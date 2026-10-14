import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { statusFromReport } from '../../determinism/src/status.js';
import { analyze } from '../src/analyze.js';
import { buildMigrationReport } from '../src/migration-report.js';

/**
 * A pivot with no group-by renders as a list with a note plus ONE counted
 * manual item (the shelves must be rebuilt). A plain list report has none.
 * Both are parsed from the excerpt.
 */
const PIVOT_REASON = 'Rebuild the pivot table manually: the export carries no pivot shelves, so pick the row, column and measure (aggregation) fields again over Item.';

const PIVOT_STUB = `application "Ui_Stub"
{
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
		}
	}
	reports
	{
		pivottable Totals
		{
			show all rows from Item
			(
				Title
			)
		}
	}
}
`;

/** A map whose form has no address field: list + note, no counted item. */
const MAP_NO_GEO = `application "Map_No_Geo"
{
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
		}
	}
	reports
	{
		map Where
		{
			show all rows from Item
			(
				Title
			)
		}
	}
}
`;

/** A map whose form has an address with latitude/longitude: unchanged. */
const MAP_WITH_GEO = `application "Map_With_Geo"
{
	forms
	{
		form Item
		{
			Place
			(
				type = address
				latitude
				(
					type = decimal
				)
				longitude
				(
					type = decimal
				)
			)
		}
	}
	reports
	{
		map Where
		{
			show all rows from Item
			(
				Place
			)
		}
	}
}
`;

const CLEAN_LIST = `application "Ui_Clean"
{
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
		}
	}
	reports
	{
		list All_Items
		{
			show all rows from Item
			(
				Title
			)
		}
	}
}
`;

test('a pivot report without a group-by renders as a list with a note and one counted manual item', () => {
  const report = analyze(deriveIr(parse(PIVOT_STUB)));
  const stubs = report.deluge.todoLocations.filter((item) => item.scope === 'ui');
  const stubBlockers = report.blockers.filter((blocker) => blocker.scope === 'ui');
  assert.equal(report.determinism.uiTodoCount, 1);
  assert.equal(report.determinism.deterministic, false);
  assert.equal(stubs.length, 1);
  assert.equal(stubBlockers.length, 1);
  assert.equal(stubs[0]?.location, 'report Totals');
  assert.equal(stubs[0]?.construct, PIVOT_REASON);
  assert.equal(stubBlockers[0]?.label, stubs[0]?.location);
  assert.equal(stubBlockers[0]?.detail, stubs[0]?.construct);
  assert.equal(stubBlockers[0]?.kind, 'ui');
  assert.equal(report.deluge.todo, report.determinism.todoCount);
  assert.equal(report.deluge.todoLocations.length, report.deluge.todo);
  assert.equal(report.blockers.filter((blocker) => blocker.kind !== 'feature').length, report.determinism.todoCount);
  assert.equal(report.determinism.todoKinds.find((kind) => kind.construct === PIVOT_REASON)?.count, 1);
});

test('a pivot report without a group-by falls back to a generated list view with a note', () => {
  const model = buildUi(deriveIr(parse(PIVOT_STUB))).model;
  const totals = model.reports.find((report) => report.name === 'Totals');
  assert.ok(totals);
  assert.equal(totals.status, 'generated');
  assert.equal(totals.view, 'list');
  assert.equal(totals.type, 'pivottable');
  assert.equal(totals.todo, undefined);
  assert.ok(totals.note?.includes('row, column and measure'));
  assert.deepEqual(
    totals.columns.map((column) => column.field),
    ['Title'],
  );
});

test('a map report without an address field falls back to a list with a note and no counted item', () => {
  const report = analyze(deriveIr(parse(MAP_NO_GEO)));
  assert.equal(report.determinism.uiTodoCount, 0);
  assert.equal(report.determinism.todoCount, 0);
  assert.equal(report.determinism.deterministic, true);
  assert.deepEqual(report.deluge.todoLocations, []);
  const model = buildUi(deriveIr(parse(MAP_NO_GEO))).model;
  const where = model.reports.find((item) => item.name === 'Where');
  assert.ok(where);
  assert.equal(where.status, 'generated');
  assert.equal(where.view, 'list');
  assert.equal(where.type, 'map');
  assert.equal(where.todo, undefined);
  assert.ok(where.note?.includes('no address field'));
  assert.deepEqual(
    where.columns.map((column) => column.field),
    ['Title'],
  );
});

test('a map report with an address field is unchanged', () => {
  const report = analyze(deriveIr(parse(MAP_WITH_GEO)));
  assert.equal(report.determinism.todoCount, 0);
  const model = buildUi(deriveIr(parse(MAP_WITH_GEO))).model;
  const where = model.reports.find((item) => item.name === 'Where');
  assert.ok(where);
  assert.equal(where.status, 'generated');
  assert.equal(where.view, 'map');
  assert.equal(where.note, undefined);
});

test('the rendered report shows the fallback note as visible text', async () => {
  const runtime = (await import(pathToFileURL(path.resolve('packages/ui/src/client-runtime.js')).href)) as {
    renderReport(report: unknown): string;
  };
  for (const source of [PIVOT_STUB, MAP_NO_GEO]) {
    const model = buildUi(deriveIr(parse(source))).model;
    const html = runtime.renderReport(model.reports[0]);
    assert.match(html, /data-report-note/);
    assert.match(html, /Shown as a list/);
    assert.match(html, /data-view="list"/);
  }
});

test('a list report with no stub stays deterministic', () => {
  const report = analyze(deriveIr(parse(CLEAN_LIST)));
  assert.equal(report.determinism.uiTodoCount, 0);
  assert.equal(report.determinism.deterministic, true);
  assert.equal(report.determinism.todoCount, 0);
  assert.deepEqual(report.deluge.todoLocations.filter((item) => item.scope === 'ui'), []);
});

interface GeneratedReport {
  deterministic: boolean;
  todoCount: number;
  uiTodoCount: number;
  fillLockEntries: number;
}

/** The migration-report.json inside the generated tree. */
function generatedReport(text: string): GeneratedReport {
  const file = buildUi(deriveIr(parse(text))).files.find((item) => item.path === 'migration-report.json');
  assert.ok(file, 'generated tree has no migration-report.json');
  return JSON.parse(String(file.data)) as GeneratedReport;
}

test('a UI-stub-only app writes deterministic:false todoCount:1 into the generated migration-report.json', () => {
  const report = analyze(deriveIr(parse(PIVOT_STUB)));
  const generated = generatedReport(PIVOT_STUB);
  assert.equal(generated.deterministic, false);
  assert.equal(generated.todoCount, 1);
  assert.equal(generated.uiTodoCount, 1);
  assert.equal(generated.deterministic, report.determinism.deterministic);
  assert.equal(generated.todoCount, report.determinism.todoCount);
  assert.equal(generated.uiTodoCount, report.determinism.uiTodoCount);
});

test('a clean app stays deterministic:true in the generated migration-report.json', () => {
  const generated = generatedReport(CLEAN_LIST);
  assert.equal(generated.deterministic, true);
  assert.equal(generated.todoCount, 0);
  assert.equal(generated.uiTodoCount, 0);
});

test('analyze, the generated migration-report.json and the determinism status agree per app', () => {
  const cases = [
    { name: 'ui-stub', text: PIVOT_STUB },
    { name: 'clean', text: CLEAN_LIST },
  ];
  const entries = cases.map((item) => ({ name: item.name, ir: deriveIr(parse(item.text)) }));
  const report = buildMigrationReport(entries, 'inline');
  const status = statusFromReport(report);
  for (const [index, entry] of entries.entries()) {
    const a = analyze(entry.ir);
    const generated = generatedReport(cases[index]!.text);
    const row = report.apps.find((app) => app.app === entry.name);
    assert.ok(row, `migration report has no row for ${entry.name}`);
    assert.equal(generated.deterministic, a.determinism.deterministic, `${entry.name} generated flag`);
    assert.equal(generated.todoCount, a.determinism.todoCount, `${entry.name} generated todoCount`);
    assert.equal(generated.uiTodoCount, a.determinism.uiTodoCount, `${entry.name} generated uiTodoCount`);
    assert.equal(row.deterministic, a.determinism.deterministic, `${entry.name} report flag`);
    assert.equal(row.todoCount, a.determinism.todoCount, `${entry.name} report todoCount`);
    assert.equal(row.uiTodoCount, a.determinism.uiTodoCount, `${entry.name} report uiTodoCount`);
  }
  assert.equal(status.todoTotal, 1);
  assert.equal(status.deterministicApps, 1);
});
