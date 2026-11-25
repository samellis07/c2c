/**
 * A link written `<app address>view-embed/Name?x=1` names the embedded view of
 * a page or report. The app opens that name at its own route, the way a
 * `#View:Name` link does; a name the app does not have gets no route.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime, type NavInstruction, type NavRoutes } from '../src/runtime.js';

const routes: NavRoutes = {
  forms: { Notes: ['Body'] },
  reports: { All_Notes: ['Body'] },
  pages: { Calendar: ['dateVal', 'usermailid'], Chart: ['dayVal'] },
};

function resolve(url: string, options?: { ignoreUndeclared?: boolean }): NavInstruction | null {
  const nav = (createRuntime({ dryRun: true, appTimeZone: 'UTC' }).shim as unknown as {
    nav: { resolve(result: unknown, routes?: NavRoutes, options?: { ignoreUndeclared?: boolean }): NavInstruction | null };
  }).nav;
  return nav.resolve({ kind: 'navigate', url, target: 'same' }, routes, options);
}

test('an embedded page link opens the page route with the parameters the page declares', () => {
  const first = resolve('[object Object]view-embed/Calendar?dateVal=28-Feb-2026&&usermailid=a-mail&zc_Header=false');
  assert.deepEqual(first, { kind: 'navigate', url: '#/page/Calendar?dateVal=28-Feb-2026&usermailid=a-mail', target: 'same' });
  assert.deepEqual(resolve('page-embed/Chart?dayVal=01-Mar-2026'), { kind: 'navigate', url: '#/page/Chart?dayVal=01-Mar-2026', target: 'same' });
});

test('the app address in front of an embedded view is no part of the route', () => {
  const hosted = resolve('https://host.example/owner/app/view-embed/Chart?dayVal=2');
  assert.deepEqual(hosted, { kind: 'navigate', url: '#/page/Chart?dayVal=2', target: 'same' });
});

test('an embedded report opens the report route and one the app lacks gets none', () => {
  assert.deepEqual(resolve('view-embed/All_Notes'), { kind: 'navigate', url: '#/report/All_Notes', target: 'same' });
  assert.equal(resolve('view-embed/Missing?x=1'), null);
  assert.equal(resolve('view-embed/Calendar?other=1'), null);
  assert.deepEqual(resolve('view-embed/Calendar?other=1', { ignoreUndeclared: true }), { kind: 'navigate', url: '#/page/Calendar', target: 'same' });
});

test('a path that only contains the embed words is not an embedded view', () => {
  for (const url of ['view-embed/Calendar/extra', 'my-view-embed/Calendar', 'view-embed/', 'x/view-embed.js']) {
    const out = resolve(url);
    assert.ok(out === null || out.kind !== 'navigate' || !out.url.startsWith('#/'), url);
  }
});

test('legacy #From links resolve to a declared report route with safe filtering', () => {
  assert.deepEqual(resolve('#From:All_Notes?Body=hello'), {
    kind: 'navigate', url: '#/report/All_Notes?Body=hello', target: 'same',
  });
  assert.equal(resolve('#From:All_Notes?Body=hello&ignored=nope'), null);
  assert.equal(resolve('#From:All_Notes?Body=one&Body=two'), null);
  assert.equal(resolve('#From:Missing?Body=hello'), null);
});

test('navigation instructions require an own url property', () => {
  const inherited = Object.create({ url: '#From:All_Notes' }) as { kind: string; target: string };
  inherited.kind = 'navigate';
  inherited.target = 'same';
  const nav = (createRuntime({ dryRun: true, appTimeZone: 'UTC' }).shim as unknown as {
    nav: { resolve(result: unknown, routes?: NavRoutes): NavInstruction | null };
  }).nav;
  assert.equal(nav.resolve(inherited, routes), null);
});
