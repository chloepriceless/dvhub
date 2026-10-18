// test/ui-guidance-bigge.test.js — Anwenderführung aus dem Feldfall BIGGE
// (Kundentermin 2026-10-16, UEBERGABE §5 Punkt 8): echte Felddefinitionen aus
// config-model.js gegen die echte Sichtbarkeitslogik der Einstellungsseite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { getConfigDefinition } from '../config-model.js';

function settingsSandbox() {
  const source = fs.readFileSync(fileURLToPath(new URL('../public/settings.js', import.meta.url)), 'utf8');
  const stub = () => {};
  const sandbox = {
    console,
    window: { DVhubCommon: { escapeHtml: (v) => String(v ?? '') }, addEventListener: stub, setTimeout: stub },
    document: { getElementById: () => null, createElement: () => ({ appendChild: stub, setAttribute: stub, style: {}, classList: { add: stub, remove: stub } }), addEventListener: stub },
    setTimeout: stub,
    location: {},
    localStorage: { getItem: () => null, setItem: stub }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(source, sandbox); } catch { /* Bootstrap braucht einen Browser */ }
  // getVisibilityValue ist eine Funktionsdeklaration → von außen ersetzbar.
  const withConfig = (cfg) => {
    sandbox.getVisibilityValue = (p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
  };
  return { sandbox, withConfig };
}

const field = (p) => getConfigDefinition().fields.find((f) => f.path === p);

test('U2: Anlagenadresse nur bei Profilen mit Geräteverbindung', () => {
  const { sandbox, withConfig } = settingsSandbox();
  const host = field('victron.host');
  assert.ok(host);
  for (const manufacturer of ['victron', 'fronius', 'deye-lv', 'bridge-mqtt']) {
    withConfig({ manufacturer, updateChannel: 'dev' });
    assert.equal(sandbox.isFieldVisible(host), true, manufacturer);
  }
  withConfig({ manufacturer: 'dvhub-mqtt', updateChannel: 'dev' });
  assert.equal(sandbox.isFieldVisible(host), false, 'Universal HA/Loxone: kein Gerät, keine Adresse');
});

test('C8: Netzladen an, aber ohne MiSpeL-Freigabe → Hinweis „wirkt gerade nicht“', () => {
  const { sandbox, withConfig } = settingsSandbox();
  const note = (cfg, p = 'optimizer.allowGridCharge') => { withConfig(cfg); return sandbox.fieldRuntimeNote(p); };
  // Feldfall: Schalter an, keine Option, kein „ohne“ → wirkt nicht.
  assert.match(note({ optimizer: { allowGridCharge: true } }), /^Wirkt gerade nicht/);
  assert.match(note({ optimizer: { allowGridCharge: true, mispel: { mode: 'none' } } }), /^Wirkt gerade nicht/);
  // Jede Freigabe nimmt den Hinweis weg (wie grid-storage.js isMispelReleased).
  for (const optimizer of [
    { allowGridCharge: true, mispel: { mode: 'pauschal' } },
    { allowGridCharge: true, mispel: { mode: 'abgrenzung' } },
    { allowGridCharge: true, gridChargeWithoutMispel: true },
    { allowGridCharge: true, gridStorageOnly: true },
  ]) assert.equal(note({ optimizer }), '', JSON.stringify(optimizer));
  assert.equal(note({ optimizer: { allowGridCharge: false } }), '', 'aus = nichts zu melden');
  // Gegenrichtung: Freigabe ohne den Hauptschalter
  assert.match(note({ optimizer: { gridChargeWithoutMispel: true } }, 'optimizer.gridChargeWithoutMispel'), /zusammen mit „Netzladen erlaubt“/);
  assert.match(note({ optimizer: { mispel: { mode: 'pauschal' } } }, 'optimizer.mispel.mode'), /bis „Netzladen erlaubt“/);
  assert.equal(note({ optimizer: { mispel: { mode: 'none' } } }, 'optimizer.mispel.mode'), '');
  // Umschalten eines dieser Felder zeichnet die Seite neu (Hinweis folgt sofort).
  for (const p of ['optimizer.allowGridCharge', 'optimizer.mispel.mode', 'optimizer.gridChargeWithoutMispel']) {
    assert.equal(sandbox.fieldAffectsVisibility(p), true, p);
  }
});

test('MiSpeL-Option: Auswahlfeld unter den rechtlichen Schaltern, Wahl einer Option muss bestätigt werden', () => {
  const f = field('optimizer.mispel.mode');
  assert.ok(f, 'Feld vorhanden');
  assert.equal(f.group, 'legalSwitches');
  assert.equal(f.type, 'select');
  assert.deepEqual(f.options.map((o) => o.value), ['none', 'pauschal', 'abgrenzung']);
  const { sandbox } = settingsSandbox();
  // JSON-Runde: Arrays aus der VM haben einen eigenen Prototyp.
  const flipped = (before, after) => JSON.parse(JSON.stringify(sandbox.legalGatesFlippedOn(
    { optimizer: { mispel: { mode: after } } }, { optimizer: { mispel: { mode: before } } },
  ).map((x) => x.path)));
  assert.deepEqual(flipped(undefined, 'none'), []);
  assert.deepEqual(flipped('none', 'pauschal'), ['optimizer.mispel.mode']);
  assert.deepEqual(flipped(undefined, 'abgrenzung'), ['optimizer.mispel.mode']);
  assert.deepEqual(flipped('pauschal', 'abgrenzung'), []);
  assert.deepEqual(flipped('pauschal', 'none'), []);
});

test('U3: Dachflächen-Hinweis ohne Fläche, Anlegen schaltet die Prognose auf „detailed“', () => {
  const { sandbox, withConfig } = settingsSandbox();
  withConfig({ forecast: { pv: { totalKwp: 36, strings: [] } } });
  assert.match(sandbox.forecastStringsNote([]), /35° Neigung, Süd 180°/);
  const flaeche = [{ label: 'Süd', kwp: 20, tiltDeg: 30, azimuthDeg: 180 }];
  // Fläche in der Config, aber Stufe nicht „detailed“ → Prognose ignoriert sie.
  assert.match(sandbox.forecastStringsNote(flaeche), /gelten noch nicht/);
  withConfig({ forecast: { pv: { configLevel: 'detailed', strings: flaeche } } });
  assert.equal(sandbox.forecastStringsNote(flaeche), '');
  // Editor-Sichtbarkeit hing an configLevel — jetzt immer da.
  const src = fs.readFileSync(fileURLToPath(new URL('../public/settings.js', import.meta.url)), 'utf8');
  assert.match(src, /if \(name === 'forecastStrings'\) return renderForecastStringEditor\(\);/);
  assert.match(src, /if \(forecastStringsDraft\.length\) currentDraftConfig\.forecast\.pv\.configLevel = 'detailed';/);
});

test('U4: Standard-Tarif sagt, ob heute er oder ein Zeitraum gilt', () => {
  const { sandbox } = settingsSandbox();
  const periods = [{ id: 'sommer', label: 'Dynamisch Sommer', startDate: '2026-04-01', endDate: '2026-09-30' }];
  const at = (iso) => sandbox.pricingPeriodNote(periods, 'Europe/Berlin', new Date(iso));
  assert.equal(sandbox.pricingPeriodNote([], 'Europe/Berlin', new Date('2026-07-01T12:00:00Z')), '');
  assert.match(at('2026-07-01T12:00:00Z'), /^Heute gilt der Zeitraum „Dynamisch Sommer“ \(01\.04\.2026–30\.09\.2026\)/);
  // Zeitraum erbt, was er nicht setzt (deepMerge) — kein „ersetzt vollständig“.
  assert.match(at('2026-07-01T12:00:00Z'), /alles andere \(z\. B\. §14a Modul 3\) übernimmt er vom Standard-Tarif/);
  // 30.09. 23:30 Ortszeit = 21:30 UTC → noch Zeitraum; 01.10. 00:30 Ortszeit → Grundtarif
  assert.match(at('2026-09-30T21:30:00Z'), /Zeitraum „Dynamisch Sommer“/);
  assert.equal(at('2026-09-30T22:30:00Z'), 'Heute gilt dieser Grundtarif.');
  assert.equal(at('2026-03-15T12:00:00Z'), 'Heute gilt dieser Grundtarif. Ab 01.04.2026 gilt der Zeitraum „Dynamisch Sommer“ mit eigenen Werten.');
});

// Codex 2026-10-18: Abbruch der Bestätigung setzte jedes Feld auf false — für die
// Auswahl der MiSpeL-Option ungültig (leeres Feld, ungültiger Wert beim nächsten Speichern).
test('Abbruch der Bestätigung: MiSpeL-Option zurück auf „none“, Schalter auf false', async () => {
  const { sandbox } = settingsSandbox();
  const draft = { optimizer: { allowGridCharge: true, mispel: { mode: 'pauschal' } } };
  sandbox.getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  sandbox.setPath = (o, p, v) => { const ks = p.split('.'); let n = o; for (const k of ks.slice(0, -1)) n = (n[k] ??= {}); n[ks.at(-1)] = v; };
  sandbox.legalGatesFlippedOn = () => [{ path: 'optimizer.allowGridCharge' }, { path: 'optimizer.mispel.mode' }];
  sandbox.confirmLegalGateDialog = async () => false;
  sandbox.renderSettingsShell = () => {};
  sandbox.setBanner = () => {};
  vm.runInContext('currentDraftConfig = globalThis.__draft;', Object.assign(sandbox, { __draft: draft }));
  const r = await sandbox.confirmLegalGatesBeforeSave({});
  assert.equal(r.proceed, false);
  assert.equal(draft.optimizer.mispel.mode, 'none');
  assert.equal(draft.optimizer.allowGridCharge, false);
});
