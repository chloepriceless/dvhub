// services/mqtt-crosscheck.js — T-CROSSCHECK Zweitquellen-Kreuzprobe (2026-07-25).
//
// ANLASS: Am 24.07.2026 lieferte der GX-Modbus-Dienst 2,5 h lang einen falschen,
// aber in sich stimmigen Weltzustand (Forensik: .planning/handover/
// HANDOVER-2026-07-24-EOS-KALIBRIERUNG-MODBUS.md, Abschnitt 6). NICHTS innerhalb der
// Modbus-Daten konnte das sehen: die Werte bewegten sich, die Energiebilanz war
// sauberer als im Normalbetrieb, Soll/Ist passte auf 100-190 W, und selbst eine
// ZWEITE Modbus-Sitzung sah exakt dieselben falschen Werte.
//
// WAS ES SEHEN KANN: eine Quelle außerhalb von `dbus-modbustcp`. Christin verglich
// im Zwischenfall VRM, Ekrano-Display und DVhub — Display und VRM zeigten die
// Wahrheit. Das Ekrano-Display liest den dbus DIREKT: der dbus war also richtig,
// gelogen hat nur die Modbus-Schicht davor. MQTT (`dbus-mqtt`/flashmq) spiegelt
// denselben dbus wie das Display und ist ein EIGENER Prozess auf dem GX.
//
// GEMESSEN an der realen Anlage (2026-07-25, 120 s parallel, read-only):
//   • Werte identisch (SoC/Akku Abweichung 0; Netz 0,25 W Rundung)
//   • MQTT ist ~207 ms schneller als ein 0,5-s-Poll (also praktisch verzögerungsfrei)
//   • MQTT-Kadenz = Quellkadenz = 1 Hz
// Im Normalbetrieb stimmen beide Kanäle also auf den Watt überein — jede ANHALTENDE
// Abweichung ist damit ein echtes Signal und kein Rauschen.
//
// WAS DIE REAKTION KANN — UND WAS NICHT (Christins Einwand, 2026-07-25):
// Eine Entladesperre über denselben Modbus-Kanal ist wirkungslos, wenn die Befehle
// ohnehin nicht wirken. Deshalb ist der ALARM das Hauptprodukt (Mensch als Aktor).
// Die Sperre bleibt als schmale Absicherung: sie verhindert, dass DVhub auf Basis
// bekannt falscher Werte NEUE Entladebefehle absetzt und dass ein solcher Befehl
// später wirksam wird, wenn die Verbindung wieder greift. Der eigentliche Ausweg
// (Steuerung auf MQTT umschalten) ist ein separater, steuerkritischer Schritt.

/** Felder der Kreuzprobe. `abs`/`rel`: erlaubte Abweichung (beide müssen gerissen sein). */
export const CROSSCHECK_FIELDS = [
  { key: 'soc', label: 'Ladestand', unit: '%', abs: 3, rel: 0 },
  { key: 'batteryPowerW', label: 'Akku-Leistung', unit: 'W', abs: 400, rel: 0.15 },
  { key: 'gridTotalW', label: 'Netzleistung', unit: 'W', abs: 400, rel: 0.15 }
];

export const CROSSCHECK_DEFAULTS = {
  enabled: false,        // braucht Broker-Zugangsdaten → bewusst opt-in
  compareMs: 15000,      // Vergleichstakt
  sustainMs: 180000,     // so lange muss die Abweichung ANHALTEN
  maxAgeMs: 60000,       // beide Seiten müssen so frisch sein
  keepaliveMs: 25000     // Venus stellt ohne Keepalive nach 60 s das Publizieren ein
};

function numOr(value, fallback, min = -Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function resolveCrossCheckOptions(cfg = {}) {
  const c = cfg?.victron?.mqttCrossCheck || {};
  const m = cfg?.victron?.mqtt || {};
  const host = cfg?.victron?.host || '';
  return {
    enabled: c.enabled === true,
    broker: c.broker || m.broker || (host ? `mqtts://${host}:8883` : ''),
    portalId: c.portalId || m.portalId || '',
    username: c.username || m.username || '',
    password: c.password || m.password || '',
    // Venus liefert ein selbstsigniertes Zertifikat (CN=venus.local) — eine
    // Prüfung gegen eine öffentliche CA schlägt zwangsläufig fehl. Der Kanal
    // bleibt verschlüsselt; die Gegenstelle ist die per IP adressierte Anlage
    // im eigenen LAN. Bewusst abschaltbar, falls jemand eine eigene CA fährt.
    rejectUnauthorized: c.rejectUnauthorized === true,
    compareMs: numOr(c.compareMs, CROSSCHECK_DEFAULTS.compareMs, 5000),
    sustainMs: numOr(c.sustainMs, CROSSCHECK_DEFAULTS.sustainMs, 30000),
    maxAgeMs: numOr(c.maxAgeMs, CROSSCHECK_DEFAULTS.maxAgeMs, 10000),
    keepaliveMs: numOr(c.keepaliveMs, CROSSCHECK_DEFAULTS.keepaliveMs, 5000)
  };
}

/**
 * Ein Vergleich. PURE — kein IO, testbar.
 * @param {object} mqttValues   { soc, batteryPowerW, gridTotalW } + _ts je Feld
 * @param {object} modbusValues dieselben Felder aus dem Live-State
 * @param {object} state        Vergleichs-Gedächtnis (divergingSince je Feld)
 * @returns {{ mismatches: Array, state: object, transition: 'mismatch'|'clear'|null }}
 */
export function compareSources(mqttValues, modbusValues, state, opts, nowMs = Date.now()) {
  const mem = state || { fields: {}, active: false, since: null };
  const mismatches = [];
  for (const f of CROSSCHECK_FIELDS) {
    const a = Number(mqttValues?.[f.key]);
    const b = Number(modbusValues?.[f.key]);
    const aAge = Number(mqttValues?.[`${f.key}_ageMs`]);
    const bAge = Number(modbusValues?.[`${f.key}_ageMs`]);
    // Beide Seiten müssen frisch sein. Fehlt eine, ist das KEIN Widerspruch,
    // sondern Unwissen — dafür ist die T-0075-Frische zuständig, nicht dieser Wächter.
    const usable = Number.isFinite(a) && Number.isFinite(b)
      && (!Number.isFinite(aAge) || aAge <= opts.maxAgeMs)
      && (!Number.isFinite(bAge) || bAge <= opts.maxAgeMs);
    if (!usable) { delete mem.fields[f.key]; continue; }
    const diff = Math.abs(a - b);
    const limit = Math.max(f.abs, f.rel * Math.max(Math.abs(a), Math.abs(b)));
    if (diff <= limit) { delete mem.fields[f.key]; continue; }
    const entry = mem.fields[f.key] || (mem.fields[f.key] = { since: nowMs, worst: 0 });
    entry.worst = Math.max(entry.worst, diff);
    entry.mqtt = a; entry.modbus = b;
    if ((nowMs - entry.since) >= opts.sustainMs) {
      mismatches.push({
        key: f.key, label: f.label, unit: f.unit,
        mqtt: a, modbus: b, diff: Number(diff.toFixed(1)),
        limit: Number(limit.toFixed(1)), seitMs: nowMs - entry.since
      });
    }
  }
  const active = mismatches.length > 0;
  const transition = active && !mem.active ? 'mismatch' : (!active && mem.active ? 'clear' : null);
  if (transition === 'mismatch') mem.since = nowMs;
  if (transition === 'clear') mem.since = null;
  mem.active = active;
  mem.mismatches = mismatches;
  return { mismatches, state: mem, transition };
}

/**
 * Fabrik: eigener, rein LESENDER MQTT-Client zum GX + Vergleichstakt.
 * ctx: { state, getCfg, pushLog, telemetrySafeWrite?, telemetryStore?,
 *        notificationService?, monitoringAlertPush? }
 */
export function createMqttCrossCheck(ctx) {
  const { state, getCfg, pushLog } = ctx;
  let client = null;
  let keepaliveTimer = null;
  let compareTimer = null;
  let stopping = false;
  let mem = { fields: {}, active: false, since: null };
  const cache = new Map();  // topic → { value, ts }
  let connectedAt = 0;
  let lastConnectError = null;

  function topics(portalId) {
    return {
      soc: `N/${portalId}/system/0/Dc/Battery/Soc`,
      batteryPowerW: `N/${portalId}/system/0/Dc/Battery/Power`,
      gridL1W: `N/${portalId}/system/0/Ac/Grid/L1/Power`,
      gridL2W: `N/${portalId}/system/0/Ac/Grid/L2/Power`,
      gridL3W: `N/${portalId}/system/0/Ac/Grid/L3/Power`
    };
  }

  function cached(topic, maxAgeMs, nowMs) {
    const e = cache.get(topic);
    if (!e || e.value == null) return null;
    if ((nowMs - e.ts) > maxAgeMs) return null;
    return e;
  }

  /** MQTT-Seite in DVhub-Konvention bringen (Venus: positiv = Netzbezug). */
  function mqttSnapshot(opts, nowMs) {
    const t = topics(opts.portalId);
    const out = {};
    const soc = cached(t.soc, opts.maxAgeMs, nowMs);
    if (soc) { out.soc = Number(soc.value); out.soc_ageMs = nowMs - soc.ts; }
    const bat = cached(t.batteryPowerW, opts.maxAgeMs, nowMs);
    if (bat) { out.batteryPowerW = Number(bat.value); out.batteryPowerW_ageMs = nowMs - bat.ts; }
    const phases = [t.gridL1W, t.gridL2W, t.gridL3W].map((x) => cached(x, opts.maxAgeMs, nowMs));
    if (phases.some(Boolean)) {
      // Eine nie gesehene Phase zählt 0 (1-/2-phasige Anlagen publizieren sie nicht),
      // eine STALE Phase macht die Summe unbrauchbar (sonst fiele sie still weg).
      const seen = phases.filter(Boolean);
      const sum = seen.reduce((acc, e) => acc + Number(e.value || 0), 0);
      const posImport = getCfg()?.gridPositiveMeans === 'grid_import';
      out.gridTotalW = posImport ? sum : -sum;
      out.gridTotalW_ageMs = nowMs - Math.min(...seen.map((e) => e.ts));
    }
    return out;
  }

  function modbusSnapshot(nowMs) {
    const v = state.victron || {};
    const fu = v.fieldUpdatedAt || {};
    const out = {};
    if (v.soc != null) { out.soc = Number(v.soc); out.soc_ageMs = fu.soc ? nowMs - fu.soc : null; }
    if (v.batteryPowerW != null) {
      out.batteryPowerW = Number(v.batteryPowerW);
      out.batteryPowerW_ageMs = fu.batteryPowerW ? nowMs - fu.batteryPowerW : null;
    }
    if (state.meter?.ok === true && state.meter.grid_total_w != null) {
      out.gridTotalW = Number(state.meter.grid_total_w);
      out.gridTotalW_ageMs = nowMs - Number(state.meter.updatedAt || 0);
    }
    return out;
  }

  function alarm(mismatches) {
    const list = mismatches.map((m) => `${m.label}: MQTT ${m.mqtt}${m.unit} vs. Modbus ${m.modbus}${m.unit}`).join(' · ');
    pushLog('telemetry_source_mismatch', { mismatches }, 'critical');
    try {
      ctx.telemetrySafeWrite?.(() => ctx.telemetryStore?.writeControlEvent({
        eventType: 'telemetry_source_mismatch', target: 'telemetry', valueNum: null,
        reason: mismatches.map((m) => m.key).join('+'), source: 'runtime', meta: { mismatches }
      }));
    } catch { /* Alarm darf nie den Takt brechen */ }
    try {
      ctx.notificationService?.sendDirect?.({
        event: 'telemetry_source_mismatch', level: 'critical',
        title: 'DVhub: Anlagendaten widersprüchlich',
        body: `Die Anlage meldet über zwei getrennte Wege unterschiedliche Werte (${list}). `
          + 'Erfahrungsgemäß hat dann der Modbus-Dienst des GX veraltete Daten und nimmt auch '
          + 'keine Steuerbefehle mehr an. DVhub setzt keine neuen Entladebefehle mehr ab. '
          + 'Bitte am Gerät prüfen — ein Neustart des Modbus-Dienstes am GX behebt es erfahrungsgemäß.'
      })?.catch?.(() => { /* fire-and-forget */ });
    } catch { /* noop */ }
    try {
      Promise.resolve(ctx.monitoringAlertPush?.('down', 'DVhub: Anlagendaten widersprüchlich (MQTT vs. Modbus)'))
        .catch(() => { /* noop */ });
    } catch { /* noop */ }
  }

  function cleared() {
    pushLog('telemetry_source_mismatch_cleared', {}, 'warn');
    try {
      ctx.notificationService?.sendDirect?.({
        event: 'telemetry_source_mismatch_cleared', level: 'info',
        title: 'DVhub: Anlagendaten wieder stimmig',
        body: 'Beide Datenwege der Anlage liefern wieder dieselben Werte. Die Steuerung arbeitet normal weiter.'
      })?.catch?.(() => { /* fire-and-forget */ });
    } catch { /* noop */ }
    try {
      Promise.resolve(ctx.monitoringAlertPush?.('up', 'DVhub: Anlagendaten wieder stimmig')).catch(() => { /* noop */ });
    } catch { /* noop */ }
  }

  /** Ein Vergleichstakt. Wirft nie. */
  function compare(nowMs = Date.now()) {
    try {
      const opts = resolveCrossCheckOptions(getCfg() || {});
      if (!opts.enabled) { state.victron && (state.victron.sourceMismatch = null); return null; }
      const { mismatches, transition } = compareSources(
        mqttSnapshot(opts, nowMs), modbusSnapshot(nowMs), mem, opts, nowMs
      );
      if (transition === 'mismatch') alarm(mismatches);
      if (transition === 'clear') cleared();
      if (state.victron) {
        state.victron.sourceMismatch = mem.active
          ? {
            active: true, since: new Date(mem.since || nowMs).toISOString(),
            fields: mismatches.map((m) => m.key), mismatches
          }
          : null;
      }
      return mismatches;
    } catch (e) {
      try { pushLog('mqtt_crosscheck_error', { error: e?.message || String(e) }, 'warn'); } catch { /* noop */ }
      return null;
    }
  }

  async function start() {
    const opts = resolveCrossCheckOptions(getCfg() || {});
    if (!opts.enabled) return;
    if (!opts.portalId || !opts.broker) {
      pushLog('mqtt_crosscheck_unconfigured', { broker: !!opts.broker, portalId: !!opts.portalId }, 'warn');
      return;
    }
    stopping = false;
    const mqtt = await import('mqtt');
    const connectFn = mqtt.default?.connect || mqtt.connect;
    client = connectFn(opts.broker, {
      username: opts.username || undefined,
      password: opts.password || undefined,
      rejectUnauthorized: opts.rejectUnauthorized,
      clean: true, connectTimeout: 8000, reconnectPeriod: 5000
    });
    const t = topics(opts.portalId);
    client.on('connect', () => {
      connectedAt = Date.now();
      lastConnectError = null;
      client.subscribe(Object.values(t), { qos: 0 }, (err) => {
        if (err) pushLog('mqtt_crosscheck_subscribe_error', { error: err.message }, 'warn');
      });
      const ka = () => { try { client.publish(`R/${opts.portalId}/keepalive`, ''); } catch { /* noop */ } };
      ka();
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = setInterval(ka, opts.keepaliveMs);
      keepaliveTimer.unref?.();
      pushLog('mqtt_crosscheck_connected', { broker: opts.broker });
    });
    client.on('message', (topic, payload, packet) => {
      // Ein RETAINED-Replay ist kein Frische-Beweis (dieselbe Lehre wie im
      // MQTT-Transport, T-MQTT-RETAIN) — sonst wäre die Kreuzprobe mit
      // Alt-Werten gefüttert und meldete Widersprüche, die keine sind.
      if (packet?.retain) return;
      try {
        const msg = JSON.parse(payload.toString());
        if (msg.value !== undefined && msg.value !== null) cache.set(topic, { value: msg.value, ts: Date.now() });
      } catch { /* noop */ }
    });
    client.on('error', (e) => {
      lastConnectError = e?.message || String(e);
      if (!stopping) pushLog('mqtt_crosscheck_connection_error', { error: lastConnectError }, 'warn');
    });
    compareTimer = setInterval(() => compare(), opts.compareMs);
    compareTimer.unref?.();
  }

  function stop() {
    stopping = true;
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (compareTimer) { clearInterval(compareTimer); compareTimer = null; }
    if (client) { try { client.end(true); } catch { /* noop */ } client = null; }
  }

  function getStatus() {
    const opts = resolveCrossCheckOptions(getCfg() || {});
    return {
      enabled: opts.enabled,
      connected: !!client?.connected,
      connectedAt: connectedAt || null,
      topics: cache.size,
      lastError: lastConnectError,
      mismatch: state.victron?.sourceMismatch || null
    };
  }

  return { start, stop, compare, getStatus, _mem: () => mem };
}
