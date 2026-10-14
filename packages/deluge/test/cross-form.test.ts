import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../../shims/src/runtime.js';
import { buildCatalogue, repoRoot } from '../src/catalogue.js';
import { CROSS_FORM_FREE_ARITIES, canonicalBuiltin } from '../src/dispatch.js';
import { translate } from '../src/translate.js';

function strip(s: string): string {
  return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, '').trim();
}

type Outcome = { value?: unknown; error?: string };

function body(code: string): (shim: unknown, ctx: unknown) => Promise<unknown> {
  return new Function('shim', 'ctx', `return (async () => {\n${code}\n})();`) as (shim: unknown, ctx: unknown) => Promise<unknown>;
}

async function run(src: string): Promise<Outcome> {
  const t = translate(src);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  try {
    return { value: await body(t.server)(runtime.shim, runtime.context({})) };
  } catch (e) {
    const err = e as Error;
    return { error: `${err.name}: ${err.message}` };
  }
}

function shape(src: string): { server: string; client: string; todo: boolean } {
  const t = translate(src);
  const server = strip(t.server);
  const client = strip(t.client);
  return { server, client, todo: /shim\.todo\(/.test(`${server}\n${client}`) || t.todos.length > 0 };
}

/**
 * Names whose other call form already had a translation. Each pair is the
 * same help page: the receiver is the function's first argument.
 */
const ROUTED: { name: string; free: (v: string) => string; method: (v: string) => string; inputs: string[] }[] = [
  {
    name: 'ceil',
    free: (v) => `v = ${v};\nreturn ceil(v);`,
    method: (v) => `v = ${v};\nreturn v.ceil();`,
    inputs: ['1.5', 'null', '""'],
  },
  {
    name: 'floor',
    free: (v) => `v = ${v};\nreturn floor(v);`,
    method: (v) => `v = ${v};\nreturn v.floor();`,
    inputs: ['1.5', 'null', '""'],
  },
  {
    name: 'log',
    free: (v) => `v = ${v};\nreturn log(v);`,
    method: (v) => `v = ${v};\nreturn v.log();`,
    inputs: ['1', 'null', '""'],
  },
  {
    name: 'power',
    free: (v) => `v = ${v};\nreturn power(v, 2);`,
    method: (v) => `v = ${v};\nreturn v.power(2);`,
    inputs: ['3', 'null', '""'],
  },
  {
    name: 'min',
    free: (v) => `v = ${v};\nreturn min(v, 2);`,
    method: (v) => `v = ${v};\nreturn v.min(2);`,
    inputs: ['3', 'null', '""'],
  },
  {
    name: 'max',
    free: (v) => `v = ${v};\nreturn max(v, 2);`,
    method: (v) => `v = ${v};\nreturn v.max(2);`,
    inputs: ['3', 'null', '""'],
  },
  {
    name: 'average',
    free: (v) => `v = ${v};\nreturn average(v);`,
    method: (v) => `v = ${v};\nreturn v.average();`,
    inputs: ['{1, 5, 2, 3}'],
  },
  {
    name: 'median',
    free: (v) => `v = ${v};\nreturn median(v);`,
    method: (v) => `v = ${v};\nreturn v.median();`,
    inputs: ['{1, 5, 2, 3}'],
  },
  {
    name: 'toLong',
    free: (v) => `v = ${v};\nreturn toLong(v);`,
    method: (v) => `v = ${v};\nreturn v.toLong();`,
    inputs: ['"12"', 'null', '""'],
  },
  {
    name: 'toNumber',
    free: (v) => `v = ${v};\nreturn toNumber(v);`,
    method: (v) => `v = ${v};\nreturn v.toNumber();`,
    inputs: ['"12"', 'null', '""'],
  },
  {
    name: 'toString',
    free: (v) => `v = ${v};\nreturn toString(v);`,
    method: (v) => `v = ${v};\nreturn v.toString();`,
    inputs: ['"abc"', 'null', '""'],
  },
  {
    name: 'concat',
    free: (v) => `v = ${v};\nreturn concat(v, "c");`,
    method: (v) => `v = ${v};\nreturn v.concat("c");`,
    inputs: ['"ab"', 'null', '""'],
  },
  {
    name: 'contains',
    free: (v) => `v = ${v};\nreturn contains(v, "b");`,
    method: (v) => `v = ${v};\nreturn v.contains("b");`,
    inputs: ['"abc"', 'null', '""'],
  },
  {
    name: 'endsWith',
    free: (v) => `v = ${v};\nreturn endsWith(v, "bc");`,
    method: (v) => `v = ${v};\nreturn v.endsWith("bc");`,
    inputs: ['"abc"', 'null', '""'],
  },
  {
    name: 'getPrefix',
    free: (v) => `v = ${v};\nreturn getPrefix(v, "-");`,
    method: (v) => `v = ${v};\nreturn v.getPrefix("-");`,
    inputs: ['"ab-cd"', 'null', '""'],
  },
  {
    name: 'remove',
    free: (v) => `v = ${v};\nreturn remove(v, "-");`,
    method: (v) => `v = ${v};\nreturn v.remove("-");`,
    inputs: ['"a-b"', 'null', '""'],
  },
  {
    name: 'replaceAll',
    free: (v) => `v = ${v};\nreturn replaceAll(v, "a", "x", false);`,
    method: (v) => `v = ${v};\nreturn v.replaceAll("a", "x", false);`,
    inputs: ['"aba"', 'null', '""'],
  },
  {
    name: 'replaceFirst',
    free: (v) => `v = ${v};\nreturn replaceFirst(v, "a", "x", false);`,
    method: (v) => `v = ${v};\nreturn v.replaceFirst("a", "x", false);`,
    inputs: ['"aba"', 'null', '""'],
  },
  {
    name: 'replaceAllIgnoreCase',
    free: (v) => `v = ${v};\nreturn replaceAllIgnoreCase(v, "A", "x", false);`,
    method: (v) => `v = ${v};\nreturn v.replaceAllIgnoreCase("A", "x", false);`,
    inputs: ['"aBa"', 'null', '""'],
  },
  {
    name: 'replaceFirstIgnoreCase',
    free: (v) => `v = ${v};\nreturn replaceFirstIgnoreCase(v, "A", "x", false);`,
    method: (v) => `v = ${v};\nreturn v.replaceFirstIgnoreCase("A", "x", false);`,
    inputs: ['"aBa"', 'null', '""'],
  },
  {
    name: 'toText',
    free: (v) => `v = ${v};\nreturn toText(v);`,
    method: (v) => `v = ${v};\nreturn v.toText();`,
    inputs: ['"12"', '100', '""'],
  },
  {
    name: 'subString',
    free: (v) => `v = ${v};\nreturn subString(v, 0);`,
    method: (v) => `v = ${v};\nreturn v.subString(0);`,
    inputs: ['"abcd"', 'null', '""'],
  },
];

test('function and method forms of a documented pair emit one shape and evaluate the same', async () => {
  for (const spec of ROUTED) {
    for (const input of spec.inputs) {
      const freeSrc = spec.free(input);
      const methodSrc = spec.method(input);
      const freeShape = shape(freeSrc);
      const methodShape = shape(methodSrc);
      assert.equal(freeShape.todo, false, freeSrc);
      assert.equal(methodShape.todo, false, methodSrc);
      assert.equal(freeShape.server, methodShape.server, freeSrc);
      assert.equal(freeShape.client, methodShape.client, freeSrc);
      assert.deepEqual(await run(freeSrc), await run(methodSrc), freeSrc);
    }
  }
  // List and text share the name. The receiver type picks the behaviour, and both call forms agree.
  for (const [freeSrc, methodSrc] of [
    ['v = {1, 2, 3};\nreturn contains(v, 2);', 'v = {1, 2, 3};\nreturn v.contains(2);'],
    ['v = {"a", "b"};\nreturn contains(v, "a");', 'v = {"a", "b"};\nreturn v.contains("a");'],
    ['v = {10, 20};\nreturn remove(v, 0);', 'v = {10, 20};\nreturn v.remove(0);'],
    ['return isEven(2);', 'return (2).isEven();'],
  ] as const) {
    const freeShape = shape(freeSrc);
    const methodShape = shape(methodSrc);
    assert.equal(freeShape.todo, false, freeSrc);
    assert.equal(freeShape.server, methodShape.server, freeSrc);
    assert.deepEqual(await run(freeSrc), await run(methodSrc), freeSrc);
  }
});

test('a pair with no translation on either form stays a hole, and a different function keeps its own translation', () => {
  for (const src of [
    'return now();',
    'return today();',
    'return edate("2020-01-01", 1);',
    'return "2020-01-01".edate(1);',
    'return subBusinessDay("2020-01-01", 1);',
    'return toHex(255);',
    'return Average();',
  ]) {
    assert.equal(shape(src).todo, true, src);
  }
  const aggregate = shape('return Orders.min(Amount);');
  assert.equal(aggregate.todo, false);
  assert.match(aggregate.server, /shim\.datastore\.aggregate/);
  assert.doesNotMatch(aggregate.server, /Math\.min/);
  const numberMin = shape('return (1).min(2);');
  assert.match(numberMin.server, /Math\.min\(1, 2\)/);
  const textContains = shape('return "abc".contains("b");');
  const listContains = shape('return {"a", "b"}.contains("a");');
  assert.match(textContains.server, /shim\.list\.contains/);
  assert.match(listContains.server, /shim\.list\.contains/);
});

test('a shimmed or supported builtin does not emit a todo hole', () => {
  const cat = buildCatalogue();
  for (const entry of cat.entries) {
    if (entry.status === 'todo') continue;
    const got = translate(entry.snippet);
    const bodyText = `${got.server}\n${got.client}`;
    assert.equal(/shim\.todo\(/.test(bodyText), false, `${entry.status} ${entry.name} :: ${entry.snippet}`);
    assert.equal(got.todos.length, 0, entry.snippet);
  }
});

test('the cross-form arity table is the help-page pair list', () => {
  const docs = JSON.parse(readFileSync(join(repoRoot(), 'packages/deluge/data/builtin-docs.json'), 'utf8')) as {
    entries: { name: string; form?: string; arity: number; docUrl: string | null }[];
  };
  const groups = new Map<string, typeof docs.entries>();
  for (const doc of docs.entries) {
    if (doc.form !== 'method' && doc.form !== 'free') continue;
    const key = `${doc.name.toLowerCase()}|${doc.docUrl ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(doc);
    groups.set(key, list);
  }
  const found = new Map<string, Set<number>>();
  for (const entries of groups.values()) {
    const methods = entries.filter((d) => d.form === 'method');
    const frees = entries.filter((d) => d.form === 'free');
    if (!methods.length || !frees.length) continue;
    const key = canonicalBuiltin(entries[0]!.name).toLowerCase();
    const set = found.get(key) ?? new Set<number>();
    for (const method of methods) {
      for (const free of frees) {
        if (free.arity === method.arity + 1) set.add(free.arity);
      }
    }
    if (set.size) found.set(key, set);
  }
  const fromDocs = [...found.keys()].sort().map((key) => `${key}=${[...found.get(key)!].sort((a, b) => a - b).join(',')}`);
  const fromTable = Object.keys(CROSS_FORM_FREE_ARITIES).sort().map((key) => `${key}=${CROSS_FORM_FREE_ARITIES[key]}`);
  assert.deepEqual(fromTable, fromDocs);
});
