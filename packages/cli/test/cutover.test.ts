import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { computeDelta, readSourceJson, rollbackExportCli, STATE_FILE, type Io } from '../../deploy/src/index.js';
import {
  CHECKLIST_MD,
  PROOF_JSON,
  PROOF_MD,
  cutoverChecklist,
  cutoverCli,
  cutoverInput,
  proofMarkdown,
  proofReport,
  type CutoverInput,
  type ProofReport,
} from '../src/cutover.js';

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

function workspace(): { dir: string; ds: string; source: string; state: string } {
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
  return { dir, ds, source, state };
}

function capture() {
  let out = '';
  let err = '';
  return { io: { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t) }, out: () => out, err: () => err };
}

/** Runs `c2c rollback-export --rows` into `out` and returns the manifest path. */
async function realExport(ws: { ds: string }, out: string): Promise<string> {
  const rows = mkdtempSync(join(tmpdir(), 'c2c-rows-'));
  writeFileSync(
    join(rows, 'Vendor.json'),
    JSON.stringify([
      { ROWID: '1', c2c_source_id: '11', Vendor_Name: 'Acme' },
      { ROWID: '2', c2c_source_id: '12', Vendor_Name: 'Northwind' },
    ]),
  );
  writeFileSync(join(rows, 'Purchase_Order.json'), JSON.stringify([{ ROWID: '3', c2c_source_id: '21', PO_Title: 'Restock', Vendor: '1' }]));
  let err = '';
  const io = {
    stdout: () => {},
    stderr: (t: string) => void (err += t),
    env: {},
    spawn: async () => assert.fail('no catalyst CLI spawn in a cutover test'),
    fetch: async () => assert.fail('no fetch in an offline export'),
  } as unknown as Io;
  assert.equal(await rollbackExportCli(['--ds', ws.ds, '--out', out, '--rows', rows], io), 0, err);
  return join(out, 'c2c-rollback-manifest.json');
}

/** Re-points one manifest files entry or drops tables, then rewrites the manifest. */
function tamperManifest(manifestPath: string, edit: (manifest: Record<string, unknown>) => void): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function checklist(ws: { ds: string; source: string; state: string }, rollbackDir: string): string {
  const run = capture();
  const code = cutoverCli([ws.ds, '--source-json', ws.source, '--since', ws.state, '--rollback-export', rollbackDir], run.io, 'checklist');
  assert.equal(code, 0, run.err());
  return run.out();
}

function markdownCells(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let slashes = 0;
  for (const char of row.trim().slice(1, -1)) {
    if (char === '|' && slashes % 2 === 0) {
      cells.push(cell.trim());
      cell = '';
      slashes = 0;
      continue;
    }
    cell += char;
    slashes = char === '\\' ? slashes + 1 : 0;
  }
  cells.push(cell.trim());
  return cells;
}

test('cutover-checklist escapes supplied smoke lines in the evidence ledger', () => {
  const ws = workspace();
  const smoke = join(ws.state, 'smoke-report.json');
  writeFileSync(
    smoke,
    JSON.stringify({
      version: 'c2c-smoke-report/1',
      ok: true,
      session: 'app-user',
      lines: ['status | detail C:\\path `code`\nnext | segment'],
    }),
  );
  const input = cutoverInput(ws.ds, ['--smoke', smoke]);
  const row = cutoverChecklist(input, proofReport(input))
    .split('\n')
    .find((line) => line.startsWith('| Smoke result:'))!;
  assert.equal(markdownCells(row).length, 3, row);
  assert.ok(row.includes('status \\| detail'), row);
  assert.ok(row.includes('next \\| segment'), row);
  assert.ok(row.includes('\\`code\\`'), row);
});

test('proof and checklist neutralize HTML and Markdown injection in supplied values', () => {
  const hostile = '<script>alert(1)</script> [x](javascript:alert(1)) ![](http://x) a|b `c`';
  const proof: ProofReport = {
    schema: 'c2c-proof/1',
    app: 'Shop',
    checksum: 'sha256 of sorted record fingerprints',
    tables: [
      {
        table: hostile,
        form: 'F',
        sourceRows: 1,
        sourceChecksum: 'a'.repeat(64),
        checkpointRows: 1,
        checkpointChecksum: 'b'.repeat(64),
        match: false,
      },
    ],
    smoke: { status: 'fail', blocker: hostile, lines: [hostile] },
    readiness: { automatic: 50, band: 'mid', manual: [`smoke: ${hostile}`] },
  };
  const md = proofMarkdown(proof);
  assert.ok(!md.includes('<script>'), md);
  assert.ok(md.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), md);
  assert.ok(!md.includes('[x](javascript:'), md);
  assert.ok(md.includes('\\[x\\]'), md);
  assert.ok(!md.includes('![](http://x)'), md);
  assert.ok(md.includes('!\\[\\]'), md);
  // The checksum rows escape the table name too: the pipe cannot split or start a row.
  const checksumLine = md.split('\n').find((line) => line.includes(': export '))!;
  assert.ok(checksumLine.startsWith('- '), checksumLine);
  assert.ok(checksumLine.includes('a\\|b'), checksumLine);
  assert.ok(checksumLine.includes('&lt;script&gt;'), checksumLine);
  // The evidence table cell keeps the hostile line inert inside exactly 3 cells.
  const ws = workspace();
  const smoke = join(ws.state, 'smoke-report.json');
  writeFileSync(smoke, JSON.stringify({ version: 'c2c-smoke-report/1', ok: false, session: 'owner', lines: [hostile] }));
  const input = cutoverInput(ws.ds, ['--smoke', smoke]);
  const row = cutoverChecklist(input, proofReport(input))
    .split('\n')
    .find((line) => line.startsWith('| Smoke result:'))!;
  assert.equal(markdownCells(row).length, 3, row);
  assert.ok(!row.includes('<script>'), row);
  assert.ok(row.includes('&lt;script&gt;'), row);
  assert.ok(!row.includes('[x](javascript:'), row);
  assert.ok(row.includes('\\[x\\]'), row);
  assert.ok(!row.includes('![](http://x)'), row);
  assert.ok(row.includes('!\\[\\]'), row);
});

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
  const steps = text.slice(text.indexOf('## 1. Rollback baseline'));
  const order = ['Rollback baseline', 'Freeze Creator edits', 'Redirect', 'Rollback ready', 'Owner sign-off'].map((heading) =>
    steps.indexOf(` ${heading}`),
  );
  for (let i = 1; i < order.length; i++) assert.ok(order[i]! > order[i - 1]!, `${order} should ascend`);
  assert.match(text, /## 1\. Rollback baseline\n\n- \[ \] `c2c rollback-export /);
  assert.match(text, /^Project 1001, data centre eu\. 2 form\(s\), 2 table\(s\), 3 record\(s\) in the export\.$/m);
  assert.match(text, /^  - Purchase_Order: 1 new, 0 changed at the last plan$/m);
  assert.match(text, /Human: open Purchase_Order in the app, submit a test record, then open its report/);
  assert.match(text, /^\| Check \| Type \| Evidence to record \|$/m);
  assert.match(text, /^\| Source app parses.*\| Verified from local inputs \| c2c-proof.json:/m);
  assert.match(text, /does not query Catalyst, Creator, users, DNS or links/);
  assert.match(text, /Human: in Zoho Creator, open the app permissions/);
  assert.match(text, /After reviewing and approving the plan, run the same command with `--confirm`/);
  assert.match(text, /Human: review c2c-proof.md/);
  // Missing external evidence stays explicitly open; local readiness is not a live cutover pass.
  assert.match(text, /\| Smoke result: not run \| Human check \| Run the smoke command below and save its report/);
  // The smoke step names the page run and the --result-code report, never a --confirm --report as the pass evidence.
  assert.match(text, /^- \[ \] Human: run `c2c smoke <app\.ds> --project 1001 --url [^`]+ --confirm`; it does not drive a browser — it names the app's #\/admin\/smoke page\./m);
  assert.match(text, /^- \[ \] Human: run `c2c smoke <app\.ds> --project 1001 --url [^`]+ --result-code <code> --report <report\.json>`; record report path and result, and pass that report to cutover-checklist with `--smoke`\.$/m);
  assert.doesNotMatch(text, /--confirm --report/);
  assert.match(text, /Human: open Purchase_Order in the app, submit a test record, then open its report/);
});

test('an unreadable target reports the loader error instead of a missing-target error', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('mode-000 permissions are bypassed when running as root');
    return;
  }
  const ws = workspace();
  chmodSync(ws.ds, 0);
  t.after(() => chmodSync(ws.ds, 0o600));
  const run = capture();
  const code = cutoverCli([ws.ds], run.io, 'checklist');
  assert.equal(code, 1);
  assert.match(run.err(), /^c2c: .*EACCES|^c2c: .*permission denied/i);
  assert.doesNotMatch(run.err(), /no such file or directory/);
});

test('a missing cutover target keeps the specific missing-file error', () => {
  const run = capture();
  const code = cutoverCli(['/path/that/does/not/exist.ds'], run.io, 'checklist');
  assert.equal(code, 3);
  assert.match(run.err(), /^c2c: no such file or directory:/);
});

test('proof report holds counts, checksums, the smoke slot and readiness with manual items', () => {
  const ws = workspace();
  const input = cutoverInput(ws.ds, ['--source-json', ws.source, '--since', ws.state]);
  const before = proofReport(input);
  assert.equal(before.smoke.status, 'not run');
  assert.equal(typeof before.readiness.automatic, 'number');
  assert.ok(before.readiness.manual.includes('owner sign-off'));
  // A passing report comes from --result-code; --confirm --report only ever writes a blocked one.
  assert.ok(
    before.readiness.manual.includes(
      'smoke: run c2c smoke --confirm, open the #/admin/smoke page it names signed in as the owner, then run c2c smoke --result-code <code> --report <file> and pass that file with --smoke',
    ),
    JSON.stringify(before.readiness.manual),
  );
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
  assert.match(readFileSync(join(out, CHECKLIST_MD), 'utf8'), /invitation redirect to https:\/\/shop\.example\.test/);
  assert.match(readFileSync(join(out, CHECKLIST_MD), 'utf8'), /Input report: .*smoke\.json/);
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

  // The report `c2c smoke --confirm --report` writes is blocked on the smoke page: the item names the page and --result-code.
  writeFileSync(smoke, JSON.stringify({ version: 'c2c-smoke-report/1', ok: false, session: 'app-user', blocker: 'smoke-page https://shop.example.test/#/admin/smoke' }));
  const guided = proofReport(cutoverInput(ws.ds, ['--smoke', smoke]));
  assert.deepEqual(
    guided.readiness.manual.filter((item) => item.startsWith('smoke:')),
    ['smoke: open https://shop.example.test/#/admin/smoke signed in as the owner, then run c2c smoke --result-code <code> --report <file> and pass that file with --smoke'],
  );
  writeFileSync(smoke, JSON.stringify({ version: 'c2c-smoke-report/1', ok: false, session: 'app-user', blocker: 'smoke-page' }));
  assert.ok(proofReport(cutoverInput(ws.ds, ['--smoke', smoke])).readiness.manual.includes("smoke: open the app's #/admin/smoke page signed in as the owner, then run c2c smoke --result-code <code> --report <file> and pass that file with --smoke"));
});

test('a real rollback-export round trip ticks both rollback items', async () => {
  const ws = workspace();
  const rollbackDir = mkdtempSync(join(tmpdir(), 'c2c-rollback-outside-'));
  const manifestPath = await realExport(ws, rollbackDir);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string; app: string; tables: Record<string, string>; files: Record<string, string> };
  assert.equal(manifest.version, 'c2c-rollback-export/1');
  assert.equal(manifest.app, 'Shop');
  assert.deepEqual(Object.keys(manifest.tables).sort(), ['Purchase_Order', 'Vendor']);
  assert.equal(manifest.tables.Vendor, 'import/Vendor.csv');
  assert.ok(Object.keys(manifest.files).length > 0);
  for (const [path, sum] of Object.entries(manifest.files)) {
    assert.equal(createHash('sha256').update(readFileSync(join(rollbackDir, path))).digest('hex'), sum, `checksum for ${path}`);
  }

  const text = checklist(ws, rollbackDir);
  assert.match(text, /- \[x\] `c2c rollback-export .*\(automatic\)/);
  assert.match(text, /- \[x\] Keep the exported folder somewhere outside this workspace\. \(automatic\)/);
  // Passing the manifest file directly also ticks both rollback items.
  const viaFile = checklist(ws, manifestPath);
  assert.match(viaFile, /- \[x\] `c2c rollback-export .*\(automatic\)/);
  assert.match(viaFile, /- \[x\] Keep the exported folder somewhere outside this workspace\. \(automatic\)/);
  // Human items remain open in the same checklist
  assert.match(text, /- \[ \] Human: notify Shop users of the cut-over window/);
  assert.match(text, /- \[ \] Human: in Zoho Creator, open the app permissions/);
});

test('empty, partial and forged manifests keep the baseline open', async () => {
  const ws = workspace();

  // Empty files map.
  let dir = mkdtempSync(join(tmpdir(), 'c2c-rollback-empty-'));
  let manifestPath = await realExport(ws, dir);
  tamperManifest(manifestPath, (manifest) => {
    manifest.files = {};
  });
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: manifest lists no files\)/);

  // Partial inventory: one table dropped.
  dir = mkdtempSync(join(tmpdir(), 'c2c-rollback-partial-'));
  manifestPath = await realExport(ws, dir);
  tamperManifest(manifestPath, (manifest) => {
    delete (manifest.tables as Record<string, string>).Purchase_Order;
  });
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: manifest table inventory does not match/);

  // Forged version and app identity.
  dir = mkdtempSync(join(tmpdir(), 'c2c-rollback-forged-'));
  manifestPath = await realExport(ws, dir);
  tamperManifest(manifestPath, (manifest) => {
    manifest.version = 'c2c-rollback-manifest/1';
  });
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: manifest version is not c2c-rollback-export\/1\)/);
  tamperManifest(manifestPath, (manifest) => {
    manifest.version = 'c2c-rollback-export/1';
    manifest.app = 'Other';
  });
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: manifest app does not match/);
});

test('checksum mismatch, missing files, path traversal and symlink escapes keep the baseline open', async () => {
  const ws = workspace();

  // A file changed after the export.
  let dir = mkdtempSync(join(tmpdir(), 'c2c-rollback-mismatch-'));
  await realExport(ws, dir);
  writeFileSync(join(dir, 'import', 'Vendor.csv'), 'forged\n');
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: checksum mismatch on import\/Vendor\.csv\)/);

  // A file listed in the manifest is missing from disk.
  dir = mkdtempSync(join(tmpdir(), 'c2c-rollback-missing-file-'));
  await realExport(ws, dir);
  rmSync(join(dir, 'import', 'Vendor.csv'));
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: missing file import\/Vendor\.csv\)/);

  // A file listed in the manifest was replaced with a directory (EISDIR).
  mkdirSync(join(dir, 'import', 'Vendor.csv'));
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: missing file import\/Vendor\.csv\)/);

  // Missing rollback directory or missing manifest file.
  assert.match(checklist(ws, join(dir, 'does-not-exist')), /- \[ \] `c2c rollback-export .*\(open: directory or file does not exist\)/);
  const emptyRollbackDir = mkdtempSync(join(tmpdir(), 'c2c-rollback-no-manifest-'));
  assert.match(checklist(ws, emptyRollbackDir), /- \[ \] `c2c rollback-export .*\(open: no manifest found\)/);

  // A manifest path that escapes the export dir.
  dir = mkdtempSync(join(tmpdir(), 'c2c-rollback-traversal-'));
  const manifestPath = await realExport(ws, dir);
  tamperManifest(manifestPath, (manifest) => {
    (manifest.files as Record<string, string>)['../outside.csv'] = createHash('sha256').update('x').digest('hex');
  });
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: manifest path \.\.\/outside\.csv escapes the export dir\)/);

  // A manifest entry that resolves through a symlink to a file outside the dir.
  dir = mkdtempSync(join(tmpdir(), 'c2c-rollback-filelink-'));
  const secret = join(mkdtempSync(join(tmpdir(), 'c2c-secret-')), 'secret.csv');
  writeFileSync(secret, 'secret\n');
  const linkedManifest = await realExport(ws, dir);
  symlinkSync(secret, join(dir, 'import', 'Linked.csv'));
  tamperManifest(linkedManifest, (manifest) => {
    (manifest.files as Record<string, string>)['import/Linked.csv'] = createHash('sha256').update('secret\n').digest('hex');
  });
  assert.match(checklist(ws, dir), /- \[ \] `c2c rollback-export .*\(open: manifest path import\/Linked\.csv resolves outside the export dir\)/);
});

test('a valid export inside the workspace ticks nothing, even through a symlink', async () => {
  const ws = workspace();
  const insideDir = join(ws.dir, 'rollback');
  await realExport(ws, insideDir);

  const text = checklist(ws, insideDir);
  assert.match(text, /- \[ \] `c2c rollback-export .*\(open: export is inside the workspace\)/);
  assert.match(text, /- \[ \] Keep the exported folder somewhere outside this workspace\. \(open: export is inside the workspace\)/);

  // Reached through a symlink outside the workspace, the real dir still resolves inside.
  const link = join(mkdtempSync(join(tmpdir(), 'c2c-rollback-link-')), 'link');
  symlinkSync(insideDir, link, 'dir');
  const linked = checklist(ws, link);
  assert.match(linked, /- \[ \] `c2c rollback-export .*\(open: export is inside the workspace\)/);
  assert.match(linked, /- \[ \] Keep the exported folder somewhere outside this workspace\. \(open: export is inside the workspace\)/);
});

test('proof file and cutover checklist are byte-identical across two runs with rollback evidence', async () => {
  const ws = workspace();
  const rollbackDir = mkdtempSync(join(tmpdir(), 'c2c-rollback-outside-'));
  await realExport(ws, rollbackDir);

  const out1 = mkdtempSync(join(tmpdir(), 'c2c-proof-run1-'));
  const out2 = mkdtempSync(join(tmpdir(), 'c2c-proof-run2-'));
  const run1 = capture();
  const run2 = capture();

  const args1 = [ws.ds, '--source-json', ws.source, '--since', ws.state, '--rollback-export', rollbackDir, '--out', out1];
  const args2 = [ws.ds, '--source-json', ws.source, '--since', ws.state, '--rollback-export', rollbackDir, '--out', out2];

  assert.equal(cutoverCli(args1, run1.io, 'checklist'), 0, run1.err());
  assert.equal(cutoverCli(args2, run2.io, 'checklist'), 0, run2.err());
  assert.equal(run1.out(), run2.out());

  assert.equal(readFileSync(join(out1, CHECKLIST_MD), 'utf8'), readFileSync(join(out2, CHECKLIST_MD), 'utf8'));
  assert.equal(readFileSync(join(out1, PROOF_JSON), 'utf8'), readFileSync(join(out2, PROOF_JSON), 'utf8'));
  assert.equal(readFileSync(join(out1, PROOF_MD), 'utf8'), readFileSync(join(out2, PROOF_MD), 'utf8'));
});

// Each token is a whole untrusted field. The tail is what mdText must emit for
// `<script>`, `[x](javascript:...)`, a pipe, and a newline plus `# heading`.
// Dropping mdText on any one field leaves that field's raw tail in the output.
const HOSTILE_TAIL = '<script>alert(1)</script> [x](javascript:alert(1)) |\n# heading';
const ESCAPED_TAIL = '&lt;script&gt;alert(1)&lt;/script&gt; \\[x\\](javascript:alert(1)) \\| # heading';

function hostile(field: string): string {
  return `${field} ${HOSTILE_TAIL}`;
}

function assertFieldEscaped(md: string, field: string): void {
  assert.ok(md.includes(`${field} ${ESCAPED_TAIL}`), `${field} bypassed mdText`);
  assert.ok(!md.includes(`${field} <script>`), `${field} leaked a script tag`);
  assert.equal(md.includes('[x](javascript:'), false, `${field} left an active link`);
  assert.equal(
    md.split('\n').some((line) => /^ {0,3}# heading\b/.test(line)),
    false,
    `${field} injected a heading`,
  );
  assert.equal(/(?<!\\)\]\(javascript:/.test(md), false, `${field} opened a javascript link`);
}

test('proof and checklist escape every untrusted field', () => {
  const app = deriveIr(parse(APP));
  app.name = hostile('check.app');
  app.forms[0]!.displayName = hostile('check.formDisplay');
  app.forms[1]!.name = hostile('check.formName');
  app.profiles.push({
    name: hostile('check.role'),
    type: 'Users_Permissions',
    properties: [],
    modules: [],
    span: app.forms[0]!.span,
  });
  const proof: ProofReport = {
    schema: 'c2c-proof/1',
    app: hostile('proof.app'),
    checksum: hostile('proof.checksum') as ProofReport['checksum'],
    source: hostile('proof.source'),
    checkpointSince: hostile('proof.checkpointSince'),
    tables: [
      {
        table: hostile('proof.table'),
        form: hostile('proof.form'),
        sourceRows: 1,
        sourceChecksum: hostile('proof.sourceChecksum'),
        checkpointRows: 1,
        checkpointChecksum: hostile('proof.checkpointChecksum'),
        match: false,
        delta: { new: 1, changed: 2, deleted: 3, missing: false },
      },
    ],
    smoke: {
      status: hostile('proof.status') as ProofReport['smoke']['status'],
      session: hostile('proof.session'),
      blocker: hostile('proof.blocker'),
      lines: [hostile('proof.line')],
    },
    readiness: { automatic: 50, band: hostile('proof.band'), manual: [hostile('proof.manual')] },
  };
  const proofMd = proofMarkdown(proof);
  for (const field of [
    'proof.app',
    'proof.checksum',
    'proof.source',
    'proof.checkpointSince',
    'proof.status',
    'proof.session',
    'proof.blocker',
    'proof.line',
    'proof.table',
    'proof.form',
    'proof.sourceChecksum',
    'proof.checkpointChecksum',
    'proof.band',
    'proof.manual',
  ]) {
    assertFieldEscaped(proofMd, field);
  }
  assert.equal(proofMd.includes('<script>'), false);
  const proofRow = proofMd.split('\n').find((line) => line.startsWith('|') && line.includes('proof.table'));
  assert.ok(proofRow, proofMd);
  assert.equal(markdownCells(proofRow!).length, 8, proofRow);

  const input: CutoverInput = {
    app,
    sourceKind: hostile('check.source'),
    state: { projectId: hostile('check.project'), slateUrl: hostile('check.url') },
    scope: { org: '1', projectId: 'fallback', dc: hostile('check.dc') },
    smoke: proof.smoke,
    smokeSource: hostile('check.smokeSource'),
    rollback: { status: 'invalid', dir: '/tmp/rollback', outsideWorkspace: true, checksumMatch: false, reason: hostile('check.rollbackReason') },
  };
  const checklist = cutoverChecklist(input, proof);
  for (const field of [
    'check.app',
    'check.formDisplay',
    'check.formName',
    'check.role',
    'check.project',
    'check.dc',
    'check.url',
    'check.source',
    'check.smokeSource',
    'check.rollbackReason',
    'proof.status',
    'proof.session',
    'proof.line',
    'proof.table',
    'proof.band',
  ]) {
    assertFieldEscaped(checklist, field);
  }
  assert.equal(checklist.includes('<script>'), false);
  const smokeRow = checklist.split('\n').find((line) => line.startsWith('| Smoke result:'));
  assert.ok(smokeRow, checklist);
  assert.equal(markdownCells(smokeRow!).length, 3, smokeRow);
  // The slate value is escaped text, not a Markdown link.
  assert.equal(/\[[^\]]*\]\(https?:/.test(checklist), false);

  const blockedSmoke: ProofReport = {
    ...proof,
    smoke: { status: 'fail', blocker: hostile('proof.blocker') },
  };
  const blockedList = cutoverChecklist({ ...input, smoke: blockedSmoke.smoke }, blockedSmoke);
  assertFieldEscaped(blockedList, 'proof.blocker');
  assert.equal(blockedList.includes('<script>'), false);
});

test('proof lists the last sync-delta conflicts with hashes and makes an unresolved one a manual item', () => {
  const ws = workspace();
  const fields = [{ column: 'PO_Title', creator: 'sha256:aaaaaaaaaaaa', catalyst: 'sha256:bbbbbbbbbbbb' }];
  writeFileSync(
    join(ws.state, STATE_FILE),
    JSON.stringify({
      deltaConflicts: {
        since: '2026-10-06 10:00:00',
        conflicts: [
          { table: 'Purchase_Order', sourceId: '21', rowid: '9001', kind: 'changed', fields },
          { table: 'Vendor', sourceId: '11', rowid: '9002', kind: 'changed', fields: [], resolution: 'creator' },
        ],
      },
    }),
  );
  const input = cutoverInput(ws.ds, ['--since', ws.state]);
  const proof = proofReport(input);
  assert.equal(proof.conflicts?.items.length, 2);
  const manual = proof.readiness.manual.filter((item) => item.startsWith('resolve conflict:'));
  assert.deepEqual(manual, [
    'resolve conflict: Purchase_Order ROWID 9001 source id 21: edited in Creator and in the new app: PO_Title (Creator sha256:aaaaaaaaaaaa, new app sha256:bbbbbbbbbbbb) -> unresolved; re-run sync-delta with --prefer creator|catalyst or --conflicts <file>',
  ]);
  const md = proofMarkdown(proof);
  assert.match(md, /^## Conflicts$/m);
  assert.match(md, /^\| Purchase_Order \| 9001 \| 21 \| changed \| PO_Title sha256:aaaaaaaaaaaa \/ sha256:bbbbbbbbbbbb \| unresolved \|$/m);
  assert.match(md, /^\| Vendor \| 9002 \| 11 \| changed \| - \| keep Creator value \|$/m);
  // No conflict record: the proof keeps its earlier shape.
  writeFileSync(join(ws.state, STATE_FILE), JSON.stringify({ deltaConflicts: { conflicts: [] } }));
  const clean = proofReport(cutoverInput(ws.ds, ['--since', ws.state]));
  assert.equal('conflicts' in clean, false);
  assert.doesNotMatch(proofMarkdown(clean), /## Conflicts/);
});
