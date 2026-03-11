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
  'soc',
  'batteryPowerW',
  'pvPowerW',
  'acPvL1W',
  'acPvL2W',
  'acPvL3W',
  'pvTotalW',
  'gridSetpointW',
  'minSocPct',
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
  'errors'
];

const SCHEDULE_FIELDS = [
  'config',
  'rules',
  'active',
  'lastWrite',
  'manualOverride',
  'lastEvalAt'
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

export function buildMeterSnapshot(meter = {}) {
  return pickFields(meter, METER_FIELDS);
}

export function buildVictronSnapshot(victron = {}) {
  return pickFields(victron, VICTRON_FIELDS);
}

export function buildScheduleSnapshot(schedule = {}) {
  return pickFields(schedule, SCHEDULE_FIELDS);
}

export function buildTelemetrySnapshot(telemetry = {}) {
  return pickFields(telemetry, TELEMETRY_FIELDS);
}

export function buildHistoryImportSnapshot(historyImport = null) {
  if (!historyImport || typeof historyImport !== 'object') return null;
  return pickFields(historyImport, HISTORY_IMPORT_FIELDS);
}

export function buildRuntimeSnapshot({
  now = Date.now(),
  meter = {},
  victron = {},
  schedule = {},
  telemetry = {},
  historyImport = null
} = {}) {
  return {
    capturedAt: normalizeIso(now),
    meter: buildMeterSnapshot(meter),
    victron: buildVictronSnapshot(victron),
    schedule: buildScheduleSnapshot(schedule),
    telemetry: buildTelemetrySnapshot(telemetry),
    historyImport: buildHistoryImportSnapshot(historyImport)
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
