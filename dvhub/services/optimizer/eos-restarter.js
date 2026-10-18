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
//   - Nur für das EOS auf derselben Box (URL auf 127.0.0.1/localhost).
//   - Docker (2026-10-18): dort gibt es kein systemd. DVhub legt eine
//     Neustart-Anforderung ab; der Wächter im EOS-Container (docker/compose.yml,
//     configs dvhub-eos-watch) fragt GET /api/eos/restart-request ab, beendet EOS
//     bei einer Anforderung, die jünger ist als sein Start, und Docker startet den
//     Container neu. Nur wenn sich der Wächter gemeldet hat — ältere Compose-
//     Dateien ohne Wächter bleiben bei „container“ (kein Knopf ohne Wirkung).

import { resolveEosProxy } from './eos-adapter.js';

export const EOS_STALL_RESTART_MIN_DEFAULT = 90;
export const EOS_STALL_RESTART_MIN_FLOOR = 30;
export const EOS_WATCHDOG_INTERVAL_MS = 60_000;
export const EOS_WATCHDOG_COOLDOWN_MS = 2 * 3600_000;
export const EOS_MANUAL_RESTART_MIN_GAP_MS = 60_000;
export const EOS_SERVICE_NAME_DEFAULT = 'eos.service';
// Wächter im Container gilt als da, wenn er sich so kürzlich gemeldet hat (fragt jede Minute).
export const EOS_CONTAINER_HELPER_FRESH_MS = 5 * 60_000;
// Kommt EOS nach einer Anforderung so lange nicht neu hoch, gilt sie als gescheitert.
export const EOS_CONTAINER_RESTART_TIMEOUT_MS = 10 * 60_000;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Kann DVhub dieses EOS neu starten?
 * @returns {{ok:boolean, reason:null|'eos_off'|'container'|'remote'}}
 */
export function eosRestartability(cfg, { inContainer = false, containerHelper = false } = {}) {
  const proxy = resolveEosProxy(cfg);
  if (!proxy.enabled) return { ok: false, reason: 'eos_off' };
  if (inContainer && !containerHelper) return { ok: false, reason: 'container' };
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
  // Docker: Anforderung an den Wächter im EOS-Container und dessen letzte Meldung.
  let containerRequest = null;   // { at, via, reason }
  let helperSeenAt = 0;
  let helperBootAt = null;
  const helperAlive = () => inContainer && helperSeenAt > 0 && now() - helperSeenAt < EOS_CONTAINER_HELPER_FRESH_MS;
  const restartability = (cfg) => eosRestartability(cfg, { inContainer, containerHelper: helperAlive() });

  const log = (type, data, actor) => { try { pushLog?.(type, data, actor); } catch { /* Log darf nie stören */ } };

  function status() {
    // Auch hier (nicht nur in der Wache): mit getrenntem Runtime-Prozess läuft die
    // Wache in einem anderen Prozess als der Knopf (Codex 2026-10-18).
    expireContainerRequest();
    const cfg = getCfg() || {};
    const cap = restartability(cfg);
    const stallMs = stallRestartMs(cfg);
    const stalled = stalledRunMs(state?.optimizer?.eosRun, now(), stallMs);
    return {
      canRestart: cap.ok,
      reason: cap.reason,
      serviceName,
      stallRestartMin: stallMs / 60_000,
      stalledForMin: stalled === null ? null : Math.round(stalled / 60_000),
      restarting: inFlight !== null || containerRequest !== null,
      restarts,
      lastRestart,
      mode: inContainer ? 'container' : 'systemd',
      helperSeenAt: inContainer && helperSeenAt ? new Date(helperSeenAt).toISOString() : null,
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
    const cap = restartability(getCfg() || {});
    if (!cap.ok) return Promise.resolve({ ok: false, error: cap.reason });
    if (inFlight) return inFlight;
    if (containerRequest) return Promise.resolve({ ok: true, pending: true });
    if (via !== 'watchdog' && lastRestart && now() - lastRestart.at < EOS_MANUAL_RESTART_MIN_GAP_MS) {
      return Promise.resolve({ ok: false, error: 'too_soon' });
    }
    const at = now();
    log('eos_restart_requested', { via, reason, service: inContainer ? 'container' : serviceName }, actor);
    if (inContainer) {
      // Ausführen tut der Wächter im EOS-Container; fertig ist es, wenn er sich
      // mit einem Start nach der Anforderung zurückmeldet (helperPoll).
      containerRequest = { at, via, reason };
      lastRestart = { at, via, reason, ok: true, pending: true, error: null };
      publish();
      return Promise.resolve({ ok: true, pending: true });
    }
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

  /**
   * Meldung des Wächters im EOS-Container (GET /api/eos/restart-request?boot=).
   * boot = Startzeit des Wächters (ms). Startete er nach der Anforderung, ist
   * der Neustart erledigt. Antwort: Zeit der offenen Anforderung oder null.
   */
  function helperPoll({ boot } = {}) {
    expireContainerRequest();
    helperSeenAt = now();
    const b = Number(boot);
    if (Number.isFinite(b) && b > 0) helperBootAt = b;
    if (containerRequest && helperBootAt !== null && helperBootAt >= containerRequest.at) {
      const r = containerRequest;
      containerRequest = null;
      restarts += 1;
      lastRestart = { at: r.at, via: r.via, reason: r.reason, ok: true, pending: false, error: null };
      log('eos_restarted', { via: r.via, reason: r.reason, service: 'container', seconds: Math.round((helperBootAt - r.at) / 1000) });
    }
    publish();
    return { requestedAt: containerRequest ? containerRequest.at : null };
  }

  function expireContainerRequest() {
    if (!containerRequest || now() - containerRequest.at < EOS_CONTAINER_RESTART_TIMEOUT_MS) return;
    const r = containerRequest;
    containerRequest = null;
    const error = 'EOS-Container hat nicht neu gestartet (Wächter meldet keinen Neustart)';
    lastRestart = { at: r.at, via: r.via, reason: r.reason, ok: false, pending: false, error };
    log('eos_restart_failed', { via: r.via, reason: r.reason, service: 'container', error });
  }

  /** Ein Takt der Wache. Wirft nie. */
  async function watchdogTick() {
    try {
      expireContainerRequest();
      const cfg = getCfg() || {};
      const stalled = stalledRunMs(state?.optimizer?.eosRun, now(), stallRestartMs(cfg));
      if (stalled === null) return { action: 'none' };
      if (!restartability(cfg).ok) return { action: 'none', reason: 'cannot_restart' };
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
    helperPoll,
    start() {
      if (timer) return;
      publish();
      timer = setTimer(() => { watchdogTick(); }, EOS_WATCHDOG_INTERVAL_MS);
    },
    stop() { if (timer) clearTimer(timer); timer = null; },
  };
}
