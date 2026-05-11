(function () {
  const STORAGE_KEY = 'dvhub.apiToken';
  const LEGACY_STORAGE_KEY = ['plex', 'lite.apiToken'].join('');

  // Plan 08-06 Task 2 Step 4: token storage moved off localStorage.
  // localStorage survives tab close + is readable by ANY script running on the
  // origin → trivial XSS exfiltration vector. sessionStorage scopes to a single
  // tab/session, removing the persistent-cookie-style attack surface.
  // One-time migration: any existing localStorage token is moved into
  // sessionStorage on first call, then the localStorage entry is cleared.
  function tokenStore() {
    try { return window.sessionStorage; } catch { return null; }
  }

  function migrateLegacyToken() {
    try {
      const store = tokenStore();
      if (store && store.getItem(STORAGE_KEY)) return store.getItem(STORAGE_KEY);
      // Pull from localStorage (current STORAGE_KEY first, then very-old "plexlite" key).
      const fromLocal = window.localStorage.getItem(STORAGE_KEY)
        || window.localStorage.getItem(LEGACY_STORAGE_KEY)
        || '';
      if (fromLocal && store) {
        store.setItem(STORAGE_KEY, fromLocal);
      }
      // Clear localStorage either way so future XSS cannot read it.
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      try { window.localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
      return fromLocal;
    } catch {
      return '';
    }
  }

  function getStoredApiToken() {
    try {
      const store = tokenStore();
      const fromSession = store ? store.getItem(STORAGE_KEY) : null;
      return fromSession || migrateLegacyToken() || '';
    } catch {
      return '';
    }
  }

  function setStoredApiToken(token) {
    try {
      const store = tokenStore();
      if (!store) return;
      if (token) store.setItem(STORAGE_KEY, token);
      else store.removeItem(STORAGE_KEY);
      // Defensive: keep localStorage cleared so an old value never re-surfaces.
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    } catch {
      // ignore storage errors
    }
  }

  function syncTokenFromUrl() {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (!token) return;
    // Plan 08-03 Task 3: persist the token BEFORE we rewrite the URL so a
    // navigation/race can never lose the value.
    setStoredApiToken(token);
    url.searchParams.delete('token');
    // Defensive: also strip `token=` from any hash fragment that might carry it.
    if (url.hash && url.hash.includes('token=')) {
      const hashParts = url.hash.replace(/^#/, '').split('&').filter((p) => !/^token=/.test(p));
      url.hash = hashParts.length ? '#' + hashParts.join('&') : '';
    }
    try {
      const rewritten = url.pathname + (url.search || '') + (url.hash || '');
      window.history.replaceState(null, '', rewritten);
    } catch (err) {
      // history API may be unavailable in some embedded contexts (file://, sandboxed iframe)
      console.warn('[syncTokenFromUrl] history.replaceState failed', err);
    }
  }

  function buildApiUrl(path) {
    const url = new URL(path, window.location.origin);
    // Plan 08-06 Task 2 Step 3: do NOT append ?token= to API URLs. The server now
    // rejects ?token= on every endpoint except /api/config/export (which uses
    // window.location.href for the file download and cannot send a header).
    // Auth flows through the Authorization: Bearer <token> header in apiFetch().
    if (url.pathname === '/api/config/export') {
      const token = getStoredApiToken();
      if (token && !url.searchParams.has('token')) url.searchParams.set('token', token);
    }
    return url.toString();
  }

  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getStoredApiToken();
    if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('dvhub:unauthorized'));
    }
    return response;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // Plan 08-07 Task 3: global frontend error boundary.
  // Surfaces uncaught exceptions and unhandled promise rejections to /api/log
  // so widget crashes are observable in the operator log instead of dying silently
  // in the console. keepalive:true lets POST survive page-navigation away.
  function installGlobalErrorBoundary() {
    if (window.__dvhubErrorBoundaryInstalled) return;
    window.__dvhubErrorBoundaryInstalled = true;

    function postFrontendError(payload) {
      if (!getStoredApiToken()) return; // no auth — server would 401 anyway
      try {
        apiFetch('/api/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            level: 'error',
            source: 'frontend',
            page: window.location.pathname,
            ts: new Date().toISOString(),
            ...payload
          }),
          keepalive: true
        }).catch(() => { /* never loop on log post failure */ });
      } catch { /* defensive: never let error logging itself throw */ }
    }

    window.addEventListener('error', (event) => {
      postFrontendError({
        type: 'window.onerror',
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 4000) : null
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      postFrontendError({
        type: 'unhandledrejection',
        reason: reason && reason.message ? reason.message : String(reason),
        stack: reason && reason.stack ? String(reason.stack).slice(0, 4000) : null
      });
    });
  }

  // Plan 09-04: per-sub-widget error boundary. Operates BELOW the coarse
  // withWidgetBoundary('dashboard', refresh) wrapper that Plan 08-07 shipped:
  // each individual widget update inside the refresh cycle is wrapped so one
  // failure does NOT abort the sibling widgets in the same tick. On throw,
  // safeRender POSTs to /api/log (same endpoint Plan 08-07 created) with
  // event='widget_error' and renders an inline placeholder if a target is given.
  async function safeRender(widgetName, fn, opts = {}) {
    const placeholderTarget = opts && opts.placeholderTarget ? opts.placeholderTarget : null;
    try {
      const ret = fn();
      if (ret && typeof ret.then === 'function') await ret;
      return { ok: true };
    } catch (err) {
      try {
        // Best-effort log; do not throw if /api/log is unreachable. Same payload
        // shape as Plan 08-07 frontend_* events, with event='widget_error' so
        // audit-log filters can distinguish per-widget from page-level errors.
        apiFetch('/api/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            event: 'widget_error',
            level: 'error',
            source: 'widget',
            widget: widgetName,
            message: String(err && err.message ? err.message : err),
            stack: String(err && err.stack ? err.stack : '').slice(0, 500),
            page: typeof location !== 'undefined' ? location.pathname : null
          })
        }).catch(() => { /* never loop on log post failure */ });
      } catch { /* defensive: never let error logging itself throw */ }
      if (placeholderTarget && typeof placeholderTarget.appendChild === 'function') {
        try {
          const span = document.createElement('span');
          span.className = 'dvhub-widget-error';
          span.title = `${widgetName}: ${err && err.message ? err.message : err}`;
          span.textContent = 'Widget aktuell nicht verfügbar';
          if (typeof placeholderTarget.replaceChildren === 'function') {
            placeholderTarget.replaceChildren(span);
          } else {
            placeholderTarget.appendChild(span);
          }
        } catch { /* ignore DOM errors in placeholder render */ }
      }
      return { ok: false, error: err };
    }
  }

  syncTokenFromUrl();
  installGlobalErrorBoundary();

  window.DVhubCommon = {
    apiFetch,
    buildApiUrl,
    escapeHtml,
    getStoredApiToken,
    setStoredApiToken,
    safeRender  // Plan 09-04 — per-sub-widget error boundary
  };

  // Unregister any old service workers — DVhub is a LAN app, SW caching causes stale UI
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      for (const reg of regs) reg.unregister();
    });
  }
})();
