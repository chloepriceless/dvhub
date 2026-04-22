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

  // Plan 08-04 Task 2 Step 1: concurrency mutex. On a Pi with one CPU and a
  // ~500 MB OOM guard for Python ML, two overlapping retrains would fork-bomb
  // the device. We keep the flag module-local (closure scope) so every call
  // goes through the same gate regardless of which ctx variant invokes it.
  let retrainInProgress = false;
  let retrainStartedAt = 0;
  let retrainCurrentJobId = null;

  /**
   * Start a retrain job asynchronously.
   *
   * Returns `null` when a retrain is already in progress — callers translate
   * that into a 409 for the HTTP layer. The flag is cleared in `finally` so
   * a thrown retrain never wedges the mutex permanently.
   *
   * @param {() => Promise<any>} runFn - the actual retrain logic (usually
   *   () => mlService.runRetrainEndpoint())
   * @returns {string | null} jobId (UUID) — caller returns this in a 202
   *   Accepted body, or null when retrain is already in progress.
   */
  function startJob(runFn) {
    if (retrainInProgress) {
      pushLog?.('ml_retrain_rejected_in_progress', {
        currentJobId: retrainCurrentJobId,
        elapsedMs: Date.now() - retrainStartedAt,
      });
      return null;
    }

    const jobId = randomUUID();
    /** @type {JobState} */
    const job = {
      status: 'pending',
      startedAt: new Date().toISOString(),
      result: null,
      error: null,
    };
    jobs.set(jobId, job);
    retrainInProgress = true;
    retrainStartedAt = Date.now();
    retrainCurrentJobId = jobId;

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
      } finally {
        retrainInProgress = false;
        retrainCurrentJobId = null;
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

  /**
   * Plan 08-04 Task 2: expose mutex state so the /api/ml/retrain handler can
   * fail fast with 409 before spawning anything. Returned shape is stable —
   * consumers can rely on `inProgress` being a boolean for the foreseeable
   * life of the factory.
   *
   * @returns {{ inProgress: boolean, jobId: string | null, elapsedMs: number }}
   */
  function isRetrainInProgress() {
    return {
      inProgress: retrainInProgress,
      jobId: retrainCurrentJobId,
      elapsedMs: retrainInProgress ? Date.now() - retrainStartedAt : 0,
    };
  }

  return { startJob, getStatus, list, isRetrainInProgress };
}
