// services/integrations-health-tracker.js -- Per-system health tracker (Phase 09.2 D-01..D-05).
//
// In-memory state: ring buffer of latencyMs (cap 60), sliding-window errors24h,
// sampleIntervalHistogramMs (cap 7 for activity-pulse rendering), lastSampleAt,
// uptimeStartedAt, firmware. Persisted to integration_health_snapshots on
// graceful shutdown (D-02). Re-hydrated at boot — except uptimeStartedAt
// which resets to Date.now() because uptime is "since this process started"
// (Pitfall 6 — see Phase 09.2 RESEARCH.md).
//
// Internal API:
//   recordSample(system, { latencyMs, success, firmware }) — fire-and-forget mutation
//   snapshot() — synchronous, returns per-system rolled-up state (averaged latency, etc.)
//   persistSnapshot() — async, UPSERT into integration_health_snapshots
//   loadSnapshot() — async, hydrate from DB at boot
//   close() — no-op (no timers; pure state)
//
// DI: ctx (full DI context with pool, getCfg, pushLog).

/**
 * @param {{ pool: object, getCfg?: Function, pushLog?: Function }} ctx
 * @returns {{
 *   recordSample: Function,
 *   snapshot: Function,
 *   persistSnapshot: Function,
 *   loadSnapshot: Function,
 *   close: Function,
 *   _state: Map<string, object>
 * }}
 */
export function createIntegrationsHealthTracker(ctx) {
  const { pool = null, pushLog = () => {} } = ctx || {};
  const state = new Map();

  const LATENCY_RING_CAP = 60;
  const HIST_RING_CAP = 7;
  const ERRORS_WINDOW_MS = 24 * 60 * 60 * 1000;
  const SCHEMA_VERSION = 1;

  // Status threshold map (per Phase 09.2 D-19 revised for victron — 30s warn, 5min err).
  // Other systems share the same thresholds for now; planner can add per-system overrides
  // in a follow-up if needed (luox/epex have their own cadences).
  function deriveStatus(s) {
    if (!s.lastSampleAt) return 'err';
    // Recent error wave → 'warn' even if latest sample is fresh
    if (s.errors24h.length > 10) return 'warn';
    const ageMs = Date.now() - s.lastSampleAt;
    if (ageMs > 5 * 60 * 1000) return 'err';
    if (ageMs > 30 * 1000) return 'warn';
    return 'ok';
  }

  function ensureSystem(system) {
    let s = state.get(system);
    if (!s) {
      s = {
        latencyMs: [],
        errors24h: [],
        lastSampleAt: null,
        uptimeStartedAt: Date.now(),
        firmware: null,
        sampleIntervalHistogramMs: []
      };
      state.set(system, s);
    }
    return s;
  }

  function recordSample(system, opts = {}) {
    if (!system || typeof system !== 'string') return;
    const { latencyMs, success, firmware } = opts;
    const now = Date.now();
    const s = ensureSystem(system);

    // Activity-pulse: gap since last sample (cap at HIST_RING_CAP entries)
    if (s.lastSampleAt) {
      s.sampleIntervalHistogramMs.push(now - s.lastSampleAt);
      while (s.sampleIntervalHistogramMs.length > HIST_RING_CAP) {
        s.sampleIntervalHistogramMs.shift();
      }
    }
    s.lastSampleAt = now;

    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      s.latencyMs.push(latencyMs);
      while (s.latencyMs.length > LATENCY_RING_CAP) s.latencyMs.shift();
    }

    if (success === false) {
      s.errors24h.push(now);
    }
    // D-05: sliding-window prune of errors older than 24h
    const cutoff = now - ERRORS_WINDOW_MS;
    while (s.errors24h.length && s.errors24h[0] < cutoff) s.errors24h.shift();

    if (firmware) s.firmware = String(firmware).slice(0, 64);
  }

  function snapshot() {
    const out = {};
    const now = Date.now();
    for (const [system, s] of state) {
      const avg = s.latencyMs.length
        ? Math.round(s.latencyMs.reduce((a, b) => a + b, 0) / s.latencyMs.length)
        : null;
      out[system] = {
        latencyMs: avg,
        uptimeSec: Math.max(0, Math.floor((now - s.uptimeStartedAt) / 1000)),
        errors24h: s.errors24h.length,
        lastSampleAt: s.lastSampleAt ? new Date(s.lastSampleAt).toISOString() : null,
        sampleIntervalHistogramMs: [...s.sampleIntervalHistogramMs],
        firmware: s.firmware,
        status: deriveStatus(s)
      };
    }
    return out;
  }

  async function persistSnapshot() {
    if (!pool) return;
    const rollup = snapshot();
    for (const [system, s] of state) {
      const payload = {
        version: SCHEMA_VERSION,
        ...rollup[system],
        // Internal arrays — let loadSnapshot() rehydrate full ring-buffer + sliding window
        _internalLatencyMs: [...s.latencyMs],
        _internalErrors24h: [...s.errors24h]
      };
      try {
        await pool.query(
          `INSERT INTO integration_health_snapshots (system, snapshot_jsonb, taken_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (system) DO UPDATE
             SET snapshot_jsonb = EXCLUDED.snapshot_jsonb,
                 taken_at = EXCLUDED.taken_at`,
          [system, JSON.stringify(payload)]
        );
      } catch (e) {
        pushLog('health_tracker_persist_error', { system, error: e.message });
      }
    }
  }

  async function loadSnapshot() {
    if (!pool) return;
    let rows = [];
    try {
      const r = await pool.query(
        `SELECT system, snapshot_jsonb FROM integration_health_snapshots`
      );
      rows = r.rows || [];
    } catch (e) {
      pushLog('health_tracker_load_error', { error: e.message });
      return;
    }
    const now = Date.now();
    for (const row of rows) {
      const snap = row.snapshot_jsonb;
      if (!snap || snap.version !== SCHEMA_VERSION) continue; // ignore foreign / missing schemas
      state.set(row.system, {
        latencyMs: Array.isArray(snap._internalLatencyMs)
          ? snap._internalLatencyMs.slice(-LATENCY_RING_CAP)
          : [],
        errors24h: Array.isArray(snap._internalErrors24h)
          ? snap._internalErrors24h.filter(ts => Number.isFinite(ts) && (now - ts) < ERRORS_WINDOW_MS)
          : [],
        lastSampleAt: snap.lastSampleAt ? new Date(snap.lastSampleAt).getTime() : null,
        // Pitfall 6: uptimeStartedAt MUST reset on every process restart by design.
        // "Uptime" here means "uptime since this process started", not "since provisioning".
        uptimeStartedAt: now,
        firmware: snap.firmware || null,
        sampleIntervalHistogramMs: Array.isArray(snap.sampleIntervalHistogramMs)
          ? snap.sampleIntervalHistogramMs.slice(-HIST_RING_CAP)
          : []
      });
    }
  }

  function close() {
    // No timer; pure state. Idempotent — safe to call multiple times.
  }

  return {
    recordSample,
    snapshot,
    persistSnapshot,
    loadSnapshot,
    close,
    // Test-only — exposed for unit-test introspection (D-05 sliding-window assertion)
    _state: state
  };
}
