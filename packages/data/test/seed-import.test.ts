import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateCreatorImport } from '../src/index.js';

function appOf(body: string, name = 'Demo'): App {
  return deriveIr(parse(`application "${name}"\n{\n${body}\n}\n`));
}

function parseCsv(csv: string): string[][] {
  return csv.trimEnd().split('\n').map((line) => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

const APP = appOf(
  `\tform Add_Material
\t{
\t\tmust have unique Material_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have Unit_Price
\t\t(
\t\t\ttype = USD
\t\t)
\t\tKind
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = {"Raw","Composite"}
\t\t)
\t\tPhoto
\t\t(
\t\t\ttype = image
\t\t)
\t}
\tform Add_Batch
\t{
\t\tmust have unique Batch_No
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have Start_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tBOM
\t\t(
\t\t\ttype = list
\t\t\tvalues = Add_Material.ID
\t\t\tdisplayformat = [Material_Name]
\t\t)
\t}
\tform Create_BOM
\t{
\t\tmust have Product
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Material.ID
\t\t\tdisplayformat = [Material_Name]
\t\t)
\t\tmust have Lines
\t\t(
\t\t\ttype = grid
\t\t\tQty
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t)
\t}
\tform Use_BOM
\t{
\t\tmust have Which
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Create_BOM.ID
\t\t\tdisplayformat = [Serial]
\t\t)
\t}`,
);

test('same seed byte-identical; different seed differs', () => {
  const a = generateCreatorImport(APP, { rows: 5, seed: 'bom' });
  const b = generateCreatorImport(APP, { rows: 5, seed: 'bom' });
  assert.deepEqual(a.files.map((f) => f.csv), b.files.map((f) => f.csv));
  assert.equal(a.readme, b.readme);
  const c = generateCreatorImport(APP, { rows: 5, seed: 'other' });
  assert.notEqual(a.files.map((f) => f.csv).join(''), c.files.map((f) => f.csv).join(''));
});

test('subform forms are skipped; parents come first in IMPORT_ORDER', () => {
  const r = generateCreatorImport(APP, { rows: 5, seed: 'bom' });
  assert.deepEqual(r.skipped.map((s) => s.form), ['Create_BOM']);
  const names = r.files.map((f) => f.form);
  assert.ok(names.indexOf('Add_Material') < names.indexOf('Add_Batch'));
  assert.ok(names.indexOf('Add_Material') < names.indexOf('Use_BOM'));
  assert.ok(r.orderText.includes('Add_Material.csv'));
  assert.ok(r.readme.includes('Create_BOM'));
  // Use_BOM's lookup into the skipped parent carries the display values.
  const use = parseCsv(r.files.find((f) => f.form === 'Use_BOM')!.csv);
  for (const row of use.slice(1)) assert.ok(row[0].length > 0);
  assert.ok(r.warnings.some((w) => w.field === 'Which'));
});

test('creator import conventions: dd-MMM-yyyy, comma multi-lookup, no file columns', () => {
  const r = generateCreatorImport(APP, { rows: 10, seed: 'bom' });
  const mat = parseCsv(r.files.find((f) => f.form === 'Add_Material')!.csv);
  assert.deepEqual(mat[0], ['Material_Name', 'Unit_Price', 'Kind']); // Photo dropped
  const names = new Set(mat.slice(1).map((row) => row[0]));
  assert.equal(names.size, 10);
  for (const row of mat.slice(1)) {
    assert.match(row[1], /^\d+\.\d{2}$/);
    assert.ok(['Raw', 'Composite'].includes(row[2]));
  }
  const batch = parseCsv(r.files.find((f) => f.form === 'Add_Batch')!.csv);
  for (const row of batch.slice(1)) {
    assert.match(row[1], /^\d{2}-[A-Z][a-z]{2}-\d{4}$/);
    assert.ok(names.has(row[2].split(',')[0]), row[2]);
  }
});

test('creator import date-times retain seconds with a fixed seed', () => {
  const app = appOf(`\tform Visit\n\t{\n\t\tWhen\n\t\t(\n\t\t\ttype = datetime\n\t\t)\n\t}`);
  const first = generateCreatorImport(app, { rows: 8, seed: 'seconds' });
  const second = generateCreatorImport(app, { rows: 8, seed: 'seconds' });
  const values = parseCsv(first.files[0]!.csv).slice(1).map((row) => row[0]);
  assert.deepEqual(first.files[0]!.csv, second.files[0]!.csv);
  assert.ok(values.every((value) => /^\d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}:\d{2}$/.test(value)));
  assert.match(first.readme, /date-times `dd-MMM-yyyy HH:mm:ss`/);
});

test('name composite becomes dotted columns and emails/phones are fictional', () => {
  const app = appOf(
    `\tform Person
\t{
\t\tmust have Name
\t\t(
\t\t\ttype = name
\t\t\tfirst_name
\t\t\t(
\t\t\t\ttype = first_name
\t\t\t)
\t\t\tlast_name
\t\t\t(
\t\t\t\ttype = last_name
\t\t\t)
\t\t)
\t\tmust have Mail
\t\t(
\t\t\ttype = email
\t\t)
\t\tPhone
\t\t(
\t\t\ttype = phonenumber
\t\t)
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 4, seed: 'ppl' });
  const rows = parseCsv(r.files[0].csv);
  assert.deepEqual(rows[0], ['Name.first_name', 'Name.last_name', 'Mail', 'Phone']);
  for (const row of rows.slice(1)) {
    assert.match(row[2], /@example\.com$/);
    assert.match(row[3], /^\+1-555-01\d{2}$/);
  }
});

function sectionCsv(md: string, heading: string): string[][] {
  const at = md.indexOf(heading);
  assert.ok(at >= 0, heading);
  const fenced = md.slice(at).match(/```csv\n([\s\S]*?)```/);
  assert.ok(fenced, heading);
  return parseCsv(fenced[1]);
}

test('name prefix uses the subfield value list and is not suffixed', () => {
  const app = appOf(
    `\tform Person
\t{
\t\tmust have Name
\t\t(
\t\t\ttype = name
\t\t\tprefix
\t\t\t(
\t\t\t\ttype = prefix
\t\t\t\tvisibility = false
\t\t\t\tvalue = {"Mr.","Mrs.","Ms."}
\t\t\t)
\t\t\tfirst_name
\t\t\t(
\t\t\t\ttype = first_name
\t\t\t)
\t\t\tlast_name
\t\t\t(
\t\t\t\ttype = last_name
\t\t\t)
\t\t)
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 12, seed: 'names' });
  const rows = parseCsv(r.files[0].csv);
  assert.equal(rows[0][0], 'Name.prefix');
  const allowed = new Set(['Mr.', 'Mrs.', 'Ms.']);
  for (const row of rows.slice(1)) {
    assert.ok(allowed.has(row[0]), row[0]);
    assert.equal(/\(\d+\)/.test(row[0]), false);
  }
  assert.deepEqual([...new Set(rows.slice(1).map((row) => row[0]))], ['Mr.', 'Mrs.', 'Ms.']);
});

test('picklist text is copied from the .ds, including a trailing space', () => {
  const app = appOf(
    `\tform Add_Material
\t{
\t\tMeasurement_Unit
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = {"Pieces","dozen ","Kgs"}
\t\t)
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 6, seed: 'units' });
  const rows = parseCsv(r.files[0].csv);
  const allowed = ['Pieces', 'dozen ', 'Kgs'];
  for (const row of rows.slice(1)) assert.ok(allowed.includes(row[0]), JSON.stringify(row[0]));
  assert.ok(rows.slice(1).some((row) => row[0] === 'dozen '));
});

test('a stateless must-have lookup at a skipped parent is not an import file', () => {
  const app = appOf(
    `\tform Parent
\t{
\t\tSerial
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have Lines
\t\t(
\t\t\ttype = grid
\t\t\tQty
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t)
\t}
\tform Calc
\t{
\t\tstore data in zc = false
\t\tmust have Which
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Parent.ID
\t\t\tdisplayformat = [Serial]
\t\t)
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 4, seed: 'calc' });
  assert.equal(r.files.some((f) => f.form === 'Calc' || f.form === 'Parent'), false);
  assert.equal(/^\d+\.\s/m.test(r.orderText), false);
  const calc = r.skipped.find((s) => s.form === 'Calc');
  assert.ok(calc);
  assert.match(calc.reason, /store data in zc = false/);
  assert.match(calc.reason, /Which/);
  assert.match(calc.reason, /Parent\.Serial/);
  const sheet = r.manual.find((m) => m.form === 'Parent');
  assert.ok(sheet);
  assert.equal(sheet.fileName, 'Parent.worksheet.md');
  assert.equal(r.orderText.includes(sheet.fileName), false);
  assert.match(sheet.body, /Not for Import Data/);
  const parent = sectionCsv(sheet.body, '## Parent rows');
  assert.deepEqual(parent.slice(1).map((row) => row[0]), ['SN-2026-0001', 'SN-2026-0002', 'SN-2026-0003', 'SN-2026-0004']);
});

test('manual worksheet keys grid lines and does not seed placeholder grid columns', () => {
  const app = appOf(
    `\tform Add_Material
\t{
\t\tmust have unique Material_Name
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Add_Product
\t{
\t\tmust have Product_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tThis_is_also_the_subassembly
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = {"true","false"}
\t\t)
\t}
\tform Add_User
\t{
\t\tmust have Name
\t\t(
\t\t\ttype = name
\t\t\tprefix
\t\t\t(
\t\t\t\ttype = prefix
\t\t\t\tvisibility = false
\t\t\t\tvalue = {"Mr.","Mrs.","Ms."}
\t\t\t)
\t\t\tfirst_name
\t\t\t(
\t\t\t\ttype = first_name
\t\t\t)
\t\t\tlast_name
\t\t\t(
\t\t\t\ttype = last_name
\t\t\t)
\t\t\tsuffix
\t\t\t(
\t\t\t\ttype = suffix
\t\t\t\tvisibility = false
\t\t\t)
\t\t)
\t}
\tform Add_Production_Batch
\t{
\t\tmust have unique Batch_No
\t\t(
\t\t\ttype = text
\t\t)
\t\tBOM
\t\t(
\t\t\ttype = list
\t\t\tvalues = Create_BOM.ID
\t\t\tbidirectional = Production_Batch
\t\t\tdisplayformat = [ID]
\t\t)
\t}
\tform BOM_Calculator
\t{
\t\tstore data in zc = false
\t\tmust have Product_to_Production
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Create_BOM.ID
\t\t\tdisplayformat = [Serial_Number]
\t\t)
\t}
\tform Create_BOM
\t{
\t\tmust have Product
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Product.ID
\t\t\tdisplayformat = [Product_Name]
\t\t)
\t\tSerial_Number
\t\t(
\t\t\ttype = text
\t\t)
\t\tCreated_By
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_User.ID
\t\t\tdisplayformat = [" " + Name.prefix + " " + Name.first_name + " " + Name.last_name + " " + Name.suffix]
\t\t)
\t\tmust have Created_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tBOM_Status
\t\t(
\t\t\ttype = radiobuttons
\t\t\tvalues = {"Active","Archive"}
\t\t\tinitial value = "Active"
\t\t)
\t\tmust have Production_Batch
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Production_Batch.ID
\t\t\tdisplayformat = [Batch_No]
\t\t)
\t\tmust have Subtotal_Price
\t\t(
\t\t\ttype = USD
\t\t)
\t\tOther_Cost
\t\t(
\t\t\ttype = USD
\t\t)
\t\tmust have List_Of_Materials
\t\t(
\t\t\ttype = grid
\t\t\tmust have Material
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = Add_Material.ID
\t\t\t\tdisplayformat = [Material_Name]
\t\t\t)
\t\t\tMeasurement_Unit
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = {"Choice 1"}
\t\t\t)
\t\t\tUnit_Price
\t\t\t(
\t\t\t\ttype = USD
\t\t\t)
\t\t\tmust have Quantity
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t\tTotal_Price
\t\t\t(
\t\t\t\ttype = USD
\t\t\t)
\t\t)
\t\tList_Of_Subassemblies
\t\t(
\t\t\ttype = grid
\t\t\tmust have Product
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = Add_Product[This_is_also_the_subassembly == true].ID
\t\t\t\tdisplayformat = [Product_Name]
\t\t\t)
\t\t\tMeasurement_Unit
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = {"Choice 1"}
\t\t\t)
\t\t\tmust have Unit_Price
\t\t\t(
\t\t\t\ttype = USD
\t\t\t)
\t\t\tmust have Quantity
\t\t\t(
\t\t\t\ttype = number
\t\t\t)
\t\t)
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 4, seed: 'grid' });
  assert.equal(r.files.some((f) => f.form === 'Create_BOM' || f.form === 'BOM_Calculator'), false);
  const steps = r.orderText.split('\n').filter((line) => /^\d+\./.test(line));
  assert.equal(steps.some((line) => /BOM_Calculator|worksheet|Create_BOM/.test(line)), false);
  const batchSheet = r.manual.find((m) => m.form === 'Add_Production_Batch')!;
  const batch = sectionCsv(batchSheet.body, '## Parent rows');
  const bomCol = batch[0].indexOf('BOM');
  for (const row of batch.slice(1)) assert.equal(row[bomCol], '');
  assert.match(r.readme, /NoSQL collection/);
  const sheet = r.manual.find((m) => m.form === 'Create_BOM')!;
  assert.match(sheet.body, /Not for Import Data/);
  assert.match(sheet.body, /BOM_Calculator/);
  assert.match(sheet.body, /Leave `BOM_Status` at its initial value `Active`/);
  const parent = sectionCsv(sheet.body, '## Parent rows');
  assert.deepEqual(parent[0].slice(0, 3), ['Serial_Number', 'Product', 'Created_By']);
  assert.equal(parent[0].includes('BOM_Status'), false);
  assert.deepEqual(parent.slice(1).map((row) => row[0]), ['SN-2026-0001', 'SN-2026-0002', 'SN-2026-0003', 'SN-2026-0004']);
  for (const row of parent.slice(1)) assert.match(row[2], /^(Mr\.|Mrs\.|Ms\.) /);
  const materials = sectionCsv(sheet.body, '## List_Of_Materials');
  assert.deepEqual(materials[0], ['Serial_Number', 'Material', 'Measurement_Unit', 'Unit_Price', 'Quantity', 'Total_Price']);
  assert.equal(materials.length - 1, 8);
  const materialNames = new Set(parseCsv(r.files.find((f) => f.form === 'Add_Material')!.csv).slice(1).map((row) => row[0]));
  for (const row of materials.slice(1)) {
    assert.ok(materialNames.has(row[1]), row[1]);
    assert.match(row[4], /^[1-9]$/);
  }
  const products = parseCsv(r.files.find((f) => f.form === 'Add_Product')!.csv);
  const subFlag = new Map(products.slice(1).map((row) => [row[0], row[1]]));
  const subs = sectionCsv(sheet.body, '## List_Of_Subassemblies');
  assert.deepEqual(subs[0], ['Serial_Number', 'Product', 'Measurement_Unit', 'Unit_Price', 'Quantity']);
  assert.equal(subs.length - 1, 4);
  for (const row of subs.slice(1)) {
    const parentProduct = parent.slice(1).find((p) => p[0] === row[0])![1];
    assert.notEqual(row[1], parentProduct);
    assert.equal(subFlag.get(row[1]), 'true');
  }
});

test('readme says to import a file once when sibling reports are filtered views', () => {
  const app = appOf(
    `\tform Add_Product
\t{
\t\tmust have Product_Name
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Add_Production_Batch
\t{
\t\tmust have unique Batch_No
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tsection Reports
\t{
\t\tlist Final_Products
\t\t{
\t\t\tshow all rows from Add_Product [Flag == false]
\t\t\t(
\t\t\t\tProduct_Name
\t\t\t)
\t\t}
\t\tlist Subassemblies
\t\t{
\t\t\tshow all rows from Add_Product [Flag == true]
\t\t\t(
\t\t\t\tProduct_Name
\t\t\t)
\t\t}
\t\tlist All_Production_Batches
\t\t{
\t\t\tshow all rows from Add_Production_Batch [Status == "Active"]
\t\t\t(
\t\t\t\tBatch_No
\t\t\t)
\t\t}
\t\tlist Archive_Batches
\t\t{
\t\t\tshow all rows from Add_Production_Batch [Status == "Archive"]
\t\t\t(
\t\t\t\tBatch_No
\t\t\t)
\t\t}
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 2, seed: 'views' });
  assert.match(r.readme, /Import each CSV \*\*once\*\*/);
  assert.match(r.readme, /Import this file \*\*once\*\*/);
  assert.match(r.readme, /Final_Products/);
  assert.match(r.readme, /Subassemblies/);
  assert.match(r.readme, /duplicates `Product_Name`/);
  assert.match(r.readme, /trips unique `Batch_No`/);
  assert.match(r.orderText, /Import each file once/);
});

test('a single-record form caps its row count', () => {
  const app = appOf(
    `\tform Setup
\t{
\t\tmust have Company_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tproperties
\t\t{
\t\t\ttotal entries
\t\t\t{
\t\t\t\tallowed count = 1
\t\t\t}
\t\t}
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 20, seed: 'one' });
  assert.equal(r.files[0].rowCount, 1);
  assert.ok(r.warnings.some((w) => w.form === 'Setup'));
});

/** Import files and `type` worksheet lines, in the order the user follows. */
function procedure(orderText: string): { kind: 'type' | 'import'; name: string }[] {
  const steps: { kind: 'type' | 'import'; name: string }[] = [];
  for (const line of orderText.split('\n')) {
    const typed = /^type\s+\S+\s+\(([^)]+)\)/.exec(line);
    if (typed) {
      steps.push({ kind: 'type', name: typed[1] });
      continue;
    }
    const imported = /^\d+\.\s+\S+\s+\(([^,]+),/.exec(line);
    if (imported) steps.push({ kind: 'import', name: imported[1] });
  }
  return steps;
}

/**
 * Walk the documented order. A required lookup resolves only against a parent
 * key loaded by an earlier step. The parent's key is that step's first column.
 */
function assertLookupsResolve(
  r: ReturnType<typeof generateCreatorImport>,
  lookups: { form: string; column: string; parent: string }[],
): void {
  const loaded = new Map<string, Set<string>>();
  for (const step of procedure(r.orderText)) {
    let table: string[][];
    if (step.kind === 'import') {
      const file = r.files.find((f) => f.form === step.name);
      assert.ok(file, step.name);
      table = parseCsv(file.csv);
    } else {
      const sheet = r.manual.find((m) => m.form === step.name);
      assert.ok(sheet, step.name);
      table = sectionCsv(sheet.body, '## Parent rows');
    }
    const header = table[0];
    for (const look of lookups.filter((item) => item.form === step.name)) {
      const col = header.indexOf(look.column);
      assert.ok(col >= 0, `${step.name}.${look.column}`);
      const parentKeys = loaded.get(look.parent);
      for (const row of table.slice(1)) {
        const value = row[col];
        assert.ok(parentKeys?.has(value), `${step.name}.${look.column}="${value}" has no loaded ${look.parent}`);
      }
    }
    const keys = loaded.get(step.name) ?? new Set<string>();
    for (const row of table.slice(1)) keys.add(row[0]);
    loaded.set(step.name, keys);
  }
}

test('expenses-shaped reference grid orders the worksheet parent before the child import', () => {
  const app = appOf(
    `\tform Add_Expense_Category
\t{
\t\tmust have Category_Name
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Add_Policy
\t{
\t\tmust have unique Policy_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have Categorywise_Limits
\t\t(
\t\t\ttype = grid
\t\t\tvalues = Add_Expense_Limits.ID
\t\t\tbidirectional = Policy
\t\t)
\t}
\tform Add_Expense_Limits
\t{
\t\tmust have Policy
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Policy.ID
\t\t\tdisplayformat = [Policy_Name]
\t\t)
\t\tmust have Expense_Category
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Expense_Category.ID
\t\t\tdisplayformat = [Category_Name]
\t\t)
\t\tmust have Expense_Amount_Limit
\t\t(
\t\t\ttype = number
\t\t)
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 4, seed: 'expenses' });
  const steps = procedure(r.orderText);
  const at = (name: string) => {
    const i = steps.findIndex((s) => s.name === name);
    assert.ok(i >= 0, `${name} missing from import order`);
    return i;
  };
  assert.ok(at('Add_Expense_Category') < at('Add_Expense_Limits'));
  assert.ok(at('Add_Policy') < at('Add_Expense_Limits'));
  assert.equal(r.files.some((f) => f.form === 'Add_Policy'), false);
  const policy = r.manual.find((m) => m.form === 'Add_Policy');
  assert.ok(policy);
  assert.equal(policy.body.includes('## Categorywise_Limits'), false);
  assert.match(policy.body, /Add_Expense_Limits\.csv/);
  assert.match(policy.body, /`Policy`/);
  assertLookupsResolve(r, [
    { form: 'Add_Expense_Limits', column: 'Policy', parent: 'Add_Policy' },
    { form: 'Add_Expense_Limits', column: 'Expense_Category', parent: 'Add_Expense_Category' },
  ]);
});

test('facilities-shaped reference grid carries child columns and orders worksheet parents first', () => {
  const app = appOf(
    `\tform Add_Company_Details
\t{
\t\tmust have Company_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tBranches
\t\t(
\t\t\ttype = grid
\t\t\tvalues = Add_Site.ID
\t\t\tbidirectional = Company
\t\t)
\t}
\tform Add_Site
\t{
\t\tmust have Company
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Company_Details.ID
\t\t\tdisplayformat = [Company_Name]
\t\t)
\t\tmust have Branch_Site_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tBuildings
\t\t(
\t\t\ttype = grid
\t\t\tvalues = Add_Building.ID
\t\t\tbidirectional = Associated_Site
\t\t)
\t}
\tform Add_Building
\t{
\t\tmust have Associated_Site
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Site.ID
\t\t\tdisplayformat = [Branch_Site_Name]
\t\t)
\t\tmust have Building_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tGateways
\t\t(
\t\t\ttype = grid
\t\t\tvalues = Add_Gateway.ID
\t\t\tbidirectional = Building
\t\t)
\t}
\tform Add_Gateway
\t{
\t\tmust have Spot_Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have Building
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Building.ID
\t\t\tdisplayformat = [Building_Name]
\t\t)
\t\tmust have Floor
\t\t(
\t\t\ttype = number
\t\t)
\t\tAssets_With_Quantity
\t\t(
\t\t\ttype = grid
\t\t\tvalues = Add_Asset_To_Gateway.ID
\t\t\tbidirectional = Gateway
\t\t)
\t}
\tform Add_Asset_To_Gateway
\t{
\t\tmust have Gateway
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Add_Gateway.ID
\t\t\tdisplayformat = [Spot_Name]
\t\t)
\t\tmust have Quantity
\t\t(
\t\t\ttype = number
\t\t)
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 4, seed: 'facilities' });
  const steps = procedure(r.orderText);
  const at = (name: string) => {
    const i = steps.findIndex((s) => s.name === name);
    assert.ok(i >= 0, `${name} missing from import order`);
    return i;
  };
  const chain = ['Add_Company_Details', 'Add_Site', 'Add_Building', 'Add_Gateway', 'Add_Asset_To_Gateway'];
  for (let i = 1; i < chain.length; i++) assert.ok(at(chain[i - 1]) < at(chain[i]), chain[i]);
  assert.equal(r.files.some((f) => f.form === 'Add_Gateway' || f.form === 'Add_Building'), false);
  assert.ok(r.files.some((f) => f.form === 'Add_Asset_To_Gateway'));
  const building = r.manual.find((m) => m.form === 'Add_Building');
  assert.ok(building);
  const gateways = sectionCsv(building.body, '## Gateways');
  assert.ok(gateways[0].includes('Spot_Name'), gateways[0].join(','));
  assert.ok(gateways[0].includes('Floor'), gateways[0].join(','));
  const buildingNames = new Set(sectionCsv(building.body, '## Parent rows').slice(1).map((row) => row[0]));
  for (const row of gateways.slice(1)) assert.ok(buildingNames.has(row[0]), row[0]);
  const gateway = r.manual.find((m) => m.form === 'Add_Gateway');
  assert.ok(gateway);
  assert.equal(gateway.body.includes('## Assets_With_Quantity'), false);
  assertLookupsResolve(r, [
    { form: 'Add_Site', column: 'Company', parent: 'Add_Company_Details' },
    { form: 'Add_Building', column: 'Associated_Site', parent: 'Add_Site' },
    { form: 'Add_Gateway', column: 'Building', parent: 'Add_Building' },
    { form: 'Add_Asset_To_Gateway', column: 'Gateway', parent: 'Add_Gateway' },
  ]);
});

test('a mutual lookup cycle is reported as a manual worksheet', () => {
  const app = appOf(
    `\tform Left
\t{
\t\tmust have Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have To_Right
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Right.ID
\t\t\tdisplayformat = [Name]
\t\t)
\t}
\tform Right
\t{
\t\tmust have Name
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have To_Left
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Left.ID
\t\t\tdisplayformat = [Name]
\t\t)
\t}`,
  );
  const r = generateCreatorImport(app, { rows: 3, seed: 'cycle' });
  assert.equal(r.files.some((f) => f.form === 'Left' || f.form === 'Right'), false);
  for (const name of ['Left', 'Right']) {
    const skipped = r.skipped.find((s) => s.form === name);
    assert.ok(skipped, name);
    assert.match(skipped.reason, /cyclic/);
    assert.ok(r.manual.some((m) => m.form === name), name);
  }
  assert.equal(procedure(r.orderText).some((s) => s.kind === 'import' && (s.name === 'Left' || s.name === 'Right')), false);
});
