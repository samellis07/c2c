/**
 * A server-side script that reads `input.Lookup.Field` (Creator: the linked
 * record's field) must see the linked row on the REST write path, not
 * undefined: the on-validate result is stored, so an unresolved read would
 * write the text "undefined" into the data store.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { assertGolden, runBehavior, startOfflineBackend } from '../src/verify-behavior.js';

const LOOKUP_DS = `application "lookup-sample"
{
	time zone = "Asia/Kolkata"
	share_settings
	{
		"Administrator"
		{
			name = "Administrator"
			type = Users_Permissions
			description = "This profile will have all the permissions."
		}
	}
	section S
	{
		form Add_Team
		{
			must have Team_Name
			(
				type = text
			)
		}
		form Add_Shift
		{
			must have Shift_Name
			(
				type = text
			)
		}
		form Add_Job
		{
			must have Team
			(
				type = picklist
				values  = Add_Team.ID
				displayformat = [Team_Name]
			)
			Shift
			(
				type = picklist
				values  = Add_Shift.ID
				displayformat = [Shift_Name]
			)
			Window
			(
				type = text
			)
			Badge
			(
				type = image
				source  = public_url,file
			)
			Job_Key
			(
				type = text
			)
		}
		list All_Jobs
		{
			show all rows from Add_Job
		}
	}
	workflow
	{
		form
		{
			Compose_Key as "Compose Key"
			{
				type = form
				form = Add_Job
				record event = on add or edit
				on validate
				{
					actions
					{
						custom deluge script
						(
							input.Job_Key = input.Team.Team_Name + " " + input.Shift.Shift_Name + " (" + input.Window + ")";
						)
					}
				}
			}
		}
	}
}
`;

async function replayJobs(cases: unknown[]) {
  const app = deriveIr(parse(LOOKUP_DS));
  const golden = assertGolden({ version: 'c2c-behavior-golden/2', app: 'lookup-sample', cases });
  const backend = await startOfflineBackend(app);
  try {
    return (await runBehavior(app, golden, backend, 'offline')).report;
  } finally {
    await backend.close();
  }
}

const SETUP = [
  { op: 'submit', form: 'Add_Team', record: { Team_Name: 'Physics' }, bind: { team: 'body.values.ROWID' }, expect: { outcome: 'saved' } },
  { op: 'submit', form: 'Add_Shift', record: { Shift_Name: 'Morning' }, bind: { shift: 'body.values.ROWID' }, expect: { outcome: 'saved' } },
];

test('on-validate composes a key from the linked rows of two lookups on the REST path', async () => {
  const job = { op: 'submit', form: 'Add_Job', record: { Team: '<ref:team>', Shift: '<ref:shift>', Window: 'Jun 2027' }, expect: { outcome: 'saved' } };
  const expected = (key: string) => ({ partial: true, tables: { Add_Job: [{ Job_Key: key }] } });
  const ok = await replayJobs([{ id: 'compose', steps: [...SETUP, job], expect: expected('Physics Morning (Jun 2027)') }]);
  assert.equal(ok.ok, true, JSON.stringify(ok.findings));
  // MUST-FAIL: the unresolved read stored the text the defect produced.
  const bad = await replayJobs([{ id: 'compose', steps: [...SETUP, job], expect: expected('undefined undefined (Jun 2027)') }]);
  assert.equal(bad.ok, false);
});

test('an unset optional lookup reads as no linked row, not a failure', async () => {
  const job = { op: 'submit', form: 'Add_Job', record: { Team: '<ref:team>', Window: 'Jun 2027' }, expect: { outcome: 'saved' } };
  const r = await replayJobs([{ id: 'no-shift', steps: [...SETUP, job], expect: { partial: true, tables: { Add_Job: [{ Team: '<ref:team>' }] } } }]);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

const JOB = { Team: '<ref:team>', Window: 'Jun 2027' };

test('a file reference the form does not own is a 400, never a 500; a well-formed key saves', async () => {
  const post = (badge: unknown, status: unknown) => ({
    op: 'request',
    method: 'POST',
    path: '/forms/Add_Job/submit',
    body: { record: { ...JOB, Badge: badge } },
    expect: { status },
  });
  const key = ['uploads', 'Add_Job', 'Badge', 'a'.repeat(64), 'badge.png'].join('/');
  const ok = await replayJobs([{ id: 'files', steps: [...SETUP, post({ key: 'k1' }, 400), post({ key }, '2xx')], expect: { partial: true, tables: { Add_Job: [{ Badge: key }] } } }]);
  assert.equal(ok.ok, true, JSON.stringify(ok.findings));
  // MUST-FAIL: expecting the old 500 for the unowned key is a finding.
  const bad = await replayJobs([{ id: 'files', steps: [...SETUP, post({ key: 'k1' }, 500)], expect: { partial: true } }]);
  assert.equal(bad.ok, false);
});
