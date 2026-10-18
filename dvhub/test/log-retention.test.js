import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogRetention, AUDIT_ERROR_SQL, AUDIT_NOISE_SQL, LOG_DETAIL_DAYS, LOG_ERROR_DETAIL_DAYS } from '../services/log-retention.js';

function fakeDb({ oldest = {} } = {}) {
  const calls = [];
  const days = { ...oldest };   // kind → [tage …], werden pro Löschen verbraucht
  const db = {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      const kind = /control_events WHERE event_type = 'control_write' AND ts_utc < \$2/.test(sql) ? 'control'
        : sql.includes('SELECT (min(ts_utc)') && sql.includes('_error') && !sql.includes('NOT (') ? 'error'
          : sql.includes('SELECT (min(ts_utc)') ? 'audit' : null;
      if (kind) return { rows: [{ day: (days[kind] || [])[0] || null }] };
      if (/^DELETE FROM (control_events|audit_log) WHERE/.test(String(sql).replace(/\s+/g, ' ').trim()) && params?.length === 2 && typeof params[0] === 'string' && /^\d{4}-/.test(params[0]) && params[0].length === 10) {
        const k = sql.includes('control_events') ? 'control' : sql.includes('NOT (') ? 'audit' : 'error';
        days[k]?.shift();
        return { rowCount: 10 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

const cfg = () => ({ timeZone: 'Europe/Berlin' });
const NOW = Date.parse('2026-10-01T12:00:00Z');

test('Seltene Ereignisse und Verdichtetes werden nie gelöscht', async () => {
  const db = fakeDb();
  await createLogRetention({ getDb: () => db, getCfg: cfg, now: () => NOW }).runOnce();
  const deletes = db.calls.filter((c) => c.sql.startsWith('DELETE'));
  for (const d of deletes) {
    assert.ok(!/DELETE FROM control_events WHERE ts_utc </.test(d.sql), 'keine Pauschal-Löschung von Ereignissen');
    assert.ok(!/DELETE FROM audit_log WHERE ts_utc </.test(d.sql), 'keine Pauschal-Löschung im Audit-Log');
    assert.ok(!/control_events_15m|audit_log_daily|audit_error_episodes/.test(d.sql), 'Aggregate bleiben für immer');
  }
});

test('Ohne Portal-Quittung keine kurze Frist für Fehler', async () => {
  const db = fakeDb();
  await createLogRetention({ getDb: () => db, getCfg: cfg, now: () => NOW, getErrorAckId: () => null }).runOnce();
  assert.ok(!db.calls.some((c) => c.sql.includes('audit_error_15m')));
});

test('Mit Portal-Quittung: 24 h, Bündeln + Löschen in einer Transaktion, nur bis zum Cursor', async () => {
  const db = fakeDb();
  const r = await createLogRetention({ getDb: () => db, getCfg: cfg, now: () => NOW, getErrorAckId: () => 4711 }).runOnce();
  assert.equal(r.error, undefined);
  const seq = db.calls.map((c) => c.sql.split(' ').slice(0, 3).join(' '));
  const b = seq.indexOf('BEGIN');
  assert.ok(b >= 0 && seq[b + 1].startsWith('INSERT INTO audit_error_15m') && seq[b + 2].startsWith('DELETE FROM audit_log') && seq[b + 3] === 'COMMIT');
  const ins = db.calls[b + 1];
  assert.equal(ins.params[1], 4711);
  assert.equal(ins.params[0], new Date(NOW - 24 * 3600_000).toISOString());
  const drop = db.calls.find((c) => c.sql.startsWith('DELETE FROM audit_error_15m'));
  assert.equal(drop.params[0], new Date(NOW - 7 * 86_400_000).toISOString());
});

test('Verdichtet tageweise bis zum 14-Tage-Stichtag', async () => {
  const db = fakeDb({ oldest: { control: ['2026-03-10', '2026-03-11'], audit: ['2026-05-11'] } });
  const r = await createLogRetention({ getDb: () => db, getCfg: cfg, now: () => NOW }).runOnce();
  assert.equal(r.controlDays, 2);
  assert.equal(r.auditDays, 1);
  const agg = db.calls.filter((c) => c.sql.startsWith('INSERT INTO control_events_15m'));
  assert.deepEqual(agg.map((c) => c.params[0]), ['2026-03-10', '2026-03-11']);
});

test('Rauschen und Fehler sind getrennt', () => {
  assert.match(AUDIT_NOISE_SQL, /AND NOT/);
  assert.match(AUDIT_ERROR_SQL, /_error/);
});

test('Bleibt ein Tag stehen, bricht der Job ab statt zu kreisen', async () => {
  const db = { calls: 0, async query(sql) { this.calls++; return sql.includes('SELECT (min(ts_utc)') ? { rows: [{ day: '2026-03-10' }] } : { rows: [], rowCount: 0 }; } };
  const logs = [];
  await createLogRetention({ getDb: () => db, getCfg: cfg, now: () => NOW, pushLog: (e) => logs.push(e) }).runOnce();
  assert.ok(db.calls < 30, `nur wenige Abfragen (${db.calls})`);
  assert.ok(logs.includes('log_retention_stuck'));
});

// Christin 2026-10-18: bei Kunden 14 Tage Einzelwerte (vorher 60), Fehler
// bleiben 60 Tage voll; auf unseren Geräten „Vollständig“ = nichts verdichten.
test('Standard: 14 Tage Einzelwerte, Fehler 60 Tage', async () => {
  assert.equal(LOG_DETAIL_DAYS, 14);
  assert.equal(LOG_ERROR_DETAIL_DAYS, 60);
  const db = fakeDb();
  await createLogRetention({ getDb: () => db, getCfg: cfg, now: () => NOW }).runOnce();
  const cut = (days) => new Date(NOW - days * 86_400_000).toISOString();
  const oldestControl = db.calls.find((c) => /control_events WHERE event_type = 'control_write' AND ts_utc < \$2/.test(c.sql));
  assert.equal(oldestControl.params[1], cut(14));
  const oldestError = db.calls.find((c) => c.sql.includes('SELECT (min(ts_utc)') && c.sql.includes('_error') && !c.sql.includes('NOT ('));
  assert.equal(oldestError.params[1], cut(60));
  const oldestNoise = db.calls.find((c) => c.sql.includes('SELECT (min(ts_utc)') && c.sql.includes('NOT ('));
  assert.equal(oldestNoise.params[1], cut(14));
});

test('Vollständig: nichts wird verdichtet oder gelöscht', async () => {
  const db = fakeDb({ oldest: { control: ['2026-03-10'], audit: ['2026-05-11'] } });
  const full = () => ({ timeZone: 'Europe/Berlin', telemetry: { logRetention: { mode: 'full' } } });
  const r = await createLogRetention({ getDb: () => db, getCfg: full, now: () => NOW, getErrorAckId: () => 4711 }).runOnce();
  assert.equal(r.skipped, 'full');
  assert.equal(db.calls.length, 0);
});

test('Laufreihen: je Tag bleibt ein Plan (Day-Ahead vom Vortag), nicht der letzte Lauf', async () => {
  const db = fakeDb();
  await createLogRetention({ getDb: () => db, getCfg: cfg, now: () => NOW }).runOnce();
  assert.ok(!db.calls.some((c) => /row_number\(\) OVER/.test(c.sql)), 'kein „letzter Lauf je Tag“ mehr');
  assert.ok(db.calls.some((c) => /count\(DISTINCT optimizer_run_id\) > 1/.test(c.sql)), 'sucht Tage mit mehreren Läufen');
});
