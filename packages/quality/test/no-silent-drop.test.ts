import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type App, type Field, type Workflow } from '../../core/src/index.js';
import { FORM_EVENT_SERVER_UNINVOKED, clientPostsServerPath } from '../../deluge/src/generate.js';
import { auditApp, collectOutputs, groupDrops, renderNoSilentDrop } from '../src/no-silent-drop.js';

const Z = { start: 0, end: 0 };

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

function field(name: string, type: string): Field {
  return { name, type, modifiers: [], required: false, unique: false, properties: [], subfields: [], annotations: [], flags: [], span: Z };
}

function app(partial: Partial<App>): App {
  return { ...emptyApp('empty'), name: 'Demo_App', ...partial };
}

function coveredApp(): App {
  return app({
    forms: [
      {
        name: 'Orders',
        properties: [],
        fields: [field('Title', 'text')],
        actions: [],
        blocks: [],
        span: Z,
      },
    ],
    reports: [
      {
        name: 'All_Orders',
        type: 'list',
        modifiers: [],
        form: 'Orders',
        flags: [],
        properties: [],
        columns: [{ field: 'Title', properties: [], subcolumns: [], span: Z }],
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
    pages: [{ name: 'Home', properties: [], zml: [], references: [], span: Z }],
    workflows: [
      workflow({ name: 'Stamp', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = 1;', span: Z } }),
      workflow({
        name: 'Daily',
        container: 'schedule',
        event: 'on schedule',
        properties: [
          { key: 'start', value: '"2017-01-03 09:30:00"', span: Z },
          { key: 'frequency', value: 'daily', span: Z },
        ],
      }),
      workflow({ name: 'Sale approval', container: 'approval', form: 'Orders', event: 'on approve' }),
      workflow({ name: 'Pay now', container: 'form', form: 'Orders', event: 'on load' }),
    ],
  });
}

test('a produced construct is never listed as a drop', () => {
  assert.deepEqual(auditApp(coveredApp()), []);
});

test('an unlisted translation fails until the manual step exists', () => {
  const withTranslation = app({
    ...coveredApp(),
    translations: [{ json: '{"de":{"FormField.Orders.Title":" Titel "}}', data: { de: { 'FormField.Orders.Title': ' Titel ' } }, span: Z }],
  });
  // The generator lists the manual step, so the audit passes.
  assert.deepEqual(auditApp(withTranslation), []);
  // Without the listing, the same construct fails.
  const unlisted = collectOutputs(withTranslation);
  unlisted.warnings = [];
  const drops = auditApp(withTranslation, unlisted);
  assert.equal(drops.length, 1);
  assert.equal(drops[0]!.kind, 'translation');
});

test('an unsurfaced integration call fails until the connections report lists it', () => {
  const sms = app({
    workflows: [workflow({ name: 'Notify', container: 'form', form: 'Orders', event: 'on success', deluge: { text: 'zoho.sms.send("template", "9876543210");', span: Z } })],
  });
  // The connections analysis lists the call as unsupported, so the audit passes.
  assert.deepEqual(auditApp(sms), []);
  // Without the listing, the same call fails.
  const unlisted = collectOutputs(sms);
  unlisted.connections = { entries: [], unsupported: [], urlDcs: [], diagnostics: [] };
  const drops = auditApp(sms, unlisted);
  assert.ok(drops.some((d) => d.kind === 'integration' && d.name.includes('zoho.sms.send')));
});

test('the integration audit enumerates calls the connections analysis could drop', () => {
  // An unadapted task and a connectionless invokeurl: the connections report
  // lists both, so the audit passes. If the report ever stopped listing one,
  // the audit's own walk of the script still flags it as a drop.
  const w = app({
    workflows: [
      workflow({
        name: 'Notify',
        container: 'form',
        form: 'Orders',
        event: 'on load',
        deluge: {
          text: 'zoho.foo.bar("x");\nresp = invokeurl [ url: "https://www.zohoapis.com/crm/v2/Leads" type: GET ];',
          span: Z,
        },
      }),
    ],
  });
  assert.deepEqual(
    auditApp(w).filter((d) => d.kind === 'integration'),
    [],
  );
  const unlisted = collectOutputs(w);
  unlisted.connections = { entries: [], unsupported: [], urlDcs: [], diagnostics: [] };
  const drops = auditApp(w, unlisted).filter((d) => d.kind === 'integration');
  assert.deepEqual(
    drops.map((d) => d.name).sort(),
    ['invokeurl in Notify (on load)', 'zoho.foo.bar in Notify (on load)'],
  );
});

test('a commented-out script declares no behaviour and is not a drop', () => {
  const commented = app({
    workflows: [
      workflow({ name: 'Old', container: 'form', form: 'Orders', event: 'on load', deluge: { text: '/* input.Title = "x"; */\n// hide Title;\n', span: Z } }),
    ],
  });
  assert.deepEqual(auditApp(commented), []);
});

test('integration mentions in comments and strings are not calls', () => {
  const quiet = app({
    workflows: [
      workflow({ name: 'A', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = 1; // zoho.sms.send("t", "123");', span: Z } }),
      workflow({ name: 'B', container: 'form', form: 'Orders', event: 'on load', deluge: { text: '/* zoho.sms.send("t", "123"); */', span: Z } }),
      workflow({ name: 'C', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = 1; // resp = invokeurl;', span: Z } }),
      workflow({ name: 'D', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = "use zoho.sms.send() here";', span: Z } }),
      workflow({ name: 'E', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = "the invokeurl statement";', span: Z } }),
    ],
  });
  assert.deepEqual(
    auditApp(quiet).filter((d) => d.kind === 'integration'),
    [],
  );
});

test('a permissions literal outside every profile and role is a drop', () => {
  const orphan = app({ permissions: [{ owner: 'Ghost', value: '{Chat:false}', span: Z }] });
  const drops = auditApp(orphan);
  assert.equal(drops.length, 1);
  assert.equal(drops[0]!.kind, 'permission');
});

function connApp(link: string, permissionsValue: string): App {
  return app({
    permissions: [{ owner: link, value: permissionsValue, span: Z }],
    configuration: [
      {
        name: 'connections',
        properties: [],
        items: [],
        blocks: [
          {
            name: link,
            properties: [
              { key: 'displayname', value: '"FS CRM"', span: Z },
              { key: 'permissions', value: permissionsValue, span: Z },
            ],
            items: [],
            blocks: [],
            span: Z,
          },
        ],
        span: Z,
      },
    ],
  });
}

test('a connection permissions literal is covered once the connections report lists its scopes', () => {
  const conn = connApp('fs_crm', '{"create_cases_record","fetch_cases_record"}');
  assert.deepEqual(auditApp(conn).filter((d) => d.kind === 'permission'), []);
  // With the scopes listing removed from the real report, the literal is a drop again.
  const out = collectOutputs(conn);
  const listed = out.connections.diagnostics.length;
  out.connections = {
    ...out.connections,
    diagnostics: out.connections.diagnostics.filter((d) => !d.startsWith('connection fs_crm: declares granted scopes')),
  };
  assert.ok(out.connections.diagnostics.length < listed);
  assert.equal(auditApp(conn, out).filter((d) => d.kind === 'permission').length, 1);
});

test('a permissions literal is covered only by a diagnostic that lists every scope it grants', () => {
  const literal = '{"create_cases_record","fetch_cases_record","update_cases_record"}';
  const covered = (diagnostics: string[]) => {
    const conn = connApp('fs_crm', literal);
    const out = collectOutputs(conn);
    out.connections = { ...out.connections, diagnostics };
    return auditApp(conn, out).filter((d) => d.kind === 'permission').length === 0;
  };
  // Exact set.
  assert.equal(covered(['connection fs_crm: declares granted scopes create_cases_record, fetch_cases_record, update_cases_record; carry them to the Catalyst connection']), true);
  // Superset.
  assert.equal(covered(['connection fs_crm: declares granted scopes create_cases_record, extra_scope, fetch_cases_record, update_cases_record; carry them to the Catalyst connection']), true);
  // A subset (missing update_cases_record) still drops.
  assert.equal(covered(['connection fs_crm: declares granted scopes create_cases_record, fetch_cases_record; carry them to the Catalyst connection']), false);
  // A diagnostic listing other scopes still drops.
  assert.equal(covered(['connection fs_crm: declares granted scopes other_scope; carry them to the Catalyst connection']), false);
  // A different connection's diagnostic never covers.
  assert.equal(covered(['connection fs_books: declares granted scopes create_cases_record, fetch_cases_record, update_cases_record; carry them to the Catalyst connection']), false);
  // A link name sharing the prefix never covers, in either direction.
  assert.equal(covered(['connection fs_crm2: declares granted scopes create_cases_record, fetch_cases_record, update_cases_record; carry them to the Catalyst connection']), false);
  const prefixed = connApp('fs_crm2', literal);
  const out = collectOutputs(prefixed);
  out.connections = {
    ...out.connections,
    diagnostics: ['connection fs_crm: declares granted scopes create_cases_record, fetch_cases_record, update_cases_record; carry them to the Catalyst connection'],
  };
  assert.equal(auditApp(prefixed, out).filter((d) => d.kind === 'permission').length, 1);
  // An unrelated diagnostic that merely names the connection never covers.
  assert.equal(covered(['connection fs_crm: used for crm and books']), false);
});

test('a permissions literal holding a value that is not a scope name stays a drop', () => {
  const conn = connApp('fs_books', '{"create_invoice","https://maps.example/secret","get_customer"}');
  const report = collectOutputs(conn);
  // The URL is never copied into the report's scope list.
  assert.ok(report.connections.diagnostics.every((d) => !d.includes('https://')));
  assert.equal(auditApp(conn, report).filter((d) => d.kind === 'permission').length, 1);
});

function formOf(name: string, names: string[]): App['forms'][number] {
  return { name, properties: [], fields: names.map((n) => field(n, 'text')), actions: [], blocks: [], span: Z };
}

test('a merged on-user-input route is produced when the script is written into it', () => {
  const booking = app({
    forms: [
      formOf('Add_Services', ['ID', 'Service_Time']),
      formOf('Appointment_Booking', ['Service', 'Schedule_upto', 'Staff_Name']),
    ],
    workflows: [
      workflow({
        name: 'Run_Scripts_On_Always1',
        container: 'form',
        form: 'Appointment_Booking',
        event: 'on user input of Schedule_Date_Time',
        span: { start: 10, end: 40, file: 'app.ds' },
        deluge: {
          text: 'if (input.Service != null) {\n  getServiceDetails = Add_Services[ID == input.Service];\n  input.Schedule_upto = getServiceDetails.Service_Time;\n}',
          span: { start: 12, end: 38, file: 'app.ds' },
        },
      }),
      workflow({
        name: 'Run_Scripts_On_Always2',
        container: 'form',
        form: 'Appointment_Booking',
        event: 'on user input of Staff_Name',
        span: { start: 50, end: 70, file: 'app.ds' },
        deluge: { text: 'hide input.Staff_Name;', span: { start: 52, end: 68, file: 'app.ds' } },
      }),
    ],
  });
  const out = collectOutputs(booking);
  assert.ok(out.files.some((f) => f.path === 'functions/aio/appointment-booking/input-handlers.mjs'));
  assert.ok(out.files.some((f) => f.path.includes('client/handlers/appointment-booking/on-user-input-of-schedule-date-time')));
  const prefetch = out.files.find((f) => f.path.endsWith('input-handlers-prefetch.mjs'));
  assert.ok(prefetch);
  assert.match(prefetch.source, /slots\[/);
  assert.doesNotMatch(prefetch.source, /thisapp\.call/);
  assert.deepEqual(auditApp(booking, out).filter((d) => d.kind === 'workflow'), []);
  const schedule = out.coverage?.find((c) => c.event.includes('Schedule_Date_Time'));
  assert.equal(schedule?.serverInvoked, true);
  const client = out.files.find((f) => f.path.includes('on-user-input-of-schedule-date-time'));
  assert.ok(client);
  assert.match(client.source, /shim\.client\.run\(ctx\)/);
  assert.equal(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === 10), false);

  // The merged leaf is not the per-event slug. Without coverage, the client
  // file, and the counted server-half TODO, the same script is a silent drop.
  const stripped = {
    ...out,
    coverage: [],
    todos: out.todos.filter((t) => t.construct !== FORM_EVENT_SERVER_UNINVOKED),
    files: out.files.filter((f) => !f.path.includes('on-user-input-of-schedule-date-time')),
  };
  const drops = auditApp(booking, stripped).filter((d) => d.kind === 'workflow');
  assert.equal(drops.length, 1);
  assert.match(drops[0]!.name, /Schedule_Date_Time/);
});

test('a thisapp field write in a merged route is covered and is not prefetched', () => {
  const hours = app({
    forms: [formOf('Timesheet', ['End_Time', 'Hours'])],
    functions: [],
    workflows: [
      workflow({
        name: 'Run_Scripts_On_Always2',
        container: 'form',
        form: 'Timesheet',
        event: 'on user input of End_Time',
        span: { start: 10, end: 30, file: 'app.ds' },
        deluge: { text: 'input.Hours = thisapp.timesheet.getHours(input.End_Time);', span: { start: 12, end: 28, file: 'app.ds' } },
      }),
      workflow({
        name: 'Show_Note',
        container: 'form',
        form: 'Timesheet',
        event: 'on user input of Hours',
        span: { start: 40, end: 55, file: 'app.ds' },
        deluge: { text: 'hide input.Hours;', span: { start: 42, end: 50, file: 'app.ds' } },
      }),
    ],
  });
  const out = collectOutputs(hours);
  assert.ok(out.files.some((f) => f.path === 'functions/aio/timesheet/input-handlers.mjs'));
  const prefetch = out.files.filter((f) => f.path.includes('prefetch')).map((f) => f.source).join('\n');
  assert.doesNotMatch(prefetch, /thisapp\.call/);
  assert.deepEqual(auditApp(hours, out).filter((d) => d.kind === 'workflow'), []);
  const hoursServer = out.coverage?.find((c) => c.event === 'on user input of End_Time');
  assert.equal(hoursServer?.serverInvoked, false);
  assert.ok(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === 10));
  const hidden = {
    ...out,
    coverage: (out.coverage ?? []).filter((c) => c.event !== 'on user input of End_Time'),
    todos: out.todos.filter((t) => !(t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === 10)),
    files: out.files.filter((f) => !f.path.includes('on-user-input-of-end-time')),
  };
  const drops = auditApp(hours, hidden).filter((d) => d.kind === 'workflow');
  assert.equal(drops.length, 1);
  assert.match(drops[0]!.name, /End_Time/);
});

test('an on-start sendmail merged with an empty sibling is the handler module', () => {
  const mail = app({
    forms: [formOf('Add_User', ['Email'])],
    workflows: [
      workflow({
        name: 'Send_Email_Form_Propertie',
        container: 'form',
        form: 'Add_User',
        event: 'on start',
        span: { start: 10, end: 40, file: 'app.ds' },
        deluge: {
          text: 'sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "hi"];',
          span: { start: 12, end: 36, file: 'app.ds' },
        },
      }),
      workflow({
        name: 'Field_Scripts8',
        container: 'form',
        form: 'Add_User',
        event: '',
        span: { start: 80, end: 90, file: 'app.ds' },
        deluge: { text: '', span: { start: 82, end: 88, file: 'app.ds' } },
      }),
    ],
  });
  const out = collectOutputs(mail);
  assert.ok(out.files.some((f) => f.path === 'functions/aio/add-user/handler-handlers.mjs'));
  assert.ok(!out.files.some((f) => f.path.endsWith('/on-start.mjs')));
  const blob = out.files.map((f) => f.source).join('\n');
  assert.match(blob, /shim\.mail\.send/);
  assert.doesNotMatch(blob, /slots\[.*mail\.send|mail\.send[\s\S]*slots\[/);
  assert.deepEqual(auditApp(mail, out).filter((d) => d.kind === 'workflow'), []);
  const started = out.coverage?.find((c) => c.name === 'Send_Email_Form_Propertie');
  assert.equal(started?.serverInvoked, false);
  assert.ok(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === 10));
  const cleared = {
    ...out,
    coverage: [],
    todos: out.todos.filter((t) => t.construct !== FORM_EVENT_SERVER_UNINVOKED),
  };
  const drops = auditApp(mail, cleared).filter((d) => d.kind === 'workflow');
  assert.equal(drops.length, 1);
  assert.match(drops[0]!.name, /on start/);
});

test('a client run posts /input and credits the merged server half', () => {
  // The same hide+sendmail script keeps its client half; the generated
  // shim.client.run guard posts the merged route, so the server part is
  // invoked and no form-event-server-uninvoked todo remains.
  const lead = app({
    forms: [formOf('New_Lead', ['Mode_of_Shipment'])],
    workflows: [
      workflow({
        name: 'pop_sub_mode_of_shipment',
        container: 'form',
        form: 'New_Lead',
        event: 'on user input of Mode_of_Shipment',
        span: { start: 10, end: 40, file: 'app.ds' },
        deluge: {
          text: 'hide Mode_of_Shipment;\nsendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "hi"];',
          span: { start: 12, end: 38, file: 'app.ds' },
        },
      }),
    ],
  });
  const out = collectOutputs(lead);
  const serverPath = '/forms/New_Lead/input';
  const client = out.files.find((f) => f.path.includes('client/handlers/new-lead/'));
  const server = out.files.find((f) => f.path.startsWith('functions/aio/new-lead/') && !f.path.includes('prefetch') && !f.path.endsWith('_lib.mjs'));
  assert.ok(client);
  assert.ok(server);
  assert.match(server.source, /path: "\/forms\/New_Lead\/input"/);
  assert.match(client.source, /shim\.client\.run\(ctx\)/);
  assert.equal(clientPostsServerPath(client.source, serverPath), true);
  const entry = out.coverage?.find((c) => c.name === 'pop_sub_mode_of_shipment');
  assert.ok(entry);
  assert.equal(entry.serverInvoked, true);
  assert.ok(entry.paths.includes(server.path));
  assert.ok(entry.paths.some((p) => p.startsWith('client/')));
  assert.equal(auditApp(lead, out).filter((d) => d.kind === 'workflow').length, 0);
  assert.equal(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED), false);
});

test('a server-only on-input script the client never posts stays counted', () => {
  const lead = app({
    forms: [formOf('New_Lead', ['Mode_of_Shipment'])],
    workflows: [
      workflow({
        name: 'pop_sub_mode_of_shipment',
        container: 'form',
        form: 'New_Lead',
        event: 'on user input of Mode_of_Shipment',
        span: { start: 10, end: 40, file: 'app.ds' },
        deluge: {
          text: 'sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "hi"];',
          span: { start: 12, end: 38, file: 'app.ds' },
        },
      }),
    ],
  });
  const out = collectOutputs(lead);
  const serverPath = '/forms/New_Lead/input';
  const server = out.files.find((f) => f.path.startsWith('functions/aio/new-lead/') && !f.path.includes('prefetch') && !f.path.endsWith('_lib.mjs'));
  assert.ok(server);
  assert.match(server.source, /path: "\/forms\/New_Lead\/input"/);
  for (const f of out.files.filter((f) => f.path.startsWith('client/'))) {
    assert.equal(clientPostsServerPath(f.source, serverPath), false, f.path);
  }
  const entry = out.coverage?.find((c) => c.name === 'pop_sub_mode_of_shipment');
  assert.ok(entry);
  assert.equal(entry.serverInvoked, false);
  assert.equal(entry.paths.includes(server.path), false);
  assert.equal(auditApp(lead, out).filter((d) => d.kind === 'workflow').length, 0);
  assert.ok(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === 10 && t.end === 40));
  // Crediting the uninvoked server file is the failure this guards. With the
  // count removed and the flag forced true, the client file would pass the
  // audit with nothing listed. The real output must not take that shape.
  const forced = {
    ...out,
    todos: out.todos.filter((t) => t.construct !== FORM_EVENT_SERVER_UNINVOKED),
    coverage: (out.coverage ?? []).map((c) => (c.name === 'pop_sub_mode_of_shipment' ? { ...c, serverInvoked: true as const } : c)),
  };
  assert.equal(auditApp(lead, forced).filter((d) => d.kind === 'workflow').length, 0);
  assert.equal(entry.serverInvoked, false);
  assert.ok(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED));
});

test('submit still credits an on-success server half the browser posts', () => {
  const orders = app({
    forms: [formOf('Orders', ['Title'])],
    workflows: [
      workflow({
        name: 'Stamp',
        container: 'form',
        form: 'Orders',
        event: 'on success',
        span: { start: 10, end: 30, file: 'app.ds' },
        deluge: {
          text: 'sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "hi"];',
          span: { start: 12, end: 28, file: 'app.ds' },
        },
      }),
    ],
  });
  const out = collectOutputs(orders);
  const entry = out.coverage?.find((c) => c.name === 'Stamp');
  assert.equal(entry?.serverInvoked, true);
  assert.ok(entry?.paths.some((p) => p.startsWith('functions/aio/')));
  assert.equal(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED), false);
  assert.deepEqual(auditApp(orders, out).filter((d) => d.kind === 'workflow'), []);
});

test('a prefetch URL is not a post of the server route', () => {
  const path = '/forms/New_Lead/input';
  assert.equal(clientPostsServerPath(`POST ${path}/prefetch`, path), false);
  assert.equal(clientPostsServerPath(`{"prefetch":"${path}/prefetch"}`, path), false);
  assert.equal(clientPostsServerPath(`await postJson("${path}", body)`, path), true);
  assert.equal(clientPostsServerPath(`await postJson("${path}/other", body)`, path), false);
});

test('rows are numbered and carry no app names', () => {
  const groups = groupDrops([
    [
      { kind: 'translation', name: 'translation de', note: 'The de block is not migrated.' },
      { kind: 'translation', name: 'translation de', note: 'The de block is not migrated.' },
    ],
    [{ kind: 'integration', name: 'zoho.sms.send in Notify (on success)', note: 'No checklist row.' }],
  ]);
  assert.equal(groups[0]!.occurrences, 2);
  assert.equal(groups[0]!.apps, 1);
  const body = renderNoSilentDrop(2, groups, 'example-audit');
  assert.match(body, /^1\. \[translation\]/m);
  assert.match(body, /^2\. \[integration\]/m);
  assert.doesNotMatch(body, /bug-tracker|leave-tracker|Demo_App/);
  const clean = renderNoSilentDrop(3, [], 'example-audit');
  assert.match(clean, /No silent drops/);
});

/** coveredApp plus a payments workflow and a blueprint, so every workflow kind is present. */
function everyKindApp(): App {
  const base = coveredApp();
  return app({
    ...base,
    workflows: [
      ...base.workflows,
      workflow({ name: 'Checkout payments', container: 'form', form: 'Orders', event: 'on success', deluge: { text: 'x = 1;', span: Z } }),
    ],
  });
}

/** The real outputs with every produced construct and every listing removed. */
function bareOutputs(a: App): ReturnType<typeof collectOutputs> {
  const out = collectOutputs(a);
  return {
    ...out,
    schema: { ...out.schema, tables: [], fields: [], issues: [] },
    model: { ...out.model, forms: [], reports: [], pages: [], todos: [] },
    files: [],
    todos: [],
    schedules: new Map(),
    specs: [],
  };
}

test('a construct neither produced nor listed is a drop of its own kind', () => {
  const a = everyKindApp();
  assert.deepEqual(auditApp(a), [], 'the real outputs produce or list everything');
  const drops = auditApp(a, bareOutputs(a));
  assert.deepEqual(
    drops.map((d) => `${d.kind}: ${d.name}`),
    [
      'form: Orders',
      'field: Orders.Title',
      'report: All_Orders',
      'page: Home',
      'workflow: Orders on load',
      'schedule: Daily',
      'approval: Sale approval',
      'workflow: Checkout payments',
    ],
  );
  for (const d of drops) assert.match(d.note, /Add one:/);
});

test('a fidelity note or todo lists each construct the generators did not produce', () => {
  const a = everyKindApp();
  const out = bareOutputs(a);
  out.schema.issues = [{ severity: 'unsupported', form: 'Orders', message: 'not migrated' } as (typeof out.schema.issues)[number]];
  out.schema.fields = [{ form: 'Orders', field: 'Title', status: 'unsupported' } as (typeof out.schema.fields)[number]];
  out.model.todos = [
    { area: 'report', name: 'All_Orders' } as (typeof out.model.todos)[number],
    // A page is listed through one of its ZML snippets.
    { area: 'zml', name: 'Home.panel1' } as (typeof out.model.todos)[number],
  ];
  // A todo inside a workflow's span lists that workflow's manual step.
  out.todos = [{ construct: 'manual', start: 0, end: 0 }];
  assert.deepEqual(auditApp(a, out), []);
  // A ZML todo of another page whose name merely starts the same does not list Home.
  out.model.todos = [{ area: 'report', name: 'All_Orders' } as (typeof out.model.todos)[number], { area: 'zml', name: 'Homepage.panel1' } as (typeof out.model.todos)[number]];
  assert.deepEqual(auditApp(a, out).map((d) => `${d.kind}: ${d.name}`), ['page: Home']);
});

test('only a blank or fully commented script is vacuous', () => {
  const one = (w: Workflow) => app({ workflows: [w] });
  const kinds = (a: App) => auditApp(a, bareOutputs(a)).map((d) => d.kind);
  // Whitespace only: nothing to migrate.
  assert.deepEqual(kinds(one(workflow({ name: 'Blank', container: 'form', form: 'Orders', event: 'on load', deluge: { text: '  \n\t', span: Z } }))), []);
  // An unparseable script parses to an unknown statement, so it is never vacuous: with no handler and no todo it is a drop.
  assert.deepEqual(kinds(one(workflow({ name: 'Broken', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'if (', span: Z } }))), ['workflow']);
  // Field rules are behaviour even without a script.
  const ruled = workflow({ name: 'Rules', container: 'form', form: 'Orders', event: 'on load' });
  ruled.fieldRules = [{ actions: [], span: Z }];
  assert.deepEqual(kinds(one(ruled)), ['workflow']);
});

test('a translation block with several languages is named as a block and listed by any warning', () => {
  const multi = app({ translations: [{ json: '{}', data: { de: {}, fr: {} }, span: Z }] });
  const out = collectOutputs(multi);
  out.warnings = [];
  assert.deepEqual(auditApp(multi, out).map((d) => d.name), ['translation block']);
  out.warnings = [{ construct: 'translation-not-migrated', name: 'translations' } as (typeof out.warnings)[number]];
  assert.deepEqual(auditApp(multi, out), []);
  // A single-language block needs a warning naming its language.
  const de = app({ translations: [{ json: '{}', data: { de: {} }, span: Z }] });
  const deOut = collectOutputs(de);
  deOut.warnings = [{ construct: 'translation-not-migrated', name: 'translation fr' } as (typeof deOut.warnings)[number]];
  assert.deepEqual(auditApp(de, deOut).map((d) => d.name), ['translation de']);
});
