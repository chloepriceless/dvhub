// test/timescale-ext-auto.test.js — Container: TimescaleDB-Erweiterung nach
// einem DB-Image-Update beim Start selbst anheben (2026-10-15, Christin: ein
// DVhub-Update soll alles auf den neuesten Stand bringen).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeTimescaleIfPending } from '../services/timescale-ext-auto.js';

// Pool-Attrappe: jede createPool-Instanz merkt sich ihre Abfragen in Reihenfolge.
function fakePools({ installed, available, failAlter = false }) {
  const pools = [];
  const createPool = (cfg) => {
    const p = {
      cfg, queries: [], ended: false,
      async connect() { return { release() {} }; },
      async query(sql) {
        p.queries.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        if (/pg_available_extensions/.test(sql)) return { rows: [{ installed_version: installed, default_version: available }] };
        if (/^ALTER EXTENSION/.test(sql.trim()) && failAlter) throw new Error('boom');
        if (/^ALTER EXTENSION/.test(sql.trim())) installed = available;
        return { rows: [] };
      },
      async end() { p.ended = true; },
    };
    pools.push(p);
    return p;
  };
  return { pools, createPool };
}

const base = { dbConfig: { host: 'db', name: 'dvhub' }, adminUser: 'postgres', adminPassword: 'x' };

describe('upgradeTimescaleIfPending', () => {
  it('2.28.2 installiert, 2.30.2 im Image → ALTER EXTENSION als ERSTER Befehl einer frischen Verbindung', async () => {
    const f = fakePools({ installed: '2.28.2', available: '2.30.2' });
    const logs = [];
    const r = await upgradeTimescaleIfPending({ ...base, createPool: f.createPool, pushLog: (e, d) => logs.push({ e, d }) });
    assert.deepEqual(r, { upgraded: true, from: '2.28.2', to: '2.30.2' });
    assert.equal(f.pools.length, 2, 'Prüfen und Anheben in getrennten Verbindungen');
    assert.equal(f.pools[1].queries[0], 'ALTER EXTENSION timescaledb');
    assert.equal(f.pools[1].cfg.user, 'postgres');
    assert.equal(f.pools[1].cfg.name, 'dvhub');
    assert.ok(f.pools.every((p) => p.ended), 'alle Admin-Verbindungen geschlossen');
    assert.ok(logs.some((l) => l.e === 'timescale_extension_upgraded' && l.d.to === '2.30.2'));
  });

  it('aktuell → nichts tun', async () => {
    const f = fakePools({ installed: '2.30.2', available: '2.30.2' });
    const r = await upgradeTimescaleIfPending({ ...base, createPool: f.createPool });
    assert.deepEqual(r, { upgraded: false, reason: 'current', version: '2.30.2' });
    assert.equal(f.pools.length, 1);
  });

  it('keine Erweiterung installiert → nichts tun', async () => {
    const f = fakePools({ installed: null, available: '2.30.2' });
    const r = await upgradeTimescaleIfPending({ ...base, createPool: f.createPool });
    assert.equal(r.upgraded, false);
    assert.equal(r.reason, 'not_installed');
  });

  it('ohne Admin-Zugang → übersprungen, keine Verbindung', async () => {
    const f = fakePools({ installed: '2.28.2', available: '2.30.2' });
    const r = await upgradeTimescaleIfPending({ ...base, adminPassword: '', createPool: f.createPool });
    assert.deepEqual(r, { upgraded: false, reason: 'no_admin' });
    assert.equal(f.pools.length, 0);
  });

  it('Fehler beim Anheben → kein Wurf, Meldung, Verbindungen zu', async () => {
    const f = fakePools({ installed: '2.28.2', available: '2.30.2', failAlter: true });
    const logs = [];
    const r = await upgradeTimescaleIfPending({ ...base, createPool: f.createPool, pushLog: (e, d) => logs.push({ e, d }) });
    assert.equal(r.upgraded, false);
    assert.equal(r.reason, 'error');
    assert.ok(logs.some((l) => l.e === 'timescale_extension_upgrade_error'));
    assert.ok(f.pools.every((p) => p.ended));
  });
});
