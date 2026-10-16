import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type Workflow } from '../../core/src/index.js';
import { unsupportedClientShims } from '../src/client-shim.js';
import { generate } from '../src/generate.js';
import { translate } from '../src/translate.js';

test('unsupportedClientShims names what the browser runtime lacks', () => {
  assert.deepEqual(unsupportedClientShims('if (!shim.list.contains(l, x)) shim.each(ctx, l); shim.list(); shim.client.call(ctx, "f", []);'), []);
  assert.deepEqual(
    unsupportedClientShims('shim.string.trim(a) + shim.list.aggregate(r, "sum") + shim.zoho.task(ctx, ["x"]) + shim.old.set(ctx, ["A"], 1) + shim.string.trim(b) + shim.xml'),
    ['list.aggregate', 'old.set', 'string.trim', 'xml', 'zoho.task'],
  );
  assert.deepEqual(unsupportedClientShims('var x = 1;'), []);
});

const SNIPPETS = [
  'l = {"a","b"};\nif (input.Name not in l) { alert "missing"; }',
  'x = input.Name.trim();\nif (x == "") { alert "empty"; }',
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
  const out = translate('input.Name = input.Name.trim();\ninfo "done";', { inputFields: ['Name'] });
  assert.doesNotMatch(out.client, /shim\.string|shim\.input\.set/);
  assert.match(out.client, /"done"/);
  assert.match(out.server, /shim\.input\.set\(ctx, \["Name"\], shim\.string\.trim/);
  // The server part is unchanged, so server-only callers see no todo; the client emitter counts the gap.
  assert.deepEqual(out.todos, []);
  assert.equal(out.stats.todo, 0);
  assert.deepEqual(out.clientGaps, [{ todo: { construct: 'client-shim-unsupported', start: 0, end: 30 }, bucket: 'shimmed' }]);

  const alerted = translate('alert input.Name.trim();', { inputFields: ['Name'] });
  assert.doesNotMatch(alerted.client, /shim\.string/);
  assert.equal(alerted.clientGaps.length + (/slots\[/.test(alerted.client) ? 1 : 0), 1, 'the alert is prefetched or counted');

  const ok = translate('l = {"a"};\nif (input.Name not in l) { alert "missing"; }', { inputFields: ['Name'] });
  assert.match(ok.client, /shim\.list\.contains/);
  assert.deepEqual(ok.todos, []);
  assert.deepEqual(ok.clientGaps, []);
});

test('a local the browser cannot compute reads server-bound, so a condition on it is prefetched, not a gap', () => {
  const out = translate('x = input.Name.trim();\nif (x == "") { alert "empty"; }', { inputFields: ['Name'] });
  assert.doesNotMatch(out.client, /shim\.string/);
  assert.doesNotMatch(out.client.replace(/^\s*\/\/.*$/gm, ''), /\bx\b/);
  assert.match(out.client, /if \(slots\["c0"\]\)/);
  assert.match(out.prefetch, /shim\.string\.trim/);
  assert.deepEqual(out.clientGaps, []);
  assert.deepEqual(out.todos, []);

  const direct = translate('if (input.Name.toUpperCase() == "A") { alert "upper"; }\ninfo "done";', { inputFields: ['Name'] });
  assert.doesNotMatch(direct.client.replace(/^\s*\/\/.*$/gm, ''), /toUpperCase/);
  assert.match(direct.client, /if \(slots\["c0"\]\)/);
  assert.deepEqual(direct.clientGaps, []);
});

test('the form handler emitter counts a client gap; a server-only script does not', () => {
  const span = { start: 0, end: 0 };
  const text = 'input.Name = input.Name.trim();\ninfo "done";';
  const handler: Workflow = { name: 'Check', form: 'Orders', event: 'on user input', deluge: { text, span }, properties: [], span };
  const g = generate({ ...emptyApp('empty'), name: 'Demo_App', workflows: [handler] });
  assert.deepEqual(g.todos.map((t) => t.construct), ['client-shim-unsupported']);
  assert.equal(g.stats.todo, 1);
  assert.equal(g.stats.statements, g.stats.translated + g.stats.shimmed + g.stats.todo);
  for (const f of g.files) if (f.path.startsWith('client/')) assert.deepEqual(unsupportedClientShims(f.source), [], f.path);

  const ok = generate({ ...emptyApp('empty'), name: 'Demo_App', workflows: [{ ...handler, deluge: { text: 'l = {"a"};\nif (input.Name not in l) { alert "missing"; }', span } }] });
  assert.deepEqual(ok.todos, []);
});

test('a server-only for each over a form criteria is not a client gap', () => {
  // The field write needs string.trim, which the browser shim does not
  // implement, so a unit that ships a client half still counts that one gap.
  // The form fetch is in the same script: serverOnly keeps its server loop and
  // counts nothing, because that client half is thrown away.
  const src = `input.Name = input.Name.trim();
for each rec in Orders[ID != 0] sort by Added_Time desc
{
  n = rec.Name;
  alert n;
}`;
  const opts = { formNames: ['Orders'], formFields: { Orders: ['ID', 'Added_Time', 'Name'] }, inputFields: ['Name'] };
  const only = translate(src, { ...opts, serverOnly: true });
  assert.equal(only.clientGaps.length, 0);
  assert.equal(only.client, '');
  assert.match(only.server, /for \(var /);
  assert.match(only.server, /shim\.datastore\.rows/);

  const open = translate(src, opts);
  assert.equal(open.clientGaps.length, 1);
  assert.equal(open.clientGaps[0]!.todo.construct, 'client-shim-unsupported');
  assert.equal(src.slice(open.clientGaps[0]!.todo.start, open.clientGaps[0]!.todo.end), 'input.Name = input.Name.trim()');
  assert.match(open.client, /for \(var /);
  assert.doesNotMatch(open.client, /shim\.datastore/);
});
