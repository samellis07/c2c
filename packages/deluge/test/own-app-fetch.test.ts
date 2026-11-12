import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { resolveOwnAppFetches } from '../src/own-app-fetch.js';

const ORDERS_REPORT = `\tform Orders
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = open,closed
\t\t)
\t\tAmount
\t\t(
\t\t\ttype = decimal
\t\t)
\t}
\tlist Orders_Report
\t{
\t\tshow all rows from Orders
\t\t(
\t\t\tName
\t\t)
\t}`;

function appOf(body: string): App {
  const app = deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
  app.profiles.push({ name: 'Administrator', type: 'Users_Permissions', properties: [], modules: [], span: { start: 0, end: 0 } });
  return app;
}

function callSrc(criteria: string): string {
  return `resp = zoho.creator.getRecords(zoho.adminuser, "demo", "Orders_Report", "${criteria}", 1, 10);`;
}

test('resolveOwnAppFetches leaves a getRecords call with a trailing unvalidated statement in its criteria unspliced', () => {
  // The criteria text is wrapped as `x = Form[<criteria>];` purely to parse
  // and validate it. Validation only ever looked at the first parsed
  // statement's criteria tree — but the OUTPUT splice always embeds the
  // full, raw, unvalidated `where` text, not just the validated span. A
  // criteria string engineered so the wrapper closes early (a stray `]`)
  // and the remainder parses as a second, independent statement passed
  // validation on the original implementation while that second
  // statement's text still rode along into the generated output verbatim.
  const criteria = 'ID != 0]; x = Orders[true';
  const src = callSrc(criteria);
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'a criteria string that parses as more than one statement must not be spliced');
});

test('resolveOwnAppFetches still splices a genuinely single-statement static criteria', () => {
  const src = callSrc('Status == \\"open\\"');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.notEqual(out, src);
  assert.match(out, /"code":3000/);
});

test('resolveOwnAppFetches refuses a direct name-vs-name comparison', () => {
  const src = callSrc('Status == Name');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'comparing two bare columns to each other must stay refused');
});

test('resolveOwnAppFetches refuses a string-concat-wrapped name used as a shadowed-variable value', () => {
  // `Name` is a real column on Orders, but nothing in the criteria text can
  // prove the surrounding Deluge script did not earlier shadow it with
  // `Name = zoho.loginuser;` before calling getRecords. Wrapping the name in
  // `+ ""` does not make it any safer than a direct name-vs-name comparison.
  const src = callSrc('Status == Name + \\"\\"');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'a concat-wrapped name on the value side must stay refused');
});

test('resolveOwnAppFetches refuses a unary-negation-wrapped name', () => {
  const src = callSrc('Status == -Name');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'a unary-wrapped name on the value side must stay refused');
});

test('resolveOwnAppFetches refuses an arithmetic-wrapped name', () => {
  const src = callSrc('Amount == Name * 1');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'an arithmetic-wrapped name on the value side must stay refused');
});

test('resolveOwnAppFetches refuses a wrapped name on the LHS of the comparison too', () => {
  const src = callSrc('Name + \\"\\" == Status');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'the wrapper check must not be order-dependent');
});

test('resolveOwnAppFetches still splices a comparison between two fully-literal operands', () => {
  const src = callSrc('1 == 1');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.notEqual(out, src, 'a literal-vs-literal comparison carries no shadowing risk and must still splice');
  assert.match(out, /"code":3000/);
});

test('resolveOwnAppFetches refuses a case-folded True literal used as a shadowed-variable value', () => {
  // The true/false literal check must be exact-case: Deluge identifiers are
  // case-sensitive, so a variable spelled `True` (capital T) is a real,
  // potentially-shadowed name -- e.g. `True = zoho.loginuser;` earlier in
  // the script -- not the boolean literal `true`. A lowercased comparison
  // would wrongly accept it.
  const src = callSrc('Status == True');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'a case-folded True used as a value must stay refused');
});

test('resolveOwnAppFetches refuses a unary-wrapped case-folded True literal', () => {
  const src = callSrc('Status == -True');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'a unary-wrapped case-folded True must stay refused');
});

test('resolveOwnAppFetches refuses a concat-wrapped case-folded False literal', () => {
  const src = callSrc('Status == \\"x\\" + False');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'a concat-wrapped case-folded False must stay refused');
});

test('resolveOwnAppFetches still splices the exact-case true/false literal comparison', () => {
  const src = callSrc('Status == true');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.notEqual(out, src, 'the genuine lowercase true keyword must still be accepted as a literal');
  assert.match(out, /"code":3000/);
});

test('resolveOwnAppFetches refuses a case-folded True used as a bare column name', () => {
  // isBareColumn must also reject True/False by exact case only, so a
  // column genuinely named e.g. "true" (lowercase) on the form is still
  // correctly excluded from being treated as a safe bare column, while a
  // criteria-side `True` identifier (capital T, not a real column) is never
  // mistaken for the boolean literal either.
  const src = callSrc('True == Status');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'True on the LHS must not be treated as a bare column or a literal');
});

test('resolveOwnAppFetches refuses a chained second bracket smuggling an unvalidated inner criteria', () => {
  // `Form[c1][c2]` parses as nested `criteria` nodes as ONE statement (not
  // caught by the single-statement guard): the outer node's `criteria` is
  // c2 (what gets validated) but its `object` is the INNER criteria node
  // holding the unvalidated c1 (here, the zoho.loginuser leak), not a bare
  // name. Only the bare form name may ever appear as the indexed object.
  const src = callSrc('Name == zoho.loginuser][ID != 0');
  const out = resolveOwnAppFetches(src, appOf(ORDERS_REPORT));
  assert.equal(out, src, 'a chained second bracket must stay refused entirely');
});
