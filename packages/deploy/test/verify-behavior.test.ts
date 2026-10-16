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
import { assertGolden, formatBehaviorMarkdown, loadGoldens, runBehavior, startOfflineBackend, textBoundaryEqual, type BehaviorBackend, type BehaviorCall } from '../src/verify-behavior.js';

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
  assert.throws(() => assertGolden({ version: 'nope', cases: [] }), /c2c-behavior-golden\/2/);
  assert.throws(() => assertGolden({ version: 'c2c-behavior-golden/1', cases: [] }), /c2c-behavior-golden\/2/);
  assert.throws(() => assertGolden({ version: 'c2c-behavior-golden/2', cases: [{ id: 'a', steps: [] }, { id: 'a', steps: [] }] }), /duplicate case id/);
  assert.throws(
    () => assertGolden({ version: 'c2c-behavior-golden/2', cases: [{ id: 'a', steps: [{ op: 'teleport' }] }] }),
    /unknown op/,
  );
  assert.throws(
    () => assertGolden({ version: 'c2c-behavior-golden/2', cases: [{ id: 'a', steps: [{ op: 'request', method: 'GET', path: '/x', expect: { unordered: 'yes' } }] }] }),
    /expect\.unordered must be a boolean/,
  );
  assert.throws(
    () => assertGolden({ version: 'c2c-behavior-golden/2', cases: [{ id: 'a', steps: [], expect: { unordered: 1 } }] }),
    /expect\.unordered must be a boolean/,
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
  // Row order is significant by default: a golden that declares the table
  // unordered still matches rows whose field order or row order differs.
  const reordered = JSON.parse(readFileSync(join(GOLDENS, 'cases.json'), 'utf8')) as ReturnType<typeof loadGoldens>;
  reordered.cases[0].expect!.unordered = true;
  reordered.cases[0].expect!.tables!.Book = [
    { Qty: '2', Title: 'Dune', Added_User: '<any>', Added_Time: '<timestamp>', CREATEDTIME: '<timestamp>', MODIFIEDTIME: '<timestamp>', ROWID: '<id>' },
  ];
  const backend2 = await startOfflineBackend(app);
  try {
    const { report } = await runBehavior(app, reordered, backend2, 'offline');
    assert.equal(report.ok, true, JSON.stringify(report.findings));
  } finally {
    await backend2.close();
  }
});

/** Golden fixture for the ordering/strictness MUST-FAIL cases below. */
function mutatedGolden(mutate: (golden: ReturnType<typeof loadGoldens>) => void): ReturnType<typeof loadGoldens> {
  const golden = JSON.parse(readFileSync(join(GOLDENS, 'cases.json'), 'utf8')) as ReturnType<typeof loadGoldens>;
  mutate(golden);
  return golden;
}

test('MUST-FAIL: a reordered report row list is a finding unless the step declares unordered', async () => {
  const app = deriveIr(parse(readFileSync(APP_DS, 'utf8')));
  // Two rows in the store; the golden lists them against insertion order.
  const twoRows = (first: string, second: string) => [
      { op: 'submit', form: 'Book', record: { Title: 'Dune', Qty: 2 } },
      { op: 'submit', form: 'Book', record: { Title: 'Foundation', Qty: 5 } },
      {
        op: 'report',
        report: 'All_Books',
        expect: {
          status: 200,
          body: {
            dryRun: false,
            rows: [
              { ROWID: '<id>', Title: first, Qty: first === 'Dune' ? 2 : 5, Added_User: '<any>', Added_Time: '<timestamp>', Modified_Time: null },
              { ROWID: '<id>', Title: second, Qty: second === 'Dune' ? 2 : 5, Added_User: '<any>', Added_Time: '<timestamp>', Modified_Time: null },
            ],
            fields: null,
            queryShape: 'SELECT ROWID, Title, Qty, Added_User, Added_Time, Modified_User, Modified_Time, c2c_source_id FROM Book ORDER BY ROWID LIMIT 1, 300',
            criteria: { op: 'true' },
            page: 0,
            pageSize: 300,
          },
        },
      },
    ];
  const backend = await startOfflineBackend(app);
  try {
    const ordered = mutatedGolden((g) => {
      g.cases = [{ id: 'reordered-report', steps: twoRows('Foundation', 'Dune') as never[] }];
    });
    const { report } = await runBehavior(app, ordered, backend, 'offline');
    assert.equal(report.ok, false, 'reordered rows in a sorted report must be a finding');
    assert.ok(report.findings.some((f) => f.pointer === 'body.rows[0].Title' && f.expected === 'Foundation' && f.actual === 'Dune'));
    const unordered = mutatedGolden((g) => {
      const steps = twoRows('Foundation', 'Dune');
      (steps[2].expect as { unordered?: boolean }).unordered = true;
      g.cases = [{ id: 'reordered-report', steps: steps as never[] }];
    });
    const { report: report2 } = await runBehavior(app, unordered, backend, 'offline');
    assert.equal(report2.ok, true, JSON.stringify(report2.findings));
  } finally {
    await backend.close();
  }
});

test('MUST-FAIL: extra, missing and absent-volatile fields are findings', async () => {
  const app = deriveIr(parse(readFileSync(APP_DS, 'utf8')));
  const backend = await startOfflineBackend(app);
  try {
    // Extra field on the Catalyst side: the golden omits `wrote`, which is
    // not volatile, so the response key set no longer matches.
    const extra = mutatedGolden((g) => {
      const values = (g.cases[0].steps[0] as { expect: { body: Record<string, unknown> } }).expect.body;
      delete values.wrote;
    });
    const { report } = await runBehavior(app, extra, backend, 'offline');
    assert.equal(report.ok, false, 'a dropped expected key must surface the extra actual field');
    assert.ok(report.findings.some((f) => f.pointer === 'body.wrote' && f.expected === '(absent)' && f.actual === true));
    // Missing field: the golden asserts a key the response does not carry.
    const missing = mutatedGolden((g) => {
      const values = ((g.cases[0].steps[0] as { expect: { body: { values: Record<string, unknown> } } }).expect.body.values);
      values.No_Such_Field = 'x';
    });
    const { report: report2 } = await runBehavior(app, missing, backend, 'offline');
    assert.equal(report2.ok, false);
    assert.ok(report2.findings.some((f) => f.pointer === 'body.values.No_Such_Field' && f.actual === '(absent)'));
    // Volatile field absent: a marker still requires the key to be present.
    const absentVolatile = mutatedGolden((g) => {
      const values = ((g.cases[0].steps[0] as { expect: { body: { values: Record<string, unknown> } } }).expect.body.values);
      values.GHOST_ID = '<id>';
    });
    const { report: report3 } = await runBehavior(app, absentVolatile, backend, 'offline');
    assert.equal(report3.ok, false);
    assert.ok(report3.findings.some((f) => f.pointer === 'body.values.GHOST_ID' && f.expected === '<id>' && f.actual === '(absent)'));
  } finally {
    await backend.close();
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

// ---------- capture-derived goldens: bind/ref, update, outcome, partial, tags, skip ----------

function sampleApp() {
  return deriveIr(parse(readFileSync(APP_DS, 'utf8')));
}

/** Rewrites replies of the offline backend, to stand in for Creator answers the harness never gives. */
type Rewrite = (method: string, path: string, body: unknown, res: BehaviorCall) => BehaviorCall;

async function replay(cases: unknown[], rewrite?: Rewrite) {
  const app = sampleApp();
  const golden = assertGolden({ version: 'c2c-behavior-golden/2', app: 'behavior-sample', cases });
  const offline = await startOfflineBackend(app);
  const backend: BehaviorBackend = rewrite
    ? { ...offline, call: async (method, path, body) => rewrite(method, path, body, await offline.call(method, path, body)), tableRows: (t) => offline.tableRows(t), reset: offline.reset && (() => offline.reset!()), close: () => offline.close() }
    : offline;
  try {
    return (await runBehavior(app, golden, backend, 'offline')).report;
  } finally {
    await backend.close();
  }
}

const SAVE_DUNE = { op: 'submit', form: 'Book', record: { Title: 'Dune', Qty: 2 }, bind: { dune: 'body.values.ROWID' }, expect: { outcome: 'saved' } };

test('the schema rejects malformed capture fields', () => {
  const bad = (step: Record<string, unknown>, extra: Record<string, unknown> = {}) => () =>
    assertGolden({ version: 'c2c-behavior-golden/2', cases: [{ id: 'a', steps: [step], ...extra }] });
  assert.throws(bad({ op: 'report', report: 'R', expect: { status: '3xx' } }), /expect\.status/);
  assert.throws(bad({ op: 'report', report: 'R', expect: { outcome: 'stored' } }), /expect\.outcome/);
  assert.throws(bad({ op: 'report', report: 'R', expect: { outcome: 'saved', count: 1 } }), /count/);
  assert.throws(bad({ op: 'submit', form: 'Book', record: {}, bind: { x: 'values.ROWID' } }), /bind/);
  assert.throws(bad({ op: 'update', report: 'R', record: {} }), /update needs report \+ where \+ record/);
  assert.throws(bad({ op: 'report', report: 'R' }, { skip: '' }), /skip/);
  assert.throws(bad({ op: 'report', report: 'R', tags: [''] }), /tags/);
  assert.throws(() => assertGolden({ version: 'c2c-behavior-golden/2', source: { origin: 'x' }, cases: [] }), /source/);
});

test('bind + ref, update-by-where and partial tables replay clean', async () => {
  const report = await replay([
    {
      id: 'update-qty',
      steps: [
        SAVE_DUNE,
        { op: 'submit', form: 'Book', record: { Title: 'Emma', Qty: 1 }, setup: true },
        { op: 'update', report: 'All_Books', where: { Title: 'Dune' }, record: { Qty: 7 }, expect: { body: { matched: 1, updated: 1, refused: 0 } } },
        { op: 'update', report: 'All_Books', where: { Title: 'Nope' }, record: { Qty: 9 }, expect: { body: { matched: 0, updated: 0, refused: 0 } }, creator: { code: 3100 } },
        { op: 'report', report: 'All_Books', expect: { outcome: 'rows', count: 2 } },
        { op: 'request', method: 'POST', path: '/reports/All_Books', body: { op: 'query' }, expect: { status: '2xx', partial: true, body: { rows: [{ ROWID: '<ref:dune>', Qty: '7' }, { Title: 'Emma' }] } } },
      ],
      expect: { partial: true, tables: { Book: [{ ROWID: '<ref:dune>', Title: 'Dune', Qty: 7 }, { Title: 'Emma', Qty: 1 }] } },
    },
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.summary.skipped, 0);
});

test('MUST-FAIL: outcome, update counts, partial values and unbound refs are findings', async () => {
  const report = await replay([
    {
      id: 'wrong',
      tags: ['creator-api-replay-unconfirmed'],
      steps: [
        { ...SAVE_DUNE, expect: { outcome: 'refused' } },
        { op: 'submit', form: 'Book', record: { Qty: 1 }, expect: { outcome: 'saved' } },
        { op: 'update', report: 'All_Books', where: { Title: 'Dune' }, record: { Qty: 7 }, expect: { body: { matched: 0, updated: 0, refused: 0 } } },
        { op: 'report', report: 'All_Books', expect: { outcome: 'rows', count: 3 } },
        { op: 'report', report: 'All_Books', expect: { status: '4xx' } },
        { op: 'submit', form: 'Book', record: { Title: '<ref:ghost>' }, tags: ['lookup'], expect: { outcome: 'saved' } },
      ],
      expect: { partial: true, tables: { Book: [{ Title: 'Dune', Qty: '2.5' }, { Title: 'x' }] } },
    },
  ]);
  const at = (pointer: string) => report.findings.find((f) => f.pointer === pointer);
  assert.equal(report.ok, false);
  assert.match(String(at('/forms/Book/submit outcome')?.actual), /^200 wrote/);
  assert.ok(report.findings.some((f) => f.step === 2 && f.expected === 'saved' && /^422 .*MANDATORY_MISSING/.test(String(f.actual))));
  assert.equal(at('body.matched')?.actual, 1);
  assert.ok(report.findings.some((f) => f.pointer === '/reports/All_Books outcome' && f.expected === 'rows:3' && f.actual === '200 rows:1'));
  assert.ok(report.findings.some((f) => f.pointer === '/reports/All_Books status' && f.expected === '4xx' && f.actual === 200));
  const ghost = at('<ref:ghost>');
  assert.equal(ghost?.actual, '(unbound)');
  assert.deepEqual(ghost?.tags, ['creator-api-replay-unconfirmed', 'lookup']);
  assert.ok(report.findings.some((f) => f.pointer === 'tables.Book[0].Qty' && f.expected === '2.5'));
  assert.ok(report.findings.some((f) => f.pointer === 'tables.Book[1].Title'));
});

test('a skipped case is reported as skipped, never as passing; env-artifact steps run uncompared', async () => {
  const report = await replay([
    { id: 'unreachable', skip: 'unreachable via API: mandatory image field', tags: ['unreachable-via-api'], steps: [{ op: 'submit', form: 'Nope', record: {} }] },
    {
      id: 'artifact',
      steps: [
        { op: 'submit', form: 'Book', record: { Title: 'Dune' }, tags: ['env-artifact:trial-user-limit'], expect: { outcome: 'refused' }, creator: { code: 3001 } },
      ],
      expect: { partial: true, tables: { Book: [{ Title: 'Dune' }] } },
    },
  ]);
  // The replayed case is clean, but one case was skipped: never equivalent.
  assert.deepEqual(report.findings, []);
  assert.equal(report.status, 'not-equivalent');
  assert.equal(report.ok, false);
  assert.equal(report.behaviorEquivalentApps, 0);
  assert.deepEqual([report.summary.replayed, report.summary.equivalentCases, report.summary.skipped], [1, 1, 1]);
  assert.deepEqual(report.skipped, [{ case: 'unreachable', reason: 'unreachable via API: mandatory image field' }]);
  assert.deepEqual(report.envArtifacts, [{ case: 'artifact', step: 1, tags: ['env-artifact:trial-user-limit'] }]);
  const md = formatBehaviorMarkdown(report);
  assert.match(md, /skipped: 1/);
  assert.match(md, /status: not-equivalent — equivalent on 1 of 2 cases, 1 skipped/);
  assert.match(md, /behavior-equivalent apps: 0/);
  assert.match(md, /- unreachable: unreachable via API/);
  assert.match(md, /- artifact step 1: env-artifact:trial-user-limit/);
  // MUST-FAIL: without the tag the same refusal expectation is a finding.
  const untagged = await replay([
    { id: 'artifact', steps: [{ op: 'submit', form: 'Book', record: { Title: 'Dune' }, expect: { outcome: 'refused' } }] },
  ]);
  assert.equal(untagged.ok, false);
});

test('the text boundary: numbers by value, booleans as true/false text, strings strictly', async () => {
  assert.equal(textBoundaryEqual('947.00', 947), true);
  assert.equal(textBoundaryEqual(947, '947'), true);
  assert.equal(textBoundaryEqual('true', true), true);
  assert.equal(textBoundaryEqual(false, 'false'), true);
  // MUST-FAIL: a different number, a non-numeric text, the other boolean, two strings.
  assert.equal(textBoundaryEqual('947.5', 947), false);
  assert.equal(textBoundaryEqual('947 units', 947), false);
  assert.equal(textBoundaryEqual('false', true), false);
  assert.equal(textBoundaryEqual('947.00', '947'), false);
  // In a replay: report rows carry Qty as a number, the golden as Creator decimal text.
  const ok = await replay([
    { id: 'n', steps: [{ op: 'submit', form: 'Book', record: { Title: 'Dune', Qty: 2 } }, { op: 'request', method: 'POST', path: '/reports/All_Books', body: { op: 'query' }, expect: { partial: true, body: { rows: [{ Qty: '2.00' }] } } }] },
  ]);
  assert.equal(ok.ok, true, JSON.stringify(ok.findings));
  const bad = await replay([
    { id: 'n', steps: [{ op: 'submit', form: 'Book', record: { Title: 'Dune', Qty: 2 } }, { op: 'request', method: 'POST', path: '/reports/All_Books', body: { op: 'query' }, expect: { partial: true, body: { rows: [{ Qty: '2.5' }] } } }] },
  ]);
  assert.deepEqual(bad.findings.map((f) => f.pointer), ['body.rows[0].Qty']);
});

// ---------- skipped goldens never pass ----------

test('MUST-FAIL: an all-skipped golden is not run: ok false, KPI 0, exit 3', async () => {
  const report = await replay([
    { id: 'a', skip: 'unreachable via API', steps: [{ op: 'submit', form: 'Book', record: { Title: 'x' } }] },
  ]);
  assert.equal(report.status, 'not-run');
  assert.equal(report.ok, false);
  assert.equal(report.behaviorEquivalentApps, 0);
  assert.deepEqual([report.summary.replayed, report.summary.equivalentCases], [0, 0]);
  assert.match(formatBehaviorMarkdown(report), /status: not-run — equivalent on 0 of 1 cases, 1 skipped/);

  const dir = mkdtempSync(join(tmpdir(), 'c2c-behavior-skip-'));
  try {
    writeFileSync(join(dir, 'cases.json'), JSON.stringify({ version: 'c2c-behavior-golden/2', cases: [{ id: 'a', skip: 'unreachable via API', steps: [{ op: 'submit', form: 'Book', record: { Title: 'x' } }] }] }));
    const cap = capture();
    const code = await verifyBehaviorCli([APP_DS, '--goldens', dir], cap.io);
    assert.equal(code, 3, cap.stdout() + cap.stderr());
    assert.match(cap.stdout(), /behavior-equivalent apps: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MUST-FAIL: a partly skipped golden with a clean replay exits 1, not 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-behavior-skip-'));
  try {
    writeFileSync(join(dir, 'cases.json'), JSON.stringify({ version: 'c2c-behavior-golden/2', cases: [
      { id: 'skipped', skip: 'unreachable via API', steps: [{ op: 'submit', form: 'Book', record: { Title: 'x' } }] },
      { id: 'clean', steps: [{ op: 'submit', form: 'Book', record: { Title: 'Dune' }, expect: { outcome: 'saved' } }] },
    ] }));
    const cap = capture();
    const code = await verifyBehaviorCli([APP_DS, '--goldens', dir], cap.io);
    assert.equal(code, 1, cap.stdout() + cap.stderr());
    assert.match(cap.stdout(), /equivalent on 1 of 2 cases, 1 skipped/);
    assert.match(cap.stdout(), /behavior-equivalent apps: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a golden with no skipped case and no finding is equivalent', async () => {
  const report = await replay([{ id: 'clean', steps: [{ op: 'submit', form: 'Book', record: { Title: 'Dune' }, expect: { outcome: 'saved' } }] }]);
  assert.equal(report.status, 'equivalent');
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.behaviorEquivalentApps, 1);
});

// ---------- saved-with-warning, bind, setup, update refused ----------

/** Creator's code 3000 with an on-success error array: stored, with a warning. */
const withWarning: Rewrite = (_m, path, _b, res) =>
  /\/forms\/Book\/submit$/.test(path) && res.body && typeof res.body === 'object' ? { ...res, body: { ...(res.body as object), warning: ['User Limit Reached'] } } : res;

test('saved-with-warning needs a warning; saved refuses one (MUST-FAIL both ways)', async () => {
  const dune = (outcome: string) => [{ id: 'w', steps: [{ op: 'submit', form: 'Book', record: { Title: 'Dune' }, expect: { outcome } }] }];
  assert.equal((await replay(dune('saved-with-warning'), withWarning)).ok, true);
  assert.equal((await replay(dune('saved'))).ok, true);
  // A plain save is not saved-with-warning.
  const noWarning = await replay(dune('saved-with-warning'));
  assert.deepEqual(noWarning.findings.map((f) => [f.pointer, f.expected, f.actual]), [['/forms/Book/submit outcome', 'saved-with-warning', '200 wrote']]);
  // A save with a warning is not a plain save.
  const warned = await replay(dune('saved'), withWarning);
  assert.deepEqual(warned.findings.map((f) => [f.pointer, f.expected, f.actual]), [['/forms/Book/submit outcome', 'saved', '200 wrote warning']]);
});

test('MUST-FAIL: a bind whose pointer is absent in the reply is a finding', async () => {
  const report = await replay([
    { id: 'b', steps: [{ op: 'submit', form: 'Book', record: { Title: 'Dune' }, bind: { dune: 'body.values.NO_SUCH' }, expect: { outcome: 'saved' } }] },
  ]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.findings.map((f) => [f.step, f.pointer, f.actual]), [[1, 'bind dune <- body.values.NO_SUCH', '(absent)']]);
});

test('a setup step is replayed but its reply is never compared', async () => {
  // The setup submit is refused (Title is mandatory) — compared, the default 200 would be a finding.
  const report = await replay([
    { id: 's', steps: [{ op: 'submit', form: 'Book', record: { Qty: 1 }, setup: true }, { op: 'submit', form: 'Book', record: { Title: 'Dune' }, expect: { outcome: 'saved' } }] },
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.summary.steps, 2);
  // MUST-FAIL: the same step without setup is compared.
  const compared = await replay([{ id: 's', steps: [{ op: 'submit', form: 'Book', record: { Qty: 1 } }] }]);
  assert.deepEqual(compared.findings.map((f) => [f.pointer, f.expected]), [['/forms/Book/submit status', 200]]);
});

test('MUST-FAIL: an update whose edit is refused counts it under refused', async () => {
  const seen: string[] = [];
  const refuseEdits: Rewrite = (_m, path, body, res) => {
    if (body && typeof body === 'object' && 'ROWID' in body) {
      seen.push(path);
      return { status: 422, body: { code: 'RULE', message: 'refused by rule' } };
    }
    return res;
  };
  const update = (refused: number) => [
    { id: 'u', steps: [SAVE_DUNE, { op: 'update', report: 'All_Books', where: { Title: 'Dune' }, record: { Qty: 7 }, expect: { body: { matched: 1, updated: 0, refused } } }] },
  ];
  const report = await replay(update(1), refuseEdits);
  assert.equal(seen.length, 1, 'the edit went through the backend');
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  const wrong = await replay(update(0), refuseEdits);
  assert.deepEqual(wrong.findings.map((f) => [f.pointer, f.expected, f.actual]), [['body.refused', 0, 1]]);
});

// ---------- api-only acceptance: a field a form rule hides, set through the Creator API ----------

const RULE_DS = `application "rule-sample"
{
\ttime zone = "Asia/Kolkata"
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tsection S
\t{
\t\tform Item
\t\t{
\t\t\tmust have Title
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tShelf
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tStatus
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tlist All_Items
\t\t{
\t\t\tshow all rows from Item
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\trecord event = on add
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\thide Shelf;
\t\t\t\t\t\tdisable Status;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tFile as "File"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\trecord event = on add
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Status = "Filed";
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

async function replayRule(cases: unknown[]) {
  const app = deriveIr(parse(RULE_DS));
  const golden = assertGolden({ version: 'c2c-behavior-golden/2', app: 'rule-sample', cases });
  const backend = await startOfflineBackend(app);
  try {
    return (await runBehavior(app, golden, backend, 'offline')).report;
  } finally {
    await backend.close();
  }
}

const CAPTURED = { op: 'submit', form: 'Item', record: { Title: 'Bolt', Shelf: 'S1', Status: 'Draft' }, creator: { code: 3000 }, expect: { outcome: 'saved' } };

test('api-only acceptance: the captured record is refused for client input, the form replay is compared, the workflow value still counts', async () => {
  const report = await replayRule([
    {
      id: 'add-item',
      steps: [{ ...CAPTURED, tags: ['api-only-acceptance'], apiOnly: ['Shelf', 'Status'], bind: { item: 'body.values.ROWID' } }],
      // Creator stored the client's Shelf (not compared) and the On Success Status (compared).
      expect: { partial: true, tables: { Item: [{ ROWID: '<ref:item>', Title: 'Bolt', Shelf: 'S1', Status: 'Filed' }] } },
    },
    {
      id: 'setup-only',
      steps: [
        { op: 'submit', form: 'Item', record: { Title: 'Nut', Shelf: 'S2' }, setup: true, tags: ['api-only-acceptance'], apiOnly: ['Shelf'] },
        { op: 'report', report: 'All_Items', expect: { outcome: 'rows', count: 1 } },
      ],
    },
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.summary.equivalentByDesign, 1);
  assert.equal(report.equivalentByDesign?.length, 1);
  const entry = report.equivalentByDesign![0]!;
  assert.deepEqual([entry.case, entry.step, entry.class, entry.fields], ['add-item', 1, 'api-only-acceptance', ['Shelf', 'Status']]);
  assert.match(entry.actual, /^403 .*Item\.(Shelf|Status) is (hidden|disabled) by a field rule/);
  const md = formatBehaviorMarkdown(report);
  assert.match(md, /equivalent by design: 1/);
  assert.match(md, /- add-item step 1: api-only-acceptance Shelf, Status — 403/);
  assert.match(md, /behavior-equivalent apps: 1/);
});

test('MUST-FAIL: api-only acceptance is never a plain pass or a silent skip', async () => {
  // Untagged: the 403 is a finding.
  const untagged = await replayRule([{ id: 'add-item', steps: [CAPTURED] }]);
  assert.equal(untagged.ok, false);
  assert.ok(untagged.findings.some((f) => f.pointer === '/forms/Item/success outcome' && /^403/.test(String(f.actual))), JSON.stringify(untagged.findings));
  assert.equal(untagged.summary.equivalentByDesign, 0);
  // Tagged on a field no rule denies: c2c accepting client input is a finding.
  const wrongField = await replayRule([
    { id: 'add-item', steps: [{ op: 'submit', form: 'Item', record: { Title: 'Bolt', Note: 'n' }, creator: { code: 3000 }, expect: { outcome: 'saved' }, tags: ['api-only-acceptance'], apiOnly: ['Note'] }] },
  ]);
  assert.equal(wrongField.ok, false);
  const refusal = wrongField.findings.find((f) => f.expected === 'refused for client input');
  assert.ok(refusal, JSON.stringify(wrongField.findings));
  assert.equal(refusal.pointer, '/forms/Item/success client input Note');
  assert.equal(wrongField.summary.equivalentByDesign, 0);
  // A workflow value is still compared: Creator stored Filed, a wrong table expectation is a finding.
  const workflow = await replayRule([
    {
      id: 'add-item',
      steps: [{ ...CAPTURED, tags: ['api-only-acceptance'], apiOnly: ['Shelf', 'Status'] }],
      expect: { partial: true, tables: { Item: [{ Title: 'Bolt', Status: 'Approved' }] } },
    },
  ]);
  assert.ok(workflow.findings.some((f) => f.pointer === 'tables.Item[0].Status' && f.expected === 'Approved' && f.actual === 'Filed'), JSON.stringify(workflow.findings));
});

test('the schema pairs the api-only-acceptance tag with apiOnly on a write step', () => {
  const bad = (step: Record<string, unknown>) => () => assertGolden({ version: 'c2c-behavior-golden/2', cases: [{ id: 'a', steps: [step] }] });
  assert.throws(bad({ op: 'submit', form: 'Item', record: {}, tags: ['api-only-acceptance'] }), /tag api-only-acceptance and apiOnly go together/);
  assert.throws(bad({ op: 'submit', form: 'Item', record: {}, apiOnly: ['Shelf'] }), /tag api-only-acceptance and apiOnly go together/);
  assert.throws(bad({ op: 'submit', form: 'Item', record: {}, tags: ['api-only-acceptance'], apiOnly: [] }), /apiOnly must be non-empty/);
  assert.throws(bad({ op: 'report', report: 'R', tags: ['api-only-acceptance'], apiOnly: ['Shelf'] }), /apiOnly needs a submit or update step/);
});
