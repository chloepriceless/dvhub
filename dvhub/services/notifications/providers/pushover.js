// services/notifications/providers/pushover.js -- Pushover API provider (INTG-07).
// Sends formatted messages via native fetch (zero npm deps).
// Uses AbortController with 10s timeout.
// Accepts optional cfg.baseUrl for test injection.

const PUSHOVER_API = 'https://api.pushover.net';
const TIMEOUT_MS = 10_000;

/**
 * Create a Pushover notification provider.
 *
 * @param {object} cfg - { appToken, userKey, baseUrl? }
 * @returns {{ type: string, notify: function }}
 */
export function createPushoverProvider(cfg) {
  const { appToken, userKey, baseUrl } = cfg;

  if (!appToken || !userKey) {
    throw new Error('Pushover provider requires appToken and userKey');
  }

  const apiBase = baseUrl || PUSHOVER_API;

  async function notify({ level, title, body, data } = {}) {
    const priority = level === 'critical' ? 1 : 0;
    const url = `${apiBase}/1/messages.json`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: appToken,
          user: userKey,
          title: title || '',
          message: body || '',
          priority
        }),
        signal: ac.signal
      });

      const json = await res.json();

      if (json.status === 1) {
        return { ok: true };
      }
      return { ok: false, error: (json.errors || []).join(', ') || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message || 'Unknown error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { type: 'pushover', notify };
}
