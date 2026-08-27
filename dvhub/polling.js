// polling.js -- Device polling, energy integration, and energy persistence.
// Extracted from server.js (Phase 3).
// Factory receives DI context; timer lifecycle via start()/stop().

import fs from 'node:fs';
import { berlinDateString, gridDirection, u16, s16 } from './server-utils.js';
import { createSerialTaskRunner, normalizePollIntervalMs } from './runtime-performance.js';
import { safeInterval } from './services/safe-async.js';
import { decodeSunspecFloat32, scanSunspecModels, resolveSunspecAddresses } from './services/inverter/sunspec.js';
import { resolveImportPriceCtKwhForSlot } from './user-energy-pricing.js';
import { VEBUS_BLOCK, BATTERY_BLOCK, buildActiveAlarms, buildActiveAlarmsFromDbus } from './victron-alarms.js';
// T-FREEZE (2026-07-24): Einfrier-Wächter. Erkennt eingefrorene Live-Werte trotz
// ERFOLGREICHER Reads (halb-tote GX-Modbus-Session) — die eine Lücke, die weder die
// T-0075-Frische noch die T-VERIFY-Rücklesung schließt.
import { createFreezeWatchdog } from './services/telemetry-freeze-watchdog.js';
// Plan 09-06 (D-08): wrapper around console.* for the polling heavy-hitter module.
import { info as logInfo, error as logError } from './services/log.js';
// Plan 09-06 (D-06): meter-poll instruments. Wired in pollMeter success/error
// branches (gauge.set on success duration, counter.inc on catch).
import { meterPollDurationSeconds, meterPollErrorsTotal, telemetryFreezeActive } from './routes-api.js';

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
  // spine-http-Meterzweig (EnergyLink): HTTP-Client injizierbar für Tests,
  // Default ist das globale fetch (Node >= 18).
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;

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

  // T-FREEZE: läuft am Ende jedes Poll-Zyklus (nach den abgeleiteten Größen, vor
  // onPollComplete) und datiert bei erkanntem Einfrierer die Frische-Stempel zurück
  // → der bestehende T-0075-Entlade-Boden-Schutz greift. Auf MQTT ein No-op.
  const freezeWatchdog = createFreezeWatchdog(ctx);

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
    } catch {
      // silent - avoid recursive log if pushLog triggers persist
    }
  }

  // --- pointFromRegs: convert raw register values to engineering value ---
  function pointFromRegs(regs, conf) {
    if (!regs || !regs.length) return null;
    const scale = Number(conf.scale ?? 1);
    const offset = Number(conf.offset ?? 0);
    // SunSpec Float-Modus (B-1112 Fronius/SolarEdge/Kostal): zwei Register =
    // IEEE-754-Float32. Der Codec liefert null für das SunSpec-NaN-Sentinel
    // ("not implemented") und ±Inf — null hält die T-0075-Unknown-Semantik
    // aufrecht (pollPoint stempelt fieldUpdatedAt nur bei echtem Wert nicht,
    // sondern der Punkt bleibt sichtbar unbelegt statt giftig NaN im State).
    if (String(conf.readType || '').toLowerCase() === 'float32') {
      const value = decodeSunspecFloat32(regs, conf.wordOrder);
      if (value === null) return null;
      return Number((value * scale + offset).toFixed(3));
    }
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
    // rawSentinels (2026-07-12, reg-2704-Scale-Fix): Sentinel-Rohwerte sind
    // MODES (Victron 2704: -1 = unbegrenzt, 0 = gesperrt) und werden NICHT
    // skaliert — sonst würde -1 mit scale 10 als „-10 W" angezeigt.
    const rawSentinels = Array.isArray(conf.rawSentinels) ? conf.rawSentinels.map(Number) : [];
    if (rawSentinels.includes(Number(v))) return Number(v);
    v = Number(v) * scale + offset;
    return Number(v.toFixed(3));
  }

  // --- pollPoint: read a single Victron data point ---
  async function pollPoint(name, conf) {
    if (!conf?.enabled) return;
    // SunSpec-deklarierte Punkte warten auf den Geräte-Scan (ensureSunspecResolved)
    // — vor der Auflösung wäre die Adresse null (Lesen von Register-Müll).
    if (conf.sunspec && conf.address == null) return;
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
    if (!conf?.enabled) return;
    if (transport.type !== 'modbus' && transport.type !== 'mqtt') return;
    try {
      if (transport.type === 'mqtt') {
        // T-MQTT-READBACK (2026-07-25): die Read-Topics für feedExcessDcPv /
        // dontFeedExcessAcPv existieren im Venus-Mapping längst (T-VERIFY) — nur
        // dieser Pfad war noch hart auf Modbus verriegelt, sodass auf MQTT die
        // Rücklesung der DV-Steuerpunkte fehlte (Voraussetzung für einen
        // vollständigen Umzug auf MQTT).
        const result = await transport.readPoint(name);
        state.victron[name] = result.mqttValue;
      } else {
        const regs = await transport.mbRequest(conf);
        state.victron[name] = pointFromRegs(regs, conf);
      }
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
  // T-ALARM-POLL-V2 (2026-07-22): adaptive cadence. The VE.Bus/BMS unit reads
  // go through the GX's single-threaded dbus-modbustcp — on a busy Venus they
  // can stall it and starve the CONTROL path (root cause of the 12.07.+ Modbus
  // burst regression on the operator install). Alarm banners are minute-scale
  // information, so they must always yield:
  //   • latency guard  — a slow cycle doubles the effective interval (cap 15 min)
  //   • failure backoff — a failed cycle backs off exponentially (cap 60 min)
  //   • health gate    — no alarm reads at all while the control poll is erroring
  //   • recovery decay — healthy fast cycles shrink the interval back to base
  let alarmDynMs = 0; // dynamic add-on over the configured base interval

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
      const aCfg = cfg?.victron?.alarms;
      if (!aCfg || aCfg.enabled === false) return;
      if (transport.type === 'mqtt') {
        // T-MQTT-ALARMS (2026-07-25): über MQTT gibt es keine Blockreads, aber die
        // Alarm-dbus-Pfade kommen ohnehin gepusht (Transport abonniert sie). Kein
        // Throttle nötig — es entsteht keine zusätzliche Geräte-Last. Kein
        // Rückfall auf „alles in Ordnung": ohne frische Werte bleibt das Banner
        // ohne Zeitstempel und die Leseseite degradiert es zu „veraltet".
        const values = transport.getAlarmValues?.();
        const prevActive = state.victron.alarms?.active || [];
        if (!values) {
          state.victron.alarms = { ...(state.victron.alarms || { active: [] }), configured: true };
          return;
        }
        const nowMs = Date.now();
        const active = buildActiveAlarmsFromDbus(values, prevActive, nowMs);
        state.victron.alarms = { configured: true, active, updatedAt: new Date(nowMs).toISOString() };
        return;
      }
      if (transport.type !== 'modbus') return;
      const vebusUnitId = alarmUnitIdOrNull(aCfg.vebusUnitId);
      const batteryUnitId = alarmUnitIdOrNull(aCfg.batteryUnitId);
      if (vebusUnitId == null && batteryUnitId == null) {
        // no unit-ids configured → mark not-configured so the read-side shows no
        // banner (absence of banner ≠ a trusted "all OK").
        const prev = state.victron.alarms;
        state.victron.alarms = { configured: false, active: [], updatedAt: prev?.updatedAt || null };
        return;
      }
      // T-ALARM-POLL-V2: base interval min 60 s (alarms are banners, not control),
      // effective interval = base + adaptive add-on from past slowness/failures.
      const baseMs = Math.max(60000, Number(aCfg.pollIntervalMs) || 120000);
      const intervalMs = baseMs + alarmDynMs;
      const now = Date.now();
      if (now - lastAlarmPollMs < intervalMs) return; // throttle (decouple from 1 Hz)
      // Health gate: while the control-telemetry poll is failing, the GX Modbus
      // service is already struggling — adding unit-block reads makes it worse.
      // Count the window as served so the next attempt is a full interval away.
      if (Number(state.meter?.consecutiveErrors) > 0) { lastAlarmPollMs = now; return; }
      lastAlarmPollMs = now;

      // Sequential (not Promise.all): one unit-block in flight at a time keeps
      // the burst on the GX as small as possible.
      const cycleT0 = Date.now();
      const vebus = vebusUnitId == null ? null : await readAlarmBlock(cfg.victron, vebusUnitId, VEBUS_BLOCK);
      const battery = batteryUnitId == null ? null : await readAlarmBlock(cfg.victron, batteryUnitId, BATTERY_BLOCK);
      const cycleMs = Date.now() - cycleT0;
      // a CONFIGURED unit returning null = read failure this cycle. Keep the
      // last-known active list but do NOT bump updatedAt → the read-side flags it
      // stale and degrades the banner (no stale "all clear" masquerade).
      const failed = (vebusUnitId != null && vebus == null) || (batteryUnitId != null && battery == null);
      if (failed) {
        // T-ALARM-POLL-V2 failure backoff: exponential, floor 5 min over base,
        // cap 60 min. One log line per escalation step (no 30-s spam).
        const nextDyn = Math.min(3600000, Math.max(300000, alarmDynMs * 2 || 300000));
        if (nextDyn !== alarmDynMs) {
          try { pushLog('victron_alarm_poll_backoff', { cycleMs, nextIntervalMs: baseMs + nextDyn }); } catch { /* never throw */ }
        }
        alarmDynMs = nextDyn;
        state.victron.alarms = { ...(state.victron.alarms || { active: [] }), configured: true };
        return;
      }
      // T-ALARM-POLL-V2 latency guard + recovery decay: a slow-but-successful
      // cycle (>1.5 s for both blocks) doubles the add-on (cap 15 min); a fast
      // healthy cycle decays it by 25 % back toward the base interval.
      if (cycleMs > 1500) {
        alarmDynMs = Math.min(900000, Math.max(60000, alarmDynMs * 2 || 60000));
      } else {
        alarmDynMs = alarmDynMs > 1000 ? Math.round(alarmDynMs * 0.75) : 0;
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

  // --- SunSpec-Scan (B-1112): löst sunspec-deklarierte Punkte lazy auf ---
  // Vendor-Profile (z. B. hersteller/fronius.json) deklarieren Punkte als
  // sunspec:{model, offset} statt fester Adressen (float- vs. int+SF-Layout
  // verschiebt die Modell-Basen). Läuft im Poll-Loop statt als Boot-Hook:
  // nach jedem Config-Apply ersetzt server.js das cfg-Objekt (die aufgelösten
  // Adressen sind dann weg) — der needs-Check hier erkennt das und scannt neu.
  // Erfolg mutiert die EFFEKTIVE Config in-place; Schreibpfad (schedule-eval)
  // sieht dieselbe Referenz. Fehler → Backoff, Punkte bleiben schlafend
  // (pollPoint/applyControlTarget überspringen unaufgelöste sunspec-Punkte).
  let sunspecRetryAt = 0;
  // Drossel für m160_battery-Derive-Diagnose (1×/5 min statt jeden Zyklus).
  let m160DeriveLogAt = 0;
  async function ensureSunspecResolved(cfg) {
    const blocks = [cfg.points, cfg.controlWrite];
    const needs = blocks.some((block) => Object.values(block || {})
      .some((conf) => conf && typeof conf === 'object' && conf.sunspec && conf.address == null));
    if (!needs) return;
    const now = Date.now();
    if (now < sunspecRetryAt) return;
    sunspecRetryAt = now + 60000;
    const v = cfg.victron || {};
    try {
      const scan = await scanSunspecModels((address, quantity) => transport.mbRequest({
        fc: 3, host: v.host, port: v.port, unitId: v.unitId, timeoutMs: v.timeoutMs, address, quantity
      }));
      const allMissing = [];
      for (const block of blocks) {
        if (!block) continue;
        const { resolved, missing } = resolveSunspecAddresses(block, scan);
        for (const [name, conf] of Object.entries(resolved)) block[name] = conf;
        allMissing.push(...missing);
      }
      // M160-Modellbasis für den m160_battery-Derive merken: der liest den
      // Block zur LAUFZEIT inkl. DCW_SF — eine statisch aufgelöste Punkt-
      // Adresse allein reicht dafür nicht.
      (state.ctrl ??= {})._sunspecM160 = scan.byId.get(160)?.[0] || null;
      pushLog('sunspec_scan_ok', {
        base: scan.base,
        models: scan.models.map((m) => m.id),
        missing: allMissing
      });
    } catch (e) {
      pushLog('sunspec_scan_error', { error: e.message }, 'warn');
    }
  }

  // --- pollMeter: main polling function (meter + all Victron points) ---
  async function pollMeter() {
    const cfg = getCfg();
    await ensureSunspecResolved(cfg);
    // Plan 09-06 (D-06): wall-clock duration of the meter read — recorded into
    // dvhub_meter_poll_duration_seconds gauge on success, dvhub_meter_poll_errors_total
    // counter on catch. Tracked in seconds (Prometheus convention).
    const __pollStart = process.hrtime.bigint();
    try {
      let l1, l2, l3, total;
      if (String(cfg.meter?.readType || '').toLowerCase() === 'spine-http') {
        // SPiNE EnergyLink One als Netzzähler-Quelle: der eingebaute
        // 3-Phasen-Zähler (Shelly Pro3EM) wird über die lokale HTTP-API des
        // Geräts gelesen (GET /rpc/EM.GetStatus; Semantik: positiv = Bezug).
        // Unabhängig vom Anlagen-Transport — Victron/Fronius-Punkte laufen
        // weiter über Modbus/MQTT; cfg.meter wählt NUR die Netzzähler-Quelle.
        // Läuft dvHub als Container AUF dem EnergyLink, ist die baseUrl
        // http://local-api:80 (interner Hostname), sonst die Geräte-IP.
        const baseUrl = String(cfg.meter.baseUrl || `http://${cfg.meter.host}`).replace(/\/+$/, '');
        const timeoutMs = Number(cfg.meter.timeoutMs || 4000);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let em;
        try {
          const res = await fetchImpl(`${baseUrl}/rpc/EM.GetStatus`, { signal: ctrl.signal });
          if (!res.ok) throw new Error(`spine meter: HTTP ${res.status}`);
          em = await res.json();
        } finally {
          clearTimeout(timer);
        }
        const fTotal = Number(em?.total_act_power);
        // Fehlendes/NaN-Total ist ein Lesefehler — werfen, damit der normale
        // Fehler-/Backoff-Pfad greift statt einer stillen 0 im Steuerpfad
        // (gleiche Regel wie im float32-Zweig).
        if (!Number.isFinite(fTotal)) throw new Error('spine meter: total power missing/NaN');
        const fL1 = Number(em?.a_act_power) || 0;
        const fL2 = Number(em?.b_act_power) || 0;
        const fL3 = Number(em?.c_act_power) || 0;
        const posImport = cfg.gridPositiveMeans === 'grid_import';
        // EM.GetStatus: positiv = Bezug → bei feed_in-Konvention invertieren
        const sign = posImport ? 1 : -1;
        // Auf ganze Watt runden: state.dvRegs[0] = u16(total) unten erwartet
        // Integer-Registersemantik (wie float32-Zweig). `|| 0` normalisiert
        // das -0, das bei 0 * sign(-1) entsteht.
        l1 = Math.round(fL1 * sign) || 0;
        l2 = Math.round(fL2 * sign) || 0;
        l3 = Math.round(fL3 * sign) || 0;
        total = Math.round(fTotal * sign) || 0;
        state.meter = {
          ok: true, updatedAt: Date.now(), raw: [fTotal, fL1, fL2, fL3],
          grid_l1_w: l1, grid_l2_w: l2, grid_l3_w: l3, grid_total_w: total,
          error: null,
          consecutiveErrors: 0,
          nextRetryAt: null
        };
      } else if (transport.type === 'mqtt') {
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
      } else if (String(cfg.meter?.readType || '').toLowerCase() === 'float32') {
        // SunSpec-Float-Meter (B-1112, z. B. Fronius Smart Meter Model 203 @
        // Unit-ID 200): 8 Register = 4×Float32 in der Reihenfolge
        // [W_total, WphA, WphB, WphC]. Ein NaN-Total (Meter meldet "not
        // implemented"/Ausfall) ist ein Lesefehler — werfen, damit der normale
        // Fehler-/Backoff-Pfad greift statt einer stillen 0 im Steuerpfad.
        const regs = await transport.mbRequest({ ...cfg.meter, quantity: 8 });
        const fTotal = decodeSunspecFloat32([regs[0], regs[1]], cfg.meter.wordOrder);
        if (fTotal === null) throw new Error('sunspec float meter: total power not implemented/NaN');
        const fL1 = decodeSunspecFloat32([regs[2], regs[3]], cfg.meter.wordOrder) ?? 0;
        const fL2 = decodeSunspecFloat32([regs[4], regs[5]], cfg.meter.wordOrder) ?? 0;
        const fL3 = decodeSunspecFloat32([regs[6], regs[7]], cfg.meter.wordOrder) ?? 0;

        const posImport = cfg.gridPositiveMeans === 'grid_import';
        const sign = posImport ? 1 : -1;
        // Auf ganze Watt runden: state.dvRegs[0] = u16(total) unten erwartet
        // Integer-Registersemantik; Sub-Watt-Auflösung trägt keine Information.
        l1 = Math.round(fL1 * sign);
        l2 = Math.round(fL2 * sign);
        l3 = Math.round(fL3 * sign);
        total = Math.round(fTotal * sign);
        state.meter = {
          ok: true, updatedAt: Date.now(), raw: [fTotal, fL1, fL2, fL3],
          grid_l1_w: l1, grid_l2_w: l2, grid_l3_w: l3, grid_total_w: total,
          error: null,
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
      // Issue #13: zweite AC-PV-Position. Die Punkte sind AUS, solange
      // victron.acPvSource2 nicht gesetzt ist — pollPoint ueberspringt sie dann.
      pollPoint('acPv2L1W', cfg.points.acPv2L1W),
      pollPoint('acPv2L2W', cfg.points.acPv2L2W),
      pollPoint('acPv2L3W', cfg.points.acPv2L3W),
      pollPoint('acPvL2W', cfg.points.acPvL2W),
      pollPoint('acPvL3W', cfg.points.acPvL3W),
      pollPoint('gridSetpointW', cfg.points.gridSetpointW),
      pollPoint('minSocPct', cfg.points.minSocPct),
      pollPoint('maxDischargeW', cfg.points.maxDischargeW),
      pollPoint('selfConsumptionW', cfg.points.selfConsumptionW),
      ...buildDvControlReadbackPolls(cfg).map(([name, conf]) => pollDvControlReadback(name, conf))
    ]);

    const pvDc = Number(state.victron.pvPowerW || 0);
    // Issue #13: PV kann an zwei Positionen haengen (z. B. String-WR am
    // Netz-Eingang + WR am Verbraucher-Ausgang). Beide Bloecke fliessen in pvAc —
    // dieselbe Addition wie schon zwischen DC- und AC-PV. Ohne zweite Position
    // sind acPv2* null und der Term ist 0.
    const pvAc = Number(state.victron.acPvL1W || 0) + Number(state.victron.acPvL2W || 0) + Number(state.victron.acPvL3W || 0)
      + Number(state.victron.acPv2L1W || 0) + Number(state.victron.acPv2L2W || 0) + Number(state.victron.acPv2L3W || 0);
    state.victron.pvAcW = Number(pvAc.toFixed(3));
    state.victron.pvTotalW = Number((pvDc + pvAc).toFixed(3));

    const gridW = state.meter.grid_total_w || 0;
    const posImport = cfg.gridPositiveMeans === 'grid_import';
    state.victron.gridImportW = Math.max(0, posImport ? gridW : -gridW);
    state.victron.gridExportW = Math.max(0, posImport ? -gridW : gridW);

    // Echte DC-Akku-Leistung via SunSpec Model 160 (Profil-opt-in:
    // points.batteryPowerW.derive = 'm160_battery'; GEN24: MPPT-Eingang 3 =
    // Akku-Laden, 4 = Entladen — evcc-bestätigt, Zuordnung per Profil
    // konfigurierbar). Vorzeichen wie Victron: POSITIV = Laden (die
    // batteryCharge/DischargeW-Ableitung direkt darunter erwartet das).
    // Ein Block-Read pro Zyklus; SunSpec not-implemented (int16 0x8000) →
    // Punkt bleibt unangetastet statt einen falschen Wert zu stempeln.
    const bpConf = cfg.points?.batteryPowerW;
    if (bpConf?.derive === 'm160_battery' && state.ctrl?._sunspecM160 && transport.type !== 'mqtt') {
      try {
        const m160 = state.ctrl._sunspecM160;
        const chargeModule = Number(bpConf.chargeModule ?? 3);
        const dischargeModule = Number(bpConf.dischargeModule ?? 4);
        const needQty = 8 + Math.max(chargeModule, dischargeModule) * 20;
        const v = cfg.victron || {};
        const regs = await transport.mbRequest({
          fc: 3, host: v.host, port: v.port, unitId: v.unitId, timeoutMs: v.timeoutMs,
          address: m160.address, quantity: Math.min(needQty, m160.length)
        });
        const int16 = (w) => (Number(w) > 0x7fff ? Number(w) - 0x10000 : Number(w));
        const NOT_IMPL = -32768; // SunSpec int16 not-implemented (0x8000)
        const sfRaw = int16(regs[2]);   // DCW_SF @ Datenbereich +2
        const nModules = Number(regs[6]); // N @ +6
        if (nModules >= Math.max(chargeModule, dischargeModule) && sfRaw !== NOT_IMPL) {
          const dcwAt = (k) => int16(regs[8 + (k - 1) * 20 + 3]); // DCW @ Modul +3
          const chargeRaw = dcwAt(chargeModule);
          const dischargeRaw = dcwAt(dischargeModule);
          if (chargeRaw !== NOT_IMPL && dischargeRaw !== NOT_IMPL) {
            const sf = 10 ** sfRaw;
            state.victron.batteryPowerW = Number(((chargeRaw - dischargeRaw) * sf).toFixed(3));
            // T-0075-Frische: der Discharge-Floor keyt auf batteryPowerW —
            // ohne Stempel gälte der abgeleitete Wert sofort als stale.
            (state.victron.fieldUpdatedAt ??= {}).batteryPowerW = Date.now();
          }
        } else if (Date.now() - m160DeriveLogAt > 300000) {
          m160DeriveLogAt = Date.now();
          pushLog('m160_battery_unavailable', { nModules, sfRaw, chargeModule, dischargeModule });
        }
      } catch (e) {
        if (Date.now() - m160DeriveLogAt > 300000) {
          m160DeriveLogAt = Date.now();
          pushLog('m160_battery_read_error', { error: e?.message || String(e) });
        }
      }
    }

    const batP = Number(state.victron.batteryPowerW || 0);
    state.victron.batteryChargeW = Math.max(0, batP);
    state.victron.batteryDischargeW = Math.max(0, -batP);

    // Hauslast-Ableitung (Profil-opt-in via points.selfConsumptionW.derive =
    // 'pv_plus_grid'): Last = WR-AC-Ausgang + Netzbezug − Einspeisung. Gilt,
    // wenn pvPowerW den AC-Ausgang HINTER dem Meter misst (Fronius GEN24:
    // M113 W enthält den Akku-Anteil und ist netto nach Akku-Ladung — die
    // Bilanz stimmt dadurch auch bei Laden/Entladen/Netz-Ladung). Kein eigener
    // Register-Punkt nötig; verifiziert am GEN24 Symo 2026-07-18 gegen die
    // Solar API (P_Load 1332,9 W vs. abgeleitet 1332 W).
    if (cfg.points?.selfConsumptionW?.derive === 'pv_plus_grid'
      && state.meter.ok && state.victron.pvPowerW != null) {
      const inverterAcW = Number(state.victron.pvTotalW || 0);
      const derived = inverterAcW
        + Number(state.victron.gridImportW || 0)
        - Number(state.victron.gridExportW || 0);
      state.victron.selfConsumptionW = Number(Math.max(0, derived).toFixed(3));
    }

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

    // T-FREEZE Einfrier-Wächter: NACH allen Reads/Ableitungen, VOR dem Snapshot —
    // so trägt der Powerflow-Snapshot bereits den erkannten Einfrierer und die
    // zurückdatierten Frische-Stempel. Der Wächter wirft nie (eigenes try/catch
    // hier als letzte Bastion: er darf den Poll-Zyklus unter keinen Umständen
    // abbrechen, sonst nähme der Schutz die Steuerung mit).
    try {
      freezeWatchdog.tick();
      telemetryFreezeActive.set(state.victron?.freeze?.active ? 1 : 0);
    } catch (e) { pushLog('telemetry_freeze_watchdog_error', { error: e?.message || String(e) }, 'warn'); }

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
    // Quality-Review 2026-07-01: was a naked setInterval — a throw inside
    // persistEnergy would have silently killed the minutely energy-state
    // persist for the rest of the process lifetime.
    persistInterval = safeInterval('polling.persist-energy', persistEnergy, 60000);
  }

  function stop() {
    stopping = true;
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    if (persistInterval) { clearInterval(persistInterval); persistInterval = null; }
    persistEnergy();  // Final save before shutdown
  }

  return { start, stop, requestPoll };
}
