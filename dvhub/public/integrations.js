(function () {
  'use strict';

  var POLL_INTERVAL_MS = 10000;
  var STALE_THRESHOLD_MS = 60000;

  // System catalogue — drives card render order + per-system summary
  // shape. Phase 09.2 will extend each entry with health-endpoint fields
  // (latencyMs, uptimeSec, errors24h, sampleIntervalMs, firmware).
  var SYSTEMS = [
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
      var res = await apiFetch('/api/integrations/status');
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

  function getSystemStatus(key, data) {
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

  // Build the 4 stat tiles per system. Phase 09.2 will fill the EM-DASH
  // placeholders with real metrics; until then we render "—" for
  // metrics the backend doesn't expose so the layout stays mockup-faithful
  // without lying about numbers.
  function buildStats(key, data) {
    switch (key) {
      case 'mqtt':
        return [
          { label: 'Broker', value: data.broker || 'embedded' },
          { label: 'Topics', value: data.topicCount != null ? String(data.topicCount) : '—' },
          { label: 'Errors · 24h', value: '—' },
          { label: 'Last data', value: '—' }
        ];
      case 'tesla':
        var s = data.state || {};
        return [
          { label: 'SOC', value: s.batteryLevel != null ? (s.batteryLevel + '%') : '—' },
          { label: 'Status', value: s.state || '—' },
          { label: 'Geofence', value: s.geofence || '—' },
          { label: 'Last seen', value: fmtRel(data.lastUpdate) }
        ];
      case 'homeAssistant':
        return [
          { label: 'Discovery', value: data.haDiscovery ? 'auto' : 'aus' },
          { label: 'Entitäten', value: '—' },
          { label: 'Topics', value: '—' },
          { label: 'Last sync', value: '—' }
        ];
      case 'loxone':
        return [
          { label: 'Miniserver', value: data.configured ? 'konfiguriert' : 'aus' },
          { label: 'Sensoren', value: '—' },
          { label: 'Aktoren', value: '—' },
          { label: 'Last sync', value: '—' }
        ];
      case 'devices':
        return [
          { label: 'Gesamt', value: data.total != null ? String(data.total) : '0' },
          { label: 'Online', value: data.online != null ? String(data.online) : '0' },
          { label: 'Errors · 24h', value: '—' },
          { label: 'Sample', value: '—' }
        ];
      case 'notifications':
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
    if (sys.key === 'mqtt' || sys.key === 'tesla' || sys.key === 'homeAssistant' || sys.key === 'loxone' || sys.key === 'devices' || sys.key === 'notifications') {
      actions = '<div class="conn-actions">'
        + '<a class="btn sm ghost" href="/settings.html#system">Logs</a>'
        + '<a class="btn sm" href="/settings.html">Konfig.</a>'
        + '</div>';
    }
    return '<article class="' + cardClass + '" data-system="' + esc(sys.key) + '" data-status="' + esc(status) + '" data-filter="' + filterBucket(status) + '">'
      + '<header class="conn-head">'
        + '<div class="conn-logo">' + esc(sys.logo) + '</div>'
        + '<div class="conn-meta">'
          + '<div class="conn-name">' + esc(sys.label) + '</div>'
          + '<div class="conn-cat">' + esc(sys.category) + '</div>'
        + '</div>'
        + '<span class="conn-status-chip"><span class="dot ' + dotClass + '"></span>' + esc(label) + '</span>'
      + '</header>'
      + '<div class="conn-stats">' + statsHtml + '</div>'
      + actions
    + '</article>';
  }

  function renderAll(data) {
    var list = document.getElementById('intg-list');
    var empty = document.getElementById('intg-empty');
    if (!list) return;
    if (!data) return;

    // Build cards for every system present in the response payload
    var cards = [];
    var counts = { all: 0, connected: 0, disabled: 0 };
    var anyData = false;
    for (var i = 0; i < SYSTEMS.length; i++) {
      var sys = SYSTEMS[i];
      var sysData = data[sys.key];
      if (!sysData) continue;
      anyData = true;
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
