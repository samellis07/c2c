import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyApp, type App, type Workflow } from '../../core/src/index.js';
import { analyzeConnections, declaredConnections, scriptUses } from '../src/connections.js';

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
