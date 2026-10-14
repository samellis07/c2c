/**
 * Widget-level record contract tests. The real field widgets are bundled
 * with the generated app's own toolchain (Vite + the React plugin from
 * packages/ui-react/template), rendered in jsdom, and readRecord must read
 * back exactly what the record held: a decimal keeps its point and scale, a
 * negative keeps its sign, an empty field posts nothing on add and clears the
 * stored value on edit, and an unchanged load→save round trip posts
 * identical values. Runs in whatever TZ the
 * process has; widgets-tz.test.ts re-runs this file east and west of UTC.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { JSDOM } from 'jsdom';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMPLATE_DIR } from '../src/index.js';
import { readRecord } from '../template/lib/c2c-ui/form/record.js';
import type { FieldSpec, FormSpec } from '../template/lib/c2c-ui/types.js';

interface Bundle {
  css: string;
  react: Record<string, any>;
  client: Record<string, any>;
  dom: Record<string, any>;
  fields: Record<string, any>;
  formview: Record<string, any>;
  env: Record<string, any>;
  extend: Record<string, any>;
}

interface Rendered {
  formEl: HTMLFormElement;
  box: Document;
  win: any;
  flush(): Promise<void>;
}

const VITE_ENTRY = join(TEMPLATE_DIR, 'node_modules/vite/dist/node/index.js');
const REACT_PLUGIN_ENTRY = join(TEMPLATE_DIR, 'node_modules/@vitejs/plugin-react/dist/index.js');
if (!existsSync(VITE_ENTRY) || !existsSync(REACT_PLUGIN_ENTRY)) {
  // Missing template deps must fail loudly, never skip: a skipped widget suite
  // leaves the record contract unverified while `npm test` still exits green.
  test('the React template build dependencies are installed', () => {
    throw new Error('the React template build dependencies are not installed; run `npm ci --prefix packages/ui-react/template`');
  });
}

const dirs: string[] = [];
const mounted: (() => void)[] = [];
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
after(() => {
  // Unmounting stops the widgets' timers and animation frames so the process can exit.
  for (const unmount of mounted.splice(0)) unmount();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[key];
    else Object.defineProperty(globalThis, key, descriptor);
  }
  savedGlobals.clear();
});

let bundled: Promise<Bundle> | undefined;
/** Bundles fields.tsx, react and react-dom once per process with the template's own build deps. */
function bundle(): Promise<Bundle> {
  bundled ??= (async () => {
    if (!existsSync(VITE_ENTRY) || !existsSync(REACT_PLUGIN_ENTRY)) {
      throw new Error('the React template build dependencies are not installed; run `npm ci --prefix packages/ui-react/template`');
    }
    const { build } = (await import(pathToFileURL(VITE_ENTRY).href)) as { build: (config: Record<string, unknown>) => Promise<unknown> };
    const reactPlugin = ((await import(pathToFileURL(REACT_PLUGIN_ENTRY).href)) as { default: () => unknown }).default;
    const out = mkdtempSync(join(tmpdir(), 'c2c-widgets-'));
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
            fields: join(TEMPLATE_DIR, 'lib/c2c-ui/form/fields.tsx'),
            formview: join(TEMPLATE_DIR, 'lib/c2c-ui/form/FormView.tsx'),
            env: join(TEMPLATE_DIR, 'lib/c2c-ui/runtime/env.tsx'),
            extend: join(TEMPLATE_DIR, 'lib/c2c-ui/runtime/extend.tsx'),
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
      // The CJS entries (react, react-dom) surface as a default export.
      return (mod.default ?? mod) as Record<string, any>;
    };
    const [react, client, dom, fields, formview, env, extend] = await Promise.all([load('react'), load('client'), load('dom'), load('fields'), load('formview'), load('env'), load('extend')]);
    const assets = join(out, 'assets');
    const css = existsSync(assets) ? readdirSync(assets).filter((name) => name.endsWith('.css')).map((name) => readFileSync(join(assets, name), 'utf8')).join('\n') : '';
    return { css, react, client, dom, fields, formview, env, extend };
  })();
  return bundled;
}

/** The globals the widgets and their animation layer expect from a browser. */
function installGlobals(win: any): void {
  // Node 21+ defines navigator (and friends) as getter-only accessors on
  // globalThis, so plain assignment throws; defineProperty replaces them.
  const set = (key: string, value: unknown): void => {
    if (!savedGlobals.has(key)) savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  set('window', win);
  set('document', win.document);
  set('navigator', win.navigator);
  for (const key of [
    'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement',
    'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'SVGElement', 'Element', 'Node',
    'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent', 'PointerEvent',
    'AbortController', 'AbortSignal',
    'EventTarget', 'MutationObserver', 'DOMParser', 'XMLSerializer', 'DocumentFragment', 'ShadowRoot',
    'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'FileReader', 'Blob', 'File',
    'DataTransfer', 'ClipboardEvent', 'DragEvent', 'Touch', 'TouchEvent', 'CSS',
  ]) {
    if (win[key] !== undefined) set(key, win[key]);
  }
  const g = globalThis as Record<string, any>;
  g.requestAnimationFrame ??= (fn: () => void) => setTimeout(fn, 0);
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
  g.self ??= win;
  g.NodeFilter ??= win.NodeFilter;
  g.CSS ??= { escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`) };
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
  // jsdom has no layout engine; widgets that observe layout are guarded, but
  // the choice controls' positioning code references it unconditionally.
  g.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  win.Element.prototype.scrollIntoView ??= () => {};
  win.HTMLElement.prototype.setPointerCapture ??= () => {};
  win.HTMLElement.prototype.releasePointerCapture ??= () => {};
  win.HTMLElement.prototype.hasPointerCapture ??= () => false;
}

function field(name: string, widget: FieldSpec['widget'], extra: Partial<FieldSpec> = {}): FieldSpec {
  return { name, label: name, widget, required: false, readonly: false, generated: true, ...extra };
}

function spec(fields: FieldSpec[]): FormSpec {
  return { name: 'F', label: 'F', layout: 'one', fields, submitEndpoint: '/s', recordEndpoint: '/r', buttons: { add: [], edit: [] } };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mounts every field of `form` through <Field> into a jsdom form and waits out the lazy widgets. */
async function render(record: Record<string, unknown>, fields: FieldSpec[], mode: 'add' | 'edit' = 'add'): Promise<Rendered> {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  const win = dom.window as any;
  installGlobals(win);
  // The bundle evaluates after the browser globals exist: imported earlier it
  // caches no-DOM feature flags and the controls stop taking input.
  const kit = await bundle();
  const h = kit.react.createElement;
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = kit.client.createRoot(container);
  mounted.push(() => {
    kit.dom.flushSync(() => root.unmount());
    win.close();
  });
  const { flushSync } = kit.dom;
  const { Field, FormContext } = kit.fields;
  const { EnvContext } = kit.env;
  const { CustomizationContext } = kit.extend;
  const state = { form: spec(fields), errors: {}, record };
  const env = { view: win, doc: win.document, spec: { forms: {} }, api: { post: async () => ({ ok: true, body: {} }), get: async () => ({ ok: true, status: 200, body: { rows: [], field: '', page: 0, pageSize: 300 } }) }, navigator: { onLine: true } };
  flushSync(() =>
    root.render(
      h(
        CustomizationContext.Provider,
        { value: {} },
        h(
          EnvContext.Provider,
          { value: env },
          h(
            FormContext.Provider,
            { value: state },
            h(
              'form',
              { 'data-mode': mode },
              fields.map((item) => h(Field, { key: item.name, name: item.name })),
            ),
          )
        )
      )
    ),
  );
  const formEl = container.querySelector('form') as unknown as HTMLFormElement;
  const flush = async () => {
    for (let i = 0; i < 100 && container.querySelector('[aria-busy="true"]'); i++) {
      flushSync(() => {});
      await delay(5);
    }
    flushSync(() => {});
    assert.equal(container.querySelector('[aria-busy="true"]'), null, 'a lazy widget never mounted');
  };
  await flush();
  return { formEl, box: win.document as unknown as Document, win, flush };
}

/** Types into a control the way a key event would reach it: native setter, then a bubbling input event. */
function type(rendered: Rendered, selector: string, value: string): void {
  const input = rendered.box.querySelector(selector) as any;
  assert.ok(input, `no control at ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(rendered.win.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new rendered.win.Event('input', { bubbles: true }));
  input.dispatchEvent(new rendered.win.FocusEvent('focusout', { bubbles: true }));
}

const NUMBER_FIELDS = [
  field('Qty', 'number'),
  field('Ratio', 'decimal', { decimalPlaces: 2 }),
  field('Pct', 'percent', { decimalPlaces: 2 }),
  field('Naught', 'number'),
];

test('typed decimal, negative number and percent post their exact values', async () => {
  const rendered = await render({ Naught: '5' }, NUMBER_FIELDS);
  type(rendered, '[data-field="Ratio"] input[role="spinbutton"]', '12.34');
  type(rendered, '[data-field="Qty"] input[role="spinbutton"]', '-5');
  type(rendered, '[data-field="Pct"] input[role="spinbutton"]', '7.5');
  type(rendered, '[data-field="Naught"] input[role="spinbutton"]', '0');
  await rendered.flush();
  const record = readRecord(rendered.formEl, spec(NUMBER_FIELDS));
  assert.equal(record.Ratio, '12.34');
  assert.equal(record.Qty, '-5');
  assert.equal(record.Pct, '7.50');
  assert.equal(record.Naught, '0');
});

test('typed currency posts canonical major units', async () => {
  const fields = [field('Amount', 'currency', { currencyCode: 'USD', decimalPlaces: 2 })];
  const rendered = await render({}, fields);
  type(rendered, '[data-field="Amount"] input[role="spinbutton"]', '12.50');
  await rendered.flush();
  assert.equal(readRecord(rendered.formEl, spec(fields)).Amount, '12.50');
});

test('an empty number, decimal or percent field posts nothing — never 0', async () => {
  const fields = [
    field('N1', 'number'),
    field('N2', 'number'),
    field('D1', 'decimal', { decimalPlaces: 2 }),
    field('D2', 'decimal', { decimalPlaces: 2 }),
    field('P1', 'percent', { decimalPlaces: 2 }),
    field('C1', 'currency', { currencyCode: 'USD' }),
    field('C2', 'currency', { currencyCode: 'USD' }),
  ];
  const stored = { N1: null, N2: '', D1: null, D2: '', P1: null, C1: null, C2: '' };
  const rendered = await render(stored, fields);
  assert.deepEqual(readRecord(rendered.formEl, spec(fields)), {});
});

test('a stored zero still posts as zero', async () => {
  const fields = [field('Qty', 'number'), field('Ratio', 'decimal', { decimalPlaces: 2 })];
  const rendered = await render({ Qty: '0', Ratio: '0' }, fields);
  assert.deepEqual(readRecord(rendered.formEl, spec(fields)), { Qty: '0', Ratio: '0.00' });
});

test('signature and richtext controls have accessible names, required state, keyboard support, and focusable surfaces', async () => {
  const fields = [
    field('Sig', 'signature', { required: true }),
    field('Body', 'richtext', { required: true }),
  ];
  const rendered = await render({}, fields);
  const signature = rendered.box.querySelector('[data-field="Sig"] svg[role="application"]') as SVGSVGElement | null;
  assert.ok(signature, 'signature field exposes its actual SVG drawing surface');
  assert.equal(signature?.getAttribute('aria-labelledby'), 'Sig-label');
  assert.equal(signature?.getAttribute('aria-required'), 'true');
  assert.equal(signature?.getAttribute('tabindex'), '0');
  assert.equal(rendered.box.querySelector('[data-field="Sig"] canvas'), null, 'signature has no parallel canvas');
  signature?.dispatchEvent(new rendered.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await rendered.flush();
  assert.ok(rendered.box.querySelector('[data-field="Sig"] svg path[data-color]:not([d=""])'), 'Enter adds a keyboard signature mark');
  const editable = rendered.box.querySelector('[data-field="Body"] [contenteditable="true"]');
  assert.ok(editable, 'richtext field exposes an editable control');
  assert.equal(editable?.getAttribute('aria-labelledby'), 'Body-label');
  assert.equal(editable.getAttribute('aria-required'), 'true', 'a required richtext marks the editable required');
});

test('the signature pad keyboard focus ring is drawn inside the pad clip', async () => {
  const rendered = await render({}, [field('Sig', 'signature')]);
  const kit = await bundle();
  const style = rendered.box.createElement('style');
  style.textContent = kit.css;
  rendered.box.head.appendChild(style);
  const rules = Array.from(style.sheet?.cssRules ?? []).filter(
    (rule): rule is CSSStyleRule => 'selectorText' in rule,
  );
  const ruleFor = (cls: string, pseudo = '') =>
    rules.find((rule) => rule.selectorText.split(',').some((sel) => sel.trim() === `.${cls}${pseudo}`));
  const surface = rendered.box.querySelector('[data-field="Sig"] svg[role="application"]');
  const pad = surface?.parentElement;
  assert.ok(surface && pad, 'the drawing surface sits inside the pad');
  const firstClass = (el: Element) => (el.getAttribute('class') ?? '').split(' ')[0] ?? '';
  // The pad keeps clipping the ink at its rounded edge — drawing behaviour unchanged —
  const padRule = ruleFor(firstClass(pad));
  assert.equal(padRule?.style.getPropertyValue('overflow'), 'hidden', 'the pad still clips the ink');
  // so the focus ring has to be inset: a negative offset keeps it inside the clip.
  const focusRule = ruleFor(firstClass(surface), ':focus-visible');
  assert.ok(focusRule, 'the drawing surface keeps a keyboard focus ring');
  const ring = focusRule.style.getPropertyValue('outline');
  assert.ok(ring && !ring.startsWith('none'), 'the ring is a real outline');
  const offset = focusRule.style.getPropertyValue('--focus-outline-offset') || focusRule.style.getPropertyValue('outline-offset');
  assert.ok(
    /^-\d/.test(offset.trim()),
    `the ring is inset (offset "${offset}") instead of clipped by the pad's overflow: hidden`,
  );
});

test('an unchanged load→save round trip posts identical values for every widget kind', async () => {
  const fields = [
    field('Title', 'text'),
    field('Email', 'email'),
    field('Phone', 'phone'),
    field('Qty', 'number'),
    field('Ratio', 'decimal', { decimalPlaces: 2 }),
    field('Pct', 'percent', { decimalPlaces: 2 }),
    field('Amount', 'currency', { currencyCode: 'INR', decimalPlaces: 2 }),
    field('Yen', 'currency', { currencyCode: 'JPY', decimalPlaces: 0 }),
    field('Due', 'date'),
    field('When', 'datetime'),
    field('At', 'time'),
    field('Agree', 'decision'),
    field('Off', 'decision'),
    field('Status', 'select', { choices: ['Open', 'Closed'] }),
    field('Kind', 'radio', { choices: ['A', 'B'] }),
    field('Tags', 'multiselect', { choices: ['a', 'b', 'c'] }),
    field('Body', 'richtext'),
    field('Sig', 'signature'),
    field('Doc', 'file'),
    field('EmptyText', 'text'),
    field('EmptyTags', 'multiselect', { choices: ['x', 'y'] }),
    field('NullNum', 'number'),
    field('BlankDec', 'decimal', { decimalPlaces: 2 }),
    field('Who', 'name', { subfields: [field('First', 'text'), field('Last', 'text')] }),
    field('Lines', 'subform', { subfields: [field('Item', 'text'), field('Qty', 'number')] }),
  ];
  const stored = {
    Title: 'Hello',
    Email: 'ada@example.com',
    Phone: '+1 555 0100',
    Qty: '-3',
    Ratio: '12.34',
    Pct: '7.50',
    Amount: '12.50',
    Yen: '1234',
    Due: '2026-10-10',
    When: '2026-10-10T14:30',
    At: '14:30',
    Agree: true,
    Off: false,
    Status: 'Closed',
    Kind: 'B',
    Tags: ['c', 'a'],
    Body: '<p>hello <strong>bold</strong></p>',
    EmptyText: '',
    EmptyTags: [],
    NullNum: null,
    BlankDec: '',
    Who: { First: 'Ada', Last: 'Lovelace' },
    Lines: [{ Item: 'Bolt', Qty: '4' }],
  };
  const rendered = await render(stored, fields);
  const record = readRecord(rendered.formEl, spec(fields));
  assert.deepEqual(record, {
    Title: 'Hello',
    Email: 'ada@example.com',
    Phone: '+1 555 0100',
    Qty: '-3',
    Ratio: '12.34',
    Pct: '7.50',
    Amount: '12.50',
    Yen: '1234',
    Due: '2026-10-10',
    When: '2026-10-10T14:30',
    At: '14:30',
    Agree: true,
    Off: false,
    Status: 'Closed',
    Kind: 'B',
    Tags: ['c', 'a'],
    Body: '<p>hello <strong>bold</strong></p>',
    Who: { First: 'Ada', Last: 'Lovelace' },
    Lines: [{ Item: 'Bolt', Qty: '4' }],
  });
});

/** Clicks a control the way a pointer would reach it. */
function click(rendered: Rendered, selector: string): void {
  const el = rendered.box.querySelector(selector) as any;
  assert.ok(el, `no control at ${selector}`);
  el.dispatchEvent(new rendered.win.MouseEvent('click', { bubbles: true }));
}

const CLEARABLE = [
  field('Qty', 'number'),
  field('Ratio', 'decimal', { decimalPlaces: 2 }),
  field('Name', 'text'),
  field('Pct', 'percent', { decimalPlaces: 2 }),
  field('Amount', 'currency', { currencyCode: 'USD', decimalPlaces: 2 }),
  field('Due', 'date'),
  field('Tags', 'multiselect', { choices: ['a', 'b'] }),
  field('Status', 'select', { choices: ['Open', 'Closed'] }),
  field('Owner', 'lookup', { lookup: { form: 'Customer', display: 'Name', endpoint: '/lookups/Customer/Name' } }),
];
const CLEARABLE_STORED = { Qty: '7', Ratio: '12.34', Name: 'x', Pct: '7.50', Amount: '12.50', Due: '2026-10-10', Tags: ['a'], Status: 'Open', Owner: '4000000012345' };

/** Empties every clearable control through its own UI: typed controls by typing nothing, the picker and the multi-select by their Clear buttons. */
async function clearAll(rendered: Rendered): Promise<void> {
  for (const name of ['Qty', 'Ratio', 'Pct', 'Amount']) type(rendered, `[data-field="${name}"] input[role="spinbutton"]`, '');
  type(rendered, 'input[name="Name"]', '');
  click(rendered, '[data-field="Due"] button[aria-haspopup="dialog"]');
  await rendered.flush();
  await delay(20);
  const clearDay = Array.from(rendered.box.querySelectorAll('[data-field="Due"] button')).find((b) => b.textContent === 'Clear') as any;
  assert.ok(clearDay, 'the date picker has a Clear button');
  clearDay.dispatchEvent(new rendered.win.MouseEvent('click', { bubbles: true }));
  click(rendered, '[data-field="Tags"] button[aria-label="Clear selections"]');
  await rendered.flush();
}

test('an edit that clears stored values posts null for typed fields and "" for text', async () => {
  const rendered = await render(CLEARABLE_STORED, CLEARABLE, 'edit');
  await clearAll(rendered);
  const record = readRecord(rendered.formEl, spec(CLEARABLE));
  assert.deepEqual(record, {
    Qty: null,
    Ratio: null,
    Name: '',
    Pct: null,
    Amount: null,
    Due: null,
    Tags: [],
    Status: 'Open',
    // The lookup posts its stored id while untouched; there is no clear without a change.
    Owner: '4000000012345',
  });
});

test('a cleared number widget stays empty after blur instead of snapping back', async () => {
  const fields = [field('Qty', 'number'), field('Ratio', 'decimal', { decimalPlaces: 2 })];
  const rendered = await render({ Qty: '7', Ratio: '12.34' }, fields, 'edit');
  type(rendered, '[data-field="Qty"] input[role="spinbutton"]', '');
  type(rendered, '[data-field="Ratio"] input[role="spinbutton"]', '');
  await rendered.flush();
  const shown = (name: string) => (rendered.box.querySelector(`[data-field="${name}"] input[role="spinbutton"]`) as HTMLInputElement).value;
  assert.equal(shown('Qty'), '');
  assert.equal(shown('Ratio'), '');
  // Typing the old value back after a clear restores it.
  type(rendered, '[data-field="Qty"] input[role="spinbutton"]', '7');
  await rendered.flush();
  assert.deepEqual(readRecord(rendered.formEl, spec(fields)), { Qty: '7', Ratio: null });
});

test('the same empty fields on add are omitted', async () => {
  const rendered = await render({}, CLEARABLE, 'add');
  const record = readRecord(rendered.formEl, spec(CLEARABLE));
  assert.deepEqual(record, {});
  // Typing then clearing on add still leaves nothing to post.
  type(rendered, '[data-field="Qty"] input[role="spinbutton"]', '55');
  type(rendered, '[data-field="Qty"] input[role="spinbutton"]', '');
  type(rendered, 'input[name="Name"]', 'y');
  type(rendered, 'input[name="Name"]', '');
  await rendered.flush();
  assert.deepEqual(readRecord(rendered.formEl, spec(CLEARABLE)), {});
});

test('an unchanged edit posts identical values', async () => {
  const rendered = await render(CLEARABLE_STORED, CLEARABLE, 'edit');
  const record = readRecord(rendered.formEl, spec(CLEARABLE));
  assert.deepEqual(record, { Qty: '7', Ratio: '12.34', Name: 'x', Pct: '7.50', Amount: '12.50', Due: '2026-10-10', Tags: ['a'], Status: 'Open', Owner: '4000000012345' });
});

test('stored whitespace seeds an empty number field; a huge number posts its exact digits', async () => {
  const fields = [field('Blank', 'number'), field('Big', 'number'), field('Typed', 'number'), field('BigDec', 'decimal', { decimalPlaces: 2 })];
  const rendered = await render({ Blank: ' ', Big: '1234567890123456789012', BigDec: '1000000000000000000000.50' }, fields, 'edit');
  assert.equal((rendered.box.querySelector('[data-field="Blank"] input[role="spinbutton"]') as HTMLInputElement).value, '');
  type(rendered, '[data-field="Typed"] input[role="spinbutton"]', '1000000000000000000000');
  await rendered.flush();
  const record = readRecord(rendered.formEl, spec(fields));
  assert.equal(record.Blank, null);
  assert.equal(record.Big, '1234567890123456789012');
  assert.equal(record.Typed, '1000000000000000000000');
  assert.equal(record.BigDec, '1000000000000000000000.50');
});

async function renderFormView(mode: 'add' | 'edit', fields: FieldSpec[], api: any) {
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
  const { flushSync } = kit.dom;
  const { FormView } = kit.formview;
  const { Field } = kit.fields;
  const { EnvContext } = kit.env;
  const { CustomizationContext } = kit.extend;
  const env = { view: win, doc: win.document, spec: { forms: {} }, api, navigator: { onLine: true } };
  
  const form = spec(fields);
  flushSync(() =>
    root.render(
      h(
        CustomizationContext.Provider,
        { value: {} },
        h(
          EnvContext.Provider,
          { value: env },
          h(
            FormView,
            { form, edit: mode === 'edit' ? '123' : undefined },
            fields.map((item) => h(Field, { key: item.name, name: item.name })),
          ),
        ),
      ),
    ),
  );
  const formEl = container.querySelector('form') as unknown as HTMLFormElement;
  const flush = async () => {
    for (let i = 0; i < 100 && container.querySelector('[aria-busy="true"]'); i++) {
      flushSync(() => {});
      await delay(5);
    }
    flushSync(() => {});
  };
  await flush();
  return { formEl, box: win.document as unknown as Document, win, flush };
}

test('edit mode submit before load posts NOTHING; failed fetch posts nothing; after load clear behaviour works', async () => {
  let resolveLoad: any;
  let loadPromise = new Promise((resolve) => { resolveLoad = resolve; });
  let posted: any = null;
  
  const api = {
    post: async (url: string, body: any) => {
      if (url === '/r') return loadPromise;
      if (url === '/s') { posted = body; return { ok: true, body: {} }; }
      return { ok: true, body: {} };
    }
  };

  const fields = [field('Qty', 'number'), field('Name', 'text')];
  const rendered = await renderFormView('edit', fields, api);

  // Submit before load
  click(rendered, 'button[type="submit"]');
  await rendered.flush();
  assert.equal(posted, null);

  // Fail fetch: the error card replaces the form, so there is nothing to submit
  resolveLoad({ ok: false });
  while (!rendered.box.querySelector('[data-state="error"]')) {
    await delay(5);
  }
  await rendered.flush();
  assert.equal(rendered.box.querySelector('form'), null, 'a failed edit read does not leave an empty form open');
  assert.match(rendered.box.querySelector('[data-state="error"]')?.textContent || '', /could not be loaded/);
});

test('edit mode successful load re-enables submit and clear behaviour works', async () => {
  let posted: any = null;
  const api = {
    post: async (url: string, body: any) => {
      if (url === '/r') return Promise.resolve({ ok: true, body: { record: { Qty: '7', Name: 'x' } } });
      if (url === '/s') { posted = body; return { ok: true, body: {} }; }
      return { ok: true, body: {} };
    }
  };

  const fields = [field('Qty', 'number'), field('Name', 'text')];
  const rendered = await renderFormView('edit', fields, api);
  
  // Wait for load
  while (true) {
    const input = rendered.box.querySelector('[data-field="Qty"] input[role="spinbutton"]') as HTMLInputElement;
    if (input && input.value === '7') break;
    await delay(5);
  }
  await rendered.flush();
  
  // Clear behavior
  type(rendered, '[data-field="Qty"] input[role="spinbutton"]', '');
  await rendered.flush(); // Wait for React to render the clear
  
  click(rendered, 'button[type="submit"]');
  
  // Wait for post
  while (!posted) {
    await delay(5);
  }
  await rendered.flush();
  
  assert.ok(posted);
  assert.equal(posted.record.Qty, null);
  assert.equal(posted.record.Name, 'x'); // unchanged field keeps its value
});

test('an edit that empties a composite part or subform cell posts them as empty string/null', async () => {
  const fields = [
    field('Who', 'name', { subfields: [field('First', 'text'), field('Last', 'text')] }),
    field('Lines', 'subform', { subfields: [field('Item', 'text'), field('Qty', 'number')] }),
  ];
  const stored = {
    Who: { First: 'Ada', Last: 'Lovelace' },
    Lines: [{ Item: 'Bolt', Qty: '4' }, { Item: 'Nut', Qty: '5' }],
  };
  const rendered = await render(stored, fields, 'edit');
  
  // Empty one composite part
  type(rendered, 'input[name="Who.Last"]', '');
  // Empty one cell in the first subform row
  type(rendered, 'input[name="Lines[0].Qty"]', '');
  // Empty all cells in the second subform row
  type(rendered, 'input[name="Lines[1].Item"]', '');
  type(rendered, 'input[name="Lines[1].Qty"]', '');
  await rendered.flush();

  const record = readRecord(rendered.formEl, spec(fields));
  assert.deepEqual(record, {
    Who: { First: 'Ada', Last: '' },
    // The second row has every field empty, so it is not posted.
    Lines: [{ Item: 'Bolt', Qty: null }],
  });
});

test('an edit that removes a file or signature posts null for that field', async () => {
  const fields = [field('Doc', 'file'), field('Sig', 'signature')];
  const stored = { Doc: 'https://example.com/doc.pdf', Sig: 'https://example.com/sig.png' };
  const rendered = await render(stored, fields, 'edit');
  
  // Click remove file button
  click(rendered, '[data-field="Doc"] button');
  // Click remove signature button
  click(rendered, '[data-field="Sig"] button');
  await rendered.flush();

  const record = readRecord(rendered.formEl, spec(fields));
  assert.deepEqual(record, { Doc: null, Sig: null });
});

test('an edit whose record has no subform rows posts the drawn grid as an empty list', async () => {
  const fields = [
    field('Title', 'text'),
    field('Lines', 'subform', { subfields: [field('Item', 'text'), field('Qty', 'number')] }),
  ];
  // The edit prefill when the record read did not attach child rows: the grid
  // draws one blank row, is empty, and posts [] — the server replaces the
  // stored children with the grid's list.
  const rendered = await render({ Title: 'T1' }, fields, 'edit');
  assert.deepEqual(readRecord(rendered.formEl, spec(fields)), { Title: 'T1', Lines: [] });
});

test('an edit with loaded subform rows posts those rows, a removed row, and an added row', async () => {
  const fields = [
    field('Title', 'text'),
    field('Lines', 'subform', { subfields: [field('Item', 'text'), field('Qty', 'number')] }),
  ];
  const stored = {
    Title: 'T1',
    Lines: [{ Item: 'Bolt', Qty: '4' }, { Item: 'Nut', Qty: '5' }],
  };
  const untouched = await render(stored, fields, 'edit');
  assert.deepEqual(readRecord(untouched.formEl, spec(fields)), stored);

  const removed = await render(stored, fields, 'edit');
  click(removed, '[aria-label="Remove row 2"]');
  await removed.flush();
  assert.deepEqual(readRecord(removed.formEl, spec(fields)), {
    Title: 'T1',
    Lines: [{ Item: 'Bolt', Qty: '4' }],
  });

  const added = await render(stored, fields, 'edit');
  const add = Array.from(added.box.querySelectorAll('button')).find((button) => (button.textContent || '').includes('Add Lines row'));
  assert.ok(add, 'add-row control');
  add.dispatchEvent(new added.win.MouseEvent('click', { bubbles: true }));
  await added.flush();
  type(added, 'input[name="Lines[2].Item"]', 'Washer');
  type(added, 'input[name="Lines[2].Qty"]', '1');
  await added.flush();
  assert.deepEqual(readRecord(added.formEl, spec(fields)), {
    Title: 'T1',
    Lines: [{ Item: 'Bolt', Qty: '4' }, { Item: 'Nut', Qty: '5' }, { Item: 'Washer', Qty: '1' }],
  });
});

test('a subform link name that contains punctuation still posts its rows on edit', async () => {
  const name = 'A.B(C)[D]';
  const fields = [field(name, 'subform', { subfields: [field('Item', 'text'), field('Qty', 'number')] })];
  const stored = { [name]: [{ Item: 'Bolt', Qty: '4' }] };
  const rendered = await render(stored, fields, 'edit');
  assert.deepEqual(readRecord(rendered.formEl, spec(fields)), stored);
});

/** Polls a condition with a deadline so a missing UI update fails instead of hanging the suite. */
async function waitFor(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 5) {
    if (cond()) return;
    await delay(5);
  }
  assert.ok(cond(), `timed out waiting for ${what}`);
}

function stubOpenedWindow(rendered: Rendered): { opened: () => string | undefined } {
  let openedUrl: string | undefined;
  rendered.win.open = (url: string) => {
    openedUrl = url || undefined;
    return {
      document: { write: () => {} },
      location: {
        set href(val: string) { openedUrl = val; },
      },
      close() {},
    } as any;
  };
  return { opened: () => openedUrl };
}

test('a stored file or signature view link fetches the file through a POST with the rowId, then opens it', async () => {
  const fields = [field('Doc', 'file'), field('Sig', 'signature')];

  const posted: { url: string; body: any }[] = [];

  const api = {
    post: async (url: string, body: any) => {
      posted.push({ url, body });
      if (url.startsWith('/files/')) {
        return { ok: true, status: 200, body: { url: 'https://example.com/signed' } };
      }
      return { ok: true, status: 200, body: { record: { Doc: 'x', Sig: 'y' } } };
    },
  };

  const rendered = await renderFormView('edit', fields, api);
  const win = stubOpenedWindow(rendered);

  // The stored signature image fetches the same signed URL as the view link.
  // The img lands only after the POST resolves and React re-renders, which can
  // take longer than a single flush, so wait for the element itself.
  await waitFor(() => rendered.box.querySelector('[data-field="Sig"] img[src="https://example.com/signed"]') !== null, 'the signature image');
  const sigImg = rendered.box.querySelector('[data-field="Sig"] img') as HTMLImageElement | null;
  assert.ok(sigImg, 'stored signature renders as an image');
  assert.equal(sigImg.getAttribute('src'), 'https://example.com/signed');
  const sigPost = posted.find((p) => p.url === '/files/F/Sig');
  assert.deepEqual(sigPost?.body, { rowId: '123' });

  const docLink = rendered.box.querySelector('[data-field="Doc"] a');
  const sigLink = rendered.box.querySelector('[data-field="Sig"] a');
  assert.ok(docLink, 'doc view link');
  assert.equal(docLink.textContent, 'View Doc');
  assert.ok(sigLink, 'signature view link');
  assert.equal(sigLink.textContent, 'View Sig');

  // Clicking the doc link posts { rowId } and opens the signed URL. The window
  // open runs once the POST resolves, so wait for that rather than the call.
  docLink.dispatchEvent(new rendered.win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => win.opened() === 'https://example.com/signed', 'the doc file opening');
  const docPost = posted.find((p) => p.url === '/files/F/Doc');
  assert.deepEqual(docPost?.body, { rowId: '123' });
  assert.equal(win.opened(), 'https://example.com/signed');

  // Clicking the signature link posts { rowId } for the signature field too.
  sigLink.dispatchEvent(new rendered.win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => posted.filter((p) => p.url === '/files/F/Sig').length >= 2, 'the second signature POST');
  await waitFor(() => win.opened() === 'https://example.com/signed', 'the signature file opening');
  assert.equal(win.opened(), 'https://example.com/signed');
});

test('a failed file fetch leaves a visible message instead of closing quietly', async () => {
  const fields = [field('Doc', 'file')];
  const replies: Record<number, any> = {
    0: { ok: false, status: 403, body: { error: 'access denied' } },
    1: { ok: false, status: 404, body: { error: 'no such file' } },
    2: { ok: true, status: 200, body: { url: null } },
  };
  let calls = 0;
  const api = {
    post: async (url: string, _body: any) => {
      if (url === '/r') return { ok: true, status: 200, body: { record: { Doc: 'x' } } };
      return replies[calls++] ?? { ok: true, status: 200, body: { url: null } };
    },
  };
  const rendered = await renderFormView('edit', fields, api);
  stubOpenedWindow(rendered);

  await waitFor(() => rendered.box.querySelector('[data-field="Doc"] a') !== null, 'the doc view link');
  const expectMessage = async (pattern: RegExp, clicks: number) => {
    const link = rendered.box.querySelector('[data-field="Doc"] a') as HTMLElement;
    for (let i = 0; i < clicks; i++) link.dispatchEvent(new rendered.win.MouseEvent('click', { bubbles: true }));
    await waitFor(() => pattern.test(rendered.box.querySelector('[data-field="Doc"] [role="alert"]')?.textContent ?? ''), `message ${pattern}`);
    await rendered.flush();
  };

  await expectMessage(/do not have access/, 1);
  await expectMessage(/no such file/, 1);
  await expectMessage(/no doc download is available/i, 1);
});

test('a stored file with no record id shows no view action', async () => {
  const fields = [field('Doc', 'file'), field('Sig', 'signature')];
  const rendered = await render({ Doc: 'x', Sig: 'y' }, fields, 'edit');
  await rendered.flush();

  assert.equal(rendered.box.querySelector('[data-field="Doc"] a'), null);
  assert.equal(rendered.box.querySelector('[data-field="Sig"] a'), null);
  assert.equal(rendered.box.querySelector('[data-field="Sig"] img'), null);
});
