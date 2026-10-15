import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate } from '../src/index.js';
import { cataloguePath, type Catalogue } from '../src/catalogue.js';
import { createRuntime } from '../../shims/src/runtime.js';

test('aggregate task forms translate to shim.datastore.aggregate', () => {
  const code = `
    a = Count(Orders[Amount > 10]);
    b = Sum(Orders[Amount > 10].Amount);
    c = Maximum(Orders.Qty);
    d = Minimum(Orders[ID == 123].Price);
    e = Average(Orders.Price);
    f = Distinct(Orders.Status);
    g = Median(Orders.Qty);
  `;
  const t = translate(code);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: ">", field: "Amount", value: 10 \}\), "count", undefined\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: ">", field: "Amount", value: 10 \}\), "sum", "Amount"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), "max", "Qty"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "==", field: "ID", value: 123 \}\), "min", "Price"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), "avg", "Price"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), "distinct", "Status"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), "median", "Qty"\)/);
});

test('aggregate task evaluation with dryRun fallback', async () => {
  const RT = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalDeluge = async (src: string) => {
    const t = translate(src);
    const body = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`);
    return body(RT.shim, RT.context({ record: {} }));
  };

  assert.equal(await evalDeluge('out = Count(Orders[ID == 1]);'), 0);
  assert.equal(await evalDeluge('out = Sum(Orders[ID == 2].Amount);'), null);
  assert.equal(await evalDeluge('out = Average(Orders[ID == 3].Amount);'), null);
  assert.equal(await evalDeluge('out = Maximum(Orders[ID == 4].Amount);'), null);
  assert.equal(await evalDeluge('out = Minimum(Orders[ID == 5].Amount);'), null);
  assert.equal(await evalDeluge('out = Median(Orders[ID == 6].Amount);'), null);
  assert.equal(await evalDeluge('out = Distinct(Orders[ID == 7].Amount);'), null);
});

test('lowercase aggregate function forms use the same datastore shim', () => {
  const code = `
    a = count(Orders[Amount > 10]);
    b = sum(Orders[Amount > 10].Amount);
    c = maximum(Orders.Qty);
    d = minimum(Orders[ID == 123].Price);
    e = average(Orders.Price);
    f = distinct(Orders.Status);
    g = median(Orders.Qty);
  `;
  const t = translate(code);
  assert.doesNotMatch(t.server, /shim\.todo\(/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: ">", field: "Amount", value: 10 \}\), "count", undefined\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: ">", field: "Amount", value: 10 \}\), "sum", "Amount"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), "max", "Qty"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "==", field: "ID", value: 123 \}\), "min", "Price"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), "avg", "Price"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), "distinct", "Status"\)/);
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", \{ op: "true" \}\), "median", "Qty"\)/);
});

test('a shimmed or supported ledger snippet does not emit shim.todo', () => {
  const committed = JSON.parse(readFileSync(cataloguePath(), 'utf8')) as Catalogue;
  const bad: string[] = [];
  for (const entry of committed.entries) {
    if (entry.status !== 'shimmed' && entry.status !== 'supported') continue;
    const result = translate(entry.snippet);
    const code = [result.server, result.client, result.prefetch]
      .join('\n')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    if (result.todos.length > 0 || /shim\.todo\(/.test(code)) bad.push(`${entry.status} ${entry.name} :: ${entry.snippet}`);
  }
  assert.deepEqual(bad, []);
});

test('Sum on a local list or list expression uses shim.list.aggregate', async () => {
  const RT = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const evalOut = async (src: string) => {
    const t = translate(src);
    const body = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`);
    return body(RT.shim, RT.context({ record: {} }));
  };
  const pairs = [
    ['myList = {1, null, 4};\nout = Sum(myList);', 'myList = {1, null, 4};\nout = myList.sum();', 5],
    ['out = Sum(List());', 'out = List().sum();', null],
    ['out = sum({null, null});', 'out = {null, null}.sum();', null],
  ] as const;
  for (const [fnSrc, methodSrc, expected] of pairs) {
    const fn = translate(fnSrc);
    const method = translate(methodSrc);
    assert.match(fn.server, /shim\.list\.aggregate\(/);
    assert.doesNotMatch(fn.server, /shim\.todo\(/);
    assert.match(method.server, /shim\.list\.aggregate\(/);
    assert.equal(await evalOut(fnSrc), expected);
    assert.equal(await evalOut(fnSrc), await evalOut(methodSrc));
  }
  const names = ['average', 'count', 'median', 'maximum', 'minimum', 'distinct'] as const;
  const inputs = ['{1, null, 4}', 'List()', '{null, null}'] as const;
  for (const name of names) {
    for (const input of inputs) {
      const fnSrc = `out = ${name}(${input});`;
      const methodSrc = `out = ${input}.${name}();`;
      const fn = translate(fnSrc);
      assert.match(fn.server, /shim\.list\.aggregate\(/, fnSrc);
      assert.doesNotMatch(fn.server, /shim\.todo\(/, fnSrc);
      if ((name === 'average' || name === 'median') && input.includes('null')) {
        assert.ok(fn.todos.some((item) => item.construct === `call:${name}`), `${fnSrc} should be counted`);
        await assert.rejects(evalOut(fnSrc), /expected numeric list members/);
        await assert.rejects(evalOut(methodSrc), /expected numeric list members/);
        continue;
      }
      assert.deepEqual(await evalOut(fnSrc), await evalOut(methodSrc));
    }
  }
});

test('a function-form aggregate with extra arguments emits shim.todo (arg dropped silently fix)', () => {
  const t1 = translate('out = sum({1, 2}, 9);');
  assert.match(t1.server, /shim\.todo\(/);
  assert.doesNotMatch(t1.server, /shim\.list\.aggregate/);

  const t2 = translate('out = Maximum(Orders.Qty, 10);');
  assert.match(t2.server, /shim\.todo\(/);
  assert.doesNotMatch(t2.server, /shim\.list\.aggregate/);

  const local = translate('a = {1, 2};\nout = Sum(a, 9);');
  assert.match(local.server, /shim\.todo\(ctx, "call:Sum"\)/);
  assert.doesNotMatch(local.server, /shim\.list\.aggregate/);

  const maxLocal = translate('x = {1, 2};\nout = maximum(x, 10);');
  assert.match(maxLocal.server, /shim\.todo\(ctx, "call:maximum"\)/);
  assert.doesNotMatch(maxLocal.server, /shim\.list\.aggregate/);
});

test('a script-defined function named sum/count does not trigger the aggregate capture', () => {
  const t = translate('out = sum({1, 2});', { functions: ['sum'] });
  assert.match(t.server, /shim\.todo\(ctx, "call:sum"\)/);
  assert.doesNotMatch(t.server, /shim\.list\.aggregate/);

  const upper = translate('out = SUM({1, 2});', { functions: ['Sum'] });
  assert.match(upper.server, /shim\.todo\(ctx, "call:SUM"\)/);
  assert.doesNotMatch(upper.server, /shim\.list\.aggregate/);

  const count = translate('out = Count({1, 2});', { functions: ['count'] });
  assert.match(count.server, /shim\.todo\(ctx, "call:Count"\)/);
  assert.doesNotMatch(count.server, /shim\.list\.aggregate/);
});

test('sum(m.k) on a map member translates exactly like m.k.sum()', () => {
  const t1 = translate('m = {"k": {1, 2}}; out = sum(m.k);');
  const t2 = translate('m = {"k": {1, 2}}; out = m.k.sum();');
  assert.equal(t1.server.replace(/\/\/ Deluge: .*\n/g, ''), t2.server.replace(/\/\/ Deluge: .*\n/g, ''));
  assert.match(t1.server, /shim\.list\.aggregate/);
});

function codeLines(src: string): string {
  return src.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
}

test('a datastore aggregate of a decimal column stays exact in later arithmetic', () => {
  const sum = codeLines(translate('s = Sum(Orders.Amount);\nout = s * 2 + s;', { decimalFields: ['Amount'] }).server);
  assert.match(sum, /shim\.decimal\.mul\(/);
  assert.match(sum, /shim\.decimal\.add\(/);
  assert.doesNotMatch(sum, / \* /);

  const method = codeLines(translate('s = Orders.sum(Amount);\nout = s * 2;', { decimalFields: ['Amount'] }).server);
  assert.match(method, /shim\.decimal\.mul\(/);
  assert.doesNotMatch(method, / \* /);

  // count and distinct are not decimals. A non-decimal field stays a JS number.
  // These must fail if every aggregate result is marked exact.
  const count = codeLines(translate('n = Count(Orders[ID != 0]);\nout = n * 2;', { decimalFields: ['Amount'] }).server);
  assert.match(count, / \* /);
  assert.doesNotMatch(count, /shim\.decimal\.mul\(/);

  const countField = codeLines(translate('n = Orders.count(Amount);\nout = n * 2;', { decimalFields: ['Amount'] }).server);
  assert.match(countField, / \* /);
  assert.doesNotMatch(countField, /shim\.decimal\.mul\(/);

  const qty = codeLines(translate('s = Sum(Orders.Qty);\nout = s * 2;', { decimalFields: ['Amount'] }).server);
  assert.match(qty, / \* /);
  assert.doesNotMatch(qty, /shim\.decimal\.mul\(/);

  const distinct = codeLines(translate('s = Distinct(Orders.Amount);', { decimalFields: ['Amount'] }).server);
  assert.doesNotMatch(distinct, /shim\.decimal\./);
});

test('a string argument is not an in-memory list aggregate', () => {
  const literal = translate('out = sum("localStringVar");');
  assert.match(literal.server, /shim\.todo\(ctx, "call:sum"\)/);
  assert.doesNotMatch(literal.server, /shim\.list\.aggregate/);

  const variable = translate('localStringVar = "x";\nout = average(localStringVar);');
  assert.match(variable.server, /shim\.todo\(ctx, "call:average"\)/);
  assert.doesNotMatch(variable.server, /shim\.list\.aggregate/);

  const median = translate('out = median("x");');
  assert.match(median.server, /shim\.todo\(ctx, "call:median"\)/);
  assert.doesNotMatch(median.server, /shim\.list\.aggregate/);
});

test('count() on a record-typed function parameter emits the record cardinality', async () => {
  // A parameter holding one record or a record collection counts as 1, its
  // rows, or 0 for null — without a Data Store read.
  // (record count: https://www.zoho.com/deluge/help/data-access/aggregate-records/count.html)
  const t = translate('string countIt(Faculty_Details d) { return d.count(); }');
  assert.doesNotMatch(t.server, /shim\.todo\(/);
  assert.doesNotMatch(t.server, /shim\.datastore\.aggregate/);
  assert.match(t.server, /\(d \? \(Array\.isArray\(d\) \? d\.length : 1\) : 0\)/);
  const run = new Function('ctx', 'd', `${t.server}\nreturn countIt(ctx, d);`) as (ctx: unknown, d: unknown) => Promise<unknown>;
  assert.equal(await run({}, { ID: 1 }), 1);
  assert.equal(await run({}, [{ ID: 1 }, { ID: 2 }, { ID: 3 }]), 3);
  assert.equal(await run({}, null), 0);
});

test('a record-typed parameter guard `if (faculty_Obj.count() != 0)` needs no Data Store read', () => {
  const t = translate(
    [
      'string checkIt(Faculty_Details faculty_Obj) {',
      '  if (faculty_Obj.count() != 0) {',
      '    return "yes";',
      '  }',
      '  return "no";',
      '}',
    ].join('\n'),
  );
  assert.doesNotMatch(t.server, /method:count/);
  assert.doesNotMatch(t.server, /shim\.todo\(/);
  assert.match(
    t.server,
    /\(faculty_Obj \? \(Array\.isArray\(faculty_Obj\) \? faculty_Obj\.length : 1\) : 0\)/,
  );
});

const facultySeed = {
  Faculty: [
    { ROWID: '1', Name: 'a' },
    { ROWID: '2', Name: 'b' },
    { ROWID: '3', Name: 'c' },
  ],
};

async function evalSeeded(src: string, options?: { formNames?: string[] }) {
  const rt = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: facultySeed });
  const t = translate(src, options);
  const body = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`);
  const value = await body(rt.shim, rt.context({ record: {} }));
  return { value, server: t.server, todos: t.todos.map((item) => item.construct), transcript: rt.transcript };
}

test('count() on a fetch local is the number of matching rows', async () => {
  const zero = await evalSeeded('faculty_Obj = Faculty[ID == 99];\nout = faculty_Obj.count();');
  const one = await evalSeeded('faculty_Obj = Faculty[ID == 2];\nout = faculty_Obj.count();');
  const three = await evalSeeded('faculty_Obj = Faculty[ID != 0];\nout = faculty_Obj.count();');
  assert.equal(zero.value, 0);
  assert.equal(one.value, 1);
  assert.equal(three.value, 3);
  for (const result of [zero, one, three]) {
    assert.deepEqual(result.todos, []);
    assert.match(result.server, /shim\.datastore\.aggregate\(ctx, faculty_Obj, "count", undefined\)/);
    assert.equal(result.server.match(/shim\.datastore\.query\(/g)?.length, 1);
    assert.deepEqual(result.transcript.map((entry) => entry.op), ['aggregate']);
  }

  const eq1 = await evalSeeded('faculty_Obj = Faculty[ID == 2];\nif(faculty_Obj.count() == 1) { out = "yes"; } else { out = "no"; }');
  const eq1many = await evalSeeded('faculty_Obj = Faculty[ID != 0];\nif(faculty_Obj.count() == 1) { out = "yes"; } else { out = "no"; }');
  const ne0 = await evalSeeded('faculty_Obj = Faculty[ID != 0];\nif(faculty_Obj.count() != 0) { out = "yes"; } else { out = "no"; }');
  const ne0none = await evalSeeded('faculty_Obj = Faculty[ID == 99];\nif(faculty_Obj.count() != 0) { out = "yes"; } else { out = "no"; }');
  assert.equal(eq1.value, 'yes');
  assert.equal(eq1many.value, 'no');
  assert.equal(ne0.value, 'yes');
  assert.equal(ne0none.value, 'no');

  const text = translate('localStringVar = "x";\nout = localStringVar.count();');
  assert.match(text.server, /Array\.isArray\(localStringVar\)/);
  assert.doesNotMatch(text.server, /shim\.datastore\.aggregate/);
});

test('count() on a row binding counts the fetch it was given', async () => {
  const opts = { rowNames: ['faculty_Obj'] };
  const t = translate('out = faculty_Obj.count();', opts);
  assert.ok(!t.todos.some((item) => item.construct === 'method:count'));
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, faculty_Obj, "count", undefined\)/);
  assert.doesNotMatch(t.server, /shim\.datastore\.query\(/);

  const rt = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: facultySeed });
  let aggregates = 0;
  const orig = rt.shim.datastore.aggregate.bind(rt.shim.datastore);
  rt.shim.datastore.aggregate = async (ctx, query, fn, field) => {
    aggregates += 1;
    return orig(ctx, query, fn, field);
  };
  const ctx = rt.context({ record: {} });
  const run = async (src: string, arg: unknown) => {
    const translated = translate(src, opts);
    const body = new Function('shim', 'ctx', 'faculty_Obj', `return (async () => {\n${translated.server}\nreturn out;\n})();`);
    return body(rt.shim, ctx, arg);
  };
  const queryFor = (criteria: { op: '==' | '!='; field: string; value: number }) => rt.shim.datastore.query(ctx, 'Faculty', criteria);

  aggregates = 0;
  assert.equal(await run('out = faculty_Obj.count();', queryFor({ op: '==', field: 'ID', value: 99 })), 0);
  assert.equal(aggregates, 1);
  aggregates = 0;
  assert.equal(await run('out = faculty_Obj.count();', queryFor({ op: '==', field: 'ID', value: 2 })), 1);
  assert.equal(aggregates, 1);
  aggregates = 0;
  assert.equal(await run('out = faculty_Obj.count();', queryFor({ op: '!=', field: 'ID', value: 0 })), 3);
  assert.equal(aggregates, 1);

  aggregates = 0;
  assert.equal(await run('out = faculty_Obj.count();', null), 0);
  assert.equal(await run('out = faculty_Obj.count();', { ID: 2 }), 1);
  assert.equal(await run('out = faculty_Obj.count();', [{ ID: 1 }, { ID: 2 }, { ID: 3 }]), 3);
  assert.equal(aggregates, 0);

  assert.equal(await run('if(faculty_Obj.count() == 1) { out = "yes"; } else { out = "no"; }', queryFor({ op: '==', field: 'ID', value: 2 })), 'yes');
  assert.equal(await run('if(faculty_Obj.count() == 1) { out = "yes"; } else { out = "no"; }', queryFor({ op: '!=', field: 'ID', value: 0 })), 'no');
  assert.equal(await run('if(faculty_Obj.count() != 0) { out = "yes"; } else { out = "no"; }', queryFor({ op: '!=', field: 'ID', value: 0 })), 'yes');
  assert.equal(await run('if(faculty_Obj.count() != 0) { out = "yes"; } else { out = "no"; }', queryFor({ op: '==', field: 'ID', value: 99 })), 'no');

  const text = translate('localStringVar = "x";\nout = localStringVar.count();', opts);
  assert.match(text.server, /Array\.isArray\(localStringVar\)/);
  const reassigned = translate('faculty_Obj = "x";\nout = faculty_Obj.count();', opts);
  assert.match(reassigned.server, /Array\.isArray\(faculty_Obj\)/);
  assert.doesNotMatch(reassigned.server, /shim\.datastore\.aggregate/);
});
