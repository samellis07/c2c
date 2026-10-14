/**
 * The UX-states gate is non-vacuous: on the current bundle the states it
 * already ships pass, the missing ones come back as
 * expected-fail under their tracked issue, and the scorer's extended checks are
 * measured but do not move the score.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { bundleFromFiles, createFakeApi, scoreUi, type UiScore } from '../src/score.js';
import { OWNER, STATE_OWNER_ISSUES, checkUiStates, type StateVerdict } from '../src/states.js';

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  return `\t\t\t${head}\n\t\t\t(\n\t\t\t\ttype = ${type}\n\t\t\t\tdisplayname = "${name.replace(/_/g, ' ')}"\n${extra}\t\t\t)`;
}

const SOURCE = `application "Order Desk"
{
\tsection Sales
\t{
\t\tform Order
\t\t{
\t\t\tdisplayname = "New Order"
${field('Title', 'text', '', 'must have')}
${field('Qty', 'number')}
\t\t}
\t\tlist All_Orders
\t\t{
\t\t\tdisplayname = "All Orders"
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t\tQty
\t\t\t)
\t\t}
\t}
}
`;

function app(): App {
  return deriveIr(parse(SOURCE));
}

let cached: { bundle: ReturnType<typeof bundleFromFiles>; verdicts: StateVerdict[] } | undefined;

async function run(): Promise<StateVerdict[]> {
  if (!cached) {
    const bundle = bundleFromFiles(buildUi(app()).files);
    cached = { bundle, verdicts: await checkUiStates(app(), bundle, { ui: 'vanilla' }) };
  }
  return cached.verdicts;
}

const byState = (verdicts: StateVerdict[], state: string): StateVerdict | undefined => verdicts.find((v) => v.state === state);

test('the vanilla bundle passes the states it already ships and xfails the rest under their issues', async () => {
  const verdicts = await run();
  const states = verdicts.map((v) => v.state);
  for (const state of ['loading', 'empty', 'error', 'invalid', 'submitting', 'confirm-open', 'row-rollback', 'toast', 'offline', 'session-expired', 'denied', 'not-found', 'crash', 'route-focus', 'reduced-motion']) {
    assert.ok(states.includes(state), `missing verdict row ${state}`);
  }
  // Already shipped on vanilla: loading (skeleton+status), empty with the form
  // action, and error with a working retry. The gate found the retry dead —
  // captureQuery cached [] on a failed answer, so drawList emptied [data-rows]
  // and the retry handler had no tbody; captureQuery now only caches ok
  // responses, so the table survives the error and the retry re-queries.
  for (const state of ['loading', 'empty', 'error']) {
    const v = byState(verdicts, state)!;
    assert.equal(v.status, 'pass', `${state}: ${v.evidence}`);
  }
  // The string-render runtime carries a named waiver for the crash row.
  assert.equal(byState(verdicts, 'crash')!.status, 'waived');
  // Everything a tracked issue owns reports an expected-fail naming the issue.
  for (const [state, issue] of Object.entries({
    'confirm-open': 'ux-confirm-pending',
    submitting: 'ux-confirm-pending',
    toast: 'ux-toasts-field-errors',
    offline: 'ux-offline-session',
    'server-field-error': 'ux-toasts-field-errors',
    invalid: 'ux-toasts-field-errors',
    'session-expired': 'ux-offline-session',
    denied: 'ux-offline-session',
    'not-found': 'ux-loading-empty-not-found',
    'route-focus': 'ux-focus-motion',
  })) {
    const v = byState(verdicts, state);
    assert.ok(v, `no verdict for ${state}`);
    if (v.status === 'skip') continue;
    assert.equal(v.status, 'fail', `${state}: ${v.evidence}`);
    assert.equal(v.issue, issue, `${state}: issue`);
  }
  // Rows vanilla may already satisfy: a pass is fine, a fail must still name
  // its issue.
  for (const [state, issue] of Object.entries({ 'reduced-motion': 'ux-focus-motion', 'empty-filtered': 'ux-loading-empty-not-found', 'row-rollback': 'ux-confirm-pending' })) {
    const v = byState(verdicts, state);
    if (!v || v.status !== 'fail') continue;
    assert.equal(v.issue, issue, `${state}: issue`);
  }
});

test('every xfail owner is a real issue id — a phantom name fails', () => {
  // Only the six listed issues may own a row, so a made-up OWNER value
  // breaks this test.
  for (const [state, issue] of Object.entries(OWNER)) {
    if (issue === '') continue; // '' = unowned baseline (must always pass)
    assert.ok(STATE_OWNER_ISSUES.has(issue), `${state} is owned by "${issue}", not one of ${[...STATE_OWNER_ISSUES].join(', ')}`);
  }
  for (const issue of STATE_OWNER_ISSUES) assert.match(issue, /^(ux|react)-/);
});

test('the scripted API classifies endpoints and records calls', async () => {
  const api = createFakeApi(new Map([['All_Orders', { ROWID: '7', Title: 'Sprocket' }]]), []);
  const get = (res: unknown) => res as { status: number; json(): Promise<unknown> };
  assert.equal((await get(await api.fetch('/reports/All_Orders', { method: 'POST', body: '{}' })).json()) !== undefined, true);
  api.lane.submit = 'field';
  api.fieldError = { field: 'Qty', message: 'no' };
  const denied = await api.fetch('/forms/Order/submit', { method: 'POST', body: '{}' });
  assert.equal((denied as { status: number }).status, 400);
  api.lane.query = 'denied';
  assert.equal((await api.fetch('/reports/All_Orders', { method: 'POST' }) as { status: number }).status, 403);
  api.lane.query = 'unauth';
  assert.equal((await api.fetch('/reports/All_Orders', { method: 'POST' }) as { status: number }).status, 401);
  assert.equal(api.matching('/submit').length, 1);
  assert.equal(api.matching('/reports/').length, 3);
  await assert.rejects(() => {
    api.lane.action = 'reject';
    return api.fetch('/reports/All_Orders/actions/approve', { method: 'POST' });
  }, TypeError);
});

test('the extended states checks are measured but never move the score', async () => {
  const bundle = bundleFromFiles(buildUi(app()).files);
  const result: UiScore = await scoreUi(app(), bundle);
  const extended = result.checks.filter((c) => c.unscored);
  assert.ok(extended.length >= 5, `expected the extended states checks to run, got ${extended.length}`);
  assert.ok(extended.every((c) => c.criterion === 'states'));
  // The unowned baseline checks all still pass — the extension must not have
  // broken the states the app already ships.
  for (const c of result.checks.filter((x) => x.criterion === 'states' && !x.unscored)) {
    assert.ok(c.pass, `${c.id}: ${c.evidence}`);
  }
  assert.ok(result.desktop.score >= 8 && result.phone.score >= 8, `score moved: ${result.desktop.score}/${result.phone.score}`);
});
