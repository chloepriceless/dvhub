// second-gx-view.js — Leitstand-Kachel „Zweite Anlage“ (21.10.2026).
//
// Zeigt die zweite Victron-GX am selben Hausanschluss (services/multi-gx):
// Ladestand, Akkuleistung, ihren Anteil an der gesamten Akkuleistung, den
// Sollwert, den DVhub ihr schreibt, und ob sie folgt. Quelle ist
// /api/status.multiGx; ohne eingeschaltete zweite Anlage bleibt die Kachel weg.
// view() ist reine Anzeige-Logik (test/second-gx-view.test.js), render() setzt
// sie in die Kachel aus index.html.
(function () {
  'use strict';
  const DASH = '–';
  const num = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const watt = (v) => (num(v) ? `${Math.round(Number(v))} W` : DASH);
  const pct = (v) => (num(v) ? `${Math.round(Number(v))} %` : DASH);

  function state(m) {
    if (m.online === false || m.reason === 'follower_offline') return ['Nicht erreichbar', 'danger'];
    if (m.reason === 'stop') return ['Not-Halt', 'danger'];
    if (m.reason === 'no_data') return ['Keine Messwerte', 'warn'];
    if (m.reason === 'export_blocked') return ['Einspeisung gesperrt', 'warn'];
    const w = Number(m.batteryPowerW);
    if (!num(m.batteryPowerW)) return [DASH, ''];
    if (w > 50) return ['Lädt', 'info'];
    if (w < -50) return ['Entlädt', 'ok'];
    return ['Ruht', ''];
  }

  function view(m) {
    if (!m || m.enabled !== true) return { hidden: true };
    const [label, tone] = state(m);
    const online = m.online === true;
    return {
      hidden: false,
      soc: online ? pct(m.socPct) : DASH,
      socPct: online && num(m.socPct) ? Math.max(0, Math.min(100, Number(m.socPct))) : null,
      battery: online ? watt(m.batteryPowerW) : DASH,
      share: online && num(m.sharePct) && num(m.totalBatteryW) ? `${Math.round(Number(m.sharePct))} % von ${watt(m.totalBatteryW)}` : DASH,
      setpoint: watt(m.setpointW),
      minSoc: pct(m.minSocPct),
      state: label,
      tone,
    };
  }

  function render(m, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    const card = d && d.getElementById('secondGxCard');
    if (!card) return;
    const v = view(m);
    card.hidden = v.hidden;
    if (v.hidden) return;
    const set = (id, text) => { const el = d.getElementById(id); if (el) el.textContent = text; };
    set('secondGxSoc', v.soc);
    set('secondGxBatP', v.battery);
    set('secondGxShare', v.share);
    set('secondGxSetpoint', v.setpoint);
    set('secondGxMinSoc', v.minSoc);
    set('secondGxState', v.state);
    const chip = d.getElementById('secondGxChip');
    if (chip) {
      chip.classList.remove('info', 'ok', 'warn', 'danger');
      if (v.tone) chip.classList.add(v.tone);
    }
    const bar = d.getElementById('secondGxSocBar');
    if (bar) {
      bar.classList.remove('progress-fill-init');
      bar.style.width = `${v.socPct ?? 0}%`;
    }
  }

  window.DVhubSecondGx = { view, render };
})();
