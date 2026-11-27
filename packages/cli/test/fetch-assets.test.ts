import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ASSET_MAX_BYTES, ASSET_MAX_REDIRECTS } from '../../core/src/remote-assets.js';
import { solidPng } from '../../ui/src/build.js';
import { fetchAsset, fetchAssetsInto, type AssetResponse, type FetchDeps } from '../src/fetch-assets.js';

const PNG = solidPng(2, [1, 2, 3]);

function response(status: number, headers: Record<string, string>, body: Uint8Array | Uint8Array[]): AssetResponse {
  const chunks = Array.isArray(body) ? body : [body];
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
    destroy() {},
  };
}

interface Script {
  addresses?: Record<string, string[]>;
  routes: Record<string, () => AssetResponse>;
  connected: string[];
}

function deps(script: Script): FetchDeps {
  return {
    async resolve(host) {
      const found = script.addresses?.[host] ?? ['93.184.216.34'];
      if (!found.length) throw new Error('no such host');
      return found;
    },
    async get(url, address) {
      script.connected.push(`${url.hostname} ${address}`);
      const route = script.routes[url.href];
      if (!route) throw new Error('no route');
      return route();
    },
  };
}

const OK = { 'content-type': 'image/png' };

test('a plain https png is fetched, hashed and typed by its bytes', async () => {
  const s: Script = { routes: { 'https://img.example.com/a.png': () => response(200, OK, PNG) }, connected: [] };
  const result = await fetchAsset('https://img.example.com/a.png', deps(s));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ext, 'png');
    assert.equal(result.sha256.length, 64);
    assert.ok(result.bytes.equals(PNG));
  }
  assert.deepEqual(s.connected, ['img.example.com 93.184.216.34']);
});

test('http, ip-literal and local hosts are refused before any connection', async () => {
  const s: Script = { routes: {}, connected: [] };
  for (const url of ['http://img.example.com/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://169.254.169.254/latest']) {
    const result = await fetchAsset(url, deps(s));
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.equal(result.status, 'refused', url);
  }
  assert.deepEqual(s.connected, []);
});

test('a host that resolves to a private, link-local or metadata address is refused, even if another address is public', async () => {
  for (const bad of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1']) {
    const s: Script = { addresses: { 'img.example.com': ['93.184.216.34', bad] }, routes: { 'https://img.example.com/a.png': () => response(200, OK, PNG) }, connected: [] };
    const result = await fetchAsset('https://img.example.com/a.png', deps(s));
    assert.equal(result.ok, false, bad);
    assert.deepEqual(s.connected, [], bad);
  }
});

test('a redirect to a private host or a downgrade is refused after the redirect, and the redirect cap holds', async () => {
  const toPrivate: Script = {
    addresses: { 'cdn.example.com': ['10.0.0.9'] },
    routes: { 'https://img.example.com/a.png': () => response(302, { location: 'https://cdn.example.com/a.png' }, new Uint8Array()) },
    connected: [],
  };
  const a = await fetchAsset('https://img.example.com/a.png', deps(toPrivate));
  assert.equal(a.ok, false);
  assert.deepEqual(toPrivate.connected, ['img.example.com 93.184.216.34']);
  const downgrade: Script = { routes: { 'https://img.example.com/a.png': () => response(301, { location: 'http://img.example.com/a.png' }, new Uint8Array()) }, connected: [] };
  const b = await fetchAsset('https://img.example.com/a.png', deps(downgrade));
  assert.equal(b.ok, false);
  if (!b.ok) assert.match(b.reason, /redirect target refused: only https/);
  const loop: Script = { routes: {}, connected: [] };
  for (let n = 0; n <= ASSET_MAX_REDIRECTS + 2; n++) loop.routes[`https://img.example.com/${n}`] = () => response(302, { location: `/${n + 1}` }, new Uint8Array());
  const c = await fetchAsset('https://img.example.com/0', deps(loop));
  assert.equal(c.ok, false);
  if (!c.ok) assert.match(c.reason, /redirects/);
  assert.equal(loop.connected.length, ASSET_MAX_REDIRECTS + 1);
});

test('a redirect within the cap to another public host is followed', async () => {
  const s: Script = {
    routes: {
      'https://img.example.com/a.png': () => response(302, { location: 'https://cdn.example.org/b.png' }, new Uint8Array()),
      'https://cdn.example.org/b.png': () => response(200, OK, PNG),
    },
    connected: [],
  };
  const result = await fetchAsset('https://img.example.com/a.png', deps(s));
  assert.equal(result.ok, true);
});

test('size cap: a declared or streamed body over the cap is refused', async () => {
  const big = new Uint8Array(ASSET_MAX_BYTES + 1);
  big.set(PNG);
  const declared: Script = { routes: { 'https://img.example.com/a.png': () => response(200, { ...OK, 'content-length': String(big.length) }, big) }, connected: [] };
  const a = await fetchAsset('https://img.example.com/a.png', deps(declared));
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.status, 'refused');
  const streamed: Script = { routes: { 'https://img.example.com/a.png': () => response(200, OK, [big.subarray(0, 600_000), big.subarray(600_000)]) }, connected: [] };
  const b = await fetchAsset('https://img.example.com/a.png', deps(streamed));
  assert.equal(b.ok, false);
});

test('content type and bytes must both be on the allowlist: svg, html and non-image bytes are refused', async () => {
  const cases: Array<[string, Record<string, string>, Uint8Array]> = [
    ['svg type', { 'content-type': 'image/svg+xml' }, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['html type', { 'content-type': 'text/html' }, Buffer.from('<html></html>')],
    ['no type', {}, PNG],
    ['png type with html bytes', OK, Buffer.from('<html><script>1</script></html>')],
    ['svg bytes under an image type', OK, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ];
  for (const [label, headers, body] of cases) {
    const s: Script = { routes: { 'https://img.example.com/a.png': () => response(200, headers, body) }, connected: [] };
    const result = await fetchAsset('https://img.example.com/a.png', deps(s));
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.status, 'refused', label);
  }
});

test('an allowed image header over different allowed image bytes is stored under the type the bytes have', async () => {
  const s: Script = { routes: { 'https://img.example.com/a.png': () => response(200, { 'content-type': 'image/jpeg' }, PNG) }, connected: [] };
  const result = await fetchAsset('https://img.example.com/a.png', deps(s));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.ext, 'png');
});

test('a non-200 answer and a request error are failures, not refusals', async () => {
  const s: Script = { routes: { 'https://img.example.com/a.png': () => response(404, {}, new Uint8Array()) }, connected: [] };
  const a = await fetchAsset('https://img.example.com/a.png', deps(s));
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.status, 'failed');
  const b = await fetchAsset('https://img.example.com/none.png', deps(s));
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.status, 'failed');
});

test('the timeout aborts a request that never answers', async () => {
  const hang: FetchDeps = {
    resolve: async () => ['93.184.216.34'],
    get: (_url, _address, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  };
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => originalSetTimeout(fn, 5)) as typeof setTimeout;
  try {
    const result = await fetchAsset('https://img.example.com/a.png', hang);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /timed out/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

const DS = `x { background: url('https://img.example.com/a.png'); } y { background-image: url(&quot;https://img.example.com/b.png?x=1&amp;y=2&quot;); } z { background: url(http://old.example.com/c.png); } w { list-style-image: url('https://img.example.com/skip.png'); } v { background: url('https://img.example.com/<%=x%>.png'); }`;

test('fetchAssetsInto writes the cache and a sorted lock, counts refusals, and a rerun is offline and byte-identical', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fetch-'));
  try {
    const s: Script = {
      routes: {
        'https://img.example.com/a.png': () => response(200, OK, PNG),
        'https://img.example.com/b.png?x=1&y=2': () => response(404, {}, new Uint8Array()),
      },
      connected: [],
    };
    const first = await fetchAssetsInto(dir, [DS], deps(s));
    assert.deepEqual([first.fetched, first.refused, first.failed, first.reused], [1, 1, 1, 0]);
    assert.deepEqual(first.entries.map((entry) => `${entry.status} ${entry.url}`), [
      'fetched https://img.example.com/a.png',
      'failed https://img.example.com/b.png?x=1&y=2',
      'refused http://old.example.com/c.png',
    ].sort((a, b) => (a.split(' ')[1]! < b.split(' ')[1]! ? -1 : 1)));
    assert.equal(s.connected.some((line) => line.split(' ').includes('skip') || line.split(' ')[0] === 'old.example.com'), false);
    const lock = readFileSync(join(dir, 'c2c-assets.lock.json'), 'utf8');
    const files = readdirSync(join(dir, 'c2c-assets'));
    assert.equal(files.length, 1);
    assert.match(files[0] as string, /^[0-9a-f]{64}\.png$/);
    // Rerun: the fetched url is reused with no network call; the failed and refused ones are retried.
    const s2: Script = { routes: { 'https://img.example.com/b.png?x=1&y=2': () => response(404, {}, new Uint8Array()) }, connected: [] };
    const second = await fetchAssetsInto(dir, [DS], deps(s2));
    assert.equal(second.reused, 1);
    assert.equal(s2.connected.some((line) => line.split(' ')[0] === 'img.example.com' && line.split(' ').includes('93.184.216.34')), true);
    assert.equal(readFileSync(join(dir, 'c2c-assets.lock.json'), 'utf8'), lock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the url count is capped and the overflow is counted, not silently dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fetch-'));
  try {
    const text = Array.from({ length: 40 }, (_v, n) => `a { background: url('https://img.example.com/${String(n).padStart(2, '0')}.png'); }`).join('\n');
    writeFileSync(join(dir, 'x.ds'), text);
    const s: Script = { routes: {}, connected: [] };
    const summary = await fetchAssetsInto(dir, [text], deps(s));
    assert.equal(summary.entries.length, 32);
    assert.equal(summary.overCap, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchAssetsInto never writes through a symlinked lock, cache directory or temp file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-fetch-link-'));
  try {
    const script = (): Script => ({ routes: { 'https://img.example.com/a.png': () => response(200, OK, PNG) }, connected: [] });
    // 1. A symlinked lock file would clobber its target.
    const lockDir = join(root, 'a');
    mkdirSync(lockDir);
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(lockDir, 'c2c-assets.lock.json'));
    await assert.rejects(fetchAssetsInto(lockDir, [DS], deps(script())), /symbolic link/);
    assert.equal(readFileSync(victim, 'utf8'), 'keep');
    // 2. A symlinked cache directory would receive the fetched file outside the export.
    const cacheDir = join(root, 'b');
    const outside = join(root, 'outside');
    mkdirSync(cacheDir);
    mkdirSync(outside);
    symlinkSync(outside, join(cacheDir, 'c2c-assets'));
    await assert.rejects(fetchAssetsInto(cacheDir, [DS], deps(script())), /symbolic link/);
    assert.deepEqual(readdirSync(outside), []);
    // 3. A symlink planted at the temp name is replaced, never followed.
    const tmpDir = join(root, 'c');
    mkdirSync(join(tmpDir, 'c2c-assets'), { recursive: true });
    const first = await fetchAssetsInto(tmpDir, [DS], deps(script()));
    const file = readdirSync(join(tmpDir, 'c2c-assets'))[0] as string;
    rmSync(join(tmpDir, 'c2c-assets', file));
    rmSync(join(tmpDir, 'c2c-assets.lock.json'));
    const victim2 = join(root, 'victim2.txt');
    writeFileSync(victim2, 'keep2');
    symlinkSync(victim2, join(tmpDir, 'c2c-assets', `${file}.tmp`));
    await fetchAssetsInto(tmpDir, [DS], deps(script()));
    assert.equal(first.fetched, 1);
    assert.equal(readFileSync(victim2, 'utf8'), 'keep2');
    assert.ok(existsSync(join(tmpDir, 'c2c-assets', file)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
