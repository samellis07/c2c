/**
 * React client: a current-user call that never answers must show the stall
 * message and a Retry button on the sign-in gate and on the smoke page.
 * The budget is short here so a removed timeout fails the test.
 */
process.env.NODE_ENV = 'production';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { TEMPLATE_DIR } from '../src/index.js';

const STALL =
  'Sign-in did not complete. Reload the page; if it keeps happening, the app administrator must finish setup step 3, "Sign in once: sign in to the deployed app once".';
const CURRENT = 'https://slate.example/baas/v1/project/1001/project-user/current';
const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react')) && existsSync(join(MODULES, 'react-dom'));
const skip = runtimeReady ? false : process.env.CI ? false : 'template runtime dependencies are not installed';

interface Compiled {
  dir: string;
  auth: { AuthGate: (props: { children?: unknown }) => unknown };
  env: { EnvContext: { Provider: unknown } };
  smoke: { mountSmoke(section: Element, model: unknown, view: unknown): void };
}

function emit(dir: string, rel: string, out: string, rewrite: (text: string) => string): void {
  const source = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui', rel), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: rel,
  }).outputText;
  writeFileSync(join(dir, out), rewrite(js));
}

async function load(): Promise<Compiled> {
  assert.ok(runtimeReady, 'template runtime dependencies are not installed');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-auth-timeout-'));
  writeFileSync(
    join(dir, 'button.mjs'),
    `import { createElement } from 'react';
export function Button({ children, onClick, type }) {
  return createElement('button', { type: type || 'button', onClick }, children);
}
`,
  );
  emit(dir, 'runtime/api.ts', 'api.mjs', (text) => text);
  emit(dir, 'runtime/env.tsx', 'env.mjs', (text) => text.replace(/from\s+['"]\.\/api['"]/, "from './api.mjs'"));
  emit(dir, 'runtime/auth.tsx', 'auth.mjs', (text) =>
    text
      .replace(/from\s+['"]\.\.\/arc\/components\/button\/button['"]/, "from './button.mjs'")
      .replace(/from\s+['"]\.\/api['"]/, "from './api.mjs'")
      .replace(/from\s+['"]\.\/env['"]/, "from './env.mjs'"),
  );
  emit(dir, 'smoke/run.ts', 'run.mjs', (text) => text.replace(/from\s+['"]\.\.\/runtime\/api['"]/, "from './api.mjs'"));
  symlinkSync(MODULES, join(dir, 'node_modules'), 'dir');
  const auth = (await import(pathToFileURL(join(dir, 'auth.mjs')).href)) as Compiled['auth'];
  const env = (await import(pathToFileURL(join(dir, 'env.mjs')).href)) as Compiled['env'];
  const smoke = (await import(pathToFileURL(join(dir, 'run.mjs')).href)) as Compiled['smoke'];
  return { dir, auth, env, smoke };
}

function reply(status: number, data: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in input && typeof (input as { url?: unknown }).url === 'string') return (input as { url: string }).url;
  return String(input ?? '');
}

async function until(ready: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1500) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} did not settle within 1500ms`);
}

function installGlobals(view: Window): () => void {
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'HTMLButtonElement', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const saved = new Map<string, unknown>();
  const g = globalThis as Record<string, unknown>;
  const bag = view as unknown as Record<string, unknown>;
  for (const key of keys) {
    saved.set(key, g[key]);
    try {
      g[key] = bag[key];
    } catch {
      Object.defineProperty(globalThis, key, { value: bag[key], configurable: true, writable: true });
    }
  }
  return () => {
    for (const key of keys) {
      if (key === 'window') continue;
      try {
        g[key] = saved.get(key);
      } catch {
        Object.defineProperty(globalThis, key, { value: saved.get(key), configurable: true, writable: true });
      }
    }
  };
}

test('AuthGate shows the stall message when current-user never answers, and Retry renders the app', { skip }, async () => {
  const { JSDOM } = await import('jsdom');
  const compiled = await load();
  try {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/slate/index.html', pretendToBeVisual: true });
    const view = dom.window as unknown as Window & Record<string, unknown>;
    const restore = installGlobals(view);
    const logs: string[] = [];
    (view.console as { error: (...args: unknown[]) => void }).error = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    view.C2C_AUTH_TIMEOUT_MS = 40;
    let hang = true;
    let signal: AbortSignal | undefined;
    view.fetch = ((input: unknown, init?: { signal?: AbortSignal }) => {
      if (/\/project-user\/(?:current|token)(?:[/?#]|$)/.test(urlOf(input))) {
        signal = init?.signal;
        if (hang) return new Promise(() => {});
        return Promise.resolve(reply(200, { user_id: '1' }));
      }
      return Promise.resolve(reply(401));
    }) as unknown as typeof fetch;
    view.catalyst = { auth: { isUserAuthenticated: () => (view.fetch as (input: string) => Promise<unknown>)(CURRENT) } };
    const require = createRequire(join(MODULES, 'react/package.json'));
    const React = require('react') as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown };
    const { createRoot } = require('react-dom/client') as { createRoot: (el: Element) => { render: (node: unknown) => void; unmount: () => void } };
    const root = createRoot(view.document.getElementById('root')!);
    const env = { view, doc: view.document, spec: {}, api: {} };
    root.render(React.createElement(compiled.env.EnvContext.Provider as never, { value: env }, React.createElement(compiled.auth.AuthGate, null, React.createElement('p', { 'data-app': '' }, 'app'))));
    const started = Date.now();
    await until(() => view.document.querySelector('[role="alert"]')?.textContent === STALL, 'AuthGate stall');
    assert.ok(Date.now() - started < 1500);
    assert.equal(view.document.querySelector('h1')?.textContent, 'Sign-in did not complete');
    const retry = [...view.document.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    assert.ok(retry, 'Retry is shown');
    assert.equal(view.document.querySelector('[data-app]'), null, 'the app stays hidden while sign-in is stalled');
    assert.equal(signal?.aborted, true);
    assert.ok(logs.length > 0);
    for (const entry of logs) {
      assert.notEqual(entry.trim(), 't');
      assert.match(entry, /Sign-in did not complete/);
    }
    hang = false;
    retry!.click();
    await until(() => view.document.querySelector('[data-app]') != null, 'AuthGate retry');
    assert.equal(view.document.querySelector('[role="alert"]'), null);
    root.unmount();
    restore();
    view.close();
  } finally {
    rmSync(compiled.dir, { recursive: true, force: true });
  }
});

test("AuthGate logs a sentence when the current-user call throws 't'", { skip }, async () => {
  const { JSDOM } = await import('jsdom');
  const compiled = await load();
  try {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/slate/index.html', pretendToBeVisual: true });
    const view = dom.window as unknown as Window & Record<string, unknown>;
    const restore = installGlobals(view);
    const logs: string[] = [];
    (view.console as { error: (...args: unknown[]) => void }).error = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    view.C2C_AUTH_TIMEOUT_MS = 40;
    view.fetch = (async (input: unknown) => {
      if (/\/project-user\/(?:current|token)(?:[/?#]|$)/.test(urlOf(input))) throw new Error('t');
      return reply(401);
    }) as unknown as typeof fetch;
    view.catalyst = { auth: { isUserAuthenticated: () => (view.fetch as (input: string) => Promise<unknown>)(CURRENT) } };
    const require = createRequire(join(MODULES, 'react/package.json'));
    const React = require('react') as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown };
    const { createRoot } = require('react-dom/client') as { createRoot: (el: Element) => { render: (node: unknown) => void; unmount: () => void } };
    const root = createRoot(view.document.getElementById('root')!);
    root.render(
      React.createElement(
        compiled.env.EnvContext.Provider as never,
        { value: { view, doc: view.document, spec: {}, api: {} } },
        React.createElement(compiled.auth.AuthGate, null, React.createElement('p', null, 'app')),
      ),
    );
    await until(() => view.document.querySelector('[role="alert"]')?.textContent === STALL, 'minified AuthGate stall');
    for (const entry of logs) assert.notEqual(entry.trim(), 't');
    assert.ok(logs.some((entry) => entry.includes('Sign-in did not complete')));
    root.unmount();
    restore();
    view.close();
  } finally {
    rmSync(compiled.dir, { recursive: true, force: true });
  }
});

test('AuthGate keeps the sign-in prompt when current-user answers 401', { skip }, async () => {
  const { JSDOM } = await import('jsdom');
  const compiled = await load();
  try {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/slate/index.html', pretendToBeVisual: true });
    const view = dom.window as unknown as Window & Record<string, unknown>;
    const restore = installGlobals(view);
    view.C2C_AUTH_TIMEOUT_MS = 40;
    view.C2C_LOGIN_WAIT_MS = 60_000;
    view.fetch = (async () => reply(401, { error: 'no session' })) as unknown as typeof fetch;
    view.catalyst = {
      auth: {
        isUserAuthenticated: async () => {
          await (view.fetch as (input: string) => Promise<unknown>)(CURRENT);
          throw new Error('no session');
        },
        signIn() {},
      },
    };
    const require = createRequire(join(MODULES, 'react/package.json'));
    const React = require('react') as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown };
    const { createRoot } = require('react-dom/client') as { createRoot: (el: Element) => { render: (node: unknown) => void; unmount: () => void } };
    const root = createRoot(view.document.getElementById('root')!);
    root.render(
      React.createElement(
        compiled.env.EnvContext.Provider as never,
        { value: { view, doc: view.document, spec: {}, api: {} } },
        React.createElement(compiled.auth.AuthGate, null, React.createElement('p', { 'data-app': '' }, 'app')),
      ),
    );
    await until(() => view.document.querySelector('h1')?.textContent === 'Sign in to continue.', 'signed-out AuthGate');
    assert.equal([...view.document.querySelectorAll('button')].some((button) => button.textContent === 'Retry'), false);
    assert.equal(view.document.querySelector('[data-app]'), null);
    assert.ok(view.document.getElementById('c2c-login'));
    root.unmount();
    restore();
    view.close();
  } finally {
    rmSync(compiled.dir, { recursive: true, force: true });
  }
});

test('the smoke page fails when current-user never answers, and Retry clears the stall', { skip }, async () => {
  const { JSDOM } = await import('jsdom');
  const compiled = await load();
  try {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/slate/index.html' });
    const view = dom.window as unknown as Window & Record<string, unknown>;
    const logs: string[] = [];
    (view.console as { error: (...args: unknown[]) => void }).error = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(' '));
    };
    view.C2C_AUTH_TIMEOUT_MS = 40;
    view.C2C_SMOKE_PLAN = [{ kind: 'session', label: 'session bootstrap', method: 'GET', path: '/' }];
    view.C2C_SMOKE_PROJECT = '1001';
    let hang = true;
    view.fetch = ((input: unknown) => {
      const url = urlOf(input);
      if (/\/project-user\/(?:current|token)(?:[/?#]|$)/.test(url)) {
        if (hang) return new Promise(() => {});
        return Promise.resolve(reply(200, { user_id: '1' }));
      }
      return Promise.resolve(reply(401, { error: 'authenticated caller required' }));
    }) as unknown as typeof fetch;
    view.catalyst = {
      auth: {
        isUserAuthenticated: async () => ({}),
        generateAuthToken: async () => {
          await (view.fetch as (input: string) => Promise<unknown>)(CURRENT);
          return { access_token: 'token' };
        },
      },
    };
    const section = view.document.createElement('section');
    section.innerHTML = '<p data-smoke-state="pending">Checking access…</p><table hidden><tbody data-smoke-steps></tbody></table><pre id="c2c-smoke-json" hidden></pre>';
    view.document.body.appendChild(section);
    const started = Date.now();
    compiled.smoke.mountSmoke(section, {}, view);
    await until(() => section.querySelector('[data-smoke-state]')?.getAttribute('data-smoke-state') === 'failed', 'react smoke stall');
    assert.ok(Date.now() - started < 1500);
    assert.equal(section.querySelector('[data-smoke-state]')?.textContent, STALL);
    assert.ok(section.querySelector('[data-smoke-retry]'));
    for (const entry of logs) assert.notEqual(entry.trim(), 't');
    hang = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
    (section.querySelector('[data-smoke-retry]') as HTMLButtonElement).click();
    await until(() => section.querySelector('[data-smoke-state]')?.getAttribute('data-smoke-state') === 'not-signed-in', 'react smoke retry');
    view.close();
  } finally {
    rmSync(compiled.dir, { recursive: true, force: true });
  }
});
