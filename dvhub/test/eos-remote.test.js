// test/eos-remote.test.js — EOS im Fernbetrieb (optimizer.eosProxy.mode = 'remote').
//
// DVhub startet eine lokale EOS-Fassade; alle EOS-Module schreiben wie gewohnt
// an „EOS“. Die Fassade sammelt Konfiguration, Prognosen und Messwerte und
// schickt bei POST /v1/optimize EINEN Auftrag an den Rechendienst. Plan und
// Lösung liefert sie danach wie ein lokales EOS aus.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import {
  createEosRemoteFacade, REMOTE_FORWARD_PATHS, eosRemoteActive,
} from '../services/optimizer/eos-remote.js';
import { resolveEosProxy, setEosRemoteFacadeUrl } from '../services/optimizer/eos-adapter.js';
import { detectEosCapabilities } from '../services/optimizer/eos-capabilities.js';
import { dvhubTriggersEosRuns } from '../services/optimizer/eos-run-trigger.js';
import { eosRestartability } from '../services/optimizer/eos-restarter.js';

const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
  setEosRemoteFacadeUrl(null);
});

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
      resolve(`http://127.0.0.1:${srv.address().port}`);
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
      resolve(buf.length ? JSON.parse(buf.toString()) : undefined);
    });
  });
}

const RESULT = {
  optimize: { start_solution: [1, 2, 3], start_solution_datetime: '2026-10-28T11:00:00+01:00' },
  plan: { id: 'p1', generated_at: '2026-10-28T11:00:05+01:00', valid_until: null, instructions: [{ type: 'FRBCInstruction', execution_time: '2026-10-28T11:00:00+01:00', actuator_id: 'battery1', operation_mode_id: 'SELF_CONSUMPTION', operation_mode_factor: 1 }] },
  solution: { generated_at: '2026-10-28T11:00:05+01:00', solution: { data: { '2026-10-28T10:00:00Z': { battery1_soc_factor: 0.5 } } }, prediction: { data: {} } },
  diagnostics: { eosVersion: 'v0.4.0rc3', runMs: 41234, workers: 4, costs: { netAmt: 0.73 }, warnings: ['Tail forecast shortened: requested 48 h, effective # h'] },
  runMs: 41234,
};

/** Fake-Rechendienst: Einschreiben, Auftrag, Long-Poll. */
async function fakeService({ jobStatus = 'done', submitStatus = 202, tokenOk = (t) => t === 'dves_neu' } = {}) {
  const calls = { enroll: [], submit: [], poll: 0 };
  const url = await listen(async (req, res) => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const body = await readBody(req);
    if (req.method === 'POST' && req.url === '/v1/enroll') {
      calls.enroll.push(body);
      return send(200, { boxId: 'box_1', token: 'dves_neu' });
    }
    const auth = String(req.headers.authorization || '').replace('Bearer ', '');
    if (!tokenOk(auth)) return send(401, { error: { code: 'unauthorized' } });
    if (req.method === 'POST' && req.url === '/v1/jobs') {
      calls.submit.push({ body, encoding: req.headers['content-encoding'] || null });
      if (submitStatus !== 202) return send(submitStatus, { error: { code: 'quota_exceeded', message: 'zu viele' } });
      return send(202, { id: 'job_abc', status: 'queued' });
    }
    if (req.method === 'GET' && req.url === '/v1/jobs/job_abc/debug') {
      return send(200, { id: 'job_abc', bundle: { eosLog: 'LOG', eosConfig: { a: 1 } } });
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/jobs/job_abc')) {
      calls.poll += 1;
      if (jobStatus === 'done') return send(200, { id: 'job_abc', status: 'done', result: RESULT });
      return send(200, { id: 'job_abc', status: jobStatus, error: { code: 'no_solution', message: 'keine Lösung' } });
    }
    return send(404, {});
  });
  return { url, calls };
}

function makeCfg(endpoint, extra = {}) {
  return {
    timeZone: 'Europe/Berlin',
    optimizer: {
      eosProxy: { enabled: true, mode: 'remote', url: 'http://127.0.0.1:8503', remote: { endpoint, token: '', jobTimeoutMs: 20_000, ...extra } },
    },
  };
}

async function startFacade(cfg, over = {}) {
  const state = { optimizer: {} };
  const saved = [];
  const facade = createEosRemoteFacade({
    getCfg: () => cfg,
    getLicenceProof: () => ({ licenseKey: 'key/abc.sig', machineFile: '-----BEGIN MACHINE FILE-----\nx\n-----END MACHINE FILE-----' }),
    saveToken: async (t) => { saved.push(t); cfg.optimizer.eosProxy.remote.token = t; },
    state,
    pushLog: () => {},
    eosVersion: 'v0.4.0rc3',
    ...over,
  });
  const url = await facade.start();
  closers.push(() => facade.stop());
  return { facade, url, state, saved };
}

async function req(base, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

// ---------------------------------------------------------------------------

describe('Fernbetrieb: Auflösung und Schalter', () => {
  it('local bleibt wie bisher; remote zeigt auf die Fassade, sobald sie läuft', () => {
    const local = resolveEosProxy({ optimizer: { eosProxy: { enabled: true, url: 'http://10.0.0.5:8503' } } });
    assert.equal(local.url, 'http://10.0.0.5:8503');
    assert.equal(local.mode, 'local');
    const cfg = makeCfg('https://eos.example.invalid');
    const before = resolveEosProxy(cfg);
    assert.equal(before.mode, 'remote');
    assert.notEqual(before.url, 'http://127.0.0.1:8503', 'nie das lokale EOS ansprechen');
    setEosRemoteFacadeUrl('http://127.0.0.1:45678');
    assert.equal(resolveEosProxy(cfg).url, 'http://127.0.0.1:45678');
    assert.equal(eosRemoteActive(cfg), true);
    assert.equal(eosRemoteActive({ optimizer: { eosProxy: { enabled: false, mode: 'remote' } } }), false);
  });

  it('im Fernbetrieb stößt DVhub jeden Lauf an (eosStartAfterPreviousRun gilt nicht)', () => {
    const cfg = makeCfg('https://x.invalid');
    cfg.optimizer.eosStartAfterPreviousRun = true;
    assert.equal(dvhubTriggersEosRuns(cfg), true);
  });

  it('kein Neustart-Knopf für den Rechendienst', () => {
    setEosRemoteFacadeUrl('http://127.0.0.1:45678');
    assert.deepEqual(eosRestartability(makeCfg('https://x.invalid')), { ok: false, reason: 'remote' });
  });
});

describe('Fernbetrieb: EOS-Fassade', () => {
  it('Konfiguration: GET /v1/config wird als EOS 0.4 erkannt, mit den Fähigkeiten von v0.4.0rc3', async () => {
    const { url } = await startFacade(makeCfg('https://x.invalid'));
    await req(url, 'PUT', '/v1/config/devices/max_inverters', 1);
    await req(url, 'PUT', '/v1/config/devices/inverters', { inverter1: { device_id: 'inverter1', max_power_w: 10000 } });
    const cfg = (await req(url, 'GET', '/v1/config')).json;
    const health = (await req(url, 'GET', '/v1/health')).json;
    const caps = detectEosCapabilities(cfg, health);
    assert.equal(caps.supported, true);
    assert.equal(caps.inverterEfficiencyCurve, true);
    assert.equal(caps.timezoneOverride, true);
    assert.equal(caps.selfConsumptionInterpolator, true);
    // Fertig-Meldung und Fitness-Cache gehören dem Dienst, nicht der Box.
    assert.equal(caps.solutionNotify, false);
    assert.equal(caps.fitnessCacheLimit, false);
    assert.equal(cfg.devices.inverters.inverter1.max_power_w, 10000);
    assert.equal(health.status, 'alive');
  });

  it('Messwert-Schlüssel folgen den angemeldeten Geräten', async () => {
    const { url } = await startFacade(makeCfg('https://x.invalid'));
    await req(url, 'PUT', '/v1/config/devices/batteries', { battery1: { device_id: 'battery1' } });
    await req(url, 'PUT', '/v1/config/devices/home_appliances', { appl_dw: { device_id: 'appl_dw' } });
    const keys = (await req(url, 'GET', '/v1/measurement/keys')).json;
    assert.ok(keys.includes('battery1-soc-factor'));
    assert.ok(keys.includes('appl_dw.cycles_completed'));
    assert.ok(!keys.some((k) => k.startsWith('ev11')));
  });

  it('POST /v1/optimize: schreibt sich ein, schickt EINEN Auftrag mit genau dem, was EOS bekäme', async () => {
    const svc = await fakeService();
    const cfg = makeCfg(svc.url);
    const { url, saved, state } = await startFacade(cfg);
    const now = Date.now();
    const slot = (i) => new Date(Math.floor(now / 900_000) * 900_000 + i * 900_000).toISOString().replace('.000Z', 'Z');
    // wie eos-config-sync
    for (const [p, v] of [
      ['devices/max_batteries', 1], ['devices/batteries', { battery1: { device_id: 'battery1', capacity_wh: 10000 } }],
      ['devices/max_home_appliances', 1], ['devices/home_appliances', { appl_dw: { device_id: 'appl_dw', consumption_wh: 1000, duration_h: 2 } }],
      ['ems/interval', 900], ['ems/mode', 'DISABLED'], ['measurement/historic_hours', 48],
      ['database/autosave_interval_sec', null], ['ems/notify_url', 'http://127.0.0.1:8080/api/eos/solution-ready'],
      ['optimization/genetic/horizon_hours', 12], ['pvforecast/provider', 'PVForecastImport'],
    ]) assert.equal((await req(url, 'PUT', `/v1/config/${p}`, v)).status, 200);
    // wie eos-forecast-bridge: zwei Pushes, der zweite überschreibt nur seine Zeitpunkte
    const df = (vals) => ({ data: Object.fromEntries(vals.map(([i, v]) => [slot(i), { pvforecast_ac_power: v }])), dtypes: { pvforecast_ac_power: 'float64' }, tz: 'Europe/Berlin', datetime_columns: [] });
    await req(url, 'PUT', '/v1/prediction/import/PVForecastImport?force_enable=true', df([[0, 100], [1, 200]]));
    await req(url, 'PUT', '/v1/prediction/import/PVForecastImport?force_enable=true', df([[1, 250], [2, 300]]));
    await req(url, 'PUT', `/v1/measurement/value?datetime=${encodeURIComponent(new Date().toISOString())}&key=appl_dw.cycles_completed&value=1`);

    const r = await req(url, 'POST', '/v1/optimize', { soc: { battery1: 57 }, start_solution: [0, 1], start_solution_datetime: slot(0) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, RESULT.optimize);

    assert.equal(svc.calls.enroll.length, 1);
    assert.equal(svc.calls.enroll[0].licenseKey, 'key/abc.sig');
    assert.deepEqual(saved, ['dves_neu']);
    assert.equal(svc.calls.submit.length, 1);
    const job = svc.calls.submit[0].body;
    assert.equal(svc.calls.submit[0].encoding, 'gzip');
    assert.equal(job.eosVersion, 'v0.4.0rc3');
    assert.deepEqual(job.licence, { key: 'key/abc.sig', machineFile: '-----BEGIN MACHINE FILE-----\nx\n-----END MACHINE FILE-----' });
    assert.deepEqual(Object.keys(job.config).sort(), [
      'devices/batteries', 'devices/home_appliances', 'devices/max_batteries', 'devices/max_home_appliances',
      'optimization/genetic/horizon_hours', 'pvforecast/provider',
    ]);
    for (const k of Object.keys(job.config)) assert.ok(REMOTE_FORWARD_PATHS.includes(k));
    assert.deepEqual(Object.values(job.predictions.PVForecastImport.data).map((x) => x.pvforecast_ac_power), [100, 250, 300]);
    assert.deepEqual(job.measurements.map((m) => [m.key, m.value]), [['appl_dw.cycles_completed', 1]]);
    assert.deepEqual(job.optimize, { soc: { battery1: 57 }, start_solution: [0, 1], start_solution_datetime: slot(0) });
    assert.ok(Date.parse(job.deadline) > Date.now());

    // danach wie ein lokales EOS
    assert.deepEqual((await req(url, 'GET', '/v1/energy-management/plan')).json, RESULT.plan);
    assert.deepEqual((await req(url, 'GET', '/v1/energy-management/optimization/solution')).json, RESULT.solution);
    assert.equal(state.optimizer.eosRemote.lastError, null);
    assert.ok(state.optimizer.eosRemote.lastOkAt);
    // Diagnose des Laufs (Ersatz für EOSdash) liegt für die Oberfläche bereit.
    assert.deepEqual(state.optimizer.eosRemote.diagnostics, RESULT.diagnostics);
    assert.equal(state.optimizer.eosRemote.lastRunMs, 41234);
    assert.equal(job.debug, undefined, 'Diagnosepaket nur auf Wunsch');
  });

  it('Diagnosepaket nur mit remote.debugBundle; abrufbar für den Support', async () => {
    const svc = await fakeService();
    const cfg = makeCfg(svc.url, { token: 'dves_neu', debugBundle: true });
    const { url, facade, state } = await startFacade(cfg);
    assert.equal(await facade.fetchDebugBundle(), null, 'vor dem ersten Lauf nichts');
    assert.equal((await req(url, 'POST', '/v1/optimize', {})).status, 200);
    assert.equal(svc.calls.submit[0].body.debug, true);
    assert.equal(state.optimizer.eosRemote.lastJobId, 'job_abc');
    const b = await facade.fetchDebugBundle();
    assert.deepEqual(b, { jobId: 'job_abc', bundle: { eosLog: 'LOG', eosConfig: { a: 1 } } });
  });

  it('abgelehntes Token → einmal neu einschreiben und erneut senden', async () => {
    const svc = await fakeService();
    const cfg = makeCfg(svc.url, { token: 'dves_alt' });
    const { url } = await startFacade(cfg);
    await req(url, 'PUT', '/v1/config/devices/batteries', { battery1: { device_id: 'battery1' } });
    const r = await req(url, 'POST', '/v1/optimize', { soc: { battery1: 50 } });
    assert.equal(r.status, 200);
    assert.equal(svc.calls.enroll.length, 1);
    assert.equal(svc.calls.submit.length, 1);
  });

  it('Dienst nicht erreichbar: Lauf scheitert, letzter Plan bleibt, Zustand sagt es', async () => {
    const svc = await fakeService();
    const cfg = makeCfg(svc.url, { token: 'dves_neu' });
    const { url, state } = await startFacade(cfg);
    await req(url, 'PUT', '/v1/config/devices/batteries', { battery1: { device_id: 'battery1' } });
    assert.equal((await req(url, 'POST', '/v1/optimize', { soc: { battery1: 50 } })).status, 200);
    cfg.optimizer.eosProxy.remote.endpoint = 'http://127.0.0.1:9';
    const r = await req(url, 'POST', '/v1/optimize', { soc: { battery1: 51 } });
    assert.equal(r.status, 503);
    assert.deepEqual((await req(url, 'GET', '/v1/energy-management/plan')).json, RESULT.plan);
    const st = state.optimizer.eosRemote;
    assert.equal(st.lastError.code, 'service_unreachable');
    assert.equal(st.usingLastPlan, true);
  });

  it('Auftrag endgültig gescheitert (keine Lösung) → 503 mit Code, kein lokaler Rückfall nötig', async () => {
    const svc = await fakeService({ jobStatus: 'failed' });
    const { url, state } = await startFacade(makeCfg(svc.url, { token: 'dves_neu' }));
    const r = await req(url, 'POST', '/v1/optimize', {});
    assert.equal(r.status, 503);
    assert.equal(state.optimizer.eosRemote.lastError.code, 'no_solution');
  });

  it('Kontingent erschöpft → 503, Code quota_exceeded', async () => {
    const svc = await fakeService({ submitStatus: 429 });
    const { url, state } = await startFacade(makeCfg(svc.url, { token: 'dves_neu' }));
    assert.equal((await req(url, 'POST', '/v1/optimize', {})).status, 503);
    assert.equal(state.optimizer.eosRemote.lastError.code, 'quota_exceeded');
  });

  it('ohne aktiven Lizenznachweis kein Auftrag', async () => {
    const svc = await fakeService();
    const { url, state } = await startFacade(makeCfg(svc.url), { getLicenceProof: () => null });
    assert.equal((await req(url, 'POST', '/v1/optimize', {})).status, 503);
    assert.equal(state.optimizer.eosRemote.lastError.code, 'licence_missing');
    assert.equal(svc.calls.enroll.length + svc.calls.submit.length, 0);
  });

  it('lokaler Rückfall: Dienst weg → Auftrag an das lokale EOS (optimizer.eosProxy.url)', async () => {
    const localPuts = [];
    let optimized = null;
    const local = await listen(async (rq, rs) => {
      const body = await readBody(rq);
      const send = (s, o) => { rs.writeHead(s, { 'Content-Type': 'application/json' }); rs.end(o === undefined ? '' : JSON.stringify(o)); };
      if (rq.method === 'PUT') { localPuts.push(rq.url.split('?')[0]); return send(200, {}); }
      if (rq.method === 'POST' && rq.url === '/v1/optimize') { optimized = body; return send(200, { start_solution: [9] }); }
      if (rq.url === '/v1/energy-management/plan') return send(200, { id: 'local-plan', instructions: [] });
      if (rq.url === '/v1/energy-management/optimization/solution') return send(200, { solution: { data: {} }, local: true });
      return send(404, {});
    });
    const cfg = makeCfg('http://127.0.0.1:9', { token: 'dves_x', localFallback: true });
    cfg.optimizer.eosProxy.url = local;
    const { url, state } = await startFacade(cfg);
    await req(url, 'PUT', '/v1/config/devices/batteries', { battery1: { device_id: 'battery1' } });
    await req(url, 'PUT', '/v1/config/ems/mode', 'DISABLED');
    const r = await req(url, 'POST', '/v1/optimize', { soc: { battery1: 40 } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { start_solution: [9] });
    assert.deepEqual(optimized, { soc: { battery1: 40 } });
    // Das lokale EOS bekommt ALLES, was DVhub ihm sonst schicken würde.
    assert.ok(localPuts.includes('/v1/config/devices/batteries'));
    assert.ok(localPuts.includes('/v1/config/ems/mode'));
    assert.equal((await req(url, 'GET', '/v1/energy-management/plan')).json.id, 'local-plan');
    assert.equal(state.optimizer.eosRemote.fallback, 'local');
  });
});

describe('Fernbetrieb: DVhubs EOS-Module sprechen unverändert mit der Fassade', () => {
  it('Abgleich, Prognose-Push, Ladestand und Lauf landen über die Fassade im Auftrag; Plan kommt zurück', async () => {
    const { createEosConfigSync } = await import('../services/optimizer/eos-config-sync.js');
    const { createEosForecastBridge } = await import('../services/optimizer/eos-forecast-bridge.js');
    const { createEosAdapter } = await import('../services/optimizer/eos-adapter.js');
    const svc = await fakeService();
    const cfg = makeCfg(svc.url, { token: 'dves_neu' });
    cfg.optimizer.batteryCapacityWh = 12000;
    cfg.optimizer.eosOptimizationIntervalSec = 900;
    const { url, state } = await startFacade(cfg);
    setEosRemoteFacadeUrl(url);
    state.victron = { soc: 63 };
    const ctx = { getCfg: () => cfg, pushLog: () => {}, state };

    const sync = await createEosConfigSync(ctx).sync();
    assert.equal(sync.ok, true, JSON.stringify(sync.errors));
    assert.equal(state.optimizer.eos.supported, true);

    const t0 = Math.floor(Date.now() / 900_000) * 900_000;
    const slots = (n, f) => Array.from({ length: n }, (_, i) => ({ start: new Date(t0 + i * 900_000).toISOString(), ...f(i) }));
    const forecastService = {
      buildForecastResponse: async () => ({
        pv: { slots: slots(48, (i) => ({ powerW: 1000 + i })) },
        load: { slots: Array.from({ length: 12 }, (_, i) => ({ start: new Date(t0 + i * 3600_000).toISOString(), powerW: 500 })) },
        price: { slots: slots(48, () => ({ ctKwh: 20 })) },
      }),
    };
    const bridge = createEosForecastBridge({ ...ctx, forecastService });
    const push = await bridge.push();
    assert.equal(push.errors.PVForecastImport, undefined);
    const soc = await bridge.socForRun();
    assert.deepEqual(soc, { soc: { battery1: 63 } });

    const adapter = createEosAdapter(ctx);
    const run = await adapter.triggerOptimization({ soc: soc.soc }, 30_000);
    assert.equal(run.ok, true, run.error);
    const job = svc.calls.submit[0].body;
    assert.equal(job.config['devices/batteries'].battery1.capacity_wh, 12000);
    assert.equal(job.config['optimization/genetic/interval_sec'], 900);
    assert.ok(job.config['optimization/genetic/horizon_hours'] >= 1);
    assert.equal(job.config['ems/mode'], undefined);
    assert.equal(Object.keys(job.predictions.PVForecastImport.data).length, 48);
    assert.ok(job.predictions.LoadImport && job.predictions.ElecPriceImport && job.predictions.FeedInTariffImport);
    assert.deepEqual(job.optimize, { soc: { battery1: 63 } });

    const sol = await adapter.getOptimizationSolution(10);
    assert.ok(sol && Array.isArray(sol.rows));
    const sched = await adapter.pullSchedule({ solution: sol });
    assert.ok(Array.isArray(sched) && sched.length > 0);
  });
});
