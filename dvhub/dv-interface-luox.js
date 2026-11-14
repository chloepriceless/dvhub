// dv-interface-luox.js -- Modbus-Registerbelegung LUOX/Lumenaza (Stand 02.06.2026).
//
// DVhub spricht zum Direktvermarkter wahlweise das Plexlog-Profil (bisher,
// Standard) oder dieses. Umschalter: dvInterface.profile = 'plexlog' | 'luox'.
//
// Input-Register (FC4, nur lesen), 32-Bit-Werte Little-Endian = niederwertiges
// Wort zuerst:
//   0–1  i32  W   Einspeiseleistung am Netzübergabepunkt (+ Einspeisung, − Bezug)
//   2–3  u32  W   Produktionsleistung der Anlage
//   4    u16  %   Wirkleistungsvorgabe Netzbetreiber (100 = volle Einspeisung)
//   5–6  u32  W   Referenzleistung / Leistung ohne Abregelung (Wp)
// Holding-Register (FC3 lesen, FC6/FC16 schreiben):
//   2    u16  %   Wirkleistungsvorgabe Direktvermarkter (0–100, auch Zwischenwerte)
//   3–4  u32  -   Watchdog: 15 min nicht neu beschrieben → Einspeisung wieder 100 %
//
// Input- und Holding-Register sind getrennte Bereiche (Plexlog teilt einen).

export const DV_INTERFACE_PROFILES = Object.freeze(['plexlog', 'luox']);
export const LUOX_WATCHDOG_MS = 15 * 60 * 1000;
export const LUOX_HOLDING_SETPOINT = 2;
export const LUOX_HOLDING_WATCHDOG = 3;

export function dvInterfaceProfile(cfg) {
  const p = cfg?.dvInterface?.profile;
  return DV_INTERFACE_PROFILES.includes(p) ? p : 'plexlog';
}

function i32Words(value) {
  const n = Math.round(Number(value) || 0);
  const x = Math.max(-0x80000000, Math.min(0x7fffffff, n)) >>> 0;
  return [x & 0xffff, (x >>> 16) & 0xffff];
}

function u32Words(value) {
  const n = Math.max(0, Math.min(0xffffffff, Math.round(Number(value) || 0)));
  return [n % 0x10000, Math.floor(n / 0x10000)];
}

export function wordsToU32(lo, hi) {
  return (Number(hi) & 0xffff) * 0x10000 + (Number(lo) & 0xffff);
}

// Einspeisung positiv, Bezug negativ — unabhängig davon, wie der Zähler
// angeschlossen ist (grid_total_w folgt gridPositiveMeans).
export function luoxFeedInW(state, cfg) {
  const total = Number(state?.meter?.grid_total_w);
  if (!Number.isFinite(total)) return 0;
  return cfg?.gridPositiveMeans === 'grid_import' ? -total : total;
}

// Referenzleistung: fest eingestellt, sonst Summe der PV-Anlagen (kWp × 1000).
export function luoxReferencePowerW(cfg) {
  const fixed = Number(cfg?.dvInterface?.luox?.referencePowerW);
  if (Number.isFinite(fixed) && fixed > 0) return Math.round(fixed);
  const plants = Array.isArray(cfg?.userEnergyPricing?.pvPlants) ? cfg.userEnergyPricing.pvPlants : [];
  const kwp = plants.reduce((sum, p) => sum + (Number(p?.kwp) > 0 ? Number(p.kwp) : 0), 0);
  return Math.round(kwp * 1000);
}

export function luoxInputRegisters(state, cfg) {
  const pvW = Math.max(0, Number(state?.victron?.pvTotalW) || 0);
  // Eine Vorgabe des Netzbetreibers kennt DVhub nicht — volle Einspeisung.
  const gridOperatorPct = 100;
  return [
    ...i32Words(luoxFeedInW(state, cfg)),
    ...u32Words(pvW),
    gridOperatorPct,
    ...u32Words(luoxReferencePowerW(cfg)),
  ];
}

export function luoxHoldingRegisters(luox) {
  const setpoint = Number.isFinite(luox?.setpointPct) ? luox.setpointPct : 100;
  const wd = Array.isArray(luox?.watchdog) ? luox.watchdog : [0, 0];
  return [0, 0, setpoint, wd[0] & 0xffff, wd[1] & 0xffff];
}

// Input-Register (FC4) nach der ECHTEN Plexlog-Belegung — abgeleitet aus dem
// dekompilierten Gerätecode (MIClientHandle.cs, RequestReceivedEvent_handler,
// FC4), am echten Plexlog-Gerät am 14.11.2026 gegengemessen:
//   0–1  i32  W  Einspeisung am Netzanschlusspunkt (+ Einspeisung / − Bezug)
//   3–4  i32  W  Referenz-/Anlagenleistung (totalpowerproduction)
//   5–6  i32  W  einstrahlungsbasierter Schätzwert (kennt DVhub nicht → 0)
//   7–8  i32  W  aktuelle Produktion
//   10–11 i32    Spiegel der Soll-Wirkleistung (Holding 0)
//   13    i16    Spiegel des Watchdog (Holding 3)
// LUOX liest davon FC4 0–1 und 3–4. Registerbelegung ist ein durchgehender
// Block (anders als LUOX/Lumenaza, wo Input und Holding getrennt sind).
export function plexlogInputRegisters(state, cfg) {
  const dvRegs = state?.dvRegs || {};
  const prodW = Math.max(0, Number(state?.victron?.pvTotalW) || 0);
  const regs = new Array(14).fill(0);
  const feed = i32Words(luoxFeedInW(state, cfg));
  regs[0] = feed[0]; regs[1] = feed[1];
  const ref = i32Words(luoxReferencePowerW(cfg));
  regs[3] = ref[0]; regs[4] = ref[1];
  const prod = i32Words(prodW);
  regs[7] = prod[0]; regs[8] = prod[1];
  // Ab Register 10 spiegelt das Gerät die Holding-Register (zuletzt geschrieben).
  regs[10] = Number(dvRegs[0] ?? 0) & 0xffff;
  regs[11] = Number(dvRegs[1] ?? 0) & 0xffff;
  regs[13] = Number(dvRegs[3] ?? 0) & 0xffff;
  return regs;
}

export function readWindow(registers, addr, qty) {
  const out = [];
  for (let i = 0; i < qty; i++) out.push(Number(registers[addr + i] ?? 0) & 0xffff);
  return out;
}

/**
 * Schreibzugriff auf die Holding-Register auswerten (ohne Seiteneffekte).
 * @returns {{ error?: number, setpointPct?: number, watchdog?: number[] }}
 *   error = Modbus-Exception-Code (3 = unzulässiger Wert); sonst die Änderungen.
 */
export function luoxApplyWrite(luox, addr, values) {
  const result = {};
  const wd = Array.isArray(luox?.watchdog) ? [...luox.watchdog] : [0, 0];
  let watchdogTouched = false;
  for (let i = 0; i < values.length; i++) {
    const a = addr + i;
    const v = Number(values[i]) & 0xffff;
    if (a === LUOX_HOLDING_SETPOINT) {
      if (v > 100) return { error: 3 };
      result.setpointPct = v;
    } else if (a === LUOX_HOLDING_WATCHDOG || a === LUOX_HOLDING_WATCHDOG + 1) {
      wd[a - LUOX_HOLDING_WATCHDOG] = v;
      watchdogTouched = true;
    }
    // Andere Adressen sind in der Belegung nicht vorgesehen: angenommen, ohne Wirkung.
  }
  if (watchdogTouched) result.watchdog = wd;
  return result;
}

/**
 * Wirkleistungsvorgabe des Direktvermarkters in Prozent umsetzen.
 *   100 → volle Einspeisung (Sperre und Teilgrenze aufheben)
 *     0 → keine Einspeisung (bestehende DV-Abregelung wie bei Plexlog)
 *  1–99 → Einspeisegrenze = Prozent × Referenzleistung über den Steuerpunkt
 *         controlWrite.dvFeedInLimitW (Victron 2706; alter Wert wird gesichert
 *         und danach zurückgeschrieben). Fehlt der Steuerpunkt oder die
 *         Referenzleistung, oder schlägt das Schreiben fehl, wird sicherheits-
 *         halber ganz abgeregelt — weniger einspeisen erfüllt die Vorgabe immer.
 * Die Vorgabe gilt, solange das Watchdog-Register mindestens alle 15 min neu
 * beschrieben wird (statt der festen Plexlog-Lease offLeaseMs); ohne Watchdog-
 * Schreibvorgang zählt die Frist ab dem Setzen der Vorgabe.
 */
export function createDvLimitController({
  state, getCfg, setForcedOff, clearForcedOff, applyDvFeedInLimit, pushLog = () => {}, writeControlEvent = () => {},
  now = () => Date.now(),
}) {
  const luox = () => (state.dvLuox ??= { setpointPct: 100, watchdog: [0, 0], watchdogAt: null });

  function leaseUntil() {
    const at = Number(luox().watchdogAt);
    return (Number.isFinite(at) && at > 0 ? at : now()) + LUOX_WATCHDOG_MS;
  }

  function watchdogRefresh() {
    luox().watchdogAt = now();
    const until = leaseUntil();
    if (state.ctrl.forcedOff) state.ctrl.offUntil = until;
    if (state.ctrl.dvLimitPct != null) state.ctrl.dvLimitUntil = until;
  }

  function releaseLimit() {
    if (state.ctrl.dvLimitPct == null) return;
    state.ctrl.dvLimitPct = null;
    state.ctrl.dvLimitUntil = 0;
    Promise.resolve()
      .then(() => applyDvFeedInLimit(null))
      .catch((e) => pushLog('dv_feedin_limit_error', { phase: 'release', error: e?.message || String(e) }));
  }

  function applyFull(reason) {
    luox().setpointPct = 100;
    releaseLimit();
    if (state.ctrl.forcedOff) clearForcedOff(reason);
    return { mode: 'full' };
  }

  function applyOff(reason) {
    luox().setpointPct = 0;
    releaseLimit();
    setForcedOff(reason, { until: leaseUntil() });
    return { mode: 'off' };
  }

  // Teilgrenze in Watt setzen. pct dient nur der Anzeige/Ablaufverfolgung.
  // Fehlt der Steuerpunkt (oder ist der Begrenzer-Weg nicht verfügbar), wird
  // sicherheitshalber ganz abgeregelt — weniger einspeisen erfüllt jede Vorgabe.
  function applyLimit(limitW, pct, reason) {
    const cfg = getCfg();
    const point = cfg?.controlWrite?.dvFeedInLimitW;
    if (!(limitW > 0) || !point?.enabled || typeof applyDvFeedInLimit !== 'function') {
      pushLog('dv_partial_as_off', { pct, limitW, reason, limiter: !!point?.enabled });
      setForcedOff(`${reason}_partial_as_off`, { until: leaseUntil() });
      return { mode: 'off', fallback: true };
    }
    luox().setpointPct = pct;
    if (state.ctrl.forcedOff) clearForcedOff(reason);
    state.ctrl.dvLimitPct = pct;
    state.ctrl.dvLimitUntil = leaseUntil();
    state.ctrl.lastSignal = reason;
    state.ctrl.updatedAt = now();
    pushLog('ctrl_limit', { pct, limitW, reason });
    writeControlEvent({
      eventType: 'ctrl_limit', target: 'dv_control', valueNum: limitW, reason, source: 'direktvermarkter',
      meta: { pct, limitW, referencePowerW: luoxReferencePowerW(cfg), until: new Date(state.ctrl.dvLimitUntil).toISOString() },
    });
    const done = Promise.resolve()
      .then(() => applyDvFeedInLimit(limitW))
      .catch((e) => {
        pushLog('dv_feedin_limit_error', { phase: 'limit', pct, limitW, error: e?.message || String(e) });
        state.ctrl.dvLimitPct = null;
        state.ctrl.dvLimitUntil = 0;
        setForcedOff(`${reason}_limit_failed`, { until: leaseUntil() });
      });
    return { mode: 'limit', limitW, done };
  }

  function setDvLimitPct(pct, reason) {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct))));
    if (p >= 100) return applyFull(reason);
    if (p <= 0) return applyOff(reason);
    const refW = luoxReferencePowerW(getCfg());
    if (!(refW > 0)) {
      pushLog('dv_partial_as_off', { pct: p, reason, refW, limiter: !!getCfg()?.controlWrite?.dvFeedInLimitW?.enabled });
      setForcedOff(`${reason}_partial_as_off`, { until: leaseUntil() });
      return { mode: 'off', fallback: true };
    }
    return applyLimit(Math.round((p / 100) * refW), p, reason);
  }

  // Plexlog Holding 0: Soll-Wirkleistung in Watt (Int32, niederwertiges Wort
  // zuerst). Umsetzung analog zur LUOX-Teilvorgabe, aber watt- statt prozent-
  // basiert (die Watt sind die Einspeise-/Wirkleistungsgrenze selbst):
  //   -1               = keine Vorgabe (misollvalue == -1)       → voll frei
  //   0 (oder negativ)                                           → aus
  //   >= Anlagenleistung (Referenzleistung)                      → voll frei
  //   dazwischen        = Grenze in Watt                         → Teilvorgabe
  // Ohne Referenzleistung ist die Teilvorgabe nicht sauber einzuordnen →
  // sicherheitshalber ganz abregeln (wie bei fehlendem Steuerpunkt).
  function setDvLimitW(watts, reason) {
    if (Number(watts) === -1) return applyFull(reason);
    const w = Math.round(Number(watts) || 0);
    if (w <= 0) return applyOff(reason);
    const refW = luoxReferencePowerW(getCfg());
    if (refW > 0 && w >= refW) return applyFull(reason);
    if (!(refW > 0)) {
      pushLog('dv_partial_as_off', { watts: w, reason, refW, limiter: !!getCfg()?.controlWrite?.dvFeedInLimitW?.enabled });
      setForcedOff(`${reason}_partial_as_off`, { until: leaseUntil() });
      return { mode: 'off', fallback: true };
    }
    const pct = Math.max(1, Math.min(100, Math.round((100 * w) / refW)));
    return applyLimit(w, pct, reason);
  }

  function expireIfNeeded() {
    if (state.ctrl.dvLimitPct != null && now() > Number(state.ctrl.dvLimitUntil || 0)) {
      setDvLimitPct(100, 'luox_watchdog_expired');
    }
  }

  return { setDvLimitPct, setDvLimitW, watchdogRefresh, expireIfNeeded, leaseUntil };
}
