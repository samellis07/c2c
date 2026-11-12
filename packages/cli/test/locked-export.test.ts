/**
 * Locked Marketplace export: fail closed.
 *
 * Partner apps installed from the Zoho Marketplace are LOCKED in Creator.
 * Their export (exportScript) returns HTTP 200 with a small text/html
 * "Access denied" page instead of a .ds. c2c must never treat that as an
 * empty or valid export: every .ds-reading command (precheck, analyze, plan,
 * deploy, schema, seed, migrate-data, smoke, and the directory readers)
 * refuses it with exit 2 and the locked-export message.
 *
 * The fixture is SYNTHETIC (same shape as the live error page: doctype,
 * title, 'Access denied' heading). Raw live responses stay local-only.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  LOCKED_EXPORT_MESSAGE,
  LockedExportError,
  isLockedExportSource,
  parseFile,
} from '../../core/src/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(repo, 'dist/cli/src/c2c.js');
// The many `node c2c.js` children below share a V8 compile cache so each e2e
// spawn does not recompile the whole CLI (ignored on runtimes without it).
process.env.NODE_COMPILE_CACHE ??= path.join(tmpdir(), 'c2c-node-compile-cache');
const lockedHtml = path.join(repo, 'tests/fixtures/locked-export.html');
const cleanDs = path.join(repo, 'fixtures/redistributable/library-application-system/library_application.ds');

const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('locked export fixture has the error-page shape (and is not a copy of a live response)', () => {
  const text = readFileSync(lockedHtml, 'utf8');
  assert.ok(text.length < 2048, `fixture stays small like the live page, got ${text.length}`);
  assert.match(text, /<!doctype html/i);
  assert.match(text, /<html/i);
  assert.match(text, /<head/i);
  assert.match(text, /Access denied/);
  assert.doesNotMatch(text, /^\s*application\s+"/m);
});

test('core flags the locked payload and keeps real exports and garbage apart', () => {
  const locked = readFileSync(lockedHtml, 'utf8');
  assert.equal(isLockedExportSource(locked), true);
  const clean = readFileSync(cleanDs, 'utf8');
  assert.equal(isLockedExportSource(clean), false);
  // Plain garbage is NOT a locked export: it keeps the generic exit-4 path.
  assert.equal(isLockedExportSource('garbage {{{\n'), false);
  assert.equal(isLockedExportSource('{"a": 1}\n'), false);
});

test('parseFile throws LockedExportError with the refusal message', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-locked-'));
  try {
    const lockedDs = path.join(dir, 'locked.ds');
    copyFileSync(lockedHtml, lockedDs);
    assert.throws(() => parseFile(lockedDs), (err: unknown) => {
      assert.ok(err instanceof LockedExportError);
      assert.equal((err as Error).message, LOCKED_EXPORT_MESSAGE);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precheck/analyze/plan/schema refuse a locked export with exit 2', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-locked-cli-'));
  try {
    const lockedDs = path.join(dir, 'locked.ds');
    copyFileSync(lockedHtml, lockedDs);
    const out = path.join(dir, 'plan-out');
    const cases: [string, string[]][] = [
      ['precheck', [lockedDs]],
      ['analyze', [lockedDs]],
      ['schema', [lockedDs]],
      ['plan', [lockedDs, '--out', out, '--dc', 'in']],
    ];
    for (const [label, args] of cases) {
      const result = run(label, ...args);
      assert.equal(result.status, 2, `${label}: exit ${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
      assert.match(result.stderr, /This export is not a Creator \.ds: the app looks like a locked Marketplace install/);
      assert.match(result.stderr, /Ask the vendor for the source \.ds or an unlocked copy/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seed, migrate-data, smoke, and the other .ds readers refuse a locked export with exit 2', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-locked-cmds-'));
  try {
    const lockedDs = path.join(dir, 'locked.ds');
    copyFileSync(lockedHtml, lockedDs);
    const out = path.join(dir, 'out');
    const cases: [string, string[]][] = [
      ['seed', ['seed', lockedDs, '--out', out]],
      ['smoke', ['smoke', lockedDs, '--project', '1', '--org', '2']],
      ['migrate-data', ['migrate-data', '--source-csv', dir, '--ds', lockedDs, '--project', '1', '--org', '2']],
      ['migrate-data --source-json', ['migrate-data', '--source-json', dir, '--ds', lockedDs, '--project', '1', '--org', '2']],
      ['fill-todos', ['fill-todos', lockedDs, '--emit', out]],
      ['parse', ['parse', lockedDs]],
      ['ui', ['ui', lockedDs, '--out', out]],
      ['auth', ['auth', lockedDs]],
      ['features', ['features', dir]],
      ['deluge', ['deluge', dir]],
      ['corpus', ['corpus', dir]],
      ['migration-report', ['migration-report', dir]],
      ['schema-corpus', ['schema-corpus', dir]],
      ['ui-corpus', ['ui-corpus', dir]],
    ];
    for (const [label, args] of cases) {
      const result = run(...args);
      assert.equal(result.status, 2, `${label}: exit ${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
      assert.match(result.stderr, /locked Marketplace install/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy refuses a locked export with exit 2', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-locked-deploy-'));
  try {
    const lockedDs = path.join(dir, 'locked.ds');
    copyFileSync(lockedHtml, lockedDs);
    const result = run('deploy', lockedDs, '--project', '1', '--org', '2');
    assert.equal(result.status, 2, `deploy: exit ${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /locked Marketplace install/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('garbage keeps the generic unparsable path (exit 4), not the locked refusal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-locked-garbage-'));
  try {
    const garbage = path.join(dir, 'garbage.ds');
    writeFileSync(garbage, 'garbage {{{\n');
    const result = run('precheck', garbage);
    assert.equal(result.status, 4, result.stderr);
    assert.doesNotMatch(result.stderr, /locked Marketplace install/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real gallery .ds still passes precheck (no locked refusal)', () => {
  const ok = run('precheck', cleanDs);
  assert.ok(ok.status === 0 || ok.status === 1, `exit ${ok.status} stderr=${ok.stderr}`);
  assert.doesNotMatch(ok.stderr, /locked Marketplace install/);
  const gallery = process.env.C2C_FIXTURES_DIR;
  if (!gallery) return;
  const probe = path.join(gallery, 'fixtures/c2c-test-batch/c2c-test-batch.ds');
  try {
    readFileSync(probe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return;
    throw error;
  }
  const g = run('precheck', probe);
  assert.ok(g.status === 0 || g.status === 1, `gallery exit ${g.status} stderr=${g.stderr}`);
  assert.doesNotMatch(g.stderr, /locked Marketplace install/);
});
