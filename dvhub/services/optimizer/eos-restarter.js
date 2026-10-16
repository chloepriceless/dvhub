// services/optimizer/eos-restarter.js — EOS neu starten: per Knopf und von selbst.
//
// Feldfall 2026-10-15 (BIGGE): EOS antwortete auf /v1/health, rechnete aber
// nicht mehr. Ein Rechenprozess hing seit einem Lauf, jeder weitere Auftrag
// wartete dahinter bis zum Timeout (EOS_RUN_TIMEOUT_MS, 3 h). DVhub zeigte
// „online“ und den Plan vom Vorabend; neu starten konnte EOS nur, wer sudo hat.
// Ein Neustart von DVhub hilft nicht: post-update.sh startet EOS nur, wenn es
// gar nicht läuft.
//
//   - restart(): `sudo -n systemctl restart eos.service` (eigene sudoers-Regel,
//     nur genau diese Unit) — für den Knopf in der Oberfläche und die Wache.
//   - Wache: rechnet ein von DVhub angestoßener Lauf länger als
//     optimizer.eosStallRestartMin (Standard 90 min, 0 = aus), startet DVhub
//     EOS neu — höchstens alle 2 h, damit ein dauerhaft kaputtes EOS nicht im
//     Kreis neu startet. Der hängende Aufruf bricht mit dem Neustart ab, der
//     EOS-Monitor erkennt den neuen Prozess und stößt Abgleich + Lauf an.
//   - Nur für das EOS auf derselben Box (URL auf 127.0.0.1/localhost) und nicht
//     im Container (dort ist EOS ein eigener Container ohne systemd).

import { resolveEosProxy } from './eos-adapter.js';

export const EOS_STALL_RESTART_MIN_DEFAULT = 90;
export const EOS_STALL_RESTART_MIN_FLOOR = 30;
export const EOS_WATCHDOG_INTERVAL_MS = 60_000;
export const EOS_WATCHDOG_COOLDOWN_MS = 2 * 3600_000;
export const EOS_MANUAL_RESTART_MIN_GAP_MS = 60_000;
export const EOS_SERVICE_NAME_DEFAULT = 'eos.service';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Kann DVhub dieses EOS neu starten?
 * @returns {{ok:boolean, reason:null|'eos_off'|'container'|'remote'}}
 */
export function eosRestartability(cfg, { inContainer = false } = {}) {
  const proxy = resolveEosProxy(cfg);
  if (!proxy.enabled) return { ok: false, reason: 'eos_off' };
  if (inContainer) return { ok: false, reason: 'container' };
  let host = '';
  try { host = new URL(proxy.url).hostname.toLowerCase(); } catch { /* ungültige URL → nicht lokal */ }
  if (!LOCAL_HOSTS.has(host)) return { ok: false, reason: 'remote' };
  return { ok: true, reason: null };
}

/** Ab wie viel ms gilt ein Lauf als hängend; 0 = Wache aus. */
export function stallRestartMs(cfg) {
  const raw = cfg?.optimizer?.eosStallRestartMin;
  if (raw === 0) return 0;
  const min = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.max(EOS_STALL_RESTART_MIN_FLOOR, raw)
    : EOS_STALL_RESTART_MIN_DEFAULT;
  return min * 60_000;
}

/**
 * Wie lange rechnet der laufende Lauf schon über die Grenze hinaus?
 * @param {{inFlight?:boolean, startedAt?:number}|null} eosRun  state.optimizer.eosRun
 * @returns {number|null} Laufzeit in ms, wenn er als hängend gilt, sonst null
 */
export function stalledRunMs(eosRun, nowMs, stallMs) {
  if (!(stallMs > 0) || !eosRun || eosRun.inFlight !== true) return null;
  const startedAt = eosRun.startedAt;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null;
  const running = nowMs - startedAt;
  return running > stallMs ? running : null;
}

/**
 * @param {object} deps
 * @param {()=>object} deps.getCfg
 * @param {object} [deps.state]                 liest state.optimizer.eosRun, schreibt state.optimizer.eosRestart
 * @param {(args:string[])=>Promise<{ok:boolean,error?:string}>} deps.exec  systemctl-Aufruf (mit sudo)
 * @param {string} [deps.serviceName]
 * @param {boolean} [deps.inContainer]
 * @param {(type:string, data:object, actor?:object)=>void} [deps.pushLog]
 */
export function createEosRestarter({
  getCfg, state, exec, serviceName = EOS_SERVICE_NAME_DEFAULT, inContainer = false, pushLog,
  now = () => Date.now(),
  setTimer = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearInterval(t),
}) {
  let lastRestart = null;   // { at, via, reason, ok, error }
  let restarts = 0;
  let inFlight = null;
  let lastWatchdogAt = 0;
  let timer = null;

  const log = (type, data, actor) => { try { pushLog?.(type, data, actor); } catch { /* Log darf nie stören */ } };

  function status() {
    const cfg = getCfg() || {};
    const cap = eosRestartability(cfg, { inContainer });
    const stallMs = stallRestartMs(cfg);
    const stalled = stalledRunMs(state?.optimizer?.eosRun, now(), stallMs);
    return {
      canRestart: cap.ok,
      reason: cap.reason,
      serviceName,
      stallRestartMin: stallMs / 60_000,
      stalledForMin: stalled === null ? null : Math.round(stalled / 60_000),
      restarting: inFlight !== null,
      restarts,
      lastRestart,
    };
  }

  function publish() {
    if (!state) return;
    if (!state.optimizer) state.optimizer = {};
    state.optimizer.eosRestart = status();
  }

  /**
   * EOS neu starten. Wirft nie.
   * @returns {Promise<{ok:boolean, error?:string, detail?:string}>}
   */
  function restart({ via = 'ui', reason = null, actor = null } = {}) {
    const cap = eosRestartability(getCfg() || {}, { inContainer });
    if (!cap.ok) return Promise.resolve({ ok: false, error: cap.reason });
    if (inFlight) return inFlight;
    if (via !== 'watchdog' && lastRestart && now() - lastRestart.at < EOS_MANUAL_RESTART_MIN_GAP_MS) {
      return Promise.resolve({ ok: false, error: 'too_soon' });
    }
    const at = now();
    log('eos_restart_requested', { via, reason, service: serviceName }, actor);
    inFlight = (async () => {
      let res;
      try { res = await exec(['restart', serviceName]); } catch (e) { res = { ok: false, error: String(e?.message || e) }; }
      const ok = res?.ok === true;
      lastRestart = { at, via, reason, ok, error: ok ? null : String(res?.error || 'restart failed').slice(0, 300) };
      if (ok) restarts += 1;
      log(ok ? 'eos_restarted' : 'eos_restart_failed', { via, reason, service: serviceName, error: lastRestart.error }, actor);
      return ok ? { ok: true } : { ok: false, error: 'restart_failed', detail: lastRestart.error };
    })().finally(() => { inFlight = null; publish(); });
    publish();
    return inFlight;
  }

  /** Ein Takt der Wache. Wirft nie. */
  async function watchdogTick() {
    try {
      const cfg = getCfg() || {};
      const stalled = stalledRunMs(state?.optimizer?.eosRun, now(), stallRestartMs(cfg));
      if (stalled === null) return { action: 'none' };
      if (!eosRestartability(cfg, { inContainer }).ok) return { action: 'none', reason: 'cannot_restart' };
      if (lastWatchdogAt && now() - lastWatchdogAt < EOS_WATCHDOG_COOLDOWN_MS) return { action: 'cooldown' };
      lastWatchdogAt = now();
      const minutes = Math.round(stalled / 60_000);
      const r = await restart({ via: 'watchdog', reason: `EOS-Lauf rechnet seit ${minutes} min` });
      return { action: 'restart', ...r };
    } catch (e) {
      log('eos_watchdog_error', { error: String(e?.message || e) });
      return { action: 'error' };
    } finally {
      publish();
    }
  }

  return {
    status,
    restart,
    watchdogTick,
    start() {
      if (timer) return;
      publish();
      timer = setTimer(() => { watchdogTick(); }, EOS_WATCHDOG_INTERVAL_MS);
    },
    stop() { if (timer) clearTimer(timer); timer = null; },
  };
}
