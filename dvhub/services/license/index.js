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
//     scheme_name: string|null
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

const KEYGEN_BASE = 'https://license.dvhub.de';
const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
const VALID_STATUSES = new Set(['active', 'invalid', 'expired', 'suspended', 'none']);

// V5 ASVS — whitelist featureName for the 403-response body to prevent
// log/response injection. Phase 17 ships exactly one Pro feature
// ('family-dashboard'). Phase 18+ extends this set.
const ALLOWED_FEATURES = new Set(['family-dashboard']);

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
    scheme_name: null
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
      try { fs.chmodSync(licensePath, 0o600); } catch (e) { /* best-effort on Windows / restricted FS */ }
    } catch (err) {
      console.error('[license] persist error:', err.message);
    }
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

    persistState();

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
   * revalidateLicense: reuse the persisted plaintext key against the same
   * validate-key endpoint (D-14 collapsed to Option A per RESEARCH §Open
   * Questions §1). No license_key persisted -> { ok:false, error:'no_license_active' }
   * without any fetch.
   */
  async function revalidateLicense() {
    const key = state.license.license_key;
    if (!key) return { ok: false, error: 'no_license_active' };

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
    state.license = freshNoneState();
    persistState();
    pushLog('license_removed', {});
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
    return s;
  }

  /**
   * getStatus: cheap status read for requirePro/middleware.
   */
  function getStatus() {
    return state.license.status;
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
    if (state.license.status === 'active') return true;
    const body = JSON.stringify({ error: 'pro_required', feature: feat });
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
    revalidateLicense,
    removeLicense,
    getState,
    getStatus,
    requirePro,
    start,
    close,
    setStatusForTest,
    setLicenseKeyForTest
  };
}
