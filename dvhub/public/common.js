(function () {
  const STORAGE_KEY = 'dvhub.apiToken';
  const LEGACY_STORAGE_KEY = ['plex', 'lite.apiToken'].join('');

  // Token persistence (operator decision, Christin 2026-06-27): the API token is
  // stored in localStorage so it SURVIVES closing the tab/browser. Otherwise an
  // operator who set the box up via the onboarding wizard would be silently
  // logged out — and locked out of Settings under lanTrust='restricted' — the
  // next time they reopen the page, with no way to recover the token (the
  // onboarding does not re-run once setupCompleted=true, and the config payload
  // only ever returns the token redacted). Only an explicit "clear site data"
  // removes it now. Tradeoff vs. the earlier sessionStorage hardening:
  // localStorage is readable by any script on the origin, so this leans on the
  // app's strict CSP (no 'unsafe-inline', no third-party scripts) to keep XSS
  // exfiltration off the table. The token can be viewed/copied any time from
  // Settings → Zugang.
  function tokenStore() {
    try { return window.localStorage; } catch { return null; }
  }

  function migrateLegacyToken() {
    // One-time migration into the canonical localStorage slot from the previous
    // sessionStorage home (XSS-era) and the very-old localStorage "plexlite" key.
    try {
      const store = tokenStore();
      if (store && store.getItem(STORAGE_KEY)) return store.getItem(STORAGE_KEY);
      let legacy = '';
      try { legacy = window.sessionStorage.getItem(STORAGE_KEY) || ''; } catch { /* ignore */ }
      if (!legacy) {
        try { legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY) || ''; } catch { /* ignore */ }
      }
      if (legacy && store) store.setItem(STORAGE_KEY, legacy);
      // Clear the old sessionStorage + legacy localStorage homes so a stale value
      // never shadows the canonical token.
      try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      try { window.localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
      return legacy;
    } catch {
      return '';
    }
  }

  function getStoredApiToken() {
    try {
      const store = tokenStore();
      const fromStore = store ? store.getItem(STORAGE_KEY) : null;
      return fromStore || migrateLegacyToken() || '';
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
      // Keep the old sessionStorage home cleared so a stale value never shadows
      // the canonical localStorage token.
      try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
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

  // Sweep package 6: shared frontend 2-decimal rounding helper.
  // Was a local round2 duplicate in history.js; sign-aware + EPSILON-corrected,
  // matching the server-side server-utils.js round2 default behavior.
  function round2(value) {
    const numeric = Number(value || 0);
    const sign = numeric < 0 ? -1 : 1;
    return sign * (Math.round((Math.abs(numeric) + Number.EPSILON) * 100) / 100);
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

  // ---------------------------------------------------------------------------
  // Aurora chart-color readers (Plan 09.1-04 — port Chart.js dataset colors
  // off hardcoded hex/rgba literals onto Aurora CSS tokens). Chart.js v3+
  // does NOT resolve `var(--token)` strings in dataset/options values, so we
  // resolve them at chart-construction time via getComputedStyle. Both app.js
  // and leitstand-charts.js call these helpers; placing them on
  // DVhubCommon means common.js (loaded BEFORE app.js + leitstand-charts.js
  // in index.html) is the single source of the colour-shim.
  // ---------------------------------------------------------------------------
  function aurChartColor(name, fallback) {
    if (typeof document === 'undefined' || !document.documentElement) {
      return fallback || '#fff';
    }
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = (v || '').trim();
    return v || fallback || '#fff';
  }
  function aurChartColorAlpha(name, alpha, fallback) {
    var v = aurChartColor(name, fallback);
    // Best-effort: convert hex (#rgb / #rrggbb) to rgba(); pass through
    // anything else (already-rgba, already-hsl, named colors, etc.).
    if (typeof v !== 'string') return fallback || v;
    var hex = v.replace('#', '');
    if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.split('').map(function (c) { return c + c; }).join('');
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return 'rgba(' +
        parseInt(hex.slice(0, 2), 16) + ',' +
        parseInt(hex.slice(2, 4), 16) + ',' +
        parseInt(hex.slice(4, 6), 16) + ',' +
        alpha + ')';
    }
    return v;
  }

  // Plan 09.1-05 (Wave 4): wire the Aurora topbar burger toggle on every page
  // that uses `<button id="navToggle"> + <nav id="topbarNav">`. Previously the
  // wiring lived in app.js#wireNavToggle() (index-only); settings.html + setup.html
  // also adopt the Aurora topbar in this wave and need the same behaviour, so
  // hoist the wiring to common.js. Idempotent — a missing #navToggle or
  // #topbarNav is the canonical "page has no burger" state (e.g. family.html
  // kiosk) and the function no-ops.
  function wireAuroraTopbarNavToggle() {
    var toggle = document.getElementById('navToggle');
    var nav = document.getElementById('topbarNav');
    if (!toggle || !nav) return;
    // Idempotent: app.js#wireNavToggle (index-only) may also try to wire the
    // same nodes after this common.js call. Mark via data-attr so the second
    // call short-circuits and we don't end up with two click listeners that
    // each toggle the open state (net no-op + flicker).
    if (toggle.dataset.navToggleWired === '1') return;
    toggle.dataset.navToggleWired = '1';
    toggle.addEventListener('click', function () {
      var isOpen = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
    var links = nav.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function () {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAuroraTopbarNavToggle);
  } else {
    wireAuroraTopbarNavToggle();
  }

  syncTokenFromUrl();
  installGlobalErrorBoundary();

  window.DVhubCommon = {
    apiFetch,
    buildApiUrl,
    escapeHtml,
    round2,             // Sweep package 6 — shared frontend 2-decimal rounding helper
    getStoredApiToken,
    setStoredApiToken,
    safeRender,         // Plan 09-04 — per-sub-widget error boundary
    aurChartColor,      // Plan 09.1-04 — Aurora chart token reader (resolves CSS variables at chart-build time)
    aurChartColorAlpha  // Plan 09.1-04 — Aurora chart token reader with alpha (hex→rgba conversion)
  };

  // Unregister any old service workers — DVhub is a LAN app, SW caching causes stale UI
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      for (const reg of regs) reg.unregister();
    });
  }
})();
