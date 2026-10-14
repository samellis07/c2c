import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { translate } from '../src/translate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const parityUrl = pathToFileURL(path.join(root, 'tests/golden/parity.mjs')).href;
const parity = await import(parityUrl);

interface GoldenCase {
  id: string;
  builtin: string;
  capture: 'value' | 'mock' | 'client' | 'workflow';
  resultKind: string | null;
  kind?: string;
  edges: string[];
  needsForm: boolean;
  notes: string;
  script: string;
  expect?: { $compileError: string };
  additional?: boolean;
  residual?: boolean;
}

const cases = parity.cases as GoldenCase[];
const BOOL_CAPTURE_ARTIFACTS = parity.BOOL_CAPTURE_ARTIFACTS as string[];
const BOOL_CAPTURE_ARTIFACT_ERROR = parity.BOOL_CAPTURE_ARTIFACT_ERROR as string;

const MIN: Record<string, number> = {
  'task:cancel': 1,
  get: 8,
  distinct: 4,
  getall: 3,
  removeAllAlpha: 4,
  isEmpty: 4,
  'task:success': 1,
  sendmail: 1,
  add: 4,
  remove: 4,
  removeelement: 4,
  days360: 4,
  removeall: 4,
  select: 2,
  sort: 4,
  round: 4,
  getDayOfWeek: 4,
  indexOf: 4,
  leftpad: 4,
  toStartOfWeek: 4,
  intersect: 4,
  isNumber: 4,
  toLowerCase: 1,
  toUpperCase: 1,
  trim: 1,
  contains: 1,
  startsWith: 1,
  endsWith: 1,
  subString: 1,
  replaceAll: 1,
  replaceFirst: 1,
  lastIndexOf: 1,
  length: 1,
  getPrefix: 1,
  getSuffix: 1,
  concat: 1,
  toList: 1,
  toLong: 1,
  toNumber: 1,
  toDecimal: 1,
  toMap: 1,
  isNull: 1,
  isBlank: 1,
  ifnull: 1,
  abs: 1,
  sqrt: 1,
  floor: 1,
  ceil: 1,
  min: 1,
  max: 1,
  power: 1,
  addDay: 1,
  addMonth: 1,
  addYear: 1,
  addWeek: 1,
  addHour: 1,
  addMinutes: 1,
  addSeconds: 1,
  addBusinessDay: 1,
  getYear: 1,
  getMonth: 1,
  getDay: 1,
  getHour: 1,
  getMinutes: 1,
  getSeconds: 1,
  toDate: 1,
  toTime: 1,
  toString: 1,
  put: 1,
  containKey: 1,
  size: 1,
  addAll: 1,
  diffDays: 1,
};

/** Node output for one case. This is the shim, not Creator. */
export async function evaluateCase(entry: GoldenCase): Promise<unknown> {
  return parity.evaluateCase(entry);
}

/** Accept a raw function return, a `{ cases }` wrapper, a quoted JSON string, or `c2c<TAB>` info lines. */
export function parseVectors(text: string): Record<string, unknown> {
  return parity.parseVectors(text);
}

/**
 * Compared cases, plus ids that must stay pending.
 * `invalid: { id: "capture-artifact" }` records the bool-encoder bug.
 * That id is pending only while it has no stored case value, or while the
 * stored value is the criteria-null artifact error.
 * A stored true, false, null, or a different $error is compared.
 */
export function vectorStatus(
  text: string,
  artifactIds: readonly string[],
): { cases: Record<string, unknown>; pending: Set<string> } {
  return parity.vectorStatus(text, artifactIds);
}

test('golden catalog names every built-in and every case parses', () => {
  const dsPath = path.join(root, 'tests/golden/c2c-golden.ds');
  const ds = readFileSync(dsPath, 'utf8');
  assert.doesNotMatch(ds, /GoldenRow_Select/);
  assert.doesNotMatch(ds, /Tag\.select\("Open"\)/);
  assert.match(ds, /share_settings/);
  assert.match(ds, /space Space/);
  assert.match(ds, /section Golden[\s\S]*form GoldenRow/);
  assert.match(ds, /displayname = "Reset"/);
  assert.match(ds, /displayname = "Cancel"/);
  assert.equal(BOOL_CAPTURE_ARTIFACTS.length, 42);
  const added = [
    'foreach.null',
    'foreach.empty',
    'date.cmp.lt-null',
    'date.cmp.gt-null',
    'date.cmp.lte-null',
    'date.cmp.gte-null',
    'date.cmp.lt-null-null',
    'date.cmp.gt-null-null',
    'date.cmp.lte-null-null',
    'date.cmp.gte-null-null',
    'date.rel.bad-eq',
  ];
  for (const id of added) assert.ok(cases.some((entry) => entry.id === id), id);
  const badEq = cases.find((entry) => entry.id === 'date.rel.bad-eq');
  assert.equal(badEq?.script.includes("'"), false, 'date.rel.bad-eq must not use a single-quoted date literal');
  assert.match(badEq?.script ?? '', /"not-a-date"\.toDate\(\)/);
  for (const entry of cases) {
    if (!entry.expect) continue;
    assert.equal(entry.expect.$compileError.length > 0, true, entry.id);
  }

  const counts: Record<string, number> = Object.create(null);
  for (const entry of cases) counts[entry.builtin] = (counts[entry.builtin] ?? 0) + 1;
  for (const [builtin, min] of Object.entries(MIN)) {
    assert.ok((counts[builtin] ?? 0) >= min, `${builtin} has ${counts[builtin] ?? 0} cases, want >= ${min}`);
  }
  const ids = new Set<string>();
  for (const entry of cases) {
    assert.equal(ids.has(entry.id), false, entry.id);
    ids.add(entry.id);
    const translated = translate(entry.script);
    const unknown = translated.todos.filter((item) => item.construct.startsWith('task:'));
    assert.deepEqual(unknown, [], `${entry.id} did not parse`);
    assert.ok(translated.stats.statements > 0, entry.id);
  }
});

test('vector parser accepts the shapes the user can paste', () => {
  assert.deepEqual(parseVectors('{"indexOf.found":1}'), { 'indexOf.found': 1 });
  assert.deepEqual(parseVectors('{"version":1,"source":"pending","cases":{}}'), {});
  assert.deepEqual(parseVectors('{"version":1,"cases":{"indexOf.found":1}}'), { 'indexOf.found': 1 });
  assert.deepEqual(parseVectors('"{\\"indexOf.found\\":1}"'), { 'indexOf.found': 1 });
  assert.deepEqual(parseVectors('log c2c\tindexOf.found\t1\nc2c\taddDay.month-end\t{"$date":"2020-02-01T00:00:00"}\n'), {
    'indexOf.found': 1,
    'addDay.month-end': { $date: '2020-02-01T00:00:00' },
  });
});

test('node evaluator returns a canon for every case without calling Creator', async () => {
  const byId = new Map<string, unknown>();
  for (const entry of cases) {
    const value = await evaluateCase(entry);
    JSON.stringify(value);
    byId.set(entry.id, value);
  }
  assert.equal(byId.get('indexOf.found'), 1);
  assert.equal(byId.get('abs.negative'), 3);
  assert.deepEqual(byId.get('addDay.month-end'), { $date: '2020-02-01T00:00:00' });
  assert.deepEqual(byId.get('decimal.add'), { $decimal: '10.75' });
  assert.deepEqual(byId.get('toLong.decimal-text'), 12);
  assert.deepEqual(byId.get('toLong.negative-text'), -12);
  assert.deepEqual(byId.get('sendmail.dry-run'), { $sendmail: { performed: false, dryRun: true } });
  assert.deepEqual(byId.get('task.cancel.bare'), { $client: ['cancelSubmit'] });
  assert.deepEqual(byId.get('task.cancel.guarded'), { $client: ['cancelSubmit'] });
  assert.deepEqual(byId.get('task.success.info'), { $workflow: 'on success', $client: ['info'] });
});

test('invalid capture artifacts stay pending and a real bool value does not', () => {
  const id = BOOL_CAPTURE_ARTIFACTS[0]!;
  const artifacts = BOOL_CAPTURE_ARTIFACTS;
  const marked = vectorStatus(
    JSON.stringify({
      version: 1,
      invalid: { [id]: 'capture-artifact' },
      cases: {
        'indexOf.found': 1,
        [id]: { $error: `Error at line : 1, ${BOOL_CAPTURE_ARTIFACT_ERROR}` },
      },
    }),
    artifacts,
  );
  assert.equal(marked.pending.has(id), true);
  assert.equal(marked.cases['indexOf.found'], 1);
  const bare = vectorStatus(
    JSON.stringify({
      [id]: { $error: `Error at line : 9, ${BOOL_CAPTURE_ARTIFACT_ERROR}` },
      'abs.negative': 3,
    }),
    artifacts,
  );
  assert.equal(bare.pending.has(id), true);
  assert.equal(bare.pending.has('abs.negative'), false);
  const real = vectorStatus(JSON.stringify({ [id]: true }), artifacts);
  assert.equal(real.pending.has(id), false);
  assert.equal(real.cases[id], true);
  // The invalid map must not keep an id pending once a real value is stored.
  for (const value of [true, false, null, { $error: 'a different failure' }]) {
    const replaced = vectorStatus(
      JSON.stringify({
        version: 1,
        invalid: { [id]: 'capture-artifact' },
        cases: { [id]: value },
      }),
      artifacts,
    );
    assert.equal(replaced.pending.has(id), false, JSON.stringify(value));
    assert.deepEqual(replaced.cases[id], value);
  }
});

test('recapture.json overlays vectors and a mismatch is a new failure', async () => {
  const artifacts = BOOL_CAPTURE_ARTIFACTS;
  const id = artifacts[0]!;
  const other = artifacts[1]!;
  const third = artifacts[2]!;
  const base = JSON.stringify({
    version: 1,
    invalid: {
      [id]: 'capture-artifact',
      [other]: 'capture-artifact',
      [third]: 'capture-artifact',
    },
    cases: {
      'indexOf.found': 1,
      [id]: { $error: `Error at line : 1, ${BOOL_CAPTURE_ARTIFACT_ERROR}` },
    },
  });
  const merged = parity.mergeRecaptureText(
    base,
    JSON.stringify({
      version: 1,
      cases: { [id]: true, [other]: false, [third]: null },
    }),
  ) as string;
  const status = vectorStatus(merged, artifacts);
  assert.equal(status.pending.has(id), false);
  assert.equal(status.cases[id], true);
  assert.equal(status.cases[other], false);
  assert.equal(status.pending.has(other), false);
  assert.equal(status.cases[third], null);
  assert.equal(status.pending.has(third), false);
  assert.equal(status.cases['indexOf.found'], 1);
  const doc = JSON.parse(merged) as { invalid: Record<string, string> };
  assert.equal(doc.invalid[id], 'capture-artifact');
  const stillBad = parity.mergeRecaptureText(
    base,
    `c2c\t${id}\t${JSON.stringify({ $error: `line 3, ${BOOL_CAPTURE_ARTIFACT_ERROR}` })}\n`,
  ) as string;
  assert.equal(vectorStatus(stillBad, artifacts).pending.has(id), true);

  const wrong = { $error: 'not the capture artifact' };
  const committed = readFileSync(path.join(root, 'tests/golden/vectors.json'), 'utf8');
  const overCommitted = parity.mergeRecaptureText(committed, JSON.stringify({ [id]: wrong })) as string;
  const compared = vectorStatus(overCommitted, artifacts);
  assert.equal(compared.pending.has(id), false);
  assert.equal(Object.keys(compared.cases).length, 239);
  const entry = cases.find((item) => item.id === id);
  assert.ok(entry);
  const failing = (await parity.failingParityIds([entry], compared.cases, compared.pending)) as string[];
  assert.deepEqual(failing, [id]);
  const inBaseline = (parity.loadBaselineIds() as string[]).includes(id);
  assert.equal(inBaseline, false);
  assert.equal(parity.parityVerdict(true, false, false), 'fail');

  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-golden-'));
  try {
    const fixtures = path.join(dir, 'fixtures');
    const localDir = path.join(fixtures, 'golden');
    const env = { C2C_FIXTURES_DIR: fixtures } as NodeJS.ProcessEnv;
    mkdirSync(localDir, { recursive: true });
    mkdirSync(path.join(dir, 'tests/golden'), { recursive: true });
    writeFileSync(path.join(dir, 'tests/golden/vectors.json'), base);
    writeFileSync(path.join(localDir, 'recapture.json'), JSON.stringify({ [id]: true }));
    const fromCommitted = parity.loadVectorText(dir, env) as string;
    const loaded = vectorStatus(fromCommitted, artifacts);
    assert.equal(loaded.cases[id], true);
    assert.equal(loaded.cases['indexOf.found'], 1);
    assert.equal(loaded.pending.has(id), false);
    writeFileSync(path.join(localDir, 'vectors.json'), JSON.stringify({ 'indexOf.found': 9, [id]: false }));
    const fromLocal = vectorStatus(parity.loadVectorText(dir, env) as string, artifacts);
    assert.equal(fromLocal.cases['indexOf.found'], 9);
    assert.equal(fromLocal.cases[id], true);
    assert.equal(fromLocal.pending.has(id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Creator line prefix is not part of the compared error', () => {
  const stripped = vectorStatus(
    JSON.stringify({ 'indexOf.missing': { $error: 'Error at line : 12, boom' } }),
    [],
  );
  assert.deepEqual(stripped.cases['indexOf.missing'], { $error: 'boom' });
  const plain = vectorStatus(JSON.stringify({ 'indexOf.found': { $error: 'boom' } }), []);
  assert.deepEqual(plain.cases['indexOf.found'], { $error: 'boom' });
  assert.equal(parity.sameValue({ $error: 'boom' }, { $error: 'Error at line : 4, boom' }), true);
  assert.equal(parity.sameValue({ $error: 'other' }, { $error: 'Error at line : 4, boom' }), false);
});

test('committed vectors compare the 238 captures and leave the 42 bool artifacts pending', () => {
  const text = readFileSync(path.join(root, 'tests/golden/vectors.json'), 'utf8');
  const { cases: vectors, pending } = vectorStatus(text, BOOL_CAPTURE_ARTIFACTS);
  assert.equal(Object.keys(vectors).length, 238);
  const dataIds = [
    'getall.names-qty-positive',
    'getall.names-qty-negative',
    'getall.names-qty-missing',
    'getall.ada-qty',
    'distinct.status-open',
    'distinct.all-names',
    'distinct.all-status',
    'getall.names-open',
    'getall.names-open-spelling',
    'getall.status-all',
    'removeelement.fetch-present',
    'removeelement.fetch-absent',
    'removeelement.fetch-spelling',
    'removeall.fetch-subset',
    'removeall.fetch-spelling',
  ];
  for (const id of dataIds) assert.equal(Object.prototype.hasOwnProperty.call(vectors, id), true, id);
  for (const id of BOOL_CAPTURE_ARTIFACTS) {
    assert.equal(Object.prototype.hasOwnProperty.call(vectors, id), false, id);
    assert.equal(pending.has(id), true, id);
  }
  const doc = JSON.parse(text) as { cases: Record<string, unknown>; invalid: Record<string, string> };
  assert.deepEqual(Object.keys(doc.invalid).sort(), [...BOOL_CAPTURE_ARTIFACTS].sort());
  for (const mark of Object.values(doc.invalid)) assert.equal(mark, 'capture-artifact');
});

test('parity baseline is a sorted comment-headed id list and only shrinks', () => {
  const text = readFileSync(path.join(root, 'tests/golden/parity-baseline.json'), 'utf8');
  assert.match(text, /^\/\/ Parity baseline:/);
  const ids = parity.readBaseline(text) as string[];
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(parity.formatBaseline(ids), text);
  const known = new Set(cases.map((entry) => entry.id));
  for (const id of ids) assert.equal(known.has(id), true, id);
  assert.equal(parity.shrinkMessage('days360.same-day'), 'remove days360.same-day from parity-baseline.json');
  assert.equal(parity.parityVerdict(true, false, true), 'known-gap');
  assert.equal(parity.parityVerdict(true, true, true), 'shrink');
  assert.equal(parity.parityVerdict(true, false, false), 'fail');
  assert.equal(parity.parityVerdict(true, true, false), 'pass');
  assert.equal(parity.parityVerdict(false, false, false), 'pending');
  assert.equal(parity.parityVerdict(false, false, true), 'shrink');

  const refused = parity.planBaselineUpdate(['b'], ['a', 'b'], false);
  assert.equal(refused.refused, true);
  assert.equal(refused.next, null);
  assert.deepEqual(refused.added, ['a']);
  assert.deepEqual(refused.removed, []);
  const shrunk = parity.planBaselineUpdate(['a', 'b'], ['b'], false);
  assert.equal(shrunk.refused, false);
  assert.deepEqual(shrunk.removed, ['a']);
  assert.deepEqual(shrunk.added, []);
  assert.deepEqual(shrunk.next, ['b']);
  const added = parity.planBaselineUpdate(['b'], ['a', 'b'], true);
  assert.equal(added.refused, false);
  assert.deepEqual(added.added, ['a']);
  assert.deepEqual(added.next, ['a', 'b']);
  const round = parity.readBaseline(parity.formatBaseline(['z', 'a'])) as string[];
  assert.deepEqual(round, ['a', 'z']);
});

test('fixture directory comes only from C2C_FIXTURES_DIR; local files overlay the committed vectors', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'c2c-fixtures-'));
  try {
    const repo = path.join(parent, 'repo');
    const committed = path.join(repo, 'tests/golden');
    const envRoot = path.join(parent, 'env-fixtures');
    const envGolden = path.join(envRoot, 'golden');
    const empty = path.join(parent, 'empty');
    mkdirSync(committed, { recursive: true });
    mkdirSync(envGolden, { recursive: true });
    mkdirSync(empty, { recursive: true });
    writeFileSync(path.join(committed, 'vectors.json'), JSON.stringify({ 'indexOf.found': 1 }));

    const noEnv = {} as NodeJS.ProcessEnv;
    assert.equal(parity.resolveFixturesDir(repo, noEnv), null);
    const bare = parity.loadVectorBundle(repo, noEnv);
    assert.equal(bare.base.kind, 'committed');
    assert.equal(JSON.parse(bare.text)['indexOf.found'], 1);
    assert.match(parity.formatVectorSources(bare) as string, /golden vectors: committed 1 .+; recapture 0; residual 0$/);

    const env = { C2C_FIXTURES_DIR: envRoot } as NodeJS.ProcessEnv;
    assert.equal(parity.resolveFixturesDir(repo, env), envRoot);
    writeFileSync(path.join(envGolden, 'vectors.json'), JSON.stringify({ 'indexOf.found': 2 }));
    writeFileSync(path.join(envGolden, 'recapture.json'), JSON.stringify({ 'indexOf.found': 3 }));
    const local = parity.loadVectorBundle(repo, env);
    assert.equal(local.base.kind, 'local');
    assert.equal(local.base.count, 1);
    assert.equal(local.recapture?.count, 1);
    assert.equal(local.residual, null);
    assert.equal(JSON.parse(local.text)['indexOf.found'], 3);
    assert.match(parity.formatVectorSources(local) as string, /golden vectors: local 1 .+; recapture 1 .+; residual 0$/);
    writeFileSync(path.join(envGolden, 'residual.json'), JSON.stringify({ 'indexOf.found': 7, 'abs.negative': 8 }));
    const overlaid = parity.loadVectorBundle(repo, env);
    assert.equal(overlaid.residual?.count, 2);
    assert.equal(JSON.parse(overlaid.text)['indexOf.found'], 7);
    assert.equal(JSON.parse(overlaid.text)['abs.negative'], 8);
    assert.match(parity.formatVectorSources(overlaid) as string, /recapture 1 .+; residual 2 /);
    writeFileSync(path.join(envGolden, 'submit.json'), JSON.stringify({ 'indexOf.found': 9 }));
    const submitOverlaid = parity.loadVectorBundle(repo, env);
    assert.equal(submitOverlaid.submit?.count, 1);
    assert.equal(JSON.parse(submitOverlaid.text)['indexOf.found'], 9);
    assert.match(parity.formatVectorSources(submitOverlaid) as string, /residual 2 .+; submit 1 /);

    assert.equal(parity.resolveFixturesDir(repo, { C2C_FIXTURES_DIR: empty }), empty);
    const emptyBundle = parity.loadVectorBundle(repo, { C2C_FIXTURES_DIR: empty });
    assert.equal(emptyBundle.base.kind, 'committed');
    assert.equal(emptyBundle.base.count, 1);
    assert.equal(emptyBundle.recapture, null);
    assert.equal(emptyBundle.residual, null);
    assert.equal(JSON.parse(emptyBundle.text)['indexOf.found'], 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('each golden case is pending until its Creator vector is saved', async (t) => {
  const bundle = parity.loadVectorBundle();
  const sources = parity.formatVectorSources(bundle) as string;
  console.log(sources);
  t.diagnostic(sources);
  const { cases: vectors, pending } = vectorStatus(bundle.text, BOOL_CAPTURE_ARTIFACTS);
  const baseline = new Set<string>(parity.loadBaselineIds() as string[]);
  const seen = new Set<string>();
  let knownGaps = 0;
  for (const entry of cases) {
    seen.add(entry.id);
    const has = Object.prototype.hasOwnProperty.call(vectors, entry.id);
    const artifact = pending.has(entry.id);
    const compared = has && !artifact;
    const inBaseline = baseline.has(entry.id);
    if (!compared) {
      if (inBaseline) {
        await t.test(entry.id, async () => {
          assert.fail(parity.shrinkMessage(entry.id));
        });
      } else {
        await t.test(entry.id, { todo: true }, async () => {});
      }
      continue;
    }
    const actual = await evaluateCase(entry);
    const matches = parity.sameValue(actual, vectors[entry.id]) as boolean;
    const verdict = parity.parityVerdict(true, matches, inBaseline) as string;
    if (verdict === 'known-gap') {
      knownGaps += 1;
      await t.test(entry.id, { todo: 'known parity gap' }, () => {
        assert.deepEqual(actual, vectors[entry.id]);
      });
    } else if (verdict === 'shrink') {
      await t.test(entry.id, async () => {
        assert.fail(parity.shrinkMessage(entry.id));
      });
    } else {
      await t.test(entry.id, () => {
        assert.deepEqual(actual, vectors[entry.id]);
      });
    }
  }
  for (const id of baseline) {
    if (seen.has(id)) continue;
    await t.test(id, async () => {
      assert.fail(parity.shrinkMessage(id));
    });
  }
  const line = `golden parity known gaps: ${knownGaps}`;
  t.diagnostic(line);
  console.log(line);
  await t.test(line, () => {
    assert.equal(Number.isInteger(knownGaps), true);
  });
});

test('criteria dataset is the ordered list the harness compares', () => {
  const data = JSON.parse(readFileSync(path.join(root, 'tests/golden/criteria-data.json'), 'utf8')) as {
    app: string;
    notApp: string;
    listCompare: string;
    forms: {
      GoldenRow: { csv: string; rows: Array<{ Name: string; Qty: number; Status: string }> };
      FlagRow: {
        csv: string;
        rows: Array<{ Name: string; Qty: number; Status: string; Billable: boolean; Approved: boolean }>;
      };
    };
    dropped: Record<string, string>;
    expected: Record<string, unknown>;
  };
  assert.equal(data.app, 'c2c-golden-criteria');
  assert.equal(typeof data.notApp, 'string');
  assert.notEqual(data.notApp, data.app);
  assert.equal(data.listCompare, 'deepEqual');
  assert.equal(parity.sameValue(['Ada', 'Bea'], ['Bea', 'Ada']), false);
  const byText = (rows: Array<{ Name: string }>, dir: 1 | -1) =>
    [...rows].sort((a, b) => (a.Name < b.Name ? -dir : a.Name > b.Name ? dir : 0));
  const byQty = <T extends { Qty: number }>(rows: T[], dir: 1 | -1): T[] =>
    [...rows].sort((a, b) => (a.Qty < b.Qty ? -dir : a.Qty > b.Qty ? dir : 0));
  const names = (rows: Array<{ Name: string }>) => rows.map((row) => row.Name);
  const seed = JSON.parse(readFileSync(path.join(root, 'tests/golden/data-rows.json'), 'utf8')) as {
    form: string;
    rows: Array<{ Name: string; Qty: number; Status: string }>;
  };
  const golden = data.forms.GoldenRow.rows;
  assert.equal(seed.form, 'GoldenRow');
  assert.deepEqual(seed.rows, golden);
  const part = data.forms.FlagRow.rows;
  const qtyNe = golden.filter((row) => row.Qty !== 99);
  const varNeRows = golden.filter((row) => row.Name !== 'Ada' && row.Status === 'Open');
  const expected = {
    'sort.by-asc': names(byText(qtyNe, 1)),
    'sort.by-desc': names(byText(qtyNe, -1)),
    'sort.by-desc-range': byQty(qtyNe, -1).slice(0, 1).map((row) => row.Qty),
    'sort.foreach-desc': `${names(byText(qtyNe, -1)).join(',')},`,
    'criteria.bare-and': names(byText(part.filter((row) => row.Status === 'Open' && row.Billable && row.Approved), 1)),
    'criteria.bare-false': names(byText(part.filter((row) => row.Qty !== 99 && row.Billable === false), 1)),
    'criteria.var-ne': names(byQty(varNeRows, 1)),
    'getall.bare-field': names(byText(part.filter((row) => row.Billable), 1)),
  };
  assert.equal(Object.keys(expected).length, 8);
  assert.equal(cases.filter((entry) => entry.residual).length, 8);
  assert.notDeepEqual(expected['sort.by-desc-range'], [qtyNe[0]?.Qty]);
  assert.notDeepEqual(expected['criteria.var-ne'], names(varNeRows));
  assert.notDeepEqual(expected['getall.bare-field'], names(part.filter((row) => row.Billable)));
  assert.deepEqual(data.expected, expected);
  assert.equal(typeof data.dropped['criteria.left-member'], 'string');
  assert.match(data.dropped['criteria.member-rhs'] ?? '', /dropped: does not save in Creator/);
  const ids = new Set(cases.map((entry) => entry.id));
  assert.equal(ids.has('criteria.left-member'), false);
  assert.equal(ids.has('criteria.member-rhs'), false);
  const scripts = new Map(cases.map((entry) => [entry.id, entry.script]));
  for (const id of Object.keys(expected)) {
    assert.equal(ids.has(id), true, id);
    assert.equal(scripts.has(id), true, id);
  }
  assert.match(scripts.get('sort.by-desc-range') ?? '', /sort by Qty desc range from 1 to 1/);
  assert.match(scripts.get('sort.by-desc-range') ?? '', /\.Qty\.getAll\(\)/);
  assert.match(scripts.get('criteria.var-ne') ?? '', /sort by Qty/);
  assert.match(scripts.get('criteria.bare-and') ?? '', /FlagRow\[Status == "Open" && Billable && Approved\] sort by Name/);
  assert.match(scripts.get('criteria.bare-false') ?? '', /Billable == false/);
  assert.match(scripts.get('getall.bare-field') ?? '', /FlagRow\[Billable == true\] sort by Name/);
  assert.equal([...scripts.values()].some((script) => script.includes('.ID')), false);
  assert.equal([...scripts.values()].some((script) => /who\s*==\s*who\.ID/.test(script)), false);
  const csv = (rel: string) => readFileSync(path.join(root, rel), 'utf8').trim().split('\n');
  const goldenCsv = csv(data.forms.GoldenRow.csv);
  assert.deepEqual(goldenCsv, ['Name,Qty,Status', 'Ada,2,Open', 'Bea,0,Open', 'Ada,5,Hold', 'Cy,-1,Open']);
  const partCsv = csv(data.forms.FlagRow.csv);
  assert.deepEqual(partCsv, [
    'Name,Qty,Status,Billable,Approved',
    'Cy,5,Hold,true,true',
    'Ada,2,Open,true,true',
    'Bea,0,Open,true,false',
    'Dee,1,Open,false,true',
  ]);
  const shape = JSON.parse(readFileSync(path.join(root, 'tests/golden/criteria-submit.shape.json'), 'utf8')) as Record<
    string,
    { parts?: number; message?: string; from?: string; to?: string }
  >;
  for (const id of [
    'task.cancel.delete',
    'task.success.literal',
    'task.success.literal-expr',
    'task.success.expr-literal',
    'task.success.three-part',
    'task.success.five-part',
    'task.sendmail.submit',
  ]) {
    assert.equal(typeof shape[id], 'object', id);
    assert.equal(ids.has(id), false, id);
  }
  assert.equal(shape['task.success.three-part']?.parts, 3);
  assert.equal(shape['task.success.three-part']?.message, 'c2c Zed saved');
  assert.equal(shape['task.success.five-part']?.parts, 5);
  assert.equal(shape['task.success.five-part']?.message, 'c2c Zed qty 1 ok');
  assert.equal(shape['task.sendmail.submit']?.from, 'zoho.adminuserid');
  assert.equal(shape['task.sendmail.submit']?.to, 'zoho.adminuserid');
  const ds = readFileSync(path.join(root, 'tests/golden/c2c-golden.ds'), 'utf8');
  assert.equal(ds.includes('cancel delete'), false);
  assert.equal(ds.includes('success message'), false);
});

test('the sendmail submit shape pastes its own body', () => {
  const shape = JSON.parse(readFileSync(path.join(root, 'tests/golden/criteria-submit.shape.json'), 'utf8')) as {
    'task.sendmail.submit': { message: string; body: string; paste: string };
  };
  const expected = shape['task.sendmail.submit'];
  assert.equal(expected.body, 'c2c submit sendmail test');
  assert.equal(expected.message, expected.body);
  assert.equal(
    expected.paste,
    `sendmail [ from: zoho.adminuserid to: zoho.adminuserid subject: "c2c-golden-submit" message: "${expected.body}" ];`,
  );
});

test('submit parity cases are pending until captured into submit.json', async (t) => {
  const bundle = parity.loadVectorBundle();
  const { cases: vectors } = vectorStatus(bundle.text, BOOL_CAPTURE_ARTIFACTS);
  const shapes = JSON.parse(readFileSync(path.join(root, 'tests/golden/criteria-submit.shape.json'), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [id, shape] of Object.entries(shapes)) {
    if (!Object.prototype.hasOwnProperty.call(vectors, id)) {
      await t.test(id, { todo: 'pending Creator submit capture' }, async () => {});
      continue;
    }
    await t.test(id, async () => {
      const got = (await parity.evaluateSubmit(id, shape)) as Record<string, unknown>;
      const captured = parity.submitCapturedView(vectors[id], Object.keys(got));
      assert.deepEqual(got, captured, `${id} shim output differs from the Creator capture`);
    });
  }
});
