// Golden-Master der EFFEKTIVEN Konfiguration für das Node-Schreibtor (H-1, Nachweis D.4(1) des VCL-Vertrags):
// „Verglichen wird, was nach applyManufacturerProfile UND applyVictronDefaults wirklich gilt — nicht die Profildatei."
//
// Durchlauf über den echten Ladeweg (loadConfigFile → normalizeConfigInput → applyManufacturerProfile →
// applyVictronDefaults) gegen ein temporäres Verzeichnis mit config.json + hersteller/<profil>.json. Eingefroren
// werden NUR benannte Felder (Positivliste unten: Lese-/Steuerpunkte, Adressen, Unit-IDs, Flags) — nie
// Zugangsdaten. Ein Feld, das weder auf der Positiv- noch auf der Ausschlussliste steht, bricht den Test
// („unklassifiziert"), damit ein neues Profilfeld bewusst eingeordnet wird statt still durchzurutschen.
//
// Zellen (Auswahl aus dem vollen Produkt, siehe CELLS unten):
//   A) 6 Profile × Profilstand {mitgeliefert, geändert, kaputt, fehlend, leer} × Overrides {keine, durchgesetzt,
//      verwaltete Felder in config.json} × applyVictronDefaults = Standard                     → 90 Zellen
//   B) 6 Profile × Profilstand {mitgeliefert, fehlend} × Overrides keine × 8 applyVictronDefaults-Varianten
//      (pvCoupling ac/dc, acPvSource grid/genset, acPvSource2 aktiv/gleich, dc+acPvSource2, Akku-Stufen) → 96 Zellen
//   Weggelassen: Override- und Varianten-Kreuzungen mit „geändert"/„kaputt"/„leer" — applyVictronDefaults läuft
//   in allen Ständen auf derselben Funktion; die Kombinationen bringen keinen neuen Codepfad.
//
// Die Zellen „kaputt", „fehlend" und „leer" frieren den Fehlerzustand ein (writeSafety.ok=false). Seit E1/E2
// (18.11.2026) gilt dort R-T2.1 (Vertrag v6): für einen anderen Hersteller als victron bleibt keine Victron-
// Werkskarte stehen (meter/points/controlWrite/dvControl-Ziele leer); victron selbst behält sie, das Schreiben
// sperrt writeSafety. Eine leere Profildatei ist seitdem ungültig statt ein {}-Profil.
//
// Frieren/aktualisieren: GOLDEN_FREEZE=1 node --test dvhub/test/gate-golden-effective-config.test.js
// (schreibt test/fixtures/gate-golden/effective-config.json neu). NUR mit belegtem Grund.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfigFile } from '../config-model.js';

const FREEZE = process.env.GOLDEN_FREEZE === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(HERE, '..', 'hersteller');
const FIXTURE = path.join(HERE, 'fixtures', 'gate-golden', 'effective-config.json');

const PROFILES = ['victron', 'fronius', 'sungrow', 'deye-lv', 'bridge-mqtt', 'dvhub-mqtt'];

// --- Positivliste ---------------------------------------------------------------------------------------
// Felder eines Register-/Steuer-Eintrags (meter, points.*, controlWrite.*, dvControl.<ziel>).
const ENTRY_KEYS = new Set([
  'enabled', 'fc', 'address', 'quantity', 'host', 'port', 'unitId', 'timeoutMs', 'signed', 'scale', 'offset',
  'readType', 'writeType', 'wordOrder', 'notAvailableRaw', 'rawSentinels', 'rawSentinelMap', 'sumRegisters',
  'sunspec', 'derive', 'chargeModule', 'dischargeModule', 'pollEveryMs', 'emulate', 'keepaliveMs', 'verify',
  'sungrowEms', 'sequence', 'fallback',
]);
const VICTRON_KEYS = new Set([
  'transport', 'host', 'port', 'unitId', 'timeoutMs', 'acPvSource', 'acPvSource2', 'telemetryMaxAgeMs',
  'modbusConnectTimeoutMs',
]);
const VICTRON_SUB_KEYS = {
  mqtt: new Set(['broker', 'portalId', 'keepaliveIntervalMs', 'qos', 'schema', 'topicPrefix', 'staleMaxAgeMs']),
  alarms: new Set(['enabled', 'batteryUnitId', 'vebusUnitId', 'pollIntervalMs', 'timeoutMs']),
  freezeWatchdog: new Set(['enabled', 'freezeMs', 'maxReconnects', 'minJitterFields', 'minPowerW', 'minSamples',
    'reconnectMs', 'socBandHighPct', 'socBandLowPct', 'socStepPct']),
  mqttCrossCheck: new Set(['enabled', 'broker', 'portalId', 'compareMs', 'keepaliveMs', 'maxAgeMs', 'sustainMs',
    'rejectUnauthorized']),
};
const DV_TARGETS = new Set(['feedExcessDcPv', 'dontFeedExcessAcPv', 'zeroFeedIn']);
const IDENTIFY_KEYS = new Set(['kind', 'requiredForWrites', 'infoEveryMs']);
const WRITE_SAFETY_KEYS = new Set(['ok', 'reason', 'manufacturer']);
// Bewusst NICHT eingefroren: Kommentare/Doku und Zugangsdaten.
const EXCLUDED_KEYS = new Set(['_comment', '_doc', '_comment_alarms', 'label', 'username', 'password']);

// Kopie ohne `_*`-Kommentarschlüssel (in sequence/sunspec/sungrowEms/fallback verschachtelt).
function stripDoc(value) {
  if (Array.isArray(value)) return value.map(stripDoc);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('_')) out[k] = stripDoc(v);
    return out;
  }
  return value;
}

// Effektive Config → flaches, sortiertes { pfad: wert } nur über die Positivliste. `unclassified` sammelt
// Schlüssel, die weder positiv noch ausgeschlossen sind (nur der Pfad, nie der Wert).
function snapshotEffective(result) {
  const cfg = result.effectiveConfig || {};
  const flat = {};
  const unclassified = [];
  const put = (p, v) => { if (v !== undefined) flat[p] = stripDoc(v); };
  const entry = (prefix, obj) => {
    if (obj == null) return;
    if (typeof obj !== 'object' || Array.isArray(obj)) { put(prefix, obj); return; }
    for (const [k, v] of Object.entries(obj)) {
      if (ENTRY_KEYS.has(k)) put(`${prefix}.${k}`, v);
      else if (!EXCLUDED_KEYS.has(k)) unclassified.push(`${prefix}.${k}`);
    }
  };
  const victron = cfg.victron || {};
  for (const [k, v] of Object.entries(victron)) {
    if (VICTRON_KEYS.has(k)) put(`victron.${k}`, v);
    else if (VICTRON_SUB_KEYS[k] && v && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (VICTRON_SUB_KEYS[k].has(sk)) put(`victron.${k}.${sk}`, sv);
        else if (!EXCLUDED_KEYS.has(sk)) unclassified.push(`victron.${k}.${sk}`);
      }
    } else if (!EXCLUDED_KEYS.has(k)) unclassified.push(`victron.${k}`);
  }
  entry('meter', cfg.meter);
  for (const group of ['points', 'controlWrite']) {
    for (const [name, item] of Object.entries(cfg[group] || {})) entry(`${group}.${name}`, item);
  }
  for (const [k, v] of Object.entries(cfg.dvControl || {})) {
    if (k === 'enabled') put('dvControl.enabled', v);
    else if (k === 'negativePriceProtection') {
      put('dvControl.negativePriceProtection.enabled', v?.enabled);
      put('dvControl.negativePriceProtection.gridSetpointW', v?.gridSetpointW);
    } else if (DV_TARGETS.has(k)) entry(`dvControl.${k}`, v);
    else if (!EXCLUDED_KEYS.has(k)) unclassified.push(`dvControl.${k}`);
  }
  if (cfg.identify !== undefined) {
    for (const [k, v] of Object.entries(cfg.identify || {})) {
      if (IDENTIFY_KEYS.has(k)) put(`identify.${k}`, v);
      else if (!EXCLUDED_KEYS.has(k)) unclassified.push(`identify.${k}`);
    }
  }
  if (cfg.writeSafety !== undefined) {
    for (const [k, v] of Object.entries(cfg.writeSafety || {})) {
      if (WRITE_SAFETY_KEYS.has(k)) put(`writeSafety.${k}`, v);
      else unclassified.push(`writeSafety.${k}`);
    }
  }
  put('pvCoupling', cfg.pvCoupling);
  put('optimizer.batteryCapacityWh', cfg.optimizer?.batteryCapacityWh);
  // Ladeergebnis: nur Wahrheitswerte und die Strip-Warnungen (Fehlertexte enthalten Pfade/V8-Wortlaut).
  put('$.valid', result.valid);
  put('$.profileError', result.manufacturerProfileError != null);
  put('$.managedWarnings', (result.warnings || []).filter((w) => /managed by manufacturer profile/.test(w)));
  const sorted = {};
  for (const k of Object.keys(flat).sort()) sorted[k] = flat[k];
  return { flat: sorted, unclassified };
}

// --- Achsen ---------------------------------------------------------------------------------------------
// „vom Betreiber geändert": je verwalteter Gruppe EIN Wert, deterministisch aus dem mitgelieferten Profil.
function bumpEntryMap(map) {
  const entries = Object.entries(map || {});
  const withAddress = entries.find(([, v]) => typeof v?.address === 'number');
  if (withAddress) { withAddress[1].address += 1; return; }
  const withSunspec = entries.find(([, v]) => v?.sunspec && typeof v.sunspec.offset === 'number');
  if (withSunspec) { withSunspec[1].sunspec.offset += 1; return; }
  if (entries.length) entries[0][1].enabled = !entries[0][1].enabled;
}
function modifyProfile(shipped) {
  const p = structuredClone(shipped);
  if (p.victron) {
    if (typeof p.victron.port === 'number') p.victron.port = 1502;
    else if (p.victron.mqtt) p.victron.mqtt.keepaliveIntervalMs = 45000;
  }
  if (p.meter && typeof p.meter.address === 'number') p.meter.address += 1;
  bumpEntryMap(p.points);
  bumpEntryMap(p.controlWrite);
  if (p.dvControl) {
    const targets = ['feedExcessDcPv', 'dontFeedExcessAcPv', 'zeroFeedIn'].map((k) => p.dvControl[k]).filter(Boolean);
    const withAddress = targets.find((t) => typeof t.address === 'number');
    const withSeq = targets.find((t) => Array.isArray(t.sequence?.['0']) && t.sequence['0'].length);
    if (withAddress) withAddress.address += 1;
    else if (withSeq) {
      const step = withSeq.sequence['0'][0];
      if (typeof step.value === 'number') step.value += 1; else step.restoreDefault = (step.restoreDefault ?? 0) + 1;
    } else if (targets.length) targets[0].enabled = !targets[0].enabled;
  }
  if (p.identify) p.identify.requiredForWrites = !p.identify.requiredForWrites;
  return p;
}

const STATES = {
  shipped: (text) => text,
  modified: (text) => JSON.stringify(modifyProfile(JSON.parse(text)), null, 2),
  broken: (text) => text.slice(0, Math.floor(text.length / 2)),   // syntaktisch kaputt (abgeschnitten)
  missing: () => null,                                            // Datei fehlt
  empty: () => '',                                                // leere Datei (ungültig wie kaputt, seit E2)
};

// Betreiber-Overrides. „enforced" = alle Felder, die config.json laut config-model.js:375-431 noch durchsetzt
// (victron.host/alarms/freezeWatchdog/mqttCrossCheck/telemetryMaxAgeMs/modbusConnectTimeoutMs/mqtt nicht-leer,
// dvControl.enabled/negativePriceProtection). acPvSource/acPvSource2 laufen als eigene Varianten (B).
// „managedLeak" = verwaltete Felder in config.json → müssen entfernt und gewarnt werden (:345-351).
const OVERRIDES = {
  none: {},
  enforced: {
    victron: {
      host: '192.0.2.10',
      alarms: { enabled: true, vebusUnitId: 227, batteryUnitId: 225, pollIntervalMs: 15000, timeoutMs: 1500 },
      freezeWatchdog: { enabled: true, freezeMs: 600000 },
      mqttCrossCheck: { enabled: true, broker: 'mqtt://192.0.2.11:1883', portalId: 'testportal' },
      telemetryMaxAgeMs: 45000,
      modbusConnectTimeoutMs: 4000,
      mqtt: { broker: 'mqtt://192.0.2.12:1883', portalId: '', qos: 1 },
    },
    dvControl: { enabled: false, negativePriceProtection: { enabled: false, gridSetpointW: -77 } },
  },
  managedLeak: {
    victron: { transport: 'mqtt', port: 1503, unitId: 42, timeoutMs: 4321 },
    meter: { address: 9001 },
    points: { soc: { address: 9002 } },
    controlWrite: { gridSetpointW: { address: 9003 } },
    identify: { kind: 'fake', requiredForWrites: false },
    dvControl: { feedExcessDcPv: { enabled: true, address: 9004 }, dontFeedExcessAcPv: { enabled: true }, zeroFeedIn: { enabled: true } },
  },
};

// applyVictronDefaults-Varianten (config-model.js applyVictronDefaults: pvCoupling, acPv-Quelle 1/2, Akku-Stufen).
// Akku-Stufen: 2000-01-01 → 7000 Wh, 2100-01-01 → 14000 Wh ⇒ bis 2100 unabhängig von der Uhr 7000 Wh.
const VARIANTS = {
  default: {},
  coupling_ac: { pvCoupling: 'ac' },
  coupling_dc: { pvCoupling: 'dc' },
  acpv_grid: { victron: { acPvSource: 'grid' } },
  acpv_genset: { victron: { acPvSource: 'genset' } },
  acpv2_grid: { victron: { acPvSource2: 'grid' } },
  acpv2_same: { victron: { acPvSource: 'grid', acPvSource2: 'grid' } },
  dc_acpv2: { pvCoupling: 'dc', victron: { acPvSource2: 'genset' } },
  stages: { optimizer: { batteryCapacityWh: 10000, batteryStages: [
    { id: 'a', label: 'Start', startDate: '2000-01-01', capacityWh: 7000 },
    { id: 'b', label: 'Ausbau', startDate: '2100-01-01', capacityWh: 14000 },
  ] } },
};

function merge(a, b) {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object'
      ? merge(out[k], v) : structuredClone(v);
  }
  return out;
}

const CELLS = [];
for (const profile of PROFILES) {
  for (const state of Object.keys(STATES)) {
    for (const override of Object.keys(OVERRIDES)) CELLS.push({ profile, state, override, variant: 'default' });
  }
  for (const state of ['shipped', 'missing']) {
    for (const variant of Object.keys(VARIANTS)) {
      if (variant !== 'default') CELLS.push({ profile, state, override: 'none', variant });
    }
  }
}
const cellKey = (c) => `${c.profile}|${c.state}|${c.override}|${c.variant}`;
// Referenz für die Differenz-Ablage: mitgeliefertes/geändertes Profil → das mitgelieferte Profil; kaputt, fehlend
// oder leer → der Fehlerzustand „fehlend" desselben Herstellers (victron: Werksstand; andere: ohne Victron-Karte).
// Nur die Ablage — verglichen wird immer das vollständig expandierte Abbild je Zelle.
const refKey = (c) => (['broken', 'missing', 'empty'].includes(c.state)
  ? `${c.profile}|missing|none|default` : `${c.profile}|shipped|none|default`);

function runCell(c, tmpRoot) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'cell-'));
  fs.mkdirSync(path.join(dir, 'hersteller'));
  const shippedText = fs.readFileSync(path.join(PROFILE_DIR, `${c.profile}.json`), 'utf8');
  const profileText = STATES[c.state](shippedText);
  if (profileText != null) fs.writeFileSync(path.join(dir, 'hersteller', `${c.profile}.json`), profileText);
  const config = merge(merge({ manufacturer: c.profile }, OVERRIDES[c.override]), VARIANTS[c.variant]);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return snapshotEffective(loadConfigFile(path.join(dir, 'config.json')));
}

function captureAll() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-gate-cfg-'));
  try {
    const snaps = {};
    const unclassified = new Set();
    for (const c of CELLS) {
      const { flat, unclassified: u } = runCell(c, tmpRoot);
      snaps[cellKey(c)] = flat;
      for (const p of u) unclassified.add(p);
    }
    return { snaps, unclassified: [...unclassified].sort() };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function toFixture(snaps) {
  const refs = [...new Set(CELLS.map(refKey))];
  const bases = Object.fromEntries(refs.map((r) => [r, snaps[r]]));
  const cells = {};
  for (const c of CELLS) {
    const key = cellKey(c);
    if (refs.includes(key)) { cells[key] = { ref: key }; continue; }
    const base = bases[refKey(c)];
    const got = snaps[key];
    const set = {};
    for (const [p, v] of Object.entries(got)) if (!(p in base) || !same(base[p], v)) set[p] = v;
    const removed = Object.keys(base).filter((p) => !(p in got));
    cells[key] = { ref: refKey(c), ...(Object.keys(set).length ? { set } : {}), ...(removed.length ? { removed } : {}) };
  }
  return {
    _doc: 'Referenzabbild D.4(1), erzeugt von test/gate-golden-effective-config.test.js (GOLDEN_FREEZE=1). '
      + 'bases = vollständige Abbilder; cells = je Zelle Referenz + Abweichungen (set) + fehlende Pfade (removed).',
    bases,
    cells,
  };
}

// Eine Zeile je Feldpfad — kurze, gut diffbare Fixture statt tief eingerückter Werte.
function serializeFixture(fx) {
  const ind = (n) => ' '.repeat(n);
  const lines = (items, n, open, close) => (items.length
    ? `${open}\n${items.map((it) => `${ind(n + 2)}${it}`).join(',\n')}\n${ind(n)}${close}` : `${open}${close}`);
  const flatObj = (o, n) => lines(Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`), n, '{', '}');
  const flatArr = (a, n) => lines(a.map((v) => JSON.stringify(v)), n, '[', ']');
  const bases = Object.entries(fx.bases).map(([k, b]) => `${JSON.stringify(k)}: ${flatObj(b, 4)}`);
  const cells = Object.entries(fx.cells).map(([k, c]) => {
    const parts = [`"ref": ${JSON.stringify(c.ref)}`];
    if (c.set) parts.push(`"set": ${flatObj(c.set, 6)}`);
    if (c.removed) parts.push(`"removed": ${flatArr(c.removed, 6)}`);
    return `${JSON.stringify(k)}: ${lines(parts, 4, '{', '}')}`;
  });
  return `{\n  "_doc": ${JSON.stringify(fx._doc)},\n  "bases": ${lines(bases, 2, '{', '}')},\n  "cells": ${lines(cells, 2, '{', '}')}\n}\n`;
}

function expand(fixture, key) {
  const cell = fixture.cells[key];
  if (!cell) return undefined;
  const out = { ...fixture.bases[cell.ref] };
  for (const [p, v] of Object.entries(cell.set || {})) out[p] = v;
  for (const p of cell.removed || []) delete out[p];
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}

const captured = captureAll();

test('H-1 D.4(1): jedes Feld der verwalteten Gruppen ist klassifiziert (Positiv- oder Ausschlussliste)', () => {
  assert.deepEqual(captured.unclassified, [], 'neues Feld in der effektiven Config — in ENTRY_KEYS o. ä. einordnen');
});

test('H-1 D.4(1): effektive Konfiguration je Zelle unverändert (186 Zellen)', () => {
  if (FREEZE) {
    fs.writeFileSync(FIXTURE, serializeFixture(toFixture(captured.snaps)));
    // eslint-disable-next-line no-console
    console.error(`GOLDEN_FREEZE: ${FIXTURE} neu geschrieben (${CELLS.length} Zellen)`);
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(Object.keys(fixture.cells).sort(), CELLS.map(cellKey).sort(), 'Zellen-Menge weicht ab');
  const diffs = [];
  for (const c of CELLS) {
    const key = cellKey(c);
    const want = expand(fixture, key);
    const got = captured.snaps[key];
    for (const p of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (!same(want[p], got[p])) diffs.push(`${key} :: ${p}: erwartet ${JSON.stringify(want[p])}, ist ${JSON.stringify(got[p])}`);
    }
  }
  assert.deepEqual(diffs.slice(0, 40), [], `effektive Konfiguration weicht ab (${diffs.length} Abweichungen) — Verhaltensänderung!`);
});

// Plausibilitätsanker: die Kernaussagen des Vertrags am eingefrorenen Stand, lesbar ohne Fixture-Diff.
test('H-1 D.4(1): kaputtes/fehlendes/leeres Profil = writeSafety gesperrt; victron behält seine Werkskarte', () => {
  for (const profile of PROFILES) {
    for (const state of ['broken', 'missing', 'empty']) {
      const s = captured.snaps[`${profile}|${state}|none|default`];
      assert.equal(s['$.valid'], false, `${profile}/${state}: valid`);
      assert.equal(s['writeSafety.ok'], false, `${profile}/${state}: writeSafety.ok`);
      assert.equal(s['writeSafety.reason'], 'manufacturer_profile_error');
      assert.equal(s['writeSafety.manufacturer'], profile);
    }
  }
  for (const state of ['broken', 'missing', 'empty']) {
    const s = captured.snaps[`victron|${state}|none|default`];
    assert.equal(s['controlWrite.gridSetpointW.address'], 2716, `victron/${state}: Victron-Werks-Sollwertregister bleibt stehen`);
  }
});

// R-T2.1 (Vertrag v6 D.1): ungültiges Profil → für einen ANDEREN Hersteller kein Rückgriff auf Victron-Werkswerte;
// controlWrite, dvControl-Ziele und Profil-Lesepunkte leer. R-T2.2–4 (Lease/safetyRelease) gehören zum Tor.
test('H-1 R-T2.1: ungültiges/fehlendes/leeres Profil eines anderen Herstellers → keine Victron-Werkswerte, Ziele/Lesepunkte leer', () => {
  for (const profile of PROFILES.filter((p) => p !== 'victron')) {
    for (const state of ['broken', 'missing', 'empty']) {
      for (const override of Object.keys(OVERRIDES)) {
        const s = captured.snaps[`${profile}|${state}|${override}|default`];
        const writeTargets = Object.keys(s).filter((p) => /^(controlWrite|dvControl\.(feedExcessDcPv|dontFeedExcessAcPv|zeroFeedIn))\./.test(p));
        const readPoints = Object.keys(s).filter((p) => /^(points|meter)\./.test(p));
        assert.deepEqual(writeTargets, [], `${profile}/${state}/${override}: Schreibziele müssen leer sein`);
        assert.deepEqual(readPoints, [], `${profile}/${state}/${override}: herstellerspezifische Lesepunkte müssen leer sein`);
      }
    }
  }
});
