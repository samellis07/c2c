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
  const apply = client.applyOpenUrlNav;
  assert.equal(typeof apply, 'function', 'client runtime must expose the openUrl seam');
  const dom = new JSDOM('<!doctype html><body><div data-banner></div></body>', { url: 'https://app.example/' });
  const effects: unknown[] = [];
  (dom as any).window.open = (url: string) => {
    effects.push(['new', url]);
    return null;
  };
  (apply as (root: unknown, nav: unknown, effects?: unknown) => void)((dom as any).window.document.body, NAV, { refresh: () => effects.push(['reload']), closeDialog: () => effects.push(['dialog']), refreshParent: () => effects.push(['parent']) });
  assert.deepEqual(effects, [['reload'], ['dialog'], ['parent'], ['new', 'https://allowed.example/arrival']]);
  void dom;
});

test('generated action refuses hostile returned URLs and preserves order', async () => {
  const client = await runtime();
  const apply = client.applyOpenUrlNav;
  assert.equal(typeof apply, 'function', 'client runtime must expose the openUrl seam');
  const effects: unknown[] = [];
  (apply as (root: unknown, nav: unknown, effects?: unknown) => void)({ querySelector: () => null, location: { href: 'https://app.example/', assign: (u: string) => effects.push(u) }, open: (u: string) => effects.push(u) }, [
    { url: 'javascript:alert(1)', window: 'same window' },
    { url: '//evil.example/x', window: 'new window' },
    { url: 'https://user:pass@evil.example/x', window: 'new window' },
  ], {});
  assert.deepEqual(effects, []);
});
