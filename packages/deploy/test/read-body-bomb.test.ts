import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { repoRoot } from '../../core/src/toolchain.js';

const require = createRequire(import.meta.url);
const { MAX_BODY_BYTES, readBody } = require(join(repoRoot(), 'packages/deploy/fn/read-body.cjs')) as {
  MAX_BODY_BYTES: number;
  readBody: (req: unknown) => Promise<unknown>;
};

const bodyRequest = (encoding: string, body: Buffer) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-encoding': encoding },
  body,
});

test('a small gzip or deflate bomb is refused at the decoded cap without allocating past it', async () => {
  const zeros = Buffer.alloc(64 * 1024 * 1024);
  for (const [encoding, bomb] of [['gzip', zlib.gzipSync(zeros)], ['deflate', zlib.deflateSync(zeros)]] as const) {
    assert.ok(bomb.length < MAX_BODY_BYTES, `${encoding} bomb is below the encoded cap (${bomb.length} bytes)`);
    const before = process.memoryUsage().rss;
    const started = Date.now();
    await assert.rejects(readBody(bodyRequest(encoding, bomb)), (err: { status?: number }) => err.status === 413);
    assert.ok(Date.now() - started < 2000, `${encoding} bomb refused quickly`);
    assert.ok(process.memoryUsage().rss - before < 32 * 1024 * 1024, `${encoding} bomb did not allocate the full output`);
  }
});

test('a gzip body exactly at the decoded cap is accepted and one byte over is refused', async () => {
  const at = Buffer.from(JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES - 10) }));
  assert.equal(at.length, MAX_BODY_BYTES);
  assert.ok(await readBody(bodyRequest('gzip', zlib.gzipSync(at))));
  const over = Buffer.concat([at, Buffer.from(' ')]);
  await assert.rejects(readBody(bodyRequest('gzip', zlib.gzipSync(over))), (err: { status?: number }) => err.status === 413);
});

test('a declared Content-Length above the cap is refused before the body is read', async () => {
  for (const declared of ['1048577', '9999999999', '99999999999999999999999']) {
    const req = { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': declared }, body: Buffer.from('{}') };
    await assert.rejects(readBody(req), (err: { status?: number }) => err.status === 413, declared);
  }
  const ok = { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '2' }, body: Buffer.from('{}') };
  assert.ok(await readBody(ok));
});

test('repeated, comma-joined and malformed Content-Length headers are refused whatever their order', async () => {
  const mk = (cl: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': cl }, body: Buffer.from('{}') });
  for (const cl of [['1', '9999999999'], ['9999999999', '1'], '1, 9999999999', '9999999999,1', ['2', '3'], '2,3', ['abc'], '1e9', '-1', '', ' ']) {
    await assert.rejects(readBody(mk(cl)), (err: { status?: number }) => err.status === 400 || err.status === 413, JSON.stringify(cl));
  }
  assert.ok(await readBody(mk(['2', '2'])));
  assert.ok(await readBody(mk('2, 2')));
});
