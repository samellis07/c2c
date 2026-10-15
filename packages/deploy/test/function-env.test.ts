import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
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
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
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

    const permsResult = writeResult(out, 'import-table-permissions', { '101': { 'App Administrator': ['SELECT', 'UPDATE', 'INSERT', 'DELETE'], 'App User': ['SELECT'] } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-table-permissions', '--result', permsResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const scopesResult = writeResult(out, 'import-table-scopes', { '101': { 'App Administrator': ['GLOBAL'], 'App User': ['GLOBAL'] } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-table-scopes', '--result', scopesResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const secResult = writeResult(out, 'import-security-rule', { c2c_api: { is_authenticated: true } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-security-rule', '--result', secResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    // Check provision status
    const statusCap = cap(sandbox);
    assert.equal(await provisionCli(['--out', out, '--status', '--org', ORG, '--dc', 'in'], statusCap.io), 0, statusCap.err());

    // function-env.json must exist under --out and contain derivable keys
    const fenvPath = join(out, 'function-env.json');
    assert.ok(existsSync(fenvPath), 'function-env.json must be generated under --out');
    const fenv = JSON.parse(readFileSync(fenvPath, 'utf8')) as Record<string, string>;

    assert.equal(fenv.PROJECT_ID, PROJECT);
    assert.equal(fenv.CATALYST_PROJECT_ID, PROJECT);
    assert.equal(fenv.DC, 'in');
    assert.equal(fenv.ENV, 'Development');
    assert.ok(fenv.TABLE_ID === '101' || fenv.TABLE_ITEM_ID === '101' || fenv.TABLE_ID_ITEM === '101', 'table id must be autofilled');

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

    const permsResult = writeResult(out, 'import-table-permissions', { '101': { 'App Administrator': ['SELECT', 'UPDATE', 'INSERT', 'DELETE'], 'App User': ['SELECT'] } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-table-permissions', '--result', permsResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const scopesResult = writeResult(out, 'import-table-scopes', { '101': { 'App Administrator': ['GLOBAL'], 'App User': ['GLOBAL'] } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-table-scopes', '--result', scopesResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    const secResult = writeResult(out, 'import-security-rule', { c2c_api: { is_authenticated: true } });
    assert.equal(await provisionCli(['--out', out, '--record', 'import-security-rule', '--result', secResult, '--org', ORG, '--dc', 'in'], cap(sandbox).io), 0);

    // Check provision status
    const statusCap = cap(sandbox);
    assert.equal(await provisionCli(['--out', out, '--status', '--org', ORG, '--dc', 'in'], statusCap.io), 0, statusCap.err());

    // function-env.json must hold the connection secret key
    const fenvPath = join(out, 'function-env.json');
    assert.ok(existsSync(fenvPath), 'function-env.json must exist');
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

test('Acceptance 3: generated human-step checklist for the 3 RC fixture shapes has <= 5 items, and docs/human-steps.md matches', () => {
  // Shape 1: deterministic (minimal app without mail or slate)
  const shape1 = humanChecklist({ slate: false, sendsMail: false });
  assert.ok(shape1.length <= 5, `deterministic shape must have <= 5 items, got ${shape1.length}`);

  // Shape 2: few TODOs (e.g. standard Slate app without mail)
  const shape2 = humanChecklist({ slate: true, sendsMail: false });
  assert.ok(shape2.length <= 5, `few TODOs shape must have <= 5 items, got ${shape2.length}`);

  // Shape 3: mail + Slate (app with Slate client and mail)
  const shape3 = humanChecklist({ slate: true, sendsMail: true });
  assert.ok(shape3.length <= 5, `mail+Slate shape must have <= 5 items, got ${shape3.length}`);

  // Shape 3 with connection secret: still <= 5 items
  const shape3WithSecret = (humanChecklist as unknown as (input: Record<string, unknown>) => string[])({
    slate: true,
    sendsMail: true,
    connectionSecretKeys: ['MY_STRIPE_CLIENT_SECRET'],
  });
  assert.ok(shape3WithSecret.length <= 5, `mail+Slate+secret shape must have <= 5 items, got ${shape3WithSecret.length}`);
  assert.equal(shape3WithSecret.length, 5);

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
    const path = join(root, 'function-env.json');
    writeOrUpdateFunctionEnv(root, { projectId: '1001', connectionSecrets: [{ connectionName: 'stripe', propertyKey: 'secret', envKey: 'STRIPE_SECRET', secretValue: 'canary' }] });
    assert.equal(statSync(path).mode & 0o777, 0o600, 'new secret file must be private');
    // Simulate a pre-fix file and confirm an update repairs its permissions.
    const { chmodSync } = await import('node:fs');
    chmodSync(path, 0o644);
    writeOrUpdateFunctionEnv(root, { projectId: '1002' });
    assert.equal(statSync(path).mode & 0o777, 0o600, 'updated secret file must be private');
  } finally {
    umask(oldUmask);
    rmSync(root, { recursive: true, force: true });
  }
});
