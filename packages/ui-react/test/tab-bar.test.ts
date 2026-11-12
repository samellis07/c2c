/**
 * The phone tab bar follows the WAI-ARIA tabs pattern for navigation: a
 * tablist of tab links where only the current route's tab is selected and
 * tabbable (roving tabindex), arrows wrap, and Home/End jump to the ends.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { JSDOM } from 'jsdom';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMPLATE_DIR } from '../src/index.js';
import type { NavSection } from '../template/lib/c2c-ui/types.js';

interface Bundle {
  react: Record<string, any>;
  client: Record<string, any>;
  dom: Record<string, any>;
  shell: Record<string, any>;
  env: Record<string, any>;
}

const VITE_ENTRY = join(TEMPLATE_DIR, 'node_modules/vite/dist/node/index.js');
const REACT_PLUGIN_ENTRY = join(TEMPLATE_DIR, 'node_modules/@vitejs/plugin-react/dist/index.js');
if (!existsSync(VITE_ENTRY) || !existsSync(REACT_PLUGIN_ENTRY)) {
  test('the React template build dependencies are installed', () => {
    throw new Error('the React template build dependencies are not installed; run `npm ci --prefix packages/ui-react/template`');
  });
}

const dirs: string[] = [];
const mounted: (() => void)[] = [];
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
after(() => {
  for (const unmount of mounted.splice(0)) unmount();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[key];
    else Object.defineProperty(globalThis, key, descriptor);
  }
  savedGlobals.clear();
});

let bundled: Promise<Bundle> | undefined;
function bundle(): Promise<Bundle> {
  bundled ??= (async () => {
    const { build } = (await import(pathToFileURL(VITE_ENTRY).href)) as { build: (config: Record<string, unknown>) => Promise<unknown> };
    const reactPlugin = ((await import(pathToFileURL(REACT_PLUGIN_ENTRY).href)) as { default: () => unknown }).default;
    const out = mkdtempSync(join(tmpdir(), 'c2c-tabbar-'));
    dirs.push(out);
    await build({
      configFile: false,
      root: TEMPLATE_DIR,
      logLevel: 'error',
      plugins: [reactPlugin()],
      build: {
        target: 'es2022',
        outDir: out,
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
        modulePreload: false,
        cssCodeSplit: false,
        rollupOptions: {
          preserveEntrySignatures: 'exports-only',
          input: {
            react: 'react',
            dom: 'react-dom',
            client: 'react-dom/client',
            shell: join(TEMPLATE_DIR, 'lib/c2c-ui/shell/AppShell.tsx'),
            env: join(TEMPLATE_DIR, 'lib/c2c-ui/runtime/env.tsx'),
          },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
            assetFileNames: 'assets/[name][extname]',
          },
        },
      },
    });
    const load = async (name: string) => {
      const mod = (await import(pathToFileURL(join(out, `${name}.js`)).href)) as Record<string, any>;
      return (mod.default ?? mod) as Record<string, any>;
    };
    const [react, client, dom, shell, env] = await Promise.all([load('react'), load('client'), load('dom'), load('shell'), load('env')]);
    return { react, client, dom, shell, env };
  })();
  return bundled;
}

function installGlobals(win: any): void {
  const set = (key: string, value: unknown): void => {
    if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  set('window', win);
  set('document', win.document);
  set('navigator', win.navigator);
  for (const key of [
    'HTMLElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'SVGElement', 'Element', 'Node',
    'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'EventTarget',
    'MutationObserver', 'DocumentFragment', 'requestAnimationFrame', 'cancelAnimationFrame',
    'getComputedStyle', 'CSS',
  ]) {
    if (win[key] !== undefined) set(key, win[key]);
  }
  const g = globalThis as Record<string, any>;
  g.requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
  g.self ??= win;
  win.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
}

const item = (kind: 'form' | 'report', name: string) => ({ kind, name, label: name.replace(/_/g, ' '), href: `#/${kind}/${name}` });

/** Six entries: the first four become tabs, the rest sit behind More. */
const SECTIONS: NavSection[] = [
  { label: 'Sales', items: [item('form', 'Order'), item('form', 'Quote'), item('report', 'All_Orders'), item('report', 'All_Quotes')] },
  { label: 'Stock', items: [item('form', 'Part'), item('report', 'All_Parts')] },
];

async function render(current: string): Promise<{ doc: Document; win: any; container: HTMLElement }> {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  const win = dom.window as any;
  installGlobals(win);
  const kit = await bundle();
  const h = kit.react.createElement;
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = kit.client.createRoot(container);
  mounted.push(() => {
    kit.dom.flushSync(() => root.unmount());
    win.close();
  });
  const env = {
    view: win,
    doc: win.document,
    spec: { forms: {} },
    api: {
      post: async () => ({ ok: true, body: {} }),
      get: async () => ({ ok: true, status: 200, body: { rows: [], field: '', page: 0, pageSize: 300 } }),
    },
  };
  kit.dom.flushSync(() =>
    root.render(
      h(kit.env.EnvContext.Provider, { value: env }, h(kit.shell.AppShell, { title: 'Demo', sections: SECTIONS, current }, h('div', null, 'screen'))),
    ),
  );
  return { doc: win.document as unknown as Document, win, container };
}

test('the tab bar is a tablist of tabs with one selected, tabbable tab', async () => {
  const { doc } = await render('form/Quote');
  const tabbar = doc.getElementById('tabbar');
  assert.equal(tabbar?.getAttribute('role'), 'tablist');
  const tabs = Array.from(tabbar!.querySelectorAll('[role="tab"]'));
  assert.equal(tabs.length, 5, 'four tabs plus the More tab');
  const selected = tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true');
  assert.equal(selected.length, 1, 'exactly one selected tab');
  assert.equal(selected[0].getAttribute('href'), '#/form/Quote');
  for (const tab of tabs) {
    const on = tab === selected[0];
    assert.equal(tab.getAttribute('aria-selected'), String(on));
    assert.equal(tab.getAttribute('tabindex'), on ? '0' : '-1');
  }
});

test('a route behind More selects the More tab', async () => {
  const { doc } = await render('form/Part');
  const more = doc.querySelector('#tabbar [data-more]');
  assert.equal(more?.getAttribute('aria-selected'), 'true');
  assert.equal(more?.getAttribute('tabindex'), '0');
  for (const tab of doc.querySelectorAll('#tabbar a[role="tab"]')) {
    assert.equal(tab.getAttribute('aria-selected'), 'false');
    assert.equal(tab.getAttribute('tabindex'), '-1');
  }
});

test('arrows wrap and Home/End jump between the tabs', async () => {
  const { doc, win } = await render('form/Order');
  const tabs = Array.from(doc.querySelectorAll('#tabbar [role="tab"]')) as HTMLElement[];
  assert.equal(tabs.length, 5);
  const press = (key: string) =>
    (doc.activeElement as Element).dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const last = tabs[tabs.length - 1];
  tabs[0].focus();
  press('ArrowLeft');
  assert.equal(doc.activeElement, last, 'ArrowLeft wraps to the last tab');
  press('ArrowRight');
  assert.equal(doc.activeElement, tabs[0], 'ArrowRight wraps back to the first tab');
  press('ArrowRight');
  assert.equal(doc.activeElement, tabs[1]);
  press('End');
  assert.equal(doc.activeElement, last, 'End jumps to the last tab');
  press('Home');
  assert.equal(doc.activeElement, tabs[0], 'Home jumps to the first tab');
});

test('the More tab still opens the sheet', async () => {
  const { doc, win } = await render('form/Order');
  const more = doc.querySelector('#tabbar [data-more]') as HTMLElement;
  assert.ok(more);
  more.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  const sheet = doc.getElementById('more-sheet') as unknown as { hidden: boolean };
  assert.equal(sheet.hidden, false, 'the More sheet did not open');
  assert.ok(sheet && (doc.querySelector('#more-sheet a[href="#/form/Part"]') as Element), 'the sheet lacks the leftover entries');
});
