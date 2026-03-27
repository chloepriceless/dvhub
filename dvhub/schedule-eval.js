// schedule-eval.js -- Schedule evaluation brain with timer lifecycle.
// Extracted from server.js (Phase 4, Plan 02).
// Controls hardware via injected transport: applyDvVictronControl, applyControlTarget.
// Evaluates schedule rules every ~15 seconds, writes control signals to Victron inverter.

import { localMinutesOfDay } from './server-utils.js';
import {
  autoDisableStopSocScheduleRules,
  autoDisableExpiredScheduleRules,
  scheduleMatch
} from './schedule-runtime.js';
import { isSmallMarketAutomationRule, SLOT_DURATION_MS } from './market-automation-builder.js';

export function createScheduleEvaluator(ctx) {
  const { state, getCfg, transport, pushLog, telemetrySafeWrite, persistConfig } = ctx;

  let stopping = false;
  let evalTimeout = null;

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  function toRawForWrite(value, conf) {
    const scale = Number(conf.scale ?? 1);
    const offset = Number(conf.offset ?? 0);
    if (!Number.isFinite(scale) || scale === 0) throw new Error('invalid write scale');
    const engineeringValue = Number(value);
    if (!Number.isFinite(engineeringValue)) throw new Error('invalid write value');

    const writeTypeRaw = String(conf.writeType || (conf.signed ? 'int16' : 'uint16')).toLowerCase();
    const writeType = writeTypeRaw === 'signed' || writeTypeRaw === 's16'
      ? 'int16'
      : writeTypeRaw === 'unsigned' || writeTypeRaw === 'u16'
        ? 'uint16'
        : writeTypeRaw;
    const wordOrderRaw = String(conf.wordOrder || 'be').toLowerCase();
    const wordOrder = (wordOrderRaw === 'le' || wordOrderRaw === 'little' || wordOrderRaw === 'swapped' || wordOrderRaw === 'swap') ? 'le' : 'be';
    const scaled = Math.round((engineeringValue - offset) / scale);

    if (writeType === 'int16') {
      if (scaled < -32768 || scaled > 32767) throw new Error(`int16 range exceeded: ${scaled}`);
      const b = Buffer.allocUnsafe(2);
      b.writeInt16BE(scaled, 0);
      const raw = b.readUInt16BE(0);
      return { raw, words: [raw], scaled, writeType, wordOrder: 'be' };
    }

    if (writeType === 'uint16') {
      if (scaled < 0 || scaled > 65535) throw new Error(`uint16 range exceeded: ${scaled}`);
      const raw = scaled & 0xffff;
      return { raw, words: [raw], scaled, writeType, wordOrder: 'be' };
    }

    if (writeType === 'int32') {
      if (scaled < -2147483648 || scaled > 2147483647) throw new Error(`int32 range exceeded: ${scaled}`);
      const b = Buffer.allocUnsafe(4);
      b.writeInt32BE(scaled, 0);
      const words = [b.readUInt16BE(0), b.readUInt16BE(2)];
      if (wordOrder === 'le') words.reverse();
      return { raw: words[0], words, scaled, writeType, wordOrder };
    }

    if (writeType === 'uint32') {
      if (scaled < 0 || scaled > 4294967295) throw new Error(`uint32 range exceeded: ${scaled}`);
      const b = Buffer.allocUnsafe(4);
      b.writeUInt32BE(scaled, 0);
      const words = [b.readUInt16BE(0), b.readUInt16BE(2)];
      if (wordOrder === 'le') words.reverse();
      return { raw: words[0], words, scaled, writeType, wordOrder };
    }

    throw new Error(`unsupported writeType: ${conf.writeType}`);
  }

  function effectiveTargetValue(target) {
    const cfg = getCfg();
    const now = Date.now();
    const mod = localMinutesOfDay(new Date(now), cfg.schedule.timezone);

    const hit = state.schedule.rules.find((r) => {
      if (r.target !== target || !scheduleMatch(r, mod)) return false;
      // SMA rules carry absolute slot timestamps -- enforce them so a rule
      // generated for "tomorrow 03:00" does not accidentally fire today at 03:00.
      if (isSmallMarketAutomationRule(r) && r.slotTs != null) {
        const slotTs = Number(r.slotTs);
        const slotEndTs = Number(r.slotEndTs) || (slotTs + SLOT_DURATION_MS);
        if (Number.isFinite(slotTs) && (now < slotTs || now >= slotEndTs)) return false;
      }
      return true;
    });
    if (hit) { hit._wasActive = true; delete state.schedule.manualOverride[target]; return { value: Number(hit.value), source: `rule:${hit.id || 'unnamed'}`, rule: hit }; }

    const mo = state.schedule.manualOverride[target];
    if (mo && (Date.now() - mo.at) < (cfg.schedule.manualOverrideTtlMs || 300000)) {
      return { value: Number(mo.value), source: 'manual_override', rule: null };
    }
    delete state.schedule.manualOverride[target];

    if (target === 'gridSetpointW' && state.schedule.config.defaultGridSetpointW != null) return { value: Number(state.schedule.config.defaultGridSetpointW), source: 'default', rule: null };
    if (target === 'chargeCurrentA' && state.schedule.config.defaultChargeCurrentA != null) return { value: Number(state.schedule.config.defaultChargeCurrentA), source: 'default', rule: null };
    if (target === 'feedExcessDcPv') return { value: Number(state.schedule.config.defaultFeedExcessDcPv ?? 1), source: 'default', rule: null };
    return { value: null, source: 'none', rule: null };
  }

  // ---------------------------------------------------------------------------
  // Public functions
  // ---------------------------------------------------------------------------

  async function applyDvVictronControl(feedIn) {
    const cfg = getCfg();
    const dc = cfg.dvControl;
    if (!dc?.enabled) return;
    const results = {};

    // Feed excess DC-coupled PV into grid: 1 = feed, 0 = block
    if (dc.feedExcessDcPv?.enabled) {
      const val = feedIn ? 1 : 0;
      try {
        if (transport.type === 'mqtt') {
          await transport.mqttWrite('feedExcessDcPv', val);
        } else {
          await transport.mbWriteSingle({
            host: dc.feedExcessDcPv.host, port: dc.feedExcessDcPv.port,
            unitId: dc.feedExcessDcPv.unitId, address: dc.feedExcessDcPv.address,
            value: val, timeoutMs: dc.feedExcessDcPv.timeoutMs
          });
        }
        results.feedExcessDcPv = { ok: true, value: val };
        pushLog('dv_victron_write', { register: 'feedExcessDcPv', address: dc.feedExcessDcPv.address, value: val, feedIn });
      } catch (e) {
        results.feedExcessDcPv = { ok: false, error: e.message };
        pushLog('dv_victron_write_error', { register: 'feedExcessDcPv', error: e.message });
      }
    }

    // Don't feed excess AC-coupled PV into grid: 1 = block, 0 = allow
    if (dc.dontFeedExcessAcPv?.enabled) {
      const val = feedIn ? 0 : 1;
      try {
        if (transport.type === 'mqtt') {
          await transport.mqttWrite('dontFeedExcessAcPv', val);
        } else {
          await transport.mbWriteSingle({
            host: dc.dontFeedExcessAcPv.host, port: dc.dontFeedExcessAcPv.port,
            unitId: dc.dontFeedExcessAcPv.unitId, address: dc.dontFeedExcessAcPv.address,
            value: val, timeoutMs: dc.dontFeedExcessAcPv.timeoutMs
          });
        }
        results.dontFeedExcessAcPv = { ok: true, value: val };
        pushLog('dv_victron_write', { register: 'dontFeedExcessAcPv', address: dc.dontFeedExcessAcPv.address, value: val, feedIn });
      } catch (e) {
        results.dontFeedExcessAcPv = { ok: false, error: e.message };
        pushLog('dv_victron_write_error', { register: 'dontFeedExcessAcPv', error: e.message });
      }
    }

    state.ctrl.dvControl = { feedIn, ...results, at: Date.now() };
  }

  async function applyControlTarget(target, value, source) {
    const cfg = getCfg();
    const conf = cfg.controlWrite[target] || cfg.dvControl?.[target];
    if (!conf?.enabled) return { ok: false, error: 'write target not enabled in config' };
    if (Number(conf.address) === 0 && conf.allowAddressZero !== true) return { ok: false, error: 'unsafe address 0 blocked (set allowAddressZero=true to override)' };

    const prev = state.schedule.lastWrite[target];
    if (prev != null && Number(prev.value) === Number(value)) {
      state.schedule.active[target] = { value, source, at: Date.now(), skipped: true };
      return { ok: true, skipped: true };
    }

    try {
      let encoded, words, fc;
      if (transport.type === 'mqtt') {
        // MQTT: Engineering-Wert direkt schreiben (kein Register-Encoding)
        await transport.mqttWrite(target, value);
        encoded = { raw: value, scaled: value, writeType: 'mqtt', wordOrder: 'n/a' };
        words = [value];
        fc = 0;
      } else {
        // Modbus: Wert in Register-Format kodieren
        encoded = toRawForWrite(value, conf);
        words = Array.isArray(encoded.words) && encoded.words.length ? encoded.words : [encoded.raw];
        fc = Number(conf.fc || (words.length > 1 ? 16 : 6));

        if (fc === 6) {
          if (words.length !== 1) throw new Error(`fc6 only supports one register, got ${words.length}`);
          await transport.mbWriteSingle({ host: conf.host, port: conf.port, unitId: conf.unitId, address: conf.address, value: words[0], timeoutMs: conf.timeoutMs });
        } else if (fc === 16) {
          await transport.mbWriteMultiple({ host: conf.host, port: conf.port, unitId: conf.unitId, address: conf.address, values: words, timeoutMs: conf.timeoutMs });
        } else {
          throw new Error(`unsupported write fc: ${fc}`);
        }
      }

      state.schedule.lastWrite[target] = {
        value,
        source,
        raw: encoded.raw,
        words,
        scaled: encoded.scaled,
        writeType: encoded.writeType,
        fc,
        address: conf.address,
        at: Date.now()
      };
      state.schedule.active[target] = { value, source, at: Date.now() };
      pushLog('control_write', {
        target,
        value,
        raw: encoded.raw,
        words,
        scaled: encoded.scaled,
        writeType: encoded.writeType,
        wordOrder: encoded.wordOrder,
        fc,
        address: conf.address,
        source
      });
      telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
        eventType: 'control_write',
        target,
        valueNum: Number(value),
        reason: source,
        source: source.includes('optimization') ? 'optimizer' : 'runtime',
        meta: {
          raw: encoded.raw,
          words,
          scaled: encoded.scaled,
          writeType: encoded.writeType,
          fc,
          address: conf.address
        }
      }));
      return { ok: true, raw: encoded.raw, words, scaled: encoded.scaled, writeType: encoded.writeType, wordOrder: encoded.wordOrder, fc, address: conf.address };
    } catch (e) {
      pushLog('control_write_error', { target, value, source, error: e.message });
      telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
        eventType: 'control_write_error',
        target,
        valueNum: Number.isFinite(Number(value)) ? Number(value) : null,
        reason: source,
        source: 'runtime',
        meta: { error: e.message }
      }));
      return { ok: false, error: e.message };
    }
  }

  async function evaluateSchedule() {
    const cfg = getCfg();
    const now = Date.now();
    const nowMin = localMinutesOfDay(new Date(now), cfg.schedule.timezone);
    await ctx.regenerateSmallMarketAutomationRules({ now });
    state.schedule.lastEvalAt = now;

    const stopSocDisable = autoDisableStopSocScheduleRules({
      rules: state.schedule.rules,
      nowMin,
      batterySocPct: state.victron.soc
    });
    if (stopSocDisable.changed) {
      state.schedule.rules = stopSocDisable.rules;
      for (const ruleId of stopSocDisable.disabledRuleIds) {
        pushLog('schedule_stop_soc_reached', { id: ruleId, target: 'gridSetpointW', soc: state.victron.soc });
      }
      persistConfig();
    }

    const npp = cfg.dvControl?.negativePriceProtection;
    const priceNow = ctx.epexNowNext()?.current;
    const priceNegative = npp?.enabled && priceNow && Number(priceNow.ct_kwh) < 0;

    // --- DC Export Mode: dynamischer Grid Setpoint = -(DC-PV - Puffer) ---
    // Nur fuer DC-gekoppelte PV (MPPT auf DC-Seite). Setzt den Grid Setpoint
    // so, dass der Multi die gesamte DC-PV-Produktion einspeist.
    // Netto-Batteriestrom bleibt bei ca. 0A.
    //
    // dcExportMode: NUR aktiv wenn eine Schedule-Regel target='dcExportMode', value=1 matcht.
    // Config-Flags (enabled, priceThresholdCtKwh) werden nur als Parameter genutzt,
    // nicht zur Aktivierung. Ohne aktive Schedule-Regel bleibt dcExportMode AUS.
    const dcScheduleRule = state.schedule.rules.find(r => r.target === 'dcExportMode' && r.enabled !== false && scheduleMatch(r, nowMin));
    let dcExportActive = dcScheduleRule != null && Number(dcScheduleRule.value) === 1;
    // SOC-Sicherung: Wenn Akku unter Ziel-SOC UND weniger als X Stunden bis Abend-Peak,
    // DC-Export deaktivieren damit der Akku noch laden kann.
    const dcTargetSoc = Number(cfg.dcExportMode?.targetSocPct ?? 90);
    const dcDeadlineHour = Number(cfg.dcExportMode?.chargeDeadlineHour ?? 17);
    const currentSoc = Number(state.victron.soc ?? 0);
    const currentHour = new Date(now).getHours();
    if (dcExportActive && currentSoc < dcTargetSoc && currentHour >= (dcDeadlineHour - 2)) {
      // Weniger als 2 Stunden bis Deadline und SOC noch nicht erreicht -> laden lassen
      dcExportActive = false;
      if (!state.ctrl._dcSocGuardLogged) {
        pushLog('dc_export_soc_guard', { currentSoc, dcTargetSoc, dcDeadlineHour, currentHour });
        state.ctrl._dcSocGuardLogged = true;
      }
    } else {
      state.ctrl._dcSocGuardLogged = false;
    }
    if (dcExportActive) {
      // Negativpreis-Schutz: bei Preis < 0 ct/kWh Export pausieren (0 ct/kWh = weiter exportieren)
      const currentPrice = priceNow ? Number(priceNow.ct_kwh) : null;
      const priceBlocked = currentPrice !== null && currentPrice < 0;

      if (priceBlocked) {
        // Export pausiert wegen negativem Preis -- kein Setpoint schreiben
        if (!state.ctrl._dcExportPriceBlockLogged) {
          pushLog('pv_export_price_blocked', { currentPrice });
          state.ctrl._dcExportPriceBlockLogged = true;
        }
      } else {
        state.ctrl._dcExportPriceBlockLogged = false;
        const pvW = Math.max(0, Number(state.victron.pvTotalW || state.victron.pvPowerW || 0));
        const bufferW = Number(cfg.dcExportMode?.bufferW ?? 100);
        if (pvW > 50) {
          // Negativer Setpoint = Einspeisung. Export = Gesamt-PV minus Puffer.
          const exportW = Math.round(-(pvW - bufferW));
          const prev = state.schedule.active.gridSetpointW;
          const prevVal = prev?.value;
          // Nur schreiben wenn sich der Wert merklich aendert (>50W Differenz) oder alle 60s
          const timeSinceLastWrite = now - (state.ctrl._dcExportLastWriteAt || 0);
          if (prevVal == null || Math.abs(exportW - prevVal) > 50 || timeSinceLastWrite > 60000) {
            await applyControlTarget('gridSetpointW', exportW, 'dc_export_mode');
            state.ctrl._dcExportLastWriteAt = now;
            if (!state.ctrl._dcExportLogged) {
              pushLog('dc_export_mode_active', { pvW, exportW, bufferW, currentPrice });
              state.ctrl._dcExportLogged = true;
            }
          }
        } else {
          // Kein PV: Zurueck zum Default Setpoint
          if (state.ctrl._dcExportLogged) {
            pushLog('dc_export_mode_idle', { pvW });
            state.ctrl._dcExportLogged = false;
          }
        }
      }
    } else if (state.ctrl._dcExportLogged) {
      pushLog('dc_export_mode_off', {});
      state.ctrl._dcExportLogged = false;
    }

    for (const target of ['gridSetpointW', 'chargeCurrentA']) {
      const eff = effectiveTargetValue(target);
      if (eff.value == null) continue;

      // Bei negativen Preisen: DC/AC Einspeisung blockieren + Grid Setpoint begrenzen
      if (target === 'gridSetpointW' && priceNegative) {
        const limit = Number(npp.gridSetpointW ?? -40);
        const prev = state.ctrl.negativePriceActive;
        if (!prev) {
          pushLog('negative_price_protection_on', { price: priceNow.ct_kwh, limit });
          telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
            eventType: 'negative_price_protection_on',
            target: 'dv_control',
            valueNum: priceNow.ct_kwh,
            reason: 'negative_price',
            source: 'runtime',
            meta: { price: priceNow.ct_kwh, limit }
          }));
        }
        state.ctrl.negativePriceActive = true;
        // Victron DC/AC Abregelung immer bei negativen Preisen
        if (cfg.dvControl?.enabled && !state.ctrl.forcedOff) {
          applyDvVictronControl(false);
        }
        if (eff.value < limit) {
          await applyControlTarget(target, limit, 'negative_price_protection');
          continue;
        }
      }

      // Skip gridSetpointW if export mode is actively controlling it
      if (target === 'gridSetpointW' && dcExportActive && Math.max(0, Number(state.victron.pvTotalW || state.victron.pvPowerW || 0)) > 50) {
        continue;
      }
      await applyControlTarget(target, eff.value, eff.source);
    }

    // feedExcessDcPv: schedule-gesteuerte DC-Einspeisung (+ dontFeedExcessAcPv invers)
    if (cfg.dvControl?.enabled) {
      let dcFeedIn = false;
      let dcSource = 'default_off';
      // DV forcedOff und negative Preise blockieren DC-Einspeisung immer
      if (state.ctrl.forcedOff) {
        dcSource = 'dv_forced_off';
      } else if (priceNegative) {
        dcSource = 'negative_price_protection';
      } else {
        const eff = effectiveTargetValue('feedExcessDcPv');
        dcFeedIn = eff.value != null && Number(eff.value) === 1;
        dcSource = eff.source;
      }
      await applyDvVictronControl(dcFeedIn);
      state.schedule.active.feedExcessDcPv = { value: dcFeedIn ? 1 : 0, source: dcSource, at: Date.now() };
    }

    // Auto-Deaktivierung: Regeln die aktiv waren aber deren Zeitfenster abgelaufen ist
    const autoDisable = autoDisableExpiredScheduleRules(state.schedule.rules, nowMin);
    if (autoDisable.changed) {
      for (const rule of state.schedule.rules) {
        if (!rule?._wasActive || rule.enabled === false || scheduleMatch(rule, nowMin)) continue;
        pushLog('schedule_auto_disabled', { id: rule.id, target: rule.target });
      }
      state.schedule.rules = autoDisable.rules;
      persistConfig();
    }

    // Negative-Preis-Schutz aufheben wenn Preis wieder positiv
    if (state.ctrl.negativePriceActive && !priceNegative) {
      state.ctrl.negativePriceActive = false;
      pushLog('negative_price_protection_off', { price: priceNow?.ct_kwh });
      telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
        eventType: 'negative_price_protection_off',
        target: 'dv_control',
        valueNum: priceNow?.ct_kwh,
        reason: 'price_positive',
        source: 'runtime',
        meta: { price: priceNow?.ct_kwh }
      }));
      // feedExcessDcPv: wird oben im feedExcessDcPv-Block schedule-basiert gesetzt
    }

    ctx.onEvalComplete?.();
  }

  // ---------------------------------------------------------------------------
  // Timer lifecycle (modeled on polling.js)
  // ---------------------------------------------------------------------------

  function scheduleEvaluateLoop() {
    const cfg = getCfg();
    evalTimeout = setTimeout(async () => {
      try { await evaluateSchedule(); }
      catch (e) { pushLog('schedule_eval_error', { error: e.message }); }
      if (!stopping) scheduleEvaluateLoop();
    }, Math.max(5000, Number(cfg.schedule.evaluateMs || 15000)));
  }

  function start() {
    stopping = false;
    evaluateSchedule().catch(e => pushLog('schedule_eval_error', { error: e.message }));
    scheduleEvaluateLoop();
  }

  function stop() {
    stopping = true;
    if (evalTimeout) { clearTimeout(evalTimeout); evalTimeout = null; }
  }

  return { evaluateSchedule, applyControlTarget, applyDvVictronControl, start, stop };
}
