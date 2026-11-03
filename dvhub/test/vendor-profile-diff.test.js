// vendor-profile-diff: Migrations-Helfer für <name>.dist. classifyDiff() teilt in
// added/changed/removed; mergeAdditions() übernimmt NUR neue Felder, nie
// überschreibend (deine Anpassungen bleiben). Bildet das reale prod-Szenario ab
// (victron.json: alarms neu, broker/maxDischargeW = Operator-Edit).

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyDiff, mergeAdditions } from '../../scripts/vendor-profile-diff.mjs';

test('classifyDiff: added / changed / removed', () => {
  const active = { victron: { mqtt: { broker: 'mqtt://203.0.113.19:1883' } }, points: { maxDischargeW: { address: 2704 } } };
  const dist = { victron: { mqtt: { broker: 'mqtt://192.168.1.10:1883' }, alarms: { enabled: true, vebusUnitId: null } } };
  const { added, changed, removed } = classifyDiff(active, dist);
  assert.deepEqual(added.map((x) => x.path), ['victron.alarms.enabled', 'victron.alarms.vebusUnitId']);
  assert.deepEqual(changed.map((x) => x.path), ['victron.mqtt.broker']); // Operator-Edit
  assert.deepEqual(removed.map((x) => x.path), ['points.maxDischargeW.address']); // Operator-Zusatz
});

test('mergeAdditions adds ONLY new fields, never touching edited/existing ones', () => {
  const active = {
    victron: { mqtt: { broker: 'mqtt://203.0.113.19:1883' } },
    points: { maxDischargeW: { enabled: true, address: 2704 } }
  };
  const dist = {
    victron: { mqtt: { broker: 'mqtt://192.168.1.10:1883' }, alarms: { enabled: true, pollIntervalMs: 30000 } }
  };
  const { merged, addedTopLevel } = mergeAdditions(active, dist);
  // Neu übernommen:
  assert.deepEqual(merged.victron.alarms, { enabled: true, pollIntervalMs: 30000 });
  // Operator-Edits UNANGETASTET:
  assert.equal(merged.victron.mqtt.broker, 'mqtt://203.0.113.19:1883', 'broker-IP bleibt');
  assert.deepEqual(merged.points.maxDischargeW, { enabled: true, address: 2704 }, 'maxDischargeW bleibt');
  assert.ok(addedTopLevel.includes('victron.alarms'));
});

test('mergeAdditions is a no-op when dist adds nothing new', () => {
  const active = { victron: { mqtt: { broker: 'x' } } };
  const dist = { victron: { mqtt: { broker: 'y' } } }; // nur geändert, nichts neu
  const { merged, addedTopLevel } = mergeAdditions(active, dist);
  assert.deepEqual(merged, active, 'geänderte Werte werden NICHT übernommen');
  assert.deepEqual(addedTopLevel, []);
});

// Gegenprüfung zu ad70a264 (P3): das Werkzeug läuft als root im Ordner des
// Dienstbenutzers. Ein Verweis x.json → <fremde JSON-Datei> ließ es dort Felder
// hineinmischen (writeFileSync folgte dem Verweis) und den fremden Inhalt
// anzeigen und als .bak in den Ordner kopieren.
test('CLI: aktives Profil als Verweis → abgelehnt, Ziel unberührt', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'vendor-profile-diff.mjs');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vpdiff-')));
  try {
    const h = path.join(tmp, 'cfg', 'hersteller');
    fs.mkdirSync(h, { recursive: true });
    const victim = path.join(tmp, 'opfer.json');
    fs.writeFileSync(victim, '{"geheim":1}\n');
    fs.symlinkSync(victim, path.join(h, 'x.json'));
    fs.writeFileSync(path.join(h, 'x.json.dist'), '{"neu":2}\n');
    const r = spawnSync(process.execPath, [tool, 'x.json', '--apply-additions'], { encoding: 'utf8', env: { ...process.env, CONFIG_DIR: path.join(tmp, 'cfg') } });
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(fs.readFileSync(victim, 'utf8'), '{"geheim":1}\n');
    assert.doesNotMatch(r.stdout, /geheim/);
    assert.deepEqual(fs.readdirSync(h).filter((f) => f.includes('.bak-')), []);
    const traversal = spawnSync(process.execPath, [tool, '../opfer.json'], { encoding: 'utf8', env: { ...process.env, CONFIG_DIR: path.join(tmp, 'cfg') } });
    assert.equal(traversal.status, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI: echtes Profil → neue Felder übernommen, Sicherung angelegt', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'vendor-profile-diff.mjs');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vpdiff-')));
  try {
    const h = path.join(tmp, 'cfg', 'hersteller');
    fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(path.join(h, 'x.json'), '{"a":1}\n');
    fs.writeFileSync(path.join(h, 'x.json.dist'), '{"a":5,"b":2}\n');
    const r = spawnSync(process.execPath, [tool, 'x.json', '--apply-additions'], { encoding: 'utf8', env: { ...process.env, CONFIG_DIR: path.join(tmp, 'cfg') } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, 'x.json'), 'utf8')), { a: 1, b: 2 });
    assert.equal(fs.readdirSync(h).filter((f) => f.startsWith('x.json.bak-')).length, 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Gegenprüfung 1c0105a0 (2× P3): „nur anzeigen“ ersetzte einen Verweis
// hersteller/ still durch einen leeren Ordner; Schlüssel aus dem Ordner des
// Dienstbenutzers gingen mit Steuerzeichen roh ins Terminal von root.
test('CLI: nur anzeigen lässt einen Verweis hersteller/ stehen und legt nichts an', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'vendor-profile-diff.mjs');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vpdiff-')));
  try {
    const real = path.join(tmp, 'woanders');
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, 'x.json'), '{"a":1}\n');
    fs.writeFileSync(path.join(real, 'x.json.dist'), '{"a":1,"b":2}\n');
    fs.mkdirSync(path.join(tmp, 'cfg'));
    fs.symlinkSync(real, path.join(tmp, 'cfg', 'hersteller'));
    const r = spawnSync(process.execPath, [tool, 'x.json'], { encoding: 'utf8', env: { ...process.env, CONFIG_DIR: path.join(tmp, 'cfg') } });
    assert.notEqual(r.status, 0);
    assert.ok(fs.lstatSync(path.join(tmp, 'cfg', 'hersteller')).isSymbolicLink(), 'Verweis steht noch');
    const r2 = spawnSync(process.execPath, [tool, 'x.json'], { encoding: 'utf8', env: { ...process.env, CONFIG_DIR: path.join(tmp, 'leer') } });
    assert.notEqual(r2.status, 0);
    assert.equal(fs.existsSync(path.join(tmp, 'leer')), false, 'nichts angelegt');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI: Steuerzeichen in Schlüsseln werden maskiert ausgegeben', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'vendor-profile-diff.mjs');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vpdiff-')));
  try {
    const h = path.join(tmp, 'cfg', 'hersteller');
    fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(path.join(h, 'x.json'), '{"a":1}\n');
    fs.writeFileSync(path.join(h, 'x.json.dist'), JSON.stringify({ a: 1, '\u001b[2Kfake': 2 }));
    const r = spawnSync(process.execPath, [tool, 'x.json'], { encoding: 'utf8', env: { ...process.env, CONFIG_DIR: path.join(tmp, 'cfg') } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('\u001b'), 'kein rohes ESC');
    assert.match(r.stdout, /\\u001b\[2Kfake/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Gesamtprüfung 03.11.2026: auf Paket-Boxen ist /opt/dvhub/scripts ein
// Verweis auf current/scripts. Der alte Vergleich import.meta.url ===
// file://argv[1] schlug dort fehl (argv[1] behält den Verweis, import.meta.url
// zeigt aufs Ziel) — das Werkzeug lief still ins Leere.
test('CLI über einen verlinkten scripts-Ordner (Paket-Layout) läuft', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vpdiff-link-')));
  try {
    const h = path.join(tmp, 'cfg', 'hersteller');
    fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(path.join(h, 'x.json'), '{"a":1}\n');
    fs.writeFileSync(path.join(h, 'x.json.dist'), '{"a":1,"neu":2}\n');
    fs.mkdirSync(path.join(tmp, 'opt'));
    fs.symlinkSync(fs.realpathSync(scripts), path.join(tmp, 'opt', 'scripts'));
    const r = spawnSync(process.execPath, ['scripts/vendor-profile-diff.mjs', 'x.json'], { cwd: path.join(tmp, 'opt'), encoding: 'utf8', env: { ...process.env, CONFIG_DIR: path.join(tmp, 'cfg') } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Herstellerprofil x\.json/);
    assert.match(r.stdout, /\+ neu = 2/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
