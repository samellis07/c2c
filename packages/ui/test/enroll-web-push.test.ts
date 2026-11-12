/**
 * After sign-in, a push-sending app enrolls the user and opens the payload view.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { UiModel } from '../src/index.js';
import { slateConfigSource } from '../src/generate.js';

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
  enrollWebPush(view: Window): void;
}

async function loadRuntime(): Promise<Runtime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return (await import(url)) as Runtime;
}

const model = { name: 'Notifier', nav: [], forms: [], reports: [], pages: [] } as unknown as UiModel;

function polyfillCss(): void {
  (globalThis as { CSS?: { escape(value: string): string } }).CSS ??= { escape: (value: string) => value };
}

function harness(): { doc: Document; view: Window & Record<string, unknown> & { close(): void } } {
  const dom = new JSDOM('<!doctype html><body><header><strong id="app-title"></strong></header><nav id="nav"></nav><div id="c2c-login" hidden></div><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html',
  });
  const view = dom.window as unknown as Window & Record<string, unknown> & { close(): void };
  return { doc: view.document, view };
}

async function until(ready: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1500) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${label} did not settle within 1500ms`);
}

test('slateConfigSource sets C2C_SENDS_PUSH only when the app sends a push', () => {
  assert.match(slateConfigSource({ sendsPush: true }), /globalThis\.C2C_SENDS_PUSH = true;/);
  assert.doesNotMatch(slateConfigSource({}), /C2C_SENDS_PUSH/);
});

test('a signed-in push app enrolls and opens the payload report', async () => {
  polyfillCss();
  const runtime = await loadRuntime();
  const { doc, view } = harness();
  view.C2C_SENDS_PUSH = true;
  const enrolled: unknown[] = [];
  let handler: ((payload: unknown) => void) | undefined;
  view.catalyst = {
    auth: {
      isUserAuthenticated: async () => ({}),
      signIn() {},
    },
    notification: {
      enableNotification: async () => {
        enrolled.push('ok');
      },
      messageHandler(next: (payload: unknown) => void) {
        handler = next;
      },
    },
  };
  await runtime.boot(model, doc);
  await until(() => enrolled.length > 0, 'enableNotification');
  assert.equal(enrolled.length, 1);
  assert.ok(handler);
  handler!({ view: 'Recent_Incidents', recordid: '9' });
  assert.equal(view.location.hash, '#/report/Recent_Incidents/row/9');
  view.close();
});

test('a quiet app does not enroll', async () => {
  polyfillCss();
  const runtime = await loadRuntime();
  const { doc, view } = harness();
  const enrolled: unknown[] = [];
  view.catalyst = {
    auth: {
      isUserAuthenticated: async () => ({}),
      signIn() {},
    },
    notification: {
      enableNotification: async () => {
        enrolled.push('ok');
      },
    },
  };
  await runtime.boot(model, doc);
  await until(() => (doc.getElementById('c2c-login') as HTMLElement).hidden === true, 'signed-in');
  assert.equal(enrolled.length, 0);
  view.close();
});
