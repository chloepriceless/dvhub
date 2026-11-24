// services/dataflow.js — Datenfluss-Übersicht: was kommt in DVhub an, was geht hinaus.
//
// Für Anlagen, deren Messwerte aus Loxone, Home Assistant oder einem anderen
// HTTP-/MQTT-Anschluss kommen (Christin 2026-10-16, Feldfall BIGGE): der
// Betreiber soll selbst sehen können, welche Werte DVhub empfängt, wie DVhub
// sie versteht und welche Sollwerte über welchen Weg hinausgehen. Vorher stand
// das verteilt in /api/input/status, /api/status und dem Loxone-Text — und
// falsch zugeordnete Werte (PV + Akku addiert, Sprünge um 20 kW) fielen erst
// über Umwege auf (Lizenzhinweis, Lastprognose).
//
// buildDataflow() ist rein (kein Netz, keine Uhr außer `now`); die Route sammelt
// die Zutaten ein.

import { PUSH_FIELDS } from './input-push.js';
import { gridDirection } from '../server-utils.js';
import { effectivePvKwp } from './forecast/effective-pv.js';
import { monoStampAge } from './mono-clock.js';

// Ohne diese beiden kann DVhub nicht steuern; alles andere ist optional.
const REQUIRED_INPUTS = new Set(['grid_total', 'battery_soc']);

const INPUT_LABELS = Object.fromEntries(Object.entries(PUSH_FIELDS).map(([field, spec]) => [spec.input, { field, label: spec.label }]));

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// A26: Alter monoton aus der Erzeuger-Marke (Poller, A24), wenn box/key den Stempel tragen; sonst Wanduhr wie bisher.
const ageMs = (at, now, box = null, key = null) => {
  if (num(at) === null) return null;
  const mono = box && key != null && Number(box[key]) === at ? monoStampAge(box, key) : null;
  return Math.max(0, Math.round(mono ?? (now - at))); // ganze ms wie bisher (monotone Zeit ist gebrochen)
};

function describeSource(cfg, transport) {
  if (transport?.type === 'mqtt' && transport?.schema === 'dvhub') {
    const pushOnly = transport.brokerMode === 'push-only';
    return {
      kind: pushOnly ? 'http_push' : 'mqtt',
      label: pushOnly ? 'HTTP-Push (Loxone, Home Assistant, Skript)' : 'MQTT (DVhub-Schema)',
      endpoint: pushOnly ? '/api/input/push' : `${cfg?.victron?.mqtt?.topicPrefix || 'dvhub'}/input/…`,
    };
  }
  if (transport?.type === 'mqtt') return { kind: 'mqtt', label: 'MQTT (Gerät)', endpoint: cfg?.victron?.host || null };
  const host = cfg?.victron?.host || null;
  const port = cfg?.victron?.port || 502;
  return { kind: 'modbus', label: 'Modbus TCP (Gerät)', endpoint: host ? `${host}:${port}` : null };
}

function inputRows({ cfg, state, transport, now }) {
  if (transport?.type === 'mqtt' && transport?.schema === 'dvhub' && typeof transport.inputStatus === 'function') {
    const st = transport.inputStatus() || {};
    return Object.entries(st).map(([input, s]) => ({
      key: input,
      label: INPUT_LABELS[input]?.label || input,
      pushField: INPUT_LABELS[input]?.field || null,
      topic: s?.topic || null,
      value: num(s?.value),
      unit: input === 'battery_soc' ? '%' : 'W',
      ageMs: num(s?.ageMs),
      fresh: s?.fresh === true,
      received: num(s?.value) !== null,
      optional: !REQUIRED_INPUTS.has(input),
      error: null,
    }));
  }
  // Geräteprofil (Modbus/MQTT): die Punkte aus dem Herstellerprofil.
  const v = state?.victron || {};
  const errors = v.errors || {};
  const fieldAt = v.fieldUpdatedAt || {};
  const points = cfg?.points || {};
  // Dieselbe Grenze wie die Steuerung (victronFieldStale in schedule-eval.js);
  // die Einfrier-Wache setzt fieldUpdatedAt zurück, ohne einen Fehler einzutragen.
  const maxAgeMs = Number(cfg?.victron?.telemetryMaxAgeMs ?? 90000);
  const rows = Object.entries(points)
    .filter(([, p]) => p && p.enabled !== false)
    .map(([key]) => {
      const age = fieldAt[key] != null ? ageMs(fieldAt[key], now, fieldAt, key) : ageMs(v.updatedAt, now, v, 'updatedAt');
      return {
        key,
        label: key,
        pushField: null,
        topic: null,
        value: num(v[key]),
        unit: key === 'soc' || key.endsWith('Pct') ? '%' : 'W',
        ageMs: age,
        fresh: !errors[key] && num(v[key]) !== null && !(age !== null && Number.isFinite(maxAgeMs) && age > maxAgeMs),
        received: num(v[key]) !== null,
        error: errors[key] || null,
      };
    });
  const m = state?.meter || {};
  rows.unshift({
    key: 'meter', label: 'Netzzähler', pushField: null, topic: null,
    value: num(m.grid_total_w), unit: 'W', ageMs: ageMs(m.updatedAt, now, m, 'updatedAt'),
    fresh: m.ok === true, received: num(m.grid_total_w) !== null, error: m.error || null,
  });
  return rows;
}

/** Wie DVhub die Werte versteht — die Größen, mit denen Leitstand, Prognose und Steuerung rechnen. */
function seenRows(cfg, state, now, inputs) {
  const v = state?.victron || {};
  const m = state?.meter || {};
  const loadDerived = loadIsDerived(cfg, inputs);
  const grid = num(m.grid_total_w);
  const signRule = cfg?.gridPositiveMeans === 'grid_import' ? '+ = Bezug' : '+ = Einspeisung';
  const rows = [
    { key: 'grid', label: 'Netz', value: grid, unit: 'W',
      note: grid === null ? null : `${gridDirection(grid, cfg?.gridPositiveMeans).label} (Vorzeichen: ${signRule})`,
      ageMs: ageMs(m.updatedAt, now, m, 'updatedAt') },
    { key: 'gridImportW', label: 'Netzbezug', value: num(v.gridImportW), unit: 'W' },
    { key: 'gridExportW', label: 'Einspeisung', value: num(v.gridExportW), unit: 'W' },
    { key: 'pvTotalW', label: 'PV gesamt', value: num(v.pvTotalW), unit: 'W' },
    { key: 'batteryPowerW', label: 'Akku (Laden +)', value: num(v.batteryPowerW), unit: 'W' },
    { key: 'soc', label: 'Ladestand', value: num(v.soc), unit: '%' },
    { key: 'selfConsumptionW', label: 'Hausverbrauch', value: num(v.selfConsumptionW), unit: 'W',
      note: loadDerived ? 'berechnet aus Energiebilanz' : null },
  ];
  for (const r of rows) if (r.ageMs === undefined) r.ageMs = ageMs(v.updatedAt, now, v, 'updatedAt');
  return rows;
}

/** Hausverbrauch aus der Energiebilanz berechnet? Liefert die Quelle ihn selbst, gilt er als gemessen. */
function loadIsDerived(cfg, inputs) {
  if (!cfg?.points?.selfConsumptionW?.derive) return false;
  return !inputs.some((i) => i.key === 'consumption_total' && i.received);
}

/**
 * Plausibilitätsprüfungen auf den Werten, wie DVhub sie sieht.
 * level: 'error' (Wert unmöglich) | 'warn' (vermutlich falsch zugeordnet) | 'info'
 */
export function plausibilityChecks({ cfg, state, inputs = [] }) {
  const out = [];
  const v = state?.victron || {};
  const kwp = num(Number(effectivePvKwp(cfg))); // Punkt 5: Gesamt-kWp inkl. zweitem Sungrow-WR
  const pv = num(v.pvTotalW);
  if (kwp && pv !== null && pv > kwp * 1000 * 1.2) {
    out.push({ key: 'pvTotalW', level: 'warn',
      text: `PV ${Math.round(pv)} W liegt über 120 % der eingetragenen PV-Leistung (${kwp} kWp). Zuordnung oder Einheit der PV-Quelle prüfen (z. B. PV und Akku addiert, kW statt W).` });
  }
  const soc = num(v.soc);
  if (soc !== null && (soc < 0 || soc > 100)) {
    out.push({ key: 'soc', level: 'error', text: `Ladestand ${soc} % ist kein gültiger Wert (0–100 %).` });
  }
  const bat = num(v.batteryPowerW);
  const batMax = Math.max(Math.abs(Number(cfg?.optimizer?.maxChargeW) || 0), Math.abs(Number(cfg?.optimizer?.maxDischargeW) || 0));
  if (bat !== null && batMax > 0 && Math.abs(bat) > batMax * 1.3) {
    out.push({ key: 'batteryPowerW', level: 'warn',
      text: `Akku-Leistung ${Math.round(bat)} W ist deutlich größer als die eingetragene Lade-/Entladeleistung (${batMax} W). Einheit oder Zuordnung prüfen.` });
  }
  // Energiebilanz nur, wenn der Hausverbrauch gemessen und nicht daraus berechnet ist.
  const load = num(v.selfConsumptionW);
  const imp = num(v.gridImportW);
  const exp = num(v.gridExportW);
  if (!loadIsDerived(cfg, inputs) && [pv, imp, exp, bat, load].every((x) => x !== null)) {
    const residual = pv + imp - exp - bat - load;
    const tolerance = Math.max(1500, 0.15 * Math.max(pv, load, Math.abs(bat)));
    if (Math.abs(residual) > tolerance) {
      out.push({ key: 'balance', level: 'warn',
        text: `Energiebilanz geht nicht auf: PV + Bezug − Einspeisung − Akku − Haus = ${Math.round(residual)} W. Meist ein Vorzeichen (Akku „Laden +“, Netz „Bezug +“) oder ein doppelt gezählter Wert.` });
    }
  }
  for (const i of inputs) {
    if (i.received && !i.fresh) {
      out.push({ key: i.key, level: 'warn', text: `${i.label}: letzter Wert ist veraltet${i.ageMs !== null ? ` (${Math.round(i.ageMs / 1000)} s)` : ''} — sendet die Quelle noch?` });
    }
  }
  const byKey = Object.fromEntries(inputs.map((i) => [i.key, i]));
  for (const [key, label] of [['grid_total', 'Netz gesamt'], ['battery_soc', 'Batterie-SoC']]) { // REQUIRED_INPUTS
    if (byKey[key] && !byKey[key].received) out.push({ key, level: 'error', text: `${label} kommt nicht an — ohne diesen Wert kann DVhub nicht steuern.` });
  }
  return out;
}

function controlRows(snapshot) {
  const labels = {
    gridSetpointW: ['Netz-Sollwert', 'W'],
    chargeCurrentA: ['Ladestrom', 'A'],
    minSocPct: ['Mindest-Ladestand', '%'],
    maxDischargeW: ['Max. Entladeleistung', 'W'],
  };
  return Object.entries(snapshot?.values || {}).map(([key, v]) => ({
    key,
    label: labels[key]?.[0] || key,
    unit: labels[key]?.[1] || '',
    value: v?.value ?? null,
    source: v?.source || null,
    origin: v?.origin || null,
    at: v?.at ?? null,
  }));
}

/**
 * @param {object} p
 * @param {object} p.cfg
 * @param {object} p.state
 * @param {object} [p.transport]
 * @param {object} [p.controlSnapshot]   was hinausgeht: services/gate/pickup.js handOut().control
 * @param {object} [p.gridLimit]         dito handOut().gridLimit
 * @param {Array}  [p.channels]          Ausgangskanäle (von der Route gebaut)
 * @param {number|null} [p.dvControlValue]
 * @param {string|null} [p.dvSignalSuspended]  services/gate/pickup.js dvSignal(): warum das DV-Signal gerade nicht
 *                                             hinausgeht (not_halt | read_only | gate_error), sonst null
 * @param {number} p.now
 */
export function buildDataflow({ cfg, state, transport, controlSnapshot, gridLimit, channels = [], dvControlValue = null, dvSignalSuspended = null, now }) {
  const inputs = inputRows({ cfg, state, transport, now });
  const lastWrite = state?.schedule?.lastWrite || {};
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    profile: cfg?.manufacturer || 'victron',
    in: {
      source: describeSource(cfg, transport),
      staleMaxAgeMs: num(transport?.staleMaxAgeMs),
      inputs,
    },
    seen: seenRows(cfg, state, now, inputs),
    checks: plausibilityChecks({ cfg, state, inputs }),
    out: {
      control: {
        source: controlSnapshot?.source || null,
        rule: controlSnapshot?.rule || null,
        updatedAt: controlSnapshot?.updatedAt || null,
        paused: !!controlSnapshot?.paused,
        rows: controlRows(controlSnapshot),
        // R-T3: warum gerade „keine Vorgabe“ hinausgeht (not_halt | read_only | config_unsafe | …) — nur dann gesetzt.
        ...(controlSnapshot?.suspended ? { suspended: controlSnapshot.suspended } : {}),
      },
      // Christin 19.11.2026: im Not-Halt und Lese-Modus geht das DV-Signal nicht hinaus — dann „kein Signal“ mit Grund.
      dvSignal: dvSignalSuspended
        ? { value: null, forcedOff: null, suspended: dvSignalSuspended }
        : { value: dvControlValue, forcedOff: !!state?.ctrl?.forcedOff },
      gridLimit: gridLimit || null,
      lastWrites: Object.entries(lastWrite)
        .filter(([, w]) => w)
        .map(([key, w]) => ({ key, value: w.value ?? null, writeType: w.writeType || null, source: w.source || null, at: w.at ?? null })),
      channels,
    },
  };
}
