// services/telemetry-freeze-watchdog.js — T-FREEZE Einfrier-Wächter (2026-07-24).
//
// ANLASS (GX-Modbus-Zwischenfall 24.07., 07:00–09:32 Berliner Zeit): der Victron-GX
// (dbus-modbustcp v1.0.93) räumt tote Modbus-TCP-Sessions nicht ab. DVhub bekam über
// eine halb-tote Session EINGEFRORENE Werte — jeder Read war ERFOLGREICH, lieferte aber
// unverändert denselben Wert (SoC hing bei 7 %), während VRM live weiterlief. Writes
// kamen nicht durch, der Einspeise-Loop stoppte, und KEIN bestehender Schutz schlug an:
//   • T-0075-Frische (fieldUpdatedAt) — der Stempel wird im ERFOLGS-Zweig gesetzt, und
//     der Read WAR erfolgreich → die Telemetrie sah taufrisch aus.
//   • T-VERIFY-Write-Verifikation — die Rücklesung „bestätigte" denselben eingefrorenen
//     Wert, der Einspeise-Loop nutzt ohnehin einen anderen Schreibpfad.
// LEHRE: Staleness muss die WERT-ÄNDERUNG prüfen, nicht nur den Zeitstempel.
//
// Zwei unabhängige Detektoren (beide nötig, sie decken verschiedene Ausfallbilder ab):
//
//   A) identical_values — ALLE anwesenden Jitter-Felder (Netz-Gesamtleistung,
//      Akku-Leistung, PV-Gesamt, Hauslast) stehen gleichzeitig ≥ freezeMs auf
//      BIT-IDENTISCHEN Werten, über ≥ minSamples erfolgreiche Polls, und mindestens
//      eines davon ist ≠ 0 (|v| ≥ minPowerW). Eine echte Anlage jittert auf
//      Watt-Auflösung im Sekundentakt — 180 identische Samples bei laufender Leistung
//      sind physikalisch praktisch unmöglich. Die Nicht-Null-Bedingung schließt den
//      legitimen Fall „Anlage steht komplett still, alles exakt 0" aus.
//
//   B) soc_no_step — der SoC steht, obwohl der GX durchgehend Akku-Leistung meldet:
//      der integrierte |Akku-Durchsatz| seit der letzten SoC-Änderung übersteigt die
//      Energie, die für einen SoC-Schritt nötig wäre (socStepPct der Kapazität). Fängt
//      den TEIL-Einfrierer, bei dem nur der SoC klemmt und die Leistungswerte weiter
//      jittern (Detektor A greift dann nicht). Ohne bekannte Akkukapazität
//      (optimizer.batteryCapacityWh) bleibt B AUS — lieber blind als falsch geraten.
//      NUR im linearen SoC-Band (socBandLowPct..socBandHighPct): an den Enden steht der
//      SoC LEGITIM still — oben nimmt der Akku in Absorption/Float stundenlang Strom auf,
//      ohne dass der Ladestand steigt, unten ruht er am Entlade-Boden. Gegen 5 Tage
//      echte Anlagendaten geprüft (2026-07-24, 60-kWh-LFP): die naive Fassung ohne Band
//      mit 1,5 % hätte in 5 Tagen ~9-mal falsch Alarm geschlagen (fast alles
//      Absorptionsphase bei 95-100 %), die Fassung hier 0-mal.
//
// REAKTION (keine neue Steuer-Semantik, es klinkt sich in Bestehendes ein):
//   1. Frische-Stempel zurückdatieren auf den letzten ECHTEN Wertwechsel → der
//      vorhandene T-0075-Entlade-Boden-Schutz (schedule-eval.js, Chokepoint) hält jede
//      erzwungene Entladung, victron.connected fällt, abgeleitete Loops degradieren.
//      Bei Detektor B nur der SoC-Stempel (die Leistungswerte sind ja live).
//   2. Modbus-Verbindung verwerfen (transport.dropConnections) → der nächste Poll baut
//      eine frische TCP-Session auf; throttled, damit kein Reconnect-Sturm entsteht.
//   3. Lauter, gedrosselter Alarm (pushLog critical + Direkt-Notification + Uptime-Kuma
//      Alert-Push) — der Zwischenfall war 2,5 h lang STILL.
// Der Wächter läuft NUR auf Modbus: der MQTT-Transport ist per Design on-change
// (unveränderte Werte sind dort normal) und hat seine eigene Staleness-Prüfung.

/** Felder, die auf einer lebenden Anlage im Sekundentakt jittern. */
export const FREEZE_JITTER_FIELDS = ['grid_total_w', 'batteryPowerW', 'pvTotalW', 'selfConsumptionW'];

export const FREEZE_DEFAULTS = {
  enabled: true,
  freezeMs: 180000,      // 3 min identische Werte
  minSamples: 20,        // … über mindestens so viele erfolgreiche Polls
  minPowerW: 25,         // … mit mindestens einem Feld ≠ 0
  minJitterFields: 2,    // … und mindestens so vielen anwesenden Feldern
  socStepPct: 3,         // Detektor B: Durchsatz-Schwelle in % der Kapazität
  socBandLowPct: 10,     // Detektor B nur im linearen SoC-Band …
  socBandHighPct: 95,    // … (außerhalb steht der SoC legitim still)
  reconnectMs: 60000,    // Throttle für das Verwerfen der Modbus-Session
  // Reconnect-Versuche PRO Einfrier-Episode. Hart gedeckelt, weil ein
  // Reconnect-Sturm dem GX nachweislich schadet: in der Victron-Community ist
  // dokumentiert, dass eine Verbindungs-Abriss-Schleife die dbus-Kette so belastet,
  // dass die GX-CPU voll läuft und der Hardware-Watchdog neu startet
  // (community.victronenergy.com/t/evcs-ns-ac22ns-chargers-modbus-tcp-disconnect-loop-
  // drives-gx-cpu-load-storm-watchdog-reboot/60277). Dazu räumt der GX tote Sessions
  // nicht ab (Beobachtung 24.07.2026: 89 Zombie-Verbindungen eines einzigen Clients
  // legten den Modbus-Dienst lahm) — jeder weitere Neuaufbau ist also potenziell ein
  // weiterer Leichnam. Hilft der Neuaufbau nicht, hilft er auch beim 50. Mal nicht:
  // ab dann bleibt nur der Alarm stehen.
  maxReconnects: 3
};

const HOUR_MS = 3600000;

function numOr(value, fallback, min = -Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Wächter-Optionen aus der effektiven Config auflösen.
 * @param {object} cfg  effektive DVhub-Config
 */
export function resolveFreezeOptions(cfg = {}) {
  const w = cfg?.victron?.freezeWatchdog || {};
  const socStepPct = numOr(w.socStepPct, FREEZE_DEFAULTS.socStepPct, 0);
  const capacityWh = Number(cfg?.optimizer?.batteryCapacityWh);
  // Kapazität unbekannt → Detektor B aus. Eine geratene Schwelle wäre in beide
  // Richtungen gefährlich: zu klein = Fehlalarm (60-kWh-Akku braucht 600 Wh je %),
  // zu groß = nutzlos.
  const socStepWh = (Number.isFinite(capacityWh) && capacityWh > 0 && socStepPct > 0)
    ? (capacityWh * socStepPct) / 100
    : 0;
  return {
    enabled: w.enabled !== false,
    freezeMs: numOr(w.freezeMs, FREEZE_DEFAULTS.freezeMs, 30000),
    minSamples: numOr(w.minSamples, FREEZE_DEFAULTS.minSamples, 2),
    minPowerW: numOr(w.minPowerW, FREEZE_DEFAULTS.minPowerW, 0),
    minJitterFields: numOr(w.minJitterFields, FREEZE_DEFAULTS.minJitterFields, 1),
    reconnectMs: numOr(w.reconnectMs, FREEZE_DEFAULTS.reconnectMs, 5000),
    maxReconnects: numOr(w.maxReconnects, FREEZE_DEFAULTS.maxReconnects, 0),
    socBandLowPct: numOr(w.socBandLowPct, FREEZE_DEFAULTS.socBandLowPct, 0),
    socBandHighPct: numOr(w.socBandHighPct, FREEZE_DEFAULTS.socBandHighPct, 0),
    socStepWh
  };
}

export function createFreezeState() {
  return {
    fields: {},          // name → { value, sinceMs, samples }
    soc: null,           // { value, sinceMs, throughputWh, lastMs }
    active: false,
    since: null,         // ms — wann der Einfrierer ERKANNT wurde
    anchorMs: null,      // ms — letzter ECHTER Wertwechsel (Rückdatier-Anker)
    reasons: [],
    stalledFields: []
  };
}

/**
 * Einen Poll-Zyklus bewerten. Mutiert `state` (1-Hz-Pfad: kein Objekt-Neubau) und
 * gibt die Übergangs-Kennung zurück.
 *
 * @param {object} state   Zustand aus createFreezeState()
 * @param {{nowMs:number, values:object}} sample  Nur Felder, deren Read in DIESEM
 *        Zyklus ERFOLGREICH war (ein fehlgeschlagener Read hält den alten Wert im
 *        State — den als „unverändert" zu zählen wäre ein Fehlalarm; dafür greift
 *        die normale T-0075-Frische).
 * @param {object} opts    aus resolveFreezeOptions()
 * @returns {{ state: object, transition: 'freeze'|'clear'|null }}
 */
export function evaluateFreeze(state, sample, opts) {
  const now = numOr(sample?.nowMs, Date.now());
  const values = sample?.values || {};

  // --- Detektor A: identische Jitter-Felder ---------------------------------
  const present = [];
  for (const field of FREEZE_JITTER_FIELDS) {
    const v = Number(values[field]);
    if (!Number.isFinite(v)) { delete state.fields[field]; continue; }
    const entry = state.fields[field];
    if (!entry || entry.value !== v) state.fields[field] = { value: v, sinceMs: now, samples: 1 };
    else entry.samples += 1;
    present.push([field, state.fields[field]]);
  }
  const frozenA = present.length >= opts.minJitterFields
    && present.every(([, e]) => (now - e.sinceMs) >= opts.freezeMs && e.samples >= opts.minSamples)
    && present.some(([, e]) => Math.abs(e.value) >= opts.minPowerW);

  // --- Detektor B: SoC steht trotz gemeldetem Akku-Durchsatz ----------------
  const socV = Number(values.soc);
  const batW = Number(values.batteryPowerW);
  let frozenB = false;
  const socInBand = Number.isFinite(socV)
    && socV >= opts.socBandLowPct && socV <= opts.socBandHighPct;
  if (Number.isFinite(socV) && opts.socStepWh > 0 && socInBand) {
    const prevSoc = state.soc;
    if (!prevSoc || prevSoc.value !== socV) {
      state.soc = { value: socV, sinceMs: now, throughputWh: 0, lastMs: now };
    } else {
      // dt gedeckelt: nach einem Poll-Backoff/Neustart darf keine Riesen-Lücke
      // als Durchsatz verbucht werden.
      const dtMs = Math.min(Math.max(0, now - prevSoc.lastMs), 60000);
      prevSoc.lastMs = now;
      if (Number.isFinite(batW)) prevSoc.throughputWh += (Math.abs(batW) * dtMs) / HOUR_MS;
    }
    frozenB = state.soc.throughputWh >= opts.socStepWh && (now - state.soc.sinceMs) >= opts.freezeMs;
  } else {
    // Kein SoC oder außerhalb des Bandes → Akkumulator verwerfen. Beim Wieder-
    // eintritt ins Band wird frisch gezählt (eine über die Absorptionsphase
    // mitgeschleppte Summe wäre genau der Fehlalarm, den das Band verhindert).
    state.soc = null;
  }

  // --- Zustand + Übergang ---------------------------------------------------
  const reasons = [];
  if (frozenA) reasons.push('identical_values');
  if (frozenB) reasons.push('soc_no_step');
  const active = reasons.length > 0;

  let anchorMs = null;
  if (frozenA) anchorMs = Math.min(...present.map(([, e]) => e.sinceMs));
  if (frozenB) anchorMs = anchorMs == null ? state.soc.sinceMs : Math.min(anchorMs, state.soc.sinceMs);

  const transition = active && !state.active ? 'freeze' : (!active && state.active ? 'clear' : null);
  if (transition === 'freeze') state.since = now;
  if (transition === 'clear') state.since = null;
  state.active = active;
  state.reasons = reasons;
  state.anchorMs = anchorMs;
  state.stalledFields = frozenA ? present.map(([name]) => name) : (frozenB ? ['soc'] : []);
  return { state, transition };
}

/**
 * Wächter-Fabrik für den Poll-Pfad (polling.js ruft tick() am Zyklus-Ende).
 * ctx: { state, getCfg, transport, pushLog, telemetrySafeWrite?, telemetryStore?,
 *        notificationService?, monitoringAlertPush? }
 */
export function createFreezeWatchdog(ctx) {
  const { state, getCfg, transport, pushLog } = ctx;
  let fstate = createFreezeState();
  let prevStamps = {};
  let prevMeterAt = 0;
  let lastReconnectAt = 0;
  let reconnectsThisEpisode = 0;

  /**
   * Sample aus dem Live-State bauen — NUR Felder, deren Read in diesem Zyklus
   * erfolgreich war. Erkennungsmerkmal: der T-0075-Erfolgs-Stempel
   * (fieldUpdatedAt) bzw. meter.updatedAt hat sich seit dem letzten Tick bewegt.
   * Die Stempel werden VOR dem eigenen Rückdatieren gelesen (siehe tick()).
   */
  function buildSample(nowMs, stamps, meterOk, meterAt) {
    const v = state.victron || {};
    const advanced = (name) => Number(stamps?.[name]) > 0 && Number(stamps[name]) !== Number(prevStamps?.[name] || 0);
    const values = {};
    if (meterOk && meterAt > 0 && meterAt !== prevMeterAt) values.grid_total_w = state.meter?.grid_total_w;
    if (advanced('batteryPowerW')) values.batteryPowerW = v.batteryPowerW;
    if (advanced('soc')) values.soc = v.soc;
    // pvTotalW ist abgeleitet (DC + AC): die Frische kommt vom jeweils gepollten
    // Basis-Punkt. selfConsumptionW ist entweder gepollt oder aus Meter+PV
    // abgeleitet — im abgeleiteten Fall trägt es keine EIGENE Information und
    // bleibt draußen (sonst zählte derselbe eingefrorene Messwert doppelt).
    if (advanced('pvPowerW') || advanced('acPvL1W')) values.pvTotalW = v.pvTotalW;
    if (advanced('selfConsumptionW')) values.selfConsumptionW = v.selfConsumptionW;
    return { nowMs, values };
  }

  function alarm(reasons, detail) {
    pushLog('telemetry_freeze_detected', detail, 'critical');
    try {
      ctx.telemetrySafeWrite?.(() => ctx.telemetryStore?.writeControlEvent({
        eventType: 'telemetry_freeze_detected',
        target: 'telemetry',
        valueNum: null,
        reason: reasons.join('+'),
        source: 'runtime',
        meta: detail
      }));
    } catch { /* Alarm darf den Poll-Zyklus nie brechen */ }
    const body = reasons.includes('identical_values')
      ? `Die Live-Werte der Anlage stehen seit ${Math.round((detail.stalledForMs || 0) / 1000)} s unverändert still (${(detail.fields || []).join(', ')}). DVhub hält jede erzwungene Entladung an und baut die Verbindung neu auf. Bitte am GX/Wechselrichter prüfen (Modbus-Dienst neu starten hilft erfahrungsgemäß).`
      : `Der Ladestand steht seit ${Math.round((detail.stalledForMs || 0) / 1000)} s auf ${detail.soc} %, obwohl bereits ${Math.round(detail.throughputWh || 0)} Wh Akku-Leistung gemeldet wurden. DVhub behandelt den Ladestand als veraltet und hält jede erzwungene Entladung an.`;
    try {
      ctx.notificationService?.sendDirect?.({
        event: 'telemetry_freeze', level: 'critical',
        title: 'DVhub: Live-Daten eingefroren', body
      })?.catch?.(() => { /* fire-and-forget */ });
    } catch { /* noop */ }
    try {
      Promise.resolve(ctx.monitoringAlertPush?.('down', `DVhub: Live-Daten eingefroren (${reasons.join('+')})`))
        .catch(() => { /* noop */ });
    } catch { /* noop */ }
  }

  function cleared(detail) {
    pushLog('telemetry_freeze_cleared', detail, 'warn');
    try {
      ctx.notificationService?.sendDirect?.({
        event: 'telemetry_freeze_cleared', level: 'info',
        title: 'DVhub: Live-Daten wieder aktuell',
        body: `Die Messwerte bewegen sich wieder (Stillstand ${Math.round((detail.stalledForMs || 0) / 1000)} s). Die Steuerung arbeitet normal weiter.`
      })?.catch?.(() => { /* fire-and-forget */ });
    } catch { /* noop */ }
    try {
      Promise.resolve(ctx.monitoringAlertPush?.('up', 'DVhub: Live-Daten wieder aktuell'))
        .catch(() => { /* noop */ });
    } catch { /* noop */ }
  }

  /** Ein Poll-Zyklus. Wirft nie. */
  function tick(nowMs = Date.now()) {
    const cfg = getCfg() || {};
    const opts = resolveFreezeOptions(cfg);
    // MQTT ist on-change (unveränderte Werte sind dort normal) → Wächter aus.
    if (!opts.enabled || transport?.type !== 'modbus') {
      if (fstate.active) fstate = createFreezeState();
      if (state.victron) state.victron.freeze = null;
      return null;
    }

    // Stempel VOR dem eigenen Rückdatieren einfrieren (sonst hielte der Wächter
    // seine eigene Rückdatierung für einen fehlgeschlagenen Read).
    const stamps = { ...(state.victron?.fieldUpdatedAt || {}) };
    const meterOk = state.meter?.ok === true;
    const meterAt = Number(state.meter?.updatedAt || 0);

    const { transition } = evaluateFreeze(fstate, buildSample(nowMs, stamps, meterOk, meterAt), opts);
    prevStamps = stamps;
    if (meterOk && meterAt > 0) prevMeterAt = meterAt;

    const stalledForMs = fstate.anchorMs != null ? nowMs - fstate.anchorMs : 0;
    const detail = {
      reasons: fstate.reasons,
      fields: fstate.stalledFields,
      stalledForMs,
      soc: state.victron?.soc ?? null,
      throughputWh: fstate.soc ? Number(fstate.soc.throughputWh.toFixed(1)) : 0,
      batteryPowerW: state.victron?.batteryPowerW ?? null,
      gridTotalW: state.meter?.grid_total_w ?? null
    };

    if (transition === 'freeze') { reconnectsThisEpisode = 0; alarm(fstate.reasons, detail); }
    if (transition === 'clear') cleared(detail);

    if (state.victron) {
      state.victron.freeze = fstate.active
        ? {
          active: true,
          reason: fstate.reasons[0],
          reasons: [...fstate.reasons],
          since: new Date(fstate.since || nowMs).toISOString(),
          stalledSince: fstate.anchorMs != null ? new Date(fstate.anchorMs).toISOString() : null,
          stalledForMs,
          fields: [...fstate.stalledFields]
        }
        : null;
    }

    if (!fstate.active) return null;

    // --- 1) Frische-Stempel auf den letzten ECHTEN Wertwechsel zurückdatieren.
    // Damit sieht der bestehende T-0075-Entlade-Boden-Schutz das, was wirklich
    // gilt: diese Information ist stalledForMs alt. Selbstheilend — sobald sich
    // wieder etwas bewegt, stempelt pollPoint normal weiter.
    const anchor = fstate.anchorMs;
    if (anchor != null && state.victron?.fieldUpdatedAt) {
      const fu = state.victron.fieldUpdatedAt;
      if (fstate.reasons.includes('identical_values')) {
        for (const key of Object.keys(fu)) if (Number(fu[key]) > anchor) fu[key] = anchor;
        if (state.meter) {
          state.meter.ok = false;
          state.meter.error = `Live-Daten eingefroren: keine Wertänderung seit ${Math.round(stalledForMs / 1000)} s`;
        }
      } else if (Number(fu.soc) > anchor) {
        // Teil-Einfrierer: nur der SoC ist unglaubwürdig, die Leistungswerte leben.
        fu.soc = anchor;
      }
    }

    // --- 2) Modbus-Session verwerfen (throttled + gedeckelt) → frischer TCP-Aufbau.
    // Der Deckel ist Absicht, nicht Sparsamkeit: ein Abriss-/Neuaufbau-Karussell
    // belastet die dbus-Kette des GX bis zum Watchdog-Reboot, und tote Sessions
    // räumt er nicht ab. Nach maxReconnects bleibt es beim Alarm.
    if (typeof transport.dropConnections === 'function'
        && reconnectsThisEpisode < opts.maxReconnects
        && (nowMs - lastReconnectAt) >= opts.reconnectMs) {
      lastReconnectAt = nowMs;
      reconnectsThisEpisode += 1;
      try {
        const dropped = transport.dropConnections();
        pushLog('telemetry_freeze_reconnect', {
          dropped, attempt: reconnectsThisEpisode, maxAttempts: opts.maxReconnects,
          reasons: fstate.reasons, stalledForMs
        }, 'warn');
        if (reconnectsThisEpisode >= opts.maxReconnects) {
          pushLog('telemetry_freeze_reconnect_exhausted', {
            attempts: reconnectsThisEpisode,
            note: 'kein weiterer Neuaufbau — Verbindungs-Karussell schadet dem GX'
          }, 'warn');
        }
      } catch (e) {
        pushLog('telemetry_freeze_reconnect_error', { error: e?.message || String(e) }, 'warn');
      }
    }
    return fstate.reasons;
  }

  return { tick, _state: () => fstate };
}
