// SEC-01: Single source of truth for redacted config field paths.
// Imported by routes-api.js (redactConfig) and server.js (restoreRedacted)


export const REDACTED_PATHS = Object.freeze([
  'apiToken',
  'telemetry.historyImport.vrmToken',
  'telemetry.database.password',
  'dbBackup.smb.password',
  // Phase 24-05 (§5): the SMB service-account NAME also leaks an internal
  // identity — whole-field redaction (covers redact + restore automatically).
  'dbBackup.smb.username',
  'forecast.solcast.apiKey',
  'forecast.pvnode.apiKey',
  'mqtt.username',
  'mqtt.password',
  // T-CROSSCHECK (2026-07-25): Zugangsdaten der GX-Zweitquelle. FlashMQ auf dem
  // GX prüft gegen das Remote-Console-Passwort — dasselbe Geheimnis wie der
  // Gerätezugang, gehört also nie in einen Config-Export.
  'victron.mqtt.username',
  'victron.mqtt.password',
  'victron.mqttCrossCheck.username',
  'victron.mqttCrossCheck.password',
  // T-0131 MQTT weather provider (Review 2026-06-10 B4): the dedicated weather
  // broker can carry its own credentials — redact like the top-level mqtt block.
  'forecast.weather.mqtt.username',
  'forecast.weather.mqtt.password',
  'monitoring.signingKey',
  'notifications.providers.telegram.botToken',
  'notifications.providers.telegram.chatId',
  'notifications.providers.pushover.appToken',
  'notifications.providers.pushover.userKey',
  'notifications.providers.ntfy.token',
  // Zugang zur OpenEVSE-Weboberflaeche (Basic Auth) — Geraetezugang, nie in einen Export.
  'wallbox.openevse.username',
  'wallbox.openevse.password',
  'wallbox.wattpilot.password',
  'wallbox.nrgkick.username',
  'wallbox.nrgkick.password',
  // evcc-Fahrzeugtreiber (services/vehicle-evcc): Zugangsdaten beim Hersteller,
  // Tokens, FIN — das ganze Objekt, die Felder hängen von der Vorlage ab.
  'vehicleEvcc.params',
  // OCPP-Zentrale: Passwort der Wallboxen (Sicherheitsprofil 1).
  'ocpp.password',
  // E-Auto-Ladestand per HTTP-Abruf / Home Assistant (services/vehicle-pull).
  'optimizer.evHttpToken',
  'optimizer.evHaToken',
  // Preis vom Stromanbieter (services/tariff-provider): Tibber-Zugangsschlüssel,
  // LichtBlick-App-Login. Die E-Mail ist zugleich Kennung des Kundenkontos.
  'userEnergyPricing.provider.tibber.token',
  'userEnergyPricing.provider.lichtblick.email',
  'userEnergyPricing.provider.lichtblick.password',
  // LUOX/Lumenaza (T-0417): Kundenportal-Login und Partner-API (OAuth2). Ziele
  // fest (portal.luox-energy.de, api[.test].lumenaza.de) — kein SECRET_TARGETS.
  'luox.email',
  'luox.password',
  'luox.partner.clientId',
  'luox.partner.clientSecret',
  // EOS-Rechendienst (Fernbetrieb): Zugangsschlüssel der Box, beim
  // Einschreiben mit der Lizenz ausgegeben.
  'optimizer.eosProxy.remote.token'
  // Phase 09.4 gap-closure: notifications.providers.uptime-kuma removed — the
  // Uptime Kuma integration is the `monitoring` block; monitoring.pushUrl is
  // redacted below via redactUrlCreds (URL-level, not whole-field).
]);

export const REDACTED = '***';

// Geheimnis → Adressen, an die es tatsächlich geht. Steht das Geheimnis als
// „***“ im Entwurf (unverändert) bzw. trägt eine Route den gespeicherten Wert
// weiter, und kommt dabei eine neue Adresse hinzu, wandert der gespeicherte
// Wert NICHT mit (Strix-Fund 29.10.2026 für ntfy; Gegenprüfungen edeb17db und
// bca61061): sonst setzt ein Gerät im WLAN eine eigene Adresse ein und bekommt
// den Token beim nächsten Abruf geschickt. Die Ziele folgen denselben
// Rückfall-Regeln wie die Verbraucher (Wetter- und Kreuzprobe-MQTT nehmen ohne
// eigene Zugangsdaten die allgemeinen, Victron-MQTT ohne Broker victron.host).
// Wer die Adresse ändert, gibt das Geheimnis neu ein.
const g = (cfg, p) => getPath(cfg, p);
function victronBroker(cfg) {
  const vm = g(cfg, 'victron.mqtt') || {};
  if (vm.broker) return vm.broker;
  if (vm.schema === 'dvhub') return g(cfg, 'mqtt.brokerUrl') || '';
  const host = g(cfg, 'victron.host');
  return host ? `mqtt://${host}:1883` : '';
}
function crossCheckBroker(cfg) {
  const c = g(cfg, 'victron.mqttCrossCheck') || {};
  const host = g(cfg, 'victron.host');
  return c.broker || g(cfg, 'victron.mqtt.broker') || (host ? `mqtts://${host}:8883` : '');
}
function hostPort(host, port) {
  const h = String(host ?? '').trim();
  if (!h) return '';
  return `${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}:${port}`;
}
function weatherBroker(cfg) { return g(cfg, 'forecast.weather.mqtt.brokerUrl') || g(cfg, 'mqtt.brokerUrl') || ''; }
const SECRET_TARGETS = {
  'notifications.providers.ntfy.token': (c) => [g(c, 'notifications.providers.ntfy.topicUrl')],
  'optimizer.evHaToken': (c) => [g(c, 'optimizer.evHaUrl')],
  'optimizer.evHttpToken': (c) => [g(c, 'optimizer.evHttpUrl')],
  'optimizer.eosProxy.remote.token': (c) => [g(c, 'optimizer.eosProxy.remote.endpoint')],
  'dbBackup.smb.username': (c) => [g(c, 'dbBackup.smb.host')],
  'dbBackup.smb.password': (c) => [g(c, 'dbBackup.smb.host')],
  // Port steht hier in einem eigenen Feld (Gegenprüfung 039a110c, P2).
  'telemetry.database.password': (c) => [hostPort(g(c, 'telemetry.database.host'), g(c, 'telemetry.database.port') || 5432)],
  'wallbox.openevse.username': (c) => [g(c, 'wallbox.openevse.url')],
  'wallbox.openevse.password': (c) => [g(c, 'wallbox.openevse.url')],
  'wallbox.nrgkick.username': (c) => [g(c, 'wallbox.nrgkick.host')],
  'wallbox.nrgkick.password': (c) => [g(c, 'wallbox.nrgkick.host')],
  'wallbox.wattpilot.password': (c) => [g(c, 'wallbox.wattpilot.host')],
};
for (const f of ['username', 'password']) {
  SECRET_TARGETS[`mqtt.${f}`] = (c) => [
    g(c, 'mqtt.brokerUrl'),
    ...(g(c, 'forecast.weather.provider') === 'mqtt' && !g(c, `forecast.weather.mqtt.${f}`) ? [weatherBroker(c)] : []),
  ];
  SECRET_TARGETS[`forecast.weather.mqtt.${f}`] = (c) => [weatherBroker(c)];
  SECRET_TARGETS[`victron.mqtt.${f}`] = (c) => [
    victronBroker(c),
    ...(!g(c, `victron.mqttCrossCheck.${f}`) ? [crossCheckBroker(c)] : []),
  ];
  SECRET_TARGETS[`victron.mqttCrossCheck.${f}`] = (c) => [crossCheckBroker(c)];
}
export const SECRET_TARGET_PATHS = Object.freeze(Object.keys(SECRET_TARGETS));

// Ziel = Host, Port plus „gesichert?“. Gleicher Host und Port und gleiche
// oder bessere Sicherung (mqtt → mqtts, http → https) gilt als dasselbe Ziel;
// ein anderer Host, ein anderer Port (ein anderer Dienst, Gesamtprüfung
// 1.0.9) oder TLS → Klartext gilt als neu (Gegenprüfung 4fe254c9: sonst ginge
// das Geheimnis im Klartext). Standard-Ports zählen wie weggelassene; beim
// Wechsel auf die bessere Sicherung darf sich der Port mitändern
// (mqtt://b:1883 → mqtts://b:8883). Nicht URL.origin — für mqtt:// u. ä. ist
// die Herkunft immer „null“.
const SECURE_SCHEMES = new Set(['https:', 'mqtts:', 'wss:', 'ssl:', 'tls:']);
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443', 'mqtt:': '1883', 'mqtts:': '8883', 'tcp:': '1883', 'ssl:': '8883', 'tls:': '8883', 'smb:': '445' };
function normTarget(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (s.includes('://')) {
    try {
      const u = new URL(s);
      const port = u.port || DEFAULT_PORTS[u.protocol] || '';
      return { host: u.hostname.replace(/^\[|\]$/g, ''), secure: SECURE_SCHEMES.has(u.protocol), port, std: port !== '' && port === DEFAULT_PORTS[u.protocol], proto: u.protocol };
    } catch { return { host: s, secure: null, port: '' }; }
  }
  // host[:port] ohne Schema: Port nur bei genau einem ':' bzw. [v6]:port abtrennen
  // (sonst verschmolzen fd00::1 und fd00::1234, Gegenprüfung 4fe254c9).
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) return { host: v6[1], secure: null, port: v6[2] || '' };
  const hp = s.split(':').length === 2 ? /^(.*):(\d+)$/.exec(s) : null;
  return hp ? { host: hp[1], secure: null, port: hp[2] } : { host: s, secure: null, port: '' };
}
function targetsOf(cfg, secretPath) {
  return SECRET_TARGETS[secretPath](cfg || {}).map(normTarget);
}
// Beim Wechsel auf die bessere Sicherung darf sich der Port nur von einem
// Standard-Port zum anderen ändern (1883 → 8883, 80 → 443), sonst wäre jeder
// TLS-Dienst auf demselben Host „dasselbe Ziel“ (Gegenprüfung 039a110c, P2).
// Nur zusammengehörige Paare (mqtt ↔ mqtts, http ↔ https, ws ↔ wss) — mqtt://b
// → wss://b wäre ein anderer Dienst (Gegenprüfung eb44b949, P3).
const TLS_UPGRADE = { 'mqtt:': ['mqtts:', 'ssl:', 'tls:'], 'tcp:': ['mqtts:', 'ssl:', 'tls:'], 'http:': ['https:'], 'ws:': ['wss:'] };
function isNewTarget(t, before) {
  return !before.some((b) => b.host === t.host
    && !(b.secure === true && t.secure === false)
    && (b.port === t.port || (b.std && t.std && (TLS_UPGRADE[b.proto] || []).includes(t.proto))));
}

/**
 * Setzt in `next` jedes Geheimnis aus `keptPaths` auf '', dessen Ziele in
 * `next` eine Adresse enthalten, die in `current` nicht dabei war. Gibt die
 * geleerten Pfade zurück.
 */
export function dropSecretsForChangedTargets(next, current, keptPaths) {
  const dropped = [];
  // Bis nichts mehr fällt: ein geleertes spezielles Geheimnis (Wetter-,
  // Kreuzprobe-Zugang) macht das allgemeine zum Rückfall für das neue Ziel
  // (Gegenprüfung 4fe254c9, P2 — vorher hing es an der Reihenfolge).
  for (let changed = true; changed;) {
    changed = false;
    for (const sp of keptPaths) {
      if (!SECRET_TARGETS[sp] || dropped.includes(sp)) continue;
      const val = getPath(next, sp);
      if (val === undefined || val === '' || val === null) continue;
      const before = targetsOf(current, sp);
      if (targetsOf(next, sp).some((t) => isNewTarget(t, before))) { setPath(next, sp, ''); dropped.push(sp); changed = true; }
    }
  }
  return dropped;
}

/** Für Routen, die gespeicherte Werte selbst weitertragen: alle Geheimnisse, die unverändert geblieben sind. */
export function unchangedSecretPaths(next, current) {
  return SECRET_TARGET_PATHS.filter((sp) => {
    const v = getPath(next, sp);
    return typeof v === 'string' && v !== '' && v === getPath(current, sp);
  });
}

function getPath(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function setPath(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let o = obj;
  for (const k of parts.slice(0, -1)) {
    if (!o || typeof o !== 'object') return;
    o = o[k];
  }
  if (o && typeof o === 'object') o[parts.at(-1)] = value;
}

export function isRedactedPath(path) {
  return REDACTED_PATHS.includes(path);
}

// Plan 08-03 Task 2: URL-level credential redaction for fields that carry
// user:password@host embedded in the URL itself (e.g. mqtt.brokerUrl,
// monitoring.pushUrl). Whole-field redaction would break the useful parts
// (broker host, health-check endpoint), so only the userinfo component is
// stripped. Non-URL / malformed input is passed through untouched unless
// it contains an `@`, in which case we defensively mask.
export function redactUrlCreds(raw) {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== 'string') return raw;
  if (raw.length === 0) return raw;
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      if (u.username) u.username = '***';
      if (u.password) u.password = '***';
      return u.toString();
    }
    return raw;
  } catch {
    // Not a parseable URL (e.g. empty-scheme host:port). Best effort: if
    // an `@` is present it's likely a userinfo separator, so redact the
    // left-hand side rather than leak creds.
    return raw.includes('@') ? '***@redacted' : raw;
  }
}

// Phase 24-05 (§5): redact embedded credentials from a SCHEMELESS host string
// (e.g. a modbus `user:pass@192.168.1.7`). Unlike redactUrlCreds, this does NOT
// run `new URL()` — for a schemeless input `new URL('user:pass@host')` parses
// `user:` as the scheme and silently leaks the rest. A bare `@` here is always a
// userinfo separator, so strip everything left of the LAST `@`. A credential-free
// host (no `@`) is returned untouched (no-op for the normal bare-IP case).
export function redactHostCreds(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  const at = raw.lastIndexOf('@');
  if (at < 0) return raw;
  return `***@${raw.slice(at + 1)}`;
}

// T-0113 support bundle: scrub FREE TEXT (log-ring lines, audit_log payloads)
// for secrets + obvious PII before they enter a shareable diagnostic bundle.
// This is the SECOND line of defence — the bundle is allowlist-built (only
// known-safe sources) and config goes through redactConfig() first; scrubText
// catches secrets/PII that leak into event payloads. Conservative + over-redacts
// rather than under-redacts (a diagnostic bundle is meant to be sharable).
const SCRUB_PATTERNS = Object.freeze([
  // "Bearer <token>"
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, '$1***'],
  // key/token/secret/password = value  (json or kv form)
  [/\b(api[_-]?key|apitoken|access[_-]?token|token|secret|password|passwd|pwd|auth|signingkey|botToken)(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi, '$1$2***'],
  // JWT
  [/\beyJ[A-Za-z0-9._-]{20,}/g, '***'],
  // long hex blobs (>=32) — likely keys/hashes/tokens
  [/\b[A-Fa-f0-9]{32,}\b/g, '***'],
  // email addresses (PII)
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '***@***'],
  // userinfo embedded in URLs
  [/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://***:***@'],
  // PUBLIC IPv4 → masked (PII / customer location). RFC1918 + loopback are KEPT
  // because LAN/GX addresses (192.168.x, the Victron GX, the broker) are exactly
  // what makes a diagnostic bundle useful. Replacer decides per-match.
  [/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a, b) => {
    const o1 = Number(a), o2 = Number(b);
    if (o1 > 255 || o2 > 255) return m; // not a real octet (version string etc.)
    const isPrivate = o1 === 10
      || (o1 === 172 && o2 >= 16 && o2 <= 31)
      || (o1 === 192 && o2 === 168)
      || o1 === 127
      || (o1 === 169 && o2 === 254); // link-local
    return isPrivate ? m : '***.***.***.***';
  }],
]);

export function scrubText(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let s = input;
  for (const [re, repl] of SCRUB_PATTERNS) s = s.replace(re, repl);
  return s;
}

// Keys whose VALUE is a secret regardless of its shape (audit/log payloads
// often carry e.g. {token:"<opaque>"} where the value matches no pattern). A
// normalised key (lowercased, _/- stripped) containing one of these → mask the
// whole string value. Substring match so botToken/appToken/clientSecret hit.
const SECRET_KEY_RE = /(password|passwd|secret|token|apikey|signingkey|privatekey|accesskey)/;

// Recursively scrub a structured value (audit payloads, log event detail
// objects): string values are pattern-scrubbed; a string value whose KEY looks
// like a secret is fully masked; keys themselves are left intact. Cycle-safe.
export function scrubDeep(value, _seen) {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  const seen = _seen || new WeakSet();
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const keyNorm = String(k).toLowerCase().replace(/[_-]/g, '');
    if (typeof v === 'string' && v.length > 0 && SECRET_KEY_RE.test(keyNorm)) {
      out[k] = REDACTED;
    } else {
      out[k] = scrubDeep(v, seen);
    }
  }
  return out;
}

/**
 * Gespeicherte Platzhalter leeren (verändert `config`). Ein „***" als Wert ist
 * nie ein echter Zugang — es ist der Rest eines früheren fehlerhaften Speicherns.
 */
export function scrubStoredPlaceholders(config) {
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let obj = config;
    for (let i = 0; i < parts.length - 1; i++) obj = obj?.[parts[i]];
    const key = parts[parts.length - 1];
    if (obj && typeof obj === 'object' && obj[key] === REDACTED) obj[key] = '';
  }
  return config;
}

export function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let obj = copy;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj?.[parts[i]];
      if (!obj) break;
    }
    const key = parts[parts.length - 1];
    if (obj && key in obj) {
      // Leer oder nur der gespeicherte Platzhalter = nichts hinterlegt. Das als
      // „***" auszugeben ließe die Oberfläche „gesetzt" anzeigen, obwohl kein
      // Zugang da ist (07.10.2026: Pushover/Telegram standen so auf der Anlage).
      const value = obj[key];
      obj[key] = (value == null || value === '' || value === REDACTED) ? '' : REDACTED;
    }
  }
  // Plan 08-03 Task 2: strip embedded userinfo from URL-shaped config fields
  // so /api/config and /api/config/export responses never echo the cleartext
  // `mqtt://user:pass@broker` or `https://user:token@monitoring.example/push`
  // straight back to a LAN client.
  if (copy?.mqtt && typeof copy.mqtt.brokerUrl === 'string') {
    copy.mqtt.brokerUrl = redactUrlCreds(copy.mqtt.brokerUrl);
  }
  if (copy?.monitoring && typeof copy.monitoring.pushUrl === 'string') {
    copy.monitoring.pushUrl = redactUrlCreds(copy.monitoring.pushUrl);
  }
  // T-0131 weather broker URL (Review 2026-06-10 B4): same embedded-credential
  // shape as mqtt.brokerUrl (`mqtt://user:pass@host`).
  const weatherMqtt = copy?.forecast?.weather?.mqtt;
  if (weatherMqtt && typeof weatherMqtt.brokerUrl === 'string') {
    weatherMqtt.brokerUrl = redactUrlCreds(weatherMqtt.brokerUrl);
  }
  // Phase 24-05 (§5): the meter HTTP source URL can carry `user:pass@host`
  // credentials; strip only the userinfo so host/path survive (same shape as
  // mqtt.brokerUrl above). redactUrlCreds is a no-op on a credential-free host.
  if (copy?.meterSource?.http && typeof copy.meterSource.http.url === 'string') {
    copy.meterSource.http.url = redactUrlCreds(copy.meterSource.http.url);
  }
  // Phase 24-05 (§5): modbus host is normally a bare IP (no-op), but defend
  // against an `@`-bearing value leaking embedded creds (RESEARCH A2). A modbus
  // host is never a `scheme://` URL, so `redactUrlCreds` (which parses
  // `user:pass@host` as scheme `user:` + path and would leak the userinfo) is
  // the wrong tool here — use the schemeless `userinfo@host` strip instead.
  if (copy?.meterSource?.modbus && typeof copy.meterSource.modbus.host === 'string') {
    copy.meterSource.modbus.host = redactHostCreds(copy.meterSource.modbus.host);
  }
  return copy;
}

// Plan 08-03 Task 2: a brokerUrl/pushUrl that still carries the `***:***@`
// userinfo marker means the UI echoed back a redacted copy — restore the
// original so we don't overwrite live credentials with masked tokens.
function looksUrlRedacted(raw) {
  if (typeof raw !== 'string') return false;
  // Phase 24-05 (§5): a leading `***@` is the schemeless redactHostCreds marker
  // (e.g. modbus `***@192.168.1.7`) — a real host never starts with it.
  return raw.includes('***:***@') || raw.includes('***@redacted')
    || raw.includes('://***@') || raw.startsWith('***@');
}

export function restoreRedacted(incoming, current) {
  const copy = JSON.parse(JSON.stringify(incoming));
  // Welche Geheimnisse kamen unverändert („***“)? Vor dem Zurückholen merken.
  const keptSecrets = SECRET_TARGET_PATHS.filter((sp) => getPath(copy, sp) === REDACTED);
  for (const dotPath of REDACTED_PATHS) {
    const parts = dotPath.split('.');
    let target = copy;
    let source = current;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target?.[parts[i]];
      source = source?.[parts[i]];
    }
    const key = parts[parts.length - 1];
    if (target && typeof target === 'object' && target[key] === REDACTED) {
      // Der Platzhalter darf nie als Wert gespeichert werden: gibt es keinen
      // echten Wert zum Zurückholen (z. B. beim Einspielen einer exportierten
      // Config auf ein frisches Gerät), bleibt das Feld leer.
      const original = source && typeof source === 'object' && key in source ? source[key] : '';
      target[key] = original === REDACTED ? '' : original;
    }
  }
  // URL-level restoration for fields redacted via redactUrlCreds (Plan 08-03).
  if (copy?.mqtt && typeof copy.mqtt.brokerUrl === 'string' && looksUrlRedacted(copy.mqtt.brokerUrl)
      && current?.mqtt && typeof current.mqtt.brokerUrl === 'string') {
    copy.mqtt.brokerUrl = current.mqtt.brokerUrl;
  }
  if (copy?.monitoring && typeof copy.monitoring.pushUrl === 'string' && looksUrlRedacted(copy.monitoring.pushUrl)
      && current?.monitoring && typeof current.monitoring.pushUrl === 'string') {
    copy.monitoring.pushUrl = current.monitoring.pushUrl;
  }
  // T-0131 weather broker URL restore (Review 2026-06-10 B4) — mirror of the
  // redactConfig() URL-level redaction above.
  const wmIn = copy?.forecast?.weather?.mqtt;
  const wmCur = current?.forecast?.weather?.mqtt;
  if (wmIn && typeof wmIn.brokerUrl === 'string' && looksUrlRedacted(wmIn.brokerUrl)
      && wmCur && typeof wmCur.brokerUrl === 'string') {
    wmIn.brokerUrl = wmCur.brokerUrl;
  }
  // Phase 24-05 (§5): mirror the meterSource URL-cred redaction so a GUI-Save
  // (POST /api/config REPLACES verbatim) never writes the masked URL back.
  if (copy?.meterSource?.http && typeof copy.meterSource.http.url === 'string'
      && looksUrlRedacted(copy.meterSource.http.url)
      && current?.meterSource?.http && typeof current.meterSource.http.url === 'string') {
    copy.meterSource.http.url = current.meterSource.http.url;
  }
  if (copy?.meterSource?.modbus && typeof copy.meterSource.modbus.host === 'string'
      && looksUrlRedacted(copy.meterSource.modbus.host)
      && current?.meterSource?.modbus && typeof current.meterSource.modbus.host === 'string') {
    copy.meterSource.modbus.host = current.meterSource.modbus.host;
  }
  // Geheimnisse an ihre Adressen binden (SECRET_TARGETS) — nach dem
  // Zurückholen redigierter URLs, damit eine unverändert maskierte URL zählt.
  dropSecretsForChangedTargets(copy, current, keptSecrets);
  // EOS-Fernbetrieb: für welche Adresse das Token ausgegeben wurde, weiß nur
  // die Box (eos-remote.js) — ein Entwurf setzt das nicht.
  if (copy?.optimizer?.eosProxy?.remote && typeof copy.optimizer.eosProxy.remote === 'object') {
    const curTe = current?.optimizer?.eosProxy?.remote?.tokenEndpoint;
    if (curTe === undefined) delete copy.optimizer.eosProxy.remote.tokenEndpoint;
    else copy.optimizer.eosProxy.remote.tokenEndpoint = curTe;
  }
  return copy;
}
