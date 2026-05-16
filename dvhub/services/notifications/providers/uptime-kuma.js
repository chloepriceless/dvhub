// services/notifications/providers/uptime-kuma.js -- Uptime Kuma push-monitor provider (Phase 09.4 D-08).
// cfg: { pushUrl, heartbeatIntervalSec? }  pushUrl = full Kuma push-monitor URL.
// The pushToken in the URL path IS the credential — treat the whole URL as a secret.
// Modelled on providers/pushover.js (level->status mapping) + family-tiles.js
// (start/close timer-lifecycle discipline). notify()/push() never throw.
//
// NOTE (Pitfall 4): the Kuma monitor's configured interval must be >= the
// heartbeat interval + grace, or Kuma false-alarms. Default heartbeat 60s ->
// set the Kuma monitor to 120s+ to avoid spurious DOWN alerts.

const TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_SEC = 60;

/**
 * Create an Uptime Kuma push-monitor notification provider.
 *
 * @param {object} cfg - { pushUrl, heartbeatIntervalSec? }
 * @returns {{ type: string, notify: function, startHeartbeat: function, stopHeartbeat: function }}
 */
export function createUptimeKumaProvider(cfg) {
  const { pushUrl } = cfg;
  if (!pushUrl) throw new Error('uptime-kuma provider requires pushUrl');
  const intervalMs = (Number(cfg.heartbeatIntervalSec) || DEFAULT_HEARTBEAT_SEC) * 1000;
  let timer = null;

  async function push(status, msg) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const u = new URL(pushUrl);
      u.searchParams.set('status', status);   // 'up' | 'down'
      if (msg) u.searchParams.set('msg', msg);
      const res = await fetch(u.toString(), { method: 'GET', signal: ac.signal });
      return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message || 'Unknown error' };
    } finally {
      clearTimeout(t);
    }
  }

  async function notify({ level, title, body } = {}) {
    const status = level === 'critical' ? 'down' : 'up';
    return push(status, `${title || 'DVhub'}: ${body || ''}`.slice(0, 200));
  }

  function startHeartbeat() {
    if (timer) return;                          // idempotent
    push('up', 'DVhub alive');                  // immediate first beat
    timer = setInterval(() => { push('up', 'DVhub alive'); }, intervalMs);
    if (timer.unref) timer.unref();             // do not hold the event loop open
  }
  function stopHeartbeat() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { type: 'uptime-kuma', notify, startHeartbeat, stopHeartbeat };
}
