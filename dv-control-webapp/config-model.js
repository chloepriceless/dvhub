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
    description: 'Victron-System und Netzzaehler verständlich anbinden.',
    intro: 'Hier legst du fest, wie DVhub mit deiner Anlage spricht und wo die Kernmesswerte herkommen.'
  },
  {
    id: 'control',
    label: 'Steuerung',
    description: 'Regelung, Schreibwerte und Zeitplan-Basis für DVhub.',
    intro: 'Diese Einstellungen steuern Sollwerte, DV-Logik und die Basis des Zeitplans.'
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
    description: 'Register-nahe und technische Bereiche für Spezialfaelle.',
    intro: 'Hier liegen tiefergehende Register- und Scan-Einstellungen, die meist nur bei Sonderfaellen noetig sind.'
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
    label: 'Victron Verbindung',
    description: 'Basisverbindung zum GX-System per Modbus TCP oder MQTT.',
    destination: 'connection'
  },
  {
    id: 'meter',
    label: 'Netzzaehler',
    description: 'Register- und Verbindungsdaten für den Netzleistungsblock.',
    destination: 'connection'
  },
  {
    id: 'points',
    label: 'Lese-Register',
    description: 'Alle Lesepunkte für SOC, PV, Batterie, Setpoints und Hausverbrauch.',
    destination: 'advanced'
  },
  {
    id: 'controlWrite',
    label: 'Schreib-Register',
    description: 'Register für Grid Setpoint, Charge Current und Minimum SOC.',
    destination: 'control'
  },
  {
    id: 'dvControl',
    label: 'DV Steuerung',
    description: 'Victron-Register für DC/AC-PV-Freigabe und Negativpreis-Schutz.',
    destination: 'control'
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
    title: 'Victron Verbindung',
    description: 'Wähle den passenden Victron-Transport und zeige nur die Felder, die für Modbus oder MQTT wirklich noetig sind.'
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
  'victron.transport': {
    stepId: 'transport',
    order: 10,
    help: 'Modbus ist die direkte GX-Verbindung. MQTT eignet sich für Venus-OS-Daten mit Portal-ID.'
  },
  'victron.host': {
    stepId: 'transport',
    order: 20,
    help: 'Adresse deines GX. Bei MQTT dient sie auch als Fallback, wenn kein eigener Broker eingetragen ist.'
  },
  'victron.port': {
    stepId: 'transport',
    order: 30,
    visibleWhenTransport: ['modbus'],
    help: 'Nur für Modbus. In den meisten Installationen bleibt das 502.'
  },
  'victron.unitId': {
    stepId: 'transport',
    order: 40,
    visibleWhenTransport: ['modbus'],
    help: 'Nur für Modbus. Der GX nutzt typischerweise die Unit ID 100.'
  },
  'victron.timeoutMs': {
    stepId: 'transport',
    order: 50,
    visibleWhenTransport: ['modbus'],
    help: 'Nur für Modbus. Definiert, wie lange DVhub auf eine Register-Antwort wartet.'
  },
  'victron.mqtt.portalId': {
    stepId: 'transport',
    order: 60,
    visibleWhenTransport: ['mqtt'],
    help: 'Pflicht für Victron MQTT, damit DVhub die richtigen Venus-Topics lesen kann.'
  },
  'victron.mqtt.broker': {
    stepId: 'transport',
    order: 70,
    visibleWhenTransport: ['mqtt'],
    help: 'Optionaler eigener Broker. Leer bedeutet: DVhub nutzt den GX-Host als MQTT-Ziel.'
  },
  'victron.mqtt.keepaliveIntervalMs': {
    stepId: 'transport',
    order: 80,
    visibleWhenTransport: ['mqtt'],
    help: 'Nur für MQTT. Haelt die Verbindung aktiv, wenn laenger keine Daten eingehen.'
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
  'meter.fc': {
    stepId: 'dv',
    order: 40,
    help: 'Function Code für den Netzleistungsblock. Bei vielen Victron-Setups ist das 4.'
  },
  'meter.address': {
    stepId: 'dv',
    order: 50,
    help: 'Startadresse des Meterblocks für L1, L2 und L3.'
  },
  'meter.quantity': {
    stepId: 'dv',
    order: 60,
    help: 'Wie viele Register DVhub für den Meterblock am Stueck liest.'
  },
  'dvControl.enabled': {
    stepId: 'dv',
    order: 70,
    help: 'Aktiviert die DV-Schreiblogik, sobald später Signale oder Preise darauf reagieren.'
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
  'victron.transport',
  'victron.mqtt.broker',
  'victron.mqtt.portalId',
  'victron.mqtt.keepaliveIntervalMs',
  'victron.mqtt.qos'
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
      groupDescription: 'Zentrale Verbindung zum GX oder Venus OS.',
      path: 'victron.transport',
      label: 'Transport',
      type: 'select',
      options: [
        { value: 'modbus', label: 'Modbus TCP' },
        { value: 'mqtt', label: 'MQTT (Venus OS)' }
      ],
      help: 'Waehlt den Kommunikationsweg zum Victron-System.'
    },
    {
      section: 'victron',
      group: 'connection',
      groupLabel: 'Verbindung',
      groupDescription: 'Zentrale Verbindung zum GX oder Venus OS.',
      path: 'victron.host',
      label: 'GX Host',
      type: 'text',
      help: 'IP-Adresse oder Hostname des GX.'
    },
    {
      section: 'victron',
      group: 'connection',
      groupLabel: 'Verbindung',
      groupDescription: 'Zentrale Verbindung zum GX oder Venus OS.',
      path: 'victron.port',
      label: 'GX Port',
      type: 'number',
      min: 1,
      max: 65535,
      help: 'Standard ist 502 für Modbus TCP.'
    },
    {
      section: 'victron',
      group: 'connection',
      groupLabel: 'Verbindung',
      groupDescription: 'Zentrale Verbindung zum GX oder Venus OS.',
      path: 'victron.unitId',
      label: 'GX Unit ID',
      type: 'number',
      min: 0,
      max: 255,
      help: 'Modbus Unit ID des GX.'
    },
    {
      section: 'victron',
      group: 'connection',
      groupLabel: 'Verbindung',
      groupDescription: 'Zentrale Verbindung zum GX oder Venus OS.',
      path: 'victron.timeoutMs',
      label: 'GX Timeout (ms)',
      type: 'number',
      min: 100,
      max: 60000,
      step: 100,
      help: 'Timeout für Modbus-Requests.'
    },
    {
      section: 'victron',
      group: 'mqtt',
      groupLabel: 'MQTT',
      groupDescription: 'Nur relevant, wenn als Transport MQTT gewaehlt ist.',
      path: 'victron.mqtt.broker',
      label: 'MQTT Broker URL',
      type: 'text',
      help: 'Zum Beispiel mqtt://192.168.1.10:1883'
    },
    {
      section: 'victron',
      group: 'mqtt',
      groupLabel: 'MQTT',
      groupDescription: 'Nur relevant, wenn als Transport MQTT gewaehlt ist.',
      path: 'victron.mqtt.portalId',
      label: 'Portal ID',
      type: 'text',
      help: 'Victron Portal ID für Venus MQTT Topics.'
    },
    {
      section: 'victron',
      group: 'mqtt',
      groupLabel: 'MQTT',
      groupDescription: 'Nur relevant, wenn als Transport MQTT gewaehlt ist.',
      path: 'victron.mqtt.keepaliveIntervalMs',
      label: 'MQTT Keepalive (ms)',
      type: 'number',
      min: 1000,
      max: 600000,
      step: 1000,
      help: 'Intervall für MQTT Keepalive-Pakete.'
    },
    {
      section: 'victron',
      group: 'mqtt',
      groupLabel: 'MQTT',
      groupDescription: 'Nur relevant, wenn als Transport MQTT gewaehlt ist.',
      path: 'victron.mqtt.qos',
      label: 'MQTT QoS',
      type: 'select',
      options: [
        { value: 0, label: '0 - At most once' },
        { value: 1, label: '1 - At least once' },
        { value: 2, label: '2 - Exactly once' }
      ],
      help: 'QoS für MQTT Subscribe/Publish.'
    },

    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock für L1/L2/L3.',
      path: 'meter.fc',
      label: 'Function Code',
      type: 'select',
      options: [
        { value: 3, label: '3 - Holding Register' },
        { value: 4, label: '4 - Input Register' }
      ],
      help: 'Typischerweise 4 für Input Register.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock für L1/L2/L3.',
      path: 'meter.address',
      label: 'Startadresse',
      type: 'number',
      min: 0,
      max: 65535,
      help: 'Erstes Register des Netzleistungsblocks.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock für L1/L2/L3.',
      path: 'meter.quantity',
      label: 'Anzahl Register',
      type: 'number',
      min: 1,
      max: 125,
      help: 'Typischerweise 3 Register für L1/L2/L3.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock für L1/L2/L3.',
      path: 'meter.timeoutMs',
      label: 'Timeout (ms)',
      type: 'number',
      min: 100,
      max: 60000,
      step: 100,
      empty: 'delete',
      help: 'Leer lassen für Victron-Timeout.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock für L1/L2/L3.',
      path: 'meter.host',
      label: 'Host Override',
      type: 'text',
      empty: 'delete',
      help: 'Leer lassen, um den Victron-Host zu verwenden.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock für L1/L2/L3.',
      path: 'meter.port',
      label: 'Port Override',
      type: 'number',
      min: 1,
      max: 65535,
      empty: 'delete',
      help: 'Leer lassen, um den Victron-Port zu verwenden.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock für L1/L2/L3.',
      path: 'meter.unitId',
      label: 'Unit ID Override',
      type: 'number',
      min: 0,
      max: 255,
      empty: 'delete',
      help: 'Leer lassen, um die Victron Unit ID zu verwenden.'
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

  for (const [key, meta] of Object.entries(POINT_META)) {
    fields.push(...buildRegisterFieldGroup('points', key, 'points', meta, {
      includeSumRegisters: key === 'selfConsumptionW'
    }));
  }

  for (const [key, meta] of Object.entries(CONTROL_WRITE_META)) {
    fields.push(...buildRegisterFieldGroup('controlWrite', key, 'controlWrite', meta, {
      includeWriteType: true,
      allowAddressZero: key === 'gridSetpointW'
    }));
  }

  for (const [key, meta] of Object.entries(DV_CONTROL_META)) {
    fields.push(...buildRegisterFieldGroup('dvControl', key, 'dvControl', meta, {
      includeWriteType: true
    }));
  }

  fields.push(
    {
      section: 'dvControl',
      group: 'safety',
      groupLabel: 'Negativpreis-Schutz',
      groupDescription: 'Automatische Schutzlogik bei negativen Preisen.',
      path: 'dvControl.enabled',
      label: 'DV Control aktiv',
      type: 'boolean',
      help: 'Aktiviert die automatische Umschaltung für DV-Signale.'
    },
    {
      section: 'dvControl',
      group: 'safety',
      groupLabel: 'Negativpreis-Schutz',
      groupDescription: 'Automatische Schutzlogik bei negativen Preisen.',
      path: 'dvControl.negativePriceProtection.enabled',
      label: 'Negativpreis-Schutz aktiv',
      type: 'boolean',
      help: 'Aktiviert die Schutzlogik bei negativen Preisen.'
    },
    {
      section: 'dvControl',
      group: 'safety',
      groupLabel: 'Negativpreis-Schutz',
      groupDescription: 'Automatische Schutzlogik bei negativen Preisen.',
      path: 'dvControl.negativePriceProtection.gridSetpointW',
      label: 'Negativpreis Grid Setpoint (W)',
      type: 'number',
      help: 'Setpoint, der bei negativen Preisen geschrieben wird.'
    }
  );

  return addSetupWizardMetadata(fields.filter((entry) => entry.path));
}

const FIELD_DEFINITIONS = buildFieldDefinitions();

export function createDefaultConfig() {
  return {
    httpPort: 8080,
    apiToken: '',
    modbusListenHost: '0.0.0.0',
    modbusListenPort: 1502,
    offLeaseMs: 8 * 60 * 1000,
    meterPollMs: 2000,
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
      enabled: false,
      feedExcessDcPv: { enabled: true, fc: 6, address: 2848, writeType: 'uint16', signed: false, scale: 1, offset: 0, wordOrder: 'be' },
      dontFeedExcessAcPv: { enabled: true, fc: 6, address: 2850, writeType: 'uint16', signed: false, scale: 1, offset: 0, wordOrder: 'be' },
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
    if (item.enabled != null) next.enabled = coerceBoolean(item.enabled);
    if (next.value != null && !Number.isFinite(next.value)) {
      warnings.push(`schedule.rules.${next.id || rules.length}: value ignored because it is not numeric`);
      continue;
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

  if (isPlainObject(next.dynamicComponents)) {
    for (const key of ['energyMarkupCtKwh', 'gridChargesCtKwh', 'leviesAndFeesCtKwh', 'vatPct']) {
      if (next.dynamicComponents[key] == null || next.dynamicComponents[key] === '') continue;
      next.dynamicComponents[key] = Number(next.dynamicComponents[key]);
      if (!Number.isFinite(next.dynamicComponents[key])) {
        warnings.push(`userEnergyPricing.dynamicComponents.${key}: invalid number, field was reset`);
        delete next.dynamicComponents[key];
      }
    }
  }

  next.module3Windows = sanitizeUserEnergyPricingWindows(next.module3Windows, warnings);

  if (isPlainObject(next.costs)) {
    for (const key of ['pvCtKwh', 'batteryBaseCtKwh', 'batteryLossMarkupPct']) {
      if (next.costs[key] == null || next.costs[key] === '') continue;
      next.costs[key] = Number(next.costs[key]);
      if (!Number.isFinite(next.costs[key])) {
        warnings.push(`userEnergyPricing.costs.${key}: invalid number, field was reset`);
        delete next.costs[key];
      }
    }
  }

  return next;
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
      if (Number.isFinite(num)) setPath(raw, field.path, num);
      else {
        warnings.push(`${field.path}: invalid number, field was reset to default`);
        deletePath(raw, field.path);
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

    setPath(raw, field.path, currentValue == null ? '' : String(currentValue));
  }

  raw.schedule = raw.schedule || {};
  raw.schedule.rules = sanitizeScheduleRules(raw.schedule.rules, warnings);
  if (hasPath(raw, 'userEnergyPricing')) {
    raw.userEnergyPricing = sanitizeUserEnergyPricing(raw.userEnergyPricing, warnings);
  }
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

export function loadConfigFile(configPath) {
  const exists = fs.existsSync(configPath);
  let parsed = {};
  let valid = true;
  let parseError = null;

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
  return {
    path: configPath,
    exists,
    valid,
    parseError,
    needsSetup: !exists || !valid,
    rawConfig: normalized.rawConfig,
    persistedConfig: normalized.persistedConfig,
    effectiveConfig: normalized.effectiveConfig,
    warnings: normalized.warnings
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
