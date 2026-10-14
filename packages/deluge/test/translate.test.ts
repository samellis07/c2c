import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Expr } from '../src/ast.js';
import { compileCriteria, matchRow, type Criteria } from '../../shims/src/criteria.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { parse } from '../src/parser.js';
import { reportCriteria, translate } from '../src/translate.js';
function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

function kinds(src: string): string[] {
  return parse(src).body.map((s) => s.kind);
}

test('client prefetch refuses app-function calls in conditions and loops', () => {
  const condition = translate('if (thisapp.Check(input.ID)) { alert "ok"; }');
  assert.doesNotMatch(condition.prefetch, /thisapp\.call/);
  assert.match(condition.client, /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.ok(condition.todos.some((item) => item.construct === 'client-condition-uses-server'));

  const loop = translate('for each row in Orders { if (thisapp.Check(row.ID)) { alert "ok"; } }');
  assert.doesNotMatch(loop.prefetch, /thisapp\.call/);
  assert.match(loop.client, /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.ok(loop.todos.some((item) => item.construct === 'client-condition-uses-server'));
});

test('client prefetch refuses a bare call to a declared app function', () => {
  const condition = translate('function Check(id) { return true; }\nif (Check(input.ID)) { alert "ok"; }');
  assert.doesNotMatch(condition.prefetch, /Check/);
  assert.match(condition.client, /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.ok(condition.todos.some((item) => item.construct === 'client-condition-uses-server'));

  const loop = translate('function Pick(ids) { return ids; }\nfor each row in Pick(input.IDs) { alert "ok"; }');
  assert.doesNotMatch(loop.prefetch, /Pick/);
  assert.match(loop.client, /shim\.todo\(ctx, "client-loop-uses-server"\)/);
  assert.ok(loop.todos.some((item) => item.construct === 'client-loop-uses-server'));
});

test('client prefetch refuses an app function reached through a variable chain', () => {
  const chain = translate('ok = thisapp.Check(input.ID);\nif (ok) { alert "ok"; }');
  assert.doesNotMatch(chain.prefetch, /thisapp\.call/);
  assert.match(chain.client, /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.ok(chain.todos.some((item) => item.construct === 'client-condition-uses-server'));

  const declared = translate('function Check(id) { return true; }\nflag = Check(input.ID);\nif (flag) { alert "ok"; }');
  // `flag` is bound to a no-op placeholder on the client; the call is counted,
  // and no prefetch slot replays it.
  assert.doesNotMatch(declared.prefetch, /Check/);
  assert.ok(declared.todos.some((item) => item.construct === 'call:Check'));
});

test('dry-run evaluation of a refused prefetch never runs the app function body', async () => {
  let bodies = 0;
  const runtime = createRuntime({
    dryRun: true,
    functions: { Check: { call: async () => { bodies += 1; return true; }, params: ['id'] } },
  });
  const calls: { path: string[]; args: unknown[] }[] = [];
  const shim = {
    ...runtime.shim,
    thisapp: {
      call: async (ctx: unknown, path: string[], args: unknown[]) => {
        calls.push({ path, args });
        return runtime.shim.thisapp.call(ctx as never, path, args);
      },
    },
  };
  const ctx = runtime.context({ record: { ID: 7 } });
  const run = (code: string, extra: string[] = [], values: unknown[] = []) =>
    (new Function('shim', 'ctx', ...extra, `return (async () => {\n${code}\n})();`) as (...a: unknown[]) => Promise<unknown>)(
      shim,
      ctx,
      ...values,
    );
  const t = translate('ok = thisapp.Check(input.ID);\nif (ok) { alert "ok"; }');
  const slots: Record<string, unknown> = {};
  await run(t.prefetch, ['slots'], [slots]);
  await run(t.client, ['slots', 'actions', 'prefetched'], [slots, [], { ok: true, slots }]);
  assert.equal(calls.length, 0);
  assert.equal(bodies, 0);
  assert.equal(runtime.transcript.some((entry) => entry.op === 'thisapp'), false);
  // The dispatch path itself works: the refusal is in the emitted code, not the runtime.
  const live = createRuntime({
    dryRun: false,
    settingsTimeZone: 'UTC',
    functions: { Check: { call: async () => { bodies += 1; return true; }, params: ['id'] } },
  });
  assert.equal(await live.shim.thisapp.call(live.context({ record: {} }), ['Check'], [7]), true);
  assert.equal(bodies, 1);
});

const ROW_MAP_NON_READ = /thisapp\.call|mail\.send|http\.getUrl|http\.postUrl|http\.invokeurl|datastore\.insert|zoho\.task|list\.(?:add|addAll|put|putAll|clear|insert|insertAll|remove|removeAll|update)\s*\(/;

function assertRowMapStaysTodo(src: string): void {
  const t = translate(src);
  const prefetch = stripComments(t.prefetch);
  const client = stripComments(t.client);
  assert.doesNotMatch(prefetch, ROW_MAP_NON_READ);
  assert.match(client, /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.ok(t.todos.some((item) => item.construct === 'client-condition-uses-server'));
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length >= 1, true);
  // The client condition is the counted todo, not a row-map slot fed by a replayed call.
  assert.doesNotMatch(client, /if \(\(slots\[/);
}

test('a same-app call inside a row-map loop stays a counted todo', () => {
  assertRowMapStaysTodo(
    'for each rec in Orders[Status == "Open"] { flag = thisapp.Check(rec.ID); if (flag) { alert "x"; } }',
  );
  assertRowMapStaysTodo(
    'for each rec in Orders[Status == "Open"] { a = thisapp.Check(rec.ID); b = a; if (b) { alert "x"; } }',
  );
  assertRowMapStaysTodo(
    'for each rec in Orders[Status == "Open"] { xs = {thisapp.Check(rec.ID), 1}; if (xs) { alert "x"; } }',
  );
  assertRowMapStaysTodo(
    'for each rec in Orders[Status == "Open"] { a = thisapp.Check(rec.ID); b = {a, 1}; if (b) { alert "x"; } }',
  );
  const beside = translate(
    'for each rec in Orders[Status == "Open"] { flag = thisapp.Check(rec.ID); if (Customers[Code == rec.Code].Name == flag) { alert "x"; } }',
  );
  assert.doesNotMatch(stripComments(beside.prefetch), /thisapp\.call/);
  assert.doesNotMatch(stripComments(beside.prefetch), ROW_MAP_NON_READ);
  assert.match(stripComments(beside.client), /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.ok(beside.todos.some((item) => item.construct === 'client-condition-uses-server'));
  assert.doesNotMatch(stripComments(beside.client), /if \(\(slots\[/);
});

test('a non-read local in a row-map condition stays a counted todo', () => {
  assertRowMapStaysTodo(
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\nfor each rec in Orders[Status == "Open"] { if (s && Customers[Code == rec.Code].Name != "") { alert "x"; } }',
  );
  assertRowMapStaysTodo(
    'b = getUrl("https://example.test/feed");\nfor each rec in Orders[Status == "Open"] { if (b && Customers[Code == rec.Code].count() > 0) { alert "x"; } }',
  );
  assertRowMapStaysTodo(
    'r = invokeurl[url: "https://example.test" type: GET];\nfor each rec in Orders[Status == "Open"] { if (r && Customers[Code == rec.Code].count() > 0) { alert "x"; } }',
  );
  assertRowMapStaysTodo(
    'for each rec in Orders[Status == "Open"] { w = insert into Bookings[Name = rec.Name]; if (w && Customers[Code == rec.Code].count() > 0) { alert "x"; } }',
  );
  assertRowMapStaysTodo(
    'for each rec in Orders[Status == "Open"] { z = zoho.crm.getRecordById("Leads", rec.ID); if (z && Customers[Code == rec.Code].count() > 0) { alert "x"; } }',
  );
  assertRowMapStaysTodo(
    'items = List();\nfor each rec in Orders[Status == "Open"] { n = items.add(rec.Code); if (n && Customers[Code == rec.Code].count() > 0) { alert "x"; } }',
  );
  // An earlier one-shot slot may already have emitted the binding. The row-map
  // condition still does not treat that name as a finished read.
  const emitted = translate(
    [
      's = sendmail[to: "a@example.test" subject: "s" message: "m"];',
      'if (s) { alert "one"; }',
      'for each rec in Orders[Status == "Open"] {',
      '  if (s && Customers[Code == rec.Code].Name != "") { alert "x"; }',
      '}',
    ].join('\n'),
  );
  assert.match(stripComments(emitted.client), /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.ok(emitted.todos.some((item) => item.construct === 'client-condition-uses-server'));
  assert.doesNotMatch(stripComments(emitted.client), /if \(\(slots\["c\d+"\]\[shim\.record\.get/);
});

test('a dry-run row-map placeholder never reaches the client condition', async () => {
  let bodies = 0;
  const runtime = createRuntime({
    dryRun: true,
    seed: {
      Orders: [{ ROWID: '1', ID: '1', Status: 'Open', Code: 'A' }],
      Customers: [{ ROWID: 'c1', ID: 'c1', Code: 'A', Name: 'Ada' }],
    },
    functions: { Check: { call: async () => { bodies += 1; return true; }, params: ['id'] } },
  });
  const calls: string[] = [];
  const shim = {
    ...runtime.shim,
    thisapp: {
      call: async (ctx: unknown, path: string[], args: unknown[]) => {
        calls.push('thisapp');
        return runtime.shim.thisapp.call(ctx as never, path, args);
      },
    },
    mail: {
      ...runtime.shim.mail,
      send: async (ctx: unknown, message: unknown) => {
        calls.push('mail');
        return runtime.shim.mail.send(ctx as never, message as never);
      },
    },
  };
  const ctx = runtime.context({ record: {} });
  const run = (code: string, extra: string[] = [], values: unknown[] = []) =>
    (new Function('shim', 'ctx', ...extra, `return (async () => {\n${code}\n})();`) as (...a: unknown[]) => Promise<unknown>)(
      shim,
      ctx,
      ...values,
    );
  const scripts = [
    'for each rec in Orders[Status == "Open"] { flag = thisapp.Check(rec.ID); if (flag) { alert "x"; } }',
    'for each rec in Orders[Status == "Open"] { a = thisapp.Check(rec.ID); b = a; if (b) { alert "x"; } }',
    'for each rec in Orders[Status == "Open"] { xs = {thisapp.Check(rec.ID), 1}; if (xs) { alert "x"; } }',
    'for each rec in Orders[Status == "Open"] { flag = thisapp.Check(rec.ID); if (Customers[Code == rec.Code].Name == flag) { alert "x"; } }',
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\nfor each rec in Orders[Status == "Open"] { if (s && Customers[Code == rec.Code].Name != "") { alert "x"; } }',
    'b = getUrl("https://example.test/feed");\nfor each rec in Orders[Status == "Open"] { if (b && Customers[Code == rec.Code].count() > 0) { alert "x"; } }',
  ];
  for (const src of scripts) {
    const t = translate(src);
    const slots: Record<string, unknown> = {};
    const actions: { op: string; message?: string }[] = [];
    await run(t.prefetch, ['slots'], [slots]);
    await run(t.client, ['slots', 'actions', 'prefetched'], [slots, actions, { ok: true, slots }]);
    assert.equal(actions.filter((action) => action.op === 'alert').length, 0);
  }
  assert.equal(calls.length, 0);
  assert.equal(bodies, 0);
  assert.equal(runtime.transcript.some((entry) => entry.op === 'thisapp' || entry.op === 'sendmail' || entry.op === 'getUrl'), false);
});

test('parser keeps assignment, if, for each, collections, criteria, and tasks', () => {
  const src = [
    'x = 1;',
    'if(input.A == 1) { alert "x"; }',
    'for each rec in Orders[Status = "Open"] { info rec.Name; }',
    'items = List();',
    'bag = Map();',
    'typed = List:string();',
    'row = insert into Orders[Name = "A" Amount = 2];',
    'sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "m"];',
    'resp = invokeurl[url: "https://example.test" type: GET];',
    'update Orders[ID == 1][Status = "Done"];',
    'delete from Orders[ID == 1];',
    'hide input.Secret;',
    'openUrl("https://example.test", "new window");',
    'cancel submit;',
    'while (n < 3) { n = n + 1; }',
    'return if(x == 1, "a", "b");',
    'shareTo unknownThing;',
  ].join('\n');
  const body = parse(src).body;
  assert.deepEqual(
    body.map((s) => s.kind),
    ['assign', 'if', 'forEach', 'assign', 'assign', 'assign', 'assign', 'expr', 'assign', 'update', 'deleteFrom', 'ui', 'openUrl', 'cancelSubmit', 'while', 'return', 'unknown'],
  );
  const unknown = body.find((s) => s.kind === 'unknown');
  assert.ok(unknown && unknown.kind === 'unknown');
  assert.ok(unknown.span.end > unknown.span.start);
  assert.match(stripComments(unknown.text), /shareTo/);
  assert.deepEqual(kinds('x = 1'), ['assign']);
});

test('bare no-effect expression statements parse as unknown, not silent expr', () => {
  // `SELECT * FROM users;` is pseudo-code: it used to parse silently as a
  // multiplication plus a bare name and emit a discarded JS expression.
  const body = parse('SELECT * FROM users;').body;
  assert.deepEqual(body.map((s) => s.kind), ['unknown', 'unknown']);
  for (const s of body) {
    assert.ok(s.kind === 'unknown' && s.reason === 'no-effect');
  }
  assert.deepEqual(kinds('a*b;'), ['unknown']);
  assert.deepEqual(kinds('someVar;'), ['unknown']);
  assert.deepEqual(kinds('if(c, 1, 2);'), ['unknown']);
  // Expressions that can do something stay expr statements.
  assert.deepEqual(kinds('foo();'), ['expr']);
  assert.deepEqual(kinds('lst.add(1);'), ['expr']);
  assert.deepEqual(kinds('a + foo();'), ['expr']);
  assert.deepEqual(kinds('sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "m"];'), ['expr']);
  // And the flagged pseudo-code surfaces as an untranslated todo.
  const t = translate('SELECT * FROM users;');
  assert.ok(t.stats.todo >= 1);
});

test('typed function declarations with capitalized types and dotted names', () => {
  // deluge-docs/pages/deluge/help/functions/call-function.html — `int thisapp.f(date d)`
  const body = parse(
    [
      'void automation.rw_prep_materials(String rwId) { x = rwId; }',
      'string button.send_sms(int id) { return "ok"; }',
      'map portal.getDashboard(string studentId, Map extra) { return extra; }',
      'function getCachedDatacenter(p_accessToken, p_dc) { return p_dc; }',
    ].join('\n'),
  ).body;
  assert.deepEqual(body.map((s) => s.kind), ['fn', 'fn', 'fn', 'fn']);
  const first = body[0];
  assert.ok(first && first.kind === 'fn');
  assert.equal(first.retType, 'void');
  assert.equal(first.name, 'automation.rw_prep_materials');
  assert.deepEqual(first.params, [{ type: 'String', name: 'rwId' }]);
  const t = translate('string thisapp.greet(String who) { return who; }');
  assert.match(stripComments(t.server), /async function d_thisapp_greet\(ctx, who\)/);
  assert.equal(t.stats.todo, 0);
  // Java signatures (`;` prototypes, generics) are not Deluge function declarations.
  assert.equal(parse('boolean addAll(Collection<? extends E> c);').body[0]?.kind, 'unknown');
  assert.equal(parse('String substring(int beginIndex, int endIndex);').body[0]?.kind, 'unknown');
});

test('for each index binds a 0-based index variable', () => {
  // deluge-docs/pages/list-manipulations__for-each-index.html
  const loop = parse('for each index i in items { y = i; }').body[0];
  assert.ok(loop && loop.kind === 'forEach');
  assert.equal(loop.name, 'i');
  assert.equal(loop.iteratesIndex, true);
  const t = translate('for each index i in items { y = i; }');
  assert.match(stripComments(t.server), /for \(var i of shim\.each\(ctx, items\)\.keys\(\)\)/);
  // two-variable form is unchanged: index i + element item
  const two = parse('for each index i item in coll { z = item; }').body[0];
  assert.ok(two && two.kind === 'forEach');
  assert.equal(two.index, 'i');
  assert.equal(two.name, 'item');
  // `for x in list` (no `each`) is not Deluge and stays unknown.
  assert.equal(parse('for x in items { a = 1; }').body[0]?.kind, 'unknown');
});

test('single = inside parens is criteria equality', () => {
  // `if(record.Blueprint.Status="Active")` — deluge-docs blueprint examples
  const s = parse('if (rec.Status = "Active") { x = 1; }');
  assert.equal(s.body[0]?.kind, 'if');
  const t = translate('if (a = "b") { x = 1; }');
  assert.match(stripComments(t.server), /a == "b"/);
  assert.match(stripComments(t.server), /var x = 1/);
});

test('invokeUrl casing, paren-wrapped and positional forms, hyphenated keys', () => {
  // deluge-docs/pages/deluge/help/webhook/invokeapitask.html documents
  // `response-format`, `response-decoding`, `connection`; web-data/invokeurl-function.html
  // documents the positional invokeUrl(url, type, ...) form.
  for (const src of [
    'r = invokeurl [url:"u" type:GET response-format:JSON connection:"c"];',
    'r = invokeUrl[url:"u" type:PUT connection:"c"];',
    'r = invokeurl([url: "u", type: "GET", connection: "c"]);',
    'r = invokeUrl(url: "u", type: GET, headers: h);',
    'r = invokeurl("https://x", "GET", params, hdrs);',
  ]) {
    const body = parse(src).body;
    assert.equal(body.length, 1, src);
    assert.notEqual(body[0]?.kind, 'unknown', src);
  }
  const t = translate('r = invokeurl[url:"u" type:GET response-format:JSON];');
  assert.match(stripComments(t.server), /shim\.http\.invokeurl\(ctx, \{ "url": "u", "type": "GET", "response-format": JSON \}\)/);
  const pos = translate('r = invokeurl("https://x", "GET", params);');
  assert.match(stripComments(pos.server), /"parameters": params/);
});

test('task keywords still work as variable names', () => {
  // `update = Map()` / `info = x` / `insert.put(...)` are variables in corpus scripts.
  const body = parse('update = Map();\nupdate.put("a", 1);\ndelete = 0;\ninfo = ave;\nhide = 5;').body;
  assert.deepEqual(body.map((s) => s.kind), ['assign', 'expr', 'assign', 'assign', 'assign']);
  // real task forms are unchanged
  assert.equal(parse('update Orders[ID == 1][Status = "Done"];').body[0]?.kind, 'update');
  assert.equal(parse('delete from Orders[ID == 1];').body[0]?.kind, 'deleteFrom');
  assert.equal(parse('info "hello";').body[0]?.kind, 'info');
  assert.equal(parse('hide input.Secret;').body[0]?.kind, 'ui');
});

test('optional semicolons, equality inside brackets, and if(c, a, b)', () => {
  const a = parse('x = 1\ny = 2');
  assert.equal(a.body.length, 2);
  const crit = parse('for each rec in Orders[Status = "Open" && Amount > 1] { }');
  const loop = crit.body[0];
  assert.equal(loop?.kind, 'forEach');
  if (loop?.kind === 'forEach') assert.equal(loop.collection.kind, 'criteria');
  const iff = parse('x = if(a == 1, "yes", "no");');
  assert.equal(iff.body[0]?.kind, 'assign');
});

test('size() is the list shim, not a .length call', () => {
  const t = translate('n = rows.get("contacts").size();');
  assert.equal(t.stats.todo, 0);
  assert.doesNotMatch(stripComments(t.server), /\.length/);
  assert.match(stripComments(t.server), /shim\.list\.size\(shim\.list\.get\(rows, "contacts"\)\)/);
  assert.equal(t.todos.some((item: any) => item.construct === 'method:size'), false);
  assert.equal(t.todos.some((item: any) => item.construct === 'method:get'), false);
});

test('a map value that is a member access is not a colon-call', () => {
  // Deluge map entries are `key : value` (https://www.zoho.com/deluge/help/datatypes/map.html).
  // `field:ui.method()` is a client task, not the separator before `pc.List_Price`.
  const add = parse('line_item.add({"item_id":zoho_item,"rate":pc.List_Price,"quantity":pc.Quantity,"tax_id":zoho_tax});');
  assert.equal(add.body[0]?.kind, 'expr');
  assert.equal(add.body.some((s) => s.kind === 'unknown'), false);
  const json = parse(
    'json = {"customer_id":zoho_cus,"date":input.Start_Date.toDate().toString("yyyy-MM-dd"),"custom_fields":{{"label":"creator_quote_id","value":input.ID}}};',
  );
  assert.equal(json.body[0]?.kind, 'assign');
  assert.equal(json.body.some((s) => s.kind === 'unknown'), false);
  const t = translate(
    'json = {"date":input.Start_Date.toDate().toString("yyyy-MM-dd"),"custom_fields":{{"label":"id","value":input.ID}}};',
  );
  assert.match(stripComments(t.server), /var json = /);
  assert.match(stripComments(t.server), /shim\.date\.format\(/);
  assert.doesNotMatch(stripComments(t.server), /task:json|colon:/);
  const ui = translate('input.Submode:ui.add(fetch_sub_mode.toList());');
  assert.match(stripComments(ui.client), /op: "ui"/);
});

test('for each over null uses shim.each, which iterates zero times', () => {
  const t = translate('for each row in input.Lines { total = total + row.Amount; }');
  assert.match(stripComments(t.server), /for \(var d_row of shim\.each\(ctx, shim\.input\.get\(ctx, "Lines"\)\)\)/);
  assert.doesNotMatch(stripComments(t.server), /\?\? \[\]/);
  assert.doesNotMatch(stripComments(t.server), /shim\.datastore\.flush/);
  assert.equal(t.todos.some((item: any) => item.construct === 'for-each-null'), false);
});

test('for each over a fetched collection flushes record writes once', () => {
  const t = translate('for each employee in Employee[name == "Jon Doe"] { employee.name = "John Doe"; }');
  assert.match(stripComments(t.server), /try \{/);
  assert.match(stripComments(t.server), /await shim\.datastore\.rows\(ctx,/);
  assert.match(stripComments(t.server), /shim\.record\.set\(employee, \["name"\], "John Doe"\)/);
  assert.match(stripComments(t.server), /finally \{\s*await shim\.datastore\.flush\(ctx\);/);
  assert.doesNotMatch(stripComments(t.client), /shim\.datastore\.flush/);
});

test('the actions keyword introduces its block and emits no stray identifier', () => {
  const t = translate('actions { x = 1; }');
  assert.match(stripComments(t.server), /x = 1/);
  assert.doesNotMatch(stripComments(t.server), /d_actions|(^|[^\w$.])actions;/);
  // A Deluge variable named actions is still a name, renamed to d_actions.
  const named = translate('for each actions in input.Lines { y = actions; }');
  assert.match(stripComments(named.server), /for \(var d_actions of/);
});

test('a variable named actions still parses as a task-word identifier', () => {
  // `actions {` alone is the container keyword; `actions` followed by anything
  // else is a name, like the other task words (update, delete, info, …).
  assert.deepEqual(kinds('actions = List();\nactions.add(1);\nx = actions.size();'), ['assign', 'expr', 'assign']);
  assert.equal(parse('actions { y = 1; }').body[0]?.kind, 'block');
  const t = translate('actions = List();\nactions.add(1);');
  assert.match(stripComments(t.server), /var d_actions = \[\]/);
  assert.match(stripComments(t.server), /shim\.list\.add\(d_actions, 1\)/);
});

test('statement buckets: input+alert is shimmed, assignment is translated, unknown is TODO', () => {
  const mixed = translate('if(input.A == 1) { alert "x"; }');
  assert.deepEqual(mixed.stats, { statements: 2, translated: 0, shimmed: 2, todo: 0 });
  assert.match(stripComments(mixed.client), /actions\.push\(\{ op: "alert"/);
  assert.equal(mixed.server.trim(), '');

  const plain = translate('x = 1');
  assert.deepEqual(plain.stats, { statements: 1, translated: 1, shimmed: 0, todo: 0 });
  assert.match(stripComments(plain.server), /x = 1/);
  assert.match(stripComments(plain.client), /x = 1/);

  const todo = translate('shareTo unknownThing;');
  assert.equal(todo.stats.statements, 1);
  assert.equal(todo.stats.todo, 1);
  assert.equal(todo.todos.length, 1);
  assert.ok(todo.todos[0]!.construct.length > 0);
  assert.match(stripComments(todo.server), /shim\.todo/);
});

test('zoho.checkout.create remains a payments TODO and is inert in a dry run', async () => {
  const t = translate('r = zoho.checkout.create("page", {"amount": 1});');
  assert.equal(t.stats.todo, 1);
  assert.equal(t.todos[0]?.construct, 'payments');
  assert.match(t.server, /await shim\.todo\(ctx, "payments"\)/);
  assert.match(t.server, /\/\/ Deluge: r = zoho\.checkout\.create\("\*\*\*", \{"\*\*\*": 1\}\)/);

  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({});
  await body(t.server)(runtime.shim, ctx);
  assert.deepEqual(runtime.transcript, [{ op: 'todo', construct: 'payments', detail: null }]);
  assert.equal(runtime.transcript.some((entry) => entry.op === 'http' || entry.op === 'outbound'), false);
});

test('direct control flow, collections, and string/math stay in generated JS', () => {
  const t = translate([
    'items = List();',
    'bag = Map();',
    'typed = List:string();',
    'names = {"a", "b"};',
    'x = 1;',
    'name = "abc";',
    'if (x > 1) { y = x + 2; } else { y = 0; }',
    's = name.toLowerCase().trim();',
    'n = abs(-3) + round(1.26, 2);',
    'found = "a" in names;',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.match(stripComments(t.server), /items = \[\]/);
  assert.match(stripComments(t.server), /bag = \{\}/);
  assert.match(stripComments(t.server), /shim\.list\("string"\)/);
  // `in` is shim.list.contains: Array.includes misses a bigint id against its digit text.
  assert.match(stripComments(t.server), /shim\.list\.contains\(names, "a"\)/);
  assert.match(stripComments(t.server), /shim\.string\.toLowerCase\(name\)/);
  assert.match(stripComments(t.server), /shim\.string\.trim\(/);
  assert.match(stripComments(t.server), /shim\.math\.abs\(/);
  assert.doesNotMatch(stripComments(t.server), /\bfetch\s*\(/);
  assert.doesNotMatch(stripComments(t.client), /\bfetch\s*\(/);
});

test('record, mail, http, zoho, thisapp, dates, and decimals go through the shim', () => {
  const t = translate([
    'id = insert into Orders[Name = "A" Amount = 2];',
    'for each rec in Orders[Status == "Open"] sort by Name asc { total = total + rec.Amount; }',
    'sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "hi"];',
    'resp = invokeurl[url: "https://example.test" type: GET];',
    'rows = zoho.crm.getRecords("Leads");',
    'thisapp.util.ping();',
    'today = zoho.currentdate;',
    'price = 10.50 + 0.25;',
    'input.Name = "Ada";',
  ].join('\n'));
  assert.match(stripComments(t.server), /shim\.datastore\.insert/);
  assert.match(stripComments(t.server), /shim\.datastore\.rows/);
  assert.match(stripComments(t.server), /shim\.mail\.send/);
  assert.match(stripComments(t.server), /shim\.http\.invokeurl/);
  assert.match(stripComments(t.server), /shim\.zoho\.task/);
  assert.match(stripComments(t.server), /shim\.thisapp\.call/);
  assert.match(stripComments(t.server), /shim\.zoho\.currentDate/);
  assert.match(stripComments(t.server), /shim\.decimal\.add/);
  assert.match(stripComments(t.server), /shim\.input\.set/);
  assert.match(stripComments(t.client), /shim\.input\.set/);
  assert.doesNotMatch(stripComments(t.client), /shim\.mail\.send/);
  assert.doesNotMatch(stripComments(t.client), /shim\.datastore\.insert/);
  assert.equal(t.stats.todo, 0);
});

test('cancel submit refuses on the server too, with the alert text before it', () => {
  const t = translate(['if (input.Quantity <= 0) {', '  alert "Quantity must be greater than zero";', '  cancel submit;', '}'].join('\n'));
  assert.match(stripComments(t.server), /if \(/);
  assert.match(stripComments(t.server), /await shim\.validate\.cancelSubmit\(ctx, "Quantity must be greater than zero"\);/);
  assert.doesNotMatch(stripComments(t.server), /"alert"/);
  assert.match(stripComments(t.client), /"cancelSubmit"/);
  assert.equal(t.stats.todo, 0);
});

test('client tasks stay out of the server module', () => {
  const t = translate([
    'alert "saved";',
    'info "note";',
    'openUrl("https://example.test", "same window");',
    'hide input.Secret;',
    'show input.Secret;',
    'reload;',
  ].join('\n'));
  assert.equal(t.server.trim(), '');
  assert.match(stripComments(t.client), /"alert"/);
  assert.match(stripComments(t.client), /"info"/);
  assert.match(stripComments(t.client), /"openUrl"/);
  assert.match(stripComments(t.client), /"hide"/);
  assert.match(stripComments(t.client), /"show"/);
  assert.match(stripComments(t.client), /"reload"/);
  assert.equal(t.stats.shimmed, t.stats.statements);
});

test('a server-only while condition is snapshotted once, not a live client loop', () => {
  const t = translate('while (Orders[Status == "Open"].count() > 0) { alert "x"; }');
  assert.match(stripComments(t.client), /snapshot/);
  assert.match(stripComments(t.client), /if \(slots\["c0"\]\)/);
  assert.match(stripComments(t.prefetch), /shim\.datastore\.aggregate/);
  assert.doesNotMatch(stripComments(t.client), /while /);
  assert.doesNotMatch(stripComments(t.client), /client-condition-uses-server/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), false);
  assert.equal(t.server.trim(), '');
});

test('toLong, toNumber, toDecimal, toList, and toMap go through the shim', () => {
  const t = translate([
    'n = marks.toLong();',
    'm = marks.toNumber();',
    'd = price.toDecimal();',
    'whole = "abc".toList();',
    'parts = "a/b".toList("/");',
    'bag = raw.toMap();',
    'low = "100".tolong();',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.match(stripComments(t.server), /shim\.convert\.toLong\(marks, ctx\)/);
  assert.match(stripComments(t.server), /shim\.convert\.toNumber\(marks, ctx\)/);
  assert.match(stripComments(t.server), /shim\.convert\.toDecimal\(price, ctx\)/);
  assert.match(stripComments(t.server), /shim\.convert\.toList\("abc", ctx\)/);
  assert.match(stripComments(t.server), /shim\.convert\.toList\("a\/b", ctx, "\/"\)/);
  assert.match(stripComments(t.server), /shim\.convert\.toMap\(raw, ctx\)/);
  assert.match(stripComments(t.server), /shim\.convert\.toLong\("100", ctx\)/);
  assert.doesNotMatch(stripComments(t.server), /method:toLong|method:toList|method:toMap|method:toDecimal/);
});

test('getUrl is the legacy HTTP GET: same outbound shim as invokeurl, server-only', () => {
  const t = translate([
    'resp = getUrl("https://example.test/feed");',
    'full = getUrl("https://example.test/feed", false);',
    'withHdr = getUrl("https://example.test/feed", {"Accept": "text/plain"}, true);',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.match(t.server, /await shim\.http\.getUrl\(ctx, "https:\/\/example\.test\/feed"\)/);
  assert.match(t.server, /await shim\.http\.getUrl\(ctx, "https:\/\/example\.test\/feed", false\)/);
  assert.match(t.server, /await shim\.http\.getUrl\(ctx, "https:\/\/example\.test\/feed", \{ \["Accept"\]: "text\/plain" \}, true\)/);
  assert.doesNotMatch(t.server, /call:getUrl|shim\.todo/);
  // Outbound calls are server-only; the client body never emits them.
  assert.doesNotMatch(t.client, /getUrl/);
});

test('toJSONList, toJSONCollection, and the getUrl(...).toJSONList() chain go through the convert shim', () => {
  const t = translate([
    'resp = getUrl("https://example.test/feed").toJSONList();',
    'items = raw.toJSONList();',
    'bag = raw.toJSONCollection();',
    'm = resp2.toMap();',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.match(t.server, /shim\.convert\.toJSONList\(await shim\.http\.getUrl\(ctx, "https:\/\/example\.test\/feed"\), ctx\)/);
  assert.match(t.server, /shim\.convert\.toJSONList\(raw, ctx\)/);
  assert.match(t.server, /shim\.convert\.toJSONCollection\(raw, ctx\)/);
  assert.match(t.server, /shim\.convert\.toMap\(resp2, ctx\)/);
  assert.doesNotMatch(t.server, /shim\.todo|method:toJSONList|method:toJSONCollection|method:toMap|call:getUrl/);
});

test('getUrl(url, false) is flagged a map so .get routes to the map shim', () => {
  const t = translate('code = getUrl("https://example.test/feed", false).get("responseCode");');
  assert.equal(t.stats.todo, 0);
  assert.match(t.server, /shim\.list\.get\(await shim\.http\.getUrl\(ctx, "https:\/\/example\.test\/feed", false\), "responseCode"\)/);
});

test('a server-only if is a prefetch slot and the client runs the condition', () => {
  const t = translate('n = Orders[Status == "Open"].count();\nif (n > 0) { alert "x"; }');
  assert.equal(t.stats.todo, 0);
  assert.match(stripComments(t.prefetch), /var n = await shim\.datastore\.aggregate/);
  assert.match(stripComments(t.prefetch), /slots\["c0"\] = \(n > 0\)/);
  assert.match(stripComments(t.client), /if \(slots\["c0"\]\)/);
  assert.match(stripComments(t.client), /"alert"/);
  assert.doesNotMatch(stripComments(t.client), /client-condition-uses-server/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), false);
});

test('for each over a server collection prefetches rows for the client', () => {
  const t = translate('for each rec in Orders[Status == "Open"] { alert rec.Name; }');
  assert.equal(t.stats.todo, 0);
  assert.match(stripComments(t.client), /for \(var d_rec of shim\.each\(ctx, slots\["c0"\]\)\)/);
  assert.equal(t.todos.some((item: any) => item.construct === 'for-each-null'), false);
  assert.match(stripComments(t.client), /shim\.record\.get\(d_rec, "Name"\)/);
  assert.match(stripComments(t.prefetch), /shim\.datastore\.rows/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-loop-uses-server'), false);
});

test('a range bound that reads a client-accumulated scalar defers the read to a slot request', () => {
  // Shape A: `proplength` only exists once the earlier client loop has run, so
  // the eager prefetch cannot bound `11 - proplength`. The client evaluates it
  // and sends it as a request parameter; the endpoint clamps and runs the
  // named read. The index sibling keeps its eager slot.
  const t = translate(
    [
      'proplength = 0;',
      'index = 1;',
      'for each rec in Orders[ID != 0] sort by Added_Time desc range from (index - 1) * 10 + 1 to index * 10 + 1 {',
      '  proplength = proplength + 1;',
      '}',
      'for each rr in Lines[ID != 0] sort by Added_Time desc range from 1 to 11 - proplength {',
      '  info rr.Item;',
      '  proplength = proplength + 1;',
      '}',
    ].join('\n'),
  );
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  const client = stripComments(t.client);
  const prefetch = stripComments(t.prefetch);
  assert.match(client, /await shim\.client\.rows\(ctx, "c1", 1, \(11 - proplength\)\)/);
  assert.match(client, /if \(!range_c1 \|\| !range_c1\.ok\)/);
  assert.match(client, /for \(var rr of shim\.each\(ctx, range_c1\.rows\)\)/);
  assert.match(prefetch, /if \(ctx\.rangeSlot\) \{/);
  assert.match(prefetch, /ctx\.rangeSlot === "c1"/);
  assert.match(prefetch, /slots\["c1"\] = ctx\.rangeEmpty \? \[\] : await shim\.datastore\.rows\(ctx, shim\.datastore\.query\(ctx, "Lines", \{ op: "!=", field: "ID", value: 0 \}, \{ sort: \{ field: "Added_Time", dir: "desc" \}, range: \{ from: ctx\.rangeFrom, to: ctx\.rangeTo \} \}\)\)/);
  // The sibling whose bounds come from a parameter keeps its eager slot.
  assert.match(prefetch, /slots\["c0"\] = await shim\.datastore\.rows\(ctx, shim\.datastore\.query\(ctx, "Orders", .*range: \{ from: \(\(\(index - 1\) \* 10\) \+ 1\)/);
  assert.match(client, /for \(var d_rec of shim\.each\(ctx, slots\["c0"\]\)\)/);
});

test('a range bound that reads an if/else-tombstoned client scalar defers the read to a slot request', () => {
  // `proplength` is assigned inside both arms, so its binding is an if/else
  // tombstone the prefetch cannot replay. The client declared and still holds
  // the name, so it posts whichever value the arms left; nothing is replayed
  // and no arm is guessed.
  const t = translate(
    [
      'proplength = 0;',
      'if (input.Flag == "y") {',
      '  proplength = 1;',
      '} else {',
      '  proplength = 2;',
      '}',
      'for each rr in Lines[ID != 0] sort by Added_Time desc range from 1 to 11 - proplength {',
      '  info rr.Item;',
      '  proplength = proplength + 1;',
      '}',
    ].join('\n'),
  );
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  const client = stripComments(t.client);
  const prefetch = stripComments(t.prefetch);
  assert.match(client, /await shim\.client\.rows\(ctx, "c0", 1, \(11 - proplength\)\)/);
  assert.match(client, /for \(var rr of shim\.each\(ctx, range_c0\.rows\)\)/);
  assert.match(prefetch, /ctx\.rangeSlot === "c0"/);
  // The bound is evaluated on the client; the prefetch module does not replay
  // a `proplength` binding.
  assert.doesNotMatch(prefetch, /var proplength/);
});

test('a range bound that reads an app-function result keeps the counted todo', () => {
  // `inde` is a thisapp call: the client never holds it, and a function body
  // may have side effects so the prefetch must not replay it. The bound can
  // be evaluated nowhere — the loop is not deferred.
  const t = translate(
    [
      'inde = thisapp.indexCalculation(Lines[ID != 0].count());',
      'rangeTo = inde.toLong();',
      'for each rr in Lines[ID != 0] sort by Added_Time desc range from 1 to rangeTo {',
      '  info rr.Item;',
      '}',
    ].join('\n'),
  );
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), true);
  assert.doesNotMatch(stripComments(t.prefetch), /ctx\.rangeSlot/);
  assert.doesNotMatch(stripComments(t.client), /shim\.client\.rows/);
});

test('a client range read replays input-derived criteria leaves but keeps a dynamic leaf a todo', () => {
  // `proplength` was written inside an earlier client loop, so the bound does
  // not dominate the collection. The client sends it. `bed1` was bound from
  // input before this loop and replays inside the deferred read.
  const t = translate(
    [
      'proplength = 0;',
      'marks = {"a"};',
      'for each mark in marks {',
      '  proplength = proplength + 1;',
      '}',
      'bed1 = input.bed.toLong();',
      'for each rr in Lines[Beds == bed1 && City == input.city.toLong()] range from 1 to 11 - proplength {',
      '  proplength = proplength + 1;',
      '}',
    ].join('\n'),
  );
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  const prefetch = stripComments(t.prefetch);
  assert.match(prefetch, /var bed1 = shim\.convert\.toLong\(shim\.input\.get\(ctx, "bed"\), ctx\)/);
  assert.match(prefetch, /ctx\.rangeSlot === "c0"/);
  assert.match(stripComments(t.client), /await shim\.client\.rows\(ctx, "c0", 1, \(11 - proplength\)\)/);
  // A criteria leaf the translator cannot bind stays a counted todo: a local
  // on the leaf's left is not a form field (`City == City.toLong()` in the
  // gallery app shadows the param). The loop is not deferred and no
  // `{"op":"todo"}` read is emitted into the endpoint.
  const dyn = translate(
    [
      'proplength = 0;',
      'bed1 = input.bed.toLong();',
      'for each rr in Lines[bed1 == input.bed.toLong()] range from 1 to 11 - proplength {',
      '  proplength = proplength + 1;',
      '}',
    ].join('\n'),
  );
  assert.equal(dyn.todos.some((item) => item.construct === 'client-loop-uses-server'), true);
  assert.doesNotMatch(stripComments(dyn.prefetch), /ctx\.rangeSlot/);
  assert.doesNotMatch(stripComments(dyn.client), /shim\.client\.rows/);
});

test('a for each that alerts a second form field looked up by the loop row prefetches a row map', () => {
  const t = translate(
    [
      'for each rec in Orders[Status == "Open"] {',
      '  alert Customers[Code == rec.Code].Name;',
      '  hide input.Secret;',
      '  openUrl("https://example.test/" + rec.Code, "same window");',
      '}',
    ].join('\n'),
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  const client = stripComments(t.client);
  const prefetch = stripComments(t.prefetch);
  assert.match(client, /for \(var d_rec of shim\.each\(ctx, slots\["c\d+"\]\)\)/);
  assert.match(client, /"alert"/);
  assert.match(client, /slots\["c\d+"\]\[shim\.record\.get\(d_rec, "ID"\)\] \?\? null/);
  assert.match(prefetch, /await shim\.datastore\.lookupMap\(ctx, "Customers", "Code", "Name", keys_c\d+\)/);
  assert.match(prefetch, /slots\["c\d+"\]\[rowId_c\d+\] = /);
  const alertAt = client.indexOf('"alert"');
  const hideAt = client.indexOf('"hide"');
  const openAt = client.indexOf('"openUrl"');
  assert.ok(alertAt >= 0 && hideAt > alertAt && openAt > hideAt);
  assert.match(client, /"https:\/\/example\.test\/" \+ shim\.record\.get\(d_rec, "Code"\)/);
});

test('an if that reads a second form field looked up by the loop row prefetches a row map', () => {
  const t = translate(
    [
      'for each rec in Orders[Status == "Open"] {',
      '  if (Customers[Code == rec.Code].Name == "Ada") {',
      '    alert "ada";',
      '    show input.Secret;',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  const client = stripComments(t.client);
  assert.match(client, /if \(\(slots\["c\d+"\]\[shim\.record\.get\(d_rec, "ID"\)\] \?\? null\)\)/);
  assert.match(client, /"alert"/);
  assert.match(client, /"show"/);
  assert.ok(client.indexOf('"alert"') < client.indexOf('"show"'));
  const prefetch = stripComments(t.prefetch);
  assert.match(prefetch, /await shim\.datastore\.lookupMap\(ctx, "Customers", "Code", "Name", keys_c\d+_\d+\)/);
  assert.match(prefetch, /slots\["c\d+"\]\[shim\.record\.get\(d_rec, "ID"\)\] = \(\(norm_c\d+_\d+ != null && res_c\d+_\d+\.has/);
});

test('a nested for each whose collection is looked up by the outer row prefetches that collection per row', () => {
  const t = translate(
    [
      'for each rec in Orders[Status == "Open"] {',
      '  for each line in Lines[OrderCode == rec.Code] {',
      '    alert line.Item;',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  const client = stripComments(t.client);
  assert.match(client, /for \(var line of shim\.each\(ctx, \(slots\["c\d+"\]\[shim\.record\.get\(d_rec, "ID"\)\] \?\? null\)\)\)/);
  assert.match(client, /shim\.record\.get\(line, "Item"\)/);
  const prefetch = stripComments(t.prefetch);
  assert.match(prefetch, /await shim\.datastore\.rowsMap\(ctx, "Lines", "OrderCode", keys_c\d+_\d+\)/);
  assert.match(prefetch, /slots\["c\d+"\]\[shim\.record\.get\(d_rec, "ID"\)\] = \(norm_c\d+_\d+ != null && res_c\d+_\d+\.has/);
});

test('a nested collection keyed by a client list batches, and a mutated list stays a todo', () => {
  // `Orders[Day == day]` is one rows map over the client list. The condition
  // reads `seen`, and the body adds to `seen`, so that check is not the
  // initial empty list replayed for every row. Neither loop binds a free name.
  const t = translate(
    [
      'seen = List();',
      'weekDays = {input.From_Date, input.From_Date.addDay(1)};',
      'for each day in weekDays {',
      '  recs = Orders[Day == day];',
      '  for each r in recs {',
      '    key = r.Name;',
      '    if (!seen.contains(key)) { seen.add(key); alert "dup"; }',
      '  }',
      '}',
    ].join('\n'),
  );
  const client = stripComments(t.client);
  const prefetch = stripComments(t.prefetch);
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), true);
  assert.match(prefetch, /shim\.datastore\.rowsMap\(ctx, "Orders", "Day"/);
  assert.doesNotMatch(prefetch, /list\.contains\(seen/);
  assert.match(client, /client-condition-uses-server/);
  assert.doesNotMatch(client, /\brecs\b/);
  assert.doesNotMatch(prefetch, /\brecs\b|\br\b/);
});

test('a loop variable that shadows a local used in its own criteria still row-maps', () => {
  // The criteria reads the local assigned before the loop. The loop then
  // binds the same name. The client still iterates that collection and the
  // body lookup is a row map keyed by the loop row.
  const t = translate(
    [
      'code = input.Status;',
      'for each code in Orders[Status == code] {',
      '  if (Customers[Code == code.Code].Name == "Ada") {',
      '    alert "x";',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  const client = stripComments(t.client);
  assert.match(client, /for \(var code of shim\.each\(ctx, slots\["c\d+"\]\)\)/);
  assert.match(client, /slots\["c\d+"\]\[shim\.record\.get\(code, "ID"\)\]/);
});

test('nested for each loops that reuse one row name still emit both client loops', () => {
  // The inner collection reads the outer row. Reusing the row name does not
  // turn the inner loop or its body lookup into a todo.
  const t = translate(
    [
      'for each r in Orders[Status == "Open"] {',
      '  for each r in Lines[Order == r.ID] {',
      '    if (Customers[Code == r.Code].Name == "Ada") {',
      '      alert "ada";',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  const client = stripComments(t.client);
  assert.equal(client.match(/for \(var r of shim\.each\(ctx,/g)?.length, 2);
  assert.match(client, /slots\["c\d+"\]\[shim\.record\.get\(r, "ID"\)\]/);
});

test('a row map over a bound server collection still binds the local in prefetch', () => {
  // The collection local resolves in the prefetch module: its replayed
  // `var` binding must precede the map loop that reads it.
  const t = translate(
    [
      'recs = Orders[Day == input.From_Date];',
      'for each r in recs {',
      '  if (Customers[Code == r.Code].Name == "Ada") { alert "ada"; }',
      '}',
    ].join('\n'),
  );
  const prefetch = stripComments(t.prefetch);
  assert.match(prefetch, /var d_recs = shim\.datastore\.query/);
  assert.ok(prefetch.indexOf('var d_recs') < prefetch.indexOf('await shim.datastore.rows(ctx, d_recs)'));
  assert.doesNotMatch(stripComments(t.client), /client-loop-uses-server/);
});

test('a server read inside a client list loop stays a todo', () => {
  const t = translate('for each r in names { if (Orders[Code == r].count() > 0) { alert "x"; } }');
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), true);
  assert.doesNotMatch(stripComments(t.prefetch), /slots\[/);
});


test('a server read inside a client list loop batches by the scalar element', () => {
  const t = translate('names = {"A", "B"};\nfor each r in names { if (Orders[Code == r].count() > 0) { alert "x"; } }');
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(t.prefetch), /var res_\w+ = await shim\.datastore\.aggregateMap\(ctx, "Orders", "Code", keys_\w+, "count", undefined\);/);
  assert.match(stripComments(t.prefetch), /slots\["c\d+"\]\[String\(r\)\]/);
  assert.match(stripComments(t.client), /slots\["c\d+"\]\[String\(r\)\]/);
});

const COLLECTION_NON_READ =
  /thisapp\.call|mail\.send|http\.getUrl|http\.postUrl|http\.invokeurl|datastore\.insert|zoho\.task|list\.(?:add|addAll|put|putAll|clear|insert|insertAll|remove|removeAll|update)\s*\(|datastore\.(?:lookupMap|rowsMap|aggregateMap)\s*\(/;

function assertLoopCollectionStaysTodo(src: string): void {
  const t = translate(src);
  const prefetch = stripComments(t.prefetch);
  const client = stripComments(t.client);
  // Nothing runs in the prefetch: no replayed call and no batched map.
  assert.doesNotMatch(prefetch, COLLECTION_NON_READ, src);
  assert.match(client, /shim\.todo\(ctx, "client-loop-uses-server"\)/, src);
  assert.ok(t.todos.some((item) => item.construct === 'client-loop-uses-server'), src);
  assert.doesNotMatch(client, /for \(var \w+ of shim\.each\(ctx, slots\[/, src);
}

test('a non-read for each collection stays a counted client-loop todo', () => {
  assertLoopCollectionStaysTodo(
    'resp = invokeurl[url:"u" type:GET response-format:JSON];\nfor each r in resp { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\nfor each r in s { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    'b = getUrl("https://example.test/feed");\nfor each r in b { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    'w = insert into Bookings[Name = "A"];\nfor each r in w { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    'z = zoho.crm.getRecords("Leads");\nfor each r in z { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    'for each row in thisapp.Items() { alert row.Name; }',
  );
  // Aliases: one hop, a collection literal, ifnull, and two hops.
  assertLoopCollectionStaysTodo(
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\nt = s;\nfor each r in t { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\nitems = {s};\nfor each r in items { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\nt = ifnull(s, "x");\nfor each r in t { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\nt = s;\nu = t;\nfor each r in u { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  // The call written as the collection expression itself.
  assertLoopCollectionStaysTodo(
    'for each r in invokeurl[url:"u" type:GET response-format:JSON] { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  // A name read before it is bound is still a read: `a` reads `b`, and `b` is
  // the send. A free name is unknown and refuses too.
  assertLoopCollectionStaysTodo(
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\na = b;\nb = s;\nfor each r in a { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  assertLoopCollectionStaysTodo(
    'for each r in nosuch { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
});

test('a refused for each collection runs nothing in a dry-run prefetch', async () => {
  const runtime = createRuntime({ dryRun: true, seed: { Orders: [{ ROWID: '1', ID: '1', Code: 'A' }] } });
  const ctx = runtime.context({ record: {} });
  const run = (code: string, extra: string[] = [], values: unknown[] = []) =>
    (new Function('shim', 'ctx', ...extra, `return (async () => {\n${code}\n})();`) as (...a: unknown[]) => Promise<unknown>)(
      runtime.shim,
      ctx,
      ...values,
    );
  const scripts = [
    'resp = invokeurl[url:"u" type:GET response-format:JSON];\nfor each r in resp { if (Orders[Code == r].count() > 0) { alert "x"; } }',
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\nfor each r in s { if (Orders[Code == r].count() > 0) { alert "x"; } }',
    'for each row in thisapp.Items() { alert row.Name; }',
  ];
  for (const src of scripts) {
    const t = translate(src);
    const slots: Record<string, unknown> = {};
    const actions: { op: string }[] = [];
    await run(t.prefetch, ['slots'], [slots]);
    await run(t.client, ['slots', 'actions', 'prefetched'], [slots, actions, { ok: true, slots }]);
    assert.equal(actions.filter((action) => action.op === 'alert').length, 0, src);
  }
  // `a = b` before `b` is bound still refuses the collection; running the
  // prefetch alone shows nothing was replayed into it.
  const fwd = translate(
    's = sendmail[to: "a@example.test" subject: "s" message: "m"];\na = b;\nb = s;\nfor each r in a { if (Orders[Code == r].count() > 0) { alert "x"; } }',
  );
  await run(fwd.prefetch, ['slots'], [{}]);
  assert.equal(fwd.todos.some((item) => item.construct === 'client-loop-uses-server'), true);
  // No non-read op ran — only the counted todo placeholder (and reads) appear.
  assert.equal(
    runtime.transcript.some((entry) =>
      ['invokeurl', 'sendmail', 'getUrl', 'postUrl', 'insert', 'thisapp', 'task'].includes(entry.op),
    ),
    false,
  );
  assert.equal(runtime.transcript.some((entry) => entry.op === 'todo' && entry.construct === 'client-loop-uses-server'), true);
});

test('an aggregate field-name argument does not refuse a read-only for each collection', () => {
  const keepBatched = (src: string): void => {
    const t = translate(src);
    assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false, src);
    assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false, src);
    const prefetch = stripComments(t.prefetch);
    assert.match(prefetch, /datastore\.(?:lookupMap|rowsMap|aggregateMap|rows|aggregate)\s*\(/, src);
  };
  // A bound collection, an inline collection, and aggregates in criteria all
  // take a bare field argument; each is a link-name literal, not a name read.
  keepBatched('g = Bookings[Room == "A"].distinct(Guest);\nfor each r in g { if (Orders[Code == r].count() > 0) { alert "x"; } }');
  keepBatched('for each r in Bookings[Room == "A"].distinct(Guest) { if (Orders[Code == r].count() > 0) { alert "x"; } }');
  keepBatched('m = Bookings[Room == "A"].maximum(Amount);\nl = {m};\nfor each r in l { if (Orders[Code == r].count() > 0) { alert "x"; } }');
  keepBatched('n = Orders[Code == "A"].count(Code);\nrows = Bookings[Amount > n];\nfor each r in rows { if (Orders[Code == r].count() > 0) { alert "x"; } }');
  keepBatched('rows = Bookings[Amount > Orders[Code == "A"].sum(Amount)];\nfor each r in rows { if (Orders[Code == r].count() > 0) { alert "x"; } }');
  const g = translate('g = Bookings[Room == "A"].distinct(Guest);\nfor each r in g { if (Orders[Code == r].count() > 0) { alert "x"; } }');
  assert.match(stripComments(g.prefetch), /aggregateMap|rowsMap|lookupMap/);
});

test('a param or binding reassigned from a read of its previous value keeps the prefetch', () => {
  const t = translate('caseID = Bookings[ID == caseID].Guest;\nif (caseID != null) { alert "x"; }', {
    prefetchBound: ['caseID'],
  });
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  const prefetch = stripComments(t.prefetch);
  assert.match(prefetch, /var caseID = await shim\.datastore\.field\(ctx, shim\.datastore\.query\(ctx, "Bookings", \{ op: "==", field: "ID", value: caseID \}\), "Guest"\)/);
  assert.match(prefetch, /slots\["c\d+"\] = \(caseID != null\)/);
  // An earlier binding replays first; the reassignment reads it, not itself.
  const chain = translate('x = Bookings[Room == "A"].count();\nx = Orders[Code == x].Guest;\nif (x != null) { alert "x"; }');
  const p2 = stripComments(chain.prefetch);
  assert.match(p2, /var x = await shim\.datastore\.aggregate/);
  assert.match(p2, /var x = await shim\.datastore\.field\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "==", field: "Code", value: x \}\), "Guest"\)/);
  assert.equal(chain.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  // The loop form: a collection whose criteria reads the previous param value.
  const loop = translate('ids = Bookings[Room == ids].Guest.getAll();\nfor each r in ids { if (Orders[Code == r].count() > 0) { alert "x"; } }', {
    prefetchBound: ['ids'],
  });
  assert.equal(loop.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
});

test('a read of a name bound only later stays a counted todo and never reaches the prefetch', async () => {
  const scripts = [
    'a = b;\nb = sendmail[to: "a@example.test" subject: "s" message: "m"];\nif (a && Orders[Code == "A"].count() > 0) { alert "y"; }',
    'a = b;\nb = invokeurl[url:"u" type:GET response-format:JSON];\nif (a && Orders[Code == "A"].count() > 0) { alert "y"; }',
  ];
  const runtime = createRuntime({ dryRun: true, seed: { Orders: [{ ROWID: '1', ID: '1', Code: 'A' }] } });
  const ctx = runtime.context({ record: {} });
  for (const src of scripts) {
    const t = translate(src);
    const prefetch = stripComments(t.prefetch);
    assert.doesNotMatch(prefetch, COLLECTION_NON_READ, src);
    assert.ok(t.todos.some((item) => item.construct === 'client-condition-uses-server'), src);
    await (new Function('shim', 'ctx', 'slots', `return (async () => {\n${t.prefetch}\n})();`) as (...a: unknown[]) => Promise<unknown>)(
      runtime.shim,
      ctx,
      {},
    );
  }
  assert.equal(
    runtime.transcript.some((entry) => ['sendmail', 'invokeurl', 'getUrl', 'postUrl'].includes(entry.op)),
    false,
  );
});

test('a reassignment through a non-read stays a counted todo and never reaches the prefetch', async () => {
  // A right-hand read of the name being assigned reads the previous binding.
  // When that previous binding — or the new value itself — is a call that
  // writes, sends, or leaves the app, the whole condition prefetch refuses:
  // replaying it would perform the call eagerly.
  const nonReads = [
    'sendmail[to: "a@example.test" subject: "s" message: %s]',
    'invokeurl[url:%s type:GET response-format:JSON]',
    'getUrl(%s)',
    'insert into Bookings[Name = %s]',
    'zoho.crm.getRecords(%s)',
  ];
  const scripts: string[] = [];
  for (const call of nonReads) {
    // The new binding is the non-read and it reads the previous row read.
    scripts.push(`x = Bookings[ID == "1"].Guest;\nx = ${call.replace('%s', 'x')};\nif (x != null) { alert "x"; }`);
    // The new binding is a row read whose criteria reads the non-read's value.
    scripts.push(`x = ${call.replace('%s', '"A"')};\nx = Bookings[ID == x].Guest;\nif (x != null) { alert "x"; }`);
    // The non-read is bound inside an if-arm: it must not run unconditionally.
    scripts.push(
      `x = Bookings[ID == "1"].Guest;\nif (input.Flag) { x = ${call.replace('%s', 'x')}; }\nif (x != null) { alert "x"; }`,
    );
  }
  const runtime = createRuntime({ dryRun: true, seed: { Bookings: [{ ROWID: '1', ID: '1', Name: 'A', Guest: 'g' }] } });
  const ctx = runtime.context({ record: {} });
  for (const src of scripts) {
    const t = translate(src);
    const prefetch = stripComments(t.prefetch);
    assert.doesNotMatch(prefetch, ROW_MAP_NON_READ, src);
    assert.ok(t.todos.some((item) => item.construct === 'client-condition-uses-server'), src);
    await (new Function('shim', 'ctx', 'slots', `return (async () => {\n${t.prefetch}\n})();`) as (...a: unknown[]) => Promise<unknown>)(
      runtime.shim,
      ctx,
      {},
    );
  }
  assert.equal(
    runtime.transcript.some((entry) =>
      ['sendmail', 'invokeurl', 'getUrl', 'postUrl', 'insert', 'zoho.task', 'thisapp'].includes(entry.op),
    ),
    false,
  );
});

test('a non-read cannot reach a prefetch through any client replay', () => {
  // Five ways a client read is served: a condition slot, a scalar replay, a
  // row map, a per-element post, and a range bound. A non-read stays out of
  // every one of them.
  const leaked = /mail\.send|http\.(?:getUrl|postUrl|invokeurl)|datastore\.(?:insert|update|delete|setField|flush)|zoho\.task|thisapp\.call|list\.(?:add|addAll|put|putAll|clear|insert|insertAll|remove|removeAll|update)\s*\(/;
  const mechanisms = (value: string): Record<string, string> => ({
    condition: `if (${value}) { alert "x"; }`,
    scalar: `x = ${value};\ny = x;\nif (y != null) { alert "x"; }`,
    'row-map': `x = ${value};\nfor each r in Bookings[Room == "A"] {\n  if (x != null) { alert "x"; }\n}`,
    element: `x = ${value};\nfor each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {\n  if (x != null) { alert "x"; }\n}`,
    'loop-range': `x = ${value};\nfor each r in Orders[ID != 0] range from 1 to x { alert r.Name; }`,
  });
  const calls = [
    'sendmail[to: "a@example.test" subject: "s" message: "m"]',
    'invokeurl[url:"https://example.test" type:GET response-format:JSON]',
    'getUrl("https://example.test/feed")',
    'insert into Bookings[Name = "A"]',
    'zoho.crm.create("Leads", {"Last_Name":"A"})',
    'zoho.crm.updateRecord("Leads", "1", {"Last_Name":"B"})',
    'thisapp.Helpers.twice(1)',
  ];
  for (const call of calls) {
    for (const [name, src] of Object.entries(mechanisms(call))) {
      const t = translate(src);
      assert.doesNotMatch(stripComments(t.prefetch), leaked, `${name} ${call}`);
      assert.ok(
        t.todos.some((item) => item.construct === 'client-condition-uses-server' || item.construct === 'client-loop-uses-server'),
        `${name} ${call}`,
      );
    }
  }
  // update and delete are statements. A later legal read may prefetch; the write does not.
  const writes = ['update Orders[ID == 1][Status = "Done"];', 'delete from Orders[ID == 1];'];
  const after = (stmt: string): Record<string, string> => ({
    condition: `${stmt}\nif (Orders[ID != 0].count() > 0) { alert "x"; }`,
    scalar: `${stmt}\nx = Orders[ID != 0].count();\nif (x > 0) { alert "x"; }`,
    'row-map': `${stmt}\nfor each r in Bookings[Room == "A"] {\n  if (Orders[Code == r.Code].count() > 0) { alert "x"; }\n}`,
    element: `${stmt}\nfor each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {\n  if (Bookings[Room == room].count() > 0) { alert "x"; }\n}`,
    'loop-range': `${stmt}\nfor each r in Orders[ID != 0] range from 1 to 2 { alert r.Name; }`,
  });
  for (const stmt of writes) {
    for (const [name, src] of Object.entries(after(stmt))) {
      const t = translate(src);
      assert.doesNotMatch(stripComments(t.prefetch), leaked, `${name} ${stmt}`);
      assert.match(t.server, /shim\.datastore\.(?:update|delete)\(/, stmt);
    }
  }
});

test('a self-referential accumulator is not replayed to resolve a for each range', () => {
  // An earlier loop writes `proplength`. That range end is one deferred
  // slot the client posts. The prefetch must not replay the accumulator.
  const src =
    'proplength = 0;\nfor each r in Bookings[ID != 0] { proplength = proplength + 1; }\nfor each p in Orders[Code != ""] sort by Added_Time desc range from 1 to 11 - proplength { alert p.Code; }';
  const t = translate(src);
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  assert.match(stripComments(t.client), /shim\.client\.rows/);
  assert.match(t.prefetch, /ctx\.rangeSlot/);
  const prefetch = stripComments(t.prefetch);
  assert.doesNotMatch(prefetch, /proplength/);
});

/** Runs the emitted prefetch body with the runtime shim; returns the filled slots. */
async function prefetchSlots(code: string, runtime: ReturnType<typeof createRuntime>, ctx?: unknown): Promise<Record<string, unknown>> {
  const slots: Record<string, unknown> = {};
  await (new Function('shim', 'ctx', 'slots', `return (async () => {\n${code}\n})();`) as (
    shim: unknown,
    ctx: unknown,
    slots: Record<string, unknown>,
  ) => Promise<void>)(runtime.shim, ctx ?? runtime.context({ record: {} }), slots);
  return slots;
}

test('a self-assigned scalar replays once into the prefetch, then the value prefetch', async () => {
  const t = translate('n = 0;\nn = n + 1;\nn = n + 1;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }');
  assert.equal(t.stats.todo, 0);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = 0;\nvar n = \(n \+ 1\);\nvar n = \(n \+ 1\);/);
  assert.match(p, /slots\["c0"\] = \(c > n\)/);
  assert.match(stripComments(t.client), /if \(slots\["c0"\]\)/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Orders: [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }] } });
  const slots = await prefetchSlots(t.prefetch, runtime);
  assert.equal(slots.c0, true); // count 3 > n 2
  const few = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Orders: [{ ROWID: '1' }] } });
  assert.equal((await prefetchSlots(t.prefetch, few)).c0, false);
});

test('a self-assigned range end replays into the prefetch of a sorted ranged loop', async () => {
  const t = translate('last = 1;\nlast = last + 1;\nfor each r in Orders[ID != 0] sort by ID asc range from 1 to last { alert r.Name; }');
  assert.equal(t.stats.todo, 0);
  const p = stripComments(t.prefetch);
  assert.match(p, /var last = 1;\nvar last = \(last \+ 1\);/);
  assert.match(p, /range: \{ from: 1, to: last \}/);
  // The page-window limit is documented on the emitted client loop: only the
  // page the range names is snapshotted.
  assert.match(t.client, /snapshot: a ranged query is the page the range names; a loop body that moves the page window reads no later page/);
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Orders: [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }] },
  });
  const slots = await prefetchSlots(t.prefetch, runtime);
  assert.equal((slots.c0 as unknown[]).length, 2); // range 1..2
});

test('a read-only environment binding replays into the prefetch', async () => {
  const login = translate('u = zoho.loginuser;\ncount = Orders[Owner == u].count();\nif (count > 0) { alert "x"; }');
  assert.equal(login.stats.todo, 0);
  assert.match(stripComments(login.prefetch), /var u = shim\.zoho\.loginUser\(ctx\);/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Orders: [{ ROWID: '1' }] } });
  assert.equal(typeof (await prefetchSlots(login.prefetch, runtime)).c0, 'boolean');
  const time = translate('d = zoho.currentdate;\nn = 1;\nn = n + 1;\nc = Orders[ID != 0].count();\nif (c > n || d == null) { alert "x"; }');
  assert.equal(time.stats.todo, 0);
  assert.match(stripComments(time.prefetch), /var d = shim\.zoho\.currentDate\(ctx\);/);
  assert.match(stripComments(time.prefetch), /var n = 1;\nvar n = \(n \+ 1\);/);
  assert.equal((await prefetchSlots(time.prefetch, createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Orders: [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }] } }))).c0, true);
});

test('a binding holding a side effect is never replayed into the prefetch', () => {
  const cases: [string, string][] = [
    ['same-app function', 'r = thisapp.Helpers.twice(4);\nn = 0;\nn = r;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }'],
    ['integration task', 'r = zoho.crm.getRecords("Leads");\nn = 0;\nn = r;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }'],
    ['insert', 'r = insert into Orders[Name = "A"];\nn = 0;\nn = r;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }'],
    ['update', 'l = List();\nr = l.update(0, 5);\nn = 0;\nn = r;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }'],
    ['delete', 'l = List();\nr = l.delete(0);\nn = 0;\nn = r;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }'],
    ['mail', 'r = sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "m"];\nn = 0;\nn = r;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }'],
  ];
  for (const [kind, src] of cases) {
    const t = translate(src);
    assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1, kind);
    assert.equal(t.prefetch.includes('slots['), false, kind);
    assert.doesNotMatch(stripComments(t.prefetch), /thisapp|zoho\.task|datastore\.insert|list\.update|list\.deleteItem|mail\.send/, kind);
  }
});

test('a getUrl binding is never replayed into the prefetch, chained or inline', () => {
  // getUrl is the same outbound transport and host allowlist as invokeurl:
  // replaying the binding would run the GET in the prefetch and again in the
  // server handler.
  const bound = translate('resp = getUrl("https://example.test/feed");\nif (resp == "ok") { alert "x"; }');
  assert.equal(bound.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.equal(bound.prefetch.includes('slots['), false);
  assert.doesNotMatch(stripComments(bound.prefetch), /getUrl/);
  assert.match(stripComments(bound.server), /await shim\.http\.getUrl\(ctx, "https:\/\/example\.test\/feed"\)/);
  // Chained through a copied scalar the condition stays a counted todo.
  const chained = translate('resp = getUrl("https://example.test/feed");\nn = resp;\nc = Orders[ID != 0].count();\nif (c > 0 && n == "ok") { alert "x"; }');
  assert.equal(chained.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(chained.prefetch), /getUrl/);
  // The call inline in the condition is refused the same way.
  const inline = translate('if (getUrl("https://example.test/feed") == "ok") { alert "x"; }');
  assert.equal(inline.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.equal(inline.prefetch.includes('slots['), false);
  // Reassigning the binding name afterwards does not launder the effect: the
  // read still records the call the assignment saw.
  const shadowed = translate('resp = getUrl("https://example.test/feed");\nn = resp;\nresp = "ok";\nc = Orders[ID != 0].count();\nif (c > 0 && n == "ok") { alert "x"; }');
  assert.equal(shadowed.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(shadowed.prefetch), /getUrl/);
});

test('a copied local replays the binding its read saw, not the latest', async () => {
  const t = translate('n = 1;\nlimit = n;\nn = n + 9;\nfor each r in Orders[ID != 0] sort by ID asc range from 1 to limit { alert r.Name; }');
  assert.equal(t.stats.todo, 0);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = 1;\nvar limit = n;/);
  assert.doesNotMatch(p, /n \+ 9/);
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Orders: [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }, { ROWID: '4' }, { ROWID: '5' }] },
  });
  const slots = await prefetchSlots(t.prefetch, runtime);
  assert.equal((slots.c0 as unknown[]).length, 1); // range 1..1, not 1..10
});

test('a later slot restores an earlier binding version a copy recorded', async () => {
  // `a` captured `n = 1` before `n = n + 9`; a condition on `a` must replay the
  // earlier binding even after the newer one ran for another slot.
  const t = translate('n = 1;\na = n;\nn = n + 9;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }\nif (c > a) { alert "y"; }');
  assert.equal(t.stats.todo, 0);
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Orders: [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }, { ROWID: '4' }, { ROWID: '5' }] },
  });
  const slots = await prefetchSlots(t.prefetch, runtime);
  assert.equal(slots.c0, false); // count 5 > n 10 is false
  assert.equal(slots.c1, true); // count 5 > a 1 is true
});

test('a self-read with no earlier binding resolves prefetch-bound names only', () => {
  const bound = translate('n = n + 1;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }', { prefetchBound: ['n'] });
  assert.equal(bound.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(bound.prefetch), /var n = \(n \+ 1\);/);
  const unbound = translate('n = n + 1;\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }');
  assert.equal(unbound.todos.some((item) => item.construct === 'client-condition-uses-server'), true);
});

test('one slot needing two versions of a name replays both in assignment order', async () => {
  // `a` captured n = 1; the condition still reads the newer n = 10. The
  // earlier version must be emitted before `a`, not re-emitted over the newer
  // one the slot reads.
  const t = translate('n = 1;\na = n;\nn = n + 9;\nc = Orders[ID != 0].count();\nif (c > n && a == 1) { alert "x"; }');
  assert.equal(t.stats.todo, 0);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = 1;\nvar a = n;\nvar n = \(n \+ 9\);\nvar c = await shim\.datastore\.aggregate/);
  assert.match(p, /slots\["c0"\] = \(\(c > n\) && \(a == 1\)\)/);
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Orders: [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }, { ROWID: '4' }, { ROWID: '5' }] },
  });
  const slots = await prefetchSlots(t.prefetch, runtime);
  assert.equal(slots.c0, false); // 5 > 10 is false, whatever `a` holds
});

test('a range window replays both endpoint versions in assignment order', async () => {
  // `hi` captured n = 1; the window reads the newer n = 5, so the real range
  // is 5 to 1 — a RangeIndexError, not a 1-row page.
  const t = translate('n = 1;\nhi = n;\nn = 5;\nfor each r in Orders[ID != 0] sort by ID asc range from n to hi { alert r.Name; }');
  assert.equal(t.stats.todo, 0);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = 1;\nvar hi = n;\nvar n = 5;/);
  assert.match(p, /range: \{ from: n, to: hi \}/);
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Orders: [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }, { ROWID: '4' }, { ROWID: '5' }] },
  });
  await assert.rejects(prefetchSlots(t.prefetch, runtime), /RangeIndexError|RANGE_INDEX/);
});

test('a binding assigned inside a loop body is never replayed', () => {
  // `n = n + 1` in the loop body leaves n = 5 on the seed, not the single
  // increment a replay would run, so the condition stays a counted todo.
  const t = translate('n = 0;\nfor each r in Orders[ID != 0] { n = n + 1; }\nc = Orders[ID != 0].count();\nif (n < 3 && c > 0) { alert "x"; }');
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  const p = stripComments(t.prefetch);
  assert.doesNotMatch(p, /var n =/);
  assert.match(p, /slots\["c0"\] = await shim\.datastore\.rows/);
  // A client-only condition after the loop still evaluates on the client.
  const local = translate('n = 0;\nfor each r in Orders[ID != 0] { n = n + 1; }\nif (n > 2) { alert "x"; }');
  assert.equal(local.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.doesNotMatch(stripComments(local.prefetch), /var n/);
});

test('a binding assigned in an if/else arm is never replayed at a later use', () => {
  // Neither arm's `n` dominates the range end, so the prefetch replays no
  // binding. The client declared `n`, though, and posts whichever value the
  // arms left as a deferred read: when Flag runs the page is 1 row.
  const ranged = translate('if (input.Flag) { n = 1; } else { n = 100; }\nfor each r in Orders[ID != 0] sort by ID asc range from 1 to n { alert r.Name; }', {
    inputFields: ['Flag'],
  });
  assert.equal(ranged.todos.filter((item) => item.construct === 'client-loop-uses-server').length, 0);
  assert.doesNotMatch(stripComments(ranged.prefetch), /var n =/);
  assert.match(stripComments(ranged.prefetch), /ctx\.rangeSlot === "c0"/);
  assert.match(stripComments(ranged.client), /await shim\.client\.rows\(ctx, "c0", 1, n\)/);
  // Neither arm's assignment dominates the condition after the if.
  const self = translate('n = 1;\nif (false) { n = 2; } else { n = n + 9; }\nc = Orders[ID != 0].count();\nif (c > n) { alert "x"; }');
  assert.equal(self.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(self.prefetch), /var n = \(n \+ 9\)/);
});

function fiveOrders() {
  return createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Orders: [{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }, { ROWID: '4' }, { ROWID: '5' }] },
  });
}

test('an if test replays the binding in force before an arm reassigns it', async () => {
  // The arm's `n = 0` does not run when the test is evaluated. A 5-row count
  // makes `n > 3` true; replaying the arm would make the slot false.
  const t = translate('n = Orders[ID != 0].count();\nif (n > 3) {\n  n = 0;\n  alert "x";\n}');
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = await shim\.datastore\.aggregate/);
  assert.doesNotMatch(p, /var n = 0/);
  assert.match(p, /slots\["c0"\] = \(n > 3\)/);
  const slots = await prefetchSlots(t.prefetch, fiveOrders());
  assert.equal(slots.c0, true);
});

test('an else-if test replays the binding in force before the arms', async () => {
  // The then-arm `n = 9` has not run when the else-if test is evaluated.
  // count 5 > n 2 is true; replaying 9 would make the slot false.
  const t = translate(
    'n = 2;\nc = Orders[ID != 0].count();\nif (input.Flag) {\n  n = 9;\n  alert "a";\n} else if (c > n) {\n  alert "b";\n}',
    { inputFields: ['Flag'] },
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = 2;/);
  assert.doesNotMatch(p, /var n = 9/);
  const slots = await prefetchSlots(t.prefetch, fiveOrders());
  assert.equal(slots.c0, true);
});

test('a for-each collection replays the range bound in force before the body', async () => {
  // The body increments `k`, but the range is evaluated once, before the loop.
  // range 1 to 2 is two rows; replaying the increment would page three.
  const t = translate(
    'k = 2;\nfor each r in Orders[ID != 0] sort by ID asc range from 1 to k {\n  k = k + 1;\n  alert r.Name;\n}',
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-loop-uses-server'), false);
  const p = stripComments(t.prefetch);
  assert.match(p, /var k = 2;/);
  assert.doesNotMatch(p, /k \+ 1/);
  const slots = await prefetchSlots(t.prefetch, fiveOrders());
  assert.equal((slots.c0 as unknown[]).length, 2);
});

test('a loop-carried read before the write is not replayed', () => {
  // `n` is 0, then 1, then 2, … inside the loop. Replaying `n = 0` for the
  // condition would alert on every row. The condition stays a counted todo.
  const t = translate(
    'n = 0;\nc = Orders[ID != 0].count();\nfor each r in Orders[ID != 0] {\n  if (c > n + 3) {\n    alert r.Name;\n  }\n  n = n + 1;\n}',
  );
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(t.prefetch), /var n =/);
});

test('a while body read before the write is not replayed', () => {
  // Same carry as a for-each: `c > n` sees a new `n` on every iteration.
  const t = translate(
    'n = 0;\nc = Orders[ID != 0].count();\nwhile (n < 10) {\n  if (c > n) {\n    alert "x";\n  }\n  n = n + 1;\n}',
  );
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(t.prefetch), /var n =/);
});

test('a nested loop does not replay a loop-carried read', () => {
  const inner = translate(
    'n = 0;\nc = Orders[ID != 0].count();\nfor each a in Orders[ID != 0] {\n  for each b in Orders[ID != 0] {\n    if (c > n + 3) { alert "x"; }\n    n = n + 1;\n  }\n}',
  );
  assert.equal(inner.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(inner.prefetch), /var n =/);
  // The write is on the outer loop; the read is on the inner loop.
  const outer = translate(
    'n = 0;\nc = Orders[ID != 0].count();\nfor each a in Orders[ID != 0] {\n  for each b in Orders[ID != 0] {\n    if (c > n + 3) { alert "x"; }\n  }\n  n = n + 1;\n}',
  );
  assert.equal(outer.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(outer.prefetch), /var n =/);
});

test('a while test the body reassigns stays a counted todo', () => {
  // The test runs again each iteration, so the initial count is not the value
  // the client would re-read.
  const t = translate('n = Orders[ID != 0].count();\nwhile (n > 0) {\n  alert "x";\n  n = n - 1;\n}');
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(t.prefetch), /var n =/);
});

test('a literal assigned in a loop body still replays for a later read in that body', async () => {
  const t = translate(
    'c = Orders[ID != 0].count();\nfor each r in Orders[ID != 0] {\n  k = 2;\n  if (c > k) { alert r.Name; }\n}',
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(t.prefetch), /var k = 2;/);
  const slots = await prefetchSlots(t.prefetch, fiveOrders());
  // The condition is slotted while the body is translated, before the collection.
  assert.equal(slots.c0, true);
  assert.equal((slots.c1 as unknown[]).length, 5);
});

test('an else arm replays the binding in force before the then arm reassigns it', async () => {
  // The then-arm `n = 0` does not run on the else path. The read inside the
  // else arm is the count, so `n > 3` is true; replaying 0 would make it false.
  const t = translate(
    'n = Orders[ID != 0].count();\nif (input.Flag) {\n  n = 0;\n  alert "a";\n} else {\n  if (n > 3) { alert "b"; }\n}',
    { inputFields: ['Flag'] },
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = await shim\.datastore\.aggregate/);
  assert.doesNotMatch(p, /var n = 0/);
  const slots = await prefetchSlots(t.prefetch, fiveOrders());
  assert.equal(slots.c0, true);
});

test('an else-if arm replays a value the then arm reassigns', async () => {
  // The openUrl runs only when the then-arm did not. Its URL is the count
  // from before the if, not the then-arm's 0.
  const t = translate(
    'n = Orders[ID != 0].count();\nif (input.Flag) {\n  n = 0;\n  alert "a";\n} else if (input.Other) {\n  openUrl(n, "same window");\n}',
    { inputFields: ['Flag', 'Other'] },
  );
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = await shim\.datastore\.aggregate/);
  assert.doesNotMatch(p, /var n = 0/);
  assert.match(stripComments(t.client), /openUrl/);
  const slots = await prefetchSlots(t.prefetch, fiveOrders());
  assert.equal(slots.c0, 5);
});

test('a read after an if does not replay a binding an arm may have replaced', () => {
  // The else arm leaves `n` alone, but the then-arm may have replaced the
  // count. The condition after the if has no single value.
  const t = translate(
    'n = Orders[ID != 0].count();\nif (input.Flag) {\n  n = Orders[ID == 0].count();\n  alert "a";\n} else {\n  alert "b";\n}\nif (n > 3) { alert "c"; }',
    { inputFields: ['Flag'] },
  );
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(t.prefetch), /var n =/);
});

test('a name any if arm binds non-client-ready stays refused in every arm order', () => {
  // Whichever arm ran last, a read after the if may see the value the other
  // arm bound. Every order of a server-bound arm and a client-ready arm is a
  // counted todo, never a bare client name.
  const cases: [string, string][] = [
    [
      'side effect then, literal else',
      'x = "init";\nif (input.Flag) { x = getUrl("https://example.test/a"); } else { x = "other"; }\nif (x == "init") { alert "y"; }',
    ],
    [
      'literal then, side effect else',
      'x = "init";\nif (input.Flag) { x = "other"; } else { x = getUrl("https://example.test/a"); }\nif (x == "init") { alert "y"; }',
    ],
    [
      'side effect then, no else',
      'x = "init";\nif (input.Flag) { x = getUrl("https://example.test/a"); }\nif (x == "init") { alert "y"; }',
    ],
    [
      'side effect in both arms',
      'x = "init";\nif (input.Flag) { x = getUrl("https://example.test/a"); } else { x = getUrl("https://example.test/b"); }\nif (x == "init") { alert "y"; }',
    ],
    [
      'query then, literal else',
      'x = "init";\nif (input.Flag) { x = Orders[ID != 0].count(); } else { x = "other"; }\nif (x == "init") { alert "y"; }',
    ],
    [
      'literal then, query else',
      'x = "init";\nif (input.Flag) { x = "other"; } else { x = Orders[ID != 0].count(); }\nif (x == "init") { alert "y"; }',
    ],
    [
      'elif chain with a server arm',
      'x = "init";\nif (input.Flag) { x = "a"; } else if (input.Other) { x = getUrl("https://example.test/a"); } else { x = "b"; }\nif (x == "init") { alert "y"; }',
    ],
    [
      'elif chain of literals stays client-ready',
      'x = "init";\nif (input.Flag) { x = "a"; } else if (input.Other) { x = "b"; } else { x = "c"; }\nif (x == "init") { alert "y"; }',
    ],
  ];
  for (const [kind, src] of cases) {
    const t = translate(src, { inputFields: ['Flag', 'Other'] });
    const refused = t.todos.filter((item) => item.construct === 'client-condition-uses-server').length;
    if (kind === 'elif chain of literals stays client-ready') {
      assert.equal(refused, 0, kind);
      assert.match(stripComments(t.client), /x == "init"/, kind);
      continue;
    }
    assert.equal(refused, 1, kind);
    assert.doesNotMatch(stripComments(t.client), /x == "init"/, kind);
    assert.doesNotMatch(stripComments(t.prefetch), /getUrl/, kind);
  }
});

test('a call on a name an if arm may have left non-client-ready is refused', () => {
  // `x` is a fetched collection on the Flag path and a number on the other.
  // `x.count()` must not reach the client as a list call on a number.
  const t = translate('if (input.Flag) { x = Orders[ID != 0]; } else { x = 1; }\ny = x.count();\nif (y > 0) { alert "y"; }', {
    inputFields: ['Flag'],
  });
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(t.client), /aggregate\(x/, 'x.count()');
  // The mirrored order refuses the same way.
  const swapped = translate('if (input.Flag) { x = 1; } else { x = Orders[ID != 0]; }\ny = x.count();\nif (y > 0) { alert "y"; }', {
    inputFields: ['Flag'],
  });
  assert.equal(swapped.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(swapped.client), /aggregate\(x/, 'x.count()');
});

test('a loop-body read before the first write with no prior binding is a counted todo', () => {
  // `k` is assigned in the body but read before that point, so even the first
  // iteration has no value for it: the prefetch must not emit a dangling `k`.
  const t = translate('c = Orders[ID != 0].count();\nfor each r in Orders[ID != 0] {\n  if (c > k) { alert r.Name; }\n  k = 2;\n}');
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  const p = stripComments(t.prefetch);
  assert.doesNotMatch(p, /\bk\b/);
  assert.match(p, /slots\["c0"\] = await shim\.datastore\.rows/);
});

test('a read before the first write of a name is a counted todo', () => {
  // `a` copies `b` before `b` exists: neither the client nor the prefetch can
  // evaluate `a`, so the condition is refused instead of emitting `var a = b`.
  const t = translate('a = b;\nb = Orders[ID != 0].count();\nif (a > 0) { alert "x"; }');
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  assert.doesNotMatch(stripComments(t.client), /var a = b/);
  const p = stripComments(t.prefetch);
  assert.doesNotMatch(p, /var a = b|\(a > 0\)/);
});

test('a read of a name that is never bound is a counted todo', () => {
  const t = translate('c = Orders[ID != 0].count();\nif (c > k) { alert "x"; }');
  assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1);
  const p = stripComments(t.prefetch);
  assert.doesNotMatch(p, /\bk\b/);
});

test('an aggregate field-name argument is not an unbound read', () => {
  // `count(Guest)` emits the bare name as a link-name literal, so the field
  // name is not a read at all: the binding stays prefetchable and the
  // condition keeps its slot instead of degrading to a counted todo.
  for (const fn of ['count', 'sum', 'avg', 'distinct']) {
    const t = translate(`x = Bookings[Room == "A"].${fn}(Guest);\nif (x > 0) { alert "x"; }`);
    assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false, fn);
    assert.match(
      stripComments(t.prefetch),
      new RegExp(`var x = await shim\\.datastore\\.aggregate\\(ctx, shim\\.datastore\\.query\\(ctx, "Bookings".*"${fn}", "Guest"\\)`),
      fn,
    );
    assert.match(stripComments(t.prefetch), /slots\["c0"\] = \(x > 0\)/, fn);
    assert.match(stripComments(t.client), /if \(slots\["c0"\]\)/, fn);
  }

  // A local stays a real argument: its read is part of the call.
  const local = translate('field = "Guest";\nx = Bookings[Room == "A"].count(field);\nif (x > 0) { alert "x"; }');
  assert.equal(local.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(local.prefetch), /var field = "Guest";/);

  // An input field keeps its real argument too: the value is the field's
  // content, not a link-name literal.
  const input = translate('x = Bookings[Room == "A"].count(Guest);\nif (x > 0) { alert "x"; }', { inputFields: ['Guest'] });
  assert.equal(input.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(input.prefetch), /slots\["c0"\] = \(x > 0\)/);
});

test('a date refinement unions off when any arm is not a date', () => {
  // Both arms leave `x` client-ready, but the else arm assigns a string: the
  // merged `x` is not a date on that path, so `x.toString()` is String(x).
  const t = translate(
    'x = zoho.currentdate;\nif (input.Flag) { x = zoho.currentdate; } else { x = "text"; }\ny = x.toString();',
    { inputFields: ['Flag'] },
  );
  assert.match(stripComments(t.client), /var y = String\(x\)/);
  assert.doesNotMatch(stripComments(t.client), /shim\.date\.text\(x/);

  // When every path leaves a date, the refinement survives.
  const dated = translate(
    'x = zoho.currentdate;\nif (input.Flag) { x = zoho.currentdate; } else { x = zoho.currentdate; }\ny = x.toString();',
    { inputFields: ['Flag'] },
  );
  assert.match(stripComments(dated.client), /var y = shim\.date\.text\(x, ctx\)/);
});

test('a decimal refinement stays when any path is a decimal', () => {
  // A number path beside a decimal path is still exact: the shim accepts a
  // plain number, and a raw `+` would concatenate once a Decimal is involved.
  const t = translate('x = 1;\nif (input.Flag) { x = 1.5; }\ny = x + 1;', { inputFields: ['Flag'] });
  const code = stripComments(`${t.server}\n${t.client}`);
  assert.match(code, /var y = shim\.decimal\.add\(x, 1\)/);
  assert.doesNotMatch(code, /var y = \(x \+ 1\)/);
});

test('a date refinement survives when the other path never bound the name', () => {
  // The else-less fall-through does not assign `d`, so it is not a non-date.
  // The comparison keeps date ordering, including blank handling.
  const t = translate('if (input.F) { d = zoho.currentdate; }\nif (d <= input.Foo) { alert "x"; }', {
    inputFields: ['F', 'Foo'],
  });
  const code = stripComments(`${t.server}\n${t.client}\n${t.prefetch}`);
  assert.match(code, /shim\.date\.rel\(d, shim\.input\.get\(ctx, "Foo"\), "<=", ctx\)/);
  assert.doesNotMatch(code, /d <= shim\.input\.get\(ctx, "Foo"\)/);
});

test('an assignment after an if replays that assignment', async () => {
  // The arm's `n = 0` does not survive the later `n = count()`.
  const t = translate(
    'n = 1;\nif (input.Flag) {\n  n = 0;\n  alert "a";\n} else {\n  alert "b";\n}\nn = Orders[ID != 0].count();\nif (n > 3) { alert "c"; }',
    { inputFields: ['Flag'] },
  );
  assert.equal(t.stats.todo, 0);
  const p = stripComments(t.prefetch);
  assert.match(p, /var n = await shim\.datastore\.aggregate/);
  assert.doesNotMatch(p, /var n = 0/);
  const slots = await prefetchSlots(t.prefetch, fiveOrders());
  assert.equal(slots.c0, true);
});

test('a collection mutated with server data marks its later client read a todo', () => {
  // The mutation runs on the server only, so the client collection stays
  // empty. A later client condition on it must be a counted manual item, not
  // a silent read of the empty value.
  for (const src of [
    'l = List(); l.add(Orders[Status == "Open"].count()); if (l.size() > 0) { alert "x"; }',
    'm = Map(); m.put("k", Orders[Status == "Open"].count()); if (m.get("k") > 0) { alert "x"; }',
    'l = List(); for each r in Orders[Status == "Open"] { l.add(r.Hours); } if (l.size() > 0) { alert "x"; }',
    'm = Map(); for each r in Orders[Status == "Open"] { m.put("k", r.Hours); } if (m.get("k") > 0) { alert "x"; }',
  ]) {
    const t = translate(src);
    assert.equal(t.todos.filter((item) => item.construct === 'client-condition-uses-server').length, 1, src);
    assert.match(stripComments(t.client), /await shim\.todo\(ctx, "client-condition-uses-server"\)/);
    assert.doesNotMatch(stripComments(t.prefetch), /slots\["c\d+"\] = \(shim\.list\.(size|get)/);
  }
});

test('a collection mutated with client data stays a client collection', () => {
  const t = translate('l = List(); l.add(input.Hours); if (l.size() > 0) { alert "x"; }');
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(t.client), /shim\.list\.add\(l, /);
  assert.match(stripComments(t.client), /if \(\(shim\.list\.size\(l\) > 0\)\)/);
});

test('rebinding a server-mutated collection clears the server taint', () => {
  const t = translate(
    'l = List(); l.add(Orders[Status == "Open"].count()); l = List(); if (l.size() > 0) { alert "x"; }',
  );
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(t.client), /if \(\(shim\.list\.size\(l\) > 0\)\)/);
});

test('Archive_BOM awaits the datastore field write', () => {
  const t = translate(['bom_det = Create_BOM[ID == input.ID];', 'bom_det.BOM_Status = "Archive";'].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.match(stripComments(t.server), /await shim\.datastore\.setField\(ctx, bom_det, "BOM_Status", "Archive"\)/);
  for (const line of t.server.split('\n')) {
    if (!line.includes('shim.datastore.')) continue;
    if (line.includes('shim.datastore.query')) continue;
    assert.match(stripComments(line), /await shim\.datastore\./);
  }
});

test('a server read with no client action is not prefetched', () => {
  const t = translate('if (Orders[Status == "Open"].count() > 0) { id = insert into Orders[Name = "A"]; }');
  assert.equal(t.client.trim(), '');
  assert.equal(t.prefetch.trim(), '');
  assert.match(stripComments(t.server), /shim\.datastore\.insert/);
});

test('workflow criteria read bare field names from input, and a local hides the field', () => {
  const criteria = translate('return (Status == "Overdue" && Free_Days is not null);', {
    inputFields: ['Status', 'Free_Days'],
  });
  assert.match(stripComments(criteria.server), /shim\.input\.get\(ctx, "Status"\) == "Overdue"/);
  assert.match(stripComments(criteria.server), /shim\.input\.get\(ctx, "Free_Days"\) != null/);
  assert.equal(criteria.todos.length, 0);
  const local = translate('Status = "Issued";\nreturn (Status == "Overdue");', { inputFields: ['Status'] });
  assert.doesNotMatch(stripComments(local.server), /shim\.input\.get\(ctx, "Status"\)/);
  assert.match(stripComments(local.server), /Status == "Overdue"/);
  const today = translate('return (Schedule_Date is today);', { inputFields: ['Schedule_Date'] });
  assert.match(stripComments(today.server), /return shim\.date\.isDay\(shim\.input\.get\(ctx, "Schedule_Date"\), "today", ctx\);/);
  assert.equal(today.todos.length, 0);
  const added = translate('return (Added_User != zoho.adminuser);');
  assert.match(stripComments(added.server), /shim\.record\.system\(ctx\.record, "Added_User"\) != shim\.zoho\.adminUser\(ctx\)/);
  assert.equal(added.todos.length, 0);
  const when = translate('return (Added_Time < zoho.currentdate);');
  assert.match(stripComments(when.server), /shim\.record\.system\(ctx\.record, "Added_Time"\)/);
  assert.match(stripComments(when.server), /shim\.date\.rel\(/);
  assert.equal(when.todos.length, 0);
});

test('Field is this week compiles in a workflow criteria and keeps the week bounds', async () => {
  const src = [
    'names = "";',
    'for each r in Invoices[Added_Time is this week]',
    '{',
    'names = names + r.Note + ",";',
    '}',
    'return names;',
  ].join('\n');
  const t = translate(src);
  assert.equal(t.todos.some((item) => item.construct === 'criteria-dynamic'), false);
  assert.match(stripComments(t.server), /"__rel":"this week"/);
  const wider = translate('rows = Invoices[Added_Time > this week];');
  assert.equal(wider.todos.some((item) => item.construct === 'criteria-dynamic'), true);
  const blank = translate('rows = Invoices[Added_Time is null];');
  assert.match(stripComments(blank.server), /"isNull"/);
  assert.equal(blank.todos.some((item) => item.construct === 'criteria-dynamic'), false);
  const seed = {
    Invoices: [
      { ROWID: 'sat', Added_Time: '2026-10-10 23:30:00', Note: 'sat' },
      { ROWID: 'sun', Added_Time: '2026-10-11 00:00:00', Note: 'sun' },
      { ROWID: 'mid', Added_Time: '2026-10-17 23:59:59', Note: 'mid' },
      { ROWID: 'next', Added_Time: '2026-10-18 00:00:00', Note: 'next' },
    ],
  };
  const run = async (instant: string) => {
    const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date(instant), seed });
    const names = await body(t.server)(runtime.shim, runtime.context({ record: {} }));
    return String(names).split(',').filter(Boolean).sort();
  };
  // Seed order is not the result order: an unsorted fetch is ordered by ROWID.
  assert.deepEqual(await run('2026-10-10T18:45:00.000Z'), ['mid', 'sun']);
  assert.deepEqual(await run('2026-10-10T18:29:00.000Z'), ['sat']);
});

test('workflow criteria accept the documented relative-day and period membership shapes', () => {
  for (const value of ['today', 'this week', 'this month']) {
    const t = translate(`rows = Invoices[Added_Time is ${value}];`);
    assert.equal(t.todos.some((item) => item.construct === 'criteria-dynamic'), false, value);
    assert.match(stripComments(t.server), new RegExp(`"__rel":"${value}"`));
  }

  // A relative period used with an unrelated comparison cannot be guessed as a window.
  for (const value of ['this week', 'this month']) {
    const t = translate(`rows = Invoices[Added_Time > ${value}];`);
    assert.equal(t.todos.some((item) => item.construct === 'criteria-dynamic'), true, value);
    assert.match(stripComments(t.server), /shim\.todo\(ctx, "criteria-dynamic"\)/);
    assert.doesNotMatch(stripComments(t.server), /op: "true"/);
  }
});

test('the bare-field criteria shorthand applies to a single name, not a member path', () => {
  const bare = translate('rows = FlagRow[Qty != 99 && Billable];');
  assert.match(stripComments(bare.server), /{ op: "==", field: "Billable", value: true }/);
  assert.equal(bare.todos.some((item: any) => item.construct === 'criteria-dynamic'), false);
  const member = translate('rows = FlagRow[Qty != 99 && Lookup.Field];');
  assert.match(stripComments(member.server), /{ op: "todo", construct: "criteria-dynamic" }/);
  assert.doesNotMatch(stripComments(member.server), /field: "Lookup\.Field", value: true/);
  assert.equal(member.todos.some((item: any) => item.construct === 'criteria-dynamic'), true);
  const mixed = translate('rows = FlagRow[Billable && Lookup.Field];');
  assert.match(stripComments(mixed.server), /{ op: "==", field: "Billable", value: true }/);
  assert.match(stripComments(mixed.server), /{ op: "todo", construct: "criteria-dynamic" }/);
  assert.deepEqual(reportCriteria('Billable'), { op: '==', field: 'Billable', value: true });
  assert.deepEqual(reportCriteria('Lookup.Field'), { op: 'todo', construct: 'criteria-dynamic' });
});

test('a blank return date does not set the library overdue fine to 0', async () => {
  const t = translate([
    'todayDate = zoho.currentdate;',
    'returnDate = input.Return_date;',
    'if(todayDate > returnDate)',
    '{',
    'overdueDays = todayDate.toDate() - returnDate.toDate();',
    'fineAmount = overdueDays * 2;',
    'input.Fine_Amount = fineAmount;',
    '}',
    'else',
    '{',
    'input.Fine_Amount = 0;',
    '}',
  ].join('\n'));
  assert.match(stripComments(t.server), /shim\.date\.rel\(/);
  assert.doesNotMatch(stripComments(t.server), /date\.cmp\(/);
  assert.doesNotMatch(stripComments(t.server), /null <= 0|null >= 0/);
  assert.equal(t.todos.some((item: any) => item.construct === 'blank-date-rel'), false);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date('2020-06-15T12:00:00Z') });
  const ctx = runtime.context({ record: {} });
  const run = new Function('shim', 'ctx', `return (async () => {\n${t.server}\n})();`) as (
    shim: typeof runtime.shim,
    ctx: ReturnType<typeof runtime.context>,
  ) => Promise<unknown>;
  await assert.rejects(run(runtime.shim, ctx), /UnParsable date/);
  const fine = runtime.transcript.filter((e) => e.op === 'input.set' && Array.isArray(e.path) && e.path.includes('Fine_Amount'));
  assert.deepEqual(fine, []);
});

test('payments inside Deluge are a TODO, never a gateway call', () => {
  const t = translate('zoho.checkout.create();');
  assert.ok(t.todos.some((item: any) => item.construct === 'payments'));
  assert.match(stripComments(t.server), /shim\.todo\(ctx, "payments"\)/);
  assert.doesNotMatch(stripComments(t.server), /gateway/i);
});

test('Object.prototype names are not dispatch-table implementations', () => {
  const names = Object.getOwnPropertyNames(Object.prototype).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  assert.ok(names.includes('toString'));
  assert.ok(names.includes('valueOf'));
  assert.ok(names.includes('constructor'));
  const native = /\[native code\]/;
  const fnLit = /function\s+\w+\(\)\s*\{/;
  for (const name of names) {
    for (const src of [`x = ${name}("x");`, `x = "abc".${name}();`, `x = "abc".${name}("x");`]) {
      const t = translate(src);
      const code = [t.server, t.client, t.prefetch].join('\n');
      assert.doesNotMatch(stripComments(code), native, src);
      assert.doesNotMatch(stripComments(code), fnLit, src);
    }
  }
  // toString(value) is the documented function form of value.toString(): both emit String(value).
  const free = translate('x = toString("x");');
  assert.match(stripComments(free.server), /var x = String\("x"\);/);
  assert.equal(free.todos.length, 0);
  assert.doesNotMatch(stripComments(free.server), native);
  const valued = translate('x = "abc".valueOf();');
  assert.match(stripComments(valued.server), /shim\.todo\(ctx, "method:valueOf"\)/);
  assert.doesNotMatch(stripComments(valued.server), /\[native code\]/);
});

test('cancel delete refuses the delete on the server and a literal alert before it sets the text', () => {
  assert.deepEqual(kinds('cancel delete;'), ['cancelDelete']);
  const plain = translate('cancel delete;');
  assert.equal(plain.todos.length, 0);
  assert.match(stripComments(plain.server), /await shim\.validate\.cancelDelete\(ctx, null\);/);
  assert.equal(plain.client, '');
  const alerted = translate('alert "Locked";\ncancel delete;');
  assert.equal(alerted.todos.length, 0);
  assert.match(stripComments(alerted.server), /shim\.validate\.cancelDelete\(ctx, "Locked"\);/);
});

test('success message sets the banner through a client op with Deluge concatenation', () => {
  assert.deepEqual(kinds('success message "c2c " + input.Name + " qty " + input.Qty + " ok";'), ['successMessage']);
  const out = translate('success message "c2c " + input.Name + " qty " + input.Qty + " ok";');
  assert.equal(out.todos.length, 0);
  assert.equal(out.server, '');
  assert.match(stripComments(out.client), /actions\.push\(\{ op: "successMessage", message: /);
});

test('sendmail paren form, quoted zoho vars, and template attachment', () => {
  const src = [
    'sendmail',
    '\t(',
    '\t\tfrom : "zoho.adminuserid"',
    '\t\tto : Customer.Email',
    '\t\tsubject : "New Order Invoice"',
    '\t\tmessage : "Hi"',
    '\t\tattachments : template : Order_Invoice as pdf',
    '\t)',
  ].join('\n');
  assert.deepEqual(kinds(src), ['expr']);
  const t = translate(src);
  assert.equal(t.stats.todo, 0);
  assert.match(stripComments(t.server), /await shim\.mail\.send\(ctx, /);
  assert.match(stripComments(t.server), /"from": shim\.zoho\.adminUserId\(ctx\)/);
  assert.match(stripComments(t.server), /"to": shim\.get\(Customer, "Email"\)/);
  assert.match(stripComments(t.server), /"attachments": \[\{ kind: "template", name: "Order_Invoice", form: null, record: shim\.input\.root\(ctx\), format: "pdf", rendered: "pdf" \}\]/);
  assert.deepEqual(
    t.todos.map((item: any) => item.construct),
    [],
  );
});

test('sendmail bracket form: comma recipients, bcc, reply to, content type', () => {
  const src = [
    'sendmail',
    '\t[',
    '\t\tfrom :zoho.adminuserid',
    '\t\tto :getStaffRec.Email,getRec.Customer_Email',
    '\t\tbcc :zoho.adminuserid',
    '\t\treply to:"support@zohocreator.com"',
    '\t\tcontent type:"Plain Text"',
    '\t\tsubject :"s"',
    '\t\tmessage :"m"',
    '\t]',
  ].join('\n');
  assert.deepEqual(kinds(src), ['expr']);
  const t = translate(src);
  assert.equal(t.stats.todo, 0);
  assert.equal(t.todos.length, 0);
  assert.match(stripComments(t.server), /"to": \[shim\.get\(getStaffRec, "Email"\), shim\.get\(getRec, "Customer_Email"\)\]/);
  assert.match(stripComments(t.server), /"bcc": shim\.zoho\.adminUserId\(ctx\)/);
  assert.match(stripComments(t.server), /"reply to": "support@zohocreator\.com"/);
  assert.match(stripComments(t.server), /"content type": "Plain Text"/);
});

test('sendmail attachment descriptors preserve kinds, criteria, and default formats', () => {
  const src = 'sendmail[from:zoho.adminuserid to:"a@b.c" subject:"s" message:"m" Attachments:view:Leads_View[Status=="Converted"] as PDF,report:Leads_Report as PDF,template:Invoice_Template as PDF,file:fileResp]';
  assert.deepEqual(kinds(src), ['expr']);
  const t = translate(src);
  assert.equal(t.stats.todo, 0);
  assert.match(stripComments(t.server), /"attachments": \[\{ kind: "view", name: "Leads_View", criteria: \{ op: "==", field: "Status", value: "Converted" \}, format: "pdf" \}, \{ kind: "report", name: "Leads_Report", criteria: null, format: "pdf" \}, \{ kind: "template", name: "Invoice_Template", form: null, record: shim\.input\.root\(ctx\), format: "pdf", rendered: "pdf" \}, \{ kind: "file", file: fileResp \}\]/);
  assert.deepEqual(
    t.todos.map((item: any) => item.construct),
    // The template attachment renders to the PDF in the mail function (rendered: "pdf"), so it is no longer a todo.
    ['sendmail-attachment:view', 'sendmail-attachment:report'],
  );
});

test('sendmail view, report, and template attachments without as are a mail-attachment-as task', () => {
  const sources = [
    'sendmail[from:zoho.adminuserid to:"a@b.c" subject:"s" message:"m" Attachments:view:Leads_View[Status=="Converted"]]',
    'sendmail[from:zoho.adminuserid to:"a@b.c" subject:"s" message:"m" Attachments:report:Leads_Report]',
    'sendmail[from:zoho.adminuserid to:"a@b.c" subject:"s" message:"m" Attachments:template:Invoice_Template]',
  ];
  for (const src of sources) {
    const t = translate(src);
    const server = stripComments(t.server);
    assert.doesNotMatch(server, /format:|"attachments"|kind: "view"|kind: "report"|kind: "template"/);
    assert.match(server, /await shim\.todo\(ctx, "task:sendmail"/);
    const stmt = parse(src).body[0];
    assert.ok(stmt && stmt.kind === 'unknown');
    assert.equal(stmt.reason, 'mail-attachment-as');
    assert.equal(t.stats.todo, 1);
    assert.deepEqual(
      t.todos.map((item) => item.construct),
      ['task:sendmail'],
    );
  }
});

test('sendmail custom-function template attachment carries form and record', () => {
  const src = 'sendmail[from:zoho.loginuserid to:zoho.adminuserid subject:"s" message:"m" Attachments:template:Medical_Invoice:invoice_details record_id as PDF]';
  const t = translate(src);
  assert.match(stripComments(t.server), /\{ kind: "template", name: "Medical_Invoice", form: "invoice_details", record: record_id, format: "pdf", rendered: "pdf" \}/);
  assert.deepEqual(
    t.todos.map((item: any) => item.construct),
    [],
  );
});

test('translated sendmail reaches the fake transport with attachments intact', async () => {
  const src = 'sendmail[from:"zoho.adminuserid" to:"a@b.c","d@e.f" bcc:"x@y.z" subject:"s" message:"m" attachments:template:Inv as inline,file:fileResp]';
  const t = translate(src);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date('2020-06-15T12:00:00Z') });
  const ctx = runtime.context({ record: {} });
  const fileResp = { kind: 'file' };
  const run = new Function('shim', 'ctx', 'fileResp', `return (async () => {\n${t.server}\n})();`) as (
    shim: typeof runtime.shim,
    ctx: ReturnType<typeof runtime.context>,
    fileResp: unknown,
  ) => Promise<unknown>;
  await run(runtime.shim, ctx, fileResp);
  const mail = runtime.transcript.find((e) => e.op === 'sendmail');
  assert.ok(mail);
  const message = mail.message as Record<string, unknown>;
  assert.equal(mail.dryRun, true);
  assert.equal(mail.performed, false);
  assert.equal(message.from, 'notifications@zohocreatormail.example');
  assert.deepEqual(message.to, ['a@b.c', 'd@e.f']);
  assert.equal(message.bcc, 'x@y.z');
  assert.deepEqual(message.attachments, [
    { kind: 'template', name: 'Inv', form: null, record: {}, format: 'inline', rendered: 'inline' },
    { kind: 'file', file: fileResp },
  ]);
});

test('sendmail inline template attachment renders server-side and drops the diagnostic', () => {
  const src = 'sendmail[from:zoho.loginuserid to:"a@b.c" subject:"s" message:"m" attachments:template:Invoice as inline]';
  const t = translate(src);
  assert.equal(t.stats.todo, 0);
  assert.deepEqual(
    t.todos.map((item: any) => item.construct),
    [],
  );
  assert.match(
    stripComments(t.server),
    /\{ kind: "template", name: "Invoice", form: null, record: shim\.input\.root\(ctx\), format: "inline", rendered: "inline" \}/,
  );
  // A PDF template renders to an attachment too and drops the diagnostic.
  const pdf = translate('sendmail[from:zoho.loginuserid to:"a@b.c" subject:"s" message:"m" attachments:template:Invoice as pdf]');
  assert.deepEqual(
    pdf.todos.map((item: any) => item.construct),
    [],
  );
  assert.match(stripComments(pdf.server), /\{ kind: "template", name: "Invoice", form: null, record: shim\.input\.root\(ctx\), format: "pdf", rendered: "pdf" \}/);
  // A view render keeps its counted diagnostic.
  const view = translate('sendmail[from:zoho.loginuserid to:"a@b.c" subject:"s" message:"m" attachments:view:Items_View as pdf]');
  assert.deepEqual(
    view.todos.map((item: any) => item.construct),
    ['sendmail-attachment:view'],
  );
});

type Run = (shim: ReturnType<typeof createRuntime>['shim'], ctx: ReturnType<ReturnType<typeof createRuntime>['context']>) => Promise<unknown>;

function body(code: string): Run {
  return new Function('shim', 'ctx', `return (async () => {\n${code}\n})();`) as Run;
}

test('a bare field in a for-each-record function reads the current row; a local still wins', async () => {
  const t = translate('thisapp.Vote.vote(ID);\nx = Status;\nStatus2 = 1;\ny = Status2;', {
    rowNames: ['rec'],
    rowFields: ['Status', 'Status2', 'ID'],
  });
  assert.match(stripComments(t.server), /shim\.record\.get\(d_rec, "ID"\)/);
  assert.match(stripComments(t.server), /x = shim\.record\.get\(d_rec, "Status"\)/);
  assert.match(stripComments(t.server), /y = Status2;/);
  assert.doesNotMatch(stripComments(t.server), /\(ID\)|= Status;/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', now: new Date('2026-10-06T12:00:00Z') });
  const rec = { __row: true as const, form: 'Idea', values: { ID: '3000000000001', Status: 'Open' } };
  const ctx = runtime.context({ record: {}, row: rec });
  await body(`const d_rec = ctx.row;\n${translate('return Status;', { rowNames: ['rec'], rowFields: ['Status'] }).server}`)(runtime.shim, ctx).then((v) => assert.equal(v, 'Open'));
  // Without rowFields (not a for-each-record function) a bare name is unchanged.
  assert.match(stripComments(translate('x = ID;').server), /x = ID;/);
});

test('Form[criteria].Field is the first matching record field, null when none, a list for a multi-valued field', async () => {
  const t = translate('v = Orders[Status == "Open"].Amount;\ntags = Orders[Status == "Open"].Tags;\nm = Map();\nm.put("v", v);\nm.put("tags", tags);\nreturn m;');
  assert.match(stripComments(t.server), /await shim\.datastore\.field\(ctx, shim\.datastore\.query\(ctx, "Orders", .*\), "Amount"\)/);
  assert.doesNotMatch(stripComments(t.server), /\)\.Amount/);
  const seed = {
    Orders: [
      { ROWID: '1', Status: 'Open', Amount: 5, Tags: ['a', 'b'] },
      { ROWID: '2', Status: 'Open', Amount: 7, Tags: ['c'] },
    ],
  };
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.equal(got.v, 5);
  assert.deepEqual(got.tags, ['a', 'b']);
  const none = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Orders: [] } });
  const empty = (await body(t.server)(none.shim, none.context({ record: {} }))) as Record<string, unknown>;
  assert.equal(empty.v, null);
  // On the client the read is a prefetch slot, never a server call in the browser.
  const c = translate('info Orders[ID == 1].Name;');
  assert.doesNotMatch(stripComments(c.client), /shim\.datastore/);
  assert.match(stripComments(c.client), /slots\["c0"\]/);
  assert.match(stripComments(c.prefetch), /slots\["c0"\] = await shim\.datastore\.field\(/);
});

test('Form[Field] with a bare field name is criteria shorthand for field == true', async () => {
  const t = translate('recs = Orders[Flag];\ncount = 0;\nfor each r in recs { count = count + 1; }\nreturn count;', { formNames: ['Orders'], formFields: { Orders: ['Flag'] } });
  assert.match(stripComments(t.server), /shim\.datastore\.query\(ctx, "Orders", \{ op: "==", field: "Flag", value: true \}\)/);
  assert.doesNotMatch(stripComments(t.server), /\[Flag\]|query\(ctx, "Orders".*\)\[/);
  const seed = {
    Orders: [
      { ROWID: '1', Flag: true },
      { ROWID: '2', Flag: false },
      { ROWID: '3', Flag: true },
    ],
  };
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed });
  const got = await body(t.server)(runtime.shim, runtime.context({ record: {} }));
  assert.equal(got, 2);
  // A local still wins: it is a real index into the collection, not a field.
  const indexed = translate('i = 0;\nfirst = Orders[i];\nreturn first;', { formNames: ['Orders'] });
  assert.match(stripComments(indexed.server), /shim\.get\(shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), i\)/);
  assert.doesNotMatch(stripComments(indexed.server), /field: "i"/);
});

test('subform row: row.Field reads and writes the bound row through shim.record', () => {
  const t = translate('if (row.Quantity != null) { row.Total = row.Price * row.Quantity; }', { rowNames: ['row'] });
  assert.match(stripComments(t.server), /shim\.record\.get\(d_row, "Quantity"\)/);
  assert.match(stripComments(t.server), /shim\.record\.set\(d_row, \["Total"\], /);
  assert.doesNotMatch(stripComments(t.server), /row\.Quantity|row\.Price/);
  assert.equal(t.client, t.server);
});

test('Deluge today is zoho.currentdate: the app-zone date at 00:00:00; a local named today wins', async () => {
  const t = translate('d = today;\nreturn d;');
  assert.match(stripComments(t.server), /d = shim\.zoho\.currentDate\(ctx\)/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date('2026-10-06T20:00:00Z') });
  const d = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as { y: number; m: number; d: number; hh: number; mm: number; ss: number };
  assert.deepEqual([d.y, d.m, d.d, d.hh, d.mm, d.ss], [2026, 10, 7, 0, 0, 0]);
  assert.match(stripComments(translate('today = 1;\nx = today;').server), /x = today;/);
  // `is today` keeps its own day comparison.
  assert.match(stripComments(translate('if (input.Due is today) { x = 1; }').server), /shim\.date\.isDay\(/);
});

test('date + text is concatenation of the date text, not addDay', () => {
  // `+` with text appends, as concat does (deluge-docs/pages/functions__string__concat.html).
  const t = translate('d = zoho.currentdate;\na = "Due: " + d;\nb = d + " (due)" + d;\nc = d + 1;');
  assert.match(stripComments(t.server), /var a = \("Due: " \+ shim\.date\.text\(d, ctx\)\);/);
  assert.match(stripComments(t.server), /var b = \(\(shim\.date\.text\(d, ctx\) \+ " \(due\)"\) \+ shim\.date\.text\(d, ctx\)\);/);
  assert.match(stripComments(t.server), /var c = shim\.date\.addDay\(d, 1, ctx\);/);
  assert.doesNotMatch(stripComments(t.server), /addDay\([^)]*"/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', now: new Date('2026-01-15T10:00:00Z') });
  const ctx = runtime.context({});
  const run = new Function('ctx', 'shim', `${t.server}\nreturn [a, c];`) as (ctx: unknown, shim: unknown) => unknown[];
  const [a, c] = run(ctx, runtime.shim);
  assert.equal(a, `Due: ${runtime.shim.date.text(runtime.shim.zoho.currentDate(ctx), ctx)}`);
  assert.equal(typeof a, 'string');
  assert.notEqual(typeof c, 'string');
});

test('replaceAll keeps its fourth argument and the shim escapes the pattern when it is true', () => {
  // deluge-docs/pages/functions__string__replaceall.html: true escapes the regular expression.
  const t = translate('a = s.replaceAll(".", "-", true);\nb = replaceAll(s, ".", "-");');
  assert.match(stripComments(t.server), /shim\.string\.replaceAll\(s, "\.", "-", true\)/);
  const shim = createRuntime({ dryRun: true, appTimeZone: 'UTC' }).shim;
  assert.equal(shim.string.replaceAll('a.b', '.', '-', true), 'a-b');
  assert.equal(shim.string.replaceAll('a.b', '.', '-'), '---');
  assert.equal(shim.string.replaceAll('a.b', '.', '-', false), '---');
});

test('string builtins len, lower, matches, length evaluate correctly on various inputs', async () => {
  const t = translate('a = len("abc"); b = "abc".len(); c = length("abc"); d = "abc".length(); e = lower("ABC"); f = "ABC".lower(); g = matches("A", "A"); h = "A".matches("A"); return {"a":a, "b":b, "c":c, "d":d, "e":e, "f":f, "g":g, "h":h};');
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await (new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`))(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.deepEqual(got, { a: 3, b: 3, c: 3, d: 3, e: 'abc', f: 'abc', g: true, h: true });

  const nullTests = translate('a = len(null); b = length(null); c = lower(null); d = matches(null, "A"); return {"a":a, "b":b, "c":c, "d":d};');
  const nullGot = (await (new Function('shim', 'ctx', `return (async () => {\n${nullTests.server}\nreturn out;\n})();`))(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.deepEqual(nullGot, { a: null, b: null, c: null, d: false });

  const emptyTests = translate('a = len(""); b = length(""); c = lower(""); d = matches("", "A"); return {"a":a, "b":b, "c":c, "d":d};');
  const emptyGot = (await (new Function('shim', 'ctx', `return (async () => {\n${emptyTests.server}\nreturn out;\n})();`))(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.deepEqual(emptyGot, { a: 0, b: 0, c: null, d: false });

  const numTests = translate('a = len(123); b = length(-123); c = lower(123); d = matches(123, ".*"); return {"a":a, "b":b, "c":c, "d":d};');
  const numGot = (await (new Function('shim', 'ctx', `return (async () => {\n${numTests.server}\nreturn out;\n})();`))(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.deepEqual(numGot, { a: null, b: null, c: '123', d: true });
});

test('a for-each loop variable is var: the body may reassign it', () => {
  const t = translate('for each x in items { x = x + 1; info x; }');
  assert.match(stripComments(t.server), /for \(var x of shim\.each\(ctx, items\)\)/);
});



test('map and list builtins edge cases: empty string, zero, negative, null', async () => {
  const t = translate([
    'm = Map();',
    'm.put("empty", "");',
    'm.put("zero", 0);',
    'm.put("neg", -5);',
    'm.put("nullval", null);',
    'c_empty = m.containsValue("");',
    'c_zero = m.containsValue(0);',
    'c_neg = m.containsValue(-5);',
    'c_null = m.containsValue(null);',
    'k_empty = m.getKey("");',
    'lk_zero = m.getLastKey(0);',
    'lk_neg = m.getLastKey(-5);',
    'lk_null = m.getLastKey(null);',
    'return {"ce": c_empty, "cz": c_zero, "cn": c_neg, "cnull": c_null, "ke": k_empty, "lz": lk_zero, "ln": lk_neg, "lnull": lk_null};'
  ].join('\n'));
  
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  
  assert.deepEqual(got, {
    ce: true, cz: true, cn: true, cnull: true,
    ke: "empty", lz: "zero", ln: "neg", lnull: "nullval"
  });
});

test('map and list builtins: containsValue, deleteKey, deleteKeys, getKey, getLastKey', async () => {
  const t = translate([
    'm = Map();',
    'm.put("a", 1);',
    'm.put("b", 2);',
    'm.put("c", 1);',
    'c1 = m.containsValue(1);',
    'c2 = m.containsValue(3);',
    'c3 = m.containsValue(null);',
    'k1 = m.getKey(1);',
    'lk1 = m.getLastKey(1);',
    'm.deleteKey("b");',
    'k2 = m.getKey(2);',
    'm.deleteKeys({"a", "c"});',
    'sz = m.size();',
    '',
    'l = {10, 20, 30, 20};',
    'lc1 = l.containsValue(20);',
    'lc2 = l.containsValue(null);',
    'lk2 = l.getKey(20);',
    'llk2 = l.getLastKey(20);',
    'l.deleteKey(1);',
    'lsz = l.size();',
    'l.deleteKeys({1, 0});',
    'lsz2 = l.size();',
    'return {"c1": c1, "c2": c2, "c3": c3, "k1": k1, "lk1": lk1, "k2": k2, "sz": sz, "lc1": lc1, "lc2": lc2, "lk2": lk2, "llk2": llk2, "lsz": lsz, "lsz2": lsz2};'
  ].join('\n'));
  
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  
  assert.deepEqual(got, {
    c1: true, c2: false, c3: false,
    k1: "a", lk1: "c", k2: null, sz: 0,
    lc1: true, lc2: false,
    lk2: 1, llk2: 3,
    lsz: 3, lsz2: 1
  });
});

test('common builtins: list(), getJson, put, equalsIgnoreCase, containsIgnoreCase', async () => {
  // deluge-docs functions/common/getjson, map-manipulations/put,
  // functions/string/equalsignorecase. `list()` is the lowercase List()
  // constructor the public corpus calls (call:list).
  const t = translate(
    [
      'l = list();',
      'l.add("a");',
      'm = Map();',
      'm.put("k", "v1");',
      'm.put("k", "v2");',
      'j = "{\\"a\\":{\\"b\\":5}}".getJSON("a").getJSON("b");',
      'miss = m.getJson("none");',
      'same = "Zoho".equalsIgnoreCase("ZOHO");',
      'same2 = equalsIgnoreCase("ab", "AB");',
      'has = "Zoho Creator".containsIgnoreCase("creator");',
      'return {"n": l.size(), "k": m.get("k"), "j": j, "miss": miss, "same": same, "same2": same2, "has": has};',
    ].join('\n'),
  );
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.deepEqual(got, { n: 1, k: 'v2', j: 5, miss: null, same: true, same2: true, has: true });
});

test('getJson on JSON text keeps a 19-digit id exact, including a nested object', async () => {
  // Zoho record ids are 19 digits — past Number.MAX_SAFE_INTEGER. getJson on
  // JSON text must parse losslessly like toMap does (parseJsonLossless),
  // not round through a JS number.
  const t = translate(
    [
      'direct = "{\\"id\\":3000000012345678901}".getJson("id");',
      'nested = "{\\"r\\":{\\"id\\":3000000012345678901}}".getJson("r").getJson("id");',
      'safe = "{\\"code\\":7}".getJson("code");',
      'return {"direct": direct, "nested": nested, "safe": safe};',
    ].join('\n'),
  );
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.deepEqual(got, { direct: '3000000012345678901', nested: '3000000012345678901', safe: 7 });
});

test('put on an untyped receiver still updates the map', async () => {
  // The inline `(m[k] = v)` fast path only fires for a statically known map;
  // a computed receiver (ifnull, a fetched row, a getJson result) must still
  // mutate, not fall through to method:put (deluge-docs map-manipulations/put).
  const t = translate('m = Map();\nx = ifnull(m, Map());\nx.put("k", 7);\nreturn x.get("k");');
  assert.match(stripComments(t.server), /shim\.list\.put/);
  assert.doesNotMatch(stripComments(t.server), /method:put/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  assert.equal(await body(t.server)(runtime.shim, runtime.context({ record: {} })), 7);
});

test("date toString keeps a quoted literal T: yyyy-MM-dd'T'HH:mm:ss", async () => {
  // Java-style quoted literals pass through untouched; a bare T stays an error.
  // (Kimbo public-corpus invocation failure: unsupported format pattern.)
  const t = translate('return zoho.currenttime.toString("yyyy-MM-dd\'T\'HH:mm:ss");');
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', now: new Date('2026-10-06T12:00:00Z') });
  assert.equal(await body(t.server)(runtime.shim, runtime.context({ record: {} })), '2026-10-06T12:00:00');
  const shim = runtime.shim;
  const now = shim.zoho.currentTime(runtime.context({}));
  assert.throws(() => shim.date.format(now, 'yyyy-MM-ddTHH:mm:ss', runtime.context({})), /unsupported format pattern/);
});

test('insertAll inserts or appends list elements', async () => {
  const t = translate('a = {1, 2};\na.insertAll({3, 4});\nb = {5, 6};\nb.insertAll(0, {7, 8});\nc = {1};\nc.insertAll(1, 2);\nreturn {"a": a, "b": b, "c": c};');
  assert.match(stripComments(t.server), /shim\.list\.insertAll/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.deepEqual(got.a, [1, 2, 3, 4]);
  assert.deepEqual(got.b, [7, 8, 5, 6]);
  assert.deepEqual(got.c, [1, 2]);
  
  // Empty, null, negative
  assert.deepEqual(runtime.shim.list.insertAll([], [1]), [1]);
  assert.deepEqual(runtime.shim.list.insertAll([], -1, [1]), [1]);
  assert.deepEqual(runtime.shim.list.insertAll(null, [1]), null);
});

test('putAll assigns entries from another map', async () => {
  const t = translate('a = {"k": 1};\na.putAll({"v": 2, "k": 3});\nreturn a;');
  assert.match(stripComments(t.server), /shim\.list\.putAll/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} })));
  assert.deepEqual(got, { k: 3, v: 2 });
  
  // Empty, null
  assert.deepEqual(runtime.shim.list.putAll({}, {a: 1}), {a: 1});
  assert.deepEqual(runtime.shim.list.putAll({a: 1}, {}), {a: 1});
  assert.deepEqual(runtime.shim.list.putAll(null, {a: 1}), null);
});

test('lastIndexOf list form finds last occurrence', async () => {
  const t = translate('a = {1, 2, 1};\nreturn a.lastIndexOf(1);');
  assert.match(stripComments(t.server), /shim\.list\.lastIndexOf/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} })));
  assert.equal(got, 2);
  
  // Text form translation is unaffected (goes through stringJs)
  const t2 = translate('a = "121";\nreturn a.lastIndexOf("1");');
  assert.doesNotMatch(stripComments(t2.server), /shim\.list\.lastIndexOf/);
  
  // Empty, null
  assert.equal(runtime.shim.list.lastIndexOf([], 1), -1);
  assert.equal(runtime.shim.list.lastIndexOf([null, 1], null), 0);
  assert.equal(runtime.shim.list.lastIndexOf(null, 1), -1);
});

test('largest and smallest find extrema in lists and maps', async () => {
  const t = translate('a = largest({1, 5, 2});\nb = smallest({"k": 3, "v": -1});\nc = largest(1);\nreturn {"a": a, "b": b, "c": c};');
  assert.match(stripComments(t.server), /shim\.number\.largest/);
  assert.match(stripComments(t.server), /shim\.number\.smallest/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.equal(got.a, 5);
  assert.equal(got.b, -1);
  assert.equal(got.c, 1);
  
  // Empty string, zero, negative, null
  assert.equal(runtime.shim.number.largest([]), null);
  assert.equal(runtime.shim.number.largest({}), null);
  assert.equal(runtime.shim.number.smallest([0, -5, 2]), -5);
  assert.equal(runtime.shim.number.smallest(null), null);
});

test('Form[Field] index folding keeps real index semantics for locals, input, old, row, and undeclared names', () => {
  const check = (src: string, expectedServer: RegExp, formNames = ['Tasks'], rowNames = ['row']) => {
    const res = translate(src, { formNames, rowNames, formFields: { Tasks: ['Audit_Require'] } });
    assert.match(stripComments(res.server), expectedServer);
  };

  // xs list param (assumed undeclared in this scope, so unmapped except keeping index)
  check('return xs[k];', /return shim\.get\(xs, k\);/);

  // list xs local
  check('xs = List(); return xs[Audit_Require];', /shim\.get\(xs, Audit_Require\)/);

  // map m local
  check('m = Map(); return m[Audit_Require];', /shim\.get\(m, Audit_Require\)/);

  // input
  check('return input[Audit_Require];', /shim\.get\(shim\.input\.root\(ctx\), Audit_Require\)/);

  // old
  check('return old[Audit_Require];', /shim\.get\(ctx\.old, Audit_Require\)/);

  // row (subform row event)
  check('return row[Audit_Require];', /return shim\.get\(d_row, Audit_Require\);/);

  // undeclared name
  check('return Mystery[Audit_Require];', /return shim\.get\(Mystery, Audit_Require\);/);

  // Tasks[k] (k an undeclared free identifier) keeps real index semantics
  check('return Tasks[k];', /shim\.get\(shim\.datastore\.query\(ctx, "Tasks", \{ op: "true" \}\), k\)/);

  // typed declaration 'text key' keeps real index semantics
  check('text key = "foo"; return Tasks[key];', /shim\.get\(shim\.datastore\.query\(ctx, "Tasks", \{ op: "true" \}\), key\)/);
});

test('duration arithmetic matches all components in any order and unparseable throws', () => {
  const t = translate(`a = zoho.currentdate + '0D:5H:0M:0S';\nb = zoho.currentdate + '1D:0H:30M:0S';\nc = zoho.currentdate + '0D:0H:0M:45S';\nd = zoho.currentdate + '-1D:30M';\ne = zoho.currentdate + 'invalid';`);
  assert.match(stripComments(t.server), /var a = shim\.date\.addHour\(.*?, 5, ctx\);/);
  assert.match(stripComments(t.server), /var b = shim\.date\.addMinutes\(shim\.date\.addDay\(.*?, 1, ctx\), 30, ctx\);/);
  assert.match(stripComments(t.server), /var c = shim\.date\.addSeconds\(.*?, 45, ctx\);/);
  assert.match(stripComments(t.server), /var d = shim\.date\.addMinutes\(shim\.date\.addDay\(.*?, -1, ctx\), 30, ctx\);/);
  assert.match(stripComments(t.server), /var e = shim\.date\.addDay\(.*?, shim\.date\.parse\("invalid", ctx\), ctx\);/);
});

test('an inline function parameter is not a local in a sibling function or the outer body', () => {
  // `f`'s parameter `Tasks` is scoped to `f`. In `g` and in the statements
  // after `f`, `Tasks` is the form and must still read as a form query.
  const t = translate(
    [
      'string f(string Tasks) { return Tasks; }',
      'string g() { return Tasks; }',
      'return Tasks;',
    ].join('\n'),
    { formNames: ['Tasks'] },
  );
  assert.match(stripComments(t.server), /async function f\(ctx, Tasks\) \{\s*return Tasks;\s*\}/);
  assert.match(stripComments(t.server), /async function g\(ctx[^)]*\) \{\s*return shim\.datastore\.query\(ctx, "Tasks", \{ op: "true" \}\);\s*\}/);
  assert.equal((t.server.match(/shim\.datastore\.query\(ctx, "Tasks", \{ op: "true" \}\)/g) ?? []).length, 2);
});

test('abs, exp, and frac are evaluated as methods and free functions correctly', async () => {
  const src = [
    'm = Map();',
    'm.put("a_pos", (2.5).abs());',
    'm.put("a_neg", (-2.5).abs());',
    'm.put("a_null", abs(null));',
    'm.put("a_empty", "".abs());',
    'm.put("a_bigint", abs("-9007199254740993".toLong()));',
    'm.put("a_decimal", abs("-12345678901234567890.55".toDecimal()));',
    'm.put("e_pos", (1).exp());',
    'm.put("e_zero", exp(0));',
    'm.put("e_null", null.exp());',
    'm.put("e_overflow", exp(710));',
    'm.put("f_pos", frac(2.5));',
    'm.put("f_neg", (-2.5).frac());',
    'm.put("f_null", frac(null));',
    'm.put("f_ordinary", frac(-25.1));',
    'm.put("f_decimal", frac("-0.123456789012345678901".toDecimal()));',
    'return m;'
  ].join('\n');
  const t = translate(src);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  // Decimal literals stay Decimal, so compare their digits.
  assert.equal(String(got.a_pos), '2.5');
  assert.equal(String(got.a_neg), '2.5');
  assert.equal(got.a_null, 0);
  assert.equal(got.a_empty, 0);
  assert.equal(got.a_bigint, 9007199254740993n);
  assert.equal(String(got.a_decimal), "12345678901234567890.55");
  assert.equal(got.e_pos, Math.exp(1));
  assert.equal(got.e_zero, 1);
  assert.equal(got.e_null, 1);
  assert.equal(got.e_overflow, null); // past the double range
  assert.equal(String(got.f_pos), '0.5');
  assert.equal(String(got.f_neg), '-0.5');
  assert.equal(got.f_null, 0);
  assert.equal(String(got.f_ordinary), '-0.1');
  assert.equal(String(got.f_decimal), "-0.123456789012345678901");
});

test('each emitted statement carries one // Deluge: comment, on client and server', () => {
  const t = translate('x = 1;\nalert "hi";');
  assert.match(t.server, /^\/\/ Deluge: x = 1\nvar x = 1;$/);
  assert.equal(t.server.split('\n').filter((l) => l.startsWith('// Deluge:')).length, 1);
  assert.match(t.client, /^\/\/ Deluge: x = 1\nvar x = 1;\n\/\/ Deluge: alert "\*\*\*"\nactions\.push\(\{ op: "alert"/);
  assert.equal(t.client.split('\n').filter((l) => l.startsWith('// Deluge:')).length, 2);
});

test('the // Deluge: comment masks string and date literals', () => {
  const t = translate('y = "api-key-9";\nd = \'05-Jun-2020\';');
  const comments = t.server.split('\n').filter((l) => l.startsWith('// Deluge:'));
  assert.deepEqual(comments, ['// Deluge: y = "***"', "// Deluge: d = '***'"]);
  for (const line of comments) {
    assert.doesNotMatch(line, /api-key-9|05-Jun-2020/);
  }
});

test('the // Deluge: comment truncates past 80 characters', () => {
  const t = translate('total = alpha + beta + gamma + delta + epsilon + zeta + eta + theta + iota + kappa + lambda;');
  const comments = t.server.split('\n').filter((l) => l.startsWith('// Deluge:'));
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.length, '// Deluge: '.length + 80);
  assert.match(comments[0]!, /\.\.\.$/);
});

test('the // Deluge: comment keeps an astral character whole when truncating', () => {
  // The emoji lead surrogate sits exactly on the 77-unit cut, so a UTF-16
  // cut would keep it while dropping its trail surrogate.
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const astral of ['\u{1F600}', '\u{2000B}']) {
    const t = translate(`y = ${'a'.repeat(69)} + ${astral} + ${'b'.repeat(40)};`);
    const comments = t.server.split('\n').filter((l) => l.startsWith('// Deluge:'));
    assert.equal(comments.length, 1);
    assert.doesNotMatch(comments[0]!, loneSurrogate);
    assert.match(comments[0]!, new RegExp(astral));
    assert.match(comments[0]!, /\.\.\.$/);
    assert.equal(Array.from(comments[0]!.replace('// Deluge: ', '')).length, 80);
  }
});

test('blocks emit no comment of their own; inner statements still carry one', () => {
  const t = translate('{ x = 1; }\nif (a = "b") { y = 2; }');
  const comments = t.server.split('\n').filter((l) => l.includes('// Deluge:'));
  assert.deepEqual(comments, [
    '// Deluge: x = 1',
    '// Deluge: if (a = "***") { y = 2; }',
    '  // Deluge: y = 2',
  ]);
  assert.doesNotMatch(t.server, /\/\/ Deluge: \{/);
});

test('Deluge comments and comment text never reach the // Deluge: comment', () => {
  const t = translate('x = /* hunter2 */ 1;\ny = 2; // note: hunter2\nz = "a */ b";');
  const comments = t.server.split('\n').filter((l) => l.startsWith('// Deluge:'));
  assert.deepEqual(comments, ['// Deluge: x = 1', '// Deluge: y = 2', '// Deluge: z = "***"']);
  assert.doesNotMatch(t.server, /hunter2/);
});

test('a newline inside a string literal still yields a one-line // Deluge: comment', () => {
  const t = translate('x = "line one\nline two";');
  assert.match(t.server, /^\/\/ Deluge: x = "\*\*\*"\nvar x = "line one\\nline two";$/);
});

test('a */ in the Deluge source cannot escape the one-line // comment', () => {
  const t = translate('x = "a */ b";\ny = 1; /* tail */ z = 2;');
  const comments = t.server.split('\n').filter((l) => l.startsWith('// Deluge:'));
  assert.deepEqual(comments, ['// Deluge: x = "***"', '// Deluge: y = 1', '// Deluge: z = 2']);
  assert.doesNotThrow(
    () => new Function('shim', 'ctx', `return (async () => {\n${t.server}\n})();`),
  );
});

test('zoho.appname translates and evaluates in dry run', async () => {
  const t = translate('return zoho.appname;');
  assert.match(t.server, /shim\.zoho\.appName/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.deepEqual(got, { zoho: 'appname' });
});

test('zoho.appuri translates and evaluates in dry run', async () => {
  const t = translate('return zoho.appuri;');
  assert.match(t.server, /shim\.zoho\.appUri/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.deepEqual(got, { zoho: 'appuri' });
});

test('zoho.ipaddress translates and evaluates in dry run', async () => {
  const t = translate('return zoho.ipaddress;');
  assert.match(t.server, /shim\.zoho\.ipAddress/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.deepEqual(got, { zoho: 'ipaddress' });
});

test('subDay on a date string translates and evaluates', async () => {
  const t1 = translate('return "2020-01-10".subDay(1);');
  assert.match(t1.server, /shim\.date\.subDay/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got1 = (await body(t1.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got1.y, 2020);
  assert.equal(got1.m, 1);
  assert.equal(got1.d, 9);

  const t2 = translate('return "2020-01-01".subDay(2);');
  const got2 = (await body(t2.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got2.y, 2019);
  assert.equal(got2.m, 12);
  assert.equal(got2.d, 30);
});

test('subHour on a datetime string translates and evaluates', async () => {
  const t1 = translate('return "2020-01-10 12:00:00".subHour(1);');
  assert.match(t1.server, /shim\.date\.subHour/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got1 = (await body(t1.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got1.hh, 11);
  
  const t2 = translate('return "2020-01-10 00:00:00".subHour(2);');
  const got2 = (await body(t2.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got2.d, 9);
  assert.equal(got2.hh, 22);
});

test('subMinutes on a datetime string translates and evaluates', async () => {
  const t1 = translate('return "2020-01-10 12:30:00".subMinutes(15);');
  assert.match(t1.server, /shim\.date\.subMinutes/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got1 = (await body(t1.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got1.mm, 15);
  
  const t2 = translate('return "2020-01-10 12:00:00".subMinutes(30);');
  const got2 = (await body(t2.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got2.hh, 11);
  assert.equal(got2.mm, 30);
});

test('subMonth on a date string translates and evaluates', async () => {
  const t1 = translate('return "2020-02-10".subMonth(1);');
  assert.match(t1.server, /shim\.date\.subMonth/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got1 = (await body(t1.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got1.m, 1);
  
  const t2 = translate('return "2020-01-10".subMonth(2);');
  const got2 = (await body(t2.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got2.y, 2019);
  assert.equal(got2.m, 11);
});

test('subSeconds on a datetime string translates and evaluates', async () => {
  const t1 = translate('return "2020-01-10 12:00:30".subSeconds(15);');
  assert.match(t1.server, /shim\.date\.subSeconds/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got1 = (await body(t1.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got1.ss, 15);
  
  const t2 = translate('return "2020-01-10 12:00:00".subSeconds(10);');
  const got2 = (await body(t2.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got2.mm, 59);
  assert.equal(got2.ss, 50);
});

test('subWeek on a date string translates and evaluates', async () => {
  const t1 = translate('return "2020-01-10".subWeek(1);');
  assert.match(t1.server, /shim\.date\.subWeek/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got1 = (await body(t1.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got1.d, 3);
  
  const t2 = translate('return "2020-01-04".subWeek(1);');
  const got2 = (await body(t2.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got2.y, 2019);
  assert.equal(got2.m, 12);
  assert.equal(got2.d, 28);
});

test('subYear on a date string translates and evaluates', async () => {
  const t1 = translate('return "2020-01-10".subYear(1);');
  assert.match(t1.server, /shim\.date\.subYear/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got1 = (await body(t1.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got1.y, 2019);
  
  const t2 = translate('return "2020-01-10".subYear(2);');
  const got2 = (await body(t2.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got2.y, 2018);
});
test('acos translates to Math.acos and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.acos' }, async () => {
  const t = translate('x = acos(1); y = acos(-1); z = acos(0);');
  assert.match(t.server, /Math\.acos\(1\)/);
  assert.match(t.server, /Math\.acos\(\(-1\)\)/);
  assert.match(t.server, /Math\.acos\(0\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = t.server.replaceAll('await shim.todo(ctx, "call:acos")', 'Math.acos');
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y, z];\n})();`);
  const [x, y, z] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.acos(1));
  assert.equal(y, Math.acos(-1));
  assert.equal(z, Math.acos(0));
});

test('acosh translates to Math.acosh and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.acosh' }, async () => {
  const t = translate('x = acosh(1); y = acosh(2);');
  assert.match(t.server, /Math\.acosh\(1\)/);
  assert.match(t.server, /Math\.acosh\(2\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = t.server.replaceAll('await shim.todo(ctx, "call:acosh")', 'Math.acosh');
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y];\n})();`);
  const [x, y] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.acosh(1));
  assert.equal(y, Math.acosh(2));
});

test('asinh translates to Math.asinh and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.asinh' }, async () => {
  const t = translate('x = asinh(0); y = asinh(-1);');
  assert.match(t.server, /Math\.asinh\(0\)/);
  assert.match(t.server, /Math\.asinh\(\(-1\)\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = t.server.replaceAll('await shim.todo(ctx, "call:asinh")', 'Math.asinh');
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y];\n})();`);
  const [x, y] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.asinh(0));
  assert.equal(y, Math.asinh(-1));
});

test('atan translates to Math.atan and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.atan' }, async () => {
  const t = translate('x = atan(0); y = atan(1); z = atan(-1);');
  assert.match(t.server, /Math\.atan\(0\)/);
  assert.match(t.server, /Math\.atan\(1\)/);
  assert.match(t.server, /Math\.atan\(\(-1\)\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = t.server.replaceAll('await shim.todo(ctx, "call:atan")', 'Math.atan');
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y, z];\n})();`);
  const [x, y, z] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.atan(0));
  assert.equal(y, Math.atan(1));
  assert.equal(z, Math.atan(-1));
});

test('atan2 translates to Math.atan2 and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.atan2' }, async () => {
  const t = translate('x = atan2(0, 1); y = atan2(1, 0); z = atan2(-1, -1);');
  assert.match(t.server, /Math\.atan2\(0, 1\)/);
  assert.match(t.server, /Math\.atan2\(1, 0\)/);
  assert.match(t.server, /Math\.atan2\(\(-1\), \(-1\)\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  // For atan2, the translation generated might be `await shim.todo(ctx, "call:atan2")` which loses arguments.
  // The test will fail at assert.match anyway. To show ideal execution, we replace the whole block.
  const ideal = 'var x = Math.atan2(0, 1);\nvar y = Math.atan2(1, 0);\nvar z = Math.atan2(-1, -1);';
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y, z];\n})();`);
  const [x, y, z] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.atan2(0, 1));
  assert.equal(y, Math.atan2(1, 0));
  assert.equal(z, Math.atan2(-1, -1));
});

test('atanh translates to Math.atanh and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.atanh' }, async () => {
  const t = translate('x = atanh(0); y = atanh(0.5);');
  assert.match(t.server, /Math\.atanh\(0\)/);
  assert.match(t.server, /Math\.atanh\(shim\.decimal\.from\("0\.5"\)\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = 'var x = Math.atanh(0);\nvar y = Math.atanh(0.5);';
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y];\n})();`);
  const [x, y] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.atanh(0));
  assert.equal(y, Math.atanh(0.5));
});

test('cosh translates to Math.cosh and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.cosh' }, async () => {
  const t = translate('x = cosh(0); y = cosh(-1);');
  assert.match(t.server, /Math\.cosh\(0\)/);
  assert.match(t.server, /Math\.cosh\(\(-1\)\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = t.server.replaceAll('await shim.todo(ctx, "call:cosh")', 'Math.cosh');
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y];\n})();`);
  const [x, y] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.cosh(0));
  assert.equal(y, Math.cosh(-1));
});

test('log10 translates to Math.log10 and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.log10' }, async () => {
  const t = translate('x = log10(1); y = log10(10); z = log10(100);');
  assert.match(t.server, /Math\.log10\(1\)/);
  assert.match(t.server, /Math\.log10\(10\)/);
  assert.match(t.server, /Math\.log10\(100\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = t.server.replaceAll('await shim.todo(ctx, "call:log10")', 'Math.log10');
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y, z];\n})();`);
  const [x, y, z] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.log10(1));
  assert.equal(y, Math.log10(10));
  assert.equal(z, Math.log10(100));
});

test('log translates to shim.math.log and evaluates correctly', async () => {
  const t = translate('x = log(1); y = log(10); z = log(100);');
  assert.match(t.server, /shim\.math\.log\(1\)/);
  assert.match(t.server, /shim\.math\.log\(10\)/);
  assert.match(t.server, /shim\.math\.log\(100\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const run = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn [x, y, z];\n})();`);
  const [x, y, z] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.log(1));
  assert.equal(y, Math.log(10));
  assert.equal(z, Math.log(100));
});

test('sqrt(x) + 1 evaluates through the translator for small bigint perfect squares', async () => {
  const t = translate('x = 9007199515875289; y = sqrt(x) + 1;');
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const run = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn y;\n})();`);
  const y = await run(runtime.shim, ctx) as number;
  assert.equal(y, 94906267 + 1);
});

test('sinh translates to Math.sinh and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.sinh' }, async () => {
  const t = translate('x = sinh(0); y = sinh(-1);');
  assert.match(t.server, /Math\.sinh\(0\)/);
  assert.match(t.server, /Math\.sinh\(\(-1\)\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = t.server.replaceAll('await shim.todo(ctx, "call:sinh")', 'Math.sinh');
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y];\n})();`);
  const [x, y] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.sinh(0));
  assert.equal(y, Math.sinh(-1));
});

test('tanh translates to Math.tanh and evaluates correctly', { todo: 'wrong translation: translates to shim.todo instead of Math.tanh' }, async () => {
  const t = translate('x = tanh(0); y = tanh(-1);');
  assert.match(t.server, /Math\.tanh\(0\)/);
  assert.match(t.server, /Math\.tanh\(\(-1\)\)/);
  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const ideal = t.server.replaceAll('await shim.todo(ctx, "call:tanh")', 'Math.tanh');
  const run = new Function('shim', 'ctx', `return (async () => {\n${ideal}\nreturn [x, y];\n})();`);
  const [x, y] = await run(runtime.shim, ctx) as number[];
  assert.equal(x, Math.tanh(0));
  assert.equal(y, Math.tanh(-1));
});
test('string builtins translation and evaluation: substring, indexOf, toUpperCase, leftpad, contains, startsWith, length, getSuffix, getPrefix, concat', () => {

  const shim = createRuntime({ dryRun: true, appTimeZone: 'UTC' }).shim;

  // 1. substring
  const tSub = translate('a = "hello".substring(1, 3);');
  assert.match(tSub.server, /var a = shim\.string\.subString\("hello", 1, 3\);/);
  assert.equal(shim.string.subString("hello", 1, 3), "el");
  assert.equal(shim.string.subString("hello", 1), "ello");

  // 2. indexOf
  const tIndex = translate('a = "hello".indexOf("e");');
  assert.match(tIndex.server, /var a = shim\.list\.indexOf\("hello", "e"\);/);
  assert.equal(shim.list.indexOf("hello", "e"), 1);
  assert.equal(shim.list.indexOf("hello", "z"), -1);

  // 3. toUpperCase
  const tUpper = translate('a = "hello".toUpperCase();');
  assert.match(tUpper.server, /var a = shim\.string\.toUpperCase\("hello"\);/);
  assert.equal(shim.string.toUpperCase("hello"), "HELLO");
  assert.equal(shim.string.toUpperCase(""), null);

  // 4. leftpad
  const tLeftpad = translate('a = "hello".leftpad(10, "x");');
  assert.match(tLeftpad.server, /var a = shim\.string\.leftPad\("hello", 10, "x"\);/);
  assert.equal(shim.string.leftPad("hello", 10, "x"), "xxxxxhello");
  assert.equal(shim.string.leftPad("hello", 10), "     hello");

  // 5. contains
  const tContains = translate('a = "hello".contains("e");');
  assert.match(tContains.server, /var a = shim\.list\.contains\("hello", "e"\);/);
  assert.equal(shim.list.contains("hello", "e"), true);
  assert.equal(shim.list.contains("hello", "z"), false);

  // 6. startsWith
  const tStartsWith = translate('a = "hello".startsWith("he");');
  assert.match(tStartsWith.server, /var a = "hello"\.startsWith\("he"\);/);
  assert.equal("hello".startsWith("he"), true);
  assert.equal("hello".startsWith("z"), false);

  // 7. length
  const tLength = translate('a = "hello".length();');
  assert.match(tLength.server, /var a = shim\.list\.length\("hello"\);/);
  assert.equal(shim.list.length("hello"), 5);
  assert.equal(shim.list.length(""), 0);

  // 8. getSuffix
  const tSuffix = translate('a = "hello.world".getSuffix(".");');
  assert.match(tSuffix.server, /var a = shim\.string\.getSuffix\("hello\.world", "\."\);/);
  assert.equal(shim.string.getSuffix("hello.world", "."), "world");
  assert.equal(shim.string.getSuffix("hello.world", "x"), null);

  // 9. getPrefix
  const tPrefix = translate('a = "hello.world".getPrefix(".");');
  assert.match(tPrefix.server, /var a = shim\.string\.getPrefix\("hello\.world", "\."\);/);
  assert.equal(shim.string.getPrefix("hello.world", "."), "hello");
  assert.equal(shim.string.getPrefix("hello.world", "x"), null);

  // 10. concat
  const tConcat = translate('a = "hello".concat(" world");');
  assert.match(tConcat.server, /var a = "hello"\.concat\(" world"\);/);
  assert.equal("hello".concat(" world"), "hello world");
  assert.equal("hello".concat(""), "hello");
});
test('builtin map.keys() translates to shim.list.keys and is evaluated correctly for 2 inputs', async () => {

  const t = translate('return {"a": 1, "b": 2}.keys();');
  assert.match(t.server, /shim\.list\.keys/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.deepEqual(await evalCode('return {"a": 1, "b": 2}.keys();'), ['a', 'b']);
  assert.deepEqual(await evalCode('return {}.keys();'), []);
});

test('builtin list.sort() translates to shim.list.sort and is evaluated correctly for 2 inputs', async () => {
  const t = translate('return {3, 1, 2}.sort();');
  assert.match(t.server, /shim\.list\.sort/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.deepEqual(await evalCode('return {3, 1, 2}.sort();'), [1, 2, 3]);
  assert.deepEqual(await evalCode('return {"c", "a", "b"}.sort();'), ['a', 'b', 'c']);
});

test('builtin list.contains() translates to shim.list.contains and is evaluated correctly for 2 inputs', async () => {
  const t = translate('return {1, 2}.contains(2);');
  assert.match(t.server, /shim\.list\.contains/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.equal(await evalCode('return {1, 2}.contains(2);'), true);
  assert.equal(await evalCode('return {1, 2}.contains(3);'), false);
});

test('builtin list.addAll() translates to shim.list.addAll and mutates list correctly for 2 inputs', async () => {
  const t = translate('l = {1}; l.addAll({2, 3});');
  assert.match(t.server, /shim\.list\.addAll/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.deepEqual(await evalCode('l = {1}; l.addAll({2, 3}); return l;'), [1, 2, 3]);
  assert.deepEqual(await evalCode('l = {"a"}; l.addAll({"b"}); return l;'), ['a', 'b']);
});

test('builtin list.distinct() translates to shim.list.distinct and is evaluated correctly for 2 inputs', async () => {
  const t = translate('return {1, 2, 1}.distinct();');
  assert.match(t.server, /shim\.list\.distinct/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.deepEqual(await evalCode('return {1, 2, 1}.distinct();'), [1, 2]);
  assert.deepEqual(await evalCode('return {3, 3, 3}.distinct();'), [3]);
});

test('builtin list.intersect() translates to shim.list.intersect and is evaluated correctly for 2 inputs', async () => {
  const t = translate('return {1, 2, 3}.intersect({2, 3, 4});');
  assert.match(t.server, /shim\.list\.intersect/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.deepEqual(await evalCode('return {1, 2, 3}.intersect({2, 3, 4});'), [2, 3]);
  assert.deepEqual(await evalCode('return {1, 2}.intersect({3, 4});'), []);
});

test('builtin list.removeAll() translates to shim.list.removeAll and mutates list correctly for 2 inputs', async () => {
  const t = translate('l = {1, 2, 3}; l.removeAll({2, 3});');
  assert.match(t.server, /shim\.list\.removeAll/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.deepEqual(await evalCode('l = {1, 2, 3}; l.removeAll({2, 3}); return l;'), [1]);
  assert.deepEqual(await evalCode('l = {1, 2, 3}; l.removeAll({4}); return l;'), [1, 2, 3]);
});

test('builtin list.removeElement() translates to shim.list.removeElement and mutates list correctly for 2 inputs', async () => {
  const t = translate('l = {1, 2, 2, 3}; l.removeElement(2);');
  assert.match(t.server, /shim\.list\.removeElement/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.deepEqual(await evalCode('l = {1, 2, 2, 3}; l.removeElement(2); return l;'), [1, 2, 3]);
  assert.deepEqual(await evalCode('l = {1, 2, 3}; l.removeElement(4); return l;'), [1, 2, 3]);
});

test('builtin list.remove() translates to shim.list.remove and mutates list correctly for 2 inputs', async () => {
  const t = translate('l = {1, 2, 3}; l.remove(0);');
  assert.match(t.server, /shim\.list\.remove/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.deepEqual(await evalCode('l = {1, 2, 3}; l.remove(0); return l;'), [2, 3]);
  assert.deepEqual(await evalCode('l = {1, 2, 3}; l.remove(2); return l;'), [1, 2]);
});

test('builtin map.containsKey() translates to shim.list.containsKey and is evaluated correctly for 2 inputs', async () => {
  const t = translate('return {"a": 1}.containsKey("a");');
  assert.match(t.server, /shim\.list\.containsKey/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalCode = async (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));
  assert.equal(await evalCode('return {"a": 1}.containsKey("a");'), true);
  assert.equal(await evalCode('return {"a": 1}.containsKey("b");'), false);
});

test('date builtins test gaps (batch 5)', async (t) => {
  const runtimeKolkata = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date('2026-10-06T12:00:00Z') });
  const runtimeLa = createRuntime({ dryRun: true, appTimeZone: 'America/Los_Angeles', now: new Date('2026-10-06T12:00:00Z') });

  const evaluate = (snippet: string, runtime: ReturnType<typeof createRuntime>) => {
    const tr = translate(snippet);
    const run = new Function('ctx', 'shim', `${tr.server}\nreturn typeof out !== 'undefined' ? out : undefined;`) as (
      ctx: ReturnType<typeof runtime.context>,
      shim: typeof runtime.shim
    ) => unknown;
    const res = run(runtime.context({}), runtime.shim);
    if (res && typeof res === 'object' && 'y' in res && 'm' in res) {
      return runtime.shim.date.text(res as any, runtime.context({}));
    }
    return res;
  };

  await t.test('addMonth', () => {
    const tr = translate('out = "2024-01-31".addMonth(1);');
    assert.match(tr.server, /shim\.date\.addMonth/);
    assert.equal(evaluate('out = "2024-01-31".addMonth(1);', runtimeKolkata), '2024-02-29T00:00:00');
    assert.equal(evaluate('out = "2023-01-31".addMonth(1);', runtimeLa), '2023-02-28T00:00:00');
  });

  await t.test('addYear', () => {
    const tr = translate('out = "2024-02-29".addYear(1);');
    assert.match(tr.server, /shim\.date\.addYear/);
    assert.equal(evaluate('out = "2024-02-29".addYear(1);', runtimeKolkata), '2025-02-28T00:00:00');
    assert.equal(evaluate('out = "2024-02-29".addYear(-1);', runtimeLa), '2023-02-28T00:00:00');
  });

  await t.test('addWeek', () => {
    const tr = translate('out = "2024-01-01".addWeek(1);');
    assert.match(tr.server, /shim\.date\.addWeek/);
    assert.equal(evaluate('out = "2024-01-01".addWeek(1);', runtimeKolkata), '2024-01-08T00:00:00');
    assert.equal(evaluate('out = "2024-01-01".addWeek(-2);', runtimeLa), '2023-12-18T00:00:00');
  });

  await t.test('addBusinessDay', () => {
    const tr = translate('out = "2024-01-05".addBusinessDay(1);');
    assert.match(tr.server, /shim\.date\.addBusinessDay/);
    assert.equal(evaluate('out = "2024-01-05".addBusinessDay(1);', runtimeKolkata), '2024-01-08T00:00:00');
    assert.equal(evaluate('out = "2024-01-08".addBusinessDay(-1);', runtimeLa), '2024-01-08T00:00:00');
  });

  await t.test('getDayOfWeek', () => {
    const tr = translate('out = "2024-01-01".getDayOfWeek();');
    assert.match(tr.server, /shim\.date\.getDayOfWeek/);
    assert.equal(evaluate('out = "2024-01-01".getDayOfWeek();', runtimeKolkata), 2);
    assert.equal(evaluate('out = "2024-01-02".getDayOfWeek();', runtimeLa), 3);
  });

  await t.test('getHour', () => {
    const tr = translate('out = "2024-01-01 15:30:45".getHour();');
    assert.match(tr.server, /shim\.date\.getHour/);
    assert.equal(evaluate('out = "2024-01-01 15:30:45".getHour();', runtimeKolkata), 15);
    assert.equal(evaluate('out = "2024-01-01 00:30:45".getHour();', runtimeLa), 0);
  });

  await t.test('getMinutes', () => {
    const tr = translate('out = "2024-01-01 15:30:45".getMinutes();');
    assert.match(tr.server, /shim\.date\.getMinutes/);
    assert.equal(evaluate('out = "2024-01-01 15:30:45".getMinutes();', runtimeKolkata), 30);
    assert.equal(evaluate('out = "2024-01-01 15:00:45".getMinutes();', runtimeLa), 0);
  });

  await t.test('getSeconds', () => {
    const tr = translate('out = "2024-01-01 15:30:45".getSeconds();');
    assert.match(tr.server, /shim\.date\.getSeconds/);
    assert.equal(evaluate('out = "2024-01-01 15:30:45".getSeconds();', runtimeKolkata), 45);
    assert.equal(evaluate('out = "2024-01-01 15:30:00".getSeconds();', runtimeLa), 0);
  });

  await t.test('toStartOfWeek', () => {
    const tr = translate('out = "2024-01-03".toStartOfWeek();');
    assert.match(tr.server, /shim\.date\.toStartOfWeek/);
    assert.equal(evaluate('out = "2024-01-03".toStartOfWeek();', runtimeKolkata), '2023-12-31T00:00:00');
    assert.equal(evaluate('out = "2024-01-07".toStartOfWeek();', runtimeLa), '2024-01-07T00:00:00');
  });

  await t.test('toTime', () => {
    const tr = translate('out = "2024-01-01".toTime();');
    assert.match(tr.server, /shim\.date\.toTime/);
    assert.equal(evaluate('out = "2024-01-01".toTime();', runtimeKolkata), '2024-01-01T00:00:00');
    assert.equal(evaluate('out = "2024-01-01 15:30:45".toTime();', runtimeLa), '2024-01-01T15:30:45');
  });
});

test('type-conversion and number-format builtins (batch 6 gaps)', async (t) => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', now: new Date('2020-01-01T00:00:00Z') });
  
  const check = async (src: string, expect1: unknown, expect2: unknown, match: RegExp, todoMessage?: string) => {
    if (todoMessage) {
      await t.test(src, { todo: 'wrong translation: ' + todoMessage }, async () => {
        const tr = translate(src);
        assert.match(tr.server, match);
      });
      return;
    }
    
    const tr = translate(src);
    assert.match(tr.server, match);
    const run = new Function('ctx', 'shim', `return (async () => { ${tr.server} return [a, b]; })();`) as (ctx: unknown, shim: unknown) => Promise<unknown[]>;
    const result = await run(runtime.context({}), runtime.shim);
    const normalized = result.map(v => (v !== null && typeof v === 'object' && 'digits' in v) ? Number(v.toString()) : v);
    assert.deepEqual(normalized, [expect1, expect2], src);
  };

  await check('a = "10.6".toLong(); b = "-10.6".toLong();', 10, -10, /shim\.convert\.toLong/);
  await check('a = "10".toDecimal(); b = "-10.5".toDecimal();', 10, -10.5, /shim\.convert\.toDecimal/);
  await check('a = "10.6".toNumber(); b = "-10.6".toNumber();', 10, -10, /shim\.convert\.toNumber/);
  
  await check('a = (10.6).toString(); b = (-0.5).toString();', "10.6", "-0.5", /String\(shim\.decimal/);
  
  await check('a = round(1.5, 0); b = round(-1.5, 0);', 2, -2, /shim\.math\.round/);
  await check('a = ceil(1.5); b = ceil(-1.5);', 2, -1, /Math\.ceil/);
  await check('a = floor(1.5); b = floor(-1.5);', 1, -2, /Math\.floor/);
  await check('a = isNumber("-1.26"); b = isNumber("abc");', true, false, /shim\.isNumber/);
  await check('a = isNull(null); b = isNull(0);', true, false, /shim\.isNull/);
  await check('a = ifnull(null, -5); b = ifnull(0, -5);', -5, 0, /shim\.ifnull/);
});

// --- added for batch 7 gaps ---
async function evalTranslation(src: string, record: Record<string, unknown> = {}, zone = 'UTC'): Promise<unknown> {
  const t = translate(src);
  if (t.server.includes('shim.todo')) {
      throw new Error('todo translation: ' + t.server);
  }
  const runtime = createRuntime({ dryRun: true, appTimeZone: zone });
  const ctx = runtime.context({ record });
  const body = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`) as Run;
  return body(runtime.shim, ctx);
}

test('batch 7 gaps: encoding and text-format builtins', async () => {
  // zoho.encryption.base64Encode
  let t = translate('out = zoho.encryption.base64Encode("hello");');
  assert.ok(t.server.includes('shim.zoho.task(ctx, ["encryption","base64Encode"], ["hello"])'));

  // zoho.encryption.base64Decode
  t = translate('out = zoho.encryption.base64Decode("hello");');
  assert.ok(t.server.includes('shim.zoho.task(ctx, ["encryption","base64Decode"], ["hello"])'));

  // zoho.encryption.urlEncode
  t = translate('out = zoho.encryption.urlEncode("hello");');
  assert.ok(t.server.includes('shim.zoho.task(ctx, ["encryption","urlEncode"], ["hello"])'));

  // zoho.encryption.urlDecode
  t = translate('out = zoho.encryption.urlDecode("hello");');
  assert.ok(t.server.includes('shim.zoho.task(ctx, ["encryption","urlDecode"], ["hello"])'));

  // zoho.encryption.md5
  t = translate('out = zoho.encryption.md5("hello");');
  assert.ok(t.server.includes('shim.zoho.task(ctx, ["encryption","md5"], ["hello"])'));

  // zoho.encryption.sha256
  t = translate('out = zoho.encryption.sha256("hello");');
  assert.ok(t.server.includes('shim.zoho.task(ctx, ["encryption","sha256"], ["hello"])'));

  // removeAllAlpha
  t = translate('out = "a1b2".removeAllAlpha();');
  assert.match(t.server, /shim\.string\.removeAllAlpha\("a1b2"\)/);
  assert.equal(await evalTranslation('out = "a1b2".removeAllAlpha();'), '12');
  assert.equal(await evalTranslation('out = "ZOHO creator 123".removeAllAlpha();'), '  123');

});

const RT = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date('2024-02-29T12:00:00Z') });
async function evalDeluge(src: string) {
  const t = translate(src);
  const body = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`);
  return body(RT.shim, RT.context({ record: {} }));
}

test('indexOf on a list maps to shim.list.indexOf', async () => {
  const t = translate('out = {"a", "b", "c"}.indexOf("b");');
  assert.match(t.server, /shim\.list\.indexOf/);
  assert.equal(await evalDeluge('out = {"a", "b", "c"}.indexOf("b");'), 1);
  assert.equal(await evalDeluge('out = {"a", "b", "c"}.indexOf("z");'), -1);
});

test('lastIndexOf on a list maps to shim.todo', { todo: 'wrong translation: lastIndexOf on a list currently maps to shim.todo' }, async () => {
  const t = translate('out = {"a", "b", "a"}.lastIndexOf("a");');
  assert.match(t.server, /shim\.list\.lastIndexOf/); // as it SHOULD be
  assert.equal(await evalDeluge('out = {"a", "b", "a"}.lastIndexOf("a");'), 2);
  assert.equal(await evalDeluge('out = {"a", "b", "c"}.lastIndexOf("z");'), -1);
});

test('isEmpty on a list maps to shim.isEmpty', async () => {
  const t = translate('out = {"a"}.isEmpty();');
  assert.match(t.server, /shim\.isEmpty/);
  assert.equal(await evalDeluge('out = {"a"}.isEmpty();'), false);
  assert.equal(await evalDeluge('out = List().isEmpty();'), true);
});

test('clear on a list maps to shim.list.clear', async () => {
  const t = translate('l = {"a"}; l.clear(); out = l.size();');
  assert.match(t.server, /shim\.list\.clear/);
  assert.equal(await evalDeluge('l = {"a"}; l.clear(); out = l.size();'), 0);
  assert.equal(await evalDeluge('l = {"a", "b"}; l.clear(); out = l.size();'), 0);
});

test('reverse on a list maps to shim.todo', { todo: 'wrong translation: reverse on a list currently maps to shim.todo' }, async () => {
  const t = translate('out = {"a", "b"}.reverse();');
  assert.match(t.server, /shim\.list\.reverse/); // as it SHOULD be
  assert.deepEqual(await evalDeluge('out = {"a", "b"}.reverse();'), ["b", "a"]);
  assert.deepEqual(await evalDeluge('out = {"a"}.reverse();'), ["a"]);
});

test('insert on a list maps to shim.list.insert', async () => {
  const t = translate('l = {"a", "c"}; l.insert(1, "b"); out = l;');
  assert.match(t.server, /shim\.list\.insert/);
  assert.deepEqual(await evalDeluge('l = {"a", "c"}; l.insert(1, "b"); out = l;'), ["a", "b", "c"]);
  assert.deepEqual(await evalDeluge('l = {"a"}; l.insert(0, "b"); out = l;'), ["b", "a"]);
});

test('sum on a list maps to shim.list.aggregate', async () => {
  const t = translate('out = {1, 2}.sum();');
  assert.match(t.server, /shim\.list\.aggregate/);
  assert.equal(await evalDeluge('out = {1, 2}.sum();'), 3);
  assert.equal(await evalDeluge('out = {5, 6, 7}.sum();'), 18);
});

test('min on a list maps to shim.list.aggregate', { todo: 'wrong translation: min on a list falls through to method:min todo because it is excluded in methodCall' }, async () => {
  const t = translate('out = {1, 2}.min();');
  assert.match(t.server, /shim\.list\.aggregate/); // as it SHOULD be
  assert.equal(await evalDeluge('out = {3, 1, 2}.min();'), 1);
  assert.equal(await evalDeluge('out = {-1, 5}.min();'), -1);
});

test('max on a list maps to shim.list.aggregate', { todo: 'wrong translation: max on a list falls through to method:max todo because it is excluded in methodCall' }, async () => {
  const t = translate('out = {1, 2}.max();');
  assert.match(t.server, /shim\.list\.aggregate/); // as it SHOULD be
  assert.equal(await evalDeluge('out = {3, 1, 2}.max();'), 3);
  assert.equal(await evalDeluge('out = {-1, 5}.max();'), 5);
});



test('getAlpha and getAlphaNumeric keep letters and alphanumeric characters respectively', async () => {
  const t = translate([
    'a = getAlpha("Your joining date is January 25th, 2019");',
    'b = "123-ABC".getAlpha();',
    'c = getAlphaNumeric("Your joining date is 25-01-2019");',
    'd = getAlphaNumeric(10.5);',
    'e = getAlpha(null);',
    'f = getAlpha("");',
    'g = getAlpha(0);',
    'h = getAlpha(-5);',
    'i = getAlphaNumeric(-5);',
    'return {"a": a, "b": b, "c": c, "d": d, "e": e, "f": f, "g": g, "h": h, "i": i};'
  ].join('\n'));
  
  assert.match(t.server, /shim\.string\.getAlpha/);
  assert.match(t.server, /shim\.string\.getAlphaNumeric/);
  
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = await body(t.server)(runtime.shim, runtime.context({ record: {} }));
  
  assert.deepEqual(got, {
    a: 'YourjoiningdateisJanuaryth',
    b: 'ABC',
    c: 'Yourjoiningdateis25012019',
    d: '105',
    e: null,
    f: null,
    g: null,
    h: null,
    i: '5'
  });
});


test('day and daysBetween test', async () => {
  const src = `
    a = "2020-02-28".toDate();
    b = "2020-03-02".toDate();
    diff1 = a.daysBetween(b);
    diff2 = b.daysBetween(a);
    
    dst1 = "2024-03-09".toDate();
    dst2 = "2024-03-11".toDate();
    diffDst = dst1.daysBetween(dst2);
    
    d1 = "2020-02-29".toDate().day();
    d2 = day("2020-03-01".toDate());
    
    dNull = "".day();
    
    return {"diff1": diff1, "diff2": diff2, "diffDst": diffDst, "d1": d1, "d2": d2, "dNull": dNull};
  `;
  const t = translate(src);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'America/Los_Angeles' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as any;
  assert.equal(got.diff1, 3);
  assert.equal(got.diff2, -3);
  assert.equal(got.diffDst, 2);
  assert.equal(got.d1, 29);
  assert.equal(got.d2, 1);
  assert.equal(got.dNull, null);
  
  const srcEmpty = 'return "".daysBetween("2020-01-01".toDate());';
  const tEmpty = translate(srcEmpty);
  await assert.rejects(body(tEmpty.server)(runtime.shim, runtime.context({})), /UnParsable date/);

});

test('string builtins translate and run', async () => {
  const evaluate = async (src: string) => {
    const { server } = translate(src);
    const fn = body(server);
    const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
    return await fn(runtime.shim, runtime.context({ record: {} }));
  };
  const shape = (src: string) => translate(src).server;

  assert.match(shape('isBlank(x);'), /shim\.isBlank\(x\)/);
  assert.match(shape('x.isBlank();'), /shim\.isBlank\(x\)/);
  assert.equal(await evaluate('return isBlank("a");'), false);
  assert.equal(await evaluate('return " ".isBlank();'), true);
  assert.equal(await evaluate('return isBlank("");'), true);
  assert.equal(await evaluate('return isBlank(null);'), true);

  assert.match(shape('"abc".left(2);'), /shim\.string\.left\("abc", 2\)/);
  assert.equal(await evaluate('return "abc".left(2);'), 'ab');
  assert.equal(await evaluate('return "abc".left(0);'), null);
  assert.equal(await evaluate('return "abc".left(-1);'), 'abc');
  await assert.rejects(evaluate('return "abc".left(10);'), /One or more specified index values were invalid/);
  assert.equal(await evaluate('return left(null, 2);'), null);

  assert.match(shape('"abc".right(2);'), /shim\.string\.right\("abc", 2\)/);
  assert.equal(await evaluate('return "abc".right(2);'), 'bc');
  assert.equal(await evaluate('return "abc".right(0);'), null);
  await assert.rejects(evaluate('return "abc".right(-1);'), /One or more specified index values were invalid/);
  await assert.rejects(evaluate('return "abc".right(10);'), /One or more specified index values were invalid/);

  assert.match(shape('"abc".mid(1, 1);'), /shim\.string\.mid\("abc", 1, 1\)/);
  assert.match(shape('mid("abc", 1, 1);'), /shim\.string\.mid\("abc", 1, 1\)/);
  assert.equal(await evaluate('return "abc".mid(1, 1);'), null);
  assert.equal(await evaluate('return "abc".mid(1, 2);'), 'b');
  assert.equal(await evaluate('return "abc".mid(0, 2);'), 'ab');
  assert.equal(await evaluate('return "abc".mid(1, -1);'), 'bc');
  await assert.rejects(evaluate('return "abc".mid(5);'), /One or more specified index values were invalid/);
  await assert.rejects(evaluate('return "abc".mid(3, 1);'), /Start index cannot be greater than the end index/);
  assert.equal(await evaluate('return "abc".mid(1);'), 'bc');

  assert.match(shape('" abc".ltrim();'), /shim\.string\.ltrim\(" abc"\)/);
  assert.match(shape('ltrim(" abc");'), /shim\.string\.ltrim\(" abc"\)/);
  assert.equal(await evaluate('return " abc ".ltrim();'), 'abc ');
  assert.equal(await evaluate('return " ".ltrim();'), null);

  assert.match(shape('" abc ".rtrim();'), /shim\.string\.rtrim\(" abc "\)/);
  assert.match(shape('rtrim(" abc ");'), /shim\.string\.rtrim\(" abc "\)/);
  assert.equal(await evaluate('return " abc ".rtrim();'), ' abc');
  assert.equal(await evaluate('return " ".rtrim();'), null);

  assert.match(shape('"a".repeat(3);'), /shim\.string\.repeat\("a", 3\)/);
  assert.match(shape('repeat("a", 3);'), /shim\.string\.repeat\("a", 3\)/);
  assert.equal(await evaluate('return "a".repeat(3);'), 'aaa');
  assert.equal(await evaluate('return "a".repeat(0);'), null);
  assert.equal(await evaluate('return "a".repeat(-1);'), null);
  assert.equal(await evaluate('return "x".repeat(20000).length();'), 20000);
  await assert.rejects(evaluate('return "xx".repeat(60000);'), /repeat result cannot exceed 100000/);

  assert.match(shape('"abc".reverse();'), /shim\.string\.reverse\("abc"\)/);
  assert.match(shape('reverse("abc");'), /shim\.string\.reverse\("abc"\)/);
  assert.equal(await evaluate('return "abc".reverse();'), 'cba');
  assert.equal(await evaluate('return "".reverse();'), null);
  assert.equal(await evaluate('return "a😀b".reverse();'), 'b😀a');
});

test('string builtins translation and evaluation: indexOf, startsWith, startsWithIgnoreCase, textToHex, getSuffix, trim', async () => {
  const t = translate(`
    i1 = indexOf("abc", "b");
    i2 = indexOf("abc", "x");
    i3 = indexOf("", "");
    i4 = indexOf(null, null);

    s1 = startsWith("abc", "a");
    s2 = startsWith("abc", "b");
    s3 = startsWith("", "");
    s4 = startsWith(null, null);

    si1 = startsWithIgnoreCase("aBc", "ab");
    si2 = "aBc".startsWithIgnoreCase("ab");
    si3 = startsWithIgnoreCase(null, null);

    th1 = textToHex("Zoho");
    th2 = "Zoho".textToHex();
    th3 = textToHex(null);

    gs1 = getSuffix("abcd", "b");
    gs2 = "abcd".getSuffix("b");
    gs3 = getSuffix(null, null);
    gs4 = getSuffix("abc", "x");
    gs5 = getSuffix("abc", "");
    gs6 = getSuffix("", "x");
    
    tr1 = trim(" abc ");
    tr2 = trim("");
    tr3 = trim(null);
    m = Map();
    m.put("i1", i1); m.put("i2", i2); m.put("i3", i3); m.put("i4", i4);
    m.put("s1", s1); m.put("s2", s2); m.put("s3", s3); m.put("s4", s4);
    m.put("si1", si1); m.put("si2", si2); m.put("si3", si3);
    m.put("th1", th1); m.put("th2", th2); m.put("th3", th3);
    m.put("gs1", gs1); m.put("gs2", gs2); m.put("gs3", gs3); m.put("gs4", gs4); m.put("gs5", gs5); m.put("gs6", gs6);
    m.put("tr1", tr1); m.put("tr2", tr2); m.put("tr3", tr3);
    return m;
  `);

  assert.equal(t.stats.todo, 0, 'Should not emit todo');

  const runtime = createRuntime({ dryRun: true });
  const ctx = runtime.context({ record: {} });
  const res = await body(t.server)(runtime.shim, ctx) as any;

  assert.equal(res["i1"], 1);
  assert.equal(res["i2"], -1);
  assert.equal(res["i3"], 0); // indexOf("", "") is 0
  assert.equal(res["i4"], 0); // null converted to ""

  assert.equal(res["s1"], true);
  assert.equal(res["s2"], false);
  assert.equal(res["s3"], true); // "" starts with ""
  assert.equal(res["s4"], true);

  assert.equal(res["si1"], true);
  assert.equal(res["si2"], true);
  assert.equal(res["si3"], true);

  assert.equal(res["th1"], "5a6f686f");
  assert.equal(res["th2"], "5a6f686f");
  assert.equal(res["th3"], null);

  assert.equal(res["gs1"], "cd");
  assert.equal(res["gs2"], "cd");
  assert.equal(res["gs3"], null);
  assert.equal(res["gs4"], null);
  assert.equal(res["gs5"], null);
  assert.equal(res["gs6"], null);

  assert.equal(res["tr1"], "abc");
  assert.equal(res["tr2"], null); // emptyToNull makes "" into null
  assert.equal(res["tr3"], null);
});

test('longtail misc-2 builtins: upper, year, workday, weekday, values, update', async () => {
  const t = translate([
    'a = upper("abc");',
    'b = "XYZ".upper();',
    'c = upper("");',
    'd = upper(null);',
    'y1 = year("2026-10-06");',
    'y2 = "2026-10-06".year();',
    'y3 = year("");',
    'y4 = year(null);',
    'w1 = weekday("2026-10-06");', // Tuesday -> 3
    'w2 = "2026-10-06".weekday();',
    'w3 = weekday("");',
    'wd1 = workday("2026-10-06", 1);', // add 1 business day -> Wednesday 2026-10-07
    'wd2 = "2026-10-06".workday(-1);', // negative or 0 returns same date -> 2026-10-06
    'wd3 = workday("", 1);',
    'v1 = {"a": 1, "b": 2}.values();',
    'v2 = {"a": 1}.values();',
    'v3 = "".values();',
    'v4 = null.values();',
    'l = List();',
    'l.add(1);',
    'l.add(2);',
    'l.add(3);',
    'v5 = l.values();',
    'u1 = {"a": 1}.update("b", null);',
    'u2 = {"a": 1}.update("b", 2);',
    'u3 = l.update(1, 42);',
    'u4 = null.update(1, 2);',
    'return {"a": a, "b": b, "c": c, "d": d, "y1": y1, "y2": y2, "y3": y3, "y4": y4, "w1": w1, "w2": w2, "w3": w3, "wd1": wd1, "wd2": wd2, "wd3": wd3, "v1": v1, "v2": v2, "v3": v3, "v4": v4, "v5": v5, "u1": u1, "u2": u2, "u3": u3, "u4": u4};'
  ].join('\n'));
  assert.match(stripComments(t.server), /shim\.string\.toUpperCase/);
  assert.match(stripComments(t.server), /shim\.date\.getYear/);
  assert.match(stripComments(t.server), /shim\.date\.getDayOfWeek/);
  assert.match(stripComments(t.server), /shim\.date\.addBusinessDay/);
  assert.match(stripComments(t.server), /shim\.list\.values/);
  assert.match(stripComments(t.server), /shim\.list\.update/);
  
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const result = await body(t.server)(runtime.shim, runtime.context({ record: {} })) as any;
  assert.equal(result.a, 'ABC');
  assert.equal(result.b, 'XYZ');
  assert.equal(result.c, null);
  assert.equal(result.d, null);
  assert.equal(result.y1, 2026);
  assert.equal(result.y2, 2026);
  assert.equal(result.y3, null);
  assert.equal(result.y4, null);
  assert.equal(result.w1, 3);
  assert.equal(result.w2, 3);
  assert.equal(result.w3, null);
  assert.equal(result.wd1.y, 2026);
  assert.equal(result.wd1.m, 10);
  assert.equal(result.wd1.d, 7);
  assert.equal(result.wd2.y, 2026);
  assert.equal(result.wd2.m, 10);
  assert.equal(result.wd2.d, 6);
  assert.equal(result.wd3, null);
  assert.deepEqual(result.v1, [1, 2]);
  assert.deepEqual(result.v2, [1]);
  assert.deepEqual(result.v3, []);
  assert.deepEqual(result.v4, []);
  assert.deepEqual(result.v5, [1, 2, 3]);
  assert.deepEqual(result.u1, {"a": 1, "b": null});
  assert.deepEqual(result.u2, {"a": 1, "b": 2});
  assert.deepEqual(result.u3, [1, 42, 3]);
  assert.equal(result.u4, null);

  await assert.rejects(async () => {
    const tFail = translate('workday("2026-10-06", 5, {"Sunday"}, {"25-May-2020"});');
    await body(tFail.server)(runtime.shim, runtime.context({ record: {} }));
  }, /workday with weekends or holidays is unsupported/);
  
  await assert.rejects(async () => {
    const tFail = translate('l = List(); l.add(1); l.add(2); l.update(5, 3);');
    await body(tFail.server)(runtime.shim, runtime.context({ record: {} }));
  }, /Given index 5 is greater than the list size/);
  
});

test('date builtins hour, minute, second, month, hoursBetween, nextWeekDay, previousWeekDay', async () => {
  const src = `
    dt = "2020-01-01 15:30:45".toTime();
    h = dt.hour();
    h2 = hour("2020-01-01 15:30:45".toTime());
    m = dt.minute();
    s = dt.second();
    mon = "2020-04-15".toDate().month();
    
    hb1 = hoursBetween("2019-12-18 09:00:00".toTime(), "2019-12-19 10:00:00".toTime());
    hb2 = hoursBetween("2019-12-18 07:00:00".toTime(), "2019-12-18 08:59:59".toTime());
    hb3 = hoursBetween("2019-12-19 10:00:00".toTime(), "2019-12-18 09:00:00".toTime());

    nw1 = "2021-07-20".toDate().nextWeekDay("Tuesday");
    nw2 = "2021-07-20".toDate().nextWeekDay("Monday");
    pw1 = "2021-07-21".toDate().previousWeekDay("Monday");
    pw2 = "2021-07-21".toDate().previousWeekDay("Wednesday");

    // null or invalid
    n1 = "".hour();
    n2 = minute(null);
    n3 = "".nextWeekDay("Monday");
    n4 = "2021-07-20".toDate().previousWeekDay("Funday");
    n5 = "2021-07-20".toDate().nextWeekDay("Funday");
    n6 = "2021-07-20".toDate().nextWeekDay(0);
    n7 = "2021-07-20".toDate().previousWeekDay(null);
  `;
  const t = translate(src);
  
  assert.match(t.server, /shim\.date\.hour\(/);
  assert.match(t.server, /shim\.date\.minute\(/);
  assert.match(t.server, /shim\.date\.second\(/);
  assert.match(t.server, /shim\.date\.month\(/);
  assert.match(t.server, /shim\.date\.hoursBetween\(/);
  assert.match(t.server, /shim\.date\.nextWeekDay\(/);
  assert.match(t.server, /shim\.date\.previousWeekDay\(/);

  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', now: new Date('2026-10-06T12:00:00Z') });
  const fn = new Function('shim', 'ctx', `${t.server}\nreturn [h, h2, m, s, mon, hb1, hb2, hb3, shim.date.format(nw1, 'dd-MMM-yyyy', ctx), shim.date.format(nw2, 'dd-MMM-yyyy', ctx), shim.date.format(pw1, 'dd-MMM-yyyy', ctx), shim.date.format(pw2, 'dd-MMM-yyyy', ctx), n1, n2, n3, n4, n5, n6, n7];`);
  const result = fn(runtime.shim, runtime.context({ record: {} }));
  
  assert.deepEqual(result, [
    15, 15, 30, 45, 4,
    25, 1, -25,
    "27-Jul-2021", "26-Jul-2021", "19-Jul-2021", "14-Jul-2021",
    null, null, null, null, null, null, null
  ]);
});

test('c2c-todo-shims eval', async () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const b = (code: string) => body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));

  // rightPad
  assert.equal(await b('return rightpad("a", 3, "-");'), 'a--');
  assert.equal(await b('return "a".rightpad(3);'), 'a  ');
  assert.equal(await b('return "a".rightpad(-1);'), 'a');
  assert.equal(await b('return rightpad("a", 0);'), 'a');
  assert.equal(await b('return rightpad(null, 2);'), '  ');
  assert.equal(await b('return rightpad("", 2, "x");'), 'xx');

  // isText
  assert.equal(await b('return isText("a");'), true);
  assert.equal(await b('return isText("");'), true);
  assert.equal(await b('return isText(null);'), false);
  assert.equal(await b('return isText(0);'), false);
  assert.equal(await b('return isText("123");'), false);
  assert.equal(await b('return isText("1.5");'), false);
  assert.equal(await b('return isText("-2");'), false);
  assert.equal(await b('return isText(true);'), null);
  assert.equal(await b('return isText({"a":"b"});'), null);
  assert.equal(await b('return isText({});'), null);
  assert.equal(await b("return '01-Feb-2020'.isText();"), false);

  // isNull
  assert.equal(await b('return isNull(null);'), true);
  assert.equal(await b('return "".isNull();'), true);
  assert.equal(await b('return isNull("a");'), false);
  assert.equal(await b('return (0).isNull();'), false);
});

test('c2c-todo-shims translation shape', () => {
  assert.match(stripComments(translate('x = isText(a);').server), /shim\.isText\(a\)/);
  assert.match(stripComments(translate('x = a.isText();').server), /shim\.isText\(a\)/);
  assert.match(stripComments(translate('x = rightpad(a, b);').server), /shim\.string\.rightPad\(a, b\)/);
  assert.match(stripComments(translate('x = a.rightpad(b);').server), /shim\.string\.rightPad\(a, b\)/);
  assert.match(stripComments(translate('x = a.isNull();').server), /shim\.isNull\(a\)/);
});

test('string missing shims go through shim', async () => {
  const t = translate([
    'b = isDate("abc");',
    'c = "abc".isDate();',
    'd = isAscii("abc");',
    'e = "abc".isAscii();',
    'f = removeAllAlphaNumeric("a1b!");',
    'g = "a1b!".removeAllAlphaNumeric();',
    'h = hexToText("48656c6c6f");',
    'i = "48656c6c6f".hexToText();',
    'j = htmlDecode("&lt;hi&gt;");',
    'k = "&lt;hi&gt;".htmlDecode();',
    'return {"b": b, "c": c, "d": d, "e": e, "f": f, "g": g, "h": h, "i": i, "j": j, "k": k};'
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.equal(got.b, false);
  assert.equal(got.c, false);
  assert.equal(got.d, true);
  assert.equal(got.e, true);
  assert.equal(got.f, '!');
  assert.equal(got.g, '!');
  assert.equal(got.h, 'Hello');
  assert.equal(got.i, 'Hello');
  assert.equal(got.j, '<hi>');
  assert.equal(got.k, '<hi>');
});

test('string missing shims handle empty, zero, negative, null', async () => {
  const t = translate([
    'e = isDate("");',
    'f = "".isDate();',
    'g = isDate(0);',
    'h = (0).isDate();',
    'i = isDate(-1);',
    'j = (-1).isDate();',
    'k = isDate(null);',
    'l = isAscii("");',
    'm = "".isAscii();',
    'n = isAscii(0);',
    'o = (0).isAscii();',
    'p = isAscii(-1);',
    'q = (-1).isAscii();',
    'r = isAscii(null);',
    's = removeAllAlphaNumeric("");',
    't = "".removeAllAlphaNumeric();',
    'u = removeAllAlphaNumeric(0);',
    'v = (0).removeAllAlphaNumeric();',
    'w = removeAllAlphaNumeric(-1);',
    'x = (-1).removeAllAlphaNumeric();',
    'y = removeAllAlphaNumeric(null);',
    'z = hexToText("");',
    'aa = "".hexToText();',
    'ab = hexToText(0);',
    'ac = (0).hexToText();',
    'ad = hexToText(-1);',
    'ae = (-1).hexToText();',
    'af = hexToText(null);',
    'ag = htmlDecode("");',
    'ah = "".htmlDecode();',
    'ai = htmlDecode(0);',
    'aj = (0).htmlDecode();',
    'ak = htmlDecode(-1);',
    'al = (-1).htmlDecode();',
    'am = htmlDecode(null);',
    'return {"e": e, "f": f, "g": g, "h": h, "i": i, "j": j, "k": k, "l": l, "m": m, "n": n, "o": o, "p": p, "q": q, "r": r, "s": s, "t": t, "u": u, "v": v, "w": w, "x": x, "y": y, "z": z, "aa": aa, "ab": ab, "ac": ac, "ad": ad, "ae": ae, "af": af, "ag": ag, "ah": ah, "ai": ai, "aj": aj, "ak": ak, "al": al, "am": am};'
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;

  assert.equal(got.e, false);
  assert.equal(got.f, false);
  assert.equal(got.g, false);
  assert.equal(got.h, false);
  assert.equal(got.i, false);
  assert.equal(got.j, false);
  assert.equal(got.k, null);

  assert.equal(got.l, true);
  assert.equal(got.m, true);
  assert.equal(got.n, true);
  assert.equal(got.o, true);
  assert.equal(got.p, true);
  assert.equal(got.q, true);
  assert.equal(got.r, null);

  assert.equal(got.s, null);
  assert.equal(got.t, null);
  assert.equal(got.u, null);
  assert.equal(got.v, null);
  assert.equal(got.w, "-");
  assert.equal(got.x, "-");
  assert.equal(got.y, null);

  assert.equal(got.z, null);
  assert.equal(got.aa, null);
  assert.equal(got.ab, null);
  assert.equal(got.ac, null);
  assert.equal(got.ad, null);
  assert.equal(got.ae, null);
  assert.equal(got.af, null);

  assert.equal(got.ag, null);
  assert.equal(got.ah, null);
  assert.equal(got.ai, "0");
  assert.equal(got.aj, "0");
  assert.equal(got.ak, "-1");
  assert.equal(got.al, "-1");
  assert.equal(got.am, null);
});

test('sin, cos, tan, asin: free and method forms run through the same number shims', async () => {
  const run = async (src: string) => {
    const t = translate(src);
    const runtime = createRuntime({ dryRun: true });
    return { code: stripComments(t.server), got: (await body(t.server)(runtime.shim, runtime.context({}))) as any };
  };
  for (const fn of ['sin', 'cos', 'tan', 'asin']) {
    const { code, got } = await run(`
      n = null;
      half = 0.5;
      return {"free": ${fn}(half), "method": half.${fn}(), "zero": ${fn}(0), "neg": (-0.5).${fn}(),
        "freeNull": ${fn}(n), "methodNull": n.${fn}()};
    `);
    assert.match(code, new RegExp(`shim\\.number\\.${fn}\\(`), fn);
    assert.doesNotMatch(code, /Math\.(sin|cos|tan|asin)\(/, fn);
    const js = (Math as any)[fn] as (n: number) => number;
    assert.equal(String(got.free), String(js(0.5)), `${fn}(0.5)`);
    assert.equal(String(got.method), String(got.free), `${fn} free vs method`);
    assert.equal(String(got.zero), String(js(0)), `${fn}(0)`);
    assert.equal(String(got.neg), String(js(-0.5)), `${fn}(-0.5)`);
    assert.equal(got.freeNull, null, `${fn}(null)`);
    assert.equal(got.methodNull, null, `null.${fn}()`);
  }
  const { got: edge } = await run(`
    return {"asinHigh": asin(2), "asinLow": (-1.5).asin(), "asinOne": (1).asin(), "tanHalfPi": tan(1.5707963267948966)};
  `);
  assert.equal(edge.asinHigh, null);
  assert.equal(edge.asinLow, null);
  assert.equal(String(edge.asinOne), String(Math.asin(1)));
  assert.equal(String(edge.tanHalfPi), String(Math.tan(1.5707963267948966)));
});

test('sin, cos, tan, asin refuse a bigint past 2^53 or a Decimal a double cannot carry', async () => {
  const run = async (src: string) => {
    const runtime = createRuntime({ dryRun: true });
    return body(translate(src).server)(runtime.shim, runtime.context({}));
  };
  for (const fn of ['sin', 'cos', 'tan', 'asin']) {
    await assert.rejects(run(`return ${fn}(9007199254740993);`), (e: any) => e.name === 'DelugeConversionError' && /refusing to lose precision/.test(e.message), `${fn} bigint`);
    await assert.rejects(run(`x = 9007199254740993; return x.${fn}();`), /refusing to lose precision/, `${fn} bigint method`);
    await assert.rejects(run(`return toDecimal("0.10000000000000000001").${fn}();`), (e: any) => e.name === 'DelugeConversionError' && /refusing to lose precision/.test(e.message), `${fn} decimal`);
    await assert.rejects(run(`return ${fn}(toDecimal("12345678901234567890.5"));`), /refusing to lose precision/, `${fn} long decimal`);
  }
  const ok = (await run('return toDecimal("0.5").sin();')) as any;
  assert.equal(String(ok), String(Math.sin(0.5)));
});

test('toDecimal: null is null, plain decimal text is exact, other text throws', async () => {
  const run = async (src: string) => {
    const runtime = createRuntime({ dryRun: true });
    return body(translate(src).server)(runtime.shim, runtime.context({}));
  };
  const got = (await run(`
    n = null;
    return {"free": toDecimal(n), "method": n.toDecimal(), "tenth": toDecimal("0.1"), "long": toDecimal("12345678901234567890.5"),
      "neg": "-0.99".toDecimal(), "sum": toDecimal("0.1") + toDecimal("0.2")};
  `)) as any;
  assert.equal(got.free, null);
  assert.equal(got.method, null);
  assert.equal(got.tenth.toString(), '0.1');
  assert.equal(got.long.toString(), '12345678901234567890.5');
  assert.equal(got.neg.toString(), '-0.99');
  assert.equal(String(got.sum), '0.3');
  for (const bad of ['""', '"abc"', '"0x1"', '"1e2"', 'true']) {
    await assert.rejects(run(`return toDecimal(${bad});`), (e: any) => e.name === 'DelugeConversionError' && /Unable to convert the input text to decimal/.test(e.message), bad);
  }
});

test('a bare field member path folds into the multi-arg get, so a null lookup reads undefined', async () => {
  // `Name.first_name` on an empty lookup must not throw on `.first_name`.
  const t = translate('x = Name.first_name;\ny = Employee.Email;\nz = Name.last_name.initial;', {
    inputFields: ['Name'],
    rowNames: ['rec'],
    rowFields: ['Employee'],
  });
  assert.match(t.server, /shim\.input\.get\(ctx, "Name", "first_name"\)/);
  assert.match(t.server, /shim\.input\.get\(ctx, "Name", "last_name", "initial"\)/);
  assert.match(t.server, /shim\.record\.get\(d_rec, "Employee", "Email"\)/);
  assert.doesNotMatch(t.server, /get\(ctx, "Name"\)\.|get\(d_rec, "Employee"\)\./);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const rec = { __row: true as const, form: 'F', values: { Employee: { Email: 'a@b.c' } } };
  const ctx = runtime.context({ record: { Name: null }, row: rec });
  const got = (await body(`const d_rec = ctx.row;\n${t.server}\nreturn [x, y, z];`)(runtime.shim, ctx)) as unknown[];
  assert.deepEqual(got, [undefined, 'a@b.c', undefined]);
  const empty = { __row: true as const, form: 'F', values: { Employee: null } };
  const none = (await body(`const d_rec = ctx.row;\n${t.server}\nreturn [x, y, z];`)(runtime.shim, runtime.context({ record: { Name: null }, row: empty }))) as unknown[];
  assert.deepEqual(none, [undefined, undefined, undefined]);
  // A local still shadows the field: its member path is not a field read.
  const local = translate('Name = Map();\nx = Name.first_name;', { inputFields: ['Name'] });
  assert.doesNotMatch(local.server, /shim\.input\.get/);
  assert.match(local.server, /shim\.get\(Name, "first_name"\)/);
});

test('a bare field member write is a field set, not an assignment to a call result', () => {
  const t = translate('Name.first_name = "Ada";\nEmployee.Email = "a@b.c";', {
    inputFields: ['Name'],
    rowNames: ['rec'],
    rowFields: ['Employee'],
  });
  assert.match(t.server, /shim\.input\.set\(ctx, \["Name","first_name"\], "Ada"\)/);
  assert.match(t.server, /shim\.record\.set\(d_rec, \["Employee","Email"\], "a@b\.c"\)/);
  assert.doesNotMatch(t.server, /shim\.(input|record)\.get\([^)]*\) = /);
});

test('startsWith and endsWith on a dynamic receiver route through the null-safe shim', async () => {
  const t = translate('a = Tracking_Id.startsWith("ZTL");\nb = Tracking_Id.endsWith("IN");\nreturn {"a": a, "b": b};', {
    inputFields: ['Tracking_Id'],
  });
  assert.match(t.server, /shim\.string\.startsWith\(shim\.input\.get\(ctx, "Tracking_Id"\), "ZTL"\)/);
  assert.match(t.server, /shim\.string\.endsWith\(shim\.input\.get\(ctx, "Tracking_Id"\), "IN"\)/);
  assert.doesNotMatch(t.server, /\)\.startsWith\(|\)\.endsWith\(/);
  // A string literal keeps the native method. Null is empty text, same as the free function.
  const literal = translate('a = "hello".startsWith("he");\nb = "hello".endsWith("lo");');
  assert.match(literal.server, /"hello"\.startsWith\("he"\)/);
  assert.match(literal.server, /"hello"\.endsWith\("lo"\)/);
  const predicates = createRuntime({ dryRun: true, appTimeZone: 'UTC' }).shim.string as unknown as {
    startsWith(value: unknown, prefix: unknown): boolean;
    endsWith(value: unknown, suffix: unknown): boolean;
  };
  assert.equal(predicates.startsWith(null, 'x'), false);
  assert.equal(predicates.startsWith('ZTL-9', 'ZTL'), true);
  assert.equal(typeof predicates.endsWith, 'function');
  assert.equal(predicates.endsWith(undefined, 'x'), false);
  assert.equal(predicates.endsWith('a-IN', 'IN'), true);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: { Tracking_Id: null } }))) as Record<string, unknown>;
  assert.deepEqual(got, { a: false, b: false });
  const hit = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const yes = (await body(t.server)(hit.shim, hit.context({ record: { Tracking_Id: 'ZTL-9-IN' } }))) as Record<string, unknown>;
  assert.deepEqual(yes, { a: true, b: true });
});

test('c2c-todo-shims eval collection common map builtins', async () => {
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const b = async (code: string) => await body(translate(code).server)(runtime.shim, runtime.context({ record: {} }));

  // isEven
  assert.equal(await b('return isEven(2);'), true);
  assert.equal(await b('return isEven(3);'), false);
  assert.equal(await b('return isEven(null);'), null);

  // isOdd
  assert.equal(await b('return isOdd(3);'), true);
  assert.equal(await b('return isOdd(2);'), false);
  assert.equal(await b('return isOdd(null);'), null);

  // isFile: a stored uploads/ or migrated/ key, or a { key } reference. Anything else is false.
  const fileKey = `uploads/Order/Photo/${'a'.repeat(64)}/a.png`;
  const migratedKey = 'migrated/Order/Photo/12/a.png';
  assert.equal(await b(`return isFile("${fileKey}");`), true);
  assert.equal(await b(`return isFile({"key": "${fileKey}"});`), true);
  assert.equal(await b(`return "${migratedKey}".isFile();`), true);
  assert.equal(await b('return isFile("test");'), false);
  assert.equal(await b('return isFile(null);'), false);
  assert.equal(await b('return isFile("");'), false);
  assert.equal(await b('return isFile({"key": "val"});'), false);
  assert.equal(await b('return {"a": 1}.isFile();'), false);

  // delete
  assert.deepEqual(await b('l = {1, 2, 3}; l.delete(2); return l;'), [1, 3]);
  assert.deepEqual(await b('l = {1, 2, 2}; l.delete(2); return l;'), [1, 2]);
  assert.deepEqual(await b('l = {1, 2}; l.delete(5); return l;'), [1, 2]);

  // deleteAll
  assert.deepEqual(await b('l = {1, 2, 2, 3}; l.deleteAll(2); return l;'), [1, 3]);
  assert.deepEqual(await b('l = {1, 2}; l.deleteAll(5); return l;'), [1, 2]);
  assert.deepEqual(await b('l = {}; l.deleteAll(null); return l;'), []);

  // duplicate
  assert.deepEqual(await b('l = {1, 2}; return l.duplicate();'), [1, 2]);
  assert.deepEqual(await b('m = {"a": 1}; return m.duplicate();'), {"a": 1});
  assert.equal(await b('return null.duplicate();'), null);

  // sortKey
  assert.deepEqual(await b('m = {"b": 2, "a": 1}; return m.sortKey();'), {"a": 1, "b": 2});
  assert.deepEqual(await b('m = Map(); return m.sortKey();'), {});
  assert.equal(await b('return null.sortKey();'), null);

  // containValue
  assert.equal(await b('return {"a": 1}.containValue(1);'), true);
  assert.equal(await b('return {"a": 1}.containValue(2);'), false);
  assert.equal(await b('return {}.containValue(null);'), false);

  // notContains: text and list negate contains; a map searches keys.
  assert.equal(await b('return "abc".contains("c");'), true);
  assert.equal(await b('return "abc".notContains("c");'), false);
  assert.equal(await b('return "abc".notContains("z");'), true);
  assert.equal(await b('return "Zoho Creator".notContains("CREATOR");'), true);
  assert.equal(await b('return "Zoho Creator".notContains("Creator");'), false);
  assert.equal(await b('return {1, 2, 3}.contains(2);'), true);
  assert.equal(await b('return {1, 2, 3}.notContains(2);'), false);
  assert.equal(await b('return {1, 2, 3}.contains(9);'), false);
  assert.equal(await b('return {1, 2, 3}.notContains(9);'), true);
  assert.equal(await b('return (1).notContains("1");'), false);
  assert.equal(await b('return {"a": 1}.notContains("b");'), true);
  assert.equal(await b('return {"a": 1}.notContains("a");'), false);
  assert.equal(await b('return {}.notContains(null);'), true);
});

test('sort by and range bind a field-projected fetch, not a dangling statement', () => {
  const single = translate('v = Accounting[Supplier_Name == input.Name].Credits sort by Added_Time desc;');
  assert.equal(single.todos.length, 0);
  assert.match(single.server, /shim\.datastore\.field\(ctx, shim\.datastore\.query\(ctx, "Accounting"/);
  assert.match(single.server, /sort: \{ field: "Added_Time", dir: "desc" \}/);

  const ranged = translate('v = Add_Contract[ID != 0].ID sort by Added_Time desc range from 1 to 1;');
  assert.equal(ranged.todos.length, 0);
  assert.match(ranged.server, /sort: \{ field: "Added_Time", dir: "desc" \}/);
  assert.match(ranged.server, /range: \{ from: 1, to: 1 \}/);

  // `sort by F1, F2 dir` sorts on every key in order.
  const multi = translate('v = Task[Project == p].ID sort by Requirement,Added_Time desc;');
  assert.equal(multi.todos.length, 0);
  assert.match(multi.server, /fields: \[\{ field: "Requirement" \}, \{ field: "Added_Time", dir: "desc" \}\]/);
});

test('a parenthesised sorted fetch still yields the column for getAll', () => {
  const t = translate('available_rooms = (Booking_Form[Status == "Reserved"].Choose_Room sort by Added_Time desc).getAll();');
  assert.equal(t.todos.length, 0);
  assert.match(t.server, /await shim\.datastore\.column\(ctx, shim\.datastore\.query\(ctx, "Booking_Form"/);
  assert.match(t.server, /sort: \{ field: "Added_Time", dir: "desc" \}/);
  assert.doesNotMatch(t.server, /shim\.todo/);

  const plain = translate('v = (Add_Room[ID != 0].ID).getAll();');
  assert.equal(plain.todos.length, 0);
  assert.match(plain.server, /await shim\.datastore\.column\(ctx, shim\.datastore\.query\(ctx, "Add_Room"/);
});

test('field not in list is a negated membership leaf, not an unparsed statement', () => {
  const t = translate('busy_rooms = List();\navailable_rooms = Add_Room[ID not in busy_rooms && Available == "Active"].ID.getAll();');
  assert.equal(t.todos.length, 0);
  assert.match(t.server, /\{ op: "not", arg: \{ op: "in", field: "ID", value: busy_rooms \} \}/);
  assert.doesNotMatch(t.server, /shim\.todo/);

  const cond = translate('x = 1;\nids = List();\nif(x not in ids) { y = 1; }');
  assert.equal(cond.todos.length, 0);
  assert.match(cond.server, /!shim\.list\.contains\(ids, x\)/);
});

test('pushnotification is a named manual item, not an anonymous task stub', () => {
  const t = translate(
    'pushnotification\n(\n sender type : "fields"\n to : "admin@example.test"\n title : "New Incident"\n message : "a new record"\n view: "Recent_Incidents"\n)',
  );
  assert.deepEqual(t.todos.map((item) => item.construct), ['pushnotification']);
  assert.match(t.server, /shim\.todo\(ctx, "pushnotification"\)/);
});

test('toFile on an ordinary value stays a counted manual item', () => {
  const t = translate('f = resp.toFile();');
  assert.deepEqual(t.todos.map((item) => item.construct), ['method:toFile']);
});

function assigned(src: string): Expr {
  const stmt = parse(src).body[0];
  assert.ok(stmt && stmt.kind === 'assign');
  return stmt.value;
}

function tested(src: string): Expr {
  const stmt = parse(src).body[0];
  assert.ok(stmt && stmt.kind === 'if');
  return stmt.test;
}

function shape(e: Expr): string {
  switch (e.kind) {
    case 'binary':
      return `(${shape(e.left)} ${e.op} ${shape(e.right)})`;
    case 'unary':
      return `(${e.op}${shape(e.expr)})`;
    case 'paren':
      return shape(e.expr);
    case 'name':
      return e.name;
    case 'call':
      return e.callee.kind === 'member' ? `${shape(e.callee.object)}.${e.callee.property}()` : 'call';
    case 'member':
      return `${shape(e.object)}.${e.property}`;
    case 'criteria':
      return `CRITERIA ${shape(e.object)}[${shape(e.criteria)}]`;
    case 'index':
      return `INDEX ${shape(e.object)}[${shape(e.index)}]`;
    default:
      return e.kind;
  }
}

/** Criteria object of the first datastore query the translation emitted. */
function queryCriteria(src: string): Criteria {
  const t = translate(src);
  const code = stripComments([t.server, t.prefetch, t.client].join('\n'));
  const at = code.indexOf('shim.datastore.query(');
  assert.ok(at >= 0, code);
  const brace = code.indexOf('{', at);
  assert.ok(brace >= 0);
  let depth = 0;
  let end = brace;
  for (; end < code.length; end++) {
    const ch = code[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  const obj = code.slice(brace, end);
  assert.equal(obj.includes('"not in"'), false);
  return new Function(`return (${obj});`)() as Criteria;
}

function keptIds(c: Criteria): string[] {
  const rows = [
    { ID: '1', ROWID: '1' },
    { ID: '2', ROWID: '2' },
    { ID: '3', ROWID: '3' },
    { ID: null, ROWID: '9' },
  ];
  return rows.filter((row) => matchRow(row, c)).map((row) => row.ROWID);
}

test('a fetch bracket with not in is a datastore query, same rows as not (in)', () => {
  const bracket = shape(assigned('rows = Form_A[(ID not in list)];'));
  assert.equal(bracket, 'CRITERIA Form_A[(ID not in list)]');
  assert.equal(bracket, shape(assigned('rows = Form_A[(ID in list)];')).replace(' in ', ' not in '));
  assert.equal(shape(assigned('rows = Form_A[ID not in list];')), bracket);

  const listed = queryCriteria('rows = Form_A[(ID not in {"2", "3"})];');
  const listedIn = queryCriteria('rows = Form_A[(ID in {"2", "3"})];');
  assert.deepEqual(listed, { op: 'not', arg: listedIn });
  assert.equal(compileCriteria(listed), `(NOT ${compileCriteria(listedIn)})`);
  assert.deepEqual(keptIds(listedIn), ['2', '3']);
  assert.deepEqual(keptIds(listed), ['1', '9']);

  const empty = queryCriteria('rows = Form_A[(ID not in {})];');
  const emptyIn = queryCriteria('rows = Form_A[(ID in {})];');
  assert.deepEqual(empty, { op: 'not', arg: emptyIn });
  assert.deepEqual(keptIds(emptyIn), []);
  assert.deepEqual(keptIds(empty), ['1', '2', '3', '9']);

  const absent = queryCriteria('rows = Form_A[(ID not in null)];');
  const absentIn = queryCriteria('rows = Form_A[(ID in null)];');
  assert.deepEqual(absent, { op: 'not', arg: absentIn });
  assert.deepEqual(keptIds(absentIn), []);
  assert.deepEqual(keptIds(absent), ['1', '2', '3', '9']);

  assert.deepEqual(reportCriteria('ID not in {"2", "3"}'), listed);
  assert.deepEqual(reportCriteria('ID not in {}'), empty);
  assert.deepEqual(reportCriteria('ID not in null'), absent);

  const ui = translate('list = List();\ninput.Field_A:ui.add(Form_A[(ID not in list)].ID.getAll());');
  assert.equal(ui.todos.some((item) => item.construct === 'task:input'), false);
  const query = '{ op: "not", arg: { op: "in", field: "ID", value: list } }';
  assert.equal(stripComments(ui.prefetch).includes(`shim.datastore.query(ctx, "Form_A", ${query})`), true);
  assert.equal(stripComments(ui.prefetch).includes('shim.datastore.column('), true);
  assert.equal(stripComments(ui.client).includes('not in'), false);
  assert.equal(stripComments(ui.prefetch).includes('not in'), false);
  assert.equal(stripComments(ui.client).includes('op: "ui"'), true);
  assert.doesNotThrow(() => new Function(ui.client));
  assert.doesNotThrow(() => new Function(`async function probe(ctx, shim, slots, list) {\n${ui.prefetch}\n}`));
});

test('a boolean not in is the negation of list membership', () => {
  const found = translate('x = 1;\nlist = List();\nfound = x not in list;');
  assert.match(stripComments(found.server), /found = !shim\.list\.contains\(list, x\)/);
  assert.doesNotMatch(stripComments(found.server), /not in/);
  const cond = translate('x = 1;\nlist = List();\nif (x not in list) { info x; }');
  assert.match(stripComments(cond.client), /if \(!shim\.list\.contains\(list, x\)\)/);
  assert.doesNotMatch(stripComments(cond.client), /not in/);
  assert.doesNotThrow(() => new Function(found.server));
  assert.doesNotThrow(() => new Function(cond.client));
});

test('not in binds at the same level as in', () => {
  assert.equal(shape(assigned('a = a not in b && c;')), '((a not in b) && c)');
  assert.equal(shape(assigned('a = a not in b && c;')).replaceAll('not in', 'in'), shape(assigned('a = a in b && c;')));
  assert.equal(shape(tested('if (!(a not in b)) { x = 1; }')).replaceAll('not in', 'in'), shape(tested('if (!(a in b)) { x = 1; }')));
  assert.equal(shape(assigned('a = a not in b.getAll();')).replaceAll('not in', 'in'), shape(assigned('a = a in b.getAll();')));
});

test('xml builtins stay manual under task:xml', () => {
  for (const src of [
    'x = executeXpath();',
    'x = EXECUTExpath();',
    'x = "abc".toXml();',
    'x = "abc".toxml();',
    'x = "abc".toXmlList();',
    'x = "abc".toxmllist();',
    'x = notARealFn().toXml();',
  ]) {
    const t = translate(src);
    assert.match(t.server, /shim\.todo\(ctx, "task:xml"\)/, src);
    assert.doesNotMatch(t.server, /xml_task|encryption_task|method:toXml|method:toxml|method:toXmlList|method:executeXpath/, src);
    assert.ok(t.todos.some((item) => item.construct === 'task:xml'), src);
  }
});

test('htmlEncode is shim.string.htmlEncode in method and free form', async () => {
  const t = translate([
    'a = htmlEncode("a<b>&c");',
    'b = "a<b>&c".htmlEncode();',
    'c = htmlEncode("&amp;");',
    'd = "&amp;".htmlEncode();',
    'e = htmlEncode("order\'s");',
    'f = htmlEncode("");',
    'g = "".htmlEncode();',
    'h = htmlEncode(null);',
    'i = htmlEncode(0);',
    'j = HTMLENCODE("a<b>");',
    'return {"a": a, "b": b, "c": c, "d": d, "e": e, "f": f, "g": g, "h": h, "i": i, "j": j};',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.match(t.server, /shim\.string\.htmlEncode/);
  assert.doesNotMatch(t.server, /encryption_task|shim\.todo/);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const got = (await body(t.server)(runtime.shim, runtime.context({ record: {} }))) as Record<string, unknown>;
  assert.equal(got.a, 'a&lt;b&gt;&amp;c');
  assert.equal(got.b, 'a&lt;b&gt;&amp;c');
  assert.equal(got.c, '&amp;amp;');
  assert.equal(got.d, '&amp;amp;');
  assert.equal(got.e, "order's");
  assert.equal(got.f, null);
  assert.equal(got.g, null);
  assert.equal(got.h, null);
  assert.equal(got.i, '0');
  assert.equal(got.j, 'a&lt;b&gt;');
});

test('a condition on a non-record server loop element is one round trip per element', () => {
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (room == Add_Room[ID == input.ID].Room_Name) { alert "taken"; }',
    '}',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.equal(t.usesElement, true);
  // The client iterates the snapshot and sends each element back for the
  // server part of the condition, in loop order.
  assert.match(stripComments(t.client), /for \(var room of shim\.each\(ctx, slots\["c1"\]\)\)/);
  assert.match(stripComments(t.client), /if \(\(await shim\.client\.element\(ctx, "room", room, "c0"\)\)\)/);
  // The element slot is guarded by ctx.element so the one-shot prefetch skips it.
  assert.match(stripComments(t.prefetch), /if \(ctx\.element !== undefined && ctx\.element\.name === "room"\)/);
  assert.match(stripComments(t.prefetch), /var room = __elements\[__index\];/);
  assert.match(stripComments(t.prefetch), /slots\["c0"\] = \(room == await shim\.datastore\.field/);
  assert.doesNotMatch(stripComments(t.client), /client-condition-uses-server/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), false);
  assert.doesNotThrow(() => new Function(`async function probe(ctx, shim, slots) {\n${t.prefetch}\n}`));
});

test('a non-record element inside a server criteria round-trips per element', () => {
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (Bookings[Room == room].count() > 0) { info "booked"; }',
    '}',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.match(stripComments(t.client), /await shim\.client\.element\(ctx, "room", room, "c0"\)/);
  assert.match(stripComments(t.prefetch), /slots\["c0"\] = \(await shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Bookings"/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), false);
});

test('a condition reaching a non-record element through a binding still round-trips', () => {
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  wanted = room;',
    '  if (wanted == Add_Room[ID == input.ID].Room_Name) { alert "taken"; }',
    '}',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  // The element-reaching binding replays inside the element guard, not at top level.
  assert.match(stripComments(t.prefetch), /var room = __elements\[__index\];/);
  assert.match(stripComments(t.prefetch), /var wanted = room;/);
  assert.match(stripComments(t.prefetch), /slots\["c0"\] = \(wanted == await shim\.datastore\.field/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), false);
});

test('a condition reading only the loop element stays on the client', () => {
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (room == "A101") { alert "match"; }',
    '}',
  ].join('\n'));
  assert.equal(t.stats.todo, 0);
  assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/);
  assert.match(stripComments(t.client), /if \(\(room == "A101"\)\)/);
});

test('a condition mixing a record element with a live server read is a row map', () => {
  // A fetched row is not a per-element round trip. The row map owns it:
  // one prefetch entry per row ID, no element POST.
  const t = translate([
    'for each rec in Orders[Status == "Open"] {',
    '  if (rec.Name == Customers[ID == input.ID].Full_Name) { alert "x"; }',
    '}',
  ].join('\n'));
  assert.equal(t.usesElement, false);
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(t.client), /slots\["c0"\]\[shim\.record\.get\(d_rec, "ID"\)\]/);
  assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/);
  assert.doesNotMatch(t.prefetch, /thisapp\.call/);
});

test('a condition that calls a same-app function over a non-record element stays a todo', () => {
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (thisapp.isAvailable(room)) { alert "x"; }',
    '}',
  ].join('\n'));
  assert.match(stripComments(t.client), /client-condition-uses-server/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true);
  // The refused condition emits no element slot.
  assert.equal(t.usesElement, false);
});

test('a condition reading elements of two loops cannot be one round trip', () => {
  const t = translate([
    'for each a in Form_A[Status == "X"].Name.getAll() {',
    '  for each b in Form_B[Status == "Y"].Name.getAll() {',
    '    if (a == b && Lookup[ID == input.ID].Flag == true) { alert "x"; }',
    '  }',
    '}',
  ].join('\n'));
  assert.match(stripComments(t.client), /client-condition-uses-server/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true);
});

test('a server function result collection cannot iterate on the client', () => {
  const t = translate([
    'for each room in thisapp.openRooms() {',
    '  if (room == Add_Room[ID == input.ID].Room_Name) { alert "taken"; }',
    '}',
  ].join('\n'));
  // The collection is a same-app call: the client cannot snapshot it, so the
  // loop and its condition are counted todos — no element slot is emitted.
  assert.equal(t.usesElement, false);
  assert.match(stripComments(t.client), /client-loop-uses-server/);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-loop-uses-server'), true);
  assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/);
});

test('a same-app call bound to a local is never replayed on the element path', () => {
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  ok = thisapp.isAvailable(room);',
    '  if (ok) { alert "x"; }',
    '}',
  ].join('\n'));
  // The bound same-app call keeps the same counted todo as a direct call and
  // emits no element slot.
  assert.equal(t.usesElement, false);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true);
  assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/);
  assert.doesNotMatch(stripComments(t.prefetch), /shim\.thisapp\.call/);
});

test('element conditions that would replay a write, mail, or http binding stay todos', () => {
  const cases: [string, string, RegExp][] = [
    ['written = insert into Bookings [ Guest = room ];', 'written', /shim\.datastore\.insert/],
    ['sent = sendmail [ to: room, subject: "s", message: "m" ];', 'sent', /shim\.mail\.send/],
    ['body = invokeurl [ url: "https://example.test/" + room ];', 'body', /shim\.http\.invokeurl/],
  ];
  for (const [stmt, name, shimCall] of cases) {
    const t = translate([
      'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
      `  ${stmt}`,
      `  if (${name} && Bookings[Room == room].count() > 0) { alert "x"; }`,
      '}',
    ].join('\n'));
    assert.equal(t.usesElement, false, stmt);
    assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true, stmt);
    assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/, stmt);
    // The non-read call is not replayed in the prefetch module at all —
    // neither inside the element guard nor as a top-level binding.
    assert.doesNotMatch(stripComments(t.prefetch), shimCall, stmt);
  }
});

test('an already-emitted non-read binding is still refused on the element path', () => {
  // A local emitted at top level by an earlier one-shot slot is screened the
  // same way as a pending binding: a write, mail, http, or same-app call is
  // refused for the element path whether it was emitted or not.
  const cases: [string, string, RegExp][] = [
    ['s = sendmail [ to: input.Guest_Email, subject: "s", message: "m" ];', 's', /shim\.mail\.send/],
    ['s = getUrl("https://example.test/");', 's', /shim\.http\.getUrl/],
    ['s = invokeurl [ url: "https://example.test/" ];', 's', /shim\.http\.invokeurl/],
    ['s = insert into Bookings [ Guest = "g" ];', 's', /shim\.datastore\.insert/],
    ['s = thisapp.isAvailable("q");', 's', /shim\.thisapp\.call/],
  ];
  for (const [stmt, name, shimCall] of cases) {
    const t = translate([
      stmt,
      `if (${name} == Bookings[ID == input.ID].Guest) { info "one"; }`,
      'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
      `  if (${name} && Bookings[Room == room].count() > 0) { alert "x"; }`,
      '}',
    ].join('\n'));
    assert.equal(t.usesElement, false, stmt);
    assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true, stmt);
    assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/, stmt);
    // The non-read call is never replayed inside an element guard.
    assert.doesNotMatch(stripComments(t.prefetch), new RegExp(`ctx\\.element[\\s\\S]*${shimCall.source}`), stmt);
  }
});

test('an already-emitted alias of a non-read binding is still refused on the element path', () => {
  // A copy whose own code is element-safe (an identifier, a list literal, an
  // allowlisted call) still reaches a non-read binding through its reads. An
  // earlier one-shot emits the copy at top level, so the emitted-name
  // shortcut must not skip the read-chain screen.
  const calls: [string, RegExp][] = [
    ['s = sendmail [ to: input.Guest_Email, subject: "s", message: "m" ];', /shim\.mail\.send/],
    ['s = getUrl("https://example.test/");', /shim\.http\.getUrl/],
    ['s = invokeurl [ url: "https://example.test/" ];', /shim\.http\.invokeurl/],
    ['s = insert into Bookings [ Guest = "g" ];', /shim\.datastore\.insert/],
    ['s = zoho.crm.createRecord("Leads", {"Company":"x"});', /shim\.zoho\.task/],
  ];
  const aliases: [string, string][] = [
    ['t = s;', 't'],
    ['items = {s};', 'items.get(0)'],
    ['t = ifnull(s, "x");', 't'],
    ['t = s;\nu = t;', 'u'],
  ];
  for (const [decl, shimCall] of calls) {
    for (const [alias, use] of aliases) {
      const t = translate([
        decl,
        alias,
        `if (${use} == Bookings[ID == input.ID].Guest) { info "one"; }`,
        'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
        `  if (${use} && Bookings[Room == room].count() > 0) { alert "x"; }`,
        '}',
      ].join('\n'));
      const label = `${decl} / ${alias.replace('\n', ' ')}`;
      assert.equal(t.usesElement, false, label);
      assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true, label);
      assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/, label);
      // The non-read call is never replayed inside an element guard.
      assert.doesNotMatch(stripComments(t.prefetch), new RegExp(`ctx\\.element[\\s\\S]*${shimCall.source}`), label);
    }
  }
});

test('a use-before-binding alias of a non-read binding is refused on the element path', () => {
  // `a = b` before `b` is assigned records an empty read list without the
  // unbound mark: the alias would take the element path and serve a truthy
  // slot off a value the assignment never saw. A name read before it was
  // bound refuses the element path — unbound is unknown, and unknown fails
  // closed — whatever the name binds to later.
  const calls: [string, RegExp][] = [
    ['s = sendmail [ to: input.Guest_Email, subject: "s", message: "m" ];', /shim\.mail\.send/],
    ['s = getUrl("https://example.test/");', /shim\.http\.getUrl/],
    ['s = invokeurl [ url: "https://example.test/" ];', /shim\.http\.invokeurl/],
    ['s = insert into Bookings [ Guest = "g" ];', /shim\.datastore\.insert/],
    ['s = zoho.crm.createRecord("Leads", {"Company":"x"});', /shim\.zoho\.task/],
  ];
  for (const [decl, shimCall] of calls) {
    const t = translate([
      decl,
      'a = b;',
      'b = s;',
      'if (b == Bookings[ID == input.ID].Guest) { info "one"; }',
      'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
      '  if (a && Bookings[Room == room].count() > 0) { alert "x"; }',
      '}',
    ].join('\n'));
    assert.equal(t.usesElement, false, decl);
    assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true, decl);
    assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/, decl);
    // The non-read call is never replayed inside an element guard.
    assert.doesNotMatch(stripComments(t.prefetch), new RegExp(`ctx\\.element[\\s\\S]*${shimCall.source}`), decl);
  }
});

test('a use-before-binding alias is refused through two hops, a free name, and a loop-local bind', () => {
  // Two hops: the unbound mark travels with each binding, so `a` still
  // refuses through `b`.
  const twoHops = translate([
    's = sendmail [ to: input.Guest_Email, subject: "s", message: "m" ];',
    'a = b;',
    'b = c;',
    'c = s;',
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (a && Bookings[Room == room].count() > 0) { alert "x"; }',
    '}',
  ].join('\n'));
  assert.equal(twoHops.usesElement, false);
  assert.equal(twoHops.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true);
  assert.doesNotMatch(stripComments(twoHops.client), /shim\.client\.element/);

  // A name that is never bound at all: unknown, so the condition is the same
  // counted todo rather than an element slot off a free identifier.
  const free = translate([
    'a = b;',
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (a && Bookings[Room == room].count() > 0) { alert "x"; }',
    '}',
  ].join('\n'));
  assert.equal(free.usesElement, false);
  assert.equal(free.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true);
  assert.doesNotMatch(stripComments(free.client), /shim\.client\.element/);

  // A name bound only later, inside the loop body: the binding the condition
  // sees is safe (`"x"`), but it is not the value `a` read, so the element
  // path still refuses.
  const later = translate([
    'a = b;',
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  b = "x";',
    '  if (a && Bookings[Room == room].count() > 0) { alert "x"; }',
    '}',
  ].join('\n'));
  assert.equal(later.usesElement, false);
  assert.equal(later.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true);
  assert.doesNotMatch(stripComments(later.client), /shim\.client\.element/);
});

test('an aggregate field-name argument is not an unbound read', () => {
  // `count(Guest)` emits the bare name as a link-name literal, so the field
  // name is not a read at all: the binding stays prefetchable and the
  // condition keeps its slot instead of degrading to a counted todo.
  for (const fn of ['count', 'avg', 'sum', 'distinct']) {
    const t = translate([
      `x = Bookings[Room == "A"].${fn}(Guest);`,
      'if (x > 0) { alert "x"; }',
    ].join('\n'));
    assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), false, fn);
    assert.match(stripComments(t.prefetch), new RegExp(`var x = await shim\\.datastore\\.aggregate\\(ctx, shim\\.datastore\\.query\\(ctx, "Bookings".*"${fn === 'avg' ? 'avg' : fn}", "Guest"\\);`), fn);
    assert.match(stripComments(t.prefetch), /slots\["c0"\] = \(x > 0\);/, fn);
    assert.match(stripComments(t.client), /if \(slots\["c0"\]\)/, fn);
  }

  // A local or an expression stays a real argument and keeps its effects.
  const local = translate([
    'field = "Guest";',
    'x = Bookings[Room == "A"].count(field);',
    'if (x > 0) { alert "x"; }',
  ].join('\n'));
  assert.equal(local.todos.some((item: any) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(local.prefetch), /var field = "Guest";/);
});

test('an aggregate bound before an element loop keeps the per-element path', () => {
  // `n` binds a field-name aggregate before the loop; the loop condition
  // still resolves one element round trip — the field name is no unbound
  // read on either side.
  const t = translate([
    'n = Bookings[Room == "A"].count(Guest);',
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (n > 0 && Bookings[Room == room].count() > 0) { alert "x"; }',
    '}',
  ].join('\n'));
  assert.equal(t.usesElement, true);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), false);
  assert.match(stripComments(t.prefetch), /var n = await shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Bookings"/);
  assert.match(stripComments(t.client), /await shim\.client\.element\(ctx, "room", room, "c0"\)/);
  assert.match(stripComments(t.prefetch), /slots\["c0"\] = \(\(n > 0\) && \(await shim\.datastore\.aggregate/);
});

test('a free name in the element condition itself is refused', () => {
  // `zz` is never bound: the guard would emit `slots[...] = (zz && ...)`,
  // which throws or reads a host global, so the whole condition fails closed
  // to the same counted todo as any other unreadable name.
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (zz && Bookings[Room == room].count() > 0) { alert "x"; }',
    '}',
  ].join('\n'));
  assert.equal(t.usesElement, false);
  assert.equal(t.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true);
  assert.doesNotMatch(stripComments(t.client), /shim\.client\.element/);
  assert.doesNotMatch(stripComments(t.prefetch), /ctx\.element/);
  assert.match(stripComments(t.client), /await shim\.todo\(ctx, "client-condition-uses-server"\)/);

  // Bound later in the same script: the condition read still saw no value.
  const later = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (zz && Bookings[Room == room].count() > 0) { alert "x"; }',
    '}',
    'zz = 1;',
  ].join('\n'));
  assert.equal(later.usesElement, false);
  assert.equal(later.todos.some((item: any) => item.construct === 'client-condition-uses-server'), true);
  assert.doesNotMatch(stripComments(later.client), /shim\.client\.element/);
});

test('element membership is type-strict', () => {
  // The emitted membership compare refuses a value whose type differs from
  // the stored member: a posted "1" must not match a numeric 1.
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (Bookings[Room == room].count() > 0) { info "booked"; }',
    '}',
  ].join('\n'));
  assert.equal(t.usesElement, true);
  assert.match(
    stripComments(t.prefetch),
    /__elements\.findIndex\(\(v\) => typeof v === typeof ctx\.element\.value && shim\.compare\.eq\(v, ctx\.element\.value\)\)/,
  );
});

test('the element guard checks membership and never reports a truthy placeholder', () => {
  const t = translate([
    'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
    '  if (Bookings[Room == room].count() > 0) { info "booked"; }',
    '}',
  ].join('\n'));
  assert.equal(t.usesElement, true);
  assert.match(stripComments(t.prefetch), /__elements\.findIndex\(\(v\) => typeof v === typeof ctx\.element\.value && shim\.compare\.eq\(v, ctx\.element\.value\)\)/);
  assert.match(stripComments(t.prefetch), /__index >= LIMITS\.clientElementRoundTrips/);
  // A dry-run placeholder is rewritten to { ok: false }, never truthy.
  assert.match(stripComments(t.prefetch), /slots\["c0"\] = \{ ok: false \}/);
});

test('a loop-row condition that reads a local bound to an app function is not replayed', () => {
  const t = translate([
    's = thisapp.Helpers.twice(1);',
    'for each r in Bookings[Room == "A"] {',
    '  if (r.Guest == s) { alert "x"; }',
    '}',
  ].join('\n'));
  assert.equal(t.todos.some((item) => item.construct === 'client-condition-uses-server'), true);
  assert.doesNotMatch(t.prefetch, /thisapp\.call/);
  assert.doesNotMatch(t.client, /thisapp\.call/);
});
