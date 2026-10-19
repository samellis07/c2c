import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type App, type Workflow } from '../../core/src/index.js';
import { generate } from '../src/generate.js';

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

const Z = { start: 0, end: 0 };

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

function app(partial: Partial<App>): App {
  return { ...emptyApp('empty'), name: 'Demo_App', ...partial };
}

function plainField(name: string, type = 'text', subfields: string[] = []): App['forms'][number]['fields'][number] {
  return {
    name,
    type,
    modifiers: [],
    required: false,
    unique: false,
    properties: [],
    subfields: subfields.map((s) => plainField(s)),
    annotations: [],
    flags: [],
    span: Z,
  };
}

function plainForm(name: string, fields: App['forms'][number]['fields']): App['forms'][number] {
  return { name, properties: [], fields, actions: [], blocks: [], span: Z };
}

const RESERVATION_FORMS = [
  plainForm('Reservation', [plainField('Check_In', 'date'), plainField('Check_Out', 'date')]),
  plainForm('Pods', [plainField('Pod_No')]),
];

/** A client condition over two loop elements plus a server read: past the
 * element round-trip cap, so it is a server-condition candidate. */
function serverConditionApp(condition: string, prefix = ''): App {
  return app({
    forms: RESERVATION_FORMS,
    workflows: [
      workflow({
        name: 'Overlap check',
        form: 'Reservation',
        event: 'on user input',
        deluge: {
          text: `${prefix}for each a in Pods[ID != 0].Pod_No { for each b in Pods[ID != 0].Pod_No { if(${condition} && a == b && Reservation[ID != 0].count() > 0) { alert "overlap"; } else { alert "free"; } } }`,
          span: Z,
        },
      }),
    ],
  });
}

function condModules(g: ReturnType<typeof generate>): string[] {
  return g.files.filter((f) => /^functions\/custom\/c2ccond-[0-9a-f]+\.mjs$/.test(f.path) && !f.path.endsWith('-call.mjs')).map((f) => f.path);
}

function conditionTodos(g: ReturnType<typeof generate>): number {
  return g.todos.filter((t) => t.construct === 'client-condition-uses-server').length;
}

test('a condition that puts into a browser-passed map is not a server condition', () => {
  // The endpoint receives plain JSON copies of the caller's arguments and
  // answers `{ value }` only: a `m.put` admitted here would mutate a
  // discarded copy while the browser's map stays unchanged. It keeps its
  // counted todo instead.
  const g = generate(serverConditionApp('m.put("k", 1).get("k") == 1', 'm = {"a": 1};\n'));
  assert.equal(condModules(g).length, 0, 'no condition endpoint is emitted for a mutating condition');
  assert.equal(conditionTodos(g), 1, 'the mutating condition keeps its counted todo');
  assert.equal(g.files.some((f) => /c2ccond/.test(f.path)), false);
});

test('inline collection mutators in a server condition all fail closed', () => {
  // Every in-place collection write the translator can emit without a
  // sideEffect flag: each must refuse the server-condition route, not just
  // `put`. (`delete`/`insert`/`update` already carry sideEffect.)
  for (const [label, prefix, condition] of [
    ['add', 'ids = {1, 2};\n', 'ids.add(3).size() > 2'],
    ['remove', 'm = {"a": 1};\n', 'm.remove("a") == 1'],
    ['clear', 'm = {"a": 1};\n', 'm.clear() == null'],
    ['sort', 'ids = {2, 1};\n', 'ids.sort().get(0) == 1'],
    ['putAll', 'm = {"a": 1};\n', 'm.putAll({"k": 1}).get("k") == 1'],
  ] as const) {
    const g = generate(serverConditionApp(condition, prefix));
    assert.equal(condModules(g).length, 0, label);
    assert.equal(conditionTodos(g), 1, label);
  }
});

test('a condition that only reads a browser-passed map stays a server condition', () => {
  // Reads (`get`, `size`, `keys`) evaluate identically on the deserialized
  // copy, so a read-only condition over a caller-passed map is still
  // admitted: the guard refuses writes, not reads.
  const g = generate(serverConditionApp('m.get("k") == 1', 'm = {"a": 1};\n'));
  assert.equal(conditionTodos(g), 0);
  const modules = condModules(g);
  assert.equal(modules.length, 1);
  const body = stripComments(g.files.find((f) => f.path === modules[0])!.source);
  assert.doesNotMatch(body, /shim\.set\(/);
  assert.match(body, /shim\.list\.get\(m, "k"\)/);
});

test('a client-local put with no server read stays fully client-side', () => {
  // Nothing forces this condition to the server, so the `put` runs on the
  // client's own map with its normal semantics: no endpoint, no todo.
  const g = generate(
    app({
      forms: RESERVATION_FORMS,
      workflows: [
        workflow({
          name: 'Local put',
          form: 'Reservation',
          event: 'on user input',
          deluge: { text: 'm = {"a": 1};\nif(m.put("k", 1).get("k") == 1) { alert "hit"; } else { alert "miss"; }', span: Z },
        }),
      ],
    }),
  );
  assert.equal(condModules(g).length, 0);
  assert.equal(conditionTodos(g), 0);
});

test('a writing callee inside the condition expression keeps the counted todo', () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Hours')])],
      functions: [
        {
          name: 'Util.Write',
          kind: 'deluge',
          signature: 'bool Util.Write(int n)',
          deluge: [{ text: 'insert into Orders [ Hours = n ];\nreturn true;', span: Z }],
          properties: [],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'Write check',
          form: 'Orders',
          event: 'on user input',
          deluge: {
            text: 'for each a in Orders[ID != 0].Hours { for each b in Orders[ID != 0].Hours { if(thisapp.Util.Write(a) && Orders[ID != 0].count() > 0) { alert "w"; } } }',
            span: Z,
          },
        }),
      ],
    }),
  );
  assert.equal(condModules(g).length, 0, 'no condition endpoint is emitted for a writing callee');
  assert.equal(g.files.some((f) => f.path === 'functions/custom/util-write-call.mjs'), false);
  assert.equal(conditionTodos(g), 1);
});

test('a ui.add argument reading a client-bound map needs no endpoint and no todo', () => {
  // The `:ui.add(map.get(...))` shape from the hotel check-in flows: the
  // argument evaluates client-side against the client's own map.
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Choice')])],
      workflows: [
        workflow({
          name: 'load',
          form: 'Orders',
          event: 'on load',
          deluge: { text: 'available = {"Rooms": {"1A", "2A"}};\ninput.Choice:ui.add(available.get("Rooms"));', span: Z },
        }),
      ],
    }),
  );
  assert.equal(conditionTodos(g), 0);
  assert.equal(g.files.some((f) => f.path.endsWith('-call.mjs')), false);
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs')!;
  assert.match(stripComments(client.source), /shim\.list\.get\(available, "Rooms"\)/);
  assert.doesNotMatch(stripComments(client.source), /shim\.todo\(/);
});
