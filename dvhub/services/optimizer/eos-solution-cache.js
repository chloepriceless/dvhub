// services/optimizer/eos-solution-cache.js — letzte EOS-Lösung für Anzeigen.
//
// Liest /v1/energy-management/optimization/solution (ohne Prognose-Push) und
// hält das letzte gültige Ergebnis. Antwortet EOS gerade nicht (rechnet auf
// einem Kern, Timeout), gilt der letzte Plan bis MAX_AGE weiter — sonst
// zeigte die E-Auto-Kachel „kein Plan: eos_off“, obwohl EOS lief.

export const EOS_SOLUTION_MIN_REFRESH_MS = 20_000;
export const EOS_SOLUTION_MAX_AGE_MS = 30 * 60_000;

export function createEosSolutionCache({ fetchSolution, now = () => Date.now() }) {
  let last = null;      // { solution, at }
  let inflight = null;
  let lastTryAt = 0;

  async function refresh() {
    lastTryAt = now();
    try {
      const sol = await fetchSolution();
      if (sol && Array.isArray(sol.rows)) last = { solution: sol, at: now() };
      return !!sol;
    } catch {
      return false;
    }
  }

  return {
    /** → { solution, stale, reason } oder { solution:null, reason } */
    async get() {
      if (!last || now() - lastTryAt >= EOS_SOLUTION_MIN_REFRESH_MS) {
        inflight = inflight || refresh().finally(() => { inflight = null; });
        await inflight;
      }
      if (last && now() - last.at <= EOS_SOLUTION_MAX_AGE_MS) {
        return { solution: last.solution, stale: now() - last.at > EOS_SOLUTION_MIN_REFRESH_MS * 3, reason: null };
      }
      return { solution: null, reason: 'EOS antwortet nicht' };
    },
    peek: () => last,
  };
}
