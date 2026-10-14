import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { computeDelta, readSourceJson, STATE_FILE } from '../../deploy/src/index.js';
import { CHECKLIST_MD, PROOF_JSON, PROOF_MD, cutoverCli, cutoverInput, proofMarkdown, proofReport, type ProofReport } from '../src/cutover.js';

const APP = `application "Shop"
{
form Vendor
{
must have unique Vendor_Name
(
type = text
displayname = "Vendor Name"
)
}
form Purchase_Order
{
must have PO_Title
(
type = text
displayname = "PO Title"
)
must have Vendor
(
type = picklist
values = Vendor.ID
displayformat = [Vendor_Name]
)
}
list All_Vendors
{
show all rows from Vendor
(
Vendor_Name as "Vendor Name"
)
}
list All_Purchase_Orders
{
show all rows from Purchase_Order
(
PO_Title as "PO Title"
Vendor as "Vendor"
)
}
}
`;

function workspace(): { ds: string; source: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-cutover-'));
  const ds = join(dir, 'shop.ds');
  writeFileSync(ds, APP);
  const source = join(dir, 'export');
  mkdirSync(source);
  writeFileSync(join(source, 'All_Vendors.json'), JSON.stringify({ All_Vendors: [{ ID: '11', Vendor_Name: 'Acme' }, { ID: '12', Vendor_Name: 'Northwind' }] }));
  writeFileSync(
    join(source, 'All_Purchase_Orders.json'),
    JSON.stringify({ All_Purchase_Orders: [{ ID: '21', PO_Title: 'Restock', Vendor: { ID: '11' } }] }),
  );
  const state = join(dir, 'deploy');
  mkdirSync(state);
  return { ds, source, state };
}

function capture() {
  let out = '';
  let err = '';
  return { io: { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t) }, out: () => out, err: () => err };
}

test('cutover-checklist is deterministic and filled with the app facts', () => {
  const ws = workspace();
  const args = [ws.ds, '--source-json', ws.source, '--since', ws.state, '--project', '1001', '--dc', 'eu'];
  const first = capture();
  const second = capture();
  assert.equal(cutoverCli(args, first.io, 'checklist'), 0, first.err());
  assert.equal(cutoverCli(args, second.io, 'checklist'), 0, second.err());
  assert.equal(first.out(), second.out());
  const text = first.out();
  for (const heading of ['Rollback baseline', 'Freeze Creator edits', 'Final delta', 'Smoke', 'Sign-in', 'Redirect', 'DNS and links', 'Rollback ready', 'Owner sign-off']) {
    assert.match(text, new RegExp(`^## \\d+\\. ${heading}$`, 'm'));
  }
  // The rollback export is taken before the freeze as the pre-cut-over baseline.
  const order = ['Rollback baseline', 'Freeze Creator edits', 'Redirect', 'Rollback ready', 'Owner sign-off'].map((heading) =>
    text.indexOf(` ${heading}`),
  );
  for (let i = 1; i < order.length; i++) assert.ok(order[i]! > order[i - 1]!, `${order} should ascend`);
  assert.match(text, /## 1\. Rollback baseline\n\n- \[ \] `c2c rollback-export /);
  assert.match(text, /^Project 1001, data centre eu\. 2 form\(s\), 2 table\(s\), 3 record\(s\) in the export\.$/m);
  assert.match(text, /^  - Purchase_Order: 1 new, 0 changed at the last plan$/m);
  assert.match(text, /Open Purchase_Order, add a record/);
});

test('proof report holds counts, checksums, the smoke slot and readiness with manual items', () => {
  const ws = workspace();
  const input = cutoverInput(ws.ds, ['--source-json', ws.source, '--since', ws.state]);
  const before = proofReport(input);
  assert.equal(before.smoke.status, 'not run');
  assert.equal(typeof before.readiness.automatic, 'number');
  assert.ok(before.readiness.manual.includes('owner sign-off'));
  assert.ok(before.readiness.manual.some((item) => item.startsWith('smoke: run c2c smoke')));
  const vendor = before.tables.find((table) => table.table === 'Vendor')!;
  assert.equal(vendor.sourceRows, 2);
  assert.match(vendor.sourceChecksum!, /^[0-9a-f]{64}$/);
  assert.equal(vendor.match, undefined);

  // After the delta is applied the checkpoint matches the export table by table.
  const plan = computeDelta(input.app, readSourceJson(ws.source, input.app), undefined, 'json');
  writeFileSync(join(ws.state, STATE_FILE), JSON.stringify({ version: 1, projectId: '1001', slateUrl: 'https://shop.example.test', delta: plan.next }));
  const smoke = join(ws.state, 'smoke.json');
  writeFileSync(smoke, JSON.stringify({ status: 'pass' }));
  const out = mkdtempSync(join(tmpdir(), 'c2c-proof-'));
  const run = capture();
  assert.equal(cutoverCli([ws.ds, '--source-json', ws.source, '--since', ws.state, '--smoke', smoke, '--out', out], run.io, 'proof'), 0, run.err());
  const proof = JSON.parse(readFileSync(join(out, PROOF_JSON), 'utf8')) as ProofReport;
  assert.equal(proof.smoke.status, 'pass');
  assert.ok(proof.tables.every((table) => table.match === true), JSON.stringify(proof.tables));
  assert.equal(proof.tables.find((table) => table.table === 'Vendor')!.checkpointChecksum, vendor.sourceChecksum);
  assert.equal(proof.readiness.manual.some((item) => item.startsWith('smoke:')), false);
  assert.match(readFileSync(join(out, PROOF_MD), 'utf8'), /^\| Vendor \| Vendor \| 2 \| 2 \| yes \| 0 \| 0 \| 0 \|$/m);
  assert.match(readFileSync(join(out, CHECKLIST_MD), 'utf8'), /redirect is https:\/\/shop\.example\.test/);
});

test('proof reads the report c2c smoke --report writes', () => {
  const ws = workspace();
  const smoke = join(ws.state, 'smoke-report.json');
  writeFileSync(
    smoke,
    JSON.stringify({
      version: 'c2c-smoke-report/1',
      ok: true,
      session: 'app-user',
      lines: ['form-submit: 201 wrote 1000000000000123001', 'report-view: 200 read back'],
    }),
  );
  const input = cutoverInput(ws.ds, ['--smoke', smoke]);
  assert.equal(input.smoke?.status, 'pass');
  assert.equal(input.smoke?.session, 'app-user');
  assert.deepEqual(input.smoke?.lines, ['form-submit: 201 wrote 1000000000000123001', 'report-view: 200 read back']);
  assert.equal(proofReport(input).readiness.manual.some((item) => item.startsWith('smoke:')), false);

  // A failed report keeps the smoke manual item and carries the failed step lines.
  writeFileSync(smoke, JSON.stringify({ version: 'c2c-smoke-report/1', ok: false, session: 'owner', lines: ['report-view: 500 failed'] }));
  const failing = proofReport(cutoverInput(ws.ds, ['--smoke', smoke]));
  assert.equal(failing.smoke.status, 'fail');
  assert.ok(failing.readiness.manual.some((item) => item.startsWith('smoke: fix the failed steps')));
  assert.match(proofMarkdown(failing), /- report-view: 500 failed/);

  // A blocked run names the blocker in the manual item instead.
  writeFileSync(smoke, JSON.stringify({ version: 'c2c-smoke-report/1', ok: false, session: 'owner', blocker: 'not-signed-in https://shop.example.test' }));
  const blocked = proofReport(cutoverInput(ws.ds, ['--smoke', smoke]));
  assert.equal(blocked.smoke.status, 'fail');
  assert.equal(blocked.smoke.blocker, 'not-signed-in https://shop.example.test');
  assert.ok(
    blocked.readiness.manual.includes('smoke: the run was blocked — not-signed-in https://shop.example.test; resolve it and run c2c smoke again'),
    JSON.stringify(blocked.readiness.manual),
  );
  assert.equal(blocked.readiness.manual.some((item) => item.includes('fix the failed steps')), false);
});
