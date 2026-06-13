import fs from 'node:fs';
import path from 'node:path';
import { toFiniteNumber } from './util.js';

// Plan 09-01 (D-03): canonical minimum apiToken length floor. Re-exported here
// (also defined in routes-api.js) so the settings-UI field descriptor and the
// server-side validator agree on a single numeric pin. Acceptance test in
// dvhub/test/token-lifecycle.test.js checks `MIN_API_TOKEN_LENGTH === 32`.
export const MIN_API_TOKEN_LENGTH = 32;

const BERLIN_TIME_ZONE = 'Europe/Berlin';
const MANUFACTURER_MANAGED_PATHS = [
  'meter',
  'points',
  'controlWrite',
  'dvControl',
  'victron.transport',
  'victron.port',
  'victron.unitId',
  'victron.timeoutMs',
  'victron.mqtt'
];
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

const SETTINGS_DESTINATIONS = [
  {
    id: 'quickstart',
    label: 'Schnellstart',
    description: 'Die wichtigsten Grundwerte und Einstiege für die Einrichtung.',
    intro: 'Beginne hier mit den Kernwerten für Zugriff, Erreichbarkeit und sicheren Start.'
  },
  {
    id: 'connection',
    label: 'Anlage verbinden',
    description: 'Herstellerprofil und Anlagenadresse für die Verbindung.',
    intro: 'Hier legst du fest, welches Herstellerprofil aktiv ist und unter welcher Adresse die Anlage erreichbar ist.'
  },
  {
    id: 'control',
    label: 'Steuerung',
    description: 'Zeitplan-Basis und globale Steuerwerte für DVhub.',
    intro: 'Diese Einstellungen steuern Zeitplan, Defaults und DVhub-eigene Regelungslogik.'
  },
  {
    id: 'services',
    label: 'Preise & Daten',
    description: 'Optionale Preis- und Datendienste für Marktwerte und Verlauf.',
    intro: 'Verbinde hier Preisquellen, Historie und Datendienste, wenn du sie wirklich brauchst.'
  },
  {
    id: 'advanced',
    label: 'Erweitert',
    description: 'Technische Diagnose und Spezialwerkzeuge.',
    intro: 'Hier liegen nur noch technische Diagnose- und Servicewerkzeuge. Hersteller-Register werden bewusst nicht im Alltags-UI gepflegt.'
  }
];

const SECTIONS = [
  {
    id: 'system',
    label: 'System',
    description: 'Allgemeine Laufzeit- und Webserver-Einstellungen.',
    destination: 'quickstart'
  },
  {
    id: 'victron',
    label: 'Anlagenprofil',
    description: 'Aktiver Hersteller und die Anlagenadresse.',
    destination: 'connection'
  },
  {
    id: 'schedule',
    label: 'Zeitplan',
    description: 'Globale Parameter für Zeitplan und Default-Werte. Die Regeln selbst bleiben im Dashboard editierbar.',
    destination: 'control'
  },
  {
    id: 'scan',
    label: 'Scan Tool',
    description: 'Voreinstellungen für den Modbus-Scanner.',
    destination: 'advanced'
  },
  {
    id: 'telemetry',
    label: 'Telemetrie & Historie',
    description: 'Interne Datenbank für Live-Historie, Rollups und Backfill.',
    destination: 'services'
  },
  {
    id: 'pricing',
    label: 'Eigene Strompreise',
    description: 'Persönliche Bezugs- und interne Kosten für den Marktvergleich.',
    destination: 'services'
  },
  {
    id: 'epex',
    label: 'EPEX',
    description: 'Börsenpreis-Abruf für Day-Ahead-Preise.',
    destination: 'services'
  },
  {
    id: 'forecast',
    label: 'Vorhersage & PV',
    description: 'PV-Anlage, Standort, Solcast/pvnode API-Keys und Wetter-Provider.',
    destination: 'services'
  },
  {
    id: 'ml',
    label: 'ML & Forecast-Korrektur',
    description: 'ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
    destination: 'services'
  }
];

const SETUP_WIZARD_STEPS = [
  {
    id: 'basics',
    index: 0,
    label: 'Schritt 1',
    title: 'Webserver & Sicherheit',
    description: 'Lege die Basis für Zugriff und Erstkontakt fest, damit DVhub nach dem Speichern erreichbar bleibt.'
  },
  {
    id: 'transport',
    index: 1,
    label: 'Schritt 2',
    title: 'Anlage',
    description: 'Wähle das aktive Herstellerprofil und trage die Adresse deiner Anlage ein.'
  },
  {
    id: 'dv',
    index: 2,
    label: 'Schritt 3',
    title: 'DV & Meter',
    description: 'Richte Proxy-Port, Meterblock und die Vorzeichenlogik für Netzwerte ein.'
  },
  {
    id: 'services',
    index: 3,
    label: 'Schritt 4',
    title: 'Preise & Zusatzdienste',
    description: 'Erfasse Zeitzone und optional nur die Dienste, die du direkt zum Start brauchst.'
  }
];

const SETUP_WIZARD_FIELD_META = {
  httpPort: {
    stepId: 'basics',
    order: 10,
    help: 'Unter diesem Port oeffnest du später die DVhub-Oberfläche im Browser.'
  },
  apiToken: {
    stepId: 'basics',
    order: 20,
    help: 'Optional. Schuetzt die API direkt ab dem ersten Start, wenn du extern auf DVhub zugreifst.'
  },
  manufacturer: {
    stepId: 'transport',
    order: 10,
    help: 'Aktuell ist Victron vorbereitet. Weitere Hersteller koennen spaeter ergänzt werden.'
  },
  'victron.host': {
    stepId: 'transport',
    order: 20,
    help: 'IP-Adresse oder Hostname der Anlage. Technische Register- und Kommunikationswerte kommen aus dem Herstellerprofil.'
  },
  pvCoupling: {
    stepId: 'transport',
    order: 30,
    help: 'W\u00e4hle wie deine PV-Anlage am Victron-System angeschlossen ist.'
  },
  modbusListenHost: {
    stepId: 'dv',
    order: 10,
    help: 'Interface, auf dem DVhub den lokalen Modbus-Proxy anbietet.'
  },
  modbusListenPort: {
    stepId: 'dv',
    order: 20,
    help: 'Auf diesen Port verbindet sich später der Direktvermarkter oder das Zielsystem.'
  },
  gridPositiveMeans: {
    stepId: 'dv',
    order: 30,
    help: 'Hier legst du fest, ob positive Netzwerte Einspeisung oder Netzbezug bedeuten.'
  },
  'schedule.timezone': {
    stepId: 'services',
    order: 10,
    help: 'Diese Zeitzone steuert Schedule-Auswertung und dient auch als EPEX-Standard.'
  },
  'epex.enabled': {
    stepId: 'services',
    order: 20,
    help: 'Nur aktivieren, wenn du Day-Ahead-Preise direkt in DVhub nutzen willst.'
  },
  'epex.bzn': {
    stepId: 'services',
    order: 30,
    visibleWhenPath: { path: 'epex.enabled', equals: true },
    help: 'Handelszone für EPEX, zum Beispiel DE-LU.'
  },
};

const restartSensitivePrefixes = [
  'httpPort',
  'modbusListenHost',
  'modbusListenPort',
  'meterPollMs',
  'telemetry.enabled',
  'telemetry.database.host',
  'telemetry.database.port',
  'telemetry.database.name',
  'telemetry.historyImport.enabled',
  'telemetry.historyImport.provider',
  'schedule.evaluateMs',
  'manufacturer',
  'victron.host',
  'pvCoupling'
];

function addSetupWizardMetadata(fields) {
  return fields.map((field) => {
    if (!field.path) return field;
    const setup = SETUP_WIZARD_FIELD_META[field.path];
    if (!setup) return field;
    return {
      ...field,
      setup: clone(setup)
    };
  });
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) return clone(override);
  if (!isPlainObject(override)) return clone(base);
  const out = { ...clone(base) };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) out[key] = clone(value);
    else if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = clone(value);
  }
  return out;
}

function getPathParts(path) {
  const parts = String(path).split('.').filter(Boolean);
  if (parts.some((p) => FORBIDDEN_PATH_SEGMENTS.has(p))) {
    throw new Error(`unsafe config path: ${path}`);
  }
  return parts;
}

function hasPath(obj, path) {
  let cur = obj;
  for (const part of getPathParts(path)) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return false;
    if (!(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

function getPath(obj, path, fallback = undefined) {
  let cur = obj;
  for (const part of getPathParts(path)) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return fallback;
    if (!(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = getPathParts(path);
  if (!parts.length) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!Object.prototype.hasOwnProperty.call(cur, part) || !isPlainObject(cur[part])) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, path) {
  const parts = getPathParts(path);
  if (!parts.length) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!Object.prototype.hasOwnProperty.call(cur, part) || !isPlainObject(cur[part])) return;
    cur = cur[part];
  }
  delete cur[parts[parts.length - 1]];
}

function stripManufacturerManagedFields(raw, warnings) {
  for (const managedPath of MANUFACTURER_MANAGED_PATHS) {
    if (!hasPath(raw, managedPath)) continue;
    deletePath(raw, managedPath);
    warnings.push(`${managedPath}: managed by manufacturer profile and ignored in config.json`);
  }
}

function resolveManufacturerProfilePath(configPath, manufacturer) {
  return path.join(path.dirname(configPath), 'hersteller', `${manufacturer}.json`);
}

function loadManufacturerProfile(profilePath) {
  const text = fs.readFileSync(profilePath, 'utf8');
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!isPlainObject(parsed)) {
    throw new Error('manufacturer profile root must be an object');
  }
  return parsed;
}

function applyManufacturerProfile(persistedConfig, manufacturerProfile) {
  const effectiveConfig = clone(persistedConfig);
  const persistedVictron = isPlainObject(persistedConfig?.victron) ? persistedConfig.victron : {};
  const profileVictron = isPlainObject(manufacturerProfile?.victron) ? manufacturerProfile.victron : {};

  effectiveConfig.victron = deepMerge(profileVictron, { host: persistedVictron.host ?? '' });

  if (isPlainObject(manufacturerProfile?.meter)) effectiveConfig.meter = clone(manufacturerProfile.meter);
  if (isPlainObject(manufacturerProfile?.points)) effectiveConfig.points = clone(manufacturerProfile.points);
  if (isPlainObject(manufacturerProfile?.controlWrite)) effectiveConfig.controlWrite = clone(manufacturerProfile.controlWrite);
  if (isPlainObject(manufacturerProfile?.dvControl)) effectiveConfig.dvControl = clone(manufacturerProfile.dvControl);

  return applyVictronDefaults(effectiveConfig);
}

function buildFieldDefinitions() {
  const fields = [
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'httpPort',
      label: 'HTTP Port',
      type: 'number',
      min: 1,
      max: 65535,
      help: 'Port der Weboberflaeche.'
    },
    {
      section: 'system',
      group: 'security',
      groupLabel: 'Sicherheit / LAN-Vertrauen',
      groupDescription: 'Legt fest, wie viel ein Geraet im lokalen Netz ohne API-Token darf. Feinere Listen (erlaubte Netze/IPs, Endpunkt-Gruppen) liegen in security.lanCidrs / security.trustedClientIps / security.lanSafeGroups.',
      path: 'security.lanTrust',
      label: 'LAN-Vertrauensstufe',
      type: 'select',
      default: 'open',
      options: [
        { value: 'open', label: 'Offen — jedes LAN-Geraet ohne Token (Standard)' },
        { value: 'restricted', label: 'Eingeschraenkt — LAN nur fuer freigegebene Bereiche, Rest braucht Token' },
        { value: 'strict', label: 'Strikt — nur 127.0.0.1, alles andere braucht Token' }
      ],
      help: 'Offen = bisheriges Verhalten (jedes Geraet im Heimnetz darf ohne Token). Eingeschraenkt = nur lesende Dashboard-/Historie-/Prognose-Bereiche sind im LAN tokenfrei, Konfig-/Steuer-/Admin-Schreibzugriffe und die EOSdash-Konfig verlangen ein Bearer-Token. Strikt = ausser dem Geraet selbst (127.0.0.1) braucht jeder Aufruf ein Token. Bei Eingeschraenkt/Strikt: API-Token unter Verbindung setzen, sonst sperrst du dich aus.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'apiToken',
      label: 'API Token',
      type: 'text',
      // Plan 09-01 (D-03): hint to the settings UI that a non-empty token
      // must be at least MIN_API_TOKEN_LENGTH chars. The optional-empty
      // contract (D-05) is preserved by `empty: 'blank'` — empty stays valid.
      // The Shannon-entropy floor (≥ 3.5 bits/char) is enforced server-side
      // in routes-api.js validateApiTokenStrength.
      minLength: 32,
      empty: 'blank',
      help: 'External-access bearer token. OPTIONAL — empty string means no external auth (LAN bypass continues to gate local traffic). When SET, must be >=32 chars with Shannon entropy >=3.5 bits/char (validated server-side in routes-api.js validateApiTokenStrength).'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      // Plan 09-01 (D-01): optional session TTL knob. Default null = no
      // automatic expiry (LAN-trust appliance model). Reserved for a later
      // user/account phase; not consumed by Phase 9 code.
      path: 'apiTokenSessionTtlMs',
      label: 'API Token Session TTL (ms)',
      type: 'number',
      min: 0,
      empty: 'blank',
      help: 'OPTIONAL: token session TTL in milliseconds. Default null = no automatic expiry. Reserved for a future user/account phase; not yet enforced.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'modbusListenHost',
      label: 'Modbus Listen Host',
      type: 'text',
      help: 'IP oder Interface für den Modbus-Server.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'modbusListenPort',
      label: 'Modbus Listen Port',
      type: 'number',
      min: 1,
      max: 65535,
      help: 'Port, auf dem DVhub als Modbus-Proxy lauscht.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'offLeaseMs',
      label: 'OFF Lease (ms)',
      type: 'number',
      min: 1000,
      max: 86400000,
      step: 1000,
      help: 'Wie lange ein OFF-Signal wirksam bleibt.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'meterPollMs',
      label: 'Poll Intervall (ms)',
      type: 'number',
      min: 500,
      max: 60000,
      step: 100,
      help: 'Abstand zwischen den Live-Abfragen an das GX. 1000ms = 1s.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'keepalivePulseSec',
      label: 'Keepalive Puls (Sekunden)',
      type: 'number',
      min: 5,
      max: 3600,
      help: 'Intervall für den Uptime-/Heartbeat-Endpunkt.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'gridPositiveMeans',
      label: 'Bedeutung positiver Netzwerte',
      type: 'select',
      options: [
        { value: 'feed_in', label: 'Positiv bedeutet Einspeisung' },
        { value: 'grid_import', label: 'Positiv bedeutet Netzbezug' }
      ],
      help: 'Legt fest, wie eingehende Meterwerte interpretiert werden.'
    },
    {
      section: 'system',
      group: 'monitoring',
      groupLabel: 'Remote-Überwachung',
      groupDescription: 'Externer Heartbeat für Uptime-Monitoring (z.B. Uptime Kuma, Healthchecks.io).',
      path: 'monitoring.pushUrl',
      label: 'Push-URL für Heartbeat',
      type: 'text',
      placeholder: 'https://uptime.example.com/api/push/TOKEN?status=up&msg=OK&ping=',
      help: 'DVhub sendet alle 4 Minuten einen Heartbeat an diese URL. Leer lassen um den Heartbeat zu deaktivieren. Kompatibel mit Uptime Kuma (Push-Monitor), Healthchecks.io und ähnlichen Diensten.'
    },
    {
      section: 'system',
      group: 'monitoring',
      groupLabel: 'Remote-Überwachung',
      groupDescription: 'Externer Heartbeat für Uptime-Monitoring (z.B. Uptime Kuma, Healthchecks.io).',
      path: 'monitoring.pushIntervalSec',
      label: 'Heartbeat-Intervall (Sekunden)',
      type: 'number',
      min: 30,
      max: 600,
      help: 'Wie oft der Heartbeat gesendet wird (Standard: 240 Sekunden = 4 Minuten).'
    },

    {
      section: 'system',
      group: 'dcExportMode',
      groupLabel: 'PV-Export-Modus (Ladeverhinderung)',
      groupDescription: 'Verhindert Akkuladung durch dynamischen Grid Setpoint der die gesamte PV-Leistung (DC + AC) ins Netz einspeist.',
      path: 'dcExportMode.enabled',
      label: 'PV-Export-Modus aktivieren',
      type: 'boolean',
      help: 'Wenn aktiv, wird der Grid Setpoint dynamisch auf -(Gesamt-PV-Leistung) gesetzt, sodass der Multi/Quattro die komplette PV-Produktion (DC + AC) ins Netz einspeist. Netto-Batteriestrom bleibt bei ca. 0A. Bei negativen B\u00f6rsenpreisen wird der Export automatisch pausiert.'
    },
    {
      section: 'system',
      group: 'dcExportMode',
      groupLabel: 'PV-Export-Modus (Ladeverhinderung)',
      groupDescription: 'Verhindert Akkuladung durch dynamischen Grid Setpoint der die gesamte PV-Leistung (DC + AC) ins Netz einspeist.',
      path: 'dcExportMode.bufferW',
      label: 'Puffer (W)',
      type: 'number',
      min: 0,
      max: 1000,
      help: 'Kleiner Sicherheitspuffer in Watt (Standard: 100W). Verhindert kurzzeitiges Pendeln zwischen Laden/Entladen bei schwankender PV-Leistung.'
    },
    {
      section: 'system',
      group: 'dcExportMode',
      groupLabel: 'PV-Export-Modus (Ladeverhinderung)',
      groupDescription: 'Verhindert Akkuladung durch dynamischen Grid Setpoint der die gesamte PV-Leistung (DC + AC) ins Netz einspeist.',
      path: 'dcExportMode.subtractHouseLoad',
      label: 'Hausverbrauch abziehen',
      type: 'boolean',
      help: 'EIN (Standard): speist nur den echten Überschuss ein (PV − live Hausverbrauch − Puffer), der Akku-Nettostrom bleibt ~0 A. AUS: speist die gesamte PV ein (PV − Puffer), der Hausverbrauch kommt dann aus Akku/Netz. Live-Hausverbrauch = Victron Ac/Consumption.'
    },
    {
      section: 'system',
      group: 'dcExportMode',
      groupLabel: 'PV-Export-Modus (Ladeverhinderung)',
      groupDescription: 'Verhindert Akkuladung durch dynamischen Grid Setpoint der die gesamte PV-Leistung (DC + AC) ins Netz einspeist.',
      path: 'dcExportMode.priceThresholdCtKwh',
      label: 'Preisschwelle (ct/kWh)',
      type: 'number',
      min: -20,
      max: 50,
      help: 'Wenn der aktuelle B\u00f6rsenpreis \u00fcber diesem Wert liegt, wird PV eingespeist statt geladen. Unter dem Schwellwert wird normal geladen (g\u00fcnstige Stunden nutzen). Leer lassen f\u00fcr rein manuellen/zeitgesteuerten Betrieb.'
    },
    {
      section: 'system',
      group: 'dcExportMode',
      groupLabel: 'PV-Export-Modus (Ladeverhinderung)',
      groupDescription: 'Verhindert Akkuladung durch dynamischen Grid Setpoint der die gesamte PV-Leistung (DC + AC) ins Netz einspeist.',
      path: 'dcExportMode.targetSocPct',
      label: 'Ziel-SOC f\u00fcr Abend (%)',
      type: 'number',
      min: 20,
      max: 100,
      help: 'Der Akku muss diesen SOC bis zur Deadline erreicht haben. Wird der Wert nicht erreicht, wird der PV-Export 2 Stunden vor der Deadline automatisch deaktiviert um den Akku noch laden zu lassen. Standard: 90%.'
    },
    {
      section: 'system',
      group: 'dcExportMode',
      groupLabel: 'PV-Export-Modus (Ladeverhinderung)',
      groupDescription: 'Verhindert Akkuladung durch dynamischen Grid Setpoint der die gesamte PV-Leistung (DC + AC) ins Netz einspeist.',
      path: 'dcExportMode.chargeDeadlineHour',
      label: 'Lade-Deadline (Uhrzeit)',
      type: 'number',
      min: 10,
      max: 22,
      help: 'Bis zu dieser Uhrzeit muss der Akku den Ziel-SOC erreicht haben (für Abend-Einspeisung). Standard: 17 Uhr.'
    },
    {
      section: 'system',
      group: 'dcExportMode',
      groupLabel: 'PV-Export-Modus (Ladeverhinderung)',
      groupDescription: 'Verhindert Akkuladung durch dynamischen Grid Setpoint der die gesamte PV-Leistung (DC + AC) ins Netz einspeist.',
      path: 'dcExportMode.chargeGuardHours',
      label: 'SOC-Guard-Fenster (Stunden)',
      type: 'number',
      min: 1,
      max: 6,
      help: 'Wie viele Stunden vor der Lade-Deadline der DC-Export abgeschaltet wird, falls der Ziel-SOC noch nicht erreicht wurde. Standard: 2 Stunden.'
    },

    // T-0113 Tier 3 — Fern-Support. Nur diese zwei Felder sind nutzer-editierbar;
    // die Relay-Ports (peer-zugeteilt) liegen bewusst NICHT in config.json,
    // sondern in /var/lib/dvhub/support/relay.json (config-replace-sicher).
    {
      section: 'system',
      group: 'support',
      groupLabel: 'Fern-Support (Remote-Zugang)',
      groupDescription: 'Optionaler, vom Kunden kontrollierter Support-Zugang. Der Zugang ist STANDARDMÄSSIG VERSCHLOSSEN — ein Tunnel zum Support öffnet sich NUR, wenn du ihn aktiv per Knopf startest, ist zeitlich begrenzt und jederzeit abbrechbar. Ohne offenen Tunnel ist die Box von außen nicht erreichbar.',
      path: 'support.localUser.enabled',
      label: 'Support-Login-User bereithalten',
      type: 'boolean',
      help: 'Legt den Login-User „dvhub-support“ (Gruppe dvhub, KEIN sudo) an und hinterlegt den öffentlichen Support-Schlüssel — als Bereitschaft für Fern-Diagnose. Das allein gibt KEINEN Zugriff: der Support kommt nur rein, solange DU den Tunnel geöffnet hast. Deaktivieren entfernt User + Schlüssel beim nächsten Neustart (kein Fern-Support mehr möglich).'
    },
    {
      section: 'system',
      group: 'support',
      groupLabel: 'Fern-Support (Remote-Zugang)',
      groupDescription: 'Optionaler, vom Kunden kontrollierter Support-Zugang.',
      path: 'support.tunnel.autoCloseMin',
      label: 'Tunnel-Auto-Schließung (Minuten)',
      type: 'select',
      options: [
        { value: 30, label: '30 Minuten' },
        { value: 60, label: '60 Minuten (Standard)' },
        { value: 120, label: '120 Minuten' }
      ],
      help: 'Spätestens nach dieser Zeit schließt sich ein geöffneter Support-Tunnel automatisch wieder. Du kannst ihn jederzeit vorher manuell beenden.'
    },

    {
      section: 'telemetry',

      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'Automatische lokale Historie für Telemetrie, Preise und Optimierer.',
      path: 'telemetry.enabled',
      label: 'Interne Historie aktiv',
      type: 'boolean',
      hidden: true,
      help: 'Schreibt Livewerte, Preise, Steuerereignisse und Optimierergebnisse lokal in eine eingebaute Datenbank.'
    },
    {
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'PostgreSQL + TimescaleDB Verbindung für Telemetrie, Preise und Optimierer.',
      path: 'telemetry.database.host',
      label: 'DB Host',
      type: 'text',
      hidden: true,
      help: 'PostgreSQL Hostname oder IP-Adresse.'
    },
    {
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'PostgreSQL + TimescaleDB Verbindung für Telemetrie, Preise und Optimierer.',
      path: 'telemetry.database.port',
      label: 'DB Port',
      type: 'number',
      hidden: true,
      min: 1,
      max: 65535,
      help: 'PostgreSQL Port (Standard: 5432).'
    },
    {
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'PostgreSQL + TimescaleDB Verbindung für Telemetrie, Preise und Optimierer.',
      path: 'telemetry.database.name',
      label: 'Datenbankname',
      type: 'text',
      hidden: true,
      help: 'Name der PostgreSQL-Datenbank (Standard: dvhub).'
    },
    {
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'PostgreSQL + TimescaleDB Verbindung für Telemetrie, Preise und Optimierer.',
      path: 'telemetry.database.user',
      label: 'DB Benutzer',
      type: 'text',
      hidden: true,
      help: 'PostgreSQL Benutzername.'
    },
    {
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'PostgreSQL + TimescaleDB Verbindung für Telemetrie, Preise und Optimierer.',
      path: 'telemetry.database.password',
      label: 'DB Passwort',
      type: 'text',
      hidden: true,
      empty: 'blank',
      help: 'PostgreSQL Passwort.'
    },
    {
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'PostgreSQL + TimescaleDB Verbindung für Telemetrie, Preise und Optimierer.',
      path: 'telemetry.rawRetentionDays',
      label: 'Raw Retention (Tage)',
      type: 'number',
      min: 1,
      max: 3650,
      help: 'Wie lange Rohdaten mit hoher Auflösung aufbewahrt werden. TimescaleDB Retention Policy.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.enabled',
      label: 'Geplantes Backup aktiv',
      type: 'boolean',
      help: 'Wenn aktiv, wird täglich zur eingestellten Uhrzeit ein pg_dump (Custom-Format, .dump) ins Zielverzeichnis geschrieben.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.scope',
      label: 'Umfang',
      type: 'select',
      options: [
        { value: 'full', label: 'Komplette Datenbank' },
        { value: 'energy15m', label: 'Nur 15-min-Energiewerte' }
      ],
      help: 'Komplette DB (alles inkl. Roh-Telemetrie) oder nur die aggregierte 15-min-Tabelle energy_slots_15m.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.time',
      label: 'Uhrzeit (täglich)',
      type: 'time',
      help: 'Lokale Uhrzeit (HH:MM), zu der das Backup täglich läuft. Standard: 03:30.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.targetType',
      label: 'Ziel-Typ',
      type: 'select',
      options: [
        { value: 'local', label: 'Lokales Verzeichnis' },
        { value: 'smb', label: 'SMB / CIFS Netzwerk-Freigabe (NAS)' }
      ],
      help: 'Lokales Verzeichnis (auch ein OS-gemounteter Share) oder direkt eine SMB/CIFS-Freigabe (NAS) — dann werden die Felder unten genutzt.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.destinationDir',
      label: 'Zielverzeichnis (lokal)',
      type: 'text',
      empty: 'blank',
      help: 'Nur bei Ziel-Typ "Lokales Verzeichnis": Pfad, in den die .dump-Dateien geschrieben werden (z. B. /mnt/nas/dvhub-backups). Muss für den dvhub-Dienst beschreibbar sein.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.smb.host',
      label: 'SMB Server (Host/IP)',
      type: 'text',
      empty: 'blank',
      help: 'Nur bei Ziel-Typ "SMB": Hostname oder IP der NAS/SMB-Freigabe (z. B. 192.168.1.10 oder nas.local).'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.smb.share',
      label: 'SMB Freigabe-Name',
      type: 'text',
      empty: 'blank',
      help: 'Name der Freigabe (Share), z. B. "backups". Ohne führende Slashes.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.smb.path',
      label: 'SMB Unterordner (optional)',
      type: 'text',
      empty: 'blank',
      help: 'Optionaler Unterordner innerhalb der Freigabe, z. B. "dvhub". Leer = Wurzel der Freigabe.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.smb.username',
      label: 'SMB Benutzer',
      type: 'text',
      empty: 'blank',
      help: 'Benutzername für die SMB-Freigabe.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.smb.password',
      label: 'SMB Passwort',
      type: 'text',
      hidden: true,
      empty: 'blank',
      help: 'Passwort für die SMB-Freigabe. Wird nur serverseitig in einer temporären 0600-Auth-Datei genutzt, nie als Prozessargument.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.smb.domain',
      label: 'SMB Domäne (optional)',
      type: 'text',
      empty: 'blank',
      help: 'Optionale Windows-Domäne / Workgroup. Meist leer lassen.'
    },
    {
      section: 'telemetry',
      group: 'dbBackup',
      groupLabel: 'Geplantes Datenbank-Backup',
      groupDescription: 'Sichert die Datenbank täglich per pg_dump in ein Zielverzeichnis (z. B. einen ins OS gemounteten Netzwerk-Share NFS/SMB) und rotiert alte Backups.',
      path: 'dbBackup.retentionCount',
      label: 'Aufbewahrung (Anzahl)',
      type: 'number',
      min: 1,
      max: 365,
      help: 'Wie viele der neuesten Backup-Dateien behalten werden. Ältere werden nach jedem Lauf gelöscht. Standard: 14.'
    },
    {
      section: 'telemetry',
      group: 'historyImport',
      groupLabel: 'History Import',
      groupDescription: 'Optionale Nachfüllung aus VRM für Historie und Datenlücken.',
      path: 'telemetry.historyImport.enabled',
      label: 'History Import aktiv',
      type: 'boolean',
      help: 'Aktiviert den optionalen VRM-Import für bestehende Historie und Gap-Fill.'
    },
    {
      section: 'telemetry',
      group: 'historyImport',
      groupLabel: 'History Import',
      groupDescription: 'Optionale Nachfüllung aus VRM für Historie und Datenlücken.',
      path: 'telemetry.historyImport.provider',
      label: 'Import Quelle',
      type: 'select',
      options: [
        { value: 'vrm', label: 'VRM' }
      ],
      help: 'Historischer Nachimport wird bewusst nur über VRM unterstützt.'
    },
    {
      section: 'telemetry',
      group: 'historyImport',
      groupLabel: 'History Import',
      groupDescription: 'Optionale Nachfüllung aus VRM für Historie und Datenlücken.',
      path: 'telemetry.historyImport.vrmPortalId',
      label: 'VRM Portal ID',
      type: 'text',
      empty: 'blank',
      help: 'Optional. Wird für späteren VRM-Historienimport genutzt.'
    },
    {
      section: 'telemetry',
      group: 'historyImport',
      groupLabel: 'History Import',
      groupDescription: 'Optionale Nachfüllung aus VRM für Historie und Datenlücken.',
      path: 'telemetry.historyImport.vrmToken',
      label: 'VRM Token',
      type: 'text',
      empty: 'blank',
      help: 'Optionaler API-Token für späteren VRM-Backfill.'
    },

    {
      section: 'victron',
      group: 'connection',
      groupLabel: 'Verbindung',
      groupDescription: 'Aktives Herstellerprofil und Anlagenadresse.',
      path: 'manufacturer',
      label: 'Hersteller',
      type: 'select',
      options: [
        { value: 'victron', label: 'Victron' }
      ],
      help: 'Aktuell ist nur Victron auswählbar. Die technischen Werte kommen aus der Herstellerdatei.'
    },
    {
      section: 'victron',
      group: 'connection',
      groupLabel: 'Verbindung',
      groupDescription: 'Aktives Herstellerprofil und Anlagenadresse.',
      path: 'victron.host',
      label: 'Anlagenadresse',
      type: 'text',
      discovery: {
        manufacturerPath: 'manufacturer',
        actionLabel: 'Find System IP'
      },
      help: 'IP-Adresse oder Hostname der Anlage. Register und weitere Kommunikationswerte kommen aus der Herstellerdatei.'
    },
    {
      section: 'victron',
      group: 'connection',
      groupLabel: 'Verbindung',
      groupDescription: 'Aktives Herstellerprofil und die Anlagenadresse.',
      path: 'pvCoupling',
      label: 'PV-Anbindung',
      type: 'select',
      options: [
        { value: 'ac_dc', label: 'AC + DC gekoppelt' },
        { value: 'dc', label: 'Nur DC (MPPT)' },
        { value: 'ac', label: 'Nur AC (Fronius, SMA, etc.)' }
      ],
      help: 'Art der PV-Anbindung. Bei reiner DC-Kopplung werden AC-PV-Register nicht abgefragt, bei reiner AC-Kopplung wird das DC-PV-Register \u00fcbersprungen.'
    },
    {
      section: 'victron',
      group: 'connection',
      groupLabel: 'Verbindung',
      groupDescription: 'Aktives Herstellerprofil und Anlagenadresse.',
      path: 'victron.telemetryMaxAgeMs',
      label: 'Telemetrie-Frische max. Alter (ms)',
      type: 'number',
      default: 90000,
      min: 15000,
      max: 600000,
      step: 1000,
      help: 'Maximales Alter eines erfolgreichen SoC-/Akku-Reads, bevor die Telemetrie als veraltet gilt. \u00c4ltere Werte unterdr\u00fccken jede erzwungene Entladung (Hold), damit ein eingefrorener Messwert nach einem Kommunikationsausfall den Akku nicht tiefentl\u00e4dt. ~3-6 Poll-Zyklen.'
    },

    {
      section: 'schedule',
      group: 'defaults',
      groupLabel: 'Zeitplan Basis',
      groupDescription: 'Globale Zeitplan-Parameter. Einzelregeln bleiben im Dashboard editierbar.',
      path: 'schedule.timezone',
      label: 'Zeitzone',
      type: 'text',
      help: 'Zum Beispiel Europe/Berlin.'
    },
    {
      section: 'schedule',
      group: 'defaults',
      groupLabel: 'Zeitplan Basis',
      groupDescription: 'Globale Zeitplan-Parameter. Einzelregeln bleiben im Dashboard editierbar.',
      path: 'schedule.evaluateMs',
      label: 'Schedule Evaluate (ms)',
      type: 'number',
      min: 1000,
      max: 600000,
      step: 1000,
      help: 'Wie oft der Zeitplan ausgewertet wird.'
    },
    {
      section: 'schedule',
      group: 'defaults',
      groupLabel: 'Zeitplan Basis',
      groupDescription: 'Globale Zeitplan-Parameter. Einzelregeln bleiben im Dashboard editierbar.',
      path: 'schedule.manualOverrideTtlMs',
      label: 'Manual Override TTL',
      type: 'number',
      default: 300000,
      help: 'Wie lange ein manueller Override gilt (ms). Persistente Overrides (persist:true) ignorieren dies.'
    },
    {
      section: 'schedule',
      group: 'defaults',
      groupLabel: 'Zeitplan Basis',
      groupDescription: 'Globale Zeitplan-Parameter. Einzelregeln bleiben im Dashboard editierbar.',
      path: 'schedule.controlKeepaliveMs',
      label: 'Grid-Setpoint Keepalive (ms)',
      type: 'number',
      default: 5000,
      min: 0,
      max: 600000,
      step: 1000,
      help: 'ESS-Grid-Setpoint periodisch neu schreiben (auch unverändert). PFLICHT fürs flüchtige Reg 2716/2717: fällt real schon nach ~10 s (Venus 3.7x) in Passthru, nicht erst nach 60 s → 5 s empfohlen (RAM, Schreiben gratis). Wert in (0, 60000]. 0 = aus (nur fürs persistente Reg 2700).'
    },
    {
      section: 'schedule',
      group: 'defaults',
      groupLabel: 'Zeitplan Basis',
      groupDescription: 'Globale Zeitplan-Parameter. Einzelregeln bleiben im Dashboard editierbar.',
      path: 'schedule.manualOverrideMinSocPct',
      label: 'Persistenter Override SoC-Floor (%)',
      type: 'number',
      default: 10,
      min: 0,
      max: 100,
      step: 1,
      help: 'Unter diesem SoC wird ein persistenter Entlade-Override (gridSetpointW < 0) unterdrückt (Hold), damit er den Akku nicht bis zum reinen Hardware-Minimum entleert.'
    },
    {
      section: 'schedule',
      group: 'defaults',
      groupLabel: 'Zeitplan Basis',
      groupDescription: 'Globale Zeitplan-Parameter. Einzelregeln bleiben im Dashboard editierbar.',
      path: 'schedule.defaultGridSetpointW',
      label: 'Default Grid Setpoint (W)',
      type: 'number',
      empty: 'null',
      help: 'Leer lassen, wenn kein Default geschrieben werden soll.'
    },
    {
      section: 'schedule',
      group: 'defaults',
      groupLabel: 'Zeitplan Basis',
      groupDescription: 'Globale Zeitplan-Parameter. Einzelregeln bleiben im Dashboard editierbar.',
      path: 'schedule.defaultChargeCurrentA',
      label: 'Default Charge Current (A)',
      type: 'number',
      empty: 'null',
      help: 'Leer lassen, wenn kein Default geschrieben werden soll.'
    },
    {
      section: 'schedule',
      group: 'defaults',
      groupLabel: 'Zeitplan Basis',
      groupDescription: 'Globale Zeitplan-Parameter. Einzelregeln bleiben im Dashboard editierbar.',
      path: 'schedule.defaultFeedExcessDcPv',
      label: 'Default DC-Einspeisung (0/1)',
      type: 'number',
      help: '1 = DC-Einspeisung erlaubt (Standard), 0 = DC-Einspeisung gesperrt. Über Zeitplan-Regeln mit target "feedExcessDcPv" steuerbar.'
    },
    // ── Optimizer (Batterie-Optimierung) ──────────────────────────���────
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Automatische Batterie-Lade-/Entladeplanung basierend auf Preisprognosen. Achtung: Netzladen und Netzentladung haben rechtliche Implikationen (EEG, §14a EnWG).',
      path: 'optimizer.enabled',
      label: 'Optimierung aktiv',
      type: 'boolean',
      help: 'Master-Schalter: Aktiviert die automatische Batterie-Optimierung. Bei Deaktivierung werden alle bestehenden Optimizer-Regeln sofort entfernt.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Automatische Batterie-Lade-/Entladeplanung basierend auf Preisprognosen.',
      path: 'optimizer.allowGridCharge',
      label: '\u26a0\ufe0f Netzladen erlaubt (Netz \u2192 Akku)',
      type: 'boolean',
      help: 'Erlaubt dem Optimizer, den Akku aus dem Stromnetz zu laden. ACHTUNG: Ohne aktive MiSpeL-Registrierung (Pauschaloption/Abgrenzung) ist Netzladen EEG-rechtlich problematisch \u2014 Vermischung Gr\u00fcnstrom/Graustrom, Risiko F\u00f6rderungsverlust.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Automatische Batterie-Lade-/Entladeplanung basierend auf Preisprognosen.',
      path: 'optimizer.allowGridDischarge',
      label: '\u26a0\ufe0f Netzentladung erlaubt (Akku \u2192 Netz)',
      type: 'boolean',
      help: 'Erlaubt dem Optimizer, den Akku ins Stromnetz zu entladen (Verkauf). ACHTUNG: Steuerliche und regulatorische Implikationen (\u00a714a EnWG, Umlagen, ggf. Direktvermarktungs-Pflichten). Nur aktivieren wenn rechtlich abgesichert.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Genauigkeit/Geschwindigkeit der EOS-Optimierung. 15 Minuten matches EPEX-Day-Ahead seit 2024 \u2014 empfohlen f\u00fcr Direktvermarktung.',
      path: 'optimizer.eosOptimizationIntervalSec',
      label: 'EOS Slot-Aufl\u00f6sung',
      type: 'select',
      options: [
        { value: 900, label: '15 Minuten (Direktvermarktung, EPEX-konform)' },
        { value: 1800, label: '30 Minuten' },
        { value: 3600, label: '1 Stunde (Standard, schnellste Optimierung)' }
      ],
      help: 'Slot-Aufl\u00f6sung f\u00fcr den EOS-Genetic-Algorithmus. 15min liefert die feinste Granularit\u00e4t f\u00fcr Spot-Arbitrage, ben\u00f6tigt aber 4\u00d7 mehr Rechenzeit. F\u00fcr DV \u00fcblicherweise 900s.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Genauigkeit/Geschwindigkeit der EOS-Optimierung. 15 Minuten matches EPEX-Day-Ahead seit 2024 \u2014 empfohlen f\u00fcr Direktvermarktung.',
      path: 'optimizer.eosEmsIntervalSec',
      label: 'EOS Re-Planungs-Intervall',
      type: 'select',
      options: [
        { value: 0, label: 'Automatisch (an Slot-Aufl\u00f6sung gekoppelt)' },
        { value: 900, label: '15 Minuten' },
        { value: 1800, label: '30 Minuten' },
        { value: 3600, label: '1 Stunde' }
      ],
      help: 'Wie oft EOS einen frischen Optimierungslauf startet (ems.interval), ENTKOPPELT von der Slot-Aufl\u00f6sung. \u201eAutomatisch\u201c drosselt 15-min-Slots auf st\u00fcndlich. Ein Lauf dauert ~6 min; 30 Minuten gibt auch langsamer Hardware (z.B. Raspberry-Pi-EOS-Host) Puffer. Muss > Laufdauer sein, sonst stomp.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Einspeiseverg\u00fctung: Bestimmt wie der Optimizer den Verkaufserl\u00f6s bewertet.',
      path: 'optimizer.tariff.feedInMode',
      label: 'Einspeise-Modus',
      type: 'select',
      options: [
        { value: 'spot', label: 'Spot (Direktvermarktung) \u2014 B\u00f6rsenpreis pro Slot' },
        { value: 'fixed', label: 'Fest (EEG) \u2014 feste Einspeisverg\u00fctung' }
      ],
      help: 'Spot: Optimizer bewertet Entladung zum aktuellen B\u00f6rsenpreis (EPEX Spot). F\u00fcr Direktvermarktung. Fest: Feste Einspeisverg\u00fctung (Standard 7.78 ct/kWh). F\u00fcr EEG-Volleinspeiser ohne Direktvermarktung.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Batterie-Eckdaten f\u00fcr die automatische Optimierung.',
      path: 'optimizer.batteryCapacityWh',
      label: 'Akkukapazit\u00e4t (Wh)',
      type: 'number',
      min: 0,
      step: 100,
      help: 'Nutzbare Kapazit\u00e4t des Batteriespeichers in Wattstunden.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Batterie-Eckdaten f\u00fcr die automatische Optimierung.',
      path: 'optimizer.maxChargeW',
      label: 'Max. Ladeleistung (W)',
      type: 'number',
      min: 0,
      step: 100,
      help: 'Maximale Ladeleistung des Batteriespeichers in Watt.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Batterie-Eckdaten f\u00fcr die automatische Optimierung.',
      path: 'optimizer.maxDischargeW',
      label: 'Max. Entladeleistung (W)',
      type: 'number',
      min: 0,
      step: 100,
      help: 'Maximale Entladeleistung des Batteriespeichers in Watt. Begrenzt den negativen Grid-Setpoint den der Optimizer erzeugen darf.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Batterie-Eckdaten f\u00fcr die automatische Optimierung.',
      path: 'optimizer.minSocPct',
      label: 'Min. SOC (%)',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
      help: 'Minimaler Ladestand \u2014 der Optimizer entl\u00e4dt nie unter diesen Wert.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Batterie-Eckdaten f\u00fcr die automatische Optimierung.',
      path: 'optimizer.maxSocPct',
      label: 'Max. SOC (%)',
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
      help: 'Maximaler Ladestand \u2014 der Optimizer l\u00e4dt nie \u00fcber diesen Wert.'
    },
    {
      section: 'schedule',
      group: 'optimizer',
      groupLabel: 'Batterie-Optimierung',
      groupDescription: 'Batterie-Eckdaten f\u00fcr die automatische Optimierung.',
      path: 'optimizer.hardFloorSocPct',
      label: 'Harter SoC-Floor (%)',
      type: 'number',
      default: 5,
      min: 0,
      max: 100,
      step: 1,
      help: 'Absoluter Sicherheits-Floor: Bei oder unter diesem SoC wird JEDE erzwungene Entladung im Steuerpfad unterdr\u00fcckt (Hold), egal welche Quelle (Optimizer/Regel/Override/EOS). Sollte nicht unter dem Hardware-Minimum (Victron minSoc) liegen. Standard 5 %.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine B\u00f6rsenautomatik',
      groupDescription: 'Automatische Entladeplanung basierend auf B\u00f6rsenpreisen.',
      path: 'schedule.smallMarketAutomation.engine',
      label: 'Optimierungs-Engine',
      type: 'select',
      options: [
        { value: 'greedy', label: 'Greedy (Legacy) \u2014 schnell, lokales Optimum' },
        { value: 'milp', label: 'MILP (HiGHS) \u2014 mathematisch optimal, global' }
      ],
      help: 'Greedy platziert Bl\u00f6cke einzeln am jeweils besten Slot (schnell, aber findet nicht immer das globale Optimum). MILP nutzt den HiGHS-Solver und findet mathematisch bewiesen die beste Kombination aller Bl\u00f6cke.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.enabled',
      label: 'Kleine Börsenautomatik aktiv',
      type: 'boolean',
      help: 'Aktiviert die tägliche Regelgenerierung für freie Marktfenster.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.forecastAware',
      label: 'Forecast-aware Reserve (Beta)',
      type: 'boolean',
      help: 'Wenn aktiv: Reserve und Hoarding-Gate werden aus PV-/Last-Forecast der nächsten 24 h gerechnet. Sonniger Tag erwartet → mehr Slots; PV-Mangel → weniger oder keine Slots. Statisches Minimum-SOC bleibt Obergrenze. Aus = altes Verhalten (statische Reserve).'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.searchWindowStart',
      label: 'Suchfenster Start',
      type: 'time',
      help: 'Lokale Startzeit des Suchfensters.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.searchWindowEnd',
      label: 'Suchfenster Ende',
      type: 'time',
      help: 'Lokale Endzeit des Suchfensters.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.targetSlotCount',
      label: 'Maximale Ziel-Slots (optional)',
      type: 'number',
      min: 0,
      max: 24,
      help: 'Optionaler Maximalwert. Wird automatisch aus Batteriekapazität, Leistung und SOC berechnet wenn leer oder 0.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.maxDischargeW',
      label: 'Maximale Entladeleistung (W)',
      type: 'number',
      help: 'Harte Obergrenze für die Automatik.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.predictivePreEmpty.enabled',
      label: 'Forecast Aware++ (Stufe 2) aktivieren',
      type: 'boolean',
      help: 'Aktiviert das vorausschauende Akku-Leeren (Stufe 2). Nur wirksam, wenn die Forecast-aware Börsenautomatik (Stufe 1) ebenfalls aktiv ist. Stufe 2 verkauft aktiv und leert den physischen Akku — separat scharfschalten. Auslöser ist der Börsenpreis unter den PV-Erzeugungskosten — diese werden unter Preise → Interne Kosten → „PV-Kosten (ct/kWh)“ gepflegt.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.predictivePreEmpty.akkuHardLimitW',
      label: 'Stage 2 Akku-Hard-Limit (W)',
      type: 'number',
      min: 1000,
      max: 50000,
      help: 'Harte Obergrenze der tatsächlichen Akku-Entladeleistung im Vorab-Leeren (Stufe 2). Begrenzt die DC-seitige Akkuleistung — anders als die Maximale Entladeleistung, die nur den Netz-Export deckelt. Würde der geplante Export den Akku über diesen Wert entladen, wird der Slot auf einen akkuschonenden (DC-Discharge) Export gedrosselt. Richtwert 20000 W — gegen Akku-/Wechselrichter-Datenblatt prüfen.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.predictivePreEmpty.akkuSoftLimitW',
      label: 'Stage 2 Akku-Soft-Limit (W)',
      type: 'number',
      min: 0,
      max: 50000,
      help: 'Schwelle, ab der das vorausschauende Akku-Leeren (Stufe 2) gedrosselt wird. Bis zu dieser tatsächlichen Akku-Entladeleistung wird frei ausgespeist (auch aus dem Akku); darüber wird der Akku-Anteil schrittweise zurückgenommen, sodass die Entladeleistung das Akku-Hard-Limit nie erreicht. Richtwert: etwa 2000 W unter dem Akku-Hard-Limit.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.predictivePreEmpty.confidenceFactorLow',
      label: 'Confidence-Untergrenze (Tiefe-Faktor 0)',
      type: 'number',
      min: 0,
      max: 1,
      help: 'Forecast-Confidence, bei der der Vorab-Entladefaktor 0 ist (kein zusätzliches Leeren). Auf das reale SMA-Confidence-Band kalibrieren (~0,25).'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.predictivePreEmpty.confidenceFactorHigh',
      label: 'Confidence-Obergrenze (Tiefe-Faktor 1)',
      type: 'number',
      min: 0,
      max: 1,
      help: 'Forecast-Confidence, bei der voll auf die prognose-begründete Tiefe geleert wird. Auf das reale SMA-Confidence-Band kalibrieren (~0,30). NICHT 0,5/0,7 (das ist das Optimizer-Band).'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.predictivePreEmpty.haltenAbortDropPct',
      label: 'Halten-Abbruch-Schwelle (%)',
      type: 'number',
      min: 5,
      max: 90,
      help: 'Relativer Rückgang der prognostizierten Fenster-PV-Energie, ab dem die Halten-Phase abgebrochen wird und der Akku wieder normal laden darf (Intraday-Re-Evaluation).'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.predictivePreEmpty.maxChargeCurrentA',
      label: 'Freigabe-Drossel: Hardware-Maximum (A, DC)',
      type: 'number',
      min: 0,
      max: 1000,
      empty: 'null',
      help: 'Maximaler DC-Batterie-Ladestrom (Cerbo GX SystemSetup/MaxChargeCurrent). Die FREIGEBEN-Drossel rechnet die benötigte Restladung auf diese Obergrenze um. Default 350 A (~19 kW bei 55,2 V). Leer = nimmt schedule.config.defaultChargeCurrentA als Obergrenze.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.predictivePreEmpty.batteryVoltageV',
      label: 'Freigabe-Drossel: Batterie-Spannung (V, DC)',
      type: 'number',
      min: 12,
      max: 1000,
      help: 'DC-Batteriespannung für die A↔W-Umrechnung im FREIGEBEN-Throttle. Standard 55,2 V (48-V-LiFePO4 voll). chargeCurrentA schreibt den Cerbo-MaxChargeCurrent — das ist DC-seitig (Battery), NICHT AC-seitig.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.batteryCapacityKwh',
      label: 'Akkukapazität (kWh)',
      type: 'number',
      empty: 'null',
      help: 'Akkukapazität in kWh. Wenn gesetzt, wird die Slot-Anzahl automatisch aus der verfügbaren Energie berechnet.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.inverterEfficiencyPct',
      label: 'Wechselrichter-Effizienz (%)',
      type: 'number',
      help: 'Wechselrichter-Effizienz in Prozent (Standard: 85%). Wird für die Berechnung der Netz-Energie abgezogen.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.minSocPct',
      label: 'Automatik Minimum-SOC (%)',
      type: 'number',
      min: 0,
      max: 100,
      help: 'Standard-SOC-Untergrenze der Automatik.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.aggressivePremiumPct',
      label: 'Aggressiver Preisaufschlag (%)',
      type: 'number',
      min: 0,
      max: 500,
      help: 'Ab diesem Aufschlag darf bis zum globalen Minimum-SOC entladen werden.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.location.label',
      label: 'Standort Bezeichnung',
      type: 'text',
      help: 'Freier Name für den Anlagenstandort.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.location.latitude',
      label: 'Breitengrad',
      type: 'number',
      min: -90,
      max: 90,
      step: 0.000001,
      help: 'Breitengrad des Anlagenstandorts.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Automatische Auswahl profitabler freier Börsenfenster mit eigener SOC-Logik.',
      path: 'schedule.smallMarketAutomation.location.longitude',
      label: 'Längengrad',
      type: 'number',
      min: -180,
      max: 180,
      step: 0.000001,
      help: 'Längengrad des Anlagenstandorts.'
    },
    {
      section: 'schedule',
      group: 'smallMarketAutomation',
      groupLabel: 'Kleine Börsenautomatik',
      groupDescription: 'Optionale Ketten aus Entlade- und Cooldown-Stufen.',
      path: 'schedule.smallMarketAutomation.stages',
      label: 'Erweiterte Stufen',
      type: 'array',
      help: 'Definiert optionale Entlade- und Cooldown-Stufen für die Automatik.'
    },

    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.host',
      label: 'Scan Host',
      type: 'text',
      help: 'Host für das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.port',
      label: 'Scan Port',
      type: 'number',
      min: 1,
      max: 65535,
      help: 'Port für das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.unitId',
      label: 'Scan Unit ID',
      type: 'number',
      min: 0,
      max: 255,
      help: 'Unit ID für das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.fc',
      label: 'Scan Function Code',
      type: 'select',
      options: [
        { value: 3, label: '3 - Holding Register' },
        { value: 4, label: '4 - Input Register' }
      ],
      help: 'Function Code für das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.start',
      label: 'Startadresse',
      type: 'number',
      min: 0,
      max: 65535,
      help: 'Start des Scan-Bereichs.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.end',
      label: 'Endadresse',
      type: 'number',
      min: 0,
      max: 65535,
      help: 'Ende des Scan-Bereichs.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.step',
      label: 'Schrittweite',
      type: 'number',
      min: 1,
      max: 125,
      help: 'Abstand zwischen den Scan-Anfragen.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.quantity',
      label: 'Register pro Anfrage',
      type: 'number',
      min: 1,
      max: 125,
      help: 'Anzahl gelesener Register je Scan-Schritt.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.timeoutMs',
      label: 'Timeout (ms)',
      type: 'number',
      min: 100,
      max: 60000,
      step: 100,
      help: 'Timeout für das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen für die Diagnose-Seite.',
      path: 'scan.onlyNonZero',
      label: 'Nur nicht-null Treffer',
      type: 'boolean',
      help: 'Blendet leere Registerbereiche aus.'
    },


    {
      section: 'pricing',
      group: 'mode',
      groupLabel: 'Eigener Strompreis',
      groupDescription: 'Hinterlege deinen vollständigen Bruttopreis inklusive MwSt, Netzentgelten, Umlagen und sonstigen kWh-basierten Bestandteilen.',
      path: 'userEnergyPricing.mode',
      label: 'Preislogik',
      type: 'select',
      options: [
        { value: 'fixed', label: 'Fester Bruttopreis' },
        { value: 'dynamic', label: 'Dynamisch aus EPEX + Preisbestandteilen' }
      ],
      help: 'Fester Preis bedeutet ein kompletter Endkundenpreis. Dynamisch berechnet DVhub den Bruttopreis pro Slot aus EPEX und deinen Zuschlägen.'
    },
    {
      section: 'pricing',
      group: 'mode',
      groupLabel: 'Eigener Strompreis',
      groupDescription: 'Optional koennen mehrere gueltige Tarifzeiträume mit eigener Preislogik gepflegt werden.',
      path: 'userEnergyPricing.periods',
      label: 'Preiszeiträume',
      type: 'array',
      help: 'Wird von der erweiterten Preiseingabe genutzt, um tageweise gueltige Tarife zu speichern.'
    },
    {
      section: 'pricing',
      group: 'marketPremium',
      groupLabel: 'PV-Anlagen für Marktprämie',
      groupDescription: 'Mehrere PV-Anlagen mit Inbetriebnahme und Leistung für den gewichteten anzulegenden Wert.',
      path: 'userEnergyPricing.marketValueMode',
      label: 'Marktwert-Modus',
      type: 'select',
      options: [
        { value: 'annual', label: 'Jahresmarktwert' },
        { value: 'monthly', label: 'Monatsmarktwert' }
      ],
      help: 'Legt global fest, ob DVhub die Marktprämie mit Jahres- oder Monatsmarktwerten berechnet.'
    },
    {
      section: 'pricing',
      group: 'marketPremium',
      groupLabel: 'PV-Anlagen f\u00fcr Marktpr\u00e4mie',
      groupDescription: 'Gewichteter anzulegender Wert f\u00fcr die Marktpr\u00e4mienberechnung.',
      path: 'userEnergyPricing.applicableValueOverrideCtKwh',
      label: 'Anzulegender Wert (ct/kWh) \u2014 manuell',
      type: 'number',
      step: 0.01,
      min: 0,
      empty: 'null',
      help: 'Gewichteter anzulegender Wert in ct/kWh. Wird automatisch aus BNetzA-Daten + PV-Anlagen berechnet. Hier manuell \u00fcberschreiben wenn BNetzA-Daten fehlen oder falsch sind. Berechnung f\u00fcr 29.7 kWp (IBN 01/2026): (10\u00d77.78 + 19.7\u00d76.73) / 29.7 = 7.08 ct/kWh. Leer = automatisch.'
    },
    {
      section: 'pricing',
      group: 'marketPremium',
      groupLabel: 'PV-Anlagen f\u00fcr Marktpr\u00e4mie',
      groupDescription: 'Mehrere PV-Anlagen mit Inbetriebnahme und Leistung f\u00fcr den gewichteten anzulegenden Wert.',
      path: 'userEnergyPricing.pvPlants',
      label: 'PV-Anlagen',
      type: 'array',
      help: 'Wird von der PV-Anlagenliste genutzt, um kWp und Inbetriebnahme mehrerer Anlagen zu pflegen.'
    },
    {
      section: 'pricing',
      group: 'marketPremium',
      groupLabel: 'PV-Anlagen für Marktprämie',
      groupDescription: 'Mehrere PV-Anlagen mit Inbetriebnahme und Leistung für den gewichteten anzulegenden Wert.',
      key: 'dvCostMonthlyEur',
      label: 'DV-Kosten monatlich (EUR)',
      path: 'userEnergyPricing.dvCostMonthlyEur',
      type: 'number',
      step: 0.01,
      min: 0,
      placeholder: '8.50',
      hint: 'Monatliche Kosten fuer Direktvermarktung (z.B. Luox: 8,50 EUR)',
    },
    {
      section: 'pricing',
      group: 'mode',
      groupLabel: 'Eigener Strompreis',
      groupDescription: 'Hinterlege deinen vollständigen Bruttopreis inklusive MwSt, Netzentgelten, Umlagen und sonstigen kWh-basierten Bestandteilen.',
      path: 'userEnergyPricing.fixedGrossImportCtKwh',
      label: 'Fester Bruttopreis (ct/kWh)',
      type: 'number',
      step: 0.01,
      min: 0,
      visibleWhenPath: { path: 'userEnergyPricing.mode', equals: 'fixed' },
      help: 'Bitte den vollständigen Arbeitspreis inklusive MwSt, Netzentgelten, Umlagen, Abgaben und Steuern eintragen.'
    },
    {
      section: 'pricing',
      group: 'dynamic',
      groupLabel: 'Dynamische Preisbestandteile',
      groupDescription: 'Diese Bestandteile werden auf den EPEX-Preis pro Slot addiert und anschließend mit MwSt beaufschlagt.',
      path: 'userEnergyPricing.dynamicComponents.energyMarkupCtKwh',
      label: 'Energie-Aufschlag (ct/kWh)',
      type: 'number',
      step: 0.01,
      visibleWhenPath: { path: 'userEnergyPricing.mode', equals: 'dynamic' },
      help: 'Zusätzlicher kWh-Aufschlag außerhalb von Netzentgelten und Umlagen.'
    },
    {
      section: 'pricing',
      group: 'dynamic',
      groupLabel: 'Dynamische Preisbestandteile',
      groupDescription: 'Diese Bestandteile werden auf den EPEX-Preis pro Slot addiert und anschließend mit MwSt beaufschlagt.',
      path: 'userEnergyPricing.dynamicComponents.gridChargesCtKwh',
      label: 'Netzentgelte (ct/kWh)',
      type: 'number',
      step: 0.01,
      visibleWhenPath: { path: 'userEnergyPricing.mode', equals: 'dynamic' },
      help: 'Netzentgelte und vergleichbare kWh-basierte Netzbestandteile.'
    },
    {
      section: 'pricing',
      group: 'dynamic',
      groupLabel: 'Dynamische Preisbestandteile',
      groupDescription: 'Diese Bestandteile werden auf den EPEX-Preis pro Slot addiert und anschließend mit MwSt beaufschlagt.',
      path: 'userEnergyPricing.dynamicComponents.leviesAndFeesCtKwh',
      label: 'Umlagen & Abgaben (ct/kWh)',
      type: 'number',
      step: 0.01,
      visibleWhenPath: { path: 'userEnergyPricing.mode', equals: 'dynamic' },
      help: 'Alle weiteren verbrauchsabhängigen Preisbestandteile, die nicht direkt im Marktpreis enthalten sind.'
    },
    {
      section: 'pricing',
      group: 'dynamic',
      groupLabel: 'Dynamische Preisbestandteile',
      groupDescription: 'Diese Bestandteile werden auf den EPEX-Preis pro Slot addiert und anschließend mit MwSt beaufschlagt.',
      path: 'userEnergyPricing.dynamicComponents.vatPct',
      label: 'MwSt (%)',
      type: 'number',
      step: 0.01,
      min: 0,
      visibleWhenPath: { path: 'userEnergyPricing.mode', equals: 'dynamic' },
      help: 'Mehrwertsteuer auf die Summe aus Börsenpreis und Preisbestandteilen.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.usesParagraph14aModule3',
      label: 'Paragraph 14a Modul 3 aktiv',
      type: 'boolean',
      help: 'Aktivieren, wenn für bestimmte Zeitfenster abweichende Bruttopreise gelten.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window1.enabled',
      label: 'Fenster 1 aktiv',
      type: 'boolean',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Aktiviert das erste Modul-3-Zeitfenster.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window1.label',
      label: 'Fenster 1 Bezeichnung',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Optionaler Name, zum Beispiel Nachtfenster.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window1.start',
      label: 'Fenster 1 Start',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Startzeit im Format HH:MM.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window1.end',
      label: 'Fenster 1 Ende',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Endzeit im Format HH:MM.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window1.priceCtKwh',
      label: 'Fenster 1 Bruttopreis (ct/kWh)',
      type: 'number',
      step: 0.01,
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Finaler Endkundenpreis in diesem Fenster, inklusive MwSt und aller kWh-basierten Bestandteile.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window2.enabled',
      label: 'Fenster 2 aktiv',
      type: 'boolean',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Aktiviert das zweite Modul-3-Zeitfenster.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window2.label',
      label: 'Fenster 2 Bezeichnung',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Optionaler Name für das zweite Zeitfenster.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window2.start',
      label: 'Fenster 2 Start',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Startzeit im Format HH:MM.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window2.end',
      label: 'Fenster 2 Ende',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Endzeit im Format HH:MM.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window2.priceCtKwh',
      label: 'Fenster 2 Bruttopreis (ct/kWh)',
      type: 'number',
      step: 0.01,
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Finaler Endkundenpreis in diesem Fenster, inklusive MwSt und aller kWh-basierten Bestandteile.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window3.enabled',
      label: 'Fenster 3 aktiv',
      type: 'boolean',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Aktiviert das dritte Modul-3-Zeitfenster.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window3.label',
      label: 'Fenster 3 Bezeichnung',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Optionaler Name für das dritte Zeitfenster.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window3.start',
      label: 'Fenster 3 Start',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Startzeit im Format HH:MM.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window3.end',
      label: 'Fenster 3 Ende',
      type: 'text',
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Endzeit im Format HH:MM.'
    },
    {
      section: 'pricing',
      group: 'module3',
      groupLabel: 'Paragraph 14a Modul 3',
      groupDescription: 'Optional: definierte Zeitfenster mit abweichendem Bruttopreis für reduzierte Netzentgelte.',
      path: 'userEnergyPricing.module3Windows.window3.priceCtKwh',
      label: 'Fenster 3 Bruttopreis (ct/kWh)',
      type: 'number',
      step: 0.01,
      visibleWhenPath: { path: 'userEnergyPricing.usesParagraph14aModule3', equals: true },
      help: 'Finaler Endkundenpreis in diesem Fenster, inklusive MwSt und aller kWh-basierten Bestandteile.'
    },
    {
      section: 'pricing',
      group: 'costs',
      groupLabel: 'Interne Kosten',
      groupDescription: 'Eigene Erzeugungs- und Speicherkosten für den Vergleich pro Börsenslot.',
      path: 'userEnergyPricing.costs.pvCtKwh',
      label: 'PV-Kosten (ct/kWh)',
      type: 'number',
      step: 0.01,
      help: 'Eigene PV-Stromgestehungskosten pro kWh.'
    },
    {
      section: 'pricing',
      group: 'costs',
      groupLabel: 'Interne Kosten',
      groupDescription: 'Eigene Erzeugungs- und Speicherkosten für den Vergleich pro Börsenslot.',
      path: 'userEnergyPricing.costs.batteryBaseCtKwh',
      label: 'Akku-Basispreis (ct/kWh)',
      type: 'number',
      step: 0.01,
      help: 'Basispreis der gespeicherten kWh ohne pauschalen Verlustaufschlag.'
    },
    {
      section: 'pricing',
      group: 'costs',
      groupLabel: 'Interne Kosten',
      groupDescription: 'Eigene Erzeugungs- und Speicherkosten für den Vergleich pro Börsenslot.',
      path: 'userEnergyPricing.costs.batteryLossMarkupPct',
      label: 'Akku-Verlustaufschlag (%)',
      type: 'number',
      step: 0.01,
      min: 0,
      help: 'Pauschaler Effizienzaufschlag auf den Akku-Basispreis.'
    },
    // ── Forecast & PV ─────────────────────────────────────────────
    {
      section: 'forecast',
      group: 'location',
      groupLabel: 'Standort',
      groupDescription: 'Koordinaten f\u00fcr Wetter- und PV-Vorhersage.',
      path: 'forecast.location.latitude',
      label: 'Breitengrad',
      type: 'number',
      step: 0.000001,
      help: 'Dezimal-Breitengrad (z.B. 48.125611).'
    },
    {
      section: 'forecast',
      group: 'location',
      groupLabel: 'Standort',
      groupDescription: 'Koordinaten f\u00fcr Wetter- und PV-Vorhersage.',
      path: 'forecast.location.longitude',
      label: 'L\u00e4ngengrad',
      type: 'number',
      step: 0.000001,
      help: 'Dezimal-L\u00e4ngengrad (z.B. 9.432794).'
    },
    {
      section: 'forecast',
      group: 'pv',
      groupLabel: 'PV-Anlage',
      groupDescription: 'PV-Konfiguration f\u00fcr die Ertragsprognose.',
      path: 'forecast.pv.totalKwp',
      label: 'Gesamt kWp',
      type: 'number',
      step: 0.1,
      min: 0,
      help: 'Gesamte installierte PV-Leistung in kWp.'
    },
    {
      section: 'forecast',
      group: 'pv',
      groupLabel: 'PV-Anlage',
      groupDescription: 'PV-Konfiguration f\u00fcr die Ertragsprognose.',
      path: 'forecast.pv.model',
      label: 'PV-Modell',
      type: 'select',
      options: [
        { value: 'auto', label: 'Auto (bester verf\u00fcgbarer Dienst)' },
        { value: 'pvlib', label: 'pvlib (lokal, Open-Meteo Wetter)' },
        { value: 'solcast', label: 'Solcast (Cloud API)' },
        { value: 'pvnode', label: 'pvnode (Cloud API)' }
      ],
      help: 'Welcher Dienst die PV-Prognose berechnet. Auto w\u00e4hlt den besten verf\u00fcgbaren.'
    },
    {
      section: 'forecast',
      group: 'pv',
      groupLabel: 'PV-Anlage',
      groupDescription: 'PV-Konfiguration f\u00fcr die Ertragsprognose.',
      path: 'forecast.pv.strings',
      label: 'PV-Strings',
      type: 'array',
      help: 'Liste der PV-Strings mit kWp, Neigung und Ausrichtung. Wird von der PV-String-Konfiguration genutzt.'
    },
    {
      section: 'forecast',
      group: 'solcast',
      groupLabel: 'Solcast',
      groupDescription: 'Solcast Cloud-API f\u00fcr hochpr\u00e4zise PV-Prognosen.',
      path: 'forecast.solcast.enabled',
      label: 'Solcast aktiv',
      type: 'boolean',
      help: 'Aktiviert den Solcast-Dienst f\u00fcr PV-Vorhersagen. Erfordert API-Key und Site-ID.'
    },
    {
      section: 'forecast',
      group: 'solcast',
      groupLabel: 'Solcast',
      groupDescription: 'Solcast Cloud-API f\u00fcr hochpr\u00e4zise PV-Prognosen.',
      path: 'forecast.solcast.apiKey',
      label: 'Solcast API-Key',
      type: 'password',
      help: 'API-Key von solcast.com (kostenlos f\u00fcr Residential bis 10 API-Calls/Tag).'
    },
    {
      section: 'forecast',
      group: 'solcast',
      groupLabel: 'Solcast',
      groupDescription: 'Solcast Cloud-API f\u00fcr hochpr\u00e4zise PV-Prognosen.',
      path: 'forecast.solcast.siteId',
      label: 'Solcast Site-ID',
      type: 'text',
      help: 'Resource-ID der Solcast-Site (z.B. "1234-5678-abcd").'
    },
    {
      section: 'forecast',
      group: 'pvnode',
      groupLabel: 'pvnode',
      groupDescription: 'pvnode.de Cloud-API f\u00fcr PV-Prognosen.',
      path: 'forecast.pvnode.apiKey',
      label: 'pvnode API-Key',
      type: 'password',
      help: 'API-Key von pvnode.de.'
    },
    {
      section: 'forecast',
      group: 'pvnode',
      groupLabel: 'pvnode',
      groupDescription: 'pvnode.de Cloud-API f\u00fcr PV-Prognosen.',
      path: 'forecast.pvnode.nowcastEnabled',
      label: 'Nowcast aktiv (kostenpflichtig)',
      type: 'boolean',
      help: 'Aktiviert pvnode Nowcast f\u00fcr kurzfristige Echtzeit-PV-Prognosen (15min-Horizont). Erfordert kostenpflichtigen pvnode-Plan. Testmodus verf\u00fcgbar.'
    },
    {
      section: 'forecast',
      group: 'weather',
      groupLabel: 'Wetter',
      groupDescription: 'Wetterdaten-Provider f\u00fcr pvlib und ML-Korrektur.',
      path: 'forecast.weather.provider',
      label: 'Wetter-Provider',
      type: 'select',
      options: [
        { value: 'open_meteo', label: 'Open-Meteo (kostenlos, global)' },
        { value: 'mqtt', label: 'MQTT (lokal, z.B. LoxBerry Weather4Lox)' }
      ],
      help: 'Quelle f\u00fcr Wetterdaten (Globalstrahlung, Temperatur, Bew\u00f6lkung). "MQTT" liest eine lokale Wetterstation \u00fcber den Broker (z.B. Weather4Lox auf der LoxBerry).'
    },
    {
      section: 'forecast',
      group: 'weather',
      groupLabel: 'Wetter',
      groupDescription: 'Wetterdaten-Provider f\u00fcr pvlib und ML-Korrektur.',
      path: 'forecast.weather.mqtt.preset',
      label: 'MQTT-Wetter: Schema',
      type: 'select',
      options: [
        { value: 'weather4lox', label: 'LoxBerry Weather4Lox (nur Pfad n\u00f6tig)' },
        { value: 'custom', label: 'Eigenes Mapping (andere Quelle)' }
      ],
      help: 'Weather4Lox hat ein festes Topic-Schema \u2014 es reicht der Broker + Pr\u00e4fix. F\u00fcr andere Quellen (Home Assistant, ioBroker, Node-RED, eigene Station) "Eigenes Mapping" w\u00e4hlen und die Topics je Feld angeben.',
      visibleWhenPath: { path: 'forecast.weather.provider', equals: 'mqtt' }
    },
    {
      section: 'forecast',
      group: 'weather',
      groupLabel: 'Wetter',
      groupDescription: 'Wetterdaten-Provider f\u00fcr pvlib und ML-Korrektur.',
      path: 'forecast.weather.mqtt.brokerUrl',
      label: 'MQTT-Wetter: Broker-URL',
      type: 'text',
      help: 'Broker der Wetterquelle, z.B. mqtt://192.168.0.10:1883. Leer lassen = denselben Broker wie unter "MQTT" verwenden.',
      visibleWhenPath: { path: 'forecast.weather.provider', equals: 'mqtt' }
    },
    {
      section: 'forecast',
      group: 'weather',
      groupLabel: 'Wetter',
      groupDescription: 'Wetterdaten-Provider f\u00fcr pvlib und ML-Korrektur.',
      path: 'forecast.weather.mqtt.prefix',
      label: 'Weather4Lox: Topic-Pr\u00e4fix',
      type: 'text',
      help: 'Pr\u00e4fix der Weather4Lox-Topics (Standard: weather4lox). Es werden die st\u00fcndliche Vorhersage <pr\u00e4fix>/hfcNN_* und die Live-Werte <pr\u00e4fix>/cur_* gelesen.',
      visibleWhenPath: { path: 'forecast.weather.mqtt.preset', equals: 'weather4lox' }
    },
    {
      section: 'forecast',
      group: 'weather',
      groupLabel: 'Wetter',
      groupDescription: 'Wetterdaten-Provider f\u00fcr pvlib und ML-Korrektur.',
      path: 'forecast.weather.mqtt.ghiTopic',
      label: 'Eigenes Mapping: Globalstrahlung-Topic',
      type: 'text',
      // Review 2026-06-10 (B5): das fr\u00fchere ghiUnit-Auswahlfeld (W/m\u00b2 vs. Wh/m\u00b2)
      // ist entfernt \u2014 es gab keine Konversion dahinter (Wh/m\u00b2 pro Stunde ist
      // numerisch identisch mit W/m\u00b2; sub-st\u00fcndlich w\u00e4re ohne Mess-Intervall
      // nicht definierbar). Der Wert MUSS in W/m\u00b2 geliefert werden.
      help: 'MQTT-Topic mit der Globalstrahlung (GHI). Der Wert muss in W/m\u00b2 geliefert werden. Pflichtfeld f\u00fcr eigenes Mapping \u2014 ohne Strahlung keine PV-Sch\u00e4tzung.',
      visibleWhenPath: { path: 'forecast.weather.mqtt.preset', equals: 'custom' }
    },
    {
      section: 'forecast',
      group: 'weather',
      groupLabel: 'Wetter',
      groupDescription: 'Wetterdaten-Provider f\u00fcr pvlib und ML-Korrektur.',
      path: 'forecast.weather.mqtt.tempTopic',
      label: 'Eigenes Mapping: Temperatur-Topic',
      type: 'text',
      help: 'MQTT-Topic mit der Au\u00dfentemperatur (\u00b0C). Optional.',
      visibleWhenPath: { path: 'forecast.weather.mqtt.preset', equals: 'custom' }
    },
    {
      section: 'forecast',
      group: 'weather',
      groupLabel: 'Wetter',
      groupDescription: 'Wetterdaten-Provider f\u00fcr pvlib und ML-Korrektur.',
      path: 'forecast.weather.mqtt.cloudTopic',
      label: 'Eigenes Mapping: Bew\u00f6lkung-Topic',
      type: 'text',
      help: 'MQTT-Topic mit der Bew\u00f6lkung (%). Optional.',
      visibleWhenPath: { path: 'forecast.weather.mqtt.preset', equals: 'custom' }
    },
    {
      section: 'forecast',
      group: 'weather',
      groupLabel: 'Wetter',
      groupDescription: 'Wetterdaten-Provider f\u00fcr pvlib und ML-Korrektur.',
      path: 'forecast.weather.fetchIntervalMs',
      label: 'Abruf-Intervall (ms)',
      type: 'number',
      step: 60000,
      min: 300000,
      help: 'Wie oft Wetterdaten abgerufen werden (Standard: 3600000 = 1h).'
    },
    {
      section: 'forecast',
      group: 'load',
      groupLabel: 'Last-Vorhersage',
      groupDescription: 'Konfiguration der Verbrauchsprognose.',
      path: 'forecast.load.model',
      label: 'Last-Modell',
      type: 'select',
      options: [
        { value: 'sql_weekday', label: 'SQL Wochentag-Rollup (Standard)' },
        { value: 'statsforecast', label: 'StatsForecast (ML, Tier 2+)' }
      ],
      help: 'Methode zur Lastvorhersage. StatsForecast ben\u00f6tigt Python-Bridge und Tier 2+.'
    },
    {
      section: 'forecast',
      group: 'load',
      groupLabel: 'Last-Vorhersage',
      groupDescription: 'Konfiguration der Verbrauchsprognose.',
      path: 'forecast.load.defaultPowerW',
      label: 'Fallback-Leistung (W)',
      type: 'number',
      min: 0,
      step: 50,
      help: 'Wird genutzt wenn keine historischen Verbrauchsdaten vorhanden sind. Typisch: 600-1000W Baseload.'
    },
    {
      section: 'epex',
      group: 'market',
      groupLabel: 'EPEX',
      groupDescription: 'Day-Ahead-Preisfeed für Preise, Prognosen und Negativpreis-Logik.',
      path: 'epex.enabled',
      label: 'EPEX aktiv',
      type: 'boolean',
      help: 'Aktiviert den Abruf von Börsenpreisen.'
    },
    {
      section: 'epex',
      group: 'market',
      groupLabel: 'EPEX',
      groupDescription: 'Day-Ahead-Preisfeed für Preise, Prognosen und Negativpreis-Logik.',
      path: 'epex.bzn',
      label: 'Preiszone',
      type: 'dynamicSelect',
      dynamicOptionsUrl: '/api/epex/zones',
      help: 'EPEX Day-Ahead Bidding Zone. Wird von api.dvhub.de geladen.'
    },
    {
      section: 'epex',
      group: 'market',
      groupLabel: 'EPEX',
      groupDescription: 'Day-Ahead-Preisfeed für Preise, Prognosen und Negativpreis-Logik.',
      path: 'epex.timezone',
      label: 'EPEX Zeitzone',
      type: 'text',
      help: 'Zum Beispiel Europe/Berlin.'
    },
    {
      section: 'epex',
      group: 'market',
      groupLabel: 'EPEX',
      groupDescription: 'Day-Ahead-Preisfeed für Preise, Prognosen und Negativpreis-Logik.',
      path: 'epex.priceApiUrl',
      label: 'Preis-API',
      type: 'select',
      hidden: true,
      options: [
        { value: 'https://api.dvhub.de', label: 'DVhub API (api.dvhub.de)' },
        { value: 'https://api.awattar.com', label: 'Fallback (aWATTar)' }
      ],
      help: 'DVhub Price API Endpunkt. Standard: https://api.dvhub.de'
    },

    // --- ML & Forecast-Korrektur ---
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.mlEnabled',
      label: 'ML-Korrektur aktiviert',
      type: 'boolean',
      help: 'Aktiviert die ML-basierte PV-Forecast-Korrektur (Tier 2+).'
    },
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.mlModelDir',
      label: 'Modell-Verzeichnis',
      type: 'text',
      help: 'Pfad fuer trainierte ML-Modelle.'
    },
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.mlTrainingHour',
      label: 'Training-Stunde (UTC)',
      type: 'number',
      min: 0,
      max: 23,
      help: 'Stunde fuer taegliches Re-Training (UTC).'
    },
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.mlTrainingMinute',
      label: 'Training-Minute',
      type: 'number',
      min: 0,
      max: 59,
      help: 'Minute fuer taegliches Re-Training.'
    },
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.mlRollbackThreshold',
      label: 'Rollback-Schwelle (%)',
      type: 'number',
      min: 1,
      max: 100,
      help: 'Neues Modell wird verworfen wenn MAE um diesen Prozentsatz steigt.'
    },
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.mlMinDataDays',
      label: 'Min. Datentage (Linear)',
      type: 'number',
      min: 7,
      max: 365,
      help: 'Mindestanzahl Tage fuer Linear-Regression-Training.'
    },
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.mlSlidingWindowMonths',
      label: 'Datenfenster (Monate)',
      type: 'number',
      min: 3,
      max: 24,
      help: 'Sliding Window fuer Trainingsdaten.'
    },
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.sfEnabled',
      label: 'StatsForecast aktiviert',
      type: 'boolean',
      help: 'StatsForecast Lastvorhersage statt SQL-Rollups (Tier 2+).'
    },
    {
      section: 'ml',
      group: 'mlCorrection',
      groupLabel: 'ML & Forecast-Korrektur',
      groupDescription: 'Konfiguration fuer ML-basierte PV-Forecast-Korrektur und StatsForecast Lastvorhersage.',
      path: 'ml.sfUseMstl',
      label: 'MSTL aktiviert',
      type: 'boolean',
      help: 'MSTL Multi-Saisonalitaet (Tier 3). Tier 2 nutzt einfaches AutoARIMA.'
    },

  ];

  return addSetupWizardMetadata(fields.filter((entry) => entry.path));
}

const FIELD_DEFINITIONS = buildFieldDefinitions();

export function createDefaultConfig() {
  return {
    manufacturer: 'victron',
    updateChannel: 'stable',
    httpPort: 8080,
    apiToken: '',
    // Plan 09-01 (D-01): optional token-session TTL. Default null = no
    // automatic expiry (LAN-trust appliance model). Reserved for a later
    // user/account phase; not consumed by Phase 9 code.
    apiTokenSessionTtlMs: null,
    modbusListenHost: '0.0.0.0',
    modbusListenPort: 1502,
    // Plan 08-06 Task 2 Step 1: optional allowlist of remote IPs permitted to talk
    // to the Modbus TCP listener. Empty = LAN/loopback default (RFC1918 + 127.0.0.1).
    // Non-empty = exact-string allowlist (no CIDR).
    modbusAllowedClients: [],
    offLeaseMs: 8 * 60 * 1000,
    meterPollMs: 2000,
    keepalivePulseSec: 60,
    gridPositiveMeans: 'feed_in',
    pvCoupling: 'ac_dc',
    // Operator meter-source selector (2026-06-13). Decouples the GRID-METER feed
    // from the manufacturer profile so a non-Victron / hybrid system can point at
    // its own meter (hybrid batteries usually ship their own meter point).
    //   mode='profile' (DEFAULT) — unchanged: the meter register map comes from
    //     the manufacturer profile (hersteller/<manufacturer>.json). Live systems
    //     keep their current behaviour with zero change.
    //   mode='modbus'|'mqtt'|'http' — the operator-supplied endpoint below feeds
    //     the grid value (DV-Schnittstelle + Anzeige). The data-path routing that
    //     consumes these is staged on top of this config (the field is read by the
    //     meter poll once that lands). NOT in MANUFACTURER_MANAGED_PATHS, so it
    //     survives config.json round-trips (unlike cfg.meter, which is stripped).
    meterSource: {
      mode: 'profile',
      label: '',
      modbus: { host: '', port: 502, unitId: 1, fc: 3, address: 0, quantity: 3, timeoutMs: 1200 },
      mqtt: { topicL1: '', topicL2: '', topicL3: '', topicTotal: '' },
      http: { url: '', jsonPath: '' }
    },
    monitoring: {
      pushUrl: '',
      pushIntervalSec: 240,
      // Plan 08-05 Task 1: optional HMAC-SHA256 signing key for outbound
      // heartbeat. Empty string = heartbeat ships as `x-dvhub-signature: unsigned`
      // (backward compatible). When set, the receiver can verify origin.
      signingKey: ''
    },
    dcExportMode: {
      enabled: false,
      bufferW: 100,
      subtractHouseLoad: true,
      priceThresholdCtKwh: null,
      targetSocPct: 90,
      chargeDeadlineHour: 17,
      chargeGuardHours: 2
    },
    victron: {
      transport: 'modbus',
      // T-0080: generic product default — operator configures their own Victron
      // host. Was a fleet-specific LAN IP; prod runs from /etc/dvhub/config.json
      // so it is unaffected. Empty host → transport retry until configured.
      host: '',
      port: 502,
      unitId: 100,
      timeoutMs: 1000,
      // T-0075: max age (ms) of a successful SoC/battery poll before telemetry is
      // treated as stale and forced discharge is suppressed (chokepoint floor).
      telemetryMaxAgeMs: 90000,
      mqtt: {
        // T-0080 P1: was a fleet-specific LAN IP baked into the shipped default
        // (same class as victron.host above — prod reads /etc/dvhub/config.json
        // and is unaffected). Empty broker → MQTT transport waits until the
        // operator configures it instead of probing a stranger's network.
        broker: '',
        portalId: '',
        keepaliveIntervalMs: 30000,
        qos: 0
      }
    },
    meter: {
      fc: 4,
      address: 820,
      quantity: 3,
      timeoutMs: 1200
    },
    points: {
      soc: { enabled: true, fc: 4, address: 843, quantity: 1, signed: false, scale: 1, offset: 0 },
      batteryPowerW: { enabled: true, fc: 4, address: 842, quantity: 1, signed: true, scale: 1, offset: 0 },
      pvPowerW: { enabled: true, fc: 4, address: 850, quantity: 1, signed: false, scale: 1, offset: 0 },
      acPvL1W: { enabled: true, fc: 4, address: 808, quantity: 1, signed: false, scale: 1, offset: 0 },
      acPvL2W: { enabled: true, fc: 4, address: 809, quantity: 1, signed: false, scale: 1, offset: 0 },
      acPvL3W: { enabled: true, fc: 4, address: 810, quantity: 1, signed: false, scale: 1, offset: 0 },
      // T-0107: read the VOLATILE setpoint (2716/2717, int32) — the value actually
      // active once the write path drives 2716. Reading legacy 2700 goes stale then.
      // fc3 = holding register (verify fc3 vs fc4 at the GX). Requires Venus >= 3.50.
      gridSetpointW: { enabled: true, fc: 3, address: 2716, quantity: 2, signed: true, scale: 1, offset: 0, readType: 'int32', wordOrder: 'be' },
      minSocPct: { enabled: true, fc: 4, address: 2901, quantity: 1, signed: false, scale: 0.1, offset: 0 },
      // T-0118: live readback of Cerbo reg 2704 (com.victronenergy.settings
      // /Settings/CGwacs/MaxDischargePower). signed int16 so the -1 "unlimited"
      // sentinel decodes correctly (0xFFFF -> -1, not 65535). 0 = hold, positive
      // = AC discharge cap in W. Same register controlWrite.maxDischargeW writes.
      maxDischargeW: { enabled: true, fc: 4, address: 2704, quantity: 1, signed: true, scale: 1, offset: 0 },
      selfConsumptionW: { enabled: true, fc: 4, address: 817, quantity: 3, signed: false, scale: 1, offset: 0, sumRegisters: true }
    },
    controlWrite: {
      // T-0107: VOLATILE 32-bit ESS setpoint (com.victronenergy.hub4 /Overrides/Setpoint,
      // 2716/2717, big-endian high-word-first). Flash-safe vs the persistent 2700.
      // REQUIRES Venus >= 3.50 AND schedule.controlKeepaliveMs in (0,60000] — else the
      // Multi reverts to Passthru; enforced by the guard in schedule-eval applyControlTarget.
      gridSetpointW: { enabled: true, fc: 16, address: 2716, writeType: 'int32', signed: true, scale: 1, offset: 0, wordOrder: 'be' },
      chargeCurrentA: { enabled: true, fc: 6, address: 2705, writeType: 'int16', signed: true, scale: 1, offset: 0, wordOrder: 'be' },
      minSocPct: { enabled: true, fc: 6, address: 2901, writeType: 'uint16', signed: false, scale: 0.1, offset: 0, wordOrder: 'be' },
      // Cerbo reg 2704 — AC-side discharge cap (com.victronenergy.settings).
      // 0 = no discharge (hold), positive int = cap in W, -1 (0xFFFF) = unlimited.
      // Same register evcc batteryDischargeControl writes; see docs/research/inverter-control-landscape-eu.csv.
      maxDischargeW: { enabled: true, fc: 6, address: 2704, writeType: 'int16', signed: true, scale: 1, offset: 0, wordOrder: 'be' }
    },
    dvControl: {
      enabled: true,
      feedExcessDcPv: { enabled: true, fc: 6, address: 2707, writeType: 'uint16', signed: false, scale: 1, offset: 0, wordOrder: 'be' },
      dontFeedExcessAcPv: { enabled: true, fc: 6, address: 2708, writeType: 'uint16', signed: false, scale: 1, offset: 0, wordOrder: 'be' },
      negativePriceProtection: { enabled: true, gridSetpointW: -40 }
    },
    schedule: {
      timezone: 'Europe/Berlin',
      // T-0107: 5 s eval IS the volatile reg-2716 re-assert cadence. The firmware
      // reverts to Passthru well before the documented 60 s (~10 s observed on
      // Venus 3.7x; we run 3.73). One 5 s writer — no parallel loop racing on 2716.
      evaluateMs: 5000,
      // T-0002/T-0107 keepalive: re-assert the ESS grid setpoint every N ms even
      // if unchanged. MANDATORY for the volatile reg 2716/2717 setpoint. The
      // documented 60 s Passthru timeout is OPTIMISTIC — ~10 s observed on Venus
      // 3.7x. 5 s gives >2x margin; 2716 is RAM so frequent writes are free.
      // Must be in (0,60000]. Per-target override via controlWrite.<target>.keepaliveMs.
      controlKeepaliveMs: 5000,
      // T-0002 safety: SoC floor (%) for a PERSISTENT discharge override
      // (gridSetpointW < 0). At/below this SoC the override is suppressed (hold)
      // so it can never run the battery down to the bare hardware min-SoC.
      manualOverrideMinSocPct: 10,
      defaultGridSetpointW: -40,
      defaultChargeCurrentA: null,
      defaultFeedExcessDcPv: 1,
      rules: [],
      smallMarketAutomation: {
      engine: 'milp',
        enabled: false,
        forecastAware: false,
        searchWindowStart: '14:00',
        searchWindowEnd: '09:00',
        targetSlotCount: null,
        maxDischargeW: -12000,
        batteryCapacityKwh: 30,
        inverterEfficiencyPct: 85,
        minSocPct: 30,
        aggressivePremiumPct: 20,
        predictivePreEmpty: {
          enabled: false,
          akkuHardLimitW: 20000,
          akkuSoftLimitW: 18000,
          confidenceFactorLow: 0.24,
          confidenceFactorHigh: 0.30,
          haltenAbortDropPct: 25
        },
        location: {
          label: 'Deutschland',
          latitude: 51.1657,
          longitude: 10.4515
        },
        stages: []
      }
    },
    userEnergyPricing: {
      mode: 'fixed',
      fixedGrossImportCtKwh: 30,
      periods: [],
      marketValueMode: 'annual',
      pvPlants: [],
      // Erwartete Jahresproduktion in kWh — Basis fuer die Abregelungs-Karte
      // (Vergleich Soll vs. Ist). null = Schaetzung aus Anlagenleistung × 900
      // kWh/kWp (Deutschland-Schnitt). Setzen wenn deine Ausrichtung deutlich
      // davon abweicht — z.B. 25000 bei einer 29.7 kWp-Anlage mit Ost-West
      // statt Sued.
      pvPotentialKwhAnnual: null,
      // Monatliche Verteilung der Jahres-PV-Erzeugung in Prozent (Summe ≈ 100).
      // Default = typische deutsche Verteilung (HTW Berlin / Fraunhofer-Referenz).
      pvMonthlyDistributionPct: [2.5, 4.5, 7.5, 11.0, 14.0, 14.5, 14.0, 12.0, 9.5, 6.0, 3.0, 1.5],
      dvCostMonthlyEur: 8.50,
      dynamicComponents: {
        energyMarkupCtKwh: 0,
        gridChargesCtKwh: 8.5,
        leviesAndFeesCtKwh: 3,
        vatPct: 19
      },
      usesParagraph14aModule3: false,
      module3Windows: {
        window1: { enabled: false, label: '', start: '', end: '', priceCtKwh: null },
        window2: { enabled: false, label: '', start: '', end: '', priceCtKwh: null },
        window3: { enabled: false, label: '', start: '', end: '', priceCtKwh: null }
      },
      costs: {
        pvCtKwh: 5,
        batteryBaseCtKwh: 4,
        batteryLossMarkupPct: 20
      }
    },
    scan: {
      host: '',  // T-0080: generic default; operator sets the scan target (on-demand debug tool).
      port: 502,
      unitId: 0,
      fc: 4,
      start: 2500,
      end: 2700,
      step: 10,
      quantity: 10,
      timeoutMs: 700,
      onlyNonZero: true
    },
    telemetry: {
      enabled: true,
      database: {
        host: '/var/run/postgresql',
        port: 5432,
        name: 'dvhub',
        user: 'dvhub',
        password: ''
      },
      rawRetentionDays: 45,
      historyImport: {
        enabled: false,
        provider: 'vrm',
        vrmPortalId: '',
        vrmToken: ''
      }
    },
    dbBackup: {
      enabled: false,
      scope: 'full',
      time: '03:30',
      targetType: 'local',
      destinationDir: '',
      smb: { host: '', share: '', path: '', username: '', password: '', domain: '' },
      retentionCount: 14
    },
    epex: {
      enabled: true,
      bzn: 'DE-LU',
      timezone: 'Europe/Berlin',
      priceApiUrl: 'https://api.dvhub.de'
    },
    ml: {
      mlEnabled: true,
      mlModelDir: '/opt/dvhub/ml-models',
      mlTrainingHour: 21,
      mlTrainingMinute: 30,
      mlRollbackThreshold: 10,
      mlMinDataDays: 30,
      mlSlidingWindowMonths: 12,
      sfEnabled: true,
      sfUseMstl: true
    },
    optimizer: {
      eosProxy: { enabled: false, url: 'http://127.0.0.1:8503', timeoutMs: 30000 },
      // T-0075: absolute SoC floor (%) below which the chokepoint discharge floor
      // (applyControlTarget) suppresses ANY forced discharge, regardless of source.
      hardFloorSocPct: 5,
      // T-0118: minimum spot price (ct/kWh) for a FORCED grid export. Below this,
      // the schedule-eval chokepoint suppresses arbitrage export rules (hold at
      // default self-consumption) so the battery is never dumped to grid at a low
      // price. Covers ALL sources (heuristic/MILP/small-market/Stage-2 LEEREN).
      // null = OFF (no floor, prior behavior). Self-consumption setpoints are
      // never gated — only forced exports beyond the threshold.
      minSellPriceCtKwh: null,
      // T-0121: how far ahead to ACTUATE schedule rules from the optimizer/EOS
      // plan. The plan still covers days (kept for display/forecast), but emitting
      // rules for >12 h out is pointless — the next (hourly) run recomputes them as
      // conditions change, so it just churns hundreds of rules. Cap the rule set to
      // the next N hours; rules beyond are not actuated until they enter the window.
      ruleHorizonHours: 12,
      // T-0121 closed-loop: fixed load headroom (W) added to the reg-2704 battery
      // cap (cap = B + headroom). FIXED (not live load) so the cap only changes on
      // B change (per slot) → no flash wear on the persistent register.
      capLoadHeadroomW: 5000
    },
    // evcc integration. Polls evcc /api/state and writes maxDischargeW=holdValueW (default 0 = HOLD)
    // when an EV is charging, releases (-1 = unlimited) when charging stops. Edge-triggered, so it
    // never fights with manual operator writes or other schedule rules between transitions.
    // Set holdValueW to a positive number (e.g. 8000) if you want a cap instead of full hold.
    evcc: {
      enabled: false,
      url: '',  // T-0080: generic default (evcc off by default; operator sets their evcc URL).
      pollIntervalMs: 15000,
      requestTimeoutMs: 5000,
      holdValueW: 0,
      releaseValueW: -1,
      // #23 (2026-06-13): which evcc loadpoint the Family EV panel shows/controls
      // (1-based; null = first available). Configured on the Integrations page.
      dashboardLoadpoint: null
    },
    // Plan 08-04 Task 2 Step 5: Host-header + CORS + trust-proxy allowlists.
    // Defaults stay permissive for LAN-first installs (empty arrays = no check);
    // operators on public-facing / reverse-proxy deployments MUST populate
    // allowedHosts (FQDN list), corsAllowedOrigins (exact origins), and opt in
    // to trustProxy=true only when a known reverse proxy is actually in front.
    // Never auto-populate from req.headers.host at runtime — defeats the guard.
    allowedHosts: [],
    corsAllowedOrigins: [],
    trustProxy: false,
    // Plan 09-03: reverse-proxy IPs whose X-Forwarded-For header is trusted by
    // deriveClientIp(). Only consulted when trustProxy=true. Empty list with
    // trustProxy=true is treated as misconfigured (server logs a one-time
    // warning at startup and falls back to req.socket.remoteAddress — defends
    // against XFF spoofing, which is the CRITICAL class Phase 8 hardened).
    trustedProxyIps: [],
    // Go-Live-Review 2026-06-10 (Christin): operator-selectable LAN-trust posture.
    // Until now the LAN bypass was hard-coded: every endpoint reachable from a
    // private/loopback address skipped checkAuth (the curated LAN_SAFE_ENDPOINTS
    // allowlist was never actually consulted — dead code). This block makes the
    // posture a choice without breaking any existing install (default 'open' ==
    // the prior blanket-bypass behaviour). See routes-api.js checkAuth.
    //   lanTrust:
    //     'open'       — any LAN client bypasses the token (today's behaviour, default)
    //     'restricted' — LAN clients bypass ONLY for endpoints whose group is in
    //                    lanSafeGroups; everything else (admin, config writes,
    //                    control writes, eosdash) needs a Bearer token even on LAN
    //     'strict'     — no LAN bypass at all; only 127.0.0.1/::1 (the box itself)
    //                    is trusted, every other client needs a Bearer token
    //   lanCidrs:        [] = built-in RFC1918 + loopback + fe80 definition of "LAN".
    //                    Non-empty = ONLY these CIDRs count as LAN (e.g. just the
    //                    smart-home VLAN). IPv4 a.b.c.d/n and IPv6 prefix/n.
    //   lanSafeGroups:   endpoint groups that bypass under 'restricted'. Groups:
    //                    status, dashboard, history, forecast, integrations.
    //   trustedClientIps:[] = any LAN ip is trusted. Non-empty = ONLY these exact
    //                    IPs get the LAN bypass (an explicit per-device allowlist).
    security: {
      lanTrust: 'open',
      lanCidrs: [],
      lanSafeGroups: ['status', 'dashboard', 'history', 'forecast', 'integrations'],
      trustedClientIps: []
    },
    // Licensing (Phase 17 license service). keygenAccount is the Keygen CE
    // account ID on license.dvhub.de — product-wide, identical for every
    // DVhub installation (it identifies the VENDOR account, not the customer;
    // the customer-specific part is the license key itself, which is never
    // stored in config.json — it lives in license_state.json, mode 0600).
    // Previously this had no default, so activateLicense() always failed with
    // keygen_account_not_configured unless KEYGEN_ACCOUNT was set in the env.
    // Being part of createDefaultConfig also auto-adds the 'licensing' root to
    // ALLOWED_CONFIG_ROOTS (strict-root save check).
    licensing: {
      keygenAccount: '7458ae2d-50d2-469a-9174-8a7fcd9934a1'
    }
  };
}

function applyVictronDefaults(config) {
  const next = clone(config);
  const victron = next.victron || {};
  const apply = (entry) => {
    if (!isPlainObject(entry)) return;
    entry.host = entry.host ?? victron.host;
    entry.port = entry.port ?? victron.port;
    entry.unitId = entry.unitId ?? victron.unitId;
    entry.timeoutMs = entry.timeoutMs ?? victron.timeoutMs;
  };
  apply(next.meter);
  for (const item of Object.values(next.points || {})) apply(item);
  for (const item of Object.values(next.controlWrite || {})) apply(item);
  for (const [key, item] of Object.entries(next.dvControl || {})) {
    if (key !== 'enabled' && key !== 'negativePriceProtection') apply(item);
  }
  // Disable PV points based on pvCoupling selection
  const coupling = next.pvCoupling || 'ac_dc';
  if (coupling === 'dc' && next.points) {
    if (next.points.acPvL1W) next.points.acPvL1W.enabled = false;
    if (next.points.acPvL2W) next.points.acPvL2W.enabled = false;
    if (next.points.acPvL3W) next.points.acPvL3W.enabled = false;
  }
  if (coupling === 'ac' && next.points) {
    if (next.points.pvPowerW) next.points.pvPowerW.enabled = false;
  }

  return next;
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'ja', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'nein', 'off'].includes(normalized)) return false;
  }
  return Boolean(value);
}

function toFiniteNumberOrNull(value) {
  return toFiniteNumber(value, null);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundCtKwh(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function formatLocalDate(value, timeZone = BERLIN_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function localMinutesOfDay(value, timeZone = BERLIN_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function slotMinuteMatchesWindow(minuteOfDay, window) {
  if (minuteOfDay == null || !window) return false;
  if (window.start <= window.end) return minuteOfDay >= window.start && minuteOfDay < window.end;
  return minuteOfDay >= window.start || minuteOfDay < window.end;
}

function sanitizePricingNumberField(target, key, warningPrefix, warnings) {
  if (!isPlainObject(target)) return;
  if (target[key] == null || target[key] === '') return;
  target[key] = Number(target[key]);
  if (!Number.isFinite(target[key])) {
    warnings.push(`${warningPrefix}.${key}: invalid number, field was reset`);
    delete target[key];
  }
}

function sanitizeDynamicComponents(value, warnings, warningPrefix = 'userEnergyPricing.dynamicComponents') {
  const next = isPlainObject(value) ? clone(value) : {};
  for (const key of ['energyMarkupCtKwh', 'gridChargesCtKwh', 'leviesAndFeesCtKwh', 'vatPct']) {
    sanitizePricingNumberField(next, key, warningPrefix, warnings);
  }
  return next;
}

function sanitizePricingCosts(value, warnings, warningPrefix = 'userEnergyPricing.costs') {
  const next = isPlainObject(value) ? clone(value) : {};
  for (const key of ['pvCtKwh', 'batteryBaseCtKwh', 'batteryLossMarkupPct']) {
    sanitizePricingNumberField(next, key, warningPrefix, warnings);
  }
  return next;
}

function isIsoDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sanitizeScheduleRules(value, warnings) {
  if (!Array.isArray(value)) return [];
  const rules = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const next = {};
    if (item.id != null) next.id = String(item.id);
    if (item.target != null) next.target = String(item.target);
    if (item.start != null) next.start = String(item.start);
    if (item.end != null) next.end = String(item.end);
    if (item.value != null) next.value = Number(item.value);
    if (item.stopSocPct != null && item.stopSocPct !== '') next.stopSocPct = Number(item.stopSocPct);
    if (item.enabled != null) next.enabled = coerceBoolean(item.enabled);
    if (item.source != null) next.source = String(item.source);
    if (item.autoManaged != null) next.autoManaged = coerceBoolean(item.autoManaged);
    if (item.displayTone != null) next.displayTone = String(item.displayTone);
    if (item.activeDate != null) next.activeDate = String(item.activeDate);
    if (item.slotTs != null) next.slotTs = Number(item.slotTs);
    if (item.slotEndTs != null) next.slotEndTs = Number(item.slotEndTs);
    if (next.value != null && !Number.isFinite(next.value)) {
      warnings.push(`schedule.rules.${next.id || rules.length}: value ignored because it is not numeric`);
      continue;
    }
    if (next.stopSocPct != null && !Number.isFinite(next.stopSocPct)) {
      warnings.push(`schedule.rules.${next.id || rules.length}: stopSocPct ignored because it is not numeric`);
      delete next.stopSocPct;
    }
    rules.push(next);
  }
  return rules;
}

function sanitizeSmallMarketAutomationStages(value, warnings) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry, index) => {
      if (!isPlainObject(entry)) {
        warnings.push(`schedule.smallMarketAutomation.stages.${index}: invalid entry ignored`);
        return null;
      }

      const next = {};
      for (const key of ['dischargeW', 'dischargeSlots', 'cooldownW', 'cooldownSlots']) {
        if (entry[key] == null || entry[key] === '') continue;
        const numericValue = Number(entry[key]);
        if (!Number.isFinite(numericValue)) {
          warnings.push(`schedule.smallMarketAutomation.stages.${index}.${key}: invalid number, field was reset`);
          continue;
        }
        next[key] = numericValue;
      }
      return next;
    })
    .filter(Boolean);
}

function sanitizePredictivePreEmpty(value, warnings) {
  if (!isPlainObject(value)) return {};
  const next = clone(value);
  if (next.enabled != null) next.enabled = coerceBoolean(next.enabled);

  // akkuHardLimitW (D-17): a missing/NaN value must NEVER silently disable the
  // battery clamp — reset to the safe default 20000, then clamp into [1000, 50000].
  if (next.akkuHardLimitW != null && next.akkuHardLimitW !== '') {
    const n = Number(next.akkuHardLimitW);
    if (!Number.isFinite(n)) {
      warnings.push('schedule.smallMarketAutomation.predictivePreEmpty.akkuHardLimitW: invalid number, reset to safe default');
      next.akkuHardLimitW = 20000;
    } else {
      next.akkuHardLimitW = clamp(n, 1000, 50000);
    }
  }

  // The Stage-2 below-PV-cost trigger reads the operator's existing PV
  // generation cost (userEnergyPricing.costs.pvCtKwh) — there is no Stage-2-
  // specific duplicate of that field, so nothing to sanitize here for it.

  // Bounded tuning fields — delete on invalid, clamp on valid.
  const bounded = [
    ['akkuSoftLimitW', 0, 50000],
    ['confidenceFactorLow', 0, 1],
    ['confidenceFactorHigh', 0, 1],
    ['haltenAbortDropPct', 5, 90],
    ['maxChargeCurrentA', 0, 1000],
    ['batteryVoltageV', 12, 1000]
  ];
  for (const [key, lo, hi] of bounded) {
    if (next[key] == null || next[key] === '') continue;
    const n = Number(next[key]);
    if (!Number.isFinite(n)) {
      warnings.push(`schedule.smallMarketAutomation.predictivePreEmpty.${key}: invalid number, field was reset`);
      delete next[key];
      continue;
    }
    next[key] = clamp(n, lo, hi);
  }
  return next;
}

function sanitizeSmallMarketAutomation(value, warnings) {
  if (!isPlainObject(value)) return {};

  const next = clone(value);
  if (next.enabled != null) next.enabled = coerceBoolean(next.enabled);
  if (next.searchWindowStart != null) next.searchWindowStart = String(next.searchWindowStart);
  if (next.searchWindowEnd != null) next.searchWindowEnd = String(next.searchWindowEnd);

  for (const key of ['targetSlotCount', 'maxDischargeW', 'minSocPct', 'aggressivePremiumPct']) {
    if (next[key] == null || next[key] === '') continue;
    const numericValue = Number(next[key]);
    if (!Number.isFinite(numericValue)) {
      warnings.push(`schedule.smallMarketAutomation.${key}: invalid number, field was reset`);
      delete next[key];
      continue;
    }
    next[key] = numericValue;
  }

  if (next.batteryCapacityKwh != null && next.batteryCapacityKwh !== '') {
    const numericValue = toFiniteNumberOrNull(next.batteryCapacityKwh);
    if (numericValue == null || numericValue <= 0) {
      warnings.push('schedule.smallMarketAutomation.batteryCapacityKwh: invalid number, field was reset');
      delete next.batteryCapacityKwh;
    } else {
      next.batteryCapacityKwh = numericValue;
    }
  }

  if (next.inverterEfficiencyPct != null && next.inverterEfficiencyPct !== '') {
    const numericValue = Number(next.inverterEfficiencyPct);
    if (!Number.isFinite(numericValue)) {
      warnings.push('schedule.smallMarketAutomation.inverterEfficiencyPct: invalid number, field was reset');
      delete next.inverterEfficiencyPct;
    } else {
      next.inverterEfficiencyPct = clamp(toFiniteNumber(next.inverterEfficiencyPct, 85), 1, 100);
    }
  }

  const location = isPlainObject(next.location) ? clone(next.location) : {};
  if (location.label != null) location.label = String(location.label);
  for (const key of ['latitude', 'longitude']) {
    if (location[key] == null || location[key] === '') continue;
    const numericValue = Number(location[key]);
    if (!Number.isFinite(numericValue)) {
      warnings.push(`schedule.smallMarketAutomation.location.${key}: invalid number, field was reset`);
      delete location[key];
      continue;
    }
    location[key] = numericValue;
  }
  next.location = location;
  // Only sanitize predictivePreEmpty when the input actually carries it — never
  // inject an empty sub-block into a config the operator never set it on. The
  // createDefaultConfig defaults supply the full block via deepMerge downstream.
  if (next.predictivePreEmpty !== undefined) {
    next.predictivePreEmpty = sanitizePredictivePreEmpty(next.predictivePreEmpty, warnings);
  }
  next.stages = sanitizeSmallMarketAutomationStages(next.stages, warnings);
  return next;
}

function sanitizeUserEnergyPricingWindows(value, warnings) {
  const windowIds = ['window1', 'window2', 'window3'];
  const out = {};
  const source = isPlainObject(value) ? value : {};
  for (const windowId of windowIds) {
    const entry = isPlainObject(source[windowId]) ? { ...source[windowId] } : {};
    const next = {
      enabled: coerceBoolean(entry.enabled),
      label: entry.label == null ? '' : String(entry.label),
      start: entry.start == null ? '' : String(entry.start),
      end: entry.end == null ? '' : String(entry.end),
      priceCtKwh: entry.priceCtKwh == null || entry.priceCtKwh === '' ? null : Number(entry.priceCtKwh)
    };
    if (next.priceCtKwh != null && !Number.isFinite(next.priceCtKwh)) {
      warnings.push(`userEnergyPricing.module3Windows.${windowId}.priceCtKwh: invalid number, field was reset`);
      next.priceCtKwh = null;
    }
    out[windowId] = next;
  }
  return out;
}

function sanitizeUserEnergyPricingPeriods(value, warnings) {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .map((entry, index) => {
      if (!isPlainObject(entry)) {
        warnings.push(`userEnergyPricing.periods.${index}: invalid entry ignored`);
        return null;
      }

      const next = {
        id: entry.id == null || entry.id === '' ? `period-${index + 1}` : String(entry.id),
        label: entry.label == null ? '' : String(entry.label),
        startDate: entry.startDate == null ? '' : String(entry.startDate),
        endDate: entry.endDate == null ? '' : String(entry.endDate),
        mode: entry.mode == null ? '' : String(entry.mode)
      };

      if (!isIsoDateOnly(next.startDate) || !isIsoDateOnly(next.endDate)) {
        warnings.push(`userEnergyPricing.periods.${next.id}: startDate and endDate must use YYYY-MM-DD`);
        return null;
      }
      if (next.startDate > next.endDate) {
        warnings.push(`userEnergyPricing.periods.${next.id}: startDate must be on or before endDate`);
        return null;
      }
      if (!['fixed', 'dynamic'].includes(next.mode)) {
        warnings.push(`userEnergyPricing.periods.${next.id}: mode must be fixed or dynamic`);
        return null;
      }

      if (next.mode === 'fixed') {
        next.fixedGrossImportCtKwh = entry.fixedGrossImportCtKwh == null || entry.fixedGrossImportCtKwh === ''
          ? null
          : Number(entry.fixedGrossImportCtKwh);
        if (!Number.isFinite(next.fixedGrossImportCtKwh)) {
          warnings.push(`userEnergyPricing.periods.${next.id}.fixedGrossImportCtKwh: required numeric value for fixed mode`);
          return null;
        }
      }

      if (next.mode === 'dynamic') {
        next.dynamicComponents = sanitizeDynamicComponents(
          entry.dynamicComponents,
          warnings,
          `userEnergyPricing.periods.${next.id}.dynamicComponents`
        );
        const requiredKeys = ['energyMarkupCtKwh', 'gridChargesCtKwh', 'leviesAndFeesCtKwh', 'vatPct'];
        if (requiredKeys.some((key) => !Number.isFinite(Number(next.dynamicComponents[key])))) {
          warnings.push(`userEnergyPricing.periods.${next.id}.dynamicComponents: all dynamic fields are required`);
          return null;
        }
      }

      if (entry.usesParagraph14aModule3 != null) next.usesParagraph14aModule3 = coerceBoolean(entry.usesParagraph14aModule3);
      if (entry.module3Windows != null) next.module3Windows = sanitizeUserEnergyPricingWindows(entry.module3Windows, warnings);
      if (entry.costs != null) next.costs = sanitizePricingCosts(
        entry.costs,
        warnings,
        `userEnergyPricing.periods.${next.id}.costs`
      );

      return next;
    })
    .filter(Boolean)
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.endDate.localeCompare(right.endDate));

  const accepted = [];
  for (const period of normalized) {
    const previous = accepted[accepted.length - 1];
    if (previous && period.startDate <= previous.endDate) {
      warnings.push(`userEnergyPricing.periods.${period.id}: overlap with ${previous.id}`);
      continue;
    }
    accepted.push(period);
  }
  return accepted;
}

/**
 * Sanitize pvPlants[] array from user config.
 *
 * Accepted fields (per plant):
 * - kwp              — installed capacity in kWp (required, > 0)
 * - commissionedAt   — ISO date YYYY-MM-DD (required)
 * - tiltDeg          — roof/panel tilt 0..90 degrees (optional, Phase 07 D-A2)
 * - azimuthDeg       — panel azimuth 0..360 (0=N, 180=S) — native pvnode convention (optional)
 * - skyObstructionConfig — string (≤2000 chars); maps to pvnode `sky_obstruction_config`
 *                          query param (horizon profile for direct-sun shading)
 * - shadingConfig    — string (≤2000 chars); maps to pvnode `shading_config`
 *                      query param (inter-row / tracker shading)
 *
 * skyObstructionConfig and shadingConfig are INDEPENDENT pvnode API params per REVIEWS H7.
 * The legacy `skyObstruction` (no suffix) field name is NOT introduced.
 * ASVS V5 length bound: 2000 chars per string field (prevents config-file DoS).
 */
function sanitizeUserEnergyPricingPvPlants(value, warnings) {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry, index) => {
      if (!isPlainObject(entry)) {
        warnings.push(`userEnergyPricing.pvPlants.${index}: invalid entry ignored`);
        return null;
      }

      const kwp = entry.kwp == null || entry.kwp === '' ? null : Number(entry.kwp);
      const commissionedAt = entry.commissionedAt == null ? '' : String(entry.commissionedAt);
      if (!Number.isFinite(kwp) || kwp <= 0) {
        warnings.push(`userEnergyPricing.pvPlants.${index}: kwp must be a positive number`);
        return null;
      }
      if (!isIsoDateOnly(commissionedAt)) {
        warnings.push(`userEnergyPricing.pvPlants.${index}: commissionedAt must use YYYY-MM-DD`);
        return null;
      }

      // Phase 07 D-A2 + REVIEWS H7: optional pvPlants[] forecast fields
      //   tiltDeg, azimuthDeg — geometry (native pvnode convention: azimuth 0=N, 180=S)
      //   skyObstructionConfig → pvnode sky_obstruction_config (horizon profile)
      //   shadingConfig        → pvnode shading_config (inter-row / tracker shading)
      // These two string fields are separate pvnode API params; do NOT merge them.
      let tiltDeg;
      const tiltDegRaw = entry.tiltDeg;
      if (tiltDegRaw != null && tiltDegRaw !== '') {
        const v = Number(tiltDegRaw);
        if (Number.isFinite(v) && v >= 0 && v <= 90) {
          tiltDeg = v;
        } else {
          warnings.push(`userEnergyPricing.pvPlants.${index}: tiltDeg must be 0..90 degrees`);
        }
      }

      let azimuthDeg;
      const azimuthDegRaw = entry.azimuthDeg;
      if (azimuthDegRaw != null && azimuthDegRaw !== '') {
        const v = Number(azimuthDegRaw);
        if (Number.isFinite(v) && v >= 0 && v <= 360) {
          azimuthDeg = v;
        } else {
          warnings.push(`userEnergyPricing.pvPlants.${index}: azimuthDeg must be 0..360 (0=N, 180=S)`);
        }
      }

      // REVIEWS H7: skyObstructionConfig maps to pvnode `sky_obstruction_config` (horizon profile)
      let skyObstructionConfig;
      if (typeof entry.skyObstructionConfig === 'string' && entry.skyObstructionConfig.length > 0) {
        skyObstructionConfig = entry.skyObstructionConfig.slice(0, 2000); // ASVS V5 length bound
      }

      // REVIEWS H7: shadingConfig maps to pvnode `shading_config` (inter-row / tracker shading)
      let shadingConfig;
      if (typeof entry.shadingConfig === 'string' && entry.shadingConfig.length > 0) {
        shadingConfig = entry.shadingConfig.slice(0, 2000); // ASVS V5 length bound
      }

      return {
        kwp: roundCtKwh(kwp),
        commissionedAt,
        ...(tiltDeg !== undefined && { tiltDeg }),
        ...(azimuthDeg !== undefined && { azimuthDeg }),
        ...(skyObstructionConfig !== undefined && { skyObstructionConfig }),
        ...(shadingConfig !== undefined && { shadingConfig })
      };
    })
    .filter(Boolean);
}

function sanitizeUserEnergyPricing(value, warnings) {
  if (!isPlainObject(value)) return value;
  const next = clone(value);
  if (next.mode != null) next.mode = String(next.mode);
  if (next.fixedGrossImportCtKwh != null && next.fixedGrossImportCtKwh !== '') {
    next.fixedGrossImportCtKwh = Number(next.fixedGrossImportCtKwh);
    if (!Number.isFinite(next.fixedGrossImportCtKwh)) {
      warnings.push('userEnergyPricing.fixedGrossImportCtKwh: invalid number, field was reset');
      delete next.fixedGrossImportCtKwh;
    }
  }
  if (next.usesParagraph14aModule3 != null) next.usesParagraph14aModule3 = coerceBoolean(next.usesParagraph14aModule3);
  next.periods = sanitizeUserEnergyPricingPeriods(next.periods, warnings);
  next.pvPlants = sanitizeUserEnergyPricingPvPlants(next.pvPlants, warnings);
  const dvCostMonthlyEur = Number(next.dvCostMonthlyEur);
  next.dvCostMonthlyEur = Number.isFinite(dvCostMonthlyEur) && dvCostMonthlyEur >= 0
    ? roundCtKwh(dvCostMonthlyEur)
    : 8.50;
  next.dynamicComponents = sanitizeDynamicComponents(next.dynamicComponents, warnings);
  next.module3Windows = sanitizeUserEnergyPricingWindows(next.module3Windows, warnings);
  next.costs = sanitizePricingCosts(next.costs, warnings);
  return next;
}

function isLegacyPlaceholderRegisterEntry(entry) {
  if (!isPlainObject(entry)) return false;

  const address = entry.address == null || entry.address === '' ? 0 : Number(entry.address);
  const quantity = entry.quantity == null || entry.quantity === '' ? 0 : Number(entry.quantity);
  const scale = entry.scale == null || entry.scale === '' ? 0 : Number(entry.scale);
  const offset = entry.offset == null || entry.offset === '' ? 0 : Number(entry.offset);
  const signed = coerceBoolean(entry.signed ?? false);
  const fc = entry.fc == null || entry.fc === '' ? null : Number(entry.fc);
  const writeType = entry.writeType == null ? '' : String(entry.writeType).trim();
  const wordOrder = entry.wordOrder == null ? '' : String(entry.wordOrder).trim();
  const allowAddressZero = entry.allowAddressZero == null ? false : coerceBoolean(entry.allowAddressZero);

  return address === 0
    && quantity === 0
    && scale === 0
    && offset === 0
    && signed === false
    && (fc == null || fc === 0)
    && writeType === ''
    && wordOrder === ''
    && allowAddressZero === false;
}

function resetLegacyPlaceholderRegisters(raw, warnings) {
  const resetEntry = (path) => {
    const entry = getPath(raw, path);
    if (!isLegacyPlaceholderRegisterEntry(entry)) return false;
    deletePath(raw, path);
    warnings.push(`${path}: legacy placeholder register was reset to default`);
    return true;
  };

  resetEntry('controlWrite.gridSetpointW');
  resetEntry('controlWrite.chargeCurrentA');
  resetEntry('controlWrite.minSocPct');
  resetEntry('controlWrite.maxDischargeW');

  const dvFeedReset = resetEntry('dvControl.feedExcessDcPv');
  const dvAcReset = resetEntry('dvControl.dontFeedExcessAcPv');
  const negativePricePath = 'dvControl.negativePriceProtection.gridSetpointW';
  if ((dvFeedReset || dvAcReset) && Number(getPath(raw, negativePricePath)) === 0) {
    deletePath(raw, negativePricePath);
    warnings.push(`${negativePricePath}: legacy placeholder register was reset to default`);
  }
}

function sanitizeRawConfig(rawInput) {
  const raw = isPlainObject(rawInput) ? clone(rawInput) : {};
  const warnings = [];
  // Sweep package 6: shape-level schema checks run FIRST, on the raw parsed
  // config — before the FIELD_DEFINITIONS coercion pass below, which would
  // otherwise silently string-coerce a wrong-typed scalar (e.g. a numeric
  // apiToken) past the type check. Warn-and-continue only; never aborts.
  validateConfigSchema(raw, warnings);
  for (const field of FIELD_DEFINITIONS) {
    if (!hasPath(raw, field.path)) continue;
    // predictivePreEmpty has its own dedicated sub-block validator
    // (sanitizePredictivePreEmpty) with a reset-on-invalid contract — T-10-04
    // requires an invalid akkuHardLimitW to RESET to the safe default, never be
    // deleted. The generic number pass below deletes on invalid/out-of-range, so
    // it must NOT touch these fields; sanitizeSmallMarketAutomation owns them.
    if (field.path.startsWith('schedule.smallMarketAutomation.predictivePreEmpty.')) continue;
    const currentValue = getPath(raw, field.path);
    if ((currentValue === '' || currentValue == null) && field.empty === 'delete') {
      deletePath(raw, field.path);
      continue;
    }
    if ((currentValue === '' || currentValue == null) && field.empty === 'null') {
      setPath(raw, field.path, null);
      continue;
    }

    if (field.type === 'boolean') {
      setPath(raw, field.path, coerceBoolean(currentValue));
      continue;
    }

    if (field.type === 'number') {
      const num = Number(currentValue);
      if (!Number.isFinite(num)) {
        warnings.push(`${field.path}: invalid number, field was reset to default`);
        deletePath(raw, field.path);
      } else if ((field.min !== undefined && num < field.min) || (field.max !== undefined && num > field.max)) {
        warnings.push(`${field.path}: out of range, field was reset to default`);
        deletePath(raw, field.path);
      } else {
        setPath(raw, field.path, num);
      }
      continue;
    }

    if (field.type === 'select') {
      const allowed = (field.options || []).map((option) => option.value);
      const normalized = allowed.includes(currentValue)
        ? currentValue
        : allowed.find((entry) => String(entry) === String(currentValue));
      if (normalized === undefined) {
        warnings.push(`${field.path}: invalid option, field was reset to default`);
        deletePath(raw, field.path);
      } else {
        setPath(raw, field.path, normalized);
      }
      continue;
    }

    if (field.type === 'array') continue;

    setPath(raw, field.path, currentValue == null ? '' : String(currentValue));
  }

  raw.schedule = raw.schedule || {};
  raw.schedule.rules = sanitizeScheduleRules(raw.schedule.rules, warnings);
  if (hasPath(raw, 'schedule.smallMarketAutomation')) {
    raw.schedule.smallMarketAutomation = sanitizeSmallMarketAutomation(raw.schedule.smallMarketAutomation, warnings);
  }
  if (hasPath(raw, 'userEnergyPricing')) {
    raw.userEnergyPricing = sanitizeUserEnergyPricing(raw.userEnergyPricing, warnings);
  }
  resetLegacyPlaceholderRegisters(raw, warnings);
  stripManufacturerManagedFields(raw, warnings);
  return { raw, warnings };
}

// Sweep package 6: shape-level config-schema validation.
// Runs at the START of sanitizeRawConfig, BEFORE the FIELD_DEFINITIONS coercion
// pass — so it sees the raw parsed value and a wrong-typed scalar (e.g. a
// numeric apiToken) is caught before string-coercion masks the type. It catches
// a config that parses as JSON but carries wrong-typed critical fields, warns,
// and substitutes a safe default. WARN-AND-CONTINUE only — it NEVER aborts
// startup or sets valid=false; a hard abort on a bad config edit would brick
// the battery controller. The `warnings` array it receives is the same channel
// surfaced to loadConfigFile callers and the server-side startup log.
function isFiniteIntInRange(value, lo, hi) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= lo && numeric <= hi;
}

function validateConfigSchema(raw, warnings) {
  if (!isPlainObject(raw)) return;
  const defaults = createDefaultConfig();

  // httpPort — must be a finite integer 1-65535. (FIELD_DEFINITIONS also covers
  // this; the extra layer catches a value that slipped past, e.g. an object.)
  if ('httpPort' in raw && !isFiniteIntInRange(raw.httpPort, 1, 65535)) {
    warnings.push(`config.httpPort (${JSON.stringify(raw.httpPort)}) is not a valid port number — using default ${defaults.httpPort}`);
    raw.httpPort = defaults.httpPort;
  }

  // httpsPort — optional; only validated when present. No createDefaultConfig
  // key exists, so an invalid value is dropped (server.js treats absent as
  // "no HTTPS"), never carried forward.
  if ('httpsPort' in raw && raw.httpsPort != null && raw.httpsPort !== ''
      && !isFiniteIntInRange(raw.httpsPort, 1, 65535)) {
    warnings.push(`config.httpsPort (${JSON.stringify(raw.httpsPort)}) is not a valid port number — HTTPS disabled`);
    delete raw.httpsPort;
  }

  // apiToken — must be a string. A non-string token would break the bearer
  // comparison in routes-api.js; fall back to the empty-string default (the
  // LAN-trust no-external-auth posture) rather than carrying a bad value.
  if ('apiToken' in raw && raw.apiToken != null && typeof raw.apiToken !== 'string') {
    warnings.push(`config.apiToken is not a string (got ${typeof raw.apiToken}) — using empty token (no external auth)`);
    raw.apiToken = defaults.apiToken;
  }

  // keepalivePulseSec — must be a positive number (pairs with H-2 in Plan 16-02).
  if ('keepalivePulseSec' in raw
      && !(Number.isFinite(Number(raw.keepalivePulseSec)) && Number(raw.keepalivePulseSec) > 0)) {
    warnings.push(`config.keepalivePulseSec (${JSON.stringify(raw.keepalivePulseSec)}) is not a positive number — using default ${defaults.keepalivePulseSec}`);
    raw.keepalivePulseSec = defaults.keepalivePulseSec;
  }

  // epex / optimizer — must be objects when present, else deepMerge would carry
  // a scalar into an object slot. Drop a wrong-typed section so the default
  // object stands in.
  for (const section of ['epex', 'optimizer']) {
    if (section in raw && raw[section] != null && !isPlainObject(raw[section])) {
      warnings.push(`config.${section} is not an object (got ${typeof raw[section]}) — section reset to default`);
      delete raw[section];
    }
  }
}

export function normalizeConfigInput(rawInput) {
  const defaults = createDefaultConfig();
  // sanitizeRawConfig runs the sweep-package-6 validateConfigSchema shape checks
  // first, then the FIELD_DEFINITIONS coercion pass — both push to `warnings`.
  const { raw, warnings } = sanitizeRawConfig(rawInput);
  const persistedConfig = deepMerge(defaults, raw);
  if (!Array.isArray(persistedConfig.schedule?.rules)) persistedConfig.schedule.rules = [];
  // Default BZN to DE-LU when EPEX is enabled but no zone is set
  if (persistedConfig.epex?.enabled && !persistedConfig.epex?.bzn) persistedConfig.epex.bzn = 'DE-LU';
  // Ensure priceApiUrl is always set (legacy configs may omit it)
  if (persistedConfig.epex && !persistedConfig.epex.priceApiUrl) persistedConfig.epex.priceApiUrl = 'https://api.dvhub.de';
  const effectiveConfig = applyVictronDefaults(persistedConfig);
  return { rawConfig: raw, persistedConfig, effectiveConfig, warnings };
}

function buildEffectiveUserEnergyPricing(pricing = {}) {
  return {
    mode: pricing?.mode || 'fixed',
    fixedGrossImportCtKwh: pricing?.fixedGrossImportCtKwh ?? null,
    dynamicComponents: clone(pricing?.dynamicComponents || {}),
    usesParagraph14aModule3: pricing?.usesParagraph14aModule3 === true,
    module3Windows: clone(pricing?.module3Windows || {}),
    costs: clone(pricing?.costs || {})
  };
}

function configuredModule3Windows(pricing = {}) {
  if (!pricing?.usesParagraph14aModule3) return [];
  return Object.entries(pricing.module3Windows || {})
    .map(([id, window]) => {
      const start = parseHHMM(window?.start);
      const end = parseHHMM(window?.end);
      const priceCtKwh = Number(window?.priceCtKwh);
      if (window?.enabled !== true || start == null || end == null || !Number.isFinite(priceCtKwh)) return null;
      return {
        id,
        label: window?.label ? String(window.label) : id,
        start,
        end,
        priceCtKwh: roundCtKwh(priceCtKwh)
      };
    })
    .filter(Boolean);
}

function computeDynamicGrossImportCtKwh(marketCtKwh, components = {}) {
  const base =
    Number(marketCtKwh || 0)
    + Number(components.energyMarkupCtKwh || 0)
    + Number(components.gridChargesCtKwh || 0)
    + Number(components.leviesAndFeesCtKwh || 0);
  return roundCtKwh(base * (1 + (Number(components.vatPct || 0) / 100)));
}

export function resolveActiveUserEnergyPricingForTimestamp(ts, pricing = {}, options = {}) {
  const timeZone = options.timeZone || BERLIN_TIME_ZONE;
  const localDate = formatLocalDate(ts, timeZone);
  if (!localDate) return null;
  const periods = Array.isArray(pricing?.periods) ? pricing.periods : [];
  const match = periods.find((period) => period?.startDate <= localDate && period?.endDate >= localDate);
  if (!match) return null;
  return deepMerge(buildEffectiveUserEnergyPricing(pricing), clone(match));
}

export function resolveUserImportPriceCtKwhForSlot(row, pricing = {}, options = {}) {
  if (!row?.ts) return null;
  const timeZone = options.timeZone || BERLIN_TIME_ZONE;
  const minuteOfDay = localMinutesOfDay(row.ts, timeZone);
  const effectivePricing = resolveActiveUserEnergyPricingForTimestamp(row.ts, pricing, options) || buildEffectiveUserEnergyPricing(pricing);

  for (const window of configuredModule3Windows(effectivePricing)) {
    if (slotMinuteMatchesWindow(minuteOfDay, window)) return window.priceCtKwh;
  }

  if (effectivePricing.mode === 'fixed') {
    if (effectivePricing.fixedGrossImportCtKwh == null || effectivePricing.fixedGrossImportCtKwh === '') return null;
    const fixed = Number(effectivePricing.fixedGrossImportCtKwh);
    return Number.isFinite(fixed) ? roundCtKwh(fixed) : null;
  }

  return computeDynamicGrossImportCtKwh(Number(row.ct_kwh || 0), effectivePricing.dynamicComponents || {});
}

export function loadConfigFile(configPath) {
  const exists = fs.existsSync(configPath);
  let parsed = {};
  let valid = true;
  let parseError = null;
  let manufacturerProfile = null;
  let manufacturerProfilePath = null;
  let manufacturerProfileError = null;

  if (exists) {
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      parsed = text.trim() ? JSON.parse(text) : {};
      if (!isPlainObject(parsed)) {
        parsed = {};
        valid = false;
        parseError = 'config root must be an object';
      }
    } catch (error) {
      parsed = {};
      valid = false;
      parseError = error.message;
    }
  }

  const normalized = normalizeConfigInput(parsed);
  const manufacturer = normalized.persistedConfig.manufacturer || 'victron';
  manufacturerProfilePath = resolveManufacturerProfilePath(configPath, manufacturer);
  let effectiveConfig = normalized.effectiveConfig;

  try {
    manufacturerProfile = loadManufacturerProfile(manufacturerProfilePath);
    effectiveConfig = applyManufacturerProfile(normalized.persistedConfig, manufacturerProfile);
  } catch (error) {
    manufacturerProfileError = error.message;
    valid = false;
    if (!parseError) parseError = `manufacturer profile error: ${error.message}`;
  }

  return {
    path: configPath,
    exists,
    valid,
    parseError,
    needsSetup: !exists || !valid,
    rawConfig: normalized.rawConfig,
    persistedConfig: normalized.persistedConfig,
    effectiveConfig,
    warnings: normalized.warnings,
    manufacturerProfile,
    manufacturerProfilePath,
    manufacturerProfileError
  };
}

// Plan 08-09 Task 1: backup-on-write retention. Keep the 10 most recent
// timestamped backups so a config-corrupting save can be reverted from disk
// without git access. 10 covers ~daily ops for ~10 days; older backups are
// pruned to keep the data dir tidy. Mirrors migration-runner.js:71-87 pattern
// established in plan 08-01 for SQL migrations (consistency for ops).
const CONFIG_BACKUP_RETENTION = 10;

export function saveConfigFile(configPath, rawInput) {
  const normalized = normalizeConfigInput(rawInput);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Plan 08-09 Task 1: backup-on-write — copy the existing config.json to a
  // timestamped sibling BEFORE we overwrite it, so a bad save can be rolled
  // back from disk. Wrapped in try/catch because backup failure (e.g. disk
  // full, permission flip) MUST NOT prevent the actual save from proceeding —
  // operator continuity beats backup completeness in this safety order.
  if (fs.existsSync(configPath)) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dir = path.dirname(configPath);
      const backupPath = path.join(dir, `config.backup-${timestamp}.json`);
      fs.copyFileSync(configPath, backupPath);
      try { fs.chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
      // Prune oldest beyond retention (sort DESC by name = lexicographic = ts).
      const backups = fs.readdirSync(dir)
        .filter((f) => /^config\.backup-/.test(f))
        .sort()
        .reverse();
      for (const old of backups.slice(CONFIG_BACKUP_RETENTION)) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { /* best-effort */ }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[config] backup-on-write failed:', err.message);
    }
  }
  // Atomic write: temp file + rename prevents corruption on crash/power loss
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(normalized.rawConfig, null, 2) + '\n', 'utf8');
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, configPath);
  return loadConfigFile(configPath);
}

export function getConfigDefinition() {
  return {
    destinations: clone(SETTINGS_DESTINATIONS),
    sections: clone(SECTIONS),
    fields: clone(FIELD_DEFINITIONS),
    setupWizard: {
      steps: clone(SETUP_WIZARD_STEPS)
    },
    restartSensitivePrefixes: clone(restartSensitivePrefixes)
  };
}

export function collectChangedPaths(previousValue, nextValue, prefix = '') {
  if (previousValue === nextValue) return [];
  const prevIsObject = isPlainObject(previousValue);
  const nextIsObject = isPlainObject(nextValue);
  if (!prevIsObject || !nextIsObject) return prefix ? [prefix] : [];

  const keys = new Set([...Object.keys(previousValue || {}), ...Object.keys(nextValue || {})]);
  const changes = [];
  for (const key of keys) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    const prev = previousValue?.[key];
    const next = nextValue?.[key];
    if (Array.isArray(prev) || Array.isArray(next)) {
      if (JSON.stringify(prev) !== JSON.stringify(next)) changes.push(nextPrefix);
      continue;
    }
    changes.push(...collectChangedPaths(prev, next, nextPrefix));
  }
  return changes;
}

export function detectRestartRequired(changedPaths) {
  const paths = Array.isArray(changedPaths) ? changedPaths : [];
  const matchingPaths = paths.filter((path) => restartSensitivePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`)));
  return {
    required: matchingPaths.length > 0,
    paths: matchingPaths
  };
}
