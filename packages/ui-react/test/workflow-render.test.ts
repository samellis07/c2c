/**
 * Renders the workflow UI in jsdom through a compiled copy of the template's
 * lib/c2c-ui: the decision dialog posts { ROWID, status, comment } to the
 * action's own endpoint, a refused transition shows the server's reason, the
 * session timeline is labelled as session-only, and bootApp renders into a
 * foreign document when the host `window` is a getter-only global — in a
 * browser `window.window` is such a property, so assigning it would throw at
 * boot under module strict mode.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { TEMPLATE_DIR } from '../src/index.js';
import type { AppSpec, FlowSpec } from '../template/lib/c2c-ui/types.js';

const LIB = join(TEMPLATE_DIR, 'lib/c2c-ui');
const CSS_STUB = 'export default new Proxy({}, { get: (_t, key) => String(key) });\n';

/** Emitted module specifiers the bundler resolves but Node cannot: extensionless paths and css modules. */
function rewriteSpecifiers(code: string): string {
  return code.replace(/((?:from|import)\s*(?:\(\s*)?["'])(\.[^"']*)(["'])/g, (_all, head: string, spec: string, tail: string) => {
    const next = /\.css$/.test(spec) ? `${spec}.mjs` : /\.(?:tsx?|jsx?|mts|cts)$/.test(spec) ? spec.replace(/\.[^.]+$/, '.mjs') : `${spec}.mjs`;
    return `${head}${next}${tail}`;
  });
}

/** Transpile lib/c2c-ui to plain ESM in a scratch dir; the app's own node_modules resolve through a symlink. */
function emitLib(out: string): void {
  const walk = (src: string, dst: string): void => {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, entry.name);
      const to = join(dst, entry.name);
      if (entry.isDirectory()) walk(from, to);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(from, 'utf8');
        const emitted = ts.transpileModule(source, {
          fileName: entry.name,
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText;
        writeFileSync(`${to.replace(/\.tsx?$/, '')}.mjs`, rewriteSpecifiers(emitted));
      }
    }
  };
  walk(LIB, out);
  const stubs = new Set<string>();
  const collect = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith('.mjs')) {
        for (const match of readFileSync(path, 'utf8').matchAll(/["'](\.[^"']*\.css\.mjs)["']/g)) stubs.add(join(dirname(path), match[1]!));
      }
    }
  };
  collect(out);
  for (const stub of stubs) writeFileSync(stub, CSS_STUB);
}

type Dom = { window: Window };
type Post = { endpoint: string; body: Record<string, unknown> };

function setGlobal(name: string, value: unknown): void {
  const host = Object.getOwnPropertyDescriptor(globalThis, name);
  if (host && !host.configurable) return;
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

// The jsdom window and document must be global before react-dom initializes:
// canUseDOM and isInputEventSupported are settled once at module load. Loading
// react-dom first leaves isInputEventSupported false and the change plugin on
// its polyfill path, which never synthesizes onChange from 'input' events, so
// the comment composer could not be typed through in this harness.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true }) as unknown as Dom;
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
setGlobal('window', dom.window);
setGlobal('document', dom.window.document);
setGlobal('navigator', dom.window.navigator);
// jsdom ships no IntersectionObserver; the components' in-view animations only
// need the constructor to exist in this harness.
class StubIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
setGlobal('IntersectionObserver', StubIntersectionObserver);

const req = createRequire(join(TEMPLATE_DIR, 'package.json'));
const React = req('react') as {
  createElement: (...args: unknown[]) => unknown;
  useState: <T>(initial: T) => [T, (next: T) => void];
  act: (fn: () => unknown) => Promise<void>;
};
const { createRoot } = req('react-dom/client') as { createRoot: (el: Element) => { render(node: unknown): void; unmount(): void } };

let dir = '';
let tpl = '';

function moduleUrl(name: string): string {
  return pathToFileURL(join(tpl, name)).href;
}

/** Loop-bound platform globals must stay the host's: jsdom's MessageChannel never delivers to Node's event loop, so React's scheduler would strand pending work. */
const HOST_GLOBALS = new Set(['console', 'MessageChannel', 'MessagePort', 'BroadcastChannel', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'performance']);

/** The realm globals bootApp adopts, applied directly so components see the booted document's constructors. */
function adoptWindowGlobals(view: Window): void {
  for (const name of Object.getOwnPropertyNames(view)) {
    if (HOST_GLOBALS.has(name)) continue;
    let value: unknown;
    try {
      value = (view as unknown as Record<string, unknown>)[name];
    } catch {
      continue;
    }
    if (value !== undefined) setGlobal(name, value);
  }
  setGlobal('window', view);
  setGlobal('document', view.document);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'c2c-ui-render-'));
  tpl = join(dir, 'tpl');
  emitLib(tpl);
  symlinkSync(join(TEMPLATE_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir');
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const FLOW: FlowSpec = {
  kind: 'approval',
  name: 'Request_Approval',
  label: 'Request Approval',
  form: 'Request',
  statusColumn: 'Status',
  start: 'Pending',
  stages: ['Pending', 'Approved', 'Rejected'],
  transitions: [
    { name: 'level 1', action: 'approve', from: 'Pending', to: 'Approved' },
    { name: 'level 1', action: 'reject', from: 'Pending', to: 'Rejected' },
  ],
  endpoints: {
    approve: '/flows/request-approval/approve',
    reject: '/flows/request-approval/reject',
    transition: '/flows/request-approval/transition',
  },
  report: 'All_Requests',
};

const SPEC: AppSpec = {
  name: 'Flow App',
  spec: 1,
  theme: { accent: '#226688', accentInk: '#ffffff', menu: 'list' },
  nav: [],
  forms: {},
  reports: {
    All_Requests: {
      name: 'All_Requests',
      label: 'All Requests',
      view: 'list',
      form: 'Request',
      queryEndpoint: '/reports/all-requests/query',
      pageSize: 20,
      columns: [{ field: 'Title', label: 'Title', phone: true }],
      rowActions: { edit: true, delete: false },
      customActions: [],
      sort: [],
      filters: [],
      groupBy: [],
      detail: false,
      conditionalFormats: [],
    },
  },
  workflows: [FLOW],
};

function doc(): Document {
  return dom.window.document;
}

function buttonWith(text: string, within?: Element): HTMLElement | undefined {
  return Array.from((within ?? doc()).querySelectorAll('button')).find((el) => (el.textContent ?? '').trim() === text);
}

/** The open decision dialog's surface; the inbox behind it stays in the DOM, so its buttons must be excluded. */
function dialogSurface(): Element | undefined {
  return doc().querySelector('[role="dialog"]') ?? undefined;
}

function click(el: Element): void {
  el.dispatchEvent(new (dom.window as unknown as typeof globalThis).MouseEvent('click', { bubbles: true, cancelable: true }));
}

function typeIn(el: HTMLTextAreaElement, value: string): void {
  const proto = (dom.window as unknown as typeof globalThis).HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new (dom.window as unknown as typeof globalThis).Event('input', { bubbles: true }));
}

function apiEnv(posts: Post[], reply: { ok: boolean; status: number; body?: unknown }): unknown {
  return {
    view: dom.window,
    doc: doc(),
    spec: SPEC,
    api: {
      post: async (endpoint: string, body: unknown) => {
        posts.push({ endpoint, body: body as Record<string, unknown> });
        return reply;
      },
    },
  };
}

interface DecisionDialogModule {
  DecisionDialog: (props: Record<string, unknown>) => unknown;
}
interface EnvModule {
  EnvContext: { Provider: unknown };
}

async function mountDialog(posts: Post[], reply: { ok: boolean; status: number; body?: unknown }, outcomes: unknown[]): Promise<{ host: HTMLElement; unmount(): void }> {
  const { DecisionDialog } = (await import(moduleUrl('workflow/DecisionDialog.mjs'))) as unknown as DecisionDialogModule;
  const { EnvContext } = (await import(moduleUrl('runtime/env.mjs'))) as unknown as EnvModule;
  const decision = { flow: FLOW, transition: FLOW.transitions[0], rowId: '42', recordLabel: 'Request 42' };
  const harness = () => {
    const [comments, setComments] = React.useState<unknown[]>([]);
    return React.createElement(
      EnvContext.Provider as never,
      { value: apiEnv(posts, reply) },
      React.createElement(DecisionDialog as never, {
        decision,
        comments,
        onComments: setComments,
        onDone: (outcome: unknown) => outcomes.push(outcome),
        onClose: () => undefined,
      }),
    );
  };
  const host = doc().createElement('div');
  doc().body.appendChild(host);
  const root = createRoot(host);
  await React.act(() => root.render(React.createElement(harness)));
  return { host, unmount: () => root.unmount() };
}

test('bootApp renders into a foreign document when the host window is getter-only', async () => {
  const { bootApp } = (await import(moduleUrl('boot.mjs'))) as {
    bootApp: (spec: AppSpec, doc: Document | undefined, routes: Record<string, never>, custom: Record<string, never>) => void;
  };
  const container = doc().createElement('div');
  container.id = 'root';
  doc().body.appendChild(container);
  // A browser's own window.window is a getter-only accessor; an unconditional
  // host.window = view assignment throws TypeError in strict-mode module code.
  // The guard must leave a defined host window alone.
  Object.defineProperty(globalThis, 'window', { configurable: true, get: () => globalThis });
  assert.doesNotThrow(() => bootApp(SPEC, doc(), {}, {}), 'boot threw on a getter-only host window');
  assert.match(container.innerHTML, /Not found/);
});

test('the decision dialog posts the action endpoint with ROWID, status and the newest comment', async () => {
  adoptWindowGlobals(dom.window);
  const posts: Post[] = [];
  const outcomes: { from: string; to: string; comment: string; dryRun: boolean }[] = [];
  const mounted = await mountDialog(posts, { ok: true, status: 200, body: { dryRun: false, wrote: true, from: 'Pending', status: 'Approved' } }, outcomes);
  try {
    const surface = dialogSurface();
    assert.ok(surface, 'the dialog opened');
    const field = Array.from(doc().querySelectorAll('textarea')).find((el) => el.getAttribute('aria-label') === 'Add a comment (optional)') as HTMLTextAreaElement | undefined;
    assert.ok(field, 'the comment composer is rendered');
    await React.act(() => typeIn(field, 'ship it'));
    await React.act(() => click(buttonWith('Send', surface)!));
    await React.act(() => click(buttonWith('Approve', surface)!));
    await React.act(() => undefined);
    assert.equal(posts.length, 1, JSON.stringify(posts));
    assert.equal(posts[0]!.endpoint, '/flows/request-approval/approve');
    assert.deepEqual(posts[0]!.body, { ROWID: '42', status: 'Approved', comment: 'ship it' });
    assert.equal(outcomes.length, 1);
    assert.deepEqual([outcomes[0]!.from, outcomes[0]!.to, outcomes[0]!.comment, outcomes[0]!.dryRun], ['Pending', 'Approved', 'ship it', false]);
  } finally {
    await React.act(() => mounted.unmount());
  }
});

test('a refused transition shows the server reason and does not report a decision', async () => {
  adoptWindowGlobals(dom.window);
  const posts: Post[] = [];
  const outcomes: unknown[] = [];
  const mounted = await mountDialog(posts, { ok: false, status: 403, body: { error: 'caller is not an approver for this stage' } }, outcomes);
  try {
    await React.act(() => click(buttonWith('Approve')!));
    await React.act(() => undefined);
    assert.equal(posts.length, 1);
    assert.match(doc().body.textContent ?? '', /caller is not an approver for this stage/);
    assert.equal(outcomes.length, 0);
  } finally {
    await React.act(() => mounted.unmount());
  }
});

test('the inbox labels its timeline as session-only and shows a completed comment read-only', async () => {
  adoptWindowGlobals(dom.window);
  const { ApprovalsInbox } = (await import(moduleUrl('workflow/ApprovalsInbox.mjs'))) as unknown as { ApprovalsInbox: (props: Record<string, unknown>) => unknown };
  const { EnvContext } = (await import(moduleUrl('runtime/env.mjs'))) as unknown as EnvModule;
  const posts: Post[] = [];
  const env = {
    view: dom.window,
    doc: doc(),
    spec: SPEC,
    api: {
      post: async (endpoint: string, body: unknown) => {
        posts.push({ endpoint, body: body as Record<string, unknown> });
        if (endpoint === '/reports/all-requests/query') {
          const stage = (body as { filter?: { value?: string } }).filter?.value;
          // One stored record, reported only for the stage it is actually at:
          // a reply per queried stage would repeat the row under the same key.
          const rows = stage === 'Pending' || stage === 'Approved' ? [{ ROWID: '42', Title: 'Ada', Status: stage }] : [];
          return { ok: true, status: 200, body: { rows } };
        }
        return { ok: true, status: 200, body: { dryRun: false, wrote: true, from: 'Pending', status: 'Approved' } };
      },
    },
  };
  const host = doc().createElement('div');
  doc().body.appendChild(host);
  const root = createRoot(host);
  const render = (view: string) =>
    root.render(React.createElement(EnvContext.Provider as never, { value: env }, React.createElement(ApprovalsInbox as never, { view })));
  try {
    await React.act(() => render('pending'));
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.match(host.textContent ?? '', /Ada/);
    // Open the decision, type a comment, and confirm it.
    await React.act(() => click(buttonWith('Approve')!));
    const surface = dialogSurface();
    assert.ok(surface, 'the dialog opened');
    const field = Array.from(doc().querySelectorAll('textarea')).find((el) => el.getAttribute('aria-label') === 'Add a comment (optional)') as HTMLTextAreaElement | undefined;
    assert.ok(field, 'the comment composer is rendered');
    await React.act(() => typeIn(field, 'looks right'));
    await React.act(() => click(buttonWith('Send', surface)!));
    await React.act(() => click(buttonWith('Approve', surface)!));
    await React.act(() => undefined);
    const decision = posts.find((post) => post.endpoint === '/flows/request-approval/approve');
    assert.ok(decision, 'the decision posted');
    assert.deepEqual(decision.body, { ROWID: '42', status: 'Approved', comment: 'looks right' });
    // The confirmed item left the pending list. The same inbox mounted on the
    // completed view keeps this session's timeline — honestly labelled — and
    // the comment, but no composer: text typed there would go nowhere.
    await React.act(() => render('completed'));
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const text = host.textContent ?? '';
    assert.match(text, /This session's decisions/);
    assert.match(text, /Pending → Approved/);
    assert.match(text, /This session's comments/);
    assert.match(text, /looks right/);
    assert.equal(host.querySelector('textarea'), null);
    assert.equal(host.textContent?.includes('Recent decisions'), false);
  } finally {
    await React.act(() => root.unmount());
  }
});

test('the record stage bar labels its timeline as session-only', async () => {
  adoptWindowGlobals(dom.window);
  const { FlowStageBar } = (await import(moduleUrl('workflow/FlowStageBar.mjs'))) as unknown as { FlowStageBar: (props: Record<string, unknown>) => unknown };
  const { EnvContext } = (await import(moduleUrl('runtime/env.mjs'))) as unknown as EnvModule;
  const posts: Post[] = [];
  const form = { name: 'Request', recordEndpoint: '/forms/request/record', fields: [{ name: 'Title' }] };
  const env = {
    view: dom.window,
    doc: doc(),
    spec: SPEC,
    api: {
      post: async (endpoint: string, body: unknown) => {
        posts.push({ endpoint, body: body as Record<string, unknown> });
        if (endpoint === form.recordEndpoint) return { ok: true, status: 200, body: { record: { ROWID: '42', Title: 'Ada', Status: 'Pending' } } };
        return { ok: true, status: 200, body: { dryRun: false, wrote: true, from: 'Pending', status: 'Approved' } };
      },
    },
  };
  const host = doc().createElement('div');
  doc().body.appendChild(host);
  const root = createRoot(host);
  try {
    await React.act(() => root.render(React.createElement(EnvContext.Provider as never, { value: env }, React.createElement(FlowStageBar as never, { form, rowId: '42' }))));
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.ok(host.querySelector('[data-stage="Pending"]'), 'the bar shows the stored stage');
    await React.act(() => click(buttonWith('Approve', host)!));
    const surface = dialogSurface();
    assert.ok(surface, 'the dialog opened');
    await React.act(() => click(buttonWith('Approve', surface)!));
    await React.act(() => undefined);
    assert.ok(posts.some((post) => post.endpoint === '/flows/request-approval/approve'), 'the decision posted');
    // The timeline holds only transitions confirmed in this session, so its
    // heading and accessible name must say so.
    const text = host.textContent ?? '';
    assert.match(text, /This session's transitions/);
    assert.match(text, /Pending → Approved/);
    assert.equal(text.includes('Recent transitions'), false);
    assert.equal(host.querySelector('[aria-label="Recent transitions"]'), null);
  } finally {
    await React.act(() => root.unmount());
  }
});
