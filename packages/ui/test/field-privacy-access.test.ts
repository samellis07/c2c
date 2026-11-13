/**
 * Attack tests for a data-privacy-flagged field (docs/field-privacy.md):
 * Contact.SSN is `personal data = true` with no explicit .ds grant for
 * Staff, so fieldGrant (packages/deluge/src/generate.ts) excludes it from
 * Staff's read and write field list by default. Manager has an explicit
 * `visibility:true` grant on it, so it is exempt. Every path below is
 * generated and executed for real — no path is asserted from source text
 * alone.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import { buildUi } from '../src/index.js';

const STAFF = { profile: 'Staff', loginUser: 'staff@example.test' };
const MANAGER = { profile: 'Manager', loginUser: 'manager@example.test' };
const ADMIN = { profile: 'Administrator', loginUser: 'admin@example.test' };

const SRC = `application "Demo"
{
\tform Contact
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tSSN
\t\t(
\t\t\ttype = text
\t\t\tpersonal data = true
\t\t)
\t}
\tform Deal
\t{
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t\tContact_Ref
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Contact.ID
\t\t\tdisplayformat = [SSN]
\t\t)
\t}
\tlist All_Contacts
\t{
\t\tshow all rows from Contact
\t\t(
\t\t\tName
\t\t\tSSN
\t\t)
\t}
\tlist All_Deals
\t{
\t\tshow all rows from Deal
\t\t(
\t\t\tTitle
\t\t\tContact_Ref
\t\t)
\t}
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\tdescription = "This profile has all the permissions by default."
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t}
\t\t}
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tContact
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Contacts = {"View","Add","Edit"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tDeal
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Deals = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\t"Manager"
\t\t{
\t\t\tname = "Manager"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tContact
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Contacts = {"View","Add","Edit"}
\t\t\t\t\t}
\t\t\t\t\tFieldPermissions
\t\t\t\t\t{
\t\t\t\t\t\tName
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t\tSSN
\t\t\t\t\t\t{
\t\t\t\t\t\t\tvisibility:true,readonly:false
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tDeal
\t\t\t\t{
\t\t\t\t\tenabled = true
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Deals = {"View"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(text: string) {
      raw = text;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, raw }));
}

interface Built {
  dir: string;
  files: Map<string, { default: (req: unknown, res: unknown) => unknown }>;
  access: { profiles: Record<string, Record<string, { fields?: string[]; writable?: string[] }>> };
  close(): Promise<void>;
}

async function build(): Promise<Built> {
  const app: App = deriveIr(parse(SRC));
  const ui = buildUi(app);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-field-privacy-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of ui.files) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.data);
  }
  writeFileSync(join(dir, 'functions/c2c-deploy.json'), JSON.stringify({ mode: 'live', appTimeZone: 'UTC' }));
  const access = JSON.parse(ui.files.find((f) => f.path === 'functions/access-policy.json')!.data as string) as Built['access'];
  const named = ['functions/reports/all-contacts.mjs', 'functions/reports/all-deals.mjs', 'functions/aio/contact/record.mjs', 'functions/aio/contact/submit.mjs'];
  const files = new Map<string, { default: (req: unknown, res: unknown) => unknown }>();
  for (const path of named) {
    const file = ui.files.find((f) => f.path === path);
    assert.ok(file, `expected generated file ${path}`);
    files.set(path, (await import(pathToFileURL(join(dir, path)).href)) as { default: (req: unknown, res: unknown) => unknown });
  }
  return {
    dir,
    files,
    access,
    async close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('fieldGrant excludes SSN from Staff by default and keeps it for Manager and Administrator', async () => {
  const built = await build();
  try {
    assert.deepEqual(built.access.profiles.Staff!.Contact!.fields, ['Name']);
    assert.deepEqual(built.access.profiles.Staff!.Contact!.writable, ['Name']);
    assert.deepEqual(built.access.profiles.Manager!.Contact!.fields, ['Name', 'SSN']);
    assert.equal(built.access.profiles.Administrator!.Contact!.fields, undefined, 'Administrator has no field restriction at all');
  } finally {
    await built.close();
  }
});

test('list read: SSN is masked for Staff and present for Manager; the raw response never carries it for Staff', async () => {
  const built = await build();
  try {
    const datastore = mockDatastore({ Contact: ['Name', 'SSN'] }).datastore;
    (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
    await datastore.insert('Contact', [{ Name: 'Ada', SSN: '078-05-1120' }]);
    const report = built.files.get('functions/reports/all-contacts.mjs')!;

    const staff = await invoke(report.default, { user: STAFF, body: { op: 'query', page: 0, pageSize: 10 } });
    assert.equal(staff.status, 200, staff.raw);
    const staffRows = staff.body.rows as Record<string, unknown>[];
    assert.equal(staffRows.length, 1);
    assert.equal(staffRows[0]!.Name, 'Ada');
    assert.equal('SSN' in staffRows[0]!, false);
    assert.doesNotMatch(staff.raw, /078-05-1120/, 'the raw response never carries the masked value');

    const manager = await invoke(report.default, { user: MANAGER, body: { op: 'query', page: 0, pageSize: 10 } });
    assert.equal(manager.status, 200, manager.raw);
    const managerRows = manager.body.rows as Record<string, unknown>[];
    assert.equal(managerRows[0]!.SSN, '078-05-1120');
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await built.close();
  }
});

test('detail read: a direct record fetch masks SSN for Staff', async () => {
  const built = await build();
  try {
    const datastore = mockDatastore({ Contact: ['Name', 'SSN'] }).datastore;
    (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
    const [row] = await datastore.insert('Contact', [{ Name: 'Grace', SSN: '219-09-9999' }]);
    const record = built.files.get('functions/aio/contact/record.mjs')!;

    const staff = await invoke(record.default, { user: STAFF, body: { ROWID: row!.ROWID } });
    assert.equal(staff.status, 200, staff.raw);
    assert.equal('SSN' in (staff.body.record as Record<string, unknown>), false);
    assert.doesNotMatch(staff.raw, /219-09-9999/);

    const manager = await invoke(record.default, { user: MANAGER, body: { ROWID: row!.ROWID } });
    assert.equal(manager.status, 200, manager.raw);
    assert.equal((manager.body.record as Record<string, unknown>).SSN, '219-09-9999');
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await built.close();
  }
});

test('search, sort and filter on SSN never leak it and never error for Staff', async () => {
  const built = await build();
  try {
    const datastore = mockDatastore({ Contact: ['Name', 'SSN'] }).datastore;
    (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
    await datastore.insert('Contact', [
      { Name: 'Ada', SSN: '078-05-1120' },
      { Name: 'Grace', SSN: '219-09-9999' },
    ]);
    const report = built.files.get('functions/reports/all-contacts.mjs')!;

    // body.q (free-text search) only searches readable fields: a search term
    // that matches only a hidden value finds nothing for Staff.
    const search = await invoke(report.default, { user: STAFF, body: { op: 'query', page: 0, pageSize: 10, q: '078-05-1120' } });
    assert.equal(search.status, 200, search.raw);
    assert.deepEqual(search.body.rows, []);

    // body.sort naming a hidden field is dropped: the request still succeeds,
    // ordered by the fallback (ROWID), never erroring and never exposing the
    // sort key's values.
    const sort = await invoke(report.default, { user: STAFF, body: { op: 'query', page: 0, pageSize: 10, sort: [{ field: 'SSN', order: 'desc' }] } });
    assert.equal(sort.status, 200, sort.raw);
    assert.doesNotMatch(sort.raw, /078-05-1120|219-09-9999/);

    // body.filters naming a hidden field is dropped (the leaf is not
    // compiled): the read still succeeds as if the filter were absent, and
    // the probed value never appears in the reply either way.
    const filter = await invoke(report.default, {
      user: STAFF,
      body: { op: 'query', page: 0, pageSize: 10, filters: [{ field: 'SSN', op: '==', value: '078-05-1120' }] },
    });
    assert.equal(filter.status, 200, filter.raw);
    assert.equal((filter.body.rows as unknown[]).length, 2, 'an unreadable filter leaf narrows nothing, so both rows still come back');
    assert.doesNotMatch(filter.raw, /078-05-1120|219-09-9999/);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await built.close();
  }
});

test('count/aggregate side channel: grouping by SSN is refused outright, not folded into bucket keys', async () => {
  const built = await build();
  try {
    const datastore = mockDatastore({ Contact: ['Name', 'SSN'] }).datastore;
    (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
    await datastore.insert('Contact', [
      { Name: 'Ada', SSN: '078-05-1120' },
      { Name: 'Grace', SSN: '219-09-9999' },
    ]);
    const report = built.files.get('functions/reports/all-contacts.mjs')!;

    const grouped = await invoke(report.default, { user: STAFF, body: { op: 'aggregate', group: 'SSN' } });
    assert.equal(grouped.status, 400, grouped.raw);
    assert.equal(grouped.body.buckets, undefined);

    // A hidden measure field just drops that measure; the count alone remains,
    // and no bucket key or value carries SSN.
    const measured = await invoke(report.default, { user: STAFF, body: { op: 'aggregate', group: 'Name', measures: [{ fn: 'sum', field: 'SSN' }] } });
    assert.equal(measured.status, 200, measured.raw);
    assert.deepEqual(measured.body.measures, [{ fn: 'count', field: '' }]);
    assert.doesNotMatch(JSON.stringify(measured.body), /078-05-1120|219-09-9999/);

    // Administrator (no module permissions, Administrator preset) may group by it.
    const admin = await invoke(report.default, { user: ADMIN, body: { op: 'aggregate', group: 'SSN' } });
    assert.equal(admin.status, 200, admin.raw);
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await built.close();
  }
});

test('relation traversal: a lookup display field pointing at SSN resolves empty for Staff, real for Manager', async () => {
  const built = await build();
  try {
    const datastore = mockDatastore({ Contact: ['Name', 'SSN'], Deal: ['Title', 'Contact_Ref'] }).datastore;
    (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
    const [contact] = await datastore.insert('Contact', [{ Name: 'Ada', SSN: '078-05-1120' }]);
    await datastore.insert('Deal', [{ Title: 'Renewal', Contact_Ref: contact!.ROWID }]);
    const deals = await import(pathToFileURL(join(built.dir, 'functions/reports/all-deals.mjs')).href) as { default: (req: unknown, res: unknown) => unknown };

    const staff = await invoke(deals.default, { user: STAFF, body: { op: 'query', page: 0, pageSize: 10 } });
    assert.equal(staff.status, 200, staff.raw);
    const staffRow = (staff.body.rows as Record<string, unknown>[])[0]!;
    assert.equal(staffRow.Contact_Ref, '', 'the display text resolves empty, not the privacy-flagged value, when the caller cannot read it on the parent form');
    assert.doesNotMatch(staff.raw, /078-05-1120/);

    const manager = await invoke(deals.default, { user: MANAGER, body: { op: 'query', page: 0, pageSize: 10 } });
    assert.equal(manager.status, 200, manager.raw);
    assert.equal((manager.body.rows as Record<string, unknown>[])[0]!.Contact_Ref, '078-05-1120');
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await built.close();
  }
});

test('write: Staff cannot post SSN at all, Manager can, and the denial text is the uniform field-access message with no value in it', async () => {
  const built = await build();
  try {
    const datastore = mockDatastore({ Contact: ['Name', 'SSN'] }).datastore;
    (globalThis as Record<string, unknown>).__c2cDatastore = datastore;
    const submit = built.files.get('functions/aio/contact/submit.mjs')!;

    const staffDenied = await invoke(submit.default, { user: STAFF, body: { record: { Name: 'Ada', SSN: '078-05-1120' } } });
    assert.equal(staffDenied.status, 403, staffDenied.raw);
    // The exact generic message authorizeWrite throws for any field hidden
    // from the caller's grant (packages/shims/src/access.ts), privacy-flagged
    // or not: it names the profile, form and field, never a value.
    assert.equal(staffDenied.body.error, 'record access: profile Staff cannot write hidden Contact.SSN');
    assert.doesNotMatch(staffDenied.raw, /078-05-1120/, 'the denial never echoes the rejected value');

    // A plain writable field succeeds, proving the denial above is specific
    // to the privacy-flagged field, not a blanket refusal of the whole form.
    const staffOk = await invoke(submit.default, { user: STAFF, body: { record: { Name: 'Ada' } } });
    assert.equal(staffOk.status, 200, staffOk.raw);

    const managerOk = await invoke(submit.default, { user: MANAGER, body: { record: { Name: 'Ada', SSN: '078-05-1120' } } });
    assert.equal(managerOk.status, 200, managerOk.raw);
    assert.equal((managerOk.body.values as Record<string, unknown>).SSN, '078-05-1120');
  } finally {
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
    await built.close();
  }
});
