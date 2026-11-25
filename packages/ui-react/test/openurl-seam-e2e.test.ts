import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { TEMPLATE_DIR, compileTemplateLib } from '../src/index.js';

// React template seam gate for the same four generated gallery apps as the
// vanilla test.  The server response is intentionally a contract fixture.
const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react'));
const MISSING = 'template runtime dependencies are not installed: run `npm ci --prefix packages/ui-react/template`';
const SKIP = runtimeReady ? false : process.env.CI === 'true' ? false : MISSING;

async function loadNavigation(t: { after(fn: () => void): void }) {
  assert.ok(runtimeReady, MISSING);
  const out = mkdtempSync(join(tmpdir(), 'c2c-openurl-runtime-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compileTemplateLib(out);
  return import(pathToFileURL(join(out, 'lib/c2c-ui/runtime/navigation.js')).href) as Promise<{ applyOpenUrlNav: (...args: any[]) => void }>;
}

test('React generated action applies ordered nav response', { skip: SKIP, todo: 'server lane c2c-kpi-openurl-fn-capture' }, async (t) => {
  const navigation = await loadNavigation(t);
  assert.equal(typeof navigation.applyOpenUrlNav, 'function');
  const effects: string[] = [];
  const opened: unknown[] = [];
  const view = { location: { hash: '', href: 'https://app.example/' }, open: (...args: unknown[]) => opened.push(args) } as any;
  navigation.applyOpenUrlNav([
    { url: '#Script:page.refresh', window: 'same window' },
    { url: '#Script:dialog.close', window: 'popup window' },
    { url: 'https://allowed.example/arrival', window: 'new window' },
  ], ['allowed.example'], view, { refresh: () => effects.push('refresh'), closeDialog: () => effects.push('dialog') });
  assert.deepEqual(effects, ['refresh', 'dialog']);
  assert.deepEqual(opened, [['https://allowed.example/arrival', '_blank', 'noopener,noreferrer']]);
});

test('React generated action refuses hostile returned URLs', { skip: SKIP, todo: 'server lane c2c-kpi-openurl-fn-capture' }, async (t) => {
  const navigation = await loadNavigation(t);
  const opened: unknown[] = [];
  const view = { location: { hash: '', href: 'https://app.example/' }, open: (...args: unknown[]) => opened.push(args) } as any;
  navigation.applyOpenUrlNav([{ url: 'javascript:alert(1)', window: 'new window' }, { url: '//evil.example/x', window: 'new window' }], [], view);
  assert.deepEqual(opened, []);
});
