/**
 * A form, field, report or page named exactly `__proto__` cannot live in the
 * generated name-keyed map literals (`{"__proto__": ...}` sets the prototype).
 * It is refused with a counted `refused-name` todo and nothing is generated
 * from it. `constructor` and `prototype` stay ordinary names.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import { analyze } from '../src/analyze.js';
import { buildMigrationReport } from '../src/migration-report.js';

const source = (form: string, field: string, report: string, page: string) => `application "Evil"
{
\tsection Main
\t{
\t\tform ${form}
\t\t{
\t\t\t${field}
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tKeep
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tform Orders
\t\t{
\t\t\t${field}
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tlist ${report}
\t\t{
\t\t\tshow all rows from Orders
\t\t}
\t}
\tpage ${page}
\t{
\t\tContent="<zml><layout><row><column width='100%'><text value='Hi'></text></column></row></layout></zml>"
\t}
}
`;

const refusedOf = (report: ReturnType<typeof analyze>) => report.deluge.todoLocations.filter((t) => t.construct === 'refused-name');

test('forms, fields, reports and pages named __proto__ are refused with a counted diagnostic and generate nothing', () => {
  const app = deriveIr(parse(source('__proto__', '__proto__', '__proto__', '__proto__')));
  assert.deepEqual(app.refusedNames?.map((r) => r.kind).sort(), ['field', 'form', 'page', 'report']);
  assert.deepEqual(app.forms.map((f) => f.name), ['Orders']);
  assert.equal(app.forms[0]!.fields.length, 0);
  assert.equal(app.reports.length, 0);
  assert.equal(app.pages.length, 0);
  assert.equal(generateSchema(app).tables.some((t) => t.name.includes('__proto__')), false);

  const report = analyze(app);
  assert.equal(refusedOf(report).length, 4);
  assert.equal(report.determinism.todoKinds.find((k) => k.construct === 'refused-name')?.count, 4);
  assert.equal(report.determinism.deterministic, false);
  assert.ok(refusedOf(report).every((t) => t.manualStep?.includes('Rename it')));

  const migration = JSON.stringify(buildMigrationReport([{ name: 'evil', ir: app }], 'inline'));
  assert.match(migration, /refused-name/);
});

for (const name of ['constructor', 'prototype']) {
  test(`${name} stays an ordinary name: nothing is refused`, () => {
    const app = deriveIr(parse(source(name, name, name, name)));
    assert.equal(app.refusedNames, undefined);
    assert.equal(app.forms[0]!.name, name);
    assert.equal(refusedOf(analyze(app)).length, 0);
  });
}
