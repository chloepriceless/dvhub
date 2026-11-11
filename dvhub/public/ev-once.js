// ev-once.js -- Einmal-Ziel der E-Auto-Kachel (ev-tile.js) als Knopf + Dialog
// (Christin 11.11.2026, Prod-Test test-5: die dauerhaften Felder liessen offen,
// ab wann ein Eintrag aktiv ist und wann er endet).
//
// - Knopf „Einmalige Abfahrt planen“ oeffnet einen Dialog: Abfahrt (Datum +
//   Uhrzeit), mindestens %, unter „Erweitert“ der Verbrauch der Fahrt und
//   einmal „zuhause ab“ (seit T-0427 dieselben Begriffe wie im Wochenplan).
//   „Aktivieren“ speichert (POST /api/ev), „Abbrechen“ verwirft.
// - Solange aktiv, zeigt die Kachel einen Status-Chip mit „Ändern“/„Beenden“
//   (Text aus chip(), Daten aus GET /api/ev departure.onceInfo — der Server
//   sagt, ob es aktiv ist, was es ersetzt und was vorher noch kommt;
//   ev-departure.js describeEvOnce).
// - Ende: zur Abfahrt (10 min Vorlauf) bzw. beim Abstecken in der halben
//   Stunde davor; die Minuten-Wache raeumt es danach aus der Config.
//
// Reine Logik (validate, chip, effectLines, fmtAt, joinLocal, splitLocal) ohne
// DOM — test/ev-once-dialog.test.js laedt die Datei per vm. Kein Inline-JS,
// keine Inline-Styles (CSP); Stile in ev-tile.css (.ev-once-*).
//
// window.DVhubEvOnce = { validate, chip, effectLines, fmtAt, joinLocal, splitLocal, open, confirmEnd, attach }
// attach(host, { fetch, onSaved }): Knopf/Chip/Dialog in Leitstand-Kachel, Family-Panel und Integrationsseite.
(function () {
  'use strict';

  const MIN = 60000;
  const POLL_MS = 60000;

  // ------------------------------------------------------------ Formatieren

  /** „Fr 14.11. 07:30“ in DVhubs Zeitzone. */
  function fmtAt(iso, tz) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '—';
    const o = { timeZone: tz || 'Europe/Berlin' };
    const wd = d.toLocaleDateString('de-DE', Object.assign({ weekday: 'short' }, o)).replace('.', '');
    const dm = d.toLocaleDateString('de-DE', Object.assign({ day: '2-digit', month: '2-digit' }, o));
    const hm = d.toLocaleTimeString('de-DE', Object.assign({ hour: '2-digit', minute: '2-digit' }, o));
    return wd + ' ' + (dm.endsWith('.') ? dm : dm + '.') + ' ' + hm;
  }
  /** „07:30“ in DVhubs Zeitzone. */
  function fmtTime(iso, tz) {
    return new Date(iso).toLocaleTimeString('de-DE', { timeZone: tz || 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  }

  // Datum + Uhrzeit (Felder type=date/time, Ortszeit des Browsers) <-> ISO.
  // Halb ausgefuellt (nur Datum oder nur Uhrzeit) = null, leer = ''.
  function joinLocal(date, time) {
    date = String(date || '').trim(); time = String(time || '').trim();
    if (!date && !time) return '';
    if (!date || !/^\d{1,2}:\d{2}$/.test(time) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const d = new Date(date + 'T' + (time.length === 4 ? '0' + time : time));
    return isNaN(d) ? null : d.toISOString();
  }
  function splitLocal(iso) {
    const d = new Date(iso || '');
    if (!iso || isNaN(d)) return { date: '', time: '' };
    const p = function (n) { return String(n).padStart(2, '0'); };
    return { date: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()), time: p(d.getHours()) + ':' + p(d.getMinutes()) };
  }

  // ------------------------------------------------------------ Pruefen

  function pct(v) {
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(String(v).replace(',', '.'));
    return isFinite(n) ? n : NaN;
  }

  /**
   * Eingaben des Dialogs pruefen.
   * draft: { once: ISO|''|null, arrivalOnce: ISO|''|null, minSocPct, tripSocPct } (null = halb ausgefuellt)
   * c: { nowMs, leadMinutes, maxSocPct, enabled (Wochenplan an), plugged, nextArrivalAt, tz, storedArrivalOnce }
   * @returns {{ error: string|null, hints: string[] }}
   */
  function validate(draft, c) {
    c = c || {};
    const now = Number(c.nowMs) || Date.now();
    const lead = (Number(c.leadMinutes) || 10) * MIN;
    const hints = [];
    const fail = function (e) { return { error: e, hints: hints }; };
    if (draft.once === null) return fail('Abfahrt: bitte Datum und Uhrzeit angeben.');
    if (draft.arrivalOnce === null) return fail('Zuhause ab: bitte Datum und Uhrzeit angeben (oder beide Felder leeren).');
    const once = draft.once ? Date.parse(draft.once) : NaN;
    const arr = draft.arrivalOnce ? Date.parse(draft.arrivalOnce) : NaN;
    const min = pct(draft.minSocPct);
    const trip = pct(draft.tripSocPct);
    if (!isFinite(once) && !isFinite(arr)) return fail('Bitte die Abfahrt eintragen.');
    if (isFinite(once) && once <= now) return fail('Die Abfahrt liegt in der Vergangenheit.');
    if (isFinite(once) && once - lead <= now) return fail('Die Abfahrt muss mehr als ' + (lead / MIN) + ' min in der Zukunft liegen — so kurz vorher plant DVhub nicht mehr um.');
    if (min !== '' && !(min >= 0 && min <= 100)) return fail('Mindestens: 0–100 % oder leer.');
    if (trip !== '' && !(trip >= 0 && trip <= 100)) return fail('Verbrauch: 0–100 % oder leer.');
    if (!isFinite(once) && (min !== '' || trip !== '')) return fail('Mindestens und Verbrauch gehören zu einer Abfahrt — bitte die Abfahrt eintragen.');
    // Die schon gespeicherte Ankunft darf unveraendert bleiben (wie beim Server), auch wenn sie vorbei ist.
    const storedArr = c.storedArrivalOnce ? Date.parse(c.storedArrivalOnce) : NaN;
    if (isFinite(arr) && arr <= now && arr !== storedArr) return fail('„Zuhause ab“ liegt in der Vergangenheit.');
    if (isFinite(arr) && isFinite(once) && arr >= once) return fail('„Zuhause ab“ muss vor der Abfahrt liegen.');
    // Ohne Wochenplan gibt es keine Abfahrt, deren Ankunft sie ersetzen koennte (Codex 175975ce).
    if (isFinite(arr) && !isFinite(once) && c.enabled === false) return fail('Der Wochenplan ist aus — „zuhause ab“ allein bewirkt nichts. Bitte die Abfahrt dazu eintragen.');
    // Hinweise (speichern geht trotzdem)
    const next = c.nextArrivalAt ? Date.parse(c.nextArrivalAt) : NaN;
    if (isFinite(once) && !isFinite(arr) && c.plugged !== true && isFinite(next) && next > now && next > once) {
      hints.push('Die Abfahrt liegt vor „zuhause ab“ laut Plan (' + fmtAt(c.nextArrivalAt, c.tz) + '): Das Auto ist bis dahin unterwegs, DVhub kann vorher nicht laden. Bist du früher zuhause, unter „Erweitert“ einmal „zuhause ab“ eintragen.');
    }
    const max = Number(c.maxSocPct);
    if (min !== '' && c.maxSocPct !== null && c.maxSocPct !== '' && isFinite(max) && max > 0 && min > max) {
      hints.push('Mindestens ' + min + ' % liegt über „Max, wenn günstig“ (' + max + ' %): Für diese Abfahrt lädt DVhub bis ' + min + ' %, danach gilt wieder ' + max + ' %.');
    }
    if (c.enabled === false && isFinite(once)) {
      hints.push('Der Wochenplan ist aus und bleibt aus: Diese Abfahrt ist dann die einzige, die DVhub plant. Danach plant DVhub wieder keine Abfahrt.');
    }
    return { error: null, hints: hints };
  }

  // ------------------------------------------------------------ Status

  /**
   * Was das Einmal-Ziel bewirkt (Chip in der Kachel und Vorschau im Dialog).
   * info: departure.onceInfo bzw. once aus POST /api/ev/preview (describeEvOnce).
   */
  function effectLines(info, c) {
    c = c || {};
    const tz = c.tz;
    const lines = [];
    const d = info && info.departure;
    const weeklyOff = info && (info.weeklyEnabled === false || (info.weeklyEnabled === undefined && info.enabled === false));
    if (d && d.state === 'active' && weeklyOff) {
      lines.push('Der Wochenplan ist aus — das ist die einzige geplante Abfahrt.');
      if (d.tripSocPct !== null && d.tripSocPct !== undefined) lines.push('Verbrauch dieser Fahrt ≈ ' + d.tripSocPct + ' %.');
      const unplugOff = Date.parse(d.at) - (Number(info.unplugWindowMinutes) || 30) * MIN;
      lines.push('Endet von selbst mit der Abfahrt — oder wenn du das Auto ab ' + fmtTime(new Date(unplugOff).toISOString(), tz) + ' absteckst.');
    } else if (d && d.state === 'active') {
      if (d.replaces && d.replaces.departureAt) lines.push('Statt Wochenplan ' + fmtAt(d.replaces.departureAt, tz) + (d.targetFrom === 'weekly' ? ' (Ziel von dort)' : '') + '.');
      else lines.push('Zusätzlich zum Wochenplan.');
      if (d.weeklyBefore > 0 && d.nextWeeklyAt) {
        lines.push('Davor gilt der Wochenplan weiter: nächste Abfahrt ' + fmtAt(d.nextWeeklyAt, tz) + (d.weeklyBefore > 1 ? ' (+' + (d.weeklyBefore - 1) + ' weitere)' : '') + '.');
      } else lines.push('Das ist die nächste Abfahrt.');
      if (d.tripSocPct !== null && d.tripSocPct !== undefined) lines.push('Verbrauch dieser Fahrt ≈ ' + d.tripSocPct + ' %.');
      const unplugMs = Date.parse(d.at) - (Number(info.unplugWindowMinutes) || 30) * MIN;
      lines.push('Endet von selbst mit der Abfahrt — oder wenn du das Auto ab ' + fmtTime(new Date(unplugMs).toISOString(), tz) + ' absteckst.');
    }
    const a = info && info.arrival;
    if (a && (a.state === 'active' || a.state === 'pending')) {
      lines.push('Einmal zuhause ab ' + fmtAt(a.at, tz) + (a.state === 'pending' ? ' (gilt nach der Abfahrt davor)' : ' statt laut Wochenplan') + '.');
    }
    return lines;
  }

  /**
   * Chip in der Kachel oder null (dann der Knopf „Einmalige Abfahrt planen“).
   * @returns {null|{ kind: 'active', title: string, lines: string[] }}
   */
  function chip(info, c) {
    c = c || {};
    if (!info) return null;
    const d = info.departure && info.departure.state === 'active' ? info.departure : null;
    const a = info.arrival && (info.arrival.state === 'active' || info.arrival.state === 'pending') ? info.arrival : null;
    if (!d && !a) return null;
    const lines = effectLines(info, c);
    if (d) {
      const own = d.targetFrom === 'once';
      const title = 'Einmalig: ' + fmtAt(d.at, c.tz) + (d.targetSocPct !== null && d.targetSocPct !== undefined ? ' · mind. ' + d.targetSocPct + '\u00a0%' + (own ? '' : ' (wie Plan)') : '');
      return { kind: 'active', title: title, lines: lines };
    }
    if (info.weeklyEnabled === false) {
      return { kind: 'active', title: 'Einmal zuhause ab: ' + fmtAt(a.at, c.tz) + ' — wirkt nicht', lines: ['Der Wochenplan ist aus und es gibt keine Abfahrt dazu. „Beenden“ löscht sie.'] };
    }
    return { kind: 'active', title: 'Einmal zuhause ab: ' + fmtAt(a.at, c.tz), lines: ['Gilt vor der nächsten Abfahrt statt „zuhause ab“ laut Plan; endet mit dieser Abfahrt.'] };
  }

  // ------------------------------------------------------------ Dialog (DOM)

  const DIALOG = [
    '<div class="ev-once-dialog" role="dialog" aria-modal="true" aria-labelledby="evOnceDlgTitle" aria-describedby="evOnceDlgIntro" tabindex="-1">',
    '  <h2 class="ev-once-title" id="evOnceDlgTitle">Einmalige Abfahrt planen</h2>',
    '  <p class="ev-once-intro" id="evOnceDlgIntro">F&uuml;r eine Fahrt au&szlig;er der Reihe &mdash; z. B. morgen fr&uuml;her los oder eine l&auml;ngere Strecke. Gilt genau einmal und endet mit der Abfahrt; der Wochenplan bleibt, wie er ist (an oder aus).</p>',
    '  <div class="ev-once-group">',
    '    <span class="ev-once-label" id="evOnceDepL">Abfahrt</span>',
    '    <div class="ev-once-dt" role="group" aria-labelledby="evOnceDepL">',
    '      <input type="date" class="input mono" id="evOnceDate" aria-label="Abfahrt Datum">',
    '      <input type="time" class="input mono" id="evOnceTime" aria-label="Abfahrt Uhrzeit">',
    '    </div>',
    '    <p class="ev-once-help" id="evOnceDepHelp">Bis dahin soll das Auto geladen sein. Ersetzt die Abfahrt aus dem Wochenplan, die am n&auml;chsten liegt (h&ouml;chstens 24&nbsp;h entfernt); Abfahrten davor bleiben mit ihrem Ziel.</p>',
    '  </div>',
    '  <div class="ev-once-group">',
    '    <label class="ev-once-label" for="evOnceMinIn">Mindestens bei Abfahrt</label>',
    '    <span class="ev-once-pct"><input type="number" inputmode="numeric" class="input mono" id="evOnceMinIn" min="0" max="100" step="5"><span class="ev-unit">%</span></span>',
    '    <p class="ev-once-help" id="evOnceMinHelp">Ladestand, der zur Abfahrt sicher erreicht sein soll. Leer = Wert des Wochenplans.</p>',
    '  </div>',
    '  <details class="ev-once-more" id="evOnceMore">',
    '    <summary>Erweitert: Verbrauch, zuhause ab</summary>',
    '    <div class="ev-once-group">',
    '      <label class="ev-once-label" for="evOnceTripIn">Verbrauch dieser Fahrt &asymp;</label>',
    '      <span class="ev-once-pct"><input type="number" inputmode="numeric" class="input mono" id="evOnceTripIn" min="0" max="100" step="1"><span class="ev-unit">%</span></span>',
    '      <p class="ev-once-help">So viel Ladestand kostet die Fahrt ab dieser Abfahrt bis zur Heimkehr. Damit sch&auml;tzt DVhub den Ladestand bei Ankunft und l&auml;dt bei knappen Folgefahrten vorher mehr. Leer = wie im Wochenplan.</p>',
    '    </div>',
    '    <div class="ev-once-group">',
    '      <span class="ev-once-label" id="evOnceArrL">Einmal zuhause ab</span>',
    '      <button type="button" class="btn sm ev-once-arr-add" id="evOnceArrAdd">+ Zeit eintragen</button>',
    '      <div class="ev-once-dt" id="evOnceArrRow" role="group" aria-labelledby="evOnceArrL" hidden>',
    '        <input type="date" class="input mono" id="evOnceArrDate" aria-label="Zuhause ab Datum">',
    '        <input type="time" class="input mono" id="evOnceArrTime" aria-label="Zuhause ab Uhrzeit">',
    '        <button type="button" class="btn sm ghost ev-once-clear" id="evOnceArrClear" aria-label="Zuhause ab leeren">&#x2715;</button>',
    '      </div>',
    '      <p class="ev-once-help">Nur wenn das Auto vor dieser Abfahrt zu einer anderen Zeit zuhause ist als im Wochenplan (z. B. heute sp&auml;ter). Gilt einmal; geht auch ohne Abfahrt.</p>',
    '    </div>',
    '  </details>',
    '  <div class="ev-once-effect" id="evOnceEffect" aria-live="polite" hidden></div>',
    '  <div class="ev-once-hints" id="evOnceHints" hidden></div>',
    '  <div class="ev-once-error" id="evOnceError" role="alert" hidden></div>',
    '  <div class="ev-once-actions">',
    '    <button type="button" class="btn ghost" id="evOnceCancel">Abbrechen</button>',
    '    <button type="button" class="btn primary" id="evOnceSave">Aktivieren</button>',
    '  </div>',
    '</div>'
  ].join('\n');

  let overlay = null;
  let lastFocus = null;
  let onKey = null;

  function close() {
    if (!overlay) return;
    try { overlay.remove(); } catch (_) { /* weg */ }
    overlay = null;
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
    try { document.body.classList.remove('ev-once-open'); } catch (_) { /* egal */ }
    if (lastFocus && typeof lastFocus.focus === 'function') { try { lastFocus.focus(); } catch (_) { /* egal */ } }
  }

  function mountOverlay(html) {
    close();
    lastFocus = document.activeElement;
    overlay = document.createElement('div');
    overlay.className = 'ev-once-overlay';
    overlay.innerHTML = html;   // nur festes Markup, Werte per value/textContent
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) overlay.dataset.downOutside = '1'; });
    document.body.appendChild(overlay);
    document.body.classList.add('ev-once-open');
    return overlay.firstElementChild;
  }

  // Tab bleibt im Dialog, Esc = Abbrechen (Capture: die Family-Ansicht schliesst sonst ihr Panel).
  function trapKeys(dlg, cancel) {
    onKey = function (e) {
      if (!overlay) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
      if (e.key !== 'Tab') return;
      const f = Array.prototype.filter.call(dlg.querySelectorAll('button, input, summary, [tabindex="0"]'), function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
  }

  function show(box, list, cls) {
    box.textContent = '';
    (list || []).forEach(function (t) {
      const p = document.createElement('p');
      if (cls) p.className = cls;
      p.textContent = t;
      box.appendChild(p);
    });
    box.hidden = !(list && list.length);
  }

  /**
   * Dialog oeffnen.
   * o.data: Antwort von GET /api/ev (Kontext: Zeitzone, Max, Plan, Ankunft).
   * o.current: true = vorhandenes Einmal-Ziel aendern (Felder vorbelegt).
   * o.save(departure) -> Promise<{ ok, error? }>: speichert (POST /api/ev).
   * o.preview(departure) -> Promise<body|null>: POST /api/ev/preview.
   */
  function open(o) {
    const data = o.data || {};
    const dep = data.departure || {};
    const info = dep.onceInfo || {};
    const tz = (dep.resolved && dep.resolved.timeZone) || 'Europe/Berlin';
    const dlg = mountOverlay(DIALOG);
    const $ = function (id) { return dlg.querySelector('#' + id); };
    const editing = !!o.current;
    $('evOnceDlgTitle').textContent = editing ? 'Einmalige Abfahrt ändern' : 'Einmalige Abfahrt planen';
    $('evOnceSave').textContent = editing ? 'Speichern' : 'Aktivieren';

    // Vorbelegen: beim Aendern die gespeicherten Werte, sonst morgen zur
    // naechsten Abfahrtszeit des Plans (bzw. 07:00).
    const curDep = info.departure && info.departure.state === 'active' ? dep.once : '';
    const curArr = info.arrival && info.arrival.state !== 'ended' ? dep.arrivalOnce : '';
    let depParts = splitLocal(editing ? curDep : '');
    if (!editing) {
      const base = new Date(Date.now() + 86400000);
      const nextDep = dep.resolved && dep.resolved.departureAt ? splitLocal(dep.resolved.departureAt).time : '07:00';
      depParts = { date: splitLocal(base.toISOString()).date, time: nextDep || '07:00' };
    }
    $('evOnceDate').value = depParts.date;
    $('evOnceTime').value = depParts.time;
    $('evOnceDate').min = splitLocal(new Date().toISOString()).date;
    const arrParts = splitLocal(editing ? curArr : '');
    $('evOnceArrDate').value = arrParts.date;
    $('evOnceArrTime').value = arrParts.time;
    // Ankunftsfelder erst auf Wunsch: ein leeres Datumsfeld zeigt in WebKit
    // sonst schon ein Datum und sieht ausgefuellt aus.
    const showArr = function (on) { $('evOnceArrRow').hidden = !on; $('evOnceArrAdd').hidden = on; };
    showArr(!!arrParts.date);
    $('evOnceMinIn').value = editing && dep.onceMinSocPct != null ? dep.onceMinSocPct : '';
    $('evOnceTripIn').value = editing && dep.onceTripSocPct != null ? dep.onceTripSocPct : '';
    const planMin = dep.defaultMinSocPct != null ? dep.defaultMinSocPct : null;
    $('evOnceMinIn').placeholder = planMin != null ? 'Plan' : '';
    $('evOnceTripIn').placeholder = 'Plan';
    if (editing && (curArr || dep.onceTripSocPct != null)) $('evOnceMore').open = true;
    // Wochenplan aus: das Einmal-Ziel ist die einzige Abfahrt und ersetzt nichts.
    if (dep.enabled !== true) {
      $('evOnceDepHelp').textContent = 'Bis dahin soll das Auto geladen sein. Der Wochenplan ist aus — das ist die einzige geplante Abfahrt.';
      $('evOnceMinHelp').textContent = 'Ladestand, der zur Abfahrt sicher erreicht sein soll. Leer = allgemeiner Wert „Mindestens bei Abfahrt“.';
    }

    const ctxV = function () {
      const res = dep.resolved || {};
      const nextArrival = (data.arrival && data.arrival.at) || res.arrivalAt || null;
      return {
        nowMs: Date.now(), leadMinutes: info.leadMinutes || 10, maxSocPct: dep.maxSocPct, enabled: dep.enabled === true,
        plugged: data.vehicle ? data.vehicle.plugged : null, nextArrivalAt: nextArrival, tz: tz,
        storedArrivalOnce: dep.arrivalOnce || null
      };
    };
    const draft = function () {
      return {
        once: joinLocal($('evOnceDate').value, $('evOnceTime').value),
        arrivalOnce: joinLocal($('evOnceArrDate').value, $('evOnceArrTime').value),
        minSocPct: $('evOnceMinIn').value, tripSocPct: $('evOnceTripIn').value
      };
    };
    const body = function (d) {
      const out = {
        once: d.once || '', arrivalOnce: d.arrivalOnce || '',
        onceMinSocPct: d.once ? pct(d.minSocPct) : '', onceTripSocPct: d.once ? pct(d.tripSocPct) : ''
      };
      return out;
    };

    let pvTimer = null;
    let pvSeq = 0;
    function refresh() {
      const d = draft();
      const v = validate(d, ctxV());
      show($('evOnceError'), v.error ? [v.error] : [], '');
      show($('evOnceHints'), v.hints, '');
      $('evOnceSave').disabled = !!v.error;
      clearTimeout(pvTimer);
      if (v.error || typeof o.preview !== 'function') { show($('evOnceEffect'), [], ''); return; }
      const seq = ++pvSeq;
      pvTimer = setTimeout(function () {
        Promise.resolve(o.preview(body(d))).then(function (out) {
          if (seq !== pvSeq || !overlay || !out || !out.once) return;
          const lines = effectLines(out.once, { tz: tz });
          const r = out.resolved || {};
          if (out.once.departure && out.once.departure.targetSocPct != null) lines.unshift('Mindestens ' + out.once.departure.targetSocPct + ' % bis ' + fmtAt(out.once.departure.at, tz) + '.');
          else if (r.departureAt && !out.once.departure) lines.unshift('Nächste Abfahrt ' + fmtAt(r.departureAt, tz) + '.');
          show($('evOnceEffect'), lines, '');
        }).catch(function () { /* Vorschau ist nur Beiwerk */ });
      }, 300);
    }

    dlg.addEventListener('input', refresh);
    dlg.addEventListener('change', refresh);
    $('evOnceArrClear').addEventListener('click', function () { $('evOnceArrDate').value = ''; $('evOnceArrTime').value = ''; showArr(false); refresh(); try { $('evOnceArrAdd').focus(); } catch (_) { /* egal */ } });
    $('evOnceArrAdd').addEventListener('click', function () {
      showArr(true);
      if (!$('evOnceArrDate').value) $('evOnceArrDate').value = splitLocal(new Date().toISOString()).date;
      refresh();
      try { $('evOnceArrTime').focus(); } catch (_) { /* egal */ }
    });
    $('evOnceCancel').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      // Tipp auf den Hintergrund = Abbrechen (nur wenn er dort auch begann — Markieren im Feld zieht sonst raus).
      if (e.target === overlay && overlay.dataset.downOutside === '1') close();
      if (overlay) overlay.dataset.downOutside = '';
    });
    $('evOnceSave').addEventListener('click', async function () {
      const d = draft();
      const v = validate(d, ctxV());
      if (v.error) { refresh(); return; }
      const btn = $('evOnceSave');
      btn.disabled = true;
      $('evOnceCancel').disabled = true;
      try {
        const out = await o.save(body(d));
        if (out && out.ok) { close(); return; }
        show($('evOnceError'), ['Nicht gespeichert: ' + ((out && out.error) || 'unbekannter Fehler')], '');
      } catch (e) {
        show($('evOnceError'), ['Nicht gespeichert: ' + e.message], '');
      }
      if (overlay) { btn.disabled = false; $('evOnceCancel').disabled = false; }
    });
    trapKeys(dlg, close);
    refresh();
    try { (editing ? $('evOnceSave') : $('evOnceDate')).focus(); } catch (_) { /* egal */ }
    return dlg;
  }

  /** Rueckfrage „Einmal-Ziel beenden?“ im selben Stil. Promise<boolean>. */
  function confirmEnd(text) {
    return new Promise(function (resolve) {
      const dlg = mountOverlay([
        '<div class="ev-once-dialog ev-once-confirm" role="alertdialog" aria-modal="true" aria-labelledby="evOnceEndTitle" aria-describedby="evOnceEndText" tabindex="-1">',
        '  <h2 class="ev-once-title" id="evOnceEndTitle">Einmal-Ziel beenden?</h2>',
        '  <p class="ev-once-intro" id="evOnceEndText"></p>',
        '  <div class="ev-once-actions">',
        '    <button type="button" class="btn ghost" id="evOnceEndNo">Abbrechen</button>',
        '    <button type="button" class="btn danger" id="evOnceEndYes">Beenden</button>',
        '  </div>',
        '</div>'
      ].join('\n'));
      dlg.querySelector('#evOnceEndText').textContent = text || 'Danach gilt wieder nur der Wochenplan.';
      const done = function (v) { close(); resolve(v); };
      dlg.querySelector('#evOnceEndNo').addEventListener('click', function () { done(false); });
      dlg.querySelector('#evOnceEndYes').addEventListener('click', function () { done(true); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(false); });
      trapKeys(dlg, function () { done(false); });
      try { dlg.querySelector('#evOnceEndNo').focus(); } catch (_) { /* egal */ }
    });
  }

  // ------------------------------------------------------------ Knopf + Chip

  // Gleiches Markup in Leitstand-Kachel, Family-Panel (beide ueber ev-tile.js)
  // und Integrationsseite. Nur festes Markup; Texte per textContent.
  const SLOT = [
    '<div class="ev-once-chip" data-evo="chip" role="status" hidden>',
    '  <div class="ev-once-chip-title" data-evo="title">&mdash;</div>',
    '  <div class="ev-once-chip-lines" data-evo="lines"></div>',
    '  <div class="ev-once-chip-actions">',
    '    <button type="button" class="btn sm" data-evo="edit">&Auml;ndern</button>',
    '    <button type="button" class="btn sm ghost" data-evo="end">Beenden</button>',
    '  </div>',
    '</div>',
    '<div class="ev-once-start" data-evo="start" hidden>',
    '  <button type="button" class="btn sm" data-evo="plan" title="F&uuml;r eine Fahrt au&szlig;er der Reihe: einmal Abfahrt und Mindest-Ladestand festlegen. Gilt genau einmal; der Wochenplan bleibt, wie er ist.">+ Einmalige Abfahrt planen</button>',
    '</div>',
    '<div class="ev-once-msg" data-evo="msg" role="status" hidden></div>'
  ].join('\n');

  const controllers = typeof WeakMap === 'function' ? new WeakMap() : null;

  /** Fehlermeldung des Servers beim Speichern in Klartext. */
  function saveError(res, body) {
    if (body && body.error === 'pro_required') return 'E-Auto-Planung braucht DVhub Pro.';
    if (body && body.code === 'once_in_past') return 'Die Abfahrt liegt in der Vergangenheit (oder in weniger als 10 min).';
    if (body && body.code === 'arrival_once_in_past') return '„Zuhause ab“ liegt in der Vergangenheit.';
    if (res && (res.status === 401 || res.status === 403)) return 'Keine Berechtigung (Anmeldung nötig).';
    return (body && body.error) || ('HTTP ' + (res ? res.status : '?'));
  }

  /**
   * Knopf „Einmalige Abfahrt planen“ bzw. Chip mit Ändern/Beenden in `host`.
   * o.fetch(path, opts) → Response (DVhubCommon.apiFetch); o.onSaved(): nach
   * dem Speichern (Kachel: neu laden); ohne onSaved laedt der Baustein GET
   * /api/ev selbst neu. Gespeichert wird immer ueber POST /api/ev (nur die
   * Einmal-Felder) — gleiche Rechte wie die Kachel: Anmeldung + Pro.
   * o.poll: true = alle POLL_MS selbst GET /api/ev, solange der Host im Dokument
   * und die Seite sichtbar ist (Integrationsseite; die Kachel fragt selbst).
   * @returns {{ render(data), refresh(): Promise, data(): object|null, active(): boolean }}
   */
  function attach(host, o) {
    if (!host) return null;
    let ctl = controllers ? controllers.get(host) : host.__evOnce;
    if (ctl) { ctl.opts = o || ctl.opts; return ctl; }
    host.innerHTML = SLOT;
    const q = function (k) { return host.querySelector('[data-evo="' + k + '"]'); };
    const state = { data: null, msgTimer: null };
    const fetcher = function (path, opts) { return (o && o.fetch ? o.fetch : fetch)(path, opts); };
    const tzOf = function () { const d = state.data && state.data.departure; return (d && d.resolved && d.resolved.timeZone) || 'Europe/Berlin'; };
    function msg(text, isError) {
      const m = q('msg');
      clearTimeout(state.msgTimer);
      m.textContent = text || '';
      m.hidden = !text;
      m.classList.toggle('is-error', !!isError);
      if (text && !isError) state.msgTimer = setTimeout(function () { m.hidden = true; }, 5000);
    }
    function render(data) {
      if (data) state.data = data;
      const info = state.data && state.data.departure && state.data.departure.onceInfo;
      const c = chip(info, { tz: tzOf() });
      q('chip').hidden = !c;
      q('start').hidden = !!c || !state.data;
      if (!c) return;
      q('title').textContent = c.title;
      const box = q('lines');
      box.textContent = '';
      c.lines.forEach(function (t) { const p = document.createElement('div'); p.textContent = t; box.appendChild(p); });
    }
    async function refresh() {
      try {
        const res = await fetcher('/api/ev');
        if (!res.ok) return;
        const body = await res.json();
        if (body && body.ok) render(body);
      } catch (_) { /* naechstes Mal */ }
    }
    async function save(departure, okText) {
      try {
        const res = await fetcher('/api/ev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ departure: departure }) });
        let body = {};
        try { body = await res.json(); } catch (_) { /* leer */ }
        if (!res.ok || !body.ok) return { ok: false, error: saveError(res, body) };
        msg(okText);
        if (ctl.opts && typeof ctl.opts.onSaved === 'function') ctl.opts.onSaved(); else refresh();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    async function preview(departure) {
      try {
        const res = await fetcher('/api/ev/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ departure: departure }) });
        return res.ok ? await res.json() : null;
      } catch (_) { return null; }
    }
    function openDialog(editing) {
      if (!state.data) return;
      open({
        data: state.data, current: editing, preview: preview,
        save: function (d) { return save(d, editing ? 'Einmal-Ziel geändert.' : 'Einmal-Ziel aktiv — EOS plant damit beim nächsten Lauf.'); }
      });
    }
    host.addEventListener('click', function (e) {
      const b = e.target && e.target.closest ? e.target.closest('[data-evo]') : null;
      if (!b || !host.contains(b)) return;
      const k = b.getAttribute('data-evo');
      if (k === 'plan') openDialog(false);
      else if (k === 'edit') openDialog(true);
      else if (k === 'end') {
        const i = state.data && state.data.departure && state.data.departure.onceInfo;
        confirmEnd('Die einmalige Abfahrt (und ein einmaliges „zuhause ab“) wird gelöscht. '
          + (i && i.weeklyEnabled === false ? 'Danach plant DVhub keine Abfahrt — der Wochenplan ist aus.' : 'Danach gilt wieder nur der Wochenplan.')).then(async function (yes) {
          if (!yes) return;
          const out = await save({ once: '', onceMinSocPct: '', onceTripSocPct: '', arrivalOnce: '' }, 'Einmal-Ziel beendet.');
          if (!out.ok) msg('Nicht beendet: ' + out.error, true);
        });
      }
    });
    if (o && o.poll) {
      // Ablauf oder Abstecken zeigen, ohne dass jemand neu laedt (Codex 175975ce).
      const timer = setInterval(function () {
        if (!document.documentElement.contains(host)) { clearInterval(timer); return; }
        if (!document.hidden) refresh();
      }, POLL_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden && document.documentElement.contains(host)) refresh(); });
    }
    ctl = {
      opts: o || {}, render: render, refresh: refresh,
      data: function () { return state.data; },
      active: function () { const i = state.data && state.data.departure && state.data.departure.onceInfo; return !!(i && i.departure && i.departure.state === 'active'); }
    };
    if (controllers) controllers.set(host, ctl); else host.__evOnce = ctl;
    return ctl;
  }

  window.DVhubEvOnce = {
    validate: validate, chip: chip, effectLines: effectLines, fmtAt: fmtAt,
    joinLocal: joinLocal, splitLocal: splitLocal, open: open, confirmEnd: confirmEnd, close: close,
    attach: attach, saveError: saveError
  };
})();
