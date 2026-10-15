// routes/notification-routes.js — Benachrichtigungs-Provider: ntfy, Telegram,
// Pushover (GET/POST /api/notifications/providers/<name>, POST …/<name>/test).
//
// Aus routes-api.js herausgelöst (2026-10-15, Wartung: Aufteilung der großen
// Routen-Datei). Der Code ist unverändert; was er aus createApiRoutes braucht
// (Antwort-Helfer, Auth, Ratenbegrenzung der Test-Sendungen), kommt über
// `deps`. Gibt `false` zurück, wenn die Anfrage keine dieser Routen ist.

import { parseBody } from '../server-utils.js';

export function createNotificationRoutes(deps) {
  const { ctx, pushLog, json, checkAuth, actorContext, checkProviderRateLimit } = deps;

  return async function handleNotificationRoute(req, res, url) {
    // === Phase 20-01: dedicated ntfy endpoints (D-12 server-side merge) ===
    // GET / POST / POST-test live here, adjacent to the legacy combined endpoint
    // below. Migration plan: 20-02..06 add Telegram/Pushover/Uptime-Kuma/VRM/
    // Solcast/pvnode counterparts; the legacy endpoint stays until 20-06 is
    // closed (kept for shape-stability and a deprecation window).
    if (url.pathname === '/api/notifications/providers/ntfy' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const ntfy = raw.notifications?.providers?.ntfy || {};
      return json(res, 200, {
        ok: true,
        enabled: !!ntfy.enabled,
        topicUrl: ntfy.topicUrl || '',
        token: ntfy.token ? '***' : ''     // D-13: redacted, never raw
      });
    }

    if (url.pathname === '/api/notifications/providers/ntfy' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.notifications = (next.notifications && typeof next.notifications === 'object') ? next.notifications : {};
      next.notifications.providers = (next.notifications.providers && typeof next.notifications.providers === 'object')
        ? next.notifications.providers : {};
      const prev = next.notifications.providers.ntfy || {};
      // D-13 '***' sentinel: keep existing token.
      const token = (body.token === '***') ? (prev.token || '') : clip(body.token, 256);
      next.notifications.providers.ntfy = {
        enabled: !!body.enabled,
        topicUrl: clip(body.topicUrl, 512),
        ...(token ? { token: token } : {})
      };
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('ntfy_provider_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('ntfy_provider_saved', {
        enabled: !!body.enabled,
        topicUrlSet: !!body.topicUrl,
        tokenSet: !!token
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/notifications/providers/ntfy/test' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }

      // Pitfall 2: empty form value means "use stored". Same '***' sentinel
      // semantics applied to the TEST path.
      const stored = ctx.getRawCfg?.().notifications?.providers?.ntfy || {};
      const topicUrl = (body?.topicUrl && body.topicUrl !== '***') ? body.topicUrl : (stored.topicUrl || '');
      const token = (body?.token && body.token !== '***') ? body.token : (stored.token || '');
      if (!topicUrl) return json(res, 400, { ok: false, error: 'missing_topicurl' });

      // 5/min per (provider, token-hash). When no token, hash the URL so the
      // bucket key is still stable per-config.
      const rl = checkProviderRateLimit('ntfy', token || topicUrl);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });

      try {
        const { createNtfyProvider } = await import('../services/notifications/providers/ntfy.js');
        const provider = createNtfyProvider({ topicUrl, token });
        const result = await provider.notify({
          level: 'info',
          title: 'DVhub Test',
          body: 'Test-Nachricht von DVhub — ' + new Date().toISOString()
        });
        pushLog('notification_test_send', { provider: 'ntfy', ok: result.ok, error: result.error }, actorContext(req));
        return json(res, result.ok ? 200 : 502, result);
      } catch (e) {
        pushLog('notification_test_send_error', { provider: 'ntfy', error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // === Phase 20-02: Telegram dedicated endpoints (D-12 server-side-merge; D-13 redaction) ===
    if (url.pathname === '/api/notifications/providers/telegram' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const tg = raw.notifications?.providers?.telegram || {};
      return json(res, 200, {
        ok: true,
        enabled: !!tg.enabled,
        // D-13 + Pitfall 9: both botToken AND chatId are in REDACTED_PATHS.
        // Emit '***' when set, '' when unset; UI shows placeholder
        // "leer lassen = unverändert" when empty.
        botToken: tg.botToken ? '***' : '',
        chatId: tg.chatId ? '***' : ''
      });
    }

    if (url.pathname === '/api/notifications/providers/telegram' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.notifications = (next.notifications && typeof next.notifications === 'object') ? next.notifications : {};
      next.notifications.providers = (next.notifications.providers && typeof next.notifications.providers === 'object')
        ? next.notifications.providers : {};
      const prev = next.notifications.providers.telegram || {};
      // D-13 '***' sentinel applied to BOTH botToken AND chatId.
      const botToken = (body.botToken === '***') ? (prev.botToken || '') : clip(body.botToken, 256);
      const chatId   = (body.chatId   === '***') ? (prev.chatId   || '') : clip(body.chatId,   64);
      next.notifications.providers.telegram = {
        enabled: !!body.enabled,
        ...(botToken ? { botToken } : {}),
        ...(chatId   ? { chatId   } : {})
      };
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('telegram_provider_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('telegram_provider_saved', {
        enabled: !!body.enabled,
        botTokenSet: !!botToken,
        chatIdSet: !!chatId
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/notifications/providers/telegram/test' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }

      // Pitfall 2: empty form value means "use stored". Same '***' sentinel
      // semantics applied to the TEST path.
      const stored = ctx.getRawCfg?.().notifications?.providers?.telegram || {};
      const botToken = (body?.botToken && body.botToken !== '***') ? body.botToken : (stored.botToken || '');
      const chatId   = (body?.chatId   && body.chatId   !== '***') ? body.chatId   : (stored.chatId   || '');
      if (!botToken || !chatId) return json(res, 400, { ok: false, error: 'missing_credentials' });

      // 5/min per (provider, token-hash). Hash the bot token for the bucket key.
      const rl = checkProviderRateLimit('telegram', botToken);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });

      try {
        const { createTelegramProvider } = await import('../services/notifications/providers/telegram.js');
        const provider = createTelegramProvider({ botToken, chatId });
        const result = await provider.notify({
          level: 'info',
          title: 'DVhub Test',
          body: 'Test-Nachricht von DVhub — ' + new Date().toISOString()
        });
        pushLog('notification_test_send', { provider: 'telegram', ok: result.ok, error: result.error }, actorContext(req));
        return json(res, result.ok ? 200 : 502, result);
      } catch (e) {
        pushLog('notification_test_send_error', { provider: 'telegram', error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    // === Phase 20-03: Pushover dedicated endpoints (D-12 server-side-merge; D-13 redaction) ===
    if (url.pathname === '/api/notifications/providers/pushover' && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      const raw = ctx.getRawCfg?.() || {};
      const po = raw.notifications?.providers?.pushover || {};
      return json(res, 200, {
        ok: true,
        enabled: !!po.enabled,
        // D-13 + T-20-03-01: appToken AND userKey are in REDACTED_PATHS.
        // Emit '***' when set, '' when unset; UI shows placeholder
        // "leer lassen = unverändert" when empty.
        appToken: po.appToken ? '***' : '',
        userKey: po.userKey ? '***' : ''
      });
    }

    if (url.pathname === '/api/notifications/providers/pushover' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'object required' });
      }
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
      const next = JSON.parse(JSON.stringify(ctx.getRawCfg() || {}));
      next.notifications = (next.notifications && typeof next.notifications === 'object') ? next.notifications : {};
      next.notifications.providers = (next.notifications.providers && typeof next.notifications.providers === 'object')
        ? next.notifications.providers : {};
      const prev = next.notifications.providers.pushover || {};
      // D-13 '***' sentinel applied to BOTH appToken AND userKey.
      // Length clip = 64 (Pushover spec = 30 chars; generous bound, parallel to
      // telegram chatId clip).
      const appToken = (body.appToken === '***') ? (prev.appToken || '') : clip(body.appToken, 64);
      const userKey  = (body.userKey  === '***') ? (prev.userKey  || '') : clip(body.userKey,  64);
      next.notifications.providers.pushover = {
        enabled: !!body.enabled,
        ...(appToken ? { appToken } : {}),
        ...(userKey  ? { userKey  } : {})
      };
      try {
        ctx.saveAndApplyConfig(next);
      } catch (e) {
        pushLog('pushover_provider_save_error', { error: e.message });
        return json(res, 500, { ok: false, error: 'save failed' });
      }
      pushLog('pushover_provider_saved', {
        enabled: !!body.enabled,
        appTokenSet: !!appToken,
        userKeySet: !!userKey
      }, actorContext(req));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/notifications/providers/pushover/test' && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      let body;
      try { body = await parseBody(req); }
      catch { return json(res, 400, { ok: false, error: 'invalid json' }); }

      // Pitfall 2: empty form value means "use stored". Same '***' sentinel
      // semantics applied to the TEST path.
      const stored = ctx.getRawCfg?.().notifications?.providers?.pushover || {};
      const appToken = (body?.appToken && body.appToken !== '***') ? body.appToken : (stored.appToken || '');
      const userKey  = (body?.userKey  && body.userKey  !== '***') ? body.userKey  : (stored.userKey  || '');
      if (!appToken || !userKey) return json(res, 400, { ok: false, error: 'missing_credentials' });

      // 5/min per (provider, token-hash). Hash the app token for the bucket key.
      const rl = checkProviderRateLimit('pushover', appToken);
      if (!rl.ok) return json(res, 429, { ok: false, error: 'rate_limited', retry_after_s: rl.retry_after_s });

      try {
        const { createPushoverProvider } = await import('../services/notifications/providers/pushover.js');
        const provider = createPushoverProvider({ appToken, userKey });
        // T-20-03-04 escalation guard: HARD-CODED level: 'info' (priority 0).
        // pushover.js maps level === 'critical' → priority:1 (urgent, bypasses
        // operator's Pushover quiet hours); test-sends must stay non-urgent
        // regardless of what the operator submits via body.
        const result = await provider.notify({
          level: 'info',
          title: 'DVhub Test',
          body: 'Test-Nachricht von DVhub — ' + new Date().toISOString()
        });
        pushLog('notification_test_send', { provider: 'pushover', ok: result.ok, error: result.error }, actorContext(req));
        return json(res, result.ok ? 200 : 502, result);
      } catch (e) {
        pushLog('notification_test_send_error', { provider: 'pushover', error: e.message });
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    return false;
  };
}
