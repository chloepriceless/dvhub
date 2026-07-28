// schedule-eval.js -- Schedule evaluation brain with timer lifecycle.
// Extracted from server.js (Phase 4, Plan 02).
// Controls hardware via injected transport: applyDvVictronControl, applyControlTarget.
// Evaluates schedule rules every ~15 seconds, writes control signals to Victron inverter.

import fs from 'node:fs';

import { atomicWriteControlState } from './control-state-io.js';
import { localMinutesOfDay, victronFieldAgeMs, victronFieldStale, controlWriteBoundsError, clampMinSoc } from './server-utils.js';
import {
  autoDisableStopSocScheduleRules,
  autoDisableExpiredScheduleRules,
  scheduleMatch
} from './schedule-runtime.js';
import { isSmallMarketAutomationRule, SLOT_DURATION_MS } from './market-automation-builder.js';
// Plan 09-07: safeInterval — der Eval selbst läuft als setTimeout-Kette
// (evalTimeout); safeInterval trägt den 5-s-Zero-Feed-in-Regelkreis (B-1112
// Stufe 2), damit ein Throw im Tick den Takt nicht stillschweigend beendet.
import { safeInterval } from './services/safe-async.js';
import { encodeSunspecFloat32 } from './services/inverter/sunspec.js';
import { getPowerLimits } from './services/power-limits.js';

// T-0118 sell-price floor: a gridSetpointW more negative than this counts as a
// FORCED grid export (arbitrage), eligible for sell-price-floor suppression.
// Self-consumption setpoints (e.g. -100) and the neg-price limit (-40) are well
// above it and are never gated.
const FORCED_EXPORT_THRESHOLD_W = -1000;

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
// Einspeise-Puffer (GitHub #12 + Christin 29.07.) — EIN Wert, kein eigener
// Regler: der bereits vorhandene `schedule.defaultGridSetpointW`.
//
// Beide Melder beschreiben denselben Wert. Johann (#12): „…als mindest Export,
// wenn der Börsenpreis nicht <0 ist. Sozusagen auf den ‚Default Grid' Wert."
// Christin: sein eingestelltes -100 wurde während der Abregelung vom
// eingebauten -40 überschrieben. Deshalb wirkt der Default-Sollwert jetzt
// überall als Untergrenze, statt nur zu greifen, wenn gar keine Regel läuft.
//
// null = kein Puffer (Wert ist 0, leer oder positiv) → unverändertes Verhalten.
export function exportBufferFloorW(cfg) {
  const v = Number(cfg?.schedule?.defaultGridSetpointW);
  if (!Number.isFinite(v) || v >= 0) return null;
  return Math.round(v);
}

// Obergrenze für den Puffer WÄHREND der Abregelung. Darüber hinaus wäre es kein
// Ausregeln von Lastsprüngen mehr, sondern ein echter Verkauf bei negativem
// Preis — dieselbe Schwelle, mit der das EEG/§14a-Gate eine erzwungene
// Netzentladung erkennt. Im Normalbetrieb gilt sie nicht.
const CURTAILMENT_BUFFER_LIMIT_W = FORCED_EXPORT_THRESHOLD_W;

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
// forecast_optimizer rule:* sources, eos_optimization,
// emhass_optimization, api_manual_write, manual_override*, default.
// NOTE: applyDvVictronControl (§9 feed-in limit / PV curtailment, reg 2707/2709)
// is a separate path that never goes through applyControlTarget. Issue #8: its
// CALLERS now honor the emergency stop — while discretionaryWritesPaused is set,
// the discretionary schedule path RELEASES the PV (feedIn=true, source
// 'emergency_stop_release') instead of continuing to curtail; only the mandatory
// §51 negative-price path (and DV forcedOff) keep curtailing. Reads (polling.js)
// are untouched.
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

  // Aktueller Spotpreis in ct/kWh, oder null wenn nicht ermittelbar. null heißt
  // ausdrücklich „unbekannt", NICHT „nicht negativ" — Aufrufer, die eine
  // Preisentscheidung treffen, müssen den unbekannten Fall fail-safe behandeln.
  // (Der Preis hängt unter epexNowNext().current, nicht top-level.)
  function currentPriceCtKwh() {
    try {
      const p = typeof ctx.epexNowNext === 'function' ? ctx.epexNowNext()?.current : null;
      const ct = p ? Number(p.ct_kwh) : NaN;
      return Number.isFinite(ct) ? ct : null;
    } catch {
      return null;
    }
  }

  function toRawForWrite(value, conf) {
    const scale = Number(conf.scale ?? 1);
    const offset = Number(conf.offset ?? 0);
    if (!Number.isFinite(scale) || scale === 0) throw new Error('invalid write scale');
    let engineeringValue = Number(value);
    if (!Number.isFinite(engineeringValue)) throw new Error('invalid write value');

    // rawSentinels (2026-07-12, reg-2704-Scale-Fix): Sentinel-Werte sind MODES,
    // keine Messwerte — sie gehen UNskaliert aufs Register. Victron MaxDischarge-
    // Power (2704): 0 = Entladung sperren, -1 = unbegrenzt; das Register selbst
    // zählt in 10-W-Schritten (scale 10). Ohne Passthrough würde -1 mit
    // scale 10 zu round(-0.1) = 0 — aus „unbegrenzt" würde „gesperrt".
    const rawSentinels = Array.isArray(conf.rawSentinels) ? conf.rawSentinels.map(Number) : [];
    if (rawSentinels.includes(engineeringValue)) {
      // Sentinel 1:1 kodieren: scale/offset überspringen, Typ-Encoding unten
      // (int16-Zweierkomplement für -1 → 0xFFFF) läuft normal weiter.
      return toRawForWrite(engineeringValue, { ...conf, scale: 1, offset: 0, rawSentinels: [] });
    }

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

    // SunSpec Float-Modus (B-1112): Engineering-Wert als IEEE-754-Float32 in
    // zwei Registern. Kein Math.round — Float trägt die Nachkommastellen
    // (z. B. WMaxLimPct in 0,01-%-Schritten); scale/offset gelten wie üblich.
    if (writeType === 'float32') {
      const scaledFloat = (engineeringValue - offset) / scale;
      const words = encodeSunspecFloat32(scaledFloat, wordOrder);
      return { raw: words[0], words, scaled: scaledFloat, writeType, wordOrder };
    }

    throw new Error(`unsupported writeType: ${conf.writeType}`);
  }

  function effectiveTargetValue(target) {
    const cfg = getCfg();
    const optimizerEnabled = cfg.optimizer?.enabled ?? false;
    const allowGridCharge = cfg.optimizer?.allowGridCharge ?? false;
    const allowGridDischarge = cfg.optimizer?.allowGridDischarge ?? false;
    // Pro-Gating (Task #11): forecast_optimizer rules (EOS/optimizer dispatch) are
    // a Pro feature. Without an active licence they NEVER actuate — even stale rules
    // lingering in state.schedule.rules — so the box falls back to Stage 1/2 (SMA
    // rules, which are unaffected). Mirrors the runOptimization() production gate.
    // Defensive: a missing isProActive never gates (prod licensed → unaffected).
    const proGateClosed = typeof ctx.licenseService?.isProActive === 'function'
      && ctx.licenseService.isProActive() === false;
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
        if (!optimizerEnabled || proGateClosed) return false;
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

  // B-1112 (Fronius u. a. mode-Dialekt-Geräte): ein dvControl-Flag kann statt
  // eines einzelnen Registers eine SEQUENZ von controlWrite-Punkten schreiben
  // (z. B. Einspeisesperre = WMaxLimPct:=0 DANN WMaxLim_Ena:=1; Freigabe =
  // WMaxLim_Ena:=0). Die Schritte referenzieren Einträge in cfg.controlWrite —
  // Adresse/Encoding kommen dort ggf. aus dem SunSpec-Scan (polling.js).
  // Wirft bei nicht aufgelöstem/deaktiviertem Punkt → der Aufrufer behandelt
  // das wie einen fehlgeschlagenen Register-Write (T-0076-Retry-Semantik).
  // Step-Formen:
  //   { point, value }                      — festen Wert schreiben
  //   { point, value, saveBefore: true }    — vorher aktuellen Registerwert
  //     lesen und (nur beim ERSTEN Block, nie doppelt) für restore sichern.
  //     Deye-Fall: der Kunde fährt ggf. regulär Zero-Export — ein fixer
  //     Release-Wert würde seine Betriebsart zerstören.
  //   { point, restore: true, restoreDefault? } — den gesicherten Wert
  //     zurückschreiben; ohne Sicherung (z. B. Neustart während der Sperre —
  //     der Speicher ist in-memory) greift restoreDefault, sonst wird der
  //     Schritt übersprungen.
  // B-1112 restore-Speicher restart-fest (Christin 2026-07-19): Der saveBefore/
  // restore-Store lebte nur in-memory — ein Neustart WÄHREND einer aktiven
  // Sperre verlor die gesicherten Kundenwerte (Fronius-Feldtest: StorCtl_Mod=1
  // + InWRte aus Solar.web), die Freigabe schrieb dann nur die pauschalen
  // restoreDefaults. Jetzt: Laden beim Init, atomares Persistieren bei jeder
  // Mutation (tmp+rename wie control_state.json). Ohne ctx.dvSeqSavedPath
  // (alte Aufrufer/Tests) bleibt das Verhalten rein in-memory.
  if (ctx.dvSeqSavedPath && state.ctrl._dvSeqSaved === undefined) {
    try {
      const raw = JSON.parse(fs.readFileSync(ctx.dvSeqSavedPath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) state.ctrl._dvSeqSaved = raw;
    } catch { /* keine/korrupte Datei → leerer Store (Erstlauf) */ }
  }

  function persistDvSeqSaved() {
    if (!ctx.dvSeqSavedPath) return;
    try {
      atomicWriteControlState(ctx.dvSeqSavedPath, state.ctrl._dvSeqSaved ?? {});
    } catch (e) {
      pushLog('dv_seq_saved_persist_error', { error: e?.message || String(e) });
    }
  }

  async function runDvControlSequence(steps) {
    const cfg = getCfg();
    const saved = (state.ctrl._dvSeqSaved ??= {});
    for (const step of steps) {
      const pconf = cfg.controlWrite?.[step.point];
      if (!pconf?.enabled) throw new Error(`sequence point not enabled: ${step.point}`);
      if (pconf.address == null) throw new Error(`sequence point unresolved (sunspec scan pending): ${step.point}`);
      let value = step.value;
      if (step.restore === true) {
        value = saved[step.point] ?? step.restoreDefault;
        if (value == null) continue; // nie geblockt und kein Default → no-op
      } else if (step.saveBefore === true && saved[step.point] === undefined) {
        const regs = await transport.mbRequest({
          fc: 3, host: pconf.host, port: pconf.port, unitId: pconf.unitId,
          address: pconf.address, quantity: 1, timeoutMs: pconf.timeoutMs
        });
        // Rohwert rückwärts durch scale/offset in den Engineering-Wert, damit
        // der restore-Write denselben toRawForWrite-Weg nehmen kann.
        const scale = Number(pconf.scale ?? 1);
        const offset = Number(pconf.offset ?? 0);
        saved[step.point] = Number(regs[0]) * scale + offset;
        persistDvSeqSaved();
      }
      const encoded = toRawForWrite(value, pconf);
      const words = Array.isArray(encoded.words) && encoded.words.length ? encoded.words : [encoded.raw];
      const fc = Number(pconf.fc || (words.length > 1 ? 16 : 6));
      if (fc === 16 || words.length > 1) {
        await transport.mbWriteMultiple({ host: pconf.host, port: pconf.port, unitId: pconf.unitId, address: pconf.address, values: words, timeoutMs: pconf.timeoutMs });
      } else {
        await transport.mbWriteSingle({ host: pconf.host, port: pconf.port, unitId: pconf.unitId, address: pconf.address, value: words[0], timeoutMs: pconf.timeoutMs });
      }
      if (step.restore === true && saved[step.point] !== undefined) {
        delete saved[step.point];
        persistDvSeqSaved();
      }
    }
  }

  async function applyDvVictronControl(feedIn) {
    const cfg = getCfg();
    const dc = cfg.dvControl;
    if (!dc) return;
    // #10 (FrodoVDR): Ist die aktive Steuerung deaktiviert, darf DVhub NIE sperren —
    // muss aber eine früher gesetzte EIGENE Sperre aufheben können. Steuer-Register
    // sind persistent (Victron CGwacs reg 2707/2708 überleben DVhub-Aus), sonst
    // bleibt die PV abgeregelt, obwohl DVhub „aus" ist. Deshalb bei enabled=false
    // NUR die Freigabe (feedIn=true) zulassen, alles andere abweisen.
    if (!dc.enabled && feedIn !== true) return;

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
        if (Array.isArray(dc.feedExcessDcPv.sequence?.[String(val)])) {
          await runDvControlSequence(dc.feedExcessDcPv.sequence[String(val)]);
        } else if (transport.type === 'mqtt') {
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
        if (Array.isArray(dc.dontFeedExcessAcPv.sequence?.[String(val)])) {
          await runDvControlSequence(dc.dontFeedExcessAcPv.sequence[String(val)]);
        } else if (transport.type === 'mqtt') {
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

  // === T-VERIFY write-verification (Read-after-Write-Regelkreis) ============
  // Christin 2026-07-20: "Gibt es einen Regelungsloop, der prüft, ob wir eine
  // Rückmeldung bekommen, wenn wir einen Befehl abschicken?" — bislang nein:
  // MQTT war fire-and-forget (QoS 0), Modbus nur Frame-Ack. Dieser Loop liest
  // nach jedem ECHTEN Write (kein Keepalive) den Ist-Zustand zurück und
  // vergleicht mit dem Soll:
  //   Match     → still (nur state-Statistik; Recovery nach Mismatch wird geloggt)
  //   Mismatch  → warn `control_write_unconfirmed` + lastWrite[target] VERWERFEN,
  //               damit das T-0002-Unchanged-Short-Circuit den Wert nicht ewig
  //               skippt — der nächste Eval-Tick/Recompute schreibt neu durch
  //               die VOLLE Gate-Pipeline (kein Transport-Direktpfad, keine
  //               Gate-Umgehung). Nach VERIFY_FAIL_ESCALATE Mismatches in Folge
  //               → error `control_write_verify_failed` (Telemetrie-Event).
  //   Kein Wert → warn `control_write_verify_error` (Lese-Problem ≠ Schreib-Problem,
  //               KEIN Verwerfen — das Gerät nicht für unsere Lese-Schwäche strafen).
  // MQTT: transport.readPointSince (nur Nach-Write-Werte zählen als Beweis).
  // Modbus: Register-Rücklesen (fc verifyFc||3), Vergleich auf RAW-Wort-Ebene
  // (identisch zu den geschriebenen Words — kein Dekodier-Drift möglich).
  // Flag default OFF (schedule.controlWriteVerify.enabled) — Opt-in pro Anlage.
  // Sequenz-Dialekte (B-1112) sind v1 außen vor (eigener Aktuator, eigenes Log).
  const VERIFY_DEFAULT_DELAY_MS = 4000;
  const VERIFY_DEFAULT_MIN_INTERVAL_MS = 30000;
  const VERIFY_FAIL_ESCALATE = 3;

  function maybeScheduleWriteVerify(target, conf, cfg, { isKeepalive }) {
    const vc = cfg.schedule?.controlWriteVerify;
    if (vc?.enabled !== true || isKeepalive) return;
    if (typeof transport?.readPointSince !== 'function' && transport?.type === 'mqtt') return;
    const all = (state.schedule._verify || (state.schedule._verify = {}));
    const v = (all[target] || (all[target] = { timer: null, lastRunAt: 0, mismatches: 0, lastOkAt: null }));
    // Ein Verify pro Target in flight: es prüft beim Feuern den NEUESTEN
    // lastWrite — schnell aufeinanderfolgende Writes (5-s-Recompute) erzeugen
    // so höchstens einen Read pro minIntervalMs statt einen pro Write.
    if (v.timer) return;
    const delayMs = Number(vc.delayMs) > 0 ? Number(vc.delayMs) : VERIFY_DEFAULT_DELAY_MS;
    const minIntervalMs = Number(vc.minIntervalMs) > 0 ? Number(vc.minIntervalMs) : VERIFY_DEFAULT_MIN_INTERVAL_MS;
    const wait = Math.max(delayMs, (v.lastRunAt + minIntervalMs) - Date.now());
    v.timer = setTimeout(() => {
      v.timer = null;
      v.lastRunAt = Date.now();
      runWriteVerify(target, conf).catch((e) => {
        pushLog('control_write_verify_error', { target, error: e?.message || String(e) }, 'warn');
      });
    }, wait);
    if (typeof v.timer.unref === 'function') v.timer.unref();
  }

  async function runWriteVerify(target, confAtWrite) {
    const cfg = getCfg();
    const vc = cfg.schedule?.controlWriteVerify || {};
    const lw = state.schedule.lastWrite[target];
    const v = state.schedule._verify?.[target];
    if (!lw || !v) return;
    const expected = Number(lw.value);
    const toleranceAbs = Number(vc.toleranceAbs) || 0;

    let match;
    let actual;
    try {
      if (transport.type === 'mqtt') {
        const res = await transport.readPointSince(target, lw.at);
        actual = Number(res.mqttValue);
        match = Number.isFinite(actual) && Math.abs(actual - expected) <= toleranceAbs;
      } else {
        const conf = cfg.controlWrite?.[target] || cfg.dvControl?.[target] || confAtWrite;
        const words = Array.isArray(lw.words) && lw.words.length ? lw.words : [lw.raw];
        const regs = await transport.mbRequest({
          host: conf.host, port: conf.port, unitId: conf.unitId,
          fc: Number(conf.verifyFc) || 3, address: conf.address,
          quantity: words.length, timeoutMs: conf.timeoutMs
        });
        actual = Array.isArray(regs) ? regs.slice(0, words.length) : regs;
        match = Array.isArray(regs)
          && words.every((w, i) => (Number(regs[i]) & 0xFFFF) === (Number(w) & 0xFFFF));
      }
    } catch (e) {
      // Kein Nach-Write-Wert / Lese-Fehler: NICHT als Schreib-Fehlschlag werten.
      pushLog('control_write_verify_error', { target, expected, error: e?.message || String(e) }, 'warn');
      return;
    }

    // Superseded-Guard: landete WÄHREND unseres Reads ein neuer Write, kann der
    // Rücklesewert bereits den NEUEN Soll spiegeln — Vergleich gegen den alten
    // Soll wäre ein falscher Mismatch. Der Write hat sein eigenes Verify geplant.
    const lwNow = state.schedule.lastWrite[target];
    if (!lwNow || lwNow.at !== lw.at) return;

    if (match) {
      const recovered = v.mismatches > 0;
      v.mismatches = 0;
      v.lastOkAt = Date.now();
      if (recovered) {
        pushLog('control_write_verify_recovered', { target, value: expected });
      } else if (!v.okLogged) {
        // Feldtest-Beweis: der ERSTE bestätigte Write pro Target wird einmalig
        // geloggt (danach still — Erfolg ist der Normalfall, kein Log-Futter).
        v.okLogged = true;
        pushLog('control_write_verified', { target, value: expected, transport: transport.type });
      }
      return;
    }

    v.mismatches += 1;
    pushLog('control_write_unconfirmed', {
      target, expected, actual, source: lw.source,
      mismatches: v.mismatches, retryVia: 'next_assert'
    }, 'warn');
    telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
      eventType: 'control_write_unconfirmed',
      target,
      valueNum: Number.isFinite(expected) ? expected : null,
      reason: lw.source,
      source: 'runtime',
      meta: { actual, mismatches: v.mismatches }
    }));
    // Korrektur über den NATÜRLICHEN Pfad: lastWrite verwerfen → das
    // Unchanged-Short-Circuit greift nicht mehr, der nächste Assert schreibt
    // den Soll erneut (voll durch Not-Halt-/EEG-/Floor-Gates) und wird
    // wieder verifiziert.
    delete state.schedule.lastWrite[target];
    if (v.mismatches >= VERIFY_FAIL_ESCALATE) {
      pushLog('control_write_verify_failed', {
        target, expected, actual, mismatches: v.mismatches
      }, 'error');
      telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
        eventType: 'control_write_verify_failed',
        target,
        valueNum: Number.isFinite(expected) ? expected : null,
        reason: lw.source,
        source: 'runtime',
        meta: { actual, mismatches: v.mismatches }
      }));
    }
  }
  // === end T-VERIFY =========================================================

  async function applyControlTarget(target, value, source) {
    const cfg = getCfg();
    const conf = cfg.controlWrite[target] || cfg.dvControl?.[target];
    if (!conf?.enabled) return { ok: false, error: 'write target not enabled in config' };
    // SunSpec-deklarierte Punkte haben erst nach dem Geräte-Scan (polling.js)
    // eine Adresse — vorher NIE schreiben (der address-0-Guard darunter würde
    // Number(null)===0 zwar auch blocken, aber mit irreführender Meldung).
    if (conf.sunspec && conf.address == null) return { ok: false, error: 'sunspec address not resolved yet (device scan pending)' };
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

    // === B-1112 Sequenz-Dialekt: feedExcessDcPv ohne Direkt-Register ==========
    // Mode-Dialekt-Profile (Fronius M124-Force-Charge, Deye Work-Mode) aktuieren
    // das Feed-in-Flag über eine SEQUENZ von controlWrite-Punkten —
    // dvControl.feedExcessDcPv hat dort KEINE eigene Register-Adresse. Der
    // generische Einzelregister-Pfad unten schrieb dann auf address=undefined →
    // das Gerät antwortete "modbus exception 2" (illegal data address), obwohl
    // der Eval-Pfad (applyDvVictronControl) die Sequenz ~15 s später korrekt
    // schrieb — die API-Antwort log (Feldtest 554bbdfd, 2026-07-18). Deshalb hier
    // an den kanonischen Aktuator delegieren, damit Antwort == Geräteaktion.
    // Victron (Direkt-Register 2707, keine sequence) läuft unverändert durch den
    // generischen Pfad. Sitzt NACH dem NOT-HALT-Gate: manuelle Flag-Writes
    // bleiben im Not-Halt geblockt.
    if (target === 'feedExcessDcPv') {
      const feedIn = Number(value) === 1;
      const seq = cfg.dvControl?.feedExcessDcPv?.sequence;
      if (Array.isArray(seq?.[feedIn ? '1' : '0'])) {
        if (cfg.dvControl?.enabled !== true && !feedIn) {
          // #10 (FrodoVDR): deaktivierte Steuerung darf NIE sperren, nur freigeben.
          pushLog('control_write_rejected', { target, value, source, reason: 'dv_control_disabled' });
          return { ok: false, error: 'dv_control_disabled' };
        }
        if (state.ctrl._lastDvFeedIn === feedIn) {
          state.schedule.active[target] = { value, source, at: Date.now(), skipped: true, reason: 'unchanged' };
          return { ok: true, skipped: true, reason: 'unchanged' };
        }
        await applyDvVictronControl(feedIn);
        const seqResult = state.ctrl.dvControl?.feedExcessDcPv;
        if (!seqResult?.ok) {
          pushLog('control_write_error', { target, value, source, error: seqResult?.error || 'dv_sequence_failed' });
          return { ok: false, error: seqResult?.error || 'dv_sequence_failed' };
        }
        state.schedule.lastWrite[target] = { value, source, writeType: 'sequence', at: Date.now() };
        state.schedule.active[target] = { value, source, at: Date.now() };
        pushLog('control_write', { target, value, source, writeType: 'sequence' });
        telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
          eventType: 'control_write',
          target,
          valueNum: Number(value),
          reason: source,
          source: 'runtime',
          meta: { writeType: 'sequence' }
        }));
        return { ok: true, writeType: 'sequence' };
      }
    }
    // === end B-1112 Sequenz-Dialekt ==========================================

    // === Einspeise-Puffer als Untergrenze (GitHub #12) ========================
    // Steht der gridSetpointW auf 0, regelt die Anlage auf "null am Zähler" —
    // ein Lastsprung (Herd, Wärmepumpe, Wallbox) erzeugt dann bis zu 1 kW
    // Netzbezug, weil die ESS-Regelung dem Sprung hinterherläuft. Der
    // Default-Sollwert wirkt deshalb als Untergrenze für JEDEN Sollwert, nicht
    // mehr nur als Fallback, wenn gar keine Regel läuft.
    //
    // Der Boden VERSTÄRKT nur (Math.min auf der negativen Achse) — er schwächt
    // keinen stärkeren Export ab und schreibt nie in Richtung Netzbezug.
    //
    // Fail-safe-Gates, ALLE müssen halten, sonst greift der Boden nicht:
    //   - Preis muss bekannt UND >= 0 sein. Unbekannt => KEIN erzwungener Export:
    //     bei negativem Preis kostet Einspeisen Geld, und ein ausgefallener
    //     EPEX-Feed darf das nicht verdecken (fail-safe statt fail-open).
    //   - negativePriceActive => aus; dort setzt der Abregelungspfad den Wert
    //     selbst (mit derselben Zahl, nur zusätzlich gedeckelt).
    //   - Pflicht-Quellen (§51, SoC-Floor, Not-Halt) bleiben unangetastet —
    //     deren Werte sind Schutzmaßnahmen, kein Regelpunkt.
    //   - sell_price_floor => aus (hält bereits auf genau diesem Wert).
    //   - Ein POSITIVER Sollwert ist ein gewolltes Netzladen (Optimierer lädt den
    //     Akku aus dem Netz). Den dreht der Boden nicht in einen Export um — sonst
    //     sabotierte der Puffer einen bezahlten Ladeslot.
    // Der T-0075-Entlade-Boden weiter unten bleibt wirksam: bei unbekanntem,
    // veraltetem oder eingefrorenem SoC bzw. SoC <= hardFloor wird der negative
    // Wert auf 0 gehalten — der Boden kann den Akku also nicht leerfahren.
    if (target === 'gridSetpointW') {
      const floorW = exportBufferFloorW(cfg);
      const eligible = floorW !== null
        && !isMandatoryControlSource(source)
        && source !== 'sell_price_floor'
        && state.ctrl.negativePriceActive !== true;
      if (eligible) {
        const priceCt = currentPriceCtKwh();
        const requested = Number(value);
        if (priceCt !== null && priceCt >= 0 && Number.isFinite(requested)
            && requested <= 0 && requested > floorW) {
          const key = `${source}|${floorW}`;
          if (state.ctrl._exportBufferKey !== key) {
            state.ctrl._exportBufferKey = key;
            pushLog('export_buffer_floor', { requested, floorW, source, priceCt });
          }
          value = floorW;
        } else if (state.ctrl._exportBufferKey != null && !(priceCt !== null && priceCt >= 0)) {
          state.ctrl._exportBufferKey = null;
        }
      } else if (state.ctrl._exportBufferKey != null) {
        state.ctrl._exportBufferKey = null;
      }
    }
    // === end Issue #12 Mindesteinspeisung ====================================

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
    // T-0001 P0-1: the per-rule stopSoc floors check only null/non-finite,
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
      // T-FREEZE (2026-07-24): erkannter Einfrierer hält SOFORT, ohne erst
      // telemetryMaxAgeMs abzuwarten. Der Wächter datiert die Stempel zwar
      // zurück (dann griffe `stale` ohnehin), aber bei kurzem maxAgeMs-Fenster
      // vs. langem Poll-Backoff ist die explizite Flagge das ehrlichere Signal —
      // und der Log-Grund benennt die Ursache statt nur „veraltet".
      const frozen = state.victron?.freeze?.active === true;
      // T-CROSSCHECK (2026-07-25): die zweite Quelle (MQTT) widerspricht dem
      // Modbus-Bild dauerhaft → die Zahlen, auf denen eine Entladeentscheidung
      // beruhen würde, sind nachweislich falsch. Ehrliche Einordnung: hilft der
      // Steuerung nicht, wenn die Befehle ohnehin nicht ankommen (Christin,
      // 25.07.) — es verhindert nur, dass DVhub auf Basis falscher Werte NEUE
      // Entladebefehle absetzt bzw. dass ein solcher später wirksam wird.
      // Das eigentliche Signal ist der Alarm.
      const mismatched = state.victron?.sourceMismatch?.active === true;
      if (unknown || frozen || mismatched || stale || soc <= floorPct) {
        const reason = unknown ? 'soc_unknown'
          : frozen ? 'telemetry_frozen'
            : mismatched ? 'source_mismatch'
              : stale ? 'soc_stale' : 'below_hard_floor';
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
      // T-VERIFY: Read-after-Write-Verifikation planen (non-blocking, Flag-gated,
      // keine Keepalives — die re-asserten ohnehin denselben Wert zyklisch).
      maybeScheduleWriteVerify(target, conf, cfg, { isKeepalive });
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
        // T-CURTAIL-CHARGE (Christin 2026-06-25): the EOS plan may want the battery
        // to CHARGE in this surplus slot (carried on the dcExportMode rule). Reserve
        // that charge BEFORE exporting, so "100 % Einspeisung" feeds in only the real
        // surplus above the charge instead of exporting the power EOS wanted to store.
        const planChargeReserveW = Math.max(0, Number(dcScheduleRule?.chargeReserveW) || 0);
        // T-LIVESOC-RESERVE (Variante B, Christin 2026-07-22): the plan-derived
        // reserve trusts the EOS SoC trajectory — which drifts (30.06. + 21.07.:
        // export started while the real battery lagged the model, full charge
        // 25-45 min late). With the flag ON and a plan SoC target on the rule,
        // re-derive the reserve from the LIVE SoC every cycle:
        //   reserveW = (targetSoc − liveSoc) × capacityWh / slotHours
        // Self-correcting both ways: battery behind plan ⇒ reserve rises, export
        // is curtailed until it catches up; battery ahead ⇒ reserve drops to 0
        // and the export starts earlier. Clamped to [0, maxChargeW]. Any missing
        // input (flag off, no target on rule, no live SoC, no capacity) falls
        // back to the plan value — worst case is exactly today's behaviour.
        let chargeReserveW = planChargeReserveW;
        {
          const lsCfg = cfg.optimizer?.liveSocChargeReserve;
          const targetSocPct = Number(dcScheduleRule?.targetSocPct);
          const liveSocPct = Number(state.victron.soc);
          const capWh = Number(cfg.optimizer?.batteryCapacityWh) || 0;
          if (lsCfg?.enabled === true && Number.isFinite(targetSocPct)
              && Number.isFinite(liveSocPct) && liveSocPct >= 0 && capWh > 0) {
            const slotMs = (Number(dcScheduleRule.slotEndTs) || 0) - (Number(dcScheduleRule.slotTs) || 0);
            const slotH = slotMs > 0 ? Math.max(0.25 / 3, slotMs / 3600000) : 0.25;
            let liveReserveW = Math.round(((targetSocPct - liveSocPct) / 100) * capWh / slotH);
            if (liveReserveW < 0) liveReserveW = 0;
            const maxChargeW = Number(cfg.optimizer?.maxChargeW) || 0;
            if (maxChargeW > 0 && liveReserveW > maxChargeW) liveReserveW = maxChargeW;
            chargeReserveW = liveReserveW;
            // Log once per slot when the live correction deviates notably from
            // the plan — the field-test evidence trail.
            const logDeltaW = Number(lsCfg.logDeltaW) > 0 ? Number(lsCfg.logDeltaW) : 1000;
            const slotKey = String(dcScheduleRule.slotTs || dcScheduleRule.id || '');
            if (Math.abs(liveReserveW - planChargeReserveW) >= logDeltaW
                && state.ctrl._liveSocReserveSlotLogged !== slotKey) {
              pushLog('live_soc_charge_reserve', {
                targetSocPct, liveSocPct, planChargeReserveW, liveReserveW,
                slotH: Math.round(slotH * 100) / 100, capWh,
              });
              state.ctrl._liveSocReserveSlotLogged = slotKey;
            }
          }
        }
        // Batterie-Effizienz-Aufschlag (Christin 2026-06-26): bei VOLLeinspeisung
        // deckt der Eigenverbrauch-Abzug (liveLoadW) zwar die AC-Last, aber der
        // Akku-Beitrag zum Eigenverbrauch geht über die DC-AC-Wandlung — diese
        // Verluste ziehen real weiter Leistung aus dem Akku, sodass er trotzdem
        // langsam entlädt. Der Verlust skaliert mit dem Verbrauch (Christin: „je
        // nach Verbrauch höher/niedriger"), daher DYNAMISCH = Hausverbrauch ×
        // (1 − Wirkungsgrad), nicht fest. Diesen Aufschlag zusätzlich vom Export
        // zurückhalten, damit PV den Akku-Beitrag mitdeckt und der Netto-Akkustrom
        // wirklich ~0 bleibt. NUR bei Volleinspeisung (kein chargeReserve) — bei
        // Teileinspeisung lädt der Akku ohnehin. Greift nur mit aktivem Hausver-
        // brauch-Abzug (sonst liveLoadW=0 ⇒ Aufschlag 0). Knopf: batteryEfficiencyPct.
        const battEffPct = Number(cfg.dcExportMode?.batteryEfficiencyPct ?? 92);
        const battEffLossFrac = Math.min(1, Math.max(0, (100 - battEffPct) / 100));
        const battEffSurchargeW = (subtractLoad && chargeReserveW === 0)
          ? Math.round(liveLoadW * battEffLossFrac)
          : 0;
        const reserveW = liveLoadW + bufferW + chargeReserveW + battEffSurchargeW;
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
              pushLog('dc_export_mode_active', { pvW, exportW, bufferW, liveLoadW, chargeReserveW, battEffSurchargeW, subtractLoad, currentPrice });
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
      // Runs BEFORE the guards so neg-price / SoC-floor act on the live
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
      // A persistent override has no TTL and is invisible to the per-rule
      // stopSocPct floor (autoDisableStopSocScheduleRules — rules only; an
      // override has rule:null). Left unguarded it would force-discharge down to the bare
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
        // 2026-07-29 (Christin): der Puffer während der Abregelung ist DERSELBE
        // Wert wie im Normalbetrieb — der Default-Sollwert. Vorher stand hier ein
        // fest eingebautes -40, das einen eingestellten -100 für die Dauer der
        // Abregelung überschrieb. `npp.gridSetpointW` bleibt als ausdrücklicher
        // Sonderfall erhalten (wer ihn je gesetzt hat, behält sein Verhalten),
        // steht aber nicht mehr in den Einstellungen und ist kein Vorgabewert.
        // Gedeckelt, weil ein großer Default-Sollwert bei negativem Preis sonst
        // aus dem Ausregeln einen echten Verkauf machen würde.
        const bufferW = Number(npp.gridSetpointW ?? cfg.schedule?.defaultGridSetpointW ?? -40);
        const limit = Number.isFinite(bufferW)
          ? Math.min(0, Math.max(bufferW, CURTAILMENT_BUFFER_LIMIT_W))
          : -40;
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
        // 2026-07-29 (Christin): der Sollwert wird während der Abregelung auf
        // genau `limit` GEPINNT, nicht nur nach unten gedeckelt. Vorher galt
        // `eff.value < limit` — wollte eine Regel 0 (Eigenverbrauch), fiel das
        // durch und es wurde 0 geschrieben. „Null am Zähler" heißt aber, dass
        // jeder Lastsprung sofort Netzbezug erzeugt, weil die Regelung
        // hinterherläuft — und Bezug ist genau in der Abregelung teuer. `limit`
        // ist der kleine Regel-Puffer (Standard 40 W, jetzt einstellbar): es
        // wird dabei nichts nennenswert eingespeist, er fängt nur das Schwanken
        // der Ausregelung ab.
        //
        // POSITIVE Sollwerte laufen bewusst durch: bei negativen Preisen ist
        // Netzladen wirtschaftlich richtig und keine Einspeisung — das eigene
        // Gate (allowGridCharge) entscheidet darüber, nicht der Abregelungspfad.
        if (eff.value <= 0) {
          await applyControlTarget(target, limit, 'negative_price_protection');
          continue;
        }
      }

      // === T-0118 sell-price floor =========================================
      // Arbitrage export rules (forecast_optimizer / small-market) rank
      // discharge slots RELATIVE to a daily average. On solar-glut
      // days with negative midday prices the average collapses, so absolutely-
      // cheap night slots (e.g. 6 ct at 04:00) clear the relative bar and the
      // 43 kWh battery gets sold off cheap. When the current spot price is below
      // the configured floor, suppress a FORCED grid export — hold at the default
      // self-consumption setpoint so the energy stays for own load instead of a
      // cheap sale. Same shape as negativePriceProtection above. OFF when
      // minSellPriceCtKwh is unset (prior behavior).
      //
      // T-0118 (2026-06-06): the floor is NOT applied to EOS-sourced rules. EOS
      // owns the full economic decision and deliberately empties at low/cheap
      // prices before a curtailment window to free room for otherwise-curtailed
      // PV — a flat 12 ct floor would block that valid prep. The negative-price
      // guard above still applies to EVERY source (never pay to export). The
      // floor stays in force for the internal optimizer and the small-market
      // automation (eff.rule.optimizer is 'internal'/absent).
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
      } else if (state.ctrl.discretionaryWritesPaused) {
        // Issue #8 / T-0099: der Not-Halt stoppte bisher NUR applyControlTarget
        // (gridSetpoint etc.), nicht die diskretionäre PV-Abregelung — die lief
        // weiter und regelte die PV ab (gemeldet von FrodoVDR, GH #8). Im Not-Halt
        // die PV FREIGEBEN (feedIn=true), damit die Anlage wieder normal einspeist.
        // forcedOff und §51-Negativpreis (oben) behalten Vorrang — die sind mandatory.
        dcFeedIn = true;
        dcSource = 'emergency_stop_release';
      } else {
        const eff = effectiveTargetValue('feedExcessDcPv');
        dcFeedIn = eff.value != null && Number(eff.value) === 1;
        dcSource = eff.source;
      }
      await applyDvVictronControl(dcFeedIn);
      state.schedule.active.feedExcessDcPv = { value: dcFeedIn ? 1 : 0, source: dcSource, at: Date.now() };
    } else if (cfg.dvControl) {
      // #10 (FrodoVDR): Steuerung deaktiviert (Volleinspeiser / „nur beobachten") →
      // DVhub darf keine eigene Abregelung am Gerät stehen lassen. Einmalig
      // (change-detected) die Einspeisung freigeben — reg 2707/2708 bzw. die
      // CGwacs-Settings auf „frei" — dann Ruhe (kein weiterer Write). Auch beim
      // ersten Eval nach Neustart, damit eine persistente Sperre weggeräumt wird.
      // Prinzip [[feedback_neutralize_on_disable]]: was DVhub setzt, setzt es beim
      // Deaktivieren wieder zurück.
      await applyDvVictronControl(true);
      state.schedule.active.feedExcessDcPv = { value: 1, source: 'control_disabled_release', at: Date.now() };
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

  // ===========================================================================
  // B-1112 Stufe 2 — Nulleinspeisungs-Deckel (Zero-Feed-in-Loop, Christin
  // 2026-07-19). Die M124-Force-Charge-Sperre (feedExcessDcPv sequence '0')
  // deckt die Abregelung nur, solange der Akku den PV-Überschuss aufnimmt —
  // bei vollem Akku speist der GEN24 wieder ein (am Gerät verifiziert, siehe
  // fronius.json _doc). Die native Fronius-Exportbegrenzung ist NICHT
  // fernschaltbar (WebUI-Konfiguration, kein Modbus-/API-Schalter) — deshalb
  // regelt DVhub hier selbst: SunSpec Model 123 WMaxLimPct wird lastfolgend
  // auf die Hauslast geführt (5-s-Takt, integrierender Regler auf die
  // Smart-Meter-Messung), der WR drosselt dann die MPPTs. NIE auf 0 drosseln:
  // WMaxLimPct=0 legt den ganzen WR lahm und das Haus zieht Netzstrom.
  //
  // Zustandsmaschine (nur während aktiver Sperre, state.ctrl._lastDvFeedIn===false):
  //   Force-Charge (Default)  — Akku schluckt Überschuss, kein Deckel.
  //   Deckel (capActive)      — Enter bei SoC >= zeroFeedIn.socThresholdPct
  //     ODER wenn trotz Sperre Export gemessen wird (BMS-Derating o. ä.).
  //     Beim Enter wird OutWRte auf +100 % freigegeben, damit der Akku bei
  //     PV-Defizit das Haus stützen kann („der Akku muss mithelfen") — Export
  //     aus dem Akku verhindert der WMaxLimPct-Deckel physikalisch (AC-Ausgang
  //     <= Hauslast). Exit bei SoC <= Schwelle − Hysterese: OutWRte zurück auf
  //     −100 % (Force-Charge), Deckel aus.
  // Failsafe: WMaxLimPct_RvrtTms (Geräte-Timeout) — stirbt DVhub, verfällt das
  // Limit von selbst; deshalb wird WMaxLimPct jeden Tick neu geschrieben
  // (refresht das Fenster). Beim DVhub-Stop wird bewusst NICHT geschrieben —
  // der RvrtTms räumt auf (kein Modbus-I/O im Shutdown-Pfad).
  // Direkt-Writes am applyControlTarget-Gate vorbei: der Loop gehört zur
  // mandatory-Abregelungsklasse (§51/DV-forcedOff) wie applyDvVictronControl
  // selbst — er folgt via _lastDvFeedIn exakt dessen Not-Halt-Semantik
  // (emergency_stop_release setzt feedIn=true → der Loop räumt den Deckel ab).
  // Kein saveBefore/restore für OutWRte: die Kundenwerte hat die Sperr-Sequenz
  // bereits gesichert; die Freigabe-Sequenz restauriert sie unabhängig vom Loop.

  const ZFI_TICK_MS = 5000;
  const ZFI_GAIN = 0.7;               // Dämpfung des integrierenden Reglers
  const ZFI_EXPORT_ENTER_STREAK = 3;  // Export-Ticks in Folge bis Deckel-Enter
  const ZFI_READBACK_MS = 60000;      // Steuerprioritäten-Drift-Check (throttled)
  const ZFI_ERRLOG_MS = 60000;
  let zfiInterval = null;
  let zfiBusy = false;

  function zfiState() {
    return (state.ctrl._zfi ??= {
      capActive: false, limitPct: null, exportStreak: 0, blockedStreak: 0,
      lastReadbackAt: 0, lastErrLogAt: 0
    });
  }

  async function zfiWrite(pconf, value) {
    const encoded = toRawForWrite(value, pconf);
    await transport.mbWriteSingle({
      host: pconf.host, port: pconf.port, unitId: pconf.unitId,
      address: pconf.address, value: encoded.raw, timeoutMs: pconf.timeoutMs
    });
  }

  async function zeroFeedInTick() {
    if (zfiBusy || stopping) return;
    zfiBusy = true;
    try {
      const cfg = getCfg();
      const zc = cfg.dvControl?.zeroFeedIn;
      const pctConf = cfg.controlWrite?.wMaxLimPct;
      const enaConf = cfg.controlWrite?.wMaxLimEna;
      const rvrtConf = cfg.controlWrite?.wMaxLimPctRvrtTms;
      const outConf = cfg.controlWrite?.outWRte;
      const zfi = zfiState();
      // Profil ohne Feature / Punkte (noch) nicht per SunSpec-Scan aufgelöst →
      // still bleiben. Ein am Gerät stehender Deckel verfällt über RvrtTms.
      if (!zc?.enabled || transport.type !== 'modbus') return;
      if (!pctConf?.enabled || pctConf.address == null) return;
      if (!enaConf?.enabled || enaConf.address == null) return;

      const blocked = state.ctrl._lastDvFeedIn === false;
      if (!blocked) {
        zfi.exportStreak = 0;
        zfi.blockedStreak = 0;
        if (zfi.capActive) {
          // Freigabe (Preis positiv / Not-Halt-Release / DV-Ende): nur den
          // Deckel abräumen — OutWRte hat die restore-Sequenz schon gesetzt.
          await zfiWrite(enaConf, 0);
          zfi.capActive = false;
          zfi.limitPct = null;
          pushLog('zero_feedin_cap_off', { reason: 'feedin_restored' });
          telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
            eventType: 'zero_feedin_cap_off', target: 'wMaxLimPct',
            valueNum: null, reason: 'feedin_restored', source: 'runtime', meta: {}
          }));
        }
        return;
      }
      zfi.blockedStreak += 1;

      const uc = cfg.zeroFeedIn || {};
      const thresholdPct = Number(uc.socThresholdPct ?? 95);
      const hysteresisPct = Number(uc.socHysteresisPct ?? 5);
      const targetImportW = Number(uc.targetGridImportW ?? 50);
      const deadbandW = Number(uc.deadbandW ?? 50);
      const revertTimeoutS = Number(uc.revertTimeoutS ?? 300);
      // %-Referenz: nur Regler-Gain/Startwert — der integrierende Regler
      // konvergiert auch bei ungenauer Nennleistung gegen Export ≈ 0.
      // Kanonische Quelle = Leistungs-Kette (T-0126, systemPower → legacy).
      const refW = Number(getPowerLimits(cfg).inverterMaxPowerW) || 10000;

      const maxAgeMs = Number(cfg.victron?.telemetryMaxAgeMs) || 90000;
      // victronFieldAgeMs, nicht victronFieldStale: ein NIE gepollter SoC
      // (fieldUpdatedAt fehlt) ist "unbekannt", nicht "frisch" (T-0075-Gotcha).
      const socAge = victronFieldAgeMs(state, 'soc');
      const socFresh = socAge !== null && socAge <= maxAgeMs;
      const soc = Number(state.victron?.soc);
      const meterFresh = state.meter?.ok === true
        && (Date.now() - Number(state.meter.updatedAt || 0)) < 15000;
      const importW = Math.max(0, Number(state.victron?.gridImportW || 0));
      const exportW = Math.max(0, Number(state.victron?.gridExportW || 0));
      const loadW = Math.max(0, Number(state.victron?.selfConsumptionW || 0));

      if (!zfi.capActive) {
        const socEnter = socFresh && Number.isFinite(soc) && soc >= thresholdPct;
        // Export trotz Force-Charge = Akku nimmt nichts mehr (voll/Derating) —
        // auch unterhalb der SoC-Schwelle greift dann der Deckel.
        zfi.exportStreak = (meterFresh && exportW > deadbandW) ? zfi.exportStreak + 1 : 0;
        const exportEnter = zfi.exportStreak >= ZFI_EXPORT_ENTER_STREAK;
        // blockedStreak >= 2: nie im selben Tick einschalten, in dem die Sperre
        // gerade erst geschrieben wurde/wird (Race gegen die Freigabe-Sequenz).
        if ((socEnter || exportEnter) && zfi.blockedStreak >= 2 && meterFresh) {
          zfi.limitPct = Math.min(100, Math.max(0, (100 * Math.max(0, loadW - targetImportW)) / refW));
          if (outConf?.enabled && outConf.address != null) await zfiWrite(outConf, 100);
          if (rvrtConf?.enabled && rvrtConf.address != null) await zfiWrite(rvrtConf, revertTimeoutS);
          await zfiWrite(pctConf, zfi.limitPct);
          await zfiWrite(enaConf, 1);
          zfi.capActive = true;
          zfi.exportStreak = 0;
          pushLog('zero_feedin_cap_on', {
            trigger: socEnter ? 'soc' : 'export', soc: Number.isFinite(soc) ? soc : null,
            limitPct: Number(zfi.limitPct.toFixed(2)), loadW, exportW
          });
          telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
            eventType: 'zero_feedin_cap_on', target: 'wMaxLimPct',
            valueNum: Number(zfi.limitPct.toFixed(2)),
            reason: socEnter ? 'soc' : 'export', source: 'runtime',
            meta: { soc: Number.isFinite(soc) ? soc : null, loadW, exportW }
          }));
        }
        return;
      }

      // --- Deckel aktiv: Exit prüfen, sonst regeln + Failsafe-Fenster refreshen.
      if (socFresh && Number.isFinite(soc) && soc <= thresholdPct - hysteresisPct) {
        // Reihenfolge: erst Force-Charge wieder scharf, dann Deckel aus — so
        // gibt es kein Fenster, in dem weder Akku-Zwang noch Deckel steht.
        if (outConf?.enabled && outConf.address != null) await zfiWrite(outConf, -100);
        await zfiWrite(enaConf, 0);
        zfi.capActive = false;
        zfi.limitPct = null;
        pushLog('zero_feedin_cap_off', { reason: 'soc_recovered', soc });
        telemetrySafeWrite(() => ctx.telemetryStore?.writeControlEvent({
          eventType: 'zero_feedin_cap_off', target: 'wMaxLimPct',
          valueNum: null, reason: 'soc_recovered', source: 'runtime', meta: { soc }
        }));
        return;
      }

      if (meterFresh) {
        // Integrierender Regler: Ziel = leichter Netzbezug (targetImportW),
        // damit die Quantisierungs-/Latenzfehler in Richtung Bezug statt
        // Einspeisung fallen. err > 0 → zu wenig Bezug/Export → Limit senken.
        const signedGridW = importW - exportW;
        const err = targetImportW - signedGridW;
        if (Math.abs(err) > deadbandW) {
          zfi.limitPct = Math.min(100, Math.max(0, zfi.limitPct - (100 * ZFI_GAIN * err) / refW));
        }
      }
      // Meter stale → Limit einfrieren, aber weiter schreiben: der Write
      // refresht das RvrtTms-Fenster (sonst verfiele der Deckel mitten in der
      // Abregelung); Ena wird re-asserted (Gerät könnte nach eigenem Revert
      // oder Neustart auf Normalbetrieb zurückgefallen sein).
      await zfiWrite(pctConf, zfi.limitPct);
      await zfiWrite(enaConf, 1);

      // Readback-Drift-Check (throttled): Steuerprioritäten am WR (IO-Steuerung >
      // dyn. Leistungsreduzierung > Modbus) können Writes still ignorieren.
      const now = Date.now();
      if (now - zfi.lastReadbackAt >= ZFI_READBACK_MS) {
        zfi.lastReadbackAt = now;
        try {
          const regs = await transport.mbRequest({
            fc: 3, host: pctConf.host, port: pctConf.port, unitId: pctConf.unitId,
            address: pctConf.address, quantity: 1, timeoutMs: pctConf.timeoutMs
          });
          const readPct = Number(regs?.[0]) * Number(pctConf.scale ?? 1);
          if (Number.isFinite(readPct) && Math.abs(readPct - zfi.limitPct) > 1) {
            pushLog('zero_feedin_readback_mismatch', {
              wrotePct: Number(zfi.limitPct.toFixed(2)), readPct: Number(readPct.toFixed(2))
            }, 'warn');
          }
        } catch { /* Readback ist Diagnose — nie den Regel-Tick brechen */ }
      }
    } catch (e) {
      const zfi = zfiState();
      const now = Date.now();
      if (now - zfi.lastErrLogAt >= ZFI_ERRLOG_MS) {
        zfi.lastErrLogAt = now;
        pushLog('zero_feedin_write_error', { error: e?.message || String(e) }, 'warn');
      }
    } finally {
      zfiBusy = false;
    }
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
    // Zero-Feed-in-Deckel: fester 5-s-Takt (Regelkreis-Kadenz wie der Victron-
    // Setpoint-Pfad). Der Tick guarded sich selbst heraus, wenn das Profil das
    // Feature nicht deklariert — auf Victron-Anlagen bleibt er ein No-op.
    zfiInterval = safeInterval('schedule-eval.zero-feedin',
      () => { zeroFeedInTick().catch(() => { /* zfi loggt selbst (throttled) */ }); },
      ZFI_TICK_MS);
  }

  function stop() {
    stopping = true;
    if (evalTimeout) { clearTimeout(evalTimeout); evalTimeout = null; }
    if (zfiInterval) { clearInterval(zfiInterval); zfiInterval = null; }
    // Bewusst KEIN Modbus-Write im Stop-Pfad (Shutdown-Hänger-Historie) — ein
    // aktiver Deckel am Gerät verfällt über WMaxLimPct_RvrtTms von selbst.
  }

  return { evaluateSchedule, applyControlTarget, applyDvVictronControl, zeroFeedInTick, start, stop };
}
