/**
 * Acceptance gate: precheck against the Creator import fixtures in
 * $C2C_FIXTURES_DIR/regressions. Each "bad" file is one Creator rejected at
 * import; each "fixed" file is one Creator imported. The files are read in
 * place and never copied into this repo. Skipped when
 * $C2C_FIXTURES_DIR/regressions/INDEX.md is absent.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { decode, parseFile } from '../../core/src/index.js';
import { precheck, type PrecheckReport } from '../src/precheck.js';

const fixtures = process.env.C2C_FIXTURES_DIR;
const fixtureDir = fixtures ? path.join(fixtures, 'regressions') : '';
const present =
  !!fixtures && !!statSync(path.join(fixtureDir, 'INDEX.md'), { throwIfNoEntry: false })?.isFile();
const skip = present ? false : 'C2C_FIXTURES_DIR/regressions/INDEX.md is not available; skipping import fixtures';

interface Expect {
  /** check:severity of every finding except converter-gap (the shared base app's gaps), sorted. */
  findings: string[];
  /** Line of the blocker, when the fixture records one. */
  line?: number;
}

/** On-disk names beside INDEX.md. */
const fx = (id: string) => `c2c-repro-${id}.ds`;
const fixtureName = /^c2c-repro-\d+[a-z]?(-[\w-]+)?\.ds$/;

/** Import blockers and warnings, cited by check id. */
const BAD: Record<string, Expect> = {
  [fx('1-bad')]: { findings: ['signature:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 592 },
  [fx('2-bad')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'void-assign:blocker'], line: 592 },
  [fx('3-bad')]: { findings: ['success-message:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 592 },
  [fx('3-load')]: { findings: ['success-message:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('4-bad')]: { findings: ['signature:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 593 },
  [fx('5')]: { findings: ['approver-on-success:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('5-criteria')]: { findings: ['approver-on-success:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('5-nocriteria')]: { findings: ['approver-on-success:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('6-bad')]: { findings: ['sendmail-sender:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 594 },
  [fx('7c-mlookup-ms')]: { findings: ['criteria-multiselect:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 592 },
  [fx('7-ms-eq')]: { findings: ['field-type:blocker', 'report-filter:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('7-ms-nofilter')]: { findings: ['field-type:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  // signature:blocker on the stale re-import, plus pivot-analytics warnings.
  // The tenant/unit lookups form a cycle, so the mandatory link is relaxed.
  [fx('9r-reimport')]: {
    findings: ['lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'signature:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'],
    line: 4980,
  },
  [fx('9-fa')]: { findings: ['custom-action:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 570 },
  // custom-action:blocker on every hand-grafted action; collection-to-scalar bindings warn.
  [fx('10-each')]: { findings: ['custom-action:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 570 },
  [fx('10-fixed')]: { findings: ['custom-action:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 570 },
  [fx('10-int')]: { findings: ['custom-action:blocker', 'custom-action:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('10-noarg')]: { findings: ['custom-action:blocker', 'custom-action:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('10-nseach')]: { findings: ['custom-action:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 570 },
  [fx('10-nsfixed')]: { findings: ['custom-action:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 570 },
  [fx('10-nsint')]: { findings: ['custom-action:blocker', 'custom-action:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('10-pm-bad')]: {
    findings: ['custom-action:warning', 'lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'],
  },
  // reserved-name:blocker when a workflow link name is Type.
  [fx('11-all')]: { findings: ['reserved-name:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 608 },
  [fx('11-wf')]: { findings: ['reserved-name:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 590 },
  // insert-comment:blocker when a comment sits inside insert into [...].
  [fx('12-block')]: { findings: ['insert-comment:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 608 },
  [fx('12-line')]: { findings: ['insert-comment:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 608 },
  // legacy-getall:blocker for the doubled legacy traversal.
  [fx('13-legacy')]: { findings: ['legacy-getall:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 608 },
  // report-view:blocker when a lookup column view= names another form's report.
  [fx('14-bad')]: { findings: ['report-view:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'], line: 616 },
};

/** Creator imported these. Precheck must not block them. */
const FIXED: Record<string, Expect> = {
  [fx('1-fixed')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('2-fixed')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('3-fixed')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('4-fixed')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('6-fixed')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('7-cb-eq')]: { findings: ['report-filter:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('7b-mlookup')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('7c-slookup-ms')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  // signature and custom-action stay quiet on the base and matched-signature variants.
  [fx('9-base')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('9-pm')]: { findings: ['lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('9-pm2')]: { findings: ['lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('10-base')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('10-nsfixed-noca')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  // reserved-name stays quiet for a field Type, a report Type, and workflow Typex / type_wf.
  [fx('11-field')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('11-fr')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('11-report')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('11-wfctl')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('11-wflower')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  // insert-comment stays quiet when the insert brackets contain no comment.
  [fx('12-none')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  // legacy-getall stays quiet for the closest-that-saves form, the modern form, a for-each loop, and Creator's own re-export.
  [fx('13-legacy2')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('13-loop')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('13-modern')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('13r-reimport')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('14-fixed')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  // Runtime and data issues, not .ds defects: they import fine.
  [fx('15')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('15b')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  [fx('16')]: { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
};

/**
 * Creator's own exportScript output. These names are not in the import
 * manifest; each asserts its full finding list anyway.
 * `c9-export-pm2-after.ds` is the stale export. Creator produces it, and
 * precheck must flag the signature drift it carries (signature:blocker).
 */
const EXPORTED: Record<string, Expect> = {
  'pm-export.ds': { findings: ['lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  'c9-export-pm.ds': { findings: ['lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  'c9-export-pm2-before.ds': { findings: ['lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  'c9-export-pm2-after.ds': {
    findings: ['lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'signature:blocker', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'],
    line: 4980,
  },
  'c10-export-base.ds': { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  'c10-export-noca.ds': { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  'c10-export-pm-bad.ds': {
    findings: ['custom-action:warning', 'lookup-cycle:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'pivot-analytics:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning', 'table-name-length-unverified:warning'],
  },
  'c11-export-fr.ds': { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  'c13-export-legacy2.ds': { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
  'c13-export-modern.ds': { findings: ['table-name-length-unverified:warning', 'table-name-length-unverified:warning'] },
};

function run(name: string): PrecheckReport {
  const file = path.join(fixtureDir, name);
  return precheck(parseFile(file).ir, decode(readFileSync(file)).text);
}

function summary(report: PrecheckReport): string[] {
  return report.findings
    .filter((finding) => finding.check !== 'converter-gap')
    .map((finding) => `${finding.check}:${finding.severity}`)
    .sort();
}

function detail(report: PrecheckReport): string {
  return report.findings.map((finding) => `${finding.check} ${finding.severity} L${finding.location.line} ${finding.message}`).join('\n');
}

test('precheck fixture manifest covers every documented import .ds', { skip }, () => {
  const documented = readdirSync(fixtureDir)
    .filter((name) => fixtureName.test(name))
    .sort();
  assert.deepEqual(documented, Object.keys({ ...BAD, ...FIXED }).sort());
});

for (const [name, want] of Object.entries(BAD)) {
  test(`precheck import ${name} fires exactly ${want.findings.join(', ')}`, { skip }, () => {
    const report = run(name);
    assert.deepEqual(summary(report), want.findings, detail(report));
    if (want.line !== undefined) {
      const blocker = report.findings.find((finding) => finding.severity === 'blocker');
      assert.equal(blocker?.location.line, want.line, detail(report));
    }
  });
}

for (const [name, want] of Object.entries(FIXED)) {
  test(`precheck import ${name} (Creator imports it) has no blocker`, { skip }, () => {
    const report = run(name);
    assert.equal(report.counts.blocker, 0, detail(report));
    assert.deepEqual(summary(report), want.findings, detail(report));
  });
}

for (const [name, want] of Object.entries(EXPORTED)) {
  test(`precheck export ${name} fires exactly ${want.findings.join(', ') || 'nothing'}`, { skip }, () => {
    const report = run(name);
    assert.deepEqual(summary(report), want.findings, detail(report));
    if (want.line !== undefined) {
      const blocker = report.findings.find((finding) => finding.severity === 'blocker');
      assert.equal(blocker?.location.line, want.line, detail(report));
    }
  });
}
