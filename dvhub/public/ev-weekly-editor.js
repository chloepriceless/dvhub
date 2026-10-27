// ev-weekly-editor.js -- Wochenplan-Editor fuers E-Auto (Leitstand-Kachel und
// Integrationsseite teilen ihn): 7 Zeilen Mo..So mit Ankunft, Abfahrt, Ziel
// und — auf der Integrationsseite — Heimweg je Tag, dazu „gleich fuer Mo–Fr“.
//
// Liegt die Abfahrt nicht nach der Ankunft, ist sie am Folgetag (20:00 →
// 05:00); die Zeile zeigt dann „+1 Tag“. Leere Ziel-/Heimweg-Felder heissen
// „allgemeiner Wert“. Kein Inline-JS, keine Inline-Styles (CSP).
//
// window.DVhubEvWeekly = { render(host, plan, opts), read(host), validate(plan) }
(function () {
  'use strict';

  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  const minutes = function (t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };

  function entryFor(plan, day) {
    const list = Array.isArray(plan) ? plan : [];
    for (let i = 0; i < list.length; i += 1) if (Number(list[i] && list[i].day) === day) return list[i];
    return { day: day, arrival: '', departure: '', targetValue: null, commuteKm: null };
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
      + '<input type="number" class="input mono evw-tgt" min="0" max="' + (opts.unit === '%' ? 100 : 2000) + '" step="' + (opts.unit === '%' ? 5 : 1) + '" value="' + val(e.targetValue) + '" placeholder="' + val(opts.defaultTarget) + '" aria-label="Ziel ' + name + ' (' + esc(opts.unit) + ')">'
      + (opts.showKm ? '<input type="number" class="input mono evw-km" min="0" max="1000" step="1" value="' + val(e.commuteKm) + '" placeholder="' + val(opts.defaultKm) + '" aria-label="Heimweg ' + name + ' (km)">' : '')
      + '</div>';
  }

  function markNextDay(row) {
    const a = minutes(row.querySelector('.evw-arr').value);
    const d = minutes(row.querySelector('.evw-dep').value);
    row.querySelector('.evw-next').hidden = !(a !== null && d !== null && d <= a);
    row.classList.toggle('is-empty', d === null);
  }

  function render(host, plan, opts) {
    if (!host) return;
    opts = opts || {};
    host._evwPlan = Array.isArray(plan) ? plan : [];
    const o = { unit: opts.unit || '%', defaultTarget: opts.defaultTarget, defaultKm: opts.defaultKm, showKm: opts.showKm === true };
    host.classList.add('evw');
    host.classList.toggle('evw-with-km', o.showKm);
    host._evwOpts = opts;
    host.innerHTML = '<div class="evw-head"><span>Tag</span><span>Ankunft</span><span>Abfahrt</span><span>Ziel ' + esc(o.unit) + '</span>'
      + (o.showKm ? '<span>Heimweg km</span>' : '') + '</div>'
      + DAYS.map(function (_, i) { return rowHtml(entryFor(plan, i + 1), i, o); }).join('')
      + '<div class="evw-tools">'
      + '<button type="button" class="btn sm ghost evw-copy" title="Ankunft, Abfahrt, Ziel und Heimweg vom Montag auf Dienstag bis Freitag übertragen">Montag gleich für Mo–Fr</button>'
      + '<button type="button" class="btn sm ghost evw-clear" title="Alle Tage leeren">Leeren</button>'
      + '</div>'
      + '<p class="evw-hint">Abfahrt vor der Ankunftszeit gilt am Folgetag (20:00 → 05:00). Ohne Ankunft gilt nur die Abfahrt. Leere Ziel- und Heimweg-Felder: allgemeiner Wert.</p>';
    host.querySelectorAll('.evw-row').forEach(markNextDay);
    if (host.dataset.evwWired === '1') return;
    host.dataset.evwWired = '1';
    const changed = function () { const cb = host._evwOpts && host._evwOpts.onChange; if (typeof cb === 'function') cb(); };
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
          ['.evw-arr', '.evw-dep', '.evw-tgt', '.evw-km'].forEach(function (sel) {
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
   * Felder, die der Editor nicht zeigt, aus dem dargestellten Plan behalten:
   * ohne Heimweg-Spalte (Kachel) bleiben die je Tag eingetragenen km stehen —
   * sonst loeschte ein Speichern in der Kachel die Werte der Integrationsseite.
   */
  function keepHidden(readPlan, renderedPlan, opts) {
    if (opts && opts.showKm) return readPlan;
    return readPlan.map(function (e) {
      const orig = entryFor(renderedPlan, e.day);
      return { day: e.day, arrival: e.arrival, departure: e.departure, targetValue: e.targetValue, commuteKm: orig.commuteKm == null ? null : orig.commuteKm };
    });
  }

  /** Plan aus dem Editor: 7 Eintraege, leere Felder → '' bzw. null. */
  function read(host) {
    const out = [];
    if (!host) return out;
    const finish = function () { return keepHidden(out, host._evwPlan || [], host._evwOpts || {}); };
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
        targetValue: num('.evw-tgt'),
        commuteKm: num('.evw-km')
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

  window.DVhubEvWeekly = { render: render, read: read, validate: validate, keepHidden: keepHidden, isEditing: isEditing, DAYS: DAYS };
})();
