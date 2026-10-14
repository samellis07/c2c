import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { test } from 'node:test';
import { deriveIr, emptyApp, headerWords, isGroup, parse, parseProject, sig, walkStatements, type App, type BlueprintTransition, type FunctionDef, type Property, type PropertyBlock, type Workflow } from '../../core/src/index.js';
import { createRuntime, LIMITS } from '../../shims/src/runtime.js';
import { RecordAccessError } from '../../shims/src/access.js';
import { mockDatastore } from '../../shims/test/zcql-mock.js';
import { conditionalFieldRules, emittedFieldRuleCondition, fieldRuleDenials, generate, measureActionCriteria, workflowKind, type AlertDiagnostic } from '../src/generate.js';

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

const Z = { start: 0, end: 0 };

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

function app(partial: Partial<App>): App {
  return { ...emptyApp('empty'), name: 'Demo_App', ...partial };
}

function check(source: string, name: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-deluge-'));
  const file = join(dir, name);
  writeFileSync(file, source);
  const ran = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr || ran.stdout);
}

test('handlers embed the IR time zone and still honour C2C_APP_TIMEZONE', () => {
  const g = generate(
    app({
      settings: [{ key: 'time zone', value: '"Asia/Kolkata"', span: Z }],
      workflows: [
        workflow({
          name: 'On add',
          form: 'Orders',
          event: 'on success',
          deluge: { text: 'x = zoho.currentdate;', span: Z },
        }),
      ],
    }),
  );
  const server = g.files.find((f) => f.path === 'functions/aio/orders/on-success.mjs');
  assert.ok(server);
  assert.match(stripComments(server.source), /settingsTimeZone: "Asia\/Kolkata"/);
  assert.match(stripComments(server.source), /C2C_APP_TIMEZONE/);
  const report = g.files.find((f) => f.path === 'migration-report.json');
  assert.ok(report);
  const sized = generate(
    app({
      workflows: [
        workflow({
          name: 'On add',
          form: 'Orders',
          event: 'on success',
          deluge: { text: 'n = rows.get("contacts").size();', span: Z },
        }),
      ],
    }),
  );
  const sizedReport = JSON.parse(sized.files.find((f) => f.path === 'migration-report.json')!.source) as {
    untranslated: { construct: string }[];
  };
  assert.equal(sizedReport.untranslated.some((row) => row.construct === 'method:get'), false);
  assert.equal(sizedReport.untranslated.some((row) => row.construct === 'method:size'), false);
  const sizedServer = sized.files.find((f) => f.path === 'functions/aio/orders/on-success.mjs');
  assert.ok(sizedServer);
  assert.match(stripComments(sizedServer.source), /shim\.list\.size\(shim\.list\.get\(rows, "contacts"\)\)/);
});

test('form events become Advanced I/O handlers and client modules', () => {
  const g = generate(
    app({
      workflows: [
        workflow({
          name: 'On add',
          form: 'Orders',
          event: 'on validate',
          recordEvent: 'on add',
          deluge: { text: 'if(input.A == 1) { alert "x"; }\nx = 1;', span: { start: 40, end: 80 } },
          fieldRules: [{ condition: 'input.A == 1', actions: [{ action: 'hide', fields: ['Secret'] }], span: Z }],
        }),
      ],
    }),
  );
  const server = g.files.find((f) => f.path === 'functions/aio/orders/on-validate.mjs');
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-validate.mjs');
  assert.ok(server);
  assert.ok(client);
  assert.match(stripComments(server.source), /advancedio/);
  assert.match(stripComments(server.source), /row_inserted/);
  assert.match(stripComments(server.source), /x = 1/);
  assert.doesNotMatch(stripComments(server.source), /cancelSubmit|"alert"/);
  assert.doesNotMatch(stripComments(server.source), /body\.old/);
  assert.match(stripComments(server.source), /dry-run-old/);
  assert.match(stripComments(client.source), /"alert"/);
  assert.match(stripComments(client.source), /"hide"/);
  assert.match(stripComments(server.source), /C2C_APP_TIMEZONE/);
  assert.match(stripComments(server.source), /dryRun: true/);
  assert.match(stripComments(server.source), /authorizeWrite/);
  assert.match(stripComments(server.source), /op === "view"/);
  assert.match(stripComments(server.source), /hidden form/);
  assert.doesNotMatch(stripComments(server.source), /\bfetch\s*\(/);
  check(server.source, 'aio.mjs');
  check(client.source, 'client.mjs');
  const shifted = g.todos.filter((t) => t.construct !== 'client-condition-uses-server');
  for (const item of shifted) assert.ok(item.start >= 40);
});

test('a client condition that reads the server gets a prefetch endpoint', () => {
  const g = generate(
    app({
      workflows: [
        workflow({
          name: 'On load',
          form: 'Orders',
          event: 'on load',
          deluge: { text: 'if (Orders[Status == "Open"].count() > 0) { alert "open"; }', span: Z },
        }),
      ],
    }),
  );
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs');
  assert.ok(prefetch);
  assert.ok(client);
  assert.match(stripComments(prefetch.source), /POST \/forms\/Orders\/load\/prefetch/);
  assert.match(stripComments(prefetch.source), /return slots/);
  assert.match(stripComments(prefetch.source), /shim\.datastore\.aggregate/);
  assert.match(stripComments(client.source), /shim\.client\.prefetch/);
  assert.match(stripComments(client.source), /slots\["c0"\]/);
  assert.match(stripComments(client.source), /shim\.client\.touch/);
  assert.match(stripComments(client.source), /prefetched\.ok !== true/);
  assert.match(stripComments(client.source), /client action blocked/);
  assert.match(stripComments(prefetch.source), /principalFromRequest/);
  assert.match(stripComments(prefetch.source), /authenticated caller required/);
  assert.match(stripComments(prefetch.source), /RECORD_ACCESS_DENIED/);
  assert.equal(g.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  check(prefetch.source, 'prefetch.mjs');
  check(client.source, 'client-prefetch.mjs');
});

test('a prefetch that replays a self-assigned binding still honours the caller read policy', async () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Name')]), plainForm('Products', [plainField('Title')])],
      profiles: [
        {
          name: 'Staff',
          type: 'Users_Permissions',
          properties: [],
          modules: [
            {
              component: 'Products',
              properties: [{ key: 'enabled', value: 'viewall', span: Z }],
              reports: [],
              fields: [],
              span: Z,
            },
          ],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'On load',
          form: 'Orders',
          event: 'on load',
          deluge: { text: 'n = 0;\nn = n + 1;\nfor each r in Orders[ID != 0] sort by ID asc range from 1 to n { alert r.Name; }', span: Z },
        }),
      ],
    }),
  );
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  assert.ok(prefetch);
  // The replayed binding and the ranged query run inside the same gated prefetch:
  // a caller with no Orders grant is refused, not served a partial snapshot.
  const mod = await loadModule(prefetch.source, 'prefetch-denied.mjs');
  const denied = await invoke(mod.default, { user: { profile: 'Staff', loginUser: 's@t' }, body: { record: {} } });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.match(String(denied.body.error), /cannot view Orders/);
});

function grantModule(component: string, enabled: string): App['profiles'][number]['modules'][number] {
  return { component, properties: [{ key: 'enabled', value: enabled, span: Z }], reports: [], fields: [], span: Z };
}

test('a form prefetch enforces the form grant before any read: an ungranted profile gets 403 and no transcript', async () => {
  // Restaurants shape: Cashier may read Menu but has no grant on
  // Add_Restaurant_Details; Kitchen Staff may read Menu but has no grant on
  // New_Order. Before, both prefetches answered 200 with slots and a transcript.
  const g = generate(
    app({
      forms: [
        plainForm('Add_Restaurant_Details', [plainField('Name')]),
        plainForm('New_Order', [plainField('Item')]),
        plainForm('Menu', [plainField('Title')]),
      ],
      profiles: [
        { name: 'Cashier', type: 'Users_Permissions', properties: [], modules: [grantModule('Menu', 'viewall'), grantModule('New_Order', 'create, viewall')], span: Z },
        { name: 'Kitchen Staff', type: 'Users_Permissions', properties: [], modules: [grantModule('Menu', 'viewall')], span: Z },
        { name: 'Manager', type: 'Users_Permissions', properties: [], modules: [grantModule('Menu', 'viewall'), grantModule('Add_Restaurant_Details', 'create, viewall')], span: Z },
      ],
      workflows: [
        workflow({
          name: 'Check name',
          form: 'Add_Restaurant_Details',
          event: 'on validate',
          deluge: { text: 'if (Menu[Title == Name].count() > 0) { alert "taken"; }', span: Z },
        }),
        workflow({
          name: 'Pick item',
          form: 'New_Order',
          event: 'on user input of Item',
          deluge: { text: 'if (Menu[Title == Item].count() > 0) { alert "on menu"; }', span: Z },
        }),
      ],
    }),
  );
  const validate = g.files.find((f) => f.path === 'functions/aio/add-restaurant-details/on-validate-prefetch.mjs');
  const input = g.files.find((f) => f.path.startsWith('functions/aio/new-order/') && f.path.endsWith('-prefetch.mjs'));
  assert.ok(validate && input, g.files.map((f) => f.path).join('\n'));
  for (const pre of [validate, input]) {
    const src = stripComments(pre.source);
    assert.match(src, /if \(isHidden\(formName\)\)/);
    // The grant check runs before the runtime exists, so nothing is executed.
    const grantAt = src.indexOf('authorizeWrite(access, principal, formName, {})');
    assert.ok(grantAt >= 0 && grantAt < src.indexOf('createRuntime({'));
    check(pre.source, 'form-grant-prefetch.mjs');
  }
  const validateMod = await loadModule(validate.source, 'validate-prefetch.mjs');
  const inputMod = await loadModule(input.source, 'input-prefetch.mjs');
  const cashier = await invoke(validateMod.default, { user: { profile: 'Cashier', loginUser: 'c@t' }, body: { record: { Name: 'x' } } });
  assert.equal(cashier.status, 403, JSON.stringify(cashier.body));
  assert.match(String(cashier.body.error), /cannot view Add_Restaurant_Details/);
  assert.equal('transcript' in cashier.body, false);
  assert.equal(cashier.body.slots, null);
  const kitchen = await invoke(inputMod.default, { user: { profile: 'Kitchen Staff', loginUser: 'k@t' }, body: { record: { Item: 'x' } } });
  assert.equal(kitchen.status, 403, JSON.stringify(kitchen.body));
  assert.equal('transcript' in kitchen.body, false);
  assert.equal(kitchen.body.slots, null);
  // Granted profiles still get their slots.
  const manager = await invoke(validateMod.default, { user: { profile: 'Manager', loginUser: 'm@t' }, body: { record: { Name: 'x' } } });
  assert.equal(manager.status, 200, JSON.stringify(manager.body));
  assert.ok(manager.body.slots && typeof manager.body.slots === 'object');
  const cashierOrder = await invoke(inputMod.default, { user: { profile: 'Cashier', loginUser: 'c@t' }, body: { record: { Item: 'x' } } });
  assert.equal(cashierOrder.status, 200, JSON.stringify(cashierOrder.body));
  const anon = await invoke(validateMod.default, { body: { record: {} } });
  assert.equal(anon.status, 401);
});

test('bare field names in a workflow body read input on both sides', () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Status'), plainField('Total')])],
      workflows: [
        workflow({
          name: 'On validate',
          form: 'Orders',
          event: 'on validate',
          deluge: { text: 'if (Status == "Open") { y = Total; }', span: Z },
        }),
      ],
    }),
  );
  const server = g.files.find((f) => f.path === 'functions/aio/orders/on-validate.mjs');
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-validate.mjs');
  assert.ok(server);
  assert.ok(client);
  for (const m of [server, client]) {
    assert.match(stripComments(m.source), /if \(\(shim\.input\.get\(ctx, "Status"\) == "Open"\)\)/);
    assert.match(stripComments(m.source), /var y = shim\.input\.get\(ctx, "Total"\)/);
    check(m.source, 'body-input.mjs');
  }
  // A local of the same name still shadows the field.
  const shadowed = generate(
    app({
      forms: [plainForm('Orders', [plainField('Status')])],
      workflows: [
        workflow({
          name: 'On validate',
          form: 'Orders',
          event: 'on validate',
          deluge: { text: 'Status = "x";\nif (Status == "x") { y = 1; }', span: Z },
        }),
      ],
    }),
  );
  const shadowServer = shadowed.files.find((f) => f.path === 'functions/aio/orders/on-validate.mjs');
  assert.ok(shadowServer);
  assert.match(stripComments(shadowServer.source), /var Status = "x";/);
  assert.match(stripComments(shadowServer.source), /if \(\(Status == "x"\)\)/);
  assert.doesNotMatch(stripComments(shadowServer.source), /shim\.input\.get\(ctx, "Status"\)/);
});

test('bare field names in a schedule body read the job record', () => {
  const g = generate(
    app({
      forms: [plainForm('Bookings', [plainField('Official_Email')])],
      workflows: [
        workflow({
          name: 'Remind',
          type: 'schedule',
          form: 'Bookings',
          event: 'schedule',
          deluge: { text: 'sendmail ( to : Official_Email );', span: Z },
        }),
      ],
    }),
  );
  const job = g.files.find((f) => f.path === 'functions/job/remind.mjs');
  assert.ok(job);
  assert.match(stripComments(job.source), /shim\.input\.get\(ctx, "Official_Email"\)/);
  check(job.source, 'job-input.mjs');
});

test(':ui and openUrl args that need the server go through prefetch slots', () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Status'), plainField('Items', 'grid', ['Item'])])],
      workflows: [
        workflow({
          name: 'add row',
          form: 'Orders',
          event: 'on add row of Items',
          deluge: { text: 'all = Orders[Status == "Open"].ID.getAll();\nrow.Items:ui.add(all);\nopenUrl ("http://x/" + all.size());', span: Z },
        }),
      ],
    }),
  );
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-add-row-of-items.mjs');
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-add-row-of-items-prefetch.mjs');
  assert.ok(client);
  assert.ok(prefetch);
  assert.match(stripComments(client.source), /args: \[slots\["c0"\]\]/);
  assert.match(stripComments(client.source), /op: "openUrl", args: \[slots\["c1"\]\]/);
  assert.match(stripComments(prefetch.source), /var all = await shim\.datastore\.column/);
  assert.doesNotMatch(stripComments(client.source), /\ball\b[^"]/);
  check(client.source, 'client-ui-args.mjs');
  check(prefetch.source, 'prefetch-ui-args.mjs');
});

test('a client condition reading a loop-scoped binding is a row map, not a free prefetch name', () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Status'), plainField('Code')])],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: {
            text: 'for each r in Orders[Status == "Open"] {\n  q = Items[Code == r.Code];\n  if (q.count() > 0) { info "hit"; }\n}',
            span: Z,
          },
        }),
      ],
    }),
  );
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs');
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  assert.ok(client);
  assert.ok(prefetch);
  const pre = stripComments(prefetch.source);
  const loopAt = pre.indexOf('for (var r of');
  assert.ok(loopAt > 0);
  // `q` is bound inside the loop. It is not a free name beside the collection slot.
  assert.equal(pre.slice(0, loopAt).includes('var q'), false);
  // The keyed fetch rebinds to the row's fetched rows; `q.count()` aggregates them in memory.
  assert.match(pre, /var q = \(norm_c\d+_\d+ != null && res_c\d+_\d+\.has/);
  assert.match(pre, /shim\.list\.aggregate\(q, "count", undefined\)/);
  assert.match(pre, /shim\.record\.get\(r, "Code"\)/);
  assert.match(stripComments(client.source), /slots\["c\d+"\]\[shim\.record\.get\(r, "ID"\)\]/);
  assert.match(stripComments(client.source), /"info"/);
  assert.doesNotMatch(stripComments(client.source), /client-condition-uses-server/);
  assert.equal(g.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  check(client.source, 'client-loop-map.mjs');
  check(prefetch.source, 'prefetch-loop-map.mjs');
});

test('a prefetched row map returns the second form field for each fetched row, and null when nothing matches', async () => {
  const script = [
    'for each rec in Orders[Status == "Open"] {',
    '  alert Customers[Code == rec.Code].Name;',
    '  hide input.Secret;',
    '  openUrl("https://example.test/" + rec.Code, "same window");',
    '}',
  ].join('\n');
  const g = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code')]),
        plainForm('Customers', [plainField('Code'), plainField('Name')]),
      ],
      workflows: [workflow({ name: 'on load', form: 'Orders', event: 'on load', deluge: { text: script, span: Z } })],
    }),
  );
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs');
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  assert.ok(client && prefetch);
  assert.equal(g.todos.some((t) => t.construct === 'client-loop-uses-server' || t.construct === 'client-condition-uses-server'), false);
  check(client.source, 'row-map-client.mjs');
  check(prefetch.source, 'row-map-prefetch.mjs');
  const pre = (await loadModule(prefetch.source, 'row-map-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const cmod = (await loadModule(client.source, 'row-map-client.mjs')) as unknown as {
    clientActions: (ctx: unknown) => Promise<{ op: string; message?: unknown; args?: unknown[] }[]>;
  };
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A' },
        { ROWID: '2', Status: 'Open', Code: 'B' },
        { ROWID: '3', Status: 'Open', Code: 'C' },
        { ROWID: '4', Status: 'Closed', Code: 'Z' },
      ],
      Customers: [
        { ROWID: '10', Code: 'A', Name: 'Ada' },
        { ROWID: '20', Code: 'B', Name: 'Bea' },
        { ROWID: '40', Code: 'Z', Name: 'Zoe' },
      ],
    },
    clientPrefetch: async (_path, nonce) => ({ nonce, slots: await pre.prefetch(seeded.context({ record: {} })) }),
  });
  const actions = await cmod.clientActions(seeded.context({ record: {} }));
  assert.deepEqual(
    actions.map((a) => a.op),
    ['alert', 'hide', 'openUrl', 'alert', 'hide', 'openUrl', 'alert', 'hide', 'openUrl'],
  );
  assert.deepEqual(
    actions.filter((a) => a.op === 'alert').map((a) => a.message),
    ['Ada', 'Bea', null],
  );
  assert.deepEqual(
    actions.filter((a) => a.op === 'openUrl').map((a) => a.args?.[0]),
    ['https://example.test/A', 'https://example.test/B', 'https://example.test/C'],
  );

  const branched = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code')]),
        plainForm('Customers', [plainField('Code'), plainField('Name')]),
      ],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: {
            text: 'for each rec in Orders[Status == "Open"] {\n  if (Customers[Code == rec.Code].Name == "Ada") { alert rec.Code; }\n}',
            span: Z,
          },
        }),
      ],
    }),
  );
  const ifClient = branched.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs')!;
  const ifPre = branched.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs')!;
  assert.equal(branched.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  const ifPrefetch = (await loadModule(ifPre.source, 'if-map-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const ifMod = (await loadModule(ifClient.source, 'if-map-client.mjs')) as unknown as {
    clientActions: (ctx: unknown) => Promise<{ op: string; message?: unknown }[]>;
  };
  const ifRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A' },
        { ROWID: '2', Status: 'Open', Code: 'B' },
        { ROWID: '3', Status: 'Open', Code: 'C' },
      ],
      Customers: [
        { ROWID: '10', Code: 'A', Name: 'Ada' },
        { ROWID: '20', Code: 'B', Name: 'Bea' },
      ],
    },
    clientPrefetch: async (_path, nonce) => ({ nonce, slots: await ifPrefetch.prefetch(ifRuntime.context({ record: {} })) }),
  });
  const ifActions = await ifMod.clientActions(ifRuntime.context({ record: {} }));
  assert.deepEqual(ifActions.map((a) => a.message), ['A']);
});

test('batched lookupMap prefetches 2000 rows with 3 distinct keys in constant datastore queries and satisfies access probes', async () => {
  const script = [
    'for each rec in Orders[Status == "Open"] {',
    '  alert Customers[Code == rec.Code].Name;',
    '  hide input.Secret;',
    '  openUrl("https://example.test/" + rec.Code, "same window");',
    '}',
  ].join('\n');
  const g = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code')]),
        plainForm('Customers', [plainField('Code'), plainField('Name')]),
      ],
      workflows: [workflow({ name: 'on load', form: 'Orders', event: 'on load', deluge: { text: script, span: Z } })],
    }),
  );
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs');
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  assert.ok(client && prefetch);
  check(client.source, 'batched-row-map-client.mjs');
  check(prefetch.source, 'batched-row-map-prefetch.mjs');
  const pre = (await loadModule(prefetch.source, 'batched-row-map-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const cmod = (await loadModule(client.source, 'batched-row-map-client.mjs')) as unknown as {
    clientActions: (ctx: unknown) => Promise<{ op: string; message?: unknown; args?: unknown[] }[]>;
  };

  // Generate 2000 Orders with 3 distinct codes: A, B, C
  const ordersSeed: Record<string, unknown>[] = [];
  const codes = ['A', 'B', 'C'];
  for (let i = 1; i <= 2000; i++) {
    ordersSeed.push({ ROWID: String(i), Status: 'Open', Code: codes[(i - 1) % 3] });
  }
  const customersSeed = [
    { ROWID: '100', Code: 'A', Name: 'Ada' },
    { ROWID: '200', Code: 'B', Name: 'Bea' },
    // Code 'C' does not exist in Customers
  ];

  // 1. Datastore call-count test: 2000 rows -> exactly 2 fetch queries (1 Orders, 1 Customers)
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Orders: ordersSeed,
      Customers: customersSeed,
    },
  });
  const ctx = runtime.context({ record: {} });
  const slots = await pre.prefetch(ctx);

  const fetchCalls = runtime.transcript.filter((e) => e.op === 'fetch');
  const fieldCalls = runtime.transcript.filter((e) => e.op === 'field');
  assert.equal(fetchCalls.length, 2, 'exactly 2 fetch calls: 1 for Orders, 1 for batched Customers');
  assert.equal(fieldCalls.length, 0, 'zero per-row field calls');

  // 2. Map results identical to per-row path on same data & keys = exactly fetched row ids
  const rowMap = slots['c0'] as Record<string, unknown>;
  assert.ok(rowMap, 'row map slot exists');
  const keys = Object.keys(rowMap);
  assert.equal(keys.length, 2000, 'map keys = exactly fetched row ids count');
  for (let i = 1; i <= 2000; i++) {
    const id = String(i);
    assert.ok(Object.hasOwn(rowMap, id), `map has key ${id}`);
    const code = codes[(i - 1) % 3];
    const expected = code === 'A' ? 'Ada' : code === 'B' ? 'Bea' : null;
    assert.equal(rowMap[id], expected, `row ${id} (Code ${code}) mapped value`);
  }

  // 3. Order of client operations unchanged
  const clientRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    clientPrefetch: async (_path, nonce) => ({ nonce, slots }),
  });
  const actions = await cmod.clientActions(clientRuntime.context({ record: {} }));
  assert.equal(actions.length, 2000 * 3, '2000 rows * 3 actions per row');
  for (let i = 0; i < 2000; i++) {
    assert.equal(actions[i * 3]?.op, 'alert');
    assert.equal(actions[i * 3 + 1]?.op, 'hide');
    assert.equal(actions[i * 3 + 2]?.op, 'openUrl');
  }

  // 4. Review access probe: RecordAccessError on no grant
  const noGrantAccess = {
    profiles: {
      Staff: {
        Orders: { fields: ['Status', 'Code'] },
        // Customers not granted
      },
    },
    roles: ['Librarian'],
  };
  const noGrantRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    access: noGrantAccess,
    seed: { Orders: ordersSeed, Customers: customersSeed },
  });
  const noGrantCtx = noGrantRuntime.context({
    principal: { profile: 'Staff', role: 'Librarian', loginUser: 'user@example.test' },
    record: {},
  });
  await assert.rejects(() => pre.prefetch(noGrantCtx), (err: unknown) => {
    return (err instanceof RecordAccessError) || (err as { name?: string }).name === 'RecordAccessError';
  }, 'RecordAccessError thrown on no grant');

  // 5. Review access probe: RECORD_ACCESS_DENIED on hidden field
  const hiddenFieldAccess = {
    profiles: {
      Staff: {
        Orders: { fields: ['Status', 'Code'] },
        Customers: { fields: ['Code'] }, // Name is hidden
      },
    },
    roles: ['Librarian'],
  };
  const hiddenFieldRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    access: hiddenFieldAccess,
    seed: { Orders: ordersSeed, Customers: customersSeed },
  });
  const hiddenFieldCtx = hiddenFieldRuntime.context({
    principal: { profile: 'Staff', role: 'Librarian', loginUser: 'user@example.test' },
    record: {},
  });
  await assert.rejects(() => pre.prefetch(hiddenFieldCtx), (err: unknown) => {
    const accessErr = err as { code?: string; name?: string };
    return accessErr.code === 'RECORD_ACCESS_DENIED' || accessErr.name === 'RecordAccessError';
  }, 'RECORD_ACCESS_DENIED thrown on hidden field');

  // 6. Review access probe: Record filter hiding rows maps to null
  const filteredAccess = {
    profiles: {
      Staff: {
        Orders: { fields: ['Status', 'Code'] },
        Customers: {
          fields: ['Code', 'Name'],
          recordFilter: { op: '==' as const, field: 'Code', value: 'A' }, // Only 'A' visible, 'B' hidden
        },
      },
    },
    roles: ['Librarian'],
  };
  const filteredRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    access: filteredAccess,
    seed: { Orders: ordersSeed, Customers: customersSeed },
  });
  const filteredCtx = filteredRuntime.context({
    principal: { profile: 'Staff', role: 'Librarian', loginUser: 'user@example.test' },
    record: {},
  });
  const filteredSlots = await pre.prefetch(filteredCtx);
  const filteredMap = filteredSlots['c0'] as Record<string, unknown>;
  // For Code A: Ada. For Code B: null (hidden by record filter). For Code C: null.
  for (let i = 1; i <= 2000; i++) {
    const id = String(i);
    const code = codes[(i - 1) % 3];
    const expected = code === 'A' ? 'Ada' : null;
    assert.equal(filteredMap[id], expected, `filtered row ${id} mapped value`);
  }
});

test('a client-evaluated range bound is a deferred slot read the endpoint validates and clamps', async () => {
  // Shape A: an earlier client loop accumulates `proplength`, so the next
  // loop's end bound is that count. The client sends it as a request
  // parameter; the endpoint validates, clamps, and runs only the generated
  // query — form, criteria, sort, and access policy never move. A write of
  // the same name inside this loop is not the bound: the range is evaluated
  // once, before the body.
  const script = [
    'proplength = 0;',
    'marks = {"a"};',
    'for each mark in marks {',
    '  proplength = proplength + 1;',
    '}',
    'for each rec in Orders[ID != 0] sort by Added_Time desc range from 1 to 11 - proplength {',
    '  info rec.Name;',
    '  proplength = proplength + 1;',
    '}',
  ].join('\n');
  const g = generate(
    app({
      // The form prefetch requires the form handler's write grant: Staff may add Orders.
      profiles: [{ ...ordersStaff, modules: [{ ...ordersStaff.modules[0]!, properties: [{ key: 'enabled', value: 'create, viewall', span: Z }] }] } as App['profiles'][number]],
      forms: [plainForm('Orders', [plainField('Name'), plainField('Added_Time'), plainField('Status')])],
      workflows: [workflow({ name: 'on load', form: 'Orders', event: 'on load', deluge: { text: script, span: Z } })],
    }),
  );
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs');
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  assert.ok(client && prefetch);
  assert.equal(g.todos.some((t) => t.construct === 'client-loop-uses-server'), false);
  check(client.source, 'range-slot-client.mjs');
  check(prefetch.source, 'range-slot-prefetch.mjs');
  const clientCode = stripComments(client.source);
  assert.match(clientCode, /await shim\.client\.rows\(ctx, "c0", 1, \(11 - proplength\)\)/);
  assert.match(clientCode, /for \(var d_rec of shim\.each\(ctx, range_c0\.rows\)\)/);
  const pre = stripComments(prefetch.source);
  assert.match(pre, /rangeSlotRequest\(req\?\.body\)/);
  assert.match(pre, /ctx\.rangeSlot === "c0"/);
  assert.match(pre, /ctx\.rangeEmpty \? \[\] :/);
  assert.match(pre, /range: \{ from: ctx\.rangeFrom, to: ctx\.rangeTo \}/);

  const mod = (await loadModule(prefetch.source, 'range-slot-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
    default: (req: unknown, res: unknown) => unknown;
  };
  const caller = { user: { profile: 'Staff', email: 'a@example.com' } };

  // Malformed bounds refuse with the same error envelope the endpoint uses.
  for (const range of [{ from: '1', to: 11 }, { from: 1.5, to: 11 }, { to: 11 }, undefined]) {
    const bad = await invoke(mod.default, { ...caller, body: { record: {}, nonce: 'n1', slot: 'c0', range } });
    assert.equal(bad.status, 400, `range ${JSON.stringify(range)} must be refused`);
    assert.ok(bad.body.error, 'refusal carries a message');
  }
  // An unauthenticated caller is refused before any read runs.
  const anon = await invoke(mod.default, { body: { record: {}, nonce: 'n1', slot: 'c0', range: { from: 1, to: 5 } } });
  assert.equal(anon.status, 401);
  // A profile with no grant on the form gets the same access refusal as any
  // other client round trip.
  const guest = await invoke(mod.default, {
    user: { profile: 'Guest', email: 'g@example.com' },
    body: { record: {}, nonce: 'n1', slot: 'c0', range: { from: 1, to: 5 } },
  });
  assert.equal(guest.status, 403);
  // A slot the endpoint did not generate is refused: the request picks the
  // read, never the query.
  const unknown = await invoke(mod.default, { ...caller, body: { record: {}, nonce: 'n1', slot: 'c9', range: { from: 1, to: 5 } } });
  assert.equal(unknown.status, 400);
  // A valid request answers with only the slot it named — the eager reads are
  // not recomputed for a deferred range request.
  const ok = await invoke(mod.default, { ...caller, body: { record: {}, nonce: 'n1', slot: 'c0', range: { from: 1, to: 11 } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body.slots as Record<string, unknown>), ['c0']);
  // A forged wide range is clamped by the endpoint, not refused outright.
  const wide = await invoke(mod.default, { ...caller, body: { record: {}, nonce: 'n1', slot: 'c0', range: { from: 1, to: 100000 } } });
  assert.equal(wide.status, 200);

  // The clamp is real: a seeded store yields at most the ZCQL page cap, and an
  // access record filter still narrows the deferred read.
  const ordersSeed: Record<string, unknown>[] = [];
  for (let i = 1; i <= 400; i++) ordersSeed.push({ ROWID: String(i), Name: `n${i}`, Status: i <= 200 ? 'Open' : 'Closed' });
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Orders: ordersSeed },
    access: {
      profiles: { Staff: { Orders: { fields: ['Name', 'Status'], recordFilter: { op: '==', field: 'Status', value: 'Open' } } } },
      roles: [],
    },
  });
  const clamped = await mod.prefetch(
    seeded.context({
      record: {},
      principal: { profile: 'Staff', loginUser: 'a@example.com' },
      rangeSlot: 'c0',
      rangeFrom: 1,
      rangeTo: 1 + LIMITS.zcqlRowsPerQuery,
    }),
  );
  const rows = clamped['c0'] as unknown[];
  assert.equal(rows.length, 200, 'the deferred read serves the caller\'s filtered, capped window');
  // An empty range (the client's `to` preceded `from`) reads nothing.
  const empty = await mod.prefetch(
    seeded.context({
      record: {},
      principal: { profile: 'Staff', loginUser: 'a@example.com' },
      rangeSlot: 'c0',
      rangeFrom: 1,
      rangeTo: 0,
      rangeEmpty: true,
    }),
  );
  assert.deepEqual(empty['c0'], []);
});


test('a compound criteria batches and evaluates: static conjunct filters rows, quote-bearing keys stay safe', async () => {
  const g = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code')]),
        plainForm('Customers', [plainField('Code'), plainField('Name'), plainField('Active', 'checkbox')]),
      ],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: {
            text: 'for each rec in Orders[Status == "Open"] {\n  alert Customers[Code == rec.Code && Active == true].Name;\n}',
            span: Z,
          },
        }),
      ],
    }),
  );
  assert.equal(g.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  assert.equal(g.todos.some((t) => t.construct === 'client-loop-uses-server'), false);
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs')!;
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs')!;
  check(client.source, 'compound-map-client.mjs');
  check(prefetch.source, 'compound-map-prefetch.mjs');
  const pre = (await loadModule(prefetch.source, 'compound-map-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const cmod = (await loadModule(client.source, 'compound-map-client.mjs')) as unknown as {
    clientActions: (ctx: unknown) => Promise<{ op: string; message?: unknown }[]>;
  };
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A' },
        { ROWID: '2', Status: 'Open', Code: 'B' },
        { ROWID: '3', Status: 'Open', Code: "O'Brien" },
        { ROWID: '4', Status: 'Open', Code: 'C' },
      ],
      Customers: [
        { ROWID: '10', Code: 'A', Name: 'Ada', Active: true },
        { ROWID: '20', Code: 'B', Name: 'Bea', Active: false },
        { ROWID: '30', Code: "O'Brien", Name: 'Obi', Active: true },
      ],
    },
  });
  const slots = await pre.prefetch(runtime.context({ record: {} }));
  const fetchCalls = runtime.transcript.filter((e) => e.op === 'fetch');
  assert.equal(fetchCalls.length, 2, 'Orders fetch plus one batched Customers read');
  assert.equal(runtime.transcript.filter((e) => e.op === 'field').length, 0);
  const customersFetch = fetchCalls.find((e) => e.form === 'Customers')!;
  // The key set is quote-safe: O'Brien arrives as a doubled-quote literal.
  assert.match(String(customersFetch.where), /O''Brien/);
  assert.match(String(customersFetch.where), /Active = true/);
  const map = slots['c0'] as Record<string, unknown>;
  assert.deepEqual(
    [map['1'], map['2'], map['3'], map['4']],
    ['Ada', null, 'Obi', null],
    'active rows map; inactive and missing keys map to null',
  );
  const clientRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    clientPrefetch: async (_path, nonce) => ({ nonce, slots }),
  });
  const actions = await cmod.clientActions(clientRuntime.context({ record: {} }));
  assert.deepEqual(actions.map((a) => a.message), ['Ada', null, 'Obi', null]);
});

test('two server field reads in one client condition batch into two map lookups on shared keys', async () => {
  const g = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code')]),
        plainForm('Customers', [plainField('Code'), plainField('Credit'), plainField('Limit')]),
      ],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: {
            text: 'for each rec in Orders[Status == "Open"] {\n  if (Customers[Code == rec.Code].Credit > Customers[Code == rec.Code].Limit) {\n    alert rec.Code;\n  }\n}',
            span: Z,
          },
        }),
      ],
    }),
  );
  assert.equal(g.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs')!;
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs')!;
  const preSrc = stripComments(prefetch.source);
  const lookups = preSrc.match(/shim\.datastore\.lookupMap/g) ?? [];
  assert.equal(lookups.length, 2, 'Credit and Limit each batch into a lookupMap');
  const pre = (await loadModule(prefetch.source, 'two-field-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const cmod = (await loadModule(client.source, 'two-field-client.mjs')) as unknown as {
    clientActions: (ctx: unknown) => Promise<{ op: string; message?: unknown }[]>;
  };
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A' },
        { ROWID: '2', Status: 'Open', Code: 'B' },
        { ROWID: '3', Status: 'Open', Code: 'C' },
      ],
      Customers: [
        { ROWID: '10', Code: 'A', Credit: 90, Limit: 100 },
        { ROWID: '20', Code: 'B', Credit: 250, Limit: 100 },
      ],
    },
  });
  const slots = await pre.prefetch(runtime.context({ record: {} }));
  assert.equal(runtime.transcript.filter((e) => e.op === 'fetch').length, 3, 'Orders plus two batched Customers reads');
  assert.equal(runtime.transcript.filter((e) => e.op === 'field').length, 0);
  const clientRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    clientPrefetch: async (_path, nonce) => ({ nonce, slots }),
  });
  const actions = await cmod.clientActions(clientRuntime.context({ record: {} }));
  assert.deepEqual(actions.map((a) => a.message), ['B'], 'only the over-limit row alerts');
});

test('a row-keyed aggregate in a client condition batches into aggregateMap and counts missing keys as zero', async () => {
  const g = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code')]),
        plainForm('Lines', [plainField('OrderCode'), plainField('Qty', 'decimal')]),
      ],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: {
            text: 'for each rec in Orders[Status == "Open"] {\n  if (Lines[OrderCode == rec.Code].count() > 1) {\n    alert rec.Code;\n  }\n}',
            span: Z,
          },
        }),
      ],
    }),
  );
  assert.equal(g.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs')!;
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs')!;
  assert.match(stripComments(prefetch.source), /await shim\.datastore\.aggregateMap\(ctx, "Lines", "OrderCode", keys_c\d+_\d+, "count", undefined\)/);
  const pre = (await loadModule(prefetch.source, 'agg-map-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const cmod = (await loadModule(client.source, 'agg-map-client.mjs')) as unknown as {
    clientActions: (ctx: unknown) => Promise<{ op: string; message?: unknown }[]>;
  };
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A' },
        { ROWID: '2', Status: 'Open', Code: 'B' },
        { ROWID: '3', Status: 'Open', Code: 'C' },
      ],
      Lines: [
        { ROWID: '10', OrderCode: 'A', Qty: 1 },
        { ROWID: '11', OrderCode: 'A', Qty: 2 },
        { ROWID: '12', OrderCode: 'B', Qty: 5 },
      ],
    },
  });
  const slots = await pre.prefetch(runtime.context({ record: {} }));
  assert.equal(runtime.transcript.filter((e) => e.op === 'fetch').length, 1, 'only the Orders fetch');
  const aggregates = runtime.transcript.filter((e) => e.op === 'aggregate');
  assert.equal(aggregates.length, 1, 'one batched Lines aggregate, not one per row');
  assert.equal(aggregates[0]!.form, 'Lines');
  assert.equal(runtime.transcript.filter((e) => e.op === 'field').length, 0);
  const clientRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    clientPrefetch: async (_path, nonce) => ({ nonce, slots }),
  });
  const actions = await cmod.clientActions(clientRuntime.context({ record: {} }));
  assert.deepEqual(actions.map((a) => a.message), ['A'], 'only the two-line order alerts; the missing key counts 0');

  // Access probes: aggregate batched reads stay behind the same read policy.
  const staff = {
    profiles: {
      Staff: {
        Orders: { fields: ['Status', 'Code'] },
        Lines: { fields: ['OrderCode', 'Qty'], recordFilter: { op: '==' as const, field: 'Qty', value: 1 } },
      },
    },
    roles: ['Staff'],
  };
  const scopedRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    access: staff,
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A' },
        { ROWID: '2', Status: 'Open', Code: 'B' },
      ],
      Lines: [
        { ROWID: '10', OrderCode: 'A', Qty: 1 },
        { ROWID: '11', OrderCode: 'A', Qty: 2 },
        { ROWID: '12', OrderCode: 'B', Qty: 5 },
      ],
    },
  });
  const scopedSlots = await pre.prefetch(
    scopedRuntime.context({ principal: { profile: 'Staff', role: 'Staff', loginUser: 'user@example.test' }, record: {} }),
  );
  const scopedMap = scopedSlots['c0'] as Record<string, unknown>;
  assert.equal((slots['c0'] as Record<string, unknown>)['1'], true, 'unfiltered: two lines satisfy > 1');
  assert.equal(scopedMap['1'], false, 'the filter hides the Qty=2 line: count 1 fails > 1');
  assert.equal(scopedMap['2'], false, 'the filter hides every B line');

  const noGrant = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    access: { profiles: { Staff: { Orders: { fields: ['Status', 'Code'] } } }, roles: ['Staff'] },
    seed: { Orders: [{ ROWID: '1', Status: 'Open', Code: 'A' }], Lines: [] },
  });
  await assert.rejects(
    () => pre.prefetch(noGrant.context({ principal: { profile: 'Staff', role: 'Staff', loginUser: 'user@example.test' }, record: {} })),
    (err: unknown) => (err as { name?: string }).name === 'RecordAccessError',
    'no Lines grant refuses the prefetch',
  );
});

test('a nested row collection batches into rowsMap, keeps row order, and honours access filters', async () => {
  const g = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code')]),
        plainForm('Lines', [plainField('OrderCode'), plainField('Item')]),
      ],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: {
            text: 'for each rec in Orders[Status == "Open"] {\n  for each line in Lines[OrderCode == rec.Code] {\n    alert line.Item;\n  }\n}',
            span: Z,
          },
        }),
      ],
    }),
  );
  assert.equal(g.todos.some((t) => t.construct === 'client-loop-uses-server'), false);
  assert.equal(g.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs')!;
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs')!;
  assert.match(stripComments(prefetch.source), /await shim\.datastore\.rowsMap\(ctx, "Lines", "OrderCode", keys_c\d+_\d+\)/);
  const pre = (await loadModule(prefetch.source, 'rows-map-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const cmod = (await loadModule(client.source, 'rows-map-client.mjs')) as unknown as {
    clientActions: (ctx: unknown) => Promise<{ op: string; message?: unknown }[]>;
  };
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A' },
        { ROWID: '2', Status: 'Open', Code: 'B' },
        { ROWID: '3', Status: 'Open', Code: 'C' },
      ],
      Lines: [
        { ROWID: '10', OrderCode: 'A', Item: 'a1' },
        { ROWID: '11', OrderCode: 'A', Item: 'a2' },
        { ROWID: '12', OrderCode: 'B', Item: 'b1' },
      ],
    },
  });
  const slots = await pre.prefetch(runtime.context({ record: {} }));
  const fetchCalls = runtime.transcript.filter((e) => e.op === 'fetch');
  assert.equal(fetchCalls.length, 2, 'Orders plus one batched Lines read');
  const map = slots['c0'] as Record<string, unknown>;
  assert.equal((map['3'] as unknown[]).length, 0, 'no lines for C: empty collection');
  const clientRuntime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    clientPrefetch: async (_path, nonce) => ({ nonce, slots }),
  });
  const actions = await cmod.clientActions(clientRuntime.context({ record: {} }));
  assert.deepEqual(actions.map((a) => a.message), ['a1', 'a2', 'b1'], 'inner loop replays the mapped rows in order');

  // Access: no Lines grant refuses; a record filter drops rows from the mapped collection.
  const noGrant = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    access: { profiles: { Staff: { Orders: { fields: ['Status', 'Code'] } } }, roles: ['Staff'] },
    seed: { Orders: [{ ROWID: '1', Status: 'Open', Code: 'A' }], Lines: [] },
  });
  await assert.rejects(
    () => pre.prefetch(noGrant.context({ principal: { profile: 'Staff', role: 'Staff', loginUser: 'user@example.test' }, record: {} })),
    (err: unknown) => (err as { name?: string }).name === 'RecordAccessError',
    'no Lines grant refuses the prefetch',
  );
  const filtered = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    access: {
      profiles: {
        Staff: {
          Orders: { fields: ['Status', 'Code'] },
          Lines: { fields: ['OrderCode', 'Item'], recordFilter: { op: '!=' as const, field: 'Item', value: 'a2' } },
        },
      },
      roles: ['Staff'],
    },
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A' },
        { ROWID: '2', Status: 'Open', Code: 'B' },
      ],
      Lines: [
        { ROWID: '10', OrderCode: 'A', Item: 'a1' },
        { ROWID: '11', OrderCode: 'A', Item: 'a2' },
        { ROWID: '12', OrderCode: 'B', Item: 'b1' },
      ],
    },
  });
  const filteredSlots = await pre.prefetch(
    filtered.context({ principal: { profile: 'Staff', role: 'Staff', loginUser: 'user@example.test' }, record: {} }),
  );
  const filteredMap = filteredSlots['c0'] as Record<string, unknown>;
  const aItems = (filteredMap['1'] as { values?: Record<string, unknown> }[]).map((r) => r.values?.Item ?? (r as Record<string, unknown>).Item);
  assert.deepEqual(aItems, ['a1'], 'the filtered-out line never reaches the map');

  const hiddenItem = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    access: {
      profiles: {
        Staff: {
          Orders: { fields: ['Status', 'Code'] },
          Lines: { fields: ['OrderCode'] }, // Item is hidden
        },
      },
      roles: ['Staff'],
    },
    seed: {
      Orders: [{ ROWID: '1', Status: 'Open', Code: 'A' }],
      Lines: [{ ROWID: '10', OrderCode: 'A', Item: 'a1' }],
    },
  });
  const hiddenSlots = await pre.prefetch(
    hiddenItem.context({ principal: { profile: 'Staff', role: 'Staff', loginUser: 'user@example.test' }, record: {} }),
  );
  const hiddenRows = (hiddenSlots['c0'] as Record<string, unknown>)['1'] as { values: Record<string, unknown> }[];
  assert.equal(hiddenRows.length, 1, 'the row itself is still visible');
  assert.equal(hiddenRows[0]!.values.Item, undefined, 'the hidden field value is not projected into the map');
});

test('a local binding carrying a row-keyed read still batches, and a second keyed leaf post-filters', async () => {
  const g = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code'), plainField('Region')]),
        plainForm('Customers', [plainField('Code'), plainField('Name'), plainField('Region')]),
      ],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: {
            text: 'for each rec in Orders[Status == "Open"] {\n  k = Customers[Code == rec.Code].Name;\n  alert k;\n  if (Customers[Code == rec.Code && Region == rec.Region].Name == "Bea") { alert "hit"; }\n}',
            span: Z,
          },
        }),
      ],
    }),
  );
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs')!;
  const pre = stripComments(prefetch.source);
  assert.match(pre, /await shim\.datastore\.lookupMap\(ctx, "Customers", "Code", "Name", keys_c\d+_\d+\)/);
  // Two row-keyed leaves: one batched `IN` on Code, then `matches` applies `Region == rec.Region` per row.
  assert.match(pre, /await shim\.datastore\.rowsMap\(ctx, "Customers", "Code", keys_c\d+_\d+\)/);
  assert.match(pre, /shim\.datastore\.matches\(ctx, cand, \{ op: "==", field: "Region", value: shim\.record\.get\(d_rec, "Region"\) \}\)/);
  assert.doesNotMatch(pre, /await shim\.datastore\.field\(ctx, shim\.datastore\.query/);
  const mod = (await loadModule(prefetch.source, 'local-read-prefetch.mjs')) as unknown as {
    prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
  };
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Orders: [
        { ROWID: '1', Status: 'Open', Code: 'A', Region: 'EU' },
        { ROWID: '2', Status: 'Open', Code: 'B', Region: 'US' },
      ],
      Customers: [
        { ROWID: '10', Code: 'A', Name: 'Ada', Region: 'EU' },
        { ROWID: '20', Code: 'B', Name: 'Bea', Region: 'US' },
      ],
    },
  });
  const slots = await mod.prefetch(runtime.context({ record: {} }));
  const names = Object.values(slots)
    .map((slot) => slot as Record<string, unknown>)
    .find((slot) => slot && typeof slot === 'object' && slot['1'] === 'Ada');
  assert.ok(names, 'the batched local-binding slot maps row 1 to Ada');
  assert.equal(names['2'], 'Bea', 'the local binding replays the batched value per row');
  // The post-filter sees the second keyed leaf: row 1's candidate is Ada (EU),
  // row 2's is Bea (US) — `Name == "Bea"` is true only for row 2.
  const hits = Object.values(slots)
    .map((slot) => slot as Record<string, unknown>)
    .find((slot) => slot && typeof slot === 'object' && typeof slot['1'] === 'boolean');
  assert.ok(hits, 'the two-leaf condition slot exists');
  assert.deepEqual([hits['1'], hits['2']], [false, true]);
});

test('a compound criteria keeps the extra conjuncts inside one batched lookup', () => {
  const scriptMultiple = [
    'for each rec in Orders[Status == "Open"] {',
    '  alert Customers[Code == rec.Code && Active == true].Name;',
    '}',
  ].join('\n');
  const g1 = generate(
    app({
      forms: [
        plainForm('Orders', [plainField('Status'), plainField('Code')]),
        plainForm('Customers', [plainField('Code'), plainField('Name'), plainField('Active')]),
      ],
      workflows: [workflow({ name: 'on load', form: 'Orders', event: 'on load', deluge: { text: scriptMultiple, span: Z } })],
    }),
  );
  const preMultiple = g1.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs')!;
  assert.ok(preMultiple);
  const pre = stripComments(preMultiple.source);
  // The row-keyed equality is batched; the remaining conjunct goes into the same query.
  assert.match(pre, /await shim\.datastore\.lookupMap\(ctx, "Customers", "Code", "Name", keys_c\d+_\d+, \{ op: "==", field: "Active", value: true \}\)/);
  assert.doesNotMatch(pre, /= await shim\.datastore\.field/);
});

test('non-keyed row reads (inequality, disjunction, dotted key) keep the per-row datastore query path', () => {
  for (const crit of ['Code != rec.Code', 'Code == rec.Code || Active == true', 'Address.City == rec.City']) {
    const g = generate(
      app({
        forms: [
          plainForm('Orders', [plainField('Status'), plainField('Code'), plainField('City')]),
          plainForm('Customers', [plainField('Code'), plainField('Name'), plainField('Active'), plainField('Address')]),
        ],
        workflows: [
          workflow({
            name: 'on load',
            form: 'Orders',
            event: 'on load',
            deluge: { text: `for each rec in Orders[Status == "Open"] {\n  alert Customers[${crit}].Name;\n}`, span: Z },
          }),
        ],
      }),
    );
    const pre = stripComments(g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs')!.source);
    assert.match(pre, /slots\["c\d+"\]\[shim\.record\.get\(d_rec, "ID"\)\] = await shim\.datastore\.field/, crit);
    assert.doesNotMatch(pre, /shim\.datastore\.lookupMap/, crit);
  }
});

test('an unparseable assignment still binds its target on both sides', () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Status')])],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: { text: 'ids = 1 +;\nn = ids.size();', span: Z },
        }),
      ],
    }),
  );
  const server = g.files.find((f) => f.path === 'functions/aio/orders/on-load.mjs');
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs');
  assert.ok(server);
  assert.ok(client);
  for (const m of [server, client]) {
    assert.match(stripComments(m.source), /var ids = await shim\.todo\(ctx, "task:ids"/);
    assert.match(stripComments(m.source), /var n = shim\.list\.size\(ids\)/);
    check(m.source, 'unknown-assign.mjs');
  }
});

test('a Form.Subform() row constructor stays client-capable inside a prefetched loop', () => {
  const g = generate(
    app({
      forms: [
        plainForm('Quotes', [plainField('Items', 'grid', ['Item'])]),
        plainForm('Orders', [plainField('Quote_No'), plainField('Items', 'grid', ['Item'])]),
      ],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Orders',
          event: 'on load',
          deluge: {
            text: 'q = Quotes[ID == input.Quote_No];\nfor each r in q.Items {\n  nr = Orders.Items();\n  input.Items.insert(nr);\n}',
            span: Z,
          },
        }),
      ],
    }),
  );
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs');
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  const server = g.files.find((f) => f.path === 'functions/aio/orders/on-load.mjs');
  assert.ok(client);
  assert.ok(prefetch);
  assert.ok(server);
  // `nr` is a fresh row bound to the subform; insert renders a grid row on the client.
  assert.match(stripComments(client.source), /for \(var r of shim\.each\(ctx, slots\["c0"\]\)\)/);
  assert.match(stripComments(client.source), /var nr = shim\.record\.bind\(ctx, \{\}, "Orders\.Items"\)/);
  assert.match(stripComments(client.source), /actions\.push\(\{ op: "subform", method: "insert", target: \["Items"\], args: \[nr\] \}\)/);
  assert.doesNotMatch(stripComments(client.source), /\bvar q\b/);
  assert.match(stripComments(server.source), /var nr = shim\.record\.bind\(ctx, \{\}, "Orders\.Items"\)/);
  assert.match(stripComments(server.source), /shim\.input\.insert\(ctx, \["Items"\], nr\)/);
  assert.match(stripComments(prefetch.source), /var q = shim\.datastore\.query\(ctx, "Quotes"/);
  check(client.source, 'subform-ctor-client.mjs');
  check(server.source, 'subform-ctor-server.mjs');
  check(prefetch.source, 'subform-ctor-prefetch.mjs');
});

test('a bare form name in a for-each is the form collection, and yesterday is a day offset', () => {
  const g = generate(
    app({
      forms: [plainForm('Staff', [plainField('Email')])],
      workflows: [
        workflow({
          name: 'on load',
          form: 'Staff',
          event: 'on load',
          deluge: { text: 'for each s in Staff {\n  seen = s.Email;\n}\nd = yesterday;', span: Z },
        }),
      ],
    }),
  );
  const server = g.files.find((f) => f.path === 'functions/aio/staff/on-load.mjs');
  assert.ok(server);
  assert.match(stripComments(server.source), /shim\.datastore\.rows\(ctx, shim\.datastore\.query\(ctx, "Staff", \{ op: "true" \}\)\)/);
  assert.match(stripComments(server.source), /shim\.record\.get\(s, "Email"\)/);
  assert.match(stripComments(server.source), /var d = shim\.date\.addDay\(shim\.zoho\.currentDate\(ctx\), -1, ctx\)/);
  check(server.source, 'for-each-form.mjs');
});

test('prefetch embeds the profile field grant and the report record filter', () => {
  const g = generate(
    app({
      reports: [
        {
          name: 'Mine',
          type: 'list',
          modifiers: [],
          form: 'Orders',
          criteria: 'Owner == zoho.loginuser',
          flags: [],
          properties: [],
          columns: [],
          customActions: [],
          conditionalFormats: [],
          filters: [],
          groupBy: [],
          sortBy: [],
          blocks: [],
          views: [],
          span: Z,
        },
      ],
      profiles: [
        {
          name: 'Staff',
          type: 'Users_Permissions',
          properties: [],
          modules: [
            {
              component: 'Orders',
              properties: [{ key: 'allFieldsVisible', value: 'false', span: Z }],
              reports: [{ key: 'Mine', value: '{"View"}', span: Z }],
              fields: [
                { field: 'Status', flags: { visibility: 'true' }, span: Z },
                { field: 'Secret', flags: { visibility: 'false' }, span: Z },
              ],
              span: Z,
            },
          ],
          span: Z,
        },
      ],
      roles: [{ name: 'Librarian', properties: [], children: [], span: Z }],
      workflows: [
        workflow({
          name: 'On load',
          form: 'Orders',
          event: 'on load',
          deluge: { text: 'if (Orders[Status == "Open"].count() > 0) { alert "open"; }', span: Z },
        }),
      ],
    }),
  );
  const prefetch = g.files.find((f) => f.path === 'functions/aio/orders/on-load-prefetch.mjs');
  assert.ok(prefetch);
  const start = prefetch.source.indexOf('export const access = ');
  const json = prefetch.source.slice(start + 'export const access = '.length, prefetch.source.indexOf(';\n', start));
  const access = JSON.parse(json) as {
    roles: string[];
    profiles: { Staff: { Orders: { fields: string[]; recordFilter: { field: string; value: { __bind: string } } } } };
  };
  assert.deepEqual(access.roles, ['Librarian']);
  assert.deepEqual(access.profiles.Staff.Orders.fields, ['Status']);
  assert.equal(access.profiles.Staff.Orders.recordFilter.field, 'Owner');
  assert.equal(access.profiles.Staff.Orders.recordFilter.value.__bind, 'loginUser');
  assert.equal(JSON.stringify(access).includes('Secret'), false);
  check(prefetch.source, 'prefetch-auth.mjs');
});

test('schedules generate deterministic Catalyst jobs: pool and cron metadata', () => {
  const withCron = generate(
    app({
      name: 'Night_Run',
      workflows: [
        workflow({
          name: 'Nightly',
          container: 'schedule',
          event: 'on schedule',
          properties: [
            { key: 'start', value: '"2024-01-01 02:00:00"', span: Z },
            { key: 'frequency', value: 'daily', span: Z },
            { key: 'time zone', value: '"UTC"', span: Z },
          ],
          deluge: { text: 'x = 1;', span: Z },
        }),
      ],
    }),
  );
  const job = withCron.files.find((f) => f.path.startsWith('functions/job/'));
  assert.ok(job);
  assert.match(stripComments(job.source), /jobPool = "NightRun"/);
  assert.match(stripComments(job.source), /cron = \{"cron_name":"c2c_Nightly","cron_status":true,"cron_type":"CronExpression","cron_detail":\{"cron_expression":"0 2 \* \* \*"\}/);
  assert.match(stripComments(job.source), /dryRun: !live/);
  const pool = /jobPool = "([^"]*)"/.exec(job.source);
  assert.ok(pool && !pool[1]!.includes('_'));
  assert.match(stripComments(job.source), /0 2 \* \* \*/);
  assert.match(stripComments(job.source), /Job function/);
  assert.match(stripComments(job.source), /run as the application/);
  assert.match(stripComments(job.source), /not an HTTP route/);
  assert.doesNotMatch(stripComments(job.source), /export const endpoint/);
  assert.doesNotMatch(stripComments(job.source), /function handler/);
  assert.doesNotMatch(stripComments(job.source), /\breq\s*,\s*res\b/);
  assert.equal([...job.source.matchAll(/path:\s*"/g)].length, 0);
  check(job.source, 'job.mjs');

  const bare = generate(
    app({
      workflows: [workflow({ name: 'Later', container: 'schedule', event: 'on schedule' })],
    }),
  );
  const bareJob = bare.files.find((f) => f.path.startsWith('functions/job/'));
  assert.ok(bareJob);
  assert.match(stripComments(bareJob.source), /None is invented/);
  assert.match(stripComments(bareJob.source), /export const cron = null;/);
  assert.ok(bare.todos.some((t) => t.construct === 'schedule-start'));
  assert.doesNotMatch(stripComments(bareJob.source), /cron:\s*"/);
});

test('approvals and blueprints are state machines, not Circuits, and do not double-emit', () => {
  const approval = generate(
    app({
      workflows: [
        workflow({
          name: 'Leave approval',
          container: 'approval',
          form: 'Leave',
          event: 'on approve',
          approvers: [{ key: 'level', value: '1', span: Z }],
          deluge: { text: 'x = 1;', span: Z },
        }),
      ],
    }),
  );
  const flow = approval.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(flow);
  assert.match(stripComments(flow.source), /"circuits": false/);
  assert.match(stripComments(flow.source), /\/approve/);
  assert.match(stripComments(flow.source), /\/reject/);
  assert.match(stripComments(flow.source), /\/transition/);
  assert.match(stripComments(flow.source), /Status/);
  assert.equal(approval.files.filter((f) => f.path.includes('leave-approval') || f.path.includes('functions/flow')).length, 1);
  check(flow.source, 'approval.mjs');

  const blueprint = generate(
    app({
      forms: [plainForm('Orders', [plainField('Amount')])],
      workflows: [
        workflow({
          name: 'Order flow',
          container: 'schedule',
          form: 'Orders',
          event: 'blueprint',
          deluge: { text: 'y = 2;', span: Z },
          blueprint: {
            start: { name: 'Draft', properties: [], blocks: [], items: [], span: Z },
            stages: [
              { name: 'Draft', properties: [], blocks: [], items: [], span: Z },
              { name: 'Review', properties: [], blocks: [], items: [], span: Z },
              { name: 'Done', properties: [], blocks: [], items: [], span: Z },
            ],
            transitions: [
              {
                name: 'Send',
                fromStage: 'Draft',
                toStage: 'Review',
                properties: [],
                phases: [{ phase: 'before', properties: [{ key: 'transition criteria', value: '(Amount > 100)', span: Z }], blocks: [], deluge: [], span: Z }],
                span: Z,
              },
              {
                name: 'Ship',
                fromStage: 'Review',
                toStage: 'Done',
                properties: [],
                phases: [{ phase: 'before', properties: [], blocks: [], deluge: [{ text: 'z = 3;', span: { start: 10, end: 16 } }], span: Z }],
                span: Z,
              },
            ],
          },
        }),
      ],
    }),
  );
  assert.equal(blueprint.files.filter((f) => f.path.startsWith('functions/job/')).length, 0);
  const machine = blueprint.files.find((f) => f.path.startsWith('functions/flow/'));
  const form = blueprint.files.find((f) => f.path.startsWith('functions/aio/'));
  assert.ok(machine);
  assert.ok(form);
  assert.match(stripComments(machine.source), /not available in the IN/);
  assert.match(stripComments(machine.source), /return \(shim\.input\.get\(ctx, "Amount"\) > 100\);/);
  assert.match(stripComments(machine.source), /script_transition_0_condition/);
  assert.match(stripComments(machine.source), /z = 3/);
  assert.match(stripComments(form.source), /y = 2/);
  assert.equal(blueprint.files.filter((f) => f.path.startsWith('functions/aio/')).length, 1);
  check(machine.source, 'blueprint.mjs');
  assert.doesNotMatch(stripComments(machine.source), /body\.record/);
  assert.doesNotMatch(stripComments(machine.source), /body\.old/);
  assert.match(stripComments(machine.source), /dry-run-record/);
  const hiddenAt = machine.source.indexOf('if (isHidden(formName))');
  const authAt = machine.source.indexOf('const principal = principalFromRequest(req)');
  const readAt = machine.source.indexOf('authorizeRead(access, principal');
  assert.ok(hiddenAt >= 0 && hiddenAt < authAt && authAt < readAt);
});

/** Orders form read by profile Staff; `pb`/`prop` are shorthand for blueprint fixtures. */
const ordersStaff = {
  name: 'Staff',
  type: 'Users_Permissions',
  properties: [],
  modules: [
    {
      component: 'Orders',
      properties: [{ key: 'enabled', value: 'viewall', span: Z }],
      reports: [] as { key: string; value: string; span: typeof Z }[],
      fields: [] as { field: string; flags: Record<string, string>; span: typeof Z }[],
      span: Z,
    },
  ],
  span: Z,
};
const prop = (key: string, value: string): Property => ({ key, value, span: Z });
const pb = (name: string, properties: Property[] = [], blocks: PropertyBlock[] = []): PropertyBlock => ({ name, properties, blocks, items: [], span: Z });

/** Orders blueprint app: `Draft → Review` via `Send`, criteria per call. */
function orderBlueprint(fields: App['forms'][number]['fields'], send: Pick<BlueprintTransition, 'name'> & Partial<BlueprintTransition>): App {
  return app({
    profiles: [ordersStaff as App['profiles'][number]],
    forms: [plainForm('Orders', fields)],
    workflows: [
      workflow({
        name: 'Order flow',
        container: 'schedule',
        form: 'Orders',
        event: 'blueprint',
        blueprint: {
          start: pb('Draft'),
          stages: [pb('Draft'), pb('Review'), pb('Done')],
          transitions: [{ fromStage: 'Draft', toStage: 'Review', properties: [], phases: [], span: Z, ...send }],
        },
      }),
    ],
  });
}

/** env live + injected mock store preloaded with Orders rows; restore() in finally. */
async function liveOrders(rows: Record<string, unknown>[]): Promise<{ restore: () => void }> {
  const { datastore } = mockDatastore({});
  const realMode = process.env.C2C_DEPLOY_MODE;
  const realZone = process.env.C2C_APP_TIMEZONE;
  const realStore = (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
  process.env.C2C_DEPLOY_MODE = 'live';
  process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = datastore;
  if (rows.length) await datastore.insert('Orders', rows);
  return {
    restore() {
      if (realMode === undefined) delete process.env.C2C_DEPLOY_MODE;
      else process.env.C2C_DEPLOY_MODE = realMode;
      if (realZone === undefined) delete process.env.C2C_APP_TIMEZONE;
      else process.env.C2C_APP_TIMEZONE = realZone;
      if (realStore === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
      else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = realStore;
    },
  };
}

test('blueprint criteria failure is not "no such transition"; dry run reports criteria unevaluated', async () => {
  const g = generate(
    orderBlueprint([plainField('Amount')], {
      name: 'Send',
      phases: [{ phase: 'before', properties: [prop('transition criteria', 'Amount > 100')], blocks: [], deluge: [], span: Z }],
    }),
  );
  const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(machine);
  const mod = await loadModule(machine.source, 'flow.mjs');
  const caller = { user: { profile: 'Staff', email: 'a@example.com' } };

  // Dry run: the placeholder stage still picks the transition, and the reply
  // says the criteria were not evaluated — the client record is never trusted.
  const dry = await invoke(mod.transition, { ...caller, body: { status: 'Review', record: { Amount: 1 } } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.status, 'Review');
  assert.equal(dry.body.criteria, 'not evaluated in dry run');

  const live = await liveOrders([
    { Amount: '150', Status: 'Draft' },
    { Amount: '50', Status: 'Draft' },
  ]);
  try {
    const denied = await invoke(mod.transition, { ...caller, body: { ROWID: '1001', status: 'Review' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'transition criteria not met', 'a real transition whose criterion fails is not "no such transition"');
    const nowhere = await invoke(mod.transition, { ...caller, body: { ROWID: '1001', status: 'Nowhere' } });
    assert.equal(nowhere.status, 403);
    assert.equal(nowhere.body.error, 'status is not a transition of this stage');
    const ok = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.dryRun, false);
    assert.equal(ok.body.status, 'Review');
  } finally {
    live.restore();
  }
});

test('criteria at transition level and in any case gate, and repeated keys emit no duplicate function', async () => {
  const g = generate(
    orderBlueprint([plainField('Amount')], {
      name: 'Send',
      properties: [prop('transition criteria', 'Amount > 100'), prop('transition criteria', 'Amount < 1000')],
      phases: [
        { phase: 'before', properties: [prop('Transition Criteria', 'Amount != 500')], blocks: [], deluge: [], span: Z },
        { phase: 'during', properties: [prop('transition criteria', 'Amount >= 100'), prop('transition criteria', 'Amount >= 100')], blocks: [], deluge: [], span: Z },
      ],
    }),
  );
  const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(machine);
  // Before the fix every criterion emitted `transition_0_condition`, a
  // duplicate declaration that failed module load with a SyntaxError.
  const mod = await loadModule(machine.source, 'flow.mjs');
  const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
  const live = await liveOrders([
    { Amount: '150', Status: 'Draft' },
    { Amount: '500', Status: 'Draft' },
    { Amount: '2000', Status: 'Draft' },
    { Amount: '50', Status: 'Draft' },
  ]);
  try {
    assert.equal((await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } })).status, 200);
    const under = await invoke(mod.transition, { ...caller, body: { ROWID: '1003', status: 'Review' } });
    assert.equal(under.status, 403);
    assert.equal(under.body.error, 'transition criteria not met');
    const mid = await invoke(mod.transition, { ...caller, body: { ROWID: '1001', status: 'Review' } });
    assert.equal(mid.status, 403);
    assert.equal(mid.body.error, 'transition criteria not met');
    const over = await invoke(mod.transition, { ...caller, body: { ROWID: '1002', status: 'Review' } });
    assert.equal(over.status, 403);
    assert.equal(over.body.error, 'transition criteria not met');
  } finally {
    live.restore();
  }
});

test('an unparseable transition criterion fails closed and is listed as a todo', async () => {
  const g = generate(
    orderBlueprint([plainField('Amount')], {
      name: 'Send',
      phases: [{ phase: 'before', properties: [prop('transition criteria', 'Amount >')], blocks: [], deluge: [], span: Z }],
    }),
  );
  assert.ok(g.todos.length, 'the unparseable criterion is reported, not dropped');
  const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(machine);
  const mod = await loadModule(machine.source, 'flow.mjs');
  const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
  const live = await liveOrders([{ Amount: '150', Status: 'Draft' }]);
  try {
    const denied = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'transition criteria not met');
  } finally {
    live.restore();
  }
});

test('a transition criterion on a removed field fails closed with 403 and is listed as a todo', async () => {
  const g = generate(
    orderBlueprint([plainField('Amount')], {
      name: 'Send',
      phases: [{ phase: 'before', properties: [prop('transition criteria', 'Deleted_Field > 100')], blocks: [], deluge: [], span: Z }],
    }),
  );
  assert.ok(g.todos.length > 0, 'the unresolvable field is reported, not dropped');
  assert.ok(
    g.todos.some((t) => t.construct === 'blueprint-transition-criteria'),
    `expected a blueprint-transition-criteria todo, got ${JSON.stringify(g.todos.map((t) => t.construct))}`,
  );
  const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(machine);
  const mod = await loadModule(machine.source, 'flow.mjs');
  const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
  const live = await liveOrders([{ Amount: '150', Status: 'Draft' }]);
  try {
    const denied = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, 'transition criteria reference an unknown field or function');
  } finally {
    live.restore();
  }
});

test('a removed-field transition criterion both denies and is a visible report row, beside the translation manual step', async () => {
  // Fail closed and nothing silently dropped hold together: the criterion
  // the generator cannot evaluate is denied at run time AND counted in the
  // migration report, and the app's other unmigrated construct (a
  // translation block) is still listed as a manual step. The `input.`
  // spelling is the one only the record-root check catches.
  const base = orderBlueprint([plainField('Amount')], {
    name: 'Send',
    phases: [{ phase: 'before', properties: [prop('transition criteria', 'input.Deleted_Field > 100')], blocks: [], deluge: [], span: Z }],
  });
  const g = generate({
    ...base,
    translations: [{ json: '{"de":{"FormField.Orders.Amount":" Betrag "}}', data: { de: { 'FormField.Orders.Amount': ' Betrag ' } }, span: Z }],
  });
  assert.equal(workflowKind(base.workflows[0]!), 'blueprint');
  const report = JSON.parse(g.files.find((f) => f.path === 'migration-report.json')!.source) as {
    deterministic: boolean;
    todoCount: number;
    untranslated: { construct: string; count: number }[];
    warnings?: { construct: string; name: string }[];
  };
  assert.equal(report.deterministic, false);
  assert.ok(report.todoCount > 0);
  assert.ok(
    report.untranslated.some((u) => u.construct === 'blueprint-transition-criteria'),
    `expected a blueprint-transition-criteria row, got ${JSON.stringify(report.untranslated)}`,
  );
  assert.deepEqual(
    (report.warnings ?? []).filter((w) => w.construct === 'translation-not-migrated').map((w) => w.name),
    ['translation:de'],
  );
  const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(machine);
  const mod = await loadModule(machine.source, 'flow.mjs');
  const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
  const live = await liveOrders([{ Amount: '150', Status: 'Draft' }]);
  try {
    const denied = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, 'transition criteria reference an unknown field or function');
  } finally {
    live.restore();
  }
});

test('a transition criterion reading a removed field through input. or old. fails closed too', async () => {
  // `input.X`/`old.X` spellings translate unconditionally, so the bare-name
  // scan never sees them; the member root is validated against the form.
  for (const criteria of ['input.Deleted == null', 'old.Deleted == null', 'input.Deleted != "x"', 'input.Deleted.foo == 1']) {
    const g = generate(
      orderBlueprint([plainField('Amount')], {
        name: 'Send',
        phases: [{ phase: 'before', properties: [prop('transition criteria', criteria)], blocks: [], deluge: [], span: Z }],
      }),
    );
    assert.ok(
      g.todos.some((t) => t.construct === 'blueprint-transition-criteria'),
      `expected a blueprint-transition-criteria todo for ${criteria}, got ${JSON.stringify(g.todos.map((t) => t.construct))}`,
    );
    const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
    assert.ok(machine);
    const mod = await loadModule(machine.source, 'flow.mjs');
    const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
    const live = await liveOrders([{ Amount: '150', Status: 'Draft' }]);
    try {
      const denied = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
      assert.equal(denied.status, 403, `${criteria}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.error, 'transition criteria reference an unknown field or function');
    } finally {
      live.restore();
    }
  }

  // The same spellings on a field that exists still gate normally; `Status`
  // is the machine's own status column, not a form field.
  const ok = generate(
    orderBlueprint([plainField('Amount')], {
      name: 'Send',
      phases: [{ phase: 'before', properties: [prop('transition criteria', 'input.Amount > 100 && old.Status == "Draft"')], blocks: [], deluge: [], span: Z }],
    }),
  );
  assert.ok(!ok.todos.some((t) => t.construct === 'blueprint-transition-criteria'));
  const machine = ok.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(machine);
  const mod = await loadModule(machine.source, 'flow.mjs');
  const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
  const live = await liveOrders([
    { Amount: '150', Status: 'Draft' },
    { Amount: '50', Status: 'Draft' },
  ]);
  try {
    const allow = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
    assert.equal(allow.status, 200, JSON.stringify(allow.body));
    const denied = await invoke(mod.transition, { ...caller, body: { ROWID: '1001', status: 'Review' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'transition criteria not met');
  } finally {
    live.restore();
  }
});

test('a transition criterion reading a removed field through .get or .toMap fails closed too', async () => {
  // `input.get("X")`, `old.get("X")`, and `input.toMap().get("X")` are record
  // reads exactly like `input.X`, so a removed key is the same closed gate.
  for (const criteria of [
    'input.get("Deleted") == null',
    'old.get("Deleted") == null',
    'input.toMap().get("Deleted") == null',
    'old.toMap().get("Deleted") == null',
    'input.get("Deleted.Sub") == null',
    'input.containsKey("Deleted")',
    'input.keys().contains("Deleted")',
    'Amount > 100 && input.get("Deleted") == null',
  ]) {
    const g = generate(
      orderBlueprint([plainField('Amount')], {
        name: 'Send',
        phases: [{ phase: 'before', properties: [prop('transition criteria', criteria)], blocks: [], deluge: [], span: Z }],
      }),
    );
    assert.ok(
      g.todos.some((t) => t.construct === 'blueprint-transition-criteria'),
      `expected a blueprint-transition-criteria todo for ${criteria}, got ${JSON.stringify(g.todos.map((t) => t.construct))}`,
    );
    const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
    assert.ok(machine);
    const mod = await loadModule(machine.source, 'flow.mjs');
    const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
    const live = await liveOrders([{ Amount: '150', Status: 'Draft' }]);
    try {
      const denied = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
      assert.equal(denied.status, 403, `${criteria}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.error, 'transition criteria reference an unknown field or function');
    } finally {
      live.restore();
    }
  }

  // The same spellings on a field that exists still gate normally.
  for (const criteria of [
    'input.get("Amount") > 100',
    'input.toMap().get("Amount") > 100',
    'old.get("Status") == "Draft" && input.containsKey("Amount") && input.get("Amount") > 100',
    'input.keys().contains("Amount") && input.get("Amount") > 100',
  ]) {
    const ok = generate(
      orderBlueprint([plainField('Amount')], {
        name: 'Send',
        phases: [{ phase: 'before', properties: [prop('transition criteria', criteria)], blocks: [], deluge: [], span: Z }],
      }),
    );
    assert.ok(!ok.todos.some((t) => t.construct === 'blueprint-transition-criteria'), `unexpected todo for ${criteria}`);
    const machine = ok.files.find((f) => f.path.startsWith('functions/flow/'));
    assert.ok(machine);
    const mod = await loadModule(machine.source, 'flow.mjs');
    const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
    const live = await liveOrders([
      { Amount: '150', Status: 'Draft' },
      { Amount: '50', Status: 'Draft' },
    ]);
    try {
      const allow = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
      assert.equal(allow.status, 200, `${criteria}: ${JSON.stringify(allow.body)}`);
      const denied = await invoke(mod.transition, { ...caller, body: { ROWID: '1001', status: 'Review' } });
      assert.equal(denied.status, 403, `${criteria}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.error, 'transition criteria not met');
    } finally {
      live.restore();
    }
  }
});

test('a transition criterion may name the status column and ROWID bare, like input.X', async () => {
  // Bare `Status`/`ROWID` read the same record as `input.Status`/`input.ROWID`;
  // a genuinely unknown bare name still fails closed.
  const cases: { criteria: string; pass1000: boolean }[] = [
    { criteria: 'Status == "Draft"', pass1000: true },
    { criteria: 'Status == "Done"', pass1000: false },
    { criteria: 'ROWID != null', pass1000: true },
    { criteria: 'Bogus == 1', pass1000: false },
  ];
  for (const { criteria, pass1000 } of cases) {
    const g = generate(
      orderBlueprint([plainField('Amount')], {
        name: 'Send',
        phases: [{ phase: 'before', properties: [prop('transition criteria', criteria)], blocks: [], deluge: [], span: Z }],
      }),
    );
    const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
    assert.ok(machine);
    const mod = await loadModule(machine.source, 'flow.mjs');
    const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
    const live = await liveOrders([{ Amount: '150', Status: 'Draft' }]);
    try {
      const res = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
      if (criteria === 'Bogus == 1') {
        assert.ok(g.todos.some((t) => t.construct === 'blueprint-transition-criteria'));
        assert.equal(res.status, 403, `${criteria}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.error, 'transition criteria reference an unknown field or function');
      } else {
        assert.ok(!g.todos.some((t) => t.construct === 'blueprint-transition-criteria'), `unexpected todo for ${criteria}`);
        assert.equal(res.status, pass1000 ? 200 : 403, `${criteria}: ${JSON.stringify(res.body)}`);
        if (!pass1000) assert.equal(res.body.error, 'transition criteria not met');
      }
    } finally {
      live.restore();
    }
  }
});

test('a criterion that emits no verdict is closed by an explicit return false', async () => {
  const g = generate(
    orderBlueprint([plainField('Amount')], {
      name: 'Send',
      phases: [{ phase: 'before', properties: [prop('transition criteria', 'Amount >')], blocks: [], deluge: [], span: Z }],
    }),
  );
  const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(machine);
  // The todo call yields undefined; the appended return keeps the gate closed
  // even though the `// Deluge:` line and the todo string mention `return`.
  assert.match(stripComments(machine.source), /shim\.todo\(ctx, "task:return"[^)]*\);\s*\n\s*return false;/);
});

test('a subscript read, an ifnull-wrapped record, or an untranslated call in a criterion fails closed', async () => {
  // `deny` = 403 unknown field or function plus a listed todo on both rows;
  // `data` = no todo, row 1000 (Amount 150) passes and row 1001 (Amount 50)
  // is "not met".
  const cases: { criteria: string; expect: 'deny' | 'data' }[] = [
    { criteria: 'input["Deleted"] == null', expect: 'deny' },
    { criteria: 'old["Deleted"] == null', expect: 'deny' },
    { criteria: 'input.toMap()["Deleted"] == null', expect: 'deny' },
    { criteria: 'input.toMap().toMap()["Deleted"] == null', expect: 'deny' },
    { criteria: '(input)["Deleted"] == null', expect: 'deny' },
    { criteria: 'input["Dele" + "ted"] == null', expect: 'deny' },
    { criteria: 'input[Amount] == null', expect: 'deny' },
    { criteria: 'input.GET("Deleted") == null', expect: 'deny' },
    { criteria: '!input.GET("Deleted")', expect: 'deny' },
    { criteria: 'input.Get("Deleted") == null', expect: 'deny' },
    { criteria: 'input.Keys().contains("Deleted")', expect: 'deny' },
    { criteria: 'input.getAll("Deleted") == null', expect: 'deny' },
    { criteria: 'ifnull(input, input).get("Deleted") == null', expect: 'deny' },
    { criteria: 'ifnull(input.toMap(), input.toMap()).get("Deleted") == null', expect: 'deny' },
    { criteria: 'ifnull(input.Deleted, "") == ""', expect: 'deny' },
    { criteria: 'ifnull(input.get("Deleted"), "") == ""', expect: 'deny' },
    { criteria: 'input["Amount"] > 100', expect: 'data' },
    { criteria: 'input.toMap()["Amount"] > 100', expect: 'data' },
    { criteria: 'input["Amount"] > 100 && old["Status"] == "Draft"', expect: 'data' },
    { criteria: 'ifnull(input.Amount, 0) > 100', expect: 'data' },
    { criteria: 'ifnull(input.get("Amount"), 0) > 100', expect: 'data' },
    { criteria: 'ifnull(input.toMap(), input.toMap()).get("Amount") > 100', expect: 'data' },
    { criteria: '(input || old)["Deleted"] == null', expect: 'deny' },
    { criteria: '(old || input)["Deleted"] == null', expect: 'deny' },
    { criteria: '(input || old).Deleted == null', expect: 'deny' },
    { criteria: '(input || old).get("Deleted") == null', expect: 'deny' },
    { criteria: 'if(Amount > 0, input, old)["Deleted"] == null', expect: 'deny' },
    { criteria: 'if(Amount > 0, input, old).Deleted == null', expect: 'deny' },
    { criteria: 'if(Amount > 0, input, old).get("Deleted") == null', expect: 'deny' },
    { criteria: '(input && input)["Deleted"] == null', expect: 'deny' },
    { criteria: '(input.toMap() || old)["Deleted"] == null', expect: 'deny' },
    { criteria: '(ifnull(input, old) || old)["Deleted"] == null', expect: 'deny' },
    { criteria: 'Amount > 0 && (input || old)["Deleted"] == null', expect: 'deny' },
    { criteria: '(input || old)["Amount"] > 100', expect: 'data' },
    { criteria: '(input || old).Amount > 100', expect: 'data' },
    { criteria: '(input || old).get("Amount") > 100', expect: 'data' },
    { criteria: 'if(Amount > 0, input, old)["Amount"] > 100', expect: 'data' },
    { criteria: 'if(Amount > 0, input, old).Amount > 100', expect: 'data' },
    { criteria: 'if(Amount > 0, input, old).get("Amount") > 100', expect: 'data' },
    // Escape check rows (records in container literals)
    { criteria: '{input}.get(0).get("Deleted") == null', expect: 'deny' },
    { criteria: '{input}.get(0).Deleted == null', expect: 'deny' },
    { criteria: '{input, old}.get(1)["Deleted"] == null', expect: 'deny' },
    { criteria: '{"k": input}.get("k").get("Deleted") == null', expect: 'deny' },
    { criteria: '{"k": input}.get("k")["Deleted"] == null', expect: 'deny' },
    { criteria: '{input}.get(0).get("Amount") > 100', expect: 'deny' }, // known false-deny due to escape check
    // Mixed receiver false-denies
    { criteria: 'ifnull(input, {"a":1}).get("Amount") > 100', expect: 'deny' },
    { criteria: '(input || {"a":1})["Amount"] > 100', expect: 'deny' },
    { criteria: 'if(Amount > 0, input, {"Amount":0}).Amount > 100', expect: 'deny' },
    { criteria: '(Amount > 0 && input)["Amount"] > 100', expect: 'deny' },
    // A record in the condition of if() / ?: is not a value arm.
    { criteria: 'if({input}.get(0).get("Deleted") == null, input, old).Amount > 100', expect: 'deny' },
    { criteria: '(input || if({input}.get(0).Deleted == null, input, old)).Amount > 100', expect: 'deny' },
    { criteria: 'if(input == null, input, old).Amount > 100', expect: 'deny' },
  ];
  for (const { criteria, expect } of cases) {
    const g = generate(
      orderBlueprint([plainField('Amount')], {
        name: 'Send',
        phases: [{ phase: 'before', properties: [prop('transition criteria', criteria)], blocks: [], deluge: [], span: Z }],
      }),
    );
    const listed = g.todos.some((t) => t.construct === 'blueprint-transition-criteria');
    assert.equal(listed, expect === 'deny', `${criteria}: ${JSON.stringify(g.todos.map((t) => t.construct))}`);
    const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
    assert.ok(machine);
    const mod = await loadModule(machine.source, 'flow.mjs');
    const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
    const live = await liveOrders([
      { Amount: '150', Status: 'Draft' },
      { Amount: '50', Status: 'Draft' },
    ]);
    try {
      const first = await invoke(mod.transition, { ...caller, body: { ROWID: '1000', status: 'Review' } });
      const second = await invoke(mod.transition, { ...caller, body: { ROWID: '1001', status: 'Review' } });
      if (expect === 'deny') {
        for (const res of [first, second]) {
          assert.equal(res.status, 403, `${criteria}: ${JSON.stringify(res.body)}`);
          assert.equal(res.body.error, 'transition criteria reference an unknown field or function');
        }
      } else {
        assert.equal(first.status, 200, `${criteria}: ${JSON.stringify(first.body)}`);
        assert.equal(second.status, 403, `${criteria}: ${JSON.stringify(second.body)}`);
        assert.equal(second.body.error, 'transition criteria not met');
      }
    } finally {
      live.restore();
    }
  }
});

test('condition scripts see rowId as ID and compare lookups by member value', async () => {
  const g = generate(
    orderBlueprint([plainField('Amount'), plainField('Manager', 'lookup')], {
      name: 'Send',
      properties: [prop('transition criteria', 'ID == 4242'), prop('transition criteria', 'Manager == "Ada"')],
    }),
  );
  const machine = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(machine);
  const mod = (await loadModule(machine.source, 'flow.mjs')) as {
    handle: (ctx: ReturnType<ReturnType<typeof createRuntime>['context']>) => Promise<unknown>;
  };
  const runtime = createRuntime({ dryRun: true });
  const run = (script: string, record: Record<string, unknown>, rowId?: string) =>
    mod.handle(runtime.context({ record, old: {}, rowId, transition: { action: 'transition', from: 'Draft', to: 'Review', script } }));
  // Bare ID resolves to the transition request's rowId.
  assert.equal(await run('transition_0_condition', { Amount: '1' }, '4242'), true);
  assert.equal(await run('transition_0_condition', { Amount: '1' }, '9'), false);
  // A lookup {id,label} equals its label or id, not object identity.
  assert.equal(await run('transition_0_condition_2', { Manager: { id: '7', label: 'Ada' } }), true);
  assert.equal(await run('transition_0_condition_2', { Manager: { id: '9', label: 'Bob' } }), false);
});

test('stage and start blocks such as chart data surface as todos, not silent drops', () => {
  const g = generate(
    orderBlueprint([plainField('Amount')], {
      name: 'Send',
      phases: [],
    }),
  );
  const withBlocks = generate(
    app({
      profiles: [ordersStaff as App['profiles'][number]],
      forms: [plainForm('Orders', [plainField('Amount')])],
      workflows: [
        workflow({
          name: 'Order flow',
          container: 'schedule',
          form: 'Orders',
          event: 'blueprint',
          blueprint: {
            start: pb('Draft', [prop('start stage', 'Draft'), prop('theme', 'dark')], [pb('chart data')]),
            stages: [pb('Draft', [], [pb('chart data')]), pb('Review'), pb('Done')],
            transitions: [{ name: 'Send', fromStage: 'Draft', toStage: 'Review', properties: [], phases: [], span: Z }],
          },
        }),
      ],
    }),
  );
  assert.ok(withBlocks.todos.some((t) => t.construct === 'blueprint-stage-block-chart data'));
  assert.ok(withBlocks.todos.some((t) => t.construct === 'blueprint-start-block-chart data'));
  assert.ok(withBlocks.todos.some((t) => t.construct === 'blueprint-start-property-theme'));
  assert.ok(!withBlocks.todos.some((t) => t.construct === 'blueprint-start-property-start stage'), 'the supported start-stage property is not a todo');
  assert.equal(g.todos.filter((t) => t.construct.startsWith('blueprint-stage-') || t.construct.startsWith('blueprint-start-')).length, 0);
});

test('no HTTP route maps to a schedule handler', () => {
  const g = generate(
    app({
      workflows: [
        workflow({
          name: 'Nightly',
          container: 'schedule',
          event: 'on schedule',
          deluge: { text: 'x = 1;', span: Z },
        }),
        workflow({
          name: 'On add',
          form: 'Orders',
          event: 'on success',
          deluge: { text: 'y = 2;', span: Z },
        }),
      ],
    }),
  );
  const jobs = g.files.filter((file) => file.path.startsWith('functions/job/'));
  assert.equal(jobs.length, 1);
  const routes = g.files.flatMap((file) => [...file.source.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]!));
  assert.ok(routes.length > 0);
  for (const job of jobs) {
    assert.equal([...job.source.matchAll(/path:\s*"/g)].length, 0);
    assert.doesNotMatch(stripComments(job.source), /export const endpoint/);
  }
  for (const route of routes) {
    assert.doesNotMatch(stripComments(route), /\/job\/|nightly|schedule/i);
  }
});

test('approval and custom-function gates ignore the client record', async () => {
  const view = {
    component: 'Leave',
    properties: [{ key: 'enabled', value: 'viewall', span: Z }],
    reports: [] as { key: string; value: string; span: typeof Z }[],
    fields: [] as { field: string; flags: Record<string, string>; span: typeof Z }[],
    span: Z,
  };
  const staff = {
    name: 'Staff',
    type: 'Users_Permissions',
    properties: [],
    modules: [view],
    span: Z,
  };
  const approval = generate(
    app({
      profiles: [staff],
      sections: [
        {
          name: 'Hidden',
          hidden: true,
          components: [{ kind: 'form', name: 'SecretLeave' }],
          properties: [],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'Leave approval',
          container: 'approval',
          form: 'Leave',
          event: 'on approve',
          approvers: [{ key: 'users', value: 'a@example.com', span: Z }],
          deluge: { text: 'x = 1;', span: Z },
        }),
        workflow({
          name: 'Hidden approval',
          container: 'approval',
          form: 'SecretLeave',
          event: 'on approve',
          approvers: [{ key: 'users', value: 'a@example.com', span: Z }],
          deluge: { text: 'x = 1;', span: Z },
        }),
      ],
    }),
  );
  const visible = approval.files.find((file) => file.path === 'functions/flow/leave-approval.mjs');
  const hidden = approval.files.find((file) => file.path === 'functions/flow/hidden-approval.mjs');
  assert.ok(visible);
  assert.ok(hidden);
  const visibleMod = await loadModule(visible.source, 'leave.mjs');
  const hiddenMod = await loadModule(hidden.source, 'hidden.mjs');
  const caller = { user: { profile: 'Staff', email: 'a@example.com' } };
  const leak = { record: { Secret: 'nope' }, old: { Secret: 'previous' }, status: 'Approved' };
  assert.equal((await invoke(hiddenMod.approve, { ...caller, body: leak })).status, 403);
  assert.equal((await invoke(visibleMod.approve, { body: leak })).status, 401);
  const stranger = await invoke(visibleMod.approve, { user: { profile: 'Staff', email: 'eve@example.test' }, body: leak });
  assert.equal(stranger.status, 403);
  assert.equal(JSON.stringify(stranger.body).includes('nope'), false);
  assert.equal(JSON.stringify(stranger.body).includes('previous'), false);
  const badStatus = await invoke(visibleMod.approve, { ...caller, body: { status: 'Hacked', record: { Secret: 'nope' } } });
  assert.equal(badStatus.status, 403);
  assert.equal(JSON.stringify(badStatus.body).includes('nope'), false);
  const rejected = await invoke(visibleMod.reject, { ...caller, body: { status: 'Rejected' } });
  assert.equal(rejected.status, 403);
  const ok = await invoke(visibleMod.approve, { ...caller, body: leak });
  assert.equal(ok.status, 200);
  assert.equal(JSON.stringify(ok.body).includes('nope'), false);
  assert.equal(JSON.stringify(ok.body).includes('previous'), false);

  const custom = generate(
    app({
      profiles: [staff],
      functions: [
        {
          name: 'sumRows',
          kind: 'creator',
          signature: 'int sumRows(int limit)',
          form: 'Leave',
          properties: [{ key: 'execution', value: 'for each record', span: Z }],
          deluge: [{ text: 'total = rec.Amount;', span: Z }],
          span: Z,
        },
      ],
    }),
  );
  const fn = custom.files.find((file) => file.path.startsWith('functions/custom/'));
  assert.ok(fn);
  // No api block publishes sumRows, so it is not an HTTP route at all: no
  // endpoint export, and the default handler refuses every request.
  assert.doesNotMatch(stripComments(fn.source), /export const endpoint/);
  assert.doesNotMatch(stripComments(fn.source), /req\.body\.(record|old|row|args)/);
  const mod = await loadModule(fn.source, 'fn.mjs');
  const called = await invoke(mod.default, {
    ...caller,
    body: { record: { Secret: 'nope' }, old: { Secret: 'previous' }, row: { Secret: 'row-secret' }, args: [2] },
  });
  assert.equal(called.status, 404);
});

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

async function loadModule(source: string, name: string, storeSource?: string): Promise<Record<string, (req: unknown, res: unknown) => unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-gate-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  if (storeSource) writeFileSync(join(dir, 'c2c-store.mjs'), storeSource);
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, (req: unknown, res: unknown) => unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write every generated `functions/*` file at its real path so sibling imports (`../thisapp.mjs`) resolve. */
async function loadTree(g: ReturnType<typeof generate>, entry: string): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-tree-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of g.files.filter((f) => f.path.startsWith('functions/'))) {
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.source);
  }
  try {
    return (await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Keep a generated functions tree alive while a callback runs lazy registry imports. */
async function withTree<T>(g: ReturnType<typeof generate>, entry: string, run: (mod: Record<string, unknown>) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-tree-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of g.files.filter((f) => f.path.startsWith('functions/'))) {
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.source);
  }
  try {
    return await run((await import(pathToFileURL(join(dir, entry)).href)) as Record<string, unknown>);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('custom functions get a deterministic thisapp registry and live dispatch stays in-process', async () => {
  const build = () =>
    app({
      functions: [
        {
          name: 'Helpers.twice',
          kind: 'deluge',
          signature: 'int Helpers.twice(int n)',
          deluge: [{ text: 'return n * 2;', span: Z }],
          properties: [],
          span: Z,
        },
        {
          name: 'Helpers.twicePlus',
          kind: 'deluge',
          signature: 'int Helpers.twicePlus(int n)',
          deluge: [{ text: 'return thisapp.Helpers.twice(n) + 1;', span: Z }],
          properties: [],
          span: Z,
        },
      ],
    });
  const g = generate(build());
  const registry = g.files.find((f) => f.path === 'functions/thisapp.mjs');
  assert.ok(registry, 'functions/thisapp.mjs is generated');
  // Entries dispatch through a lazy in-process import so a callee module
  // that fails to parse only fails the call that reaches it, not every
  // module importing the registry.
  assert.doesNotMatch(stripComments(registry.source), /^import /m);
  assert.match(stripComments(registry.source), /"Helpers\.twice": \{ call: async \(\.\.\.a\) => \(await import\("\.\/custom\/helpers-twice\.mjs"\)\)\.Helpers_twice\(\.\.\.a\), params: \["n"\] \}/);
  assert.match(stripComments(registry.source), /"Helpers\.twicePlus": \{ call: async \(\.\.\.a\) => \(await import\("\.\/custom\/helpers-twiceplus\.mjs"\)\)\.Helpers_twicePlus\(\.\.\.a\), params: \["n"\] \}/);
  const again = generate(build());
  assert.equal(again.files.find((f) => f.path === 'functions/thisapp.mjs')!.source, registry.source, 'registry is deterministic');

  // Custom functions are not HTTP routes — no `endpoint` export means no
  // routes.json entry — and the callee needs no `functions` import: the shim
  // dispatches on the caller's runtime.
  const caller = g.files.find((f) => f.path === 'functions/custom/helpers-twiceplus.mjs');
  const callee = g.files.find((f) => f.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(caller && callee);
  assert.doesNotMatch(stripComments(caller.source), /export const endpoint/);
  assert.doesNotMatch(stripComments(callee.source), /export const endpoint/);

  // In-process dispatch: the generated callee runs inside the caller's
  // runtime and returns its value — no HTTP surface involved.
  const dir = mkdtempSync(join(tmpdir(), 'c2c-tree-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
    for (const file of g.files.filter((f) => f.path.startsWith('functions/'))) {
      const dest = join(dir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.source);
    }
    const registry = (await import(pathToFileURL(join(dir, 'functions/thisapp.mjs')).href)) as {
      functions: Readonly<Record<string, { call(ctx: unknown, ...a: unknown[]): Promise<unknown> }>>;
    };
    const runtime = createRuntime({ dryRun: false, settingsTimeZone: 'Asia/Kolkata', functions: registry.functions });
    const ctx = runtime.context({ record: {}, old: {} });
    const result = await ctx.shim.thisapp.call(ctx, ['Helpers', 'twicePlus'], [4]);
    assert.equal(result, 9, 'thisapp.Helpers.twice(4) + 1');
    assert.ok(runtime.transcript.some((entry) => entry.op === 'thisapp' && entry.performed === true));
    // HTTP is not an entry point: the module's default handler refuses.
    const mod = (await import(pathToFileURL(join(dir, 'functions/custom/helpers-twiceplus.mjs')).href)) as {
      default(req: unknown, res: unknown): unknown;
    };
    const refused = await invoke(mod.default, { user: { profile: 'Administrator' }, body: { args: [4] } });
    assert.equal(refused.status, 404);
    const dryRuntime = createRuntime({ dryRun: true, settingsTimeZone: 'Asia/Kolkata', functions: registry.functions });
    const dryCtx = dryRuntime.context({ record: {}, old: {} });
    const dry = (await dryCtx.shim.thisapp.call(dryCtx, ['Helpers', 'twicePlus'], [4])) as { dryRun?: boolean };
    assert.equal(dry.dryRun, true);
    assert.ok(dryRuntime.transcript.some((entry) => entry.op === 'thisapp' && entry.performed === false), 'the thisapp call is recorded, not run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** An `api` block whose actions call `thisapp.<fn>` — the .ds way to mark a function HTTP-exposed. */
function apiBlock(
  name: string,
  actions: string,
  extra: { key: string; value: string }[] = [],
  method: string | null = 'GET',
) {
  return {
    name,
    properties: [
      ...(method === null ? [] : [{ key: 'method', value: method, span: Z }]),
      ...extra.map((p) => ({ ...p, span: Z })),
    ],
    blocks: [
      { name: 'actions', properties: [], blocks: [], items: [], deluge: [{ text: actions, span: Z }], span: Z },
    ],
    items: [],
    span: Z,
  };
}

const ADMIN = {
  name: 'Administrator',
  type: 'Users_Permissions',
  properties: [],
  modules: [],
  span: Z,
};

function twiceFn() {
  return {
    name: 'Helpers.twice',
    kind: 'deluge' as const,
    signature: 'int Helpers.twice(int n)',
    deluge: [{ text: 'return n * 2;', span: Z }],
    properties: [],
    span: Z,
  };
}

test('a read-only thisapp callee becomes an event-time client call and endpoint', async () => {
  const build = () =>
    app({
      forms: [plainForm('Orders', [plainField('Hours')])],
      profiles: [ADMIN],
      functions: [
        {
          name: 'Util.Ok',
          kind: 'deluge',
          signature: 'bool Util.Ok(int n)',
          deluge: [{ text: 'return n > 1;', span: Z }],
          properties: [],
          span: Z,
        },
        {
          name: 'Util.Unused',
          kind: 'deluge',
          signature: 'int Util.Unused()',
          deluge: [{ text: 'return 1;', span: Z }],
          properties: [],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'Hours check',
          form: 'Orders',
          event: 'on user input',
          deluge: { text: 'if(thisapp.Util.Ok(input.Hours)) { alert "ok"; }', span: Z },
        }),
      ],
    });
  const g = generate(build());
  const again = generate(build());
  assert.deepEqual(
    again.files.map((f) => [f.path, f.source]),
    g.files.map((f) => [f.path, f.source]),
    'generated files are deterministic',
  );
  assert.equal(g.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-user-input.mjs')!;
  const endpoint = g.files.find((f) => f.path === 'functions/custom/util-ok-call.mjs')!;
  assert.ok(client && endpoint);
  assert.match(stripComments(client.source), /await shim\.client\.call\(ctx, "Util\.Ok", \[shim\.input\.get\(ctx, "Hours"\)\]\)/);
  assert.equal(g.files.some((f) => f.path === 'functions/custom/util-unused-call.mjs'), false, 'unused read-only functions do not get a route');
  check(endpoint.source, 'call.mjs');
  check(client.source, 'client.mjs');

  const mod = (await loadTree(g, 'functions/custom/util-ok-call.mjs')) as Record<string, (req: unknown, res: unknown) => unknown>;
  const called = await invoke(mod.default, { user: { profile: 'Administrator' }, body: { nonce: 'n1', args: [3] } });
  assert.equal(called.status, 200);
  assert.equal(called.body.ok, true);
  assert.equal(called.body.dryRun, true);
  assert.equal(called.body.nonce, 'n1');
  assert.equal(called.body.value, null, 'a dry run reports a falsy value, never a truthy placeholder');

  const live = await liveOrders([]);
  try {
    const liveCall = await withTree(g, 'functions/custom/util-ok-call.mjs', (liveMod) =>
      invoke(liveMod.default as (req: unknown, res: unknown) => unknown, { user: { profile: 'Administrator' }, body: { nonce: 'n2', args: [3] } }),
    );
    assert.equal(liveCall.status, 200);
    assert.equal(liveCall.body.ok, true);
    assert.equal(liveCall.body.dryRun, false);
    assert.equal(liveCall.body.nonce, 'n2');
    assert.equal(liveCall.body.value, true);
  } finally {
    live.restore();
  }

  const clientMod = (await loadModule(client.source, 'client.mjs')) as Record<string, (ctx: unknown) => Promise<{ op: string }[]>>;
  const okRuntime = createRuntime({
    dryRun: true,
    clientPrefetch: (path, nonce, request) => {
      assert.equal(path, '/functions/util-ok/call');
      assert.equal(request?.args?.[0], 3);
      return { ok: true, nonce, value: true };
    },
  });
  const okActions = await clientMod.clientActions!(okRuntime.context({ record: { Hours: 3 }, formNonce: 'n1' }));
  assert.deepEqual(okActions, [{ op: 'alert', message: 'ok' }]);
  const staleRuntime = createRuntime({
    dryRun: true,
    clientPrefetch: () => ({ ok: true, nonce: 'old', value: true }),
  });
  const stale = await clientMod.clientActions!(staleRuntime.context({ record: { Hours: 3 }, formNonce: 'n1' }));
  assert.deepEqual(stale.map((a) => a.op), ['info'], 'a stale nonce fails closed');
  const blockedRuntime = createRuntime({
    dryRun: true,
    clientPrefetch: (_path, nonce) => ({ ok: false, nonce, error: 'denied' }),
  });
  const blocked = await clientMod.clientActions!(blockedRuntime.context({ record: { Hours: 3 }, formNonce: 'n1' }));
  assert.deepEqual(blocked.map((a) => a.op), ['info'], 'a failed call fails closed and discards queued actions');
});

test('a read-only thisapp call on a server-bound local keeps the manual condition', async () => {
  for (const text of [
    'n = Orders[Hours == input.Hours].count();\nif(thisapp.Util.F(n)) { alert "x"; }',
    'n = Orders[Hours == input.Hours].count();\nif(thisapp.Util.F(input.Hours) && n > 0) { alert "x"; }',
  ]) {
    const g = generate(
      app({
        forms: [plainForm('Orders', [plainField('Hours')])],
        profiles: [ADMIN],
        functions: [
          {
            name: 'Util.F',
            kind: 'deluge',
            signature: 'bool Util.F(int n)',
            deluge: [{ text: 'return n > 0;', span: Z }],
            properties: [],
            span: Z,
          },
        ],
        workflows: [
          workflow({
            name: 'Hours check',
            form: 'Orders',
            event: 'on user input',
            deluge: { text, span: Z },
          }),
        ],
      }),
    );
    assert.equal(g.todos.filter((t) => t.construct === 'client-condition-uses-server').length, 1, text);
    const client = g.files.find((f) => f.path === 'client/handlers/orders/on-user-input.mjs')!;
    assert.doesNotMatch(stripComments(client.source), /shim\.client\.call\(/, text);
    assert.match(stripComments(client.source), /shim\.todo\(ctx, "client-condition-uses-server"\)/, text);
    const clientMod = (await loadModule(client.source, 'server-bound-client.mjs')) as Record<string, (ctx: unknown) => Promise<{ op: string }[]>>;
    const runtime = createRuntime({ dryRun: true });
    const actions = await clientMod.clientActions!(runtime.context({ record: { Hours: 3 }, formNonce: 'n1' }));
    assert.ok(Array.isArray(actions), 'the client handler runs without a ReferenceError');
  }
});

test('a local collection mutated with server data keeps the manual condition', async () => {
  const calls = [
    { name: 'Util.F', signature: 'bool Util.F(int n)', body: 'return n > 0;' },
    { name: 'Util.L', signature: 'bool Util.L(collection items)', body: 'return items.size() > 0;' },
  ].map((f) => ({ name: f.name, kind: 'deluge' as const, signature: f.signature, deluge: [{ text: f.body, span: Z }], properties: [], span: Z }));
  for (const text of [
    'm = Map();\nm.put("k", Orders[Hours == input.Hours].count());\nif(thisapp.Util.F(m.get("k"))) { alert "x"; }',
    'm = Map();\nfor each r in Orders[Hours == input.Hours] { m.put("k", r.Hours); }\nif(thisapp.Util.F(m.get("k"))) { alert "x"; }',
    'l = List();\nl.add(Orders[Hours == input.Hours].count());\nif(thisapp.Util.L(l)) { alert "x"; }',
    'l = List();\nfor each r in Orders[Hours == input.Hours] { l.add(r.Hours); }\nif(thisapp.Util.L(l)) { alert "x"; }',
  ]) {
    const g = generate(
      app({
        forms: [plainForm('Orders', [plainField('Hours')])],
        profiles: [ADMIN],
        functions: calls,
        workflows: [
          workflow({
            name: 'Hours check',
            form: 'Orders',
            event: 'on user input',
            deluge: { text, span: Z },
          }),
        ],
      }),
    );
    assert.equal(g.todos.filter((t) => t.construct === 'client-condition-uses-server').length, 1, text);
    const client = g.files.find((f) => f.path === 'client/handlers/orders/on-user-input.mjs')!;
    assert.doesNotMatch(stripComments(client.source), /shim\.client\.call\(/, text);
    assert.match(stripComments(client.source), /shim\.todo\(ctx, "client-condition-uses-server"\)/, text);
    const clientMod = (await loadModule(client.source, 'server-mutated-client.mjs')) as Record<string, (ctx: unknown) => Promise<{ op: string }[]>>;
    const runtime = createRuntime({ dryRun: true });
    const actions = await clientMod.clientActions!(runtime.context({ record: { Hours: 3 }, formNonce: 'n1' }));
    assert.ok(Array.isArray(actions), 'the client handler runs without a ReferenceError');
  }
});

test('a client-fed mutation of a local collection still becomes a client call', () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Hours')])],
      profiles: [ADMIN],
      functions: [
        {
          name: 'Util.L',
          kind: 'deluge',
          signature: 'bool Util.L(collection items)',
          deluge: [{ text: 'return items.size() > 0;', span: Z }],
          properties: [],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'Hours check',
          form: 'Orders',
          event: 'on user input',
          deluge: { text: 'l = List();\nl.add(input.Hours);\nif(thisapp.Util.L(l)) { alert "x"; }', span: Z },
        }),
      ],
    }),
  );
  assert.equal(g.todos.some((t) => t.construct === 'client-condition-uses-server'), false);
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-user-input.mjs')!;
  assert.match(stripComments(client.source), /await shim\.client\.call\(ctx, "Util\.L", \[l\]\)/);
});

test('a writing or transitively writing thisapp callee keeps the manual condition and no endpoint', () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Hours')])],
      profiles: [ADMIN],
      functions: [
        {
          name: 'Util.Close',
          kind: 'deluge',
          signature: 'void Util.Close(int n)',
          deluge: [{ text: 'row = insert into Orders [ Hours = n ];', span: Z }],
          properties: [],
          span: Z,
        },
        {
          name: 'Util.Wrap',
          kind: 'deluge',
          signature: 'void Util.Wrap(int n)',
          deluge: [{ text: 'return thisapp.Util.Close(n);', span: Z }],
          properties: [],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'Hours check',
          form: 'Orders',
          event: 'on user input',
          deluge: { text: 'if(thisapp.Util.Wrap(input.Hours)) { alert "ok"; }', span: Z },
        }),
      ],
    }),
  );
  assert.equal(g.files.some((f) => f.path.endsWith('-call.mjs')), false);
  assert.equal(g.todos.filter((t) => t.construct === 'client-condition-uses-server').length, 1);
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-user-input.mjs')!;
  assert.match(stripComments(client.source), /shim\.todo\(ctx, "client-condition-uses-server"\)/);
});

test('a read-only thisapp call in a ui.add argument keeps the manual todo', () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Choice')])],
      profiles: [ADMIN],
      functions: [
        {
          name: 'Choices',
          kind: 'deluge',
          signature: 'list Choices()',
          deluge: [{ text: 'return {"A", "B"};', span: Z }],
          properties: [],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'load',
          form: 'Orders',
          event: 'on load',
          deluge: { text: 'input.Choice:ui.add(thisapp.Choices());', span: Z },
        }),
      ],
    }),
  );
  assert.equal(g.files.some((f) => f.path.endsWith('-call.mjs')), false);
  assert.equal(g.todos.filter((t) => t.construct === 'client-condition-uses-server').length, 1);
  const client = g.files.find((f) => f.path === 'client/handlers/orders/on-load.mjs')!;
  assert.match(stripComments(client.source), /shim\.todo\(ctx, "client-condition-uses-server"\)/);
  assert.doesNotMatch(stripComments(client.source), /shim\.client\.call\(/);
});

test('a read call endpoint authorizes each form it reads and rejects branded arguments', async () => {
  const reader = {
    name: 'Util.Booked',
    kind: 'deluge' as const,
    signature: 'bool Util.Booked(int id)',
    deluge: [{ text: 'return Orders[ID == id].count() > 0;', span: Z }],
    properties: [],
    span: Z,
  };
  const g = generate(
    app({
      forms: [plainForm('Orders', [plainField('Hours')])],
      profiles: [ADMIN],
      functions: [reader],
      workflows: [
        workflow({
          name: 'Hours check',
          form: 'Orders',
          event: 'on user input',
          deluge: { text: 'if(thisapp.Util.Booked(input.ID)) { alert "booked"; }', span: Z },
        }),
      ],
    }),
  );
  const endpoint = g.files.find((f) => f.path === 'functions/custom/util-booked-call.mjs')!;
  assert.ok(endpoint);
  assert.match(stripComments(endpoint.source), /readForms = \["Orders"\]/);
  assert.match(stripComments(endpoint.source), /authorizeRead\(access, principal, form/);
  check(endpoint.source, 'call.mjs');
  const mod = (await loadTree(g, 'functions/custom/util-booked-call.mjs')) as Record<string, (req: unknown, res: unknown) => unknown>;
  const denied = await invoke(mod.default, { user: { profile: 'Staff' }, body: { nonce: 'n1', args: [1] } });
  assert.equal(denied.status, 403);
  const injected = await invoke(mod.default, {
    user: { profile: 'Administrator' },
    body: { nonce: 'n1', args: [{ __row: true, form: 'Orders', values: { ID: 1 } }] },
  });
  assert.equal(injected.status, 400);
  const oversized = await invoke(mod.default, { user: { profile: 'Administrator' }, body: { nonce: 'n1', args: ['x'.repeat(70000)] } });
  assert.equal(oversized.status, 400, 'a call argument over the byte cap is refused');
  // The cap counts encoded bytes, not UTF-16 code units: ~120 KB of UTF-8 is refused.
  const wide = await invoke(mod.default, { user: { profile: 'Administrator' }, body: { nonce: 'n1', args: ['é'.repeat(60000)] } });
  assert.equal(wide.status, 400, 'a call argument over the byte cap in UTF-8 is refused');
  const underWide = await invoke(mod.default, { user: { profile: 'Administrator' }, body: { nonce: 'n1', args: ['é'.repeat(20000)] } });
  assert.equal(underWide.status, 200, 'a call argument under the byte cap is accepted');
});

test('a client call endpoint on a partly readable form reports a caller-scoped-read advisory', () => {
  const g = generate(
    app({
      forms: [plainForm('Bookings', [plainField('Hours')])],
      reports: [
        {
          name: 'Mine',
          type: 'list',
          modifiers: [],
          form: 'Bookings',
          criteria: 'Owner == zoho.loginuser',
          flags: [],
          properties: [],
          columns: [],
          customActions: [],
          conditionalFormats: [],
          filters: [],
          groupBy: [],
          sortBy: [],
          blocks: [],
          views: [],
          span: Z,
        },
      ],
      profiles: [
        ADMIN,
        {
          name: 'Staff',
          type: 'Users_Permissions',
          properties: [],
          modules: [
            {
              component: 'Bookings',
              properties: [],
              reports: [{ key: 'Mine', value: '{"View"}', span: Z }],
              fields: [],
              span: Z,
            },
          ],
          span: Z,
        },
      ],
      functions: [
        {
          name: 'Util.Free',
          kind: 'deluge',
          signature: 'bool Util.Free(int n)',
          deluge: [{ text: 'return Bookings[Hours == n].count() == 0;', span: Z }],
          properties: [],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'Hours check',
          form: 'Bookings',
          event: 'on user input',
          deluge: { text: 'if(thisapp.Util.Free(input.Hours)) { alert "free"; }', span: Z },
        }),
      ],
    }),
  );
  const endpoint = g.files.find((f) => f.path === 'functions/custom/util-free-call.mjs');
  assert.ok(endpoint);
  const report = JSON.parse(g.files.find((f) => f.path === 'migration-report.json')!.source) as {
    warnings?: { construct: string; name: string; note: string }[];
  };
  const advisory = report.warnings?.find((w) => w.construct === 'client-call-caller-scoped-read');
  assert.ok(advisory, 'the migration report names the caller-scoped read');
  assert.equal(advisory!.name, 'Util.Free');
  assert.match(advisory!.note, /Bookings/);
  assert.match(advisory!.note, /caller/);

  // A profile that reads the form in full produces no advisory.
  const full = generate(
    app({
      forms: [plainForm('Bookings', [plainField('Hours')])],
      profiles: [ADMIN],
      functions: [
        {
          name: 'Util.Free',
          kind: 'deluge',
          signature: 'bool Util.Free(int n)',
          deluge: [{ text: 'return Bookings[Hours == n].count() == 0;', span: Z }],
          properties: [],
          span: Z,
        },
      ],
      workflows: [
        workflow({
          name: 'Hours check',
          form: 'Bookings',
          event: 'on user input',
          deluge: { text: 'if(thisapp.Util.Free(input.Hours)) { alert "free"; }', span: Z },
        }),
      ],
    }),
  );
  const fullReport = JSON.parse(full.files.find((f) => f.path === 'migration-report.json')!.source) as {
    warnings?: { construct: string }[];
  };
  assert.equal(fullReport.warnings?.some((w) => w.construct === 'client-call-caller-scoped-read') ?? false, false);
});

test('an api block routes its function and the Administrator profile gates it', async () => {
  const staff = {
    name: 'Staff',
    type: 'Users_Permissions',
    properties: [],
    modules: [
      {
        component: 'Leave',
        properties: [{ key: 'enabled', value: 'viewall', span: Z }],
        reports: [],
        fields: [],
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(
    app({
      profiles: [ADMIN, staff],
      apis: [apiBlock('Get_Twice', 'r = thisapp.Helpers.twice(4)', [{ key: 'scope', value: '"Admin only"' }])],
      functions: [twiceFn()],
    }),
  );
  const fn = g.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(fn);
  assert.match(stripComments(fn.source), /export const endpoint = \{ type: "advancedio", method: "GET", path: "\/functions\/helpers-twice"/);
  assert.match(stripComments(fn.source), /HTTP-exposed by custom API: Get_Twice \(scope "Admin only"\)/);
  const mod = await loadModule(fn.source, 'helpers-twice.mjs');
  // Not authenticated, then authenticated but not an Administrator-preset profile.
  assert.equal((await invoke(mod.default, { body: { args: [4] } })).status, 401);
  const denied = await invoke(mod.default, { user: { profile: 'Staff', loginUser: 's@t' }, body: { args: [4] } });
  assert.equal(denied.status, 403);
  assert.match(stripComments(String(denied.body.error)), /Administrator/);
  const ok = await invoke(mod.default, { user: { profile: 'Administrator', loginUser: 'a@t' }, body: { args: [4] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result, 8);
  // An admin-scoped api is a determinable permission: no migration warning.
  const report = g.files.find((file) => file.path === 'migration-report.json');
  assert.equal(JSON.parse(report!.source).warnings, undefined);
});

/** An application whose `api` block publishes `Helpers.twice`. `methodLine` is a raw property line, or empty when the block omits `method`. */
function apiApp(methodLine: string): App {
  return deriveIr(parse(`application "Demo_App"
{
	functions
	{
		Deluge
		{
			int Helpers.twice(int n)
			{
				return n * 2;
			}
		}
	}
	api Get_Twice
	{
		${methodLine}
		scope = "Admin only"
		actions
		(
			demo-app.Helpers.twice(4)
		)
	}
	share_settings
	{
		Administrator
		{
			type = Users_Permissions
		}
	}
}
`));
}

function customEndpoint(source: string): string {
  return stripComments(source);
}

test('an api block method is the advanced-io endpoint method and the banner matches', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'get']) {
    const expected = method.toUpperCase();
    const g = generate(apiApp(`method = ${method}`));
    const fn = g.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
    assert.ok(fn, method);
    const source = customEndpoint(fn.source);
    assert.match(source, new RegExp(`${expected} /functions/helpers-twice`), method);
    assert.match(
      source,
      new RegExp(`export const endpoint = \\{ type: "advancedio", method: "${expected}", path: "/functions/helpers-twice"`),
      method,
    );
  }
  const quoted = generate(apiApp('method = "GET"'));
  const quotedFn = quoted.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(quotedFn);
  assert.match(customEndpoint(quotedFn.source), /export const endpoint = \{ type: "advancedio", method: "GET", path: "\/functions\/helpers-twice"/);
});

test('an api block with no method keeps the POST endpoint', () => {
  const g = generate(apiApp(''));
  const fn = g.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(fn);
  const source = customEndpoint(fn.source);
  assert.match(source, /POST \/functions\/helpers-twice/);
  assert.match(source, /export const endpoint = \{ type: "advancedio", method: "POST", path: "\/functions\/helpers-twice"/);
});

test('disagreeing or unsupported api methods do not invent a route', () => {
  const disagree = generate(app({
    profiles: [ADMIN],
    apis: [
      apiBlock('Read_Twice', 'r = thisapp.Helpers.twice(4)', [{ key: 'scope', value: '"Admin only"' }], 'GET'),
      apiBlock('Write_Twice', 'r = thisapp.Helpers.twice(4)', [{ key: 'scope', value: '"Admin only"' }], 'POST'),
    ],
    functions: [twiceFn()],
  }));
  const split = disagree.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(split);
  assert.doesNotMatch(stripComments(split.source), /export const endpoint/);
  const splitWarnings = JSON.parse(disagree.files.find((file) => file.path === 'migration-report.json')!.source).warnings as {
    construct: string;
    name: string;
    note: string;
  }[];
  assert.ok(splitWarnings.some((w) => w.construct === 'custom-function-api-method' && w.name === 'Helpers.twice' && /GET/.test(w.note) && /POST/.test(w.note)));

  const unsupported = generate(app({
    profiles: [ADMIN],
    apis: [apiBlock('Head_Twice', 'r = thisapp.Helpers.twice(4)', [{ key: 'scope', value: '"Admin only"' }], 'HEAD')],
    functions: [twiceFn()],
  }));
  const head = unsupported.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(head);
  assert.doesNotMatch(stripComments(head.source), /export const endpoint/);
  assert.doesNotMatch(stripComments(head.source), /method: "POST"/);
  const headWarnings = JSON.parse(unsupported.files.find((file) => file.path === 'migration-report.json')!.source).warnings as {
    construct: string;
    note: string;
  }[];
  assert.ok(headWarnings.some((w) => w.construct === 'custom-function-api-method' && w.note.includes('HEAD')));
});

/**
 * The deployed Advanced I/O entry hands a generated handler this request shape
 * (packages/deploy/fn/index.js): `url` is pathname + search, `method` the verb,
 * `body` the parsed JSON body, `params` matched route segments, and
 * `catalyst.user` the authenticated principal.
 */
function sdkRequest(init: { method?: string; search?: string; args?: unknown[]; path?: string } = {}) {
  return {
    url: `${init.path ?? '/functions/helpers-twice'}${init.search ?? ''}`,
    method: init.method ?? 'GET',
    headers: {},
    body: init.args !== undefined ? { args: init.args } : {},
    params: {},
    catalyst: { user: { profile: 'Administrator', loginUser: 'admin-user' } },
  };
}

test('a GET or DELETE custom api reads its arguments from the query string', async () => {
  const g = generate(apiApp('method = GET'));
  const fn = g.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(fn);
  const mod = await loadModule(fn.source, 'helpers-twice.mjs');

  // The query parameter carries the argument exactly as body.args would.
  const viaQuery = await invoke(mod.default, sdkRequest({ search: '?n=5' }));
  assert.equal(viaQuery.status, 200, JSON.stringify(viaQuery.body));
  assert.equal(viaQuery.body.result, 10);
  const viaBody = await invoke(mod.default, sdkRequest({ method: 'POST', args: [5] }));
  assert.equal(viaBody.status, 200, JSON.stringify(viaBody.body));
  assert.equal(viaBody.body.result, viaQuery.body.result);

  // DELETE takes the same query-string arguments; a query parameter is
  // required and named in the 400.
  const deleted = await invoke(mod.default, sdkRequest({ method: 'DELETE', search: '?n=7' }));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.result, 14);
  const missing = await invoke(mod.default, sdkRequest({ method: 'DELETE' }));
  assert.equal(missing.status, 400);
  assert.match(String(missing.body.error), /\bn\b/);

  // A GET carries no usable body: args in the body are not read, so the
  // declared parameter is missing rather than silently bound to null.
  const bodyOnly = await invoke(mod.default, sdkRequest({ args: [9] }));
  assert.equal(bodyOnly.status, 400);
  assert.match(String(bodyOnly.body.error), /missing required parameter: n/);

  // A value that cannot carry the declared type is a 400 naming the parameter,
  // never a coerced default.
  for (const search of ['?n=abc', '?n=', '?n=1.2.3']) {
    const bad = await invoke(mod.default, sdkRequest({ search }));
    assert.equal(bad.status, 400, search);
    assert.match(String(bad.body.error), /n/, search);
  }
});

test('a live custom api reply carries no transcript; a dry run still does', async () => {
  // The transcript holds record values, table names and ops: a dry-run debug
  // view only. A non-dry (live) reply must not carry it.
  const g = generate(apiApp(''));
  const fn = g.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(fn);
  const mod = await loadModule(fn.source, 'helpers-twice.mjs');
  const post = {
    url: '/functions/helpers-twice',
    method: 'POST',
    headers: {},
    body: { args: [4] },
    params: {},
    catalyst: { user: { profile: 'Administrator', loginUser: 'a@t' } },
  };
  const realMode = process.env.C2C_DEPLOY_MODE;
  const realZone = process.env.C2C_APP_TIMEZONE;
  try {
    // A live runtime requires the Creator app time zone; apiApp declares
    // none, so it comes from the environment like the other live tests.
    process.env.C2C_DEPLOY_MODE = 'live';
    process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    const live = await invoke(mod.default, post);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    assert.equal(live.body.dryRun, false);
    assert.equal('transcript' in live.body, false, `a live reply must not carry the transcript: ${JSON.stringify(live.body).slice(0, 200)}`);
  } finally {
    if (realMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = realMode;
    if (realZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = realZone;
  }
  const dry = await invoke(mod.default, post);
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dryRun, true);
  assert.ok(Array.isArray(dry.body.transcript), 'a dry run still returns its debug transcript');
});

test('query arguments coerce to the JSON values the body would carry', async () => {
  const fnOf = (name: string, signature: string, returns: string) => ({
    name,
    kind: 'deluge' as const,
    signature,
    deluge: [{ text: returns, span: Z }],
    properties: [],
    span: Z,
  });
  const g = generate(
    app({
      profiles: [ADMIN],
      functions: [
        fnOf('Probe.flag', 'boolean Probe.flag(boolean flag, string s)', 'return flag;'),
        fnOf('Probe.items', 'list Probe.items(list items)', 'return items;'),
        fnOf('Probe.opts', 'map Probe.opts(map opts)', 'return opts;'),
        fnOf('Probe.when', 'date Probe.when(date when)', 'return when;'),
      ],
      apis: [
        apiBlock('Flag_Api', 'r = thisapp.Probe.flag(true, "x")', [{ key: 'scope', value: '"Admin only"' }], 'GET'),
        apiBlock('Items_Api', 'r = thisapp.Probe.items(l)', [{ key: 'scope', value: '"Admin only"' }], 'GET'),
        apiBlock('Opts_Api', 'r = thisapp.Probe.opts(m)', [{ key: 'scope', value: '"Admin only"' }], 'GET'),
        apiBlock('When_Api', 'r = thisapp.Probe.when(d)', [{ key: 'scope', value: '"Admin only"' }], 'GET'),
      ],
    }),
  );
  const modOf = async (file: string) => {
    const f = g.files.find((item) => item.path === `functions/custom/${file}`);
    assert.ok(f, file);
    return loadModule(f.source, file);
  };

  const flag = await modOf('probe-flag.mjs');
  const path = '/functions/probe-flag';
  const trueGet = await invoke(flag.default, sdkRequest({ path, search: '?flag=true&s=x' }));
  const truePost = await invoke(flag.default, sdkRequest({ path, method: 'POST', args: [true, 'x'] }));
  assert.strictEqual(trueGet.body.result, true, 'a boolean query value is the boolean the body would carry');
  assert.equal(truePost.body.result, true);
  const falseGet = await invoke(flag.default, sdkRequest({ path, search: '?flag=false&s=x' }));
  assert.strictEqual(falseGet.body.result, false);
  const badFlag = await invoke(flag.default, sdkRequest({ path, search: '?flag=yes&s=x' }));
  assert.equal(badFlag.status, 400);
  assert.match(String(badFlag.body.error), /flag/);

  const items = await modOf('probe-items.mjs');
  const itemsGet = await invoke(items.default, sdkRequest({ path: '/functions/probe-items', search: `?items=${encodeURIComponent('[1,"a",true]')}` }));
  const itemsPost = await invoke(items.default, sdkRequest({ path: '/functions/probe-items', method: 'POST', args: [[1, 'a', true]] }));
  assert.deepEqual(itemsGet.body.result, [1, 'a', true]);
  assert.deepEqual(itemsGet.body.result, itemsPost.body.result);
  for (const search of ['?items=notjson', `?items=${encodeURIComponent('{"a":1}')}`]) {
    const bad = await invoke(items.default, sdkRequest({ path: '/functions/probe-items', search }));
    assert.equal(bad.status, 400, search);
    assert.match(String(bad.body.error), /items/, search);
  }
  // A parsed argument gets the same plain-JSON screening a body argument gets:
  // a runtime-branded value is null on both paths.
  const branded = encodeURIComponent('[{"__row":true}]');
  const brandedGet = await invoke(items.default, sdkRequest({ path: '/functions/probe-items', search: `?items=${branded}` }));
  const brandedPost = await invoke(items.default, sdkRequest({ path: '/functions/probe-items', method: 'POST', args: [[{ __row: true }]] }));
  assert.equal(brandedGet.body.result, brandedPost.body.result, 'branded JSON is screened like body args');

  const opts = await modOf('probe-opts.mjs');
  const optsGet = await invoke(opts.default, sdkRequest({ path: '/functions/probe-opts', search: `?opts=${encodeURIComponent('{"a":1}')}` }));
  assert.deepEqual(optsGet.body.result, { a: 1 });
  const arrayOpts = await invoke(opts.default, sdkRequest({ path: '/functions/probe-opts', search: `?opts=${encodeURIComponent('[1]')}` }));
  assert.equal(arrayOpts.status, 400);
  assert.match(String(arrayOpts.body.error), /opts/);

  const when = await modOf('probe-when.mjs');
  const whenGet = await invoke(when.default, sdkRequest({ path: '/functions/probe-when', search: '?when=2026-03-04' }));
  const whenPost = await invoke(when.default, sdkRequest({ path: '/functions/probe-when', method: 'POST', args: ['2026-03-04'] }));
  assert.equal(whenGet.body.result, '2026-03-04');
  assert.equal(whenGet.body.result, whenPost.body.result);
  const badWhen = await invoke(when.default, sdkRequest({ path: '/functions/probe-when', search: '?when=not-a-date' }));
  assert.equal(badWhen.status, 400);
  assert.match(String(badWhen.body.error), /when/);
});

test('query arguments coerce by the normalised type, whatever spelling the signature uses', async () => {
  // Every spelling the compiler's normalised-type table accepts must coerce on
  // GET exactly as the JSON value the body carries on a POST — `bool` is the
  // boolean `boolean` is, `integer` the number `int` is, `collection` the JSON
  // list `list` is.
  const cases: { type: string; search: string; arg: unknown }[] = [
    { type: 'bool', search: '?v=TRUE', arg: true },
    { type: 'boolean', search: '?v=false', arg: false },
    { type: 'int', search: '?v=5', arg: 5 },
    { type: 'integer', search: '?v=5', arg: 5 },
    { type: 'long', search: '?v=-7', arg: -7 },
    { type: 'bigint', search: '?v=42', arg: 42 },
    { type: 'number', search: '?v=1.5', arg: 1.5 },
    { type: 'float', search: '?v=1.5', arg: 1.5 },
    { type: 'double', search: '?v=2.25', arg: 2.25 },
    { type: 'decimal', search: '?v=1.10', arg: 1.1 },
    { type: 'string', search: `?v=${encodeURIComponent('WO 42')}`, arg: 'WO 42' },
    { type: 'text', search: `?v=${encodeURIComponent('WO 42')}`, arg: 'WO 42' },
    { type: 'date', search: '?v=2026-03-04', arg: '2026-03-04' },
    { type: 'datetime', search: `?v=${encodeURIComponent('2026-03-04 15:04:05')}`, arg: '2026-03-04 15:04:05' },
    { type: 'date time', search: `?v=${encodeURIComponent('2026-03-04 15:04:05')}`, arg: '2026-03-04 15:04:05' },
    { type: 'timestamp', search: `?v=${encodeURIComponent('2026-03-04 15:04:05')}`, arg: '2026-03-04 15:04:05' },
    { type: 'list', search: `?v=${encodeURIComponent('[1,2]')}`, arg: [1, 2] },
    { type: 'collection', search: `?v=${encodeURIComponent('[1,2]')}`, arg: [1, 2] },
    { type: 'map', search: `?v=${encodeURIComponent('{"a":1}')}`, arg: { a: 1 } },
  ];
  const fnOf = (name: string, signature: string, returns: string) => ({
    name,
    kind: 'deluge' as const,
    signature,
    deluge: [{ text: returns, span: Z }],
    properties: [],
    span: Z,
  });
  const g = generate(
    app({
      profiles: [ADMIN],
      functions: cases.map((c, i) => fnOf(`Probe.p${i}`, `string Probe.p${i}(${c.type} v)`, 'return v;')),
      apis: cases.map((c, i) =>
        apiBlock(`Api_P${i}`, `r = thisapp.Probe.p${i}(x)`, [{ key: 'scope', value: '"Admin only"' }], 'GET'),
      ),
    }),
  );
  for (const [i, c] of cases.entries()) {
    const file = `probe-p${i}.mjs`;
    const f = g.files.find((item) => item.path === `functions/custom/${file}`);
    assert.ok(f, `${file} (${c.type})`);
    const mod = await loadModule(f.source, file);
    const path = `/functions/probe-p${i}`;
    const viaGet = await invoke(mod.default, sdkRequest({ path, search: c.search }));
    assert.equal(viaGet.status, 200, `${c.type}: ${JSON.stringify(viaGet.body)}`);
    const viaPost = await invoke(mod.default, sdkRequest({ path, method: 'POST', args: [c.arg] }));
    assert.equal(viaPost.status, 200, `${c.type}: ${JSON.stringify(viaPost.body)}`);
    assert.deepEqual(viaGet.body.result, viaPost.body.result, `${c.type}: GET coerces to the POST value`);
    assert.deepEqual(viaGet.body.result, c.arg, `${c.type}: GET ${c.search} is ${JSON.stringify(c.arg)}`);
  }
});

test('a query parameter of a type with no coercion is a 400 naming the parameter and the type', async () => {
  const g = generate(
    app({
      profiles: [ADMIN],
      functions: [
        {
          name: 'Probe.blob',
          kind: 'deluge' as const,
          signature: 'string Probe.blob(object v)',
          deluge: [{ text: 'return "x";', span: Z }],
          properties: [],
          span: Z,
        },
      ],
      apis: [apiBlock('Blob_Api', 'r = thisapp.Probe.blob(x)', [{ key: 'scope', value: '"Admin only"' }], 'GET')],
    }),
  );
  const f = g.files.find((item) => item.path === 'functions/custom/probe-blob.mjs');
  assert.ok(f);
  const mod = await loadModule(f.source, 'probe-blob.mjs');
  const res = await invoke(mod.default, sdkRequest({ path: '/functions/probe-blob', search: '?v=anything' }));
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error), /v/);
  assert.match(String(res.body.error), /object/);
});

test('a query key that names no parameter is ignored with a warning; other verbs keep body args', async () => {
  const g = generate(apiApp('method = GET'));
  const fn = g.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(fn);
  const mod = await loadModule(fn.source, 'helpers-twice.mjs');

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: unknown) => warnings.push(String(msg));
  try {
    const ok = await invoke(mod.default, sdkRequest({ search: '?n=5&bogus=1' }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.result, 10);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some((w) => w.includes('bogus')), 'the unknown key is warned about');

  // POST, PUT and PATCH are unchanged: body.args only, query string ignored.
  for (const method of ['POST', 'PUT', 'PATCH']) {
    const viaBody = await invoke(mod.default, sdkRequest({ method, args: [5] }));
    assert.equal(viaBody.body.result, 10, method);
    const viaQuery = await invoke(mod.default, sdkRequest({ method, search: '?n=5' }));
    assert.equal(viaQuery.body.result, 0, `${method} ignores the query string`);
  }
});

test('a GET custom api binds a work-order-style string parameter end to end', async () => {
  const g = generate(
    deriveIr(
      parse(`application "Demo_App"
{
	functions
	{
		Deluge
		{
			string fs.workOrderStatus(string woNumber)
			{
				return "status:" + woNumber;
			}
		}
	}
	api WorkOrder_Status
	{
		method = GET
		scope = "Admin only"
		actions
		(
			demo-app.fs.workOrderStatus(woNumber)
		)
	}
	share_settings
	{
		Administrator
		{
			type = Users_Permissions
		}
	}
}
`),
    ),
  );
  const fn = g.files.find((file) => file.path === 'functions/custom/fs-workorderstatus.mjs');
  assert.ok(fn);
  assert.match(stripComments(fn.source), /export const endpoint = \{ type: "advancedio", method: "GET", path: "\/functions\/fs-workorderstatus"/);
  const mod = await loadModule(fn.source, 'fs-workorderstatus.mjs');
  const ok = await invoke(mod.default, sdkRequest({ path: '/functions/fs-workorderstatus', search: `?woNumber=${encodeURIComponent('WO 42')}` }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.result, 'status:WO 42');
  const missing = await invoke(mod.default, sdkRequest({ path: '/functions/fs-workorderstatus' }));
  assert.equal(missing.status, 400);
  assert.match(String(missing.body.error), /woNumber/);
});

test('API custom function checks hidden form before principal authentication', async () => {
  const fn: FunctionDef = {
    name: 'Secret.peek', kind: 'creator', form: 'SecretLeave',
    signature: 'string Secret.peek()', properties: [],
    deluge: [{ text: 'return "ok";', span: Z }], span: Z,
  };
  const g = generate(app({
    profiles: [ADMIN], functions: [fn],
    sections: [{ name: 'Hidden', hidden: true, components: [{ kind: 'form', name: 'SecretLeave' }], properties: [], span: Z }],
    apis: [apiBlock('Peek_Secret', 'r = thisapp.Secret.peek()', [{ key: 'scope', value: '"Admin only"' }])],
  }));
  const file = g.files.find((item) => item.path === 'functions/custom/secret-peek.mjs');
  assert.ok(file);
  const mod = await loadModule(file.source, 'secret-peek.mjs');
  const anonymous = await invoke(mod.default, {});
  assert.equal(anonymous.status, 403);
  assert.equal(anonymous.body.error, 'hidden form');
  const hiddenAt = file.source.indexOf('if (isHidden(formName))');
  const principalAt = file.source.indexOf('const principal = principalFromRequest(req)');
  assert.ok(hiddenAt >= 0 && hiddenAt < principalAt);
});

test('an api with no determinable scope still routes but warns and gates to Administrator', async () => {
  const g = generate(
    app({
      profiles: [ADMIN],
      apis: [apiBlock('Get_Twice', 'r = thisapp.Helpers.twice(4)')],
      functions: [twiceFn()],
    }),
  );
  const fn = g.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(fn);
  assert.match(stripComments(fn.source), /export const endpoint/);
  const mod = await loadModule(fn.source, 'helpers-twice.mjs');
  assert.equal((await invoke(mod.default, { user: { profile: 'Member' }, body: { args: [1] } })).status, 403);
  assert.equal((await invoke(mod.default, { user: { profile: 'Administrator' }, body: { args: [1] } })).status, 200);
  const warnings = JSON.parse(g.files.find((file) => file.path === 'migration-report.json')!.source).warnings as {
    construct: string;
    name: string;
    note: string;
  }[];
  assert.ok(warnings.some((w) => w.construct === 'custom-function-api-scope' && w.name === 'Helpers.twice' && w.note.includes('Get_Twice')));
});

test('an app-name-qualified api action still publishes its function', () => {
  const g = generate(
    app({
      name: 'demo-app',
      profiles: [ADMIN],
      apis: [apiBlock('Get_Twice', 'demo-app.Helpers.twice(4)', [{ key: 'scope', value: '"Admin only"' }])],
      functions: [twiceFn()],
    }),
  );
  const fn = g.files.find((file) => file.path === 'functions/custom/helpers-twice.mjs');
  assert.ok(fn);
  assert.match(stripComments(fn.source), /export const endpoint/);
});

test('jobs and flows honour C2C_DEPLOY_MODE instead of a hard-coded dry run', () => {
  const g = generate(
    app({
      workflows: [
        workflow({
          name: 'Nightly',
          container: 'schedule',
          event: 'on schedule',
          deluge: { text: 'x = 1;', span: Z },
        }),
        workflow({
          name: 'Leave approval',
          container: 'approval',
          form: 'Leave',
          event: 'on approve',
          approvers: [{ key: 'level', value: '1', span: Z }],
          deluge: { text: 'x = 1;', span: Z },
        }),
      ],
    }),
  );
  const job = g.files.find((f) => f.path.startsWith('functions/job/'));
  const flow = g.files.find((f) => f.path.startsWith('functions/flow/'));
  assert.ok(job && flow);
  for (const file of [job, flow]) {
    assert.match(stripComments(file.source), /modeOverride\(\)/, file.path);
    assert.match(stripComments(file.source), /deployConfig\(\)/, file.path);
    assert.match(stripComments(file.source), /liveDatastore\(\)/, file.path);
    assert.match(stripComments(file.source), /dryRun: !live/, file.path);
    assert.doesNotMatch(stripComments(file.source), /createRuntime\(\{\s*dryRun: true/, file.path);
    check(file.source, file.path.split('/').pop()!);
  }
  assert.match(stripComments(job.source), /import \{ createRuntime \}/);
  // The flow loads the stored row in live mode before validating the transition.
  assert.match(stripComments(flow.source), /a live transition needs body\.ROWID/);
  assert.match(stripComments(flow.source), /shim\.datastore\.writeRow\(ctx, formName/);
});

test('payments stay not-supported and are not translated', () => {
  const g = generate(
    app({
      workflows: [
        workflow({
          name: 'Checkout',
          type: 'payment',
          event: 'on success',
          deluge: { text: 'charge = 1;', span: Z },
        }),
      ],
    }),
  );
  const stub = g.files.find((f) => f.path.startsWith('not-supported/payments-'));
  assert.ok(stub);
  assert.match(stripComments(stub.source), /not-supported/);
  assert.doesNotMatch(stripComments(stub.source), /charge = 1/);
  assert.equal(g.stats.statements, 0);
  assert.equal(g.files.filter((f) => f.path.startsWith('functions/')).length, 0);
  check(stub.source, 'pay.mjs');
});

test('for-each-record functions bind rec and every generated file parses', () => {
  const fn: FunctionDef = {
    name: 'sumRows',
    kind: 'creator',
    signature: 'int sumRows(int limit)',
    form: 'Orders',
    properties: [{ key: 'execution', value: 'for each record', span: Z }],
    deluge: [{ text: 'total = rec.Amount;', span: Z }],
    span: Z,
  };
  const g = generate(app({ functions: [fn] }));
  const custom = g.files.find((f) => f.path.startsWith('functions/custom/'));
  assert.ok(custom);
  assert.match(stripComments(custom.source), /const d_rec = ctx\.row/);
  assert.doesNotMatch(stripComments(custom.source), /req\.body\.row/);
  assert.doesNotMatch(stripComments(custom.source), /req\.body\.old/);
  assert.doesNotMatch(stripComments(custom.source), /req\.body\.record/);
  assert.match(stripComments(custom.source), /sumRows\(ctx, limit\)/);
  // No api block publishes this function, so it is in-process only.
  assert.doesNotMatch(stripComments(custom.source), /export const endpoint/);
  for (const file of g.files.filter((f) => f.path.endsWith('.mjs'))) {
    assert.doesNotMatch(stripComments(file.source), /\bfetch\s*\(/);
    check(file.source, file.path.replace(/[^\w.]+/g, '_') || 'file.mjs');
  }
  const report = g.files.find((f) => f.path === 'migration-report.json');
  assert.ok(report);
  const parsed = JSON.parse(report.source) as { dryRun: boolean; statements: { statements: number } };
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.statements.statements, g.stats.statements);
});

test('a creator function with an empty body is still generated', () => {
  const ir = snippet(`\tworkflow
\t{
\t\tfunctions
\t\t{
\t\t\tSchedule_Maintenance as "Schedule Maintenance"
\t\t\t{
\t\t\t\ttype = functions
\t\t\t\tform = Raise_New_Complaint
\t\t\t\texecution type = for each record
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  assert.equal(ir.functions.length, 1);
  assert.equal(ir.functions[0].deluge.length, 0);
  const generated = generate(ir);
  const file = generated.files.find((item) => item.path === 'functions/custom/schedule-maintenance.mjs');
  assert.ok(file);
  assert.match(file.source, /Function Schedule_Maintenance/);
  assert.match(file.source, /export async function Schedule_Maintenance/);
  assert.match(file.source, /const d_rec = ctx\.row/);
  const registry = generated.files.find((item) => item.path === 'functions/thisapp.mjs');
  assert.ok(registry);
  assert.match(registry.source, /Schedule_Maintenance/);
  for (const item of generated.files.filter((entry) => entry.path.endsWith('.mjs'))) check(item.source, item.path.replace(/[^\w.]+/g, '_') || 'file.mjs');
});

test('a pre-success openUrl is a client handler, and an empty workflow is named in the report', () => {
  const ir = snippet(`\tform Item
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tDirect as "Direct"
\t\t\t{
\t\t\t\ttype = presuccess
\t\t\t\tform = Item
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\topenURL("#Report:Active","new window");
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tBlank as "Blank"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  assert.match(ir.workflows.find((item) => item.name === 'Direct')?.deluge?.text ?? '', /openURL/);
  const generated = generate(ir);
  const client = generated.files.find((item) => item.path === 'client/handlers/item/on-start.mjs');
  assert.ok(client);
  assert.match(stripComments(client.source), /op: "openUrl"/);
  const report = JSON.parse(generated.files.find((item) => item.path === 'migration-report.json')!.source) as {
    warnings?: { construct: string; name: string; note: string }[];
  };
  assert.ok(report.warnings?.some((item) => item.construct === 'workflow-empty' && item.name === 'Blank'));
  assert.equal(report.warnings?.some((item) => item.name === 'Direct'), false);
});

test('field and reporting-level approvers deny explicitly and transitions use the placeholder stage', async () => {
  const view = {
    component: 'Item',
    properties: [{ key: 'enabled', value: 'viewall', span: Z }],
    reports: [] as { key: string; value: string; span: typeof Z }[],
    fields: [] as { field: string; flags: Record<string, string>; span: typeof Z }[],
    span: Z,
  };
  const staff = { name: 'Staff', type: 'Users_Permissions', properties: [], modules: [view], span: Z };
  const generated = generate(
    app({
      profiles: [staff],
      workflows: [
        workflow({
          name: 'Order flow',
          form: 'Item',
          event: 'blueprint',
          blueprint: {
            start: { name: 'Draft', properties: [], blocks: [], items: [], span: Z },
            stages: [
              { name: 'Draft', properties: [], blocks: [], items: [], span: Z },
              { name: 'Review', properties: [], blocks: [], items: [], span: Z },
              { name: 'Done', properties: [], blocks: [], items: [], span: Z },
            ],
            transitions: [
              {
                name: 'Send',
                fromStage: 'Draft',
                toStage: 'Review',
                properties: [{ key: 'roles', value: 'Manager', span: Z }],
                phases: [],
                span: Z,
              },
              {
                name: 'Finish',
                fromStage: 'Review',
                toStage: 'Done',
                properties: [{ key: 'roles', value: 'Manager', span: Z }],
                phases: [],
                span: Z,
              },
            ],
          },
        }),
        workflow({
          name: 'Field approval',
          container: 'approval',
          form: 'Item',
          event: 'on approve',
          approvers: [{ key: 'approver field', value: 'Manager', span: { start: 4, end: 18 } }],
        }),
        workflow({
          name: 'Level approval',
          container: 'approval',
          form: 'Item',
          event: 'on approve',
          approvers: [{ key: 'reporting level', value: '1', span: { start: 20, end: 36 } }],
        }),
      ],
    }),
  );
  const report = generated.files.find((file) => file.path === 'migration-report.json');
  assert.ok(report);
  const parsed = JSON.parse(report.source) as { untranslated: { construct: string; count: number }[] };
  assert.equal(parsed.untranslated.find((row) => row.construct === 'approver-field')?.count, 1);
  assert.equal(parsed.untranslated.find((row) => row.construct === 'approver-reporting-level')?.count, 1);

  const machine = generated.files.find((file) => file.path === 'functions/flow/order-flow.mjs');
  const fieldFile = generated.files.find((file) => file.path === 'functions/flow/field-approval.mjs');
  const levelFile = generated.files.find((file) => file.path === 'functions/flow/level-approval.mjs');
  assert.ok(machine);
  assert.ok(fieldFile);
  assert.ok(levelFile);
  assert.doesNotMatch(stripComments(machine.source), /body\.record/);
  assert.match(stripComments(machine.source), /unsupported: form-field approver/);
  assert.match(stripComments(machine.source), /unsupported: reporting-level approver/);
  check(machine.source, 'machine.mjs');

  const flow = await loadModule(machine.source, 'order-flow.mjs');
  const manager = { user: { profile: 'Staff', role: 'Manager' } };
  assert.equal((await invoke(flow.transition, { ...manager, body: { status: 'Review' } })).status, 200);
  const skipped = await invoke(flow.transition, { ...manager, body: { status: 'Done' } });
  assert.equal(skipped.status, 403);
  assert.equal(skipped.body.error, 'status is not a transition of this stage');
  assert.equal((await invoke(flow.transition, { ...manager, body: { status: 'Done', stage: 'Review' } })).status, 200);
  const wrongStage = await invoke(flow.transition, { ...manager, body: { status: 'Review', stage: 'Done', record: { Secret: 'nope' } } });
  assert.equal(wrongStage.status, 403);
  assert.equal(JSON.stringify(wrongStage.body).includes('nope'), false);

  const fieldMod = await loadModule(fieldFile.source, 'field-approval.mjs');
  const fieldDenied = await invoke(fieldMod.approve, { ...manager, body: { status: 'Approved', record: { Secret: 'nope' } } });
  assert.equal(fieldDenied.status, 403);
  assert.equal(fieldDenied.body.error, 'unsupported: form-field approver');
  assert.equal(JSON.stringify(fieldDenied.body).includes('nope'), false);

  const levelMod = await loadModule(levelFile.source, 'level-approval.mjs');
  const levelDenied = await invoke(levelMod.approve, { ...manager, body: { status: 'Approved' } });
  assert.equal(levelDenied.status, 403);
  assert.equal(levelDenied.body.error, 'unsupported: reporting-level approver');
});

test('an actions criteria gates the handler and a blank date still throws only when it runs', async () => {
  const ir = deriveIr(
    parse(`application "T"
{
	form Book_Transaction
	{
		Status
		(
			type = picklist
		)
		Return_date
		(
			type = date
		)
		Fine_Amount
		(
			type = number
		)
	}
	workflow
	{
		form
		{
			Overdue as "Overdue"
			{
				type = form
				form = Book_Transaction
				record event = on add
				on success
				{
					actions (Status == "Overdue")
					{
						custom deluge script
						(
							todayDate = zoho.currentdate;
							returnDate = input.Return_date;
							if(todayDate > returnDate)
							{
								input.Fine_Amount = 1;
							}
							else
							{
								input.Fine_Amount = 0;
							}
						)
					}
				}
			}
		}
	}
}
`),
  );
  assert.equal(ir.workflows[0]?.actionCondition, 'Status == "Overdue"');
  const generated = generate(ir);
  const server = generated.files.find((file) => file.path === 'functions/aio/book-transaction/on-success.mjs');
  assert.ok(server);
  assert.match(stripComments(server.source), /if \(shim\.input\.get\(ctx, "Status"\) == "Overdue"\)/);
  assert.doesNotMatch(stripComments(server.source), /if \(await shim\.todo/);
  check(server.source, 'overdue.mjs');
  const mod = (await loadModule(server.source, 'on-success.mjs')) as {
    handle: (ctx: ReturnType<ReturnType<typeof createRuntime>['context']>) => Promise<unknown>;
  };
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date('2020-06-15T12:00:00Z') });
  const issued = runtime.context({ record: { Status: 'Issued', Return_date: '' } });
  await mod.handle(issued);
  assert.equal(
    runtime.transcript.some((entry) => entry.op === 'input.set' && Array.isArray(entry.path) && entry.path.includes('Fine_Amount')),
    false,
  );
  const overdue = createRuntime({ dryRun: true, appTimeZone: 'Asia/Kolkata', now: new Date('2020-06-15T12:00:00Z') });
  await assert.rejects(
    () => mod.handle(overdue.context({ record: { Status: 'Overdue', Return_date: '' } })),
    /UnParsable date/,
  );
  assert.equal(
    overdue.transcript.some((entry) => entry.op === 'input.set' && Array.isArray(entry.path) && entry.path.includes('Fine_Amount')),
    false,
  );

  const gap = generate(
    app({
      workflows: [
        workflow({
          name: 'On add',
          form: 'Orders',
          event: 'on success',
          actionCondition: 'foo() == 1',
          deluge: { text: 'input.Fine_Amount = 0;', span: Z },
        }),
      ],
    }),
  );
  const gapFile = gap.files.find((file) => file.path === 'functions/aio/orders/on-success.mjs');
  assert.ok(gapFile);
  assert.match(stripComments(gapFile.source), /await shim\.todo\(ctx, "workflow-action-condition"\)/);
  assert.doesNotMatch(stripComments(gapFile.source), /Fine_Amount/);
  assert.doesNotMatch(stripComments(gapFile.source), /if \(await shim\.todo/);
  const report = JSON.parse(gap.files.find((file) => file.path === 'migration-report.json')!.source) as {
    untranslated: { construct: string }[];
  };
  assert.equal(report.untranslated.some((row) => row.construct === 'workflow-action-condition'), true);
});

test('limits module quotes the measured Catalyst limits', () => {
  const g = generate(app({}));
  const limits = g.files.find((f) => f.path === 'runtime/limits.mjs');
  assert.ok(limits);
  assert.match(stripComments(limits.source), /255/);
  assert.match(stripComments(limits.source), /200/);
  assert.match(stripComments(limits.source), /300/);
  check(limits.source, 'limits.mjs');
});

const CRITERIA_NOW = new Date('2020-06-15T20:00:00Z');
const CRITERIA_ZONE = 'Asia/Kolkata';

function snippet(body: string): App {
  return deriveIr(parse(`application "T"\n{\n${body}\n}\n`));
}

async function runHandle(
  source: string,
  record: Record<string, unknown>,
  opts: {
    principal?: { profile: string; loginUser?: string; userId?: string };
    adminUser?: string;
    writeOp?: 'insert' | 'update';
    rowId?: string;
  } = {},
): Promise<ReturnType<typeof createRuntime>> {
  const mod = (await loadModule(source, 'handler.mjs')) as {
    handle: (ctx: ReturnType<ReturnType<typeof createRuntime>['context']>) => Promise<unknown>;
  };
  const runtime = createRuntime({
    dryRun: true,
    appTimeZone: CRITERIA_ZONE,
    now: CRITERIA_NOW,
    ...(opts.adminUser ? { adminUser: opts.adminUser } : {}),
  });
  await mod.handle(
    runtime.context({
      record,
      ...(opts.principal ? { principal: opts.principal } : {}),
      ...(opts.writeOp ? { writeOp: opts.writeOp } : {}),
      ...(opts.rowId !== undefined ? { rowId: opts.rowId } : {}),
    }),
  );
  return runtime;
}

async function runPrepared(
  source: string,
  record: Record<string, unknown>,
  opts: {
    principal: { profile: string; loginUser?: string; userId?: string };
    rowId?: string;
    writeOp?: 'insert' | 'update';
    rows: Record<string, unknown>[];
  },
): Promise<{ runtime: ReturnType<typeof createRuntime>; where: string }> {
  const mod = (await loadModule(source, 'prepared.mjs')) as unknown as {
    handle: (ctx: ReturnType<ReturnType<typeof createRuntime>['context']>) => Promise<unknown>;
    access: NonNullable<Parameters<typeof createRuntime>[0]>['access'];
  };
  let where = '';
  const runtime = createRuntime({
    dryRun: false,
    appTimeZone: CRITERIA_ZONE,
    now: CRITERIA_NOW,
    access: mod.access,
    datastore: {
      async query(_form: string, zcql: string) {
        where = zcql;
        const id = /ROWID = '([^']*)'/.exec(zcql)?.[1];
        const row = opts.rows.find((item) => item.ROWID === id);
        return row ? [row] : [];
      },
    },
  });
  await mod.handle(
    runtime.context({
      record,
      principal: opts.principal,
      ...(opts.rowId !== undefined ? { rowId: opts.rowId } : {}),
      ...(opts.writeOp ? { writeOp: opts.writeOp } : {}),
    }),
  );
  return { runtime, where };
}

function wroteFine(runtime: ReturnType<typeof createRuntime>): boolean {
  return runtime.transcript.some(
    (entry) => entry.op === 'input.set' && Array.isArray(entry.path) && entry.path.includes('Fine_Amount') && entry.value === 1,
  );
}

test('is today and is tomorrow compile to shim.date.isDay and do not throw', async () => {
  const ir = snippet(`\tform Plan
\t{
\t\tSchedule_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tExpiry_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tFine_Amount
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tworkflow
\t{
\t\tschedule
\t\t{
\t\t\tDue as "Due"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Plan
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions (Schedule_Date is today)
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tExpiry as "Expiry"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Plan
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions (Expiry_Date is tomorrow)
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const generated = generate(ir);
  const today = generated.files.find((file) => file.path === 'functions/job/due.mjs');
  const tomorrow = generated.files.find((file) => file.path === 'functions/job/expiry.mjs');
  assert.ok(today);
  assert.ok(tomorrow);
  assert.match(stripComments(today.source), /shim\.date\.isDay\(shim\.input\.get\(ctx, "Schedule_Date"\), "today", ctx\)/);
  assert.match(stripComments(tomorrow.source), /shim\.date\.isDay\(shim\.input\.get\(ctx, "Expiry_Date"\), "tomorrow", ctx\)/);
  assert.doesNotMatch(stripComments(today.source), /[^"'\\w]today\\b/);
  assert.doesNotMatch(stripComments(tomorrow.source), /[^"'\\w]tomorrow\\b/);
  assert.equal(measureActionCriteria(ir).unbound.length, 0);
  assert.equal(measureActionCriteria(ir).guarded, 2);
  const todayHit = await runHandle(today.source, { Schedule_Date: '16-Jun-2020' });
  assert.equal(wroteFine(todayHit), true);
  const todayMiss = await runHandle(today.source, { Schedule_Date: '15-Jun-2020' });
  assert.equal(wroteFine(todayMiss), false);
  const todayBlank = await runHandle(today.source, { Schedule_Date: '' });
  assert.equal(wroteFine(todayBlank), false);
  const tomorrowHit = await runHandle(tomorrow.source, { Expiry_Date: '17-Jun-2020' });
  assert.equal(wroteFine(tomorrowHit), true);
  const tomorrowMiss = await runHandle(tomorrow.source, { Expiry_Date: '16-Jun-2020' });
  assert.equal(wroteFine(tomorrowMiss), false);
});

test('Added_User and Added_Time use system-field accessors', async () => {
  const ir = snippet(`\tform Raise_Incident
\t{
\t\tFine_Amount
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tform Maintenance_Block
\t{
\t\tBlock_From
\t\t(
\t\t\ttype = date
\t\t)
\t\tFine_Amount
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tNotify as "Notify"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Raise_Incident
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions (Added_User != zoho.adminuser)
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\tschedule
\t\t{
\t\t\tBlock as "Block"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Maintenance_Block
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions (Added_Time < zoho.currentdate && Block_From == zoho.currentdate)
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const generated = generate(ir);
  const user = generated.files.find((file) => file.path === 'functions/aio/raise-incident/on-success.mjs');
  const block = generated.files.find((file) => file.path === 'functions/job/block.mjs');
  assert.ok(user);
  assert.ok(block);
  assert.match(stripComments(user.source), /shim\.record\.system\(ctx\.record, "Added_User"\) != shim\.zoho\.adminUser\(ctx\)/);
  assert.doesNotMatch(stripComments(user.source), /[^"'\\w.]Added_User\\b/);
  assert.match(stripComments(block.source), /shim\.record\.system\(ctx\.record, "Added_Time"\)/);
  assert.match(stripComments(block.source), /shim\.date\.rel\(/);
  assert.match(stripComments(block.source), /shim\.input\.get\(ctx, "Block_From"\)/);
  assert.match(stripComments(block.source), /shim\.zoho\.currentDate\(ctx\)/);
  assert.equal(measureActionCriteria(ir).unbound.length, 0);
  const ran = await runHandle(user.source, { Added_User: 'ada' });
  assert.equal(wroteFine(ran), true);
  const before = await runHandle(block.source, { Added_Time: '01-Jan-2020', Block_From: '16-Jun-2020' });
  assert.equal(wroteFine(before), true);
  const after = await runHandle(block.source, { Added_Time: '31-Dec-2020', Block_From: '16-Jun-2020' });
  assert.equal(wroteFine(after), false);
});

function numberForm(name: string): string {
  return `\tform ${name}
\t{
\t\tFine_Amount
\t\t(
\t\t\ttype = number
\t\t)
\t}`;
}

test('Added_User and Added_Time are set before the on-success guard', async () => {
  const ir = snippet(`${numberForm('Raise_Incident')}
${numberForm('Clock_Later')}
${numberForm('Clock_Earlier')}
${numberForm('Edit_Incident')}
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tNotify as "Notify"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Raise_Incident
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions (Added_User == zoho.adminuser)
\t\t\t\t\t{
\t\t\t\t\t\ton success
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tLater as "Later"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Clock_Later
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions (Added_Time >= zoho.currentdate)
\t\t\t\t\t{
\t\t\t\t\t\ton success
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tEarlier as "Earlier"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Clock_Earlier
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions (Added_Time < zoho.currentdate)
\t\t\t\t\t{
\t\t\t\t\t\ton success
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tEdit as "Edit"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Edit_Incident
\t\t\t\ton edit
\t\t\t\t{
\t\t\t\t\tactions (Added_User == zoho.loginuser)
\t\t\t\t\t{
\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const generated = generate(ir);
  const user = generated.files.find((file) => file.path === 'functions/aio/raise-incident/on-success.mjs');
  const later = generated.files.find((file) => file.path === 'functions/aio/clock-later/on-success.mjs');
  const earlier = generated.files.find((file) => file.path === 'functions/aio/clock-earlier/on-success.mjs');
  const edit = generated.files.find((file) => file.path === 'functions/aio/edit-incident/on-edit.mjs');
  assert.ok(user);
  assert.ok(later);
  assert.ok(earlier);
  assert.ok(edit);
  assert.match(stripComments(user.source), /shim\.record\.stamp\(ctx, "insert"\)/);
  const handleAt = user.source.indexOf('export async function handle');
  const stampAt = user.source.indexOf('shim.record.stamp', handleAt);
  const guardAt = user.source.indexOf('if (', stampAt);
  assert.ok(handleAt >= 0 && stampAt > handleAt && guardAt > stampAt);
  const admin = 'app.owner';
  const matching = await runHandle(user.source, {}, {
    principal: { profile: 'Administrator', loginUser: admin },
    adminUser: admin,
  });
  assert.equal(wroteFine(matching), true);
  const another = await runHandle(user.source, { Added_User: admin }, {
    principal: { profile: 'Administrator', loginUser: 'ada' },
    adminUser: admin,
  });
  assert.equal(wroteFine(another), false);
  assert.equal(wroteFine(await runHandle(later.source, {})), true);
  assert.equal(wroteFine(await runHandle(earlier.source, {})), false);

  assert.match(stripComments(edit.source), /await shim\.record\.prepare\(ctx, formName, "update"\)/);
  assert.doesNotMatch(stripComments(edit.source), /shim\.record\.stamp\(ctx, "update"\)/);
  const stored = [
    { ROWID: '1001', Added_User: 'ada', Added_Time: '13-Apr-2023 17:21:24' },
    { ROWID: '1002', Added_User: 'bob', Added_Time: '13-Apr-2023 17:21:24' },
  ];
  const adaEdit = { Fine_Amount: 1 };
  const same = await runPrepared(edit.source, { ...adaEdit }, {
    principal: { profile: 'Administrator', loginUser: 'ada' },
    rowId: '1001',
    rows: stored,
  });
  assert.equal(wroteFine(same.runtime), true);

  const editMod = (await loadModule(edit.source, 'edit-incident-http.mjs')) as {
    default: (req: unknown, res: unknown) => Promise<unknown>;
  };

  const realMode = process.env.C2C_DEPLOY_MODE;
  const realZone = process.env.C2C_APP_TIMEZONE;
  const realStore = (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
  const storedRow = { ROWID: '1001', Added_User: 'ada', Added_Time: '13-Apr-2023 17:21:24' };
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = {
    async query(_form: string, zcql: string) {
      const id = /ROWID = '([^']*)'/.exec(zcql)?.[1];
      return storedRow.ROWID === id ? [storedRow] : [];
    },
    async update() {
      return {};
    },
  };
  try {
    const editShellWithoutRow = await invoke(editMod.default, {
      user: { profile: 'Administrator', loginUser: 'ada' },
      body: { record: adaEdit },
    });
    assert.equal(editShellWithoutRow.status, 400);
    assert.match(String(editShellWithoutRow.body.error), /record needs body.ROWID/);

    const editShellWithRow = await invoke(editMod.default, {
      user: { profile: 'Administrator', loginUser: 'ada' },
      body: { ROWID: '9999', record: adaEdit },
    });
    assert.equal(editShellWithRow.status, 404); // 9999 not in stored

    const editShellWithRowValid = await invoke(editMod.default, {
      user: { profile: 'Administrator', loginUser: 'ada' },
      body: { ROWID: '1001', record: { Fine_Amount: 2 } },
    });
    assert.equal(editShellWithRowValid.status, 200, JSON.stringify(editShellWithRowValid.body));
    const dryTranscript = editShellWithRowValid.body.transcript as { op: string; write?: string; path?: string[]; value?: unknown }[];
    assert.equal(dryTranscript.some((entry) => entry.op === 'system-fields' && entry.write === 'update'), true);
    // The script reads Added_User on the record, not old. Both modes must set Fine_Amount.
    assert.equal(
      dryTranscript.some((entry) => entry.op === 'input.set' && Array.isArray(entry.path) && entry.path.includes('Fine_Amount') && entry.value === 1),
      true,
    );

    process.env.C2C_DEPLOY_MODE = 'live';
    process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    const liveEdit = await invoke(editMod.default, {
      user: { profile: 'Administrator', loginUser: 'ada' },
      body: { ROWID: '1001', record: { Fine_Amount: 2 } },
    });
    assert.equal(liveEdit.status, 200, JSON.stringify(liveEdit.body));
    assert.equal(liveEdit.body.wrote, true);
    const liveValues = liveEdit.body.values as Record<string, unknown>;
    assert.equal(liveValues.Fine_Amount, 1);
    assert.equal(liveValues.Added_User, 'ada');
    assert.equal(liveValues.Added_Time, '13-Apr-2023 17:21:24');
    assert.equal(liveValues.Modified_User, 'ada');
    assert.match(
      stripComments(edit.source),
      /authorizeRead\(access, principal, formName, \{ op: "==", field: "ROWID", value: reqRowId \}, undefined, "modify"\)/,
    );
  } finally {
    if (realMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = realMode;
    if (realZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = realZone;
    if (realStore === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = realStore;
  }
  assert.equal(same.where.includes("ROWID = '1001'"), true);
  const bobEdit: Record<string, unknown> = {};
  const kept = await runPrepared(edit.source, bobEdit, {
    principal: { profile: 'Administrator', loginUser: 'ada' },
    rowId: '1002',
    writeOp: 'insert',
    rows: stored,
  });
  assert.equal(wroteFine(kept.runtime), false);
  assert.equal(bobEdit.Added_User, 'bob');
  assert.equal(kept.runtime.transcript.some((entry) => entry.op === 'system-fields' && entry.write === 'update'), true);

  const mod = (await loadModule(user.source, 'gate.mjs')) as {
    default: (req: unknown, res: unknown) => Promise<unknown>;
  };
  const forged = await invoke(mod.default, {
    user: { profile: 'Administrator', loginUser: 'ada' },
    body: { record: { Added_User: 'forged' } },
  });
  assert.equal(forged.status, 403);
  const clean = await invoke(mod.default, {
    user: { profile: 'Administrator', loginUser: admin },
    body: { record: {} },
  });
  assert.equal(clean.status, 200);
  const transcript = clean.body.transcript as { op: string; write?: string }[];
  assert.equal(transcript.some((entry) => entry.op === 'system-fields' && entry.write === 'insert'), true);
});

test('an edit of a row the caller may read but not modify is refused before the script', async () => {
  const ir = snippet(`${numberForm('Edit_Incident')}
\tshare_settings
\t{
\t\t"Staff"
\t\t{
\t\t\tname = "Staff"
\t\t\ttype = Customer_Portal
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tEdit_Incident
\t\t\t\t{
\t\t\t\t\tenabled = Viewall
\t\t\t\t\tReportPermissions
\t\t\t\t\t{
\t\t\t\t\t\tAll_Edit_Incidents = {"View","Edit"}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\t"Clerk"
\t\t{
\t\t\tname = "Clerk"
\t\t\ttype = Users_Permissions
\t\t\tModulePermissions
\t\t\t{
\t\t\t\tEdit_Incident
\t\t\t\t{
\t\t\t\t\tenabled = Create
\t\t\t\t}
\t\t\t}
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tEdit as "Edit"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Edit_Incident
\t\t\t\ton edit
\t\t\t\t{
\t\t\t\t\tactions (Added_User == zoho.loginuser)
\t\t\t\t\t{
\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const generated = generate(ir);
  const edit = generated.files.find((file) => file.path === 'functions/aio/edit-incident/on-edit.mjs');
  assert.ok(edit);
  const editMod = (await loadModule(edit.source, 'edit-modify-http.mjs')) as unknown as {
    default: (req: unknown, res: unknown) => Promise<unknown>;
    access: { profiles: Record<string, Record<string, { ownerScope?: string; read?: boolean }>> };
  };
  assert.equal(editMod.access.profiles.Staff?.Edit_Incident?.ownerScope, 'modify');
  assert.equal(editMod.access.profiles.Clerk?.Edit_Incident?.read, false);
  const table = [
    { ROWID: '1001', Added_User: 'ada', Added_Time: '13-Apr-2023 17:21:24' },
    { ROWID: '1002', Added_User: 'bob', Added_Time: '13-Apr-2023 17:21:24' },
  ];
  const queries: string[] = [];
  const updates: unknown[] = [];
  const realMode = process.env.C2C_DEPLOY_MODE;
  const realZone = process.env.C2C_APP_TIMEZONE;
  const realStore = (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
  (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = {
    async query(_form: string, zcql: string) {
      queries.push(zcql);
      const id = /ROWID = '([^']*)'/.exec(zcql)?.[1];
      const owner = /Added_User = '([^']*)'/.exec(zcql)?.[1];
      return table.filter((row) => (id === undefined || row.ROWID === id) && (owner === undefined || row.Added_User === owner));
    },
    async update(_form: string, rows: unknown) {
      updates.push(rows);
      return {};
    },
  };
  const staff = { profile: 'Staff', loginUser: 'ada' };
  const posted = { Fine_Amount: 2 };
  const scriptRan = (body: Record<string, unknown>): boolean => {
    const transcript = body.transcript as { op: string; path?: string[]; value?: unknown }[] | undefined;
    if (transcript?.some((entry) => entry.op === 'input.set' && Array.isArray(entry.path) && entry.path.includes('Fine_Amount'))) return true;
    const values = body.values as Record<string, unknown> | undefined;
    return values?.Fine_Amount === 1;
  };
  try {
    const badId = await invoke(editMod.default, { user: staff, body: { ROWID: 'ada-row', record: posted } });
    assert.equal(badId.status, 400);
    assert.match(String(badId.body.error), /record needs body.ROWID/);
    assert.equal(queries.length, 0);

    const blindOwn = await invoke(editMod.default, {
      user: { profile: 'Clerk', loginUser: 'ada' },
      body: { ROWID: '1001', record: posted },
    });
    const blindMissing = await invoke(editMod.default, {
      user: { profile: 'Clerk', loginUser: 'ada' },
      body: { ROWID: '9999', record: posted },
    });
    assert.equal(blindOwn.status, 403);
    assert.equal(blindMissing.status, 403);
    assert.equal(blindOwn.body.error, blindMissing.body.error);
    assert.match(String(blindOwn.body.error), /cannot read Edit_Incident/);
    assert.equal(queries.length, 0);
    assert.equal(updates.length, 0);

    const missing = await invoke(editMod.default, { user: staff, body: { ROWID: '9999', record: posted } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'no such row');
    queries.length = 0;

    const dryForeign = await invoke(editMod.default, { user: staff, body: { ROWID: '1002', record: posted } });
    const dryForeignQueries = queries.slice();
    queries.length = 0;
    process.env.C2C_DEPLOY_MODE = 'live';
    process.env.C2C_APP_TIMEZONE = 'Asia/Kolkata';
    const liveForeign = await invoke(editMod.default, { user: staff, body: { ROWID: '1002', record: posted } });
    assert.equal(dryForeign.status, liveForeign.status);
    assert.equal(dryForeign.body.error, liveForeign.body.error);
    assert.equal(dryForeign.status, 403);
    assert.equal(dryForeign.body.error, 'record access: Edit_Incident row is not visible');
    assert.equal(dryForeign.body.slots, null);
    assert.equal(liveForeign.body.slots, null);
    assert.equal(dryForeign.body.dryRun, true);
    assert.equal(liveForeign.body.dryRun, false);
    assert.equal(dryForeign.body.transcript, undefined);
    assert.equal(liveForeign.body.transcript, undefined);
    assert.equal(scriptRan(dryForeign.body), false);
    assert.equal(scriptRan(liveForeign.body), false);
    assert.equal(updates.length, 0);
    assert.equal(dryForeignQueries.length > 0, true);
    assert.equal(queries.length > 0, true);

    queries.length = 0;
    delete process.env.C2C_DEPLOY_MODE;
    const dryOwn = await invoke(editMod.default, { user: staff, body: { ROWID: '1001', record: posted } });
    assert.equal(dryOwn.status, 200, JSON.stringify(dryOwn.body));
    assert.equal(scriptRan(dryOwn.body), true);
    const ownTranscript = dryOwn.body.transcript as { op: string; path?: string[]; value?: unknown }[];
    assert.equal(
      ownTranscript.some((entry) => entry.op === 'input.set' && entry.value === 1 && Array.isArray(entry.path) && entry.path.includes('Fine_Amount')),
      true,
    );
    process.env.C2C_DEPLOY_MODE = 'live';
    const liveOwn = await invoke(editMod.default, { user: staff, body: { ROWID: '1001', record: posted } });
    assert.equal(liveOwn.status, 200, JSON.stringify(liveOwn.body));
    assert.equal(liveOwn.body.wrote, true);
    const ownValues = liveOwn.body.values as Record<string, unknown>;
    assert.equal(ownValues.Fine_Amount, 1);
    assert.equal(ownValues.Added_User, 'ada');
    assert.equal(ownValues.Added_Time, '13-Apr-2023 17:21:24');
    assert.equal(scriptRan(liveOwn.body), true);

    queries.length = 0;
    const updatesBeforeForge = updates.length;
    const forged = await invoke(editMod.default, {
      user: staff,
      body: { ROWID: '1001', record: { Fine_Amount: 2, Added_User: 'forged' } },
    });
    assert.equal(forged.status, 403);
    assert.match(String(forged.body.error), /Added_User is not client-writable/);
    assert.equal(updates.length, updatesBeforeForge);
    assert.equal(scriptRan(forged.body), false);
  } finally {
    if (realMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = realMode;
    if (realZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = realZone;
    if (realStore === undefined) delete (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore;
    else (globalThis as { __c2cDatastore?: unknown }).__c2cDatastore = realStore;
  }
});

test('on add or edit follows body.ROWID and ignores the client op', async () => {
  const ir = snippet(`${numberForm('Either')}
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tSave as "Save"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Either
\t\t\t\ton add or edit
\t\t\t\t{
\t\t\t\t\tactions (Added_User == zoho.loginuser)
\t\t\t\t\t{
\t\t\t\t\t\ton success
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const generated = generate(ir);
  const file = generated.files.find((item) => item.path === 'functions/aio/either/on-success.mjs');
  assert.ok(file);
  assert.match(stripComments(file.source), /await shim\.record\.prepare\(ctx, formName\);/);
  assert.doesNotMatch(stripComments(file.source), /body\.op === "edit"/);
  assert.match(stripComments(file.source), /rowId: reqRowId/);
  check(file.source, 'either.mjs');
  const inserted = await runHandle(file.source, { Added_User: 'eve' }, {
    principal: { profile: 'Administrator', loginUser: 'ada' },
  });
  assert.equal(wroteFine(inserted), true);
  assert.equal(inserted.transcript.some((entry) => entry.op === 'system-fields' && entry.write === 'insert'), true);
  const spoofed = await runPrepared(file.source, { Added_User: 'eve' }, {
    principal: { profile: 'Administrator', loginUser: 'ada' },
    rowId: 'bob-row',
    writeOp: 'insert',
    rows: [{ ROWID: 'bob-row', Added_User: 'bob', Added_Time: '13-Apr-2023 17:21:24' }],
  });
  assert.equal(wroteFine(spoofed.runtime), false);
  assert.equal(spoofed.runtime.transcript.some((entry) => entry.op === 'system-fields' && entry.write === 'update'), true);

  const mod = (await loadModule(file.source, 'either-http.mjs')) as {
    default: (req: unknown, res: unknown) => Promise<unknown>;
  };
  (globalThis as any).__c2cDatastore = {
    async query(_form: string, zcql: string) {
      if (zcql.includes("ROWID = '1009'")) return [{ ROWID: '1009', Added_User: 'old' }];
      return [];
    }
  };
  const editWithoutRow = await invoke(mod.default, {
    user: { profile: 'Administrator', loginUser: 'ada' },
    body: { op: 'edit', record: {} },
  });
  assert.equal(editWithoutRow.status, 200);
  const editTranscript = editWithoutRow.body.transcript as { op: string; write?: string }[];
  assert.equal(editTranscript.some((entry) => entry.op === 'system-fields' && entry.write === 'insert'), true);
  const addWithRow = await invoke(mod.default, {
    user: { profile: 'Administrator', loginUser: 'ada' },
    body: { op: 'add', ROWID: '1009', record: {} },
  });
  assert.equal(addWithRow.status, 200);
  const addTranscript = addWithRow.body.transcript as { op: string; write?: string }[];
  assert.equal(addTranscript.some((entry) => entry.op === 'system-fields' && entry.write === 'update'), true);
  delete (globalThis as any).__c2cDatastore;
});

test('a schedule form criteria is a datastore query and still runs the handler', async () => {
  const ir = snippet(`\tform Create_New_Procurement_Plan
\t{
\t\tSchedule_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tApproval_Status
\t\t(
\t\t\ttype = picklist
\t\t)
\t\tFine_Amount
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tform Add_New_Subscription
\t{
\t\tExpiry_Date
\t\t(
\t\t\ttype = date
\t\t)
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t)
\t\tFine_Amount
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tworkflow
\t{
\t\tschedule
\t\t{
\t\t\tPlan as "Plan"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Create_New_Procurement_Plan[Approval_Status == "Scheduled"]
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions (Schedule_Date is today)
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\tRenew as "Renew"
\t\t\t{
\t\t\t\ttype = schedule
\t\t\t\tform = Add_New_Subscription[Status != "Cancelled"]
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions (Expiry_Date is today)
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const generated = generate(ir);
  const plan = generated.files.find((file) => file.path === 'functions/job/plan.mjs');
  const renew = generated.files.find((file) => file.path === 'functions/job/renew.mjs');
  assert.ok(plan);
  assert.ok(renew);
  const planQuery = 'shim.datastore.query(ctx, "Create_New_Procurement_Plan", {"op":"==","field":"Approval_Status","value":"Scheduled"})';
  const renewQuery = 'shim.datastore.query(ctx, "Add_New_Subscription", {"op":"!=","field":"Status","value":"Cancelled"})';
  assert.ok(plan.source.includes(planQuery));
  assert.ok(renew.source.includes(renewQuery));
  const planHandle = plan.source.slice(plan.source.indexOf('export async function handle'));
  const renewHandle = renew.source.slice(renew.source.indexOf('export async function handle'));
  assert.ok(planHandle.indexOf(planQuery) < planHandle.indexOf('if ('));
  assert.ok(renewHandle.indexOf(renewQuery) < renewHandle.indexOf('if ('));
  assert.equal(measureActionCriteria(ir).unbound.length, 0);
  const ran = await runHandle(plan.source, { Schedule_Date: '16-Jun-2020' });
  assert.equal(ran.transcript.some((entry) => entry.op === 'fetch' && entry.form === 'Create_New_Procurement_Plan'), true);
  assert.equal(wroteFine(ran), true);
});

test('an unbound actions criteria is a coverage gap and omits the body', () => {
  const ir = snippet(`\tform Orders
\t{
\t\tFine_Amount
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tOn_Add as "On add"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Orders
\t\t\t\ton success
\t\t\t\t{
\t\t\t\t\tactions (NotAField == 1)
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine_Amount = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const generated = generate(ir);
  const file = generated.files.find((item) => item.path === 'functions/aio/orders/on-success.mjs');
  assert.ok(file);
  const handle = file.source.slice(file.source.indexOf('export async function handle'), file.source.indexOf('export default'));
  assert.match(stripComments(handle), /await shim\.todo\(ctx, "workflow-action-condition"\)/);
  assert.doesNotMatch(stripComments(handle), /NotAField/);
  assert.doesNotMatch(stripComments(handle), /Fine_Amount/);
  assert.doesNotMatch(stripComments(handle), /if \(/);
  assert.doesNotMatch(stripComments(file.source), /NotAField/);
  const report = JSON.parse(generated.files.find((item) => item.path === 'migration-report.json')!.source) as {
    untranslated: { construct: string }[];
  };
  assert.equal(report.untranslated.some((row) => row.construct === 'workflow-action-condition'), true);
  assert.equal(measureActionCriteria(ir).gap, 1);
  assert.equal(measureActionCriteria(ir).guarded, 0);
  assert.deepEqual(measureActionCriteria(ir).unbound, []);
});

test('field rules use input fields and omit a body whose condition is unbound', () => {
  const ir = snippet(`\tform Shipment
\t{
\t\tSubmode
\t\t(
\t\t\ttype = picklist
\t\t)
\t\tVessel
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Shipment
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions (Submode == "Sea")
\t\t\t\t\t{
\t\t\t\t\t\tshow Vessel;
\t\t\t\t\t}
\t\t\t\t\tactions (NotAField == 1)
\t\t\t\t\t{
\t\t\t\t\t\thide Vessel;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\ton load
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  const generated = generate(ir);
  const client = generated.files.find((file) => file.path === 'client/handlers/shipment/on-load.mjs');
  assert.ok(client);
  assert.match(stripComments(client.source), /if \(shim\.input\.get\(ctx, "Submode"\) == "Sea"\)/);
  assert.match(stripComments(client.source), /op: "show"/);
  assert.match(stripComments(client.source), /await shim\.todo\(ctx, "field-rule-condition"\)/);
  assert.doesNotMatch(stripComments(client.source), /NotAField/);
  assert.doesNotMatch(stripComments(client.source), /op: "hide"/);
  assert.equal(measureActionCriteria(ir).unbound.length, 0);
});

test('guard extraction still finds the return past the provenance comment', async () => {
  // Every translated statement carries a `// Deluge:` comment line ahead of
  // it; an extraction that anchors `return` at the head degrades each guard
  // to a todo. Both users of the extraction keep working.
  assert.equal(emittedFieldRuleCondition('Amount > 100', ['Amount']), 'shim.input.get(ctx, "Amount") > 100');
  const ir = app({
    forms: [plainForm('Orders', [plainField('Amount')])],
    workflows: [
      workflow({
        name: 'On add',
        form: 'Orders',
        event: 'on success',
        actionCondition: 'Amount > 100',
        deluge: { text: 'input.Fine_Amount = 1;', span: Z },
      }),
    ],
  });
  assert.equal(measureActionCriteria(ir).guarded, 1);
  assert.equal(measureActionCriteria(ir).gap, 0);
  assert.deepEqual(measureActionCriteria(ir).unbound, []);
  const server = generate(ir).files.find((file) => file.path === 'functions/aio/orders/on-success.mjs');
  assert.ok(server);
  assert.match(stripComments(server.source), /if \(shim\.input\.get\(ctx, "Amount"\) > 100\)/);
  assert.equal(wroteFine(await runHandle(server.source, { Amount: '150' })), true);
  assert.equal(wroteFine(await runHandle(server.source, { Amount: '50' })), false);
});

test('actions criteria with show and on success emit both the client action and the server handler', () => {
  const ir = snippet(`\tform Item
\t{
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t)
\t\tNotes
\t\t(
\t\t\ttype = text
\t\t)
\t\tFine
\t\t(
\t\t\ttype = number
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tOpen_Notes as "Open notes"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tactions (Status == "Open")
\t\t\t\t\t{
\t\t\t\t\t\tshow Notes;
\t\t\t\t\t\ton success
\t\t\t\t\t\t(
\t\t\t\t\t\t\tinput.Fine = 1;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  assert.equal(ir.workflows.filter((item) => item.actionCondition === 'Status == "Open"').length, 2);
  const generated = generate(ir);
  // The field rule under a record event lands on the load screen's client
  // handler; the nested `on success` keeps its own server module.
  const client = generated.files.find((file) => file.path === 'client/handlers/item/on-load.mjs');
  const server = generated.files.find((file) => file.path === 'functions/aio/item/on-success.mjs');
  assert.ok(client);
  assert.ok(server);
  assert.match(stripComments(client.source), /if \(shim\.input\.get\(ctx, "Status"\) == "Open"\)/);
  assert.match(stripComments(client.source), /op: "show"/);
  assert.match(stripComments(client.source), /"Notes"/);
  assert.match(stripComments(server.source), /if \(shim\.input\.get\(ctx, "Status"\) == "Open"\)/);
  assert.match(stripComments(server.source), /shim\.input\.set\(ctx, \["Fine"\], 1\)/);
  assert.equal(measureActionCriteria(ir).guarded, 2);
  assert.equal(measureActionCriteria(ir).unbound.length, 0);
});

function galleryDir(): string | undefined {
  const fromEnv = process.env.C2C_GALLERY_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const fixtures = process.env.C2C_FIXTURES_DIR;
  if (!fixtures) return undefined;
  const fallback = join(fixtures, 'gallery');
  return existsSync(fallback) ? fallback : undefined;
}

function rawActionBraces(source: string, doc: ReturnType<typeof parse>): number {
  let raw = 0;
  walkStatements(doc, (statement) => {
    if (headerWords(statement).map((token) => token.text).join(' ').toLowerCase() !== 'actions') return;
    const items = sig(statement);
    const paren = items.find((item) => isGroup(item) && item.open.text === '(');
    const brace = items.find((item) => isGroup(item) && item.open.text === '{');
    if (!paren || !isGroup(paren) || !brace || !isGroup(brace) || !brace.raw) return;
    const criteria = source.slice(paren.open.start + paren.open.text.length, paren.close ? paren.close.start : paren.end).trim();
    if (criteria) raw++;
  });
  return raw;
}

test('gallery action criteria are guarded or explicitly gapped and never raw', { skip: !galleryDir(), timeout: 180000 }, () => {
  const root = galleryDir();
  assert.ok(root);
  const names = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory());
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let guarded = 0;
  let gap = 0;
  let raw = 0;
  const unbound: string[] = [];
  for (const name of names) {
    const project = parseProject(join(root, name));
    raw += project.files.reduce((count, file) => count + rawActionBraces(file.cst.source, file.cst), 0);
    const measured = measureActionCriteria(project.ir);
    guarded += measured.guarded;
    gap += measured.gap;
    unbound.push(...measured.unbound);
  }
  assert.equal(raw, 0, `guarded=${guarded} gap=${gap} raw=${raw}`);
  assert.deepEqual(unbound, [], unbound.join(','));
  console.log(`gallery criteria guarded=${guarded} gap=${gap} raw=${raw} apps=${names.length}`);
});

test('alert verdicts follow the innermost event header', () => {
  const deluge = { text: 'x = 1;\nalert "hi";', span: Z };
  interface Report {
    alertDiagnostics: AlertDiagnostic[];
    untranslated: { construct: string; count: number }[];
  }
  const report = (g: ReturnType<typeof generate>): Report =>
    JSON.parse(g.files.find((f) => f.path === 'migration-report.json')!.source) as Report;
  const clientSource = (g: ReturnType<typeof generate>) =>
    g.files.filter((f) => f.path.startsWith('client/handlers/')).map((f) => f.source).join('\n');

  // Live-tested on Creator: these events run `alert`. A `/` inside a field
  // name is not a path separator; only ` / ` joins event path segments.
  for (const event of [
    'on load',
    'On Validate',
    'on user input of Name',
    'on change of Status',
    'on change of Due/Paid',
    'on click',
    'on add / on click',
    'on success / on validate',
  ]) {
    const g = generate(app({
      workflows: [workflow({ name: 'W', form: 'Orders', event, deluge })],
    }));
    assert.match(stripComments(clientSource(g)), /op: "alert"/, event);
    assert.equal(report(g).alertDiagnostics.length, 0, event);
    assert.equal(report(g).untranslated.filter((u) => u.construct.startsWith('alert-')).length, 0, event);
  }

  // Only the form-workflow on success is proven rejected at import.
  for (const event of ['on success', 'On Success', 'on delete / on success']) {
    const g = generate(app({
      workflows: [workflow({ name: 'W', form: 'Orders', event, deluge })],
    }));
    assert.doesNotMatch(stripComments(clientSource(g)), /op: "alert"/, event);
    const rep = report(g);
    assert.equal(rep.alertDiagnostics.length, 1, event);
    assert.equal(rep.alertDiagnostics[0].verdict, 'disallowed', event);
    assert.equal(rep.alertDiagnostics[0].event, event);
    assert.equal(rep.alertDiagnostics[0].form, 'Orders');
    assert.equal(rep.untranslated.find((u) => u.construct === 'alert-outside-allowed-event')?.count, 1, event);
  }

  // Anything else is unverified, not proven disallowed. `on delete success`
  // was never live-tested, so it must not count as disallowed.
  for (const event of ['on add', 'on add row of Items', 'On Delete Success', 'on add / on delete success', '']) {
    const g = generate(app({
      workflows: [workflow({ name: 'W', form: 'Orders', event, deluge })],
    }));
    assert.doesNotMatch(stripComments(clientSource(g)), /op: "alert"/, event);
    const rep = report(g);
    assert.equal(rep.alertDiagnostics.length, 1, event || '(empty)');
    assert.equal(rep.alertDiagnostics[0].verdict, 'unverified', event);
    assert.equal(rep.untranslated.find((u) => u.construct === 'alert-in-unverified-event')?.count, 1, event);
  }
});

test('an alert after a comment line keeps its real verdict with a note', () => {
  const rep = (text: string, event: string) =>
    JSON.parse(
      generate(app({ workflows: [workflow({ name: 'W', form: 'Orders', event, deluge: { text, span: Z } })] }))
        .files.find((f) => f.path === 'migration-report.json')!.source,
    ) as { alertDiagnostics: AlertDiagnostic[]; untranslated: { construct: string; count: number }[] };

  // A `//` comment line never reaches the parser.
  const plain = rep('//alert lst.Docket_No;\nx = 1;', 'on success');
  assert.equal(plain.alertDiagnostics.length, 0);
  assert.equal(plain.untranslated.filter((u) => u.construct.startsWith('alert-')).length, 0);

  // An ordinary `//` line followed by a live `alert` is NOT a commented
  // statement: the alert keeps its real verdict and carries an adjacency
  // note. An empty `//` line (the closest export-wrap shape) is the same.
  for (const text of ['// Tell the user it saved\nalert "Saved";', '//\nalert lst.Docket_No;\nx = 1;']) {
    const g = generate(app({
      workflows: [workflow({ name: 'W', form: 'Orders', event: 'on success', deluge: { text, span: Z } })],
    }));
    const r = rep(text, 'on success');
    assert.equal(r.alertDiagnostics.length, 1, text);
    assert.equal(r.alertDiagnostics[0].verdict, 'disallowed', text);
    assert.equal(r.alertDiagnostics[0].note, 'follows-comment-line', text);
    assert.equal(r.untranslated.find((u) => u.construct === 'alert-outside-allowed-event')?.count, 1, text);
    assert.equal(r.untranslated.find((u) => u.construct === 'alert-in-commented-source'), undefined, text);
    assert.doesNotMatch(stripComments(
      g.files.filter((f) => f.path.startsWith('client/handlers/')).map((f) => f.source).join('\n')),
      /op: "alert"/,
      text,
    );
  }

  // Without the preceding comment line there is no note.
  const bare = rep('alert "Saved";', 'on success');
  assert.equal(bare.alertDiagnostics[0].verdict, 'disallowed');
  assert.equal(bare.alertDiagnostics[0].note, undefined);

  // The adjacency note also applies in unverified placements.
  const unv = rep('// Tell the user it saved\nalert "Saved";', 'on add');
  assert.equal(unv.alertDiagnostics[0].verdict, 'unverified');
  assert.equal(unv.alertDiagnostics[0].note, 'follows-comment-line');

  // An alert inside a function body is always unverified — callers are not
  // analysed — and is never blamed on the enclosing event.
  const fn = rep('void f() { alert "x"; }', 'on success');
  assert.equal(fn.alertDiagnostics.length, 1);
  assert.equal(fn.alertDiagnostics[0].verdict, 'unverified');
});

test('alert diagnostics mark schedules, approvals, blueprints, and functions unverified at any position', () => {
  const nested = { text: 'x = 1;\nif (x == 1) { alert "a"; }\nalert "b";', span: Z };
  const g = generate(app({
    workflows: [
      workflow({ name: 'Sched', container: 'schedule', event: 'on schedule', deluge: nested }),
      workflow({
        name: 'Appr',
        type: 'approval',
        event: 'on approve',
        deluge: { text: 'alert "hi";', span: Z },
        approvers: [{ key: 'level 1 approver', value: 'zoho.loginuser', span: Z }],
      }),
      workflow({
        name: 'Bp',
        form: 'Orders',
        event: 'blueprint',
        blueprint: {
          stages: [{ name: 'Draft', properties: [], blocks: [], items: [], span: Z }],
          transitions: [{
            name: 'Ship',
            fromStage: 'Draft',
            toStage: 'Done',
            properties: [],
            phases: [{ phase: 'before', properties: [], blocks: [], deluge: [{ text: 'alert "bp";', span: { start: 10, end: 20 } }], span: Z }],
            span: Z,
          }],
        },
        deluge: null,
      }),
    ],
    functions: [{ name: 'Fn', kind: 'creator', deluge: [nested], properties: [], span: Z }],
  }));
  const rep = JSON.parse(g.files.find((f) => f.path === 'migration-report.json')!.source) as
    { alertDiagnostics: AlertDiagnostic[]; untranslated: { construct: string; count: number }[] };
  assert.equal(rep.alertDiagnostics.length, 6);
  const names = rep.alertDiagnostics.map((d) => d.name).sort();
  assert.deepEqual(names, ['Appr', 'Fn', 'Fn', 'Sched', 'Sched', 'Ship / before']);
  for (const d of rep.alertDiagnostics) assert.equal(d.verdict, 'unverified', d.name ?? '');
  assert.equal(rep.untranslated.find((u) => u.construct === 'alert-in-unverified-event')?.count, 6);
  assert.equal(rep.untranslated.find((u) => u.construct === 'alert-outside-allowed-event'), undefined);
  for (const f of g.files) assert.doesNotMatch(stripComments(f.source), /op: "alert"/, f.path);
});

test('gallery alerts: no proven-disallowed placement', { skip: !galleryDir(), timeout: 180000 }, () => {
  const root = galleryDir();
  assert.ok(root);
  const names = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory());
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const byVerdict = { disallowed: 0, unverified: 0, commented: 0 };
  const list: string[] = [];
  for (const name of names) {
    const project = parseProject(join(root, name));
    const g = generate(project.ir);
    const rep = JSON.parse(g.files.find((f) => f.path === 'migration-report.json')!.source) as
      { alertDiagnostics: AlertDiagnostic[] };
    for (const d of rep.alertDiagnostics) {
      byVerdict[d.verdict]++;
      list.push(`${name} ${d.verdict} ${d.event ?? ''} ${d.name ?? ''}`);
    }
  }
  console.log(`gallery alert verdicts ${JSON.stringify(byVerdict)}\n${list.join('\n')}`);
  assert.equal(byVerdict.disallowed, 0, list.filter((l) => l.includes('disallowed')).join('\n'));
});

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

test('a for-each-record function reads bare form fields and ID from rec', async () => {
  const fn: FunctionDef = {
    name: 'vote',
    kind: 'creator',
    form: 'Idea',
    properties: [{ key: 'execution type', value: 'for each record', span: Z }],
    deluge: [{ text: 'thisapp.Vote.vote(ID);\nreturn Title + ":" + ID;', span: Z }],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Idea', [plainField('Title')])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/vote.mjs');
  assert.ok(custom);
  assert.match(stripComments(custom.source), /shim\.record\.get\(d_rec, "ID"\)/);
  assert.match(stripComments(custom.source), /shim\.record\.get\(d_rec, "Title"\)/);
  assert.doesNotMatch(stripComments(custom.source), /\(ID\)|\+ ID\b/);
  check(custom.source, 'vote.mjs');
  const mod = (await loadTree(g, 'functions/custom/vote.mjs')) as Record<string, (ctx: unknown) => Promise<unknown>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({ record: {}, row: { __row: true, form: 'Idea', values: { ID: '42', Title: 'T' } } });
  assert.equal(await mod.vote!(ctx), 'T:42');
});

test('a for-each-record client twin binds ctx.record', async () => {
  const fn: FunctionDef = {
    name: 'approveTask',
    kind: 'creator',
    form: 'Tasks',
    properties: [{ key: 'execution type', value: 'for each record', span: Z }],
    deluge: [{ text: 'if (Audit_Require == false) { input.Status = "Closed"; } else { input.Status = "Approved"; }', span: Z }],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Tasks', [plainField('Audit_Require'), plainField('Status')])], functions: [fn] }));
  const client = g.files.find((f) => f.path === 'client/handlers/functions/approvetask.mjs');
  assert.ok(client);
  assert.match(stripComments(client.source), /const d_rec = ctx\.record;/);
  check(client.source, 'approveTask-client.mjs');
  const mod = (await loadModule(client.source, 'approveTask-client.mjs')) as unknown as Record<
    string,
    (ctx: unknown) => Promise<unknown>
  >;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const record: Record<string, unknown> = { Audit_Require: true };
  await mod.clientActions!(runtime.context({ record }));
  assert.equal(record.Status, 'Approved');
});

test('subform row events bind row on the server and the client and write through shim.record', async () => {
  const deluge = { text: 'if (row.Quantity != null) { row.Total = row.Price * row.Quantity; }', span: Z };
  const forms = [plainForm('BOM', [plainField('Parts', 'grid', ['Price', 'Quantity', 'Total'])])];
  const g = generate(
    app({
      forms,
      workflows: [
        workflow({ name: 'Qty', form: 'BOM', event: 'on user input of Parts.Quantity', deluge }),
        workflow({ name: 'Add', form: 'BOM', event: 'on add row of Parts', deluge }),
        workflow({ name: 'Plain', form: 'BOM', event: 'on user input of Parts', deluge: { text: 'x = 1;', span: Z } }),
      ],
    }),
  );
  for (const base of ['bom/on-user-input-of-parts-quantity', 'bom/on-add-row-of-parts']) {
    const server = g.files.find((f) => f.path === `functions/aio/${base}.mjs`);
    const client = g.files.find((f) => f.path === `client/handlers/${base}.mjs`);
    assert.ok(server, base);
    assert.ok(client, base);
    for (const src of [server.source, client.source]) {
      assert.match(stripComments(src), /const d_row = shim\.subform\.currentRow\(ctx, "Parts"\);/);
      assert.match(stripComments(src), /shim\.record\.set\(d_row, \["Total"\], /);
      assert.doesNotMatch(stripComments(src), /\brow\.Quantity\b/);
    }
    assert.match(stripComments(server.source), /subformRow: requestSubformRow\(req, "Parts", accepted\)/);
    check(server.source, 'aio.mjs');
    check(client.source, 'client.mjs');
  }
  const plain = g.files.find((f) => f.path === 'functions/aio/bom/on-user-input-of-parts.mjs');
  assert.ok(plain);
  assert.doesNotMatch(stripComments(plain.source), /currentRow|requestSubformRow/);
  const client = g.files.find((f) => f.path === 'client/handlers/bom/on-user-input-of-parts-quantity.mjs')!;
  const mod = (await loadModule(client.source, 'qty.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<unknown>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const record = { Parts: [{ Price: 2, Quantity: 3 }, { Price: 5, Quantity: 1 }] };
  await mod.clientActions!(runtime.context({ record, subformRow: { field: 'Parts', index: 1 } }));
  assert.deepEqual(record.Parts, [{ Price: 2, Quantity: 3 }, { Price: 5, Quantity: 1, Total: 5 }]);
  // No row named by the request: row is null, reads are null-safe and nothing is written.
  const bare = { Parts: [{ Price: 2, Quantity: 3 }] };
  await mod.clientActions!(runtime.context({ record: bare }));
  assert.deepEqual(bare.Parts, [{ Price: 2, Quantity: 3 }]);
});

test('a subform row event prefetch binds row from body.subformRow', async () => {
  const g = generate(
    app({
      forms: [plainForm('BOM', [plainField('Parts', 'grid', ['Course', 'Pct'])])],
      workflows: [
        workflow({
          name: 'Pct',
          form: 'BOM',
          event: 'on user input of Parts.Pct',
          deluge: { text: 'min = Rules[Course == row.Course].Min;\nif (row.Pct < min) { alert "low"; }', span: Z },
        }),
      ],
    }),
  );
  const pre = g.files.find((f) => f.path === 'functions/aio/bom/on-user-input-of-parts-pct-prefetch.mjs');
  assert.ok(pre);
  assert.match(stripComments(pre.source), /const d_row = shim\.subform\.currentRow\(ctx, "Parts"\);/);
  assert.match(stripComments(pre.source), /subformRow: requestSubformRow\(req, "Parts", record\)/);
  check(pre.source, 'pre.mjs');
  const mod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Rules: [{ ROWID: '1', Course: 'X', Min: 50 }] } });
  const record = { Parts: [{ Course: 'X', Pct: 40 }] };
  const slots = await mod.prefetch!(runtime.context({ record, subformRow: { field: 'Parts', index: 0 } }));
  assert.ok(Object.values(slots).includes(true));
});

test('a form-typed parameter reads and writes through shim.record: first record, null-safe', async () => {
  // <collection_variable>.<field_link_name> is the first record of the collection
  // (deluge-docs/pages/data-access__update-records.html).
  const fn: FunctionDef = {
    name: 'approve',
    kind: 'creator',
    form: 'Visa',
    signature: 'void CustomAction.approve(Visa visaDetails, string note)',
    properties: [],
    deluge: [{ text: 'if (visaDetails.Status == "Requested") { visaDetails.Status = "Approved"; }\nreturn visaDetails.Employee.Name;', span: Z }],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Visa', [plainField('Status'), plainField('Employee')])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/approve.mjs');
  assert.ok(custom);
  assert.match(stripComments(custom.source), /shim\.record\.get\(visaDetails, "Status"\)/);
  assert.match(stripComments(custom.source), /shim\.record\.set\(visaDetails, \["Status"\], "Approved"\)/);
  assert.match(stripComments(custom.source), /shim\.record\.get\(visaDetails, "Employee", "Name"\)/);
  assert.doesNotMatch(stripComments(custom.source), /visaDetails\.Status/);
  check(custom.source, 'approve.mjs');
  const mod = (await loadModule(custom.source, 'approve.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({ record: {} });
  // A null record: reads are null, the write has no record to update, nothing throws.
  assert.equal(await mod.approve!(ctx, null, 'n'), null);
  const first = { Status: 'Requested', Employee: { Name: 'Ada' } };
  const second = { Status: 'Requested', Employee: { Name: 'Bea' } };
  assert.equal(await mod.approve!(ctx, [first, second], 'n'), 'Ada');
  assert.equal(first.Status, 'Approved');
  assert.equal(second.Status, 'Requested');
  assert.equal(await mod.approve!(ctx, [], 'n'), null);
});

test('a collection-of-records function names its selected records by the form and reads bare fields from the first', async () => {
  const fn: FunctionDef = {
    name: 'Approve2',
    kind: 'creator',
    form: 'Visa',
    properties: [{ key: 'execution type', value: 'collection of records', span: Z }],
    deluge: [{ text: 'thisapp.CustomAction.approve(Visa);\nVisa.Status = "Seen";\nreturn Status + ":" + ID;', span: Z }],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Visa', [plainField('Status')])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/approve2.mjs');
  assert.ok(custom);
  assert.match(stripComments(custom.source), /const d_recs = ctx\.row;/);
  assert.match(stripComments(custom.source), /\["CustomAction","approve"\], \[d_recs\]/);
  assert.match(stripComments(custom.source), /shim\.record\.set\(d_recs, \["Status"\], "Seen"\)/);
  assert.match(stripComments(custom.source), /shim\.record\.get\(d_recs, "ID"\)/);
  assert.match(stripComments(custom.source), /collection of records/);
  assert.doesNotMatch(stripComments(custom.source), /\[Visa\]|\bID\)|\+ ID\b/);
  check(custom.source, 'approve2.mjs');
  const mod = (await loadModule(custom.source, 'approve2.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<unknown>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const rows = [{ ID: '7', Status: 'Open' }, { ID: '8', Status: 'Open' }];
  const ctx = runtime.context({ record: {}, row: rows as never });
  assert.equal(await mod.Approve2!(ctx), 'Seen:7');
  assert.equal(rows[1]!.Status, 'Open');
});

test('generator-owned identifiers are reserved: Deluge params named like them become d_*', () => {
  // A Deluge parameter named like a generated local collided with the emitted
  // `const`/`ctx` and produced "SyntaxError: Identifier 'shim' has already been
  // declared" in the prefetch and client modules. All of them rename to d_*.
  const fn: FunctionDef = {
    name: 'Clash',
    kind: 'creator',
    form: 'Orders',
    signature:
      'void Clash(string ctx, string shim, string slots, string actions, string prefetched, string record, string principal, string runtime, string rec, string recs, string row)',
    properties: [],
    deluge: [
      {
        text: 'y = Orders[Code == shim].ID;\nif (Orders[Code == slots].count() > 0) { info actions + prefetched + record + principal + runtime + rec + recs + row + ctx; }',
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Orders', [plainField('Code')])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/clash.mjs');
  const prefetch = g.files.find((f) => f.path === 'functions/custom/clash-prefetch.mjs');
  const client = g.files.find((f) => f.path === 'client/handlers/functions/clash.mjs');
  assert.ok(custom && prefetch && client);
  const renamed = 'd_ctx, d_shim, d_slots, d_actions, d_prefetched, d_record, d_principal, d_runtime, d_rec, d_recs, d_row';
  assert.match(stripComments(custom.source), new RegExp(`Clash\\(ctx, ${renamed}\\)`));
  assert.match(stripComments(prefetch.source), new RegExp(`var \\[${renamed}\\]`));
  assert.match(stripComments(client.source), new RegExp(`clientActions\\(ctx, ${renamed}\\)`));
  for (const file of g.files.filter((f) => f.path.endsWith('.mjs'))) {
    check(file.source, file.path.replace(/[^\w.]+/g, '_') || 'clash.mjs');
  }
});

test('loop variables and locals named like generated bindings rename, so every module parses', () => {
  const fn: FunctionDef = {
    name: 'LoopClash',
    kind: 'creator',
    signature: 'void LoopClash()',
    properties: [],
    deluge: [
      {
        text: [
          'for each actions in "a,b".toList(",") { info actions; }',
          'for each slots in "a,b".toList(",") { info slots; }',
          'for each shim in "a,b".toList(",") { info shim; }',
          'for each index i ctx in "a,b".toList(",") { info ctx; }',
          'record = "r";',
          'principal = "p";',
          'runtime = "t";',
          'prefetched = "s";',
          'slots = list();',
          'slots.add("s2");',
        ].join('\n'),
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('F', [])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/loopclash.mjs');
  const client = g.files.find((f) => f.path === 'client/handlers/functions/loopclash.mjs');
  assert.ok(custom && client);
  assert.match(stripComments(client.source), /for \(var d_actions of shim\.each/);
  assert.match(stripComments(client.source), /for \(var d_slots of shim\.each/);
  assert.match(stripComments(client.source), /for \(var d_shim of shim\.each/);
  assert.match(stripComments(client.source), /for \(var \[i, d_ctx\] of shim\.each/);
  assert.match(stripComments(custom.source), /var d_record = "r";/);
  assert.match(stripComments(custom.source), /var d_principal = "p";/);
  assert.match(stripComments(custom.source), /var d_runtime = "t";/);
  assert.match(stripComments(custom.source), /var d_prefetched = "s";/);
  // A plain local named `slots` renames too: the generated prefetch binding is
  // also `slots`, and a bare local collided with it (public-corpus Kimbo:
  // "Identifier 'slots' has already been declared" in the prefetch modules).
  assert.match(stripComments(custom.source), /var d_slots = \[\];/);
  assert.match(stripComments(custom.source), /shim\.list\.add\(d_slots, "s2"\)/);
  for (const file of g.files.filter((f) => f.path.endsWith('.mjs'))) {
    check(file.source, file.path.replace(/[^\w.]+/g, '_') || 'loop.mjs');
  }
});

test('a for-each loop variable named row does not collide with the subform row binding', () => {
  // `for each index i row` emits `var [i, d_row]` — the binding check must see
  // through the destructured pair, not only a bare `var row`.
  const g = generate(
    app({
      forms: [plainForm('BOM', [plainField('Parts', 'grid', ['Quantity', 'Total'])])],
      workflows: [
        workflow({
          name: 'Qty',
          form: 'BOM',
          event: 'on user input of Parts.Quantity',
          deluge: { text: 'for each index i row in "a,b".toList(",") { x = row; }', span: Z },
        }),
      ],
    }),
  );
  const server = g.files.find((f) => f.path === 'functions/aio/bom/on-user-input-of-parts-quantity.mjs');
  const client = g.files.find((f) => f.path === 'client/handlers/bom/on-user-input-of-parts-quantity.mjs');
  assert.ok(server && client);
  for (const src of [server.source, client.source]) check(src, 'subform-clash.mjs');
});

test('a for-each-record function parameter named rec does not collide with the row binding', () => {
  const fn: FunctionDef = {
    name: 'SumRec',
    kind: 'creator',
    form: 'Orders',
    signature: 'string SumRec(string rec)',
    properties: [{ key: 'execution type', value: 'for each record', span: Z }],
    deluge: [{ text: 'return rec;', span: Z }],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Orders', [])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/sumrec.mjs');
  assert.ok(custom);
  // `rec` is the row binding name; the parameter is d_rec and wins it.
  assert.match(stripComments(custom.source), /SumRec\(ctx, d_rec\)/);
  check(custom.source, 'sumrec.mjs');
});

test('a function prefetch applies the function gate: hidden form, then authorizeRead of the function form', async () => {
  // The same gate the custom route applies: isHidden(fn.form) → authenticated
  // profile → authorizeRead(fn.form). Before, the prefetch only required a
  // signed-in caller.
  const fn: FunctionDef = {
    name: 'Peek',
    kind: 'creator',
    signature: 'string Peek(Visa visaDetails)',
    form: 'SecretForm',
    properties: [],
    deluge: [{ text: 'if (SecretForm[Code == visaDetails.Status].count() > 0) { info "yes"; }\nreturn visaDetails.Status;', span: Z }],
    span: Z,
  };
  const g = generate(
    app({ forms: [plainForm('SecretForm', [plainField('Status'), plainField('Code')]), plainForm('Visa', [plainField('Status')])], functions: [fn] }),
  );
  const pre = g.files.find((f) => f.path === 'functions/custom/peek-prefetch.mjs');
  assert.ok(pre);
  assert.match(stripComments(pre.source), /export const formName = "SecretForm";/);
  assert.match(stripComments(pre.source), /if \(isHidden\(formName\)\)/);
  assert.match(stripComments(pre.source), /authorizeRead\(access, principal, formName, \{ op: "true" \}\)/);
  const hiddenAt = pre.source.indexOf('if (isHidden(formName))');
  const authAt = pre.source.indexOf('authorizeRead(access, principal, formName');
  const callAt = pre.source.indexOf('await prefetch(ctx)');
  assert.ok(hiddenAt >= 0 && hiddenAt < authAt && authAt < callAt);
  check(pre.source, 'peek-prefetch.mjs');
  const mod = await loadModule(pre.source, 'peek-prefetch.mjs');
  // No signed-in caller → 401; a caller whose profile cannot read the function's
  // form → 403 before any prefetch runs.
  const anon = await invoke(mod.default, { body: { args: [[{ Status: 'a' }]] } });
  assert.equal(anon.status, 401);
  const denied = await invoke(mod.default, { user: { profile: 'Staff' }, body: { args: [[{ Status: 'a' }]] } });
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(denied.body).includes('Status'), false);
});

test('for each over a form-typed parameter is a record loop: record.set and one flush', async () => {
  // "update every record" on a collection parameter
  // (deluge-docs/pages/data-access__update-records.html): v.Field = x is a
  // record write on each row, not a raw property assignment that loses the value.
  const fn: FunctionDef = {
    name: 'Touch',
    kind: 'creator',
    form: 'Visa',
    signature: 'void Touch(Visa visaDetails)',
    properties: [],
    deluge: [{ text: 'for each v in visaDetails { v.Status = "Touched"; }\nreturn visaDetails.Status;', span: Z }],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Visa', [plainField('Status')])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/touch.mjs');
  assert.ok(custom);
  assert.match(stripComments(custom.source), /for \(var v of shim\.each\(ctx, visaDetails\)\)/);
  assert.match(stripComments(custom.source), /shim\.record\.set\(v, \["Status"\], "Touched"\)/);
  assert.match(stripComments(custom.source), /await shim\.datastore\.flush\(ctx\)/);
  assert.doesNotMatch(stripComments(custom.source), /v\.Status = "Touched"|v\["Status"\] = "Touched"/);
  check(custom.source, 'touch.mjs');
  const mod = (await loadModule(custom.source, 'touch.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const rows = [{ Status: 'a' }, { Status: 'b' }];
  const ctx = runtime.context({ record: {} });
  assert.equal(await mod.Touch!(ctx, rows), 'Touched');
  assert.deepEqual(rows, [{ Status: 'Touched' }, { Status: 'Touched' }]);
});

test('for each over the selected records — by binding or form name — is a record loop, and Form.count() counts the selection', async () => {
  const fn: FunctionDef = {
    name: 'Approve',
    kind: 'creator',
    form: 'Visa',
    properties: [{ key: 'execution type', value: 'collection of records', span: Z }],
    deluge: [
      {
        text: 'for each v in Visa { v.Status = "Seen"; }\nfor each w in recs { w.Status = "Done"; }\nreturn Visa.count();',
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Visa', [plainField('Status')])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/approve.mjs');
  assert.ok(custom);
  assert.match(stripComments(custom.source), /for \(var v of shim\.each\(ctx, d_recs\)\)/);
  assert.match(stripComments(custom.source), /shim\.record\.set\(v, \["Status"\], "Seen"\)/);
  assert.match(stripComments(custom.source), /for \(var w of shim\.each\(ctx, d_recs\)\)/);
  assert.match(stripComments(custom.source), /shim\.record\.set\(w, \["Status"\], "Done"\)/);
  // The selection's count — not a whole-table datastore.aggregate over Visa.
  assert.match(stripComments(custom.source), /\(d_recs \? \(Array\.isArray\(d_recs\) \? d_recs\.length : 1\) : 0\)/);
  assert.doesNotMatch(stripComments(custom.source), /datastore\.aggregate/);
  check(custom.source, 'approve.mjs');
  const mod = (await loadModule(custom.source, 'approve.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<unknown>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const rows = [{ Status: 'a' }, { Status: 'b' }, { Status: 'c' }];
  const ctx = runtime.context({ record: {}, row: rows as never });
  assert.equal(await mod.Approve!(ctx), 3);
  assert.deepEqual(rows.map((row) => row.Status), ['Done', 'Done', 'Done']);
});

test('a client function handler binds its declared parameters and sends them with its prefetch', async () => {
  const fn: FunctionDef = {
    name: 'OpenForm.Review',
    kind: 'creator',
    signature: 'void OpenForm.Review(int recID)',
    properties: [],
    deluge: [{ text: 'openUrl("#Form:Add_Review?recID=" + recID, "popup window");', span: Z }],
    span: Z,
  };
  const reads: FunctionDef = {
    name: 'Check',
    kind: 'creator',
    signature: 'void Check(int recID)',
    properties: [],
    deluge: [{ text: 'if (Orders[Code == recID].count() > 0) { openUrl("#Report:Orders", "same window"); }', span: Z }],
    span: Z,
  };
  const g = generate(app({ functions: [fn, reads] }));
  const client = g.files.find((f) => f.path === 'client/handlers/functions/openform-review.mjs');
  assert.ok(client);
  assert.match(stripComments(client.source), /export async function clientActions\(ctx, recID\)/);
  assert.match(stripComments(client.source), /Signature \(verbatim\): void OpenForm\.Review\(int recID\)/);
  check(client.source, 'review.mjs');
  const mod = (await loadModule(client.source, 'review.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const actions = (await mod.clientActions!(runtime.context({ record: {} }), 42)) as { args: unknown[] }[];
  assert.equal(actions[0]!.args[0], '#Form:Add_Review?recID=42');

  const checkClient = g.files.find((f) => f.path === 'client/handlers/functions/check.mjs')!;
  const checkPre = g.files.find((f) => f.path === 'functions/custom/check-prefetch.mjs')!;
  assert.ok(checkClient && checkPre);
  assert.match(stripComments(checkClient.source), /ctx\.args = \[recID\];/);
  assert.match(stripComments(checkPre.source), /var \[recID\] = Array\.isArray\(ctx\.args\) \? ctx\.args : \[\];/);
  assert.match(stripComments(checkPre.source), /args: requestArgs\(req, 1\),/);
  check(checkPre.source, 'pre.mjs');
  const pre = (await loadModule(checkPre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const cmod = (await loadModule(checkClient.source, 'check.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Orders: [{ ROWID: '1', Code: '5' }] },
    clientPrefetch: async (_path, nonce, request) => ({ nonce, slots: await pre.prefetch!(seeded.context({ record: {}, args: request?.args })) }),
  });
  const hit = (await cmod.clientActions!(seeded.context({ record: {} }), '5')) as { op: string }[];
  assert.deepEqual(hit.map((a) => a.op), ['openUrl']);
  const miss = (await cmod.clientActions!(seeded.context({ record: {} }), '6')) as { op: string }[];
  assert.deepEqual(miss, []);
});

test('body.args are untrusted: plain JSON per parameter, never a forged row, query or binding', async () => {
  // Same discipline as requestSubformRow: the client names values, the server decides what they are.
  const reads: FunctionDef = {
    name: 'Check',
    kind: 'creator',
    signature: 'void Check(int recID, string note)',
    properties: [],
    deluge: [{ text: 'if (Orders[Code == recID].count() > 0) { openUrl("#Report:Orders", "same window"); }', span: Z }],
    span: Z,
  };
  const record: FunctionDef = {
    name: 'Peek',
    kind: 'creator',
    signature: 'string Peek(Visa visaDetails)',
    properties: [],
    deluge: [{ text: 'return visaDetails.Status;', span: Z }],
    span: Z,
  };
  // Peek is published by an admin-scoped `api` block, so it has an HTTP route (an
  // unpublished custom function has none); the Administrator gate runs first.
  const g = generate(
    app({
      forms: [plainForm('Visa', [plainField('Status')])],
      functions: [reads, record],
      profiles: [ADMIN],
      apis: [apiBlock('Peek_Api', 'r = thisapp.Peek(null)', [{ key: 'scope', value: '"Admin only"' }])],
    }),
  );
  const pre = g.files.find((f) => f.path === 'functions/custom/check-prefetch.mjs')!;
  const peek = g.files.find((f) => f.path === 'functions/custom/peek.mjs')!;
  assert.ok(pre && peek);
  assert.match(stripComments(pre.source), /args: requestArgs\(req, 2\),/);
  assert.match(stripComments(peek.source), /argsList = requestArgs\(req, 1\);[\s\S]*Peek\(ctx, \.\.\.argsList\)/);
  assert.doesNotMatch(stripComments(`${pre.source}\n${peek.source}`), /req\.body\.args|req\?\.body\?\.args/);
  const helper = /function plainJsonArg\([\s\S]*?function requestArgs\([\s\S]*?\n}\n/.exec(pre.source)![0];
  // A request body is JSON parsed in the handler's own realm.
  const realm = vm.createContext({});
  const requestArgs = vm.runInContext(`${helper} requestArgs`, realm) as (req: unknown, count: number) => unknown[];
  const parse = vm.runInContext('JSON.parse', realm) as (text: string) => unknown;
  const args = (body: unknown, count = 2) => JSON.stringify(requestArgs({ body: parse(JSON.stringify(body)) }, count));
  assert.equal(args({ args: [5, 'x'] }), '[5,"x"]');
  // One per declared parameter: extras are dropped, missing ones are null.
  assert.equal(args({ args: [5, 'x', 'extra'] }), '[5,"x"]');
  assert.equal(args({ args: [5] }), '[5,null]');
  assert.equal(args({ args: 'nope' }), '[null,null]');
  assert.equal(args(null), '[null,null]');
  assert.equal(args({ args: [{ Status: 'ok', tags: ['a', 1, true, null] }] }, 1), '[{"Status":"ok","tags":["a",1,true,null]}]');
  // Runtime brands, at any depth, are not data the client may send.
  assert.equal(args({ args: [{ __row: true, form: 'Visa', values: { Status: 'Forged' } }] }, 1), '[null]');
  assert.equal(args({ args: [{ __query: true, form: 'Payroll', criteria: { op: 'true' } }] }, 1), '[null]');
  assert.equal(args({ args: [{ Code: { __bind: 'loginUser' } }] }, 1), '[null]');
  assert.equal(args({ args: [[{ __c2c: 'dry-run-record' }]] }, 1), '[null]');
  assert.equal(JSON.stringify(requestArgs({ body: parse('{"args":[{"__proto__":{"admin":true}}]}') }, 1)), '[null]');
  // Non-JSON values (a non-plain object, a non-finite number) and runaway nesting.
  assert.equal(JSON.stringify(requestArgs({ body: { args: [Number.NaN, new Date(0)] } }, 2)), '[null,null]');
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = [deep];
  assert.equal(args({ args: [deep] }, 1), '[null]');
  // "deeper than 16 is null": 16 nested containers pass, the 17th rejects.
  let edge: unknown = 'x';
  for (let i = 0; i < 16; i++) edge = [edge];
  assert.equal(args({ args: [edge] }, 1), JSON.stringify([edge]));
  assert.equal(args({ args: [[edge]] }, 1), '[null]');

  // End to end: a form-typed parameter cannot be handed a forged fetched row.
  check(peek.source, 'peek.mjs');
  const mod = await loadModule(peek.source, 'peek.mjs');
  const caller = { user: { profile: 'Administrator', email: 'a@example.com' } };
  const forged = await invoke(mod.default, { ...caller, body: { args: [{ __row: true, form: 'Visa', values: { Status: 'Forged' } }] } });
  assert.equal(forged.status, 200);
  assert.equal(forged.body.result, null);
  assert.equal(JSON.stringify(forged.body).includes('Forged'), false);
  const plain = await invoke(mod.default, { ...caller, body: { args: [{ Status: 'Client' }] } });
  assert.equal(plain.body.result, 'Client');
});

test('approver.submitter in an approval script emits the submitter read, other approver.<x> emit todo', async () => {
  const g = generate(
    app({
      forms: [
        plainForm('Orders', [])
      ],
      workflows: [
        workflow({
          name: 'Order_Approval',
          form: 'Orders',
          event: 'on level 1 / on approve',
          type: 'approval',
          deluge: { text: 'if (approver.submitter == "userA") { sendmail [ from: zoho.adminuserid to: approver.submitter subject: "Approved" message: "ok" ]; } else { approver.manager; }', span: Z },
        }),
      ],
    }),
  );
  const flow = g.files.filter((f) => f.path.startsWith('functions/flow/') && f.path.endsWith('.mjs'));
  assert.ok(flow.length);
  for (const f of flow) {
    assert.match(stripComments(f.source), /\(ctx\.approver\?\.submitter \?\? null\)/, f.path);
    check(f.source, 'flow.mjs');
  }
  assert.ok(flow.some((f) => f.source.includes('shim.todo(ctx, "approval-approver")')));
  assert.ok(g.todos.some((t) => t.construct === 'approval-approver'));
});

test('approver.submitter reads the newest submit history row for the record', async () => {
  const g = generate(
    app({
      forms: [plainForm('Orders', [])],
      profiles: [
        { name: 'Read', type: 'Users_Permissions', properties: [], modules: [], span: Z },
      ],
      workflows: [
        workflow({
          name: 'Order_Approval',
          form: 'Orders',
          event: 'on level 1 / on approve',
          type: 'approval',
          deluge: { text: 'return approver.submitter;', span: Z },
        }),
      ],
    }),
  );
  const flowFile = g.files.find((f) => f.path === 'functions/flow/order-approval.mjs');
  assert.ok(flowFile);
  const mod = (await loadModule(flowFile.source, 'flow.mjs')) as Record<string, any>;
  const historyTable = mod.machine.historyTable as string;
  assert.ok(historyTable);
  const historyRow = (rowid: string, recordId: string, actor: string, from = '') => ({
    ROWID: rowid,
    Machine: 'Order_Approval',
    Form: 'Orders',
    Record_ID: recordId,
    Action: 'submit',
    Name: '',
    From_Status: from,
    To_Status: 'Pending',
    Actor: actor,
  });
  const store = mockDatastore({});
  store.tables.set('Orders', [
    { ROWID: '123', Status: 'Pending' },
    { ROWID: '124', Status: 'Pending' },
  ]);
  // Two records, two submitters; record 123 also has an older submit row from
  // before a rejection, so the resubmission (higher ROWID) is the submitter.
  store.tables.set(historyTable, [
    historyRow('10', '123', 'first_user'),
    historyRow('11', '124', 'second_user'),
    historyRow('12', '123', 'resub_user', 'Rejected'),
  ]);
  const caller = (rowid: string) => ({
    // The caller's profile can read Orders but has no grant on the generated
    // history table: the machine's own history read is what fills submitter.
    user: { profile: 'Read', loginUser: 'approver1' },
    url: '/flows/Order_Approval/approve',
    body: { ROWID: rowid },
  });
  const globalStore = globalThis as { __c2cDatastore?: unknown };
  const realMode = process.env.C2C_DEPLOY_MODE;
  const realZone = process.env.C2C_APP_TIMEZONE;
  process.env.C2C_DEPLOY_MODE = 'live';
  process.env.C2C_APP_TIMEZONE = 'UTC';
  try {
    globalStore.__c2cDatastore = store.datastore;
    const resub = await invoke(mod.approve, caller('123'));
    assert.equal(resub.status, 200, JSON.stringify(resub.body));
    assert.equal(resub.body.result, 'resub_user');
    const other = await invoke(mod.approve, caller('124'));
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.result, 'second_user');

    // No submit row for the record: submitter is null, not an error.
    store.tables.get('Orders')!.push({ ROWID: '125', Status: 'Pending' });
    const none = await invoke(mod.approve, caller('125'));
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.equal(none.body.result, null);

    // A missing history table reads as no history; any other store error fails.
    const boom = new Error('store unavailable');
    const missing = {
      ...store.datastore,
      async query(form: string, where: string, limit: number, offset?: number, orderBy?: string) {
        if (form === historyTable) {
          const err = new Error(`Data Store query failed: table ${form} does not exist`) as Error & { statusCode?: number };
          err.statusCode = 404;
          throw err;
        }
        return store.datastore.query(form, where, limit, offset, orderBy);
      },
    };
    const broken = {
      ...store.datastore,
      async query(form: string, where: string, limit: number, offset?: number, orderBy?: string) {
        if (form === historyTable) throw boom;
        return store.datastore.query(form, where, limit, offset, orderBy);
      },
    };
    // A missing table and a failing read are checked on records that still
    // sit at the start stage (an earlier approve moved their stage on).
    store.tables.get('Orders')!.push({ ROWID: '126', Status: 'Pending' }, { ROWID: '127', Status: 'Pending' });
    store.tables.get(historyTable)!.push(historyRow('13', '126', 'pending_user'), historyRow('14', '127', 'pending_user'));
    globalStore.__c2cDatastore = missing;
    const noTable = await invoke(mod.approve, caller('126'));
    assert.equal(noTable.status, 200, JSON.stringify(noTable.body));
    assert.equal(noTable.body.result, null);
    globalStore.__c2cDatastore = broken;
    const failed = await invoke(mod.approve, caller('127'));
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
  } finally {
    delete globalStore.__c2cDatastore;
    if (realMode === undefined) delete process.env.C2C_DEPLOY_MODE;
    else process.env.C2C_DEPLOY_MODE = realMode;
    if (realZone === undefined) delete process.env.C2C_APP_TIMEZONE;
    else process.env.C2C_APP_TIMEZONE = realZone;
  }
});

test('a reserved-word parameter and a reassigned for-each variable still parse', () => {
  const fn: FunctionDef = {
    name: 'indexCalculation',
    kind: 'creator',
    signature: 'int indexCalculation(string var)',
    properties: [],
    deluge: [{ text: 'n = 0;\nfor each text in var.toList(",") { text = text.trim(); if (text != "") { n = n + 1; } }\nreturn n;', span: Z }],
    span: Z,
  };
  const g = generate(app({ functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/indexcalculation.mjs');
  assert.ok(custom);
  assert.match(stripComments(custom.source), /export async function indexCalculation\(ctx, d_var\)/);
  assert.match(stripComments(custom.source), /for \(var text of shim\.each\(/);
  check(custom.source, 'index.mjs');
});

test('a for-each-record function names its current record by the form', async () => {
  const fn: FunctionDef = {
    name: 'Cancel',
    kind: 'creator',
    form: 'Application',
    properties: [{ key: 'execution type', value: 'for each record', span: Z }],
    deluge: [{ text: 'thisapp.Application.Cancel(Application);\nreturn Application.Status;', span: Z }],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Application', [plainField('Status')])], functions: [fn] }));
  const custom = g.files.find((f) => f.path === 'functions/custom/cancel.mjs');
  assert.ok(custom);
  assert.match(stripComments(custom.source), /\["Application","Cancel"\], \[d_rec\]/);
  assert.match(stripComments(custom.source), /return shim\.record\.get\(d_rec, "Status"\);/);
  check(custom.source, 'cancel.mjs');
  const mod = (await loadModule(custom.source, 'cancel.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<unknown>>;
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC' });
  const ctx = runtime.context({ record: {}, row: { __row: true, form: 'Application', values: { ID: '1', Status: 'Open' } } });
  assert.equal(await mod.Cancel!(ctx), 'Open');
});

test('migration-report.json carries the deterministic flag, todoCount and fillLockEntries', async () => {
  const { acceptTodo, collectTasks, readLock } = await import('../src/fill-todos.js');
  type Flag = { deterministic: boolean; todoCount: number; fillLockEntries: number; untranslated: { construct: string; count: number }[] };
  const flagOf = (g: ReturnType<typeof generate>) => JSON.parse(g.files.find((f) => f.path === 'migration-report.json')!.source) as Flag;
  const text = 'x = subBusinessDay(Calendar,0).getDay();';
  const dirty = app({ workflows: [workflow({ name: 'On add', form: 'Orders', event: 'on success', deluge: { text, span: { start: 0, end: text.length } } })] });
  const clean = flagOf(generate(app({})));
  assert.deepEqual([clean.deterministic, clean.todoCount, clean.fillLockEntries], [true, 0, 0]);
  const plain = flagOf(generate(dirty));
  assert.equal(plain.deterministic, false);
  assert.equal(plain.todoCount, plain.untranslated.reduce((sum, kind) => sum + kind.count, 0));
  assert.ok(plain.todoCount > 0);
  assert.equal(plain.fillLockEntries, 0);
  const task = collectTasks(dirty).find((item) => item.role !== 'note');
  assert.ok(task);
  const dir = mkdtempSync(join(tmpdir(), 'c2c-flag-lock-'));
  try {
    const lockPath = join(dir, 'c2c.lock.json');
    await acceptTodo({ app: dirty, taskId: task.id, fill: 'shim.input.get(ctx, "A")', lockPath });
    const filled = flagOf(generate(dirty, { lock: readLock(lockPath), stale: [] }));
    assert.equal(filled.fillLockEntries, 1);
    assert.equal(filled.deterministic, false);
    assert.equal(filled.todoCount, plain.todoCount);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on add row is a subform form event: no record insert, no submit route, script runs without a write', () => {
  // Creator lists "Subform on add row" beside On Load and On User input, apart from
  // On Validate and On Success (deluge-docs/pages/miscellaneous__access-subform-fields.html).
  const forms = [plainForm('BOM', [plainField('Parts', 'grid', ['Price', 'Quantity', 'Total']), plainField('Name')])];
  const g = generate(
    app({
      forms,
      workflows: [
        workflow({ name: 'Add', form: 'BOM', event: 'on add row of Parts', deluge: { text: 'row.Total = 1;', span: Z } }),
        workflow({ name: 'Del', form: 'BOM', event: 'on delete row of Parts', deluge: { text: 'row.Total = 0;', span: Z } }),
        workflow({ name: 'Save', form: 'BOM', recordEvent: 'on add', event: 'on success', deluge: { text: 'x = input.Name;', span: Z } }),
      ],
    }),
  );
  const src = (path: string) => g.files.find((f) => f.path === path)?.source ?? '';
  const addRow = src('functions/aio/bom/on-add-row-of-parts.mjs');
  assert.ok(addRow);
  assert.doesNotMatch(stripComments(addRow), /writeLive|shim\.record\.stamp\(ctx, "insert"\)|record\.prepare/);
  assert.match(stripComments(addRow), /path: "\/forms\/BOM\/addrow"/);
  assert.match(stripComments(src('functions/aio/bom/on-delete-row-of-parts.mjs')), /path: "\/forms\/BOM\/deleterow"/);
  // The record's own save still inserts; no row event takes a record route (/submit, /delete).
  assert.match(stripComments(src('functions/aio/bom/on-success.mjs')), /writeLive/);
  const routes = g.files.filter((f) => f.path.startsWith('functions/aio/bom/')).map((f) => /path: "([^"]+)"/.exec(f.source)?.[1]);
  assert.deepEqual(routes.filter((r) => r === '/forms/BOM/submit' || r === '/forms/BOM/delete'), []);
  // The client handler is not a submit or record-delete handler either.
  assert.match(stripComments(src('client/handlers/bom/on-add-row-of-parts.mjs')), /"when":"addrow"/);
  assert.match(stripComments(src('client/handlers/bom/on-delete-row-of-parts.mjs')), /"when":"deleterow"/);
});

test('requestSubformRow names only a row of this event subform in the screened record', async () => {
  const g = generate(
    app({
      forms: [plainForm('BOM', [plainField('Parts', 'grid', ['Quantity', 'Total']), plainField('Other', 'grid', ['Quantity'])])],
      workflows: [workflow({ name: 'Qty', form: 'BOM', event: 'on user input of Parts.Quantity', deluge: { text: 'row.Total = row.Quantity;', span: Z } })],
    }),
  );
  for (const path of ['functions/aio/bom/on-user-input-of-parts-quantity.mjs']) {
    const source = g.files.find((f) => f.path === path)!.source;
    assert.match(stripComments(source), /subformRow: requestSubformRow\(req, "Parts", accepted\)/);
    const helper = /function requestSubformRow\([\s\S]*?\n}\n/.exec(source)![0];
    const requestSubformRow = vm.runInNewContext(`(${helper})`) as (req: unknown, subform: string, record: unknown) => unknown;
    const record = { Parts: [{ Quantity: 1 }, { Quantity: 2 }], Other: [{ Quantity: 3 }, { Quantity: 4 }, { Quantity: 5 }] };
    const at = (field: unknown, index: unknown) => requestSubformRow({ body: { subformRow: { field, index } } }, 'Parts', record);
    assert.equal(JSON.stringify(at('Parts', 1)), '{"field":"Parts","index":1}');
    // Another subform of the same form is not this event's row.
    assert.equal(at('Other', 0), undefined);
    assert.equal(at('Other', 2), undefined);
    // An index that is not a row of the screened Parts array.
    assert.equal(at('Parts', 2), undefined);
    assert.equal(at('Parts', -1), undefined);
    assert.equal(requestSubformRow({ body: { subformRow: { field: 'Parts', index: 0 } } }, 'Parts', { Parts: ['x'] }), undefined);
    assert.equal(requestSubformRow({ body: { subformRow: { field: 'Parts', index: 0 } } }, 'Parts', {}), undefined);
  }
});

test('translation blocks are listed as explicit manual steps in migration-report warnings', () => {
  const g = generate(
    app({
      translations: [
        {
          json: '{"de":{"FormField.Orders.Title":" Titel ","ReportField.Orders.Status":" Status "}}',
          data: { de: { 'FormField.Orders.Title': ' Titel ', 'ReportField.Orders.Status': ' Status ' } },
          span: Z,
        },
      ],
    }),
  );
  const warnings = JSON.parse(g.files.find((file) => file.path === 'migration-report.json')!.source).warnings as {
    construct: string;
    name: string;
    note: string;
  }[];
  const rows = (warnings ?? []).filter((w) => w.construct === 'translation-not-migrated');
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.name, /de/);
  assert.match(rows[0]!.note, /2 strings/);
  assert.match(rows[0]!.note, /default-language/);
});

test('a submit claim is per machine: two machines on one form write one submit history row', async () => {
  const machine = (name: string) =>
    workflow({
      name,
      container: 'approval',
      form: 'Request',
      event: 'on approve',
      approvers: [{ key: 'level', value: '1', span: Z }],
      deluge: { text: 'x = 1;', span: Z },
    });
  const submit = async (machines: string[]) => {
    const g = generate(
      app({ forms: [{ name: 'Request', properties: [], fields: [], actions: [], blocks: [], span: Z }], workflows: machines.map(machine) }),
    );
    const flows = g.files.filter((f) => f.path.startsWith('functions/flow/')).map((f) => f.path);
    assert.equal(flows.length, machines.length);
    const writes: { table: string; row: Record<string, unknown> }[] = [];
    const ctx = {
      record: {} as Record<string, unknown>,
      shim: {
        datastore: {
          insertRow: async (_ctx: unknown, table: string, row: Record<string, unknown>) => {
            writes.push({ table, row });
          },
        },
      },
    };
    type Flow = { begin(c: unknown): Promise<void>; commit(c: unknown): Promise<void> };
    const mods = (await Promise.all(flows.map((path) => loadTree(g, path)))) as unknown as Flow[];
    for (const mod of mods) await mod.begin(ctx);
    for (const mod of mods) await mod.commit(ctx);
    return writes;
  };
  const two = await submit(['Flow One', 'Flow Two']);
  assert.equal(two.length, 1, JSON.stringify(two));
  assert.equal(two[0]!.row.Action, 'submit');
  const one = await submit(['Flow One']);
  assert.equal(one.length, 1, JSON.stringify(one));
  assert.equal(one[0]!.row.Action, 'submit');
});

test('a non-record loop element round-trips per element through the prefetch endpoint', async () => {
  const fn: FunctionDef = {
    name: 'Check',
    kind: 'creator',
    signature: 'void Check(string recID)',
    properties: [],
    deluge: [
      {
        text: [
          'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
          '  if (Bookings[Room == room && Guest == input.Guest_Name].count() > 0) { openUrl("#Report:Bookings?room=" + room, "same window"); }',
          '}',
        ].join('\n'),
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(
    app({
      forms: [
        plainForm('Booking_Form', [plainField('Status'), plainField('Choose_Room')]),
        plainForm('Bookings', [plainField('Room'), plainField('Guest')]),
      ],
      functions: [fn],
      profiles: [ADMIN],
    }),
  );
  const pre = g.files.find((f) => f.path === 'functions/custom/check-prefetch.mjs')!;
  const client = g.files.find((f) => f.path === 'client/handlers/functions/check.mjs')!;
  assert.ok(pre && client);
  assert.match(stripComments(pre.source), /element: requestElement\(req\)/);
  assert.match(stripComments(pre.source), /function requestElement\(req\)/);
  assert.match(stripComments(pre.source), /if \(ctx\.element !== undefined && ctx\.element\.name === "room"\)/);
  assert.match(stripComments(client.source), /await shim\.client\.element\(ctx, "room", room, "c0"\)/);
  check(pre.source, 'pre.mjs');
  check(client.source, 'check.mjs');
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const cmod = (await loadModule(client.source, 'check.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const elementCalls: unknown[] = [];
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [
        { ROWID: '1', Status: 'Reserved', Choose_Room: 'A' },
        { ROWID: '2', Status: 'Reserved', Choose_Room: 'B' },
        { ROWID: '3', Status: 'Reserved', Choose_Room: 'C' },
        { ROWID: '4', Status: 'Cancelled', Choose_Room: 'D' },
      ],
      Bookings: [
        { ROWID: '9', Room: 'A', Guest: 'Gita' },
        { ROWID: '8', Room: 'C', Guest: 'Gita' },
        { ROWID: '7', Room: 'B', Guest: 'Ravi' },
      ],
    },
    clientPrefetch: async (_path, nonce, request) => {
      if (request?.element) elementCalls.push(request.element.value);
      return { nonce, slots: await preMod.prefetch!(seeded.context({ record: { Guest_Name: 'Gita' }, args: request?.args, element: request?.element })) };
    },
  });
  const actions = (await cmod.clientActions!(seeded.context({ record: { Guest_Name: 'Gita' } }), 'x')) as { op: string; args?: unknown[] }[];
  // One round trip per iterated element, in loop order; matching elements open their report in order.
  assert.deepEqual(elementCalls, ['A', 'B', 'C']);
  assert.deepEqual(
    actions.filter((a) => a.op === 'openUrl').map((a) => a.args![0]),
    ['#Report:Bookings?room=A', '#Report:Bookings?room=C'],
  );
});

test('per-element round trips stop at the cap and an empty collection makes none', async () => {
  const fn: FunctionDef = {
    name: 'Check',
    kind: 'creator',
    signature: 'void Check(string recID)',
    properties: [],
    deluge: [
      {
        text: [
          'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
          '  if (Bookings[Room == room].count() > 0) { openUrl("#Report:Bookings?room=" + room, "same window"); }',
          '}',
        ].join('\n'),
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Booking_Form', [plainField('Status'), plainField('Choose_Room')]), plainForm('Bookings', [plainField('Room')])], functions: [fn], profiles: [ADMIN] }));
  const pre = g.files.find((f) => f.path === 'functions/custom/check-prefetch.mjs')!;
  const client = g.files.find((f) => f.path === 'client/handlers/functions/check.mjs')!;
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const cmod = (await loadModule(client.source, 'check.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const rooms = Array.from({ length: 120 }, (_, i) => ({ ROWID: String(i + 1), Status: 'Reserved', Choose_Room: `R${i}` }));
  let calls = 0;
  const capped = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Booking_Form: rooms, Bookings: rooms.map((r, i) => ({ ROWID: String(500 + i), Room: r.Choose_Room })) },
    clientPrefetch: async (_path, nonce, request) => {
      if (request?.element) calls += 1;
      return { nonce, slots: await preMod.prefetch!(capped.context({ record: {}, args: request?.args, element: request?.element })) };
    },
  });
  const actions = (await cmod.clientActions!(capped.context({ record: {} }), 'x')) as { op: string }[];
  assert.equal(calls, 100);
  // Hitting the cap aborts the run: the 100 actions already queued are
  // discarded rather than partially applied.
  assert.equal(actions.filter((a) => a.op === 'openUrl').length, 0);
  assert.equal(actions.filter((a) => a.op === 'info').length, 1);
  const todos = capped.transcript.filter((n) => n.op === 'todo' && n.construct === 'client-condition-uses-server');
  assert.ok(todos.some((n) => String(n.detail).includes('element round-trip cap')));

  let emptyCalls = 0;
  const empty = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Booking_Form: [{ ROWID: '1', Status: 'Cancelled', Choose_Room: 'A' }] },
    clientPrefetch: async (_path, nonce, request) => {
      if (request?.element) emptyCalls += 1;
      return { nonce, slots: await preMod.prefetch!(empty.context({ record: {}, args: request?.args, element: request?.element })) };
    },
  });
  const noActions = (await cmod.clientActions!(empty.context({ record: {} }), 'x')) as { op: string }[];
  assert.equal(emptyCalls, 0);
  assert.deepEqual(noActions, []);
});

test('a refused per-element round trip shows nothing', async () => {
  const fn: FunctionDef = {
    name: 'Check',
    kind: 'creator',
    signature: 'void Check(string recID)',
    properties: [],
    deluge: [
      {
        text: [
          'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
          '  if (Bookings[Room == room].count() > 0) { openUrl("#Report:Bookings?room=" + room, "same window"); }',
          '}',
        ].join('\n'),
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(app({ forms: [plainForm('Booking_Form', [plainField('Status'), plainField('Choose_Room')]), plainForm('Bookings', [plainField('Room')])], functions: [fn], profiles: [ADMIN] }));
  const pre = g.files.find((f) => f.path === 'functions/custom/check-prefetch.mjs')!;
  const client = g.files.find((f) => f.path === 'client/handlers/functions/check.mjs')!;
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const cmod = (await loadModule(client.source, 'check.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const denied = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: { Booking_Form: [{ ROWID: '1', Status: 'Reserved', Choose_Room: 'A' }], Bookings: [{ ROWID: '2', Room: 'A' }] },
    clientPrefetch: async (_path, nonce, request) =>
      request?.element
        ? { ok: false, error: 'denied', nonce }
        : { nonce, slots: await preMod.prefetch!(denied.context({ record: {}, args: request?.args })) },
  });
  const actions = (await cmod.clientActions!(denied.context({ record: {} }), 'x')) as { op: string }[];
  assert.deepEqual(actions.filter((a) => a.op === 'openUrl'), []);
});

function elementLoopFixture(condition = 'if (Bookings[Room == room].count() > 0) { openUrl("#Report:Bookings?room=" + room, "same window"); }') {
  const fn: FunctionDef = {
    name: 'Check',
    kind: 'creator',
    signature: 'void Check(string recID)',
    properties: [],
    deluge: [
      {
        text: [
          'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
          `  ${condition}`,
          '}',
        ].join('\n'),
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(
    app({
      forms: [
        plainForm('Booking_Form', [plainField('Status'), plainField('Choose_Room')]),
        plainForm('Bookings', [plainField('Room'), plainField('Guest')]),
      ],
      functions: [fn],
      profiles: [ADMIN],
    }),
  );
  const pre = g.files.find((f) => f.path === 'functions/custom/check-prefetch.mjs')!;
  const client = g.files.find((f) => f.path === 'client/handlers/functions/check.mjs')!;
  assert.ok(pre && client);
  return { g, pre, client };
}

test('the prefetch endpoint refuses an element value outside the iterated collection or past the cap', async () => {
  const { pre } = elementLoopFixture();
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [
        { ROWID: '1', Status: 'Reserved', Choose_Room: 'A' },
        { ROWID: '2', Status: 'Reserved', Choose_Room: 'B' },
      ],
      Bookings: [{ ROWID: '9', Room: 'A', Guest: 'Gita' }],
    },
  });
  // A member evaluates its slot; a non-member is refused, nothing evaluated.
  const member = await preMod.prefetch!(seeded.context({ record: {}, element: { name: 'room', value: 'A' } }));
  assert.equal(member['c0'], true);
  await assert.rejects(
    preMod.prefetch!(seeded.context({ record: {}, element: { name: 'room', value: 'Z' } })),
    /not in the iterated collection or is past the element cap/,
  );
  // The cap is enforced server-side: an element whose position in the
  // collection is past the cap is refused even if the client keeps POSTing.
  const rooms = Array.from({ length: 120 }, (_, i) => ({ ROWID: String(i + 1), Status: 'Reserved', Choose_Room: `R${i}` }));
  const big = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Booking_Form: rooms, Bookings: [] } });
  const inCap = await preMod.prefetch!(big.context({ record: {}, element: { name: 'room', value: 'R99' } }));
  assert.ok('c0' in inCap);
  await assert.rejects(
    preMod.prefetch!(big.context({ record: {}, element: { name: 'room', value: 'R105' } })),
    /not in the iterated collection or is past the element cap/,
  );
});

test('element membership compares type-strictly against the stored collection', async () => {
  const { pre } = elementLoopFixture();
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  // A numeric collection: the number 1 is a member, the text "1" is not.
  const numeric = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [
        { ROWID: '1', Status: 'Reserved', Choose_Room: 1 },
        { ROWID: '2', Status: 'Reserved', Choose_Room: 2 },
      ],
      Bookings: [{ ROWID: '9', Room: 1 }],
    },
  });
  const member = await preMod.prefetch!(numeric.context({ record: {}, element: { name: 'room', value: 1 } }));
  assert.equal(member['c0'], true);
  await assert.rejects(
    preMod.prefetch!(numeric.context({ record: {}, element: { name: 'room', value: '1' } })),
    /not in the iterated collection or is past the element cap/,
  );
  // A text collection: "1" is a genuine member and evaluates.
  const text = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [
        { ROWID: '1', Status: 'Reserved', Choose_Room: '1' },
        { ROWID: '2', Status: 'Reserved', Choose_Room: '2' },
      ],
      Bookings: [{ ROWID: '9', Room: '1' }],
    },
  });
  const textMember = await preMod.prefetch!(text.context({ record: {}, element: { name: 'room', value: '1' } }));
  assert.equal(textMember['c0'], true);
});

test('a use-before-binding alias serves no truthy element slot on a direct prefetch', async () => {
  // `a = b` before `b = s` reads a name with no binding yet: the element
  // condition on `a` is refused, so the endpoint emits no element guard and
  // a direct element post cannot buy a truthy slot out of the alias.
  const fn: FunctionDef = {
    name: 'Check',
    kind: 'creator',
    signature: 'void Check(string recID)',
    properties: [],
    deluge: [
      {
        text: [
          's = sendmail [ to: input.Guest_Email, subject: "s", message: "m" ];',
          'a = b;',
          'b = s;',
          'if (b == Bookings[Guest == input.Guest_Name].Guest) { openUrl("#one", "same window"); }',
          'for each room in Booking_Form[Status == "Reserved"].Choose_Room.getAll() {',
          '  if (a && Bookings[Room == room].count() > 0) { openUrl("#x?room=" + room, "same window"); }',
          '}',
        ].join('\n'),
        span: Z,
      },
    ],
    span: Z,
  };
  const g = generate(
    app({
      forms: [
        plainForm('Booking_Form', [plainField('Status'), plainField('Choose_Room')]),
        plainForm('Bookings', [plainField('Room'), plainField('Guest')]),
      ],
      functions: [fn],
      profiles: [ADMIN],
    }),
  );
  const pre = g.files.find((f) => f.path === 'functions/custom/check-prefetch.mjs')!;
  const client = g.files.find((f) => f.path === 'client/handlers/functions/check.mjs')!;
  assert.ok(pre && client);
  assert.doesNotMatch(stripComments(pre.source), /ctx\.element/);
  assert.doesNotMatch(stripComments(client.source), /shim\.client\.element/);
  check(pre.source, 'pre.mjs');
  check(client.source, 'check.mjs');
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [
        { ROWID: '1', Status: 'Reserved', Choose_Room: 'A' },
        { ROWID: '2', Status: 'Reserved', Choose_Room: 'B' },
      ],
      Bookings: [{ ROWID: '9', Room: 'A', Guest: 'Gita' }],
    },
  });
  // A direct post of a real member returns no truthy slot.
  const member = await preMod.prefetch!(seeded.context({ record: { Guest_Name: 'Gita' }, element: { name: 'room', value: 'A' } }));
  assert.equal(Object.values(member).some((v) => v === true), false);
  // The mail call is a non-read. The prefetch must not replay it, not even as
  // a dry-run one-shot for the straight-line condition that reads the alias.
  assert.doesNotMatch(stripComments(pre.source), /mail\.send/);
  assert.equal(seeded.transcript.some((n) => n.op === 'sendmail'), false);
});

test('a refused element value mid-loop leaves no partial client actions', async () => {
  const { pre, client } = elementLoopFixture();
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const cmod = (await loadModule(client.source, 'check.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const calls: unknown[] = [];
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [
        { ROWID: '1', Status: 'Reserved', Choose_Room: 'A' },
        { ROWID: '2', Status: 'Reserved', Choose_Room: 'B' },
        { ROWID: '3', Status: 'Reserved', Choose_Room: 'C' },
      ],
      Bookings: [
        { ROWID: '9', Room: 'A', Guest: 'Gita' },
        { ROWID: '8', Room: 'B', Guest: 'Gita' },
        { ROWID: '7', Room: 'C', Guest: 'Gita' },
      ],
    },
    clientPrefetch: async (_path, nonce, request) => {
      if (request?.element) calls.push(request.element.value);
      return { nonce, slots: await preMod.prefetch!(seeded.context({ record: { Guest_Name: 'Gita' }, args: request?.args, element: request?.element })) };
    },
  });
  // The middle element's POST is denied; A already succeeded before it.
  const shimmed = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [
        { ROWID: '1', Status: 'Reserved', Choose_Room: 'A' },
        { ROWID: '2', Status: 'Reserved', Choose_Room: 'B' },
        { ROWID: '3', Status: 'Reserved', Choose_Room: 'C' },
      ],
      Bookings: [
        { ROWID: '9', Room: 'A', Guest: 'Gita' },
        { ROWID: '8', Room: 'B', Guest: 'Gita' },
        { ROWID: '7', Room: 'C', Guest: 'Gita' },
      ],
    },
    clientPrefetch: async (_path, nonce, request) => {
      if (request?.element?.value === 'B') return { ok: false, error: 'denied', nonce };
      return { nonce, slots: await preMod.prefetch!(shimmed.context({ record: { Guest_Name: 'Gita' }, args: request?.args, element: request?.element })) };
    },
  });
  const actions = (await cmod.clientActions!(shimmed.context({ record: { Guest_Name: 'Gita' } }), 'x')) as { op: string }[];
  // A's action was queued before B failed; the run discards it wholesale.
  assert.deepEqual(actions.filter((a) => a.op === 'openUrl'), []);
  assert.equal(actions.filter((a) => a.op === 'info').length, 1);
  const allOk = (await cmod.clientActions!(seeded.context({ record: { Guest_Name: 'Gita' } }), 'x')) as { op: string }[];
  assert.equal(allOk.filter((a) => a.op === 'openUrl').length, 3);
});

test('a stale nonce on a mid-loop element discards queued client actions', async () => {
  const { pre, client } = elementLoopFixture();
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const cmod = (await loadModule(client.source, 'check.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [
        { ROWID: '1', Status: 'Reserved', Choose_Room: 'A' },
        { ROWID: '2', Status: 'Reserved', Choose_Room: 'B' },
        { ROWID: '3', Status: 'Reserved', Choose_Room: 'C' },
      ],
      Bookings: [
        { ROWID: '9', Room: 'A', Guest: 'Gita' },
        { ROWID: '8', Room: 'B', Guest: 'Gita' },
        { ROWID: '7', Room: 'C', Guest: 'Gita' },
      ],
    },
    clientPrefetch: async (_path, nonce, request) => {
      if (request?.element?.value === 'B') return { nonce: 'other-nonce', slots: { c0: true } };
      return { nonce, slots: await preMod.prefetch!(seeded.context({ record: { Guest_Name: 'Gita' }, args: request?.args, element: request?.element })) };
    },
  });
  const actions = (await cmod.clientActions!(seeded.context({ record: { Guest_Name: 'Gita' } }), 'x')) as { op: string }[];
  assert.deepEqual(actions.filter((a) => a.op === 'openUrl'), []);
  assert.equal(actions.filter((a) => a.op === 'info').length, 1);
});

test('a dry-run placeholder element slot is never truthy to the client', async () => {
  const { pre, client } = elementLoopFixture();
  const preMod = (await loadModule(pre.source, 'pre.mjs')) as unknown as Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>;
  const cmod = (await loadModule(client.source, 'check.mjs')) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const seeded = createRuntime({
    dryRun: true,
    appTimeZone: 'UTC',
    seed: {
      Booking_Form: [{ ROWID: '1', Status: 'Reserved', Choose_Room: 'A' }],
      Bookings: [{ ROWID: '9', Room: 'A', Guest: 'Gita' }],
    },
    clientPrefetch: async (_path, nonce, request) => {
      if (request?.element) return { nonce, slots: { c0: { dryRun: true, performed: false, path: ['isAvailable'] } } };
      return { nonce, slots: await preMod.prefetch!(seeded.context({ record: { Guest_Name: 'Gita' }, args: request?.args })) };
    },
  });
  const actions = (await cmod.clientActions!(seeded.context({ record: { Guest_Name: 'Gita' } }), 'x')) as { op: string }[];
  assert.deepEqual(actions.filter((a) => a.op === 'openUrl'), []);
});

test('unconditional field rules become server write denials; conditional rules are a counted gap', () => {
  const ir = snippet(`\tform Shipment
\t{
\t\tSubmode
\t\t(
\t\t\ttype = picklist
\t\t)
\t\tVessel
\t\t(
\t\t\ttype = text
\t\t)
\t\tSecret
\t\t(
\t\t\ttype = text
\t\t)
\t\tLocked
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Shipment
\t\t\t\trecord event = on add
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\thide Secret;
\t\t\t\t\t\tdisable Locked;
\t\t\t\t\t}
\t\t\t\t\tactions (Submode == "Sea")
\t\t\t\t\t{
\t\t\t\t\t\tshow Vessel;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  // Static rules deny only the covered op: `on add` is insert, so an update
  // may still write them. The conditional rule is a counted fidelity gap.
  assert.deepEqual(fieldRuleDenials(ir, 'Shipment'), [
    { field: 'Locked', action: 'disable', ops: ['insert'] },
    { field: 'Secret', action: 'hide', ops: ['insert'] },
  ]);
  assert.equal(conditionalFieldRules(ir, 'Shipment'), 1);
});

test('fieldRuleDenials scopes by record event and lets a later static rule win', () => {
  const ir = app({
    forms: [plainForm('Item', [plainField('A'), plainField('B'), plainField('C')])],
    workflows: [
      workflow({
        name: 'add', form: 'Item', event: 'on load', recordEvent: 'on add',
        fieldRules: [{ actions: [{ action: 'hide', fields: ['A'] }, { action: 'disable', fields: ['B'] }], span: Z }],
      }),
      workflow({
        name: 'edit', form: 'Item', event: 'on load', recordEvent: 'on edit',
        fieldRules: [{ actions: [{ action: 'show', fields: ['A'] }, { action: 'hide', fields: ['C'] }], span: Z }],
      }),
    ],
  });
  // A is hidden on insert but shown on edit: the show is scoped to the edit
  // context and does not cancel the insert hide. B is insert-disabled; C is
  // update-hidden.
  assert.deepEqual(fieldRuleDenials(ir, 'Item'), [
    { field: 'A', action: 'hide', ops: ['insert'] },
    { field: 'B', action: 'disable', ops: ['insert'] },
    { field: 'C', action: 'hide', ops: ['update'] },
  ]);
});

test('an unscoped rule denies both ops; a conditional rule denies neither', () => {
  const ir = app({
    forms: [plainForm('Item', [plainField('A'), plainField('B'), plainField('C')])],
    workflows: [
      workflow({
        name: 'load', form: 'Item', event: 'on load',
        fieldRules: [
          { actions: [{ action: 'hide', fields: ['A'] }], span: Z },
          { condition: 'B == 1', actions: [{ action: 'hide', fields: ['C'] }], span: Z },
        ],
      }),
    ],
  });
  assert.deepEqual(fieldRuleDenials(ir, 'Item'), [{ field: 'A', action: 'hide' }]);
});

test('a workflow aio module embeds the form field-rule denials and passes them to authorizeWrite', () => {
  const ir = app({
    forms: [plainForm('Orders', [plainField('Status'), plainField('Secret')])],
    workflows: [
      workflow({
        name: 'Rules', form: 'Orders', event: 'on load', recordEvent: 'on add',
        fieldRules: [{ actions: [{ action: 'hide', fields: ['Secret'] }], span: Z }],
      }),
      workflow({
        name: 'On success', form: 'Orders', event: 'on success', recordEvent: 'on add or edit',
        deluge: { text: 'x = 1;', span: Z },
      }),
    ],
  });
  const g = generate(ir);
  const server = g.files.find((f) => f.path === 'functions/aio/orders/on-success.mjs');
  assert.ok(server);
  assert.match(server.source, /export const fieldRuleDenied = \[\{"field":"Secret","action":"hide","ops":\["insert"\]\}\];/);
  assert.match(server.source, /authorizeWrite\(access, principal, formName, record, \{ readonlyFields, fieldNames, fields, ruleDenied: fieldRuleDenied \}/);
});
