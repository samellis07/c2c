/**
 * `others option = true` writes screened at the generated server: a direct
 * POST to the submit handler (bypassing the client) must refuse an
 * over-length Others text, a non-string value, and the `__c2c_others__`
 * marker itself, and a mandatory others-option field must refuse a blank
 * text like any required field left empty.
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

const SOURCE = `application "Demo"
{
${tab(1)}form Task
${tab(1)}{
${tab(2)}Priority
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = {"Low","High"}
${tab(3)}others option = true
${tab(3)}maxchar = 40
${tab(2)})
${tab(2)}must have Reason
${tab(2)}(
${tab(3)}type = radiobuttons
${tab(3)}values = {"S","M"}
${tab(3)}others option = true
${tab(2)})
${tab(2)}Sealed
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}values = {"a","b"}
${tab(2)})
${tab(1)}}
${tab(1)}list Task_All
${tab(1)}{
${tab(2)}show all rows from Task
${tab(2)}(
${tab(3)}Priority
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
${tab(4)}Task
${tab(4)}{
${tab(5)}enabled = true
${tab(5)}ReportPermissions
${tab(5)}{
${tab(6)}Task_All = {"View","Edit"}
${tab(5)}}
${tab(5)}FieldPermissions
${tab(5)}{
${['Priority', 'Reason', 'Sealed'].map((name) => `${tab(5)}${name}\n${tab(5)}{\n${tab(6)}visibility:true,readonly:false\n${tab(5)}}`).join('\n')}
${tab(5)}}
${tab(4)}}
${tab(3)}}
${tab(2)}}
${tab(1)}}
}
`;

interface Row extends Record<string, unknown> {
  ROWID: string;
}

/** In-memory adapter in the datastore slot shape. */
function memoryDatastore() {
  const tables = new Map<string, Row[]>();
  let next = 100;
  const rows = (t: string) => (tables.has(t) ? tables.get(t)! : (tables.set(t, []), tables.get(t)!));
  return {
    tables,
    async insert(table: string, batch: Record<string, unknown>[]) {
      const stored = batch.map((row) => ({ ...row, ROWID: String(next++) }));
      rows(table).push(...stored);
      return stored;
    },
    async update(table: string, batch: Record<string, unknown>[]) {
      for (const change of batch) {
        const row = rows(table).find((item) => item.ROWID === String(change.ROWID));
        if (row) Object.assign(row, change);
      }
      return batch;
    },
    async query(table: string, where: string, limit: number, offset = 0) {
      const w = where.trim().replace(/^\((.*)\)$/, '$1');
      const match = (row: Row) => {
        if (!w || w === 'true') return true;
        const eq = /^(\w+) = '([^']*)'$/.exec(w);
        if (eq) return String(row[eq[1]]) === eq[2];
        throw new Error(`unexpected where ${where}`);
      };
      return rows(table).filter(match).slice(offset, offset + limit).map((row) => ({ ...row }));
    },
    async delete(table: string, ids: readonly unknown[]) {
      tables.set(table, rows(table).filter((row) => !ids.map(String).includes(row.ROWID)));
      return ids;
    },
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

function emit(): string {
  const built = buildUi(deriveIr(parse(SOURCE)));
  const dir = mkdtempSync(join(tmpdir(), 'c2c-others-server-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of built.files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.data);
  }
  return dir;
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

test('the submit stub carries the others-option write marks', async () => {
  const dir = emit();
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/task/submit.mjs')).href);
    const byName = new Map((mod.fields as { name: string; othersOption?: boolean; maxLength?: number; required?: boolean; choices?: string[] }[]).map((f) => [f.name, f]));
    assert.equal(byName.get('Priority')?.othersOption, true);
    assert.equal(byName.get('Priority')?.maxLength, 40);
    assert.equal(byName.get('Reason')?.othersOption, true);
    assert.equal(byName.get('Reason')?.maxLength, 255);
    assert.equal(byName.get('Reason')?.required, true);
    assert.equal(byName.get('Sealed')?.othersOption, undefined);
    assert.deepEqual(byName.get('Sealed')?.choices, ['a', 'b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a direct POST cannot write a bad Others value through the generated submit', async () => {
  const dir = emit();
  try {
    const mod = await import(pathToFileURL(join(dir, 'functions/aio/task/submit.mjs')).href);
    const store = memoryDatastore();
    const post = (record: Record<string, unknown>) => withLive(store, () => invoke(mod.default, { ...staff, body: { record } }));
    const base = { Priority: 'Low', Reason: 'S', Sealed: 'a' };

    // Control: a typed Others text within the cap is stored verbatim.
    const ok = await post({ ...base, Priority: 'Custom answer' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(store.tables.get('Task')!.length, 1);
    assert.equal(store.tables.get('Task')![0]!.Priority, 'Custom answer');

    const refused = async (label: string, record: Record<string, unknown>, want: number[]) => {
      const before = store.tables.get('Task')!.length;
      const out = await post(record);
      assert.ok(want.includes(out.status), `${label}: ${out.status} ${JSON.stringify(out.body)}`);
      assert.equal(store.tables.get('Task')!.length, before, `${label} stored a row`);
      return out;
    };

    // Over-length free text: refused like a store write-rule failure.
    const tooLong = await refused('10KB others text', { ...base, Priority: 'x'.repeat(10 * 1024) }, [400]);
    assert.equal(tooLong.body.code, 'INVALID_INPUT');
    // The cap is the field's maxchar, not just the 255 default.
    await refused('over maxchar', { ...base, Priority: 'x'.repeat(41) }, [400]);

    // Non-string shapes: refused like an unwritable value.
    await refused('array', { ...base, Priority: ['x'] }, [403]);
    await refused('object', { ...base, Priority: { x: 1 } }, [403]);

    // The client marker itself is never a stored value.
    await refused('sentinel', { ...base, Priority: '__c2c_others__' }, [403]);
    await refused('sentinel on required', { ...base, Reason: '__c2c_others__' }, [403]);

    // A blank Others text on a mandatory field is a missing required value.
    const blank = await refused('blank required others text', { ...base, Reason: '' }, [422]);
    assert.equal(blank.body.code, 'MANDATORY_MISSING');

    // Listed choices and an empty text on the optional field still write.
    const listed = await post({ ...base, Reason: 'M' });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const emptyOptional = await post({ ...base, Priority: '', Reason: 'S' });
    assert.equal(emptyOptional.status, 200, JSON.stringify(emptyOptional.body));

    // The sealed picklist still refuses an out-of-list value.
    await refused('sealed out-of-list', { ...base, Sealed: 'z' }, [400]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
