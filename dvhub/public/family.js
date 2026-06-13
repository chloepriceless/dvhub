/* DVhub Family Dashboard — ported from energiefluss-photorealistic.html
   Decisions: D-01 (port), D-09 (5 tags), D-10 (forecast/price widgets),
   D-11 (device cards), D-12 (configurable bottom-bar), D-13 (surplus greeting),
   D-22 (offline fallback, last-known values preserved).
   CSP note: this module is loaded as an external script because routes-api.js
   SECURITY_HEADERS['Content-Security-Policy'] disallows 'unsafe-inline' for
   script-src. All inline onclick handlers from the original have been replaced
   with event delegation via data-action attributes. */

(function () {
  'use strict';

  /* =======================================================================
     API KONFIGURATION (D-05, D-06)
     ======================================================================= */
  var FAMILY_STATUS_URL = '/api/family/status';
  var FAMILY_PRESENCE_URL = '/api/family/presence';
  var POLL_INTERVAL_MS = 5000;              // D-06 (match 5s Victron poll cycle)
  var DEVICE_THRESHOLD_W = 50;              // Geräte erst ab 50W anzeigen (D-11)
  var LS_SLOTS_KEY = 'dvhub.family.slots';  // Pitfall 3 — namespaced
  var LS_OFFLINE_GRACE_POLLS = 2;           // D-22 — show banner after 2 failed polls
  var lastStatus = null;
  var lastStatusAt = 0;
  var failedPolls = 0;

  function apiFetchCompat(path, init) {
    var common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, init);
    return fetch(path, init);
  }

  /* Event delegation for tag taps (detail panels) */
  document.addEventListener('click', function (e) {
    var actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      var action = actionEl.getAttribute('data-action');
      if (action === 'toggle-edit') { toggleEdit(); return; }
      if (action === 'close-picker') { closePicker(); return; }
      if (action === 'close-fam-settings') { closeFamSettings(); return; }
      if (action === 'close-panel') { closePanel(); return; }
      if (action === 'pick-metric') {
        var key = actionEl.getAttribute('data-metric-key');
        if (key) pickMetric(key);
        return;
      }
      if (action === 'pick-period') {
        var pkey = actionEl.getAttribute('data-period-key');
        if (pkey) pickPeriod(pkey);
        return;
      }
      if (action === 'slot-click') {
        var idx = parseInt(actionEl.getAttribute('data-slot'), 10);
        if (!isNaN(idx)) slotClick(idx);
        return;
      }
    }
    var tag = e.target.closest('[data-panel]');
    if (tag) {
      if (tagDragSuppressTap) return; // T-0091: a drag just ended — not a tap
      openPanel(tag.getAttribute('data-panel'));
    }
  });
  document.addEventListener('touchend', function (e) {
    var tag = e.target.closest('[data-panel]');
    var actionEl = e.target.closest('[data-action]');
    if (actionEl) return; // click handler will fire
    if (tag) {
      if (tagDragSuppressTap) { e.preventDefault(); return; } // T-0091
      e.preventDefault(); openPanel(tag.getAttribute('data-panel'));
    }
  }, { passive: false });

  var NS = 'http://www.w3.org/2000/svg';
  var panelChart = null;
  var activeDevices = {};

  /* Phase 11-06 round 10: the Tesla side-profile glyph used both on the #tag-ev
     constellation node (inline in family.html) and as the EV detail-panel icon
     (set here via innerHTML). currentColor inherits the EV accent purple;
     CSP-safe — SVG presentation attributes only, no inline style=. The same
     <path> data as the family.html markup so the two surfaces match. */
  var TESLA_GLYPH_SVG = '<svg class="tesla-glyph" viewBox="0 0 64 26" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tesla">'
    + '<path fill="currentColor" d="M9.6 23.4c-2 0-3.6-1.6-3.6-3.6 0-.5.1-1 .3-1.5H3.4c-1.3 0-2.4-1-2.5-2.3l-.3-3c-.1-1 .5-2 1.4-2.4l5.6-2.6 4.3-4.4C12.7 2 14 1.4 15.4 1.4h22.9c1.6 0 3.1.7 4.2 1.9l3.6 4.1 9.7 1.7c2.4.4 4.3 2.3 4.7 4.7l.3 1.8c.3 1.8-1.1 3.5-3 3.5h-3.4c.2.5.3 1 .3 1.5 0 2-1.6 3.6-3.6 3.6s-3.6-1.6-3.6-3.6c0-.5.1-1 .3-1.5H16.5c.2.5.3 1 .3 1.5 0 2-1.6 3.6-3.6 3.6z"/>'
    + '<circle cx="13.2" cy="19.8" r="2.1" fill="#0a0c12"/><circle cx="51.4" cy="19.8" r="2.1" fill="#0a0c12"/></svg>';

  /* Panel data for main tags (static copy seeded from original; stats are
     rewritten on every poll via applyFamilyStatus -> updatePanelStats) */
  var panelData = {
    solar: { icon: '&#9728;&#65039;', iconBg: 'rgba(247,183,49,.1)', title: 'Solaranlage', sub: 'Deine Module auf dem Dach', color: '#F7B731', summary: 'Die Solaranlage wandelt Sonnenlicht in Strom um. An guten Tagen deckst du den gesamten Hausverbrauch und lädst gleichzeitig Batterie und Auto.', stats: [{ label: 'Gerade', val: '—', delta: '', up: true }, { label: 'Heute', val: '—', delta: '', up: true }, { label: 'Morgen', val: '—', delta: '', up: true }], chart: null, details: [['Status', 'Live von /api/family/status']] },
    home: { icon: '&#127968;', iconBg: 'rgba(75,123,236,.1)', title: 'Dein Zuhause', sub: 'Gesamtverbrauch', color: '#4b7bec', summary: 'Der Verbrauch wird berechnet aus Solar minus Batterie, Auto und Netz.', stats: [{ label: 'Gerade', val: '—', delta: '', up: true }, { label: 'Heute', val: '—', delta: '', up: true }, { label: 'Eigenverbrauch', val: '—', delta: '', up: true }], chart: null, details: [['Berechnung', 'Solar - Batterie - Auto - Netz']] },
    bat: { icon: '&#128267;', iconBg: 'rgba(38,222,129,.1)', title: 'Batteriespeicher', sub: 'Dein Stromspeicher', color: '#26de81', summary: 'Speichert Solarüberschuss für den Abend.', stats: [{ label: 'Stand', val: '—', delta: '', up: true }, { label: 'Leistung', val: '—', delta: '', up: true }, { label: 'Reicht', val: '—', delta: '', up: true }], chart: null, details: [['Kapazität', '—']] },
    ev: { icon: TESLA_GLYPH_SVG, iconBg: 'rgba(165,94,234,.1)', title: 'E-Auto', sub: 'Solarüberschuss-Laden', color: '#a55eea', summary: 'Lädt clever mit dem Strom den die Sonne liefert.', stats: [{ label: 'Leistung', val: '—', delta: '', up: true }, { label: 'Akku', val: '—', delta: '', up: true }, { label: 'Modus', val: '—', delta: '', up: true }], chart: null, details: [['Wallbox', '—']] },
    grid: { icon: '&#9889;', iconBg: 'rgba(253,150,68,.1)', title: 'Stromnetz', sub: 'Einspeisung & Bezug', color: '#fd9644', summary: 'Richtung und Preis live vom /api/family/status Endpoint.', stats: [{ label: 'Gerade', val: '—', delta: '', up: true }, { label: 'Preis jetzt', val: '—', delta: '', up: true }, { label: 'Min/Max heute', val: '—', delta: '', up: true }], chart: null, details: [['Tarif', 'Dynamisch']] },
    forecast: { icon: '&#9925;', iconBg: 'rgba(247,183,49,.08)', title: 'PV Vorhersage', sub: 'Heute & Morgen', color: '#F7B731', summary: 'Die PV-Vorhersage basiert auf Wetterdaten und pvlib-Simulation.', stats: [{ label: 'Heute', val: '—', delta: '', up: true }, { label: 'Morgen', val: '—', delta: '', up: true }, { label: 'Peak', val: '—', delta: '', up: true }], chart: null, details: [['Quelle', '/api/forecast']] },
    price: { icon: '&#128181;', iconBg: 'rgba(253,150,68,.08)', title: 'EPEX Strompreis', sub: 'Day-Ahead Markt', color: '#fd9644', summary: 'Stündliche EPEX Day-Ahead Börsenpreise.', stats: [{ label: 'Jetzt', val: '—', delta: '', up: true }, { label: 'Min heute', val: '—', delta: '', up: true }, { label: 'Max heute', val: '—', delta: '', up: true }], chart: null, details: [['Quelle', '/api/forecast (price slots)']] },
    optimizer: { icon: '&#129302;', iconBg: 'rgba(75,123,236,.08)', title: 'Optimizer', sub: 'DV-EOS Vorhersage', color: '#4b7bec', summary: 'DV-EOS plant Laden, Entladen und Einspeisen aus EPEX-Preisen, PV- und Last-Prognose. Die Tabelle zeigt den geplanten Verlauf inkl. erwartetem Akkustand.', stats: [{ label: 'Jetzt', val: '—', delta: '', up: true }, { label: 'Als nächstes', val: '—', delta: '', up: true }, { label: 'Status', val: '—', delta: '', up: true }], chart: null, details: [['Fahrplan', '\u2014']] },
    weather: { icon: '&#9925;', iconBg: 'rgba(52,219,255,.08)', title: 'Wetter', sub: 'Open-Meteo · Standort der Anlage', color: '#34dbff', summary: 'Stundenprognose aus der Wetter-Integration, die auch die PV-Vorhersage speist.', stats: [{ label: 'Jetzt', val: '—', delta: '', up: true }, { label: 'Heute', val: '—', delta: '', up: true }, { label: 'Regen', val: '—', delta: '', up: true }], chart: null, details: [] },
  };

  /* ===================== TILE ICON / COLOUR HEURISTIC (D-01..D-04) ==========
     Per-tile icon + accent colour for MQTT value tiles. An explicit
     tile.icon / tile.color (operator-picked in the integrations editor) always
     wins; an unset field is auto-derived from the tile's unit (preferred) or
     topic (fallback). 100% backward compatible — icon/color are additive
     optional config fields, so an existing prod tile with neither still
     renders a sensible auto icon + colour with zero migration.

     family.js is a browser IIFE and cannot `import` the ESM module
     dvhub/services/family/tile-meta.js, so the SAME RULES table is re-declared
     inline here (the Phase 11 browser-consumption approach — 11-01-SUMMARY).
     tile-meta.js stays the test's single source of truth; this inline copy
     MUST mirror it exactly. */
  var TILE_META_FALLBACK = { icon: '📡', color: '#78909c' };
  // Ordered rules — first match wins. `units` matched against the lowercased
  // unit; `topicIncludes` against the lowercased topic. Unit rules are checked
  // across ALL rules before any topic rule, so a power unit always wins over a
  // topic match (unit `W` + topic `tesla` → ⚡, not 🚗).
  var TILE_META_RULES = [
    { units: ['w', 'kw', 'mw'],            icon: '⚡',  color: '#F7B731' },
    { units: ['wh', 'kwh'],                icon: '🔋', color: '#26de81' },
    { units: ['°c', '°f', 'c', 'k'],       icon: '🌡️', color: '#ff6b6b' },
    { units: ['%'],                        icon: '💧', color: '#4b7bec' },
    { units: ['v', 'a', 'hz'],             icon: '🔌', color: '#22d3ee' },
    { units: ['ct', 'ct/kwh', 'eur', '€'], icon: '💡', color: '#fd9644' },
    { units: ['lx', 'lux'],                icon: '💡', color: '#F7B731' },
    { units: ['ppm', 'µg/m³'],             icon: '💨', color: '#4b7bec' },
    { topicIncludes: ['tesla', 'car', 'ev'], icon: '🚗', color: '#a55eea' },
    { topicIncludes: ['temp', 'klima'],      icon: '🌡️', color: '#ff6b6b' }
  ];

  // Auto-derive { icon, color } purely from a tile's unit/topic. Slate
  // fallback when nothing matches.
  function autoTileMeta(tile) {
    var unit = String((tile && tile.unit) || '').trim().toLowerCase();
    var topic = String((tile && tile.topic) || '').toLowerCase();
    var i, r;
    for (i = 0; i < TILE_META_RULES.length; i++) {
      r = TILE_META_RULES[i];
      if (r.units && unit && r.units.indexOf(unit) !== -1) {
        return { icon: r.icon, color: r.color };
      }
    }
    for (i = 0; i < TILE_META_RULES.length; i++) {
      r = TILE_META_RULES[i];
      if (r.topicIncludes) {
        for (var j = 0; j < r.topicIncludes.length; j++) {
          if (topic.indexOf(r.topicIncludes[j]) !== -1) {
            return { icon: r.icon, color: r.color };
          }
        }
      }
    }
    return { icon: TILE_META_FALLBACK.icon, color: TILE_META_FALLBACK.color };
  }

  // Resolve a tile's final { icon, color }. An explicit tile.icon / tile.color
  // wins per-field; each unset field falls through to the heuristic. Mirrors
  // resolveTileIconColor() in services/family/tile-meta.js.
  function resolveTileMeta(tile) {
    var auto = autoTileMeta(tile);
    var icon = (tile && typeof tile.icon === 'string' && tile.icon.trim())
      ? tile.icon
      : auto.icon;
    var color = (tile && typeof tile.color === 'string' && tile.color.trim())
      ? tile.color
      : auto.color;
    return { icon: icon, color: color };
  }

  // Power-unit classifier (D-06). Re-declared inline here per 11-01-SUMMARY —
  // family.js is a browser IIFE and cannot import services/family/tile-meta.js,
  // so this MUST mirror isPowerUnit() in that ESM module exactly: true for
  // W / kW / MW, case-insensitive, whitespace-trimmed.
  function isPowerUnit(unit) {
    var u = String(unit == null ? '' : unit).trim().toLowerCase();
    return u === 'w' || u === 'kw' || u === 'mw';
  }

  // Convert a #RRGGBB hex string to an [r,g,b] triplet for a bgFlow stream
  // color. Falls back to Slate (#78909c → [120,144,156]) on a malformed hex,
  // matching the TILE_META_FALLBACK colour.
  function hexToRgb(hex) {
    var h = String(hex == null ? '' : hex).trim().replace(/^#/, '');
    if (h.length === 3) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [120, 144, 156];
    return [
      parseInt(h.substr(0, 2), 16),
      parseInt(h.substr(2, 2), 16),
      parseInt(h.substr(4, 2), 16)
    ];
  }

  // The currently-open panel key — set by openPanel(), cleared by closePanel().
  // The lazy MQTT-history fetch checks this before drawing so a result that
  // arrives after the panel was closed (or switched) is discarded.
  var currentPanelKey = null;

  // Show/clear a no-data message inside .panel-chart. The message element is
  // created lazily; the text is set via .textContent (never innerHTML markup)
  // — D-14 / T-11-18 CSP posture.
  function setPanelChartMessage(text) {
    var box = document.querySelector('.panel-chart');
    if (!box) return;
    var msg = box.querySelector('.panel-chart-empty');
    if (!msg) {
      msg = document.createElement('div');
      msg.className = 'panel-chart-empty';
      box.appendChild(msg);
    }
    if (text) {
      msg.textContent = text;
      msg.style.display = '';
    } else {
      msg.textContent = '';
      msg.style.display = 'none';
    }
  }

  /* Build (or rebuild) the Chart.js line chart for the currently-open panel.
     `d.chart` may be:
       - a bare array (the 5 main tags — 96 = 15-min EPEX, else hourly), OR
       - an { labels:[], data:[] } object (an MQTT tile's lazily-fetched
         today history — labels are HH:MM strings from the sample ts).
     A falsy/empty `d.chart` hides the chart section. */
  function renderPanelChart(d, key) {
    // Pitfall 1 — destroy before re-creating to avoid chart instance leak.
    if (panelChart) { panelChart.destroy(); panelChart = null; }
    var box = document.querySelector('.panel-chart');
    var canvas = document.getElementById('p-chart');

    var labels = null, series = null, isMqtt = false;
    if (d && d.chart && !Array.isArray(d.chart)
        && Array.isArray(d.chart.labels) && Array.isArray(d.chart.data)) {
      labels = d.chart.labels; series = d.chart.data; isMqtt = true;
    } else if (d && Array.isArray(d.chart) && d.chart.length) {
      series = d.chart;
      // Derive x-axis labels from the chart array length — 96 = 15-min EPEX
      // resolution (00:00, 00:15, …, 23:45), 24 = hourly (00:00..23:00).
      if (d.chart.length === 96) {
        labels = [];
        for (var hh = 0; hh < 24; hh++) {
          for (var mm = 0; mm < 60; mm += 15) {
            labels.push(String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'));
          }
        }
      } else {
        labels = Array.from({ length: 24 }, function (_, i) { return String(i).padStart(2, '0') + ':00'; });
      }
    }

    if (!series || !series.length) {
      // No chart for this panel — hide the section. (An MQTT tile with no
      // history reaches setPanelChartMessage() separately, which keeps the
      // section visible; this branch covers the no-chart main tags.)
      if (box) box.style.display = 'none';
      if (canvas) canvas.style.display = 'none';
      return;
    }

    if (box) box.style.display = '';
    if (canvas) canvas.style.display = '';
    setPanelChartMessage('');
    var ctx = canvas.getContext('2d');
    // Unit per panel: price chart shows ct/kWh, MQTT tiles show their own unit,
    // everything else shows kW. Signed panels (bat, grid) skip beginAtZero so
    // Chart.js auto-scales the y-axis to include negative values.
    var isPrice = key === 'price';
    var isSigned = (key === 'bat' || key === 'grid');
    var mqttUnit = isMqtt ? (d.chartUnit || '') : '';
    var unitFn;
    if (isMqtt) {
      unitFn = function (v) {
        var n = (typeof v === 'number') ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : v;
        return mqttUnit ? n + ' ' + mqttUnit : String(n);
      };
    } else if (isPrice) {
      unitFn = function (v) { return (typeof v === 'number' ? v.toFixed(1) : v) + ' ct'; };
    } else {
      unitFn = function (v) { return (typeof v === 'number' ? v.toFixed(2) : v) + ' kW'; };
    }
    panelChart = new Chart(ctx, {
      type: 'line',
      data: { labels: labels, datasets: [{ data: series, borderColor: d.color, backgroundColor: d.color + '18', fill: true, tension: .4, pointRadius: 0, borderWidth: 2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // mode:'index' + intersect:false makes mouseover AND touchmove reveal
        // the value at whichever x the finger/pointer is over, even between
        // line segments. Essential on the tablet where there are no hover
        // events and the chart is touch-driven.
        interaction: { mode: 'index', intersect: false, axis: 'x' },
        hover: { mode: 'index', intersect: false, axis: 'x' },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            backgroundColor: 'rgba(14,16,24,.92)', titleColor: '#fff', bodyColor: '#ccc',
            borderColor: 'rgba(255,255,255,.1)', borderWidth: 1, cornerRadius: 10, padding: 10,
            displayColors: false,
            callbacks: {
              title: function (items) { return items && items[0] ? items[0].label + ' Uhr' : ''; },
              label: function (c) { return unitFn(c.parsed.y); }
            }
          }
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: 'rgba(255,255,255,.2)', font: { size: 10 }, maxTicksLimit: 6 }, border: { display: false } },
          y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: 'rgba(255,255,255,.2)', font: { size: 10 }, callback: function (v) { return unitFn(v); } }, border: { display: false }, beginAtZero: !isSigned }
        }
      }
    });
  }

  // Format an MQTT-tile sample timestamp into a kiosk HH:MM label.
  function fmtTileHistTime(ts) {
    var dt = new Date(ts);
    if (isNaN(dt.getTime())) return '';
    return String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0');
  }

  /* Lazily fetch an MQTT tile's today history and render it as the Verlauf
     heute chart (D-14, RESEARCH Pattern 2 option A). openPanel() stays
     synchronous; this fires the async fetch and re-renders only the chart
     section on resolve. Empty history → the no-data copy. A non-numeric tile,
     a network error, or a 503 degrade gracefully — no error is surfaced to the
     kiosk (T-11-16). Guarded against the panel being closed/switched before
     the fetch resolves. */
  function loadTileHistoryChart(key, tileId) {
    if (!tileId) return;
    fetch('/api/family/tile-history?id=' + encodeURIComponent(tileId))
      .then(function (resp) { return resp.json(); })
      .then(function (body) {
        // Discard a result for a panel that is no longer the open one.
        if (currentPanelKey !== key) return;
        if (!document.getElementById('overlay').classList.contains('open')) return;
        var d = panelData[key];
        if (!d) return;
        var rows = (body && body.ok && Array.isArray(body.data)) ? body.data : [];
        if (!rows.length) {
          // Empty history — show the no-data copy, no chart, keep the section
          // visible so the operator sees the explanation.
          d.chart = null;
          if (panelChart) { panelChart.destroy(); panelChart = null; }
          var box = document.querySelector('.panel-chart');
          var canvas = document.getElementById('p-chart');
          if (box) box.style.display = '';
          if (canvas) canvas.style.display = 'none';
          setPanelChartMessage('Noch keine Verlaufsdaten — die Kurve erscheint, sobald Werte eintreffen.');
          return;
        }
        var labels = [], values = [];
        rows.forEach(function (r) {
          labels.push(fmtTileHistTime(r.ts));
          values.push(typeof r.value === 'number' ? r.value : Number(r.value));
        });
        d.chart = { labels: labels, data: values };
        d.chartUnit = (rows[0] && rows[0].unit) || '';
        renderPanelChart(d, key);
      })
      .catch(function (err) {
        // Network / 503 / parse error must not throw into the kiosk — degrade
        // to a hidden chart, log to console only (T-11-16).
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('tile-history fetch failed', err);
        }
        if (currentPanelKey !== key) return;
        if (!document.getElementById('overlay').classList.contains('open')) return;
        if (panelChart) { panelChart.destroy(); panelChart = null; }
        var box = document.querySelector('.panel-chart');
        var canvas = document.getElementById('p-chart');
        if (canvas) canvas.style.display = 'none';
        if (box) box.style.display = 'none';
      });
  }

  /* Format a Tesla-history sample timestamp into a kiosk label. The tesla
     window spans several days (sparse charge events), so include the day. */
  function fmtTeslaHistTime(ts) {
    var dt = new Date(ts);
    if (isNaN(dt.getTime())) return '';
    return String(dt.getDate()).padStart(2, '0') + '.'
      + String(dt.getMonth() + 1).padStart(2, '0') + ' '
      + String(dt.getHours()).padStart(2, '0') + ':'
      + String(dt.getMinutes()).padStart(2, '0');
  }

  /* Lazily fetch the Tesla charge history and render it as the EV-panel
     "Verlauf heute" chart. Mirrors loadTileHistoryChart() exactly: openPanel()
     stays synchronous, this fires the async fetch and re-renders only the
     chart section on resolve. The primary series is tesla_charger_power (the
     charge power over time). Empty history → the no-data copy; a network
     error / 503 degrades to a hidden chart, console-only (no kiosk error).
     Guarded against the panel being closed/switched before the fetch lands. */
  function loadTeslaHistoryChart(key) {
    fetch('/api/family/tesla-history')
      .then(function (resp) { return resp.json(); })
      .then(function (body) {
        if (currentPanelKey !== key) return;
        if (!document.getElementById('overlay').classList.contains('open')) return;
        var d = panelData[key];
        if (!d) return;
        var allRows = (body && body.ok && Array.isArray(body.data)) ? body.data : [];
        // The route returns tesla_charger_power AND tesla_battery_level rows;
        // the charge-history chart plots the charge power.
        var rows = allRows.filter(function (r) { return r && r.key === 'tesla_charger_power'; });
        if (!rows.length) {
          d.chart = null;
          if (panelChart) { panelChart.destroy(); panelChart = null; }
          var box = document.querySelector('.panel-chart');
          var canvas = document.getElementById('p-chart');
          if (box) box.style.display = '';
          if (canvas) canvas.style.display = 'none';
          setPanelChartMessage('Noch keine Ladehistorie — die Kurve erscheint, sobald das Auto wieder lädt.');
          return;
        }
        var labels = [], values = [];
        rows.forEach(function (r) {
          labels.push(fmtTeslaHistTime(r.ts));
          values.push(typeof r.value === 'number' ? r.value : Number(r.value));
        });
        d.chart = { labels: labels, data: values };
        d.chartUnit = (rows[0] && rows[0].unit) || 'kW';
        renderPanelChart(d, key);
      })
      .catch(function (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('tesla-history fetch failed', err);
        }
        if (currentPanelKey !== key) return;
        if (!document.getElementById('overlay').classList.contains('open')) return;
        if (panelChart) { panelChart.destroy(); panelChart = null; }
        var box = document.querySelector('.panel-chart');
        var canvas = document.getElementById('p-chart');
        if (canvas) canvas.style.display = 'none';
        if (box) box.style.display = 'none';
      });
  }

  /* Task #19 (operator request 2026-06-13): the optimizer detail panel shows
     the COMPLETE DV-EOS forecast — EOS' own optimised trajectory with the
     expected battery SoC per 15-min slot — adapted from the Settings →
     Forecast → DV-EOS inspector table to the kiosk. Lazily fetched on panel
     open (the inspector pulls EOS live; polling it on the 3-s tick would
     hammer the EOS service). While loading / when EOS is off or the backend
     has no result yet, the panel keeps the Fahrplan rows openPanel() already
     rendered from planSlots — graceful fallback, never an error overlay. */
  function famEosActionLabel(r, prevSocPct) {
    if (typeof r.zeitplanAction === 'string') {
      switch (r.zeitplanAction) {
        case 'co_export':      return { txt: '\u26a1 PV+Akku \u2192 Netz', cls: 'fam-eos-exp' };
        case 'battery_export': return { txt: '\u26a1 Akku \u2192 Netz', cls: 'fam-eos-exp' };
        case 'pv_export':      return { txt: '\u26a1 PV-\u00dcberschuss', cls: 'fam-eos-exp' };
        case 'charge':         return { txt: '\u2600 Akku l\u00e4dt', cls: 'fam-eos-chg' };
        case 'grid_draw':      return { txt: '\u2193 Netzbezug', cls: 'fam-eos-imp' };
        case 'hold':           return { txt: '\u2192 Halten', cls: '' };
        default:               return { txt: r.zeitplanLabel || r.zeitplanAction, cls: '' };
      }
    }
    // Older backend without zeitplanAction — same SoC-delta heuristic the
    // settings inspector renderer falls back to.
    var d = (typeof r.socPct === 'number' && typeof prevSocPct === 'number') ? r.socPct - prevSocPct : 0;
    if (typeof r.gridFeedinWh === 'number' && r.gridFeedinWh > 1) return { txt: '\u26a1 Einspeisen', cls: 'fam-eos-exp' };
    if (d >= 1) return { txt: '\u2600 Akku l\u00e4dt', cls: 'fam-eos-chg' };
    if (d <= -1) return { txt: '\u2193 Entladen', cls: '' };
    return { txt: '\u2192 Halten', cls: '' };
  }

  function loadEosForecastPanel(key) {
    var now = new Date();
    var qs = '?from=' + encodeURIComponent(now.toISOString()) +
             '&to=' + encodeURIComponent(new Date(now.getTime() + 24 * 3600 * 1000).toISOString());
    apiFetchCompat('/api/forecast/inspector/eos' + qs)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (currentPanelKey !== key) return;
        if (!document.getElementById('overlay').classList.contains('open')) return;
        var details = document.getElementById('p-details');
        if (!details) return;
        var output = (j && j.ok && j.available !== false) ? (j.output || null) : null;
        var rows = (output && Array.isArray(output.rows)) ? output.rows : [];
        if (!rows.length) return; // keep the Fahrplan fallback rows
        function fmtSpW(w) {
          var a = Math.abs(w);
          return a >= 1000 ? (a / 1000).toFixed(1).replace('.', ',') + ' kW' : Math.round(a) + ' W';
        }
        var nowMs = Date.now();
        var trs = '';
        var prevSoc = null;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          var tMs = Date.parse(r.ts_utc);
          var act = famEosActionLabel(r, prevSoc);
          // Grid setpoint the slot would command: prefer the Zeitplan-Hebel
          // value (what the lever pulls), fall back to the raw net setpoint.
          var sp = (typeof r.zeitplanGridSetpointW === 'number') ? r.zeitplanGridSetpointW : r.dvhubSetpointW;
          var spTxt = '\u2013', spCls = '';
          if (typeof sp === 'number' && isFinite(sp)) {
            if (sp <= -1)     { spTxt = '\u2191 ' + fmtSpW(sp); spCls = 'fam-eos-exp'; }
            else if (sp >= 1) { spTxt = '\u2193 ' + fmtSpW(sp); spCls = 'fam-eos-imp'; }
            else              { spTxt = '0 W'; }
          }
          var isNow = isFinite(tMs) && tMs <= nowMs && nowMs < tMs + 15 * 60000;
          trs += '<tr' + (isNow ? ' class="fam-eos-now"' : '') + '>' +
            '<td>' + escapeMsg(famOptimizerHHMM(tMs)) + '</td>' +
            '<td class="num">' + (r.socPct != null ? escapeMsg(String(r.socPct)) + '\u202f%' : '\u2013') + '</td>' +
            '<td class="' + act.cls + '">' + escapeMsg(act.txt) + '</td>' +
            '<td class="num ' + spCls + '">' + escapeMsg(spTxt) + '</td>' +
            '<td class="num">' + ((typeof r.feedInCtKwh === 'number' && isFinite(r.feedInCtKwh)) ? escapeMsg(r.feedInCtKwh.toFixed(1)) + ' ct' : '\u2013') + '</td>' +
            '</tr>';
          if (r.socPct != null) prevSoc = r.socPct;
        }
        var genLbl = (output && output.generatedAt) ? famOptimizerHHMM(Date.parse(output.generatedAt)) : '';
        details.innerHTML =
          '<div class="fam-eos-meta">DV-EOS Vorhersage \u00b7 ' + rows.length + ' Slots (15 min)' +
            (genLbl ? ' \u00b7 Stand ' + escapeMsg(genLbl) : '') + '</div>' +
          '<div class="fam-eos-tbl-wrap"><table class="fam-eos-tbl">' +
            '<thead><tr><th>Zeit</th><th class="num">SoC</th><th>Aktion</th><th class="num">Netz</th><th class="num">B\u00f6rse</th></tr></thead>' +
            '<tbody>' + trs + '</tbody>' +
          '</table></div>';
        // Scroll the table to the "now" row so the operator lands in the present.
        var nowRow = details.querySelector('.fam-eos-now');
        var wrap = details.querySelector('.fam-eos-tbl-wrap');
        if (nowRow && wrap) wrap.scrollTop = Math.max(0, nowRow.offsetTop - 60);
      })
      .catch(function (err) {
        if (typeof console !== 'undefined' && console.warn) console.warn('eos inspector fetch failed', err);
      });
  }

  function openPanel(key) {
    var d = panelData[key]; if (!d) return;
    currentPanelKey = key;
    document.getElementById('p-icon').innerHTML = d.icon;
    document.getElementById('p-icon').style.background = d.iconBg;
    document.getElementById('p-title').innerHTML = d.title;
    document.getElementById('p-title').style.color = d.color;
    document.getElementById('p-sub').innerHTML = d.sub;
    document.getElementById('p-summary').innerHTML = d.summary;
    var sh = ''; d.stats.forEach(function (s) { sh += '<div class="stat-card"><div class="stat-label">' + s.label + '</div><div class="stat-val">' + s.val + '</div><div class="stat-delta ' + (s.up ? 'up' : 'down') + '">' + s.delta + '</div></div>'; });
    document.getElementById('p-stats').innerHTML = sh;
    // CSP-safe: set per-stat colors after innerHTML (style="..." in innerHTML
    // is parsed-as-HTML and blocked by style-src without 'unsafe-inline').
    var pStatVals = document.getElementById('p-stats').querySelectorAll('.stat-val');
    for (var siv = 0; siv < pStatVals.length; siv++) { pStatVals[siv].style.color = d.color; }
    var dh = ''; d.details.forEach(function (r) { dh += '<div class="detail-row"><span class="detail-key">' + r[0] + '</span><span class="detail-val">' + r[1] + '</span></div>'; });
    document.getElementById('p-details').innerHTML = dh;
    var api = document.getElementById('p-api'); if (d.apiHint) { api.innerHTML = d.apiHint; api.style.display = 'block'; } else { api.style.display = 'none'; }
    // Clear any stale no-data message from a previously-open MQTT panel.
    setPanelChartMessage('');
    // Chart section label — "Verlauf heute" for the today-windowed panels, but
    // the EV panel charts a multi-day Tesla charge history (round 10), so it
    // reads "Ladehistorie". textContent only — no markup (CSP posture).
    var chartLabel = document.querySelector('.panel-chart .chart-label');
    if (chartLabel) chartLabel.textContent = (key === 'ev') ? 'Ladehistorie' : 'Verlauf heute';
    // Render the chart synchronously for the 5 main tags (d.chart is already
    // populated from the poll). MQTT tiles arrive here with d.chart === null
    // and get their history lazily fetched below.
    renderPanelChart(d, key);
    // D-14 lazy "Verlauf heute" chart for an MQTT tile. The MQTT panel key is
    // 'fam-<tile.id>' (renderFamilyExtras builds panelKey = 'fam-' + tile.id);
    // the 5 main tags use plain keys (solar/home/...). A 'dev-*' or 'tesla'
    // panel is not an MQTT value tile and is skipped (no fetch, no chart).
    if (key.indexOf('fam-') === 0) {
      loadTileHistoryChart(key, key.slice(4));
    }
    // Plan 11-06 round 10 — the EV detail panel lazily fetches the Tesla
    // charge history (GET /api/family/tesla-history) and renders it as the
    // panel chart, the same way an MQTT tile renders its "Verlauf heute".
    if (key === 'ev') {
      loadTeslaHistoryChart(key);
    }
    // Task #19 — optimizer panel lazily loads the full DV-EOS forecast table
    // (incl. expected SoC); until it lands, the Fahrplan rows above show.
    if (key === 'optimizer') {
      loadEosForecastPanel(key);
    }
    document.getElementById('overlay').classList.add('open');
    document.getElementById('panel').scrollTop = 0;
  }
  function closePanel() {
    currentPanelKey = null;
    document.getElementById('overlay').classList.remove('open');
  }

  var panel = document.getElementById('panel');
  var startY = 0, currentY = 0, dragging = false;
  if (panel) {
    panel.addEventListener('touchstart', function (e) { if (panel.scrollTop > 5) return; startY = e.touches[0].clientY; dragging = true; }, { passive: true });
    panel.addEventListener('touchmove', function (e) { if (!dragging) return; currentY = e.touches[0].clientY; var dy = currentY - startY; if (dy > 0) panel.style.transform = 'translateY(' + dy + 'px)'; }, { passive: true });
    panel.addEventListener('touchend', function () { if (!dragging) return; dragging = false; panel.style.transform = ''; if (currentY - startY > 80) closePanel(); startY = 0; currentY = 0; });
  }

  /* ===================== DEVICE CARDS ===================== */
  // Initial value matches the empty device list that rebuildAll() at boot
  // already produces, so the first applyFamilyStatus → updateDevices([]) does
  // NOT re-rebuild the SVG and tear down Chrome's freshly-started SMIL timers.
  var lastDeviceFlowKey = '';
  function updateDevices(devices) {
    var tray = document.getElementById('devices-tray');
    var visible = (devices || []).filter(function (d) { return d && d.watts >= DEVICE_THRESHOLD_W; });
    visible.sort(function (a, b) { return b.watts - a.watts; });

    var currentIds = {};
    visible.forEach(function (d) { currentIds[d.id] = true; });

    Object.keys(activeDevices).forEach(function (id) {
      if (!currentIds[id]) {
        var el = activeDevices[id];
        el.classList.add('leaving');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
        delete activeDevices[id];
        delete panelData['dev-' + id];
      }
    });

    visible.forEach(function (d, i) {
      var cardId = 'dev-' + d.id;
      var el = activeDevices[d.id];
      var barPct = Math.min(100, Math.round((d.watts / 3000) * 100));
      var col = d.color || 'var(--device)';
      if (!el) {
        el = document.createElement('div');
        el.className = 'dev-card';
        el.id = 'dev-card-' + d.id;
        el.setAttribute('data-panel', cardId);
        el.style.animationDelay = (i * 0.06) + 's';
        // Review 2026-06-10 (P2-3): device name/emoji are operator/MQTT-sourced
        // strings — escape before the innerHTML sink (same rule as the MQTT
        // tiles below, which already run everything through escapeMsg()).
        el.innerHTML = '<div class="dev-emoji">' + escapeMsg(d.emoji) + '</div><div class="dev-name">' + escapeMsg(d.name) + '</div><div class="dev-watts">' + formatW(d.watts) + '</div><div class="dev-bar-wrap"><div class="dev-bar"></div></div>';
        el.querySelector('.dev-watts').style.color = col;
        el.querySelector('.dev-bar').style.width = barPct + '%';
        el.querySelector('.dev-bar').style.background = col;
        tray.appendChild(el);
        activeDevices[d.id] = el;
      } else {
        el.querySelector('.dev-watts').textContent = formatW(d.watts);
        el.querySelector('.dev-watts').style.color = col;
        el.querySelector('.dev-bar').style.width = barPct + '%';
        el.querySelector('.dev-bar').style.background = col;
      }
      // Review 2026-06-10 (P2-3): panelData feeds openPanel()'s innerHTML sinks
      // (p-title / p-summary / detail rows) — escape the device-sourced strings
      // at the source. Static panels above keep raw HTML icons by design.
      panelData[cardId] = {
        icon: escapeMsg(d.emoji), iconBg: 'rgba(120,144,156,.1)', title: escapeMsg(d.name), sub: 'Einzelverbraucher', color: d.color || '#78909c',
        summary: escapeMsg(d.name) + ' verbraucht gerade ' + formatW(d.watts) + '.',
        stats: [{ label: 'Gerade', val: formatW(d.watts), delta: d.watts > 500 ? 'Hoher Verbrauch' : 'Normal', up: d.watts < 500 }],
        chart: null,
        details: [['Aktueller Verbrauch', formatW(d.watts)], ['Quelle', 'Shelly / Smart Plug'], ['Gerät', escapeMsg(d.name)]]
      };
    });

    // Only rebuild the SVG flow graph when the actual set of visible devices
    // changes. Rebuilding clears the DOM and re-inserts SMIL <animateMotion>
    // elements — Chrome's SMIL implementation is unreliable when doing that
    // repeatedly on a live page, so a noisy poll cycle with no device
    // additions/removals would otherwise kill particle flows after the first
    // cycle. Watts changes still update the existing cards in place above.
    var newKey = visible.map(function (d) { return d.id; }).join('|');
    if (newKey !== lastDeviceFlowKey) {
      lastDeviceFlowKey = newKey;
      rebuildAllWithDevices(visible);
    }
  }

  function formatW(w) { return w >= 1000 ? (w / 1000).toFixed(1) + ' kW' : Math.round(w) + ' W'; }

  /* ===================== FAMILY EXTRAS: MQTT tiles + Tesla ===================== */
  // Operator-configured generic MQTT value tiles (family.mqttTiles) + the full
  // TeslaMate snapshot, rendered into the (otherwise-unused) #devices-tray.
  // Cards are reconciled across polls so they update in place without
  // re-triggering the devPop entry animation. All dynamic strings are routed
  // through escapeMsg() before reaching openPanel(), which uses innerHTML.
  var familyExtraCards = {}; // logical-id -> element

  function fmtTileValue(value, unit) {
    if (value == null || value === '') return '—';
    var out;
    if (typeof value === 'number' && isFinite(value)) {
      out = Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
    } else if (typeof value === 'boolean') {
      out = value ? 'an' : 'aus';
    } else {
      out = String(value);
    }
    return unit ? out + ' ' + unit : out;
  }

  function fmtRelTime(ts) {
    if (!ts) return 'nie';
    var delta = Date.now() - Number(ts);
    if (delta < 0) return 'gerade';
    if (delta < 60000) return Math.floor(delta / 1000) + ' s';
    if (delta < 3600000) return Math.floor(delta / 60000) + ' min';
    if (delta < 86400000) return Math.floor(delta / 3600000) + ' h';
    return Math.floor(delta / 86400000) + ' d';
  }

  // Phase 11-06 round 9: TESLA_CHARGE_LABEL / TESLA_STATE_LABEL were removed
  // together with the standalone Tesla tray card — the EV panel (panelData.ev,
  // built in family.sr('family.ev')) carries its own German charge/state copy.

  // Phase 11-06 round 7: "is the Tesla charging" decided from BOTH signals.
  // TeslaMate re-publishes charger_power far more often than charging_state,
  // so after a dvhub restart charging_state can be momentarily null/stale
  // while the car is clearly drawing power. The server already exposes a
  // derived `tesla.charging` boolean (services/family/index.js) computed the
  // same way — prefer it; otherwise OR the two raw signals locally. No
  // fabricated values: only signals already present on the object.
  function teslaIsCharging(t) {
    if (!t) return false;
    if (typeof t.charging === 'boolean') return t.charging;
    return t.chargingState === 'Charging'
      || (typeof t.chargerPowerKw === 'number' && t.chargerPowerKw > 0);
  }

  // Phase 11-06 round 9: the `hasSub` param was dropped with the Tesla tray
  // card — only the generic MQTT value tile uses this now, which has no sub-row.
  function makeExtraCard(logicalId, panelKey, modifierClass) {
    var el = document.createElement('div');
    el.className = 'dev-card ' + modifierClass;
    el.id = 'fam-card-' + logicalId;
    el.setAttribute('data-panel', panelKey);
    el.innerHTML =
      '<div class="dev-emoji"></div>'
      + '<div class="dev-name"></div>'
      + '<div class="dev-watts fam-extra-val"></div>';
    return el;
  }

  // Phase 11-06 checkpoint round 9: the standalone Tesla tray card was removed.
  // The detailed EV constellation node (#tag-ev, with the round-5/6 SoC display)
  // is now the single Tesla surface — tapping it opens panelData.ev, which is
  // Tesla-driven in family.sr('family.ev'). renderFamilyExtras only renders the
  // generic MQTT value tiles into #devices-tray now.
  function renderFamilyExtras(mqttTiles) {
    var tray = document.getElementById('devices-tray');
    if (!tray) return;
    var wanted = {};

    // --- Generic MQTT value tiles -----------------------------------
    (mqttTiles || []).forEach(function (tile) {
      if (!tile || !tile.id) return;
      // "wenn werte stehen → anzeigen": skip tiles that never produced a value.
      if (tile.value == null && !tile.lastSeen) return;
      var logicalId = 'mqtt-' + tile.id;
      var panelKey = 'fam-' + tile.id;
      wanted[logicalId] = true;
      var card = familyExtraCards[logicalId];
      if (!card) {
        card = makeExtraCard(logicalId, panelKey, 'fam-tile');
        tray.appendChild(card);
        familyExtraCards[logicalId] = card;
      }
      var valTxt = fmtTileValue(tile.value, tile.unit);
      // Per-tile icon + accent colour (D-01..D-04): operator-picked tile.icon /
      // tile.color win, else auto-derived from unit/topic. Computed once before
      // the assignments below, which run on BOTH the create and update render
      // paths (the `if (!card)` block above only builds the DOM shell), so an
      // edited tile updates its glyph + accent in place across the 5s poll.
      var meta = resolveTileMeta(tile);
      card.classList.toggle('is-stale', !tile.online);
      card.querySelector('.dev-emoji').textContent = meta.icon;
      card.querySelector('.dev-name').textContent = tile.label || tile.topic;
      card.querySelector('.fam-extra-val').textContent = valTxt;
      // CSP-safe: per-element accent set via .style.color in JS AFTER the
      // textContent write — never a style= attribute in markup/innerHTML.
      card.querySelector('.fam-extra-val').style.color = meta.color;

      panelData[panelKey] = {
        icon: meta.icon, iconBg: meta.color + '1f',
        title: escapeMsg(tile.label || tile.topic), sub: 'MQTT', color: meta.color,
        summary: escapeMsg(tile.value != null
          ? (tile.label || 'Der Wert') + ' meldet aktuell ' + valTxt + '.'
          : 'Auf diesem Topic liegen aktuell keine Daten an.'),
        stats: [
          { label: 'Wert', val: escapeMsg(valTxt), delta: '', up: true },
          { label: 'Status', val: tile.online ? 'Live' : 'Offline', delta: '', up: !!tile.online },
          { label: 'Empfangen', val: tile.lastSeen ? escapeMsg(fmtRelTime(tile.lastSeen)) : 'nie', delta: '', up: true }
        ],
        chart: null,
        details: [
          ['Aktueller Wert', escapeMsg(valTxt)],
          ['MQTT-Topic', escapeMsg(tile.topic || '—')],
          ['Zuletzt empfangen', tile.lastSeen ? 'vor ' + fmtRelTime(tile.lastSeen) : 'nie'],
          ['Status', tile.online ? 'Live' : 'Offline']
        ]
      };
    });

    // --- Drop cards no longer wanted --------------------------------
    Object.keys(familyExtraCards).forEach(function (id) {
      if (!wanted[id]) {
        var el = familyExtraCards[id];
        if (el) {
          var pk = el.getAttribute('data-panel');
          if (pk) delete panelData[pk];
          if (el.parentNode) el.parentNode.removeChild(el);
        }
        delete familyExtraCards[id];
      }
    });
  }

  /* ===================== STICKY FLOWS ===================== */
  function edge(f, t) { var fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect(); var fc = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 }; var tc = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 }; var dx = tc.x - fc.x, dy = tc.y - fc.y, a = Math.atan2(dy, dx); var fs = Math.min((fr.width / 2 + 8) / Math.abs(Math.cos(a) || .001), (fr.height / 2 + 8) / Math.abs(Math.sin(a) || .001)); var ts = Math.min((tr.width / 2 + 8) / Math.abs(Math.cos(a) || .001), (tr.height / 2 + 8) / Math.abs(Math.sin(a) || .001)); return { x1: fc.x + Math.cos(a) * fs, y1: fc.y + Math.sin(a) * fs, x2: tc.x - Math.cos(a) * ts, y2: tc.y - Math.sin(a) * ts }; }
  /* Legacy SVG flows — #flowSvg is fully suppressed (opacity:0 in family.css) and
     kept only for binding-contract DOM compatibility. Phase 11-06 round 3: the
     'tag-home' endpoint was removed (the House is now #pfCenter), so these flows
     route through 'pfCenter' instead. They remain visually invisible. */
  var flows = [
    { from: 'tag-solar', to: 'pfCenter', hex: '#F7B731', w: 2.5, p: 3, wh: 2, dur: 1.8, id: 'f1' },
    { from: 'pfCenter', to: 'tag-bat', hex: '#26de81', w: 2, p: 2, wh: 1, dur: 2.2, id: 'f2' },
    { from: 'pfCenter', to: 'tag-ev', hex: '#a55eea', w: 2, p: 2, wh: 1, dur: 2.0, id: 'f3' },
    { from: 'pfCenter', to: 'tag-grid', hex: '#fd9644', w: 1.8, p: 1, wh: 1, dur: 2.8, id: 'f4' }
  ];
  var pathEls = {}, lblEls = {};         // pathEls[fl.id] = { fwd, rev } — two <path> elements per flow
  var particleGroupEls = {};             // particleGroupEls[fl.id] = { fwd, rev } — two <g> with circles+animateMotion
  var pathCoords = {};                   // fl.id -> { x1, y1, x2, y2, cx, cy } (forward orientation)
  var lastFlowDirection = {};            // fl.id -> 'forward' | 'reverse' — cached to avoid redundant visibility writes
  function addFlowToSvg(g, fl) {
    // Dual-path layout to work around Chrome SMIL limitations: each flow has
    // two <path> elements (forward + reverse) and two matching particle
    // groups built at load time, so all <animateMotion> elements exist
    // before SMIL starts. Show/hide toggles visibility on the outer group
    // (visibility:hidden pauses rendering without killing the animation
    // timeline, unlike display:none which tears down the SMIL state).
    // Direction flip swaps visibility between the fwd/rev particle groups.
    var fg = document.createElementNS(NS, 'g'); fg.id = 'fg-' + fl.id; fg.style.visibility = 'hidden';

    function makePath(suffix) {
      var pa = document.createElementNS(NS, 'path');
      pa.id = fl.id + suffix;
      pa.setAttribute('fill', 'none');
      pa.setAttribute('stroke', fl.hex);
      pa.setAttribute('stroke-width', fl.w);
      pa.setAttribute('stroke-dasharray', '10 18');
      pa.setAttribute('opacity', '0.35');
      pa.setAttribute('stroke-linecap', 'round');
      pa.style.animation = 'fd 1.2s linear infinite';
      return pa;
    }
    var paFwd = makePath('-fwd'); fg.appendChild(paFwd);
    var paRev = makePath('-rev'); paRev.style.visibility = 'hidden'; fg.appendChild(paRev);
    pathEls[fl.id] = { fwd: paFwd, rev: paRev };

    function makeParticleGroup(pathSuffix) {
      var pg = document.createElementNS(NS, 'g');
      pg.id = 'fg-' + fl.id + pathSuffix;
      for (var i = 0; i < fl.p; i++) {
        var c = document.createElementNS(NS, 'circle');
        c.setAttribute('r', fl.w > 2 ? '5' : '4');
        c.setAttribute('fill', fl.hex);
        c.setAttribute('filter', 'url(#gl)');
        c.setAttribute('opacity', '0.9');
        var am = document.createElementNS(NS, 'animateMotion');
        am.setAttribute('dur', fl.dur + 's');
        am.setAttribute('repeatCount', 'indefinite');
        am.setAttribute('begin', (i * (fl.dur / fl.p)).toFixed(2) + 's');
        var mp = document.createElementNS(NS, 'mpath');
        mp.setAttribute('href', '#' + fl.id + pathSuffix);
        am.appendChild(mp);
        c.appendChild(am);
        pg.appendChild(c);
      }
      for (var j = 0; j < fl.wh; j++) {
        var w = document.createElementNS(NS, 'circle');
        w.setAttribute('r', '2.5');
        w.setAttribute('fill', '#fff');
        w.setAttribute('opacity', '0.4');
        var am2 = document.createElementNS(NS, 'animateMotion');
        am2.setAttribute('dur', fl.dur + 's');
        am2.setAttribute('repeatCount', 'indefinite');
        am2.setAttribute('begin', ((j + 0.5) * (fl.dur / Math.max(fl.wh + fl.p, 1))).toFixed(2) + 's');
        var mp2 = document.createElementNS(NS, 'mpath');
        mp2.setAttribute('href', '#' + fl.id + pathSuffix);
        am2.appendChild(mp2);
        w.appendChild(am2);
        pg.appendChild(w);
      }
      return pg;
    }
    var pgFwd = makeParticleGroup('-fwd'); fg.appendChild(pgFwd);
    var pgRev = makeParticleGroup('-rev'); pgRev.style.visibility = 'hidden'; fg.appendChild(pgRev);
    particleGroupEls[fl.id] = { fwd: pgFwd, rev: pgRev };

    var tx = document.createElementNS(NS, 'text'); tx.setAttribute('fill', fl.hex); tx.setAttribute('font-family', 'Inter,sans-serif'); tx.setAttribute('font-size', '11'); tx.setAttribute('font-weight', '700'); tx.setAttribute('opacity', '0.85'); tx.setAttribute('text-anchor', 'middle'); tx.id = 'ft-' + fl.id; fg.appendChild(tx); lblEls[fl.id] = tx;
    g.appendChild(fg);
  }
  function buildFlows() { var g = document.getElementById('flowGroup'); g.innerHTML = ''; pathEls = {}; lblEls = {}; particleGroupEls = {}; pathCoords = {}; lastFlowDirection = {}; flows.forEach(function (fl) { addFlowToSvg(g, fl); }); }
  var lastDeviceFlows = [];
  function rebuildAllWithDevices(visibleDevices) {
    var g = document.getElementById('flowGroup'); g.innerHTML = ''; pathEls = {}; lblEls = {}; particleGroupEls = {}; pathCoords = {}; lastFlowDirection = {};
    flows.forEach(function (fl) { addFlowToSvg(g, fl); });
    lastDeviceFlows = [];
    if (visibleDevices) {
      visibleDevices.forEach(function (d, i) {
        var cardEl = document.getElementById('dev-card-' + d.id);
        if (!cardEl) return;
        var devFlow = { from: 'pfCenter', to: 'dev-card-' + d.id, hex: d.color || '#78909c', w: 1.2, p: 1, wh: 0, dur: 2.0 + i * 0.3, id: 'df-' + d.id };
        lastDeviceFlows.push(devFlow);
        addFlowToSvg(g, devFlow);
      });
    }
    setTimeout(function () {
      var W = window.innerWidth, H = window.innerHeight;
      document.getElementById('flowSvg').setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      var allFlows = flows.concat(lastDeviceFlows);
      allFlows.forEach(function (fl) {
        var fe = document.getElementById(fl.from), te = document.getElementById(fl.to);
        if (!fe || !te) return;
        var e = edge(fe, te);
        var mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2, dx = e.x2 - e.x1, dy = e.y2 - e.y1, len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) return;
        var nx = -dy / len, ny = dx / len, bulge = len * .15;
        var cx = mx + nx * bulge, cy = my + ny * bulge;
        // Store forward-orientation coords for reference. Both forward and
        // reverse <path> elements are updated so the two particle groups
        // have correct geometry from load time onwards.
        pathCoords[fl.id] = { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, cx: cx, cy: cy };
        var dFwd = 'M' + e.x1.toFixed(1) + ' ' + e.y1.toFixed(1) + ' Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + e.x2.toFixed(1) + ' ' + e.y2.toFixed(1);
        var dRev = 'M' + e.x2.toFixed(1) + ' ' + e.y2.toFixed(1) + ' Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + e.x1.toFixed(1) + ' ' + e.y1.toFixed(1);
        var pe = pathEls[fl.id];
        if (pe) { if (pe.fwd) pe.fwd.setAttribute('d', dFwd); if (pe.rev) pe.rev.setAttribute('d', dRev); }
        if (lblEls[fl.id]) { lblEls[fl.id].setAttribute('x', ((e.x1 + cx) / 2).toFixed(0)); lblEls[fl.id].setAttribute('y', ((e.y1 + cy) / 2 - 8).toFixed(0)); }
      });
      // Re-apply last known flow state after a rebuild so show/hide and
      // direction survive resizes and panel opens.
      if (lastStatus && lastStatus.energy) updateFlowState(lastStatus.energy);
    }, 60);
  }

  /**
   * Toggle each of the 4 main flows (solar→home, home↔bat, home→ev, home↔grid)
   * based on actual power. Both forward and reverse particle groups exist
   * in the DOM from page load (so SMIL animateMotion starts correctly under
   * Chrome); this function only swaps `visibility` on the outer flow group
   * (show/hide) and on the two inner particle/path groups (direction).
   * visibility:hidden does not tear down the SMIL timeline, so particles
   * keep their position cache even while hidden.
   */
  function updateFlowState(energy) {
    if (!energy) return;
    var batteryKw = Number(energy.batteryKw || 0);
    var gridKw = Number(energy.gridKw || 0);       // positive = import, negative = export (post grid-sign fix)
    var solarKw = Number(energy.solarKw || 0);
    var evKw = Number(energy.evKw || 0);
    var states = {
      f1: { kw: Math.max(0, solarKw),      reverse: false },
      f2: { kw: Math.abs(batteryKw),       reverse: batteryKw < 0 },  // discharging flips bat→home
      f3: { kw: Math.max(0, evKw),         reverse: false },
      f4: { kw: Math.abs(gridKw),          reverse: gridKw > 0 }      // importing flips grid→home
    };
    var THRESHOLD_KW = 0.05; // 50 W — below this we consider the link idle
    flows.forEach(function (fl) {
      var s = states[fl.id];
      if (!s) return;
      var fg = document.getElementById('fg-' + fl.id);
      if (!fg) return;
      var active = s.kw > THRESHOLD_KW;
      var label = lblEls[fl.id];
      if (label) label.textContent = active ? formatKw(s.kw) : '';
      fg.style.visibility = active ? 'visible' : 'hidden';
      if (!active) return;
      // Swap visibility between the pre-built fwd/rev path + particle pairs.
      var dir = s.reverse ? 'reverse' : 'forward';
      if (lastFlowDirection[fl.id] === dir) return;
      var pe = pathEls[fl.id];
      var pg = particleGroupEls[fl.id];
      if (pe && pe.fwd && pe.rev) {
        pe.fwd.style.visibility = s.reverse ? 'hidden' : 'visible';
        pe.rev.style.visibility = s.reverse ? 'visible' : 'hidden';
      }
      if (pg && pg.fwd && pg.rev) {
        pg.fwd.style.visibility = s.reverse ? 'hidden' : 'visible';
        pg.rev.style.visibility = s.reverse ? 'visible' : 'hidden';
      }
      lastFlowDirection[fl.id] = dir;
    });
  }
  function rebuildAll() { rebuildAllWithDevices(null); }

  /**
   * Update path `d` attributes and label positions for every flow without
   * tearing down the SVG subtree. After rewriting the paths we call
   * beginElement() on each animateMotion so the particle animation restarts
   * against the new path geometry — Chrome's SMIL implementation snapshots
   * the motion path at animation start, so a naked d mutation would leave
   * the particles moving along the old curve. This keeps flows alive across
   * viewport resizes and late layout shifts (font loading, tag content
   * width changes) without relying on addFlowToSvg's dynamic SMIL insertion
   * which stops working after the first post-load rebuild.
   */
  function repositionFlows() {
    var flowSvg = document.getElementById('flowSvg');
    if (!flowSvg) return;
    var W = window.innerWidth, H = window.innerHeight;
    flowSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var allFlows = flows.concat(lastDeviceFlows);
    // Hide flows whose endpoint tag is display:none (e.g. tag-ev when no
    // wallbox is connected). offsetParent === null is the cheap
    // display-none test; checking getBoundingClientRect.width === 0 would
    // also work. Hidden endpoint → hide the whole flow group so no stray
    // arc/particles remain from the previous layout.
    function endpointHidden(el) { return !el || el.offsetParent === null; }
    allFlows.forEach(function (fl) {
      var fe = document.getElementById(fl.from), te = document.getElementById(fl.to);
      if (!fe || !te) return;
      // If either endpoint is display:none (hidden EV tag on installs with
      // no wallbox, for example) force the whole flow group to visibility
      // hidden and skip geometry updates — getBoundingClientRect on a
      // display:none element returns zeros and would otherwise produce a
      // malformed zero-length path that Chrome renders as a stuck pixel.
      if (endpointHidden(fe) || endpointHidden(te)) {
        var fg = document.getElementById('fg-' + fl.id);
        if (fg) fg.style.visibility = 'hidden';
        lastFlowDirection[fl.id] = null; // force re-apply once endpoints are visible again
        return;
      }
      var e = edge(fe, te);
      var mx = (e.x1 + e.x2) / 2, my = (e.y1 + e.y2) / 2;
      var dx = e.x2 - e.x1, dy = e.y2 - e.y1, len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) return;
      var nx = -dy / len, ny = dx / len, bulge = len * .15;
      var cx = mx + nx * bulge, cy = my + ny * bulge;
      pathCoords[fl.id] = { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, cx: cx, cy: cy };
      var dFwd = 'M' + e.x1.toFixed(1) + ' ' + e.y1.toFixed(1) + ' Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + e.x2.toFixed(1) + ' ' + e.y2.toFixed(1);
      var dRev = 'M' + e.x2.toFixed(1) + ' ' + e.y2.toFixed(1) + ' Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + e.x1.toFixed(1) + ' ' + e.y1.toFixed(1);
      var pe = pathEls[fl.id];
      if (pe) { if (pe.fwd) pe.fwd.setAttribute('d', dFwd); if (pe.rev) pe.rev.setAttribute('d', dRev); }
      if (lblEls[fl.id]) { lblEls[fl.id].setAttribute('x', ((e.x1 + cx) / 2).toFixed(0)); lblEls[fl.id].setAttribute('y', ((e.y1 + cy) / 2 - 8).toFixed(0)); }
      // Restart SMIL animations so circles follow the new path.
      var pg = particleGroupEls[fl.id];
      if (pg) {
        [pg.fwd, pg.rev].forEach(function (group) {
          if (!group) return;
          var anims = group.querySelectorAll('animateMotion');
          for (var k = 0; k < anims.length; k++) {
            try { if (typeof anims[k].beginElement === 'function') anims[k].beginElement(); } catch (_e) { /* ignore */ }
          }
        });
      }
    });
  }

  rebuildAll();
  // Late layout passes — font loading and tag content width changes can shift
  // the home tag a few pixels after the initial rebuild. Re-measure once the
  // fonts settle and again after a short delay so the flow endpoints catch up
  // with the final positions (without tearing down particle timers).
  if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
    document.fonts.ready.then(function () { repositionFlows(); });
  }
  setTimeout(repositionFlows, 500);
  setTimeout(repositionFlows, 1500);
  window.addEventListener('resize', function () { repositionFlows(); positionTray(); renderSlots(); updateSlotValues(); });
  // @keyframes fd moved to family.css (Plan 09.1-07 Task 3 — runtime-injected
  // <style> elements are blocked by style-src-elem without 'unsafe-inline').

  function positionTray() {
    var glass = document.querySelector('.glass');
    var tray = document.getElementById('devices-tray');
    if (glass && tray) {
      var gr = glass.getBoundingClientRect();
      tray.style.bottom = (window.innerHeight - gr.top + 12) + 'px';
    }
  }
  setTimeout(positionTray, 600);
  setInterval(positionTray, 2000);

  /* ===================== CONFIGURABLE METRICS BAR (D-12) =====================
     Reworked 2026-06-13 (operator request): metrics can be PERIOD-aware
     (Heute / Monat / Jahr) — backed by payload.periods (the same history
     KPIs the Historie page shows). Slot config entries are stored as
     'metricId' (default period) or 'metricId:month' / 'metricId:year'.
     calc(stats, period): stats = { live, savings, periods:{day,month,year} }. */
  var PERIOD_LABEL = { day: 'Heute', month: 'Monat', year: 'Jahr' };
  function pk(stats, period, field) {
    var p = stats.periods && stats.periods[period || 'day'];
    var v = p ? p[field] : null;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  function fmtOr(v, digits) {
    return v == null ? '--' : (digits === 0 ? Math.round(v) : v.toFixed(digits));
  }
  var allMetrics = {
    eigenverbrauch: { id: 'eigenverbrauch', icon: '\u{1F340}', label: 'Eigenverbrauch', color: '#26de81', unit: '%', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var pv = pk(s, p, 'pvKwh'); var ex = pk(s, p, 'exportKwh');
      if (pv == null || ex == null || pv <= 0) return s.live.sr;
      return Math.max(0, Math.min(100, Math.round((pv - ex) / pv * 100)));
    } },
    autarkie: { id: 'autarkie', icon: '\u{1F3E0}', label: 'Autarkie', color: '#4b7bec', unit: '%', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var load = pk(s, p, 'loadKwh'); var imp = pk(s, p, 'importKwh');
      if (load == null || imp == null || load <= 0) return s.live.autarkie;
      return Math.max(0, Math.min(100, Math.round((load - imp) / load * 100)));
    } },
    bilanz: { id: 'bilanz', icon: '\u{1F4C8}', label: 'Bilanz', color: '#F7B731', unit: '\u20ac', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var v = pk(s, p, 'netEur');
      if (v == null && (p === 'day' || !p)) { var n = parseFloat(s.savings.todayEur); return isFinite(n) ? n.toFixed(2) : '--'; }
      return fmtOr(v, 2);
    } },
    einnahmen: { id: 'einnahmen', icon: '\u{1F4B8}', label: 'Einnahmen', color: '#fd9644', unit: '\u20ac', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'exportRevenueEur'), 2);
    } },
    kosten_vermieden: { id: 'kosten_vermieden', icon: '\u{1F6E1}\uFE0F', label: 'Kosten vermieden', color: '#26de81', unit: '\u20ac', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'avoidedImportGrossEur'), 2);
    } },
    ertrag: { id: 'ertrag', icon: '\u2600\uFE0F', label: 'PV-Ertrag', color: '#F7B731', unit: 'kWh', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'pvKwh'), 1);
    } },
    einspeisung_kwh: { id: 'einspeisung_kwh', icon: '\u{1F50C}', label: 'Eingespeist', color: '#fd9644', unit: 'kWh', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'exportKwh'), 1);
    } },
    bezug_kwh: { id: 'bezug_kwh', icon: '\u26A1', label: 'Netzbezug', color: '#ff6b6b', unit: 'kWh', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'importKwh'), 1);
    } },
    erzielt_ct: { id: 'erzielt_ct', icon: '\u{1F3AF}', label: 'Erzielt (Einspeisung)', color: '#a55eea', unit: 'ct/kWh', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'dvRevenueCtKwh'), 2);
    } },
    boerse_avg: { id: 'boerse_avg', icon: '\u{1F4B9}', label: '\u00d8 B\u00f6rsen-Verg\u00fctung', color: '#34dbff', unit: 'ct/kWh', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'periodMarketValueCtKwh'), 2);
    } },
    aw_mittel: { id: 'aw_mittel', icon: '\u2696\uFE0F', label: 'Anzulegender Wert', color: '#4b7bec', unit: 'ct/kWh', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'weightedApplicableValueCtKwh'), 2);
    } },
    jahresmarktwert: { id: 'jahresmarktwert', icon: '\u{1F4C5}', label: 'Jahresmarktwert', color: '#34dbff', unit: 'ct/kWh', periods: ['year'], calc: function (s, p) {
      return fmtOr(pk(s, 'year', 'annualMarketValueCtKwh'), 2);
    } },
    zyklen: { id: 'zyklen', icon: '\u{1F504}', label: 'Akku-Zyklen', color: '#26de81', unit: '', periods: ['day', 'month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'cycles'), 1);
    } },
    eeg51a: { id: 'eeg51a', icon: '\u00a7', label: '\u00a751a Verl\u00e4ngerung', color: '#a55eea', unit: 'Mon.', periods: ['month', 'year'], calc: function (s, p) {
      return fmtOr(pk(s, p, 'eegExtensionMonths'), 2);
    } },
    co2: { id: 'co2', icon: '\u{1F33F}', label: 'CO\u2082 vermieden', color: '#26de81', unit: 'kg', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var sc = pk(s, p, 'selfConsumptionKwh');
      return sc == null ? '--' : (sc * 0.4).toFixed(1);
    } },
    baeume: { id: 'baeume', icon: '\u{1F333}', label: 'B\u00e4ume-\u00c4quivalent', color: '#26de81', unit: '', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var sc = pk(s, p, 'selfConsumptionKwh');
      return sc == null ? '--' : (sc * 0.4 / 25).toFixed(2);
    } },
    solar_km: { id: 'solar_km', icon: '\u{1F697}', label: 'Solar-Kilometer', color: '#a55eea', unit: 'km', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var pv = pk(s, p, 'pvKwh');
      return pv == null ? '--' : Math.round(pv * 6);
    } },
    waschgaenge: { id: 'waschgaenge', icon: '\u{1F455}', label: 'Waschg\u00e4nge gratis', color: '#42a5f5', unit: '', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var pv = pk(s, p, 'pvKwh');
      return pv == null ? '--' : Math.round(pv / 1.5);
    } },
    netflix: { id: 'netflix', icon: '\u{1F4FA}', label: 'Std Netflix gratis', color: '#e84118', unit: 'h', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var pv = pk(s, p, 'pvKwh');
      return pv == null ? '--' : Math.round(pv / 0.08);
    } },
    netz_bilanz: { id: 'netz_bilanz', icon: '\u2696\uFE0F', label: 'Netz-Saldo', color: '#fd9644', unit: 'kWh', periods: ['day', 'month', 'year'], calc: function (s, p) {
      var ex = pk(s, p, 'exportKwh'); var im = pk(s, p, 'importKwh');
      if (ex == null || im == null) return '--';
      var net = ex - im;
      return (net >= 0 ? '+' : '') + net.toFixed(1);
    } }
  };

  // Legacy slot-id migration (pre-2026-06-13 catalog → period-aware ids).
  var LEGACY_METRIC_MAP = {
    gespart: 'bilanz', einspeisung_eur: 'einnahmen', monatsbilanz: 'bilanz:month',
    tagesertrag: 'ertrag', jahresertrag: 'ertrag:year', bat_zyklen: 'zyklen'
  };

  var defaultSlots = ['eigenverbrauch', 'bilanz', 'erzielt_ct', 'boerse_avg', 'einspeisung_kwh', 'ertrag'];
  var slotConfig = [];
  var editMode = false;
  var editingSlot = -1;
  var pendingMetricKey = null; // picker step 2 (period choice)

  function parseSlotEntry(entry) {
    var parts = String(entry || '').split(':');
    var id = parts[0];
    var period = parts[1] || 'day';
    if (LEGACY_METRIC_MAP[id]) {
      var mapped = LEGACY_METRIC_MAP[id].split(':');
      id = mapped[0];
      period = mapped[1] || period;
    }
    var m = allMetrics[id];
    if (m && m.periods && m.periods.indexOf(period) === -1) period = m.periods[0];
    return { id: id, period: period, metric: m };
  }

  function getSlotCount() { var w = window.innerWidth; return w > 1100 ? 6 : w > 900 ? 5 : w > 700 ? 4 : w > 500 ? 3 : 2; }

  function loadSlotConfig() {
    try { var s = localStorage.getItem(LS_SLOTS_KEY); if (s) slotConfig = JSON.parse(s); } catch (e) { /* ignore */ }
    if (!slotConfig.length) slotConfig = defaultSlots.slice();
  }

  function saveSlotConfig() {
    try { localStorage.setItem(LS_SLOTS_KEY, JSON.stringify(slotConfig)); } catch (e) { /* ignore */ }
  }

  function renderSlots() {
    var container = document.getElementById('slots');
    if (!container) return;
    var count = getSlotCount();
    var html = '';
    for (var i = 0; i < count; i++) {
      var entry = parseSlotEntry(slotConfig[i] || defaultSlots[i % defaultSlots.length]);
      if (!entry.metric) continue;
      var perSuffix = (entry.metric.periods && entry.metric.periods.length > 1)
        ? ' \u00b7 ' + PERIOD_LABEL[entry.period]
        : '';
      html += '<div class="slot" data-slot="' + i + '" data-action="slot-click">';
      html += '<div class="slot-edit">\u270E</div>';
      html += '<div class="slot-icon">' + entry.metric.icon + '</div>';
      html += '<div class="slot-val" id="sv-' + i + '">--</div>';
      html += '<div class="slot-label">' + entry.metric.label + perSuffix + '</div>';
      html += '</div>';
    }
    container.innerHTML = html;
    for (var si = 0; si < count; si++) {
      var sentry = parseSlotEntry(slotConfig[si] || defaultSlots[si % defaultSlots.length]);
      var sel = document.getElementById('sv-' + si);
      if (sel && sentry.metric) sel.style.color = sentry.metric.color;
    }
  }

  function toggleEdit() {
    editMode = !editMode;
    document.getElementById('glass').classList.toggle('editing', editMode);
    document.getElementById('editBtn').classList.toggle('active', editMode);
    if (!editMode) closePicker();
  }

  function slotClick(idx) {
    editingSlot = idx;
    openPicker(idx);
  }

  function openPicker(slotIdx) {
    var grid = document.getElementById('pickerGrid');
    var current = parseSlotEntry(slotConfig[slotIdx]);
    pendingMetricKey = null;
    var html = '';
    Object.keys(allMetrics).forEach(function (key) {
      var m = allMetrics[key];
      var sel = key === current.id ? ' selected' : '';
      html += '<div class="picker-item' + sel + '" data-action="pick-metric" data-metric-key="' + key + '">';
      html += '<div class="picker-item-icon">' + m.icon + '</div>';
      html += '<div><div class="picker-item-name">' + m.label + '</div>';
      html += '<div class="picker-item-desc">' + m.unit + '</div></div>';
      html += '</div>';
    });
    grid.innerHTML = html;
    document.getElementById('picker-title').textContent = 'Slot ' + (slotIdx + 1) + ' \u2014 Kennzahl w\u00e4hlen';
    document.getElementById('pickerOverlay').classList.add('open');
  }

  function closePicker() { document.getElementById('pickerOverlay').classList.remove('open'); editingSlot = -1; pendingMetricKey = null; }

  /* Picker step 2: period choice for period-aware metrics. */
  function openPeriodPicker(key) {
    var grid = document.getElementById('pickerGrid');
    var m = allMetrics[key];
    if (!grid || !m) return;
    pendingMetricKey = key;
    var html = '';
    m.periods.forEach(function (p) {
      html += '<div class="picker-item picker-period" data-action="pick-period" data-period-key="' + p + '">';
      html += '<div class="picker-item-icon">' + (p === 'day' ? '\u{1F4C6}' : p === 'month' ? '\u{1F4C5}' : '\u{1F5D3}\uFE0F') + '</div>';
      html += '<div><div class="picker-item-name">' + PERIOD_LABEL[p] + '</div>';
      html += '<div class="picker-item-desc">' + m.label + '</div></div>';
      html += '</div>';
    });
    grid.innerHTML = html;
    document.getElementById('picker-title').textContent = m.label + ' \u2014 Zeitraum w\u00e4hlen';
  }

  function pickMetric(key) {
    if (editingSlot < 0) return;
    var m = allMetrics[key];
    if (!m) return;
    if (m.periods && m.periods.length > 1) { openPeriodPicker(key); return; }
    slotConfig[editingSlot] = m.periods && m.periods.length === 1 && m.periods[0] !== 'day'
      ? key + ':' + m.periods[0] : key;
    saveSlotConfig(); renderSlots(); updateSlotValues(); closePicker();
  }

  function pickPeriod(period) {
    if (editingSlot < 0 || !pendingMetricKey) return;
    slotConfig[editingSlot] = period === 'day' ? pendingMetricKey : pendingMetricKey + ':' + period;
    saveSlotConfig(); renderSlots(); updateSlotValues(); closePicker();
  }

  // Stats snapshot for the bottom-bar metrics: live moment values + the
  // savings strings + the per-period history KPIs from payload.periods.
  var slotStats = { live: { sr: '--', autarkie: '--' }, savings: {}, periods: {} };

  function updateSlotValues() {
    var count = getSlotCount();
    for (var i = 0; i < count; i++) {
      var entry = parseSlotEntry(slotConfig[i] || defaultSlots[i % defaultSlots.length]);
      if (!entry.metric) continue;
      var el = document.getElementById('sv-' + i);
      if (!el) continue;
      var val = entry.metric.calc(slotStats, entry.period);
      el.textContent = val + (entry.metric.unit && val !== '--' ? ' ' + entry.metric.unit : '');
    }
  }

  loadSlotConfig();
  renderSlots();

  /* ===================== FAMILY STATUS POLLING (D-06, D-22) ===================== */
  async function pollFamilyStatus() {
    try {
      var res = await apiFetchCompat(FAMILY_STATUS_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || 'not ok');
      lastStatus = data;
      lastStatusAt = Date.now();
      failedPolls = 0;
      // Plan 08-11 Task 2: SW + offline-banner removed. DVhub is a LAN-only
      // app — when the server is unreachable the dashboard simply keeps the
      // last-known values on screen. No banner needed.
      applyFamilyStatus(data);
    } catch (err) {
      failedPolls += 1;
      // D-22 (revised 08-11) — do NOT clear lastStatus; last known values
      // remain visible. Operator can see staleness via the time widget.
      void failedPolls;
    }
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function formatKw(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    // Sub-kilowatt values render as integer watts (e.g. 842 W) so the tablet
    // doesn't flatten 0.842 kW → "0.8 kW"; from 1 kW upwards switch to two
    // decimals so 2.24 kW stays readable without eating horizontal space.
    if (Math.abs(v) < 1.0) {
      return Math.round(v * 1000) + ' W';
    }
    return v.toFixed(2) + ' kW';
  }

  function formatPct(v) {
    if (typeof v !== 'number') return '—';
    return Math.round(v) + '%';
  }

  /* Conservation-of-energy fallback for energy.homeKw.
     Sign conventions on the /api/family/status payload:
       batteryKw > 0 = charging, < 0 = discharging
       gridKw    > 0 = importing, < 0 = exporting
     Sources INTO the house bus: solar + bat_discharge + grid_import
     Other sinks pulling FROM it:  bat_charge + grid_export + ev
     The remainder must be home consumption. The Victron stack occasionally
     drops the homeKw sensor reading to 0 even while the battery is clearly
     discharging into the house — when reported and inferred disagree by
     ≥0.1 kW (100 W), trust conservation over the missing telemetry. */
  function inferHomeKw(e) {
    if (!e || typeof e !== 'object') return 0;
    var solar = Math.max(0, Number(e.solarKw   || 0));
    var bat   = Number(e.batteryKw || 0);
    var grid  = Number(e.gridKw    || 0);
    var ev    = Math.max(0, Number(e.evKw      || 0));
    var reported = Math.max(0, Number(e.homeKw || 0));
    var sources    = solar + Math.max(0, -bat) + Math.max(0,  grid);
    var otherSinks = Math.max(0,  bat) + Math.max(0, -grid) + ev;
    var inferred = Math.max(0, sources - otherSinks);
    return Math.abs(reported - inferred) < 0.1 ? reported : inferred;
  }

  function applyFamilyStatus(data) {
    var energy = data.energy || {};
    var battery = data.battery || {};
    var ev = data.ev || {};
    var price = data.price || {};
    var greeting = data.greeting || {};

    // Patch energy.homeKw via conservation when the API reports 0 / wrong value.
    // Mutating the payload's energy object here means every downstream consumer
    // (the #pfCenter House readout, friendly-text rules, autarky calc,
    // panel-stats, bgFlow) sees a consistent home-consumption number.
    energy.homeKw = inferHomeKw(energy);

    // Plan 09-04: per-card error boundary inside applyFamilyStatus. A throw in
    // one visible-card render does NOT blank a sibling card on the family
    // screensaver. Falls back to inline console logging if DVhubCommon is not
    // loaded (defensive — family.html might load before common.js in some
    // standalone preview contexts).
    var sr = (window.DVhubCommon && window.DVhubCommon.safeRender) || function (_, fn) { try { fn(); } catch (e) { console.error('[family-fallback]', _, e); } };

    sr('family.main-tags', function () {
      // 4 surrounding tag values — the House is no longer a separate Kachel
      // (Phase 11-06 round 3): Hausverbrauch is shown on the #pfCenter centre
      // readout, driven by updatePfCenterReadout() in the family.bg-flow block.
      setText('v-s', formatKw(energy.solarKw));
      setText('v-b', typeof battery.socPct === 'number' ? Math.round(battery.socPct) + '%' : '—');
      setText('v-e', formatKw(ev.powerKw));
      setText('v-g', formatKw(Math.abs(energy.gridKw || 0)));
    });

    // Generated friendly captions removed (operator request 2026-06-13) — the
    // tag labels are static HTML now ("Solar", "Batterie", "E-Auto", "Netz",
    // "Zuhause"); only DATA lines (kW, SoC, prices, times) stay dynamic.

    sr('family.battery', function () {
      if (typeof battery.powerKw === 'number') {
        setText('ts-bat', (battery.powerKw >= 0 ? '+' : '') + battery.powerKw.toFixed(1) + ' kW');
      }
      famUpdateTagAnims(energy, battery);
    });

    sr('family.ev', function () {
      var evMode = ev.mode || 'idle';
      // Part B (checkpoint round 5) — surface the Tesla state-of-charge on the
      // EV tag, Aurora-styled, driven entirely from the top-level data.tesla
      // object. The Tesla integration (TeslaMate) delivers live SoC / charge
      // limit / charging state / range; energy.ev is the idle Victron
      // placeholder, so without this the EV tag shows nothing meaningful while
      // the car charges. Degrades gracefully: when tesla.enabled is false /
      // the object is missing, the existing EV display is left unchanged.
      var tesla = data.tesla;
      var teslaLive = !!(tesla && tesla.enabled);
      var teslaCharging = teslaLive && teslaIsCharging(tesla);
      if (teslaLive) {
        var tChgKw = Number(tesla.chargerPowerKw);
        // Primary value line: charge power while charging, else the range.
        // Graceful degradation for the ASLEEP state (checkpoint round 6) —
        // when the Tesla sleeps, chargerPowerKw / rangeKm / chargingState all
        // go null but the norm/estimated range (ratedRangeKm) and batteryLevel
        // survive. Fall back to ratedRangeKm so the primary value never
        // collapses to a bare "—" while range data IS actually known.
        if (teslaCharging && tChgKw > 0) {
          setText('v-e', (Math.round(tChgKw * 10) / 10).toString().replace('.', ',') + ' kW');
        } else if (typeof tesla.rangeKm === 'number') {
          setText('v-e', Math.round(tesla.rangeKm) + ' km');
        } else if (typeof tesla.ratedRangeKm === 'number') {
          setText('v-e', Math.round(tesla.ratedRangeKm) + ' km');
        } else {
          setText('v-e', '—');
        }
        // SoC readout + charge-progress bar.
        var lvl = typeof tesla.batteryLevel === 'number' ? Math.max(0, Math.min(100, tesla.batteryLevel)) : null;
        var lim = typeof tesla.chargeLimitSoc === 'number' ? Math.max(0, Math.min(100, tesla.chargeLimitSoc)) : null;
        var socWrap = document.getElementById('ev-soc-wrap');
        if (socWrap) socWrap.hidden = lvl == null;
        if (lvl != null) {
          setText('ev-soc-pct', Math.round(lvl) + ' %');
          setText('ev-soc-limit', lim != null ? 'Limit ' + Math.round(lim) + ' %' : '');
          var fill = document.getElementById('ev-soc-fill');
          if (fill) fill.style.width = Math.round(lvl) + '%';
          var mark = document.getElementById('ev-soc-limit-mark');
          if (mark) {
            mark.hidden = lim == null;
            if (lim != null) mark.style.left = Math.round(lim) + '%';
          }
          var bar = socWrap ? socWrap.querySelector('.tag-soc-bar') : null;
          if (bar) bar.classList.toggle('is-charging', teslaCharging);
        }
        setText('ts-ev', teslaCharging ? 'Lädt gerade' : (tesla.pluggedIn === true ? 'Bereit' : 'Geparkt'));
      } else {
        setText('ts-ev', ev.finishEstIso ? 'Fertig ca. ' + formatHour(ev.finishEstIso) : '');
        var socWrapOff = document.getElementById('ev-soc-wrap');
        if (socWrapOff) socWrapOff.hidden = true;
      }
      // Hide the EV tag entirely when no wallbox reports power and no vehicle
      // SoC is known — on installs without an EV integration the empty tile
      // was sitting on top of the right edge widgets and looked broken.
      // Phase 04 will populate ev.vehicles[] when an integration is wired.
      // A live Tesla also counts as "connected" so the tag stays visible while
      // the car is plugged in / charging even though energy.ev is idle.
      var evConnected = teslaLive
        || (typeof ev.powerKw === 'number' && Math.abs(ev.powerKw) > 0.01)
        || (typeof ev.socPct === 'number' && ev.socPct !== null)
        || (Array.isArray(ev.vehicles) && ev.vehicles.length > 0);
      var evTag = document.getElementById('tag-ev');
      if (evTag) {
        var wasHidden = evTag.style.display === 'none';
        evTag.style.display = evConnected ? '' : 'none';
        // When the tag becomes visible/invisible the flow endpoints move, so
        // reposition the SVG paths without tearing down the SMIL timers.
        if (wasHidden !== !evConnected && typeof repositionFlows === 'function') {
          setTimeout(repositionFlows, 0);
        }
      }
    });

    sr('family.grid', function () {
      // Data-only status (generated copy removed): direction + the tariff-
      // adjusted import price (falls back to EPEX spot) when importing.
      var importPrice = typeof price.importCtKwh === 'number' ? price.importCtKwh
        : (typeof price.nowCtKwh === 'number' ? price.nowCtKwh : null);
      setText('ts-grid', energy.feedingToGrid
        ? 'Einspeisung'
        : (importPrice != null ? 'Bezug · ' + importPrice.toFixed(1) + ' ct/kWh' : 'Bezug'));
    });

    sr('family.greeting', function () {
      // Rule-based status copy removed (operator request 2026-06-13) — the
      // greeting strip keeps only hello + clock/date; g-msg / g-mood are gone
      // from the markup.
      if (greeting.hello) setText('g-hello', greeting.hello);
      if (greeting.time) setText('g-time', greeting.time);
      if (greeting.date) setText('g-date', greeting.date);
    });

    sr('family.live-stats', function () {
      // Bottom-bar stats (D-12, reworked 2026-06-13): period metrics come from
      // data.periods (history KPIs, same numbers as the Historie page); the
      // moment-value fallbacks (Eigenverbrauch/Autarkie before the first KPI
      // refresh) stay live-computed.
      slotStats.savings = data.savings || {};
      slotStats.periods = data.periods || {};
      slotStats.live.sr = typeof energy.solarKw === 'number' && energy.solarKw > 0
        ? Math.max(0, Math.min(100, Math.round((energy.solarKw - Math.max(0, -(energy.gridKw || 0))) / energy.solarKw * 100)))
        : '--';
      slotStats.live.autarkie = typeof energy.homeKw === 'number' && energy.homeKw > 0
        ? Math.max(0, Math.round(Math.min(100, ((energy.homeKw - Math.max(0, energy.gridKw || 0)) / energy.homeKw) * 100)))
        : '--';
      updateSlotValues();
    });

    sr('family.devices', function () {
      // Devices (Phase 03: empty array, Phase 04 fills this in)
      updateDevices(data.devices || []);
    });

    sr('family.extras', function () {
      // Generic MQTT value tiles (family.mqttTiles). The Tesla is no longer a
      // tray card (round 9) — it lives entirely on the #tag-ev constellation
      // node + the Tesla-driven EV panel (panelData.ev).
      renderFamilyExtras(data.mqttTiles || []);
    });

    sr('family.forecast-widget', function () {
      // Widgets (D-10)
      renderForecastWidget(data.forecast, data.today);
    });
    if (data.price) sr('family.price-widget', function () { renderPriceWidget(data.price); });
    if (data.optimizer) sr('family.optimizer-widget', function () { renderOptimizerWidget(data.optimizer); });
    sr('family.weather-widget', function () { renderWeatherWidget(data.weather); });

    sr('family.flow-state', function () {
      // Flow animations: hide idle links, reverse direction on discharge/import
      updateFlowState(energy);
    });

    sr('family.bg-flow', function () {
      // Aurora dust constellation between the 5 tag DOM centers, rendered into
      // <canvas id="bgFlow"> by initBgFlow() at bootstrap. This replaces the
      // legacy SVG flow (#flowSvg) which is hidden by family.css.
      updateBgFlowFromStatus(data);
      // Power-unit MQTT tiles join the constellation as their own streams
      // (D-05..D-10). MUST run after the family.extras block above has called
      // renderFamilyExtras() so the #fam-card-mqtt-<id> cards exist — a stream
      // to a not-yet-rendered card silently does not paint (bgFlowEndpoint
      // returns null). The sr() blocks run in order, so family.extras precedes
      // this family.bg-flow block.
      // houseW: the Hausverbrauch figure (data.energy.homeKw, already patched by
      // inferHomeKw in family.tags) — also the value the #pfCenter House readout
      // shows. Converted to W so it is unit-consistent with the MQTT device value.
      var houseW = Math.max(0, Number((data.energy && data.energy.homeKw) || 0)) * 1000;
      updateBgFlowMqttStreams(data.mqttTiles || [], houseW);
      // #pfCenter centre readout — the House: Hausverbrauch (kW) primary,
      // day-net-Euro balance secondary (Phase 11-06 round 3).
      updatePfCenterReadout(data);
    });

    sr('family.panel-stats', function () {
      // Also update panel stats so touch-to-open shows live data
      updatePanelStats(data);
    });
  }

  function formatHour(iso) {
    try {
      var d = new Date(iso);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (e) { return ''; }
  }

  function updatePanelStats(data) {
    var energy = data.energy || {};
    var battery = data.battery || {};
    var ev = data.ev || {};
    var forecast = data.forecast || {};
    var today = data.today || {};
    var price = data.price || {};
    var optimizer = data.optimizer || {};

    // "Heute" rows pull from data.today (real telemetry counters from
    // /api/history/summary), not forecast. Forecast kWh is used for
    // the "Morgen" row on the forecast widget/panel only.
    panelData.solar.stats = [
      { label: 'Gerade', val: formatKw(energy.solarKw), delta: energy.surplus ? 'Überschuss' : '', up: true },
      { label: 'Heute', val: typeof today.pvKwh === 'number' ? today.pvKwh.toFixed(1) + ' kWh' : '—', delta: '', up: true },
      { label: 'Eingespeist', val: typeof today.exportKwh === 'number' ? today.exportKwh.toFixed(1) + ' kWh' : '—', delta: '', up: true }
    ];
    panelData.home.stats = [
      { label: 'Gerade', val: formatKw(energy.homeKw), delta: '', up: true },
      { label: 'Heute', val: typeof today.loadKwh === 'number' ? today.loadKwh.toFixed(1) + ' kWh' : '—', delta: '', up: true },
      // Eigenverbrauchsquote: live (momentary) while PV produces; at night the
      // live ratio is undefined, so fall back to the day quota
      // (PV − Einspeisung)/PV from the real telemetry counters.
      (function () {
        if (slotStats.live.sr !== '--') return { label: 'Eigenverbrauch', val: slotStats.live.sr + '%', delta: '', up: true };
        if (typeof today.pvKwh === 'number' && today.pvKwh > 0 && typeof today.exportKwh === 'number') {
          var srDay = Math.max(0, Math.min(100, Math.round((today.pvKwh - today.exportKwh) / today.pvKwh * 100)));
          return { label: 'Eigenverbrauch', val: srDay + '%', delta: 'heute', up: true };
        }
        return { label: 'Eigenverbrauch', val: '—', delta: 'keine PV', up: true };
      })()
    ];
    panelData.bat.stats = [
      { label: 'Stand', val: formatPct(battery.socPct), delta: battery.mode || '', up: true },
      { label: 'Leistung', val: typeof battery.powerKw === 'number' ? (battery.powerKw > 0 ? '+' + formatKw(battery.powerKw) : formatKw(battery.powerKw)) : '—', delta: '', up: true },
      { label: 'Heute',
        val: typeof today.batteryChargeKwh === 'number' && typeof today.batteryDischargeKwh === 'number'
          ? '+' + today.batteryChargeKwh.toFixed(1) + ' / -' + today.batteryDischargeKwh.toFixed(1) + ' kWh'
          : (typeof battery.runtimeHours === 'number' ? '~' + battery.runtimeHours.toFixed(1) + ' h' : '—'),
        delta: '', up: true }
    ];
    // EV detail panel — Part B (checkpoint round 5): when a Tesla is live,
    // surface its SoC / charge limit / charge power / range / state from
    // data.tesla; otherwise keep the original Victron-placeholder stats.
    var teslaPanel = data.tesla;
    if (teslaPanel && teslaPanel.enabled) {
      var tChg = teslaIsCharging(teslaPanel);
      var tKw = Number(teslaPanel.chargerPowerKw);
      var tLvl = typeof teslaPanel.batteryLevel === 'number' ? Math.round(teslaPanel.batteryLevel) : null;
      var tLim = typeof teslaPanel.chargeLimitSoc === 'number' ? Math.round(teslaPanel.chargeLimitSoc) : null;
      // Asleep-state graceful degradation (checkpoint round 6): rangeKm goes
      // null while the car sleeps — fall back to ratedRangeKm (norm range),
      // which survives sleep, so the panel never shows a bare "—".
      var tRangeKm = typeof teslaPanel.rangeKm === 'number' ? teslaPanel.rangeKm
        : (typeof teslaPanel.ratedRangeKm === 'number' ? teslaPanel.ratedRangeKm : null);
      panelData.ev.stats = [
        { label: 'Ladezustand', val: tLvl != null ? tLvl + ' %' : '—', delta: tLim != null ? 'Limit ' + tLim + ' %' : '', up: true },
        { label: 'Ladeleistung', val: (tChg && tKw > 0) ? (Math.round(tKw * 10) / 10) + ' kW' : '0 kW', delta: tChg ? 'lädt' : '', up: true },
        { label: 'Reichweite', val: tRangeKm != null ? Math.round(tRangeKm) + ' km' : '—', delta: '', up: true }
      ];
      panelData.ev.details = [
        ['Status', tChg ? 'Lädt' : (teslaPanel.pluggedIn === true ? 'Eingesteckt' : 'Geparkt')],
        ['Ladelimit', tLim != null ? tLim + ' %' : '—'],
        ['Standort', escapeMsg(teslaPanel.geofence || '—')]
      ];
      panelData.ev.sub = 'Tesla · Ladezustand';
    } else {
      panelData.ev.stats = [
        { label: 'Leistung', val: formatKw(ev.powerKw), delta: ev.mode || '', up: true },
        { label: 'Akku', val: formatPct(ev.socPct), delta: '', up: true },
        { label: 'Modus', val: ev.mode || '—', delta: '', up: true }
      ];
    }
    panelData.grid.stats = [
      { label: 'Gerade', val: formatKw(Math.abs(energy.gridKw || 0)) + (energy.feedingToGrid ? ' ein' : ' bez'), delta: '', up: energy.feedingToGrid },
      { label: 'Bezug jetzt', val: typeof price.importCtKwh === 'number' ? price.importCtKwh.toFixed(1) + ' ct' : '—', delta: typeof price.nowCtKwh === 'number' ? 'EPEX ' + price.nowCtKwh.toFixed(1) + ' ct' : '', up: true },
      { label: 'EPEX min/max heute', val: (typeof price.todayMinCtKwh === 'number' ? price.todayMinCtKwh.toFixed(1) : '—') + ' / ' + (typeof price.todayMaxCtKwh === 'number' ? price.todayMaxCtKwh.toFixed(1) : '—') + ' ct', delta: '', up: true }
    ];
    // Forecast panel: "Heute" pulls the real counter from today.pvKwh
    // because the forecast service frequently has no slots (no Solcast key
    // configured on small installs). "Morgen" and "Peak morgen" still
    // require actual forecast output and fall back to "—" when the
    // forecast service is empty. Peak heute is derived from the 24-bucket
    // today.charts.solar so we can at least show a real number now.
    var tomorrowKwh = forecast.pv && forecast.pv.tomorrow && typeof forecast.pv.tomorrow.kwhTotal === 'number' && forecast.pv.tomorrow.kwhTotal > 0
      ? forecast.pv.tomorrow.kwhTotal.toFixed(1) + ' kWh' : '—';
    var tomorrowPeak = forecast.pv && forecast.pv.tomorrow && typeof forecast.pv.tomorrow.peakKw === 'number' && forecast.pv.tomorrow.peakKw > 0
      ? forecast.pv.tomorrow.peakKw.toFixed(2) + ' kW' : '—';
    var peakHeuteKw = null;
    if (today.charts && Array.isArray(today.charts.solar)) {
      peakHeuteKw = today.charts.solar.reduce(function (m, v) { return typeof v === 'number' && v > m ? v : m; }, 0);
    }
    panelData.forecast.stats = [
      { label: 'Heute', val: typeof today.pvKwh === 'number' ? today.pvKwh.toFixed(1) + ' kWh' : '—', delta: '', up: true },
      { label: 'Peak heute', val: peakHeuteKw != null && peakHeuteKw > 0 ? peakHeuteKw.toFixed(2) + ' kW' : '—', delta: '', up: true },
      { label: 'Morgen', val: tomorrowKwh, delta: tomorrowPeak !== '—' ? 'Peak ' + tomorrowPeak : 'keine Prognose', up: true }
    ];
    panelData.price.stats = [
      { label: 'Jetzt', val: typeof price.nowCtKwh === 'number' ? price.nowCtKwh.toFixed(1) + ' ct' : '—', delta: '', up: true },
      { label: 'Min heute', val: typeof price.todayMinCtKwh === 'number' ? price.todayMinCtKwh.toFixed(1) + ' ct' : '—', delta: '', up: true },
      { label: 'Max heute', val: typeof price.todayMaxCtKwh === 'number' ? price.todayMaxCtKwh.toFixed(1) + ' ct' : '—', delta: '', up: true }
    ];
    // Panel "Verlauf heute" charts — 24 hourly values per panel from
    // data.today.charts (96 for price, native 15-min EPEX resolution).
    // Only assign if the array is present and non-empty so the panel chart
    // section stays hidden when telemetry is disabled.
    var tc = today.charts || {};
    function hasChartData(arr) { return Array.isArray(arr) && arr.length > 0; }
    panelData.solar.chart = hasChartData(tc.solar) ? tc.solar : null;
    panelData.home.chart = hasChartData(tc.home) ? tc.home : null;
    panelData.bat.chart = hasChartData(tc.bat) ? tc.bat : null;
    panelData.grid.chart = hasChartData(tc.grid) ? tc.grid : null;
    panelData.price.chart = hasChartData(tc.price) ? tc.price : null;
    // Forecast panel: reuse today.charts.solar as the PV curve. When a real
    // forecast service is configured Phase 04 will replace this with next48h.
    panelData.forecast.chart = hasChartData(tc.solar) ? tc.solar : null;
    var planSlots = optimizer.planSlots || [];
    var activeSlots = planSlots.filter(function (s) { return s.enabled !== false; });
    var nowMs = Date.now();
    var curSlot = null, nextSlot = null;
    for (var psi = 0; psi < activeSlots.length; psi++) {
      if (activeSlots[psi].startTs <= nowMs && nowMs < activeSlots[psi].endTs) curSlot = activeSlots[psi];
      else if (activeSlots[psi].startTs > nowMs && !nextSlot) nextSlot = activeSlots[psi];
    }
    panelData.optimizer.stats = [
      { label: 'Jetzt', val: curSlot ? famOptimizerSlotLabel(curSlot) : (nextSlot ? 'Wartet' : (optimizer.currentActionLabel || '—')), delta: '', up: true },
      { label: 'Als nächstes', val: nextSlot ? famOptimizerHHMM(nextSlot.startTs) + ' ' + famOptimizerSlotLabel(nextSlot) : (optimizer.nextActionLabel || '—'), delta: '', up: true },
      { label: 'Status', val: optimizer.enabled ? 'Aktiv' : 'Aus', delta: optimizer.source ? ('Quelle: ' + optimizer.source) : '', up: !!optimizer.enabled }
    ];
    // Fahrplan list in the detail panel — one row per upcoming EOS slot.
    panelData.optimizer.details = planSlots.length
      ? planSlots.map(function (s) {
          return [
            famOptimizerHHMM(s.startTs) + '–' + famOptimizerHHMM(s.endTs),
            famOptimizerSlotLabel(s) + (s.enabled === false ? ' (deaktiviert)' : '')
          ];
        })
      : [['Fahrplan', 'Keine geplanten Slots']];
  }

  /* ===================== OFFLINE BANNER (D-22) — REMOVED 08-11 =====================
     Service Worker + offline banner deleted; DVhub is a LAN-only app, so
     "offline" means the server is unreachable and the right action is to
     show the last-known values stale rather than overlay a warning banner. */

  /* ===================== WIDGET RENDERERS (D-10) ===================== */
  var forecastChart = null;

  function renderForecastWidget(forecast, today) {
    var canvas = document.getElementById('forecast-chart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    var labels, values, titleText;
    var next48h = forecast && forecast.pv && Array.isArray(forecast.pv.next48h) ? forecast.pv.next48h : [];
    if (next48h.length > 0) {
      // Real forecast service output (Solcast / pvlib). Prefer this when
      // available because it spans "morgen".
      labels = next48h.map(function (s) { var d = new Date(s.ts); return String(d.getHours()).padStart(2, '0') + ':00'; });
      values = next48h.map(function (s) { return typeof s.kw === 'number' ? s.kw : 0; });
      titleText = 'PV Morgen';
    } else if (today && today.charts && Array.isArray(today.charts.solar) && today.charts.solar.length === 24) {
      // Fallback for installs where /api/forecast is empty (no Solcast key,
      // pvlib disabled): show today's actual PV production from history so
      // the card isn't blank.
      labels = today.charts.solar.map(function (_, i) { return String(i).padStart(2, '0') + ':00'; });
      values = today.charts.solar.slice();
      titleText = 'PV heute';
    } else {
      return;
    }
    var titleEl = document.querySelector('.widget-forecast .widget-title');
    if (titleEl && titleEl.textContent !== titleText) titleEl.textContent = titleText;
    // Pitfall 1 — reuse instance to avoid memory leak
    if (forecastChart) {
      forecastChart.data.labels = labels;
      forecastChart.data.datasets[0].data = values;
      forecastChart.update('none');
    } else {
      forecastChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: labels, datasets: [{ data: values, borderColor: '#F7B731', backgroundColor: 'rgba(247,183,49,0.12)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(14,16,24,.9)', titleColor: '#fff', bodyColor: '#ccc',
              borderColor: 'rgba(255,255,255,.1)', borderWidth: 1, cornerRadius: 8, padding: 8,
              callbacks: { label: function (c) { return c.parsed.y.toFixed(2) + ' kW'; } }
            }
          },
          scales: { x: { ticks: { color: 'rgba(255,255,255,0.3)', maxTicksLimit: 8 } }, y: { ticks: { color: 'rgba(255,255,255,0.3)' }, beginAtZero: true } }
        }
      });
    }
  }

  function renderPriceWidget(price) {
    var el = document.getElementById('price-now');
    if (el) el.textContent = (typeof price.nowCtKwh === 'number' ? price.nowCtKwh.toFixed(1) : '—') + ' ct';
    var elMin = document.getElementById('price-min');
    if (elMin) elMin.textContent = typeof price.todayMinCtKwh === 'number' ? price.todayMinCtKwh.toFixed(1) : '—';
    var elMax = document.getElementById('price-max');
    if (elMax) elMax.textContent = typeof price.todayMaxCtKwh === 'number' ? price.todayMaxCtKwh.toFixed(1) : '—';
  }

  /* Weather widget (2026-06-13) — WMO weather_code → emoji symbol. */
  function famWeatherSymbol(code, cloudPct) {
    if (code == null) {
      if (cloudPct == null) return '🌡️';
      return cloudPct < 25 ? '☀️' : cloudPct < 70 ? '🌤️' : '☁️';
    }
    if (code === 0) return '☀️';
    if (code <= 2) return '🌤️';
    if (code === 3) return '☁️';
    if (code === 45 || code === 48) return '🌫️';
    if (code >= 51 && code <= 57) return '🌦️';
    if (code >= 61 && code <= 67) return '🌧️';
    if (code >= 71 && code <= 77) return '🌨️';
    if (code >= 80 && code <= 82) return '🌦️';
    if (code >= 85 && code <= 86) return '🌨️';
    if (code >= 95) return '⛈️';
    return '🌡️';
  }

  function renderWeatherWidget(weather) {
    var box = document.getElementById('widgetWeather');
    if (!box) return;
    if (!weather || weather.tempC == null) { box.hidden = true; return; }
    box.hidden = false;
    setText('weather-now', famWeatherSymbol(weather.code, weather.cloudPct) + ' ' + Math.round(weather.tempC) + '°');
    var subParts = [];
    if (weather.maxC != null && weather.minC != null) {
      subParts.push('↑' + Math.round(weather.maxC) + '° ↓' + Math.round(weather.minC) + '°');
    }
    if (weather.precipPct != null) subParts.push('Regen ' + Math.round(weather.precipPct) + '%');
    setText('weather-sub', subParts.join(' · ') || '—');
    // Detail panel: stats + the next hours as rows.
    panelData.weather.stats = [
      { label: 'Jetzt', val: Math.round(weather.tempC) + ' °C', delta: weather.windMs != null ? 'Wind ' + Math.round(weather.windMs * 3.6) + ' km/h' : '', up: true },
      { label: 'Heute', val: (weather.maxC != null ? '↑' + Math.round(weather.maxC) + '°' : '—') + (weather.minC != null ? ' ↓' + Math.round(weather.minC) + '°' : ''), delta: '', up: true },
      { label: 'Regen', val: weather.precipPct != null ? Math.round(weather.precipPct) + ' %' : '—', delta: weather.humidityPct != null ? 'Luftfeuchte ' + Math.round(weather.humidityPct) + '%' : '', up: true }
    ];
    panelData.weather.details = (weather.hours || []).map(function (h) {
      var t = new Date(h.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      var parts = [];
      if (h.tempC != null) parts.push(Math.round(h.tempC) + ' °C');
      if (h.precipPct != null && h.precipPct > 0) parts.push(h.precipPct + '% Regen');
      return [t, famWeatherSymbol(h.code, h.cloudPct) + ' ' + parts.join(' · ')];
    });
  }

  /* DV-EOS plan slot → human label (operator request 2026-06-13: the widget
     shows the live EOS Fahrplan — the forecast_optimizer schedule slots). */
  function famOptimizerSlotLabel(s) {
    if (!s) return '—';
    if (s.target === 'gridSetpointW' && typeof s.gridW === 'number') {
      if (s.gridW < 0) return 'Einspeisen ' + formatKw(Math.abs(s.gridW) / 1000);
      if (s.gridW > 0) return 'Netzladen ' + formatKw(s.gridW / 1000);
      return 'Halten (0 W)';
    }
    if (s.target === 'feedExcessDcPv') return '100% Einspeisung';
    if (s.target === 'chargeCurrentA' && typeof s.value === 'number') return 'Laden ' + s.value + ' A';
    if (s.target === 'minSocPct' && typeof s.value === 'number') return 'Min-SOC ' + s.value + ' %';
    return s.target || '—';
  }

  function famOptimizerHHMM(ts) {
    return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function renderOptimizerWidget(optimizer) {
    var el = document.getElementById('optimizer-action');
    var next = document.getElementById('optimizer-next');
    var slots = (optimizer.planSlots || []).filter(function (s) { return s.enabled !== false; });
    var nowTs = Date.now();
    var current = null, upcoming = null;
    for (var i = 0; i < slots.length; i++) {
      if (slots[i].startTs <= nowTs && nowTs < slots[i].endTs) { current = slots[i]; }
      else if (slots[i].startTs > nowTs && !upcoming) { upcoming = slots[i]; }
    }
    if (current || upcoming) {
      if (el) el.textContent = current ? famOptimizerSlotLabel(current) : 'Wartet';
      if (next) {
        next.textContent = upcoming
          ? famOptimizerHHMM(upcoming.startTs) + ' · ' + famOptimizerSlotLabel(upcoming)
          : (current ? 'bis ' + famOptimizerHHMM(current.endTs) : '—');
      }
      return;
    }
    if (el) el.textContent = optimizer.currentActionLabel || optimizer.currentAction || (optimizer.enabled ? 'Kein Fahrplan' : '—');
    if (next) next.textContent = optimizer.nextActionLabel || (optimizer.enabled ? '' : 'Optimizer aus');
  }

  /* ===================== VISIBILITY HANDLER (Pitfall 2) ===================== */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      // Reposition paths (layout may have shifted while the tab was hidden)
      // but keep the SMIL timers — rebuilding here would break Chrome's
      // dynamically-inserted animateMotion just like resize used to.
      repositionFlows();
      pollFamilyStatus();
      // Visibility returning is an activity event — re-arm the screensaver timer
      resetInactivity();
    }
  });

  /* =======================================================================
     SCREENSAVER STATE MACHINE (DASH-03, D-16 in-dashboard dimming,
     D-17 time-window configurable timeout, D-19 presence-hook wake,
     D-23 no service worker — in-memory state only)
     ======================================================================= */
  var screensaverOn = false;
  var inactivityTimer = null;
  var lastActivityAt = Date.now();
  var presencePollTimer = null;

  function currentHHMM() {
    var d = new Date();
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  function computeTimeout() {
    // Fallback: if the deferred module script hasn't loaded yet, use the safe default.
    // Subsequent activity/poll ticks will pick up the real helper once it's on window.
    var logic = window.FamilyScreensaverLogic;
    var cfg = (lastStatus && lastStatus.config && lastStatus.config.screensaver) || null;
    if (!logic) return (cfg && cfg.enabled === false) ? 0 : (cfg && cfg.defaultTimeoutSec) || 120;
    return logic.getActiveTimeout(cfg || { defaultTimeoutSec: 120, windows: [], enabled: true }, currentHHMM());
  }

  function enterScreensaver() {
    if (screensaverOn) return;
    screensaverOn = true;
    document.body.classList.add('screensaver');
  }

  function exitScreensaver() {
    if (!screensaverOn) return;
    screensaverOn = false;
    document.body.classList.remove('screensaver');
  }

  function resetInactivity() {
    lastActivityAt = Date.now();
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    if (screensaverOn) exitScreensaver();
    var timeoutSec = computeTimeout();
    if (timeoutSec > 0) {
      inactivityTimer = setTimeout(enterScreensaver, timeoutSec * 1000);
    }
  }

  // Any user activity resets the inactivity timer (D-16, D-17)
  ['touchstart', 'pointerdown', 'keydown', 'mousemove'].forEach(function (ev) {
    window.addEventListener(ev, resetInactivity, { passive: true });
  });

  // Presence polling for wake-on-presence (D-19)
  async function pollPresence() {
    try {
      var res = await apiFetchCompat(FAMILY_PRESENCE_URL);
      if (!res || !res.ok) return;
      var data = await res.json();
      if (data && data.detected && screensaverOn) {
        exitScreensaver();
        resetInactivity();
      }
    } catch (err) { /* silent — presence is best-effort */ }
  }

  function startPresencePolling() {
    if (presencePollTimer) return;
    var interval = (lastStatus && lastStatus.config && lastStatus.config.presence && lastStatus.config.presence.pollIntervalMs) || 2000;
    presencePollTimer = setInterval(pollPresence, interval);
  }

  // Bootstrap screensaver AFTER the deferred module script has set window.FamilyScreensaverLogic.
  // DOMContentLoaded fires after module scripts execute — safe to initialise here.
  function bootstrapScreensaver() {
    resetInactivity();
    startPresencePolling();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapScreensaver);
  } else {
    bootstrapScreensaver();
  }

  /* escapeMsg stays (the LLM message widget it came with was removed
     2026-06-13) — it is the shared HTML-escaper for device cards, MQTT tiles
     and panel content built via innerHTML. */
  function escapeMsg(text) {
    var common = window.DVhubCommon;
    if (common && typeof common.escapeHtml === 'function') return common.escapeHtml(text);
    return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ===================== AURORA BG-FLOW DUST CONSTELLATION (Plan 09.1-02) ====
     Dust particles flow between the source/sink tag DOM centers (tag-solar,
     tag-bat, tag-ev, tag-grid) and the central #pfCenter hub, painted into
     <canvas id="bgFlow"> as a fullscreen background layer. Phase 11-06 round 3:
     the House is no longer a separate tag — #pfCenter IS the House, the centre
     of the constellation. This is the Aurora replacement for the legacy SVG
     flowSvg/flowGroup rendering, which is kept in the DOM (binding-contract
     compatibility) but visually suppressed via #flowSvg{opacity:0} in family.css.

     Ported from .planning/DESIGN-2026-05-10-aurora/family.html inline <script>
     block (~lines 384-509). The Aurora source's fetch-sniffer pattern is
     replaced here by an explicit updateBgFlowFromStatus(data) call wired into
     applyStatus().
     ======================================================================== */
  /* Hub-and-spoke wiring: all flows route through a hub at the visual centre of
     the viewport (#pfCenter — which Phase 11-06 round 3 repurposed as the House
     readout). This mirrors the dvhub-powerflow widget topology — sources
     (PV/Bat/Grid) feed INTO the hub; sinks (Bat/EV/Grid) draw FROM the hub. The
     House sink (k_home) was removed because the hub now IS the House. Battery
     and Grid have one "source" stream and one "sink" stream each — only one is
     active at any moment (positive batteryKw = charging = sink; negative =
     discharging = source. Positive gridKw = importing = source; negative =
     exporting = sink). The visual effect: bat→home is rendered as two segments
     (bat→hub, then hub→home) so the dust visibly passes through the Bilanz. */
  /* Per-source nameplate maximums for flow intensity scaling — count and speed
     of dust on each stream is computed from kW / maxKw (ratio 0..1), not raw
     kW. This way a 1 kW grid feed-in produces visibly different intensity than
     a 20 kW solar peak even though both are "moderate" in absolute terms.
     EV defaults to 22 kW (typical 3-phase wallbox); user-spec did not list EV. */
  /* Phase 11-06 round 3: the k_home stream (hub → tag-home) was removed — the
     House IS the hub (#pfCenter) now, so a pfCenter→pfCenter stream would be
     meaningless. Source streams still feed the centre; the proportional MQTT
     device streams flow OUT of the centre to the device tiles. */
  var BG_FLOWS_BASE = [
    // Source streams (feed INTO the crossing at pfCenter)
    { from: 'tag-solar', to: 'pfCenter', color: [255,212,33],  id: 's_pv',   maxKw: 27 },
    { from: 'tag-bat',   to: 'pfCenter', color: [70,211,68],   id: 's_bat',  maxKw: 24 },
    { from: 'tag-grid',  to: 'pfCenter', color: [255,122,198], id: 's_grid', maxKw: 30 },
    // Sink streams (drawn FROM the crossing at pfCenter)
    { from: 'pfCenter',  to: 'tag-bat',  color: [70,211,68],   id: 'k_bat',  maxKw: 24 },
    { from: 'pfCenter',  to: 'tag-ev',   color: [165,94,234],  id: 'k_ev',   maxKw: 22 },
    { from: 'pfCenter',  to: 'tag-grid', color: [255,122,198], id: 'k_grid', maxKw: 30 },
    // Powerflow-2.0 rework (2026-06-13): the House is an endpoint again — the
    // centre is a CROSSING, the house-consumption flow runs crossing → house.
    // APPENDED so updateBgFlowFromStatus's fixed [0..5] indices stay valid.
    { from: 'pfCenter',  to: 'tag-home', color: [52,219,255],  id: 'k_home', maxKw: 30 }
  ];

  /* Source colours for the provenance mix (operator request 2026-06-13):
     particles on SINK streams (house, EV, battery-charge, grid-export and the
     s_mqtt_* device streams) are coloured by where the energy COMES FROM —
     green battery particles arrive green at the consumers. The mix is the
     live source share at the crossing (mockup compute(): fPV/fBat/fGrid). */
  var SRC_PV_COL   = [255, 212, 33];
  var SRC_BAT_COL  = [70, 211, 68];
  var SRC_GRID_COL = [255, 122, 198];
  // Cumulative-bucket mix shared with the s_mqtt_* device streams — rebuilt on
  // every status poll by updateBgFlowFromStatus().
  var bgFlowSourceMix = null;

  function bgFlowBuildMix(parts) {
    var tot = 0;
    for (var i = 0; i < parts.length; i++) tot += Math.max(0, parts[i][1]);
    if (tot <= 0) return null;
    var cum = 0;
    var mix = [];
    for (var j = 0; j < parts.length; j++) {
      var share = Math.max(0, parts[j][1]) / tot;
      if (share <= 0.001) continue; // sub-0.1% slivers add noise, not insight
      cum += share;
      mix.push({ c: parts[j][0], cum: cum });
    }
    if (mix.length) mix[mix.length - 1].cum = 1; // close rounding gap
    return mix.length ? mix : null;
  }
  /* Per-stream dust-speed multiplier for BG_FLOWS_BASE — applied on top of the
     bgFlowPwr2Speed() result. Default (any id not listed) is 1. k_grid is the
     hub → grid export stream (PV/solar power flowing toward the grid /
     Einspeisung); the operator reported it visualised far too slowly, so its
     dust runs 20% faster. No other base stream is affected. */
  var BG_FLOWS_SPEED_FACTOR = { k_grid: 1.2 };
  /* Min-visibility floor for the BG_FLOWS_BASE streams (grid/battery/solar/EV)
     ONLY. The base streams scale linearly against a large nameplate (maxKw — the
     grid is 30), so a real but small flow (e.g. the grid at 0.05 kW / 50 W of
     export) computes a near-zero dust count/speed and renders as nothing. When a
     base stream carries power above the bgFlowDraw() draw threshold (s.kw >= 0.05
     — i.e. it WILL be drawn), its count and speed are raised to at least these
     minima so the flow is a thin but clearly-visible trickle. Calibrated against
     DUST_PER_STREAM (400) and the busy maxima (~320 count, ~0.2 speed): 40 dust
     ≈ 10% density is a sparse, clearly-visible scatter; speed 0.03 is plainly
     moving. A genuinely idle stream (s.kw < 0.05) is skipped by bgFlowDraw() and
     gets NO floor. The s_mqtt_* device streams are deliberately NOT floored —
     they stay strictly proportional. */
  var BG_FLOW_MIN_COUNT = 40;
  var BG_FLOW_MIN_SPEED = 0.03;
  var bgFlowDust = [];
  var bgFlowCanvas = null;
  var bgFlowCtx = null;
  var BG_FLOW_W = 0;
  var BG_FLOW_H = 0;
  var BG_FLOW_DPR = Math.min(2, window.devicePixelRatio || 1);
  var DUST_PER_STREAM = 400;

  function bgFlowSize() {
    if (!bgFlowCanvas) return;
    BG_FLOW_DPR = Math.min(2, window.devicePixelRatio || 1);
    BG_FLOW_W = bgFlowCanvas.width  = Math.max(1, window.innerWidth  * BG_FLOW_DPR);
    BG_FLOW_H = bgFlowCanvas.height = Math.max(1, window.innerHeight * BG_FLOW_DPR);
    bgFlowCanvas.style.width  = window.innerWidth  + 'px';
    bgFlowCanvas.style.height = window.innerHeight + 'px';
  }

  function bgFlowSeedDust(s) {
    s.count = 0; s.speed = 0; s.reverse = false; s.kw = 0;
    for (var i = 0; i < DUST_PER_STREAM; i++) {
      bgFlowDust.push({
        s: s, p: Math.random(), life: Math.random(),
        phase: Math.random() * 6.28, sz: Math.random() * 1.4 + 0.4,
        jit: (Math.random() - 0.5) * 0.05
      });
    }
  }

  function bgFlowEndpoint(id) {
    var el = document.getElementById(id);
    if (!el || el.offsetParent === null) return null;
    var r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2) * BG_FLOW_DPR, y: (r.top + r.height / 2) * BG_FLOW_DPR };
  }

  function bgFlowDraw() {
    if (!bgFlowCtx) return;
    bgFlowCtx.fillStyle = 'rgba(3,6,16,.32)';
    bgFlowCtx.fillRect(0, 0, BG_FLOW_W, BG_FLOW_H);
    bgFlowCtx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < bgFlowDust.length; i++) {
      var d = bgFlowDust[i], s = d.s;
      if (!s || s.kw < (s.minKw != null ? s.minKw : 0.05)) continue;
      var rank = (d.phase * 1000) % 1;
      if (rank > Math.min(s.count / DUST_PER_STREAM, 1)) continue;
      var a = bgFlowEndpoint(s.from), b = bgFlowEndpoint(s.to);
      if (!a || !b) continue;
      if (s.reverse) { var tmp = a; a = b; b = tmp; }
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      var nx = -dy / len, ny = dx / len;
      var jit = Math.sin(d.p * Math.PI * 8 + d.life * 10) * d.jit * len;
      var x = a.x + dx * d.p + nx * jit, y = a.y + dy * d.p + ny * jit;
      var env = Math.sin(d.p * Math.PI);
      var aa = env * 0.85;
      var sz = d.sz * BG_FLOW_DPR * (0.6 + env * 0.6);
      // Provenance mix (2026-06-13): when the stream carries a source-share
      // mix, each particle picks its colour from a cumulative bucket keyed by
      // its OWN phase — deterministic per particle (no per-frame flicker), and
      // the population splits in the live source proportions: 60 % PV / 40 %
      // battery renders as 60 % yellow / 40 % green dust arriving at the sink.
      var c = s.color;
      if (s.mix && s.mix.length) {
        var pick = (d.phase * 0.954929658) % 1; // phase 0..2π → 0..~6 → frac
        for (var mi = 0; mi < s.mix.length; mi++) {
          c = s.mix[mi].c;
          if (pick <= s.mix[mi].cum) break;
        }
      }
      bgFlowCtx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + aa + ')';
      bgFlowCtx.beginPath(); bgFlowCtx.arc(x, y, sz, 0, Math.PI * 2); bgFlowCtx.fill();
      bgFlowCtx.fillStyle = 'rgba(255,255,255,' + (aa * 0.55) + ')';
      bgFlowCtx.beginPath(); bgFlowCtx.arc(x, y, sz * 0.35, 0, Math.PI * 2); bgFlowCtx.fill();
      d.p += s.speed * 0.018;
      if (d.p > 1) { d.p = 0; d.life = Math.random(); }
    }
    bgFlowCtx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(bgFlowDraw);
  }

  /* Convert raw kW + stream nameplate max into an "effective kW" in 0..14.5 so
     the existing dust-density and speed curves keep their visual feel: 100% of
     maxKw maps to ~320 dust + speed 0.195 (which used to require ~14.5 kW
     absolute). Below 5% of capacity the stream is treated as idle to avoid
     visible single-particle noise. */
  function bgFlowEffectiveKw(kW, maxKw) {
    if (!maxKw || maxKw <= 0) return 0;
    var ratio = Math.max(0, Math.min(1, kW / maxKw));
    return ratio * 14.5;
  }
  function bgFlowPwr2Speed(kW) { return 0.005 + 0.05 * Math.sqrt(Math.max(kW, 0)); }
  function bgFlowPwr2Count(kW) { return Math.min(Math.round(kW * 22), 320); }

  function initBgFlow() {
    bgFlowCanvas = document.getElementById('bgFlow');
    if (!bgFlowCanvas) return;
    bgFlowCtx = bgFlowCanvas.getContext('2d');
    bgFlowSize();
    window.addEventListener('resize', bgFlowSize);
    BG_FLOWS_BASE.forEach(bgFlowSeedDust);
    bgFlowDraw();
  }

  /* Drive BG_FLOWS_BASE from a /api/family/status payload (called from applyStatus).
     Sign conventions (matches /api/family/status):
       batteryKw > 0  → charging (hub → bat, k_bat active)
       batteryKw < 0  → discharging (bat → hub, s_bat active)
       gridKw    > 0  → importing (grid → hub, s_grid active)
       gridKw    < 0  → exporting (hub → grid, k_grid active)
     Each opposing pair is mutually exclusive — the inactive stream has kw=0
     and is skipped by bgFlowDraw's `s.kw < 0.05` threshold. */
  function updateBgFlowFromStatus(data) {
    if (!data || !data.energy) return;
    var e = data.energy;
    var solar = Math.max(0, Number(e.solarKw   || 0));
    var bat   = Number(e.batteryKw || 0);
    var grid  = Number(e.gridKw    || 0);
    var ev    = Math.max(0, Number(e.evKw      || 0));

    // Part A (checkpoint round 5): when the Tesla is charging at home its live
    // charge power drives the k_ev constellation stream so the charging flow is
    // visible. energy.evKw is wired to the Victron evPowerW placeholder (idle on
    // this install) — the real charge power lives in the top-level data.tesla
    // object. This is a VISUAL-only override of the k_ev stream magnitude: it
    // does NOT touch energy.evKw nor the server-side energy-balance/surplus math
    // (the wallbox draw is already inside homeKw — re-adding it would
    // double-count). Tesla-when-charging wins; otherwise fall back to evKw.
    var t = data.tesla;
    if (t && teslaIsCharging(t) && Number(t.chargerPowerKw) > 0) {
      ev = Math.max(ev, Number(t.chargerPowerKw));
    }

    // Sources → crossing
    BG_FLOWS_BASE[0].kw = solar;                      // s_pv:   pv  → crossing
    BG_FLOWS_BASE[1].kw = bat  < 0 ? -bat  : 0;       // s_bat:  bat → crossing (discharging)
    BG_FLOWS_BASE[2].kw = grid > 0 ?  grid : 0;       // s_grid: grid→ crossing (importing)
    // Crossing → sinks
    BG_FLOWS_BASE[3].kw = bat  > 0 ?  bat  : 0;       // k_bat:  crossing → bat (charging)
    BG_FLOWS_BASE[4].kw = ev;                         // k_ev:   crossing → ev (Tesla charge power when charging)
    BG_FLOWS_BASE[5].kw = grid < 0 ? -grid : 0;       // k_grid: crossing → grid (exporting)
    BG_FLOWS_BASE[6].kw = Math.max(0, Number(e.homeKw || 0)); // k_home: crossing → house

    // Provenance colour mix (operator request 2026-06-13): sink-stream
    // particles carry the colours of the energy's ORIGIN, in the live share.
    // Consumers (house/EV/devices) draw from PV + discharging battery +
    // grid import; battery CHARGE comes from PV/grid only (a battery does not
    // charge itself); grid EXPORT comes from PV/battery only.
    var batOutKw = bat < 0 ? -bat : 0;
    var gridImpKw = grid > 0 ? grid : 0;
    bgFlowSourceMix = bgFlowBuildMix([
      [SRC_PV_COL, solar], [SRC_BAT_COL, batOutKw], [SRC_GRID_COL, gridImpKw]
    ]);
    BG_FLOWS_BASE[3].mix = bgFlowBuildMix([[SRC_PV_COL, solar], [SRC_GRID_COL, gridImpKw]]); // k_bat
    BG_FLOWS_BASE[4].mix = bgFlowSourceMix;                                                  // k_ev
    BG_FLOWS_BASE[5].mix = bgFlowBuildMix([[SRC_PV_COL, solar], [SRC_BAT_COL, batOutKw]]);   // k_grid
    BG_FLOWS_BASE[6].mix = bgFlowSourceMix;                                                  // k_home

    // Task #20 (operator request 2026-06-13): the house tile no longer prints
    // a textual source breakdown ("PV x% / Akku y% / Netz z%") — at night it
    // read "Akku 100%" and looked like a battery gauge on the house, redundant
    // with the battery tile on the left. Provenance is already visible in the
    // source-mix particle colours flowing into the house.

    BG_FLOWS_BASE.forEach(function (s) {
      var eff   = bgFlowEffectiveKw(s.kw, s.maxKw);   // scale by stream's nameplate
      s.count   = bgFlowPwr2Count(eff);
      // k_grid (hub → grid = PV/solar feed-in toward the grid / Einspeisung) runs
      // 20% faster than its bgFlowPwr2Speed value (operator request — the base
      // PV-to-grid export stream looked far too slow). No other base stream and
      // no s_mqtt_* stream is affected: BG_FLOWS_SPEED_FACTOR is 1 for all others.
      s.speed   = bgFlowPwr2Speed(eff) * (BG_FLOWS_SPEED_FACTOR[s.id] || 1);
      s.reverse = false;                              // direction is encoded in from/to
      // Min-visibility floor: a base stream that WILL be drawn (s.kw >= 0.05, the
      // bgFlowDraw threshold) is lifted to at least a clearly-visible trickle, so
      // a real few-hundred-watt flow against a large nameplate is never invisible.
      // An idle stream (s.kw < 0.05) is skipped by bgFlowDraw and gets no floor.
      var isGridStream = s.id === 's_grid' || s.id === 'k_grid';
      if (isGridStream) {
        // Operator request 2026-06-13: the grid flow had an effective ~50-80 W
        // visibility floor (draw threshold 0.05 kW + min 40 dust). For small
        // balances that overstated the flow — drop to a true trickle: visible
        // from ~5 W, a handful of slow particles, strictly proportional above.
        s.minKw = 0.005;
        if (s.kw >= s.minKw) {
          s.count = Math.max(s.count, 5);
          s.speed = Math.max(s.speed, 0.012);
        }
      } else if (s.kw >= 0.05) {
        s.count = Math.max(s.count, BG_FLOW_MIN_COUNT);
        s.speed = Math.max(s.speed, BG_FLOW_MIN_SPEED);
      }
    });
  }

  /* ===================== MQTT POWER-TILE bgFlow STREAMS (D-05..D-10) ========
     A power-unit MQTT tile (W/kW/MW — isPowerUnit) joins the bgFlow dust
     constellation as its own stream between the tile's tray card
     (#fam-card-mqtt-<id>) and the hub (#pfCenter). Non-power tiles stay plain
     cards with no stream.

     These streams live in a SEPARATE array (bgFlowMqttStreams) rather than
     being spliced into BG_FLOWS_BASE — keeps the base-stream code path (and its
     fixed indices in updateBgFlowFromStatus) completely untouched. bgFlowDraw()
     is extended to seed/draw the dust for both arrays.

     Direction (D-07/D-08): a tile that has NEVER reported a negative value is a
     SINK (consumer) — drawn FROM the hub TO the card. Once a negative value is
     seen (everNegative becomes sticky-true), the direction follows the live
     sign. The canonical positive-only plug case is therefore correct
     immediately.

     Intensity (operator request — see below): each s_mqtt_* stream is sized
     STRICTLY PROPORTIONALLY to that device's share of the total house
     consumption (device W ÷ house W, clamped 0..1). The device streams visually
     divide up the house-consumption flow — NO minimum visibility floor: a small
     device (e.g. 114 W of a 1.29 kW house ≈ 9%) draws a correspondingly thin,
     slow stream. This SUPERSEDES the earlier logarithmic / running-max model. */

  // Per-tile in-memory sign state. Lives in family.js memory and resets on page
  // reload (acceptable — D-12 has no completeness guarantee).
  // Keyed by tile.id → { everNegative: boolean }.
  var bgFlowMqttState = {};
  // Active MQTT power-tile streams, keyed by tile.id. Each value is a stream
  // object of the same shape bgFlowDraw() consumes.
  var bgFlowMqttStreams = {};

  // Proportional intensity tuning for the s_mqtt_* streams. A device that IS the
  // whole house load (frac = 1) draws a near-full stream; these maxima are set
  // near the base streams' busiest values (bgFlowPwr2Count caps at 320, peak
  // bgFlowPwr2Speed ≈ 0.2) so a full-house device is comparable to the base flows.
  var MQTT_FLOW_MAX_COUNT = 300;    // near the base streams' busiest dust count
  var MQTT_FLOW_MAX_SPEED = 0.18;   // comparable to bgFlowPwr2Speed near peak

  function bgFlowClamp01(v) {
    if (!isFinite(v)) return 0;
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  /* Reconcile the MQTT power-tile streams against the polled mqttTiles set.
     MUST be called AFTER renderFamilyExtras() so the #fam-card-mqtt-<id> card
     exists — bgFlowDraw silently skips a stream whose endpoint resolves null.
     For each power-unit tile: create+seed a stream if new, then drive its
     direction/count/speed from the live value sized as a STRICTLY PROPORTIONAL
     share of houseW (the total house consumption, in W). Non-power tiles, and
     any tile that has dropped out of the poll, have their stream torn down. */
  function updateBgFlowMqttStreams(mqttTiles, houseW) {
    var tiles = mqttTiles || [];
    var houseLoadW = Math.max(0, Number(houseW) || 0);
    var seen = {};

    tiles.forEach(function (tile) {
      if (!tile || !tile.id) return;
      // Skip a tile that never produced a value — same guard renderFamilyExtras
      // uses to decide whether to render the card at all.
      if (tile.value == null && !tile.lastSeen) return;
      if (!isPowerUnit(tile.unit)) return;            // D-06: power units only
      // A power tile whose value is non-numeric carries no flow magnitude.
      var rawVal = tile.value;
      var valW = (typeof rawVal === 'number' && isFinite(rawVal)) ? rawVal : null;
      if (valW == null) return;

      seen[tile.id] = true;
      var st = bgFlowMqttState[tile.id];
      if (!st) { st = bgFlowMqttState[tile.id] = { everNegative: false }; }
      if (valW < 0) st.everNegative = true;           // D-08: sticky sign state

      var meta = resolveTileMeta(tile);
      var cardId = 'fam-card-mqtt-' + tile.id;

      var s = bgFlowMqttStreams[tile.id];
      if (!s) {
        // New stream — create with the card↔hub endpoints and individually
        // seed its dust (BG_FLOWS_BASE.forEach(bgFlowSeedDust) ran once at
        // init; streams added later are NOT auto-seeded).
        s = {
          id: 's_mqtt_' + tile.id,
          from: cardId, to: 'pfCenter',
          color: hexToRgb(meta.color)
        };
        bgFlowMqttStreams[tile.id] = s;
        bgFlowSeedDust(s);                            // pushes DUST_PER_STREAM particles
      }
      // Keep the accent colour in sync if the tile was re-themed.
      s.color = hexToRgb(meta.color);

      // D-07/D-08 direction: positive-only tile → SINK (hub → card). Once a
      // negative value has been seen, follow the live sign. Encode direction
      // in from/to (mirrors the base streams) — reverse stays false.
      if (!st.everNegative) {
        s.from = 'pfCenter'; s.to = cardId;           // consumer/sink
      } else if (valW >= 0) {
        s.from = 'pfCenter'; s.to = cardId;           // positive → into the card
      } else {
        s.from = cardId; s.to = 'pfCenter';           // negative → out of the card
      }
      s.reverse = false;
      // Provenance mix (2026-06-13): a consuming device receives particles in
      // the live source-share colours (same mix as the house/EV sinks). A
      // PRODUCING device (negative value) keeps its own accent colour.
      s.mix = (s.from === 'pfCenter') ? bgFlowSourceMix : null;

      var absW = Math.abs(valW);

      // bgFlowDraw's `s.kw < 0.05` skip guard works in kW — keep it intact so a
      // genuinely zero/idle tile still paints nothing.
      s.kw = absW / 1000;

      // (f) STRICTLY PROPORTIONAL particle intensity — operator request. Each
      // device stream is sized by its SHARE of the total house consumption:
      // the s_mqtt_* streams visually divide up the house-consumption flow.
      // frac = clamp01(device W ÷ house W). A device that IS the whole house
      // load (frac = 1) draws a near-full stream comparable to the busiest base
      // flows. Clamping to [0,1] guards measurement-timing skew where a device
      // briefly reads higher than the measured house total. This applies to the
      // s_mqtt_* streams ONLY — BG_FLOWS_BASE keeps its bgFlowPwr2Count/Speed
      // path.
      var frac = bgFlowClamp01(absW / Math.max(houseLoadW, 1));
      s.count = Math.round(frac * MQTT_FLOW_MAX_COUNT);
      s.speed = frac * MQTT_FLOW_MAX_SPEED;

      // Min-visibility floor (checkpoint round 5 — REVISES the round-2 "strictly
      // proportional, no floor" decision). The operator observed the 117 W
      // Gebläse stream as dead: against a ~10 kW house, frac ≈ 0.012 gives ~3
      // particles and nothing visibly arrives. A device that carries real power
      // (above the bgFlowDraw() s.kw < 0.05 skip threshold — i.e. it WILL be
      // drawn) is now lifted to at least the SAME minima as the base streams
      // (BG_FLOW_MIN_COUNT / BG_FLOW_MIN_SPEED, round 4) so the operator's MQTT
      // floor matches the grid/base behaviour. The proportional sizing still
      // governs ABOVE the floor — a device that is a big share of the house
      // still draws a correspondingly bigger stream. A genuinely idle device
      // (s.kw < 0.05) is skipped by bgFlowDraw and gets NO floor.
      if (s.kw >= 0.05) {
        s.count = Math.max(s.count, BG_FLOW_MIN_COUNT);
        s.speed = Math.max(s.speed, BG_FLOW_MIN_SPEED);
      }
    });

    // Tear down streams for tiles that dropped out of the poll, were disabled,
    // or are no longer power-unit tiles — drop their dust so no orphan remains.
    Object.keys(bgFlowMqttStreams).forEach(function (tileId) {
      if (seen[tileId]) return;
      var s = bgFlowMqttStreams[tileId];
      // Remove this stream's dust particles from the shared bgFlowDust array.
      for (var i = bgFlowDust.length - 1; i >= 0; i--) {
        if (bgFlowDust[i].s === s) bgFlowDust.splice(i, 1);
      }
      delete bgFlowMqttStreams[tileId];
    });
  }

  // #pfCenter centre readout — Powerflow-2.0 rework (2026-06-13): the centre is
  // a CROSSING (junction) like the powerflow mockup, not the House. Primary
  // line: net energy in kW + direction (EXPORT / BEZUG / BALANCE). Secondary
  // line: the daily net-Euro balance (kept from the previous design). The live
  // Hausverbrauch moved to the dedicated #tag-home tile (id pf-house-kw kept).
  function updatePfCenterReadout(data) {
    var c = document.getElementById('pfCenter');
    if (!c) return;
    var energy = (data && data.energy) || {};
    // House tile — the SAME homeKw the proportional MQTT streams use as
    // their denominator (already patched by inferHomeKw in the family.tags block).
    setText('pf-house-kw', formatKw(Math.max(0, Number(energy.homeKw || 0))));
    // PRIMARY line (operator request 2026-06-13): the day's earnings in €.
    // Secondary line: live net grid energy + direction (EXPORT/BEZUG/BALANCE).
    var sav = (data && data.savings) || {};
    var feed = parseFloat(sav.feedInRevenueEur || '0');
    var avoid = parseFloat(sav.avoidedCostEur || '0');
    var net = (isFinite(feed) ? feed : 0) + (isFinite(avoid) ? avoid : 0);
    var sign = net >= 0 ? '+' : '−'; // unicode minus
    setText('pf-center-v', sign + Math.abs(net).toFixed(2).replace('.', ',') + ' €');
    setText('pf-center-d', net >= 0 ? 'Gewinn heute' : 'Kosten heute');
    c.classList.toggle('loss', net < 0);
    // energy.gridKw: + = Bezug, − = Export (matches updateBgFlowFromStatus).
    var gridKw = Number(energy.gridKw || 0);
    var netKw = -gridKw; // + = exporting, − = importing
    var dirEl = document.getElementById('pf-center-dir');
    setText('pf-center-kw', (netKw > 0.05 ? '+' : netKw < -0.05 ? '−' : '') + formatKw(Math.abs(netKw)));
    if (dirEl) {
      dirEl.textContent = netKw > 0.05 ? 'EXPORT' : netKw < -0.05 ? 'BEZUG' : 'BALANCE';
      dirEl.classList.toggle('dir-export', netKw > 0.05);
      dirEl.classList.toggle('dir-import', netKw < -0.05);
    }
  }

  /* =======================================================================
     Phase 19 Plan 19-07 — Family-dashboard Optimizer-Cold mirror.
     Independent 60s polling block (sibling of pollFamilyStatus) that mirrors
     the settings.html #optimizerColdBanner onto the kiosk surface. Same
     thresholds, same copy, same markup as settings.js — the mirror MUST stay
     identical (UI-SPEC §"Family-dashboard mirror"). Pauses on tab-hidden via
     the existing visibilitychange handler is not enough — we install a
     dedicated one because pollFamilyStatus runs at 5s anyway, but this block
     is gated to 60s + must stop when hidden.
     ======================================================================= */
  var FAMILY_COLD_POLL_MS = 60_000;
  var FAMILY_COLD_YELLOW_DAYS = 2;
  var FAMILY_COLD_RED_DAYS = 5;
  var familyColdTimer = null;

  function getFamilyColdBanner() {
    return document.getElementById('familyOptimizerColdBanner');
  }

  function renderFamilyColdBanner(payload) {
    var banner = getFamilyColdBanner();
    if (!banner) return;
    if (!payload || payload.ok === false) {
      banner.hidden = true;
      banner.textContent = '';
      return;
    }
    var days = payload.daysSinceLastRun;
    if (days == null || days < FAMILY_COLD_YELLOW_DAYS) {
      banner.hidden = true;
      banner.classList.remove('warn', 'error');
      banner.textContent = '';
      return;
    }
    banner.hidden = false;
    var dateStr = '';
    if (payload.lastRunAt) {
      var d = new Date(payload.lastRunAt);
      if (!isNaN(d.getTime())) {
        dateStr = ('0' + d.getDate()).slice(-2) + '.' +
                  ('0' + (d.getMonth() + 1)).slice(-2) + '.' +
                  d.getFullYear();
      }
    }
    if (days >= FAMILY_COLD_RED_DAYS) {
      banner.classList.remove('warn');
      banner.classList.add('error');
      banner.textContent = 'Optimizer ist seit ' + Math.floor(days) +
        ' Tagen kalt. Stage-2-Automatik liefert keine neuen Pläne mehr — bitte Optimizer-Status prüfen.';
    } else {
      banner.classList.remove('error');
      banner.classList.add('warn');
      banner.textContent = 'Optimizer kalt seit ' + Math.floor(days) + ' Tagen.' +
        (dateStr ? ' Stage-2-Plan wurde zuletzt am ' + dateStr + ' berechnet.' : '');
    }
  }

  function pollFamilyCold() {
    apiFetchCompat('/api/forecast/inspector/optimizer-cold')
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ok !== false) renderFamilyColdBanner(j); })
      .catch(function () { /* silent — banner retains last state on network blip */ });
  }

  function startFamilyColdPoll() {
    if (familyColdTimer != null) return;
    pollFamilyCold();
    familyColdTimer = setInterval(pollFamilyCold, FAMILY_COLD_POLL_MS);
  }

  function stopFamilyColdPoll() {
    if (familyColdTimer == null) return;
    clearInterval(familyColdTimer);
    familyColdTimer = null;
  }

  // Visibility gate — pause cold-poll on tab hidden, resume on visible.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') startFamilyColdPoll();
    else stopFamilyColdPoll();
  });

  /* ===================== Powerflow-2.0 tag animations (2026-06-13) =========
     The Leitstand's photo sky + battery SoC pill, reused on the Family tags.
     Animation CSS lives dual-scoped in dvhub-powerflow.css (.fam-taganim.*);
     family.css only overrides the compact sizes. Sky frames are the same
     /assets/pf-sky/ WebPs (one browser cache entry for both pages). */
  var FAM_SKY_PCTS = [0, 10, 20, 30, 40, 50, 60, 65, 70, 75, 80, 85, 90, 93, 95, 97, 99, 100];
  var FAM_PV_RAMP_MAX_KW = 27; // 90% of the 30 kW plant nameplate (mockup contract)

  function initFamTagAnims() {
    var sky = document.getElementById('famSky');
    if (sky && !sky.childElementCount) {
      FAM_SKY_PCTS.forEach(function (p) {
        var img = document.createElement('img');
        img.className = 'pf-frame';
        img.dataset.pct = String(p);
        img.src = '/assets/pf-sky/sky-' + ('00' + p).slice(-3) + '.webp';
        img.alt = '';
        img.decoding = 'async';
        if (p === 0) img.style.opacity = '1'; // moon until the first poll
        sky.appendChild(img);
      });
    }
  }

  function famUpdateTagAnims(energy, battery) {
    // Sky — weighted multi-frame blending over the PV share (see dvhub-powerflow.js).
    var sky = document.getElementById('famSky');
    if (sky) {
      var pvKw = Math.max(0, Number(energy && energy.solarKw || 0));
      var pct = Math.max(0, Math.min(pvKw / FAM_PV_RAMP_MAX_KW, 1)) * 100;
      sky.style.setProperty('--pv-i', (pct / 100).toFixed(3));
      var frames = sky.querySelectorAll('.pf-frame');
      var SPAN = 18;
      var maxW = 0;
      var weights = [];
      for (var i = 0; i < frames.length; i++) {
        var dlt = Math.abs(pct - Number(frames[i].dataset.pct));
        var w = Math.max(0, 1 - dlt / SPAN);
        w = w * w * (3 - 2 * w);
        weights.push(w);
        if (w > maxW) maxW = w;
      }
      var norm = maxW > 0 ? 1 / maxW : 1;
      for (var j = 0; j < frames.length; j++) {
        frames[j].style.opacity = (weights[j] * norm).toFixed(3);
      }
    }
    // Battery pill — SoC fill + colour, charge sweep/bolts, danger blink.
    var bat = document.getElementById('famBat');
    if (bat && battery && typeof battery.socPct === 'number') {
      var soc = Math.max(0, Math.min(Number(battery.socPct), 100));
      var charging = battery.mode === 'charging';
      var passive = Math.max(0, Math.min((soc - 35) / 65, 1));
      bat.style.setProperty('--p', soc.toFixed(2));
      bat.style.setProperty('--fill', soc.toFixed(2) + '%');
      bat.style.setProperty('--glow', Math.max(0, Math.min((soc - 18) / 82, 1)).toFixed(3));
      bat.style.setProperty('--charge', (charging ? 1 : passive).toFixed(3));
      bat.style.setProperty('--danger', Math.max(0, Math.min((18 - soc) / 18, 1)).toFixed(3));
    }
  }

  /* ===================== Family settings popup (2026-06-13) ================
     Tapping the top-right clock opens the dashboard's OWN settings: the
     screensaver ("automatisch abdunkeln") toggle + timeout, and a reset for
     the dragged tile layout (T-0091). Saved server-side via
     POST /api/family/settings → cfg.family.screensaver, which the existing
     screensaver state machine reads from /api/family/status config block. */
  function openFamSettings() {
    var ov = document.getElementById('famSettingsOverlay');
    if (!ov) return;
    var cfg = (lastStatus && lastStatus.config && lastStatus.config.screensaver) || {};
    var en = document.getElementById('famSetSaverEnabled');
    var min = document.getElementById('famSetSaverMinutes');
    if (en) en.checked = cfg.enabled !== false;
    if (min) min.value = String(Math.max(1, Math.round((Number(cfg.defaultTimeoutSec) || 120) / 60)));
    setText('famSetMsg', '');
    ov.classList.add('open');
  }

  function closeFamSettings() {
    var ov = document.getElementById('famSettingsOverlay');
    if (ov) ov.classList.remove('open');
  }

  function saveFamSettings() {
    var en = document.getElementById('famSetSaverEnabled');
    var min = document.getElementById('famSetSaverMinutes');
    var minutes = Math.max(1, Math.min(120, Math.round(Number(min && min.value) || 2)));
    var body = {
      screensaver: {
        enabled: !(en && en.checked === false),
        defaultTimeoutSec: minutes * 60
      }
    };
    apiFetchCompat('/api/family/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (out) {
      if (!out || out.ok !== true) throw new Error((out && out.error) || 'save failed');
      // Patch the local status copy so the state machine picks it up before
      // the next poll.
      if (lastStatus) {
        lastStatus.config = lastStatus.config || {};
        lastStatus.config.screensaver = Object.assign({}, lastStatus.config.screensaver, body.screensaver);
      }
      setText('famSetMsg', 'Gespeichert ✓');
      setTimeout(closeFamSettings, 700);
    }).catch(function (e) {
      setText('famSetMsg', 'Fehler: ' + e.message);
    });
  }

  function initFamSettings() {
    var clock = document.getElementById('g-time');
    if (clock) clock.addEventListener('click', openFamSettings);
    var save = document.getElementById('famSetSave');
    if (save) save.addEventListener('click', saveFamSettings);
    var reset = document.getElementById('famSetLayoutReset');
    if (reset) reset.addEventListener('click', function () {
      try { localStorage.removeItem(TAG_LAYOUT_KEY); } catch (e) { /* private mode */ }
      DRAGGABLE_TILE_IDS.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) tagLayoutClearOne(el);
      });
      setText('famSetMsg', 'Kachel-Layout zurückgesetzt ✓');
    });
  }

  /* ===================== T-0091: draggable constellation tiles =============
     Operator request (2026-06-05/13): the tags sit on fixed CSS positions, so
     flows can overlap (EV and Grid ran on nearly the same bearing). Every
     constellation tile (+ the House centre) is now drag-movable; positions
     persist per browser in localStorage as viewport-% so they survive reloads
     and adapt to screen size. The bgFlow particle paths follow automatically —
     bgFlowEndpoint() reads live getBoundingClientRect() each frame.
     Interaction contract: <8 px movement = tap (opens the detail panel as
     before); >=8 px = drag (panel-open suppressed). Double-tap a tile to reset
     it to its CSS default position. ======================================== */
  var TAG_LAYOUT_KEY = 'dvhub.family.tagLayout.v1';
  var DRAGGABLE_TILE_IDS = ['tag-solar', 'tag-bat', 'tag-ev', 'tag-grid', 'tag-home', 'pfCenter'];
  var tagDragSuppressTap = false;

  function tagLayoutLoad() {
    try { return JSON.parse(localStorage.getItem(TAG_LAYOUT_KEY)) || {}; } catch (e) { return {}; }
  }
  function tagLayoutSave(layout) {
    try { localStorage.setItem(TAG_LAYOUT_KEY, JSON.stringify(layout)); } catch (e) { /* private mode */ }
  }
  function tagLayoutApplyOne(el, pos) {
    var leftPct = Math.max(0, Math.min(95, Number(pos && pos.leftPct)));
    var topPct = Math.max(0, Math.min(92, Number(pos && pos.topPct)));
    if (!isFinite(leftPct) || !isFinite(topPct)) return;
    el.style.left = leftPct + '%';
    el.style.top = topPct + '%';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  function tagLayoutClearOne(el) {
    el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = '';
  }

  function initTagDrag() {
    var layout = tagLayoutLoad();
    DRAGGABLE_TILE_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (layout[id]) tagLayoutApplyOne(el, layout[id]);

      el.addEventListener('dblclick', function () {
        var l = tagLayoutLoad(); delete l[id]; tagLayoutSave(l);
        tagLayoutClearOne(el);
      });

      el.addEventListener('pointerdown', function (ev) {
        if (ev.isPrimary === false) return;
        var startX = ev.clientX, startY = ev.clientY;
        var rect = el.getBoundingClientRect();
        var moved = false;
        // #pfCenter is centred via translate(-50%,-50%) — its left/top address
        // the CENTRE, not the top-left corner.
        var centred = (id === 'pfCenter');

        function onMove(mv) {
          var dx = mv.clientX - startX, dy = mv.clientY - startY;
          if (!moved && Math.hypot(dx, dy) < 8) return;
          if (!moved) {
            moved = true;
            el.classList.add('tag-dragging');
            try { el.setPointerCapture(ev.pointerId); } catch (e) { /* capture optional */ }
          }
          mv.preventDefault();
          el.style.left = (rect.left + dx + (centred ? rect.width / 2 : 0)) + 'px';
          el.style.top = (rect.top + dy + (centred ? rect.height / 2 : 0)) + 'px';
          el.style.right = 'auto';
          el.style.bottom = 'auto';
        }
        function onUp() {
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointercancel', onUp);
          if (!moved) return;
          el.classList.remove('tag-dragging');
          var r = el.getBoundingClientRect();
          var pos = {
            leftPct: (r.left + (centred ? r.width / 2 : 0)) / window.innerWidth * 100,
            topPct: (r.top + (centred ? r.height / 2 : 0)) / window.innerHeight * 100
          };
          tagLayoutApplyOne(el, pos);   // re-anchor in % (responsive) + clamp
          var l = tagLayoutLoad(); l[id] = pos; tagLayoutSave(l);
          // The browser fires click/touchend after pointerup — swallow that
          // one tap so ending a drag does not open the detail panel.
          tagDragSuppressTap = true;
          setTimeout(function () { tagDragSuppressTap = false; }, 350);
        }
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
      });
    });
  }

  /* ===================== BOOTSTRAP ===================== */
  // Initialise the Aurora bgFlow dust constellation eagerly so the background
  // paints (idle) before the first /api/family/status poll completes; the poll
  // then drives stream kW/speed/count from real data.
  initBgFlow();
  initTagDrag();
  initFamTagAnims();
  initFamSettings();
  pollFamilyStatus();
  setInterval(pollFamilyStatus, POLL_INTERVAL_MS);
  // Phase 19 Plan 19-07 — start the optimizer-cold poll alongside the rest.
  startFamilyColdPoll();
  // Periodic clock fallback in case /api/family/status is unreachable at boot —
  // the greeting.time field from the backend takes over once the first poll succeeds.
  (function bootstrapClock() {
    function tick() {
      if (lastStatus) return; // backend-provided time wins once connected
      var d = new Date();
      setText('g-time', d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
      setText('g-date', d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }));
    }
    tick();
    setInterval(tick, 15000);
  })();

})();
