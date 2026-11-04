import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, emptyApp, parse, parseProject, type App, type Field, type Workflow } from '../../core/src/index.js';
import { FORM_EVENT_SERVER_UNINVOKED, assertNoSkippedStatements, clientPostsServerPath, generate, submitBodyReadsClientState, submitMergeBlockers } from '../../deluge/src/generate.js';
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

test('carried field layout values emit; unknown values and nav layouts on a field stay drops', () => {
  const layouts: [string, number][] = [
    ['2', 2],
    ['3', 3],
    ['onecolumn', 1],
    ['twocolumn', 2],
  ];
  for (const [value, columns] of layouts) {
    const known = app({ forms: [{ name: 'Orders', properties: [], fields: [{ ...field('Status', 'radiobuttons'), properties: [{ key: 'layout', value, span: Z }], choices: ['Open', 'Closed'] }], actions: [], blocks: [], span: Z }] });
    assert.deepEqual(auditApp(known), [], `layout ${value} should reach the generated field`);
    // Mutation: a different option column count in generated output must not prove this value.
    const outputs = collectOutputs(known);
    const ui = outputs.model.forms[0].fields.find((item) => item.name === 'Status');
    assert.equal(ui?.optionColumns, columns, `layout ${value} carried the wrong column count`);
    ui!.optionColumns = columns === 2 ? 3 : 2;
    assert.equal(
      auditApp(known, outputs).filter((drop) => drop.property === 'property layout').length,
      1,
      `layout ${value} must not pass when the generated field lost its arrangement`,
    );
  }
  const card = app({ forms: [{ name: 'Orders', properties: [], fields: [{ ...field('Status', 'radiobuttons'), properties: [{ key: 'layout', value: 'onecolumncard', span: Z }], choices: ['Open', 'Closed'] }], actions: [], blocks: [], span: Z }] });
  assert.deepEqual(auditApp(card), [], 'layout onecolumncard should reach the generated field');
  const cardOut = collectOutputs(card);
  cardOut.model.forms[0].fields.find((item) => item.name === 'Status')!.optionCard = false;
  assert.equal(auditApp(card, cardOut).filter((drop) => drop.property === 'property layout').length, 1, 'a lost card wrapper must not pass');

  for (const value of ['fourcolumn', 'slidingpane', 'tabbar']) {
    const unknown = app({ forms: [{ name: 'Orders', properties: [], fields: [{ ...field('Status', 'radiobuttons'), properties: [{ key: 'layout', value, span: Z }], choices: ['Open', 'Closed'] }], actions: [], blocks: [], span: Z }] });
    assert.equal(auditApp(unknown).filter((drop) => drop.property === 'property layout').length, 1, `layout ${value} should remain a drop on a field`);
  }
});

test('an unlisted translation fails until the manual step exists', () => {
  const withTranslation = app({
    ...coveredApp(),
    translations: [{ json: '{"de":{"FormField.Orders.Title":" Titel "}}', data: { de: { 'FormField.Orders.Title': ' Titel ' } }, span: { start: 10, end: 200 } }],
  });
  // The generator's migration-report warning is not a manual step: the block
  // is still a drop, and the note names the warning.
  const drops = auditApp(withTranslation);
  assert.deepEqual(
    drops.map((d) => `${d.kind}: ${d.name}`),
    ['translation: translation de'],
  );
  assert.match(drops[0]!.note, /migration-report warning/);
  // A todo inside the block's span is the counted manual step.
  const listed = collectOutputs(withTranslation);
  listed.todos = [...listed.todos, { construct: 'manual', start: 20, end: 30 }];
  assert.deepEqual(auditApp(withTranslation, listed), []);
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
  // A plain form workflow on `on start` emits the /forms/<form>/handler route;
  // the guarded client run cannot express it and, not being a presuccess
  // action, the submit pipeline does not call it, so it stays counted.
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

test('an on start presuccess body is credited: the submit pipeline runs it', () => {
  const lead = app({
    forms: [formOf('New_Lead', ['Mode_of_Shipment'])],
    workflows: [
      workflow({
        name: 'presuccess_mail',
        type: 'presuccess',
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
  const server = out.files.find((f) => /path: "\/forms\/New_Lead\/handler"/.test(f.source));
  assert.ok(server);
  assert.match(server.source, /^export const presuccess = true;$/m);
  const entry = out.coverage?.find((c) => c.name === 'presuccess_mail');
  assert.ok(entry);
  assert.equal(entry.serverInvoked, true);
  assert.ok(entry.paths.includes(server.path));
  assert.equal(out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED), false);
  assert.equal(auditApp(lead, out).filter((d) => d.kind === 'workflow').length, 0);
});

test('a handler route merging a presuccess body with another server script stays counted', () => {
  // The pipeline runs a whole module, never one script of a merged route, so
  // a route that also carries a non-presuccess `on start` script is not
  // marked and neither script is credited.
  const mail = { text: 'sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "hi"];', span: { start: 12, end: 38, file: 'app.ds' } };
  const lead = app({
    forms: [formOf('New_Lead', ['Mode_of_Shipment'])],
    workflows: [
      workflow({ name: 'presuccess_mail', type: 'presuccess', container: 'form', form: 'New_Lead', event: 'on start', span: { start: 10, end: 40, file: 'app.ds' }, deluge: mail }),
      workflow({ name: 'plain_start', container: 'form', form: 'New_Lead', event: 'on start', span: { start: 50, end: 80, file: 'app.ds' }, deluge: { ...mail, span: { start: 52, end: 78, file: 'app.ds' } } }),
    ],
  });
  const out = collectOutputs(lead);
  const server = out.files.find((f) => /path: "\/forms\/New_Lead\/handler"/.test(f.source));
  assert.ok(server);
  assert.doesNotMatch(server.source, /export const presuccess/);
  for (const name of ['presuccess_mail', 'plain_start']) {
    const entry = out.coverage?.find((c) => c.name === name);
    assert.ok(entry, name);
    assert.equal(entry.serverInvoked, false, name);
  }
  assert.equal(out.todos.filter((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED).length, 2);
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

test('a translation block with several languages is named as a block and counted only by a todo', () => {
  const multi = app({ translations: [{ json: '{}', data: { de: {}, fr: {} }, span: { start: 10, end: 200 } }] });
  const out = collectOutputs(multi);
  assert.deepEqual(auditApp(multi, out).map((d) => d.name), ['translation block']);
  // A todo inside the span counts it once; a todo outside does not.
  out.todos = [{ construct: 'manual', start: 0, end: 5 }];
  assert.deepEqual(auditApp(multi, out).map((d) => d.name), ['translation block']);
  out.todos = [{ construct: 'manual', start: 20, end: 30 }];
  assert.deepEqual(auditApp(multi, out), []);
  // A single-language block is named by its language, warned or not.
  const de = app({ translations: [{ json: '{}', data: { de: {} }, span: Z }] });
  const deOut = collectOutputs(de);
  deOut.warnings = [{ construct: 'translation-not-migrated', name: 'translation de' } as (typeof deOut.warnings)[number]];
  assert.deepEqual(auditApp(de, deOut).map((d) => d.name), ['translation de']);
});

/** A creator function whose body has no translatable statement: the generator warns `function-untranslated` and writes no module. A bare `openUrl(...)` body is excluded here — that now classifies (and is counted) as a navigation function with its own supported/unsupported outcome, not this generic path. */
function warningOnlyFunctionApp(): App {
  return app({
    functions: [
      {
        name: 'Navi',
        kind: 'creator',
        deluge: [{ text: '// not yet implemented', span: { start: 0, end: 23 } }],
        properties: [],
        span: { start: 0, end: 500 },
      },
    ],
  });
}

test('a function warned about but not emitted is a silent drop, not coverage', () => {
  const a = warningOnlyFunctionApp();
  const out = collectOutputs(a);
  assert.ok(out.warnings.some((w) => w.construct === 'function-untranslated' && w.name === 'Navi'));
  assert.ok(!out.files.some((f) => f.path === 'functions/custom/navi.mjs'));
  const drops = auditApp(a, out);
  assert.deepEqual(
    drops.map((d) => `${d.kind}: ${d.name}`),
    ['function: Navi'],
  );
  assert.match(drops[0]!.note, /warning/);
});

test('a todo inside a warned function counts it once — a warning alone never does', () => {
  const a = warningOnlyFunctionApp();
  const out = collectOutputs(a);
  out.todos = [{ construct: 'manual', start: 0, end: 10 }];
  const rows = coverageLedger(a, out).filter((r) => r.kind === 'function');
  assert.deepEqual(
    rows.map((r) => `${r.status}:${r.via}`),
    ['counted:todo'],
  );
  assert.deepEqual(auditApp(a, out), []);
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

test('a detail view proves against the layout kept for its device', () => {
  const block = (name: string, title: string, relatedField: string | undefined, fields: string[]) => ({
    name,
    title,
    ...(relatedField ? { relatedField } : {}),
    fields: fields.map((f) => ({ field: f, properties: [], subcolumns: [], span: Z })),
    properties: [],
    span: Z,
  });
  const view = (kind: 'quickview' | 'detailview', device: string | undefined, blocks: ReturnType<typeof block>[]) => ({
    kind,
    ...(device ? { device } : {}),
    layoutProperties: [],
    blocks,
    menus: {},
    actions: {},
    properties: [],
    span: Z,
  });
  const source = app({
    forms: [{ name: 'Orders', properties: [], fields: [field('Title', 'text'), field('Name', 'text'), field('Qty', 'text')], actions: [], blocks: [], span: Z }],
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
        views: [
          // Two "Overview" blocks: a field section and a related list.
          view('detailview', 'web', [block('datablock1', 'Overview', undefined, ['Title']), block('datablock2', 'Overview', 'Items', ['Name', 'Qty'])]),
          view('detailview', 'phone', [block('datablock1', 'Phone Card', undefined, ['Title'])]),
        ],
        span: Z,
      },
    ],
  });
  const out = collectOutputs(source);
  const built = out.model.reports.find((item) => item.name === 'All_Orders')!;
  assert.equal(built.detailDevice, 'web');
  assert.deepEqual((built.deviceDetailBlocks ?? []).map((variant) => variant.device), ['phone']);
  const rows = coverageLedger(source, out);
  // The related "Overview" block lands on the related layout block, not the first same-title block.
  assert.equal(rows.find((row) => row.name === 'All_Orders detailview web')?.status, 'emitted');
  assert.equal(rows.find((row) => row.name === 'All_Orders detailview phone')?.status, 'emitted');
  assert.equal(dropNames(source, out).includes('All_Orders detailview phone'), false);
  // Break the generated output: without the carried phone layout the drop returns.
  const mutated = cloneOutputs(out);
  delete mutated.model.reports.find((item) => item.name === 'All_Orders')!.deviceDetailBlocks;
  assert.ok(dropNames(source, mutated).includes('All_Orders detailview phone'));
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

test('options display rows, records per row and label width clear only when the generated report carries them', () => {
  const source = app({
    forms: [{ name: 'Orders', properties: [], fields: [field('Title', 'text')], actions: [], blocks: [], span: Z }],
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
        blocks: [
          {
            name: 'options',
            properties: [
              { key: 'display rows', value: '10', span: Z },
              { key: 'display records per row', value: '2', span: Z },
              { key: 'label width', value: '20%', span: Z },
            ],
            blocks: [],
            items: [],
            span: Z,
          },
        ],
        views: [],
        span: Z,
      },
    ],
  });
  const out = collectOutputs(source);
  assert.equal(out.model.reports[0]!.pageSize, 10);
  assert.equal(out.model.reports[0]!.recordsPerRow, 2);
  assert.equal(out.model.reports[0]!.labelWidth, '20%');
  assert.deepEqual(dropNames(source, out), []);

  // A mutation to any carried setting returns the drop (audit proves the
  // generated output, not the export).
  const tampered = cloneOutputs(out);
  tampered.model.reports[0]!.recordsPerRow = 3;
  assert.deepEqual(dropNames(source, tampered), ['All_Orders block options']);
  const shrunk = cloneOutputs(out);
  shrunk.model.reports[0]!.pageSize = 300;
  assert.deepEqual(dropNames(source, shrunk), ['All_Orders block options']);

  // Unknown keys and values that are not carried fail closed.
  const prop = (key: string, value: string) => ({ key, value, span: Z });
  const withBlock = (properties: ReturnType<typeof prop>[]) =>
    app({ ...source, reports: [{ ...source.reports[0]!, blocks: [{ name: 'options', properties, blocks: [], items: [], span: Z }] }] });
  assert.deepEqual(dropNames(withBlock([prop('display rows', 'many')]), collectOutputs(withBlock([prop('display rows', 'many')]))), [
    'All_Orders block options',
  ]);
  assert.deepEqual(dropNames(withBlock([prop('record count', 'enable')]), collectOutputs(withBlock([prop('record count', 'enable')]))), [
    'All_Orders block options',
  ]);
  // A board view never draws the rows table: the density stays a drop.
  const board = app({ ...source, reports: [{ ...source.reports[0]!, type: 'kanban', groupBy: [{ field: 'Title' }] }] });
  assert.deepEqual(dropNames(board, collectOutputs(board)), ['All_Orders block options']);
});

// A submit-kind body on /forms/<form>/submit runs only for the posts the
// generated UI still sends there: add posts go to submitEndpoint, edit posts
// to editSubmitEndpoint (falling back to submitEndpoint). Each case pins which
// body is credited and checks the credit against the UI model's endpoints.
function submitScopeApp(successes: { name: string; recordEvent?: string; client: boolean }[]): App {
  const mail = (tag: string) => `sendmail[from: zoho.loginuserid to: "a@b.c" subject: "${tag}" message: "hi"];`;
  let at = 100;
  const span = () => {
    const start = at;
    at += 100;
    return { start, end: start + 50, file: 'app.ds' };
  };
  const body = (name: string, event: string, text: string, extra: Partial<Workflow> = {}) => {
    const s = span();
    return workflow({ name, container: 'form', form: 'Orders', event, span: s, deluge: { text, span: { start: s.start + 1, end: s.end - 1, file: 'app.ds' } }, ...extra });
  };
  return app({
    forms: [formOf('Orders', ['Title'])],
    workflows: [
      ...successes.map((w) =>
        body(w.name, 'on success', (w.client ? 'openUrl("https://example.com", "same window");\n' : '') + mail(w.name), w.recordEvent ? { recordEvent: w.recordEvent } : {}),
      ),
      body('AddBody', 'on add', mail('add')),
      body('EditBody', 'on edit', mail('edit')),
      body('BothBody', 'on add or edit', mail('both')),
    ],
  });
}

// A submit body the success module owns merges into it: `moved` bodies leave
// `/submit` entirely, `copied` bodies keep a `/submit` copy for the posts the
// success route does not own, and `stay` bodies are never merged.
for (const [label, successes, expected] of [
  ['an add-only success with a client part owns add; edits post to the plain submit', [{ name: 'Succ', recordEvent: 'on add', client: true }], { AddBody: 'moved', EditBody: 'stay', BothBody: 'copied' }],
  ['an edit-only success with a client part owns only edit posts', [{ name: 'Succ', recordEvent: 'on edit', client: true }], { AddBody: 'stay', EditBody: 'moved', BothBody: 'copied' }],
  ['add- and edit-scoped successes own every submit post', [{ name: 'SuccA', recordEvent: 'on add', client: true }, { name: 'SuccE', recordEvent: 'on edit', client: true }], { AddBody: 'moved', EditBody: 'moved', BothBody: 'moved' }],
  ['a server-only success registers no client handler and owns nothing', [{ name: 'Succ', client: false }], { AddBody: 'stay', EditBody: 'stay', BothBody: 'stay' }],
] as const) {
  test(`submit-scope credit: ${label}`, () => {
    const orders = submitScopeApp([...successes]);
    const out = collectOutputs(orders);
    const successFile = out.files.find((f) => f.path === 'functions/aio/orders/on-success.mjs');
    const submitFile = out.files.find((f) => f.path.startsWith('functions/aio/orders/') && f.source.includes('path: "/forms/Orders/submit"'));
    const subjects = { AddBody: 'add', EditBody: 'edit', BothBody: 'both' } as const;
    for (const [name, where] of Object.entries(expected)) {
      const entry = out.coverage?.find((c) => c.name === name);
      assert.ok(entry, name);
      // Merged or not, the body runs: owned scopes inside the success module,
      // the rest on the `/submit` posts the generated UI still sends.
      assert.equal(entry.serverInvoked, true, name);
      const counted = out.todos.some((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === entry.start);
      assert.equal(counted, false, `${name} counted`);
      const tag = `"subject": "${subjects[name as keyof typeof subjects]}"`;
      const inSuccess = successFile ? successFile.source.split(tag).length - 1 : 0;
      const inSubmit = submitFile ? submitFile.source.split(tag).length - 1 : 0;
      if (where === 'moved') {
        assert.ok(successFile, 'success module emitted');
        assert.ok(entry.paths.includes(successFile!.path), `${name} credits the success module`);
        assert.ok(!submitFile || !entry.paths.includes(submitFile.path), `${name} out of the submit module`);
        assert.equal(inSuccess, 1, `${name} merged body runs exactly once on success`);
        assert.equal(inSubmit, 0, `${name} absent from submit`);
      } else if (where === 'copied') {
        assert.ok(successFile && submitFile, 'both modules emitted');
        assert.ok(entry.paths.includes(successFile!.path) && entry.paths.includes(submitFile!.path), `${name} credits both modules`);
        assert.equal(inSuccess, 1, `${name} merged once on success`);
        assert.equal(inSubmit, 1, `${name} kept once on submit`);
      } else {
        assert.ok(submitFile, 'submit module emitted');
        assert.ok(entry.paths.includes(submitFile!.path), `${name} credits the submit module`);
        assert.equal(inSuccess, 0, `${name} not in success`);
        assert.equal(inSubmit, 1, `${name} once on submit`);
      }
    }
    assert.equal(auditApp(orders, out).filter((d) => d.kind === 'workflow').length, 0);
  });
}

test('merged submit bodies run after the on-success body, under their owned scope, only after the write', () => {
  const orders = submitScopeApp([{ name: 'Succ', recordEvent: 'on add', client: true }]);
  const out = collectOutputs(orders);
  const success = out.files.find((f) => f.path === 'functions/aio/orders/on-success.mjs')!;
  assert.ok(success);
  const handle = success.source.slice(success.source.indexOf('export async function handle'));
  // The success script runs first; the merged `on add` body follows it.
  const succAt = handle.indexOf('"subject": "Succ"');
  const mergedAt = handle.indexOf('"subject": "add"');
  assert.ok(succAt > -1 && mergedAt > succAt, 'merged body keeps the original order after the on-success body');
  // Scope guard: the add-owned merge runs only on add posts.
  const guardAt = handle.lastIndexOf('if (!ctx.rowId)', mergedAt);
  assert.ok(guardAt > succAt && guardAt < mergedAt, 'merged add body is guarded to add posts');
  // The body runs inside handle(ctx), which the handler calls only after
  // writeLive commits the row and the validate siblings pass.
  const callAt = success.source.indexOf('await handle(ctx)');
  const writeAt = success.source.indexOf('await writeLive(');
  const mergedFileAt = success.source.indexOf('"subject": "add"');
  assert.ok(writeAt > -1 && callAt > writeAt, 'handle runs after the committed write');
  assert.ok(mergedFileAt > success.source.indexOf('export async function handle'), 'merged body is inside handle');
});

test('a submit body reading client-only request state stays counted', () => {
  // The merge must not lift a body that reads state only a generated client
  // posts; the predicate is the fail-closed gate the plan applies.
  assert.equal(submitBodyReadsClientState('const row = shim.subform.currentRow(ctx, "Sub");\nctx.subformRow;'), true);
  assert.equal(submitBodyReadsClientState('await shim.mail.send(ctx, {});'), false);
});

// An unsafe submit-kind body must never merge into the on-success module:
// the merged body runs after `writeLive` commits the row, so a `cancel
// submit`, an `input` write the saved row needs, or an alert to the
// submitter would silently change behavior. Each case is its own .ds — one
// marker per shape — so dropping a marker from submitMergeBlockers fails
// exactly the case it guards. The add-scoped success owns every add post.
const mergeGuardDs = (deluge: string): App =>
  dsApp(`
	form Orders
	{
		Title
		(
			type = text
		)
	}
	workflow
	{
	form
	{
		Guard_W
		{
			type =  form
			form = Orders
			on add
			{
				actions
				{
					on success
					(
						openUrl("https://example.com", "same window");
						sendmail
						(
							from : "zoho.loginuserid"
							to : "a@b.c"
							subject : "safe"
							message : "hi"
						)
					)
				}
				actions
				{
					${deluge}
				}
			}
		}
	}
	}
`);

for (const [label, deluge, reason] of [
  [
    'a `cancel submit` body',
    `cancel submit;
					sendmail
					(
						from : "zoho.loginuserid"
						to : "u@b.c"
						subject : "unsafe"
						message : "hi"
					)`,
    'cancels-submit',
  ],
  [
    'an `input` write the saved row needs',
    `input.Title = "unsafe";
					sendmail
					(
						from : "zoho.loginuserid"
						to : "u@b.c"
						subject : "unsafe"
						message : "hi"
					)`,
    'writes-input',
  ],
  [
    'an `alert` to the submitter',
    `alert "careful";
					sendmail
					(
						from : "zoho.loginuserid"
						to : "u@b.c"
						subject : "unsafe"
						message : "hi"
					)`,
    'alerts',
  ],
  [
    'an `info` to the submitter',
    `info "note";
					sendmail
					(
						from : "zoho.loginuserid"
						to : "u@b.c"
						subject : "unsafe"
						message : "hi"
					)`,
    'alerts',
  ],
] as const) {
  test(`a submit body with ${label} stays counted instead of merging post-commit`, () => {
    const source = mergeGuardDs(deluge);
    const out = collectOutputs(source);
    const entry = out.coverage?.find((c) => c.name === 'Guard_W' && c.event === 'on add');
    assert.ok(entry, 'the bare on add body is tracked');
    assert.equal(entry.serverInvoked, false);
    const todo = out.todos.find((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === entry.start);
    assert.ok(todo, 'the body stays a counted uninvoked todo');
    assert.deepEqual(todo.manualReasons, [reason]);
    const success = out.files.find((f) => f.path === 'functions/aio/orders/on-success.mjs');
    assert.ok(success, 'the owning success module is emitted');
    // The unsafe body never reaches the post-commit module; the safe
    // on-success script is still there.
    assert.equal(success.source.split('"subject": "unsafe"').length - 1, 0);
    assert.equal(success.source.split('"subject": "safe"').length - 1, 1);
    assert.ok(!entry.paths.includes(success.path));
  });
}

test('a clean post-save submit body still merges once, after the write', () => {
  const source = mergeGuardDs(`sendmail
					(
						from : "zoho.loginuserid"
						to : "u@b.c"
						subject : "unsafe"
						message : "hi"
					)`);
  const out = collectOutputs(source);
  const entry = out.coverage?.find((c) => c.name === 'Guard_W' && c.event === 'on add');
  assert.ok(entry);
  assert.equal(entry.serverInvoked, true);
  const todo = out.todos.find((t) => t.construct === FORM_EVENT_SERVER_UNINVOKED && t.start === entry.start);
  assert.equal(todo, undefined);
  const success = out.files.find((f) => f.path === 'functions/aio/orders/on-success.mjs')!;
  assert.ok(success);
  assert.equal(success.source.split('"subject": "unsafe"').length - 1, 1);
  assert.ok(entry.paths.includes(success.path));
  const handle = success.source.slice(success.source.indexOf('export async function handle'));
  assert.ok(handle.indexOf('"subject": "unsafe"') > handle.indexOf('"subject": "safe"'), 'merged body runs after the on-success body');
  assert.ok(success.source.indexOf('await handle(ctx)') > success.source.indexOf('await writeLive('), 'handle runs after the write');
});

test('the merge predicate fails closed on a non post-save or unknown phase', () => {
  const mail = 'sendmail[from: zoho.loginuserid to: "a@b.c" subject: "s" message: "hi"];';
  const serverMail = 'await shim.mail.send(ctx, {});';
  // A phase-qualified event (on validate) and every event this model does
  // not name as the post-save slot are not provably post-save: they stay.
  for (const event of ['on validate', 'on submit', 'on load', 'on frobnicate']) {
    const reasons = submitMergeBlockers(workflow({ name: 'W', event, deluge: { text: mail, span: Z } }), serverMail);
    assert.deepEqual(reasons, ['pre-save-phase'], event);
  }
  // A bare `actions` script under `on add` / `on edit` / `on add or edit` is
  // Creator's post-save slot; a clean body lists no blocker.
  for (const event of ['on add', 'on edit', 'on add or edit']) {
    assert.deepEqual(submitMergeBlockers(workflow({ name: 'W', event, deluge: { text: mail, span: Z } }), serverMail), [], event);
  }
  // Each unsafe marker alone is its own blocker; a body carrying several
  // lists them all.
  const w = (event: string, text: string) => workflow({ name: 'W', event, deluge: { text, span: Z } });
  assert.deepEqual(submitMergeBlockers(w('on add', 'cancel submit;'), serverMail), ['cancels-submit']);
  assert.deepEqual(submitMergeBlockers(w('on add', 'input.Title = "x";'), serverMail), ['writes-input']);
  assert.deepEqual(submitMergeBlockers(w('on add', 'input.Tags:ui.add(tags);'), serverMail), ['writes-input']);
  assert.deepEqual(submitMergeBlockers(w('on add', 'alert "no";'), serverMail), ['alerts']);
  assert.deepEqual(submitMergeBlockers(w('on add', 'x = ctx.subformRow;'), 'ctx.subformRow;'), ['reads-client-state']);
});

function dsApp(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

function rowStatus(source: App, out: ReturnType<typeof collectOutputs>, name: string): string | undefined {
  return coverageLedger(source, out).find((row) => row.name === name)?.status;
}

const LINKED_PAIR = `
	form Company
	{
		Branches
		(
			type = grid
			values = Site.ID
			bidirectional = Owner
		)
	}
	form Site
	{
		Name
		(
			type = text
		)
		Owner
		(
			type = picklist
			values = Company.ID
			bidirectional = Branches
		)
	}
`;

test('a bidirectional lookup pair is emitted only when the schema stores its named reverse column', () => {
  const source = dsApp(LINKED_PAIR);
  const out = collectOutputs(source);
  assert.equal(rowStatus(source, out, 'Company.Branches property bidirectional'), 'emitted');
  assert.equal(rowStatus(source, out, 'Site.Owner property bidirectional'), 'emitted');

  // The reverse relation gone from the generated schema: both sides drop.
  const unrelated = cloneOutputs(out);
  for (const table of unrelated.schema.tables) {
    for (const column of table.columns) if (column.name === 'Owner') delete column.relation;
  }
  assert.equal(rowStatus(source, unrelated, 'Company.Branches property bidirectional'), 'dropped');
  assert.equal(rowStatus(source, unrelated, 'Site.Owner property bidirectional'), 'dropped');

  // A generator that ignored the name and added its fallback back column.
  const fallback = cloneOutputs(out);
  const site = fallback.schema.tables.find((table) => table.form === 'Site')!;
  const owner = site.columns.find((column) => column.name === 'Owner')!;
  site.columns.push({ ...owner, name: 'Company_id', creatorType: 'subform', field: undefined });
  assert.equal(rowStatus(source, fallback, 'Company.Branches property bidirectional'), 'dropped');
  assert.equal(rowStatus(source, fallback, 'Site.Owner property bidirectional'), 'dropped');
});

test('a grid whose reverse field is not declared is proved by the back column the schema generator creates', () => {
  const source = dsApp(`
	form Company
	{
		Branches
		(
			type = grid
			values = Site.ID
			bidirectional = Head_Office
		)
	}
	form Site
	{
		Name
		(
			type = text
		)
	}
`);
  const out = collectOutputs(source);
  const back = out.schema.tables.find((table) => table.form === 'Site')!.columns.find((column) => column.name === 'Head_Office');
  assert.equal(back?.relation?.table, out.schema.tables.find((table) => table.form === 'Company')!.name);
  assert.equal(rowStatus(source, out, 'Company.Branches property bidirectional'), 'emitted');

  const missing = cloneOutputs(out);
  const site = missing.schema.tables.find((table) => table.form === 'Site')!;
  site.columns = site.columns.filter((column) => column.name !== 'Head_Office');
  assert.equal(rowStatus(source, missing, 'Company.Branches property bidirectional'), 'dropped');
});

test('a same-named lookup on a child table never proves the reverse column of the form table', () => {
  const source = dsApp(`
	form Parent
	{
		Kids
		(
			type = grid
			values = Child.ID
			bidirectional = Back
		)
	}
	form Child
	{
		Back
		(
			type = text
		)
		Inner
		(
			type = grid
			Back
			(
				type = picklist
				values = Parent.ID
			)
		)
	}
`);
  const out = collectOutputs(source);
  const parent = out.schema.tables.find((table) => table.form === 'Parent' && table.role === 'form')!;
  const inner = out.schema.tables.find((table) => table.form === 'Child' && table.role !== 'form' && table.columns.some((column) => column.name === 'Back'));
  assert.equal(inner?.columns.find((column) => column.name === 'Back')?.relation?.table, parent.name);
  const own = out.schema.tables.find((table) => table.form === 'Child' && table.role === 'form')!;
  assert.equal(own.columns.find((column) => column.name === 'Back')?.relation, undefined);
  assert.equal(rowStatus(source, out, 'Parent.Kids property bidirectional'), 'dropped');
});

test('a bidirectional pair without a linked grid side gets no reverse relation and stays a drop', () => {
  const source = dsApp(`
	form Company
	{
		Main_Site
		(
			type = picklist
			values = Site.ID
			bidirectional = Owner
		)
	}
	form Site
	{
		Owner
		(
			type = picklist
			values = Company.ID
			bidirectional = Main_Site
		)
	}
`);
  const out = collectOutputs(source);
  assert.equal(rowStatus(source, out, 'Company.Main_Site property bidirectional'), 'dropped');
  assert.equal(rowStatus(source, out, 'Site.Owner property bidirectional'), 'dropped');
});

test('alloweddays is emitted only for every weekday on a generated date widget', () => {
  const days = (value: string, type = 'date'): string => `
	form Visit
	{
		Day
		(
			type = ${type}
			alloweddays = ${value}
		)
	}
`;
  const all = dsApp(days('0,1,2,3,4,5,6'));
  const out = collectOutputs(all);
  assert.equal(rowStatus(all, out, 'Visit.Day property alloweddays'), 'emitted');
  const datetime = dsApp(days('0,1,2,3,4,5,6', 'datetime'));
  assert.equal(rowStatus(datetime, collectOutputs(datetime), 'Visit.Day property alloweddays'), 'emitted');

  // A restricted set is not enforced by the generated input.
  for (const value of ['1,2,3,4,5', '0', '0,1,2,3,4,5,5']) {
    const restricted = dsApp(days(value));
    assert.equal(rowStatus(restricted, collectOutputs(restricted), 'Visit.Day property alloweddays'), 'dropped', value);
  }

  // Not a native date input any more: the default is no longer shown to hold.
  const notDate = cloneOutputs(out);
  notDate.model.forms[0]!.fields.find((item) => item.name === 'Day')!.widget = 'text';
  assert.equal(rowStatus(all, notDate, 'Visit.Day property alloweddays'), 'dropped');
});

const LOOKUP_APP = `
	form Course
	{
		Course_Name
		(
			type = text
		)
	}
	form Enrolment
	{
		Course
		(
			type = picklist
			values = Course.ID
			displayformat = [Course_Name]
			searchable = true
		)
	}
`;

type CarriedLookup = { form: string; field?: string; displayFields?: string[]; displayFormat?: unknown[] };

function lookupUi(out: ReturnType<typeof collectOutputs>) {
  return out.model.forms.find((f) => f.name === 'Enrolment')!.fields.find((f) => f.name === 'Course')!;
}

test('displayformat is emitted only when the generated lookup carries its resolved display field', () => {
  const source = dsApp(LOOKUP_APP);
  const out = collectOutputs(source);
  const name = 'Enrolment.Course property displayformat';
  assert.equal(lookupUi(out).lookup?.field, 'Course_Name');
  assert.equal(rowStatus(source, out, name), 'emitted');

  // The generated lookup resolves to a different parent field: the .ds format was not carried.
  const wrong = cloneOutputs(out);
  lookupUi(wrong).lookup!.field = 'ID';
  assert.equal(rowStatus(source, wrong, name), 'dropped');

  // No generated lookup at all: the format has nowhere to live.
  const gone = cloneOutputs(out);
  delete lookupUi(gone).lookup;
  assert.equal(rowStatus(source, gone, name), 'dropped');
});

test('a multi-field displayformat is emitted only when the generated lookup carries its format terms', () => {
  const source = dsApp(`
	form Person
	{
		First_Name
		(
			type = text
		)
	}
	form Booking
	{
		Guest
		(
			type = picklist
			values = Person.ID
			displayformat = [Person.First_Name + " (" + Person.ID + ")"]
		)
	}
`);
  const out = collectOutputs(source);
  const name = 'Booking.Guest property displayformat';
  const ui = out.model.forms.find((f) => f.name === 'Booking')!.fields.find((f) => f.name === 'Guest')!;
  const carried = ui.lookup as CarriedLookup | undefined;
  assert.equal(carried?.field, 'Person');
  assert.ok(carried?.displayFields?.length || carried?.displayFormat?.length);
  assert.equal(rowStatus(source, out, name), 'emitted');

  // The generated lookup kept only the first field of the format: terms dropped.
  const flat = cloneOutputs(out);
  const got = flat.model.forms.find((f) => f.name === 'Booking')!.fields.find((f) => f.name === 'Guest')!;
  const gotLookup = got.lookup as CarriedLookup | undefined;
  delete gotLookup!.displayFields;
  delete gotLookup!.displayFormat;
  assert.equal(rowStatus(source, flat, name), 'dropped');
});

test('a notes field value is emitted only as the generated notesHtml', () => {
  const source = dsApp(`
	form Board
	{
		Note
		(
			type = add-notes
			value = "<b>Info</b> banner"
		)
	}
`);
  const out = collectOutputs(source);
  const name = 'Board.Note property value';
  const ui = out.model.forms[0]!.fields.find((f) => f.name === 'Note')!;
  assert.equal(ui.widget, 'notes');
  assert.equal(ui.notesHtml, '<b>Info</b> banner');
  assert.equal(rowStatus(source, out, name), 'emitted');

  // The notes widget lost its stored markup.
  const gone = cloneOutputs(out);
  delete gone.model.forms[0]!.fields.find((f) => f.name === 'Note')!.notesHtml;
  assert.equal(rowStatus(source, gone, name), 'dropped');

  // A different markup text: the .ds value was not carried.
  const wrong = cloneOutputs(out);
  wrong.model.forms[0]!.fields.find((f) => f.name === 'Note')!.notesHtml = '<b>Other</b>';
  assert.equal(rowStatus(source, wrong, name), 'dropped');

  // The same property on a non-notes widget is never proved by notesHtml.
  const text = dsApp(`
	form Board
	{
		Note
		(
			type = text
			value = "x"
		)
	}
`);
  assert.equal(rowStatus(text, collectOutputs(text), 'Board.Note property value'), 'dropped');
});

test('flag description and a help_text annotation are emitted only as the generated help', () => {
  const source = dsApp(`
	form Visit
	{
		Notes
		(
			type = text
			description
			[
				type = help_text
				message = "Bring ID"
			]
		)
	}
`);
  const out = collectOutputs(source);
  const ui = out.model.forms[0]!.fields.find((f) => f.name === 'Notes')!;
  assert.equal(ui.help, 'Bring ID');
  const annotationRow = coverageLedger(source, out).find((row) => row.name.startsWith('Visit.Notes annotation'));
  assert.equal(annotationRow?.status, 'emitted');
  assert.equal(rowStatus(source, out, 'Visit.Notes flag description'), 'emitted');

  // The generated field carries different help text: neither item was carried.
  const wrong = cloneOutputs(out);
  wrong.model.forms[0]!.fields.find((f) => f.name === 'Notes')!.help = 'Other text';
  assert.equal(rowStatus(source, wrong, 'Visit.Notes flag description'), 'dropped');
  assert.equal(coverageLedger(source, wrong).find((row) => row.name.startsWith('Visit.Notes annotation'))?.status, 'dropped');

  // No generated help at all.
  const gone = cloneOutputs(out);
  delete gone.model.forms[0]!.fields.find((f) => f.name === 'Notes')!.help;
  assert.equal(rowStatus(source, gone, 'Visit.Notes flag description'), 'dropped');

  // A description flag with no help_text message has nothing carried.
  const bare = dsApp(`
	form Visit
	{
		Notes
		(
			type = text
			description
		)
	}
`);
  assert.equal(rowStatus(bare, collectOutputs(bare), 'Visit.Notes flag description'), 'dropped');
});

test('a non-help_text annotation is still a silent drop', () => {
  const source = dsApp(`
	form Visit
	{
		Notes
		(
			type = text
			[
				type = tooltip
				message = "Hover me"
			]
		)
	}
`);
  const out = collectOutputs(source);
  const row = coverageLedger(source, out).find((r) => r.name.startsWith('Visit.Notes annotation'));
  assert.equal(row?.status, 'dropped');
});

test('searchable is emitted only when the field generated a lookup widget', () => {
  const source = dsApp(LOOKUP_APP);
  const out = collectOutputs(source);
  const name = 'Enrolment.Course property searchable';
  assert.equal(rowStatus(source, out, name), 'emitted');

  // The lookup widget is gone: the ?q= endpoint it searches no longer exists.
  const gone = cloneOutputs(out);
  delete lookupUi(gone).lookup;
  assert.equal(rowStatus(source, gone, name), 'dropped');

  // searchable = false is not honoured by the always-searchable endpoint.
  const off = dsApp(`
	form Course
	{
		Course_Name
		(
			type = text
		)
	}
	form Enrolment
	{
		Course
		(
			type = picklist
			values = Course.ID
			searchable = false
		)
	}
`);
  assert.equal(rowStatus(off, collectOutputs(off), 'Enrolment.Course property searchable'), 'dropped');
});

test('a report column naming the group field is emitted by the group headers', () => {
  const source = dsApp(`
	form Project
	{
		Status
		(
			type = picklist
			values = {"Open","Closed"}
		)
		Title
		(
			type = text
		)
	}
	report By_Status
	{
		show all rows from Project
		(
			Status as "Status"
			Title
		)
		group by
		(
			Status ascending
		)
	}
`);
  const out = collectOutputs(source);
  const built = out.model.reports.find((r) => r.name === 'By_Status')!;
  assert.equal(built.groupField, 'Status');
  const name = 'By_Status column Status';
  if (!built.columns.some((column) => column.field === 'Status')) {
    // The column reached the model only through the group headers.
    assert.equal(rowStatus(source, out, name), 'emitted');
  }
  // Without the generated group field the column is a silent drop.
  const gone = cloneOutputs(out);
  const mutated = gone.model.reports.find((r) => r.name === 'By_Status')!;
  delete mutated.groupField;
  mutated.columns = mutated.columns.filter((column) => column.field !== 'Status');
  mutated.phoneColumns = (mutated.phoneColumns ?? []).filter((column) => column.field !== 'Status');
  for (const block of mutated.detailBlocks ?? []) block.fields = block.fields.filter((item) => item.field !== 'Status');
  assert.equal(rowStatus(source, gone, name), 'dropped');
});

const USERS_LOOKUP_APP = `
	form Raise_an_Idea
	{
		Idea
		(
			type = text
		)
		Approver
		(
			type = picklist
			module = users
			displayformat = [username]
		)
	}
`;

function approverUi(out: ReturnType<typeof collectOutputs>) {
  return out.model.forms.find((f) => f.name === 'Raise_an_Idea')!.fields.find((f) => f.name === 'Approver')!;
}

test('module = users and its displayformat are emitted only by the generated users lookup', () => {
  const source = dsApp(USERS_LOOKUP_APP);
  const out = collectOutputs(source);
  const moduleRow = 'Raise_an_Idea.Approver property module';
  const formatRow = 'Raise_an_Idea.Approver property displayformat';
  assert.equal(approverUi(out).widget, 'users');
  assert.deepEqual(approverUi(out).lookup, { form: 'users', field: 'username', endpoint: '/lookups/users/username' });
  assert.equal(rowStatus(source, out, moduleRow), 'emitted');
  assert.equal(rowStatus(source, out, formatRow), 'emitted');

  // Remove the generated lookup: both items return.
  const gone = cloneOutputs(out);
  delete approverUi(gone).lookup;
  assert.equal(rowStatus(source, gone, moduleRow), 'dropped');
  assert.equal(rowStatus(source, gone, formatRow), 'dropped');

  // A lookup bound to an ordinary form is not the system Users module.
  const wrong = cloneOutputs(out);
  approverUi(wrong).lookup!.form = 'Employee';
  approverUi(wrong).lookup!.endpoint = '/lookups/Employee/username';
  assert.equal(rowStatus(source, wrong, moduleRow), 'dropped');

  // The users widget without its endpoint serves nothing.
  const noRoute = cloneOutputs(out);
  delete (approverUi(noRoute).lookup as { endpoint?: string }).endpoint;
  assert.equal(rowStatus(source, noRoute, moduleRow), 'dropped');

  // A lookup resolving to a different display attribute did not carry the format.
  const other = cloneOutputs(out);
  approverUi(other).lookup!.field = 'email';
  assert.equal(rowStatus(source, other, formatRow), 'dropped');
});

test('a source list the generated controls draw is emitted; an undrawn source stays a drop', () => {
  const photo = (value: string, type = 'image'): string => `
	form Profile
	{
		Photo
		(
			type = ${type}
			source = ${value}
		)
	}
`;
  for (const value of ['file', 'public_url,file', 'public_url,file,camera', 'file,camera', 'public_url']) {
    const source = dsApp(photo(value));
    assert.equal(rowStatus(source, collectOutputs(source), 'Profile.Photo property source'), 'emitted', value);
  }
  // `source` is honoured on the generic file widget too, not only image.
  const fileField = dsApp(photo('file', 'upload file'));
  assert.equal(rowStatus(fileField, collectOutputs(fileField), 'Profile.Photo property source'), 'emitted');

  // A source token the controls do not draw keeps the whole property counted.
  const unknown = dsApp(photo('web,file'));
  assert.equal(rowStatus(unknown, collectOutputs(unknown), 'Profile.Photo property source'), 'dropped');

  // The proof is the carried list: a field without it is a drop again.
  const source = dsApp(photo('file'));
  const missing = cloneOutputs(collectOutputs(source));
  delete missing.model.forms[0]!.fields.find((item) => item.name === 'Photo')!.uploadSources;
  assert.equal(rowStatus(source, missing, 'Profile.Photo property source'), 'dropped');
});

test('preview duration = 0 on an image field is emitted; non-zero stays a drop', () => {
  const photo = (duration: string): string => `
	form Profile
	{
		Photo
		(
			type = image
			preview duration = ${duration}
		)
	}
`;
  const defaultZero = dsApp(photo('0'));
  assert.equal(rowStatus(defaultZero, collectOutputs(defaultZero), 'Profile.Photo property preview duration'), 'emitted');

  const nonZero = dsApp(photo('3'));
  assert.equal(rowStatus(nonZero, collectOutputs(nonZero), 'Profile.Photo property preview duration'), 'dropped');

  // Mutation test: breaking default equivalence makes preview duration = 0 a drop again.
  const mutated = cloneOutputs(collectOutputs(defaultZero));
  mutated.model.forms[0]!.fields.find((f) => f.name === 'Photo')!.widget = 'text';
  assert.equal(rowStatus(defaultZero, mutated, 'Profile.Photo property preview duration'), 'dropped');
});

test('browse = local_drive is emitted; uncarried cloud docs emit counted UI todo; unknown stays drop', () => {
  const fileField = (browse: string): string => `
	form Attachment
	{
		File_Attachment
		(
			type = upload file
			browse = ${browse}
		)
	}
`;
  const localOnly = dsApp(fileField('local_drive'));
  assert.equal(rowStatus(localOnly, collectOutputs(localOnly), 'Attachment.File_Attachment property browse'), 'emitted');

  const cloudSources = dsApp(fileField('local_drive, google_docs, zoho_docs'));
  const cloudOut = collectOutputs(cloudSources);
  assert.equal(rowStatus(cloudSources, cloudOut, 'Attachment.File_Attachment property browse'), 'counted');
  const todo = cloudOut.model.todos.find((t) => t.name === 'Attachment.File_Attachment property browse');
  assert.ok(todo, 'UI todo is emitted for uncarried cloud browse options');
  assert.ok(todo.reason.includes('google_docs, zoho_docs'));
  assert.ok(todo.manualStep?.includes('Google Drive, Zoho WorkDrive'));

  // Unknown browse source stays a drop.
  const unknown = dsApp(fileField('local_drive, dropbox'));
  assert.equal(rowStatus(unknown, collectOutputs(unknown), 'Attachment.File_Attachment property browse'), 'dropped');

  // Mutation test: removing the UI todo makes local_drive, google_docs, zoho_docs a drop again.
  const mutated = cloneOutputs(cloudOut);
  mutated.model.todos = mutated.model.todos.filter((t) => t.name !== 'Attachment.File_Attachment property browse');
  assert.equal(rowStatus(cloudSources, mutated, 'Attachment.File_Attachment property browse'), 'dropped');
});

test('gallery apps: Contacts preview duration is emitted, TaskzDone browse is counted', { skip: !process.env.C2C_FIXTURES_DIR ? 'C2C_FIXTURES_DIR is not set' : false }, () => {
  const gallery = join(process.env.C2C_FIXTURES_DIR!, 'gallery');
  const contacts = parseProject(join(gallery, 'contacts')).ir;
  assert.equal(rowStatus(contacts, collectOutputs(contacts), 'New_Contact.Picture property preview duration'), 'emitted');

  const taskzdone = parseProject(join(gallery, 'taskzdone')).ir;
  const taskzOut = collectOutputs(taskzdone);
  assert.equal(rowStatus(taskzdone, taskzOut, 'Add_Attachment.File_Attachment property browse'), 'counted');
  const todo = taskzOut.model.todos.find((t) => t.name === 'Add_Attachment.File_Attachment property browse');
  assert.ok(todo, 'TaskzDone Add_Attachment.File_Attachment property browse has a counted UI todo');
});

test('allow new entries and its displayname dialog title are emitted through the lookup picker', () => {
  const source = `application "Demo"
{
\tsection Main
\t{
\t\tform Department
\t\t{
\t\t\tDepartment_Name
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tform Course
\t\t{
\t\t\tDepartment
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = Department.ID
\t\t\t\tdisplayformat = [Department_Name]
\t\t\t\tallow new entries
\t\t\t\t[
\t\t\t\t\tdisplayname = "Add New Department"
\t\t\t\t]
\t\t\t)
\t\t}
\t}
}
`;
  const appUnderTest = deriveIr(parse(source));
  const out = collectOutputs(appUnderTest);
  const rows = coverageLedger(appUnderTest, out);
  assert.equal(
    rows.find((row) => row.name === 'Course.Department flag allow new entries')?.status,
    'emitted',
    'the picker opens the parent form add screen and selects the new row',
  );
  assert.equal(
    rows.find((row) => row.name.startsWith('Course.Department annotation'))?.status,
    'emitted',
    'the displayname annotation is the add-new dialog title',
  );

  // Mutation: remove the carried affordance and the same constructs drop again.
  const without = cloneOutputs(out);
  delete without.model.forms.find((form) => form.name === 'Course')!.fields.find((item) => item.name === 'Department')!.lookup!.addNew;
  const names = dropNames(appUnderTest, without);
  assert.ok(names.includes('Course.Department flag allow new entries'), names.join(', '));
  assert.ok(names.some((name) => name.startsWith('Course.Department annotation')), names.join(', '));
});
