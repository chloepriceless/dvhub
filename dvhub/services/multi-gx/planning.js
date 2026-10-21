/**
 * multi-gx/planning.js — gemeinsamer Akku fuer die Planung (Chrissi 21.10.2026:
 * „EOS plant beide Akkus gemeinsam“).
 *
 * Ist eine zweite GX-Anlage eingerichtet und erreichbar (state.multiGx.online),
 * sehen EOS und die Plan-Umrechnung einen Akku: Kapazitaet, Lade-/Entladeleistung
 * und Wechselrichter-Leistung addiert, Ladestand und Mindest-SoC nach Kapazitaet
 * gewichtet. Die Aufteilung auf die Anlagen macht danach der Regler
 * (follower-controller.js): Die Hauptanlage faehrt DVhubs Netz-Sollwert, die
 * zweite traegt ihren Anteil an der Akkuleistung.
 *
 * Ohne erreichbare zweite Anlage geben alle Funktionen die Werte der
 * Hauptanlage zurueck — planningCfg dann dasselbe Objekt, keine Kopie.
 * Die Vorgaben (8000 Wh, 5000 W) sind dieselben wie in eos-config-sync und
 * eos-adapter, damit eine unvollstaendige Hauptanlage gleich gerechnet wird.
 *
 * @module services/multi-gx/planning
 */
import { getPowerLimits } from '../power-limits.js';
import { betaGateOpen } from '../../beta-features.js';

const finite = (v) => v != null && v !== '' && Number.isFinite(Number(v));

function follower(ctx, cfg) {
  const c = cfg?.multiGx || {};
  const s = ctx?.state?.multiGx;
  const capacityWh = Number(c.batteryCapacityWh) || 0;
  if (c.enabled !== true || !betaGateOpen(cfg, 'multiGx') || !s || s.online !== true || !finite(s.socPct) || capacityWh <= 0) return null;
  return {
    capacityWh,
    maxChargeW: Number(c.maxChargeW) || 0,
    maxDischargeW: Number(c.maxDischargeW) || 0,
    socPct: Number(s.socPct),
    minSocPct: finite(s.minSocPct) ? Number(s.minSocPct) : (finite(c.minSocPct) ? Number(c.minSocPct) : 10),
  };
}

const primaryCapacityWh = (cfg) => Number(cfg?.optimizer?.batteryCapacityWh) || 8000;
const weighted = (a, capA, b, capB) => Number(((a * capA + b * capB) / (capA + capB)).toFixed(1));

/** Config fuer EOS/Plan-Umrechnung: Akku- und Wechselrichterwerte beider Anlagen. */
export function planningCfg(ctx, cfg = ctx?.getCfg?.()) {
  const f = follower(ctx, cfg);
  if (!f) return cfg;
  const opt = cfg.optimizer || {};
  const sp = cfg.system?.power || {};
  const inverterW = getPowerLimits(cfg).limits.inverterMaxPowerW;
  const power = { ...sp, inverterMaxPowerW: inverterW + Math.max(f.maxChargeW, f.maxDischargeW) };
  if (finite(sp.batteryCapacityWh)) power.batteryCapacityWh = Number(sp.batteryCapacityWh) + f.capacityWh;
  if (finite(sp.batteryMaxChargeW)) power.batteryMaxChargeW = Number(sp.batteryMaxChargeW) + f.maxChargeW;
  if (finite(sp.batteryMaxDischargeDcW)) power.batteryMaxDischargeDcW = Number(sp.batteryMaxDischargeDcW) + f.maxDischargeW;
  return {
    ...cfg,
    optimizer: {
      ...opt,
      batteryCapacityWh: primaryCapacityWh(cfg) + f.capacityWh,
      maxChargeW: (Number(opt.maxChargeW) || 5000) + f.maxChargeW,
      maxDischargeW: (Number(opt.maxDischargeW) || 5000) + f.maxDischargeW,
    },
    system: { ...(cfg.system || {}), power },
  };
}

/**
 * Akkuleistung der zweiten Anlage fuer die Hauslast-Korrektur (Codex Runde 2):
 * sie haengt hinter dem Zaehler der Hauptanlage, ihr Laden/Entladen steckt im
 * gemessenen Verbrauch. 0, wenn sie nicht einbezogen ist oder der Wert aelter
 * als 20 s ist. Vorzeichen: + = laedt.
 */
export function followerBatteryForLoadW(ctx, nowMs = Date.now()) {
  return followerBatteryForFlow(ctx, nowMs)?.batteryPowerW ?? 0;
}

/**
 * Akku der zweiten Anlage fuer die Energiefluss-Aufteilung (21.10.2026, Chrissi:
 * „kannst die Akkus dort getrennt aufzeigen“): { batteryPowerW (+ = laedt), socPct }
 * unter denselben Bedingungen wie followerBatteryForLoadW, sonst null. null heisst
 * „keine zweite Anlage einbezogen“ — dann schreibt DVhub keine Akku-2-Werte; eine
 * einbezogene, ruhende Anlage liefert dagegen 0 W.
 */
export function followerBatteryForFlow(ctx, nowMs = Date.now()) {
  const cfg = ctx?.getCfg?.();
  const f = follower(ctx, cfg);
  const s = ctx?.state?.multiGx;
  if (!f || !finite(s?.batteryPowerW)) return null;
  if (finite(s.updatedAt) && nowMs - Number(s.updatedAt) > 20000) return null;
  return { batteryPowerW: Number(s.batteryPowerW), socPct: f.socPct };
}

/** Ladestand fuer die Planung: beide Akkus nach Kapazitaet gewichtet. */
export function planningSocPct(ctx) {
  const cfg = ctx?.getCfg?.();
  const primary = ctx?.state?.victron?.soc;
  const f = follower(ctx, cfg);
  if (!f || !finite(primary)) return primary;
  return weighted(Number(primary), primaryCapacityWh(cfg), f.socPct, f.capacityWh);
}

/** Mindest-SoC fuer die Planung: Untergrenze der Hauptanlage und der zweiten, gewichtet. */
export function planningMinSocPct(ctx, primaryMinSocPct) {
  const cfg = ctx?.getCfg?.();
  const f = follower(ctx, cfg);
  if (!f || !finite(primaryMinSocPct)) return primaryMinSocPct;
  return weighted(Number(primaryMinSocPct), primaryCapacityWh(cfg), f.minSocPct, f.capacityWh);
}
