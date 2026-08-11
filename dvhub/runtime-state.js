const METER_FIELDS = [
  'ok',
  'updatedAt',
  'raw',
  'grid_l1_w',
  'grid_l2_w',
  'grid_l3_w',
  'grid_total_w',
  'error',
  'l1Dir',
  'l2Dir',
  'l3Dir',
  'totalDir',
  'semantics'
];

const VICTRON_FIELDS = [
  'updatedAt',
  // Connection flag for the settings banner (Christin 2026-06-21). Whitelisted so
  // pickFields carries it through the web-side re-snapshot pass (where the raw
  // fieldUpdatedAt is no longer present). Computed in buildVictronSnapshot.
  'connected',
  'soc',
  'batteryPowerW',
  'pvPowerW',
  'acPvL1W',
  'acPvL2W',
  'acPvL3W',
  'pvAcW',
  'pvTotalW',
  'gridSetpointW',
  'minSocPct',
  'maxDischargeW',
  'feedExcessDcPv',
  'dontFeedExcessAcPv',
  'gridImportW',
  'gridExportW',
  'selfConsumptionW',
  'batteryChargeW',
  'batteryDischargeW',
  'solarDirectUseW',
  'solarToBatteryW',
  'solarToGridW',
  'gridDirectUseW',
  'gridToBatteryW',
  'batteryDirectUseW',
  'batteryToGridW',
  'errors',
  // Victron device-alarm banner: the poller (a separate runtime-worker process)
  // writes state.victron.alarms; it MUST be whitelisted here or the IPC snapshot
  // drops it and the web process serves payload.victron.alarms = undefined
  // (banner permanently empty in split-process mode).
  'alarms',
  // T-FREEZE (2026-07-24): Einfrier-Wächter-Zustand ({active, reason, since,
  // stalledForMs, fields} oder null). Muss wie `alarms` whitelisted sein, sonst
  // verliert der IPC-Snapshot ihn und die Web-Seite sieht im Split-Prozess-Betrieb
  // nie einen erkannten Einfrierer.
  'freeze',
  // T-CROSSCHECK (2026-07-25): Widerspruch zwischen Modbus und der MQTT-Zweitquelle
  // ({active, since, fields, mismatches} oder null) — gleiche Begründung wie oben.
  'sourceMismatch'
];

const SCHEDULE_FIELDS = [
  'config',
  'rules',
  'active',
  'lastWrite',
  'manualOverride',
  'lastEvalAt',
  'smallMarketAutomation'
];

const TELEMETRY_FIELDS = [
  'enabled',
  'dbPath',
  'ok',
  'lastWriteAt',
  'lastRollupAt',
  'lastCleanupAt',
  'lastError'
];

const HISTORY_IMPORT_FIELDS = [
  'enabled',
  'provider',
  'ready',
  'mode',
  'vrmPortalId',
  'backfillRunning',
  'runningMode',
  'lastStartedAt',
  'lastFinishedAt',
  'lastError'
];

const VPN_FIELDS = [
  'enabled',
  'status',
  'protocol',
  'tunIp',
  'remoteIp',
  'upSince',
  'uptimeSeconds',
  'bytesSent',
  'bytesReceived',
  'lastModbusActivity',
  'reconnectAttempts',
  'lastReconnectAt',
  'lastError',
  'certExpiry',
  'certDaysRemaining',
  'watchdogOk',
  'profileName'
];

const RUNTIME_FIELDS = [
  'ready',
  'busy',
  'queueDepth',
  'snapshotAgeMs',
  'heartbeatAgeMs',
  'mode',
  'lastError'
];

function normalizeIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sanitizeValue(value) {
  if (value == null) return value ?? null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (typeof value === 'object') {
    const plain = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'function' || typeof entry === 'undefined') continue;
      plain[key] = sanitizeValue(entry);
    }
    return plain;
  }
  return null;
}

function pickFields(source, fields) {
  const snapshot = {};
  const input = source && typeof source === 'object' ? source : {};
  for (const field of fields) {
    if (!(field in input)) continue;
    snapshot[field] = sanitizeValue(input[field]);
  }
  return snapshot;
}

function buildMeterSnapshot(meter = {}) {
  return pickFields(meter, METER_FIELDS);
}

export function buildVictronSnapshot(victron = {}) {
  const snapshot = pickFields(victron, VICTRON_FIELDS);
  // Live-connection flag for the settings banner (Christin 2026-06-21): the banner
  // read victron.connected, which was NEVER populated → it always showed "Keine
  // Verbindung zum Victron-System" even while fresh live data was flowing in.
  // Derive it from the real per-field SUCCESS freshness (fieldUpdatedAt.soc), NOT
  // updatedAt (which is bumped on every attempt incl. failures). Only compute on
  // the poller-side pass where fieldUpdatedAt exists; on the web-side re-snapshot
  // (filtered input) pickFields has already carried the whitelisted `connected`
  // through, so we must not clobber it back to false. Threshold mirrors the
  // telemetryMaxAgeMs default (90 s ≈ many ~1 Hz poll cycles).
  const socOkAt = Number(victron?.fieldUpdatedAt?.soc);
  if (Number.isFinite(socOkAt)) {
    snapshot.connected = (Date.now() - socOkAt) <= 90000;
  }
  return snapshot;
}

/**
 * Lizenz-kWp-Cap für die ANGEZEIGTE Live-PV (T-LICENSE-KWP-GATING, Christin
 * 2026-07-02). Kappt die PV-Leistungsfelder eines FRISCHEN Victron-Snapshots auf
 * `capW` (= lizenzierte kWp × 1000). Mutiert das übergebene Snapshot-Objekt (der
 * Aufrufer reicht die frische Kopie aus buildVictronSnapshot/IPC — NIE die Quelle
 * `state.victron`, die der Steuerungspfad liest). `capW==null` → No-op
 * (Community/Legacy). Nur Anzeige; die reale Messung bleibt unberührt.
 *
 * @param {object} victron  frischer Snapshot (wird mutiert)
 * @param {number|null} capW  Cap in Watt, oder null = kein Cap
 * @returns {object} derselbe (ggf. gekappte) Snapshot
 */
export function capVictronPvForDisplay(victron, capW) {
  if (!(Number.isFinite(capW) && capW > 0) || !victron || typeof victron !== 'object') return victron;
  const cap = (w) => (Number(w) > capW ? capW : w);
  if (victron.pvPowerW != null) victron.pvPowerW = cap(victron.pvPowerW);
  if (victron.pvAcW != null) victron.pvAcW = cap(victron.pvAcW);
  if (victron.pvTotalW != null) victron.pvTotalW = cap(victron.pvTotalW);
  if (victron.dcExportMode && typeof victron.dcExportMode === 'object') {
    if (victron.dcExportMode.pvTotalW != null) victron.dcExportMode.pvTotalW = cap(victron.dcExportMode.pvTotalW);
    if (victron.dcExportMode.pvDcW != null) victron.dcExportMode.pvDcW = cap(victron.dcExportMode.pvDcW);
  }
  return victron;
}

function buildScheduleSnapshot(schedule = {}) {
  return pickFields(schedule, SCHEDULE_FIELDS);
}

function buildTelemetrySnapshot(telemetry = {}) {
  return pickFields(telemetry, TELEMETRY_FIELDS);
}

function buildHistoryImportSnapshot(historyImport = null) {
  if (!historyImport || typeof historyImport !== 'object') return null;
  return pickFields(historyImport, HISTORY_IMPORT_FIELDS);
}

function buildVpnSnapshot(vpn = null) {
  if (!vpn || typeof vpn !== 'object') return null;
  return pickFields(vpn, VPN_FIELDS);
}

export function buildRuntimeSnapshot({
  now = Date.now(),
  meter = {},
  victron = {},
  schedule = {},
  telemetry = {},
  historyImport = null,
  vpn = null
} = {}) {
  return {
    capturedAt: normalizeIso(now),
    meter: buildMeterSnapshot(meter),
    victron: buildVictronSnapshot(victron),
    schedule: buildScheduleSnapshot(schedule),
    telemetry: buildTelemetrySnapshot(telemetry),
    historyImport: buildHistoryImportSnapshot(historyImport),
    vpn: buildVpnSnapshot(vpn)
  };
}

export function buildWebStatusResponse({
  now = Date.now(),
  snapshot = {},
  runtime = {}
} = {}) {
  return {
    now: Number(now),
    meter: buildMeterSnapshot(snapshot.meter),
    victron: buildVictronSnapshot(snapshot.victron),
    schedule: buildScheduleSnapshot(snapshot.schedule),
    telemetry: {
      ...buildTelemetrySnapshot(snapshot.telemetry),
      historyImport: buildHistoryImportSnapshot(snapshot.historyImport)
    },
    vpn: buildVpnSnapshot(snapshot.vpn),
    runtime: pickFields(runtime, RUNTIME_FIELDS)
  };
}

export function buildWorkerBackedStatusResponse({
  cachedStatus = null,
  fallbackStatus = {},
  setup = null,
  runtime = {}
} = {}) {
  const base = sanitizeValue(
    cachedStatus && typeof cachedStatus === 'object'
      ? cachedStatus
      : fallbackStatus
  ) || {};

  const response = {
    ...base,
    runtime: pickFields(runtime, RUNTIME_FIELDS)
  };

  if (setup != null) {
    response.setup = sanitizeValue(setup);
  }

  return response;
}

export function buildHistoryImportStatusResponse({
  cachedStatus = null,
  fallbackTelemetryEnabled = false,
  fallbackHistoryImport = null
} = {}) {
  const cachedTelemetry = cachedStatus && typeof cachedStatus === 'object'
    ? sanitizeValue(cachedStatus.telemetry)
    : null;

  if (cachedTelemetry && typeof cachedTelemetry === 'object') {
    return {
      ok: true,
      telemetryEnabled: Boolean(cachedTelemetry.enabled),
      historyImport: cachedTelemetry.historyImport ?? null
    };
  }

  return {
    ok: true,
    telemetryEnabled: Boolean(fallbackTelemetryEnabled),
    historyImport: sanitizeValue(fallbackHistoryImport)
  };
}
