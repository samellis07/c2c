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
    for (const id of ['report-todos-match-analyze', 'report-manual-steps-match-precheck', 'report-deterministic', 'report-golden-current', 'guide-offline-steps-run']) {
      assert.equal(status(app.criteria, id).status, 'PASS', `${app.fixture} ${id}`);
    }
    // A live-only or not-yet-built criterion is a GAP, never a PASS.
    for (const id of ['report-lists-converted', 'guide-live-steps-run', 'non-developer-under-one-day']) {
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

test('two different builds of the same report fail the byte-identity check', async () => {
  const inputs = await fresh();
  assert.equal(status(checkApp({ ...inputs, rebuiltJson: `${inputs.rebuiltJson} ` }).criteria, 'report-deterministic').status, 'FAIL');
});

test('a markdown report without the scope labels fails', async () => {
  const inputs = await fresh();
  assert.equal(status(checkApp({ ...inputs, reportMd: inputs.reportMd.replace('## Scope', '').replace(/^- .* — not .*$/gm, '') }).criteria, 'report-lists-scope').status, 'FAIL');
});

test('human steps count the checklist once and console steps that are a separate visit', () => {
  const steps = humanSteps({
    steps: [
      { id: 'cloudscale-enable', via: 'console' },
      { id: 'sign-in-check', via: 'console' },
      { id: 'mail-sender', via: 'console' },
      { id: 'tables', via: 'mcp' },
    ],
    connectionSecretKeys: [],
  });
  assert.deepEqual(steps.map((step) => step.split(':')[0]), ['Accept invite', 'Sign in once', 'Run the in-app check and paste its code', 'Verify mail sender', 'console']);
});

test('more than the step limit fails, the limit passes, and a failed plan fails both plan criteria', async () => {
  const inputs = await fresh();
  const over = { ...inputs, plan: { ...inputs.plan, steps: [{ id: 'cloudscale-enable', via: 'console' }, { id: 'stratus-enable', via: 'console' }] } };
  assert.equal(humanSteps(over.plan).length, MAX_HUMAN_STEPS + 1);
  assert.equal(status(checkApp(over).criteria, 'human-steps-within-limit').status, 'FAIL');
  const within = { ...inputs, plan: { ...inputs.plan, steps: [{ id: 'cloudscale-enable', via: 'console' }] } };
  assert.equal(humanSteps(within.plan).length, MAX_HUMAN_STEPS);
  assert.equal(status(checkApp(within).criteria, 'human-steps-within-limit').status, 'PASS');
  const failed = checkApp({ ...inputs, plan: { ...inputs.plan, code: 1, files: [], stderr: 'c2c plan: boom\n' } });
  assert.equal(status(failed.criteria, 'human-steps-within-limit').status, 'FAIL');
  assert.equal(status(failed.criteria, 'guide-offline-steps-run').status, 'FAIL');
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
