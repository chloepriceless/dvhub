// server-utils.js -- Pure utility functions and shared constants.
// Extracted from server.js (Phase 1, Plan 01).
// ZERO imports. ZERO state/config dependencies.

export const MAX_BODY_BYTES = 256 * 1024; // 256 KB

export function nowIso() { return new Date().toISOString(); }
export function fmtTs(ts) { return ts ? new Date(ts).toISOString() : '-'; }

export function resolveLogLimit(rawLimit, defaultLimit = 20, maxLimit = 200) {
  const limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit <= 0) return defaultLimit;
  return Math.min(Math.floor(limit), maxLimit);
}

export function u16(v) {
  let x = Math.trunc(Number(v) || 0);
  if (x < 0) x += 0x10000;
  return x & 0xffff;
}
export function s16(v) {
  const x = Number(v) & 0xffff;
  return x >= 0x8000 ? x - 0x10000 : x;
}

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        // H-1 (Plan 16-02): carry statusCode=413 so the route layer can map a
        // body-too-large to a clean 413 instead of an uncaught 500. Mirrors the
        // invalid-JSON branch below, which already sets statusCode=400.
        const e = new Error('body too large');
        e.statusCode = 413;
        return reject(e);
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch { const e = new Error('invalid JSON body'); e.statusCode = 400; reject(e); }
    });
    req.on('error', reject);
  });
}

export function roundCtKwh(value) {
  return Number(Number(value || 0).toFixed(2));
}

// Sweep package 6: single shared 2-decimal rounding helper.
// Was duplicated in eeg-rules.js, history-runtime.js, bundesnetzagentur-applicable-values.js
// (as round2) and telemetry-store{,-pg}.js (as roundKwh). Sign-aware and EPSILON-corrected.
// nullOnInvalid:true preserves the eeg-rules / bundesnetzagentur "return null on a
// non-finite input" behavior; the default returns 0 (the history-runtime / telemetry
// `Number(value||0)` behavior).
export function round2(value, { nullOnInvalid = false } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return nullOnInvalid ? null : 0;
  const sign = numeric < 0 ? -1 : 1;
  return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
}

export function berlinDateString(d = new Date(), timezone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(d);
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function localMinutesOfDay(date = new Date(), timezone = 'Europe/Berlin') {
  const hh = Number(date.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
  const mm = Number(date.toLocaleString('en-GB', { timeZone: timezone, minute: '2-digit', hour12: false }));
  return hh * 60 + mm;
}

// T-0075 telemetry-freshness helpers. polling.js stamps
// state.victron.fieldUpdatedAt[field] ONLY in the success branch of a poll
// (victron.updatedAt is set on every attempt incl. errors, so it is "last
// attempt", not "last success"). These give a real per-field freshness signal.
// A field is "stale" only when it HAS a success timestamp that has aged past
// maxAgeMs — a missing timestamp (0) coincides with a cold-start null value and
// is handled by the caller's null/unknown check, never treated as stale here.
export function victronFieldAgeMs(state, field, nowMs = Date.now()) {
  const at = Number(state?.victron?.fieldUpdatedAt?.[field] ?? 0);
  return at > 0 ? nowMs - at : null;
}
export function victronFieldStale(state, field, maxAgeMs, nowMs = Date.now()) {
  const at = Number(state?.victron?.fieldUpdatedAt?.[field] ?? 0);
  const max = Number(maxAgeMs);
  return at > 0 && Number.isFinite(max) && (nowMs - at) > max;
}

export function gridDirection(value, gridPositiveMeans = 'feed_in') {
  const v = Number(value) || 0;
  const positiveFeedIn = gridPositiveMeans !== 'grid_import';
  if (v === 0) return { mode: 'neutral', label: 'neutral' };
  const exporting = positiveFeedIn ? v > 0 : v < 0;
  return exporting ? { mode: 'feed_in', label: 'Einspeisung' } : { mode: 'grid_import', label: 'Netzbezug' };
}

// ── Control-write numeric sanity bounds (T-0080) ────────────────────────
// Anti-attack / anti-bug ceilings for ESS hardware writes. SINGLE source of
// truth shared by the /api/control/write route AND the applyControlTarget
// chokepoint (schedule-eval.js): EOS/EMHASS/evcc call the chokepoint directly
// with only an isFinite check and previously bypassed the route's bounds.
// These are GROSS sanity ceilings (against 1e308-type payloads / a faulty
// optimizer), NOT install-specific inverter-spec limits.
export const MAX_GRID_SETPOINT_W = 100_000;
export const MAX_MINSOC_PCT = 100;
// maxDischargeW: 0 = hold, positive = AC discharge cap (W), -1 = unlimited sentinel.
export const MAX_BATTERY_DISCHARGE_W = 30_000;
export const MAX_CHARGE_CURRENT_A = 1000;

// Pure bounds check for the always-REJECT control targets. Returns null when in
// range, else { error, max? } — the shape mirrors the historical
// /api/control/write 400 responses verbatim. minSocPct is intentionally NOT
// handled here: the route rejects out-of-[0,100] manual input, while the
// chokepoint CLAMPS it to the hard floor (clampMinSoc) — two deliberate,
// different behaviours (a manual API typo is a 400; an optimizer's low minSoc
// is silently raised to the safe floor rather than dropped).
export function controlWriteBoundsError(target, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return { error: 'value_not_finite' };
  if (target === 'gridSetpointW' && Math.abs(v) > MAX_GRID_SETPOINT_W) {
    return { error: 'value_out_of_range', max: MAX_GRID_SETPOINT_W };
  }
  if (target === 'chargeCurrentA' && Math.abs(v) > MAX_CHARGE_CURRENT_A) {
    return { error: 'charge_current_out_of_range', max: MAX_CHARGE_CURRENT_A };
  }
  if (target === 'maxDischargeW' && v !== -1 && (v < 0 || v > MAX_BATTERY_DISCHARGE_W)) {
    return { error: 'max_discharge_out_of_range', max: MAX_BATTERY_DISCHARGE_W };
  }
  if (target === 'feedExcessDcPv' && v !== 0 && v !== 1) {
    return { error: 'feed_excess_flag_must_be_0_or_1' };
  }
  return null;
}

// Clamp a minSocPct write into [floorPct, 100] for the applyControlTarget
// chokepoint, so any caller (incl. an optimizer sending minSoc=0) cannot drop
// the Victron SoC floor (reg 2901) below the configured hard floor. Returns
// { value, clamped }. A non-finite input clamps to the floor (fail-safe).
export function clampMinSoc(value, floorPct) {
  const lo = Math.max(0, Number.isFinite(Number(floorPct)) ? Number(floorPct) : 0);
  const v = Number(value);
  if (!Number.isFinite(v)) return { value: lo, clamped: true };
  const clampedVal = Math.min(MAX_MINSOC_PCT, Math.max(lo, v));
  return { value: clampedVal, clamped: clampedVal !== v };
}
