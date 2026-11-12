import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveIr, parse, parseFile } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { buildBusinessMigrationReport, businessReportAsJson, businessReportAsMarkdown } from '../src/business-report.js';

const root = repoRoot();
const ds = join(root, 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds');
const goldenDir = join(root, 'packages/cli/test/golden/business-report/kitchen-sink-gaps');
const cli = join(root, 'dist/cli/src/c2c.js');

function withoutStatusKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(withoutStatusKeys);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value as Record<string, unknown>).every(([key, child]) => key !== 'status' && withoutStatusKeys(child));
}

test('kitchen-sink-gaps business report matches the committed markdown and JSON goldens', () => {
  const report = buildBusinessMigrationReport(parseFile(ds).ir, { dc: 'in' });
  assert.equal(businessReportAsJson(report), readFileSync(join(goldenDir, 'migration-report.json'), 'utf8'));
  assert.equal(businessReportAsMarkdown(report), readFileSync(join(goldenDir, 'migration-report.md'), 'utf8'));
  assert.equal(withoutStatusKeys(report), true);
});

test('converted roles count every Creator profile, not only hierarchy roles', () => {
  const kitchenSink = join(root, 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds');
  const report = buildBusinessMigrationReport(parseFile(kitchenSink).ir, { dc: 'in' });
  assert.deepEqual(report.converted.roles, { count: 4, names: ['Administrator', 'Desk_Staff', 'Studio_Crew', 'Studio_Lead'] });
});

test('c2c report writes byte-identical markdown and JSON on repeated runs', (t) => {
  const one = mkdtempSync(join(tmpdir(), 'c2c-business-report-a-'));
  const two = mkdtempSync(join(tmpdir(), 'c2c-business-report-b-'));
  t.after(() => {
    rmSync(one, { recursive: true, force: true });
    rmSync(two, { recursive: true, force: true });
  });
  for (const out of [one, two]) {
    const run = spawnSync(process.execPath, [cli, 'report', ds, '--dc', 'in', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  }
  assert.equal(readFileSync(join(one, 'migration-report.md'), 'utf8'), readFileSync(join(two, 'migration-report.md'), 'utf8'));
  assert.equal(readFileSync(join(one, 'migration-report.json'), 'utf8'), readFileSync(join(two, 'migration-report.json'), 'utf8'));
});

test('c2c report refuses an unknown flag and a missing source cleanly', () => {
  const badFlag = spawnSync(process.execPath, [cli, 'report', ds, '--bogus'], { encoding: 'utf8' });
  assert.equal(badFlag.status, 2);
  assert.match(badFlag.stderr, /unknown flag --bogus/);
  const missing = spawnSync(process.execPath, [cli, 'report', join(root, 'missing.ds'), '--dc', 'in'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such file or directory/);
});

const DS_RECORD_RELATIVE_SCHEDULE = `application "Roster"
{
	time zone = "Asia/Kolkata"
	section S
	{
		form Shift
		{
			End_Date
			(
				type = date
			)
		}
	}
	workflow
	{
		schedule
		{
			Shift_Reminder as "Shift reminder"
			{
				type = schedule
				form = Shift
				start = before 1 days from End_Date at "16:00:00"
				time zone = "Asia/Kolkata"
				on start
				{
					actions
					{
					on load
					(
						x = 1;
					)
					}
				}
			}
			Nightly_Cleanup as "Nightly cleanup"
			{
				type = schedule
				start = "01-Jan-2030 02:00:00"
				time zone = "Asia/Kolkata"
				on start
				{
					actions
					{
					on load
					(
						v = 1;
					)
					}
				}
			}
		}
	}
}
`;

test('business report: a record-relative schedule is not told it was "created disabled for review"', () => {
  const app = deriveIr(parse(DS_RECORD_RELATIVE_SCHEDULE));
  const report = buildBusinessMigrationReport(app, { dc: 'in' });
  const relative = report.appSpecificSteps.find((item) => item.name === 'Shift_Reminder');
  assert.ok(relative, 'Shift_Reminder has an app-specific step');
  // A record-relative schedule is never posted as a cron (see offline-plan.ts
  // recordRelativeSchedule): telling the customer to "enable" it is wrong,
  // since there is nothing to enable. The step must say it was not created.
  assert.doesNotMatch(relative!.detail, /created disabled for review/);
  assert.doesNotMatch(relative!.workaround, /Enable this schedule in Job Scheduling/);
  assert.match(relative!.workaround, /scheduling per record is not generated yet/);
  // An absolute, fixed-time schedule still gets the original guidance: it was
  // posted as a real (disabled) cron and only needs enabling.
  const absolute = report.appSpecificSteps.find((item) => item.name === 'Nightly_Cleanup');
  assert.ok(absolute, 'Nightly_Cleanup has an app-specific step');
  assert.match(absolute!.detail, /created disabled for review/);
  assert.match(absolute!.workaround, /Enable this schedule in Job Scheduling/);
});
