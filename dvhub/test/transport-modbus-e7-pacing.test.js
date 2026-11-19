// E7 (18.11.2026): Anfrage-Taktung je Verbindung im echten Modbus-Transport, mit falscher Uhr.
//
// Ohne Einstellung (jedes mitgelieferte Stable-Profil) muss der Transport auf dem Draht genau so laufen wie vorher:
// gleiche Reihenfolge, gleiche Zeitpunkte, gleiche Ergebnisse — auch mit Schreib-Sperre (A7) und Zeitüberschreitung
// (A4). Mit Einstellung gelten Abstand, Pause nach dem Verbindungsaufbau und Registerdeckel für Lesen UND Schreiben;
// Not-Halt-Sperre und Lese-Modus wirken wie bisher.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createModbusTransport, fenceModbusWrites, normalizeModbusPacing, modbusPacingFromConfig,
} from '../transport-modbus.js';
import { classifyModbusError } from '../services/gate/index.js';
import { createRegisterDevice, createPollerRig } from './helpers/fake-modbus-device.js';
import { installFakeModbusSockets, advance, flush, enableFakeClock, disableFakeClock } from './helpers/fake-modbus-socket.js';

const HOST = '192.0.2.81';
const OTHER = '192.0.2.82';
const base = (extra = {}) => ({ host: HOST, port: 502, unitId: 1, timeoutMs: 1000, ...extra });

// Ein Prüfstand je Test: falsche Uhr, Schein-Sockets, Transport mit pacingFor.
function rig(pacingFor, opts = {}) {
  enableFakeClock();
  const sockets = installFakeModbusSockets(opts.socket);
  const transport = createModbusTransport({ ...(pacingFor !== undefined ? { pacingFor } : {}), ...(opts.transport || {}) });
  const t0 = Date.now();
  const settled = [];
  const track = (label, p) => p.then(
    (v) => { settled.push({ label, ok: true, t: Date.now() - t0, v }); return v; },
    (e) => { settled.push({ label, ok: false, t: Date.now() - t0, error: e.message }); return e; },
  );
  return {
    sockets, transport, settled, track,
    async done() {
      await transport.destroy();
      await flush();
      sockets.restore();
      disableFakeClock();
    },
  };
}

const wireTimes = (wire) => wire.map((f) => f.t);
const wireAddrs = (wire) => wire.map((f) => f.address);

// --- Null-Änderung ohne Einstellung --------------------------------------------------------------------------------

// Gemischte Reads und Writes in einem Zug, eine Not-Halt-Sperre mittendrin, ein langer Block, eine Zeitüberschreitung.
async function baselineScenario(r) {
  const { transport, sockets, track } = r;
  sockets.silence(130);
  track('r1', transport.mbRequest(base({ fc: 3, address: 100, quantity: 2 })));
  track('w1', transport.mbWriteSingle(base({ address: 200, value: 1 })));
  track('r2', transport.mbRequest(base({ fc: 4, address: 110, quantity: 1 })));
  track('w2', transport.mbWriteMultiple(base({ address: 210, values: [1, 2] })));
  fenceModbusWrites();
  track('w3', transport.mbWriteSingle(base({ address: 220, value: 0 })));
  track('r3', transport.mbRequest(base({ fc: 3, address: 120, quantity: 30 })));
  track('r4', transport.mbRequest(base({ fc: 3, address: 130, quantity: 1, timeoutMs: 500 })));
  track('r5', transport.mbRequest(base({ fc: 3, address: 140, quantity: 1 })));
  await advance(2000);
  return {
    wire: sockets.wire.map(({ t, fc, address, quantity, value, values }) => ({ t, fc, address, quantity, value, values })),
    events: sockets.events.map(({ t, ev }) => `${t}:${ev}`),
    settled: r.settled.map(({ label, ok, t, error }) => `${label}:${ok ? 'ok' : error}@${t}`),
  };
}

// Stand vor E7 (24eabf21), einmal mit derselben Szenerie gegen die alte transport-modbus.js aufgenommen: alles zur
// Zeit 0 in Einreihungs-Reihenfolge (r1 noch vor dem connect-Ereignis, wie bei net.Socket), w1/w2 von der Sperre
// verworfen, r4 läuft nach 500 ms ab, danach Neuaufbau und r5 sofort.
const BASELINE = {
  wire: [
    { t: 0, fc: 3, address: 100, quantity: 2, value: undefined, values: undefined },
    { t: 0, fc: 4, address: 110, quantity: 1, value: undefined, values: undefined },
    { t: 0, fc: 6, address: 220, quantity: undefined, value: 0, values: undefined },
    { t: 0, fc: 3, address: 120, quantity: 30, value: undefined, values: undefined },
    { t: 0, fc: 3, address: 130, quantity: 1, value: undefined, values: undefined },
    { t: 500, fc: 3, address: 140, quantity: 1, value: undefined, values: undefined },
  ],
  events: ['0:connect', '500:close', '500:connect'],
  settled: [
    'r1:ok@0',
    'w1:modbus write verworfen (Not-Halt seit dem Einreihen)@0',
    'r2:ok@0',
    'w2:modbus write verworfen (Not-Halt seit dem Einreihen)@0',
    'w3:ok@0',
    'r3:ok@0',
    'r4:modbus timeout@500',
    'r5:ok@500',
  ],
};

test('ohne Einstellung: Draht, Zeitpunkte und Ergebnisse wie vor E7 — für jede Form von „keine Taktung“', async () => {
  const variants = [
    ['kein pacingFor', undefined],
    ['Resolver liefert null', () => null],
    ['leerer Block', () => ({})],
    ['alles 0', () => ({ minRequestGapMs: 0, connectDelayMs: 0, maxRegistersPerRequest: 0 })],
    ['ungültige Werte', () => ({ minRequestGapMs: 'x', connectDelayMs: -5, maxRegistersPerRequest: 1.5 })],
    ['Taktung nur für eine andere Adresse', (host) => (host === OTHER ? { minRequestGapMs: 10000, connectDelayMs: 1000, maxRegistersPerRequest: 4 } : null)],
    ['Resolver wirft', () => { throw new Error('kaputt'); }],
  ];
  for (const [name, pacingFor] of variants) {
    const r = rig(pacingFor);
    try {
      assert.deepEqual(await baselineScenario(r), BASELINE, name);
    } finally {
      await r.done();
    }
  }
});

test('ohne Einstellung: die nächste Anfrage geht im selben Takt wie die Antwort raus (keine virtuelle Zeit vergeht)', async () => {
  const r = rig(undefined, { socket: { respondDelayMs: 7 } });
  try {
    for (let i = 0; i < 5; i += 1) r.track(`r${i}`, r.transport.mbRequest(base({ fc: 3, address: 300 + i, quantity: 1 })));
    await advance(200, 1);
    assert.deepEqual(wireTimes(r.sockets.wire), [0, 7, 14, 21, 28], 'Abstand = nur die Antwortzeit des Geräts');
    assert.deepEqual(wireAddrs(r.sockets.wire), [300, 301, 302, 303, 304]);
  } finally {
    await r.done();
  }
});

// --- Abstand ---------------------------------------------------------------------------------------------------------

test('minRequestGapMs: Abstand ab dem Ende der vorigen Anfrage, auch wenn alles in einem Zug eingereiht ist', async () => {
  const r = rig(() => ({ minRequestGapMs: 10000 }), { socket: { respondDelayMs: 300 } });
  try {
    for (const a of [10, 20, 30]) r.track(`r${a}`, r.transport.mbRequest(base({ fc: 3, address: a, quantity: 2 })));
    await advance(25000);
    assert.deepEqual(wireTimes(r.sockets.wire), [0, 10300, 20600], 'Ende (Antwort nach 300 ms) + 10 s');
    assert.deepEqual(r.settled.map((s) => [s.label, s.ok, s.t]), [['r10', true, 300], ['r20', true, 10600], ['r30', true, 20900]]);
    // Die Wartezeit in der Schlange zählt nicht gegen das Zeitlimit der Anfrage (1000 ms).
    assert.ok(r.settled.every((s) => s.ok));
  } finally {
    await r.done();
  }
});

test('minRequestGapMs gilt je Verbindung: eine andere Adresse ohne Taktung wartet nicht', async () => {
  const r = rig((host) => (host === HOST ? { minRequestGapMs: 10000 } : null));
  try {
    r.track('a1', r.transport.mbRequest(base({ fc: 3, address: 1, quantity: 1 })));
    r.track('a2', r.transport.mbRequest(base({ fc: 3, address: 2, quantity: 1 })));
    r.track('b1', r.transport.mbRequest(base({ host: OTHER, fc: 3, address: 3, quantity: 1 })));
    r.track('b2', r.transport.mbRequest(base({ host: OTHER, fc: 3, address: 4, quantity: 1 })));
    await advance(11000);
    assert.deepEqual(r.sockets.wire.map((f) => `${f.address}@${f.t}`).sort(), ['1@0', '2@10000', '3@0', '4@0']);
  } finally {
    await r.done();
  }
});

test('Lesen und Schreiben gemischt: Reihenfolge der Warteschlange, Writes nie vertauscht, jeder Transfer im Abstand', async () => {
  const r = rig(() => ({ minRequestGapMs: 1000 }));
  try {
    const t = r.transport;
    r.track('r1', t.mbRequest(base({ fc: 3, address: 1, quantity: 1 })));
    r.track('w1', t.mbWriteSingle(base({ address: 500, value: 11 })));
    r.track('r2', t.mbRequest(base({ fc: 4, address: 2, quantity: 1 })));
    r.track('w2', t.mbWriteMultiple(base({ address: 501, values: [22, 23] })));
    r.track('w3', t.mbWriteSingle(base({ address: 502, value: 33 })));
    r.track('w4', t.mbWriteCoil(base({ address: 503, value: true })));
    r.track('r3', t.mbRequest(base({ fc: 3, address: 3, quantity: 1 })));
    await advance(8000);
    assert.deepEqual(r.sockets.wire.map((f) => `${f.fc}:${f.address}@${f.t}`),
      ['3:1@0', '6:500@1000', '4:2@2000', '16:501@3000', '6:502@4000', '5:503@5000', '3:3@6000']);
    assert.deepEqual(r.sockets.wire.filter((f) => f.fc >= 5).map((f) => f.value ?? f.values),
      [11, [22, 23], 33, 0xff00], 'Writes in Einreihungs-Reihenfolge mit ihren Werten');
    assert.ok(r.settled.every((s) => s.ok), JSON.stringify(r.settled));
  } finally {
    await r.done();
  }
});

// --- Not-Halt-Sperre und Lese-Modus ----------------------------------------------------------------------------------

test('Not-Halt während ein Write auf seinen Abstand wartet: der Write geht nicht raus, die Rücknahme danach schon', async () => {
  const r = rig(() => ({ minRequestGapMs: 10000 }));
  try {
    const t = r.transport;
    r.track('read', t.mbRequest(base({ fc: 3, address: 10, quantity: 1 })));
    const stale = r.track('stale', t.mbWriteSingle(base({ address: 2716, value: 5000 })));
    await advance(5000);
    assert.deepEqual(r.sockets.wire.map((f) => f.address), [10], 'der Write wartet noch auf seinen Abstand');
    fenceModbusWrites();
    r.track('neutral', t.mbWriteSingle(base({ address: 2716, value: 0 })));
    await advance(10000);
    const err = await stale;
    assert.match(err.message, /Not-Halt/);
    assert.equal(classifyModbusError(err).delivery, 'notSent', 'das Schreibtor wertet ihn als nie gesendet');
    assert.deepEqual(r.sockets.wire.filter((f) => f.fc === 6).map((f) => [f.value, f.t]), [[0, 10000]],
      'nur die Rücknahme am Gerät, im Abstand zur letzten echten Anfrage');
    assert.deepEqual(r.settled.find((s) => s.label === 'stale').t, 10000, 'verworfen beim Senden, nicht vorher');
  } finally {
    await r.done();
  }
});

test('Lese-Modus (DVHUB_READ_ONLY=1): Writes sofort abgelehnt, ohne auf den Abstand zu warten; Reads weiter getaktet', async () => {
  const before = process.env.DVHUB_READ_ONLY;
  process.env.DVHUB_READ_ONLY = '1';
  const warn = console.warn;
  console.warn = () => {};
  const r = rig(() => ({ minRequestGapMs: 10000 }));
  try {
    r.track('r1', r.transport.mbRequest(base({ fc: 3, address: 1, quantity: 1 })));
    r.track('w1', r.transport.mbWriteSingle(base({ address: 2716, value: 1 })));
    r.track('r2', r.transport.mbRequest(base({ fc: 3, address: 2, quantity: 1 })));
    await advance(11000);
    const w1 = r.settled.find((s) => s.label === 'w1');
    assert.equal(w1.ok, false);
    assert.match(w1.error, /Lese-Modus/);
    assert.equal(w1.t, 0);
    assert.deepEqual(r.sockets.wire.map((f) => `${f.fc}:${f.address}@${f.t}`), ['3:1@0', '3:2@10000']);
  } finally {
    await r.done();
    console.warn = warn;
    if (before === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = before;
  }
});

// --- Pause nach dem Verbindungsaufbau ---------------------------------------------------------------------------------

test('connectDelayMs: erste Anfrage erst nach der Pause, auch nach Zeitüberschreitung und dropConnections', async () => {
  const r = rig(() => ({ connectDelayMs: 1000 }), { socket: { connectLatencyMs: 200 } });
  try {
    const t = r.transport;
    r.sockets.silence(3);
    r.track('r1', t.mbRequest(base({ fc: 3, address: 1, quantity: 1 })));
    r.track('r2', t.mbRequest(base({ fc: 3, address: 2, quantity: 1 })));
    r.track('r3', t.mbRequest(base({ fc: 3, address: 3, quantity: 1, timeoutMs: 500 })));
    r.track('r4', t.mbRequest(base({ fc: 3, address: 4, quantity: 1 })));
    await advance(5000);
    // connect 200 → Pause → 1200; r3 läuft ab (1700), Neuaufbau (+200 = 1900), Pause → 2900.
    assert.deepEqual(r.sockets.events.map((e) => `${e.ev}@${e.t}`), ['connect@200', 'close@1700', 'connect@1900']);
    assert.deepEqual(r.sockets.wire.map((f) => `${f.address}@${f.t}`), ['1@1200', '2@1200', '3@1200', '4@2900']);
    assert.equal(t.dropConnections(), 1);
    r.track('r5', t.mbRequest(base({ fc: 3, address: 5, quantity: 1 })));
    await advance(3000);
    assert.deepEqual(r.sockets.wire.at(-1), { t: 5000 + 200 + 1000, fc: 3, unitId: 1, address: 5, quantity: 1 });
  } finally {
    await r.done();
  }
});

test('Abstand gilt über einen Neuaufbau hinweg (dropConnections, Leerlauf-Abbau)', async () => {
  const r = rig(() => ({ minRequestGapMs: 5000, connectDelayMs: 100 }), { transport: { idleMs: 300 } });
  try {
    const t = r.transport;
    r.track('r1', t.mbRequest(base({ fc: 3, address: 1, quantity: 1 })));
    await advance(1000);
    t.dropConnections();
    r.track('r2', t.mbRequest(base({ fc: 3, address: 2, quantity: 1 })));
    await advance(6000);
    // r1 bei 100 (Pause), Ende 100 → r2 frühestens 5100, obwohl die neue Verbindung schon ab 1000 + 100 bereit wäre.
    assert.deepEqual(r.sockets.wire.map((f) => `${f.address}@${f.t}`), ['1@100', '2@5100']);
  } finally {
    await r.done();
  }
});

test('Leerlauf-Abbau bricht keine Anfrage ab, die länger als idleMs auf ihren Abstand wartet', async () => {
  const r = rig(() => ({ minRequestGapMs: 1000 }), { transport: { idleMs: 300 } });
  try {
    r.track('r1', r.transport.mbRequest(base({ fc: 3, address: 1, quantity: 1 })));
    r.track('r2', r.transport.mbRequest(base({ fc: 3, address: 2, quantity: 1 })));
    await advance(1500);
    assert.deepEqual(r.settled.map((s) => [s.label, s.ok, s.t]), [['r1', true, 0], ['r2', true, 1000]]);
    await advance(500);
    assert.equal(r.sockets.events.at(-1).ev, 'close', 'danach baut der Leerlauf die Verbindung wie bisher ab');
  } finally {
    await r.done();
  }
});

// --- Registerdeckel --------------------------------------------------------------------------------------------------

test('maxRegistersPerRequest: ein Block wird in Teil-Anfragen zerlegt, getaktet, und in Reihenfolge zusammengesetzt', async () => {
  const r = rig(() => ({ minRequestGapMs: 1000, maxRegistersPerRequest: 10 }));
  try {
    for (let i = 0; i < 24; i += 1) r.sockets.set(1, 30771 + i, 1000 + i);
    const block = r.track('block', r.transport.mbRequest(base({ fc: 3, address: 30771, quantity: 24 })));
    r.track('after', r.transport.mbWriteSingle(base({ address: 40000, value: 7 })));
    await advance(5000);
    assert.deepEqual(r.sockets.wire.map((f) => `${f.fc}:${f.address}x${f.quantity ?? '-'}@${f.t}`),
      ['3:30771x10@0', '3:30781x10@1000', '3:30791x4@2000', '6:40000x-@3000'],
      'Teile direkt hintereinander, der danach eingereihte Write erst nach dem letzten Teil');
    assert.deepEqual(await block, Array.from({ length: 24 }, (_, i) => 1000 + i));
  } finally {
    await r.done();
  }
});

test('maxRegistersPerRequest: Blöcke bis zum Deckel und FC 1/2 (Bits) bleiben eine Anfrage; ein Fehler im Teil = Lesefehler', async () => {
  const r = rig(() => ({ maxRegistersPerRequest: 10 }));
  try {
    r.track('ten', r.transport.mbRequest(base({ fc: 4, address: 100, quantity: 10 })));
    r.track('coils', r.transport.mbRequest(base({ fc: 1, address: 200, quantity: 24 })));
    await advance(100);
    assert.deepEqual(r.sockets.wire.map((f) => `${f.fc}:${f.address}x${f.quantity}`), ['4:100x10', '1:200x24']);
    r.sockets.silence(310);
    const p = r.track('split', r.transport.mbRequest(base({ fc: 3, address: 300, quantity: 20, timeoutMs: 400 })));
    await advance(1000);
    assert.match((await p).message, /modbus timeout/);
  } finally {
    await r.done();
  }
});

// Codex 742c52c9 (P2): der Deckel darf eine Lesung, die EIN Messzeitpunkt sein muss, nicht zerlegen — sonst stammen
// die Teile aus verschiedenen Proben (Richtungswechsel zwischen den Teil-Anfragen → erfundener Wert). Die Lese-Engine
// markiert ihre Lesungen als atomar; was über dem Deckel liegt, ist ein Lesefehler mit klarer Meldung statt einer
// Mischung. Blöcke ohne Markierung (z. B. Zählerblock Summe + Phasen) zerlegt der Transport weiter.
test('Codex 742c52c9: atomare Lesungen der Lese-Engine werden nie zerlegt — Lesefehler statt Mischwert', async () => {
  const { readPointValue } = await import('../services/inverter/point-read.js');
  const r = rig(() => ({ minRequestGapMs: 1000, maxRegistersPerRequest: 4 }));
  const read = (c, o) => r.transport.mbRequest(c, o);
  try {
    // combineBlock über 7 Register (int32 bei 100 und 105): 2000 W Bezug, nach der ersten Anfrage 500 W Einspeisung.
    r.sockets.set32(1, 100, 2000).set32(1, 105, 0);
    const grid = { ...base({ fc: 3 }), readType: 'int32', combineBlock: true, combine: [{ address: 100 }, { address: 105, sign: -1 }] };
    const p = readPointValue(grid, read).then((v) => v, (e) => e);
    await advance(500);
    r.sockets.set32(1, 100, 0).set32(1, 105, 500);
    await advance(3000);
    const got = await p;
    assert.ok(got instanceof Error, `kein Mischwert (bekam ${got})`);
    assert.match(got.message, /7 Register .*in einer Anfrage.*höchstens 4/);
    // Wert + Skalenfaktor im Block (Spanne 6) ebenso; ein 32-bit-Wert bei Deckel 1 ebenso.
    const sf = { ...base({ fc: 3 }), address: 200, quantity: 1, signed: true, sfAddress: 205 };
    await assert.rejects(() => readPointValue(sf, (c, o) => r.transport.mbRequest(c, o)), /höchstens 4/);
    const wire = r.sockets.wire.length;
    // Ein gewöhnlicher Punkt bis zum Deckel geht wie bisher in einer Anfrage.
    r.sockets.set32(1, 300, 1234);
    const one = readPointValue({ ...base({ fc: 3 }), address: 300, quantity: 2, readType: 'int32' }, read);
    await advance(3000);
    assert.equal(await one, 1234);
    assert.deepEqual(r.sockets.wire.slice(wire).map((f) => `${f.address}x${f.quantity}`), ['300x2']);
    assert.ok(!r.sockets.wire.some((f) => f.address === 104), 'kein Teil-Block auf dem Draht');
  } finally {
    await r.done();
  }
});

test('Codex 742c52c9: ein 32-bit-Punkt bei ungeradem Deckel 1 wird nicht in zwei Hälften gelesen', async () => {
  const { readPointValue } = await import('../services/inverter/point-read.js');
  const r = rig(() => ({ maxRegistersPerRequest: 1 }));
  try {
    r.sockets.set32(1, 10, 70000);
    const p = readPointValue({ ...base({ fc: 3 }), address: 10, quantity: 2, readType: 'uint32' }, (c, o) => r.transport.mbRequest(c, o))
      .then((v) => v, (e) => e);
    await advance(100);
    const got = await p;
    assert.ok(got instanceof Error, `keine zusammengesetzten Hälften (bekam ${got})`);
    assert.match(got.message, /2 Register .*höchstens 1/);
    assert.equal(r.sockets.wire.length, 0);
  } finally {
    await r.done();
  }
});

// --- Einstellungen ---------------------------------------------------------------------------------------------------

test('normalizeModbusPacing: nur gültige positive Werte zählen, sonst „aus“', () => {
  assert.equal(normalizeModbusPacing(undefined), null);
  assert.equal(normalizeModbusPacing([]), null);
  assert.equal(normalizeModbusPacing({}), null);
  assert.equal(normalizeModbusPacing({ minRequestGapMs: 0, connectDelayMs: '', maxRegistersPerRequest: 125 }), null);
  assert.deepEqual(normalizeModbusPacing({ minRequestGapMs: 10000, maxRegistersPerRequest: 10, minPollIntervalMs: 10000, _comment: 'x' }),
    { minRequestGapMs: 10000, connectDelayMs: 0, maxRegistersPerRequest: 10 });
  assert.deepEqual(normalizeModbusPacing({ connectDelayMs: 999999, minRequestGapMs: 1e9 }),
    { minRequestGapMs: 600000, connectDelayMs: 60000, maxRegistersPerRequest: 0 }, 'gedeckelt');
});

test('modbusPacingFromConfig: nur victron.host:victron.port des Profils, nie MQTT, liest die Config live', () => {
  let cfg = { victron: { transport: 'modbus', host: HOST, port: 502, requestPacing: { minRequestGapMs: 10000 } } };
  const pacingFor = modbusPacingFromConfig(() => cfg);
  assert.deepEqual(pacingFor(HOST, 502), { minRequestGapMs: 10000 });
  assert.equal(pacingFor(HOST, 1502), null, 'anderer Port = andere Verbindung');
  assert.equal(pacingFor(OTHER, 502), null, 'Wallbox, Zähler an anderer Adresse');
  cfg = { victron: { ...cfg.victron, transport: 'mqtt' } };
  assert.equal(pacingFor(HOST, 502), null);
  cfg = { victron: { transport: 'modbus', host: HOST, port: 502 } };
  assert.equal(pacingFor(HOST, 502), null, 'Profil ohne requestPacing');
});

// --- Poll-Takt -------------------------------------------------------------------------------------------------------

function pollRig(victron) {
  const dev = createRegisterDevice({ defaultUnitId: 1 }).set(1, 0);
  const cfg = { victron, meter: { fc: 3, address: 1, quantity: 1, host: HOST, port: 502, unitId: 1 }, meterPollMs: 2000 };
  const r = createPollerRig(cfg, dev);
  return { ...r, dev, cfg };
}

test('minPollIntervalMs: hebt einen kürzeren Poll-Takt an; ohne Angabe bleibt der Takt wie bisher', async () => {
  enableFakeClock();
  const runs = [];
  try {
    for (const [name, victron, pollMs, expected] of [
      ['ohne Angabe, meterPollMs 2000', { host: HOST, port: 502 }, undefined, 2000],
      ['ohne Angabe, pollMs 500 (Testweg)', { host: HOST, port: 502 }, 500, 500],
      ['SMA 10 s über meterPollMs 2000', { host: HOST, port: 502, requestPacing: { minPollIntervalMs: 10000 } }, undefined, 10000],
      ['SMA 10 s über pollMs 500', { host: HOST, port: 502, requestPacing: { minPollIntervalMs: 10000 } }, 500, 10000],
      ['länger als meterPollMs senkt nie', { host: HOST, port: 502, requestPacing: { minPollIntervalMs: 1000 } }, undefined, 2000],
    ]) {
      const { state, poller, dev, cfg } = pollRig(victron);
      if (pollMs === undefined) delete cfg.pollMs; else cfg.pollMs = pollMs;
      poller.start();
      await flush();
      const polls = () => dev.requests.filter((q) => q.address === 1).length;
      assert.equal(polls(), 1, name);
      const delay = state.meter.nextRetryAt - Date.now();
      await advance(expected - 1, 1);
      const beforeDue = polls();
      await advance(1, 1);
      runs.push([name, delay, beforeDue, polls()]);
      poller.stop();
    }
  } finally {
    disableFakeClock();
  }
  assert.deepEqual(runs, [
    ['ohne Angabe, meterPollMs 2000', 2000, 1, 2],
    ['ohne Angabe, pollMs 500 (Testweg)', 500, 1, 2],
    ['SMA 10 s über meterPollMs 2000', 10000, 1, 2],
    ['SMA 10 s über pollMs 500', 10000, 1, 2],
    ['länger als meterPollMs senkt nie', 2000, 1, 2],
  ]);
});
