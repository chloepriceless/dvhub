// services/setpoint-follow-watchdog.js — Wächter „Speicher folgt dem Sollwert nicht".
//
// ANLASS (07.10.2026, ab ca. 15:45 bis in die Nacht): DVhub schrieb den
// Netz-Sollwert korrekt (abends −12 bis −18 kW, danach −100 W), der Victron
// las ihn auch so zurück — der MultiPlus gab aber nichts aus dem Akku ab. Der
// Akku stand bei 70 %, das Haus bezog 1,4–1,9 kW aus dem Netz, der gesamte
// Abendverkauf fiel aus. Kein Alarm, kein Fehler am Gerät, keine Sperre in den
// Registern; erst ein Eingriff an der Anlage brachte die Entladung zurück.
// DVhub kann das nicht beheben, aber es darf nicht still bleiben.
//
// ERKENNUNG — bewusst eng, damit es keinen Fehlalarm gibt:
//   • die Anlage bezieht wirklich Strom aus dem Netz (≥ minImportW), und zwar
//     deutlich mehr, als der Sollwert vorgibt (≥ minShortfallW),
//   • der Akku entlädt dabei nicht (Akku-Leistung über −idleW),
//   • der Ladestand liegt klar über der Entlade-Untergrenze — der höheren aus
//     Mindestgrenze (Reg. 2901) und aktiver SoC-Grenze des Victron (Reg. 2903),
//   • keine Entlade-Sperre ist gesetzt (maxDischargeW) und DVhub hält den Akku
//     nicht selbst gewollt fest (EOS „Akku halten“),
//   • und das hält ≥ holdMs durchgehend an.
// Ein Wechselrichter an seiner Leistungsgrenze fällt nicht darunter (dann
// entlädt der Akku ja), ein gewolltes Halten des Akkus auch nicht (dann liegt
// der Sollwert beim Verbrauch, die Abweichung ist null).
//
// REAKTION: nur melden (Protokoll + Push aufs Handy), nichts steuern.
//
// FEHLALARM 31.10.2026 12:32 (und 20.10., 22.10., 30.10.): EOS „Akku halten“
// (schedule-eval, Quelle eos_grid_hold) stellte den Sollwert jeden Takt auf
// Live-Last − PV − Puffer; der Akku soll dabei stehen. Mit einem E-Auto (11 kW)
// springt die Last, der Sollwert läuft nach, und bei PV > Last fällt er auf den
// Eigenverbrauchs-Boden −100 W. Zugleich stand der Akku bei 10 % = aktiver
// SoC-Grenze des Victron (Reg. 2903), DVhub kannte nur 5 % (Reg. 2901). Beides
// ist gewollt bzw. vom Gerät so vorgegeben, kein Wechselrichter-Fehler. Darum
// zählen jetzt (a) eine aktive Halteregel der eigenen Steuerung und (b) die
// aktive SoC-Grenze wie eine gesetzte Entlade-Sperre.

// So alt darf der Eintrag der Auswertung (state.schedule.active) höchstens
// sein, damit eine Halteregel als „aktiv“ gilt. Die Auswertung frischt ihn
// jeden Takt auf (Standard 15 s); steht sie, entschuldigt ein alter Eintrag nichts.
export const HOLD_SIGNAL_MAX_AGE_MS = 120000;

// Steuerquellen, mit denen DVhub den Akku bewusst nicht entladen lässt. Nur
// eos_grid_hold gehört dazu: die Regel deckt die Last aus dem Netz, damit der
// Akku stehen bleibt (schedule-eval „EOS Akku halten“).
export const DISCHARGE_HOLD_SOURCES = new Set(['eos_grid_hold']);

import { knownMaxDischargeW } from './peak-shaving/index.js';

export const SETPOINT_FOLLOW_DEFAULTS = {
  enabled: true,
  holdMs: 10 * 60000,      // so lange muss das Bild durchgehend stehen
  clearMs: 2 * 60000,      // so lange muss es weg sein, bevor es als behoben gilt
  minImportW: 300,         // echter Netzbezug
  minShortfallW: 500,      // Netzbezug über dem Sollwert
  idleW: 150,              // Akku gilt als „entlädt nicht" oberhalb von −idleW
  socMarginPct: 3,         // Abstand zur Entlade-Untergrenze
  fallbackMinSocPct: 5,    // falls die Anlage keine Untergrenze meldet
  reminderMs: 3 * 3600000, // Erinnerung, solange es anhält
  maxAgeMs: 60000          // so alt darf ein Messwert höchstens sein
};

function numOr(value, fallback, min = -Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function resolveSetpointFollowOptions(cfg = {}) {
  const w = cfg?.victron?.setpointWatchdog || {};
  const d = SETPOINT_FOLLOW_DEFAULTS;
  return {
    enabled: w.enabled !== false,
    holdMs: numOr(w.holdMs, d.holdMs, 60000),
    clearMs: numOr(w.clearMs, d.clearMs, 10000),
    minImportW: numOr(w.minImportW, d.minImportW, 0),
    minShortfallW: numOr(w.minShortfallW, d.minShortfallW, 50),
    idleW: numOr(w.idleW, d.idleW, 0),
    socMarginPct: numOr(w.socMarginPct, d.socMarginPct, 0),
    fallbackMinSocPct: numOr(w.fallbackMinSocPct, d.fallbackMinSocPct, 0),
    reminderMs: numOr(w.reminderMs, d.reminderMs, 600000),
    maxAgeMs: numOr(w.maxAgeMs, d.maxAgeMs, 5000)
  };
}

export function createSetpointFollowState() {
  return { suspectSince: null, okSince: null, active: false, lastAlarmAt: null, last: null };
}

function pct(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * Entlade-Untergrenze in %: die höhere aus Mindestgrenze (minSocPct) und
 * aktiver SoC-Grenze des Victron (activeSocLimitPct). Fehlen beide, gilt
 * fallbackMinSocPct.
 */
export function dischargeFloorPct(sample, opts) {
  const known = [pct(sample?.minSocPct), pct(sample?.activeSocLimitPct)].filter((n) => n != null);
  return known.length ? Math.max(...known) : opts.fallbackMinSocPct;
}

/**
 * Hält DVhub den Akku gerade selbst fest? Liefert die Steuerquelle oder null.
 * Grundlage ist der Eintrag, den die Auswertung zuletzt für gridSetpointW
 * geschrieben bzw. bestätigt hat (schedule-eval: state.schedule.active).
 */
export function activeDischargeHold(state, nowMs = Date.now()) {
  const active = state?.schedule?.active?.gridSetpointW;
  if (!active || !DISCHARGE_HOLD_SOURCES.has(String(active.source))) return null;
  const at = Number(active.at);
  if (!(at > 0) || nowMs - at > HOLD_SIGNAL_MAX_AGE_MS || at - nowMs > HOLD_SIGNAL_MAX_AGE_MS) return null;
  return String(active.source);
}

/**
 * Ein Messpunkt: Verweigert der Speicher gerade die Entladung?
 * @returns {boolean|null} null = nicht beurteilbar (Werte fehlen)
 */
export function isRefusingDischarge(sample, opts) {
  const setpointW = Number(sample?.setpointW);
  const netImportW = Number(sample?.netImportW);
  const batteryW = Number(sample?.batteryW);
  const soc = Number(sample?.soc);
  if (sample?.setpointW == null || sample?.netImportW == null || sample?.batteryW == null || sample?.soc == null) return null;
  if (![setpointW, netImportW, batteryW, soc].every(Number.isFinite)) return null;
  if (soc < dischargeFloorPct(sample, opts) + opts.socMarginPct) return false;
  // Gewolltes Halten durch DVhub selbst (EOS „Akku halten“): kein Fehler.
  if (sample.holdReason) return false;
  // Eine gesetzte Entlade-Sperre ist gewollt, kein Fehler.
  const maxDischargeW = sample.maxDischargeW == null ? NaN : Number(sample.maxDischargeW);
  if (Number.isFinite(maxDischargeW) && maxDischargeW >= 0 && maxDischargeW < opts.minShortfallW) return false;
  return netImportW >= opts.minImportW
    && (netImportW - setpointW) >= opts.minShortfallW
    && batteryW > -opts.idleW;
}

/**
 * Einen Poll-Zyklus bewerten. Mutiert `state`.
 * @returns {{ state: object, transition: 'alarm'|'reminder'|'clear'|null }}
 */
export function evaluateSetpointFollow(state, sample, opts) {
  const now = numOr(sample?.nowMs, Date.now());
  const refusing = isRefusingDischarge(sample, opts);
  let transition = null;

  if (refusing === true) {
    state.okSince = null;
    if (state.suspectSince == null) state.suspectSince = now;
    state.last = {
      setpointW: Number(sample.setpointW), netImportW: Number(sample.netImportW),
      batteryW: Number(sample.batteryW), soc: Number(sample.soc),
      floorPct: dischargeFloorPct(sample, opts)
    };
    if (!state.active && (now - state.suspectSince) >= opts.holdMs) {
      state.active = true;
      state.lastAlarmAt = now;
      transition = 'alarm';
    } else if (state.active && (now - state.lastAlarmAt) >= opts.reminderMs) {
      state.lastAlarmAt = now;
      transition = 'reminder';
    }
  } else if (refusing === false) {
    // Kurze Ausreißer (ein einzelner Entlade-Zacken) setzen nichts zurück —
    // erst wenn das Bild clearMs lang weg ist.
    if (state.okSince == null) state.okSince = now;
    if ((now - state.okSince) >= opts.clearMs) {
      if (state.active) transition = 'clear';
      state.active = false;
      state.suspectSince = null;
      state.lastAlarmAt = null;
    }
  }
  // refusing === null: Werte fehlen — Zustand unverändert lassen.
  return { state, transition };
}

function kw(w) {
  return (Math.abs(Number(w) || 0) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function describeSetpoint(setpointW) {
  const w = Math.round(Number(setpointW) || 0);
  if (w <= -1000) return `Einspeisung mit ${kw(w)} kW`;
  if (w >= 1000) return `höchstens ${kw(w)} kW Netzbezug`;
  return 'kein Netzbezug';
}

/**
 * Wächter-Fabrik für den Poll-Pfad (polling.js ruft tick() am Zyklus-Ende).
 * ctx: { state, getCfg, pushLog, notificationService?, monitoringAlertPush? }
 */
export function createSetpointFollowWatchdog(ctx) {
  const { state, getCfg, pushLog } = ctx;
  let wstate = createSetpointFollowState();

  function send(msg) {
    try {
      ctx.notificationService?.sendDirect?.(msg)?.catch?.(() => { /* fire-and-forget */ });
    } catch { /* noop */ }
  }

  /** Ein Poll-Zyklus. Wirft nie. */
  function tick(nowMs = Date.now()) {
    const opts = resolveSetpointFollowOptions(getCfg() || {});
    const v = state.victron || {};
    // Nur wo DVhub selbst steuert; bei eingefrorenen Live-Daten meldet der
    // Einfrier-Wächter, die Werte hier wären dann nicht belastbar.
    if (!opts.enabled || process.env.DVHUB_READ_ONLY === '1' || v.freeze?.active || state.meter?.ok === false) {
      if (!opts.enabled) {
        wstate = createSetpointFollowState();
        if (state.victron) state.victron.setpointFollow = null;
      }
      return null;
    }

    // Nur frisch gelesene Werte zählen: schlägt ein Read fehl, behält der
    // Live-State den alten Wert — ein alter „Akku steht"-Wert wäre ein Fehlalarm.
    const stamps = v.fieldUpdatedAt || {};
    const fresh = (name) => Number(stamps[name]) > 0 && (nowMs - Number(stamps[name])) <= opts.maxAgeMs;
    const live = (name) => (fresh(name) ? v[name] : null);

    const netImportW = (v.gridImportW == null || v.gridExportW == null)
      ? null
      : Number(v.gridImportW) - Number(v.gridExportW);
    const { transition } = evaluateSetpointFollow(wstate, {
      nowMs,
      setpointW: live('gridSetpointW'),
      netImportW,
      batteryW: live('batteryPowerW'),
      soc: live('soc'),
      minSocPct: v.minSocPct,
      // Aktive SoC-Grenze (Reg. 2903) nur frisch: sie wandert mit BatteryLife,
      // ein alter hoher Wert würde echte Alarme verschlucken.
      activeSocLimitPct: live('activeSocLimitPct'),
      holdReason: activeDischargeHold(state, nowMs),
      // Entlade-Sperre (Reg. 2704): Rücklesung, sonst DVhubs eigener letzter
      // Schreibwert — das Victron-Profil liest 2704 nicht in jedem Setup zurück.
      maxDischargeW: knownMaxDischargeW(state, getCfg() || {}, nowMs)?.value ?? null
    }, opts);

    const last = wstate.last || {};
    const detail = {
      sinceMs: wstate.suspectSince != null ? nowMs - wstate.suspectSince : 0,
      setpointW: last.setpointW ?? null,
      netImportW: last.netImportW ?? null,
      batteryW: last.batteryW ?? null,
      soc: last.soc ?? null,
      floorPct: last.floorPct ?? null
    };

    if (transition === 'alarm' || transition === 'reminder') {
      pushLog('setpoint_not_followed', { ...detail, reminder: transition === 'reminder' }, 'warn');
      const minutes = Math.max(1, Math.round(detail.sinceMs / 60000));
      send({
        event: 'setpoint_not_followed', level: 'warning',
        title: 'DVhub: Speicher entlädt nicht',
        body: `Seit ${minutes} Minuten bezieht die Anlage ${kw(detail.netImportW)} kW aus dem Netz, obwohl der Akku bei ${Math.round(detail.soc)} % steht und DVhub „${describeSetpoint(detail.setpointW)}" vorgibt. Der Wechselrichter gibt nichts aus dem Akku ab. DVhub kann das nicht selbst beheben — bitte an der Anlage nachsehen.`
      });
      try {
        Promise.resolve(ctx.monitoringAlertPush?.('down', 'DVhub: Speicher entlädt nicht, Wechselrichter folgt dem Sollwert nicht'))
          .catch(() => { /* noop */ });
      } catch { /* noop */ }
    }
    if (transition === 'clear') {
      pushLog('setpoint_followed_again', detail, 'info');
      send({
        event: 'setpoint_followed_again', level: 'info',
        title: 'DVhub: Speicher entlädt wieder',
        body: 'Der Wechselrichter folgt dem Sollwert wieder. Die Steuerung arbeitet normal weiter.'
      });
      try {
        Promise.resolve(ctx.monitoringAlertPush?.('up', 'DVhub: Speicher entlädt wieder')).catch(() => { /* noop */ });
      } catch { /* noop */ }
    }

    if (state.victron) {
      state.victron.setpointFollow = wstate.active
        ? { active: true, since: new Date(wstate.suspectSince || nowMs).toISOString(), ...detail }
        : null;
    }
    return wstate.active;
  }

  return { tick, _state: () => wstate };
}
