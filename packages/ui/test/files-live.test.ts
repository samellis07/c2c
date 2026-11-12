import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);
const HASH = 'b'.repeat(64);

function field(name: string, type: string): string {
  return `${tab(2)}${name}\n${tab(2)}(\n${tab(3)}type = ${type}\n${tab(2)})`;
}

function grant(name: string): string {
  return `${tab(5)}${name}\n${tab(5)}{\n${tab(6)}visibility:true,readonly:false\n${tab(5)}}`;
}

const SOURCE = `application "Demo"
{
${tab(1)}form Order
${tab(1)}{
${field('Customer', 'text')}
${field('Photo', 'image')}
${field('Sign', 'signature')}
${tab(1)}}
${tab(1)}list Order_All
${tab(1)}{
${tab(2)}show all rows from Order
${tab(2)}(
${tab(3)}Customer
${tab(3)}Photo
${tab(2)})
${tab(1)}}
${tab(1)}share_settings
${tab(1)}{
${tab(2)}"Staff"
${tab(2)}{
${tab(3)}name = "Staff"
${tab(3)}type = Users_Permissions
${tab(3)}ModulePermissions
${tab(3)}{
${tab(4)}Order
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Order_All = {"View","Edit"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${['Customer', 'Photo', 'Sign'].map(grant).join('\n')}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

function emit(source = SOURCE): { dir: string; files: Map<string, string | Buffer> } {
  const built = buildUi(deriveIr(parse(source)));
  const files = new Map(built.files.map((file) => [file.path, file.data]));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-files-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const [path, data] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  return { dir, files };
}

async function withLive<T>(datastore: unknown, fn: () => Promise<T>): Promise<T> {
  process.env.C2C_DEPLOY_MODE = 'live';
  process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
  try {
    return await fn();
  } finally {
    delete process.env.C2C_DEPLOY_MODE;
    delete process.env.C2C_APP_TIMEZONE;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
  }
}

const staff = { user: { profile: 'Staff' } };

async function load(dir: string, path: string) {
  return import(pathToFileURL(join(dir, path)).href);
}

test('an app with no file field gets no download route and no file store module', () => {
  const plain = SOURCE.replace(`${field('Photo', 'image')}\n${field('Sign', 'signature')}\n`, '').replace(`${tab(3)}Photo\n`, '');
  const built = buildUi(deriveIr(parse(plain)));
  const paths = built.files.map((file) => file.path);
  assert.ok(paths.includes('functions/uploads/stratus-upload.mjs'));
  assert.ok(!paths.includes('functions/uploads/stratus-download.mjs'));
  assert.ok(!paths.includes('functions/c2c-files.mjs'));
});

test('live upload returns a signed Stratus PUT for a file field; dry run still signs nothing', async () => {
  const { dir, files } = emit();
  try {
    assert.match(String(files.get('functions/uploads/stratus-upload.mjs')), /export const fileFields = \{"Order":\["Photo","Sign"\]\}/);
    const upload = await load(dir, 'functions/uploads/stratus-upload.mjs');
    const filesMod = await load(dir, 'functions/c2c-files.mjs');
    const req = (fieldName: string, body: Record<string, unknown>) => ({ ...staff, params: { form: 'Order', field: fieldName }, body });

    const dry = await invoke(upload.default, req('Photo', { filename: 'a.png' }));
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.body.reference, { key: 'dry-run/Order/Photo/a.png' });
    assert.equal(Object.hasOwn(dry.body, 'upload'), false);

    const unconfigured = await withLive({}, () => invoke(upload.default, req('Photo', { filename: 'a.png', sha256: HASH })));
    assert.equal(unconfigured.status, 500);
    assert.match(String(unconfigured.body.error), /file store is not configured/);

    const signed: unknown[] = [];
    filesMod.setFileStore({
      async signedUrl(key: string, action: string, options: unknown) {
        signed.push([key, action, options]);
        return 'https://c2c-development.zohostratus.in/_signed/x';
      },
    });
    try {
      const ok = await withLive({}, () => invoke(upload.default, req('Photo', { filename: 'a.png', sha256: HASH, contentType: 'image/png' })));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(ok.body.reference, { key: `uploads/Order/Photo/${HASH}/a.png` });
      assert.deepEqual(ok.body.upload, { method: 'PUT', url: 'https://c2c-development.zohostratus.in/_signed/x', headers: { 'Content-Type': 'image/png' }, expiresIn: 600 });
      assert.deepEqual(signed, [[`uploads/Order/Photo/${HASH}/a.png`, 'PUT', { expiresIn: 600, contentType: 'image/png' }]]);

      const notFile = await withLive({}, () => invoke(upload.default, req('Customer', { filename: 'a.png', sha256: HASH })));
      assert.equal(notFile.status, 404);
      const badHash = await withLive({}, () => invoke(upload.default, req('Photo', { filename: 'a.png', sha256: 'zz' })));
      assert.equal(badHash.status, 400);
      assert.equal(signed.length, 1);
    } finally {
      filesMod.setFileStore(null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('submit stores the Stratus key string, and refuses a key that belongs to another field', async () => {
  const { dir, files } = emit();
  try {
    assert.match(String(files.get('functions/aio/order/submit.mjs')), /storeFileKeys\(targetForm, ctx\.record, fileFields\)/);
    const submit = await load(dir, 'functions/aio/order/submit.mjs');
    const stored: Record<string, unknown>[] = [];
    const datastore = {
      async insert(_form: string, rows: Record<string, unknown>[]) {
        stored.push(...rows);
        return rows.map((row) => ({ ...row, ROWID: '5' }));
      },
    };
    const key = `uploads/Order/Photo/${HASH}/a.png`;
    const ok = await withLive(datastore, () => invoke(submit.default, { ...staff, body: { record: { Customer: 'Ann', Photo: { key } } } }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(stored[0].Photo, key);
    const wrong = await withLive(datastore, () =>
      invoke(submit.default, { ...staff, body: { record: { Customer: 'Bo', Sign: { key } } } }),
    );
    assert.notEqual(wrong.status, 200);
    assert.equal(stored.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('download signs a GET for the key on a row the caller can read; the key never comes from the request', async () => {
  const { dir } = emit();
  try {
    const download = await load(dir, 'functions/uploads/stratus-download.mjs');
    const filesMod = await load(dir, 'functions/c2c-files.mjs');
    const key = 'migrated/Order/Photo/4400000000000000123/cat.jpg';
    const wheres: string[] = [];
    const datastore = {
      async query(form: string, where: string) {
        wheres.push(`${form}: ${where}`);
        return /ROWID = '5'/.test(where) ? [{ ROWID: '5', Photo: key, Sign: 'migrated/Other/Sign/1/x.png' }] : [];
      },
    };
    const req = (fieldName: string, body: Record<string, unknown>) => ({ ...staff, params: { form: 'Order', field: fieldName }, body });
    filesMod.setFileStore({ signedUrl: async (k: string, action: string) => `https://signed/${action}/${k}` });
    try {
      const dry = await invoke(download.default, req('Photo', { rowId: '5' }));
      assert.deepEqual(dry.body, { dryRun: true, url: null });
      const ok = await withLive(datastore, () => invoke(download.default, req('Photo', { rowId: '5', key: 'migrated/Order/Photo/9/evil.jpg' })));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.url, `https://signed/GET/${key}`);
      assert.equal(ok.body.key, key);
      assert.match(wheres[0], /^Order: .*ROWID = '5'/);
      const missing = await withLive(datastore, () => invoke(download.default, req('Photo', { rowId: '6' })));
      assert.equal(missing.status, 404);
      const foreign = await withLive(datastore, () => invoke(download.default, req('Sign', { rowId: '5' })));
      assert.equal(foreign.status, 409);
      const notFile = await withLive(datastore, () => invoke(download.default, req('Customer', { rowId: '5' })));
      assert.equal(notFile.status, 404);
      const badId = await withLive(datastore, () => invoke(download.default, req('Photo', { rowId: "5' OR '1'='1" })));
      assert.equal(badId.status, 400);
      const anon = await withLive(datastore, () => invoke(download.default, { params: { form: 'Order', field: 'Photo' }, body: { rowId: '5' } }));
      assert.equal(anon.status, 401);
    } finally {
      filesMod.setFileStore(null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
