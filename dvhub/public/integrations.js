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
      label: 'Victron Wechselrichter',
      category: 'Wechselrichter · lokal (Modbus)',
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
    {
      // DV-EOS fork as the arbitrage optimizer (operator request 2026-06-13:
      // her own DV-EOS fork, NOT the stock EOS). Status from cfg.optimizer +
      // a live reachability ping in the drawer (/api/integrations/dveos).
      key: 'dveos',
      label: 'DV-EOS',
      category: 'Arbitrage-Optimizer · Fork',
      logo: 'EO',
      accent: 'violet'
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
      label: 'Shelly',
      category: 'Energie · Shelly HTTP',
      logo: 'Sh',
      accent: 'orange'
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
      category: 'Victron-Cloud · History-Import',
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
    },
    // #23 (2026-06-13): EVCC wallbox — charge-mode control surfaced on the
    // Family EV panel. Click opens #dv-drawer-evcc (URL, battery-protect,
    // loadpoint selection). Status from /api/integrations/status.evcc.
    {
      key: 'evcc',
      label: 'EVCC Wallbox',
      category: 'Wallbox · Lademodus',
      logo: 'EV',
      accent: 'cyan'
    }
  ];

  var lastData = null;
  var currentFilter = 'all';

  function apiFetch(path, opts) {
    var common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }

  // Quality-Review 2026-07-01: shared res.json() fallback — was duplicated as
  // `try { data = await res.json(); } catch (_) {}` at ~16 call sites. Behaviour
  // unchanged (empty body / non-JSON response still falls back to {}, callers
  // already branch on res.ok/res.status), but a genuine parse failure now leaves
  // a console trace instead of vanishing silently.
  async function safeJson(res) {
    try { return await res.json(); }
    catch (e) { console.debug('[integrations] response was not valid JSON', res.url, e); return {}; }
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
      if (onOpen) { try { onOpen(); } catch (e) { console.debug('[integrations] drawer onOpen threw', e); } }
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
      if (onClose) { try { onClose(); } catch (e) { console.debug('[integrations] drawer onClose threw', e); } }
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
      var data = await safeJson(res);
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

  // Phase 21 (2026-05-23): unified Berlin-time helpers. The DVhub appliance
  // runs in Europe/Berlin and operators expect every clock displayed in that
  // timezone — regardless of what timezone their browser/phone is set to.
  // d.getHours()/getMinutes() return BROWSER-local time, so a phone in
  // London or a laptop accessed via VPN from a different TZ would show
  // off-by-one clocks. These helpers lock to Europe/Berlin explicitly.
  function fmtBerlinTime(ts) {
    if (!ts) return '—';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat('de-DE', {
        hour: '2-digit', minute: '2-digit',
        timeZone: 'Europe/Berlin', hour12: false
      }).format(d);
    } catch (_) { return '—'; }
  }
  function fmtBerlinDateTime(ts) {
    if (!ts) return '—';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '—';
      return new Intl.DateTimeFormat('de-DE', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'Europe/Berlin', hour12: false
      }).format(d);
    } catch (_) { return '—'; }
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
      case 'evcc':
        // #23: data from /api/integrations/status.evcc {enabled, url, reachable}.
        // No URL = not configured. URL set but unreachable = stale (warn).
        if (!data || !data.url) return 'disabled';
        return data.reachable ? 'online' : 'stale';
      case 'mid':
        // MID grid meter — online when a Modbus meter host is configured
        // (cfg.meter.host), else not configured.
        if (!data || !data.host) return 'disabled';
        return 'online';
      case 'dveos':
        // DV-EOS fork optimizer — online when the EOS proxy is enabled in
        // cfg.optimizer; the active-source detail lives in the stats/drawer.
        if (!data || !data.enabled) return 'disabled';
        return 'online';
      default: return 'disabled';
    }
  }

  function statusLabel(status, data) {
    // A 'warn' caused by an error WAVE (statusReason='errors') maps to 'stale'
    // for the colour bucket, but "Veraltet" is wrong when the feed is still
    // fresh — label it "Instabil" instead (operator report 2026-06-13: MQTT card
    // said "Veraltet" while live topics kept arriving). Staleness keeps "Veraltet".
    if (status === 'stale' && data && data.status === 'warn' && data.statusReason === 'errors') {
      return 'Instabil';
    }
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

  // Phase 21 (2026-05-23) rewrite: each integration picks its 4 most-useful
  // stats from whatever is actually in the status payload — no more 4×"—"
  // when latency/uptime/errors aren't tracked yet. Live-tracked metrics
  // (Latency / Errors · 24h) only appear when present; otherwise we fall
  // back to identity-style values (broker / topic count / SoC / portal-ID).
  // A stat with a missing value still shows '—' (single dash, not full row)
  // so the slot stays the same width across cards.
  function pickFirst(fn, data, fallback) {
    var v = fn(data);
    return v == null ? (fallback != null ? fallback : '—') : v;
  }
  function fmtBool(v, on, off) {
    if (v === true) return on || 'Ja';
    if (v === false) return off || 'Nein';
    return '—';
  }
  function fmtNumUnit(v, digits, unit) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toFixed(digits) + (unit ? (' ' + unit) : '');
  }
  function fmtBrokerHost(url) {
    if (!url) return '—';
    if (url === 'embedded') return 'embedded';
    try {
      var u = new URL(url);
      return u.host || url;
    } catch (_) { return String(url); }
  }
  function buildStats(key, data) {
    data = data || {};
    switch (key) {
      case 'mqtt':
        return [
          { label: 'Status', value: fmtBool(data.connected, 'Verbunden', 'Offline') },
          { label: 'Topics', value: fmtCount(data.topicCount) },
          { label: 'Broker', value: fmtBrokerHost(data.broker) },
          { label: data.latencyMs != null ? 'Latency' : 'Mode',
            value: data.latencyMs != null ? fmtLatency(data.latencyMs) : (data.embedded ? 'Embedded' : 'Extern') }
        ];
      case 'tesla': {
        var s = data.state || {};
        return [
          { label: 'SoC', value: fmtNumUnit(s.batteryLevel, 0, '%') },
          { label: 'Ladeleistung', value: fmtNumUnit(s.chargerPower, 1, 'kW') },
          { label: 'Reichweite', value: fmtNumUnit(s.ratedRangeKm, 0, 'km') },
          { label: 'Letztes Update', value: fmtRel(data.lastUpdate) }
        ];
      }
      case 'homeAssistant':
        return [
          { label: 'Auto-Discovery', value: fmtBool(data.haDiscovery, 'Aktiv', 'Aus') },
          { label: 'Topics', value: fmtCount(data.topicsPublished) },
          { label: 'Latency', value: fmtLatency(data.latencyMs) },
          { label: 'Last sync', value: fmtRel(data.lastSampleAt) }
        ];
      case 'victron':
        return [
          { label: 'Host', value: data.host || '—' },
          { label: 'Modell', value: data.modelId || '—' },
          { label: 'Firmware', value: data.firmware || '—' },
          { label: 'Status', value: fmtBool(data.host != null, 'Konfiguriert', 'Nicht konfiguriert') }
        ];
      case 'mid':
        return [
          { label: 'Host', value: data.host || '—' },
          { label: 'Unit-ID', value: data.unitId != null ? String(data.unitId) : '—' },
          { label: 'Register', value: data.address != null ? String(data.address) : '—' },
          { label: 'Status', value: fmtBool(!!data.host, 'Konfiguriert', 'Nicht konfiguriert') }
        ];
      case 'dveos':
        return [
          { label: 'Optimizer', value: fmtBool(data.enabled, 'Aktiv', 'Aus') },
          { label: 'Quelle', value: data.primarySource === 'eos' ? 'EOS' : (data.primarySource === 'best' ? 'Best' : 'Intern') },
          { label: 'Steuerung', value: data.active ? 'EOS führt' : 'nicht führend' },
          { label: 'Proxy', value: data.url ? String(data.url).replace(/^https?:\/\//, '') : '—' }
        ];
      case 'luox':
        return [
          { label: 'Identifier', value: data.identifier || '—' },
          { label: 'Firmware', value: data.firmware || '—' },
          { label: 'Status', value: fmtBool(!!data.identifier, 'Konfiguriert', 'Nicht konfiguriert') },
          { label: '—', value: '—' }
        ];
      case 'loxone':
        return [
          { label: 'Status', value: fmtBool(data.configured, 'Konfiguriert', 'Nicht konfiguriert') },
          { label: 'Latency', value: fmtLatency(data.latencyMs) },
          { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
          { label: 'Last sync', value: fmtRel(data.lastSampleAt) }
        ];
      case 'devices': {
        var total = Number(data.total) || 0;
        var online = Number(data.online) || 0;
        return [
          { label: 'Online', value: total > 0 ? (online + ' / ' + total) : '0 / 0' },
          { label: 'Total', value: fmtCount(total) },
          { label: 'Sample', value: fmtSampleRate(data.sampleIntervalHistogramMs) },
          { label: 'Last sample', value: fmtRel(data.lastSampleAt) }
        ];
      }
      case 'notifications': {
        var p = Array.isArray(data.providers) ? data.providers : [];
        var on = p.filter(function (x) { return typeof x === 'string' ? true : !!(x && x.enabled); }).length;
        return [
          { label: 'Aktiv', value: p.length ? (on + ' / ' + p.length) : '0 / 0' },
          { label: 'Provider', value: p.length ? String(p.length) : '—' },
          { label: 'Status', value: fmtBool(data.enabled, 'Aktiv', 'Aus') },
          { label: 'Last send', value: fmtRel(data.lastSampleAt) }
        ];
      }
      case 'vrm':
        return [
          { label: 'Portal-ID', value: data.vrmPortalId || '—' },
          { label: 'Token', value: fmtBool(data.vrmTokenSet, 'Hinterlegt', 'Fehlt') },
          { label: 'Import', value: fmtBool(data.enabled, 'Aktiv', 'Aus') },
          { label: 'Last import', value: fmtRel(data.lastImportAt) }
        ];
      case 'forecast-providers': {
        var solOn = !!(data.solcast && data.solcast.apiKeySet);
        var pvOn = !!(data.pvnode && data.pvnode.apiKeySet);
        var configuredN = (solOn ? 1 : 0) + (pvOn ? 1 : 0);
        return [
          { label: 'Konfiguriert', value: configuredN + ' / 2' },
          { label: 'Solcast', value: solOn ? 'OK' : '—' },
          { label: 'pvnode', value: pvOn ? (data.pvnode && data.pvnode.nowcastEnabled ? 'OK · Nowcast' : 'OK') : '—' },
          { label: 'Last fetch', value: fmtRel(data.lastFetchAt) }
        ];
      }
      case 'evcc':
        return [
          { label: 'Status', value: data.url ? (data.reachable ? 'Erreichbar' : 'Nicht erreichbar') : 'Nicht konfiguriert' },
          { label: 'Ladepunkte', value: data.url ? fmtCount(data.loadpointCount) : '—' },
          { label: 'Akkuschutz', value: fmtBool(data.enabled, 'Aktiv', 'Aus') },
          { label: 'Dashboard-LP', value: data.dashboardLoadpoint != null ? ('#' + data.dashboardLoadpoint) : 'Auto' }
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
    var label = statusLabel(status, data);
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
        || sys.key === 'victron' || sys.key === 'luox') {
      actions = '<div class="conn-actions">'
        + '<a class="btn sm ghost" href="/settings.html#system" data-action="card-logs" data-system="' + esc(sys.key) + '" data-label="' + esc(sys.label) + '">Logs</a>'
        + '<a class="btn sm" href="/settings.html" data-action="card-konfig" data-system="' + esc(sys.key) + '">Konfig.</a>'
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

    // The static "Keine Integrationen konfiguriert" empty card was removed on
    // operator request (2026-06-13): SYSTEMS is always non-empty, so the empty
    // state never showed in practice — and the `is-empty` card's CSS display
    // overrode [hidden], leaving a blank full-width card on the page.
    list.innerHTML = '';
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
        onOpen: function () { pollMqttTopics(); startMqttPoll(); loadMqttSettings(); },
        onClose: function () { stopMqttPoll(); }
      });
    }
    mqttDrawerInstance.open();
  }
  // Phase 21 (2026-05-23): pre-fill the MQTT Einstellungen-Tab from the
  // status payload (mqtt.config — see routes-api.js). Password stays empty
  // (placeholder explains keep-existing) so the '***' / '' contract is
  // operator-visible.
  async function loadMqttSettings() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var r = await apiFetch('/api/integrations/status');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      var c = (d && d.mqtt && d.mqtt.config) || {};
      if (el('mqtt-broker-url')) el('mqtt-broker-url').value = c.brokerUrl || '';
      if (el('mqtt-username')) el('mqtt-username').value = c.username || '';
      if (el('mqtt-embedded')) el('mqtt-embedded').checked = !!c.embedded;
      if (el('mqtt-topic-prefix')) el('mqtt-topic-prefix').value = (c.topicPrefix === 'dvhub') ? '' : (c.topicPrefix || '');
      if (el('mqtt-password')) {
        el('mqtt-password').value = '';
        el('mqtt-password').placeholder = c.passwordSet ? 'leer lassen = unverändert' : 'kein Passwort gespeichert';
      }
    } catch (e) {
      showDrawerToast('mqtt', 'err', '✗ MQTT-Settings laden fehlgeschlagen: ' + e.message);
    }
  }
  async function saveMqttSettings(buttonEl) {
    var el = function (id) { return document.getElementById(id); };
    var pwInput = el('mqtt-password');
    var body = {
      brokerUrl: ((el('mqtt-broker-url') && el('mqtt-broker-url').value) || '').trim(),
      username: ((el('mqtt-username') && el('mqtt-username').value) || '').trim(),
      // Empty input = '***' (keep existing) — operator clears explicitly via
      // a typed space-then-backspace OR by clicking Speichern with truly
      // empty value below. We use the placeholder text to remind them.
      password: pwInput ? pwInput.value : '***',
      embedded: !!(el('mqtt-embedded') && el('mqtt-embedded').checked),
      topicPrefix: ((el('mqtt-topic-prefix') && el('mqtt-topic-prefix').value) || '').trim()
    };
    // If the input is empty AND there's a stored password, treat as "keep".
    // Without this guard, an operator who only changes the URL would wipe
    // their stored password silently.
    if (pwInput && pwInput.value === '') {
      body.password = (pwInput.placeholder.indexOf('unverändert') >= 0) ? '***' : '';
    }
    if (!body.embedded && !body.brokerUrl) {
      showDrawerToast('mqtt', 'err', '✗ Broker-URL fehlt (oder Embedded aktivieren).');
      return;
    }
    var banner = el('mqtt-restart-banner');
    if (banner) banner.hidden = false;
    if (buttonEl) { buttonEl.disabled = true; var orig = buttonEl.textContent; buttonEl.textContent = 'Speichere …'; }
    try {
      var res = await apiFetch('/api/family/mqtt-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await safeJson(res);
      if (res.ok && data.ok) {
        showDrawerToast('mqtt', 'ok', data.restartRequired
          ? '✓ Gespeichert. Service wird neu gestartet — Seite in ~10 s neu laden.'
          : '✓ MQTT-Konfiguration gespeichert.');
      } else {
        showDrawerToast('mqtt', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('mqtt', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = orig; }
    }
  }
  document.addEventListener('click', function (e) {
    var saveBtn = e.target.closest('#mqtt-save');
    if (saveBtn) { saveMqttSettings(saveBtn); return; }
  });
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

  // Single source of truth for "card → its settings drawer" so the card-click
  // AND the "Konfig."-link open the exact same drawer (operator request
  // 2026-06-13). Returns true if a drawer was opened, false if the system has no
  // drawer yet (then the "Konfig."-link falls through to its settings.html href).
  function openDrawerForSystem(key) {
    var inst;
    if (key === 'mqtt') { openMqttDrawer(); return true; }
    if (key === 'victron') {
      inst = getOrCreateDrawer('victron');
      if (inst) { inst.open(); setTimeout(loadVictronDrawer, 0); }
      return true;
    }
    if (key === 'homeAssistant') {
      inst = getOrCreateDrawer('homeassistant');
      if (inst) { inst.open(); setTimeout(loadHaDrawer, 0); }
      return true;
    }
    if (key === 'notifications') { inst = getOrCreateDrawer('notifications'); if (inst) inst.open(); return true; }
    if (key === 'vrm') { inst = getOrCreateDrawer('vrm'); if (inst) inst.open(); return true; }
    if (key === 'forecast-providers') { inst = getOrCreateDrawer('forecast'); if (inst) inst.open(); return true; }
    if (key === 'evcc') {
      inst = getOrCreateDrawer('evcc');
      if (inst) { inst.open(); setTimeout(loadEvccDrawer, 0); }
      return true;
    }
    if (key === 'mid') {
      inst = getOrCreateDrawer('mid');
      if (inst) { inst.open(); setTimeout(loadMidDrawer, 0); }
      return true;
    }
    if (key === 'dveos') {
      inst = getOrCreateDrawer('dveos');
      if (inst) { inst.open(); setTimeout(loadDveosDrawer, 0); }
      return true;
    }
    if (key === 'loxone') {
      inst = getOrCreateDrawer('loxone');
      if (inst) { inst.open(); setTimeout(loadLoxoneDrawer, 0); }
      return true;
    }
    if (key === 'tesla') {
      inst = getOrCreateDrawer('tesla');
      if (inst) {
        inst.open();
        setTimeout(loadTeslaSettings, 0);
        setTimeout(loadTeslaSnapshot, 0);
        setTimeout(function () { loadTeslaSessions(7); }, 0);
      }
      return true;
    }
    return false;
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

    // "Logs"-link inside a card → integration-specific log drawer (operator
    // request 2026-06-13: the Logs link went generically to settings.html#system;
    // now it filters the live log-ring to this integration). href stays as a
    // no-JS fallback.
    var logsLink = e.target.closest('a[data-action="card-logs"]');
    if (logsLink) {
      e.preventDefault();
      var lKey = logsLink.getAttribute('data-system') || '';
      var lLabel = logsLink.getAttribute('data-label') || lKey;
      var logsInst = getOrCreateDrawer('logs');
      if (logsInst) {
        logsInst.open();
        setTimeout(function () { loadLogsDrawer(lKey, lLabel); }, 0);
      }
      return;
    }

    // "Konfig."-link inside a card → open the SAME drawer as clicking the card
    // (operator request 2026-06-13: both must show the card's own settings). If
    // the system has no drawer yet, fall through to the link's settings.html href.
    var konfigLink = e.target.closest('a[data-action="card-konfig"]');
    if (konfigLink) {
      var kKey = konfigLink.getAttribute('data-system') || '';
      if (openDrawerForSystem(kKey)) e.preventDefault();
      return;
    }

    // Other action-links inside card should navigate, not open drawer.
    if (e.target.closest('a')) return;

    // Card → drawer routing by data-system (single shared path with "Konfig.").
    var card = e.target.closest('.conn-card[data-system]');
    if (card) {
      var cKey = card.getAttribute('data-system');
      if (openDrawerForSystem(cKey)) { e.preventDefault(); return; }
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
      var data = await safeJson(res);
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
      var data = await safeJson(res);
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
      var data = await safeJson(res);
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
      var data = await safeJson(res);
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
      var data = await safeJson(res);
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
      var data = await safeJson(res);
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

  // === EVCC Drawer Wiring (#23, 2026-06-13) ===
  // Loads/saves cfg.evcc.{url, enabled (battery-protect), dashboardLoadpoint}
  // via the dedicated /api/integrations/evcc server-side-merge endpoint. The
  // loadpoint <select> is populated from the live loadpoint list the GET
  // returns. The Family EV panel then shows/controls the chosen loadpoint.
  async function loadEvccDrawer() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/integrations/evcc');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data || !data.ok) return;
      if (el('evcc-url')) el('evcc-url').value = data.url || '';
      if (el('evcc-enabled')) el('evcc-enabled').checked = !!data.enabled;
      var sel = el('evcc-loadpoint');
      if (sel) {
        var lps = Array.isArray(data.loadpoints) ? data.loadpoints : [];
        if (lps.length) {
          sel.innerHTML = '<option value="">Automatisch (erster Ladepunkt)</option>'
            + lps.map(function (l) { return '<option value="' + l.id + '">#' + l.id + ' · ' + esc(l.title) + '</option>'; }).join('');
          sel.disabled = false;
          sel.value = data.dashboardLoadpoint != null ? String(data.dashboardLoadpoint) : '';
        } else {
          sel.innerHTML = '<option value="">' + (data.url ? '— kein Ladepunkt erreichbar —' : '— erst Adresse speichern —') + '</option>';
          sel.disabled = true;
        }
      }
      var st = el('evcc-status');
      if (st) {
        st.hidden = false;
        st.textContent = data.url
          ? (data.reachable ? ('✓ Erreichbar · ' + data.loadpointCount + ' Ladepunkt(e)') : ('✗ Nicht erreichbar' + (data.lastError ? ' (' + data.lastError + ')' : '')))
          : 'Noch keine Adresse konfiguriert.';
      }
    } catch (e) {
      showDrawerToast('evcc', 'err', '✗ EVCC laden fehlgeschlagen: ' + e.message);
    }
  }
  async function saveEvccDrawer(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    var el = function (id) { return document.getElementById(id); };
    var banner = el('evcc-banner');
    var urlVal = ((el('evcc-url') && el('evcc-url').value) || '').trim();
    if (urlVal && !/^https?:\/\//i.test(urlVal)) {
      if (banner) { banner.textContent = 'Adresse muss mit http:// oder https:// beginnen.'; banner.hidden = false; }
      return;
    }
    if (banner) banner.hidden = true;
    var lpRaw = (el('evcc-loadpoint') && el('evcc-loadpoint').value) || '';
    var body = {
      url: urlVal,
      enabled: !!(el('evcc-enabled') && el('evcc-enabled').checked),
      dashboardLoadpoint: lpRaw === '' ? null : parseInt(lpRaw, 10)
    };
    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/integrations/evcc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await safeJson(res);
      if (res.ok && data.ok) {
        showDrawerToast('evcc', 'ok', '✓ Gespeichert.');
        // Re-poll after a beat so a freshly-saved URL has a chance to connect
        // and the loadpoint list/status refresh.
        setTimeout(loadEvccDrawer, 1200);
      } else {
        showDrawerToast('evcc', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('evcc', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  document.addEventListener('click', function (e) {
    var evccSave = e.target.closest('#evcc-save');
    if (evccSave) { saveEvccDrawer(evccSave); return; }
    var evccRefresh = e.target.closest('#evcc-refresh');
    if (evccRefresh) { loadEvccDrawer(); return; }
  });

  // === MID / Netzzähler Drawer Wiring (2026-06-13) ===
  // The grid meter has a SOURCE selector: 'profile' (register map from the
  // manufacturer profile, read-only), or an operator endpoint 'modbus'|'mqtt'|
  // 'http' persisted in cfg.meterSource. The manufacturer dropdown is populated
  // from the hersteller/ folder. Default 'profile' = unchanged live behaviour;
  // the data-path that consumes a custom source is staged on top of this config.
  var MID_MODES = ['profile', 'modbus', 'mqtt', 'http'];
  function midApplyMode(mode) {
    var el = function (id) { return document.getElementById(id); };
    MID_MODES.forEach(function (mo) {
      var g = el('mid-grp-' + mo);
      if (g) g.hidden = (mo !== mode);
    });
  }
  async function loadMidDrawer() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/integrations/mid');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data || !data.ok) return;

      // Manufacturer dropdown — options come from the hersteller/ folder.
      var manSel = el('mid-manufacturer');
      if (manSel) {
        var opts = Array.isArray(data.manufacturers) ? data.manufacturers : [];
        manSel.textContent = '';
        opts.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label || o.value;
          manSel.appendChild(opt);
        });
        manSel.value = data.manufacturer || 'victron';
      }

      // Source mode.
      var mode = MID_MODES.indexOf(data.mode) >= 0 ? data.mode : 'profile';
      if (el('mid-source-mode')) el('mid-source-mode').value = mode;
      midApplyMode(mode);

      // Modbus (individuell) fields.
      var mb = data.modbus || {};
      if (el('mid-host')) el('mid-host').value = mb.host || '';
      if (el('mid-port')) el('mid-port').value = mb.port != null ? mb.port : 502;
      if (el('mid-unitid')) el('mid-unitid').value = mb.unitId != null ? mb.unitId : 1;
      if (el('mid-address')) el('mid-address').value = mb.address != null ? mb.address : 0;
      if (el('mid-quantity')) el('mid-quantity').value = mb.quantity != null ? mb.quantity : 3;
      if (el('mid-fc')) el('mid-fc').value = String(mb.fc === 4 ? 4 : 3);

      // MQTT fields.
      var mq = data.mqtt || {};
      if (el('mid-mqtt-l1')) el('mid-mqtt-l1').value = mq.topicL1 || '';
      if (el('mid-mqtt-l2')) el('mid-mqtt-l2').value = mq.topicL2 || '';
      if (el('mid-mqtt-l3')) el('mid-mqtt-l3').value = mq.topicL3 || '';
      if (el('mid-mqtt-total')) el('mid-mqtt-total').value = mq.topicTotal || '';

      // HTTP fields.
      var ht = data.http || {};
      if (el('mid-http-url')) el('mid-http-url').value = ht.url || '';
      if (el('mid-http-path')) el('mid-http-path').value = ht.jsonPath || '';

      // General.
      if (el('mid-name')) el('mid-name').value = data.name || '';
      if (el('mid-sign')) el('mid-sign').value = data.gridPositiveMeans === 'grid_import' ? 'grid_import' : 'feed_in';

      // Profile read-only meter detail.
      var pd = el('mid-profile-detail');
      if (pd) {
        var pm = data.profileMeter || {};
        if (pm.host || data.profileManaged) {
          pd.hidden = false;
          pd.textContent = '🔒 Profil-Zähler ' + (pm.host || '—') + ':' + (pm.port != null ? pm.port : 502)
            + ' · Unit ' + (pm.unitId != null ? pm.unitId : 1)
            + ' · Reg ' + (pm.address != null ? pm.address : 0) + '×' + (pm.quantity != null ? pm.quantity : 3)
            + ' · FC' + (pm.fc != null ? pm.fc : 3)
            + ' · ' + (data.meterOk ? 'liefert Werte ✓' : 'noch keine Werte ⚠');
        } else {
          pd.hidden = true;
        }
      }

      // Status line (per mode).
      var st = el('mid-status');
      if (st) {
        st.hidden = false;
        if (mode === 'profile') {
          st.textContent = data.meterOk
            ? '✓ Netzwerte kommen aus dem Hersteller-Profil und liefern Werte.'
            : '⚠ Hersteller-Profil aktiv, aber noch keine Netzwerte gelesen.';
        } else if (mode === 'modbus') {
          st.textContent = mb.host
            ? 'Eigener Modbus-Zähler hinterlegt. Aktivierung des Datenpfads folgt im nächsten Schritt.'
            : 'Trage Host/Register des Modbus-Zählers ein.';
        } else if (mode === 'mqtt') {
          st.textContent = 'MQTT-Quelle: Topics hinterlegen + MQTT-Hub einbinden. Datenpfad folgt.';
        } else {
          st.textContent = 'HTTP-Quelle: URL hinterlegen. Datenpfad folgt.';
        }
      }
    } catch (e) {
      showDrawerToast('mid', 'err', '✗ Zähler laden fehlgeschlagen: ' + e.message);
    }
  }
  async function saveMidDrawer(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    var el = function (id) { return document.getElementById(id); };
    var banner = el('mid-banner');
    var mode = (el('mid-source-mode') && el('mid-source-mode').value) || 'profile';
    var host = ((el('mid-host') && el('mid-host').value) || '').trim();
    // Host required only in Modbus mode; when set it must look like a host.
    if (mode === 'modbus' && host && /\s/.test(host)) {
      if (banner) { banner.textContent = 'Host darf keine Leerzeichen enthalten.'; banner.hidden = false; }
      return;
    }
    if (banner) banner.hidden = true;
    var intVal = function (id, d) { var v = parseInt((el(id) && el(id).value) || '', 10); return Number.isFinite(v) ? v : d; };
    var trim = function (id) { return ((el(id) && el(id).value) || '').trim(); };
    var body = {
      manufacturer: (el('mid-manufacturer') && el('mid-manufacturer').value) || undefined,
      mode: mode,
      name: trim('mid-name'),
      gridPositiveMeans: (el('mid-sign') && el('mid-sign').value === 'grid_import') ? 'grid_import' : 'feed_in',
      modbus: {
        host: host,
        port: intVal('mid-port', 502),
        unitId: intVal('mid-unitid', 1),
        address: intVal('mid-address', 0),
        quantity: intVal('mid-quantity', 3),
        fc: intVal('mid-fc', 3)
      },
      mqtt: {
        topicL1: trim('mid-mqtt-l1'),
        topicL2: trim('mid-mqtt-l2'),
        topicL3: trim('mid-mqtt-l3'),
        topicTotal: trim('mid-mqtt-total')
      },
      http: {
        url: trim('mid-http-url'),
        jsonPath: trim('mid-http-path')
      }
    };
    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/integrations/mid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await safeJson(res);
      if (res.ok && data.ok) {
        showDrawerToast('mid', 'ok', '✓ Gespeichert.');
        setTimeout(loadMidDrawer, 1000);
      } else {
        showDrawerToast('mid', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('mid', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  document.addEventListener('click', function (e) {
    var midSave = e.target.closest('#mid-save');
    if (midSave) { saveMidDrawer(midSave); return; }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.id === 'mid-source-mode') { midApplyMode(t.value); }
  });

  // === DV-EOS Drawer Wiring (2026-06-13) ===
  // Read-only status of the DV-EOS fork optimizer + a live reachability ping
  // (/api/integrations/dveos). EOS engine config itself lives in EOSdash.
  async function loadDveosDrawer() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/integrations/dveos');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var d = await res.json();
      if (!d || !d.ok) return;
      var srcLabel = d.primarySource === 'eos' ? 'EOS'
        : (d.primarySource === 'best' ? 'Best (intern/EOS)' : 'Intern');
      if (el('dveos-enabled')) el('dveos-enabled').textContent = d.enabled ? 'Ja' : 'Nein';
      if (el('dveos-source')) el('dveos-source').textContent = srcLabel;
      if (el('dveos-active')) el('dveos-active').textContent = d.active ? 'EOS führt die Steuerung' : 'EOS nicht führend';
      if (el('dveos-url')) el('dveos-url').textContent = d.url || '—';
      if (el('dveos-reachable')) el('dveos-reachable').textContent = d.reachable ? '✓ erreichbar' : '✗ nicht erreichbar';
      var st = el('dveos-status');
      if (st) {
        st.hidden = false;
        if (!d.enabled) {
          st.textContent = 'DV-EOS-Optimizer ist deaktiviert (cfg.optimizer.eosProxy.enabled = false).';
        } else if (!d.reachable) {
          st.textContent = '⚠ EOS-Proxy nicht erreichbar unter ' + (d.url || '—') + '.';
        } else if (d.active) {
          st.textContent = '✓ DV-EOS läuft und steuert die Batterie (Quelle: ' + srcLabel + ').';
        } else {
          st.textContent = 'DV-EOS erreichbar, aber nicht die führende Optimizer-Quelle (primarySource = ' + d.primarySource + ').';
        }
      }
    } catch (e) {
      showDrawerToast('dveos', 'err', '✗ DV-EOS-Status laden fehlgeschlagen: ' + e.message);
    }
  }

  // === Integration-specific Logs Drawer (2026-06-13) ===
  // The card "Logs" link filters the live /api/log ring to entries whose `event`
  // key matches the integration's keyword set, instead of jumping to the generic
  // settings log view. Heuristic by design — the ring has no per-integration tag.
  var LOG_FILTERS = {
    victron: ['victron', 'modbus', 'poll_meter', 'poll_point', 'control_write', 'ctrl_', 'control_', 'minsoc', 'discharge'],
    mid: ['mid', 'meter'],
    dveos: ['eos'],
    mqtt: ['mqtt'],
    evcc: ['evcc'],
    tesla: ['tesla'],
    vrm: ['vrm', 'historyimport', 'history_import', 'backfill'],
    notifications: ['notif', 'ntfy', 'telegram', 'pushover', 'uptime', 'alert'],
    'forecast-providers': ['forecast', 'solcast', 'pvnode', 'accuracy'],
    homeAssistant: ['ha_', 'homeassistant', 'hadiscovery'],
    loxone: ['loxone'],
    devices: ['device', 'shelly']
  };
  function logMatchesSystem(row, key) {
    var kws = LOG_FILTERS[key];
    if (!kws || !row || !row.event) return false;
    var ev = String(row.event).toLowerCase();
    for (var i = 0; i < kws.length; i++) { if (ev.indexOf(kws[i]) >= 0) return true; }
    return false;
  }
  function fmtLogTime(ts) {
    try { return new Date(ts).toLocaleTimeString('de-DE'); } catch (_) { return String(ts || ''); }
  }
  function summarizeLogDetail(r) {
    var skip = { ts: 1, event: 1, level: 1 };
    var parts = [];
    for (var k in r) {
      if (skip[k] || !Object.prototype.hasOwnProperty.call(r, k)) continue;
      var v = r[k];
      if (v && typeof v === 'object') { try { v = JSON.stringify(v); } catch (_) { v = '[obj]'; } }
      parts.push(k + '=' + v);
    }
    return parts.join('  ').slice(0, 200);
  }
  async function loadLogsDrawer(key, label) {
    var el = function (id) { return document.getElementById(id); };
    var titleEl = el('dv-drawer-logs-title');
    if (titleEl) titleEl.textContent = 'Logs — ' + (label || key);
    var listEl = el('logs-list');
    var emptyEl = el('logs-empty');
    if (listEl) listEl.textContent = '';
    if (emptyEl) emptyEl.hidden = true;
    try {
      var res = await apiFetch('/api/log?limit=400');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      var rows = (data && Array.isArray(data.rows)) ? data.rows : [];
      var filtered = rows.filter(function (r) { return logMatchesSystem(r, key); }).reverse();
      if (!filtered.length) {
        if (emptyEl) emptyEl.hidden = false;
        return;
      }
      if (!listEl) return;
      filtered.slice(0, 200).forEach(function (r) {
        var item = document.createElement('div');
        item.className = 'logs-row level-' + (r.level || 'info');
        var t = document.createElement('span');
        t.className = 'logs-ts mono';
        t.textContent = fmtLogTime(r.ts);
        var lvl = document.createElement('span');
        lvl.className = 'logs-level';
        lvl.textContent = (r.level || 'info').toUpperCase();
        var ev = document.createElement('span');
        ev.className = 'logs-event mono';
        ev.textContent = r.event || '';
        var det = document.createElement('span');
        det.className = 'logs-detail mono';
        det.textContent = summarizeLogDetail(r);
        item.appendChild(t);
        item.appendChild(lvl);
        item.appendChild(ev);
        item.appendChild(det);
        listEl.appendChild(item);
      });
    } catch (e) {
      showDrawerToast('logs', 'err', '✗ Logs laden fehlgeschlagen: ' + e.message);
    }
  }

  // === Victron Wechselrichter / Anlage Drawer Wiring (2026-06-13) ===
  // Editable per appliance: Hersteller, Anlagenadresse (victron.host), PV-Anbindung.
  // Transport + register map come from the manufacturer profile → read-only.
  async function loadVictronDrawer() {
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/integrations/victron');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var d = await res.json();
      if (!d || !d.ok) return;
      var manSel = el('victron-manufacturer');
      if (manSel) {
        var opts = Array.isArray(d.manufacturers) ? d.manufacturers : [];
        manSel.textContent = '';
        opts.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o.value; opt.textContent = o.label || o.value;
          manSel.appendChild(opt);
        });
        manSel.value = d.manufacturer || 'victron';
      }
      if (el('victron-host')) el('victron-host').value = d.host || '';
      if (el('victron-pvcoupling')) el('victron-pvcoupling').value = ['ac_dc', 'ac', 'dc'].indexOf(d.pvCoupling) >= 0 ? d.pvCoupling : 'ac_dc';
      if (el('victron-transport')) {
        var tr = d.transport === 'mqtt'
          ? ('MQTT' + (d.mqttBroker ? (' · ' + d.mqttBroker) : ''))
          : ('Modbus TCP · Port ' + (d.port != null ? d.port : 502) + ' · Unit ' + (d.unitId != null ? d.unitId : 100));
        el('victron-transport').textContent = tr + ' (aus Herstellerprofil)';
      }
      // Read-only register summary from the profile.
      var regBox = el('victron-regs');
      if (regBox) {
        regBox.textContent = '';
        var r = d.registers || {};
        var addRow = function (labelTxt, valTxt) {
          var row = document.createElement('div');
          row.className = 'dv-info-row';
          var l = document.createElement('span'); l.className = 'dv-info-label'; l.textContent = labelTxt;
          var v = document.createElement('span'); v.className = 'dv-info-value mono'; v.textContent = valTxt;
          row.appendChild(l); row.appendChild(v); regBox.appendChild(row);
        };
        if (r.meter) addRow('Zähler-Register', 'FC' + (r.meter.fc != null ? r.meter.fc : '?') + ' · Adr ' + (r.meter.address != null ? r.meter.address : '?') + ' ×' + (r.meter.quantity != null ? r.meter.quantity : '?'));
        var readNames = (r.read || []).map(function (x) { return x.name + (x.address != null ? ('@' + x.address) : ''); });
        var writeNames = (r.write || []).map(function (x) { return x.name + (x.address != null ? ('@' + x.address) : ''); });
        addRow('Lese-Register (' + readNames.length + ')', readNames.join(', ') || '—');
        addRow('Schreib-Register (' + writeNames.length + ')', writeNames.join(', ') || '—');
      }
      var st = el('victron-status');
      if (st) {
        st.hidden = false;
        var hb = d.heartbeatSec != null ? (d.heartbeatSec + ' s' ) : '—';
        st.textContent = (d.meterOk ? '✓ Anlage liefert Werte' : '⚠ Noch keine frischen Werte')
          + ' · Heartbeat ' + hb
          + (d.firmware ? (' · FW ' + d.firmware) : '');
      }
    } catch (e) {
      showDrawerToast('victron', 'err', '✗ Anlage laden fehlgeschlagen: ' + e.message);
    }
  }
  async function saveVictronDrawer(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    var el = function (id) { return document.getElementById(id); };
    var banner = el('victron-banner');
    var host = ((el('victron-host') && el('victron-host').value) || '').trim();
    if (host && /\s/.test(host)) {
      if (banner) { banner.textContent = 'Anlagenadresse darf keine Leerzeichen enthalten.'; banner.hidden = false; }
      return;
    }
    if (banner) banner.hidden = true;
    var body = {
      manufacturer: (el('victron-manufacturer') && el('victron-manufacturer').value) || undefined,
      host: host,
      pvCoupling: (el('victron-pvcoupling') && el('victron-pvcoupling').value) || 'ac_dc'
    };
    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/integrations/victron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await safeJson(res);
      if (res.ok && data.ok) {
        showDrawerToast('victron', 'ok', '✓ Gespeichert.');
        setTimeout(loadVictronDrawer, 1000);
      } else {
        showDrawerToast('victron', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('victron', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  document.addEventListener('click', function (e) {
    var vSave = e.target.closest('#victron-save');
    if (vSave) { saveVictronDrawer(vSave); return; }
  });

  // === Home Assistant MQTT-Discovery Drawer Wiring (2026-06-13) ===
  // Enable/disable + prefix + "Speichern & Resync" (republish without a restart).
  // Copy-paste REST fallback (no MQTT) with THIS appliance's address pre-filled —
  // window.location.origin is exactly how the user reached DVhub, so every user
  // gets a ready-to-paste snippet with their own IP (operator request 2026-06-13).
  function buildHaRestYaml() {
    var base = (window.location && window.location.origin) ? window.location.origin : 'http://DVHUB-IP';
    return [
      '# Home Assistant — DVhub via REST (ohne MQTT). Spiegelt die MQTT-Discovery-Sensoren.',
      '# In configuration.yaml einfügen, dann HA neu starten. Adresse ist bereits eingetragen.',
      'rest:',
      '  - resource: "' + base + '/api/status"',
      '    scan_interval: 30',
      '    # Nur falls in DVhub ein API-Token gesetzt ist (LAN-Zugriff ohne Token braucht das nicht):',
      '    # headers:',
      '    #   Authorization: "Bearer DEIN_API_TOKEN"',
      '    sensor:',
      '      # --- Leistung (W) ---',
      '      - name: "DVhub Netzleistung"',
      '        value_template: "{{ value_json.meter.grid_total_w }}"',
      '        unit_of_measurement: "W"',
      '        device_class: power',
      '        state_class: measurement',
      '      - name: "DVhub Netz L1"',
      '        value_template: "{{ value_json.meter.grid_l1_w }}"',
      '        unit_of_measurement: "W"',
      '        device_class: power',
      '        state_class: measurement',
      '      - name: "DVhub Netz L2"',
      '        value_template: "{{ value_json.meter.grid_l2_w }}"',
      '        unit_of_measurement: "W"',
      '        device_class: power',
      '        state_class: measurement',
      '      - name: "DVhub Netz L3"',
      '        value_template: "{{ value_json.meter.grid_l3_w }}"',
      '        unit_of_measurement: "W"',
      '        device_class: power',
      '        state_class: measurement',
      '      - name: "DVhub Batterieleistung"',
      '        value_template: "{{ value_json.victron.batteryPowerW }}"',
      '        unit_of_measurement: "W"',
      '        device_class: power',
      '        state_class: measurement',
      '      - name: "DVhub PV gesamt"',
      '        value_template: "{{ value_json.victron.pvTotalW }}"',
      '        unit_of_measurement: "W"',
      '        device_class: power',
      '        state_class: measurement',
      '      - name: "DVhub PV DC"',
      '        value_template: "{{ value_json.victron.pvPowerW }}"',
      '        unit_of_measurement: "W"',
      '        device_class: power',
      '        state_class: measurement',
      '      # --- Batterie-Zustand ---',
      '      - name: "DVhub Batterie SoC"',
      '        value_template: "{{ value_json.victron.soc }}"',
      '        unit_of_measurement: "%"',
      '        device_class: battery',
      '        state_class: measurement',
      '      - name: "DVhub Batterie Min-SoC"',
      '        value_template: "{{ value_json.victron.minSocPct }}"',
      '        unit_of_measurement: "%"',
      '        state_class: measurement',
      '      # --- Preis (ct/kWh) ---',
      '      - name: "DVhub Strompreis"',
      '        value_template: "{{ value_json.costs.priceNowCtKwh }}"',
      '        unit_of_measurement: "ct/kWh"',
      '        state_class: measurement',
      '      # --- Energiezähler (Wh, heute) → HA-Energie-Dashboard ---',
      '      - name: "DVhub Netzbezug (heute)"',
      '        value_template: "{{ value_json.costs.importWh }}"',
      '        unit_of_measurement: "Wh"',
      '        device_class: energy',
      '        state_class: total_increasing',
      '      - name: "DVhub Einspeisung (heute)"',
      '        value_template: "{{ value_json.costs.exportWh }}"',
      '        unit_of_measurement: "Wh"',
      '        device_class: energy',
      '        state_class: total_increasing',
      '      # --- Geld (EUR, heute) ---',
      '      - name: "DVhub Stromkosten (heute)"',
      '        value_template: "{{ value_json.costs.costEur }}"',
      '        unit_of_measurement: "EUR"',
      '        device_class: monetary',
      '      - name: "DVhub Erlös (heute)"',
      '        value_template: "{{ value_json.costs.revenueEur }}"',
      '        unit_of_measurement: "EUR"',
      '        device_class: monetary',
      '      - name: "DVhub Netto (heute)"',
      '        value_template: "{{ value_json.costs.netEur }}"',
      '        unit_of_measurement: "EUR"',
      '        device_class: monetary',
      '      # --- Optimizer ---',
      '      - name: "DVhub Optimizer"',
      "        value_template: \"{{ 'disabled' if value_json.schedule.smallMarketAutomation.lastOutcome == 'idle' else 'active' }}\"",
      '      - name: "DVhub Optimizer-Quelle"',
      '        value_template: "{{ value_json.schedule.smallMarketAutomation.lastOutcome }}"',
      '      - name: "DVhub Optimizer letzter Lauf"',
      '        value_template: "{{ value_json.schedule.smallMarketAutomation.lastRunDate }}"',
      '      # --- Diagnose ---',
      '      - name: "DVhub Victron letztes Update"',
      '        value_template: "{{ none if (value_json.victron.updatedAt | int) == 0 else (value_json.victron.updatedAt | int / 1000) | timestamp_utc }}"',
      '        device_class: timestamp',
      '    binary_sensor:',
      '      - name: "DVhub Zähler"',
      "        value_template: \"{{ 'ON' if value_json.meter.ok else 'OFF' }}\"",
      '        device_class: connectivity',
      '# Hinweis: Uptime gibt es nur über den MQTT-Weg — sie steckt nicht im /api/status.'
    ].join('\n');
  }
  async function loadHaDrawer() {
    var yamlEl = document.getElementById('ha-rest-yaml');
    if (yamlEl) yamlEl.textContent = buildHaRestYaml();
    var el = function (id) { return document.getElementById(id); };
    try {
      var res = await apiFetch('/api/integrations/homeassistant');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var d = await res.json();
      if (!d || !d.ok) return;
      if (el('ha-enabled')) el('ha-enabled').checked = !!d.enabled;
      if (el('ha-prefix')) el('ha-prefix').value = d.prefix || 'homeassistant';
      if (el('ha-topic-prefix')) el('ha-topic-prefix').value = d.topicPrefix || 'dvhub';
      if (el('ha-broker')) el('ha-broker').textContent = d.broker || '—';
      if (el('ha-entity-count')) el('ha-entity-count').textContent = (d.entityCount != null ? d.entityCount : '—') + ' Sensoren';
      if (el('ha-mqtt-status')) el('ha-mqtt-status').textContent = d.mqttConnected ? '✓ verbunden' : '✗ nicht verbunden';
      var st = el('ha-status');
      if (st) {
        st.hidden = false;
        if (!d.enabled) {
          st.textContent = 'Inaktiv — aktivieren, um DVhub in Home Assistant einzubinden.';
        } else if (!d.mqttConnected) {
          st.textContent = '⚠ Aktiv, aber der MQTT-Hub ist nicht verbunden — in HA kommen keine Daten an.';
        } else {
          st.textContent = '✓ Aktiv — DVhub erscheint in HA als Gerät „DVhub" (' + (d.entityCount || '?') + ' Sensoren).';
        }
      }
    } catch (e) {
      showDrawerToast('homeassistant', 'err', '✗ Laden fehlgeschlagen: ' + e.message);
    }
  }
  async function saveHaDrawer(buttonEl) {
    if (!buttonEl || buttonEl.disabled) return;
    var el = function (id) { return document.getElementById(id); };
    var body = {
      enabled: !!(el('ha-enabled') && el('ha-enabled').checked),
      prefix: ((el('ha-prefix') && el('ha-prefix').value) || '').trim() || 'homeassistant',
      topicPrefix: ((el('ha-topic-prefix') && el('ha-topic-prefix').value) || '').trim() || 'dvhub'
    };
    buttonEl.disabled = true;
    var origText = buttonEl.textContent;
    buttonEl.textContent = 'Wird gespeichert …';
    try {
      var res = await apiFetch('/api/integrations/homeassistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await safeJson(res);
      if (res.ok && data.ok) {
        showDrawerToast('homeassistant', 'ok', data.enabled
          ? ('✓ Aktiv — ' + (data.published || 0) + ' Sensoren an HA gesendet.')
          : '✓ Deaktiviert (Entities in HA entfernt).');
        setTimeout(loadHaDrawer, 800);
      } else {
        showDrawerToast('homeassistant', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('homeassistant', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      buttonEl.disabled = false;
      buttonEl.textContent = origText;
    }
  }
  // Loxone Virtual HTTP Input import template (operator request 2026-06-13).
  // Data source is the existing /api/integration/loxone endpoint, which emits a
  // flat `key=value` text block (plus a few JSON blobs). Loxone's command
  // recognition (`\v` = value placeholder) scans that text. We expose only the
  // values that appear BEFORE the large userEnergyPricing JSON array, so a
  // Miniserver response buffer never truncates them. The own DVhub address is
  // pre-filled from window.location.origin so each user gets their own IP.
  function buildLoxoneTemplate() {
    var base = (window.location && window.location.origin) ? window.location.origin : 'http://DVHUB-IP';
    var addr = base + '/api/integration/loxone';
    var cmds = [
      { t: 'Batterie SoC (%)', c: 'soc=\\v' },
      { t: 'Batterieleistung (W)', c: 'batteryPowerW=\\v' },
      { t: 'Netzleistung (W)', c: 'gridTotalW=\\v' },
      { t: 'PV gesamt (W)', c: 'pvTotalW=\\v' },
      { t: 'Netz-Sollwert (W)', c: 'gridSetpointW=\\v' },
      { t: 'Min-SoC (%)', c: 'minSocPct=\\v' },
      { t: 'DV-Steuerwert', c: 'dvControlValue=\\v' },
      { t: 'Netzbezug heute (Wh)', c: '&quot;importWh&quot;:\\v' },
      { t: 'Einspeisung heute (Wh)', c: '&quot;exportWh&quot;:\\v' },
      { t: 'Stromkosten heute (EUR)', c: '&quot;costEur&quot;:\\v' },
      { t: 'Erlös heute (EUR)', c: '&quot;revenueEur&quot;:\\v' },
      { t: 'Netto heute (EUR)', c: '&quot;netEur&quot;:\\v' },
      { t: 'Strompreis (ct/kWh)', c: '&quot;priceNowCtKwh&quot;:\\v' }
    ];
    var lines = [];
    lines.push('<?xml version="1.0" encoding="utf-8"?>');
    lines.push('<VirtualInHttp Title="DVhub" Comment="DVhub HEMS Messwerte" Address="' + addr + '" PollingTime="60">');
    for (var i = 0; i < cmds.length; i++) {
      lines.push('\t<VirtualInHttpCmd Title="' + cmds[i].t + '" Comment="" Check="' + cmds[i].c + '" Signed="true" Analog="true" SourceValLow="0" DestValLow="0" SourceValHigh="100" DestValHigh="100" DefVal="0" MinVal="-1000000" MaxVal="1000000"/>');
    }
    lines.push('</VirtualInHttp>');
    return lines.join('\n');
  }
  function loadLoxoneDrawer() {
    var base = (window.location && window.location.origin) ? window.location.origin : 'http://DVHUB-IP';
    var urlEl = document.getElementById('lox-url');
    if (urlEl) urlEl.textContent = base + '/api/integration/loxone';
    var tpl = buildLoxoneTemplate();
    var tplEl = document.getElementById('lox-template');
    if (tplEl) tplEl.textContent = tpl;
    var countEl = document.getElementById('lox-count');
    if (countEl) countEl.textContent = (tpl.match(/VirtualInHttpCmd/g) || []).length + ' Messwerte';
  }
  document.addEventListener('click', function (e) {
    var haSave = e.target.closest('#ha-save');
    if (haSave) { saveHaDrawer(haSave); return; }
    var haCopy = e.target.closest('#ha-rest-copy');
    if (haCopy) {
      var pre = document.getElementById('ha-rest-yaml');
      var txt = pre ? pre.textContent : '';
      if (txt && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {
          showDrawerToast('homeassistant', 'ok', '✓ REST-Vorlage kopiert.');
        }).catch(function () {
          showDrawerToast('homeassistant', 'err', 'Kopieren fehlgeschlagen — Block manuell markieren.');
        });
      } else {
        showDrawerToast('homeassistant', 'err', 'Zwischenablage nicht verfügbar — Block manuell markieren.');
      }
      return;
    }
    var loxCopy = e.target.closest('#lox-copy');
    if (loxCopy) {
      var loxPre = document.getElementById('lox-template');
      var loxTxt = loxPre ? loxPre.textContent : '';
      if (loxTxt && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(loxTxt).then(function () {
          showDrawerToast('loxone', 'ok', '✓ Loxone-Vorlage kopiert.');
        }).catch(function () {
          showDrawerToast('loxone', 'err', 'Kopieren fehlgeschlagen — Block manuell markieren.');
        });
      } else {
        showDrawerToast('loxone', 'err', 'Zwischenablage nicht verfügbar — Block manuell markieren.');
      }
      return;
    }
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
          if (el('fc-pvnode-plan')) el('fc-pvnode-plan').value = p.plan || 'free';
          if (el('fc-pvnode-siteid')) el('fc-pvnode-siteid').value = p.siteId || '';
          if (el('fc-pvnode-forecastdays')) el('fc-pvnode-forecastdays').value = (p.forecastDays != null && p.forecastDays !== '') ? p.forecastDays : '';
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
      plan: ((el('fc-pvnode-plan') && el('fc-pvnode-plan').value) || 'free'),
      siteId: ((el('fc-pvnode-siteid') && el('fc-pvnode-siteid').value) || '').trim(),
      forecastDays: ((el('fc-pvnode-forecastdays') && el('fc-pvnode-forecastdays').value) || '').trim(),
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
    // Phase 21 (2026-05-23): timezone-locked to Berlin via fmtBerlinTime.
    timeEl.textContent = fmtBerlinTime(sample.ts);
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
      var data = await safeJson(res);
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
            return '✓ Solcast-Probe OK: ' + (data.sample.watts != null ? data.sample.watts : 0) + ' W um ' + fmtBerlinTime(data.sample.ts) + '.';
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
            return '✓ pvnode-Probe OK: ' + (data.sample.watts != null ? data.sample.watts : 0) + ' W um ' + fmtBerlinTime(data.sample.ts) + '.';
          }
          return '✓ pvnode-Probe OK (kein Sample im Fenster).';
        },
        null
      );
      return;
    }
    // Phase 21 (2026-05-23): EOS-Akkudoktor read-back. handleTestSend takes
    // an empty body (probe needs no operator input — reads from EOS' own
    // provider config), shows the first future-or-recent sample, and reports
    // total slot count so the operator sees the prognosis horizon.
    var eosProbe = e.target.closest('#fc-eos-import');
    if (eosProbe) {
      handleTestSend(
        eosProbe,
        'forecast',
        '/api/forecast/providers/eos-akkudoktor/probe',
        function () { return {}; },
        function (data) {
          showProviderSample('eos', data && data.sample);
          var n = (data && data.slotCount) || 0;
          if (data && data.sample) {
            return '✓ EOS-Akkudoktor: ' + (data.sample.watts != null ? data.sample.watts : 0) + ' W um ' + fmtBerlinTime(data.sample.ts) + ' (' + n + ' Slots im Horizon).';
          }
          return '✓ EOS-Akkudoktor OK, aber kein nutzbares Sample.';
        },
        null
      );
      return;
    }
  });
  // Phase 21 (2026-05-23): EOS-tab loader — fills the read-only EOS-URL box
  // from /api/integrations/status (we don't have a dedicated GET endpoint,
  // so we re-derive from the optimizer.eosProxy.url echo via the status
  // payload — which already contains everything we need anyway).
  async function loadEosForecastTab() {
    var el = document.getElementById('fc-eos-url');
    if (!el) return;
    try {
      var r = await apiFetch('/api/status');
      if (r.ok) {
        // /api/status doesn't echo eosProxy directly — fall back to the
        // common-case default that matches the operator's setup. The probe
        // endpoint reads the authoritative cfg.optimizer.eosProxy.url so the
        // displayed-vs-used URLs converge by construction.
        el.textContent = 'http://127.0.0.1:8503 (lokaler EOSdash)';
      } else {
        el.textContent = '—';
      }
    } catch (_) { el.textContent = '—'; }
  }
  // Hook EOS-tab activation to lazy-load the URL display.
  document.addEventListener('click', function (e) {
    if (e.target.closest('#dv-tab-fc-eos')) setTimeout(loadEosForecastTab, 0);
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
      // Phase 21: topic-prefix override (empty input = default 'teslamate/cars').
      if (el('tesla-prefix')) {
        var pref = (t.config && t.config.topicPrefix) || '';
        el('tesla-prefix').value = (pref === 'teslamate/cars') ? '' : pref;
      }
      // Phase 21: read-only broker info block — shows WHERE DVhub is listening
      // for TeslaMate data so the operator doesn't have to guess.
      if (el('tesla-broker-url')) el('tesla-broker-url').textContent = t.broker || '—';
      if (el('tesla-sub-topic')) el('tesla-sub-topic').textContent = t.subscriptionTopic || '—';
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
      // getState() returns camelCase keys (batteryLevel, chargingState, chargerPower …)
      // — NOT snake_case. (Bug 2026-06-13: the grid read snake_case and so showed "—"
      // for everything except Status/Geofence, which made the card look hung.)
      var STALE_STATES = ['offline', 'asleep', 'suspended'];
      var isStale = STALE_STATES.indexOf(String(s.state || '')) >= 0;
      var html = '';
      if (isStale) {
        var sinceTxt = s.since ? fmtBerlinDateTime(s.since) : (t.lastUpdate ? fmtBerlinDateTime(t.lastUpdate) : '—');
        var stLabel = s.state === 'offline' ? 'offline' : (s.state === 'asleep' ? 'schläft' : esc(String(s.state)));
        html += '<div class="dv-snapshot-stale">&#9888; Werte veraltet &mdash; TeslaMate ' + stLabel
          + ' seit ' + esc(sinceTxt) + '. Der Wagen sendet aktuell keine Live-Daten (SoC etc. eingefroren).</div>';
      }
      var pluggedTxt = s.pluggedIn === true ? 'Ja' : (s.pluggedIn === false ? 'Nein' : null);
      html += ''
        + teslaSnapshotKvLine('Name', s.displayName)
        + teslaSnapshotKvLine('Status', s.state)
        + teslaSnapshotKvLine('Geofence', s.geofence)
        + teslaSnapshotKvLine('Akku-SoC', s.batteryLevel, '%')
        + teslaSnapshotKvLine('Nutzbarer SoC', s.usableBatteryLevel, '%')
        + teslaSnapshotKvLine('Ziel-SoC', s.chargeLimitSoc, '%')
        + teslaSnapshotKvLine('Reichweite', s.ratedRangeKm, 'km')
        + teslaSnapshotKvLine('Schätz-Reichweite', s.estRangeKm, 'km')
        + teslaSnapshotKvLine('Lade-Status', s.chargingState)
        + teslaSnapshotKvLine('Ladeleistung', s.chargerPower, 'kW')
        + teslaSnapshotKvLine('Ladestrom', s.chargerCurrent, 'A')
        + teslaSnapshotKvLine('Ladespannung', s.chargerVoltage, 'V')
        + teslaSnapshotKvLine('Geladene Energie', s.chargeEnergyAdded, 'kWh')
        + teslaSnapshotKvLine('Stecker', pluggedTxt)
        + teslaSnapshotKvLine('Innentemperatur', s.insideTemp, '°C');
      grid.innerHTML = html;
      if (meta) {
        meta.textContent = t.lastUpdate
          ? 'Letztes Update: ' + fmtBerlinDateTime(t.lastUpdate)
          : 'Noch keine Daten von TeslaMate empfangen.';
      }
    } catch (e) {
      grid.innerHTML = '<p class="dv-drawer-empty">Snapshot fehlgeschlagen: ' + esc(e.message) + '</p>';
    }
  }
  function fmtSessionTs(iso) {
    // Phase 21 (2026-05-23): Berlin-locked via fmtBerlinDateTime so charge
    // sessions table reads as "23.05.2026, 14:32" regardless of browser TZ.
    return fmtBerlinDateTime(iso);
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
  // === Phase 21 (2026-05-23): Shelly device-list drawer ===
  // GET /api/family/shelly-devices for the saved rows; POST same path to
  // replace. Live status (online/power) is merged in from /api/integrations/
  // status `devices.list` (already polled by fetchStatus) — keeps the rows
  // mockup-faithful when DVhub has just been restarted and the adapter hasn't
  // produced a sample yet.
  var shellyRows = []; // working state: array of {id, name, host, pollIntervalSec, enabled}
  function shellyRowHtml(row, idx, liveByHost) {
    var live = liveByHost && row.host ? liveByHost[row.host.replace(/:\d+$/, '')] : null;
    var statusLabel = '—';
    var statusClass = 'is-unknown';
    if (live) {
      statusLabel = live.online
        ? (live.powerW != null ? (Math.round(live.powerW) + ' W') : 'Online')
        : 'Offline';
      statusClass = live.online ? 'is-online' : 'is-offline';
    }
    return '<div class="shelly-row" data-idx="' + idx + '">'
      + '<input type="text" class="input shelly-in" data-k="name" value="' + esc(row.name || '') + '" placeholder="Waschmaschine" maxlength="80" />'
      + '<input type="text" class="input mono shelly-in" data-k="host" value="' + esc(row.host || '') + '" placeholder="192.168.x.x" maxlength="128" spellcheck="false" autocomplete="off" />'
      + '<input type="number" class="input mono shelly-in" data-k="poll" value="' + (row.pollIntervalSec || 10) + '" min="2" max="3600" step="1" inputmode="numeric" />'
      + '<span class="shelly-status ' + statusClass + '">' + esc(statusLabel) + '</span>'
      + '<button type="button" class="btn sm ghost shelly-del" data-idx="' + idx + '" aria-label="Entfernen">&times;</button>'
      + '</div>';
  }
  function renderShellyRows(liveByHost) {
    var body = document.getElementById('shelly-list-body');
    if (!body) return;
    if (!shellyRows.length) {
      body.innerHTML = '<p class="dv-drawer-empty">Noch keine Shelly-Geräte konfiguriert. „+ Gerät hinzufügen" um zu starten.</p>';
      return;
    }
    var html = '';
    for (var i = 0; i < shellyRows.length; i++) html += shellyRowHtml(shellyRows[i], i, liveByHost);
    body.innerHTML = html;
  }
  async function loadShellyDrawer() {
    try {
      var r = await apiFetch('/api/family/shelly-devices');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      var src = (d && Array.isArray(d.devices)) ? d.devices : [];
      shellyRows = src.map(function (x) {
        return {
          id: x.id || '',
          name: x.name || '',
          host: (x.shelly && x.shelly.host) || '',
          pollIntervalSec: (x.shelly && x.shelly.pollIntervalSec) || 10,
          enabled: x.enabled !== false
        };
      });
      // Overlay live online/power from /api/integrations/status devices.list.
      var liveByHost = {};
      try {
        var s = await apiFetch('/api/integrations/status');
        if (s.ok) {
          var sd = await s.json();
          var list = (sd && sd.devices && Array.isArray(sd.devices.list)) ? sd.devices.list : [];
          for (var i = 0; i < list.length; i++) {
            var dev = list[i];
            if (dev && dev.host) liveByHost[String(dev.host).replace(/:\d+$/, '')] = dev;
          }
        }
      } catch (_) { /* live overlay is best-effort */ }
      renderShellyRows(liveByHost);
    } catch (e) {
      var body = document.getElementById('shelly-list-body');
      if (body) body.innerHTML = '<p class="dv-drawer-empty">Laden fehlgeschlagen: ' + esc(e.message) + '</p>';
    }
  }
  function readShellyRowsFromDom() {
    var nodes = document.querySelectorAll('#shelly-list-body .shelly-row');
    var rows = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var idx = Number(n.dataset.idx);
      var existing = (Number.isFinite(idx) && shellyRows[idx]) ? shellyRows[idx] : {};
      var get = function (k) {
        var el = n.querySelector('.shelly-in[data-k="' + k + '"]');
        return el ? el.value : '';
      };
      rows.push({
        id: existing.id || '',
        name: (get('name') || '').trim(),
        host: (get('host') || '').trim(),
        pollIntervalSec: Number(get('poll')) || 10,
        enabled: existing.enabled !== false
      });
    }
    return rows;
  }
  async function saveShellyDrawer(buttonEl) {
    var rows = readShellyRowsFromDom();
    var body = {
      devices: rows.map(function (r) {
        return {
          id: r.id || undefined,
          name: r.name,
          adapter: 'shelly-http',
          enabled: r.enabled,
          shelly: { host: r.host, pollIntervalSec: r.pollIntervalSec }
        };
      })
    };
    var banner = document.getElementById('shelly-banner');
    if (banner) { banner.hidden = true; banner.classList.remove('error'); banner.textContent = ''; }
    if (buttonEl) { buttonEl.disabled = true; var orig = buttonEl.textContent; buttonEl.textContent = 'Speichere …'; }
    try {
      var res = await apiFetch('/api/family/shelly-devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var data = await safeJson(res);
      if (res.ok && data.ok) {
        shellyRows = (data.devices || []).map(function (x) {
          return {
            id: x.id || '', name: x.name || '',
            host: (x.shelly && x.shelly.host) || '',
            pollIntervalSec: (x.shelly && x.shelly.pollIntervalSec) || 10,
            enabled: x.enabled !== false
          };
        });
        renderShellyRows(null);
        showDrawerToast('shelly', 'ok', data.restartRequired
          ? '✓ Gespeichert. Service wird neu gestartet — Seite in ~10 s neu laden.'
          : '✓ ' + shellyRows.length + ' Shelly-Gerät(e) gespeichert.');
      } else if (banner && Array.isArray(data.details) && data.details.length) {
        banner.classList.add('error');
        banner.innerHTML = '<strong>Validierung fehlgeschlagen:</strong><br>' + data.details.map(esc).join('<br>');
        banner.hidden = false;
      } else {
        showDrawerToast('shelly', 'err', '✗ Speichern fehlgeschlagen: ' + (data.error || ('HTTP ' + res.status)));
      }
    } catch (e) {
      showDrawerToast('shelly', 'err', '✗ Netzwerkfehler: ' + e.message);
    } finally {
      if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = orig; }
    }
  }
  // mDNS-Discovery für Shellys — nutzt denselben generischen Endpoint wie die
  // Victron-Suche (server-seitiger Provider 'shelly' browst _shelly._tcp.local
  // [Gen2/Plus/Pro] + _http._tcp.local [Gen1] und filtert per Hostname-Hint).
  function renderShellyDiscoverResults(state) {
    var box = document.getElementById('shelly-discover-results');
    if (!box) return;
    if (!state) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    if (state.loading) { box.innerHTML = '<p class="shelly-discover-hint">Suche im Netzwerk … (mDNS, ~2 s)</p>'; return; }
    if (state.error) { box.innerHTML = '<p class="shelly-discover-hint">Suche fehlgeschlagen: ' + esc(state.error) + '</p>'; return; }
    var systems = Array.isArray(state.systems) ? state.systems : [];
    if (!systems.length) {
      box.innerHTML = '<p class="shelly-discover-hint">Keine Shellys per mDNS gefunden. Manuell per IP hinzufügen oder erneut suchen.</p>';
      return;
    }
    var existing = {};
    for (var i = 0; i < shellyRows.length; i++) {
      var h = (shellyRows[i].host || '').replace(/:\d+$/, '').toLowerCase();
      if (h) existing[h] = true;
    }
    var html = '<p class="shelly-discover-hint">' + systems.length + ' Gerät(e) gefunden:</p>';
    for (var j = 0; j < systems.length; j++) {
      var sys = systems[j];
      var ip = sys.ipv4 || sys.ip || sys.ipv6 || sys.host || '';
      var already = !!existing[String(ip).replace(/:\d+$/, '').toLowerCase()];
      html += '<div class="shelly-discover-row">'
        + '<span class="shelly-discover-name">' + esc(sys.label || sys.host || ip) + '</span>'
        + '<span class="shelly-discover-ip mono">' + esc(ip) + '</span>'
        + (already
            ? '<span class="shelly-discover-added">✓ in Liste</span>'
            : '<button type="button" class="btn sm ghost shelly-discover-pick" data-host="' + esc(ip) + '" data-name="' + esc(sys.label || '') + '">Übernehmen</button>')
        + '</div>';
    }
    box.innerHTML = html;
  }
  async function discoverShellyDevices(buttonEl) {
    renderShellyDiscoverResults({ loading: true });
    var orig = buttonEl ? buttonEl.textContent : '';
    if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Suche …'; }
    try {
      var r = await apiFetch('/api/discovery/systems?manufacturer=shelly');
      var d = await safeJson(r);
      if (r.ok && d.ok) renderShellyDiscoverResults({ systems: d.systems || [] });
      else renderShellyDiscoverResults({ error: d.error || ('HTTP ' + r.status) });
    } catch (e) {
      renderShellyDiscoverResults({ error: e.message });
    } finally {
      if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = orig; }
    }
  }

  document.addEventListener('click', function (e) {
    var devCard = e.target.closest('.conn-card[data-system="devices"]');
    if (devCard) {
      e.preventDefault();
      var inst = getOrCreateDrawer('shelly');
      if (inst) inst.open();
      setTimeout(loadShellyDrawer, 0);
      return;
    }
    var discoverBtn = e.target.closest('#shelly-discover');
    if (discoverBtn) { discoverShellyDevices(discoverBtn); return; }
    var pickBtn = e.target.closest('.shelly-discover-pick');
    if (pickBtn) {
      // Laufende Edits sichern, dann das gewählte Gerät als neue Zeile übernehmen.
      shellyRows = readShellyRowsFromDom();
      var pickHost = (pickBtn.dataset.host || '').trim();
      var pickName = (pickBtn.dataset.name || '').trim();
      var normHost = pickHost.replace(/:\d+$/, '').toLowerCase();
      var dup = shellyRows.some(function (row) {
        return (row.host || '').replace(/:\d+$/, '').toLowerCase() === normHost;
      });
      if (!dup && pickHost) {
        shellyRows.push({ id: '', name: pickName, host: pickHost, pollIntervalSec: 10, enabled: true });
        renderShellyRows(null);
      }
      pickBtn.outerHTML = '<span class="shelly-discover-added">✓ in Liste</span>';
      return;
    }
    var addBtn = e.target.closest('#shelly-add');
    if (addBtn) {
      // Persist any in-progress edits before re-render so the operator doesn't
      // lose typing when they click + multiple times in a row.
      shellyRows = readShellyRowsFromDom();
      shellyRows.push({ id: '', name: '', host: '', pollIntervalSec: 10, enabled: true });
      renderShellyRows(null);
      return;
    }
    var saveBtn = e.target.closest('#shelly-save');
    if (saveBtn) { saveShellyDrawer(saveBtn); return; }
    var delBtn = e.target.closest('.shelly-del');
    if (delBtn) {
      // Persist DOM edits, splice the target index, re-render.
      shellyRows = readShellyRowsFromDom();
      var idx = Number(delBtn.dataset.idx);
      if (Number.isFinite(idx)) {
        shellyRows.splice(idx, 1);
        renderShellyRows(null);
      }
      return;
    }
  });

  async function saveTeslaConfig(buttonEl) {
    var el = function (id) { return document.getElementById(id); };
    var body = {
      enabled: !!(el('tesla-enabled') && el('tesla-enabled').checked),
      name: (el('tesla-name') && el('tesla-name').value || '').trim() || 'Tesla',
      teslamateCarId: Number((el('tesla-carid') && el('tesla-carid').value) || 1),
      snapshotIntervalSec: Number((el('tesla-interval') && el('tesla-interval').value) || 300),
      // Empty string = clear override → backend falls back to 'teslamate/cars'.
      topicPrefix: ((el('tesla-prefix') && el('tesla-prefix').value) || '').trim()
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
      var data = await safeJson(res);
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
    // "Broker ändern → MQTT-Hub-Karte" — open the MQTT inspector drawer from
    // inside the Tesla drawer. e.preventDefault for the href="#" anchor.
    var openMqtt = e.target.closest('[data-action="open-mqtt-drawer"]');
    if (openMqtt) {
      e.preventDefault();
      openMqttDrawer();
      return;
    }
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
