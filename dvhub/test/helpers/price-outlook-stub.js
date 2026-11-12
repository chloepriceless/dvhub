// test/helpers/price-outlook-stub.js — Residuallast-Prognose (dvhub.online)
// für Tests der EOS-Bridge: stündliche P50 aus einer Funktion (ct/kWh je
// Zeitpunkt), Form wie parseOutlook(...).outlook.

const H = 3_600_000;

/**
 * @param {(ms:number) => number} ctAt  Börsenpreis in ct/kWh zum Stundenbeginn
 * @param {object} [o]
 * @param {number} [o.fromMs]   erste Stunde (wird auf die Stunde abgerundet)
 * @param {number} [o.hours]    Anzahl Stunden (Standard 7 Tage)
 * @param {number} [o.issuedMs] Ausgabezeit (Standard: jetzt)
 * @param {string} [o.zone]
 */
export function buildOutlook(ctAt, { fromMs = Date.now() - 3 * 86_400_000, hours = 10 * 24, issuedMs = Date.now(), zone = 'DE-LU', band = 2 } = {}) {
  const h0 = fromMs - (fromMs % H);
  const list = [];
  for (let i = 0; i < hours; i += 1) {
    const ms = h0 + i * H;
    const p50 = ctAt(ms) * 10;
    list.push({ ms, p10: p50 - band * 10, p50, p90: p50 + band * 10, leadDays: 1 + Math.floor(i / 24) });
  }
  return {
    issuedAt: new Date(issuedMs).toISOString(),
    issuedMs,
    lastKnownDay: null,
    biddingZone: zone,
    modelVersion: 'test',
    schemaVersion: 1,
    stale: false,
    hours: list,
  };
}

/** Dienst-Stub mit current()/ensureFresh() wie createPriceOutlookService. */
export function outlookService(outlook, { status = 'live' } = {}) {
  const svc = {
    outlook,
    calls: 0,
    async ensureFresh() { svc.calls += 1; return false; },
    current() {
      if (!svc.outlook) {
        return { status: 'unavailable', reason: 'fetch_failed', outlook: null, issuedAt: null, fetchedAt: null, unavailableSince: new Date().toISOString(), lastError: 'test' };
      }
      return { status, reason: null, outlook: svc.outlook, issuedAt: svc.outlook.issuedAt, fetchedAt: svc.outlook.issuedAt, unavailableSince: null, lastError: null };
    },
  };
  return svc;
}
