import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { decodeMultiValue, multiValueCell } from '../../shims/src/multi-value.js';
import { buildUi, type UiModel } from '../src/index.js';

/**
 * A multi select or checkboxes field is stored as JSON list text. The edit
 * screen must select every stored choice, so saving without touching the field
 * posts the same choices back, and a legacy shape ([No], {"No"}) is re-saved in
 * the canonical one. A report shows the choices, not the list text.
 */
const APP = `application "Library"
{
form Book
{
Title
(
type = text
)
Mark_as_Featured
(
type = checkboxes
values = {"Yes", "No"}
)
Genres
(
type = multiselect
values = {"Fiction", "History", "Science"}
)
}
list Book_Report
{
show all rows from Book
(
Title
Mark_as_Featured
Genres
)
}
}`;

type Runtime = {
  boot(model: UiModel, doc: Document): Promise<void>;
  renderReportRows(report: UiModel['reports'][number], rows: Record<string, unknown>[]): string;
  multiValueItems(value: unknown): string[];
};

async function browserRuntime(): Promise<Runtime> {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
  const { clientRuntimeSource } = await import('../src/generate.js');
  return (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as unknown as Runtime;
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function model(): UiModel {
  return buildUi(deriveIr(parse(APP))).model;
}

const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Open the edit screen on a stored row, submit it untouched, and return the posted record. */
async function saveUntouched(stored: Record<string, unknown>): Promise<{ record: Record<string, unknown>; doc: Document }> {
  const runtime = await browserRuntime();
  const app = model();
  const form = app.forms.find((item) => item.name === 'Book')!;
  const posts: { endpoint: string; body: string }[] = [];
  const dom = new JSDOM('<!doctype html><body><main id="main"></main></body>', { url: 'http://localhost/slate/index.html#/form/Book/edit/41016' });
  (dom.window as unknown as { fetch: typeof fetch }).fetch = (async (endpoint: string, init: { body?: string }) => {
    posts.push({ endpoint, body: String(init && init.body) });
    if (endpoint === form.recordEndpoint) return okResponse({ dryRun: false, record: { ROWID: '41016', Title: 'Dune', ...stored } });
    return okResponse({ dryRun: false, wrote: true });
  }) as unknown as typeof fetch;
  await runtime.boot(app, dom.window.document as unknown as Document);
  await settle();
  const win = dom.window as unknown as { document: Document; Event: typeof Event };
  win.document.querySelector('form')?.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await settle(30);
  const submit = posts.find((post) => post.endpoint === form.submitEndpoint);
  assert.ok(submit, 'the edit screen posts the record');
  const body = JSON.parse(submit.body) as { ROWID?: string; record?: Record<string, unknown> };
  assert.equal(body.ROWID, '41016');
  return { record: body.record ?? (body as Record<string, unknown>), doc: win.document };
}

test('the model marks multi-value report columns', () => {
  const report = model().reports.find((item) => item.name === 'Book_Report')!;
  const flags = Object.fromEntries(report.columns.map((column) => [column.field, column.multiValue === true]));
  assert.deepEqual(flags, { Title: false, Mark_as_Featured: true, Genres: true });
});

test('editing a record and saving without touching a multi-value field keeps its choices', async () => {
  const { record, doc } = await saveUntouched({ Mark_as_Featured: '["No"]', Genres: '["Fiction","Science"]' });
  const featured = [...doc.querySelectorAll<HTMLInputElement>('input[name="Mark_as_Featured"][data-choice]')].filter((box) => box.checked).map((box) => box.value);
  assert.deepEqual(featured, ['No'], 'the stored choice is checked on the edit screen');
  const genres = doc.querySelector<HTMLSelectElement>('select[name="Genres"]')!;
  assert.deepEqual([...genres.selectedOptions].map((option) => option.value), ['Fiction', 'Science']);
  assert.equal(multiValueCell(record.Mark_as_Featured), '["No"]', 'the save keeps the stored choice, never []');
  assert.equal(multiValueCell(record.Genres), '["Fiction","Science"]');
});

test('a stored legacy shape is decoded on edit and re-saved canonical', async () => {
  for (const legacy of ['[No]', '{"No"}', '["No"]', 'No']) {
    const { record } = await saveUntouched({ Mark_as_Featured: legacy, Genres: '{"History","Science"}' });
    assert.equal(multiValueCell(record.Mark_as_Featured), '["No"]', `${legacy} saves as ["No"]`);
    assert.equal(multiValueCell(record.Genres), '["History","Science"]');
  }
});

test('a report shows the choices of a multi-value cell, not its stored text', async () => {
  const runtime = await browserRuntime();
  const report = model().reports.find((item) => item.name === 'Book_Report')!;
  const html = runtime.renderReportRows(report, [
    { ROWID: '1', Title: 'Dune', Mark_as_Featured: '["No"]', Genres: '["Fiction","Science"]' },
    { ROWID: '2', Title: 'Emma', Mark_as_Featured: '[No]', Genres: '{"History"}' },
  ]);
  const table = new JSDOM(`<table><tbody>${html}</tbody></table>`).window.document as unknown as Document;
  // A row opens with its selection cell and closes with its record actions.
  const cells = [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent).slice(1, 4));
  assert.deepEqual(cells, [
    ['Dune', 'No', 'Fiction, Science'],
    ['Emma', 'No', 'History'],
  ]);
});

test('the browser decoder reads every stored shape the shared decoder reads', async () => {
  const runtime = await browserRuntime();
  const shapes: unknown[] = ['["No"]', '[No]', '{"No"}', "{'No'}", 'No', '[Red, Blue]', '{"Red","Blue"}', '[ "a" , "b" ]', '[]', '{}', '', ' ', null, undefined, ['x', ' ', 'y'], 3, true];
  for (const shape of shapes) assert.deepEqual(runtime.multiValueItems(shape), decodeMultiValue(shape), JSON.stringify(shape));
  assert.deepEqual(decodeMultiValue('[No]'), ['No']);
  assert.deepEqual(decodeMultiValue('{"No"}'), ['No']);
  assert.deepEqual(decodeMultiValue('[Red, Blue]'), ['Red', 'Blue']);
  assert.equal(multiValueCell('[No]'), '["No"]', 'a legacy unquoted list is re-encoded, not stored as one choice');
  assert.equal(multiValueCell('[Red, Blue]'), '["Red","Blue"]');
});
