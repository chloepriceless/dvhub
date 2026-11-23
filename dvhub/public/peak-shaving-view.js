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

  // Warum DVhub nicht (ganz) deckeln konnte: leerer Akku ist kein Messfehler.
  const MEASUREMENT_REASONS = ['soc_unknown', 'telemetry_frozen', 'source_mismatch', 'telemetry_unknown'];
  const REASON_TEXT = {
    soc_floor: 'Akku am Mindest-Ladestand',
    soc_unknown: 'Ladestand unbekannt',
    telemetry_frozen: 'Messwerte eingefroren',
    source_mismatch: 'Messquellen widersprechen sich',
    telemetry_unknown: 'Ladestand/Last unbekannt'
  };

  function state(s) {
    if (s.reason === 'manufacturer_unsupported') return ['Nur Anzeige', 'info'];
    if (s.reason === 'builtin_disabled') return ['Eingebaut, aus', 'info'];
    if (s.reason === 'limit_missing') return ['Grenze fehlt', 'warn'];
    if (s.active !== true) return [DASH, ''];
    if (s.acting) return ['Greift', 'warn'];
    if (s.clamp && s.clamp.mode === 'held') {
      return s.clamp.reason === 'soc_floor' ? ['Akku am Boden', 'warn']
        : MEASUREMENT_REASONS.includes(s.clamp.reason) || !s.clamp.reason ? ['Messwerte fehlen', 'danger']
          : ['Kann nicht greifen', 'warn'];
    }
    return ['Bereit', 'ok'];
  }

  function detail(s) {
    if (s.lift && num(s.lift.liftedW)) {
      return s.lift.waiting === 'readback'
        ? `Akku freigegeben: ${kw(s.lift.liftedW)} — Sperre wird gesetzt, sobald 2704 lesbar ist`
        : `Akku freigegeben: ${kw(s.lift.liftedW)}`;
    }
    if (s.builtin) {
      const b = s.builtin;
      if (s.reason === 'builtin_disabled') return 'Eingebaute Peak-Shaving-Funktion vorhanden (ungetestet) — Schalter unter Einstellungen → Peak Shaving.';
      if (b.error) return `Eingebaute Funktion (ungetestet): ${b.error}`;
      if (b.active) return `Eingebaute Funktion des Wechselrichters (ungetestet): Bezug höchstens ${kw(b.targetW)}`;
      return `Eingebaute Funktion (ungetestet): ${b.reason || 'wartet'}`;
    }
    if (s.assist) {
      if (!s.assist.requested) return `Akku-Hilfe nicht möglich (${s.assist.reason || 'abgelehnt'})`;
      return `${s.leverText || 'Akku zuerst'}: Bezug höchstens ${kw(s.assist.maxImportW)}${num(s.assist.helpW) && Number(s.assist.helpW) > 0 ? `, Akku gibt ${kw(s.assist.helpW)}` : ''}`;
    }
    const why = s.clamp && REASON_TEXT[s.clamp.reason];
    if (s.clamp && (s.clamp.mode === 'target' || s.clamp.mode === 'net_load')) {
      const base = `Sollwert ${kw(s.clamp.requestedW)} → ${kw(s.clamp.valueW)}`;
      return s.clamp.mode === 'net_load' && why ? `${base} (${why}: Akku entlädt nicht)` : base;
    }
    if (s.clamp && s.clamp.mode === 'held') return `${why || 'Ladestand/Last unbekannt'} — DVhub greift nicht ein`;
    return s.message || '';
  }

  const kwh = (wh) => (num(wh)
    ? `${(Number(wh) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`
    : DASH);
  const mmss = (sec) => {
    if (!num(sec)) return DASH;
    const t = Math.max(0, Math.round(Number(sec)));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  };

  // Viertelstunden-Budget (P1): bezogen / Budget dieser Viertelstunde, Restzeit,
  // erlaubte Leistung bis zum Ende — oder warum gerade der Augenblickswert gilt.
  function budgetText(b) {
    if (!b) return '';
    if (b.mode === 'budget') {
      return `${kwh(b.usedWh)} von ${kwh(b.budgetWh)} · noch ${mmss(b.remainingS)} · bis zum Ende höchstens ${kw(b.allowedW)}`;
    }
    if (b.reason === 'billing_instant') return 'Augenblickswert (eingestellt)';
    return `Augenblickswert — ${b.reasonText || b.reason || 'unsicher'}`;
  }

  const eur = (v) => (num(v)
    ? `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`
    : DASH);
  const dec2 = (v) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hours = (h) => (num(h) ? `${Math.round(Number(h)).toLocaleString('de-DE')} h` : DASH);

  // P4: Leistungsentgelt in € (laufendes Jahr bzw. Monat beim Monatsleistungspreis).
  function billingView(b) {
    if (!b || !b.year) return null;
    const y = b.year;
    const out = { charge: DASH, usage: DASH, effective: DASH, avoided: DASH, note: '' };
    if (b.model === 'month') {
      const m = b.month || {};
      out.charge = num(m.demandChargeEur) ? `${eur(m.demandChargeEur)} diesen Monat (${kw(m.peakW)} × ${num(y.lpEurPerKwMonth) ? dec2(y.lpEurPerKwMonth) : DASH} €)` : DASH;
      out.avoided = num(m.avoidedEur) ? `${eur(m.avoidedEur)} diesen Monat (ohne Akku ${kw(m.uncappedPeakW)})` : DASH;
    } else {
      out.charge = num(y.demandChargeEur) ? `${eur(y.demandChargeEur)} im Jahr (${kw(y.peakW)} × ${dec2(y.lpEurPerKwYear)} €)` : DASH;
      out.avoided = num(y.avoidedEur) ? `${eur(y.avoidedEur)} im Jahr (ohne Akku ${kw(y.uncappedPeakW)})` : DASH;
    }
    const tier = y.tier === 'high' ? 'ab 2.500 h' : y.tier === 'low' ? 'unter 2.500 h' : '';
    out.usage = num(y.usageHours)
      ? (y.running ? `${hours(y.usageHours)} bisher · ${hours(y.usageHoursProjected)} hochgerechnet` : hours(y.usageHours)) + (tier && b.model !== 'month' ? ` (Stufe ${tier})` : '')
      : DASH;
    out.effective = num(y.effectiveCtPerKwh) ? `${dec2(y.effectiveCtPerKwh)} ct/kWh` : DASH;
    if (b.tariffComplete === false) out.note = 'Für € fehlen die Netzentgelt-Preise: Einstellungen → Peak Shaving (Preisblatt des Netzbetreibers).';
    return out;
  }

  // P3: Hinweis auf den Schalter „Grenze an erreichte Jahresspitze anpassen“.
  function adaptText(s) {
    const a = s.adapt;
    if (!a) return '';
    const what = a.scope === 'month' ? 'Monatsspitze' : 'Jahresspitze';
    const period = a.scope === 'month' ? 'diesen Monat' : 'dieses Jahr';
    if (a.active) return `Grenze an die ${what} angepasst: ${kw(a.effectiveLimitW)} (eingestellt ${kw(s.limitW)}) — weitere Kappung darunter spart ${period} nichts.`;
    if (a.suggest) {
      return `${what} ${kw(a.reachedPeakW)} liegt schon über der Grenze ${kw(s.limitW)}: jede weitere Kappung darunter spart ${period} nichts, kostet aber Akku-Einsatz. `
        + 'Tipp: Schalter „Grenze an erreichte Jahresspitze anpassen“ unter Einstellungen → Peak Shaving.';
    }
    return '';
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
      detail: detail(s),
      budget: budgetText(s.budget),
      adaptNote: adaptText(s),
      billing: billingView(s.billing),
      adaptSuggest: Boolean(s.adapt && s.adapt.suggest),
      budgetMode: s.budget ? s.budget.mode : null
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
    const budgetRow = d.getElementById('peakShavingBudgetRow');
    if (budgetRow) budgetRow.hidden = !v.budget;
    set('peakShavingBudget', v.budget || DASH);
    const bill = d.getElementById('peakShavingBilling');
    if (bill) bill.hidden = !v.billing;
    if (v.billing) {
      set('peakShavingCharge', v.billing.charge);
      set('peakShavingUsage', v.billing.usage);
      set('peakShavingEffective', v.billing.effective);
      set('peakShavingAvoided', v.billing.avoided);
      set('peakShavingBillingNote', v.billing.note);
    }
    const adaptEl = d.getElementById('peakShavingAdapt');
    if (adaptEl) {
      adaptEl.hidden = !v.adaptNote;
      adaptEl.textContent = v.adaptNote || '';
      adaptEl.classList.toggle('warn', v.adaptSuggest);
    }
    set('peakShavingDetail', v.peakNote ? `${v.detail} ${v.peakNote}`.trim() : v.detail);
    const chip = d.getElementById('peakShavingChip');
    if (chip) {
      chip.classList.remove('info', 'ok', 'warn', 'danger');
      if (v.tone) chip.classList.add(v.tone);
    }
  }

  window.DVhubPeakShaving = { view, render };
})();
