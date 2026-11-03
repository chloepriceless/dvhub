// services/optimizer/grid-share-poll.js — Netzstrom-Zähler aus dem Poll-Pfad
// füttern (grid-share.js).
//
// polling.js ruft ctx.gridSharePollTick(state.victron) bei JEDER Abfrage auf,
// noch vor ctx.onPollComplete. Der echte onPollComplete wird in server.js erst
// eingehängt, wenn Datenbank, Migrationen und Snapshots bereit sind — bei
// langsamem PostgreSQL bis ~140 s nach dem Start. Hinge der Zähler daran,
// fehlte eine laufende Netzladung aus dieser Zeit (bei 6 kW rund 233 Wh, mehr
// als die Sperrschwelle; Gesamtprüfung Release 1.0.9, Befund 7).
//
// Akku-Inhalt = Ladestand × Kapazität. Die Kapazität kommt nur aus der
// Einstellung optimizer.batteryCapacityWh (bzw. der heute gültigen
// Akku-Ausbaustufe, die applyVictronDefaults dort einträgt), mit zweiter
// GX-Anlage plus multiGx.batteryCapacityWh. Herstellerprofile und gelesene
// Register liefern keine Kapazität. Fehlt sie, gibt es KEINE Ersatzzahl
// (früher 8000 Wh: ein 40-kWh-Akku mit 20 kWh Netzstrom wurde auf ~5,7 kWh
// gekappt, die Sperre fiel viel zu früh; Gesamtprüfung Release 1.0.9,
// Befund 3): der Zähler kappt dann nicht am Ladestand und bucht beim Entladen
// nichts ab — die Sperre bleibt im Zweifel an. Log und Leitstand melden die
// fehlende Kapazität (capacityMissing).

import { planningCfg, planningSocPct, secondGxMissing, followerBatteryStale } from '../multi-gx/planning.js';

/**
 * Kapazität und Ladestand für den Zähler.
 * @returns {{capacityWh:number|null, socPct:number|null, capacityMissing:boolean}}
 */
export function gridShareCapacityInput(ctx, cfg = ctx?.getCfg?.()) {
  const main = Number(cfg?.optimizer?.batteryCapacityWh);
  if (!(Number.isFinite(main) && main > 0)) return { capacityWh: null, socPct: null, capacityMissing: true };
  // Zweite GX eingeschaltet, aber gerade nicht einbezogen: Kapazität und
  // Ladestand wären nur die der Hauptanlage → Akku-Inhalt unbekannt, damit die
  // Kappung keinen Netzstrom abschreibt (Gegenprüfung 8465a540, P2).
  if (secondGxMissing(ctx, cfg)) return { capacityWh: null, socPct: null, capacityMissing: false };
  const cap = Number(planningCfg(ctx, cfg)?.optimizer?.batteryCapacityWh);
  const soc = planningSocPct(ctx);
  return {
    capacityWh: Number.isFinite(cap) && cap > 0 ? cap : null,
    socPct: soc == null ? null : soc,
    capacityMissing: false,
  };
}

/**
 * Ein Zählschritt je Abfrage. Hängt die Live-Werte an `victron` (Telemetrie
 * und Leitstand). Wirft nie.
 * @param {object} ctx { gridShare, getCfg, pushLog, state }
 */
export function createGridSharePollTick(ctx) {
  return function gridSharePollTick(victron, nowMs = Date.now()) {
    const tracker = ctx?.gridShare;
    if (!tracker || typeof tracker.tick !== 'function') return null;
    try {
      const cfg = ctx.getCfg?.() || {};
      const cap = gridShareCapacityInput(ctx, cfg);
      // Akkuwerte (Lesefehler, Stempel, Einfrier-Wächter, Kreuzprobe) prüft der
      // Zähler selbst an `victron`; die zweite Anlage hat eigene Stempel
      // (state.multiGx) — veraltet heißt auch dort: nichts abbuchen.
      const gs = tracker.tick({
        nowMs,
        victron,
        socPct: cap.socPct,
        capacityWh: cap.capacityWh,
        capacityMissing: cap.capacityMissing,
        secondBatteryStale: followerBatteryStale(ctx, nowMs),
      });
      if (gs && victron) {
        victron.batteryGridShareWh = Math.round(gs.gridWh);
        victron.batteryGridSharePct = gs.sharePct;
        victron.batteryGridShareToHomeW = gs.toHomeW;
        victron.batteryGridShareToGridW = gs.toGridW;
      }
      return gs;
    } catch (err) {
      try { ctx.pushLog?.('grid_share_error', { error: err?.message || String(err) }, 'warn'); } catch { /* nie werfen */ }
      return null;
    }
  };
}
