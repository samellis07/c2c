import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type App, type Field, type Workflow } from '../../core/src/index.js';
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
