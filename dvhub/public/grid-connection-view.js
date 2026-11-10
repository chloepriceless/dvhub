// grid-connection-view.js — Leitstand-Kachel „Netzanschluss“ (services/grid-connection).
//
// Zeigt den Netzbezug gegen die Grenze des Hausanschlusses und, ob DVhub gerade
// begrenzt — im Klartext des Wächters, z. B. „Netzanschluss: begrenzt
// Akku-Ladung auf 28,0 kW · Wallbox pausiert“. Quelle ist /api/status.gridConnection;
// ohne eingetragene Grenze bleibt die Kachel weg. Dazu der Akku-Hebel („Akku
// zuerst“ bzw. „Akku nicht steuerbar“) und die aktuelle Akku-Hilfe in kW. view() ist reine Anzeige-Logik
// (test/grid-connection-view.test.js), render() setzt sie in die Kachel aus index.html.
(function () {
  'use strict';
  const DASH = '–';
  const num = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const kw = (w) => (num(w)
    ? `${(Number(w) / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kW`
    : DASH);

  function state(s) {
    if (s.paused) return ['Not-Halt', 'warn'];
    if (s.active !== true && s.reason === 'not_set' && s.victronReadError) return ['Victron-Grenze nicht lesbar', 'warn'];
    if (s.active !== true) return ['Grenze ungültig', 'warn'];
    if (s.failsafe) return ['Zähler gestört', 'danger'];
    if (s.exhausted) return ['Nichts mehr steuerbar', 'danger'];
    // Nur der Akku hilft (keine Last gedrosselt, keine Ladung gedeckelt):
    // das ist „Akku zuerst“ in Aktion, keine Begrenzung.
    const caps = Array.isArray(s.caps) ? s.caps.length : 0;
    if (s.acting && s.assist && !caps && !s.clamp) return ['Akku hilft', 'info'];
    if (s.acting) return ['Begrenzt', 'warn'];
    return ['Bereit', 'ok'];
  }

  function phases(s) {
    if (!Array.isArray(s.phasesW) || s.phasesW.length !== 3) return DASH;
    return s.phasesW.map((w) => kw(w).replace(' kW', '')).join(' / ') + ' kW';
  }

  function assist(a) {
    if (!a || !num(a.valueW)) return DASH;
    const base = Number(a.baseW) === -1 ? 'unbegrenzt' : kw(a.baseW);
    return `${kw(a.helpW)} (Entladegrenze ${kw(a.valueW)} statt ${base})`;
  }

  function view(s) {
    if (!s || s.enabled !== true) return { hidden: true };
    const [label, tone] = state(s);
    // Victron-Grenze ohne Abstand: das sagen statt „Ziel = Grenze“ unerklärt.
    const limit = num(s.limitW)
      ? `${kw(s.limitW)} (${s.marginText ? s.marginText : `Ziel ${kw(s.targetW)}`})` : DASH;
    const load = num(s.importW) && num(s.limitW) && Number(s.limitW) > 0
      ? `${Math.round((Number(s.importW) / Number(s.limitW)) * 100)} %` : DASH;
    return {
      hidden: false,
      importNow: kw(s.importW),
      limit,
      load,
      phases: phases(s),
      phaseLimit: num(s.phaseLimitA) ? `${s.phaseLimitA} A je Phase` : 'keine',
      // Woher die wirksame Grenze kommt (DVhub-Einstellung oder Victron Reg. 2714).
      source: (s.limitText || '') + (s.victronReadError ? ' · Victron-Grenze nicht lesbar' : ''),
      // Akku zuerst: welcher Hebel, und was der Akku gerade abgibt.
      battery: s.battery && s.battery.text ? s.battery.text : DASH,
      assist: assist(s.assist),
      state: label,
      tone,
      detail: s.text || (s.active ? 'Keine Begrenzung nötig.' : 'Netzanschluss-Grenze ungültig (2 bis 2 000 kW) — DVhub regelt nicht.')
    };
  }

  function render(s, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const card = d && d.getElementById('gridConnectionCard');
    if (!card) return;
    const v = view(s);
    card.hidden = v.hidden;
    if (v.hidden) return;
    const set = (id, text) => {
      const el = d.getElementById(id);
      if (el) el.textContent = text;
    };
    set('gridConnectionImport', v.importNow);
    set('gridConnectionLimit', v.limit);
    set('gridConnectionLoad', v.load);
    set('gridConnectionPhases', v.phases);
    set('gridConnectionSource', v.source || '–');
    set('gridConnectionBattery', v.battery);
    set('gridConnectionAssist', v.assist);
    set('gridConnectionState', v.state);
    set('gridConnectionDetail', v.detail);
    const chip = d.getElementById('gridConnectionChip');
    if (chip) {
      chip.classList.remove('info', 'ok', 'warn', 'danger');
      if (v.tone) chip.classList.add(v.tone);
    }
  }

  window.DVhubGridConnection = { view, render };
})();
