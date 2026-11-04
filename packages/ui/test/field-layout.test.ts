/**
 * The field `layout` property and the device `customize { layout }` value are
 * carried into the UI model and drawn: option columns and cards on the
 * generated field, the phone form arrangement on `data-phone-layout`, the
 * sliding pane as a labelled drawer, and the tab bar with tablist semantics.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { generateUi, type UiModel } from '../src/index.js';

const FIELD_BODY = `\tsection Main
\t{
\t\tform Cases
\t\t{
\t\t\tdisplayname = "Cases"
\t\t\tSource
\t\t\t(
\t\t\t\ttype = radiobuttons
\t\t\t\tvalues = {"Call","Email","Social Media","Website"}
\t\t\t\tlayout = 2
\t\t\t)
\t\t\tPriority
\t\t\t(
\t\t\t\ttype = radiobuttons
\t\t\t\tvalues = {"High","Normal","Low"}
\t\t\t\tlayout = 3
\t\t\t)
\t\t\tChannels
\t\t\t(
\t\t\t\ttype = checkboxes
\t\t\t\tvalues = {"A","B","C","D"}
\t\t\t\tlayout = twocolumn
\t\t\t)
\t\t\tOwner
\t\t\t(
\t\t\t\ttype = radiobuttons
\t\t\t\tvalues = {"Me","Team"}
\t\t\t\tlayout = onecolumncard
\t\t\t)
\t\t}
\t}`;

function appOf(body: string, device?: string): App {
  return deriveIr(parse(`application "Layout Demo"\n{\n${body}${device ? `\n${device}` : ''}\n}\n`));
}

interface LayoutRuntime {
  renderForm(form: UiModel['forms'][number]): string;
  renderTabbar(model: UiModel): string;
  renderDrawer(model: UiModel): string;
  boot(model: UiModel, doc: Document): void;
}

async function loadRuntime(): Promise<LayoutRuntime> {
  const source = readFileSync(join(process.cwd(), 'packages/ui/src/client-runtime.js'), 'utf8');
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)) as LayoutRuntime;
}

function doc(html: string): Document {
  return new JSDOM(`<!doctype html><body>${html}</body>`).window.document as unknown as Document;
}

function shellDoc(): Document {
  return new JSDOM(
    '<!doctype html><body><nav id="nav"></nav><main id="main"></main><nav id="tabbar"></nav><div id="more-sheet" hidden></div><button id="nav-drawer-open" hidden></button><nav id="drawer" hidden></nav></body>',
    { url: 'http://localhost/slate/index.html' },
  ).window.document as unknown as Document;
}

function cssOf(body: string, device?: string): string {
  const bundle = generateUi(appOf(body, device));
  const file = bundle.files.find((item) => item.path === 'slate/assets/app.css');
  assert.ok(file, 'generated slate css missing');
  return String(file.data);
}

test('field layout values carry option columns and cards onto the generated field', async () => {
  const { model } = generateUi(appOf(FIELD_BODY));
  const form = model.forms[0];
  assert.equal(form.fields.find((f) => f.name === 'Source')?.optionColumns, 2);
  assert.equal(form.fields.find((f) => f.name === 'Priority')?.optionColumns, 3);
  assert.equal(form.fields.find((f) => f.name === 'Channels')?.optionColumns, 2);
  const owner = form.fields.find((f) => f.name === 'Owner');
  assert.equal(owner?.optionColumns, 1);
  assert.equal(owner?.optionCard, true);

  const runtime = await loadRuntime();
  const rendered = doc(runtime.renderForm(form));
  assert.ok(rendered.querySelector('[data-field="Source"] .choices[data-option-columns="2"]'), 'Source options are not a two-column group');
  assert.ok(rendered.querySelector('[data-field="Priority"] .choices[data-option-columns="3"]'), 'Priority options are not a three-column group');
  assert.ok(rendered.querySelector('[data-field="Channels"] .choices[data-option-columns="2"]'), 'Channels options are not a two-column group');
  assert.ok(
    rendered.querySelector('[data-field="Owner"] .choices[data-option-columns="1"][data-option-style="card"]'),
    'Owner options are not a card column',
  );
  const css = cssOf(FIELD_BODY);
  assert.match(css, /\[data-option-columns="2"\]\{grid-template-columns:1fr 1fr\}/);
  assert.match(css, /\[data-option-columns="3"\]\{grid-template-columns:1fr 1fr 1fr\}/);
  assert.match(css, /\[data-option-style="card"\] \.choice/);
});

test('a device customize layout reaches the model and the form data attribute', () => {
  const device = `\tphone\n\t{\n\t\tcustomize\n\t\t{\n\t\t\tlayout = twocolumn\n\t\t}\n\t}`;
  const { model } = generateUi(appOf(FIELD_BODY, device));
  assert.equal(model.phoneLayout, 'two-column');
  assert.equal(model.forms[0].phoneLayout, 'two-column');
});

test('slidingpane becomes a labelled slide-over drawer; tabbar keeps the tab bar', async () => {
  const device = (layout: string) => `\tphone\n\t{\n\t\tcustomize\n\t\t{\n\t\t\tlayout = ${layout}\n\t\t}\n\t}`;
  const runtime = await loadRuntime();

  const sliding = generateUi(appOf(FIELD_BODY, device('slidingpane'))).model;
  assert.equal(sliding.phoneLayout, 'sliding-pane');
  const slidingDoc = shellDoc();
  runtime.boot(sliding, slidingDoc);
  assert.equal(slidingDoc.querySelectorAll('#tabbar [data-tab]').length, 0, 'sliding pane must not paint the tab bar');
  const open = slidingDoc.getElementById('nav-drawer-open') as HTMLElement & { hidden: boolean };
  assert.equal(open.hidden, false, 'drawer open button is hidden');
  const drawer = slidingDoc.getElementById('drawer') as HTMLElement & { hidden: boolean };
  assert.equal(drawer.getAttribute('role'), 'dialog');
  assert.equal(drawer.getAttribute('aria-modal'), 'true');
  assert.ok(drawer.getAttribute('aria-label'), 'drawer is unlabelled');
  assert.ok(drawer.querySelector('a[href^="#"]'), 'drawer has no navigation links');
  assert.ok(drawer.querySelector('[data-drawer-close]'), 'drawer has no close button');
  open.dispatchEvent(new slidingDoc.defaultView!.MouseEvent('click', { bubbles: true }));
  assert.equal(drawer.hidden, false, 'drawer did not open');
  drawer.dispatchEvent(
    new slidingDoc.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  // Escape is bound on the document, like the More sheet.
  slidingDoc.dispatchEvent(new slidingDoc.defaultView!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(drawer.hidden, true, 'Escape did not close the drawer');

  const tabs = generateUi(appOf(FIELD_BODY, device('tabbar'))).model;
  assert.equal(tabs.phoneLayout, 'tab-bar');
  const tabDoc = shellDoc();
  runtime.boot(tabs, tabDoc);
  assert.ok(tabDoc.querySelectorAll('#tabbar [role="tab"]').length > 0, 'tab bar tabs are missing');
  assert.equal(tabDoc.getElementById('tabbar')?.getAttribute('role'), 'tablist');
  assert.equal((tabDoc.getElementById('nav-drawer-open') as HTMLElement & { hidden: boolean }).hidden, true);

  // Mutation: dropping the carried value must return the shell to no drawer.
  const plain = generateUi(appOf(FIELD_BODY)).model;
  const plainDoc = shellDoc();
  runtime.boot(plain, plainDoc);
  assert.equal((plainDoc.getElementById('nav-drawer-open') as HTMLElement & { hidden: boolean }).hidden, true);
  assert.ok(plainDoc.querySelectorAll('#tabbar [data-tab]').length > 0, 'default shell lost its tab bar');
});

test('the device form layouts pick the form grid and the card wrapper', async () => {
  const runtime = await loadRuntime();
  const cases: [string, string, string][] = [
    ['twocolumn', 'two-column', 'two'],
    ['onecolumn', 'one-column', 'one'],
    ['onecolumncard', 'one-column-card', 'one'],
  ];
  for (const [raw, carried, grid] of cases) {
    const device = `\tphone\n\t{\n\t\tcustomize\n\t\t{\n\t\t\tlayout = ${raw}\n\t\t}\n\t}`;
    const { model } = generateUi(appOf(FIELD_BODY, device));
    assert.equal(model.phoneLayout, carried, raw);
    const form = doc(runtime.renderForm(model.forms[0])).querySelector('form[data-form]');
    assert.equal(form?.getAttribute('data-phone-layout'), carried);
    assert.equal(form?.getAttribute('data-layout'), grid, `${raw} picked the wrong form grid`);
  }
  const css = cssOf(FIELD_BODY);
  assert.match(css, /\[data-layout="two"\] \.form-grid\{grid-template-columns:1fr 1fr\}/);
  assert.match(css, /\[data-phone-layout="one-column-card"\] \.form-grid>\.field/);
  // The phone breakpoint still collapses every grid to one column.
  const phone = css.slice(css.indexOf('@media (max-width:768px)'));
  assert.doesNotMatch(phone, /1fr 1fr/, 'a multi-column grid leaked into the phone block');
});

test('an unknown device layout value is not carried', () => {
  const device = `\tphone\n\t{\n\t\tcustomize\n\t\t{\n\t\t\tlayout = triplestack\n\t\t}\n\t}`;
  const { model } = generateUi(appOf(FIELD_BODY, device));
  assert.equal(model.phoneLayout, undefined);
});
