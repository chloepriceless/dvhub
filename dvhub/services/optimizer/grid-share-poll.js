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
// Register liefern keine Kapazität. Das Feld der Kleinen Börsenautomatik
// (schedule.smallMarketAutomation.batteryCapacityKwh) zählt bewusst nicht: es
// steht in jeder Konfiguration mit dem Standard 30 kWh (createDefaultConfig) —
// eingetragen und nie angefasst sind nicht zu unterscheiden (Gegenprüfung
// 0bd0577a, P2 verworfen). Fehlt die Kapazität, gibt es KEINE Ersatzzahl
// (früher 8000 Wh: ein 40-kWh-Akku mit 20 kWh Netzstrom wurde auf ~5,7 kWh
// gekappt, die Sperre fiel viel zu früh; Gesamtprüfung Release 1.0.9,
// Befund 3): der Zähler kappt dann nicht am Ladestand und bucht beim Entladen
// nichts ab — die Sperre bleibt im Zweifel an. Log und Leitstand melden die
// fehlende Kapazität (capacityMissing).

import { planningCfg, planningSocPct, planningMinSocPct, secondGxMissing, followerBatteryStale } from '../multi-gx/planning.js';
import { resolveSecondInverter, secondInverterTelemetry } from '../inverter/sungrow.js';
import { resolveEosMinSocPct } from './eos-config-sync.js';
import { monoNow } from '../mono-clock.js';

const finiteOrNullGs = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Zwei Sungrow-WR im Parallelbetrieb (aggregateTelemetry + Slave einbezogen): die Systemkapazität des
 * Netzstrom-Zählers ist die SUMME beider Akkus, der Ladestand der System-SoC (state.victron.soc, Punkt 2).
 * Fehlt die Zweit-Kapazität (sungrow.secondInverter.batteryCapacityWh), ist die Summe unbekannt → wie eine
 * fehlende Kapazität behandeln (keine Kappung, nichts abbuchen). Gibt null zurück, wenn gerade NICHT aggregiert
 * wird (Slave offline/aggregateTelemetry aus) → dann gilt der normale (Master-only) Pfad darunter.
 * @returns {{capacityWh:number|null, socPct:number|null, capacityMissing:boolean}|null}
 */
function sungrowSystemCapacityInput(ctx, cfg, mainCapWh) {
  if (!resolveSecondInverter(cfg).aggregateTelemetry) return null;
  if (secondInverterTelemetry(ctx?.state, cfg, {}) == null) return null; // Slave nicht einbezogen → Master-only
  // M10 (Feld 16.11.): der ECHTE System-SoC (planningSocPct rechnet beide gemeldeten Fenster-SoCs real um),
  // NICHT der gemeldete Fenster-Mittel (state.victron.soc) — sonst deckelt der Zähler am falschen Inhalt und die
  // Sperre hängt bei leerem Akku.
  const socPct = finiteOrNullGs(planningSocPct(ctx));
  const secondCapWh = Number(cfg?.sungrow?.secondInverter?.batteryCapacityWh);
  if (!(Number.isFinite(secondCapWh) && secondCapWh > 0)) {
    return { capacityWh: null, socPct, capacityMissing: true };
  }
  return { capacityWh: mainCapWh + secondCapWh, socPct, capacityMissing: false };
}

/**
 * Kapazität und Ladestand für den Zähler.
 * @returns {{capacityWh:number|null, socPct:number|null, capacityMissing:boolean}}
 */
export function gridShareCapacityInput(ctx, cfg = ctx?.getCfg?.()) {
  const main = Number(cfg?.optimizer?.batteryCapacityWh);
  if (!(Number.isFinite(main) && main > 0)) return { capacityWh: null, socPct: null, floorPct: 0, capacityMissing: true };
  // Wirksamer Entlade-Boden (real %), derselbe wie Aktuator/EOS (M10): der nutzbare Akku-Inhalt — und die Obergrenze
  // für den Netzstrom-Anteil — liegt NUR über diesem Boden. max(hardFloor/Live-Min, geräteMin+Puffer je WR).
  const primaryMin = resolveEosMinSocPct(ctx?.state?.victron?.minSocPct, cfg?.optimizer?.hardFloorSocPct);
  const floorPct = finiteOrNullGs(planningMinSocPct(ctx, primaryMin)) ?? 0;
  // Zwei Sungrow-WR: Systemkapazität = Summe beider Akkus (vor dem multi-gx-Pfad; sie schließen sich aus).
  const sungrow = sungrowSystemCapacityInput(ctx, cfg, main);
  if (sungrow) return { ...sungrow, floorPct };
  // Zweite GX eingeschaltet, aber gerade nicht einbezogen: Kapazität und
  // Ladestand wären nur die der Hauptanlage → Akku-Inhalt unbekannt, damit die
  // Kappung keinen Netzstrom abschreibt (Gegenprüfung 8465a540, P2).
  if (secondGxMissing(ctx, cfg)) return { capacityWh: null, socPct: null, floorPct, capacityMissing: false };
  const cap = Number(planningCfg(ctx, cfg)?.optimizer?.batteryCapacityWh);
  const soc = planningSocPct(ctx);
  return {
    capacityWh: Number.isFinite(cap) && cap > 0 ? cap : null,
    socPct: soc == null ? null : soc,
    floorPct,
    capacityMissing: false,
  };
}

/**
 * Ein Zählschritt je Abfrage. Hängt die Live-Werte an `victron` (Telemetrie
 * und Leitstand). Wirft nie.
 * @param {object} ctx { gridShare, getCfg, pushLog, state }
 */
export function createGridSharePollTick(ctx) {
  // A26: Zeitpunkt (Tageswechsel, Protokoll) aus der Wanduhr, Abstände monoton. Ein übergebenes nowMs (Tests) misst
  // ohne eigenes monoMs auch die Abstände wie bisher.
  return function gridSharePollTick(victron, nowMs, monoMs) {
    if (monoMs == null) monoMs = nowMs != null ? nowMs : monoNow();
    if (nowMs == null) nowMs = Date.now();
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
        monoMs,
        victron,
        socPct: cap.socPct,
        capacityWh: cap.capacityWh,
        floorPct: cap.floorPct,
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
