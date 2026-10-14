import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { UiModel } from '../src/index.js';

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
}

async function loadRuntime(): Promise<Runtime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return (await import(url)) as Runtime;
}

const model = {
  name: 'Runtime Test',
  nav: [
    {
      name: 'Menu',
      hidden: false,
      items: [
        { kind: 'form', name: 'F', label: 'F', href: '#/form/F' },
        { kind: 'report', name: 'R', label: 'R', href: '#/report/R' },
      ],
    },
  ],
  pages: [],
  forms: [
    {
      name: 'F',
      label: 'F',
      submitEndpoint: '/forms/F/submit',
      recordEndpoint: '/forms/F/record',
      deleteEndpoint: '/forms/F/delete',
      successMessage: 'Test Item Added Successfully!',
      handlers: [],
      fields: [
        { name: 'Item_Name', label: 'Item Name', widget: 'text', required: false, readonly: false, unique: false, status: 'generated', scan: false },
        {
          name: 'Is_Urgent',
          label: 'Is Urgent',
          widget: 'multiselect',
          matrixId: 'checkbox-multi',
          choices: ['Yes', 'No'],
          required: false,
          readonly: false,
          unique: false,
          status: 'generated',
          scan: false,
        },
        { name: 'Approved', label: 'Approved', widget: 'decision', required: false, readonly: false, unique: false, status: 'generated', scan: false },
      ],
    },
  ],
  reports: [
    {
      name: 'R',
      label: 'R',
      status: 'generated',
      view: 'list',
      queryEndpoint: '/reports/R',
      pageSize: 300,
      columns: [
        { field: 'Item_Name', label: 'Item Name' },
        { field: 'Is_Urgent', label: 'Is Urgent' },
      ],
      filters: [],
      sort: [],
      groupBy: [],
      customActions: [],
      detail: false,
    },
  ],
} as unknown as UiModel;

interface Call {
  url: string;
  body: Record<string, unknown>;
}

interface DomWindow {
  document: Document;
  fetch: typeof fetch;
  Event: typeof Event;
}

function setup(hash: string, options: { submitOk: boolean; rows?: unknown[] }) {
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: `http://localhost/slate/index.html${hash}`,
  }).window as unknown as DomWindow;
  const calls: Call[] = [];
  win.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    if (body.op === 'query') return { ok: true, status: 200, json: async () => ({ rows: options.rows ?? [] }) };
    return { ok: options.submitOk, status: options.submitOk ? 200 : 500, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { win, doc: win.document, calls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('runtime renders checkbox groups as checkbox inputs and submits the checked values', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const { win, doc, calls } = setup('#/form/F', { submitOk: true });
  await runtime.boot(model, doc);
  const form = doc.querySelector('form[data-form="F"]') as HTMLFormElement;
  assert.ok(form, 'form rendered');
  assert.equal(doc.querySelector('select[name="Is_Urgent"]'), null, 'no multi-select for a checkbox group');
  const boxes = form.querySelectorAll('input[type="checkbox"][name="Is_Urgent"]');
  assert.deepEqual(
    Array.from(boxes).map((b) => (b as HTMLInputElement).value),
    ['Yes', 'No'],
  );
  (form.querySelector('input[name="Item_Name"]') as HTMLInputElement).value = 'Widget Alpha';
  (form.querySelector('input[name="Is_Urgent"][value="Yes"]') as HTMLInputElement).checked = true;
  form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  const post = calls.find((c) => c.url === '/forms/F/submit');
  assert.ok(post, 'submit posted');
  assert.deepEqual((post.body.record as Record<string, unknown>).Is_Urgent, ['Yes']);
});

test('checkbox group with multiple choices checked submits all choices once', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const { win, doc, calls } = setup('#/form/F', { submitOk: true });
  await runtime.boot(model, doc);
  const form = doc.querySelector('form[data-form="F"]') as HTMLFormElement;
  (form.querySelector('input[name="Item_Name"]') as HTMLInputElement).value = 'Widget Beta';
  (form.querySelector('input[name="Is_Urgent"][value="Yes"]') as HTMLInputElement).checked = true;
  (form.querySelector('input[name="Is_Urgent"][value="No"]') as HTMLInputElement).checked = true;
  form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  const post = calls.find((c) => c.url === '/forms/F/submit');
  assert.ok(post, 'submit posted');
  assert.deepEqual((post.body.record as Record<string, unknown>).Is_Urgent, ['Yes', 'No']);
});

test('checkbox group with no choices checked submits empty array', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const { win, doc, calls } = setup('#/form/F', { submitOk: true });
  await runtime.boot(model, doc);
  const form = doc.querySelector('form[data-form="F"]') as HTMLFormElement;
  (form.querySelector('input[name="Item_Name"]') as HTMLInputElement).value = 'Widget Gamma';
  form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  const post = calls.find((c) => c.url === '/forms/F/submit');
  assert.ok(post, 'submit posted');
  assert.deepEqual((post.body.record as Record<string, unknown>).Is_Urgent, []);
});

test('decision box on same form as checkbox group still submits boolean', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const { win, doc, calls } = setup('#/form/F', { submitOk: true });
  await runtime.boot(model, doc);
  const form = doc.querySelector('form[data-form="F"]') as HTMLFormElement;
  (form.querySelector('input[name="Item_Name"]') as HTMLInputElement).value = 'Widget Delta';
  (form.querySelector('input[name="Is_Urgent"][value="Yes"]') as HTMLInputElement).checked = true;
  (form.querySelector('input[name="Approved"]') as HTMLInputElement).checked = true;
  form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  const post = calls.find((c) => c.url === '/forms/F/submit');
  assert.ok(post, 'submit posted');
  assert.deepEqual((post.body.record as Record<string, unknown>).Is_Urgent, ['Yes']);
  assert.equal((post.body.record as Record<string, unknown>).Approved, true);
});

test('a successful submit writes the form success message to the banner', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const { win, doc } = setup('#/form/F', { submitOk: true });
  await runtime.boot(model, doc);
  const form = doc.querySelector('form[data-form="F"]') as HTMLFormElement;
  (form.querySelector('input[name="Item_Name"]') as HTMLInputElement).value = 'Widget Alpha';
  form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  assert.equal(doc.querySelector('[data-banner]')?.textContent, 'Test Item Added Successfully!');
});

test('a failed submit says the record was not saved instead of reporting success', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const { win, doc } = setup('#/form/F', { submitOk: false });
  await runtime.boot(model, doc);
  const form = doc.querySelector('form[data-form="F"]') as HTMLFormElement;
  (form.querySelector('input[name="Item_Name"]') as HTMLInputElement).value = 'Widget Alpha';
  form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
  assert.equal(doc.querySelector('[data-banner]')?.textContent, 'The record was not saved.');
});

interface AuthWindow extends DomWindow {
  catalyst: { auth: unknown };
  C2C_LOGIN_WAIT_MS?: number;
}

function authDom(auth: unknown, url = 'http://localhost/slate/index.html'): { win: AuthWindow; doc: Document } {
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><div id="c2c-login" hidden></div><main id="main"></main></body>', {
    url,
  }).window as unknown as AuthWindow;
  win.catalyst = { auth };
  win.C2C_LOGIN_WAIT_MS = 0;
  return { win, doc: win.document };
}

test('a signed-out visitor sees a clear sign-in prompt and the SDK gets the box', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const signIns: [string, unknown][] = [];
  const { doc } = authDom({
    isUserAuthenticated: async () => {
      throw new Error('no session');
    },
    signIn: (elementId: string, config?: unknown) => {
      signIns.push([elementId, config]);
      doc.getElementById(elementId)?.appendChild(doc.createElement('iframe'));
    },
  });
  await runtime.boot(model, doc);
  await settle();
  const login = doc.getElementById('c2c-login')!;
  assert.equal(login.hidden, false, 'the sign-in box shows when there is no session');
  // service_url returns the signed-in user to the app, not a missing page.
  assert.deepEqual(signIns, [['c2c-login', { service_url: '/slate/index.html' }]]);
  assert.equal(login.querySelector('[data-sign-in]')?.textContent, 'Sign in to continue.');
  // The frame mounted, so the only message is the blank-frame hint — no error.
  await settle();
  assert.equal(login.querySelector('[data-sign-in-error]'), null);
  assert.match(login.querySelector('[data-sign-in-hint]')?.textContent ?? '', /iFrame/);
});

test('service_url stays on this origin even when the page path starts with // or /\\', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  // A path of "//evil.example/" (or "/\evil.example/", which the URL parser
  // reads the same way) must not reach the SDK verbatim — the SDK resolves it
  // against the page, where it would point at another host.
  for (const [path, want] of [
    ['//evil.example/', '/evil.example/'],
    ['/\\evil.example/', '/evil.example/'],
    ['//evil.example', '/evil.example'],
    ['/', '/'],
  ] as const) {
    const signIns: [string, unknown][] = [];
    const { win } = authDom(
      {
        isUserAuthenticated: async () => {
          throw new Error('no session');
        },
        signIn: (elementId: string, config?: unknown) => {
          signIns.push([elementId, config]);
        },
      },
      `http://localhost${path}`,
    );
    await runtime.boot(model, win.document);
    await settle();
    const serviceUrl = (signIns[0]?.[1] as { service_url?: string } | undefined)?.service_url;
    assert.ok(serviceUrl, `${path}: signIn ran`);
    assert.equal(serviceUrl, want, path);
    assert.equal(new URL(serviceUrl, 'http://localhost').origin, 'http://localhost', `${path}: ${serviceUrl}`);
  }
});

test('service_url stays on this origin even when the path decodes to a different host', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  // A percent-encoded path can still reach the sign-in return: the SDK hands
  // service_url to a server that may decode it once, and one decode turns
  // "/%2Fevil.example" into "//evil.example" — a protocol-relative URL. The
  // same trick works through extra encoding layers: "%2509" decodes to a tab,
  // which the URL parser strips, leaving "//evil.example". Every value the SDK
  // gets must stay on this origin as sent and through every decode.
  for (const [path, want] of [
    ['/%2Fevil.example', '/'],
    ['/%2F%2Fevil.example/', '/'],
    ['/%2f%5Cevil.example', '/'],
    ['/%5C%5Cevil.example', '/'],
    ['/%09/evil.example', '/'],
    ['/%0A/evil.example', '/'],
    ['/%2509/evil.example', '/'],
    ['/%250A/evil.example', '/'],
    ['/%250d/evil.example', '/'],
    ['/%25250A/evil.example', '/'],
    ['/%2500/evil.example', '/'],
    ['/%7F/x', '/'],
    ['/%252F%252Fevil.example', '/'],
    // Still changing after the last decode pass — a later decode would expose
    // the off-origin form, so the value is refused rather than trusted.
    ['/%2525250A/evil.example', '/'],
    ['/%2525252F%2525252Fevil.example', '/'],
    ['/\t/evil.example', '/evil.example'],
    ['/\n/evil.example', '/evil.example'],
    ['/./%2e/%2E%2E//evil.example', '/evil.example'],
    ['/#//evil.example', '/#//evil.example'],
    ['/x?service_url=//evil.example#/r', '/x#/r'],
    ['/slate/index.html#/form/F', '/slate/index.html#/form/F'],
    // Ordinary routes keep their path, hyphens included.
    ['/my-app/index.html', '/my-app/index.html'],
    ['/slate/index.html#/form/order-items', '/slate/index.html#/form/order-items'],
    ['/xn--80ak6aa92e.com/', '/xn--80ak6aa92e.com/'],
  ] as const) {
    const signIns: [string, unknown][] = [];
    const { win } = authDom(
      {
        isUserAuthenticated: async () => {
          throw new Error('no session');
        },
        signIn: (elementId: string, config?: unknown) => {
          signIns.push([elementId, config]);
        },
      },
      `http://localhost${path}`,
    );
    await runtime.boot(model, win.document);
    await settle();
    const serviceUrl = (signIns[0]?.[1] as { service_url?: string } | undefined)?.service_url;
    assert.ok(serviceUrl, `${JSON.stringify(path)}: signIn ran`);
    assert.equal(serviceUrl, want, JSON.stringify(path));
    const origin = 'http://localhost';
    let decoded: string = serviceUrl;
    for (let i = 0; i <= 4; i++) {
      assert.equal(
        new URL(decoded, origin).origin,
        origin,
        `${JSON.stringify(path)}: decode ${i} of ${serviceUrl}`,
      );
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  }
});

test('a sign-in frame that never mounts leaves a visible failure message and a hosted-login link', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const { doc } = authDom({
    isUserAuthenticated: async () => {
      throw new Error('no session');
    },
    signIn: () => {
      // The SDK mounted no frame — the box cannot stay silent about it.
    },
  });
  await runtime.boot(model, doc);
  await settle();
  const login = doc.getElementById('c2c-login')!;
  assert.equal(login.hidden, false);
  assert.match(login.querySelector('[data-sign-in]')?.textContent ?? '', /Sign in/);
  assert.match(login.querySelector('[data-sign-in-error]')?.textContent ?? '', /could not load/);
  const link = login.querySelector('a');
  assert.match(link?.getAttribute('href') ?? '', /^\/__catalyst\/auth\/login\?service_url=/);
  assert.match(link?.getAttribute('href') ?? '', /service_url=http%3A%2F%2Flocalhost%2Fslate%2Findex\.html/);
});

test('a report route fills its table body with the rows the query returns', async () => {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const runtime = await loadRuntime();
  const rows = [
    { Item_Name: 'Widget Alpha', Is_Urgent: 'Yes' },
    { Item_Name: 'Widget Beta', Is_Urgent: '' },
  ];
  const { doc, calls } = setup('#/report/R', { submitOk: true, rows });
  await runtime.boot(model, doc);
  await settle();
  const trs = Array.from(doc.querySelectorAll('[data-rows] tbody tr'));
  assert.equal(trs.length, 2);
  assert.deepEqual(
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent)),
    [
      ['Widget Alpha', 'Yes'],
      ['Widget Beta', ''],
    ],
  );
  assert.ok(calls.some((c) => c.url === '/reports/R' && c.body.op === 'query'));
});

