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

  function renderTimeline() {
    var host = el('evTimeline');
    if (!host) return;
    var plan = data.plan;
    var slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
    if (!data.optimizeEv || !slots.length || !plan.hasEv) {
      host.innerHTML = '';
      el('evAxisEnd').textContent = '—';
      return;
    }
    var slotMs = (plan.slotMinutes || 15) * 60000;
    var t0 = Date.parse(slots[0].ts);
    var t1 = Date.parse(slots[slots.length - 1].ts) + slotMs;
    var span = Math.max(1, t1 - t0);
    var W = 240; var H = 44; var barH = 30;
    var maxW = data.maxChargeW || 1;
    var x = function (t) { return ((t - t0) / span) * W; };
    var yPct = function (p) { return H - 2 - (Math.max(0, Math.min(100, p)) / 100) * (H - 4); };
    var parts = ['<line class="ev-base" x1="0" y1="' + (H - 0.5) + '" x2="' + W + '" y2="' + (H - 0.5) + '"/>'];
    var socPts = [];
    slots.forEach(function (s) {
      var ts = Date.parse(s.ts);
      if (s.powerW > 0) {
        var h = Math.max(2, (s.powerW / maxW) * barH);
        parts.push('<rect class="ev-bar" x="' + x(ts).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(1, (slotMs / span) * W - 0.6).toFixed(1)
          + '" height="' + h.toFixed(1) + '"><title>' + esc(fmtTime(s.ts) + ' · ' + fmtKw(s.powerW) + (s.socPct != null ? ' · ' + s.socPct + ' %' : '')) + '</title></rect>');
      }
      if (s.socPct != null) socPts.push(x(ts).toFixed(1) + ',' + yPct(s.socPct).toFixed(1));
    });
    var res = data.departure && data.departure.resolved;
    if (res && res.targetSocPct != null) {
      parts.push('<line class="ev-target" x1="0" y1="' + yPct(res.targetSocPct).toFixed(1) + '" x2="' + W + '" y2="' + yPct(res.targetSocPct).toFixed(1) + '"/>');
    }
    if (socPts.length > 1) parts.push('<polyline class="ev-soc" points="' + socPts.join(' ') + '"/>');
    var depMs = res && res.departureAt ? Date.parse(res.departureAt) : NaN;
    if (isFinite(depMs) && depMs >= t0 && depMs <= t1) {
      parts.push('<line class="ev-dep" x1="' + x(depMs).toFixed(1) + '" y1="0" x2="' + x(depMs).toFixed(1) + '" y2="' + H + '"><title>Abfahrt ' + esc(fmtDayTime(res.departureAt)) + '</title></line>');
    }
    // SVG-Attribute statt Inline-Styles: CSP style-src ohne 'unsafe-inline'.
    host.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">' + parts.join('') + '</svg>';
    el('evAxisEnd').textContent = fmtDayTime(new Date(t1).toISOString());
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
    if (e.target.id === 'evSave') { save(); return; }
    if (e.target.id === 'evReset') { setDirty(false); msg(''); draft = draftFromData(); renderForm(); }
  });

  function start() {
    if (!el('evTile')) return;
    load();
    timer = setInterval(function () { if (!document.hidden) load(); }, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.DVhubEvTile = { load: load, stop: function () { clearInterval(timer); } };
})();
