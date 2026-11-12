import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { integrityColumns } from '../../data/src/integrity.js';
import { generateSchema } from '../../schema/src/generator.js';
import { applyInitialValues, type WriteField } from '../../shims/src/access.js';
import { encodeMultiValue, multiValueCell, multiValueDefault, parseDelugeList, splitMultiValueText } from '../../shims/src/multi-value.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { checkRow, type WriteRuleColumn } from '../../shims/src/write-rules.js';
import { generateUi } from '../../ui/src/generate.js';
import { readSourceCsv } from '../src/csv.js';

/**
 * A multi-value field (checkboxes, multi select) is stored as one shape — JSON
 * list text — whether the row came from the field default on a new record or
 * from migrate-data. The `.ds` list literal `{"No"}` is never stored as text.
 */
const APP = `application "MultiDefault"
{
form Book
{
Title
(
type = text
)
Featured
(
type = checkboxes
values = {"Yes", "No"}
initial value = {"No"}
)
Tags
(
type = multiselect
values = {"a, b", "say \\"hi\\"", "plain"}
initial value = {"a, b", "say \\"hi\\""}
)
Cleared
(
type = checkboxes
values = {"One", "Two"}
initial value = {}
)
Single
(
type = checkboxes
values = {"Yes", "No"}
initial value = "Yes"
)
}
}`;

const app = deriveIr(parse(APP));
const MULTI = ['Featured', 'Tags', 'Cleared', 'Single'] as const;

function bookRules(): WriteRuleColumn[] {
  const table = generateSchema(app).tables.find((item) => item.form === 'Book' && item.role === 'form')!;
  return integrityColumns(table);
}

function submitFields(): WriteField[] {
  const file = generateUi(app).files.find((item) => item.path.endsWith('aio/book/submit.mjs'));
  assert.ok(file, 'Book submit handler is generated');
  const match = /export const fields = (.*);\n/.exec(String(file.data));
  assert.ok(match, 'submit handler exports its write fields');
  return JSON.parse(match[1]!) as WriteField[];
}

/** A new record with no posted values: the submit defaults, then the live insert. */
async function storedNewRecord(): Promise<Record<string, unknown>> {
  const record: Record<string, unknown> = { Title: 'New' };
  applyInitialValues(record, submitFields());
  const inserted: Record<string, unknown>[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules: { Book: bookRules() },
    datastore: {
      async insert(_form, rows) {
        inserted.push(...rows);
        return rows;
      },
      async query() {
        return [];
      },
      async update(_form, rows) {
        return { updated: rows.length };
      },
      async delete(_form, rowIds) {
        return { deleted: rowIds.length };
      },
    },
  });
  await runtime.shim.datastore.insert(runtime.context({}), 'Book', record);
  assert.equal(inserted.length, 1);
  return inserted[0]!;
}

/** The same values exported from Creator and loaded by migrate-data. */
function migratedRow(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-multi-default-'));
  try {
    writeFileSync(join(dir, 'Book.csv'), 'ID,Title,Featured,Tags,Cleared,Single\n1001,Old,No,"a, b;say ""hi""",,Yes\n');
    const loaded = readSourceCsv(dir, app);
    return loaded.tables.find((table) => table.table === 'Book')!.rows[0]!.columns;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoListSource(value: unknown, where: string): void {
  assert.ok(!(typeof value === 'string' && /^\s*\{/.test(value)), `${where} stores Deluge list source ${JSON.stringify(value)}`);
}

test('Deluge list literals parse to their items, keeping quotes and commas inside a value', () => {
  assert.deepEqual(parseDelugeList('{"No"}'), ['No']);
  assert.deepEqual(parseDelugeList(`{ "a, b" , 'say "hi"', "it\\"s", "x""y" }`), ['a, b', 'say "hi"', 'it"s', 'x"y']);
  assert.deepEqual(parseDelugeList('{"{braced}"}'), ['{braced}']);
  assert.deepEqual(parseDelugeList('{}'), []);
  assert.deepEqual(parseDelugeList('{1, 2.5, true}'), ['1', '2.5', 'true']);
  assert.equal(parseDelugeList('{zoho.loginuser}'), undefined);
  assert.equal(parseDelugeList('{"a" "b"}'), undefined);
  assert.equal(parseDelugeList('{"open}'), undefined);
  assert.equal(parseDelugeList('"No"'), undefined);
});

test('the field-default compiler gives the stored JSON list shape', () => {
  assert.equal(multiValueDefault('{"No"}'), '["No"]');
  assert.equal(multiValueDefault('{"a, b", "say \\"hi\\""}'), JSON.stringify(['a, b', 'say "hi"']));
  assert.equal(multiValueDefault('"Yes"'), '["Yes"]');
  assert.equal(multiValueDefault("'it''s'"), JSON.stringify(["it's"]));
  assert.equal(multiValueDefault('{}'), undefined, 'an empty list is no default');
  assert.equal(multiValueDefault('{"", "  "}'), undefined, 'blank items are no default');
  assert.equal(multiValueDefault('zoho.loginuser'), undefined, 'a dynamic default is never stored as source');
  assert.equal(multiValueDefault('{input.Other}'), undefined);
  assert.equal(encodeMultiValue([' a ', '', null, 3]), '["a","3"]');
});

test('every multi-value write is one shape, and a raw {..} cell is never stored', () => {
  assert.equal(multiValueCell(['No']), '["No"]');
  assert.equal(multiValueCell('{"No"}'), '["No"]');
  assert.equal(multiValueCell('["No"]'), '["No"]');
  assert.equal(multiValueCell('[ "No" ]'), '["No"]', 'JSON list text is re-encoded canonically');
  assert.equal(multiValueCell('No'), '["No"]');
  assert.equal(multiValueCell([]), null);
  assert.equal(multiValueCell(''), null);
  assert.equal(multiValueCell('{not a list'), '["{not a list"]');
  const columns: WriteRuleColumn[] = [{ name: 'Featured', dataType: 'Text', multiValue: true }];
  for (const cell of ['{"No"}', '{ "No" , "Yes" }', '{zoho.loginuser}', '{}', ['No'], '["No"]']) {
    const { cells, refusals } = checkRow(columns, { Featured: cell });
    assert.deepEqual(refusals, []);
    assertNoListSource(cells.Featured, `write of ${JSON.stringify(cell)}`);
  }
  assert.equal(checkRow(columns, { Featured: '{"No"}' }).cells.Featured, '["No"]');
  const required: WriteRuleColumn[] = [{ name: 'Featured', dataType: 'Text', multiValue: true, required: true }];
  assert.deepEqual(checkRow(required, { Featured: ['', ' '] }).refusals, [{ column: 'Featured', rule: 'mandatory-missing' }]);
});

test('the generated schema marks multi-value columns for the write path', () => {
  const rules = new Map(bookRules().map((column) => [column.name, column]));
  for (const name of MULTI) assert.equal(rules.get(name)?.multiValue, true, `${name} is a multi-value column`);
  assert.equal(rules.get('Title')?.multiValue, undefined);
});

test('a new record stores its multi-value defaults in the migrated shape', async () => {
  const fields = new Map(submitFields().map((field) => [field.name, field]));
  assert.equal(fields.get('Featured')?.defaultValue, '["No"]');
  assert.equal(fields.get('Tags')?.defaultValue, JSON.stringify(['a, b', 'say "hi"']));
  assert.equal(fields.get('Cleared')?.defaultValue, undefined, 'an empty list default is no default');
  assert.equal(fields.get('Single')?.defaultValue, '["Yes"]');

  const stored = await storedNewRecord();
  const migrated = migratedRow();
  for (const name of MULTI) {
    assertNoListSource(stored[name], `new record ${name}`);
    assertNoListSource(migrated[name], `migrated ${name}`);
    assert.equal(stored[name], migrated[name], `${name}: a new record and a migrated row hold the same shape`);
  }
  assert.deepEqual(JSON.parse(String(stored.Featured)), ['No']);
  assert.deepEqual(JSON.parse(String(stored.Tags)), ['a, b', 'say "hi"']);
  assert.equal(stored.Cleared, undefined);
});

test('a posted multi-value list is stored in the migrated shape', async () => {
  const rules = bookRules();
  const posted = checkRow(rules, { Featured: ['No'], Tags: ['a, b', 'say "hi"'] }, {}).cells;
  const migrated = migratedRow();
  assert.equal(posted.Featured, migrated.Featured);
  assert.equal(posted.Tags, migrated.Tags);
});

test('no generated file carries a Deluge list literal as a default', () => {
  for (const file of generateUi(app).files) {
    const text = String(file.data);
    assert.ok(!/"defaultValue":\s*"\s*\{/.test(text), `${file.path} has a {..} defaultValue`);
  }
  const model = generateUi(app).model.forms.find((form) => form.name === 'Book')!;
  const prefill = new Map(model.fields.map((field) => [field.name, field.initialValue]));
  assert.equal(prefill.get('Featured'), '["No"]', 'the form prefill is the stored shape');
  assert.equal(prefill.get('Cleared'), undefined);
});

test('migrate-data reads a list-shaped export cell as its choices, never as one choice', () => {
  for (const cell of ['[No]', '{"No"}', '["No"]', 'No']) assert.deepEqual(splitMultiValueText(cell), ['No'], cell);
  assert.deepEqual(splitMultiValueText('Red;Blue'), ['Red', 'Blue']);
  assert.deepEqual(splitMultiValueText('[Red, Blue]'), ['Red', 'Blue']);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-multi-legacy-'));
  try {
    writeFileSync(join(dir, 'Book.csv'), 'ID,Title,Featured,Tags\n1,A,[No],"[plain]"\n2,B,"{""No""}","[""plain""]"\n3,C,"[""No""]",plain\n');
    const rows = readSourceCsv(dir, app).tables.find((table) => table.table === 'Book')!.rows;
    assert.deepEqual(rows.map((row) => [row.columns.Featured, row.columns.Tags]), [
      ['["No"]', '["plain"]'],
      ['["No"]', '["plain"]'],
      ['["No"]', '["plain"]'],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
