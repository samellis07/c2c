import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, clientRuntimeSource, type UiModel } from '../src/index.js';

// The translation block's `.ds` shape, verbatim: `translation` + a JSON body
// of language → Creator label key → text (with the non-string
// `Language Properties` entry real exports carry).
function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

const FORM = `\tform Contact
\t{
\t\tdisplayname = "Contact"
\t\tName
\t\t(
\t\t\ttype = text
\t\t\tdisplayname = "Name"
\t\t)
\t}`;

const TRANSLATION = (label: string) => `\ttranslation
\t{
{"de":{"Form.Contact":" Kontakt ","FormField.Contact.Name":" ${label} ","Languages List.de":" Deutsch ","Languages List.en":" Englisch ","Language Properties":{"Status":true,"Auto Translate":false,"Direction":0}}}
\t}`;

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
}

async function booted(model: UiModel, url: string, t: { after: (fn: () => void) => void }): Promise<Document> {
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main></body>', { url }).window as unknown as {
    document: Document;
  };
  const globals = globalThis as { model?: UiModel; document?: Document; CSS?: unknown };
  globals.CSS ??= { escape: (s: string) => s };
  globals.model = model;
  globals.document = win.document;
  t.after(() => {
    delete globals.model;
    delete globals.document;
  });
  const runtime = (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as Runtime;
  await runtime.boot(model, win.document);
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  return win.document;
}

test('translation blocks land on the model i18n table as data-only strings', () => {
  const model = buildUi(appOf(`${FORM}\n${TRANSLATION('Name')}`)).model;
  assert.equal(model.i18n?.de?.['Form.Contact'], ' Kontakt ');
  assert.equal(model.i18n?.de?.['FormField.Contact.Name'], ' Name ');
  // The non-string `Language Properties` entry does not migrate.
  assert.equal(model.i18n?.de?.['Language Properties'], undefined);
});

test('the selected language renders translated labels; default stays without a pick', async (t) => {
  const model = buildUi(appOf(`${FORM}\n${TRANSLATION('Name')}`)).model;
  const doc = await booted(model, 'http://localhost/slate/index.html?lang=de#/form/Contact', t);
  const card = doc.querySelector('section[data-form-card]');
  assert.match(card?.querySelector('h1')?.textContent ?? '', /Kontakt/);
  assert.match(card?.querySelector('label')?.textContent ?? '', /Name/);
  // The nav carries the language switch with the URL pick selected.
  const picker = doc.querySelector('select[data-i18n-lang]');
  assert.ok(picker, 'the nav shows the language switch');
  const selected = picker?.querySelector('option[selected]');
  assert.equal(selected?.getAttribute('value'), 'de');
});

test('without a selected language the app keeps the default wording and still offers the switch', async (t) => {
  const model = buildUi(appOf(`${FORM}\n${TRANSLATION('Name')}`)).model;
  const doc = await booted(model, 'http://localhost/slate/index.html#/form/Contact', t);
  const card = doc.querySelector('section[data-form-card]');
  assert.equal(card?.querySelector('h1')?.textContent, 'Contact');
  assert.equal(card?.querySelector('label')?.textContent?.trim(), 'Name');
  assert.ok(doc.querySelector('select[data-i18n-lang]'), 'the switch is offered even in the default language');
});

test('a translation string is data-only: markup renders as text, never HTML', async (t) => {
  const model = buildUi(appOf(`${FORM}\n${TRANSLATION('<img src=x onerror=alert(1)>')}`)).model;
  const doc = await booted(model, 'http://localhost/slate/index.html?lang=de#/form/Contact', t);
  const card = doc.querySelector('section[data-form-card]');
  const label = card?.querySelector('label');
  assert.match(label?.textContent ?? '', /<img src=x onerror=alert\(1\)>/);
  assert.equal(card?.querySelector('img'), null, 'the string renders as text, not an element');
  assert.match(label?.innerHTML ?? '', /&lt;img/, 'the markup is escaped in the rendered HTML');
});
