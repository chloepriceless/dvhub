// services/safe-async.js — Plan 09-07
// Shared helpers for long-running async patterns. Generalises the per-call-site
// `.catch + pushLog` pattern that Phase 8 plan 08-07 established.
//
// safeInterval(name, fn, ms):
//   Like setInterval but the callback is wrapped in try/catch (sync throws) AND
//   awaited inside an async runner (Promise rejections). Errors are logged via
//   logger.error from services/log.js + pushLog('safe_interval_error', ...).
//   The next tick ALWAYS fires — a thrown error never disables the interval.
//   The returned handle is .unref()'d so it does not hold the Node event loop
//   open during graceful shutdown.
//
// safeAsync(name, fn):
//   One-shot wrapper for fire-and-forget async work. Catches both sync throws
//   and Promise rejections. Returns the wrapped promise (resolved or
//   rejected-with-logging).
//
// Wire-up (server.js boot):
//   import { logger } from './services/log.js';
//   import { configureSafeAsync } from './services/safe-async.js';
//   // ... after pushLog is in scope ...
//   configureSafeAsync({ logger, pushLog });
//
// BLOCKER 2 fix: 09-06 is a hard depends_on. configureSafeAsync MUST be called
// with a real logger BEFORE any safeInterval fires. If misordered, _logError
// throws loudly so the operator sees it at boot — no silent console.error
// fallback.

let _logger = null;
let _pushLog = null;

export function configureSafeAsync({ logger, pushLog }) {
  if (!logger || typeof logger.error !== 'function') {
    throw new TypeError('configureSafeAsync requires a logger with .error (got: ' + typeof logger + ')');
  }
  if (typeof pushLog !== 'function') {
    throw new TypeError('configureSafeAsync requires a pushLog function');
  }
  _logger = logger;
  _pushLog = pushLog;
}

function _logError(event, details) {
  if (!_logger || !_pushLog) {
    // Wire-up bug — log loudly to stderr and re-throw so the operator sees the
    // misordering at boot rather than silently swallowing errors.
    // eslint-disable-next-line no-console
    console.error('[safe-async] configureSafeAsync was not called before safeInterval fired', { event, details });
    throw new Error('safe-async.js used before configureSafeAsync() — 09-06 must wire logger+pushLog at startup');
  }
  _logger.error(`[${event}] ${details?.interval || details?.name || 'anon'}: ${details?.message || ''}`, details);
  try {
    _pushLog(event, details, 'error');
  } catch { /* never let audit-write break the runner */ }
}

export function safeInterval(name, fn, ms) {
  if (typeof name !== 'string' || !name) throw new TypeError('safeInterval requires a stable name string');
  if (typeof fn !== 'function') throw new TypeError('safeInterval requires a function');
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError('safeInterval requires positive ms');

  const handle = setInterval(async () => {
    try {
      const result = fn();
      // Await Promise return without unwrapping non-Promise return — keeps
      // fn() that returns undefined / number / boolean etc. fully compatible.
      if (result && typeof result.then === 'function') {
        await result;
      }
    } catch (err) {
      _logError('safe_interval_error', {
        interval: name,
        message: String(err?.message || err),
        stack: String(err?.stack || '').slice(0, 500)
      });
    }
  }, ms);

  // Prevent the interval from holding the event loop open during shutdown.
  // Node returns a Timeout object that has .unref(); jsdom / fake-timer envs
  // may return a number — guard with typeof to stay portable across tests.
  if (typeof handle?.unref === 'function') handle.unref();

  return handle;  // Caller can clearInterval(handle) at teardown
}

export async function safeAsync(name, fn) {
  try {
    return await fn();
  } catch (err) {
    _logError('safe_async_error', {
      name,
      message: String(err?.message || err),
      stack: String(err?.stack || '').slice(0, 500)
    });
    return undefined;
  }
}

// Test-only escape hatch — lets unit tests reset the module-level singletons
// between tests so each `configureSafeAsync(...)` call sets a fresh logger/pushLog.
// Not part of the public API; do not call from production code.
export function _resetForTests() {
  _logger = null;
  _pushLog = null;
}
