// services/energy-balance-battery.js — Akku für die Leitstand-Kachel
// „Überschuss / Defizit“ (Christin 02.11.2026).
//
// Die Kachel las Akkugröße und Untergrenze aus statusData.config.optimizer,
// das /api/status nie geliefert hat — es griffen Ersatzwerte (43 kWh / 5 %),
// auf Prod mit 77 kWh viel zu wenig. Hier dieselben Werte, mit denen EOS plant:
//   capacityWh — optimizer.batteryCapacityWh, mit zweiter GX-Anlage beide
//                (planningCfg); null, wenn nicht eingestellt (keine Ersatzzahl);
//   socPct     — Ladestand, mit zweiter Anlage nach Kapazität gewichtet;
//   minSocPct  — Untergrenze wie für EOS: der höhere aus Live-BMS-Wert und
//                optimizer.hardFloorSocPct (resolveEosMinSocPct), gewichtet.
// Wirft nie (Status-Payload); bei kaputtem Kontext null.
import { planningCfg, planningSocPct, planningMinSocPct } from './multi-gx/planning.js';
import { resolveEosMinSocPct } from './optimizer/eos-config-sync.js';

const finiteOrNull = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function energyBalanceBattery(ctx) {
  if (!ctx || typeof ctx.getCfg !== 'function') return null;
  try {
    const cfg = ctx?.getCfg?.() || {};
    // Ohne eingestellte Hauptkapazität keine Zahl — planningCfg setzte sonst
    // mit zweiter GX-Anlage 8 kWh für die Hauptanlage ein (Gegenprüfung 527906fc).
    // Ohne Hauptkapazität auch Ladestand und Untergrenze nur der Hauptanlage,
    // ungewichtet (planningSocPct gewichtete mit den erfundenen 8 kWh,
    // Gegenprüfung e07271be).
    const main = finiteOrNull(cfg?.optimizer?.batteryCapacityWh);
    const primaryMin = resolveEosMinSocPct(ctx?.state?.victron?.minSocPct, cfg?.optimizer?.hardFloorSocPct);
    if (main === null || main <= 0) {
      return { capacityWh: null, socPct: finiteOrNull(ctx?.state?.victron?.soc), minSocPct: finiteOrNull(primaryMin) };
    }
    const cap = finiteOrNull(planningCfg(ctx, cfg)?.optimizer?.batteryCapacityWh);
    return {
      capacityWh: cap !== null && cap > 0 ? cap : null,
      socPct: finiteOrNull(planningSocPct(ctx)),
      minSocPct: finiteOrNull(planningMinSocPct(ctx, primaryMin)),
    };
  } catch {
    return null;
  }
}
