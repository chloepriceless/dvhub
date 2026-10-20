import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  createEebusService, resolveEebusConfig, planOhpcfStart, gridImportPositiveW,
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
    svc, state, ctx, feedIn, logs, children, dir, timers,
    setCfg: (next) => { cfg = next(cfg); },
    advance: (ms) => { t += ms; },
    child: () => children.at(-1),
  };
}

test('Konfiguration: Standardwerte, ungültige SKIs fallen raus, Failsafe-Dauer mindestens 2 h', () => {
  const c = resolveEebusConfig({ eebus: { enabled: true, trusted: [{ ski: 'xyz' }, { ski: SKI_BOX.toUpperCase(), role: 'grid' }], grid: { failsafeConsumptionDurationS: 60 } } });
  assert.equal(c.port, 4712);
  assert.deepEqual(c.trusted.map((t) => [t.ski, t.role]), [[SKI_BOX, 'grid']]);
  assert.equal(c.grid.failsafeConsumptionW, 0, '0 = automatisch (Pmin,14a)');
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

test('§14a: Grenze der Steuerbox geht an den §14a-Dienst, Anteile an die Wärmepumpe', async () => {
  const s = setup();
  let updates = 0;
  s.ctx.p14a = { update: () => { updates += 1; } };
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
  assert.ok(s.state.ctrl.eebusConsumptionLimitUntil > 0, 'Ende der Grenze für die Dauer am Gerät');
  assert.ok(updates >= 1, '§14a-Dienst rechnet sofort neu');

  const devices = s.svc.consumptionDevices();
  assert.deepEqual(devices.map((d) => [d.id, d.kind, d.maxW]), [[`eebus:${SKI_HP}`, 'waermepumpe', 3000]]);
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1500 }, s.state.ctrl.eebusConsumptionLimitUntil);
  await settle();
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
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: null }, null);
  await settle();
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

test('Heartbeat der Steuerbox 120 s weg → Failsafe-Grenze, die die Steuerbox vorher geschrieben hat', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpc', kind: 'failsafe_limit', ski: SKI_BOX, w: 3500, approved: true });
  c.emitEvent({ ev: 'grid_failsafe_limit', uc: 'lpc', w: 3500 });
  c.emitEvent({ ev: 'grid_failsafe_limit', uc: 'lpp', w: 0 }); // Spiegelmeldung, keine Vorgabe
  await settle();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, null);
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: false, lpp_ok: false });
  await settle();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, null, 'kurzer Abbruch: noch kein Failsafe');
  s.advance(120_000);
  s.svc._apply();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, 3500);
  assert.equal(s.svc.status().grid.lpc.state, 'failsafe');
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'eebus', 'grid-state.json'), 'utf8'));
  assert.equal(saved.lpc.failsafeW, 3500, 'Failsafe-Wert überdauert einen Neustart');
  assert.equal(saved.lpp.failsafeW, null, 'eigene Vorgabe wird nicht gespeichert, Spiegelmeldung ignoriert');
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

test('neue Steuerbox erbt keine Failsafe-Werte der alten', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpc', kind: 'failsafe_limit', ski: SKI_BOX, w: 3800, approved: true });
  await settle();
  assert.equal(s.svc.status().grid.lpc.failsafeW, 3800);
  s.setCfg((cfg) => ({ ...cfg, eebus: { ...cfg.eebus, trusted: [{ ski: SKI_OTHER, name: 'neu', role: 'grid' }] } }));
  await s.svc.reload();
  await settle();
  assert.equal(s.svc.status().grid.lpc.failsafeW, 4200, 'zurück auf den Wert aus der Konfiguration');
  const saved = JSON.parse(fs.readFileSync(path.join(s.dir, 'eebus', 'grid-state.json'), 'utf8'));
  assert.equal(saved.lpc.failsafeW, null);
  assert.ok(c.commands.some((x) => x.cmd === 'grid_config' && x.uc === 'lpc' && x.failsafe_w === 4200), 'Wert auch in openeebus zurückgesetzt');
});

test('Rollenvorschlag: EEBUS-Handwerkertool (GCPH) als Steuerbox', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'mdns', services: [{ ski: 'f'.repeat(40), brand: 'EEBus_Initiative_e.V.', model: 'EEBUS-Handwerkertool', type: 'GCPH' }] });
  await settle();
  assert.equal(s.svc.status().discovered[0].suggestedRole, 'grid');
});

test('Leitstand-Kurzfassung: Steuerbox, LPC/LPP und Umsetzung; aus → nur enabled:false', async () => {
  const h = setup({ extraCfg: { controlWrite: { dvFeedInLimitW: { enabled: true } } } });
  await h.svc.start();
  const c = h.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_BOX });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpc', kind: 'limit', ski: SKI_BOX, w: 4200, duration_s: 900, active: true, approved: true });
  c.emitEvent({ ev: 'grid_limit', uc: 'lpc', w: 4200, duration_s: 900, active: true });
  await settle();
  const s = h.svc.summary();
  assert.equal(s.enabled, true);
  assert.equal(s.status, 'running');
  assert.deepEqual(s.grid, { name: 'Steuerbox', connected: true });
  assert.equal(s.lpc.state, 'limited');
  assert.equal(s.lpc.limitW, 4200);
  assert.equal(s.lpp.state, 'unlimited_controlled');
  assert.equal(s.applied.consumptionLimitW, 4200);
  assert.deepEqual(s.devices, { total: 1, connected: 0 });
  assert.ok(h.logs.some(([e, d]) => e === 'paragraph14a_write' && d.uc === 'lpc' && d.w === 4200));

  c.emitEvent({ ev: 'grid_write', uc: 'lpp', kind: 'limit', ski: SKI_BOX, w: -5000, duration_s: 0, active: true, approved: false });
  await settle();
  assert.ok(h.logs.some(([e, d]) => e === 'paragraph14a_write_denied' && d.uc === 'lpp' && d.w === -5000), 'abgelehnte Vorgabe steht im Protokoll');

  h.setCfg((cfg) => ({ ...cfg, eebus: { ...cfg.eebus, enabled: false } }));
  assert.deepEqual(h.svc.summary(), { enabled: false });
});

test('LPP mit negativem Wert (EEBUS: Erzeugung negativ) wirkt als Betrag', async () => {
  const h = setup({ extraCfg: { controlWrite: { dvFeedInLimitW: { enabled: true } } } });
  await h.svc.start();
  const c = h.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpp', kind: 'failsafe_limit', ski: SKI_BOX, w: -6000, approved: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpp', kind: 'limit', ski: SKI_BOX, w: -4200, duration_s: 0, active: true, approved: true });
  c.emitEvent({ ev: 'grid_limit', uc: 'lpp', w: -4200, duration_s: 0, active: true });
  await settle();
  assert.deepEqual(h.feedIn.at(-1), ['eebus_lpp', 4200]);
  assert.equal(h.svc.summary().lpp.limitW, 4200);
  assert.equal(h.svc._machines().lpp.snapshot().failsafeW, 6000);
});

test('Absturz des Hilfsprozesses: Neustart übernimmt die zuletzt geschriebenen Failsafe-Werte', async () => {
  const s = setup();
  await s.svc.start();
  let c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpc', kind: 'failsafe_limit', ski: SKI_BOX, w: 3800, approved: true });
  await settle();
  c.emit('exit', null, 'SIGSEGV');
  await settle();
  await s.timers.find((x) => x.ms === 5_000).fn();
  c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpc', kind: 'failsafe_limit', ski: SKI_BOX, w: 1_000_000, approved: true });
  await settle();
  c.emit('exit', null, 'SIGSEGV');
  await settle();
  await s.timers.filter((x) => x.ms > 0).at(-1).fn();
  assert.equal(s.children.length, 3);
  assert.equal(s.svc.status().grid.lpc.failsafeW, 1_000_000, 'nicht der Stand vom Start von DVhub (3800)');
});

test('LPP ohne Begrenzer: Sperre nur, wenn die Grenze unter der Anlagenleistung liegt', async () => {
  const s = setup({ eebus: { grid: { productionNominalMaxW: 30_000 } } });
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'grid_write', uc: 'lpp', kind: 'limit', ski: SKI_BOX, w: -30_000, duration_s: 0, active: true, approved: true });
  c.emitEvent({ ev: 'grid_limit', uc: 'lpp', w: -30_000, duration_s: 0, active: true });
  await settle();
  assert.equal(s.state.ctrl.eebusProductionBlock, false, 'Grenze = Nennleistung schränkt nichts ein');
  c.emitEvent({ ev: 'grid_limit', uc: 'lpp', w: -4200, duration_s: 0, active: true });
  await settle();
  assert.equal(s.state.ctrl.eebusProductionBlock, true);
});

test('E-Auto an der EEBUS-Wallbox: Meldungen je Gerät, Stromgrenze an dvhub-eebus', async () => {
  const SKI_WB = 'e'.repeat(40);
  const EV = 'd:_n:Wallbox_1/1/1';
  const s = setup({ eebus: { trusted: [{ ski: SKI_BOX, role: 'grid' }, { ski: SKI_WB, name: 'Wallbox', role: 'device' }] } });
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_WB });
  c.emitEvent({ ev: 'ev_connected', ski: SKI_WB, entity: EV });
  c.emitEvent({ ev: 'ev_data', ski: SKI_WB, entity: EV, charge_state: 'active', comm_standard: 'iso15118-2ed2', power_min_w: 1380, power_max_w: 11040, power_standby_w: 0, ids: [{ type: 'eui48', value: '0a1b2c3d4e5f' }], manufacturer: { brand: 'VW' }, sleep: false });
  c.emitEvent({ ev: 'ev_measurement', ski: SKI_WB, entity: EV, phases: 3, current_a: [10, 10.5, 9.5], power_w: [2300, 2400, 2200], power_total_w: 6900, energy_wh: 1200 });
  c.emitEvent({ ev: 'ev_soc', ski: SKI_WB, entity: EV, soc: 63.5 });
  c.emitEvent({ ev: 'ev_limits', ski: SKI_WB, entity: EV, uc: 'opev', min_a: [6, 6, 6], max_a: [16, 16, 16], default_a: [0, 0, 0], limits: [{ phase: 'a', active: true, value_a: 10, changeable: true }] });
  c.emitEvent({ ev: 'ev_charge_plan', ski: SKI_WB, entity: EV, strategy: 'timedcharging', demand: { min_wh: 1000, opt_wh: 20000, max_wh: 40000, start_in_s: 0, end_in_s: 7200 }, plan: [{ start_ms: 1, end_ms: 2, w: 11000, min_w: 1380, max_w: 11040 }] });
  c.emitEvent({ ev: 'ev_soc', ski: SKI_OTHER, entity: 'd:_n:X/1/1', soc: 10 }); // nicht gekoppelt
  await settle();

  const ev = s.svc.status().trusted.find((t) => t.ski === SKI_WB).device.ev;
  assert.equal(ev.connected, true);
  assert.equal(ev.entity, EV);
  assert.equal(ev.soc, 63.5);
  assert.deepEqual(ev.phasesA, [10, 10.5, 9.5]);
  assert.deepEqual(ev.powerPerPhaseW, [2300, 2400, 2200]);
  assert.equal(ev.powerW, 6900);
  assert.equal(ev.energyWh, 1200);
  assert.equal(ev.phases, 3);
  assert.equal(ev.chargeState, 'active');
  assert.equal(ev.vehicle.powerMaxW, 11040);
  assert.equal(ev.vehicle.commStandard, 'iso15118-2ed2');
  assert.deepEqual(ev.limits.opev.maxA, [16, 16, 16]);
  assert.equal(ev.limits.opev.limits[0].valueA, 10);
  assert.equal(ev.plan.strategy, 'timedcharging');
  assert.equal(ev.plan.demand.optWh, 20000);
  assert.equal(ev.plan.slots[0].w, 11000);
  assert.equal(s.svc.status().trusted.some((t) => t.ski === SKI_OTHER), false, 'fremde Geräte bleiben draußen');

  // Stromgrenze je Phase (OPEV) und Aufheben (null)
  let r = await s.svc.setEvCurrentLimits(SKI_WB, [10, 10, 10]);
  assert.equal(r.ok, true);
  let cmd = c.commands.filter((x) => x.cmd === 'ev_current_limits').at(-1);
  assert.deepEqual({ ski: cmd.ski, entity: cmd.entity, uc: cmd.uc, amps: cmd.amps }, { ski: SKI_WB, entity: EV, uc: 'opev', amps: [10, 10, 10] });
  r = await s.svc.setEvCurrentLimits(SKI_WB, null);
  cmd = c.commands.filter((x) => x.cmd === 'ev_current_limits').at(-1);
  assert.equal(r.ok, true);
  assert.equal(cmd.amps, null, 'null hebt die Grenze auf');
  await s.svc.setEvCurrentLimits(SKI_WB, [8], { uc: 'oscev' });
  cmd = c.commands.filter((x) => x.cmd === 'ev_current_limits').at(-1);
  assert.equal(cmd.uc, 'oscev');

  const before = c.commands.length;
  assert.equal((await s.svc.setEvCurrentLimits(SKI_WB, [-1])).ok, false);
  assert.equal((await s.svc.setEvCurrentLimits(SKI_WB, [16, 16, 16, 16])).ok, false);
  assert.equal((await s.svc.setEvCurrentLimits(SKI_WB, [16], { uc: 'lpc' })).ok, false);
  assert.equal((await s.svc.setEvCurrentLimits(SKI_HP, [16])).ok, false, 'Gerät ohne Auto');
  assert.equal(c.commands.length, before, 'ungültige Vorgaben gehen nicht an dvhub-eebus');

  // Auto ab → verbunden false, Messwerte weg
  c.emitEvent({ ev: 'ev_disconnected', ski: SKI_WB, entity: EV });
  await settle();
  const off = s.svc.status().trusted.find((t) => t.ski === SKI_WB).device.ev;
  assert.equal(off.connected, false);
  assert.equal(off.soc, null);
  assert.equal(off.powerW, null);
  assert.equal((await s.svc.setEvCurrentLimits(SKI_WB, [16])).ok, false, 'ohne Auto keine Grenze');
});

test('Failsafe-Vorgabe automatisch: Mindestleistung Pmin,14a aus dem §14a-Dienst', async () => {
  const s = setup();
  s.ctx.p14a = { pminW: () => 7560, update: () => {} };
  await s.svc.start();
  s.child().emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  await settle();
  assert.equal(s.svc._machines().lpc.snapshot().failsafeW, 7560);
  assert.ok(s.child().commands.some((x) => x.cmd === 'grid_config' && x.uc === 'lpc' && x.failsafe_w === 7560));
});

// ── EEBUS-Wallbox (Christin 2026-10-20, Wallbox-Liste Punkt 2) ──
// openeebus kennt die E-Auto-Abläufe (EVCC/OPEV/OSCEV) nicht; DVhub steuert eine
// EEBUS-Wallbox über die Verbrauchsgrenze (LPC). Die Vorgabe der Wallbox-
// Steuerung (EOS, Lademodus) und der §14a-Anteil gelten zusammen: der kleinere.
const SKI_WB = 'e'.repeat(40);
async function withWallbox() {
  const s = setup({ eebus: { trusted: [{ ski: SKI_BOX, name: 'Steuerbox', role: 'grid' }, { ski: SKI_WB, name: 'Elli', role: 'device', kind: 'wallbox' }] } });
  s.ctx.p14a = { update: () => {} };
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_WB });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:WB/1', ski: SKI_WB });
  await settle();
  return { s, c, limits: () => c.commands.filter((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:WB/1') };
}

test('EEBUS-Wallbox: Steuer-Grenze geht ans Gerät, §14a-Anteil kleiner gewinnt, Aufheben behält die Steuer-Grenze', async () => {
  const { s, limits } = await withWallbox();
  assert.equal((await s.svc.setEmsLimit(SKI_WB, 6900)).ok, true);
  await settle();
  assert.deepEqual([limits().at(-1).w, limits().at(-1).active], [6900, true]);

  s.svc.applyConsumptionShares({ [`eebus:${SKI_WB}`]: 4200 }, null);
  await settle();
  assert.deepEqual([limits().at(-1).w, limits().at(-1).active], [4200, true], '§14a kleiner');

  s.svc.applyConsumptionShares({ [`eebus:${SKI_WB}`]: null }, null);
  await settle();
  assert.deepEqual([limits().at(-1).w, limits().at(-1).active], [6900, true], 'nach §14a wieder die Steuer-Grenze, nicht frei');

  assert.equal((await s.svc.setEmsLimit(SKI_WB, null)).ok, true);
  await settle();
  assert.equal(limits().at(-1).active, false, 'Freigeben hebt auf');
});

test('EEBUS-Wallbox: Geräteinfo (verbunden, LPC, Leistung) und Fehler ohne LPC', async () => {
  const { s, c } = await withWallbox();
  c.emitEvent({ ev: 'measurement', uc: 'mpc', ski: SKI_WB, entity: 'd:_n:WB/1', name: 'power_w', value: 3650 });
  await settle();
  const i = s.svc.deviceInfo(SKI_WB);
  assert.equal(i.connected, true);
  assert.equal(i.hasLpc, true);
  assert.equal(i.name, 'Elli');
  assert.equal((await s.svc.setEmsLimit('f'.repeat(40), 1000)).ok, false);
});
