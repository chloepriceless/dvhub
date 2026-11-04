let nextRequestId = 1;

const CONTROL_TARGETS = new Set(['gridSetpointW', 'chargeCurrentA', 'minSocPct', 'feedExcessDcPv', 'maxDischargeW']);
const HISTORY_BACKFILL_MODES = new Set(['gap', 'full']);
const NOTIFY_LEVELS = new Set(['debug', 'info', 'warning', 'warn', 'error', 'critical']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  if (value == null) return true;
  if (typeof value !== 'string' || value.length === 0) return false;
  return !Number.isNaN(Date.parse(value));
}

function createRequestId() {
  const requestId = `runtime-${nextRequestId}`;
  nextRequestId += 1;
  return requestId;
}

export function createRuntimeCommandRequest(type, payload = {}, options = {}) {
  return {
    requestId: options.requestId || createRequestId(),
    type: String(type || ''),
    route: options.route || 'runtime_worker',
    payload: isObject(payload) ? { ...payload } : {}
  };
}

export function validateRuntimeCommand(command) {
  if (!isObject(command)) return { ok: false, error: 'runtime command must be an object' };
  const type = String(command.type || '');
  const payload = isObject(command.payload) ? command.payload : {};

  if (!type) return { ok: false, error: 'runtime command type is required' };

  if (type === 'poll_now' || type === 'service_health_snapshot') {
    return { ok: true, error: null };
  }

  if (type === 'control_write') {
    if (!CONTROL_TARGETS.has(String(payload.target || ''))) {
      return { ok: false, error: 'control_write target must be gridSetpointW, chargeCurrentA, minSocPct, feedExcessDcPv, or maxDischargeW' };
    }
    if (!Number.isFinite(Number(payload.value))) {
      return { ok: false, error: 'control_write value must be finite' };
    }
    return { ok: true, error: null };
  }

  if (type === 'history_import') {
    if (typeof payload.provider !== 'string' || payload.provider.trim().length === 0) {
      return { ok: false, error: 'history_import provider is required' };
    }
    if (!isIsoTimestamp(payload.requestedFrom) || !isIsoTimestamp(payload.requestedTo)) {
      return { ok: false, error: 'history_import requestedFrom/requestedTo must be valid ISO timestamps' };
    }
    return { ok: true, error: null };
  }

  // Netzstrom-Zähler auf 0 (services/optimizer/grid-share.js): nur der
  // Runtime-Prozess zählt und darf schreiben (Gegenprüfung Release 1.0.9, P2).
  if (type === 'grid_share_reset') {
    if (payload.reason != null && typeof payload.reason !== 'string') {
      return { ok: false, error: 'grid_share_reset reason must be a string' };
    }
    return { ok: true, error: null };
  }

  // Direktmeldung aus dem Web-Prozess (services/notifications/direct-relay.js):
  // nur der Runtime-Prozess hat gestartete Kanäle (Codex-Prüfung release/1.0.9, P2).
  if (type === 'notify_direct') {
    for (const [k, max] of [['title', 200], ['body', 2000], ['event', 64]]) {
      const v = payload[k];
      if (v == null && k !== 'title') continue;
      if (typeof v !== 'string' || v.length > max) return { ok: false, error: `notify_direct ${k} must be a string up to ${max} chars` };
    }
    if (payload.level != null && !NOTIFY_LEVELS.has(String(payload.level))) {
      return { ok: false, error: 'notify_direct level unknown' };
    }
    return { ok: true, error: null };
  }

  if (type === 'history_backfill') {
    if (!HISTORY_BACKFILL_MODES.has(String(payload.mode || ''))) {
      return { ok: false, error: 'history_backfill mode must be gap or full' };
    }
    return { ok: true, error: null };
  }

  return { ok: false, error: `unsupported runtime command: ${type}` };
}
