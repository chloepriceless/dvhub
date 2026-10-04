// services/optimizer/eos-monitor.js — EIN Punkt für „läuft EOS?“ und „letzter Plan“.
//
// Vorher fragte jede Stelle EOS selbst: Inspector, E-Auto-Kachel, DV-EOS-Karte,
// Neustart-Wache, Wallbox- und Geräte-Bridge — jede mit eigenem Timeout und
// eigenem Urteil. EOS rechnet auf einem Kern und antwortet dabei oft > 5 s;
// je nach Stelle hieß das dann „EOS aus“, obwohl es lief (prod 2026-10-01).
//
// Jetzt: alle 30 s ein /v1/health (Timeout 15 s), alle 60 s die Lösung. Wer
// etwas wissen will, liest status() / latestSolution() — ohne eigenen Aufruf.
//
// Push (DV-EOS ab rc1.9, ems.notify_url): EOS meldet jeden fertigen Lauf an
// POST /api/eos/solution-ready, der Monitor holt die Lösung dann sofort.
// Solange Meldungen kommen, fragt er nur noch alle 10 min nach (Rückfall).
//
// Der Leitstand zeigt displayPlan(): den zuletzt geholten Plan, auch wenn EOS
// inzwischen neu gestartet ist (dann gilt er nicht mehr für die Regelung,
// latestSolution() liefert null, aber er ist weiterhin der letzte Plan).
//
// Neustart-Erkennung (2026-10-04): früher nur über die Prozessnummer aus
// /v1/health. Im Container ist die immer 1 — ein neu gestartetes EOS blieb
// unbemerkt, DVhub schickte Prognosen und Einstellungen erst mit dem nächsten
// 15-Minuten-Push, die ersten Läufe brachen ab („Missing or invalid PV“).
// Jetzt gilt als Neustart, wenn EINES davon zutrifft:
//   - die Prozessnummer hat sich geändert (native Installation),
//   - die Startzeit des Prozesses hat sich geändert (health.started_at,
//     DV-EOS ab rc1.14),
//   - EOS hat Verbindungen abgelehnt und antwortet wieder (ein laufender
//     Server lehnt nicht ab; Zeitüberschreitungen zählen nicht — da rechnet er).
//
// Zustände:
//   disabled — EOS-Anbindung aus
//   unknown  — noch keine Antwort seit dem Start
//   up       — letzte Abfrage beantwortet
//   busy     — Zeitüberschreitung, aber vor < 5 min noch geantwortet (rechnet)
//   down     — Verbindung abgelehnt, oder seit ≥ 5 min keine Antwort

export const EOS_HEALTH_INTERVAL_MS = 30_000;
export const EOS_SOLUTION_INTERVAL_MS = 60_000;
export const EOS_BUSY_GRACE_MS = 5 * 60_000;
export const EOS_SOLUTION_MAX_AGE_MS = 30 * 60_000;
export const EOS_SOLUTION_FALLBACK_MS = 10 * 60_000;
// Ohne Meldung so lange gilt Push als ausgefallen → wieder minütlich fragen.
export const EOS_PUSH_STALE_MS = 2 * 3600_000;
const SOLUTION_ROWS = 8 * 24 * 4;

const isTimeout = (err) => /timed out|timeout/i.test(String(err || ''));

/**
 * @param {object} deps
 * @param {()=>boolean} deps.isEnabled          EOS-Anbindung eingeschaltet?
 * @param {()=>Promise<{ok:boolean,data?:object,error?:string}>} deps.getHealth
 * @param {(rows:number)=>Promise<object|null>} deps.fetchSolution
 * @param {()=>number} [deps.now]
 */
export function createEosMonitor({ isEnabled, getHealth, fetchSolution, now = () => Date.now() }) {
  const st = {
    status: 'unknown', pid: null, version: null, startedAt: null,
    lastCheckAt: null, lastOkAt: null, lastError: null, restarts: 0, lastRestartAt: null,
    lastRestartReason: null,
  };
  let refusedSinceOk = false; // Verbindung abgelehnt, seit EOS zuletzt geantwortet hat
  let solution = null;       // { data, at }
  let displayed = null;      // { data, at } — überlebt EOS-Neustarts
  let solutionTryAt = 0;
  let lastPushAt = null;
  let pushCount = 0;
  const solutionListeners = new Set();
  let healthFlight = null;
  let solutionFlight = null;
  const restartListeners = new Set();
  let healthTimer = null;
  let solutionTimer = null;

  async function checkHealth() {
    if (!isEnabled()) { st.status = 'disabled'; return st.status; }
    if (healthFlight) return healthFlight;
    healthFlight = (async () => {
      st.lastCheckAt = now();
      let res;
      try { res = await getHealth(); } catch (e) { res = { ok: false, error: String(e?.message || e) }; }
      if (res?.ok) {
        const pid = Number(res.data?.pid);
        const newPid = Number.isFinite(pid) ? pid : null;
        const newStartedAt = typeof res.data?.started_at === 'string' && res.data.started_at ? res.data.started_at : null;
        const pidChanged = st.pid !== null && newPid !== null && newPid !== st.pid;
        const startChanged = st.startedAt !== null && newStartedAt !== null && newStartedAt !== st.startedAt;
        // Nur wenn wir EOS in diesem Prozess schon einmal erreicht hatten: ein
        // beim DVhub-Start noch nicht laufendes EOS ist kein „Neustart“.
        const cameBack = refusedSinceOk && st.lastOkAt !== null;
        const reason = pidChanged ? 'pid' : (startChanged ? 'started_at' : (cameBack ? 'connection_refused' : null));
        const restarted = reason !== null;
        const oldPid = st.pid;
        refusedSinceOk = false;
        Object.assign(st, { status: 'up', lastOkAt: now(), lastError: null, version: res.data?.version || st.version });
        if (newPid !== null) st.pid = newPid;
        if (newStartedAt !== null) st.startedAt = newStartedAt;
        if (restarted) {
          st.restarts += 1; st.lastRestartAt = now(); st.lastRestartReason = reason;
          solution = null; // Plan des alten Prozesses gilt nicht mehr
          for (const fn of restartListeners) { try { await fn({ oldPid, newPid, reason }); } catch { /* Aufrufer loggt */ } }
        }
      } else {
        st.lastError = res?.error || 'no_response';
        if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(st.lastError)) refusedSinceOk = true;
        const recentlyOk = st.lastOkAt !== null && now() - st.lastOkAt < EOS_BUSY_GRACE_MS;
        st.status = isTimeout(st.lastError) && recentlyOk ? 'busy' : 'down';
      }
      return st.status;
    })().finally(() => { healthFlight = null; });
    return healthFlight;
  }

  const pushActive = () => lastPushAt !== null && now() - lastPushAt < EOS_PUSH_STALE_MS;
  const solutionIntervalMs = () => (pushActive() ? EOS_SOLUTION_FALLBACK_MS : EOS_SOLUTION_INTERVAL_MS);

  /** Eine geholte Lösung übernehmen; Zuhörer hören nur neue Pläne. */
  function ingest(sol) {
    if (!sol || !Array.isArray(sol.rows)) return false;
    const previous = solution?.data?.generatedAt ?? null;
    solution = { data: sol, at: now() };
    displayed = solution;
    const stamp = sol.generatedAt ?? null;
    if (stamp && stamp !== previous) {
      for (const fn of solutionListeners) { try { fn(stamp, sol); } catch { /* Aufrufer loggt */ } }
    }
    return true;
  }

  async function refreshSolution({ force = false } = {}) {
    if (!isEnabled()) return solution;
    if (solutionFlight) return solutionFlight;
    // Rechnet EOS gerade, nicht noch zusätzlich die große Lösung abholen.
    // Eine Push-Meldung (force) heißt: Lauf fertig, EOS antwortet wieder.
    if (!force && (st.status === 'down' || st.status === 'busy')) return solution;
    solutionFlight = (async () => {
      solutionTryAt = now();
      try {
        ingest(await fetchSolution(SOLUTION_ROWS));
      } catch { /* letzter Plan bleibt */ }
      return solution;
    })().finally(() => { solutionFlight = null; });
    return solutionFlight;
  }

  return {
    start() {
      if (healthTimer) return;
      checkHealth().then(() => refreshSolution()).catch(() => {});
      healthTimer = setInterval(() => { checkHealth().catch(() => {}); }, EOS_HEALTH_INTERVAL_MS);
      solutionTimer = setInterval(() => {
        if (now() - solutionTryAt < solutionIntervalMs() - 1000) return;
        refreshSolution().catch(() => {});
      }, EOS_SOLUTION_INTERVAL_MS);
      healthTimer.unref?.(); solutionTimer.unref?.();
    },
    stop() {
      clearInterval(healthTimer); clearInterval(solutionTimer);
      healthTimer = null; solutionTimer = null;
    },
    checkHealth,
    refreshSolution,
    ingest,
    /**
     * Push von EOS (POST /api/eos/solution-ready): Lauf fertig → Lösung sofort
     * holen. Meldet EOS denselben Plan doppelt, wird trotzdem nur einmal geholt
     * (laufender Abruf wird geteilt).
     */
    async notifySolutionReady() {
      lastPushAt = now();
      pushCount += 1;
      if (st.status === 'busy' || st.status === 'unknown') st.status = 'up';
      return refreshSolution({ force: true });
    },
    /** Momentaufnahme — kein Netzaufruf. */
    status() {
      const enabled = isEnabled();
      return {
        ...st,
        status: enabled ? st.status : 'disabled',
        enabled,
        reachable: enabled && (st.status === 'up' || st.status === 'busy'),
        solutionAt: solution?.at ?? null,
        solutionGeneratedAt: solution?.data?.generatedAt ?? null,
        push: { active: pushActive(), lastAt: lastPushAt, count: pushCount },
      };
    },
    /** up oder busy: EOS läuft (rechnet evtl. gerade). */
    isUp: () => isEnabled() && (st.status === 'up' || st.status === 'busy'),
    /**
     * Letzter Plan, höchstens maxAgeMs alt. Ohne Plan im Speicher (Start)
     * einmal abholen; ist er älter als 60 s, nebenbei auffrischen.
     */
    async latestSolution({ maxAgeMs = EOS_SOLUTION_MAX_AGE_MS } = {}) {
      if (!solution) {
        if (st.status === 'unknown') await checkHealth();
        await refreshSolution();
      } else if (now() - solutionTryAt >= solutionIntervalMs()) {
        refreshSolution().catch(() => {});
      }
      // Auch mit Push wird spätestens alle 10 min neu geholt (solution.at).
      return solution && now() - solution.at <= maxAgeMs ? solution.data : null;
    },
    /**
     * Für die Anzeige: der zuletzt geholte Plan, auch über EOS-Neustarts hinweg.
     * Holt einmal selbst, wenn noch gar keiner da ist. Kein Plan → null.
     * @returns {Promise<null|{data:object, at:number, current:boolean}>}
     */
    async displayPlan() {
      if (!displayed && isEnabled()) {
        if (st.status === 'unknown') await checkHealth();
        await refreshSolution();
      }
      if (!displayed) return null;
      return { data: displayed.data, at: displayed.at, current: solution === displayed };
    },
    onSolution(fn) { solutionListeners.add(fn); return () => solutionListeners.delete(fn); },
    onRestart(fn) { restartListeners.add(fn); return () => restartListeners.delete(fn); },
  };
}
