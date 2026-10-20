// evcc als Fahrzeugtreiber (Christin 2026-10-20): Den Ladestand anderer Autos
// (VW, Kia, Renault, Mercedes …) holt DVhub über evccs Fahrzeug-Treiber —
// evcc ist MIT-lizenziert, die meisten Fahrzeug-Vorlagen brauchen keine
// evcc-Lizenz. DVhub liefert evcc NICHT im Image aus: es wird erst geladen,
// wenn jemand die Funktion einschaltet (feste Version, Prüfsumme), und fragt
// dann nur das Auto ab (`evcc vehicle`). Kunden richten alles in der
// Oberfläche ein.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  EVCC_VERSION, evccAsset, loadCatalog, validateVehicleSettings, buildEvccYaml, parseVehicleOutput,
  sha256File, createVehicleEvcc, maskVehicleSettings, mergeVehicleSettings,
} from '../services/vehicle-evcc/index.js';
import { resolveEvSocPct, EV_SOC_SOURCES } from '../services/optimizer/ev-soc.js';
import { createDefaultConfig, getConfigDefinition } from '../config-model.js';
import { REDACTED_PATHS } from '../config-redaction.js';

// Echte Ausgabe von `evcc vehicle` 0.317.2 (Testfahrzeug, 2026-10-20)
const SAMPLE = [
  '[main  ] INFO 2026/10/20 01:40:37 using config file: /cfg/evcc.yaml',
  'Soc:            55%        ',
  'Capacity:       50.0kWh    ',
  'Charge status:  B          ',
  'Range:          312km      ',
  'Odometer:       12345km    ',
].join('\n');

test('Ab Werk aus, feste evcc-Version, Programm für arm64/amd64/armv6 mit Prüfsumme', () => {
  const d = createDefaultConfig();
  assert.equal(d.vehicleEvcc.enabled, false);
  assert.equal(EVCC_VERSION, '0.317.2');
  for (const arch of ['arm64', 'x64', 'arm']) {
    const a = evccAsset('linux', arch);
    assert.match(a.url, /^https:\/\/github\.com\/evcc-io\/evcc\/releases\/download\/0\.317\.2\/evcc_0\.317\.2_linux-(arm64|amd64|armv6)\.tar\.gz$/);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(evccAsset('darwin', 'arm64'), null);
});

test('Katalog: Vorlagen mit Feldern, ohne Browser-Anmeldung und Sponsor-Pflicht', () => {
  const c = loadCatalog();
  assert.equal(c.evccVersion, EVCC_VERSION);
  const vw = c.templates.find((t) => t.template === 'vw');
  assert.deepEqual(vw.params.filter((p) => p.required).map((p) => p.name), ['user', 'password']);
  assert.ok(vw.params.find((p) => p.name === 'password').secret);
  for (const t of ['cardata', 'porsche', 'volvo-connected', 'tronity', 'teslamate']) {
    assert.ok(!c.templates.some((x) => x.template === t), `${t} ausgelassen`);
  }
  assert.ok(c.products.some((p) => p.name === 'Renault'));
});

test('Einstellungen prüfen: Vorlage bekannt, Pflichtfelder da, nur bekannte Felder', () => {
  const c = loadCatalog();
  assert.deepEqual(validateVehicleSettings({ template: 'vw', params: { user: 'a@b.de', password: 'x' } }, c), { ok: true, errors: [] });
  assert.match(validateVehicleSettings({ template: 'vw', params: { user: 'a@b.de' } }, c).errors.join(), /password/);
  assert.match(validateVehicleSettings({ template: 'gibtsnicht', params: {} }, c).errors.join(), /Vorlage/);
  assert.match(validateVehicleSettings({ template: 'cardata', params: {} }, c).errors.join(), /Vorlage/);
});

test('evcc.yaml: nur Felder der Vorlage, Werte sicher gequotet (keine YAML-Einschleusung)', () => {
  const c = loadCatalog();
  const y = buildEvccYaml({ template: 'vw', params: { user: 'a@b.de', password: 'p"w\nsite:\n  x: 1', vin: 'WVW1', fremd: 'weg' } }, c);
  assert.ok(y.startsWith('vehicles:\n  - name: dvhub\n    type: template\n    template: "vw"\n'));
  assert.ok(y.includes('    password: "p\\"w\\nsite:\\n  x: 1"\n'));
  assert.ok(!/fremd/.test(y));
  assert.ok(!/^site:/m.test(y));
});

test('Ausgabe von evcc vehicle auswerten', () => {
  const r = parseVehicleOutput(SAMPLE);
  assert.deepEqual(r.values, { socPct: 55, capacityKwh: 50, status: 'B', rangeKm: 312, odometerKm: 12345 });
  assert.deepEqual(r.errors, {});
  const e = parseVehicleOutput('Soc:            login failed: invalid credentials   \nRange:          312km');
  assert.equal(e.values.socPct, undefined);
  assert.match(e.errors.socPct, /login failed/);
  assert.equal(e.values.rangeKm, 312);
  assert.deepEqual(parseVehicleOutput('Soc:   80.5%\nLimit Soc:  90%').values, { socPct: 80.5, limitSocPct: 90 });
});

test('Geheimnisse: nie zurückgeben, leer/*** behält den alten Wert', () => {
  const c = loadCatalog();
  const stored = { enabled: true, template: 'vw', params: { user: 'a@b.de', password: 'geheim', vin: 'WVW1' }, intervalMin: 15 };
  const m = maskVehicleSettings(stored, c);
  assert.equal(m.params.password, '');
  assert.equal(m.secretsSet.password, true);
  assert.equal(m.params.user, 'a@b.de');
  const next = mergeVehicleSettings(stored, { template: 'vw', params: { user: 'neu@b.de', password: '***' } }, c);
  assert.equal(next.params.password, 'geheim');
  assert.equal(next.params.user, 'neu@b.de');
  assert.equal(next.params.vin, undefined, 'nicht mitgeschickt = gelöscht (außer Geheimnisse)');
  assert.ok(REDACTED_PATHS.includes('vehicleEvcc.params'), 'Konfig-Export schwärzt die Fahrzeugdaten');
});

test('Prüfsumme einer Datei', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evcc-sha-'));
  const f = path.join(dir, 'x');
  fs.writeFileSync(f, 'hallo');
  assert.equal(await sha256File(f), crypto.createHash('sha256').update('hallo').digest('hex'));
});

// ── Dienst mit nachgebautem evcc ──
function fakeEvcc(dir, body) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const bin = path.join(dir, 'bin', 'evcc');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

test('Dienst: Abfrage schreibt evcc.yaml (0600), ruft evcc vehicle, merkt Ladestand', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evcc-svc-'));
  const args = path.join(dir, 'args');
  const bin = fakeEvcc(dir, `echo "$@" > ${args}\ncat <<'EOF'\n${SAMPLE}\nEOF`);
  const cfg = { vehicleEvcc: { enabled: true, template: 'vw', params: { user: 'a@b.de', password: 'x' }, intervalMin: 15 } };
  const svc = createVehicleEvcc({ getCfg: () => cfg, pushLog: () => {} }, { dataDir: dir, binaryPath: bin, now: () => Date.parse('2026-10-20T10:00:00Z') });
  const r = await svc.refresh('test');
  assert.equal(r.ok, true);
  const st = svc.getState();
  assert.equal(st.socPct, 55);
  assert.equal(st.rangeKm, 312);
  assert.equal(st.at, '2026-10-20T10:00:00.000Z');
  const yamlFile = path.join(dir, 'evcc', 'evcc.yaml');
  assert.equal(fs.statSync(yamlFile).mode & 0o777, 0o600);
  const a = fs.readFileSync(args, 'utf8');
  assert.match(a, /^vehicle dvhub --config .*evcc\.yaml --database .*evcc\.db/);
});

test('Dienst: Anmeldefehler → Fehler gemeldet, alter Ladestand bleibt mit Zeitstempel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evcc-svc-'));
  let out = SAMPLE;
  const bin = fakeEvcc(dir, `cat ${path.join(dir, 'out')}`);
  fs.writeFileSync(path.join(dir, 'out'), out);
  let t = Date.parse('2026-10-20T10:00:00Z');
  const cfg = { vehicleEvcc: { enabled: true, template: 'vw', params: { user: 'a', password: 'x' } } };
  const svc = createVehicleEvcc({ getCfg: () => cfg, pushLog: () => {} }, { dataDir: dir, binaryPath: bin, now: () => t });
  await svc.refresh('test');
  out = 'Soc:            login failed: 401   ';
  fs.writeFileSync(path.join(dir, 'out'), out);
  t += 15 * 60_000;
  const r = await svc.refresh('test');
  assert.equal(r.ok, false);
  const st = svc.getState();
  assert.equal(st.socPct, 55, 'letzter gültiger Wert bleibt');
  assert.equal(st.at, '2026-10-20T10:00:00.000Z');
  assert.match(st.error, /login failed/);
});

test('Dienst: aus oder ungültig → keine Abfrage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evcc-svc-'));
  const bin = fakeEvcc(dir, 'echo "Soc: 50%"');
  const cfg = { vehicleEvcc: { enabled: false, template: 'vw', params: { user: 'a', password: 'x' } } };
  const svc = createVehicleEvcc({ getCfg: () => cfg, pushLog: () => {} }, { dataDir: dir, binaryPath: bin });
  assert.equal((await svc.refresh('test')).skipped, 'disabled');
  cfg.vehicleEvcc = { enabled: true, template: 'vw', params: {} };
  assert.match((await svc.refresh('test')).error, /password/);
});

// ── Ladestand-Quelle ──
test('Ladestand: neue Quelle „Fahrzeug über evcc-Treiber“, im Automatik-Modus nach Wallbox, vor MQTT', () => {
  assert.ok(EV_SOC_SOURCES.includes('evccvehicle'));
  const now = Date.now();
  const ctx = (src, extra = {}) => ({
    getCfg: () => ({ optimizer: { evSocSource: src } }),
    vehicleEvcc: { getState: () => ({ socPct: 63, at: new Date(now - 3600_000).toISOString() }) },
    vehicleMqtt: { getState: () => ({ socPct: 47 }) },
    ...extra,
  });
  assert.deepEqual(resolveEvSocPct(ctx('evccvehicle')), { pct: 63, source: 'evccvehicle' });
  assert.deepEqual(resolveEvSocPct(ctx('auto')), { pct: 63, source: 'evccvehicle' });
  const stale = ctx('evccvehicle', { vehicleEvcc: { getState: () => ({ socPct: 63, at: new Date(now - 30 * 3600_000).toISOString() }) } });
  assert.equal(resolveEvSocPct(stale), null, 'älter als 24 h zählt nicht');
  const opt = getConfigDefinition().fields.find((f) => f.path === 'optimizer.evSocSource');
  assert.ok(opt.options.some((o) => o.value === 'evccvehicle'));
});

// Echter Lauf im Linux-Container (2026-10-20): evcc setzt einen Fortschrittspunkt
// vor „Soc:“, und seine Fehlermeldungen enthalten die Abfrage-URL MIT Passwort.
test('Ausgabe: Fortschrittspunkt vor dem Feld wird erkannt', () => {
  const r = parseVehicleOutput('.Soc:           Get "https://x/api": no such host  3.003s  ');
  assert.match(r.errors.socPct, /no such host/);
});

test('Fehlermeldung: Zugangsdaten werden geschwärzt (UI und Protokoll)', async () => {
  const { scrubEvccError } = await import('../services/vehicle-evcc/index.js');
  const msg = 'Get "https://srv:6869/api/cookie?username=test&password=falsch&pin=1234": dial tcp: no such host';
  const out = scrubEvccError(msg, { template: 'ovms', params: { user: 'test', password: 'falsch', vehicleid: 'X' } });
  assert.ok(!/falsch/.test(out), out);
  assert.ok(!/1234/.test(out), out);
  assert.match(out, /no such host/);
});

test('Dienst: Fehlermeldung mit Passwort landet geschwärzt im Zustand und Protokoll', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evcc-svc-'));
  const bin = fakeEvcc(dir, `echo '.Soc:           Get "https://srv/api?username=a&password=geheim99": no such host  3.0s'`);
  const logs = [];
  const cfg = { vehicleEvcc: { enabled: true, template: 'vw', params: { user: 'a', password: 'geheim99' } } };
  const svc = createVehicleEvcc({ getCfg: () => cfg, pushLog: (...a) => logs.push(a) }, { dataDir: dir, binaryPath: bin });
  await svc.refresh('test');
  assert.match(svc.getState().error, /no such host/);
  assert.ok(!JSON.stringify(svc.getState()).includes('geheim99'));
  assert.ok(!JSON.stringify(logs).includes('geheim99'));
});
