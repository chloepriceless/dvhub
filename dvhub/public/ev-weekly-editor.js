// ev-weekly-editor.js -- E-Auto-Planung: gemeinsamer Baustein für Leitstand-
// Kachel, Family-Ansicht (beide ev-tile.js) und Integrationsseite.
//
// Bedienkonzept seit T-0427 (Christin 11.11.2026: „die Felder und die Eingabe
// sind sehr unintuitiv“; mobil zuerst, Home-Screen-Webapp am iPhone):
//   1. Erst die allgemeinen Werte („Standard: mindestens … % bei Abfahrt“,
//      „wenn günstig bis … %“), dann je Tag nur Abweichungen.
//   2. Je Tag eine Karte in Klartext („Di · 08:30 · mind. 80 %“) mit Schalter
//      „fahre an diesem Tag“ — aus = kein Termin, statt leerer Zeitfelder.
//      Antippen öffnet ein Blatt (gleiches Muster wie das Einmal-Ziel,
//      ev-once.css): Abfahrt, mindestens (Knöpfe 50–100 % + frei), unter
//      „Erweitert“ zuhause ab und Verbrauch der Fahrt mit „→ bei Ankunft ≈ X %“.
//   3. Schnellstart: „Pendeln Mo–Fr einrichten“, „Wie Montag“ im Blatt,
//      „Woche leeren“.
//   4. Rückmeldung in Klartext oben (nächste Abfahrt, wann geladen wird);
//      Technik (EOS, Wertstufen) nur eingeklappt unter „Details“.
//   Breit (ab ~640 px) stehen die sieben Karten als Wochenleiste nebeneinander.
//
// Datenmodell (ev-departure.js): Zeile = Tag der ABFAHRT
//   { day 1..7, departure 'HH:MM'|'', minSocPct, tripSocPct, homeFrom 'HH:MM'|'', homeFromPrevDay }
// je Tag mindestens eine Zeile; eine zweite Abfahrt am selben Tag kommt nur aus
// umgerechneten alten Plänen und lässt sich löschen. Gesendet wird
// `weeklyDepartures`; der Server rechnet die Vorschau (POST /api/ev/preview)
// mit seiner eigenen Auflösung — keine zweite Logik im Browser.
//
// Kein Inline-JS, keine Inline-Styles (CSP). Reine Logik (rowInfo,
// summaryLines, validate, arrivalSocPct, cardText) ohne DOM —
// test/ev-weekly-editor.test.js lädt die Datei per vm.
//
// window.DVhubEvWeekly = { render(host, plan, opts), read(host), readSettings(host),
//   validate(plan, opts), rowInfo(entry), cardText(entry, defMin), arrivalSocPct(min, trip),
//   summaryLines(info), setSummary(host, info), updateSaved(host, info), refreshPreview(host),
//   legacyCommuteHint(km), clearDay(host, day), clearFields(ids), isEditing(host), DAYS, DAY_NAMES }
// opts: { settings: { enabled, minSocPct, maxSocPct }, migration: Hinweis|null,
//   onMigrationSeen(), onChange(), previewBody(), legacyCommuteKm }
(function () {
  'use strict';

  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  const MIN_CHIPS = [50, 60, 70, 80, 90, 100];
  const FALLBACK_TIME = '07:30';
  // ev-departure.js EARLY_DEPARTURE_HINT_BEFORE (06:00)
  const EARLY_BEFORE_MIN = 6 * 60;
  const NBSP = ' ';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Wie ev-departure.js parseTime: „H:MM“/„HH:MM“, 00:00–23:59.
  function minutes(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }
  function hhmm(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
  function pad5(t) { const m = minutes(t); return m === null ? '' : hhmm(m); }
  function pctOrNull(v) {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }
  const dayIdx = function (d) { return Math.max(0, Math.min(6, Number(d) - 1 || 0)); };
  const prevIdx = function (i) { return (i + 6) % 7; };

  /** Wie ev-departure.js defaultHomeFromPrevDay: nicht vor der Abfahrt → Vortag. */
  function defaultPrevDay(homeFrom, departure) {
    const h = minutes(homeFrom); const d = minutes(departure);
    if (h === null) return false;
    return d === null || h >= d;
  }

  function normRow(e) {
    const day = Number(e && e.day);
    const departure = pad5(e && e.departure);
    const homeFrom = pad5(e && e.homeFrom);
    return {
      day: day >= 1 && day <= 7 ? day : 1,
      departure: departure,
      minSocPct: pctOrNull(e && e.minSocPct),
      tripSocPct: pctOrNull(e && e.tripSocPct),
      homeFrom: homeFrom,
      homeFromPrevDay: homeFrom ? (typeof (e && e.homeFromPrevDay) === 'boolean' ? e.homeFromPrevDay : defaultPrevDay(homeFrom, departure)) : false
    };
  }
  function emptyRow(day) { return { day: day, departure: '', minSocPct: null, tripSocPct: null, homeFrom: '', homeFromPrevDay: false }; }

  /** Feste Form wie ev-departure.js normalizeDepartureRows (je Tag mind. eine Zeile, nach Uhrzeit). */
  function normalizePlan(list) {
    // Ungültige Tage fallen weg (wie am Server).
    const rows = (Array.isArray(list) ? list : []).filter(function (e) { const d = Number(e && e.day); return d >= 1 && d <= 7 && Math.floor(d) === d; }).map(normRow);
    const out = [];
    for (let day = 1; day <= 7; day += 1) {
      const mine = rows.filter(function (r) { return r.day === day && r.departure; })
        .sort(function (a, b) { return minutes(a.departure) - minutes(b.departure) || Number(b.homeFromPrevDay) - Number(a.homeFromPrevDay); });
      if (mine.length) out.push.apply(out, mine); else out.push(emptyRow(day));
    }
    return out;
  }

  /** Erwarteter Ladestand bei der Heimkehr: Ladestand bei Abfahrt − Verbrauch; ohne Verbrauch null. */
  function arrivalSocPct(minPct, tripPct) {
    const m = Number(minPct); const t = Number(tripPct);
    if (tripPct === null || tripPct === undefined || tripPct === '' || !(t > 0) || !isFinite(m)) return null;
    return Math.max(0, Math.round(m - t));
  }

  /**
   * Was DVhub aus einer Zeile macht (Regeln wie ev-departure.js planWindows).
   * @returns {{ off, text, homeText, hint, error }}  text: „Abfahrt Di 08:30“;
   *   homeText: „zuhause ab Mo 19:15“; hint: Nacht-Hinweis; error: Widerspruch.
   */
  function rowInfo(e) {
    const r = normRow(e || {});
    const i = dayIdx(r.day);
    const d = minutes(r.departure);
    const h = minutes(r.homeFrom);
    const out = { off: d === null, text: '', homeText: '', hint: '', error: '' };
    if (d === null) {
      if (h !== null) out.error = DAY_NAMES[i] + ': „zuhause ab“ ohne Abfahrt — bitte die Abfahrt eintragen.';
      return out;
    }
    out.text = 'Abfahrt ' + DAYS[i] + ' ' + hhmm(d);
    if (h !== null) {
      if (!r.homeFromPrevDay && h >= d) out.error = DAY_NAMES[i] + ': „zuhause ab“ muss vor der Abfahrt liegen — oder „am Vortag“ wählen.';
      out.homeText = 'zuhause ab ' + DAYS[r.homeFromPrevDay ? prevIdx(i) : i] + ' ' + hhmm(h);
    } else if (d < EARLY_BEFORE_MIN) {
      out.hint = 'Nacht von ' + DAY_NAMES[prevIdx(i)] + ' auf ' + DAY_NAMES[i];
    }
    return out;
  }

  /** Kartentext: { time, min, sub } — min mit Standard, sub: zuhause ab · Verbrauch → bei Ankunft. */
  function cardText(e, defMin) {
    const r = normRow(e || {});
    const info = rowInfo(r);
    if (info.off) return { time: '', min: '', sub: 'kein Termin', minOwn: false };
    const own = r.minSocPct !== null;
    const minVal = own ? r.minSocPct : pctOrNull(defMin);
    const parts = [];
    if (info.homeText) parts.push(info.homeText);
    if (info.hint) parts.push(info.hint);
    if (r.tripSocPct !== null && r.tripSocPct > 0) {
      const arr = arrivalSocPct(minVal, r.tripSocPct);
      parts.push('Verbrauch ≈ ' + fmtPct(r.tripSocPct) + (arr !== null ? ' → bei Ankunft ≈ ' + fmtPct(arr) : ''));
    }
    return {
      time: pad5(r.departure),
      min: minVal !== null ? 'mind. ' + fmtPct(minVal) : 'mind. Standard',
      minOwn: own,
      sub: parts.join(' · ')
    };
  }
  function fmtPct(v) { return Math.round(Number(v)) + NBSP + '%'; }

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

  /**
   * Zusammenfassung über dem Plan in Klartext. info = {
   *   resolved: resolveEvDeparture (gespeichert oder Vorschau),
   *   preview: true = Entwurf, noch nicht gespeichert,
   *   capacityWh: für „≈ kWh“, maxSocPct: „wenn günstig bis“,
   *   plannedSocAtDeparture: von EOS geplanter Ladestand zur nächsten Abfahrt (falls bekannt),
   *   eos: { optimizeEv, registered, reason, preplanBlocked, mode, chargeStartAt,
   *          deadlineSupported, chargeStartSupported, resolved: gespeicherter Stand } | null
   * } → [{ text, cls, tech }]  tech: Technik-Zeile (eingeklappt unter „Details“)
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
      return ' (≈' + NBSP + (Math.round(cap * pct / 100 / 100) / 10).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + NBSP + 'kWh)';
    };
    const ct = function (eur) { return Math.round(Number(eur) * 100); };
    const weeklyOff = r.weeklyEnabled === false || (r.weeklyEnabled === undefined && !r.enabled);
    if (!r.enabled) lines.push({ text: pre + 'Wochenplan aus — DVhub plant keine Abfahrt und lädt bis zum Standard-Ladestand.', cls: 'is-dim' });
    else if (!r.departureAt) lines.push({ text: pre + 'Keine Abfahrt geplant' + (r.reason && r.reason !== 'keine Abfahrt geplant' ? ' (' + r.reason + ')' : '') + '.', cls: 'is-warn' });
    else {
      let head = 'Nächste Abfahrt: ' + fmtAt(r.departureAt, tz);
      if (r.targetSocPct != null) head += ' mit mindestens ' + fmtPct(r.targetSocPct) + kwh(r.targetSocPct);
      if (r.source === 'once') head += ' — einmalig';
      lines.push({ text: pre + head, cls: 'is-next' });
      if (Number(r.tripSocPct) > 0) {
        const planned = !info.preview && info.plannedSocAtDeparture != null && isFinite(Number(info.plannedSocAtDeparture)) ? Number(info.plannedSocAtDeparture) : null;
        const base = planned !== null ? Math.max(planned, Number(r.targetSocPct) || 0) : r.targetSocPct;
        const arr = arrivalSocPct(base, r.tripSocPct);
        lines.push({ text: 'Verbrauch der Fahrt ≈ ' + fmtPct(r.tripSocPct) + (arr !== null ? ' → bei Ankunft ≈ ' + fmtPct(arr) + (planned !== null ? ' (nach dem Ladeplan)' : '') : ''), cls: '' });
      }
      const max = info.maxSocPct != null && info.maxSocPct !== '' ? Number(info.maxSocPct) : null;
      const from = r.arrivalAt ? 'ab ' + fmtAt(r.arrivalAt, tz) + ' (zuhause ab' + (r.arrivalSource === 'once' ? ', einmalig' : '') + ')' : 'ab dem Anstecken';
      lines.push({ text: 'Geladen wird ' + from + ' in den günstigsten Stunden, auch über Nacht'
        + (max !== null && isFinite(max) && max > (Number(r.targetSocPct) || 0) ? ' — und bis ' + fmtPct(max) + ', wenn Strom günstig ist.' : '.'), cls: '' });
      if (weeklyOff && r.source === 'once') lines.push({ text: 'Der Wochenplan ist aus — das ist die einzige geplante Abfahrt.', cls: 'is-dim' });
    }
    const e = info.eos;
    if (e) {
      const s = e.resolved || r;
      const stz = s.timeZone || tz;
      const head = 'Ladeplanung (EOS)' + (info.preview ? ', gespeicherter Stand' : '') + ': ';
      if (!e.optimizeEv) lines.push({ text: head + 'aus — das Auto wird nicht mitgeplant.', cls: 'is-warn', tech: false });
      else if (e.registered == null) lines.push({ text: head + 'noch nicht abgeglichen.', cls: 'is-dim', tech: true });
      else if (e.registered !== true) {
        const why = e.preplanBlocked || e.reason;
        lines.push({ text: head + 'Auto gerade nicht angemeldet' + (why ? ' (' + why + ')' : '') + '.', cls: 'is-dim', tech: true });
      } else {
        const parts = [];
        if (!s.enabled || s.targetSocPct == null) parts.push('Standard-Ladestand' + (s.enabled ? '' : ' (Wochenplan aus)'));
        else if (!e.deadlineSupported) parts.push('mindestens ' + fmtPct(s.targetSocPct) + ' ohne Uhrzeit (kein EOS 0.4 erkannt)');
        else {
          const t = e.targets;
          const min = t && t.minSocPct != null ? t.minSocPct : s.targetSocPct;
          let txt = 'mindestens ' + fmtPct(min) + (s.departureAt ? ' bis ' + fmtAt(s.departureAt, stz) : ' ohne Frist');
          if (t && t.minWeekPct != null && Number(t.minSocPct) > Number(t.minWeekPct)) txt += ' (vorausschauend, Plan ' + fmtPct(t.minWeekPct) + ')';
          parts.push(txt);
          if (t && t.maxActive) {
            const steps = Array.isArray(t.steps) ? t.steps : [];
            parts.push('bis ' + fmtPct(t.maxSocPct) + ', wenn günstig' + (steps.length
              ? ' (Wert ' + ct(steps[0][1]) + '–' + ct(steps[steps.length - 1][1]) + ' ct je kWh)'
              : (t.reason ? ' (' + t.reason + ')' : '')));
          }
        }
        if (e.deadlineSupported && e.chargeStartSupported) {
          if (e.mode === 'preplan') parts.push('Ladestart ' + (e.chargeStartAt ? fmtAt(e.chargeStartAt, stz) : 'sofort (Ankunft vorbei)'));
          else if (e.mode === 'plugged') parts.push('Ladestart sofort (angesteckt)');
          else if (e.mode === 'always') parts.push('Ladestart sofort');
        }
        lines.push({ text: head + parts.join(' · '), cls: !e.deadlineSupported ? 'is-warn' : '', tech: true });
        if (e.valueSupported === false && e.maxSocPct != null) {
          lines.push({ text: '„Wenn günstig bis ' + fmtPct(e.maxSocPct) + '“ wirkt erst mit einem EOS, das Wertstufen kennt — bis dahin lädt EOS nur bis zum Mindestziel.', cls: 'is-dim', tech: true });
        }
      }
    }
    if (info.previewError) lines.push({ text: 'Vorschau nicht möglich: ' + info.previewError, cls: 'is-warn' });
    return lines;
  }

  /** Fehlertext oder null. opts.enabled: eingeschalteter Plan braucht eine Abfahrt (oder opts.hasOnce). */
  function validate(plan, opts) {
    const list = Array.isArray(plan) ? plan : [];
    for (let i = 0; i < list.length; i += 1) {
      const err = rowInfo(list[i]).error;
      if (err) return err;
    }
    if (list.filter(function (e) { return minutes(e && e.departure) !== null; }).length > 14) return 'Höchstens 14 Abfahrten je Woche.';
    // Eine einmalige Abfahrt allein genügt (der Server rechnet damit).
    if (opts && opts.enabled && !opts.hasOnce && !list.some(function (e) { return minutes(e && e.departure) !== null; })) return 'Mindestens einen Tag mit Abfahrt einschalten — oder den Wochenplan ausschalten.';
    if (opts && opts.settings) {
      const s = opts.settings;
      if (!(Number(s.minSocPct) >= 0 && Number(s.minSocPct) <= 100) || s.minSocPct === '') return 'Standard „mindestens bei Abfahrt“: 0–100 %.';
      if (s.maxSocPct !== '' && s.maxSocPct != null && !(Number(s.maxSocPct) >= 10 && Number(s.maxSocPct) <= 100)) return '„Wenn günstig laden bis“: 10–100 % oder leer (aus).';
    }
    return null;
  }

  /**
   * Hinweis auf einen alten Heimweg in km (bis 1.0.9, optimizer.evCommuteKm):
   * er fließt seit 10.11.2026 nicht mehr in die Planung ein.
   */
  function legacyCommuteHint(km) {
    if (km === null || km === undefined || String(km).trim() === '') return '';
    const v = Number(String(km).replace(',', '.'));
    if (!isFinite(v) || v <= 0) return '';
    return 'Der alte Heimweg (' + String(Math.round(v * 10) / 10).replace('.', ',') + ' km) wird nicht mehr genutzt: DVhub plant mit dem Verbrauch je Fahrt (im Tag unter „Erweitert“).';
  }

  // ======================================================================== DOM

  const hasDom = typeof document !== 'undefined' && !!document.createElement;

  function settingsOf(host) {
    const s = (host && host._evwSettings) || {};
    return { enabled: s.enabled === true, minSocPct: s.minSocPct, maxSocPct: s.maxSocPct == null ? '' : s.maxSocPct };
  }

  function switchHtml(cls, checked, label) {
    return '<span class="switch switch-sm evw-switch"><input type="checkbox" class="' + cls + '"' + (checked ? ' checked' : '') + ' aria-label="' + esc(label) + '"><span class="track"></span><span class="thumb"></span></span>';
  }

  function cardHtml(row, idx, list, defMin) {
    const i = dayIdx(row.day);
    const ct = cardText(row, defMin);
    const extra = idx > 0 && list[idx - 1].day === row.day;
    const name = DAY_NAMES[i] + (extra ? ' (weitere Abfahrt)' : '');
    const aria = ct.time ? name + ': Abfahrt ' + ct.time + ', ' + ct.min.replace('mind.', 'mindestens') + (ct.sub ? ', ' + ct.sub : '') + ' — ändern' : name + ': kein Termin — Abfahrt eintragen';
    return '<div class="evw-card' + (ct.time ? '' : ' is-off') + (extra ? ' is-extra' : '') + '" data-idx="' + idx + '" data-day="' + row.day + '">'
      + '<button type="button" class="evw-card-main" aria-label="' + esc(aria) + '">'
      + '<span class="evw-card-day">' + DAYS[i] + (extra ? '<span class="evw-card-nr">2.</span>' : '') + '</span>'
      + '<span class="evw-card-body">'
      + (ct.time
        ? '<span class="evw-card-line"><span class="evw-card-time">' + esc(ct.time) + '</span><span class="evw-card-min' + (ct.minOwn ? ' is-own' : '') + '">' + esc(ct.min) + '</span></span>'
          + (ct.sub ? '<span class="evw-card-sub">' + esc(ct.sub) + '</span>' : '')
        : '<span class="evw-card-line"><span class="evw-card-none">kein Termin</span></span>')
      + '</span>'
      + '<span class="evw-card-chev" aria-hidden="true">›</span>'
      + '</button>'
      + (extra
        ? '<button type="button" class="btn sm ghost evw-card-del" aria-label="' + esc(DAY_NAMES[i]) + ': weitere Abfahrt ' + esc(ct.time) + ' löschen" title="Diese Abfahrt löschen">✕</button>'
        : '<label class="evw-card-sw" title="Fahre an diesem Tag">' + switchHtml('evw-drive', !!ct.time, DAY_NAMES[i] + ': fahre an diesem Tag') + '</label>')
      + '</div>';
  }

  function migrationHtml(m) {
    if (!m || !Array.isArray(m.notes)) return '';
    const items = m.notes.map(function (n) { return '<li>' + esc(n && n.text) + '</li>'; }).join('');
    return '<div class="evw-migr" role="status">'
      + '<strong class="evw-migr-t">Wochenplan umgestellt — bitte prüfen</strong>'
      + '<p class="evw-migr-p">Jede Zeile ist jetzt der Tag, an dem du losfährst. '
      + (m.reason === 'older-version' ? 'Eine ältere DVhub-Version hatte den Plan geändert; ihr Stand gilt jetzt. ' : '')
      + (items ? 'Dabei hat sich geändert:' : 'Abfahrten und Ziele sind gleich geblieben.') + '</p>'
      + (items ? '<ul class="evw-migr-l">' + items + '</ul>' : '')
      + '<button type="button" class="btn sm evw-migr-ok">Verstanden</button>'
      + '</div>';
  }

  function paintCards(host) {
    const box = host.querySelector('.evw-week');
    if (!box) return;
    const list = host._evwRows;
    const defMin = settingsOf(host).minSocPct;
    // Je Tag eine Gruppe (Listeneintrag) — breit eine Spalte der Wochenleiste,
    // auch wenn der Tag zwei Abfahrten hat.
    let html = '';
    for (let day = 1; day <= 7; day += 1) {
      let cards = '';
      list.forEach(function (r, i) { if (r.day === day) cards += cardHtml(r, i, list, defMin); });
      html += '<div class="evw-day" role="listitem" data-day="' + day + '">' + cards + '</div>';
    }
    box.innerHTML = html;
    box.classList.toggle('is-disabled', !settingsOf(host).enabled);
  }

  function changed(host) {
    const cb = host._evwOpts && host._evwOpts.onChange;
    if (typeof cb === 'function') cb();
    refreshPreview(host);
  }

  function setRows(host, rows) {
    host._evwRows = normalizePlan(rows);
    paintCards(host);
    changed(host);
  }

  function render(host, plan, opts) {
    if (!host || !hasDom) return;
    opts = opts || {};
    host._evwOpts = opts;
    host._evwRows = normalizePlan(plan);
    const s = opts.settings || {};
    host._evwSettings = {
      enabled: s.enabled === true,
      minSocPct: s.minSocPct != null && s.minSocPct !== '' ? s.minSocPct : (opts.defaultMin != null ? opts.defaultMin : 80),
      maxSocPct: s.maxSocPct == null ? '' : s.maxSocPct
    };
    host._evwMemory = host._evwMemory || {};
    const st = host._evwSettings;
    host.classList.add('evw');
    const legacy = legacyCommuteHint(opts.legacyCommuteKm);
    host.innerHTML = '<div class="evw-summary" aria-live="polite" hidden></div>'
      + migrationHtml(opts.migration)
      + '<div class="evw-std" role="group" aria-label="Standardwerte">'
      + '<label class="evw-std-on"><span class="evw-std-on-l">Wochenplan</span>' + switchHtml('evw-enabled', st.enabled, 'Wochenplan an') + '</label>'
      + '<label class="evw-std-f"><span class="evw-std-l">Standard: mindestens bei Abfahrt</span>'
      + '<span class="evw-std-in"><input type="number" inputmode="numeric" class="input mono evw-std-min" min="0" max="100" step="5" value="' + esc(st.minSocPct) + '" aria-describedby="evwStdHelp"><span class="evw-unit">%</span></span></label>'
      + '<label class="evw-std-f"><span class="evw-std-l">Wenn günstig laden bis</span>'
      + '<span class="evw-std-in"><input type="number" inputmode="numeric" class="input mono evw-std-max" min="10" max="100" step="5" placeholder="aus" value="' + esc(st.maxSocPct) + '" aria-describedby="evwStdHelp"><span class="evw-unit">%</span></span></label>'
      + '<p class="evw-std-help" id="evwStdHelp">Gilt für jede Abfahrt ohne eigenen Wert. „Wenn günstig“: billige Stunden und Sonnenstrom nutzen, um weiter zu laden — leer = aus.</p>'
      + '</div>'
      + '<div class="evw-week" role="list" aria-label="Abfahrten je Wochentag"></div>'
      + '<div class="evw-tools">'
      + '<button type="button" class="btn sm evw-commute">Pendeln Mo–Fr einrichten</button>'
      + '<button type="button" class="btn sm ghost evw-clear">Woche leeren</button>'
      + '</div>'
      + (legacy ? '<p class="evw-hint evw-legacy">' + esc(legacy) + '</p>' : '')
      + '<p class="evw-hint">Jede Karte ist der Tag, an dem du losfährst. Antippen zum Ändern; der Schalter nimmt einen Tag heraus.</p>';
    paintCards(host);
    paintSummary(host);
    if (host.dataset.evwWired === '1') return;
    host.dataset.evwWired = '1';
    host.addEventListener('input', function (e) { onSettingInput(host, e); });
    host.addEventListener('change', function (e) {
      const t = e.target;
      if (t.classList.contains('evw-drive')) {
        const card = t.closest('.evw-card');
        toggleDay(host, Number(card.getAttribute('data-idx')), t.checked);
        return;
      }
      onSettingInput(host, e);
    });
    host.addEventListener('click', function (e) {
      const t = e.target;
      const main = t.closest && t.closest('.evw-card-main');
      if (main) { openDaySheet(host, Number(main.closest('.evw-card').getAttribute('data-idx'))); return; }
      const del = t.closest && t.closest('.evw-card-del');
      if (del) { removeRow(host, Number(del.closest('.evw-card').getAttribute('data-idx'))); return; }
      if (t.closest && t.closest('.evw-commute')) { openCommuteSheet(host); return; }
      if (t.closest && t.closest('.evw-clear')) { setRows(host, []); return; }
      if (t.closest && t.closest('.evw-migr-ok')) {
        const box = host.querySelector('.evw-migr');
        if (box) box.remove();
        const cb = host._evwOpts && host._evwOpts.onMigrationSeen;
        if (typeof cb === 'function') cb();
      }
    });
  }

  function onSettingInput(host, e) {
    const t = e.target;
    const st = host._evwSettings;
    if (!st) return;
    if (t.classList.contains('evw-enabled')) st.enabled = t.checked;
    else if (t.classList.contains('evw-std-min')) st.minSocPct = String(t.value).trim() === '' ? '' : Number(String(t.value).replace(',', '.'));
    else if (t.classList.contains('evw-std-max')) st.maxSocPct = String(t.value).trim() === '' ? '' : Number(String(t.value).replace(',', '.'));
    else return;
    // Karten zeigen „mind. Standard“ mit dem neuen Wert; Fokus im Feld bleibt.
    paintCards(host);
    changed(host);
  }

  // Vorschlag für einen neu eingeschalteten Tag: zuletzt dort eingetragene
  // Zeit, sonst die erste Abfahrt am Montag, sonst die häufigste, sonst 07:30.
  function suggestTime(host, day) {
    const mem = host._evwMemory && host._evwMemory[day];
    if (mem) return mem;
    const rows = host._evwRows.filter(function (r) { return r.departure; });
    const mo = rows.filter(function (r) { return r.day === 1; })[0];
    if (mo) return mo.departure;
    const count = {};
    rows.forEach(function (r) { count[r.departure] = (count[r.departure] || 0) + 1; });
    const best = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0];
    return best || FALLBACK_TIME;
  }

  function toggleDay(host, idx, on) {
    const rows = host._evwRows.slice();
    const r = rows[idx];
    if (!r) return;
    if (on) rows[idx] = Object.assign({}, r, { departure: suggestTime(host, r.day) });
    else {
      if (r.departure) host._evwMemory[r.day] = r.departure;
      rows[idx] = emptyRow(r.day);
    }
    setRows(host, rows);
    // Fokus zurück auf den Schalter derselben Karte (Neuaufbau)
    const sw = host.querySelector('.evw-card[data-idx="' + idx + '"] .evw-drive');
    if (sw) sw.focus();
  }

  function removeRow(host, idx) {
    const rows = host._evwRows.slice();
    rows.splice(idx, 1);
    setRows(host, rows);
  }

  /** Einen Tag (1 = Mo … 7 = So) leeren: alle Abfahrten dieses Tages raus. */
  function clearDay(host, day) {
    if (!host || !host._evwRows) return false;
    const d = Number(day);
    const had = host._evwRows.some(function (r) { return r.day === d; });
    if (!had) return false;
    setRows(host, host._evwRows.filter(function (r) { return r.day !== d; }));
    return true;
  }

  /** Plan aus dem Editor: je Tag mindestens eine Zeile (wie ev-departure.js). */
  function read(host) {
    if (!host || !host._evwRows) return [];
    return host._evwRows.map(function (r) { return Object.assign({}, r); });
  }
  function readSettings(host) { return settingsOf(host); }

  // ------------------------------------------------------------ Blatt (Dialog)

  let sheet = null;
  function closeSheet() {
    if (!sheet) return;
    try { sheet.overlay.remove(); } catch (_) { /* weg */ }
    document.removeEventListener('keydown', sheet.onKey, true);
    try { document.body.classList.remove('ev-once-open'); } catch (_) { /* egal */ }
    const back = sheet.back;
    if (sheet.host) sheet.host._evwSheetOpen = false;
    sheet = null;
    if (back && typeof back.focus === 'function' && document.contains(back)) { try { back.focus(); } catch (_) { /* egal */ } }
  }

  function mountSheet(host, html, backFocus) {
    closeSheet();
    const overlay = document.createElement('div');
    overlay.className = 'ev-once-overlay evw-overlay';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
    document.body.classList.add('ev-once-open');
    const dlg = overlay.firstElementChild;
    const onKey = function (e) {
      if (!sheet) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); return; }
      if (e.key !== 'Tab') return;
      const f = Array.prototype.filter.call(dlg.querySelectorAll('button, input, select, summary'), function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) overlay.dataset.downOutside = '1'; });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay && overlay.dataset.downOutside === '1') closeSheet();
      overlay.dataset.downOutside = '';
    });
    host._evwSheetOpen = true;
    sheet = { overlay: overlay, dlg: dlg, onKey: onKey, back: backFocus || null, host: host };
    return dlg;
  }

  function chipsHtml(cls, labelId, defMin) {
    return '<div class="evw-chips" role="group" aria-labelledby="' + labelId + '">'
      + '<button type="button" class="evw-chip ' + cls + '" data-v="">Standard' + (pctOrNull(defMin) !== null ? ' (' + fmtPct(defMin) + ')' : '') + '</button>'
      + MIN_CHIPS.map(function (v) { return '<button type="button" class="evw-chip ' + cls + '" data-v="' + v + '">' + v + NBSP + '%</button>'; }).join('')
      + '</div>';
  }
  function markChips(dlg, cls, value) {
    const v = value === null || value === undefined || value === '' ? '' : String(Number(value));
    dlg.querySelectorAll('.' + cls).forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v)); });
  }

  const DAY_SHEET = [
    '<div class="ev-once-dialog evw-sheet" role="dialog" aria-modal="true" aria-labelledby="evwSheetTitle" tabindex="-1">',
    '  <div class="evw-sheet-head"><h2 class="ev-once-title" id="evwSheetTitle"></h2>',
    '    <button type="button" class="btn sm ghost evw-sheet-like" id="evwSheetLike" hidden>Wie Montag</button></div>',
    '  <div class="ev-once-group">',
    '    <label class="ev-once-label" for="evwSheetDep">Abfahrt</label>',
    '    <input type="time" class="input mono evw-sheet-time" id="evwSheetDep" step="300">',
    '  </div>',
    '  <div class="ev-once-group">',
    '    <span class="ev-once-label" id="evwSheetMinL">Mindestens bei Abfahrt</span>',
    '    <!--chips-->',
    '    <span class="ev-once-pct evw-sheet-other"><label class="evw-sheet-otherl" for="evwSheetMin">anderer Wert</label><input type="number" inputmode="numeric" class="input mono" id="evwSheetMin" min="0" max="100" step="5" placeholder="—"><span class="ev-unit">%</span></span>',
    '  </div>',
    '  <details class="ev-once-more" id="evwSheetMore">',
    '    <summary>Erweitert: zuhause ab, Verbrauch der Fahrt</summary>',
    '    <div class="ev-once-group">',
    '      <label class="ev-once-label" for="evwSheetHome">Zuhause ab (optional)</label>',
    '      <div class="ev-once-dt">',
    '        <input type="time" class="input mono evw-sheet-time" id="evwSheetHome" step="300">',
    '        <span class="evw-seg" role="radiogroup" aria-label="An welchem Tag">',
    '          <button type="button" class="evw-seg-b" role="radio" data-prev="1" id="evwSheetPrev"></button>',
    '          <button type="button" class="evw-seg-b" role="radio" data-prev="0" id="evwSheetSame"></button>',
    '        </span>',
    '        <button type="button" class="btn sm ghost ev-once-clear" id="evwSheetHomeClear" aria-label="Zuhause ab leeren">&#x2715;</button>',
    '      </div>',
    '      <p class="ev-once-help">Ab wann das Auto vor dieser Abfahrt meist zuhause steht — dann plant DVhub das Laden schon vorher ein. Leer: sobald es angesteckt ist.</p>',
    '    </div>',
    '    <div class="ev-once-group">',
    '      <label class="ev-once-label" for="evwSheetTrip">Verbrauch dieser Fahrt ≈</label>',
    '      <span class="ev-once-pct"><input type="number" inputmode="numeric" class="input mono" id="evwSheetTrip" min="0" max="100" step="1" placeholder="—"><span class="ev-unit">%</span><span class="evw-sheet-arr" id="evwSheetArr" aria-live="polite"></span></span>',
    '      <p class="ev-once-help">So viel Ladestand kostet die Fahrt ab dieser Abfahrt bis zur Heimkehr. Leer = 0. Damit schätzt DVhub den Ladestand bei Ankunft und lädt bei knappen Folgefahrten vorher mehr.</p>',
    '    </div>',
    '  </details>',
    '  <div class="ev-once-effect" id="evwSheetEffect" aria-live="polite"></div>',
    '  <div class="ev-once-error" id="evwSheetError" role="alert" hidden></div>',
    '  <div class="ev-once-actions">',
    '    <button type="button" class="btn ghost evw-sheet-del" id="evwSheetDel" hidden>Löschen</button>',
    '    <button type="button" class="btn ghost" id="evwSheetCancel">Abbrechen</button>',
    '    <button type="button" class="btn primary" id="evwSheetOk">Fertig</button>',
    '  </div>',
    '</div>'
  ].join('\n');

  function openDaySheet(host, idx) {
    const row = host._evwRows[idx];
    if (!row) return;
    const i = dayIdx(row.day);
    const extra = idx > 0 && host._evwRows[idx - 1].day === row.day;
    const defMin = settingsOf(host).minSocPct;
    const back = host.querySelector('.evw-card[data-idx="' + idx + '"] .evw-card-main');
    const dlg = mountSheet(host, DAY_SHEET.replace('<!--chips-->', chipsHtml('evw-chip-min', 'evwSheetMinL', defMin)), back);
    const $ = function (id) { return dlg.querySelector('#' + id); };
    $('evwSheetTitle').textContent = DAY_NAMES[i] + (extra ? ' — weitere Abfahrt' : '');
    $('evwSheetPrev').textContent = 'am Vortag (' + DAYS[prevIdx(i)] + ')';
    $('evwSheetSame').textContent = 'am selben Tag';
    const st = {
      departure: row.departure || suggestTime(host, row.day),
      minSocPct: row.minSocPct, tripSocPct: row.tripSocPct,
      homeFrom: row.homeFrom, homeFromPrevDay: row.homeFrom ? row.homeFromPrevDay : true, prevTouched: !!row.homeFrom
    };
    $('evwSheetDep').value = st.departure;
    $('evwSheetHome').value = st.homeFrom;
    $('evwSheetTrip').value = st.tripSocPct == null ? '' : st.tripSocPct;
    if (st.homeFrom || st.tripSocPct != null) $('evwSheetMore').open = true;
    const mo = host._evwRows.filter(function (r) { return r.day === 1 && r.departure; })[0];
    $('evwSheetLike').hidden = !(mo && row.day !== 1);
    $('evwSheetDel').hidden = !extra;

    function paint() {
      const custom = st.minSocPct !== null && MIN_CHIPS.indexOf(Number(st.minSocPct)) < 0;
      markChips(dlg, 'evw-chip-min', st.minSocPct);
      $('evwSheetMin').value = custom ? st.minSocPct : '';
      // Tag für „zuhause ab“: Vorschlag folgt der Uhrzeit, bis man selbst wählt.
      if (!st.prevTouched) st.homeFromPrevDay = defaultPrevDay(st.homeFrom || '23:59', st.departure);
      dlg.querySelectorAll('.evw-seg-b').forEach(function (b) {
        const on = (b.getAttribute('data-prev') === '1') === !!st.homeFromPrevDay;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      const draft = { day: row.day, departure: st.departure, minSocPct: st.minSocPct, tripSocPct: st.tripSocPct, homeFrom: st.homeFrom, homeFromPrevDay: st.homeFromPrevDay };
      const ct = cardText(draft, defMin);
      const minVal = st.minSocPct !== null ? st.minSocPct : pctOrNull(defMin);
      const arr = arrivalSocPct(minVal, st.tripSocPct);
      $('evwSheetArr').textContent = arr !== null ? '→ bei Ankunft ≈ ' + fmtPct(arr) : '';
      const info = rowInfo(draft);
      const err = !minutes(st.departure) ? 'Bitte eine Abfahrtszeit wählen.' : info.error;
      $('evwSheetError').textContent = err || '';
      $('evwSheetError').hidden = !err;
      $('evwSheetOk').disabled = !!err;
      const eff = $('evwSheetEffect');
      eff.textContent = '';
      if (!err) {
        const p1 = document.createElement('p');
        p1.textContent = DAYS[i] + ' ' + ct.time + ' mit ' + (minVal !== null ? 'mindestens ' + fmtPct(minVal) : 'dem Standard-Ladestand') + (info.hint ? ' (' + info.hint + ')' : '') + '.';
        const p2 = document.createElement('p');
        p2.textContent = 'Geladen wird ' + (info.homeText ? info.homeText.replace('zuhause ab', 'ab') + ' (zuhause ab)' : 'ab dem Anstecken') + ' in den günstigsten Stunden, auch über Nacht.';
        eff.appendChild(p1); eff.appendChild(p2);
      }
    }
    dlg.addEventListener('input', function (e) {
      const t = e.target;
      if (t.id === 'evwSheetDep') st.departure = pad5(t.value);
      else if (t.id === 'evwSheetHome') st.homeFrom = pad5(t.value);
      else if (t.id === 'evwSheetTrip') st.tripSocPct = pctOrNull(t.value);
      else if (t.id === 'evwSheetMin') { st.minSocPct = pctOrNull(t.value); paintKeep(t); return; }
      paint();
    });
    // Beim Tippen in „anderer Wert“ das Feld nicht neu befüllen.
    function paintKeep(field) { const v = field.value; paint(); field.value = v; }
    dlg.addEventListener('click', function (e) {
      const t = e.target;
      const chip = t.closest && t.closest('.evw-chip-min');
      if (chip) { const v = chip.getAttribute('data-v'); st.minSocPct = v === '' ? null : Number(v); paint(); return; }
      const seg = t.closest && t.closest('.evw-seg-b');
      if (seg) { st.homeFromPrevDay = seg.getAttribute('data-prev') === '1'; st.prevTouched = true; paint(); return; }
      if (t.id === 'evwSheetHomeClear') { st.homeFrom = ''; $('evwSheetHome').value = ''; st.prevTouched = false; paint(); return; }
      if (t.id === 'evwSheetCancel') { closeSheet(); return; }
      if (t.id === 'evwSheetLike' && mo) {
        Object.assign(st, { departure: mo.departure, minSocPct: mo.minSocPct, tripSocPct: mo.tripSocPct, homeFrom: mo.homeFrom, homeFromPrevDay: mo.homeFromPrevDay, prevTouched: !!mo.homeFrom });
        $('evwSheetDep').value = st.departure; $('evwSheetHome').value = st.homeFrom; $('evwSheetTrip').value = st.tripSocPct == null ? '' : st.tripSocPct;
        paint(); return;
      }
      if (t.id === 'evwSheetDel') { closeSheet(); removeRow(host, idx); return; }
      if (t.id === 'evwSheetOk' && !$('evwSheetOk').disabled) {
        const rows = host._evwRows.slice();
        rows[idx] = normRow({ day: row.day, departure: st.departure, minSocPct: st.minSocPct, tripSocPct: st.tripSocPct, homeFrom: st.homeFrom, homeFromPrevDay: st.homeFrom ? st.homeFromPrevDay : false });
        host._evwMemory[row.day] = st.departure;
        closeSheet();
        setRows(host, rows);
        const card = host.querySelector('.evw-card[data-day="' + row.day + '"] .evw-card-main');
        if (card) card.focus();
      }
    });
    dlg.addEventListener('keydown', function (e) {
      // Pfeiltasten im Tag-Umschalter (Radiogruppe)
      const seg = e.target.closest && e.target.closest('.evw-seg-b');
      if (!seg || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      st.homeFromPrevDay = !st.homeFromPrevDay; st.prevTouched = true; paint();
      const on = dlg.querySelector('.evw-seg-b[aria-checked="true"]');
      if (on) on.focus();
    });
    paint();
    setTimeout(function () { try { $('evwSheetDep').focus(); } catch (_) { /* egal */ } }, 0);
  }

  const COMMUTE_SHEET = [
    '<div class="ev-once-dialog evw-sheet" role="dialog" aria-modal="true" aria-labelledby="evwComTitle" aria-describedby="evwComIntro" tabindex="-1">',
    '  <h2 class="ev-once-title" id="evwComTitle">Pendeln Mo–Fr einrichten</h2>',
    '  <p class="ev-once-intro" id="evwComIntro">Eine Abfahrt für alle Werktage. Samstag und Sonntag bleiben, wie sie sind; einzelne Tage kannst du danach antippen und ändern.</p>',
    '  <div class="ev-once-group">',
    '    <label class="ev-once-label" for="evwComDep">Abfahrt Mo–Fr</label>',
    '    <input type="time" class="input mono evw-sheet-time" id="evwComDep" step="300">',
    '  </div>',
    '  <div class="ev-once-group">',
    '    <span class="ev-once-label" id="evwComMinL">Mindestens bei Abfahrt</span>',
    '    <!--chips-->',
    '  </div>',
    '  <div class="ev-once-error" id="evwComError" role="alert" hidden></div>',
    '  <div class="ev-once-actions">',
    '    <button type="button" class="btn ghost" id="evwComCancel">Abbrechen</button>',
    '    <button type="button" class="btn primary" id="evwComOk">Für Mo–Fr übernehmen</button>',
    '  </div>',
    '</div>'
  ].join('\n');

  function openCommuteSheet(host) {
    const defMin = settingsOf(host).minSocPct;
    const back = host.querySelector('.evw-commute');
    const dlg = mountSheet(host, COMMUTE_SHEET.replace('<!--chips-->', chipsHtml('evw-chip-com', 'evwComMinL', defMin)), back);
    const $ = function (id) { return dlg.querySelector('#' + id); };
    const mo = host._evwRows.filter(function (r) { return r.day === 1 && r.departure; })[0];
    const st = { departure: mo ? mo.departure : suggestTime(host, 1), minSocPct: mo ? mo.minSocPct : null };
    $('evwComDep').value = st.departure;
    function paint() {
      markChips(dlg, 'evw-chip-com', st.minSocPct);
      const err = minutes(st.departure) === null ? 'Bitte eine Abfahrtszeit wählen.' : '';
      $('evwComError').textContent = err; $('evwComError').hidden = !err; $('evwComOk').disabled = !!err;
    }
    dlg.addEventListener('input', function (e) { if (e.target.id === 'evwComDep') { st.departure = pad5(e.target.value); paint(); } });
    dlg.addEventListener('click', function (e) {
      const t = e.target;
      const chip = t.closest && t.closest('.evw-chip-com');
      if (chip) { const v = chip.getAttribute('data-v'); st.minSocPct = v === '' ? null : Number(v); paint(); return; }
      if (t.id === 'evwComCancel') { closeSheet(); return; }
      if (t.id === 'evwComOk' && !$('evwComOk').disabled) {
        // Mo–Fr: je Tag eine Abfahrt (weitere Abfahrten dieser Tage fallen weg);
        // „zuhause ab“ passt nicht mehr zur neuen Zeit und fällt weg, der
        // Verbrauch der Fahrt bleibt.
        const rows = [];
        for (let day = 1; day <= 7; day += 1) {
          const mine = host._evwRows.filter(function (r) { return r.day === day; });
          if (day > 5) { rows.push.apply(rows, mine); continue; }
          const keepTrip = mine[0] ? mine[0].tripSocPct : null;
          rows.push({ day: day, departure: st.departure, minSocPct: st.minSocPct, tripSocPct: keepTrip, homeFrom: '', homeFromPrevDay: false });
          host._evwMemory[day] = st.departure;
        }
        closeSheet();
        setRows(host, rows);
      }
    });
    paint();
    setTimeout(function () { try { $('evwComDep').focus(); } catch (_) { /* egal */ } }, 0);
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
    const lines = summaryLines(Object.assign({ maxSocPct: settingsOf(host).maxSocPct }, info));
    let tech = null;
    lines.forEach(function (l) {
      const div = document.createElement('div');
      div.className = 'evw-sum-line' + (l.cls ? ' ' + l.cls : '');
      div.textContent = l.text;
      if (l.tech) {
        if (!tech) {
          tech = document.createElement('details');
          tech.className = 'evw-tech';
          const s = document.createElement('summary');
          s.textContent = 'Details zur Ladeplanung';
          tech.appendChild(s);
        }
        tech.appendChild(div);
      } else box.appendChild(div);
    });
    if (tech) box.appendChild(tech);
  }

  function previewKey(host) {
    const fn = host._evwOpts && host._evwOpts.previewBody;
    if (typeof fn !== 'function') return null;
    try { return JSON.stringify(fn()); } catch (_) { return null; }
  }

  /**
   * Gespeicherten Stand zeigen (nach dem Laden vom Server) und den
   * Formularstand als Vergleich merken: solange er gleich bleibt, ist die
   * Anzeige keine Vorschau.
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

  /** Gespeicherten Stand auffrischen (Abfragetakt), ohne den Entwurf zu verwerfen. */
  function updateSaved(host, info) {
    if (!host) return;
    if (!host._evwSaved) { setSummary(host, info); return; }
    const before = host._evwSaved.capacityWh;
    host._evwSaved = info || null;
    showDraft(host);
    const d = host._evwDraft;
    if (d && d.capacityFromSaved && info && info.capacityWh !== before) refreshPreview(host);
  }

  function apiFetch(p, o) {
    const c = typeof window !== 'undefined' && window.DVhubCommon;
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
      const savedCapAtSend = (host._evwSaved || {}).capacityWh;
      const capAtSend = sentCapacity(key) != null ? sentCapacity(key) : savedCapAtSend;
      apiFetch('/api/ev/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: key })
        .then(function (res) { return res.json().catch(function () { return { ok: false, error: 'HTTP ' + res.status }; }); })
        .then(function (body) {
          if (seq !== host._evwSeq) return;
          host._evwDraft = body && body.ok
            ? { resolved: body.resolved, capacityWh: Number(body.capacityWh) > 0 ? Number(body.capacityWh) : capAtSend, capacityFromSaved: sentCapacity(key) == null }
            : { previewError: (body && body.error) || 'unbekannter Fehler' };
          showDraft(host);
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

  /**
   * Felder außerhalb des Editors leeren (Knöpfe data-evw-clear="id1 id2 …"):
   * Wert '' und input + change wie bei einer Eingabe.
   */
  function clearFields(ids) {
    (Array.isArray(ids) ? ids : []).forEach(function (id) {
      const f = document.getElementById(id);
      if (!f || f.value === '') return;
      f.value = '';
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  if (hasDom && document.addEventListener) {
    document.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest && e.target.closest('[data-evw-clear]');
      if (!btn) return;
      clearFields(String(btn.getAttribute('data-evw-clear') || '').split(/\s+/).filter(Boolean));
    });
  }

  /** Wird gerade bearbeitet (Blatt offen oder Fokus im Baustein)? Neuaufbau beim Abfragetakt unterlassen. */
  function isEditing(host) {
    if (!host) return false;
    if (host._evwSheetOpen) return true;
    if (host.querySelector) {
      const inner = host.querySelector('.evw');
      if (inner && inner._evwSheetOpen) return true;
    }
    return !!(hasDom && document.activeElement && host.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName));
  }

  window.DVhubEvWeekly = {
    render: render, read: read, readSettings: readSettings, validate: validate, isEditing: isEditing,
    DAYS: DAYS, DAY_NAMES: DAY_NAMES,
    rowInfo: rowInfo, cardText: cardText, arrivalSocPct: arrivalSocPct, normalizePlan: normalizePlan,
    summaryLines: summaryLines, legacyCommuteHint: legacyCommuteHint, setSummary: setSummary, updateSaved: updateSaved, refreshPreview: refreshPreview,
    clearDay: clearDay, clearFields: clearFields
  };
})();
