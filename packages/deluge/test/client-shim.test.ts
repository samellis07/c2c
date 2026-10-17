import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type Workflow } from '../../core/src/index.js';
import { unsupportedClientShims } from '../src/client-shim.js';
import { generate } from '../src/generate.js';
import { translate } from '../src/translate.js';

test('unsupportedClientShims names what the browser runtime lacks', () => {
  assert.deepEqual(unsupportedClientShims('if (!shim.list.contains(l, x)) shim.each(ctx, l); shim.list(); shim.client.call(ctx, "f", []);'), []);
  assert.deepEqual(
    unsupportedClientShims('shim.string.toUpperCase(a) + shim.list.aggregate(r, "sum") + shim.zoho.task(ctx, ["x"]) + shim.old.set(ctx, ["A"], 1) + shim.string.toUpperCase(b) + shim.xml'),
    ['list.aggregate', 'old.set', 'string.toUpperCase', 'xml', 'zoho.task'],
  );
  assert.deepEqual(unsupportedClientShims('var x = 1;'), []);
});

const SNIPPETS = [
  'l = {"a","b"};\nif (input.Name not in l) { alert "missing"; }',
  'x = input.Name.trim();\nif (x == "") { alert "empty"; }',
  'x = input.Name.toUpperCase();\nif (x == "") { alert "empty"; }',
  'input.Name = input.Name.trim();',
  'input.Name = input.Name.getPrefix(":").trim();',
  'input.Name = input.Name.getSuffix(":");',
  'd = toStartOfWeek(zoho.currentdate);\ninput.Name = d.toString();',
  'input.Price = input.Price.round(1);',
  'l = input.Name.toList();\nif (l.indexOf("x") >= 0) { alert "found"; }',
  'l = List();\nl.add(input.Name);\nl.sort(false);\nif (l.size() > 1 && l.distinct().indexOf("b") >= 0) { info l.get(0); }',
  'u = zoho.appuri;\ninput.Name = u;',
  'm = Map();\nm.put("k", input.Name);\nif (m.containsKey("k") && !m.isEmpty()) { info m.keys(); }',
  'if (input.Name.toUpperCase() == "A") { alert "upper"; }\ninfo "done";',
  'd = zoho.currentdate.addDay(1);\ninput.Name = d;',
];

test('translated client code references only shims the browser implements', () => {
  for (const src of SNIPPETS) {
    const out = translate(src, { inputFields: ['Name'] });
    assert.deepEqual(unsupportedClientShims(out.client), [], src);
  }
});

test('a client effect the browser cannot run is a client gap with no client code', () => {
  const out = translate('input.Name = input.Name.toUpperCase();\ninfo "done";', { inputFields: ['Name'] });
  assert.doesNotMatch(out.client, /shim\.string|shim\.input\.set/);
  assert.match(out.client, /"done"/);
  assert.match(out.server, /shim\.input\.set\(ctx, \["Name"\], shim\.string\.toUpperCase/);
  // The server part is unchanged, so server-only callers see no todo; the client emitter counts the gap.
  assert.deepEqual(out.todos, []);
  assert.equal(out.stats.todo, 0);
  assert.deepEqual(out.clientGaps, [{ todo: { construct: 'client-shim-unsupported', start: 0, end: 37 }, bucket: 'shimmed' }]);

  const alerted = translate('alert input.Name.toUpperCase();', { inputFields: ['Name'] });
  assert.doesNotMatch(alerted.client, /shim\.string/);
  assert.equal(alerted.clientGaps.length + (/slots\[/.test(alerted.client) ? 1 : 0), 1, 'the alert is prefetched or counted');

  const ok = translate('l = {"a"};\nif (input.Name not in l) { alert "missing"; }', { inputFields: ['Name'] });
  assert.match(ok.client, /shim\.list\.contains/);
  assert.deepEqual(ok.todos, []);
  assert.deepEqual(ok.clientGaps, []);
});

test('a local the browser cannot compute reads server-bound, so a condition on it is prefetched, not a gap', () => {
  const out = translate('x = input.Name.toUpperCase();\nif (x == "") { alert "empty"; }', { inputFields: ['Name'] });
  assert.doesNotMatch(out.client, /shim\.string/);
  assert.doesNotMatch(out.client.replace(/^\s*\/\/.*$/gm, ''), /\bx\b/);
  assert.match(out.client, /if \(slots\["c0"\]\)/);
  assert.match(out.prefetch, /shim\.string\.toUpperCase/);
  assert.deepEqual(out.clientGaps, []);
  assert.deepEqual(out.todos, []);

  const direct = translate('if (input.Name.toUpperCase() == "A") { alert "upper"; }\ninfo "done";', { inputFields: ['Name'] });
  assert.doesNotMatch(direct.client.replace(/^\s*\/\/.*$/gm, ''), /toUpperCase/);
  assert.match(direct.client, /if \(slots\["c0"\]\)/);
  assert.deepEqual(direct.clientGaps, []);
});

test('the form handler emitter counts a client gap; a server-only script does not', () => {
  const span = { start: 0, end: 0 };
  const text = 'input.Name = input.Name.toUpperCase();\ninfo "done";';
  const handler: Workflow = { name: 'Check', form: 'Orders', event: 'on user input', deluge: { text, span }, properties: [], span };
  const g = generate({ ...emptyApp('empty'), name: 'Demo_App', workflows: [handler] });
  assert.deepEqual(g.todos.map((t) => t.construct), ['client-shim-unsupported']);
  assert.equal(g.stats.todo, 1);
  assert.equal(g.stats.statements, g.stats.translated + g.stats.shimmed + g.stats.todo);
  for (const f of g.files) if (f.path.startsWith('client/')) assert.deepEqual(unsupportedClientShims(f.source), [], f.path);

  const ok = generate({ ...emptyApp('empty'), name: 'Demo_App', workflows: [{ ...handler, deluge: { text: 'l = {"a"};\nif (input.Name not in l) { alert "missing"; }', span } }] });
  assert.deepEqual(ok.todos, []);
});

test('newly client-supported builtins emit client code; unsupported siblings keep their gap', () => {
  const supported: [string, RegExp][] = [
    ['input.Name = input.Name.trim();', /shim\.string\.trim\(shim\.input\.get/],
    ['input.Name = input.Name.getPrefix(":");', /shim\.string\.getPrefix\(shim\.input\.get/],
    ['input.Name = input.Name.getSuffix(":");', /shim\.string\.getSuffix\(shim\.input\.get/],
    ['d = toStartOfWeek(zoho.currentdate);\ninput.Name = d.toString();', /shim\.date\.toStartOfWeek\(shim\.zoho\.currentDate/],
    ['input.Price = input.Price.round(1);', /shim\.math\.round\(shim\.input\.get/],
    ['input.Name = input.Name.toList().indexOf("x");', /shim\.convert\.toList\(shim\.input\.get/],
  ];
  for (const [src, want] of supported) {
    const out = translate(src, { inputFields: ['Name', 'Price'] });
    assert.match(out.client, want, src);
    assert.deepEqual(unsupportedClientShims(out.client), [], src);
    assert.deepEqual(out.clientGaps, [], src);
  }

  // Sibling names the browser still lacks keep the SAME counted todo.
  const gap = translate('input.Name = input.Name.toStartOfMonth();', { inputFields: ['Name'] });
  assert.doesNotMatch(gap.client, /shim\.date\.toStartOfMonth/);
  assert.deepEqual(gap.clientGaps, [{ todo: { construct: 'client-shim-unsupported', start: 0, end: 40 }, bucket: 'shimmed' }]);

  const map = translate('input.Name = input.Name.toMap();', { inputFields: ['Name'] });
  assert.doesNotMatch(map.client, /shim\.convert\.toMap/);
  assert.equal(map.clientGaps.length, 1);

  const math = translate('input.Price = input.Price.sqrt();', { inputFields: ['Name', 'Price'] });
  assert.doesNotMatch(math.client, /shim\.math\.sqrt/);
  assert.equal(math.clientGaps.length, 1);
});
