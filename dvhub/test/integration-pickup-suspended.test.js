// R-T3 (VCL-Vertrag v6 D.1): Der Abholpfad ist ein Schreibpfad. Wer DVhubs Sollwert ABHOLT — Loxone über
// GET /api/integration/loxone, Home Assistant über /api/integration/home-assistant oder den MQTT-Spiegel
// <prefix>/control/*, das DVhub-Schema ohne Broker —, setzt ihn um. Bis 24eabf21 bekam er im Not-Halt und bei
// ungültiger Konfiguration den LETZTEN Sollwert weiter (rot vor dem Umbau). Soll (Christin 06.–10.11. und C2 16.11.2026,
// „als ob die Kiste aus ist — Werte laufen weiter“):
//   • Not-Halt, Lese-Modus (DVHUB_READ_ONLY=1), writeSafety.ok === false → die Steuerfelder sagen „keine Vorgabe“ in der
//     Form, die die Abnehmer schon kennen (Sollwerte null, Herkunft none, Regel/Zeitpunkt null, scheduleActive je Ziel
//     null) und nennen den Grund (dvhub_control_suspended; im MQTT-Spiegel kein eigenes Topic).
//   • §14a-/EEBUS-Grenzen zum Nachfolgen: im Not-Halt und Lese-Modus „keine Grenze“; bei ungültigem Herstellerprofil
//     laufen sie weiter (betrifft nur den Wechselrichter).
//   • Messwerte und Status (Netz, SoC, Rücklesungen, paused, forcedOff, DV-Signal) laufen unverändert weiter.
//   • Nach dem Aufheben bzw. mit wieder gültiger Config geht der aktuelle Sollwert wieder hinaus.
// Nur über die öffentlichen Wege (Routen-Handler, Publisher, Tor) — läuft so auch gegen 24eabf21 (dort rot).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createApiRoutes } from '../routes-api.js';
import { createMqttPublisher } from '../services/mqtt/publisher.js';
import { createLegacyGate } from '../services/gate/legacy.js';
import { setEmergencyStop } from '../services/control-commands.js';
import { blockedWriteCount } from '../read-only-guard.js';

const TOKEN = 'r'.repeat(64);
const T0 = 1_789_000_000_000;
const UNSAFE = { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' };

function makeState() {
  return {
    ctrl: { forcedOff: false, discretionaryWritesPaused: false, _stopBlockLogged: {} },
    meter: { ok: true, grid_total_w: 120, grid_l1_w: 40, grid_l2_w: 40, grid_l3_w: 40 },
    victron: { gridSetpointW: -100, minSocPct: 20, maxDischargeW: -1, soc: 55, batteryPowerW: -300, pvTotalW: 900, pvPowerW: 600 },
    schedule: {
      rules: [{ id: 'abend', source: 'forecast_optimizer', optimizer: 'eos' }],
      active: {
        gridSetpointW: { value: -3000, source: 'rule:abend', at: T0 },
        chargeCurrentA: { value: 30, source: 'default', at: T0 - 1000 },
        maxDischargeW: { value: 0, source: 'api_manual_write', at: T0 - 2000 },
        feedExcessDcPv: { value: 1, source: 'runtime', at: T0 - 500 },
      },
      lastWrite: {},
    },
    p14a: { active: true, limitW: 7560, source: 'eebus', budgetW: 7560, shares: { speicher: 3780, wallbox: 3780 } },
    eebus: { applied: { consumptionLimitW: 7560, productionLimitW: 4200, productionBlock: false } },
    costs: {}, energy: { day: '2026-09-14', importWh: 0, exportWh: 0, costEur: 0, revenueEur: 0 }, epex: { data: [] },
    keepalive: { modbusLastQuery: null },
  };
}

function makeRig({ cfgExtra = {}, gate = undefined } = {}) {
  const state = makeState();
  const cfg = {
    apiToken: TOKEN, trustProxy: true, trustedProxyIps: ['127.0.0.1'], allowedHosts: [], corsAllowedOrigins: [],
    gridPositiveMeans: 'grid_import', mqtt: { topicPrefix: 'dvhub' }, ...cfgExtra,
  };
  const ctx = {
    state, getCfg: () => cfg, getRawCfg: () => cfg, pushLog: () => {},
    controlValue: () => (state.ctrl.forcedOff ? 0 : 1), epexNowNext: () => ({ current: null, next: null }),
    needsSetup: () => false, getAppDir: () => process.cwd(), getAppVersion: () => ({ versionLabel: 'test' }),
    persistControlState: () => true,
  };
  if (gate !== undefined) ctx.gate = gate === 'shared' ? createLegacyGate({ isHalted: () => state.ctrl?.discretionaryWritesPaused === true }) : gate;
  const routes = createApiRoutes(ctx);
  const published = [];
  const hub = { publish(topic, payload, opts) { published.push({ topic, payload, opts }); }, connected: true };
  const publisher = createMqttPublisher(hub, ctx);
  return { state, cfg, ctx, routes, publisher, published };
}

async function get(r, pathname) {
  const req = {
    method: 'GET', url: pathname, headers: { host: 'dvhub.test', authorization: `Bearer ${TOKEN}` },
    socket: { remoteAddress: '127.0.0.1' }, on() { return req; }, destroy() {},
  };
  const res = { status: 0, body: '', writeHead(c) { this.status = c; }, setHeader() {}, end(b) { this.body = b == null ? '' : String(b); } };
  await r.routes.handleRequest(req, res, new URL(pathname, 'http://dvhub.test'));
  assert.equal(res.status, 200, res.body.slice(0, 300));
  return res.body;
}

async function loxone(r) {
  const body = await get(r, '/api/integration/loxone');
  return Object.fromEntries(body.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
}

const homeAssistant = async (r) => JSON.parse(await get(r, '/api/integration/home-assistant'));

function mqtt(r) {
  r.published.length = 0;
  r.publisher._publishOnce();
  const m = {};
  for (const p of r.published) m[p.topic] = { raw: p.payload, retain: p.opts?.retain };
  return { map: m, topics: r.published.map((p) => p.topic) };
}

const CONTROL_LINES = ['dvhub_control_grid_setpoint_w', 'dvhub_control_charge_current_a', 'dvhub_control_min_soc_pct', 'dvhub_control_max_discharge_w'];
const LIMIT_LINES = {
  dvhub_control_grid_limit_active: 'false', dvhub_control_grid_limit_source: 'none', dvhub_control_grid_limit_consumption_w: 'null',
  dvhub_control_grid_limit_production_w: 'null', dvhub_control_grid_limit_production_blocked: 'false',
};

function assertNoSetpoint(lines, reason, paused) {
  for (const k of CONTROL_LINES) assert.equal(lines[k], 'null', `${k}: keine Vorgabe statt des letzten Werts`);
  assert.equal(lines.dvhub_control_source, 'none');
  assert.equal(lines.dvhub_control_rule, 'null');
  assert.equal(lines.dvhub_control_updated_at, 'null');
  assert.equal(lines.dvhub_control_paused, String(paused), 'Status läuft weiter');
  assert.equal(lines.dvhub_control_suspended, reason, 'Grund sichtbar');
}

function assertMeasuredUnchanged(lines) {
  // Werte laufen weiter: Netz, SoC, Akku, PV, Rücklesungen der Anlage, DV-Signal.
  assert.equal(lines.gridTotalW, '120');
  assert.equal(lines.soc, '55');
  assert.equal(lines.batteryPowerW, '-300');
  assert.equal(lines.pvTotalW, '900');
  assert.equal(lines.gridSetpointW, '-100', 'Rücklesung bleibt');
  assert.equal(lines.minSocPct, '20', 'Rücklesung bleibt');
  assert.equal(lines.dvControlValue, '1');
  assert.equal(lines.forcedOff, 'false');
}

function assertCurrentSetpoint(lines) {
  assert.equal(lines.dvhub_control_grid_setpoint_w, '-3000');
  assert.equal(lines.dvhub_control_charge_current_a, '30');
  assert.equal(lines.dvhub_control_min_soc_pct, '20', 'Rücklesung als Fallback wie bisher');
  assert.equal(lines.dvhub_control_max_discharge_w, '0');
  assert.equal(lines.dvhub_control_source, 'eos');
  assert.equal(lines.dvhub_control_rule, 'abend');
  assert.equal(lines.dvhub_control_updated_at, new Date(T0).toISOString());
  assert.equal('dvhub_control_suspended' in lines, false, 'kein Grund-Feld im Normalbetrieb');
}

afterEach(() => { delete process.env.DVHUB_READ_ONLY; });

describe('R-T3 GET /api/integration/loxone — Not-Halt', () => {
  for (const gate of [undefined, 'shared']) {
    it(`keine Vorgabe statt des letzten Werts, Werte laufen weiter, danach wieder der aktuelle Sollwert (${gate ? 'Tor des Prozesses' : 'eigenes Tor'})`, async () => {
      const r = makeRig({ gate });
      assertCurrentSetpoint(await loxone(r));
      await setEmergencyStop(r.ctx, { on: true });
      assert.equal(r.state.ctrl.discretionaryWritesPaused, true);
      const halted = await loxone(r);
      assertNoSetpoint(halted, 'not_halt', true);
      for (const [k, v] of Object.entries(LIMIT_LINES)) assert.equal(halted[k], v, `${k}: §14a im Not-Halt ausgesetzt`);
      assertMeasuredUnchanged(halted);
      assert.deepEqual(JSON.parse(halted.scheduleActive), { gridSetpointW: null, chargeCurrentA: null, maxDischargeW: null, feedExcessDcPv: null });
      // Der Puffer selbst bleibt (DVhub hält seinen Zustand), nur hinaus geht er nicht.
      assert.equal(r.state.schedule.active.gridSetpointW.value, -3000);
      await setEmergencyStop(r.ctx, { on: false });
      const back = await loxone(r);
      assertCurrentSetpoint(back);
      assert.equal(back.dvhub_control_grid_limit_consumption_w, '7560');
      assert.equal(back.dvhub_control_paused, 'false');
    });
  }

  it('Not-Halt UND ungültige Config: Grund ist der Not-Halt (Reihenfolge des Tors)', async () => {
    const r = makeRig({ cfgExtra: { writeSafety: UNSAFE } });
    r.state.ctrl.discretionaryWritesPaused = true;
    assertNoSetpoint(await loxone(r), 'not_halt', true);
  });

  it('das Tor des Prozesses entscheidet: meldet es den Not-Halt, gibt die Route nichts heraus', async () => {
    const r = makeRig({ gate: createLegacyGate({ isHalted: () => true }) });
    assertNoSetpoint(await loxone(r), 'not_halt', false);
    const r2 = makeRig({ gate: createLegacyGate({ isHalted: () => { throw new Error('unlesbar'); } }) });
    assertNoSetpoint(await loxone(r2), 'not_halt', false);
  });
});

describe('R-T3 GET /api/integration/loxone — ungültige Konfiguration (C2) und Lese-Modus', () => {
  it('writeSafety.ok === false: keine Vorgabe, Grenzen der Steuerbox laufen weiter; gültig → wieder der aktuelle Wert', async () => {
    const r = makeRig({ cfgExtra: { writeSafety: UNSAFE }, gate: 'shared' });
    const lines = await loxone(r);
    assertNoSetpoint(lines, 'config_unsafe', false);
    assertMeasuredUnchanged(lines);
    assert.equal(lines.dvhub_control_grid_limit_active, 'true', 'Herstellerprofil betrifft nur den Wechselrichter');
    assert.equal(lines.dvhub_control_grid_limit_consumption_w, '7560');
    assert.equal(lines.dvhub_control_grid_limit_production_w, '4200');
    r.cfg.writeSafety = { ok: true };
    assertCurrentSetpoint(await loxone(r));
    delete r.cfg.writeSafety;
    assertCurrentSetpoint(await loxone(r));
  });

  it('DVHUB_READ_ONLY=1: keine Vorgabe und keine Grenze, ohne „Schreibzugriff blockiert“ je Abfrage zu zählen', async () => {
    const r = makeRig();
    process.env.DVHUB_READ_ONLY = '1';
    const before = blockedWriteCount();
    const lines = await loxone(r);
    assertNoSetpoint(lines, 'read_only', false);
    for (const [k, v] of Object.entries(LIMIT_LINES)) assert.equal(lines[k], v, k);
    assertMeasuredUnchanged(lines);
    assert.equal(blockedWriteCount(), before, 'Abholen ist kein Schreibversuch von DVhub');
    delete process.env.DVHUB_READ_ONLY;
    assertCurrentSetpoint(await loxone(r));
  });
});

describe('R-T3 Urteil nach dem letzten Warten (Codex 36f71297 P1)', () => {
  // integrationState wartet auf die Prognose; kommt der Not-Halt (oder wird die Config ungültig), während die Antwort
  // noch auf sie wartet, darf sie nicht mit dem vorher gelesenen Sollwert hinausgehen.
  for (const [label, change, reason, paused] of [
    ['Not-Halt', (r) => { r.state.ctrl.discretionaryWritesPaused = true; }, 'not_halt', true],
    ['ungültige Config', (r) => { r.cfg.writeSafety = UNSAFE; }, 'config_unsafe', false],
  ]) {
    for (const pathname of ['/api/integration/loxone', '/api/integration/home-assistant']) {
      it(`${label} während des Wartens auf die Prognose: ${pathname} gibt keine Vorgabe heraus`, async () => {
        const r = makeRig();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let asked = 0;
        r.ctx.forecastService = { buildForecastResponse: async () => { asked += 1; await gate; return null; } };
        const pending = get(r, pathname);
        for (let i = 0; i < 20 && asked === 0; i += 1) await new Promise((res) => setImmediate(res));
        assert.equal(asked, 1, 'Antwort wartet auf die Prognose');
        change(r);
        release();
        const body = await pending;
        if (pathname.endsWith('loxone')) {
          const lines = Object.fromEntries(body.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
          assertNoSetpoint(lines, reason, paused);
          assert.equal(JSON.parse(lines.scheduleActive).gridSetpointW, null);
        } else {
          const s = JSON.parse(body);
          assert.equal(s.dvhub_control_grid_setpoint_w, null);
          assert.equal(s.dvhub_control_suspended, reason);
          assert.equal(s.dvhub_control_paused, paused);
          assert.equal(s.scheduleActive.gridSetpointW, null);
        }
      });
    }
  }
});

describe('R-T3 GET /api/integration/home-assistant', () => {
  it('Not-Halt: dieselben Steuerfelder und scheduleActive je Ziel null, Messwerte unverändert', async () => {
    const r = makeRig();
    r.state.ctrl.discretionaryWritesPaused = true;
    const s = await homeAssistant(r);
    assert.equal(s.dvhub_control_grid_setpoint_w, null);
    assert.equal(s.dvhub_control_max_discharge_w, null);
    assert.equal(s.dvhub_control_source, 'none');
    assert.equal(s.dvhub_control_paused, true);
    assert.equal(s.dvhub_control_suspended, 'not_halt');
    assert.equal(s.dvhub_control_grid_limit_active, false);
    assert.deepEqual(s.scheduleActive, { gridSetpointW: null, chargeCurrentA: null, maxDischargeW: null, feedExcessDcPv: null });
    assert.equal(s.gridSetpointW, -100);
    assert.equal(s.soc, 55);
    r.state.ctrl.discretionaryWritesPaused = false;
    const back = await homeAssistant(r);
    assert.equal(back.dvhub_control_grid_setpoint_w, -3000);
    assert.equal('dvhub_control_suspended' in back, false);
    assert.deepEqual(back.scheduleActive, r.state.schedule.active);
  });
});

describe('R-T3 MQTT-Spiegel <prefix>/control/*', () => {
  const SETPOINT_TOPICS = ['dvhub/control/grid_setpoint_w', 'dvhub/control/charge_current_a', 'dvhub/control/min_soc_pct', 'dvhub/control/max_discharge_w'];

  it('Not-Halt: Sollwerte null, Herkunft none, Grenzen frei, paused true — dieselben Topics, Messwerte weiter; danach wieder da', async () => {
    const r = makeRig({ gate: 'shared' });
    const normal = mqtt(r);
    assert.equal(normal.map['dvhub/control/grid_setpoint_w'].raw, '-3000');
    await setEmergencyStop(r.ctx, { on: true });
    const halted = mqtt(r);
    assert.deepEqual(halted.topics, normal.topics, 'kein Topic dazu, keines weg');
    for (const t of SETPOINT_TOPICS) {
      assert.equal(halted.map[t].raw, 'null', `${t}: keine Vorgabe`);
      assert.equal(halted.map[t].retain, true);
    }
    assert.equal(halted.map['dvhub/control/source'].raw, 'none');
    assert.equal(halted.map['dvhub/control/rule'].raw, 'null');
    assert.equal(halted.map['dvhub/control/updated_at'].raw, 'null');
    assert.equal(halted.map['dvhub/control/paused'].raw, 'true', 'Status läuft weiter (HA-Schalter Not-Halt)');
    const st = JSON.parse(halted.map['dvhub/control/state'].raw);
    for (const k of ['gridSetpointW', 'chargeCurrentA', 'minSocPct', 'maxDischargeW']) assert.deepEqual(st[k], { value: null, source: null, at: null, origin: null });
    assert.equal(halted.map['dvhub/control/grid_limit/active'].raw, 'false');
    assert.equal(halted.map['dvhub/control/grid_limit/consumption_w'].raw, 'null');
    assert.equal(halted.map['dvhub/control/grid_limit/production_w'].raw, 'null');
    assert.deepEqual(JSON.parse(halted.map['dvhub/control/grid_limit/state'].raw).shares, {});
    // Messwerte und Rücklesung laufen weiter.
    for (const t of ['dvhub/energy/grid_power_w', 'dvhub/battery/soc_pct', 'dvhub/battery/min_soc_pct', 'dvhub/solar/pv_total_w']) {
      assert.equal(halted.map[t].raw, normal.map[t].raw, t);
    }
    await setEmergencyStop(r.ctx, { on: false });
    const back = mqtt(r);
    assert.deepEqual(back.map, normal.map, 'nach dem Aufheben wieder genau der Normalbetrieb');
  });

  it('ungültige Config: Sollwerte null, Grenzen laufen weiter; Lese-Modus: beides null', () => {
    const r = makeRig({ cfgExtra: { writeSafety: UNSAFE } });
    const unsafe = mqtt(r).map;
    for (const t of SETPOINT_TOPICS) assert.equal(unsafe[t].raw, 'null', t);
    assert.equal(unsafe['dvhub/control/paused'].raw, 'false');
    assert.equal(unsafe['dvhub/control/grid_limit/consumption_w'].raw, '7560');
    assert.equal(unsafe['dvhub/control/grid_limit/production_w'].raw, '4200');
    const ro = makeRig();
    process.env.DVHUB_READ_ONLY = '1';
    const m = mqtt(ro).map;
    for (const t of SETPOINT_TOPICS) assert.equal(m[t].raw, 'null', t);
    assert.equal(m['dvhub/control/grid_limit/active'].raw, 'false');
  });
});

describe('R-T3 Datenfluss-Übersicht (Oberfläche „Raus — Sollwerte“)', () => {
  it('zeigt, was wirklich hinausgeht, und warum nichts', async () => {
    const r = makeRig();
    r.cfg.writeSafety = UNSAFE;
    const df = JSON.parse(await get(r, '/api/integrations/dataflow'));
    assert.equal(df.out.control.suspended, 'config_unsafe');
    assert.equal(df.out.control.rows.find((x) => x.key === 'gridSetpointW').value, null);
    assert.equal(df.out.gridLimit.consumptionW, 7560);
    delete r.cfg.writeSafety;
    const ok = JSON.parse(await get(r, '/api/integrations/dataflow'));
    assert.equal('suspended' in ok.out.control, false);
    assert.equal(ok.out.control.rows.find((x) => x.key === 'gridSetpointW').value, -3000);
  });
});
