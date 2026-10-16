import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyApp, parseProject, type App, type Field, type Workflow } from '../../core/src/index.js';
import { FORM_EVENT_SERVER_UNINVOKED, assertNoSkippedStatements, clientPostsServerPath, generate } from '../../deluge/src/generate.js';
import { assertCovered, auditApp, collectOutputs, coverageLedger, groupDrops, renderNoSilentDrop, SilentDropError } from '../src/no-silent-drop.js';

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
  assert.equal(hoursServer?.serverInvoked, true);
  assert.equal(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === 10), false);
  const guard = out.files.find((f) => f.path.includes('on-user-input-of-end-time'));
  assert.ok(guard);
  assert.match(guard.source, /shim\.client\.run\(ctx\)/);
  assert.equal(clientPostsServerPath(guard.source, '/forms/Timesheet/input'), true);
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

test('a server-only on-input script is wired through a guarded client run', () => {
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
  // A single-script route needs no scriptEvents map: the client run posts the
  // route and the module runs its one body.
  assert.doesNotMatch(server.source, /export const scriptEvents/);
  const client = out.files.find((f) => f.path.includes('client/handlers/new-lead/'));
  assert.ok(client);
  assert.match(client.source, /shim\.client\.run\(ctx\)/);
  assert.equal(clientPostsServerPath(client.source, serverPath), true);
  const entry = out.coverage?.find((c) => c.name === 'pop_sub_mode_of_shipment');
  assert.ok(entry);
  assert.equal(entry.serverInvoked, true);
  assert.ok(entry.paths.includes(server.path));
  assert.ok(entry.paths.includes(client.path));
  assert.equal(auditApp(lead, out).filter((d) => d.kind === 'workflow').length, 0);
  assert.equal(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED), false);
});

test('a server body on an event nothing posts stays counted', () => {
  // `on start` (a presuccess form-properties action) emits the
  // /forms/<form>/handler route; the guarded client run cannot express it and
  // the submit pipeline does not call it, so it stays counted.
  const lead = app({
    forms: [formOf('New_Lead', ['Mode_of_Shipment'])],
    workflows: [
      workflow({
        name: 'on_start_mail',
        container: 'form',
        form: 'New_Lead',
        event: 'on start',
        span: { start: 10, end: 40, file: 'app.ds' },
        deluge: {
          text: 'sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "hi"];',
          span: { start: 12, end: 38, file: 'app.ds' },
        },
      }),
    ],
  });
  const out = collectOutputs(lead);
  const entry = out.coverage?.find((c) => c.name === 'on_start_mail');
  assert.ok(entry);
  assert.equal(entry.serverInvoked, false);
  assert.equal(auditApp(lead, out).filter((d) => d.kind === 'workflow').length, 0);
  assert.ok(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === 10 && t.end === 40));
  // Crediting the uninvoked server file is the failure this guards. With the
  // count removed and the flag forced true, the audit would pass with nothing
  // listed. The real output must not take that shape.
  const forced = {
    ...out,
    todos: out.todos.filter((t) => t.construct !== FORM_EVENT_SERVER_UNINVOKED),
    coverage: (out.coverage ?? []).map((c) => (c.name === 'on_start_mail' ? { ...c, serverInvoked: true as const } : c)),
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

/** App with one emitted workflow whose script has two assign statements. */
function twoStatementApp(): App {
  const base = coveredApp();
  return app({
    ...base,
    workflows: [workflow({ name: 'Stamp', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = 1;\ny = 2;', span: Z } })],
  });
}

test('every declared statement is emitted or counted (C3)', () => {
  const a = twoStatementApp();
  const rows = coverageLedger(a);
  const stmts = rows.filter((r) => r.kind === 'statement');
  assert.equal(stmts.length, 2);
  assert.ok(stmts.every((r) => r.status === 'emitted'));
  assert.deepEqual(auditApp(a), []);
});

test('a fake generator that skips a statement fails generation', () => {
  const a = twoStatementApp();
  const out = collectOutputs(a);
  // The handler module still exists, but the ledger has no row for `y = 2;`.
  out.statementCoverage = out.statementCoverage.filter((c) => !(c.kind === 'assign' && c.start === 7));
  const drops = auditApp(a, out);
  assert.equal(drops.length, 1);
  assert.equal(drops[0]!.kind, 'statement');
  assert.match(drops[0]!.name, /Stamp/);
  assert.throws(() => assertCovered(a, out), SilentDropError);
});

/** Two emitted workflows with identical statements: deleting one unit's row must not be covered by the other unit's. */
function twoUnitApp(): App {
  const base = coveredApp();
  return app({
    ...base,
    workflows: [
      workflow({ name: 'StampA', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = 1;\ny = 2;', span: { start: 0, end: 12 } } }),
      workflow({ name: 'StampB', container: 'form', form: 'Orders', event: 'on success', deluge: { text: 'x = 1;\ny = 2;', span: { start: 100, end: 112 } } }),
    ],
  });
}

test('a statement row can only satisfy a statement in its own unit', () => {
  const a = twoUnitApp();
  const out = collectOutputs(a);
  const units = new Set(out.statementCoverage.map((c) => c.unit));
  assert.ok(units.has('workflow StampA (on load)') && units.has('workflow StampB (on success)'));
  // Remove StampA's `y = 2;` row. StampB still emits its own `y = 2;` row of
  // the same kind: before unit-scoping that row covered the deletion.
  out.statementCoverage = out.statementCoverage.filter((c) => !(c.unit === 'workflow StampA (on load)' && c.kind === 'assign' && c.start === 7));
  const drops = auditApp(a, out);
  assert.deepEqual(
    drops.map((d) => d.name),
    ['workflow StampA (on load) assign statement'],
  );
});

test('deleting one emitted statement row per unit is detected across gallery apps', { skip: !process.env.C2C_FIXTURES_DIR ? 'C2C_FIXTURES_DIR/gallery is not available' : false }, () => {
  const gallery = join(process.env.C2C_FIXTURES_DIR!, 'gallery');
  for (const name of ['admission-management', 'sales-management', 'course-planner']) {
    const appUnderTest = parseProject(join(gallery, name)).ir;
    const out = collectOutputs(appUnderTest);
    const emittedByUnit = new Map<string, typeof out.statementCoverage>();
    for (const c of out.statementCoverage) {
      if (c.bucket !== 'translated' && c.bucket !== 'shimmed') continue;
      const list = emittedByUnit.get(c.unit) ?? [];
      list.push(c);
      emittedByUnit.set(c.unit, list);
    }
    let tested = 0;
    let caught = 0;
    for (const list of emittedByUnit.values()) {
      const victim = list[0]!;
      const mutated = { ...out, statementCoverage: out.statementCoverage.filter((c) => c !== victim) };
      const drops = coverageLedger(appUnderTest, mutated).filter((r) => r.status === 'dropped' && r.kind === 'statement');
      // A unit whose owner is itself dropped or counted reports at the owner
      // row, so a missing statement row surfaces only under an emitted owner.
      if (!drops.length) continue;
      tested++;
      const baseline = coverageLedger(appUnderTest, out).filter((r) => r.status === 'dropped' && r.kind === 'statement').length;
      if (drops.length > baseline) caught++;
    }
    assert.equal(caught, tested, `${name}: ${caught}/${tested} single-row deletions detected`);
  }
});

test('a statement visited but accounted nowhere fails generation', () => {
  const a = twoStatementApp();
  const out = collectOutputs(a);
  out.statementCoverage = out.statementCoverage.map((c) => (c.kind === 'assign' && c.start === 7 ? { ...c, bucket: 'skipped' as const } : c));
  const drops = auditApp(a, out);
  assert.equal(drops.length, 1);
  assert.equal(drops[0]!.kind, 'statement');
  assert.match(drops[0]!.note, /silent drop/);
});

test('assertNoSkippedStatements throws on a skipped non-block row only', () => {
  const row = { unit: 'workflow W (on load)', kind: 'assign', start: 0, end: 5 };
  assert.throws(() => assertNoSkippedStatements([{ ...row, bucket: 'skipped' }]), /silent drop/);
  // A `block` only recurses; 'skipped' is its resting bucket, not a drop.
  assert.doesNotThrow(() =>
    assertNoSkippedStatements([
      { ...row, kind: 'block', bucket: 'skipped' },
      { ...row, bucket: 'translated' },
    ]),
  );
});

// The translator accounts every statement it can parse, so no script reaches a
// 'skipped' row on its own. A child process replaces translate() with one
// that reports its rows as skipped and runs the real generate(): the gate
// inside generate() is what must refuse the app.
const SKIPPING_TRANSLATE = `
import { mock } from 'node:test';
const [translateUrl, generateUrl, appJson] = process.argv.slice(1);
const real = await import(translateUrl);
mock.module(translateUrl, {
  namedExports: {
    ...real,
    translate: (src, options) => {
      const out = real.translate(src, options);
      return { ...out, coverage: out.coverage.map((c) => ({ ...c, bucket: 'skipped' })) };
    },
  },
});
const { generate } = await import(generateUrl);
try {
  generate(JSON.parse(appJson));
  console.log('generated');
} catch (e) {
  console.log(e.message);
}
`;

test('generate() refuses an app whose translator leaves a statement skipped', () => {
  const a = app({
    ...coveredApp(),
    workflows: [workflow({ name: 'Load', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = 1;', span: Z } })],
  });
  // Control: the same app generates when every statement is accounted.
  assert.ok(generate(a).statementCoverage.some((c) => c.kind === 'assign' && c.bucket !== 'skipped'));
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--no-warnings',
      '--input-type=module',
      '-e',
      SKIPPING_TRANSLATE,
      new URL('../../deluge/src/translate.js', import.meta.url).href,
      new URL('../../deluge/src/generate.js', import.meta.url).href,
      JSON.stringify(a),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^silent drop: a assign statement in workflow Load \(on load\) was visited but emitted nothing/);
});

test('a todo-bucket statement with no covering TODO item fails generation', () => {
  const a = app({
    ...coveredApp(),
    workflows: [workflow({ name: 'Gap', container: 'form', form: 'Orders', event: 'on load', deluge: { text: 'x = 1;\nzoho.unknownthing.go("x");', span: Z } })],
  });
  const out = collectOutputs(a);
  // Force the second statement into the todo bucket without any TODO item.
  const second = out.statementCoverage.find((c) => c.start === 7);
  assert.ok(second);
  second.bucket = 'todo';
  out.todos = out.todos.filter((t) => t.end <= 7 || t.start >= 30);
  const drops = auditApp(a, out);
  assert.deepEqual(drops.filter((d) => d.kind === 'statement').map((d) => d.name), ['workflow Gap (on load) expr statement']);
});

const SPAN = {
  report: { start: 1000, end: 2000 },
  column: { start: 1100, end: 1200 },
  filter: { start: 1300, end: 1400 },
  action: { start: 1500, end: 1600 },
  format: { start: 1700, end: 1800 },
  field: { start: 2000, end: 2600 },
  type: { start: 2010, end: 2050 },
  max: { start: 2100, end: 2200 },
  initial: { start: 2300, end: 2400 },
  page: { start: 3000, end: 3400 },
  panel: { start: 3010, end: 3080 },
};

/** Report, page, and field whose generated artefacts carry every declared feature. */
function richApp(): App {
  const title = field('Title', 'text');
  title.span = SPAN.field;
  title.initialValue = '"Hello"';
  title.properties = [
    { key: 'type', value: 'text', span: SPAN.type },
    { key: 'max char', value: '40', span: SPAN.max },
    { key: 'initial value', value: '"Hello"', span: SPAN.initial },
  ];
  return app({
    forms: [{ name: 'Orders', properties: [], fields: [title], actions: [], blocks: [], span: SPAN.field }],
    reports: [
      {
        name: 'All_Orders',
        type: 'list',
        modifiers: [],
        form: 'Orders',
        flags: [],
        properties: [],
        criteria: 'Title == "Open"',
        columns: [{ field: 'Title', properties: [], subcolumns: [], span: SPAN.column }],
        customActions: [{ name: 'Export', column: false, properties: [], flags: [], blocks: [], span: SPAN.action }],
        conditionalFormats: [{ name: 'Hot', condition: 'Title == "Open"', properties: [], span: SPAN.format }],
        filters: [{ field: 'Title', span: SPAN.filter }],
        groupBy: [],
        sortBy: [],
        blocks: [],
        views: [],
        span: SPAN.report,
      },
    ],
    pages: [
      {
        name: 'Dash',
        properties: [],
        zml: [{ tag: 'panel', attributes: { elementName: 'Panel' }, children: [], start: SPAN.panel.start, end: SPAN.panel.end }],
        references: [],
        span: SPAN.page,
      },
    ],
  });
}

function cloneOutputs(out: ReturnType<typeof collectOutputs>): ReturnType<typeof collectOutputs> {
  return {
    ...out,
    schema: JSON.parse(JSON.stringify(out.schema)) as ReturnType<typeof collectOutputs>['schema'],
    model: JSON.parse(JSON.stringify(out.model)) as ReturnType<typeof collectOutputs>['model'],
    todos: [...out.todos],
  };
}

function dropNames(appUnderTest: App, out: ReturnType<typeof collectOutputs>): string[] {
  return auditApp(appUnderTest, out).map((drop) => drop.name);
}

test('a report feature, page element, or field setting is emitted only when the generated artefact contains it', () => {
  const source = richApp();
  const out = collectOutputs(source);
  const rows = coverageLedger(source, out);
  const dropped = rows.filter((row) => row.status === 'dropped').map((row) => `${row.kind}: ${row.name}`);
  assert.deepEqual(dropped, []);
  for (const name of [
    'All_Orders column Title',
    'All_Orders filter Title',
    'All_Orders custom action Export',
    'All_Orders conditional format Hot',
    'All_Orders criteria',
    'Dash.Panel',
    'Orders.Title property max char',
    'Orders.Title property initial value',
    'Orders.Title initial value',
  ]) {
    assert.equal(rows.find((row) => row.name === name)?.status, 'emitted', name);
  }

  const withoutColumn = cloneOutputs(out);
  const columnReport = withoutColumn.model.reports[0]!;
  columnReport.columns = columnReport.columns.filter((column) => column.field !== 'Title');
  columnReport.phoneColumns = (columnReport.phoneColumns ?? []).filter((column) => column.field !== 'Title');
  for (const block of columnReport.detailBlocks ?? []) block.fields = block.fields.filter((item) => item.field !== 'Title');
  assert.deepEqual(dropNames(source, withoutColumn), ['All_Orders column Title']);

  const withoutFilter = cloneOutputs(out);
  withoutFilter.model.reports[0]!.filters = [];
  assert.deepEqual(dropNames(source, withoutFilter), ['All_Orders filter Title']);

  const withoutAction = cloneOutputs(out);
  const actionReport = withoutAction.model.reports[0]!;
  actionReport.customActions = [];
  actionReport.columns = actionReport.columns.filter((column) => column.field !== 'Export');
  assert.deepEqual(dropNames(source, withoutAction), ['All_Orders custom action Export']);

  const withoutFormat = cloneOutputs(out);
  delete withoutFormat.model.reports[0]!.conditionalFormats;
  assert.deepEqual(dropNames(source, withoutFormat), ['All_Orders conditional format Hot']);

  const withoutCriteria = cloneOutputs(out);
  delete withoutCriteria.model.reports[0]!.criteria;
  assert.deepEqual(dropNames(source, withoutCriteria), ['All_Orders criteria']);

  const withoutPanel = cloneOutputs(out);
  withoutPanel.model.pages[0]!.elements = [];
  assert.deepEqual(dropNames(source, withoutPanel), ['Dash.Panel']);

  const withoutMax = cloneOutputs(out);
  const maxField = withoutMax.model.forms[0]!.fields.find((item) => item.name === 'Title')!;
  delete maxField.maxLength;
  for (const table of withoutMax.schema.tables) {
    for (const column of table.columns) if (column.name === 'Title' || column.field === 'Title') delete column.length;
  }
  assert.deepEqual(dropNames(source, withoutMax), ['Orders.Title property max char']);

  const withoutInitial = cloneOutputs(out);
  const initialField = withoutInitial.model.forms[0]!.fields.find((item) => item.name === 'Title')!;
  delete initialField.initialValue;
  for (const table of withoutInitial.schema.tables) {
    for (const column of table.columns) if (column.name === 'Title' || column.field === 'Title') delete column.defaultValue;
  }
  assert.deepEqual(dropNames(source, withoutInitial).sort(), ['Orders.Title initial value', 'Orders.Title property initial value']);

  const counted = cloneOutputs(out);
  const countedReport = counted.model.reports[0]!;
  countedReport.columns = [];
  countedReport.phoneColumns = [];
  countedReport.detailBlocks = [];
  counted.todos.push({ construct: 'manual', start: SPAN.column.start, end: SPAN.column.end });
  const countedRow = coverageLedger(source, counted).find((row) => row.name === 'All_Orders column Title');
  assert.equal(countedRow?.status, 'counted');
  assert.equal(dropNames(source, counted).includes('All_Orders column Title'), false);
});

test('a page element whose payload was not generated is a drop even though the node exists', () => {
  const element = (tag: string, attributes: Record<string, string>) => ({ tag, attributes, children: [], start: 10, end: 20 });
  const source = app({
    pages: [
      {
        name: 'Dash',
        properties: [],
        zml: [
          element('panel', { elementName: 'Panel' }),
          element('button', { elementName: 'Go', parameters: 'View all Books' }),
          element('search', { elementName: 'Search', linkName: 'Book_Report', criteriaString: 'Title.contains(input.searchString)' }),
          element('text', { elementName: 'Fine', type: 'form data', value: 'thisapp.Book.Fine_Amount.distinctCount' }),
          element('text', { elementName: 'Total', type: 'form data', value: 'thisapp.Book.Fine_Amount.count' }),
        ],
        references: [],
        span: { start: 1, end: 80 },
      },
    ],
  });
  const rows = coverageLedger(source);
  assert.equal(rows.find((row) => row.name === 'Dash.Panel')?.status, 'emitted');
  assert.equal(rows.find((row) => row.name === 'Dash.Total')?.status, 'emitted');
  const drops = rows.filter((row) => row.status === 'dropped');
  assert.deepEqual(
    drops.map((drop) => drop.name).sort(),
    ['Dash.Book_Report', 'Dash.Fine', 'Dash.Go'],
  );
  for (const drop of drops) assert.match(drop.note ?? '', /Add one:/);
});

test('a page element emitted as an empty stub is a drop', () => {
  const source = app({
    pages: [
      {
        name: 'Dash',
        properties: [],
        zml: [
          { tag: 'text', attributes: { elementName: 'Hello' }, children: [], text: 'Hello', start: 10, end: 20 },
          { tag: 'text', attributes: { elementName: 'World' }, children: [], text: 'World', start: 21, end: 30 },
        ],
        references: [],
        span: { start: 1, end: 40 },
      },
    ],
  });
  const out = collectOutputs(source);
  assert.deepEqual(dropNames(source, out), []);
  const stub = cloneOutputs(out);
  const walk = (els: typeof stub.model.pages[number]['elements']): void => {
    for (const el of els) {
      if (el.kind === 'text') el.text = '';
      walk(el.children);
    }
  };
  walk(stub.model.pages[0]!.elements);
  assert.deepEqual(dropNames(source, stub).sort(), ['Dash.Hello', 'Dash.World']);
});

test('a same-tag element under another name does not satisfy a named page element', () => {
  const source = app({
    pages: [
      {
        name: 'Dash',
        properties: [],
        zml: [
          { tag: 'text', attributes: { elementName: 'Hello' }, children: [], text: 'Hello', start: 10, end: 20 },
          { tag: 'text', attributes: { elementName: 'World' }, children: [], text: 'World', start: 21, end: 30 },
        ],
        references: [],
        span: { start: 1, end: 40 },
      },
    ],
  });
  const out = collectOutputs(source);
  assert.deepEqual(dropNames(source, out), []);
  const renamed = cloneOutputs(out);
  const walk = (els: typeof renamed.model.pages[number]['elements']): void => {
    for (const el of els) {
      if (el.name === 'Hello') el.name = 'SomethingElse';
      walk(el.children);
    }
  };
  walk(renamed.model.pages[0]!.elements);
  assert.deepEqual(dropNames(source, renamed), ['Dash.Hello']);
});

test('a kanban view that the model does not keep, and an options icon, are drops', () => {
  const genre = field('Genre', 'picklist');
  genre.span = { start: 1, end: 40 };
  genre.choices = ['Fiction', 'History'];
  genre.properties = [
    { key: 'type', value: 'picklist', span: { start: 2, end: 8 } },
    { key: 'values', value: '{"Fiction","History"}', span: { start: 9, end: 16 } },
  ];
  const source = app({
    forms: [{ name: 'Orders', properties: [], fields: [genre], actions: [], blocks: [], span: { start: 1, end: 40 } }],
    reports: [
      {
        name: 'Book_by_Genre',
        type: 'kanban',
        modifiers: [],
        form: 'Orders',
        flags: [],
        properties: [],
        columns: [{ field: 'Genre', properties: [], subcolumns: [], span: { start: 100, end: 120 } }],
        customActions: [],
        conditionalFormats: [],
        filters: [],
        groupBy: [],
        sortBy: [],
        blocks: [
          {
            name: 'options',
            properties: [{ key: 'display field', value: 'Genre', span: { start: 130, end: 140 } }],
            blocks: [],
            items: [],
            span: { start: 130, end: 150 },
          },
        ],
        views: [],
        span: { start: 90, end: 200 },
      },
    ],
  });
  const out = collectOutputs(source);
  assert.equal(out.model.reports[0]!.view, 'kanban');
  assert.deepEqual(dropNames(source, out), []);

  const listed = cloneOutputs(out);
  listed.model.reports[0]!.view = 'list';
  delete listed.model.reports[0]!.note;
  assert.deepEqual(dropNames(source, listed), ['Book_by_Genre view kanban']);

  const icon = app({
    ...source,
    reports: [
      {
        ...source.reports[0]!,
        blocks: [
          {
            name: 'options',
            properties: [
              { key: 'display field', value: 'Genre', span: { start: 130, end: 140 } },
              { key: 'icon', value: 'books', span: { start: 141, end: 148 } },
            ],
            blocks: [],
            items: [],
            span: { start: 130, end: 150 },
          },
        ],
      },
    ],
  });
  assert.deepEqual(dropNames(icon, collectOutputs(icon)), ['Book_by_Genre block options']);
});
