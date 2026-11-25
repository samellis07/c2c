/**
 * Runs generated page and report modules from a written copy of the tree,
 * against the fake datastore: what a deployed function would answer, not the
 * generated text. Shared by the tests that check an endpoint's behaviour.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { mockDatastore } from '../../shims/test/zcql-mock.js';

const SLATE_ORIGIN = 'https://c2c-app-4f3a.onslate.in';
const FUNCTION_HOST = 'c2c-app-1001.development.catalystserverless.in';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export const ADMIN = { profile: 'Administrator', loginUser: 'ada-login', userId: 'u1' };
export const CLERK = { profile: 'Clerk', loginUser: 'cy-login', userId: 'u2' };

/** The generated `functions/*` written to a temp tree whose `node_modules` reaches this package. */
export function loadTree(files: { path: string; data: string | Buffer }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ep-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of files.filter((item) => item.path.startsWith('functions/'))) {
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
  const deploy = join(dir, 'functions/c2c-deploy.json');
  const parsed = JSON.parse(readFileSync(deploy, 'utf8')) as Record<string, unknown>;
  parsed.allowedOrigins = [SLATE_ORIGIN];
  writeFileSync(deploy, `${JSON.stringify(parsed, null, 2)}\n`);
  dirs.push(dir);
  return dir;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** POST `body` to the module at `path` as `user`. */
export async function invoke(dir: string, path: string, user: Record<string, string>, body: unknown): Promise<Reply> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    setHeader() {},
    end(text: string) {
      raw = text;
    },
  };
  const mod = (await import(pathToFileURL(join(dir, path)).href)) as { default(req: unknown, res: unknown): Promise<void> };
  await mod.default({ method: 'POST', headers: { host: FUNCTION_HOST, origin: SLATE_ORIGIN }, user, body }, res);
  return { status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

/** Live mode with a fake datastore installed as the process-wide store; `restore()` undoes both. */
export function liveDatastore() {
  const { datastore } = mockDatastore({});
  const saved = { mode: process.env.C2C_DEPLOY_MODE, zone: process.env.C2C_APP_TIMEZONE, admin: process.env.C2C_ADMIN_USER_ID, store: (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore };
  process.env.C2C_DEPLOY_MODE = 'live';
  process.env.C2C_APP_TIMEZONE = 'UTC';
  process.env.C2C_ADMIN_USER_ID = ADMIN.userId;
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  return {
    datastore,
    restore() {
      for (const [key, value] of [['C2C_DEPLOY_MODE', saved.mode], ['C2C_APP_TIMEZONE', saved.zone], ['C2C_ADMIN_USER_ID', saved.admin]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (saved.store === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
      else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = saved.store;
    },
  };
}
