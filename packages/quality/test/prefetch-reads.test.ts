import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkPrefetchReads, isPrefetchModule } from '../src/prefetch-reads.js';
import { GalleryIncomplete, prefetchFailure, runGallery, sweepGallery, summarize, asMarkdown, type AppRow, type AppResult } from '../src/gallery.js';
import type { GeneratedTree, ModuleKind } from '../src/modules.js';

function tree(modules: { path: string; text: string; kind?: ModuleKind }[]): GeneratedTree {
  return { files: [], modules: modules.map((m) => ({ path: m.path, kind: m.kind ?? 'server', text: m.text })) };
}

const READS = `export async function prefetch(ctx) {
  const shim = ctx.shim;
  const slots = {};
  slots["rows"] = await shim.datastore.rows(ctx, "Orders", { status: "open" });
  slots["map"] = await shim.datastore.lookupMap(ctx, "Customers", "ID", ids);
  return slots;
}
`;

test('a generated prefetch module is named *-prefetch.mjs', () => {
  assert.equal(isPrefetchModule('functions/aio/new-deal/on-load-prefetch.mjs'), true);
  assert.equal(isPrefetchModule('functions/custom/convert-prefetch.mjs'), true);
  assert.equal(isPrefetchModule('functions/aio/new-deal/on-load.mjs'), false);
  assert.equal(isPrefetchModule('client/handlers/new-deal/on-load.js'), false);
});

test('a prefetch module that only reads passes', () => {
  const r = checkPrefetchReads(tree([{ path: 'functions/aio/f/on-load-prefetch.mjs', text: READS }]));
  assert.equal(r.ok, true);
  assert.equal(r.modules, 1);
  assert.equal(r.nonReads, 0);
  assert.deepEqual(r.findings, []);
});

test('a non-read inside a prefetch module fails with op, path and line', () => {
  const text = `${READS}  await shim.mail.send({ to: "user@example.com" });\n  await shim.datastore.insert(ctx, "Audit", { a: 1 });\n  await shim.thisapp.call(ctx, "f", []);\n  await shim.zoho.task(ctx, "t", []);\n  await shim.http.getUrl(ctx, "https://example.test");\n  await shim.datastore.update(ctx, "Orders", "1", {});\n  await shim.datastore.delete(ctx, "Orders", "1");\n  await shim.datastore.setField(ctx, "Orders", "f", 1);\n`;
  const r = checkPrefetchReads(tree([{ path: 'functions/aio/f/on-load-prefetch.mjs', text }]));
  assert.equal(r.ok, false);
  assert.equal(r.nonReads, 8);
  assert.equal(r.findings[0]!.path, 'functions/aio/f/on-load-prefetch.mjs');
  assert.equal(r.findings[0]!.op, 'shim.mail.send');
  assert.equal(r.findings[0]!.line, READS.split('\n').length);
  assert.equal(r.byOp['shim.datastore.insert'], 1);
  assert.equal(r.byOp['shim.thisapp.call'], 1);
  assert.equal(r.byOp['shim.zoho.task'], 1);
  assert.equal(r.byOp['shim.datastore.setField'], 1);
});

test('batched and staged writes inside a prefetch module count as non-reads', () => {
  const text = `  await shim.datastore.insertRow(ctx, "Audit", { a: 1 });\n  await shim.datastore.insertRows(ctx, "Audit", [{ a: 1 }]);\n  await shim.datastore.updateRows(ctx, "Orders", [{ id: "1" }]);\n  await shim.datastore.deleteRows(ctx, "Orders", ["1"]);\n  await shim.datastore.writeRow(ctx, "Orders", "1", { a: 2 });\n  await shim.datastore.flush(ctx);\n  await shim.http.postUrl(ctx, "https://example.test", {});\n`;
  const r = checkPrefetchReads(tree([{ path: 'functions/custom/f-prefetch.mjs', text }]));
  assert.equal(r.ok, false);
  assert.equal(r.nonReads, 7);
  assert.equal(r.byOp['shim.datastore.insertRow'], 1);
  assert.equal(r.byOp['shim.datastore.insertRows'], 1);
  assert.equal(r.byOp['shim.datastore.updateRows'], 1);
  assert.equal(r.byOp['shim.datastore.deleteRows'], 1);
  assert.equal(r.byOp['shim.datastore.writeRow'], 1);
  assert.equal(r.byOp['shim.datastore.flush'], 1);
  assert.equal(r.byOp['shim.http.postUrl'], 1);
});

test('a non-read quoted in a comment line is not counted', () => {
  const text = `${READS}// Deluge: zoho.task("reminder")\n// await shim.datastore.insert(ctx, "Audit", { a: 1 });\n * await shim.thisapp.call(ctx, "f", []);\n`;
  const r = checkPrefetchReads(tree([{ path: 'functions/aio/f/on-load-prefetch.mjs', text }]));
  assert.equal(r.ok, true);
  assert.equal(r.nonReads, 0);
});

test('the same calls outside a prefetch module are not counted', () => {
  const r = checkPrefetchReads(
    tree([
      { path: 'functions/aio/f/on-load-prefetch.mjs', text: READS },
      { path: 'functions/aio/f/on-success.mjs', text: 'await shim.mail.send({});\nawait shim.datastore.insert(ctx, "A", {});' },
      { path: 'client/handlers/f/on-load.js', kind: 'client', text: 'await shim.http.postUrl(ctx, "u", {});' },
    ]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.modules, 1);
  assert.equal(r.nonReads, 0);
});

const ROW: AppRow = {
  compiles: { ok: true, modules: 1, nodeCheckFailures: 0, scanned: 1, freeIdentifiers: 0, modulesWithFreeIdentifiers: 0, freeByName: {}, typeChecked: 1, typeErrors: 0, typeByCode: {}, typeAdvisories: 0, templateTypeErrors: 0 },
  smokeClean: { ok: true, handlers: 1, calls: 1, handlersWithCrash: 0, handlersCrashOnValid: 0, crashByClass: {}, delugeByClass: {}, unmappedByClass: {}, importFailures: 0 },
  prefetch: { modules: 1, nonReads: 0, byOp: {} },
  crashSignatures: {},
  crashOnValidSignatures: {},
  unmappedSignatures: {},
  typeMessages: {},
};

test('a row with prefetch non-reads becomes an app failure', () => {
  assert.equal(prefetchFailure(ROW), null);
  const bad = { ...ROW, prefetch: { modules: 1, nonReads: 2, byOp: { 'shim.mail.send': 2 } } };
  const f = prefetchFailure(bad);
  assert.equal(f?.kind, 'app');
  assert.equal(f?.error, 'prefetch-non-reads=2');
});

function oneAppDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-prefetch-gate-'));
  writeFileSync(join(dir, 'a.ds'), '');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the sweep fails an app whose row reports prefetch non-reads, without a retry', async (t) => {
  let runs = 0;
  const bad: AppResult = { ...ROW, prefetch: { modules: 1, nonReads: 1, byOp: { 'shim.datastore.insert': 1 } } };
  const sweep = await sweepGallery(oneAppDir(t), 1, {
    retries: 2,
    run: async () => {
      runs++;
      return bad;
    },
    load: () => ({ cores: 4, load1: 0 }),
  });
  assert.equal(runs, 1);
  assert.equal(sweep.stats.failed, 1);
  const row = sweep.rows[0]!;
  assert.ok('error' in row && row.error === 'prefetch-non-reads=1');
});

test('runGallery rejects with prefetch-non-reads=<n> on the failure line', async (t) => {
  const bad: AppResult = { ...ROW, prefetch: { modules: 1, nonReads: 3, byOp: { 'shim.thisapp.call': 3 } } };
  const err = await runGallery(oneAppDir(t), 1, { run: async () => bad, load: () => ({ cores: 4, load1: 0 }) }).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof GalleryIncomplete);
  assert.match(err.message, /prefetch-non-reads=3/);
});

test('the summary and markdown report prefetch counts per app', () => {
  const s = summarize([ROW, { ...ROW, prefetch: { modules: 2, nonReads: 0, byOp: {} } }], 1);
  assert.equal(s.prefetch.modules, 3);
  assert.equal(s.prefetch.nonReads, 0);
  assert.equal(s.prefetch.appsWithNonReads, 0);
  assert.deepEqual(
    s.perApp.map((p) => p.prefetchNonReads),
    [0, 0],
  );
  const md = asMarkdown(s);
  assert.match(md, /\| Prefetch \| endpoint modules scanned \| 3 \|/);
  assert.match(md, /\| Prefetch \| non-read calls in prefetch endpoints \| 0 \|/);
});
