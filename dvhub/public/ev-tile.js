// ev-tile.js -- Leitstand-Kachel "E-Auto": plant das Auto bei EOS mit (an/aus),
// Wochenplan (Ankunft + Abfahrt je Tag, ev-weekly-editor.js), Ziel bei
// Abfahrt, das naechste Fenster mit dem erwarteten Ladestand bei Ankunft und
// der EOS-Ladeplan im Fenster als Mini-Zeitleiste. Daten: GET /api/ev,
// Speichern: POST /api/ev (fasst nur optimizer.eosOptimizeEv + die
// Abfahrtsfelder an). Markenneutral — der Ladestand kommt aus der Quelle, die
// unter Einstellungen gewaehlt ist.
(function () {
  'use strict';

  const UNITS = { percent: '%', kwh: 'kWh', km: 'km' };
  const POLL_MS = 60000;

  let data = null;      // letzte Antwort von GET /api/ev
  let draft = null;     // Bearbeitungsstand { enabled, weeklyPlan[], targetValue, commuteKm, arrivalOnce, once }
  let weekOpen = false; // Wochenplan-Editor aufgeklappt
  let dirty = false;
  let timer = null;
  let boostTouched = false;  // kW-Feld von Hand geändert — Takt überschreibt es nicht

  // Markup der Kachel (Leitstand + Family-Panel teilen es; mount() füllt den Host).
  const TEMPLATE = [
    "  <div class=\"rail-card-head\">",
    "    <span class=\"ttl\"><span class=\"dot dot-ev\"></span><span id=\"evTitle\">E-Auto</span></span>",
    "    <label class=\"ev-plan-toggle\" title=\"EOS plant das Laden des Autos mit (Ladefenster nach Preis und PV, Ziel bis zur Abfahrt). Aus: das Auto steckt nur in der Lastprognose.\">",
    "      <span class=\"ev-plan-toggle-l\">Plant mit</span>",
    "      <span class=\"switch\"><input type=\"checkbox\" id=\"evOptimize\"><span class=\"track\"></span><span class=\"thumb\"></span></span>",
    "    </label>",
    "  </div>",
    "  <div class=\"rail-big card-value value-ev\"><span id=\"evSocNow\">&mdash;</span><span class=\"ev-soc-arrow\">&rarr;</span><span id=\"evSocTarget\">&mdash;</span></div>",
    "  <div class=\"ev-state\" id=\"evState\">&mdash;</div>",
    "  <div class=\"ev-window\" id=\"evWindow\" hidden>&mdash;</div>",
    "  <div class=\"ev-boost\" id=\"evBoost\" hidden title=\"Jetzt laden, egal was EOS plant &mdash; auch wenn EOS nicht l&auml;uft. Endet zur gew&auml;hlten Zeit, beim Abstecken oder mit Beenden; danach gilt wieder der EOS-Plan.\">",
    "    <div class=\"ev-boost-idle\" id=\"evBoostIdle\">",
    "      <span class=\"l\">Sofort laden</span>",
    "      <span class=\"ev-inline\">",
    "        <input type=\"number\" class=\"input mono ev-boost-kw\" id=\"evBoostKw\" step=\"0.5\" aria-label=\"Ladeleistung in kW\">",
    "        <span class=\"ev-unit\">kW</span>",
    "        <select class=\"input mono ev-boost-for\" id=\"evBoostFor\" aria-label=\"Wie lange\">",
    "          <option value=\"\">bis Abstecken</option><option value=\"60\">1 h</option><option value=\"120\">2 h</option><option value=\"240\">4 h</option><option value=\"480\">8 h</option>",
    "        </select>",
    "        <button type=\"button\" class=\"btn primary sm\" id=\"evBoostStart\">Jetzt laden</button>",
    "        <button type=\"button\" class=\"btn sm ghost\" id=\"evStopStart\" title=\"Die Wallbox l&auml;dt nicht, egal was EOS plant &mdash; auch im Not-Halt. Endet zur gew&auml;hlten Zeit, beim Abstecken oder mit Beenden.\">Laden stoppen</button>",
    "      </span>",
    "    </div>",
    "    <div class=\"ev-boost-active\" id=\"evBoostActive\" hidden>",
    "      <span class=\"ev-boost-text\" id=\"evBoostText\">&mdash;</span>",
    "      <button type=\"button\" class=\"btn sm ghost\" id=\"evBoostStop\">Beenden</button>",
    "    </div>",
    "  </div>",
    "  <div class=\"ev-timeline\" id=\"evTimeline\" aria-label=\"EOS-Ladeplan\" title=\"Mausrad: Zeit verschieben &middot; Strg + Mausrad: zoomen &middot; Doppelklick: zur&uuml;ck auf jetzt\"></div>",
    "  <div class=\"ev-timeline-axis\"><span id=\"evAxisStart\">jetzt</span><span id=\"evAxisEnd\">&mdash;</span></div>",
    "  <div class=\"rail-row ev-plan-row\"><span class=\"l\">Plan</span><strong class=\"v\" id=\"evPlanSummary\">&mdash;</strong></div>",
    "  <div class=\"ev-steps\" id=\"evSteps\" aria-label=\"EOS-Ladestufen\" hidden></div>",
    "  <div class=\"rail-row ev-edit-row\" title=\"An: EOS plant das Auto nur, solange es an der Wallbox steckt. Anstecken/Abziehen l&ouml;st sofort einen Neuplan aus &mdash; ohne Auto h&auml;lt EOS keine Energie daf&uuml;r zur&uuml;ck. Aus: EOS plant das Auto immer mit.\">",
    "    <span class=\"l\">Nur angesteckt planen</span>",
    "    <span class=\"switch switch-sm\"><input type=\"checkbox\" id=\"evOnlyPlugged\" aria-label=\"Nur angesteckt planen\"><span class=\"track\"></span><span class=\"thumb\"></span></span>",
    "  </div>",
    "  <div class=\"rail-row ev-edit-row\" title=\"Je Wochentag Ankunft (Anstecken), Abfahrt und Ziel. Mit Ankunft kann EOS das Laden schon vorher einplanen, wenn EOS einen Ladestart kennt.\">",
    "    <span class=\"l\">Wochenplan</span>",
    "    <span class=\"ev-inline\">",
    "      <span class=\"switch switch-sm\"><input type=\"checkbox\" id=\"evDepEnabled\" aria-label=\"Wochenplan ber&uuml;cksichtigen\"><span class=\"track\"></span><span class=\"thumb\"></span></span>",
    "      <button type=\"button\" class=\"btn sm ghost\" id=\"evWeekToggle\" aria-expanded=\"false\" aria-controls=\"evWeekly\">Bearbeiten</button>",
    "    </span>",
    "  </div>",
    "  <div class=\"ev-weekly\" id=\"evWeekly\" hidden>",
    "    <div id=\"evWeeklyGrid\"></div>",
    "    <div class=\"ev-weekly-extra\">",
    "      <label class=\"ev-field\"><span>Heimweg (km)</span><input type=\"number\" class=\"input mono\" id=\"evCommuteKm\" min=\"0\" max=\"1000\" step=\"1\" title=\"So weit f&auml;hrt das Auto noch, bevor es ansteckt &mdash; davon h&auml;ngt der erwartete Ladestand bei Ankunft ab.\"></label>",
    "      <label class=\"ev-field\"><span>Nur n&auml;chste Ankunft</span><input type=\"datetime-local\" class=\"input mono\" id=\"evArrOnce\"></label>",
    "      <label class=\"ev-field\"><span>Nur n&auml;chste Abfahrt</span><input type=\"datetime-local\" class=\"input mono\" id=\"evDepOnce\"></label>",
    "    </div>",
    "  </div>",
    "  <div class=\"rail-row ev-edit-row\">",
    "    <span class=\"l\">Ziel bei Abfahrt</span>",
    "    <span class=\"ev-inline\">",
    "      <input type=\"number\" class=\"input mono ev-target\" id=\"evTarget\" min=\"0\" max=\"100\" step=\"5\" aria-label=\"Ziel bei Abfahrt\">",
    "      <span class=\"ev-unit\" id=\"evTargetUnit\">%</span>",
    "    </span>",
    "  </div>",
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
    const common = window.DVhubCommon;
    if (common && typeof common.apiFetch === 'function') return common.apiFetch(path, opts);
    return fetch(path, opts);
  }
  function tz() { return (data && data.departure && data.departure.resolved && data.departure.resolved.timeZone) || 'Europe/Berlin'; }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString('de-DE', { timeZone: tz(), hour: '2-digit', minute: '2-digit' });
  }
  function fmtDayTime(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE', { timeZone: tz(), weekday: 'short' }) + ' ' + fmtTime(iso);
  }
  // „heute 20:00“, „morgen 05:00“, sonst „Sa 09:00“ — in DVhubs Zeitzone.
  function fmtRelDay(iso) {
    const opts = { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' };
    const day = new Date(iso).toLocaleDateString('de-DE', opts);
    const now = Date.now();
    if (day === new Date(now).toLocaleDateString('de-DE', opts)) return 'heute ' + fmtTime(iso);
    if (day === new Date(now + 86400000).toLocaleDateString('de-DE', opts)) return 'morgen ' + fmtTime(iso);
    return fmtDayTime(iso);
  }
  // datetime-local (Ortszeit des Browsers) <-> ISO
  function toLocalInput(iso) {
    const d = new Date(iso || '');
    if (!iso || isNaN(d)) return '';
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fromLocalInput(v) { return v ? new Date(v).toISOString() : ''; }
  const SOURCE_NAMES = { teslamate: 'TeslaMate', evcc: 'evcc', evccvehicle: 'Fahrzeugtreiber', mqtt: 'MQTT', http: 'HTTP-Abruf', homeassistant: 'Home Assistant' };
  function sourceName(src) { return SOURCE_NAMES[src] || (src ? 'Wallbox' : '—'); }
  function fmtKw(w) { return (w / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' kW'; }
  function fmtNum(v, digits) { return Number(v).toLocaleString('de-DE', { maximumFractionDigits: digits || 0 }); }

  function msg(text, isError) {
    const m = el('evMsg');
    if (!m) return;
    m.hidden = !text;
    m.textContent = text || '';
    m.classList.toggle('is-error', !!isError);
  }

  function draftFromData() {
    const d = data.departure || {};
    return {
      enabled: d.enabled === true,
      weeklyPlan: Array.isArray(d.weeklyPlan) ? d.weeklyPlan : [],
      targetValue: d.targetValue,
      commuteKm: d.commuteKm != null ? d.commuteKm : 0,
      arrivalOnce: d.arrivalOnce || '',
      once: d.once || ''
    };
  }

  function setDirty(v) {
    dirty = v;
    const a = el('evActions');
    if (a) a.hidden = !v;
  }

  // ---------------------------------------------------------------- Anzeige

  // Sichtfenster des Charts: Mausrad verschiebt, Strg/⌘ + Mausrad zoomt.
  // startMs null = folgt „jetzt“ (bis jemand scrollt).
  const HOUR = 3600000;
  const view = { startMs: null, spanMs: 6 * HOUR };
  const VIEW_MIN = 2 * HOUR;
  const VIEW_MAX = 48 * HOUR;
  let bounds = null;    // { t0, t1, slotMs } des aktuellen Plans

  function clampView() {
    if (!bounds) return;
    const total = bounds.t1 - bounds.t0;
    view.spanMs = Math.max(VIEW_MIN, Math.min(VIEW_MAX, total, view.spanMs));
    if (view.startMs == null) return;
    view.startMs = Math.max(bounds.t0, Math.min(bounds.t1 - view.spanMs, view.startMs));
  }
  function viewStart() {
    if (!bounds) return 0;
    if (view.startMs != null) return view.startMs;
    // Folgt „jetzt“: laufender Slot links, eine Viertelstunde Vorlauf.
    const now = Date.now() - bounds.slotMs;
    return Math.max(bounds.t0, Math.min(bounds.t1 - view.spanMs, now));
  }

  function renderTimeline() {
    const host = el('evTimeline');
    if (!host) return;
    const plan = data.plan;
    const slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
    if (!data.optimizeEv || !slots.length || !plan.hasEv) {
      host.innerHTML = '';
      bounds = null;
      el('evAxisStart').textContent = 'jetzt';
      el('evAxisEnd').textContent = '—';
      // Ohne Ladeplan bliebe hier eine leere Fläche stehen.
      host.hidden = true;
      if (el('evAxisStart').parentElement) el('evAxisStart').parentElement.hidden = true;
      return;
    }
    host.hidden = false;
    if (el('evAxisStart').parentElement) el('evAxisStart').parentElement.hidden = false;
    const slotMs = (plan.slotMinutes || 15) * 60000;
    bounds = { t0: Date.parse(slots[0].ts), t1: Date.parse(slots[slots.length - 1].ts) + slotMs, slotMs: slotMs };
    clampView();
    const v0 = viewStart();
    const v1 = v0 + view.spanMs;
    const W = 240; const H = 44; const barH = 30;
    const maxW = data.maxChargeW || 1;
    const x = function (t) { return ((t - v0) / view.spanMs) * W; };
    const yPct = function (p) { return H - 2 - (Math.max(0, Math.min(100, p)) / 100) * (H - 4); };
    const parts = ['<line class="ev-base" x1="0" y1="' + (H - 0.5) + '" x2="' + W + '" y2="' + (H - 0.5) + '"/>'];
    const socPts = [];
    // Volle Stunden als feine Raster-Linien, damit man beim Scrollen die Zeit sieht.
    for (let hr = Math.ceil(v0 / HOUR) * HOUR; hr < v1; hr += HOUR) {
      parts.push('<line class="ev-grid" x1="' + x(hr).toFixed(1) + '" y1="0" x2="' + x(hr).toFixed(1) + '" y2="' + H + '"/>');
    }
    slots.forEach(function (s) {
      const ts = Date.parse(s.ts);
      if (ts + slotMs < v0 - slotMs || ts > v1 + slotMs) return;
      if (s.powerW > 0) {
        const h = Math.max(2, (s.powerW / maxW) * barH);
        parts.push('<rect class="ev-bar" x="' + x(ts).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(1, (slotMs / view.spanMs) * W - 0.6).toFixed(1)
          + '" height="' + h.toFixed(1) + '"><title>' + esc(fmtTime(s.ts) + ' · ' + fmtKw(s.powerW) + (s.socPct != null ? ' · ' + s.socPct + ' %' : '')) + '</title></rect>');
      }
      if (s.socPct != null) socPts.push(x(ts).toFixed(1) + ',' + yPct(s.socPct).toFixed(1));
    });
    const res = data.departure && data.departure.resolved;
    if (res && res.targetSocPct != null) {
      parts.push('<line class="ev-target" x1="0" y1="' + yPct(res.targetSocPct).toFixed(1) + '" x2="' + W + '" y2="' + yPct(res.targetSocPct).toFixed(1) + '"/>');
    }
    if (socPts.length > 1) parts.push('<polyline class="ev-soc" points="' + socPts.join(' ') + '"/>');
    const nowMs = Date.now();
    if (nowMs >= v0 && nowMs <= v1) parts.push('<line class="ev-now" x1="' + x(nowMs).toFixed(1) + '" y1="0" x2="' + x(nowMs).toFixed(1) + '" y2="' + H + '"><title>jetzt</title></line>');
    const depMs = res && res.departureAt ? Date.parse(res.departureAt) : NaN;
    const arrMs = res && res.arrivalAt ? Date.parse(res.arrivalAt) : NaN;
    // Das Fenster Ankunft → Abfahrt hinterlegt; davor steht das Auto nicht da.
    if (isFinite(depMs) && depMs > v0) {
      const wx0 = Math.max(0, x(isFinite(arrMs) ? arrMs : v0));
      const wx1 = Math.min(W, x(depMs));
      if (wx1 > wx0) parts.unshift('<rect class="ev-win" x="' + wx0.toFixed(1) + '" y="0" width="' + (wx1 - wx0).toFixed(1) + '" height="' + H + '"/>');
    }
    if (isFinite(arrMs) && arrMs >= v0 && arrMs <= v1) {
      parts.push('<line class="ev-arr" x1="' + x(arrMs).toFixed(1) + '" y1="0" x2="' + x(arrMs).toFixed(1) + '" y2="' + H + '"><title>Ankunft ' + esc(fmtDayTime(res.arrivalAt)) + '</title></line>');
    }
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
    const steps = [];
    slots.forEach(function (s) {
      const ts = Date.parse(s.ts);
      const w = s.powerW > 0 ? s.powerW : 0;
      const last = steps[steps.length - 1];
      if (last && last.powerW === w && last.end === ts) { last.end = ts + slotMs; last.socEnd = s.socPct; return; }
      steps.push({ start: ts, end: ts + slotMs, powerW: w, socEnd: s.socPct });
    });
    return steps.filter(function (st) { return st.powerW > 0; });
  }

  let stepsOpen = false;   // Ladestufen aufgeklappt (bleibt über Aktualisierungen)

  function renderSteps() {
    const host = el('evSteps');
    if (!host) return;
    const plan = data.plan;
    const slots = plan && Array.isArray(plan.slots) ? plan.slots : [];
    if (!data.optimizeEv || !plan || !plan.hasEv || !slots.length) { host.hidden = true; host.innerHTML = ''; return; }
    const now = Date.now();
    const steps = evSteps(slots, (plan.slotMinutes || 15) * 60000).filter(function (st) { return st.end > now; });
    host.hidden = false;
    if (!steps.length) { host.innerHTML = '<div class="ev-step is-none">EOS plant keine weitere Ladung</div>'; return; }
    const row = function (st) {
      const cur = st.start <= now && now < st.end;
      return '<div class="ev-step' + (cur ? ' is-now' : '') + '">'
        + '<span class="ev-step-t">' + (cur ? 'jetzt' : esc(fmtTime(new Date(st.start).toISOString()))) + '–' + esc(fmtTime(new Date(st.end).toISOString())) + '</span>'
        + '<span class="ev-step-w">' + esc(fmtKw(st.powerW)) + '</span>'
        + '<span class="ev-step-s">' + (st.socEnd != null ? '→ ' + st.socEnd + ' %' : '') + '</span>'
        + '</div>';
    };
    // Laufende bzw. nächste Stufe immer sichtbar, der Rest zum Aufklappen.
    const rest = steps.slice(1);
    const toggle = '<button type="button" class="ev-steps-toggle" id="evStepsToggle" aria-expanded="' + stepsOpen + '">'
      + (stepsOpen ? 'weniger' : '+ ' + rest.length + ' weitere Stufe' + (rest.length === 1 ? '' : 'n')) + '</button>';
    host.innerHTML = row(steps[0])
      + (stepsOpen && rest.length ? '<div class="ev-steps-more">' + rest.map(row).join('') + '</div>' : '')
      + (rest.length ? toggle : '');
  }

  function wireTimelineWheel() {
    const host = el('evTimeline');
    if (!host || host.dataset.wheelWired === '1') return;
    host.dataset.wheelWired = '1';
    host.addEventListener('wheel', function (e) {
      if (!bounds || !data) return;
      e.preventDefault();
      const start = viewStart();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      if (e.ctrlKey || e.metaKey) {
        // Zoom um die Mausposition.
        const rect = host.getBoundingClientRect();
        const frac = rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
        const anchor = start + frac * view.spanMs;
        view.spanMs = Math.max(VIEW_MIN, Math.min(VIEW_MAX, view.spanMs * (delta > 0 ? 1.25 : 0.8)));
        view.startMs = anchor - frac * view.spanMs;
      } else {
        const step = Math.max(bounds.slotMs, view.spanMs / 8);
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
    const out = el('evPlanSummary');
    if (!out) return;
    out.className = 'v';
    const res = data.departure && data.departure.resolved;
    if (!data.optimizeEv) { out.textContent = 'EOS plant das Auto nicht'; out.classList.add('dim'); return; }
    if (data.vehicle && data.vehicle.registered === false) {
      if (data.vehicle.preplanBlocked) {
        // Ankunft steht an, aber vorplanen geht (noch) nicht.
        out.textContent = data.vehicle.preplanBlocked;
        out.title = data.departure && data.departure.chargeStartSupported === false
          ? 'Dieses EOS kennt keinen fr\u00fchesten Ladestart \u2014 es w\u00fcrde schon Ladung einplanen, bevor das Auto da ist. DVhub meldet das Auto deshalb erst beim Anstecken an.'
          : 'Ohne erwarteten Ladestand kann EOS nicht vorplanen \u2014 eine Quelle, die das Fahrzeug auch unterwegs meldet, oder ein letzter bekannter Wert fehlt.';
        out.classList.add('warn');
        return;
      }
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
    const plan = data.plan;
    if (!plan || !plan.hasEv) { out.textContent = data.planError ? ('kein Plan: ' + data.planError) : 'noch kein EOS-Plan'; out.classList.add('dim'); return; }
    const parts = [];
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
    if (data.vehicle && data.vehicle.registrationMode === 'preplan') parts.push('vorgeplant' + (data.vehicle.chargeStartAt ? ' ab ' + fmtTime(data.vehicle.chargeStartAt) : ''));
    out.textContent = parts.join(' · ');
    const w = (plan.windows || []).map(function (x) { return fmtTime(x.start) + '–' + fmtTime(x.end) + ' ' + fmtKw(x.maxW) + ' (' + fmtNum(x.kwh, 1) + ' kWh)'; });
    out.title = w.length ? 'Ladefenster bis zur Abfahrt:\n' + w.join('\n') : 'Bis zur Abfahrt plant EOS keine Ladung.';
  }

  function renderState() {
    const v = data.vehicle || {};
    const st = el('evState');
    const parts = [];
    if (v.connected === true) parts.push(v.charging ? ('lädt' + (v.chargePowerW ? ' mit ' + fmtKw(v.chargePowerW) : '')) : 'angesteckt');
    else if (v.connected === false) parts.push('nicht angesteckt');
    if (data.departure && data.departure.enabled === false) parts.push('ohne Wochenplan');
    if (data.departure && data.departure.enabled && data.departure.deadlineSupported === false) parts.push('EOS kennt die Uhrzeit erst ab 0.4');
    st.textContent = parts.join(' · ') || '—';
    st.classList.toggle('is-charging', v.charging === true);
  }

  // Naechstes Fenster: „Ankunft heute 20:00 · Abfahrt morgen 05:00 · Ziel 80 %
  // · erwartet bei Ankunft 42 % (geschätzt)“.
  function renderWindow() {
    const box = el('evWindow');
    if (!box) return;
    const res = data.departure && data.departure.resolved;
    if (!res || !res.enabled || !res.departureAt) { box.hidden = true; return; }
    const a = data.arrival || {};
    const parts = [];
    if (res.arrivalAt) parts.push('Ankunft ' + fmtRelDay(res.arrivalAt) + (res.arrivalSource === 'once' ? ' (einmalig)' : ''));
    parts.push('Abfahrt ' + fmtRelDay(res.departureAt) + (res.source === 'once' ? ' (einmalig)' : ''));
    if (res.targetSocPct != null) parts.push('Ziel ' + res.targetSocPct + ' %');
    let title = '';
    if (a.expectedSocPct != null) {
      const how = a.source === 'plugged' ? 'angesteckt' : (a.source === 'live' ? 'live vom Fahrzeug' : 'geschätzt');
      parts.push((a.source === 'plugged' ? 'jetzt ' : 'erwartet bei Ankunft ') + a.expectedSocPct + ' % (' + how + ')');
      if (a.source !== 'plugged' && a.basePct != null) {
        title = 'Basis: ' + fmtNum(a.basePct) + ' % von ' + sourceName(a.baseSource) + (a.baseAt ? ', ' + fmtDayTime(a.baseAt) : '')
          + (a.deductKm > 0 ? ' − ' + (a.legs === 2 ? 'Hin- und Rückweg 2 × ' + fmtNum(a.commuteKm) : 'Heimweg ' + fmtNum(a.commuteKm)) + ' km' : '');
      }
    } else if (res.arrivalAt && data.vehicle && data.vehicle.plugged !== true) {
      parts.push('Ladestand bei Ankunft unbekannt');
      title = 'Keine Quelle meldet den Ladestand des Fahrzeugs, und es ist kein letzter Wert bekannt.';
    }
    // Fenster kürzer als eine Viertelstunde: EOS kann darin nicht laden.
    const arrMs = res.arrivalAt ? Date.parse(res.arrivalAt) : NaN;
    const short = isFinite(arrMs) && Date.parse(res.departureAt) - Math.max(arrMs, Date.now()) < 15 * 60000;
    if (short) parts.push('Fenster zu kurz zum Laden');
    let hint = '';
    if (data.vehicle && data.vehicle.registrationMode === 'preplan') hint = 'EOS plant ab Ankunft vor';
    else if (data.vehicle && data.vehicle.preplanBlocked) hint = data.vehicle.preplanBlocked;
    box.textContent = parts.join(' · ') + (hint ? ' · ' + hint : '');
    box.title = title;
    box.classList.toggle('is-warn', short || (!!data.vehicle && !!data.vehicle.preplanBlocked));
    box.hidden = false;
  }

  function renderForm() {
    const mode = (data.departure && data.departure.targetMode) || 'percent';
    el('evDepEnabled').checked = !!draft.enabled;
    el('evTarget').value = draft.targetValue != null ? draft.targetValue : '';
    el('evTarget').max = mode === 'percent' ? 100 : 2000;
    el('evTarget').step = mode === 'percent' ? 5 : 1;
    el('evTargetUnit').textContent = UNITS[mode] || '%';
    el('evCommuteKm').value = draft.commuteKm != null ? draft.commuteKm : '';
    el('evArrOnce').value = toLocalInput(draft.arrivalOnce);
    el('evDepOnce').value = toLocalInput(draft.once);
    el('evWeekly').hidden = !weekOpen;
    el('evWeekToggle').setAttribute('aria-expanded', String(weekOpen));
    el('evWeekToggle').textContent = weekOpen ? 'Zuklappen' : 'Bearbeiten';
    if (window.DVhubEvWeekly) {
      window.DVhubEvWeekly.render(el('evWeeklyGrid'), draft.weeklyPlan, {
        unit: UNITS[mode] || '%', defaultTarget: draft.targetValue, showKm: false,
        onChange: function () { setDirty(true); },
        // Vorschau beim Bearbeiten (POST /api/ev/preview): derselbe Body wie beim Speichern.
        previewBody: function () { return { departure: formDeparture() }; }
      });
      window.DVhubEvWeekly.setSummary(el('evWeeklyGrid'), savedSummary());
    }
  }

  // Gespeicherter Stand fuer die Zusammenfassung ueber dem Wochenplan: naechste
  // Abfahrt (resolveEvDeparture) und was davon gerade an EOS geht.
  function savedSummary() {
    const d = data.departure || {};
    const v = data.vehicle || {};
    return {
      resolved: d.resolved || null,
      capacityWh: data.capacityWh,
      eos: {
        optimizeEv: !!data.optimizeEv, registered: v.registered, reason: v.registrationReason,
        preplanBlocked: v.preplanBlocked, mode: v.registrationMode, chargeStartAt: v.chargeStartAt,
        deadlineSupported: d.deadlineSupported === true, chargeStartSupported: d.chargeStartSupported === true
      }
    };
  }

  // Abfahrtsfelder aus dem Formular (Speichern und Vorschau), ohne Pruefung.
  function formDeparture() {
    const plan = window.DVhubEvWeekly ? window.DVhubEvWeekly.read(el('evWeeklyGrid')) : draft.weeklyPlan;
    return {
      enabled: draft.enabled, weeklyPlan: plan, targetValue: Number(el('evTarget').value),
      commuteKm: el('evCommuteKm').value === '' ? 0 : Number(el('evCommuteKm').value),
      arrivalOnce: fromLocalInput(el('evArrOnce').value), once: fromLocalInput(el('evDepOnce').value)
    };
  }
  function previewSoon() {
    if (window.DVhubEvWeekly) window.DVhubEvWeekly.refreshPreview(el('evWeeklyGrid'));
  }

  // „Sofort laden“: laden mit X kW, egal was EOS plant (POST/DELETE /api/ev/override).
  function renderBoost() {
    const box = el('evBoost');
    if (!box) return;
    box.hidden = !data.chargerConfigured && !data.override;
    const ov = data.override;
    const lim = data.overrideLimits || { minPowerW: 4140, maxPowerW: data.maxChargeW || 11000 };
    el('evBoostIdle').hidden = !!ov;
    el('evBoostActive').hidden = !ov;
    box.classList.toggle('is-active', !!ov);
    const kw = el('evBoostKw');
    kw.min = String(Math.ceil(lim.minPowerW / 100) / 10);
    kw.max = String(lim.maxPowerW / 1000);
    if (!boostTouched && document.activeElement !== kw) kw.value = String(lim.maxPowerW / 1000);
    if (!ov) return;
    const isStop = ov.kind === 'stop';
    const parts = [isStop ? 'Laden gestoppt' : 'Sofort laden · ' + fmtKw(ov.powerW)];
    parts.push(ov.until ? 'bis ' + fmtTime(ov.until) : 'bis Abstecken');
    if (!ov.seenConnected && data.vehicle && data.vehicle.connected === false) parts.push('wartet aufs Anstecken');
    if (data.lastCommandError) parts.push('Fehler: ' + data.lastCommandError);
    const t = el('evBoostText');
    t.textContent = parts.join(' · ');
    t.classList.toggle('is-error', !!data.lastCommandError);
    t.title = !isStop && ov.requestedW && ov.requestedW !== ov.powerW
      ? 'Gewünscht ' + fmtKw(ov.requestedW) + ', möglich ' + fmtKw(lim.minPowerW) + '–' + fmtKw(lim.maxPowerW)
      : 'seit ' + fmtTime(ov.startedAt);
  }

  async function startBoost() {
    const kw = Number(String(el('evBoostKw').value).replace(',', '.'));
    if (!isFinite(kw) || kw <= 0) { msg('Ladeleistung in kW angeben.', true); return; }
    const dur = el('evBoostFor').value;
    const payload = { powerW: Math.round(kw * 1000) };
    if (dur) payload.durationMin = Number(dur);
    el('evBoostStart').disabled = true;
    try {
      const res = await apiFetch('/api/ev/override', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      let body = {};
      try { body = await res.json(); } catch (_) { /* leer */ }
      if (body.error === 'pro_required') { msg('Wallbox-Steuerung braucht DVhub Pro.', true); return; }
      if (!res.ok || !body.ok) { msg('Nicht gestartet: ' + (body.error || ('HTTP ' + res.status)), true); return; }
      boostTouched = false;
      const r = body.result || {};
      if (r.skipped === 'paused') msg('Gespeichert — Not-Halt ist aktiv, geladen wird erst nach dem Aufheben.', true);
      else if (r.skipped === 'pro required') msg('Gespeichert, aber ohne Pro-Lizenz steuert DVhub die Wallbox nicht.', true);
      else msg(r.ok === false && r.error ? 'Gespeichert, Wallbox meldet: ' + r.error : 'Lädt jetzt mit ' + fmtKw(body.override.powerW) + '.', r.ok === false && !!r.error);
      setTimeout(function () { msg(''); }, 5000);
    } catch (e) {
      msg('Nicht gestartet: ' + e.message, true);
    } finally {
      el('evBoostStart').disabled = false;
      load();
    }
  }

  // „Laden stoppen“: die Wallbox lädt nicht, egal was EOS plant (kind 'stop').
  async function startStop() {
    const dur = el('evBoostFor').value;
    const payload = { kind: 'stop' };
    if (dur) payload.durationMin = Number(dur);
    el('evStopStart').disabled = true;
    try {
      const res = await apiFetch('/api/ev/override', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      let body = {};
      try { body = await res.json(); } catch (_) { /* leer */ }
      if (body.error === 'pro_required') { msg('Wallbox-Steuerung braucht DVhub Pro.', true); return; }
      if (!res.ok || !body.ok) { msg('Nicht gestoppt: ' + (body.error || ('HTTP ' + res.status)), true); return; }
      const r = body.result || {};
      if (r.skipped === 'pro required') msg('Gespeichert, aber ohne Pro-Lizenz steuert DVhub die Wallbox nicht.', true);
      else msg(r.ok === false && r.error ? 'Gespeichert, Wallbox meldet: ' + r.error : 'Laden gestoppt.', r.ok === false && !!r.error);
      setTimeout(function () { msg(''); }, 5000);
    } catch (e) {
      msg('Nicht gestoppt: ' + e.message, true);
    } finally {
      el('evStopStart').disabled = false;
      load();
    }
  }

  async function stopBoost() {
    el('evBoostStop').disabled = true;
    const wasStop = data && data.override && data.override.kind === 'stop';
    try {
      const res = await apiFetch('/api/ev/override', { method: 'DELETE' });
      let body = {};
      try { body = await res.json(); } catch (_) { /* leer */ }
      if (body.error === 'emergency_stop_active') { msg('Not-Halt ist aktiv — „Laden stoppen“ bleibt bis zum Aufheben.', true); return; }
      if (!res.ok || !body.ok) { msg('Nicht beendet: ' + (body.error || ('HTTP ' + res.status)), true); return; }
      const what = wasStop ? 'Laden stoppen' : 'Sofort laden';
      if (body.error) { msg(what + ' beendet, aber die Wallbox meldet: ' + body.error, true); return; }
      msg(what + ' beendet — es gilt wieder der EOS-Plan bzw. die Wallbox selbst.');
      setTimeout(function () { msg(''); }, 4000);
    } catch (e) {
      msg('Nicht beendet: ' + e.message, true);
    } finally {
      el('evBoostStop').disabled = false;
      load();
    }
  }

  function render() {
    const tile = el('evTile');
    if (!tile || !data) return;
    tile.hidden = false;
    const v = data.vehicle || {};
    el('evTitle').textContent = 'E-Auto' + (v.title ? ' · ' + v.title : '');
    el('evOptimize').checked = !!data.optimizeEv;
    el('evOnlyPlugged').checked = data.onlyWhenPlugged !== false;
    el('evOnlyPlugged').disabled = !data.optimizeEv;
    tile.classList.toggle('is-off', !data.optimizeEv);
    el('evSocNow').textContent = v.socPct != null ? v.socPct + ' %' : '—';
    const res = data.departure && data.departure.resolved;
    const mode = (data.departure && data.departure.targetMode) || 'percent';
    let tgt = res && res.targetSocPct != null ? res.targetSocPct + ' %' : '—';
    if (mode !== 'percent' && data.departure.targetValue != null) tgt += ' (' + fmtNum(data.departure.targetValue) + ' ' + UNITS[mode] + ')';
    el('evSocTarget').textContent = tgt;
    el('evSocNow').title = v.socSource ? 'Quelle: ' + v.socSource + (v.rangeKm > 0 ? ' · ' + v.rangeKm + ' km' : '') : '';
    renderState();
    renderWindow();
    renderBoost();
    renderTimeline();
    renderSteps();
    renderSummary();
    // Nicht neu aufbauen, solange jemand im Wochenplan tippt (eine halbe
    // Uhrzeit loest noch kein input-Ereignis aus).
    if (!dirty && !(window.DVhubEvWeekly && window.DVhubEvWeekly.isEditing(el('evWeekly')))) { draft = draftFromData(); renderForm(); }
    // Sonst nur den gespeicherten Stand der Zusammenfassung auffrischen (EOS-Zeile).
    else if (window.DVhubEvWeekly) window.DVhubEvWeekly.updateSaved(el('evWeeklyGrid'), savedSummary());
  }

  // ---------------------------------------------------------------- Daten

  async function load() {
    try {
      const res = await apiFetch('/api/ev');
      if (!res.ok) { if (res.status === 404) el('evTile').hidden = true; return; }
      const body = await res.json();
      if (!body || !body.ok) return;
      data = body;
      try { document.dispatchEvent(new CustomEvent('dvhub:ev-data', { detail: body })); } catch (_) { /* alte Browser */ }
      // Kein Auto eingerichtet (EOS-Planung aus, keine Abfahrt, kein Ladepunkt): Kachel bleibt weg.
      const any = body.optimizeEv || body.override || (body.departure && body.departure.enabled) || (body.vehicle && body.vehicle.connected !== null);
      if (!any) { el('evTile').hidden = true; return; }
      render();
    } catch (_) { /* naechster Takt */ }
  }

  async function post(payload, okText) {
    msg('Speichere …');
    try {
      const res = await apiFetch('/api/ev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      let body = {};
      try { body = await res.json(); } catch (_) { /* leer */ }
      if (body.error === 'pro_required') { msg('Nicht gespeichert: E-Auto-Planung und Wallbox-Steuerung brauchen DVhub Pro.', true); return false; }
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
    const ok = await post({ optimizeEv: on }, on ? 'EOS plant das Auto jetzt mit — der neue Plan kommt mit dem nächsten EOS-Lauf.' : 'EOS plant das Auto nicht mehr.');
    if (!ok) el('evOptimize').checked = !on;
    load();
  }

  async function toggleOnlyPlugged(on) {
    const ok = await post({ onlyWhenPlugged: on }, on
      ? 'EOS plant das Auto nur noch, wenn es angesteckt ist.'
      : 'EOS plant das Auto immer mit, auch ohne Stecker.');
    if (!ok) el('evOnlyPlugged').checked = !on;
    load();
  }

  async function save() {
    const mode = (data.departure && data.departure.targetMode) || 'percent';
    const tv = Number(el('evTarget').value);
    if (!isFinite(tv) || tv < 0 || (mode === 'percent' && tv > 100)) { msg('Ziel: ' + (mode === 'percent' ? '0–100 %' : 'Zahl ≥ 0'), true); return; }
    const dep = formDeparture();
    const err = window.DVhubEvWeekly ? window.DVhubEvWeekly.validate(dep.weeklyPlan, { enabled: draft.enabled, hasOnce: !!el('evDepOnce').value }) : null;
    if (err) { msg(err, true); return; }
    const km = dep.commuteKm;
    if (!isFinite(km) || km < 0 || km > 1000) { msg('Heimweg: 0–1000 km', true); return; }
    dep.targetValue = tv;
    const ok = await post({ departure: dep }, 'Übernommen — EOS rechnet mit dem neuen Wochenplan.');
    if (ok) { setDirty(false); load(); }
  }

  // ---------------------------------------------------------------- Ereignisse

  document.addEventListener('change', function (e) {
    if (!data) return;
    if (e.target.id === 'evOptimize') { toggleOptimize(e.target.checked); return; }
    if (e.target.id === 'evOnlyPlugged') { toggleOnlyPlugged(e.target.checked); return; }
    if (e.target.id === 'evDepEnabled') { draft.enabled = e.target.checked; setDirty(true); previewSoon(); return; }
    if (e.target.id === 'evTarget') { draft.targetValue = e.target.value; setDirty(true); previewSoon(); return; }
    if (e.target.id === 'evCommuteKm' || e.target.id === 'evArrOnce' || e.target.id === 'evDepOnce') { setDirty(true); previewSoon(); }
  });
  document.addEventListener('input', function (e) {
    if (!data) return;
    if (e.target.id === 'evTarget' || e.target.id === 'evCommuteKm') { setDirty(true); previewSoon(); }
    if (e.target.id === 'evBoostKw') boostTouched = true;
  });
  document.addEventListener('click', function (e) {
    if (!data) return;
    if (e.target.id === 'evWeekToggle') {
      weekOpen = !weekOpen;
      el('evWeekly').hidden = !weekOpen;
      e.target.setAttribute('aria-expanded', String(weekOpen));
      e.target.textContent = weekOpen ? 'Zuklappen' : 'Bearbeiten';
      return;
    }
    if (e.target.id === 'evStepsToggle') { stepsOpen = !stepsOpen; renderSteps(); return; }
    if (e.target.id === 'evSave') { save(); return; }
    if (e.target.id === 'evBoostStart') { startBoost(); return; }
    if (e.target.id === 'evBoostStop') { stopBoost(); return; }
    if (e.target.id === 'evStopStart') { startStop(); return; }
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
