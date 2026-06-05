// schedule-eval.js -- Schedule evaluation brain with timer lifecycle.
// Extracted from server.js (Phase 4, Plan 02).
// Controls hardware via injected transport: applyDvVictronControl, applyControlTarget.
// Evaluates schedule rules every ~15 seconds, writes control signals to Victron inverter.

import { localMinutesOfDay, victronFieldAgeMs, victronFieldStale } from './server-utils.js';
import {
  autoDisableStopSocScheduleRules,
  autoDisableExpiredScheduleRules,
  scheduleMatch
} from './schedule-runtime.js';
import { isSmallMarketAutomationRule, SLOT_DURATION_MS } from './market-automation-builder.js';
// Plan 09-07: safeInterval reserved import — schedule-eval uses a setTimeout
// chain (evalTimeout) not setInterval. Import kept so future periodic checks
// inherit the helper. Auditable via grep "from './services/safe-async.js'".
// eslint-disable-next-line no-unused-vars
import { safeInterval } from './services/safe-async.js';

// D-18 live runtime Akku-Hard-Limit clamp — hysteresis dead-band (W).
// Within [akkuHardLimitW - HYST, akkuHardLimitW + HYST] the clamp does not
// change the setpoint, so a measured battery discharge hovering near the
// limit cannot flap the Stage-2 LEEREN gridSetpointW every control cycle.
const STAGE2_CLAMP_HYSTERESIS_W = 500;

// T-0075: per-target classifier for the universal discharge floor. The "enables
// battery discharge" direction is NOT uniform across write targets, so a naive
// `value < 0` would be wrong for maxDischargeW. Returns the safe "no discharge"
// hold value when `value` would enable/force battery discharge for `target`,
// else null (= not a discharge-enabling write → the floor leaves it untouched).
//   gridSetpointW (2700, int16): negative = grid export / discharge   → hold 0
//   chargeCurrentA (2705, int16): charge current positive; negative = discharge
//     direction (a positive charge command is never an over-drain risk)  → hold 0
//   maxDischargeW (2704, int16): 0 = no discharge, positive = cap in W, -1 =
//     unlimited; ANY non-zero value ENABLES discharge                    → hold 0
// Verified against config-model.js controlWrite defaults (see T-0075-DESIGN E1).
function dischargeFloorHold(target, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (target === 'gridSetpointW' || target === 'chargeCurrentA') return v < 0 ? 0 : null;
  if (target === 'maxDischargeW') return v !== 0 ? 0 : null;
  return null;
}

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
    const optimizerEnabled = cfg.optimizer?.enabled ?? false;
    const allowGridCharge = cfg.optimizer?.allowGridCharge ?? false;
    const allowGridDischarge = cfg.optimizer?.allowGridDischarge ?? false;
    const now = Date.now();
    const mod = localMinutesOfDay(new Date(now), cfg.schedule.timezone);

    const hit = state.schedule.rules.find((r) => {
      if (r.target !== target || !scheduleMatch(r, mod)) return false;

      // ── Optimizer rule enforcement (EEG-relevant) ───────────────────
      // Skip ALL optimizer rules when optimizer is disabled.
      // When optimizer IS enabled, enforce grid-permission flags:
      //   - Positive gridSetpointW (>0) = grid import (Netzladen) → needs allowGridCharge
      //   - Negative gridSetpointW (<0) = grid export (Netzentladung) → needs allowGridDischarge
      // User rules and SMA (Börsenautomatik) are never blocked by these flags.
      // Defence-in-depth: the canonical EEG/§14a gate now lives in applyControlTarget
      // (Plan 08-06 Task 1) and catches ALL caller sources at write time. This filter
      // short-circuits optimizer rules earlier so they never reach the hardware-write path.
      if (r.source === 'forecast_optimizer') {
        if (!optimizerEnabled) return false;
        if (r.target === 'gridSetpointW') {
          const val = Number(r.value);
          if (val > 0 && !allowGridCharge) return false;   // Netzladen blocked
          if (val < 0 && !allowGridDischarge) return false; // Netzentladung blocked
        }
      }

      // SMA rules carry absolute slot timestamps -- enforce them so a rule
      // generated for "tomorrow 03:00" does not accidentally fire today at 03:00.
      if ((isSmallMarketAutomationRule(r) || r.source === 'forecast_optimizer') && r.slotTs != null) {
        const slotTs = Number(r.slotTs);
        const slotEndTs = Number(r.slotEndTs) || (slotTs + SLOT_DURATION_MS);
        if (Number.isFinite(slotTs) && (now < slotTs || now >= slotEndTs)) return false;
      }
      return true;
    });
    if (hit) {
      hit._wasActive = true;
      // A transient scheduled rule wins over a manual override, but must NOT
      // erase a PERSISTENT override (T-0002) — that one resumes when the rule's
      // window ends. Non-persistent overrides are still consumed as before.
      const mo0 = state.schedule.manualOverride[target];
      if (mo0 && mo0.persistent !== true) delete state.schedule.manualOverride[target];
      return { value: Number(hit.value), source: `rule:${hit.id || 'unnamed'}`, rule: hit };
    }

    const mo = state.schedule.manualOverride[target];
    if (mo) {
      // T-0002 persistent override: a `persistent` override never expires — it
      // holds X kW (e.g. a continuous feed-in setpoint) until explicitly cleared
      // via POST /api/control/write {clear:true}. A normal override still expires
      // after manualOverrideTtlMs.
      const ttlMs = cfg.schedule.manualOverrideTtlMs || 300000;
      if (mo.persistent === true || (now - mo.at) < ttlMs) {
        return {
          value: Number(mo.value),
          source: mo.persistent === true ? 'manual_override_persistent' : 'manual_override',
          rule: null
        };
      }
      delete state.schedule.manualOverride[target];
    }

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

    // Only write when feedIn state actually changes (first call: _lastDvFeedIn is undefined → always writes once)
    if (state.ctrl._lastDvFeedIn === feedIn) return;

    const results = {};
    // T-0076 (P0-2): advance the change-detection cache ONLY after the hardware
    // write actually succeeds. The old code set _lastDvFeedIn BEFORE the await,
    // so a failed write was cached as if applied and the next cycle short-circuited
    // → the write was never retried. Worst case: a failed "block feed-in" (feedIn
    // = false) on a negative price kept the DC/AC PV exporting against the price.
    // Now any write failure leaves the cache at its previous value so the next
    // call re-attempts. Partial success also re-attempts (idempotent re-write).
    let allOk = true;

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
        allOk = false;
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
        allOk = false;
        pushLog('dv_victron_write_error', { register: 'dontFeedExcessAcPv', error: e.message });
      }
    }

    state.ctrl.dvControl = { feedIn, ...results, at: Date.now() };
    // Cache the applied state only on a fully successful write (see above).
    if (allOk) state.ctrl._lastDvFeedIn = feedIn;
  }

  async function applyControlTarget(target, value, source) {
    const cfg = getCfg();
    const conf = cfg.controlWrite[target] || cfg.dvControl?.[target];
    if (!conf?.enabled) return { ok: false, error: 'write target not enabled in config' };
    if (Number(conf.address) === 0 && conf.allowAddressZero !== true) return { ok: false, error: 'unsafe address 0 blocked (set allowAddressZero=true to override)' };

    // === EEG/§14a legal gate — applies to ALL callers (schedule rules, manual control,
    // dc-export, eos/emhass optimizer, negative-price triggers). Source of truth:
    // cfg.optimizer.allowGridCharge / allowGridDischarge.
    // User memory: these flags are legally relevant — never auto-flip, never flip for demos.
    // Runs BEFORE the prev-value short-circuit so a flag flip between identical writes
    // cannot produce a silently-skipped illegal write.
    if (target === 'gridSetpointW') {
      const numericValue = Number(value);
      const allowGridCharge = cfg.optimizer?.allowGridCharge ?? false;
      const allowGridDischarge = cfg.optimizer?.allowGridDischarge ?? false;
      if (numericValue > 0 && !allowGridCharge) {
        pushLog('control_write_rejected', { target, value: numericValue, source, reason: 'grid_charge_not_allowed' });
        return { ok: false, error: 'grid_charge_not_allowed' };
      }
      if (numericValue < 0 && !allowGridDischarge) {
        pushLog('control_write_rejected', { target, value: numericValue, source, reason: 'grid_discharge_not_allowed' });
        return { ok: false, error: 'grid_discharge_not_allowed' };
      }
    }
    // === end EEG/§14a gate ===

    // === T-0075 universal discharge floor (telemetry-freshness + hard SoC floor) ===
    // Chokepoint floor: EVERY discharge-enabling hardware write (optimizer,
    // schedule rule, manual, persistent override, EOS/EMHASS, negative-price, and
    // API-driven maxDischargeW/chargeCurrentA) passes here. A discharge is
    // suppressed when SoC is UNKNOWN, STALE, or at/below the hard floor. Closes
    // T-0001 P0-1: the per-rule stopSoc + D-18 floors check only null/non-finite,
    // NOT age — but polling.js keeps the last SoC on a failed read, so a frozen
    // finite SoC would pass them (over-drain on a comms fault). soc's per-field
    // success timestamp (fieldUpdatedAt.soc, set ONLY on a successful poll, part 1
    // 732ad07) gives real freshness. The "discharge direction" is per-target and
    // NOT uniform (see dischargeFloorHold / T-0075-DESIGN E1). Fail-safe:
    // unknown/stale telemetry => no forced/enabled discharge.
    const safeHold = dischargeFloorHold(target, value);
    if (safeHold !== null) {
      const socRaw = state.victron.soc;
      const soc = Number(socRaw);
      const floorPct = Number(cfg.optimizer?.hardFloorSocPct ?? 5);
      const maxAgeMs = Number(cfg.victron?.telemetryMaxAgeMs ?? 90000);
      const unknown = socRaw == null || !Number.isFinite(soc);
      const stale = victronFieldStale(state, 'soc', maxAgeMs);
      if (unknown || stale || soc <= floorPct) {
        const reason = unknown ? 'soc_unknown' : stale ? 'soc_stale' : 'below_hard_floor';
        pushLog('control_discharge_floor', {
          target, requested: Number(value), soc: unknown ? null : soc,
          ageMs: victronFieldAgeMs(state, 'soc'), floorPct, reason
        });
        value = safeHold;
      }
    }
    // === end T-0075 discharge floor ===

    // === T-0002 Reg-2700 keepalive ==========================================
    // Victron's ESS AcPowerSetpoint (reg 2700) reverts if it is not re-asserted
    // periodically (GX/Venus reboot, dbus/MQTT reconnect, internal watchdog).
    // Without a keepalive an identical-value write is short-circuited forever,
    // so a silently-lost setpoint would never be re-written. keepaliveMs > 0
    // forces a re-write once that long has elapsed since the last REAL write.
    // Config-driven and default-OFF (0) so existing setups behave identically:
    //   per-target  controlWrite.<target>.keepaliveMs   (applies to any target)
    //   global      schedule.controlKeepaliveMs         (gridSetpointW only — the
    //               only register with a Venus-side watchdog; chargeCurrentA /
    //               minSocPct are persistent settings that do not time out).
    const keepaliveMs = Number(
      conf.keepaliveMs
      ?? (target === 'gridSetpointW' ? cfg.schedule?.controlKeepaliveMs : 0)
      ?? 0
    );
    const prev = state.schedule.lastWrite[target];
    let isKeepalive = false;
    if (prev != null && Number(prev.value) === Number(value)) {
      const sinceLastWriteMs = Date.now() - (Number(prev.at) || 0);
      if (!(keepaliveMs > 0 && sinceLastWriteMs >= keepaliveMs)) {
        // Unchanged and no keepalive due → HOLD (skip the hardware write).
        state.schedule.active[target] = {
          value, source, at: Date.now(), skipped: true,
          reason: 'unchanged', heldSinceMs: sinceLastWriteMs
        };
        // Transparency (T-0002): surface a held write once per (target,value)
        // transition so the operator can see "held at X" without log spam.
        if (state.schedule._lastSkipKey?.[target] !== String(value)) {
          pushLog('control_write_skipped', { target, value, source, reason: 'unchanged', heldSinceMs: sinceLastWriteMs });
          state.schedule._lastSkipKey = { ...(state.schedule._lastSkipKey || {}), [target]: String(value) };
        }
        return { ok: true, skipped: true, reason: 'unchanged', heldSinceMs: sinceLastWriteMs };
      }
      // keepalive due → fall through and re-assert the identical value.
      isKeepalive = true;
    }
    // A real write (changed value or keepalive) resets this target's skip throttle.
    if (state.schedule._lastSkipKey) delete state.schedule._lastSkipKey[target];
    // === end T-0002 keepalive ===============================================

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
        at: Date.now(),
        keepalive: isKeepalive
      };
      state.schedule.active[target] = { value, source, at: Date.now(), keepalive: isKeepalive };
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
        source,
        keepalive: isKeepalive
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
      return { ok: true, raw: encoded.raw, words, scaled: encoded.scaled, writeType: encoded.writeType, wordOrder: encoded.wordOrder, fc, address: conf.address, keepalive: isKeepalive };
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

    // Purge optimizer rules that violate current config.
    // - optimizer disabled: remove ALL optimizer rules
    // - optimizer enabled but allowGridCharge=false: remove positive gridSetpointW rules (Netzladen)
    // - optimizer enabled but allowGridDischarge=false: remove negative gridSetpointW rules (Netzentladung)
    const optimizerEnabled = cfg.optimizer?.enabled ?? false;
    const allowGridCharge = cfg.optimizer?.allowGridCharge ?? false;
    const allowGridDischarge = cfg.optimizer?.allowGridDischarge ?? false;
    {
      const before = state.schedule.rules.length;
      state.schedule.rules = state.schedule.rules.filter(r => {
        if (r.source !== 'forecast_optimizer') return true; // keep non-optimizer rules
        if (!optimizerEnabled) return false; // optimizer off → purge all
        if (r.target === 'gridSetpointW') {
          const val = Number(r.value);
          if (val > 0 && !allowGridCharge) return false;   // Netzladen verboten
          if (val < 0 && !allowGridDischarge) return false; // Netzentladung verboten
        }
        return true;
      });
      const removed = before - state.schedule.rules.length;
      if (removed > 0) {
        const reason = !optimizerEnabled ? 'optimizer_disabled'
          : !allowGridCharge && !allowGridDischarge ? 'grid_charge_and_discharge_blocked'
          : !allowGridCharge ? 'grid_charge_blocked' : 'grid_discharge_blocked';
        pushLog('optimizer_rules_purged', { removed, reason });
        persistConfig();
      }
    }

    await ctx.regenerateSmallMarketAutomationRules({ now });
    state.schedule.lastEvalAt = now;

    // T-0075: stale SoC telemetry latches active stop-SoC rules off (fail-safe),
    // keyed on soc's per-field success timestamp — not the frozen value.
    const stopSocStale = victronFieldStale(state, 'soc', Number(cfg.victron?.telemetryMaxAgeMs ?? 90000));
    const stopSocDisable = autoDisableStopSocScheduleRules({
      rules: state.schedule.rules,
      nowMin,
      batterySocPct: state.victron.soc,
      socStale: stopSocStale
    });
    if (stopSocDisable.changed) {
      state.schedule.rules = stopSocDisable.rules;
      for (const ruleId of stopSocDisable.disabledRuleIds) {
        pushLog('schedule_stop_soc_reached', {
          id: ruleId, target: 'gridSetpointW', soc: state.victron.soc,
          reason: stopSocStale ? 'soc_stale' : 'below_stop_soc'
        });
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
    const dcChargeGuardHours = Number(cfg.dcExportMode?.chargeGuardHours ?? 2);
    const currentSoc = Number(state.victron.soc ?? 0);
    const currentHour = new Date(now).getHours();
    if (dcExportActive && currentSoc < dcTargetSoc && currentHour >= (dcDeadlineHour - dcChargeGuardHours)) {
      // Weniger als chargeGuardHours Stunden bis Deadline und SOC noch nicht erreicht -> laden lassen
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

      // === T-0002 safety: SoC floor for a PERSISTENT discharge override ========
      // A persistent override has no TTL and is invisible to both the per-rule
      // stopSocPct floor (autoDisableStopSocScheduleRules — rules only) and the
      // D-18 Akku clamp (gated on eff.rule.stage2Phase, but an override has
      // rule:null). Left unguarded it would force-discharge down to the bare
      // Victron hardware min-SoC — exactly the 2026-05-22 overnight-drain class.
      // Floor it on measured SoC; fail-safe (suppress) when SoC is unknown.
      // Scoped to persistent overrides only — normal overrides are TTL-bounded.
      if (target === 'gridSetpointW'
          && eff.source === 'manual_override_persistent'
          && Number(eff.value) < 0) {
        const floorPct = Number(cfg.schedule?.manualOverrideMinSocPct ?? 10);
        const socRaw = state.victron.soc;
        const soc = Number(socRaw);
        const socKnown = socRaw != null && Number.isFinite(soc);
        if (!socKnown || soc <= floorPct) {
          // Hold (0 = no forced grid setpoint → self-consumption), do not discharge.
          await applyControlTarget('gridSetpointW', 0, 'manual_override_soc_floor');
          if (!state.ctrl._persistOverrideSocFloorLogged) {
            pushLog('manual_override_soc_floor', { soc: socKnown ? soc : null, floorPct, suppressed: Number(eff.value) });
            state.ctrl._persistOverrideSocFloorLogged = true;
          }
          continue;
        }
        state.ctrl._persistOverrideSocFloorLogged = false;
      }
      // === end T-0002 persistent-override SoC floor ===========================

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

      // === D-18 live runtime Akku-Hard-Limit clamp =========================
      // The runtime half of the D-17/D-18 dual enforcement. The plan-time
      // clamp (plan 10-03/10-04) sizes the Stage-2 LEEREN gridSetpointW on
      // FORECAST. A higher-than-forecast morning load or a PV dip can push a
      // plan-locked LEEREN slot's REAL battery discharge over the Akku Hard
      // Limit. This clamp inspects measured battery discharge every control
      // cycle and trims the active Stage-2 LEEREN setpoint toward 0 so
      // forecast error can never overdraw the physical 43 kWh battery.
      // Structurally mirrors the negativePriceProtection block above: inspect
      // eff.value, compare against a limit, conditionally write a clamped
      // value with its own source tag, continue. NEVER touches a non-Stage-2
      // gridSetpointW (a manual rule, the optimizer, a plain SMA rule).
      if (target === 'gridSetpointW' && eff.rule?.stage2Phase === 'LEEREN') {
        const akkuHardLimitW = Number(
          cfg.schedule?.smallMarketAutomation?.predictivePreEmpty?.akkuHardLimitW ?? 20000
        );
        const measuredBatteryDischargeW = state.victron.batteryDischargeW;
        // T-0075: batteryDischargeW is DERIVED from batteryPowerW (polling.js
        // `Math.max(0, -batteryPowerW)`), so it carries no own success timestamp —
        // key freshness on the real polled field batteryPowerW. A stale (frozen
        // but finite) discharge reading would otherwise pass the null/non-finite
        // guard below and let the clamp run on outdated telemetry.
        const maxAgeMs = Number(cfg.victron?.telemetryMaxAgeMs ?? 90000);
        const dischargeStale = victronFieldStale(state, 'batteryPowerW', maxAgeMs);

        // Note: Number(null) === 0 (finite), so a bare Number.isFinite check
        // would silently treat missing telemetry as a 0 W discharge. Reject
        // null/undefined explicitly before coercing — a missing reading must
        // hit the fail-safe path, never be read as "0 W, clamp not needed".
        if (
          measuredBatteryDischargeW == null ||
          !Number.isFinite(Number(measuredBatteryDischargeW)) ||
          dischargeStale
        ) {
          // FAIL SAFE: telemetry missing/null/non-finite/stale. Hold the current
          // (already plan-time-clamped) setpoint — do NOT no-op into an
          // unbounded discharge. Log once per episode.
          if (!state.ctrl._stage2ClampTelemetryMissing) {
            pushLog('stage2_akku_telemetry_missing', {
              rule: eff.rule?.id || null,
              eff: eff.value,
              reason: dischargeStale ? 'stale' : 'missing',
              ageMs: victronFieldAgeMs(state, 'batteryPowerW')
            });
            state.ctrl._stage2ClampTelemetryMissing = true;
          }
          await applyControlTarget(target, eff.value, eff.source);
          continue;
        }
        state.ctrl._stage2ClampTelemetryMissing = false;

        const measured = Number(measuredBatteryDischargeW);
        if (measured > akkuHardLimitW + STAGE2_CLAMP_HYSTERESIS_W) {
          // The clamp BINDS: real discharge is above the upper hysteresis
          // edge. Trim the (negative) setpoint toward 0 by the overshoot.
          // Math.min(0, ...) caps at 0 — the trim can never cross into a
          // positive (grid-charge) value, so it stays legal under the
          // EEG/§14a gate in applyControlTarget.
          const overshoot = measured - akkuHardLimitW;
          const trimmedValue = Math.min(0, Number(eff.value) + overshoot);
          await applyControlTarget('gridSetpointW', trimmedValue, 'stage2_akku_clamp');
          if (!state.ctrl._stage2ClampActive) {
            pushLog('stage2_akku_hard_limit_exceeded', {
              measured,
              limit: akkuHardLimitW,
              from: eff.value,
              to: trimmedValue
            });
            state.ctrl._stage2ClampActive = true;
          }
          continue;
        }
        if (measured < akkuHardLimitW - STAGE2_CLAMP_HYSTERESIS_W) {
          // Recovered below the lower hysteresis edge — reset the one-shot
          // flag so a future overshoot logs the binding episode again.
          state.ctrl._stage2ClampActive = false;
        }
        // Within the hysteresis dead-band: no write change (no flapping) —
        // fall through to the normal applyControlTarget below.
      }
      // === end D-18 live runtime Akku-Hard-Limit clamp =====================

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
