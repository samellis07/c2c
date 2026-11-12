/**
 * An edit runs only the validates Creator runs for an edit. The export's
 * on-validate script is scoped `record event = on add` and counts rows with
 * the same Staff lookup; an edit of one field (Reading) of a stored row whose
 * optional Staff lookup is blank must not run it. Creator saves that edit.
 *
 * The edit still validates what Creator validates: blanking the mandatory
 * Supervisor lookup is refused, and a lookup value with a forged key is
 * refused before anything is written. An add still runs the add validate.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { generate } from '../../deluge/src/generate.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

const t = (n: number) => '\t'.repeat(n);

const DS = `application "Site Log"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}forms
${t(1)}{
${t(2)}form Crew_Member
${t(2)}{
${t(3)}must have Full_Name
${t(3)}(
${t(4)}type = text
${t(3)})
${t(2)}}
${t(2)}form Shift_Log
${t(2)}{
${t(3)}Staff
${t(3)}(
${t(4)}type = picklist
${t(4)}values = Crew_Member.ID
${t(4)}displayformat = [Full_Name]
${t(3)})
${t(3)}must have Supervisor
${t(3)}(
${t(4)}type = picklist
${t(4)}values = Crew_Member.ID
${t(4)}displayformat = [Full_Name]
${t(3)})
${t(3)}Reading
${t(3)}(
${t(4)}type = decimal
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}reports
${t(1)}{
${t(2)}list All_Shift_Logs
${t(2)}{
${t(3)}show all rows from Shift_Log
${t(3)}(
${t(4)}Staff
${t(4)}Supervisor
${t(4)}Reading
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}workflow
${t(1)}{
${t(2)}form
${t(2)}{
${t(3)}One_Log_Per_Staff as "One Log Per Staff"
${t(3)}{
${t(4)}type = form
${t(4)}form = Shift_Log
${t(4)}record event = on add
${t(4)}on validate
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}custom deluge script
${t(6)}(
${t(7)}logged = Shift_Log[Staff == input.Staff].count();
${t(7)}if(logged == 1)
${t(7)}{
${t(8)}alert "Already logged for this staff member";
${t(8)}cancel submit;
${t(7)}}
${t(6)})
${t(5)}}
${t(4)}}
${t(3)}}
${t(3)}Stamp_Log as "Stamp Log"
${t(3)}{
${t(4)}type = form
${t(4)}form = Shift_Log
${t(4)}record event = on add
${t(4)}on success
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}custom deluge script
${t(6)}(
${t(7)}crew = Crew_Member[ID == input.Supervisor].count();
${t(6)})
${t(5)}}
${t(4)}}
${t(3)}}
${t(2)}}
${t(1)}}
${t(1)}share_settings
${t(1)}{
${t(2)}"Administrator"
${t(2)}{
${t(3)}name = "Administrator"
${t(3)}type = Users_Permissions
${t(3)}description = "This profile will have all the permissions."
${t(2)}}
${t(1)}}
}
`;

interface FakeTable {
  insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
}

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
  initialize(req: unknown, opts: { scope: string }): { datastore(): { table(name: string): FakeTable } };
}

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  return {
    org: '10000000000',
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: { org: '10000000000', env: 'Development', projects: {}, dc: 'in' },
  };
}

test('an edit of one field skips the add-only validate; mandatory and lookup-shape rules still refuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-edit-add-validate-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  let server: Server | undefined;
  try {
    const app = deriveIr(parse(DS));
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const require = createRequire(import.meta.url);
    const sdk = require(fake) as FakeSdk;
    sdk.setSession('admin', { user_id: '31', email_id: 'admin@example.test', role_details: { role_name: 'Administrator' } });
    const store = sdk.initialize({}, { scope: 'admin' }).datastore();
    const [crew] = await store.table('Crew_Member').insertRows([{ Full_Name: 'Rowan Vale' }]);
    const crewId = String(crew!.ROWID);
    // A stored row whose optional Staff lookup is blank, as an import leaves it.
    const [stored] = await store.table('Shift_Log').insertRows([{ Staff: '', Supervisor: crewId, Reading: '12.50' }]);
    const rowId = String(stored!.ROWID);
    const entry = require(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const post = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/forms/Shift_Log/success`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=admin' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
    };
    const row = () => (sdk.state().tables.Shift_Log ?? []).find((r) => r.ROWID === rowId);

    // The one-field edit saves: the add-only validate does not run.
    const edit = await post({ ROWID: rowId, record: { Reading: 590 } });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.wrote, true);
    assert.equal(Number(row()?.Reading), 590);
    assert.equal(row()?.Staff, '', 'the unchanged blank lookup is left as stored');

    // MUST-FAIL: blanking the mandatory lookup on edit is still refused.
    const blankMandatory = await post({ ROWID: rowId, record: { Supervisor: '' } });
    assert.equal(blankMandatory.status, 422, JSON.stringify(blankMandatory.body));
    assert.equal(blankMandatory.body.code, 'MANDATORY_MISSING');
    assert.equal(blankMandatory.body.field, 'Supervisor');
    assert.equal(row()?.Supervisor, crewId);

    // MUST-FAIL: a lookup value carrying a forged key is refused unwritten.
    const forged = await post({ ROWID: rowId, record: { Staff: { id: crewId, ROWID: '1' } } });
    assert.equal(forged.status, 403, JSON.stringify(forged.body));
    assert.equal(row()?.Staff, '');

    // MUST-FAIL: an add still runs the add validate (one log per staff member).
    const first = await post({ record: { Staff: crewId, Supervisor: crewId, Reading: 1 } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await post({ record: { Staff: crewId, Supervisor: crewId, Reading: 2 } });
    assert.equal(second.status, 422, JSON.stringify(second.body));
    assert.equal(second.body.refused, true);
    assert.equal(second.body.message, 'Already logged for this staff member');
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the generated success route picks validates by the request ROWID, also for an add-scoped module', () => {
  const success = generate(deriveIr(parse(DS))).files.find((file) => file.path === 'functions/aio/shift-log/on-success.mjs');
  assert.ok(success);
  assert.match(success.source, /const validateAdd = \["\.\/on-validate\.mjs"\];\nconst validateEdit = \[\];/);
  assert.match(success.source, /function validateSpecsFor\(rowId\) \{\n {2}return rowId \? validateEdit : validateAdd;\n\}/);
});
