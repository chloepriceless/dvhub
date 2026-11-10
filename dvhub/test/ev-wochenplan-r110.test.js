// test/ev-wochenplan-r110.test.js -- Zusammenführung E-Auto-Wochenplan
// (Min/Max, Phasenumschaltung, Stopp am Max) mit release/1.0.10:
//   - Not-Halt „als ob aus“ (services/emergency-stop/policy.js): Kommt der
//     Not-Halt, während die Brücke den EOS-Plan holt oder mitten in einer
//     Befehlsfolge (Strom → Phasen → Laden) steckt, schreibt sie nichts mehr —
//     weder Phasen noch Laden noch den Stopp am Max-Ladestand.
//   - Not-Halt nach einphasigem DVhub-Laden: einmal „aus“, keine Phasen-Rückstellung.
//   - Lese-Modus: Phasenumschaltung und Stopp am Max gehen nicht an evcc.
//   - Konfig: Die Übernahme alter Wochenpläne schreibt beim Laden nichts, eine
//     kaputte config.json bleibt unangetastet, falsche Typen werfen nicht.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createEosEvccBridge } from '../services/optimizer/eos-evcc-bridge.js';
import { createEvccAdapter } from '../services/wallbox/adapters.js';
import { createEvccIntegration } from '../evcc-integration.js';
import { loadConfigFile, saveConfigFile } from '../config-model.js';

const T0 = Date.parse('2026-11-16T22:00:00Z');
const Q = 15 * 60_000;

function harness({ factors = [0.25, 0.25, 0.25, 0.25], maxStop = null } = {}) {
  const calls = [];
  const ctl = { paused: false, pauseOnSolution: false, pauseOnMaxCurrent: false, maxStop };
  const lp = { id: 1, mode: 'pv', connected: true, charging: false, phases1p3p: true, phasesActive: 3 };
  const fakeEvcc = {
    getStatus: () => ({ url: 'http://evcc.local:7070' }),
    getLoadpoints: () => [{ ...lp }],
    refresh: async () => true,
    setMaxCurrent: async (id, a) => { calls.push(['maxcurrent', a]); if (ctl.pauseOnMaxCurrent) ctl.paused = true; return { ok: true }; },
    setMode: async (id, m) => { calls.push(['mode', m]); lp.mode = m; return { ok: true }; },
    setPhases: async (id, n) => { calls.push(['phases', n]); lp.phasesActive = n; return { ok: true }; },
  };
  const cfg = { evcc: { url: 'http://evcc.local:7070' }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3, evStopMode: 'pv' } };
  let clock = T0 + 60_000;
  let sol = factors;
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => {
      if (ctl.pauseOnSolution) ctl.paused = true; // Not-Halt kommt während des Abrufs
      return { generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: sol.map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) };
    },
    getCharger: (c, bc) => createEvccAdapter(fakeEvcc, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => [{ ...lp }],
    getGridCapW: () => null,
    getEvMaxStop: () => ctl.maxStop,
    isPaused: () => ctl.paused,
    now: () => clock,
  });
  return { bridge, calls, ctl, lp, advance: (ms) => { clock += ms; }, setFactors: (f) => { sol = f; } };
}

describe('Not-Halt während eines Takts: Phasen und Max-Stopp schreiben nicht', () => {
  test('Not-Halt kommt während des Plan-Abrufs: keine Phasen-, Strom- oder Moduswrites', async () => {
    const h = harness();
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['phases', 1], ['maxcurrent', 12], ['mode', 'now']], 'einphasig geladen');
    h.calls.length = 0;
    h.setFactors([1, 1, 1, 1]); // jetzt dreiphasig voll — wäre Strom → Phasen 3 → Laden
    h.ctl.pauseOnSolution = true;
    h.advance(60_000);
    const r = await h.bridge.tick();
    assert.deepEqual(h.calls, [], 'nichts geschrieben');
    assert.equal(r.skipped, 'paused');
  });

  test('Not-Halt kommt während des Plan-Abrufs am Max-Ladestand: kein Stopp-Write', async () => {
    const h = harness({ factors: [1, 1, 1, 1], maxStop: { maxSocPct: 80, socPct: 70 } });
    await h.bridge.tick();
    assert.deepEqual(h.calls.at(-1), ['mode', 'now']);
    h.calls.length = 0;
    h.ctl.maxStop = { maxSocPct: 80, socPct: 80 };
    h.ctl.pauseOnSolution = true;
    h.advance(60_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls, [], 'kein „aus“ am Max im Not-Halt');
  });

  test('Not-Halt mitten in „Strom, dann drei Phasen“: nach dem Strom nichts mehr', async () => {
    const h = harness();
    await h.bridge.tick();
    h.calls.length = 0;
    h.setFactors([1, 1, 1, 1]);
    h.ctl.pauseOnMaxCurrent = true;
    h.advance(60_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['maxcurrent', 16]], 'keine Phasenumschaltung, kein Laden nach dem Not-Halt');
  });

  test('„Sofort laden“ nach einphasigem Plan, Not-Halt nach dem Strom: keine drei Phasen, kein Laden', async () => {
    const h = harness();
    await h.bridge.tick();
    h.calls.length = 0;
    h.ctl.pauseOnMaxCurrent = true;
    const r = await h.bridge.setOverride({ powerW: 11000 });
    assert.deepEqual(h.calls, [['maxcurrent', 16]], JSON.stringify(h.calls));
    assert.equal(h.bridge.getStatus().lastError ?? null, null, 'kein Schreibfehler gemeldet');
    assert.ok(r);
  });

  test('Not-Halt nach einphasigem DVhub-Laden: einmal „aus“, keine Phasen-Rückstellung, dann still', async () => {
    const h = harness();
    await h.bridge.tick();
    h.calls.length = 0;
    h.ctl.paused = true;
    const r = await h.bridge.emergencyStop();
    assert.equal(r.ok, true);
    assert.deepEqual(h.calls, [['mode', 'off']]);
    h.advance(60_000);
    await h.bridge.tick();
    assert.deepEqual(h.calls, [['mode', 'off']], 'danach keine Writes');
  });

  test('von Hand umgestellt (evcc nicht mehr „now“): Not-Halt stoppt nicht, schaltet keine Phasen', async () => {
    const h = harness();
    await h.bridge.tick();
    h.calls.length = 0;
    h.lp.mode = 'minpv'; // Kunde hat in evcc selbst umgestellt
    h.ctl.paused = true;
    const r = await h.bridge.emergencyStop();
    assert.equal(r.ok, true);
    assert.deepEqual(h.calls, []);
  });
});

// Lese-Modus mit der echten evcc-Anbindung: Phasen und Max-Stopp gehen nicht raus.
function mockEvcc() {
  const requests = [];
  const state = { loadpoints: [{ title: 'Garage', mode: 'now', connected: true, charging: true, chargerPhases1p3p: true, phasesActive: 3 }] };
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/api/state' ? JSON.stringify(state) : '{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)),
  })));
}

test('Lese-Modus: Plan einphasig und Stopp am Max schicken nichts an evcc', async () => {
  const evcc = await mockEvcc();
  const cfg = { evcc: { url: evcc.url }, optimizer: { eosOptimizeEv: true, evEvccControl: true, evEvccLoadpoint: 1, evMaxChargeW: 11000, evPhases: 3 } };
  const integ = createEvccIntegration({ getCfg: () => cfg, pushLog: () => {} });
  await integ.refresh();
  let stop = null;
  let clock = T0 + 60_000;
  const bridge = createEosEvccBridge({
    getCfg: () => cfg,
    getSolution: async () => ({ generatedAt: '2026-11-16T21:58:00Z', slotMinutes: 15, rows: [0.25, 0.25].map((f, i) => ({ ts_utc: new Date(T0 + i * Q).toISOString(), evChargeFactor: f, evSocPct: 50 })) }),
    getCharger: (c, bc) => createEvccAdapter(integ, () => bc.loadpoint, () => bc.stopMode),
    getEvccLoadpoints: () => integ.getLoadpoints(),
    getGridCapW: () => null,
    getEvMaxStop: () => stop,
    now: () => clock,
  });
  process.env.DVHUB_READ_ONLY = '1';
  try {
    await bridge.tick();
    stop = { maxSocPct: 80, socPct: 85 };
    clock += 60_000;
    await bridge.tick({ force: true });
    assert.deepEqual(evcc.requests.filter((r) => r.startsWith('POST')), []);
  } finally {
    delete process.env.DVHUB_READ_ONLY;
    integ.stop();
    await evcc.close();
  }
});

describe('Konfig: Wochenplan-Übernahme und kaputte config.json', () => {
  const legacy = {
    optimizer: {
      evTargetMode: 'kwh', evTargetValue: 40, evCapacityWh: 60000, evCommuteKm: 20, evConsumptionKwhPer100km: 18,
      evWeeklyPlan: [{ day: 1, arrival: '17:00', departure: '07:00', targetValue: 30, commuteKm: 20 }],
    },
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dvhub-evplan-'));

  test('Laden rechnet nur im Speicher um — config.json bleibt bytegleich, erst Speichern schreibt das neue Format', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'config.json');
      const text = JSON.stringify(legacy, null, 2);
      fs.writeFileSync(file, text);
      const loaded = loadConfigFile(file);
      assert.equal(loaded.broken, false);
      assert.equal(loaded.rawConfig.optimizer.evWeeklyPlan[0].minSocPct, 50);
      assert.equal(loaded.rawConfig.optimizer.evTargetMode, 'percent');
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'Laden schreibt nichts');
      saveConfigFile(file, loaded.rawConfig);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.optimizer.evWeeklyPlan[0].minSocPct, 50);
      assert.equal('targetValue' in saved.optimizer.evWeeklyPlan[0], false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('kaputte config.json mit altem Wochenplan: gesichert, Vorgaben, Speichern ohne Bestätigung verweigert', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'config.json');
      const text = `${JSON.stringify(legacy)}\n}kaputt`;
      fs.writeFileSync(file, text);
      const loaded = loadConfigFile(file);
      assert.equal(loaded.broken, true);
      assert.ok(loaded.brokenCopyPath && fs.readFileSync(loaded.brokenCopyPath, 'utf8') === text, 'kaputter Stand gesichert');
      assert.equal(loaded.rawConfig.optimizer?.evWeeklyPlan ?? null, null, 'keine halbe Übernahme aus dem kaputten Stand');
      assert.throws(() => saveConfigFile(file, loaded.rawConfig), (e) => e.code === 'CONFIG_BROKEN');
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'nicht überschrieben');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('falsche Typen im Wochenplan werfen beim Laden nicht', () => {
    const dir = tmp();
    try {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(file, JSON.stringify({ optimizer: {
        evWeeklyPlan: [5, null, 'x', { day: 'a', targetValue: 'abc' }, { day: 2, arrival: 7, departure: {}, commuteKm: 'z' }],
        evTargetMode: 'km', evTargetValue: {}, evMaxSocPct: 'x',
      } }));
      const loaded = loadConfigFile(file);
      assert.equal(loaded.broken, false);
      assert.equal(loaded.rawConfig.optimizer.evWeeklyPlan.length, 7);
      fs.writeFileSync(file, JSON.stringify({ optimizer: 5 }));
      assert.doesNotThrow(() => loadConfigFile(file));
      fs.writeFileSync(file, JSON.stringify({ optimizer: { evWeeklyPlan: 'kaputt', evTargetMode: 'kwh', evTargetValue: 'abc' } }));
      assert.doesNotThrow(() => loadConfigFile(file));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
