/**
 * End users never see a generator placeholder. A field, report, chart, value
 * or page part the generator cannot draw renders nothing, or a neutral "not
 * available yet" line where an empty space would confuse; the reason is a
 * migration note listed by `c2c analyze` and the migration report.
 *
 * The render test boots every form, report and page of the library and
 * kitchen-sink-gaps fixtures in jsdom. It needs the template's runtime
 * dependencies (`npm ci --prefix packages/ui-react/template`); without them it
 * skips locally and fails under CI, where the install step is part of the run.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { parseFile, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { analyze } from '../../cli/src/analyze.js';
import { buildMigrationReport, migrationReportAsText } from '../../cli/src/migration-report.js';
import { TEMPLATE_DIR, generateReactApp, hiddenParts, reactAppSpec } from '../src/index.js';
import type { AppSpec } from '../template/lib/c2c-ui/types.js';

const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react')) && existsSync(join(MODULES, 'react-dom'));
const MISSING = 'template runtime dependencies are not installed: run `npm ci --prefix packages/ui-react/template`';
const SKIP = runtimeReady ? false : process.env.CI === 'true' ? false : MISSING;
const LIB = join(TEMPLATE_DIR, 'lib');

const FIXTURES = {
  library: 'fixtures/redistributable/library-application-system/library_application.ds',
  'kitchen-sink-gaps': 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds',
};

/** Developer wording that must never reach an end user's screen. */
const DEV_WORDING = /not generated|has no generated|\bZML\b|\bstub\b|c2c-not-generated|not migrated|wire the click/i;
const DEV_UPPER = /\bTODO\b/;

function load(path: string): App {
  return parseFile(join(repoRoot(), path)).ir;
}

/** Transpile lib/c2c-ui to ESM .js under <out>/lib; css imports get a stub module, bare specifiers get a node_modules link. */
function compileLib(out: string): void {
  assert.ok(runtimeReady, MISSING);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(LIB);
  mkdirSync(out, { recursive: true });
  const stub = join(out, 'css-stub.mjs');
  writeFileSync(stub, 'export default new Proxy({}, { get: (_, key) => String(key) });\n');
  for (const file of files) {
    const target = join(out, 'lib', relative(LIB, file).replace(/\.tsx?$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    const specifier = (pre: string, spec: string): string => {
      if (spec.endsWith('.css')) {
        const to = relative(dirname(target), stub).replace(/\\/g, '/');
        return `${pre}'${to.startsWith('.') ? to : `./${to}`}'`;
      }
      return /\.[a-z]+$/.test(spec) ? `${pre}'${spec}'` : `${pre}'${spec}.js'`;
    };
    const rewritten = outputText
      .replace(/^(\s*(?:import|export)\s[^'"]*?\bfrom\s*)['"](\.{1,2}\/[^'"]+)['"]/gm, (_all, pre: string, spec: string) => specifier(pre, spec))
      .replace(/^(\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm, (_all, pre: string, spec: string) => specifier(pre, spec))
      // Lazily loaded widgets: a relative dynamic import gets the same .js suffix.
      .replace(/\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g, (_all, spec: string) => `import(${specifier('', spec)})`);
    writeFileSync(target, rewritten);
  }
  symlinkSync(MODULES, join(out, 'node_modules'), 'dir');
}

test('the fixtures carry parts the generator cannot draw, and every one is listed for the developer', () => {
  for (const [name, path] of Object.entries(FIXTURES)) {
    const app = load(path);
    const spec = reactAppSpec(app);
    const hidden = hiddenParts(spec);
    assert.ok(hidden.length > 0, `${name}: the fixture exercises at least one hidden part`);
    const listed = new Set(hidden.map((part) => `${part.location}\0${part.reason}`));
    for (const page of Object.values(spec.pages ?? {})) {
      for (const todo of page.todos) assert.ok(listed.has(`page ${page.name}\0${todo}`), `${name}: page ${page.name} lists ${todo}`);
    }
    for (const form of Object.values(spec.forms)) {
      for (const field of form.fields) {
        if (!field.generated && field.todo) assert.ok(listed.has(`form ${form.name} field ${field.name}\0${field.todo}`), `${name}: ${form.name}.${field.name} listed`);
      }
    }
    const analysis = analyze(app);
    assert.deepEqual(analysis.hiddenParts, hidden, `${name}: analyze lists the same hidden parts`);
    const report = buildMigrationReport([{ name, ir: app }], 'fixtures');
    assert.equal(report.aggregate.hiddenPartTotal, hidden.length);
    const text = migrationReportAsText(report);
    for (const part of hidden) assert.ok(text.includes(`${name}: ${part.location}: ${part.reason}`), `${name}: migration report lists ${part.location}`);
  }
});

test('generated report modules carry no placeholder note', () => {
  for (const path of Object.values(FIXTURES)) {
    for (const file of generateReactApp(load(path))) {
      if (!/^src\/generated\/(reports|pages|forms)\//.test(file.path)) continue;
      const text = String(file.data);
      assert.doesNotMatch(text, /not generated yet|data-view-pending/, file.path);
    }
  }
});

test('no developer wording reaches the end-user DOM of any form, report or page', { skip: SKIP }, async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-no-dev-placeholders-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compileLib(out);

  const require = createRequire(join(out, 'lib', 'loader.cjs'));
  const React = require('react') as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown };
  const lib = async <T>(path: string): Promise<T> => (await import(pathToFileURL(join(out, 'lib/c2c-ui', path)).href)) as T;
  const { bootApp } = await lib<{ bootApp: (spec: AppSpec, doc: Document, routes: Record<string, () => unknown>, custom: Record<string, unknown>) => void }>('boot.js');
  const { FormView } = await lib<{ FormView: unknown }>('form/FormView.js');
  const { Field } = await lib<{ Field: unknown }>('form/fields.js');
  const { ReportView } = await lib<{ ReportView: unknown }>('report/ReportView.js');
  const { ChartReport } = await lib<{ ChartReport: unknown }>('charts/ChartView.js');
  const { PageView } = await lib<{ PageView: unknown }>('pages/PageView.js');
  const { JSDOM } = await import('jsdom');

  const info = console.info;
  console.info = () => {};
  t.after(() => {
    console.info = info;
  });

  for (const [name, path] of Object.entries(FIXTURES)) {
    const spec = reactAppSpec(load(path));
    const dom = new JSDOM('<!doctype html><html><body><div id="root"><main id="main"></main></div></body></html>', {
      url: 'https://app.example.test/',
      pretendToBeVisual: true,
    });
    const view = dom.window as unknown as Record<string, unknown> & Window;
    if (typeof view.matchMedia !== 'function') {
      view.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof view.matchMedia;
    }
    const reply = { rows: [], op: 'aggregate', buckets: [], scanned: 0, truncated: false };
    view.fetch = (() => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(reply), json: async () => reply })) as unknown as typeof fetch;

    const routes: Record<string, () => unknown> = {};
    for (const form of Object.values(spec.forms)) {
      const fields = form.fields.filter((field) => field.visibility !== false).map((field) => React.createElement(Field, { key: field.name, name: field.name }));
      routes[`form/${form.name}`] = () => React.createElement(FormView, { form, edit: undefined }, ...fields);
    }
    for (const report of Object.values(spec.reports)) {
      routes[`report/${report.name}`] = () => React.createElement(report.view === 'chart' ? ChartReport : ReportView, { report, row: undefined });
    }
    for (const page of Object.values(spec.pages ?? {})) routes[`page/${page.name}`] = () => React.createElement(PageView, { page });
    bootApp(spec, view.document, routes, {});

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => view.setTimeout(resolve, 0));
    };
    let unavailable = 0;
    for (const route of Object.keys(routes)) {
      view.location.hash = `#/${route}`;
      await settle();
      const text = view.document.body.textContent ?? '';
      assert.ok(text.length > 0, `${name} ${route} renders`);
      assert.doesNotMatch(text, /could not be shown/, `${name} ${route} draws its screen, not the error boundary`);
      assert.doesNotMatch(text, DEV_WORDING, `${name} ${route}`);
      assert.doesNotMatch(text, DEV_UPPER, `${name} ${route}`);
      assert.equal(view.document.querySelectorAll('[data-todo-count], [data-view-pending], .c2c-todo-reason').length, 0, `${name} ${route}`);
      unavailable += view.document.querySelectorAll('.c2c-unavailable-note').length;
    }
    const todoFields = Object.values(spec.forms).flatMap((form) => form.fields.filter((field) => !field.generated && field.visibility !== false));
    assert.equal(unavailable, todoFields.length, `${name}: each undrawn field keeps its label and one neutral line`);
    view.close();
  }
});
