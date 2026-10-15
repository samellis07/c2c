import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFunctionEnvSecrets, functionIdFromList, liveFunctionVariables } from '../src/function-env.js';
import { isSecretEnvName, secretEnvValues } from '../src/function-dir.js';
import type { RestCall, RestFn } from '../src/tables.js';

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
  for (const name of ['C2C_DEPLOY_MODE', 'C2C_MAIL_FROM', 'C2C_APP_TIMEZONE', 'TABLE_ID', 'REGION']) assert.ok(!isSecretEnvName(name), name);
  assert.deepEqual(secretEnvValues({ API_KEY: 'k', PLAIN: 'p' }), { API_KEY: 'k' });
});

test('applyFunctionEnvSecrets merges the live set and POSTs the full replace-only set', async () => {
  const { rest, calls } = restStub((call) => {
    if (call.method === 'GET' && call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'GET' && call.path === `${PREFIX}/function/2001`)
      return { status: 200, body: { data: { configuration: { environment: { variables: { C2C_DEPLOY_MODE: 'live', TABLE_ID: '55', C2C_OWNER_APPROVAL_TOKEN: '' } } } } } };
    if (call.method === 'POST' && call.path === `${PREFIX}/function/2001/configuration`) return { status: 200, body: { status: 'success' } };
    return undefined;
  });
  const applied = await applyFunctionEnvSecrets(rest, '1001', { C2C_OWNER_APPROVAL_TOKEN: 'real-token' }, { tries: 1 });
  assert.deepEqual(applied, ['C2C_OWNER_APPROVAL_TOKEN']);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [`GET ${PREFIX}/function`, `GET ${PREFIX}/function/2001`, `POST ${PREFIX}/function/2001/configuration`],
  );
  // The POST replaces every variable, so the body is the live set plus the
  // secrets — the name-only placeholder gains its value, nothing else is lost.
  assert.deepEqual(calls[2]?.body, { variables: { C2C_DEPLOY_MODE: 'live', C2C_OWNER_APPROVAL_TOKEN: 'real-token', TABLE_ID: '55' } });
});

test('applyFunctionEnvSecrets is a no-op with no secrets and fails on any refused call', async () => {
  const idle = restStub(() => ({ status: 500, body: {} }));
  assert.deepEqual(await applyFunctionEnvSecrets(idle.rest, '1001', {}), []);
  assert.equal(idle.calls.length, 0);

  const refusedList = restStub(() => ({ status: 403, body: {} }));
  await assert.rejects(() => applyFunctionEnvSecrets(refusedList.rest, '1001', { API_KEY: 'k' }, { tries: 1 }), /listing functions/);

  const missing = restStub((call) => (call.path === `${PREFIX}/function` ? { status: 200, body: { data: [{ function_name: 'other', id: '9' }] } } : undefined));
  await assert.rejects(() => applyFunctionEnvSecrets(missing.rest, '1001', { API_KEY: 'k' }, { tries: 1 }), /c2c_api is not in the project function list/);

  const refusedPost = restStub((call) => {
    if (call.path === `${PREFIX}/function`) return { status: 200, body: functionList };
    if (call.method === 'GET') return { status: 200, body: { data: { configuration: { environment: { variables: {} } } } } };
    if (call.method === 'POST') return { status: 500, body: {} };
    return undefined;
  });
  await assert.rejects(() => applyFunctionEnvSecrets(refusedPost.rest, '1001', { API_KEY: 'k' }, { tries: 1 }), /setting c2c_api env vars/);
});

test('functionIdFromList and liveFunctionVariables tolerate envelope shapes', () => {
  assert.equal(functionIdFromList([{ name: 'c2c_api', id: 7 }]), '7');
  assert.equal(functionIdFromList({ functions: [{ name: 'c2c_api', id: '8' }] }), '8');
  assert.equal(functionIdFromList({ data: { functions: [{ function_name: 'c2c_api', function_id: '9' }] } }), '9');
  assert.equal(functionIdFromList({ data: [] }), undefined);
  assert.deepEqual(liveFunctionVariables({ data: { configuration: { environment: { variables: { A: '1', B: 2 } } } } }), { A: '1' });
  assert.deepEqual(liveFunctionVariables({}), {});
});
