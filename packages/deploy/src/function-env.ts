import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unquote, type App, type PropertyBlock } from '../../core/src/ir.js';

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
  if (existsSync(fenvPath)) {
    try {
      existing = JSON.parse(readFileSync(fenvPath, 'utf8'));
    } catch {
      existing = {};
    }
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
  if (existsSync(fenvPath)) {
    try {
      const data = JSON.parse(readFileSync(fenvPath, 'utf8')) as Record<string, unknown>;
      for (const k of Object.keys(data)) {
        if (!isDerivableEnvKey(k)) keys.add(k);
      }
    } catch {
      // ignore
    }
  }
  return [...keys];
}
