// Absicherung C (Dauer-Forced-Split): externe sichere Rücknahme des Forced mode (ExecStopPost/Watchdog).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sungrowForcedSafeOff, readForcedMarker, forcedConnections, watchdogShouldRelease, readForcedHeartbeatAt } from '../services/inverter/sungrow-forced-safeoff.js';
import { wire, EMS_MODE, EMS_CMD } from '../services/inverter/sungrow.js';

const MODE = wire(13050);
const CMD = wire(13051);

function recordingTransport({ failAt = null } = {}) {
  return {
    writes: [],
    async mbWriteSingle({ host, address, value }) {
      if (failAt && failAt.host === host && failAt.address === address) throw new Error('modbus timeout');
      this.writes.push({ host, address, value });
      return { addr: address, value };
    },
  };
}

test('safeOff: Slave zuerst 0xCC (kein Modus), dann Master 0xCC + Modus 0', async () => {
  const t = recordingTransport();
  const out = await sungrowForcedSafeOff({ transport: t, master: { host: '192.0.2.84', port: 502, unitId: 1 }, slave: { host: '192.0.2.83', port: 502, unitId: 1 } });
  assert.deepEqual(t.writes, [
    { host: '192.0.2.83', address: CMD, value: EMS_CMD.STOP },   // Slave Befehl 0xCC (kein 13050!)
    { host: '192.0.2.84', address: CMD, value: EMS_CMD.STOP },   // Master Befehl 0xCC
    { host: '192.0.2.84', address: MODE, value: EMS_MODE.SELF }, // Master Modus 0
  ]);
  assert.ok(out.slave.cmd && out.master.cmd && out.master.mode);
  assert.ok(!t.writes.some((w) => w.host === '192.0.2.83' && w.address === MODE), 'Slave bekommt NIE einen Modus-Write');
});

test('safeOff: ohne Slave nur der Master; ein Fehler an einem Register stoppt die anderen nicht', async () => {
  const t = recordingTransport({ failAt: { host: '192.0.2.84', address: CMD } });
  const out = await sungrowForcedSafeOff({ transport: t, master: { host: '192.0.2.84', port: 502, unitId: 1 }, slave: null });
  // Befehl schlug fehl, Modus 0 geht trotzdem raus (sichere Seite).
  assert.ok(out.master.cmdError, 'Befehl-Fehler gemeldet');
  assert.deepEqual(t.writes, [{ host: '192.0.2.84', address: MODE, value: EMS_MODE.SELF }]);
});

test('readForcedMarker: ownMode 2 = besessen; fehlend/anderer Modus = nicht besessen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-marker-'));
  const p = path.join(dir, 'm.json');
  fs.writeFileSync(p, JSON.stringify({ ownMode: 2, endpointKey: '192.0.2.84:502:1', at: 123 }));
  assert.deepEqual(readForcedMarker(p), { owned: true, ownMode: 2, endpointKey: '192.0.2.84:502:1', at: 123 });
  fs.writeFileSync(p, JSON.stringify({ ownMode: 3, endpointKey: 'x', at: 1 }));
  assert.equal(readForcedMarker(p).owned, false, 'Modus 3 (External) ist kein Forced-Besitz');
  assert.equal(readForcedMarker(path.join(dir, 'fehlt.json')).owned, false, 'ohne Datei nicht besessen');
});

test('forcedConnections: Master aus victron, Slave aus secondInverter', () => {
  const c = forcedConnections({ victron: { host: '192.0.2.84', port: 502, unitId: 1 }, sungrow: { secondInverter: { host: '192.0.2.83', port: 1502, unitId: 2 } } });
  assert.deepEqual(c.master, { host: '192.0.2.84', port: 502, unitId: 1, timeoutMs: 1500 });
  assert.deepEqual([c.slave.host, c.slave.port, c.slave.unitId], ['192.0.2.83', 1502, 2]);
  assert.equal(c.masterKey, '192.0.2.84:502:1');
  // Ohne zweiten WR: kein Slave.
  assert.equal(forcedConnections({ victron: { host: '192.0.2.84' } }).slave, null);
  // Review-Befund 2: masterKey wird GENAU wie der Besitz-Merker (endpointKeyOf, Rohform) gebildet — auch ohne
  // explizite port/unitId, damit die Skripte nicht fälschlich überspringen.
  assert.equal(forcedConnections({ victron: { host: '192.0.2.84' } }).masterKey, '192.0.2.84::');
});

test('watchdogShouldRelease: verwaister Forced mode (Modus 2 + besessen + Lebenszeichen alt) → Rücknahme', () => {
  const base = { liveMode: EMS_MODE.FORCED, markerOwned: true, nowMs: 1_000_000, staleMs: 120000 };
  // Lebenszeichen 200 s alt → verwaist → Rücknahme.
  assert.equal(watchdogShouldRelease({ ...base, heartbeatAt: 1_000_000 - 200_000 }).release, true);
  // Lebenszeichen fehlt (null) → als unendlich alt → Rücknahme.
  assert.equal(watchdogShouldRelease({ ...base, heartbeatAt: null }).release, true);
  // Lebenszeichen frisch (30 s) → DVhub lebt → nichts tun.
  assert.equal(watchdogShouldRelease({ ...base, heartbeatAt: 1_000_000 - 30_000 }).release, false);
  // Master nicht in Modus 2 (sauber freigegeben) → nichts tun.
  assert.equal(watchdogShouldRelease({ ...base, liveMode: EMS_MODE.SELF, heartbeatAt: 0 }).release, false);
  // DVhub besitzt den Modus nicht (fremdes EMS) → nicht anfassen.
  assert.equal(watchdogShouldRelease({ ...base, markerOwned: false, heartbeatAt: 0 }).release, false);
});

test('readForcedHeartbeatAt: at aus der Datei, null wenn fehlend/ungültig', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-hb-'));
  const p = path.join(dir, 'hb.json');
  fs.writeFileSync(p, JSON.stringify({ at: 5555 }));
  assert.equal(readForcedHeartbeatAt(p), 5555);
  assert.equal(readForcedHeartbeatAt(path.join(dir, 'fehlt.json')), null);
});
