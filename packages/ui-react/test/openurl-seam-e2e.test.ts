import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { TEMPLATE_DIR, compileTemplateLib } from '../src/index.js';
import { SCRIPT_TARGETS, runScriptNavEndpoint, scriptNavSource, type ScriptShape } from '../../ui/test/support/script-nav-app.js';

// The React page's half of the one navigation protocol: every `#Script:`
// target Creator documents is generated from a gallery-shaped .ds, run
// through the generated endpoint, and its reply applied by the shipped
// `performActionNav`. The vanilla page proves the same set in packages/ui.
const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react'));
const MISSING = 'template runtime dependencies are not installed: run `npm ci --prefix packages/ui-react/template`';
const SKIP = runtimeReady ? false : process.env.CI === 'true' ? false : MISSING;

type Nav = { performActionNav: (nav: unknown, allowedHosts: readonly string[], view: unknown) => void } & Record<string, unknown>;

async function loadNavigation(t: { after(fn: () => void): void }): Promise<Nav> {
  assert.ok(runtimeReady, MISSING);
  const out = mkdtempSync(join(tmpdir(), 'c2c-openurl-runtime-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compileTemplateLib(out);
  const navigation = (await import(pathToFileURL(join(out, 'lib/c2c-ui/runtime/navigation.js')).href)) as Nav;
  assert.equal('applyOpenUrlNav' in navigation, false, 'the old nav-list applier is gone: there is one protocol');
  return navigation;
}

function page(opts: { opener?: boolean; history?: number } = {}) {
  const events: string[] = [];
  const view = {
    location: { hash: '', href: 'https://app.example/', reload: () => events.push('reload') },
    open: (...args: unknown[]) => events.push(`open ${args.join(' ')}`),
    close: () => events.push('close'),
    history: { length: opts.history ?? 1, back: () => events.push('back') },
    opener: opts.opener ? { closed: false, location: { reload: () => events.push('opener reload') } } : null,
  };
  return { events, view };
}

test('navigate in the same window sets the route, in a new window opens it detached', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  const same = page();
  performActionNav({ kind: 'navigate', url: '#/report/Orders', target: 'same' }, [], same.view);
  assert.equal(same.view.location.hash, '#/report/Orders');
  assert.deepEqual(same.events, []);
  const path = page();
  performActionNav({ kind: 'navigate', url: '/report/Orders' }, [], path.view);
  assert.equal(path.view.location.href, '/report/Orders');
  const fresh = page();
  performActionNav({ kind: 'navigate', url: 'https://allowed.example/arrival', target: 'new' }, ['allowed.example'], fresh.view);
  assert.deepEqual(fresh.events, ['open https://allowed.example/arrival _blank noopener,noreferrer']);
});

test('React refuses hostile addresses and an unknown kind at run time', { skip: SKIP }, async (t) => {
  const { performActionNav } = await loadNavigation(t);
  for (const url of ['javascript:alert(1)', '//evil.example/x', 'https://user:pass@evil.example/x', 'https://evil.example/x', '#Script:window.close']) {
    for (const target of ['same', 'new']) {
      const hostile = page();
      performActionNav({ kind: 'navigate', url: url.startsWith('#Script') ? url.replace('#Script:', 'javascript:') : url, target }, ['allowed.example'], hostile.view);
      assert.deepEqual(hostile.events, [], `${url} (${target})`);
      assert.equal(hostile.view.location.hash, '');
    }
  }
  const unknown = page({ opener: true, history: 3 });
  for (const nav of [{ kind: 'explode' }, {}, null, undefined]) performActionNav(nav, [], unknown.view);
  assert.deepEqual(unknown.events, []);
});

const EVENTS: Record<string, string[]> = {
  reload: ['reload'],
  closeDialog: ['close'],
  closePage: ['close'],
  refreshParent: ['opener reload'],
};

for (const shape of ['after-server-work', 'navigation-only'] as ScriptShape[]) {
  for (const [script, kind] of SCRIPT_TARGETS) {
    test(`${script} (${shape}) is carried from the generated endpoint to the React page`, { skip: SKIP }, async (t) => {
      const { performActionNav } = await loadNavigation(t);
      const reply = await runScriptNavEndpoint(scriptNavSource(script, shape));
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.deepEqual(reply.body.nav, { kind });
      assert.equal(reply.status_after, shape === 'after-server-work' ? 'Closed' : 'Open');
      assert.deepEqual(reply.manualSteps.filter((step) => /navigation|openUrl/i.test(step)), []);
      // A popup opened by another page, where all three page commands have something to act on.
      const popup = page({ opener: true });
      performActionNav(reply.body.nav, [], popup.view);
      assert.deepEqual(popup.events, EVENTS[kind]);
    });
  }
}
