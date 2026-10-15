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
