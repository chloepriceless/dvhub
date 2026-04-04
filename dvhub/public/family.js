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
      if (action === 'close-panel') { closePanel(); return; }
      if (action === 'pick-metric') {
        var key = actionEl.getAttribute('data-metric-key');
        if (key) pickMetric(key);
        return;
      }
      if (action === 'slot-click') {
        var idx = parseInt(actionEl.getAttribute('data-slot'), 10);
        if (!isNaN(idx)) slotClick(idx);
        return;
      }
    }
    var tag = e.target.closest('[data-panel]');
    if (tag) openPanel(tag.getAttribute('data-panel'));
  });
  document.addEventListener('touchend', function (e) {
    var tag = e.target.closest('[data-panel]');
    var actionEl = e.target.closest('[data-action]');
    if (actionEl) return; // click handler will fire
    if (tag) { e.preventDefault(); openPanel(tag.getAttribute('data-panel')); }
  }, { passive: false });

  var NS = 'http://www.w3.org/2000/svg';
  var panelChart = null;
  var activeDevices = {};

  /* Panel data for main tags (static copy seeded from original; stats are
     rewritten on every poll via applyFamilyStatus -> updatePanelStats) */
  var panelData = {
    solar: { icon: '&#9728;&#65039;', iconBg: 'rgba(247,183,49,.1)', title: 'Solaranlage', sub: 'Deine Module auf dem Dach', color: '#F7B731', summary: 'Die Solaranlage wandelt Sonnenlicht in Strom um. An guten Tagen deckst du den gesamten Hausverbrauch und lädst gleichzeitig Batterie und Auto.', stats: [{ label: 'Gerade', val: '—', delta: '', up: true }, { label: 'Heute', val: '—', delta: '', up: true }, { label: 'Morgen', val: '—', delta: '', up: true }], chart: null, details: [['Status', 'Live von /api/family/status']] },
    home: { icon: '&#127968;', iconBg: 'rgba(75,123,236,.1)', title: 'Dein Zuhause', sub: 'Gesamtverbrauch', color: '#4b7bec', summary: 'Der Verbrauch wird berechnet aus Solar minus Batterie, Auto und Netz.', stats: [{ label: 'Gerade', val: '—', delta: '', up: true }, { label: 'Heute', val: '—', delta: '', up: true }, { label: 'Eigenverbrauch', val: '—', delta: '', up: true }], chart: null, details: [['Berechnung', 'Solar - Batterie - Auto - Netz']] },
    bat: { icon: '&#128267;', iconBg: 'rgba(38,222,129,.1)', title: 'Batteriespeicher', sub: 'Dein Stromspeicher', color: '#26de81', summary: 'Speichert Solarüberschuss für den Abend.', stats: [{ label: 'Stand', val: '—', delta: '', up: true }, { label: 'Leistung', val: '—', delta: '', up: true }, { label: 'Reicht', val: '—', delta: '', up: true }], chart: null, details: [['Kapazität', '—']] },
    ev: { icon: '&#128664;', iconBg: 'rgba(165,94,234,.1)', title: 'E-Auto', sub: 'Solarüberschuss-Laden', color: '#a55eea', summary: 'Lädt clever mit dem Strom den die Sonne liefert.', stats: [{ label: 'Leistung', val: '—', delta: '', up: true }, { label: 'Akku', val: '—', delta: '', up: true }, { label: 'Modus', val: '—', delta: '', up: true }], chart: null, details: [['Wallbox', '—']] },
    grid: { icon: '&#9889;', iconBg: 'rgba(253,150,68,.1)', title: 'Stromnetz', sub: 'Einspeisung & Bezug', color: '#fd9644', summary: 'Richtung und Preis live vom /api/family/status Endpoint.', stats: [{ label: 'Gerade', val: '—', delta: '', up: true }, { label: 'Preis jetzt', val: '—', delta: '', up: true }, { label: 'Min/Max heute', val: '—', delta: '', up: true }], chart: null, details: [['Tarif', 'Dynamisch']] },
    forecast: { icon: '&#9925;', iconBg: 'rgba(247,183,49,.08)', title: 'PV Vorhersage', sub: 'Heute & Morgen', color: '#F7B731', summary: 'Die PV-Vorhersage basiert auf Wetterdaten und pvlib-Simulation.', stats: [{ label: 'Heute', val: '—', delta: '', up: true }, { label: 'Morgen', val: '—', delta: '', up: true }, { label: 'Peak', val: '—', delta: '', up: true }], chart: null, details: [['Quelle', '/api/forecast']] },
    price: { icon: '&#128181;', iconBg: 'rgba(253,150,68,.08)', title: 'EPEX Strompreis', sub: 'Day-Ahead Markt', color: '#fd9644', summary: 'Stündliche EPEX Day-Ahead Börsenpreise.', stats: [{ label: 'Jetzt', val: '—', delta: '', up: true }, { label: 'Min heute', val: '—', delta: '', up: true }, { label: 'Max heute', val: '—', delta: '', up: true }], chart: null, details: [['Quelle', '/api/forecast (price slots)']] },
    optimizer: { icon: '&#129302;', iconBg: 'rgba(75,123,236,.08)', title: 'Optimizer', sub: 'Lade-/Entlade-Strategie', color: '#4b7bec', summary: 'Der interne Optimizer plant Lade- und Entladephasen basierend auf EPEX Preisen und PV-Vorhersage.', stats: [{ label: 'Jetzt', val: '—', delta: '', up: true }, { label: 'Als nächstes', val: '—', delta: '', up: true }, { label: 'Status', val: '—', delta: '', up: true }], chart: null, details: [['Quelle', '/api/optimizer/status']] }
  };

  function openPanel(key) {
    var d = panelData[key]; if (!d) return;
    document.getElementById('p-icon').innerHTML = d.icon;
    document.getElementById('p-icon').style.background = d.iconBg;
    document.getElementById('p-title').innerHTML = d.title;
    document.getElementById('p-title').style.color = d.color;
    document.getElementById('p-sub').innerHTML = d.sub;
    document.getElementById('p-summary').innerHTML = d.summary;
    var sh = ''; d.stats.forEach(function (s) { sh += '<div class="stat-card"><div class="stat-label">' + s.label + '</div><div class="stat-val" style="color:' + d.color + '">' + s.val + '</div><div class="stat-delta ' + (s.up ? 'up' : 'down') + '">' + s.delta + '</div></div>'; });
    document.getElementById('p-stats').innerHTML = sh;
    var dh = ''; d.details.forEach(function (r) { dh += '<div class="detail-row"><span class="detail-key">' + r[0] + '</span><span class="detail-val">' + r[1] + '</span></div>'; });
    document.getElementById('p-details').innerHTML = dh;
    var api = document.getElementById('p-api'); if (d.apiHint) { api.innerHTML = d.apiHint; api.style.display = 'block'; } else { api.style.display = 'none'; }
    // Pitfall 1 — destroy before re-creating to avoid chart instance leak
    if (panelChart) { panelChart.destroy(); panelChart = null; }
    if (d.chart) {
      var ctx = document.getElementById('p-chart').getContext('2d');
      var hrs = Array.from({ length: 24 }, function (_, i) { return String(i).padStart(2, '0') + ':00'; });
      var isBat = key === 'bat', isGrid = key === 'grid';
      panelChart = new Chart(ctx, { type: 'line', data: { labels: hrs, datasets: [{ data: d.chart, borderColor: d.color, backgroundColor: d.color + '18', fill: true, tension: .4, pointRadius: 0, borderWidth: 2 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(14,16,24,.9)', titleColor: '#fff', bodyColor: '#ccc', borderColor: 'rgba(255,255,255,.1)', borderWidth: 1, cornerRadius: 10, padding: 10, callbacks: { label: function (c) { return isBat ? c.parsed.y + '%' : c.parsed.y.toFixed(1) + ' kW'; } } } }, scales: { x: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: 'rgba(255,255,255,.2)', font: { size: 10 }, maxTicksLimit: 6 }, border: { display: false } }, y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: 'rgba(255,255,255,.2)', font: { size: 10 }, callback: function (v) { return isBat ? v + '%' : v + 'kW'; } }, border: { display: false }, beginAtZero: !isGrid } } } });
      document.querySelector('.panel-chart').style.display = '';
    } else { document.querySelector('.panel-chart').style.display = 'none'; }
    document.getElementById('overlay').classList.add('open');
    document.getElementById('panel').scrollTop = 0;
  }
  function closePanel() { document.getElementById('overlay').classList.remove('open'); }

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
        el.innerHTML = '<div class="dev-emoji">' + d.emoji + '</div><div class="dev-name">' + d.name + '</div><div class="dev-watts" style="color:' + col + '">' + formatW(d.watts) + '</div><div class="dev-bar-wrap"><div class="dev-bar" style="width:' + barPct + '%;background:' + col + '"></div></div>';
        tray.appendChild(el);
        activeDevices[d.id] = el;
      } else {
        el.querySelector('.dev-watts').textContent = formatW(d.watts);
        el.querySelector('.dev-watts').style.color = col;
        el.querySelector('.dev-bar').style.width = barPct + '%';
        el.querySelector('.dev-bar').style.background = col;
      }
      panelData[cardId] = {
        icon: d.emoji, iconBg: 'rgba(120,144,156,.1)', title: d.name, sub: 'Einzelverbraucher', color: d.color || '#78909c',
        summary: d.name + ' verbraucht gerade ' + formatW(d.watts) + '.',
        stats: [{ label: 'Gerade', val: formatW(d.watts), delta: d.watts > 500 ? 'Hoher Verbrauch' : 'Normal', up: d.watts < 500 }],
        chart: null,
        details: [['Aktueller Verbrauch', formatW(d.watts)], ['Quelle', 'Shelly / Smart Plug'], ['Gerät', d.name]]
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

  /* ===================== STICKY FLOWS ===================== */
  function edge(f, t) { var fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect(); var fc = { x: fr.left + fr.width / 2, y: fr.top + fr.height / 2 }; var tc = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 }; var dx = tc.x - fc.x, dy = tc.y - fc.y, a = Math.atan2(dy, dx); var fs = Math.min((fr.width / 2 + 8) / Math.abs(Math.cos(a) || .001), (fr.height / 2 + 8) / Math.abs(Math.sin(a) || .001)); var ts = Math.min((tr.width / 2 + 8) / Math.abs(Math.cos(a) || .001), (tr.height / 2 + 8) / Math.abs(Math.sin(a) || .001)); return { x1: fc.x + Math.cos(a) * fs, y1: fc.y + Math.sin(a) * fs, x2: tc.x - Math.cos(a) * ts, y2: tc.y - Math.sin(a) * ts }; }
  var flows = [
    { from: 'tag-solar', to: 'tag-home', hex: '#F7B731', w: 2.5, p: 3, wh: 2, dur: 1.8, id: 'f1' },
    { from: 'tag-home', to: 'tag-bat', hex: '#26de81', w: 2, p: 2, wh: 1, dur: 2.2, id: 'f2' },
    { from: 'tag-home', to: 'tag-ev', hex: '#a55eea', w: 2, p: 2, wh: 1, dur: 2.0, id: 'f3' },
    { from: 'tag-home', to: 'tag-grid', hex: '#fd9644', w: 1.8, p: 1, wh: 1, dur: 2.8, id: 'f4' }
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
        var devFlow = { from: 'tag-home', to: 'dev-card-' + d.id, hex: d.color || '#78909c', w: 1.2, p: 1, wh: 0, dur: 2.0 + i * 0.3, id: 'df-' + d.id };
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
    allFlows.forEach(function (fl) {
      var fe = document.getElementById(fl.from), te = document.getElementById(fl.to);
      if (!fe || !te) return;
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
  var sty = document.createElement('style'); sty.textContent = '@keyframes fd{to{stroke-dashoffset:-50}}'; document.head.appendChild(sty);

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

  /* ===================== CONFIGURABLE METRICS BAR (D-12) ===================== */
  var allMetrics = {
    eigenverbrauch: { id: 'eigenverbrauch', icon: '\u{1F340}', label: 'Eigenverbrauch', color: '#26de81', unit: '%', calc: function (s) { return s.sr; } },
    autarkie: { id: 'autarkie', icon: '\u{1F3E0}', label: 'Autarkie', color: '#4b7bec', unit: '%', calc: function (s) { return s.autarkie; } },
    gespart: { id: 'gespart', icon: '\u{1F4B0}', label: 'Heute gespart', color: '#26de81', unit: '\u20ac', calc: function (s) { return s.savedEur; } },
    einspeisung_eur: { id: 'einspeisung_eur', icon: '\u{1F4B8}', label: 'Einnahmen', color: '#fd9644', unit: '\u20ac', calc: function (s) { return s.feedEur; } },
    kosten_vermieden: { id: 'kosten_vermieden', icon: '\u{1F6E1}\uFE0F', label: 'Kosten vermieden', color: '#26de81', unit: '\u20ac', calc: function (s) { return s.avoidedEur; } },
    monatsbilanz: { id: 'monatsbilanz', icon: '\u{1F4C8}', label: 'Monatsbilanz', color: '#F7B731', unit: '\u20ac', calc: function (s) { return s.monthEur; } },
    co2: { id: 'co2', icon: '\u{1F33F}', label: 'CO\u2082 vermieden', color: '#26de81', unit: 'kg', calc: function (s) { return s.co2; } },
    baeume: { id: 'baeume', icon: '\u{1F333}', label: 'Bäume-Äquivalent', color: '#26de81', unit: '', calc: function (s) { return s.trees; } },
    solar_km: { id: 'solar_km', icon: '\u{1F697}', label: 'Solar-Kilometer', color: '#a55eea', unit: 'km', calc: function (s) { return s.solarKm; } },
    waschgaenge: { id: 'waschgaenge', icon: '\u{1F455}', label: 'Waschgänge gratis', color: '#42a5f5', unit: '', calc: function (s) { return s.washes; } },
    netflix: { id: 'netflix', icon: '\u{1F4FA}', label: 'Std Netflix gratis', color: '#e84118', unit: 'h', calc: function (s) { return s.netflixH; } },
    tagesertrag: { id: 'tagesertrag', icon: '\u2600\uFE0F', label: 'Tagesertrag', color: '#F7B731', unit: 'kWh', calc: function (s) { return s.dayYield; } },
    netz_bilanz: { id: 'netz_bilanz', icon: '\u26A1', label: 'Netz heute', color: '#fd9644', unit: 'kWh', calc: function (s) { return s.netBalance; } },
    bat_zyklen: { id: 'bat_zyklen', icon: '\u{1F504}', label: 'Batterie-Zyklen', color: '#26de81', unit: '', calc: function (s) { return s.batCycles; } },
    jahresertrag: { id: 'jahresertrag', icon: '\u{1F4CA}', label: 'Jahresertrag', color: '#F7B731', unit: 'MWh', calc: function (s) { return s.yearYield; } }
  };

  var defaultSlots = ['eigenverbrauch', 'gespart', 'co2', 'baeume', 'solar_km', 'tagesertrag'];
  var slotConfig = [];
  var editMode = false;
  var editingSlot = -1;

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
      var mid = slotConfig[i] || defaultSlots[i % defaultSlots.length];
      var m = allMetrics[mid];
      if (!m) continue;
      html += '<div class="slot" data-slot="' + i + '" data-metric="' + mid + '" data-action="slot-click">';
      html += '<div class="slot-edit">\u270E</div>';
      html += '<div class="slot-icon">' + m.icon + '</div>';
      html += '<div class="slot-val" id="sv-' + i + '" style="color:' + m.color + '">--</div>';
      html += '<div class="slot-label">' + m.label + '</div>';
      html += '</div>';
    }
    container.innerHTML = html;
  }

  function toggleEdit() {
    editMode = !editMode;
    document.getElementById('glass').classList.toggle('editing', editMode);
    document.getElementById('editBtn').classList.toggle('active', editMode);
    if (!editMode) closePicker();
  }

  function slotClick(idx) {
    if (!editMode) return;
    editingSlot = idx;
    openPicker(idx);
  }

  function openPicker(slotIdx) {
    var grid = document.getElementById('pickerGrid');
    var current = slotConfig[slotIdx];
    var html = '';
    Object.keys(allMetrics).forEach(function (key) {
      var m = allMetrics[key];
      var sel = key === current ? ' selected' : '';
      html += '<div class="picker-item' + sel + '" data-action="pick-metric" data-metric-key="' + key + '">';
      html += '<div class="picker-item-icon">' + m.icon + '</div>';
      html += '<div><div class="picker-item-name">' + m.label + '</div>';
      html += '<div class="picker-item-desc">' + m.unit + '</div></div>';
      html += '</div>';
    });
    grid.innerHTML = html;
    document.getElementById('picker-title').textContent = 'Slot ' + (slotIdx + 1) + ' — Kennzahl wählen';
    document.getElementById('pickerOverlay').classList.add('open');
  }

  function closePicker() { document.getElementById('pickerOverlay').classList.remove('open'); editingSlot = -1; }

  function pickMetric(key) {
    if (editingSlot < 0) return;
    slotConfig[editingSlot] = key;
    saveSlotConfig();
    renderSlots();
    updateSlotValues();
    closePicker();
  }

  var liveStats = { sr: '--', autarkie: '--', savedEur: '--', feedEur: '--', avoidedEur: '--', monthEur: '--', co2: '--', trees: '--', solarKm: '--', washes: '--', netflixH: '--', dayYield: '--', netBalance: '--', batCycles: '--', yearYield: '--' };

  function updateSlotValues() {
    var count = getSlotCount();
    for (var i = 0; i < count; i++) {
      var mid = slotConfig[i];
      var m = allMetrics[mid];
      if (!m) continue;
      var el = document.getElementById('sv-' + i);
      if (!el) continue;
      var val = m.calc(liveStats);
      el.textContent = val + (m.unit && val !== '--' ? ' ' + m.unit : '');
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
      hideOfflineBanner();
      applyFamilyStatus(data);
    } catch (err) {
      failedPolls += 1;
      if (failedPolls >= LS_OFFLINE_GRACE_POLLS) {
        showOfflineBanner(lastStatusAt);
      }
      // D-22 — do NOT clear lastStatus; last known values remain visible
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

  function applyFamilyStatus(data) {
    var energy = data.energy || {};
    var battery = data.battery || {};
    var ev = data.ev || {};
    var price = data.price || {};
    var greeting = data.greeting || {};

    // 5 main tag values
    setText('v-s', formatKw(energy.solarKw));
    setText('v-h', formatKw(energy.homeKw));
    setText('v-b', typeof battery.socPct === 'number' ? Math.round(battery.socPct) + '%' : '—');
    setText('v-e', formatKw(ev.powerKw));
    setText('v-g', formatKw(Math.abs(energy.gridKw || 0)));

    // Friendly texts & statuses
    setText('tf-solar', energy.surplus ? 'Sonne gibt Vollgas' : (energy.solarKw > 0.5 ? 'Solar läuft' : 'Kaum Sonne'));
    setText('tf-home', (energy.homeKw || 0) > 4 ? 'Hoher Verbrauch' : (energy.homeKw || 0) > 2.5 ? 'Verbrauch normal' : 'Wenig Verbrauch');

    var batMode = battery.mode || 'idle';
    setText('tf-bat', batMode === 'charging' ? 'Batterie lädt' : batMode === 'discharging' ? 'Batterie entlädt' : 'Batterie hält');
    if (typeof battery.powerKw === 'number') {
      setText('ts-bat', (battery.powerKw >= 0 ? '+' : '') + battery.powerKw.toFixed(1) + ' kW');
    }

    var evMode = ev.mode || 'idle';
    setText('tf-ev', evMode === 'solar_charging' ? 'Auto lädt mit Solar' : evMode === 'grid_charging' ? 'Auto lädt' : 'Auto parkt');
    setText('ts-ev', ev.finishEstIso ? 'Fertig ca. ' + formatHour(ev.finishEstIso) : '');

    setText('tf-grid', energy.feedingToGrid ? 'Wir speisen ein' : 'Wir beziehen');
    // "Kosten" = actual user import price (includes grid fees/VAT/taxes), not the
    // raw EPEX spot. Fall back to EPEX spot only if the tariff-adjusted price is
    // unavailable so the row never shows a confusing number.
    var importPrice = typeof price.importCtKwh === 'number' ? price.importCtKwh
      : (typeof price.nowCtKwh === 'number' ? price.nowCtKwh : null);
    setText('ts-grid', energy.feedingToGrid ? 'Verdienen gerade' : (importPrice != null ? 'Kosten ' + importPrice.toFixed(1) + ' ct' : ''));

    // Greeting (vorkalkuliert per D-07/D-13)
    if (greeting.hello) setText('g-hello', greeting.hello);
    if (greeting.message) {
      var msgEl = document.getElementById('g-msg');
      if (msgEl) msgEl.innerHTML = String(greeting.message).replace(/\n/g, '<br>');
    }
    if (greeting.moodLabel) setText('g-mood', greeting.moodLabel);
    var moodEl = document.getElementById('g-mood');
    if (moodEl) moodEl.classList.toggle('warn', greeting.mood === 'warn');
    if (greeting.time) setText('g-time', greeting.time);
    if (greeting.date) setText('g-date', greeting.date);

    // Live stats for bottom-bar slots (D-12)
    var savings = data.savings || {};
    var forecast = data.forecast || {};
    liveStats.sr = typeof energy.solarKw === 'number' && energy.solarKw > 0 && typeof energy.homeKw === 'number'
      ? Math.round(Math.min(100, (Math.min(energy.solarKw, energy.homeKw) / Math.max(energy.solarKw, 0.01)) * 100))
      : '--';
    liveStats.autarkie = typeof energy.solarKw === 'number' && typeof energy.homeKw === 'number' && energy.homeKw > 0
      ? Math.max(0, Math.round(Math.min(100, ((energy.homeKw - Math.max(0, energy.gridKw || 0)) / energy.homeKw) * 100)))
      : '--';
    liveStats.savedEur = typeof savings.todayEur === 'number' ? savings.todayEur.toFixed(2) : '--';
    liveStats.feedEur = typeof savings.feedInRevenueEur === 'number' ? savings.feedInRevenueEur.toFixed(2) : '--';
    liveStats.avoidedEur = typeof savings.avoidedCostEur === 'number' ? savings.avoidedCostEur.toFixed(2) : '--';
    liveStats.monthEur = typeof savings.monthEur === 'number' ? Math.round(savings.monthEur) : '--';
    liveStats.dayYield = forecast && forecast.pv && forecast.pv.today && typeof forecast.pv.today.kwhTotal === 'number'
      ? forecast.pv.today.kwhTotal.toFixed(1) : '--';
    updateSlotValues();

    // Devices (Phase 03: empty array, Phase 04 fills this in)
    updateDevices(data.devices || []);

    // Widgets (D-10)
    if (data.forecast) renderForecastWidget(data.forecast);
    if (data.price) renderPriceWidget(data.price);
    if (data.optimizer) renderOptimizerWidget(data.optimizer);

    // Flow animations: hide idle links, reverse direction on discharge/import
    updateFlowState(energy);

    // Also update panel stats so touch-to-open shows live data
    updatePanelStats(data);
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
      { label: 'Eigenverbrauch', val: liveStats.sr === '--' ? '—' : liveStats.sr + '%', delta: '', up: true }
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
    panelData.ev.stats = [
      { label: 'Leistung', val: formatKw(ev.powerKw), delta: ev.mode || '', up: true },
      { label: 'Akku', val: formatPct(ev.socPct), delta: '', up: true },
      { label: 'Modus', val: ev.mode || '—', delta: '', up: true }
    ];
    panelData.grid.stats = [
      { label: 'Gerade', val: formatKw(Math.abs(energy.gridKw || 0)) + (energy.feedingToGrid ? ' ein' : ' bez'), delta: '', up: energy.feedingToGrid },
      { label: 'Bezug jetzt', val: typeof price.importCtKwh === 'number' ? price.importCtKwh.toFixed(1) + ' ct' : '—', delta: typeof price.nowCtKwh === 'number' ? 'EPEX ' + price.nowCtKwh.toFixed(1) + ' ct' : '', up: true },
      { label: 'EPEX min/max heute', val: (typeof price.todayMinCtKwh === 'number' ? price.todayMinCtKwh.toFixed(1) : '—') + ' / ' + (typeof price.todayMaxCtKwh === 'number' ? price.todayMaxCtKwh.toFixed(1) : '—') + ' ct', delta: '', up: true }
    ];
    panelData.forecast.stats = [
      { label: 'Heute', val: forecast.pv && forecast.pv.today ? (forecast.pv.today.kwhTotal || 0).toFixed(1) + ' kWh' : '—', delta: '', up: true },
      { label: 'Morgen', val: forecast.pv && forecast.pv.tomorrow ? (forecast.pv.tomorrow.kwhTotal || 0).toFixed(1) + ' kWh' : '—', delta: '', up: true },
      { label: 'Peak morgen', val: forecast.pv && forecast.pv.tomorrow ? (forecast.pv.tomorrow.peakKw || 0).toFixed(1) + ' kW' : '—', delta: '', up: true }
    ];
    panelData.price.stats = [
      { label: 'Jetzt', val: typeof price.nowCtKwh === 'number' ? price.nowCtKwh.toFixed(1) + ' ct' : '—', delta: '', up: true },
      { label: 'Min heute', val: typeof price.todayMinCtKwh === 'number' ? price.todayMinCtKwh.toFixed(1) + ' ct' : '—', delta: '', up: true },
      { label: 'Max heute', val: typeof price.todayMaxCtKwh === 'number' ? price.todayMaxCtKwh.toFixed(1) + ' ct' : '—', delta: '', up: true }
    ];
    panelData.optimizer.stats = [
      { label: 'Jetzt', val: optimizer.currentActionLabel || optimizer.currentAction || '—', delta: '', up: true },
      { label: 'Als nächstes', val: optimizer.nextActionLabel || '—', delta: '', up: true },
      { label: 'Status', val: optimizer.enabled ? 'Aktiv' : 'Aus', delta: '', up: !!optimizer.enabled }
    ];
  }

  /* ===================== OFFLINE BANNER (D-22) ===================== */
  function showOfflineBanner(sinceTs) {
    var el = document.getElementById('offline-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'offline-banner';
      el.className = 'offline-banner';
      var vp = document.querySelector('.viewport');
      if (vp) vp.appendChild(el); else document.body.appendChild(el);
    }
    if (sinceTs) {
      var minutes = Math.max(0, Math.floor((Date.now() - sinceTs) / 60000));
      el.textContent = 'Keine Verbindung — letztes Update vor ' + minutes + ' min';
    } else {
      el.textContent = 'Keine Verbindung zum DVhub-Server';
    }
    el.style.display = 'block';
  }

  function hideOfflineBanner() {
    var el = document.getElementById('offline-banner');
    if (el) el.style.display = 'none';
  }

  /* ===================== WIDGET RENDERERS (D-10) ===================== */
  var forecastChart = null;

  function renderForecastWidget(forecast) {
    if (!forecast || !forecast.pv || !Array.isArray(forecast.pv.next48h)) return;
    var canvas = document.getElementById('forecast-chart');
    if (!canvas || typeof window.Chart === 'undefined') return;
    var labels = forecast.pv.next48h.map(function (s) {
      var d = new Date(s.ts);
      return String(d.getHours()).padStart(2, '0') + ':00';
    });
    var values = forecast.pv.next48h.map(function (s) { return typeof s.kw === 'number' ? s.kw : 0; });
    // Pitfall 1 — reuse instance to avoid memory leak
    if (forecastChart) {
      forecastChart.data.labels = labels;
      forecastChart.data.datasets[0].data = values;
      forecastChart.update('none');
    } else {
      forecastChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: labels, datasets: [{ data: values, borderColor: '#F7B731', backgroundColor: 'rgba(247,183,49,0.12)', fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: 'rgba(255,255,255,0.3)', maxTicksLimit: 8 } }, y: { ticks: { color: 'rgba(255,255,255,0.3)' }, beginAtZero: true } } }
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

  function renderOptimizerWidget(optimizer) {
    var el = document.getElementById('optimizer-action');
    if (el) el.textContent = optimizer.currentActionLabel || optimizer.currentAction || '—';
    var next = document.getElementById('optimizer-next');
    if (next) next.textContent = optimizer.nextActionLabel || '—';
  }

  /* ===================== VISIBILITY HANDLER (Pitfall 2) ===================== */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      // Reposition paths (layout may have shifted while the tab was hidden)
      // but keep the SMIL timers — rebuilding here would break Chrome's
      // dynamically-inserted animateMotion just like resize used to.
      repositionFlows();
      pollFamilyStatus();
    }
  });

  /* ===================== BOOTSTRAP ===================== */
  pollFamilyStatus();
  setInterval(pollFamilyStatus, POLL_INTERVAL_MS);
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
