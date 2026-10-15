/**
 * GitHub install: a checkout holds only tracked files, so plugin/vendor (built,
 * gitignored) is absent. The repo root must be a valid marketplace, and
 * bin/c2c must fetch the pinned runtime archive instead of exiting 6.
 * No network: the archive is built here and handed over as a local file;
 * the "offline" case points the download at a closed loopback port.
 * npm test builds first, so dist/ exists before these run.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { packRuntime, runtimeLockText } from '../../scripts/vendor-plugin.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const node = process.execPath;
const script = path.join(repo, 'scripts/vendor-plugin.mjs');
const PINNED_NODE = '20.20.1';
const CLOSED_PORT_URL = 'http://127.0.0.1:9/c2c-runtime.tgz';
const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

let temp;
let clone;
let archiveFile;
let lock;

/** Copy what `git clone` would check out: tracked files plus new unignored ones, never gitignored output. */
function checkout(dest) {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    const from = path.join(repo, rel);
    if (!existsSync(from)) continue;
    mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    copyFileSync(from, path.join(dest, rel));
  }
}

/** Only PATH (this Node first, no Catalyst CLI), a fresh HOME and the given extras. */
function cleanEnv(extra = {}) {
  const home = path.join(temp, 'home');
  return {
    PATH: [path.dirname(node), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: tmpdir(),
    C2C_QUIET_NODE_WARN: '1',
    ...extra,
  };
}

function claude(args, cwd) {
  const env = { ...cleanEnv(), PATH: process.env.PATH ?? '' };
  return spawnSync('claude', args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
}

function c2c(pluginDir, args, extra) {
  const workspace = mkdtempSync(path.join(temp, 'ws-'));
  const res = spawnSync(path.join(pluginDir, 'bin/c2c'), args, {
    cwd: workspace,
    env: cleanEnv({ C2C_WORKSPACE: workspace, ...extra }),
    encoding: 'utf8',
  });
  return res;
}

/** Async c2c for tests that serve answers from this process (spawnSync would deadlock). */
function c2cAsync(pluginDir, args, extra) {
  const workspace = mkdtempSync(path.join(temp, 'ws-'));
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(pluginDir, 'bin/c2c'), args, {
      cwd: workspace,
      env: cleanEnv({ C2C_WORKSPACE: workspace, ...extra }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

before(() => {
  temp = mkdtempSync(path.join(tmpdir(), 'c2c-gh-install-'));
  clone = path.join(temp, 'repo');
  checkout(clone);
  // The release step: build the runtime archive and pin it in the checkout.
  const packed = packRuntime({ root: repo });
  lock = packed.lock;
  archiveFile = path.join(temp, 'release', lock.asset);
  mkdirSync(path.dirname(archiveFile), { recursive: true });
  writeFileSync(archiveFile, packed.archive);
  writeFileSync(path.join(clone, 'plugin/runtime/runtime.json'), runtimeLockText(lock));
});

after(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});

test('a checkout has no vendor tree and keeps the marketplace at the repo root', () => {
  assert.equal(existsSync(path.join(clone, 'plugin/vendor')), false);
  assert.equal(existsSync(path.join(clone, '.claude-plugin/marketplace.json')), true);
  assert.equal(existsSync(path.join(clone, 'plugin/.claude-plugin/marketplace.json')), false);
  const market = JSON.parse(readFileSync(path.join(clone, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.deepEqual(market.plugins.map((entry) => [entry.name, entry.source]), [['c2c', './plugin']]);
  const schema = spawnSync(node, [script, '--schema', '--root', clone], { encoding: 'utf8' });
  assert.equal(schema.status, 0, schema.stderr || schema.stdout);
});

test('the schema stand-in rejects a marketplace kept only inside plugin/', () => {
  const bad = mkdtempSync(path.join(temp, 'bad-'));
  mkdirSync(path.join(bad, 'plugin/.claude-plugin'), { recursive: true });
  copyFileSync(path.join(clone, 'plugin/.claude-plugin/plugin.json'), path.join(bad, 'plugin/.claude-plugin/plugin.json'));
  copyFileSync(path.join(clone, '.claude-plugin/marketplace.json'), path.join(bad, 'plugin/.claude-plugin/marketplace.json'));
  const res = spawnSync(node, [script, '--schema', '--root', bad], { encoding: 'utf8' });
  assert.notEqual(res.status, 0, res.stdout);
  assert.match(res.stderr, /marketplace\.json unreadable/);
});

test('the schema stand-in rejects a source that does not reach the plugin', () => {
  const bad = mkdtempSync(path.join(temp, 'bad-src-'));
  mkdirSync(path.join(bad, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(bad, 'plugin/.claude-plugin'), { recursive: true });
  copyFileSync(path.join(clone, 'plugin/.claude-plugin/plugin.json'), path.join(bad, 'plugin/.claude-plugin/plugin.json'));
  const market = JSON.parse(readFileSync(path.join(clone, '.claude-plugin/marketplace.json'), 'utf8'));
  for (const source of ['./', '../plugin']) {
    market.plugins[0].source = source;
    writeFileSync(path.join(bad, '.claude-plugin/marketplace.json'), JSON.stringify(market));
    const res = spawnSync(node, [script, '--schema', '--root', bad], { encoding: 'utf8' });
    assert.notEqual(res.status, 0, `${source} accepted`);
    assert.match(res.stderr, /plugins\[0\]\.source/);
  }
});

test('claude plugin marketplace add and install work from the checkout path', (t) => {
  if (!hasClaude) {
    t.skip('claude is not on PATH');
    return;
  }
  const added = claude(['plugin', 'marketplace', 'add', clone], temp);
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const installed = claude(['plugin', 'install', 'c2c@creator-to-catalyst'], temp);
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  const list = claude(['plugin', 'list', '--json'], temp);
  assert.equal(list.status, 0, list.stderr);
  const entry = JSON.parse(list.stdout).find((item) => item.id === 'c2c@creator-to-catalyst');
  assert.ok(entry, list.stdout);
  assert.equal(entry.version, lock.version);

  // The old layout, marketplace.json inside plugin/, is what failed.
  const old = mkdtempSync(path.join(temp, 'old-'));
  mkdirSync(path.join(old, 'plugin/.claude-plugin'), { recursive: true });
  copyFileSync(path.join(clone, '.claude-plugin/marketplace.json'), path.join(old, 'plugin/.claude-plugin/marketplace.json'));
  const refused = claude(['plugin', 'marketplace', 'add', old], temp);
  assert.notEqual(refused.status, 0, refused.stdout);
});

test('bin/c2c doctor in a checkout fetches the pinned runtime and runs, never exit 6', () => {
  const pluginDir = path.join(clone, 'plugin');
  const res = c2c(pluginDir, ['doctor', '--local'], { C2C_RUNTIME_ARCHIVE: archiveFile });
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout, /local run; doctor\.json not updated/);
  assert.match(res.stdout, /D-E3 +vendor ok/);
  // Unpacked into the user cache, keyed by sha256; the plugin directory is untouched.
  assert.equal(existsSync(path.join(temp, 'home/.cache/c2c/runtime', lock.sha256, 'c2c/MANIFEST.sha256')), true);
  assert.equal(existsSync(path.join(pluginDir, 'vendor')), false);
  assert.deepEqual(readdirSync(path.join(temp, 'home/.cache/c2c/runtime')), [lock.sha256]);

  // Second run: cached, so no download is attempted even with no route out.
  const again = c2c(pluginDir, ['doctor', '--local'], { C2C_RUNTIME_URL: CLOSED_PORT_URL });
  assert.ok(again.status === 0 || again.status === 1, `exit ${again.status}\nstderr=${again.stderr}`);
});

test('offline first run exits 6 with one line naming the asset and C2C_RUNTIME_ARCHIVE', () => {
  const res = c2c(path.join(clone, 'plugin'), ['doctor', '--local'], {
    C2C_RUNTIME_DIR: path.join(temp, 'offline-cache'),
    C2C_RUNTIME_URL: CLOSED_PORT_URL,
  });
  assert.equal(res.status, 6, res.stdout);
  const lines = res.stderr.trim().split('\n');
  assert.equal(lines.length, 1, res.stderr);
  assert.match(lines[0], /^c2c: could not download the c2c \d+\.\d+\.\d+ runtime/);
  assert.ok(lines[0].includes(lock.asset), lines[0]);
  assert.match(lines[0], /C2C_RUNTIME_ARCHIVE=/);
  assert.equal(existsSync(path.join(temp, 'offline-cache', lock.sha256)), false);
});

test('a tampered runtime archive fails its checksum and is not unpacked', () => {
  const tampered = path.join(temp, 'tampered.tgz');
  const bytes = readFileSync(archiveFile);
  bytes[bytes.length - 100] ^= 0xff;
  writeFileSync(tampered, bytes);
  const cache = path.join(temp, 'tampered-cache');
  const res = c2c(path.join(clone, 'plugin'), ['doctor', '--local'], { C2C_RUNTIME_DIR: cache, C2C_RUNTIME_ARCHIVE: tampered });
  assert.equal(res.status, 6, res.stdout);
  assert.match(res.stderr, /failed its checksum/);
  assert.equal(existsSync(path.join(cache, lock.sha256)), false);
});

test('8 parallel first runs share one install, 4 rounds, never exit 6', async () => {
  const fetcher = path.join(clone, 'plugin/runtime/fetch-runtime.mjs');
  const run = (env) =>
    new Promise((resolve) => {
      const child = spawn(node, [fetcher], { env: cleanEnv(env), encoding: 'utf8' });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  for (let round = 0; round < 4; round++) {
    const cache = path.join(temp, `race-${round}`);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => run({ C2C_RUNTIME_DIR: cache, C2C_RUNTIME_ARCHIVE: archiveFile })),
    );
    const runtime = path.join(cache, lock.sha256, 'c2c');
    for (const res of results) {
      assert.equal(res.status, 0, `round ${round}: exit ${res.status}\nstderr=${res.stderr}`);
      assert.equal(res.stdout.trim(), runtime);
    }
    assert.equal(existsSync(path.join(runtime, 'MANIFEST.sha256')), true);
    // The install ran once; no staging or lock debris remains.
    assert.deepEqual(readdirSync(cache), [lock.sha256]);
    // The installed runtime actually runs.
    const doctor = c2c(path.join(clone, 'plugin'), ['doctor', '--local'], { C2C_RUNTIME_DIR: cache });
    assert.ok(doctor.status === 0 || doctor.status === 1, `round ${round}: exit ${doctor.status}\nstderr=${doctor.stderr}`);
  }
});

test('a lock left by a dead process is reclaimed and the install proceeds', () => {
  const cache = path.join(temp, 'stale-lock');
  const lockDir = path.join(cache, lock.sha256);
  mkdirSync(cache, { recursive: true });
  const dead = spawnSync(node, ['-e', '']);
  assert.equal(dead.status, 0);
  writeFileSync(`${lockDir}.lock`, JSON.stringify({ pid: dead.pid ?? 0, time: Date.now() }));
  const res = spawnSync(node, [path.join(clone, 'plugin/runtime/fetch-runtime.mjs')], {
    env: cleanEnv({ C2C_RUNTIME_DIR: cache, C2C_RUNTIME_ARCHIVE: archiveFile }),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), path.join(lockDir, 'c2c'));
  assert.equal(existsSync(path.join(lockDir, 'c2c/MANIFEST.sha256')), true);
});

test('an unpublished runtime asset (HTTP 404) names the release page and the source build', async () => {
  const server = createServer((req, res) => {
    res.writeHead(404).end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/releases/download/v${lock.version}/${lock.asset}`;
    const res = await c2cAsync(path.join(clone, 'plugin'), ['doctor', '--local'], {
      C2C_RUNTIME_DIR: path.join(temp, 'missing-asset-cache'),
      C2C_RUNTIME_URL: url,
    });
    assert.equal(res.status, 6, res.stdout);
    assert.match(res.stderr, /is not published at .* \(HTTP 404\)/);
    assert.match(res.stderr, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('/releases/download/.*', '/releases')));
    assert.match(res.stderr, /npm ci && npm run build && node scripts\/vendor-plugin\.mjs --pack/);
    assert.match(res.stderr, /C2C_RUNTIME_ARCHIVE=/);
    assert.equal(existsSync(path.join(temp, 'missing-asset-cache', lock.sha256)), false);
    // It is not misreported as an offline hint.
    assert.doesNotMatch(res.stderr, /If this machine is offline/);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('the committed runtime.json pins the archive this tree builds', (t) => {
  if (process.versions.node !== PINNED_NODE) {
    t.skip('gzip bytes are pinned to the Node 20.20.1 zlib');
    return;
  }
  assert.equal(readFileSync(path.join(repo, 'plugin/runtime/runtime.json'), 'utf8'), runtimeLockText(lock));
  // Same tree, same bytes.
  assert.equal(packRuntime({ root: repo }).lock.sha256, lock.sha256);
});
