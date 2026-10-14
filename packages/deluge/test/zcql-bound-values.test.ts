import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/translate.js';
import { compileCriteria } from '../../shims/src/criteria.js';
import { createRuntime } from '../../shims/src/runtime.js';

/**
 * A record-criteria value is one ZCQL literal. The query text around that
 * literal is the same for every value. A quote inside the value is doubled
 * inside the literal; it does not close the literal or add another predicate.
 */
function delugeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    if (ch === '\\' || ch === '"') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return `${out}"`;
}

const CASES: { name: string; value: string | null }[] = [
  { name: 'quote', value: "it's" },
  { name: 'predicate text', value: "' OR 1=1" },
  { name: 'backslash', value: 'a\\b' },
  { name: 'newline', value: 'a\nb' },
  { name: 'criteria text', value: "Total > 100 OR Status = 'x'" },
  { name: 'digit text', value: '100' },
  { name: 'null', value: null },
];

function stripComments(source: string): string {
  return source.replace(/^\s*\/\/ Deluge: .*\n?/gm, '');
}

/** The single-quoted span of a ZCQL literal, with `''` read back as one quote. */
function readQuoted(sql: string): { start: number; end: number; text: string } | null {
  const start = sql.indexOf("'");
  if (start < 0) return null;
  let text = '';
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      if (sql[i + 1] === "'") {
        text += "'";
        i += 2;
        continue;
      }
      return { start, end: i + 1, text };
    }
    text += ch;
    i += 1;
  }
  return null;
}

function skeleton(where: string, value: string | null): string {
  if (value === null) {
    assert.equal(where, 'Field = null');
    assert.equal(where.includes("'"), false);
    return 'Field = §';
  }
  const quoted = `'${value.replace(/'/g, "''")}'`;
  assert.equal(where, `Field = ${quoted}`);
  const read = readQuoted(where);
  assert.ok(read, `${where} has one quoted literal`);
  assert.equal(read.text, value);
  assert.equal(read.start, 'Field = '.length);
  assert.equal(read.end, where.length);
  const outside = where.slice(0, read.start) + where.slice(read.end);
  assert.equal(outside.includes("'"), false);
  return `${outside.slice(0, read.start)}§`;
}

async function dryWhere(value: string | null): Promise<{ where: string; server: string }> {
  const literal = value === null ? 'null' : delugeString(value);
  const src = `got = Form[Field == ${literal}].Name;`;
  const translated = translate(src, { formNames: ['Form'], formFields: { Form: ['Field', 'Name'] } });
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const run = new Function('shim', 'ctx', `return (async () => {\n${translated.server}\n})();`) as (
    shim: ReturnType<typeof createRuntime>['shim'],
    ctx: ReturnType<ReturnType<typeof createRuntime>['context']>,
  ) => Promise<unknown>;
  await run(runtime.shim, runtime.context({ record: {} }));
  const hit = runtime.transcript.find((entry) => entry.op === 'field');
  assert.ok(hit, 'dry-run records the field read');
  assert.equal(typeof hit.where, 'string');
  return { where: hit.where as string, server: stripComments(translated.server) };
}

test('Form[Field == x] binds each value as one ZCQL literal and keeps the query text', async () => {
  const shapes: string[] = [];
  const scripts: string[] = [];
  for (const item of CASES) {
    const { where, server } = await dryWhere(item.value);
    const compiled = compileCriteria({ op: '==', field: 'Field', value: item.value });
    assert.equal(compiled, where, item.name);
    shapes.push(skeleton(where, item.value));
    const token = item.value === null ? 'null' : JSON.stringify(item.value);
    const bound = `value: ${token}`;
    assert.equal(server.split(bound).length - 1, 1, `${item.name} is one bound value in the generated script`);
    assert.doesNotMatch(server, /\bSELECT\b|\bWHERE\b/);
    scripts.push(server.replace(bound, 'value: §'));
  }
  assert.equal(new Set(shapes).size, 1);
  assert.equal(shapes[0], 'Field = §');
  assert.equal(new Set(scripts).size, 1);
});
