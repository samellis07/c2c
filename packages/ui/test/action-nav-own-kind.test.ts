import assert from 'node:assert/strict';
import { test } from 'node:test';

test('applyActionNav ignores an instruction that only inherits its kind, url or target', async () => {
  const { clientRuntimeSource } = await import('../src/generate.js');
  const runtime = (await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`)) as {
    applyActionNav(root: unknown, nav: unknown, source?: unknown): void;
  };
  const calls: string[] = [];
  const view = { location: { href: 'https://app.example/', reload: () => calls.push('reload'), assign: (u: string) => calls.push(u) }, open: (u: string) => calls.push(u) };
  const root = { ownerDocument: { defaultView: view }, querySelector: () => null };
  runtime.applyActionNav(root, Object.create({ kind: 'reload' }));
  runtime.applyActionNav(root, Object.create({ kind: 'navigate', url: 'https://allowed.example/x' }));
  assert.deepEqual(calls, []);
});
