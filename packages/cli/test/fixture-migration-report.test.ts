import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveIr, parse, parseFileWithSidecars } from '../../core/src/index.js';
import { analyze, analyzeAsText } from '../src/analyze.js';
import {
  buildFixtureMigrationReport,
  fixtureMigrationReportAsJson,
  fixtureMigrationReportAsMarkdown,
  listInRepoFixtures,
  migrationReportGoldenDir,
  type FixtureMigrationReport,
} from '../src/fixture-migration-report.js';
import { ownerScope } from '../src/scope-labels.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const goldenDir = migrationReportGoldenDir(root);

/** Published owner scope. A wording change has to edit this list on purpose. */
const EXPECTED_SCOPE = [
  { feature: 'Payments', label: 'not supported in this version (counted)' },
  { feature: 'Offline', label: 'not supported in this version (counted)' },
  { feature: 'Form Email', label: 'not supported in this version (counted)' },
  { feature: 'C8 dialect', label: 'not supported in this version (counted)' },
  { feature: 'Cliq bots', label: 'not supported in this version (counted)' },
  { feature: 'Marketplace publishing', label: 'not applicable (out of scope)' },
  { feature: 'Zia AI builder', label: 'not applicable (out of scope)' },
  { feature: 'On-prem Data Bridge', label: 'not applicable (out of scope)' },
];

function goldenIds(dir: string, prefix: string, out: string[]): void {
  const st = statSync(dir, { throwIfNoEntry: false });
  if (!st) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const child = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(child).isDirectory()) goldenIds(child, rel, out);
    else if (name.endsWith('.json')) out.push(rel.slice(0, -'.json'.length));
  }
}

test('owner-scope labels are exactly the published list', () => {
  assert.deepEqual(ownerScope(), EXPECTED_SCOPE);
  const supported = EXPECTED_SCOPE.filter((item) => item.label === 'not supported in this version (counted)').map((item) => item.feature);
  const absent = EXPECTED_SCOPE.filter((item) => item.label === 'not applicable (out of scope)').map((item) => item.feature);
  assert.deepEqual(supported, ['Payments', 'Offline', 'Form Email', 'C8 dialect', 'Cliq bots']);
  assert.deepEqual(absent, ['Marketplace publishing', 'Zia AI builder', 'On-prem Data Bridge']);
  assert.equal(new Set(EXPECTED_SCOPE.map((item) => item.label)).size, 2);
});

test('every in-repo fixture has a migration-report golden, and nothing else', () => {
  const fixtures = listInRepoFixtures(root);
  assert.ok(fixtures.length > 0);
  const ids = fixtures.map((fixture) => fixture.id);
  const committed: string[] = [];
  goldenIds(goldenDir, '', committed);
  committed.sort();
  assert.deepEqual(committed, [...ids].sort());
  for (const fixture of fixtures) {
    const report = buildFixtureMigrationReport(fixture);
    const base = join(goldenDir, fixture.id);
    assert.equal(fixtureMigrationReportAsJson(report), readFileSync(`${base}.json`, 'utf8'), fixture.id);
    assert.equal(fixtureMigrationReportAsMarkdown(report), readFileSync(`${base}.md`, 'utf8'), fixture.id);
    const parsed = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as FixtureMigrationReport;
    assert.deepEqual(parsed.scope, EXPECTED_SCOPE, fixture.id);
    assert.equal(parsed.todoCount, report.todoKinds.reduce((sum, kind) => sum + kind.count, 0), fixture.id);
    const markdown = readFileSync(`${base}.md`, 'utf8');
    for (const item of EXPECTED_SCOPE) assert.ok(markdown.includes(`- ${item.feature} — ${item.label}`), `${fixture.id} ${item.feature}`);
  }
});

test('a rewritten payments label does not match the committed report', () => {
  const fixture = listInRepoFixtures(root)[0];
  assert.ok(fixture);
  const report = buildFixtureMigrationReport(fixture);
  const tampered: FixtureMigrationReport = {
    ...report,
    scope: report.scope.map((item) => (item.feature === 'Payments' ? { ...item, label: 'not applicable (out of scope)' } : item)),
  };
  const golden = readFileSync(join(goldenDir, `${fixture.id}.json`), 'utf8');
  assert.notEqual(fixtureMigrationReportAsJson(tampered), golden);
  assert.equal(tampered.scope[0]?.label, 'not applicable (out of scope)');
  assert.equal(report.scope[0]?.label, 'not supported in this version (counted)');
});

test('not-applicable areas do not add gaps, TODOs, or a score change', () => {
  const source = 'application "ScopeFixture" { }';
  const baseline = analyze(deriveIr(parse(source)));
  const marked = deriveIr(parse(source));
  marked.unknown = [
    { context: 'application', keyword: 'marketplace publishing', cstKind: 'statement', span: { start: 0, end: 0 }, text: 'marketplace publishing' },
    { context: 'application', keyword: 'Zia AI builder', cstKind: 'statement', span: { start: 0, end: 0 }, text: 'Zia AI builder' },
    { context: 'application', keyword: 'on-prem Data Bridge', cstKind: 'statement', span: { start: 0, end: 0 }, text: 'on-prem Data Bridge' },
  ];
  const report = analyze(marked);
  assert.deepEqual(report.features.scope, EXPECTED_SCOPE);
  assert.equal(report.score.readiness, baseline.score.readiness);
  assert.deepEqual(report.features.counts, baseline.features.counts);
  assert.equal(report.deluge.todo, 0);
  assert.deepEqual(report.blockers, []);
});

test('counted roadmap areas still count as feature uses', () => {
  const source = 'application "ScopeFixture" { }';
  const baseline = analyze(deriveIr(parse(source)));
  const marked = deriveIr(parse(source));
  marked.forms.push({
    name: 'Order',
    properties: [],
    fields: [],
    actions: [],
    blocks: [{ name: 'enable payment', properties: [], blocks: [], items: [], span: { start: 0, end: 0 } }],
    span: { start: 0, end: 0 },
  });
  const report = analyze(marked);
  assert.deepEqual(report.features.scope, EXPECTED_SCOPE);
  const payments = report.features.used.filter((item) => item.feature.startsWith('Payment'));
  assert.ok(payments.length > 0);
  assert.notDeepEqual(report.features.counts, baseline.features.counts);
});

test('analyze prints the same scope labels and does not fold them into the score', () => {
  const fixture = listInRepoFixtures(root).find((item) => item.id.endsWith('library_application'));
  assert.ok(fixture);
  const ir = parseFileWithSidecars(fixture.file).ir;
  const report = analyze(ir);
  assert.deepEqual(report.features.scope, EXPECTED_SCOPE);
  const text = analyzeAsText(report);
  assert.match(text, /scope: Payments — not supported in this version \(counted\)/);
  assert.match(text, /scope: Form Email — not supported in this version \(counted\)/);
  assert.match(text, /scope: C8 dialect — not supported in this version \(counted\)/);
  assert.match(text, /scope: Marketplace publishing — not applicable \(out of scope\)/);
  const golden = JSON.parse(readFileSync(join(root, 'packages/cli/test/golden/library-application-system.analyze.json'), 'utf8')) as {
    features: { scope: unknown };
    score: { readiness: number };
  };
  assert.deepEqual(golden.features.scope, EXPECTED_SCOPE);
  assert.equal(golden.score.readiness, report.score.readiness);
});
