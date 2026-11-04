// services/support-tunnel-policy.js — was der Fern-Support über den
// Support-Tunnel darf und wie seine Änderungen protokolliert werden.
//
// Christin, 03./04.11.2026: Der Support-Tunnel ist der Reparaturzugang bei
// Kunden und muss alles können, was zur Reparatur nötig ist — VPN, API-Token,
// Kopplungen, Sicherheits- und Broker-Einstellungen, Updates, Neustart. Die
// Sperren der Gesamtprüfung 1.0.9 hatten in der Vergangenheit genau dort zu
// Problemen geführt. Gesperrt bleibt nur, was eine Einwilligung des Kunden
// ist; Ausschalten bleibt auch dafür erlaubt. Als Ausgleich steht jede
// schreibende Aktion über den Tunnel im Protokoll, und der Kunde sieht
// Token-, Kopplungs- und Sicherheitsänderungen (Liste + Benachrichtigung).

/**
 * Einwilligungen, die über den Tunnel nicht ERTEILT werden können.
 * Freigeben = Eintrag hier entfernen; das gilt dann für die Routen
 * (`actions`), für Speichern/Import der Konfiguration (`configRoots`) und
 * für Dateien eines Geräte-Tauschs (`migrationFiles`, Pfad oder Ordner/).
 */
export const SUPPORT_TUNNEL_CONSENTS = Object.freeze({
  // Datenspende verknüpfen, einschalten, Nachlieferung starten.
  datenspende: Object.freeze({
    actions: Object.freeze(['datenspende_link', 'datenspende_settings', 'datenspende_backfill']),
    configRoots: Object.freeze(['datenspende']),
    migrationFiles: Object.freeze(['data/datenspende.json']),
  }),
  // Ortsnetz-Auslastung einschalten (Standort und Messwerte gehen hinaus).
  ortsnetz: Object.freeze({
    actions: Object.freeze(['ortsnetz_settings']),
    configRoots: Object.freeze(['ortsnetz']),
  }),
  // Einwilligung in den Fernzugang selbst: der Tunnel öffnet oder verlängert
  // sich nicht selbst, und Portal-Zugang, „Installateur darf Tunnel öffnen“,
  // Portal-Updates, Support-Login und Tunnel-Laufzeit schaltet der Kunde ein.
  fernzugang: Object.freeze({
    actions: Object.freeze(['support_tunnel_open', 'installer_portal_grant']),
    configRoots: Object.freeze(['support', 'installerPortal']),
    migrationFiles: Object.freeze(['data/support/']),
  }),
});

/** Die eine Stelle zum Freigeben: Namen aus SUPPORT_TUNNEL_CONSENTS. */
export const SUPPORT_TUNNEL_BLOCKED_CONSENTS = Object.freeze(['datenspende', 'ortsnetz', 'fernzugang']);

const blocked = () => SUPPORT_TUNNEL_BLOCKED_CONSENTS.map((name) => SUPPORT_TUNNEL_CONSENTS[name]).filter(Boolean);

/** Ist `action` eine (noch gesperrte) Einwilligung? */
export function isSupportTunnelConsentAction(action) {
  return blocked().some((c) => c.actions.includes(action));
}

/** Konfigurations-Wurzeln, die über den Tunnel bleiben, wie die Box sie hat. */
export function supportTunnelKeptConfigRoots() {
  return [...new Set(blocked().flatMap((c) => c.configRoots))];
}

/** Gehört diese Datei eines Geräte-Tauschs zu einer gesperrten Einwilligung? */
export function isSupportTunnelKeptMigrationFile(rel) {
  const r = String(rel || '');
  return blocked().some((c) => (c.migrationFiles || []).some((f) => (f.endsWith('/') ? r.startsWith(f) : r === f)));
}

// ── Protokoll ──────────────────────────────────────────────────────────────

// Schreibende Aufrufe, die nichts ändern (Fehlerberichte der Seite).
const NOT_A_CHANGE = new Set(['/api/log']);

/** Soll dieser Aufruf über den Tunnel ins Protokoll? */
export function isSupportTunnelWrite(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  const p = String(pathname || '');
  return (p.startsWith('/api/') || p === '/eosdash' || p.startsWith('/eosdash/')) && !NOT_A_CHANGE.has(p);
}

const MAX_KEYS = 40;
const MAX_KEY_LEN = 64;

/**
 * Nur die Namen der Felder (oberste Ebene; ein Objekt oder schon die
 * Namensliste aus server-utils.js parseBody), nie Werte. Lange oder viele
 * Namen werden gekürzt, damit niemand das Protokoll damit füllt.
 */
export function bodyKeyNames(bodyOrKeys) {
  let keys;
  if (Array.isArray(bodyOrKeys)) keys = bodyOrKeys;
  else if (bodyOrKeys && typeof bodyOrKeys === 'object') keys = Object.keys(bodyOrKeys);
  else return [];
  return keys.slice(0, MAX_KEYS).map((k) => String(k).slice(0, MAX_KEY_LEN));
}

// Was der Kunde zusätzlich sieht (Liste + Benachrichtigung).
const TOKEN_ROUTES = new Set(['/api/admin/token/rotate', '/api/admin/token/revoke', '/api/setup/complete', '/api/input/push-key']);
const PAIRING_PREFIXES = ['/api/mobile-link/pair/', '/api/mobile-link/devices/update', '/api/eebus/trust', '/api/eebus/pairing',
  '/api/installer/client/pair', '/api/installer/confirm'];
const PAIRING_ROUTES = new Set(['/api/mobile-link/settings']);
const SECURITY_PREFIXES = ['/api/vpn/'];
const SECURITY_ROUTES = new Set(['/api/config/export']);
const SECURITY_CONFIG_PREFIXES = ['security', 'allowedHosts', 'corsAllowedOrigins', 'trustProxy', 'trustedProxyIps',
  'vpn', 'eebus.trusted', 'mqtt.brokerUrl', 'victron.mqtt.broker', 'victron.mqttCrossCheck.broker', 'forecast.weather.mqtt.brokerUrl'];
const PAIRING_CONFIG_PREFIXES = ['mobileLink', 'eebus.trusted'];

const startsWithPath = (p, prefix) => p === prefix || p.startsWith(`${prefix}.`);

/**
 * Art der Änderung für die Kunden-Anzeige: 'token' | 'kopplung' | 'sicherheit'
 * oder null (übrige Einstellungen — nur im Protokoll).
 */
export function supportTunnelActionKind(pathname, { changedPaths = [], migrate = false } = {}) {
  const p = String(pathname || '');
  const paths = Array.isArray(changedPaths) ? changedPaths.filter((x) => typeof x === 'string') : [];
  if (TOKEN_ROUTES.has(p) || paths.some((x) => startsWithPath(x, 'apiToken'))) return 'token';
  if (PAIRING_ROUTES.has(p) || PAIRING_PREFIXES.some((x) => p.startsWith(x))) return 'kopplung';
  if (migrate) return 'sicherheit';
  if (SECURITY_ROUTES.has(p) || SECURITY_PREFIXES.some((x) => p.startsWith(x))) return 'sicherheit';
  if (paths.some((x) => SECURITY_CONFIG_PREFIXES.some((s) => startsWithPath(x, s)))) return 'sicherheit';
  if (paths.some((x) => PAIRING_CONFIG_PREFIXES.some((s) => startsWithPath(x, s)))) return 'kopplung';
  return null;
}

export const SUPPORT_TUNNEL_KIND_LABELS = Object.freeze({
  token: 'API-Token oder Zugangsschlüssel',
  kopplung: 'Kopplung',
  sicherheit: 'Sicherheitseinstellung',
});
