/**
 * Blueprint transition owners and during-phase field settings in the
 * generated state machine. A transition call by a caller who is not an owner
 * answers 403 with the reason; an owner kind the generator cannot resolve
 * denies instead of opening the transition. A transition's `during` fields
 * are the only fields a call may set (400 naming any other), and its
 * mandatory fields must be filled.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { emptyApp, type App, type BlueprintTransition, type Property, type PropertyBlock } from '../../core/src/index.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import { generate } from '../src/generate.js';

const Z = { start: 0, end: 0 };
const prop = (key: string, value: string): Property => ({ key, value, span: Z });
const pb = (name: string, properties: Property[] = [], blocks: PropertyBlock[] = []): PropertyBlock => ({ name, properties, blocks, items: [], span: Z });
type Phase = BlueprintTransition['phases'][number];
const phase = (name: string, properties: Property[], blocks: PropertyBlock[] = []): Phase => ({ phase: name, properties, blocks, deluge: [], span: Z });

function field(name: string, type = 'text'): App['forms'][number]['fields'][number] {
  return { name, type, modifiers: [], required: false, unique: false, properties: [], subfields: [], annotations: [], flags: [], span: Z };
}

const staff = {
  name: 'Staff',
  type: 'Users_Permissions',
  properties: [],
  modules: [{ component: 'Orders', properties: [{ key: 'enabled', value: 'viewall', span: Z }], reports: [], fields: [], span: Z }],
  span: Z,
} as unknown as App['profiles'][number];

/** Orders blueprint: `Draft → Review` via `Send`; the transition is the variable part. */
function ordersApp(send: Partial<BlueprintTransition>, stages: PropertyBlock[] = [pb('Draft'), pb('Review')]): App {
  return {
    ...emptyApp('empty'),
    name: 'Demo_App',
    profiles: [staff],
    forms: [{ name: 'Orders', properties: [], fields: [field('Amount'), field('Notes'), field('Approved_Amount'), field('Assigned_To', 'users')], actions: [], blocks: [], span: Z }],
    workflows: [
      {
        name: 'Order flow',
        form: 'Orders',
        event: 'blueprint',
        deluge: null,
        properties: [],
        span: Z,
        blueprint: {
          start: pb('Draft'),
          stages,
          transitions: [{ name: 'Send', fromStage: 'Draft', toStage: 'Review', properties: [], phases: [], span: Z, ...send }],
        },
      },
    ],
  };
}

function invoke(handler: (req: unknown, res: unknown) => unknown, req: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(body: string) {
      raw = body;
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} }));
}

type Machine = Record<string, (...args: unknown[]) => unknown>;

async function machineOf(g: ReturnType<typeof generate>): Promise<Machine> {
  const file = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(file, 'a machine module is generated');
  const dir = mkdtempSync(join(tmpdir(), 'c2c-owner-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    const path = join(dir, 'flow.mjs');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.source);
    return (await import(pathToFileURL(path).href)) as Machine;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Live mode over a mock store preloaded with Orders rows (ROWIDs from 1000). */
async function live(rows: Record<string, unknown>[], t: { after(fn: () => void): void }): Promise<ReturnType<typeof mockDatastore>['datastore']> {
  const { datastore } = mockDatastore({});
  const prev = { mode: process.env.C2C_DEPLOY_MODE, zone: process.env.C2C_APP_TIMEZONE, store: (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore };
  process.env.C2C_DEPLOY_MODE = 'live';
  process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  if (rows.length) await datastore.insert('Orders', rows);
  t.after(() => {
    if (prev.mode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = prev.mode;
    if (prev.zone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = prev.zone;
    if (prev.store === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = prev.store;
  });
  return datastore;
}

const as = (loginUser: string, role = 'Clerk') => ({ user: { profile: 'Staff', role, loginUser } });
const asProfile = (loginUser: string, profile: string) => ({ user: { profile, role: '', loginUser } });
const profileOf = (name: string) => ({ ...staff, name }) as App['profiles'][number];

/**
 * The POR export shape: owner settings live in a `transition owner ( ... )`
 * block of the `before` phase — `permissions` names profiles and `userfields`
 * names the record's users fields — and a reject transition's `during` lists
 * `visible fields` but no updatable set.
 */
function porApp(): App {
  const owner = (properties: Property[]) => pb('transition owner', properties);
  const transitions: BlueprintTransition[] = [
    {
      name: 'Submit_Request as "Submit Request"',
      fromStage: 'Draft',
      toStage: 'Pending Manager Approval',
      properties: [],
      phases: [phase('before', [], [owner([prop('permissions', '{Employee}')])])],
      span: Z,
    },
    {
      name: 'Manager_Approve as "Manager Approve"',
      fromStage: 'Pending Manager Approval',
      toStage: 'Approved',
      properties: [],
      phases: [phase('before', [], [owner([prop('permissions', '{Purchase_Approver}'), prop('userfields', '{Assigned_Approver}')])])],
      span: Z,
    },
    {
      name: 'Manager_Reject as "Manager Reject"',
      fromStage: 'Pending Manager Approval',
      toStage: 'Rejected',
      properties: [],
      phases: [
        phase('before', [], [owner([prop('permissions', '{Purchase_Approver}'), prop('userfields', '{Assigned_Approver}')])]),
        phase('during', [prop('action', 'update_fields'), prop('workflow status', 'true'), prop('visible fields', '[Rejection_Reason, Status]')]),
      ],
      span: Z,
    },
    {
      name: 'Finance_Issue_PO as "Finance Issue PO"',
      fromStage: 'Approved',
      toStage: 'PO Issued',
      properties: [],
      phases: [phase('before', [], [owner([prop('permissions', '{Finance,Procurement_Admin}')])])],
      span: Z,
    },
  ];
  return {
    ...emptyApp('empty'),
    name: 'POR_App',
    profiles: ['Employee', 'Purchase_Approver', 'Finance', 'Procurement_Admin'].map(profileOf),
    forms: [
      {
        name: 'Orders',
        properties: [],
        fields: [field('Amount'), field('Notes'), field('Rejection_Reason'), field('Status'), field('Assigned_Approver', 'users')],
        actions: [],
        blocks: [],
        span: Z,
      },
    ],
    workflows: [
      {
        name: 'POR flow',
        form: 'Orders',
        event: 'blueprint',
        deluge: null,
        properties: [],
        span: Z,
        blueprint: {
          start: pb('Draft'),
          stages: [pb('Draft'), pb('Pending Manager Approval'), pb('Approved'), pb('Rejected'), pb('PO Issued')],
          transitions,
        },
      },
    ],
  };
}

test('a user owner in the before phase may transition; any other caller gets 403 with the reason', async (t) => {
  const mod = await machineOf(generate(ordersApp({ phases: [phase('before', [prop('users', '"owner@example.test"')])] })));
  await live([{ Amount: '10', Status: 'Draft' }], t);
  const denied = await invoke(mod.transition, { ...as('other@example.test'), body: { ROWID: '1000', status: 'Review' } });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error, 'caller is not an owner of this transition');
  const ok = await invoke(mod.transition, { ...as('owner@example.test'), body: { ROWID: '1000', status: 'Review' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'Review');
});

test('a role owner in an owners section admits that role only', async (t) => {
  const g = generate(ordersApp({ phases: [phase('owners', [prop('roles', '"Manager"')])] }));
  assert.ok(!g.todos.some((todo) => /owners/.test(todo.construct)), `owner settings are consumed, got ${JSON.stringify(g.todos.map((todo) => todo.construct))}`);
  const mod = await machineOf(g);
  await live([{ Amount: '10', Status: 'Draft' }, { Amount: '20', Status: 'Draft' }], t);
  const clerk = await invoke(mod.transition, { ...as('a@example.test', 'Clerk'), body: { ROWID: '1000', status: 'Review' } });
  assert.equal(clerk.status, 403, JSON.stringify(clerk.body));
  assert.equal(clerk.body.error, 'caller is not an owner of this transition');
  const manager = await invoke(mod.transition, { ...as('b@example.test', 'Manager'), body: { ROWID: '1001', status: 'Review' } });
  assert.equal(manager.status, 200, JSON.stringify(manager.body));
});

test('a field owner admits the user the record assigns', async (t) => {
  const mod = await machineOf(generate(ordersApp({ phases: [phase('before', [prop('user field', 'Assigned_To')])] })));
  await live([{ Amount: '10', Status: 'Draft', Assigned_To: 'kim@example.test' }], t);
  const stranger = await invoke(mod.transition, { ...as('lee@example.test'), body: { ROWID: '1000', status: 'Review' } });
  assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
  const assigned = await invoke(mod.transition, { ...as('kim@example.test'), body: { ROWID: '1000', status: 'Review' } });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
});

test('an owner setting of no known kind denies and is listed, never opens the transition', async (t) => {
  const g = generate(ordersApp({ properties: [prop('owners', '"someone"')] }));
  assert.ok(g.todos.some((todo) => todo.construct === 'blueprint-transition-owner'), JSON.stringify(g.todos.map((todo) => todo.construct)));
  const mod = await machineOf(g);
  await live([{ Amount: '10', Status: 'Draft' }], t);
  const denied = await invoke(mod.transition, { ...as('someone'), body: { ROWID: '1000', status: 'Review' } });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error, 'unsupported: transition owner kind');
});

test('during a transition only its fields may be set, and mandatory ones must be filled', async (t) => {
  const g = generate(ordersApp({ phases: [phase('during', [prop('fields', 'Notes'), prop('mandatory fields', 'Approved_Amount')])] }));
  assert.ok(!g.todos.some((todo) => /fields/.test(todo.construct)), JSON.stringify(g.todos.map((todo) => todo.construct)));
  const mod = await machineOf(g);
  const datastore = await live([{ Amount: '10', Status: 'Draft' }], t);
  const other = await invoke(mod.transition, { ...as('a@example.test'), body: { ROWID: '1000', status: 'Review', fields: { Approved_Amount: '9', Amount: '99' } } });
  assert.equal(other.status, 400, JSON.stringify(other.body));
  assert.equal(other.body.field, 'Amount');
  assert.match(String(other.body.error), /Amount is not updatable during transition Send/);
  const missing = await invoke(mod.transition, { ...as('a@example.test'), body: { ROWID: '1000', status: 'Review', fields: { Notes: 'n' } } });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  assert.equal(missing.body.field, 'Approved_Amount');
  const ok = await invoke(mod.transition, { ...as('a@example.test'), body: { ROWID: '1000', status: 'Review', fields: { Approved_Amount: '9', Notes: 'n' } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const rows = (await datastore.query('Orders', "ROWID = '1000'", 1, 0, 'ORDER BY ROWID')) as Record<string, unknown>[];
  assert.deepEqual([rows[0]?.Status, rows[0]?.Approved_Amount, rows[0]?.Notes, rows[0]?.Amount], ['Review', '9', 'n', '10']);
});

test('stage field settings: the read drops hidden fields and an edit of a locked field is refused', async () => {
  const mod = await machineOf(
    generate(ordersApp({}, [pb('Draft'), pb('Review', [prop('hidden fields', 'Amount'), prop('editable fields', 'Notes')])])),
  );
  const stored = { ROWID: '1', Status: 'Review', Amount: '10', Notes: 'x', Approved_Amount: '' };
  assert.deepEqual(Object.keys(mod.visibleRecord!({ ROWID: '1', Amount: '10', Notes: 'x' }, stored) as object).sort(), ['Notes', 'ROWID']);
  assert.deepEqual(mod.stageUpdateError!(stored, ['Approved_Amount']), { field: 'Approved_Amount', error: 'field Approved_Amount is not updatable in stage Review' });
  assert.deepEqual(mod.stageUpdateError!(stored, ['Amount']), { field: 'Amount', error: 'field Amount is not updatable in stage Review' });
  assert.equal(mod.stageUpdateError!(stored, ['Notes']), '');
  // A stage with no settings leaves the record and every field alone.
  const draft = { ...stored, Status: 'Draft' };
  assert.equal(mod.stageUpdateError!(draft, ['Amount']), '');
  assert.deepEqual(Object.keys(mod.visibleRecord!(draft, draft) as object).sort(), ['Amount', 'Approved_Amount', 'Notes', 'ROWID', 'Status']);
});

test('during action=update_fields and workflow status are consumed; workflowStatus rides the machine row', async () => {
  const g = generate(porApp());
  assert.ok(
    !g.todos.some((todo) => todo.construct === 'blueprint-phase-property-action' || todo.construct === 'blueprint-phase-property-workflow status'),
    `the update-fields action and workflow status are migrated, got ${JSON.stringify(g.todos.map((todo) => todo.construct))}`,
  );
  const file = g.files.find((item) => item.path.startsWith('functions/flow/'))!;
  const machine = JSON.parse(/export const machine = (\{[\s\S]*?\n\});/.exec(file.source)![1]!) as {
    transitions: { name: string; workflowStatus?: boolean }[];
  };
  for (const name of ['Manager Reject']) {
    assert.equal(machine.transitions.find((row) => row.name === name)?.workflowStatus, true, `${name} is an update-fields transition`);
  }
  for (const row of machine.transitions) {
    if (row.name !== 'Manager Reject') assert.equal(row.workflowStatus, undefined, `${row.name} is not an update-fields transition`);
  }
});

test('a during action that is not update_fields and a non-boolean workflow status stay listed', () => {
  const g = generate(
    ordersApp({
      phases: [phase('during', [prop('action', 'add_record'), prop('workflow status', 'maybe'), prop('visible fields', 'Notes')])],
    }),
  );
  const constructs = g.todos.map((todo) => todo.construct);
  assert.ok(constructs.includes('blueprint-phase-property-action'), JSON.stringify(constructs));
  assert.ok(constructs.includes('blueprint-phase-property-workflow status'), JSON.stringify(constructs));
});

/**
 * The generated tree, materialized under a temp root with every emitted file
 * in place so the machine's `../aio/...` on-edit imports resolve.
 */
async function treeOf(g: ReturnType<typeof generate>, t: { after(fn: () => void): void }): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-wfstatus-'));
  // The machine imports the aio modules lazily, on the transition call, so the
  // tree must outlive the import of the flow module itself.
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of g.files) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.source);
  }
  const flow = g.files.find((f) => f.path.startsWith('functions/flow/'))!;
  return (await import(pathToFileURL(join(dir, flow.path)).href)) as Machine;
}

/** POR-shaped reject transition plus the form's on-edit workflows. */
function porWithEditWorkflows(status: string): App {
  const app = porApp();
  const forms = app.forms as App['forms'];
  forms.push({ name: 'Audit_Log', properties: [], fields: [field('Event'), field('Note')], actions: [], blocks: [], span: Z });
  const orders = app.workflows[0]!.blueprint!.transitions.find((row) => row.name === 'Manager_Reject as "Manager Reject"')!;
  orders.phases.push(phase('during', [prop('action', 'update_fields'), prop('workflow status', status), prop('visible fields', '[Rejection_Reason, Status]')]));
  const audit = `insert into Audit_Log [ Event = "rejected" Note = input.Rejection_Reason ];`;
  const workflows: App['workflows'] = [
    {
      name: 'validate edit',
      form: 'Orders',
      event: 'on validate',
      recordEvent: 'on edit',
      properties: [],
      span: Z,
      deluge: { text: 'if (input.Rejection_Reason == "block") { cancel submit; }', span: Z },
    },
    {
      name: 'audit edit',
      form: 'Orders',
      event: 'on success',
      recordEvent: 'on edit',
      properties: [],
      span: Z,
      deluge: { text: audit, span: Z },
    },
  ];
  return { ...app, workflows: [...app.workflows, ...workflows] };
}

test('workflow status = true fires the form on-edit workflows on the transition save', async (t) => {
  const g = generate(porWithEditWorkflows('true'));
  const mod = await treeOf(g, t);
  const datastore = await live([{ Amount: '20', Flow_Status: 'Pending Manager Approval', Assigned_Approver: 'kim@example.test' }], t);
  const blocked = await invoke(mod.transition, {
    ...asProfile('kim@example.test', 'Employee'),
    body: { ROWID: '1000', status: 'Rejected', fields: { Rejection_Reason: 'block', Status: 'Rejected' } },
  });
  // The edit-scope on-validate cancel submit refuses: the stage does not move.
  assert.equal(blocked.status, 422, JSON.stringify(blocked.body));
  let rows = (await datastore.query('Orders', "ROWID = '1000'", 1, 0, 'ORDER BY ROWID')) as Record<string, unknown>[];
  assert.equal(rows[0]?.Flow_Status, 'Pending Manager Approval');
  const ok = await invoke(mod.transition, {
    ...asProfile('kim@example.test', 'Employee'),
    body: { ROWID: '1000', status: 'Rejected', fields: { Rejection_Reason: 'missing quote', Status: 'Rejected' } },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  rows = (await datastore.query('Orders', "ROWID = '1000'", 1, 0, 'ORDER BY ROWID')) as Record<string, unknown>[];
  assert.equal(rows[0]?.Flow_Status, 'Rejected');
  const audit = (await datastore.query('Audit_Log', '', 10, 0, 'ORDER BY ROWID')) as Record<string, unknown>[];
  assert.equal(audit.length, 1, `the on-edit on-success workflow ran: ${JSON.stringify(audit)}`);
  assert.equal(audit[0]?.Event, 'rejected');
});

test('workflow status = false skips the form on-edit workflows on the transition save', async (t) => {
  const mod = await treeOf(generate(porWithEditWorkflows('false')), t);
  const datastore = await live([{ Amount: '20', Flow_Status: 'Pending Manager Approval', Assigned_Approver: 'kim@example.test' }], t);
  const ok = await invoke(mod.transition, {
    ...asProfile('kim@example.test', 'Employee'),
    body: { ROWID: '1000', status: 'Rejected', fields: { Rejection_Reason: 'block', Status: 'Rejected' } },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const rows = (await datastore.query('Orders', "ROWID = '1000'", 1, 0, 'ORDER BY ROWID')) as Record<string, unknown>[];
  assert.equal(rows[0]?.Flow_Status, 'Rejected');
  const audit = (await datastore.query('Audit_Log', '', 10, 0, 'ORDER BY ROWID')) as Record<string, unknown>[];
  assert.equal(audit.length, 0, `the on-edit workflows were skipped: ${JSON.stringify(audit)}`);
});

/** The reject transition with an after-phase script that writes an Audit_Log row. */
function porWithAfterScript(): App {
  const app = porWithEditWorkflows('true');
  const reject = app.workflows[0]!.blueprint!.transitions.find((row) => row.name === 'Manager_Reject as "Manager Reject"')!;
  const after = phase('after', []);
  after.deluge.push({ text: 'insert into Audit_Log [ Event = "after-script" Note = input.Rejection_Reason ];', span: Z });
  reject.phases.push(after);
  return app;
}

/** Live store whose Audit_Log inserts record the Orders stage at insert time. */
async function auditedStore(t: { after(fn: () => void): void }) {
  const datastore = await live([{ Amount: '20', Flow_Status: 'Pending Manager Approval', Assigned_Approver: 'kim@example.test' }], t);
  const stageAtAudit: unknown[] = [];
  const insert = datastore.insert.bind(datastore);
  datastore.insert = (async (table: string, rows: Record<string, unknown>[]) => {
    if (table === 'Audit_Log') {
      const orders = (await datastore.query('Orders', "ROWID = '1000'", 1, 0, 'ORDER BY ROWID')) as Record<string, unknown>[];
      stageAtAudit.push(...rows.map((row) => `${String(row.Event)}@${String(orders[0]?.Flow_Status)}`));
    }
    return insert(table, rows);
  }) as typeof datastore.insert;
  const audit = async () => ((await datastore.query('Audit_Log', '', 10, 0, 'ORDER BY ROWID')) as Record<string, unknown>[]).map((row) => row.Event);
  const stage = async () => ((await datastore.query('Orders', "ROWID = '1000'", 1, 0, 'ORDER BY ROWID')) as Record<string, unknown>[])[0]?.Flow_Status;
  return { audit, stage, stageAtAudit };
}

test('a refused transition (422, 400, 403) runs no after-phase script', async (t) => {
  const mod = await treeOf(generate(porWithAfterScript()), t);
  const store = await auditedStore(t);
  const refusals: [number, Record<string, unknown>][] = [
    [422, { ...asProfile('kim@example.test', 'Employee'), body: { ROWID: '1000', status: 'Rejected', fields: { Rejection_Reason: 'block', Status: 'Rejected' } } }],
    [400, { ...asProfile('kim@example.test', 'Employee'), body: { ROWID: '1000', status: 'Rejected', fields: { Amount: '1', Status: 'Rejected' } } }],
    [403, { ...asProfile('lee@example.test', 'Employee'), body: { ROWID: '1000', status: 'Rejected', fields: { Rejection_Reason: 'why', Status: 'Rejected' } } }],
  ];
  for (const [code, req] of refusals) {
    const res = await invoke(mod.transition, req);
    assert.equal(res.status, code, JSON.stringify(res.body));
    assert.deepEqual(await store.audit(), [], `a ${code} refusal leaves no after-script or workflow row`);
    assert.equal(await store.stage(), 'Pending Manager Approval');
  }
});

test('a successful transition runs the after-phase script once, after the stage write', async (t) => {
  const mod = await treeOf(generate(porWithAfterScript()), t);
  const store = await auditedStore(t);
  const ok = await invoke(mod.transition, {
    ...asProfile('kim@example.test', 'Employee'),
    body: { ROWID: '1000', status: 'Rejected', fields: { Rejection_Reason: 'missing quote', Status: 'Rejected' } },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await store.stage(), 'Rejected');
  assert.deepEqual((await store.audit()).filter((event) => event === 'after-script'), ['after-script'], 'the after script ran exactly once');
  assert.deepEqual(store.stageAtAudit, ['rejected@Pending Manager Approval', 'after-script@Rejected'], 'On Success runs before the stage write, the after script after it');
});

test('a transition owner block resolves permissions to profiles and userfields to field owners', async (t) => {
  const g = generate(porApp());
  assert.ok(
    !g.todos.some((todo) => /transition owner/.test(todo.construct)),
    `the owner block is consumed, got ${JSON.stringify(g.todos.map((todo) => todo.construct))}`,
  );
  const file = g.files.find((item) => item.path.startsWith('functions/flow/'))!;
  const machine = JSON.parse(/export const machine = (\{[\s\S]*?\n\});/.exec(file.source)![1]!) as {
    transitions: { name: string; approvers: { kind: string; value: string }[]; fields?: { visible?: string[] } }[];
  };
  for (const transition of machine.transitions) assert.ok(transition.approvers.length > 0, `${transition.name} must not be open`);
  const submit = machine.transitions.find((row) => row.name === 'Submit Request')!;
  assert.deepEqual(submit.approvers, [{ key: 'profiles', value: 'Employee', kind: 'profile' }]);
  const approve = machine.transitions.find((row) => row.name === 'Manager Approve')!;
  assert.deepEqual(approve.approvers, [
    { key: 'profiles', value: 'Purchase_Approver', kind: 'profile' },
    { key: 'user field', value: 'Assigned_Approver', kind: 'field' },
  ]);
  const reject = machine.transitions.find((row) => row.name === 'Manager Reject')!;
  assert.deepEqual(reject.fields?.visible, ['Rejection_Reason', 'Status']);
  const issue = machine.transitions.find((row) => row.name === 'Finance Issue PO')!;
  assert.deepEqual(issue.approvers, [
    { key: 'profiles', value: 'Finance', kind: 'profile' },
    { key: 'profiles', value: 'Procurement_Admin', kind: 'profile' },
  ]);

  const mod = await machineOf(g);
  await live(
    [
      { Amount: '10', Flow_Status: 'Draft' },
      { Amount: '20', Flow_Status: 'Pending Manager Approval', Assigned_Approver: 'kim@example.test' },
      { Amount: '30', Flow_Status: 'Approved' },
    ],
    t,
  );
  // permissions {Employee}: the Employee profile may submit; another profile may not.
  const notEmployee = await invoke(mod.transition, { ...asProfile('ada@example.test', 'Finance'), body: { ROWID: '1000', status: 'Pending Manager Approval' } });
  assert.equal(notEmployee.status, 403, JSON.stringify(notEmployee.body));
  const employee = await invoke(mod.transition, { ...asProfile('ada@example.test', 'Employee'), body: { ROWID: '1000', status: 'Pending Manager Approval' } });
  assert.equal(employee.status, 200, JSON.stringify(employee.body));
  // Manager Approve: the Purchase_Approver profile or the record's users field admits.
  const notApprover = await invoke(mod.transition, { ...asProfile('ada@example.test', 'Employee'), body: { ROWID: '1001', status: 'Approved' } });
  assert.equal(notApprover.status, 403, JSON.stringify(notApprover.body));
  const approverProfile = await invoke(mod.transition, { ...asProfile('ada@example.test', 'Purchase_Approver'), body: { ROWID: '1001', status: 'Approved' } });
  assert.equal(approverProfile.status, 200, JSON.stringify(approverProfile.body));
  const assigned = await invoke(mod.transition, { ...asProfile('kim@example.test', 'Employee'), body: { ROWID: '1002', status: 'PO Issued' } });
  assert.equal(assigned.status, 403, `a field owner admits only on its own transition: ${JSON.stringify(assigned.body)}`);

  // Finance Issue PO lists two permission names; each admits.
  const finance = await invoke(mod.transition, { ...asProfile('ada@example.test', 'Finance'), body: { ROWID: '1002', status: 'PO Issued' } });
  assert.equal(finance.status, 200, JSON.stringify(finance.body));
});

test('a record-assigned approver may reject, and the during visible fields are settable', async (t) => {
  const mod = await machineOf(generate(porApp()));
  const datastore = await live(
    [
      { Amount: '20', Flow_Status: 'Pending Manager Approval', Assigned_Approver: 'kim@example.test' },
      { Amount: '40', Flow_Status: 'Pending Manager Approval', Assigned_Approver: 'kim@example.test' },
    ],
    t,
  );
  // The record's users field names kim: she may reject even without the profile.
  const reason = await invoke(mod.transition, {
    ...asProfile('kim@example.test', 'Employee'),
    body: { ROWID: '1000', status: 'Rejected', fields: { Rejection_Reason: 'missing quote', Status: 'Rejected' } },
  });
  assert.equal(reason.status, 200, JSON.stringify(reason.body));
  const rows = (await datastore.query('Orders', "ROWID = '1000'", 1, 0, 'ORDER BY ROWID')) as Record<string, unknown>[];
  assert.equal(rows[0]?.Rejection_Reason, 'missing quote');
  // A field the during phase does not list still answers 400 naming it.
  const other = await invoke(mod.transition, {
    ...asProfile('kim@example.test', 'Employee'),
    body: { ROWID: '1001', status: 'Rejected', fields: { Amount: '999' } },
  });
  assert.equal(other.status, 400, JSON.stringify(other.body));
  assert.equal(other.body.field, 'Amount');
});

test('an owner block key the machine cannot map denies and is listed', async (t) => {
  const g = generate(
    ordersApp({ phases: [phase('before', [], [pb('transition owner', [prop('escalation', '"Boss"'), prop('permissions', '{Ghost}')])])] }),
  );
  const counts = g.todos.filter((todo) => todo.construct === 'blueprint-transition-owner').length;
  assert.ok(counts >= 2, `each unmappable owner entry is counted, got ${JSON.stringify(g.todos.map((todo) => todo.construct))}`);
  const mod = await machineOf(g);
  await live([{ Amount: '10', Status: 'Draft' }], t);
  const denied = await invoke(mod.transition, { ...as('boss@example.test'), body: { ROWID: '1000', status: 'Review' } });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error, 'unsupported: transition owner kind');
});
