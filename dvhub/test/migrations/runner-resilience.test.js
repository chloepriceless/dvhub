// test/migrations/runner-resilience.test.js
//
// Phase 23-03 — Frischinstall-Crash-Quelle #3: runPendingMigrations-Resilienz.
//
// Wave-0-Unit-Test (DB-frei, Mock-Pool). Belegt die Open-Question-4-Doktrin
// best-effort-continue:
//   (1) Eine absichtlich werfende Migration killt den Lauf NICHT
//       (assert.doesNotReject) — Folge-Migrationen laufen weiter.
//   (2) Mindestens eine Migration, die alphabetisch NACH der kaputten kommt,
//       wird trotzdem an pool.query(sql) übergeben (die kaputte ist 001 →
//       002..020 müssen folgen).
//   (3) Eine console.error-Diagnose-Zeile nennt `[migration] FAILED` + den
//       Dateinamen der kaputten Migration.
//
// Mock-Pool-Muster abgeleitet aus dvhub/test/forecast-batch-insert.test.js
// (Z.17-24): fakePool.query async, sammelt { sql, params }, liefert
// { rows: [], rowCount: 0 }. WICHTIG: die schema_migrations-Existenzabfrage
// muss { rows: [] } liefern, sonst gelten alle Migrationen als "schon
// angewendet" und werden übersprungen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runPendingMigrations } from '../../telemetry-store-pg.js';

/**
 * Baut einen Fake-pg-Pool für runPendingMigrations.
 *
 * @param {RegExp} [failOn] - matcht den SQL-INHALT einer Migration, die werfen
 *   soll. Die echten Migrations-Dateien tragen einen `-- Migration NNN:`-Header,
 *   d.h. /Migration 001:/ trifft gezielt die erste Migration und keine andere.
 * @returns {{ fakePool: object, calls: Array<{sql:string, params:any}> }}
 */
function makeMockPool(failOn) {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      // schema_migrations-Versions-Check: leer → Migration gilt als NICHT
      // angewendet und wird ausgeführt.
      if (/SELECT 1 FROM schema_migrations WHERE version/.test(sql)) {
        return { rows: [], rowCount: 0 };
      }
      // Gezielt eine bestimmte Migration sprengen (synthetischer PG-Fehler).
      if (failOn && failOn.test(sql)) {
        throw Object.assign(new Error('synthetic boom'), { code: '42883' });
      }
      return { rows: [], rowCount: 0 };
    }
  };
  return { fakePool, calls };
}

// TimescaleDB-Migration 014 ist opt-in — aus lassen, damit der 014-Skip greift
// und keine echte Hypertable-DDL versucht wird.
const CFG = { telemetry: { database: { timescaledb: false } } };

test('runPendingMigrations: kaputte Migration killt Folge-Migrationen nicht (best-effort-continue)', async () => {
  // 001 ist die erste Migration → ihr Fehler darf 002..020 nicht abwürgen.
  const { fakePool, calls } = makeMockPool(/Migration 001:/);

  const origError = console.error;
  const errorLines = [];
  // eslint-disable-next-line no-console
  console.error = (...args) => { errorLines.push(args.join(' ')); };

  try {
    // (1) Lauf darf NICHT rejecten, obwohl Migration 001 wirft.
    await assert.doesNotReject(
      () => runPendingMigrations(fakePool, CFG),
      'ein einzelner Migrationsfehler darf runPendingMigrations nicht abbrechen'
    );
  } finally {
    // console.error-Spy IMMER wiederherstellen.
    // eslint-disable-next-line no-console
    console.error = origError;
  }

  // (2) Folge-Migration lief: mindestens ein query-Call trägt SQL einer
  // Migration, die NACH 001 kommt. Die Header-Kommentare `-- Migration 0NN:`
  // sind eindeutige Marker; 002..020 müssen erscheinen.
  const ranLaterMigration = calls.some(c =>
    typeof c.sql === 'string' && /-- Migration 0(0[2-9]|1[0-9]|20):/.test(c.sql)
  );
  assert.ok(
    ranLaterMigration,
    'eine Migration nach der kaputten 001 muss trotzdem ausgeführt worden sein'
  );

  // (3) Diagnose-Zeile nennt [migration] FAILED + Dateiname der kaputten Migration.
  const diag = errorLines.find(l =>
    l.includes('[migration] FAILED') && l.includes('001-vrm-forecasts-unique.sql')
  );
  assert.ok(
    diag,
    `eine console.error-Diagnose mit "[migration] FAILED" + Dateiname erwartet; ` +
    `gesehen: ${JSON.stringify(errorLines)}`
  );
});

test('runPendingMigrations: ohne Fehler keine FAILED-Diagnose, alle Migrationen ausgeführt', async () => {
  const { fakePool, calls } = makeMockPool(/* failOn */ null);

  const origError = console.error;
  const errorLines = [];
  // eslint-disable-next-line no-console
  console.error = (...args) => { errorLines.push(args.join(' ')); };

  try {
    await assert.doesNotReject(() => runPendingMigrations(fakePool, CFG));
  } finally {
    // eslint-disable-next-line no-console
    console.error = origError;
  }

  const anyFailed = errorLines.some(l => l.includes('[migration] FAILED'));
  assert.equal(anyFailed, false, 'ohne werfende Migration darf keine FAILED-Diagnose erscheinen');

  // Sanity: mindestens eine Migrations-SQL wurde ausgeführt (Mock liefert
  // schema_migrations leer → alle gelten als ausstehend).
  const ranAnyMigration = calls.some(c =>
    typeof c.sql === 'string' && /-- Migration \d{3}:/.test(c.sql)
  );
  assert.ok(ranAnyMigration, 'mindestens eine Migration sollte ausgeführt worden sein');
});
