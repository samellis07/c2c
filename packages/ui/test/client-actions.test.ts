import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

// applyActions on the concatenated client runtime: the `clear`, `ui`,
// `subform` and `reload` ops a Deluge statement emits, and openUrl
// navigation. Each test pins the DOM change, not just the note.

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function field(name: string, type: string, extra = ''): string {
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${name}\n\t\t(\n${lines}\n\t\t)`;
}

async function loadRuntime() {
  const { clientRuntimeSource } = await import('../src/generate.js');
  return (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as {
    renderForm(form: unknown): string;
    applyActions(actions: Record<string, unknown>[], root: unknown): string[];
  };
}

// A test DOM has no navigation: `location.assign` and `location.reload`
// would hit the DOM's unimplemented navigation. The window's `location` cannot
// be replaced, so the document hands the runtime a view whose `location`
// records those calls and reads everything else from the real location.
function stubNavigation(dom: JSDOM) {
  const nav = { assigned: [] as string[], replaced: [] as string[], reloads: 0 };
  const win = dom.window as unknown as Window;
  const real = win.location;
  const location = {
    get href() { return real.href; },
    get origin() { return real.origin; },
    get pathname() { return real.pathname; },
    get search() { return real.search; },
    get hash() { return real.hash; },
    set hash(value: string) { real.hash = value; },
    assign: (url: string) => void nav.assigned.push(String(url)),
    replace: (url: string) => void nav.replaced.push(String(url)),
    reload: () => void nav.reloads++,
  };
  const view = new Proxy(win, {
    get(target, key) {
      if (key === 'location') return location;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  Object.defineProperty(win.document, 'defaultView', { configurable: true, get: () => view });
  return nav;
}

async function setup(body: string) {
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };
  const runtime = await loadRuntime();
  const model = buildUi(appOf(body)).model;
  const dom = new JSDOM(`<!doctype html><body>${runtime.renderForm(model.forms[0])}</body>`, { url: 'http://localhost/' });
  const nav = stubNavigation(dom);
  return { runtime, nav, doc: dom.window.document as unknown as Document, win: dom.window as unknown as Window };
}

const SUBFORM = field('Items', 'grid', '\t\t\tItem\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t\tQty\n\t\t\t(\n\t\t\t\ttype = number\n\t\t\t)');
const CHOICE = field('Phase', 'dropdown', '\t\t\tvalues = {"Open","Done"}');

test('clear on a subform drops the body rows; a field target clears its value', async () => {
  const { runtime, doc } = await setup(`\tform Order\n\t{\n${SUBFORM}\n${field('Note', 'text')}\n\t}`);
  const formEl = doc.querySelector('form');
  const box = doc.querySelector('.subform[data-field="Items"]')!;
  box.querySelector('tbody')!.innerHTML = '<tr><td><input data-subfield="Item" value="Bolt"></td><td><input data-subfield="Qty" value="3"></td></tr>';
  (doc.querySelector('[data-field="Note"] input') as HTMLInputElement).value = 'keep me';
  const notes = runtime.applyActions([{ op: 'clear', targets: ['Items'] }], formEl);
  assert.deepEqual(notes, ['clear:Items']);
  assert.equal(box.querySelectorAll('tbody tr').length, 0);
  runtime.applyActions([{ op: 'clear', targets: ['Note'] }], formEl);
  assert.equal((doc.querySelector('[data-field="Note"] input') as HTMLInputElement).value, '');
});

test('clear on Subform.Field empties that column in every row', async () => {
  const { runtime, doc } = await setup(`\tform Order\n\t{\n${SUBFORM}\n\t}`);
  const formEl = doc.querySelector('form');
  const box = doc.querySelector('.subform[data-field="Items"]')!;
  box.querySelector('tbody')!.innerHTML =
    '<tr><td><input data-subfield="Item" value="Bolt"></td><td><input data-subfield="Qty" value="3"></td></tr>';
  runtime.applyActions([{ op: 'clear', targets: ['Items.Qty'] }], formEl);
  const qty = box.querySelector('[data-subfield="Qty"]') as HTMLInputElement;
  const item = box.querySelector('[data-subfield="Item"]') as HTMLInputElement;
  assert.equal(qty.value, '');
  assert.equal(item.value, 'Bolt');
  assert.equal(box.querySelectorAll('tbody tr').length, 1, 'the row stays');
});

test('clear on a select removes its choices and keeps the blank', async () => {
  const { runtime, doc } = await setup(`\tform Order\n\t{\n${CHOICE}\n\t}`);
  const formEl = doc.querySelector('form');
  const select = doc.querySelector('[data-field="Phase"] select') as HTMLSelectElement;
  assert.ok(select);
  runtime.applyActions([{ op: 'clear', targets: ['Phase'] }], formEl);
  assert.deepEqual([...select.options].map((o) => o.value), ['']);
});

test('ui add appends a choice; select / deselect / selectAll / deselectAll toggle it', async () => {
  const { runtime, doc } = await setup(`\tform Order\n\t{\n${field('Phase', 'multi-select', '\t\t\tvalues = {"Open","Done"}')}\n\t}`);
  const formEl = doc.querySelector('form');
  const select = doc.querySelector('[data-field="Phase"] select') as HTMLSelectElement;
  assert.ok(select && select.multiple);
  let notes = runtime.applyActions([{ op: 'ui', method: 'add', target: ['Phase'], args: ['Stuck'] }], formEl);
  assert.deepEqual(notes, ['ui:add:Phase']);
  assert.deepEqual([...select.options].map((o) => o.value), ['Open', 'Done', 'Stuck']);
  // An AddChoice row ({ option_value }) is the same choice.
  runtime.applyActions([{ op: 'ui', method: 'append', target: ['Phase'], args: [{ option_value: 'Late' }] }], formEl);
  assert.deepEqual([...select.options].map((o) => o.value), ['Open', 'Done', 'Stuck', 'Late']);
  runtime.applyActions([{ op: 'ui', method: 'select', target: ['Phase'], args: ['Stuck'] }], formEl);
  assert.equal(select.options[2].selected, true);
  runtime.applyActions([{ op: 'ui', method: 'deselect', target: ['Phase'], args: ['Stuck'] }], formEl);
  assert.equal(select.options[2].selected, false);
  runtime.applyActions([{ op: 'ui', method: 'selectAll', target: ['Phase'], args: [] }], formEl);
  assert.equal([...select.options].every((o) => o.selected), true);
  runtime.applyActions([{ op: 'ui', method: 'deselectAll', target: ['Phase'], args: [] }], formEl);
  assert.equal([...select.options].every((o) => !o.selected), true);
  // REMOVE_ALL deselects every choice without naming it.
  select.options[0].selected = true;
  runtime.applyActions([{ op: 'ui', method: 'deselect', target: ['Phase'], args: ['REMOVE_ALL'] }], formEl);
  assert.equal([...select.options].every((o) => !o.selected), true);
});

test('ui add on a checkbox group appends a labelled input; deselect unchecks it', async () => {
  const { runtime, doc } = await setup(`\tform Order\n\t{\n${field('Opts', 'checkboxes', '\t\t\tvalues = {"A","B"}')}\n\t}`);
  const formEl = doc.querySelector('form');
  const block = doc.querySelector('[data-field="Opts"]')!;
  runtime.applyActions([{ op: 'ui', method: 'add', target: ['Opts'], args: ['C'] }], formEl);
  const inputs = block.querySelectorAll('input[data-choice]');
  assert.deepEqual([...inputs].map((i) => (i as HTMLInputElement).value), ['A', 'B', 'C']);
  runtime.applyActions([{ op: 'ui', method: 'select', target: ['Opts'], args: ['C'] }], formEl);
  assert.equal((inputs[2] as HTMLInputElement).checked, true);
  runtime.applyActions([{ op: 'ui', method: 'deselect', target: ['Opts'], args: ['C'] }], formEl);
  assert.equal((inputs[2] as HTMLInputElement).checked, false);
});

test('ui add on a subform field extends the column choices and the rendered cells', async () => {
  const { runtime, doc } = await setup(
    `\tform Order\n\t{\n${field('Items', 'grid', '\t\t\tItem\n\t\t\t(\n\t\t\t\ttype = dropdown\n\t\t\t\tvalues = {"a"}\n\t\t\t)')}\n\t}`,
  );
  const formEl = doc.querySelector('form');
  const box = doc.querySelector('.subform[data-field="Items"]')!;
  box.querySelector('tbody')!.innerHTML = '<tr><td><select data-subfield="Item"><option value="">-Select-</option><option value="a">a</option></select></td></tr>';
  const notes = runtime.applyActions([{ op: 'ui', method: 'add', target: ['Items', 'Item'], args: [{ option_value: 'b' }] }], formEl);
  assert.deepEqual(notes, ['ui:add:Items.Item']);
  const columns = JSON.parse(box.getAttribute('data-columns') || '[]') as { name: string; choices?: string[] }[];
  assert.deepEqual(columns.find((c) => c.name === 'Item')?.choices, ['a', 'b']);
  const cell = box.querySelector('select[data-subfield="Item"]') as HTMLSelectElement;
  assert.deepEqual([...cell.options].map((o) => o.value), ['', 'a', 'b']);
});

test('subform insert renders one grid row per collection element, values in place', async () => {
  const { runtime, doc } = await setup(`\tform Order\n\t{\n${SUBFORM}\n\t}`);
  const formEl = doc.querySelector('form');
  const box = doc.querySelector('.subform[data-field="Items"]')!;
  // A `Form.Subform()` constructor row carries values under `values`.
  const row = { __row: true, form: 'Order.Items', values: { Item: 'Bolt', Qty: 3 } };
  const notes = runtime.applyActions(
    [{ op: 'subform', method: 'insert', target: ['Items'], args: [[row, { Item: 'Nut', Qty: 2 }]] }],
    formEl,
  );
  assert.deepEqual(notes, ['subform:insert:Items']);
  const rows = box.querySelectorAll('tbody tr');
  assert.equal(rows.length, 2);
  assert.equal((rows[0].querySelector('[data-subfield="Item"]') as HTMLInputElement).value, 'Bolt');
  assert.equal((rows[1].querySelector('[data-subfield="Qty"]') as HTMLInputElement).value, '2');
});

test('openUrl notes the URL and opens a new window; same window assigns location', async () => {
  const { runtime, nav, doc, win } = await setup(`\tform Order\n\t{\n${field('Name', 'text')}\n\t}`);
  const formEl = doc.querySelector('form');
  const opened: string[][] = [];
  (win as unknown as { open: (...a: string[]) => null }).open = (...a: string[]) => {
    opened.push(a);
    return null;
  };
  const notes = runtime.applyActions([{ op: 'openUrl', args: ['https://example.test/x', 'new window'] }], formEl);
  assert.deepEqual(notes, ['https://example.test/x']);
  assert.deepEqual(opened, [['https://example.test/x', '_blank', undefined]]);
  // A popup window opens a named popup; a same-window navigation assigns the
  // page location and opens nothing.
  runtime.applyActions([{ op: 'openUrl', args: ['https://example.test/p', 'popup window'] }], formEl);
  assert.deepEqual(opened[1], ['https://example.test/p', '_blank', 'popup']);
  assert.deepEqual(nav.assigned, []);
  const same = runtime.applyActions([{ op: 'openUrl', args: ['https://example.test/s', 'same window'] }], formEl);
  assert.deepEqual(same, ['https://example.test/s']);
  assert.deepEqual(nav.assigned, ['https://example.test/s']);
  assert.equal(opened.length, 2);
  assert.equal(nav.reloads, 0);
});

test('openUrl refuses a non-web scheme and says so instead of navigating', async () => {
  const { runtime, nav, doc, win } = await setup(`\tform Order\n\t{\n${field('Name', 'text')}\n\t}`);
  const formEl = doc.querySelector('form');
  const banner = doc.querySelector('[data-banner]')!;
  const opened: string[][] = [];
  (win as unknown as { open: (...a: string[]) => null }).open = (...a: string[]) => {
    opened.push(a);
    return null;
  };
  const refused = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    '\tjavascript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,x',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ];
  for (const target of ['same window', 'new window', 'popup window', 'parent window']) {
    for (const url of refused) {
      banner.textContent = '';
      const notes = runtime.applyActions([{ op: 'openUrl', args: [url, target] }], formEl);
      assert.deepEqual(notes, ['openUrl refused'], `${target}: ${JSON.stringify(url)}`);
      assert.equal(banner.textContent, 'The link was not opened: the address is not allowed.', `${target}: ${JSON.stringify(url)}`);
      assert.equal(opened.length, 0, `${target}: ${JSON.stringify(url)}`);
      assert.deepEqual(nav.assigned, [], `${target}: ${JSON.stringify(url)}`);
    }
  }
});

test('openUrl still navigates anchors, relative paths, and scheme-relative addresses', async () => {
  const { runtime, doc, win } = await setup(`\tform Order\n\t{\n${field('Name', 'text')}\n\t}`);
  const formEl = doc.querySelector('form');
  const opened: string[][] = [];
  (win as unknown as { open: (...a: string[]) => null }).open = (...a: string[]) => {
    opened.push(a);
    return null;
  };
  // `#Form:`/`#Report:` are the in-app links a page snippet emits.
  for (const url of ['#Form:Add_Firm', '#Report:Report_Stock', '/reports/Report_Stock', '?view=grid']) {
    const notes = runtime.applyActions([{ op: 'openUrl', args: [url, 'new window'] }], formEl);
    assert.deepEqual(notes, [url], url);
  }
  assert.deepEqual(
    opened.map((a) => a[0]),
    ['#Form:Add_Firm', '#Report:Report_Stock', '/reports/Report_Stock', '?view=grid'],
  );
  // `//host/path` inherits the page's scheme — https on a deployed app — so
  // it reaches the same place an `https:` URL does and stays allowed.
  runtime.applyActions([{ op: 'openUrl', args: ['//cdn.example.test/x', 'new window'] }], formEl);
  assert.deepEqual(opened[4], ['//cdn.example.test/x', '_blank', undefined]);
});

test('reload is recorded and reloads the page', async () => {
  const { runtime, nav, doc } = await setup(`\tform Order\n\t{\n${field('Name', 'text')}\n\t}`);
  const notes = runtime.applyActions([{ op: 'reload' }], doc.querySelector('form'));
  assert.deepEqual(notes, ['reload']);
  assert.equal(nav.reloads, 1);
  assert.deepEqual(nav.assigned, []);
});
