// services/license/index.js -- License Service (Phase 17 Plan 02).
//
// Self-contained, testable, permissive-offline license-state holder. Knows
// nothing about HTTP routing (Wave 2 wires it in via routes-api.js).
//
// Public API (per CONTEXT D-09):
//   loadStateFromDisk()       — sync read of license_state.json into state.license
//   activateLicense(rawKey)   — POST validate-key with {meta:{key}}, map response, persist, notify on transition
//   revalidateLicense()       — reuses persisted plaintext key against the same validate-key endpoint (D-14 collapsed to Option A)
//   removeLicense()           — resets state to 'none', clears license_key/license_id/fingerprint, persists
//   getState()                — returns a shallow clone of state.license with license_key REPLACED by null
//   getStatus()               — returns state.license.status (cheap read for requirePro)
//   requirePro(req,res,feat)  — 403 gate helper; whitelist featureName (V5 ASVS — D-04 / RESEARCH §Security Domain)
//   start() / close()         — lifecycle hooks; start() is a no-op here (Plan 03 adds the poller)
//
// Internal-only test helpers (Plan 03 poller-tests consume these):
//   setStatusForTest(s)       — @internal — overrides state.license.status
//   setLicenseKeyForTest(k)   — @internal — overrides state.license.license_key
//
// Schema (D-03 amended — license_key persisted plaintext, NEVER logged, NEVER returned by getState()):
//   state.license = {
//     status: 'active'|'invalid'|'expired'|'suspended'|'none',
//     last_check_ok_at: ISO-string|null,
//     key_fingerprint: string,       // last-4 chars only — for UI display
//     license_key: string|null,      // FULL plaintext (for re-validate); never returned externally
//     license_id: string|null,
//     polar_customer_id: string|null,
//     subscription_until: ISO-string|null,
//     scheme_name: string|null,
//     machine_file: string|null      // Hardening C — Keygen offline machine file (node-lock); null = floating/legacy
//   }
//
// Failure handling (D-16):
//   - AbortSignal.timeout(10_000) — permissive: state unchanged on timeout/network errors
//   - 1 retry after 2s on TimeoutError / TypeError (DNS / connection-refused)
//   - HTTP non-200 -> server_error -> NO state mutation
//   - meta.valid + meta.code drive the status mapping (NOT response.ok — see Pitfall 1)
//
// Status-code truth table (RESEARCH §"Mapping meta.code -> status"):
//   meta.valid:true,  code:'VALID'              -> 'active'
//   meta.valid:true   (any other code)          -> 'active'  (ALLOW_ACCESS lenient)
//   meta.valid:false, code:'NOT_FOUND'          -> 'invalid'
//   meta.valid:false, code:'SUSPENDED'|'BANNED' -> 'suspended'
//   meta.valid:false, code:'EXPIRED'            -> 'expired'
//   HTTP non-200 / timeout / DNS                -> server_error (NO mutation)

import fs from 'node:fs';
import path from 'node:path';

import { PROVIDER_FACTORIES } from '../notifications/index.js';
import { verifyKeygenSignedKey, verifyKeygenMachineFile, readApplianceId, decodeKeygenPayload } from './keygen-verify.js';

const KEYGEN_BASE = 'https://license.dvhub.de';
const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
const VALID_STATUSES = new Set(['active', 'invalid', 'expired', 'suspended', 'none']);

// Hardening (Codex #4): tolerance before a backward clock jump (vs the trusted
// server-time high-water) is logged as a suspected rollback. 24h absorbs normal
// NTP skew / timezone-less ISO parsing slack without crying wolf.
const CLOCK_ROLLBACK_TOLERANCE_MS = 24 * 60 * 60 * 1000;
// Hardening (Codex #5, Christin C): offline grace AFTER a node-locked monthly
// licence's SIGNED expiry passes — Pro stays on for 14 days, then expired_offline.
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
// Sentinel for a SIGNED key whose payload carries no license.id — matches no real
// machine-file licenseId, so binding fails CLOSED instead of falling back to the
// editable plaintext license_id (Codex-v2 re-verify HIGH).
const SIGNED_KEY_NO_LICENSE_ID = '\0no-signed-license-id\0';

// Account Ed25519 public key (PUBLIC — not a secret) for Hardening B: offline
// verification that a persisted license_key is a genuine Keygen ED25519_SIGN key
// for THIS account, so a hand-tampered license_state.json cannot unlock Pro
// offline (without ever reaching Keygen). Overridable via ctx.accountPublicKey
// for tests. Verified against the live prod key 2026-06-22 (verify → valid).
const ACCOUNT_PUBLIC_KEY = '2b8cc3310c0958f58bf9b9d3a52cb868f8f2c2260a679b5ebf4b41ed9038c5c3';

// V5 ASVS — whitelist featureName for the 403-response body to prevent
// log/response injection. Phase 17 ships exactly one Pro feature
// ('family-dashboard'). Phase 18+ extends this set.
const ALLOWED_FEATURES = new Set([
  'family-dashboard',
  'forecast-inspector-ml',     // Phase 19 Plan 19-04 (B3 ML-Korrektur-Inspector)
  'forecast-inspector-eos',    // Phase 19 Plan 19-05 (B4 EOS-Output-Inspector) — Teil von EOS-Pro
  'vpn-manager',               // 2026-06-21: VPN-Manager als Pro-Feature gegated (/api/vpn/*)
  // Pro-Gating #12 (2026-06-27): die DV-Schnittstelle (Modbus-Server + HTTP-Read
  // /dv/control-value) und der EOS/Optimizer-Dispatch sind serverseitig gegatete
  // Pro-Features. forecast-inspector-stage2 ENTFERNT — Stage 2++ ist in der UI
  // ausgeblendet (#8-lite), der Inspektor dafür entfällt.
  'dv-interface',              // DV-Schnittstelle (modbus-server.js + /dv/control-value)
  'eos',                       // EOS / DV-EOS Optimizer-Dispatch (services/optimizer)
]);

/**
 * Build a fresh "none" state object (used on first-boot, on corrupt-file
 * fallback, and on removeLicense).
 */
function freshNoneState() {
  return {
    status: 'none',
    last_check_ok_at: null,
    key_fingerprint: '',
    license_key: null,
    license_id: null,
    polar_customer_id: null,
    subscription_until: null,
    scheme_name: null,
    machine_file: null,           // Hardening C: offline Keygen machine file (node-lock); null = floating/legacy
    machine_id: null,             // Stufe C: Keygen machine UUID (for re-bind/release; not secret)
    max_kwp: null,                // tier ceiling (kWp) from the SIGNED license metadata; null = legacy/unlimited (fail-open)
    license_kind: null,           // license kind from metadata (e.g. "demo"); null = normal/paid
    last_server_ts: null          // Hardening (Codex #4): monotone high-water of the highest server time seen
  };
}

/**
 * Last-4-chars fingerprint for UI display ("DVHB-XXXX-XXXX-XXXX-AAAA" -> "AAAA").
 */
function fingerprint(key) {
  return String(key || '').slice(-4);
}

/**
 * Map Keygen meta.valid + meta.code -> dvhub license status enum.
 */
function mapCodeToStatus(code, valid) {
  if (valid === true) return 'active';                          // VALID or ALLOW_ACCESS-EXPIRED
  if (code === 'NOT_FOUND') return 'invalid';
  if (code === 'SUSPENDED' || code === 'BANNED') return 'suspended';
  if (code === 'EXPIRED') return 'expired';
  return 'invalid';                                              // unknown -> conservative invalid
}

/**
 * Create the license service. Factory pattern matches services/forecast/index.js
 * and services/family/index.js.
 *
 * @param {object} ctx - DI context
 *   ctx.state          - shared mutable state tree (state.license is initialized here)
 *   ctx.getCfg         - () => config object (hot-reload-safe per server.js convention)
 *   ctx.pushLog        - (event, details, level?) => void — ring-buffer logger
 *   ctx.appDir         - install dir fallback for license_state.json path
 *   ctx.securityHeaders - optional headers spread into requirePro 403 response (Plan 03 wires this)
 * @returns {{
 *   loadStateFromDisk: Function,
 *   activateLicense: Function,
 *   revalidateLicense: Function,
 *   removeLicense: Function,
 *   getState: Function,
 *   getStatus: Function,
 *   requirePro: Function,
 *   start: Function,
 *   close: Function,
 *   setStatusForTest: Function,
 *   setLicenseKeyForTest: Function
 * }}
 */
export function createLicenseService(ctx) {
  const { state, getCfg, pushLog } = ctx;
  const baseDir = process.env.DV_DATA_DIR || ctx.appDir || process.cwd();
  const licensePath = path.join(baseDir, 'license_state.json');
  const securityHeaders = ctx.securityHeaders || {};
  // Hardening B: account public key for offline signed-key verification (null disables).
  const accountPublicKey = ctx.accountPublicKey !== undefined ? ctx.accountPublicKey : ACCOUNT_PUBLIC_KEY;

  // Timer-injection seam — tests pass ctx.timers = { setInterval, setTimeout,
  // clearInterval, clearTimeout } to capture scheduled callbacks without
  // running the real event loop (Plan 17-03 poller-tests; RESEARCH §Pitfall 4).
  // Production callers omit ctx.timers and get the globals.
  const timers = ctx.timers || {
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout
  };
  let pollerInterval = null;
  let pollerInitialTimeout = null;
  let revalidateInFlight = false;

  // Pro-Gating (Task #9): live status-transition fan-out. Live services (the
  // DV-Schnittstelle / Modbus server and the EOS/optimizer dispatch layer)
  // register a callback via onProActiveChange(); an active <-> non-active flip
  // then starts/stops them WITHOUT a process restart (revoke closes them,
  // activation re-opens them). The non-HTTP gate isProActive() shares the exact
  // same predicate as the HTTP gate requirePro(): state.license.status === 'active'.
  const proActiveListeners = [];

  // Initialize state.license eagerly so callers (e.g. requirePro before
  // loadStateFromDisk) never see undefined. loadStateFromDisk() will overwrite
  // this with the persisted state when invoked at boot.
  state.license = freshNoneState();

  // ----------------- Persistence -----------------

  /**
   * Atomic write to license_state.json (tmpfile + rename). Mode 0600 after
   * rename so other LXC users / restic snapshots can't read the plaintext
   * license key (V8 ASVS — Data Protection). Silent catch — avoid recursive
   * log if pushLog itself triggers persist (mirrors polling.js:102-104).
   */
  function persistState() {
    try {
      const tmp = licensePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state.license) + '\n', 'utf8');
      fs.renameSync(tmp, licensePath);
      try { fs.chmodSync(licensePath, 0o600); } catch { /* best-effort on Windows / restricted FS */ }
    } catch (err) {
      console.error('[license] persist error:', err.message);
    }
  }

  // ----------------- Trusted time (Hardening, Codex #4) -----------------
  //
  // Offline grace/expiry MUST NOT be defeatable by winding the system clock
  // back. We keep a MONOTONE high-water mark of the highest server timestamp
  // ever seen (Keygen meta.ts on every validate response) and derive a
  // rollback-resistant "now" as max(wall-clock, high-water): time can never be
  // observed EARLIER than the last server-confirmed instant. Forward clock moves
  // are honoured; backward moves below the high-water are floored out. The grace
  // logic (Codex #5, next step) computes its deadlines against trustedNowMs().

  /** Update the monotone server-time high-water from a Keygen meta.ts (ISO). */
  function recordServerTime(metaTs) {
    const ms = Date.parse(metaTs);
    if (!Number.isFinite(ms)) return;
    const prev = Date.parse(state.license.last_server_ts);
    if (!Number.isFinite(prev) || ms > prev) {
      state.license.last_server_ts = new Date(ms).toISOString();
    }
  }

  /** Rollback-resistant current time (ms): never earlier than the high-water. */
  function trustedNowMs() {
    let floor = Date.now();
    const hw = Date.parse(state.license.last_server_ts);
    if (Number.isFinite(hw)) floor = Math.max(floor, hw);
    // Codex-v2 C-2: the signed machine-file issue time is tamper-proof — it floors
    // "now" even if the plaintext last_server_ts high-water was cleared/backdated.
    if (Number.isFinite(signedIssuedMsCache)) floor = Math.max(floor, signedIssuedMsCache);
    return floor;
  }

  /** Log when the local clock is implausibly behind the trusted high-water. */
  function checkClockRollback() {
    const hw = Date.parse(state.license.last_server_ts);
    if (Number.isFinite(hw) && Date.now() < hw - CLOCK_ROLLBACK_TOLERANCE_MS) {
      pushLog('license_clock_rollback_detected', {
        local_now: new Date().toISOString(),
        high_water: state.license.last_server_ts
      });
    }
  }

  // ----------------- Offline grace / effective status (Codex #5) -----------------
  //
  // The AUTHORITATIVE monthly expiry is the SIGNED expiry inside the machine
  // file (verified offline against the account public key) — NOT the plaintext
  // state.license.subscription_until, which is hand-editable. Cached at load /
  // activation (the file only changes there) so requirePro stays crypto-free per
  // request. null = no signed expiry → perpetual/floating → no offline expiry
  // (Christin A grandfathering + D perpetual-offline-final).
  let signedExpiryMsCache = null;
  let signedIssuedMsCache = null;   // Codex-v2 C-2: tamper-proof time floor from the signed file
  // Codex-v2-fix (HIGH): the TAMPER-PROOF license identity is the license id INSIDE
  // the Ed25519-signed key (Hardening-B-verified), NOT the editable plaintext
  // state.license.license_id. Falls back to plaintext only for legacy/non-signed
  // keys (grandfathered floating — never node-locked, so binding matters less).
  function authoritativeLicenseId() {
    const key = state.license.license_key;
    if (typeof key === 'string' && key.startsWith('key/')) {
      // SIGNED key → the license id MUST come from the signed payload. A missing
      // signed id fails CLOSED (a sentinel that matches no real file id) — NEVER
      // fall back to the editable plaintext for a signed key (Codex-v2 re-verify).
      return decodeKeygenPayload(key)?.license?.id ?? SIGNED_KEY_NO_LICENSE_ID;
    }
    return state.license.license_id || null;   // legacy/non-signed keys only
  }
  function refreshSignedExpiry() {
    signedExpiryMsCache = null;
    signedIssuedMsCache = null;
    // Tier ceiling is re-derived from the signed file each refresh — cleared first
    // so a missing/invalid/mismatched file leaves max_kwp=null (legacy/unlimited,
    // fail-open) rather than retaining a stale ceiling.
    state.license.max_kwp = null;
    state.license.license_kind = null;
    const mf = state.license.machine_file;
    if (!mf || !accountPublicKey) return;
    const v = verifyKeygenMachineFile(mf, accountPublicKey);
    if (!v.valid) return;
    // Codex-v2 H-3 (#6) + fix: the file MUST be bound to THIS key's signed license
    // id (tamper-proof) — a genuinely-signed file for a DIFFERENT license is ignored.
    const authId = authoritativeLicenseId();
    if (authId && v.licenseId !== authId) {
      pushLog('license_machine_file_license_mismatch', { bound: v.licenseId, expected: authId });
      return;
    }
    // Trusted: signed AND bound to THIS license → adopt its tier ceiling + kind.
    state.license.max_kwp = Number.isFinite(v.maxKwp) ? v.maxKwp : null;
    state.license.license_kind = v.kind || null;
    // Codex-v2 C-2: the signed check-out/issued time is a tamper-proof LOWER bound
    // on "now" (feeds trustedNowMs even if plaintext last_server_ts was wiped).
    const issuedMs = Date.parse(v.dataset?.meta?.issued ?? v.dataset?.data?.attributes?.created);
    if (Number.isFinite(issuedMs)) signedIssuedMsCache = issuedMs;
    // expiry: null/absent = perpetual (legit). PRESENT-but-unparseable = tampered/
    // malformed → fail CLOSED (Codex-v2 M-6), never silently perpetual.
    if (v.expiry == null) return;                       // perpetual
    const ms = Date.parse(v.expiry);
    if (Number.isFinite(ms)) { signedExpiryMsCache = ms; return; }
    pushLog('license_machine_file_bad_expiry', {});
    signedExpiryMsCache = 0;                             // already-expired sentinel (fail-closed)
  }

  /**
   * Derive the effective licence status from the persisted status + the signed
   * monthly expiry, measured against trustedNowMs() (rollback-resistant):
   *   active        — base active AND (no signed expiry OR now <= expiry)
   *   grace         — signed expiry passed but within the 14-day grace
   *   expired_offline — past expiry + grace (a replayed OLD file lands here too,
   *                     because the high-water has advanced past its old expiry)
   * Any non-active base status (none/invalid/expired/suspended) passes through.
   */
  function effectiveStatus() {
    if (state.license.status !== 'active') return state.license.status;
    if (signedExpiryMsCache == null) return 'active';   // perpetual/floating
    const now = trustedNowMs();
    if (now <= signedExpiryMsCache) return 'active';
    if (now <= signedExpiryMsCache + OFFLINE_GRACE_MS) return 'grace';
    return 'expired_offline';
  }

  /** Grace deadline (ISO) for UI countdown, or null when no signed expiry. */
  function graceUntilIso() {
    if (signedExpiryMsCache == null) return null;
    return new Date(signedExpiryMsCache + OFFLINE_GRACE_MS).toISOString();
  }

  /**
   * Sync read of license_state.json into state.license. Missing file OR
   * corrupt JSON -> fresh 'none' state + pushLog('license_state_load_error').
   * Boot-load must NEVER throw — Pro features must work permissively after a
   * fresh install or a wiped state.
   */
  function loadStateFromDisk() {
    try {
      const raw = fs.readFileSync(licensePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !VALID_STATUSES.has(parsed.status)) {
        throw new Error('invalid_schema');
      }
      // Merge into a freshNoneState() base so missing fields default to null;
      // never trust the disk shape blindly.
      state.license = { ...freshNoneState(), ...parsed };
      // Hardening A (2026-06-22): an on-disk `status:'active'` is only honoured
      // when it is backed by a persisted license_key. Kills the trivial bypass
      // of hand-writing `{"status":"active"}` into license_state.json to unlock
      // Pro without ever talking to Keygen. A legitimately activated state ALWAYS
      // carries the plaintext key (applyValidateResponse persists it); Stufe B
      // adds offline Ed25519 signature verification of that key on top.
      if (state.license.status === 'active') {
        if (!state.license.license_key) {
          pushLog('license_state_active_without_key_rejected', {});
          state.license = freshNoneState();
        } else if (accountPublicKey && state.license.license_key.startsWith('key/')) {
          // Hardening B: a persisted Keygen signed key MUST verify offline against
          // the account public key — otherwise the on-disk active state is forged.
          const v = verifyKeygenSignedKey(state.license.license_key, accountPublicKey);
          if (!v.valid) {
            pushLog('license_state_signature_invalid', { reason: v.reason });
            state.license = freshNoneState();
          }
        }
      }
      // Hardening C (2026-06-22): node-lock. When enabled AND the persisted
      // licence carries a Keygen machine file, that file MUST verify offline
      // against the account public key AND its bound fingerprint MUST equal this
      // host's appliance-id — otherwise the active state was copied onto a
      // foreign box. INERT by default: cfg.licensing.nodeLock !== true, OR no
      // machine_file present (legacy/floating licences are grandfathered per
      // T-0125 decision A). Runs after B, so it re-checks the (possibly reset)
      // status. Time/expiry + grace are deliberately NOT enforced here — that
      // needs trusted-time (Codex #4) and lands with the online build phase.
      if (state.license.status === 'active' && state.license.machine_file) {
        const cfg = (typeof getCfg === 'function' ? getCfg() : null) || {};
        if (cfg?.licensing?.nodeLock === true) {
          const m = verifyKeygenMachineFile(state.license.machine_file, accountPublicKey);
          const applianceId = readApplianceId(baseDir);
          if (!m.valid) {
            pushLog('license_machine_file_invalid', { reason: m.reason });
            state.license = freshNoneState();
          } else if (!applianceId) {
            pushLog('license_node_lock_no_appliance_id', {});
            state.license = freshNoneState();
          } else if (String(m.fingerprint || '').toLowerCase() !== applianceId) {
            pushLog('license_node_lock_fingerprint_mismatch', {
              bound_fp: fingerprint(m.fingerprint), local_fp: fingerprint(applianceId)
            });
            state.license = freshNoneState();
          }
        }
      }
      // Hardening Codex-v2 C-1: a signed key on a configured NODE-LOCKED policy
      // MUST carry a valid machine_file bound to THIS appliance — deleting it to
      // masquerade as a grandfathered floating licence is the bypass. Config-gated
      // (licensing.nodeLockedPolicyIds): EMPTY default leaves prod's shared/
      // grandfathered policy untouched. Tamper-proof — the policy id is read from
      // the Ed25519-signed key payload (already verified by Hardening B above),
      // not from editable plaintext.
      if (state.license.status === 'active' && accountPublicKey
          && typeof state.license.license_key === 'string'
          && state.license.license_key.startsWith('key/')) {
        const lockedPolicies = getCfg()?.licensing?.nodeLockedPolicyIds;
        if (Array.isArray(lockedPolicies) && lockedPolicies.length) {
          const policyId = decodeKeygenPayload(state.license.license_key)?.policy?.id;
          if (policyId && lockedPolicies.includes(policyId)) {
            const mf = state.license.machine_file;
            const mv = mf ? verifyKeygenMachineFile(mf, accountPublicKey) : { valid: false };
            const applianceId = readApplianceId(baseDir);
            const authId = authoritativeLicenseId();
            // valid signature AND bound to THIS appliance AND to THIS key's signed
            // license id — else the active node-locked state was tampered/copied.
            if (!mv.valid || !applianceId
                || String(mv.fingerprint || '').toLowerCase() !== applianceId
                || (authId && mv.licenseId !== authId)) {
              pushLog('license_nodelock_policy_unsatisfied', { policy: policyId, reason: mv.reason || 'no_machine_file_or_mismatch' });
              state.license = freshNoneState();
            }
          }
        }
      }
      // Hardening (Codex #4): flag an implausible backward clock jump vs the
      // trusted server-time high-water (offline grace must not be rewindable).
      checkClockRollback();
      // Hardening (Codex #5): cache the signed monthly expiry for effectiveStatus().
      refreshSignedExpiry();
    } catch (err) {
      pushLog('license_state_load_error', { error: err.message });
      state.license = freshNoneState();
    }
  }

  // ----------------- Keygen HTTP client -----------------

  /**
   * fetch() with 10 s AbortSignal + 1-retry-after-2s on TimeoutError /
   * TypeError (transport-level failures only). HTTP non-200 does NOT throw —
   * the caller inspects res.ok separately (per RESEARCH §Pitfall 1).
   */
  async function fetchKeygen(url, body) {
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json'
      },
      body: JSON.stringify(body)
    };
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (err.name !== 'TimeoutError' && err.name !== 'TypeError') throw err;
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    }
  }

  /**
   * Apply a parsed Keygen validate-key response to state.license, persist,
   * log, and trigger operator notification on an active -> !active transition.
   *
   * @param {object} json - parsed Keygen response body
   * @param {string} keyForState - the plaintext key (D-03 amended: persisted)
   * @returns {{ok: boolean, status: string, code: string}}
   */
  function applyValidateResponse(json, keyForState) {
    const code = json?.meta?.code;
    const valid = json?.meta?.valid === true;
    const attrs = json?.data?.attributes || {};
    const newStatus = mapCodeToStatus(code, valid);
    const prevStatus = state.license.status;
    const prevLicenseId = state.license.license_id;

    state.license.status = newStatus;
    state.license.key_fingerprint = fingerprint(keyForState);
    state.license.license_key = keyForState;                    // D-03 amended — full key persisted
    state.license.license_id = json?.data?.id || null;
    state.license.polar_customer_id = attrs.metadata?.polarOrderId || null;
    state.license.subscription_until = attrs.expiry || null;
    state.license.scheme_name = attrs.scheme || null;
    if (newStatus === 'active') {
      state.license.last_check_ok_at = new Date().toISOString();
    }
    // Hardening (Codex #4): record the server's clock as the trusted high-water,
    // regardless of license validity — the server time is trustworthy even when
    // the licence is not.
    recordServerTime(json?.meta?.ts);
    // Codex-v2-fix (MEDIUM): a DIFFERENT license must not inherit the previous
    // license's signed machine file / cached expiry. Clear it on a license change.
    if (state.license.license_id !== prevLicenseId) {
      state.license.machine_file = null;
      state.license.machine_id = null;
    }

    persistState();
    refreshSignedExpiry();   // keep the signed-expiry/issued caches in sync with the new state

    if (newStatus === 'active') {
      pushLog('license_activate_ok', {
        status: newStatus, code,
        license_id: state.license.license_id,
        key_fingerprint: state.license.key_fingerprint
      });
    } else {
      pushLog('license_activate_invalid', {
        status: newStatus, code,
        key_fingerprint: state.license.key_fingerprint
      });
    }

    if (prevStatus === 'active' && newStatus !== 'active') {
      pushLog('license_revalidate_revoked', { from: prevStatus, to: newStatus, code });
      notifyOperatorOfRevoke(newStatus).catch(err =>
        pushLog('license_notify_error', { error: err.message })
      );
    }

    // Pro-Gating (Task #9): fire the live start/stop fan-out on BOTH directions
    // (activation AND revoke) so DV-Schnittstelle + EOS follow the licence state
    // without a restart. notifyOperatorOfRevoke above only covers the revoke side.
    emitProActiveChange(prevStatus === 'active');

    return { ok: valid, status: newStatus, code };
  }

  /**
   * activateLicense: trim key, validate non-empty, resolve account-slug,
   * POST validate-key, map response. Permissive on transport failure (D-16).
   */
  async function activateLicense(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) return { ok: false, error: 'empty_key' };

    const cfg = getCfg();
    const account = cfg?.licensing?.keygenAccount || process.env.KEYGEN_ACCOUNT;
    if (!account) {
      pushLog('license_keygen_account_missing', { phase: 'activate' });
      return { ok: false, error: 'keygen_account_not_configured' };
    }

    const url = `${KEYGEN_BASE}/v1/accounts/${encodeURIComponent(account)}/licenses/actions/validate-key`;
    let res;
    try {
      res = await fetchKeygen(url, { meta: { key } });
    } catch (err) {
      pushLog('license_activate_network_error', {
        error: err.message,
        key_fingerprint: fingerprint(key)
      });
      return { ok: false, error: 'server_error' };
    }
    if (!res.ok) {
      pushLog('license_activate_http_error', {
        status: res.status,
        key_fingerprint: fingerprint(key)
      });
      return { ok: false, error: 'server_error' };
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      pushLog('license_activate_http_error', { status: res.status, error: err.message });
      return { ok: false, error: 'server_error' };
    }
    return applyValidateResponse(json, key);
  }

  /**
   * activateNodeLock: Stufe-C node-lock activation via the server proxy
   * (cfg.licensing.activationProxyUrl → webhook.dvhub.de). The appliance CANNOT
   * create a Keygen machine itself — the policy is protected + authStrategy=TOKEN
   * (spike 2026-06-22: POST /machines with the customer key → 403). So the
   * privileged machines.create + check-out runs SERVER-side; we POST
   * {licenseKey, applianceId}, receive a signed machine file, verify it OFFLINE
   * against the embedded account public key, assert its bound fingerprint ==
   * this host's appliance-id, then persist it. The loadStateFromDisk node-lock
   * gate (only when cfg.licensing.nodeLock===true) re-checks it on every boot.
   *
   * Permissive on transport failure (no state mutation). A verify failure or a
   * fingerprint mismatch is a HARD reject — an unverifiable file is NEVER stored.
   *
   * @param {string} [rawKey] - customer signed key; defaults to the persisted key.
   * @returns {Promise<{ok:boolean, error?:string, reason?:string, status?:number,
   *   fingerprint?:string, expiry?:string|null, machineId?:string|null, boundFingerprint?:string}>}
   */
  async function activateNodeLock(rawKey) {
    const key = String(rawKey ?? state.license.license_key ?? '').trim();
    if (!key) return { ok: false, error: 'empty_key' };

    const applianceId = readApplianceId(baseDir);
    if (!applianceId) {
      pushLog('license_nodelock_no_appliance_id', {});
      return { ok: false, error: 'no_appliance_id' };
    }
    if (!accountPublicKey) {
      pushLog('license_nodelock_no_public_key', {});
      return { ok: false, error: 'no_account_public_key' };
    }

    const proxyUrl = getCfg()?.licensing?.activationProxyUrl;
    if (!proxyUrl) {
      pushLog('license_nodelock_no_proxy_url', {});
      return { ok: false, error: 'activation_proxy_not_configured' };
    }

    let res;
    try {
      res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ licenseKey: key, applianceId }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      pushLog('license_nodelock_network_error', { error: err.message, key_fingerprint: fingerprint(key) });
      return { ok: false, error: 'server_error' };
    }

    let body = null;
    try { body = await res.json(); } catch { /* tolerate empty / non-JSON error bodies */ }

    if (!res.ok) {
      const code = body?.code || `http_${res.status}`;
      pushLog('license_nodelock_http_error', { status: res.status, code, key_fingerprint: fingerprint(key) });
      return { ok: false, error: code, status: res.status, boundFingerprint: body?.boundFingerprint };
    }

    const machineFile = body?.machineFile;
    if (typeof machineFile !== 'string' || !machineFile) {
      pushLog('license_nodelock_no_machine_file', {});
      return { ok: false, error: 'no_machine_file' };
    }

    // OFFLINE verify BEFORE trusting/persisting — never store an unverifiable file.
    const v = verifyKeygenMachineFile(machineFile, accountPublicKey);
    if (!v.valid) {
      pushLog('license_nodelock_verify_failed', { reason: v.reason });
      return { ok: false, error: 'machine_file_invalid', reason: v.reason };
    }
    if (String(v.fingerprint || '').toLowerCase() !== applianceId) {
      pushLog('license_nodelock_fingerprint_mismatch', {
        bound_fp: fingerprint(v.fingerprint), local_fp: fingerprint(applianceId)
      });
      return { ok: false, error: 'fingerprint_mismatch' };
    }

    // Verified + bound to THIS appliance → persist. machine_file is bulky +
    // sensitive (redacted from getState, excluded from support bundles — Codex #9).
    state.license.machine_file = machineFile;
    state.license.machine_id = body?.machineId || null;
    if (v.expiry) state.license.subscription_until = v.expiry;
    persistState();
    refreshSignedExpiry();   // Codex #5: pick up the new signed expiry for effectiveStatus()
    pushLog('license_nodelock_bound', {
      machine_id: state.license.machine_id,
      fingerprint: fingerprint(applianceId),
      expiry: v.expiry || null
    });
    return { ok: true, fingerprint: applianceId, expiry: v.expiry || null, machineId: state.license.machine_id };
  }

  /**
   * revalidateLicense: reuse the persisted plaintext key against the same
   * validate-key endpoint (D-14 collapsed to Option A per RESEARCH §Open
   * Questions §1). No license_key persisted -> { ok:false, error:'no_license_active' }
   * without any fetch.
   */
  async function revalidateLicense() {
    const key = state.license.license_key;
    if (!key) {
      // Hardening A (2026-06-22): no persisted key => an 'active' status cannot
      // be backed by Keygen. Force it down to 'none' so a tampered key-less
      // `status:active` cannot survive the poller. A real licence always has a
      // key and takes the validate-key path below.
      if (state.license.status !== 'none') {
        const prevActive = isProActive();
        state.license.status = 'none';
        persistState();
        pushLog('license_revalidate_no_key_reset', {});
        emitProActiveChange(prevActive);   // Task #9: close DV/EOS if a key-less active state is force-reset
      }
      return { ok: false, error: 'no_license_active' };
    }

    const cfg = getCfg();
    const account = cfg?.licensing?.keygenAccount || process.env.KEYGEN_ACCOUNT;
    if (!account) {
      pushLog('license_keygen_account_missing', { phase: 'revalidate' });
      return { ok: false, error: 'keygen_account_not_configured' };
    }

    const url = `${KEYGEN_BASE}/v1/accounts/${encodeURIComponent(account)}/licenses/actions/validate-key`;
    let res;
    try {
      res = await fetchKeygen(url, { meta: { key } });
    } catch (err) {
      pushLog('license_revalidate_network_error', {
        error: err.message,
        key_fingerprint: state.license.key_fingerprint
      });
      return { ok: false, error: 'server_error' };
    }
    if (!res.ok) {
      pushLog('license_revalidate_http_error', {
        status: res.status,
        key_fingerprint: state.license.key_fingerprint
      });
      return { ok: false, error: 'server_error' };
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      pushLog('license_revalidate_http_error', { status: res.status, error: err.message });
      return { ok: false, error: 'server_error' };
    }

    const result = applyValidateResponse(json, key);
    if (result.ok) {
      pushLog('license_revalidate_ok', {
        status: result.status, code: result.code,
        license_id: state.license.license_id
      });
    }
    return result;
  }

  /**
   * removeLicense: reset state to a fresh 'none', clear the plaintext key,
   * persist, log. The on-disk file is overwritten with the new (empty) state
   * — operator who wants to wipe the disk record entirely should delete the
   * file manually post-remove (out of scope for v1.0).
   */
  function removeLicense() {
    const prevActive = isProActive();
    state.license = freshNoneState();
    persistState();
    pushLog('license_removed', {});
    emitProActiveChange(prevActive);   // Task #9: close DV/EOS live on manual removal
    return { ok: true, status: 'none' };
  }

  /**
   * getState: return a shallow clone of state.license with license_key
   * REPLACED by null. The plaintext key MUST NEVER leave the service (V8
   * Data Protection — RESEARCH §Security Domain).
   */
  function getState() {
    const s = { ...state.license };
    s.license_key = null;
    s.machine_file = null;          // Hardening C: bulky signed blob, never returned externally
    s.effective_status = effectiveStatus();   // Codex #5: active|grace|expired_offline|… for UI
    s.grace_until = graceUntilIso();          // ISO grace deadline (UI countdown) or null
    s.system_kwp = getSystemKwp();            // declared plant size (kWp) for the tier check
    s.capacity_ok = capacityOk();             // false = plant exceeds the licensed tier → upgrade
    // max_kwp + license_kind ride along via the {...state.license} spread above.
    return s;
  }

  /**
   * getStatus: cheap status read for requirePro/middleware.
   */
  function getStatus() {
    return state.license.status;
  }

  /**
   * getSystemKwp: total installed PV capacity (kWp) this box DECLARES — summed
   * over userEnergyPricing.pvPlants[].kwp, with forecast.pv.totalKwp as fallback.
   * This is the number the licence's tier ceiling (max_kwp) is checked against.
   * (Anti-under-report plausibility vs the measured PV peak is a separate, soft
   * flag in the optimizer/telemetry path — not a gate here.)
   */
  function getSystemKwp() {
    const cfg = (typeof getCfg === 'function' ? getCfg() : null) || {};
    const plants = cfg?.userEnergyPricing?.pvPlants;
    if (Array.isArray(plants) && plants.length) {
      const sum = plants.reduce((a, p) => a + (Number(p?.kwp) > 0 ? Number(p.kwp) : 0), 0);
      if (sum > 0) return sum;
    }
    const total = Number(cfg?.forecast?.pv?.totalKwp);
    return Number.isFinite(total) && total > 0 ? total : 0;
  }

  /**
   * capacityOk: does the licence's tier ceiling COVER this plant's size?
   *   - max_kwp == null  -> legacy/unlimited licence (no tier metadata) -> ALWAYS ok.
   *     FAIL-OPEN by design: existing paid keys + the dev-bypass (which carry no
   *     maxKwp) keep working untouched — only a licence that EXPLICITLY ships a
   *     maxKwp is ever capacity-gated.
   *   - systemKwp == 0   -> plant not configured yet -> ok (never gate a fresh box
   *     before the operator has entered pvPlants).
   *   - else             -> systemKwp <= max_kwp.
   */
  function capacityOk() {
    const cap = state.license.max_kwp;
    if (cap == null) return true;
    const kwp = getSystemKwp();
    if (kwp <= 0) return true;
    return kwp <= cap;
  }

  /**
   * isProActive: non-HTTP Pro-gate for live services (DV-Schnittstelle, EOS).
   * Shares the EXACT predicate of requirePro() so the HTTP and non-HTTP gates
   * never diverge. effective_status (grace/expired_offline) is deliberately NOT
   * used here for the same reason requirePro() gates on the base status — see the
   * Codex-Refute-v2 note in requirePro().
   */
  function isProActive() {
    // Base online status AND the plant fits the licensed tier (capacityOk()).
    // Mirrors requirePro() exactly so HTTP + non-HTTP gates never diverge.
    return state.license.status === 'active' && capacityOk();
  }

  /**
   * onProActiveChange: register a callback fired on every active <-> non-active
   * transition with the new boolean. Used by server.js to start/stop the
   * DV-Modbus server + EOS dispatch live on a license change.
   */
  function onProActiveChange(cb) {
    if (typeof cb === 'function') proActiveListeners.push(cb);
  }

  /**
   * emitProActiveChange: fan out to registered listeners ONLY when the active
   * flag actually flipped relative to `prevActive`. Listener errors are logged
   * and absorbed (one bad listener must not block the others or the caller).
   */
  function emitProActiveChange(prevActive) {
    const nowActive = isProActive();
    if (prevActive === nowActive) return;
    for (const cb of proActiveListeners) {
      try {
        cb(nowActive);
      } catch (err) {
        pushLog('license_pro_change_listener_error', { error: err?.message ?? String(err) });
      }
    }
  }

  // ----------------- Notifications -----------------

  /**
   * Iterate enabled notification providers and dispatch a direct notify()
   * call (no trigger-evaluate loop — D-28 + RESEARCH §"Notifications Provider
   * Call"). Errors per provider are logged and absorbed; the notify path
   * never propagates back to the caller (best-effort).
   */
  async function notifyOperatorOfRevoke(newStatus) {
    const cfg = getCfg();
    const providers = cfg?.notifications?.providers || {};
    for (const [name, pCfg] of Object.entries(providers)) {
      if (!pCfg?.enabled) continue;
      const factory = PROVIDER_FACTORIES[name];
      if (!factory) continue;
      try {
        const provider = factory(pCfg);
        await provider.notify({
          level: 'warning',
          title: 'DVhub-Lizenz pausiert',
          body: `License-Status hat von "active" zu "${newStatus}" gewechselt. Pro-Features sind deaktiviert.`
        });
      } catch (err) {
        pushLog('license_notify_error', { provider: name, error: err.message });
      }
    }
  }

  // ----------------- HTTP gate -----------------

  /**
   * requirePro: 403 gate for Pro-only routes. Call inside the route handler
   * (after LAN-bypass already accepted the request, per Amendment Option-B).
   *
   * featureName is whitelisted to ALLOWED_FEATURES; anything else degrades
   * to 'unknown' in the 403 body (V5 ASVS — prevents log/response injection).
   *
   * @returns {boolean} true if the request is allowed (status === 'active'),
   *                    false after writing the 403 response (caller MUST early-return)
   */
  function requirePro(req, res, featureName) {
    const feat = ALLOWED_FEATURES.has(featureName) ? featureName : 'unknown';
    // effective_status (active|grace|expired_offline) is COMPUTED + exposed via
    // getState() for the UI, but deliberately NOT YET ENFORCED here. Codex-Refute-v2
    // (2026-06-23) showed enforcing offline-expiry now would wrongly cut off a
    // RENEWING monthly customer — the signed machine_file is not re-checked-out on
    // online revalidation, so its frozen expiry would lapse while the sub is paid.
    // Enforcement is gated on the server re-checkout + check-in/high-water design
    // (T-0125 next step). Until then gate on the base (online-driven) status, which
    // already reflects revocation/expiry whenever the box can reach Keygen.
    if (state.license.status === 'active' && capacityOk()) return true;
    // Distinguish "no/expired Pro" from "Pro active but plant exceeds the licensed
    // tier" so the UI shows an UPGRADE prompt (Pro M/L), not a re-activate prompt.
    const overCapacity = state.license.status === 'active' && !capacityOk();
    const body = JSON.stringify(overCapacity
      ? { error: 'pro_required', feature: feat, reason: 'capacity_exceeded', maxKwp: state.license.max_kwp, systemKwp: getSystemKwp() }
      : { error: 'pro_required', feature: feat });
    res.writeHead(403, {
      ...securityHeaders,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body, 'utf8')
    });
    res.end(body);
    return false;
  }

  // ----------------- Lifecycle -----------------

  /**
   * Wrap a revalidateLicense() call with an overlap-guard so a slow upstream
   * can never produce concurrent in-flight calls (RESEARCH §Pitfall 4 —
   * matches the weather-fetch.js polling pattern at services/forecast/weather-fetch.js:138-145).
   */
  function guardedRevalidate(source) {
    if (revalidateInFlight) {
      pushLog('license_revalidate_skipped_overlap', { source });
      return;
    }
    revalidateInFlight = true;
    revalidateLicense()
      .catch(err => pushLog('license_revalidate_error', { source, error: err?.message ?? String(err) }))
      .finally(() => { revalidateInFlight = false; });
  }

  /**
   * start: schedules the license poller. Two timers:
   *   1. setTimeout(30_000) — first validate 30s after boot. Verifies the
   *      persisted license without blocking server bootstrap (CONTEXT D-11).
   *   2. setInterval(24h)   — recurring validate every 24h.
   *
   * Both wrap revalidateLicense() in an overlap-guard so a slow upstream
   * (Keygen latency / outage) never piles up concurrent calls.
   *
   * Timer injection via ctx.timers (see factory header) makes the schedule
   * deterministic under test.
   */
  async function start() {
    // First validate runs 30s after start() — not synchronously. Boot must
    // never block on a Keygen call.
    pollerInitialTimeout = timers.setTimeout(() => {
      guardedRevalidate('boot');
    }, 30_000);

    // Recurring 24h validate.
    pollerInterval = timers.setInterval(() => {
      guardedRevalidate('interval');
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * close: clears the boot setTimeout AND the 24h setInterval. Uses the
   * type-correct clear* function for each handle. Safe to call multiple times.
   */
  async function close() {
    if (pollerInterval != null) {
      timers.clearInterval(pollerInterval);
      pollerInterval = null;
    }
    if (pollerInitialTimeout != null) {
      const clearTimeoutFn = timers.clearTimeout || timers.clearInterval;
      clearTimeoutFn(pollerInitialTimeout);
      pollerInitialTimeout = null;
    }
  }

  // ----------------- @internal test seams -----------------

  /** @internal — used by Plan 03 poller-tests to simulate prior-active state. */
  function setStatusForTest(s) {
    if (!VALID_STATUSES.has(s)) throw new Error(`invalid test status: ${s}`);
    state.license.status = s;
  }

  /** @internal — used by Plan 03 poller-tests to simulate a persisted key. */
  function setLicenseKeyForTest(k) {
    state.license.license_key = k == null ? null : String(k);
  }

  return {
    loadStateFromDisk,
    activateLicense,
    activateNodeLock,
    trustedNowMs,
    effectiveStatus,
    revalidateLicense,
    removeLicense,
    getState,
    getStatus,
    isProActive,
    onProActiveChange,
    requirePro,
    start,
    close,
    setStatusForTest,
    setLicenseKeyForTest
  };
}
