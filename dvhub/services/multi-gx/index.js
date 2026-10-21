/**
 * multi-gx/index.js — Laufzeitdienst fuer eine zweite Victron-GX-Anlage am
 * selben Netzanschluss (ohne PV, ohne eigenen Zaehler; Chrissi 21.10.2026).
 *
 * Eigener, traeger Takt (5 s) neben dem Steuerpfad der Hauptanlage: DVhub liest
 * an der zweiten GX Ladestand (843), Akkuleistung (842) und Mindest-SoC (2901),
 * rechnet mit follower-controller.js ihren Anteil an der gesamten Akkuleistung
 * und schreibt ihren Netz-Sollwert 2716/2717 (int32). Das Register ist fluechtig
 * (faellt ohne Nachfuehren zurueck, siehe T-0107) → jeden Takt schreiben.
 *
 * Der Schreibpfad der Hauptanlage (schedule-eval applyControlTarget) bleibt
 * unberuehrt: Sie regelt den Anschluss weiter auf DVhubs Netz-Sollwert und
 * gleicht ueber ihren Zaehler aus, was die zweite Anlage tut.
 *
 * Schutz: Not-Halt → sofort 0. Direktvermarkter-Abregelung oder negativer Preis
 * → die zweite Anlage schiebt nichts ins Hausnetz (Sollwert >= 0). Drei
 * Fehlversuche → offline, Sollwert 0, EOS rechnet ohne ihren Akku.
 * Eigener Modbus-Pool (server.js), damit eine haengende zweite GX die
 * Hauptanlage nie ausbremst.
 *
 * @module services/multi-gx
 */
import { createFollowerController } from './follower-controller.js';
import { safeInterval } from '../safe-async.js';
import { betaGateOpen } from '../../beta-features.js';

export const MULTI_GX_TICK_MS = 5000;
const REG = { soc: 843, batteryPowerW: 842, minSocPct: 2901, setpoint: 2716 };
const OFFLINE_AFTER_ERRORS = 3;
const TIMEOUT_MS = 1500;

const int16 = (raw) => (raw > 0x7fff ? raw - 0x10000 : raw);

function int32Words(v) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(v), 0);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
}

const finite = (v) => v != null && Number.isFinite(Number(v));

/** Wirksamer Schalter: nur mit Beta-Freigabe (Bleeding-Edge-Kanal), siehe test/beta-gate.test.js. */
export function resolveMultiGxOptions(cfg = {}) {
  return { enabled: cfg?.multiGx?.enabled === true && betaGateOpen(cfg, 'multiGx') };
}

export function createMultiGx(ctx, deps = {}) {
  const transport = deps.transport;
  const now = deps.now || Date.now;
  let controller = null;
  let controllerKey = '';
  let errors = 0;
  let online = null;
  let active = false;
  let timer = null;
  const side = { socPct: null, batteryPowerW: null, minSocPct: null, at: 0 };

  function conf() {
    const cfg = ctx.getCfg() || {};
    const c = cfg.multiGx || {};
    return {
      enabled: resolveMultiGxOptions(cfg).enabled,
      host: String(c.host || '').trim(),
      port: Number(c.port) || 502,
      unitId: Number.isFinite(Number(c.unitId)) ? Number(c.unitId) : 100,
      capacityWh: Number(c.batteryCapacityWh) || 0,
      maxChargeW: Number(c.maxChargeW) || 0,
      maxDischargeW: Number(c.maxDischargeW) || 0,
      minSocPct: finite(c.minSocPct) ? Number(c.minSocPct) : 10,
      rampWPerS: finite(c.rampWPerS) ? Number(c.rampWPerS) : undefined,
      deadbandW: finite(c.deadbandW) ? Number(c.deadbandW) : undefined,
    };
  }

  function publish(extra) {
    ctx.state.multiGx = {
      enabled: false, online: null, socPct: null, batteryPowerW: null, minSocPct: null,
      setpointW: 0, desiredBatteryW: 0, sharePct: null, totalBatteryW: null, reason: null, errors, updatedAt: now(),
      ...extra,
    };
  }

  async function read(c, name, fc, scale = 1, signed = false) {
    const regs = await transport.mbRequest({ host: c.host, port: c.port, unitId: c.unitId, fc, address: REG[name], quantity: 1, timeoutMs: TIMEOUT_MS });
    const raw = Number(regs?.[0]);
    if (!Number.isFinite(raw)) throw new Error(`multi-gx: ${name} unlesbar`);
    return (signed ? int16(raw) : raw) * scale;
  }

  async function write(c, value) {
    await transport.mbWriteMultiple({ host: c.host, port: c.port, unitId: c.unitId, address: REG.setpoint, values: int32Words(value), timeoutMs: TIMEOUT_MS });
  }

  async function tick() {
    const c = conf();
    if (!c.enabled || !c.host) {
      if (active && c.host) {
        // Einmal neutral hinterlassen; das Register faellt ohnehin von selbst zurueck.
        try { await write(c, 0); } catch { /* best effort */ }
      }
      active = false; controller = null; controllerKey = ''; errors = 0; online = null;
      publish({ enabled: c.enabled, reason: c.enabled ? 'not_configured' : 'disabled' });
      return;
    }
    active = true;

    const key = JSON.stringify([c.host, c.port, c.unitId, c.maxChargeW, c.maxDischargeW, c.rampWPerS, c.deadbandW]);
    if (key !== controllerKey) {
      controller = createFollowerController({ maxChargeW: c.maxChargeW, maxDischargeW: c.maxDischargeW, rampWPerS: c.rampWPerS, deadbandW: c.deadbandW });
      controllerKey = key;
    }

    try {
      side.socPct = await read(c, 'soc', 4);
      side.batteryPowerW = await read(c, 'batteryPowerW', 4, 1, true);
      try { side.minSocPct = await read(c, 'minSocPct', 4, 0.1); } catch { side.minSocPct = null; }
      side.at = now();
      errors = 0;
      if (online === false) ctx.pushLog?.('multi_gx_online', { host: c.host });
      online = true;
    } catch (e) {
      errors += 1;
      if (errors >= OFFLINE_AFTER_ERRORS && online !== false) {
        online = false;
        ctx.pushLog?.('multi_gx_offline', { host: c.host, error: e?.message || String(e) });
      }
    }

    const cfg = ctx.getCfg() || {};
    const v = ctx.state.victron || {};
    const ctrl = ctx.state.ctrl || {};
    const primaryFresh = finite(v.batteryPowerW) && !v.errors?.batteryPowerW;
    const out = controller.tick({
      nowMs: now(),
      online: online !== false,
      stop: ctrl.discretionaryWritesPaused === true,
      exportBlocked: ctrl.forcedOff === true || ctrl.negativePriceActive === true,
      primaryBatteryW: primaryFresh ? Number(v.batteryPowerW) : null,
      followerBatteryW: online === true ? side.batteryPowerW : null,
      primary: { socPct: v.soc, minSocPct: v.minSocPct, maxSocPct: cfg.optimizer?.maxSocPct ?? 100, capacityWh: cfg.optimizer?.batteryCapacityWh },
      follower: { socPct: side.socPct, minSocPct: side.minSocPct ?? c.minSocPct, maxSocPct: 100, capacityWh: c.capacityWh },
    });

    if (online === true) {
      try { await write(c, out.setpointW); } catch (e) { errors += 1; ctx.pushLog?.('multi_gx_write_error', { error: e?.message || String(e) }); }
    }
    publish({
      enabled: true, online: online === true,
      socPct: online === true ? side.socPct : null,
      batteryPowerW: online === true ? side.batteryPowerW : null,
      minSocPct: side.minSocPct ?? c.minSocPct,
      setpointW: out.setpointW, desiredBatteryW: out.desiredFollowerBatteryW, sharePct: out.followerWeightPct,
      totalBatteryW: out.totalBatteryW, reason: out.reason,
    });
  }

  function start() {
    if (timer) return;
    publish({ enabled: conf().enabled, reason: 'starting' });
    timer = safeInterval('multi-gx', tick, MULTI_GX_TICK_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, status: () => ctx.state.multiGx || null };
}
