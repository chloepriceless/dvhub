// test/beta-gate.test.js — Beta-Gate für Einstellungen (Christin, 29.07.2026)
//
// Vertrag: ein Feature, das noch im Feldtest ist, darf im Stable-Kanal WEDER
// sichtbar sein NOCH wirken — auch dann nicht, wenn `enabled: true` in der
// config.json steht (etwa weil die Box vorher im Bleeding-Edge-Kanal lief oder
// eine Konfiguration von einer Testbox importiert wurde).
//
// Der wichtigste Test hier ist der letzte: er zählt ALLE registrierten
// Beta-Features auf und prüft für jedes dieselbe Zusage. Ein neu hinzugefügtes
// Beta-Feature ohne Gate fällt damit auf, statt still auf jeder Kundenbox zu
// laufen — genau der Fehler, der ohne dieses Gate passiert wäre.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { BETA_FEATURES, betaGateOpen, updateChannelOf, betaFeatureForPath } from '../beta-features.js';
import { getConfigDefinition } from '../config-model.js';
import { resolveEosProxy } from '../services/optimizer/eos-adapter.js';
import { resolveControlWriteVerify } from '../schedule-eval.js';
import { resolveCrossCheckOptions } from '../services/mqtt-crosscheck.js';
import { resolveFreezeOptions } from '../services/telemetry-freeze-watchdog.js';

// Pro Feature: eine Config, in der der Schalter AUSDRÜCKLICH an ist, und die
// Funktion, die daraus das wirksame `enabled` ableitet.
const RESOLVERS = {
  freezeWatchdog: {
    resolve: resolveFreezeOptions,
    configWithFlagOn: { victron: { freezeWatchdog: { enabled: true } } }
  },
  mqttCrossCheck: {
    resolve: resolveCrossCheckOptions,
    configWithFlagOn: { victron: { host: '10.0.0.5', mqttCrossCheck: { enabled: true, portalId: 'abc', password: 'x' } } }
  },
  controlWriteVerify: {
    resolve: resolveControlWriteVerify,
    configWithFlagOn: { schedule: { controlWriteVerify: { enabled: true } } }
  }
};

const RUNTIME_KEYS = Object.keys(BETA_FEATURES).filter((k) => BETA_FEATURES[k].gate === 'runtime');
const DISPLAY_KEYS = Object.keys(BETA_FEATURES).filter((k) => BETA_FEATURES[k].gate === 'display');

test('updateChannelOf: fehlender/leerer Kanal gilt als stable', () => {
  assert.equal(updateChannelOf({}), 'stable');
  assert.equal(updateChannelOf({ updateChannel: '' }), 'stable');
  assert.equal(updateChannelOf({ updateChannel: '  ' }), 'stable');
  assert.equal(updateChannelOf(null), 'stable');
  assert.equal(updateChannelOf({ updateChannel: ' dev ' }), 'dev');
  assert.equal(updateChannelOf({ updateChannel: 'stable' }), 'stable');
});

test('betaGateOpen: nur im dev-Kanal offen, unbekannter Schlüssel fail-closed', () => {
  assert.equal(betaGateOpen({ updateChannel: 'dev' }, 'freezeWatchdog'), true);
  assert.equal(betaGateOpen({ updateChannel: 'stable' }, 'freezeWatchdog'), false);
  assert.equal(betaGateOpen({}, 'freezeWatchdog'), false);
  // Tippfehler an einer Aufrufstelle schaltet das Feature AB, statt es
  // versehentlich für alle freizugeben.
  assert.equal(betaGateOpen({ updateChannel: 'dev' }, 'freezeWatchDog'), false);
  assert.equal(betaGateOpen({ updateChannel: 'dev' }, '__proto__'), false);
});

test('betaFeatureForPath ordnet Feldpfade ihrem Feature zu', () => {
  assert.equal(betaFeatureForPath('victron.freezeWatchdog.enabled'), 'freezeWatchdog');
  assert.equal(betaFeatureForPath('victron.freezeWatchdog'), 'freezeWatchdog');
  assert.equal(betaFeatureForPath('schedule.controlWriteVerify.toleranceAbs'), 'controlWriteVerify');
  assert.equal(betaFeatureForPath('victron.host'), null);
  // Kein Präfix-Fehlgriff: ein ähnlich benannter Nachbar gehört nicht dazu.
  assert.equal(betaFeatureForPath('victron.freezeWatchdogExtra'), null);
});

// Runde 2 (29.07.2026): die Beta-Features haben jetzt VOLLSTÄNDIGE Bedienfelder,
// nicht mehr nur ihren Ein/Aus-Schalter. Vorher waren die Schwellen nur in der
// config.json erreichbar — genau deshalb war der Einfrier-Wächter im ersten
// Feldtest wirkungslos konfiguriert.
test('jede Beta-Funktion hat eine eigene Gruppe mit mehr als nur dem Schalter', () => {
  const fields = getConfigDefinition().fields.filter((f) => f.path && f.beta === true);
  const byFeature = new Map();
  for (const f of fields) {
    const key = betaFeatureForPath(f.path);
    if (!byFeature.has(key)) byFeature.set(key, []);
    byFeature.get(key).push(f);
  }
  for (const key of Object.keys(BETA_FEATURES)) {
    const own = byFeature.get(key) || [];
    assert.ok(own.length >= 2,
      `${key}: nur ${own.length} Bedienfeld(er) — die Werte wären weiter nur in der Datei erreichbar`);
    // Ein Ein/Aus-Schalter gehört nur zu einer FUNKTION. Ein Anzeige-Gate
    // (gate: 'display') bündelt Werte, die immer wirken — dort gibt es nichts
    // zu schalten, nur etwas zu verstellen.
    if (BETA_FEATURES[key].gate === 'runtime') {
      assert.ok(own.some((f) => f.path.endsWith('.enabled')), `${key}: Ein/Aus-Schalter fehlt`);
    }
    const groups = new Set(own.map((f) => f.group));
    assert.equal(groups.size, 1, `${key}: Felder liegen in mehreren Gruppen (${[...groups].join(', ')})`);
    assert.ok(!['connection', 'general'].includes([...groups][0]),
      `${key}: liegt noch in einer allgemeinen Gruppe statt einer eigenen`);
  }
});

// Ein Anzeige-Gate darf NIE zur Laufzeit abgefragt werden: seine Werte sind
// Schutzwälle, das Ausblenden des Bedienfelds darf sie nicht abschalten.
// Christin, 29.07.2026: der EOS-Proxy war kurzzeitig runtime-gegated. Falsch —
// er IST die EOS-Anbindung, und das Flag wird an fünf Stellen gelesen, ein Gate
// an einer davon hätte einen Mischzustand erzeugt (Prognose-Push läuft,
// Planung nicht). Hier festgenagelt, damit es niemand zurückdreht.
test('der EOS-Proxy wird NICHT zur Laufzeit abgeschaltet', () => {
  assert.equal(BETA_FEATURES.eosProxy.gate, 'display');
  const cfgOn = { optimizer: { eosProxy: { enabled: true } } };
  assert.equal(resolveEosProxy({ ...cfgOn, updateChannel: 'stable' }).enabled, true,
    'eine eingerichtete EOS-Anlage muss auch im Stable-Kanal planen');
  assert.equal(resolveEosProxy({ ...cfgOn, updateChannel: 'dev' }).enabled, true);
  assert.equal(resolveEosProxy({ optimizer: { eosProxy: { enabled: false } } }).enabled, false);
  // Adresse und Zeitgrenze kommen trotzdem aus EINER Quelle.
  assert.equal(resolveEosProxy({}).url, 'http://127.0.0.1:8503');
  assert.equal(resolveEosProxy({}).timeoutMs, 30000);
});

test('Anzeige-Gates bleiben zur Laufzeit unangetastet', () => {
  for (const key of DISPLAY_KEYS) {
    assert.equal(betaGateOpen({ updateChannel: 'dev' }, key), false,
      `${key} ist ein Anzeige-Gate — betaGateOpen muss auch im dev-Kanal false liefern, `
      + 'damit niemand versehentlich eine Schutzfunktion daran aufhängt');
  }
  assert.ok(DISPLAY_KEYS.length > 0, 'es gibt überhaupt ein Anzeige-Gate');
  assert.ok(RUNTIME_KEYS.length >= 3);
});

test('jedes als beta markierte Einstellungsfeld gehört zu einem registrierten Feature', () => {
  const FIELD_DEFINITIONS = getConfigDefinition().fields;
  const marked = FIELD_DEFINITIONS.filter((f) => f.beta === true && f.path);
  assert.ok(marked.length > 0, 'es gibt überhaupt beta-markierte Felder');
  for (const field of marked) {
    assert.ok(
      betaFeatureForPath(field.path),
      `${field.path} ist als beta markiert, gehört aber zu keinem Feature in BETA_FEATURES — `
      + 'das Feld wäre versteckt, das Verhalten aber ungegatet'
    );
  }
});

test('umgekehrt: jedes GUI-Feld eines Beta-Features ist auch als beta markiert', () => {
  for (const field of getConfigDefinition().fields) {
    if (!field.path || !betaFeatureForPath(field.path)) continue;
    assert.equal(
      field.beta, true,
      `${field.path} gehört zu einem Beta-Feature, ist aber nicht als beta markiert — `
      + 'das Feld erschiene im Stable-Kanal in den Einstellungen'
    );
  }
});

// Der Kernvertrag, für JEDES registrierte Feature.
for (const key of RUNTIME_KEYS) {
  const feature = BETA_FEATURES[key];
  test(`${feature.label}: enabled:true bleibt im Stable-Kanal wirkungslos`, () => {
    const entry = RESOLVERS[key];
    assert.ok(entry, `für ${key} fehlt ein Eintrag in RESOLVERS — Gate ungeprüft`);

    const stable = entry.resolve({ ...entry.configWithFlagOn, updateChannel: 'stable' });
    assert.equal(stable.enabled, false, 'im Stable-Kanal AUS, trotz enabled:true in der Config');

    const noChannel = entry.resolve({ ...entry.configWithFlagOn });
    assert.equal(noChannel.enabled, false, 'ohne gesetzten Kanal ebenfalls AUS (stable ist der Default)');

    const dev = entry.resolve({ ...entry.configWithFlagOn, updateChannel: 'dev' });
    assert.equal(dev.enabled, true, 'im Bleeding-Edge-Kanal läuft der Feldtest');
  });

  test(`${feature.label}: im dev-Kanal bleibt ein ausdrückliches AUS ein AUS`, () => {
    const entry = RESOLVERS[key];
    const off = JSON.parse(JSON.stringify(entry.configWithFlagOn));
    for (const prefix of feature.paths) {
      const parts = prefix.split('.');
      let node = off;
      for (const part of parts) node = node[part];
      node.enabled = false;
    }
    assert.equal(entry.resolve({ ...off, updateChannel: 'dev' }).enabled, false);
  });
}

test('Einstellungsseite blendet beta-Felder außerhalb des dev-Kanals aus', () => {
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

  const isFieldVisible = sandbox.isFieldVisible;
  assert.equal(typeof isFieldVisible, 'function');
  // `currentEffectiveConfig` ist ein `let` im Skript und damit von außen nicht
  // setzbar; die Sichtbarkeit fragt aber alles über getVisibilityValue() ab —
  // eine Funktionsdeklaration und deshalb überschreibbar.
  const withChannel = (channel) => {
    sandbox.getVisibilityValue = (p) => (p === 'updateChannel' ? channel : undefined);
  };
  const field = { path: 'victron.freezeWatchdog.enabled', type: 'boolean', beta: true };
  const normal = { path: 'victron.host', type: 'text' };

  withChannel('stable');
  assert.equal(isFieldVisible(field), false, 'stable: versteckt');
  assert.equal(isFieldVisible(normal), true, 'normale Felder bleiben sichtbar');

  withChannel('dev');
  assert.equal(isFieldVisible(field), true, 'dev: sichtbar');
  assert.equal(isFieldVisible(normal), true);

  withChannel(undefined);
  assert.equal(isFieldVisible(field), false, 'ohne Kanal-Angabe versteckt');
});
