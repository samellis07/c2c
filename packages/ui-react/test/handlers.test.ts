/**
 * Client handlers in the React target. The same generated
 * client/handlers modules run on load, on user input, on validate and on
 * success through the same browser shim the vanilla target uses — observed
 * as hidden/disabled fields, scripted set-values, a blocked submit, and the
 * same observable effect the vanilla applyActions has on a vanilla-rendered
 * form of the same app.
 *
 * The three inline apps mirror real gallery apps: call-logs (Add_Call hides
 * End_Call and the follow-up fields on load, shows them on user input,
 * cancels submit on a missing follow-up time), restaurants (New_Order hides
 * subform columns and disables totals on load, a user-input rule copies the
 * subtotal), time-tracker (Add_Job hides remarks/status, disables the
 * reviewer, blocks a backwards date range).
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { JSDOM } from 'jsdom';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { clientRuntimeSource } from '../../ui/src/generate.js';
import { buildUi } from '../../ui/src/index.js';
import { TEMPLATE_DIR, generateReactApp } from '../src/index.js';
import type { AppSpec, FormSpec } from '../template/lib/c2c-ui/types.js';
import type { FormHandlers, HandlerModule } from '../template/lib/c2c-ui/form/handlers.js';

interface Bundle {
  react: Record<string, any>;
  client: Record<string, any>;
  dom: Record<string, any>;
  fields: Record<string, any>;
  formview: Record<string, any>;
  env: Record<string, any>;
  extend: Record<string, any>;
}

const VITE_ENTRY = join(TEMPLATE_DIR, 'node_modules/vite/dist/node/index.js');
const REACT_PLUGIN_ENTRY = join(TEMPLATE_DIR, 'node_modules/@vitejs/plugin-react/dist/index.js');
if (!existsSync(VITE_ENTRY) || !existsSync(REACT_PLUGIN_ENTRY)) {
  // Missing template deps must fail loudly, never skip: a skipped handler
  // suite leaves the handler behaviour contract unverified while npm test is green.
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
/** Bundles FormView, fields and the handler engine once with the template's own build deps. */
function bundle(): Promise<Bundle> {
  bundled ??= (async () => {
    const { build } = (await import(pathToFileURL(VITE_ENTRY).href)) as { build: (config: Record<string, unknown>) => Promise<unknown> };
    const reactPlugin = ((await import(pathToFileURL(REACT_PLUGIN_ENTRY).href)) as { default: () => unknown }).default;
    const out = mkdtempSync(join(tmpdir(), 'c2c-handlers-'));
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
      return (mod.default ?? mod) as Record<string, any>;
    };
    const [react, client, dom, fields, formview, env, extend] = await Promise.all([
      load('react'), load('client'), load('dom'), load('fields'), load('formview'), load('env'), load('extend'),
    ]);
    return { react, client, dom, fields, formview, env, extend };
  })();
  return bundled;
}

/** The globals the widgets and their animation layer expect from a browser. */
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

interface VanillaRuntime {
  renderForm(form: unknown): string;
  applyActions(actions: Record<string, unknown>[], root: unknown): string[];
  browserShim(fetchImpl?: unknown): unknown;
}

let runtime: Promise<VanillaRuntime> | undefined;
/** The same concatenated client runtime the vanilla target serves. */
function vanillaRuntime(): Promise<VanillaRuntime> {
  runtime ??= import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`) as Promise<VanillaRuntime>;
  return runtime;
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

interface Generated {
  spec: AppSpec;
  handlers: FormHandlers;
}

/**
 * The React app files for `app`, reduced to the form spec plus a lazy module
 * registry over the verbatim client/handlers output — what the generated
 * src/generated/handlers.ts looks like in the app.
 */
function generated(app: App): Generated {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-handler-modules-'));
  dirs.push(dir);
  const files = generateReactApp(app);
  const modelSource = String(files.find((f) => f.path === 'src/generated/model.ts')!.data);
  const spec = JSON.parse(/= (\{[\s\S]*\});/.exec(modelSource)![1]!) as AppSpec;
  const modules: FormHandlers['modules'] = {};
  for (const file of files) {
    if (!file.path.startsWith('src/generated/handlers/') || !file.path.endsWith('.ts')) continue;
    const key = file.path.slice('src/generated/'.length, -'.ts'.length);
    const target = join(dir, `${key.replace(/\//g, '_')}.mjs`);
    writeFileSync(target, String(file.data));
    modules[key] = () => import(pathToFileURL(target).href) as Promise<HandlerModule>;
  }
  return { spec, handlers: { modules, createShim: async () => ({ shim: {} }) } };
}

interface Rendered {
  container: HTMLElement;
  formEl: HTMLFormElement;
  win: any;
  flush(): Promise<void>;
  posts: { endpoint: string; body: unknown }[];
}

/**
 * Mount a form through the real FormView, with the generated handlers wired
 * like the emitted src/generated/handlers.ts registry. `posts` records the
 * api.post calls the submit makes.
 */
async function renderForm(spec: FormSpec, allHandlers: FormHandlers): Promise<Rendered> {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  const win = dom.window as any;
  installGlobals(win);
  const kit = await bundle();
  const vanilla = await vanillaRuntime();
  const handlers: FormHandlers = { modules: allHandlers.modules, createShim: () => ({ shim: vanilla.browserShim() }) };
  const h = kit.react.createElement;
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = kit.client.createRoot(container);
  mounted.push(() => {
    kit.dom.flushSync(() => root.unmount());
    win.close();
  });
  const { flushSync } = kit.dom;
  const { Field } = kit.fields;
  const { FormView } = kit.formview;
  const { EnvContext } = kit.env;
  const { CustomizationContext } = kit.extend;
  const posts: Rendered['posts'] = [];
  const env = {
    view: win,
    doc: win.document,
    spec: {},
    api: {
      post: async (endpoint: string, body: unknown) => {
        posts.push({ endpoint, body });
        return { ok: true, status: 200, body: { dryRun: true, record: {} } };
      },
    },
    navigator: { onLine: true },
  };
  flushSync(() =>
    root.render(
      h(
        CustomizationContext.Provider,
        { value: {} },
        h(
          EnvContext.Provider,
          { value: env },
          h(FormView, { form: spec, handlers }, spec.fields.map((item) => h(Field, { key: item.name, name: item.name }))),
        ),
      ),
    ),
  );
  const formEl = container.querySelector('form') as unknown as HTMLFormElement;
  const flush = async () => {
    for (let i = 0; i < 200; i++) {
      flushSync(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5));
      const loading = container.querySelector('[aria-busy="true"]');
      if (!loading) break;
    }
    flushSync(() => {});
    assert.equal(container.querySelector('[aria-busy="true"]'), null, 'a lazy widget never mounted');
    // Handler passes are async (a dynamic module import plus state writes):
    // give them a few event-loop turns to publish before the caller reads.
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      flushSync(() => {});
    }
  };
  await flush();
  return { container, formEl, win, flush, posts };
}

/** Field boxes the handler rules hid, by link name — the observable `hide` set. */
function hiddenFields(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement>('[data-field]')]
    .filter((el) => el.hidden)
    .map((el) => el.getAttribute('data-field') ?? '')
    .filter(Boolean)
    .sort();
}

/** Disabled controls, by the field box (or subform column header) that owns them. */
function disabledFields(root: ParentNode): string[] {
  const out = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-field] input:disabled, [data-field] select:disabled, [data-field] textarea:disabled, fieldset[data-field-disabled][disabled]')) {
    out.add(el.closest('[data-field]')?.getAttribute('data-field') ?? el.getAttribute('data-field-disabled') ?? '');
  }
  return [...out].filter(Boolean).sort();
}

/**
 * Run the app's generated handlers for one lifecycle slot through the
 * vanilla applyActions on a vanilla-rendered form, and report the observable
 * sets — the vanilla half of the parity claim.
 */
async function vanillaOutcome(app: App, when: 'load' | 'input' | 'validate', record: Record<string, unknown>, fieldName?: string): Promise<{ hidden: string[]; disabled: string[]; columns: string[]; notes: string[] }> {
  const vanilla = await vanillaRuntime();
  const ui = buildUi(app);
  const form = ui.model.forms[0]!;
  const dom = new JSDOM(`<!doctype html><body>${vanilla.renderForm(form)}</body>`, { url: 'http://localhost/' });
  const formEl = dom.window.document.querySelector('form')! as unknown as HTMLFormElement;
  const recordEvents = new Set(['', 'on add', 'on add or edit']);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-handler-modules-'));
  dirs.push(dir);
  const notes: string[] = [];
  for (const handler of (form.handlers ?? []).filter((h) => {
    if (h.when !== when) return false;
    if (fieldName && h.field && h.field !== fieldName) return false;
    return recordEvents.has((h.recordEvent ?? '').toLowerCase());
  })) {
    const key = /handlers\/(.+)\.js@@$/.exec(handler.module ?? '')?.[1];
    const emitted = ui.files.find((f) => f.path === `client/handlers/${key}.mjs`);
    assert.ok(emitted, `no emitted module for ${handler.module}`);
    const target = join(dir, `${key!.replace(/\//g, '_')}.mjs`);
    writeFileSync(target, String(emitted.data));
    const mod = (await import(pathToFileURL(target).href)) as { clientActions?: (ctx: unknown) => Promise<Record<string, unknown>[]> };
    assert.equal(typeof mod.clientActions, 'function', `${key} exports no clientActions`);
    const actions = await mod.clientActions!({ record: { ...record }, old: {}, formNonce: '', form: formEl, shim: vanilla.browserShim() });
    notes.push(...vanilla.applyActions(Array.isArray(actions) ? actions : [], formEl));
  }
  const hidden = [...formEl.querySelectorAll<HTMLElement>('[data-field]')].filter((el) => el.hidden).map((el) => el.getAttribute('data-field') ?? '').filter(Boolean).sort();
  const disabled = [...new Set([...formEl.querySelectorAll<HTMLElement>('[data-field] input:disabled, [data-field] select:disabled, [data-field] textarea:disabled')].map((el) => el.closest('[data-field]')?.getAttribute('data-field') ?? '').filter(Boolean))].sort();
  const columns = [...formEl.querySelectorAll<HTMLElement>('.subform th')].filter((th) => th.hidden).map((th) => th.textContent?.trim() ?? '').sort();
  return { hidden, disabled, columns, notes };
}

function field(name: string, type: string, extra = ''): string {
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${name}\n\t\t(\n${lines}\n\t\t)`;
}

function subform(name: string, columns: string): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = subform\n${columns}\n\t\t)`;
}

/** The `type = X` line for a grid column, indented under its subform field. */
function column(name: string, type: string): string {
  return `\t\t\t${name}\n\t\t\t(\n\t\t\t\ttype = ${type}\n\t\t\t)`;
}

/* call-logs/Call_Logs.ds, "Run Scripts - While Adding a Record" on Add_Call:
   on load hides End_Call and the follow-up fields and disables Duration;
   on user input of Follow_up_Required shows or re-hides them; on validate
   alerts and cancels submit when a follow-up is due without a time. */
const CALL_LOGS = `\tform Add_Call
\t{
${field('Type', 'text')}
${field('Call_Start_Time', 'datetime')}
${field('Call_End_Time', 'datetime')}
${field('Duration', 'text')}
${field('Follow_up_Required', 'text')}
${field('Follow_up_Time', 'datetime')}
${field('Follow_up_Notes', 'text')}
${field('End_Call', 'text')}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tAdding as "While adding"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Add_Call
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton load
\t\t\t\t\t\t(
\t\t\t\t\t\t\thide End_Call;
\t\t\t\t\t\t\tdisable Duration;
\t\t\t\t\t\t\thide Follow_up_Time;
\t\t\t\t\t\t\thide Follow_up_Notes;
\t\t\t\t\t\t)
\t\t\t\t\t\ton validate
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif(input.Follow_up_Required == "Yes" && input.Follow_up_Time == null)
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\talert "Please specify/check the follow-up time";
\t\t\t\t\t\t\t\tcancel submit;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tAlways as "On always"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Add_Call
\t\t\t\ton add or edit
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton user input of Follow_up_Required
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif(input.Follow_up_Required == "Yes")
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\tshow Follow_up_Time;
\t\t\t\t\t\t\t\tshow Follow_up_Notes;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\telse
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\thide Follow_up_Time;
\t\t\t\t\t\t\t\thide Follow_up_Notes;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t)
\t\t\t\t\t\ton user input of Type
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif(input.Type == "Current Call")
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\tshow End_Call;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\telse
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\thide End_Call;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;

/* restaurants/Restaurants.ds: New_Order hides grid columns and disables the
   totals on load, and the submit is cancelled for a dine-in order with no
   table. The subtotal copy is the user-input rule the app runs on totals. */
const RESTAURANTS = `\tform New_Order
\t{
${field('Order_Type', 'text')}
${field('Table_No', 'text')}
${subform('Items', `${column('Item', 'text')}\n${column('Quantity', 'number')}\n${column('Status', 'text')}\n${column('Category', 'text')}`)}
${field('Sub_Total', 'text')}
${field('Net_Total', 'text')}
${field('Submitted_By', 'text')}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tAdding as "While adding"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = New_Order
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton load
\t\t\t\t\t\t(
\t\t\t\t\t\t\thide Items.Status;
\t\t\t\t\t\t\thide Items.Category;
\t\t\t\t\t\t\tdisable Net_Total,Submitted_By,Sub_Total;
\t\t\t\t\t\t)
\t\t\t\t\t\ton validate
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif(input.Order_Type == "Dine In" && input.Table_No == null)
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\talert "Please specify the table for a dine-in order";
\t\t\t\t\t\t\t\tcancel submit;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tTotals as "Totals"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = New_Order
\t\t\t\ton add or edit
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton user input of Sub_Total
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Net_Total = input.Sub_Total;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;

/* time-tracker/Time_Tracker.ds: Add_Job hides Remarks and Status, disables
   the reviewer on load, shows the remarks box on a high-priority pick, and
   cancels the submit when the dates run backwards. */
const TIME_TRACKER = `\tform Add_Job
\t{
${field('Job_Name', 'text')}
${field('Project', 'text')}
${field('Priority', 'text')}
${field('Reviewer', 'text')}
${field('Start_Date', 'text')}
${field('End_Date', 'text')}
${field('Remarks', 'text')}
${field('Status', 'text')}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tAdding as "While adding"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Add_Job
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton load
\t\t\t\t\t\t(
\t\t\t\t\t\t\thide Remarks,Status;
\t\t\t\t\t\t\tdisable Reviewer;
\t\t\t\t\t\t)
\t\t\t\t\t\ton validate
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif(input.End_Date < input.Start_Date)
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\talert "Please specify the correct date";
\t\t\t\t\t\t\t\tcancel submit;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tPriority as "Priority"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Add_Job
\t\t\t\ton add or edit
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton user input of Priority
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif(input.Priority == "High")
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\tshow Remarks;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`;

/**
 * Set a control's answer and fire the input event the form listens for.
 * Fields this harness drives are plain text inputs — Arc picklists (Radix)
 * cannot be opened by jsdom events, and handler behaviour does not depend
 * on the widget type.
 */
function enter(rendered: Rendered, name: string, value: string): void {
  const el = rendered.formEl.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null;
  assert.ok(el, `no control named ${name}`);
  if (el.tagName === 'SELECT') {
    (el as HTMLSelectElement).value = value;
    el.dispatchEvent(new rendered.win.Event('change', { bubbles: true }));
    return;
  }
  const setter = Object.getOwnPropertyDescriptor(rendered.win.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new rendered.win.Event('input', { bubbles: true }));
}

/** Submit the form and let the handler checks and (blocked) post settle. */
async function submit(rendered: Rendered): Promise<void> {
  const { flushSync } = (await bundle()).dom;
  flushSync(() => {
    rendered.formEl.dispatchEvent(new rendered.win.Event('submit', { bubbles: true, cancelable: true }));
  });
  await rendered.flush();
}

test('call-logs: on-load hide/disable, on-input show/hide, on-validate cancel — same as vanilla', async () => {
  const app = appOf(CALL_LOGS);
  const { spec, handlers } = generated(app);
  const form = spec.forms['Add_Call']!;
  assert.ok(form.handlers?.length, 'Add_Call carries handler specs');
  const rendered = await renderForm(form, handlers);

  // On load ran: End_Call, Follow_up_Time and Follow_up_Notes are hidden,
  // Duration is disabled — the same sets the vanilla applyActions produces.
  const expected = await vanillaOutcome(app, 'load', {});
  assert.deepEqual(hiddenFields(rendered.container), expected.hidden);
  assert.deepEqual(disabledFields(rendered.container), expected.disabled);
  assert.ok(expected.hidden.includes('End_Call') && expected.hidden.includes('Follow_up_Time'), 'vanilla baseline has the load hides');
  assert.ok(expected.disabled.includes('Duration'), 'vanilla baseline disables Duration');

  // On user input of Follow_up_Required = Yes shows the follow-up fields.
  enter(rendered, 'Follow_up_Required', 'Yes');
  await rendered.flush();
  const shown = await vanillaOutcome(app, 'load', {});
  const afterShow = hiddenFields(rendered.container);
  assert.ok(!afterShow.includes('Follow_up_Time'), 'Follow_up_Time is shown again');
  assert.ok(!afterShow.includes('Follow_up_Notes'), 'Follow_up_Notes is shown again');
  assert.deepEqual([...shown.hidden.filter((n) => n !== 'Follow_up_Time' && n !== 'Follow_up_Notes')].sort(), afterShow);

  // Switching Type off "Current Call" keeps End_Call hidden; switching back shows it.
  enter(rendered, 'Type', 'Current Call');
  await rendered.flush();
  assert.ok(!hiddenFields(rendered.container).includes('End_Call'), 'End_Call shows for a current call');
  enter(rendered, 'Type', 'Scheduled');
  await rendered.flush();
  assert.ok(hiddenFields(rendered.container).includes('End_Call'), 'End_Call hides again');

  // On validate: a due follow-up without a time cancels the submit and the
  // alert reaches the user as the form banner, exactly like the vanilla flow.
  const vanillaValidate = await vanillaOutcome(app, 'validate', { Follow_up_Required: 'Yes' });
  assert.ok(vanillaValidate.notes.includes('cancel'), 'the vanilla run cancels this submit');
  enter(rendered, 'Follow_up_Required', 'Yes');
  await rendered.flush();
  await submit(rendered);
  assert.equal(rendered.posts.filter((p) => p.endpoint === form.submitEndpoint).length, 0, 'the cancelled submit never posts');
  const banner = rendered.container.querySelector('.c2c-banner');
  assert.match(banner?.textContent ?? '', /follow-up time/);
});

test('restaurants: on-load column hides and disables, input set-value, validate cancel — same as vanilla', async () => {
  const app = appOf(RESTAURANTS);
  const { spec, handlers } = generated(app);
  const form = spec.forms['New_Order']!;
  const rendered = await renderForm(form, handlers);

  const expected = await vanillaOutcome(app, 'load', {});
  // Subform column hides: Items.Status and Items.Category columns are gone
  // (the React grid drops hidden columns; the vanilla grid hides their cells).
  assert.deepEqual(expected.columns.sort(), ['Category', 'Status'].sort());
  // The last column is the row-remove button (vanilla shows the button without
  // a field header), so only field column headers are comparable.
  const headerText = [...rendered.container.querySelectorAll('.c2c-subform thead th')]
    .map((th) => th.textContent?.trim())
    .filter((text) => text !== 'Remove')
    .sort();
  assert.deepEqual(headerText, ['Item', 'Quantity']);
  assert.deepEqual(disabledFields(rendered.container), expected.disabled);
  assert.ok(expected.disabled.includes('Net_Total') && expected.disabled.includes('Sub_Total'), 'vanilla disables the totals');

  // The user-input rule copies Sub_Total into Net_Total: a scripted set-value
  // repaints the (disabled) control.
  enter(rendered, 'Sub_Total', '42.50');
  await rendered.flush();
  const net = rendered.container.querySelector('input[name="Net_Total"]') as HTMLInputElement | null;
  assert.ok(net, 'Net_Total control exists');
  assert.equal(net.value, '42.50');

  // A dine-in order with no table cancels the submit with the alert as banner.
  const vanillaValidate = await vanillaOutcome(app, 'validate', { Order_Type: 'Dine In' });
  assert.ok(vanillaValidate.notes.includes('cancel'), 'the vanilla run cancels this submit');
  enter(rendered, 'Order_Type', 'Dine In');
  await rendered.flush();
  await submit(rendered);
  assert.equal(rendered.posts.filter((p) => p.endpoint === form.submitEndpoint).length, 0, 'the cancelled submit never posts');
  const banner = rendered.container.querySelector('.c2c-banner');
  assert.match(banner?.textContent ?? '', /dine-in order/);
});

test('time-tracker: on-load hides and disable, input show, validate cancel — same as vanilla', async () => {
  const app = appOf(TIME_TRACKER);
  const { spec, handlers } = generated(app);
  const form = spec.forms['Add_Job']!;
  const rendered = await renderForm(form, handlers);

  const expected = await vanillaOutcome(app, 'load', {});
  assert.deepEqual(hiddenFields(rendered.container), expected.hidden);
  assert.deepEqual(disabledFields(rendered.container), expected.disabled);
  assert.deepEqual(expected.hidden, ['Remarks', 'Status'], 'vanilla baseline hides Remarks and Status');
  assert.deepEqual(expected.disabled, ['Reviewer'], 'vanilla baseline disables Reviewer');

  // Priority = High shows Remarks again.
  enter(rendered, 'Priority', 'High');
  await rendered.flush();
  assert.deepEqual(hiddenFields(rendered.container), ['Status'], 'Remarks shows for a high-priority job');

  // A backwards date range cancels the submit; valid dates post the record
  // and the success banner lands, with no raw handler failure text anywhere.
  enter(rendered, 'Start_Date', '2026-10-20');
  enter(rendered, 'End_Date', '2026-10-12');
  await rendered.flush();
  await submit(rendered);
  assert.equal(rendered.posts.filter((p) => p.endpoint === form.submitEndpoint).length, 0, 'the cancelled submit never posts');
  assert.match(rendered.container.querySelector('.c2c-banner')?.textContent ?? '', /correct date/);

  enter(rendered, 'End_Date', '2026-10-30');
  await rendered.flush();
  await submit(rendered);
  assert.equal(rendered.posts.filter((p) => p.endpoint === form.submitEndpoint).length, 1, 'the valid submit posts once');
  assert.match(rendered.container.querySelector('.c2c-banner')?.textContent ?? '', /Record added|Dry run/);
  assert.doesNotMatch(rendered.container.textContent ?? '', /Client handler failed/);
});
