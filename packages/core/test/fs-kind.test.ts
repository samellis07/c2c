import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegularFileIfPresent } from '../src/fs-kind.js';
import { NotFileError, parseFile, parseFileOrProject, parseFileOrProjectWithSidecars, parseProject } from '../src/parse.js';
import { repoRoot } from '../src/toolchain.js';

const FIXTURE_DS = join(repoRoot(), 'fixtures/redistributable/library-application-system/library_application.ds');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** A Unix socket needs a short path (macOS caps it near 104 bytes), so it lives under /tmp. */
async function withSocket(fn: (dir: string, sock: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync('/tmp/c2c-kind-');
  const sock = join(dir, 's.ds');
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  try {
    await fn(dir, sock);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fs-kind-'));
  writeFileSync(join(dir, 'file.txt'), 'text');
  writeFileSync(join(dir, 'empty.txt'), '');
  mkdirSync(join(dir, 'sub'));
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  symlinkSync(join(dir, 'missing'), join(dir, 'dangling'));
  symlinkSync(join(dir, 'sub'), join(dir, 'to-dir'));
  symlinkSync(join(dir, 'file.txt'), join(dir, 'to-file'));
  symlinkSync(join(dir, 'pipe'), join(dir, 'to-pipe'));
  return dir;
}

test('readRegularFileIfPresent reads a regular file, including an empty one', () => {
  const dir = fixtureTree();
  try {
    assert.equal(readRegularFileIfPresent(join(dir, 'file.txt')), 'text');
    assert.equal(readRegularFileIfPresent(join(dir, 'empty.txt')), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRegularFileIfPresent is undefined for absent, directory and FIFO without blocking, and follows no link', () => {
  const dir = fixtureTree();
  try {
    for (const name of ['missing', 'file.txt/x', 'sub', 'pipe', 'dangling', 'to-dir', 'to-file', 'to-pipe']) {
      assert.equal(readRegularFileIfPresent(join(dir, name)), undefined, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRegularFileIfPresent never opens a socket, direct or through a link', async () => {
  await withSocket((dir, sock) => {
    symlinkSync(sock, join(dir, 'link.ds'));
    assert.equal(readRegularFileIfPresent(sock), undefined);
    assert.equal(readRegularFileIfPresent(join(dir, 'link.ds')), undefined);
  });
});

test('readRegularFileIfPresent throws for an unreadable file instead of treating it as absent', { skip: isRoot && 'root reads mode 000' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fs-kind-acl-'));
  try {
    writeFileSync(join(dir, 'locked.txt'), 'x');
    chmodSync(join(dir, 'locked.txt'), 0o000);
    assert.throws(() => readRegularFileIfPresent(join(dir, 'locked.txt')), { code: 'EACCES' });
  } finally {
    chmodSync(join(dir, 'locked.txt'), 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseFileOrProject parses a file as parseFile and a directory as parseProject, and refuses a FIFO or absent target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fs-kind-parse-'));
  try {
    mkdirSync(join(dir, 'app'));
    copyFileSync(FIXTURE_DS, join(dir, 'app', 'library_application.ds'));
    copyFileSync(FIXTURE_DS, join(dir, 'one.ds'));
    execFileSync('mkfifo', [join(dir, 'pipe.ds')]);
    assert.deepEqual(parseFileOrProject(join(dir, 'one.ds')).ir, parseFile(join(dir, 'one.ds')).ir);
    assert.deepEqual(parseFileOrProject(join(dir, 'app')).ir, parseProject(join(dir, 'app')).ir);
    assert.throws(() => parseFileOrProject(join(dir, 'pipe.ds')), NotFileError);
    assert.throws(() => parseFileOrProject(join(dir, 'missing.ds')), { code: 'ENOENT' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseFileOrProject adds no widget sidecars where parseFileOrProjectWithSidecars does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fs-kind-sidecar-'));
  try {
    copyFileSync(FIXTURE_DS, join(dir, 'one.ds'));
    mkdirSync(join(dir, 'sidecars', 'widgets', 'w1'), { recursive: true });
    writeFileSync(join(dir, 'sidecars', 'widgets', 'w1', 'index.html'), '<div></div>');
    assert.ok(parseFileOrProjectWithSidecars(join(dir, 'one.ds')).ir.widgets?.length, 'the sidecar variant sees the widget');
    assert.equal(parseFileOrProject(join(dir, 'one.ds')).ir.widgets, parseFile(join(dir, 'one.ds')).ir.widgets);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
