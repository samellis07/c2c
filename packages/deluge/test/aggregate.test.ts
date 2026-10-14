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
