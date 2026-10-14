/**
 * Render-error boundaries: a screen that throws while it renders used to
 * unmount the whole React root, so every later route painted nothing. The
 * shell now wraps the open screen in a boundary keyed by route: the screen
 * shows "This screen could not be shown" with Retry, the menu keeps working,
 * and the next route renders. A last-resort boundary covers the app itself.
 *
 * The render tests need the template's runtime dependencies
 * (`npm ci --prefix packages/ui-react/template`); without them they skip
 * locally and fail under CI, where the install step is part of the run.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test, type TestContext } from 'node:test';
import ts from 'typescript';
import { deriveIr, parse } from '../../core/src/index.js';
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

const SOURCE = `application "Desk"
{
	list Orders
	{
		displayname = "Orders"
		show all rows from Order
		(
			Title
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
	}
}
`;

/** A record value the thrown message quotes; the console line must not carry it. */
const SECRET = 'ACME-SECRET-4711';

let compiled: string | undefined;
function lib(): string {
  if (!compiled) {
    compiled = join(tmpdir(), `c2c-error-boundary-${process.pid}`);
    const out = compiled;
    after(() => rmSync(out, { recursive: true, force: true }));
    compileLib(out);
  }
  return compiled;
}

interface Mounted {
  view: Window & Record<string, unknown>;
  main: () => HTMLElement;
  settle: () => Promise<void>;
  go: (hash: string) => Promise<void>;
  logs: string[];
  React: { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown };
  boot: (routes: Record<string, () => unknown>, custom?: Record<string, unknown>) => void;
}

/** A fresh jsdom document, the realm globals React DOM reads, and console.error captured. */
async function mount(t: TestContext): Promise<Mounted> {
  const out = lib();
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://app.example.test/', pretendToBeVisual: true });
  const view = dom.window as unknown as Window & Record<string, unknown>;
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'DocumentFragment', 'SVGElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTableElement', 'getComputedStyle', 'CSS', 'self', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const key of globals) {
    saved.set(key, g[key]);
    try {
      g[key] = view[key];
    } catch {
      Object.defineProperty(globalThis, key, { value: view[key], configurable: true, writable: true });
    }
  }
  const logs: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack ?? ''}` : String(arg))).join(' '));
  };
  t.after(() => {
    console.error = consoleError;
    for (const key of globals) {
      try {
        g[key] = saved.get(key);
      } catch {
        Object.defineProperty(globalThis, key, { value: saved.get(key), configurable: true, writable: true });
      }
    }
    view.close();
  });
  if (typeof view.matchMedia !== 'function') {
    view.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof view.matchMedia;
  }
  view.fetch = (() => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"rows":[]}', json: async () => ({ rows: [] }) })) as unknown as typeof fetch;
  const require = createRequire(join(out, 'lib', 'loader.cjs'));
  const React = require('react') as Mounted['React'];
  const { bootApp } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/boot.js')).href)) as {
    bootApp: (spec: unknown, doc: Document | undefined, routes: Record<string, () => unknown>, custom: Record<string, unknown>) => void;
  };
  const spec = reactAppSpec(deriveIr(parse(SOURCE)));
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => view.setTimeout(resolve, 0));
  };
  return {
    view,
    logs,
    React,
    settle,
    main: () => (view.document.getElementById('main') ?? view.document.body) as HTMLElement,
    go: async (hash: string) => {
      view.location.hash = hash;
      await settle();
    },
    boot: (routes, custom = {}) => bootApp(spec, view.document, routes, custom),
  };
}

const ownLines = (logs: string[]) => logs.filter((line) => line.startsWith('c2c-ui:'));

test('a screen that throws shows its own error state; the menu and the next route still work', { skip: SKIP }, async (t) => {
  const m = await mount(t);
  m.boot({
    'form/Order': () => {
      throw new TypeError(`cannot read the record ${SECRET}`);
    },
    'report/Orders': () => m.React.createElement('div', { 'data-ok': 'orders' }, 'Orders list'),
  });
  await m.go('#/form/Order');
  const state = m.main().querySelector('[data-screen-error]');
  assert.ok(state, 'the throwing screen shows the boundary state, not an empty root');
  assert.equal(state.getAttribute('role'), 'alert');
  assert.equal(state.getAttribute('data-screen-error'), 'form/Order');
  assert.match(state.querySelector('h1')?.textContent ?? '', /This screen could not be shown/);
  assert.match(state.textContent ?? '', /"Order"/, 'the state names the screen');
  assert.ok(state.querySelector('.fidelity-note'), 'the state carries a fidelity note');
  assert.ok([...state.querySelectorAll('button')].some((b) => b.textContent === 'Retry'), 'the state offers Retry');
  const nav = m.view.document.getElementById('nav');
  assert.ok(nav?.querySelector('a[href="#/report/Orders"]'), 'the menu stays mounted');

  const lines = ownLines(m.logs);
  assert.equal(lines.length, 1, `one console line per render error, got ${JSON.stringify(m.logs)}`);
  assert.match(lines[0]!, /the screen "Order" could not be shown \(TypeError\)/);
  assert.ok(!m.logs.some((line) => line.includes(SECRET)), 'no console line quotes the record value');

  await m.go('#/report/Orders');
  assert.ok(m.main().querySelector('[data-ok="orders"]'), 'the next route renders after a screen threw');
  assert.equal(m.main().querySelector('[data-screen-error]'), null, 'navigation resets the boundary');
  assert.equal(nav?.querySelector('a[aria-current="page"]')?.getAttribute('href'), '#/report/Orders', 'the menu follows the route');
});

test('Retry re-mounts the screen', { skip: SKIP }, async (t) => {
  const m = await mount(t);
  let broken = true;
  let mounts = 0;
  const Fragile = () => {
    if (broken) throw new Error('not yet');
    return m.React.createElement('p', { 'data-ok': 'order' }, 'Order form');
  };
  const Counted = () => {
    const { useEffect } = m.React as unknown as { useEffect: (fn: () => void, deps: unknown[]) => void };
    useEffect(() => {
      mounts++;
    }, []);
    return m.React.createElement(Fragile);
  };
  m.boot({ 'form/Order': Counted, 'report/Orders': () => m.React.createElement('div', null, 'Orders') });
  await m.go('#/form/Order');
  assert.ok(m.main().querySelector('[data-screen-error="form/Order"]'));
  assert.equal(mounts, 0, 'the throwing screen never mounted');
  broken = false;
  const retry = [...m.main().querySelectorAll('button')].find((b) => b.textContent === 'Retry');
  assert.ok(retry);
  retry.click();
  await m.settle();
  assert.ok(m.main().querySelector('[data-ok="order"]'), 'Retry renders the screen again');
  assert.equal(m.main().querySelector('[data-screen-error]'), null);
  assert.ok(mounts >= 1, 'the screen mounted after Retry');
});

test('an error outside any screen shows the app-level fallback, not an empty page', { skip: SKIP }, async (t) => {
  const m = await mount(t);
  m.boot(
    { 'form/Order': () => m.React.createElement('div', null, 'Order') },
    {
      nav: () => {
        throw new RangeError(`bad nav ${SECRET}`);
      },
    },
  );
  await m.settle();
  const root = m.view.document.getElementById('root')!;
  const state = root.querySelector('[data-screen-error="app"]');
  assert.ok(state, 'the last-resort boundary paints its state');
  assert.match(state.querySelector('h1')?.textContent ?? '', /This app could not be shown/);
  assert.ok([...state.querySelectorAll('button')].some((b) => b.textContent === 'Retry'));
  const lines = ownLines(m.logs);
  assert.equal(lines.length, 1, `one console line, got ${JSON.stringify(m.logs)}`);
  assert.match(lines[0]!, /the app could not be shown \(RangeError\)/);
  assert.ok(!m.logs.some((line) => line.includes(SECRET)));
});
