// ev-tile.js -- Leitstand-Kachel "E-Auto": plant das Auto bei EOS mit (an/aus),
// Abfahrt (Uhrzeit + Wochentage) und Ziel bei Abfahrt, dazu der EOS-Ladeplan
// bis zur Abfahrt als Mini-Zeitleiste. Daten: GET /api/ev, Speichern: POST
// /api/ev (fasst nur optimizer.eosOptimizeEv + die Abfahrtsfelder an).
(function () {
  'use strict';

  var DAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  var UNITS = { percent: '%', kwh: 'kWh', km: 'km' };
  var POLL_MS = 60000;

  var data = null;      // letzte Antwort von GET /api/ev
  var draft = null;     // Bearbeitungsstand { enabled, time, days[], targetValue }
  var dirty = false;
  var timer = null;

  // Markup der Kachel (Leitstand + Family-Panel teilen es; mount() füllt den Host).
  var TEMPLATE = [
    "  <div class=\"rail-card-head\">",
    "    <span class=\"ttl\"><span class=\"dot dot-ev\"></span><span id=\"evTitle\">E-Auto</span></span>",
    "    <label class=\"ev-plan-toggle\" title=\"EOS plant das Laden des Autos mit (Ladefenster nach Preis und PV, Ziel bis zur Abfahrt). Aus: das Auto steckt nur in der Lastprognose.\">",
    "      <span class=\"ev-plan-toggle-l\">Plant mit</span>",
    "      <span class=\"switch\"><input type=\"checkbox\" id=\"evOptimize\"><span class=\"track\"></span><span class=\"thumb\"></span></span>",
    "    </label>",
    "  </div>",
    "  <div class=\"rail-big card-value value-ev\"><span id=\"evSocNow\">&mdash;</span><span class=\"ev-soc-arrow\">&rarr;</span><span id=\"evSocTarget\">&mdash;</span></div>",
    "  <div class=\"ev-state\" id=\"evState\">&mdash;</div>",
    "  <div class=\"ev-timeline\" id=\"evTimeline\" aria-label=\"EOS-Ladeplan\" title=\"Mausrad: Zeit verschieben &middot; Strg + Mausrad: zoomen &middot; Doppelklick: zur&uuml;ck auf jetzt\"></div>",
    "  <div class=\"ev-timeline-axis\"><span id=\"evAxisStart\">jetzt</span><span id=\"evAxisEnd\">&mdash;</span></div>",
    "  <div class=\"ev-steps\" id=\"evSteps\" aria-label=\"EOS-Ladestufen\" hidden></div>",
    "  <div class=\"rail-row ev-edit-row\" title=\"An: EOS plant das Auto nur, solange es an der Wallbox steckt (evcc). Anstecken/Abziehen l&ouml;st sofort einen Neuplan aus &mdash; ohne Auto h&auml;lt EOS keine Energie daf&uuml;r zur&uuml;ck. Aus: EOS plant das Auto immer mit.\">",
    "    <span class=\"l\">Nur angesteckt planen</span>",
    "    <span class=\"switch switch-sm\"><input type=\"checkbox\" id=\"evOnlyPlugged\" aria-label=\"Nur angesteckt planen\"><span class=\"track\"></span><span class=\"thumb\"></span></span>",
    "  </div>",
    "  <div class=\"rail-row ev-edit-row\">",
    "    <span class=\"l\">Abfahrt</span>",
    "    <span class=\"ev-inline\">",
    "      <span class=\"switch switch-sm\"><input type=\"checkbox\" id=\"evDepEnabled\" aria-label=\"Abfahrtszeit ber&uuml;cksichtigen\"><span class=\"track\"></span><span class=\"thumb\"></span></span>",
    "      <input type=\"time\" class=\"input mono ev-time\" id=\"evDepTime\" step=\"300\" aria-label=\"Abfahrt um\">",
    "    </span>",
    "  </div>",
    "  <div class=\"ev-days\" id=\"evDays\" role=\"group\" aria-label=\"Wochentage\"></div>",
    "  <div class=\"rail-row ev-edit-row\">",
    "    <span class=\"l\">Ziel bei Abfahrt</span>",
    "    <span class=\"ev-inline\">",
    "      <input type=\"number\" class=\"input mono ev-target\" id=\"evTarget\" min=\"0\" max=\"100\" step=\"5\" aria-label=\"Ziel bei Abfahrt\">",
    "      <span class=\"ev-unit\" id=\"evTargetUnit\">%</span>",
    "    </span>",
    "  </div>",
    "  <div class=\"rail-row\"><span class=\"l\">Plan</span><strong class=\"v\" id=\"evPlanSummary\">&mdash;</strong></div>",
    "  <div class=\"ev-actions\" id=\"evActions\" hidden>",
    "    <button type=\"button\" class=\"btn sm ghost\" id=\"evReset\">Verwerfen</button>",
    "    <button type=\"button\" class=\"btn primary sm\" id=\"evSave\">&Uuml;bernehmen</button>",
    "  </div>",
    "  <div class=\"ev-msg\" id=\"evMsg\" hidden></div>",
    ""
  ].join('\n');

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function apiFetch(path, opts) {
    var common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }
  function tz() { return (data && data.departure && data.departure.resolved && data.departure.resolved.timeZone) || 'Europe/Berlin'; }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('de-DE', { timeZone: tz(), hour: '2-digit', minute: '2-digit' });
  }
  function fmtDayTime(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('de-DE', { timeZone: tz(), weekday: 'short' }) + ' ' + fmtTime(iso);
  }
  function fmtKw(w) { return (w / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' kW'; }
  function fmtNum(v, digits) { return Number(v).toLocaleString('de-DE', { maximumFractionDigits: digits || 0 }); }

  function msg(text, isError) {
    var m = el('evMsg');
    if (!m) return;
    m.hidden = !text;
    m.textContent = text || '';
    m.classList.toggle('is-error', !!isError);
  }

  function draftFromData() {
    var d = data.departure || {};
    return {
      enabled: d.enabled === true,
      time: d.time || '07:00',
      days: Array.isArray(d.days) ? d.days.slice() : [1, 2, 3, 4, 5],
      targetValue: d.targetValue
    };
  }

  function setDirty(v) {
    dirty = v;
    var a = el('evActions');
    if (a) a.hidden = !v;
  }

  // ---------------------------------------------------------------- Anzeige

  // Sichtfenster des Charts: Mausrad verschiebt, Strg/⌘ + Mausrad zoomt.
  // startMs null = folgt „jetzt“ (bis jemand scrollt).
  var HOUR = 3600000;
  var view = { startMs: null, spanMs: 6 * HOUR };
  var VIEW_MIN = 2 * HOUR;
  var VIEW_MAX = 48 * HOUR;
  var bounds = null;    // { t0, t1, slotMs } des aktuellen Plans

  function clampView() {
    if (!bounds) return;
    var total = bounds.t1 - bounds.t0;
    view.spanMs = Math.max(VIEW_MIN, Math.min(VIEW_MAX, total, view.spanMs));
    if (view.startMs == null) return;
    view.startMs = Math.max(bounds.t0, Math.min(bounds.t1 - view.spanMs, view.startMs));
  }
  function viewStart() {
    if (!bounds) return 0;
    if (view.startMs != null) return view.startMs;
    // Folgt „jetzt“: laufender Slot links, eine Viertelstunde Vorlauf.
    var now = Date.now() - bounds.slotMs;
    return Math.max(bounds.t0, Math.min(bounds.t1 - view.spanMs, now));
  }

  function renderTimeline() {
    var host = el('evTimeline');
    if (!host) return;
    var plan = data.plan;
    var slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
    if (!data.optimizeEv || !slots.length || !plan.hasEv) {
      host.innerHTML = '';
      bounds = null;
      el('evAxisStart').textContent = 'jetzt';
      el('evAxisEnd').textContent = '—';
      return;
    }
    var slotMs = (plan.slotMinutes || 15) * 60000;
    bounds = { t0: Date.parse(slots[0].ts), t1: Date.parse(slots[slots.length - 1].ts) + slotMs, slotMs: slotMs };
    clampView();
    var v0 = viewStart();
    var v1 = v0 + view.spanMs;
    var W = 240; var H = 44; var barH = 30;
    var maxW = data.maxChargeW || 1;
    var x = function (t) { return ((t - v0) / view.spanMs) * W; };
    var yPct = function (p) { return H - 2 - (Math.max(0, Math.min(100, p)) / 100) * (H - 4); };
    var parts = ['<line class="ev-base" x1="0" y1="' + (H - 0.5) + '" x2="' + W + '" y2="' + (H - 0.5) + '"/>'];
    var socPts = [];
    // Volle Stunden als feine Raster-Linien, damit man beim Scrollen die Zeit sieht.
    for (var hr = Math.ceil(v0 / HOUR) * HOUR; hr < v1; hr += HOUR) {
      parts.push('<line class="ev-grid" x1="' + x(hr).toFixed(1) + '" y1="0" x2="' + x(hr).toFixed(1) + '" y2="' + H + '"/>');
    }
    slots.forEach(function (s) {
      var ts = Date.parse(s.ts);
      if (ts + slotMs < v0 - slotMs || ts > v1 + slotMs) return;
      if (s.powerW > 0) {
        var h = Math.max(2, (s.powerW / maxW) * barH);
        parts.push('<rect class="ev-bar" x="' + x(ts).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(1, (slotMs / view.spanMs) * W - 0.6).toFixed(1)
          + '" height="' + h.toFixed(1) + '"><title>' + esc(fmtTime(s.ts) + ' · ' + fmtKw(s.powerW) + (s.socPct != null ? ' · ' + s.socPct + ' %' : '')) + '</title></rect>');
      }
      if (s.socPct != null) socPts.push(x(ts).toFixed(1) + ',' + yPct(s.socPct).toFixed(1));
    });
    var res = data.departure && data.departure.resolved;
    if (res && res.targetSocPct != null) {
      parts.push('<line class="ev-target" x1="0" y1="' + yPct(res.targetSocPct).toFixed(1) + '" x2="' + W + '" y2="' + yPct(res.targetSocPct).toFixed(1) + '"/>');
    }
    if (socPts.length > 1) parts.push('<polyline class="ev-soc" points="' + socPts.join(' ') + '"/>');
    var nowMs = Date.now();
    if (nowMs >= v0 && nowMs <= v1) parts.push('<line class="ev-now" x1="' + x(nowMs).toFixed(1) + '" y1="0" x2="' + x(nowMs).toFixed(1) + '" y2="' + H + '"><title>jetzt</title></line>');
    var depMs = res && res.departureAt ? Date.parse(res.departureAt) : NaN;
    if (isFinite(depMs) && depMs >= v0 && depMs <= v1) {
      parts.push('<line class="ev-dep" x1="' + x(depMs).toFixed(1) + '" y1="0" x2="' + x(depMs).toFixed(1) + '" y2="' + H + '"><title>Abfahrt ' + esc(fmtDayTime(res.departureAt)) + '</title></line>');
    }
    // SVG-Attribute statt Inline-Styles: CSP style-src ohne 'unsafe-inline'.
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">' + parts.join('') + '</svg>';
    el('evAxisStart').textContent = (nowMs >= v0 && nowMs < v0 + slotMs * 2) ? 'jetzt' : fmtDayTime(new Date(v0).toISOString());
    el('evAxisEnd').textContent = fmtDayTime(new Date(v1).toISOString());
  }

  // EOS-Ladestufen: aufeinanderfolgende Slots gleicher Leistung zusammengefasst,
  // z. B. „20:45–21:15 11 kW · 21:15–21:30 3,3 kW“. Laufende Stufe markiert.
  function evSteps(slots, slotMs) {
    var steps = [];
    slots.forEach(function (s) {
      var ts = Date.parse(s.ts);
      var w = s.powerW > 0 ? s.powerW : 0;
      var last = steps[steps.length - 1];
      if (last && last.powerW === w && last.end === ts) { last.end = ts + slotMs; last.socEnd = s.socPct; return; }
      steps.push({ start: ts, end: ts + slotMs, powerW: w, socEnd: s.socPct });
    });
    return steps.filter(function (st) { return st.powerW > 0; });
  }

  var stepsOpen = false;   // Ladestufen aufgeklappt (bleibt über Aktualisierungen)

  function renderSteps() {
    var host = el('evSteps');
    if (!host) return;
    var plan = data.plan;
    var slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
    if (!data.optimizeEv || !plan || !plan.hasEv || !slots.length) { host.hidden = true; host.innerHTML = ''; return; }
    var now = Date.now();
    var steps = evSteps(slots, (plan.slotMinutes || 15) * 60000).filter(function (st) { return st.end > now; });
    host.hidden = false;
    if (!steps.length) { host.innerHTML = '<div class="ev-step is-none">EOS plant keine weitere Ladung</div>'; return; }
    var row = function (st) {
      var cur = st.start <= now && now < st.end;
      return '<div class="ev-step' + (cur ? ' is-now' : '') + '">'
        + '<span class="ev-step-t">' + (cur ? 'jetzt' : esc(fmtTime(new Date(st.start).toISOString()))) + '–' + esc(fmtTime(new Date(st.end).toISOString())) + '</span>'
        + '<span class="ev-step-w">' + esc(fmtKw(st.powerW)) + '</span>'
        + '<span class="ev-step-s">' + (st.socEnd != null ? '→ ' + st.socEnd + ' %' : '') + '</span>'
        + '</div>';
    };
    // Laufende bzw. nächste Stufe immer sichtbar, der Rest zum Aufklappen.
    var rest = steps.slice(1);
    var toggle = '<button type="button" class="ev-steps-toggle" id="evStepsToggle" aria-expanded="' + stepsOpen + '">'
      + (stepsOpen ? 'weniger' : '+ ' + rest.length + ' weitere Stufe' + (rest.length === 1 ? '' : 'n')) + '</button>';
    host.innerHTML = row(steps[0])
      + (stepsOpen && rest.length ? '<div class="ev-steps-more">' + rest.map(row).join('') + '</div>' : '')
      + (rest.length ? toggle : '');
  }

  function wireTimelineWheel() {
    var host = el('evTimeline');
    if (!host || host.dataset.wheelWired === '1') return;
    host.dataset.wheelWired = '1';
    host.addEventListener('wheel', function (e) {
      if (!bounds || !data) return;
      e.preventDefault();
      var start = viewStart();
      var delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      if (e.ctrlKey || e.metaKey) {
        // Zoom um die Mausposition.
        var rect = host.getBoundingClientRect();
        var frac = rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
        var anchor = start + frac * view.spanMs;
        view.spanMs = Math.max(VIEW_MIN, Math.min(VIEW_MAX, view.spanMs * (delta > 0 ? 1.25 : 0.8)));
        view.startMs = anchor - frac * view.spanMs;
      } else {
        var step = Math.max(bounds.slotMs, view.spanMs / 8);
        view.startMs = start + (delta > 0 ? step : -step);
      }
      clampView();
      renderTimeline();
    }, { passive: false });
    // Doppelklick: zurück auf „jetzt“, 6 h.
    host.addEventListener('dblclick', function () {
      view.startMs = null; view.spanMs = 6 * HOUR;
      if (data) renderTimeline();
    });
  }

  function renderSummary() {
    var out = el('evPlanSummary');
    if (!out) return;
    out.className = 'v';
    var res = data.departure && data.departure.resolved;
    if (!data.optimizeEv) { out.textContent = 'EOS plant das Auto nicht'; out.classList.add('dim'); return; }
    if (data.vehicle && data.vehicle.registered === false) {
      if (data.onlyWhenPlugged && data.vehicle.plugged !== true) {
        // Gewollt: ohne Auto an der Wallbox plant EOS ohne Auto.
        out.textContent = 'wartet aufs Anstecken';
        out.title = 'EOS plant gerade ohne Auto und hält keine Energie dafür zurück. Beim Anstecken meldet DVhub das Auto an und EOS plant sofort neu (1–5 min).';
        out.classList.add('dim');
        return;
      }
      out.textContent = 'nicht bei EOS: ' + (data.vehicle.registrationReason || 'kein Ladestand');
      out.classList.add('warn');
      return;
    }
    var plan = data.plan;
    if (!plan || !plan.hasEv) { out.textContent = data.planError ? ('kein Plan: ' + data.planError) : 'noch kein EOS-Plan'; out.classList.add('dim'); return; }
    var parts = [];
    parts.push(fmtNum(plan.energyKwh, 1) + ' kWh');
    if (res && res.departureAt && res.targetSocPct != null) {
      if (plan.targetReachedAt) {
        parts.push(res.targetSocPct + ' % ab ' + fmtTime(plan.targetReachedAt));
        out.classList.add('ok');
      } else if (plan.socAtDeparture != null) {
        parts.push('nur ' + plan.socAtDeparture + ' % bei Abfahrt');
        out.classList.add('warn');
      }
    }
    out.textContent = parts.join(' · ');
    var w = (plan.windows || []).map(function (x) { return fmtTime(x.start) + '–' + fmtTime(x.end) + ' ' + fmtKw(x.maxW) + ' (' + fmtNum(x.kwh, 1) + ' kWh)'; });
    out.title = w.length ? 'Ladefenster bis zur Abfahrt:\n' + w.join('\n') : 'Bis zur Abfahrt plant EOS keine Ladung.';
  }

  function renderState() {
    var v = data.vehicle || {};
    var st = el('evState');
    var parts = [];
    if (v.connected === true) parts.push(v.charging ? ('lädt' + (v.chargePowerW ? ' mit ' + fmtKw(v.chargePowerW) : '')) : 'angesteckt');
    else if (v.connected === false) parts.push('nicht angesteckt');
    var res = data.departure && data.departure.resolved;
    if (res && res.departureAt) parts.push('Abfahrt ' + fmtDayTime(res.departureAt) + (res.source === 'once' ? ' (einmalig)' : ''));
    else if (data.departure && data.departure.enabled === false) parts.push('ohne Abfahrtszeit');
    if (data.departure && data.departure.enabled && data.departure.deadlineSupported === false) parts.push('EOS kennt die Uhrzeit erst ab 0.4');
    st.textContent = parts.join(' · ') || '—';
    st.classList.toggle('is-charging', v.charging === true);
  }

  function renderForm() {
    var mode = (data.departure && data.departure.targetMode) || 'percent';
    el('evDepEnabled').checked = !!draft.enabled;
    el('evDepTime').value = draft.time;
    el('evDepTime').disabled = !draft.enabled;
    el('evTarget').value = draft.targetValue != null ? draft.targetValue : '';
    el('evTarget').max = mode === 'percent' ? 100 : 2000;
    el('evTarget').step = mode === 'percent' ? 5 : 1;
    el('evTargetUnit').textContent = UNITS[mode] || '%';
    el('evDays').innerHTML = DAY_LABELS.map(function (lbl, i) {
      var day = i + 1;
      var on = draft.days.indexOf(day) >= 0;
      return '<button type="button" class="ev-day" data-day="' + day + '" aria-pressed="' + on + '"' + (draft.enabled ? '' : ' disabled') + '>' + lbl + '</button>';
    }).join('');
  }

  function render() {
    var tile = el('evTile');
    if (!tile || !data) return;
    tile.hidden = false;
    var v = data.vehicle || {};
    el('evTitle').textContent = 'E-Auto' + (v.title ? ' · ' + v.title : '');
    el('evOptimize').checked = !!data.optimizeEv;
    el('evOnlyPlugged').checked = data.onlyWhenPlugged !== false;
    el('evOnlyPlugged').disabled = !data.optimizeEv;
    tile.classList.toggle('is-off', !data.optimizeEv);
    el('evSocNow').textContent = v.socPct != null ? v.socPct + ' %' : '—';
    var res = data.departure && data.departure.resolved;
    var mode = (data.departure && data.departure.targetMode) || 'percent';
    var tgt = res && res.targetSocPct != null ? res.targetSocPct + ' %' : '—';
    if (mode !== 'percent' && data.departure.targetValue != null) tgt += ' (' + fmtNum(data.departure.targetValue) + ' ' + UNITS[mode] + ')';
    el('evSocTarget').textContent = tgt;
    el('evSocNow').title = v.socSource ? 'Quelle: ' + v.socSource + (v.rangeKm > 0 ? ' · ' + v.rangeKm + ' km' : '') : '';
    renderState();
    renderTimeline();
    renderSteps();
    renderSummary();
    if (!dirty) { draft = draftFromData(); renderForm(); }
  }

  // ---------------------------------------------------------------- Daten

  async function load() {
    try {
      var res = await apiFetch('/api/ev');
      if (!res.ok) { if (res.status === 404) el('evTile').hidden = true; return; }
      var body = await res.json();
      if (!body || !body.ok) return;
      data = body;
      try { document.dispatchEvent(new CustomEvent('dvhub:ev-data', { detail: body })); } catch (_) { /* alte Browser */ }
      // Kein Auto eingerichtet (EOS-Planung aus, keine Abfahrt, kein Ladepunkt): Kachel bleibt weg.
      var any = body.optimizeEv || (body.departure && body.departure.enabled) || (body.vehicle && body.vehicle.connected !== null);
      if (!any) { el('evTile').hidden = true; return; }
      render();
    } catch (_) { /* naechster Takt */ }
  }

  async function post(payload, okText) {
    msg('Speichere …');
    try {
      var res = await apiFetch('/api/ev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      var body = {};
      try { body = await res.json(); } catch (_) { /* leer */ }
      if (!res.ok || !body.ok) { msg('Nicht gespeichert: ' + (body.error || ('HTTP ' + res.status)), true); return false; }
      msg(okText);
      setTimeout(function () { msg(''); }, 4000);
      return true;
    } catch (e) {
      msg('Nicht gespeichert: ' + e.message, true);
      return false;
    }
  }

  async function toggleOptimize(on) {
    var ok = await post({ optimizeEv: on }, on ? 'EOS plant das Auto jetzt mit — der neue Plan kommt mit dem nächsten EOS-Lauf.' : 'EOS plant das Auto nicht mehr.');
    if (!ok) el('evOptimize').checked = !on;
    load();
  }

  async function toggleOnlyPlugged(on) {
    var ok = await post({ onlyWhenPlugged: on }, on
      ? 'EOS plant das Auto nur noch, wenn es angesteckt ist.'
      : 'EOS plant das Auto immer mit, auch ohne Stecker.');
    if (!ok) el('evOnlyPlugged').checked = !on;
    load();
  }

  async function save() {
    var mode = (data.departure && data.departure.targetMode) || 'percent';
    var tv = Number(el('evTarget').value);
    if (!isFinite(tv) || tv < 0 || (mode === 'percent' && tv > 100)) { msg('Ziel: ' + (mode === 'percent' ? '0–100 %' : 'Zahl ≥ 0'), true); return; }
    if (draft.enabled && !draft.days.length) { msg('Mindestens einen Wochentag wählen.', true); return; }
    var ok = await post({ departure: { enabled: draft.enabled, time: el('evDepTime').value || draft.time, days: draft.days, targetValue: tv } },
      'Übernommen — EOS rechnet mit der neuen Abfahrt.');
    if (ok) { setDirty(false); load(); }
  }

  // ---------------------------------------------------------------- Ereignisse

  document.addEventListener('change', function (e) {
    if (!data) return;
    if (e.target.id === 'evOptimize') { toggleOptimize(e.target.checked); return; }
    if (e.target.id === 'evOnlyPlugged') { toggleOnlyPlugged(e.target.checked); return; }
    if (e.target.id === 'evDepEnabled') { draft.enabled = e.target.checked; renderForm(); setDirty(true); return; }
    if (e.target.id === 'evDepTime') { draft.time = e.target.value; setDirty(true); return; }
    if (e.target.id === 'evTarget') { draft.targetValue = e.target.value; setDirty(true); }
  });
  document.addEventListener('input', function (e) {
    if (!data) return;
    if (e.target.id === 'evTarget' || e.target.id === 'evDepTime') setDirty(true);
  });
  document.addEventListener('click', function (e) {
    if (!data) return;
    var dayBtn = e.target.closest && e.target.closest('.ev-day');
    if (dayBtn && !dayBtn.disabled) {
      var day = Number(dayBtn.getAttribute('data-day'));
      var i = draft.days.indexOf(day);
      if (i >= 0) draft.days.splice(i, 1); else draft.days.push(day);
      draft.days.sort();
      dayBtn.setAttribute('aria-pressed', String(i < 0));
      setDirty(true);
      return;
    }
    if (e.target.id === 'evStepsToggle') { stepsOpen = !stepsOpen; renderSteps(); return; }
    if (e.target.id === 'evSave') { save(); return; }
    if (e.target.id === 'evReset') { setDirty(false); msg(''); draft = draftFromData(); renderForm(); }
  });

  // Host (#evTile) mit dem Kachel-Markup füllen und Abfrage starten. Der
  // Leitstand hat den Host fest im HTML, die Family-Ansicht legt ihn beim
  // Öffnen des E-Auto-Panels an und ruft mount() erneut auf.
  function mount(host) {
    host = host || el('evTile');
    if (!host) return;
    if (!host.firstElementChild) {
      host.innerHTML = TEMPLATE;
      draft = null; setDirty(false);
    }
    wireTimelineWheel();
    if (!timer) {
      timer = setInterval(function () { if (!document.hidden && el('evTile')) load(); }, POLL_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden && el('evTile')) load(); });
    }
    return load();
  }
  function start() { if (el('evTile')) mount(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.DVhubEvTile = { load: load, mount: mount, stop: function () { clearInterval(timer); timer = null; } };
})();
