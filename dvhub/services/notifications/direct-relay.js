// services/notifications/direct-relay.js — Direktmeldungen (sendDirect) auch
// aus dem Web-Prozess.
//
// Mit DVHUB_ENABLE_RUNTIME_WORKER=1 startet der Benachrichtigungsdienst nur im
// Runtime-Prozess (server.js); der Web-Prozess hat zwar ein Dienst-Objekt, aber
// keine Kanäle. Meldungen, die im Web-Prozess entstehen (Support-Tunnel
// geöffnet/geschlossen, Fern-Support-Änderungen), gehen deshalb als Befehl
// notify_direct an den Worker (Codex-Prüfung release/1.0.9, P2). Im
// Einzelprozess und im Worker selbst sendet der Dienst direkt.

export const NOTIFY_DIRECT_LEVELS = Object.freeze(['debug', 'info', 'warning', 'warn', 'error', 'critical']);
export const NOTIFY_DIRECT_MAX = Object.freeze({ event: 64, title: 200, body: 2000 });

/** Nur die Felder, die sendDirect nutzt; Texte gekürzt. */
export function directMessagePayload(msg = {}) {
  const out = {
    event: String(msg.event || 'direct').slice(0, NOTIFY_DIRECT_MAX.event),
    level: NOTIFY_DIRECT_LEVELS.includes(msg.level) ? msg.level : 'info',
    title: String(msg.title || 'DVhub').slice(0, NOTIFY_DIRECT_MAX.title),
    body: String(msg.body || '').slice(0, NOTIFY_DIRECT_MAX.body),
  };
  return out;
}

/**
 * @param {{ isRuntimeProcess: boolean, getService: () => any, sendCommand?: (type: string, payload: object) => Promise<{ok: boolean, result?: any, error?: string}> }} opts
 * @returns {(msg: object) => Promise<object>}
 */
export function createDirectNotifier({ isRuntimeProcess, getService, sendCommand }) {
  return async function notifyDirect(msg) {
    const payload = directMessagePayload(msg);
    try {
      if (isRuntimeProcess) {
        const svc = getService?.();
        if (!svc || typeof svc.sendDirect !== 'function') return { sent: 0, error: 'notification_service_unavailable' };
        return await svc.sendDirect(payload);
      }
      if (typeof sendCommand !== 'function') return { sent: 0, error: 'runtime_worker_unavailable' };
      const r = await sendCommand('notify_direct', payload);
      if (!r?.ok) return { sent: 0, error: r?.error || 'runtime_command_failed' };
      return r.result && typeof r.result === 'object' ? r.result : { queued: true };
    } catch (e) {
      return { sent: 0, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

/**
 * Handler für den Runtime-Worker (attachRuntimeCommandServer). Antwortet
 * sofort und sendet im Hintergrund — langsame Kanäle sollen die Befehlsreihe
 * (z. B. grid_share_reset) nicht aufhalten.
 */
export function notifyDirectHandler(getService) {
  return (payload) => {
    const svc = getService?.();
    if (!svc || typeof svc.sendDirect !== 'function') return { queued: false, error: 'notification_service_unavailable' };
    Promise.resolve()
      .then(() => svc.sendDirect(directMessagePayload(payload)))
      .catch(() => { /* sendDirect protokolliert selbst */ });
    return { queued: true };
  };
}
