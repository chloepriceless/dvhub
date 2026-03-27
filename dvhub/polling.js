// polling.js -- Device polling, energy integration, and energy persistence.
// Extracted from server.js (Phase 3).
// Factory receives DI context; timer lifecycle via start()/stop().

import fs from 'node:fs';
import { berlinDateString, gridDirection, u16, s16 } from './server-utils.js';
import { createSerialTaskRunner, normalizePollIntervalMs } from './runtime-performance.js';
import { resolveImportPriceCtKwhForSlot } from './user-energy-pricing.js';

/**
 * Load persisted energy state from disk into state.energy (if today's data).
 * Standalone export -- called once at startup, before createPoller.
 */
export function loadEnergy(state, energyPath, timezone = 'Europe/Berlin') {
  try {
    if (!fs.existsSync(energyPath)) return;
    const data = JSON.parse(fs.readFileSync(energyPath, 'utf8'));
    const today = berlinDateString(new Date(), timezone);
    if (data.day === today) {
      state.energy.day = data.day;
      state.energy.importWh = Number(data.importWh) || 0;
      state.energy.exportWh = Number(data.exportWh) || 0;
      state.energy.costEur = Number(data.costEur) || 0;
      state.energy.revenueEur = Number(data.revenueEur) || 0;
      state.energy.lastTs = Number(data.lastTs) || 0;
      console.log(`Energy state restored for ${data.day}: import=${(state.energy.importWh / 1000).toFixed(2)}kWh export=${(state.energy.exportWh / 1000).toFixed(2)}kWh`);
    } else {
      console.log(`Energy state file is from ${data.day}, today is ${today} - starting fresh`);
    }
  } catch (e) {
    console.error('Failed to load energy state:', e.message);
  }
}

/**
 * Factory: creates the polling subsystem.
 * @param {object} ctx - DI context { state, getCfg, transport, pushLog, energyPath, onPollComplete, epexNowNext }
 * @returns {{ start: Function, stop: Function, requestPoll: Function }}
 */
export function createPoller(ctx) {
  const { state, getCfg, transport, pushLog } = ctx;

  const MIN_POLL_INTERVAL_MS = 1000;

  let stopping = false;
  let pollTimeout = null;
  let persistInterval = null;

  // --- effectivePollIntervalMs ---
  const effectivePollIntervalMs = () => normalizePollIntervalMs(getCfg().meterPollMs, MIN_POLL_INTERVAL_MS);

  // --- persistEnergy: atomic write (tmp + rename) for crash-safe persistence ---
  function persistEnergy() {
    try {
      const data = {
        day: state.energy.day,
        importWh: state.energy.importWh,
        exportWh: state.energy.exportWh,
        costEur: state.energy.costEur,
        revenueEur: state.energy.revenueEur,
        lastTs: state.energy.lastTs,
        savedAt: Date.now()
      };
      // Atomic write: temp file + rename prevents corruption on crash/power loss
      const tmpPath = ctx.energyPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data) + '\n', 'utf8');
      fs.renameSync(tmpPath, ctx.energyPath);
    } catch (e) {
      // silent - avoid recursive log if pushLog triggers persist
    }
  }

  // --- pointFromRegs: convert raw register values to engineering value ---
  function pointFromRegs(regs, conf) {
    if (!regs || !regs.length) return null;
    const scale = Number(conf.scale ?? 1);
    const offset = Number(conf.offset ?? 0);
    if (conf.quantity > 1 && conf.sumRegisters) {
      let sum = 0;
      for (const r of regs) sum += conf.signed ? s16(r) : r;
      const v = sum * scale + offset;
      return Number(v.toFixed(3));
    }
    let v = regs[0];
    if (conf.signed) v = s16(v);
    v = Number(v) * scale + offset;
    return Number(v.toFixed(3));
  }

  // --- pollPoint: read a single Victron data point ---
  async function pollPoint(name, conf) {
    if (!conf?.enabled) return;
    try {
      if (transport.type === 'mqtt') {
        const result = await transport.readPoint(name);
        state.victron[name] = result.mqttValue;
      } else {
        const regs = await transport.mbRequest(conf);
        state.victron[name] = pointFromRegs(regs, conf);
      }
      delete state.victron.errors[name];
      state.victron.updatedAt = Date.now();
    } catch (e) {
      state.victron.errors[name] = e.message;
      state.victron.updatedAt = Date.now();
    }
  }

  // --- buildDvControlReadbackPollConfig ---
  function buildDvControlReadbackPollConfig(conf, victronConf) {
    const address = Number(conf?.address);
    if (!conf?.enabled || !Number.isFinite(address) || address <= 0) return null;
    return {
      enabled: true,
      fc: 3,
      address,
      quantity: 1,
      signed: false,
      scale: 1,
      offset: 0,
      host: conf.host || victronConf?.host,
      port: conf.port || victronConf?.port,
      unitId: conf.unitId ?? victronConf?.unitId,
      timeoutMs: conf.timeoutMs || victronConf?.timeoutMs
    };
  }

  // --- buildDvControlReadbackPolls ---
  function buildDvControlReadbackPolls(cfg) {
    return [
      ['feedExcessDcPv', buildDvControlReadbackPollConfig(cfg?.dvControl?.feedExcessDcPv, cfg?.victron)],
      ['dontFeedExcessAcPv', buildDvControlReadbackPollConfig(cfg?.dvControl?.dontFeedExcessAcPv, cfg?.victron)]
    ].filter(([, conf]) => !!conf);
  }

  // --- pollDvControlReadback ---
  async function pollDvControlReadback(name, conf) {
    if (transport.type !== 'modbus' || !conf?.enabled) return;
    try {
      const regs = await transport.mbRequest(conf);
      state.victron[name] = pointFromRegs(regs, conf);
      delete state.victron.errors[name];
      state.victron.updatedAt = Date.now();
    } catch (e) {
      state.victron.errors[name] = e.message;
      state.victron.updatedAt = Date.now();
    }
  }

  // --- updateEnergyIntegrals: accumulate import/export Wh and cost/revenue ---
  function updateEnergyIntegrals(nowMs, totalW) {
    const cfg = getCfg();
    const day = berlinDateString(new Date(nowMs), cfg.epex.timezone);
    if (state.energy.day !== day) {
      if (state.energy.day) {
        pushLog('energy_day_end', {
          day: state.energy.day,
          importKwh: Number((state.energy.importWh / 1000).toFixed(4)),
          exportKwh: Number((state.energy.exportWh / 1000).toFixed(4)),
          costEur: Number(state.energy.costEur.toFixed(4)),
          revenueEur: Number(state.energy.revenueEur.toFixed(4))
        });
      }
      state.energy.day = day;
      state.energy.importWh = 0;
      state.energy.exportWh = 0;
      state.energy.costEur = 0;
      state.energy.revenueEur = 0;
      state.energy.lastTs = nowMs;
      persistEnergy();
      return;
    }
    if (!state.energy.lastTs) {
      state.energy.lastTs = nowMs;
      return;
    }
    const dtH = Math.max(0, (nowMs - state.energy.lastTs) / 3600000);
    state.energy.lastTs = nowMs;
    if (dtH <= 0) return;

    const dir = gridDirection(totalW, cfg.gridPositiveMeans);
    const pAbs = Math.abs(Number(totalW) || 0);
    const importW = dir.mode === 'grid_import' ? pAbs : 0;
    const exportW = dir.mode === 'feed_in' ? pAbs : 0;
    state.energy.importWh += importW * dtH;
    state.energy.exportWh += exportW * dtH;

    const currentEpex = ctx.epexNowNext()?.current;
    const epexCtKwh = Number(currentEpex?.ct_kwh ?? 0);

    // Import cost: use the user's configured electricity price (Bezugspreis),
    // not the raw EPEX price. resolveImportPriceCtKwhForSlot handles fixed,
    // dynamic, and Paragraph 14a Module 3 pricing modes.
    const importSlot = { ts: nowMs, ct_kwh: epexCtKwh };
    const importCtKwh = resolveImportPriceCtKwhForSlot(importSlot, cfg.userEnergyPricing || {}, cfg.schedule?.timezone) ?? epexCtKwh;
    state.energy.costEur += (importW / 1000) * dtH * (importCtKwh / 100);

    // Export revenue: EPEX price is the actual feed-in compensation
    state.energy.revenueEur += (exportW / 1000) * dtH * (epexCtKwh / 100);
  }

  // --- pollMeter: main polling function (meter + all Victron points) ---
  async function pollMeter() {
    const cfg = getCfg();
    try {
      let l1, l2, l3, total;
      if (transport.type === 'mqtt') {
        // MQTT: Werte aus Cache lesen (Venus OS: positiv = Import, negativ = Export)
        const ml1 = transport.getCached('meter_l1') ?? 0;
        const ml2 = transport.getCached('meter_l2') ?? 0;
        const ml3 = transport.getCached('meter_l3') ?? 0;
        const posImport = cfg.gridPositiveMeans === 'grid_import';
        // Venus MQTT: positiv = Import -> bei feed_in-Konvention invertieren
        const sign = posImport ? 1 : -1;
        l1 = ml1 * sign;
        l2 = ml2 * sign;
        l3 = ml3 * sign;
        total = (ml1 + ml2 + ml3) * sign;
        state.meter = {
          ok: true, updatedAt: Date.now(), raw: [ml1, ml2, ml3],
          grid_l1_w: l1, grid_l2_w: l2, grid_l3_w: l3, grid_total_w: total,
          error: null
        };
      } else {
        // Modbus: Register lesen und signed interpretieren
        const regs = await transport.mbRequest(cfg.meter);
        const rawL1 = regs.length > 0 ? s16(regs[0]) : 0;
        const rawL2 = regs.length > 1 ? s16(regs[1]) : 0;
        const rawL3 = regs.length > 2 ? s16(regs[2]) : 0;
        const rawTotal = rawL1 + rawL2 + rawL3;

        const posImport = cfg.gridPositiveMeans === 'grid_import';
        const sign = posImport ? 1 : -1;
        l1 = rawL1 * sign;
        l2 = rawL2 * sign;
        l3 = rawL3 * sign;
        total = rawTotal * sign;
        state.meter = {
          ok: true, updatedAt: Date.now(), raw: regs,
          grid_l1_w: l1, grid_l2_w: l2, grid_l3_w: l3, grid_total_w: total,
          error: null
        };
      }

      state.dvRegs[0] = u16(total);
      state.dvRegs[1] = total < 0 ? 0xffff : 0x0000;
      state.dvRegs[3] = 0;
      state.dvRegs[4] = 0;

      updateEnergyIntegrals(state.meter.updatedAt, total);
    } catch (e) {
      state.meter.ok = false;
      state.meter.error = e.message;
      state.meter.updatedAt = Date.now();
    }

    await Promise.all([
      pollPoint('soc', cfg.points.soc),
      pollPoint('batteryPowerW', cfg.points.batteryPowerW),
      pollPoint('pvPowerW', cfg.points.pvPowerW),
      pollPoint('acPvL1W', cfg.points.acPvL1W),
      pollPoint('acPvL2W', cfg.points.acPvL2W),
      pollPoint('acPvL3W', cfg.points.acPvL3W),
      pollPoint('gridSetpointW', cfg.points.gridSetpointW),
      pollPoint('minSocPct', cfg.points.minSocPct),
      pollPoint('selfConsumptionW', cfg.points.selfConsumptionW),
      ...buildDvControlReadbackPolls(cfg).map(([name, conf]) => pollDvControlReadback(name, conf))
    ]);

    const pvDc = Number(state.victron.pvPowerW || 0);
    const pvAc = Number(state.victron.acPvL1W || 0) + Number(state.victron.acPvL2W || 0) + Number(state.victron.acPvL3W || 0);
    state.victron.pvAcW = Number(pvAc.toFixed(3));
    state.victron.pvTotalW = Number((pvDc + pvAc).toFixed(3));

    const gridW = state.meter.grid_total_w || 0;
    const posImport = cfg.gridPositiveMeans === 'grid_import';
    state.victron.gridImportW = Math.max(0, posImport ? gridW : -gridW);
    state.victron.gridExportW = Math.max(0, posImport ? -gridW : gridW);

    const batP = Number(state.victron.batteryPowerW || 0);
    state.victron.batteryChargeW = Math.max(0, batP);
    state.victron.batteryDischargeW = Math.max(0, -batP);

    const loadW = Math.max(0, Number(state.victron.selfConsumptionW || 0));
    const pvTotalW = Math.max(0, Number(state.victron.pvTotalW || 0));
    const gridImportW = Math.max(0, Number(state.victron.gridImportW || 0));
    const gridExportW = Math.max(0, Number(state.victron.gridExportW || 0));
    const batteryChargeW = Math.max(0, Number(state.victron.batteryChargeW || 0));
    const batteryDischargeW = Math.max(0, Number(state.victron.batteryDischargeW || 0));

    const solarToBatteryW = Math.max(0, Math.min(pvTotalW, batteryChargeW));
    const gridToBatteryW = Math.max(0, batteryChargeW - solarToBatteryW);
    const batteryToGridW = Math.max(0, Math.min(batteryDischargeW, gridExportW));
    const batteryDirectUseW = Math.max(0, batteryDischargeW - batteryToGridW);
    const gridDirectUseW = Math.max(0, gridImportW - gridToBatteryW);
    const solarToGridW = Math.max(0, gridExportW - batteryToGridW);
    const solarDirectUseW = Math.max(0, Math.min(pvTotalW, Math.max(0, loadW - gridDirectUseW - batteryDirectUseW)));

    state.victron.solarDirectUseW = solarDirectUseW;
    state.victron.solarToBatteryW = solarToBatteryW;
    state.victron.solarToGridW = solarToGridW;
    state.victron.gridDirectUseW = gridDirectUseW;
    state.victron.gridToBatteryW = gridToBatteryW;
    state.victron.batteryDirectUseW = batteryDirectUseW;
    state.victron.batteryToGridW = batteryToGridW;

    ctx.onPollComplete?.({
      ts: new Date(state.meter.updatedAt || Date.now()).toISOString(),
      resolutionSeconds: Math.max(1, Math.round(effectivePollIntervalMs() / 1000)),
      meter: { ...state.meter },
      victron: { ...state.victron }
    });
  }

  // --- Poll loop infrastructure ---
  const pollMeterRunner = createSerialTaskRunner({
    queueWhileRunning: false,
    task: () => pollMeter()
  });

  function requestPoll() {
    return pollMeterRunner.run();
  }

  function schedulePollLoop() {
    pollTimeout = setTimeout(async () => {
      try {
        await requestPoll();
      } catch (e) {
        pushLog('poll_meter_error', { error: e.message });
      }
      if (!stopping) schedulePollLoop();
    }, effectivePollIntervalMs());
  }

  function start() {
    stopping = false;
    requestPoll().catch(e => console.error('Initial pollMeter error:', e));
    schedulePollLoop();
    persistInterval = setInterval(persistEnergy, 60000);
  }

  function stop() {
    stopping = true;
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    if (persistInterval) { clearInterval(persistInterval); persistInterval = null; }
    persistEnergy();  // Final save before shutdown
  }

  return { start, stop, requestPoll };
}
