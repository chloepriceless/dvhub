import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  createEebusService, resolveEebusConfig, distributeConsumptionLimit, planOhpcfStart, gridImportPositiveW,
} from '../services/eebus/index.js';

const SKI_BOX = 'a'.repeat(40);
const SKI_HP = 'b'.repeat(40);
const SKI_OTHER = 'c'.repeat(40);

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.commands = [];
  let buf = '';
  child.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      child.commands.push(cmd);
      if (cmd.id != null) child.emitEvent({ ev: 'reply', id: cmd.id, cmd: cmd.cmd, ok: true });
    }
  });
  child.emitEvent = (ev) => child.stdout.write(`${JSON.stringify(ev)}\n`);
  child.kill = () => { setImmediate(() => child.emit('exit', 0, null)); };
  return child;
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 5; i++) await tick(); }

function setup({ eebus = {}, extraCfg = {}, withBinary = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eebus-svc-'));
  const bin = path.join(dir, 'dvhub-eebus');
  if (withBinary) { fs.writeFileSync(bin, '#!/bin/sh\n'); fs.chmodSync(bin, 0o755); }
  fs.mkdirSync(path.join(dir, 'eebus'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'eebus', 'cert.pem'), 'x');
  fs.writeFileSync(path.join(dir, 'eebus', 'key.pem'), 'x');
  let cfg = {
    gridPositiveMeans: 'feed_in',
    eebus: {
      enabled: true, port: 4799, binaryPath: withBinary ? bin : path.join(dir, 'missing'),
      trusted: [{ ski: SKI_BOX, name: 'Steuerbox', role: 'grid' }, { ski: SKI_HP, name: 'Wärmepumpe', role: 'device' }],
      ...eebus,
    },
    ...extraCfg,
  };
  const state = { ctrl: {}, meter: { grid_total_w: -2500 }, energy: { importWh: 0, exportWh: 0 }, epex: { data: [] } };
  const feedIn = [];
  const logs = [];
  const children = [];
  const timers = [];
  let t = 1_000_000;
  const ctx = {
    state,
    getCfg: () => cfg,
    pushLog: (e, d) => logs.push([e, d]),
    feedInLimit: { set: async (src, w) => { feedIn.push([src, w]); } },
  };
  const svc = createEebusService(ctx, {
    dataDir: dir,
    now: () => t,
    spawn: (b, args) => { const c = fakeChild(); c.bin = b; c.args = args; children.push(c); return c; },
    setInterval: () => 0,
    clearInterval: () => {},
    // Zeitgeber laufen nicht von selbst (Neustart-/Wiederholungs-Timer).
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  return {
    svc, state, feedIn, logs, children, dir, timers,
    setCfg: (next) => { cfg = next(cfg); },
    advance: (ms) => { t += ms; },
    child: () => children.at(-1),
  };
}

test('Konfiguration: Standardwerte, ungültige SKIs fallen raus, Failsafe-Dauer mindestens 2 h', () => {
  const c = resolveEebusConfig({ eebus: { enabled: true, trusted: [{ ski: 'xyz' }, { ski: SKI_BOX.toUpperCase(), role: 'grid' }], grid: { failsafeConsumptionDurationS: 60 } } });
  assert.equal(c.port, 4712);
  assert.deepEqual(c.trusted.map((t) => [t.ski, t.role]), [[SKI_BOX, 'grid']]);
  assert.equal(c.grid.failsafeConsumptionW, 4200);
  assert.equal(c.grid.failsafeConsumptionDurationS, 7200);
  assert.equal(c.ohpcf.mode, 'cheapest');
});

test('aus: kein Prozess; an ohne Binary: not_installed', async () => {
  const off = setup({ eebus: { enabled: false } });
  await off.svc.start();
  assert.equal(off.svc.status().status, 'disabled');
  assert.equal(off.children.length, 0);
  const missing = setup({ withBinary: false });
  await missing.svc.start();
  assert.equal(missing.svc.status().status, 'not_installed');
  assert.equal(missing.children.length, 0);
  assert.ok(missing.timers.some((x) => x.ms === 60_000), 'prüft jede Minute, ob der Bau fertig ist');
});

test('Start: Prozess mit Port, Zertifikat und Vertrauensliste; ready → Netzseite konfiguriert', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  assert.ok(c.args.includes('--port') && c.args.includes('4799'));
  assert.deepEqual(c.args.filter((a, i) => c.args[i - 1] === '--trust'), [SKI_BOX, SKI_HP]);
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40), ship_id: 'DVhub-DVhub-x', port: 4799 });
  await settle();
  const st = s.svc.status();
  assert.equal(st.status, 'running');
  assert.equal(st.ski, 'd'.repeat(40));
  const cfgCmds = c.commands.filter((x) => x.cmd === 'grid_config');
  assert.deepEqual(cfgCmds.map((x) => x.uc), ['lpc', 'lpp']);
  assert.equal(cfgCmds[0].failsafe_w, 4200);
  assert.equal(cfgCmds[0].failsafe_duration_s, 7200);
});

test('§14a: Grenze der Steuerbox sperrt Akku-Netzladen und teilt sich auf Wallbox und Wärmepumpe auf', async () => {
  const s = setup({ extraCfg: { optimizer: { eosOptimizeEv: true, evEvccControl: true, evMaxChargeW: 11000 } } });
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_BOX });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  c.emitEvent({ ev: 'device_nominal_max', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 3000 });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpc', kind: 'limit', ski: SKI_BOX, w: 7000, duration_s: 7200, active: true, approved: true });
  c.emitEvent({ ev: 'grid_limit', uc: 'lpc', w: 7000, duration_s: 7200, active: true });
  await settle();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, 7000);
  // 11000 + 3000 = 14000 nominal, 7000 Grenze → 5500 / 1500
  assert.equal(s.state.ctrl.eebusWallboxCapW, 5500);
  const dl = c.commands.find((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:HP/1');
  assert.ok(dl, 'Grenze an die Wärmepumpe');
  assert.equal(dl.w, 1500);
  assert.equal(dl.active, true);
  assert.ok(dl.duration_s >= 7100 && dl.duration_s <= 7200);

  // Aufheben
  c.emitEvent({ ev: 'grid_write', uc: 'lpc', kind: 'limit', ski: SKI_BOX, w: 7000, duration_s: 7200, active: false, approved: true });
  c.emitEvent({ ev: 'grid_limit', uc: 'lpc', w: 7000, duration_s: 7200, active: false });
  await settle();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, null);
  assert.equal(s.state.ctrl.eebusWallboxCapW, null);
  const release = c.commands.filter((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:HP/1').at(-1);
  assert.equal(release.active, false, 'Gerätegrenze wird zurückgenommen');
});

test('Grenze von einem Gerät statt der Steuerbox wird ignoriert', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpc', kind: 'limit', ski: SKI_HP, w: 1000, duration_s: 600, active: true, approved: true });
  c.emitEvent({ ev: 'grid_limit', uc: 'lpc', w: 1000, duration_s: 600, active: true });
  await settle();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, null);
  assert.ok(s.logs.some(([e]) => e === 'eebus_grid_write_from_non_grid_peer'));
});

test('Heartbeat der Steuerbox weg → Failsafe-Grenze, die die Steuerbox vorher geschrieben hat', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_failsafe_limit', uc: 'lpc', w: 3500 });
  await settle();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, null);
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: false, lpp_ok: false });
  await settle();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, 3500);
  assert.equal(s.svc.status().grid.lpc.state, 'failsafe');
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'eebus', 'grid-state.json'), 'utf8'));
  assert.equal(saved.lpc.failsafeW, 3500, 'Failsafe-Wert überdauert einen Neustart');
});

test('ohne gekoppelte Steuerbox nie Failsafe (Anlagen ohne §14a bleiben unbegrenzt)', async () => {
  const s = setup({ eebus: { trusted: [{ ski: SKI_HP, role: 'device' }] } });
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: false, lpp_ok: false });
  s.advance(10 * 60_000);
  s.svc._apply();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, null);
  assert.equal(s.svc.status().grid.lpc.state, 'disabled');
});

test('LPP: mit Begrenzer über den Arbiter, ohne Begrenzer Einspeisesperre', async () => {
  const withLimiter = setup({ extraCfg: { controlWrite: { dvFeedInLimitW: { enabled: true } } } });
  await withLimiter.svc.start();
  let c = withLimiter.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpp', kind: 'limit', ski: SKI_BOX, w: 8000, duration_s: 3600, active: true, approved: true });
  c.emitEvent({ ev: 'grid_limit', uc: 'lpp', w: 8000, duration_s: 3600, active: true });
  await settle();
  assert.deepEqual(withLimiter.feedIn.at(-1), ['eebus_lpp', 8000]);
  assert.equal(withLimiter.state.ctrl.eebusProductionBlock, false);
  c.emitEvent({ ev: 'grid_limit', uc: 'lpp', w: 8000, duration_s: 3600, active: false });
  await settle();
  assert.deepEqual(withLimiter.feedIn.at(-1), ['eebus_lpp', null]);

  const noLimiter = setup();
  await noLimiter.svc.start();
  c = noLimiter.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpp', kind: 'limit', ski: SKI_BOX, w: 8000, duration_s: 3600, active: true, approved: true });
  c.emitEvent({ ev: 'grid_limit', uc: 'lpp', w: 8000, duration_s: 3600, active: true });
  await settle();
  assert.equal(noLimiter.state.ctrl.eebusProductionBlock, true);
  assert.equal(noLimiter.feedIn.length, 0);
});

test('Gerät meldet Leistung; unbekannte Geräte werden nicht übernommen', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'mpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  c.emitEvent({ ev: 'device_measurement', uc: 'mpc', entity: 'd:_n:HP/1', ski: SKI_HP, name: 'power_w', value: 2100 });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:X/1', ski: SKI_OTHER });
  await settle();
  const hp = s.svc.status().trusted.find((t) => t.ski === SKI_HP);
  assert.equal(hp.connected, true);
  assert.equal(hp.device.powerW, 2100);
  assert.equal(s.svc.status().trusted.some((t) => t.ski === SKI_OTHER), false);
});

test('Verdichterlauf: Start im günstigsten Fenster', async () => {
  const s = setup();
  const t0 = 1_000_000;
  s.state.epex.data = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ ts: t0 + i * 900_000, ct_kwh: i === 4 || i === 5 ? 2 : 20 }));
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'ohpcf_announce', uc: 'ohpcf', entity: 'd:_n:HP/1/1', ski: SKI_HP, max_power_w: 2000, earliest_start_s: 0, latest_end_s: 7200, min_duration_s: 1800 });
  await settle();
  const cmd = c.commands.find((x) => x.cmd === 'ohpcf');
  assert.equal(cmd.action, 'schedule');
  assert.equal(cmd.start_in_s, 3600, 'Start in den beiden günstigen Viertelstunden');
});

test('Hilfsfunktionen: Aufteilung, Startplanung, Vorzeichen am Netzanschlusspunkt', () => {
  assert.deepEqual(distributeConsumptionLimit(10000, [{ id: 'a', nominalW: 4000 }, { id: 'b', nominalW: 2000 }]), { a: 4000, b: 2000 });
  assert.deepEqual(distributeConsumptionLimit(3000, [{ id: 'a', nominalW: 4000 }, { id: 'b', nominalW: 2000 }]), { a: 2000, b: 1000 });
  assert.deepEqual(distributeConsumptionLimit(3000, []), {});
  assert.equal(planOhpcfStart({ earliest_start_s: 120, latest_end_s: 3600, min_duration_s: 900 }, [], 0), 120);
  assert.equal(gridImportPositiveW({ meter: { grid_total_w: -500 } }, { gridPositiveMeans: 'feed_in' }), 500);
  assert.equal(gridImportPositiveW({ meter: { grid_total_w: -500 } }, { gridPositiveMeans: 'grid_import' }), -500);
  assert.equal(gridImportPositiveW({ meter: {} }, {}), null);
});

test('Prozess stirbt → Neustart geplant, ausstehende Anfragen enden', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  await settle();
  c.emit('exit', 1, null);
  await settle();
  assert.equal(s.svc.status().status, 'restarting');
  assert.equal(s.svc.status().restarts, 1);
  const restart = s.timers.find((x) => x.ms === 5_000);
  assert.ok(restart, 'Neustart nach 5 s geplant');
  await restart.fn();
  assert.equal(s.children.length, 2, 'Prozess neu gestartet');
});
