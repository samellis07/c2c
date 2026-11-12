/**
 * `c2c verify-behavior` against two generator paths the Creator goldens
 * exercise:
 * - a reserved field name (`To`, `Priority`) is stored under the schema's
 *   rename (`To_col`): a golden table row naming the Creator field compares
 *   against that column, through the same map the handlers and seeds use;
 * - an edit of a form whose only on-success script is `on add` runs the
 *   `on edit` validate against the stored record: a field the edit did not
 *   post (Status) reads its stored value, so `cancel submit` refuses it.
 * Each MUST FAIL when the golden disagrees with what was stored.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { columnRenamesOf, generateSchema } from '../../schema/src/generator.js';
import { runBehavior, startOfflineBackend, storeRowOf, type GoldenFile } from '../src/verify-behavior.js';

const APP = `application "stored-sample"
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
		form Trip
		{
			must have Title
			(
				type = text
			)
			To
			(
				type = text
			)
			Priority
			(
				type = text
			)
			Status
			(
				type = text
			)
			Note
			(
				type = text
			)
		}
		list All_Trips
		{
			show all rows from Trip
		}
	}
	workflow
	{
		form
		{
			Trip_Added as "Trip Added"
			{
				type = form
				form = Trip
				record event = on add
				on success
				{
					actions
					{
						custom deluge script
						(
							input.Note = "added";
						)
					}
				}
			}
			Trip_Edit as "Trip Edit"
			{
				type = form
				form = Trip
				record event = on edit
				on validate
				{
					actions
					{
						custom deluge script
						(
							if(Status == "Locked")
							{
								alert "Trip is locked";
								cancel submit;
							}
						)
					}
				}
			}
		}
	}
}
`;

function golden(cases: GoldenFile['cases']): GoldenFile {
  return { version: 'c2c-behavior-golden/2', app: 'stored-sample', cases } as GoldenFile;
}

const add = (record: Record<string, unknown>) => ({ op: 'submit', form: 'Trip', record, setup: true }) as never;

test('the schema stores the reserved fields under renamed columns, and storeRowOf follows that map', () => {
  const app = deriveIr(parse(APP));
  const renames = columnRenamesOf(generateSchema(app));
  assert.deepEqual(renames.Trip, { Priority: 'Priority_col', To: 'To_col' });
  assert.deepEqual(storeRowOf({ To: 'Pune', Priority_col: 'Low', Title: 'x' }, renames.Trip), { To_col: 'Pune', Priority_col: 'Low', Title: 'x' });
  assert.deepEqual(storeRowOf({ To: 'Pune' }, undefined), { To: 'Pune' });
});

test('a golden table row naming a reserved Creator field compares against its stored column', async () => {
  const app = deriveIr(parse(APP));
  const backend = await startOfflineBackend(app);
  try {
    const row = { Title: 'Trip A', To: 'Pune', Priority: 'Low', Note: 'added' };
    const ok = golden([{ id: 'reserved', steps: [add({ Title: 'Trip A', To: 'Pune', Priority: 'Low' })], expect: { tables: { Trip: [row] }, partial: true } } as never]);
    const { report } = await runBehavior(app, ok, backend, 'offline');
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    // MUST FAIL: a different stored value is a finding at the stored column.
    const bad = golden([{ id: 'reserved', steps: [add({ Title: 'Trip A', To: 'Pune', Priority: 'Low' })], expect: { tables: { Trip: [{ ...row, To: 'Goa' }] }, partial: true } } as never]);
    const { report: report2 } = await runBehavior(app, bad, backend, 'offline');
    assert.equal(report2.ok, false);
    assert.ok(report2.findings.some((f) => f.pointer === 'tables.Trip[0].To_col' && f.expected === 'Goa' && f.actual === 'Pune'), JSON.stringify(report2.findings));
  } finally {
    await backend.close();
  }
});

test('an edit runs the on edit validate against the stored record and keeps the row', async () => {
  const app = deriveIr(parse(APP));
  const backend = await startOfflineBackend(app);
  try {
    const steps = (status: string) => [
      add({ Title: 'Trip B', Status: status }),
      { op: 'update', report: 'All_Trips', where: { Title: 'Trip B' }, record: { Note: 'edited' }, expect: { body: { matched: 1, updated: 0, refused: 1 } } },
    ];
    const locked = golden([{ id: 'locked', steps: steps('Locked'), expect: { tables: { Trip: [{ Title: 'Trip B', Status: 'Locked', Note: 'added' }] }, partial: true } } as never]);
    const { report } = await runBehavior(app, locked, backend, 'offline');
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    // MUST FAIL: an unlocked row is edited, so the same golden finds the write.
    const open = golden([{ id: 'open', steps: steps('Open'), expect: { tables: { Trip: [{ Title: 'Trip B', Status: 'Open', Note: 'added' }] }, partial: true } } as never]);
    const { report: report2 } = await runBehavior(app, open, backend, 'offline');
    assert.equal(report2.ok, false);
    assert.ok(report2.findings.some((f) => f.pointer === 'body.updated' && f.expected === 0 && f.actual === 1), JSON.stringify(report2.findings));
    assert.ok(report2.findings.some((f) => f.pointer === 'tables.Trip[0].Note' && f.actual === 'edited'), JSON.stringify(report2.findings));
  } finally {
    await backend.close();
  }
});

test('an edit through an add-or-edit success module also validates against the stored record', async () => {
  const app = deriveIr(parse(APP.replace('record event = on add\n', 'record event = on add or edit\n')));
  const backend = await startOfflineBackend(app);
  try {
    const steps = (status: string) => [
      add({ Title: 'Trip C', Status: status }),
      { op: 'update', report: 'All_Trips', where: { Title: 'Trip C' }, record: { Note: 'edited' }, expect: { body: { matched: 1, updated: 0, refused: 1 } } },
    ];
    const { report } = await runBehavior(app, golden([{ id: 'locked', steps: steps('Locked') } as never]), backend, 'offline');
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    // MUST FAIL: an unlocked row is edited.
    const { report: report2 } = await runBehavior(app, golden([{ id: 'open', steps: steps('Open') } as never]), backend, 'offline');
    assert.ok(report2.findings.some((f) => f.pointer === 'body.updated' && f.expected === 0 && f.actual === 1), JSON.stringify(report2.findings));
  } finally {
    await backend.close();
  }
});
