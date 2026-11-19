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
import { resolveSecondInverter, secondInverterTelemetry, sungrowEffectivePowerW, sungrowRealSocPct, sungrowSocFloor, sungrowSocFloorBufferPct, sungrowSystemSoc } from '../inverter/sungrow.js';

const finite = (v) => v != null && v !== '' && Number.isFinite(Number(v));

function isSungrow(ctx, cfg) {
  return cfg?.manufacturer === 'sungrow' || cfg?.identify?.kind === 'sungrow' || ctx?.state?.victron?.device?.vendor === 'sungrow';
}

/**
 * Anlagen-Lade-/Entladeleistung + Kapazität beider Sungrow-WR aus den GELESENEN GERÄTEWERTEN für EOS/Planung
 * (Aufgabe 4, Feld 15.11.: EOS bekam battery_max_charge_w 10600 statt 21200, weil die Slave-Konfig leer war und
 * der Slave mit 0 W zählte). GLEICHE Regel wie die Regelgrenze im Aktuator: je WR min(Feld-Übersteuerung,
 * Gerätegrenze 33047/33048, BDC-Nennleistung). Der Master nimmt seine Gerätewerte (state.victron.device) statt
 * optimizer.maxChargeW, der Slave die seinen (state.sungrowSecond); das Feld ist nur Übersteuerung (strenger).
 *
 * - inverterMaxPowerW an EOS (Christin 15.11.) = Summe der WR-Nennleistungen (je WR min(Entlade-Gerätewert, BDC)),
 *   NICHT sungrow.maxPowerW (Testgrenze/operator-Cap). EOS soll die volle Anlagenfähigkeit sehen.
 * - Kapazität: Feld (operator) zuerst, sonst der Gerätevorschlag 33049 (Master 33049=0 → Feld).
 * Null, wenn es kein Sungrow ist oder weder Master-Gerätewerte noch ein aggregierter Slave vorliegen (dann bleibt
 * die Config unverändert — Rückwärtskompatibilität).
 */
function sungrowSystemLimits(ctx, cfg) {
  if (!isSungrow(ctx, cfg)) return null;
  const opt = cfg?.optimizer || {};
  const dev = ctx?.state?.victron?.device || {};
  const masterBdc = Number(dev.bdcRatedW) || null;
  const masterCharge = sungrowEffectivePowerW(opt.maxChargeW, dev.maxChargeWDevice, masterBdc);
  const masterDischarge = sungrowEffectivePowerW(opt.maxDischargeW, dev.maxDischargeWDevice, masterBdc);
  const masterHasDevice = finite(dev.maxChargeWDevice) || finite(dev.maxDischargeWDevice);

  // Slave nur, wenn aggregiert UND online/frisch (wie bisher). Gerätewerte aus der Telemetrie.
  const slaveTel = resolveSecondInverter(cfg).aggregateTelemetry === true ? secondInverterTelemetry(ctx?.state, cfg, {}) : null;
  const si = cfg?.sungrow?.secondInverter || {};
  const s = ctx?.state?.sungrowSecond || {};
  let slaveCharge = 0; let slaveDischarge = 0; let slaveCap = 0;
  if (slaveTel) {
    const slaveBdc = Number(slaveTel.bdcRatedW) || null;
    slaveCharge = sungrowEffectivePowerW(si.maxChargeW, slaveTel.maxChargeWDevice, slaveBdc);
    slaveDischarge = sungrowEffectivePowerW(si.maxDischargeW, slaveTel.maxDischargeWDevice, slaveBdc);
    slaveCap = Number(si.batteryCapacityWh) || Number(s.batteryCapacityLimitWh) || 0;
  }
  // Nichts zu ändern (Einzel-WR ohne gelesene Gerätewerte, kein Slave) → null, Config bleibt unverändert.
  if (!slaveTel && !masterHasDevice) return null;

  const masterCap = Number(opt.batteryCapacityWh) || Number(dev.batteryCapacityLimitWh) || 0;
  return {
    hasSlave: slaveTel != null,
    maxChargeW: masterCharge + slaveCharge,
    maxDischargeW: masterDischarge + slaveDischarge,
    // inverter_max_power_w = Summe der WR-Nennleistungen (Entladeseite ∧ BDC), nicht die operator-Testgrenze maxPowerW.
    inverterMaxPowerW: masterDischarge + slaveDischarge,
    capacityWh: masterCap + slaveCap,
  };
}

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

/**
 * Zweite Anlage wirksam eingerichtet (Schalter + Beta-Freigabe + Adresse +
 * Kapazität), aber gerade nicht in der Planung (nicht erreichbar, kein
 * Ladestand)? Dann wären Kapazität und Ladestand nur die der Hauptanlage —
 * der Netzstrom-Zähler behandelt den Akku-Inhalt dann als unbekannt. Ohne
 * wirksame zweite Anlage (aus, Beta zu, keine Adresse) gilt die Hauptanlage
 * allein (Gegenprüfung 6555bdcf, P2: sonst blieb die Sperre dauerhaft).
 */
export function secondGxMissing(ctx, cfg = ctx?.getCfg?.()) {
  const c = cfg?.multiGx || {};
  if (c.enabled !== true || !betaGateOpen(cfg, 'multiGx') || !String(c.host || '').trim()) return false;
  if (!(Number(c.batteryCapacityWh) > 0)) return false;
  return follower(ctx, cfg) == null;
}
const weighted = (a, capA, b, capB) => Number(((a * capA + b * capB) / (capA + capB)).toFixed(1));

/** Config fuer EOS/Plan-Umrechnung: Akku- und Wechselrichterwerte beider Anlagen. */
export function planningCfg(ctx, cfg = ctx?.getCfg?.()) {
  // Zwei parallele Sungrow-WR (Aufgabe 4): Akku-/Wechselrichterwerte aus den GELESENEN GERÄTEWERTEN beider WR
  // (Master device + Slave), nicht aus der (im Feld leeren) Slave-Konfig. Schließt den Multi-GX-Zweig aus.
  const sg = sungrowSystemLimits(ctx, cfg);
  if (sg) {
    const opt = cfg.optimizer || {};
    const sp = cfg.system?.power || {};
    const power = { ...sp, inverterMaxPowerW: sg.inverterMaxPowerW };
    if (sg.capacityWh > 0) power.batteryCapacityWh = sg.capacityWh;
    power.batteryMaxChargeW = sg.maxChargeW;
    power.batteryMaxDischargeDcW = sg.maxDischargeW;
    return {
      ...cfg,
      optimizer: {
        ...opt,
        ...(sg.capacityWh > 0 ? { batteryCapacityWh: sg.capacityWh } : {}),
        maxChargeW: sg.maxChargeW,
        maxDischargeW: sg.maxDischargeW,
      },
      system: { ...(cfg.system || {}), power },
    };
  }
  // Zweite Victron-GX-Anlage (multi-gx) — getrennter Pfad.
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

/**
 * Zweite Anlage steckt im Ladestand der Planung (planningSocPct), aber ihre
 * Akkuwerte sind nicht aktuell (aelter als 20 s oder Akkuleistung unbekannt) —
 * dann fehlt ihre Entladung im Energiefluss und ihr Ladestand ist alt. Der
 * Netzstrom-Zaehler bucht dann nichts ab (Gegenpruefung Release 1.0.9, P2).
 * Nicht einbezogene Anlage: false (das deckt secondGxMissing ab).
 */
export function followerBatteryStale(ctx, nowMs = Date.now()) {
  const cfg = ctx?.getCfg?.();
  return follower(ctx, cfg) != null && followerBatteryForFlow(ctx, nowMs) == null;
}

/** Ladestand fuer die Planung: beide Akkus nach Kapazitaet gewichtet. */
export function planningSocPct(ctx) {
  const cfg = ctx?.getCfg?.();
  const primary = ctx?.state?.victron?.soc;
  // M1 (Christin 16.11.): EOS bekommt den ECHTEN SoC (real %), nicht den fensterrelativen gemeldeten Sungrow-Wert.
  // Je WR aus 13059/13058 in echt umrechnen, dann kapazitätsgewichtet mitteln — konsistent mit dem Boden (ebenfalls
  // real). Ohne gelesenes Gerätefenster bleibt der gemeldete Wert stehen (rückwärtskompatibel).
  if (isSungrow(ctx, cfg)) {
    const dev = ctx?.state?.victron?.device || {};
    const opt = cfg?.optimizer || {};
    const masterReported = finite(ctx?.state?.victron?.sungrowMasterSocPct) ? Number(ctx.state.victron.sungrowMasterSocPct) : primary;
    const masterReal = sungrowRealSocPct(masterReported, dev.minSocPctDevice, dev.maxSocPctDevice);
    const slaveTel = resolveSecondInverter(cfg).aggregateTelemetry === true ? secondInverterTelemetry(ctx?.state, cfg, {}) : null;
    const slaveReal = slaveTel ? sungrowRealSocPct(slaveTel.socPct, slaveTel.minSocPctDevice, slaveTel.maxSocPctDevice) : null;
    const s = ctx?.state?.sungrowSecond || {};
    const masterCap = Number(opt.batteryCapacityWh) || Number(dev.batteryCapacityLimitWh) || 0;
    const slaveCap = slaveTel ? (Number(cfg?.sungrow?.secondInverter?.batteryCapacityWh) || Number(s.batteryCapacityLimitWh) || 0) : 0;
    return sungrowSystemSoc(masterReal, slaveReal, { masterCapacityWh: masterCap, secondCapacityWh: slaveCap }) ?? masterReal ?? primary;
  }
  const f = follower(ctx, cfg);
  if (!f || !finite(primary)) return primary;
  return weighted(Number(primary), primaryCapacityWh(cfg), f.socPct, f.capacityWh);
}

/**
 * Ladestand für den ENTLADE-BODEN am Chokepoint (Befund 1.4-2, Christin 16.11.): der Wert, der gegen den REALEN
 * harten Boden (hardFloorSocPct) verglichen wird. Bei Sungrow den gemeldeten FENSTERRELATIVEN SoC je WR in echt
 * umrechnen (13059/13058) — sonst sperrte der Boden bei gemeldet 1 % (real ~11 %) fälschlich. Der Boden schützt den
 * schwächeren Akku, darum der NIEDRIGERE der beiden realen SoC (sungrowSocFloor, min), nicht der kapazitätsgewichtete
 * (das ist planningSocPct für EOS). Non-Sungrow/Multi-GX: unverändert state.victron.socFloorPct ?? state.victron.soc.
 * null, wenn kein SoC bekannt ist (der Aufrufer behandelt das als „unbekannt" → fail-safe halten).
 */
export function floorSocPct(ctx) {
  const cfg = ctx?.getCfg?.();
  const victron = ctx?.state?.victron || {};
  if (isSungrow(ctx, cfg)) {
    const dev = victron.device || {};
    // Master: im Zwei-WR-Betrieb steht der gemeldete Master-Wert in sungrowMasterSocPct, sonst in victron.soc.
    const masterReported = finite(victron.sungrowMasterSocPct) ? Number(victron.sungrowMasterSocPct) : victron.soc;
    const masterReal = sungrowRealSocPct(masterReported, dev.minSocPctDevice, dev.maxSocPctDevice);
    const slaveTel = resolveSecondInverter(cfg).aggregateTelemetry === true ? secondInverterTelemetry(ctx?.state, cfg, {}) : null;
    const slaveReal = slaveTel ? sungrowRealSocPct(slaveTel.socPct, slaveTel.minSocPctDevice, slaveTel.maxSocPctDevice) : null;
    return sungrowSocFloor(masterReal, slaveReal);
  }
  const socRaw = victron.socFloorPct ?? victron.soc;
  return finite(socRaw) ? Number(socRaw) : null;
}

/**
 * Sungrow: aus welchen Geräte-Werten der Entlade-Boden (planningMinSocPct) gerade besteht — die höhere Geräte-Untergrenze
 * (Master, dazu der Slave nur mit frischer, aggregierter Messung) und der Puffer. Für die Herkunftsangabe der Leitstand-
 * Kachel (Codex 50deb8d3/4fc6e8da), dieselben Eingänge wie planningMinSocPct. Nicht Sungrow → null.
 */
export function planningSocFloorParts(ctx) {
  const cfg = ctx?.getCfg?.();
  if (!isSungrow(ctx, cfg)) return null;
  const dev = ctx?.state?.victron?.device || {};
  const slaveTel = resolveSecondInverter(cfg).aggregateTelemetry === true ? secondInverterTelemetry(ctx?.state, cfg, {}) : null;
  const mins = [dev.minSocPctDevice, slaveTel?.minSocPctDevice].filter((v) => finite(v)).map(Number);
  return { deviceMinSocPct: mins.length ? Math.max(...mins) : null, bufferPct: sungrowSocFloorBufferPct(cfg) };
}

/** Mindest-SoC fuer die Planung: Untergrenze der Hauptanlage und der zweiten, gewichtet. */
export function planningMinSocPct(ctx, primaryMinSocPct) {
  const cfg = ctx?.getCfg?.();
  // Zwei Sungrow-WR (Aufgabe 4 + M1, Christin 16.11.): Min-SoC an EOS = der EFFEKTIVE Entlade-Boden, den der Aktuator
  // einhält — max(hartem Boden/Live, 13059 je WR + Puffer), alles real %. KEINE Gewichtung (der Boden schützt den
  // schwächeren Akku → der HÖHERE Wert, konservativ). Puffer kundeneinstellbar (Standard 0 seit M24). Gleicher Boden wie im
  // Aktuator, sonst plant EOS Entladung bis 10 %, die DVhub bei 11 % abbricht (Mismatch).
  if (isSungrow(ctx, cfg)) {
    const dev = ctx?.state?.victron?.device || {};
    const slaveTel = resolveSecondInverter(cfg).aggregateTelemetry === true ? secondInverterTelemetry(ctx?.state, cfg, {}) : null;
    const buffer = sungrowSocFloorBufferPct(cfg);
    const devFloor = (v) => (finite(v) ? Number(v) + buffer : null);
    const cands = [primaryMinSocPct, devFloor(dev.minSocPctDevice), devFloor(slaveTel?.minSocPctDevice)].filter((v) => finite(v)).map(Number);
    return cands.length ? Math.max(...cands) : primaryMinSocPct;
  }
  const f = follower(ctx, cfg);
  if (!f || !finite(primaryMinSocPct)) return primaryMinSocPct;
  return weighted(Number(primaryMinSocPct), primaryCapacityWh(cfg), f.minSocPct, f.capacityWh);
}
