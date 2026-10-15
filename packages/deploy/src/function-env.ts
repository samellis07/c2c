import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unquote, type App, type PropertyBlock } from '../../core/src/ir.js';
import { API_FUNCTION } from './function-dir.js';
import { restWithRetry, type RetryOptions } from './retry.js';
import type { RestFn } from './tables.js';

export interface DeclaredConnectionSecret {
  connectionName: string;
  propertyKey: string;
  envKey: string;
  secretValue?: string;
}

export interface FunctionEnvInput {
  dc?: string;
  env?: string;
  projectId?: string;
  appUrl?: string;
  bucketName?: string;
  tables?: ReadonlyArray<{ name: string; id?: string }>;
  learnedByName?: Record<string, string>;
  connectionSecrets?: readonly DeclaredConnectionSecret[];
  existingEnv?: Record<string, string>;
}

export function sanitizeEnvKey(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

const SECRET_PROP_RE = /secret|apikey|api_key|password|token/i;

export function extractConnectionSecrets(app: App): DeclaredConnectionSecret[] {
  const secrets: DeclaredConnectionSecret[] = [];
  const seen = new Set<string>();

  const walk = (blocks: readonly PropertyBlock[]) => {
    for (const block of blocks) {
      if (block.name.toLowerCase() === 'connections') {
        for (const conn of block.blocks) {
          const connName = conn.name.trim();
          for (const prop of conn.properties) {
            if (SECRET_PROP_RE.test(prop.key)) {
              const envKey = `${sanitizeEnvKey(connName)}_${sanitizeEnvKey(prop.key)}`;
              if (!seen.has(envKey)) {
                seen.add(envKey);
                const val = unquote(prop.value ?? '').trim();
                secrets.push({
                  connectionName: connName,
                  propertyKey: prop.key,
                  envKey,
                  ...(val ? { secretValue: val } : {}),
                });
              }
            }
          }
        }
      }
      if (block.blocks && block.blocks.length > 0) {
        walk(block.blocks);
      }
    }
  };

  walk(app.configuration);
  return secrets;
}

export function isDerivableEnvKey(key: string): boolean {
  if (
    key === 'PROJECT_ID' ||
    key === 'CATALYST_PROJECT_ID' ||
    key === 'DC' ||
    key === 'CATALYST_DC' ||
    key === 'C2C_ZOHO_DC' ||
    key === 'ENV' ||
    key === 'CATALYST_ENV' ||
    key === 'APP_URL' ||
    key === 'CATALYST_APP_URL' ||
    key === 'C2C_STRATUS_BUCKET' ||
    key === 'STRATUS_BUCKET' ||
    key === 'TABLE_ID'
  ) {
    return true;
  }
  if (/^TABLE_[A-Z0-9_]+_ID$/.test(key) || /^TABLE_ID_[A-Z0-9_]+$/.test(key)) {
    return true;
  }
  return false;
}

export function buildFunctionEnv(input: FunctionEnvInput): Record<string, string> {
  const existing = input.existingEnv ?? {};
  const out: Record<string, string> = {};

  // Derivable DC
  const dc = input.dc ?? existing.DC ?? existing.CATALYST_DC ?? existing.C2C_ZOHO_DC;
  if (dc) {
    out.DC = dc;
    out.CATALYST_DC = dc;
    out.C2C_ZOHO_DC = dc;
  }

  // Derivable ENV
  const env = input.env ?? existing.ENV ?? existing.CATALYST_ENV ?? 'Development';
  out.ENV = env;
  out.CATALYST_ENV = env;

  // Derivable Project ID
  const projectId = input.projectId ?? existing.PROJECT_ID ?? existing.CATALYST_PROJECT_ID;
  if (projectId) {
    out.PROJECT_ID = projectId;
    out.CATALYST_PROJECT_ID = projectId;
  }

  // Derivable App URL
  const appUrl = input.appUrl ?? existing.APP_URL ?? existing.CATALYST_APP_URL;
  if (appUrl) {
    out.APP_URL = appUrl;
    out.CATALYST_APP_URL = appUrl;
  }

  // Derivable Bucket
  const bucket = input.bucketName ?? existing.C2C_STRATUS_BUCKET ?? existing.STRATUS_BUCKET;
  if (bucket) {
    out.C2C_STRATUS_BUCKET = bucket;
    out.STRATUS_BUCKET = bucket;
  }

  // Table IDs
  let firstTableId: string | undefined;

  // From input.tables
  if (input.tables) {
    for (const table of input.tables) {
      if (table.id) {
        if (!firstTableId) firstTableId = table.id;
        const nameKey = sanitizeEnvKey(table.name);
        out[`TABLE_${nameKey}_ID`] = table.id;
        out[`TABLE_ID_${nameKey}`] = table.id;
      }
    }
  }

  // From learnedByName
  if (input.learnedByName) {
    for (const [name, id] of Object.entries(input.learnedByName)) {
      if (/^[0-9]+$/.test(id)) {
        if (!firstTableId) firstTableId = id;
        const nameKey = sanitizeEnvKey(name);
        out[`TABLE_${nameKey}_ID`] = id;
        out[`TABLE_ID_${nameKey}`] = id;
      }
    }
  }

  // Existing table keys if not set
  for (const [k, v] of Object.entries(existing)) {
    if (/^TABLE_.*_ID$/.test(k) || /^TABLE_ID_.*$/.test(k)) {
      if (out[k] === undefined) out[k] = v;
      if (!firstTableId && /^[0-9]+$/.test(v)) firstTableId = v;
    }
  }

  if (firstTableId) {
    out.TABLE_ID = firstTableId;
  } else if (existing.TABLE_ID) {
    out.TABLE_ID = existing.TABLE_ID;
  }

  // Declared Connection Secrets
  if (input.connectionSecrets) {
    for (const secret of input.connectionSecrets) {
      // User's existing value is preserved!
      out[secret.envKey] = existing[secret.envKey] ?? secret.secretValue ?? '';
    }
  }

  // Preserve any other existing keys
  for (const [k, v] of Object.entries(existing)) {
    if (out[k] === undefined) {
      out[k] = v;
    }
  }

  return out;
}

export function writeOrUpdateFunctionEnv(
  outDir: string,
  input: FunctionEnvInput,
): { path: string; env: Record<string, string>; connectionSecretKeys: string[] } {
  mkdirSync(outDir, { recursive: true });
  const fenvPath = join(outDir, 'function-env.json');
  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(readFileSync(fenvPath, 'utf8'));
  } catch {
    existing = {};
  }

  const env = buildFunctionEnv({ ...input, existingEnv: existing });
  const tmpPath = `${fenvPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, fenvPath);
  // Replacing an existing file inherits the temporary file's mode; explicitly
  // enforce the secret-file permissions in case the destination predated this fix.
  chmodSync(fenvPath, 0o600);

  const connectionSecretKeys: string[] = [];
  if (input.connectionSecrets) {
    for (const s of input.connectionSecrets) {
      if (!connectionSecretKeys.includes(s.envKey)) connectionSecretKeys.push(s.envKey);
    }
  }
  for (const key of Object.keys(env)) {
    if (!isDerivableEnvKey(key) && !connectionSecretKeys.includes(key)) {
      connectionSecretKeys.push(key);
    }
  }

  return { path: fenvPath, env, connectionSecretKeys };
}

export function readConnectionSecretKeys(outDir: string, knownKeys?: readonly string[]): string[] {
  const keys = new Set<string>(knownKeys ?? []);
  const fenvPath = join(outDir, 'function-env.json');
  try {
    const data = JSON.parse(readFileSync(fenvPath, 'utf8')) as Record<string, unknown>;
    for (const k of Object.keys(data)) {
      if (!isDerivableEnvKey(k)) keys.add(k);
    }
  } catch {
    // ignore
  }
  return [...keys];
}

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
