// price-hours-view.js — Preis-Stunden im Leitstand (Issue #27, 26.10.2026).
//
// Wie viele Stunden liegt der Day-Ahead-Preis heute und morgen über der eigenen
// Verkaufsschwelle bzw. unter der Einkaufsschwelle — und mit welcher Leistung müsste
// man fahren, um eine Energiemenge in diesen Stunden zu verkaufen oder einzukaufen?
// Quelle sind die EPEX-Slots aus /api/status (epex.data, Felder ts/day/ct_kwh); die
// Schwellen und die Menge merkt sich der Browser (nur Anzeige, keine Steuerung).
// compute()/view() sind reine Logik (test/price-hours-view.test.js), render()/init()
// verbinden sie mit dem Block unter dem Preis-Chart in index.html.
(function () {
  'use strict';
  const STORE_KEY = 'dvhub.priceHours';

  function parseCt(raw) {
    const s = String(raw == null ? '' : raw).trim().replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // Slot-Länge eines Tages aus dem kleinsten Abstand zweier Slots (15 oder 60 min).
  function slotHours(rows) {
    const ts = rows.map((r) => Number(r.ts)).filter(Number.isFinite).sort((a, b) => a - b);
    let min = Infinity;
    for (let i = 1; i < ts.length; i += 1) {
      const d = ts[i] - ts[i - 1];
      if (d > 0 && d < min) min = d;
    }
    return Number.isFinite(min) ? min / 3600000 : 0.25;
  }

  function countDay(rows, sellCt, buyCt) {
    const priced = rows.filter((r) => Number.isFinite(Number(r.ct_kwh)));
    if (!priced.length) return { available: false, sellHours: null, buyHours: null };
    const h = slotHours(priced);
    const hours = (pred) => Math.round(priced.filter(pred).length * h * 100) / 100;
    return {
      available: true,
      sellHours: sellCt == null ? null : hours((r) => Number(r.ct_kwh) >= sellCt),
      buyHours: buyCt == null ? null : hours((r) => Number(r.ct_kwh) <= buyCt),
    };
  }

  function compute(rows, { today, tomorrow, sellCt, buyCt }) {
    const list = Array.isArray(rows) ? rows : [];
    const of = (d) => (d ? list.filter((r) => r.day === d) : []);
    return { today: countDay(of(today), sellCt, buyCt), tomorrow: countDay(of(tomorrow), sellCt, buyCt) };
  }

  const de = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

  function part(label, d, key, energyKwh) {
    if (!d || !d.available) return `${label} ab ~13 Uhr`;
    const h = d[key];
    const kw = energyKwh != null && energyKwh > 0 && h > 0 ? ` (≈ ${de(energyKwh / h)} kW)` : '';
    return `${label} ${de(h)} h${kw}`;
  }

  function line(name, sign, ct, result, key, energyKwh) {
    if (ct == null) return `${name}: Schwelle eintragen`;
    return `${name} ${sign} ${de(ct)} ct: ${part('heute', result.today, key, energyKwh)} · ${part('morgen', result.tomorrow, key, energyKwh)}`;
  }

  function view(result, { sellCt, buyCt, energyKwh }) {
    return {
      sell: line('Verkauf', '≥', sellCt, result, 'sellHours', energyKwh),
      buy: line('Einkauf', '≤', buyCt, result, 'buyHours', energyKwh),
    };
  }

  function readStore() {
    try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
  }
  function writeStore(v) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch { /* privat/gesperrt: nur nicht merken */ }
  }

  let lastEpex = null;
  function inputs(d) {
    return {
      sellCt: parseCt(d.getElementById('priceHoursSell')?.value),
      buyCt: parseCt(d.getElementById('priceHoursBuy')?.value),
      energyKwh: parseCt(d.getElementById('priceHoursEnergy')?.value),
    };
  }

  function render(epex, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.getElementById('priceHoursBlock')) return;
    if (epex) lastEpex = epex;
    const e = lastEpex || {};
    const today = e.summary?.today || e.date || null;
    const tomorrow = e.nextDate || null;
    const opts = inputs(d);
    const v = view(compute(e.data, { today, tomorrow, sellCt: opts.sellCt, buyCt: opts.buyCt }), opts);
    const set = (id, text) => { const el = d.getElementById(id); if (el) el.textContent = text; };
    set('priceHoursSellResult', v.sell);
    set('priceHoursBuyResult', v.buy);
  }

  function init(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.getElementById('priceHoursBlock')) return;
    const saved = readStore();
    const ids = { sell: 'priceHoursSell', buy: 'priceHoursBuy', energy: 'priceHoursEnergy' };
    for (const [key, id] of Object.entries(ids)) {
      const el = d.getElementById(id);
      if (!el) continue;
      if (saved[key] != null) el.value = saved[key];
      el.addEventListener('input', () => {
        const next = readStore();
        next[key] = el.value;
        writeStore(next);
        render(null, d);
      });
    }
    render(null, d);
  }

  window.DVhubPriceHours = { compute, view, parseCt, render, init };
})();
