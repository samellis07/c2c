/**
 * The vanilla client asks the browser for its position on submit only for a
 * form whose reports list Added_Location / Modified_Location, and posts it
 * beside the record as `geo`. Denied, unavailable and non-finite positions
 * leave `geo` out and the submit still goes ahead.
 */
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
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
}

const field = { label: 'Item Name', widget: 'text', required: false, readonly: false, unique: false, status: 'generated', scan: false };

function model(capturesLocation: boolean): UiModel {
  return {
    name: 'Geo',
    nav: [],
    pages: [],
    forms: [
      {
        name: 'F',
        label: 'F',
        submitEndpoint: '/forms/F/submit',
        recordEndpoint: '/forms/F/record',
        deleteEndpoint: '/forms/F/delete',
        ...(capturesLocation ? { capturesLocation: true } : {}),
        handlers: [],
        fields: [{ name: 'Item_Name', ...field }],
      },
    ],
    reports: [],
  } as unknown as UiModel;
}

type Geo = { getCurrentPosition(ok: (p: { coords: { latitude: number; longitude: number } }) => void, fail: (e: unknown) => void, opts?: unknown): void };

async function submit(capturesLocation: boolean, geolocation: Geo | undefined): Promise<{ posted: Record<string, unknown>[] }> {
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main><div id="toasts"></div></body>', {
    url: 'http://localhost/slate/index.html#/form/F',
  }).window as unknown as { document: Document; navigator: Navigator; fetch: unknown; Event: typeof Event };
  if (geolocation) Object.defineProperty(win.navigator, 'geolocation', { value: geolocation, configurable: true });
  const posted: Record<string, unknown>[] = [];
  win.fetch = async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body) as Record<string, unknown>);
    return { ok: true, status: 200, json: async () => ({ dryRun: false, wrote: true }) };
  };
  const runtime = await loadRuntime();
  await runtime.boot(model(capturesLocation), win.document);
  const form = win.document.querySelector('form[data-form="F"]') as HTMLFormElement;
  (form.querySelector('input[name="Item_Name"]') as HTMLInputElement).value = 'Widget';
  form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { posted };
}

test('a granted position rides beside the record as geo', async () => {
  const { posted } = await submit(true, { getCurrentPosition: (ok) => ok({ coords: { latitude: 12.5, longitude: 77.25 } }) });
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0]!.geo, { latitude: 12.5, longitude: 77.25 });
  assert.equal(Object.hasOwn(posted[0]!.record as object, 'Added_Location_latitude'), false);
});

test('denied, absent and non-finite positions leave geo out and still submit', async () => {
  for (const geolocation of [
    { getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail({ code: 1 }) },
    { getCurrentPosition: () => { throw new Error('blocked'); } },
    { getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number } }) => void) => ok({ coords: { latitude: Number.NaN, longitude: 1 } }) },
    undefined,
  ] as (Geo | undefined)[]) {
    const { posted } = await submit(true, geolocation);
    assert.equal(posted.length, 1);
    assert.equal(Object.hasOwn(posted[0]!, 'geo'), false);
  }
});

test('a form no report stamps never asks the browser', async () => {
  let asked = 0;
  const { posted } = await submit(false, { getCurrentPosition: (ok) => { asked += 1; ok({ coords: { latitude: 1, longitude: 2 } }); } });
  assert.equal(asked, 0);
  assert.equal(Object.hasOwn(posted[0]!, 'geo'), false);
});
