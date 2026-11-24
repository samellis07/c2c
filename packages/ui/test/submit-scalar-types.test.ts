/**
 * The generated submit endpoint types every scalar field it writes. A JSON
 * array is refused for anything but a genuinely multi-valued field (multi
 * select, checkboxes, multi lookup), a plain object is refused everywhere,
 * a text field caps at its maxchar (or the Creator default the column got),
 * and a typed leaf accepts only the JSON shape its client control sends.
 * Refusals answer like the existing validation errors and never echo the
 * posted value.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

const tab = (n: number) => '\t'.repeat(n);
const field = (name: string, type: string, extra = '') => `${tab(2)}${name}\n${tab(2)}(\n${tab(3)}type = ${type}\n${extra ? `${extra}\n` : ''}${tab(2)})`;

const SOURCE = `application "Demo"
{
${tab(1)}form Person
${tab(1)}{
${field('Person_Name', 'text')}
${tab(1)}}
${tab(1)}form Item
${tab(1)}{
${field('Title', 'text')}
${field('Notes', 'textarea')}
${field('Mail', 'email')}
${field('Site', 'url')}
${field('Phone', 'phone')}
${field('Qty', 'number')}
${field('Price', 'decimal')}
${field('Pct', 'percent')}
${field('Cost', 'currency')}
${field('Due', 'date')}
${field('At', 'datetime')}
${field('Alarm', 'time')}
${field('Flag', 'decision box')}
${field('Tags', 'multiselect', `${tab(3)}values = {"a","b"}`)}
${field('Checks', 'checkboxes', `${tab(3)}values = {"x","y"}`)}
${tab(2)}Member
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = Person.ID
${tab(2)})
${tab(2)}Members
${tab(2)}(
${tab(3)}type = list
${tab(3)}values = Person.ID
${tab(2)})
${tab(1)}}
${tab(1)}list Item_All
${tab(1)}{
${tab(2)}show all rows from Item
${tab(2)}(
${tab(3)}Title
${tab(2)})
${tab(1)}}
${tab(1)}list All_Person
${tab(1)}{
${tab(2)}show all rows from Person
${tab(2)}(
${tab(3)}Person_Name
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
${tab(4)}Item
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Item_All = {"View","Edit"}
${tab(5)}}
${tab(4)}}
${tab(4)}Person
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}All_Person = {"View"}
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

const staff = { user: { profile: 'Staff' } };

async function withSubmit(run: (post: (record: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>): Promise<void> {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-scalar-types-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    for (const file of built.files) {
      const full = join(dir, file.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, file.data);
    }
    const submitPath = 'functions/aio/item/submit.mjs';
    const mod = (await import(pathToFileURL(join(dir, submitPath)).href)) as { default: (req: unknown, res: unknown) => unknown };
    await run((record) => invoke(mod.default, { ...staff, body: { record } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('text-family fields take a capped string only', async () => {
  await withSubmit(async (post) => {
    // Arrays, objects, non-strings and over-length text are refused, without
    // echoing the posted value back.
    for (const record of [
      { Title: ['x'] },
      { Title: { x: 1 } },
      { Title: 5 },
      { Title: true },
      { Title: 'x'.repeat(10240) },
      { Notes: ['x'] },
      { Mail: { x: 1 } },
      { Mail: 7 },
      { Site: ['https://x'] },
      { Phone: { x: 1 } },
    ]) {
      const res = await post(record);
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(record).slice(0, 60)} -> ${res.status} ${JSON.stringify(res.body)}`);
      assert.notEqual(res.body.wrote, true);
      assert.ok(!JSON.stringify(res.body).includes('x'.repeat(500)), 'response must not echo the posted value');
    }
    // The Creator single-line cap applies: 255 stored, 256 refused.
    assert.equal((await post({ Title: 'x'.repeat(255) })).status, 200);
    const over = await post({ Title: 'x'.repeat(256) });
    assert.ok(over.status === 400 || over.status === 403, JSON.stringify(over.body));
    // Valid values are stored unchanged.
    assert.equal((await post({ Title: 'Ada', Notes: 'n', Mail: 'a@b.c', Site: 'https://x.y', Phone: '555' })).status, 200);
  });
});

test('numeric fields take a finite number or its decimal text', async () => {
  await withSubmit(async (post) => {
    for (const record of [{ Qty: ['x'] }, { Qty: { x: 1 } }, { Qty: 'abc' }, { Qty: true }, { Price: ['x'] }, { Price: 'abc' }, { Pct: {} }, { Cost: [1] }]) {
      const res = await post(record);
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(record)} -> ${res.status}`);
      assert.notEqual(res.body.wrote, true);
    }
    assert.equal((await post({ Qty: 5 })).status, 200);
    assert.equal((await post({ Price: '0.105', Pct: 12.5, Cost: '9.99' })).status, 200);
  });
});

test('date, datetime and time take only the posted format text', async () => {
  await withSubmit(async (post) => {
    for (const record of [{ Due: ['x'] }, { Due: { x: 1 } }, { Due: 5 }, { Due: 'Nov 4' }, { Due: '2026-13-40' }, { At: ['x'] }, { At: '2026-11-04T10:30:00Z' }, { Alarm: ['x'] }, { Alarm: '25:00' }, { Alarm: 1030 }]) {
      const res = await post(record);
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(record)} -> ${res.status}`);
      assert.notEqual(res.body.wrote, true);
    }
    assert.equal((await post({ Due: '2026-11-04' })).status, 200);
    assert.equal((await post({ Due: '04-Nov-2026' })).status, 200);
    assert.equal((await post({ At: '2026-11-04 10:30:00' })).status, 200);
    assert.equal((await post({ Alarm: '10:30' })).status, 200);
    assert.equal((await post({ Alarm: '10:30:05' })).status, 200);
  });
});

test('a decision box takes a boolean only', async () => {
  await withSubmit(async (post) => {
    for (const record of [{ Flag: ['x'] }, { Flag: { x: 1 } }, { Flag: 'true' }, { Flag: 1 }]) {
      const res = await post(record);
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(record)} -> ${res.status}`);
      assert.notEqual(res.body.wrote, true);
    }
    assert.equal((await post({ Flag: true })).status, 200);
    assert.equal((await post({ Flag: false })).status, 200);
  });
});

test('arrays pass only for genuinely multi-valued fields', async () => {
  await withSubmit(async (post) => {
    // Multi select and checkboxes take a list of scalars.
    assert.equal((await post({ Tags: ['a', 'b'] })).status, 200);
    assert.equal((await post({ Checks: ['x'] })).status, 200);
    // The list itself is screened: no nested objects or arrays.
    for (const record of [{ Tags: [{ x: 1 }] }, { Tags: [['a']] }, { Checks: [{}] }]) {
      const res = await post(record);
      assert.ok(res.status === 400 || res.status === 403, `${JSON.stringify(record)} -> ${res.status}`);
      assert.notEqual(res.body.wrote, true);
    }
    // A multi lookup takes a list of ids; a single lookup refuses one.
    assert.equal((await post({ Members: ['1', '2'] })).status, 200);
    const single = await post({ Member: ['1'] });
    assert.ok(single.status === 400 || single.status === 403, JSON.stringify(single.body));
    // The single lookup's own shapes still pass.
    assert.equal((await post({ Member: '1' })).status, 200);
    assert.equal((await post({ Member: { id: '1', label: 'Ada' } })).status, 200);
  });
});

test('the write schema marks every plain leaf field', async () => {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const text = String(built.files.find((file) => file.path === 'functions/aio/item/submit.mjs')?.data);
  const fields = JSON.parse(/^export const fields = (.*);$/m.exec(text)![1]!) as { name: string; input?: string; multi?: boolean; maxLength?: number }[];
  const byName = new Map(fields.map((f) => [f.name, f]));
  assert.equal(byName.get('Title')?.input, 'text');
  assert.equal(byName.get('Title')?.maxLength, 255);
  assert.equal(byName.get('Notes')?.maxLength, 10000);
  assert.equal(byName.get('Site')?.maxLength, 10000);
  assert.equal(byName.get('Qty')?.input, 'number');
  assert.equal(byName.get('Price')?.input, 'decimal');
  assert.equal(byName.get('Pct')?.input, 'decimal');
  assert.equal(byName.get('Cost')?.input, 'decimal');
  assert.equal(byName.get('Due')?.input, 'date');
  assert.equal(byName.get('At')?.input, 'datetime');
  assert.equal(byName.get('Alarm')?.input, 'time');
  assert.equal(byName.get('Flag')?.input, 'boolean');
  assert.equal(byName.get('Tags')?.multi, true);
  assert.equal(byName.get('Checks')?.multi, true);
  assert.equal(byName.get('Member')?.multi, undefined);
  assert.equal(byName.get('Members')?.multi, true);
});
