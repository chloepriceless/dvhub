let nextRequestId = 1;

const CONTROL_TARGETS = new Set(['gridSetpointW', 'chargeCurrentA', 'minSocPct']);
const HISTORY_BACKFILL_MODES = new Set(['gap', 'full']);

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
      return { ok: false, error: 'control_write target must be gridSetpointW, chargeCurrentA, or minSocPct' };
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

  if (type === 'history_backfill') {
    if (!HISTORY_BACKFILL_MODES.has(String(payload.mode || ''))) {
      return { ok: false, error: 'history_backfill mode must be gap or full' };
    }
    return { ok: true, error: null };
  }

  return { ok: false, error: `unsupported runtime command: ${type}` };
}
