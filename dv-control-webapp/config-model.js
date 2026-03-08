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
  selfConsumptionW: { label: 'Self Consumption', description: 'Summiert den Hausverbrauch ueber mehrere Register.' }
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
    id: 'basics',
    label: 'Grundsystem',
    description: 'Die wichtigsten Laufzeit- und Zugriffsoptionen fuer PlexLite.',
    intro: 'Hier richtest du die Grundfunktionen, Netzwerkbasis und das Verhalten der App ein.'
  },
  {
    id: 'connection',
    label: 'Verbindung zur Anlage',
    description: 'Alles fuer die Verbindung zu Victron-System und Netzzaehler.',
    intro: 'Waehle hier, wie PlexLite mit deiner Anlage spricht und wo Messwerte herkommen.'
  },
  {
    id: 'control',
    label: 'Direktvermarktung',
    description: 'Steuerlogik und Schreibwerte fuer die aktive Regelung.',
    intro: 'Diese Einstellungen bestimmen, wie PlexLite Sollwerte schreibt und DV-Logik anwendet.'
  },
  {
    id: 'schedule',
    label: 'Zeitplan',
    description: 'Globale Regeln und Standardwerte fuer die zeitgesteuerte Steuerung.',
    intro: 'Passe hier an, wie der Zeitplan bewertet wird und welche Standardwerte gelten.'
  },
  {
    id: 'services',
    label: 'Preise & Dienste',
    description: 'Optionale Preis- und Datendienste fuer Monitoring und Day-Ahead-Daten.',
    intro: 'Verbinde optionale Dienste, damit Preise und Verlaufsdaten sauber eingebunden werden.'
  },
  {
    id: 'advanced',
    label: 'Erweitert',
    description: 'Register-nahe und technische Bereiche fuer Spezialfaelle.',
    intro: 'Hier liegen tiefergehende Register- und Scan-Einstellungen, die meist nur bei Sonderfaellen noetig sind.'
  }
];

const SECTIONS = [
  {
    id: 'system',
    label: 'System',
    description: 'Allgemeine Laufzeit- und Webserver-Einstellungen.',
    destination: 'basics'
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
    description: 'Register- und Verbindungsdaten fuer den Netzleistungsblock.',
    destination: 'connection'
  },
  {
    id: 'points',
    label: 'Lese-Register',
    description: 'Alle Lesepunkte fuer SOC, PV, Batterie, Setpoints und Hausverbrauch.',
    destination: 'advanced'
  },
  {
    id: 'controlWrite',
    label: 'Schreib-Register',
    description: 'Register fuer Grid Setpoint, Charge Current und Minimum SOC.',
    destination: 'control'
  },
  {
    id: 'dvControl',
    label: 'DV Steuerung',
    description: 'Victron-Register fuer DC/AC-PV-Freigabe und Negativpreis-Schutz.',
    destination: 'control'
  },
  {
    id: 'schedule',
    label: 'Zeitplan',
    description: 'Globale Parameter fuer Zeitplan und Default-Werte. Die Regeln selbst bleiben im Dashboard editierbar.',
    destination: 'schedule'
  },
  {
    id: 'scan',
    label: 'Scan Tool',
    description: 'Voreinstellungen fuer den Modbus-Scanner.',
    destination: 'advanced'
  },
  {
    id: 'influx',
    label: 'InfluxDB',
    description: 'Optionale Speicherung der Messdaten in InfluxDB.',
    destination: 'services'
  },
  {
    id: 'epex',
    label: 'EPEX',
    description: 'Boersenpreis-Abruf fuer Day-Ahead-Preise.',
    destination: 'services'
  }
];

const restartSensitivePrefixes = [
  'httpPort',
  'modbusListenHost',
  'modbusListenPort',
  'meterPollMs',
  'schedule.evaluateMs',
  'victron.transport',
  'victron.mqtt.broker',
  'victron.mqtt.portalId',
  'victron.mqtt.keepaliveIntervalMs',
  'victron.mqtt.qos'
];

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
      help: 'Modbus Function Code fuer diesen Eintrag.'
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
        help: 'Datentyp fuer Schreibzugriffe.'
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
        help: 'Nur relevant fuer 32-Bit-Werte.'
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
      help: 'Sicherheitsfreigabe fuer Adresse 0 bei Schreibzugriffen.'
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
      help: 'Optionaler Bearer-Token fuer alle API-Endpunkte.'
    },
    {
      section: 'system',
      group: 'general',
      groupLabel: 'Grundsystem',
      groupDescription: 'Webserver, Modbus-Proxy und globale Laufzeit.',
      path: 'modbusListenHost',
      label: 'Modbus Listen Host',
      type: 'text',
      help: 'IP oder Interface fuer den Modbus-Server.'
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
      help: 'Port, auf dem PlexLite als Modbus-Proxy lauscht.'
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
      help: 'Intervall fuer den Uptime-/Heartbeat-Endpunkt.'
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
      help: 'Standard ist 502 fuer Modbus TCP.'
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
      help: 'Timeout fuer Modbus-Requests.'
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
      help: 'Victron Portal ID fuer Venus MQTT Topics.'
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
      help: 'Intervall fuer MQTT Keepalive-Pakete.'
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
      help: 'QoS fuer MQTT Subscribe/Publish.'
    },

    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock fuer L1/L2/L3.',
      path: 'meter.fc',
      label: 'Function Code',
      type: 'select',
      options: [
        { value: 3, label: '3 - Holding Register' },
        { value: 4, label: '4 - Input Register' }
      ],
      help: 'Typischerweise 4 fuer Input Register.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock fuer L1/L2/L3.',
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
      groupDescription: 'Netzleistungsblock fuer L1/L2/L3.',
      path: 'meter.quantity',
      label: 'Anzahl Register',
      type: 'number',
      min: 1,
      max: 125,
      help: 'Typischerweise 3 Register fuer L1/L2/L3.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock fuer L1/L2/L3.',
      path: 'meter.timeoutMs',
      label: 'Timeout (ms)',
      type: 'number',
      min: 100,
      max: 60000,
      step: 100,
      empty: 'delete',
      help: 'Leer lassen fuer Victron-Timeout.'
    },
    {
      section: 'meter',
      group: 'main',
      groupLabel: 'Hauptmeter',
      groupDescription: 'Netzleistungsblock fuer L1/L2/L3.',
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
      groupDescription: 'Netzleistungsblock fuer L1/L2/L3.',
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
      groupDescription: 'Netzleistungsblock fuer L1/L2/L3.',
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
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
      path: 'scan.host',
      label: 'Scan Host',
      type: 'text',
      help: 'Host fuer das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
      path: 'scan.port',
      label: 'Scan Port',
      type: 'number',
      min: 1,
      max: 65535,
      help: 'Port fuer das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
      path: 'scan.unitId',
      label: 'Scan Unit ID',
      type: 'number',
      min: 0,
      max: 255,
      help: 'Unit ID fuer das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
      path: 'scan.fc',
      label: 'Scan Function Code',
      type: 'select',
      options: [
        { value: 3, label: '3 - Holding Register' },
        { value: 4, label: '4 - Input Register' }
      ],
      help: 'Function Code fuer das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
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
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
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
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
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
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
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
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
      path: 'scan.timeoutMs',
      label: 'Timeout (ms)',
      type: 'number',
      min: 100,
      max: 60000,
      step: 100,
      help: 'Timeout fuer das Scan-Tool.'
    },
    {
      section: 'scan',
      group: 'scan',
      groupLabel: 'Scan Default',
      groupDescription: 'Voreinstellungen fuer die Diagnose-Seite.',
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
      help: 'DB-Name fuer Influx v3 oder Fallback fuer v2.'
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
      help: 'Nur fuer Influx v2 relevant.'
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
      help: 'Nur fuer Influx v2 relevant.'
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
      help: 'Measurement-Name fuer alle Messreihen.'
    },

    {
      section: 'epex',
      group: 'market',
      groupLabel: 'EPEX',
      groupDescription: 'Day-Ahead-Preisfeed fuer Preise, Prognosen und Negativpreis-Logik.',
      path: 'epex.enabled',
      label: 'EPEX aktiv',
      type: 'boolean',
      help: 'Aktiviert den Abruf von Boersenpreisen.'
    },
    {
      section: 'epex',
      group: 'market',
      groupLabel: 'EPEX',
      groupDescription: 'Day-Ahead-Preisfeed fuer Preise, Prognosen und Negativpreis-Logik.',
      path: 'epex.bzn',
      label: 'BZN',
      type: 'text',
      help: 'Beispiel: DE-LU'
    },
    {
      section: 'epex',
      group: 'market',
      groupLabel: 'EPEX',
      groupDescription: 'Day-Ahead-Preisfeed fuer Preise, Prognosen und Negativpreis-Logik.',
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
      help: 'Aktiviert die automatische Umschaltung fuer DV-Signale.'
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

  return fields.filter((entry) => entry.path);
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
      host: '192.168.1.19',
      port: 502,
      unitId: 100,
      timeoutMs: 1000,
      mqtt: {
        broker: 'mqtt://192.168.1.19:1883',
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
    scan: {
      host: '192.168.1.19',
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
    const next = { ...item };
    if (next.id != null) next.id = String(next.id);
    if (next.target != null) next.target = String(next.target);
    if (next.start != null) next.start = String(next.start);
    if (next.end != null) next.end = String(next.end);
    if (next.value != null) next.value = Number(next.value);
    if (next.enabled != null) next.enabled = coerceBoolean(next.enabled);
    if (next.oneTime != null) next.oneTime = coerceBoolean(next.oneTime);
    if (Array.isArray(next.days)) next.days = next.days.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 6);
    if (next.value != null && !Number.isFinite(next.value)) {
      warnings.push(`schedule.rules.${next.id || rules.length}: value ignored because it is not numeric`);
      continue;
    }
    rules.push(next);
  }
  return rules;
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
