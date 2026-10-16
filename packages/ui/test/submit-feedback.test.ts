/**
 * What the vanilla client tells a person after a submit, an edit and a row
 * Delete, and how it draws a custom action whose endpoint is a dry-run stub:
 * a saved add shows the form's success message, an edit the update wording,
 * every refusal says so, Delete asks first, and a stub action is turned off
 * with a note instead of reporting a run that saved nothing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi, type UiModel } from '../src/index.js';

interface Runtime {
  boot(model: UiModel, doc: Document): Promise<void>;
}

async function loadRuntime(): Promise<Runtime> {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
}

const field = { label: 'Item Name', widget: 'text', required: false, readonly: false, unique: false, status: 'generated', scan: false };

function modelWith(actions: Record<string, unknown>[] = [], columns: Record<string, unknown>[] = []): UiModel {
  return {
    name: 'Feedback',
    nav: [],
    pages: [],
    forms: [
      {
        name: 'F',
        label: 'F',
        submitEndpoint: '/forms/F/submit',
        recordEndpoint: '/forms/F/record',
        deleteEndpoint: '/forms/F/delete',
        successMessage: 'Item Added Successfully',
        handlers: [],
        fields: [{ name: 'Item_Name', ...field }],
      },
    ],
    reports: [
      {
        name: 'R',
        label: 'R',
        status: 'generated',
        view: 'list',
        form: 'F',
        queryEndpoint: '/reports/R',
        pageSize: 300,
        columns: [{ field: 'Item_Name', label: 'Item Name' }, ...columns],
        filters: [],
        sort: [],
        groupBy: [],
        rowActions: { edit: true, delete: true },
        customActions: actions,
        detail: false,
      },
    ],
  } as unknown as UiModel;
}

interface Win {
  document: Document;
  fetch: unknown;
  confirm: (text: string) => boolean;
  Event: typeof Event;
  MouseEvent: typeof MouseEvent;
}

type Answer = { status: number; body: Record<string, unknown> };

function setup(hash: string, submit: Answer) {
  const win = new JSDOM('<!doctype html><body><nav id="nav"></nav><main id="main"></main><div id="toasts"></div></body>', {
    url: `http://localhost/slate/index.html${hash}`,
  }).window as unknown as Win;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  win.fetch = async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, body });
    const reply = (status: number, payload: unknown) => ({ ok: status < 400, status, json: async () => payload });
    if (body.op === 'query') return reply(200, { rows: [{ ROWID: '11', Item_Name: 'Widget' }] });
    if (url === '/forms/F/record') return reply(200, { record: { ROWID: '5', Item_Name: 'Widget' } });
    if (url === '/forms/F/delete') return reply(200, { dryRun: false });
    return reply(submit.status, submit.body);
  };
  return { win, doc: win.document, calls };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function submitForm(win: Win, doc: Document): Promise<void> {
  const form = doc.querySelector('form[data-form="F"]') as HTMLFormElement;
  (form.querySelector('input[name="Item_Name"]') as HTMLInputElement).value = 'Widget Alpha';
  form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  await settle();
}

const live = { status: 200, body: { dryRun: false, wrote: true } };

test('a saved add shows the form success message and clears the form', async () => {
  const runtime = await loadRuntime();
  const { win, doc, calls } = setup('#/form/F', live);
  await runtime.boot(modelWith(), doc);
  await submitForm(win, doc);
  assert.equal(calls.filter((c) => c.url === '/forms/F/submit').length, 1);
  assert.equal(doc.querySelector('[data-banner]')?.textContent, 'Item Added Successfully');
  assert.equal((doc.querySelector('input[name="Item_Name"]') as HTMLInputElement).value, '', 'the saved add clears the form');
});

test('a saved edit says the update wording, never the add success message', async () => {
  const runtime = await loadRuntime();
  const { win, doc, calls } = setup('#/form/F/edit/5', live);
  await runtime.boot(modelWith(), doc);
  await settle();
  await submitForm(win, doc);
  const submit = calls.find((c) => c.url === '/forms/F/submit');
  assert.equal(submit?.body.ROWID, '5');
  assert.equal(doc.querySelector('[data-banner]')?.textContent, 'Data Updated Successfully!');
  assert.equal((doc.querySelector('input[name="Item_Name"]') as HTMLInputElement).value, 'Widget Alpha', 'an edit keeps its values');
});

test('a refused or failed submit always says so; a failure after the write says the record was saved', async () => {
  const runtime = await loadRuntime();
  const cases: { answer: Answer; expected: string }[] = [
    { answer: { status: 409, body: { dryRun: false, wrote: false, error: 'duplicate value for field "Email": use a different value.' } }, expected: 'duplicate value for field "Email": use a different value.' },
    { answer: { status: 500, body: { dryRun: false, wrote: true, error: 'request failed' } }, expected: 'The record was saved, but a step after saving failed.' },
    { answer: { status: 500, body: { dryRun: false, wrote: true, error: 'Fine rule refused' } }, expected: 'The record was saved, but a step after saving failed: Fine rule refused' },
    { answer: { status: 403, body: { dryRun: false, wrote: true, error: 'record access denied' } }, expected: 'The record was saved, but a step after saving failed: record access denied' },
  ];
  for (const { answer, expected } of cases) {
    const { win, doc } = setup('#/form/F', answer);
    await runtime.boot(modelWith(), doc);
    await submitForm(win, doc);
    assert.equal(doc.querySelector('[data-banner]')?.textContent, expected, JSON.stringify(answer));
    assert.equal((doc.querySelector('input[name="Item_Name"]') as HTMLInputElement).value, 'Widget Alpha', 'a failed submit keeps what was typed');
  }
});

test('a row Delete asks first; Cancel sends nothing and keeps the row', async () => {
  const runtime = await loadRuntime();
  const { win, doc, calls } = setup('#/report/R', live);
  const asked: string[] = [];
  let answer = false;
  win.confirm = (text) => {
    asked.push(text);
    return answer;
  };
  await runtime.boot(modelWith(), doc);
  await settle();
  const click = async () => {
    const button = doc.querySelector('[data-rows] tbody tr button[data-row-delete]');
    assert.ok(button, 'the row draws a Delete');
    button.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle();
  };
  await click();
  assert.deepEqual(asked, ['Are you sure you want to delete this record?']);
  assert.equal(calls.filter((c) => c.url === '/forms/F/delete').length, 0, 'Cancel sends no delete');
  assert.equal(doc.querySelectorAll('[data-rows] tbody tr').length, 1, 'Cancel keeps the row');

  answer = true;
  await click();
  assert.deepEqual(calls.filter((c) => c.url === '/forms/F/delete').map((c) => c.body), [{ ROWID: '11' }], 'OK posts the delete once');
});

test('a custom action whose endpoint is a dry-run stub is turned off and named', async () => {
  const runtime = await loadRuntime();
  const actions = [
    { name: 'Export All', endpoint: '/reports/R/actions/export-all', header: true, preview: true },
    { name: 'Mark as Lost', endpoint: '/reports/R/actions/mark-as-lost', preview: true },
  ];
  const { win, doc, calls } = setup('#/report/R', live);
  await runtime.boot(modelWith(actions, [{ field: 'Mark as Lost', label: 'Lost', action: '/reports/R/actions/mark-as-lost' }]), doc);
  await settle();
  const buttons = [...doc.querySelectorAll('button[data-action]')] as HTMLButtonElement[];
  assert.ok(buttons.some((b) => b.getAttribute('data-action') === '/reports/R/actions/export-all'), 'the header action is drawn');
  assert.ok(buttons.some((b) => b.getAttribute('data-action') === '/reports/R/actions/mark-as-lost'), 'the record action is drawn');
  for (const button of buttons) {
    assert.equal(button.disabled, true, `${button.getAttribute('data-action')} is turned off`);
    button.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  }
  await settle();
  assert.equal(calls.filter((c) => c.url.includes('/actions/')).length, 0);
  assert.equal(doc.querySelector('[data-action-preview]')?.textContent, 'Not available yet, so turned off: Export All, Mark as Lost.');
});

const ACTION_APP = [
  'application "Actions"',
  '{',
  '\tform Item',
  '\t{',
  '\t\tName',
  '\t\t(',
  '\t\t\ttype = text',
  '\t\t)',
  '\t\tStatus',
  '\t\t(',
  '\t\t\ttype = text',
  '\t\t)',
  '\t}',
  '\tlist All_Items',
  '\t{',
  '\t\tshow all rows from Item',
  '\t\t(',
  '\t\t\tName',
  '\t\t\tStatus',
  '\t\t\tcustom action "Mark as Lost"',
  '\t\t\t(',
  '\t\t\t\tworkflow = Mark_Lost',
  '\t\t\t\tcolumn header = "Mark as Lost"',
  '\t\t\t)',
  '\t\t\tcustom action "Archive"',
  '\t\t\t(',
  '\t\t\t\tworkflow = Not_A_Function',
  '\t\t\t\tcolumn header = "Archive"',
  '\t\t\t)',
  '\t\t)',
  '\t}',
  '\tworkflow',
  '\t{',
  '\tfunctions',
  '\t{',
  '\t\tMark_Lost as "Mark Lost"',
  '\t\t{',
  '\t\t\ttype = functions',
  '\t\t\tform = Item',
  '\t\t\texecution type = for each record',
  '\t\t\ton start',
  '\t\t\t{',
  '\t\t\t\tactions',
  '\t\t\t\t{',
  '\t\t\t\t\trec.Status = "Lost";',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '\t}',
  '}',
  '',
].join('\n');

test('only an action with no generated function is a counted stub: the model, the todos, the report and the endpoint agree', () => {
  const built = buildUi(deriveIr(parse(ACTION_APP)));
  const report = built.model.reports.find((item) => item.name === 'All_Items')!;
  const byName = new Map(report.customActions.map((action) => [action.name, action]));
  assert.equal(byName.get('Mark as Lost')?.preview, undefined, 'a dispatchable action is not a preview');
  assert.equal(byName.get('Archive')?.preview, true, 'an action with no generated function is a preview');
  const actionTodos = built.model.todos.filter((todo) => todo.area === 'report' && /^Custom action /.test(todo.reason));
  assert.deepEqual(actionTodos.map((todo) => todo.reason), ['Custom action "Archive" is not migrated; its button is turned off.']);
  // migration-report.json counts the same UI stubs the model lists.
  const migration = built.files.find((file) => file.path.endsWith('migration-report.json'));
  assert.ok(migration, 'migration-report.json was generated');
  assert.equal((JSON.parse(String(migration.data)) as { uiTodoCount: number }).uiTodoCount, built.model.todos.length);
  // The endpoint follows the same predicate: the live dispatch, or a refusal.
  const live = String(built.files.find((file) => file.path === 'functions/reports/all-items-action-mark-as-lost.mjs')?.data);
  const stub = String(built.files.find((file) => file.path === 'functions/reports/all-items-action-archive.mjs')?.data);
  assert.match(live, /ctx\.shim\.thisapp\.call/);
  assert.doesNotMatch(stub, /thisapp/);
  assert.match(stub, /has no generated function to run/);
});

test('the client draws a dispatchable action enabled and turns off only the stub', async () => {
  const runtime = await loadRuntime();
  const built = buildUi(deriveIr(parse(ACTION_APP)));
  const report = built.model.reports.find((item) => item.name === 'All_Items')!;
  const model = modelWith(report.customActions as unknown as Record<string, unknown>[], [
    { field: 'Mark as Lost', label: 'Mark as Lost', action: '/reports/All_Items/actions/mark-as-lost' },
    { field: 'Archive', label: 'Archive', action: '/reports/All_Items/actions/archive' },
  ]);
  const { win, doc, calls } = setup('#/report/R', live);
  await runtime.boot(model, doc);
  await settle();
  const buttonFor = (endpoint: string) => doc.querySelector(`[data-rows] tbody tr button[data-action="${endpoint}"]`) as HTMLButtonElement | null;
  const lost = buttonFor('/reports/All_Items/actions/mark-as-lost');
  const archive = buttonFor('/reports/All_Items/actions/archive');
  assert.ok(lost && archive, 'both row actions are drawn');
  assert.equal(lost.disabled, false, 'the dispatchable action is enabled');
  assert.equal(archive.disabled, true, 'the stub action is turned off');
  archive.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(calls.filter((c) => c.url.includes('/actions/archive')).length, 0, 'a turned-off action posts nothing');
  assert.equal(doc.querySelector('[data-action-preview]')?.textContent, 'Not available yet, so turned off: Archive.');
});
