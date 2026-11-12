import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, lstatSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listTargets } from '../src/gallery.js';

/** The stat-based listing the Dirent walk replaced, with lstat: a symlink is skipped, never followed. */
function statListTargets(dir: string): string[] {
  const names = readdirSync(dir).filter((name) => !name.startsWith('.'));
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    // fs-race-allow: test oracle over a private scratch tree; nothing else writes it between the lstat and the read.
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (readdirSync(path).some((child) => child.toLowerCase().endsWith('.ds'))) out.push(path);
    } else if (name.toLowerCase().endsWith('.ds')) out.push(path);
  }
  return out;
}

test('quality gallery listTargets matches the lstat walk for folders, files, FIFOs and sockets, and skips links', async () => {
  // Short path: the socket name must fit the Unix socket limit.
  const dir = mkdtempSync('/tmp/c2c-q-');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(join(dir, 'sock.ds'), resolve));
  try {
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'A.ds'), 'x');
    mkdirSync(join(dir, 'no-app'));
    writeFileSync(join(dir, 'loose.ds'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, '.hidden.ds'), 'x');
    execFileSync('mkfifo', [join(dir, 'pipe.ds')]);
    symlinkSync(join(dir, 'app'), join(dir, 'linked-app'));
    symlinkSync(join(dir, 'loose.ds'), join(dir, 'linked.ds'));
    symlinkSync(join(dir, 'sock.ds'), join(dir, 'to-sock.ds'));
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling.ds'));
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling-dir'));
    const expected = statListTargets(dir);
    assert.deepEqual(
      expected.map((p) => p.slice(dir.length + 1)),
      ['app', 'loose.ds', 'pipe.ds', 'sock.ds'],
    );
    assert.deepEqual(listTargets(dir), expected);
    assert.throws(() => listTargets(join(dir, 'missing')), { code: 'ENOENT' });
    assert.throws(() => listTargets(join(dir, 'loose.ds')), { code: 'ENOTDIR' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
