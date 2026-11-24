// test/golden/generate-split-vectors.mjs — erzeugt die Golden-Vektoren der reinen Split-/Planungs-Funktionen.
//
// Stufe S0 („Bestand festschreiben“) der herstellergenerischen WR-Basis: friert den IST-Zustand der reinen
// Funktionen als Eingang→Ausgang-Referenz ein. KEIN Produktcode wird geaendert; hier werden nur die heutigen
// Funktionen deterministisch durchgerechnet und als JSON abgelegt.
//
// Deterministisch OHNE Zufall: alle Faelle entstehen aus festen Parameter-Rastern (geschachtelte Schleifen) plus
// ausdruecklich benannten Feldfaellen. Zweimal ausfuehren ⇒ byte-gleiche Dateien (S0-Tor „reproduzierbar“).
//
//   cd dvhub && export PATH=/opt/homebrew/opt/node@22/bin:$PATH && node test/golden/generate-split-vectors.mjs
//
// Schema je Datei: { function, schema, generator, count, now?, vectors: [ { name, input, output } ] }.
// input: reine Funktionen { args: [...] }; ctx-basiert { state, cfg, now, primaryMinSocPct? }. Siehe README.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyGolden, normalized, PURE_FUNCTIONS, CTX_FUNCTIONS } from './apply.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'inverter-split');
const SCHEMA = 'dvhub.golden-split/1';
// Fester Zeitpunkt fuer die ctx-basierten Funktionen (secondInverterTelemetry-Frischepruefung). Reiner Konstante,
// damit die Vektoren unabhaengig von der Wanduhr reproduzierbar sind. 2026-11-16T12:00:00Z.
const FIXED_NOW = 1794571200000;

/** Ein Vektor: Eingang durch die echte Funktion schicken, Ausgang JSON-normiert ablegen. */
function vec(fn, name, input) {
  return { name, input, output: normalized(applyGolden(fn, input)) };
}

// Kleine Helfer, damit die Raster lesbar bleiben.
const pairs = (xs) => xs; // Lesbarkeits-Alias fuer „Liste von Tupeln“

// ===========================================================================================================
// 1) splitStrategyShares(strategy, options) — alle 7 Strategien, Grenzen, Feldfaelle
// ===========================================================================================================
function genSplitStrategyShares() {
  const fn = 'splitStrategyShares';
  const STRATS = ['master-only', 'ratio', 'by-capacity', 'by-power', 'soc-balance', 'priority-master', 'priority-slave'];
  const vectors = [];

  // -- Pflicht-Feldfaelle (einzeln, erkennbar benannt) --
  const field = (name, options) => vectors.push(vec(fn, name, { args: ['soc-balance', options] }));
  // 9,2 / 14,4 %: Entladen → hoeherer SoC (Slave 14,4) mehr; Laden → niedrigerer (Master 9,2) mehr.
  field('feld_9.2_14.4_entladen', { powerW: 4000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 9.2, slaveSoc: 14.4, masterCapacityWh: 10000, slaveCapacityWh: 10000 });
  field('feld_9.2_14.4_laden', { powerW: 4000, charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 9.2, slaveSoc: 14.4, masterCapacityWh: 10000, slaveCapacityWh: 10000 });
  // 0,8 / 2,2 %: fast leer, kleiner Abstand.
  field('feld_0.8_2.2_entladen', { powerW: 3000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 0.8, slaveSoc: 2.2, masterCapacityWh: 9600, slaveCapacityWh: 9600 });
  field('feld_0.8_2.2_laden', { powerW: 3000, charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 0.8, slaveSoc: 2.2, masterCapacityWh: 9600, slaveCapacityWh: 9600 });
  // Slave offline (slaveMax = 0) → alles an den Master.
  vectors.push(vec(fn, 'slave_offline', { args: ['soc-balance', { powerW: 4000, charge: false, masterMax: 5000, slaveMax: 0, masterSoc: 50, slaveSoc: null, masterCapacityWh: 10000, slaveCapacityWh: 0 }] }));
  // Boden je Einheit mit N1-Feldwert: Slave am eigenen Entlade-Boden (11 %) → bekommt 0 W, Master uebernimmt.
  vectors.push(vec(fn, 'boden_je_einheit_N1_slave_am_boden', { args: ['soc-balance', { powerW: 4000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 50, slaveSoc: 11, masterCapacityWh: 10000, slaveCapacityWh: 10000, masterFloorPct: 11, slaveFloorPct: 11 }] }));
  // master-only: Slave bleibt uncommanded.
  vectors.push(vec(fn, 'master_only_slave_uncommanded', { args: ['master-only', { powerW: 4000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 50, slaveSoc: 50, masterCapacityWh: 10000, slaveCapacityWh: 10000 }] }));
  // UNGLEICHE Grenzen je WR (Codex: die getrennten master/slaveFloorPct bzw. master/slaveCeilPct muessen
  // abgesichert sein — eine Regression, die sie vertauscht oder die Decke aus maxSocPct statt je WR liest,
  // soll rot werden).
  vectors.push(vec(fn, 'ungleiche_boeden_slave_am_boden', { args: ['soc-balance', { powerW: 4000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 30, slaveSoc: 18, masterCapacityWh: 10000, slaveCapacityWh: 10000, masterFloorPct: 11, slaveFloorPct: 21 }] }));
  vectors.push(vec(fn, 'ungleiche_boeden_master_am_boden', { args: ['soc-balance', { powerW: 4000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 18, slaveSoc: 30, masterCapacityWh: 10000, slaveCapacityWh: 10000, masterFloorPct: 21, slaveFloorPct: 11 }] }));
  vectors.push(vec(fn, 'ungleiche_decken_slave_voll', { args: ['soc-balance', { powerW: 4000, charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 50, slaveSoc: 92, masterCapacityWh: 10000, slaveCapacityWh: 10000, maxSocPct: 100, masterCeilPct: 100, slaveCeilPct: 90 }] }));
  vectors.push(vec(fn, 'ungleiche_decken_master_voll', { args: ['soc-balance', { powerW: 4000, charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 92, slaveSoc: 50, masterCapacityWh: 10000, slaveCapacityWh: 10000, maxSocPct: 100, masterCeilPct: 90, slaveCeilPct: 100 }] }));

  // -- Systematisches Raster --
  const mmSm = pairs([[0, 0], [5000, 0], [0, 5000], [5000, 5000], [3000, 6000], [6000, 3000]]);
  const socs = pairs([[null, null], [10, 10], [10, 50], [95, 20], [0, 100], [50, null]]);
  const powers = [0, 1500, 4000, 12000];
  for (const strat of STRATS) {
    for (const charge of [false, true]) {
      let i = 0;
      for (const [mMax, sMax] of mmSm) {
        for (const [mSoc, sSoc] of socs) {
          for (const p of powers) {
            const options = {
              powerW: p, charge, masterMax: mMax, slaveMax: sMax,
              masterSoc: mSoc, slaveSoc: sSoc,
              masterCapacityWh: 10000, slaveCapacityWh: 8000,
              floorSocPct: 5, maxSocPct: 95, ratioMasterPct: 60, minPowerW: 50,
            };
            vectors.push(vec(fn, `raster_${strat}_${charge ? 'c' : 'd'}_${i++}`, { args: [strat, options] }));
          }
        }
      }
    }
  }
  // Fokussiertes Raster mit UNGLEICHEN Grenzen je WR (getrennte Achsen masterFloorPct/slaveFloorPct/
  // masterCeilPct/slaveCeilPct): je Strategie und Richtung einmal pro Grenz-Lage.
  const limitCases = [
    { masterFloorPct: 11, slaveFloorPct: 21, masterCeilPct: 100, slaveCeilPct: 100, masterSoc: 30, slaveSoc: 18 },
    { masterFloorPct: 21, slaveFloorPct: 11, masterCeilPct: 100, slaveCeilPct: 100, masterSoc: 18, slaveSoc: 30 },
    { masterFloorPct: 5, slaveFloorPct: 5, masterCeilPct: 100, slaveCeilPct: 90, masterSoc: 50, slaveSoc: 92 },
    { masterFloorPct: 5, slaveFloorPct: 5, masterCeilPct: 90, slaveCeilPct: 100, masterSoc: 92, slaveSoc: 50 },
    { masterFloorPct: 11, slaveFloorPct: 21, masterCeilPct: 95, slaveCeilPct: 85, masterSoc: 50, slaveSoc: 50 },
  ];
  for (const strat of STRATS) {
    for (const charge of [false, true]) {
      let j = 0;
      for (const lc of limitCases) {
        const options = { powerW: 4000, charge, masterMax: 5000, slaveMax: 5000, masterCapacityWh: 10000, slaveCapacityWh: 8000, minPowerW: 50, ...lc };
        vectors.push(vec(fn, `limit_${strat}_${charge ? 'c' : 'd'}_${j++}`, { args: [strat, options] }));
      }
    }
  }
  // M28 (402a3df9/07041019/4a4f0e62): Entlade-Marge über dem Boden (dischargeMarginPct) und „liefert nicht"
  // (masterStalled/slaveStalled) nehmen einen WR heraus; masterOut/slaveOut sagen warum ('soc' | 'stalled').
  // Benannte Fälle je Zweig, damit eine Regression in der Übernahme-Regel rot wird.
  const m28 = { powerW: 4000, charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 50, slaveSoc: 50, masterCapacityWh: 10000, slaveCapacityWh: 10000, masterFloorPct: 10, slaveFloorPct: 10 };
  vectors.push(vec(fn, 'm28_master_haengt_slave_uebernimmt', { args: ['soc-balance', { ...m28, masterStalled: true }] }));
  vectors.push(vec(fn, 'm28_slave_haengt_master_uebernimmt', { args: ['soc-balance', { ...m28, slaveStalled: true }] }));
  vectors.push(vec(fn, 'm28_beide_haengen_normale_aufteilung', { args: ['soc-balance', { ...m28, masterStalled: true, slaveStalled: true }] }));
  vectors.push(vec(fn, 'm28_master_haengt_slave_am_boden_behaelt', { args: ['soc-balance', { ...m28, masterStalled: true, slaveSoc: 10 }] }));
  vectors.push(vec(fn, 'm28_master_only_slave_haengt_ohne_wirkung', { args: ['master-only', { ...m28, slaveStalled: true }] }));
  vectors.push(vec(fn, 'm28_marge_slave_knapp_ueber_boden_raus', { args: ['soc-balance', { ...m28, slaveSoc: 11, dischargeMarginPct: 2 }] }));
  vectors.push(vec(fn, 'm28_marge_slave_genau_boden_plus_marge_drin', { args: ['soc-balance', { ...m28, slaveSoc: 12, dischargeMarginPct: 2 }] }));
  vectors.push(vec(fn, 'm28_marge_gilt_nicht_beim_laden', { args: ['soc-balance', { ...m28, charge: true, slaveSoc: 11, dischargeMarginPct: 2 }] }));
  // Raster: je Strategie/Richtung alle Hänge-Kombinationen × Marge × SoC-Lage (frei, Master knapp, Slave knapp).
  const stalledPairs = pairs([[false, false], [true, false], [false, true], [true, true]]);
  const m28Socs = pairs([[50, 40], [11, 40], [40, 11]]);
  for (const strat of STRATS) {
    for (const charge of [false, true]) {
      let k = 0;
      for (const [masterStalled, slaveStalled] of stalledPairs) for (const dischargeMarginPct of [0, 2]) for (const [mSoc, sSoc] of m28Socs) {
        const options = {
          powerW: 4000, charge, masterMax: 5000, slaveMax: 3000, masterSoc: mSoc, slaveSoc: sSoc,
          masterCapacityWh: 10000, slaveCapacityWh: 8000, masterFloorPct: 10, slaveFloorPct: 10, masterCeilPct: 95, slaveCeilPct: 95,
          ratioMasterPct: 60, minPowerW: 50, dischargeMarginPct, masterStalled, slaveStalled,
        };
        vectors.push(vec(fn, `m28_${strat}_${charge ? 'c' : 'd'}_${k++}`, { args: [strat, options] }));
      }
    }
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// 2) splitSungrowPower(decision, master, slave)
// ===========================================================================================================
function genSplitSungrowPower() {
  const fn = 'splitSungrowPower';
  const vectors = [];
  vectors.push(vec(fn, 'slave_offline_alles_master', { args: [{ powerW: 4000 }, { maxW: 5000, weight: 8000 }, { maxW: 0, weight: 0 }] }));
  vectors.push(vec(fn, 'ohne_slave_null', { args: [{ powerW: 4000 }, { maxW: 5000, weight: 8000 }, null] }));
  vectors.push(vec(fn, 'ueberlauf_master_an_grenze', { args: [{ powerW: 9000 }, { maxW: 5000, weight: 9000 }, { maxW: 5000, weight: 1000 }] }));
  const powers = [0, 500, 3000, 8000, 11000];
  const mWs = [0, 3000, 5000];
  const sWs = [0, 3000, 5000];
  const weights = pairs([[0, 0], [8000, 8000], [9000, 1000], [1000, 9000]]);
  let i = 0;
  for (const p of powers) for (const mMax of mWs) for (const sMax of sWs) for (const [mW, sW] of weights) {
    vectors.push(vec(fn, `raster_${i++}`, { args: [{ powerW: p }, { maxW: mMax, weight: mW }, { maxW: sMax, weight: sW }] }));
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// 3) socBalanceWeights(options) — Marge-Modell, Feldfaelle
// ===========================================================================================================
function genSocBalanceWeights() {
  const fn = 'socBalanceWeights';
  const vectors = [];
  const F = (name, o) => vectors.push(vec(fn, name, { args: [o] }));
  F('feld_9.2_14.4_entladen', { charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 9.2, slaveSoc: 14.4, masterCapacityWh: 10000, slaveCapacityWh: 10000 });
  F('feld_9.2_14.4_laden', { charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 9.2, slaveSoc: 14.4, masterCapacityWh: 10000, slaveCapacityWh: 10000 });
  F('feld_0.8_2.2_entladen', { charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: 0.8, slaveSoc: 2.2, masterCapacityWh: 9600, slaveCapacityWh: 9600 });
  F('feld_0.8_2.2_laden', { charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 0.8, slaveSoc: 2.2, masterCapacityWh: 9600, slaveCapacityWh: 9600 });
  F('soc_unbekannt_parallel_nach_kapazitaet', { charge: false, masterMax: 5000, slaveMax: 5000, masterSoc: null, slaveSoc: 30, masterCapacityWh: 10000, slaveCapacityWh: 8000 });
  F('gleicher_soc_kapazitaetsproportional', { charge: true, masterMax: 5000, slaveMax: 5000, masterSoc: 40, slaveSoc: 40, masterCapacityWh: 10000, slaveCapacityWh: 8000 });
  F('ohne_kapazitaet_leistung_als_proxy', { charge: false, masterMax: 6000, slaveMax: 3000, masterSoc: 60, slaveSoc: 20, masterCapacityWh: 0, slaveCapacityWh: 0 });

  const socs = pairs([[10, 10], [10, 50], [50, 10], [95, 20], [0, 100], [null, 40], [40, null], [null, null]]);
  const caps = pairs([[10000, 8000], [8000, 10000], [0, 0], [10000, 0]]);
  let i = 0;
  for (const charge of [false, true]) for (const [mSoc, sSoc] of socs) for (const [mCap, sCap] of caps) {
    vectors.push(vec(fn, `raster_${charge ? 'c' : 'd'}_${i++}`, { args: [{ charge, masterMax: 5000, slaveMax: 5000, masterSoc: mSoc, slaveSoc: sSoc, masterCapacityWh: mCap, slaveCapacityWh: sCap }] }));
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// 4) sungrowRealSocPct(reportedPct, minSocPctDevice, maxSocPctDevice) — Fenster→real, Raender, min=max
// ===========================================================================================================
function genSungrowRealSocPct() {
  const fn = 'sungrowRealSocPct';
  const vectors = [];
  vectors.push(vec(fn, 'gemeldet_0_real_geraetemin', { args: [0, 10, 100] }));     // → 10 (= Geraete-Untergrenze)
  vectors.push(vec(fn, 'gemeldet_100_real_max', { args: [100, 10, 100] }));         // → 100
  vectors.push(vec(fn, 'min_gleich_max_kein_fenster', { args: [50, 20, 20] }));     // max ≤ min → geklemmter Rohwert
  vectors.push(vec(fn, 'kein_fenster_min_fehlt', { args: [50, null, 100] }));       // → geklemmter Rohwert
  vectors.push(vec(fn, 'rohwert_ueber_100_geklemmt', { args: [120, null, null] })); // → 100
  vectors.push(vec(fn, 'rohwert_negativ_geklemmt', { args: [-5, null, null] }));     // → 0
  const reported = [0, 5, 20, 33, 50, 66, 80, 95, 100];
  const mins = [null, 0, 5, 10, 20];
  const maxs = [null, 15, 80, 90, 100];
  let i = 0;
  for (const r of reported) for (const mn of mins) for (const mx of maxs) {
    vectors.push(vec(fn, `raster_${i++}`, { args: [r, mn, mx] }));
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// 5) sungrowDischargeFloorPct(hardFloorPct, deviceMinSocPct, bufferPct)
// ===========================================================================================================
function genSungrowDischargeFloorPct() {
  const fn = 'sungrowDischargeFloorPct';
  const vectors = [];
  // N1-Feldwert: harter Boden 5, Geraete-Min 10, Puffer 1 → wirksamer Boden 11 (wie im Plan/Feld dokumentiert).
  vectors.push(vec(fn, 'N1_hardFloor5_deviceMin10_buffer1', { args: [5, 10, 1] }));
  vectors.push(vec(fn, 'ohne_geraetewert_nur_harter_boden', { args: [5, null, 1] }));
  vectors.push(vec(fn, 'beide_fehlen_null', { args: [null, null, 0] }));
  const hard = [null, 0, 5, 20];
  const devMin = [null, 0, 10, 30, 50];
  const buf = [0, 1, 5];
  let i = 0;
  for (const h of hard) for (const d of devMin) for (const b of buf) {
    vectors.push(vec(fn, `raster_${i++}`, { args: [h, d, b] }));
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// 6) sungrowChargeCeilPct(maxSocPct, deviceMaxSocPct) — Decke/Puffer
// ===========================================================================================================
function genSungrowChargeCeilPct() {
  const fn = 'sungrowChargeCeilPct';
  const vectors = [];
  vectors.push(vec(fn, 'beide_fehlen_100', { args: [null, null] }));
  const maxSoc = [null, 70, 80, 95, 100];
  const devMax = [null, 70, 90, 100];
  let i = 0;
  for (const m of maxSoc) for (const d of devMax) {
    vectors.push(vec(fn, `raster_${i++}`, { args: [m, d] }));
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// 7) sungrowEffectivePowerW(fieldW, deviceW, bdcW) — kleinste je Richtung
// ===========================================================================================================
function genSungrowEffectivePowerW() {
  const fn = 'sungrowEffectivePowerW';
  const vectors = [];
  vectors.push(vec(fn, 'alles_fehlt_null', { args: [null, null, null] }));
  vectors.push(vec(fn, 'feld_uebersteuert_strenger', { args: [3000, 5000, 4000] }));
  const field = [null, 0, 3000, 6000];
  const device = [null, 0, 5000, 10600];
  const bdc = [null, 4000, 10000];
  let i = 0;
  for (const f of field) for (const d of device) for (const b of bdc) {
    vectors.push(vec(fn, `raster_${i++}`, { args: [f, d, b] }));
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// 8) decideEmsCommand(options) — Regler Netz-Sollwert → Akkuleistung
// ===========================================================================================================
function genDecideEmsCommand() {
  const fn = 'decideEmsCommand';
  const vectors = [];
  const F = (name, o) => vectors.push(vec(fn, name, { args: [o] }));
  F('no_setpoint', { setpointW: null, gridImportW: 0, batteryW: 0, maxChargeW: 5000, maxDischargeW: 5000 });
  F('band_ruhe_extern', { setpointW: 100, gridImportW: 0, batteryW: 0, maxChargeW: 5000, maxDischargeW: 5000, forced: false });
  F('forced_kein_band_bei_null', { setpointW: 0, gridImportW: 200, batteryW: 0, pvW: 2000, loadW: 500, maxChargeW: 5000, maxDischargeW: 5000, forced: true });
  // Eingaenge so gewaehlt, dass p>0 (Laden) wird und die PV-Grenze bei noGridCharge WIRKLICH greift (Codex P3):
  // p = 0 + 0,7·(3000−0) = 2100 > surplus(3000−2500)=500 → gekappt auf 500 W, reason charge_pv_only.
  F('netzlade_verbot_charge_pv_only', { setpointW: 3000, gridImportW: 0, batteryW: 0, pvW: 3000, loadW: 2500, maxChargeW: 5000, maxDischargeW: 5000, noGridCharge: true, forced: true });
  // p = 0 + 0,7·(500−3000) = −1750 (Entladen); Netto-Last 1200−200=1000 < 1750 → gekappt auf 1000 W, discharge_load_only.
  F('nur_last_decken_discharge_load_only', { setpointW: 500, gridImportW: 3000, batteryW: 0, pvW: 200, loadW: 1200, maxChargeW: 5000, maxDischargeW: 5000, forced: true });
  F('entlade_boden_sperrt_entladen', { setpointW: 2000, gridImportW: 3000, batteryW: 0, maxChargeW: 5000, maxDischargeW: 5000, forced: true, socPct: 8, floorSocPct: 11 });
  F('telemetrie_fehlt', { setpointW: 2000, gridImportW: null, batteryW: 0, maxChargeW: 5000, maxDischargeW: 5000, forced: true });
  F('power_limit_unbekannt', { setpointW: 2000, gridImportW: 1000, batteryW: 0, maxChargeW: 0, maxDischargeW: 0, forced: true });
  // Unter dem Boden bleibt Laden aus PV-Ueberschuss ERLAUBT (nur Entladen sperrt belowFloor, sungrow.js:295-298).
  // Codex-Beispiel: p = 0 + 0,7·(0−(−2000)) = 1400 > 0 → Laden 1400 W, reason regulate (kein discharge_floor).
  F('unter_boden_laden_aus_pv_erlaubt', { setpointW: 0, gridImportW: -2000, batteryW: 0, pvW: 3000, loadW: 500, maxChargeW: 5000, maxDischargeW: 5000, forced: true, socPct: 8, floorSocPct: 11 });
  // Einstellbare Reglerwerte (resolveSungrowEmsOptions erlaubt gain≥0.1): obere Klemmung Math.min(1,gain) und
  // ein minPowerW≠50 muessen eingefroren sein.
  F('gain_hoch_geklemmt_auf_1', { setpointW: 3000, gridImportW: 0, batteryW: 0, maxChargeW: 5000, maxDischargeW: 5000, forced: true, gain: 1.5 });
  F('gain_niedrig_0_1', { setpointW: 3000, gridImportW: 0, batteryW: 0, maxChargeW: 5000, maxDischargeW: 5000, forced: true, gain: 0.1 });
  F('minPowerW_hoch_stop', { setpointW: 120, gridImportW: 0, batteryW: 0, maxChargeW: 5000, maxDischargeW: 5000, forced: true, minPowerW: 200 });
  F('bandW_null_forced_false_regelt', { setpointW: 120, gridImportW: 0, batteryW: 0, maxChargeW: 5000, maxDischargeW: 5000, forced: false, bandW: 0 });

  const setpoints = [-3000, -500, 0, 500, 3000];
  const grids = [-1000, 0, 1500];
  const bats = [-1000, 0, 1000];
  const pvs = [null, 3000];
  const loads = [null, 2000];
  const limits = pairs([[5000, 5000], [0, 5000]]);
  const flags = pairs([[false, false], [true, false], [true, true]]); // [forced, noGridCharge]
  let i = 0;
  for (const s of setpoints) for (const g of grids) for (const b of bats) for (const pv of pvs) for (const load of loads) {
    for (const [mc, md] of limits) for (const [forced, noGridCharge] of flags) {
      vectors.push(vec(fn, `raster_${i++}`, { args: [{ setpointW: s, gridImportW: g, batteryW: b, pvW: pv, loadW: load, maxChargeW: mc, maxDischargeW: md, forced, noGridCharge, socPct: 50, floorSocPct: 11 }] }));
    }
  }
  // Fokussiertes Raster fuer die einstellbaren Reglerwerte und den belowFloor-Ladepfad.
  const gains = [0.1, 0.7, 1.5];
  const minPowers = [0, 50, 200];
  const bands = [0, 300];
  const socFloor = pairs([[8, 11], [50, 11]]); // [socPct, floorSocPct] — unter und ueber dem Boden
  let j = 0;
  for (const gain of gains) for (const minPowerW of minPowers) for (const bandW of bands) for (const [socPct, floorSocPct] of socFloor) {
    for (const forced of [false, true]) {
      vectors.push(vec(fn, `knobs_${j++}`, { args: [{ setpointW: 2000, gridImportW: 0, batteryW: 0, pvW: 3000, loadW: 500, maxChargeW: 5000, maxDischargeW: 5000, forced, gain, minPowerW, bandW, socPct, floorSocPct }] }));
    }
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// 9) isSungrowEmergencyCharge(runningState) — Notladung 0x4001
// ===========================================================================================================
function genIsSungrowEmergencyCharge() {
  const fn = 'isSungrowEmergencyCharge';
  const vectors = [];
  vectors.push(vec(fn, 'notladung_0x4001', { args: [0x4001] }));       // → true
  vectors.push(vec(fn, 'externes_ems_0x4000', { args: [0x4000] }));     // → false
  vectors.push(vec(fn, 'betrieb_netz_0x0000', { args: [0x0000] }));     // → false
  vectors.push(vec(fn, 'stopp_0x8000', { args: [0x8000] }));            // → false
  vectors.push(vec(fn, 'null_eingang', { args: [null] }));              // → false
  for (const rs of [0x0040, 0x0400, 0x0800, 0x1000, 0x4001, 0x5500, 0x9100, 65535]) {
    vectors.push(vec(fn, `raster_0x${rs.toString(16)}`, { args: [rs] }));
  }
  return { function: fn, vectors };
}

// ===========================================================================================================
// ctx-basiert (now festgenagelt): planningCfg / planningSocPct / planningMinSocPct / gridShareCapacityInput
// ===========================================================================================================

// Baukasten fuer ctx/cfg. Der Master-WR steckt (historisch) in state.victron.
function sungrowSingle({ soc = 50, minDev = 10, maxDev = 100, capWh = 10000, chargeW = 5000, dischargeW = 5000, bdc = 5000 } = {}) {
  return {
    state: {
      victron: {
        soc, sungrowMasterSocPct: soc,
        device: { bdcRatedW: bdc, maxChargeWDevice: chargeW, maxDischargeWDevice: dischargeW, minSocPctDevice: minDev, maxSocPctDevice: maxDev, batteryCapacityLimitWh: capWh },
      },
    },
    cfg: { manufacturer: 'sungrow', optimizer: { batteryCapacityWh: capWh, hardFloorSocPct: 5 }, sungrow: {} },
  };
}
function sungrowAggregated({ mSoc = 50, sSoc = 30, mMin = 10, sMin = 10, capWh = 10000, sCapWh = 8000, updatedAt = FIXED_NOW - 2000 } = {}) {
  const base = sungrowSingle({ soc: mSoc, minDev: mMin, capWh });
  base.state.sungrowSecond = {
    online: true, updatedAt, runningState: 0x4000,
    socPct: sSoc, batteryPowerW: -300, pvPowerW: 1200, bdcRatedW: 5000,
    maxChargeWDevice: 5000, maxDischargeWDevice: 5000, minSocPctDevice: sMin, maxSocPctDevice: 100,
    batteryCapacityLimitWh: sCapWh,
  };
  base.cfg.sungrow.secondInverter = { host: '192.168.68.83', aggregateTelemetry: true, batteryCapacityWh: sCapWh, maxChargeW: 0, maxDischargeW: 0 };
  return base;
}
function victronFollower({ primarySoc = 55, mgSoc = 40, online = true, capWh = 8000, mgCapWh = 6000, minSoc = 10 } = {}) {
  return {
    state: {
      victron: { soc: primarySoc },
      multiGx: { online, socPct: mgSoc, minSocPct: minSoc, batteryPowerW: -200, updatedAt: FIXED_NOW - 3000 },
    },
    cfg: {
      updateChannel: 'dev',
      optimizer: { batteryCapacityWh: capWh, maxChargeW: 5000, maxDischargeW: 5000, hardFloorSocPct: 5 },
      system: { power: { batteryCapacityWh: capWh, batteryMaxChargeW: 5000, batteryMaxDischargeDcW: 5000 } },
      multiGx: { enabled: true, host: '192.168.68.90', batteryCapacityWh: mgCapWh, maxChargeW: 4000, maxDischargeW: 4000, minSocPct: minSoc, port: 502, unitId: 100 },
    },
  };
}

function ctxCases() {
  // Gemeinsame Szenarien; je Funktion unten mit dem passenden Eingang verwendet.
  return {
    sungrow_single: sungrowSingle(),
    sungrow_single_leer: sungrowSingle({ soc: 8, minDev: 10 }),
    sungrow_aggregiert: sungrowAggregated(),
    'sungrow_aggregiert_feld_9.2_14.4': sungrowAggregated({ mSoc: 9.2, sSoc: 14.4 }),
    sungrow_aggregiert_ohne_zweitkapazitaet: (() => { const c = sungrowAggregated(); c.cfg.sungrow.secondInverter.batteryCapacityWh = 0; return c; })(),
    sungrow_slave_offline: (() => { const c = sungrowAggregated(); c.state.sungrowSecond.online = false; return c; })(),
    sungrow_slave_veraltet: sungrowAggregated({ updatedAt: FIXED_NOW - 999999 }),
    victron_follower: victronFollower(),
    victron_follower_offline: victronFollower({ online: false }),
    kein_sungrow_kein_follower: { state: { victron: { soc: 60 } }, cfg: { optimizer: { batteryCapacityWh: 8000, hardFloorSocPct: 5 }, system: { power: {} } } },
    // Ausdrücklich gesetzter Puffer (sungrow.socFloorBufferPct = 1): seit M24 (2c6c70d0) ist der Standard 0, der
    // eingetragene Wert bleibt aber wirksam → Boden Gerätemin 10 + Puffer 1 = 11 % (N1-Feldwert) bleibt erfasst.
    sungrow_single_puffer1: (() => { const c = sungrowSingle(); c.cfg.sungrow.socFloorBufferPct = 1; return c; })(),
    sungrow_aggregiert_puffer1: (() => { const c = sungrowAggregated(); c.cfg.sungrow.socFloorBufferPct = 1; return c; })(),
  };
}

function genPlanningCfg() {
  const fn = 'planningCfg';
  const vectors = [];
  for (const [name, c] of Object.entries(ctxCases())) {
    vectors.push(vec(fn, name, { state: c.state, cfg: c.cfg, now: FIXED_NOW }));
  }
  return { function: fn, now: FIXED_NOW, vectors };
}
function genPlanningSocPct() {
  const fn = 'planningSocPct';
  const vectors = [];
  for (const [name, c] of Object.entries(ctxCases())) {
    vectors.push(vec(fn, name, { state: c.state, cfg: c.cfg, now: FIXED_NOW }));
  }
  return { function: fn, now: FIXED_NOW, vectors };
}
function genPlanningMinSocPct() {
  const fn = 'planningMinSocPct';
  const vectors = [];
  for (const [name, c] of Object.entries(ctxCases())) {
    for (const primaryMin of [5, 10, 15]) {
      vectors.push(vec(fn, `${name}_primaryMin${primaryMin}`, { state: c.state, cfg: c.cfg, now: FIXED_NOW, primaryMinSocPct: primaryMin }));
    }
  }
  return { function: fn, now: FIXED_NOW, vectors };
}
function genGridShareCapacityInput() {
  const fn = 'gridShareCapacityInput';
  const vectors = [];
  for (const [name, c] of Object.entries(ctxCases())) {
    vectors.push(vec(fn, name, { state: c.state, cfg: c.cfg, now: FIXED_NOW }));
  }
  // Kapazitaet fehlt → capacityMissing.
  vectors.push(vec(fn, 'kapazitaet_fehlt', { state: { victron: { soc: 50 } }, cfg: { manufacturer: 'sungrow', optimizer: {}, sungrow: {} }, now: FIXED_NOW }));
  return { function: fn, now: FIXED_NOW, vectors };
}

// ===========================================================================================================
// Schreiben
// ===========================================================================================================
const GENERATORS = {
  splitStrategyShares: genSplitStrategyShares,
  splitSungrowPower: genSplitSungrowPower,
  socBalanceWeights: genSocBalanceWeights,
  sungrowRealSocPct: genSungrowRealSocPct,
  sungrowDischargeFloorPct: genSungrowDischargeFloorPct,
  sungrowChargeCeilPct: genSungrowChargeCeilPct,
  sungrowEffectivePowerW: genSungrowEffectivePowerW,
  decideEmsCommand: genDecideEmsCommand,
  isSungrowEmergencyCharge: genIsSungrowEmergencyCharge,
  planningCfg: genPlanningCfg,
  planningSocPct: genPlanningSocPct,
  planningMinSocPct: genPlanningMinSocPct,
  gridShareCapacityInput: genGridShareCapacityInput,
};

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = [];
  let total = 0;
  for (const fn of [...PURE_FUNCTIONS, ...CTX_FUNCTIONS]) {
    const gen = GENERATORS[fn];
    if (!gen) throw new Error(`Kein Generator fuer ${fn}`);
    const built = gen();
    const file = {
      function: built.function,
      schema: SCHEMA,
      generator: 'test/golden/generate-split-vectors.mjs',
      count: built.vectors.length,
      ...(built.now != null ? { now: built.now } : {}),
      vectors: built.vectors,
    };
    const out = path.join(OUT_DIR, `${fn}.json`);
    fs.writeFileSync(out, JSON.stringify(file, null, 2) + '\n');
    summary.push(`${fn}: ${built.vectors.length}`);
    total += built.vectors.length;
  }
  console.log(`Golden-Vektoren geschrieben nach ${path.relative(process.cwd(), OUT_DIR)}\n` + summary.join('\n') + `\nSUMME: ${total}`);
}

// NUR schreiben, wenn direkt als Skript ausgefuehrt — NICHT, wenn der Node-Test-Runner diese Datei einsammelt
// (Node 22 glob `test/**` bei `node --test` / `npm run test:all`). Sonst wuerde ein Testlauf die Golden-Dateien
// ueberschreiben und das Tor „rot, wenn eine Funktion sich aendert“ aushebeln (Codex P2). Unter `node --test`
// setzt Node `process.env.NODE_TEST_CONTEXT`; bei direktem Aufruf ist sie leer.
if (!process.env.NODE_TEST_CONTEXT) main();
