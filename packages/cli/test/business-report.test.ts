import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFile } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildBusinessMigrationReport, businessReportAsJson, businessReportAsMarkdown } from '../src/business-report.js';

const root = repoRoot();
const ds = join(root, 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds');
const goldenDir = join(root, 'packages/cli/test/golden/business-report/kitchen-sink-gaps');
const cli = join(root, 'dist/cli/src/c2c.js');

function withoutStatusKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(withoutStatusKeys);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value as Record<string, unknown>).every(([key, child]) => key !== 'status' && withoutStatusKeys(child));
}

test('kitchen-sink-gaps business report matches the committed markdown and JSON goldens', () => {
  const report = buildBusinessMigrationReport(parseFile(ds).ir, { dc: 'in' });
  assert.equal(businessReportAsJson(report), readFileSync(join(goldenDir, 'migration-report.json'), 'utf8'));
  assert.equal(businessReportAsMarkdown(report), readFileSync(join(goldenDir, 'migration-report.md'), 'utf8'));
  assert.equal(withoutStatusKeys(report), true);
});

test('c2c report writes byte-identical markdown and JSON on repeated runs', (t) => {
  const one = mkdtempSync(join(tmpdir(), 'c2c-business-report-a-'));
  const two = mkdtempSync(join(tmpdir(), 'c2c-business-report-b-'));
  t.after(() => {
    rmSync(one, { recursive: true, force: true });
    rmSync(two, { recursive: true, force: true });
  });
  for (const out of [one, two]) {
    const run = spawnSync(process.execPath, [cli, 'report', ds, '--dc', 'in', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  }
  assert.equal(readFileSync(join(one, 'migration-report.md'), 'utf8'), readFileSync(join(two, 'migration-report.md'), 'utf8'));
  assert.equal(readFileSync(join(one, 'migration-report.json'), 'utf8'), readFileSync(join(two, 'migration-report.json'), 'utf8'));
});

test('c2c report refuses an unknown flag and a missing source cleanly', () => {
  const badFlag = spawnSync(process.execPath, [cli, 'report', ds, '--bogus'], { encoding: 'utf8' });
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /unknown flag --bogus/);
  const missing = spawnSync(process.execPath, [cli, 'report', join(root, 'missing.ds'), '--dc', 'in'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such file or directory/);
});
