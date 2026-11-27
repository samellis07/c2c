import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkApp,
  checkGuide,
  countStatuses,
  DEFAULT_FIXTURES,
  humanSteps,
  loadAppInputs,
  loadGuideInputs,
  MAX_HUMAN_STEPS,
  onboardingReadiness,
  onboardingReadinessAsJson,
  onboardingReadinessAsMarkdown,
  type AppInputs,
  type CriterionResult,
  type GuideInputs,
} from '../src/onboarding-readiness.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const kitchenSink = 'synthetic/kitchen-sink/kitchen_sink';

const fresh = (id = kitchenSink): Promise<AppInputs> => loadAppInputs(root, { id, file: join(root, 'fixtures', `${id}.ds`) });
const status = (criteria: readonly CriterionResult[], id: string) => {
  const found = criteria.find((item) => item.id === id);
  assert.ok(found, `criterion ${id} present`);
  return found;
};

test('the default run covers the library and kitchen-sink exports with the same criteria, offline and byte-identical', async () => {
  const first = await onboardingReadiness(root);
  const second = await onboardingReadiness(root);
  assert.deepEqual(first.apps.map((app) => app.fixture), [...DEFAULT_FIXTURES]);
  assert.equal(onboardingReadinessAsJson(first), onboardingReadinessAsJson(second));
  assert.equal(onboardingReadinessAsMarkdown(first), onboardingReadinessAsMarkdown(second));
  const ids = first.apps[0]!.criteria.map((item) => item.id);
  for (const app of first.apps) assert.deepEqual(app.criteria.map((item) => item.id), ids);
  assert.equal(new Set(ids).size, ids.length);
  const all = [...first.apps.flatMap((app) => app.criteria), ...first.guide];
  for (const item of all) {
    assert.ok(['PASS', 'FAIL', 'GAP'].includes(item.status), item.id);
    assert.ok(item.detail.trim().length > 0, `${item.id} names its reason`);
  }
  assert.equal(first.counts.PASS + first.counts.FAIL + first.counts.GAP, all.length);
  // What c2c already does holds on both apps.
  for (const app of first.apps) {
    for (const id of [
      'report-todos-match-analyze',
      'report-manual-steps-match-precheck',
      'report-lists-field-gaps',
      'report-lists-converted',
      'report-carries-workaround',
      'report-lists-human-steps',
      'report-deterministic',
      'report-golden-current',
      'guide-offline-steps-run',
    ]) {
      assert.equal(status(app.criteria, id).status, 'PASS', `${app.fixture} ${id}`);
    }
    // A live-only or not-yet-built criterion is a GAP, never a PASS.
    for (const id of ['guide-live-steps-run', 'non-developer-under-one-day']) {
      assert.equal(status(app.criteria, id).status, 'GAP', `${app.fixture} ${id}`);
    }
  }
});

test('a GAP is never counted as a pass', () => {
  const counts = countStatuses([{ fixture: 'x', app: null, criteria: [{ id: 'a', title: 'a', status: 'GAP', detail: 'not built' }] }], []);
  assert.deepEqual(counts, { PASS: 0, FAIL: 0, GAP: 1 });
});

test('a report that drops a TODO kind fails the analyze comparison', async () => {
  const base = await fresh();
  // The fixture may convert with no TODOs, so give analyze and the report the same extra kind first.
  const kind = { construct: 'sample-unconverted-construct', count: 2 };
  const { analysis, report } = base;
  const inputs: AppInputs = {
    ...base,
    analysis: {
      ...analysis,
      determinism: { ...analysis.determinism, todoCount: analysis.determinism.todoCount + kind.count, todoKinds: [...analysis.determinism.todoKinds, kind] },
    },
    report: { ...report, todoCount: report.todoCount + kind.count, todoKinds: [...report.todoKinds, kind] },
  };
  assert.equal(status(checkApp(inputs).criteria, 'report-todos-match-analyze').status, 'PASS');
  const broken = { ...inputs, report: { ...inputs.report, todoKinds: inputs.report.todoKinds.filter((item) => item.construct !== kind.construct) } };
  assert.equal(status(checkApp(broken).criteria, 'report-todos-match-analyze').status, 'FAIL');
  const miscounted = { ...inputs, report: { ...inputs.report, todoCount: inputs.report.todoCount + 1 } };
  assert.equal(status(checkApp(miscounted).criteria, 'report-todos-match-analyze').status, 'FAIL');
});

test('a report that drops or miscounts a precheck finding fails the manual-steps comparison', async () => {
  const inputs = await fresh();
  assert.ok(inputs.report.manualSteps.length > 0);
  const dropped = { ...inputs, report: { ...inputs.report, manualSteps: inputs.report.manualSteps.slice(1) } };
  assert.equal(status(checkApp(dropped).criteria, 'report-manual-steps-match-precheck').status, 'FAIL');
  const [first, ...rest] = inputs.report.manualSteps;
  const miscounted = { ...inputs, report: { ...inputs.report, manualSteps: [{ ...first!, count: first!.count + 1 }, ...rest] } };
  assert.equal(status(checkApp(miscounted).criteria, 'report-manual-steps-match-precheck').status, 'FAIL');
});

test('a report that drops or misrenders a field gap fails the field-gap check', async () => {
  const inputs = await fresh();
  assert.ok(inputs.analysis.fieldGaps.length > 0);
  const dropped = { ...inputs, report: { ...inputs.report, fieldGaps: inputs.report.fieldGaps.slice(1) } };
  assert.equal(status(checkApp(dropped).criteria, 'report-lists-field-gaps').status, 'FAIL');
  const unlisted = { ...inputs, reportMd: inputs.reportMd.replace(/^- [a-z-]+: \d+/m, '- changed-row: 1') };
  assert.equal(status(checkApp(unlisted).criteria, 'report-lists-field-gaps').status, 'FAIL');
});

test('a report that miscounts the generated Catalyst resources fails the converted check', async () => {
  const inputs = await fresh();
  const wrong = {
    ...inputs,
    report: { ...inputs.report, converted: { ...inputs.report.converted, catalyst: { ...inputs.report.converted.catalyst, tables: inputs.report.converted.catalyst.tables + 1 } } },
  };
  assert.equal(status(checkApp(wrong).criteria, 'report-lists-converted').status, 'FAIL');
  const unlisted = { ...inputs, reportMd: inputs.reportMd.split('Data Store table').join('storage entity') };
  assert.equal(status(checkApp(unlisted).criteria, 'report-lists-converted').status, 'FAIL');
});

test('a markdown report that drops a workaround or a console step fails', async () => {
  const inputs = await fresh();
  const step = inputs.report.manualSteps.find((item) => item.workaround?.trim()) ?? inputs.report.fieldGaps[0]!;
  const withoutFix = { ...inputs, reportMd: inputs.reportMd.split((step as { workaround?: string; reason?: string }).workaround ?? (step as { reason: string }).reason).join('') };
  assert.equal(status(checkApp(withoutFix).criteria, 'report-carries-workaround').status, 'FAIL');
  const consoleId = inputs.plan.steps.find((item) => item.via === 'console' && !['sign-in-check', 'mail-sender'].includes(item.id))!.id;
  const withoutStep = { ...inputs, reportMd: inputs.reportMd.split(consoleId).join('gone') };
  assert.equal(status(checkApp(withoutStep).criteria, 'report-lists-human-steps').status, 'FAIL');
});

test('an unsupported item without workaround text fails', async () => {
  const inputs = await fresh();
  const [finding, ...rest] = inputs.precheck.findings;
  const broken = { ...inputs, precheck: { ...inputs.precheck, findings: [{ ...finding!, fix: '  ' }, ...rest] } };
  const result = status(checkApp(broken).criteria, 'unsupported-has-workaround');
  assert.equal(result.status, 'FAIL');
  assert.match(result.detail, new RegExp(`precheck ${finding!.check}`));
});

test('a stale or missing golden fails', async () => {
  const inputs = await fresh();
  assert.equal(status(checkApp({ ...inputs, golden: { ...inputs.golden, md: `${inputs.golden.md}x` } }).criteria, 'report-golden-current').status, 'FAIL');
  assert.equal(status(checkApp({ ...inputs, golden: {} }).criteria, 'report-golden-current').status, 'FAIL');
});

test('a gallery fixture without the private golden directory reports the golden check as not run, never as a failure', async () => {
  const inputs = await fresh();
  const missingDir = checkApp({ ...inputs, golden: {}, goldenDirMissing: true }).criteria;
  assert.equal(status(missingDir, 'report-golden-current').status, 'GAP');
  assert.match(status(missingDir, 'report-golden-current').detail, /not run/);
  // With the directory configured, a missing golden is still a failure, and a current one still passes.
  assert.equal(status(checkApp({ ...inputs, golden: {} }).criteria, 'report-golden-current').status, 'FAIL');
});

test('two different builds of the same report fail the byte-identity check', async () => {
  const inputs = await fresh();
  assert.equal(status(checkApp({ ...inputs, rebuiltJson: `${inputs.rebuiltJson} ` }).criteria, 'report-deterministic').status, 'FAIL');
});

test('a markdown report without the scope labels fails', async () => {
  const inputs = await fresh();
  assert.equal(status(checkApp({ ...inputs, reportMd: inputs.reportMd.replace('## Scope', '').replace(/^- .* — not .*$/gm, '') }).criteria, 'report-lists-scope').status, 'FAIL');
});

test('human steps fold to Connect Catalyst, invite and sign-in, the in-app check, and one review step', () => {
  const plan = {
    steps: [
      { id: 'cloudscale-enable', via: 'console', command: 'open Cloud Scale' },
      { id: 'stratus-enable', via: 'console' },
      { id: 'smartbrowz-enable', via: 'console' },
      { id: 'sign-in-check', via: 'console' },
      { id: 'mail-sender', via: 'console' },
      { id: 'tables', via: 'mcp' },
    ],
    connectionSecretKeys: ['API_KEY'],
  };
  const steps = humanSteps(plan, 3);
  assert.deepEqual(steps.map((step) => step.split(':')[0]), ['Connect Catalyst', 'Accept invite and sign in once', 'Run the in-app check and paste its code', 'Review 3 counted items']);
  for (const named of ['c2c doctor', 'cloudscale-enable — open Cloud Scale', 'stratus-enable', 'smartbrowz-enable', 'verify mail sender', 'API_KEY']) {
    assert.ok(steps[0]!.includes(named), `Connect Catalyst names ${named}`);
  }
  assert.deepEqual(humanSteps({ steps: [], connectionSecretKeys: [] }, 0).length, 3, 'no review step without counted items');
  assert.match(humanSteps({ steps: [], connectionSecretKeys: [] }, 1)[3]!, /^Review 1 counted item:/);
});

test('the worst case stays within the step limit, and a failed plan fails both plan criteria', async () => {
  const inputs = await fresh();
  const worst = { ...inputs, plan: { ...inputs.plan, connectionSecretKeys: ['API_KEY'], steps: ['cloudscale-enable', 'stratus-enable', 'smartbrowz-enable', 'mail-sender'].map((id) => ({ id, via: 'console' })) } };
  assert.equal(humanSteps(worst.plan, 40).length, MAX_HUMAN_STEPS);
  assert.equal(status(checkApp(worst).criteria, 'human-steps-within-limit').status, 'PASS');
  const failed = checkApp({ ...inputs, plan: { ...inputs.plan, code: 1, files: [], stderr: 'c2c plan: boom\n' } });
  assert.equal(status(failed.criteria, 'human-steps-within-limit').status, 'FAIL');
  assert.equal(status(failed.criteria, 'guide-offline-steps-run').status, 'FAIL');
});

test('the review checklist carries every counted TODO and every silent drop, each with reason and step', async () => {
  const inputs = await fresh();
  const items = inputs.report.reviewChecklist ?? [];
  assert.equal(items.length, inputs.analysis.determinism.todoCount + inputs.analysis.determinism.silentDrops);
  assert.ok(items.length > 0);
  for (const item of items) for (const key of ['where', 'reason', 'step'] as const) assert.ok(item[key].trim(), `${item.where}: ${key}`);
  assert.ok(inputs.report.humanSteps.some((step) => step.startsWith(`Review ${items.length} counted item`)));
  for (const item of items) assert.ok(inputs.reportMd.includes(item.step), `${item.where}: step in the markdown`);
});

test('the guide checks fail on an unknown command, a broken link and an unnamed checklist step', () => {
  const real = loadGuideInputs(root);
  for (const item of checkGuide(real)) assert.equal(item.status, 'PASS', `${item.id}: ${item.detail}`);
  const withPage = (text: string): GuideInputs => ({ ...real, pages: [...real.pages, { path: 'docs/guide/99-extra.md', text }] });
  assert.equal(status(checkGuide(withPage('Run `c2c teleport` now.')), 'guide-commands-exist').status, 'FAIL');
  const link = status(checkGuide(withPage('See [gone](../missing-page.md).')), 'guide-links-resolve');
  assert.equal(link.status, 'FAIL');
  assert.match(link.detail, /docs\/guide\/99-extra\.md -> \.\.\/missing-page\.md/);
  const unnamed = { ...real, pages: real.pages.map((page) => ({ ...page, text: page.text.replace(/^(#+ .*)invite/gim, '$1') })) };
  assert.equal(status(checkGuide(unnamed), 'guide-names-checklist').status, 'FAIL');
});

test('every silent drop is a guided residual item, and a dropped or empty item fails', async () => {
  const inputs = await fresh();
  const drops = inputs.analysis.determinism.silentDrops;
  assert.ok(drops > 0, 'kitchen-sink has silent drops to guide');
  assert.equal(inputs.report.residuals?.length, drops);
  assert.equal(inputs.analysis.determinism.deterministic, false, 'guided drops are still drops');
  assert.equal(status(checkApp(inputs).criteria, 'report-no-silent-item').status, 'PASS');
  const [first, ...rest] = inputs.report.residuals ?? [];
  const missing = { ...inputs, report: { ...inputs.report, residuals: rest } };
  assert.equal(status(checkApp(missing).criteria, 'report-no-silent-item').status, 'FAIL');
  const empty = { ...inputs, report: { ...inputs.report, residuals: [{ ...first!, step: ' ' }, ...rest] } };
  const result = status(checkApp(empty).criteria, 'report-no-silent-item');
  assert.equal(result.status, 'FAIL');
  assert.match(result.detail, /empty step/);
  const hidden = { ...inputs, report: { ...inputs.report, silentDrops: 0 } };
  assert.equal(status(checkApp(hidden).criteria, 'report-no-silent-item').status, 'FAIL');
  const unlisted = { ...inputs, reportMd: inputs.reportMd.split(first!.step).join('') };
  assert.equal(status(checkApp(unlisted).criteria, 'report-no-silent-item').status, 'FAIL');
});
