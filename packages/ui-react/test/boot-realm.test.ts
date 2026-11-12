/**
 * Boot realm resilience: components measure overlays with ResizeObserver,
 * which every shipping browser has but a document of another realm (jsdom
 * under Node) may not. A control that constructs one unconditionally (the
 * decision checkbox's hidden carrier, inside the component library) threw
 * mid-render and unmounted the whole app: every later route rendered nothing.
 * bootApp now installs a no-op stub where the API is missing, so one such
 * control cannot blank the app.
 *
 * The render test needs the template's runtime dependencies
 * (`npm ci --prefix packages/ui-react/template`); without them it skips
 * locally and fails under CI, where the install step is part of the run.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { TEMPLATE_DIR, reactAppSpec } from '../src/index.js';

const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react')) && existsSync(join(MODULES, 'react-dom'));
const MISSING = 'template runtime dependencies are not installed: run `npm ci --prefix packages/ui-react/template`';
const SKIP = runtimeReady ? false : process.env.CI === 'true' ? false : MISSING;
const LIB = join(TEMPLATE_DIR, 'lib');

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
      .replace(/^(\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm, (_all, pre: string, spec: string) => specifier(pre, spec));
    writeFileSync(target, rewritten);
  }
  symlinkSync(MODULES, join(out, 'node_modules'), 'dir');
}

function source(): string {
  return `application "Desk"
{
	list Orders
	{
		displayname = "Orders"
		show all rows from Order
		(
			Title
			Paid
		)
	}
	form Order
	{
		displayname = "Order"
		Title
		(
			type = text
			displayname = "Title"
		)
		Paid
		(
			type = decision box
			displayname = "Paid"
		)
	}
}
`;
}

function app(): App {
  return deriveIr(parse(source()));
}

test('a ResizeObserver-less realm cannot let one control unmount the whole app', { skip: SKIP }, async (t) => {
  const out = join(tmpdir(), `c2c-boot-realm-${process.pid}`);
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compileLib(out);

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><a class="skip-link" href="#main">Skip to content</a><div id="root"><main id="main"></main></div></body></html>', {
    url: 'https://app.example.test/',
    pretendToBeVisual: true,
  });
  const view = dom.window as unknown as Record<string, unknown> & Window;
  // The globals React DOM and the components read in a same-realm boot, the
  // same set the report view tests publish. ResizeObserver is deliberately
  // absent: that is the realm this test proves safe.
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'DocumentFragment', 'SVGElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTableElement', 'getComputedStyle', 'CSS', 'self', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = new Map<string, unknown>();
  for (const key of globals) {
    saved.set(key, (globalThis as Record<string, unknown>)[key]);
    try {
      (globalThis as Record<string, unknown>)[key] = view[key as keyof typeof view];
    } catch {
      Object.defineProperty(globalThis, key, { value: view[key as keyof typeof view], configurable: true });
    }
  }
  const savedObserver = (globalThis as Record<string, unknown>).ResizeObserver;
  delete (globalThis as Record<string, unknown>).ResizeObserver;
  t.after(() => {
    for (const key of globals) {
      try {
        (globalThis as Record<string, unknown>)[key] = saved.get(key);
      } catch {
        Object.defineProperty(globalThis, key, { value: saved.get(key), configurable: true, writable: true });
      }
    }
    if (savedObserver === undefined) delete (globalThis as Record<string, unknown>).ResizeObserver;
    else (globalThis as Record<string, unknown>).ResizeObserver = savedObserver;
    view.close();
  });
  const w = view as unknown as Record<string, unknown>;
  if (typeof w.matchMedia !== 'function') {
    w.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  }
  assert.equal(typeof (globalThis as Record<string, unknown>).ResizeObserver, 'undefined', 'the test realm has no ResizeObserver');
  view.fetch = (() => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"rows":[]}', json: async () => ({ rows: [] }) })) as unknown as typeof fetch;

  const require = createRequire(join(out, 'lib', 'loader.cjs'));
  const React = require('react') as { createElement: (type: unknown, props: unknown, child?: unknown) => unknown };
  const { bootApp } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/boot.js')).href)) as {
    bootApp: (spec: unknown, doc: Document | undefined, routes: Record<string, () => unknown>, custom: Record<string, unknown>) => () => void;
  };
  const { FormView } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/form/FormView.js')).href)) as { FormView: unknown };
  const { Field } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/form/fields.js')).href)) as { Field: unknown };
  const { ReportView } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/report/ReportView.js')).href)) as { ReportView: unknown };

  const spec = reactAppSpec(app());
  const routes: Record<string, () => unknown> = {
    'form/Order': () => React.createElement(FormView, { form: spec.forms.Order!, edit: undefined }, React.createElement(Field, { name: 'Paid' })),
    'report/Orders': () => React.createElement(ReportView, { report: spec.reports.Orders!, row: undefined }),
  };
  const unmount = bootApp(spec, view.document, routes, {});

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => view.setTimeout(resolve, 0));
  };
  const main = () => view.document.getElementById('main') ?? view.document.body;

  view.location.hash = '#/form/Order';
  await settle();
  assert.ok(main().querySelector('form'), 'the decision form renders');
  assert.ok(main().innerHTML.length > 200, 'the app stays mounted after the decision control measured itself');

  view.location.hash = '#/report/Orders';
  await settle();
  const section = main().querySelector('[data-report="Orders"]');
  assert.ok(section, 'the report route still renders after a control hit the missing ResizeObserver');

  assert.equal(typeof unmount, 'function', 'boot hands back the unmount');
  unmount();
  await settle();
  assert.equal(view.document.getElementById('root')?.childElementCount, 0, 'the unmount empties #root');
});
