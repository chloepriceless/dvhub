// ev-weekly-editor.js -- Wochenplan-Editor fuers E-Auto (Leitstand-Kachel und
// Integrationsseite teilen ihn): 7 Zeilen Mo..So mit Ankunft, Abfahrt,
// Mindest-Ladestand bei der Abfahrt und Verbrauch der Fahrt danach — alles in
// % Ladestand (seit 1.0.10, vorher Ziel in %/kWh/km und Heimweg in km), dazu
// „gleich fuer Mo–Fr“.
//
// Liegt die Abfahrt nicht nach der Ankunft, ist sie am Folgetag (20:00 →
// 05:00); die Zeile zeigt dann „+1 Tag“. Leeres Mindest-Feld heisst
// „allgemeiner Wert“, leere Fahrt „0 %“. Kein Inline-JS, keine Inline-Styles (CSP).
//
// Sichtbar machen, was DVhub aus dem Plan macht (2026-10-29): je Zeile die
// aufgeloeste Abfahrt („Ankunft Mi 20:00 → Abfahrt Do 02:00 (Folgetag)“), ein
// Hinweis bei frueher Abfahrt ohne Ankunft (rowInfo; dieselben Regeln wie
// ev-departure.js departsNextDay/earlyDepartureWithoutArrival, der Test haelt
// sie gleich) und oben eine Zusammenfassung: naechste Abfahrt mit Quelle und
// was an EOS geht. Beim Bearbeiten rechnet der Server die Vorschau mit seiner
// eigenen Aufloesung (POST /api/ev/preview) — keine zweite Logik im Browser.
//
// window.DVhubEvWeekly = { render(host, plan, opts), read(host), validate(plan),
//   rowInfo(entry), summaryLines(info), setSummary(host, info), updateSaved(host, info),
//   refreshPreview(host) }
(function () {
  'use strict';

  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Wie ev-departure.js parseTime: „H:MM“/„HH:MM“, 00:00–23:59.
  const minutes = function (t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const hhmm = function (min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); };
  // ev-departure.js EARLY_DEPARTURE_HINT_BEFORE (06:00)
  const EARLY_BEFORE_MIN = 6 * 60;

  /**
   * Was DVhub aus einer Zeile macht. Regeln wie ev-departure.js: mit Ankunft
   * und Abfahrt nicht danach → Folgetag; ohne Ankunft gilt die Abfahrt am Tag
   * der Zeile. early: Abfahrt vor 06:00 ohne Ankunft (die Falle vom 29.10.).
   * @returns {{ nextDay: boolean, early: boolean, text: string, hint: string, missingDeparture: boolean }}
   */
  function rowInfo(e) {
    const i = Math.max(0, Math.min(6, Number(e && e.day) - 1 || 0));
    const a = minutes(e && e.arrival);
    const d = minutes(e && e.departure);
    const nextDay = a !== null && d !== null && d <= a;
    const early = d !== null && a === null && d < EARLY_BEFORE_MIN;
    const next = (i + 1) % 7;
    const prev = (i + 6) % 7;
    let text = '';
    if (a !== null && d !== null) text = 'Ankunft ' + DAYS[i] + ' ' + hhmm(a) + ' → Abfahrt ' + DAYS[nextDay ? next : i] + ' ' + hhmm(d) + (nextDay ? ' (Folgetag)' : '');
    else if (d !== null) text = '→ Abfahrt ' + DAYS[i] + ' ' + hhmm(d);
    else if (a !== null) text = 'Ankunft ' + DAYS[i] + ' ' + hhmm(a) + ' — Abfahrt fehlt';
    const hint = early
      ? 'Diese Abfahrt gilt für ' + DAY_NAMES[i] + ' ' + hhmm(d) + ' (Nacht von ' + DAY_NAMES[prev] + ' auf ' + DAY_NAMES[i] + '). '
        + 'Ist die Nacht von ' + DAY_NAMES[i] + ' auf ' + DAY_NAMES[next] + ' gemeint, trage hier eine Ankunft ein (z. B. 20:00) — '
        + 'dann rutscht die Abfahrt auf ' + DAY_NAMES[next] + ' ' + hhmm(d) + '.'
      : '';
    return { nextDay: nextDay, early: early, text: text, hint: hint, missingDeparture: a !== null && d === null };
  }

  // „Do 29.10. 23:59“ in DVhubs Zeitzone (nicht der des Browsers).
  function fmtAt(iso, timeZone) {
    const t = Date.parse(iso || '');
    if (!isFinite(t)) return '—';
    const parts = new Intl.DateTimeFormat('de-DE', {
      timeZone: timeZone || 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(t));
    const get = function (k) { for (let j = 0; j < parts.length; j += 1) if (parts[j].type === k) return parts[j].value; return ''; };
    return get('weekday').replace('.', '') + ' ' + get('day') + '.' + get('month') + '. ' + get('hour') + ':' + get('minute');
  }
  function isoWeekday(iso, timeZone) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Europe/Berlin', weekday: 'short' }).format(new Date(Date.parse(iso)));
    return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd] || null;
  }

  /**
   * Zusammenfassung ueber dem Plan. info = {
   *   resolved: resolveEvDeparture (gespeichert oder Vorschau),
   *   preview: true = Entwurf, noch nicht gespeichert,
   *   capacityWh: fuer „≈ kWh“,
   *   eos: { optimizeEv, registered, reason, preplanBlocked, mode, chargeStartAt,
   *          deadlineSupported, chargeStartSupported, resolved: gespeicherter Stand } | null
   * } → [{ text, cls }]
   */
  function summaryLines(info) {
    info = info || {};
    const r = info.resolved || {};
    const tz = r.timeZone || 'Europe/Berlin';
    const pre = info.preview ? 'Vorschau (noch nicht gespeichert) — ' : '';
    const lines = [];
    const kwh = function (pct) {
      const cap = Number(info.capacityWh);
      if (!(cap > 0) || pct == null) return '';
      return ' ≈ ' + (Math.round(cap * pct / 100 / 100) / 10).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' kWh';
    };
    const pct = function (v) { return Math.round(Number(v)) + ' %'; };
    const ct = function (eur) { return Math.round(Number(eur) * 100); };
    if (!r.enabled) lines.push({ text: pre + 'Wochenplan aus — EOS nutzt den allgemeinen Ziel-Ladestand.', cls: 'is-dim' });
    else if (!r.departureAt) lines.push({ text: pre + 'Keine Abfahrt geplant' + (r.reason && r.reason !== 'keine Abfahrt geplant' ? ' (' + r.reason + ')' : '') + '.', cls: 'is-warn' });
    else {
      const parts = ['Nächste Abfahrt: ' + fmtAt(r.departureAt, tz)];
      if (r.targetSocPct != null) parts.push('mindestens ' + r.targetSocPct + ' %' + kwh(r.targetSocPct));
      if (Number(r.tripSocPct) > 0) parts.push('Fahrt danach ≈ ' + pct(r.tripSocPct));
      const dayName = r.day ? DAY_NAMES[r.day - 1] : '';
      if (r.source === 'once') parts.push('einmalig' + (dayName ? ' (statt Wochenplan ' + dayName + ')' : ''));
      else if (dayName) parts.push('aus Wochenplan ' + dayName + (isoWeekday(r.departureAt, tz) !== r.day ? ' (Abfahrt am Folgetag)' : ''));
      lines.push({ text: pre + parts.join(' · '), cls: 'is-next' });
      if (r.arrivalAt) lines.push({ text: 'Ankunft davor: ' + fmtAt(r.arrivalAt, tz) + ' (' + (r.arrivalSource === 'once' ? 'einmalig' : 'Wochenplan') + ')', cls: '' });
    }
    const e = info.eos;
    if (e) {
      const s = e.resolved || r;
      const stz = s.timeZone || tz;
      const head = 'An EOS' + (info.preview ? ' (gespeicherter Plan)' : '') + ': ';
      if (!e.optimizeEv) lines.push({ text: head + 'nichts — EOS plant das Auto nicht mit', cls: 'is-dim' });
      else if (e.registered == null) lines.push({ text: head + 'noch nichts — DVhub hat das Auto noch nicht mit EOS abgeglichen', cls: 'is-dim' });
      else if (e.registered !== true) {
        const why = e.preplanBlocked || e.reason;
        lines.push({ text: head + 'Auto gerade nicht angemeldet' + (why ? ' (' + why + ')' : ''), cls: 'is-dim' });
      } else {
        const parts = [];
        if (!s.enabled || s.targetSocPct == null) parts.push('allgemeiner Ziel-Ladestand' + (s.enabled ? '' : ' (Wochenplan aus)'));
        else if (!e.deadlineSupported) parts.push('mindestens ' + s.targetSocPct + ' % ohne Uhrzeit (kein EOS 0.4 erkannt)');
        else {
          // Was wirklich an EOS ging (ev-targets.js): vorausschauendes Mindestziel, Max, Wert.
          const t = e.targets;
          const min = t && t.minSocPct != null ? t.minSocPct : s.targetSocPct;
          let txt = 'mindestens ' + min + ' %' + (s.departureAt ? ' bis ' + fmtAt(s.departureAt, stz) : ' ohne Frist');
          if (t && t.minWeekPct != null && Number(t.minSocPct) > Number(t.minWeekPct)) txt += ' (vorausschauend, Plan ' + t.minWeekPct + ' %)';
          parts.push(txt);
          if (t && t.maxActive) {
            const steps = Array.isArray(t.steps) ? t.steps : [];
            parts.push('bis ' + t.maxSocPct + ' %, wenn günstig' + (steps.length
              ? ' (Wert ' + ct(steps[0][1]) + '–' + ct(steps[steps.length - 1][1]) + ' ct je kWh)'
              : (t.reason ? ' (' + t.reason + ')' : '')));
          }
        }
        if (e.deadlineSupported && e.chargeStartSupported) {
          if (e.mode === 'preplan') parts.push('Ladestart ' + (e.chargeStartAt ? fmtAt(e.chargeStartAt, stz) : 'sofort (Ankunft vorbei)'));
          else if (e.mode === 'plugged') parts.push('Ladestart sofort (angesteckt)');
          else if (e.mode === 'always') parts.push('Ladestart sofort');
        }
        lines.push({ text: head + parts.join(' · '), cls: !e.deadlineSupported ? 'is-warn' : '' });
        if (e.valueSupported === false && e.maxSocPct != null) {
          lines.push({ text: 'Max-Ladestand ' + e.maxSocPct + ' % wirkt erst mit einem EOS, das Wertstufen kennt — bis dahin lädt EOS nur bis zum Mindestziel.', cls: 'is-dim' });
        }
      }
    }
    if (info.previewError) lines.push({ text: 'Vorschau nicht möglich: ' + info.previewError, cls: 'is-warn' });
    return lines;
  }

  function entryFor(plan, day) {
    const list = Array.isArray(plan) ? plan : [];
    for (let i = 0; i < list.length; i += 1) if (Number(list[i] && list[i].day) === day) return list[i];
    return { day: day, arrival: '', departure: '', minSocPct: null, tripSocPct: null };
  }

  function rowHtml(e, i, opts) {
    const day = i + 1;
    const name = DAY_NAMES[i];
    const val = function (v) { return v == null ? '' : esc(v); };
    return '<div class="evw-row" data-day="' + day + '">'
      + '<span class="evw-day">' + DAYS[i] + '</span>'
      + '<input type="time" class="input mono evw-arr" step="300" value="' + val(e.arrival) + '" aria-label="Ankunft ' + name + '">'
      + '<span class="evw-depwrap"><input type="time" class="input mono evw-dep" step="300" value="' + val(e.departure) + '" aria-label="Abfahrt ' + name + '">'
      + '<span class="evw-next" hidden>+1 Tag</span></span>'
      + '<input type="number" class="input mono evw-min" min="0" max="100" step="5" value="' + val(e.minSocPct) + '" placeholder="' + val(opts.defaultMin) + '" aria-label="Mindestens bei Abfahrt ' + name + ' (%)" title="Mindest-Ladestand bei dieser Abfahrt — wird immer erreicht. Leer: allgemeiner Wert.">'
      + '<input type="number" class="input mono evw-trip" min="0" max="100" step="1" value="' + val(e.tripSocPct) + '" placeholder="0" aria-label="Fahrt ab ' + name + ' (% Ladestand)" title="So viel Ladestand verbraucht die Fahrt ab dieser Abfahrt bis zur nächsten Ankunft (geschätzt).">'
      + '<span class="evw-res"></span>'
      + '<span class="evw-warn" role="note" hidden></span>'
      + '</div>';
  }

  function markNextDay(row) {
    const info = rowInfo({ day: Number(row.getAttribute('data-day')), arrival: row.querySelector('.evw-arr').value, departure: row.querySelector('.evw-dep').value });
    row.querySelector('.evw-next').hidden = !info.nextDay;
    row.classList.toggle('is-empty', minutes(row.querySelector('.evw-dep').value) === null);
    const res = row.querySelector('.evw-res');
    res.textContent = info.text;
    res.hidden = !info.text;
    res.classList.toggle('is-warn', info.missingDeparture);
    const warn = row.querySelector('.evw-warn');
    warn.textContent = info.hint;
    warn.hidden = !info.hint;
  }

  // ------------------------------------------------ Zusammenfassung + Vorschau

  function paintSummary(host) {
    const box = host && host.querySelector('.evw-summary');
    if (!box) return;
    const info = host._evwShown;
    box.innerHTML = '';
    box.hidden = !info;
    if (!info) return;
    box.classList.toggle('is-preview', !!info.preview);
    summaryLines(info).forEach(function (l) {
      const div = document.createElement('div');
      div.className = 'evw-sum-line' + (l.cls ? ' ' + l.cls : '');
      div.textContent = l.text;
      box.appendChild(div);
    });
  }

  function previewKey(host) {
    const fn = host._evwOpts && host._evwOpts.previewBody;
    if (typeof fn !== 'function') return null;
    try { return JSON.stringify(fn()); } catch (_) { return null; }
  }

  /**
   * Gespeicherten Stand zeigen (nach dem Laden vom Server, wenn die Felder
   * gefuellt sind) und den Formularstand als Vergleich merken: solange er
   * gleich bleibt, ist die Anzeige keine Vorschau.
   */
  function setSummary(host, info) {
    if (!host) return;
    host._evwSaved = info || null;
    host._evwDraft = null;
    host._evwShown = info || null;
    host._evwBaseline = previewKey(host);
    host._evwSeq = (host._evwSeq || 0) + 1;
    clearTimeout(host._evwTimer);
    paintSummary(host);
  }

  // Angezeigt wird der gespeicherte Stand, bei einem Entwurf dessen Vorschau
  // (Abfahrt, Ziel, Kapazitaet fuer „≈ kWh“) — die EOS-Zeile kommt immer aus
  // dem gespeicherten Stand.
  function showDraft(host) {
    const saved = host._evwSaved || {};
    const d = host._evwDraft;
    if (!d) host._evwShown = host._evwSaved;
    else if (d.previewError) host._evwShown = Object.assign({}, saved, { previewError: d.previewError });
    else {
      host._evwShown = Object.assign({}, saved, {
        resolved: d.resolved, preview: true,
        capacityWh: d.capacityWh != null ? d.capacityWh : saved.capacityWh,
        eos: saved.eos ? Object.assign({}, saved.eos, { resolved: saved.eos.resolved || saved.resolved }) : null
      });
    }
    paintSummary(host);
  }
  function sentCapacity(key) {
    try { const b = JSON.parse(key); return b && Number(b.capacityWh) > 0 ? Number(b.capacityWh) : null; } catch (_) { return null; }
  }

  /**
   * Gespeicherten Stand auffrischen (Abfragetakt), ohne den Entwurf oder
   * dessen Vergleichsstand zu verwerfen — sonst bliebe waehrend des
   * Bearbeitens eine veraltete EOS-Zeile stehen.
   */
  function updateSaved(host, info) {
    if (!host) return;
    if (!host._evwSaved) { setSummary(host, info); return; }
    const before = host._evwSaved.capacityWh;
    host._evwSaved = info || null;
    showDraft(host);
    // Kapazitaet anderswo geaendert, Entwurf rechnete mit der gespeicherten:
    // Vorschau neu holen, damit Ziel-% und „≈ kWh“ zusammenpassen.
    const d = host._evwDraft;
    if (d && d.capacityFromSaved && info && info.capacityWh !== before) refreshPreview(host);
  }

  function apiFetch(p, o) {
    const c = window.DVhubCommon;
    return c && typeof c.apiFetch === 'function' ? c.apiFetch(p, o) : fetch(p, o);
  }

  /** Nach einer Eingabe: Vorschau vom Server holen (entprellt, alte Antworten verworfen). */
  function refreshPreview(host) {
    if (!host || !host._evwSaved) return;
    clearTimeout(host._evwTimer);
    host._evwTimer = setTimeout(function () {
      const key = previewKey(host);
      const seq = (host._evwSeq || 0) + 1;
      host._evwSeq = seq;
      if (key === null) return;
      if (key === host._evwBaseline) { host._evwDraft = null; showDraft(host); return; }
      // Ersatz, falls die Antwort keine Kapazitaet nennt: die beim Senden gueltige.
      const savedCapAtSend = (host._evwSaved || {}).capacityWh;
      const capAtSend = sentCapacity(key) != null ? sentCapacity(key) : savedCapAtSend;
      apiFetch('/api/ev/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: key })
        .then(function (res) { return res.json().catch(function () { return { ok: false, error: 'HTTP ' + res.status }; }); })
        .then(function (body) {
          if (seq !== host._evwSeq) return;
          host._evwDraft = body && body.ok
            // Kapazitaet, mit der der Server das Ziel-% gerechnet hat (aus der Antwort).
            ? { resolved: body.resolved, capacityWh: Number(body.capacityWh) > 0 ? Number(body.capacityWh) : capAtSend, capacityFromSaved: sentCapacity(key) == null }
            : { previewError: (body && body.error) || 'unbekannter Fehler' };
          showDraft(host);
          // Gespeicherte Kapazitaet hat sich WAEHREND der Anfrage geaendert und
          // die Antwort passt nicht dazu: einmal neu holen. (Nur der Vergleich
          // mit dem Stand beim Senden — haengt der Abfragetakt hinter dem Server
          // her, bliebe sonst die Anfrage in einer Schleife.)
          const d = host._evwDraft;
          const now = (host._evwSaved || {}).capacityWh;
          if (d.capacityFromSaved && now !== savedCapAtSend && Number(now) !== d.capacityWh) refreshPreview(host);
        })
        .catch(function (err) {
          if (seq !== host._evwSeq) return;
          host._evwDraft = { previewError: err && err.message ? err.message : 'keine Verbindung' };
          showDraft(host);
        });
    }, 350);
  }

  function render(host, plan, opts) {
    if (!host) return;
    opts = opts || {};
    host._evwPlan = Array.isArray(plan) ? plan : [];
    const o = { defaultMin: opts.defaultMin };
    host.classList.add('evw');
    host.classList.add('evw-with-km');
    host._evwOpts = opts;
    host.innerHTML = '<div class="evw-summary" aria-live="polite" hidden></div>'
      + '<div class="evw-head"><span>Tag</span><span>Ankunft</span><span>Abfahrt</span><span title="Mindest-Ladestand bei der Abfahrt">Mind. %</span>'
      + '<span title="Verbrauch der Fahrt ab der Abfahrt bis zur nächsten Ankunft">Fahrt %</span></div>'
      + DAYS.map(function (_, i) { return rowHtml(entryFor(plan, i + 1), i, o); }).join('')
      + '<div class="evw-tools">'
      + '<button type="button" class="btn sm ghost evw-copy" title="Ankunft, Abfahrt, Mindest-Ladestand und Fahrt vom Montag auf Dienstag bis Freitag übertragen">Montag gleich für Mo–Fr</button>'
      + '<button type="button" class="btn sm ghost evw-clear" title="Alle Tage leeren">Leeren</button>'
      + '</div>'
      + '<p class="evw-hint">Jede Zeile gehört zum Tag der Ankunft. Liegt die Abfahrt nicht nach der Ankunft, gilt sie am Folgetag (20:00 → 05:00). Ohne Ankunft gilt die Abfahrt am Tag der Zeile. „Mind. %“: so voll ist das Auto bei der Abfahrt immer — leer heißt allgemeiner Wert. „Fahrt %“: so viel Ladestand braucht die Fahrt bis zur nächsten Ankunft; DVhub rechnet damit voraus, damit auch eine spätere Fahrt kurz danach noch reicht.</p>';
    host.querySelectorAll('.evw-row').forEach(markNextDay);
    paintSummary(host);
    if (host.dataset.evwWired === '1') return;
    host.dataset.evwWired = '1';
    const changed = function () {
      const cb = host._evwOpts && host._evwOpts.onChange;
      if (typeof cb === 'function') cb();
      refreshPreview(host);
    };
    host.addEventListener('input', function (e) {
      const row = e.target.closest && e.target.closest('.evw-row');
      if (row) markNextDay(row);
      changed();
    });
    host.addEventListener('click', function (e) {
      if (e.target.classList.contains('evw-copy')) {
        const src = host.querySelector('.evw-row[data-day="1"]');
        for (let d = 2; d <= 5; d += 1) {
          const row = host.querySelector('.evw-row[data-day="' + d + '"]');
          ['.evw-arr', '.evw-dep', '.evw-min', '.evw-trip'].forEach(function (sel) {
            const from = src.querySelector(sel); const to = row.querySelector(sel);
            if (from && to) to.value = from.value;
          });
          markNextDay(row);
        }
        changed();
      } else if (e.target.classList.contains('evw-clear')) {
        host.querySelectorAll('.evw-row input').forEach(function (inp) { inp.value = ''; });
        host.querySelectorAll('.evw-row').forEach(markNextDay);
        changed();
      }
    });
  }

  /**
   * Seit 1.0.10 zeigen Kachel und Integrationsseite dieselben Spalten
   * (Mindest-Ladestand, Fahrt) — nichts ist versteckt, der gelesene Plan gilt.
   * Bleibt fuer Aufrufer der alten Schnittstelle.
   */
  function keepHidden(readPlan) {
    return readPlan;
  }

  /** Plan aus dem Editor: 7 Eintraege, leere Felder → '' bzw. null. */
  function read(host) {
    const out = [];
    if (!host) return out;
    const finish = function () { return keepHidden(out); };
    host.querySelectorAll('.evw-row').forEach(function (row) {
      const num = function (sel) {
        const el = row.querySelector(sel);
        if (!el || String(el.value).trim() === '') return null;
        const v = Number(String(el.value).replace(',', '.'));
        return isFinite(v) ? v : null;
      };
      out.push({
        day: Number(row.getAttribute('data-day')),
        arrival: row.querySelector('.evw-arr').value || '',
        departure: row.querySelector('.evw-dep').value || '',
        minSocPct: num('.evw-min'),
        tripSocPct: num('.evw-trip')
      });
    });
    return finish();
  }

  /** Fehlertext oder null. opts.enabled: eingeschalteter Plan braucht eine Abfahrt (oder opts.hasOnce). */
  function validate(plan, opts) {
    for (let i = 0; i < plan.length; i += 1) {
      const e = plan[i];
      if (e.arrival && !e.departure) return DAY_NAMES[e.day - 1] + ': Ankunft ohne Abfahrt — bitte eine Abfahrt eintragen.';
    }
    // Eine einmalige Abfahrt allein genuegt (der Server rechnet damit).
    if (opts && opts.enabled && !opts.hasOnce && !plan.some(function (e) { return e.departure; })) return 'Mindestens eine Abfahrt eintragen.';
    return null;
  }

  /** Wird gerade im Editor getippt? (Neuaufbau beim Abfragetakt unterlassen) */
  function isEditing(host) {
    return !!(host && typeof document !== 'undefined' && document.activeElement && host.contains(document.activeElement));
  }

  window.DVhubEvWeekly = {
    render: render, read: read, validate: validate, keepHidden: keepHidden, isEditing: isEditing, DAYS: DAYS,
    rowInfo: rowInfo, summaryLines: summaryLines, setSummary: setSummary, updateSaved: updateSaved, refreshPreview: refreshPreview
  };
})();
