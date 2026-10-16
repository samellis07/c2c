/**
 * Status-aware client wrapper. A 401 after boot
 * used to surface the raw "sign in required" body and nothing else; now the
 * wrapper retries the call once with a fresh token, and a second 401 ends the
 * session: the open form saves its draft to sessionStorage (keyed by route),
 * the shell shows "Your session ended", and its button goes to
 * /__catalyst/auth/login?service_url=<href>; the same route restores the
 * draft once on return. A 403 is never retried and renders the shared
 * access-denied screen (no Retry). A 5xx or a dropped network gets its own
 * message, and a failed record read never opens the edit form. Server
 * `error` text is never rendered for 401/403/5xx.
 *
 * The render tests need the template's runtime dependencies
 * (`npm ci --prefix packages/ui-react/template`); without them they skip
 * locally and fail under CI, where the install step is part of the run.
 */
// Production React for these mounts: the development build's StrictMode
// double-mount would fire every data effect twice and make the fetch counts
// below nondeterministic. The template resolves react lazily inside mount().
process.env.NODE_ENV = 'production';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test, type TestContext } from 'node:test';
import ts from 'typescript';
import { deriveIr, parse } from '../../core/src/index.js';
import { TEMPLATE_DIR, reactAppSpec } from '../src/index.js';

/* ---------- api.ts level: a fake view, no DOM ---------- */

interface ApiModule {
  createApi(view: unknown): { post<T>(endpoint: string, body: unknown): Promise<{ ok: boolean; status: number; body?: T }>; get<T>(endpoint: string): Promise<{ ok: boolean; status: number; body?: T }> };
}

async function loadApi(t: TestContext): Promise<ApiModule> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-react-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/runtime/api.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'api.ts',
  }).outputText;
  const file = join(dir, 'api.mjs');
  writeFileSync(file, js);
  return (await import(pathToFileURL(file).href)) as ApiModule;
}

interface FakeView {
  location: { href: string; hash: string };
  sessionStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  fetch: (url: string, init: { method?: string; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  hits: { url: string; init: { method?: string; body?: string } }[];
}

/** A view with a writable location and a fetch that answers the queued statuses. */
function fakeView(statuses: number[], href = 'https://app.example.test/#/form/Order'): FakeView {
  const queue = [...statuses];
  const view: FakeView = {
    location: { href, hash: '#/form/Order' },
    hits: [],
    fetch: (url, init) => {
      view.hits.push({ url, init });
      const status = queue.length > 1 ? queue.shift()! : queue[0]!;
      return Promise.resolve({ ok: status >= 200 && status < 300, status, text: async () => (status === 401 ? '{"error":"sign in required"}' : status >= 400 ? '{"error":"server words"}' : '{}') });
    },
  };
  return view;
}

test('a 401 then a 200 is exactly one retry and stays on the page', async (t) => {
  const { createApi } = await loadApi(t);
  const view = fakeView([401, 200]);
  const reply = await createApi(view).post<{ rows?: unknown[] }>('/reports/Orders', { op: 'query' });
  assert.equal(reply.ok, true, 'the retried call succeeds');
  assert.equal(view.hits.length, 2, 'exactly one retry');
  assert.equal(view.location.href, 'https://app.example.test/#/form/Order', 'a renewed session needs no sign-in');
});

test('a second 401 stops retrying and, with no prompt mounted, parks the page on the login endpoint with service_url', async (t) => {
  const { createApi } = await loadApi(t);
  const view = fakeView([401]);
  const reply = await createApi(view).post('/reports/Orders', { op: 'query' });
  assert.equal(reply.ok, false);
  assert.equal(reply.status, 401);
  assert.equal(reply.body, undefined, 'the server text is dropped');
  assert.equal(view.hits.length, 2, 'one retry, then it stops');
  const login = new URL(view.location.href, 'https://app.example.test');
  assert.equal(login.pathname, '/__catalyst/auth/login');
  assert.equal(login.searchParams.get('service_url'), 'https://app.example.test/#/form/Order', 'service_url is the page href');
});

test('a 401 on a lookup GET retries once, then goes to sign-in', async (t) => {
  const { createApi } = await loadApi(t);
  const view = fakeView([401]);
  const reply = await createApi(view).get('/lookups/Customer/Name?page=0&pageSize=300');
  assert.equal(reply.status, 401);
  assert.equal(view.hits.length, 2, 'one retry');
  const login = new URL(view.location.href, 'https://app.example.test');
  assert.equal(login.pathname, '/__catalyst/auth/login');
  assert.equal(login.searchParams.get('service_url'), 'https://app.example.test/#/form/Order');
});

test('a 401 right after a sign-in round trip does not send the page round again', async (t) => {
  const { createApi } = await loadApi(t);
  const view = fakeView([401]);
  const store: Record<string, string> = { 'c2c-auth:sign-in-at': String(Date.now() - 5_000) };
  view.sessionStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => void (store[k] = v), removeItem: (k) => void delete store[k] };
  await createApi(view).post('/reports/Orders', { op: 'query' });
  assert.equal(view.location.href, 'https://app.example.test/#/form/Order', 'no redirect loop for a user sign-in cannot help');
});

test('403 is never retried, never redirects, and carries no server text', async (t) => {
  const { createApi } = await loadApi(t);
  const view = fakeView([403]);
  const reply = await createApi(view).post('/reports/Orders', { op: 'query' });
  assert.deepEqual({ ...reply }, { ok: false, status: 403, body: undefined });
  assert.equal(view.hits.length, 1);
  assert.equal(view.location.href, 'https://app.example.test/#/form/Order');
});

test('5xx returns a failed reply without the server text and a dropped network returns status 0', async (t) => {
  const { createApi } = await loadApi(t);
  const api500 = createApi(fakeView([500]));
  assert.deepEqual({ ...(await api500.post('/x', {})) }, { ok: false, status: 500, body: undefined });
  const view = fakeView([]);
  view.fetch = () => Promise.reject(new TypeError('fetch failed'));
  const reply = await createApi(view).get('/lookups/Order/F?page=0');
  assert.equal(reply.ok, false);
  assert.equal(reply.status, 0);
  const api400 = createApi(fakeView([400]));
  assert.deepEqual((await api400.post('/x', {})).body, { error: 'server words' }, 'a validation answer keeps its text');
});

/* ---------- app level: the compiled template in jsdom ---------- */

const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react')) && existsSync(join(MODULES, 'react-dom'));
const MISSING = 'template runtime dependencies are not installed: run `npm ci --prefix packages/ui-react/template`';
const SKIP = runtimeReady ? false : process.env.CI === 'true' ? false : MISSING;
const LIB = join(TEMPLATE_DIR, 'lib');

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
	form Customer
	{
		displayname = "Customer"
		Name
		(
			type = text
			displayname = "Name"
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
		Secret
		(
			type = encrypted
			displayname = "Secret"
		)
		Buyer
		(
			type = picklist
			values = Customer.ID
			displayformat = [Name]
			displayname = "Buyer"
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
`;

let compiled: string | undefined;
function lib(): string {
  if (!compiled) {
    compiled = join(tmpdir(), `c2c-client-auth-${process.pid}`);
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
  navigations: string[];
  /** Login targets carried by the c2c:session-expired event's detail. */
  expired: string[];
  /** The "Sign in again" button of the session prompt, if it is open. */
  signInButton: () => HTMLButtonElement | undefined;
  hits: { url: string; body?: string }[];
  click: (el: Element) => void;
  /** A route component that mounts the generated Buyer lookup control with a stored value. */
  lookupRoute: () => unknown;
  boot: (routes?: Record<string, unknown>) => Promise<void>;
}

type FrameView = Window & Record<string, unknown>;

/**
 * One frame clock for the whole file, as a page has. motion-dom binds its
 * frame loop to the global requestAnimationFrame when it is first imported;
 * bound to the first test's window, every later frame would run on a closed
 * window's timer after that test's teardown. Frames go to the mounted view;
 * one requested between tests waits for the next view.
 */
let frameView: FrameView | null = null;
let waitingFrames: FrameRequestCallback[] = [];
const frameClock: Record<string, unknown> = {
  requestAnimationFrame: (callback: FrameRequestCallback): number => {
    if (frameView) return frameView.requestAnimationFrame(callback);
    waitingFrames.push(callback);
    return 0;
  },
  cancelAnimationFrame: (handle: number): void => frameView?.cancelAnimationFrame(handle),
};

function attachFrameClock(view: FrameView): void {
  frameView = view;
  const waiting = waitingFrames;
  waitingFrames = [];
  for (const callback of waiting) view.requestAnimationFrame(callback);
}

/**
 * A fresh jsdom document, a fake fetch answering the queued statuses, and the
 * app booted through bootApp with the real FormView/ReportView screens.
 * `view.location.href` is made writable so a login redirect is observable.
 */
async function mount(t: TestContext, statuses: number[], bodies: Record<number, string> = {}): Promise<Mounted> {
  const out = lib();
  const { JSDOM, VirtualConsole } = (await import('jsdom')) as unknown as {
    JSDOM: new (html: string, opts: Record<string, unknown>) => { window: Window & Record<string, unknown> };
    VirtualConsole: new () => { on(event: string, fn: (arg: unknown) => void): void };
  };
  const virtualConsole = new VirtualConsole();
  const navigations: string[] = [];
  virtualConsole.on('jsdomError', (error: unknown) => {
    const text = String((error as { message?: string })?.message ?? error);
    if (/Not implemented: navigation/.test(text)) navigations.push(text);
    else console.error(text);
  });
  virtualConsole.on('error', () => {});
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://app.example.test/',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const view = dom.window as unknown as FrameView;
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'DocumentFragment', 'SVGElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTableElement', 'getComputedStyle', 'CSS', 'self', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const key of globals) {
    saved.set(key, g[key]);
    const value = key in frameClock ? frameClock[key] : view[key];
    try {
      g[key] = value;
    } catch {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  }
  attachFrameClock(view);
  const unmounts: (() => void)[] = [];
  t.after(async () => {
    // Unmount first and let the last frames and timers run while the
    // document is live; only then detach the clock and close the window.
    for (const unmount of unmounts.splice(0)) unmount();
    for (let i = 0; i < 3; i++) await new Promise((resolve) => view.requestAnimationFrame(resolve));
    await settle();
    if (frameView === view) frameView = null;
    for (const key of globals) {
      // Keep `window` bound to the last mounted view: a framer-motion exit
      // animation resolves after teardown and React reads `window.event` for
      // the update priority — restoring undefined makes it throw async.
      if (key === 'window') continue;
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
  const queue = [...statuses];
  const hits: { url: string; body?: string }[] = [];
  const expired: string[] = [];
  view.addEventListener('c2c:session-expired', (event) => {
    const login = (event as unknown as { detail?: { login?: string } }).detail?.login;
    if (login) expired.push(login);
  });
  view.fetch = ((url: string, init: { body?: string } = {}) => {
    hits.push({ url: String(url), body: init.body });
    const status = queue.length > 1 ? queue.shift()! : queue[0]!;
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: async () => bodies[status] ?? (status === 401 ? '{"error":"sign in required"}' : status === 500 ? '{"error":"db exploded ACME-SECRET"}' : '{}') });
  }) as unknown as typeof fetch;
  const require = createRequire(join(out, 'lib', 'loader.cjs'));
  const React = require('react') as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown };
  const { bootApp } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/boot.js')).href)) as {
    bootApp: (spec: unknown, doc: Document | undefined, routes: Record<string, unknown>, custom: Record<string, unknown>) => () => void;
  };
  const { FormView } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/form/FormView.js')).href)) as { FormView: unknown };
  const { Field } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/form/fields.js')).href)) as { Field: unknown };
  const { LookupControl } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/lookup/LookupField.js')).href)) as { LookupControl: unknown };
  const { ReportView } = (await import(pathToFileURL(join(out, 'lib/c2c-ui/report/ReportView.js')).href)) as { ReportView: unknown };
  const spec = reactAppSpec(deriveIr(parse(SOURCE)));
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => view.setTimeout(resolve, 0));
  };
  const order = (spec.forms as Record<string, { fields: { name: string }[] }>).Order;
  const buyer = order.fields.find((field) => field.name === 'Buyer');
  assert.ok(buyer, 'the generated Order form carries the Buyer lookup');
  const lookupRoute = () => React.createElement(LookupControl as never, { field: buyer, name: 'Buyer', label: 'Buyer', value: '1001' });
  const routes = {
    'form/Order': ({ edit }: { edit?: string }) => React.createElement(FormView as never, { form: (spec.forms as Record<string, unknown>).Order, edit }, React.createElement(Field as never, { name: 'Title' }), React.createElement(Field as never, { name: 'Secret' })),
    'report/Orders': () => React.createElement(ReportView as never, { report: (spec.reports as Record<string, unknown>).Orders }),
  };
  return {
    view,
    hits,
    navigations,
    expired,
    signInButton: () => [...view.document.querySelectorAll('[data-session-expired] button')].find((b) => /sign in again/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined,
    click: (el: Element) => el.dispatchEvent(new (view as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true })),
    settle,
    main: () => (view.document.getElementById('main') ?? view.document.body) as HTMLElement,
    go: async (hash: string) => {
      view.location.hash = hash;
      await settle();
    },
    lookupRoute,
    boot: async (overrides: Record<string, unknown> = {}) => {
      unmounts.push(bootApp(spec, view.document, { ...routes, ...overrides }, {}));
      await settle();
    },
  };
}

test('a 401 on a report load retries once, then the session prompt sends the page to the login endpoint; the server error is never rendered', { skip: SKIP }, async (t) => {
  const m = await mount(t, [401]);
  await m.boot();
  await m.go('#/report/Orders');
  assert.equal(m.hits.length, 2, 'one retry');
  const login = m.expired.find((u) => u.startsWith('/__catalyst/auth/login?service_url='));
  assert.ok(login, `session-expired fired with the login target, got ${JSON.stringify(m.expired)}`);
  assert.ok(login.includes(encodeURIComponent('https://app.example.test/#/report/Orders')), 'service_url carries the page href');
  assert.equal(m.navigations.length, 0, 'the page does not leave before the user chooses to');
  const button = m.signInButton();
  assert.ok(button, 'the "Your session ended" prompt is open');
  assert.match(m.view.document.querySelector('[data-session-expired]')?.textContent ?? '', /session ended/i);
  m.click(button);
  await m.settle();
  assert.ok(m.navigations.some((n) => n.includes('navigation')), 'Sign in again navigates to the login endpoint');
  assert.ok(m.view.sessionStorage.getItem('c2c-auth:sign-in-at'), 'the loop guard records the round trip');
  assert.ok(!m.view.document.body.textContent?.includes('sign in required'), 'the raw server error is never rendered');
  const error = m.main().querySelector('[data-state="error"]');
  assert.ok(error, 'the report shows its error state behind the prompt');
  assert.equal([...error.querySelectorAll('button')].length, 0, 'no Retry for an ended session');
});

test('a 401 then a 200 on a report load is one retry and the rows render with no prompt', { skip: SKIP }, async (t) => {
  const m = await mount(t, [401, 200], { 200: '{"rows":[{"ROWID":"1","Title":"First order"}]}' });
  await m.boot();
  await m.go('#/report/Orders');
  assert.equal(m.hits.length, 2, 'exactly one retry');
  assert.equal(m.signInButton(), undefined, 'no session prompt');
  assert.match(m.main().textContent ?? '', /First order/);
});

test('a 403 on a report load shows the access-denied screen; the menu stays alive', { skip: SKIP }, async (t) => {
  const m = await mount(t, [403]);
  await m.boot();
  await m.go('#/report/Orders');
  const denied = m.main().querySelector('[data-access-denied]');
  assert.ok(denied, 'the denied screen renders inside the route');
  assert.match(denied.textContent ?? '', /access/i);
  assert.ok(m.view.document.getElementById('nav'), 'the menu is still mounted');
  assert.equal(m.hits.length, 1, 'no retry on a 403');
  assert.equal([...m.main().querySelectorAll('button')].filter((b) => /retry/i.test(b.textContent ?? '')).length, 0, 'a 403 never offers Retry');
  assert.ok(denied.querySelector('a[href="#/"]'), 'a way home');
});

test('a 401 on a lookup read retries once and opens the session prompt', { skip: SKIP }, async (t) => {
  const m = await mount(t, [401]);
  await m.boot({ 'form/Order': m.lookupRoute });
  await m.go('#/form/Order');
  assert.equal(m.hits.length, 2, 'one retry');
  assert.match(m.hits[0]?.url ?? '', /\/lookups\/Customer\/Name\?page=0&pageSize=300/);
  assert.ok(m.expired.some((u) => u.startsWith('/__catalyst/auth/login?service_url=')), 'the session ended with the login target');
  assert.ok(m.signInButton(), 'the session prompt is open');
  assert.ok(!m.view.document.body.textContent?.includes('sign in required'), 'the server error text is never rendered');
});

test('a 403 on a lookup read shows the access-denied screen', { skip: SKIP }, async (t) => {
  const m = await mount(t, [403]);
  await m.boot({ 'form/Order': m.lookupRoute });
  await m.go('#/form/Order');
  assert.ok(m.main().querySelector('[data-access-denied]'), 'the denied screen renders');
  assert.equal(m.hits.length, 1, 'no retry on a 403');
});

test('a 500 on a report load gets the service-unavailable message, not the server error body', { skip: SKIP }, async (t) => {
  const m = await mount(t, [500]);
  await m.boot();
  await m.go('#/report/Orders');
  const state = m.main().querySelector('[data-state="error"]');
  assert.ok(state, 'the report shows an error state');
  assert.match(state.textContent ?? '', /unavailable/i);
  assert.ok(!m.main().textContent?.includes('db exploded'), 'the server error text is never rendered');
});

test('a failed record read shows the error and never opens the edit form', { skip: SKIP }, async (t) => {
  const m = await mount(t, [500]);
  await m.boot();
  await m.go('#/form/Order/edit/123');
  assert.ok(m.main().textContent?.match(/could not be loaded|unavailable/i), 'the failure is visible');
  assert.equal(m.main().querySelector('form'), null, 'the edit form does not open on a failed read');
  assert.ok(!m.main().textContent?.includes('db exploded'), 'the server error text is never rendered');
});

test('a 403 on the record read shows the access-denied screen and no form', { skip: SKIP }, async (t) => {
  const m = await mount(t, [403]);
  await m.boot();
  await m.go('#/form/Order/edit/123');
  assert.ok(m.main().querySelector('[data-access-denied]'), 'the denied screen renders');
  assert.equal(m.main().querySelector('form'), null);
});

test('a dropped network on a report load names the connection and offers Retry', { skip: SKIP }, async (t) => {
  const m = await mount(t, [200]);
  m.view.fetch = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
  await m.boot();
  await m.go('#/report/Orders');
  const state = m.main().querySelector('[data-state="error"]');
  assert.match(state?.textContent ?? '', /could not be reached/i);
  assert.ok([...(state?.querySelectorAll('button') ?? [])].some((b) => /retry/i.test(b.textContent ?? '')), 'Retry is offered');
});

test('a 401 on submit saves the form draft keyed by route before the login redirect', { skip: SKIP }, async (t) => {
  const m = await mount(t, [401]);
  await m.boot();
  await m.go('#/form/Order');
  const input = m.main().querySelector('form input[name="Title"]') as HTMLInputElement | null;
  assert.ok(input, 'the form renders its Title input');
  input.value = 'Order for ACME';
  const submit = [...m.main().querySelectorAll('button')].find((b) => (b as HTMLButtonElement).type === 'submit');
  assert.ok(submit, 'a submit button is present');
  m.click(submit);
  await m.settle();
  assert.ok(m.expired.some((u) => u.startsWith('/__catalyst/auth/login?service_url=')), 'the session ended with the login target');
  assert.ok(m.signInButton(), 'the session prompt is open');
  assert.equal(m.hits.length, 2, 'the submit was retried once');
  assert.ok(!m.view.document.body.textContent?.includes('sign in required'), 'the server error text is never rendered');
  assert.match(m.main().querySelector('.c2c-banner')?.textContent ?? '', /session ended/i, 'the banner names the ended session');
  const draft = m.view.sessionStorage.getItem('c2c-draft:anon:#/form/Order:Order');
  assert.ok(draft, `a draft is saved under the route key; keys: ${JSON.stringify(Object.keys(m.view.sessionStorage))}`);
  assert.match(draft, /Order for ACME/, 'the draft holds the typed value');
  m.click(m.signInButton()!);
  await m.settle();
  assert.ok(m.navigations.some((n) => n.includes('navigation')), 'Sign in again leaves for the login endpoint');
});

test('a saved draft is restored into the form after the sign-in round trip', { skip: SKIP }, async (t) => {
  const m = await mount(t, [200]);
  m.view.sessionStorage.setItem('c2c-draft:anon:#/form/Order:Order', JSON.stringify({ Title: 'Order for ACME' }));
  await m.boot();
  await m.go('#/form/Order');
  const input = m.main().querySelector('form input[name="Title"]') as HTMLInputElement | null;
  assert.equal(input?.value, 'Order for ACME', 'the draft repopulates the field');
  assert.equal(m.view.sessionStorage.getItem('c2c-draft:anon:#/form/Order:Order'), null, 'the draft is restored once');
});

test('a session-expiry draft keeps no secret-typed field — the spec type decides, not the name', { skip: SKIP }, async (t) => {
  const m = await mount(t, [401]);
  await m.boot();
  await m.go('#/form/Order');
  (m.main().querySelector('form input[name="Title"]') as HTMLInputElement).value = 'Order for ACME';
  (m.main().querySelector('form input[name="Secret"]') as HTMLInputElement).value = 's3cr3t-value';
  const submit = [...m.main().querySelectorAll('button')].find((b) => (b as HTMLButtonElement).type === 'submit');
  m.click(submit!);
  await m.settle();
  const raw = m.view.sessionStorage.getItem('c2c-draft:anon:#/form/Order:Order');
  assert.ok(raw, 'the draft saved before the login redirect');
  const draft = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(draft.Secret, undefined, 'the secret-typed field is absent from the draft');
  assert.equal(raw.includes('s3cr3t-value'), false, 'no copy of the typed secret survives anywhere in the payload');
  assert.equal(draft.Title, 'Order for ACME', 'ordinary fields still draft');
});

test('a draft never restores for a different signed-in user in the same tab', { skip: SKIP }, async (t) => {
  const m = await mount(t, [200]);
  m.view.catalyst = { auth: { isUserAuthenticated: async () => ({ content: { user_id: 'user-b' } }) } };
  m.view.sessionStorage.setItem('c2c-draft:user-a:#/form/Order:Order', JSON.stringify({ Title: 'user a order' }));
  m.view.sessionStorage.setItem('c2c-draft:user-b:#/form/Order:Order', JSON.stringify({ Title: 'user b order' }));
  await m.boot();
  await m.go('#/form/Order');
  const input = m.main().querySelector('form input[name="Title"]') as HTMLInputElement | null;
  assert.equal(input?.value, 'user b order', 'only the signed-in user\u2019s draft lands');
  assert.equal(m.view.sessionStorage.getItem('c2c-draft:user-a:#/form/Order:Order')?.includes('user a order'), true, 'another user\u2019s draft is left untouched, not restored');
});

test('a 403 on submit shows the access-denied screen', { skip: SKIP }, async (t) => {
  const m = await mount(t, [403]);
  await m.boot();
  await m.go('#/form/Order');
  const submit = [...m.main().querySelectorAll('button')].find((b) => (b as HTMLButtonElement).type === 'submit');
  assert.ok(submit, 'a submit button is present');
  m.click(submit);
  await m.settle();
  assert.ok(m.main().querySelector('[data-access-denied]'), 'the denied screen renders');
});

function submitButton(m: Mounted): HTMLButtonElement {
  const submit = [...m.main().querySelectorAll('button')].find((b) => (b as HTMLButtonElement).type === 'submit');
  assert.ok(submit, 'a submit button is present');
  return submit as HTMLButtonElement;
}

function postedKeys(m: Mounted): unknown[] {
  return m.hits.filter((hit) => hit.body && hit.body.includes('"record"')).map((hit) => (JSON.parse(hit.body!) as Record<string, unknown>).idempotencyKey);
}

test('a committed submit whose on-success failed (200 + warning) shows the success banner', { skip: SKIP }, async (t) => {
  const m = await mount(t, [200], { 200: JSON.stringify({ dryRun: false, wrote: true, values: {}, warning: { code: 'POST_COMMIT_FAILED', message: 'The record was saved. An action after the save did not complete.', requestId: 'r1' } }) });
  await m.boot();
  await m.go('#/form/Order');
  (m.main().querySelector('form input[name="Title"]') as HTMLInputElement).value = 'Order for ACME';
  m.click(submitButton(m));
  await m.settle();
  const banner = m.main().querySelector('.c2c-banner')?.textContent ?? '';
  assert.match(banner, /Record added|Added Successfully/i, banner);
  assert.doesNotMatch(banner, /not saved|Dry run/i);
});

test('a 5xx that says wrote true says the row is stored and names the failed step', { skip: SKIP }, async (t) => {
  const m = await mount(t, [500], { 500: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Internal server error', correlationId: 'c', wrote: true }) });
  await m.boot();
  await m.go('#/form/Order');
  (m.main().querySelector('form input[name="Title"]') as HTMLInputElement).value = 'Order for ACME';
  m.click(submitButton(m));
  await m.settle();
  const banner = m.main().querySelector('.c2c-banner')?.textContent ?? '';
  assert.match(banner, /^The record was saved, but a step after saving failed\.$/, banner);
  assert.doesNotMatch(banner, /Internal server error|not saved/i);
});

test('a retry after a failed submit reuses the idempotency key; a committed submit starts a new one', { skip: SKIP }, async (t) => {
  const m = await mount(t, [503, 200, 200], { 200: JSON.stringify({ dryRun: false, wrote: true, values: {} }) });
  await m.boot();
  await m.go('#/form/Order');
  for (let i = 0; i < 3; i++) {
    (m.main().querySelector('form input[name="Title"]') as HTMLInputElement).value = 'Order for ACME';
    m.click(submitButton(m));
    await m.settle();
  }
  const keys = postedKeys(m);
  assert.equal(keys.length, 3, JSON.stringify(m.hits.map((hit) => hit.url)));
  for (const key of keys) assert.match(String(key), /^c2c-[0-9a-f-]{32,36}$/);
  assert.equal(keys[1], keys[0], 'the retry of a failed submit sends the same key');
  assert.notEqual(keys[2], keys[1], 'after a committed submit the next one is a new record');
});

test('submit is ignored while a submit is in flight: two presses post once', { skip: SKIP }, async (t) => {
  const m = await mount(t, [200]);
  let release: (value: unknown) => void = () => {};
  const posts: string[] = [];
  m.view.fetch = ((url: string, init: { body?: string } = {}) => {
    if (init.body && init.body.includes('"record"')) {
      posts.push(String(url));
      return new Promise((resolve) => (release = resolve));
    }
    return Promise.resolve({ ok: true, status: 200, text: async () => '{}' });
  }) as unknown as typeof fetch;
  await m.boot();
  await m.go('#/form/Order');
  (m.main().querySelector('form input[name="Title"]') as HTMLInputElement).value = 'Order for ACME';
  const formEl = m.main().querySelector('form')!;
  formEl.dispatchEvent(new (m.view.Event as typeof Event)('submit', { bubbles: true, cancelable: true }));
  formEl.dispatchEvent(new (m.view.Event as typeof Event)('submit', { bubbles: true, cancelable: true }));
  await m.settle();
  assert.equal(submitButton(m).getAttribute('aria-busy'), 'true', 'the submit control shows busy while in flight');
  formEl.dispatchEvent(new (m.view.Event as typeof Event)('submit', { bubbles: true, cancelable: true }));
  await m.settle();
  assert.equal(posts.length, 1, 'only one post while in flight');
  release({ ok: true, status: 200, text: async () => JSON.stringify({ dryRun: false, wrote: true, values: {} }) });
  await m.settle();
  assert.equal(posts.length, 1);
});
