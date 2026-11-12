import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollWork, QUEUE_LEASE_MS, runOrDefer, runWorkSlice, SYNC_BUDGET_MS, SYNC_CAP_MS, type WorkStatus, type WorkStatusStore } from '../src/long-work.js';

function memoryStatuses(): WorkStatusStore & { rows: Map<string, WorkStatus> } {
  const rows = new Map<string, WorkStatus>();
  return {
    rows,
    get: async (id) => (rows.has(id) ? (JSON.parse(JSON.stringify(rows.get(id))) as WorkStatus) : undefined),
    put: async (id, status) => {
      rows.set(id, JSON.parse(JSON.stringify(status)) as WorkStatus);
    },
  };
}

function queue() {
  const submitted: { name: string; params: Record<string, string> }[] = [];
  return { submitted, submit: async (job: { name: string; params: Record<string, string> }) => (submitted.push(job), { jobId: String(submitted.length) }) };
}

test('the inline budget sits below the request cut', () => {
  assert.ok(SYNC_BUDGET_MS < SYNC_CAP_MS);
});

test('small work runs inline and answers 200; nothing is queued; inline work gets the sync budget as its deadline', async () => {
  const jobs = queue();
  const statuses = memoryStatuses();
  let clock = 1000;
  let seen = 0;
  const reply = await runOrDefer({
    workId: 'w1',
    estimate: 120,
    runInline: async (deadline) => {
      seen = deadline;
      return { updated: 120 };
    },
    jobName: 'c2c_jobs',
    jobs,
    statuses,
    now: () => clock,
  });
  assert.deepEqual(reply, { status: 200, body: { updated: 120 } });
  assert.equal(seen, clock + SYNC_BUDGET_MS, 'the inline deadline is now + SYNC_BUDGET_MS');
  assert.equal(jobs.submitted.length, 0);
  assert.equal(statuses.rows.size, 0);
});

test('large work answers 202 with a poll path and one Job; a retried request does not submit again', async () => {
  const jobs = queue();
  const statuses = memoryStatuses();
  let inline = 0;
  const call = () =>
    runOrDefer({
      workId: 'w2',
      estimate: 12_000,
      runInline: async () => (inline += 1),
      jobName: 'c2c_jobs',
      params: { module: 'bulk-update' },
      jobs,
      statuses,
    });
  const first = await call();
  assert.equal(first.status, 202);
  assert.deepEqual(first.headers, { Location: '/c2c/work/w2' });
  assert.deepEqual(first.body, { work_id: 'w2', state: 'queued', poll: '/c2c/work/w2' });
  assert.deepEqual(jobs.submitted, [{ name: 'c2c_jobs', params: { module: 'bulk-update', work_id: 'w2' } }]);
  const again = await call();
  assert.equal(again.status, 202);
  assert.equal(jobs.submitted.length, 1, 'no second Job for the same work id');
  assert.equal(inline, 0);
  const polled = (await pollWork(statuses, 'w2')).body as Record<string, unknown>;
  assert.deepEqual(polled, { work_id: 'w2', state: 'queued', progress: { done: 0, total: 12_000 }, jobs: 1, queuedAt: statuses.rows.get('w2')!.queuedAt });
  assert.equal(typeof polled.queuedAt, 'number');
  assert.equal((await pollWork(statuses, 'nope')).status, 404);
});

test('a Job runs steps to its slice deadline, saves the cursor, resubmits itself, and the next Job finishes', async () => {
  const jobs = queue();
  const statuses = memoryStatuses();
  await runOrDefer({ workId: 'w3', estimate: 10_000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses });
  let clock = 0;
  const step = async (cursor: string | undefined) => {
    clock += 1000; // each step of 1000 rows takes a second
    const done = Number(cursor ?? '0') + 1000;
    return done >= 10_000 ? { done, result: { updated: done } } : { done, cursor: String(done) };
  };
  const slice = () => runWorkSlice({ workId: 'w3', statuses, step, jobName: 'c2c_jobs', jobs, sliceMs: 4000, now: () => clock });
  const first = await slice();
  assert.equal(first.state, 'queued');
  assert.equal(first.cursor, '4000');
  assert.equal(jobs.submitted.length, 2, 'the slice handed the rest to a fresh Job');
  const polled = (await pollWork(statuses, 'w3')).body as Record<string, unknown>;
  assert.deepEqual(polled.progress, { done: 4000, total: 10_000 });
  assert.equal('cursor' in polled, false, 'the poll reply does not expose the cursor');
  let last = first;
  while (last.state !== 'done') last = await slice();
  assert.deepEqual(last.result, { updated: 10_000 });
  assert.equal(jobs.submitted.length, 3);
  assert.equal((await pollWork(statuses, 'w3')).status, 200);
  // A late duplicate Job for finished work does nothing.
  assert.equal((await slice()).state, 'done');
});

test('a failing step marks the work failed; a new request may then start it again', async () => {
  const jobs = queue();
  const statuses = memoryStatuses();
  await runOrDefer({ workId: 'w4', estimate: 5000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses });
  const failed = await runWorkSlice({
    workId: 'w4',
    statuses,
    step: async () => {
      throw new Error('store refused the write');
    },
    jobName: 'c2c_jobs',
    jobs,
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'store refused the write');
  const retry = await runOrDefer({ workId: 'w4', estimate: 5000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses });
  assert.equal(retry.status, 202);
  assert.equal(jobs.submitted.length, 2);
});

test('a submit failure marks the work failed and a retried request resubmits it', async () => {
  const jobs = queue();
  const statuses = memoryStatuses();
  jobs.submit = async () => {
    throw new Error('job pool is full');
  };
  await assert.rejects(
    runOrDefer({ workId: 'w6', estimate: 5000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses }),
    /job pool is full/,
  );
  const stored = statuses.rows.get('w6')!;
  assert.equal(stored.state, 'failed', 'a failed submit does not leave the work queued');
  assert.match(stored.error ?? '', /job pool is full/);
  jobs.submit = async (job: { name: string; params: Record<string, string> }) => (jobs.submitted.push(job), { jobId: 'j2' });
  const retry = await runOrDefer({ workId: 'w6', estimate: 5000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses });
  assert.equal(retry.status, 202);
  assert.equal(jobs.submitted.length, 1, 'the retried request submits a fresh Job');
  assert.equal(statuses.rows.get('w6')!.state, 'queued');
});

test('a queued row past its queue lease is resubmitted on retry, keeping its cursor', async () => {
  const jobs = queue();
  const statuses = memoryStatuses();
  let clock = 1000;
  const now = () => clock;
  await statuses.put('w7', { state: 'queued', cursor: 'page-4', progress: { done: 4000, total: 9000 }, jobs: 1, queuedAt: clock });
  clock += QUEUE_LEASE_MS + 1;
  const reply = await runOrDefer({ workId: 'w7', estimate: 9000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses, now });
  assert.equal(reply.status, 202);
  assert.equal(jobs.submitted.length, 1, 'a stale queued work gets a fresh Job');
  const stored = statuses.rows.get('w7')!;
  assert.equal(stored.state, 'queued');
  assert.equal(stored.cursor, 'page-4', 'the resubmitted Job resumes from the saved cursor');
  assert.equal(stored.jobs, 2);
  assert.equal(stored.queuedAt, clock);
  // Within the lease, a retry only answers 202.
  clock += QUEUE_LEASE_MS - 2;
  const again = await runOrDefer({ workId: 'w7', estimate: 9000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses, now });
  assert.equal(again.status, 202);
  assert.equal(jobs.submitted.length, 1, 'a fresh queued row is not resubmitted');
});

test('a slice-end resubmit that throws marks the work failed instead of queued forever', async () => {
  const jobs = queue();
  const statuses = memoryStatuses();
  await runOrDefer({ workId: 'w8', estimate: 5000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses });
  jobs.submit = async () => {
    throw new Error('queue unavailable');
  };
  let clock = 0;
  const status = await runWorkSlice({
    workId: 'w8',
    statuses,
    step: async () => ((clock += 10), { done: 100, cursor: 'more' }),
    jobName: 'c2c_jobs',
    jobs,
    sliceMs: 20,
    now: () => clock,
  });
  assert.equal(status.state, 'failed');
  assert.match(status.error ?? '', /queue unavailable/);
  const polled = (await pollWork(statuses, 'w8')).body as Record<string, unknown>;
  assert.equal(polled.state, 'failed');
});

test('work that never finishes is failed after maxJobs instead of resubmitting forever', async () => {
  const jobs = queue();
  const statuses = memoryStatuses();
  await runOrDefer({ workId: 'w5', estimate: 5000, runInline: async () => 0, jobName: 'c2c_jobs', jobs, statuses });
  let clock = 0;
  let status: WorkStatus | undefined;
  for (let i = 0; i < 5; i++) {
    status = await runWorkSlice({
      workId: 'w5',
      statuses,
      step: async () => ((clock += 10), { done: 0, cursor: 'same' }),
      jobName: 'c2c_jobs',
      jobs,
      sliceMs: 20,
      now: () => clock,
      maxJobs: 3,
    });
    if (status.state === 'failed') break;
  }
  assert.equal(status?.state, 'failed');
  assert.match(status?.error ?? '', /did not finish in 3 job/);
});
