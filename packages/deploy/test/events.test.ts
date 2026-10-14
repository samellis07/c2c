import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildDeploy, checkGuards } from '../src/index.js';
import { asyncLaneBlocker, DEAD_LETTER_TABLE, PROCESSED_TABLE, TRIGGERS_WIRED_FLAG } from '../src/events.js';

const SECRET = '/tmp/cred-events-test';

const EVENT_DS = `/*
 * Author       : synthetic
 * Generated on : 01-Jan-2025 12:00:00
 * Version      : 1.0
 */
application "Events_App"
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
	reports
	{
		list All_Items
		{
			displayName = "All Items"
			show all rows from Item
			(
				Title as "Title"
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
							x = 1 + 1;
						)
					}
				}
			}
		}
	}
}
`;

function appOf(source: string) {
  return deriveIr(parse(source));
}

function guardFor(name: string, projectId: string) {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-events-projects-'));
  const path = join(dir, 'PROJECTS.json');
  writeFileSync(path, JSON.stringify({ org: '10000000000', dc: 'in', env: 'Development', projects: { [`c2c-${name.toLowerCase()}`]: projectId } }));
  return checkGuards({
    org: '10000000000',
    projectId,
    appLink: name,
    credentialPath: SECRET,
    registry: JSON.parse(readFileSync(path, 'utf8')),
  });
}

test('the dead-letter table is planned only when the async on-success lane is enabled', () => {
  const app = appOf(EVENT_DS);
  const guard = guardFor('Events_App', '1001');
  const on = buildDeploy(app, guard, false, false, undefined, undefined, undefined, undefined, [], undefined, 'vanilla', true);
  const step = on.tableSteps.find((s) => s.table === DEAD_LETTER_TABLE);
  assert.ok(step, 'the support table is planned');
  assert.deepEqual(
    step.columns.map((column) => `${column.column_name}:${column.data_type}`),
    [
      'Event_Key:varchar',
      'Form:varchar',
      'Action:varchar',
      'Record_ID:varchar',
      'Target:varchar',
      'State:varchar',
      'Attempts:int',
      'Error:text',
      'Envelope:text',
      'First_Failed:varchar',
      'Last_Failed:varchar',
    ],
  );
  assert.equal(step.columns.find((column) => column.column_name === 'Event_Key')?.is_unique, true);
  assert.ok(on.files.some((file) => file.path.includes('events/after-commit.mjs')), 'the event function is deployed');
  assert.ok(on.files.some((file) => file.path.includes('c2c-event-sweeper.mjs')), 'the sweep Job is deployed');
  const submit = on.files.find((file) => file.path.endsWith('aio/item/on-success.mjs'));
  assert.ok(submit, 'the on-success submit endpoint is deployed');
  assert.match(String(submit.data), /deferred: "after-commit event"/, 'the live submit defers the on-success run to the event lane');
  const off = buildDeploy(app, guard, false);
  assert.equal(off.tableSteps.some((s) => s.table === DEAD_LETTER_TABLE), false, 'no table without the flag');
  assert.equal(off.files.some((file) => file.path.includes('events/after-commit.mjs')), false);
  const offSubmit = off.files.find((file) => file.path.endsWith('aio/item/on-success.mjs'));
  assert.ok(offSubmit && !String(offSubmit.data).includes('after-commit event'), 'the default submit still runs on-success inline');
  for (const file of off.files.filter((f) => typeof f.data === 'string')) {
    assert.equal(String(file.data).includes(DEAD_LETTER_TABLE), false, `${file.path} names ${DEAD_LETTER_TABLE} without the flag`);
  }
});

test('blocker 2: the per-module completion ledger is planned with the dead-letter table', () => {
  const app = appOf(EVENT_DS);
  const guard = guardFor('Events_App', '1001');
  const on = buildDeploy(app, guard, false, false, undefined, undefined, undefined, undefined, [], undefined, 'vanilla', true);
  assert.ok(on.usesEvents, 'the bundle marks the event lane');
  const step = on.tableSteps.find((s) => s.table === PROCESSED_TABLE);
  assert.ok(step, 'the completion ledger is planned');
  assert.deepEqual(
    step.columns.map((column) => `${column.column_name}:${column.data_type}`),
    ['Event_Key:varchar', 'Spec:varchar', 'State:varchar', 'Finished_At:varchar'],
  );
  const off = buildDeploy(app, guard, false);
  assert.equal(off.usesEvents, false, 'no lane without the flag');
  assert.equal(off.tableSteps.some((s) => s.table === PROCESSED_TABLE), false, 'no ledger without the flag');
  for (const file of off.files.filter((f) => typeof f.data === 'string')) {
    assert.equal(String(file.data).includes(PROCESSED_TABLE), false, `${file.path} names ${PROCESSED_TABLE} without the flag`);
  }
});

test('blocker 3: the printed plan carries the trigger warning only with the lane', () => {
  const app = appOf(EVENT_DS);
  const guard = guardFor('Events_App', '1001');
  const on = buildDeploy(app, guard, false, false, undefined, undefined, undefined, undefined, [], undefined, 'vanilla', true);
  assert.match(on.plan, /async on-success triggers \(opt-in lane\):/);
  assert.match(on.plan, new RegExp(TRIGGERS_WIRED_FLAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const off = buildDeploy(app, guard, false);
  assert.equal(off.plan.includes('async on-success triggers'), false, 'flag-off plans stay silent');
});

test('blocker 3: the trigger gate refuses the lane without the explicit opt-in', () => {
  assert.equal(asyncLaneBlocker(false, false), null, 'no lane, no gate');
  const blocker = asyncLaneBlocker(true, false);
  assert.ok(blocker && blocker.includes('event-async-onsuccess'), 'the blocker names the lane');
  assert.ok(blocker.includes(TRIGGERS_WIRED_FLAG), 'the blocker names the opt-in');
  assert.equal(asyncLaneBlocker(true, true), null, 'the explicit opt-in opens the gate');
});
