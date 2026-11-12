import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { DelugeDate } from '../../shims/src/date.js';
import { appTranslateOptions } from '../src/generate.js';
import { translate, type TranslateOptions } from '../src/translate.js';

type Run = (shim: ReturnType<typeof createRuntime>['shim'], ctx: ReturnType<ReturnType<typeof createRuntime>['context']>) => Promise<unknown>;

const DATES: TranslateOptions = { inputFields: ['Start', 'Due', 'Name'], dateFields: ['Start', 'Due'] };

/** Translate `src` (which assigns `out`), run the server body over `record`, return `out`. */
async function run(src: string, record: Record<string, unknown>, options: TranslateOptions = DATES): Promise<unknown> {
  const t = translate(src, options);
  assert.deepEqual(t.todos.map((x) => x.construct), [], `${src} left a TODO`);
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', now: new Date('2020-06-15T12:00:00Z') });
  const ctx = runtime.context({ record });
  const body = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`) as Run;
  return body(runtime.shim, ctx);
}

const iso = (v: unknown) => (v instanceof DelugeDate ? String(v) : v);

test('date field arithmetic and comparison go through shim.date, not JS string ops', async () => {
  // Creator stores a date field as dd-MMM-yyyy text. As text, "02-Feb-2020" < "15-Jan-2020"
  // and "31-Jan-2020" + 1 is "31-Jan-20201". Golden vectors addDay.month-end, diffDays.*
  // and date.cmp.* pin the date semantics.
  const rec = { Start: '02-Feb-2020', Due: '31-Jan-2020' };
  assert.equal(iso(await run('out = input.Due + 1;', rec)), '2020-02-01T00:00:00');
  assert.equal(iso(await run('out = Due + 1;', rec)), '2020-02-01T00:00:00');
  assert.equal(iso(await run('d = input.Due;\nout = d + 1;', rec)), '2020-02-01T00:00:00');
  assert.equal(await run('out = input.Start - input.Due;', rec), 2 * 86_400_000);
  assert.equal(await run('out = input.Start < input.Due;', rec), false);
  assert.equal(await run('out = Start > Due;', rec), true);
  assert.equal(await run('out = input.Due == "31-Jan-2020";', rec), true);
  assert.equal(await run('out = input.Due.toString();', rec), '31-Jan-2020');

  // Text + date is still concatenation; a blank date compares as Deluge null.
  assert.equal(await run('out = "Due: " + input.Due;', rec), 'Due: 31-Jan-2020');
  assert.equal(await run('out = input.Due == null;', { Start: '02-Feb-2020', Due: null }), true);

  // A field that is not a date keeps plain operators.
  assert.match(translate('out = input.Name + 1;', DATES).server, /\(shim\.input\.get\(ctx, "Name"\) \+ 1\)/);
});

test('app translate options list date and date-time fields', () => {
  const app = deriveIr(parse(`application "T"\n{\n\tform Task\n\t{\n\t\tDue\n\t\t(\n\t\t\ttype = date\n\t\t)\n\t\tStamp\n\t\t(\n\t\t\ttype = datetime\n\t\t)\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n`));
  assert.deepEqual(appTranslateOptions(app).dateFields, ['Due', 'Stamp']);
});
