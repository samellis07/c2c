/**
 * Advanced field search (`advanced field search = true` on a lookup field):
 * the generated /lookups/:form/:field endpoint searches every column of the
 * parent the caller's profile grants, not just the display field. A profile
 * with an explicit FieldPermissions allowlist searches only those columns; a
 * profile with no FieldPermissions block on the parent form (every field
 * readable, the convention projectFields/searchColumns already use) must
 * still search -- not silently return zero rows for every query.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildUi } from '../src/index.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = ''): string {
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${name}\n\t\t(\n${lines}\n\t\t)`;
}

function grant(form: string, report: string, fields: string[]): string {
  return `\t\t\t\t${form}
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\t${report} = {"View"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
${fields.map((name) => `\t\t\t\t\t\t${name}\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tvisibility:true,readonly:false\n\t\t\t\t\t\t}`).join('\n')}
\t\t\t\t\t}
\t\t\t\t}`;
}

/** A grant with no FieldPermissions block: every field of the form is readable. */
function grantAll(form: string, report: string): string {
  return `\t\t\t\t${form}
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\t${report} = {"View"}
\t\t\t\t\t}
\t\t\t\t}`;
}

/**
 * Vendor has a readable Name and a Secret the "Restricted" profile's
 * FieldPermissions never lists. Order.For_Vendor is a lookup directly on
 * Vendor.Name (no displayformat indirection) with advanced field search
 * enabled, so the generated endpoint's display route segment ("Name")
 * matches the advancedSearch table's key exactly. "Restricted" grants Vendor
 * with an explicit field allowlist (Name only); "Open" grants Vendor with no
 * FieldPermissions block at all, the common "no per-field ACL authored" case.
 * The Vendor form name is parameterized so each test gets its own fake-sdk
 * table: the harness's in-memory store is a module-level singleton shared by
 * every test in this file.
 */
function body(vendorForm: string, orderForm: string, vendorList: string, orderList: string): string {
  return `\tsection Main
\t{
\t\tform ${vendorForm}
\t\t{
${field('Name', 'text')}
${field('Secret', 'text')}
\t\t}
\t\tform ${orderForm}
\t\t{
${field('For_Vendor', 'picklist', `\t\t\tvalues = ${vendorForm}.Name\n\t\t\tadvanced field search = true`)}
\t\t}
\t\tlist ${vendorList}
\t\t{
\t\t\tshow all rows from ${vendorForm}
\t\t\t(
\t\t\t\tName
\t\t\t\tSecret
\t\t\t)
\t\t}
\t\tlist ${orderList}
\t\t{
\t\t\tshow all rows from ${orderForm}
\t\t\t(
\t\t\t\tFor_Vendor
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Restricted"
\t\t{
\t\t\tname = "Restricted"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
${grant(vendorForm, vendorList, ['Name'])}
${grant(orderForm, orderList, ['For_Vendor'])}
\t\t\t}
\t\t}
\t\t"Open"
\t\t{
\t\t\tname = "Open"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
${grantAll(vendorForm, vendorList)}
${grant(orderForm, orderList, ['For_Vendor'])}
\t\t\t}
\t\t}
\t}`;
}

async function writeBuilt(appBody: string): Promise<{ dir: string }> {
  const built = buildUi(appOf(appBody));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-advanced-lookup-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of built.files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.data);
  }
  return { dir };
}

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

interface FakeSdk {
  initialize(req: unknown): { datastore(): { table(name: string): { insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> } } };
}

interface SdkDatastore {
  query(form: string, where: string, limit: number, offset?: number, orderBy?: string, columns?: unknown): Promise<Record<string, unknown>[]>;
}

async function liveLookup(dir: string): Promise<{
  lookup: { default: (req: unknown, res: unknown) => unknown };
  insert(form: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
}> {
  const require = createRequire(import.meta.url);
  const root = repoRoot();
  const fakeSdk = require(join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs')) as FakeSdk;
  const { createSdkDatastore } = (await import(
    pathToFileURL(join(root, 'packages/deploy/fn/c2c-sdk-datastore.mjs')).href
  )) as { createSdkDatastore: (app: unknown, opts?: Record<string, unknown>) => SdkDatastore };
  const sdkApp = fakeSdk.initialize({});
  const datastore = createSdkDatastore(sdkApp, { projections: () => '*' });
  const store = (await import(pathToFileURL(join(dir, 'functions/c2c-store.mjs')).href)) as { setDatastore(next: unknown): unknown };
  store.setDatastore(datastore);
  const lookup = (await import(pathToFileURL(join(dir, 'functions/lookups/lookup.mjs')).href)) as {
    default: (req: unknown, res: unknown) => unknown;
  };
  return {
    lookup,
    insert: (form, rows) => sdkApp.datastore().table(form).insertRows(rows),
  };
}

test('an open grant (no FieldPermissions on the parent) still finds advanced-search matches, live', async () => {
  const built = await writeBuilt(body('Vendor1', 'Order1', 'All_Vendors1', 'All_Orders1'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  try {
    process.env.C2C_DEPLOY_MODE = 'live';
    const { lookup, insert } = await liveLookup(built.dir);
    await insert('Vendor1', [{ Name: 'Acme Corp', Secret: 'swordfish' }]);

    const res = await invoke(lookup.default, { user: { profile: 'Open' }, url: '/lookups/Vendor1/Name?q=Acme' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = res.body.rows as Record<string, unknown>[];
    assert.equal(rows.length, 1, `open-grant advanced search must find the match: ${JSON.stringify(res.body)}`);
    assert.equal(rows[0]!.Name, 'Acme Corp');
    assert.equal(Object.prototype.hasOwnProperty.call(rows[0]!, 'Secret'), false, 'the lookup option never carries sibling fields');
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('an open grant also finds a match on a field the display does not name, live and dry-run', async () => {
  const built = await writeBuilt(body('Vendor2', 'Order2', 'All_Vendors2', 'All_Orders2'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  try {
    process.env.C2C_DEPLOY_MODE = 'live';
    const { lookup, insert } = await liveLookup(built.dir);
    await insert('Vendor2', [{ Name: 'Acme Corp', Secret: 'swordfish' }]);

    // "Open" grants every Vendor field, so the profile legitimately reads
    // Secret too; advanced search over "every readable field" covers it.
    const live = await invoke(lookup.default, { user: { profile: 'Open' }, url: '/lookups/Vendor2/Name?q=swordfish' });
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.equal((live.body.rows as unknown[]).length, 1, `open-grant search over a non-display field: ${JSON.stringify(live.body)}`);

    delete process.env.C2C_DEPLOY_MODE;
    const dry = await invoke(lookup.default, {
      user: { profile: 'Open' },
      url: '/lookups/Vendor2/Name?q=swordfish',
      body: { rows: [{ ROWID: '1', Name: 'Acme Corp', Secret: 'swordfish' }, { ROWID: '2', Name: 'Other Co', Secret: 'unrelated' }] },
    });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal((dry.body.rows as unknown[]).length, 1, `open-grant dry-run search over a non-display field: ${JSON.stringify(dry.body)}`);
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('a restricted field grant searches only its allowlist, never a field it excludes', async () => {
  const built = await writeBuilt(body('Vendor3', 'Order3', 'All_Vendors3', 'All_Orders3'));
  const prevMode = process.env.C2C_DEPLOY_MODE;
  try {
    process.env.C2C_DEPLOY_MODE = 'live';
    const { lookup, insert } = await liveLookup(built.dir);
    await insert('Vendor3', [{ Name: 'Acme Corp', Secret: 'swordfish' }]);

    // Name is in the allowlist: a readable match is still found.
    const match = await invoke(lookup.default, { user: { profile: 'Restricted' }, url: '/lookups/Vendor3/Name?q=Acme' });
    assert.equal(match.status, 200, JSON.stringify(match.body));
    assert.equal((match.body.rows as unknown[]).length, 1, `restricted grant must still find an allowed match: ${JSON.stringify(match.body)}`);

    // Secret is excluded from the allowlist: searching its stored value never
    // matches, live or dry-run, even though the row exists.
    const liveHidden = await invoke(lookup.default, { user: { profile: 'Restricted' }, url: '/lookups/Vendor3/Name?q=swordfish' });
    assert.equal(liveHidden.status, 200, JSON.stringify(liveHidden.body));
    assert.equal((liveHidden.body.rows as unknown[]).length, 0, `a field outside the allowlist must never be searched, live: ${JSON.stringify(liveHidden.body)}`);

    delete process.env.C2C_DEPLOY_MODE;
    const dryHidden = await invoke(lookup.default, {
      user: { profile: 'Restricted' },
      url: '/lookups/Vendor3/Name?q=swordfish',
      body: { rows: [{ ROWID: '1', Name: 'Acme Corp', Secret: 'swordfish' }] },
    });
    assert.equal(dryHidden.status, 200, JSON.stringify(dryHidden.body));
    assert.equal((dryHidden.body.rows as unknown[]).length, 0, `a field outside the allowlist must never be searched, dry-run: ${JSON.stringify(dryHidden.body)}`);
  } finally {
    if (prevMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prevMode;
    rmSync(built.dir, { recursive: true, force: true });
  }
});
