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
        return reject(new Error('body too large'));
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

export function gridDirection(value, gridPositiveMeans = 'feed_in') {
  const v = Number(value) || 0;
  const positiveFeedIn = gridPositiveMeans !== 'grid_import';
  if (v === 0) return { mode: 'neutral', label: 'neutral' };
  const exporting = positiveFeedIn ? v > 0 : v < 0;
  return exporting ? { mode: 'feed_in', label: 'Einspeisung' } : { mode: 'grid_import', label: 'Netzbezug' };
}
