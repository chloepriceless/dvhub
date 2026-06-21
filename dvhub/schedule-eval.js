// schedule-eval.js -- Schedule evaluation brain with timer lifecycle.
// Extracted from server.js (Phase 4, Plan 02).
// Controls hardware via injected transport: applyDvVictronControl, applyControlTarget.
// Evaluates schedule rules every ~15 seconds, writes control signals to Victron inverter.

import { localMinutesOfDay, victronFieldAgeMs, victronFieldStale, controlWriteBoundsError, clampMinSoc } from './server-utils.js';
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

// T-0118 sell-price floor: a gridSetpointW more negative than this counts as a
// FORCED grid export (arbitrage), eligible for sell-price-floor suppression.
// Self-consumption setpoints (e.g. -100) and the neg-price limit (-40) are well
// above it and are never gated.
const FORCED_EXPORT_THRESHOLD_W = -1000;

// D-18 live runtime Akku-Hard-Limit clamp — hysteresis dead-band (W).
// Within [akkuHardLimitW - HYST, akkuHardLimitW + HYST] the clamp does not
// change the setpoint, so a measured battery discharge hovering near the
// limit cannot flap the Stage-2 LEEREN gridSetpointW every control cycle.
const STAGE2_CLAMP_HYSTERESIS_W = 500;

// Operator request (Christin 2026-06-21): the /api/log ring was flooded by one
// identical `control_write` line every control cycle for the reg-2716 keepalive
// re-writes (~5 s), drowning out everything else within ~1–2 min. Keepalive
// writes are now aggregated in the log: at most ONE `control_keepalive` summary
// per target per this window, carrying the suppressed count. The hardware write
// and DB telemetry still happen every cycle — only the operator log is thinned.
const KEEPALIVE_LOG_THROTTLE_MS = 60000;

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

// T-0099 NOT-HALT — source classification for the selective emergency-stop
// gate. MANDATORY sources keep writing while state.ctrl.discretionaryWritesPaused
// is set; everything else is blocked. This is a WHITELIST on purpose (fail-safe):
// a source string added tomorrow that nobody classified is blocked during an
// emergency stop, not silently allowed.
//   negative_price_protection  — §51 EEG curtailment duty (legal, must keep running)
//   manual_override_soc_floor  — T-0002 safety neutralization (writes 0 at SoC floor)
//   emergency_stop             — the stop action's own one-time gridSetpointW=0
//                                neutralization (must pass its own gate)
// Deliberately DISCRETIONARY (= blocked): dc_export_mode (DV revenue
// maximization, not a curtailment duty — Christin 2026-06-12), sell_price_floor,
// stage2_akku_clamp, forecast_optimizer rule:* sources, eos_optimization,
// emhass_optimization, api_manual_write, manual_override*, default.
// NOTE: applyDvVictronControl (§9 feed-in limit / PV curtailment, reg 2707/2709)
// is a separate path that never goes through applyControlTarget — it is NOT
// gated, by design. Reads (polling.js) are likewise untouched.
const MANDATORY_CONTROL_SOURCES = new Set([
  'negative_price_protection',
  'manual_override_soc_floor',
  'emergency_stop'
]);

export function isMandatoryControlSource(source) {
  return MANDATORY_CONTROL_SOURCES.has(String(source));
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
      // A scheduled rule ENDS any manual override on this target — including a
      // persistent one. Operator semantics (Christin 2026-06-12): a persistent
      // override holds "longer than the 5-min TTL, until a time slot writes the
      // target again" — it must NOT resume after the rule's window (the old
      // T-0002 resume-after-rule behaviour is retired).
      const mo0 = state.schedule.manualOverride[target];
      if (mo0) {
        delete state.schedule.manualOverride[target];
        if (mo0.persistent === true) {
          pushLog('manual_override_ended_by_rule', {
            target,
            overrideValue: mo0.value,
            ruleId: hit.id || 'unnamed',
            ruleSource: hit.source || 'manual'
          });
        }
      }
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

    // === T-0099 NOT-HALT selective gate =======================================
    // While the operator's emergency stop is active, ONLY whitelisted mandatory
    // sources (§51 curtailment, SoC-floor safety, the stop's own neutralization)
    // may write hardware. Runs FIRST — before bounds, EEG gate, keepalive and
    // the prev-value short-circuit — so a blocked write leaves lastWrite/active
    // state completely untouched. Log once per (target,source) while paused
    // (eval ticks every ~15 s — unthrottled this would flood the ring buffer);
    // the throttle map is cleared on resume.
    if (state.ctrl.discretionaryWritesPaused && !isMandatoryControlSource(source)) {
      const blockKey = `${target}|${source}`;
      if (!state.ctrl._stopBlockLogged) state.ctrl._stopBlockLogged = {};
      if (!state.ctrl._stopBlockLogged[blockKey]) {
        state.ctrl._stopBlockLogged[blockKey] = true;
        pushLog('control_write_blocked_nothalt', { target, value, source }, 'warn');
      }
      return { ok: false, blocked: true, error: 'emergency_stop_active' };
    }
    // === end T-0099 NOT-HALT gate =============================================

    // === T-0080 write-layer bounds (defense-in-depth at the chokepoint) =======
    // The /api/control/write route bounds values, but EOS/EMHASS (routes-api.js
    // eos/emhass apply) and evcc-integration call applyControlTarget DIRECTLY
    // with only an isFinite check — they bypassed the route's sanity ceilings.
    // Enforce the SAME bounds here (single source: server-utils) so a faulty
    // optimizer output, or a stolen-token EOS-apply, cannot push an absurd value
    // into the ESS write pipeline. These are GROSS sanity bounds, not inverter
    // spec. minSocPct is CLAMPED (not rejected) to the hard floor so an optimizer
    // minSoc=0 cannot remove the Victron SoC floor (reg 2901).
    const boundsErr = controlWriteBoundsError(target, value);
    if (boundsErr) {
      pushLog('control_write_rejected', { target, value, source, reason: boundsErr.error });
      return { ok: false, error: boundsErr.error };
    }
    if (target === 'minSocPct') {
      const floorPct = Number(cfg.optimizer?.hardFloorSocPct ?? 5);
      const clamped = clampMinSoc(value, floorPct);
      if (clamped.clamped) {
        pushLog('control_minsoc_clamped', { requested: Number(value), clampedTo: clamped.value, floorPct, source });
        value = clamped.value;
      }
    }
    // === end T-0080 write-layer bounds =======================================

    // === EEG/§14a legal gate — applies to ALL callers (schedule rules, manual control,
    // dc-export, eos/emhass optimizer, negative-price triggers). Source of truth:
    // cfg.optimizer.allowGridCharge / allowGridDischarge.
    // User memory: these flags are legally relevant — never auto-flip, never flip for demos.
    // Runs BEFORE the prev-value short-circuit so a flag flip between identical writes
    // cannot produce a silently-skipped illegal write.
    //
    // 25-01/25-02 Verfeinerung des Entlade-Zweigs (Befund 1+2): Ein negativer
    // gridSetpointW ist NICHT pauschal eine verbotene Akku→Netz-Entladung. Der
    // Reject (grid_discharge_not_allowed) feuert nur noch, wenn ALLE DREI gelten:
    //   (i)  numericValue <= FORCED_EXPORT_THRESHOLD_W (= -1000, :23) — eine ECHTE
    //        erzwungene Netzentladung. Kleinere Negativwerte (-40 Idle-Default,
    //        -100 Self-Consumption) sind kein Verkauf und passieren.
    //   (ii) !isMandatoryControlSource(source) — Pflicht-Quellen
    //        (negative_price_protection §51, manual_override_soc_floor, emergency_stop)
    //        passieren immer.
    //   (iii) source !== 'dc_export_mode' — PV-Überschuss-Einspeisung ist eine
    //        eigene legale Klasse (exportW <= 0, keine Akku→Netz-Entladung).
    // Sonst: keine Aktion — der Write läuft durch zum nachgelagerten T-0075-Floor.
    // ⚠ Die echte Akku→Netz-Sperre bleibt rechtlich wirksam: ein diskretionärer
    // <=-1000-Setpoint (EOS/Optimizer/manuell) wird bei allowGridDischarge=false
    // weiterhin abgelehnt. Der §51-Pflicht-Abregelungspfad (applyDvVictronControl,
    // reg 2707/2709) umgeht dieses Gate und ist hiervon unberührt. Die NOT-HALT-Achse
    // (:306) ist getrennt und unverändert. Schwelle -1000 = checkpoint:human-verify.
    if (target === 'gridSetpointW') {
      const numericValue = Number(value);
      const allowGridCharge = cfg.optimizer?.allowGridCharge ?? false;
      const allowGridDischarge = cfg.optimizer?.allowGridDischarge ?? false;
      if (numericValue > 0 && !allowGridCharge) {
        pushLog('control_write_rejected', { target, value: numericValue, source, reason: 'grid_charge_not_allowed' });
        return { ok: false, error: 'grid_charge_not_allowed' };
      }
      const isForcedGridDischarge = numericValue <= FORCED_EXPORT_THRESHOLD_W
        && !isMandatoryControlSource(source)
        && source !== 'dc_export_mode';
      if (isForcedGridDischarge && !allowGridDischarge) {
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

    // === T-0107 safety: volatile-setpoint Passthru guard ====================
    // Reg 2716 (com.victronenergy.hub4 /Overrides/Setpoint) is the VOLATILE,
    // flash-friendly 32-bit ESS setpoint (Venus >= 3.50). Victron reverts the
    // Multi to Passthru if it is not re-asserted within 60 s. Writing it without
    // a valid keepalive (0 < keepaliveMs <= 60000) therefore guarantees an
    // uncontrolled battery shortly after. Refuse such a write LOUDLY rather than
    // silently arming Passthru. The persistent reg 2700 has no such requirement,
    // so this guard is scoped to the volatile override address only. This makes
    // a half-migration (2716 write but keepalive still 0, e.g. prod's pinned 0)
    // structurally impossible to actuate.
    const VOLATILE_SETPOINT_ADDR = 2716;
    if (transport.type !== 'mqtt'
        && target === 'gridSetpointW'
        && Number(conf.address) === VOLATILE_SETPOINT_ADDR
        && !(keepaliveMs > 0 && keepaliveMs <= 60000)) {
      pushLog('control_write_blocked', {
        target, value, source, address: conf.address,
        reason: 'volatile_setpoint_requires_keepalive', keepaliveMs
      });
      return {
        ok: false,
        error: `reg ${VOLATILE_SETPOINT_ADDR} (volatile ESS setpoint) requires schedule.controlKeepaliveMs in (0,60000]; refusing write to avoid Multi Passthru (keepaliveMs=${keepaliveMs})`
      };
    }
    // === end T-0107 volatile-setpoint guard =================================

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
      // Real writes (value changed) are always surfaced. Keepalive re-writes
      // (identical value re-asserted every controlKeepaliveMs — ~5 s for the
      // volatile reg-2716 setpoint) used to flood the /api/log ring with one
      // identical line per cycle. Aggregate them: at most ONE `control_keepalive`
      // summary per target per KEEPALIVE_LOG_THROTTLE_MS, carrying the suppressed
      // count. The hardware write above + DB telemetry below still run every
      // cycle — only the in-memory operator log is thinned.
      const writeFields = {
        target, value,
        raw: encoded.raw, words, scaled: encoded.scaled,
        writeType: encoded.writeType, wordOrder: encoded.wordOrder,
        fc, address: conf.address, source
      };
      if (!isKeepalive) {
        pushLog('control_write', { ...writeFields, keepalive: false });
        if (state.schedule._kaAgg) delete state.schedule._kaAgg[target];
      } else {
        const agg = (state.schedule._kaAgg || (state.schedule._kaAgg = {}));
        const a = agg[target] || (agg[target] = { count: 0, lastLogAt: Date.now(), value });
        if (Number(a.value) !== Number(value)) { a.count = 0; a.lastLogAt = Date.now(); a.value = value; }
        a.count += 1;
        if (Date.now() - (a.lastLogAt || 0) >= KEEPALIVE_LOG_THROTTLE_MS) {
          pushLog('control_keepalive', { ...writeFields, keepalive: true, count: a.count, throttleMs: KEEPALIVE_LOG_THROTTLE_MS });
          a.count = 0;
          a.lastLogAt = Date.now();
        }
      }
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
    // Review 2026-06-10 (B1): use the configured timezone, not process-local
    // time — on a UTC host getHours() shifted the charge-guard window by 2h.
    const currentHour = Math.floor(localMinutesOfDay(new Date(now), cfg.schedule.timezone) / 60);
    // Review 2026-06-10 (A1): the SoC guard exists so a MANUALLY scheduled
    // "100 % Einspeisung" still lets the battery charge before the evening
    // peak. EOS-planned dcExportMode slots (T-0124b, autoManaged) already
    // account for SoC/battery in the plan — guarding them only blocked
    // planned PV feed-in revenue on afternoons with SoC < targetSocPct.
    const dcGuardApplies = dcScheduleRule?.autoManaged !== true;
    if (dcExportActive && dcGuardApplies && currentSoc < dcTargetSoc && currentHour >= (dcDeadlineHour - dcChargeGuardHours)) {
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
        // T-0124c (operator 2026-06-09): subtract the LIVE house consumption so we
        // export only the REAL surplus (PV − Haus − Puffer). selfConsumptionW = live
        // total AC house load (Victron Ac/Consumption L1..L3). This keeps the
        // battery net ~0 A — exactly what the "100 % Einspeisung" tooltip promises
        // AND what EOS plans for a pure PV-surplus slot (so a live PV dip lowers the
        // export instead of draining the battery). Toggle: dcExportMode.subtractHouseLoad
        // (default ON). With it OFF the legacy "export all PV minus buffer" applies.
        const subtractLoad = cfg.dcExportMode?.subtractHouseLoad !== false;
        const liveLoadW = subtractLoad ? Math.max(0, Number(state.victron.selfConsumptionW || 0)) : 0;
        const reserveW = liveLoadW + bufferW;
        if (pvW > 50) {
          // Negativer Setpoint = Einspeisung. Export = PV − Hausverbrauch − Puffer,
          // nie negativ (kein erzwungener Import / Akku-Entladen wenn PV < Last).
          const exportW = Math.round(-Math.max(0, pvW - reserveW));
          const prev = state.schedule.active.gridSetpointW;
          const prevVal = prev?.value;
          // Nur schreiben wenn sich der Wert merklich aendert (>50W Differenz) oder alle 60s
          const timeSinceLastWrite = now - (state.ctrl._dcExportLastWriteAt || 0);
          if (prevVal == null || Math.abs(exportW - prevVal) > 50 || timeSinceLastWrite > 60000) {
            await applyControlTarget('gridSetpointW', exportW, 'dc_export_mode');
            state.ctrl._dcExportLastWriteAt = now;
            if (!state.ctrl._dcExportLogged) {
              pushLog('dc_export_mode_active', { pvW, exportW, bufferW, liveLoadW, subtractLoad, currentPrice });
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

      // === T-0121/T-0122 EOS closed-loop export: live-PV recompute ============
      // For an EOS rule, re-derive the setpoint from MEASURED PV every cycle. Two
      // regimes, split on B (the deliberate Akku→Netz share held from the plan):
      //
      //   B > 0  — deliberate battery-export slot (evening arbitrage): dump B and
      //            ride the live PV surplus on top → gridSetpointW = -(B + livePV).
      //            (Christin's evening "PV oben drauf".)
      //
      //   B == 0 — charge / self-consumption slot: EOS wants to feed in ONLY the
      //            planned amount and charge the REST of the PV surplus into the
      //            battery. So export AT MOST the planned amount, PV-limited
      //            (min(plannedExport, livePV)): a PV dip lowers the export (no
      //            drain) and surplus PV EOS earmarked for the battery is NOT
      //            dumped to the grid. T-0122 fix for "voller PV ins Netz statt
      //            Akku laden".
      //
      // maxDischargeW (reg 2704) is DELIBERATELY left untouched: the operator owns
      // it manually (prod: 20000 = full battery for house+EV). The closed-loop must
      // not cap it — a low cap starves EV charging (the shortfall comes expensively
      // from the grid). Over-discharge protection comes from THIS 5 s recompute and,
      // on a stall, from reg 2716's ~10 s Passthru revert → safe self-consumption.
      // Runs BEFORE the guards so neg-price / SoC-floor / D-18 act on the live
      // value. Internal-optimizer rules (no closedLoopExport) untouched.
      if (target === 'gridSetpointW'
          && eff.rule?.optimizer === 'eos'
          && eff.rule?.closedLoopExport
          && Number(eff.value) < 0) {
        const plannedExportW = Math.abs(Number(eff.value)); // EOS' planned net export for this slot
        const B = Math.max(0, Number(eff.rule.batteryShareW) || 0);
        const pvW = Math.max(0, Number(state.victron.pvTotalW || state.victron.pvPowerW || 0));
        const loadW = Math.max(0, Number(state.victron.selfConsumptionW || 0));
        const livePvSurplusW = Math.max(0, pvW - loadW);
        // Review 2026-06-10 (A4): clamp B + live PV to the inverter's AC limit.
        // A setpoint above what the Multis can deliver forces them to max power
        // (not the setpoint) and leaves a grid-import residual that confuses
        // the closed-loop cascade. Gross bound (100 kW) is far too loose here.
        const inverterCapW = Math.max(1000, Number(cfg.optimizer?.inverterMaxPowerW) || 29000);
        eff.value = B > 0
          ? -Math.round(Math.min(B + livePvSurplusW, inverterCapW)) // export slot: B + live PV, AC-capped
          : -Math.round(Math.min(plannedExportW, livePvSurplusW));  // charge slot: plan-capped, PV-limited
      }
      // === end T-0121/T-0122 EOS closed-loop ==================================

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
          // Review 2026-06-10 (A2): await was missing — a failed "block feed-in"
          // write went undetected in this path (T-0076 retry semantics rely on
          // the awaited result; line ~870 already awaits the same call).
          await applyDvVictronControl(false);
        }
        if (eff.value < limit) {
          await applyControlTarget(target, limit, 'negative_price_protection');
          continue;
        }
      }

      // === T-0118 sell-price floor =========================================
      // Arbitrage export rules (forecast_optimizer / small-market / Stage-2
      // LEEREN) rank discharge slots RELATIVE to a daily average. On solar-glut
      // days with negative midday prices the average collapses, so absolutely-
      // cheap night slots (e.g. 6 ct at 04:00) clear the relative bar and the
      // 43 kWh battery gets sold off cheap. When the current spot price is below
      // the configured floor, suppress a FORCED grid export — hold at the default
      // self-consumption setpoint so the energy stays for own load instead of a
      // cheap sale. Same shape as negativePriceProtection above. Runs BEFORE the
      // Stage-2 clamp so a cheap LEEREN slot is held, not clamped. OFF when
      // minSellPriceCtKwh is unset (prior behavior).
      //
      // T-0118 (2026-06-06): the floor is NOT applied to EOS-sourced rules. EOS
      // owns the full economic decision and deliberately empties at low/cheap
      // prices before a curtailment window to free room for otherwise-curtailed
      // PV — a flat 12 ct floor would block that valid prep. The negative-price
      // guard above still applies to EVERY source (never pay to export). The
      // floor stays in force for the internal optimizer, the small-market
      // automation and Stage-2 LEEREN (eff.rule.optimizer is 'internal'/absent).
      const isEosRule = eff.rule?.optimizer === 'eos';
      if (target === 'gridSetpointW' && !isEosRule) {
        const sellFloor = Number(cfg.optimizer?.minSellPriceCtKwh);
        const curCt = priceNow ? Number(priceNow.ct_kwh) : null;
        const forcedExport = Number(eff.value) <= FORCED_EXPORT_THRESHOLD_W;
        if (Number.isFinite(sellFloor) && forcedExport && curCt !== null && Number.isFinite(curCt) && curCt < sellFloor) {
          const hold = Number(cfg.schedule?.defaultGridSetpointW ?? -100);
          await applyControlTarget('gridSetpointW', hold, 'sell_price_floor');
          const key = String(eff.rule?.id ?? eff.source ?? '');
          if (state.ctrl._sellFloorKey !== key) {
            pushLog('sell_price_floor_hold', { price: curCt, floor: sellFloor, suppressed: Number(eff.value), held: hold, source: eff.source });
            state.ctrl._sellFloorKey = key;
          }
          continue;
        }
        if (state.ctrl._sellFloorKey != null) state.ctrl._sellFloorKey = null;
      }
      // === end T-0118 sell-price floor =====================================

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
