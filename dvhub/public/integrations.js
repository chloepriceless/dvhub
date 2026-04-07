(function () {
  'use strict';

  var POLL_INTERVAL_MS = 10000;
  var STALE_THRESHOLD_MS = 60000;

  var SYSTEMS = [
    { key: 'mqtt', label: 'MQTT Hub', icon: '\u{1F4E1}' },
    { key: 'tesla', label: 'TeslaMate', icon: '\u{1F697}' },
    { key: 'homeAssistant', label: 'Home Assistant', icon: '\u{1F3E0}' },
    { key: 'loxone', label: 'Loxone', icon: '\u{1F50C}' },
    { key: 'devices', label: 'Smart Plugs', icon: '\u{1F50B}' },
    { key: 'notifications', label: 'Notifications', icon: '\u{1F514}' }
  ];

  var lastData = null;

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

  function renderAll(data) {
    var list = document.getElementById('intg-list');
    var empty = document.getElementById('intg-empty');
    if (!list) return;

    var hasAny = data.mqtt?.connected || data.tesla?.enabled ||
                 data.homeAssistant?.haDiscovery || data.loxone?.configured ||
                 data.devices?.total > 0 || data.notifications?.enabled;

    if (empty) empty.style.display = hasAny ? 'none' : '';

    if (!hasAny) return;

    // Track which rows are expanded before re-render
    var expanded = new Set();
    list.querySelectorAll('.intg-row[aria-expanded="true"]').forEach(function (el) {
      expanded.add(el.dataset.system);
    });

    // Build rows
    var html = '';
    for (var i = 0; i < SYSTEMS.length; i++) {
      var sys = SYSTEMS[i];
      var sysData = data[sys.key];
      if (!sysData) continue;
      var status = getSystemStatus(sys.key, sysData);
      html += buildRow(sys, sysData, status);
    }
    list.innerHTML = html;

    // Restore expanded state
    expanded.forEach(function (key) {
      var row = list.querySelector('.intg-row[data-system="' + key + '"]');
      if (row) {
        row.setAttribute('aria-expanded', 'true');
        var detail = row.nextElementSibling;
        if (detail && detail.classList.contains('intg-detail')) {
          detail.removeAttribute('hidden');
        }
      }
    });
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

  function esc(str) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(String(str));
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildRow(sys, data, status) {
    var dotClass = status === 'online' ? 'dot-ok' :
                   status === 'stale' ? 'dot-warn' :
                   status === 'offline' ? 'dot-danger' : '';
    var statusText = status === 'online' ? 'Online' :
                     status === 'stale' ? 'Veraltet' :
                     status === 'offline' ? 'Offline' : 'Deaktiviert';
    var summary = buildSummary(sys.key, data);

    // NO inline onclick -- event delegation below handles clicks
    return '<div class="intg-row" data-system="' + esc(sys.key) + '" aria-expanded="false" tabindex="0">' +
      '<span class="intg-row-icon">' + sys.icon + '</span>' +
      '<span class="intg-row-label">' + esc(sys.label) + '</span>' +
      '<span class="intg-row-status">' +
        (dotClass ? '<span class="dot ' + dotClass + '"></span>' : '') +
        esc(statusText) +
      '</span>' +
    '</div>' +
    '<div class="intg-detail" hidden>' + summary + '</div>';
  }

  function buildSummary(key, data) {
    switch (key) {
      case 'mqtt':
        return '<div class="metric-row"><span>Broker</span><span>' + esc(data.broker || 'embedded') + '</span></div>' +
               '<div class="metric-row"><span>Topics</span><span>' + esc(data.topicCount || 0) + '</span></div>';
      case 'tesla':
        if (!data.state) return '<p>Keine Daten</p>';
        return '<div class="metric-row"><span>SOC</span><span>' + esc(data.state.batteryLevel ?? '-') + '%</span></div>' +
               '<div class="metric-row"><span>Status</span><span>' + esc(data.state.state || '-') + '</span></div>' +
               '<div class="metric-row"><span>Geofence</span><span>' + esc(data.state.geofence || '-') + '</span></div>';
      case 'devices':
        return '<div class="metric-row"><span>Gesamt</span><span>' + esc(data.total || 0) + '</span></div>' +
               '<div class="metric-row"><span>Online</span><span>' + esc(data.online || 0) + '</span></div>';
      case 'notifications':
        return '<div class="metric-row"><span>Provider</span><span>' + esc(data.providers?.join(', ') || 'keine') + '</span></div>';
      default:
        return '<p>Konfiguration siehe config.json</p>';
    }
  }

  // EVENT DELEGATION -- CSP compliant, no inline handlers
  // Addresses review HIGH concern: "inline onclick in generated HTML incompatible with CSP"
  document.addEventListener('click', function (e) {
    var row = e.target.closest('.intg-row');
    if (!row) return;
    var detail = row.nextElementSibling;
    if (!detail || !detail.classList.contains('intg-detail')) return;
    var isExpanded = row.getAttribute('aria-expanded') === 'true';
    row.setAttribute('aria-expanded', isExpanded ? 'false' : 'true');
    if (isExpanded) {
      detail.setAttribute('hidden', '');
    } else {
      detail.removeAttribute('hidden');
    }
  });

  // Keyboard accessibility for rows
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      var row = e.target.closest('.intg-row');
      if (row) {
        e.preventDefault();
        row.click();
      }
    }
  });

  // Start polling
  fetchStatus();
  setInterval(fetchStatus, POLL_INTERVAL_MS);
})();
