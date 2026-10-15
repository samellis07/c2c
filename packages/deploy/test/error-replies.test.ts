/**
 * Error replies of a generated app never carry server internals.
 *
 * The sample app is generated as a dry-run deploy tree and served through the
 * Advanced I/O entry (functions/c2c_api/index.js) with the fake Catalyst SDK.
 * Every error path the entry and the generated handlers can take is triggered,
 * plus stub handlers that answer with the leaks the entry must strip: stack
 * traces, file paths, ZCQL text, credentials, raw platform error bodies and
 * debug transcripts holding other users' record values. All data is synthetic.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';

const root = repoRoot();
const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

/** Anything a caller must never see in an error reply. */
const LEAK = /\bat\s+\S+\s+\(|\/srv\/|\/var\/|\/Users\/|node_modules|\.m?js:\d|zcql|oauthtoken|Bearer|tok_[0-9a-f]{8}|other@example\.test|"error_code"|INVALID_INPUT|transcript|stack/i;
/** Query keywords, as the store spells them. */
const QUERY = /\bSELECT\b|\bWHERE\b|\bFROM\b/;
/** Keys an error reply may carry: the {code,message} shape plus write and field signals. */
const ALLOWED_KEYS = new Set(['code', 'message', 'field', 'refused', 'wrote', 'deleted', 'dryRun', 'values', 'correlationId']);

async function sampleApp() {
  const gen = (await import(pathToFileURL(join(root, 'fixtures/sample-app/sample-app.mjs')).href)) as {
    sampleItemForm(): string[];
    sampleItemReport(): string[];
    sampleWorkflow(): string[];
  };
  const source = [
    'application "sample-app"', '{', '\ttime zone = "Asia/Kolkata"', '\tshare_settings', '\t{', '\t\t"Administrator"', '\t\t{',
    '\t\t\tname = "Administrator"', '\t\t\ttype = Users_Permissions', '\t\t\tdescription = "This profile will have all the permissions."',
    '\t\t}', '\t}', '\tforms', '\t{', ...gen.sampleItemForm(), '\t}', '\treports', '\t{', ...gen.sampleItemReport(), '\t}',
    ...gen.sampleWorkflow(), '}', '',
  ].join('\n');
  return deriveIr(parse(source));
}

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  return { org: FIXTURE_ORG, projectId: '1001', environment: ALLOWED_ENV, projectName: catalystProjectName(app.name || 'app'), dc: 'in', registry: FIXTURE_REGISTRY };
}

/** Stub handlers that answer with internals, one per leak class. */
const STUBS: Record<string, { status: number; body: Record<string, unknown> }> = {
  'stack-trace': { status: 400, body: { error: 'Cannot read properties of undefined\n    at handle (/srv/app/functions/c2c_api/aio/x.mjs:12:5)' } },
  'file-path': { status: 403, body: { error: 'record access: policy file /var/task/functions/c2c_api/access.json is unreadable' } },
  'zcql-text': { status: 422, body: { error: "ZCQL syntax error: SELECT ROWID FROM Sample_Item WHERE Owner = 'other@example.test'" } },
  'token': { status: 401, body: { error: 'refresh failed for Zoho-oauthtoken tok_0a1b2c3d4e5f60718293a4b5c6d7e8f9' } },
  'catalyst-body': { status: 409, body: { error: '{"status":"failure","data":{"error_code":"INVALID_INPUT","message":"Invalid input value for Owner. text value expected"}}' } },
  'other-user-record': {
    status: 422,
    body: { refused: true, error: 'The record was not saved.', transcript: [{ op: 'fetch', form: 'Sample_Item', where: "Owner = 'other@example.test'", rows: [{ Item_Name: 'Other user row' }] }], stack: 'Error\n    at x' },
  },
  'plain-alert': { status: 422, body: { refused: true, error: 'Please delete from the cart first, then select a size' } },
};

test('every error reply of a generated app has the {code,message} shape and no internals', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-err-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const app = await sampleApp();
  writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'dry-run' }).files);
  const functionDir = join(out, 'functions/c2c_api');
  const routes = JSON.parse(readFileSync(join(functionDir, 'routes.json'), 'utf8')) as Record<string, string>;
  for (const [name, stub] of Object.entries(STUBS)) {
    routes[`POST /stub/${name}`] = `stub-${name}.mjs`;
    writeFileSync(
      join(functionDir, `stub-${name}.mjs`),
      `export default async function stub(call, res) {\n  res.writeHead(${stub.status}, { "Content-Type": "application/json" });\n  res.end(${JSON.stringify(JSON.stringify(stub.body))});\n}\n`,
    );
  }
  // A raw SDK error with a 4xx status that escapes the handler.
  routes['POST /stub/thrown'] = 'stub-thrown.mjs';
  writeFileSync(
    join(functionDir, 'stub-thrown.mjs'),
    `export default async function stub() {\n  throw Object.assign(new Error("ZCQL syntax error near SELECT * FROM Sample_Item"), { status: 400 });\n}\n`,
  );
  writeFileSync(join(functionDir, 'routes.json'), JSON.stringify(routes));

  const req = createRequire(import.meta.url);
  const sdk = req(fake) as { setSession(token: string, user: unknown): void };
  sdk.setSession('t1', { user_id: '1', email_id: 'operator@example.test', role_details: { role_name: 'App Administrator' } });
  const entry = req(join(functionDir, 'index.js')) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const server = createServer((rq, rs) => void entry(rq, rs));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const call = async (path: string, init: { body?: string; method?: string; type?: string; session?: boolean } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${path}`, {
      method: init.method ?? 'POST',
      headers: { 'content-type': init.type ?? 'application/json', ...(init.session === false ? {} : { cookie: 'c2c-harness-session=t1' }) },
      ...((init.method ?? 'POST') === 'POST' ? { body: init.body ?? '{}' } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const assertShape = (label: string, result: { status: number; body: Record<string, unknown> }, status: number) => {
    const text = JSON.stringify(result.body);
    assert.equal(result.status, status, `${label}: ${text}`);
    assert.equal(typeof result.body.code, 'string', `${label}: ${text}`);
    assert.equal(typeof result.body.message, 'string', `${label}: ${text}`);
    for (const key of Object.keys(result.body)) assert.ok(ALLOWED_KEYS.has(key), `${label}: unexpected key ${key} in ${text}`);
    assert.doesNotMatch(text, LEAK, label);
    assert.doesNotMatch(text, QUERY, label);
  };
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]) => logged.push(parts.map(String).join(' '));
  try {
    const submit = '/forms/Sample_Item/submit';
    const record = (fields: Record<string, unknown>) => JSON.stringify({ record: fields });

    // Entry paths.
    assertShape('unauthenticated', await call(submit, { body: record({ Item_Name: 'x' }), session: false }), 401);
    assertShape('unknown route', await call('/no/such/route'), 404);
    assertShape('wrong method', await call(submit, { method: 'GET' }), 405);
    assertShape('bad JSON', await call(submit, { body: '{not json' }), 400);
    assertShape('form content type', await call(submit, { body: 'a=1', type: 'application/x-www-form-urlencoded' }), 415);
    const typed = await call(submit, { body: record({ Item_Name: 'typed', Quantity: 'not a quantity' }) });
    assertShape('field type', typed, 400);
    assert.equal(typed.body.field, 'Quantity');

    // Generated handler paths: a cancel submit in the on validate script
    // replies 422 with Creator's alert; its dry-run transcript (query text and
    // record values) stays off the error reply.
    const validate = '/forms/Sample_Item/validate';
    const refused = await call(validate, { body: record({ Item_Name: 'Zero', Quantity: 0, Unit_Price: 5 }) });
    assertShape('submit refused', refused, 422);
    assert.equal(refused.body.message, 'Quantity must be greater than zero');
    assert.equal(refused.body.refused, true);
    const priced = await call(validate, { body: record({ Item_Name: 'Negative', Quantity: 1, Unit_Price: -1 }) });
    assertShape('second validate refusal', priced, 422);
    assertShape('validate field type', await call(validate, { body: record({ Item_Name: 'typed', Quantity: 'not a quantity' }) }), 400);

    // Leaks the entry must strip, whatever a handler answers.
    for (const [name, stub] of Object.entries(STUBS)) {
      const result = await call(`/stub/${name}`);
      assertShape(name, result, stub.status);
      if (name === 'plain-alert') assert.equal(result.body.message, 'Please delete from the cart first, then select a size', 'ordinary alert text is kept');
      else if (name !== 'other-user-record') assert.equal(result.body.message, 'Request failed', name);
    }
    assertShape('thrown SDK error', await call('/stub/thrown'), 400);
  } finally {
    console.error = originalError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  }
  assert.doesNotMatch(logged.join('\n'), /tok_0a1b2c3d|other@example\.test/, 'a 4xx reply is not logged with its raw text');
});
