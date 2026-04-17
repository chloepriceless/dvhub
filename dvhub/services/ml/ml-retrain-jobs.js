// ml-retrain-jobs.js -- Phase 07 MLAI-08 REVIEWS H12: in-memory job registry.
//
// POST /api/ml/retrain returns 202 Accepted + {jobId, statusUrl} immediately;
// the actual retrain runs in the background via startJob(runFn). GET
// /api/ml/retrain/status/:jobId reads state out of the in-memory Map.
//
// Stateless across process restart — acceptable because retrain is a one-shot
// admin operation, not a persistent queue. Survivability comes from the fact
// that the model files themselves are on disk; if the process restarts
// mid-retrain, the partially-written candidate directory is still valid and
// the next manual trigger will re-run.
//
// Factory: createRetrainJobs(ctx) -> { startJob, getStatus, list }

import { randomUUID } from 'node:crypto';

/**
 * @typedef {'pending' | 'running' | 'done' | 'failed'} JobStatus
 * @typedef {{ status: JobStatus, startedAt: string, completedAt?: string,
 *              result?: any, error?: string | null }} JobState
 */

/**
 * Create a retrain job registry scoped to the current process lifetime.
 *
 * @param {{ pushLog?: Function }} ctx - DI context (only pushLog used).
 * @returns {{ startJob: (runFn: () => Promise<any>) => string,
 *             getStatus: (jobId: string) => JobState | null,
 *             list: () => Array<{jobId: string} & JobState> }}
 */
export function createRetrainJobs(ctx = {}) {
  const { pushLog } = ctx;
  /** @type {Map<string, JobState>} */
  const jobs = new Map();

  /**
   * Start a retrain job asynchronously.
   *
   * @param {() => Promise<any>} runFn - the actual retrain logic (usually
   *   () => mlService.runRetrainEndpoint())
   * @returns {string} jobId (UUID) — caller returns this in a 202 Accepted body
   */
  function startJob(runFn) {
    const jobId = randomUUID();
    /** @type {JobState} */
    const job = {
      status: 'pending',
      startedAt: new Date().toISOString(),
      result: null,
      error: null,
    };
    jobs.set(jobId, job);

    // Kick off async — fire and forget. Deliberately NOT awaited so the
    // route handler can 202 immediately.
    Promise.resolve().then(async () => {
      job.status = 'running';
      try {
        const result = await runFn();
        job.status = 'done';
        job.result = result;
        job.completedAt = new Date().toISOString();
        pushLog?.('ml_retrain_job_done', { jobId, result });
      } catch (err) {
        job.status = 'failed';
        job.error = err?.message || String(err);
        job.completedAt = new Date().toISOString();
        pushLog?.('ml_retrain_job_failed', { jobId, error: job.error });
      }
    });

    pushLog?.('ml_retrain_job_started', { jobId });
    return jobId;
  }

  /**
   * @param {string} jobId
   * @returns {JobState | null}
   */
  function getStatus(jobId) {
    return jobs.get(jobId) || null;
  }

  /** @returns {Array<{jobId: string} & JobState>} */
  function list() {
    return [...jobs.entries()].map(([jobId, state]) => ({ jobId, ...state }));
  }

  return { startJob, getStatus, list };
}
