/**
 * Catalyst runs one project import per org at a time: a POST refused with
 * 403 "Project Import already running" waits and re-posts, bounded.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runProjectImport, type ImportFetch } from '../src/iac-import.js';

const BUSY = { status: 'failure', data: { message: 'You cannot perform this operation. Project Import already running', error_code: 'INVALID_OPERATION' } };

function harness(busyAnswers: number) {
  const posts: string[] = [];
  const sleeps: number[] = [];
  const lines: string[] = [];
  let busy = busyAnswers;
  const reply = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const fetch: ImportFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    if (method === 'POST') {
      posts.push(path);
      if (busy-- > 0) return reply(403, BUSY);
      return reply(200, { status: 'success', data: { id: 'imp-1', status: 'Staged', project_details: { project_name: 'c2c-widget', id: '10000000000013200' } } });
    }
    if (/\/deploy$/.test(path)) return reply(200, { status: 'success' });
    return reply(200, { status: 'success', data: { id: 'imp-1', status: 'Completed', project_details: { project_name: 'c2c-widget', id: '10000000000013200' } } });
  };
  const run = (extra: { busyRetries?: number } = {}) =>
    runProjectImport({
      baseUrl: 'https://api.catalyst.zoho.in',
      org: '10000000000',
      token: 'test-token',
      name: 'c2c-widget',
      bundle: Buffer.from('bundle'),
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onStatus: (line) => lines.push(line),
      ...extra,
    });
  return { run, posts, sleeps, lines };
}

test('import: a busy-org refusal waits ~60 s and re-posts the same name', async () => {
  const h = harness(2);
  const result = await h.run();
  assert.equal(result.projectId, '10000000000013200');
  assert.equal(h.posts.length, 3);
  assert.deepEqual(h.sleeps.slice(0, 2), [60_000, 60_000]);
  assert.ok(h.lines.some((line) => /another project import is already running in org 10000000000/.test(line)));
});

test('import: a busy org that never clears is a bounded, explained refusal', async () => {
  const h = harness(99);
  await assert.rejects(h.run({ busyRetries: 2 }), /still refused after 2 waits.*one at a time/);
  assert.equal(h.posts.length, 3);
});
