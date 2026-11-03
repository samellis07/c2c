import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { auditApp, collectOutputs } from '../../quality/src/no-silent-drop.js';
import { buildModel, buildUi, type UiField, type UiModel } from '../src/index.js';
import { lookupSorts, sortDirOf } from '../src/decorations/lookups.js';
import { lookupOrderMap } from '../src/generate.js';

/**
 * Lookup `sortorder = ascending|descending`: the /lookups/:form/:field query
 * orders by the display's stored column with ROWID as the final tiebreaker,
 * an inline choice list sorts its options, and anything that cannot bind to a
 * stored column stays ROWID-ordered and a counted silent drop.
 */

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

const STAFF = { user: { profile: 'Staff' } };

function hotelBody(): string {
  return `\tsection Main
\t{
\t\tform Add_Room
\t\t{
${field('Room_Number', 'text')}
${field('Price', 'decimal')}
\t\t}
\t\tform Booking
\t\t{
${field('Guest', 'text')}
${field('Room', 'picklist', '\t\t\tvalues = Add_Room.ID\n\t\t\tdisplayformat = [Room_Number]\n\t\t\tsortorder = ascending')}
${field('Suite', 'picklist', '\t\t\tvalues = Add_Room.ID\n\t\t\tdisplayformat = [Price]\n\t\t\tsortorder = descending')}
${field('Status', 'picklist', '\t\t\tvalues = {"Checked Out","Booked","Checked In"}\n\t\t\tsortorder = ascending')}
\t\t}
\t\tlist All_Rooms
\t\t{
\t\t\tshow all rows from Add_Room
\t\t\t(
\t\t\t\tRoom_Number
\t\t\t\tPrice
\t\t\t)
\t\t}
\t\tlist All_Bookings
\t\t{
\t\t\tshow all rows from Booking
\t\t\t(
\t\t\t\tGuest
\t\t\t\tRoom
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
${grant('Add_Room', 'All_Rooms', ['Room_Number', 'Price'])}
${grant('Booking', 'All_Bookings', ['Guest', 'Room', 'Suite', 'Status'])}
\t\t\t}
\t\t}
\t}`;
}

function nameBody(): string {
  return `\tsection Main
\t{
\t\tform Add_Member
\t\t{
${field('Member_ID', 'text')}
\t\t\tName
\t\t\t(
\t\t\t\ttype = name
\t\t\t\tfirst_name
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t\tlast_name
\t\t\t\t(
\t\t\t\t\ttype = text
\t\t\t\t)
\t\t\t)
\t\t}
\t\tform Book_Transaction
\t\t{
${field('Title', 'text')}
${field('Member', 'picklist', '\t\t\tvalues = Add_Member.ID\n\t\t\tdisplayformat = [Member_ID + " - " + Name.first_name]\n\t\t\tsortorder = ascending')}
${field('Mentor', 'picklist', '\t\t\tvalues = Add_Member.ID\n\t\t\tdisplayformat = [Name.first_name]\n\t\t\tsortorder = descending')}
\t\t}
\t\tlist All_Members
\t\t{
\t\t\tshow all rows from Add_Member
\t\t\t(
\t\t\t\tMember_ID
\t\t\t\tName
\t\t\t)
\t\t}
\t\tlist All_Book_Transactions
\t\t{
\t\t\tshow all rows from Book_Transaction
\t\t\t(
\t\t\t\tTitle
\t\t\t\tMember
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
${grant('Add_Member', 'All_Members', ['Member_ID', 'Name'])}
${grant('Book_Transaction', 'All_Book_Transactions', ['Title', 'Member', 'Mentor'])}
\t\t\t}
\t\t}
\t}`;
}

/** A sortorder whose display ref names no stored column of the parent. */
function ghostBody(): string {
  return `\tsection Main
\t{
\t\tform Add_Member
\t\t{
${field('Member_ID', 'text')}
\t\t}
\t\tform Book_Transaction
\t\t{
${field('Title', 'text')}
${field('Member', 'picklist', '\t\t\tvalues = Add_Member.ID\n\t\t\tdisplayformat = [No_Such_Field]\n\t\t\tsortorder = ascending')}
\t\t}
\t\tlist All_Members
\t\t{
\t\t\tshow all rows from Add_Member
\t\t\t(
\t\t\t\tMember_ID
\t\t\t)
\t\t}
\t\tlist All_Book_Transactions
\t\t{
\t\t\tshow all rows from Book_Transaction
\t\t\t(
\t\t\t\tTitle
\t\t\t\tMember
\t\t\t)
\t\t}
\t}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
${grant('Add_Member', 'All_Members', ['Member_ID'])}
${grant('Book_Transaction', 'All_Book_Transactions', ['Title', 'Member'])}
\t\t\t}
\t\t}
\t}`;
}

async function writeBuilt(body: string): Promise<{ dir: string; files: { path: string; data: string | Buffer }[]; load(path: string): Promise<{ default: (req: unknown, res: unknown) => unknown }> }> {
  const built = buildUi(appOf(body));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-lookup-sortorder-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of built.files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.data);
  }
  return {
    dir,
    files: built.files,
    load: (path: string) => import(pathToFileURL(join(dir, path)).href) as Promise<{ default: (req: unknown, res: unknown) => unknown }>,
  };
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

async function withStore<T>(query: (form: string, where: string, limit: number, offset: number, orderBy: string) => unknown[], run: () => Promise<T>): Promise<T> {
  process.env.C2C_DEPLOY_MODE = 'live';
  (globalThis as Record<string, unknown>).__c2cDatastore = { query: async (form: string, where: string, limit: number, offset: number, orderBy: string) => query(form, where, limit, offset, orderBy) };
  try {
    return await run();
  } finally {
    delete process.env.C2C_DEPLOY_MODE;
    delete (globalThis as Record<string, unknown>).__c2cDatastore;
  }
}

function fieldOf(model: UiModel, form: string, name: string): UiField {
  const found = model.forms.find((item) => item.name === form)?.fields.find((item) => item.name === name);
  assert.ok(found, `no ui field ${form}.${name}`);
  return found;
}

const ORDER = /^ORDER BY [A-Za-z_][A-Za-z0-9_]* (ASC|DESC), ROWID$/;

test('lookupSorts carries the direction keyed by parent form and display field', () => {
  const app = appOf(hotelBody());
  const sorts = lookupSorts(app);
  assert.deepEqual(sorts.Add_Room?.Room_Number, { ref: 'Room_Number', dir: 'asc' });
  assert.deepEqual(sorts.Add_Room?.Price, { ref: 'Price', dir: 'desc' });
  const field = app.forms.find((form) => form.name === 'Booking')!.fields.find((item) => item.name === 'Room')!;
  assert.equal(sortDirOf(field), 'asc');
  assert.equal(sortDirOf(app.forms.find((form) => form.name === 'Booking')!.fields.find((item) => item.name === 'Guest')!), undefined);
});

test('the generated lookup query orders by the declared column, ROWID as tiebreaker', async () => {
  const built = await writeBuilt(hotelBody());
  try {
    const stub = readFileSync(join(built.dir, 'functions/lookups/lookup.mjs'), 'utf8');
    assert.ok(stub.includes('ORDER BY Room_Number ASC, ROWID'), 'ascending clause not emitted');
    assert.match(stub, /ORDER BY Price__n DESC, ROWID/, 'decimal sort does not order by the Double shadow');
    const orderBys = [...stub.matchAll(/"orderBy":"([^"]+)"/g)].map((match) => match[1]!);
    assert.ok(orderBys.length >= 2);
    for (const clause of orderBys) assert.match(clause, ORDER, `untrusted clause text: ${clause}`);
    const lookup = await built.load('functions/lookups/lookup.mjs');
    const orders: string[] = [];
    await withStore(
      (form, where, limit, offset, orderBy) => {
        orders.push(orderBy);
        return [];
      },
      async () => {
        const res = await invoke(lookup.default, { ...STAFF, url: '/lookups/Add_Room/Room_Number' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const priced = await invoke(lookup.default, { ...STAFF, url: '/lookups/Add_Room/Price' });
        assert.equal(priced.status, 200, JSON.stringify(priced.body));
      },
    );
    assert.equal(orders[0], 'ORDER BY Room_Number ASC, ROWID');
    assert.ok(orders.length >= 2, `price read did not reach the datastore: ${orders.join(' | ')}`);
    assert.match(orders.at(-1)!, /ORDER BY Price__n DESC, ROWID/);
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('a multi-field format orders by its first field, a composite part by its stored column', () => {
  const app = appOf(nameBody());
  const orders = lookupOrderMap(app);
  assert.equal(orders.Add_Member?.Member_ID?.orderBy, 'ORDER BY Member_ID ASC, ROWID');
  assert.equal(orders.Add_Member?.Name?.orderBy, 'ORDER BY Name_first_name DESC, ROWID');
});

test('a sort with no stored column falls back to ROWID and stays a silent drop', async () => {
  const app = appOf(ghostBody());
  assert.equal(lookupOrderMap(app).Add_Member, undefined, 'ghost display field must not emit a clause');
  const built = await writeBuilt(ghostBody());
  try {
    const stub = readFileSync(join(built.dir, 'functions/lookups/lookup.mjs'), 'utf8');
    assert.doesNotMatch(stub, /ORDER BY No_Such_Field/);
    const lookup = await built.load('functions/lookups/lookup.mjs');
    const orders: string[] = [];
    await withStore(
      (form, where, limit, offset, orderBy) => {
        orders.push(orderBy);
        return [];
      },
      async () => {
        const res = await invoke(lookup.default, { ...STAFF, url: '/lookups/Add_Member/No_Such_Field' });
        assert.notEqual(res.status, 200, 'a caller cannot read a field that is not granted');
        const granted = await invoke(lookup.default, { ...STAFF, url: '/lookups/Add_Member/Member_ID' });
        assert.equal(granted.status, 200, JSON.stringify(granted.body));
      },
    );
    assert.equal(orders.at(-1), 'ORDER BY ROWID');
    const drops = auditApp(app, collectOutputs(app, { model: buildModel(app), uiFiles: built.files }));
    assert.ok(
      drops.some((drop) => drop.kind === 'field-property' && drop.property === 'property sortorder'),
      `unresolvable sortorder must stay a drop: ${JSON.stringify(drops.filter((d) => d.kind === 'field-property').map((d) => d.name))}`,
    );
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('the audit proves sortorder from the emitted query and fails on a mutated stub', async () => {
  const app = appOf(hotelBody());
  const built = await writeBuilt(hotelBody());
  try {
    const drops = auditApp(app, collectOutputs(app, { model: buildModel(app), uiFiles: built.files }));
    assert.ok(
      !drops.some((drop) => drop.kind === 'field-property' && drop.property === 'property sortorder'),
      `sortorder must not drop: ${JSON.stringify(drops.filter((d) => d.name.includes('sortorder')))}`,
    );
    // Mutating the emitted ORDER BY makes the proof fail: the audit reads the
    // generated query, not just the model marker.
    const mutated = built.files.map((file) =>
      file.path === 'functions/lookups/lookup.mjs'
        ? { ...file, data: String(file.data).replace(/ORDER BY [A-Za-z_0-9]+ (ASC|DESC), ROWID/g, 'ORDER BY ROWID') }
        : file,
    );
    const after = auditApp(app, collectOutputs(app, { model: buildModel(app), uiFiles: mutated }));
    assert.ok(
      after.some((drop) => drop.kind === 'field-property' && drop.property === 'property sortorder'),
      'a stub without the clause must not prove sortorder',
    );
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('the widget carries the sort and the dry-run read orders supplied rows', async () => {
  const app = appOf(hotelBody());
  const model = buildModel(app);
  assert.equal(fieldOf(model, 'Booking', 'Room').lookup?.sort, 'asc');
  assert.equal(fieldOf(model, 'Booking', 'Suite').lookup?.sort, 'desc');
  const built = await writeBuilt(hotelBody());
  try {
    const lookup = await built.load('functions/lookups/lookup.mjs');
    const res = await invoke(lookup.default, {
      ...STAFF,
      url: '/lookups/Add_Room/Room_Number',
      body: {
        rows: [
          { ROWID: '2', Room_Number: 'B-12' },
          { ROWID: '1', Room_Number: 'A-01' },
          { ROWID: '3', Room_Number: 'C-30' },
        ],
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((res.body.rows as Record<string, unknown>[]).map((row) => row.ROWID), ['1', '2', '3']);
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test('sortorder on an inline choice list sorts the offered options', () => {
  const app = appOf(hotelBody());
  const model = buildModel(app);
  assert.deepEqual(fieldOf(model, 'Booking', 'Status').choices, ['Booked', 'Checked In', 'Checked Out']);
  const drops = auditApp(app, collectOutputs(app, { model }));
  assert.ok(
    !drops.some((drop) => drop.field === 'Status' && drop.property === 'property sortorder'),
    'the sorted choice list proves the sortorder',
  );
});

test('a sortorder value that is not a direction carries and emits nothing', () => {
  const body = `\tsection Main
\t{
\t\tform Parent
\t\t{
${field('Code', 'text')}
\t\t}
\t\tform Child
\t\t{
${field('Ref', 'picklist', '\t\t\tvalues = Parent.ID\n\t\t\tdisplayformat = [Code]\n\t\t\tsortorder = sideways')}
\t\t}
\t}`;
  const app = appOf(body);
  assert.equal(Object.keys(lookupSorts(app)).length, 0);
  assert.equal(Object.keys(lookupOrderMap(app)).length, 0);
  const model = buildModel(app);
  assert.equal(fieldOf(model, 'Child', 'Ref').lookup?.sort, undefined);
});
