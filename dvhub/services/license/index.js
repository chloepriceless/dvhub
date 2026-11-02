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
// Strix L-0006 (30.10.2026): der Aktivierungs-Proxy bekommt den Lizenzschlüssel
// im Klartext. Seine Adresse stand in der Config (licensing.activationProxyUrl)
// und ließ sich per POST /api/config auf einen fremden Server umbiegen. Sie ist
// jetzt fest wie KEYGEN_BASE; ein Config-Wert wird ignoriert. Tests setzen
// ctx.activationProxyUrl.
const ACTIVATION_PROXY_URL = 'https://webhook.dvhub.de/v1/license/activate-machine';
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
// Strix L-0001 (30.10.2026): ein Schlüssel ohne key/-Signatur lässt sich offline
// nicht prüfen — jeder mit root konnte „DVHB-0000-…“ in license_state.json
// schreiben und hatte Pro, solange die Box license.dvhub.de nicht erreicht.
// Solche Schlüssel gelten jetzt nur bis OFFLINE_GRACE_MS nach der letzten
// erfolgreichen Online-Prüfung (dieselbe Kulanz wie beim Machine-File). Eine
// letzte Prüfung mehr als einen Tag in der Zukunft gilt als verfälscht.
const UNVERIFIED_KEY_GRACE_MS = OFFLINE_GRACE_MS;
const LAST_CHECK_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;
// Strix L-0002/L-0005 (30.10.2026): Pro-Sperre wegen der Bindung. Beide nur,
// wenn feststeht, dass eine ANDERE Box die Lizenz hält — nie bei Netz- oder
// Server-Fehlern (Bestandsschutz T-0125 „A“: Lizenzen ohne Bindung bleiben gültig).
//   machine_slot_taken  — Proxy: Slot gehört einer anderen Box (< 24 h, 409)
//   bound_to_other_box  — Machine-File einer anderen Box hier, oder Keygen sagt
//                         online, die Maschine dieser Box hängt nicht mehr an
//                         der Lizenz (FINGERPRINT_SCOPE_MISMATCH)
// Aufgehoben nur durch eine erfolgreiche Bindung („An diese Box binden“) —
// automatisch zurückgeholt wird nicht, sonst nähmen sich zwei Boxen die Lizenz
// alle 24 h gegenseitig weg.
const BIND_BLOCK_SLOT_TAKEN = 'machine_slot_taken';
const BIND_BLOCK_OTHER_BOX = 'bound_to_other_box';
const BIND_BLOCKS = new Set([BIND_BLOCK_SLOT_TAKEN, BIND_BLOCK_OTHER_BOX]);
// Keygen validate-key mit scope.fingerprint: Codes, die „Maschine dieser Box
// hängt nicht mehr an der Lizenz“ bedeuten (vgl. ACTIVATABLE_CODES im Proxy).
const SCOPE_OTHER_BOX_CODES = new Set(['FINGERPRINT_SCOPE_MISMATCH']);
const SCOPE_NO_MACHINE_CODES = new Set(['NO_MACHINE', 'NO_MACHINES']);

// T-LICENSE-KWP-GATING Increment 5 (Christin 2026-07-02): Under-Report-Erkennung.
// Der GEMESSENE PV-Peak (echte, ungekappte pv_total_w aus der DB) wird gegen den
// lizenzierten Tarif verglichen. Toleranz: kWp ist der Modul-Peak; die reale
// AC-Leistung liegt meist DARUNTER (Clipping/Verluste), an kalten Klarhimmel-
// Tagen bei Überbelegung kurz darüber — daher +18 % Toleranz gegen Fehlalarme.
const UNDER_REPORT_TOLERANCE_PCT = 18;
// Kulanzfrist nach der ERST-Erkennung, bevor der Pro-Gate zugeht (Christin-
// Entscheid #5 „Kulanzfrist, dann Pro-Gate"): erst GUI-Upgrade-Prompt + Frist,
// dann greift capacityOk()-analoges Gating. 14 Tage = ein voller Abrechnungszyklus.
const UNDER_REPORT_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
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
  'forecast-inspector-eos',    // Phase 19 Plan 19-05 (B4 EOS-Output-Inspector) — Teil von EOS-Pro
  'vpn-manager',               // 2026-06-21: VPN-Manager als Pro-Feature gegated (/api/vpn/*)
  // Pro-Gating #12 (2026-06-27): die DV-Schnittstelle (Modbus-Server + HTTP-Read
  // /dv/control-value) und der EOS/Optimizer-Dispatch sind serverseitig gegatete
  // Pro-Features. forecast-inspector-stage2 ENTFERNT — Stage 2++ / predictivePreEmpty
  // wurde 2026-07-02 komplett aus dem Code entfernt, der Inspektor dafür entfällt.
  'dv-interface',              // DV-Schnittstelle (modbus-server.js + /dv/control-value)
  'eos',                       // EOS / DV-EOS Optimizer-Dispatch (services/optimizer)
  // Historie-Zeiträume (Christin 2026-07-07): nur die Tagesansicht ist frei; die
  // Woche/Monat/Jahr/Alle-Ansichten der Historie (/api/history/summary,
  // /api/history/viz/*, /api/history/export mit view!=day) sind Pro-gegated.
  'history-multiperiod',       // Historie Woche/Monat/Jahr/Alle (history.js #historyView)
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
    max_kwp: null,                // wirksamer Tarif-Deckel (kWp): kleinster aus Machine-File und Online-Antwort; null = Altlizenz/unbegrenzt
    online_max_kwp: null,         // Strix L-0002: maxKwp aus der letzten validate-key-Antwort (license.dvhub.de, TLS)
    bind_block: null,             // Strix L-0005: 'machine_slot_taken' | 'bound_to_other_box' → Pro gesperrt
    bind_error: null,             // letzter Bindungsfehler (Hinweis für die Oberfläche, sperrt nicht)
    bind_error_at: null,          // ISO-Zeit des letzten Bindungsfehlers
    license_kind: null,           // license kind from metadata (e.g. "demo"); null = normal/paid
    last_server_ts: null,         // Hardening (Codex #4): monotone high-water of the highest server time seen
    // T-LICENSE-KWP-GATING Increment 5: Under-Report-Erkennung (gemessener Peak
    // > lizenzierter Tarif). Alle null/false auf einer frischen/Community-Box.
    plant_exceeds_license: false, // aktuelles Verdikt (gemessen > Tarif+Toleranz)
    plant_exceeds_since: null,    // ISO: Erst-Erkennung (startet die Kulanzfrist) oder null
    observed_peak_w: null,        // zuletzt gemessener robuster PV-Peak (Watt) — Diagnose/UI
    observed_peak_at: null        // ISO: Zeitpunkt der letzten Auswertung
  };
}

/**
 * Last-4-chars fingerprint for UI display ("DVHB-XXXX-XXXX-XXXX-AAAA" -> "AAAA").
 */
function fingerprint(key) {
  return String(key || '').slice(-4);
}

/**
 * Under-Report-Verdikt (T-LICENSE-KWP-GATING Increment 5, rein/testbar):
 * überschreitet der GEMESSENE PV-Peak den lizenzierten Tarif zzgl. Toleranz?
 *   ceilingW = maxKwp × 1000 × (1 + tolerancePct/100)
 * Kein Cap-Tarif (maxKwp==null/≤0 → Community/Legacy) ODER keine/ungültige
 * Messung → IMMER false (fail-open: nie eine Anlage ohne belastbares Signal
 * flaggen). Nur bei aktivem Pro-max_kwp UND belastbarem Peak > Ceiling → true.
 *
 * @param {object} o
 * @param {number|null} o.observedPeakW  robuster gemessener PV-Peak (Watt)
 * @param {number|null} o.maxKwp  lizenzierter Tarif-Deckel (kWp)
 * @param {number} [o.tolerancePct]  Toleranz in Prozent (Default 18)
 * @returns {boolean}
 */
// Gemessener PV-Peak über diesem Vielfachen der EINGETRAGENEN kWp gilt als
// unplausibel (Support-Fall 2026-10-15: 52,4 kW bei 36 kWp, PV aus Loxone falsch
// zugeordnet). Nur ein Hinweis in der Oberfläche — die Kulanzfrist läuft weiter,
// denn eine zu niedrig eingetragene Anlage sähe genauso aus (Christin: „Nur Meldung“).
const PV_PEAK_IMPLAUSIBLE_FACTOR = 1.3;

function pvPeakImplausible({ observedPeakW, systemKwp }) {
  if (!(Number.isFinite(observedPeakW) && observedPeakW > 0)) return false;
  if (!(Number.isFinite(systemKwp) && systemKwp > 0)) return false;
  return observedPeakW > systemKwp * 1000 * PV_PEAK_IMPLAUSIBLE_FACTOR;
}

function plantExceedsLicenseVerdict({ observedPeakW, maxKwp, tolerancePct = UNDER_REPORT_TOLERANCE_PCT }) {
  if (!(Number.isFinite(maxKwp) && maxKwp > 0)) return false;
  if (!(Number.isFinite(observedPeakW) && observedPeakW > 0)) return false;
  const ceilingW = maxKwp * 1000 * (1 + tolerancePct / 100);
  return observedPeakW > ceilingW;
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
  // Zuletzt an die Listener gemeldeter Pro-Zustand — für Wechsel, die nur durch
  // Zeitablauf entstehen (Offline-Kulanz eines unsignierten Schlüssels).
  let lastProActive = null;
  // Während Aktivierung/Revalidate samt Bindung nur EIN Wechsel an die
  // Listener (sonst gingen DV/EOS bei „Slot belegt“ kurz an und wieder aus).
  let emitHold = 0;

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
  let fileMaxKwpCache = null;       // Deckel aus dem vertrauten Machine-File (für den Tarif-Abgleich)
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
    fileMaxKwpCache = null;
    // Tier ceiling is re-derived each refresh — cleared first so a missing/
    // invalid/mismatched file never retains a stale ceiling. Strix L-0002: the
    // ceiling is NOT only the file's — the online validate-key answer counts too
    // (smaller wins), so a box without a bound file is no longer silently unlimited.
    state.license.max_kwp = null;
    state.license.license_kind = null;
    try {
      adoptMachineFileClaims();
    } finally {
      state.license.max_kwp = combineCaps(fileMaxKwpCache, finiteCap(state.license.online_max_kwp));
    }
  }

  function finiteCap(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function combineCaps(a, b) {
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  }

  function adoptMachineFileClaims() {
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
    fileMaxKwpCache = Number.isFinite(v.maxKwp) ? v.maxKwp : null;
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
    if (unverifiedKeyStale()) return 'unverified_offline';   // Strix L-0001
    if (signedExpiryMsCache == null) return 'active';   // perpetual/floating
    const now = trustedNowMs();
    if (now <= signedExpiryMsCache) return 'active';
    if (now <= signedExpiryMsCache + OFFLINE_GRACE_MS) return 'grace';
    return 'expired_offline';
  }

  /** Signierter Keygen-Schlüssel (key/…)? Nur der lässt sich offline prüfen. */
  function isSignedKey(key) {
    return typeof key === 'string' && key.startsWith('key/');
  }

  /**
   * Strix L-0001: ein unsignierter Schlüssel (kein key/…) ist offline nicht
   * prüfbar. Er gilt nur bis UNVERIFIED_KEY_GRACE_MS nach der letzten
   * erfolgreichen Online-Prüfung — gemessen an trustedNowMs(), also nicht durch
   * Zurückstellen der Uhr zu verlängern. Ohne Kontoschlüssel (Tests) inaktiv.
   */
  function unverifiedKeyStale() {
    const key = state.license.license_key;
    if (!accountPublicKey || !key || isSignedKey(key)) return false;
    const last = Date.parse(state.license.last_check_ok_at);
    if (!Number.isFinite(last)) return true;
    const now = trustedNowMs();
    if (last > now + LAST_CHECK_FUTURE_TOLERANCE_MS) return true;   // in die Zukunft gestellt
    return now - last > UNVERIFIED_KEY_GRACE_MS;
  }

  function bindingBlocked() {
    return BIND_BLOCKS.has(state.license.bind_block);
  }

  /**
   * Hat diese Box ein vertrauenswürdiges, an SIE gebundenes Machine-File?
   * Signatur gültig, Lizenz-ID = die des signierten Schlüssels, Fingerprint =
   * appliance-id dieser Box. Liefert den Grund, wenn nicht.
   */
  function machineBinding() {
    const mf = state.license.machine_file;
    if (!mf) return { bound: false, reason: 'no_machine_file' };
    if (!accountPublicKey) return { bound: false, reason: 'no_account_public_key' };
    const v = verifyKeygenMachineFile(mf, accountPublicKey);
    if (!v.valid) return { bound: false, reason: 'invalid', detail: v.reason };
    const authId = authoritativeLicenseId();
    if (authId && v.licenseId !== authId) return { bound: false, reason: 'license_mismatch' };
    const applianceId = readApplianceId(baseDir);
    if (!applianceId) return { bound: false, reason: 'no_appliance_id', file: v };
    if (String(v.fingerprint || '').toLowerCase() !== applianceId) {
      return { bound: false, reason: 'fingerprint_mismatch', file: v, applianceId };
    }
    return { bound: true, file: v, applianceId };
  }

  function dropMachineFile() {
    state.license.machine_file = null;
    state.license.machine_id = null;
  }

  function setBindError(code) {
    state.license.bind_error = code || 'unknown';
    state.license.bind_error_at = new Date().toISOString();
  }

  function clearBindProblems() {
    state.license.bind_block = null;
    state.license.bind_error = null;
    state.license.bind_error_at = null;
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
      // Hardening C (2026-06-22) + Strix L-0005 (30.10.2026): node-lock. Trägt
      // der gespeicherte Zustand ein Machine-File, MUSS es offline gegen den
      // Kontoschlüssel prüfen UND an die appliance-id DIESER Box gebunden sein.
      // Bis 30.10. galt das nur mit licensing.nodeLock=true (ab Werk aus) — ein
      // auf eine zweite Box kopierter Zustand gab dort Pro. Jetzt immer:
      //   - File kaputt/gefälscht/fremde Lizenz → File verwerfen; die Box gilt
      //     als ungebunden, der nächste Revalidate bindet neu, der Deckel kommt
      //     solange aus der Online-Antwort (L-0002).
      //   - File einer ANDEREN Box → File verwerfen und Pro sperren
      //     (bound_to_other_box); „An diese Box binden“ hebt das auf.
      // Schlüssel und Status bleiben — der Kunde muss nichts neu eingeben.
      // licensing.nodeLock=true behält das alte, strenge Verhalten (Zustand
      // verwerfen). Lizenzen ganz OHNE Machine-File bleiben unberührt
      // (Bestandsschutz T-0125 „A“).
      if (state.license.status === 'active' && state.license.machine_file) {
        const cfg = (typeof getCfg === 'function' ? getCfg() : null) || {};
        const strict = cfg?.licensing?.nodeLock === true;
        const m = verifyKeygenMachineFile(state.license.machine_file, accountPublicKey);
        const applianceId = readApplianceId(baseDir);
        const fpMismatch = m.valid && applianceId && String(m.fingerprint || '').toLowerCase() !== applianceId;
        if (!m.valid) {
          pushLog('license_machine_file_invalid', { reason: m.reason });
          if (strict) state.license = freshNoneState(); else dropMachineFile();
        } else if (!applianceId) {
          pushLog('license_node_lock_no_appliance_id', {});
          if (strict) state.license = freshNoneState();
        } else if (fpMismatch) {
          pushLog('license_node_lock_fingerprint_mismatch', {
            bound_fp: fingerprint(m.fingerprint), local_fp: fingerprint(applianceId)
          });
          if (strict) {
            state.license = freshNoneState();
          } else {
            dropMachineFile();
            state.license.bind_block = BIND_BLOCK_OTHER_BOX;
          }
        } else {
          const authId = authoritativeLicenseId();
          if (authId && m.licenseId !== authId) {
            // Echtes File, aber für eine andere Lizenz (Codex-v2 H-3) — zählt nicht.
            pushLog('license_machine_file_license_mismatch', { bound: m.licenseId, expected: authId });
            dropMachineFile();
          }
        }
      }
      if (state.license.bind_block != null && !BIND_BLOCKS.has(state.license.bind_block)) {
        state.license.bind_block = null;   // unbekannter Wert von Hand → ignorieren
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
    lastProActive = isProActive();
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
    // Pro-Zustand VOR der Antwort — nicht nur der Status: ein veralteter
    // unsignierter Schlüssel oder eine Bindungssperre hatte Pro schon aus.
    const prevProActive = isProActive();

    state.license.status = newStatus;
    state.license.key_fingerprint = fingerprint(keyForState);
    state.license.license_key = keyForState;                    // D-03 amended — full key persisted
    state.license.license_id = json?.data?.id || null;
    state.license.polar_customer_id = attrs.metadata?.polarOrderId || null;
    state.license.subscription_until = attrs.expiry || null;
    state.license.scheme_name = attrs.scheme || null;
    // Strix L-0002: Tarif-Deckel auch aus der Online-Antwort (license.dvhub.de
    // über TLS; der Webhook schreibt metadata.maxKwp in die Lizenz). Gilt
    // zusätzlich zum Machine-File, die kleinere Grenze zählt.
    state.license.online_max_kwp = finiteCap(attrs.metadata?.maxKwp ?? attrs.metadata?.max_kwp);
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
      clearBindProblems();   // eine Sperre gehörte zur alten Lizenz
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
    emitProActiveChange(prevProActive);

    return { ok: valid, status: newStatus, code };
  }

  /**
   * activateLicense: trim key, validate non-empty, resolve account-slug,
   * POST validate-key, map response. Permissive on transport failure (D-16).
   */
  /**
   * T-LICENSE-KEYPASTE (Kundenfall 2026-07-20, lil-dav*): Keys kommen per
   * Copy-Paste aus der Lizenz-Mail — Mail-Clients brechen lange Keys um und
   * fügen Leerzeichen/Umbrüche MITTEN im Key ein. Ein Keygen-Key (key/…base64url
   * mit . und Signatur) enthält selbst NIE Whitespace → alle Whitespaces
   * entfernen ist verlustfrei und macht die Eingabe robust (vorher nur trim()).
   */
  function normalizeKey(raw) {
    return String(raw || '').replace(/\s+/g, '');
  }

  async function activateLicense(rawKey) {
    const prevProActive = isProActive();
    emitHold += 1;
    try {
      return await activateLicenseInner(rawKey);
    } finally {
      emitHold -= 1;
      emitProActiveChange(prevProActive);
    }
  }

  async function activateLicenseInner(rawKey) {
    const key = normalizeKey(rawKey);
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
    const result = applyValidateResponse(json, key);

    // T-LICENSE-AUTOBIND (Kundenfall 2026-07-20): "Aktivieren" und "An diese
    // Box binden" waren ZWEI getrennte Schritte — Kunden blieben nach der
    // Aktivierung unbebunden (Keygen: mehrere Lizenzen mit machines=0), der
    // Binden-Button wurde nie gedrückt/gefunden. Deshalb kaskadiert eine
    // ERFOLGREICHE Aktivierung jetzt direkt in die node-lock-Bindung —
    // best-effort: ein Bindungs-Fehler macht die Aktivierung NICHT kaputt
    // (permissiv wie D-16), das Ergebnis reist als result.nodeLock zur GUI,
    // der manuelle Binden-Button bleibt als Fallback. Übersprungen, wenn
    // bereits eine Maschine gebunden ist (max_machines=1 — ein Re-Bind würde
    // am Limit scheitern und Lärm machen).
    // Strix L-0002: Auslöser ist „kein vertrauenswürdiges, an diese Box
    // gebundenes Machine-File“ — nicht mehr „keine machine_id“ (ein gelöschtes
    // File bei stehen gebliebener machine_id hieß sonst: nie neu binden).
    if (result.ok && result.status === 'active' && !machineBinding().bound) {
      try {
        const nl = await activateNodeLock(key);
        result.nodeLock = nl.ok
          ? { ok: true, machineId: nl.machineId || null }
          : { ok: false, error: nl.error || 'unknown', reason: nl.reason || null };
        if (!nl.ok) {
          pushLog('license_autobind_failed', { error: nl.error || 'unknown', reason: nl.reason || null });
        }
      } catch (err) {
        result.nodeLock = { ok: false, error: 'server_error' };
        pushLog('license_autobind_failed', { error: err.message });
      }
    }
    return result;
  }

  /**
   * activateNodeLock: Stufe-C node-lock activation via the server proxy
   * (fest: ACTIVATION_PROXY_URL → webhook.dvhub.de, Strix L-0006). The appliance CANNOT
   * create a Keygen machine itself — the policy is protected + authStrategy=TOKEN
   * (spike 2026-06-22: POST /machines with the customer key → 403). So the
   * privileged machines.create + check-out runs SERVER-side; we POST
   * {licenseKey, applianceId}, receive a signed machine file, verify it OFFLINE
   * against the embedded account public key, assert its bound fingerprint ==
   * this host's appliance-id, then persist it. loadStateFromDisk re-checks it
   * on every boot (seit Strix L-0005 immer, nicht nur mit licensing.nodeLock).
   * 409 machine_slot_taken sperrt Pro auf dieser Box (bind_block), bis eine
   * Bindung gelingt; jeder Fehler wird als bind_error für die Oberfläche gemerkt.
   *
   * Permissive on transport failure (no state mutation). A verify failure or a
   * fingerprint mismatch is a HARD reject — an unverifiable file is NEVER stored.
   *
   * @param {string} [rawKey] - customer signed key; defaults to the persisted key.
   * @returns {Promise<{ok:boolean, error?:string, reason?:string, status?:number,
   *   fingerprint?:string, expiry?:string|null, machineId?:string|null, boundFingerprint?:string}>}
   */
  async function activateNodeLock(rawKey) {
    const key = normalizeKey(rawKey ?? state.license.license_key ?? '');
    if (!key) return { ok: false, error: 'empty_key' };

    // Jeder Fehlschlag wird als bind_error gemerkt (Hinweis in der Oberfläche);
    // nur 409 machine_slot_taken sperrt Pro (Strix L-0002/L-0005).
    const fail = (out) => {
      const prev = isProActive();
      if (out.error === BIND_BLOCK_SLOT_TAKEN) state.license.bind_block = BIND_BLOCK_SLOT_TAKEN;
      setBindError(out.error);
      persistState();
      emitProActiveChange(prev);   // DV/EOS stoppen live, wenn die Sperre Pro abschaltet
      return out;
    };

    const applianceId = readApplianceId(baseDir);
    if (!applianceId) {
      pushLog('license_nodelock_no_appliance_id', {});
      return fail({ ok: false, error: 'no_appliance_id' });
    }
    if (!accountPublicKey) {
      pushLog('license_nodelock_no_public_key', {});
      return { ok: false, error: 'no_account_public_key' };
    }

    // Strix L-0006: feste Adresse (siehe ACTIVATION_PROXY_URL), keine Weiterleitung —
    // der Schlüssel geht nur an webhook.dvhub.de.
    const proxyUrl = ctx.activationProxyUrl || ACTIVATION_PROXY_URL;
    const configured = getCfg()?.licensing?.activationProxyUrl;
    if (configured && configured !== proxyUrl) {
      pushLog('license_nodelock_proxy_url_ignored', {});
    }

    let res;
    try {
      res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ licenseKey: key, applianceId }),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      pushLog('license_nodelock_network_error', { error: err.message, key_fingerprint: fingerprint(key) });
      return fail({ ok: false, error: 'server_error' });
    }

    let body = null;
    try { body = await res.json(); } catch { /* tolerate empty / non-JSON error bodies */ }

    if (!res.ok) {
      const code = typeof body?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(body.code) ? body.code : `http_${res.status}`;
      pushLog('license_nodelock_http_error', { status: res.status, code, key_fingerprint: fingerprint(key) });
      // Strix L-0002/L-0005: 409 machine_slot_taken heißt „eine ANDERE Box hält
      // diese Lizenz“ — dann kein Pro auf dieser Box (bisher blieb sie aktiv
      // und sogar ungedeckelt). Alle anderen Fehler sperren nicht.
      if (res.status === 409 && code === BIND_BLOCK_SLOT_TAKEN) {
        pushLog('license_nodelock_slot_taken', { bound_since: typeof body?.boundSince === 'string' ? body.boundSince : null });
      }
      return fail({
        ok: false, error: code, status: res.status,
        boundFingerprint: body?.boundFingerprint,
        boundSince: typeof body?.boundSince === 'string' ? body.boundSince : undefined
      });
    }

    const machineFile = body?.machineFile;
    if (typeof machineFile !== 'string' || !machineFile) {
      pushLog('license_nodelock_no_machine_file', {});
      return fail({ ok: false, error: 'no_machine_file' });
    }

    // OFFLINE verify BEFORE trusting/persisting — never store an unverifiable file.
    const v = verifyKeygenMachineFile(machineFile, accountPublicKey);
    if (!v.valid) {
      pushLog('license_nodelock_verify_failed', { reason: v.reason });
      return fail({ ok: false, error: 'machine_file_invalid', reason: v.reason });
    }
    if (String(v.fingerprint || '').toLowerCase() !== applianceId) {
      pushLog('license_nodelock_fingerprint_mismatch', {
        bound_fp: fingerprint(v.fingerprint), local_fp: fingerprint(applianceId)
      });
      return fail({ ok: false, error: 'fingerprint_mismatch' });
    }

    // Verified + bound to THIS appliance → persist. machine_file is bulky +
    // sensitive (redacted from getState, excluded from support bundles — Codex #9).
    const prevProActive = isProActive();
    state.license.machine_file = machineFile;
    state.license.machine_id = body?.machineId || null;
    if (v.expiry) state.license.subscription_until = v.expiry;
    clearBindProblems();     // gebunden → eine Sperre wegen der Bindung ist aufgehoben
    persistState();
    refreshSignedExpiry();   // Codex #5: pick up the new signed expiry for effectiveStatus()
    emitProActiveChange(prevProActive);
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
    const prevProActive = isProActive();
    emitHold += 1;
    try {
      return await revalidateLicenseInner();
    } finally {
      emitHold -= 1;
      emitProActiveChange(prevProActive);
    }
  }

  async function revalidateLicenseInner() {
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

    if (result.ok && result.status === 'active') {
      try {
        await reconcileBinding(key);
      } catch (err) {
        pushLog('license_autobind_failed', { phase: 'revalidate', error: err.message });
      }
    }
    return result;
  }

  /**
   * Strix L-0002/L-0005: Bindung beim Revalidate abgleichen (aktive Lizenz).
   *
   *   gebunden (gültiges File dieser Box)
   *     → online nachfragen, ob die Maschine noch an der Lizenz hängt
   *       (validate-key mit scope.fingerprint = appliance-id):
   *         FINGERPRINT_SCOPE_MISMATCH → eine andere Box hat sie: File weg,
   *                                      Pro gesperrt, kein Zurückholen
   *         NO_MACHINE(S)              → Maschine gelöscht: neu binden
   *         gültig                     → ok; weicht der Online-Deckel vom File
   *                                      ab (Tarif-Wechsel), File neu holen
   *         alles andere / Netzfehler  → nichts ändern
   *   gesperrt (andere Box)          → nichts tun; nur „An diese Box binden“
   *   ungebunden (kein/kaputtes File) → bei JEDEM Revalidate neu binden (T-
   *                                      LICENSE-AUTOBIND, bisher 1× pro Lauf)
   *
   * Scheitert die Bindung aus anderen Gründen als „Slot belegt“, bleibt Pro an
   * (Bestandsschutz T-0125 „A“); der Deckel kommt dann aus der Online-Antwort.
   */
  async function reconcileBinding(key) {
    const b = machineBinding();
    if (b.bound) {
      const scope = await scopeCheck(key, b.applianceId);
      if (scope === 'other_box') {
        const prev = isProActive();
        pushLog('license_machine_moved_to_other_box', { machine_id: state.license.machine_id });
        dropMachineFile();
        state.license.bind_block = BIND_BLOCK_OTHER_BOX;
        setBindError(BIND_BLOCK_OTHER_BOX);
        persistState();
        refreshSignedExpiry();
        emitProActiveChange(prev);
        return;
      }
      if (scope === 'no_machine') {
        pushLog('license_machine_missing_rebind', { machine_id: state.license.machine_id });
        dropMachineFile();
        persistState();
        refreshSignedExpiry();
        await bindNow(key);
        return;
      }
      const online = finiteCap(state.license.online_max_kwp);
      if (scope === 'bound' && online != null && online !== fileMaxKwpCache) {
        pushLog('license_tier_changed_refresh', { file_max_kwp: fileMaxKwpCache, online_max_kwp: online });
        await bindNow(key);
        return;
      }
      if (scope === 'bound' && (state.license.bind_error || state.license.bind_block)) {
        clearBindProblems();
        persistState();
      }
      return;
    }
    if (bindingBlocked()) return;
    await bindNow(key);
  }

  async function bindNow(key) {
    const nl = await activateNodeLock(key);
    if (nl.ok) {
      pushLog('license_autobind_backfilled', { machine_id: nl.machineId || null });
    } else {
      pushLog('license_autobind_failed', { phase: 'revalidate', error: nl.error || 'unknown', reason: nl.reason || null });
    }
    return nl;
  }

  /**
   * validate-key mit scope.fingerprint — nur die Bindung, nie der Lizenzstatus
   * (den setzt der normale Aufruf ohne Scope). → 'bound' | 'other_box' |
   * 'no_machine' | 'unknown'.
   */
  async function scopeCheck(key, applianceId) {
    const account = getCfg()?.licensing?.keygenAccount || process.env.KEYGEN_ACCOUNT;
    if (!account) return 'unknown';
    const url = `${KEYGEN_BASE}/v1/accounts/${encodeURIComponent(account)}/licenses/actions/validate-key`;
    let json;
    try {
      const res = await fetchKeygen(url, { meta: { key, scope: { fingerprint: applianceId } } });
      if (!res.ok) return 'unknown';
      json = await res.json();
    } catch (err) {
      pushLog('license_scope_check_error', { error: err.message });
      return 'unknown';
    }
    if (json?.meta?.valid === true) return 'bound';
    const code = String(json?.meta?.code || '').toUpperCase();
    if (SCOPE_OTHER_BOX_CODES.has(code)) return 'other_box';
    if (SCOPE_NO_MACHINE_CODES.has(code)) return 'no_machine';
    return 'unknown';
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
    const binding = machineBinding();
    s.machine_file = null;          // Hardening C: bulky signed blob, never returned externally
    // Strix L-0002/L-0005: Bindung für die Oberfläche — bound | unbound | blocked.
    s.binding = {
      state: bindingBlocked() ? 'blocked' : (binding.bound ? 'bound' : 'unbound'),
      block: bindingBlocked() ? state.license.bind_block : null,
      error: state.license.bind_error || null,
      error_at: state.license.bind_error_at || null
    };
    s.effective_status = effectiveStatus();   // Codex #5: active|grace|expired_offline|… for UI
    s.grace_until = graceUntilIso();          // ISO grace deadline (UI countdown) or null
    s.system_kwp = getSystemKwp();            // declared plant size (kWp) for the tier check
    s.capacity_ok = capacityOk();             // false = plant exceeds the licensed tier → upgrade
    // Increment 5: Under-Report-Erkennung. plant_exceeds_license / _since /
    // observed_peak_w / _at reiten via {...state.license}; die berechneten
    // UI-Felder (Gate-Status + Grace-Deadline für den Countdown) hier ergänzt.
    s.plant_gate_active = plantGateActive();            // true = Frist abgelaufen → Pro-Gate zu
    s.plant_exceeds_grace_until = plantExceedsGraceUntilIso(); // ISO-Deadline oder null
    s.pv_peak_implausible = pvPeakImplausible({ observedPeakW: Number(s.observed_peak_w), systemKwp: s.system_kwp });
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
    if (Number.isFinite(total) && total > 0) return total;
    // Betriebsart „Nur Netzspeicher“ (keine PV): die Leistung des
    // Akku-Wechselrichters in kW zählt wie kWp — sonst fiele ein großer
    // Netzspeicher mit 0 kWp immer in die kleinste Stufe. Für Anlagen mit PV
    // ändert sich nichts: dort bleibt die PV-Größe das Maß.
    if (cfg?.optimizer?.gridStorageOnly === true) {
      const powers = [Math.abs(Number(cfg.optimizer.inverterMaxPowerW)), Math.abs(Number(cfg.optimizer.maxDischargeW))]
        .filter((w) => Number.isFinite(w) && w > 0);
      if (powers.length) return Math.min(...powers) / 1000;
    }
    return 0;
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
   * getCapKwp: the kWp ceiling that PV DISPLAYS + FORECAST (and the EOS/optimizer
   * PLANNING input) get capped to — the Pro-tier enforcement of the plant size.
   *
   * Christin 2026-07-02: Community is FREE for any plant size (no cap); the paid
   * value is EOS + control, tiered by plant size. So the cap applies ONLY when a
   * key carries an explicit finite max_kwp.
   *
   * Tarife (Stand 2026-08-10 — maßgeblich ist der Shop, NICHT dieser Kommentar;
   * gestempelt wird maxKwp im Webhook, Hetzner-Docker/dvhub/webhook-handler/
   * server.js:38-43, deckungsgleich mit dvhub.de):
   *   Pro S  → maxKwp 40      Pro XS  → Sitze (1 Sitz = 1 kWp), Deckel 24
   *   Pro M  → maxKwp 70      Pro XL  → Sitze, Deckel 100
   *   Pro L  → maxKwp 100     Pro XXL → Sitze, nach oben offen
   * Ohne maxKwp und damit UNGEDECKELT: Community (keine Lizenz) und die
   * Alt-Produkte "DVhub Pro" / "DVhub Monthly" → max_kwp==null → no cap.
   *
   * WARUM die Einmalkauf-Linie bei 100 kWp endet (Christin 2026-08-10): das ist
   * KEINE willkürliche Grenze und keine Lücke im Angebot. Ab 100 kW greift die
   * VERPFLICHTENDE DIREKTVERMARKTUNG nach EEG — darüber ist der Betrieb ein
   * anderer, und dafür steht die X-Linie (XS/XL/XXL, sitzbasiert). Wer hier
   * "der Vollständigkeit halber" einen Einmalkauf über 100 kWp ergänzen will,
   * hebelt diese Trennung aus.
   *
   * ⚠️ Dieser Kommentar stand bis 2026-08-10 auf "Pro S=50 / Pro M=100, Pro L
   * unbegrenzt" — das war der Entwurfsstand vom 02.07. und hat bei einer
   * Kundenanfrage zu einer falschen Auskunft geführt. Gedeckelt ist AUSSCHLIESSLICH
   * die PV-Modulleistung (getSystemKwp); Wechselrichterleistung, Speicher und
   * Gerätezahl sind nirgends begrenzt.
   *
   * The cap value is the DECLARED system kWp (getSystemKwp — "die man eingegeben
   * hat"), bounded by the tier (defensive min). When nothing is declared yet the
   * tier ceiling is used so a fresh Pro box can't display beyond its tier.
   *
   * @returns {number|null} cap in kWp, or null = no cap (uncapped display/forecast)
   */
  function getCapKwp() {
    const cap = state.license.max_kwp;
    if (!(Number.isFinite(cap) && cap > 0)) return null; // Community / Legacy → no cap
    const declared = getSystemKwp();
    return declared > 0 ? Math.min(declared, cap) : cap;
  }

  // ---------------- Under-Report-Erkennung + Grace-then-Gate (Increment 5) ----

  /**
   * updatePlantExceedsLicense: den GEMESSENEN PV-Peak (echte ungekappte
   * pv_total_w aus der DB, vom Aufrufer/Daily-Job berechnet — der Lizenz-Service
   * bleibt DB-frei) gegen den lizenzierten Tarif auswerten und den Flag-Zustand
   * fortschreiben. Kein Cap-Tarif (max_kwp==null) → verdikt IMMER false →
   * vollständiger No-op auf jeder Community/Pro-L/Legacy-Box.
   *
   * Setzt `plant_exceeds_since` beim ERST-Flag (startet die Kulanzfrist); löscht
   * beides sobald der Peak wieder unter das Ceiling fällt (kein Dauer-Gate nach
   * einem einmaligen Ausreißer). Feuert emitProActiveChange, damit ein durch die
   * abgelaufene Frist ausgelöster Gate-Wechsel DV/EOS live stoppt/startet.
   *
   * @param {number|null} observedPeakW  robuster gemessener PV-Peak (Watt)
   * @returns {{ plantExceedsLicense: boolean, gateActive: boolean }}
   */
  function updatePlantExceedsLicense(observedPeakW) {
    const prevActive = isProActive();
    const verdict = plantExceedsLicenseVerdict({
      observedPeakW,
      maxKwp: state.license.max_kwp
    });
    const nowIso = new Date(trustedNowMs()).toISOString();
    if (Number.isFinite(observedPeakW) && observedPeakW > 0) {
      state.license.observed_peak_w = Math.round(observedPeakW);
      state.license.observed_peak_at = nowIso;
    }
    if (verdict) {
      if (!state.license.plant_exceeds_license) {
        // Erst-Erkennung → Kulanzfrist ab jetzt (nur setzen, wenn noch offen).
        state.license.plant_exceeds_since = state.license.plant_exceeds_since || nowIso;
        pushLog('license_plant_exceeds_detected', {
          observed_peak_w: state.license.observed_peak_w,
          max_kwp: state.license.max_kwp,
          grace_until: plantExceedsGraceUntilIso()
        });
      }
      state.license.plant_exceeds_license = true;
    } else if (state.license.plant_exceeds_license || state.license.plant_exceeds_since) {
      // Peak wieder unter Ceiling → Flag + Frist zurücksetzen.
      state.license.plant_exceeds_license = false;
      state.license.plant_exceeds_since = null;
      pushLog('license_plant_exceeds_cleared', { observed_peak_w: state.license.observed_peak_w });
    }
    persistState();
    emitProActiveChange(prevActive);
    return { plantExceedsLicense: state.license.plant_exceeds_license, gateActive: plantGateActive() };
  }

  /** ISO-Deadline der Under-Report-Kulanzfrist (Erst-Erkennung + Grace) oder null. */
  function plantExceedsGraceUntilIso() {
    const since = Date.parse(state.license.plant_exceeds_since);
    if (!Number.isFinite(since)) return null;
    return new Date(since + UNDER_REPORT_GRACE_MS).toISOString();
  }

  /**
   * plantGateActive: ist der Under-Report-Gate ZU? true nur wenn die Anlage
   * geflaggt IST und die Kulanzfrist ABGELAUFEN ist (trusted-time, rollback-
   * resistent). Während der Frist bleibt Pro an (nur Upgrade-Prompt). Kein Flag
   * / kein Cap-Tarif → false.
   */
  function plantGateActive() {
    if (!state.license.plant_exceeds_license) return false;
    const graceUntil = Date.parse(plantExceedsGraceUntilIso());
    if (!Number.isFinite(graceUntil)) return false;
    return trustedNowMs() >= graceUntil;
  }

  /**
   * isProActive: non-HTTP Pro-gate for live services (DV-Schnittstelle, EOS).
   * Shares the EXACT predicate of requirePro() so the HTTP and non-HTTP gates
   * never diverge. effective_status (grace/expired_offline) is deliberately NOT
   * used here for the same reason requirePro() gates on the base status — see the
   * Codex-Refute-v2 note in requirePro().
   */
  function isProActive() {
    // Base online status AND the plant fits the licensed tier (capacityOk())
    // AND the measured plant hasn't out-grown the tier past the grace period
    // (!plantGateActive() — Increment 5). Mirrors requirePro() exactly so HTTP +
    // non-HTTP gates never diverge. Strix L-0001: an unsigned key only within
    // the offline grace; L-0005: no Pro while another box holds the licence.
    return state.license.status === 'active' && !unverifiedKeyStale() && !bindingBlocked()
      && capacityOk() && !plantGateActive();
  }

  /**
   * getRemoteProof: Lizenznachweis für den EOS-Rechendienst (eos-remote.js).
   * NUR intern — nie über HTTP oder getState(). Nur bei aktiver Lizenz mit
   * Machine-File (node-lock); der Dienst prüft beides selbst noch einmal.
   * @returns {{licenseKey: string, machineFile: string} | null}
   */
  function getRemoteProof() {
    const l = state.license || {};
    if (l.status !== 'active' || !l.license_key || !l.machine_file || bindingBlocked()) return null;
    return { licenseKey: l.license_key, machineFile: l.machine_file };
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
    if (emitHold > 0) return;
    const nowActive = isProActive();
    lastProActive = nowActive;
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
    if (isProActive()) return true;
    // Distinguish "no/expired Pro" from "Pro active but plant exceeds the licensed
    // tier" so the UI shows an UPGRADE prompt (Pro M/L), not a re-activate prompt.
    // Two over-tier flavours: DECLARED (capacityOk() false — user entered > tier)
    // and MEASURED-after-grace (plantGateActive() — Increment 5 under-report gate).
    const active = state.license.status === 'active';
    const unverified = active && unverifiedKeyStale();
    const blocked = active && !unverified && bindingBlocked();
    const overCapacity = active && !unverified && !blocked && !capacityOk();
    const plantGate = active && !unverified && !blocked && capacityOk() && plantGateActive();
    const body = JSON.stringify(
      unverified
        ? { error: 'pro_required', feature: feat, reason: 'license_unverified_offline' }
        : blocked
          ? { error: 'pro_required', feature: feat, reason: state.license.bind_block }
          : overCapacity
        ? { error: 'pro_required', feature: feat, reason: 'capacity_exceeded', maxKwp: state.license.max_kwp, systemKwp: getSystemKwp() }
        : plantGate
          ? { error: 'pro_required', feature: feat, reason: 'plant_exceeds_license', maxKwp: state.license.max_kwp, observedPeakW: state.license.observed_peak_w }
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
      .finally(() => {
        revalidateInFlight = false;
        // Wechsel nur durch Zeitablauf (Offline-Kulanz eines unsignierten
        // Schlüssels endet, während die Box offline ist) — DV/EOS folgen.
        if (lastProActive !== null) emitProActiveChange(lastProActive);
      });
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

  /** @internal — Zeitpunkt der letzten erfolgreichen Online-Prüfung (Strix-L-0001-Tests). */
  function setLastCheckOkForTest(iso) {
    state.license.last_check_ok_at = iso == null ? null : String(iso);
  }

  /** @internal — set the signed tier ceiling (max_kwp) for kWp-cap tests. */
  function setMaxKwpForTest(v) {
    state.license.max_kwp = v == null ? null : Number(v);
  }

  /** @internal — backdate the under-report first-detection stamp for grace tests. */
  function setPlantExceedsSinceForTest(iso) {
    state.license.plant_exceeds_since = iso == null ? null : String(iso);
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
    getRemoteProof,
    getCapKwp,
    updatePlantExceedsLicense,
    plantGateActive,
    onProActiveChange,
    requirePro,
    start,
    close,
    setStatusForTest,
    setLicenseKeyForTest,
    setLastCheckOkForTest,
    setMaxKwpForTest,
    setPlantExceedsSinceForTest
  };
}
