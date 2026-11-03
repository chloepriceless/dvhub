// services/optimizer/grid-share.js — Netzstrom-Zähler im Akku (Christin 01./02.11.2026).
//
// Netzladen (dynamischer Tarif, §14a Modul 3) an einer PV-Anlage in der
// Direktvermarktung: Es darf rechnerisch NIE Netzstrom mit Marktprämie verkauft
// werden. Dazu führt DVhub einen virtuellen Zähler, wie viel Netzstrom im Akku
// steckt, und sperrt die Akku-Einspeisung, solange es mehr als eine kleine
// Schwelle ist.
//
// Zählregel (Energieflüsse aus polling.js, Gleichstromseite des Akkus):
//   Netz→Akku          erhöht den Netzstrom-Anteil G um die geladene Energie —
//                      höchstens um den gemessenen Netzbezug (bei Fronius ist
//                      die PV-Leistung die AC-Leistung NACH dem Laden). Es zählt
//                      JEDE tatsächliche Netzladung, egal wer sie auslöst (EOS,
//                      Handeingabe, Zeitplan, fremde Steuerung) und ob Netzlade-
//                      oder MiSpeL-Freigabe gesetzt ist (Christin 03.11.2026:
//                      „dass wir rechnerisch nie Netzstrom verkaufen und
//                      Marktprämie dafür kassieren, will ich ausschließen“;
//                      Gegenprüfung Release 1.0.9, P2 — vorher zählte nur
//                      Netzladen mit Freigabe, 6 kW per Handeingabe blieben
//                      ungezählt). Regelrauschen filtert ein gleitendes
//                      30-s-Fenster (filterGridInflow): Netzladung liegt an,
//                      wenn dort im Mittel mindestens 150 W und mindestens 10 s
//                      lang Werte ab 150 W anlagen — dann zählt sie ab ihrem
//                      ersten Wert ab 150 W (Anlauf und kurze Einbrüche). So
//                      sperren Pendeln um den Sollwert (einige 10 W,
//                      Gegenprüfungen 8465a540 und f4bcc3ba) und kurze
//                      Regelvorgänge (Wolke, Laststoß) keine Anlage, eine
//                      stockende Ladung zählt trotzdem (Gegenprüfung 52a6c756).
//                      Verworfenes steht in der Tageszeile.
//   Akku→Haus/Netz     senkt G anteilig: Anteil (G / Akku-Inhalt) × Entladung.
//   Verluste           anteilig: die Wandlungsverluste stecken in den Flüssen
//                      (gemessen am Akku), alles Weitere zeigt der Ladestand —
//                      G kann nie größer sein als der Akku-Inhalt. Weil der
//                      Victron-Ladestand ganzzahlig ist, gilt als Obergrenze
//                      (Ladestand + 1 %) × Kapazität — gekappt wird erst, wenn
//                      der Ladestand 60 s lang darunter liegt (ein Fehlwert
//                      darf keinen Netzstrom „verschwinden“ lassen).
//   Unsichere Akkuwerte (gridShareBatteryUncertain: Lesefehler, alter Stempel,
//                      Einfrier-Wächter bzw. -Verdacht, Kreuzprobe; zweite
//                      Anlage veraltet) buchen NIE ab: Entladung gilt als 0.
//                      polling.js behält bei Fehlern den letzten Wert — sonst
//                      fiele die Sperre, ohne dass jemand weiß, ob der Akku
//                      entladen hat (Gegenprüfung Release 1.0.9, P2). Ist der
//                      Ladestand selbst unsicher, wird er nicht benutzt (keine
//                      Kappung). Zubuchen zählt weiter (vorsichtige Richtung:
//                      läuft Netzladen während eines Ausfalls weiter, fehlte es
//                      sonst), wird aber in der Tageszeile eigens ausgewiesen
//                      und ist immer durch die Akkukapazität begrenzt
//                      (Gegenprüfung 4cf16a5a, P2). Log einmal je Episode, die
//                      Tageszeile nennt die Minuten ohne Abbuchung.
// Akku-Inhalt = Ladestand × Kapazität (beide GX-Anlagen zusammen, wie EOS plant).
// Die Kapazität kommt nur aus der Einstellung (grid-share-poll.js); fehlt sie,
// ist der Inhalt unbekannt: keine Kappung, keine Abbuchung (capacityMissing).
//
// Sperre: gilt an einer PV-Anlage ohne MiSpeL-Option. An bei mehr als 100 Wh,
// frei erst wieder bei höchstens 50 Wh (Hysterese: sonst schaltet EOS bei
// jedem Pendeln um die Schwelle um und plant neu). Im reinen Netzspeicher gibt es keine geförderte
// Erzeugung, mit Pauschal- oder Abgrenzungsoption regelt die Option die
// Vermischung. Gesperrt heißt:
//   - Ausführung (schedule-eval): jeder diskretionäre negative Netz-Sollwert
//     wird auf den Live-PV-Überschuss gedeckelt (DC-PV mit Wandlungsverlust);
//     PV-Einspeisung bleibt, der Standard-Puffer (schedule.defaultGridSetpointW)
//     auch, aber höchstens 100 W.
//   - Planung: EOS bekommt die Akku-Netzeinspeisung abgeschaltet
//     (feedintariff/direct_marketing_enabled = false, eos-config-sync), der
//     eingebaute Planer allowGridDischarge = false.
//
// Persistenz: <DATA_DIR>/battery_grid_share.json (atomar, je Minute und bei
// jedem Sperrwechsel). Protokoll als Nachweis für die Direktvermarktung:
// <DATA_DIR>/battery_grid_share_log.jsonl — Sperrwechsel und eine Tageszeile je
// Kalendertag (Ortszeit), als CSV über /api/battery/grid-share/protocol.csv.

import fs from 'node:fs';
import path from 'node:path';

import { isGridStorageOnly, isGridChargeLicensed } from './grid-storage.js';
// isGridChargeLicensed nur noch für die Anzeige (summary.gridChargeEnabled) —
// gezählt wird jede Netzladung.

/** Ab mehr als 100 Wh Netzstrom im Akku ist die Akku-Einspeisung gesperrt … */
export const GRID_SHARE_LOCK_THRESHOLD_WH = 100;
/** … und erst bei höchstens 50 Wh wieder frei. */
export const GRID_SHARE_RELEASE_WH = 50;
/** Standard-Puffer während der Sperre höchstens 100 W (Christin: −100 W vernachlässigbar). */
export const GRID_SHARE_BUFFER_MAX_W = 100;
/** DC-PV kommt nur nach dem Wechselrichter ins Netz (vorsichtig 92 %, wie dcExportMode). */
export const GRID_SHARE_DC_PV_AC_FACTOR = 0.92;
/** So lange muss der Ladestand unter dem Zählerstand liegen, bevor gekappt wird. */
export const GRID_SHARE_CAP_CONFIRM_MS = 60_000;
/** Sicherheitsabstand zum Live-PV-Überschuss, damit die Regelung nicht aus dem Akku nachschiebt. */
export const GRID_SHARE_EXPORT_MARGIN_W = 100;
/** Längste Lücke zwischen zwei Messungen, die noch gezählt wird. */
export const GRID_SHARE_MAX_STEP_MS = 60_000;
/**
 * Höchstes Alter von Akkuleistung und Ladestand, mit dem noch abgebucht wird:
 * DVhubs Frische-Frist victron.telemetryMaxAgeMs (Standard 90 s, wie der
 * Entlade-Boden in schedule-eval), aber nie länger als 90 s — ein Zähler
 * integriert jeden alten Wert zu Energie.
 */
export const GRID_SHARE_FIELD_MAX_AGE_MS = 90_000;
/**
 * Netzladung gegen Regelrauschen: Netz→Akku zählt erst ab dieser Leistung …
 * Pendeln um den Sollwert liegt bei einigen 10 W (Victron-Standard-Sollwert
 * +50 W, Messrauschen ~40 W); echte Netzladung — EOS, Handeingabe, Victrons
 * eigenes Nachladen an der SoC-Grenze (5 A ≈ 250 W) — liegt darüber.
 */
export const GRID_SHARE_MIN_CHARGE_W = 150;
/**
 * … beurteilt über ein gleitendes Fenster dieser Länge: im Mittel mindestens
 * GRID_SHARE_MIN_CHARGE_W und mindestens ein Drittel der Fensterzeit ab dieser
 * Leistung. Kurze Regelvorgänge (Wolke: der Akku lädt einige Sekunden weiter
 * aus dem Netz, bis die Regelung nachzieht) bleiben darunter.
 */
export const GRID_SHARE_MIN_CHARGE_MS = 30_000;
/** Erst so lange sichere Werte beenden eine Unsicherheits-Episode im Log (kein Flattern). */
export const GRID_SHARE_UNCERTAIN_CLEAR_MS = 60_000;
/** Felder, aus denen polling.js Akkuflüsse und Akku-Inhalt rechnet. */
const BATTERY_FIELDS = [['batteryPowerW', 'battery_power'], ['soc', 'soc']];
/** Gründe, bei denen auch der Ladestand nicht benutzt wird (sonst nur die Akkuleistung unsicher). */
const SOC_UNCERTAIN_REASONS = new Set(['telemetry_frozen', 'source_mismatch', 'soc_error', 'soc_stale', 'second_battery_stale']);
export const GRID_SHARE_STATE_FILE = 'battery_grid_share.json';
export const GRID_SHARE_PROTOCOL_FILE = 'battery_grid_share_log.jsonl';

const PERSIST_INTERVAL_MS = 60_000;
const READ_ONLY_REFRESH_MS = 5_000;
const PROTOCOL_MAX_LINES = 5_000;

/** Gilt die Sperre für diese Anlage? PV-Anlage ohne MiSpeL-Option. */
export function gridShareLockApplies(cfg) {
  if (isGridStorageOnly(cfg)) return false;
  const mode = cfg?.optimizer?.mispel?.mode;
  return mode !== 'pauschal' && mode !== 'abgrenzung';
}

const pos = (v) => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : 0;
};
const finiteOrNull = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Sind Akkuleistung oder Ladestand unsicher? Gibt die Gründe zurück (leer = sicher).
 *   - Einfrier-Wächter (freeze.active) oder Kreuzprobe (sourceMismatch.active):
 *     dieselben Wachen wie der Entlade-Boden in schedule-eval und multi-gx;
 *     dazu der Einfrier-Verdacht (freezeSuspect.active) — im Stable-Kanal ist
 *     der Wächter aus, die Erkennung läuft trotzdem (Gegenprüfung 4cf16a5a);
 *   - Lesefehler (errors.batteryPowerW / errors.soc): polling.js behält dann den alten Wert;
 *   - fieldUpdatedAt (letzte erfolgreiche Abfrage) älter als maxAgeMs
 *     (victron.telemetryMaxAgeMs, höchstens 90 s);
 *   - nur MQTT: fieldSourceAt (Empfangszeit des Werts; die Abfrage stempelt
 *     „jetzt“, auch wenn der Wert aus dem Cache kommt) älter als 90 s — eigene
 *     Frist, weil Venus ruhende Werte nur per Keepalive (30 s) neu schickt.
 * Ein fehlender Stempel heißt „nie gelesen“: dann ist der Wert null und es gibt
 * ohnehin keinen Fluss bzw. keinen Ladestand (polling.js setzt Wert und Stempel
 * zusammen) — kein Grund.
 */
export function gridShareBatteryUncertain(victron, { nowMs = Date.now(), maxAgeMs } = {}) {
  const v = victron || {};
  const reasons = [];
  if (v.freeze?.active === true || v.freezeSuspect?.active === true) reasons.push('telemetry_frozen');
  if (v.sourceMismatch?.active === true) reasons.push('source_mismatch');
  const cfgMax = Number(maxAgeMs);
  const max = Number.isFinite(cfgMax) && cfgMax > 0 ? Math.min(cfgMax, GRID_SHARE_FIELD_MAX_AGE_MS) : GRID_SHARE_FIELD_MAX_AGE_MS;
  for (const [field, tag] of BATTERY_FIELDS) {
    if (v.errors?.[field]) reasons.push(`${tag}_error`);
    const old = (at, limit) => Number(at) > 0 && nowMs - Number(at) > limit;
    if (old(v.fieldUpdatedAt?.[field], max) || old(v.fieldSourceAt?.[field], GRID_SHARE_FIELD_MAX_AGE_MS)) reasons.push(`${tag}_stale`);
  }
  return reasons;
}

/**
 * Ein Zählschritt (rein, ohne Zustand).
 * @param {number} gridWh Netzstrom im Akku vor dem Schritt
 * @param {{dtMs:number, gridToBatteryW?:number, batteryToHomeW?:number, batteryToGridW?:number,
 *          socPct?:number|null, capacityWh?:number|null, extraInWh?:number}} p
 * @returns {{gridWh:number, inWh:number, toHomeWh:number, toGridWh:number, lossWh:number, share:number, storedWh:number|null}}
 */
export function stepGridShare(gridWh, { dtMs, gridToBatteryW, batteryToHomeW, batteryToGridW, socPct, capacityWh, capAllowed = true, extraInWh = 0 } = {}) {
  const h = Math.max(0, Number(dtMs) || 0) / 3_600_000;
  const soc = finiteOrNull(socPct);
  const cap = finiteOrNull(capacityWh);
  const known = soc != null && cap != null && cap > 0;
  const storedWh = known ? Math.max(0, Math.min(100, soc)) / 100 * cap : null;
  const upperWh = known ? Math.min(100, Math.max(0, soc) + 1) / 100 * cap : null;
  let g = Math.max(0, Number(gridWh) || 0);
  // Anteil zu Beginn des Schritts. Ohne Ladestand nimmt Entladen nichts weg —
  // der Zähler bleibt dann eher zu hoch als zu niedrig (Sperre im Zweifel an).
  const shareBefore = !known ? 0 : (g <= 0 ? 0 : (storedWh > 0 ? Math.min(1, g / storedWh) : 1));
  // extraInWh: Netzladung aus früheren Schritten, die erst jetzt als echte
  // Ladung bestätigt ist (filterGridInflow).
  const inWh = pos(gridToBatteryW) * h + pos(extraInWh);
  const toHomeWh = Math.min(g, shareBefore * pos(batteryToHomeW) * h);
  const toGridWh = Math.min(g - toHomeWh, shareBefore * pos(batteryToGridW) * h);
  g = g - toHomeWh - toGridWh + inWh;
  let lossWh = 0;
  const overUpper = upperWh != null && g > upperWh;
  if (overUpper && capAllowed) {
    lossWh = g - upperWh;
    g = upperWh;
  }
  // Nie mehr Netzstrom als der ganze Akku fasst — auch ohne Ladestand
  // (Zubuchen aus unsicheren Werten, Gegenprüfung 4cf16a5a, P2).
  if (cap != null && cap > 0 && g > cap) {
    lossWh += g - cap;
    g = cap;
  }
  const share = !known ? null : (g <= 0 ? 0 : (storedWh > 0 ? Math.min(1, g / storedWh) : 1));
  return { gridWh: g, inWh, toHomeWh, toGridWh, lossWh, share, storedWh, overUpper };
}

/**
 * Höchste erlaubte Einspeisung (W, ≥ 0) während der Sperre: Live-PV-Überschuss
 * (AC-PV + DC-PV × 0,92 − Hauslast) minus Sicherheitsabstand, mindestens der
 * Standard-Puffer (höchstens 100 W). Unbekannte PV oder Last → nur der Puffer.
 */
export function gridShareExportCapW({ pvAcW, pvDcW, loadW, bufferW = 0, marginW = GRID_SHARE_EXPORT_MARGIN_W } = {}) {
  const buffer = Math.min(GRID_SHARE_BUFFER_MAX_W, Math.max(0, Math.abs(Number(bufferW) || 0)));
  const ac = finiteOrNull(pvAcW);
  const dc = finiteOrNull(pvDcW);
  const load = finiteOrNull(loadW);
  if (ac == null || dc == null || load == null) return Math.round(buffer);
  const pv = Math.max(0, ac) + Math.max(0, dc) * GRID_SHARE_DC_PV_AC_FACTOR;
  const surplus = pv - Math.max(0, load) - Math.max(0, Number(marginW) || 0);
  return Math.round(Math.max(buffer, surplus, 0));
}

/**
 * Regelrauschen von echter Netzladung trennen — über ein gleitendes Fenster
 * (GRID_SHARE_MIN_CHARGE_MS = 30 s) statt „am Stück“ (Gegenprüfung 52a6c756:
 * eine stockende Ladung — 25 s 500 W, 1 s 0 W — wurde nie bestätigt, und eine
 * bestätigte endete bei Rauschen mit einzelnen Spitzen nie).
 * Netzladung liegt an, solange im Fenster
 *   - der Mittelwert mindestens minW beträgt und
 *   - mindestens ein Drittel der Zeit (minAboveMs, 10 s) ein Wert ab minW
 *     anlag. Regelvorgänge nach einer Wolke dauern nur Sekunden; die halbe
 *     Fensterzeit verwarf eine stockende Ladung mit 12 s an / 18 s aus
 *     (Gegenprüfung 018dc85f, P3).
 * Liegt sie an, wird alles noch nicht Gebuchte im Fenster ab dem ersten Wert
 * ab minW gebucht (die ersten Sekunden einer Ladung und kurze Einbrüche),
 * danach jeder neue Wert.
 * Liegt sie nicht an, werden neue Werte nur vorgemerkt; was ungebucht aus dem
 * Fenster fällt, ist verworfen (Rauschen, kurze Regelvorgänge).
 * @param {{samples: Array<{endMs:number, dtMs:number, w:number, booked:boolean}>}|null} filter
 * @param {{nowMs:number, dtMs:number, inflowW:number, minW?:number, windowMs?:number, minAboveMs?:number}} p
 * @returns {{filter: object, inWh:number, droppedWh:number, active:boolean}}
 */
export function filterGridInflow(filter, { nowMs, dtMs, inflowW, minW = GRID_SHARE_MIN_CHARGE_W, windowMs = GRID_SHARE_MIN_CHARGE_MS, minAboveMs = GRID_SHARE_MIN_CHARGE_MS / 3 }) {
  const samples = filter?.samples ? filter.samples.slice() : [];
  const dt = Math.max(0, Number(dtMs) || 0);
  const whOf = (s) => s.w * s.dtMs / 3_600_000;
  if (dt > 0) samples.push({ endMs: nowMs, dtMs: dt, w: pos(inflowW), booked: false });
  const fromMs = nowMs - windowMs;
  let droppedWh = 0;
  while (samples.length && samples[0].endMs <= fromMs) {
    const s = samples.shift();
    if (!s.booked) droppedWh += whOf(s);
  }
  let energyWs = 0;
  let aboveMs = 0;
  for (const s of samples) {
    const overlapMs = Math.min(s.dtMs, s.endMs - fromMs);
    energyWs += s.w * overlapMs / 1000;
    if (s.w >= minW) aboveMs += overlapMs;
  }
  const active = energyWs * 1000 / windowMs >= minW && aboveMs >= minAboveMs;
  let inWh = 0;
  if (active) {
    // Beim Anlaufen erst ab dem ersten Wert ab minW buchen — Rauschen davor ist
    // keine Ladung. Ein schon gebuchter Wert heißt: die Ladung läuft weiter.
    let started = false;
    for (const s of samples) {
      if (s.booked) { started = true; continue; }
      s.booked = true;
      if (!started && s.w < minW) { droppedWh += whOf(s); continue; }
      started = true;
      inWh += whOf(s);
    }
  }
  return { filter: { samples }, inWh, droppedWh, active };
}

function localDate(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
const emptyDay = (date) => ({ date, inWh: 0, toHomeWh: 0, toGridWh: 0, lossWh: 0, lockedMs: 0, maxGridWh: 0, uncertainMs: 0, uncertainInWh: 0, filteredInWh: 0 });

/**
 * @param {object} opts
 * @param {() => object} opts.getCfg
 * @param {(event:string, data?:object, level?:string) => void} [opts.pushLog]
 * @param {string} opts.dataDir Verzeichnis für Zustand und Protokoll
 * @param {(locked:boolean, summary:object) => void} [opts.onLockChange]
 * @param {boolean} [opts.readOnly] nur lesen (Web-Prozess neben dem Runtime-Worker)
 * @param {number} [opts.thresholdWh]
 */
export function createGridShareTracker({ getCfg, pushLog, dataDir, onLockChange, readOnly = false, thresholdWh = GRID_SHARE_LOCK_THRESHOLD_WH } = {}) {
  const statePath = dataDir ? path.join(dataDir, GRID_SHARE_STATE_FILE) : null;
  const protocolPath = dataDir ? path.join(dataDir, GRID_SHARE_PROTOCOL_FILE) : null;
  const log = (event, data, level) => { try { pushLog?.(event, data, level); } catch { /* nie werfen */ } };
  const cfgNow = () => { try { return getCfg?.() || {}; } catch { return {}; } };

  let st = null;
  let lastTickMs = null;
  let lastPersistMs = 0;
  let dirty = false;
  let lastReadMs = 0;
  let live = { toHomeW: 0, toGridW: 0 };
  let overSinceMs = null;
  // Unsicherheits-Episode fürs Log: { sinceMs, reasons:Set }, endet erst nach
  // GRID_SHARE_UNCERTAIN_CLEAR_MS sicherer Werte.
  let uncertainEpisode = null;
  let certainSinceMs = null;
  // Fenster der Netzladung (filterGridInflow) — nur im Speicher: ein Neustart
  // mitten in den ersten Sekunden einer Ladung verliert höchstens diese.
  let inflowFilter = null;
  // Akkukapazität fehlt (grid-share-poll.js): einmal je Prozess und Episode melden.
  let capacityMissingLogged = false;

  function fresh() {
    return {
      version: 1,
      gridWh: 0,
      locked: false,
      since: new Date().toISOString(),
      updatedAt: null,
      storedWh: null,
      share: null,
      day: emptyDay(null),
      totals: { inWh: 0, toHomeWh: 0, toGridWh: 0, lossWh: 0 },
      lockChangedAt: null,
    };
  }

  function load() {
    if (!statePath) return fresh();
    let text;
    try { text = fs.readFileSync(statePath, 'utf8'); } catch { return fresh(); }   // erster Start
    try {
      const raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || !Number.isFinite(Number(raw.gridWh))) throw new Error('kein Zählerstand');
      const base = fresh();
      return {
        ...base,
        ...raw,
        gridWh: Math.max(0, Number(raw.gridWh)),
        day: { ...base.day, ...(raw.day || {}) },
        totals: { ...base.totals, ...(raw.totals || {}) },
      };
    } catch (e) {
      // Datei da, aber unlesbar: laut melden — der Zähler fängt bei 0 an.
      log('grid_share_state_unreadable', { error: e?.message || String(e) }, 'error');
      return fresh();
    }
  }

  function persist(nowMs = Date.now()) {
    if (readOnly || !statePath) return true;
    try {
      const tmp = statePath + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(st) + '\n');
        fs.fsyncSync(fd);   // Stromausfall auf SD-Karte: lieber alt als leer
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, statePath);
      lastPersistMs = nowMs;
      dirty = false;
      return true;
    } catch (e) {
      log('grid_share_persist_error', { error: e?.message || String(e) }, 'warn');
      return false;
    }
  }

  function appendProtocol(entry) {
    if (readOnly || !protocolPath) return;
    try {
      fs.appendFileSync(protocolPath, JSON.stringify(entry) + '\n');
    } catch (e) {
      log('grid_share_protocol_error', { error: e?.message || String(e) }, 'warn');
    }
  }

  // limit: die jüngsten Einträge für die Anzeige (höchstens PROTOCOL_MAX_LINES);
  // Infinity nur für den Nachweis (CSV) — der braucht jede Zeile.
  function readProtocol(limit = 500) {
    if (!protocolPath) return [];
    let text;
    try { text = fs.readFileSync(protocolPath, 'utf8'); } catch { return []; }
    const lines = text.split('\n').filter(Boolean);
    const out = [];
    const n = limit === Infinity ? lines.length : Math.min(PROTOCOL_MAX_LINES, Math.max(1, Number(limit) || 1));
    for (const l of lines.slice(-n)) {
      try { out.push(JSON.parse(l)); } catch { /* kaputte Zeile überspringen */ }
    }
    return out;
  }

  function ensureLoaded(nowMs = Date.now()) {
    if (!st) { st = load(); lastReadMs = nowMs; return; }
    if (readOnly && nowMs - lastReadMs > READ_ONLY_REFRESH_MS) { st = load(); lastReadMs = nowMs; }
  }

  function lockFor(cfg) {
    if (!gridShareLockApplies(cfg)) return false;
    return st.locked ? st.gridWh > Math.min(GRID_SHARE_RELEASE_WH, thresholdWh) : st.gridWh > thresholdWh;
  }

  function closeDay(nowMs, cfg) {
    const d = st.day;
    if (d?.date) {
      appendProtocol({
        ts: new Date(nowMs).toISOString(),
        event: 'day',
        date: d.date,
        gridToBatteryKwh: r3(d.inWh / 1000),
        batteryToHomeFromGridKwh: r3(d.toHomeWh / 1000),
        batteryToGridFromGridKwh: r3(d.toGridWh / 1000),
        lossFromGridKwh: r3(d.lossWh / 1000),
        maxGridKwh: r3(d.maxGridWh / 1000),
        endGridKwh: r3(st.gridWh / 1000),
        endSharePct: st.share == null ? null : Math.round(st.share * 1000) / 10,
        lockedMinutes: Math.round(d.lockedMs / 60_000),
        uncertainMinutes: Math.round((d.uncertainMs || 0) / 60_000),
        uncertainGridToBatteryKwh: r3((d.uncertainInWh || 0) / 1000),
        filteredGridToBatteryKwh: r3((d.filteredInWh || 0) / 1000),
        lockApplies: gridShareLockApplies(cfg),
      });
    }
  }

  /**
   * Ein Messwert (jede Abfrage). Gibt die Live-Werte für Telemetrie und Status zurück.
   * secondBatteryStale: die zweite GX-Anlage steckt im Ladestand (planningSocPct),
   * ihre Werte sind aber nicht aktuell (server.js, multi-gx/planning.js).
   * capacityMissing: keine Akkukapazität eingestellt (grid-share-poll.js) —
   * capacityWh ist dann null: keine Kappung am Ladestand, keine Abbuchung
   * (Sperre im Zweifel an); Log und Leitstand melden es (Gesamtprüfung
   * Release 1.0.9, Befund 3).
   * @param {{nowMs?:number, victron?:object, socPct?:number|null, capacityWh?:number|null, capacityMissing?:boolean, secondBatteryStale?:boolean}} p
   */
  function tick({ nowMs = Date.now(), victron = {}, socPct = null, capacityWh = null, capacityMissing = false, secondBatteryStale = false } = {}) {
    ensureLoaded(nowMs);
    if (readOnly) return summaryLive();
    const cfg = cfgNow();
    trackCapacity(capacityMissing === true);
    const tz = cfg?.schedule?.timezone || 'Europe/Berlin';
    const today = localDate(nowMs, tz);
    if (st.day?.date !== today) {
      if (st.day?.date) closeDay(nowMs, cfg);
      st.day = emptyDay(today);
      dirty = true;
    }
    const dtMs = lastTickMs == null ? 0 : Math.min(GRID_SHARE_MAX_STEP_MS, Math.max(0, nowMs - lastTickMs));
    lastTickMs = nowMs;
    const v = victron || {};
    // Zufluss: jede tatsächliche Netzladung, höchstens der echte Netzbezug —
    // ohne Rücksicht auf Netzlade- oder MiSpeL-Freigabe (Christin 03.11.2026,
    // Gegenprüfung Release 1.0.9, P2; damit ist auch die offene Frage
    // „manuelle positive Sollwerte ohne MiSpeL“ beantwortet: zählen).
    // Regelrauschen filtert filterGridInflow (Mindestleistung und -dauer) —
    // das war der Grund für die frühere Freigabe-Bedingung (Gegenprüfung f4bcc3ba).
    const filtered = filterGridInflow(inflowFilter, {
      nowMs, dtMs,
      inflowW: Math.min(pos(v.gridToBatteryW) + pos(v.secondGridToBatteryW), pos(v.gridImportW)),
    });
    inflowFilter = filtered.filter;
    if (filtered.droppedWh > 0) {
      st.day.filteredInWh = (st.day.filteredInWh || 0) + filtered.droppedWh;
      dirty = true;
    }
    // Unsichere Akkuwerte: nichts abbuchen — Entladung beider Akkus gilt als 0
    // (die Aufteilung auf Akku 2 rechnet polling.js aus denselben Werten). Ist
    // der Ladestand unsicher, wird er nicht benutzt (keine Kappung); bei nur
    // unsicherer Akkuleistung kappt der frische Ladestand das Zubuchen.
    const reasons = gridShareBatteryUncertain(v, { nowMs, maxAgeMs: cfg?.victron?.telemetryMaxAgeMs });
    if (secondBatteryStale) reasons.push('second_battery_stale');
    const uncertain = reasons.length > 0;
    const flows = {
      gridToBatteryW: 0,
      batteryToHomeW: uncertain ? 0 : pos(v.batteryDirectUseW) + pos(v.secondBatteryDirectUseW),
      batteryToGridW: uncertain ? 0 : pos(v.batteryToGridW) + pos(v.secondBatteryToGridW),
    };
    trackUncertainty(nowMs, reasons);
    if (uncertain) {
      st.day.uncertainMs = (st.day.uncertainMs || 0) + dtMs;
      if (dtMs > 0) dirty = true;
    }
    const capAllowed = overSinceMs != null && nowMs - overSinceMs >= GRID_SHARE_CAP_CONFIRM_MS;
    const socUncertain = reasons.some((x) => SOC_UNCERTAIN_REASONS.has(x));
    const r = stepGridShare(st.gridWh, { dtMs, ...flows, extraInWh: filtered.inWh, socPct: socUncertain ? null : socPct, capacityWh, capAllowed });
    if (uncertain) st.day.uncertainInWh = (st.day.uncertainInWh || 0) + r.inWh;
    // Ladestand liegt unter dem Zählerstand: erst merken, nach 60 s kappen.
    // Neu warten nur nach einer echten Ladestand-Kappung — der Kapazitätsdeckel
    // allein darf die Bestätigung nicht ständig zurücksetzen (Gegenprüfung c1bc97e0).
    if (!r.overUpper || (capAllowed && r.lossWh > 0)) overSinceMs = null;
    else if (overSinceMs == null) overSinceMs = nowMs;
    st.gridWh = r.gridWh;
    if (r.storedWh != null) { st.storedWh = r.storedWh; st.share = r.share; }
    else if (st.storedWh > 0) st.share = Math.min(1, st.gridWh / st.storedWh);
    for (const k of ['inWh', 'toHomeWh', 'toGridWh', 'lossWh']) {
      st.day[k] += r[k];
      st.totals[k] += r[k];
    }
    st.day.maxGridWh = Math.max(st.day.maxGridWh || 0, st.gridWh);
    if (st.locked) st.day.lockedMs += dtMs;
    if (r.inWh || r.toHomeWh || r.toGridWh || r.lossWh) dirty = true;
    st.updatedAt = new Date(nowMs).toISOString();

    // Live-Leistung aus Netzstrom (für Telemetrie und Leitstand).
    const shareNow = st.share ?? 0;
    live = { toHomeW: Math.round(shareNow * flows.batteryToHomeW), toGridW: Math.round(shareNow * flows.batteryToGridW) };

    const locked = lockFor(cfg);
    if (locked !== st.locked) {
      st.locked = locked;
      st.lockChangedAt = st.updatedAt;
      const entry = {
        ts: st.updatedAt,
        event: locked ? 'lock_on' : 'lock_off',
        gridKwh: r3(st.gridWh / 1000),
        sharePct: st.share == null ? null : Math.round(st.share * 1000) / 10,
        thresholdKwh: r3(thresholdWh / 1000),
      };
      appendProtocol(entry);
      log('grid_share_lock', { locked, gridKwh: entry.gridKwh, sharePct: entry.sharePct });
      persist(nowMs);
      try { onLockChange?.(locked, summary(nowMs)); } catch (e) { log('grid_share_lock_hook_error', { error: e?.message || String(e) }, 'warn'); }
    } else if (dirty && nowMs - lastPersistMs >= PERSIST_INTERVAL_MS) {
      persist(nowMs);
    }
    return summaryLive();
  }

  /** Fehlende Akkukapazität: Zustand für Leitstand/Status, Log einmal je Episode. */
  function trackCapacity(missing) {
    if (missing) {
      // Ohne Kapazität ist der Akku-Inhalt unbekannt — kein alter Anteil aus
      // einer früheren Kapazität anzeigen.
      if (st.capacityMissing !== true || st.storedWh != null || st.share != null) {
        st.capacityMissing = true;
        st.storedWh = null;
        st.share = null;
        dirty = true;
      }
      if (!capacityMissingLogged) {
        capacityMissingLogged = true;
        log('grid_share_capacity_missing', {
          gridKwh: r3(st.gridWh / 1000),
          note: 'Akkukapazität fehlt (Meine Anlage → Akku-Grenzen bzw. Ausbaustufen): Netzstrom im Akku wird nur zugebucht, '
            + 'nicht am Ladestand gekappt und beim Entladen nicht abgebucht — die Sperre bleibt, bis die Kapazität eingetragen ist',
        }, 'warn');
      }
      return;
    }
    if (st.capacityMissing === true) { st.capacityMissing = false; dirty = true; }
    if (capacityMissingLogged) {
      capacityMissingLogged = false;
      log('grid_share_capacity_known', { gridKwh: r3(st.gridWh / 1000) });
    }
  }

  /** Log einmal je Episode: Beginn sofort, Ende nach GRID_SHARE_UNCERTAIN_CLEAR_MS sicherer Werte. */
  function trackUncertainty(nowMs, reasons) {
    if (reasons.length) {
      certainSinceMs = null;
      if (!uncertainEpisode) {
        uncertainEpisode = { sinceMs: nowMs, reasons: new Set(reasons) };
        log('grid_share_uncertain', { reasons: [...reasons], gridKwh: r3(st.gridWh / 1000), note: 'Akkuwerte unsicher — keine Abbuchung' }, 'warn');
      } else {
        for (const x of reasons) uncertainEpisode.reasons.add(x);
      }
      return;
    }
    if (!uncertainEpisode) return;
    if (certainSinceMs == null) certainSinceMs = nowMs;
    if (nowMs - certainSinceMs >= GRID_SHARE_UNCERTAIN_CLEAR_MS) {
      log('grid_share_uncertain_end', {
        reasons: [...uncertainEpisode.reasons],
        minutes: Math.round((certainSinceMs - uncertainEpisode.sinceMs) / 60_000),
        gridKwh: r3(st.gridWh / 1000),
      });
      uncertainEpisode = null;
      certainSinceMs = null;
    }
  }

  function summaryLive() {
    return {
      gridWh: st.gridWh,
      sharePct: st.share == null ? null : Math.round(st.share * 1000) / 10,
      toHomeW: live.toHomeW,
      toGridW: live.toGridW,
      locked: st.locked,
    };
  }

  function isLocked() {
    ensureLoaded();
    // Die Einstellung kann sich ändern, ohne dass ein Messwert kommt.
    return lockFor(cfgNow());
  }

  function summary(nowMs = Date.now()) {
    ensureLoaded(nowMs);
    const cfg = cfgNow();
    const kwh = (wh) => r3((Number(wh) || 0) / 1000);
    return {
      gridWh: st.gridWh,
      gridKwh: kwh(st.gridWh),
      sharePct: st.share == null ? null : Math.round(st.share * 1000) / 10,
      storedKwh: st.storedWh == null ? null : kwh(st.storedWh),
      locked: lockFor(cfg),
      applies: gridShareLockApplies(cfg),
      gridChargeEnabled: isGridChargeLicensed(cfg),
      thresholdKwh: kwh(thresholdWh),
      releaseKwh: kwh(Math.min(GRID_SHARE_RELEASE_WH, thresholdWh)),
      toHomeW: live.toHomeW,
      toGridW: live.toGridW,
      // Akkukapazität fehlt: keine Abbuchung, keine Kappung (Befund 3).
      capacityMissing: st.capacityMissing === true,
      today: {
        date: st.day?.date ?? null,
        gridToBatteryKwh: kwh(st.day?.inWh),
        batteryToHomeFromGridKwh: kwh(st.day?.toHomeWh), batteryToGridFromGridKwh: kwh(st.day?.toGridWh),
        lossFromGridKwh: kwh(st.day?.lossWh), lockedMinutes: Math.round((st.day?.lockedMs || 0) / 60_000),
        uncertainMinutes: Math.round((st.day?.uncertainMs || 0) / 60_000),
        uncertainGridToBatteryKwh: kwh(st.day?.uncertainInWh),
        filteredGridToBatteryKwh: kwh(st.day?.filteredInWh),
      },
      totals: {
        gridToBatteryKwh: kwh(st.totals.inWh), batteryToHomeFromGridKwh: kwh(st.totals.toHomeWh),
        batteryToGridFromGridKwh: kwh(st.totals.toGridWh), lossFromGridKwh: kwh(st.totals.lossWh),
      },
      since: st.since,
      updatedAt: st.updatedAt,
      lockChangedAt: st.lockChangedAt,
    };
  }

  const CSV_COLUMNS = [
    ['ts', 'Zeit'], ['event', 'Ereignis'], ['date', 'Datum'],
    ['gridToBatteryKwh', 'Netz→Akku kWh'], ['batteryToHomeFromGridKwh', 'Akku→Haus aus Netzstrom kWh'],
    ['batteryToGridFromGridKwh', 'Akku→Netz aus Netzstrom kWh'], ['lossFromGridKwh', 'Verlust Netzstrom kWh'],
    ['maxGridKwh', 'Netzstrom max kWh'], ['endGridKwh', 'Netzstrom Tagesende kWh'], ['endSharePct', 'Anteil Tagesende %'],
    ['lockedMinutes', 'Sperre min'], ['uncertainMinutes', 'Akkuwerte unsicher min (nicht abgebucht)'], ['uncertainGridToBatteryKwh', 'davon Netz→Akku bei unsicheren Werten kWh'], ['filteredGridToBatteryKwh', 'Netz→Akku verworfen (Regelrauschen, kurze Regelvorgänge) kWh'], ['gridKwh', 'Netzstrom kWh'], ['sharePct', 'Anteil %'], ['thresholdKwh', 'Schwelle kWh'],
    ['lockApplies', 'Sperre gilt'], ['reason', 'Grund'], ['actor', 'Ausgelöst von'],
  ];
  function protocolCsv() {
    const cell = (v) => {
      if (v == null) return '';
      if (typeof v === 'number') return String(v).replace('.', ',');
      if (typeof v === 'boolean') return v ? 'ja' : 'nein';
      if (typeof v === 'object') return cell(v.actor || v.ip || v.source || JSON.stringify(v));
      // Freitext (Grund) nie als Formel deuten lassen; \r bricht Zeilen wie \n
      // (Gegenprüfung f4bcc3ba, P3).
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Alle Zeilen: das CSV ist der Nachweis für die Direktvermarktung
    // (Gesamtprüfung Release 1.0.9 — vorher nur die letzten 5000).
    const rows = readProtocol(Infinity).map((e) => CSV_COLUMNS.map(([k]) => cell(e[k])).join(';'));
    return [CSV_COLUMNS.map(([, label]) => label).join(';'), ...rows].join('\n') + '\n';
  }

  /**
   * Zähler auf 0 (nur ausdrücklich, z. B. nach einem Zählerfehler). Schreibt eine
   * Protokollzeile mit dem alten Stand; nur der zählende Prozess darf das.
   */
  function reset({ reason = '', actor = null, nowMs = Date.now() } = {}) {
    ensureLoaded(nowMs);
    if (readOnly) return { ok: false, error: 'read_only_process' };
    const before = st.gridWh;
    const entry = { ts: new Date(nowMs).toISOString(), event: 'reset', gridKwh: r3(before / 1000), reason: String(reason || '').slice(0, 200), actor };
    st.gridWh = 0;
    st.share = st.storedWh ? 0 : st.share;
    // Vorgemerkte Netzladung stammt von vor dem Reset: nie mehr buchen
    // (Gegenprüfung 52a6c756, P3). Das Fenster bleibt — läuft die Ladung
    // weiter, zählt sie ab jetzt ohne neue Anlaufzeit.
    for (const x of inflowFilter?.samples || []) x.booked = true;
    appendProtocol(entry);
    log('grid_share_reset', { gridKwh: entry.gridKwh, reason: entry.reason, actor });
    const wasLocked = st.locked;
    st.locked = lockFor(cfgNow());
    st.updatedAt = entry.ts;
    persist(nowMs);
    if (wasLocked !== st.locked) {
      appendProtocol({ ts: entry.ts, event: st.locked ? 'lock_on' : 'lock_off', gridKwh: 0, sharePct: 0, thresholdKwh: r3(thresholdWh / 1000) });
      try { onLockChange?.(st.locked, summary(nowMs)); } catch { /* best effort */ }
    }
    return { ok: true, previousKwh: entry.gridKwh };
  }

  /** Nur lesend: Stand sofort neu aus der Datei (nach einem Reset im Runtime-Prozess). */
  function reload(nowMs = Date.now()) {
    if (!readOnly) return;
    st = load();
    lastReadMs = nowMs;
  }

  ensureLoaded();
  return {
    tick,
    reset,
    reload,
    isLocked,
    summary,
    persist: () => persist(Date.now()),
    protocol: (limit) => readProtocol(limit === Infinity ? PROTOCOL_MAX_LINES : limit),
    protocolCsv,
  };
}
