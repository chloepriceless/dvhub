(function () {
  'use strict';

  var POLL_INTERVAL_MS = 10000;
  var STALE_THRESHOLD_MS = 60000;

  // System catalogue — drives card render order + per-system summary
  // shape. Phase 09.2 D-04: order tracks the health-tracker hook coverage.
  // Each card consumes /api/integrations/health[<key>] when present
  // (latencyMs, uptimeSec, errors24h, sampleIntervalHistogramMs, firmware).
  var SYSTEMS = [
    {
      key: 'victron',
      label: 'Victron VRM',
      category: 'Inverter · Modbus',
      logo: 'V',
      accent: 'green'
    },
    {
      key: 'mid',
      label: 'MID Meter',
      category: 'Zähler · Modbus',
      logo: 'MD',
      accent: 'yellow'
    },
    // LUOX-Karte entfernt 2026-05-23 (Operator-Request): keine LUOX-Hardware
    // bei diesem Operator. Backend (`luox` in /api/integrations/status, plus
    // identity-handling für künftige Operatoren) bleibt für Aktivierung
    // intakt — nur die UI-Karte verschwindet aus der Integrations-Übersicht.
    {
      key: 'mqtt',
      label: 'MQTT Hub',
      category: 'Broker · TCP',
      logo: 'M',
      accent: 'cyan'
    },
    {
      key: 'tesla',
      label: 'TeslaMate',
      category: 'Fahrzeug · API',
      logo: 'T',
      accent: 'red'
    },
    {
      key: 'homeAssistant',
      label: 'Home Assistant',
      category: 'Smarthome · MQTT',
      logo: 'HA',
      accent: 'cyan'
    },
    {
      key: 'loxone',
      label: 'Loxone',
      category: 'Smarthome · Miniserver',
      logo: 'Lx',
      accent: 'violet'
    },
    {
      key: 'devices',
      label: 'Smart Plugs',
      category: 'Energie · Devices',
      logo: 'SP',
      accent: 'yellow'
    },
    {
      key: 'notifications',
      label: 'Notifications',
      category: 'Push · Provider',
      logo: 'No',
      accent: 'green'
    },
    // Phase 20-05 (D-06): VRM credentials get their own conn-card next to
    // Victron. Click opens #dv-drawer-vrm via the unified delegation.
    {
      key: 'vrm',
      label: 'VRM Cloud',
      category: 'Victron · History Import',
      logo: 'VR',
      accent: 'orange'
    },
    // Phase 20-06 (D-09/D-10/D-11): Solcast + pvnode credentials aggregated
    // into a single Sammelkarte. Click opens #dv-drawer-forecast with two
    // tabs (pvnode default, Solcast).
    {
      key: 'forecast-providers',
      label: 'PV-Forecast-Provider',
      category: 'Wetter & Solarprognose',
      logo: 'FP',
      accent: 'violet'
    }
  ];

  var lastData = null;
  var currentFilter = 'all';

  function apiFetch(path, opts) {
    var common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }

  // === Phase 20: Generic Drawer + Tabs + Toast Helpers (D-14) ===
  // Used by #dv-drawer-mqtt (refactored), #dv-drawer-notifications, #dv-drawer-vrm,
  // #dv-drawer-forecast. Per CONTEXT D-01/D-14 + UI-SPEC Component Inventory 1.

  function createDvDrawer(opts) {
    var root = opts && opts.root;
    var backdrop = opts && opts.backdrop;
    var onOpen = opts && opts.onOpen;
    var onClose = opts && opts.onClose;
    var escHandler = null;
    var closeTimer = null;
    var restoreFocusEl = null;

    function isOpen() { return !!(root && root.classList.contains('is-open')); }

    function open() {
      if (!root) return;
      // Cancel any pending close-hide so re-open during the 220ms window
      // doesn't re-hide the freshly-opened drawer (Pitfall 6).
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      // Single-drawer guarantee: close any other open .dv-drawer first.
      var others = document.querySelectorAll('.dv-drawer.is-open');
      for (var i = 0; i < others.length; i++) {
        if (others[i] !== root) others[i].classList.remove('is-open');
      }
      // Snapshot trigger for return-focus on close.
      restoreFocusEl = document.activeElement;
      root.hidden = false;
      if (backdrop) backdrop.hidden = false;
      requestAnimationFrame(function () {
        root.classList.add('is-open');
        if (backdrop) backdrop.classList.add('is-open');
        // Initial focus — first focusable inside drawer.
        var first = root.querySelector('input:not([type="hidden"]), button:not([disabled]), [role="tab"][aria-selected="true"], select, textarea, [tabindex]:not([tabindex="-1"])');
        if (first) { try { first.focus(); } catch (_) {} }
      });
      if (!escHandler) {
        escHandler = function (e) {
          if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); }
        };
        document.addEventListener('keydown', escHandler);
      }
      if (onOpen) { try { onOpen(); } catch (_) {} }
    }

    function close() {
      if (!root) return;
      if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
      root.classList.remove('is-open');
      if (backdrop) backdrop.classList.remove('is-open');
      closeTimer = setTimeout(function () {
        root.hidden = true;
        if (backdrop) backdrop.hidden = true;
        closeTimer = null;
        if (restoreFocusEl && typeof restoreFocusEl.focus === 'function') {
          try { restoreFocusEl.focus(); } catch (_) {}
        }
        restoreFocusEl = null;
      }, 220);
      if (onClose) { try { onClose(); } catch (_) {} }
    }

    return { open: open, close: close, isOpen: isOpen };
  }

  // Tab activation (ARIA APG pattern). One delegated tabKeyHandler per tablist;
  // registration in the per-drawer init below.
  function activateTab(tabId) {
    var tab = document.getElementById(tabId);
    if (!tab) return;
    var tablist = tab.closest('[role="tablist"]');
    if (!tablist) return;
    var sibs = tablist.querySelectorAll('[role="tab"]');
    for (var i = 0; i < sibs.length; i++) {
      var t = sibs[i];
      var on = t === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.setAttribute('tabindex', on ? '0' : '-1');
      var panelId = t.dataset.panel || t.getAttribute('aria-controls');
      if (panelId) {
        var p = document.getElementById(panelId);
        if (p) p.hidden = !on;
      }
    }
    try { tab.focus(); } catch (_) {}
  }

  function tabKeyHandler(e) {
    var allow = ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
    if (allow.indexOf(e.key) === -1) return;
    var tab = e.target.closest && e.target.closest('[role="tab"]');
    if (!tab) return;
    var list = tab.closest('[role="tablist"]');
    if (!list) return;
    e.preventDefault();
    var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    var idx = tabs.indexOf(tab);
    var next;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(idx + 1) % tabs.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(idx - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next) activateTab(next.id);
  }

  function showDrawerToast(name, variant, msg) {
    var toast = document.getElementById('dv-drawer-' + name + '-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.hidden = false;
    toast.classList.remove('is-ok', 'is-err', 'is-warn');
    if (variant) toast.classList.add('is-' + variant);
    requestAnimationFrame(function () { toast.classList.add('show'); });
    if (toast._dvTimer) clearTimeout(toast._dvTimer);
    toast._dvTimer = setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.hidden = true; }, 240);
    }, 3000);
  }

  // Shared test-send/test-probe client helper (D-05).
  // 5s minimum disable + button textContent swap + status feedback via toast.
  async function handleTestSend(buttonEl, drawerName, endpoint, bodyBuilder, okMsgBuilder, errMsgBuilder) {
    if (!buttonEl || buttonEl.disabled) return;
    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gesendet …';
    var startedAt = Date.now();
    try {
      var res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyBuilder())
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.status === 429) {
        showDrawerToast(drawerName, 'warn', '⏱ Zu viele Test-Sends. Erneut versuchen in ' + (data.retry_after_s || 60) + ' s.');
      } else if (res.ok && data.ok) {
        showDrawerToast(drawerName, 'ok', okMsgBuilder ? okMsgBuilder(data) : '✓ Test-Nachricht gesendet.');
      } else {
        showDrawerToast(drawerName, 'err', errMsgBuilder ? errMsgBuilder(data, res) : ('✗ Test fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status))));
      }
    } catch (e) {
      showDrawerToast(drawerName, 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      var elapsed = Date.now() - startedAt;
      var remain = Math.max(0, 5000 - elapsed);
      setTimeout(function () {
        buttonEl.disabled = false;
        buttonEl.textContent = origText;
      }, remain);
    }
  }

  async function fetchStatus() {
    try {
      // Phase 09.2 (revised 2026-05-15): merge BOTH endpoints. /health gives
      // per-system tracker metrics (latency/uptime/errors/sample-rate/firmware
      // + Featured-Row) for systems that have a tracker hook; /status gives
      // the rich legacy state (Tesla SOC, MQTT broker/topicCount, HA discovery,
      // notifications providers, devices list). Originally Wave 4 only fell
      // back to /status on HTTP error from /health, but /health returns 200
      // with sparse data → the legacy fields never reached the renderer →
      // Tesla/HA/Loxone/devices/notifications cards rendered with "—".
      var hres = await apiFetch('/api/integrations/health');
      var sres = await apiFetch('/api/integrations/status');
      var hdata = hres.ok ? await hres.json() : {};
      var sdata = sres.ok ? await sres.json() : {};
      // Per-system shallow merge: tracker fields (hdata[key]) override legacy
      // fields (sdata[key]) for the same property names, so newer metrics win.
      // Unknown extra keys on either side pass through.
      lastData = Object.assign({}, sdata, hdata);
      for (var key in sdata) {
        if (!Object.prototype.hasOwnProperty.call(sdata, key)) continue;
        if (sdata[key] && typeof sdata[key] === 'object' && hdata[key] && typeof hdata[key] === 'object') {
          lastData[key] = Object.assign({}, sdata[key], hdata[key]);
        }
      }
      renderAll(lastData);
    } catch (e) { /* keep showing last data */ }
  }

  function esc(str) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(str));
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtRel(ts) {
    if (!ts) return '—'; // em-dash
    var ms = typeof ts === 'string' ? new Date(ts).getTime() : Number(ts);
    if (!Number.isFinite(ms)) return '—';
    var delta = Date.now() - ms;
    if (delta < 0) return 'gerade';
    if (delta < 60000) return Math.floor(delta / 1000) + 's';
    if (delta < 3600000) return Math.floor(delta / 60000) + 'min';
    if (delta < 86400000) return Math.floor(delta / 3600000) + 'h';
    return Math.floor(delta / 86400000) + 'd';
  }

  // Phase 09.2 D-17 revised: format helpers for per-system health-tracker
  // values. All return '—' (em-dash) for null/undefined so cards stay
  // mockup-faithful when a system has not yet been observed by the tracker.
  function fmtLatency(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '—';
    return Math.round(ms) + ' ms';
  }
  function fmtUptime(s) {
    if (s == null || !Number.isFinite(Number(s))) return '—';
    var n = Math.floor(Number(s));
    if (n < 60) return n + 's';
    if (n < 3600) return Math.floor(n / 60) + 'm ' + (n % 60) + 's';
    if (n < 86400) return Math.floor(n / 3600) + 'h ' + Math.floor((n % 3600) / 60) + 'm';
    return Math.floor(n / 86400) + 'd ' + Math.floor((n % 86400) / 3600) + 'h';
  }
  function fmtCount(n) {
    return n != null && Number.isFinite(Number(n)) ? String(n) : '—';
  }
  function fmtSampleRate(histMs) {
    // Display a single representative sample interval: most-recent histogram
    // bucket. Operators reading the card know "I get a fresh value every Xs".
    if (!Array.isArray(histMs) || histMs.length === 0) return '—';
    var last = histMs[histMs.length - 1];
    if (!Number.isFinite(Number(last)) || last <= 0) return '—';
    if (last < 1000) return last + ' ms';
    return (last / 1000).toFixed(last < 10000 ? 1 : 0) + ' s';
  }

  function getSystemStatus(key, data) {
    // Phase 09.2 D-17 revised: when the health-tracker sets `status`, that is
    // the authoritative card state. Map ok|warn|err → online|stale|offline so
    // existing CSS (.conn-card.status-* + .conn-status-chip colour rules)
    // keeps working unchanged.
    if (data && typeof data.status === 'string') {
      if (data.status === 'ok') return 'online';
      if (data.status === 'warn') return 'stale';
      if (data.status === 'err') return 'offline';
    }
    switch (key) {
      case 'mqtt': return data.connected ? 'online' : 'offline';
      case 'tesla':
        if (!data.enabled) return 'disabled';
        if (!data.lastUpdate) return 'offline';
        var lastMs = typeof data.lastUpdate === 'string' ? new Date(data.lastUpdate).getTime() : (data.lastUpdate || 0);
        return (Date.now() - lastMs > STALE_THRESHOLD_MS) ? 'stale' : 'online';
      case 'homeAssistant': return data.haDiscovery ? 'online' : 'disabled';
      case 'loxone': return data.configured ? 'online' : 'disabled';
      case 'devices': return data.total > 0 ? 'online' : 'disabled';
      case 'notifications': return data.enabled ? 'online' : 'disabled';
      case 'vrm':
        // Phase 20-05 D-08: VRM card status. data comes from /api/integrations/status.vrm
        // subtree, which emits {enabled, vrmPortalId, vrmTokenSet}. Never a raw token.
        if (!data || !data.enabled) return 'disabled';
        if (!data.vrmTokenSet) return 'stale';
        return 'online';
      case 'forecast-providers': {
        // Phase 20-06 D-09: aggregated card. data comes from
        // /api/integrations/status['forecast-providers'] subtree (per-provider
        // booleans). Disabled = neither provider configured. Online = both
        // providers configured. Stale = exactly one configured (UI hint:
        // "Teilweise konfiguriert" — operator may want both for redundancy).
        if (!data) return 'disabled';
        var solcastOn = !!(data.solcast && data.solcast.apiKeySet);
        var pvnodeOn  = !!(data.pvnode  && data.pvnode.apiKeySet);
        if (!solcastOn && !pvnodeOn) return 'disabled';
        if (solcastOn && pvnodeOn) return 'online';
        return 'stale';
      }
      default: return 'disabled';
    }
  }

  function statusLabel(status) {
    return status === 'online' ? 'Online'
         : status === 'stale' ? 'Veraltet'
         : status === 'offline' ? 'Offline'
         : 'Inaktiv';
  }

  function statusDotClass(status) {
    return status === 'online' ? 'dot-ok'
         : status === 'stale' ? 'dot-warn'
         : status === 'offline' ? 'dot-danger'
         : 'dot-muted';
  }

  // Build the 4 stat tiles per system. Phase 09.4-04 (D-01): buildStats()
  // ALWAYS returns the 4 tracker tiles (Latency / Uptime|Sample / Errors·24h /
  // Last-data). Identity fields no longer render as tiles — they move to a
  // header subtitle line via buildIdentityLine() below. The /health + /status
  // merge already happens in fetchStatus() so the same merged `data` object
  // carries both data.latencyMs and data.broker. The defensive fmt* accessors
  // return '—' (em-dash) when a system has not yet been observed by the tracker.
  function buildStats(key, data) {
    switch (key) {
      case 'victron':
      case 'mid':
      case 'luox':
      case 'tesla':
        return [
          { label: 'Latency', value: fmtLatency(data.latencyMs) },
          { label: 'Uptime', value: fmtUptime(data.uptimeSec) },
          { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
          { label: 'Last sample', value: fmtRel(data.lastSampleAt) }
        ];
      case 'mqtt':
        return [
          { label: 'Latency', value: fmtLatency(data.latencyMs) },
          { label: 'Uptime', value: fmtUptime(data.uptimeSec) },
          { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
          { label: 'Last data', value: fmtRel(data.lastSampleAt) }
        ];
      case 'homeAssistant':
        return [
          { label: 'Latency', value: fmtLatency(data.latencyMs) },
          { label: 'Sample', value: fmtSampleRate(data.sampleIntervalHistogramMs) },
          { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
          { label: 'Last sync', value: fmtRel(data.lastSampleAt) }
        ];
      case 'loxone':
        return [
          { label: 'Latency', value: fmtLatency(data.latencyMs) },
          { label: 'Uptime', value: fmtUptime(data.uptimeSec) },
          { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
          { label: 'Last sync', value: fmtRel(data.lastSampleAt) }
        ];
      case 'devices':
        return [
          { label: 'Latency', value: fmtLatency(data.latencyMs) },
          { label: 'Sample', value: fmtSampleRate(data.sampleIntervalHistogramMs) },
          { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
          { label: 'Last sample', value: fmtRel(data.lastSampleAt) }
        ];
      case 'notifications':
        return [
          { label: 'Latency', value: fmtLatency(data.latencyMs) },
          { label: 'Sample', value: fmtSampleRate(data.sampleIntervalHistogramMs) },
          { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
          { label: 'Last send', value: fmtRel(data.lastSampleAt) }
        ];
      default:
        return [
          { label: '—', value: '—' },
          { label: '—', value: '—' },
          { label: '—', value: '—' },
          { label: '—', value: '—' }
        ];
    }
  }

  // Phase 09.4-04 (D-01/D-02): identity-in-header. Returns a STRING header
  // subtitle for systems with identity data on /api/integrations/status, or
  // null when no identity field is present — D-02 graceful degrade (the card
  // simply omits the line). The 4 tracker tiles from buildStats() are unchanged.
  function buildIdentityLine(key, data) {
    if (!data) return null;
    switch (key) {
      case 'mqtt':
        return data.broker || (data.embedded ? 'embedded' : null);
      case 'tesla': {
        var s = data.state || {};
        return s.name || s.vin || null;
      }
      case 'homeAssistant':
        return data.haDiscovery ? 'Auto-Discovery aktiv' : null;
      case 'loxone':
        return data.configured ? 'Miniserver konfiguriert' : null;
      case 'devices':
        return (data.total != null) ? (data.online + '/' + data.total + ' online') : null;
      case 'notifications': {
        var p = Array.isArray(data.providers) ? data.providers : [];
        // Dual-shape: legacy entries are strings (always "on"); D-06 entries
        // are {name,enabled} — count both so the line is correct during the
        // Wave 2→3 transition window (see buildCard's badge guard).
        var on = p.filter(function (x) {
          return typeof x === 'string' ? true : !!(x && x.enabled);
        }).length;
        return p.length ? (on + '/' + p.length + ' aktiv') : null;
      }
      case 'victron':
        return data.modelId || data.host || (data.firmware ? ('FW ' + data.firmware) : null);
      case 'mid':
        return data.serial || data.host || (data.firmware ? ('FW ' + data.firmware) : null);
      case 'luox':
        return data.identifier || (data.firmware ? ('FW ' + data.firmware) : null);
      case 'vrm':
        // Phase 20-05: identity-header reflects only the Portal-ID (token always redacted).
        // esc() wraps it (T-20-05-07 XSS mitigation — Portal-ID is operator-typed string).
        return data && data.vrmPortalId ? ('Portal ID: ' + esc(String(data.vrmPortalId))) : null;
      case 'forecast-providers': {
        // Phase 20-06: identity-header counts configured providers; never echos
        // any apiKey or siteId (T-20-06-01 — booleans only).
        var s = !!(data && data.solcast && data.solcast.apiKeySet);
        var p = !!(data && data.pvnode  && data.pvnode.apiKeySet);
        if (s && p) return '2 Provider konfiguriert';
        if (s) return 'Solcast konfiguriert';
        if (p) return 'pvnode konfiguriert';
        return null;
      }
      default:
        return null;
    }
  }

  // Filter bucket — segmented control state classification.
  //  - "connected": online OR stale (system is up, even if slow)
  //  - "disabled" : disabled OR offline (system needs operator attention OR isn't configured)
  function filterBucket(status) {
    if (status === 'online' || status === 'stale') return 'connected';
    return 'disabled';
  }

  // Phase 09.2 D-03: Activity-Pulse — per-card sample-density visualization.
  // CSP-safe (D-28): markup carries data-h="<percent>"; the actual height
  // is set via DOM property AFTER innerHTML by applyPulseHeights() so the
  // CSP `style-src` directive without 'unsafe-inline' never blocks the page.
  function buildPulseBars(hist) {
    if (!Array.isArray(hist) || !hist.length) return '';
    var max = 1;
    for (var i = 0; i < hist.length; i++) if (hist[i] > max) max = hist[i];
    var html = '<div class="conn-pulse" aria-hidden="true">';
    for (var j = 0; j < hist.length; j++) {
      // Invert: short interval → tall bar (more frequent samples = higher bar).
      var ms = Number(hist[j]) || max;
      var heightPct = Math.max(8, 100 - (ms / max) * 92);
      html += '<i class="pulse-bar" data-h="' + heightPct.toFixed(1) + '"></i>';
    }
    html += '</div>';
    return html;
  }

  function applyPulseHeights(rootEl) {
    if (!rootEl) return;
    var bars = rootEl.querySelectorAll('.pulse-bar[data-h]');
    for (var i = 0; i < bars.length; i++) {
      // CSP-safe: assign via DOM property setter — the CSP `style-src 'self'`
      // directive (no 'unsafe-inline' since 09.1-07) blocks the four forbidden
      // patterns inventoried in memory feedback_csp_style_src_inventory.md.
      // This per-property assignment is the one allowed alternative.
      bars[i].style.height = bars[i].dataset.h + '%';
    }
  }

  function buildCard(sys, data, status) {
    var stats = buildStats(sys.key, data);
    var identity = buildIdentityLine(sys.key, data);
    var dotClass = statusDotClass(status);
    var label = statusLabel(status);
    var cardClass = 'conn-card status-' + status + ' accent-' + sys.accent;
    var statsHtml = '';
    for (var i = 0; i < stats.length; i++) {
      var stat = stats[i];
      statsHtml += '<div class="conn-stat">'
        + '<span class="conn-stat-label">' + esc(stat.label) + '</span>'
        + '<span class="conn-stat-value">' + esc(stat.value) + '</span>'
        + '</div>';
    }
    var actions = '';
    if (sys.key === 'mqtt' || sys.key === 'tesla' || sys.key === 'homeAssistant' || sys.key === 'loxone' || sys.key === 'devices' || sys.key === 'notifications'
        || sys.key === 'victron' || sys.key === 'mid' || sys.key === 'luox') {
      actions = '<div class="conn-actions">'
        + '<a class="btn sm ghost" href="/settings.html#system">Logs</a>'
        + '<a class="btn sm" href="/settings.html">Konfig.</a>'
        + '</div>';
    }
    var pulseHtml = buildPulseBars(data && data.sampleIntervalHistogramMs);
    // Phase 09.4-04 (D-06): per-provider enabled/disabled badge strip for the
    // notifications card, WITH a dual-shape backward-compat guard
    // (RESEARCH Pitfall 6). The /api/integrations/status providers array
    // changed from string[] (pre-09.4-03) to {name,enabled}[] (09.4-03 D-06);
    // during the Wave 2→3 transition the backend — or a stale cached page —
    // may still serve either shape. Never .join() the array (that prints
    // [object Object]); render each entry per-field and esc() the name.
    var badges = '';
    if (sys.key === 'notifications' && Array.isArray(data && data.providers)) {
      badges = '<div class="conn-badges">';
      for (var b = 0; b < data.providers.length; b++) {
        var pr = data.providers[b];
        // A legacy string entry has no enabled flag — treat it as enabled
        // (it was only listed at all because the pre-D-06 filter kept actives).
        var n = (typeof pr === 'string') ? pr : ((pr && pr.name) || '');
        var isOn = (typeof pr === 'string') ? true : !!(pr && pr.enabled);
        var badgeCls = isOn ? 'conn-badge is-on' : 'conn-badge is-off';
        badges += '<span class="' + badgeCls + '">' + esc(n) + '</span>';
      }
      badges += '</div>';
    }
    return '<article class="' + cardClass + '" data-system="' + esc(sys.key) + '" data-status="' + esc(status) + '" data-filter="' + filterBucket(status) + '">'
      + '<header class="conn-head">'
        + '<div class="conn-logo">' + esc(sys.logo) + '</div>'
        + '<div class="conn-meta">'
          + '<div class="conn-name">' + esc(sys.label) + '</div>'
          + '<div class="conn-cat">' + esc(sys.category) + '</div>'
          + (identity ? ('<div class="conn-identity" title="' + esc(identity) + '">' + esc(identity) + '</div>') : '')
        + '</div>'
        + pulseHtml
        + '<span class="conn-status-chip"><span class="dot ' + dotClass + '"></span>' + esc(label) + '</span>'
      + '</header>'
      + '<div class="conn-stats">' + statsHtml + '</div>'
      + badges
      + actions
    + '</article>';
  }

  function renderAll(data) {
    var list = document.getElementById('intg-list');
    var empty = document.getElementById('intg-empty');
    if (!list) return;
    if (!data) return;

    // Build cards for EVERY system in the SYSTEMS catalogue. If the tracker
    // has no entry for a system yet, render the card with `{}` so the
    // defensive accessors below fall back to "—" placeholders. This matches
    // Phase 09.1's "honest gaps" intent: cards always present, missing
    // metrics show as dashes (and 09.2 fills them in as the tracker warms up).
    // Skipping based on `data[key]` presence (the original 09.2-04 behaviour)
    // hid configured systems that simply hadn't ticked yet — broken UX.
    var cards = [];
    var counts = { all: 0, connected: 0, disabled: 0 };
    var anyData = SYSTEMS.length > 0;
    for (var i = 0; i < SYSTEMS.length; i++) {
      var sys = SYSTEMS[i];
      var sysData = data[sys.key] || {};
      var status = getSystemStatus(sys.key, sysData);
      counts.all++;
      counts[filterBucket(status)]++;
      cards.push(buildCard(sys, sysData, status));
    }

    // Always preserve #intg-empty in the DOM as the list's first child —
    // hidden when we have data, visible when we don't. Keeps the
    // Wave-5 binding contract (#intg-empty always present) stable across
    // poll states. Playwright + binding-contract.mjs both check static IDs.
    list.innerHTML = '';
    if (empty) {
      empty.hidden = anyData;
      list.appendChild(empty);
    }
    if (!anyData) {
      updateFilterCounts({ all: 0, connected: 0, disabled: 0 });
      return;
    }
    for (var k = 0; k < cards.length; k++) {
      list.insertAdjacentHTML('beforeend', cards[k]);
    }
    // CSP-safe pulse-bar height application: must run AFTER the cards are
    // in the DOM. innerHTML strips style="…" attrs (CSP block); the
    // DOM property setter is allowed by `style-src 'self'`.
    applyPulseHeights(list);
    updateFilterCounts(counts);
    applyFilter(currentFilter);
  }

  function updateFilterCounts(counts) {
    var nodes = document.querySelectorAll('[data-count]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-count');
      nodes[i].textContent = String(counts[key] != null ? counts[key] : 0);
    }
  }

  function applyFilter(filter) {
    currentFilter = filter;
    var cards = document.querySelectorAll('#intg-list .conn-card');
    for (var i = 0; i < cards.length; i++) {
      var bucket = cards[i].getAttribute('data-filter');
      var show = filter === 'all' || bucket === filter;
      cards[i].hidden = !show;
    }
    // Update segmented active state
    var btns = document.querySelectorAll('[data-status-filter]');
    for (var j = 0; j < btns.length; j++) {
      var isActive = btns[j].getAttribute('data-status-filter') === filter;
      btns[j].classList.toggle('is-active', isActive);
      btns[j].setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  // Event delegation — segmented filter clicks (CSP-clean, no inline handlers).
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-status-filter]');
    if (!btn) return;
    applyFilter(btn.getAttribute('data-status-filter'));
  });

  /* ===================== FAMILY MQTT TILES EDITOR ===================== */
  // Operator-managed list of generic MQTT topics surfaced on the family page.
  // Persisted into config.family.mqttTiles via the dedicated
  // /api/family/mqtt-tiles endpoint, which merges server-side. (A partial
  // POST /api/config would destructively REPLACE the whole config.)

  function mteSlugId() {
    return 't' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  // Curated picker sets — the fixed UI-SPEC §"Curated emoji grid" / §"Curated
  // accent swatch palette" values. Phase 11-04 checkpoint feedback expanded the
  // emoji set from 28 to 48 (8 columns × 6 rows) — the original 28 are kept
  // (an already-picked icon must stay in the allowlist) and 20 common-household
  // glyphs were added, including a fan/ventilator pair 🌀 (cyclone) + 🪭
  // (folding hand fan). The 8 swatches are stored verbatim (mixed-case hex).
  // MTE_EMOJIS MUST stay byte-identical to FAMILY_TILE_ICON_ALLOWLIST in
  // routes-api.js or a newly-picked emoji is clipped off on save.
  var MTE_EMOJIS = [
    '⚡', '🔋', '☀️', '🔌', '💡', '🏠', '🌡️', '🪫',
    '💧', '🔥', '❄️', '💨', '🌬️', '☁️', '🌧️', '🌀',
    '🪭', '🔆', '🕯️', '🌫️', '🌪️', '🫧', '♻️', '🧯',
    '🛋️', '🛏️', '🚪', '🚿', '🍳', '🧺', '🪟', '🛁',
    '🚰', '🚽', '☕', '🍽️', '🧊', '🧴', '🔔', '🪥',
    '🚗', '📡', '🖥️', '📺', '🔊', '🌿', '🐾', '💻'
  ];
  var MTE_SWATCHES = [
    '#F7B731', '#26de81', '#4b7bec', '#22d3ee',
    '#a55eea', '#fd9644', '#ff6b6b', '#78909c'
  ];

  // Inline re-declaration of the tile-meta heuristic (per 11-01-SUMMARY:
  // family.js / integrations.js are browser IIFEs and cannot import the ESM
  // services/family/tile-meta.js without a bundler — tile-meta.js stays the
  // test's source of truth, this re-declares the SAME UI-SPEC table). Used
  // ONLY for the editor's "auto" preview glyph/colour on an unpicked row —
  // the auto value is never collected into the saved tile (Pitfall 4).
  var MTE_UNIT_RULES = [
    { re: /^(w|kw|mw)$/i, icon: '⚡', color: '#F7B731' },
    { re: /^(wh|kwh)$/i, icon: '🔋', color: '#26de81' },
    { re: /^(°c|°f|c|k)$/i, icon: '🌡️', color: '#ff6b6b' },
    { re: /^(%)$/i, icon: '💧', color: '#4b7bec' },
    { re: /^(v|a|hz)$/i, icon: '🔌', color: '#22d3ee' },
    { re: /^(ct|ct\/kwh|eur|€)$/i, icon: '💡', color: '#fd9644' },
    { re: /^(lx|lux)$/i, icon: '💡', color: '#F7B731' },
    { re: /^(ppm|µg\/m³)$/i, icon: '💨', color: '#4b7bec' }
  ];
  var MTE_TOPIC_RULES = [
    { re: /(tesla|car|ev)/i, icon: '🚗', color: '#a55eea' },
    { re: /(temp|klima)/i, icon: '🌡️', color: '#ff6b6b' }
  ];

  // autoTileMeta(tile) → { icon, color } — the auto-derived preview for an
  // unpicked row. Unit rules win over topic rules; no match → 📡 / Slate.
  function autoTileMeta(tile) {
    var unit = (tile && tile.unit != null) ? String(tile.unit).trim() : '';
    var topic = (tile && tile.topic != null) ? String(tile.topic) : '';
    var i;
    for (i = 0; i < MTE_UNIT_RULES.length; i++) {
      if (unit && MTE_UNIT_RULES[i].re.test(unit)) {
        return { icon: MTE_UNIT_RULES[i].icon, color: MTE_UNIT_RULES[i].color };
      }
    }
    for (i = 0; i < MTE_TOPIC_RULES.length; i++) {
      if (topic && MTE_TOPIC_RULES[i].re.test(topic)) {
        return { icon: MTE_TOPIC_RULES[i].icon, color: MTE_TOPIC_RULES[i].color };
      }
    }
    return { icon: '📡', color: '#78909c' };
  }

  function mteRowEl(tile) {
    var row = document.createElement('div');
    row.className = 'mte-row';
    row.setAttribute('data-id', (tile && tile.id) ? tile.id : mteSlugId());
    var fields = [
      { k: 'label', ph: 'Überschrift', cls: '' },
      { k: 'topic', ph: 'mqtt/topic', cls: '' },
      { k: 'field', ph: 'JSON-Feld (optional)', cls: 'mte-in-sm' },
      { k: 'unit', ph: 'Einheit', cls: 'mte-in-sm' }
    ];
    fields.forEach(function (f) {
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'mte-in' + (f.cls ? ' ' + f.cls : '');
      inp.setAttribute('data-k', f.k);
      inp.placeholder = f.ph;
      inp.value = (tile && tile[f.k] != null) ? String(tile[f.k]) : '';
      row.appendChild(inp);
    });
    // Symbol + Farbe picker cells (Phase 11-04, D-01/D-03). The auto preview
    // is derived from the unit/topic; an explicit tile.icon/tile.color
    // overrides it. Only an explicitly-set value tags the row via
    // data-icon/data-color — a brand-new/auto row carries NEITHER attribute
    // so it stays auto until the operator clicks a cell (Pitfall 4).
    var auto = autoTileMeta(tile);
    var hasIcon = !!(tile && tile.icon);
    var hasColor = !!(tile && tile.color);
    if (hasIcon) row.setAttribute('data-icon', tile.icon);
    if (hasColor) row.setAttribute('data-color', tile.color);

    // --- Symbol (emoji) picker cell ---
    var symCell = document.createElement('div');
    symCell.className = 'mte-symbol-cell';

    var symTrigger = document.createElement('button');
    symTrigger.type = 'button';
    symTrigger.className = 'mte-emoji-trigger' + (hasIcon ? '' : ' is-auto');
    symTrigger.setAttribute('data-action', 'mte-pick-icon');
    symTrigger.setAttribute('aria-label', 'Symbol wählen');
    symTrigger.textContent = hasIcon ? tile.icon : auto.icon;
    symCell.appendChild(symTrigger);

    var emojiGrid = document.createElement('div');
    emojiGrid.className = 'emoji-grid';
    MTE_EMOJIS.forEach(function (emo) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'emoji-cell' + (hasIcon && tile.icon === emo ? ' is-selected' : '');
      cell.setAttribute('data-emoji', emo);
      cell.textContent = emo;
      emojiGrid.appendChild(cell);
    });
    symCell.appendChild(emojiGrid);
    row.appendChild(symCell);

    // --- Farbe (swatch) picker cell ---
    var colCell = document.createElement('div');
    colCell.className = 'mte-color-cell';

    var colTrigger = document.createElement('button');
    colTrigger.type = 'button';
    colTrigger.className = 'mte-color-trigger' + (hasColor ? '' : ' is-auto');
    colTrigger.setAttribute('data-action', 'mte-pick-color');
    colTrigger.setAttribute('aria-label', 'Farbe wählen');
    // CSP-safe: per-element colour set via .style in JS, never a style= attr.
    colTrigger.style.background = hasColor ? tile.color : auto.color;
    colCell.appendChild(colTrigger);

    var swatchGrid = document.createElement('div');
    swatchGrid.className = 'swatch-grid';
    MTE_SWATCHES.forEach(function (hex) {
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'swatch-cell' + (hasColor && tile.color === hex ? ' is-selected' : '');
      cell.setAttribute('data-swatch', hex);
      cell.style.background = hex; // CSP-safe: .style in JS, not a style= attr
      swatchGrid.appendChild(cell);
    });
    colCell.appendChild(swatchGrid);
    row.appendChild(colCell);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'mte-del';
    del.setAttribute('data-action', 'mte-del');
    del.setAttribute('aria-label', 'Kachel entfernen');
    del.textContent = '✕';
    row.appendChild(del);
    return row;
  }

  function mteRefreshEmpty() {
    var rows = document.getElementById('mteRows');
    var empty = document.getElementById('mteEmpty');
    if (rows && empty) empty.hidden = rows.children.length > 0;
  }

  function mteRenderRows(tiles) {
    var rows = document.getElementById('mteRows');
    if (!rows) return;
    rows.innerHTML = '';
    (tiles || []).forEach(function (t) { rows.appendChild(mteRowEl(t)); });
    mteRefreshEmpty();
  }

  function mteSetStatus(msg, kind) {
    var el = document.getElementById('mteStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'mte-status' + (kind ? ' is-' + kind : '');
  }

  async function loadMqttTilesEditor() {
    var rows = document.getElementById('mteRows');
    if (!rows) return; // editor not present on this page
    try {
      var res = await apiFetch('/api/family/mqtt-tiles');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      mteRenderRows(Array.isArray(data.tiles) ? data.tiles : []);
    } catch (e) {
      mteSetStatus('Konfiguration konnte nicht geladen werden.', 'err');
    }
  }

  function mteCollect() {
    var out = [];
    var rows = document.getElementById('mteRows');
    if (!rows) return out;
    var rowEls = rows.querySelectorAll('.mte-row');
    for (var i = 0; i < rowEls.length; i++) {
      var r = rowEls[i];
      var get = function (k) {
        var inp = r.querySelector('[data-k="' + k + '"]');
        return inp ? inp.value.trim() : '';
      };
      var topic = get('topic');
      if (!topic) continue; // a row without a topic is incomplete — skip it
      var tile = {
        id: r.getAttribute('data-id') || mteSlugId(),
        label: get('label') || topic,
        topic: topic
      };
      var field = get('field');
      var unit = get('unit');
      if (field) tile.field = field;
      if (unit) tile.unit = unit;
      // Additive icon/color — collected ONLY when the operator picked one
      // (the row carries data-icon/data-color). An unpicked row serialises
      // WITHOUT these keys so the kiosk auto-derives them (D-02/D-04). The
      // trigger's displayed auto-preview glyph/colour is NOT read (Pitfall 4).
      var icon = r.getAttribute('data-icon');
      var color = r.getAttribute('data-color');
      if (icon) tile.icon = icon;
      if (color) tile.color = color;
      out.push(tile);
    }
    return out;
  }

  async function saveMqttTiles() {
    var btn = document.getElementById('mteSave');
    var tiles = mteCollect();
    mteSetStatus('Speichern …', '');
    if (btn) btn.disabled = true;
    try {
      var res = await apiFetch('/api/family/mqtt-tiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiles: tiles })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      var saved = Array.isArray(data.tiles) ? data.tiles : tiles;
      mteRenderRows(saved); // reflect server-normalised ids/labels
      mteSetStatus(saved.length + ' Kachel(n) gespeichert — erscheinen auf der Familienseite ✓', 'ok');
    } catch (e) {
      mteSetStatus('Fehler beim Speichern: ' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Close every open emoji/swatch grid in the editor (click-outside-to-close
  // and pre-toggle "close the others" helper).
  function mteCloseAllGrids() {
    var open = document.querySelectorAll('#mteRows .emoji-grid.is-open, #mteRows .swatch-grid.is-open');
    for (var i = 0; i < open.length; i++) open[i].classList.remove('is-open');
  }

  // Editor event delegation — separate from the segmented-filter listener
  // above. Extended (Phase 11-04) with the emoji/swatch picker branches —
  // ONE delegated listener, no inline on*= handlers.
  document.addEventListener('click', function (e) {
    var del = e.target.closest('[data-action="mte-del"]');
    if (del) {
      var row = del.closest('.mte-row');
      if (row && row.parentNode) row.parentNode.removeChild(row);
      mteRefreshEmpty();
      return;
    }
    if (e.target.closest('#mteAdd')) {
      var rows = document.getElementById('mteRows');
      if (rows) { rows.appendChild(mteRowEl(null)); mteRefreshEmpty(); }
      return;
    }
    if (e.target.closest('#mteSave')) { saveMqttTiles(); return; }

    // --- Symbol picker: toggle the sibling emoji grid ---
    var iconTrig = e.target.closest('[data-action="mte-pick-icon"]');
    if (iconTrig) {
      var grid = iconTrig.parentNode.querySelector('.emoji-grid');
      var wasOpen = grid && grid.classList.contains('is-open');
      mteCloseAllGrids();
      if (grid && !wasOpen) grid.classList.add('is-open');
      return;
    }
    // --- Farbe picker: toggle the sibling swatch grid ---
    var colorTrig = e.target.closest('[data-action="mte-pick-color"]');
    if (colorTrig) {
      var sGrid = colorTrig.parentNode.querySelector('.swatch-grid');
      var sWasOpen = sGrid && sGrid.classList.contains('is-open');
      mteCloseAllGrids();
      if (sGrid && !sWasOpen) sGrid.classList.add('is-open');
      return;
    }
    // --- Emoji cell picked: tag the row, update the trigger, close ---
    var emojiCell = e.target.closest('.emoji-cell');
    if (emojiCell) {
      var eRow = emojiCell.closest('.mte-row');
      var emo = emojiCell.getAttribute('data-emoji');
      if (eRow && emo) {
        eRow.setAttribute('data-icon', emo);
        var eTrig = eRow.querySelector('.mte-emoji-trigger');
        if (eTrig) { eTrig.textContent = emo; eTrig.classList.remove('is-auto'); }
        var eGrid = emojiCell.closest('.emoji-grid');
        if (eGrid) {
          var prev = eGrid.querySelector('.emoji-cell.is-selected');
          if (prev) prev.classList.remove('is-selected');
          emojiCell.classList.add('is-selected');
          eGrid.classList.remove('is-open');
        }
      }
      return;
    }
    // --- Swatch cell picked: tag the row, update the trigger, close ---
    var swatchCell = e.target.closest('.swatch-cell');
    if (swatchCell) {
      var sRow = swatchCell.closest('.mte-row');
      var hex = swatchCell.getAttribute('data-swatch');
      if (sRow && hex) {
        sRow.setAttribute('data-color', hex);
        var sTrig = sRow.querySelector('.mte-color-trigger');
        // CSP-safe: per-element colour set via .style in JS.
        if (sTrig) { sTrig.style.background = hex; sTrig.classList.remove('is-auto'); }
        var sCellGrid = swatchCell.closest('.swatch-grid');
        if (sCellGrid) {
          var sPrev = sCellGrid.querySelector('.swatch-cell.is-selected');
          if (sPrev) sPrev.classList.remove('is-selected');
          swatchCell.classList.add('is-selected');
          sCellGrid.classList.remove('is-open');
        }
      }
      return;
    }
    // --- Click outside any picker → close every open grid ---
    mteCloseAllGrids();
  });

  /* ===================== MQTT INSPECTOR DRAWER ===================== */
  // Phase 09.4-05 (D-03/D-04). A slide-over drawer opened by clicking the MQTT
  // .conn-card. While open it polls GET /api/integrations/mqtt/topics every 4s
  // (within the D-04 3-5s band) and renders a per-topic table — topic name,
  // message count, last-message relative time, last-payload preview. The
  // drawer is plain static markup in integrations.html; this code only toggles
  // the .is-open class + the hidden attribute (no display-property writes —
  // CSP 09.1-07) and fills #mqtt-drawer-topics. Closes on the close button, a
  // backdrop click, and the Escape key. ALL broker-supplied strings (topic
  // names AND payloads) pass through esc() before insertAdjacentHTML — the
  // payload is untrusted data published by any device on the broker
  // (RESEARCH Pitfall 3 — XSS via MQTT payload).

  var MQTT_DRAWER_POLL_MS = 4000;
  var mqttPollTimer = null;
  var mqttDrawerEls = null;
  // Phase 09.4 gap-closure: operator pause/resume of the topics poll loop.
  // Values scroll past too fast on a busy broker — paused stops the
  // setInterval so the table holds still and stays readable.
  var mqttDrawerPaused = false;

  function getMqttDrawerEls() {
    if (mqttDrawerEls) return mqttDrawerEls;
    var drawer = document.getElementById('dv-drawer-mqtt');
    if (!drawer) return null; // drawer markup not on this page
    mqttDrawerEls = {
      drawer: drawer,
      backdrop: document.getElementById('dv-drawer-mqtt-backdrop'),
      close: document.getElementById('dv-drawer-mqtt-close'),
      pause: document.getElementById('mqtt-drawer-pause'),
      topics: document.getElementById('mqtt-drawer-topics'),
      meta: document.getElementById('mqtt-drawer-meta')
    };
    return mqttDrawerEls;
  }

  // Reflect the paused/running state onto the pause button + drawer. CSP-clean:
  // a .is-paused class toggle on the drawer (no style.display writes) drives the
  // "pausiert" badge in CSS; the button label/aria-pressed switch in JS.
  function applyMqttPauseState() {
    var els = getMqttDrawerEls();
    if (!els) return;
    els.drawer.classList.toggle('is-paused', mqttDrawerPaused);
    if (els.pause) {
      // ⏸ Pause when running, ▶ Fortsetzen when paused.
      els.pause.textContent = mqttDrawerPaused ? '▶ Fortsetzen' : '⏸ Pause';
      els.pause.setAttribute('aria-pressed', mqttDrawerPaused ? 'true' : 'false');
    }
  }

  // Phase 20 D-14: ESC handling now lives inside createDvDrawer's escHandler —
  // the standalone mqttDrawerKeyHandler was removed during the refactor.

  async function pollMqttTopics() {
    var els = getMqttDrawerEls();
    if (!els || !els.topics) return;
    try {
      var res = await apiFetch('/api/integrations/mqtt/topics');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      // Pitfall 7 — distinguish "MQTT off" from "no topics yet". The endpoint
      // reports connected:false when the hub is not connected; show an
      // explicit state rather than a blank table.
      if (data && data.connected === false) {
        if (els.meta) els.meta.textContent = 'MQTT nicht verbunden';
        els.topics.innerHTML = '<p class="dv-drawer-empty">MQTT ist derzeit nicht verbunden. '
          + 'Sobald der Broker erreichbar ist, erscheinen hier die beobachteten Topics.</p>';
        return;
      }
      var topics = (data && Array.isArray(data.topics)) ? data.topics : [];
      var total = (data && data.total != null) ? data.total : topics.length;
      if (els.meta) {
        els.meta.textContent = data && data.observedSince
          ? (total + ' Topics · seit ' + fmtRel(data.observedSince))
          : (total + ' Topics');
      }
      if (!topics.length) {
        els.topics.innerHTML = '<p class="dv-drawer-empty">Noch keine Topics beobachtet — '
          + 'sobald Geräte auf dem Broker publizieren, erscheinen sie hier.</p>';
        return;
      }
      var html = '';
      for (var i = 0; i < topics.length; i++) {
        var t = topics[i] || {};
        // esc() BOTH the topic name AND the payload — untrusted broker data.
        html += '<div class="mqtt-topic-row">'
          + '<div class="mqtt-topic-head">'
            + '<span class="mqtt-topic-name">' + esc(t.topic) + '</span>'
            + '<span class="mqtt-topic-count">' + esc(String(t.count != null ? t.count : 0)) + '×</span>'
            + '<span class="mqtt-topic-time">' + esc(fmtRel(t.lastAt)) + '</span>'
          + '</div>'
          + '<span class="mqtt-topic-payload">' + esc(t.lastPayload != null ? t.lastPayload : '') + '</span>'
          + '</div>';
      }
      els.topics.innerHTML = html;
    } catch (e) {
      // Friendly message — never throw out of the poll loop.
      if (els.meta) els.meta.textContent = 'Topics konnten nicht geladen werden.';
    }
  }

  // Start (or restart) the topics poll loop. Centralised so the pause/resume
  // toggle and openMqttDrawer() share one code path.
  function startMqttPoll() {
    if (mqttPollTimer) clearInterval(mqttPollTimer);
    mqttPollTimer = setInterval(pollMqttTopics, MQTT_DRAWER_POLL_MS);
  }
  function stopMqttPoll() {
    if (mqttPollTimer) { clearInterval(mqttPollTimer); mqttPollTimer = null; }
  }

  // Pause/resume toggle. Paused → clearInterval the loop (the table freezes on
  // the last snapshot); resumed → an immediate poll + restart the interval.
  function toggleMqttPause() {
    mqttDrawerPaused = !mqttDrawerPaused;
    if (mqttDrawerPaused) {
      stopMqttPoll();
    } else {
      pollMqttTopics();
      startMqttPoll();
    }
    applyMqttPauseState();
  }

  // Phase 20 D-14: MQTT drawer now delegates open/close lifecycle to the
  // generic createDvDrawer helper. The lifecycle hooks bind the MQTT-specific
  // poll loop on open and stop it on close. mqttDrawerInstance is lazily
  // created on first open so getMqttDrawerEls() (and therefore the markup
  // lookup) does not run at module load.
  var mqttDrawerInstance = null;
  function openMqttDrawer() {
    var els = getMqttDrawerEls();
    if (!els) return;
    mqttDrawerPaused = false;
    applyMqttPauseState();
    if (!mqttDrawerInstance) {
      mqttDrawerInstance = createDvDrawer({
        root: els.drawer,
        backdrop: els.backdrop,
        onOpen: function () { pollMqttTopics(); startMqttPoll(); },
        onClose: function () { stopMqttPoll(); }
      });
    }
    mqttDrawerInstance.open();
  }
  function closeMqttDrawer() {
    if (mqttDrawerInstance) mqttDrawerInstance.close();
  }

  // === Phase 20: Unified Drawer Trigger Delegation ===
  // ONE document-level click listener handles backdrop-click, close-button,
  // and conn-card → drawer routing. ESC is handled per-drawer via
  // createDvDrawer's escHandler (registered on open, removed on close).
  var dvDrawerInstances = {};   // name → instance, lazily initialised by per-drawer code
  function getOrCreateDrawer(name) {
    if (dvDrawerInstances[name]) return dvDrawerInstances[name];
    var root = document.getElementById('dv-drawer-' + name);
    var backdrop = document.getElementById('dv-drawer-' + name + '-backdrop');
    if (!root) return null;
    var inst = createDvDrawer({ root: root, backdrop: backdrop });
    dvDrawerInstances[name] = inst;
    return inst;
  }

  document.addEventListener('click', function (e) {
    // Inline element-specific intercepts that other handlers (pause/refresh) own.
    if (e.target.closest('#mqtt-drawer-pause')) { toggleMqttPause(); return; }

    // Close button — any element with .dv-drawer-close inside any .dv-drawer.
    var closeBtn = e.target.closest('.dv-drawer-close');
    if (closeBtn) {
      var drawer = closeBtn.closest('.dv-drawer');
      if (drawer && drawer.id.indexOf('dv-drawer-') === 0) {
        var nameC = drawer.id.replace('dv-drawer-', '');
        if (nameC === 'mqtt') { closeMqttDrawer(); return; }
        var instC = getOrCreateDrawer(nameC);
        if (instC) instC.close();
        return;
      }
    }

    // Backdrop click closes.
    var bd = e.target.closest('.dv-drawer-backdrop');
    if (bd && bd.id.indexOf('dv-drawer-') === 0) {
      var nameB = bd.id.replace('dv-drawer-', '').replace(/-backdrop$/, '');
      if (nameB === 'mqtt') { closeMqttDrawer(); return; }
      var instB = getOrCreateDrawer(nameB);
      if (instB) instB.close();
      return;
    }

    // Inside any open .dv-drawer body — allow tab switching, otherwise ignore.
    if (e.target.closest('.dv-drawer')) {
      var tabBtn = e.target.closest('[role="tab"][data-panel]');
      if (tabBtn) { activateTab(tabBtn.id); return; }
      return;
    }

    // Action-link inside card should navigate, not open drawer.
    if (e.target.closest('a')) return;

    // Card → drawer routing by data-system.
    var mqttCard = e.target.closest('.conn-card[data-system="mqtt"]');
    if (mqttCard) { e.preventDefault(); openMqttDrawer(); return; }
    var notifCard = e.target.closest('.conn-card[data-system="notifications"]');
    if (notifCard) {
      e.preventDefault();
      var inst = getOrCreateDrawer('notifications');
      if (inst) inst.open();
      return;
    }
    var vrmCard = e.target.closest('.conn-card[data-system="vrm"]');
    if (vrmCard) {
      e.preventDefault();
      var inst2 = getOrCreateDrawer('vrm');
      if (inst2) inst2.open();
      return;
    }
    var fcCard = e.target.closest('.conn-card[data-system="forecast-providers"]');
    if (fcCard) {
      e.preventDefault();
      var inst3 = getOrCreateDrawer('forecast');
      if (inst3) inst3.open();
      return;
    }
    // Phase 21 (2026-05-23): TeslaMate card → drawer (Einstellungen + Live +
    // Ladevorgänge). loadTeslaSettings/Snapshot are queued via setTimeout(0)
    // so the drawer animation paints before the GET kicks off.
    var teslaCard = e.target.closest('.conn-card[data-system="tesla"]');
    if (teslaCard) {
      e.preventDefault();
      var inst4 = getOrCreateDrawer('tesla');
      if (inst4) inst4.open();
      setTimeout(loadTeslaSettings, 0);
      setTimeout(loadTeslaSnapshot, 0);
      setTimeout(function () { loadTeslaSessions(7); }, 0);
      return;
    }
  });

  // Wire tab keyboard navigation on every [role="tablist"] inside .dv-drawer.
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.closest && e.target.closest('.dv-drawer [role="tablist"]')) {
      tabKeyHandler(e);
    }
  });

  // === Phase 20-01: ntfy.sh Tab Wiring (first migration provider into the new dv-drawer) ===
  async function loadNtfyTab() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/notifications/providers/ntfy');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data || !data.ok) return;
      var enabledEl = el('notif-ntfy-enabled');
      if (enabledEl) enabledEl.checked = !!data.enabled;
      var urlEl = el('notif-ntfy-topicurl');
      if (urlEl) urlEl.value = data.topicUrl || '';
      var tokEl = el('notif-ntfy-token');
      // '***' = stored, keep field empty; placeholder explains.
      if (tokEl) tokEl.value = (data.token && data.token !== '***') ? data.token : '';
    } catch (e) {
      showDrawerToast('notifications', 'err', '✗ ntfy laden fehlgeschlagen: ' + e.message);
    }
  }
  function collectNtfyBody() {
    var el = function (id) { return document.getElementById(id); };
    var typedToken = (el('notif-ntfy-token') && el('notif-ntfy-token').value) || '';
    return {
      enabled: !!(el('notif-ntfy-enabled') && el('notif-ntfy-enabled').checked),
      topicUrl: (el('notif-ntfy-topicurl') && el('notif-ntfy-topicurl').value.trim()) || '',
      // empty input → '***' sentinel (= keep-existing). Non-empty → actual value.
      token: typedToken ? typedToken.trim() : '***'
    };
  }
  async function saveNtfyTab(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/notifications/providers/ntfy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectNtfyBody())
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data.ok) {
        showDrawerToast('notifications', 'ok', '✓ Gespeichert.');
        // Re-load so the token field returns to the empty placeholder (D-13).
        await loadNtfyTab();
      } else {
        showDrawerToast('notifications', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('notifications', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  // Per-tab button handler delegation + SINGLE consolidated card-open loader
  // (WR-04). The Notifications card-open click loads ALL four tabs in
  // default-active-first order (Pushover is the visible tab per HTML
  // aria-selected="true") so the operator sees live data immediately on the
  // default tab and tab-switches don't re-fetch. The other three per-tab
  // listeners (Telegram, Pushover, Kuma) no longer trigger their own
  // setTimeout(loadXxxTab) on the card-open — they only handle save/test
  // button clicks. This collapses 4 simultaneous GETs into a single
  // coordinated load and 3 redundant pushLog entries per drawer open.
  document.addEventListener('click', function (e) {
    if (e.target.closest('.conn-card[data-system="notifications"]')) {
      setTimeout(function () {
        loadPushoverTab();   // default-active tab — load first
        loadNtfyTab();
        loadTelegramTab();
        loadKumaTab();
      }, 0);
    }
    var saveBtn = e.target.closest('#notif-ntfy-save');
    if (saveBtn) { saveNtfyTab(saveBtn); return; }
    var testBtn = e.target.closest('#notif-ntfy-test');
    if (testBtn) {
      handleTestSend(
        testBtn,
        'notifications',
        '/api/notifications/providers/ntfy/test',
        collectNtfyBody,
        function () { return '✓ Test-Nachricht gesendet (ntfy).'; },
        null
      );
      return;
    }
  });

  // === Phase 20-02: Telegram Tab Wiring ===
  // Mirrors the ntfy pattern above (D-13 '***' sentinel, D-16 CSP-clean
  // DOM updates, D-12 dedicated server-side-merge endpoint). Adds a
  // pre-submit numeric validation for the chatId field per UI-SPEC
  // § Form-Validation Display.
  async function loadTelegramTab() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/notifications/providers/telegram');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data || !data.ok) return;
      var enabledEl = el('notif-telegram-enabled');
      if (enabledEl) enabledEl.checked = !!data.enabled;
      var tokEl = el('notif-telegram-bottoken');
      // '***' = stored, keep field empty; placeholder explains.
      if (tokEl) tokEl.value = (data.botToken && data.botToken !== '***') ? data.botToken : '';
      var chatEl = el('notif-telegram-chatid');
      if (chatEl) chatEl.value = (data.chatId && data.chatId !== '***') ? data.chatId : '';
    } catch (e) {
      showDrawerToast('notifications', 'err', '✗ Telegram laden fehlgeschlagen: ' + e.message);
    }
  }
  function collectTelegramBody() {
    var el = function (id) { return document.getElementById(id); };
    var typedToken = (el('notif-telegram-bottoken') && el('notif-telegram-bottoken').value) || '';
    var typedChat = (el('notif-telegram-chatid') && el('notif-telegram-chatid').value) || '';
    return {
      enabled: !!(el('notif-telegram-enabled') && el('notif-telegram-enabled').checked),
      // empty input → '***' sentinel (= keep-existing). Non-empty → actual value.
      botToken: typedToken ? typedToken.trim() : '***',
      chatId: typedChat ? typedChat.trim() : '***'
    };
  }
  async function saveTelegramTab(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    // Pre-submit chatId numeric validation (UI-SPEC § Form-Validation Display).
    // Skip validation when chatId is empty AND we have a stored value (the
    // '***' sentinel will keep it on the server); otherwise enforce ^-?\d+$.
    var banner = document.getElementById('notif-telegram-banner');
    var enabled = !!(document.getElementById('notif-telegram-enabled') && document.getElementById('notif-telegram-enabled').checked);
    var chatTyped = ((document.getElementById('notif-telegram-chatid') && document.getElementById('notif-telegram-chatid').value) || '').trim();
    if (enabled && chatTyped && !/^-?\d+$/.test(chatTyped)) {
      if (banner) {
        banner.textContent = 'Chat-ID muss numerisch sein (z.B. 123456789 oder -1001234567890 für Gruppen).';
        banner.hidden = false;
      }
      return;
    }
    if (banner) banner.hidden = true;

    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/notifications/providers/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectTelegramBody())
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data.ok) {
        showDrawerToast('notifications', 'ok', '✓ Gespeichert.');
        // Re-load so the token field returns to the empty placeholder (D-13).
        await loadTelegramTab();
      } else {
        showDrawerToast('notifications', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('notifications', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  // Per-tab button handler delegation. The consolidated card-open loader in
  // the ntfy block above already triggers loadTelegramTab() once per drawer
  // open (WR-04). This listener only handles the save/test button clicks.
  document.addEventListener('click', function (e) {
    var saveBtn = e.target.closest('#notif-telegram-save');
    if (saveBtn) { saveTelegramTab(saveBtn); return; }
    var testBtn = e.target.closest('#notif-telegram-test');
    if (testBtn) {
      handleTestSend(
        testBtn,
        'notifications',
        '/api/notifications/providers/telegram/test',
        collectTelegramBody,
        function () { return '✓ Test-Nachricht gesendet (Telegram).'; },
        null
      );
      return;
    }
  });

  // === Phase 20-03: Pushover Tab Wiring ===
  // Mirrors the Telegram pattern above (D-13 '***' sentinel on BOTH appToken
  // and userKey, D-16 CSP-clean DOM updates, D-12 dedicated server-side-merge
  // endpoint). Adds a pre-submit 30-character alphanumeric validation for both
  // fields per UI-SPEC § Form-Validation Display (lines 743-744).
  async function loadPushoverTab() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/notifications/providers/pushover');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data || !data.ok) return;
      var enabledEl = el('notif-pushover-enabled');
      if (enabledEl) enabledEl.checked = !!data.enabled;
      var appEl = el('notif-pushover-apptoken');
      // '***' = stored, keep field empty; placeholder explains.
      if (appEl) appEl.value = (data.appToken && data.appToken !== '***') ? data.appToken : '';
      var userEl = el('notif-pushover-userkey');
      if (userEl) userEl.value = (data.userKey && data.userKey !== '***') ? data.userKey : '';
    } catch (e) {
      showDrawerToast('notifications', 'err', '✗ Pushover laden fehlgeschlagen: ' + e.message);
    }
  }
  function collectPushoverBody() {
    var el = function (id) { return document.getElementById(id); };
    var typedApp = (el('notif-pushover-apptoken') && el('notif-pushover-apptoken').value) || '';
    var typedUser = (el('notif-pushover-userkey') && el('notif-pushover-userkey').value) || '';
    return {
      enabled: !!(el('notif-pushover-enabled') && el('notif-pushover-enabled').checked),
      // empty input → '***' sentinel (= keep-existing). Non-empty → actual value.
      appToken: typedApp ? typedApp.trim() : '***',
      userKey: typedUser ? typedUser.trim() : '***'
    };
  }
  async function savePushoverTab(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    // Pre-submit length validation (30 alphanumeric chars) per UI-SPEC
    // § Form-Validation Display (lines 743-744). Skip the regex when the
    // field is empty AND we have a stored value (the '***' sentinel will
    // keep it on the server); otherwise enforce ^[A-Za-z0-9]{30}$.
    var banner = document.getElementById('notif-pushover-banner');
    var enabled = !!(document.getElementById('notif-pushover-enabled') && document.getElementById('notif-pushover-enabled').checked);
    var appTyped = ((document.getElementById('notif-pushover-apptoken') || {}).value || '').trim();
    var userTyped = ((document.getElementById('notif-pushover-userkey') || {}).value || '').trim();
    var errors = [];
    if (enabled && appTyped && !/^[A-Za-z0-9]{30}$/.test(appTyped)) {
      errors.push('App-Token muss 30 alphanumerische Zeichen lang sein.');
    }
    if (enabled && userTyped && !/^[A-Za-z0-9]{30}$/.test(userTyped)) {
      errors.push('User-Key muss 30 alphanumerische Zeichen lang sein.');
    }
    if (errors.length) {
      if (banner) {
        banner.textContent = errors.join(' ');
        banner.hidden = false;
      }
      return;
    }
    if (banner) banner.hidden = true;

    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/notifications/providers/pushover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectPushoverBody())
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data.ok) {
        showDrawerToast('notifications', 'ok', '✓ Gespeichert.');
        // Re-load so the token fields return to the empty placeholder (D-13).
        await loadPushoverTab();
      } else {
        showDrawerToast('notifications', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('notifications', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  // Per-tab button handler delegation. The consolidated card-open loader in
  // the ntfy block above already triggers loadPushoverTab() (first, since
  // Pushover is the default-active tab) once per drawer open (WR-04). This
  // listener only handles the save/test button clicks.
  document.addEventListener('click', function (e) {
    var saveBtn = e.target.closest('#notif-pushover-save');
    if (saveBtn) { savePushoverTab(saveBtn); return; }
    var testBtn = e.target.closest('#notif-pushover-test');
    if (testBtn) {
      handleTestSend(
        testBtn,
        'notifications',
        '/api/notifications/providers/pushover/test',
        collectPushoverBody,
        function () { return '✓ Test-Nachricht gesendet (Pushover).'; },
        null
      );
      return;
    }
  });

  // === Phase 20-04: Uptime-Kuma Tab Wiring ===
  // KRITISCH: writes to cfg.monitoring.* NOT cfg.notifications.providers.uptime-kuma
  // (Pitfall 1 — Phase 09.4 gap-closure already cleaned this up once).
  // Test-Push goes via a direct SSRF-guarded fetch in the backend
  // (Pitfall 5 — ctx.monitoringAlertPush would no-op for unsaved URLs).
  async function loadKumaTab() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/integrations/uptime-kuma');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data || !data.ok) return;
      if (el('notif-kuma-enabled')) el('notif-kuma-enabled').checked = !!data.enabled;
      // pushUrl is shown in clear per Phase 09.4-06 decision: the path-token
      // is operator-set, never historically redacted, and the operator needs
      // to see which monitor their heartbeat writes to.
      if (el('notif-kuma-pushurl')) el('notif-kuma-pushurl').value = data.pushUrl || '';
      if (el('notif-kuma-interval')) el('notif-kuma-interval').value = data.pushIntervalSec || 240;
    } catch (e) {
      showDrawerToast('notifications', 'err', '✗ Uptime-Kuma laden fehlgeschlagen: ' + e.message);
    }
  }
  function collectKumaBody() {
    var el = function (id) { return document.getElementById(id); };
    return {
      enabled: !!(el('notif-kuma-enabled') && el('notif-kuma-enabled').checked),
      pushUrl: ((el('notif-kuma-pushurl') && el('notif-kuma-pushurl').value) || '').trim(),
      pushIntervalSec: Number((el('notif-kuma-interval') && el('notif-kuma-interval').value) || 240)
    };
  }
  async function saveKumaTab(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    var banner = document.getElementById('notif-kuma-banner');
    var body = collectKumaBody();
    var errors = [];
    // Validation only runs when the integration is enabled — allows the operator
    // to disable Kuma without losing their stored push-URL (Pitfall: validation
    // would reject a now-disabled-but-still-stored URL on subsequent saves).
    if (body.enabled) {
      if (!/^https:\/\//.test(body.pushUrl) || body.pushUrl.indexOf('/api/push/') === -1) {
        errors.push('Push-URL: https://<kuma>/api/push/<token>');
      }
      if (!(body.pushIntervalSec >= 30 && body.pushIntervalSec <= 600)) {
        errors.push('Heartbeat-Intervall: 30 bis 600 Sekunden.');
      }
    }
    if (errors.length) {
      if (banner) {
        banner.textContent = errors.join(' ');
        banner.hidden = false;
      }
      return;
    }
    if (banner) banner.hidden = true;

    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/integrations/uptime-kuma', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data.ok) {
        showDrawerToast('notifications', 'ok', '✓ Gespeichert.');
        await loadKumaTab();
      } else {
        showDrawerToast('notifications', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('notifications', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  // The consolidated card-open loader in the ntfy block above already
  // triggers loadKumaTab() once per drawer open (WR-04). This listener only
  // handles the save/test button clicks.
  document.addEventListener('click', function (e) {
    var saveBtn = e.target.closest('#notif-kuma-save');
    if (saveBtn) { saveKumaTab(saveBtn); return; }
    var testBtn = e.target.closest('#notif-kuma-test');
    if (testBtn) {
      handleTestSend(
        testBtn,
        'notifications',
        '/api/integrations/uptime-kuma/test',
        collectKumaBody,
        function () { return '✓ Test-Push gesendet.'; },
        function (data) {
          // Map specific error codes to friendly German copy per UI-SPEC § Error Codes.
          if (data && data.error === 'kuma_no_push_url') return '✗ Keine Push-URL gespeichert. Erst URL eintragen, dann testen.';
          if (data && data.error === 'invalid_url') return '✗ Push-URL ungültig (https + Public-IP nötig).';
          return '✗ Test-Push fehlgeschlagen: ' + (data && data.error ? data.error : 'unbekannt');
        }
      );
      return;
    }
  });

  // === Phase 20-05: VRM Drawer Wiring (D-06/D-12/D-13) ===
  // Loads/saves cfg.telemetry.historyImport.{vrmPortalId,vrmToken,enabled,provider}
  // via the dedicated /api/integrations/vrm endpoint (server-side merge so it never
  // collides with config.json branches written by other surfaces). 'Credentials
  // entfernen' uses window.dvConfirm before clearing the stored token.
  async function loadVrmDrawer() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/integrations/vrm');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data || !data.ok) return;
      if (el('vrm-enabled')) el('vrm-enabled').checked = !!data.enabled;
      if (el('vrm-portalid')) el('vrm-portalid').value = data.vrmPortalId || '';
      // Token redacted to '***' when stored — leave the field empty so the
      // placeholder "leer lassen = unverändert" explains the keep-existing
      // sentinel (D-13).
      if (el('vrm-token')) el('vrm-token').value = (data.vrmToken && data.vrmToken !== '***') ? data.vrmToken : '';
    } catch (e) {
      showDrawerToast('vrm', 'err', '✗ VRM laden fehlgeschlagen: ' + e.message);
    }
  }
  function collectVrmBody() {
    var el = function (id) { return document.getElementById(id); };
    var typedToken = (el('vrm-token') && el('vrm-token').value) || '';
    return {
      enabled: !!(el('vrm-enabled') && el('vrm-enabled').checked),
      vrmPortalId: ((el('vrm-portalid') && el('vrm-portalid').value) || '').trim(),
      // Empty typed-token → '***' sentinel = keep existing on backend (T-20-05-05).
      vrmToken: typedToken ? typedToken.trim() : '***'
    };
  }
  async function saveVrmDrawer(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    // Pre-submit validation per UI-SPEC § Form-Validation Display.
    var banner = document.getElementById('vrm-banner');
    var body = collectVrmBody();
    var errors = [];
    if (body.enabled) {
      if (!/^[A-Za-z0-9]{12,}$/.test(body.vrmPortalId)) errors.push('Portal-ID ist alphanumerisch und mindestens 12 Zeichen lang.');
      // vrmToken: '***' (= keep existing) OK; non-empty must be ≥ 20 chars
      if (body.vrmToken !== '***' && body.vrmToken.length < 20) errors.push('Token muss mindestens 20 Zeichen haben.');
    }
    if (errors.length) {
      if (banner) {
        banner.textContent = errors.join(' ');
        banner.hidden = false;
      }
      return;
    }
    if (banner) banner.hidden = true;

    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/integrations/vrm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data.ok) {
        showDrawerToast('vrm', 'ok', '✓ Gespeichert.');
        await loadVrmDrawer();
      } else {
        showDrawerToast('vrm', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('vrm', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  async function removeVrmCreds(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    var ok = false;
    try {
      ok = await window.dvConfirm(
        'Damit wird der History-Import deaktiviert und der gespeicherte Token gelöscht. Du kannst die Credentials jederzeit wieder eingeben.',
        { title: 'VRM-Credentials entfernen?', okLabel: 'Entfernen', cancelLabel: 'Abbrechen', variant: 'danger' }
      );
    } catch (_) { return; }
    if (!ok) return;
    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird entfernt …';
    try {
      // Explicitly send '' for the token so the server-side merge deletes it
      // (NOT '***' which would keep-existing).
      var res = await apiFetch('/api/integrations/vrm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, vrmPortalId: '', vrmToken: '' })
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data.ok) {
        showDrawerToast('vrm', 'ok', '✓ VRM-Credentials entfernt.');
        await loadVrmDrawer();
      } else {
        showDrawerToast('vrm', 'err', '✗ Entfernen fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('vrm', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('.conn-card[data-system="vrm"]')) {
      setTimeout(loadVrmDrawer, 0);
    }
    var saveBtn = e.target.closest('#vrm-save');
    if (saveBtn) { saveVrmDrawer(saveBtn); return; }
    var rmBtn = e.target.closest('#vrm-remove');
    if (rmBtn) { removeVrmCreds(rmBtn); return; }
  });

  // === Phase 20-06: Forecast-Provider Drawer Wiring (D-09/D-10/D-11/D-12) ===
  // Loads/saves cfg.forecast.solcast.* and cfg.forecast.pvnode.* via dedicated
  // /api/forecast/providers/{solcast,pvnode} server-side-merge endpoints. Each
  // tab has its own probe-button that hits the matching /probe endpoint and
  // renders the upstream sample (time + watts) into a sample-block. All apiKey
  // fields use the canonical '***' keep-existing sentinel (D-13).
  async function loadForecastTabs() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var sRes = await apiFetch('/api/forecast/providers/solcast');
      if (sRes.ok) {
        var s = await sRes.json();
        if (s && s.ok) {
          // '***' = stored, leave field empty (placeholder explains keep-existing).
          if (el('fc-solcast-apikey')) el('fc-solcast-apikey').value = (s.apiKey && s.apiKey !== '***') ? s.apiKey : '';
          if (el('fc-solcast-siteid')) el('fc-solcast-siteid').value = s.siteId || '';
        }
      }
      var pRes = await apiFetch('/api/forecast/providers/pvnode');
      if (pRes.ok) {
        var p = await pRes.json();
        if (p && p.ok) {
          if (el('fc-pvnode-apikey')) el('fc-pvnode-apikey').value = (p.apiKey && p.apiKey !== '***') ? p.apiKey : '';
          if (el('fc-pvnode-nowcast')) el('fc-pvnode-nowcast').checked = !!p.nowcastEnabled;
        }
      }
    } catch (e) {
      showDrawerToast('forecast', 'err', '✗ Forecast-Provider laden fehlgeschlagen: ' + e.message);
    }
  }
  function collectSolcastBody() {
    var el = function (id) { return document.getElementById(id); };
    var typedKey = (el('fc-solcast-apikey') && el('fc-solcast-apikey').value) || '';
    return {
      // Empty typed-key → '***' sentinel = keep-existing (T-20-06-07).
      apiKey: typedKey ? typedKey.trim() : '***',
      siteId: ((el('fc-solcast-siteid') && el('fc-solcast-siteid').value) || '').trim()
    };
  }
  function collectPvnodeBody() {
    var el = function (id) { return document.getElementById(id); };
    var typedKey = (el('fc-pvnode-apikey') && el('fc-pvnode-apikey').value) || '';
    return {
      apiKey: typedKey ? typedKey.trim() : '***',
      nowcastEnabled: !!(el('fc-pvnode-nowcast') && el('fc-pvnode-nowcast').checked)
    };
  }
  function showProviderSample(provider, sample) {
    var block = document.getElementById('fc-' + provider + '-sample');
    var timeEl = document.getElementById('fc-' + provider + '-sample-time');
    var wattsEl = document.getElementById('fc-' + provider + '-sample-watts');
    if (!block || !timeEl || !wattsEl) return;
    if (!sample) {
      block.hidden = true;
      return;
    }
    // textContent only — never innerHTML for upstream values (T-20-06-09 CSP).
    try {
      var d = new Date(sample.ts);
      timeEl.textContent = isNaN(d.getTime())
        ? String(sample.ts || '')
        : (String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
    } catch (_) { timeEl.textContent = String(sample.ts || ''); }
    wattsEl.textContent = (sample.watts != null ? sample.watts : 0) + ' W';
    block.hidden = false;
  }
  async function saveProviderTab(provider, buttonEl, bodyBuilder, endpoint) {
    if (!buttonEl || buttonEl.disabled) return;
    var banner = document.getElementById('fc-' + provider + '-banner');
    var body = bodyBuilder();
    // Pre-submit validation per UI-SPEC § Form-Validation Display.
    var errors = [];
    if (provider === 'solcast') {
      // apiKey == '***' (= keep-existing): skip length check.
      if (body.apiKey !== '***' && body.apiKey && body.apiKey.length < 20) errors.push('API-Key muss mindestens 20 Zeichen haben.');
      // UUID v4 / generic UUID format (8-4-4-4-12 hex).
      if (body.siteId && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(body.siteId)) {
        errors.push('Site-ID im UUID-Format erwartet (8-4-4-4-12 Hex-Zeichen).');
      }
    } else if (provider === 'pvnode') {
      if (body.apiKey !== '***' && body.apiKey && body.apiKey.length < 20) errors.push('API-Key muss mindestens 20 Zeichen haben.');
    }
    if (errors.length) {
      if (banner) { banner.textContent = errors.join(' '); banner.hidden = false; }
      return;
    }
    if (banner) banner.hidden = true;

    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data.ok) {
        showDrawerToast('forecast', 'ok', '✓ Gespeichert.');
        // Re-load so the apiKey field returns to the empty placeholder (D-13).
        await loadForecastTabs();
      } else {
        showDrawerToast('forecast', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('forecast', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  document.addEventListener('click', function (e) {
    // Open-on-card-click — load both tabs (one /probe, two /providers GET).
    if (e.target.closest('.conn-card[data-system="forecast-providers"]')) {
      setTimeout(loadForecastTabs, 0);
    }
    // Empty-State CTA — explicit stopPropagation so the card-click delegation
    // above (which routes to openDvDrawer + setTimeout(loadForecastTabs)) does
    // NOT double-fire (T-20-06-08 Pitfall). preventDefault for good measure.
    var cta = e.target.closest('[data-action="open-forecast-drawer"]');
    if (cta) {
      e.stopPropagation();
      e.preventDefault();
      var inst = getOrCreateDrawer('forecast');
      if (inst) inst.open();
      setTimeout(loadForecastTabs, 0);
      return;
    }
    // Save + Probe button handlers.
    var sSave = e.target.closest('#fc-solcast-save');
    if (sSave) { saveProviderTab('solcast', sSave, collectSolcastBody, '/api/forecast/providers/solcast'); return; }
    var pSave = e.target.closest('#fc-pvnode-save');
    if (pSave) { saveProviderTab('pvnode', pSave, collectPvnodeBody, '/api/forecast/providers/pvnode'); return; }
    var sProbe = e.target.closest('#fc-solcast-probe');
    if (sProbe) {
      handleTestSend(
        sProbe,
        'forecast',
        '/api/forecast/providers/solcast/probe',
        collectSolcastBody,
        function (data) {
          showProviderSample('solcast', data && data.sample);
          if (data && data.sample) {
            var d = new Date(data.sample.ts);
            var t = isNaN(d.getTime()) ? String(data.sample.ts || '') : (String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
            return '✓ Solcast-Probe OK: ' + (data.sample.watts != null ? data.sample.watts : 0) + ' W um ' + t + '.';
          }
          return '✓ Solcast-Probe OK (kein Sample im Fenster).';
        },
        null
      );
      return;
    }
    var pProbe = e.target.closest('#fc-pvnode-probe');
    if (pProbe) {
      handleTestSend(
        pProbe,
        'forecast',
        '/api/forecast/providers/pvnode/probe',
        collectPvnodeBody,
        function (data) {
          showProviderSample('pvnode', data && data.sample);
          if (data && data.sample) {
            var d = new Date(data.sample.ts);
            var t = isNaN(d.getTime()) ? String(data.sample.ts || '') : (String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
            return '✓ pvnode-Probe OK: ' + (data.sample.watts != null ? data.sample.watts : 0) + ' W um ' + t + '.';
          }
          return '✓ pvnode-Probe OK (kein Sample im Fenster).';
        },
        null
      );
      return;
    }
  });

  // === Phase 21 (2026-05-23): TeslaMate Drawer Wiring ===
  // Settings tab → /api/integrations/status (read cfg.integrations.tesla) +
  // POST /api/family/tesla-config (merge endpoint, NEVER /api/config).
  // Live tab → same status response, render tesla.state fields.
  // Sessions tab → GET /api/family/tesla-sessions?days=N, render table.
  async function loadTeslaSettings() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var r = await apiFetch('/api/integrations/status');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var data = await r.json();
      var t = (data && data.tesla) || {};
      // Settings are echoed back by the status endpoint (Phase 21 adds the
      // 3 config fields alongside the existing `enabled` boolean).
      if (el('tesla-enabled')) el('tesla-enabled').checked = !!t.enabled;
      if (el('tesla-name')) el('tesla-name').value = (t.config && t.config.name) || '';
      if (el('tesla-carid')) el('tesla-carid').value = (t.config && Number.isFinite(t.config.teslamateCarId)) ? t.config.teslamateCarId : 1;
      if (el('tesla-interval')) el('tesla-interval').value = (t.config && Number.isFinite(t.config.snapshotIntervalSec)) ? t.config.snapshotIntervalSec : 300;
    } catch (e) {
      showDrawerToast('tesla', 'err', '✗ Konfiguration laden fehlgeschlagen: ' + e.message);
    }
  }
  function teslaSnapshotKvLine(label, value, unit) {
    // CSP-safe escape via esc() — TeslaMate publishes operator-set names and
    // free-form geofences, so every value goes through esc() before innerHTML.
    var v = (value == null || value === '') ? '—' : esc(String(value));
    var u = unit ? (' ' + esc(unit)) : '';
    return '<div class="dv-snapshot-row"><span class="dv-snapshot-label">' + esc(label) + '</span><span class="dv-snapshot-value mono">' + v + u + '</span></div>';
  }
  async function loadTeslaSnapshot() {
    var grid = document.getElementById('tesla-snapshot-grid');
    var meta = document.getElementById('tesla-snapshot-meta');
    if (!grid) return;
    try {
      var r = await apiFetch('/api/integrations/status');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var data = await r.json();
      var t = (data && data.tesla) || {};
      var s = t.state || {};
      var html = ''
        + teslaSnapshotKvLine('Name', s.name || s.display_name)
        + teslaSnapshotKvLine('Status', s.state)
        + teslaSnapshotKvLine('Geofence', s.geofence)
        + teslaSnapshotKvLine('Akku-SoC', s.battery_level, '%')
        + teslaSnapshotKvLine('Nutzbarer SoC', s.usable_battery_level, '%')
        + teslaSnapshotKvLine('Ziel-SoC', s.charge_limit_soc, '%')
        + teslaSnapshotKvLine('Reichweite', s.rated_battery_range_km, 'km')
        + teslaSnapshotKvLine('Schätz-Reichweite', s.est_battery_range_km, 'km')
        + teslaSnapshotKvLine('Lade-Status', s.charging_state)
        + teslaSnapshotKvLine('Ladeleistung', s.charger_power, 'kW')
        + teslaSnapshotKvLine('Ladestrom', s.charger_actual_current, 'A')
        + teslaSnapshotKvLine('Ladespannung', s.charger_voltage, 'V')
        + teslaSnapshotKvLine('Geladene Energie', s.charge_energy_added, 'kWh')
        + teslaSnapshotKvLine('Stecker', s.plugged_in)
        + teslaSnapshotKvLine('Innentemperatur', s.inside_temp, '°C');
      grid.innerHTML = html;
      if (meta) {
        if (t.lastUpdate) {
          var d = new Date(t.lastUpdate);
          meta.textContent = isNaN(d.getTime()) ? 'Letztes Update: —' : ('Letztes Update: ' + d.toLocaleString());
        } else {
          meta.textContent = 'Noch keine Daten von TeslaMate empfangen.';
        }
      }
    } catch (e) {
      grid.innerHTML = '<p class="dv-drawer-empty">Snapshot fehlgeschlagen: ' + esc(e.message) + '</p>';
    }
  }
  function fmtSessionTs(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || '—');
      return d.toLocaleString();
    } catch (_) { return String(iso || '—'); }
  }
  async function loadTeslaSessions(days) {
    var body = document.getElementById('tesla-sessions-body');
    if (!body) return;
    body.innerHTML = '<p class="dv-drawer-empty">Lade Ladevorgänge …</p>';
    try {
      var r = await apiFetch('/api/family/tesla-sessions?days=' + encodeURIComponent(days));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var data = await r.json();
      var sessions = (data && Array.isArray(data.sessions)) ? data.sessions : [];
      if (!sessions.length) {
        body.innerHTML = '<p class="dv-drawer-empty">Keine Ladevorgänge im gewählten Zeitraum.</p>';
        return;
      }
      // Aggregate header — total energy + count.
      var totalKwh = 0;
      for (var i = 0; i < sessions.length; i++) totalKwh += Number(sessions[i].energyKwh) || 0;
      var html = '<p class="dv-drawer-meta">' + sessions.length + ' Sessions · ' + totalKwh.toFixed(1) + ' kWh geladen</p>';
      html += '<table class="dv-sessions-table"><thead><tr>'
        + '<th>Start</th><th class="num">Dauer</th><th class="num">kWh</th>'
        + '<th class="num">⌀ kW</th><th class="num">Peak kW</th><th class="num">SoC</th>'
        + '</tr></thead><tbody>';
      for (var j = 0; j < sessions.length; j++) {
        var s = sessions[j];
        var socRange = (s.socStartPct != null && s.socEndPct != null)
          ? (s.socStartPct + ' → ' + s.socEndPct + ' %')
          : '—';
        html += '<tr>'
          + '<td>' + esc(fmtSessionTs(s.startTs)) + '</td>'
          + '<td class="num mono">' + s.durationMin + ' min</td>'
          + '<td class="num mono">' + (Number(s.energyKwh) || 0).toFixed(2) + '</td>'
          + '<td class="num mono">' + (Math.round((s.avgPowerW || 0) / 100) / 10).toFixed(1) + '</td>'
          + '<td class="num mono">' + (Math.round((s.peakPowerW || 0) / 100) / 10).toFixed(1) + '</td>'
          + '<td class="num mono">' + esc(socRange) + '</td>'
          + '</tr>';
      }
      html += '</tbody></table>';
      body.innerHTML = html;
    } catch (e) {
      body.innerHTML = '<p class="dv-drawer-empty">Ladevorgänge laden fehlgeschlagen: ' + esc(e.message) + '</p>';
    }
  }
  async function saveTeslaConfig(buttonEl) {
    var el = function (id) { return document.getElementById(id); };
    var body = {
      enabled: !!(el('tesla-enabled') && el('tesla-enabled').checked),
      name: (el('tesla-name') && el('tesla-name').value || '').trim() || 'Tesla',
      teslamateCarId: Number((el('tesla-carid') && el('tesla-carid').value) || 1),
      snapshotIntervalSec: Number((el('tesla-interval') && el('tesla-interval').value) || 300)
    };
    if (!Number.isFinite(body.teslamateCarId) || body.teslamateCarId < 1 || body.teslamateCarId > 99) {
      showDrawerToast('tesla', 'err', '✗ Car-ID muss zwischen 1 und 99 liegen.');
      return;
    }
    if (!Number.isFinite(body.snapshotIntervalSec) || body.snapshotIntervalSec < 30 || body.snapshotIntervalSec > 3600) {
      showDrawerToast('tesla', 'err', '✗ Snapshot-Intervall muss 30–3600 s sein.');
      return;
    }
    if (buttonEl) { buttonEl.disabled = true; var orig = buttonEl.textContent; buttonEl.textContent = 'Speichere …'; }
    try {
      var res = await apiFetch('/api/family/tesla-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = {};
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data.ok) {
        showDrawerToast('tesla', 'ok', '✓ TeslaMate-Konfiguration gespeichert.');
      } else {
        showDrawerToast('tesla', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('tesla', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = orig; }
    }
  }
  document.addEventListener('click', function (e) {
    var saveBtn = e.target.closest('#tesla-save');
    if (saveBtn) { saveTeslaConfig(saveBtn); return; }
    var refreshBtn = e.target.closest('#tesla-sessions-refresh');
    if (refreshBtn) {
      var sel = document.getElementById('tesla-sessions-days');
      var d = sel ? Number(sel.value) : 7;
      loadTeslaSessions(Number.isFinite(d) ? d : 7);
      return;
    }
    // Tab-switch into Sessions → reload with current days selection (cheap
    // re-fetch keeps the table fresh on every visit without a poll loop).
    var sessionsTab = e.target.closest('#dv-tab-tesla-sessions');
    if (sessionsTab) {
      var sel2 = document.getElementById('tesla-sessions-days');
      var d2 = sel2 ? Number(sel2.value) : 7;
      setTimeout(function () { loadTeslaSessions(Number.isFinite(d2) ? d2 : 7); }, 0);
      return;
    }
    // Tab-switch into Live → re-pull snapshot (TeslaMate updates push into
    // /api/integrations/status; one re-fetch on tab show is enough).
    var snapTab = e.target.closest('#dv-tab-tesla-snapshot');
    if (snapTab) { setTimeout(loadTeslaSnapshot, 0); return; }
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'tesla-sessions-days') {
      var d = Number(e.target.value);
      loadTeslaSessions(Number.isFinite(d) ? d : 7);
    }
  });

  // Start polling
  fetchStatus();
  setInterval(fetchStatus, POLL_INTERVAL_MS);
  loadMqttTilesEditor();
})();
