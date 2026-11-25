/**
 * The generated page client's half of the report custom action navigation
 * protocol (docs/report-action-navigation.md): `runtime/navigation.ts`'s
 * `navOk` and `performActionNav`, compiled from the real template source
 * exactly like report-view.test.ts does for ReportView, so this pins the
 * ACTUAL shipped runtime, not a reimplementation of it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { TEMPLATE_DIR, compileTemplateLib } from '../src/index.js';

const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react'));
const MISSING = 'template runtime dependencies are not installed: run `npm ci --prefix packages/ui-react/template`';
const SKIP = runtimeReady ? false : process.env.CI === 'true' ? false : MISSING;

async function loadNavigation(t: { after(fn: () => void): void }) {
  assert.ok(runtimeReady, MISSING);
  const out = mkdtempSync(join(tmpdir(), 'c2c-nav-runtime-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compileTemplateLib(out);
  return (await import(pathToFileURL(join(out, 'lib/c2c-ui/runtime/navigation.js')).href)) as {
    navOk: (url: unknown, allowedHosts: readonly string[]) => boolean;
    performActionNav: (nav: unknown, allowedHosts: readonly string[], view: unknown) => void;
  };
}

const ALLOWED = ['allowed.example', 'allowed.example.com'];

/**
 * [label, url, expected navOk(url, ALLOWED) result] — the same attack classes pinned in packages/ui/test/navigation-policy.test.ts, run here against the ACTUAL shipped client copy.
 *
 * The userinfo-trick vectors below all pair an ALLOWED host as the userinfo with a non-allowed
 * host as the real authority, so correct parsing (host taken after the LAST '@') and a naive
 * parse (host taken before the first '@' or before the first ':') disagree: naive parsing would
 * read the ALLOWED-looking userinfo back as the host and wrongly allow. Each must still refuse.
 */
const VECTORS: Array<[string, string, boolean]> = [
  ['same-app hash route', '#/report/Orders', true],
  ['a #Script page command is no address', '#Script:dialog.close', false],
  ['relative path', '/report/Orders', true],
  ['allowlisted https host', 'https://allowed.example/doc', true],
  ['literal javascript: scheme', 'javascript:alert(1)', false],
  ['literal data: scheme', 'data:text/html,x', false],
  ['literal vbscript: scheme', 'vbscript:msgbox(1)', false],
  ['literal file: scheme', 'file:///etc/passwd', false],
  ['javascript: scheme hidden by an embedded tab', 'java\tscript:alert(1)', false],
  ['protocol-relative open redirect', '//evil.example/x', false],
  ['protocol-relative open redirect to an allowlisted-looking host', '//allowed.example/x', false],
  ['plain http to an allowlisted host', 'http://allowed.example/doc', false],
  ['https host not on the allowlist', 'https://evil.example/x', false],
  ['https userinfo trick: attacker host after an allowed-looking userinfo', 'https://allowed.example.com@evil.example.com/x', false],
  ['https userinfo trick with a colon-separated password', 'https://allowed.example.com:s3cret@evil.example.com/x', false],
  ['https credentials on an ALLOWED host still reach the browser', 'https://attacker:password@allowed.example/', false],
  ['https empty-password credentials on an allowed host', 'https://attacker:@allowed.example/x', false],
  ['https allowed host as its own userinfo', ['https://allowed.example', 'allowed.example/x'].join(String.fromCharCode(64)), false],
  ['https userinfo trick: attacker host is a Cyrillic look-alike of the allowed host', 'https://allowed.example.com@аllowed.example.com/x', false],
  ['https userinfo trick: a backslash truncates the authority right after the attacker host', 'https://allowed.example.com@ev\\il.example.com/x', false],
  ['relative path carrying an embedded backslash', '/\\evil.example', false],
];

test('the compiled client navOk refuses every denied class and allows only same-app routes and allowlisted https hosts', { skip: SKIP }, async (t) => {
  const { navOk } = await loadNavigation(t);
  for (const [label, url, expected] of VECTORS) {
    assert.equal(navOk(url, ALLOWED), expected, `${label}: navOk(${JSON.stringify(url)})`);
  }
});

test('performActionNav navigates a same-app hash route in the current tab via the hash router', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  const view = { location: { hash: '', href: 'https://app.example/' }, open: () => assert.fail('should not open a new tab') };
  performActionNav({ kind: 'navigate', url: '#/report/Orders' }, [], view);
  assert.equal(view.location.hash, '#/report/Orders');
});

test('performActionNav opens target "new" in a new tab with noopener,noreferrer, never the current tab', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  const opened: unknown[] = [];
  const view = { location: { hash: '', href: 'https://app.example/' }, open: (...args: unknown[]) => opened.push(args) };
  performActionNav({ kind: 'navigate', url: '#/report/Orders', target: 'new' }, [], view);
  assert.deepEqual(opened, [['#/report/Orders', '_blank', 'noopener,noreferrer']]);
  assert.equal(view.location.hash, '', 'the current tab never navigates when target is "new"');
});

test('performActionNav silently does nothing for a refused target — the action still ran, but nothing navigates', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  const view = { location: { hash: '', href: 'https://app.example/' }, open: () => assert.fail('should not open a new tab') };
  performActionNav({ kind: 'navigate', url: 'javascript:alert(1)' }, [], view);
  assert.equal(view.location.hash, '');
  assert.equal(view.location.href, 'https://app.example/');
  performActionNav({ kind: 'navigate', url: 'https://evil.example/x' }, [], view);
  assert.equal(view.location.href, 'https://app.example/');
  performActionNav(undefined, [], view);
  assert.equal(view.location.href, 'https://app.example/');
});

test('performActionNav navigates an allowlisted https host in the current tab via location.href', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  const view = { location: { hash: '', href: 'https://app.example/' }, open: () => assert.fail('should not open a new tab') };
  performActionNav({ kind: 'navigate', url: 'https://allowed.example/doc' }, ALLOWED, view);
  assert.equal(view.location.href, 'https://allowed.example/doc');
});

test('the page commands act on the page itself and never navigate', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  const page = (opener: boolean, history = 1) => {
    const events: string[] = [];
    const view = {
      location: { hash: '', href: 'https://app.example/', reload: () => events.push('reload'), assign: () => events.push('assign') },
      open: () => events.push('open'),
      close: () => events.push('close'),
      history: { length: history, back: () => events.push('back') },
      opener: opener ? { closed: false, location: { reload: () => events.push('opener reload') } } : null,
    };
    return { events, view };
  };
  const run = (kind: string, opener: boolean, history?: number) => {
    const { events, view } = page(opener, history);
    performActionNav({ kind } as never, [], view);
    assert.equal(view.location.hash, '');
    assert.equal(view.location.href, 'https://app.example/');
    return events;
  };
  // A popup this app opened for a form: dialog.close and page.close close it; the parent refreshes the opener.
  assert.deepEqual(run('closeDialog', true), ['close']);
  assert.deepEqual(run('closePage', true), ['close']);
  assert.deepEqual(run('refreshParent', true), ['opener reload']);
  // In the main window no dialog is open, so dialog.close is a deliberate no-op; page.close goes back; the parent is the page itself.
  assert.deepEqual(run('closeDialog', false, 3), []);
  assert.deepEqual(run('closePage', false, 3), ['back']);
  assert.deepEqual(run('closePage', false, 1), []);
  assert.deepEqual(run('refreshParent', false), ['reload']);
  // An unknown kind does nothing.
  assert.deepEqual(run('explode', true, 3), []);
});

test('performActionNav refuses a hostile target a workflow built at run time: script URL, protocol-relative host, userinfo trick', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  const hostile = ['javascript:alert(document.cookie)', ' JaVa\tScRiPt:alert(1)', '//evil.example/x', 'https://allowed.example.com@evil.example.com/x', 'https://user:pw@evil.example/x', 'data:text/html,x'];
  for (const url of hostile) {
    for (const target of ['same', 'new'] as const) {
      const view = { location: { hash: '', href: 'https://app.example/', reload: () => assert.fail('no reload') }, open: () => assert.fail(`opened ${url}`) };
      performActionNav({ kind: 'navigate', url, target }, ALLOWED, view);
      assert.equal(view.location.hash, '', `${url} (${target}) changed the route`);
      assert.equal(view.location.href, 'https://app.example/', `${url} (${target}) navigated`);
    }
  }
});

test('performActionNav reloads the page for a reload instruction (a page refresh in the workflow)', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  let reloads = 0;
  const view = { location: { hash: '', href: 'https://app.example/', reload: () => (reloads += 1) }, open: () => assert.fail('no new tab') };
  performActionNav({ kind: 'reload' }, [], view);
  assert.equal(reloads, 1);
});

test('performActionNav ignores an instruction that only inherits its kind, url or target', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  const calls: string[] = [];
  const view = { location: { hash: '', href: 'https://app.example/', reload: () => calls.push('reload') }, open: (...args: unknown[]) => calls.push(`open ${String(args[0])}`) };
  performActionNav(Object.create({ kind: 'reload' }), ALLOWED, view);
  performActionNav(Object.create({ kind: 'navigate', url: 'https://allowed.example/x', target: 'new' }), ALLOWED, view);
  performActionNav({ kind: 'navigate', target: 'new', ...Object.create({ url: 'https://allowed.example/x' }) }, ALLOWED, view);
  assert.deepEqual(calls, []);
  assert.equal(view.location.href, 'https://app.example/');
});
