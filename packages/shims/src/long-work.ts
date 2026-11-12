/**
 * Long work off the request path: accept, run as a Job, poll.
 *
 * An Advanced I/O function (and AppSail) is cut at about 30 s and the limit
 * cannot be raised; a Creator action may run longer. Work that would not fit
 * is not started in the request. Instead:
 *
 *   1. the handler records a work status row (`queued`) and submits a Job to
 *      the app's job pool (Catalyst Job Scheduling, `submitJob`);
 *   2. it answers 202 with { work_id, state, poll } and a Location header;
 *   3. the Job runs the work in steps, saving a cursor after each one, and
 *      stops before its own time limit; if work is left it submits itself
 *      again with the same work id, so the next Job resumes from the cursor;
 *   4. GET on the poll path answers the status row: queued, running (with
 *      progress), done (with the result) or failed (with the error).
 *
 * Submitting is idempotent per work id: a retried request that finds a
 * queued, running or done row answers 202 again without a second Job.
 * Small work (at most `inlineMaxRows`, one ZCQL page by default) still runs
 * inline and answers 200; the inline work gets `now + SYNC_BUDGET_MS` as a
 * deadline so an under-estimate stops before the request cut.
 *
 * A submit that throws marks the work failed with the reason instead of
 * leaving it `queued` — a retried request then resubmits, it does not 202 a
 * work id no Job will ever run. The same applies to a slice-end resubmit.
 * And a `queued` row older than `queueLeaseMs` is presumed to have lost its
 * Job (a queue drop, not a failed submit) and is resubmitted on retry; the
 * resubmitted Job resumes from the saved cursor. A Job lost while `running`
 * is not detected — the status row has no heartbeat — and stays a manual
 * action. Two concurrent first-submits can still race the get/put/submit
 * window and submit a second Job for the same work id; steps must be
 * idempotent, which resumable work already is.
 *
 * This module never calls the network: the job queue and the status store
 * are injected by the generated function, and only in live deploy mode.
 */
import { LIMITS } from './runtime.js';

/** The request-path cut (Advanced I/O and AppSail): about 30 s, not raisable. */
export const SYNC_CAP_MS = 30_000;
/** What a request may spend on inline work before it must defer. */
export const SYNC_BUDGET_MS = 20_000;
/** A Job function's own limit is 15 minutes; a slice stops well before it. */
export const JOB_SLICE_MS = 12 * 60_000;
/** A `queued` row this old is presumed to have lost its Job and is resubmitted on retry. */
export const QUEUE_LEASE_MS = 60_000;

export type WorkState = 'queued' | 'running' | 'done' | 'failed';

export interface WorkStatus {
  state: WorkState;
  /** Opaque resume point of the last finished step. */
  cursor?: string;
  progress?: { done: number; total?: number };
  result?: unknown;
  error?: string;
  /** Jobs submitted for this work so far. */
  jobs: number;
  /** When the work was last queued for a Job (ms epoch); a stale queued row is resubmitted. */
  queuedAt?: number;
}

export interface WorkStatusStore {
  get(workId: string): Promise<WorkStatus | undefined>;
  put(workId: string, status: WorkStatus): Promise<void>;
}

export interface JobQueue {
  /** submitJob on the app's job pool. `params` reach the Job function as job params. */
  submit(job: { name: string; params: Record<string, string> }): Promise<{ jobId: string }>;
}

export interface Reply {
  status: 200 | 202 | 404;
  headers?: Record<string, string>;
  body: unknown;
}

export function pollPath(workId: string): string {
  return `/c2c/work/${encodeURIComponent(workId)}`;
}

function accepted(workId: string, status: WorkStatus): Reply {
  const poll = pollPath(workId);
  return { status: 202, headers: { Location: poll }, body: { work_id: workId, state: status.state, poll } };
}

/**
 * Run small work inline (200), defer the rest to a Job (202). `estimate` is the
 * number of rows the work touches, known before it starts (a COUNT). Inline
 * work is passed a deadline (`now + SYNC_BUDGET_MS`) it must stop by. A
 * `queued` status older than `queueLeaseMs` is resubmitted instead of answered
 * 202 — its Job never ran.
 */
export async function runOrDefer(opts: {
  workId: string;
  estimate: number;
  inlineMaxRows?: number;
  runInline: (deadline: number) => Promise<unknown>;
  jobName: string;
  params?: Record<string, string>;
  jobs: JobQueue;
  statuses: WorkStatusStore;
  queueLeaseMs?: number;
  now?: () => number;
}): Promise<Reply> {
  const now = opts.now ?? Date.now;
  const existing = await opts.statuses.get(opts.workId);
  const stale = existing?.state === 'queued' && (existing.queuedAt === undefined || now() - existing.queuedAt > (opts.queueLeaseMs ?? QUEUE_LEASE_MS));
  if (existing && existing.state !== 'failed' && !stale) return accepted(opts.workId, existing);
  if (!existing && opts.estimate <= (opts.inlineMaxRows ?? LIMITS.zcqlRowsPerQuery)) {
    return { status: 200, body: await opts.runInline(now() + SYNC_BUDGET_MS) };
  }
  const status: WorkStatus =
    existing && existing.state === 'queued'
      ? { ...existing, jobs: existing.jobs + 1, queuedAt: now() }
      : { state: 'queued', progress: { done: 0, total: opts.estimate }, jobs: (existing?.jobs ?? 0) + 1, queuedAt: now() };
  // The row is written before the Job exists, so a Job never starts without its status.
  await opts.statuses.put(opts.workId, status);
  try {
    await opts.jobs.submit({ name: opts.jobName, params: { ...opts.params, work_id: opts.workId } });
  } catch (err) {
    // A failed submit must not leave the work queued: mark it failed so the
    // next request resubmits instead of answering 202 for a dead work id.
    status.state = 'failed';
    status.error = `the Job could not be submitted: ${err instanceof Error ? err.message : String(err)}`;
    await opts.statuses.put(opts.workId, status);
    throw err;
  }
  return accepted(opts.workId, status);
}

/** GET on the poll path. */
export async function pollWork(statuses: WorkStatusStore, workId: string): Promise<Reply> {
  const status = await statuses.get(workId);
  if (!status) return { status: 404, body: { work_id: workId, error: 'no such work' } };
  const { cursor: _cursor, ...visible } = status;
  return { status: 200, body: { work_id: workId, ...visible } };
}

export interface WorkStep {
  /** Next cursor; `undefined` means the work is finished. */
  cursor?: string;
  /** Rows finished so far (cumulative). */
  done: number;
  result?: unknown;
}

/**
 * The Job side. Calls `step(cursor, deadline)` until the work finishes or the
 * slice runs out, saving the status after every step. A step must stop by the
 * deadline it is given and return a cursor the next step can resume from.
 * Work left at the end of the slice is handed to a fresh Job.
 */
export async function runWorkSlice(opts: {
  workId: string;
  statuses: WorkStatusStore;
  step: (cursor: string | undefined, deadline: number) => Promise<WorkStep>;
  jobName: string;
  params?: Record<string, string>;
  jobs: JobQueue;
  sliceMs?: number;
  now?: () => number;
  /** Jobs one piece of work may use before it is failed instead of resubmitted. */
  maxJobs?: number;
}): Promise<WorkStatus> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.sliceMs ?? JOB_SLICE_MS);
  const status = await opts.statuses.get(opts.workId);
  if (!status) throw new Error(`work ${opts.workId} has no status row`);
  if (status.state === 'done' || status.state === 'failed') return status;
  status.state = 'running';
  try {
    while (now() < deadline) {
      const step = await opts.step(status.cursor, deadline);
      status.progress = { ...status.progress, done: step.done };
      if (step.cursor === undefined) {
        delete status.cursor;
        status.state = 'done';
        if (step.result !== undefined) status.result = step.result;
        await opts.statuses.put(opts.workId, status);
        return status;
      }
      status.cursor = step.cursor;
      await opts.statuses.put(opts.workId, status);
    }
  } catch (err) {
    status.state = 'failed';
    status.error = err instanceof Error ? err.message : String(err);
    await opts.statuses.put(opts.workId, status);
    return status;
  }
  if (status.jobs >= (opts.maxJobs ?? 50)) {
    status.state = 'failed';
    status.error = `work did not finish in ${status.jobs} job(s)`;
    await opts.statuses.put(opts.workId, status);
    return status;
  }
  status.state = 'queued';
  status.jobs += 1;
  status.queuedAt = now();
  await opts.statuses.put(opts.workId, status);
  try {
    await opts.jobs.submit({ name: opts.jobName, params: { ...opts.params, work_id: opts.workId } });
  } catch (err) {
    status.state = 'failed';
    status.error = `the follow-up Job could not be submitted: ${err instanceof Error ? err.message : String(err)}`;
    await opts.statuses.put(opts.workId, status);
  }
  return status;
}
