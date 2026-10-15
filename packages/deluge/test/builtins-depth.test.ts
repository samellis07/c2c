import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelugeConversionError } from '../../shims/src/convert.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { translate, type TranslateOptions } from '../src/translate.js';

type Run = (shim: ReturnType<typeof createRuntime>['shim'], ctx: ReturnType<ReturnType<typeof createRuntime>['context']>) => Promise<unknown>;

function noTodo(src: string, options?: TranslateOptions) {
  const t = translate(src, options);
  assert.deepEqual(t.todos.map((x) => x.construct), [], `${src} left a TODO`);
  assert.doesNotMatch(t.server + t.client, /shim\.todo\(/);
  return t;
}

/** Translate `src` (which assigns `out`), run the server body on a dry-run runtime, return `out`. */
async function run(src: string, record: Record<string, unknown> = {}, options?: TranslateOptions, zone = 'UTC'): Promise<unknown> {
  const t = noTodo(src, options);
  const runtime = createRuntime({ dryRun: true, appTimeZone: zone, now: new Date('2020-12-31T20:00:00Z') });
  const ctx = runtime.context({ record });
  const body = new Function('shim', 'ctx', `return (async () => {\n${t.server}\nreturn out;\n})();`) as Run;
  return body(runtime.shim, ctx);
}

test('text builtins translate to their shim in method and free form', async () => {
  for (const [src, call] of [
    ['out = s.removeFirstOccurence("5");', 'shim.string.removeFirstOccurence(s, "5")'],
    ['out = s.removeLastOccurence(",");', 'shim.string.removeLastOccurence(s, ",")'],
    ['out = removeLastOccurence(s, ",");', 'shim.string.removeLastOccurence(s, ",")'],
    ['out = s.getAlpha();', 'shim.string.getAlpha(s)'],
    ['out = getAlphaNumeric(s);', 'shim.string.getAlphaNumeric(s)'],
    ['out = s.subText(1, -2);', 'shim.string.subText(s, 1, (-2))'],
    ['out = s.matches("^[0-9]*$");', 'shim.string.matches(s, "^[0-9]*$")'],
    ['out = encodeUrl(s);', 'shim.string.encodeUrl(s)'],
    ['out = encodeurl(s);', 'shim.string.encodeUrl(s)'],
    ['out = s.find("h");', 'shim.list.indexOf(s, "h")'],
    ['out = find(s, "h");', 'shim.list.indexOf(s, "h")'],
  ] as const) {
    const t = noTodo(src);
    assert.ok(t.server.replace(/\s+/g, ' ').includes(call.replace(/\s+/g, ' ')), `${src} -> ${t.server}`);
  }
  assert.equal(await run('s = "Zoho Creator 5"; out = s.removeFirstOccurence("5");'), 'Zoho Creator ');
  assert.equal(await run('out = "a,b,c,".removeLastOccurence(",").toList(",");').then((v) => JSON.stringify(v)), '["a","b","c"]');
  assert.equal(await run('out = getAlpha("Your joining date is January 25th, 2019");'), 'YourjoiningdateisJanuaryth');
  assert.equal(await run('out = "Hello world".find("o");'), 4);
  assert.equal(await run('out = "Zoho Deluge".subText(5, -12);'), 'Deluge');
  assert.equal(await run('out = "ID004500F".matches("[A-Z]{2}[0-9]{6}[A-Z]");'), true);
  assert.equal(await run('out = encodeUrl("a b&c");'), 'a+b%26c');
});

test('list and conversion builtins: subList, toListString, toJSONList', async () => {
  noTodo('l = {1, 2, 3, 4}; out = l.subList(0, 3);');
  noTodo('out = m.get("Monday").toListString();');
  noTodo('out = resource.get("items").toJSONList();');
  assert.deepEqual(await run('l = {1, 2, 3, 4}; out = l.subList(0, 3);'), [1, 2, 3]);
  assert.deepEqual(await run('out = "1,2,3".toListString();'), ['1', '2', '3']);
  assert.deepEqual(await run('out = "[343,443,577]".toJSONList();'), [343, 443, 577]);
  // The result is a list, so a list method on it is a list operation.
  assert.equal(await run('out = "1,2,3".toListString().size();'), 3);
});

test('date builtins: eomonth, toStartOfMonth, between-counts, day and week of year', async () => {
  for (const src of [
    'out = eomonth(d, 0).getDay();',
    'out = d.eomonth(-1);',
    'out = toStartOfMonth(d);',
    'out = yearsBetween(input.Date_of_Birth, zoho.currentdate);',
    'out = input.Date_of_Birth.yearsBetween(zoho.currentdate);',
    'out = monthsBetween(a, b);',
    'out = daysBetween(a, b);',
    'out = d.getWeekOfYear();',
    'out = d.getDayOfYear();',
  ]) noTodo(src);
  assert.equal(await run('out = eomonth(\'01-Jan-2019\', 1).getDay();'), 28);
  assert.equal(await run('out = daysBetween(\'1-Jan-2019\', \'31-Dec-2019\');'), 364);
  // The app zone decides today: 2020-12-31T20:00Z is 1 Jan 2021 in Kolkata,
  // which is 7665 days (21 years of 365 days) after 07-Jan-2000; in UTC it is 7664.
  assert.equal(await run('out = yearsBetween(input.Date_of_Birth, zoho.currentdate);', { Date_of_Birth: '07-Jan-2000' }, undefined, 'Asia/Kolkata'), 21);
  assert.equal(await run('out = yearsBetween(input.Date_of_Birth, zoho.currentdate);', { Date_of_Birth: '07-Jan-2000' }, undefined, 'UTC'), 20);
  assert.equal(await run('out = zoho.currentdate.getDayOfYear();', {}, undefined, 'Asia/Kolkata'), 1);
  assert.equal(await run('out = \'7-Feb-2021\'.getWeekOfYear();'), 7);
});

test('a method on a zoho variable is a value method, never an integration task', async () => {
  for (const src of ['out = zoho.currenttime.toLong();', 'out = zoho.currenttime.getDayOfYear();', 'out = zoho.loginuser.toUpperCase();']) {
    const t = noTodo(src);
    assert.doesNotMatch(t.server, /shim\.zoho\.task/, src);
  }
  assert.match(translate('out = zoho.currenttime.toLong();').server, /shim\.convert\.toLong\(shim\.zoho\.currentTime\(ctx\), ctx\)/);
  // A real integration task still goes to the task adapter.
  assert.match(translate('out = zoho.crm.getRecordById("Leads", 1);').server, /shim\.zoho\.task\(ctx, \["crm","getRecordById"\]/);
});

test('getUrl is a GET through the getUrl shim; openURL is the openUrl task', async () => {
  const t = noTodo('resp = getUrl("https://example.test/a?b=" + encodeUrl(q)).toMap();');
  assert.match(t.server, /shim\.convert\.toMap\(await shim\.http\.getUrl\(ctx, \("https:\/\/example\.test\/a\?b=" \+ shim\.string\.encodeUrl\(q\)\)\), ctx\)/);
  assert.equal(t.client.trim(), '');
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({});
  await (new Function('shim', 'ctx', `return (async () => {\nvar q = 'x';\n${translate('resp = getUrl("https://example.test");').server}\n})();`) as Run)(runtime.shim, ctx);
  const sent = runtime.transcript.find((e) => e.op === 'getUrl');
  assert.ok(sent, 'getUrl is recorded as a getUrl request');
  const open = noTodo('openURL("#Form:Add_Company_Details", "new window");');
  assert.match(open.client, /actions\.push\(\{ op: "openUrl", args: \["#Form:Add_Company_Details", "new window"\] \}\)/);
});

test('choice-field select / deselect / selectAll / deselectAll are client ui actions', () => {
  const sel = noTodo('Blood_Group.select(input.Blood_Group);');
  assert.equal(sel.server.trim(), '');
  assert.match(sel.client, /actions\.push\(\{ op: "ui", method: "select", target: \["Blood_Group"\], args: \[shim\.input\.get\(ctx, "Blood_Group"\)\] \}\)/);
  assert.match(noTodo('Months.deselect(input.Months);').client, /method: "deselect", target: \["Months"\]/);
  assert.match(noTodo('Allocated_To.selectall();').client, /method: "selectAll", target: \["Allocated_To"\], args: \[\]/);
  assert.match(noTodo('input.Games.deselectAll();').client, /method: "deselectAll", target: \["Games"\]/);
  // A local list is not a field: `select` on it stays an explicit TODO.
  const local = translate('l = List(); l.select(1);');
  assert.deepEqual(local.todos.map((x) => x.construct), ['method:select']);
});

test('subform columns and aggregates over in-memory rows', async () => {
  const getAll = noTodo('out = input.Order_Details.Product.getall();');
  assert.match(getAll.server, /shim\.list\.column\(shim\.input\.get\(ctx, "Order_Details"\), "Product"\)/);
  const sum = noTodo('out = input.Order_Details.sum(Amount);', { decimalFields: ['Amount'] });
  assert.match(sum.server, /shim\.list\.aggregate\(shim\.input\.get\(ctx, "Order_Details"\), "sum", "Amount", true\)/);
  const rows = { Order_Details: [{ Product: 'A', Amount: '10.10' }, { Product: 'B', Amount: '0.20' }] };
  assert.deepEqual(await run('out = input.Order_Details.Product.getall();', rows), ['A', 'B']);
  assert.equal(String(await run('out = input.Order_Details.sum(Amount);', rows, { decimalFields: ['Amount'] })), '10.30');
  assert.equal(await run('out = input.Order_Details.sum(Qty);', { Order_Details: [{ Qty: 2 }, { Qty: 3 }] }), 5);
  assert.equal(await run('l = {1, 5, 2, 3}; out = l.average();'), 2.75);
  assert.equal(await run('l = {1, 5, 2, 3}; out = l.count();'), 4);
  // `a.max(b)` and `a.min(b)` with a value argument are not list aggregates.
  assert.doesNotMatch(translate('x = 1; out = x.max(2);').server, /shim\.list\.aggregate/);
});

test('Form[Flag] with a bare boolean field is a criteria, not an index', () => {
  const opts = { formNames: ['Add_Employee'], formFields: { Add_Employee: ['Is_a_Reporting_Manager'] } };
  const t = noTodo('out = Add_Employee[Is_a_Reporting_Manager].Official_Email.getAll();', opts);
  assert.match(t.server, /shim\.datastore\.column\(ctx, shim\.datastore\.query\(ctx, "Add_Employee", \{ op: "==", field: "Is_a_Reporting_Manager", value: true \}\), "Official_Email"\)/);
  const n = noTodo('out = Add_Employee[!Is_a_Reporting_Manager].count();', opts);
  assert.match(n.server, /\{ op: "not", arg: \{ op: "==", field: "Is_a_Reporting_Manager", value: true \} \}/);
  // A list or map that is not a form keeps its index.
  assert.match(translate('m = Map(); out = m[k];', opts).server, /m\[k\]/);
});

test('maximum / minimum on a fetch are the max / min aggregates', () => {
  const t = noTodo('out = Orders[ID > 0].maximum(Amount);', { formNames: ['Orders'] });
  assert.match(t.server, /shim\.datastore\.aggregate\(ctx, shim\.datastore\.query\(ctx, "Orders", .*\), "max", "Amount"\)/);
  assert.match(noTodo('out = Orders[ID > 0].minimum(Amount);', { formNames: ['Orders'] }).server, /"min", "Amount"/);
});

test('Form.Subform() is a row constructor; subform insert and clear are real ops', async () => {
  const opts: TranslateOptions = { formNames: ['Orders'] };
  const t = noTodo('nr = Orders.Items();\nnr.Item = "x";\ninput.Items.insert(nr);\ninput.Items.clear();', opts);
  // The constructor binds a row on both sides; a field write goes through record.set.
  assert.match(t.server, /var nr = shim\.record\.bind\(ctx, \{\}, "Orders\.Items"\)/);
  assert.match(t.client, /var nr = shim\.record\.bind\(ctx, \{\}, "Orders\.Items"\)/);
  assert.match(t.server, /shim\.record\.set\(nr, \["Item"\], "x"\)/);
  // insert mutates the record server-side and renders a grid row client-side.
  assert.match(t.server, /shim\.input\.insert\(ctx, \["Items"\], nr\)/);
  assert.match(t.client, /actions\.push\(\{ op: "subform", method: "insert", target: \["Items"\], args: \[nr\] \}\)/);
  // clear empties the row list server-side and drops the body rows client-side.
  assert.match(t.server, /shim\.list\.clear\(shim\.input\.get\(ctx, "Items"\)\)/);
  assert.match(t.client, /actions\.push\(\{ op: "clear", targets: \["Items"\] \}\)/);
  // End to end on the dry-run runtime: insert then read the rows back.
  const got = await run('nr = Orders.Items(); nr.Item = "x"; input.Items.insert(nr); input.Items.insert(nr); out = input.Items.Item.getall();', {}, opts);
  assert.deepEqual(got, ['x', 'x']);
  assert.equal(await run('nr = Orders.Items(); input.Items.insert(nr); input.Items.clear(); out = input.Items.size();', { Items: [] }, opts), 0);
  // A collection argument appends one row per element.
  assert.equal(await run('rows = {1, 2, 3}; input.Items.insert(rows); out = input.Items.size();', { Items: [] }, opts), 3);
});

test('input.<subform>.insert is a statement, not a list.insert of the collection', () => {
  const opts: TranslateOptions = { formNames: ['Orders'] };
  const t = noTodo('rows = {1, 2};\ninput.Items.insert(rows);', opts);
  assert.match(t.server, /shim\.input\.insert\(ctx, \["Items"\], rows\)/);
  assert.doesNotMatch(t.server, /shim\.list\.insert\(shim\.input\.get/);
});

test('REMOVE_ALL is a constant: Field:ui.deselect(REMOVE_ALL) emits the literal', () => {
  const t = noTodo('input.Games:ui.deselect(REMOVE_ALL);');
  assert.match(t.client, /actions\.push\(\{ op: "ui", method: "deselect", target: \["Games"\], args: \["REMOVE_ALL"\] \}\)/);
});

test('math builtins acos..tanh and the sqrt method route through shim.math', () => {
  for (const [src, call] of [
    ['out = acos(1);', 'shim.math.acos(1)'],
    ['out = (1).acos();', 'shim.math.acos(1)'],
    ['out = ACOSH(1);', 'shim.math.acosh(1)'],
    ['out = (1).acosh();', 'shim.math.acosh(1)'],
    ['out = asinh(1);', 'shim.math.asinh(1)'],
    ['out = (1).asinh();', 'shim.math.asinh(1)'],
    ['out = atan(1);', 'shim.math.atan(1)'],
    ['out = (1).atan();', 'shim.math.atan(1)'],
    ['out = atan2(1, 2);', 'shim.math.atan2(1, 2)'],
    ['out = atanh(0.5);', 'shim.math.atanh(shim.decimal.from("0.5"))'],
    ['out = (0.5).atanh();', 'shim.math.atanh(shim.decimal.from("0.5"))'],
    ['out = cosh(1);', 'shim.math.cosh(1)'],
    ['out = (1).cosh();', 'shim.math.cosh(1)'],
    ['out = log10(100);', 'shim.math.log10(100)'],
    ['out = (100).log10();', 'shim.math.log10(100)'],
    ['out = sinh(1);', 'shim.math.sinh(1)'],
    ['out = (1).sinh();', 'shim.math.sinh(1)'],
    ['out = tanh(1);', 'shim.math.tanh(1)'],
    ['out = (1).tanh();', 'shim.math.tanh(1)'],
    ['out = sqrt(4);', 'shim.math.sqrt(4)'],
    ['out = (4).sqrt();', 'shim.math.sqrt(4)'],
  ] as const) {
    const t = noTodo(src);
    assert.ok(t.server.replace(/\s+/g, ' ').includes(call), `${src} -> ${t.server}`);
  }
});

// The free form has two mandatory parameters; any other count is the counted
// call:atan2 todo, never a value.
test('atan2 free form takes exactly two arguments', () => {
  for (const src of ['out = atan2();', 'out = atan2(1);', 'out = atan2(1, 2, 3);']) {
    const t = translate(src);
    assert.deepEqual(t.todos.map((x) => x.construct), ['call:atan2'], src);
    assert.match(t.server, /shim\.todo\(ctx, "call:atan2"\)/, src);
  }
});

test('math builtins evaluate in radians, domain edges are null, null in is null out', async () => {
  for (const [src, want] of [
    ['out = acos(1);', 0],
    ['out = acos(0);', Math.PI / 2],
    ['out = acos(0.5);', Math.acos(0.5)],
    ['out = acos(2);', null],
    ['out = acos(-2);', null],
    ['out = acosh(1);', 0],
    ['out = acosh(2);', Math.acosh(2)],
    ['out = acosh(0.5);', null],
    ['out = asinh(0);', 0],
    ['out = asinh(1);', Math.asinh(1)],
    ['out = asinh(-2);', Math.asinh(-2)],
    ['out = atan(0);', 0],
    ['out = atan(1);', Math.PI / 4],
    ['out = atan(-1);', -Math.PI / 4],
    ['out = atan2(1, 1);', Math.PI / 4],
    ['out = atan2(0, 1);', 0],
    ['out = atan2(-1, -1);', (-3 * Math.PI) / 4],
    ['out = atanh(0);', 0],
    ['out = atanh(0.5);', Math.atanh(0.5)],
    ['out = atanh(1);', null],
    ['out = atanh(-1);', null],
    ['out = atanh(2);', null],
    ['out = cosh(0);', 1],
    ['out = cosh(1);', Math.cosh(1)],
    ['out = cosh(-1);', Math.cosh(1)],
    ['out = log10(100);', 2],
    ['out = log10(0.1);', -1],
    ['out = log10(0);', null],
    ['out = log10(-4);', null],
    ['out = sinh(0);', 0],
    ['out = sinh(1);', Math.sinh(1)],
    ['out = sinh(-2);', Math.sinh(-2)],
    ['out = tanh(0);', 0],
    ['out = tanh(1);', Math.tanh(1)],
    ['out = tanh(-1);', -Math.tanh(1)],
    ['out = sqrt(9);', 3],
    ['out = (4).sqrt();', 2],
    ['out = (0.25).sqrt();', 0.5],
    ['out = (-1).sqrt();', null],
    ['out = acos(null);', null],
    ['out = atan2(null, 1);', null],
    ['out = log10("abc");', null],
    ['out = sinh("");', null],
    ['x = null; out = x.cosh();', null],
  ] as const) {
    assert.equal(await run(src), want, src);
  }
  // Free and method forms of the same builtin agree.
  for (const name of ['acos', 'acosh', 'asinh', 'atan', 'atanh', 'cosh', 'log10', 'sinh', 'tanh', 'sqrt']) {
    assert.equal(await run(`out = ${name}(0.5);`), await run(`out = (0.5).${name}();`), name);
  }
});

test('math builtins refuse an argument a double cannot carry exactly', async () => {
  const refusal = (e: unknown) => e instanceof DelugeConversionError && /refusing to lose precision/.test((e as Error).message);
  for (const name of ['acos', 'acosh', 'asinh', 'atan', 'atanh', 'cosh', 'log10', 'sinh', 'tanh', 'sqrt']) {
    // An integer literal past 2^53 is a bigint; a long decimal literal is a Decimal.
    await assert.rejects(run(`out = ${name}(9007199254740993);`), refusal, name);
    await assert.rejects(run(`out = ${name}(0.123456789012345678901);`), refusal, name);
  }
  for (const name of ['acos', 'acosh', 'asinh', 'atan', 'atanh', 'cosh', 'log10', 'sinh', 'tanh', 'sqrt']) {
    await assert.rejects(run(`v = 9007199254740993; out = v.${name}();`), refusal, `method ${name}`);
  }
  await assert.rejects(run('out = atan2(9007199254740993, 1);'), refusal);
  await assert.rejects(run('out = atan2(1, 9007199254740993);'), refusal);
  await assert.rejects(run('out = atan2(0.123456789012345678901, 1);'), refusal);
  // A decimal that survives a double round-trip is not refused.
  assert.equal(await run('out = sinh(0.30000000000000004);'), Math.sinh(0.30000000000000004));
  assert.equal(await run('out = cosh(1.5);'), Math.cosh(1.5));
});
