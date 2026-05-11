// services/log.js -- Plan 09-06 (D-08).
// Thin wrapper around console.* that adds a level + ISO timestamp prefix.
// Non-breaking: callers that still use console.* keep working. The wrapper is
// the new preferred path for the heavy-hitter modules listed in CONTEXT.md D-08:
//   - polling.js
//   - services/forecast/index.js
//   - vpn-manager.js
//   - transport-modbus.js
//   - server.js (used by the in-process monitoring-heartbeat block; the
//                pushLog ring buffer threads `level` into audit_log.severity
//                instead of calling logger.* directly)
//
// Levels: debug < info < warn < error.
// LOG_LEVEL env var (default 'info') filters debug logs from prod. Setting
// LOG_LEVEL=warn suppresses both info() and debug() while preserving warn()/error().
//
// Redaction note (Plan 09-06 threat T-9-06-05):
//   The formatter does NOT auto-redact. Callers are responsible for running any
//   sensitive payload (URL credentials, tokens, keys) through config-redaction.js
//   BEFORE handing it to info/warn/error/debug. The wrapper does not introspect
//   the meta object — JSON.stringify is intentionally opaque.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function fmt(level, msg, meta) {
  const ts = new Date().toISOString();
  const tail = (meta !== undefined && meta !== null) ? ' ' + JSON.stringify(meta) : '';
  return `${ts} ${level.toUpperCase()} ${msg}${tail}`;
}

export function debug(msg, meta) {
  if (LEVELS.debug < minLevel) return;
  console.log(fmt('debug', msg, meta));  // eslint-disable-line no-console
}
export function info(msg, meta) {
  if (LEVELS.info < minLevel) return;
  console.log(fmt('info', msg, meta));   // eslint-disable-line no-console
}
export function warn(msg, meta) {
  if (LEVELS.warn < minLevel) return;
  console.warn(fmt('warn', msg, meta));
}
export function error(msg, meta) {
  if (LEVELS.error < minLevel) return;
  console.error(fmt('error', msg, meta));
}

export const logger = { debug, info, warn, error };
