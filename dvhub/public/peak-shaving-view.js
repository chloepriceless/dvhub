// peak-shaving-view.js — Leitstand-Kachel „Peak Shaving“ (GitHub #28).
//
// Zeigt die Bezugsgrenze, den aktuellen Netzbezug, ob DVhub gerade eingreift
// (Sollwert gedeckelt oder Akku-Sperre aufgehoben) und die höchste
// Viertelstunden-Bezugsleistung im laufenden Monat und Jahr — die Größe, nach
// der der RLM-Leistungspreis abgerechnet wird. Quelle ist /api/status.peakShaving;
// ausgeschaltet bleibt die Kachel weg. view() ist reine Anzeige-Logik
// (test/peak-shaving-view.test.js), render() setzt sie in die Kachel aus index.html.
(function () {
  'use strict';
  const DASH = '–';
  const num = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const kw = (w) => (num(w)
    ? `${(Number(w) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kW`
    : DASH);

  function when(iso, timeZone) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      const parts = new Intl.DateTimeFormat('de-DE', {
        timeZone: timeZone || 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(d);
      const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
      return `${p.day}.${p.month}. ${p.hour}:${p.minute}`;
    } catch {
      return '';
    }
  }

  function state(s) {
    if (s.reason === 'manufacturer_unsupported') return ['Nur Anzeige', 'info'];
    if (s.reason === 'limit_missing') return ['Grenze fehlt', 'warn'];
    if (s.active !== true) return [DASH, ''];
    if (s.acting) return ['Greift', 'warn'];
    if (s.clamp && s.clamp.mode === 'held') return ['Messwerte fehlen', 'danger'];
    return ['Bereit', 'ok'];
  }

  function detail(s) {
    if (s.lift && num(s.lift.liftedW)) return `Akku freigegeben: ${kw(s.lift.liftedW)}`;
    if (s.clamp && (s.clamp.mode === 'target' || s.clamp.mode === 'net_load')) {
      return `Sollwert ${kw(s.clamp.requestedW)} → ${kw(s.clamp.valueW)}`;
    }
    if (s.clamp && s.clamp.mode === 'held') return 'Ladestand/Last unbekannt — DVhub greift nicht ein';
    return s.message || '';
  }

  function view(s) {
    if (!s || s.enabled !== true) return { hidden: true };
    const [label, tone] = state(s);
    const peaks = s.peaks || {};
    const limit = num(s.limitW) ? Number(s.limitW) : null;
    const over = (p) => Boolean(p && limit != null && num(p.powerW) && Number(p.powerW) > limit);
    return {
      hidden: false,
      limit: kw(s.limitW),
      importNow: kw(s.importW),
      monthPeak: kw(peaks.month && peaks.month.powerW),
      monthPeakAt: when(peaks.month && peaks.month.slotStart, s.timezone),
      monthOverLimit: over(peaks.month),
      yearPeak: kw(peaks.year && peaks.year.powerW),
      yearPeakAt: when(peaks.year && peaks.year.slotStart, s.timezone),
      yearOverLimit: over(peaks.year),
      peakNote: peaks.error
        ? (peaks.error === 'no_database' ? 'Spitzen brauchen die Datenbank (Telemetrie).' : `Spitzen nicht lesbar: ${peaks.error}`)
        : '',
      state: label,
      tone,
      detail: detail(s)
    };
  }

  function render(s, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const card = d && d.getElementById('peakShavingCard');
    if (!card) return;
    const v = view(s);
    card.hidden = v.hidden;
    if (v.hidden) return;
    const set = (id, text, warn) => {
      const el = d.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (warn !== undefined) el.classList.toggle('warn', Boolean(warn));
    };
    set('peakShavingImport', v.importNow);
    set('peakShavingLimit', v.limit);
    set('peakShavingMonth', v.monthPeakAt ? `${v.monthPeak} · ${v.monthPeakAt}` : v.monthPeak, v.monthOverLimit);
    set('peakShavingYear', v.yearPeakAt ? `${v.yearPeak} · ${v.yearPeakAt}` : v.yearPeak, v.yearOverLimit);
    set('peakShavingState', v.state);
    set('peakShavingDetail', v.peakNote ? `${v.detail} ${v.peakNote}`.trim() : v.detail);
    const chip = d.getElementById('peakShavingChip');
    if (chip) {
      chip.classList.remove('info', 'ok', 'warn', 'danger');
      if (v.tone) chip.classList.add(v.tone);
    }
  }

  window.DVhubPeakShaving = { view, render };
})();
