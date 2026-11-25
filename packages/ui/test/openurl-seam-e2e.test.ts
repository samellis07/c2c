import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';

// Seam gate: these four gallery shapes are admission-management,
// hotel-management, loaner and corporate-travel-management.  The generated
// endpoint is stubbed here; server capture and client application are owned by
// the openUrl server/client lanes respectively.
const NAV = [
  { url: '#Script:page.refresh', window: 'same window' },
  { url: '#Script:dialog.close', window: 'popup window' },
  { url: '#Script:page.parent.refresh', window: 'same window' },
  { url: 'https://allowed.example/arrival', window: 'new window' },
] as const;

const source = `application "Seam"
{
\tform Item { Name ( type = text ) }
\tlist Items { show all rows from Item ( Name custom action "Open" ( workflow = Open ) ) }
\tworkflow { functions { Open as "Open" { type = functions form = Item on start { actions { on click ( openUrl("#Script:page.refresh","same window"); ) } } } } }
}`;

async function runtime() {
  const { clientRuntimeSource } = await import('../src/generate.js');
  return (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as Record<string, unknown>;
}

test('generated report action applies ordered server nav, pseudo routes and URL policy', async () => {
  const built = buildUi(deriveIr(parse(source)));
  assert.ok(built.files.some((file) => file.path.includes('open')));
  const client = await runtime();
  // CLIENT lane: export/apply the response seam from the shipped vanilla runtime.
  const apply = client.applyServerNavigation;
  assert.equal(typeof apply, 'function', 'client runtime must expose the server-nav seam');
  const dom = new JSDOM('<!doctype html><body><div data-banner></div></body>', { url: 'https://app.example/' });
  const effects: unknown[] = [];
  (apply as (response: unknown, view: unknown, effects?: unknown[]) => void)({ nav: NAV }, { location: { assign: (u: string) => effects.push(['same', u]), reload: () => effects.push(['reload']), href: 'https://app.example/' }, open: (u: string) => effects.push(['new', u]) }, effects);
  assert.deepEqual(effects, [['reload'], ['new', 'https://allowed.example/arrival']]);
  void dom;
});

test('generated action refuses hostile returned URLs and preserves order', async () => {
  const client = await runtime();
  const apply = client.applyServerNavigation;
  assert.equal(typeof apply, 'function', 'client runtime must expose the server-nav seam');
  const effects: unknown[] = [];
  (apply as (response: unknown, view: unknown, effects?: unknown[]) => void)({ nav: [
    { url: 'javascript:alert(1)', window: 'same window' },
    { url: '//evil.example/x', window: 'new window' },
    { url: 'https://user:pass@evil.example/x', window: 'new window' },
  ] }, { location: { href: 'https://app.example/', assign: (u: string) => effects.push(u) }, open: (u: string) => effects.push(u) }, effects);
  assert.deepEqual(effects, []);
});
