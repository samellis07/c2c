import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi, clientRuntimeSource, type UiModel } from '../src/index.js';

// WCAG 2.2 AA gaps in the vanilla shell: the free-text box of an "Others"
// option is named, a failure toast is announced assertively, and the phone
// More sheet (a modal dialog) takes focus, keeps Tab inside, and gives focus
// back to the More tab on Escape.

function appOf(body: string): App {
  return deriveIr(parse(`application "A11y"\n{\n${body}\n}\n`));
}

const tab = (n: number): string => '\t'.repeat(n);

const FORMS = ['Order', 'Quote', 'Part', 'Bin', 'Lot', 'Unit']
  .map((n) => `${tab(1)}form ${n}\n${tab(1)}{\n${tab(2)}Title\n${tab(2)}(\n${tab(3)}type = text\n${tab(2)})\n${tab(1)}}`)
  .join('\n');

const OTHERS = `${tab(1)}form Task
${tab(1)}{
${tab(2)}Priority
${tab(2)}(
${tab(3)}type = picklist
${tab(3)}displayname = "Urgency"
${tab(3)}values = {"Low","High"}
${tab(3)}others option = true
${tab(2)})
${tab(2)}Size
${tab(2)}(
${tab(3)}type = radiobuttons
${tab(3)}displayname = "Shirt"
${tab(3)}values = {"S","M"}
${tab(3)}others option = true
${tab(2)})
${tab(1)}}`;

type Win = Window & typeof globalThis;

interface Runtime {
  boot(model: UiModel, doc: Document): void;
  renderForm(form: unknown): string;
  showToast(doc: Document, kind: string, text: string): HTMLElement;
}

async function load(model: UiModel): Promise<Runtime> {
  const globals = globalThis as { model?: UiModel; CSS?: unknown };
  globals.CSS ??= { escape: (s: string) => s };
  globals.model = model;
  const source = clientRuntimeSource();
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as Runtime;
}

test('the free-text box of an Others option has an accessible name', async () => {
  const { model } = buildUi(appOf(OTHERS));
  const runtime = await load(model);
  const win = new JSDOM(`<!doctype html><body>${runtime.renderForm(model.forms[0])}</body>`).window as unknown as Win;
  const boxes = Array.from(win.document.querySelectorAll('input[data-others-text]'));
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes.map((b) => b.getAttribute('aria-label')), ['Urgency (other)', 'Shirt (other)']);
});

test('a failure toast is an assertive alert and a success toast stays a polite status', async () => {
  const { model } = buildUi(appOf(OTHERS));
  const runtime = await load(model);
  const doc = (new JSDOM('<!doctype html><body><div id="toasts" aria-live="polite"></div></body>').window as unknown as Win).document;
  assert.equal(runtime.showToast(doc, 'failure', 'No').getAttribute('role'), 'alert');
  assert.equal(runtime.showToast(doc, 'success', 'Ok').getAttribute('role'), 'status');
});

test('the More sheet takes focus, traps Tab, and Escape returns focus to the More tab', async () => {
  const { model } = buildUi(appOf(FORMS));
  const runtime = await load(model);
  const win = new JSDOM(
    '<!doctype html><body><nav id="nav"></nav><main id="main"></main><nav id="tabbar" aria-label="Primary"></nav><div id="more-sheet" hidden role="dialog" aria-modal="true" aria-label="More"></div></body>',
    { url: 'http://localhost/slate/index.html' },
  ).window as unknown as Win;
  const doc = win.document;
  const globals = globalThis as { document?: Document };
  globals.document = doc;
  try {
    runtime.boot(model, doc);
    const sheet = doc.getElementById('more-sheet')!;
    const moreTab = doc.querySelector<HTMLElement>('#tabbar [data-more]')!;
    assert.ok(moreTab, 'no More tab');
    moreTab.focus();
    moreTab.click();
    assert.equal(sheet.hidden, false);
    assert.ok(sheet.contains(doc.activeElement), 'focus did not move into the open More sheet');
    const focusable = Array.from(sheet.querySelectorAll<HTMLElement>('a[href], button'));
    const last = focusable[focusable.length - 1];
    last.focus();
    const tabKey = new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    doc.dispatchEvent(tabKey);
    assert.equal(doc.activeElement, focusable[0], 'Tab from the last control did not wrap to the first');
    assert.equal(tabKey.defaultPrevented, true);
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(sheet.hidden, true);
    assert.equal(doc.activeElement, moreTab);
  } finally {
    delete globals.document;
  }
});
