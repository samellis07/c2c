import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, clientRuntimeSource, type UiModel } from '../src/index.js';

// The served page evaluates the whole client runtime as one script with the
// page model and the document already defined. Every part of the runtime must
// tolerate being appended after another part: a part that installs at load
// cannot call into a later part whose top-level state is not initialized yet.

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = ''): string {
  return `\t\t${name}\n\t\t(\n\t\t\ttype = ${type}${extra ? `\n${extra}` : ''}\n\t\t)`;
}

const TEMPLATE_CONTENT = JSON.stringify({
  version: '2',
  mainLayout: [
    { id: 1, elements: [{ type: 'text', element: { id: 'e1', content: '<div><p>${Name}</p></div>' } }] },
  ],
});

const FORM = `\tform Contact
\t{
${field('Name', 'text')}
${field('Email', 'email')}
\t\tprint template
\t\t{
\t\t\tCard
\t\t\t{
\t\t\t\tdisplayname = "Contact Card"
\t\t\t\tcontent = ${TEMPLATE_CONTENT}
\t\t\t}
\t\t}
\t}`;

const REPORT = `\tlist All_Contacts
\t{
\t\tprint template = Card
\t\tshow all rows from Contact
\t\t(
\t\t\tName
\t\t\tEmail
\t\t)
\t}`;

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
}

test('the client runtime evaluates and boots with the page model and document defined', async (t) => {
  const model = buildUi(appOf(`${FORM}\n${REPORT}`)).model;
  const rows = [{ ROWID: '7', Name: 'Ada Lovelace', Email: 'ada@example.test' }];
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', {
    url: 'http://localhost/slate/index.html#/report/All_Contacts/row/7',
  }).window as unknown as { document: Document; fetch: typeof fetch };
  win.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body.op === 'query') return { ok: true, status: 200, json: async () => ({ rows }) };
    if (body.ROWID) return { ok: true, status: 200, json: async () => ({ record: rows[0] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const globals = globalThis as { model?: UiModel; document?: Document; CSS?: unknown };
  globals.CSS ??= { escape: (s: string) => s };
  globals.model = model;
  globals.document = win.document;
  t.after(() => {
    delete globals.model;
    delete globals.document;
  });

  let runtime: Runtime;
  try {
    const source = clientRuntimeSource();
    runtime = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
  } catch (err) {
    assert.fail(`the client runtime did not evaluate: ${(err as Error).message}`);
  }
  await runtime.boot(model, win.document);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const doc = win.document;
  assert.ok(doc.querySelector('section[data-report]'), 'boot renders the report section');
  const button = doc.querySelector('[data-print-record]');
  assert.ok(button, 'the record view offers a Print button');
  (button as HTMLElement).dispatchEvent(new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const sheet = doc.querySelector('[data-print-sheet]');
  assert.ok(sheet, 'the print sheet opens from the record view');
  assert.match(sheet?.textContent ?? '', /Ada Lovelace/);
});
