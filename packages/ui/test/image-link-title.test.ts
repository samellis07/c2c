import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, type UiModel } from '../src/index.js';

interface DomWindow {
  document: {
    querySelector(selector: string): { value?: string } | null;
    body: { innerHTML: string };
  };
}

function dom(html: string): DomWindow {
  return new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'http://localhost/' }).window as unknown as DomWindow;
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function imageApp(enableLine: string): UiModel {
  return buildUi(
    appOf(`\tform Profile\n\t{\n\t\tPhoto\n\t\t(\n\t\t\ttype = image\n${enableLine}\t\t)\n\t}\n`),
  ).model;
}

async function runtime() {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    renderForm: (form: UiModel['forms'][number]) => string;
    submitRecord: (
      formEl: unknown,
      form: UiModel['forms'][number],
      upload: (field: unknown, file: unknown) => Promise<unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}

test('enable = link, title draws a link URL input and a title input alongside the upload', async () => {
  const model = imageApp('\t\t\tenable = link, title\n');
  const photo = model.forms[0]!.fields[0]!;
  assert.equal(photo.imageLink, true);
  assert.equal(photo.imageTitle, true);
  const rt = await runtime();
  const html = rt.renderForm(model.forms[0]!);
  assert.match(html, new RegExp(`name="${photo.imageLinkColumn}" type="url" placeholder="Link URL"`));
  assert.match(html, new RegExp(`name="${photo.imageTitleColumn}" type="text" placeholder="Title"`));
});

test('enable = link alone draws only the link input; enable = title alone draws only the title input', async () => {
  const rt = await runtime();
  const linkOnly = imageApp('\t\t\tenable = link\n').forms[0]!;
  const linkHtml = rt.renderForm(linkOnly);
  assert.match(linkHtml, /placeholder="Link URL"/);
  assert.doesNotMatch(linkHtml, /placeholder="Title"/);

  const titleOnly = imageApp('\t\t\tenable = title\n').forms[0]!;
  const titleHtml = rt.renderForm(titleOnly);
  assert.doesNotMatch(titleHtml, /placeholder="Link URL"/);
  assert.match(titleHtml, /placeholder="Title"/);
});

test('an image field with no enable property draws neither companion input', async () => {
  const rt = await runtime();
  const plain = buildUi(appOf('\tform Profile\n\t{\n\t\tPhoto\n\t\t(\n\t\t\ttype = image\n\t\t)\n\t}\n')).model.forms[0]!;
  const html = rt.renderForm(plain);
  assert.doesNotMatch(html, /placeholder="Link URL"/);
  assert.doesNotMatch(html, /placeholder="Title"/);
});

test('submit carries the typed link and title into their own stored columns', async () => {
  const model = imageApp('\t\t\tenable = link, title\n');
  const form = model.forms[0]!;
  const photo = form.fields[0]!;
  const rt = await runtime();
  const html = rt.renderForm(form);
  const view = dom(html);
  const formEl = view.document.querySelector('form') ?? view.document.body;
  (view.document.querySelector(`input[name="${photo.imageLinkColumn}"]`) as { value: string }).value = 'https://cdn.example.com/pic.png';
  (view.document.querySelector(`input[name="${photo.imageTitleColumn}"]`) as { value: string }).value = ' A caption ';
  const record = await rt.submitRecord(formEl, form, async () => ({ key: 'never' }));
  assert.equal(record[photo.imageLinkColumn!], 'https://cdn.example.com/pic.png');
  // Typed text is trimmed, matching every other text companion the submit stub writes.
  assert.equal(record[photo.imageTitleColumn!], 'A caption');
});

test('a blank typed link or title still posts as an empty string, like any other text companion', async () => {
  const model = imageApp('\t\t\tenable = link, title\n');
  const form = model.forms[0]!;
  const photo = form.fields[0]!;
  const rt = await runtime();
  const html = rt.renderForm(form);
  const view = dom(html);
  const formEl = view.document.querySelector('form') ?? view.document.body;
  const record = await rt.submitRecord(formEl, form, async () => ({ key: 'never' }));
  assert.equal(record[photo.imageLinkColumn!], '');
  assert.equal(record[photo.imageTitleColumn!], '');
});
