/**
 * `c2c status --project <id>`: read-only project health — functions with
 * their last deploy time, the Slate URL, the Data Store table count (compared
 * against --table-budget only when one is passed), and recent function errors
 * when the log read answers.
 * Anything a read cannot answer becomes a one-line console checklist step,
 * never a stack. --fake runs the same path against a built-in fake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeStatusRest, formatStatus, readStatus, statusArgsProblem, statusAsJson, statusCli, statusTableNamesOf } from '../src/status.js';
import type { Io } from '../src/cli.js';
import type { RestCall, RestFn } from '../src/tables.js';

const PROJECT_ID = '1000000000000123';

function captureRest(rest: RestFn): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('no network');
    },
    rest,
  };
  return { io, out, err };
}

test('statusArgsProblem needs --project', () => {
  assert.match(statusArgsProblem([]) ?? '', /--project/);
  assert.match(statusArgsProblem(['--project', PROJECT_ID]) ?? '', /--org/);
  assert.equal(statusArgsProblem(['--project', PROJECT_ID, '--fake']), undefined);
  assert.equal(statusArgsProblem(['--project', PROJECT_ID, '--org', '10000000000']), undefined);
});

test('fake status reports functions, slate url, table count and log errors', async () => {
  const { io, out } = captureRest(fakeStatusRest());
  const code = await statusCli(['--project', PROJECT_ID, '--fake'], io);
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /functions/);
  assert.match(text, /c2c_api/);
  assert.match(text, /slate/i);
  assert.match(text, /onslate\.in/);
  assert.match(text, /tables: 3 org tables/);
  assert.ok(!text.includes('OVER BUDGET'));
});

test('readStatus parses the fake report and the JSON round-trips', async () => {
  const report = await readStatus(fakeStatusRest(), PROJECT_ID);
  assert.equal(report.projectId, PROJECT_ID);
  assert.ok(report.functions.items.length >= 1);
  assert.ok(report.functions.items[0]?.deployedAt);
  assert.ok((report.tables.projectTables ?? 0) > 0);
  assert.equal(report.tables.budget, undefined);
  assert.ok(report.slate.apps.some((app) => app.url?.includes('onslate.in')));
  assert.ok(report.logs.errors.length >= 1);
  assert.equal(report.ok, true);
  const parsed = JSON.parse(statusAsJson(report)) as { projectId: string };
  assert.equal(parsed.projectId, PROJECT_ID);
  assert.match(formatStatus(report), /c2c_api/);
  assert.ok(!formatStatus(report).match(/checklist/i));
});

test('unanswered reads become console checklist steps, exit 1', async () => {
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    if (call.path === `/baas/v1/project/${PROJECT_ID}`) {
      return { status: 200, body: { data: { id: PROJECT_ID, project_name: 'c2c-widget', org_id: '10000000000' } } };
    }
    return { status: 404, body: {} };
  };
  const { io, out } = captureRest(rest);
  const code = await statusCli(['--project', PROJECT_ID, '--org', '10000000000'], io);
  assert.equal(code, 1);
  const text = out.join('');
  assert.match(text, /console/i);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('status refuses to write: every call is a GET', async () => {
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    return { status: 404, body: {} };
  };
  await readStatus(rest, PROJECT_ID);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

const OTHER_PROJECT = '1000000000000456';
const OTHER_ORG = '10000000001';

/** A fully answering project whose logs carry no error lines. */
function healthyRest(): RestFn {
  return async (call) => {
    if (call.path === `/baas/v1/project/${OTHER_PROJECT}`) {
      return { status: 200, body: { data: { id: OTHER_PROJECT, project_name: 'c2c-widget', environment: 'Development', org_id: OTHER_ORG } } };
    }
    if (call.path === `/baas/v1/project/${OTHER_PROJECT}/function`) {
      return { status: 200, body: { data: [{ function_id: '2000000000000101', function_name: 'c2c_api', last_deployed: '2026-10-08T09:15:00Z' }] } };
    }
    if (call.path === `/baas/v1/project/${OTHER_PROJECT}/table`) {
      return { status: 200, body: { data: [{ table_name: 'Vendor' }] } };
    }
    if (call.path === `/slate/v1/project/${OTHER_PROJECT}/app`) {
      return { status: 200, body: { data: [{ id: '3000000000000123', name: 'c2c-widget', domain: 'c2c-widget-abc123.onslate.in' }] } };
    }
    if (call.path.startsWith(`/baas/v1/project/${OTHER_PROJECT}/logs`)) {
      return { status: 200, body: { data: [{ severity: 'info', message: 'Execution started' }] } };
    }
    return { status: 404, body: {} };
  };
}

function bareIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('no network');
    },
  };
  return { io, out, err };
}

test('tables print the count alone until --table-budget is passed', async () => {
  const report = await readStatus(fakeStatusRest(), PROJECT_ID);
  assert.equal(report.tables.projectTables, 3);
  assert.equal(report.tables.budget, undefined);
  const plain = formatStatus(Object.assign({}, report, { fake: false }));
  assert.match(plain, /tables: 3 org tables/);
  assert.ok(!plain.includes(' of '));
  assert.ok(!plain.includes('OVER BUDGET'));
  const budgeted = formatStatus(Object.assign({}, report, { tables: { ...report.tables, budget: 2 }, fake: false }));
  assert.match(budgeted, /tables: 3 of 2 org tables OVER BUDGET/);
});

test('--table-budget compares the count and refuses a non-number', async () => {
  const over = bareIo();
  const overCode = await statusCli(['--project', PROJECT_ID, '--fake', '--table-budget', '2'], over.io);
  assert.equal(overCode, 0);
  assert.match(over.out.join(''), /tables: 3 of 2 org tables OVER BUDGET/);
  const under = bareIo();
  const underCode = await statusCli(['--project', PROJECT_ID, '--fake', '--table-budget', '99'], under.io);
  assert.equal(underCode, 0);
  assert.ok(!under.out.join('').includes('OVER BUDGET'));
  const bad = bareIo();
  assert.equal(await statusCli(['--project', PROJECT_ID, '--fake', '--table-budget', 'lots'], bad.io), 2);
});

test('--fake text is labelled on the first line', async () => {
  const { io, out } = bareIo();
  const code = await statusCli(['--project', PROJECT_ID, '--fake'], io);
  assert.equal(code, 0);
  assert.equal(out.join('').split('\n')[0], 'FAKE DATA (demo mode): not your project');
});

test('--fake --json carries "fake": true', async () => {
  const { io, out } = bareIo();
  const code = await statusCli(['--project', PROJECT_ID, '--fake', '--json'], io);
  assert.equal(code, 0);
  const parsed = JSON.parse(out.join('')) as { fake: unknown };
  assert.equal(parsed.fake, true);
});

test('zero log errors is healthy: exit 0 with no checklist step', async () => {
  const { io, out } = captureRest(healthyRest());
  const code = await statusCli(['--project', OTHER_PROJECT, '--org', OTHER_ORG], io);
  assert.equal(code, 0);
  assert.ok(!out.join('').match(/checklist/i));
});

test('tables without a name key still count', () => {
  assert.equal(statusTableNamesOf({ data: [{ id: '11' }, { id: '22' }] }).length, 2);
  assert.equal(statusTableNamesOf({ data: [{ table_name: 'Vendor' }, { id: '22' }] }).length, 2);
});

test('a project outside the guarded org is refused', async () => {
  const rest: RestFn = async (call) => {
    if (call.path === `/baas/v1/project/${OTHER_PROJECT}`) {
      return { status: 200, body: { data: { id: OTHER_PROJECT, org_id: '10000000002' } } };
    }
    return { status: 404, body: {} };
  };
  const { io } = captureRest(rest);
  await assert.rejects(statusCli(['--project', OTHER_PROJECT, '--org', OTHER_ORG], io), /guarded org and project/);
});

test('--fake answers for any project id', async () => {
  const { io, out } = bareIo();
  const code = await statusCli(['--project', OTHER_PROJECT, '--fake'], io);
  assert.equal(code, 0);
  assert.match(out.join(''), /c2c_api/);
});
