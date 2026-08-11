// test/log-wrapper.test.js
//
// Plan 09-06 (REQ-9.6 log-levels + REQ-9.6 log-wrapper-scope + REQ-9.6 ui-level-filter):
//
// Verifies services/log.js exports + LOG_LEVEL behaviour, and the /api/log
// payload + pushLog signature changes that D-09 adds.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { info, warn, error, debug, logger } from '../services/log.js';

describe('Plan 09-06 services/log.js: thin wrapper around console.* with ISO ts + LEVEL prefix', () => {
  it('logger.info routes through console.log with ISO ts + INFO prefix + meta JSON', () => {
    const calls = [];
    const orig = console.log;
    console.log = (m) => calls.push(m);
    try {
      info('hello', { a: 1 });
    } finally {
      console.log = orig;
    }
    assert.equal(calls.length, 1, 'one console.log call expected');
    assert.match(
      calls[0],
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO hello \{"a":1\}$/,
      `expected "<iso> INFO hello {"a":1}", got "${calls[0]}"`
    );
  });

  it('logger.warn routes through console.warn with WARN prefix', () => {
    const calls = [];
    const orig = console.warn;
    console.warn = (m) => calls.push(m);
    try {
      warn('uhoh');
    } finally {
      console.warn = orig;
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z WARN uhoh$/);
  });

  it('logger.error routes through console.error with ERROR prefix', () => {
    const calls = [];
    const orig = console.error;
    console.error = (m) => calls.push(m);
    try {
      error('boom', { cause: 'kaboom' });
    } finally {
      console.error = orig;
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR boom \{"cause":"kaboom"\}$/);
  });

  it('LOG_LEVEL default (info) suppresses debug()', () => {
    const calls = [];
    const orig = console.log;
    console.log = (m) => calls.push(m);
    try {
      debug('this should be silent');
    } finally {
      console.log = orig;
    }
    assert.equal(calls.length, 0, `debug() must be suppressed at LOG_LEVEL=info, got ${JSON.stringify(calls)}`);
  });

  it('LOG_LEVEL=warn (via dynamic re-import) suppresses info() and debug(), preserves warn() and error()', async () => {
    // Re-import with LOG_LEVEL=warn. Because ESM caches modules, use a cache-
    // busting query string so a fresh module instance reads the new env var.
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    try {
      const mod = await import('../services/log.js?LOG_LEVEL=warn');
      const calls = { log: [], warn: [], error: [] };
      const origs = { log: console.log, warn: console.warn, error: console.error };
      console.log = (m) => calls.log.push(m);
      console.warn = (m) => calls.warn.push(m);
      console.error = (m) => calls.error.push(m);
      try {
        mod.info('should be suppressed');
        mod.debug('should be suppressed');
        mod.warn('should appear');
        mod.error('should appear');
      } finally {
        console.log = origs.log;
        console.warn = origs.warn;
        console.error = origs.error;
      }
      assert.equal(calls.log.length, 0, `info()/debug() must be suppressed at LOG_LEVEL=warn, got log=${JSON.stringify(calls.log)}`);
      assert.equal(calls.warn.length, 1, 'warn() must still emit');
      assert.equal(calls.error.length, 1, 'error() must still emit');
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });

  it('logger alias exposes the same four functions', () => {
    assert.equal(typeof logger.debug, 'function');
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.error, 'function');
  });
});

describe('Plan 09-06 D-09: /api/log payload + pushLog signature', () => {
  it('/api/log GET payload rows include level field (default "info" when missing)', async () => {
    // We can't easily boot the full server in a unit test, so this is a
    // source-level smoke check: routes-api.js maps state.log entries to
    // { ...entry, level: entry.level || 'info' } in the GET /api/log handler.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../routes-api.js', import.meta.url), 'utf8');
    const idx = src.indexOf("url.pathname === '/api/log' && req.method === 'GET'");
    assert.ok(idx !== -1, '/api/log GET handler must exist');
    const slice = src.slice(idx, idx + 600);
    assert.match(slice, /level: entry\.level \|\| 'info'/, '/api/log GET must default missing level to "info"');
  });

  it('pushLog gains a level parameter (default "info"), threads severity into writeAuditEntry', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    // Default-level shape — match either positional string ("level = 'info'")
    // or option-object default. The plan locks the 3rd-arg shorthand path.
    assert.match(src, /levelOrOptions = \{\}/, 'pushLog must accept the 3rd-arg shorthand options');
    assert.match(src, /level: level/, 'pushLog must stamp level onto the ring-buffer row');
    assert.match(src, /severity: options\.severity \|\| level/, 'pushLog must thread level into audit_log.severity');
  });

  it('pushLog ring-buffer entry includes a level field', async () => {
    // Source-level grep: the row literal must include level.
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    assert.match(src, /const row = \{ ts: nowIso\(\), event, level: level/);
  });
});

// 2026-07-12 (Operator-Report „Level-Filter wertlos"): 240 von 245 *_error-
// pushLog-Aufrufern übergeben kein Level → alles landete als INFO im Ring und
// der Leitstand-Filter zeigte unter ERROR nichts. inferLogLevel leitet den
// DEFAULT aus dem Event-Namen ab; ein explizites Level gewinnt weiterhin
// (pushLog: options.severity || options.level || inferLogLevel(event)).
describe('inferLogLevel: Event-Name → Default-Level (server-utils.js)', async () => {
  const { inferLogLevel } = await import('../server-utils.js');

  it('…_error/_failed/_failure → error', () => {
    assert.equal(inferLogLevel('control_write_error'), 'error');
    assert.equal(inferLogLevel('dv_victron_write_error'), 'error');
    assert.equal(inferLogLevel('update_failed'), 'error');
    assert.equal(inferLogLevel('error_boot'), 'error');
  });

  it('…_rejected/_stale/_warn/_rollback → warn', () => {
    assert.equal(inferLogLevel('evcc_battery_protect_rejected'), 'warn');
    assert.equal(inferLogLevel('telemetry_stale'), 'warn');
    assert.equal(inferLogLevel('update_rollback'), 'warn');
  });

  it('normale Events bleiben info; Segment-Grenzen greifen (kein Substring-Match)', () => {
    assert.equal(inferLogLevel('dv_victron_write'), 'info');
    assert.equal(inferLogLevel('schedule_stop_soc_reached'), 'info');
    assert.equal(inferLogLevel('sunspec_scan_ok'), 'info');
    // "errors"/"mirrors" sind KEIN _error-Segment:
    assert.equal(inferLogLevel('mirrors_synced'), 'info');
    assert.equal(inferLogLevel(''), 'info');
    assert.equal(inferLogLevel(null), 'info');
  });

  it('pushLog nutzt die Inferenz als Default (Source-Vertrag)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    assert.match(src, /options\.severity \|\| options\.level \|\| inferLogLevel\(event\)/);
  });
});
