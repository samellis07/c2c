/**
 * Secret --function-env values reach the c2c_api function over the Catalyst
 * admin env route at deploy time, never through a generated file:
 * catalyst-config.json env_variables carries each secret NAME with an empty
 * value (the generated project is the customer's and is often committed), and
 * this POST restores the real values right after `catalyst deploy` lands.
 * Route per plugin/references/facts/functions.md "Manage env vars as one
 * replace-only set" — a configuration write replaces every variable, so the
 * live set is re-read and merged before the POST.
 */
import { API_FUNCTION } from './function-dir.js';
import { restWithRetry, type RetryOptions } from './retry.js';
import type { RestFn } from './tables.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The function list body tolerates both a bare array and the usual {data:[…]} envelope. */
function functionEntries(body: unknown): Record<string, unknown>[] {
  const record = asRecord(body);
  const candidates = [Array.isArray(body) ? body : undefined, asRecord(record?.data)?.functions, record?.functions, record?.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter((entry): entry is Record<string, unknown> => !!asRecord(entry));
  }
  return [];
}

function stringField(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }
  return undefined;
}

/** The deployed function's Catalyst id, found by its fixed name in the project function list. */
export function functionIdFromList(body: unknown, name: string = API_FUNCTION): string | undefined {
  for (const entry of functionEntries(body)) {
    const entryName = stringField(entry, ['function_name', 'name']);
    if (entryName !== name) continue;
    const id = stringField(entry, ['function_id', 'id']);
    if (id) return id;
  }
  return undefined;
}

/** Accept only Catalyst's observed data.configuration.environment.variables object. */
export function liveFunctionVariables(body: unknown): Record<string, string> {
  const variables = asRecord(asRecord(asRecord(asRecord(asRecord(body)?.data)?.configuration)?.environment)?.variables);
  if (!variables) throw new Error('live env read-back has an unknown shape; refusing a replace-only write');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value !== 'string') throw new Error('live env read-back contains a non-string value; refusing a replace-only write');
    out[key] = value;
  }
  return out;
}

async function call(rest: RestFn, request: Parameters<RestFn>[0], opts: RetryOptions, what: string): Promise<unknown> {
  const { result } = await restWithRetry(rest, request, opts);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${what} failed (HTTP ${result.status})`);
  }
  return result.body;
}

/**
 * POST the secret values onto the live function. Returns the applied names,
 * sorted. The configuration write replaces every variable, so the POST body is
 * the live set merged with the secrets — the names the deploy wrote name-only
 * plus every variable already there.
 */
export async function applyFunctionEnvSecrets(
  rest: RestFn,
  projectId: string,
  secrets: Readonly<Record<string, string>>,
  requiredKeys: readonly string[] = ['C2C_DEPLOY_MODE'],
  opts: RetryOptions = {},
): Promise<string[]> {
  const names = Object.keys(secrets).sort();
  if (!names.length) return [];
  const prefix = `/baas/v1/project/${projectId}`;
  const list = await call(rest, { method: 'GET', path: `${prefix}/function` }, opts, `listing functions in project ${projectId}`);
  const id = functionIdFromList(list);
  if (!id) throw new Error(`function ${API_FUNCTION} is not in the project function list after its deploy`);
  const detail = await call(rest, { method: 'GET', path: `${prefix}/function/${id}` }, opts, `reading ${API_FUNCTION} configuration`);
  const live = liveFunctionVariables(detail);
  if (requiredKeys.some((key) => !(key in live))) throw new Error('live env read-back did not match the deployed env_variables; refusing a replace-only write');
  const variables = { ...live, ...secrets };
  await call(rest, { method: 'POST', path: `${prefix}/function/${id}/configuration`, body: { variables } }, opts, `setting ${API_FUNCTION} env vars`);
  const verified = liveFunctionVariables(await call(rest, { method: 'GET', path: `${prefix}/function/${id}` }, opts, `verifying ${API_FUNCTION} env vars`));
  if (Object.entries(variables).some(([key, value]) => verified[key] !== value)) {
    throw new Error('live env read-back did not match the deployed env_variables after update; set the variables in the Catalyst console or MCP env tools');
  }
  return names;
}
