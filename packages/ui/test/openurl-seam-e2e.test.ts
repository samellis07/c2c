/**
 * The vanilla page's half of the one navigation protocol (docs/report-action-
 * navigation.md): the instruction a custom action's reply carries is applied
 * by `applyActionNav` through the page's single address gate. Each kind is
 * pinned on its own, hostile addresses are refused at run time, and every
 * `#Script:` target Creator documents is proved end to end: generated from a
 * gallery-shaped .ds, run through the generated endpoint, applied in jsdom.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { clientRuntimeSource } from '../src/generate.js';
import { SCRIPT_TARGETS, runScriptNavEndpoint, scriptNavSource, type ScriptShape } from './support/script-nav-app.js';

type ApplyActionNav = (root: unknown, nav: unknown, source?: unknown) => void;

async function runtime() {
  return (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as Record<string, unknown>;
}

async function applyActionNav(): Promise<ApplyActionNav> {
  const client = await runtime();
  assert.equal(typeof client.applyActionNav, 'function', 'the client runtime must expose the navigation applier');
  assert.equal('applyOpenUrlNav' in client, false, 'the old nav-list applier is gone: there is one protocol');
  return client.applyActionNav as ApplyActionNav;
}

const docOf = (dom: JSDOM): Document => (dom.window as unknown as Window).document;

interface Calls {
  assigned: string[];
  opened: unknown[][];
  reloaded: string[];
  closed: string[];
  back: string[];
}

/** A page whose navigation entry points only record what they were asked to do. */
function fakePage(opts: { opener?: boolean; history?: number } = {}) {
  const calls: Calls = { assigned: [], opened: [], reloaded: [], closed: [], back: [] };
  const opener = opts.opener ? { closed: false, location: { reload: () => calls.reloaded.push('opener') } } : null;
  const view = {
    location: { href: 'https://app.example/', assign: (u: string) => calls.assigned.push(u), reload: () => calls.reloaded.push('page') },
    open: (...args: unknown[]) => calls.opened.push(args),
    close: () => calls.closed.push('page'),
    history: { length: opts.history ?? 1, back: () => calls.back.push('page') },
    opener,
    parent: undefined as unknown,
    document: undefined as unknown,
  };
  view.parent = view;
  const root = { ownerDocument: { defaultView: view }, querySelector: () => null };
  return { calls, view, root };
}

test('navigate in the same window goes through the address gate', async () => {
  const apply = await applyActionNav();
  const { calls, root } = fakePage();
  apply(root, { kind: 'navigate', url: '#/report/Orders', target: 'same' });
  assert.deepEqual(calls.assigned, ['#/report/Orders']);
  assert.deepEqual(calls.opened, []);
});

test('navigate to a new window opens it without a handle back to the page', async () => {
  const apply = await applyActionNav();
  const { calls, root } = fakePage();
  apply(root, { kind: 'navigate', url: '/report/Orders', target: 'new' });
  assert.deepEqual(calls.opened, [['/report/Orders', '_blank', 'noopener,noreferrer']]);
  assert.deepEqual(calls.assigned, []);
});

test('reload loads the page again', async () => {
  const apply = await applyActionNav();
  const { calls, root } = fakePage();
  apply(root, { kind: 'reload' });
  assert.deepEqual(calls.reloaded, ['page']);
});

test('closeDialog removes the dialog that holds the clicked button, and only that one', async () => {
  const apply = await applyActionNav();
  const dom = new JSDOM('<!doctype html><body><div class="modal" data-modal-form="A"><button id="a"></button></div><div class="modal" data-modal-form="B"><button id="b"></button></div></body>');
  const doc = docOf(dom);
  apply(doc.body, { kind: 'closeDialog' }, doc.getElementById('a'));
  assert.deepEqual([...doc.querySelectorAll('.modal')].map((el) => el.getAttribute('data-modal-form')), ['B']);
  // With no clicked element it closes the dialog opened last.
  apply(doc.body, { kind: 'closeDialog' });
  assert.equal(doc.querySelectorAll('.modal').length, 0);
  // With no dialog open there is nothing to close.
  apply(doc.body, { kind: 'closeDialog' });
});

test('closePage closes a popup, and goes back when the page was not opened by a script', async () => {
  const apply = await applyActionNav();
  const popup = fakePage({ opener: true });
  apply(popup.root, { kind: 'closePage' });
  assert.deepEqual([popup.calls.closed, popup.calls.back], [['page'], []]);
  const main = fakePage({ history: 3 });
  apply(main.root, { kind: 'closePage' });
  assert.deepEqual([main.calls.closed, main.calls.back], [[], ['page']]);
  const alone = fakePage();
  apply(alone.root, { kind: 'closePage' });
  assert.deepEqual([alone.calls.closed, alone.calls.back], [[], []], 'a page with nowhere to go stays put');
});

test('refreshParent reloads the page that opened this one, or this page when it has no opener', async () => {
  const apply = await applyActionNav();
  const popup = fakePage({ opener: true });
  apply(popup.root, { kind: 'refreshParent' });
  assert.deepEqual(popup.calls.reloaded, ['opener']);
  const main = fakePage();
  apply(main.root, { kind: 'refreshParent' });
  assert.deepEqual(main.calls.reloaded, ['page']);
});

test('hostile addresses a workflow built at run time are refused, same window and new', async () => {
  const apply = await applyActionNav();
  for (const url of ['javascript:alert(1)', ' JaVa\tScRiPt:alert(1)', '//evil.example/x', 'https://user:pass@evil.example/x', 'data:text/html,x', '#Script:window.close']) {
    for (const target of ['same', 'new']) {
      const { calls, root } = fakePage();
      apply(root, { kind: 'navigate', url, target });
      assert.deepEqual([calls.assigned, calls.opened], [[], []], `${url} (${target}) navigated`);
    }
  }
});

test('an unknown kind, a missing instruction or a non-object does nothing', async () => {
  const apply = await applyActionNav();
  const { calls, root } = fakePage({ opener: true, history: 3 });
  for (const nav of [{ kind: 'explode', url: '#/x' }, {}, null, undefined, 'reload', 42, []]) apply(root, nav);
  assert.deepEqual(calls, { assigned: [], opened: [], reloaded: [], closed: [], back: [] });
});

const EXPECTED: Record<string, (page: ReturnType<typeof fakePage>, dom: JSDOM) => void> = {
  reload: ({ calls }) => assert.deepEqual(calls.reloaded, ['page']),
  closeDialog: (_page, dom) => assert.equal(docOf(dom).querySelectorAll('.modal').length, 0),
  closePage: ({ calls }) => assert.deepEqual(calls.closed, ['page']),
  refreshParent: ({ calls }) => assert.deepEqual(calls.reloaded, ['opener']),
};

for (const shape of ['after-server-work', 'navigation-only'] as ScriptShape[]) {
  for (const [script, kind] of SCRIPT_TARGETS) {
    test(`${script} (${shape}) is carried from the generated endpoint to the page`, async () => {
      const apply = await applyActionNav();
      const reply = await runScriptNavEndpoint(scriptNavSource(script, shape));
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.wrote, true);
      assert.deepEqual(reply.body.nav, { kind }, 'the reply carries the page command');
      assert.equal(reply.status_after, shape === 'after-server-work' ? 'Closed' : 'Open', 'the workflow ran its own work exactly as written');
      assert.deepEqual(reply.manualSteps.filter((step) => /navigation|openUrl/i.test(step)), [], 'nothing is left as a manual step');
      // Apply it as the page would: a popup holding a dialog, opened by another page.
      const dom = new JSDOM('<!doctype html><body><div class="modal" data-modal-form="Item"><button id="go"></button></div></body>');
      const page = fakePage({ opener: true });
      const root = { ownerDocument: { defaultView: page.view }, querySelector: () => null };
      page.view.document = docOf(dom);
      apply(root, reply.body.nav, docOf(dom).getElementById('go'));
      EXPECTED[kind]!(page, dom);
    });
  }
}

test('an unknown #Script target stays a counted manual step instead of becoming a navigation', async () => {
  const reply = await runScriptNavEndpoint(scriptNavSource('#Script:window.print', 'after-server-work'));
  assert.equal('nav' in reply.body, false, 'no instruction is carried');
  assert.ok(reply.manualSteps.some((step) => /navigation/i.test(step)), `counted with its location: ${reply.manualSteps}`);
});

test('a form workflow\'s openUrl("#Script:...") runs the same page command, and an unknown one is refused visibly', async () => {
  const client = await runtime();
  const applyActions = client.applyActions as (actions: unknown[], root: unknown) => string[];
  for (const [script, kind] of SCRIPT_TARGETS) {
    const page = fakePage({ opener: true });
    const notes = applyActions([{ op: 'openUrl', args: [script, 'same window'] }], page.root);
    assert.deepEqual(notes, [script]);
    assert.deepEqual(page.calls.assigned, [], `${script} must never be written to the address bar`);
    if (kind === 'reload') assert.deepEqual(page.calls.reloaded, ['page']);
    if (kind === 'closePage') assert.deepEqual(page.calls.closed, ['page']);
    if (kind === 'refreshParent') assert.deepEqual(page.calls.reloaded, ['opener']);
  }
  const page = fakePage();
  const notes = applyActions([{ op: 'openUrl', args: ['#Script:window.print', 'same window'] }], page.root);
  assert.deepEqual(notes, ['openUrl refused']);
  assert.deepEqual(page.calls.assigned, []);
});
