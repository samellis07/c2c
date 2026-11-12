/**
 * The control contract every field box keeps: whatever the enhanced widget
 * looks like, the box shows a rendered label and a real form control — the
 * same element the user edits is the one that carries the value and the
 * mandatory marker. A styled widget that hides its record control (a clipped
 * carrier select, a radio group with no inputs, a hidden file input no label
 * reaches) fails this contract in a plain-DOM host even when it looks right
 * in a browser.
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { JSDOM } from 'jsdom';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMPLATE_DIR } from '../src/index.js';
import type { FieldSpec, FormSpec } from '../template/lib/c2c-ui/types.js';
import { readRecord } from '../template/lib/c2c-ui/form/record.js';
import { validateRows } from '../template/lib/c2c-ui/subform/rows.js';
import { multiValueCell } from '../../shims/src/multi-value.js';

interface Bundle {
  react: Record<string, any>;
  client: Record<string, any>;
  dom: Record<string, any>;
  fields: Record<string, any>;
  env: Record<string, any>;
  extend: Record<string, any>;
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
    const out = mkdtempSync(join(tmpdir(), 'c2c-controls-'));
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
      return (mod.default ?? mod) as Record<string, any>;
    };
    const [react, client, dom, fields, env, extend] = await Promise.all([load('react'), load('client'), load('dom'), load('fields'), load('env'), load('extend')]);
    return { react, client, dom, fields, env, extend };
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

/** Mounts every field through <Field> into a jsdom form and waits out the lazy widgets. */
async function render(fields: FieldSpec[], record: Record<string, unknown> = {}): Promise<{ doc: Document; win: any }> {
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
            h('form', { 'data-mode': 'add' }, fields.map((item) => h(Field, { key: item.name, name: item.name }))),
          )
        )
      )
    ),
  );
  for (let i = 0; i < 100 && container.querySelector('[aria-busy="true"]'); i++) {
    flushSync(() => {});
    await delay(5);
  }
  flushSync(() => {});
  assert.equal(container.querySelector('[aria-busy="true"]'), null, 'a lazy widget never mounted');
  return { doc: win.document as unknown as Document, win };
}

const CONTROL = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"]';

function box(doc: Document, name: string): Element {
  const el = doc.querySelector(`[data-field="${name}"]`);
  assert.ok(el, `no field box for ${name}`);
  return el;
}

function renderedLabel(el: Element, label: string): void {
  const found = Array.from(el.querySelectorAll('label, legend, .field-title')).some((node) => (node.textContent ?? '').includes(label));
  assert.ok(found, `${label}: no rendered label, legend or .field-title`);
}

function requiredMarked(el: Element, label: string): void {
  const marked = Array.from(el.querySelectorAll(CONTROL)).some((c) => c.hasAttribute('required') || c.getAttribute('aria-required') === 'true');
  assert.ok(marked, `${label}: mandatory field has no required control`);
}

test('a choice field is a real named select', async () => {
  const fields = [field('Status', 'select', { choices: ['Open', 'Closed'], required: true })];
  const { doc } = await render(fields);
  const el = box(doc, 'Status');
  const select = el.querySelector('select[name="Status"]');
  assert.ok(select, 'a select field posts its value through a named select');
  renderedLabel(el, 'Status');
  requiredMarked(el, 'Status');
});

test('an address location pin captures and stores device coordinates', async () => {
  const fields = [field('Location', 'address', { captureCoordinates: true, subfields: [
    field('latitude', 'decimal'), field('longitude', 'decimal'),
  ] })];
  const { doc, win } = await render(fields);
  win.navigator.geolocation = { getCurrentPosition(callback: (position: { coords: { latitude: number; longitude: number } }) => void) {
    callback({ coords: { latitude: 12.34, longitude: 56.78 } });
  } };
  const button = box(doc, 'Location').querySelector('button[aria-label="Capture coordinates for Location"]') as HTMLButtonElement | null;
  assert.ok(button, 'address exposes a location capture button');
  button!.click();
  assert.equal((doc.querySelector('input[name="Location.latitude"]') as HTMLInputElement)?.value, '12.34');
  assert.equal((doc.querySelector('input[name="Location.longitude"]') as HTMLInputElement)?.value, '56.78');
});

test('an address with adjust_using_map renders a map pin that adjusts and tracks coordinates; without the flag there is none', async () => {
  const parts = () => [field('latitude', 'decimal'), field('longitude', 'decimal')];
  const mapped = await render(
    [field('Location', 'address', { adjustUsingMap: true, captureCoordinates: true, subfields: parts() })],
    { Location: { latitude: '12.5', longitude: '56.5' } },
  );
  const map = box(mapped.doc, 'Location').querySelector('svg.c2c-map') as SVGSVGElement | null;
  assert.ok(map, 'flagged address renders a map');
  const pin = map!.querySelector('.c2c-map-pin');
  assert.ok(pin, 'flagged address with coordinates renders a map pin');
  assert.equal(pin!.getAttribute('data-latitude'), '12.5');
  assert.equal(pin!.getAttribute('data-longitude'), '56.5');

  map!.dispatchEvent(new mapped.win.MouseEvent('click', { clientX: 270, clientY: 45, bubbles: true }));
  assert.equal((mapped.doc.querySelector('input[name="Location.latitude"]') as HTMLInputElement)?.value, '45');
  assert.equal((mapped.doc.querySelector('input[name="Location.longitude"]') as HTMLInputElement)?.value, '90');
  assert.equal(map!.querySelector('.c2c-map-pin')?.getAttribute('data-latitude'), '45');
  assert.equal(map!.querySelector('.c2c-map-pin')?.getAttribute('data-longitude'), '90');

  mapped.win.navigator.geolocation = {
    getCurrentPosition(callback: (position: { coords: { latitude: number; longitude: number } }) => void) {
      callback({ coords: { latitude: -23.5, longitude: -46.6 } });
    },
  };
  const captureBtn = box(mapped.doc, 'Location').querySelector('button[aria-label="Capture coordinates for Location"]') as HTMLButtonElement | null;
  captureBtn!.click();
  assert.equal(map!.querySelector('.c2c-map-pin')?.getAttribute('data-latitude'), '-23.5');
  assert.equal(map!.querySelector('.c2c-map-pin')?.getAttribute('data-longitude'), '-46.6');

  const plain = await render([field('Location', 'address', { subfields: parts() })], { Location: { latitude: '12.5', longitude: '56.5' } });
  assert.equal(box(plain.doc, 'Location').querySelector('.c2c-map'), null);
});

test('a multi choice field is a real named multi-select', async () => {
  const fields = [field('Tags', 'multiselect', { choices: ['a', 'b'], required: true })];
  const { doc } = await render(fields, { Tags: ['a'] });
  const el = box(doc, 'Tags');
  const select = el.querySelector('select[multiple][name="Tags"]');
  assert.ok(select, 'a multiselect posts its values through a named multi-select');
  renderedLabel(el, 'Tags');
  requiredMarked(el, 'Tags');
});

test('editing a stored multi choice record and saving untouched keeps every choice', async () => {
  // A multi choice cell is stored as list text (["No"]); older rows hold [No] or {"No"}.
  const fields = [field('Featured', 'multiselect', { choices: ['Yes', 'No'] }), field('Tags', 'multiselect', { choices: ['a', 'b', 'c'] })];
  for (const [featured, tags] of [['["No"]', '["a","c"]'], ['[No]', '[a, c]'], ['{"No"}', '{"a","c"}']]) {
    const { doc } = await render(fields, { Featured: featured, Tags: tags });
    const selected = (name: string) => [...doc.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!.selectedOptions].map((option) => option.value);
    assert.deepEqual(selected('Featured'), ['No'], `${featured} preselects its choice`);
    assert.deepEqual(selected('Tags'), ['a', 'c'], `${tags} preselects its choices`);
    const formEl = doc.querySelector('form') as HTMLFormElement;
    formEl.setAttribute('data-mode', 'edit');
    const record = readRecord(formEl, spec(fields));
    assert.equal(multiValueCell(record.Featured), '["No"]', `${featured} saves back canonical, never []`);
    assert.equal(multiValueCell(record.Tags), '["a","c"]');
  }
});

test('radio options are real radio inputs', async () => {
  const fields = [field('Kind', 'radio', { choices: ['A', 'B'], required: true })];
  const { doc } = await render(fields);
  const el = box(doc, 'Kind');
  const radios = el.querySelectorAll('input[type="radio"][name="Kind"]');
  assert.equal(radios.length, 2, 'each option is a radio input that posts');
  renderedLabel(el, 'Kind');
  requiredMarked(el, 'Kind');
});

test('a decision field is a real checkbox', async () => {
  const fields = [field('Agree', 'decision', { required: true })];
  const { doc } = await render(fields);
  const el = box(doc, 'Agree');
  assert.ok(el.querySelector('input[type="checkbox"]'), 'the decision control is a checkbox');
  renderedLabel(el, 'Agree');
  requiredMarked(el, 'Agree');
});

test('date and time fields carry a named, readable value control', async () => {
  const fields = [field('Due', 'date', { required: true }), field('At', 'time', { required: true })];
  const { doc } = await render(fields);
  for (const name of ['Due', 'At']) {
    const el = box(doc, name);
    const mirror = el.querySelector(`input[name="${name}"]:not([type="hidden"])`);
    assert.ok(mirror, `${name}: the posted value sits on a readable control, not only a hidden input`);
    renderedLabel(el, name);
    requiredMarked(el, name);
  }
});

test('a file field’s input is reachable through a rendered label', async () => {
  const fields = [field('Photo', 'file')];
  const { doc } = await render(fields);
  const el = box(doc, 'Photo');
  const label = el.querySelector('label[for]');
  assert.ok(label, 'a rendered label activates the file input');
  const input = doc.getElementById(label!.getAttribute('for')!);
  assert.ok(input && el.contains(input) && input.getAttribute('type') === 'file', 'the label points at the file input');
  renderedLabel(el, 'Photo');
});

test('an image field with imageLink and imageTitle renders link and title inputs and wraps the shown image in a link', async () => {
  const fields = [field('Logo', 'image', { imageLink: true, imageTitle: true, linkTarget: '_self' })];
  const { doc: addDoc } = await render(fields);
  const addBox = box(addDoc, 'Logo');
  assert.ok(addBox.querySelector('input[type="url"][name="Logo__link"]'), 'collects a link URL alongside the upload');
  assert.ok(addBox.querySelector('input[type="text"][name="Logo__title"]'), 'collects a title alongside the upload');

  const { doc: storedDoc } = await render(fields, {
    Logo: { url: 'https://example.com/logo.png', link: 'https://example.com/company', title: 'Company site' },
  });
  const storedBox = box(storedDoc, 'Logo');
  const anchor = storedBox.querySelector('a[href="https://example.com/company"]') as HTMLAnchorElement | null;
  assert.ok(anchor, 'shown image is wrapped in a clickable link');
  assert.equal(anchor!.getAttribute('target'), '_self');
  assert.equal(anchor!.getAttribute('title'), 'Company site');
  const img = anchor!.querySelector('img');
  assert.ok(img, 'the link wraps the displayed image');
  assert.equal(img!.getAttribute('src'), 'https://example.com/logo.png');
  assert.equal(img!.getAttribute('title'), 'Company site');
});

test('a stored image link with an unsafe scheme or markup is never rendered as an anchor', async () => {
  const fields = [field('Logo', 'image', { imageLink: true, imageTitle: true, linkTarget: '_self' })];
  for (const link of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' java\tscript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '//evil.example/x', 'https://x.example/"onmouseover="1', 'https://x.example/<b>', 'ftp://x.example/']) {
    const { doc } = await render(fields, { Logo: { url: 'https://example.com/logo.png', link, title: 'T' } });
    const stored = box(doc, 'Logo');
    assert.equal(stored.querySelector('a[target="_self"]'), null, `no anchor for ${JSON.stringify(link)}`);
    assert.ok(stored.querySelector('img'), 'the image itself still shows');
  }
  for (const link of ['https://example.com/a?b=1', 'http://example.com/', 'mailto:a@example.com', '/local/page', '#/form/Other', 'HTTPS://EXAMPLE.COM/Path', 'Http://example.com/x', 'MAILTO:a@example.com']) {
    const { doc } = await render(fields, { Logo: { url: 'https://example.com/logo.png', link, title: 'T' } });
    assert.ok(box(doc, 'Logo').querySelector(`a[href="${link}"]`), `anchor for ${link}`);
  }
});

test('a markup-bearing image title and an unsafe link render inert', async () => {
  const fields = [field('Logo', 'image', { imageLink: true, imageTitle: true, linkTarget: '_self' })];
  const title = '<img src=x onerror=alert(1)>"\'';
  const { doc } = await render(fields, { Logo: { url: 'https://example.com/logo.png', link: 'javascript:alert(document.cookie)', title } });
  const stored = box(doc, 'Logo');
  assert.equal(stored.querySelector('a[target="_self"]'), null, 'a javascript: link is never an anchor');
  assert.equal(stored.querySelectorAll('img').length, 1, 'the title text created no extra element');
  assert.equal(stored.querySelector('img')!.getAttribute('title'), title, 'the title is only an attribute value');
  assert.equal(stored.querySelector('img[src="x"]'), null);
});

test('a multi lookup’s chosen records are a shown named multi-select', async () => {
  const fields = [field('Watchers', 'lookup-multi', { required: true, lookup: { form: 'User', display: 'Email', endpoint: '/lookups/User/Email' } })];
  const { doc } = await render(fields, { Watchers: ['1001'] });
  const el = box(doc, 'Watchers');
  const select = el.querySelector('select[multiple][name="Watchers"]');
  assert.ok(select, 'the chosen records sit on a named multi-select');
  assert.equal(select!.hasAttribute('hidden'), false, 'the chosen-records select is shown');
  renderedLabel(el, 'Watchers');
  requiredMarked(el, 'Watchers');
});

test('number, decimal, percent and currency fields mark their mandatory control', async () => {
  const fields = [
    field('Qty', 'number', { required: true }),
    field('Ratio', 'decimal', { required: true, decimalPlaces: 2 }),
    field('Pct', 'percent', { required: true, decimalPlaces: 2 }),
    field('Amount', 'currency', { required: true, currencyCode: 'USD' }),
  ];
  const { doc } = await render(fields);
  for (const name of ['Qty', 'Ratio', 'Pct', 'Amount']) {
    const el = box(doc, name);
    renderedLabel(el, name);
    requiredMarked(el, name);
  }
});

test('a required subform offers an editable control to start with', async () => {
  const fields = [
    field('Lines', 'subform', {
      required: true,
      subfields: [field('Note', 'text', { required: true })],
    }),
  ];
  const { doc } = await render(fields);
  const el = box(doc, 'Lines');
  assert.ok(el.querySelector(CONTROL), 'the grid opens with an editable row');
  requiredMarked(el, 'Lines');
});

test('a subform with no defaultRowCount opens a new record with exactly one row', async () => {
  const fields = [field('Lines', 'subform', { subfields: [field('Note', 'text')] })];
  const { doc } = await render(fields);
  const el = box(doc, 'Lines');
  assert.equal(el.querySelectorAll('tbody tr[data-row-key]').length, 1);
});

test('a subform with defaultRowCount pre-fills that many empty rows on a new record', async () => {
  const fields = [field('Lines', 'subform', { defaultRowCount: 3, subfields: [field('Note', 'text')] })];
  const { doc } = await render(fields);
  const el = box(doc, 'Lines');
  assert.equal(el.querySelectorAll('tbody tr[data-row-key]').length, 3);
});

test('a subform with autoWidth false lays columns at their declared widths; otherwise it auto-sizes', async () => {
  const columns = [
    field('Days', 'select', { width: '206px', choices: ['Sunday'] }),
    field('Workout', 'text', { width: '200px' }),
    field('Weight', 'decimal', { width: '115px' }),
  ];
  const fixed = await render([field('Workouts', 'subform', { autoWidth: false, subfields: columns })]);
  const table = box(fixed.doc, 'Workouts').querySelector('table.c2c-subform-fixed');
  assert.ok(table);
  const th = (name: string) => table.querySelector(`th[data-column="${name}"]`) as HTMLElement | null;
  assert.equal(th('Days')?.getAttribute('data-width'), '206px');
  assert.equal(th('Days')?.style.width, '206px');
  assert.equal(th('Workout')?.getAttribute('data-width'), '200px');
  assert.equal(th('Workout')?.style.width, '200px');
  assert.equal(th('Weight')?.getAttribute('data-width'), '115px');
  assert.equal(th('Weight')?.style.width, '115px');
  const daysCol = table.querySelector('col[data-width="206px"]') as HTMLElement | null;
  assert.ok(daysCol);
  assert.equal(daysCol.style.width, '206px');

  const auto = await render([field('Workouts', 'subform', { subfields: columns })]);
  const autoBox = box(auto.doc, 'Workouts');
  assert.equal(autoBox.querySelector('table.c2c-subform-fixed'), null);
  assert.equal((autoBox.querySelector('th[data-column="Days"]') as HTMLElement | null)?.style.width, '');
});

test('defaultRowCount is ignored once the record already stores rows', async () => {
  const fields = [field('Lines', 'subform', { defaultRowCount: 3, subfields: [field('Note', 'text')] })];
  const { doc } = await render(fields, { Lines: [{ Note: 'existing' }] });
  const el = box(doc, 'Lines');
  assert.equal(el.querySelectorAll('tbody tr[data-row-key]').length, 1);
});

test('a subform maxRows caps the grid: the Add control disables at the limit', async () => {
  const { dom } = await bundle();
  const fields = [field('Lines', 'subform', { maxRows: 2, subfields: [field('Note', 'text')] })];
  const { doc, win } = await render(fields);
  const el = box(doc, 'Lines');
  const add = [...el.querySelectorAll('button')].find((b) => /Add Lines row/.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
  assert.ok(add, 'the grid renders an add-row button');
  assert.equal(add.disabled, false);
  dom.flushSync(() => add.dispatchEvent(new win.MouseEvent('click', { bubbles: true })));
  assert.equal(el.querySelectorAll('tbody tr[data-row-key]').length, 2);
  assert.equal(add.disabled, true, 'the add control disables at maxRows');
  dom.flushSync(() => add.dispatchEvent(new win.MouseEvent('click', { bubbles: true })));
  assert.equal(el.querySelectorAll('tbody tr[data-row-key]').length, 2, 'a capped grid grows no further');
});

test('validateRows flags a subform carrying more rows than maxRows allows', () => {
  const lines = field('Lines', 'subform', { maxRows: 2, subfields: [field('Note', 'text')] });
  const rows = [0, 1, 2].map((index) => ({ index, values: { Note: 'x' } }));
  assert.match(validateRows(lines, rows).Lines ?? '', /at most 2 rows/);
  assert.deepEqual(validateRows(lines, rows.slice(0, 2)), {});
});
