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
//   • und das prägt ein ganzes Fenster von holdMs: die Episode reicht bis an den
//     Fensteranfang und liegt gerade an, mindestens minSuspectShare (80 %) der
//     Messpunkte sind auffällig UND im Mittel des Fensters erreichen Netzbezug
//     und Fehlbetrag (Bezug − Sollwert) die Schwellen. Entwarnung nach clearMs
//     ohne auffälligen Punkt oder clearMs deutlicher Erholung im Fenster
//     (Anteil < 40 % oder Mittel unter den Schwellen).
//
// FEHLALARM 02.11.2026 10:50 UTC: Sollwert −100 W, im 5-min-Mittel 29–124 W
// Bezug, Akku lädt — der Wechselrichter folgte. Kurze Laststöße (evcc schaltet
// die Wallbox) mit < 2 min Pause hielten den alten Zähler „seit wann auffällig“
// wach, bis 10 min erreicht waren. Darum zählt jetzt das Fenster, nicht der
// erste auffällige Punkt.
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

import { knownMaxDischargeW } from './peak-shaving/index.js';

// So alt darf das Halte-Signal der Auswertung (state.ctrl.eosGridHold) bzw.
// DVhubs eigener 2704-Schreibwert höchstens sein — mindestens, bei langsamerem
// Takt drei Takte (schedule.evaluateMs). Die Auswertung erneuert das Signal
// jeden Takt (Standard 15 s); steht sie, entschuldigt ein altes Signal nichts.
export const HOLD_SIGNAL_MAX_AGE_MS = 120000;

export const SETPOINT_FOLLOW_DEFAULTS = {
  enabled: true,
  holdMs: 10 * 60000,      // Fenster: so lange muss die Episode dauern (≥ minSuspectShare auffällig)
  clearMs: 2 * 60000,      // so lange muss es weg sein, bevor es als behoben gilt
  minImportW: 300,         // echter Netzbezug
  minShortfallW: 500,      // Netzbezug über dem Sollwert
  idleW: 150,              // Akku gilt als „entlädt nicht" oberhalb von −idleW
  minSuspectShare: 0.8,    // Anteil auffälliger Messpunkte im Fenster (holdMs)
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
    minSuspectShare: Math.min(1, numOr(w.minSuspectShare, d.minSuspectShare, 0.5)),
    socMarginPct: numOr(w.socMarginPct, d.socMarginPct, 0),
    fallbackMinSocPct: numOr(w.fallbackMinSocPct, d.fallbackMinSocPct, 0),
    reminderMs: numOr(w.reminderMs, d.reminderMs, 600000),
    maxAgeMs: numOr(w.maxAgeMs, d.maxAgeMs, 5000)
  };
}

export function createSetpointFollowState() {
  return {
    suspectSince: null, okSince: null, active: false, lastAlarmAt: null, last: null,
    // Fenster der beurteilbaren Messpunkte (holdMs) und der letzte Punkt davor
    // als Anker, damit die Abdeckung genau holdMs erreichen kann.
    window: [], anchor: null, recoveredSince: null, share: null, avgImportW: null, avgShortfallW: null
  };
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

function holdSignalMaxAgeMs(cfg) {
  const evaluateMs = Number(cfg?.schedule?.evaluateMs);
  return Math.max(HOLD_SIGNAL_MAX_AGE_MS, Number.isFinite(evaluateMs) && evaluateMs > 0 ? 3 * evaluateMs : 0);
}

function isFresh(at, nowMs, maxAgeMs) {
  const t = Number(at);
  return t > 0 && Math.abs(nowMs - t) <= maxAgeMs;
}

/**
 * Hält DVhub den Akku gerade selbst fest (EOS „Akku halten“)? Liefert
 * 'eos_grid_hold' oder null. Quelle ist das Signal, das der Halte-Zweig in
 * schedule-eval jeden Takt setzt (state.ctrl.eosGridHold) — nicht die zuletzt
 * geschriebene Quelle, denn die wird z. B. bei negativem Preis zur Pflichtquelle.
 * Kein Halten, wenn
 *   • die Hauslast unbekannt war (Sollwert 0 = Eigenverbrauch, der Akku soll entladen),
 *   • Peak Shaving den Halte-Wert gedeckelt hat (der Akku soll den Rest liefern).
 */
export function activeDischargeHold(state, nowMs = Date.now(), cfg = {}) {
  const hold = state?.ctrl?.eosGridHold;
  const maxAgeMs = holdSignalMaxAgeMs(cfg);
  if (!hold || hold.known !== true || !isFresh(hold.at, nowMs, maxAgeMs)) return null;
  const clamp = state?.ctrl?._peakShaving?.clamp;
  if (clamp && clamp.source === 'eos_grid_hold' && isFresh(clamp.at, nowMs, maxAgeMs)
      && Number(clamp.valueW) < Number(clamp.requestedW)) return null;
  return 'eos_grid_hold';
}

/**
 * Entlade-Sperre 2704 in W, soweit belastbar bekannt: Rücklesung (Victron-
 * Profil, sonst Peak-Shaving-Rücklesung); DVhubs eigener Schreibwert nur
 * befristet — an der GX kann die Sperre längst wieder aufgehoben sein.
 */
export function knownDischargeCapW(state, cfg, nowMs = Date.now()) {
  const known = knownMaxDischargeW(state, cfg, nowMs);
  if (!known) return null;
  if (known.from === 'own_write' && !isFresh(known.at, nowMs, holdSignalMaxAgeMs(cfg))) return null;
  return known.value;
}

/**
 * Warum der Speicher gerade gewollt nicht entlädt — dann ist er nicht zu
 * beurteilen. 'soc_floor' | 'hold' | 'discharge_block' | null.
 */
export function dischargeExcuse(sample, opts) {
  const soc = Number(sample?.soc);
  if (Number.isFinite(soc) && soc < dischargeFloorPct(sample, opts) + opts.socMarginPct) return 'soc_floor';
  if (sample?.holdReason) return 'hold';
  const maxDischargeW = sample?.maxDischargeW == null ? NaN : Number(sample.maxDischargeW);
  if (Number.isFinite(maxDischargeW) && maxDischargeW >= 0 && maxDischargeW < opts.minShortfallW) return 'discharge_block';
  return null;
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
  // Untergrenze erreicht, gewolltes Halten oder gesetzte Entlade-Sperre: kein Fehler.
  if (dischargeExcuse(sample, opts)) return false;
  return netImportW >= opts.minImportW
    && (netImportW - setpointW) >= opts.minShortfallW
    && batteryW > -opts.idleW;
}

/**
 * Fenster-Bild über holdMs: Anteil auffälliger Punkte, Mittelwerte und ob die
 * Episode selbst schon holdMs dauert (der Punkt am Fensteranfang ist auffällig).
 */
function windowVerdict(state, now, opts) {
  const pts = state.anchor ? [state.anchor, ...state.window] : state.window;
  const empty = { covered: false, share: 0, avgImportW: 0, avgShortfallW: 0, failing: false, recovered: false, firstSuspectAt: null };
  if (!pts.length) return empty;
  let bad = 0, imp = 0, short = 0, firstSuspectAt = null;
  for (const p of pts) {
    if (p.refusing) {
      bad += 1;
      if (firstSuspectAt == null) firstSuspectAt = p.t;
    }
    imp += p.netImportW;
    short += p.netImportW - p.setpointW;
  }
  const n = pts.length;
  const share = bad / n;
  const avgImportW = imp / n;
  const avgShortfallW = short / n;
  const start = pts[0];
  const covered = (now - start.t) >= opts.holdMs;
  const current = pts[n - 1];
  // Alarm: Fenster voll, die Episode reicht bis an den Fensteranfang, sie liegt
  // gerade an, sie überwiegt, und auch im Mittel stimmen Bezug und Fehlbetrag.
  const failing = covered && start.refusing && current.refusing
    && share >= opts.minSuspectShare
    && avgImportW >= opts.minImportW && avgShortfallW >= opts.minShortfallW;
  // Erholt (Hysterese zur Entwarnung): deutlich weniger auffällig ODER im
  // Mittel unter den Schwellen — nicht schon, wenn der Anteil knapp unter 80 % fällt.
  const recovered = covered && (share < opts.minSuspectShare / 2
    || avgImportW < opts.minImportW || avgShortfallW < opts.minShortfallW);
  return { covered, share, avgImportW, avgShortfallW, failing, recovered, firstSuspectAt };
}

/**
 * Einen Poll-Zyklus bewerten. Mutiert `state`.
 * @returns {{ state: object, transition: 'alarm'|'reminder'|'clear'|null }}
 */
export function evaluateSetpointFollow(state, sample, opts) {
  const now = numOr(sample?.nowMs, Date.now());
  const refusing = isRefusingDischarge(sample, opts);
  let transition = null;
  // refusing === null: Werte fehlen — Zustand unverändert lassen. Ebenso, wenn
  // der Akku gewollt nicht entlädt (Untergrenze, Halten, Sperre): das ist weder
  // ein Fehler noch ein Beleg, dass er wieder folgt — sonst käme mitten im
  // Halten eine falsche Entwarnung (Gegenprüfung 415a2f25).
  if (refusing === null || (refusing === false && dischargeExcuse(sample, opts))) return { state, transition };

  state.window ??= [];
  // Lücke ohne beurteilbaren Punkt (länger als gapMs, Standard maxAgeMs bzw.
  // 3 × Poll-Takt): die Vorgeschichte gilt nicht mehr.
  const gapMs = Number(opts.gapMs) > 0 ? Number(opts.gapMs) : opts.maxAgeMs;
  const prev = state.window.length ? state.window[state.window.length - 1] : state.anchor;
  if (prev && now - prev.t > gapMs) {
    state.window = [];
    state.anchor = null;
    if (!state.active) state.suspectSince = null;
    state.okSince = null;
    state.recoveredSince = null;
  }
  state.window.push({
    t: now, refusing,
    netImportW: Number(sample.netImportW), setpointW: Number(sample.setpointW)
  });
  // Älteres als holdMs fällt heraus; der jüngste herausgefallene Punkt bleibt Anker.
  while (state.window.length && state.window[0].t < now - opts.holdMs) state.anchor = state.window.shift();

  if (refusing) {
    state.okSince = null;
    state.last = {
      setpointW: Number(sample.setpointW), netImportW: Number(sample.netImportW),
      batteryW: Number(sample.batteryW), soc: Number(sample.soc),
      floorPct: dischargeFloorPct(sample, opts)
    };
  } else if (state.okSince == null) {
    state.okSince = now;
  }

  const verdict = windowVerdict(state, now, opts);
  state.share = verdict.share;
  state.avgImportW = verdict.avgImportW;
  state.avgShortfallW = verdict.avgShortfallW;

  if (!state.active) {
    // „Seit wann“: frühester auffälliger Punkt im Fenster, nicht eine alte Spitze.
    state.suspectSince = verdict.firstSuspectAt;
    if (verdict.failing) {
      state.active = true;
      state.lastAlarmAt = now;
      state.recoveredSince = null;
      transition = 'alarm';
    }
    return { state, transition };
  }

  // Alarm aktiv: suspectSince bleibt beim Beginn der Episode stehen.
  if (verdict.failing && (now - state.lastAlarmAt) >= opts.reminderMs) {
    state.lastAlarmAt = now;
    transition = 'reminder';
  }
  if (verdict.recovered) {
    if (state.recoveredSince == null) state.recoveredSince = now;
  } else {
    state.recoveredSince = null;
  }
  // Entwarnung: clearMs ohne jeden auffälligen Punkt, oder das volle Fenster
  // ist clearMs lang deutlich erholt (kurze Zacken halten keinen Alarm offen).
  const okLong = state.okSince != null && (now - state.okSince) >= opts.clearMs;
  const recoveredLong = state.recoveredSince != null && (now - state.recoveredSince) >= opts.clearMs;
  if (okLong || recoveredLong) {
    transition = 'clear';
    // Neues Fenster; letzter auffälliger Punkt und Fensterwerte bleiben fürs Protokoll.
    Object.assign(state, createSetpointFollowState(), {
      last: state.last, share: state.share, avgImportW: state.avgImportW, avgShortfallW: state.avgShortfallW
    });
  }
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
    const cfg = getCfg() || {};
    const opts = resolveSetpointFollowOptions(cfg);
    // Lückengrenze: bei langsamem Poll-Takt (meterPollMs bis 60 s) liegen die
    // Punkte selbst schon um maxAgeMs auseinander (Gegenprüfung 39bbcd6e).
    const pollMs = Number(cfg.meterPollMs);
    opts.gapMs = Math.max(opts.maxAgeMs, Number.isFinite(pollMs) && pollMs > 0 ? 3 * pollMs : 0);
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
      holdReason: activeDischargeHold(state, nowMs, cfg),
      // Entlade-Sperre (Reg. 2704): Rücklesung, sonst DVhubs eigener letzter
      // Schreibwert, dieser nur befristet.
      maxDischargeW: knownDischargeCapW(state, cfg, nowMs)
    }, opts);

    const last = wstate.last || {};
    const detail = {
      sinceMs: wstate.suspectSince != null ? nowMs - wstate.suspectSince : 0,
      setpointW: last.setpointW ?? null,
      netImportW: last.netImportW ?? null,
      batteryW: last.batteryW ?? null,
      soc: last.soc ?? null,
      floorPct: last.floorPct ?? null,
      // Fenster-Bild (02.11.2026): Anteil auffälliger Punkte und Mittel über holdMs.
      sharePct: wstate.share != null ? Math.round(wstate.share * 100) : null,
      avgImportW: wstate.avgImportW != null ? Math.round(wstate.avgImportW) : null,
      avgShortfallW: wstate.avgShortfallW != null ? Math.round(wstate.avgShortfallW) : null
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
