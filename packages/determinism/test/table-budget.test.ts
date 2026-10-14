import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { resolveStatusDir } from '../src/status.js';
import { appTableBudget, computeTableBudget, renderTableBudgetDoc } from '../src/table-budget.js';

const MAIL_DS = `application "Mailer"
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
		form Note
		{
			Body
			(
				type = text
				displayname = "Body"
			)
		}
	}
	workflow
	{
		form
		{
			On_Add as "On add"
			{
				type = form
				form = Item
				on add
				{
					actions
					{
						on success
						(
							sendmail
							[
								from: zoho.adminuserid
								to: "owner@example.com"
								subject: "added"
								message: "hello"
							];
						)
					}
				}
			}
		}
	}
}
`;

const PLAIN_DS = MAIL_DS.replace(/sendmail[\s\S]*?\];/, 'info "no mail";').replace('"Mailer"', '"Quiet"');

/** A form schedule: the sweeper keeps its checkpoints in C2CJobCheckpoint. */
const SCHEDULE_DS = `application "Reminders"
{
	time zone = "Asia/Kolkata"
	forms
	{
		form Item
		{
			Due_Date
			(
				type = date
				displayname = "Due Date"
			)
		}
	}
	workflow
	{
		schedule
		{
			Due_Reminder as "Due Reminder"
			{
				type = schedule
				form = Item
				start = before 1 days from Due_Date at "09:00:00"
				time zone = "Asia/Kolkata"
				on start
				{
					actions
					{
					on load
					(
						info "due";
					)
					}
				}
			}
		}
	}
}
`;

test('an app that sends mail needs c2c_mail_log only under --mail; a no-mail app never does', () => {
  const mailer = appTableBudget(deriveIr(parse(MAIL_DS)));
  assert.deepEqual(mailer, { appTables: 2, flowHistory: 0, mailLogDefault: 0, mailLogWithMail: 1, jobCheckpoint: 0, asyncEventTables: 2 });
  const quiet = appTableBudget(deriveIr(parse(PLAIN_DS)));
  assert.deepEqual(quiet, { appTables: 2, flowHistory: 0, mailLogDefault: 0, mailLogWithMail: 0, jobCheckpoint: 0, asyncEventTables: 0 });
});

test('a form schedule counts the sweeper checkpoint table', () => {
  assert.deepEqual(appTableBudget(deriveIr(parse(SCHEDULE_DS))), { appTables: 1, flowHistory: 0, mailLogDefault: 0, mailLogWithMail: 0, jobCheckpoint: 1, asyncEventTables: 0 });
});

test('the budget doc reports before and after per app, with counts only', () => {
  const rows = [
    { appTables: 2, flowHistory: 0, mailLogDefault: 0, mailLogWithMail: 1, jobCheckpoint: 0, asyncEventTables: 2 },
    { appTables: 5, flowHistory: 1, mailLogDefault: 0, mailLogWithMail: 0, jobCheckpoint: 1, asyncEventTables: 0 },
  ];
  const doc = renderTableBudgetDoc(rows);
  assert.match(doc, /\| 1 \| 2 \| 1 \| 3 \| 0 \| 2 \| 2 \| 4 \| 0 \|/);
  assert.match(doc, /\| 2 \| 5 \| 2 \| 7 \| 2 \| 7 \| 0 \| 7 \| 1 \|/);
  assert.match(doc, /\| \*\*all tables\*\* \| \*\*9\*\* \| \*\*10\*\* \|/);
  assert.match(doc, /sweeper checkpoints in `C2CJobCheckpoint`: 1\./);
  assert.match(doc, /\| \*\*all tables\*\* \| \*\*9\*\* \| \*\*10\*\* \| \*\*11\*\* \|/);
  assert.match(doc, /\| largest app \| 7 \| 7 \| 7 \|/);
  assert.match(doc, /\| `C2CJobCheckpoint` \| 1 \| 1 \|/);
  assert.match(doc, /\| `c2c_mail_log` \| 0 \| 1 \|/);
  assert.equal(/\d{4}-\d{2}-\d{2}|\/Users\//.test(doc), false);
  assert.equal(renderTableBudgetDoc(rows), doc);
});

test('an app with an add on-success module counts both async lane tables', () => {
  const budget = appTableBudget(deriveIr(parse(MAIL_DS)));
  assert.equal(budget.asyncEventTables, 2);
  const withoutLane = budget.appTables + budget.flowHistory + budget.jobCheckpoint + budget.mailLogDefault;
  const withLane = withoutLane + budget.asyncEventTables;
  assert.equal(withLane - withoutLane, 2);
});

function galleryDir(): string | undefined {
  const dir = resolveStatusDir(process.env);
  return dir && existsSync(dir) ? dir : undefined;
}

test('committed table budget doc equals a fresh gallery computation', { skip: !galleryDir() && 'needs C2C_FIXTURES_DIR or C2C_GALLERY_DIR' }, () => {
  const dir = galleryDir();
  assert.ok(dir);
  const fresh = renderTableBudgetDoc(computeTableBudget(dir));
  assert.equal(readFileSync(join(repoRoot(), 'docs/table-budget.md'), 'utf8'), fresh, 'docs/table-budget.md is stale: run npm run tables:budget');
});
