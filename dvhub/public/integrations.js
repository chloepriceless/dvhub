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
    {
      key: 'luox',
      label: 'LUOX',
      category: 'Direktvermarkter · VPN',
      logo: 'L',
      accent: 'violet'
    },
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
    }
  ];

  var lastData = null;
  var currentFilter = 'all';

  function apiFetch(path, opts) {
    var common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }

  async function fetchStatus() {
    try {
      // Phase 09.2: NEW endpoint — health-tracker provides per-system metrics
      // (latency / uptime / errors / sample-rate / firmware) + Featured-Row
      // data. Fall back to /api/integrations/status (D-20 unchanged) so a
      // phased rollout, or a server that hasn't been restarted yet, still
      // renders the page (the legacy shape lacks the new fields → values
      // remain "—" via defensive accessors below, no crash).
      var res = await apiFetch('/api/integrations/health');
      if (!res.ok) {
        res = await apiFetch('/api/integrations/status');
      }
      if (!res.ok) throw new Error('Fetch failed');
      lastData = await res.json();
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

  // Build the 4 stat tiles per system. Phase 09.2 D-17 revised: per-system
  // health-tracker fields (latencyMs / uptimeSec / errors24h / sampleRate /
  // firmware) come via /api/integrations/health. The legacy /api/integrations/
  // status fallback (D-20 unchanged) lacks these fields → defensive accessors
  // return '—' so cards stay mockup-faithful without lying about numbers.
  // System-specific identity tiles (Broker, SOC, Discovery, Provider, ...)
  // remain when the legacy shape supplies them; otherwise they degrade.
  function buildStats(key, data) {
    var hasTrackerShape = data && (data.latencyMs != null || data.uptimeSec != null
                                || data.firmware !== undefined || data.sampleIntervalHistogramMs);
    switch (key) {
      case 'mqtt':
        if (hasTrackerShape) {
          return [
            { label: 'Latency', value: fmtLatency(data.latencyMs) },
            { label: 'Uptime', value: fmtUptime(data.uptimeSec) },
            { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
            { label: 'Last data', value: fmtRel(data.lastSampleAt) }
          ];
        }
        return [
          { label: 'Broker', value: data.broker || 'embedded' },
          { label: 'Topics', value: data.topicCount != null ? String(data.topicCount) : '—' },
          { label: 'Errors · 24h', value: '—' },
          { label: 'Last data', value: '—' }
        ];
      case 'tesla':
        if (hasTrackerShape) {
          return [
            { label: 'Latency', value: fmtLatency(data.latencyMs) },
            { label: 'Uptime', value: fmtUptime(data.uptimeSec) },
            { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
            { label: 'Last sample', value: fmtRel(data.lastSampleAt) }
          ];
        }
        var s = data.state || {};
        return [
          { label: 'SOC', value: s.batteryLevel != null ? (s.batteryLevel + '%') : '—' },
          { label: 'Status', value: s.state || '—' },
          { label: 'Geofence', value: s.geofence || '—' },
          { label: 'Last seen', value: fmtRel(data.lastUpdate) }
        ];
      case 'homeAssistant':
        if (hasTrackerShape) {
          return [
            { label: 'Latency', value: fmtLatency(data.latencyMs) },
            { label: 'Sample', value: fmtSampleRate(data.sampleIntervalHistogramMs) },
            { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
            { label: 'Last sync', value: fmtRel(data.lastSampleAt) }
          ];
        }
        return [
          { label: 'Discovery', value: data.haDiscovery ? 'auto' : 'aus' },
          { label: 'Entitäten', value: '—' },
          { label: 'Topics', value: '—' },
          { label: 'Last sync', value: '—' }
        ];
      case 'loxone':
        if (hasTrackerShape) {
          return [
            { label: 'Latency', value: fmtLatency(data.latencyMs) },
            { label: 'Uptime', value: fmtUptime(data.uptimeSec) },
            { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
            { label: 'Last sync', value: fmtRel(data.lastSampleAt) }
          ];
        }
        return [
          { label: 'Miniserver', value: data.configured ? 'konfiguriert' : 'aus' },
          { label: 'Sensoren', value: '—' },
          { label: 'Aktoren', value: '—' },
          { label: 'Last sync', value: '—' }
        ];
      case 'devices':
        if (hasTrackerShape) {
          return [
            { label: 'Latency', value: fmtLatency(data.latencyMs) },
            { label: 'Sample', value: fmtSampleRate(data.sampleIntervalHistogramMs) },
            { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
            { label: 'Last sample', value: fmtRel(data.lastSampleAt) }
          ];
        }
        return [
          { label: 'Gesamt', value: data.total != null ? String(data.total) : '0' },
          { label: 'Online', value: data.online != null ? String(data.online) : '0' },
          { label: 'Errors · 24h', value: '—' },
          { label: 'Sample', value: '—' }
        ];
      case 'notifications':
        if (hasTrackerShape) {
          return [
            { label: 'Latency', value: fmtLatency(data.latencyMs) },
            { label: 'Sample', value: fmtSampleRate(data.sampleIntervalHistogramMs) },
            { label: 'Errors · 24h', value: fmtCount(data.errors24h) },
            { label: 'Last send', value: fmtRel(data.lastSampleAt) }
          ];
        }
        var providers = Array.isArray(data.providers) ? data.providers : [];
        return [
          { label: 'Provider', value: providers.length ? providers.join(', ') : '—' },
          { label: 'Sent · 24h', value: '—' },
          { label: 'Failed · 24h', value: '—' },
          { label: 'Last send', value: '—' }
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
    return '<article class="' + cardClass + '" data-system="' + esc(sys.key) + '" data-status="' + esc(status) + '" data-filter="' + filterBucket(status) + '">'
      + '<header class="conn-head">'
        + '<div class="conn-logo">' + esc(sys.logo) + '</div>'
        + '<div class="conn-meta">'
          + '<div class="conn-name">' + esc(sys.label) + '</div>'
          + '<div class="conn-cat">' + esc(sys.category) + '</div>'
        + '</div>'
        + pulseHtml
        + '<span class="conn-status-chip"><span class="dot ' + dotClass + '"></span>' + esc(label) + '</span>'
      + '</header>'
      + '<div class="conn-stats">' + statsHtml + '</div>'
      + actions
    + '</article>';
  }

  // Phase 09.2 D-19 revised: Featured-Row hero card (Victron-only).
  // Bound by data-bind attributes in integrations.html. Uses textContent
  // (not innerHTML) so injection is impossible even if the server payload
  // ever contained user-supplied data — defence-in-depth XSS hardening.
  function renderFeatured(data) {
    var root = document.querySelector('.featured-row');
    if (!root) return;
    var feat = data && data.featured ? data.featured : null;
    var heartbeatEl = root.querySelector('[data-bind="victron.heartbeatSec"]');
    var modeEl = root.querySelector('[data-bind="victron.essMode"]');
    if (heartbeatEl) {
      heartbeatEl.textContent = feat && feat.victronHeartbeatSec != null
        ? String(feat.victronHeartbeatSec)
        : '—';
    }
    if (modeEl) {
      modeEl.textContent = (feat && feat.victronEssMode) ? feat.victronEssMode : '—';
    }
    var card = root.querySelector('.featured-card.victron');
    if (card) {
      card.classList.remove('is-warn', 'is-err', 'is-ok');
      var hb = feat ? feat.victronHeartbeatSec : null;
      if (hb == null)        card.classList.add('is-err');
      else if (hb > 300)     card.classList.add('is-err');
      else if (hb > 30)      card.classList.add('is-warn');
      else                   card.classList.add('is-ok');
    }
  }

  function renderAll(data) {
    var list = document.getElementById('intg-list');
    var empty = document.getElementById('intg-empty');
    if (!list) return;
    if (!data) return;

    // Featured-Row first — the hero card lives outside #intg-list and is
    // bound to fixed elements (no innerHTML rebuild on each poll).
    renderFeatured(data);

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

  // Start polling
  fetchStatus();
  setInterval(fetchStatus, POLL_INTERVAL_MS);
})();
