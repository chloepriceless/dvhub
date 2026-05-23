// services/optimizer/eos-config-sync.js — Phase 21 (operator request 2026-05-23).
//
// Pushes DVhub's optimizer/battery/inverter settings into EOS via the
// path-based PUT /v1/config/{section} endpoint. Without this, EOS keeps its
// bootstrap defaults (8 kWh battery, 5 kW charge, 0% min-SoC, 10 kW inverter)
// regardless of what DVhub knows about the operator's actual hardware — so
// the genetic optimizer produces plans for a fictional appliance.
//
// Triggered from server.js:saveAndApplyConfig() (fire-and-forget) and once
// at boot when EOS first reports healthy. Same defensive contract as
// eos-adapter.js: never throws, returns { ok, applied, errors }.

import http from 'node:http';

const TIMEOUT_MS = 8_000;
const BATTERY_DEVICE_ID = 'battery1';   // EOS default — mirrors what EOS bootstraps.
const INVERTER_DEVICE_ID = 'inverter1'; // EOS default — same.
// Standard 11-step charge-rate grid used by EOS GENETIC (0 .. 1 in 0.1 steps).
const DEFAULT_CHARGE_RATES = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

/**
 * Split a round-trip efficiency into a symmetric charge/discharge pair.
 * DVhub stores one round-trip number; EOS wants two. sqrt(rt) gives a
 * symmetric split that round-trips back to the original.
 *
 * @param {number} rt - round-trip efficiency, expected in (0, 1].
 * @returns {number} per-direction efficiency in (0, 1].
 */
function splitRoundTripEff(rt) {
  if (!Number.isFinite(rt) || rt <= 0 || rt > 1) return 0.94; // safe symmetric default
  return Math.sqrt(rt);
}

/**
 * Build the EOS batteries array from a DVhub config object. Returns a single
 * battery entry — DVhub only ever models one home-battery bank. Keeps the
 * EOS measurement_key_* fields untouched (EOS regenerates them itself when
 * device_id is preserved).
 *
 * @param {object} cfg - DVhub raw config (from getCfg()).
 * @returns {Array<object>}
 */
export function buildEosBatteries(cfg) {
  const opt = cfg?.optimizer || {};
  const eff = splitRoundTripEff(opt.roundTripEfficiency);
  const costs = cfg?.userEnergyPricing?.costs || {};
  // ct/kWh + loss-markup% → €/kWh. Defaults to 0 (EOS bootstrap value) so a
  // missing pricing block doesn't accidentally penalise battery dispatch.
  const baseCt = Number(costs.batteryBaseCtKwh) || 0;
  const markupPct = Number(costs.batteryLossMarkupPct) || 0;
  const levelisedEurKwh = (baseCt / 100) * (1 + markupPct / 100);

  return [{
    device_id: BATTERY_DEVICE_ID,
    capacity_wh: Number(opt.batteryCapacityWh) || 8000,
    charging_efficiency: eff,
    discharging_efficiency: eff,
    levelized_cost_of_storage_kwh: Number(levelisedEurKwh.toFixed(6)),
    max_charge_power_w: Number(opt.maxChargeW) || 5000,
    // DVhub has no min_charge_power_w setting — leave EOS default (50 W is
    // a sane modulation floor for most hybrid inverters; configurable later).
    min_charge_power_w: 50,
    charge_rates: DEFAULT_CHARGE_RATES,
    min_soc_percentage: Number(opt.minSocPct) || 0,
    max_soc_percentage: Number(opt.maxSocPct) || 100,
  }];
}

/**
 * Build the EOS inverters array. DVhub doesn't yet expose AC-cap or per-
 * direction conversion efficiencies as first-class config; we derive max_power_w
 * from the PV nameplate (mispel.pvKwp × 1000) as a defensible upper bound and
 * use symmetric 1.0 conversion efficiencies (which match EOS bootstrap, so
 * no behaviour change unless DVhub later adds explicit fields).
 *
 * @param {object} cfg
 * @returns {Array<object>}
 */
export function buildEosInverters(cfg) {
  const opt = cfg?.optimizer || {};
  const pvKwp = Number(opt?.mispel?.pvKwp);
  const maxPowerW = Number.isFinite(pvKwp) && pvKwp > 0 ? pvKwp * 1000 : 10000;
  return [{
    device_id: INVERTER_DEVICE_ID,
    max_power_w: maxPowerW,
    battery_id: BATTERY_DEVICE_ID,
    ac_to_dc_efficiency: 1.0,
    dc_to_ac_efficiency: 1.0,
    max_ac_charge_power_w: Number(opt.maxChargeW) || null,
  }];
}

/**
 * Internal HTTP helper. Mirrors eos-adapter.js — never throws, returns
 * { ok, data?, error? } so the caller can fan out per-section errors.
 */
function eosHttpRequest(baseUrl, method, path, body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(path, baseUrl);
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 8503,
        path: url.pathname,
        method,
        headers,
        timeout: TIMEOUT_MS,
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            resolve({ ok: false, error: `EOS HTTP ${res.statusCode}: ${chunks.slice(0, 200)}` });
            return;
          }
          try {
            resolve({ ok: true, data: chunks ? JSON.parse(chunks) : null });
          } catch {
            resolve({ ok: true, data: null });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message || 'EOS connect error' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'EOS timeout' }); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    } catch (err) {
      resolve({ ok: false, error: err.message || 'EOS request failed' });
    }
  });
}

/**
 * Create an EOS config-sync agent. Returns a single `sync()` function that
 * pushes battery + inverter config sections to EOS. Caller can pushLog the
 * structured result.
 *
 * @param {object} ctx - DI context with getCfg() and pushLog()
 * @returns {{ sync: () => Promise<{ok: boolean, applied: string[], errors: object}> }}
 */
export function createEosConfigSync(ctx) {
  const { getCfg, pushLog } = ctx;

  async function sync() {
    const cfg = getCfg();
    const baseUrl = cfg?.optimizer?.eosProxy?.url || 'http://127.0.0.1:8503';

    // No-op when the operator has explicitly disabled the EOS bridge — avoids
    // log spam when EOS isn't running and the operator doesn't intend it to.
    if (cfg?.optimizer?.eosProxy?.enabled === false) {
      return { ok: true, applied: [], errors: {}, skipped: 'eosProxy.enabled=false' };
    }

    const batteries = buildEosBatteries(cfg);
    const inverters = buildEosInverters(cfg);

    // Phase 21 (2026-05-23): also flip every EOS provider to the Import
    // variant so EOS consumes the forecasts DVhub pushes via eos-adapter
    // (PVForecastImport/LoadImport/ElecPriceImport/FeedInTariffImport). Plus
    // ems.mode → OPTIMIZATION so the genetic algo runs every 300 s instead
    // of staying dormant (DISABLED) waiting for a manual trigger. When the
    // operator turns off the EOS bridge (eosProxy.enabled=false) the sync
    // doesn't run at all (see early-return above), so this won't fight
    // anyone who explicitly wants EOS in pull-only mode.
    const tariffMode = String(cfg?.optimizer?.tariff?.feedInMode || 'fixed').toLowerCase();
    const feedInProvider = tariffMode === 'spot' ? 'FeedInTariffImport' : 'FeedInTariffFixed';

    const tasks = [
      { section: 'devices/batteries',      body: batteries },
      { section: 'devices/inverters',      body: inverters },
      { section: 'pvforecast/provider',    body: 'PVForecastImport' },
      { section: 'load/provider',          body: 'LoadImport' },
      { section: 'elecprice/provider',     body: 'ElecPriceImport' },
      { section: 'feedintariff/provider',  body: feedInProvider },
      { section: 'ems/mode',               body: 'OPTIMIZATION' },
    ];

    const applied = [];
    const errors = {};
    for (const t of tasks) {
      const res = await eosHttpRequest(baseUrl, 'PUT', `/v1/config/${t.section}`, t.body);
      if (res.ok) applied.push(t.section);
      else errors[t.section] = res.error;
    }

    const okAll = applied.length === tasks.length;
    if (pushLog) {
      pushLog('eos_config_sync', {
        ok: okAll,
        applied,
        errors,
        battery_capacity_wh: batteries[0]?.capacity_wh,
        battery_max_charge_w: batteries[0]?.max_charge_power_w,
        battery_min_soc_pct: batteries[0]?.min_soc_percentage,
        inverter_max_power_w: inverters[0]?.max_power_w,
      });
    }
    return { ok: okAll, applied, errors };
  }

  return { sync };
}
