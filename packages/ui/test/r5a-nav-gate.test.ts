/** R5-A: the vanilla client acts on a server-returned navigation only inside the app, as docs/report-action-navigation.md and the React client (navOk) do. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientRuntimeSource } from '../src/generate.js';

async function apply() {
  const client = (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as { applyActionNav(root: unknown, nav: unknown): void };
  return client.applyActionNav;
}

function fakePage() {
  const calls = { assigned: [] as string[], opened: [] as unknown[][] };
  const view = { location: { href: 'https://app.example/', assign: (u: string) => calls.assigned.push(u) }, open: (...a: unknown[]) => calls.opened.push(a) };
  return { calls, root: { ownerDocument: { defaultView: view }, querySelector: () => null } };
}

test('R5A-F5: a server navigation to an external https or http address is refused, same window and new', async () => {
  const run = await apply();
  for (const target of ['same', 'new']) {
    for (const url of ['https://evil.example/phish', 'http://evil.example/', 'HTTPS://EVIL.EXAMPLE/', 'https://allowed.example/doc']) {
      const { calls, root } = fakePage();
      run(root, { kind: 'navigate', url, target });
      assert.deepEqual([calls.assigned, calls.opened], [[], []], `${target} ${url}`);
    }
  }
});

test('R5A-F5: a same-app hash route and a single-slash path still navigate', async () => {
  const run = await apply();
  const a = fakePage();
  run(a.root, { kind: 'navigate', url: '#/report/Orders', target: 'same' });
  assert.deepEqual(a.calls.assigned, ['#/report/Orders']);
  const b = fakePage();
  run(b.root, { kind: 'navigate', url: '/report/Orders', target: 'new' });
  assert.deepEqual(b.calls.opened, [['/report/Orders', '_blank', 'noopener,noreferrer']]);
});
