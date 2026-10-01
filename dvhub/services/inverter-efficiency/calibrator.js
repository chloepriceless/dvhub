// services/inverter-efficiency/calibrator.js — hält die kalibrierte Kurve aktuell.
//
// Läuft nach jedem Tagesjob (daily.js): liest das 180-Tage-Fenster bis gestern,
// rechnet die Kurve (curve.js, deterministisch) und meldet nur dann eine
// Änderung, wenn sich die Kurve wirklich geändert hat (curveHash). Das letzte
// Ergebnis liegt in einer kleinen Datei, damit DVhub nach einem Neustart sofort
// wieder dieselbe Kurve an EOS gibt, statt bis zum ersten Job auf 1.0 zu fallen.

import fs from 'node:fs';
import { fitInverterCurve, curveWindow } from './curve.js';
import { localDateString, nominalInverterPowerW } from './daily.js';

export const CURVE_ROWS_SQL = `
SELECT to_char(day, 'YYYY-MM-DD') AS day, bin, ac_wh, dc_wh, seconds
FROM inverter_efficiency_bins_daily
WHERE day >= $1::date AND day <= $2::date
ORDER BY day, bin`;

export function createInverterCurveCalibrator({ getDb, getCfg, filePath, onChange, pushLog, fsImpl = fs }) {
  let current = null;
  try {
    if (filePath && fsImpl.existsSync(filePath)) current = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch { current = null; }

  const log = (e, d) => { try { pushLog?.(e, d); } catch { /* egal */ } };

  async function refresh({ now = new Date() } = {}) {
    const db = getDb?.();
    if (!db || typeof db.query !== 'function') return { skipped: 'no database' };
    const cfg = getCfg?.() || {};
    const tz = cfg.timeZone || 'Europe/Berlin';
    const yesterday = localDateString(new Date(now.getTime() - 86_400_000), tz);
    const window = curveWindow(yesterday);
    const res = await db.query(CURVE_ROWS_SQL, [window.from, window.to]);
    const fit = fitInverterCurve(res.rows || [], { pnomW: nominalInverterPowerW(cfg), window });
    const prevHash = current?.curveHash ?? null;
    const prevStatus = current?.status ?? null;
    current = { ...fit, computedAt: now.toISOString() };
    if (filePath) {
      try {
        const tmp = `${filePath}.tmp`;
        fsImpl.writeFileSync(tmp, JSON.stringify(current, null, 2));
        fsImpl.renameSync(tmp, filePath);
      } catch (e) { log('inverter_curve_persist_error', { error: e.message }); }
    }
    const changed = fit.curveHash !== prevHash || fit.status !== prevStatus;
    if (changed) {
      log('inverter_curve_updated', {
        status: fit.status, reason: fit.reason, days: fit.days, hours: fit.hours,
        points: fit.points.length, referenceEta: fit.referenceEta, curveHash: fit.curveHash,
      });
      try { await onChange?.(current); } catch (e) { log('inverter_curve_apply_error', { error: e.message }); }
    }
    return { changed, curve: current };
  }

  return { refresh, get: () => current };
}

/**
 * Was DVhub an EOS gibt. Nur bei status 'ok' und eingeschalteter Automatik
 * (optimizer.inverterEfficiencyAuto, Standard an) — sonst null = bisheriger Wert.
 */
export function effectiveInverterCurve(cfg, curve) {
  if (cfg?.optimizer?.inverterEfficiencyAuto === false) return null;
  if (!curve || curve.status !== 'ok' || !Array.isArray(curve.points) || curve.points.length < 2) return null;
  return curve;
}
