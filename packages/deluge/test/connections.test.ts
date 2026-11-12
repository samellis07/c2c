import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type App, type Workflow } from '../../core/src/index.js';
import { analyzeConnections, connectionsChecklist, declaredConnections, scriptUses } from '../src/connections.js';

const Z = { start: 0, end: 0 };

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

function app(partial: Partial<App>): App {
  return { ...emptyApp('empty'), name: 'Demo_App', ...partial };
}

test('a task whose Deluge signature has no connection parameter is diagnosed as such, not as a missing argument', () => {
  for (const task of ['getOrgVariable', 'invokeConnector']) {
    const call = task === 'getOrgVariable' ? 'zoho.crm.getOrgVariable("Score")' : 'zoho.crm.invokeConnector("crm.getorg", {"Fname":"A"})';
    const { uses, diagnostics } = scriptUses(`x = ${call};`, 'wf (on_success)');
    assert.equal(uses.length, 1, task);
    assert.equal(uses[0]!.task, `crm.${task}`);
    const d = diagnostics.find((m) => m.includes(task));
    assert.ok(d, `${task}: a diagnostic should note the configured default connection`);
    assert.doesNotMatch(d!, /passes no connection/, task);
    assert.match(d!, /no connection parameter/, task);
    assert.match(d!, /default:crm/, task);
  }
});

test('a zoho task outside the adapted services is reported as unsupported, not ignored', () => {
  const sms = app({
    workflows: [workflow({ name: 'Notify', form: 'Orders', event: 'on success', deluge: { text: 'zoho.sms.send("template", "9876543210");', span: Z } })],
  });
  const report = analyzeConnections(sms);
  assert.ok(report.unsupported.some((u) => u === 'zoho-task:sms.send'), `sms.send should be unsupported, got ${JSON.stringify(report.unsupported)}`);
});

test('locally evaluated zoho calls stay out of the connections report', () => {
  const local = app({
    workflows: [
      workflow({ name: 'Stamp', form: 'Orders', event: 'on success', deluge: { text: 'd = zoho.currentdate.addDay(1); e = zoho.encryption.urlEncode("a b");', span: Z } }),
    ],
  });
  const report = analyzeConnections(local);
  assert.equal(report.entries.length, 0);
  assert.equal(report.unsupported.length, 0);
  assert.equal(report.diagnostics.length, 0);
});

test('an invokeurl without a connection is diagnosed and reported as unsupported', () => {
  const conn = app({
    workflows: [
      workflow({ name: 'Fetch', form: 'Orders', event: 'on success', deluge: { text: 'resp = invokeurl[url: "https://example.test/hook" type: GET];', span: Z } }),
    ],
  });
  const report = analyzeConnections(conn);
  assert.ok(
    report.diagnostics.some((d) => d.includes('Fetch (on success)') && /invokeurl/i.test(d) && /no connection/i.test(d)),
    `connectionless invokeurl should be diagnosed, got ${JSON.stringify(report.diagnostics)}`,
  );
  assert.ok(report.unsupported.some((u) => /invokeurl/i.test(u)), `connectionless invokeurl should be unsupported, got ${JSON.stringify(report.unsupported)}`);
});

test('a declared connection reports its granted scopes so none are dropped silently', () => {
  const conn = app({
    configuration: [
      {
        name: 'connections',
        properties: [],
        items: [],
        blocks: [
          {
            name: 'fs_crm',
            properties: [
              { key: 'displayname', value: '"FS CRM"', span: Z },
              { key: 'connector', value: 'zohocrm1', span: Z },
              { key: 'permissions', value: '{"create_cases_record","fetch_cases_record","search_cases_record","update_cases_record"}', span: Z },
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
  const declared = declaredConnections(conn);
  assert.equal(declared.length, 1);
  assert.deepEqual(declared[0]!.scopes, ['create_cases_record', 'fetch_cases_record', 'search_cases_record', 'update_cases_record']);
  const report = analyzeConnections(conn);
  assert.ok(
    report.diagnostics.some((d) => d.includes('fs_crm') && d.includes('create_cases_record') && d.includes('update_cases_record')),
    `the declared scopes should be listed, got ${JSON.stringify(report.diagnostics)}`,
  );
});

test('a permissions value that is not scope-name shaped is reported but never echoed', () => {
  const conn = app({
    configuration: [
      {
        name: 'connections',
        properties: [],
        items: [],
        blocks: [
          {
            name: 'fs_books',
            properties: [
              { key: 'displayname', value: '"FS Books"', span: Z },
              { key: 'connector', value: 'zohobooks', span: Z },
              { key: 'client_id', value: '"1000.ABC"', span: Z },
              { key: 'client_secret', value: '"deadbeef"', span: Z },
              { key: 'url', value: '"https://accounts.example"', span: Z },
              { key: 'permissions', value: '{"create_invoice","https://maps.example/secret","get_customer"}', span: Z },
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
  const declared = declaredConnections(conn);
  assert.deepEqual(declared[0]!.scopes, ['create_invoice', 'get_customer']);
  assert.equal(declared[0]!.unverified, 1);
  const report = analyzeConnections(conn);
  assert.ok(
    report.diagnostics.some((d) => d.includes('fs_books') && d.includes('create_invoice') && d.includes('get_customer')),
    `the scope names should be listed, got ${JSON.stringify(report.diagnostics)}`,
  );
  assert.ok(
    report.diagnostics.some((d) => d.includes('fs_books') && /not scope names/.test(d)),
    `the unverified value should be reported, got ${JSON.stringify(report.diagnostics)}`,
  );
  for (const d of report.diagnostics) {
    assert.ok(!d.includes('https://'), `no URL may be echoed, got ${d}`);
    assert.ok(!d.includes('deadbeef') && !d.includes('1000.ABC'), `no sibling property may be echoed, got ${d}`);
  }
});

test('the checklist counts generated and manual calls and names the manual connection and unresolved scope', () => {
  const demo = app({
    workflows: [workflow({
      name: 'Notify', form: 'Orders', event: 'on success',
      deluge: { text: 'a = zoho.crm.createRecord("Leads", {"Last_Name":"x"}, Map(), "fs_crm"); b = zoho.sms.send("template", "123", "fs_sms");', span: Z },
    })],
  });
  const report = analyzeConnections(demo);
  const checklist = connectionsChecklist('Demo_App', report);
  assert.match(checklist, /Integration coverage \(2 detected calls\)/);
  assert.match(checklist, /Generated calls: 1\. Adapter-backed calls: 0\. Manual integration calls: 1\. Manual connection setup steps: 1/);
  assert.match(checklist, /`sms\.send` in Notify \(on success\): connection `fs_sms`; service unknown \(identify by hand\); scope not derivable/);
  assert.match(checklist, /`crm\.createRecord` in Notify \(on success\)/);
});

const KINDS_SCRIPT = [
  'a = zoho.crm.createRecord("Leads", {"Last_Name":"x"}, Map(), "lnk_crm");',
  'b = zoho.desk.create("7000", "tickets", {"subject":"s"}, "lnk_desk");',
  'c = zoho.books.createRecord("contacts", "900", {"name":"n"}, "lnk_books");',
  'd = zoho.cliq.postToChannel("general", "hi", "lnk_cliq");',
  'e = invokeurl[url: "https://www.zohoapis.in/crm/v7/Leads" type: GET connection: "lnk_crm"];',
  'f = invokeurl[url: "https://example.test/hook" type: GET];',
  'g = zoho.sms.send("template", "123", "lnk_sms");',
].join(' ');

function kindsApp(): App {
  return app({
    workflows: [workflow({ name: 'Kinds', form: 'Orders', event: 'on success', deluge: { text: KINDS_SCRIPT, span: Z } })],
  });
}

test('each call kind lands in its own coverage bucket with the right connection and scope', () => {
  const report = analyzeConnections(kindsApp());
  const byLink = new Map(report.entries.map((e) => [e.configKey, e]));
  assert.deepEqual([...byLink.keys()].sort(), ['default:unknown', 'lnk_books', 'lnk_cliq', 'lnk_crm', 'lnk_desk', 'lnk_sms']);
  assert.deepEqual(byLink.get('lnk_crm')!.scopes, ['ZohoCRM.modules.leads.CREATE', 'ZohoCRM.modules.leads.READ']);
  assert.deepEqual(byLink.get('lnk_desk')!.scopes, ['Desk.tickets.CREATE']);
  assert.deepEqual(byLink.get('lnk_books')!.scopes, ['ZohoBooks.contacts.CREATE']);
  assert.deepEqual(byLink.get('lnk_cliq')!.scopes, ['ZohoCliq.Webhooks.CREATE']);
  assert.equal(byLink.get('lnk_crm')!.serviceName, 'Zoho CRM');
  assert.equal(byLink.get('lnk_desk')!.serviceName, 'Zoho Desk');
  assert.equal(byLink.get('lnk_books')!.serviceName, 'Zoho Books');
  assert.equal(byLink.get('lnk_cliq')!.serviceName, 'Zoho Cliq');
  const checklist = connectionsChecklist('Demo_App', report);
  assert.match(checklist, /Integration coverage \(7 detected calls\)/);
  // 4 generated (crm/desk/books/cliq adapters), 1 adapter-backed (connected
  // invokeurl), 2 manual (connectionless invokeurl + sms.send with no adapter).
  assert.match(checklist, /Generated calls: 4\. Adapter-backed calls: 1\. Manual integration calls: 2\. Manual connection setup steps: 3/);
  assert.match(checklist, /### Adapter-backed calls \(configure the connection\)/);
  assert.match(checklist, /`invokeurl GET` in Kinds \(on success\): connection `lnk_crm`; service Zoho CRM; scope `ZohoCRM\.modules\.leads\.READ`/);
  assert.match(checklist, /`invokeurl GET` in Kinds \(on success\): connection `default:unknown`/);
  assert.match(checklist, /`sms\.send` in Kinds \(on success\): connection `lnk_sms`/);
});

test('dropping a call from the report changes the coverage counts (mutation guard)', () => {
  const report = analyzeConnections(kindsApp());
  const drop = (task: string) => {
    const entries = report.entries
      .map((e) => ({ ...e, uses: e.uses.filter((u) => u.task !== task) }))
      .filter((e) => e.uses.length);
    return connectionsChecklist('Demo_App', { ...report, entries });
  };
  // A manual call dropped: the manual and setup counts fall with the total.
  assert.match(drop('sms.send'), /Integration coverage \(6 detected calls\)/);
  assert.match(drop('sms.send'), /Manual integration calls: 1\. Manual connection setup steps: 2/);
  // An adapter-backed call dropped: the adapter-backed bucket empties.
  assert.match(drop('invokeurl GET'), /Integration coverage \(5 detected calls\)/);
  assert.match(drop('invokeurl GET'), /Generated calls: 4\. Adapter-backed calls: 0\. Manual integration calls: 1\. Manual connection setup steps: 1/);
  // A generated call dropped: only the generated count falls.
  assert.match(drop('desk.create'), /Generated calls: 3\. Adapter-backed calls: 1\. Manual integration calls: 2\. Manual connection setup steps: 3/);
});
