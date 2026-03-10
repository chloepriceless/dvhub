function toIso(value) {
  return new Date(value).toISOString();
}

export function normalizePollIntervalMs(value, minimumMs = 1000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return minimumMs;
  return Math.max(minimumMs, Math.round(numeric));
}

export function createSerialTaskRunner({ task, queueWhileRunning = true }) {
  let inFlight = null;
  let queued = false;

  async function runLoop() {
    do {
      queued = false;
      await task();
    } while (queued);
  }

  return {
    async run() {
      if (inFlight) {
        queued = queueWhileRunning ? true : queued;
        return inFlight;
      }
      inFlight = runLoop().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    isRunning() {
      return Boolean(inFlight);
    }
  };
}

export function createTelemetryWriteBuffer({
  flushIntervalMs = 5000,
  now = () => Date.now(),
  buildSamples,
  writeSamples
}) {
  let pendingSnapshot = null;
  let lastFlushedAt = null;

  function capture(snapshot) {
    pendingSnapshot = {
      ...snapshot,
      capturedAt: Number(now()),
      ts: toIso(snapshot.ts || now())
    };
  }

  function flush({ force = false } = {}) {
    if (!pendingSnapshot) return false;
    const currentNow = Number(now());
    if (!force && lastFlushedAt != null && (currentNow - lastFlushedAt) < flushIntervalMs) {
      return false;
    }

    const resolutionSeconds = Math.max(
      1,
      Math.round(
        ((lastFlushedAt == null ? pendingSnapshot.capturedAt : currentNow) - (lastFlushedAt ?? pendingSnapshot.capturedAt)) / 1000
      ) || Number(pendingSnapshot.resolutionSeconds || 1)
    );

    const rows = buildSamples({
      ...pendingSnapshot,
      resolutionSeconds
    });
    if (Array.isArray(rows) && rows.length) {
      writeSamples(rows);
    }
    pendingSnapshot = null;
    lastFlushedAt = currentNow;
    return true;
  }

  return {
    capture,
    flush,
    hasPending() {
      return Boolean(pendingSnapshot);
    }
  };
}
