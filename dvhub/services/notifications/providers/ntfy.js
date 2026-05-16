// services/notifications/providers/ntfy.js -- ntfy.sh provider (Phase 09.4 D-07).
// HTTP POST to an ntfy topic URL via native fetch (zero npm deps). 10s timeout.
// cfg.topicUrl is the full topic URL (ntfy.sh hosted OR self-hosted base) — D-07.
// Modelled on providers/telegram.js. notify() never throws — returns {ok} shape.

const TIMEOUT_MS = 10_000;

/**
 * Create an ntfy.sh notification provider.
 *
 * @param {object} cfg - { topicUrl, token? }
 *   topicUrl is the full topic URL (e.g. "https://ntfy.sh/dvhub-alerts" or a
 *   self-hosted "https://ntfy.example.com/dvhub"). It doubles as the
 *   self-hosted switch (D-07) — do NOT split it into base + topic.
 * @returns {{ type: string, notify: function }}
 */
export function createNtfyProvider(cfg) {
  const { topicUrl, token } = cfg;
  if (!topicUrl) throw new Error('ntfy provider requires topicUrl');

  async function notify({ level, title, body } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const headers = {
        'Title': title || 'DVhub',
        'Priority': level === 'critical' ? '5' : '3',   // 5=urgent, 3=default
        'Tags': level === 'critical' ? 'warning' : 'information_source'
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(topicUrl, {
        method: 'POST',
        headers,
        body: body || '',
        signal: ac.signal
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message || 'Unknown error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { type: 'ntfy', notify };
}
