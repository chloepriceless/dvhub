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
  compressionOn = true, policies = 1, failing = null, compressThrows = null, dropThrows = null, keepRows = true } = {}) {
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
      if (sql.includes('NOT is_compressed AND range_end')) return { rows: [{ c: 'a' }, { c: 'b' }, { c: 'c' }] };
      if (sql.includes('compress_chunk')) {
        if (compressThrows) throw new Error(compressThrows);
        return { rows: [{}] };
      }
      if (sql.includes('drop_chunks') && dropThrows) throw new Error(dropThrows);
      // pruneRawBefore: gibt es Preise/Altdaten vor der Grenze? (Standard: ja → Zwischenkopie)
      if (sql.includes("(scope <> 'live' OR series_key LIKE 'price%') LIMIT 1")) return { rows: keepRows ? [{}] : [] };
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
    const cannot = opts.ts === false || opts.license === 'apache' || opts.hypertable === false;   // dauerhaft (Codex f90b8e04)
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

// Codex f90b8e04 (P1): Profilwechsel stellt die DB um (Kompression wieder an) → vor dem Löschen neu prüfen.
test('Nach dem Profilwechsel neu prüfen: Kompression wieder da → kein Löschen nach „winzig“', async () => {
  let lic = 'apache';
  const db = fakeDb({ oldestDays: 500, aggUntil: '2026-11-20T00:00:00Z' });
  const orig = db.query.bind(db);
  db.query = async (sql, p) => (sql.includes("current_setting('timescaledb.license'") ? { rows: [{ lic }] } : orig(sql, p));
  const changes = [];
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(60),
    onProfileChange: (p) => { changes.push(p.name); lic = 'timescale'; } }).check();
  assert.deepEqual(changes, ['winzig', 'gross'], 'gleich wieder zurück');
  assert.equal(r.profile.effective, 'gross');
  assert.ok(!r.actions.some((a) => /retain/.test(a.action)), JSON.stringify(r.actions));
  assert.ok(!db.calls.some(([s]) => /drop_chunks|DELETE/.test(s)));
});

// E2E „kleine Platte“ S3 (24.11.): reines PostgreSQL — nach portionsweisem DELETE ein VACUUM, plus Hinweis.
test('Ohne TimescaleDB: nach dem Löschen VACUUM (ANALYZE), Hinweis auf VACUUM FULL, roter Kompressions-Hinweis', async () => {
  let deletes = 0;
  const db = fakeDb({ ts: false, oldestDays: 100 });
  const orig = db.query.bind(db);
  db.query = async (sql, p) => {
    if (sql.includes('DELETE FROM timeseries_samples')) { db.calls.push([sql.replace(/\s+/g, ' ').trim(), p]); deletes += 1; return { rowCount: deletes === 1 ? 50000 : 0, rows: [] }; }
    return orig(sql, p);
  };
  const warn = {};
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(3), now: () => Date.parse('2026-10-01T00:00:00Z'), setWarning: (id, m) => { warn[id] = m; } }).check();
  const calls = db.calls.map(([s]) => s);
  const iDel = calls.findIndex((s) => s.startsWith('DELETE FROM timeseries_samples'));
  const iVac = calls.indexOf('VACUUM (ANALYZE) timeseries_samples');
  assert.ok(iDel >= 0 && iVac > iDel, 'VACUUM nach dem Löschen');
  assert.ok(!calls.some((s) => /VACUUM FULL/.test(s)), 'nie automatisch VACUUM FULL');
  assert.ok(r.actions.some((a) => a.mode === 'delete' && a.vacuumed === true), JSON.stringify(r.actions));
  assert.match(warn.storage, /VACUUM FULL/);
  assert.match(warn[COMPRESSION_WARNING_ID], /TimescaleDB ist nicht installiert/);
});

test('Ohne gelöschte Zeilen kein VACUUM', async () => {
  const db = fakeDb({ ts: false, oldestDays: 100 });
  await createStorageGuard({ getDb: () => db, statfs: stat(3), now: () => Date.parse('2026-10-01T00:00:00Z') }).check();
  assert.ok(!db.calls.some(([s]) => /VACUUM/.test(s)));
});

// Codex 5ea1b282: „ausgeschaltet“ → Einrichtung stündlich neu anstoßen, ohne Profilwechsel.
test('Kompression ausgeschaltet: Einrichtung höchstens stündlich neu, Profil bleibt, nichts gelöscht', async () => {
  let t = Date.parse('2026-11-24T00:00:00Z'); let on = false; const calls = [];
  const db = fakeDb({ oldestDays: 500, aggUntil: '2026-11-20T00:00:00Z' });
  const orig = db.query.bind(db);
  db.query = async (sql, p) => (sql.includes('timescaledb_information.hypertables')
    ? { rows: [{ on, policies: '1', failing: null }] } : orig(sql, p));
  const g = createStorageGuard({ getDb: () => db, statfs: stat(60), now: () => t,
    onProfileChange: (p, info) => { calls.push([p.name, !!info.retune]); } });
  await g.check();
  assert.deepEqual(calls, [['gross', true]]);
  t += 30 * 60_000; await g.check();
  assert.equal(calls.length, 1, 'nicht alle 30 min');
  on = true; t += 31 * 60_000;
  const r = await g.check();
  assert.equal(r.compression.ok, true);
  assert.equal(r.profile.effective, 'gross');
  assert.ok(!db.calls.some(([s]) => /drop_chunks|DELETE/.test(s)));
});

// ── E2E „kleine Platte“ S4 (24.11.): Stufen noch nicht rückgefüllt (aggregatedUntil null), Platte kritisch ──
function s4Db({ aggregateFails = false, has15m = false, days = 45, tierUntil = null } = {}) {
  const NOW = Date.parse('2026-11-24T12:00:00Z');
  const state = { oldest: Math.floor((NOW - days * 86_400_000) / 86_400_000) * 86_400_000, calls: [] };
  const db = {
    calls: state.calls,
    async query(sql, p) {
      const s = sql.replace(/\s+/g, ' ').trim();
      state.calls.push([s, p]);
      if (s.includes('pg_database_size')) return { rows: [{ b: 1400 * 1048576 }] };
      if (s.includes('pg_extension')) return { rows: [{}] };
      if (s.includes("current_setting('timescaledb.license'")) return { rows: [{ lic: 'timescale' }] };
      if (s.includes('timescaledb_information.hypertables')) return { rows: [{ on: true, policies: '1', failing: null }] };
      if (s.includes('NOT c.is_compressed')) return { rows: [{ b: 40 * 1048576 }] };
      if (s.includes('FROM telemetry_tier_state s')) return { rows: [{ done_until: tierUntil, dirty_from: null, dirty_n: 0 }] };
      if (s.startsWith('SELECT min(ts_utc) AS t')) return { rows: [{ t: new Date(state.oldest) }] };
      if (s.includes('/ 86400 AS d')) return { rows: [{ d: (NOW - state.oldest) / 86_400_000 }] };
      if (s.includes('FROM timescaledb_information.chunks') && s.includes('range_start')) {
        return { rows: [{ range_start: new Date(state.oldest), range_end: new Date(state.oldest + 86_400_000) }] };
      }
      // has15mFor: fehlende Viertelstunden (0 = vollständig abgedeckt)
      if (s.includes('AS missing')) return { rows: [{ missing: has15m ? 0 : 5 }] };
      if (s.includes("(scope <> 'live' OR series_key LIKE 'price%') LIMIT 1")) return { rows: [] };
      if (s.startsWith('SELECT drop_chunks')) { state.oldest += 86_400_000; state.freed = (state.freed || 0) + 31; return { rows: [] }; }
      if (s.includes('compress_chunk')) throw new Error('could not extend file: No space left on device');
      return { rows: [], rowCount: 0 };
    },
  };
  const aggregated = [];
  const aggregateRange = async (a, b) => { if (aggregateFails) throw new Error('aggregate: No space left on device'); aggregated.push([a, b]); return 1440; };
  // 4-GB-Platte, 93 MB frei; jeder gelöschte Tag gibt ~31 MB frei.
  const statfs = () => ({ blocks: 4096, bsize: 1048576, bavail: 93 + (state.freed || 0) });
  return { db, state, aggregated, aggregateRange, statfs, NOW };
}

test('S4: kritisch ohne Stufen-Stand → ältesten Tag erst verdichten, dann löschen; Komprimieren erst mit Platz', async () => {
  const s = s4Db();
  const warn = {};
  const r = await createStorageGuard({ getDb: () => s.db, statfs: s.statfs, now: () => s.NOW, aggregateRange: s.aggregateRange,
    setWarning: (id, m) => { warn[id] = m; } }).check();
  assert.equal(r.level, 'kritisch');
  const em = r.actions.filter((a) => a.action === 'emergency_raw' && a.day);
  assert.ok(em.length > 0, JSON.stringify(r.actions));
  assert.ok(em.every((a) => a.aggregated), 'jeder Tag vorher verdichtet');
  assert.equal(s.aggregated.length, em.length);
  // Reihenfolge: verdichten vor löschen, je Tag.
  assert.equal(s.aggregated[0][0], Date.parse('2026-10-10T00:00:00Z'));
  // Bis zur 30-Tage-Grenze (die letzten 30 Tage bleiben, wie bisher): 15 Tage à 31 MB → 558 MB frei, raus aus „kritisch“.
  assert.equal(em.length, 15);
  assert.equal(93 + s.state.freed, 558);
  assert.ok(r.actions.some((a) => a.stopped === 'keep_30_days'));
  assert.ok(s.state.oldest >= s.NOW - 31 * 86_400_000 && s.state.oldest <= s.NOW - 30 * 86_400_000 + 86_400_000);
  assert.match(warn.storage, /Notfall: älteste Rohwerte entfernt.*vorher zu 1-min- und 15-min-Werten verdichtet/);
  // Komprimieren lief danach, und nur mit Platz (hier scheitert es in der Attrappe — das darf nichts aufhalten).
  const iDrop = s.db.calls.findIndex(([q]) => q.startsWith('SELECT drop_chunks'));
  const iComp = s.db.calls.findIndex(([q]) => q.includes('compress_chunk'));
  assert.ok(iComp === -1 || iComp > iDrop, 'nie vor dem Löschen komprimieren');
});

test('S4: Verdichten scheitert (Platte voll) — ohne 15-min-Werte nichts löschen, mit 15-min-Werten laut löschen', async () => {
  const blocked = s4Db({ aggregateFails: true, has15m: false });
  const logs = [];
  const r1 = await createStorageGuard({ getDb: () => blocked.db, statfs: blocked.statfs, now: () => blocked.NOW,
    aggregateRange: blocked.aggregateRange, pushLog: (e) => logs.push(e) }).check();
  assert.ok(r1.actions.some((a) => a.stopped === 'no_15m'));
  assert.ok(!blocked.db.calls.some(([q]) => q.startsWith('SELECT drop_chunks')), 'ohne 15-min nichts weg');
  assert.ok(logs.includes('storage_emergency_blocked_error'));
  const loud = s4Db({ aggregateFails: true, has15m: true });
  const logs2 = []; const guardErrors = []; const warn = {};
  const r2 = await createStorageGuard({ getDb: () => loud.db, statfs: loud.statfs, now: () => loud.NOW,
    aggregateRange: loud.aggregateRange, pushLog: (e, d) => { logs2.push(e); if (e === 'storage_guard_error') guardErrors.push(d.error); },
    setWarning: (id, m) => { warn[id] = m; } }).check();
  assert.ok(r2.actions.some((a) => a.action === 'emergency_raw' && a.day && a.aggregated === false));
  assert.ok(logs2.includes('storage_raw_without_1m_error'), 'laut: …_error ans Portal');
  assert.ok(logs2.includes('storage_emergency_aggregate_skipped'));
  assert.ok(!guardErrors.some((m) => /aggregate/.test(m)), 'vorgesehener Rückfall, kein Fehler der Wache');
  assert.match(warn.storage, /auch die 1-min-Werte verloren, nur die 15-min-Werte blieben/);
});

test('S4: Komprimieren nur mit Platz für 2 Blöcke', async () => {
  // knapp (nicht kritisch), 40-MB-Block, nur 60 MB frei → kein compress_chunk.
  const s = s4Db();
  const statfs = () => ({ blocks: 400, bsize: 1048576, bavail: 60 });
  const r = await createStorageGuard({ getDb: () => s.db, statfs, now: () => s.NOW, aggregateRange: s.aggregateRange }).check();
  assert.ok(r.actions.some((a) => a.action === 'compress' && a.skipped === 'no_space') || !s.db.calls.some(([q]) => q.includes('compress_chunk')));
  assert.ok(!s.db.calls.some(([q]) => q.includes('compress_chunk')), JSON.stringify(r.actions));
});

test('S4: Ziel erreicht → nicht weiter löschen als nötig', async () => {
  const s = s4Db({ days: 60 });
  await createStorageGuard({ getDb: () => s.db, statfs: s.statfs, now: () => s.NOW, aggregateRange: s.aggregateRange }).check();
  // Ziel: max(„wenig“ 512 MB × 1,25, 2 × 40 MB) = 640 MB → 18 Tage (93 + 18 × 31 = 651).
  assert.equal(s.aggregated.length, 18);
  assert.equal(93 + s.state.freed, 651);
});

// E2E S4, 2. Lauf: Platte schon voll — keine Temp-Tabelle; Rückfüllung pausiert vor dem ersten Lauf der Wache.
test('S4: fast volle Platte — Preise im Speicher retten, Block löschen, zurückschreiben (keine Temp-Tabelle)', async () => {
  const s = s4Db({ has15m: true });   // 15-min-Werte (energy_slots_15m) da: erster Tag darf ohne 1-min weg
  const orig = s.db.query.bind(s.db);
  s.db.query = async (sql, p) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT * FROM timeseries_samples WHERE ts_utc < $1')) {
      s.db.calls.push([q, p]);
      return { rows: [{ id: 1, series_key: 'price_eur_mwh', scope: 'live', ts_utc: '2026-10-10T01:00:00Z', value_num: 90 }] };
    }
    return orig(sql, p);
  };
  // 0 MB frei; jeder gelöschte Tag gibt 31 MB frei.
  const r = await createStorageGuard({ getDb: () => s.db, statfs: () => ({ blocks: 4096, bsize: 1048576, bavail: 0 + (s.state.freed || 0) }),
    now: () => s.NOW, aggregateRange: async () => { if (!(s.state.freed > 0)) throw new Error('No space left on device'); } }).check();
  const calls = s.db.calls.map(([q]) => q);
  assert.ok(!calls.some((q) => q.startsWith('CREATE TEMP TABLE')), 'keine Temp-Tabelle auf voller Platte');
  const iSel = calls.findIndex((q) => q.startsWith('SELECT * FROM timeseries_samples WHERE ts_utc < $1'));
  const iDrop = calls.findIndex((q) => q.startsWith('SELECT drop_chunks'));
  const iIns = calls.findIndex((q) => q.startsWith('INSERT INTO timeseries_samples ("id"'));
  assert.ok(iSel >= 0 && iSel < iDrop && iDrop < iIns, 'retten → löschen → zurückschreiben');
  const first = r.actions.find((a) => a.action === 'emergency_raw' && a.day);
  assert.equal(first.mode, 'drop_chunks_low_space');
  assert.equal(first.aggregated, false, 'erster Tag: kein Platz zum Verdichten → laut ohne 1-min');
  const later = r.actions.filter((a) => a.action === 'emergency_raw' && a.day).slice(1);
  assert.ok(later.length > 0 && later.every((a) => a.aggregated), 'danach mit Platz wieder verdichtet');
});

test('isCritical: Sofort-Messung ohne Datenbank, auch vor dem ersten Lauf', () => {
  const g = createStorageGuard({ statfs: () => ({ blocks: 4096, bsize: 1048576, bavail: 93 }), getDataDir: () => '/' });
  assert.equal(g.status(), null);
  assert.equal(g.isCritical(), true);
  const ok = createStorageGuard({ statfs: () => ({ blocks: 4096, bsize: 1048576, bavail: 2000 }), getDataDir: () => '/' });
  assert.equal(ok.isCritical(), false);
});

// E2E S4, 2. Lauf: Kompressions-Job war schneller — „already compressed“ ist kein Fehler.
test('Komprimieren Block für Block: „already compressed“ wird übersprungen, kein roter Hinweis', async () => {
  const db = fakeDb({ oldestDays: 20 });
  const orig = db.query.bind(db);
  db.query = async (sql, p) => {
    if (sql.includes('compress_chunk') && p?.[0] === 'b') { db.calls.push([sql, p]); throw new Error('chunk "_hyper_1_53_chunk" is already compressed'); }
    return orig(sql, p);
  };
  const warn = {}; const logs = [];
  const r = await createStorageGuard({ getDb: () => db, statfs: stat(15), setWarning: (id, m) => { warn[id] = m; }, pushLog: (e) => logs.push(e) }).check();
  assert.deepEqual(r.actions.find((a) => a.action === 'compress'), { action: 'compress', chunks: 2 });
  assert.equal(warn[COMPRESSION_WARNING_ID], null);
  assert.ok(!logs.includes('storage_guard_error'));
});

// Codex ee43127e (P1): nach erfolgreichem Notfall keine zusätzliche Stufe 365 → 180 …
test('S4: Notfall hat Platz geschaffen → alte Notfall-Stufe löscht nicht noch mehr', async () => {
  // Stufen vollständig bis vor 2 Tagen — die alte Stufe (400 Tage → 365) hätte sonst noch einmal gelöscht.
  const s = s4Db({ days: 400, tierUntil: new Date(Date.parse('2026-11-22T00:00:00Z')) });
  const r = await createStorageGuard({ getDb: () => s.db, statfs: s.statfs, now: () => s.NOW, aggregateRange: s.aggregateRange }).check();
  assert.ok(r.actions.some((a) => a.action === 'emergency_raw' && a.day));
  assert.ok(!r.actions.some((a) => a.action === 'drop_raw'), JSON.stringify(r.actions.map((a) => a.action)));
  assert.equal(s.aggregated.length, 18, 'nur so viel wie nötig');
});

test('isCritical: nativ misst schon vor dem ersten Lauf die PG-Platte (Codex ee43127e)', async () => {
  const statfs = (p) => (p.startsWith('/srv/pg') ? { blocks: 4096, bsize: 1048576, bavail: 50 } : { blocks: 4096, bsize: 1048576, bavail: 3000 });
  const g = createStorageGuard({ statfs, stat: () => ({ dev: 1 }), getDataDir: () => '/var/lib/dvhub', getPgDataDir: async () => '/srv/pg/main' });
  assert.equal(g.isCritical(), false, 'vor der Ermittlung: DVhub-Ordner');
  g.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(g.isCritical(), true, 'danach: PG-Platte');
});

// Codex 43ba132e: „kritisch“ nach Reichweite bei genug freiem Platz → alte Stufe läuft weiter.
test('Reichweite kritisch, Platz absolut genug: Notfall-Pfad tut nichts, alte Stufe greift weiter', async () => {
  const s = s4Db({ days: 400, tierUntil: new Date(Date.parse('2026-11-22T00:00:00Z')) });
  const files = { '/d/storage-samples.json': JSON.stringify({ samples: [{ day: '2026-11-17', used: { data: 32768 - 6000 - 2800 } }] }) };
  const io = { writeFile: (f, d) => { files[f] = d; }, rename: (a, b) => { files[b] = files[a]; delete files[a]; }, readFile: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; } };
  // 32 GiB, 6000 MiB frei, +400 MiB/Tag → ~10 Tage Reichweite → kritisch
  const r = await createStorageGuard({ getDb: () => s.db, statfs: () => ({ blocks: 32768, bsize: 1048576, bavail: 6000 }), now: () => s.NOW,
    aggregateRange: s.aggregateRange, getDataDir: () => '/d', samplesIo: io, profileIo: io, readFile: io.readFile }).check();
  assert.equal(r.level, 'kritisch');
  assert.ok(!r.actions.some((a) => a.action === 'emergency_raw' && a.day), 'Notfall nicht nötig');
  assert.ok(r.actions.some((a) => a.action === 'drop_raw'), JSON.stringify(r.actions));
});
