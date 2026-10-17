import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { applyFunctionEnvSecrets, buildFunctionEnv, functionIdFromList, liveFunctionVariables } from '../src/function-env.js';
import { provisionFunctionEnvInput, type ProvisionPlanFile } from '../src/provision.js';
import { deployCli, readFunctionEnv } from '../src/cli.js';
import { assertEnvVariablesWithinLimit, ENV_VARIABLES_MAX, envVariables, envVariablesSize, isSecretEnvName, RESERVED_ENV_KEYS, secretEnvValues } from '../src/function-dir.js';
import type { RestCall, RestFn } from '../src/tables.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { parse, deriveIr } from '../../core/src/index.js';
import { formatHumanChecklist, humanChecklist, planCli, provisionCli, type Io } from '../src/index.js';
import { zipStore } from '../src/iac-import.js';

const ORG = '10000000000';
const PROJECT = '1001';

interface Sandbox {
  tables: Array<{ id: string; table_name: string }>;
  roles: Array<{ id: string; role_name: string }>;
}

function emptySandbox(): Sandbox {
  return {
    tables: [{ id: '101', table_name: 'Item' }],
    roles: [
      { id: '1', role_name: 'App Administrator' },
      { id: '2', role_name: 'App User' },
    ],
  };
}

function fakeImportApi(): { fetch: Io['fetch'] } {
  let postedName = '';
  let confirmed = false;
  return {
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET';
      const u = new URL(url);
      if (method === 'POST' && u.pathname === '/baas/v1/project/import') {
        const body = init?.body as unknown;
        const raw = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('latin1') : '';
        postedName = /name="project_name"\r\n\r\n([^\r\n]+)/.exec(raw)?.[1] ?? 'c2c-app';
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ status: 'success', data: { id: 'imp-1' } }),
        };
      }
      if (method === 'GET' && u.pathname.includes('/deploy')) {
        confirmed = true;
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ status: 'success' }),
        };
      }
      if (method === 'GET' && /^\/baas\/v1\/project\/import\/[^/]+$/.test(u.pathname)) {
        return {
          status: 200,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              status: 'success',
              data: {
                id: 'imp-1',
                status: 'Completed',
                project_details: {
                  project_name: postedName,
                  id: PROJECT,
                  project_type: 'Live',
                },
              },
            }),
        };
      }
      return { status: 200, headers: { get: () => null }, text: async () => '{}' };
    },
  };
}

function cap(sandbox?: Sandbox, importFetch?: Io['fetch']): { io: Io; out: () => string; err: () => string } {
  let stdout = '';
  let stderr = '';
  const fakeRest = async (spec: { method: string; path: string; body?: unknown }) => {
    if (spec.method === 'GET' && spec.path === `/baas/v1/project/${PROJECT}`) {
      return { status: 200, body: { data: { id: PROJECT, project_name: 'c2c-widget', org_id: ORG } } };
    }
    if (spec.method === 'GET' && spec.path === `/baas/v1/project/${PROJECT}/table`) {
      return { status: 200, body: { data: sandbox?.tables ?? [{ id: '101', table_name: 'Item' }] } };
    }
    if (spec.method === 'GET' && spec.path.endsWith('/connections')) {
      return { status: 200, body: { data: { connections: [{ link_name: 'my_stripe', display_name: 'Stripe', connected: true }] } } };
    }
    return { status: 200, body: { data: [] } };
  };
  return {
    out: () => stdout,
    err: () => stderr,
    io: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      env: {},
      rest: fakeRest,
      spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
      fetch: importFetch ?? (async () => ({ status: 200, headers: { get: () => null }, text: async () => '{}' })),
      accessToken: async () => 'test-token',
      sleep: async () => {},
    },
  };
}

function writeResult(out: string, stepId: string, result: unknown): string {
  const dir = join(out, 'provision', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stepId}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

const CLEAN_FIXTURE_DS = `/*
 * Author       : synthetic
 * Version      : 1.0
 */
application "WidgetApp"
{
	forms
	{
		form Item
		{
			Name
			(
				type = text
				displayname = "Name"
			)
		}
	}
	reports
	{
		list All_Items
		{
			displayName = "All Items"
			show all rows from Item
			(
				Name as "Name"
			)
		}
	}
}
`;

const CONNECTION_FIXTURE_DS = `/*
 * Author       : synthetic
 * Version      : 1.0
 */
application "PaymentApp"
{
	forms
	{
		form Item
		{
			Name
			(
				type = text
				displayname = "Name"
			)
		}
	}
	reports
	{
		list All_Items
		{
			displayName = "All Items"
			show all rows from Item
			(
				Name as "Name"
			)
		}
	}
	connections
	{
		my_stripe
		(
			displayname = "Stripe"
			connector = custom
			client_secret = "sk_canary_secret_999"
		)
	}
}
`;

function allFilesUnder(dir: string): string[] {
  const result: string[] = [];
  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.push(full);
    }
  }
  walk(dir);
  return result;
}

test('Acceptance 1: a fixture app with no third-party connections ends plan+provision (fake CLI) with zero function-env human items (FAILS on base)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-fenv-clean-'));
  try {
    const dsPath = join(root, 'app.ds');
    writeFileSync(dsPath, CLEAN_FIXTURE_DS);
    const out = join(root, 'c2c-out');

    // Run plan
    const planCap = cap();
    const planCode = await planCli([dsPath, '--out', out, '--dc', 'in'], planCap.io);
    assert.equal(planCode, 0, planCap.err());

    // Run provision to completion
    const api = fakeImportApi();
    const c1 = cap(undefined, api.fetch);
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c1.io), 0, c1.err());

    const sandbox = emptySandbox();
    assert.equal(await provisionCli(['--out', out, '--record', 'cloudscale-enable', '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const c2 = cap(sandbox, api.fetch);
    const code2 = await provisionCli(['--out', out, '--confirm', '--run', 'tables', '--org', ORG, '--dc', 'in'], c2.io);
    if (code2 !== 0) console.error('TABLES ERR:', c2.err());
    assert.equal(code2, 0, c2.err());

    const permsResult = writeResult(out, 'import-table-permissions', { '101': { 'App Administrator': ['SELECT', 'UPDATE', 'INSERT', 'DELETE'], 'App User': [] } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-table-permissions', '--result', permsResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const scopesResult = writeResult(out, 'import-table-scopes', { '101': { 'App Administrator': ['GLOBAL'], 'App User': ['USER'] } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-table-scopes', '--result', scopesResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const secResult = writeResult(out, 'import-security-rule', { c2c_api: { is_authenticated: true } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-security-rule', '--result', secResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    // Check provision status
    const statusCap = cap(sandbox);
    assert.equal(await provisionCli(['--out', out, '--status', '--org', ORG, '--dc', 'in'], statusCap.io), 0, statusCap.err());

    // function-env.json must exist under --out and contain derivable keys
    const fenvPath = join(out, 'function-env.json');
    const fenv = JSON.parse(readFileSync(fenvPath, 'utf8')) as Record<string, string>;

    // Catalyst refuses these names in env_variables: the generated file never carries them.
    for (const reserved of RESERVED_ENV_KEYS) assert.equal(fenv[reserved], undefined, `${reserved} must not be generated`);
    assert.equal(fenv.C2C_ZOHO_DC, 'in');
    assert.ok(fenv.TABLE_ID === '101' || fenv.TABLE_ITEM_ID === '101', 'table id must be autofilled');

    // Human checklist must have ZERO function-env human items
    const statusText = statusCap.out();
    assert.doesNotMatch(statusText, /function-env/i, 'clean app checklist must have zero function-env items');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Acceptance 2: a fixture with one connection yields exactly one checklist item naming the key, with no secret values in output or files outside function-env.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-fenv-conn-'));
  try {
    const dsPath = join(root, 'app.ds');
    writeFileSync(dsPath, CONNECTION_FIXTURE_DS);
    const out = join(root, 'c2c-out');

    // Run plan
    const planCap = cap();
    const planCode = await planCli([dsPath, '--out', out, '--dc', 'in'], planCap.io);
    assert.equal(planCode, 0, planCap.err());

    // Run provision to completion
    const api = fakeImportApi();
    const c1 = cap(undefined, api.fetch);
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'import', '--org', ORG, '--dc', 'in'], c1.io), 0, c1.err());

    const sandbox = emptySandbox();
    assert.equal(await provisionCli(['--out', out, '--record', 'cloudscale-enable', '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const c2 = cap(sandbox, api.fetch);
    assert.equal(await provisionCli(['--out', out, '--confirm', '--run', 'tables', '--org', ORG, '--dc', 'in'], c2.io), 0, c2.err());

    const permsResult = writeResult(out, 'import-table-permissions', { '101': { 'App Administrator': ['SELECT', 'UPDATE', 'INSERT', 'DELETE'], 'App User': [] } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-table-permissions', '--result', permsResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const scopesResult = writeResult(out, 'import-table-scopes', { '101': { 'App Administrator': ['GLOBAL'], 'App User': ['USER'] } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-table-scopes', '--result', scopesResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    // Every app ships a Slate client; its domain and sign-in check close too.
    const inputsPath = join(out, 'provision', 'inputs.json');
    writeFileSync(inputsPath, `${JSON.stringify({ ...JSON.parse(readFileSync(inputsPath, 'utf8')), slateDomain: 'app.example.test' }, null, 2)}\n`);
    const corsResult = writeResult(out, 'authorized-domain', { domains: [{ domain: 'app.example.test', cors: true, iframe: true }] });
    assert.equal(await provisionCli(['--out', out, '--record', 'authorized-domain', '--result', corsResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);
    const signInResult = writeResult(out, 'sign-in-check', { sign_in_page: true });
    assert.equal(await provisionCli(['--out', out, '--record', 'sign-in-check', '--result', signInResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const secResult = writeResult(out, 'import-security-rule', { c2c_api: { is_authenticated: true } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-security-rule', '--result', secResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    // Check provision status
    const statusCap = cap(sandbox);
    assert.equal(await provisionCli(['--out', out, '--status', '--org', ORG, '--dc', 'in'], statusCap.io), 0, statusCap.err());

    // function-env.json must hold the connection secret key
    const fenvPath = join(out, 'function-env.json');
    const fenv = JSON.parse(readFileSync(fenvPath, 'utf8')) as Record<string, string>;
    const secretKey = Object.keys(fenv).find((k) => /STRIPE.*SECRET|MY_STRIPE/i.test(k));
    assert.ok(secretKey, `secret key must be present in function-env.json, got: ${Object.keys(fenv).join(', ')}`);

    // Human checklist must contain EXACTLY ONE item naming the key
    const statusText = statusCap.out();
    const checklistPart = statusText.slice(statusText.indexOf('human checklist:'));
    const checklistLines = checklistPart.split('\n').filter((l) => /^\d+\.\s/.test(l));
    const fenvItems = checklistLines.filter((l) => /function-env/i.test(l) || new RegExp(secretKey, 'i').test(l));
    assert.equal(fenvItems.length, 1, `expected exactly 1 function-env checklist item, got: ${JSON.stringify(fenvItems)}`);
    assert.match(fenvItems[0]!, new RegExp(secretKey, 'i'), 'checklist item must name the key');

    // Security: no secret values in output or files outside function-env.json
    const secretVal = 'sk_canary_secret_999';
    assert.ok(!statusCap.out().includes(secretVal), 'stdout must not contain secret value');
    assert.ok(!statusCap.err().includes(secretVal), 'stderr must not contain secret value');
    assert.ok(!planCap.out().includes(secretVal), 'plan stdout must not contain secret value');
    assert.ok(!planCap.err().includes(secretVal), 'plan stderr must not contain secret value');

    for (const file of allFilesUnder(out)) {
      if (basename(file) === 'function-env.json') continue;
      const content = readFileSync(file, 'utf8');
      assert.ok(!content.includes(secretVal), `file ${file} outside function-env.json must not contain secret value`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Acceptance 3: generated human-step checklist for the 3 RC fixture shapes has <= 4 items, and docs/human-steps.md matches', () => {
  // Shape 1: deterministic (minimal app without mail or slate)
  const shape1 = humanChecklist({ slate: false, sendsMail: false });
  assert.ok(shape1.length <= 4, `deterministic shape must have <= 4 items, got ${shape1.length}`);

  // Shape 2: few TODOs (e.g. standard Slate app without mail)
  const shape2 = humanChecklist({ slate: true, sendsMail: false });
  assert.ok(shape2.length <= 4, `few TODOs shape must have <= 4 items, got ${shape2.length}`);

  // Shape 3: mail + Slate (app with Slate client and mail)
  const shape3 = humanChecklist({ slate: true, sendsMail: true });
  assert.ok(shape3.length <= 4, `mail+Slate shape must have <= 4 items, got ${shape3.length}`);

  // Shape 3 with connection secret: still <= 4 items
  const shape3WithSecret = (humanChecklist as unknown as (input: Record<string, unknown>) => string[])({
    slate: true,
    sendsMail: true,
    connectionSecretKeys: ['MY_STRIPE_CLIENT_SECRET'],
  });
  assert.ok(shape3WithSecret.length <= 4, `mail+Slate+secret shape must have <= 4 items, got ${shape3WithSecret.length}`);
  assert.equal(shape3WithSecret.length, 4);

  // Check docs/human-steps.md matches
  const docsPath = join(repoRoot(), 'docs/human-steps.md');
  const docs = readFileSync(docsPath, 'utf8');
  assert.match(docs, /function-env\.json/i, 'docs/human-steps.md must document function-env.json');
  assert.match(docs, /connection/i, 'docs/human-steps.md must document connection secrets');
});

test('function-env.json is mode 0600 on create and update under umask 022', async () => {
  const { umask } = await import('node:process');
  const { writeOrUpdateFunctionEnv } = await import('../src/function-env.js');
  const root = mkdtempSync(join(tmpdir(), 'c2c-fenv-mode-'));
  const oldUmask = umask(0o022);
  try {
    const createdDir = join(root, 'created');
    const createdPath = join(createdDir, 'function-env.json');
    writeOrUpdateFunctionEnv(createdDir, { projectId: '1001', connectionSecrets: [{ connectionName: 'stripe', propertyKey: 'secret', envKey: 'STRIPE_SECRET', secretValue: 'canary' }] });
    assert.equal(statSync(createdPath).mode & 0o777, 0o600, 'new secret file must be private');
    // Simulate a pre-fix file and confirm an update repairs its permissions.
    const updatedDir = join(root, 'updated');
    const updatedPath = join(updatedDir, 'function-env.json');
    writeOrUpdateFunctionEnv(updatedDir, { projectId: '1001', connectionSecrets: [{ connectionName: 'stripe', propertyKey: 'secret', envKey: 'STRIPE_SECRET', secretValue: 'canary' }] });
    const { chmodSync } = await import('node:fs');
    chmodSync(updatedPath, 0o644);
    writeOrUpdateFunctionEnv(updatedDir, { projectId: '1002' });
    assert.equal(statSync(updatedPath).mode & 0o777, 0o600, 'updated secret file must be private');
  } finally {
    umask(oldUmask);
    rmSync(root, { recursive: true, force: true });
  }
});

const PREFIX = '/baas/v1/project/1001';

function restStub(handlers: (call: RestCall) => { status: number; body: unknown } | undefined): { rest: RestFn; calls: RestCall[] } {
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    return handlers(call) ?? { status: 404, body: {} };
  };
  return { rest, calls };
}

const functionList = { data: [{ function_name: 'c2c_api', function_id: '2001' }, { function_name: 'other', function_id: '2002' }] };

test('isSecretEnvName marks token/secret/key/password/credential names', () => {
  for (const name of ['C2C_OWNER_APPROVAL_TOKEN', 'API_KEY', 'client_secret', 'DB_PASSWORD', 'oauth_credential', 'SERVICE_TOKEN'])
    assert.ok(isSecretEnvName(name), name);
  for (const name of ['DB_PASS', 'PWD', 'DATABASE_URL', 'WEBHOOK_URL', 'AUTH', 'PRIVATE_PEM', 'SIGNING_SALT', 'DSN'])
    assert.ok(!isSecretEnvName(name), `${name} is an acknowledged matcher limit`);
  for (const name of ['C2C_DEPLOY_MODE', 'C2C_MAIL_FROM', 'C2C_APP_TIMEZONE', 'TABLE_ID', 'REGION']) assert.ok(!isSecretEnvName(name), name);
  assert.deepEqual(secretEnvValues({ API_KEY: 'k', PLAIN: 'p' }), { API_KEY: 'k' });
});

test('applyFunctionEnvSecrets merges, posts, and verifies the full replace-only set', async () => {
  let posted: Record<string, string> | undefined;
  const { rest, calls } = restStub((call) => {
    if (call.method === 'GET' && call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'GET' && call.path === `${PREFIX}/function/2001`)
      return { status: 200, body: { data: { configuration: { environment: { variables: posted ?? { C2C_DEPLOY_MODE: 'live', TABLE_ID: '55', C2C_OWNER_APPROVAL_TOKEN: '' } } } } } };
    if (call.method === 'POST' && call.path === `${PREFIX}/function/2001/configuration`) {
      posted = (call.body as { variables: Record<string, string> }).variables;
      return { status: 200, body: { status: 'success' } };
    }
    return undefined;
  });
  const applied = await applyFunctionEnvSecrets(rest, '1001', { C2C_OWNER_APPROVAL_TOKEN: 'real-token' }, ['C2C_DEPLOY_MODE'], { tries: 1 });
  assert.deepEqual(applied, ['C2C_OWNER_APPROVAL_TOKEN']);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [`GET ${PREFIX}/function`, `GET ${PREFIX}/function/2001`, `POST ${PREFIX}/function/2001/configuration`, `GET ${PREFIX}/function/2001`],
  );
  // The POST replaces every variable, so the body is the live set plus the
  // secrets — the name-only placeholder gains its value, nothing else is lost.
  assert.deepEqual(calls[2]?.body, { variables: { C2C_DEPLOY_MODE: 'live', C2C_OWNER_APPROVAL_TOKEN: 'real-token', TABLE_ID: '55' } });
});

test('unknown or incomplete live env refuses before POST', async () => {
  for (const detail of [{ data: {} }, { data: { configuration: { environment: { variables: { C2C_DEPLOY_MODE: 'live', TABLE_ID: 5 } } } } }]) {
    const { rest, calls } = restStub((call) => {
      if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
      if (call.method === 'GET') return { status: 200, body: detail };
      return undefined;
    });
    await assert.rejects(() => applyFunctionEnvSecrets(rest, '1001', { API_KEY: 'k' }, ['C2C_DEPLOY_MODE'], { tries: 1 }), /unknown shape|non-string|refusing/);
    assert.equal(calls.some((call) => call.method === 'POST'), false);
  }
});

test('applyFunctionEnvSecrets rejects a POST whose read-back omits a deployed key', async () => {
  let detailReads = 0;
  const { rest } = restStub((call) => {
    if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'POST') return { status: 200, body: {} };
    if (call.method === 'GET') {
      detailReads++;
      const variables = detailReads === 1 ? { C2C_DEPLOY_MODE: 'live' } : { C2C_DEPLOY_MODE: 'live' };
      return { status: 200, body: { data: { configuration: { environment: { variables } } } } };
    }
    return undefined;
  });
  await assert.rejects(() => applyFunctionEnvSecrets(rest, '1001', { API_KEY: 'k' }, ['C2C_DEPLOY_MODE'], { tries: 1 }), /did not match/);
});

test('applyFunctionEnvSecrets is a no-op with no secrets and fails on any refused call', async () => {
  const idle = restStub(() => ({ status: 500, body: {} }));
  assert.deepEqual(await applyFunctionEnvSecrets(idle.rest, '1001', {}), []);
  assert.equal(idle.calls.length, 0);

  const refusedList = restStub(() => ({ status: 403, body: {} }));
  await assert.rejects(() => applyFunctionEnvSecrets(refusedList.rest, '1001', { API_KEY: 'k' }, ['C2C_DEPLOY_MODE'], { tries: 1 }), /listing functions/);

  const missing = restStub((call) => (call.path === `${PREFIX}/function` ? { status: 200, body: { data: [{ function_name: 'other', id: '9' }] } } : undefined));
  await assert.rejects(() => applyFunctionEnvSecrets(missing.rest, '1001', { API_KEY: 'k' }, ['C2C_DEPLOY_MODE'], { tries: 1 }), /c2c_api is not in the project function list/);

  const refusedPost = restStub((call) => {
    if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'GET') return { status: 200, body: { data: { configuration: { environment: { variables: { C2C_DEPLOY_MODE: 'live' } } } } } };
    if (call.method === 'POST') return { status: 500, body: {} };
    return undefined;
  });
  await assert.rejects(() => applyFunctionEnvSecrets(refusedPost.rest, '1001', { API_KEY: 'k' }, ['C2C_DEPLOY_MODE'], { tries: 1 }), /setting c2c_api env vars/);
});

test('functionIdFromList and liveFunctionVariables tolerate envelope shapes', () => {
  assert.equal(functionIdFromList([{ name: 'c2c_api', id: 7 }]), '7');
  assert.equal(functionIdFromList({ functions: [{ name: 'c2c_api', id: '8' }] }), '8');
  assert.equal(functionIdFromList({ data: { functions: [{ function_name: 'c2c_api', function_id: '9' }] } }), '9');
  assert.equal(functionIdFromList({ data: [] }), undefined);
  assert.deepEqual(liveFunctionVariables({ data: { configuration: { environment: { variables: { A: '1' } } } } }), { A: '1' });
  assert.throws(() => liveFunctionVariables({}), /unknown shape/);
});

// Catalyst refused a deploy whose env_variables carried these names:
// "HTTP Error: 400, environment_variables must not contain reserved keywords".
test('buildFunctionEnv never emits a reserved name, even from an older file', () => {
  const env = buildFunctionEnv({
    dc: 'in',
    env: 'Development',
    projectId: '1001',
    appUrl: 'https://app.onslate.in',
    existingEnv: { APP_URL: 'https://app.onslate.in', CATALYST_APP_URL: 'https://app.onslate.in', CATALYST_DC: 'in', CATALYST_ENV: 'Development', CATALYST_PROJECT_ID: '1', DC: 'in', ENV: 'Development', PROJECT_ID: '1', X_ZOHO_CATALYST_ORG_ID: '2', MY_CLIENT_SECRET: 'kept' },
  });
  for (const reserved of RESERVED_ENV_KEYS) assert.equal(env[reserved], undefined, reserved);
  assert.equal(env.C2C_ZOHO_DC, 'in');
  // Live 2026-10-17: Catalyst refused an env carrying APP_URL/CATALYST_APP_URL.
  assert.equal(env.APP_URL, undefined);
  assert.equal(env.CATALYST_APP_URL, undefined);
  assert.equal(env.MY_CLIENT_SECRET, 'kept');
  // The DC still carries over from an older file that only had the reserved name.
  assert.equal(buildFunctionEnv({ existingEnv: { DC: 'eu' } }).C2C_ZOHO_DC, 'eu');
});

test('envVariables refuses a reserved name and keeps a non-reserved CATALYST_ name', () => {
  for (const reserved of RESERVED_ENV_KEYS) {
    assert.throws(() => envVariables('live', { [reserved]: 'x' }), new RegExp(`function env: ${reserved} is a name Catalyst reserves`));
  }
  assert.equal(envVariables('live', { CATALYST_SOMETHING: 'x' }).CATALYST_SOMETHING, 'x');
});

// Live failure F-HRM-ENV-MAXLEN (2026-10-17): a redeploy whose env_variables
// map summed past Catalyst's aggregate size ceiling was refused with
// "environment_variables value has exceeded its maximum length". The HRM app
// had 93 keys only because every table id was written twice; the deduped env
// — one TABLE_<NAME>_ID per table — fits under the limit.
test('an HRM-shaped env (44 tables) builds one key per table and fits the env limit', () => {
  const tables = Array.from({ length: 44 }, (_, i) => ({ name: `Form_Number_${i + 1}`, id: `1000000000171${String(i).padStart(3, '0')}` }));
  const env = buildFunctionEnv({ dc: 'in', bucketName: 'c2c-human-resource-management-42124967', tables });
  assert.equal(Object.keys(env).length, 44 + 4, 'one TABLE_<NAME>_ID per table plus TABLE_ID, DC and the bucket pair');
  assert.ok(Object.keys(env).every((k) => !/^TABLE_ID_/.test(k)));
  envVariables('live', env);
  assert.ok(envVariablesSize(envVariables('live', env)) <= ENV_VARIABLES_MAX);
});

test('an env over the aggregate limit is refused before any network call', () => {
  // The probe's failing shape: 293 keys of (len 5 + len 6 + 3) = 4102 > 4096.
  const huge = Object.fromEntries(Array.from({ length: 293 }, (_, i) => [`K${String(i).padStart(4, '0')}`, 'vvvvvv']));
  assert.equal(envVariablesSize(huge), 293 * (5 + 6 + 3));
  assert.ok(envVariablesSize(huge) > ENV_VARIABLES_MAX);
  assert.throws(() => envVariables('live', huge), /env_variables is 4124 over 294 keys; Catalyst accepts at most 4096/, 'the +C2C_DEPLOY_MODE merge makes 294 keys');
});

// The limit is an exact `> 4096`: 4096 passes and 4097 is refused, so a `>=`
// mutation fails these cases.
test('the aggregate limit boundary: 4096 passes and 4097 is refused', () => {
  // 5 + 4088 + 3 = 4096.
  assert.doesNotThrow(() => assertEnvVariablesWithinLimit({ K0000: 'v'.repeat(4088) }));
  assert.throws(() => assertEnvVariablesWithinLimit({ K0000: 'v'.repeat(4089) }), /env_variables is 4097 over 1 keys; Catalyst accepts at most 4096/);
  // Through envVariables: C2C_DEPLOY_MODE=live adds 15 + 4 + 3 = 22, so the
  // file key carries 4074 or 4075. 22 + 4074 = 4096; 22 + 4075 = 4097.
  assert.equal(envVariablesSize(envVariables('live', { K0000: 'v'.repeat(4066) })), ENV_VARIABLES_MAX);
  assert.throws(() => envVariables('live', { K0000: 'v'.repeat(4067) }), /env_variables is 4097 over 2 keys/);
});

// A confirmed deploy sizes the live env (C2C_DEPLOY_MODE=live), not the
// 3-bytes-larger dry-run shape, so a file whose live env is exactly 4096 is
// accepted — and one byte more is refused.
test('the --function-env preflight sizes the env the live deploy sends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fenv-'));
  const file = join(dir, 'env.json');
  writeFileSync(file, JSON.stringify({ K0000: 'v'.repeat(4066) }));
  assert.doesNotThrow(() => readFunctionEnv(file, true), 'a live env of exactly 4096 passes');
  writeFileSync(file, JSON.stringify({ K0000: 'v'.repeat(4067) }));
  assert.throws(() => readFunctionEnv(file, true), /env_variables is 4097/);
  rmSync(dir, { recursive: true, force: true });
});

// The preflight counts C2C_MAIL_FROM too: a file whose live env fits without
// the sender (4065) but overflows with it (4097) is refused before the guard's
// project list or the mail sender read-back — a counting io sees zero calls.
test('a confirmed deploy refuses an env over the limit with C2C_MAIL_FROM before any network call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-fenv-'));
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, 'application "Widget"\n{\n\tform Item\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n\tlist Open_Items\n\t{\n\t\tshow all rows from Item\n\t}\n}\n');
  const envFile = join(dir, 'env.json');
  // 5 + 4035 + 3 = 4043, + C2C_DEPLOY_MODE=live (22) = 4065; the sender
  // 'a@b.example.test' adds 13 + 16 + 3 = 32 for a live env of 4097.
  writeFileSync(envFile, JSON.stringify({ K0000: 'v'.repeat(4035) }));
  assert.doesNotThrow(() => readFunctionEnv(envFile, true), 'the same file fits without the sender');
  let network = 0;
  let err = '';
  const io = {
    stdout: () => {},
    stderr: (s: string) => void (err += s),
    env: {},
    spawn: async () => {
      network++;
      throw new Error('spawn forbidden');
    },
    fetch: async () => {
      network++;
      throw new Error('fetch forbidden');
    },
    rest: async () => {
      network++;
      throw new Error('rest forbidden');
    },
    accessToken: async () => {
      network++;
      throw new Error('accessToken forbidden');
    },
    cliDc: () => undefined,
    sleep: async () => {},
  } as unknown as Io;
  const code = await deployCli([ds, '--project', '1001', '--org', ORG, '--dc', 'in', '--confirm', '--function-env', envFile, '--mail', '--mail-from', 'a@b.example.test'], io);
  assert.equal(code, 1);
  assert.match(err, /env_variables is 4097 over 3 keys/);
  assert.equal(network, 0, 'the refusal runs before the project list and the sender read-back');
  rmSync(dir, { recursive: true, force: true });
});

test('the secrets POST refuses a merged env over the aggregate limit before writing', async () => {
  const detail = { data: { configuration: { environment: { variables: { LIVE_TOKEN: 'x' } } } } };
  const stub = restStub((call) => {
    if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'GET') return { status: 200, body: detail };
    return undefined;
  });
  await assert.rejects(
    () => applyFunctionEnvSecrets(stub.rest, '1001', { PADDING_TOKEN: 'x'.repeat(ENV_VARIABLES_MAX) }, [], { tries: 1 }),
    /env_variables is \d+ over \d+ keys/,
  );
  assert.equal(stub.calls.some((call) => call.method === 'POST'), false, 'no POST was sent');
});

// The same exact boundary guards the secrets POST: a merged env of 4096 is
// written, 4097 is refused before the POST.
test('the secrets POST boundary: exactly 4096 posts, 4097 is refused', async () => {
  const detail = (variables: Record<string, string>) => ({ data: { configuration: { environment: { variables } } } });
  // live = LIVE_TOKEN (10) + 'x' (1) + 3 = 14; PAD_TOKEN (9) + pad + 3.
  // pad 4070 -> 14 + 4082 = 4096; pad 4071 -> 4097.
  let posted: Record<string, string> | undefined;
  const fits = restStub((call) => {
    if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'POST') {
      posted = (call.body as { variables: Record<string, string> }).variables;
      return { status: 200, body: {} };
    }
    if (call.method === 'GET') return { status: 200, body: detail(posted ?? { LIVE_TOKEN: 'x' }) };
    return undefined;
  });
  await applyFunctionEnvSecrets(fits.rest, '1001', { PAD_TOKEN: 'v'.repeat(4070) }, [], { tries: 1 });
  assert.equal(envVariablesSize(posted ?? {}), ENV_VARIABLES_MAX, 'the posted set is exactly the limit');

  const over = restStub((call) => {
    if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'GET') return { status: 200, body: detail({ LIVE_TOKEN: 'x' }) };
    return undefined;
  });
  await assert.rejects(() => applyFunctionEnvSecrets(over.rest, '1001', { PAD_TOKEN: 'v'.repeat(4071) }, [], { tries: 1 }), /env_variables is 4097/);
  assert.equal(over.calls.some((call) => call.method === 'POST'), false, 'no POST was sent');
});

// Live failure F-CM-ENV: the provisioned env had no C2C_STRATUS_BUCKET and
// turned the project and job-pool names learned during provision into TABLE_*.
test('provision env carries the app bucket and TABLE_* only for real tables', () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-fenv-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(
    join(out, 'provision', 'tables.json'),
    JSON.stringify([
      { table: 'LineItems', columns: [] },
      { table: 'Jobs', columns: [] },
    ]),
  );
  const plan = {
    version: 1,
    app: 'FixtureApp',
    steps: [
      {
        id: 'tables',
        via: 'cli',
        args: { plan: 'provision/tables.json', tables: ['LineItems', 'Jobs'] },
        readBack: { via: 'cli', match: {} },
      },
      {
        id: 'bucket',
        via: 'mcp',
        tool: 'CatalystbyZoho_Create_Bucket',
        args: { body: { bucket_name: 'c2c-fixture-app-abcd1234', bucket_meta: { type: 'protected' } } },
        readBack: { via: 'mcp', tool: 'CatalystbyZoho_Get_All_Buckets', match: { bucket_name: 'c2c-fixture-app-abcd1234' } },
      },
    ],
  } as unknown as ProvisionPlanFile;
  const tableIds = {
    LineItems: '111111',
    Jobs: '222222',
    ConstructionManagement: '333333', // the job pool's name -> id
    'c2c-br-3': '444444', // the project name -> project id
  };
  const env = buildFunctionEnv(provisionFunctionEnvInput({ out, plan, tableIds }));
  assert.equal(env.C2C_STRATUS_BUCKET, 'c2c-fixture-app-abcd1234');
  assert.equal(env.STRATUS_BUCKET, 'c2c-fixture-app-abcd1234');
  assert.equal(env.TABLE_LINEITEMS_ID, '111111');
  assert.equal(env.TABLE_ID_LINEITEMS, undefined, 'the TABLE_ID_<NAME> double is never written');
  assert.equal(env.TABLE_JOBS_ID, '222222');
  assert.equal(env.TABLE_ID, '111111');
  for (const bad of ['TABLE_CONSTRUCTIONMANAGEMENT_ID', 'TABLE_ID_CONSTRUCTIONMANAGEMENT', 'TABLE_C2C_BR_3_ID', 'TABLE_ID_C2C_BR_3']) {
    assert.ok(!(bad in env), `${bad} — a job-pool or project name is never a TABLE_* key`);
  }
  for (const [key, value] of Object.entries(env)) {
    assert.ok(value !== '333333' && value !== '444444', `${key} carries a job-pool or project id`);
  }
});

// Apps provisioned before the dedup carry the TABLE_ID_<NAME> double in their
// function-env.json: its id folds into the canonical spelling and the legacy
// key is dropped on the next write.
test('a legacy TABLE_ID_<NAME> existing key folds into TABLE_<NAME>_ID', () => {
  const env = buildFunctionEnv({
    existingEnv: { TABLE_ID_LEGACYAPP: '777777', C2C_ZOHO_DC: 'in' },
  });
  assert.equal(env.TABLE_LEGACYAPP_ID, '777777');
  assert.equal(env.TABLE_ID_LEGACYAPP, undefined);
  assert.equal(env.TABLE_ID, '777777');
});

// Deploy asserts the env read-back even when there are no secrets to apply:
// a files app missing C2C_STRATUS_BUCKET fails the deploy, not the upload.
test('applyFunctionEnvSecrets with no secrets still asserts required deployed keys', async () => {
  const detail = (variables: Record<string, string>) => ({ data: { configuration: { environment: { variables } } } });
  const missingBucket = restStub((call) => {
    if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'GET') return { status: 200, body: detail({ C2C_DEPLOY_MODE: 'live' }) };
    return undefined;
  });
  await assert.rejects(
    () => applyFunctionEnvSecrets(missingBucket.rest, '1001', {}, ['C2C_DEPLOY_MODE', 'C2C_STRATUS_BUCKET'], { tries: 1 }),
    /missing deployed variable.*C2C_STRATUS_BUCKET/,
  );
  assert.equal(missingBucket.calls.some((call) => call.method === 'POST'), false);

  const complete = restStub((call) => {
    if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'GET') return { status: 200, body: detail({ C2C_DEPLOY_MODE: 'live', C2C_STRATUS_BUCKET: 'c2c-fixture-app-abcd1234' }) };
    return undefined;
  });
  assert.deepEqual(await applyFunctionEnvSecrets(complete.rest, '1001', {}, ['C2C_DEPLOY_MODE', 'C2C_STRATUS_BUCKET'], { tries: 1 }), []);
  assert.equal(complete.calls.some((call) => call.method === 'POST'), false);
});

// A table and a project, role or job pool can share a name. The flat learned
// map keeps whichever was recorded last, so TABLE_* must come from table
// observations only — in either record order.
const COLLIDE = 'Jobs';
const COLLIDE_STEPS = [
  { id: 'project', via: 'console', command: 'Create project Jobs', args: { name: COLLIDE, environment: 'Development' }, readBack: { via: 'cli', command: 'c2c provision --record project', match: { project_name: COLLIDE, id: '<project>' } } },
  { id: 'tables', via: 'cli', command: 'c2c provision --confirm --run tables', args: { plan: 'provision/tables.json', tables: [COLLIDE] }, readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Tables', match: { table_name: [COLLIDE] } } },
  { id: 'jobpool', via: 'mcp', tool: 'CatalystbyZoho_Create_Job_Pool', args: { body: { name: COLLIDE, type: 'Function', capacity: { memory: '256' } } }, readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Jobpools', match: { name: COLLIDE } } },
  { id: 'custom-roles', via: 'console', command: 'Create role Jobs', args: { roles: [COLLIDE] }, readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Roles', match: { role_name: [COLLIDE] } } },
];
const COLLIDERS: Array<[string, Record<string, unknown>, string]> = [
  ['jobpool', { name: COLLIDE, jobpool_id: '222222' }, '222222'],
  ['custom-roles', { role_name: COLLIDE, role_id: '333333' }, '333333'],
  ['project', { project_name: COLLIDE, id: PROJECT }, PROJECT],
];

function collisionOut(): { out: string; record: (step: string, rows: unknown[]) => Promise<void>; tableEnv: () => string | undefined } {
  const out = mkdtempSync(join(tmpdir(), 'c2c-fenv-collide-'));
  mkdirSync(join(out, 'provision'), { recursive: true });
  writeFileSync(join(out, 'provision', 'plan.json'), JSON.stringify({ version: 1, app: 'JobsApp', dc: 'in', steps: COLLIDE_STEPS }));
  writeFileSync(join(out, 'provision', 'tables.json'), JSON.stringify([{ table: COLLIDE, columns: [] }]));
  const log: string[] = [];
  const io = {
    stdout: (s: string) => void log.push(s),
    stderr: (s: string) => void log.push(s),
    env: {},
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    fetch: async () => {
      throw new Error('network forbidden');
    },
  } as unknown as Io;
  const record = async (step: string, rows: unknown[]): Promise<void> => {
    const result = join(out, `${step}-input.json`);
    writeFileSync(result, JSON.stringify({ status: 'success', data: { status: 'success', data: rows } }));
    const code = await provisionCli(['--out', out, '--record', step, '--result', result, '--project', PROJECT, '--org', ORG, '--dc', 'in'], io);
    assert.equal(code, 0, log.join(''));
  };
  const tableEnv = (): string | undefined => (JSON.parse(readFileSync(join(out, 'function-env.json'), 'utf8')) as Record<string, string>).TABLE_JOBS_ID;
  return { out, record, tableEnv };
}

for (const [step, row, otherId] of COLLIDERS) {
  test(`TABLE_* keeps the table id when a same-named ${step} is recorded after the table`, async () => {
    const { out, record, tableEnv } = collisionOut();
    await record('tables', [{ table_name: COLLIDE, table_id: '111111' }]);
    assert.equal(tableEnv(), '111111');
    await record(step, [row]);
    assert.equal(tableEnv(), '111111', `a ${step} id (${otherId}) never replaces the table id`);
    rmSync(out, { recursive: true, force: true });
  });

  test(`TABLE_* takes the table id when a same-named ${step} was recorded before the table`, async () => {
    const { out, record, tableEnv } = collisionOut();
    await record(step, [row]);
    assert.notEqual(tableEnv(), otherId, `a ${step} id is never a TABLE_* id`);
    await record('tables', [{ table_name: COLLIDE, table_id: '111111' }]);
    assert.equal(tableEnv(), '111111');
    rmSync(out, { recursive: true, force: true });
  });
}

test('a state.json without kinds re-learns table ids from its recorded evidence, not the flat map', async () => {
  const { out, record, tableEnv } = collisionOut();
  await record('tables', [{ table_name: COLLIDE, table_id: '111111' }]);
  await record('jobpool', [{ name: COLLIDE, jobpool_id: '222222' }]);
  // An older state: the flat map already holds the job pool's id under the table's name.
  const statePath = join(out, 'provision', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { learned: { byName: Record<string, string>; byKind?: unknown } };
  assert.equal(state.learned.byName[COLLIDE], '222222');
  delete state.learned.byKind;
  writeFileSync(statePath, JSON.stringify(state));
  await record('custom-roles', [{ role_name: COLLIDE, role_id: '333333' }]);
  assert.equal(tableEnv(), '111111', 'the migrated table id comes from the tables evidence');
  // With the tables evidence gone, the id is unknown — never the flat entry.
  const migrated = JSON.parse(readFileSync(statePath, 'utf8')) as { learned: { byKind?: unknown }; steps: Record<string, { result?: string }> };
  rmSync(join(out, migrated.steps.tables!.result!));
  rmSync(join(out, 'function-env.json'));
  delete migrated.learned.byKind;
  writeFileSync(statePath, JSON.stringify(migrated));
  await record('custom-roles', [{ role_name: COLLIDE, role_id: '333333' }]);
  assert.equal(tableEnv(), undefined, 'a kindless flat entry is never trusted as a table id');
  rmSync(out, { recursive: true, force: true });
});
