import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageGuard, storageLevel, nextKeepDays, compressionWarningText, tuningCompressionIssue, COMPRESSION_WARNING_ID } from '../services/storage-guard.js';

test('Stufen und Aufbewahrungsschritte', () => {
  assert.equal(storageLevel(50), 'ok');
  assert.equal(storageLevel(15), 'knapp');
  assert.equal(storageLevel(8), 'wenig');
  assert.equal(storageLevel(3), 'kritisch');
  assert.equal(nextKeepDays(500), 365);
  assert.equal(nextKeepDays(200), 180);
  assert.equal(nextKeepDays(45), 30);
  assert.equal(nextKeepDays(25), null, 'die letzten 30 Tage bleiben immer');
});

// Attrappe einer Community-Box (Standard) bzw. — per Option — Apache, ohne Kompression usw.
function fakeDb({ ts = true, oldestDays = 500, aggUntil = '2026-09-30T00:00:00Z', license = 'timescale', hypertable = true,
  compressionOn = true, policies = 1, failing = null, compressThrows = null, dropThrows = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, p) {
      calls.push([sql.replace(/\s+/g, ' ').trim(), p]);
      if (sql.includes('pg_database_size')) return { rows: [{ b: 2 * 1048576 * 1024 }] };
      if (sql.includes('pg_extension')) return { rows: ts ? [{}] : [] };
      if (sql.includes("current_setting('timescaledb.license'")) return { rows: [{ lic: license }] };
      if (sql.includes('timescaledb_information.hypertables')) {
        return { rows: hypertable ? [{ on: compressionOn, policies: String(policies), failing }] : [] };
      }
      if (sql.includes('compress_chunk')) {
        if (compressThrows) throw new Error(compressThrows);
        return { rows: [{ n: 3 }] };
      }
      if (sql.includes('drop_chunks') && dropThrows) throw new Error(dropThrows);
      if (sql.includes('/ 86400 AS d')) return { rows: [{ d: oldestDays }] };
      // Datenstufen (telemetry-tiers.js): bis aggUntil sind 1-min- und 15-min-Werte vollständig.
      if (sql.includes('FROM telemetry_tier_state s')) {
        return { rows: aggUntil ? [{ done_until: aggUntil, started_from: '2024-01-01T00:00:00Z', updated_at: null, dirty_from: null, dirty_n: 0 }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
// Warten, bis ein im Hintergrund angestoßener Lauf fertig ist.
async function settled(g) {
  for (let i = 0; i < 200 && !g.status()?.actions; i++) await new Promise((r) => setTimeout(r, 5));
  return g.status();
}
const stat = (freePct) => () => ({ blocks: 1000, bsize: 1048576 * 3, bavail: Math.round(10 * freePct) });

test('Genug Platz: nichts anfassen, kein Hinweis', async () => {
  const db = fakeDb(); const warn = {};
  const g = createStorageGuard({ getDb: () => db, statfs: stat(40), setWarning: (id, m) => { warn[id] = m; } });
  const r = await g.check();
  assert.equal(r.level, 'ok');
  assert.ok(!db.calls.some(([s]) => /compress_chunk|drop_chunks|DELETE/.test(s)));
  assert.equal(warn.storage, null);
});

test('Knapp: nur früher komprimieren', async () => {
  const db = fakeDb(); const warn = {};
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(15), setWarning: (id, m) => { warn[id] = m; } }).check();
  assert.deepEqual(r.actions.map((a) => a.action), ['compress']);
  assert.ok(!db.calls.some(([s]) => /drop_chunks/.test(s)));
  assert.match(warn.storage, /knapp/);
});

// Seit Schritt 3 (Konzept 23.11.): Notfall-Löschen erst bei „kritisch“, bei „wenig“ greift das härtere Profil.
test('Kritisch: eine Stufe Rohwerte weg, nie jünger als die 15-min-Werte', async () => {
  const db = fakeDb({ oldestDays: 500, aggUntil: '2025-01-01T00:00:00Z' }); const warn = {};
  const NOW = Date.parse('2026-10-01T12:00:00Z');
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(3), now: () => NOW, setWarning: (id, m) => { warn[id] = m; } }).check();
  const drop = r.actions.find((a) => a.action === 'drop_raw');
  assert.equal(drop.keepDays, 365);
  assert.equal(drop.before, '2025-01-01T00:00:00.000Z', 'begrenzt durch den letzten verdichteten Slot');
  assert.match(warn.storage, /älter als 365 Tage/);
  const seq = db.calls.map(([q]) => q.split(' ').slice(0, 3).join(' '));
  const b = seq.indexOf('BEGIN');
  assert.ok(seq[b + 1].startsWith('CREATE TEMP TABLE'), 'Preise/Altdaten zuerst sichern');
  assert.match(db.calls[b + 1][0], /scope <> 'live' OR series_key LIKE 'price%'/);
  assert.ok(seq[b + 2].startsWith('SELECT drop_chunks'));
  assert.ok(seq[b + 3].startsWith('INSERT INTO timeseries_samples'));
  assert.equal(seq[b + 4], 'COMMIT');
});

test('Ohne TimescaleDB: in Portionen löschen', async () => {
  const db = fakeDb({ ts: false, oldestDays: 100 });
  await createStorageGuard({ getDb: () => db, statfs: stat(3), now: () => Date.parse('2026-10-01T00:00:00Z') }).check();
  assert.ok(db.calls.some(([s]) => /DELETE FROM timeseries_samples WHERE ctid IN/.test(s)));
  assert.ok(!db.calls.some(([s]) => /compress_chunk/.test(s)));
});

test('6c: storage_guard_error wird gedrosselt (gleicher Fehler nicht in jedem Zyklus)', async () => {
  const logs = [];
  let t = 1_000_000;
  const g = createStorageGuard({
    getDb: () => { throw new Error('TimescaleDB-Apache nicht erreichbar'); },
    statfs: () => ({ bsize: 4096, blocks: 1000, bavail: 500 }),
    pushLog: (event, data, level) => logs.push({ event, data, level }),
    now: () => t,
  });
  await g.check();
  await g.check(); // gleicher Fehler, gleiche Zeit → nur einmal
  t += 10 * 60_000; // 10 min später → immer noch gedrosselt (<1 h)
  await g.check();
  assert.equal(logs.filter((l) => l.event === 'storage_guard_error').length, 1);
  t += 3600_001; // über 1 h → wieder einmal
  await g.check();
  assert.equal(logs.filter((l) => l.event === 'storage_guard_error').length, 2);
});

// ── 23.11.2026: Kundenfall 12-GB-Platte, Apache-Edition (S12/S13) ──────────────
const APACHE_ERR = 'function "compress_chunk" is not supported under the current "apache" license';

test('Apache, kritisch wenig Platz: kein compress_chunk-Abbruch — Hinweis steht und eine Stufe Rohwerte geht per drop_chunks', async () => {
  // Echte Apache-Box: compress_chunk wirft genau diesen Fehler (im Image timescale/timescaledb:2.30.2-pg17
  // mit timescaledb.license=apache nachgestellt), drop_chunks geht.
  const db = fakeDb({ license: 'apache', compressThrows: APACHE_ERR, oldestDays: 500, aggUntil: '2026-09-30T00:00:00Z' });
  const warn = {}; const sev = {}; const logs = [];
  const NOW = Date.parse('2026-11-23T12:00:00Z');
  const r = await createStorageGuard({
    getDb: () => db, statfs: stat(3), now: () => NOW,
    setWarning: (id, m, s) => { warn[id] = m; sev[id] = s; },
    pushLog: (e, d, l) => logs.push({ e, d, l }),
  }).check();
  assert.equal(r.level, 'kritisch');
  assert.ok(!db.calls.some(([s]) => /compress_chunk/.test(s)), 'unter Apache nicht komprimieren');
  const drop = r.actions.find((a) => a.action === 'drop_raw');
  assert.ok(drop && !drop.error, `Rohwerte entfernt: ${JSON.stringify(r.actions)}`);
  assert.equal(drop.keepDays, 365);
  assert.ok(db.calls.some(([s]) => /SELECT drop_chunks/.test(s)), 'drop_chunks geht auch unter Apache');
  assert.match(warn.storage, /Speicher kritisch/);
  assert.match(warn.storage, /älter als 365 Tage/);
  assert.match(warn[COMPRESSION_WARNING_ID], /Datenbank ohne Kompression/);
  assert.match(warn[COMPRESSION_WARNING_ID], /Apache/);
  assert.equal(sev[COMPRESSION_WARNING_ID], 'error', 'rot');
  assert.equal(r.compression.ok, false);
  assert.equal(r.compression.reason, 'apache');
  assert.ok(logs.some((l) => l.e === 'storage_compression_failed'), 'Eintrag fürs Installateur-Portal (…_failed)');
});

test('compress_chunk wirft (auch wenn eingeschaltet): Löschstufe und Hinweise laufen trotzdem', async () => {
  const db = fakeDb({ compressThrows: 'kaputt', oldestDays: 200 });
  const warn = {};
  const r = await createStorageGuard({
    getDb: () => db, statfs: stat(3), now: () => Date.parse('2026-11-23T12:00:00Z'),
    setWarning: (id, m) => { warn[id] = m; },
  }).check();
  assert.equal(r.level, 'kritisch');
  assert.ok(r.actions.find((a) => a.action === 'compress')?.error, 'Fehler steht in den Maßnahmen');
  assert.ok(r.actions.find((a) => a.action === 'drop_raw' && !a.error), 'trotzdem gelöscht');
  assert.match(warn.storage, /Speicher kritisch/);
  assert.match(warn[COMPRESSION_WARNING_ID], /Komprimieren ist gescheitert/);
});

test('compress_chunk-Fehler bleibt stehen, bis es wieder klappt (kein Flattern alle 30 min)', async () => {
  let throws = 'kaputt';
  const db = fakeDb({ oldestDays: 20 });
  const orig = db.query.bind(db);
  db.query = async (sql, p) => { if (sql.includes('compress_chunk') && throws) throw new Error(throws); return orig(sql, p); };
  const warn = {}; const logs = [];
  const g = createStorageGuard({ getDb: () => db, statfs: stat(15), setWarning: (id, m) => { warn[id] = m; }, pushLog: (e) => logs.push(e) });
  await g.check();
  await g.check();
  assert.match(warn[COMPRESSION_WARNING_ID], /gescheitert/);
  assert.equal(logs.filter((e) => e === 'storage_compression_failed').length, 1, 'nur einmal gemeldet');
  assert.ok(!logs.includes('storage_compression_ok'));
  throws = null;
  await g.check();
  assert.equal(warn[COMPRESSION_WARNING_ID], null, 'nach Erfolg weg');
});

test('drop_chunks scheitert: Hinweis steht trotzdem, Fehler in den Maßnahmen', async () => {
  const db = fakeDb({ dropThrows: 'Sperre', oldestDays: 500 });
  const warn = {};
  const r = await createStorageGuard({
    getDb: () => db, statfs: stat(3), now: () => Date.parse('2026-11-23T12:00:00Z'),
    setWarning: (id, m) => { warn[id] = m; },
  }).check();
  assert.ok(r.actions.find((a) => a.action === 'drop_raw')?.error);
  assert.match(warn.storage, /Speicher kritisch/);
  assert.ok(db.calls.some(([s]) => s === 'ROLLBACK'));
});

test('Ohne Kompression bei genug Platz: roter Hinweis trotzdem, nichts gelöscht', async () => {
  for (const [opts, re] of [
    [{ ts: false }, /TimescaleDB ist nicht installiert/],
    [{ license: 'apache' }, /Apache-Edition/],
    [{ hypertable: false }, /nicht für TimescaleDB eingerichtet/],
    [{ compressionOn: false }, /Kompression ist für die Messwerte ausgeschaltet/],
    [{ policies: 0 }, /automatische Kompression ist nicht eingerichtet oder pausiert/],
    [{ failing: true }, /scheitert seit mehreren Tagen/],
  ]) {
    const db = fakeDb(opts); const warn = {};
    const r = await createStorageGuard({ getDb: () => db, statfs: stat(60), setWarning: (id, m) => { warn[id] = m; } }).check();
    assert.equal(r.level, 'ok');
    assert.match(warn[COMPRESSION_WARNING_ID] || '', re, JSON.stringify(opts));
    assert.match(warn[COMPRESSION_WARNING_ID], /110–230 MB pro Tag/);
    assert.equal(warn.storage, null);
    assert.ok(!db.calls.some(([s]) => /compress_chunk/.test(s)));
    assert.ok(!r.actions.some((a) => a.action === 'drop_raw'), 'kein Notfall-Löschen');
    // E3 b (Christin 24.11.): kann gar nicht komprimiert werden → mindestens „winzig“
    // (Rohwerte 30 Tage, 1-min 90 Tage); sonst bleibt das Profil.
    const cannot = !(opts.policies === 0 || opts.failing);
    assert.equal(r.profile.effective, cannot ? 'winzig' : 'gross', JSON.stringify(opts));
    if (!cannot) assert.ok(!db.calls.some(([s]) => /drop_chunks|DELETE/.test(s)));
  }
});

test('Community mit Kompression: kein Hinweis „ohne Kompression“', async () => {
  const db = fakeDb(); const warn = {}; const logs = [];
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(60), setWarning: (id, m) => { warn[id] = m; }, pushLog: (e) => logs.push(e) }).check();
  assert.equal(warn[COMPRESSION_WARNING_ID], null);
  assert.equal(r.compression.ok, true);
  assert.ok(!logs.includes('storage_compression_failed'));
});

test('Portal-Eintrag nur bei Änderung und höchstens einmal am Tag', async () => {
  let t = Date.parse('2026-11-23T00:00:00Z');
  const db = fakeDb({ license: 'apache' }); const logs = [];
  const g = createStorageGuard({ getDb: () => db, statfs: stat(60), now: () => t, pushLog: (e) => logs.push(e) });
  await g.check(); t += 30 * 60_000; await g.check();
  assert.equal(logs.filter((e) => e === 'storage_compression_failed').length, 1);
  t += 24 * 3600_000; await g.check();
  assert.equal(logs.filter((e) => e === 'storage_compression_failed').length, 2);
});

test('checkCompression: Ergebnis von tuneTimescale wird nicht mehr verschluckt', async () => {
  const db = fakeDb({ compressionOn: false }); const warn = {};
  const g = createStorageGuard({
    getDb: () => db, statfs: stat(60), setWarning: (id, m) => { warn[id] = m; },
    getTuning: () => ({ error: 'permission denied for table timeseries_samples' }),
  });
  await g.checkCompression();
  assert.match(warn[COMPRESSION_WARNING_ID], /ausgeschaltet \(permission denied/);
  // Probe nicht möglich → der von tuneTimescale gemeldete Grund gilt.
  const broken = { query: async () => { throw new Error('weg'); } }; const w2 = {};
  await createStorageGuard({ getDb: () => broken, setWarning: (id, m) => { w2[id] = m; }, getTuning: () => ({ skipped: 'apache' }) }).checkCompression();
  assert.match(w2[COMPRESSION_WARNING_ID], /Apache/);
});

test('tuningCompressionIssue und Hinweistext', () => {
  assert.equal(tuningCompressionIssue({ changed: [], compressAfter: '2 days' }), null);
  assert.equal(tuningCompressionIssue({ skipped: 'apache' }).reason, 'apache');
  assert.equal(tuningCompressionIssue({ deferred: 'compression_lock_timeout' }).reason, 'not_enabled');
  assert.equal(tuningCompressionIssue({ error: 'x' }).reason, 'tuning_error');
  const nativ = compressionWarningText({ reason: 'apache', provision: { result: 'apache', at: '2026-11-20T03:00:00Z', error: 'Community-Paket nicht installierbar' } });
  assert.match(nativ, /bei jedem Update und Neustart automatisch, auf die TimescaleDB-Community-Edition umzustellen/);
  assert.match(nativ, /Der letzte Versuch am 20\.11\.2026 ist gescheitert: Community-Paket nicht installierbar/);
  assert.match(nativ, /Support/);
  const docker = compressionWarningText({ reason: 'no_hypertable', container: true });
  assert.doesNotMatch(docker, /Update und Neustart/);
  assert.match(docker, /Support/);
});

test('Statusdatei der Nachrüstung (nativ) fließt in den Hinweis ein', async () => {
  const db = fakeDb({ license: 'apache' }); const warn = {};
  await createStorageGuard({
    getDb: () => db, statfs: stat(60), getDataDir: () => '/daten', setWarning: (id, m) => { warn[id] = m; },
    readFile: (p) => {
      assert.equal(p, '/daten/timescale-status.json');
      return JSON.stringify({ edition: 'apache', provision: { result: 'apache', at: '2026-11-22T01:00:00Z', error: 'kein Paket für forky' } });
    },
  }).check();
  assert.match(warn[COMPRESSION_WARNING_ID], /am 22\.11\.2026 ist gescheitert: kein Paket für forky/);
});

// Codex 949b20f2 (P2): ein pausierter Job (alter_job scheduled => false) zählt nicht als Regel.
test('Probe zählt nur eingeplante Kompressions-Jobs', async () => {
  const db = fakeDb();
  await createStorageGuard({ getDb: () => db, statfs: stat(60) }).checkCompression();
  const q = db.calls.find(([s]) => s.includes('timescaledb_information.hypertables'))[0];
  assert.equal((q.match(/AND j\.scheduled/g) || []).length, 2, 'Regel und Fehler-Prüfung nur für eingeplante Jobs');
});

// Codex 949b20f2 (P2): nach einem Scheitern bei wenig Platz, dann wieder genug Platz → Hinweis weg.
test('compress_chunk-Fehler verfällt, sobald wieder genug Platz ist (der Job komprimiert)', async () => {
  const db = fakeDb({ compressThrows: 'Sperre', oldestDays: 20 });
  let pct = 15; const warn = {};
  const g = createStorageGuard({ getDb: () => db, statfs: () => stat(pct)(), setWarning: (id, m) => { warn[id] = m; } });
  await g.check();
  assert.match(warn[COMPRESSION_WARNING_ID], /gescheitert/);
  pct = 60;
  const r = await g.check();
  assert.equal(r.level, 'ok');
  assert.equal(warn[COMPRESSION_WARNING_ID], null);
});

// ── Schritt 3: Speicherprofil ────────────────────────────────────────────────
test('Wenig: kein Notfall-Löschen, Profil vorübergehend eine Stufe härter (S2 a), DB-Regeln umgestellt', async () => {
  const db = fakeDb({ oldestDays: 500 }); const warn = {}; const changes = [];
  const r = await createStorageGuard({
    getDb: () => db, statfs: stat(8), setWarning: (id, m) => { warn[id] = m; },
    onProfileChange: (p, info) => changes.push([p.name, info.from]),
  }).check();
  assert.equal(r.level, 'wenig');
  assert.ok(!r.actions.some((a) => a.action === 'drop_raw'), 'kein Notfall-Löschen bei „wenig“');
  assert.equal(r.profile.base, 'gross', 'Bestandsbox (500 Tage Messwerte) bleibt beim bisherigen Verhalten');
  assert.equal(r.profile.effective, 'mittel');
  assert.equal(r.profile.temporary, true);
  assert.deepEqual(changes, [['mittel', 'gross']]);
  assert.match(warn.storage, /Speicherprofil vorübergehend „mittel“/);
});

test('Neuinstallation auf kleiner Platte: Profil automatisch, Rohwerte nach Profil (über den verdichteten Stand)', async () => {
  // 12-GB-Platte, viel frei, Messwerte erst seit 1 Tag → Neuinstallation → „klein“.
  const big = () => ({ blocks: 12 * 1024, bsize: 1048576, bavail: 10 * 1024 });
  const files = {};
  const io = { writeFile: (f, d) => { files[f] = d; }, rename: (a, b) => { files[b] = files[a]; delete files[a]; } };
  const db = fakeDb({ oldestDays: 1 }); const changes = [];
  const g = createStorageGuard({
    getDb: () => db, statfs: big, getDataDir: () => '/d', profileIo: io, samplesIo: { ...io, readFile: () => { throw new Error('x'); } },
    readFile: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; },
    onProfileChange: (p) => changes.push(p.name),
  });
  const r = await g.check();
  assert.equal(r.level, 'ok');
  assert.deepEqual([r.profile.mode, r.profile.origin, r.profile.effective], ['auto', 'install', 'klein']);
  assert.deepEqual(changes, ['klein']);
  const saved = JSON.parse(files['/d/storage-profile.json']);
  assert.equal(saved.effective, 'klein', 'für pg-write-tuning.sh / storage-limits.sh');
  assert.ok(!r.actions.some((a) => a.action === 'retain_raw'), 'nichts älter als 365 Tage');
});

test('Profil „winzig“: Rohwerte älter als 30 Tage gehen, nie jünger als der verdichtete Stand, einmal am Tag', async () => {
  let t = Date.parse('2026-11-23T12:00:00Z');
  const db = fakeDb({ oldestDays: 90, aggUntil: '2026-11-01T00:00:00Z' });
  const g = createStorageGuard({ getDb: () => db, statfs: stat(60), now: () => t, initialProfile: 'winzig',
    profileIo: { writeFile() {}, rename() {} } });
  // Gespeicherter Stand: fest „winzig“ — die Wahl stößt selbst einen Lauf an.
  g.chooseProfile('winzig');
  const r = await settled(g);
  const ret = r.actions.find((a) => a.action === 'retain_raw');
  assert.equal(ret.keepDays, 30);
  assert.equal(ret.before, '2026-10-24T12:00:00.000Z');
  t += 30 * 60_000;
  const r2 = await g.check();
  assert.ok(!r2.actions.some((a) => a.action === 'retain_raw'), 'höchstens einmal am Tag');
});

test('Profilwahl per Klick: „auto“ übernimmt den Vorschlag', async () => {
  const db = fakeDb({ oldestDays: 500 });
  const big = () => ({ blocks: 12 * 1024, bsize: 1048576, bavail: 10 * 1024 });
  const g = createStorageGuard({ getDb: () => db, statfs: big });
  const r1 = await g.check();
  assert.deepEqual([r1.profile.effective, r1.profile.suggested], ['gross', 'klein']);
  g.chooseProfile('auto');
  const r2 = await g.check();
  assert.deepEqual([r2.profile.effective, r2.profile.mode, r2.profile.suggested], ['klein', 'auto', null]);
});

// Codex 837ea5fd (P2): Platz unbekannt (statfs scheitert) belegt keine Erholung.
test('compress_chunk-Fehler bleibt, wenn der Platz nicht messbar ist', async () => {
  const db = fakeDb({ compressThrows: 'Sperre', oldestDays: 20 });
  let fail = false; const warn = {};
  const g = createStorageGuard({ getDb: () => db, statfs: () => { if (fail) throw new Error('weg'); return stat(15)(); }, setWarning: (id, m) => { warn[id] = m; } });
  await g.check();
  fail = true;
  const r = await g.check();
  assert.equal(r.level, 'unbekannt');
  assert.match(warn[COMPRESSION_WARNING_ID], /gescheitert/);
});

// ── Schritt 4: Meldungen ab „wenig“ (S11 a) ──────────────────────────────────
test('Push und Portal-Eintrag einmal je Wechsel nach oben ab „wenig“', async () => {
  let pct = 15; const sent = []; const logs = [];
  const db = fakeDb({ oldestDays: 20 });
  const g = createStorageGuard({ getDb: () => db, statfs: () => stat(pct)(), notify: (m) => sent.push(m), pushLog: (e, d, l) => logs.push({ e, l }) });
  await g.check();                       // knapp
  assert.equal(sent.length, 0, 'knapp: kein Push');
  pct = 8; await g.check();              // wenig
  assert.equal(sent.length, 1);
  assert.equal(sent[0].level, 'warning');
  assert.match(sent[0].title, /Speicher wenig/);
  assert.match(sent[0].body, /Speicher wenig: 8 % frei/);
  await g.check();                       // bleibt wenig
  assert.equal(sent.length, 1, 'nicht wiederholt');
  pct = 3; await g.check();              // kritisch
  assert.equal(sent.length, 2);
  assert.equal(sent[1].level, 'critical');
  const portal = logs.filter((x) => x.e === 'storage_space_error');
  assert.equal(portal.length, 2, '…_error → Fehlerweg ans Installateur-Portal');
  assert.equal(portal[1].l, 'error');
});

test('DB-Aufteilung für die Karte', async () => {
  const db = fakeDb();
  const orig = db.query.bind(db);
  db.query = async (sql, p) => {
    if (sql.includes('timeseries_samples_1m')) return { rows: [{ b: 100 * 1048576 }] };
    if (sql.includes('timeseries_samples_15m')) return { rows: [{ b: 10 * 1048576 }] };
    if (sql.includes('hypertable_size')) return { rows: [{ b: 2 * 1048576 * 1024 }] };
    if (sql.includes('chunk_compression_stats')) return { rows: [{ c: 116, n: 120, b: 41 * 1048576 * 1024, a: 1283 * 1048576 }] };
    if (sql.includes('pg_total_relation_size(c.oid)')) return { rows: [{ t: 'energy_slots_15m', b: 305 * 1048576 }] };
    return orig(sql, p);
  };
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(60) }).check();
  assert.deepEqual(r.db, { samplesMb: 2048, compressedChunks: 116, chunks: 120, rawBeforeMb: 41984, rawAfterMb: 1283, tables: { energy_slots_15m: 305, timeseries_samples_1m: 100, timeseries_samples_15m: 10 } });
});

// Codex 2ef7ff2c (P2): Log-Aufbewahrung sieht beim Stufenwechsel schon die NEUE Stufe.
test('onStageChange: status() liefert bereits die neue Stufe', async () => {
  const seen = [];
  const db = fakeDb({ oldestDays: 20 });
  const g = createStorageGuard({ getDb: () => db, statfs: stat(8), onStageChange: () => seen.push(g.status()?.level) });
  await g.check();
  assert.deepEqual(seen, ['wenig']);
});

// Codex 2ef7ff2c (P2): die vorübergehend härtere Stufe darf die Reserve nicht verschieben (kein Schaukeln).
test('Stufe schaukelt nicht zwischen zwei Läufen (Reserve nach gespeichertem Profil)', async () => {
  // 30 000 MiB, 2050 MiB frei, Wachstum 10 MiB/Tag (Beispiel aus der Gegenprüfung).
  const disk = () => ({ blocks: 30000, bsize: 1048576, bavail: 2050 });
  const used = 30000 - 2050;
  const files = { '/d/storage-samples.json': JSON.stringify({ samples: [{ day: '2026-11-16', used: { data: used - 70 } }] }) };
  const io = { writeFile: (f, d) => { files[f] = d; }, rename: (a, b) => { files[b] = files[a]; delete files[a]; }, readFile: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; } };
  const db = fakeDb({ oldestDays: 500 });
  const g = createStorageGuard({ getDb: () => db, statfs: disk, getDataDir: () => '/d', samplesIo: io, profileIo: io, readFile: io.readFile,
    now: () => Date.parse('2026-11-23T12:00:00Z') });
  const levels = [];
  for (let i = 0; i < 4; i++) levels.push((await g.check()).level);
  assert.equal(new Set(levels).size, 1, levels.join(' → '));
});

// Codex 33062ac7 (P1): gespeichertes „winzig“ + nicht messbare DB-Platte → keine Profil-Aufbewahrung.
test('DB-Platte nicht messbar: auch keine Aufbewahrung nach gespeichertem Profil', async () => {
  const statfs = (p) => { if (p.startsWith('/srv/pg')) throw new Error('EACCES'); return { bsize: 1048576, blocks: 30000, bavail: 20000 }; };
  const stat2 = (p) => { if (p.startsWith('/srv/pg')) throw new Error('EACCES'); return { dev: 1 }; };
  const db = fakeDb({ oldestDays: 90, aggUntil: '2026-11-20T00:00:00Z' });
  const r = await createStorageGuard({ getDb: () => db, getDataDir: () => '/d', getPgDataDir: async () => '/srv/pg/main', statfs, stat: stat2,
    initialProfile: 'winzig', readFile: (f) => { if (f.endsWith('storage-profile.json')) return JSON.stringify({ base: 'klein', mode: 'auto', effective: 'winzig' }); throw new Error('x'); },
    samplesIo: { readFile: () => { throw new Error('x'); }, writeFile() {}, rename() {} }, profileIo: { writeFile() {}, rename() {} } }).check();
  assert.equal(r.dbUnmeasured, true);
  assert.ok(!db.calls.some(([s]) => /drop_chunks|DELETE/.test(s)), 'nichts gelöscht');
});

// Codex 246e360a (P2): Wahl während eines laufenden Durchgangs wird danach sicher umgesetzt.
test('Profilwahl während eines laufenden Laufs: danach noch ein Lauf, Profil umgesetzt', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const db = fakeDb({ oldestDays: 500 });
  const orig = db.query.bind(db);
  let hold = true;
  db.query = async (sql, p) => { if (hold && sql.includes('pg_database_size')) { hold = false; await gate; } return orig(sql, p); };
  const changes = [];
  const g = createStorageGuard({ getDb: () => db, statfs: stat(60), onProfileChange: (p) => changes.push(p.name) });
  const first = g.check();                 // hängt in pg_database_size
  await new Promise((r) => setTimeout(r, 5));
  g.chooseProfile('klein');
  assert.equal(g.profile().base, 'klein', 'sofort im Status');
  release();
  await first;
  for (let i = 0; i < 200 && !changes.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(changes, ['klein'], 'nachgeholter Lauf setzt das Profil um');
});

// ── Folgeauftrag 24.11.: Datenstufen, 1-min-Aufbewahrung (D1 a), E3 b ──────────
test('Rohwerte nur bis aggregatedUntil; ohne Stufen-Stand nichts (auch im Notfall)', async () => {
  const none = fakeDb({ oldestDays: 500, aggUntil: null });
  const r = await createStorageGuard({ getDb: () => none, statfs: stat(3) }).check();
  assert.equal(r.level, 'kritisch');
  assert.ok(!none.calls.some(([s]) => /drop_chunks|DELETE/.test(s)), 'null = nichts löschen');
  const db = fakeDb({ oldestDays: 500, aggUntil: '2025-02-01T00:00:00Z' });
  const r2 = await createStorageGuard({ getDb: () => db, statfs: stat(3), now: () => Date.parse('2026-11-24T00:00:00Z') }).check();
  assert.equal(r2.actions.find((a) => a.action === 'drop_raw').before, '2025-02-01T00:00:00.000Z', 'nie jünger als die Stufen');
  assert.ok(!db.calls.some(([s]) => s.includes('FROM energy_slots_15m')), 'nicht mehr nach energy_slots_15m');
});

test('1-min-Stufe je Profil: groß nie, klein 365, winzig 180, ohne Kompression 90 Tage', async () => {
  const NOW = Date.parse('2026-11-24T12:00:00Z');
  for (const [profile, opts, keep] of [['gross', {}, null], ['klein', {}, 365], ['winzig', {}, 180], ['gross', { license: 'apache' }, 90]]) {
    const db = fakeDb({ oldestDays: 20, aggUntil: '2026-11-24T00:00:00Z', ...opts });
    const g = createStorageGuard({ getDb: () => db, statfs: stat(60), now: () => NOW, initialProfile: profile, profileIo: { writeFile() {}, rename() {} } });
    g.chooseProfile(profile);
    const r = await settled(g);
    const q = db.calls.find(([s]) => s.includes('drop_chunks(\'timeseries_samples_1m\'') || s.includes('DELETE FROM timeseries_samples_1m'));
    if (keep == null) { assert.equal(q, undefined, profile); continue; }
    assert.ok(q, `${profile}/${JSON.stringify(opts)}: 1-min gekürzt`);
    assert.equal(new Date(q[1][0]).toISOString(), new Date(Math.floor((NOW - keep * 86_400_000) / 900_000) * 900_000).toISOString());
    void r;
  }
});
