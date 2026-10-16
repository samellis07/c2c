/**
 * `c2c verify-behavior`: the committed tiny golden
 * (tests/behavior/behavior-sample) replays clean against its own app — a
 * valid submit stores the row, the report reads it back, and a missing
 * mandatory field is refused with the captured code and message — and MUST
 * FAIL against the deliberately broken variant (app-broken.ds drops `must
 * have`), where every difference lands as a finding with its pointer.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { verifyBehaviorCli, type Io } from '../src/cli.js';
import { assertGolden, formatBehaviorMarkdown, loadGoldens, runBehavior, startOfflineBackend } from '../src/verify-behavior.js';

const root = repoRoot();
const APP_DS = join(root, 'tests/behavior/behavior-sample/app.ds');
const BROKEN_DS = join(root, 'tests/behavior/behavior-sample/app-broken.ds');
const GOLDENS = join(root, 'tests/behavior/behavior-sample/creator');

function capture(): { io: Io; stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: (text: string) => void (out += text),
      stderr: (text: string) => void (err += text),
      env: {},
      spawn: async () => assert.fail('verify-behavior offline never spawns'),
      fetch: async () => assert.fail('verify-behavior offline never fetches a remote'),
    },
    stdout: () => out,
    stderr: () => err,
  };
}

test('usage errors exit 2: no ds, no --goldens', async () => {
  const cap = capture();
  assert.equal(await verifyBehaviorCli([], cap.io), 2);
  assert.equal(await verifyBehaviorCli([APP_DS], cap.io), 2);
  assert.equal(await verifyBehaviorCli(['--goldens', GOLDENS], cap.io), 2);
});

test('a missing cases.json fails the run and names the schema', async () => {
  const cap = capture();
  const code = await verifyBehaviorCli([APP_DS, '--goldens', root], cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /cases\.json/);
});

test('the golden rejects a malformed file', () => {
  assert.throws(() => assertGolden({ version: 'nope', cases: [] }), /c2c-behavior-golden\/1/);
  assert.throws(() => assertGolden({ version: 'c2c-behavior-golden/1', cases: [{ id: 'a', steps: [] }, { id: 'a', steps: [] }] }), /duplicate case id/);
  assert.throws(
    () => assertGolden({ version: 'c2c-behavior-golden/1', cases: [{ id: 'a', steps: [{ op: 'teleport' }] }] }),
    /unknown op/,
  );
});

test('the tiny golden replays clean offline: findings 0, KPI 1, exit 0', async () => {
  const cap = capture();
  const code = await verifyBehaviorCli([APP_DS, '--goldens', GOLDENS], cap.io);
  assert.equal(code, 0, cap.stderr() + cap.stdout());
  assert.match(cap.stdout(), /findings: 0/);
  assert.match(cap.stdout(), /behavior-equivalent apps: 1/);
});

test('MUST-FAIL: the deliberately broken app reports every difference and exits 1', async () => {
  const cap = capture();
  const code = await verifyBehaviorCli([BROKEN_DS, '--goldens', GOLDENS], cap.io);
  assert.equal(code, 1, 'the broken app accepts a submit the golden says is refused');
  const out = cap.stdout();
  assert.match(out, /behavior-equivalent apps: 0/);
  assert.match(out, /submit-missing-mandatory/);
  assert.match(out, /status.*422.*200/);
  assert.match(out, /tables\.Book/);
});

test('a golden naming a different app is refused', async () => {
  const cap = capture();
  const code = await verifyBehaviorCli([BROKEN_DS.replace('app-broken.ds', 'app.ds'), '--goldens', GOLDENS], cap.io);
  assert.equal(code, 0);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-golden-other-'));
  try {
    const golden = JSON.parse(readFileSync(join(GOLDENS, 'cases.json'), 'utf8')) as { app?: string };
    golden.app = 'somebody-else';
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(golden));
    const cap2 = capture();
    const code2 = await verifyBehaviorCli([APP_DS, '--goldens', dir], cap2.io);
    assert.equal(code2, 1);
    assert.match(cap2.stderr(), /somebody-else/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalization: ids, timestamps, ordering and the text/number boundary', async () => {
  const app = deriveIr(parse(readFileSync(APP_DS, 'utf8')));
  const golden = loadGoldens(GOLDENS);
  const backend = await startOfflineBackend(app);
  try {
    const { report } = await runBehavior(app, golden, backend, 'offline');
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.equal(report.behaviorEquivalentApps, 1);
    assert.equal(report.summary.cases, 2);
  } finally {
    await backend.close();
  }
  // Row order is a normalization: the same rows in a different order still match.
  const reordered = JSON.parse(readFileSync(join(GOLDENS, 'cases.json'), 'utf8')) as ReturnType<typeof loadGoldens>;
  reordered.cases[0].expect!.tables!.Book = [
    { Qty: '2', Title: 'Dune', CREATEDTIME: '<timestamp>', ROWID: '<id>' },
  ];
  const backend2 = await startOfflineBackend(app);
  try {
    const { report } = await runBehavior(app, reordered, backend2, 'offline');
    assert.equal(report.ok, true, JSON.stringify(report.findings));
  } finally {
    await backend2.close();
  }
});

test('--report writes deterministic JSON and the markdown carries the KPI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-behavior-report-'));
  try {
    const cap = capture();
    const code = await verifyBehaviorCli([APP_DS, '--goldens', GOLDENS, '--report', join(dir, 'r.json'), '--report-md', join(dir, 'r.md')], cap.io);
    assert.equal(code, 0);
    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as { version: string; behaviorEquivalentApps: number; findings: unknown[] };
    assert.equal(report.version, 'c2c-behavior-report/1');
    assert.equal(report.behaviorEquivalentApps, 1);
    assert.deepEqual(report.findings, []);
    const md = readFileSync(join(dir, 'r.md'), 'utf8');
    assert.match(md, /behavior-equivalent apps: 1/);
    // Deterministic: a second run writes byte-identical reports.
    const cap2 = capture();
    await verifyBehaviorCli([APP_DS, '--goldens', GOLDENS, '--report', join(dir, 'r2.json'), '--report-md', join(dir, 'r2.md')], cap2.io);
    assert.equal(readFileSync(join(dir, 'r.json'), 'utf8'), readFileSync(join(dir, 'r2.json'), 'utf8'));
    assert.equal(md, readFileSync(join(dir, 'r2.md'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markdown lists each finding as case + pointer + expected vs actual', async () => {
  const app = deriveIr(parse(readFileSync(BROKEN_DS, 'utf8')));
  const golden = loadGoldens(GOLDENS);
  const backend = await startOfflineBackend(app);
  try {
    const { report } = await runBehavior(app, golden, backend, 'offline');
    assert.equal(report.ok, false);
    assert.ok(report.findings.length >= 3);
    for (const f of report.findings) {
      assert.equal(typeof f.case, 'string');
      assert.equal(typeof f.pointer, 'string');
      assert.ok('expected' in f && 'actual' in f);
    }
    const md = formatBehaviorMarkdown(report);
    assert.match(md, /\| submit-missing-mandatory \|/);
    assert.match(md, /status/);
  } finally {
    await backend.close();
  }
});
