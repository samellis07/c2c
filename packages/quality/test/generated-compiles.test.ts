/**
 * Q2 over committed apps, without the local gallery: every generated module of
 * the redistributable and synthetic fixtures parses (`node --check`), has no
 * free identifier, and type-checks against the shim and `ctx` surface.
 *
 * fixtures/synthetic/shared-routes puts several scripts on one form-event
 * route: add, edit and delete validates and successes (the merged modules
 * guard the delete-scoped scripts with `ctx.deleting`), and two subform input
 * scripts whose prefetches each bind the same subform row.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import { loadApp } from '../../determinism/src/tree.js';
import { checkCompiles, generatedTree, smokeApp, type GeneratedTree } from '../src/index.js';

const root = repoRoot();
const FIXTURES = [
  'fixtures/redistributable/freight-forwarding',
  'fixtures/redistributable/library-application-system',
  'fixtures/synthetic/kitchen-sink',
  'fixtures/synthetic/shared-routes',
];

const sharedRoutes = () => generatedTree(loadApp(join(root, 'fixtures/synthetic/shared-routes')));

function moduleText(tree: GeneratedTree, suffix: string): string {
  const found = tree.modules.find((m) => m.path.endsWith(suffix));
  assert.ok(found, `no generated module ${suffix}`);
  return found.text;
}

for (const fixture of FIXTURES) {
  test(`generated ${fixture} compiles (node --check, free identifiers, checkJs)`, async () => {
    const { report, details } = await checkCompiles(generatedTree(loadApp(join(root, fixture))));
    const failing = details.filter((d) => d.check === 'node-check' || d.check === 'free-identifier' || d.check === 'type');
    assert.deepEqual(failing, []);
    assert.equal(report.ok, true);
    assert.ok(report.typeChecked > 0);
  });
}

test('shared-routes still covers merged delete scopes and a repeated subform row binding', () => {
  const tree = sharedRoutes();
  for (const leaf of ['order-sheet/on-validate.mjs', 'order-sheet/on-success.mjs']) {
    const text = moduleText(tree, `aio/${leaf}`);
    assert.match(text, /if \(ctx\.deleting\) \{/, leaf);
    assert.match(text, /if \(ctx\.rowId && !ctx\.deleting\) \{/, leaf);
  }
  const prefetch = moduleText(tree, 'aio/order-sheet/input-handlers-prefetch.mjs');
  assert.equal(prefetch.match(/const d_row = shim\.subform\.currentRow\(ctx, "Lines"\);/g)?.length, 2);
  assert.match(moduleText(tree, 'aio/order-sheet/delete.mjs'), /ctx\.deleting = true;/);
  // The prefetch request has no ROWID: a record-scope guard there would leave
  // the edit validate's slot unset, so the add and edit slots both load.
  const validatePrefetch = moduleText(tree, 'aio/order-sheet/on-validate-prefetch.mjs');
  assert.doesNotMatch(validatePrefetch, /ctx\.(rowId|deleting)/);
  for (const slot of ['c0', 'c1']) assert.match(validatePrefetch, new RegExp(`slots\\["${slot}"\\] = `));
});

test('shared-routes handlers run without a crash', async () => {
  const app = loadApp(join(root, 'fixtures/synthetic/shared-routes'));
  const { report, details } = await smokeApp(app, generatedTree(app), { iterations: 2 });
  assert.equal(report.importFailures, 0, JSON.stringify(details.slice(0, 5)));
  assert.equal(report.ok, true, JSON.stringify(details.slice(0, 5)));
});

test('the check fails a merged prefetch that redeclares a binding and a handler that reads an unknown ctx field', async () => {
  const tree = sharedRoutes();
  const prefetchPath = tree.modules.find((m) => m.path.endsWith('aio/order-sheet/input-handlers-prefetch.mjs'))!.path;
  const validatePath = tree.modules.find((m) => m.path.endsWith('aio/order-sheet/on-validate.mjs'))!.path;
  // The pre-fix prefetch: both scripts' bodies concatenated in one scope.
  const breakText = (path: string, text: string): string =>
    path === prefetchPath ? text.replace(/\n  \{\n(    const d_row)/g, '\n$1').replace(/\n  \}(?=\n(    const d_row|  return slots;))/g, '') : path === validatePath ? text.replace('if (ctx.deleting) {', 'if (ctx.deletingRow) {') : text;
  const broken: GeneratedTree = {
    files: tree.files.map((f) => (typeof f.data === 'string' ? { ...f, data: breakText(f.path, f.data) } : f)),
    modules: tree.modules.map((m) => ({ ...m, text: breakText(m.path, m.text) })),
  };
  const { report, details } = await checkCompiles(broken);
  assert.equal(report.ok, false);
  assert.ok(
    details.some((d) => d.check === 'node-check' && d.path === prefetchPath && /Identifier 'd_row' has already been declared/.test(d.message ?? '')),
    JSON.stringify(details.filter((d) => d.path === prefetchPath)),
  );
  assert.ok(
    details.some((d) => d.check === 'type' && d.path === validatePath && /^TS(2339|2551)$/.test(d.key) && /deletingRow/.test(d.message ?? '')),
    JSON.stringify(details.filter((d) => d.path === validatePath)),
  );
});
