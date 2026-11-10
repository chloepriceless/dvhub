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
      const fail = child.failCmds?.[cmd.cmd] > 0 ? (child.failCmds[cmd.cmd] -= 1, true) : false;
      if (cmd.id != null) child.emitEvent({ ev: 'reply', id: cmd.id, cmd: cmd.cmd, ok: !fail, ...(fail ? { error: 'write failed' } : {}) });
    }
  });
  child.emitEvent = (ev) => child.stdout.write(`${JSON.stringify(ev)}\n`);
  child.kill = () => { setImmediate(() => child.emit('exit', 0, null)); };
  return child;
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 5; i++) await tick(); }

function setup({ eebus = {}, extraCfg = {}, withBinary = true, dir: reuseDir = null } = {}) {
  // reuseDir: gleiches Datenverzeichnis wie ein voriger Prozess (Neustart).
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'eebus-svc-'));
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
  const intervals = [];
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
    // Takte laufen nicht von selbst; Tests rufen sie über intervals auf.
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 0; },
    clearInterval: () => {},
    // Zeitgeber laufen nicht von selbst (Neustart-/Wiederholungs-Timer).
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  return {
    svc, state, ctx, feedIn, logs, children, dir, timers, intervals,
    now: () => t,
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
  // (vorher schon „frei“ beim Anmelden des Geräts: Wiederanlauf der Kopplung)
  const dl = c.commands.find((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:HP/1' && x.active === true);
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
  const now = 1_000_000;
  const m = (x) => ({ meter: { ok: true, updatedAt: now - 1000, ...x } });
  assert.equal(gridImportPositiveW(m({ grid_total_w: -500 }), { gridPositiveMeans: 'feed_in' }, { now }), 500);
  assert.equal(gridImportPositiveW(m({ grid_total_w: -500 }), { gridPositiveMeans: 'grid_import' }, { now }), -500);
  assert.equal(gridImportPositiveW(m({}), {}, { now }), null);
  // Fable R2 P1-1: nur gültige, frische Werte gehen an die Steuerbox (MGCP)
  assert.equal(gridImportPositiveW(m({ ok: false, grid_total_w: 0 }), {}, { now }), null, 'Start: Zähler noch nicht gelesen');
  assert.equal(gridImportPositiveW(m({ updatedAt: now - 60_000, grid_total_w: -500 }), {}, { now }), null, 'eingefroren');
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

// Fable R2 P3-5: beim Start sind noch keine EEBUS-Geräte angemeldet — die
// automatische Failsafe-Vorgabe folgt der Geräteliste, solange die Steuerbox
// keinen eigenen Wert geschrieben hat.
test('Failsafe-Vorgabe automatisch: folgt Pmin,14a, wenn sich die Geräteliste ändert; nicht nach einem Wert der Steuerbox', async () => {
  const s = setup();
  let pmin = 7560;
  s.ctx.p14a = { pminW: () => pmin, update: () => {} };
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  await settle();
  pmin = 10500; // Wärmepumpe hat sich angemeldet
  s.advance(31_000);
  s.svc._tick();
  await settle();
  assert.equal(s.svc._machines().lpc.snapshot().failsafeW, 10500);
  assert.ok(c.commands.some((x) => x.cmd === 'grid_config' && x.uc === 'lpc' && x.failsafe_w === 10500));
  // Steuerbox schreibt ihren eigenen Failsafe-Wert: der gilt
  c.emitEvent({ ev: 'grid_write', ski: SKI_BOX, uc: 'lpc', kind: 'failsafe_limit', w: 5000, approved: true });
  await settle();
  pmin = 12000;
  s.advance(31_000);
  s.svc._tick();
  await settle();
  assert.equal(s.svc._machines().lpc.snapshot().failsafeW, 5000);
  assert.ok(!c.commands.some((x) => x.cmd === 'grid_config' && x.failsafe_w === 12000));
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

test('EEBUS-Wallbox: Geräteinfo enthält das E-Auto (Go-Fassung) — verbunden, Ladestand, Leistung, OPEV vorhanden', async () => {
  const { s, c } = await withWallbox();
  assert.equal(s.svc.deviceInfo(SKI_WB).ev, null, 'ohne Auto-Meldungen kein ev');
  const EV = 'd:_n:WB/1/1';
  c.emitEvent({ ev: 'ev_connected', ski: SKI_WB, entity: EV });
  c.emitEvent({ ev: 'ev_measurement', ski: SKI_WB, entity: EV, phases: 3, current_a: [10, 10, 10], power_total_w: 6900 });
  c.emitEvent({ ev: 'ev_soc', ski: SKI_WB, entity: EV, soc: 55 });
  c.emitEvent({ ev: 'ev_limits', ski: SKI_WB, entity: EV, uc: 'opev', min_a: [6, 6, 6], max_a: [16, 16, 16], default_a: [0, 0, 0], limits: [{ phase: 'a', active: true, value_a: 16, changeable: true }] });
  await settle();
  assert.deepEqual(s.svc.deviceInfo(SKI_WB).ev, { connected: true, soc: 55, powerW: 6900, phasesA: [10, 10, 10], opev: true, opevStop: true, maxA: 16 });
  c.emitEvent({ ev: 'ev_disconnected', ski: SKI_WB, entity: EV });
  await settle();
  assert.equal(s.svc.deviceInfo(SKI_WB).ev.connected, false);
});

test('EEBUS-Wallbox: OPEV gilt nur mit lesbaren Grenzen; Stopp per OPEV nur, wenn der Standardwert 0 ist (Codex 20.10.)', async () => {
  const { s, c } = await withWallbox();
  const EV = 'd:_n:WB/1/1';
  c.emitEvent({ ev: 'ev_connected', ski: SKI_WB, entity: EV });
  c.emitEvent({ ev: 'ev_limits', ski: SKI_WB, entity: EV, uc: 'opev' }); // beide Leseversuche fehlgeschlagen
  await settle();
  assert.equal(s.svc.deviceInfo(SKI_WB).ev.opev, false, 'leere Meldung ≠ OPEV');
  c.emitEvent({ ev: 'ev_limits', ski: SKI_WB, entity: EV, uc: 'opev', min_a: [6, 6, 6], max_a: [16, 16, 16], default_a: [6, 6, 6], limits: [{ phase: 'a', active: true, value_a: 16, changeable: true }] });
  await settle();
  assert.deepEqual([s.svc.deviceInfo(SKI_WB).ev.opev, s.svc.deviceInfo(SKI_WB).ev.opevStop], [true, false], 'Standard 6 A: 0 A würde zu 6 A');
  c.emitEvent({ ev: 'ev_limits', ski: SKI_WB, entity: EV, uc: 'opev', min_a: [6, 6, 6], max_a: [16, 16, 16], default_a: [0, 0, 0], limits: [{ phase: 'a', active: true, value_a: 16, changeable: false }] });
  await settle();
  assert.equal(s.svc.deviceInfo(SKI_WB).ev.opev, false, 'keine änderbare Grenze');
});

test('Netzanschluss: gleiche Gerätegrenze mit anderer Dauer (z. B. §14a-Ende) wird neu geschickt', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  c.emitEvent({ ev: 'device_nominal_max', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 3000 });
  await settle();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1000 }, 1_000_000 + 60_000);
  await settle();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1000 }, null);
  await settle();
  const sent = c.commands.filter((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:HP/1' && x.active === true);
  assert.equal(sent.length, 2, 'zweites Mal geschickt');
  assert.equal(sent.at(-1).duration_s, 0, 'ohne Ablauf');
});

test('Ablaufzeit je Gerät: untilById überschreibt die gemeinsame Dauer nur für dieses Gerät', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  c.emitEvent({ ev: 'device_nominal_max', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 3000 });
  await settle();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1000 }, 1_000_000 + 600_000, { [`eebus:${SKI_HP}`]: null });
  await settle();
  const sent = c.commands.filter((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:HP/1').at(-1);
  assert.equal(sent.duration_s, 0);
});

test('§14a-Geräteliste: EEBUS-Wallbox ist ein Ladepunkt (nicht Wärmepumpe), ohne Auto ohne Bedarf', async () => {
  const s = setup();
  s.ctx.p14a = { update: () => {} };
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  assert.equal(s.svc.consumptionDevices()[0].kind, 'waermepumpe', 'ohne weitere Angabe wie bisher Wärmepumpe');
  // Die Box meldet ein Auto (EVCC): Ladepunkt, Anlaufstufe aus der Mindestleistung des Autos
  c.emitEvent({ ev: 'ev_connected', ski: SKI_HP, entity: 'd:_n:EV/1' });
  c.emitEvent({ ev: 'ev_data', ski: SKI_HP, entity: 'd:_n:EV/1', power_min_w: 1380 });
  await settle();
  let d = s.svc.consumptionDevices()[0];
  assert.deepEqual([d.kind, d.startW, d.available], ['ladepunkt', 1380, true]);
  c.emitEvent({ ev: 'ev_disconnected', ski: SKI_HP, entity: 'd:_n:EV/1' });
  await settle();
  d = s.svc.consumptionDevices()[0];
  assert.deepEqual([d.kind, d.available], ['ladepunkt', false], 'abgesteckt: bleibt Ladepunkt, kein Bedarf');
});

test('§14a-Geräteliste: als Hauptwallbox eingetragene EEBUS-Box ist ein Ladepunkt', async () => {
  const s = setup({ extraCfg: { wallbox: { type: 'eebus', eebus: { ski: SKI_HP } } } });
  s.ctx.p14a = { update: () => {} };
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  const d = s.svc.consumptionDevices()[0];
  assert.deepEqual([d.kind, d.startW], ['ladepunkt', 4140], 'ohne Angabe des Autos: 6 A auf drei Phasen');
});

// ── Wiederanlauf und Warnungen der §14a-Gerätesteuerung (pv magazine 09.11.2026) ──
// Nach Neustart/Stromausfall muss DVhub die Kopplung zu den Geräten selbst
// wieder aufnehmen; fällt die Steuerung eines Geräts aus, warnt DVhub deutlich.
async function withHeatPump(opts = {}) {
  const s = setup(opts);
  s.ctx.p14a = { update: () => {} };
  const notes = [];
  s.ctx.notifyDirect = async (m) => { notes.push(m); return { ok: true }; };
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_BOX });
  c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  c.emitEvent({ ev: 'device_nominal_max', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 5500 });
  await settle();
  const limits = () => s.child().commands.filter((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:HP/1');
  return { s, c, notes, limits };
}

test('Wiederanlauf: meldet sich ein Gerät an, schreibt DVhub ohne Grenze „frei“ (Herzschlag startet, Failsafe des Geräts endet)', async () => {
  const { limits } = await withHeatPump();
  assert.equal(limits().length, 1, 'eine Vorgabe ans Gerät');
  assert.equal(limits()[0].active, false);
});

test('Wiederanlauf: ohne Steuerbox und ohne §14a-Relais bleibt das Gerät unberührt', async () => {
  const { limits } = await withHeatPump({ eebus: { trusted: [{ ski: SKI_HP, name: 'Wärmepumpe', role: 'device' }] } });
  assert.equal(limits().length, 0);
});

test('Wiederanlauf: nach Neustart des Hilfsprozesses gehen aktive Anteile sofort wieder ans Gerät', async () => {
  const { s, limits } = await withHeatPump();
  // §14a-Dienst: laufende Begrenzung, 1500 W für die Wärmepumpe
  s.ctx.p14a = { update: () => s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1500 }, null) };
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1500 }, null);
  await settle();
  assert.deepEqual([limits().at(-1).w, limits().at(-1).active], [1500, true]);
  s.child().emit('exit', 1, null);
  await settle();
  await s.timers.find((x) => x.ms === 5_000).fn();
  const c2 = s.child();
  c2.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c2.emitEvent({ ev: 'connected', ski: SKI_HP });
  c2.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  const sent = c2.commands.filter((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:HP/1');
  assert.deepEqual(sent.map((x) => [x.w, x.active]), [[1500, true]], 'Anteil sofort neu geschrieben');
});

test('Warnung: gesteuertes Gerät nicht erreichbar → nach 60 s Warnung (Log, Leitstand, Benachrichtigung), wieder da → aufgehoben', async () => {
  const { s, c, notes } = await withHeatPump();
  c.emitEvent({ ev: 'disconnected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_removed', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  s.advance(30_000);
  s.svc._tick();
  assert.equal(s.svc.controlIssues().length, 0, 'kurzer Aussetzer: noch keine Warnung');
  s.advance(31_000);
  s.svc._tick();
  const issues = s.svc.controlIssues();
  assert.deepEqual(issues.map((i) => [i.ski, i.code]), [[SKI_HP, 'unreachable']]);
  assert.match(issues[0].text, /nicht erreichbar/);
  assert.deepEqual(s.svc.summary().issues.map((i) => i.code), ['unreachable'], 'im Leitstand');
  assert.ok(s.logs.some(([e, d]) => e === 'paragraph14a_device_issue' && d.code === 'unreachable'));
  assert.equal(notes.length, 1, 'eine Benachrichtigung');
  assert.equal(notes[0].level, 'warning');
  s.svc._tick();
  assert.equal(notes.length, 1, 'nicht bei jedem Takt');
  // wieder da
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  s.svc._tick();
  assert.equal(s.svc.controlIssues().length, 0);
  assert.ok(s.logs.some(([e, d]) => e === 'paragraph14a_device_issue_resolved' && d.code === 'unreachable'));
});

test('Umsetzung nach Meldung des Geräts: ohne Rückmeldung keine Fehlmeldung, abweichende Meldung → Warnung und neu schreiben', async () => {
  const { s, c, limits } = await withHeatPump();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 2000 }, null);
  await settle();
  s.advance(40_000);
  s.svc._tick();
  assert.equal(s.svc.controlIssues().length, 0, 'Gerät meldet nichts: kein „nicht reagiert“');
  // Gerät meldet seine Grenze: passt
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 2000, active: true });
  await settle();
  s.advance(40_000);
  s.svc._tick();
  assert.equal(s.svc.controlIssues().length, 0);
  // Gerät meldet etwas anderes (z. B. seinen Failsafe-Wert)
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 4200, active: true });
  await settle();
  const before = limits().length;
  s.advance(61_000);
  s.svc._tick();
  await settle();
  assert.deepEqual(s.svc.controlIssues().map((i) => i.code), ['not_applied']);
  assert.equal(limits().length, before + 1, 'Vorgabe erneut geschrieben');
  assert.deepEqual([limits().at(-1).w, limits().at(-1).active], [2000, true]);
  // jetzt umgesetzt
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 2000, active: true });
  await settle();
  s.svc._tick();
  assert.equal(s.svc.controlIssues().length, 0);
});

test('Umsetzung nach Messung: zieht das Gerät 60 s deutlich mehr als die Vorgabe → Warnung', async () => {
  const { s, c } = await withHeatPump();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 2000 }, null);
  c.emitEvent({ ev: 'device_measurement', uc: 'mpc', ski: SKI_HP, entity: 'd:_n:HP/1', name: 'power_w', value: 3500 });
  await settle();
  s.svc._tick();
  s.advance(61_000);
  s.svc._tick();
  assert.deepEqual(s.svc.controlIssues().map((i) => i.code), ['over_limit']);
  c.emitEvent({ ev: 'device_measurement', uc: 'mpc', ski: SKI_HP, entity: 'd:_n:HP/1', name: 'power_w', value: 1900 });
  await settle();
  s.svc._tick();
  assert.equal(s.svc.controlIssues().length, 0);
});

test('Gerät lehnt die Vorgabe ab (write_result) → Warnung mit Gerät, nächster Erfolg hebt sie auf', async () => {
  const { s, c, limits } = await withHeatPump();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 2000 }, null);
  await settle();
  c.emitEvent({ ev: 'write_result', id: limits().at(-1).id, ok: false });
  await settle();
  assert.ok(s.logs.some(([e, d]) => e === 'eebus_device_write_rejected' && d.ski === SKI_HP));
  s.svc._tick();
  assert.deepEqual(s.svc.controlIssues().map((i) => i.code), ['rejected'], 'sofort, ohne Wartezeit');
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 2500 }, null);
  await settle();
  c.emitEvent({ ev: 'write_result', id: limits().at(-1).id, ok: true });
  await settle();
  s.svc._tick();
  assert.equal(s.svc.controlIssues().length, 0);
});

test('getrenntes Gerät bleibt in der §14a-Liste: Failsafe-Wert des Geräts (sonst Nennleistung) als belegt', async () => {
  const { s, c } = await withHeatPump();
  c.emitEvent({ ev: 'device_failsafe_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 4200 });
  await settle();
  assert.deepEqual(s.svc.lostConsumptionDevices(), []);
  c.emitEvent({ ev: 'disconnected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_removed', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  const lost = s.svc.lostConsumptionDevices();
  assert.deepEqual(lost.map((d) => [d.id, d.kind, d.maxW, d.failsafeW]), [[`eebus:${SKI_HP}`, 'waermepumpe', 5500, 4200]]);
});

test('§14a-Geräteliste: Auto-Zustand unbekannt (nur ev_limits) zählt nicht als abgesteckt (Codex e579fc30)', async () => {
  const s = setup();
  s.ctx.p14a = { update: () => {} };
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  c.emitEvent({ ev: 'ev_limits', ski: SKI_HP, entity: 'd:_n:EV/1', uc: 'opev', min_a: [6], max_a: [16], default_a: [0], limits: [] });
  await settle();
  const d = s.svc.consumptionDevices()[0];
  assert.deepEqual([d.kind, d.available], ['ladepunkt', true]);
});

// ── Codex 5323c75b ──
test('Wiederanlauf: scheitert das erste „frei“ (Grenzbeschreibung noch nicht gelesen), versucht DVhub es erneut', async () => {
  const s = setup();
  s.ctx.p14a = { update: () => {} };
  await s.svc.start();
  const c = s.child();
  c.failCmds = { device_limit: 1 };
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  const limits = () => c.commands.filter((x) => x.cmd === 'device_limit' && x.entity === 'd:_n:HP/1');
  assert.equal(limits().length, 1);
  s.advance(11_000);
  s.svc._tick();
  await settle();
  assert.equal(limits().length, 2, 'erneut geschrieben');
  s.advance(11_000);
  s.svc._tick();
  await settle();
  assert.equal(limits().length, 2, 'nach Erfolg nicht mehr');
});

test('Wiederanlauf: bei laufender Grenze rechnet DVhub die Aufteilung neu, statt das Gerät freizugeben', async () => {
  const { s, c } = await withHeatPump();
  // §14a-Dienst rechnet das wieder verbundene Gerät neu ein
  s.ctx.p14a = { update: () => s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1500 }, null) };
  s.svc.applyConsumptionShares({}, null); // Gerät war weg: nicht mehr in den Anteilen
  c.emitEvent({ ev: 'disconnected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_removed', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  const n = c.commands.length;
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  const sent = c.commands.slice(n).filter((x) => x.cmd === 'device_limit');
  assert.deepEqual(sent.map((x) => [x.w, x.active]), [[1500, true]], 'kein „frei“ zwischendurch');
});

test('Prüfung: eine Grenze von Hand (setDeviceLimit) gilt als Vorgabe, wird nicht überschrieben', async () => {
  const { s, c, limits } = await withHeatPump();
  await s.svc.setDeviceLimit(SKI_HP, 1500, 0);
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 1500, active: true });
  await settle();
  const n = limits().length;
  s.advance(61_000);
  s.svc._tick();
  await settle();
  assert.equal(limits().length, n);
  assert.equal(s.svc.controlIssues().length, 0);
});

test('Prüfung: ohne Weitergabe der §14a-Grenze (forwardGridLimit aus) keine Überwachung, kein Neuschreiben', async () => {
  const { s, c, limits } = await withHeatPump();
  s.setCfg((cfg) => ({ ...cfg, eebus: { ...cfg.eebus, devices: { forwardGridLimit: false } } }));
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 3000, active: true });
  await settle();
  const n = limits().length;
  s.advance(61_000);
  s.svc._tick();
  await settle();
  assert.equal(limits().length, n);
  assert.equal(s.svc.controlIssues().length, 0);
});

test('Prüfung: eine LPP-Rückmeldung wird nicht mit der LPC-Vorgabe verglichen', async () => {
  const { s, c, limits } = await withHeatPump();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 2000 }, null);
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 2000, active: true });
  c.emitEvent({ ev: 'device_limit', uc: 'lpp', entity: 'd:_n:HP/2', ski: SKI_HP, w: 0, active: false });
  await settle();
  const n = limits().length;
  s.advance(61_000);
  s.svc._tick();
  await settle();
  assert.equal(s.svc.controlIssues().length, 0);
  assert.equal(limits().length, n);
});

test('Prüfung: abweichende Rückmeldung wird nach 60 s gemeldet (nicht erst nach 120 s)', async () => {
  const { s, c } = await withHeatPump();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 2000 }, null);
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 4200, active: true });
  await settle();
  s.advance(61_000);
  s.svc._tick();
  assert.deepEqual(s.svc.controlIssues().map((i) => i.code), ['not_applied']);
});

// Fable R2 P2-2: im Lese-Modus startet der EEBUS-Knoten nicht — schon die
// Teilnahme schreibt (Freigabe/Quittung der Steuerbox-Vorgaben, Herzschlag,
// Messwerte, Verdichter-Planung). Lesen über EEBUS geht ohne Teilnahme nicht.
test('Lese-Modus (DVHUB_READ_ONLY=1): EEBUS-Knoten startet nicht (keine Teilnahme gegenüber Steuerbox und Geräten)', async () => {
  process.env.DVHUB_READ_ONLY = '1';
  try {
    const s = setup();
    await s.svc.start();
    assert.equal(s.children.length, 0, 'kein Hilfsprozess');
    assert.equal(s.svc.status().status, 'read_only');
    assert.match(s.svc.status().error, /Lese-Modus/);
    assert.ok(s.logs.some(([e]) => e === 'eebus_read_only'));
  } finally {
    delete process.env.DVHUB_READ_ONLY;
  }
});

test('Lese-Modus: letzte Sperre im Befehlsweg — keine Vorgabe, keine Verdichter-Planung, kein Ladestrom', async () => {
  const { s, c, limits } = await withHeatPump();
  process.env.DVHUB_READ_ONLY = '1';
  try {
    const before = c.commands.length;
    s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 2000 }, null);
    c.emitEvent({ ev: 'ohpcf_announce', uc: 'ohpcf', entity: 'd:_n:HP/1/1', ski: SKI_HP, max_power_w: 2000, earliest_start_s: 0, latest_end_s: 7200, min_duration_s: 1800 });
    await settle();
    s.advance(11_000);
    s.svc._tick();
    await settle();
    const r = await s.svc.setEvCurrentLimits(SKI_HP, [6]);
    const sent = c.commands.slice(before).filter((x) => ['device_limit', 'device_failsafe', 'ohpcf', 'ev_current_limits'].includes(x.cmd));
    assert.deepEqual(sent, [], 'kein Gerätebefehl im Lese-Modus');
    assert.equal(limits().filter((x) => x.active).length, 0);
    assert.equal(r.ok, false);
  } finally {
    delete process.env.DVHUB_READ_ONLY;
  }
});

// ── Fable R2 P2-3: Wiederanlauf auch für Geräte, die DVhub ohne Steuerbox/Relais begrenzt hat ──
async function heatPumpWithoutBox(s) {
  s.ctx.p14a = { update: () => {} };
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  return c;
}

test('Wiederanlauf ohne Steuerbox: hat DVhub das Gerät begrenzt (Netzanschluss-Deckel), schreibt es nach dem Neustart des Hilfsprozesses „frei“', async () => {
  const s = setup({ eebus: { trusted: [{ ski: SKI_HP, name: 'Wärmepumpe', role: 'device' }] } });
  const c = await heatPumpWithoutBox(s);
  assert.equal(c.commands.filter((x) => x.cmd === 'device_limit').length, 0, 'nie geführt: unberührt');
  // Netzanschluss-Wächter deckelt die WP einmal (über die Aufteilung)
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 2000 }, null, { [`eebus:${SKI_HP}`]: null });
  await settle();
  assert.deepEqual(c.commands.filter((x) => x.cmd === 'device_limit').map((x) => [x.w, x.active]), [[2000, true]]);
  // Deckel wieder weg, dann startet der Hilfsprozess neu (DVhubs Herzschlag endet)
  s.svc.applyConsumptionShares({}, null);
  await settle();
  c.emit('exit', 1, null);
  await settle();
  await s.timers.find((x) => x.ms === 5_000).fn();
  const c2 = s.child();
  c2.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  c2.emitEvent({ ev: 'connected', ski: SKI_HP });
  c2.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  await settle();
  const sent = c2.commands.filter((x) => x.cmd === 'device_limit');
  assert.deepEqual(sent.map((x) => x.active), [false], '„frei“ beendet den Failsafe des Geräts');
});

test('Wiederanlauf ohne Steuerbox: „geführt“ übersteht einen Neustart von DVhub (controlled.json)', async () => {
  const eebus = { trusted: [{ ski: SKI_HP, name: 'Wärmepumpe', role: 'device' }] };
  const a = setup({ eebus });
  const c = await heatPumpWithoutBox(a);
  await a.svc.setDeviceLimit(SKI_HP, 1500);
  await settle();
  assert.equal(c.commands.filter((x) => x.cmd === 'device_limit').length, 1);
  await a.svc.stop();
  // neuer Prozess, gleiches Datenverzeichnis
  const b = setup({ eebus, dir: a.dir });
  const c2 = await heatPumpWithoutBox(b);
  assert.deepEqual(c2.commands.filter((x) => x.cmd === 'device_limit').map((x) => x.active), [false]);
});

// ── Fable R2 P2-5: Leistung eines EEBUS-Geräts nur aus der laufenden Verbindung und nicht zu alt ──
test('Messwert des Geräts: nach Trennung unbekannt, nach 5 min ohne Meldung unbekannt', async () => {
  const { s, c } = await withHeatPump();
  c.emitEvent({ ev: 'device_measurement', uc: 'mpc', entity: 'd:_n:HP/2', ski: SKI_HP, name: 'power_w', value: 3000 });
  await settle();
  assert.equal(s.svc.consumptionDevices()[0].powerW, 3000);
  c.emitEvent({ ev: 'disconnected', ski: SKI_HP });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  await settle();
  assert.equal(s.svc.consumptionDevices()[0].powerW, null, 'alter Wert aus der vorigen Verbindung zählt nicht');
  c.emitEvent({ ev: 'device_measurement', uc: 'mpc', entity: 'd:_n:HP/2', ski: SKI_HP, name: 'power_w', value: 2500 });
  await settle();
  assert.equal(s.svc.consumptionDevices()[0].powerW, 2500);
  s.advance(5 * 60_000 + 1);
  assert.equal(s.svc.consumptionDevices()[0].powerW, null, 'zu alt');
});

// ── Fable R2 P3-4: Grenz-Rückmeldung aus der vorigen Verbindung zählt nicht ──
test('Umsetzungsprüfung: alte Grenz-Rückmeldung (vor der Trennung) löst nach dem Wiederanmelden keinen Fehlalarm aus', async () => {
  const { s, c } = await withHeatPump();
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 4200, active: true });
  c.emitEvent({ ev: 'disconnected', ski: SKI_HP });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP }); // DVhub schreibt „frei“
  await settle();
  s.advance(61_000);
  s.svc._tick();
  assert.deepEqual(s.svc.controlIssues().map((i) => i.code), [], 'Gerät hat in dieser Verbindung noch nichts gemeldet');
});

// ── Fable R2 P1-1: MGCP nur mit gültigem, frischem Zähler ──
test('Netzanschlusspunkt (MGCP): ungültiger oder alter Zählerwert geht nicht an die Steuerbox', async () => {
  const s = setup();
  await s.svc.start();
  const c = s.child();
  c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
  await settle();
  const gcp = () => c.commands.filter((x) => x.cmd === 'gcp');
  const pushGcp = s.intervals.find((x) => x.ms === 5_000).fn;
  s.state.meter = { ok: false, updatedAt: s.now(), grid_total_w: 0 };
  pushGcp();
  await settle();
  assert.equal(gcp().length, 0, 'Start: Zähler nicht gelesen');
  s.state.meter = { ok: true, updatedAt: s.now() - 60_000, grid_total_w: -2500 };
  pushGcp();
  await settle();
  assert.equal(gcp().length, 0, 'eingefroren');
  s.state.meter = { ok: true, updatedAt: s.now(), grid_total_w: -2500 };
  pushGcp();
  await settle();
  assert.deepEqual(gcp().map((x) => x.power_w), [2500]);
});

// ── Fable R2 P3-1: Go-Hilfsprozess prüft die 2-min-Frist selbst ──
test('grid_heartbeat_state mit within_duration (Go): Failsafe sofort; ohne (C): erst nach 120 s', async () => {
  for (const [flag, want] of [[true, 'failsafe'], [undefined, 'unlimited_controlled']]) {
    const s = setup();
    await s.svc.start();
    const c = s.child();
    c.emitEvent({ ev: 'ready', ski: 'd'.repeat(40) });
    c.emitEvent({ ev: 'connected', ski: SKI_BOX });
    c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: true, lpp_ok: true, within_duration: flag });
    await settle();
    s.advance(5_000);
    c.emitEvent({ ev: 'grid_heartbeat_state', lpc_ok: false, lpp_ok: false, within_duration: flag });
    await settle();
    assert.equal(s.svc.status().grid.lpc.state, want, `within_duration=${flag}`);
  }
});

// ── Fable R2 P2-4: gespeicherte, noch gültige Grenze gilt gleich beim Start ──
test('Neustart während einer Begrenzung: Grenze gilt sofort beim Start, nicht erst mit Takt oder Herzschlag', async () => {
  const s = setup();
  const t = s.now();
  fs.writeFileSync(path.join(s.dir, 'eebus', 'grid-state.json'), JSON.stringify({
    lpc: { failsafeW: null, failsafeDurationS: null, limit: { w: 4200, active: true, receivedAt: t - 60_000, until: t + 3600_000 }, failsafeSince: null },
    lpp: { failsafeW: null, failsafeDurationS: null, limit: null, failsafeSince: null },
  }));
  await s.svc.start();
  assert.equal(s.state.ctrl.eebusConsumptionLimitW, 4200);
  assert.equal(s.state.ctrl.eebusConsumptionLimitUntil, t + 3600_000);
});

// ── Codex aa32838a ──
test('Prüfung: Freigabe einer Wallbox-Grenze (setEmsLimit null) bleibt überwacht, bis das Gerät sie umsetzt — auch ohne §14a-Weitergabe', async () => {
  const { s, c, limits } = await withHeatPump({ eebus: { devices: { forwardGridLimit: false } } });
  await s.svc.setEmsLimit(SKI_HP, 0);
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 0, active: true });
  await settle();
  await s.svc.setEmsLimit(SKI_HP, null);
  await settle();
  assert.equal(limits().at(-1).active, false);
  const n = limits().length;
  s.advance(61_000);
  s.svc._tick();
  await settle();
  assert.deepEqual(s.svc.controlIssues().map((i) => i.code), ['not_applied'], 'Gerät hält noch 0 W');
  assert.equal(limits().length, n + 1, 'Freigabe erneut geschrieben');
  assert.equal(limits().at(-1).active, false);
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 0, active: false });
  await settle();
  s.svc._tick();
  assert.equal(s.svc.controlIssues().length, 0);
});

test('Prüfung: befristete Grenze von Hand wird nach Ablauf nicht erneut geschrieben', async () => {
  const { s, c, limits } = await withHeatPump();
  await s.svc.setDeviceLimit(SKI_HP, 1500, 120);
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 1500, active: true });
  await settle();
  s.advance(121_000);
  // abgelaufen: das Gerät meldet „frei“
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 1500, active: false });
  await settle();
  const n = limits().length;
  s.advance(61_000);
  s.svc._tick();
  await settle();
  assert.equal(limits().length, n, 'nicht wieder aktiviert');
  assert.equal(s.svc.controlIssues().length, 0, 'keine Fehlmeldung');
});

// ── Not-Halt „als ob die Kiste aus ist“ (Christin 10.11.2026) ─────────────────
// § 14a läuft im Not-Halt nicht weiter: beim Eintritt die von DVhub gesetzten
// Grenzen EINMAL frei, Herzschlag zu den Geräten aus, danach keine Gerätebefehle
// mehr (kein Auffrischen, kein Neuschreiben, kein „frei“ beim Anmelden, keine
// Verdichterplanung). Beim Aufheben sauber wieder anlaufen.
const DEVICE_CMDS = new Set(['device_limit', 'device_failsafe', 'ohpcf', 'ev_current_limits', 'device_heartbeat']);
const deviceCmds = (c) => c.commands.filter((x) => DEVICE_CMDS.has(x.cmd));

async function enterNotHalt(s) {
  s.state.ctrl.discretionaryWritesPaused = true;
  s.state.ctrl.pausedAt = 4242;
  s.state.ctrl._notHaltNeutralizing = true;
  const r = await s.svc.emergencyStop();
  s.state.ctrl._notHaltNeutralizing = false;
  await settle();
  return r;
}

test('Not-Halt: aktive §14a-Grenze einmal frei, dann Herzschlag aus — danach keine Gerätebefehle', async () => {
  const { s, c, limits } = await withHeatPump();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1500 }, null);
  await settle();
  assert.deepEqual([limits().at(-1).w, limits().at(-1).active], [1500, true]);
  const before = c.commands.length;
  const r = await enterNotHalt(s);
  assert.equal(r.ok, true);
  assert.deepEqual(c.commands.slice(before).map((x) => [x.cmd, x.active ?? x.on]), [['device_limit', false], ['device_heartbeat', false]],
    'genau eine Freigabe, dann Herzschlag aus');
  assert.equal(s.svc.summary().notHalt.suspended, true);
  assert.equal(s.svc.status().notHalt.heartbeat, 'stopped');

  const n = deviceCmds(c).length;
  // §14a-Anteile, Neuschreiben nach Abweichung, Wiederanmeldung, Verdichter, von Hand
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 900 }, null);
  c.emitEvent({ ev: 'device_limit', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP, w: 3000, active: true });
  for (let i = 0; i < 5; i++) { s.advance(70_000); s.svc._tick(); }
  c.emitEvent({ ev: 'disconnected', ski: SKI_HP });
  c.emitEvent({ ev: 'connected', ski: SKI_HP });
  c.emitEvent({ ev: 'device_added', uc: 'lpc', entity: 'd:_n:HP/1', ski: SKI_HP });
  c.emitEvent({ ev: 'ohpcf_announce', uc: 'ohpcf', entity: 'd:_n:HP/1/1', ski: SKI_HP, max_power_w: 2000, earliest_start_s: 0, latest_end_s: 7200, min_duration_s: 1800 });
  await settle();
  assert.equal((await s.svc.setDeviceLimit(SKI_HP, 1000, 0)).error, 'emergency_stop_active');
  assert.equal((await s.svc.setEmsLimit(SKI_HP, 1000)).error, 'emergency_stop_active');
  await settle();
  assert.equal(deviceCmds(c).length, n, 'im Not-Halt kein einziger Gerätebefehl');
  assert.ok(s.logs.some(([e]) => e === 'eebus_write_blocked_nothalt'));
});

test('Not-Halt: ohne eigene aktive Grenze nichts freizugeben — nur Herzschlag aus; Wallbox-Grenze bleibt', async () => {
  const { s, c } = await withHeatPump();
  const before = c.commands.length;
  await enterNotHalt(s);
  assert.deepEqual(c.commands.slice(before).map((x) => x.cmd), ['device_heartbeat'], 'Gerät war frei: im Zweifel nichts senden');

  const w = await withWallbox();
  await w.s.svc.setEmsLimit(SKI_WB, 0); // Not-Halt-Stopp der Wallbox (eos-evcc-bridge) vorher
  await settle();
  const b2 = w.c.commands.length;
  await enterNotHalt(w.s);
  assert.deepEqual(w.c.commands.slice(b2).map((x) => x.cmd), ['device_heartbeat'], 'Stopp der Wallbox bleibt stehen');
});

test('Not-Halt: Hilfsprozess ohne device_heartbeat (C-Bridge, alt) wird neu gestartet — frisch ohne Herzschlag', async () => {
  const { s, c } = await withHeatPump();
  // „unknown command“ wie ein Hilfsprozess ohne den Befehl
  c.stdin.removeAllListeners('data');
  c.stdin.on('data', (chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      const cmd = JSON.parse(line);
      c.commands.push(cmd);
      if (cmd.id != null) c.emitEvent({ ev: 'reply', id: cmd.id, cmd: cmd.cmd, ok: cmd.cmd !== 'device_heartbeat', ...(cmd.cmd === 'device_heartbeat' ? { error: 'unknown command' } : {}) });
    }
  });
  let killed = false;
  c.kill = () => { killed = true; setImmediate(() => c.emit('exit', 0, null)); };
  const r = await enterNotHalt(s);
  assert.equal(r.heartbeat, 'restarted');
  assert.equal(killed, true);
  assert.ok(s.logs.some(([e]) => e === 'eebus_device_heartbeat_restart'));
});

// Fable R2 P3-11: scheitert „Herzschlag aus“ (Zeitüberschreitung), liefe er im
// Not-Halt weiter — dann den Hilfsprozess neu starten (frisch ohne Herzschlag;
// ein Prozess-Neustart ist kein Geräte-Write).
test('Not-Halt: „Herzschlag aus“ scheitert → Hilfsprozess wird neu gestartet', async () => {
  const { s, c } = await withHeatPump();
  c.failCmds = { device_heartbeat: 1 };
  let killed = false;
  c.kill = () => { killed = true; setImmediate(() => c.emit('exit', 0, null)); };
  const r = await enterNotHalt(s);
  assert.equal(r.heartbeat, 'restarted');
  assert.equal(killed, true);
  assert.ok(s.logs.some(([e]) => e === 'eebus_device_heartbeat_stop_failed'));
});

test('Not-Halt aufheben: Aufteilung neu, Gerät wie beim Anmelden aufgenommen (Herzschlag startet wieder)', async () => {
  const { s, limits } = await withHeatPump();
  s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1500 }, null);
  await settle();
  await enterNotHalt(s);
  s.ctx.p14a = { update: () => s.svc.applyConsumptionShares({ [`eebus:${SKI_HP}`]: 1500 }, null) };
  s.state.ctrl.discretionaryWritesPaused = false;
  const n = limits().length;
  const r = s.svc.resumeAfterEmergencyStop();
  await settle();
  assert.equal(r.ok, true);
  assert.deepEqual(limits().slice(n).map((x) => [x.w, x.active]), [[1500, true]], 'Grenze sofort wieder am Gerät');
  assert.equal(s.svc.summary().notHalt, null);
});
