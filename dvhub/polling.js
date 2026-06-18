// polling.js -- Device polling, energy integration, and energy persistence.
// Extracted from server.js (Phase 3).
// Factory receives DI context; timer lifecycle via start()/stop().

import fs from 'node:fs';
import { berlinDateString, gridDirection, u16, s16 } from './server-utils.js';
import { createSerialTaskRunner, normalizePollIntervalMs } from './runtime-performance.js';
import { resolveImportPriceCtKwhForSlot } from './user-energy-pricing.js';
import { VEBUS_BLOCK, BATTERY_BLOCK, buildActiveAlarms } from './victron-alarms.js';
// Plan 09-06 (D-08): wrapper around console.* for the polling heavy-hitter module.
import { info as logInfo, warn as logWarn, error as logError, debug as logDebug } from './services/log.js';
// Plan 09-06 (D-06): meter-poll instruments. Wired in pollMeter success/error
// branches (gauge.set on success duration, counter.inc on catch).
import { meterPollDurationSeconds, meterPollErrorsTotal } from './routes-api.js';

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
      // Plan 09-06 (D-08): routed through services/log.js wrapper.
      logInfo(`Energy state restored for ${data.day}: import=${(state.energy.importWh / 1000).toFixed(2)}kWh export=${(state.energy.exportWh / 1000).toFixed(2)}kWh`);
    } else {
      logInfo(`Energy state file is from ${data.day}, today is ${today} - starting fresh`);
    }
  } catch (e) {
    logError('Failed to load energy state', { error: e.message });
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

  // Plan 09-08 Task 3 — backoff invariants (locked in plan frontmatter must_haves):
  //   power = max(0, consecutiveErrors - BACKOFF_THRESHOLD)
  //   nextDelay = min(MAX_BACKOFF_MS, BASE_POLL_MS * 1.5^power)
  // With BASE_POLL_MS=500, threshold=3 → cE∈{0,1,2,3} all yield 500 ms;
  // cE=4 → 750; cE=5 → 1125; cE=15 → 30000 (cap). First success resets cE to 0.
  // BASE_POLL_MS resolves cfg.pollMs (plan invariant — test-injectable) first,
  // then falls back to the project's existing meterPollMs cadence so production
  // behaviour with the default 1000 ms interval is preserved.
  const MAX_BACKOFF_MS = 30_000;
  const BACKOFF_THRESHOLD = 3;

  let stopping = false;
  let pollTimeout = null;
  let persistInterval = null;

  // --- effectivePollIntervalMs ---
  const effectivePollIntervalMs = () => normalizePollIntervalMs(getCfg().meterPollMs, MIN_POLL_INTERVAL_MS);

  // Plan 09-08 Task 3 — resolve BASE_POLL_MS at every tick so config changes
  // (and test injection of cfg.pollMs) take effect without reboot.
  const getBasePollMs = () => {
    const cfg = getCfg() || {};
    const fromPollMs = Number(cfg.pollMs);
    if (Number.isFinite(fromPollMs) && fromPollMs > 0) return fromPollMs;
    return effectivePollIntervalMs();
  };

  // Plan 09-08 Task 3 — ensure backoff state fields exist on state.meter even
  // before the first pollMeter() invocation. The /api/status payload reads
  // state.meter directly so these are visible immediately on boot.
  if (state.meter) {
    if (state.meter.consecutiveErrors === undefined) state.meter.consecutiveErrors = 0;
    if (state.meter.nextRetryAt === undefined) state.meter.nextRetryAt = null;
  }

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
    // T-0107: 32-bit value across two registers (Victron volatile setpoint
    // 2716/2717). wordOrder 'be' (default) = high word first (regs[0]); 'le' =
    // low word first. `* 0x10000` (not <<16) avoids JS 32-bit signed overflow.
    const readType = String(conf.readType || '').toLowerCase();
    if (regs.length >= 2 && (readType === 'int32' || readType === 'uint32')) {
      const le = String(conf.wordOrder || 'be').toLowerCase().startsWith('l');
      const hi = le ? regs[1] : regs[0];
      const lo = le ? regs[0] : regs[1];
      let raw = ((hi & 0xffff) * 0x10000) + (lo & 0xffff);
      if (readType === 'int32' && raw > 0x7fffffff) raw -= 0x100000000;
      const v = raw * scale + offset;
      return Number(v.toFixed(3));
    }
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
      const _now = Date.now();
      state.victron.updatedAt = _now;
      // T-0075: per-Feld Timestamp des letzten ERFOLGS (NUR Erfolgs-Zweig).
      // updatedAt allein ist "letzter Versuch" (auch im catch gesetzt) und taugt
      // NICHT als Frische-Mass — ein eingefrorener SoC nach Comms-Ausfall behielte
      // seinen Wert. fieldUpdatedAt reflektiert echte Aktualitaet je Feld.
      (state.victron.fieldUpdatedAt ??= {})[name] = _now;
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
      const _now = Date.now();
      state.victron.updatedAt = _now;
      // T-0075: per-field success timestamp (success branch only), mirroring
      // pollPoint — real freshness for the dv-control readback fields too.
      (state.victron.fieldUpdatedAt ??= {})[name] = _now;
    } catch (e) {
      state.victron.errors[name] = e.message;
      state.victron.updatedAt = Date.now();
    }
  }

  // --- Victron device-alarm polling (read-only DISPLAY feature) ---------------
  // Reads the VE.Bus + Battery/BMS alarm registers and surfaces active alarms as
  // state.victron.alarms → /api/status.victronAlarms → sticky GUI banner.
  //
  // DECOUPLED from the ~1 Hz control poll: throttled to victron.alarms.pollIntervalMs
  // (~30 s) so device alarms (minute-scale) don't add 1 Hz Modbus load on two
  // extra unit-ids. ISOLATED: a fully self-contained try/catch — an alarm-read
  // failure must NEVER touch state.meter / the control-telemetry path. Runs INSIDE
  // the serial pollMeter runner (after the energy Promise.all) so there is no real
  // socket concurrency: the transport's send-queue pulls control + alarm reads
  // one at a time, tid-matched (see transport-modbus.js send()/_next).
  let lastAlarmPollMs = 0;

  // null/''/undefined/out-of-range → null (Number(null)===0 is finite, so an
  // explicit null/empty guard is required before the finite check).
  function alarmUnitIdOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 255 ? n : null;
  }

  async function readAlarmBlock(victronConf, unitId, block) {
    if (unitId == null || !Number.isFinite(Number(unitId))) return null;
    try {
      const regs = await transport.mbRequest({
        host: victronConf.host,
        port: victronConf.port,
        unitId: Number(unitId),
        fc: 4,
        address: block.start,
        quantity: block.count,
        timeoutMs: Number(victronConf?.alarms?.timeoutMs) || 1500
      });
      return Array.isArray(regs) ? regs : null;
    } catch {
      return null; // read failure → treated as a failed cycle by the caller
    }
  }

  async function pollVictronAlarms(cfg) {
    try {
      if (transport.type !== 'modbus') return; // MQTT transport has no block reads
      const aCfg = cfg?.victron?.alarms;
      if (!aCfg || aCfg.enabled === false) return;
      const vebusUnitId = alarmUnitIdOrNull(aCfg.vebusUnitId);
      const batteryUnitId = alarmUnitIdOrNull(aCfg.batteryUnitId);
      if (vebusUnitId == null && batteryUnitId == null) {
        // no unit-ids configured → mark not-configured so the read-side shows no
        // banner (absence of banner ≠ a trusted "all OK").
        const prev = state.victron.alarms;
        state.victron.alarms = { configured: false, active: [], updatedAt: prev?.updatedAt || null };
        return;
      }
      const intervalMs = Number(aCfg.pollIntervalMs) || 30000;
      const now = Date.now();
      if (now - lastAlarmPollMs < intervalMs) return; // throttle (decouple from 1 Hz)
      lastAlarmPollMs = now;

      const reads = await Promise.all([
        vebusUnitId == null ? Promise.resolve('skip') : readAlarmBlock(cfg.victron, vebusUnitId, VEBUS_BLOCK),
        batteryUnitId == null ? Promise.resolve('skip') : readAlarmBlock(cfg.victron, batteryUnitId, BATTERY_BLOCK)
      ]);
      const vebus = reads[0] === 'skip' ? null : reads[0];
      const battery = reads[1] === 'skip' ? null : reads[1];
      // a CONFIGURED unit returning null = read failure this cycle. Keep the
      // last-known active list but do NOT bump updatedAt → the read-side flags it
      // stale and degrades the banner (no stale "all clear" masquerade).
      const failed = (vebusUnitId != null && vebus == null) || (batteryUnitId != null && battery == null);
      if (failed) {
        state.victron.alarms = { ...(state.victron.alarms || { active: [] }), configured: true };
        return;
      }
      const prevActive = state.victron.alarms?.active || [];
      const active = buildActiveAlarms({ vebus, battery }, prevActive, now);
      state.victron.alarms = { configured: true, active, updatedAt: new Date(now).toISOString() };
    } catch (e) {
      // alarm polling must NEVER disturb the control/telemetry path
      try { pushLog('victron_alarm_poll_error', { error: e?.message }); } catch { /* never throw */ }
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
    // Plan 09-06 (D-06): wall-clock duration of the meter read — recorded into
    // dvhub_meter_poll_duration_seconds gauge on success, dvhub_meter_poll_errors_total
    // counter on catch. Tracked in seconds (Prometheus convention).
    const __pollStart = process.hrtime.bigint();
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
          error: null,
          // Plan 09-08 Task 3: success path resets backoff (consecutiveErrors=0,
          // nextRetryAt=null). Mirrors the Modbus branch below.
          consecutiveErrors: 0,
          nextRetryAt: null
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
          error: null,
          // Plan 09-08 Task 3: success path resets backoff (consecutiveErrors=0,
          // nextRetryAt=null). Mirrors the MQTT branch above.
          consecutiveErrors: 0,
          nextRetryAt: null
        };
      }

      state.dvRegs[0] = u16(total);
      state.dvRegs[1] = total < 0 ? 0xffff : 0x0000;
      state.dvRegs[3] = 0;
      state.dvRegs[4] = 0;

      updateEnergyIntegrals(state.meter.updatedAt, total);
      // Plan 09-06 (D-06): success — record poll duration into the gauge.
      try {
        const durationSec = Number(process.hrtime.bigint() - __pollStart) / 1e9;
        meterPollDurationSeconds.set(durationSec);
        // Phase 09.2 D-04: record a successful Victron poll sample for the
        // health tracker. Optional chaining defends against the boot-race
        // window where pollMeter fires before ctx.healthTracker is assigned
        // (telemetryReady IIFE in server.js); also tolerates the case where
        // db init failed and the tracker was never wired.
        ctx.healthTracker?.recordSample('victron', {
          latencyMs: Math.round(durationSec * 1000),
          success: true
        });
      } catch { /* metrics must never break the poll cycle */ }
    } catch (e) {
      state.meter.ok = false;
      state.meter.error = e.message;
      state.meter.updatedAt = Date.now();
      // Plan 09-08 Task 3: increment consecutiveErrors here, BEFORE
      // pollMeterWithBackoff schedules the next tick. The delay formula
      // (power = max(0, cE - BACKOFF_THRESHOLD); delay = BASE * 1.5^power)
      // then uses the post-increment value — matches the locked delay table
      // in the plan's must_haves.truths block.
      state.meter.consecutiveErrors = (state.meter.consecutiveErrors || 0) + 1;
      // Plan 09-06 (D-06): error — increment the counter.
      try {
        meterPollErrorsTotal.inc();
        // Phase 09.2 D-04: record a failed Victron poll sample. Latency is
        // captured from the same __pollStart so error-path timing is honest
        // (a slow timeout shows up as elevated latency, not zero).
        ctx.healthTracker?.recordSample('victron', {
          latencyMs: Number(process.hrtime.bigint() - __pollStart) / 1e6,
          success: false
        });
      } catch { /* metrics must never break the poll cycle */ }
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
      pollPoint('maxDischargeW', cfg.points.maxDischargeW),
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

    // Read-only device-alarm poll — throttled (~30 s) + fully isolated. Placed
    // AFTER onPollComplete so it never delays the powerflow snapshot; its result
    // (state.victron.alarms) rides the next snapshot and is read by the route via
    // the runtime IPC snapshot (payload.victron.alarms), NOT web-process state.
    await pollVictronAlarms(cfg);
  }

  // --- Poll loop infrastructure ---
  const pollMeterRunner = createSerialTaskRunner({
    queueWhileRunning: false,
    task: () => pollMeter()
  });

  function requestPoll() {
    return pollMeterRunner.run();
  }

  // Plan 09-08 Task 3 — pollMeterWithBackoff: replaces the fixed-cadence
  // schedulePollLoop. Each tick awaits pollMeter (which updates
  // state.meter.consecutiveErrors in its catch block), then computes the next
  // delay using the locked formula:
  //   power = max(0, consecutiveErrors - BACKOFF_THRESHOLD)
  //   nextDelay = min(MAX_BACKOFF_MS, BASE_POLL_MS * 1.5^power)
  // BASE_POLL_MS resolves cfg.pollMs ?? effectivePollIntervalMs() so
  // production behaviour (1 s default) is preserved while tests can inject
  // cfg.pollMs=500 for the locked delay table (cE=4 → 750 ms, cE=5 → 1125 ms,
  // cE=15 → 30 000 ms cap).
  async function pollMeterWithBackoff() {
    try {
      await requestPoll();
    } catch (e) {
      pushLog('poll_meter_error', { error: e.message });
    }
    if (stopping) return;
    const cE = (state.meter && state.meter.consecutiveErrors) || 0;
    const basePollMs = getBasePollMs();
    let nextDelay = basePollMs;
    if (cE >= BACKOFF_THRESHOLD) {
      const power = Math.max(0, cE - BACKOFF_THRESHOLD);
      nextDelay = Math.min(MAX_BACKOFF_MS, basePollMs * Math.pow(1.5, power));
    }
    if (state.meter) state.meter.nextRetryAt = Date.now() + nextDelay;
    pollTimeout = setTimeout(pollMeterWithBackoff, nextDelay);
    if (typeof pollTimeout?.unref === 'function') pollTimeout.unref();
  }

  function start() {
    stopping = false;
    // Plan 09-08 Task 3: single pollMeterWithBackoff kickoff replaces the
    // original `requestPoll() + schedulePollLoop()` pair. The function
    // self-reschedules with exponential backoff after BACKOFF_THRESHOLD
    // consecutive failures.
    // Plan 09-06 (D-08): routed through services/log.js wrapper.
    pollMeterWithBackoff().catch(e => logError('Initial pollMeter error', { error: e?.message ?? String(e) }));
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
