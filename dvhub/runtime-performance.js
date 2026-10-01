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

// batchMs (2026-10-01, SD-Karte): die 5-s-Zeilen werden im RAM gesammelt und
// nur alle batchMs als EIN Block geschrieben — volle Auflösung, aber ein
// Schreibvorgang pro Minute statt zwölf. force (Beenden) schreibt sofort.
// maxQueuedRows begrenzt den RAM, falls die Datenbank länger weg ist (älteste
// Zeilen fallen dann weg).
export function createTelemetryWriteBuffer({
  flushIntervalMs = 5000,
  batchMs = 0,
  maxQueuedRows = 20000,
  now = () => Date.now(),
  buildSamples,
  writeSamples
}) {
  let pendingSnapshot = null;
  let lastFlushedAt = null;
  let queue = [];
  let lastWriteAt = null;

  function writeQueued(force) {
    if (!queue.length) return;
    const t = Number(now());
    if (!force && batchMs > 0 && lastWriteAt != null && (t - lastWriteAt) < batchMs) return;
    if (lastWriteAt == null && !force && batchMs > 0) { lastWriteAt = t; return; }
    const rows = queue;
    queue = [];
    lastWriteAt = t;
    writeSamples(rows);
  }

  function capture(snapshot) {
    pendingSnapshot = {
      ...snapshot,
      capturedAt: Number(now()),
      ts: toIso(snapshot.ts || now())
    };
  }

  function flush({ force = false } = {}) {
    if (!pendingSnapshot) { if (force) writeQueued(true); return false; }
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
      if (batchMs > 0) {
        queue.push(...rows);
        if (queue.length > maxQueuedRows) queue = queue.slice(queue.length - maxQueuedRows);
      } else {
        writeSamples(rows);
      }
    }
    pendingSnapshot = null;
    lastFlushedAt = currentNow;
    if (batchMs > 0) writeQueued(force);
    return true;
  }

  return {
    capture,
    flush,
    hasPending() {
      return Boolean(pendingSnapshot) || queue.length > 0;
    },
    queuedRows: () => queue.length
  };
}
