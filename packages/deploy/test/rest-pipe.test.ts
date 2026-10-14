/**
 * The Catalyst access token and REST results travel over an inherited pipe
 * (fd 3) into memory — never the filesystem. A SIGKILL between write and
 * cleanup must not leave a live token on disk, so there is no token file
 * at all. These tests run the real spawn path against a fake catalyst
 * install (bin + lib), with a `-r` spy in the child recording every
 * filesystem write.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { catalystRestCall, listCatalystProjects, readCliAccessToken } from '../src/rest.js';

const ORG = '10000000000';
const PROJECT = '10000000000315013';
const TOKEN = 'c2c-fake-token-7d3a9f2e';
const MARKER = 'c2c-rest-marker-4b1e88aa';

/** Child-side spy: records every fs write; the log itself is never recorded. */
const SPY = `'use strict';
const fs = require('fs');
const log = process.env.C2C_SPY_LOG;
const origAppend = fs.appendFileSync;
const origWriteFile = fs.writeFileSync;
const origWrite = fs.writeSync;
let busy = false;
function record(kind, target, data) {
  if (busy || !log) return;
  let text = '';
  try {
    text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  } catch { text = '<unstringifiable>'; }
  busy = true;
  try { origAppend(log, JSON.stringify({ kind, target: String(target), data: text }) + '\\n'); } catch {}
  finally { busy = false; }
}
fs.writeFileSync = function (target, data, ...rest) {
  if (target !== log) record('writeFileSync', typeof target === 'string' ? target : '[fd]', data);
  return origWriteFile.call(this, target, data, ...rest);
};
fs.appendFileSync = function (target, data, ...rest) {
  if (target !== log) record('appendFileSync', typeof target === 'string' ? target : '[fd]', data);
  return origAppend.call(this, target, data, ...rest);
};
fs.writeSync = function (fd, data, ...rest) {
  record('writeSync', typeof fd === 'number' ? 'fd:' + fd : String(fd), typeof data === 'string' ? data : '[buffer]');
  return origWrite.call(this, fd, data, ...rest);
};
`;

const FAKE_API = `'use strict';
const fs = require('fs');
const STATUS = Number(process.env.C2C_FAKE_STATUS || '201');
const BODY = JSON.parse(process.env.C2C_FAKE_BODY || '{}');
// C2C_FAKE_SEQ: one [status, body] answer per call, across processes (the last repeats).
// Parsed at load: the hook records JSON.parse text while a call runs.
const SEQ = process.env.C2C_FAKE_SEQ ? JSON.parse(process.env.C2C_FAKE_SEQ) : null;
function answer(method) {
  if (!SEQ) return { statusCode: STATUS, body: BODY };
  const seq = SEQ;
  const log = process.env.C2C_FAKE_CALLS;
  const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
  fs.appendFileSync(log, method + '\\n');
  const [statusCode, body] = seq[Math.min(n, seq.length - 1)];
  return { statusCode, body };
}
class FakeAPI {
  constructor() {}
  async get() { return answer('GET'); }
  async post() { return answer('POST'); }
}
module.exports = { default: FakeAPI };
`;

// getAccessToken: the token a call carries (a forced refresh is logged).
// init(raw).accessToken: the pure getter on the stored credential.
const FAKE_CREDENTIAL = `'use strict';
const fs = require('fs');
module.exports = { default: {
  getAccessToken: async (forceRefresh) => {
    if (forceRefresh && process.env.C2C_FAKE_REFRESHES) fs.appendFileSync(process.env.C2C_FAKE_REFRESHES, 'refresh\\n');
    return process.env.C2C_FAKE_TOKEN || '';
  },
  init: () => ({ accessToken: process.env.C2C_FAKE_STORED_TOKEN || process.env.C2C_FAKE_TOKEN || null }),
} };
`;

const FAKE_CONFIG_STORE = `'use strict';
module.exports = { default: { get: (key, fallback) => (key === 'in.credential' ? 'stored-credential' : fallback) } };
`;

const FAKE_DC = `'use strict';
module.exports = { getActiveDC: () => 'in' };
`;

interface FakeCatalyst {
  env: NodeJS.ProcessEnv;
  dir: string;
}

/** A fake catalyst install: <root>/bin/catalyst + lib beside it. */
function fakeCatalyst(binSource: string): FakeCatalyst {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-pipe-test-'));
  const binDir = join(dir, 'bin');
  const internal = join(binDir, 'internal');
  const auth = join(binDir, 'authentication');
  mkdirSync(internal, { recursive: true });
  mkdirSync(auth, { recursive: true });
  const bin = join(binDir, 'catalyst');
  writeFileSync(bin, binSource);
  chmodSync(bin, 0o755);
  writeFileSync(join(internal, 'api.js'), FAKE_API);
  writeFileSync(join(auth, 'credential.js'), FAKE_CREDENTIAL);
  mkdirSync(join(binDir, 'util_modules'), { recursive: true });
  writeFileSync(join(binDir, 'util_modules', 'config-store.js'), FAKE_CONFIG_STORE);
  writeFileSync(join(binDir, 'util_modules', 'dc.js'), FAKE_DC);
  const spy = join(dir, 'spy.js');
  writeFileSync(spy, SPY);
  const spyLog = join(dir, 'spy.log');
  writeFileSync(spyLog, '');
  const env: NodeJS.ProcessEnv = {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    C2C_FAKE_TOKEN: TOKEN,
    C2C_FAKE_STATUS: '201',
    C2C_FAKE_BODY: JSON.stringify({ data: { id: PROJECT, note: MARKER } }),
    C2C_SPY_LOG: spyLog,
    NODE_OPTIONS: `-r "${spy}"`,
  };
  return { env, dir };
}

interface SpyRecord {
  kind: string;
  target: string;
  data: string;
}

function spyRecords(dir: string): SpyRecord[] {
  const text = readFileSync(join(dir, 'spy.log'), 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line) as SpyRecord);
}

/** Writes to real file paths (fd pipes excluded). */
function fileWrites(records: SpyRecord[]): SpyRecord[] {
  return records.filter((r) => !r.target.startsWith('fd:') && r.target !== '[fd]');
}

test('readCliAccessToken returns the token without writing it to any file', async () => {
  const fake = fakeCatalyst(`'use strict';\n// Fake catalyst bin: exits; the -r hook does the work.\n`);
  const token = await readCliAccessToken(fake.env, ORG, PROJECT);
  assert.equal(token, TOKEN);
  const records = spyRecords(fake.dir);
  assert.ok(!records.some((r) => r.target.endsWith('out.txt')), 'child must not use an out.txt file channel');
  const leaked = fileWrites(records).filter((r) => r.data.includes(TOKEN));
  assert.ok(leaked.length === 0, `token reached a file: ${leaked.map((r) => r.target).join(', ')}`);
});

test('catalystRestCall returns status and body through the pipe, not a file', async () => {
  const fake = fakeCatalyst(`'use strict';\n`);
  const res = await catalystRestCall(fake.env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` });
  assert.deepEqual(res, { status: 201, body: { data: { id: PROJECT, note: MARKER } } });
  const records = spyRecords(fake.dir);
  assert.ok(!records.some((r) => r.target.endsWith('out.txt')), 'child must not use an out.txt file channel');
  const leaked = fileWrites(records).filter((r) => r.data.includes(MARKER));
  assert.ok(leaked.length === 0, `REST result reached a file: ${leaked.map((r) => r.target).join(', ')}`);
});

test('catalystRestCall lists projects through the pipe under the exact-only guard', async () => {
  const fake = fakeCatalyst(`'use strict';\n`);
  fake.env.C2C_FAKE_BODY = JSON.stringify({ data: [{ project_name: 'c2c-widget', id: '1001' }] });
  const projects = await listCatalystProjects(fake.env, '1001');
  assert.deepEqual(projects, [{ name: 'c2c-widget', id: '1001' }]);
});

test('a child that exits without writing keeps the same errors as today', async () => {
  const fake = fakeCatalyst(`'use strict';\nprocess.kill(process.pid, 'SIGKILL');\n`);
  delete fake.env.NODE_OPTIONS;
  delete fake.env.C2C_SPY_LOG;
  await assert.rejects(readCliAccessToken(fake.env, ORG, PROJECT), /catalyst token was empty/);
  await assert.rejects(
    catalystRestCall(fake.env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }),
    /catalyst rest refused the path/,
  );
});

/** The recorded expiry-edge answer: the hourly access token lapsed as the call landed. */
const INVALID_TOKEN = [401, { error_code: 'INVALID_TOKEN', message: 'invalid oauth token' }];
const OK = [200, { data: { id: PROJECT } }];

/** C2C_FAKE_SEQ answers; the credential store holds a newer token than the calls carry unless `stored` says otherwise. */
function sequenced(seq: unknown[], stored = 'c2c-fake-token-newer'): { fake: FakeCatalyst; calls: () => string[]; refreshes: () => number; lines: string[]; log: (line: string) => void } {
  const fake = fakeCatalyst(`'use strict';\n`);
  const callsLog = join(fake.dir, 'calls.log');
  const refreshLog = join(fake.dir, 'refreshes.log');
  writeFileSync(callsLog, '');
  writeFileSync(refreshLog, '');
  fake.env.C2C_FAKE_SEQ = JSON.stringify(seq);
  fake.env.C2C_FAKE_CALLS = callsLog;
  fake.env.C2C_FAKE_REFRESHES = refreshLog;
  fake.env.C2C_FAKE_STORED_TOKEN = stored;
  delete fake.env.NODE_OPTIONS;
  const lines: string[] = [];
  const read = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
  return { fake, calls: () => read(callsLog), refreshes: () => read(refreshLog).length, lines, log: (line) => lines.push(line) };
}

test('a GET that meets 401 INVALID_TOKEN re-reads the store and retries once with the newer token, with no refresh', async () => {
  const s = sequenced([INVALID_TOKEN, OK]);
  const res = await catalystRestCall(s.fake.env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }, { log: s.log });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, OK[1]);
  assert.deepEqual(s.calls(), ['GET', 'GET']);
  assert.equal(s.refreshes(), 0);
  assert.equal(s.lines.length, 1);
  assert.match(s.lines[0]!, /retried once with a newer token/);
  assert.ok(!s.lines[0]!.includes(TOKEN) && !s.lines[0]!.includes('c2c-fake-token-newer'), 'no token in the output');
});

test('a GET whose stored token is the one that failed is not retried', async () => {
  const s = sequenced([INVALID_TOKEN, OK], TOKEN);
  const res = await catalystRestCall(s.fake.env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }, { log: s.log });
  assert.equal(res.status, 401);
  assert.deepEqual(s.calls(), ['GET']);
  assert.equal(s.refreshes(), 0);
  assert.deepEqual(s.lines, [`GET /baas/v1/project/${PROJECT}: 401 INVALID_TOKEN, not retried: no newer token in the CLI credential store`]);
});

test('with C2C_ALLOW_LOCAL_REFRESH=1 a GET that meets 401 INVALID_TOKEN forces one refresh and retries once', async () => {
  const s = sequenced([INVALID_TOKEN, OK], TOKEN);
  s.fake.env.C2C_ALLOW_LOCAL_REFRESH = '1';
  const res = await catalystRestCall(s.fake.env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }, { log: s.log });
  assert.equal(res.status, 200);
  assert.deepEqual(s.calls(), ['GET', 'GET']);
  assert.equal(s.refreshes(), 1);
});

test('the project list (a read) gets the same one re-read and one retry', async () => {
  const s = sequenced([INVALID_TOKEN, [200, { data: [{ project_name: 'c2c-widget', id: '1001' }] }]]);
  const projects = await listCatalystProjects(s.fake.env, '1001', { log: s.log });
  assert.deepEqual(projects, [{ name: 'c2c-widget', id: '1001' }]);
  assert.equal(s.refreshes(), 0);
  assert.deepEqual(s.calls(), ['GET', 'GET']);
});

test('a POST that meets 401 INVALID_TOKEN is never retried and never renews', async () => {
  const s = sequenced([INVALID_TOKEN, OK]);
  const res = await catalystRestCall(s.fake.env, ORG, PROJECT, { method: 'POST', path: `/baas/v1/project/${PROJECT}/table`, body: {} }, { log: s.log });
  assert.equal(res.status, 401);
  assert.deepEqual(s.calls(), ['POST']);
  assert.equal(s.refreshes(), 0);
  assert.deepEqual(s.lines, []);
});

test('a second 401 INVALID_TOKEN after the retry is a real failure', async () => {
  const s = sequenced([INVALID_TOKEN, INVALID_TOKEN, OK]);
  const res = await catalystRestCall(s.fake.env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }, { log: s.log });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, INVALID_TOKEN[1]);
  assert.deepEqual(s.calls(), ['GET', 'GET']);
  assert.equal(s.refreshes(), 0);
  assert.match(s.lines.at(-1)!, /still 401 INVALID_TOKEN after one retry/);
});

test('a 401 with any other error code is not retried', async () => {
  for (const body of [
    { error_code: 'OAUTH_SCOPE_MISMATCH', message: 'invalid oauth scope to access this URL' },
    { error_code: 'AUTHENTICATION_FAILURE', message: 'Authentication failed' },
    { error: 'sign in required' },
  ]) {
    const s = sequenced([[401, body], OK]);
    const res = await catalystRestCall(s.fake.env, ORG, PROJECT, { method: 'GET', path: `/baas/v1/project/${PROJECT}` }, { log: s.log });
    assert.equal(res.status, 401);
    assert.deepEqual(s.calls(), ['GET']);
    assert.equal(s.refreshes(), 0);
  }
});
