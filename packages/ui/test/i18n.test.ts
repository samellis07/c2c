import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

const SETTINGS = (value: string) => `\ttranslation
\t{
{"Language_Settings":{"LANGAGUE_WITH_LOGIN":"${value}"}}
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

test('a __proto__ language and prototype-named keys stay own data, never pollute', () => {
  const block = `\ttranslation
\t{
{"__proto__":{"Form.Contact":"Proto Contact","constructor":"ctor","toString":"str","hasOwnProperty":"hop"}}
\t}`;
  const model = buildUi(appOf(`${FORM}\n${block}`)).model;
  const i18n = model.i18n as Record<string, Record<string, string>>;
  // `__proto__` is a language code like any other: an own entry, not a
  // prototype write that would vanish from Object.keys.
  assert.ok(Object.hasOwn(i18n, '__proto__'), 'the __proto__ language is an own i18n entry');
  assert.equal(Object.getPrototypeOf(i18n), null, 'the i18n table has no prototype');
  const table = i18n['__proto__']!;
  assert.equal(Object.getPrototypeOf(table), null, 'the language table has no prototype');
  assert.equal(table['Form.Contact'], 'Proto Contact');
  assert.equal(table['constructor'], 'ctor', 'constructor is stored as a string, not the inherited function');
  assert.equal(table['toString'], 'str');
  assert.equal(table['hasOwnProperty'], 'hop');
  // Building the table must not have written onto Object.prototype.
  assert.equal(({} as Record<string, unknown>)['Form.Contact'], undefined, 'Object.prototype is unpolluted');
  assert.equal(typeof ({} as Record<string, unknown>).toString, 'function');
});

test('inherited names are not reachable through strings[key]: a constructor key leaves the default text', async (t) => {
  const block = `\ttranslation
\t{
{"de":{"constructor":"ctor","Form.Contact":"Kontakt"}}
\t}`;
  const model = buildUi(appOf(`${FORM}\n${block}`)).model;
  const i18n = model.i18n as Record<string, unknown>;
  const table = model.i18n?.de as Record<string, string>;
  assert.equal(table['constructor'], 'ctor');
  // Inherited names are not reachable through `map[name]`: a language or key
  // the block did not declare resolves to undefined, not a prototype member.
  assert.equal(i18n['toString'], undefined, 'toString is not an i18n language');
  assert.equal(table['toString'], undefined, 'toString is not a stored label');
  assert.equal(table['hasOwnProperty'], undefined, 'hasOwnProperty is not a stored label');
  // A key the block did not translate — including an inherited name —
  // resolves to nothing, so the field keeps its default text.
  const doc = await booted(model, 'http://localhost/slate/index.html?lang=de#/form/Contact', t);
  const card = doc.querySelector('section[data-form-card]');
  assert.equal(card?.querySelector('h1')?.textContent, 'Kontakt');
  assert.equal(card?.querySelector('label')?.textContent?.trim(), 'Name');
  assert.equal(({} as Record<string, unknown>).constructor, Object, 'Object.prototype is unpolluted after applyLanguage');
});

test('the Language_Settings block lands on the model as languageWithLogin', () => {
  const model = buildUi(appOf(`${FORM}\n${TRANSLATION('Name')}\n${SETTINGS('browser')}`)).model;
  assert.equal(model.languageWithLogin, 'browser');
  // No Language_Settings block → no setting on the model.
  const plain = buildUi(appOf(`${FORM}\n${TRANSLATION('Name')}`)).model;
  assert.equal(plain.languageWithLogin, undefined);
});

test('the browser setting follows the visitor browser language list when nothing is picked', async () => {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client/10-i18n.js')).href)) as {
    i18nSelectedLanguage: (model: unknown, view: unknown) => string;
  };
  const model = { i18n: { de: {}, fr: {} }, languageWithLogin: 'browser' };
  const view = (extra: Record<string, unknown>) => ({ location: { search: '' }, localStorage: { getItem: () => null }, ...extra });
  // An exact code wins; otherwise the base subtag matches a migrated language.
  assert.equal(mod.i18nSelectedLanguage(model, view({ navigator: { languages: ['fr-CA', 'de'], language: 'fr-CA' } })), 'fr');
  assert.equal(mod.i18nSelectedLanguage(model, view({ navigator: { languages: ['de-AT'], language: 'de-AT' } })), 'de');
  // The first browser match wins over a later one.
  assert.equal(mod.i18nSelectedLanguage(model, view({ navigator: { languages: ['ja', 'de'] } })), 'de');
  // No browser match leaves the default language.
  assert.equal(mod.i18nSelectedLanguage(model, view({ navigator: { languages: ['ja'], language: 'ja' } })), '');
  // A URL or stored choice still wins over the setting.
  assert.equal(mod.i18nSelectedLanguage(model, view({ location: { search: '?lang=de' }, navigator: { languages: ['fr'] } })), 'de');
  assert.equal(
    mod.i18nSelectedLanguage(model, view({ localStorage: { getItem: () => 'fr' }, navigator: { languages: ['de'] } })),
    'fr',
  );
});

test('a migrated code in languageWithLogin opens that language; an unknown one leaves the default', async () => {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client/10-i18n.js')).href)) as {
    i18nSelectedLanguage: (model: unknown, view: unknown) => string;
  };
  const view = { location: { search: '' }, localStorage: { getItem: () => null }, navigator: { languages: [] } };
  assert.equal(mod.i18nSelectedLanguage({ i18n: { de: {}, fr: {} }, languageWithLogin: 'de' }, view), 'de');
  assert.equal(mod.i18nSelectedLanguage({ i18n: { de: {}, fr: {} }, languageWithLogin: 'es' }, view), '');
  // No setting at all keeps the default language.
  assert.equal(mod.i18nSelectedLanguage({ i18n: { de: {}, fr: {} } }, view), '');
});

test('the emitted slate/assets/model.js rebuilds the i18n table with null prototypes', async () => {
  const bundle = buildUi(appOf(`${FORM}\n${TRANSLATION('Name')}`));
  const file = bundle.files.find((f) => /^slate\/assets\/model\.[0-9a-f]+\.js$/.test(f.path));
  assert.ok(file, 'the bundle emits slate/assets/model.<hash>.js');
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(file.data as string).toString('base64')}`)) as {
    model: UiModel;
  };
  const i18n = mod.model.i18n as Record<string, Record<string, string>>;
  assert.equal(Object.getPrototypeOf(i18n), null, 'the loaded i18n table has no prototype');
  assert.equal(Object.getPrototypeOf(i18n.de), null, 'the loaded language table has no prototype');
  assert.equal(i18n.de['Form.Contact'], ' Kontakt ');
});
