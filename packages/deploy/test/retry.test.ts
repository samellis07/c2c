/**
 * Bounded retry on transient Catalyst failures (429/5xx). The recorded
 * failure is the Data Store column create:
 *   500 {"status":"failure","data":{"message":"Internal server error has occurred. Please try again after some time","error_code":"INTERNAL_SERVER_ERROR"}}
 * and the CLI's own transcript shape "HTTP Error: <code>, <message>".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invalidTokenAnswer, invalidTokenOutput, readWithNewerToken, restWithRetry, retryDelayMs, retryableStatus, spawnWithRetry, TOKEN_NOT_RETRIED, TOKEN_RETRY_NOTE, TOKEN_STILL_EXPIRED, transientCatalystOutput, type RetryOptions, type SpawnedResult } from '../src/retry.js';
import type { RestCall, RestFn } from '../src/tables.js';

const COLUMN_500 = {
  status: 'failure',
  data: { message: 'Internal server error has occurred. Please try again after some time', error_code: 'INTERNAL_SERVER_ERROR' },
};

function fakeClock(): { opts: RetryOptions; waits: number[]; lines: string[] } {
  const waits: number[] = [];
  const lines: string[] = [];
  return {
    waits,
    lines,
    opts: {
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0.5,
      log: (line) => lines.push(line),
    },
  };
}

test('429 and every 5xx are retryable; 4xx and success are not', () => {
  assert.equal(retryableStatus(429), true);
  for (const status of [500, 502, 503, 599]) assert.equal(retryableStatus(status), true);
  for (const status of [200, 201, 400, 401, 403, 404, 409, 422]) assert.equal(retryableStatus(status), false);
});

test('a CLI transcript is transient only on a named 429 or 5xx', () => {
  assert.equal(transientCatalystOutput('HTTP Error: 500, Internal server error'), true);
  assert.equal(transientCatalystOutput('HTTP Error: 429, Too many requests'), true);
  assert.equal(transientCatalystOutput(`deploy failed: ${JSON.stringify(COLUMN_500)}`), true);
  assert.equal(transientCatalystOutput('503 try again later'), true);
  // Recorded non-transient CLI failures do not retry.
  assert.equal(transientCatalystOutput('HTTP Error: 404, No such app with the given id exists'), false);
  assert.equal(transientCatalystOutput('HTTP Error: 400 refreshing the access token'), false);
  assert.equal(transientCatalystOutput('An unexpected error has occurred. Kindly contact Catalyst support'), false);
});

test('backoff grows exponentially with jitter and honours Retry-After, capped', () => {
  const noJitter: RetryOptions = { random: () => 0.5 };
  assert.equal(retryDelayMs(1, undefined, noJitter), 400);
  assert.equal(retryDelayMs(2, undefined, noJitter), 800);
  assert.equal(retryDelayMs(3, undefined, noJitter), 1600);
  assert.equal(retryDelayMs(30, undefined, noJitter), 8000);
  // A Retry-After hint longer than the computed backoff wins.
  assert.equal(retryDelayMs(1, 5000, noJitter), 5000);
  // …but a runaway hint is capped rather than stalling the run.
  assert.equal(retryDelayMs(1, 600_000, noJitter), 30_000);
  // Jitter stays inside the slot.
  assert.ok(retryDelayMs(2, undefined, { random: () => 0 }) >= 400);
  assert.ok(retryDelayMs(2, undefined, { random: () => 0.999 }) <= 1600);
});

test('a GET retries a transient 500 then returns the success', async () => {
  const clock = fakeClock();
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    return calls.length < 3 ? { status: 500, body: COLUMN_500 } : { status: 200, body: { data: [] } };
  };
  const out = await restWithRetry(rest, { method: 'GET', path: '/baas/v1/project/1001/table' }, clock.opts);
  assert.equal(out.result.status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(clock.waits, [400, 800]);
  assert.equal(clock.lines.length, 2);
  assert.match(clock.lines[0] ?? '', /retry 1\/3 in 400ms: GET \/baas\/v1\/project\/1001\/table \(HTTP 500\)/);
});

test('Retry-After on the result drives the wait', async () => {
  const clock = fakeClock();
  let n = 0;
  const rest: RestFn = async () => {
    n += 1;
    return n === 1 ? { status: 429, body: {}, retryAfterMs: 9000 } : { status: 200, body: {} };
  };
  const out = await restWithRetry(rest, { method: 'GET', path: '/x' }, clock.opts);
  assert.equal(out.result.status, 200);
  assert.deepEqual(clock.waits, [9000]);
});

test('the write retry backs off, then re-reads: the effect already landed → applied, no re-send', async () => {
  const clock = fakeClock();
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    if (call.method === 'POST' && calls.filter((c) => c.method === 'POST').length === 1) return { status: 500, body: COLUMN_500 };
    return { status: 200, body: { data: { table_id: 't9' } } };
  };
  const out = await restWithRetry<string>(rest, { method: 'POST', path: '/baas/v1/project/1001/table', body: { table_name: 'Item' } }, {
    ...clock.opts,
    reRead: async () => ({ applied: 't9' }),
  });
  assert.equal(out.applied, 't9');
  // The POST went out once; the post-backoff re-read stopped the retry before it sent again.
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.deepEqual(clock.waits, [400]);
});

test('a failed re-read aborts the write retry with the original failure', async () => {
  const clock = fakeClock();
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    return { status: 500, body: COLUMN_500 };
  };
  const out = await restWithRetry(rest, { method: 'POST', path: '/baas/v1/project/1001/table' }, {
    ...clock.opts,
    reRead: async () => ({ abort: true as const }),
  });
  // The POST is never re-sent: the re-read could not prove the write absent.
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(out.result.status, 500);
  assert.deepEqual(out.result.body, COLUMN_500);
  assert.deepEqual(clock.waits, [400]);
});

test('a write whose re-read stays undecided is never re-sent blind', async () => {
  const clock = fakeClock();
  const calls: RestCall[] = [];
  let reads = 0;
  const rest: RestFn = async (call) => {
    calls.push(call);
    return { status: 500, body: COLUMN_500 };
  };
  const out = await restWithRetry(rest, { method: 'POST', path: '/baas/v1/project/1001/table' }, {
    ...clock.opts,
    reRead: async () => {
      reads += 1;
      return undefined;
    },
  });
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(reads, 3);
  assert.equal(out.result.status, 500);
  assert.deepEqual(clock.waits, [400, 800, 1600]);
});

test('the write retry can be narrowed by the re-read', async () => {
  const clock = fakeClock();
  const posts: unknown[] = [];
  let postCount = 0;
  const rest: RestFn = async (call) => {
    if (call.method !== 'POST') return { status: 200, body: {} };
    postCount += 1;
    posts.push(call.body);
    return postCount === 1 ? { status: 500, body: COLUMN_500 } : { status: 200, body: {} };
  };
  const out = await restWithRetry(rest, { method: 'POST', path: '/baas/v1/project/1001/table/t1/column', body: [{ column_name: 'a' }, { column_name: 'b' }] }, {
    ...clock.opts,
    reRead: async () => ({ resend: { method: 'POST', path: '/baas/v1/project/1001/table/t1/column', body: [{ column_name: 'b' }] } }),
  });
  assert.equal(out.result.status, 200);
  assert.equal(postCount, 2);
  assert.deepEqual(posts[1], [{ column_name: 'b' }]);
});

test('after the bounded tries the original failure is the result', async () => {
  const clock = fakeClock();
  let calls = 0;
  const rest: RestFn = async () => {
    calls += 1;
    return { status: 500, body: COLUMN_500 };
  };
  const out = await restWithRetry(rest, { method: 'POST', path: '/baas/v1/project/1001/table' }, clock.opts);
  assert.equal(calls, 4);
  assert.equal(out.result.status, 500);
  assert.deepEqual(out.result.body, COLUMN_500);
  assert.equal(clock.lines.length, 3);
});

test('a 400 is never retried', async () => {
  const clock = fakeClock();
  let calls = 0;
  const rest: RestFn = async () => {
    calls += 1;
    return { status: 400, body: {} };
  };
  await restWithRetry(rest, { method: 'GET', path: '/x' }, clock.opts);
  assert.equal(calls, 1);
});

test('a CLI command retries only on transient output and stops on success', async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await spawnWithRetry(
    async () => {
      calls += 1;
      return calls === 1 ? { code: 2, stdout: '', stderr: 'HTTP Error: 503, Service Unavailable' } : { code: 0, stdout: 'ok', stderr: '' };
    },
    'catalyst deploy --only functions:c2c_api -ni',
    clock.opts,
  );
  assert.equal(result.code, 0);
  assert.equal(calls, 2);
  assert.equal(clock.lines.length, 1);
  assert.match(clock.lines[0] ?? '', /retry 1\/3 in \d+ms: catalyst deploy --only functions:c2c_api -ni \(exit 2\)/);
});

test('beforeRetry can end the retry with its own result — done or the recorded failure', async () => {
  const clock = fakeClock();
  let calls = 0;
  const skipped = await spawnWithRetry(
    async (): Promise<SpawnedResult> => {
      calls += 1;
      return { code: 2, stdout: '', stderr: 'HTTP Error: 500, Internal server error' };
    },
    'catalyst slate:link',
    {
      ...clock.opts,
      beforeRetry: async () => ({ code: 0, stdout: '', stderr: '', skipped: true }),
    },
  );
  assert.equal(skipped.code, 0);
  assert.equal(skipped.skipped, true);
  // The re-read after the backoff ended the step — the command never ran again.
  assert.equal(calls, 1);
  let n = 0;
  const failed = { code: 2, stdout: '', stderr: 'HTTP Error: 500, Internal server error' };
  const out = await spawnWithRetry(
    async () => {
      n += 1;
      return failed;
    },
    'x',
    { ...clock.opts, beforeRetry: async (failure) => failure },
  );
  assert.equal(out, failed);
  assert.equal(n, 1);
});

test('a non-transient CLI failure is not retried; a persistent transient gives up bounded', async () => {
  const clock = fakeClock();
  let calls = 0;
  const fail = await spawnWithRetry(async () => {
    calls += 1;
    return { code: 1, stdout: 'HTTP Error: 404, No such app', stderr: '' };
  }, 'x', clock.opts);
  assert.equal(fail.code, 1);
  assert.equal(calls, 1);
  let n = 0;
  const gave = await spawnWithRetry(async () => {
    n += 1;
    return { code: 2, stdout: '', stderr: 'HTTP Error: 500' };
  }, 'x', clock.opts);
  assert.equal(n, 4);
  assert.equal(gave.code, 2);
});

test('only a 401 whose error_code is INVALID_TOKEN is the token-expiry edge', () => {
  assert.equal(invalidTokenAnswer(401, { error_code: 'INVALID_TOKEN', message: 'invalid oauth token' }), true);
  assert.equal(invalidTokenAnswer(401, { status: 'failure', data: { error_code: 'INVALID_TOKEN', message: 'invalid oauth token' } }), true);
  assert.equal(invalidTokenAnswer(401, { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'invalid oauth scope to access this URL' }), false);
  assert.equal(invalidTokenAnswer(401, { error_code: 'AUTHENTICATION_FAILURE' }), false);
  assert.equal(invalidTokenAnswer(403, { error_code: 'INVALID_TOKEN' }), false);
  assert.equal(invalidTokenOutput('HTTP Error: 401, {"error_code":"INVALID_TOKEN","message":"invalid oauth token"}'), true);
  assert.equal(invalidTokenOutput('HTTP Error: 401, invalid oauth scope to access this URL'), false);
  // INVALID_TOKEN without a 401 is not the expiry edge.
  assert.equal(invalidTokenOutput('{"error_code":"INVALID_TOKEN","message":"invalid oauth token"}'), false);
  assert.equal(invalidTokenOutput('HTTP Error: 500, invalid oauth token'), false);
});

test('readWithNewerToken: one retry for a read only when a newer token is at hand, none for a write', async () => {
  const run = async (readOnly: boolean, answers: number[], newer: boolean | 'throws' = true) => {
    const seen: number[] = [];
    const events: string[] = [];
    let renewals = 0;
    const result = await readWithNewerToken({
      readOnly,
      attempt: async () => {
        const status = answers[Math.min(seen.length, answers.length - 1)]!;
        seen.push(status);
        events.push(`attempt ${status}`);
        return status;
      },
      expired: (status) => status === 401,
      renew: async () => {
        renewals++;
        if (newer === 'throws') throw new Error('catalyst token was empty');
        return newer;
      },
      describe: 'GET /x',
      log: (line) => events.push(line),
    });
    return { result, calls: seen.length, renewals, events };
  };
  // The note is logged before the second attempt runs.
  assert.deepEqual(await run(true, [401, 200]), {
    result: 200,
    calls: 2,
    renewals: 1,
    events: ['attempt 401', `GET /x: 401 INVALID_TOKEN, ${TOKEN_RETRY_NOTE}`, 'attempt 200'],
  });
  assert.deepEqual(await run(false, [401, 200]), { result: 401, calls: 1, renewals: 0, events: ['attempt 401'] });
  // Nothing newer (or the re-read failed): the first answer stands.
  for (const newer of [false, 'throws'] as const) {
    assert.deepEqual(await run(true, [401, 200], newer), {
      result: 401,
      calls: 1,
      renewals: 1,
      events: ['attempt 401', `GET /x: 401 INVALID_TOKEN, ${TOKEN_NOT_RETRIED}`],
    });
  }
  // A second 401 is a failure with its own line, which carries INVALID_TOKEN.
  const twice = await run(true, [401, 401, 200]);
  assert.equal(twice.result, 401);
  assert.equal(twice.calls, 2);
  assert.equal(twice.renewals, 1);
  assert.equal(twice.events.at(-1), `GET /x: ${TOKEN_STILL_EXPIRED}`);
});
