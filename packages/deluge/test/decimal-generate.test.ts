import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse, type App, type Workflow } from '../../core/src/index.js';
import { createRuntime, type RuntimeOptions } from '../../shims/src/runtime.js';
import { withDecimalAudit } from '../src/audit.js';
import { decimalColumnsOf, generate, writeRulesOf } from '../src/generate.js';
import { translate } from '../src/translate.js';

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

const Z = { start: 0, end: 0 };

function snippet(body: string): App {
  return deriveIr(parse(`application "T"\n{\n${body}\n}\n`));
}

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

async function loadModule(source: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-decimal-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  writeFileSync(join(dir, 'handler.mjs'), source);
  try {
    return (await import(pathToFileURL(join(dir, 'handler.mjs')).href)) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const POS_FORMS = `\tform Add_Discount
\t{
\t\tTotal_price
\t\t(
\t\t\ttype = INR
\t\t\tdecimalplace = 2
\t\t)
\t\tDiscount
\t\t(
\t\t\ttype = percent
\t\t)
\t}
\tform Add_Invoice
\t{
\t\tTotal
\t\t(
\t\t\ttype = INR
\t\t)
\t\tDiscount
\t\t(
\t\t\ttype = percent
\t\t)
\t}`;

test('generated handlers pass each form’s shadow columns, and the point-of-sale query picks 100.00', async () => {
  const ir = snippet(POS_FORMS);
  assert.deepEqual(decimalColumnsOf(ir), {
    Add_Discount: { Total_price: { shadow: 'Total_price__n', scale: 2 }, Discount: { shadow: 'Discount__n', scale: 2 } },
    Add_Invoice: { Total: { shadow: 'Total__n', scale: 2 }, Discount: { shadow: 'Discount__n', scale: 2 } },
  });
  ir.workflows.push(
    workflow({
      name: 'Field_scripts1',
      form: 'Add_Invoice',
      event: 'on user input of Total',
      deluge: {
        text: 'discount_offer = Add_Discount[Total_price <= input.Total] sort by Total_price desc range from 0 to 0;\ninput.Discount = discount_offer.Discount;',
        span: Z,
      },
    }),
  );
  const file = generate(ir).files.find((f) => f.path.startsWith('functions/aio/add-invoice/') && f.source.includes('Add_Discount'));
  assert.ok(file);
  assert.match(stripComments(file.source), /createRuntime\(\{[^\n]*decimalColumns: \{"Add_Discount":\{"Total_price":\{"shadow":"Total_price__n","scale":2\}/);
  const decimalColumns = JSON.parse(/decimalColumns: (\{.*?\}\}\})/.exec(file.source)![1]!) as RuntimeOptions['decimalColumns'];
  const mod = (await loadModule(file.source)) as { handle: (ctx: unknown) => Promise<unknown> };
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    decimalColumns,
    seed: {
      Add_Discount: [
        { ROWID: '1', Total_price: '20.00', Discount: '2.00' },
        { ROWID: '2', Total_price: '100.00', Discount: '10.00' },
        { ROWID: '3', Total_price: '15.00', Discount: '1.50' },
        { ROWID: '4', Total_price: '1000.00', Discount: '25.00' },
      ],
    },
  });
  const ctx = runtime.context({ record: { Total: '150.00', Discount: null } });
  await mod.handle(ctx);
  assert.equal(ctx.record.Discount, '10.00');
});

test('a form with two subforms is a Data Store table: its decimals and its child-table decimals get shadow columns', () => {
  const ir = snippet(`\tform Bundle
\t{
\t\tA
\t\t(
\t\t\ttype = grid
\t\t\tCost
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t)
\t\t)
\t\tB
\t\t(
\t\t\ttype = grid
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t)
\t\tTotal
\t\t(
\t\t\ttype = decimal
\t\t)
\t}`);
  assert.deepEqual(decimalColumnsOf(ir), {
    Bundle__A: { Cost: { shadow: 'Cost__n', scale: 2 } },
    Bundle: { Total: { shadow: 'Total__n', scale: 2 } },
  });
});

// `row` is a reserved name, so it is emitted renamed as `d_row`; a bound row
// name reads through shim.record.get. Both keep exact-decimal arithmetic.
const BOM = { decimalFields: ['Unit_Price', 'Total_Price', 'Subtotal'] };

test('bill-of-materials arithmetic on currency fields goes through shim.decimal on server and client', () => {
  const src = [
    'row.Total_Price = row.Unit_Price * row.Quantity + 100;',
    'subtotal = 0;',
    'for each mat in input.Materials',
    '{',
    '  subtotal = subtotal + mat.Total_Price;',
    '}',
    'input.Subtotal = subtotal;',
  ].join('\n');
  const { result: tr, audit } = withDecimalAudit(() => translate(src, BOM));
  for (const code of [tr.server, tr.client]) {
    assert.match(stripComments(code), /shim\.decimal\.add\(shim\.decimal\.mul\(d_row\.Unit_Price, d_row\.Quantity\), 100\)/);
    assert.match(stripComments(code), /subtotal = shim\.decimal\.add\(subtotal, /);
    assert.doesNotMatch(stripComments(code), /d_row\.Unit_Price \* d_row\.Quantity/);
  }
  assert.deepEqual(audit.arithmetic, []);
  const bound = translate(src, { ...BOM, rowNames: ['row'] });
  assert.match(stripComments(bound.server), /shim\.decimal\.add\(shim\.decimal\.mul\(shim\.record\.get\(d_row, "Unit_Price"\), shim\.record\.get\(d_row, "Quantity"\)\), 100\)/);
});

test('ternary, ifnull, and decimal function parameters keep the exact-decimal type', () => {
  const opts = { decimalFields: ['Price'], decimalVars: ['rate'] };
  const cases: [string, RegExp][] = [
    ['x = if(input.Flag, input.Price, 0) * 2;', /shim\.decimal\.mul\(\(.*\? .*Price.* : 0\), 2\)/],
    ['x = ifnull(input.Price, 0) + 1;', /shim\.decimal\.add\(shim\.ifnull\(.*Price.*, 0\), 1\)/],
    ['x = rate * 3;', /shim\.decimal\.mul\(rate, 3\)/],
  ];
  for (const [src, re] of cases) {
    const { result, audit } = withDecimalAudit(() => translate(src, opts));
    assert.match(stripComments(result.server), re, src);
    assert.deepEqual(audit.arithmetic, [], src);
  }
});

const RULES_APP = `\tform Item
\t{
\t\tmust have Name
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Order
\t{
\t\tmust have Title
\t\t(
\t\t\ttype = text
\t\t\tmaxchar = 10
\t\t)
\t\tmust have When
\t\t(
\t\t\ttype = date
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = decimal
\t\t\tdecimalplace = 2
\t\t)
\t\tItems
\t\t(
\t\t\ttype = list
\t\t\tvalues = Item.ID
\t\t)
\t\tParts
\t\t(
\t\t\ttype = grid
\t\t\tmust have Qty
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t)
\t}`;

test('generated runtimes carry the same write rules the loader enforces', () => {
  const ir = snippet(RULES_APP);
  const rules = writeRulesOf(ir);
  const order = rules.Order!;
  assert.deepEqual(order.find((c) => c.name === 'Title'), { name: 'Title', dataType: 'VarChar', length: 10, required: true });
  assert.equal(order.find((c) => c.name === 'When')?.required, true);
  assert.equal(order.find((c) => c.name === 'Amount')?.scale, 2);
  assert.ok(order.every((c) => (!c.name.startsWith('Added_') && !c.name.startsWith('Modified_')) || !c.required), 'system columns are never required');
  const child = rules['Order__Parts']!;
  assert.ok(child, 'child table rules are keyed by table name');
  assert.equal(child.find((c) => c.name === 'parent_id')?.required, true);
  assert.equal(child.find((c) => c.name === 'Qty')?.required, true);
  assert.equal('Order__Items' in rules, false, 'junction tables carry no generated write rules');
  assert.equal('Item__Orders' in rules, false);
  assert.deepEqual(Object.keys(rules).sort(), ['Item', 'Order', 'Order__Parts']);

  ir.workflows.push(
    workflow({
      name: 'Field_scripts1',
      form: 'Order',
      event: 'on user input of Title',
      deluge: { text: 'input.Amount = input.Amount;', span: Z },
    }),
  );
  const file = generate(ir).files.find((f) => f.source.includes('writeRules'));
  assert.ok(file, 'a generated handler carries writeRules');
  const marker = 'writeRules: ';
  const start = file.source.indexOf(marker) + marker.length;
  let depth = 0;
  let end = start;
  for (; end < file.source.length; end += 1) {
    if (file.source[end] === '{') depth += 1;
    else if (file.source[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const literal = JSON.parse(file.source.slice(start, end + 1)) as RuntimeOptions['writeRules'];
  assert.deepEqual(literal?.Order?.find((c) => c.name === 'Title'), { name: 'Title', dataType: 'VarChar', length: 10, required: true });
});

const POS_SALE = `\tform Point_Of_Sale
\t{
\t\tTotal
\t\t(
\t\t\ttype = INR
\t\t)
\t\tTax
\t\t(
\t\t\ttype = percent
\t\t)
\t\tDiscount_Percentage
\t\t(
\t\t\ttype = percent
\t\t)
\t\tPayment
\t\t(
\t\t\ttype = INR
\t\t)
\t}`;

test('a Deluge-computed currency value is rounded to the column scale before the write check', async () => {
  const ir = snippet(POS_SALE);
  const rules = writeRulesOf(ir);
  assert.equal(rules.Point_Of_Sale?.find((c) => c.name === 'Payment')?.scale, 2);
  const inserted: Record<string, unknown>[] = [];
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: 'UTC',
    writeRules: rules,
    decimalColumns: decimalColumnsOf(ir),
    datastore: {
      async insert(_form: string, rows: Record<string, unknown>[]) {
        inserted.push(...rows);
        return rows;
      },
      async query() {
        return [];
      },
    },
  });
  const ctx = runtime.context({});
  // input.Payment = input.Total + input.Tax / 100 * input.Total - input.Discount_Percentage / 100 * input.Total;
  const d = runtime.shim.decimal;
  const total = d.from('99.99');
  const payment = d.sub(
    d.add(total, d.mul(d.div(d.from('18'), 100), total)),
    d.mul(d.div(d.from('5'), 100), total),
  );
  assert.equal(payment.toString(), '112.9887');
  await runtime.shim.datastore.insert(ctx, 'Point_Of_Sale', { Total: '99.99', Tax: '18', Discount_Percentage: '5', Payment: payment });
  assert.equal(inserted[0]?.Payment, '112.99');
  assert.equal(inserted[0]?.Payment__n, 112.99);
});
