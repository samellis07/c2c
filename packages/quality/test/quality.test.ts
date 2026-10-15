import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { emptyApp, parseFile, type App, type Field } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { loadApp } from '../../determinism/src/tree.js';
import {
  DOC_BEGIN,
  DOC_END,
  GALLERY_ITERATIONS,
  GalleryIncomplete,
  asMarkdown,
  concurrencyFor,
  docBlock,
  galleryTable,
  readGalleryCache,
  runApp,
  runGallery,
  statsLine,
  summarize,
  sweepGallery,
  tableDigest,
  AppProgress,
  APP_CPU_MS,
  APP_IDLE_MS,
  APP_WALL_MS,
  HEARTBEAT_MS,
  PROGRESS_FLOOR,
  watchdogFor,
  typeBucket,
  writeGalleryCache,
  type AppResult,
  type RunAppOptions,
  type Watchdog,
} from '../src/gallery.js';
import {
  DEFAULT_SEED,
  checkCompiles,
  classify,
  fieldValue,
  freeIdentifiers,
  generatedTree,
  handlerNames,
  materialize,
  qualityGate,
  recordFor,
  rng,
  smokeApp,
  withCtxTypes,
  type GeneratedTree,
} from '../src/index.js';
import { BROWSER_GLOBALS, ES_GLOBALS, NODE_GLOBALS } from '../src/scope.js';
import { allowedGlobals, isGating } from '../src/static.js';

const root = repoRoot();
const SERVER = new Set([...ES_GLOBALS, ...NODE_GLOBALS]);
const names = (text: string) => freeIdentifiers(text, SERVER).map((f) => f.name);

test('free identifiers: bindings in every scope form resolve', () => {
  const text = `
import { a as b, default as d } from "x";
import * as ns from "y";
export const k = 1;
export { k as kk };
var hoisted = later();
function later() { return arguments.length; }
class C { m(p) { return p + this.f; } static s = 1; }
const { x, y: [z, ...rest] = [] } = obj0();
function obj0() { return {}; }
for (const it of [1]) { it; }
for (let i = 0; i < 1; i++) { i; }
try { b(); } catch (err) { err; } finally { d; }
label: for (;;) { break label; }
const o = { x, key: ns, [z]: rest, method() { return C; } };
const fe = function named() { return named; };
const ce = class Named { m() { return Named; } };
(async (q = hoisted) => { await q; })();
switch (k) { case 1: { let inCase = 1; inCase; } }
o.unknownProperty;
`;
  assert.deepEqual(names(text), []);
});

test('free identifiers: unbound references are reported with lines', () => {
  const text = 'export async function handle(ctx) {\n  const shim = ctx.shim;\n  if (row.Qty > 0) shim.input.set(ctx, ["T"], today);\n  { let inner = 1; }\n  return inner + ({ shorthand }).shorthand;\n}\n';
  assert.deepEqual(freeIdentifiers(text, SERVER), [
    { name: 'row', line: 3 },
    { name: 'today', line: 3 },
    { name: 'inner', line: 5 },
    { name: 'shorthand', line: 5 },
  ]);
  assert.deepEqual(names('const f = () => arguments;'), ['arguments']);
  assert.deepEqual(names('document.title = 1;'), ['document']);
});

const CLEAN = `import { createRuntime } from "creator-to-catalyst/shims";
export const formName = "Contact";
export async function handle(ctx) {
  const shim = ctx.shim;
  if ((shim.input.get(ctx, "Name") != null)) {
    shim.input.set(ctx, ["Email"], shim.string.toLowerCase(shim.input.get(ctx, "Email")));
  }
  for (const item of shim.each(ctx, await shim.datastore.rows(ctx, shim.datastore.query(ctx, "Contact", { op: "!=", field: "ID", value: 0 })))) {
    shim.log.info(ctx, shim.record.get(item, "Name"));
  }
  return shim.date.addDay(shim.zoho.currentDate(ctx), 1, ctx);
}
export default async function handler(req, res) {
  const runtime = createRuntime({ dryRun: true });
  res.end(String(await handle(runtime.context({ record: {} }))));
}
`;

function treeOf(text: string, path = 'functions/aio/contact/on-validate.mjs'): GeneratedTree {
  return { files: [{ path, data: text }], modules: [{ path, kind: 'server', text }] };
}

const minimal = parseFile(join(root, 'fixtures/dialects/d1-minimal.ds')).ir;

test('Q2 + Q4: a clean handler passes every check', async () => {
  const q2 = await checkCompiles(treeOf(CLEAN));
  assert.equal(q2.report.ok, true, JSON.stringify(q2.details));
  const q4 = await smokeApp(minimal, treeOf(CLEAN), { iterations: 6 });
  assert.equal(q4.report.ok, true, JSON.stringify(q4.details));
  assert.equal(q4.report.handlers, 1);
  assert.equal(q4.report.calls, 6);
});

test('Q2 bites: an unbound row fails the free-identifier pass, checkJs and Q4', async () => {
  const bad = CLEAN.replace('if ((shim.input.get(ctx, "Name") != null))', 'if ((row.Name != null))');
  const q2 = await checkCompiles(treeOf(bad));
  assert.equal(q2.report.ok, false);
  assert.deepEqual(q2.report.freeByName, { row: 1 });
  assert.equal(q2.report.typeByCode.TS2304, 1);
  const q4 = await smokeApp(minimal, treeOf(bad), { iterations: 3 });
  assert.equal(q4.report.ok, false);
  assert.deepEqual(q4.report.crashByClass, { ReferenceError: 1 });
  assert.match(q4.details[0]!.signature, /^ReferenceError: row is not defined @ generated:functions\/aio$/);
  // The deploy tree nests functions under functions/c2c_api/: the bucket is still aio.
  const nested = await smokeApp(minimal, treeOf(bad, 'functions/c2c_api/aio/contact/on-validate.mjs'), { iterations: 1 });
  assert.match(nested.details[0]!.signature, /^ReferenceError: row is not defined @ generated:functions\/aio$/);
});

test('Q2 bites: a wrong shim member and a wrong shim arity fail checkJs', async () => {
  // A probe name with no near-miss member, so the check reports an unknown member (TS2339), not a suggestion.
  const wrongName = CLEAN.replace('shim.string.toLowerCase(', 'shim.string.qzxNoSuchMember(');
  const a = await checkCompiles(treeOf(wrongName));
  assert.equal(a.report.ok, false);
  assert.equal(a.report.freeIdentifiers, 0);
  assert.deepEqual(a.report.typeByCode, { TS2339: 1 });
  const q4 = await smokeApp(minimal, treeOf(wrongName), { iterations: 1 });
  assert.deepEqual(q4.report.crashByClass, { TypeError: 1 });

  const wrongArity = CLEAN.replace('shim.date.addDay(shim.zoho.currentDate(ctx), 1, ctx)', 'shim.date.addDay(shim.zoho.currentDate(ctx), 1)');
  const b = await checkCompiles(treeOf(wrongArity));
  assert.equal(b.report.ok, false);
  assert.deepEqual(b.report.typeByCode, { TS2554: 1 });
});

test('Q2 bites: a syntax error fails node --check and the module does not import', async () => {
  const broken = CLEAN.replace('return shim.date', 'return return shim.date');
  const q2 = await checkCompiles(treeOf(broken));
  assert.equal(q2.report.nodeCheckFailures, 1);
  assert.equal(q2.report.ok, false);
  const q4 = await smokeApp(minimal, treeOf(broken), { iterations: 1 });
  assert.equal(q4.report.importFailures, 1);
  assert.deepEqual(q4.report.crashByClass, { SyntaxError: 1 });
});

function clientTreeOf(body: string): GeneratedTree {
  const path = 'client/handlers/contact/on-validate.mjs';
  const text = `export async function clientActions(ctx) {\n  const shim = ctx.shim;\n  const actions = [];\n  ${body}\n  return actions;\n}\n`;
  return { files: [{ path, data: text }], modules: [{ path, kind: 'client', text }] };
}

test('Q2 bites: a client module that reads a Node-only global fails (it throws in the browser)', async () => {
  const ok = await checkCompiles(clientTreeOf('actions.push({ op: "info", message: document.title + location.href });'));
  assert.equal(ok.report.ok, true, JSON.stringify(ok.details));
  const bad = await checkCompiles(clientTreeOf('actions.push({ op: "info", message: process.env.FOO + Buffer.byteLength("a") + String(setImmediate) });'));
  assert.equal(bad.report.ok, false);
  assert.deepEqual(bad.report.freeByName, { Buffer: 1, process: 1, setImmediate: 1 });
  // DOM typings, not @types/node: the type pass refuses the same names.
  assert.deepEqual(bad.report.typeByCode, { TS2591: 2, TS2304: 1 }, JSON.stringify(bad.details));
  for (const name of ['process', 'Buffer', 'setImmediate', 'clearImmediate', 'require', 'module', 'exports', '__dirname', '__filename']) {
    assert.equal(BROWSER_GLOBALS.has(name), false, name);
    assert.deepEqual(freeIdentifiers(`${name};`, allowedGlobals('client')).map((f) => f.name), [name]);
    assert.deepEqual(freeIdentifiers(`${name};`, allowedGlobals('ui')).map((f) => f.name), [name]);
  }
});

test('Q2: CommonJS wrapper names are allowed only in a server .js entry', () => {
  const cjs = "const { join } = require('node:path');\nmodule.exports = () => join(__dirname, __filename);\n";
  assert.deepEqual(freeIdentifiers(cjs, allowedGlobals('server', 'functions/c2c_api/index.js')), []);
  assert.deepEqual(
    freeIdentifiers(cjs, allowedGlobals('server', 'functions/c2c_api/aio/x.mjs')).map((f) => f.name),
    ['require', 'module', '__dirname', '__filename'],
  );
});

test('checkJs gating: dynamic-value arithmetic is advisory, surface faults gate', () => {
  assert.equal(isGating(2304, "Cannot find name 'row'."), true);
  assert.equal(isGating(2339, "Property 'ID' does not exist on type 'Query'."), true);
  assert.equal(isGating(2339, "Property 'ID' does not exist on type 'unknown'."), false);
  assert.equal(isGating(2345, "Argument of type 'string' is not assignable to parameter of type 'number'."), true);
  assert.equal(isGating(2345, "Argument of type 'unknown' is not assignable to parameter of type 'number'."), false);
  assert.equal(isGating(2365, "Operator '>' cannot be applied to types 'unknown' and 'number'."), false);
  assert.equal(isGating(1005, "';' expected."), true);
});

test('ctx typing keeps line numbers and covers every exported ctx function', () => {
  const text = 'export async function handle(ctx) {}\nexport function Custom_Fn(ctx, a) {}\nexport default async function handler(req, res) {}\n';
  const typed = withCtxTypes(text);
  assert.equal(typed.split('\n').length, text.split('\n').length);
  assert.equal((typed.match(/ShimContext/g) ?? []).length, 2);
  assert.deepEqual(handlerNames(text), ['handle', 'Custom_Fn']);
});

const SPAN = { start: 0, end: 0 };

function approvalApp(machines: number): App {
  return {
    ...emptyApp('empty'),
    name: 'Demo_App',
    forms: [{ name: 'Leave', properties: [], fields: [], actions: [], blocks: [], span: SPAN }],
    workflows: Array.from({ length: machines }, (_, i) => ({
      name: `Approval ${i + 1}`,
      container: 'approval',
      form: 'Leave',
      event: 'on approve',
      approvers: [{ key: 'level', value: '1', span: SPAN }],
      deluge: { text: 'x = 1;', span: SPAN },
      properties: [],
      span: SPAN,
    })),
  };
}

test('Q2: a generated state-machine module type-checks (transition script and the submit claim)', async () => {
  const tree = generatedTree(approvalApp(1));
  const flow = tree.modules.filter((m) => m.path.includes('/flow/'));
  assert.equal(flow.length, 1);
  const q2 = await checkCompiles({ files: tree.files, modules: flow });
  assert.equal(q2.report.ok, true, JSON.stringify(q2.details));
});

test('a submit claim is per machine: only the claiming machine commits the history row', async () => {
  const tree = generatedTree(approvalApp(2));
  const flows = tree.modules.filter((m) => m.path.includes('/flow/')).map((m) => m.path);
  assert.equal(flows.length, 2);
  const dir = materialize(tree);
  try {
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const ctx = {
      record: {} as Record<string, unknown>,
      shim: {
        datastore: {
          insertRow: async (_ctx: unknown, table: string, row: Record<string, unknown>) => {
            writes.push({ table, row });
          },
        },
      },
    };
    const mods = await Promise.all(flows.map((path) => import(pathToFileURL(join(dir, path)).href)));
    for (const mod of mods) await (mod as { begin(c: unknown): Promise<void> }).begin(ctx);
    for (const mod of mods) await (mod as { commit(c: unknown): Promise<void> }).commit(ctx);
    assert.equal(writes.length, 1, JSON.stringify(writes));
    assert.equal(writes[0]!.row.Action, 'submit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inputs are seeded: same seed, same record; variants and subform row counts', () => {
  const app = loadApp(join(root, 'fixtures/redistributable/library-application-system'));
  const form = app.forms[0];
  const a = recordFor(form, 'mixed', rng('s'), { subformRows: 1 });
  const b = recordFor(form, 'mixed', rng('s'), { subformRows: 1 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(recordFor(form, 'mixed', rng('t'), { subformRows: 1 }), a);
  const field = (type: string, subfields: Field[] = []): Field => ({ name: 'F', type, modifiers: [], required: false, unique: false, properties: [], subfields, annotations: [], flags: [], span: { start: 0, end: 0 } });
  const grid = field('grid', [field('number'), field('text')]);
  for (const n of [0, 1, 3]) assert.equal((fieldValue(grid, 'valid', rng(1), { subformRows: n }) as unknown[]).length, n);
  assert.equal(fieldValue(field('number'), 'null', rng(1), { subformRows: 0 }), null);
  assert.equal(fieldValue(field('text'), 'empty', rng(1), { subformRows: 0 }), '');
  assert.equal(typeof fieldValue(field('number'), 'wrong-type', rng(1), { subformRows: 0 }) === 'number', false);
  assert.equal(fieldValue(field('section'), 'valid', rng(1), { subformRows: 0 }), undefined);
});

test('classify: Deluge-mapped errors are allowed, JS errors crash, plain errors are unmapped', () => {
  const deluge = Object.assign(new Error('Invalid'), { name: 'DelugeRuntimeError' });
  assert.equal(classify(deluge, '/x').outcome, 'deluge');
  assert.equal(classify(Object.assign(new Error('stop'), { name: 'SubmitRefused' }), '/x').outcome, 'deluge');
  assert.equal(classify(new TypeError('a'), '/x').outcome, 'crash');
  assert.equal(classify(new RangeError('a'), '/x').outcome, 'crash');
  assert.equal(classify(new Error('date: bad'), '/x').outcome, 'unmapped');
  // An uncaptured rejection (for each over a non-collection) is unmapped, not deluge.
  assert.equal(classify(Object.assign(new Error("not a collection"), { name: 'UncapturedDelugeError' }), '/x').outcome, 'unmapped');
  assert.equal(classify('thrown string', '/x').outcome, 'crash');
});

test('redistributable apps: the gate is deterministic, and the library app passes Q2 and Q4', async () => {
  const library = loadApp(join(root, 'fixtures/redistributable/library-application-system'));
  const first = await qualityGate(library);
  const second = await qualityGate(library);
  assert.deepEqual(first.compiles, second.compiles);
  assert.deepEqual(first.smokeClean, second.smokeClean);
  assert.equal(first.compiles.ok, true, JSON.stringify(first.details.compiles.slice(0, 5)));
  assert.equal(first.smokeClean.ok, true, JSON.stringify(first.details.smoke.slice(0, 5)));
  assert.ok(first.smokeClean.handlers > 0);

  const freight = loadApp(join(root, 'fixtures/redistributable/freight-forwarding'));
  const tree = generatedTree(freight);
  const f1 = await smokeApp(freight, tree, { iterations: 2 });
  const f2 = await smokeApp(freight, tree, { iterations: 2 });
  assert.deepEqual(f1.report, f2.report);
  assert.deepEqual(f1.details, f2.details);
});

test('type buckets drop app names and keep shim types', () => {
  assert.equal(typeBucket("Property 'Can_Assign' does not exist on type 'Query'."), "Property '…' does not exist on type 'Query'.");
  assert.equal(typeBucket("Cannot find name 'Assignees1'."), "Cannot find name '…'.");
  assert.equal(typeBucket("Argument of type 'string' is not assignable to parameter of type 'number'."), "Argument of type 'string' is not assignable to parameter of type 'number'.");
});

test('gallery summary aggregates per-app rows without names', () => {
  const lib = { compiles: { ok: true, modules: 2, nodeCheckFailures: 0, scanned: 2, freeIdentifiers: 0, modulesWithFreeIdentifiers: 0, freeByName: {}, typeChecked: 2, typeErrors: 0, typeByCode: {}, typeAdvisories: 0, templateTypeErrors: 0 }, smokeClean: { ok: true, handlers: 1, calls: 2, handlersWithCrash: 0, handlersCrashOnValid: 0, crashByClass: {}, delugeByClass: {}, unmappedByClass: {}, importFailures: 0 }, prefetch: { modules: 1, nonReads: 0, byOp: {} }, crashSignatures: {}, crashOnValidSignatures: {}, unmappedSignatures: {}, typeMessages: {} };
  const bad = { ...lib, compiles: { ...lib.compiles, ok: false, freeIdentifiers: 3, freeByName: { row: 3 } }, smokeClean: { ...lib.smokeClean, ok: false, handlersWithCrash: 1, crashByClass: { ReferenceError: 1 } }, crashSignatures: { 'ReferenceError: row is not defined @ generated:client/handlers': 1 } };
  const s = summarize([lib, bad, { error: 'boom' }], 2);
  assert.equal(s.apps, 3);
  assert.equal(s.appErrors, 1);
  assert.equal(s.q2.appsCompile, 1);
  assert.equal(s.q2.appsWithUnboundRow, 1);
  assert.equal(s.q4.appsSmokeClean, 1);
  assert.deepEqual(s.q4.crashByClass, { ReferenceError: 1 });
  assert.deepEqual(s.perApp.map((p) => p.index), [1, 2, 3]);
});

test('quality-gate doc block: the marker carries only the table digest', () => {
  const block = docBlock('| Q2 | apps passing (compiles) | 3 / 67 |\n');
  const marker = block.slice(0, block.indexOf('-->'));
  assert.equal(/inputs=/.test(marker), false);
  const table = /table=([0-9a-f]{64})/.exec(block)![1];
  const body = block.slice(block.indexOf('-->\n') + 4, block.indexOf(DOC_END));
  assert.equal(tableDigest(body), table);
  assert.notEqual(tableDigest(body.replace('3 / 67', '4 / 67')), table);
});

test('gallery cache: a matching inputs digest is a hit, anything else a miss', () => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-gallery-cache-'));
  try {
    assert.equal(readGalleryCache(root), null);
    writeGalleryCache({ inputs: 'a'.repeat(64), iterations: 24, body: '| x | 1 |\n' }, root);
    assert.deepEqual(readGalleryCache(root), { inputs: 'a'.repeat(64), iterations: 24, body: '| x | 1 |\n' });
    mkdirSync(join(root, '.cache'), { recursive: true });
    writeFileSync(join(root, '.cache', 'quality-gallery.json'), 'not json');
    assert.equal(readGalleryCache(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs/quality-gate.md gallery table: present, and current when fixtures are available', async () => {
  const doc = readFileSync(join(root, 'docs/quality-gate.md'), 'utf8');
  const begin = doc.indexOf(DOC_BEGIN);
  const end = doc.indexOf(DOC_END);
  assert.ok(begin >= 0 && end > begin, 'gallery markers missing');
  const block = doc.slice(begin, end);
  assert.match(block, new RegExp(`Q4 iterations per handler: ${GALLERY_ITERATIONS}, seed \`${DEFAULT_SEED}\``));
  // The marker records only the table digest: a hand-edited count fails here, fixtures or not.
  const marker = doc.slice(begin, doc.indexOf('-->', begin));
  assert.equal(/inputs=/.test(marker), false, 'the committed marker must not carry an inputs digest');
  const table = /table=([0-9a-f]{64})/.exec(block)?.[1];
  assert.ok(table, 'table digest missing');
  const body = block.slice(block.indexOf('-->\n') + 4);
  assert.equal(tableDigest(body), table, 'docs/quality-gate.md table was edited by hand: regenerate it with `C2C_FIXTURES_DIR=... npm run smoke:gallery -- --markdown`');
  const fixtures = process.env.C2C_FIXTURES_DIR;
  if (!fixtures) return;
  // Staleness is judged by the results, not by an inputs digest committed in
  // the marker: recompute the table and compare it (and its digest) with the
  // committed block. galleryTable serves an unchanged tree from the local
  // inputs-keyed cache instead of re-sweeping.
  const measured = await galleryTable(join(fixtures, 'gallery'), GALLERY_ITERATIONS);
  assert.equal(
    tableDigest(measured.body),
    table,
    'docs/quality-gate.md is stale: regenerate the block with `C2C_FIXTURES_DIR=... npm run smoke:gallery -- --markdown`',
  );
  assert.equal(
    measured.body,
    body,
    'docs/quality-gate.md gallery table differs from the measured results: regenerate it with `C2C_FIXTURES_DIR=... npm run smoke:gallery -- --markdown`',
  );
});

test('gallery parallelism follows the load', () => {
  assert.equal(concurrencyFor({ cores: 32, load1: 0 }, 0), 4);
  assert.equal(concurrencyFor({ cores: 32, load1: 30 }, 0), 2);
  assert.equal(concurrencyFor({ cores: 32, load1: 31 }, 1), 2, 'the sweep does not count its own processes as load');
  assert.equal(concurrencyFor({ cores: 32, load1: 50 }, 0), 1);
  assert.equal(concurrencyFor({ cores: 8, load1: 0 }, 0, 2), 2);
});

/** A simulated app process: one heartbeat every HEARTBEAT_MS, adding `perBeatMicros` of CPU, until `untilMs` or a kill. */
function simulate(perBeatMicros: (t: number) => number, untilMs: number, limits = watchdogFor(), marksAt: (t: number) => number = () => 0): number | undefined {
  const progress = new AppProgress(0, limits);
  let cpu = 0;
  for (let t = HEARTBEAT_MS; t <= untilMs; t += HEARTBEAT_MS) {
    cpu += perBeatMicros(t);
    progress.beat(t, cpu, marksAt(t));
    if (progress.expired(t)) return t;
  }
  return undefined;
}

test('gallery watchdog: a slow app making progress is not killed; a blocked, stalled or runaway one is', () => {
  // An app that needs 995 s of wall-clock time on half a core.
  assert.equal(simulate(() => 2_500_000, 995_000), undefined);
  // Twice as slow on a busy machine, with a 10 s pause in each minute: still progressing, still running.
  assert.equal(simulate((t) => (t % 60_000 < 10_000 ? 150 : 1_250_000), 2 * 995_000), undefined);
  // Blocked: only the heartbeat's own CPU cost (a few hundred microseconds a
  // beat). The idle clock starts at the first report (t = HEARTBEAT_MS), so
  // the kill lands one idle limit after it.
  const blocked = simulate(() => 300, 3_600_000);
  assert.ok(blocked !== undefined && blocked > APP_IDLE_MS + HEARTBEAT_MS && blocked <= APP_IDLE_MS + 2 * HEARTBEAT_MS, `blocked: killed at ${blocked}`);
  // Stalled after 100 s of work.
  assert.equal(simulate((t) => (t <= 100_000 ? 5_000_000 : 0), 100_000 + APP_IDLE_MS), undefined);
  assert.equal(simulate((t) => (t <= 100_000 ? 5_000_000 : 0), 100_000 + APP_IDLE_MS + HEARTBEAT_MS), 100_000 + APP_IDLE_MS + HEARTBEAT_MS);
  // Waiting on subprocesses: little CPU of its own, but a finished piece of work every beat.
  assert.equal(simulate(() => 300, 2 * APP_IDLE_MS, watchdogFor(), (t) => t / HEARTBEAT_MS), undefined);
  // A busy loop: a full core per beat uses up the CPU budget (the wall-clock backstop lifted).
  const runaway = simulate(() => HEARTBEAT_MS * 1000, 2 * APP_CPU_MS, watchdogFor({ wallMs: Infinity }));
  assert.ok(runaway !== undefined && runaway > APP_CPU_MS && runaway <= APP_CPU_MS + HEARTBEAT_MS, `runaway: killed at ${runaway}`);
});

test('gallery watchdog: the wall-clock backstop kills an app that stays just above the progress floor', () => {
  const floor = HEARTBEAT_MS * 1000 * PROGRESS_FLOOR;
  assert.equal(floor, 50_000, '50 ms of CPU per 5 s beat');
  // Never idle and far from the CPU budget, but it never finishes.
  const killed = simulate(() => floor + 1, 10 * APP_WALL_MS);
  assert.ok(killed !== undefined && killed > APP_WALL_MS && killed <= APP_WALL_MS + HEARTBEAT_MS, `backstop: killed at ${killed}`);
  assert.ok(APP_WALL_MS > 2 * 995_000, 'the backstop is above the slowest app on a machine that halves its speed');
});

/**
 * Child script loaded before the app. It reports `c2c-gallery-progress`
 * lines and then publishes its own row. The app's stdout and exit are held
 * so a fast app cannot end the process first, and a grandchild that
 * inherits the environment reports nothing.
 */
function galleryBeatScript(lines: readonly string[]): string {
  return [
    `'use strict';`,
    `if (process.env.C2C_GALLERY_BEAT_CHILD) return;`,
    `process.env.C2C_GALLERY_BEAT_CHILD = '1';`,
    `const fs = require('node:fs');`,
    `const realWriteSync = fs.writeSync.bind(fs);`,
    `const realExit = process.exit.bind(process);`,
    `let hold = true;`,
    `fs.writeSync = (fd, buf, ...rest) => {`,
    `  if (hold && fd === 1) {`,
    `    if (typeof buf === 'string') return Buffer.byteLength(buf);`,
    `    const offset = typeof rest[0] === 'number' ? rest[0] : 0;`,
    `    return Math.max(1, buf.length - offset);`,
    `  }`,
    `  return realWriteSync(fd, buf, ...rest);`,
    `};`,
    `const stdoutWrite = process.stdout.write.bind(process.stdout);`,
    `process.stdout.write = (chunk, ...rest) => (hold ? true : stdoutWrite(chunk, ...rest));`,
    `process.exit = (code) => (hold ? undefined : realExit(code));`,
    `const beat = (cpu, marks) => realWriteSync(2, 'c2c-gallery-progress ' + cpu + ' ' + marks + '\\n');`,
    `const publish = (row) => { hold = false; realWriteSync(1, JSON.stringify(row) + '\\n'); realExit(0); };`,
    ...lines,
    '',
  ].join('\n');
}

test('gallery watchdog: a silent app is killed at the idle limit; one that keeps reporting progress is not killed', async (t) => {
  const target = join(root, 'fixtures/dialects/d1-minimal.ds');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-gallery-beats-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const savedOptions = process.env.NODE_OPTIONS;
  t.after(() => {
    if (savedOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedOptions;
  });
  const requireScript = (file: string) => {
    const flag = `--require ${JSON.stringify(file)}`;
    process.env.NODE_OPTIONS = savedOptions ? `${savedOptions} ${flag}` : flag;
  };

  // 50 ms beats and an idle limit of 1 s (20 beats of slack). The progress
  // run is longer than twice that limit, so a beat that does not count is
  // killed before the script finishes. The quiet script would exit
  // successfully after a late idle check, still ahead of a wall backstop at
  // least five idle limits out, so only the idle kill produces its timeout.
  const beatMs = 50;
  const idleMs = 1_000;
  const progressMs = 10_000;
  const silentExitMs = 40_000;
  const wallMs = 60_000;
  assert.ok(idleMs >= beatMs * 20);
  assert.ok(progressMs > idleMs * 2);
  assert.ok(wallMs >= idleMs * 5);
  assert.ok(silentExitMs > progressMs && silentExitMs < wallMs);

  // Above any CPU time a short run accumulates, so a sample never sits
  // below the heartbeat's cumulative value. Each later beat adds 1000 us,
  // more than the 500 us floor of a 50 ms beat. The beats run on a worker
  // so they continue while the app's main thread is busy.
  const cpuBase = 100_000_000;
  const workerSource = [
    `'use strict';`,
    `const { writeSync } = require('node:fs');`,
    `const { workerData } = require('node:worker_threads');`,
    `let marks = 0;`,
    `let cpu = ${cpuBase};`,
    `const timer = setInterval(() => {`,
    `  if (Atomics.load(workerData, 0) === 1) { clearInterval(timer); return; }`,
    `  const usage = process.cpuUsage();`,
    `  cpu = Math.max(cpu, usage.user + usage.system) + 1000;`,
    `  marks += 1;`,
    `  writeSync(2, 'c2c-gallery-progress ' + cpu + ' ' + marks + '\\n');`,
    `}, ${beatMs});`,
  ].join('\n');
  const silent = join(dir, 'silent.cjs');
  writeFileSync(
    silent,
    galleryBeatScript([
      `const usage = process.cpuUsage();`,
      `beat(Math.max(${cpuBase}, usage.user + usage.system) + 1000, 1);`,
      `setTimeout(() => publish({ ok: true }), ${silentExitMs});`,
    ]),
  );
  requireScript(silent);
  const silentStarted = Date.now();
  const quiet = await runApp(target, 1, { heartbeatMs: 0, idleMs, wallMs });
  const silentTook = Date.now() - silentStarted;
  assert.deepEqual(quiet, { error: 'timed out', kind: 'environment', cause: 'timeout' });
  assert.ok(silentTook > idleMs && silentTook < wallMs, `killed by the idle limit at ${silentTook} ms`);

  const fake = join(dir, 'progress.cjs');
  writeFileSync(
    fake,
    galleryBeatScript([
      `const { Worker } = require('node:worker_threads');`,
      `const stop = new Int32Array(new SharedArrayBuffer(4));`,
      `new Worker(${JSON.stringify(workerSource)}, { eval: true, workerData: stop });`,
      `const started = Date.now();`,
      `const timer = setInterval(() => {`,
      `  if (Date.now() - started < ${progressMs}) return;`,
      `  clearInterval(timer);`,
      `  Atomics.store(stop, 0, 1);`,
      `  publish({ ok: true });`,
      `}, ${beatMs});`,
    ]),
  );
  requireScript(fake);
  const row = await runApp(target, 1, { idleMs, heartbeatMs: beatMs, wallMs });
  assert.deepEqual(row, { ok: true });
});

test('gallery watchdog: a silent app hits the wall backstop', async () => {
  const target = join(root, 'fixtures/dialects/d1-minimal.ds');
  // Without a heartbeat nothing anchors the idle clock: the wall backstop
  // bounds the process instead. The limits sit below the shortest possible
  // start-up, so the kill lands long before the app could ever finish; a
  // small idleMs only narrows the watchdog's check interval.
  const silent = await runApp(target, 1, { heartbeatMs: 0, idleMs: 200, wallMs: 200 });
  assert.deepEqual(silent, { error: 'timed out', kind: 'environment', cause: 'timeout' });
});

/** One heartbeat the app process reported, as the watchdog saw it. */
interface Beat {
  at: number;
  cpuMicros: number;
  marks: number;
  counted: boolean;
}

/** Runs one app with real (generous) limits and records every heartbeat the watchdog counted. */
async function timedRun(target: string, opts: RunAppOptions, iterations = 6): Promise<{ row: AppResult; startedAt: number; beats: Beat[] }> {
  const beats: Beat[] = [];
  const startedAt = Date.now();
  const row = await runApp(target, iterations, { ...opts, onBeat: (b) => beats.push(b) });
  return { row, startedAt, beats };
}

/**
 * Replays recorded heartbeats through the watchdog's progress tracker on the
 * recorded times: the first time `limits` would have killed the process, if
 * any. Deciding on the recorded beats, not on a second run, keeps the verdict
 * exact no matter how loaded the machine is.
 */
function replay(beats: Beat[], startedAt: number, limits: Watchdog): number | undefined {
  const progress = new AppProgress(startedAt, limits);
  // Judge the silence before each recorded beat, not only the instant after
  // it: a beat that restarts the idle clock hides whatever came before it.
  for (const b of beats) {
    if (progress.expired(b.at)) return b.at;
    progress.beat(b.at, b.cpuMicros, b.marks);
  }
  const last = beats[beats.length - 1];
  if (last !== undefined && progress.expired(last.at)) return last.at;
  return undefined;
}

/** The counted beats' times, the widest gap between two of them, and how long reporting went on after the first. */
function countedSpan(beats: Beat[]): { times: number[]; maxGap: number; span: number } {
  const times = beats.filter((b) => b.counted).map((b) => b.at);
  let maxGap = 0;
  for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap, times[i]! - times[i - 1]!);
  return { times, maxGap, span: times.length > 1 ? times[times.length - 1]! - times[0]! : 0 };
}

test('gallery watchdog: a real app process that keeps reporting progress outlives the idle limit', async () => {
  const target = join(root, 'fixtures/dialects/d1-minimal.ds');
  // Default limits, so the live run cannot lose on wall-clock however busy
  // the machine is; the idle decision is then replayed below on the beats
  // the process actually reported.
  const { row, startedAt, beats } = await timedRun(target, { heartbeatMs: 250 });
  assert.ok(!('error' in row), `not killed: ${JSON.stringify(row)}`);
  const { times, maxGap, span } = countedSpan(beats);
  assert.ok(times.length > 1, 'the app process reported progress');
  // The replayed idle limit sits a wide margin above the widest gap between
  // counted beats the run produced, and far below how long the app kept
  // reporting — so a watchdog that did not restart the idle clock on progress
  // would have killed the process inside the recorded span.
  const idleMs = Math.max(2 * maxGap, 500);
  assert.ok(span > idleMs, `the app kept reporting for ${span} ms, well past one idle budget of ${idleMs} ms`);
  const expiredAt = replay(beats, startedAt, watchdogFor({ idleMs, heartbeatMs: 250, cpuMs: Infinity, wallMs: Infinity }));
  assert.equal(expiredAt, undefined, `progress beats every ${maxGap} ms or better must never trip an idle limit of ${idleMs} ms`);
});

test('gallery watchdog: a slow start before the first report does not eat the idle budget', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-gallery-slow-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A preload that blocks before the module graph loads delays the first
  // heartbeat past the idle limit, the way a busy machine does. The preload
  // consumes the flag, so the delay lands once — in the app process — and
  // the processes the app itself spawns are not slowed.
  const preload = join(dir, 'delay.cjs');
  writeFileSync(
    preload,
    `const ms = Number(process.env.C2C_SLOW_START_MS);\nif (ms > 0) { delete process.env.C2C_SLOW_START_MS; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }\n`,
  );
  const savedOptions = process.env.NODE_OPTIONS;
  const savedFlag = process.env.C2C_SLOW_START_MS;
  t.after(() => {
    if (savedOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedOptions;
    if (savedFlag === undefined) delete process.env.C2C_SLOW_START_MS;
    else process.env.C2C_SLOW_START_MS = savedFlag;
  });
  process.env.NODE_OPTIONS = `${savedOptions ? `${savedOptions} ` : ''}--require ${preload}`;
  const target = join(root, 'fixtures/dialects/d1-minimal.ds');

  let delayMs = 6_000;
  let startedAt = 0;
  let beats: any[] = [];
  let maxGap = 0;
  let span = 0;
  let startup = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    process.env.C2C_SLOW_START_MS = String(delayMs);
    // Default limits on the live run: however long the delayed process takes,
    // it is not killed. What the idle clock made of that start-up is then
    // replayed on the recorded beats.
    const started = Date.now();
    const run = await timedRun(target, { heartbeatMs: 250 });
    assert.ok(!('error' in run.row), `not killed during start-up: ${JSON.stringify(run.row)}`);
    assert.ok(Date.now() - started > delayMs, 'the injected delay ran inside the app process');
    const counted = countedSpan(run.beats);
    maxGap = counted.maxGap;
    span = counted.span;
    beats = run.beats;
    startedAt = run.startedAt;
    const firstBeat = counted.times[0];
    assert.ok(firstBeat !== undefined, 'the app process reported progress');
    startup = firstBeat - startedAt;
    
    // The first report lands only after the injected delay: a start-up silence
    // far wider than any later gap between counted beats.
    assert.ok(startup > delayMs - 2 * 250, `the first report took ${startup} ms (the injected delay is ${delayMs} ms)`);
    
    if (startup > maxGap) break;
    if (attempt === 3) assert.fail(`maxGap (${maxGap} ms) >= startup (${startup} ms) even with a ${delayMs} ms injected delay`);
    delayMs += 4_500;
  }
  // An idle limit above the widest later gap between counted beats, and
  // below the start-up silence: the clock starts at the first report, so the
  // silence costs nothing, and the app then keeps reporting well past one
  // idle budget — a watchdog that did not restart the idle clock on progress
  // would kill inside the span. Twice the widest gap is that budget when it
  // already sits under the silence. When a counted gap is more than half the
  // silence, twice that gap would land above it and reject a trace the
  // default idle limit allows; the widest gap itself still clears every
  // counted gap (the comparison is strict) and stays under the silence.
  const doubled = Math.max(2 * maxGap, 500);
  const idleMs = doubled < startup ? doubled : Math.max(maxGap, 500);
  assert.ok(startup > idleMs, `the start-up silence of ${startup} ms exceeds the idle budget of ${idleMs} ms`);
  assert.ok(span > idleMs, `the app kept reporting for ${span} ms, well past one idle budget of ${idleMs} ms`);
  const expiredAt = replay(beats, startedAt, watchdogFor({ idleMs, heartbeatMs: 250, cpuMs: Infinity, wallMs: Infinity }));
  assert.equal(expiredAt, undefined, `the slow start must not eat the idle budget of ${idleMs} ms`);
});

const ROW = { compiles: { ok: true, modules: 2, nodeCheckFailures: 0, scanned: 2, freeIdentifiers: 0, modulesWithFreeIdentifiers: 0, freeByName: {}, typeChecked: 2, typeErrors: 0, typeByCode: {}, typeAdvisories: 0, templateTypeErrors: 0 }, smokeClean: { ok: true, handlers: 1, calls: 2, handlersWithCrash: 0, handlersCrashOnValid: 0, crashByClass: {}, delugeByClass: {}, unmappedByClass: {}, importFailures: 0 }, prefetch: { modules: 1, nonReads: 0, byOp: {} }, crashSignatures: {}, crashOnValidSignatures: {}, unmappedSignatures: {}, typeMessages: {} };
const QUIET = () => ({ cores: 8, load1: 0 });

/** A gallery of the redistributable dialect fixtures, plus any extra entries. */
function fixtureGallery(extra: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-gallery-sweep-'));
  for (const name of ['d1-minimal.ds', 'd2-minimal.ds']) copyFileSync(join(root, 'fixtures/dialects', name), join(dir, name));
  extra(dir);
  return dir;
}

test('gallery watchdog: an app process blocked with its heartbeat still running is killed, retried, and reported failed', async (t) => {
  // Parsing refuses a fifo ('is not a file'), so opening one no longer blocks
  // the app and the watchdog never fires. The child instead blocks its main
  // thread (--stall-idle) while the heartbeat worker in that process keeps
  // reporting. The file itself is a regular file.
  const dir = mkdtempSync(join(tmpdir(), 'c2c-gallery-blocked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'blocked.ds'), 'form Blocked\n{\n}\n');
  const idleMs = 1_500;
  const took: number[] = [];
  const run = async (target: string, n: number) => {
    const started = Date.now();
    const r = await runApp(target, n, { idleMs, heartbeatMs: 250, stallIdle: true });
    took.push(Date.now() - started);
    return r;
  };
  let settled = false;
  const sweep = runGallery(dir, 1, { run, load: QUIET }).then(
    () => null,
    (e: unknown) => e,
  );
  void sweep.then(() => (settled = true));
  const deadline = Date.now() + 60_000;
  while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.equal(settled, true, 'the blocked app process was not killed within 60 s');
  const err = await sweep;
  assert.ok(err instanceof GalleryIncomplete, 'a blocked app yields no summary');
  assert.deepEqual(err.sweep.rows, [{ error: 'timed out', kind: 'environment', cause: 'timeout' }]);
  assert.equal(err.sweep.stats.timeouts, 3, 'the first attempt and two retries all time out');
  assert.equal(err.sweep.stats.failed, 1);
  for (const ms of took) {
    assert.ok(ms > idleMs, `killed after the idle limit, not before (${ms} ms)`);
    assert.ok(ms < 60_000, `the blocked app process was not killed within 60 s (${ms} ms)`);
  }
});

test('gallery sweep: an environmental failure is retried, an app failure is not', async () => {
  const dir = fixtureGallery();
  try {
    const calls: string[] = [];
    const flaky = async (target: string, _n: number, attempt: number): Promise<AppResult> => {
      calls.push(`${target.endsWith('d1-minimal.ds') ? 'd1' : 'd2'}#${attempt}`);
      if (target.endsWith('d1-minimal.ds') && attempt === 0) return { error: 'timed out', kind: 'environment', cause: 'timeout' };
      return ROW;
    };
    const { rows, stats } = await sweepGallery(dir, 1, { run: flaky, load: QUIET });
    assert.deepEqual(rows, [ROW, ROW]);
    assert.deepEqual(calls.sort(), ['d1#0', 'd1#1', 'd2#0']);
    assert.equal(stats.timeouts, 1);
    assert.equal(stats.retries, 1);
    assert.equal(stats.recovered, 1);
    assert.equal(stats.failed, 0);
    assert.match(statsLine(stats), / parallel=4\.\.4$/, 'the range is of one quantity, the processes allowed at once');

    let appCalls = 0;
    const broken = async (target: string): Promise<AppResult> => {
      if (!target.endsWith('d1-minimal.ds')) return ROW;
      appCalls++;
      return { error: 'TypeError: generator failed', kind: 'app', cause: 'error' };
    };
    await assert.rejects(runGallery(dir, 1, { run: broken, load: QUIET }), (err: unknown) => err instanceof GalleryIncomplete && /app 1: app TypeError/.test(err.message));
    assert.equal(appCalls, 1, 'an app failure is never retried');

    let envCalls = 0;
    const stuck = async (target: string): Promise<AppResult> => {
      if (!target.endsWith('d1-minimal.ds')) return ROW;
      envCalls++;
      return { error: 'killed by SIGKILL', kind: 'environment', cause: 'signal' };
    };
    let seen: number | undefined;
    await assert.rejects(runGallery(dir, 1, { run: stuck, load: QUIET, onStats: (st) => (seen = st.signals) }), GalleryIncomplete);
    assert.equal(envCalls, 3, 'the first attempt and two retries');
    assert.equal(seen, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gallery sweep: a timed-out app process is retried and the summary matches a quiet run', async () => {
  const dir = fixtureGallery();
  try {
    const quiet = await runGallery(dir, 1, { load: QUIET });
    let stats: { timeouts: number; retries: number; recovered: number } | undefined;
    // The first attempt of the first app gets a 1 ms wall limit: a real timeout and kill.
    const injected = (target: string, n: number, attempt: number) => runApp(target, n, attempt === 0 && target.endsWith('d1-minimal.ds') ? { wallMs: 1 } : {});
    const busy = await runGallery(dir, 1, { run: injected, load: QUIET, onStats: (st) => (stats = st) });
    assert.equal(stats?.timeouts, 1);
    assert.equal(stats?.retries, 1);
    assert.equal(stats?.recovered, 1);
    assert.equal(busy.appErrors, 0);
    assert.equal(asMarkdown(busy), asMarkdown(quiet));
    assert.equal(JSON.stringify(busy), JSON.stringify(quiet));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gallery sweep: an app whose process fails on its own is reported once, not retried away', async () => {
  // A project with a malformed edits log: loading it throws the same way on every attempt.
  const dir = fixtureGallery((d) => {
    mkdirSync(join(d, 'p-broken'));
    copyFileSync(join(root, 'fixtures/dialects/d1-minimal.ds'), join(d, 'p-broken', 'app.ds'));
    writeFileSync(join(d, 'p-broken', 'c2c.edits.json'), '{');
  });
  try {
    const attempts: number[] = [];
    const counted = (target: string, n: number, attempt: number) => {
      if (target.endsWith('p-broken')) attempts.push(attempt);
      return runApp(target, n);
    };
    const err = await runGallery(dir, 1, { run: counted, load: QUIET }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof GalleryIncomplete, 'a failed app yields no summary');
    assert.deepEqual(attempts, [0]);
    const failed = err.sweep.rows[2] as AppResult & { kind?: string };
    assert.equal(failed.kind, 'app');
    assert.match((failed as { error: string }).error, /not valid JSON/);
    assert.equal(err.sweep.stats.failed, 1);
    assert.equal(err.sweep.stats.retries, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
