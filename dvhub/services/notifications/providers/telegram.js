// services/notifications/providers/telegram.js -- Telegram Bot API provider (INTG-07).
// Sends formatted messages via native fetch (zero npm deps).
// Uses AbortController with 10s timeout.
// Accepts optional cfg.baseUrl for test injection.

const TELEGRAM_API = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

// Telegram Markdown special chars that need escaping
const MD_SPECIAL = /([_*\[\]()~`>#\+\-=|{}.!])/g;

function escapeMarkdown(text) {
  return String(text).replace(MD_SPECIAL, '\\$1');
}

/**
 * Create a Telegram notification provider.
 *
 * @param {object} cfg - { botToken, chatId, baseUrl? }
 * @returns {{ type: string, notify: function }}
 */
export function createTelegramProvider(cfg) {
  const { botToken, chatId, baseUrl } = cfg;

  if (!botToken || !chatId) {
    throw new Error('Telegram provider requires botToken and chatId');
  }

  const apiBase = baseUrl || TELEGRAM_API;

  async function notify({ level, title, body, data } = {}) {
    const escapedTitle = escapeMarkdown(title || '');
    const escapedBody = escapeMarkdown(body || '');
    const text = `*${escapedTitle}*\n${escapedBody}`;

    const url = `${apiBase}/bot${botToken}/sendMessage`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        signal: ac.signal
      });

      const json = await res.json();

      if (json.ok) {
        return { ok: true };
      }
      return { ok: false, error: json.description || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message || 'Unknown error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { type: 'telegram', notify };
}
