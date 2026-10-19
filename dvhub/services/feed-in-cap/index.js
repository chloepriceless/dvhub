// services/feed-in-cap/index.js — feste Einspeisegrenze (2026-10-20).
//
// Viele Anlagen dürfen am Netzanschlusspunkt nur einen Teil ihrer installierten
// Leistung einspeisen: 60 % (Solarspitzengesetz, neue Anlagen ohne Smart Meter
// mit Steuerbox), 70 % (ältere kleine Anlagen) oder einen vom Netzbetreiber
// vorgegebenen Wert. Andere haben keine Grenze. Welche gilt, weiß nur der
// Betreiber — ab Werk ist deshalb NICHTS gesetzt (feedInCap.mode = ''), und
// DVhub weist darauf hin, bis eine Wahl getroffen ist (auch „keine“).
//
// Begrenzt wird die EINSPEISUNG, nicht die Erzeugung: Haus und Akku dürfen
// mehr PV nutzen.
//
// Wege zur Grenze (enforcementPath):
//   native — der Hersteller hat einen Einspeisebegrenzer (Victron 2706
//            MaxFeedInPower, controlWrite.dvFeedInLimitW). Die Grenze wird zur
//            festen Quelle 'fixed' im Begrenzer (feed-in-limit-arbiter.js):
//            Direktvermarkter und Steuerbox können nur tiefer gehen; heben sie
//            auf, gilt wieder diese Grenze. Der Wert liegt im GX gespeichert
//            und gilt auch, wenn DVhub nicht läuft; der GX regelt selbst am
//            Netzzähler nach. DVhub prüft ihn alle 10 min nach.
//   loop   — nur eine Erzeugungsgrenze in % (SunSpec WMaxLimPct, Fronius):
//            Regelschleife in schedule-eval.js (capLoopStep, 5-s-Takt). Das
//            Gerät fällt nach WMaxLimPct_RvrtTms auf 100 % zurück — die
//            gesetzliche Grenze muss deshalb zusätzlich im Wechselrichter
//            selbst stehen; DVhub sagt das im Hinweis.
//   unsupported — weder noch: DVhub kann nur überwachen.
//
// Überwachung (alle Wege): gemessene Einspeisung länger als 60 s über Grenze +
// Toleranz → Meldung und Warnung, bis sie 30 s wieder darunter liegt.

export const FEED_IN_CAP_MODES = Object.freeze(['', 'none', 'pct60', 'pct70', 'pct', 'watts']);
export const FEED_IN_CAP_TICK_MS = 5000;
const READBACK_MS = 10 * 60_000;
const EXCEED_AFTER_MS = 60_000;
const RECOVER_AFTER_MS = 30_000;
const METER_MAX_AGE_MS = 15_000;

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** Installierte PV-Leistung (kWp): Summe der PV-Anlagen, sonst Prognose-kWp. */
export function installedKwp(cfg) {
  const list = Array.isArray(cfg?.userEnergyPricing?.pvPlants) ? cfg.userEnergyPricing.pvPlants : [];
  const sum = list.reduce((a, p) => a + (Number(p?.kwp) > 0 ? Number(p.kwp) : 0), 0);
  if (sum > 0) return Math.round(sum * 1000) / 1000;
  const total = Number(cfg?.forecast?.pv?.totalKwp);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * @returns {{ mode: string, configured: boolean, limitW: number|null, pct: number|null,
 *   kwp: number|null, error: string|null }}
 */
export function resolveFeedInCap(cfg) {
  const c = cfg?.feedInCap || {};
  const mode = FEED_IN_CAP_MODES.includes(c.mode) ? c.mode : '';
  const kwp = installedKwp(cfg);
  const out = { mode, configured: mode !== '', limitW: null, pct: null, kwp, error: null };
  if (mode === '' || mode === 'none') return out;
  if (mode === 'watts') {
    if (!isNum(c.watts) || Number(c.watts) < 0) return { ...out, error: 'watts_invalid' };
    return { ...out, limitW: Math.round(Number(c.watts)) };
  }
  const pct = mode === 'pct60' ? 60 : mode === 'pct70' ? 70 : Number(c.percent);
  if (!isNum(pct) || pct <= 0 || pct > 100) return { ...out, error: 'percent_invalid' };
  if (!kwp) return { ...out, pct, error: 'kwp_missing' };
  return { ...out, pct, limitW: Math.round(kwp * 10 * pct) };
}

export function enforcementPath(cfg, transportType) {
  const cw = cfg?.controlWrite || {};
  // Der Begrenzer wird per Modbus geschrieben (runDvControlSequence) — über
  // MQTT gibt es diesen Weg nicht.
  if (transportType === 'modbus' && cw.dvFeedInLimitW?.enabled) return 'native';
  if (transportType === 'modbus' && cw.wMaxLimPct?.enabled && cw.wMaxLimPct.address != null
    && cw.wMaxLimEna?.enabled && cw.wMaxLimEna.address != null) return 'loop';
  return 'unsupported';
}

/**
 * Ein Schritt der Regelschleife (rein, ändert nur st).
 * Ziel: Einspeisung knapp UNTER der Grenze (Abstand 3 %, mind. 100 W), damit
 * Mess- und Stellverzug in Richtung „zu wenig“ fallen. Runter sofort und voll,
 * hoch gedämpft (30 %); nie unter 1 % (0 % legt den Wechselrichter still und
 * das Haus zöge Netzstrom). Bleibt die Einspeisung bei 100 % sechs Takte
 * deutlich unter dem Ziel, wird die Drosselung abgeschaltet.
 * @returns {{ write: boolean, limitPct?: number, ena?: 0|1, enter?: boolean, exit?: boolean }}
 */
export function capLoopStep(st, { exportW, importW, limitW, refW, pvW, meterFresh }) {
  const ref = Number(refW) > 0 ? Number(refW) : 10000;
  const margin = Math.max(100, 0.03 * limitW);
  const target = Math.max(0, limitW - margin);
  const dead = Math.max(50, 0.01 * limitW);
  const clamp = (p) => Math.min(100, Math.max(1, p));
  if (!meterFresh) return st.capActive ? { write: true, limitPct: st.limitPct, ena: 1 } : { write: false };
  const exp = Math.max(0, Number(exportW) || 0);
  if (!st.capActive) {
    if (exp <= target) return { write: false };
    const pv = Number(pvW);
    const startW = Number.isFinite(pv) && pv > 0 ? pv - (exp - target) : ref - (exp - target);
    st.capActive = true;
    st.limitPct = clamp((100 * Math.max(0, startW)) / ref);
    st.below = 0;
    return { write: true, enter: true, limitPct: st.limitPct, ena: 1 };
  }
  // Mit Vorzeichen (Einspeisung − Bezug): Bei 0 W ist die Einspeisung nie
  // negativ — erst der Netzbezug zeigt, dass das Haus mehr PV brauchen kann.
  const err = exp - Math.max(0, Number(importW) || 0) - target;
  if (err > 0) st.limitPct = clamp(st.limitPct - (100 * err) / ref);
  else if (err < -dead) st.limitPct = clamp(st.limitPct + (100 * 0.3 * -err) / ref);
  st.below = st.limitPct >= 100 && exp < target - 2 * dead ? (st.below || 0) + 1 : 0;
  if (st.below >= 6) {
    st.capActive = false;
    st.limitPct = null;
    st.below = 0;
    return { write: true, exit: true, ena: 0 };
  }
  return { write: true, limitPct: st.limitPct, ena: 1 };
}

/** Überwachung: Einspeisung gegen Grenze, Toleranz 2 % (mind. 100 W). */
export function createExceedMonitor({ now = () => Date.now() } = {}) {
  let overSince = null;
  let underSince = null;
  let open = null; // laufende gemeldete Überschreitung
  let episodes = 0;
  let lastEpisode = null;

  function observe({ exportW, limitW }) {
    const t = now();
    if (!isNum(limitW)) {
      overSince = null; underSince = null;
      // Grenze aufgehoben während einer Überschreitung → Episode beenden.
      if (open) {
        lastEpisode = { ...open, end: t, reason: 'limit_removed' };
        open = null;
        return { event: 'recovered', episode: { ...lastEpisode } };
      }
      return {};
    }
    const tol = Math.max(100, 0.02 * limitW);
    const exp = Math.max(0, Number(exportW) || 0);
    if (exp > limitW + tol) {
      underSince = null;
      if (overSince == null) overSince = { at: t, maxW: exp };
      overSince.maxW = Math.max(overSince.maxW, exp);
      if (open) { open.maxW = Math.max(open.maxW, exp); return {}; }
      if (t - overSince.at >= EXCEED_AFTER_MS) {
        open = { start: overSince.at, maxW: overSince.maxW, limitW, lastW: exp };
        episodes += 1;
        return { event: 'exceeded', episode: { ...open } };
      }
      return {};
    }
    overSince = null;
    if (!open) return {};
    if (exp > limitW) { underSince = null; return {}; }
    if (underSince == null) underSince = t;
    if (t - underSince >= RECOVER_AFTER_MS) {
      lastEpisode = { ...open, end: t };
      open = null;
      underSince = null;
      return { event: 'recovered', episode: { ...lastEpisode } };
    }
    return {};
  }

  function status() {
    return { exceeding: Boolean(open), current: open ? { ...open } : null, episodes, lastEpisode: open ? { ...open } : lastEpisode };
  }

  return { observe, status };
}

const WARN_UNSET = 'Einspeisegrenze nicht angegeben: Bitte unter Einstellungen → Netz & Recht wählen, ob für die Anlage eine feste Einspeisegrenze gilt (z. B. 60 % oder 70 % der installierten Leistung) oder keine.';

/**
 * Der Dienst. tick() alle 5 s (start()); die Regelschleife selbst läuft in
 * schedule-eval.js und liest limitForLoop().
 */
export function createFeedInCap(ctx, deps = {}) {
  const now = deps.now || (() => Date.now());
  const setWarning = deps.setWarning || (() => {});
  const monitor = createExceedMonitor({ now });
  let lastReadbackAt = 0;
  let timer = null;
  let busy = false;
  let last = { resolved: null, path: null, readback: null };

  function cfg() { return ctx.getCfg?.() || {}; }
  function transportType() { return deps.getTransport?.()?.type || null; }

  function configWarning(r, path) {
    if (r.error === 'kwp_missing') return 'Einspeisegrenze in Prozent gewählt, aber keine Anlagengröße (kWp) eingetragen — bitte unter Einstellungen → Tarife & PV-Anlagen die kWp angeben oder die Grenze in Watt einstellen.';
    if (r.error) return 'Einspeisegrenze: ungültiger Wert — bitte unter Einstellungen → Netz & Recht prüfen.';
    if (r.limitW == null) return null;
    if (path === 'unsupported') return `Einspeisegrenze ${r.limitW} W: DVhub kann sie an diesem Gerät nicht setzen und überwacht sie nur. Bitte die Grenze im Wechselrichter selbst einstellen.`;
    return null;
  }

  async function readbackNative(limitW) {
    const t = now();
    if (t - lastReadbackAt < READBACK_MS) return;
    lastReadbackAt = t;
    const point = cfg().controlWrite?.dvFeedInLimitW;
    const transport = deps.getTransport?.();
    if (!point || typeof transport?.mbRequest !== 'function') return;
    try {
      const regs = await transport.mbRequest({ fc: 3, host: point.host, port: point.port, unitId: point.unitId, address: point.address, quantity: 1, timeoutMs: point.timeoutMs });
      let raw = Number(regs?.[0]);
      if (point.signed && raw >= 0x8000) raw -= 0x10000;
      const readW = raw === -1 ? null : raw * Number(point.scale ?? 1);
      last.readback = { at: new Date(t).toISOString(), readW };
      const eff = ctx.feedInLimit?.effective?.();
      // Steht im Gerät etwas anderes (am GX verstellt, GX getauscht …) → neu schreiben.
      if (eff != null && (readW == null || Math.abs(readW - eff) > 100)) {
        ctx.pushLog?.('feed_in_cap_readback_mismatch', { readW, expectedW: eff }, 'warn');
        await ctx.feedInLimit.reapply?.();
      }
    } catch { /* Diagnose — nie den Takt brechen */ }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const c = cfg();
      const r = resolveFeedInCap(c);
      const path = enforcementPath(c, transportType());
      last = { ...last, resolved: r, path };
      setWarning('feed_in_cap_unset', r.configured ? null : WARN_UNSET);
      setWarning('feed_in_cap_config', configWarning(r, path));

      if (path === 'native' && ctx.feedInLimit) {
        // Arbiter schreibt nur bei Änderung; null = Wert von vor DVhub zurück.
        try { await ctx.feedInLimit.set('fixed', r.limitW); } catch (e) {
          ctx.pushLog?.('feed_in_cap_write_error', { limitW: r.limitW, error: e?.message || String(e) }, 'warn');
        }
        if (r.limitW != null) await readbackNative(r.limitW);
      }

      // Überwachung gegen die wirksame Grenze (DV/Steuerbox dürfen tiefer liegen).
      const s = ctx.state || {};
      const meterFresh = s.meter?.ok === true && now() - Number(s.meter.updatedAt || 0) < METER_MAX_AGE_MS;
      const eff = path === 'native' && ctx.feedInLimit?.effective ? ctx.feedInLimit.effective() : r.limitW;
      const limitW = eff != null && r.limitW != null ? Math.min(eff, r.limitW) : (r.limitW ?? null);
      if (meterFresh || limitW == null) {
        const res = monitor.observe({ exportW: s.victron?.gridExportW, limitW });
        if (res.event === 'exceeded') {
          ctx.pushLog?.('feed_in_cap_exceeded', res.episode, 'warn');
          setWarning('feed_in_cap_exceeded', `Einspeisung über der Grenze: ${Math.round(res.episode.lastW)} W statt höchstens ${res.episode.limitW} W (seit ${new Date(res.episode.start).toLocaleTimeString('de-DE')}).`);
        } else if (res.event === 'recovered') {
          ctx.pushLog?.('feed_in_cap_recovered', res.episode);
          setWarning('feed_in_cap_exceeded', null);
        }
      }
      if (limitW == null && monitor.status().exceeding === false) setWarning('feed_in_cap_exceeded', null);
    } finally {
      busy = false;
    }
  }

  /** Grenze für die Regelschleife (nur Weg „loop“), sonst null. */
  function limitForLoop() {
    const c = cfg();
    if (enforcementPath(c, transportType()) !== 'loop') return null;
    return resolveFeedInCap(c).limitW;
  }

  function status() {
    const r = last.resolved || resolveFeedInCap(cfg());
    return {
      ...r,
      path: last.path || enforcementPath(cfg(), transportType()),
      effectiveW: ctx.feedInLimit?.effective?.() ?? null,
      sources: ctx.feedInLimit?.sources?.() ?? {},
      loop: ctx.state?.ctrl?._fic ? { active: Boolean(ctx.state.ctrl._fic.capActive), limitPct: ctx.state.ctrl._fic.limitPct ?? null } : null,
      readback: last.readback,
      monitor: monitor.status(),
    };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, FEED_IN_CAP_TICK_MS);
    timer.unref?.();
    tick().catch(() => {});
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { tick, status, limitForLoop, start, stop };
}
