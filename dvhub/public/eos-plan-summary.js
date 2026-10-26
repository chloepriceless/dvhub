// eos-plan-summary.js — „Laut EOS-Plan“ unter dem Day-Ahead-Chart (Issue #27,
// Richtungswechsel 26.10.2026: statt eigener Schwellen und Menge zählt, was EOS
// wirklich plant).
//
// Für heute (nur Slots ab jetzt, der laufende zählt mit) und morgen je:
//   Einspeisung — geplante kWh, Stunden mit Einspeisung, höchste Leistung und der
//                 niedrigste Einspeisepreis dieser Slots („EOS verkauft ab X ct“);
//   Netzbezug   — geplante kWh, Stunden mit Bezug, höchste Leistung (Spitze) und
//                 der höchste Bezugspreis dieser Slots („EOS kauft bis Y ct“);
//   mit Spitzenkappung (status.peakShaving, eigener Zweig) die Slots, in denen der
//   geplante Bezug über der Grenze liegt.
// Quelle sind die Zeilen aus /api/eos/plan (output.rows, Wh je Slot), die
// leitstand-charts.js für den EOS-Fahrplan ohnehin alle 30 s holt — kein eigener
// Abruf. Preise: feedInCtKwh / priceCtKwh aus dem Plan (das, womit EOS rechnet);
// fehlt einer, gilt der Börsenpreis aus /api/status (epex.data) für den Slot.
// summarize()/view() sind reine Logik (test/eos-plan-summary.test.js), render()
// füllt den Block in index.html. Nur Anzeige, keine Steuerung.
(function () {
  'use strict';

  // Ab dieser mittleren Leistung zählt ein Slot als Einspeise- bzw. Bezugsslot
  // (Stunden, Preis). Dieselbe Schwelle, ab der DVhub einen EOS-Slot überhaupt als
  // Einspeisung/Bezug stellt (eos-adapter pullGridSetpoints, bandW = 300 W);
  // darunter liegen Rundungsreste der EOS-Lösung (0,003 Wh) und gemischte Slots.
  // Die kWh zählen alle Slots — das ist die Energie, die der Plan bewegt.
  const BAND_W = 300;
  const DEFAULT_TZ = 'Europe/Berlin';

  const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const round = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };

  function fmtParts(tz) {
    return {
      day: new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }),
      time: new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    };
  }
  function nextDayKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  }

  // Slot-Länge: output.slotMinutes; fehlt sie (Lösung mit einer Zeile), der
  // kleinste Abstand zweier Zeilen; sonst das 15-min-Raster von EOS/DVhub.
  function slotMinutesOf(output, ts) {
    const given = num(output && output.slotMinutes);
    if (given && given > 0) return given;
    let min = null;
    for (let i = 1; i < ts.length; i += 1) {
      const d = ts[i] - ts[i - 1];
      if (d > 0 && (min === null || d < min)) min = d;
    }
    return min ? Math.round(min / 60000) : 15;
  }

  // Börsenpreis für einen Slot: exakter Zeitstempel, sonst die volle Stunde
  // (Stundenpreise bei 15-min-Plan).
  function spotLookup(epex) {
    const map = new Map();
    for (const r of Array.isArray(epex) ? epex : []) {
      const ct = num(r && r.ct_kwh);
      const ts = Number(r && r.ts);
      if (ct !== null && Number.isFinite(ts)) map.set(ts, ct);
    }
    return (ts) => (map.has(ts) ? map.get(ts) : (map.get(ts - (ts % 3600000)) ?? null));
  }

  function side(rows, slotH, whKey, priceKey, spot, pickMin) {
    let wh = 0; let slots = 0; let peakW = 0; let peakAt = null; let ct = null;
    for (const r of rows) {
      const e = num(r[whKey]);
      if (e === null || e <= 0) continue;
      wh += e;
      const w = e / slotH;
      if (w > peakW) { peakW = w; peakAt = r.ts; }
      if (w < BAND_W) continue;
      slots += 1;
      const p = num(r[priceKey]) ?? spot(r.ts);
      if (p !== null && (ct === null || (pickMin ? p < ct : p > ct))) ct = p;
    }
    const out = { kwh: round(wh / 1000, 3), hours: round(slots * slotH, 2), peakKw: round(peakW / 1000, 3), peakAt };
    out[pickMin ? 'minCt' : 'maxCt'] = ct;
    return out;
  }

  function peakOver(rows, slotH, limitW) {
    if (!(limitW > 0)) return null;
    let slots = 0; let maxW = 0;
    for (const r of rows) {
      const w = (num(r.gridConsumptionWh) || 0) / slotH;
      if (w > limitW) { slots += 1; if (w > maxW) maxW = w; }
    }
    return { limitKw: round(limitW / 1000, 3), slots, hours: round(slots * slotH, 2), maxKw: round(maxW / 1000, 3) };
  }

  function daySummary(rows, slotMs, slotH, dayKeyOf, spot, peakLimitW) {
    if (!rows.length) return null;
    const last = rows[rows.length - 1];
    const until = last.ts + slotMs;
    return {
      from: rows[0].ts,
      until,
      // Der Plan reicht bis Tagesende, wenn der Slot nach dem letzten schon zum
      // nächsten Tag gehört (sommerzeitfest, ohne Mitternacht auszurechnen).
      complete: dayKeyOf(until) !== dayKeyOf(last.ts),
      export: side(rows, slotH, 'gridFeedinWh', 'feedInCtKwh', spot, true),
      import: side(rows, slotH, 'gridConsumptionWh', 'priceCtKwh', spot, false),
      peak: peakOver(rows, slotH, peakLimitW),
    };
  }

  /**
   * @param {object|null} planResponse  Antwort von /api/eos/plan (null = nicht abrufbar)
   * @param {{now:number, epex?:Array, peakLimitW?:number|null, timeZone?:string}} opts
   */
  function summarize(planResponse, { now, epex = null, peakLimitW = null, timeZone = DEFAULT_TZ } = {}) {
    const p = planResponse || null;
    const output = p && p.output;
    const raw = output && Array.isArray(output.rows) ? output.rows : [];
    const base = { available: false, reason: (p && p.reason) || null, stale: !!(p && p.plan && p.plan.current === false), timeZone };
    const rows = raw
      .map((r) => ({ ...r, ts: Date.parse(r && r.ts_utc) }))
      .filter((r) => Number.isFinite(r.ts))
      .sort((a, b) => a.ts - b.ts);
    if (!p || p.available === false || !rows.length) return { ...base, today: null, tomorrow: null };

    const slotMin = slotMinutesOf(output, rows.map((r) => r.ts));
    const slotMs = slotMin * 60000;
    const slotH = slotMin / 60;
    const f = fmtParts(timeZone);
    const dayKeyOf = (ms) => f.day.format(new Date(ms));
    const today = dayKeyOf(now);
    const tomorrow = nextDayKey(today);
    const spot = spotLookup(epex);
    const ahead = rows.filter((r) => r.ts + slotMs > now); // vergangene Slots zählen nicht
    const of = (key) => ahead.filter((r) => dayKeyOf(r.ts) === key);
    return {
      ...base,
      available: true,
      slotMinutes: slotMin,
      today: daySummary(of(today), slotMs, slotH, dayKeyOf, spot, peakLimitW) || { empty: true },
      tomorrow: daySummary(of(tomorrow), slotMs, slotH, dayKeyOf, spot, peakLimitW),
    };
  }

  const de = (n, d) => String(round(n, d)).replace('.', ',');

  function exportLine(e) {
    if (!e.hours) return 'Einspeisung: keine geplant';
    const ct = e.minCt === null ? '' : ` · EOS verkauft ab ${de(e.minCt, 1)} ct`;
    return `Einspeisung ${de(e.kwh, 1)} kWh in ${de(e.hours, 2)} h · bis ${de(e.peakKw, 1)} kW${ct}`;
  }
  function importLine(i, time) {
    if (!i.hours) return 'Netzbezug: keiner geplant';
    const ct = i.maxCt === null ? '' : ` · EOS kauft bis ${de(i.maxCt, 1)} ct`;
    return `Netzbezug ${de(i.kwh, 1)} kWh in ${de(i.hours, 2)} h · Spitze ${de(i.peakKw, 1)} kW um ${time(i.peakAt)}${ct}`;
  }
  function peakLine(pk) {
    if (!pk) return null;
    const head = `Spitzenkappung ${de(pk.limitKw, 1)} kW`;
    if (!pk.slots) return `${head}: Plan bleibt darunter`;
    return `${head}: ${pk.slots} ${pk.slots === 1 ? 'Slot' : 'Slots'} darüber (${de(pk.hours, 2)} h, bis ${de(pk.maxKw, 1)} kW)`;
  }

  const REASON_TEXT = { eos_off: 'EOS ist aus', eos_not_answering: 'EOS antwortet nicht' };

  function view(s) {
    if (!s || !s.available) {
      const why = s && REASON_TEXT[s.reason];
      return { note: why ? `Kein EOS-Plan (${why})` : 'Kein EOS-Plan', today: null, tomorrow: null };
    }
    const time = (ms) => fmtParts(s.timeZone || DEFAULT_TZ).time.format(new Date(ms));
    const day = (d, label, missing) => {
      if (!d || d.empty) return { head: missing, export: null, import: null, peak: null };
      return {
        head: `${label}${d.complete ? '' : ` bis ${time(d.until)}`}`,
        export: exportLine(d.export),
        import: importLine(d.import, time),
        peak: peakLine(d.peak),
      };
    };
    return {
      note: s.stale ? 'EOS rechnet neu' : '',
      today: day(s.today, 'Heute ab jetzt', 'Heute: kein Plan mehr ab jetzt'),
      tomorrow: day(s.tomorrow, 'Morgen', 'Morgen: noch nicht im Plan'),
    };
  }

  // Spitzenkappung (feat/peak-shaving): status.peakShaving = { enabled, limitW, … }
  // oder null/fehlend. Nur eine eingeschaltete Grenze > 0 zählt.
  function peakLimitOf(status) {
    const ps = status && status.peakShaving;
    if (!ps || ps.enabled !== true) return null;
    const w = num(ps.limitW);
    return w !== null && w > 0 ? w : null;
  }

  // --- DOM -------------------------------------------------------------------
  let lastPlan; // undefined = noch nie geholt, null = nicht abrufbar
  let lastStatus = null;

  function render({ plan, status } = {}, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.getElementById('eosPlanSummary')) return;
    if (plan !== undefined) lastPlan = plan;
    if (status) lastStatus = status;
    const set = (id, text) => {
      const el = d.getElementById(id);
      if (!el) return;
      el.textContent = text || '';
      el.hidden = !text;
    };
    if (lastPlan === undefined) { set('eosPlanSummaryNote', 'EOS-Plan wird geladen …'); return; }
    const st = lastStatus || {};
    const v = view(summarize(lastPlan, {
      now: Number(st.now) || Date.now(),
      epex: st.epex && st.epex.data,
      peakLimitW: peakLimitOf(st),
      timeZone: (st.schedule && st.schedule.config && st.schedule.config.timezone) || DEFAULT_TZ,
    }));
    set('eosPlanSummaryNote', v.note);
    for (const [key, prefix] of [['today', 'eosPlanSummaryToday'], ['tomorrow', 'eosPlanSummaryTomorrow']]) {
      const dv = v[key] || {};
      const box = d.getElementById(prefix);
      if (box) box.hidden = !v[key];
      set(`${prefix}Head`, dv.head);
      set(`${prefix}Export`, dv.export);
      set(`${prefix}Import`, dv.import);
      set(`${prefix}Peak`, dv.peak);
    }
  }

  window.DVhubEosPlanSummary = { summarize, view, peakLimitOf, render, BAND_W };
})();
