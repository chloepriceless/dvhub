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
import { gridImportW } from '../optimizer/grid-storage.js';
import { getPowerLimits } from '../power-limits.js';

export const MULTI_GX_TICK_MS = 5000;
// 820–822: Netz L1–L3 des Systems; ohne eigenen Zaehler meldet die GX dort den
// AC-IN des Multis (systemcalc) — genau die Leistung, die der Sollwert stellt.
const REG = { soc: 843, batteryPowerW: 842, minSocPct: 2901, setpoint: 2716, acIn: 820 };
const OFFLINE_AFTER_ERRORS = 3;
const TIMEOUT_MS = 1500;
const PRIMARY_MAX_AGE_MS = 30000;

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

/**
 * Wechselt die zweite Anlage zwischen steuerbar und nicht steuerbar, aendert sich
 * der Akku, mit dem EOS plant. Erst das Akku-Modell an EOS (sync), und NUR wenn
 * das geklappt hat, neu planen — sonst plante EOS mit alter Kapazitaet und neuem
 * Ladestand (Codex Runde 2: sync() meldet Fehler als {ok:false}, wirft nicht).
 * Fehlschlag → nach retryMs erneut, hoechstens maxRetries-mal; ein neuer Wechsel
 * ersetzt einen laufenden Versuch.
 */
export function createEosResyncOnAvailability({ sync, replan, pushLog = () => {}, retryMs = 60000, maxRetries = 3, setTimer = setTimeout } = {}) {
  let generation = 0;
  async function attempt(included, gen, retry) {
    if (gen !== generation) return;
    let result;
    try { result = await sync(); } catch (e) { result = { ok: false, errors: { sync: e?.message || String(e) } }; }
    if (gen !== generation) return;
    if (result?.ok !== false) {
      replan(included ? 'multi_gx_online' : 'multi_gx_offline');
      return;
    }
    pushLog('multi_gx_eos_resync_failed', { included, retry, errors: result?.errors || null });
    if (retry < maxRetries) setTimer(() => attempt(included, gen, retry + 1), retryMs);
  }
  return (included) => {
    generation += 1;
    return attempt(included === true, generation, 0);
  };
}

export function createMultiGx(ctx, deps = {}) {
  const transport = deps.transport;
  const now = deps.now || Date.now;
  let controller = null;
  let controllerKey = '';
  let readErrors = 0;
  let writeErrors = 0;
  let running = false;
  let online = null;
  let active = false;
  let timer = null;
  const side = { socPct: null, batteryPowerW: null, minSocPct: null, acInW: null, at: 0 };

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
      enabled: false, online: null, socPct: null, batteryPowerW: null, acInW: null, minSocPct: null,
      setpointW: 0, desiredBatteryW: 0, sharePct: null, totalBatteryW: null, reason: null, errors: readErrors + writeErrors, updatedAt: now(),
      ...extra,
    };
  }

  async function read(c, name, fc, scale = 1, signed = false) {
    const regs = await transport.mbRequest({ host: c.host, port: c.port, unitId: c.unitId, fc, address: REG[name], quantity: 1, timeoutMs: TIMEOUT_MS });
    const raw = Number(regs?.[0]);
    if (!Number.isFinite(raw)) throw new Error(`multi-gx: ${name} unlesbar`);
    return (signed ? int16(raw) : raw) * scale;
  }

  async function readAcIn(c) {
    const regs = await transport.mbRequest({ host: c.host, port: c.port, unitId: c.unitId, fc: 4, address: REG.acIn, quantity: 3, timeoutMs: TIMEOUT_MS });
    if (!Array.isArray(regs) || regs.length < 3) throw new Error('multi-gx: AC-IN unlesbar');
    return regs.slice(0, 3).reduce((sum, raw) => sum + int16(Number(raw)), 0);
  }

  async function write(c, value) {
    await transport.mbWriteMultiple({ host: c.host, port: c.port, unitId: c.unitId, address: REG.setpoint, values: int32Words(value), timeoutMs: TIMEOUT_MS });
  }

  // Ungedeckter Bedarf: Netzbezug ueber dem Sollwert der Hauptanlage, aber nur,
  // wenn sie ihn nicht selbst decken kann (leer oder an der Leistungsgrenze)
  // oder das Haus wirklich bezieht. Eine Einspeisegrenze haelt das Netz auch
  // ueber dem Sollwert — dann laedt die Hauptanlage, und die zweite darf nicht
  // in sie hinein entladen.
  // Vorzeichen: + = Entladebedarf (Netz bezieht mehr als der Sollwert),
  // − = Ladebedarf (Netz bezieht weniger als der Sollwert, Hauptanlage voll oder
  // an ihrer Ladegrenze). Grenzen: Akku-Leistung UND Wechselrichter (das
  // Kleinere; Codex-Gegenpruefung Runde 2).
  function unmetW(cfg, v, primaryBatteryW) {
    const m = ctx.state.meter || {};
    if (m.ok === false || primaryBatteryW == null) return 0;
    const importW = gridImportW(m.grid_total_w, cfg.gridPositiveMeans);
    if (importW == null || !finite(v.gridSetpointW)) return 0;
    const excess = importW - Number(v.gridSetpointW);
    const inverterW = getPowerLimits(cfg).limits.inverterMaxPowerW;
    const limit = (w) => (w > 0 ? Math.min(w, inverterW || w) : inverterW || 0);
    if (excess > 0) {
      const floor = finite(v.minSocPct) ? Number(v.minSocPct) : Number(cfg.optimizer?.hardFloorSocPct ?? 5);
      const primaryEmpty = finite(v.soc) && Number(v.soc) <= floor + 1;
      const maxDis = limit(Number(cfg.optimizer?.maxDischargeW) || 0);
      const primaryAtLimit = maxDis > 0 && -primaryBatteryW >= 0.95 * maxDis;
      return importW > 100 || primaryEmpty || primaryAtLimit ? excess : 0;
    }
    if (excess < 0) {
      const maxSoc = Number(cfg.optimizer?.maxSocPct ?? 100);
      const primaryFull = finite(v.soc) && Number(v.soc) >= maxSoc - 1;
      const maxCh = limit(Number(cfg.optimizer?.maxChargeW) || 0);
      const primaryAtLimit = maxCh > 0 && primaryBatteryW >= 0.95 * maxCh;
      return primaryFull || primaryAtLimit ? excess : 0;
    }
    return 0;
  }

  // Messwerte der Hauptanlage nur, wenn sie frisch und glaubwuerdig sind —
  // dieselben Wachen wie der Entlade-Boden in schedule-eval (T-0075, Einfrier-
  // Waechter, Kreuzprobe).
  function primaryBattery(v) {
    if (!finite(v.batteryPowerW) || v.errors?.batteryPowerW) return null;
    if (v.freeze?.active === true || v.sourceMismatch?.active === true) return null;
    const at = v.fieldUpdatedAt?.batteryPowerW;
    if (finite(at) && now() - Number(at) > PRIMARY_MAX_AGE_MS) return null;
    return Number(v.batteryPowerW);
  }

  function setAvailable(next, host, error) {
    if (next === online) return;
    const was = online;
    online = next;
    if (next === false) ctx.pushLog?.('multi_gx_offline', { host, error: error || null });
    if (next === true && was === false) ctx.pushLog?.('multi_gx_online', { host });
    // EOS rechnet mit beiden Akkus nur, solange die zweite Anlage steuerbar ist →
    // bei jedem Wechsel neu abgleichen (server.js: EOS-Sync + Neuplan).
    try { ctx.onMultiGxAvailability?.(next === true); } catch { /* Anzeige-/Planungsfehler nie in den Regeltakt */ }
  }

  async function tick() {
    // Ein langsamer GX darf keine Takte stapeln (Codex 21.10.): laeuft einer, faellt der naechste aus.
    if (running) return;
    running = true;
    try { await runTick(); } finally { running = false; }
  }

  async function runTick() {
    const c = conf();
    if (!c.enabled || !c.host) {
      if (active && c.host) {
        // Einmal neutral hinterlassen; das Register faellt ohnehin von selbst zurueck.
        try { await write(c, 0); } catch { /* best effort */ }
      }
      if (online === true) setAvailable(null);
      active = false; controller = null; controllerKey = ''; readErrors = 0; writeErrors = 0; online = null;
      publish({ enabled: c.enabled, reason: c.enabled ? 'not_configured' : 'disabled' });
      return;
    }
    active = true;

    const key = JSON.stringify([c.host, c.port, c.unitId, c.maxChargeW, c.maxDischargeW, c.rampWPerS, c.deadbandW]);
    if (key !== controllerKey) {
      controller = createFollowerController({ maxChargeW: c.maxChargeW, maxDischargeW: c.maxDischargeW, rampWPerS: c.rampWPerS, deadbandW: c.deadbandW });
      controllerKey = key;
    }

    let readOk = false;
    let lastError = null;
    try {
      side.socPct = await read(c, 'soc', 4);
      side.batteryPowerW = await read(c, 'batteryPowerW', 4, 1, true);
      try { side.minSocPct = await read(c, 'minSocPct', 4, 0.1); } catch { side.minSocPct = null; }
      try { side.acInW = await readAcIn(c); } catch { side.acInW = null; }
      side.at = now();
      readErrors = 0;
      readOk = true;
    } catch (e) {
      readErrors += 1;
      lastError = e?.message || String(e);
    }
    // Steuerbar = lesbar UND der Sollwert kommt an; drei Fehlversuche in Folge
    // bei einem von beiden → nicht verfuegbar.
    if (readErrors >= OFFLINE_AFTER_ERRORS || writeErrors >= OFFLINE_AFTER_ERRORS) setAvailable(false, c.host, lastError || 'write_failed');

    const cfg = ctx.getCfg() || {};
    const v = ctx.state.victron || {};
    const ctrl = ctx.state.ctrl || {};
    const pB = primaryBattery(v);
    const out = controller.tick({
      nowMs: now(),
      online: online !== false,
      stop: ctrl.discretionaryWritesPaused === true,
      exportBlocked: ctrl.forcedOff === true || ctrl.negativePriceActive === true,
      primaryBatteryW: pB,
      followerBatteryW: readOk ? side.batteryPowerW : null,
      followerAcInW: readOk ? side.acInW : null,
      unmetW: unmetW(cfg, v, pB),
      primary: { socPct: v.soc, minSocPct: v.minSocPct, maxSocPct: cfg.optimizer?.maxSocPct ?? 100, capacityWh: cfg.optimizer?.batteryCapacityWh },
      follower: { socPct: side.socPct, minSocPct: side.minSocPct ?? c.minSocPct, maxSocPct: 100, capacityWh: c.capacityWh },
    });

    // Geschrieben wird nach jedem erfolgreichen Lesen — auch, wenn die Anlage
    // gerade als nicht verfuegbar gilt, damit eine Erholung erkannt wird.
    if (readOk) {
      try {
        await write(c, out.setpointW);
        writeErrors = 0;
        setAvailable(true, c.host);
      } catch (e) {
        writeErrors += 1;
        if (writeErrors === 1) ctx.pushLog?.('multi_gx_write_error', { error: e?.message || String(e) });
        if (writeErrors >= OFFLINE_AFTER_ERRORS) setAvailable(false, c.host, e?.message || String(e));
      }
    }
    const ok = online === true;
    publish({
      enabled: true, online: ok,
      socPct: ok ? side.socPct : null,
      batteryPowerW: ok ? side.batteryPowerW : null,
      acInW: ok ? side.acInW : null,
      minSocPct: side.minSocPct ?? c.minSocPct,
      setpointW: ok ? out.setpointW : 0, desiredBatteryW: out.desiredFollowerBatteryW, sharePct: out.followerWeightPct,
      totalBatteryW: out.totalBatteryW, reason: ok || online === null ? out.reason : 'follower_offline',
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
