import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decode, deriveIr, parse, parseFile } from '../../core/src/index.js';
import { generate } from '../../deluge/src/generate.js';
import { CREATOR_TEXT, precheck, precheckAsJson, precheckAsText, type PrecheckReport } from '../src/precheck.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDir = path.join(repo, 'packages/cli/test/fixtures/precheck');
const cli = path.join(repo, 'dist/cli/src/c2c.js');
// The many `node c2c.js` children below share a V8 compile cache so each e2e
// spawn does not recompile the whole CLI (ignored on runtimes without it).
process.env.NODE_COMPILE_CACHE ??= path.join(tmpdir(), 'c2c-node-compile-cache');

function load(name: string): PrecheckReport {
  const file = path.join(fixtureDir, name);
  const source = decode(readFileSync(file)).text;
  return precheck(parseFile(file).ir, source);
}

function fromSource(source: string): PrecheckReport {
  return precheck(deriveIr(parse(source)), source);
}

function app(name: string, body: string): string {
  return `/*
 * Author       : synthetic
 * Generated on : 01-Jan-2025 12:00:00
 * Version      : 1.0
 */
application "${name}"
{
${body}}
`;
}

function ids(report: PrecheckReport): string[] {
  return report.findings.map((finding) => finding.check);
}

/** check:severity of every finding except converter-gap (constructs the converter still leaves as TODOs). */
function brief(report: PrecheckReport): string[] {
  return report.findings.filter((finding) => finding.check !== 'converter-gap').map((finding) => `${finding.check}:${finding.severity}`);
}

function messages(report: PrecheckReport): string {
  return report.findings.map((finding) => `${finding.check} ${finding.severity} L${finding.location.line} ${finding.message}`).join('\n');
}

const workflow = (script: string) => `\tworkflow
\t{
\t\tform
\t\t{
\t\t\tOn_Add as "On add"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\ton success
\t\t\t\t\t\t(
${script}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
`;

/** One form workflow per entry, in the saved workflow shape: `<event> { actions { custom deluge script ( ... ) } }`. */
const handlers = (items: { event: string; script: string }[]) => `\tworkflow
\t{
\t\tform
\t\t{
${items
  .map(
    (item, index) => `\t\t\tW_${index} as "W ${index}"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\trecord event = on add
\t\t\t\t${item.event}
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
${item.script}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
`,
  )
  .join('')}\t\t}
\t}
`;

const itemForm = (extra = '') => `\tforms
\t{
\t\tform Item
\t\t{
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Title"
\t\t\t)
\t\t\tQty
\t\t\t(
\t\t\t\ttype = number
\t\t\t\tdisplayname = "Qty"
\t\t\t)
${extra}\t\t}
\t}
`;

const fns = (body: string) => `\tfunctions
\t{
\t\tDeluge
\t\t{
${body}
\t\t}
\t}
`;

const NS_FNS = fns(`\t\t\tvoid Mail.notify(string email)
\t\t\t{
\t\t\t\tinfo email;
\t\t\t}
\t\t\tstring Util.tag(string code)
\t\t\t{
\t\t\t\treturn "t-" + code;
\t\t\t}`);

const cases: { file: string; check: string; severity: 'blocker' | 'warning'; phrase: string }[] = [
  { file: 'sendmail.ds', check: 'sendmail-sender', severity: 'blocker', phrase: CREATOR_TEXT.from },
  { file: 'link-name.ds', check: 'link-name', severity: 'warning', phrase: 'unverified limit' },
  { file: 'duplicate.ds', check: 'duplicate-name', severity: 'warning', phrase: 'Title' },
  { file: 'cross-app.ds', check: 'cross-app', severity: 'warning', phrase: 'Other_App' },
  { file: 'formula.ds', check: 'formula-integration', severity: 'warning', phrase: 'Ext' },
  { file: 'report-filter.ds', check: 'report-filter', severity: 'warning', phrase: 'multi-value field Tags' },
  { file: 'criteria-multiselect.ds', check: 'criteria-multiselect', severity: 'blocker', phrase: CREATOR_TEXT.criteria },
  { file: 'signature.ds', check: 'signature', severity: 'blocker', phrase: "Data type of argument at index '1' of the function 'add'" },
  { file: 'void-assign.ds', check: 'void-assign', severity: 'blocker', phrase: "Void function 'ping' cannot be used in expression" },
  { file: 'converter-gap.ds', check: 'converter-gap', severity: 'warning', phrase: 'geolocation' },
];

for (const item of cases) {
  test(`precheck ${item.file} fires only ${item.check}`, () => {
    const report = load(item.file);
    assert.deepEqual(ids(report), [item.check], messages(report));
    const finding = report.findings[0];
    assert.ok(finding);
    assert.equal(finding.severity, item.severity);
    assert.ok(finding.message.includes(item.phrase), finding.message);
    assert.equal(typeof finding.location.line, 'number');
    assert.equal(report.limits.linkNameMax, 'unverified limit');
    assert.equal(precheckAsJson(report), precheckAsJson(report));
    assert.equal(precheckAsText(report), precheckAsText(report));
    const again = load(item.file);
    assert.equal(precheckAsJson(report), precheckAsJson(again));
    assert.equal(precheckAsText(report), precheckAsText(again));
  });
}

test('precheck clean app has zero findings', () => {
  const report = load('clean.ds');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.counts, { blocker: 0, warning: 0 });
  assert.equal(report.limits.linkNameMax, 'unverified limit');
  assert.match(precheckAsText(report), /link-name max: unverified limit/);
  assert.equal(precheckAsJson(report), precheckAsJson(load('clean.ds')));
  const parsed = JSON.parse(precheckAsJson(report)) as PrecheckReport;
  assert.equal(parsed.schema, 'c2c-precheck/1');
  assert.equal(parsed.app, 'Precheck_Clean');
});

test('precheck link-name does not invent a numeric cap', () => {
  const report = load('link-name.ds');
  assert.equal(report.limits.linkNameMax, 'unverified limit');
  assert.doesNotMatch(report.findings[0]?.message ?? '', /\b(50|100|255)\b/);
  assert.match(precheckAsText(report), /link-name max: unverified limit/);
});

const twoForms = (aMod: string, bMod: string, bType = 'picklist', extraA = '') => `\tforms
\t{
\t\tform A
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Name"
\t\t\t)
\t\t\t${aMod}ToB
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "To B"
\t\t\t\tvalues = B.Name
\t\t\t\tdisplayformat = [Name]
${extraA}\t\t\t)
\t\t}
\t\tform B
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Name"
\t\t\t)
\t\t\t${bMod}ToA
\t\t\t(
\t\t\t\ttype = ${bType}
\t\t\t\tdisplayname = "To A"
\t\t\t\tvalues = A.Name
\t\t\t\tdisplayformat = [Name]
\t\t\t)
\t\t}
\t}
`;

test('precheck lookup cycle: one warning per SCC, only where a mandatory FK is relaxed', () => {
  const relaxed = fromSource(app('Precheck_Lookup_Cycle', twoForms('must have ', '')));
  assert.deepEqual(brief(relaxed), ['lookup-cycle:warning'], messages(relaxed));
  assert.match(relaxed.findings[0]?.message ?? '', /among A, B/);
  assert.match(relaxed.findings[0]?.message ?? '', /mandatory relaxed/);
  assert.equal(relaxed.findings[0]?.location.form, 'A');

  const both = fromSource(app('Precheck_Lookup_Cycle_Both', twoForms('must have ', 'must have ')));
  assert.deepEqual(brief(both), ['lookup-cycle:warning'], messages(both));

  const optional = fromSource(app('Precheck_Lookup_Cycle_Optional', twoForms('', '')));
  assert.deepEqual(ids(optional), [], messages(optional));
});

test('precheck lookup cycle ignores list, checkbox and bidirectional mirrors (no FK on the multi side)', () => {
  for (const type of ['list', 'checkboxes']) {
    const report = fromSource(app(`Precheck_Mirror_${type}`, twoForms('must have ', 'must have ', type)));
    assert.deepEqual(ids(report).filter((id) => id === 'lookup-cycle'), [], `${type}\n${messages(report)}`);
  }
});

test('precheck self lookup with must have is one lookup-cycle warning', () => {
  const source = app(
    'Precheck_Self_Lookup',
    `\tforms
\t{
\t\tform A
\t\t{
\t\t\tName
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Name"
\t\t\t)
\t\t\tmust have Self
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Self"
\t\t\t\tvalues = A.Name
\t\t\t\tdisplayformat = [Name]
\t\t\t)
\t\t}
\t}
`,
  );
  const report = fromSource(source);
  assert.deepEqual(brief(report), ['lookup-cycle:warning'], messages(report));
  assert.match(report.findings[0]?.message ?? '', /A\.Self|A\.self/i);
});

test('precheck function cycle is one warning', () => {
  const source = app(
    'Precheck_Function_Cycle',
    `\tfunctions
\t{
\t\tvoid a()
\t\t{
\t\t\tthisapp.b();
\t\t}
\t\tvoid b()
\t\t{
\t\t\tthisapp.a();
\t\t}
\t}
`,
  );
  const report = fromSource(source);
  assert.deepEqual(brief(report), ['function-cycle:warning'], messages(report));
  assert.match(report.findings[0]?.message ?? '', /a -> b -> a/);
});

test('precheck signature too few arguments uses the Creator text', () => {
  const source = app(
    'Precheck_Signature_Few',
    `${itemForm()}\tfunctions
\t{
\t\tstring add(int a, int b)
\t\t{
\t\t\treturn a;
\t\t}
\t}
${workflow('\t\t\t\t\t\t\tthisapp.add(1);')}
`,
  );
  const report = fromSource(source);
  assert.deepEqual(ids(report), ['signature'], messages(report));
  assert.ok(report.findings[0]?.message.includes(CREATOR_TEXT.arity('add', 2)), report.findings[0]?.message);
  assert.doesNotMatch(report.findings[0]?.message ?? '', /Data type of argument/);
});

test('precheck signature too many arguments names the argument count', () => {
  const source = app(
    'Precheck_Signature_Many',
    `${itemForm()}\tfunctions
\t{
\t\tstring add(int a, int b)
\t\t{
\t\t\treturn a;
\t\t}
\t}
${workflow('\t\t\t\t\t\t\tthisapp.add(1, 2, 3);')}
`,
  );
  const report = fromSource(source);
  assert.deepEqual(ids(report), ['signature'], messages(report));
  assert.match(report.findings[0]?.message ?? '', /The call passes 3; the declaration has 2/);
});

test('precheck sees namespaced functions: arity, void in expression, argument type', () => {
  const call = (script: string) => fromSource(app('Precheck_Ns', `${itemForm()}${NS_FNS}${handlers([{ event: 'on validate', script }])}`));
  const arity = call('\t\t\t\t\t\t\tthisapp.Mail.notify(input.Title, "extra");');
  assert.deepEqual(brief(arity), ['signature:blocker'], messages(arity));
  assert.ok(arity.findings[0]?.message.includes(CREATOR_TEXT.arity('Mail.notify', 1)));
  const assigned = call('\t\t\t\t\t\t\tx = thisapp.Mail.notify(input.Title);');
  assert.deepEqual(brief(assigned), ['void-assign:blocker'], messages(assigned));
  assert.ok(assigned.findings[0]?.message.includes(CREATOR_TEXT.voidExpr('Mail.notify')));
  const typed = call('\t\t\t\t\t\t\tn = 5;\n\t\t\t\t\t\t\tinput.Title = thisapp.Util.tag(n);');
  assert.deepEqual(brief(typed), ['signature:blocker'], messages(typed));
  assert.ok(typed.findings[0]?.message.includes(CREATOR_TEXT.argType('Util.tag', 1, 'STRING')), typed.findings[0]?.message);
  const fine = call('\t\t\t\t\t\t\tthisapp.Mail.notify(input.Title);\n\t\t\t\t\t\t\tinput.Title = thisapp.Util.tag(input.Title);');
  assert.deepEqual(ids(fine), [], messages(fine));
});

test('precheck flags a void call in any expression, not only an assignment', () => {
  const scripts = [
    'if(thisapp.Mail.notify(input.Title) == null)\n\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\tinfo 1;\n\t\t\t\t\t\t\t}',
    'info thisapp.Mail.notify(input.Title);',
    'input.Title = thisapp.Util.tag(thisapp.Mail.notify(input.Title));',
    'x = "a" + thisapp.Mail.notify(input.Title);',
  ];
  for (const script of scripts) {
    const report = fromSource(app('Precheck_Void_Expr', `${itemForm()}${NS_FNS}${handlers([{ event: 'on validate', script: `\t\t\t\t\t\t\t${script}` }])}`));
    assert.ok(ids(report).includes('void-assign'), `${script}\n${messages(report)}`);
    assert.ok(report.counts.blocker >= 1);
  }
  const statement = fromSource(app('Precheck_Void_Stmt', `${itemForm()}${NS_FNS}${handlers([{ event: 'on validate', script: '\t\t\t\t\t\t\tthisapp.Mail.notify(input.Title);' }])}`));
  assert.deepEqual(ids(statement), [], messages(statement));
});

test('precheck infers argument types from typed input fields and leaves lookup values alone', () => {
  const lookup = `\t\t\tRef
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Ref"
\t\t\t\tvalues = Item[Qty > 0].ID
\t\t\t\tdisplayformat = [Title]
\t\t\t)
`;
  const run = (script: string) => fromSource(app('Precheck_Types', `${itemForm(lookup)}${NS_FNS}${handlers([{ event: 'on validate', script: `\t\t\t\t\t\t\t${script}` }])}`));
  const number = run('input.Title = thisapp.Util.tag(input.Qty);');
  assert.deepEqual(brief(number), ['signature:blocker'], messages(number));
  assert.match(number.findings[0]?.message ?? '', /index '1'.*'STRING'.*The argument is int/);
  assert.deepEqual(ids(run('input.Title = thisapp.Util.tag(input.Ref);')), []);
  assert.deepEqual(ids(run('input.Title = thisapp.Util.tag(input.Qty.toString());')), []);
  assert.deepEqual(ids(run('n = 5;\n\t\t\t\t\t\t\tn = "five";\n\t\t\t\t\t\t\tinput.Title = thisapp.Util.tag(n);')), []);
});

test('precheck success message: blocker in on validate, functions and schedules; warning in on load; silent in on success', () => {
  const sm = '\t\t\t\t\t\t\tsuccess message "x";';
  const validate = fromSource(app('Precheck_Sm_Validate', `${itemForm()}${handlers([{ event: 'on validate', script: sm }])}`));
  assert.deepEqual(brief(validate), ['success-message:blocker'], messages(validate));
  assert.ok(validate.findings[0]?.message.includes(CREATOR_TEXT.successMessage));
  const load = fromSource(app('Precheck_Sm_Load', `${itemForm()}${handlers([{ event: 'on load', script: sm }])}`));
  assert.deepEqual(brief(load), ['success-message:warning'], messages(load));
  const success = fromSource(app('Precheck_Sm_Success', `${itemForm()}${handlers([{ event: 'on success', script: sm }])}`));
  assert.deepEqual(ids(success), [], messages(success));
  const fn = fromSource(app('Precheck_Sm_Fn', `${itemForm()}${fns('\t\t\tvoid tell()\n\t\t\t{\n\t\t\t\tsuccess message "x";\n\t\t\t}')}`));
  assert.deepEqual(brief(fn), ['success-message:blocker'], messages(fn));
  const schedule = fromSource(
    app(
      'Precheck_Sm_Schedule',
      `${itemForm()}\tworkflow
\t{
\t\tschedule
\t\t{
\t\t\tDaily as "Daily"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Item
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\ton load
\t\t\t\t\t(
\t\t\t\t\t\tsuccess message "x";
\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
`,
    ),
  );
  assert.deepEqual(brief(schedule), ['success-message:blocker'], messages(schedule));
});

test('precheck reads handler blocks the IR drops from actions { hide …; on success ( … ) }', () => {
  const source = app(
    'Precheck_Recovered',
    `${itemForm()}${NS_FNS}\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRun as "Run"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\thide Qty;
\t\t\t\t\ton success
\t\t\t\t\t(
\t\t\t\t\t\tthisapp.Mail.notify(input.Title, "extra");
\t\t\t\t\t)
\t\t\t\t\ton load
\t\t\t\t\t(
\t\t\t\t\t\tsuccess message "x";
\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
`,
  );
  const report = fromSource(source);
  assert.deepEqual(brief(report), ['signature:blocker', 'success-message:warning'], messages(report));
});

const approverForm = `\t\t\tApprover
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Approver"
\t\t\t\tmodule = users
\t\t\t\tdisplayformat = [username]
\t\t\t)
`;

const approval = (form: string) => `\t\tapproval
\t\t{
\t\t\tItem_Approval as "Item Approval"
\t\t\t{
\t\t\t\ttype = approval
\t\t\t\tform = ${form}
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t}
\t\t\t\ton level 1
\t\t\t\t{
\t\t\t\t\tapprovers
\t\t\t\t\t(
\t\t\t\t\t\tfield = Approver
\t\t\t\t\t)
\t\t\t\t\ton approve
\t\t\t\t\t{
\t\t\t\t\t}
\t\t\t\t\ton reject
\t\t\t\t\t{
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
`;

function withApproval(items: { event: string; script: string }[], form = 'Item'): string {
  const wf = handlers(items).replace(/\t\t}\n\t}\n$/, `\t\t}\n${approval(form)}\t}\n`);
  return app('Precheck_Approval', `${itemForm(approverForm)}${wf}`);
}

test('precheck approver set only in On Success is one warning per approval field', () => {
  const onSuccess = '\t\t\t\t\t\t\trec = Item[ID == input.ID];\n\t\t\t\t\t\t\trec.Approver = zoho.loginuser;';
  const report = fromSource(withApproval([{ event: 'on success', script: onSuccess }], 'Item[Approver is not null]'));
  assert.deepEqual(brief(report), ['approver-on-success:warning'], messages(report));
  assert.equal(report.findings.find((finding) => finding.check === 'approver-on-success')?.location.field, 'Approver');
  const validated = fromSource(
    withApproval([
      { event: 'on success', script: onSuccess },
      { event: 'on validate', script: '\t\t\t\t\t\t\tinput.Approver = zoho.loginuser;' },
    ]),
  );
  assert.deepEqual(brief(validated), [], messages(validated));
});

test('precheck users field set to zoho.loginuserid is a warning; zoho.loginuser is fine', () => {
  const bad = fromSource(withApproval([{ event: 'on validate', script: '\t\t\t\t\t\t\tinput.Approver = zoho.loginuserid;' }]));
  assert.deepEqual(brief(bad), ['users-field:warning'], messages(bad));
  const users = bad.findings.find((finding) => finding.check === 'users-field');
  assert.ok(users?.message.includes(CREATOR_TEXT.usersField('Approver')), messages(bad));
  const good = fromSource(withApproval([{ event: 'on validate', script: '\t\t\t\t\t\t\tinput.Approver = zoho.loginuser;' }]));
  assert.deepEqual(brief(good), [], messages(good));
});

const mail = (from: string) => `\t\t\t\t\t\t\tsendmail
\t\t\t\t\t\t\t[
\t\t\t\t\t\t\t\tfrom : ${from}
\t\t\t\t\t\t\t\tto : "a@b.c"
\t\t\t\t\t\t\t\tsubject : "s"
\t\t\t\t\t\t\t\tmessage : "m"
\t\t\t\t\t\t\t]`;

test('precheck sendmail sender: literal blocks, admin is silent, loginuserid is one warning per app, expressions warn', () => {
  const run = (...froms: string[]) =>
    fromSource(app('Precheck_Mail', `${itemForm()}${handlers(froms.map((from) => ({ event: 'on success', script: mail(from) })))}`));
  for (const from of ['zoho.adminuserid', 'zoho.adminuser', '"zoho.adminuserid"']) {
    assert.deepEqual(ids(run(from)), [], from);
  }
  const literal = run('"Sales <sales@example.com>"');
  assert.deepEqual(brief(literal), ['sendmail-sender:blocker'], messages(literal));
  assert.ok(literal.findings[0]?.message.includes(CREATOR_TEXT.from));
  assert.match(literal.findings[0]?.fix ?? '', /from : zoho\.adminuserid and add reply to : "Sales <sales@example\.com>"/);
  const login = run('zoho.loginuserid', 'zoho.loginuserid', 'zoho.adminuserid');
  assert.deepEqual(brief(login), ['sendmail-sender:warning'], messages(login));
  assert.match(login.findings[0]?.message ?? '', /^2 sendmail calls/);
  const expression = run('input.Title');
  assert.deepEqual(brief(expression), ['sendmail-sender:warning'], messages(expression));
});

test('precheck sendmail literal points at the from line, as Creator does', () => {
  const source = app('Precheck_Mail_Line', `${itemForm()}${handlers([{ event: 'on success', script: mail('"x@example.com"') }])}`);
  const report = fromSource(source);
  const line = source.split('\n').findIndex((text) => text.includes('from : "x@example.com"')) + 1;
  assert.equal(report.findings[0]?.location.line, line);
});

test('precheck cross-app recognises versioned tasks and ignores this app by slug', () => {
  const run = (name: string, call: string) =>
    fromSource(app(name, `${itemForm()}${handlers([{ event: 'on success', script: `\t\t\t\t\t\t\tr = ${call};` }])}`));
  const v21 = run('Precheck_X', 'zoho.creator.v2_1.getRecords("owner", "other-app", "All_Items", "", 1, 200, "conn")');
  assert.deepEqual(brief(v21), ['cross-app:warning'], messages(v21));
  assert.match(v21.findings[0]?.message ?? '', /zoho\.creator\.v2_1\.getRecords/);
  const self = run('Precheck Self App', 'zoho.creator.createRecord("owner", "precheck-self-app", "Item", Map(), Map(), "conn")');
  assert.deepEqual(ids(self), [], messages(self));
});

test('c2c precheck CLI exit codes keep input errors apart from blockers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-precheck-'));
  try {
    const garbage = path.join(dir, 'garbage.ds');
    writeFileSync(garbage, 'garbage {{{\n');
    const json = path.join(dir, 'data.json');
    writeFileSync(json, '{"a": 1}\n');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'precheck', ...args], { encoding: 'utf8' });
    const ok = run(path.join(fixtureDir, 'clean.ds'), '--json');
    assert.equal(ok.status, 0, ok.stderr);
    const body = JSON.parse(ok.stdout) as PrecheckReport;
    assert.equal(body.schema, 'c2c-precheck/1');
    assert.equal(body.findings.length, 0);
    const bad = run(path.join(fixtureDir, 'sendmail.ds'));
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stdout, /sendmail-sender/);
    assert.match(bad.stdout, /link-name max: unverified limit/);
    const warnOnly = run(path.join(fixtureDir, 'cross-app.ds'));
    assert.equal(warnOnly.status, 0, warnOnly.stderr);
    assert.equal(run(path.join(fixtureDir, 'missing.ds')).status, 3);
    const junk = run(garbage);
    assert.equal(junk.status, 4);
    assert.match(junk.stderr, /not a Creator \.ds application export/);
    assert.doesNotMatch(junk.stdout, /findings 0/);
    assert.equal(run(json).status, 4);
    assert.equal(run(fixtureDir).status, 2);
    assert.equal(run().status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precheck output order is stable across checks', () => {
  const source = app(
    'Precheck_Order',
    `\tforms
\t{
\t\tform Item
\t\t{
\t\t\t1Code
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Code"
\t\t\t)
\t\t}
\t}
${workflow(`\t\t\t\t\t\t\tsendmail
\t\t\t\t\t\t\t[
\t\t\t\t\t\t\t\tfrom: "a@example.com"
\t\t\t\t\t\t\t\tto: "a@b.c"
\t\t\t\t\t\t\t\tsubject: "s"
\t\t\t\t\t\t\t\tmessage: "m"
\t\t\t\t\t\t\t];`)}
`,
  );
  const report = fromSource(source);
  assert.deepEqual(ids(report), ['link-name', 'sendmail-sender']);
  assert.equal(precheckAsJson(report), precheckAsJson(fromSource(source)));
});

// Import rules: import, export, Duplicate, and backup failures.

/** `type = functions` workflow + report custom action, in the exported shape. */
const customActionApp = (exec: string, call: string, viewItem: string | null, actionBody = 'workflow = Do_It') =>
  app(
    'Precheck_Custom_Action',
    `${itemForm()}\treports
\t{
\t\tlist All_Items
\t\t{
\t\t\tshow all rows from Item
\t\t\t(
\t\t\t\tTitle
\t\t\t\tcustom action "Do It"
\t\t\t\t(
\t\t\t\t\t${actionBody}
\t\t\t\t)
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tfunctions
\t\t{
\t\t\tDo_It
\t\t\t{
\t\t\t\ttype = functions
\t\t\t\tform = Item
\t\t\t\texecution type = ${exec}
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\t${call}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tfunctions
\t{
\t\tDeluge
\t\t{
\t\t\tvoid do_one(int id)
\t\t\t{
\t\t\t\tinfo id;
\t\t\t}
\t\t\tvoid do_coll(Item recs)
\t\t\t{
\t\t\t\tinfo recs;
\t\t\t}
\t\t}
\t}
\tweb
\t{
\t\treports
\t\t{
\t\t\treport All_Items
\t\t\t{
${
  viewItem === null
    ? ''
    : `\t\t\t\tquickview
\t\t\t\t(
\t\t\t\t\tlayout
\t\t\t\t\t(
\t\t\t\t\t\tdatablock1
\t\t\t\t\t\t(
\t\t\t\t\t\t\tfields
\t\t\t\t\t\t\t(
\t\t\t\t\t\t\t\tTitle
${viewItem ? `\t\t\t\t\t\t\t\t${viewItem}\n` : ''}\t\t\t\t\t\t\t)
\t\t\t\t\t\t)
\t\t\t\t\t)
\t\t\t\t)
`
}\t\t\t}
\t\t}
\t}
`,
  );

test('precheck custom-action: an action in a report with no views is a blocker; any view metadata is clean', () => {
  const bare = fromSource(customActionApp('for each record', 'thisapp.do_one(input.ID);', null));
  assert.deepEqual(brief(bare), ['custom-action:blocker'], messages(bare));
  assert.match(bare.findings[0]?.message ?? '', /no quickview\/detailview metadata/);
  // Real Creator exports leave some actions out of their views' menus (public corpus, 2025 exports).
  const unlisted = fromSource(customActionApp('for each record', 'thisapp.do_one(input.ID);', ''));
  assert.deepEqual(ids(unlisted), [], messages(unlisted));
  const wired = fromSource(customActionApp('for each record', 'thisapp.do_one(input.ID);', '"Do It"'));
  assert.deepEqual(ids(wired), [], messages(wired));
  const aliased = fromSource(customActionApp('for each record', 'thisapp.do_one(input.ID);', '"Do It" as "Pay"'));
  assert.deepEqual(ids(aliased), [], messages(aliased));
});

test('precheck custom-action: dangling or wrong-kind workflow binding is a blocker', () => {
  const dangling = fromSource(customActionApp('for each record', 'thisapp.do_one(input.ID);', '"Do It"', 'workflow = Gone'));
  assert.deepEqual(brief(dangling), ['custom-action:blocker'], messages(dangling));
  assert.match(dangling.findings[0]?.message ?? '', /does not exist/);
  const wrongKind = fromSource(customActionApp('for each record', 'thisapp.do_one(input.ID);', '"Do It"', 'workflow = do_one'));
  assert.deepEqual(brief(wrongKind), ['custom-action:blocker'], messages(wrongKind));
});

test('precheck custom-action: collection of records bound to a non-form parameter warns', () => {
  const scalar = fromSource(customActionApp('collection of records', 'thisapp.do_one(input.ID);', '"Do It"'));
  assert.deepEqual(brief(scalar), ['custom-action:warning'], messages(scalar));
  const formParam = fromSource(customActionApp('collection of records', 'thisapp.do_coll(Item);', '"Do It"'));
  assert.deepEqual(ids(formParam), [], messages(formParam));
  const forEach = fromSource(customActionApp('for each record', 'thisapp.do_one(input.ID);', '"Do It"'));
  assert.deepEqual(ids(forEach), [], messages(forEach));
});

test('precheck call-target: thisapp.<fn> must exist; portal/permissions/blueprint/environment are built-in', () => {
  const run = (script: string) => fromSource(app('Precheck_Call_Target', `${itemForm()}${handlers([{ event: 'on validate', script }])}`));
  const gone = run('\t\t\t\t\t\t\tthisapp.gone(1);');
  assert.deepEqual(brief(gone), ['call-target:blocker'], messages(gone));
  assert.ok(gone.findings[0]?.message.includes(CREATOR_TEXT.missingFn('gone')), gone.findings[0]?.message);
  assert.deepEqual(ids(run('\t\t\t\t\t\t\tthisapp.portal.deleteuser(input.Qty);')), []);
  assert.deepEqual(ids(run('\t\t\t\t\t\t\tthisapp.permissions.assignUserInProfile(input.Title);')), []);
  assert.deepEqual(ids(run('\t\t\t\t\t\t\tthisapp.blueprint.executeTransition("Item", "Go", input.ID);')), []);
  assert.deepEqual(ids(run('\t\t\t\t\t\t\tx = thisapp.environment.type();')), []);
  // A bare call to a missing name is not `thisapp`: Deluge built-ins (Map, List) stay quiet.
  assert.deepEqual(ids(run('\t\t\t\t\t\t\tx = Map();')), []);
});

test('precheck reserved-name: workflow link name Type blocks; field and report Type are fine', () => {
  const source = app(
    'Precheck_Reserved',
    `\tforms
\t{
\t\tform Item
\t\t{
\t\t\tType
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Type"
\t\t\t)
\t\t}
\t}
\treports
\t{
\t\tlist Type
\t\t{
\t\t\tdisplayname = "Type"
\t\t\tshow all rows from Item
\t\t\t(
\t\t\t\tType
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tType as "Type"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Type = "x";
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
`,
  );
  const report = fromSource(source);
  assert.deepEqual(brief(report), ['reserved-name:blocker'], messages(report));
  assert.ok(report.findings[0]?.message.includes(CREATOR_TEXT.genericImport));
  // Unconfirmed Deluge keywords warn: a public Creator export has a workflow named `update`.
  const keyword = fromSource(source.replace('\t\t\tType as "Type"', '\t\t\tupdate as "Update"'));
  assert.deepEqual(brief(keyword), ['reserved-name:warning'], messages(keyword));
  // type_wf is the builder's own rename.
  const fixed = fromSource(app('Precheck_Reserved_Fix', `${itemForm()}${handlers([{ event: 'on validate', script: '\t\t\t\t\t\t\tinfo 1;' }])}`));
  assert.deepEqual(ids(fixed), [], messages(fixed));
});

test('precheck insert-comment: // and /* */ inside insert into brackets block at the insert line', () => {
  const scriptFor = (inner: string) => `\t\t\t\t\t\t\tid = insert into Item\n\t\t\t\t\t\t\t[\n${inner}\t\t\t\t\t\t\t];`;
  const blocked = fromSource(
    app('Precheck_Insert_Comment', `${itemForm()}${handlers([{ event: 'on success', script: scriptFor('\t\t\t\t\t\t\t\t// copy the code\n\t\t\t\t\t\t\t\tTitle = input.Title\n') }])}`),
  );
  assert.deepEqual(brief(blocked), ['insert-comment:blocker'], messages(blocked));
  assert.ok(blocked.findings[0]?.message.includes(CREATOR_TEXT.improperStatement));
  const line = blocked.findings[0]?.location.line;
  assert.ok(line, 'insert-comment line');
  const blocked2 = fromSource(
    app('Precheck_Insert_Block', `${itemForm()}${handlers([{ event: 'on success', script: scriptFor('\t\t\t\t\t\t\t\tTitle = input.Title\n\t\t\t\t\t\t\t\t/* note */\n') }])}`),
  );
  assert.deepEqual(brief(blocked2), ['insert-comment:blocker'], messages(blocked2));
  // A comment above the statement is the documented fix.
  const clean = fromSource(
    app(
      'Precheck_Insert_Clean',
      `${itemForm()}${handlers([{ event: 'on success', script: '\t\t\t\t\t\t\t// copy the code\n\t\t\t\t\t\t\tid = insert into Item\n\t\t\t\t\t\t\t[\n\t\t\t\t\t\t\t\tTitle = input.Title\n\t\t\t\t\t\t\t];' }])}`,
    ),
  );
  assert.deepEqual(ids(clean), [], messages(clean));
});

test('precheck legacy-getall: only the doubled (chain).chain.getall() form blocks', () => {
  const run = (expr: string) =>
    fromSource(app('Precheck_Getall', `${itemForm()}${handlers([{ event: 'on validate', script: `\t\t\t\t\t\t\tnames = ${expr};` }])}`));
  const doubled = run('List((input.Subs.Name).input.Subs.Name.getall())');
  assert.deepEqual(brief(doubled), ['legacy-getall:blocker'], messages(doubled));
  const hit = doubled.findings.find((finding) => finding.check === 'legacy-getall');
  assert.ok(hit?.message.includes(CREATOR_TEXT.improperStatement), messages(doubled));
  // Creator itself exports List((x).getall()) and the bare modern form.
  // (getall still earns a converter-gap warning — brief() filters that out.)
  assert.deepEqual(brief(run('List((input.Subs.Name).getall())')), []);
  assert.deepEqual(brief(run('input.Subs.Name.getall()')), []);
});

test('precheck report-view: view= must name a report of the lookup target form', () => {
  const body = (view: string) => app(
    'Precheck_Report_View',
    `\tforms
\t{
\t\tform Parent
\t\t{
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Title"
\t\t\t)
\t\t}
\t\tform Child
\t\t{
\t\t\tParent_One
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Parent"
\t\t\t\tvalues = Parent.Title
\t\t\t\tdisplayformat = [Title]
\t\t\t)
\t\t}
\t}
\treports
\t{
\t\tlist All_Parents
\t\t{
\t\t\tshow all rows from Parent
\t\t\t(
\t\t\t\tTitle
\t\t\t)
\t\t}
\t\tlist All_Children
\t\t{
\t\t\tshow all rows from Child
\t\t\t(
\t\t\t\tParent_One as "Parent"
\t\t\t\t(
\t\t\t\t\tview = ${view}
\t\t\t\t)
\t\t\t)
\t\t}
\t}
`,
  );
  const bad = fromSource(body('All_Children'));
  assert.deepEqual(brief(bad), ['report-view:blocker'], messages(bad));
  assert.ok(bad.findings[0]?.message.includes(CREATOR_TEXT.belongsView('Parent', 'All_Children')), bad.findings[0]?.message);
  const missing = fromSource(body('No_Such_Report'));
  assert.deepEqual(brief(missing), ['report-view:blocker'], messages(missing));
  const good = fromSource(body('All_Parents'));
  assert.deepEqual(ids(good), [], messages(good));
});

test('precheck non-bmp: emoji in titles and page content block; Deluge text is out of scope', () => {
  const titled = fromSource(
    app(
      'Precheck_Emoji',
      `\treports
\t{
\t\tlist All_Items
\t\t{
\t\t\tdisplayname = "Items \u{1F600}"
\t\t\tshow all rows from Item
\t\t\t(
\t\t\t\tTitle
\t\t\t)
\t\t}
\t}
${itemForm()}`,
    ),
  );
  assert.deepEqual(brief(titled), ['non-bmp:blocker'], messages(titled));
  const page = fromSource(
    app(
      'Precheck_Emoji_Page',
      `${itemForm()}\tpages
\t{
\t\tpage Home
\t\t{
\t\t\tContent = "<h1>hi \u{1F600}</h1>"
\t\t}
\t}
`,
    ),
  );
  assert.deepEqual(brief(page), ['non-bmp:blocker'], messages(page));
  const script = fromSource(
    app('Precheck_Emoji_Script', `${itemForm()}${handlers([{ event: 'on success', script: '\t\t\t\t\t\t\tsuccess message "hi \u{1F600}";' }])}`),
  );
  assert.deepEqual(ids(script), [], messages(script));
});

test('precheck pivot-analytics: pivottable/pivotchart reports warn once each', () => {
  const report = fromSource(
    app(
      'Precheck_Pivot',
      `${itemForm()}\treports
\t{
\t\tpivottable Pivot_Items
\t\t{
\t\t\tshow all rows from Item
\t\t\t(
\t\t\t\tTitle
\t\t\t)
\t\t}
\t\tpivotchart Pivot_Chart
\t\t{
\t\t\tshow all rows from Item
\t\t\t(
\t\t\t\tTitle
\t\t\t)
\t\t}
\t}
`,
    ),
  );
  assert.deepEqual(brief(report), ['pivot-analytics:warning', 'pivot-analytics:warning'], messages(report));
});

test('c2c precheck exits 4 on a truncated .ds (unclosed application block)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-precheck-trunc-'));
  try {
    const truncated = path.join(dir, 'truncated.ds');
    writeFileSync(truncated, '/* Creator export */\napplication "Half_App"\n{\n\tforms\n\t{\n\t\tform Item\n\t\t{\n');
    const run = spawnSync(process.execPath, [cli, 'precheck', truncated, '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 4, run.stdout + run.stderr);
    assert.match(run.stderr, /cannot parse|unclosed/);
    assert.doesNotMatch(run.stdout, /findings 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('precheck reports a table over the Data Store unique varchar budget', () => {
  const report = fromSource(
    app(
      'Users',
      `\tform Add_User
\t{
\t\tmust have unique Mail_ID
\t\t(
\t\t\ttype = email
\t\t)
\t\tunique Phone
\t\t(
\t\t\ttype = phonenumber
\t\t)
\t\tunique Code
\t\t(
\t\t\ttype = text
\t\t)
\t}
`,
    ),
  );
  const found = report.findings.filter((finding) => finding.check === 'unique-varchar-budget');
  assert.equal(found.length, 1, messages(report));
  assert.equal(found[0]!.severity, 'warning');
  assert.equal(found[0]!.location.form, 'Add_User');
  assert.match(found[0]!.message, /Data Store allows 2 unique varchar columns per table/);
  assert.match(found[0]!.message, /Store-level unique: Mail_ID, Phone\. Checked by the c2c handler instead: Code\./);
  const two = fromSource(app('Users', `\tform Add_User\n\t{\n\t\tunique Mail_ID\n\t\t(\n\t\t\ttype = email\n\t\t)\n\t\tunique Phone\n\t\t(\n\t\t\ttype = phonenumber\n\t\t)\n\t}\n`));
  assert.equal(two.findings.filter((finding) => finding.check === 'unique-varchar-budget').length, 0);
});

test('precheck undefined-variable: a read that is never assigned blocks; bound names stay silent', () => {
  const bad = '\t\t\t\t\t\t\tif(blockedList.contains(input.Title))\n\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\tcancel submit;\n\t\t\t\t\t\t\t}';
  const clean = [
    '\t\t\t\t\t\t\tknown = 1;',
    '\t\t\t\t\t\t\tfor each row in Item[Qty > 0]',
    '\t\t\t\t\t\t\t{',
    '\t\t\t\t\t\t\t\tm = {key: row.Qty};',
    '\t\t\t\t\t\t\t\tif(known > 0 && Item[Title == input.Title].count() > 0)',
    '\t\t\t\t\t\t\t\t{',
    '\t\t\t\t\t\t\t\t\tinfo m;',
    '\t\t\t\t\t\t\t\t}',
    '\t\t\t\t\t\t\t\tdisable Title;',
    '\t\t\t\t\t\t\t}',
  ].join('\n');
  const source = app(
    'Undef',
    `${itemForm()}${handlers([
      { event: 'on validate', script: bad },
      { event: 'on load', script: clean },
    ])}`,
  );
  const report = fromSource(source);
  const undef = report.findings.filter((finding) => finding.check === 'undefined-variable');
  assert.equal(undef.length, 1, messages(report));
  const finding = undef[0]!;
  assert.equal(finding.severity, 'blocker');
  assert.ok(finding.message.includes("Variable 'blockedList' is not defined."), finding.message);
  const wantLine = source.split('\n').findIndex((line) => line.includes('blockedList')) + 1;
  assert.equal(finding.location.line, wantLine);
  assert.equal(finding.location.form, 'Item');
});

test('precheck undefined-variable: one finding per script per name, and a later assignment still binds', () => {
  const script = [
    '\t\t\t\t\t\t\tinfo late;',
    '\t\t\t\t\t\t\tlate = 2;',
    '\t\t\t\t\t\t\tx = ghostA + ghostA;',
    '\t\t\t\t\t\t\tif(ghostA > 1)',
    '\t\t\t\t\t\t\t{',
    '\t\t\t\t\t\t\t\tinfo ghostA;',
    '\t\t\t\t\t\t\t}',
    '\t\t\t\t\t\t\ty = x;',
    '\t\t\t\t\t\t\tinfo y;',
  ].join('\n');
  const source = app('Undef', `${itemForm()}${handlers([{ event: 'on load', script }])}`);
  const report = fromSource(source);
  const undef = report.findings.filter((finding) => finding.check === 'undefined-variable');
  assert.equal(undef.length, 1, messages(report));
  assert.ok(undef[0]!.message.includes("Variable 'ghostA' is not defined."), undef[0]!.message);
});

/** A connection block: link name, display name, connector word. */
function connectionBlock(link: string, displayName: string): string {
  return `\t\t${link}
\t\t(
\t\t\tdisplayname = "${displayName}"
\t\t\tconnector = zohocrm1
\t\t)
`;
}

/** One function that passes `arg` as the CRM connection, plus the connections block. */
function connectionApp(arg: string, blocks: string, extra = ''): string {
  return app(
    'Conn_Display',
    `\tfunctions
\t{
\t\tmap pushCaseToCrm(int woId)
\t\t{
\t\t\tcaseMap = Map();
\t\t\tresp = zoho.crm.createRecord("Cases", caseMap, Map(), "${arg}");
\t\t\treturn resp;
\t\t}
${extra}\t}
\tconnections
\t{
${blocks}\t}
`,
  );
}

function generatedCall(source: string): string {
  const file = generate(deriveIr(parse(source))).files.find((item) => item.path === 'functions/custom/pushcasetocrm.mjs');
  assert.ok(file, 'generated function');
  return file.source;
}

test('a connection argument that is a display name warns and the generated call uses the link name', () => {
  const source = connectionApp('FS CRM', connectionBlock('fs_crm', 'FS CRM') + connectionBlock('fs_books', 'FS Books'));
  const report = fromSource(source);
  const hits = report.findings.filter((finding) => finding.check === 'connection-display-name');
  assert.equal(hits.length, 1, messages(report));
  assert.equal(hits[0]!.severity, 'warning');
  assert.match(hits[0]!.message, /FS CRM/);
  assert.match(hits[0]!.message, /fs_crm/);
  assert.ok(report.counts.warning >= 1);
  const call = generatedCall(source);
  assert.match(call, /\["crm","createRecord"\], \["Cases", caseMap, \{\}, "fs_crm"\]/);
  assert.doesNotMatch(call, /"FS CRM"/);
  const migration = generate(deriveIr(parse(source))).files.find((item) => item.path === 'migration-report.json');
  assert.ok(migration);
  const parsed = JSON.parse(migration.source) as { connections: { entries: { link: string; configKey: string }[] } };
  assert.deepEqual(
    parsed.connections.entries.map((entry) => entry.link),
    ['fs_crm'],
  );
  assert.equal(parsed.connections.entries[0]!.configKey, 'fs_crm');

  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-precheck-conn-'));
  try {
    const file = path.join(dir, 'conn.ds');
    writeFileSync(file, source);
    const run = spawnSync(process.execPath, [cli, 'precheck', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /connection-display-name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection argument that is already the link name is unchanged', () => {
  const source = connectionApp('fs_crm', connectionBlock('fs_crm', 'FS CRM'));
  const report = fromSource(source);
  assert.equal(report.findings.filter((finding) => finding.check === 'connection-display-name').length, 0, messages(report));
  assert.match(generatedCall(source), /"fs_crm"/);
  assert.doesNotMatch(generatedCall(source), /"FS CRM"/);
});

test('a display name that equals the link name is not rewritten', () => {
  const source = connectionApp('zoho_book', connectionBlock('zoho_book', 'zoho_book'));
  const report = fromSource(source);
  assert.equal(report.findings.filter((finding) => finding.check === 'connection-display-name').length, 0, messages(report));
  assert.match(generatedCall(source), /\["Cases", caseMap, \{\}, "zoho_book"\]/);
});

test('a display name on a non-connection argument is left as data', () => {
  const source = connectionApp('fs_crm', connectionBlock('fs_crm', 'Cases'));
  const report = fromSource(source);
  assert.equal(report.findings.filter((finding) => finding.check === 'connection-display-name').length, 0, messages(report));
  assert.match(generatedCall(source), /\["Cases", caseMap, \{\}, "fs_crm"\]/);
});

test('an invokeurl connection display name warns and the generated call uses the link name', () => {
  const source = app(
    'Conn_Display',
    `\tfunctions
\t{
\t\tmap pushCaseToCrm(int woId)
\t\t{
\t\t\tresp = invokeurl
\t\t\t[
\t\t\t\turl :"https://example.com/hook"
\t\t\t\ttype :GET
\t\t\t\tconnection :"FS CRM"
\t\t\t];
\t\t\treturn resp;
\t\t}
\t}
\tconnections
\t{
${connectionBlock('fs_crm', 'FS CRM')}\t}
`,
  );
  const report = fromSource(source);
  const hits = report.findings.filter((finding) => finding.check === 'connection-display-name');
  assert.equal(hits.length, 1, messages(report));
  assert.equal(hits[0]!.severity, 'warning');
  const call = generatedCall(source);
  assert.match(call, /"connection": "fs_crm"/);
  assert.doesNotMatch(call, /"FS CRM"/);
});

test('two connections with the same display name stay unresolved and still block', () => {
  const source = connectionApp('Shared', connectionBlock('a_one', 'Shared') + connectionBlock('b_two', 'Shared'));
  const report = fromSource(source);
  const hits = report.findings.filter((finding) => finding.check === 'connection-display-name');
  assert.equal(hits.length, 1, messages(report));
  assert.equal(hits[0]!.severity, 'blocker');
  assert.match(hits[0]!.message, /a_one/);
  assert.match(hits[0]!.message, /b_two/);
  assert.match(generatedCall(source), /\["Cases", caseMap, \{\}, "Shared"\]/);

  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-precheck-conn-'));
  try {
    const file = path.join(dir, 'conn.ds');
    writeFileSync(file, source);
    const run = spawnSync(process.execPath, [cli, 'precheck', file], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /connection-display-name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
