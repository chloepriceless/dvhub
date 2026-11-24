// Paritätsnachweis R-T3 (VCL-Vertrag v6 D.1, D.2, D.4(2)) für den NORMALBETRIEB: Seit der Abholpuffer eine Senke hinter
// dem Schreibtor ist (services/gate/pickup.js), entscheidet das Tor bei jeder Herausgabe, ob eine Vorgabe hinausgeht.
// Außerhalb von Not-Halt, Lese-Modus und ungültiger Konfiguration muss alles bit-gleich bleiben wie VOR dem Umbau
// (Stand 24eabf21): der ganze Text von GET /api/integration/loxone, der ganze JSON-Text von
// GET /api/integration/home-assistant, die Datenfluss-Übersicht (GET /api/integrations/dataflow) und jede
// MQTT-Veröffentlichung des Publishers (Topic, Nutzlast, Optionen, Reihenfolge, Zahl der Topics).
//
// Die Golden-Datei test/fixtures/gate-golden/pickup-parity.json ist mit dem ORIGINALCODE von 24eabf21 erzeugt
// (diese Testdatei unverändert in einem Abzug von 24eabf21). Gegenbeweis/Neuerzeugung:
//   git archive 24eabf21 dvhub | tar -x -C <leeres Verzeichnis>; node_modules daneben verlinken; diese Datei nach
//   <dir>/dvhub/test/ kopieren; dort GOLDEN_FREEZE=1 node --test test/gate-pickup-parity.test.js; die erzeugte
//   test/fixtures/gate-golden/pickup-parity.json hierher kopieren — sie muss byte-gleich zur eingecheckten sein.
//
// Die Erholungs-Szenarien fragen auch WÄHREND der Sperre ab (Ergebnis verworfen — dort gilt das neue Soll, geprüft in
// test/gate-pickup.test.js) und vergleichen danach: die Sperre hinterlässt im Tor nichts, was die Herausgabe nach dem
// Aufheben verändert. Uhr fest (GOLDEN_T0); `system/uptime_sec` hängt an process.uptime() und wird geschwärzt.

import { test } from 'node:test';

import { createApiRoutes } from '../routes-api.js';
import { createMqttPublisher } from '../services/mqtt/publisher.js';
import { createLegacyGate } from '../services/gate/legacy.js';
import { GOLDEN_T0, fixClock, goldenFile } from './helpers/gate-golden.js';

const golden = goldenFile('pickup-parity');
const TOKEN = 'p'.repeat(64);
const T0 = GOLDEN_T0;

function baseCfg(extra = {}) {
  return {
    apiToken: TOKEN, trustProxy: true, trustedProxyIps: ['127.0.0.1'], allowedHosts: [], corsAllowedOrigins: [],
    gridPositiveMeans: 'grid_import', manufacturer: 'victron', mqtt: { topicPrefix: 'dvhub' }, ...extra,
  };
}

function fullState() {
  return {
    ctrl: { forcedOff: false, negativePriceActive: false, discretionaryWritesPaused: false, _stopBlockLogged: {} },
    meter: { ok: true, updatedAt: T0, grid_total_w: 120, grid_l1_w: 30, grid_l2_w: 40, grid_l3_w: 50 },
    victron: {
      gridSetpointW: -100, minSocPct: 20, maxDischargeW: -1, chargeCurrentA: 70, soc: 55, batteryPowerW: -300,
      pvTotalW: 900, pvPowerW: 600, updatedAt: T0, errors: {},
    },
    schedule: {
      rules: [
        { id: 'abend', source: 'forecast_optimizer', optimizer: 'eos' },
        { id: 'opt-1-0', source: 'forecast_optimizer', optimizer: 'internal' },
      ],
      active: {
        gridSetpointW: { value: -3000, source: 'rule:abend', at: T0 - 60_000 },
        chargeCurrentA: { value: 30, source: 'default', at: T0 - 120_000, skipped: true, reason: 'unchanged', heldSinceMs: 5000 },
        minSocPct: { value: 15, source: 'rule:opt-1-0', at: T0 - 30_000, keepalive: false },
        maxDischargeW: { value: -1, source: 'api_manual_write', at: T0 - 90_000 },
        feedExcessDcPv: { value: 1, source: 'runtime', at: T0 - 10_000 },
      },
      lastWrite: { gridSetpointW: { value: -3000, source: 'rule:abend', writeType: 'int32', at: T0 - 60_000 } },
      smallMarketAutomation: {},
    },
    p14a: { active: true, limitW: 7560, source: 'eebus', budgetW: 7000, belowPmin: false, shares: { speicher: 3780, wallbox: 3780, kaputt: 'x' } },
    eebus: { applied: { consumptionLimitW: 7560, productionLimitW: 4200, productionBlock: false } },
    optimizer: { source: 'eos', enabled: true, lastRunAt: T0 - 300_000, rulesCount: 2, error: null },
    costs: {},
    energy: { day: '2026-11-18', importWh: 1200, exportWh: 3400, costEur: 0.4, revenueEur: 0.9 },
    epex: { ok: true, data: [{ startTs: T0 - 900_000, endTs: T0 + 900_000, price: 12.3, ct_kwh: 12.3 }] },
    keepalive: { modbusLastQuery: null },
  };
}

function bootState() {
  const s = fullState();
  s.schedule = { rules: [], active: { gridSetpointW: null, chargeCurrentA: null, feedExcessDcPv: null }, lastWrite: {}, smallMarketAutomation: {} };
  s.victron = { errors: {} };
  delete s.p14a;
  delete s.eebus;
  delete s.optimizer;
  return s;
}

function readbackOnlyState() {
  const s = fullState();
  s.schedule.active = {};
  s.schedule.lastWrite = {};
  delete s.p14a;
  delete s.eebus;
  return s;
}

function blockedState() {
  const s = fullState();
  s.ctrl.forcedOff = true;
  s.schedule.active = {
    gridSetpointW: { value: 0, source: 'manual_override', at: T0 - 5000 },
    maxDischargeW: { value: 0, source: 'peak_shaving_restore', at: T0 - 4000 },
  };
  s.p14a = { active: true, limitW: 4200, source: 'relay', budgetW: null, belowPmin: true, shares: { waermepumpe: 4200 } };
  s.eebus = { applied: { consumptionLimitW: null, productionLimitW: null, productionBlock: true } };
  return s;
}

function sourcesState() {
  const s = fullState();
  s.schedule.rules = [{ id: 'sma-7', source: 'small_market_automation' }];
  s.schedule.active = {
    gridSetpointW: { value: 1500, source: 'rule:sma-7', at: T0 - 1000 },
    chargeCurrentA: { value: 50, source: 'manual_override_soc_floor', at: T0 - 2000 },
    minSocPct: { value: 25, source: 'rule:opt-9-9', at: T0 - 3000 },
  };
  s.p14a = { active: false, limitW: 4200, source: 'eebus', shares: { speicher: 4200 } };
  s.eebus = { applied: { productionLimitW: 4200, productionBlock: false } };
  return s;
}

function rig({ state, cfg = baseCfg(), sharedGate = false }) {
  const ctx = {
    state, getCfg: () => cfg, getRawCfg: () => cfg, pushLog: () => {},
    controlValue: () => (state.ctrl.forcedOff ? 0 : 1),
    epexNowNext: () => ({ current: { ct_kwh: 12.3 }, next: null }),
    needsSetup: () => false, getAppDir: () => process.cwd(), getAppVersion: () => ({ versionLabel: 'test' }),
  };
  if (sharedGate) {
    // Wie server.js: EIN Tor je Prozess, dieselbe Not-Halt-Marke wie die Bestandsprüfungen.
    ctx.gate = createLegacyGate({ isHalted: () => state.ctrl?.discretionaryWritesPaused === true });
  }
  const routes = createApiRoutes(ctx);
  const published = [];
  const hub = { publish(topic, payload, opts) { published.push([topic, payload, opts ?? null]); }, connected: true };
  const publisher = createMqttPublisher(hub, ctx);
  return { ctx, routes, publisher, published };
}

async function get(routes, pathname) {
  const req = {
    method: 'GET', url: pathname,
    headers: { host: 'dvhub.test', authorization: `Bearer ${TOKEN}` },
    socket: { remoteAddress: '127.0.0.1' }, on() { return req; }, destroy() {},
  };
  const res = {
    status: 0, headers: {}, body: '',
    writeHead(c, h) { this.status = c; if (h) Object.assign(this.headers, h); },
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(b) { this.body = b == null ? '' : String(b); },
  };
  await routes.handleRequest(req, res, new URL(pathname, 'http://dvhub.test'));
  return { status: res.status, body: res.body };
}

async function capture(r) {
  const loxone = await get(r.routes, '/api/integration/loxone');
  const homeAssistant = await get(r.routes, '/api/integration/home-assistant');
  const dataflow = await get(r.routes, '/api/integrations/dataflow');
  r.published.length = 0;
  r.publisher._publishOnce();
  const mqtt = r.published.map(([topic, payload, opts]) => [topic, topic.endsWith('/system/uptime_sec') ? '<uptime>' : payload, opts]);
  return { loxone, homeAssistant, dataflow, mqtt, topicCount: r.publisher.topicCount };
}

const SCENARIOS = {
  eos_rule_full: () => rig({ state: fullState() }),
  eos_rule_full_shared_gate: () => rig({ state: fullState(), sharedGate: true }),
  boot_empty: () => rig({ state: bootState() }),
  readback_only: () => rig({ state: readbackOnlyState() }),
  production_blocked_forced_off_relay: () => rig({ state: blockedState(), sharedGate: true }),
  config_valid_explicit: () => rig({ state: fullState(), cfg: baseCfg({ writeSafety: { ok: true } }) }),
  sources_market_override_floor: () => rig({ state: sourcesState() }),
  prefix_haus1: () => rig({ state: fullState(), cfg: baseCfg({ mqtt: { topicPrefix: 'haus1' } }) }),
};

for (const [name, make] of Object.entries(SCENARIOS)) {
  test(`R-T3 Parität Normalbetrieb: ${name}`, async (t) => {
    fixClock(t);
    golden.check(name, await capture(make()));
  });
}

test('R-T3 Parität nach dem Aufheben des Not-Halts (eigenes Tor je Route/Publisher)', async (t) => {
  fixClock(t);
  const r = rig({ state: fullState() });
  r.ctx.state.ctrl.discretionaryWritesPaused = true;
  await capture(r); // während der Sperre: neues Soll, hier verworfen
  r.ctx.state.ctrl.discretionaryWritesPaused = false;
  golden.check('recovery_after_not_halt', await capture(r));
});

test('R-T3 Parität nach dem Aufheben des Not-Halts (gemeinsames Tor, Sperrmarke gesetzt wie setEmergencyStop)', async (t) => {
  fixClock(t);
  const r = rig({ state: fullState(), sharedGate: true });
  r.ctx.state.ctrl.discretionaryWritesPaused = true;
  r.ctx.gate.fence();
  await capture(r);
  r.ctx.state.ctrl.discretionaryWritesPaused = false;
  golden.check('recovery_after_not_halt_shared_gate', await capture(r));
});

test('R-T3 Parität, wenn die Konfiguration wieder gültig ist', async (t) => {
  fixClock(t);
  const cfg = baseCfg({ writeSafety: { ok: false, reason: 'manufacturer_profile_error', manufacturer: 'victron' } });
  const r = rig({ state: fullState(), cfg, sharedGate: true });
  await capture(r);
  cfg.writeSafety = { ok: true };
  golden.check('recovery_after_config_unsafe', await capture(r));
});
