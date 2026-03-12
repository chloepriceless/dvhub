import fs from 'node:fs';
import path from 'node:path';

const POINT_META = {
  soc: { label: 'Battery SOC', description: 'Liest den Ladezustand der Batterie.' },
  batteryPowerW: { label: 'Battery Power', description: 'Liest Lade- oder Entladeleistung der Batterie.' },
  pvPowerW: { label: 'DC PV Power', description: 'Liest die DC-PV-Leistung.' },
  acPvL1W: { label: 'AC PV L1', description: 'Liest AC-PV auf Phase L1.' },
  acPvL2W: { label: 'AC PV L2', description: 'Liest AC-PV auf Phase L2.' },
  acPvL3W: { label: 'AC PV L3', description: 'Liest AC-PV auf Phase L3.' },
  gridSetpointW: { label: 'Grid Setpoint Readback', description: 'Liest den aktuellen Netz-Sollwert aus dem GX.' },
  minSocPct: { label: 'Minimum SOC Readback', description: 'Liest den Minimum-SOC als Rueckmeldung.' },
  selfConsumptionW: { label: 'Self Consumption', description: 'Summiert den Hausverbrauch über mehrere Register.' }
};

const CONTROL_WRITE_META = {
  gridSetpointW: { label: 'Grid Setpoint Write', description: 'Schreibt den Netz-Sollwert.' },
  chargeCurrentA: { label: 'Charge Current Write', description: 'Schreibt den maximalen Ladestrom.' },
  minSocPct: { label: 'Minimum SOC Write', description: 'Schreibt den Minimum-SOC.' }
};

const DV_CONTROL_META = {
  feedExcessDcPv: { label: 'DC PV Feed-In Flag', description: 'Steuert, ob DC-PV eingespeist werden darf.' },
  dontFeedExcessAcPv: { label: 'AC PV Block Flag', description: 'Steuert, ob AC-PV-Einspeisung blockiert wird.' }
};

const BERLIN_TIME_ZONE = 'Europe/Berlin';
const SUPPORTED_MANUFACTURERS = ['victron'];
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
    id: 'influx',
    label: 'InfluxDB',
    description: 'Optionale Speicherung der Messdaten in InfluxDB.',
    destination: 'services'
  },
  {
    id: 'telemetry',
    label: 'Telemetrie & Historie',
    description: 'Interne Datenbank fuer Live-Historie, Rollups und Backfill.',
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
  'influx.enabled': {
    stepId: 'services',
    order: 40,
    help: 'Aktiviere Influx nur, wenn du Messwerte langfristig extern speichern willst.'
  },
  'influx.url': {
    stepId: 'services',
    order: 50,
    visibleWhenPath: { path: 'influx.enabled', equals: true },
    help: 'Adresse deines Influx-Servers oder Containers.'
  },
  'influx.db': {
    stepId: 'services',
    order: 60,
    visibleWhenPath: { path: 'influx.enabled', equals: true },
    help: 'Name der Datenbank oder des Zielbereichs für den Influx-Export.'
  }
};

const restartSensitivePrefixes = [
  'httpPort',
  'modbusListenHost',
  'modbusListenPort',
  'meterPollMs',
  'telemetry.enabled',
  'telemetry.dbPath',
  'telemetry.rawRetentionDays',
  'telemetry.historyImport.enabled',
  'telemetry.historyImport.provider',
  'schedule.evaluateMs',
  'manufacturer',
  'victron.host'
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

export function deepMerge(base, override) {
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
  return String(path).split('.').filter(Boolean);
}

export function hasPath(obj, path) {
  let cur = obj;
  for (const part of getPathParts(path)) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return false;
    if (!(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

export function getPath(obj, path, fallback = undefined) {
  let cur = obj;
  for (const part of getPathParts(path)) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return fallback;
    if (!(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj, path, value) {
  const parts = getPathParts(path);
  let cur = obj;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[0]] = value;
}

export function deletePath(obj, path) {
  const parts = getPathParts(path);
  let cur = obj;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!isPlainObject(cur[part])) return;
    cur = cur[part];
  }
  delete cur[parts[0]];
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

function buildRegisterFieldGroup(sectionId, groupId, prefix, meta, options = {}) {
  const basePath = `${prefix}.${groupId}`;
  const groupLabel = meta.label;
  const description = meta.description;
  const fields = [
    {
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.enabled`,
      label: 'Aktiv',
      type: 'boolean',
      help: 'Schaltet diesen Punkt oder dieses Register ein bzw. aus.'
    },
    {
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.fc`,
      label: 'Function Code',
      type: 'select',
      options: [
        { value: 3, label: '3 - Holding Register' },
        { value: 4, label: '4 - Input Register' },
        { value: 6, label: '6 - Write Single' },
        { value: 16, label: '16 - Write Multiple' }
      ],
      help: 'Modbus Function Code für diesen Eintrag.'
    },
    {
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.address`,
      label: 'Startadresse',
      type: 'number',
      min: 0,
      max: 65535,
      help: 'Modbus Registeradresse.'
    },
    {
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.quantity`,
      label: 'Anzahl Register',
      type: 'number',
      min: 1,
      max: 125,
      help: 'Wie viele Register gelesen oder geschrieben werden.'
    },
    {
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.signed`,
      label: 'Vorzeichenbehaftet',
      type: 'boolean',
      help: 'Aktivieren, wenn der Wert als signed interpretiert werden soll.'
    },
    {
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.scale`,
      label: 'Skalierung',
      type: 'number',
      step: 0.001,
      help: 'Multiplikator zur Umrechnung in Engineering-Einheiten.'
    },
    {
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.offset`,
      label: 'Offset',
      type: 'number',
      step: 0.001,
      help: 'Additiver Offset nach der Skalierung.'
    }
  ];

  if (options.includeWriteType) {
    fields.push(
      {
        section: sectionId,
        group: groupId,
        groupLabel,
        groupDescription: description,
        path: `${basePath}.writeType`,
        label: 'Write Type',
        type: 'select',
        options: [
          { value: 'int16', label: 'int16' },
          { value: 'uint16', label: 'uint16' },
          { value: 'int32', label: 'int32' },
          { value: 'uint32', label: 'uint32' }
        ],
        help: 'Datentyp für Schreibzugriffe.'
      },
      {
        section: sectionId,
        group: groupId,
        groupLabel,
        groupDescription: description,
        path: `${basePath}.wordOrder`,
        label: 'Word Order',
        type: 'select',
        options: [
          { value: 'be', label: 'Big Endian (Standard)' },
          { value: 'le', label: 'Little Endian / Swapped' }
        ],
        help: 'Nur relevant für 32-Bit-Werte.'
      }
    );
  }

  if (options.includeSumRegisters) {
    fields.push({
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.sumRegisters`,
      label: 'Register summieren',
      type: 'boolean',
      help: 'Addiert mehrere Register zu einem Gesamtwert.'
    });
  }

  if (options.allowAddressZero) {
    fields.push({
      section: sectionId,
      group: groupId,
      groupLabel,
      groupDescription: description,
      path: `${basePath}.allowAddressZero`,
      label: 'Adresse 0 zulassen',
      type: 'boolean',
      help: 'Sicherheitsfreigabe für Adresse 0 bei Schreibzugriffen.'
    });
  }

  if (options.includeTransportOverride !== false) {
    fields.push(
      {
        section: sectionId,
        group: groupId,
        groupLabel,
        groupDescription: description,
        path: `${basePath}.host`,
        label: 'Host Override',
        type: 'text',
        empty: 'delete',
        help: 'Leer lassen, um den Victron-Host zu verwenden.'
      },
      {
        section: sectionId,
        group: groupId,
        groupLabel,
        groupDescription: description,
        path: `${basePath}.port`,
        label: 'Port Override',
        type: 'number',
        min: 1,
        max: 65535,
        empty: 'delete',
        help: 'Leer lassen, um den Victron-Port zu verwenden.'
      },
      {
        section: sectionId,
        group: groupId,
        groupLabel,
        groupDescription: description,
        path: `${basePath}.unitId`,
        label: 'Unit ID Override',
        type: 'number',
        min: 0,
        max: 255,
        empty: 'delete',
        help: 'Leer lassen, um die Victron Unit ID zu verwenden.'
      },
      {
        section: sectionId,
        group: groupId,
        groupLabel,
        groupDescription: description,
        path: `${basePath}.timeoutMs`,
        label: 'Timeout Override (ms)',
        type: 'number',
        min: 100,
        max: 60000,
        step: 100,
        empty: 'delete',
        help: 'Leer lassen, um den Victron Timeout zu verwenden.'
      }
    );
  }

  return fields;
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
      help: 'Abstand zwischen den Live-Abfragen an das GX.'
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
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'Automatische lokale Historie fuer Telemetrie, Preise und Optimierer.',
      path: 'telemetry.enabled',
      label: 'Interne Historie aktiv',
      type: 'boolean',
      help: 'Schreibt Livewerte, Preise, Steuerereignisse und Optimierergebnisse lokal in eine eingebaute Datenbank.'
    },
    {
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'Automatische lokale Historie fuer Telemetrie, Preise und Optimierer.',
      path: 'telemetry.dbPath',
      label: 'DB Pfad',
      type: 'text',
      empty: 'blank',
      help: 'Optionaler Override. Leer bedeutet: Standardpfad im DVhub-Datenverzeichnis.'
    },
    {
      section: 'telemetry',
      group: 'database',
      groupLabel: 'Interne Datenbank',
      groupDescription: 'Automatische lokale Historie fuer Telemetrie, Preise und Optimierer.',
      path: 'telemetry.rawRetentionDays',
      label: 'Raw Retention (Tage)',
      type: 'number',
      min: 1,
      max: 3650,
      help: 'Wie lange Rohdaten mit hoher Aufloesung aufbewahrt werden.'
    },
    {
      section: 'telemetry',
      group: 'historyImport',
      groupLabel: 'History Import',
      groupDescription: 'Optionale Nachfuellung aus VRM fuer Historie und Datenluecken.',
      path: 'telemetry.historyImport.enabled',
      label: 'History Import aktiv',
      type: 'boolean',
      help: 'Aktiviert den optionalen VRM-Import fuer bestehende Historie und Gap-Fill.'
    },
    {
      section: 'telemetry',
      group: 'historyImport',
      groupLabel: 'History Import',
      groupDescription: 'Optionale Nachfuellung aus VRM fuer Historie und Datenluecken.',
      path: 'telemetry.historyImport.provider',
      label: 'Import Quelle',
      type: 'select',
      options: [
        { value: 'vrm', label: 'VRM' }
      ],
      help: 'Historischer Nachimport wird bewusst nur ueber VRM unterstuetzt.'
    },
    {
      section: 'telemetry',
      group: 'historyImport',
      groupLabel: 'History Import',
      groupDescription: 'Optionale Nachfuellung aus VRM fuer Historie und Datenluecken.',
      path: 'telemetry.historyImport.vrmPortalId',
      label: 'VRM Portal ID',
      type: 'text',
      empty: 'blank',
      help: 'Optional. Wird fuer spaeteren VRM-Historienimport genutzt.'
    },
    {
      section: 'telemetry',
      group: 'historyImport',
      groupLabel: 'History Import',
      groupDescription: 'Optionale Nachfuellung aus VRM fuer Historie und Datenluecken.',
      path: 'telemetry.historyImport.vrmToken',
      label: 'VRM Token',
      type: 'text',
      empty: 'blank',
      help: 'Optionaler API-Token fuer spaeteren VRM-Backfill.'
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
      section: 'influx',
      group: 'connection',
      groupLabel: 'Influx',
      groupDescription: 'Optionale Speicherung in InfluxDB.',
      path: 'influx.enabled',
      label: 'Influx aktiv',
      type: 'boolean',
      help: 'Aktiviert den Export nach InfluxDB.'
    },
    {
      section: 'influx',
      group: 'connection',
      groupLabel: 'Influx',
      groupDescription: 'Optionale Speicherung in InfluxDB.',
      path: 'influx.apiVersion',
      label: 'Influx API Version',
      type: 'select',
      options: [
        { value: 'v3', label: 'v3' },
        { value: 'v2', label: 'v2' }
      ],
      help: 'Legt den Write-Endpunkt fest.'
    },
    {
      section: 'influx',
      group: 'connection',
      groupLabel: 'Influx',
      groupDescription: 'Optionale Speicherung in InfluxDB.',
      path: 'influx.url',
      label: 'Influx URL',
      type: 'text',
      help: 'Zum Beispiel http://127.0.0.1:8086'
    },
    {
      section: 'influx',
      group: 'connection',
      groupLabel: 'Influx',
      groupDescription: 'Optionale Speicherung in InfluxDB.',
      path: 'influx.db',
      label: 'Database / DB',
      type: 'text',
      help: 'DB-Name für Influx v3 oder Fallback für v2.'
    },
    {
      section: 'influx',
      group: 'connection',
      groupLabel: 'Influx',
      groupDescription: 'Optionale Speicherung in InfluxDB.',
      path: 'influx.org',
      label: 'Organisation',
      type: 'text',
      empty: 'blank',
      help: 'Nur für Influx v2 relevant.'
    },
    {
      section: 'influx',
      group: 'connection',
      groupLabel: 'Influx',
      groupDescription: 'Optionale Speicherung in InfluxDB.',
      path: 'influx.bucket',
      label: 'Bucket',
      type: 'text',
      empty: 'blank',
      help: 'Nur für Influx v2 relevant.'
    },
    {
      section: 'influx',
      group: 'connection',
      groupLabel: 'Influx',
      groupDescription: 'Optionale Speicherung in InfluxDB.',
      path: 'influx.token',
      label: 'Influx Token',
      type: 'text',
      empty: 'blank',
      help: 'Optionaler Auth-Token.'
    },
    {
      section: 'influx',
      group: 'connection',
      groupLabel: 'Influx',
      groupDescription: 'Optionale Speicherung in InfluxDB.',
      path: 'influx.measurement',
      label: 'Measurement',
      type: 'text',
      help: 'Measurement-Name für alle Messreihen.'
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
      label: 'BZN',
      type: 'text',
      help: 'Beispiel: DE-LU'
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
    }
  ];

  return addSetupWizardMetadata(fields.filter((entry) => entry.path));
}

const FIELD_DEFINITIONS = buildFieldDefinitions();

export function createDefaultConfig() {
  return {
    manufacturer: 'victron',
    httpPort: 8080,
    apiToken: '',
    modbusListenHost: '0.0.0.0',
    modbusListenPort: 1502,
    offLeaseMs: 8 * 60 * 1000,
    meterPollMs: 5000,
    keepalivePulseSec: 60,
    gridPositiveMeans: 'feed_in',
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
      defaultGridSetpointW: null,
      defaultChargeCurrentA: null,
      rules: []
    },
    userEnergyPricing: {
      mode: 'fixed',
      fixedGrossImportCtKwh: null,
      periods: [],
      marketValueMode: 'annual',
      pvPlants: [],
      dynamicComponents: {
        energyMarkupCtKwh: 0,
        gridChargesCtKwh: 0,
        leviesAndFeesCtKwh: 0,
        vatPct: 19
      },
      usesParagraph14aModule3: false,
      module3Windows: {
        window1: { enabled: false, label: '', start: '', end: '', priceCtKwh: null },
        window2: { enabled: false, label: '', start: '', end: '', priceCtKwh: null },
        window3: { enabled: false, label: '', start: '', end: '', priceCtKwh: null }
      },
      costs: {
        pvCtKwh: null,
        batteryBaseCtKwh: null,
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
    influx: {
      enabled: false,
      apiVersion: 'v3',
      url: 'http://127.0.0.1:8086',
      db: '',
      org: '',
      bucket: '',
      token: '',
      measurement: 'dv'
    },
    telemetry: {
      enabled: true,
      dbPath: '',
      rawRetentionDays: 45,
      rollupIntervals: [300, 900, 3600],
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
      timezone: 'Europe/Berlin'
    }
  };
}

export function applyVictronDefaults(config) {
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
  fs.writeFileSync(configPath, JSON.stringify(normalized.rawConfig, null, 2) + '\n', 'utf8');
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
