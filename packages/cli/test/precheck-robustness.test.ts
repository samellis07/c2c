/**
 * precheck robustness: never a stack trace. On every synthetic export precheck
 * returns a structured report with exact expected findings (CLEAN exit 0 for
 * L1-L3, BLOCKERS exit 1 with named blocker checks for negative variants), and
 * the output is byte-identical across runs. The synthetic half needs
 * C2C_FIXTURES_DIR (skips without it); input-refusal, degenerate script and
 * crash-injection tests are offline.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decode, deriveIr, parse, parseFile, type App } from '../../core/src/index.js';
import { precheck, precheckAsJson, precheckAsText, type PrecheckReport } from '../src/precheck.js';
import { listSyntheticApps, resolveSyntheticDir, type SyntheticApp } from '../src/synthetic-report.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(repo, 'dist/cli/src/c2c.js');

/** A stack frame line or an uncaught-error banner means the process crashed. */
const STACK = /\n\s+at\s+\S+\s+\(|^(Type|Syntax|Range|Reference)?Error:/m;

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const syntheticDir = resolveSyntheticDir(process.env, undefined);

export interface AppExpectation {
  /** Expected exit status: 0 for clean (no blockers), 1 for blockers present. */
  exit: 0 | 1;
  /** Blocker check names expected when exit === 1 (empty when clean). */
  blockers: string[];
}

/**
 * Exact expectations per synthetic app.
 * L1-L3 across all suites are CLEAN (exit 0, no blockers).
 * Negative L4 variants that Creator rejects have BLOCKERS (exit 1 + named checks).
 * Accepted L4 variants without import blockers produce exit 0 (warnings only).
 */
export const SYNTHETIC_EXPECTATIONS: Readonly<Record<string, AppExpectation>> = {
  // s01 Purchase Orders
  's01-purchase-orders/L1/c2c-syn-po-l1.ds': { exit: 0, blockers: [] },
  's01-purchase-orders/L2/c2c-syn-po-l2.ds': { exit: 0, blockers: [] },
  's01-purchase-orders/L3/c2c-syn-po-l3.ds': { exit: 0, blockers: [] },
  's01-purchase-orders/L4/f1-sendmail-from/c2c-syn-po-l4-f1.ds': { exit: 1, blockers: ['sendmail-sender'] },
  's01-purchase-orders/L4/f2-success-in-validate/c2c-syn-po-l4-f2.ds': { exit: 1, blockers: ['success-message'] },
  's01-purchase-orders/L4/f3-stale-arity/c2c-syn-po-l4-f3.ds': { exit: 1, blockers: ['signature'] },
  's01-purchase-orders/L4/f4-approver-on-success/c2c-syn-po-l4-f4.ds': { exit: 0, blockers: [] },
  's01-purchase-orders/L4/f5-mixed-workflow-dialect/c2c-syn-po-l4-f5.ds': { exit: 0, blockers: [] },

  // s02 Visitor Checkin
  's02-visitor-checkin/L1/c2c-syn-vis-l1.ds': { exit: 0, blockers: [] },
  's02-visitor-checkin/L2/c2c-syn-vis-l2.ds': { exit: 0, blockers: [] },
  's02-visitor-checkin/L3/c2c-syn-vis-l3.ds': { exit: 0, blockers: [] },
  's02-visitor-checkin/L4/f1-emoji-report-title/c2c-syn-vis-l4-f1.ds': { exit: 1, blockers: ['non-bmp'] },
  's02-visitor-checkin/L4/f2-void-in-expression/c2c-syn-vis-l4-f2.ds': { exit: 1, blockers: ['void-assign'] },
  's02-visitor-checkin/L4/f3-undefined-variable/c2c-syn-vis-l4-f3.ds': { exit: 1, blockers: ['undefined-variable'] },

  // s03 HR Recruitment
  's03-hr-recruitment/L1/c2c-syn-hr-l1.ds': { exit: 0, blockers: [] },
  's03-hr-recruitment/L2/c2c-syn-hr-l2.ds': { exit: 0, blockers: [] },
  's03-hr-recruitment/L3/c2c-syn-hr-l3.ds': { exit: 0, blockers: [] },
  's03-hr-recruitment/L4/f1-reserved-type/c2c-syn-hr-l4-f1.ds': { exit: 1, blockers: ['reserved-name'] },
  's03-hr-recruitment/L4/f2-multiselect-criteria/c2c-syn-hr-l4-f2.ds': { exit: 1, blockers: ['criteria-multiselect'] },
  's03-hr-recruitment/L4/f3-duplicate-workflow-name/c2c-syn-hr-l4-f3.ds': { exit: 0, blockers: [] },

  // s04 Inventory
  's04-inventory/L1/c2c-syn-inv-l1.ds': { exit: 0, blockers: [] },
  's04-inventory/L2/c2c-syn-inv-l2.ds': { exit: 0, blockers: [] },
  's04-inventory/L3/c2c-syn-inv-l3.ds': { exit: 0, blockers: [] },
  's04-inventory/L4/f1-comment-in-insert/c2c-syn-inv-l4-f1.ds': { exit: 1, blockers: ['insert-comment'] },
  's04-inventory/L4/f2-legacy-list-getall/c2c-syn-inv-l4-f2.ds': { exit: 1, blockers: ['legacy-getall'] },
  's04-inventory/L4/f3-arg-type/c2c-syn-inv-l4-f3.ds': { exit: 0, blockers: [] },
  's04-inventory/L4/f4-lookup-5-display-fields/c2c-syn-inv-l4-f4.ds': { exit: 0, blockers: [] },

  // s05 Field Service
  's05-field-service/L1/c2c-syn-fs-l1.ds': { exit: 0, blockers: [] },
  's05-field-service/L2/c2c-syn-fs-l2.ds': { exit: 0, blockers: [] },
  's05-field-service/L3/c2c-syn-fs-l3.ds': { exit: 0, blockers: [] },
  's05-field-service/L4/f1-legacy-custom-action/c2c-syn-fs-l4-f1.ds': { exit: 1, blockers: ['custom-action', 'custom-action'] },
  's05-field-service/L4/f2-connection-display-name/c2c-syn-fs-l4-f2.ds': { exit: 0, blockers: [] },
  's05-field-service/L4/f3-checkbox-no-choices/c2c-syn-fs-l4-f3.ds': { exit: 0, blockers: [] },

  // s99 Kitchen Sink
  's99-kitchen-sink/c2c-syn-kitchen-sink.ds': { exit: 0, blockers: [] },
};

export function checkSyntheticApp(
  app: SyntheticApp,
  parseApp: (file: string) => { ir: App; source: string } = (file) => ({
    ir: parseFile(file).ir,
    source: decode(readFileSync(file)).text,
  }),
): { status: 0 | 1; blockers: string[]; report: PrecheckReport } {
  let parsed: { ir: App; source: string };
  try {
    parsed = parseApp(app.file);
  } catch (err) {
    throw new Error(`precheck parse failed for ${app.rel}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  let report: PrecheckReport;
  try {
    report = precheck(parsed.ir, parsed.source);
  } catch (err) {
    throw new Error(`precheck failed for ${app.rel}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  const status = report.counts.blocker > 0 ? 1 : 0;
  const blockers = report.findings.filter((f) => f.severity === 'blocker').map((f) => f.check);
  return { status, blockers, report };
}

test('precheck never crashes, is deterministic, and matches exact expectations on every synthetic export', { skip: !syntheticDir }, () => {
  const apps = listSyntheticApps(syntheticDir!);
  assert.ok(apps.length > 0, `no synthetic apps under ${syntheticDir}`);
  for (const app of apps) {
    const exp = SYNTHETIC_EXPECTATIONS[app.rel];
    assert.ok(exp !== undefined, `missing expectation entry for ${app.rel}`);

    const { status, blockers, report } = checkSyntheticApp(app);
    assert.equal(status, exp.exit, `${app.rel}: exit code mismatch (expected ${exp.exit}, got ${status})`);
    assert.deepEqual(blockers, exp.blockers, `${app.rel}: blocker check names mismatch`);
    assert.equal(report.schema, 'c2c-precheck/1', `${app.rel}: schema mismatch`);

    // Determinism: byte-identical text and json renderings across runs
    const source = decode(readFileSync(app.file)).text;
    const parsed = parseFile(app.file);
    const again = precheck(parsed.ir, source);
    assert.equal(precheckAsText(again), precheckAsText(report), `${app.rel}: text rendering differs across runs`);
    assert.equal(precheckAsJson(again), precheckAsJson(report), `${app.rel}: JSON rendering differs across runs`);
  }
});

test('crash injection: synthetic runner fails with the app name when an app parse throws', () => {
  const fakeApp: SyntheticApp = {
    n: 1,
    rel: 's01-purchase-orders/L1/c2c-syn-po-l1.ds',
    file: '/dummy/path/c2c-syn-po-l1.ds',
  };
  const stubParse = (_file: string) => {
    throw new Error('simulated syntax/runtime crash in parser');
  };
  assert.throws(
    () => checkSyntheticApp(fakeApp, stubParse),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /s01-purchase-orders\/L1\/c2c-syn-po-l1\.ds/);
      assert.match(err.message, /simulated syntax\/runtime crash in parser/);
      return true;
    },
  );
});

test('crash injection: precheck runner fails with the app name when precheck throws', () => {
  const fakeApp: SyntheticApp = {
    n: 2,
    rel: 's04-inventory/L1/c2c-syn-inv-l1.ds',
    file: '/dummy/path/c2c-syn-inv-l1.ds',
  };
  assert.throws(
    () => checkSyntheticApp(fakeApp, () => ({ ir: null as unknown as App, source: '' })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /s04-inventory\/L1\/c2c-syn-inv-l1\.ds/);
      return true;
    },
  );
});

test('precheck CLI end-to-end smoke check', { skip: !syntheticDir }, () => {
  const cleanApp = path.join(syntheticDir!, 's01-purchase-orders/L1/c2c-syn-po-l1.ds');
  const rClean = run(['precheck', cleanApp]);
  assert.equal(rClean.status, 0);
  assert.doesNotMatch(rClean.stderr, STACK);
  assert.match(rClean.stdout, /^precheck /);

  const blockerApp = path.join(syntheticDir!, 's01-purchase-orders/L4/f1-sendmail-from/c2c-syn-po-l4-f1.ds');
  const rBlocker = run(['precheck', blockerApp]);
  assert.equal(rBlocker.status, 1);
  assert.doesNotMatch(rBlocker.stderr, STACK);
  assert.match(rBlocker.stdout, /^precheck /);

  const json = run(['precheck', cleanApp, '--json']);
  assert.equal(json.status, 0);
  const report = JSON.parse(json.stdout) as { schema?: string };
  assert.equal(report.schema, 'c2c-precheck/1');
});

test('precheck names its input refusals instead of crashing', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-precheck-robust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const missing = run(['precheck', path.join(dir, 'nope.ds')]);
  assert.equal(missing.status, 3);
  assert.doesNotMatch(missing.stderr, STACK);
  assert.match(missing.stderr, /no such file/);

  const asDir = run(['precheck', dir]);
  assert.equal(asDir.status, 2);
  assert.doesNotMatch(asDir.stderr, STACK);

  const garbage = path.join(dir, 'garbage.ds');
  writeFileSync(garbage, 'this is not a creator export\n');
  const bad = run(['precheck', garbage]);
  assert.equal(bad.status, 4);
  assert.doesNotMatch(bad.stderr, STACK);

  // Balanced enough for the .ds grammar but not an application export.
  const orphan = path.join(dir, 'orphan.ds');
  writeFileSync(orphan, 'forms\n{\n}\n');
  const orphanRun = run(['precheck', orphan]);
  assert.equal(orphanRun.status, 4);
  assert.doesNotMatch(orphanRun.stderr, STACK);
});

test('precheck() does not throw on degenerate or hostile script bodies', () => {
  const wrap = (script: string) => `application "Robust_App"
{
	forms
	{
		form Item
		{
			Title
			(
				type = text
				displayname = "Title"
			)
		}
	}
	workflow
	{
		form
		{
			W_0 as "W 0"
			{
				type = form
				form = Item
				record event = on add
				on validate
				{
					actions
					{
						custom deluge script
						(
${script}
						)
					}
				}
			}
		}
	}
}
`;
  const scripts = [
    '\t\t\t\t\t\t\t', // whitespace only
    '\t\t\t\t\t\t\t// nothing but a comment',
    '\t\t\t\t\t\t\t}',
    '\t\t\t\t\t\t\tif(input.Title == ) { }',
    '\t\t\t\t\t\t\tx = "unterminated',
    '\t\t\t\t\t\t\tinput.Title = ;;;',
    '\t\t\t\t\t\t\tfor each x in { } { z = (((; }',
    '\t\t\t\t\t\t\t🎉 = input.Title;', // non-BMP identifier position
  ];
  for (const script of scripts) {
    const source = wrap(script);
    const ir = deriveIr(parse(source));
    const report = precheck(ir, source);
    assert.equal(report.schema, 'c2c-precheck/1', script);
    // Same input, same bytes.
    const again = precheck(deriveIr(parse(source)), source);
    assert.equal(precheckAsJson(again), precheckAsJson(report), script);
    assert.equal(precheckAsText(again), precheckAsText(report), script);
  }
});
