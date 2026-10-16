/**
 * Hidden-section route gating. A Creator `hide = true` section keeps its
 * screens out of the nav, but their URLs still resolve. The vanilla runtime
 * probes the target's endpoint and paints "This page is not available." on
 * the unconditional 403; the React router now paints the same denied state
 * without mounting the screen or firing a single request — the server denies
 * hidden endpoints for every caller, so a probe can only ever come back 403.
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
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateUi } from '../../ui/src/generate.js';
import { TEMPLATE_DIR, reactAppSpec } from '../src/index.js';
import type { AppSpec, NavSection, PageElement } from '../template/lib/c2c-ui/types.js';

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
	section Main
	{
		displayname = "Main"
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
	section Secret
	{
		displayname = "Secret"
		hide = true
		form Ledger
		{
			displayname = "Ledger"
			Total
			(
				type = decimal
				displayname = "Total"
			)
		}
		list LedgerRows
		{
			displayname = "Ledger rows"
			show all rows from Ledger
			(
				Total
			)
		}
	}
}
`;

/** The same component in a hidden and a visible section stays reachable — the vanilla `hiddenTarget` rule. */
const SHARED_SOURCE = `application "Desk"
{
	section Secret
	{
		hide = true
		form Order
		{
			displayname = "Order"
			Title
			(
				type = text
			)
		}
	}
	section Main
	{
		form Order
		{
		}
	}
}
`;

function app(source = SOURCE): App {
  return deriveIr(parse(source));
}

test('the spec carries the hidden target names on denied, and keeps the nav clean', () => {
  const spec = reactAppSpec(app());
  assert.deepEqual(spec.denied, ['Ledger', 'LedgerRows'], 'every hidden-section name, list reports included');
  assert.deepEqual(
    spec.nav.map((section) => section.label),
    ['Main'],
    'hidden sections stay out of the nav',
  );
  assert.equal(reactAppSpec(deriveIr(parse(`application "Mini"\n{\n\tform Only\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t\t}\n}\n`))).denied, undefined, 'an app with nothing hidden omits the field');
});

let compiled: string | undefined;
function lib(): string {
  if (!compiled) compiled = join(tmpdir(), `c2c-hidden-route-${process.pid}`);
  const out = compiled;
  // `after` below is scoped to the test that compiles, so a later test can
  // find the shared directory already torn down (earlier tests only survived
  // on cached modules). Rebuild on demand instead of trusting the directory.
  if (!existsSync(join(out, 'lib/c2c-ui/boot.js'))) {
    compileLib(out);
    after(() => rmSync(out, { recursive: true, force: true }));
  }
  return out;
}

interface Mounted {
  view: Window & Record<string, unknown>;
  main: () => HTMLElement;
  go: (hash: string) => Promise<void>;
  settle: () => Promise<void>;
  calls: string[];
  boot: (spec: AppSpec, routes: Record<string, () => unknown>) => void;
}

/** A fresh jsdom document with a fetch spy; the app boots into it. */
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
  t.after(() => {
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
  const calls: string[] = [];
  view.fetch = ((url: unknown) => {
    calls.push(String(url));
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"rows":[]}', json: async () => ({ rows: [] }) });
  }) as unknown as typeof fetch;
  const require = createRequire(join(out, 'lib', 'loader.cjs'));
  require('react');
  const { bootApp } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/boot.js')).href)) as {
    bootApp: (spec: AppSpec, doc: Document | undefined, routes: Record<string, () => unknown>, custom: Record<string, unknown>) => void;
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => view.setTimeout(resolve, 0));
  };
  return {
    view,
    calls,
    main: () => (view.document.getElementById('main') ?? view.document.body) as HTMLElement,
    settle,
    go: async (hash: string) => {
      view.location.hash = hash;
      await settle();
    },
    boot: (spec, routes) => bootApp(spec, view.document, routes, {}),
  };
}

const denied = (main: HTMLElement) => main.querySelector('[data-access-status]');

test('direct navigation to a hidden section paints the denied state and fires no request', { skip: SKIP }, async (t) => {
  const m = await mount(t);
  const spec = reactAppSpec(app());
  let mounts = 0;
  const { createElement } = createRequire(join(lib(), 'lib', 'loader.cjs'))('react') as {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
  };
  const Screen = () => {
    mounts++;
    return createElement('div', { 'data-mounted': 'yes' }, 'a screen');
  };
  // Land on the hidden route at boot, like a pasted link: nothing may mount.
  m.view.location.hash = '#/form/Ledger';
  m.boot(spec, {
    'form/Ledger': Screen,
    'report/LedgerRows': Screen,
    'form/Order': Screen,
    'report/Orders': Screen,
  });
  await m.settle();
  assert.equal(denied(m.main())?.getAttribute('data-access-status'), '403', 'the hidden form is denied');
  assert.match(m.main().textContent ?? '', /This page is not available\./);
  assert.equal(m.main().querySelector('[data-mounted]'), null, 'the hidden screen never mounted');
  assert.equal(mounts, 0);
  assert.deepEqual(m.calls, [], 'no request fired for the hidden form');
  assert.equal(m.view.document.querySelector('#nav a[href="#/form/Ledger"]'), null, 'the nav never lists the hidden form');

  await m.go('#/report/LedgerRows');
  assert.equal(denied(m.main())?.getAttribute('data-access-status'), '403', 'the hidden report is denied');
  assert.equal(m.main().querySelector('[data-mounted]'), null);
  assert.equal(mounts, 0);
  assert.deepEqual(m.calls, [], 'no request fired for the hidden report');

  await m.go('#/form/Ledger/edit/42');
  assert.equal(denied(m.main())?.getAttribute('data-access-status'), '403', 'a hidden edit route is denied too');
  assert.equal(mounts, 0);
  assert.deepEqual(m.calls, []);

  await m.go('#/form/Order');
  assert.equal(denied(m.main()), null, 'a visible section still renders');
  assert.ok(m.main().querySelector('[data-mounted]'), 'the visible screen mounted');
  assert.ok(mounts >= 1, 'the visible screen rendered');
});


/**
 * A visible page embedding the hidden report. The page's ZML names the
 * report the caller cannot open; the spec carries the embed and the denial.
 */
const EMBED_SOURCE = `application "Desk"
{
\tsection Main
\t{
\t\tdisplayname = "Main"
\t\tform Order
\t\t{
\t\t\tdisplayname = "Order"
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Title"
\t\t\t)
\t\t}
\t\tlist Orders
\t\t{
\t\t\tdisplayname = "Orders"
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t)
\t\t}
\t}
\tsection Secret
\t{
\t\tdisplayname = "Secret"
\t\thide = true
\t\tform Ledger
\t\t{
\t\t\tdisplayname = "Ledger"
\t\t\tTotal
\t\t\t(
\t\t\t\ttype = decimal
\t\t\t\tdisplayname = "Total"
\t\t\t)
\t\t}
\t\tlist LedgerRows
\t\t{
\t\t\tdisplayname = "Ledger rows"
\t\t\tshow all rows from Ledger
\t\t\t(
\t\t\t\tTotal
\t\t\t)
\t\t}
\t}
\tpages
\t{
\t\tpage Board
\t\t{
\t\t\tdisplayname = "Board"
\t\t\tContent=${JSON.stringify("<zml><layout><row><column width='100%'><text type='Text' value='Board header'></text><report elementName='Embed' linkName='LedgerRows'/></column></row></layout></zml>")}
\t\t}
\t}
}
`;

test('a page embedding a denied report renders the denial and fires no report query', { skip: SKIP }, async (t) => {
  const ir = deriveIr(parse(EMBED_SOURCE));
  const spec = reactAppSpec(ir);
  const embedded = (elements: PageElement[]): boolean =>
    elements.some((el) => (el.kind === 'report' && el.report === 'LedgerRows') || (el.kind === 'box' && embedded(el.children)));
  assert.ok(
    Object.values(spec.pages ?? {}).some((page) => embedded(page.elements)),
    'the page spec embeds the hidden report',
  );
  assert.ok(spec.denied?.includes('LedgerRows'), 'the embedded report stays denied');
  // Mount first: it compiles the template lib the page screen renders.
  const m = await mount(t);
  const { createElement } = createRequire(join(lib(), 'lib', 'loader.cjs'))('react') as {
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
  };
  const { PageView } = (await import(pathToFileURL(join(lib(), 'lib/c2c-ui/pages/PageView.js')).href)) as {
    PageView: unknown;
  };
  // Open the visible page, like a menu click: the page draws, the embedded
  // report it names is refused in place, before any rows request.
  m.view.location.hash = '#/page/Board';
  m.boot(spec, {
    'page/Board': () => createElement(PageView, { page: spec.pages!.Board! }),
    'report/LedgerRows': () => createElement('div', { 'data-mounted': 'yes' }, 'a screen'),
  });
  await m.settle();
  const main = m.main();
  assert.ok(main.querySelector('[data-page="Board"]'), 'the visible page rendered');
  assert.match(main.querySelector('[data-page="Board"] h1')?.textContent ?? '', /Board/);
  assert.equal(denied(main)?.getAttribute('data-access-status'), '403', 'the embedded report is denied');
  assert.match(denied(main)?.textContent ?? '', /This page is not available\./);
  assert.equal(main.querySelector('[data-report="LedgerRows"]'), null, 'the denied report drew no rows');
  assert.equal(main.querySelector('[data-mounted]'), null, 'the denied report screen never mounted');
  assert.deepEqual(m.calls, [], 'the embedded denial fired no report query');
});

test('a name shared by a hidden and a visible section stays reachable', { skip: SKIP }, async (t) => {
  const m = await mount(t);
  const spec = reactAppSpec(app(SHARED_SOURCE));
  const { deniedTargets } = (await import(pathToFileURL(join(lib(), 'lib/c2c-ui/boot.js')).href)) as {
    deniedTargets: (spec: AppSpec) => ReadonlySet<string>;
  };
  assert.equal(deniedTargets(spec).has('Order'), false, 'visible membership wins');
  const { navSections } = (await import(pathToFileURL(join(lib(), 'lib/c2c-ui/boot.js')).href)) as {
    navSections: (spec: AppSpec, custom: Record<string, unknown>) => NavSection[];
  };
  assert.deepEqual(
    navSections(spec, {}).flatMap((section) => section.items.map((item) => item.name)),
    ['Order'],
    'the nav shows the visible section only',
  );
});

test('parity: vanilla and React paint the same denied state on a hidden gallery screen', { skip: SKIP }, async (t) => {
  // freight-forwarding has no hidden sections of its own; mark its first nav
  // section hidden on the model so both runtimes gate the same real gallery
  // screens (the model's nav is the input each runtime's gate reads).
  const ir = deriveIr(parse(readFileSync(join(process.cwd(), 'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds'), 'utf8')));
  const model = generateUi(ir).model;
  const navSection = model.nav[0]!;
  navSection.hidden = true;
  const item = navSection.items.find((i) => i.href !== '');
  assert.ok(item?.href, 'the section names a routable screen');
  const hash = item.href;

  // Vanilla: the gate probe hits the endpoint, the 403 paints the denial.
  const { JSDOM } = await import('jsdom');
  const vanillaDom = new JSDOM(
    '<!doctype html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><main id="main"></main></body></html>',
    { url: 'https://app.example.test/' },
  );
  const vanillaView = vanillaDom.window as unknown as Record<string, unknown> & Window;
  t.after(() => vanillaView.close());
  vanillaView.location.hash = hash;
  vanillaView.fetch = (() => Promise.resolve({ status: 403, ok: false })) as unknown as typeof fetch;
  const { boot } = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    boot: (model: unknown, doc: unknown) => Promise<void> | void;
  };
  await boot(model, vanillaView.document);
  for (let i = 0; i < 8; i++) await new Promise((resolve) => vanillaView.setTimeout(resolve, 0));
  const vanillaMain = vanillaView.document.getElementById('main')!;
  const vanillaDenied = vanillaMain.querySelector('[data-access-status]');
  assert.equal(vanillaDenied?.getAttribute('data-access-status'), '403', 'vanilla denies the hidden gallery screen');
  assert.match(vanillaDenied?.textContent ?? '', /This page is not available\./);

  // React: the same spec, the same denied copy, and not even the probe call.
  const m = await mount(t);
  const spec = reactAppSpec(ir, model);
  m.boot(spec, {});
  await m.go(hash);
  const reactDenied = denied(m.main());
  assert.equal(reactDenied?.getAttribute('data-access-status'), vanillaDenied?.getAttribute('data-access-status'));
  assert.equal(reactDenied?.textContent, vanillaDenied?.textContent);
  assert.deepEqual(m.calls, [], 'React paints the denial without the probe request');
});
