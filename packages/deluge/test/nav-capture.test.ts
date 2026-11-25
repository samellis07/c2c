/**
 * A workflow's `openUrl` navigates the browser after the workflow ends, to the
 * target evaluated when the statement ran; the last one that ran wins and the
 * statements after it still run. These tests pin that for each position an
 * `openUrl` can take among real server statements, and that the instruction
 * the function returns resolves to this app's own routes.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { emptyApp, type App, type FunctionDef } from '../../core/src/index.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { generate, navRoutesSource } from '../src/generate.js';

const Z = { start: 0, end: 0 };

function field(name: string): App['forms'][number]['fields'][number] {
  return { name, type: 'text', modifiers: [], required: false, unique: false, properties: [], subfields: [], annotations: [], flags: [], span: Z };
}

function form(name: string, fields: string[]): App['forms'][number] {
  return { name, properties: [], fields: fields.map(field), actions: [], blocks: [], span: Z };
}

function demo(text: string, signature = 'void Nav.go(Task t)'): App {
  const fn: FunctionDef = { name: 'Nav.go', kind: 'creator', signature, properties: [], deluge: [{ text, span: Z }], span: Z };
  return {
    ...emptyApp('empty'),
    name: 'Demo_App',
    forms: [form('Task', ['Status', 'Note']), form('Audit', ['Task_Ref', 'Status'])],
    reports: [{ name: 'All_Tasks', type: 'list', modifiers: [], form: 'Task', flags: [], properties: [], columns: [], customActions: [], conditionalFormats: [], filters: [], groupBy: [], sortBy: [], blocks: [], span: Z } as unknown as App['reports'][number]],
    pages: [{ name: 'Board', params: ['Task_Id'], zml: [], references: [], properties: [], span: Z }],
    functions: [fn],
  };
}

async function loadFunction(t: { after(fn: () => void): void }, app: App): Promise<{ call: (task: Record<string, unknown>) => Promise<unknown>; resolve: (value: unknown) => unknown; todos: string[]; source: string }> {
  const g = generate(app);
  const file = g.files.find((f) => f.path === 'functions/custom/nav-go.mjs');
  assert.ok(file, 'the function generated a module');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-nav-capture-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const f of g.files.filter((item) => item.path.startsWith('functions/'))) {
    const dest = join(dir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.source);
  }
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  {
    const mod = (await import(pathToFileURL(join(dir, 'functions/custom/nav-go.mjs')).href)) as Record<string, (ctx: unknown, ...args: unknown[]) => Promise<unknown>>;
    const registry = (await import(pathToFileURL(join(dir, 'functions/thisapp.mjs')).href)) as { functions: never };
    const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', functions: registry.functions });
    const ctx = runtime.context({ record: {} });
    const routes = JSON.parse(navRoutesSource(app));
    return {
      call: (task) => mod.Nav_go!(ctx, task),
      resolve: (value) => (ctx as unknown as { shim: { nav: { resolve(v: unknown, r: unknown): unknown } } }).shim.nav.resolve(value, routes),
      todos: g.todos.map((t) => t.construct),
      source: file.source,
    };
  }
}

const NAV = /openurl-dropped|openurl-unsupported/;

test('an openUrl after a nested if is carried as the returned navigation', async (t) => {
  const run = await loadFunction(
    t,
    demo(
      [
        'if (t.Status == "Open")',
        '{',
        '  if (t.Note == "urgent")',
        '  {',
        '    t.Status = "Escalated";',
        '  }',
        '  openUrl("#Report:All_Tasks", "same window");',
        '}',
      ].join('\n'),
    ),
  );
  assert.deepEqual(run.todos.filter((c) => NAV.test(c)), []);
  assert.deepEqual(run.resolve(await run.call({ Status: 'Open', Note: 'urgent' })), { kind: 'navigate', url: '#/report/All_Tasks', target: 'same' });
  assert.equal(run.resolve(await run.call({ Status: 'Closed' })), null, 'no openUrl ran, so there is no navigation');
});

test('two openUrl calls in different branches each navigate when their branch runs', async (t) => {
  const run = await loadFunction(
    t,
    demo(
      [
        't.Note = "seen";',
        'if (t.Status == "Open")',
        '{',
        '  openUrl("#Form:Audit?Status=Open", "popup window");',
        '}',
        'else',
        '{',
        '  t.Status = "Reviewed";',
        '  openUrl("#Page:Board?Task_Id=" + t.Note, "same window");',
        '}',
      ].join('\n'),
    ),
  );
  assert.deepEqual(run.todos.filter((c) => NAV.test(c)), []);
  assert.deepEqual(run.resolve(await run.call({ Status: 'Open' })), { kind: 'navigate', url: '#/form/Audit?Status=Open', target: 'new' });
  assert.deepEqual(run.resolve(await run.call({ Status: 'Done' })), { kind: 'navigate', url: '#/page/Board?Task_Id=seen', target: 'same' });
});

test('statements after an openUrl still run and the navigation is still returned', async (t) => {
  const task: Record<string, unknown> = { Status: 'Open' };
  const run = await loadFunction(t, demo(['openUrl("#Report:All_Tasks", "same window");', 't.Status = "Done";'].join('\n')));
  assert.deepEqual(run.todos.filter((c) => NAV.test(c)), []);
  assert.deepEqual(run.resolve(await run.call(task)), { kind: 'navigate', url: '#/report/All_Tasks', target: 'same' });
  assert.match(run.source, /"Status"\], "Done"/);
});

test('an openUrl ahead of an if is replaced by a later openUrl that runs (the last one wins)', async (t) => {
  const run = await loadFunction(
    t,
    demo(
      [
        'openUrl("#Report:All_Tasks", "same window");',
        'if (t.Status == "Open")',
        '{',
        '  t.Status = "Done";',
        '  openUrl("#Form:Audit", "popup window");',
        '}',
      ].join('\n'),
    ),
  );
  assert.deepEqual(run.todos.filter((c) => NAV.test(c)), []);
  assert.deepEqual(run.resolve(await run.call({ Status: 'Open' })), { kind: 'navigate', url: '#/form/Audit', target: 'new' });
  assert.deepEqual(run.resolve(await run.call({ Status: 'Done' })), { kind: 'navigate', url: '#/report/All_Tasks', target: 'same' });
});

test('a target concatenated from the app address, fields and a local resolves to an own-app route with the record id', async (t) => {
  const run = await loadFunction(
    t,
    demo(
      [
        't.Status = "Closed";',
        'url = zoho.appuri + "#Form:Audit?recLinkID=" + t.ID + "&Status=" + t.Status + "&viewLinkName=All_Tasks&zc_NextUrl=#Report:All_Tasks";',
        'openUrl(url, "popup window");',
      ].join('\n'),
    ),
  );
  assert.deepEqual(run.todos.filter((c) => NAV.test(c)), []);
  assert.deepEqual(run.resolve(await run.call({ ID: '77', Status: 'Open' })), { kind: 'navigate', url: '#/form/Audit/edit/77?Status=Closed', target: 'new' });
});

test('a page refresh is a reload, and a script call that is not a refresh stays a counted manual item', async (t) => {
  const run = await loadFunction(t, demo(['t.Status = "Done";', 'openUrl("#Script:page.refresh", "same window");'].join('\n')));
  assert.deepEqual(run.todos.filter((c) => NAV.test(c)), []);
  assert.deepEqual(run.resolve(await run.call({ Status: 'Open' })), { kind: 'reload' });
  const g = generate(demo(['t.Status = "Done";', 'openUrl("#Script:window.close", "same window");'].join('\n')));
  assert.ok(g.todos.some((t) => /^openurl-/.test(t.construct)), `an unknown script call is still counted: ${g.todos.map((t) => t.construct)}`);
});

test('a target that names a form, page parameter or filter this app does not have resolves to no navigation', async (t) => {
  const run = await loadFunction(
    t,
    demo(['t.Status = "Done";', 'if (t.Note == "a") { openUrl("#Form:Missing", "same window"); }', 'if (t.Note == "b") { openUrl("#Page:Board?Secret=" + t.ID, "same window"); }', 'if (t.Note == "c") { openUrl("#Report:All_Tasks?Status_op=2&Status=x", "same window"); }'].join('\n')),
  );
  for (const note of ['a', 'b', 'c']) assert.equal(run.resolve(await run.call({ Note: note, ID: '1' })), null, note);
});

test('a form opened with a value for a field it does not have still opens, without that value', async (t) => {
  const run = await loadFunction(t, demo(['t.Status = "Done";', 'openUrl("#Form:Audit?Task_Reff=" + t.ID + "&Status=Open&zc_Header=false", "popup window");'].join('\n')));
  assert.deepEqual(run.todos.filter((c) => NAV.test(c)), []);
  assert.deepEqual(run.resolve(await run.call({ ID: '9' })), { kind: 'navigate', url: '#/form/Audit?Status=Open', target: 'new' });
});

test('an openUrl written only in a comment is no navigation and raises no manual item', () => {
  const g = generate(demo(['t.Status = "Done";', '// openUrl("#Form:Audit", "popup window");'].join('\n')));
  assert.deepEqual(g.todos.filter((t) => NAV.test(t.construct)), []);
});

test('a function that calls a navigating function returns the callee navigation', async (t) => {
  const outer: FunctionDef = { name: 'Nav.go', kind: 'creator', signature: 'void Nav.go(Task t)', properties: [], deluge: [{ text: 't.Note = "x";\nthisapp.Nav.inner(t);\nt.Status = "after";', span: Z }], span: Z };
  const inner: FunctionDef = { name: 'Nav.inner', kind: 'creator', signature: 'void Nav.inner(Task t)', properties: [], deluge: [{ text: 't.Note = "y";\nopenUrl("#Report:All_Tasks", "same window");', span: Z }], span: Z };
  const base = demo('');
  const run = await loadFunction(t, { ...base, functions: [outer, inner] });
  assert.deepEqual(run.todos.filter((c) => NAV.test(c)), []);
  assert.deepEqual(run.resolve(await run.call({ Status: 'Open' })), { kind: 'navigate', url: '#/report/All_Tasks', target: 'same' });
});

test('a function that returns a value of its own keeps a counted manual item for its navigation', () => {
  const g = generate(demo(['t.Note = "x";', 'openUrl("#Report:All_Tasks", "same window");', 'return t.Note;'].join('\n'), 'string Nav.go(Task t)'));
  assert.ok(g.todos.some((t) => /^openurl-dropped/.test(t.construct)));
});
