function toIso(value) {
  return new Date(value).toISOString();
}

// Der Schreibpuffer stempelt den Probenabstand in ganzen Sekunden mit
// Rundungsübertrag (createTelemetryWriteBuffer): ein exakter Abstand ≤ X s
// ergibt einen Stempel ≤ X + 1 s (5,3-s-Zyklus → 5 und 6). Feine Ansichten
// (Fenster unter einer Viertelstunde) lassen darum 1 s mehr zu, sonst fielen
// Proben nur wegen des Übertrags heraus (Codex aabaca15). Grobe Grenzen
// (≥ 900 s, VRM-/Rollup-Zeilen) bleiben genau.
export const RESOLUTION_CARRY_SLACK_SECONDS = 1;
export function resolutionFilterLimit(maxSeconds) {
  const n = Number(maxSeconds);
  if (!Number.isFinite(n)) return maxSeconds;
  return n < 900 ? n + RESOLUTION_CARRY_SLACK_SECONDS : n;
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
  let roundingCarryS = 0;

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

    // Abstand zur vorigen gespeicherten Probe in ganzen Sekunden (Spalte
    // resolution_seconds ist INTEGER). Der Rundungsrest wird in die nächste
    // Probe mitgenommen (Fable R3, P2-1): einzeln gerundet zählten 5,3-s-Zyklen
    // als 5 s, ein Slot kam nur auf ~845 s Abdeckung (nie „vollständig“) und
    // ~6 % zu wenig Energie, 5,6-s-Zyklen als 6 s (Überzählung verdeckte
    // Lücken). Mit Übertrag folgt die Summe der echten Zeit auf ±0,5 s.
    let resolutionSeconds;
    if (lastFlushedAt == null) {
      resolutionSeconds = Math.max(1, Math.round(Number(pendingSnapshot.resolutionSeconds || 1)) || 1);
      roundingCarryS = 0;
    } else {
      const exactS = (currentNow - lastFlushedAt) / 1000 + roundingCarryS;
      resolutionSeconds = Math.max(1, Math.round(exactS));
      // Begrenzt: sehr kurze Zwangs-Schreibvorgänge (force, < 0,5 s) stempeln
      // 1 s und dürfen keinen wachsenden Rückstand aufbauen.
      roundingCarryS = Math.min(0.5, Math.max(-0.5, exactS - resolutionSeconds));
    }

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
