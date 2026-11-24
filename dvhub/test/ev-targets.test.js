// test/ev-targets.test.js -- Was DVhub EOS je Lauf als Ziel fürs Auto schickt:
// vorausschauendes Mindestziel, Max-Ladestand „wenn günstig“, Wertstufen — und
// der Rückfall auf Vanilla-EOS (Feld unbekannt → nur Mindestziel, max 100 %).
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { detectEosCapabilities, EOS_EV_SOC_VALUE_FIELD } from '../services/optimizer/eos-capabilities.js';
import { createEosConfigSync, buildEosElectricVehicles } from '../services/optimizer/eos-config-sync.js';
import { resolveEvTargets, buildEvValueInputs, evMaxStopSocPct, _test } from '../services/optimizer/ev-targets.js';

const TZ = 'Europe/Berlin';
const HOUR = 3600_000;
const SLOT = 15 * 60_000;

// Mo 16.11.2026 20:00 Ortszeit. Plan: Di + Mi 07:00–18:00 je 30 %, Min 50;
// Sa zweimal kurz hintereinander (09:00–12:00 40 %, 13:00–18:00 35 %).
const NOW = Date.parse('2026-11-16T19:00:00Z');
const PLAN = [
  { day: 1, arrival: '18:00', departure: '07:00', minSocPct: 50, tripSocPct: 30 },
  { day: 2, arrival: '18:00', departure: '07:00', minSocPct: 50, tripSocPct: 30 },
  { day: 5, arrival: '18:00', departure: '09:00', minSocPct: 45, tripSocPct: 40 },
  { day: 6, arrival: '12:00', departure: '13:00', minSocPct: 40, tripSocPct: 35 },
];

function cfgWith(opt = {}) {
  return {
    schedule: { timezone: TZ },
    optimizer: {
      eosOptimizeEv: true, evCapacityWh: 75000, evMaxChargeW: 11000, evDepartureEnabled: true,
      evTargetMode: 'percent', evTargetValue: 80, evWeeklyPlan: PLAN, evMaxSocPct: 80, evValueMarginCt: 1,
      ...opt,
    },
  };
}

/** Preise/PV für 10 Tage: Nacht billig (20 ct), Tag teuer (35 ct), keine PV. */
function inputs(nowMs = NOW, days = 10) {
  const priceSlots = [];
  const base = Math.floor(nowMs / SLOT) * SLOT;
  for (let i = 0; i < days * 96; i += 1) {
    const ms = base + i * SLOT;
    const h = new Date(ms).getUTCHours();
    priceSlots.push({ start: new Date(ms).toISOString(), end: new Date(ms + SLOT).toISOString(), ctKwh: h >= 22 || h < 4 ? 2 : 14 });
  }
  return buildEvValueInputs({
    priceSlots, importCtOf: (s) => 1.2252 * s.ctKwh + 15.98, feedInCtOf: (s) => s.ctKwh + 3.052,
    pvSlots: [], loadSlots: [], nowMs, timeZone: TZ,
  });
}
const ctxWith = (extra = {}) => ({ state: { optimizer: { eosControlHorizonH: 36, evValueInputs: inputs(), ...extra } } });

describe('Fähigkeit „Wertstufen“ erkennen', () => {
  it(`Feldname an EINER Stelle: ${EOS_EV_SOC_VALUE_FIELD}`, () => {
    assert.equal(EOS_EV_SOC_VALUE_FIELD, 'soc_value_steps');
  });
  it('Feld (auch null) an battery1 → evSocValue; Vanilla v0.4.0rc3 ohne → false', () => {
    const cfg = (withField) => ({
      optimization: { genetic: { interval_sec: 900 } },
      devices: { batteries: { battery1: { device_id: 'battery1', charge_start_datetime: null, ...(withField ? { soc_value_steps: null } : {}) } }, inverters: {}, electric_vehicles: {} },
    });
    assert.equal(detectEosCapabilities(cfg(true)).evSocValue, true);
    assert.equal(detectEosCapabilities(cfg(false)).evSocValue, false);
  });
});

describe('resolveEvTargets', () => {
  afterEach(() => _test.resetMemo());

  it('Vanilla-EOS (Feld unbekannt): nur Mindestziel, max 100 %, keine Wertstufen', () => {
    const t = resolveEvTargets(ctxWith(), cfgWith(), { decision: { mode: 'plugged', socPct: 46.7 }, valueSupported: false, nowMs: NOW });
    assert.equal(t.minSocPct, 50);
    assert.equal(t.maxSocPct, 100);
    assert.equal(t.steps, null);
    assert.equal(t.maxActive, false);
    assert.equal(t.initialSocPct, 46);
    assert.equal(t.deadlineAt, '2026-11-17T06:00:00.000Z');
  });

  it('mit Feld: Max 80 %, Wertstufen über dem Mindestziel, nicht steigend', () => {
    const t = resolveEvTargets(ctxWith(), cfgWith(), { decision: { mode: 'plugged', socPct: 46.7 }, valueSupported: true, nowMs: NOW });
    assert.equal(t.maxSocPct, 80);
    assert.equal(t.maxActive, true);
    assert.ok(t.steps.length > 0, t.reason);
    assert.ok(t.steps[0][0] > 50 && t.steps.at(-1)[0] <= 80);
    for (let i = 1; i < t.steps.length; i += 1) assert.ok(t.steps[i][1] <= t.steps[i - 1][1]);
    assert.equal(evMaxStopSocPct({ optimizer: { evTargets: t } }), 80);
  });

  it('Max-Ladestand aus: wie Vanilla, keine Wallbox-Grenze', () => {
    const t = resolveEvTargets(ctxWith(), cfgWith({ evMaxSocPct: null }), { decision: { mode: 'plugged', socPct: 46 }, valueSupported: true, nowMs: NOW });
    assert.equal(t.maxSocPct, 100);
    assert.equal(t.steps, null);
    assert.equal(evMaxStopSocPct({ optimizer: { evTargets: t } }), null);
  });

  it('ohne Preise/PV: Max gilt, aber keine Wertstufen (Grund steht im Status)', () => {
    const t = resolveEvTargets({ state: { optimizer: { eosControlHorizonH: 36 } } }, cfgWith(), { decision: { mode: 'plugged', socPct: 46 }, valueSupported: true, nowMs: NOW });
    assert.equal(t.maxSocPct, 80);
    assert.deepEqual(t.steps, []);
    assert.match(t.reason, /Preise/);
  });

  it('Preise nur bis übermorgen (keine Historie für die Schätzung): Vorausschau so weit sie reichen', () => {
    const ctx = { state: { optimizer: { eosControlHorizonH: 36, evValueInputs: inputs(NOW, 2) } } };
    const t = resolveEvTargets(ctx, cfgWith(), { decision: { mode: 'plugged', socPct: 46 }, valueSupported: true, nowMs: NOW });
    assert.equal(t.maxSocPct, 80);
    assert.ok(Array.isArray(t.steps) && t.steps.length > 0, t.reason);
    assert.ok(t.valueWindowDays > 0.9 && t.valueWindowDays < 7, String(t.valueWindowDays));
    // weniger als 24 h über E hinaus: keine Wertstufen
    const short = resolveEvTargets({ state: { optimizer: { eosControlHorizonH: 36, evValueInputs: inputs(NOW, 1) } } }, cfgWith(), { decision: { mode: 'plugged', socPct: 46 }, valueSupported: true, nowMs: NOW });
    assert.deepEqual(short.steps, []);
    assert.match(short.reason, /Preise reichen/);
  });

  it('vorausschauend: zwei Fahrten am Samstag kurz hintereinander heben das Ziel am Morgen', () => {
    // Fr 20.11. 22:00 Ortszeit: nächste Abfahrt Sa 09:00 (Min 45), dann 13:00 (Min 40) nach 1 h Pause
    const fri = Date.parse('2026-11-20T21:00:00Z');
    const t = resolveEvTargets({ state: { optimizer: { eosControlHorizonH: 30, evValueInputs: inputs(fri) } } }, cfgWith(), { decision: { mode: 'plugged', socPct: 35 }, valueSupported: false, nowMs: fri });
    assert.equal(t.minWeekPct, 45);
    // Sa 09:00 braucht 40 % (Ziel 13:00) + 40 % Fahrt − 1 h × 11 kW × 0,88 / 75 kWh (12,9 %) = 67,1 → 68
    // (wie die Lage „kurzwende“ der Simulation)
    assert.equal(t.minSocPct, 68);
    assert.equal(t.maxSocPct, 100, 'ohne Feld bleibt max 100 — das Mindestziel steigt trotzdem');
  });

  it('Einmal-Ziel über dem Max: Max steigt mit', () => {
    const c = cfgWith({ evDepartureOnce: '2026-11-17T07:00:00.000Z', evDepartureOnceMinSocPct: 90 });
    const t = resolveEvTargets(ctxWith(), c, { decision: { mode: 'plugged', socPct: 40 }, valueSupported: true, nowMs: NOW });
    assert.equal(t.minSocPct, 90);
    assert.equal(t.maxSocPct, 90);
    assert.deepEqual(t.steps, []);
  });

  // 1.0.11 (Christin 12.11.2026): Die Wertgrundlage endet mit der
  // Preisprognose (~5 Tage) bzw. ohne sie mit den festen Börsenpreisen. Das
  // Fenster darf nie über das Preisende reichen; unter einem Tag über E gibt es
  // keine Wertstufen — an jedem Wochentag, mit jedem Steuerzeitraum.
  for (const [label, days] of [['nur feste Preise (30 h)', 1.25], ['feste + Preisprognose (5 Tage)', 5], ['lang (10 Tage)', 10]]) {
    for (const ctrlH of [6, 36, 120]) {
      it(`Fenster endet mit den Preisen — ${label}, Steuerzeitraum ${ctrlH} h, jeder Wochentag`, () => {
        for (let k = 0; k < 7; k += 1) {
          _test.resetMemo();
          const now = NOW + k * 24 * HOUR;
          const inp = inputs(now, days);
          const coverEnd = inp.baseMs + inp.importCt.length * SLOT;
          const t = resolveEvTargets({ state: { optimizer: { eosControlHorizonH: ctrlH, evValueInputs: inp } } }, cfgWith(),
            { decision: { mode: 'plugged', socPct: 46 }, valueSupported: true, nowMs: now });
          const eMs = Date.parse(t.valueAt);
          const why = `Tag ${k}: E ${t.valueAt}, Preise bis ${new Date(coverEnd).toISOString()}, ${t.reason}`;
          assert.equal(t.maxSocPct, 80, why);
          if (coverEnd - eMs < 24 * HOUR) {
            assert.deepEqual(t.steps, [], why);
            assert.match(t.reason, /Preise reichen nicht/, why);
            assert.equal(t.valueWindowDays, null, why);
          } else {
            assert.ok(t.valueWindowDays >= 1 && t.valueWindowDays <= 7.05, why);
            // valueWindowDays ist auf 0,01 Tage (14,4 min) gerundet.
            assert.ok(eMs + t.valueWindowDays * 24 * HOUR <= coverEnd + 8 * 60_000, `Fenster über das Preisende hinaus — ${why}`);
          }
        }
      });
    }
  }

  it('Wochenplan aus: wie bisher (allgemeiner Ziel-Ladestand, max 100)', () => {
    const t = resolveEvTargets(ctxWith(), cfgWith({ evDepartureEnabled: false, evMinSocPct: 60 }), { valueSupported: true, nowMs: NOW });
    assert.equal(t.minSocPct, 60);
    assert.equal(t.maxSocPct, 100);
    assert.equal(t.steps, null);
  });
});

describe('buildEosElectricVehicles mit Zielen', () => {
  it('Feld bekannt: min/max/Wertstufen gehen an EOS; ohne Stufen ausdrücklich null', () => {
    const targets = { minSocPct: 50, maxSocPct: 80, steps: [[55, 0.24], [80, 0.2]] };
    const [ev] = buildEosElectricVehicles(cfgWith(), { supportsDeadline: true, supportsSocValue: true, targets, nowMs: NOW });
    assert.equal(ev.min_soc_percentage, 50);
    assert.equal(ev.max_soc_percentage, 80);
    assert.deepEqual(ev[EOS_EV_SOC_VALUE_FIELD], [[55, 0.24], [80, 0.2]]);
    const [none] = buildEosElectricVehicles(cfgWith(), { supportsDeadline: true, supportsSocValue: true, targets: { ...targets, steps: [] }, nowMs: NOW });
    assert.equal(none[EOS_EV_SOC_VALUE_FIELD], null);
  });
  it('Feld unbekannt (Vanilla): kein Feld im Gerät, max 100', () => {
    const [ev] = buildEosElectricVehicles(cfgWith(), { supportsDeadline: true, supportsSocValue: false, targets: { minSocPct: 50, maxSocPct: 100, steps: null }, nowMs: NOW });
    assert.ok(!(EOS_EV_SOC_VALUE_FIELD in ev));
    assert.equal(ev.max_soc_percentage, 100);
  });
});

// ── Abgleich gegen ein Mock-EOS ────────────────────────────────────────────
function mockEos(withField) {
  const puts = [];
  const eosCfg = {
    optimization: { algorithm: 'GENETIC', genetic: { interval_sec: 900 } },
    feedintariff: { direct_marketing_enabled: true },
    devices: {
      batteries: { battery1: { device_id: 'battery1', min_soc_deadline_datetime: null, charge_start_datetime: null, ...(withField ? { [EOS_EV_SOC_VALUE_FIELD]: null } : {}) } },
      inverters: { inverter1: { device_id: 'inverter1' } }, electric_vehicles: {}, home_appliances: {},
    },
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.method === 'GET' && req.url === '/v1/config') return res.end(JSON.stringify(eosCfg));
        if (req.method === 'GET' && req.url === '/v1/health') return res.end(JSON.stringify({ status: 'alive', version: '0.4.0-test' }));
        if (req.method === 'PUT') puts.push({ section: req.url.replace('/v1/config/', ''), body });
        return res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, puts, close: () => new Promise((r) => server.close(r)) }));
  });
}

describe('Abgleich: Ziele landen beim Auto in EOS und im Status', () => {
  let m;
  afterEach(async () => { if (m) await m.close(); m = null; _test.resetMemo(); });
  const ctxFor = (port) => {
    const cfg = cfgWith({ eosProxy: { enabled: true, url: `http://127.0.0.1:${port}` }, batteryCapacityWh: 43000, maxChargeW: 18000, eosOptimizationIntervalSec: 900, tariff: { feedInMode: 'spot' }, evPlanOnlyWhenPlugged: true });
    // Wochenplan relativ zu jetzt: jeden Tag Abfahrt in 10 h (sonst hinge der Test am Wochentag).
    const hhmm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
    cfg.optimizer.evWeeklyPlan = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, arrival: '', departure: hhmm(Date.now() + 10 * HOUR), minSocPct: 40, tripSocPct: 20 }));
    return {
      state: { victron: { minSocPct: 5, soc: 50 }, optimizer: { eosControlHorizonH: 24, evValueInputs: inputs(Date.now()) } },
      pushLog: () => {}, getCfg: () => cfg,
      evccIntegration: { getLoadpoints: () => [{ id: 1, connected: true, vehicleSocPct: 35.6 }], getStatus: () => ({ lastPolledAt: Date.now() }) },
    };
  };

  it('EOS mit Feld: soc_value_steps + max 80 im PUT, Status state.optimizer.evTargets', async () => {
    m = await mockEos(true);
    const ctx = ctxFor(m.port);
    const res = await createEosConfigSync(ctx).sync();
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    const ev = (m.puts.filter((p) => p.section === 'devices/electric_vehicles').at(-1) || {}).body?.ev11;
    assert.ok(ev, 'Auto angemeldet');
    assert.equal(ev.max_soc_percentage, 80);
    assert.ok(Array.isArray(ev[EOS_EV_SOC_VALUE_FIELD]) && ev[EOS_EV_SOC_VALUE_FIELD].length > 0, JSON.stringify(ctx.state.optimizer.evTargets));
    assert.equal(ctx.state.optimizer.eos.evSocValue, true);
    assert.equal(ctx.state.optimizer.evTargets.maxSocPct, 80);
    assert.deepEqual(ctx.state.optimizer.evTargets.steps, ev[EOS_EV_SOC_VALUE_FIELD]);
  });

  it('Vanilla-EOS: kein Feld, max 100 — wie bis 1.0.9', async () => {
    m = await mockEos(false);
    const ctx = ctxFor(m.port);
    await createEosConfigSync(ctx).sync();
    const ev = (m.puts.filter((p) => p.section === 'devices/electric_vehicles').at(-1) || {}).body?.ev11;
    assert.equal(ev.max_soc_percentage, 100);
    assert.ok(!(EOS_EV_SOC_VALUE_FIELD in ev));
    assert.equal(ev.min_soc_percentage, 40);
    assert.equal(ctx.state.optimizer.evTargets.maxActive, false);
  });
});

describe('Minuten-Wache: geänderte Ziele gehen sofort an EOS', () => {
  it('Max-Ladestand geändert → syncEv, sonst nicht', async () => {
    const { createEvWatch } = await import('../services/optimizer/ev-watch.js');
    const cfg = cfgWith({ eosProxy: { enabled: true }, evPlanOnlyWhenPlugged: false });
    const ctx = {
      state: { optimizer: { eos: { supported: true, evSocValue: true }, eosControlHorizonH: 36, evValueInputs: inputs() } },
      getCfg: () => cfg,
      evccIntegration: { getLoadpoints: () => [{ id: 1, connected: true, vehicleSocPct: 46 }], getStatus: () => ({ lastPolledAt: NOW }) },
    };
    let n = 0;
    const watch = createEvWatch({ ctx, eosConfigSync: { sync: async () => ({ ok: true }), syncEv: async () => { n += 1; return { ok: true }; } }, requestReplan: () => {} });
    await watch.tick(NOW);
    await watch.tick(NOW + 60_000);
    assert.equal(n, 1, 'unverändert: nur der erste Abgleich');
    cfg.optimizer.evMaxSocPct = 90;
    await watch.tick(NOW + 120_000);
    assert.equal(n, 2, 'Max geändert → Fahrzeug neu an EOS');
  });
});

describe('Codex 52c5ee20: Fahrtenliste und Mindestziel', () => {
  it('im Vorlauf der Abfahrt (06:55, Auto steckt noch): laufende Fahrt zählt nicht als Ziel 0 %', () => {
    // Di 17.11. 06:55 Ortszeit = 05:55Z, Abfahrt 07:00 (Mo-Zeile, Folgetag)
    const t = resolveEvTargets(ctxWith(), cfgWith(), { decision: { mode: 'plugged', socPct: 60 }, valueSupported: false, nowMs: Date.parse('2026-11-17T05:55:00Z') });
    assert.ok(t.minSocPct >= 50, `Ziel ${t.minSocPct}`);
    assert.equal(t.deadlineAt, '2026-11-18T06:00:00.000Z');
  });

  it('nur freitags: die Fahrt der Folgewoche liegt in der Vorausschau des Mindestziels', () => {
    // Fr 09:00–... Fahrt 30 %, Min 40, Rückkehr Fr 17:00 → nächste Abfahrt Fr eine Woche später.
    // Damit es greift: kleine Ladeleistung, kurze Zeit — hier Rückkehr erst kurz vor der nächsten Abfahrt.
    const plan = [{ day: 5, arrival: '', departure: '09:00', minSocPct: 40, tripSocPct: 30 }, { day: 4, arrival: '08:00', departure: '23:59', minSocPct: null, tripSocPct: null }];
    const c = cfgWith({ evWeeklyPlan: [{ day: 4, arrival: '08:00', departure: '09:00', minSocPct: 40, tripSocPct: 30 }], evMaxChargeW: 5000, evCapacityWh: 60000 });
    void plan;
    // So 15.11. 12:00: nächste Abfahrt Fr 20.11. 09:00 (Do-Zeile, Folgetag), Rückkehr Do 26.11. 08:00, wieder Fr 27.11. 09:00
    const sun = Date.parse('2026-11-15T11:00:00Z');
    const t = resolveEvTargets({ state: { optimizer: {} } }, c, { decision: { mode: 'plugged', socPct: 30 }, valueSupported: false, nowMs: sun });
    // 40 + 30 − 1 h × 5 kW × 0,88 / 60 kWh (7,33 %) = 62,7 → 63
    assert.equal(t.minSocPct, 63);
  });
});
