// test/helpers/dv-parity-rig.js — Prüfstand für den Paritätsnachweis der Abregel-Pfade 2–5 (VCL-Vertrag v6 D.2,
// Nachweis D.4(2)): derselbe Ablauf einmal über den ALTEN Weg und einmal über das ECHTE Tor (ein Tor je Bewertung wie
// in der Laufzeit, server.js ctx.gate).
//
// Alter Weg: der heutige Code mit einem Tor-Ersatz, der jede Operation unmittelbar an die Senke gibt (`directGate`) —
// oder, mit DV_PARITY_BASE=<Kopie der alten schedule-eval.js IM dvhub-Verzeichnis>, der Code VOR dem Umbau selbst.
//
// Der Fake-Transport bildet transport-modbus.js bzw. transport-mqtt.js an der Rahmengrenze nach: im Lese-Modus lehnt
// er jeden Write mit derselben Meldung ab (ReadOnlyViolation, noteBlockedWrite) und nichts erreicht den Draht.
// Verglichen werden Draht-Folge (Lesen und Schreiben, alle Geräte in EINEM Protokoll), volle Argument-Objekte,
// Rückgaben/Fehler, Log-Ereignisse samt Daten und Stufe, die Zustandsfelder der Pfade, die Merker-Dateien und im
// Lese-Modus die abgewehrten Schreibversuche.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as current from '../../schedule-eval.js';
import { createLegacyGate, INVERTER_GATE_DEVICE } from '../../services/gate/legacy.js';
import { ReadOnlyViolation, blockedWriteCount, isReadOnlyMode, noteBlockedWrite } from '../../read-only-guard.js';
import { recordingModbus, fixClock } from './gate-golden.js';

export const BASE = process.env.DV_PARITY_BASE
  ? await import(pathToFileURL(path.resolve(process.env.DV_PARITY_BASE)).href)
  : null;

/** „Alter Weg“ ohne Basis-Kopie: dieselbe Aufrufstelle ohne Tor — der Legacy-Aufruf geht unmittelbar an die Senke. */
export function directGate() {
  const sinks = Object.create(null);
  return {
    attachSink(name, spec) { sinks[name] = spec; },
    setRelease() {},
    setDevicePolicies() {},
    fence() {},
    admitLegacyRun() { return {}; },
    async submit(op) {
      try {
        return { outcome: 'ok', result: await sinks[op.legacy.sink].legacy[op.legacy.fn](...op.legacy.args) };
      } catch (e) {
        return { outcome: 'error', error: e };
      }
    },
  };
}

/**
 * Modbus-Attrappe (gate-golden recordingModbus) plus Lese-Modus wie transport-modbus.js, volle Argumente und ein Haken
 * nach jeder Draht-Operation (Lesen und Schreiben; bekommt die Protokollzeile — z. B. Not-Halt mitten im Lauf).
 */
export function parityModbus(opts = {}, onWrite = null) {
  const t = recordingModbus(opts);
  const calls = [];
  const read = async (req) => {
    try {
      return await t.mbRequest(req);
    } finally {
      onWrite?.(t.ops.at(-1));
    }
  };
  const wrap = (name, fc) => async (req) => {
    if (isReadOnlyMode()) {
      noteBlockedWrite(`Modbus fc=${fc} an ${req.host}:${req.port}`);
      throw new ReadOnlyViolation(`Schreibzugriff im Lese-Modus abgelehnt (Modbus fc=${fc})`);
    }
    calls.push(`${name}:${JSON.stringify(req)}`);
    try {
      return await t[name](req);
    } finally {
      onWrite?.(t.ops.at(-1));
    }
  };
  return { ...t, mbRequest: read, mbWriteSingle: wrap('mbWriteSingle', 6), mbWriteMultiple: wrap('mbWriteMultiple', 16), calls };
}

/** MQTT-Attrappe (Venus-Schema) wie transport-mqtt.js mqttWrite: Topic-Zuordnung, Lese-Modus, Übergabe. */
export function parityMqtt({ fail = {}, portalId = 'c0619ab00000' } = {}, onWrite = null) {
  const topics = {
    feedExcessDcPv: `W/${portalId}/settings/0/Settings/CGwacs/OvervoltageFeedIn`,
    dontFeedExcessAcPv: `W/${portalId}/settings/0/Settings/CGwacs/PreventFeedback`,
  };
  const ops = [];
  const calls = [];
  const seen = {};
  return {
    type: 'mqtt',
    ops,
    calls,
    regs: new Map(),
    _writeTopics: () => ({ ...topics }),
    async mqttWrite(name, value) {
      const topic = topics[name];
      if (!topic) throw new Error(`Kein MQTT-Write-Mapping für: ${name}`);
      if (isReadOnlyMode()) {
        noteBlockedWrite(`MQTT ${topic}`);
        throw new ReadOnlyViolation(`Schreibzugriff im Lese-Modus abgelehnt (MQTT ${name})`);
      }
      calls.push(`mqttWrite:${JSON.stringify([name, value])}`);
      const n = (seen[name] = (seen[name] || 0) + 1);
      const f = fail[name];
      try {
        if (f && (f.times == null || n <= (f.skip || 0) + f.times) && n > (f.skip || 0)) {
          ops.push(`MQTT ${topic}=${value} !${f.msg}`);
          throw new Error(f.msg);
        }
        ops.push(`MQTT ${topic}=${value}`);
        return { ok: true, topic, value };
      } finally {
        onWrite?.(ops.at(-1));
      }
    },
    async readPointSince(name) { throw new Error(`Kein Nach-Write-Wert empfangen für: ${name}`); },
  };
}

const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

/**
 * Ein Prüfstand je Seite. mode: 'old' | 'new'. Merker-Dateien liegen in einem eigenen Verzeichnis je Seite, mit
 * demselben Anfangsinhalt (`files`). `restart()` baut eine frische Bewertung (neuer Zustand, neues Tor) auf denselben
 * Dateien und demselben Gerät — wie ein Neustart von DVhub.
 */
export function buildRig(mode, { cfg, transport, state, ctx = {}, files = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dvhub-dv-parity-${mode}-`));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  const logs = [];
  const events = [];
  // pushLog wie in server.js: (Ereignis, Daten, Stufe | { severity }) — Szenarien reichen es an Begrenzer/Not-Halt weiter.
  const pushLog = (event, data, level) => logs.push([event, plain(data), typeof level === 'string' ? level : (level?.severity ?? null)]);
  const rig = { mode, cfg, transport, dir, logs, events, pushLog, gate: null, ev: null, state: null };
  const make = (st) => {
    const gate = mode === 'new'
      ? createLegacyGate({ isHalted: () => st.ctrl?.discretionaryWritesPaused === true, onEvent: (e) => events.push(e) })
      : (BASE ? undefined : directGate());
    const create = mode === 'old' && BASE ? BASE.createScheduleEvaluator : current.createScheduleEvaluator;
    const ev = create({
      state: st, getCfg: () => rig.cfg, transport,
      pushLog,
      telemetrySafeWrite: () => {}, persistConfig: async () => {}, telemetryStore: null, epexNowNext: () => null,
      regenerateSmallMarketAutomationRules: async () => {},
      dvSeqSavedPath: path.join(dir, 'dv_seq_saved.json'),
      dvSeqWritedayPath: path.join(dir, 'dv_seq_writeday.json'),
      sungrowEmsStatePath: path.join(dir, 'sungrow_ems_state.json'),
      sungrowSlaveEmsStatePath: path.join(dir, 'sungrow_ems_slave_state.json'),
      sungrowForcedHeartbeatPath: path.join(dir, 'sungrow_forced_heartbeat.json'),
      peakShavingLiftPath: path.join(dir, 'peak_shaving_lift.json'),
      sungrowSlaveTransport: transport?.type === 'modbus' ? transport : null,
      ...(gate ? { gate } : {}),
      ...ctx,
    });
    Object.assign(rig, { gate, ev, state: st });
  };
  make(state());
  rig.restart = () => make(state());
  /** Not-Halt so, wie setEmergencyStop ihn synchron setzt: Marke, Zeitpunkt, Sperrmarke im Tor. */
  rig.halt = () => {
    rig.state.ctrl.discretionaryWritesPaused = true;
    rig.state.ctrl.pausedAt = Date.now();
    rig.gate?.fence?.();
  };
  rig.resume = () => {
    rig.state.ctrl.discretionaryWritesPaused = false;
    rig.state.ctrl.pausedAt = 0;
  };
  rig.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return rig;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Eine Seite eines Szenarios fahren (in einem eigenen Untertest: eigene Uhr, eigene Timer). sc = { setup(mode) →
 * rig-Optionen, run(rig, step) , readOnly?, clock? }. Liefert { rig, out }.
 */
export async function runSide(t, mode, sc) {
  let result;
  await t.test(mode === 'old' ? (BASE ? 'alt (Basis-Kopie)' : 'alt (direkt)') : 'neu (Tor)', async (st) => {
    const advance = fixClock(st, sc.clock || ['Date']);
    const hook = { fn: null };
    const opts = sc.setup((entry) => hook.fn?.(entry));
    const rig = buildRig(mode, opts);
    rig.advance = advance;
    rig.onWrite = (fn) => { hook.fn = fn; };
    const steps = [];
    const step = async (label, fn) => {
      const out = { step: label };
      try {
        const v = await fn();
        out.value = plain(v);
      } catch (e) {
        out.threw = { name: e?.name, message: e?.message, code: e?.code ?? null };
      }
      steps.push(out);
      return out;
    };
    const blockedBefore = blockedWriteCount();
    const prevRo = process.env.DVHUB_READ_ONLY;
    const prevWarn = console.warn;
    const readOnlyLines = [];
    if (sc.readOnly) {
      process.env.DVHUB_READ_ONLY = '1';
      console.warn = (...a) => { readOnlyLines.push(String(a[0]).replace(/ \(bisher \d+\)$/, '')); };
    }
    try {
      await sc.run(rig, step);
    } finally {
      console.warn = prevWarn;
      if (prevRo === undefined) delete process.env.DVHUB_READ_ONLY; else process.env.DVHUB_READ_ONLY = prevRo;
    }
    const s = rig.state;
    result = {
      rig,
      out: {
        wire: [...rig.transport.ops],
        calls: [...rig.transport.calls],
        steps,
        logs: rig.logs,
        state: plain({
          ctrl: s.ctrl,
          lastWrite: s.schedule?.lastWrite,
          verify: s.schedule?._verify,
          active: s.schedule?.active,
        }),
        regs: Object.fromEntries(rig.transport.regs ?? []),
        files: {
          saved: readJson(path.join(rig.dir, 'dv_seq_saved.json')),
          writeday: readJson(path.join(rig.dir, 'dv_seq_writeday.json')),
        },
        readOnlyBlocked: blockedWriteCount() - blockedBefore,
        readOnlyLines,
      },
    };
    rig.cleanup();
  });
  return result;
}

const isWrite = (entry) => /^(W6|W16|MQTT) /.test(entry);

/**
 * Je Szenario ein Test: alte Seite, neue Seite, Vergleich. Auf der neuen Seite zusätzlich: jeder Draht-Write genau
 * ein Tor-Ereignis (ok/error), Vertrauensklasse legacy am Gerät inverter, das Tor sperrt nichts (außer im
 * Lese-Modus, dort jede Sperre mit genau einer Meldung), dann die Soll-Prüfung des Szenarios (`expect`).
 */
export function registerParityScenarios(scenarios, label = 'Legacy') {
  for (const [name, sc] of Object.entries(scenarios)) {
    test(`Parität alt ↔ Tor (${label}): ${name}`, async (t) => {
      const before = await runSide(t, 'old', sc);
      const after = await runSide(t, 'new', sc);
      assert.deepEqual(after.out, before.out, `${name}: Tor-Pfad weicht vom alten Weg ab`);
      const writes = after.out.wire.filter(isWrite);
      const delivered = after.rig.events.filter((e) => e.outcome === 'ok' || e.outcome === 'error');
      assert.equal(delivered.length, writes.length, `${name}: jeder Draht-Write ein Tor-Ereignis`);
      assert.ok(after.rig.events.every((e) => e.trust === 'legacy' && e.target.device === INVERTER_GATE_DEVICE), 'legacy, Gerät inverter');
      const blocked = after.rig.events.filter((e) => !['ok', 'error'].includes(e.outcome));
      if (sc.readOnly) {
        assert.ok(blocked.length > 0 && blocked.every((e) => e.outcome === 'blocked_readonly'), 'im Lese-Modus sperrt das Tor');
        assert.equal(after.out.readOnlyBlocked, blocked.length, 'je Sperre eine Meldung');
      } else {
        assert.deepEqual(blocked.map((e) => `${e.point}:${e.outcome}:${e.detail}`), [], 'das Tor sperrt nichts, was heute geschrieben wird');
      }
      if (!sc.noWrites) assert.ok(writes.length > 0 || sc.readOnly, `${name}: Szenario ohne Draht-Write`);
      sc.expect?.(after);
    });
  }
}
