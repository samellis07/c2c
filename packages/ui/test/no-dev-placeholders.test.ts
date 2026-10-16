/**
 * End users never see a generator placeholder in the vanilla client. A field,
 * report or page part the generator cannot draw renders nothing, or a neutral
 * "not available yet" line where an empty space would confuse; the reason is
 * a migration note in the console, `c2c analyze` and the migration report.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, parseFile, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { analyze } from '../../cli/src/analyze.js';
import { buildUi } from '../src/index.js';

const FIXTURES = {
  library: 'fixtures/redistributable/library-application-system/library_application.ds',
  'kitchen-sink-gaps': 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds',
};

/** Developer wording that must never reach an end user's screen. */
const DEV_WORDING = /not generated|has no generated|\bZML\b|\bstub\b|c2c-not-generated|not migrated|wire the click/i;
const DEV_UPPER = /\bTODO\b/;

type Runtime = { renderRoute: (model: unknown, route: { name: string; id: string }, doc: Document) => string };

async function runtimeOf(app: App, t: { after: (fn: () => void) => void }) {
  const built = buildUi(app);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-no-dev-placeholders-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  for (const file of built.files) {
    const full = join(dir, file.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.data);
  }
  const runtimePath = built.files.map((file) => file.path).find((path) => /slate\/assets\/runtime\.[0-9a-f]{10}\.js$/.test(path));
  assert.ok(runtimePath, 'the bundle ships the runtime');
  const runtime = (await import(pathToFileURL(join(dir, runtimePath)).href)) as Runtime;
  return { runtime, model: built.model };
}

/** Every screen of the app, drawn into a document; returns the body text per route. */
function screens(runtime: Runtime, model: { forms: { name: string }[]; reports: { name: string }[]; pages: { name: string }[] }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.example.test/' });
  const doc = dom.window.document as unknown as Document;
  const out: { route: string; text: string; doc: Document }[] = [];
  const routes = [
    ...model.forms.map((form) => ({ name: 'form', id: form.name })),
    ...model.reports.map((report) => ({ name: 'report', id: report.name })),
    ...model.pages.map((page) => ({ name: 'page', id: page.name })),
  ];
  for (const route of routes) {
    doc.body.innerHTML = runtime.renderRoute(model, route, doc);
    out.push({ route: `${route.name}/${route.id}`, text: doc.body.textContent ?? '', doc });
  }
  return out;
}

function quiet(t: { after: (fn: () => void) => void }): string[] {
  const info = console.info;
  const logged: string[] = [];
  console.info = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  t.after(() => {
    console.info = info;
  });
  return logged;
}

test('no developer wording reaches the end-user DOM of any form, report or page', async (t) => {
  const logged = quiet(t);
  for (const [name, path] of Object.entries(FIXTURES)) {
    const app = parseFile(join(repoRoot(), path)).ir;
    const { runtime, model } = await runtimeOf(app, t);
    let unavailable = 0;
    for (const screen of screens(runtime, model)) {
      assert.ok(screen.text.length > 0, `${name} ${screen.route} renders`);
      assert.doesNotMatch(screen.text, DEV_WORDING, `${name} ${screen.route}`);
      assert.doesNotMatch(screen.text, DEV_UPPER, `${name} ${screen.route}`);
      unavailable += screen.doc.querySelectorAll('.unavailable-note').length;
    }
    const undrawn = model.forms.flatMap((form) => form.fields.filter((field) => field.widget === 'unsupported'));
    assert.equal(unavailable, undrawn.length, `${name}: each unsupported field keeps its label and one neutral line`);
    // What the screen leaves out is still listed for the developer.
    const blockers = analyze(app).blockers.filter((blocker) => blocker.kind === 'ui');
    assert.equal(blockers.length, model.todos.length, `${name}: every UI TODO is a listed blocker`);
  }
  assert.ok(logged.some((line) => line.startsWith('[c2c] field ')), 'a hidden field reason goes to the console');
});

test('a report that is not generated keeps its heading and a neutral line; a format rule that did not translate is not on screen', async (t) => {
  const logged = quiet(t);
  const app = deriveIr(parse(`application "Desk"
{
	form Order
	{
		displayname = "Order"
		Title
		(
			type = text
			displayname = "Title"
		)
	}
	list Orders
	{
		displayname = "Orders"
		show all rows from Order
		(
			Title
		)
	}
}
`));
  const { runtime, model } = await runtimeOf(app, t);
  const report = model.reports.find((item) => item.name === 'Orders')!;
  const broken = { ...model, reports: [{ ...report, status: 'todo', todo: 'Report type grid is not generated.' }] };
  const [screen] = screens(runtime, { ...broken, forms: [], pages: [] });
  assert.match(screen!.text, /Orders/);
  assert.match(screen!.text, /This part of the page is not available yet\./);
  assert.doesNotMatch(screen!.text, DEV_WORDING);
  const formatted = { ...model, reports: [{ ...report, conditionalFormats: [{ criteria: { op: 'todo', construct: 'report-criteria' }, style: {} }] }] };
  const [list] = screens(runtime, { ...formatted, forms: [], pages: [] });
  assert.doesNotMatch(list!.text, DEV_WORDING);
  assert.ok(logged.some((line) => /Report type grid is not generated/.test(line)), 'the reason goes to the console');
  assert.ok(logged.some((line) => /conditional formatting rule was not migrated/.test(line)), 'the format note goes to the console');
});
