import fs from 'node:fs';
import path from 'node:path';
import { toFiniteNumber } from './util.js';

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
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'apiToken',
      label: 'API Token',
      type: 'text',
      empty: 'blank',
      help: 'Optionaler Bearer-Token für alle API-Endpunkte.'
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
      help: 'Bis zu dieser Uhrzeit muss der Akku den Ziel-SOC erreicht haben (f\u00fcr Abend-Einspeisung). 2 Stunden vorher wird der PV-Export ggf. deaktiviert. Standard: 17 Uhr.'
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
      help: 'Wie lange ein manueller Override gilt (ms).'
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
      groupLabel: 'PV-Anlagen für Marktprämie',
      groupDescription: 'Mehrere PV-Anlagen mit Inbetriebnahme und Leistung für den gewichteten anzulegenden Wert.',
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
      options: [
        { value: 'https://api.dvhub.de', label: 'DVhub API (api.dvhub.de)' },
        { value: 'https://api.awattar.com', label: 'Fallback (aWATTar)' }
      ],
      help: 'DVhub Price API Endpunkt. Standard: https://api.dvhub.de'
    }
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
    modbusListenHost: '0.0.0.0',
    modbusListenPort: 1502,
    offLeaseMs: 8 * 60 * 1000,
    meterPollMs: 2000,
    keepalivePulseSec: 60,
    gridPositiveMeans: 'feed_in',
    pvCoupling: 'ac_dc',
    monitoring: {
      pushUrl: '',
      pushIntervalSec: 240
    },
    dcExportMode: {
      enabled: false,
      bufferW: 100,
      priceThresholdCtKwh: null,
      targetSocPct: 90,
      chargeDeadlineHour: 17
    },
    victron: {
      transport: 'modbus',
      host: '192.168.20.19',
      port: 502,
      unitId: 100,
      timeoutMs: 1000,
      mqtt: {
        broker: 'mqtt://192.168.20.19:1883',
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
      gridSetpointW: { enabled: true, fc: 4, address: 2700, quantity: 1, signed: true, scale: 1, offset: 0 },
      minSocPct: { enabled: true, fc: 4, address: 2901, quantity: 1, signed: false, scale: 0.1, offset: 0 },
      selfConsumptionW: { enabled: true, fc: 4, address: 817, quantity: 3, signed: false, scale: 1, offset: 0, sumRegisters: true }
    },
    controlWrite: {
      gridSetpointW: { enabled: true, fc: 6, address: 2700, writeType: 'int16', signed: true, scale: 1, offset: 0, wordOrder: 'be' },
      chargeCurrentA: { enabled: true, fc: 6, address: 2705, writeType: 'int16', signed: true, scale: 1, offset: 0, wordOrder: 'be' },
      minSocPct: { enabled: true, fc: 6, address: 2901, writeType: 'uint16', signed: false, scale: 0.1, offset: 0, wordOrder: 'be' }
    },
    dvControl: {
      enabled: true,
      feedExcessDcPv: { enabled: true, fc: 6, address: 2707, writeType: 'uint16', signed: false, scale: 1, offset: 0, wordOrder: 'be' },
      dontFeedExcessAcPv: { enabled: true, fc: 6, address: 2708, writeType: 'uint16', signed: false, scale: 1, offset: 0, wordOrder: 'be' },
      negativePriceProtection: { enabled: true, gridSetpointW: -40 }
    },
    schedule: {
      timezone: 'Europe/Berlin',
      evaluateMs: 15000,
      defaultGridSetpointW: -40,
      defaultChargeCurrentA: null,
      defaultFeedExcessDcPv: 1,
      rules: [],
      smallMarketAutomation: {
      engine: 'milp',
        enabled: false,
        searchWindowStart: '14:00',
        searchWindowEnd: '09:00',
        targetSlotCount: null,
        maxDischargeW: -12000,
        batteryCapacityKwh: 30,
        inverterEfficiencyPct: 85,
        minSocPct: 30,
        aggressivePremiumPct: 20,
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
      host: '192.168.20.19',
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
    epex: {
      enabled: true,
      bzn: 'DE-LU',
      timezone: 'Europe/Berlin',
      priceApiUrl: 'https://api.dvhub.de'
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

      return {
        kwp: roundCtKwh(kwp),
        commissionedAt
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
  for (const field of FIELD_DEFINITIONS) {
    if (!hasPath(raw, field.path)) continue;
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

export function normalizeConfigInput(rawInput) {
  const defaults = createDefaultConfig();
  const { raw, warnings } = sanitizeRawConfig(rawInput);
  const persistedConfig = deepMerge(defaults, raw);
  if (!Array.isArray(persistedConfig.schedule?.rules)) persistedConfig.schedule.rules = [];
  // Default BZN to DE-LU when EPEX is enabled but no zone is set
  if (persistedConfig.epex?.enabled && !persistedConfig.epex?.bzn) persistedConfig.epex.bzn = 'DE-LU';
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

export function saveConfigFile(configPath, rawInput) {
  const normalized = normalizeConfigInput(rawInput);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
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
