import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, emptyApp, parse, type App, type Field, type Workflow } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import { EXTENSION_KEY, limitValue, plainRecordStages, selectListOf } from '../../schema/src/limits.js';
import { generate } from '../src/generate.js';

const Z = { start: 0, end: 0 };

function textField(name: string): Field {
  return {
    name,
    type: 'text',
    modifiers: [],
    required: false,
    unique: false,
    properties: [],
    subfields: [],
    annotations: [],
    flags: [],
    span: Z,
  };
}

function appOf(count: number): App {
  const workflow: Workflow = {
    name: 'On add',
    form: 'Item',
    event: 'on success',
    deluge: { text: 'rows = Item[F0 == "a"];', span: Z },
    properties: [],
    span: Z,
  };
  return {
    ...emptyApp('empty'),
    name: 'Demo',
    forms: [
      {
        name: 'Item',
        properties: [],
        fields: Array.from({ length: count }, (_, index) => textField(`F${index}`)),
        actions: [],
        blocks: [],
        span: Z,
      },
    ],
    workflows: [workflow],
  };
}

function sources(count: number): string {
  return generate(appOf(count)).files.map((file) => file.source).join('\n');
}

test('a criteria read under the select cap does not gain a zcql option', () => {
  assert.equal(sources(2).includes('zcql:'), false);
});

test('a criteria read past 30 columns on one table is staged and drops no column', () => {
  const wide = limitValue('zcql.select_columns') + 1;
  const text = sources(wide);
  assert.match(text, /shim\.datastore\.query\(ctx, "Item",/);
  const match = /zcql: (\[[\s\S]*?\])/.exec(text);
  assert.ok(match, text.slice(0, 500));
  const queries = JSON.parse(match![1]!) as string[];
  assert.ok(queries.length >= 2);
  const got = new Set<string>();
  for (const sql of queries) {
    const columns = selectListOf(sql);
    assert.ok(columns.length > 0 && columns.length <= limitValue('zcql.select_columns'), sql);
    assert.match(sql, / FROM Item\b/, sql);
    assert.equal(sql.includes('SELECT *'), false);
    for (const column of columns) got.add(column);
  }
  for (let index = 0; index < wide; index++) assert.equal(got.has(`F${index}`), true, `F${index}`);
  const cap = limitValue('datastore.columns_per_table');
  const underSplit = sources(cap - 10);
  assert.match(underSplit, /zcql: \[/);
  assert.equal(underSplit.includes('splits:'), false);
});

test('a split form stages every chunk with a row bind and an unsplit parent does not', () => {
  const cap = limitValue('datastore.columns_per_table');
  const text = sources(cap + 10);
  assert.match(text, /zcql: \[/);
  const match = /zcql: (\[[\s\S]*?\]) \}/.exec(text);
  assert.ok(match, text.slice(0, 500));
  const queries = JSON.parse(match![1]!) as string[];
  assert.ok(queries.length >= 2);
  assert.match(queries[0]!, /FROM Item/);
  for (const sql of queries.slice(1)) {
    assert.match(sql, / IN \(:Item_/, sql);
  }
  assert.match(text, /field: "F0"/);
  assert.equal(text.includes('zcql: []'), false);

  const start = text.indexOf('splits: ');
  assert.ok(start >= 0, 'a split form must publish its column layout');
  let depth = 0;
  let end = -1;
  for (let index = start + 'splits: '.length; index < text.length; index++) {
    const ch = text[index];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  const layout = JSON.parse(text.slice(start + 'splits: '.length, end)) as {
    Item: { base: string; baseColumns: string[]; extensions: { table: string; columns: string[] }[] };
  };
  assert.equal(layout.Item.base, 'Item');
  assert.equal(layout.Item.baseColumns.includes(EXTENSION_KEY), false);
  assert.ok(layout.Item.extensions.length >= 1);
  const placed = [...layout.Item.baseColumns, ...layout.Item.extensions.flatMap((ext) => ext.columns)];
  for (const ext of layout.Item.extensions) assert.equal(ext.columns.includes(EXTENSION_KEY), false);
  for (let index = 0; index < cap + 10; index++) assert.equal(placed.filter((name) => name === `F${index}`).length, 1, `F${index}`);
  assert.equal(sources(cap - 10).includes('splits:'), false);

  const subs = Array.from({ length: cap + 10 }, (_, index) => `\t\t\tS${index}\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)`);
  const child = `application "D"\n{\n\tform Parent\n\t{\n\t\tP1\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t\tLines\n\t\t(\n\t\t\ttype = grid\n${subs.join('\n')}\n\t\t)\n\t}\n}\n`;
  const plan = deriveIr(parse(child));
  assert.equal(plainRecordStages(generateSchema(plan), 'Parent'), null);
});
