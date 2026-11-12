/**
 * Q6 verified bar: the Playwright JSON report check (`e2eParity`) — the same
 * regression cases must run and pass on both the creator and catalyst
 * projects — and its fold with `dataParity` into `q6Verdict` / `verify --e2e-report`.
 * Everything here is offline: the report JSON stands in for the browser run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eParity, playwrightSpecOutcomes, q6Verdict, verifyCli, type DataParityReport, type Io } from '../src/index.js';

/** A Playwright JSON report: one spec per (title, projects) entry. */
function pwReport(entries: { title: string; projects: Record<string, string> }[]): unknown {
  return {
    suites: [
      {
        title: 'app (creator)',
        specs: entries.map((entry) => ({
          title: entry.title,
          ok: Object.values(entry.projects).every((status) => status === 'expected' || status === 'flaky'),
          tests: Object.entries(entry.projects).map(([projectName, status]) => ({
            projectName,
            status,
            results: [{ status: status === 'expected' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed' }],
          })),
        })),
      },
    ],
  };
}

const APP = `application "Widget"
{
form Vendor
{
Vendor_Name
(
type = text
displayname = "Vendor Name"
)
}
list All_Vendors
{
show all rows from Vendor
(
Vendor_Name as "Vendor Name"
)
}
}
`;

function cap() {
  let out = '';
  let err = '';
  const io: Io = {
    stdout: (t: string) => void (out += t),
    stderr: (t: string) => void (err += t),
    env: {},
    spawn: (() => Promise.reject(new Error('no spawn'))) as Io['spawn'],
    fetch: (() => Promise.reject(new Error('no fetch'))) as Io['fetch'],
  };
  return { io, out: () => out, err: () => err };
}

test('e2eParity: the same cases pass on creator and catalyst', () => {
  const report = e2eParity(
    pwReport([
      { title: 'create a vendor', projects: { creator: 'expected', catalyst: 'expected' } },
      { title: 'list vendors', projects: { creator: 'expected', catalyst: 'expected' } },
    ]),
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.reasons, []);
  assert.equal(report.cases.length, 2);
});

test('e2eParity: flaky passes, unexpected and skipped fail the named side', () => {
  const report = e2eParity(
    pwReport([
      { title: 'create a vendor', projects: { creator: 'expected', catalyst: 'flaky' } },
      { title: 'list vendors', projects: { creator: 'unexpected', catalyst: 'expected' } },
      { title: 'edit a vendor', projects: { creator: 'expected', catalyst: 'skipped' } },
    ]),
  );
  assert.equal(report.ok, false);
  assert.ok(report.cases[0]!.ok, 'flaky counts as a pass');
  assert.ok(report.reasons.includes('Q6_E2E_CREATOR_FAILED'));
  assert.ok(report.reasons.includes('Q6_E2E_CATALYST_FAILED'));
  assert.deepEqual(
    report.cases.filter((item) => !item.ok).map((item) => item.name),
    ['edit a vendor', 'list vendors'],
  );
});

test('e2eParity: a case that ran on only one project is a missing case', () => {
  const report = e2eParity(
    pwReport([
      { title: 'create a vendor', projects: { creator: 'expected', catalyst: 'expected' } },
      { title: 'creator only', projects: { creator: 'expected' } },
      { title: 'catalyst only', projects: { catalyst: 'expected' } },
    ]),
  );
  assert.equal(report.ok, false);
  assert.ok(report.reasons.includes('Q6_E2E_CASE_MISSING'));
  assert.equal(report.cases.find((item) => item.name === 'creator only')!.catalyst, 'unknown');
});

test('e2eParity: an empty or malformed report fails with Q6_E2E_NO_CASES', () => {
  for (const report of [{}, { suites: [] }, pwReport([])]) {
    const out = e2eParity(report);
    assert.equal(out.ok, false);
    assert.deepEqual(out.reasons, ['Q6_E2E_NO_CASES']);
  }
});

test('playwrightSpecOutcomes: nested describes fold and other projects are ignored by the pair but listed', () => {
  const report = {
    suites: [
      {
        title: 'outer',
        suites: [
          {
            title: 'inner',
            specs: [
              {
                title: 'case a',
                tests: [
                  { projectName: 'creator', status: 'expected' },
                  { projectName: 'catalyst', status: 'expected' },
                  { projectName: 'firefox-smoke', status: 'unexpected' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const outcomes = playwrightSpecOutcomes(report);
  assert.equal(outcomes.get('case a')!.get('firefox-smoke'), 'unexpected');
  const parity = e2eParity(report);
  assert.equal(parity.ok, true, 'other projects do not gate the pair');
  assert.deepEqual(parity.otherProjects, ['firefox-smoke']);
});

test('q6Verdict: verified only when both halves hold', () => {
  const e2e = e2eParity(pwReport([{ title: 'case', projects: { creator: 'expected', catalyst: 'expected' } }]));
  const parity = { ok: true, reasons: [], tables: [], skipped: [] } as unknown as DataParityReport;
  assert.equal(q6Verdict({ e2e, parity }).verified, true);
  assert.equal(q6Verdict({ e2e, parity: { ...parity, ok: false, reasons: ['Q6_COUNT_MISMATCH'] } }).verified, false);
  assert.equal(q6Verdict({ e2e: e2eParity(pwReport([])), parity }).verified, false);
});

test('verify --e2e-report: exit 0 on a passing report, 1 on a failing one, 2 on usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-q6-e2e-'));
  const good = join(dir, 'good.json');
  const bad = join(dir, 'bad.json');
  writeFileSync(good, JSON.stringify(pwReport([{ title: 'case', projects: { creator: 'expected', catalyst: 'expected' } }])));
  writeFileSync(bad, JSON.stringify(pwReport([{ title: 'case', projects: { creator: 'expected', catalyst: 'unexpected' } }])));

  const ok = cap();
  assert.equal(verifyCli(['--e2e-report', good], ok.io), 0, ok.err());
  assert.match(ok.out(), /e2e: ok/);
  const json = cap();
  assert.equal(verifyCli(['--e2e-report', good, '--json'], json.io), 0);
  assert.equal((JSON.parse(json.out()) as { ok: boolean }).ok, true);

  assert.equal(verifyCli(['--e2e-report', bad], cap().io), 1);
  assert.equal(verifyCli(['--e2e-report'], cap().io), 2);
  assert.equal(verifyCli([], cap().io), 2);

  rmSync(dir, { recursive: true, force: true });
});

test('verify --data-parity --e2e-report: folds both halves into the verified verdict', () => {
  const src = mkdtempSync(join(tmpdir(), 'c2c-q6-src-'));
  writeFileSync(join(src, 'All_Vendors.json'), JSON.stringify({ All_Vendors: [{ ID: '101', 'Vendor Name': 'Acme' }] }));
  const rows = mkdtempSync(join(tmpdir(), 'c2c-q6-rows-'));
  writeFileSync(join(rows, 'Vendor.json'), JSON.stringify([{ ROWID: '1', c2c_source_id: '101', Vendor_Name: 'Acme' }]));
  const dsDir = mkdtempSync(join(tmpdir(), 'c2c-q6-app-'));
  const dsPath = join(dsDir, 'app.ds');
  writeFileSync(dsPath, APP);

  const e2eDir = mkdtempSync(join(tmpdir(), 'c2c-q6-pw-'));
  const e2eGood = join(e2eDir, 'good.json');
  const e2eBad = join(e2eDir, 'bad.json');
  writeFileSync(e2eGood, JSON.stringify(pwReport([{ title: 'case', projects: { creator: 'expected', catalyst: 'expected' } }])));
  writeFileSync(e2eBad, JSON.stringify(pwReport([{ title: 'case', projects: { creator: 'expected', catalyst: 'unexpected' } }])));

  const ok = cap();
  assert.equal(
    verifyCli(['--data-parity', '--ds', dsPath, '--source-json', src, '--rows', rows, '--e2e-report', e2eGood], ok.io),
    0,
    ok.err(),
  );
  assert.match(ok.out(), /verified: yes/);

  // A failing E2E half blocks the verified bar even though parity holds.
  const e2eFail = cap();
  assert.equal(verifyCli(['--data-parity', '--ds', dsPath, '--source-json', src, '--rows', rows, '--e2e-report', e2eBad], e2eFail.io), 1);
  assert.match(e2eFail.out(), /verified: NO/);

  // A failing parity half blocks it even though the E2E passed.
  writeFileSync(join(rows, 'Vendor.json'), JSON.stringify([{ ROWID: '1', c2c_source_id: '101', Vendor_Name: 'Drifted' }]));
  const parityFail = cap();
  assert.equal(verifyCli(['--data-parity', '--ds', dsPath, '--source-json', src, '--rows', rows, '--e2e-report', e2eGood], parityFail.io), 1);

  rmSync(src, { recursive: true, force: true });
  rmSync(rows, { recursive: true, force: true });
  rmSync(dsDir, { recursive: true, force: true });
  rmSync(e2eDir, { recursive: true, force: true });
});

test('readPlaywrightReport via verifyCli surfaces invalid JSON as exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-q6-bad-'));
  const file = join(dir, 'not-json.json');
  writeFileSync(file, '{nope');
  const bad = cap();
  assert.equal(verifyCli(['--e2e-report', file], bad.io), 1);
  assert.match(bad.err(), /c2c verify:/);
  rmSync(dir, { recursive: true, force: true });
});
