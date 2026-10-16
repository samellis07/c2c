import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import {
  FIELD_TYPES,
  corpusNumbers,
  flowHistoryTable,
  formatCorpusReport,
  UNIQUE_VARCHAR_MAX_PER_TABLE,
  generateSchema,
  isStoreVarchar,
  loadCorpusApps,
  projectNameFor,
  schemaAsJson,
  schemaAsReport,
  schemaMappingMarkdown,
  type SchemaPlan,
} from '../src/index.js';

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${head}\n\t\t(\n${lines}\n\t\t)`;
}

function form(name: string, fields: string): string {
  return `\tform ${name}\n\t{\n${fields}\n\t}`;
}

function planOf(fields: string, formName = 'Item'): SchemaPlan {
  return generateSchema(appOf(form(formName, fields)));
}

test('every mapped field type has a status, a reason, and a plan', () => {
  assert.ok(FIELD_TYPES.length >= 43);
  const ids = new Set(FIELD_TYPES.map((row) => row.id));
  assert.equal(ids.size, FIELD_TYPES.length);
  for (const row of FIELD_TYPES) {
    assert.ok(row.reason.length > 20, row.id);
    for (const token of row.tokens) {
      const plan = planOf(field('F', token));
      const outcome = plan.fields.find((item) => item.field === 'F');
      assert.ok(outcome, `${row.id} / ${token}`);
      assert.equal(outcome.matrixId, row.id, token);
      assert.equal(outcome.status, row.status, token);
      assert.equal(outcome.reason, row.reason);
      const stored = plan.tables.flatMap((table) => table.columns).some((column) => column.matrixId === row.id);
      if (row.kind === 'none') assert.equal(stored, false, token);
      else assert.equal(stored, true, token);
      if (row.dataType && row.kind === 'column' && !['lookup-single', 'lookup-multi'].includes(row.id)) {
        const mapped = plan.tables.flatMap((table) => table.columns).filter((column) => column.matrixId === row.id && column.name === 'F');
        assert.equal(mapped.length, 1, `${row.id} / ${token} primary column`);
        assert.equal(mapped[0]!.dataType, row.dataType, `${row.id} / ${token} Catalyst type`);
      }
      for (const column of plan.tables.flatMap((table) => table.columns)) {
        assert.notEqual(column.dataType, 'decimal');
      }
    }
  }
});

test('docs/schema-mapping.md matches the mapping table', () => {
  const doc = readFileSync(join(process.cwd(), 'docs/schema-mapping.md'), 'utf8');
  assert.equal(doc, schemaMappingMarkdown());
  for (const row of FIELD_TYPES) assert.ok(doc.includes(row.label), row.label);
});

test('Creator required, unique, and initial-value options reach the emitted column', () => {
  const plan = planOf(field('Code', 'text', '\t\t\tinitial value = ready', 'must have unique'));
  const column = plan.tables[0]!.columns.find((item) => item.name === 'Code')!;
  assert.equal(column.dataType, 'VarChar');
  assert.equal(column.length, 255);
  assert.equal(column.mandatory, true);
  assert.equal(column.unique, true);
  assert.equal(column.defaultValue, 'ready');
});

test('varchar over 255 is promoted to text', () => {
  const long = planOf(field('Title', 'text', '\t\t\tmaxchar = 400'));
  const column = long.tables[0].columns[0];
  assert.equal(column.dataType, 'Text');
  assert.equal(column.length, undefined);
  assert.ok(long.issues.some((issue) => issue.message.includes('promoted to text')));
  const short = planOf(field('Title', 'text', '\t\t\tmaxchar = 40'));
  assert.equal(short.tables[0].columns[0].dataType, 'VarChar');
  assert.equal(short.tables[0].columns[0].length, 40);
  const choice = 'x'.repeat(300);
  const wide = planOf(field('Genre', 'picklist', `\t\t\tvalues = {"${choice}","Short"}`));
  assert.equal(wide.tables[0].columns[0].dataType, 'Text');
});

test('url defaults to text and keeps a short maxchar as varchar', () => {
  assert.equal(planOf(field('Site', 'url')).tables[0].columns[0].dataType, 'Text');
  const short = planOf(field('Site', 'url', '\t\t\tmaxchar = 20'));
  assert.equal(short.tables[0].columns[0].dataType, 'VarChar');
  assert.equal(short.tables[0].columns[0].length, 20);
});

test('decimal, percent, and currency are exact varchar strings, never a decimal or double column', () => {
  for (const token of ['decimal', 'percentage', 'INR', 'USD', 'currency']) {
    const plan = planOf(field('Amount', token, '\t\t\tdecimalplace = 3'));
    const column = plan.tables[0].columns[0];
    assert.equal(column.dataType, 'VarChar', token);
    assert.equal(column.length, 64, token);
    assert.equal(column.exactDecimal, true, token);
    assert.equal(column.precision, 3, token);
    assert.notEqual(column.dataType, 'decimal', token);
    assert.equal(plan.issues.some((issue) => issue.message.includes('no decimal column type')), false, token);
  }
  const inr = planOf(field('Amount', 'INR')).tables[0].columns[0];
  assert.equal(inr.currencyCode, 'INR');
  assert.equal(inr.precision, 2);
  const plain = planOf(field('Amount', 'currency')).tables[0].columns[0];
  assert.equal(plain.currencyCode, undefined);
  assert.match(planOf(field('Amount', 'INR')).decisions.currency, /VarChar/);
  assert.match(planOf(field('Amount', 'INR')).decisions.currency, /not bigint minor units/);
  assert.match(planOf(field('Amount', 'INR')).decisions.currency, /not divided by 100/);
});

test('lookup single is a foreign key with the API on_delete values', () => {
  const src = [form('Author', field('Name', 'text')), form('Book', field('Author', 'picklist', '\t\t\tvalues = Author.Name'))].join('\n');
  const optional = generateSchema(appOf(src));
  const column = optional.tables.find((table) => table.form === 'Book' && table.role === 'form')!.columns[0];
  assert.equal(column.dataType, 'Foreign Key');
  assert.equal(column.relation?.onDelete, 'ON-DELETE-SET-NULL');
  assert.equal(column.relation?.column, 'ROWID');
  assert.equal(column.relation?.table, 'Author');
  const required = generateSchema(appOf([form('Author', field('Name', 'text')), form('Book', field('Author', 'picklist', '\t\t\tvalues = Author.Name', 'must have'))].join('\n')));
  const mandatory = required.tables.find((table) => table.form === 'Book' && table.role === 'form')!.columns[0];
  assert.equal(mandatory.relation?.onDelete, 'ON-DELETE-CASCADE');
  const missing = planOf(field('Author', 'picklist', '\t\t\tvalues = Missing.Name'));
  assert.equal(missing.tables[0].columns[0].dataType, 'BigInt');
  assert.ok(missing.issues.some((issue) => issue.message.includes('FK needs console')));
  assert.match(schemaAsReport(missing), /FK needs console/);
});

test('a filtered lookup is still a foreign key, on a form and inside a subform', () => {
  const src = [
    form('Author', field('Name', 'text')),
    form(
      'Book',
      [
        field('Author', 'picklist', '\t\t\tvalues = Author[ID > 0].Name'),
        field(
          'Lines',
          'grid',
          '\t\t\tEditor\n\t\t\t(\n\t\t\t\ttype = picklist\n\t\t\t\tvalues = Author[ID > 0].ID\n\t\t\t)',
        ),
      ].join('\n'),
    ),
  ].join('\n');
  const plan = generateSchema(appOf(src));
  const book = plan.tables.find((table) => table.form === 'Book' && table.role === 'form')!;
  const author = book.columns.find((column) => column.name === 'Author')!;
  assert.equal(author.dataType, 'Foreign Key');
  assert.equal(author.relation?.table, 'Author');
  const child = plan.tables.find((table) => table.role === 'child' && table.form === 'Book')!;
  const editor = child.columns.find((column) => column.name === 'Editor')!;
  assert.equal(editor.dataType, 'Foreign Key');
  assert.equal(editor.relation?.table, 'Author');
});

test('multi lookup is a junction table', () => {
  const src = [form('Author', field('Name', 'text')), form('Book', field('Authors', 'list', '\t\t\tvalues = Author.ID'))].join('\n');
  const plan = generateSchema(appOf(src));
  const junction = plan.tables.find((table) => table.role === 'junction');
  assert.ok(junction);
  assert.equal(junction.columns[0].relation?.onDelete, 'ON-DELETE-CASCADE');
  assert.equal(junction.columns[1].name, 'row_order');
  assert.equal(junction.columns[1].dataType, 'Int');
  assert.equal(junction.columns[1].matrixId, 'lookup-multi-order');
  assert.equal(junction.columns[2].dataType, 'Foreign Key');
  assert.deepEqual(
    plan.tables.find((table) => table.form === 'Book' && table.role === 'form')!.columns.map((column) => column.matrixId),
    ['c2c-system-field', 'c2c-system-field', 'c2c-system-field', 'c2c-system-field', 'c2c-source-id'],
  );
});

test('every inline subform is a child table with parent_id and row_order; two subforms are two child tables, not NoSQL', () => {
  const one = planOf(`${field('Title', 'text')}\n${field('Lines', 'grid', '\t\t\tItem\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)')}`);
  assert.equal(one.tables.filter((table) => table.nosql).length, 0);
  const child = one.tables.find((table) => table.role === 'child');
  assert.ok(child);
  assert.equal(child.columns[0].name, 'parent_id');
  assert.equal(child.columns[0].relation?.onDelete, 'ON-DELETE-CASCADE');
  assert.equal(child.columns[0].relation?.table, 'Item');
  assert.equal(child.columns[1].name, 'row_order');
  assert.equal(child.columns[1].dataType, 'Int');
  assert.equal(child.columns[2].dataType, 'VarChar');
  assert.deepEqual(child.subform, { form: 'Item', field: 'Lines', parentTable: 'Item', parentColumn: 'parent_id', orderColumn: 'row_order' });
  const two = planOf(
    [field('Title', 'text'), field('Lines', 'grid', '\t\t\tItem\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)'), field('Notes', 'grid', '\t\t\tBody\n\t\t\t(\n\t\t\t\ttype = textarea\n\t\t\t)')].join('\n'),
  );
  assert.equal(two.summary.nosqlCollections, 0);
  assert.equal(two.tables[0].embedded, undefined);
  const children = two.tables.filter((table) => table.role === 'child');
  assert.deepEqual(children.map((table) => table.name), ['Item__Lines', 'Item__Notes']);
  assert.deepEqual(children.map((table) => table.subform?.field), ['Lines', 'Notes']);
  assert.ok(children.every((table) => table.columns.some((column) => column.name === 'row_order')));
  assert.equal(two.signals.length, 9);
});

test('a subform field named row_order or parent_id does not take the link columns', () => {
  const sub = '\t\t\trow_order\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t\tparent_id\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)';
  const plan = planOf(field('Lines', 'grid', sub));
  const child = plan.tables.find((table) => table.role === 'child')!;
  assert.deepEqual(child.columns.slice(0, 4).map((column) => column.name), ['parent_id', 'row_order', 'row_order_2', 'parent_id_2']);
  assert.equal(child.subform?.orderColumn, 'row_order');
});

test('users, decision box, notes, prediction, name, and address', () => {
  const users = planOf(field('Owner', 'picklist', '\t\t\tmodule = users'));
  assert.equal(users.fields[0].matrixId, 'users');
  assert.equal(users.tables[0].columns[0].dataType, 'BigInt');
  const box = planOf(field('Done', 'checkbox', '\t\t\tinitial value = false'));
  assert.equal(box.fields[0].matrixId, 'decision-box');
  assert.equal(box.tables[0].columns[0].dataType, 'Boolean');
  assert.equal(box.tables[0].columns[0].defaultValue, 'false');
  const notes = planOf(field('Hint', 'plaintext'));
  assert.equal(notes.fields[0].status, 'supported');
  assert.deepEqual(notes.tables[0].columns.map((column) => column.matrixId), [
    'c2c-system-field',
    'c2c-system-field',
    'c2c-system-field',
    'c2c-system-field',
    'c2c-source-id',
  ]);
  const prediction = planOf(field('Guess', 'prediction'));
  assert.equal(prediction.fields[0].status, 'unsupported');
  assert.equal(prediction.summary.unsupported, 1);
  const name = planOf(`${field('Name', 'name', '\t\t\tprefix\n\t\t\t(\n\t\t\t\ttype = prefix\n\t\t\t)\n\t\t\tfirst_name\n\t\t\t(\n\t\t\t\ttype = first_name\n\t\t\t)')}`);
  assert.equal(name.fields.length, 1);
  assert.equal(
    name.tables[0].columns.filter((column) => column.matrixId !== 'c2c-source-id' && column.matrixId !== 'c2c-system-field').length,
    2,
  );
  const address = planOf(field('Address', 'address', '\t\t\tlatitude\n\t\t\t(\n\t\t\t\ttype = latitude\n\t\t\t)\n\t\t\tlongitude\n\t\t\t(\n\t\t\t\ttype = longitude\n\t\t\t)'));
  assert.ok(address.tables[0].columns.some((column) => column.name.includes('latitude') && column.dataType === 'Double'));
});

test('signals are one event per rule on Data Store tables only', () => {
  const plan = planOf(field('Title', 'text'));
  assert.equal(plan.dryRun, true);
  assert.deepEqual(
    plan.signals.map((rule) => rule.event),
    ['row_inserted', 'row_updated', 'row_deleted'],
  );
  assert.ok(plan.signals.every((rule) => rule.target === 'event-function'));
});

test('every migrated table has a nullable, non-unique c2c_source_id, and a field cannot take that name', () => {
  const subform = '\t\t\tItem\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)';
  const src = [
    form('Author', field('Name', 'text')),
    form('Book', `${field('Title', 'text')}\n${field('Authors', 'list', '\t\t\tvalues = Author.ID')}\n${field('Lines', 'grid', subform)}`),
    form('Bundle', [field('A', 'grid', subform), field('B', 'grid', subform)].join('\n')),
    form('Note', field('Hint', 'plaintext')),
  ].join('\n');
  const plan = generateSchema(appOf(src));
  assert.ok(plan.tables.some((table) => table.role === 'child'));
  assert.ok(plan.tables.some((table) => table.role === 'junction'));
  assert.ok(!plan.tables.some((table) => table.nosql));
  for (const table of plan.tables) {
    const system = table.columns.filter((column) => column.name === 'c2c_source_id');
    assert.equal(system.length, 1, table.name);
    assert.equal(system[0].matrixId, 'c2c-source-id', table.name);
    assert.equal(system[0].dataType, 'VarChar', table.name);
    assert.equal(system[0].length, 255, table.name);
    // App inserts leave it NULL (403 MANDATORY_MISSING when mandatory); the loader keeps it unique.
    assert.equal(system[0].mandatory, false, table.name);
    assert.equal(system[0].unique, false, table.name);
  }
  const clash = planOf(field('c2c_source_id', 'text'));
  assert.deepEqual(
    clash.tables[0].columns.map((column) => column.name),
    ['c2c_source_id_2', 'Added_User', 'Added_Time', 'Modified_User', 'Modified_Time', 'c2c_source_id'],
  );
  assert.equal(clash.tables[0].columns.at(-1)?.matrixId, 'c2c-source-id');
});

test('form and child tables store Creator system columns and junction tables do not', () => {
  const subform = '\t\t\tItem\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)';
  const src = [
    form('Author', field('Name', 'text')),
    form('Book', `${field('Title', 'text')}\n${field('Authors', 'list', '\t\t\tvalues = Author.ID')}\n${field('Lines', 'grid', subform)}`),
  ].join('\n');
  const plan = generateSchema(appOf(src));
  const names = ['Added_User', 'Added_Time', 'Modified_User', 'Modified_Time'];
  assert.ok(plan.tables.some((table) => table.role === 'junction'));
  assert.ok(plan.tables.some((table) => table.role === 'child'));
  for (const table of plan.tables) {
    const got = table.columns.filter((column) => names.includes(column.name));
    if (table.role === 'junction') {
      assert.equal(got.length, 0, table.name);
      continue;
    }
    assert.deepEqual(
      got.map((column) => column.name),
      names,
      table.name,
    );
    assert.ok(
      got.every((column) => column.mandatory === false && column.unique === false && column.matrixId === 'c2c-system-field'),
      table.name,
    );
    assert.equal(got[0]?.dataType, 'VarChar');
    assert.equal(got[0]?.length, 255);
    assert.equal(got[1]?.dataType, 'DateTime');
  }
  const renamed = planOf(field('Added_User', 'text'));
  assert.equal(renamed.tables[0].columns[0].name, 'Added_User_2');
  assert.ok(renamed.tables[0].columns.some((column) => column.name === 'Added_User' && column.matrixId === 'c2c-system-field'));
});

test('project names stay inside 50 characters', () => {
  assert.equal(projectNameFor('library'), 'c2c-library');
  assert.equal(projectNameFor('c2c-sample-app'), 'c2c-sample-app');
  const name = projectNameFor('a'.repeat(60));
  assert.equal(name.length, 50);
  assert.match(name, /^c2c-a+-[0-9a-f]{6}$/);
});

test('an app already named c2c-* is not double-prefixed', () => {
  assert.equal(projectNameFor('c2c-conn-crm'), 'c2c-conn-crm');
  assert.equal(projectNameFor('C2C-Conn-Books'), 'C2C-Conn-Books');
  assert.equal(projectNameFor('c2cconn'), 'c2c-c2cconn');
  assert.ok(!projectNameFor('c2c-conn-rest-putdel').startsWith('c2c-c2c-'));
});

test('corpus report counts a temp app and does not invent a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-schema-'));
  try {
    writeFileSync(join(dir, 'demo.ds'), `application "Demo"\n{\n${form('Item', field('Title', 'text'))}\n}\n`);
    const apps = loadCorpusApps(dir);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].link, 'demo');
    const numbers = corpusNumbers(apps);
    assert.equal(numbers.apps, 1);
    assert.equal(numbers.failed.length, 0);
    assert.equal(numbers.fields, 1);
    assert.equal(numbers.supported, 1);
    const markdown = formatCorpusReport(numbers, { label: 'temp', date: '2026-10-05' });
    assert.match(markdown, /Apps measured: 1/);
    assert.match(markdown, /\| demo \|/);
    assert.doesNotMatch(markdown, /Title/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a table over the unique varchar budget keeps the first two store-level and the rest app-level', () => {
  const plan = planOf(
    [
      field('Mail_ID', 'email', '', 'must have unique'),
      field('Phone', 'phonenumber', '', 'unique'),
      field('Code', 'text', '', 'unique'),
      field('Seq', 'number', '', 'unique'),
    ].join('\n'),
    'Add_User',
  );
  const byName = new Map(plan.tables[0].columns.map((column) => [column.name, column]));
  assert.equal(UNIQUE_VARCHAR_MAX_PER_TABLE, 2);
  assert.deepEqual(
    ['Mail_ID', 'Phone', 'Code'].map((name) => [name, byName.get(name)?.unique, byName.get(name)?.appUnique ?? false]),
    [
      ['Mail_ID', true, false],
      ['Phone', true, false],
      ['Code', false, true],
    ],
  );
  // A non-varchar unique does not spend the budget.
  assert.equal(byName.get('Seq')?.unique, true);
  assert.match(byName.get('Code')?.note ?? '', /Unique is enforced by the c2c handler/);
  assert.ok(plan.issues.some((issue) => /Add_User has 3 unique varchar columns; Data Store allows 2\. .*App-level unique .*: Code\./.test(issue.message)));
  // The IaC writer lives in packages/deploy/src/iac.ts; the marker is the plan's appUnique (iac.test.ts covers the template).
  assert.equal(JSON.parse(schemaAsJson(plan)).tables[0].columns.find((column: { name: string }) => column.name === 'Code').appUnique, true);
  const stored = plan.tables.flatMap((table) => table.columns.filter((column) => column.unique && isStoreVarchar(column)).map(() => table.name));
  for (const name of new Set(stored)) assert.ok(stored.filter((item) => item === name).length <= UNIQUE_VARCHAR_MAX_PER_TABLE);
});

test('a unique date or datetime column is never store-unique: the handler enforces it', () => {
  // A Data Store date/datetime column created with is_unique refuses every
  // insert (400 INVALID_INPUT "date value expected"), so the flag must not
  // reach the plan no matter what the source holds.
  const plan = planOf(
    [
      field('Fiscal_Year_From', 'date', '', 'must have unique'),
      field('Fiscal_Year_To', 'datetime', '', 'unique'),
      field('Code', 'text', '', 'unique'),
    ].join('\n'),
    'Make_Your_Fiscal_Year',
  );
  const byName = new Map(plan.tables[0].columns.map((column) => [column.name, column]));
  assert.equal(byName.get('Fiscal_Year_From')?.dataType, 'Date');
  assert.equal(byName.get('Fiscal_Year_To')?.dataType, 'DateTime');
  assert.equal(byName.get('Fiscal_Year_From')?.unique, false);
  assert.equal(byName.get('Fiscal_Year_From')?.appUnique, true);
  assert.equal(byName.get('Fiscal_Year_To')?.unique, false);
  assert.equal(byName.get('Fiscal_Year_To')?.appUnique, true);
  assert.match(byName.get('Fiscal_Year_From')?.note ?? '', /not the store/);
  // A unique varchar keeps its store flag — the refusal is specific to date types.
  assert.equal(byName.get('Code')?.unique, true);
  assert.equal(byName.get('Code')?.appUnique, undefined);
  // The appUnique marker reaches the emitted schema JSON for the handler wiring.
  const emitted = JSON.parse(schemaAsJson(plan)).tables[0].columns.find((column: { name: string }) => column.name === 'Fiscal_Year_From');
  assert.equal(emitted.appUnique, true);
  assert.equal(emitted.unique, false);
  assert.ok(
    plan.issues.some(
      (issue) =>
        issue.form === 'Make_Your_Fiscal_Year' &&
        /has 2 unique date\/datetime column\(s\).*Fiscal_Year_From, Fiscal_Year_To/.test(issue.message),
    ),
    JSON.stringify(plan.issues),
  );
});


/** A form schedule in the gallery shape: a named def inside the schedule container. */
function formSchedule(name: string, formName: string, extra = ''): string {
  return `\tworkflow
\t{
\t\tschedule
\t\t{
\t\t\t${name} as "${name}"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = ${formName}
\t\t\t\tstart = before 1 days from Due_Date at "09:00:00"
\t\t\t\ttime zone = "Asia/Kolkata"
${extra}\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\ton load
\t\t\t\t\t(
\t\t\t\t\t\tx = 1;
\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

test('a schedule app plans the C2CJobCheckpoint table; a no-schedule app does not', () => {
  const withoutSchedule = appOf(`
    form Blank {
      field_1 (type = text)
    }
  `);
  const planWithout = generateSchema(withoutSchedule);
  assert.equal(planWithout.tables.some(t => t.name === 'C2CJobCheckpoint'), false);

  const withSchedule = appOf(`
    form Item {
      Due_Date
      (
        type = date
      )
    }
${formSchedule('Due_Reminder', 'Item')}
  `);
  const planWith = generateSchema(withSchedule);
  const checkpoint = planWith.tables.find(t => t.name === 'C2CJobCheckpoint');
  assert.ok(checkpoint, 'checkpoint table must be planned for an app with a form schedule');
  assert.equal(checkpoint.columns.find(c => c.name === 'Job_Key')?.dataType, 'VarChar');
  assert.equal(checkpoint.columns.find(c => c.name === 'Job_Key')?.unique, true);
  assert.equal(checkpoint.columns.find(c => c.name === 'State')?.dataType, 'Text');
  assert.equal(checkpoint.columns.find(c => c.name === 'State')?.unique, false);
});

test('a form schedule the sweeper cannot fire plans no checkpoint table', () => {
  // The sweeper skips payment workflows even inside a schedule container.
  const payment = appOf(`
    form Item {
      Due_Date
      (
        type = date
      )
    }
    workflow
    {
        schedule
        {
            "Payment Reminder"
            {
                type = schedule
                form = Item
                start = before 1 days from Due_Date at "09:00:00"
                time zone = "Asia/Kolkata"
                on start
                {
                    actions
                    {
                    on load
                    (
                        x = 1;
                    )
                    }
                }
            }
        }
    }
  `);
  assert.equal(generateSchema(payment).tables.some(t => t.name === 'C2CJobCheckpoint'), false);
  // A form schedule whose start field is not a date is a gap, not a sweep.
  const badStart = appOf(`
    form Item {
      Due_Date
      (
        type = text
      )
    }
${formSchedule('Due_Reminder', 'Item')}
  `);
  assert.equal(generateSchema(badStart).tables.some(t => t.name === 'C2CJobCheckpoint'), false);
});

/** An approval workflow governing one form, in the gallery shape. */
function approvalFlow(name: string, formName: string): string {
  return `\tworkflow
\t{
\t\tapproval
\t\t{
\t\t\t${name} as "${name}"
\t\t\t{
\t\t\t\ttype = approval
\t\t\t\tform = ${formName}
\t\t\t\ton approve
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\ton load
\t\t\t\t\t(
\t\t\t\t\t\tx = 1;
\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;
}

test('the flow history table is found by name, not by position among the system tables', () => {
  const itemForm = `
    form Item {
      Due_Date
      (
        type = date
      )
    }
  `;
  const both = appOf(`${itemForm}${approvalFlow('Sign_Off', 'Item')}${formSchedule('Due_Reminder', 'Item')}`);
  assert.equal(flowHistoryTable(both), 'C2C_Flow_History');
  assert.ok(generateSchema(both).tables.some(t => t.name === 'C2CJobCheckpoint'));
  // An approval on a form that does not resolve governs nothing, so no history
  // table exists; the checkpoint table must not be mistaken for it.
  const orphan = appOf(`${itemForm}${approvalFlow('Sign_Off', 'Missing')}${formSchedule('Due_Reminder', 'Item')}`);
  const orphanPlan = generateSchema(orphan);
  assert.ok(orphanPlan.tables.some(t => t.name === 'C2CJobCheckpoint'));
  assert.equal(orphanPlan.tables.some(t => t.name === 'C2C_Flow_History'), false);
  assert.equal(flowHistoryTable(orphan), undefined);
});
