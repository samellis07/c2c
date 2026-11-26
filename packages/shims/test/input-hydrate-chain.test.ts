/**
 * `input.hydrate` reads the linked row of each single lookup of the submitted
 * record, follows the chain A -> B -> C, reads through the caller's grant on
 * each form, and spends a bounded number of store reads. An unreadable or
 * missing link reads as empty text, never undefined.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccessPolicy } from '../src/access.js';
import { createRuntime } from '../src/runtime.js';
import { mockDatastore } from './zcql-mock.js';

const access: AccessPolicy = {
  roles: [],
  profiles: {
    Reader: { Job: {}, Team: {}, Dept: {} },
    NoTeam: { Job: {}, Dept: {} },
  },
};
const graph = { Team: { Dept: 'Dept' } };

async function setup(profile: string, teamDept: string | null = null) {
  const { datastore, calls } = mockDatastore({});
  await datastore.insert('Dept', [{ Dept_Name: 'Physics' }]);
  const dept = String((await datastore.query('Dept', 'true', 10))[0]!.ROWID);
  await datastore.insert('Team', [{ Team_Name: 'Optics', Dept: teamDept ?? dept }]);
  const team = String((await datastore.query('Team', 'true', 10))[0]!.ROWID);
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'UTC', access, datastore });
  const ctx = runtime.context({ principal: { profile } });
  return { runtime, ctx, team, reads: () => calls.length };
}

test('a chain A -> B -> C reads C through the middle link', async () => {
  const { runtime, ctx, team } = await setup('Reader');
  ctx.record = { Team: team };
  await runtime.shim.input.hydrate(ctx, { Team: 'Team' }, graph);
  assert.equal(runtime.shim.input.get(ctx, 'Team', 'Team_Name'), 'Optics');
  assert.equal(runtime.shim.input.get(ctx, 'Team', 'Dept', 'Dept_Name'), 'Physics');
});

test('a parent the profile cannot read, a missing parent and a missing middle link read as empty text', async () => {
  const denied = await setup('NoTeam');
  denied.ctx.record = { Team: denied.team };
  await denied.runtime.shim.input.hydrate(denied.ctx, { Team: 'Team' }, graph);
  assert.equal(denied.runtime.shim.input.get(denied.ctx, 'Team', 'Team_Name'), '');
  assert.equal(denied.runtime.shim.input.get(denied.ctx, 'Team', 'Dept', 'Dept_Name'), '');

  const gone = await setup('Reader');
  gone.ctx.record = { Team: '999999' };
  await gone.runtime.shim.input.hydrate(gone.ctx, { Team: 'Team' }, graph);
  assert.equal(gone.runtime.shim.input.get(gone.ctx, 'Team', 'Team_Name'), '');

  const broken = await setup('Reader', '888888');
  broken.ctx.record = { Team: broken.team };
  await broken.runtime.shim.input.hydrate(broken.ctx, { Team: 'Team' }, graph);
  assert.equal(broken.runtime.shim.input.get(broken.ctx, 'Team', 'Team_Name'), 'Optics');
  assert.equal(broken.runtime.shim.input.get(broken.ctx, 'Team', 'Dept', 'Dept_Name'), '');
});

test('five lookups beside a 50-row subform cost at most one read per lookup and chain link', async () => {
  const { runtime, ctx, team, reads } = await setup('Reader');
  ctx.record = { L1: team, L2: team, L3: team, L4: team, L5: team, Rows: Array.from({ length: 50 }, (_, i) => ({ Team: team, N: i })) };
  const links = { L1: 'Team', L2: 'Team', L3: 'Team', L4: 'Team', L5: 'Team' };
  await runtime.shim.input.hydrate(ctx, links, graph);
  assert.ok(reads() <= 10, `reads ${reads()}`);
  assert.equal(runtime.shim.input.get(ctx, 'L5', 'Team_Name'), 'Optics');
});

test('a cycle in the lookup graph stops at the depth cap and the read budget', async () => {
  const { runtime, ctx, team, reads } = await setup('Reader');
  ctx.record = { Team: team };
  await runtime.shim.input.hydrate(ctx, { Team: 'Team' }, { Team: { Dept: 'Dept' }, Dept: { Team: 'Team' } });
  assert.ok(reads() <= 32);
});

test('hydration never writes the record', async () => {
  const { runtime, ctx, team } = await setup('Reader');
  ctx.record = { Team: team };
  await runtime.shim.input.hydrate(ctx, { Team: 'Team' }, graph);
  assert.deepEqual(ctx.record, { Team: team });
});
