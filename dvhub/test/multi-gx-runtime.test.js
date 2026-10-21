// test/multi-gx-runtime.test.js -- Laufzeitdienst fuer die zweite Victron-GX:
// liest Ladestand/Akkuleistung/Mindest-SoC, schreibt den Netz-Sollwert 2716/2717
// (int32, fluechtig → jeden Takt), erkennt Ausfall, folgt Not-Halt und
// Einspeisesperre. Modbus ist eine Attrappe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiGx } from '../services/multi-gx/index.js';

function fakeTransport({ soc = 60, batteryW = 0, minSocRaw = 150, fail = () => false } = {}) {
  const calls = [];
  const regs = { 843: soc, 842: batteryW < 0 ? batteryW + 65536 : batteryW, 2901: minSocRaw };
  return {
    calls,
    regs,
    async mbRequest(req) {
      calls.push({ op: 'read', ...req });
      if (fail(req)) throw new Error('timeout');
      return Array.from({ length: req.quantity || 1 }, (_, i) => regs[req.address + i] ?? 0);
    },
    async mbWriteMultiple(req) {
      calls.push({ op: 'write', ...req });
      if (fail(req)) throw new Error('timeout');
      return { addr: req.address, quantity: req.values.length };
    },
  };
}

function setup({ multiGx = {}, victron = {}, ctrl = {}, transport = fakeTransport() } = {}) {
  const cfg = {
    updateChannel: 'dev',
    gridPositiveMeans: 'grid_import',
    optimizer: { batteryCapacityWh: 64000, maxSocPct: 100, maxDischargeW: 10000 },
    multiGx: { enabled: true, host: '192.168.1.20', port: 502, unitId: 100, batteryCapacityWh: 64000,
      maxChargeW: 10000, maxDischargeW: 10000, minSocPct: 10, rampWPerS: 200, deadbandW: 300, ...multiGx },
  };
  const state = {
    victron: { soc: 60, batteryPowerW: -4000, minSocPct: 10, errors: {}, gridSetpointW: 0, ...victron },
    meter: { ok: true, grid_total_w: 0 },
    ctrl: { forcedOff: false, discretionaryWritesPaused: false, negativePriceActive: false, ...ctrl },
  };
  const logs = [];
  let t = 0;
  const availability = [];
  const mgx = createMultiGx({ getCfg: () => cfg, state, pushLog: (e, d) => logs.push([e, d]),
    onMultiGxAvailability: (included) => availability.push(included) },
    { transport, now: () => t });
  const tick = async (ms = 5000) => { t += ms; await mgx.tick(); };
  return { cfg, state, logs, transport, mgx, tick, availability, setNow: (v) => { t = v; } };
}

const writes = (tr) => tr.calls.filter((c) => c.op === 'write');
const int32 = (words) => ((words[0] << 16) | words[1]) >> 0;

test('aus: keine einzige Modbus-Anfrage', async () => {
  const s = setup({ multiGx: { enabled: false } });
  await s.tick(); await s.tick();
  assert.equal(s.transport.calls.length, 0);
  assert.equal(s.state.multiGx.enabled, false);
});

test('Stable-Kanal: Beta gesperrt, keine Anfrage trotz Schalter', async () => {
  const s = setup();
  s.cfg.updateChannel = 'stable';
  await s.tick(); await s.tick();
  assert.equal(s.transport.calls.length, 0);
  assert.equal(s.state.multiGx.enabled, false);
});

test('an, aber ohne Adresse: keine Anfrage, Grund im Zustand', async () => {
  const s = setup({ multiGx: { host: '' } });
  await s.tick();
  assert.equal(s.transport.calls.length, 0);
  assert.equal(s.state.multiGx.reason, 'not_configured');
});

test('liest Ladestand, Akkuleistung, Mindest-SoC und schreibt 2716 als int32 an Unit 100', async () => {
  const tr = fakeTransport({ soc: 60, batteryW: 0, minSocRaw: 150 });
  const s = setup({ transport: tr });
  for (let i = 0; i < 6; i++) await s.tick();
  const reads = tr.calls.filter((c) => c.op === 'read').map((c) => c.address);
  assert.ok([843, 842, 2901].every((a) => reads.includes(a)));
  assert.ok(tr.calls.every((c) => c.host === '192.168.1.20' && c.port === 502 && c.unitId === 100));
  const w = writes(tr);
  assert.equal(w.length, 6, 'fluechtiges Register: jeden Takt schreiben');
  assert.ok(w.every((c) => c.address === 2716 && c.values.length === 2));
  const last = int32(w.at(-1).values);
  assert.ok(last < 0, `zweite Anlage soll mitentladen, Sollwert ${last}`);
  assert.equal(s.state.multiGx.socPct, 60);
  assert.equal(s.state.multiGx.minSocPct, 15);
  assert.equal(s.state.multiGx.online, true);
  assert.equal(s.state.multiGx.setpointW, last);
});

test('negativer Sollwert korrekt als Zweierkomplement kodiert', async () => {
  const tr = fakeTransport();
  const s = setup({ transport: tr });
  for (let i = 0; i < 12; i++) await s.tick();
  const v = writes(tr).at(-1).values;
  assert.equal(int32(v), s.state.multiGx.setpointW);
  assert.ok(v[0] === 0xffff, 'oberes Wort bei kleinem negativem Wert 0xFFFF');
});

test('drei Fehlversuche: offline, Sollwert 0, Meldung einmal im Protokoll; danach wieder online', async () => {
  let down = false;
  const tr = fakeTransport({ fail: () => down });
  const s = setup({ transport: tr });
  for (let i = 0; i < 6; i++) await s.tick();
  down = true;
  for (let i = 0; i < 4; i++) await s.tick();
  assert.equal(s.state.multiGx.online, false);
  assert.equal(s.state.multiGx.setpointW, 0);
  assert.equal(s.logs.filter(([e]) => e === 'multi_gx_offline').length, 1);
  down = false;
  await s.tick();
  assert.equal(s.state.multiGx.online, true);
  assert.ok(Math.abs(s.state.multiGx.setpointW) <= 1000, 'nach Rueckkehr traege von 0');
  assert.equal(s.logs.filter(([e]) => e === 'multi_gx_online').length, 1);
});

test('Not-Halt: sofort 0 an die zweite Anlage', async () => {
  const tr = fakeTransport();
  const s = setup({ transport: tr });
  for (let i = 0; i < 8; i++) await s.tick();
  s.state.ctrl.discretionaryWritesPaused = true;
  await s.tick();
  assert.equal(int32(writes(tr).at(-1).values), 0);
  assert.equal(s.state.multiGx.reason, 'stop');
});

test('Direktvermarkter-Abregelung oder negativer Preis: zweite Anlage speist nicht ins Hausnetz', async () => {
  for (const ctrl of [{ forcedOff: true }, { negativePriceActive: true }]) {
    const tr = fakeTransport();
    const s = setup({ transport: tr, ctrl });
    for (let i = 0; i < 10; i++) await s.tick();
    assert.ok(writes(tr).every((c) => int32(c.values) >= 0), JSON.stringify(ctrl));
  }
});

test('Hauptanlage ohne frische Akkuleistung: kein Anteil, Sollwert laeuft gegen 0', async () => {
  const tr = fakeTransport();
  const s = setup({ transport: tr });
  for (let i = 0; i < 8; i++) await s.tick();
  s.state.victron.errors.batteryPowerW = 'timeout';
  await s.tick();
  assert.equal(s.state.multiGx.reason, 'no_data');
});

test('ausschalten nach Betrieb: einmal 0 schreiben, danach Ruhe', async () => {
  const tr = fakeTransport();
  const s = setup({ transport: tr });
  for (let i = 0; i < 6; i++) await s.tick();
  s.cfg.multiGx.enabled = false;
  await s.tick();
  const n = tr.calls.length;
  assert.equal(int32(writes(tr).at(-1).values), 0);
  await s.tick(); await s.tick();
  assert.equal(tr.calls.length, n);
});

test('Einstellung geaendert: Regler startet neu bei 0 (kein Sprung mit alten Grenzen)', async () => {
  const tr = fakeTransport();
  const s = setup({ transport: tr });
  for (let i = 0; i < 10; i++) await s.tick();
  s.cfg.multiGx.maxDischargeW = 500;
  await s.tick();
  assert.ok(Math.abs(s.state.multiGx.setpointW) <= 500);
});

// Codex-Gegenpruefung 21.10.
test('eingefrorene oder abweichende Messwerte der Hauptanlage: kein Anteil (no_data)', async () => {
  for (const v of [{ freeze: { active: true } }, { sourceMismatch: { active: true } }]) {
    const s = setup({ victron: v });
    for (let i = 0; i < 4; i++) await s.tick();
    assert.equal(s.state.multiGx.reason, 'no_data', JSON.stringify(v));
  }
});

test('veralteter Zeitstempel der Akkuleistung (> 30 s): kein Anteil', async () => {
  const s = setup();
  await s.tick();
  s.state.victron.fieldUpdatedAt = { batteryPowerW: 0 };
  s.setNow(60000);
  await s.tick();
  assert.equal(s.state.multiGx.reason, 'no_data');
});

test('Lesen klappt, Schreiben scheitert dreimal: nicht steuerbar, EOS rechnet ohne sie', async () => {
  const tr = fakeTransport({ fail: (req) => req.address === 2716 });
  const s = setup({ transport: tr });
  for (let i = 0; i < 5; i++) await s.tick();
  assert.equal(s.state.multiGx.online, false);
  assert.equal(s.logs.filter(([e]) => e === 'multi_gx_offline').length, 1);
});

test('langsame GX: Takte ueberlappen nicht', async () => {
  let inFlight = 0; let maxInFlight = 0;
  const tr = fakeTransport();
  const slowRead = tr.mbRequest;
  tr.mbRequest = async (req) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return slowRead(req); };
  const s = setup({ transport: tr });
  await Promise.all([s.mgx.tick(), s.mgx.tick(), s.mgx.tick()]);
  assert.equal(maxInFlight, 1);
  assert.equal(tr.calls.filter((c) => c.op === 'write').length, 1, 'nur ein Takt lief');
});

test('Erreichbarkeit wechselt: EOS wird neu abgeglichen (an/aus je einmal)', async () => {
  let down = false;
  const s = setup({ transport: fakeTransport({ fail: () => down }) });
  for (let i = 0; i < 3; i++) await s.tick();
  down = true;
  for (let i = 0; i < 4; i++) await s.tick();
  down = false;
  await s.tick();
  assert.deepEqual(s.availability, [true, false, true]);
});

test('Hauptanlage leer und Haus bezieht ueber dem Sollwert: ungedeckter Bedarf geht an die zweite Anlage', async () => {
  const tr = fakeTransport({ soc: 80 });
  const s = setup({ transport: tr, victron: { soc: 10, minSocPct: 10, batteryPowerW: 0 } });
  s.state.meter.grid_total_w = 3000;
  for (let i = 0; i < 6; i++) await s.tick();
  assert.ok(s.state.multiGx.setpointW < -500, `Sollwert ${s.state.multiGx.setpointW}`);
});

test('Einspeisegrenze haelt das Netz ueber dem Sollwert, Hauptanlage laedt: KEIN ungedeckter Bedarf', async () => {
  const s = setup({ victron: { soc: 50, batteryPowerW: 3000, gridSetpointW: -10000 } });
  s.state.meter.grid_total_w = -6000; // Netz bei -6 kW gedeckelt
  for (let i = 0; i < 6; i++) await s.tick();
  assert.ok(s.state.multiGx.desiredBatteryW >= 0, `zweite Anlage soll nicht in die Hauptanlage entladen (${s.state.multiGx.desiredBatteryW})`);
});

// Codex-Gegenpruefung Runde 2 (21.10.)
test('liest den AC-IN der zweiten Anlage (820–822, ohne Zaehler = AC-IN) und meldet ihn', async () => {
  const tr = fakeTransport();
  Object.assign(tr.regs, { 820: 400, 821: 0x10000 - 100, 822: 300 });
  const s = setup({ transport: tr });
  await s.tick();
  assert.ok(tr.calls.some((c) => c.op === 'read' && c.address === 820 && c.quantity === 3));
  assert.equal(s.state.multiGx.acInW, 600);
});

test('Hauptanlage voll, Netz soll laden: Ladebedarf geht an die zweite Anlage', async () => {
  const s = setup({ victron: { soc: 100, batteryPowerW: 0, gridSetpointW: 4000 } });
  s.state.meter.grid_total_w = 0;
  for (let i = 0; i < 6; i++) await s.tick();
  assert.ok(s.state.multiGx.setpointW > 500, `Sollwert ${s.state.multiGx.setpointW}`);
});

test('Hauptanlage an der Wechselrichter-Grenze: Rest des Exports geht an die zweite Anlage', async () => {
  const s = setup({ victron: { soc: 60, batteryPowerW: -5000, gridSetpointW: -12000 } });
  s.cfg.optimizer.inverterMaxPowerW = 5000;
  s.state.meter.grid_total_w = -5000;
  for (let i = 0; i < 6; i++) await s.tick();
  // normaler Anteil waere -2500 (Haelfte von -5000); mit dem fehlenden Export
  // (7 kW) zusammen -6000
  assert.ok(s.state.multiGx.desiredBatteryW <= -5500, `Soll-Anteil ${s.state.multiGx.desiredBatteryW}`);
});

test('EOS-Abgleich nach Wechsel: Neuplan nur nach erfolgreichem Sync, sonst erneut versuchen', async () => {
  const { createEosResyncOnAvailability } = await import('../services/multi-gx/index.js');
  const calls = [];
  const timers = [];
  let ok = false;
  const handler = createEosResyncOnAvailability({
    sync: async () => { calls.push('sync'); return ok ? { ok: true } : { ok: false, errors: { battery: 'HTTP 500' } }; },
    replan: (reason) => calls.push(`replan:${reason}`),
    pushLog: (e) => calls.push(`log:${e}`),
    setTimer: (fn) => timers.push(fn),
    maxRetries: 3,
  });
  await handler(true);
  assert.deepEqual(calls, ['sync', 'log:multi_gx_eos_resync_failed'], 'kein Neuplan mit altem Akku-Modell');
  ok = true;
  await timers.shift()();
  assert.deepEqual(calls.slice(2), ['sync', 'replan:multi_gx_online']);
});

test('EOS-Abgleich: gibt nach maxRetries auf, ein neuer Wechsel ersetzt den alten Versuch', async () => {
  const { createEosResyncOnAvailability } = await import('../services/multi-gx/index.js');
  const calls = [];
  const timers = [];
  const handler = createEosResyncOnAvailability({
    sync: async () => { calls.push('sync'); return { ok: false }; },
    replan: () => calls.push('replan'),
    pushLog: () => {},
    setTimer: (fn) => timers.push(fn),
    maxRetries: 2,
  });
  await handler(false);
  await timers.shift()();
  await timers.shift()();
  assert.equal(timers.length, 0, 'nach 2 Wiederholungen Schluss');
  assert.equal(calls.filter((c) => c === 'replan').length, 0);
});

test('Not-Halt schreibt 0, auch wenn das Lesen gerade scheitert', async () => {
  let readFail = false;
  const tr = fakeTransport({ fail: (req) => readFail && req.address !== 2716 });
  const s = setup({ transport: tr });
  for (let i = 0; i < 6; i++) await s.tick();
  readFail = true;
  s.state.ctrl.discretionaryWritesPaused = true;
  await s.tick();
  const w = tr.calls.filter((c) => c.op === 'write');
  assert.equal(((w.at(-1).values[0] << 16) | w.at(-1).values[1]) >> 0, 0);
  assert.ok(w.at(-1) === tr.calls.at(-1), 'die 0 war der letzte Schreibzugriff');
});
