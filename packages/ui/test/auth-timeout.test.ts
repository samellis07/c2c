/**
 * A current-user call that never answers must not leave sign-in or the smoke
 * page spinning. The budget is short here so a removed timeout fails the test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { UiModel } from '../src/index.js';

const STALL =
  'Sign-in did not complete. Reload the page; if it keeps happening, the app administrator must finish setup step 3, "Sign in once: sign in to the deployed app once".';
const CURRENT = 'https://slate.example/baas/v1/project/1001/project-user/current';

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
}

async function loadRuntime(): Promise<Runtime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return (await import(url)) as Runtime;
}

const model = { name: 'Widget', nav: [], forms: [], reports: [], pages: [] } as unknown as UiModel;

function polyfillCss(): void {
  (globalThis as { CSS?: { escape(value: string): string } }).CSS ??= { escape: (value: string) => value };
}

interface Reply {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function reply(status: number, data: unknown = {}): Reply {
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

interface Harness {
  doc: Document;
  view: Window & Record<string, unknown> & { close(): void };
  logs: string[];
}

function harness(hash = ''): Harness {
  const dom = new JSDOM('<!doctype html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><div id="c2c-login" hidden></div><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html',
  });
  const view = dom.window as unknown as Window & Record<string, unknown>;
  if (hash) view.location.hash = hash;
  const logs: string[] = [];
  const sink = view.console as { error: (...args: unknown[]) => void };
  sink.error = (...args: unknown[]) => {
    logs.push(args.map((part) => String(part)).join(' '));
  };
  view.C2C_AUTH_TIMEOUT_MS = 40;
  view.C2C_LOGIN_WAIT_MS = 60_000;
  return { doc: view.document, view: view as Harness['view'], logs };
}

async function until(ready: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1500) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} did not settle within 1500ms`);
}

test('a never-resolving current-user fetch shows the stall message and Retry signs in', async () => {
  polyfillCss();
  const runtime = await loadRuntime();
  const { doc, view, logs } = harness();
  let hang = true;
  let signal: AbortSignal | undefined;
  view.fetch = ((input: unknown, init?: { signal?: AbortSignal }) => {
    const url = urlOf(input);
    if (/\/project-user\/(?:current|token)(?:[/?#]|$)/.test(url)) {
      signal = init?.signal;
      if (hang) return new Promise(() => {});
      return Promise.resolve(reply(200, { user_id: '1' }));
    }
    return Promise.resolve(reply(401));
  }) as unknown as typeof fetch;
  view.catalyst = {
    auth: {
      isUserAuthenticated: () => (view.fetch as (input: string) => Promise<unknown>)(CURRENT),
      signIn() {},
      generateAuthToken: async () => ({ access_token: 'token' }),
    },
  };
  // Deadline timer first, fetch-abort timer second, same delay. Hold the second
  // back: Node 20 can paint the stall before that later timer aborts the fetch.
  const nativeSetTimeout = view.setTimeout.bind(view);
  let scheduled = 0;
  view.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    scheduled += 1;
    const delay = scheduled === 2 ? Number(timeout ?? 0) + 1000 : timeout;
    return nativeSetTimeout(handler, delay, ...args);
  }) as typeof view.setTimeout;
  const started = Date.now();
  await runtime.boot(model, doc);
  await until(() => doc.querySelector('[data-sign-in-retry]') != null, 'sign-in stall');
  assert.ok(Date.now() - started < 1500, 'the stall arrived inside the auth budget');
  const line = doc.querySelector('[data-sign-in-error]');
  assert.equal(line?.textContent, STALL);
  assert.equal(line?.getAttribute('role'), 'alert');
  assert.equal(doc.querySelector('[data-sign-in]')?.textContent ?? null, null, 'a stall is not the ordinary sign-in prompt');
  assert.equal(signal?.aborted, true, 'the hung current-user fetch is aborted');
  assert.ok(logs.length > 0, 'the failure is logged');
  for (const entry of logs) {
    assert.notEqual(entry.trim(), 't');
    assert.match(entry, /Sign-in did not complete/);
  }
  hang = false;
  (doc.querySelector('[data-sign-in-retry]') as HTMLButtonElement).click();
  await until(() => (doc.getElementById('c2c-login') as HTMLElement).hidden === true, 'retry sign-in');
  view.close();
});

test("a minified 't' from the current-user call is logged as a sentence", async () => {
  polyfillCss();
  const runtime = await loadRuntime();
  const { doc, view, logs } = harness();
  view.fetch = (async (input: unknown) => {
    if (/\/project-user\/(?:current|token)(?:[/?#]|$)/.test(urlOf(input))) throw new Error('t');
    return reply(401);
  }) as unknown as typeof fetch;
  view.catalyst = {
    auth: {
      isUserAuthenticated: () => (view.fetch as (input: string) => Promise<unknown>)(CURRENT),
      signIn() {},
    },
  };
  await runtime.boot(model, doc);
  await until(() => doc.querySelector('[data-sign-in-retry]') != null, 'minified stall');
  assert.equal(doc.querySelector('[data-sign-in-error]')?.textContent, STALL);
  assert.ok(logs.length > 0);
  for (const entry of logs) assert.notEqual(entry.trim(), 't');
  assert.ok(logs.some((entry) => entry.includes('Sign-in did not complete')));
  view.close();
});

test('a resolved 401 still shows the sign-in prompt', async () => {
  polyfillCss();
  const runtime = await loadRuntime();
  const { doc, view } = harness();
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
  await runtime.boot(model, doc);
  await until(() => doc.querySelector('[data-sign-in]') != null, 'signed-out prompt');
  assert.equal(doc.querySelector('[data-sign-in]')?.textContent, 'Sign in to continue.');
  assert.equal(doc.querySelector('[data-sign-in-retry]'), null);
  assert.equal((doc.getElementById('c2c-login') as HTMLElement).hidden, false);
  view.close();
});

test('the smoke page fails the run when current-user never answers, and Retry clears the stall', async () => {
  polyfillCss();
  const runtime = await loadRuntime();
  const { doc, view, logs } = harness('#/admin/smoke');
  let hang = true;
  view.C2C_SMOKE_PLAN = [{ kind: 'session', label: 'session bootstrap', method: 'GET', path: '/' }];
  view.C2C_SMOKE_PROJECT = '1001';
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
  const started = Date.now();
  await runtime.boot(model, doc);
  await until(() => doc.querySelector('[data-smoke-state]')?.getAttribute('data-smoke-state') === 'failed', 'smoke stall');
  assert.ok(Date.now() - started < 1500, 'the smoke page left the spinner inside the auth budget');
  const state = doc.querySelector('[data-smoke-state]');
  assert.equal(state?.textContent, STALL);
  assert.doesNotMatch(state?.textContent ?? '', /Running the smoke contract/);
  assert.ok(doc.querySelector('[data-smoke-retry]'));
  for (const entry of logs) assert.notEqual(entry.trim(), 't');
  hang = false;
  await new Promise((resolve) => setTimeout(resolve, 0));
  (doc.querySelector('[data-smoke-retry]') as HTMLButtonElement).click();
  await until(() => doc.querySelector('[data-smoke-state]')?.getAttribute('data-smoke-state') === 'not-signed-in', 'smoke retry');
  assert.match(doc.querySelector('[data-smoke-state]')?.textContent ?? '', /Not signed in/);
  view.close();
});
