/**
 * Approvals and blueprints in the React target. The spec's `workflows`
 * come from the generated flow modules' `machine` literal, the menu's
 * `systemcomponent { type = approval }` entries become flow nav items, and
 * governed forms mount the stage bar on the edit screen.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type App, type Property, type Span, type Workflow } from '../../core/src/index.js';
import { generateReactApp, type ReactFile } from '../src/index.js';
import type { AppSpec } from '../template/lib/c2c-ui/types.js';
import { machineFlows } from '../src/workflow.js';

const Z: Span = { start: 0, end: 0 };

function field(name: string, type: string, extra = ''): string {
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${name}\n\t\t(\n${lines}\n\t\t)`;
}

/** A form, its list report, and the Approvals section a Creator export declares. */
function source(opts: { approvals?: boolean } = {}): string {
  const section = opts.approvals === false ? '' : `\t\t\t\tsection ZC_Approvals
\t\t\t\t{
\t\t\t\t\tdisplayname = "Approvals"
\t\t\t\t\tsystemcomponent
\t\t\t\t\t{
\t\t\t\t\t\ttype = approval
\t\t\t\t\t\tapproval status = pending
\t\t\t\t\t\tdisplayname = "Pending Tasks"
\t\t\t\t\t}
\t\t\t\t\tsystemcomponent
\t\t\t\t\t{
\t\t\t\t\t\ttype = approval
\t\t\t\t\t\tapproval status = completed
\t\t\t\t\t\tdisplayname = "Completed Tasks"
\t\t\t\t\t}
\t\t\t\t}
`;
  return `application "Contacts"
{
\tform New_Contact
\t{
\t\tdisplayname = "New Contact"
${field('Full_Name', 'text', '\t\t\tdisplayname = "Full Name"')}
${field('Email', 'email')}
\t}
\tlist All_Contacts
\t{
\t\tdisplayname = "All Contacts"
\t\tshow all rows from New_Contact
\t\t(
\t\t\tFull_Name
\t\t\tEmail
\t\t)
\t}
\tweb
\t{
\t\tmenu
\t\t{
\t\t\tspace Space
\t\t\t{
\t\t\t\tdisplayname = "Space"
\t\t\t\tsection Main
\t\t\t\t{
\t\t\t\t\tdisplayname = "Main"
\t\t\t\t\tform New_Contact
\t\t\t\t\t{
\t\t\t\t\t}
\t\t\t\t\treport All_Contacts
\t\t\t\t\t{
\t\t\t\t\t}
\t\t\t\t}
${section}\t\t\t}
\t\t}
\t}
}
`;
}

function approval(form = 'New_Contact'): Workflow[] {
  return [
    { name: 'Request_Approval', container: 'approval', form, event: 'on approve', approvers: [{ key: 'level', value: '1', span: Z }], deluge: { text: 'x = 1;', span: Z }, properties: [], span: Z },
    { name: 'Request_Approval', container: 'approval', form, event: 'on reject', deluge: { text: 'x = 2;', span: Z }, properties: [], span: Z },
    { name: 'Request_Approval', container: 'approval', form, event: 'on level 2 / on approve', approvers: [{ key: 'level', value: '2', span: Z }], deluge: { text: 'x = 3;', span: Z }, properties: [], span: Z },
  ];
}

function blueprint(form = 'New_Contact'): Workflow {
  const block = (name: string) => ({ name, properties: [] as Property[], blocks: [], items: [] as string[], span: Z });
  return {
    name: 'Order_Flow',
    container: 'schedule',
    form,
    event: 'blueprint',
    deluge: { text: 'y = 1;', span: Z },
    properties: [],
    blueprint: {
      start: block('Draft'),
      stages: [block('Draft'), block('Review'), block('Done')],
      transitions: [
        { name: 'Send for review as "Send"', fromStage: 'Draft', toStage: 'Review', properties: [], phases: [], span: Z },
        { name: 'Ship', fromStage: 'Review', toStage: 'Done', properties: [], phases: [], span: Z },
      ],
    },
    span: Z,
  };
}

function appOf(text = source()): App {
  return deriveIr(parse(text));
}

function fileOf(files: ReactFile[], path: string): string {
  const file = files.find((f) => f.path === path);
  assert.ok(file, `expected generated file ${path}`);
  return String(file.data);
}

function specOf(files: ReactFile[]): AppSpec {
  const model = fileOf(files, 'src/generated/model.ts');
  const match = /export const model: AppSpec = (\{[\s\S]*\});/.exec(model);
  assert.ok(match, 'model.ts carries the spec literal');
  return JSON.parse(match[1]!) as AppSpec;
}

test('the spec carries the machines the generated flow modules declare', () => {
  const app = appOf();
  app.workflows.push(...approval(), blueprint());
  const files = generateReactApp(app);
  const spec = specOf(files);
  const flows = spec.workflows ?? [];
  assert.equal(flows.length, 2);

  const approve = flows.find((flow) => flow.kind === 'approval');
  assert.ok(approve);
  assert.equal(approve.name, 'Request_Approval');
  assert.equal(approve.form, 'New_Contact');
  assert.equal(approve.statusColumn, 'Status');
  assert.equal(approve.start, 'Pending');
  assert.deepEqual(approve.endpoints, {
    approve: '/flows/request-approval/approve',
    reject: '/flows/request-approval/reject',
    transition: '/flows/request-approval/transition',
  });
  assert.deepEqual(approve.stages, ['Pending', 'Pending level 2', 'Approved', 'Rejected']);
  assert.deepEqual(
    approve.transitions.map((t) => [t.action, t.from, t.to]),
    [
      ['approve', 'Pending', 'Pending level 2'],
      ['reject', 'Pending', 'Rejected'],
      ['approve', 'Pending level 2', 'Approved'],
    ],
  );
  // The governed form's report backs the inbox list.
  assert.equal(approve.report, 'All_Contacts');

  const bp = flows.find((flow) => flow.kind === 'blueprint');
  assert.ok(bp);
  assert.equal(bp.form, 'New_Contact');
  assert.deepEqual(bp.stages, ['Draft', 'Review', 'Done']);
  assert.deepEqual(
    bp.transitions.map((t) => [t.name, t.action, t.from, t.to]),
    [
      ['Send', 'transition', 'Draft', 'Review'],
      ['Ship', 'transition', 'Review', 'Done'],
    ],
  );
});

test('the Approvals menu section maps to the two flow routes', () => {
  const app = appOf();
  app.workflows.push(...approval());
  const files = generateReactApp(app);
  const spec = specOf(files);
  const section = spec.nav.find((s) => s.label === 'Approvals');
  assert.ok(section, 'the Approvals section is emitted');
  assert.deepEqual(
    section.items.map((item) => [item.kind, item.name, item.label, item.href]),
    [
      ['flow', 'approvals', 'Pending Tasks', '#/flow/approvals'],
      ['flow', 'approvals/completed', 'Completed Tasks', '#/flow/approvals/completed'],
    ],
  );
  const routes = fileOf(files, 'src/generated/routes.tsx');
  assert.match(routes, /"flow\/approvals"/);
  assert.match(routes, /"flow\/approvals\/completed"/);
  const screen = fileOf(files, 'src/generated/workflow/approvals.tsx');
  assert.match(screen, /ApprovalsInbox/);
  assert.match(screen, /view=\{view\}/);
});

test('an app with machines but no Approvals menu entry still gets the section', () => {
  const app = appOf(source({ approvals: false }));
  app.workflows.push(...approval());
  const spec = specOf(generateReactApp(app));
  const section = spec.nav.find((s) => s.label === 'Approvals');
  assert.ok(section, 'fallback Approvals section is emitted');
  assert.deepEqual(
    section.items.map((item) => item.name),
    ['approvals', 'approvals/completed'],
  );
});

test('a governed form mounts the stage bar; an ungoverned app emits no workflow files', () => {
  const app = appOf();
  app.workflows.push(...approval(), blueprint());
  const files = generateReactApp(app);
  const form = fileOf(files, 'src/generated/forms/New_Contact.tsx');
  assert.match(form, /FlowStageBar form=\{form\} rowId=\{edit\}/);

  // No machines and no Approvals menu entry: nothing workflow-shaped is emitted.
  const plain = generateReactApp(appOf(source({ approvals: false })));
  const plainSpec = specOf(plain);
  assert.equal(plainSpec.workflows, undefined);
  assert.equal(plainSpec.nav.some((section) => section.items.some((item) => item.kind === 'flow')), false);
  assert.equal(plain.some((file) => file.path.startsWith('src/generated/workflow/')), false);
});

test('machineFlows ignores non-flow files and malformed literals', () => {
  const flows = machineFlows([
    { path: 'functions/flow/x.mjs', data: 'export const machine = {oops' },
    { path: 'functions/aio/y.mjs', data: 'export const machine = {};\n' },
    { path: 'functions/flow/z.mjs', data: 'no machine here' },
  ]);
  assert.deepEqual(flows, []);
});
