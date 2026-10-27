// services/tariff-provider/common.js — gemeinsame Helfer der Anbieter-Abrufe.

export const QUARTER_MS = 15 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 30_000;

// code: 'auth' (Zugangsdaten falsch/abgelaufen), 'no_contract' (kein passender
// Vertrag/Zuhause), 'network', 'api' (Fehlerantwort), 'format' (unerwartete Daten)
export class TariffProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TariffProviderError';
    this.code = code;
  }
}

/** POST mit Zeitlimit; liefert { status, json } — Fehlerantworten mit JSON-Körper inklusive. */
export async function postJson(fetchImpl, url, { headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new TariffProviderError('network', `Netzwerkfehler: ${error?.cause?.code || error?.name || error?.message || error}`);
  }
  const text = await res.text().catch(() => '');
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

/**
 * Preis-Punkte (Beginn + ct/kWh) zu Slots mit Dauer: bis zum nächsten Punkt,
 * der letzte so lang wie sein Vorgänger (sonst 15 min). Lücken > 1 h werden
 * nicht überbrückt.
 */
export function pointsToSlots(points = []) {
  const sorted = points
    .map((p) => ({ ts: new Date(p.ts).getTime(), ctKwh: Number(p.ctKwh) }))
    .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.ctKwh))
    .sort((a, b) => a.ts - b.ts);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].ts === sorted[i - 1].ts) continue;
    const next = sorted[i + 1];
    let durationMs = next ? next.ts - sorted[i].ts : (out.length ? out[out.length - 1].durationMs : QUARTER_MS);
    if (!(durationMs > 0) || durationMs > 60 * 60 * 1000) durationMs = out.length ? out[out.length - 1].durationMs : QUARTER_MS;
    out.push({ ts: sorted[i].ts, ctKwh: sorted[i].ctKwh, durationMs });
  }
  return out;
}

function zoneOffsetMinutes(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - ms) / 60000);
}

/** Ortsdatum YYYY-MM-DD von ms in timeZone. */
export function localDateOf(ms, timeZone = 'Europe/Berlin') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export function addDaysToDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Mitternacht des Ortsdatums: { ms, iso } mit Ortsversatz (z. B. 2026-11-01T00:00:00+01:00). */
export function localMidnight(date, timeZone = 'Europe/Berlin') {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let offset = zoneOffsetMinutes(guess, timeZone);
  let ms = guess - offset * 60000;
  const check = zoneOffsetMinutes(ms, timeZone);
  if (check !== offset) { offset = check; ms = guess - offset * 60000; }
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const iso = `${date}T00:00:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return { ms, iso };
}

/** Minute des Tages (Ortszeit). */
export function localMinuteOfDay(ms, timeZone = 'Europe/Berlin') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
}
