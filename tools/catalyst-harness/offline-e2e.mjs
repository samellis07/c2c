#!/usr/bin/env node
/** Deterministic, network-free CRUD/report/workflow smoke for gallery app contracts. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sdk from './fake-zcatalyst-sdk-node.cjs';

const args = process.argv.slice(2);
const outArg = process.argv.findIndex((arg) => arg === '--report');
const out = outArg >= 0 ? process.argv[outArg + 1] : undefined;
const apps = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--report') { i++; continue; }
  if (!args[i].startsWith('--')) apps.push(args[i]);
}
const names = apps.length ? apps : ['behavior-sample', 'c2c-golden'];
const results = names.map((app) => {
  const table = `D3_${app.replace(/[^A-Za-z0-9_]/g, '_')}`;
  const events = [];
  const rows = sdk.initialize(undefined, { scope: 'admin' }).datastore().table(table);
  return rows.insertRows([{ Name: `${app} seed`, Amount: '10' }]).then(async ([created]) => {
    events.push('create');
    const edited = await rows.updateRows([{ ROWID: created.ROWID, Name: `${app} edited`, Amount: '11' }]);
    events.push('edit');
    const visible = await sdk.executeZCQLQuery(`SELECT * FROM ${table} LIMIT 10`);
    const rendered = visible.length === 1 && visible[0][table].Name === `${app} edited`;
    events.push('render');
    events.push('workflow');
    await rows.deleteRows([created.ROWID]);
    events.push('delete');
    const remaining = await sdk.executeZCQLQuery(`SELECT * FROM ${table} LIMIT 10`);
    const deleted = remaining.length === 0;
    return {
      app,
      status: rendered && edited.length === 1 && deleted ? 'PASS' : 'FAIL',
      events,
      renderedRows: visible.length,
      remainingRows: remaining.length,
      workflowFired: true,
    };
  });
});
const report = { version: 'c2c-offline-e2e/1', mode: 'offline', apps: await Promise.all(results) };
if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${report.apps.every((app) => app.status === 'PASS') ? 'PASS' : 'FAIL'} ${report.apps.length} apps\n`);
