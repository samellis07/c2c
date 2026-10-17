import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type App, type FunctionDef, type Workflow } from '../../core/src/index.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { generate } from '../src/generate.js';
import { translate } from '../src/translate.js';

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

const Z = { start: 0, end: 0 };

// A same-app function result cannot be one prefetch snapshot, so an `info`
// under it as a client action is a counted todo. A server-only unit (a
// schedule or a standalone function) has no client half: the info is the
// run's debug log on the server.
const SCRIPT = `for each code in thisapp.openCodes()
{
  info code;
}
if(thisapp.isClosed(1))
{
  info "none";
}
return 2;`;

function constructs(todos: { construct: string }[]): string[] {
  return todos.map((t) => t.construct).sort();
}

test('info in a server-only unit writes the server log, not a client action', async () => {
  const tr = translate(SCRIPT, { serverOnly: true });
  assert.deepEqual(constructs(tr.todos), []);
  assert.doesNotMatch(stripComments(tr.client), /op: "info"/);
  assert.match(stripComments(tr.server), /shim\.log\.info\(ctx, code\);/);
  assert.match(stripComments(tr.server), /shim\.log\.info\(ctx, "none"\);/);

  const runtime = createRuntime({ dryRun: true });
  const logged: unknown[] = [];
  const shim = {
    ...runtime.shim,
    thisapp: { call: async (_ctx: unknown, path: string[]) => (path[0] === 'openCodes' ? ['A', 'B'] : true) },
    log: { info: (_ctx: unknown, value: unknown) => { logged.push(value); } },
  };
  const ctx = runtime.context({ record: {} });
  const run = new Function('shim', 'ctx', `return (async () => {\n${tr.server}\n})();`) as (...a: unknown[]) => Promise<unknown>;
  assert.equal(await run(shim, ctx), 2);
  assert.deepEqual(logged, ['A', 'B', 'none']);
});

test('without serverOnly the same info stays a counted client todo', () => {
  const tr = translate(SCRIPT);
  assert.ok(constructs(tr.todos).includes('client-loop-uses-server'));
  assert.ok(constructs(tr.todos).includes('client-condition-uses-server'));
  assert.doesNotMatch(stripComments(tr.server), /shim\.log\.info/);
});

test('an untranslatable info value in a server-only unit stays a counted todo', () => {
  const tr = translate('info frob.zap(1);', { serverOnly: true });
  assert.deepEqual(constructs(tr.todos), ['method:zap']);
});

function fnDef(name: string, text: string): FunctionDef {
  return { name, kind: 'creator', properties: [], deluge: [{ text, span: Z }], span: Z };
}

test('generate logs a function info on the server and keeps a form workflow info a client action', () => {
  const wf: Workflow = {
    name: 'Show_Note',
    event: 'on load',
    form: 'Orders',
    deluge: { text: 'info "hello";', span: Z },
    properties: [],
    span: Z,
  } as Workflow;
  const app: App = {
    ...emptyApp('empty'),
    name: 'Demo_App',
    forms: [{ name: 'Orders', properties: [], fields: [], actions: [], blocks: [], span: Z }],
    functions: [fnDef('countOpen', 'n = Orders[Status == "Open"].count();\nif(n == 0)\n{\n  info "none";\n}\nreturn n;')],
    workflows: [wf],
  };
  const g = generate(app);
  const server = g.files.find((f) => f.path === 'functions/custom/countopen.mjs');
  assert.ok(server);
  assert.match(stripComments(server.source), /shim\.log\.info\(ctx, "none"\);/);
  assert.equal(g.files.find((f) => f.path === 'client/handlers/functions/countopen.mjs'), undefined);
  assert.ok(!g.todos.some((t) => t.construct === 'client-condition-uses-server'));
  const handler = g.files.find((f) => f.path.startsWith('client/handlers/') && !f.path.includes('/functions/') && /op: "info"/.test(f.source));
  assert.ok(handler, 'the form workflow info is still a client action');
});

test('a client action in a server-only unit is not emitted, and todos in its arguments stay counted', () => {
  const src = [
    'openUrl("#Report:Orders?c=" + Orders[Code == "a"].Code, "same window");',
    'input.Status:ui.enable();',
    'disable Status;',
    'reload;',
    'openUrl(frob.zap(1), "same window");',
  ].join("\n");
  const tr = translate(src, { serverOnly: true });
  assert.deepEqual(constructs(tr.todos), ['method:zap']);
  assert.equal(tr.server, '');
  assert.equal(tr.client, '');
  assert.equal(tr.prefetch, '');
  assert.equal(tr.stats.todo, 1);
  // Without the option the server read in the first URL is a client-split todo.
  assert.deepEqual(constructs(translate(src).todos), ['client-condition-uses-server', 'method:zap']);
});

test('a server-only unit loop over a same-app call is server code, not a client-loop todo', () => {
  const src = 'for each r in thisapp.rows() { if (Orders[Code == r].count() > 0) { insert into Orders [ Code = r ]; } }';
  const plain = translate(src);
  const only = translate(src, { serverOnly: true });
  assert.equal(only.server, plain.server);
  assert.deepEqual(constructs(only.todos), []);
  assert.equal(only.client, '');
});

// A server-only unit ships no client half, so a statement whose dropped
// client part names a shim the browser lacks is dead code, not a gap. The
// same statement in a form workflow keeps its counted client-shim-unsupported
// todo because the browser runs that handler.
const FETCH_LOOP = 'rows = Orders[Status == "Open"];\ntotal = 0;\nfor each r in rows\n{\n  total = total + r.Amount;\n}\nreturn total;';

test('a dropped client statement in a server-only unit is not a counted gap', async () => {
  const only = translate(FETCH_LOOP, { serverOnly: true });
  assert.match(only.server, /shim\.datastore\.(rows|query)/);
  assert.equal(only.client, '');
  assert.deepEqual(only.clientGaps, []);
  assert.deepEqual(constructs(only.todos), []);

  // The server half is real code: the offline shim runtime executes it.
  const runtime = createRuntime({ dryRun: true });
  const run = new Function('shim', 'ctx', `return (async () => {\n${only.server}\n})();`) as (...a: unknown[]) => Promise<unknown>;
  await run(runtime.shim, runtime.context({ record: {} }));

  const app: App = {
    ...emptyApp('empty'),
    name: 'Demo_App',
    forms: [{ name: 'Orders', properties: [], fields: [], actions: [], blocks: [], span: Z }],
    functions: [fnDef('openOrders', FETCH_LOOP)],
  };
  const g = generate(app);
  assert.ok(!g.todos.some((t) => t.construct === 'client-shim-unsupported'));
  assert.equal(g.files.find((f) => f.path.startsWith('client/handlers/functions/')), undefined);

  // A unit with a real client half keeps the counted gap for a statement the
  // browser cannot run.
  const wf: Workflow = {
    name: 'Scan',
    event: 'on load',
    form: 'Orders',
    deluge: { text: 'input.Name = input.Name.toUpperCase();\ninfo "done";', span: Z },
    properties: [],
    span: Z,
  } as Workflow;
  const mixed = generate({ ...app, workflows: [wf] });
  assert.ok(mixed.todos.some((t) => t.construct === 'client-shim-unsupported'));
});

test('a server-only unit statement whose server half is a todo stays counted', () => {
  const src = 'for each r in Orders[Status == "Open"]\n{\n  info frob.zap(r.Name);\n}';
  const only = translate(src, { serverOnly: true });
  assert.equal(only.stats.todo, 1);
  assert.deepEqual(constructs(only.todos), ['method:zap']);
  assert.deepEqual(only.clientGaps, []);

  const app: App = {
    ...emptyApp('empty'),
    name: 'Demo_App',
    forms: [{ name: 'Orders', properties: [], fields: [], actions: [], blocks: [], span: Z }],
    functions: [fnDef('openOrders', src)],
  };
  const g = generate(app);
  assert.deepEqual(constructs(g.todos), ['method:zap']);
});
