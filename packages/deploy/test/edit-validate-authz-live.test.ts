/**
 * The plain /submit edit route must refuse a row the caller cannot modify
 * before any privileged on-edit validate runs. The Requester profile has no
 * View All on Request: only the caller's own rows are inside its modify
 * scope. The form's on-edit validate inserts a marker row into Validate_Log;
 * a caller editing another user's row must get 403 with the marker absent
 * and the row unchanged, while the owner's own edit still runs it.
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
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');

const t = (n: number) => '\t'.repeat(n);

const DS = `application "Log Desk"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}forms
${t(1)}{
${t(2)}form Request
${t(2)}{
${t(3)}Title
${t(3)}(
${t(4)}type = text
${t(3)})
${t(3)}Notes
${t(3)}(
${t(4)}type = text
${t(3)})
${t(2)}}
${t(2)}form Validate_Log
${t(2)}{
${t(3)}Note
${t(3)}(
${t(4)}type = text
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}reports
${t(1)}{
${t(2)}list All_Requests
${t(2)}{
${t(3)}show all rows from Request
${t(3)}(
${t(4)}Title
${t(4)}Notes
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}workflow
${t(1)}{
${t(2)}form
${t(2)}{
${t(3)}Mark_Edit as "Mark Edit"
${t(3)}{
${t(4)}type = form
${t(4)}form = Request
${t(4)}record event = on edit
${t(4)}on validate
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}custom deluge script
${t(6)}(
${t(7)}insert into Validate_Log [ Note = "edit-validate-ran" ];
${t(6)})
${t(5)}}
${t(4)}}
${t(3)}}
${t(3)}Mark_Add as "Mark Add"
${t(3)}{
${t(4)}type = form
${t(4)}form = Request
${t(4)}record event = on add
${t(4)}on success
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}custom deluge script
${t(6)}(
${t(7)}insert into Validate_Log [ Note = "add-success-ran" ];
${t(6)})
${t(5)}}
${t(4)}}
${t(3)}}
${t(2)}}
${t(1)}}
${t(1)}share_settings
${t(1)}{
${t(2)}"Requester"
${t(2)}{
${t(3)}name = "Requester"
${t(3)}type = Users_Permissions
${t(3)}permissions = {Chat:false, Predefined:false, ApiAccess:true, PIIAccess:true, ePHIAccess:true}
${t(3)}ModulePermissions
${t(3)}{
${t(5)}Request
${t(5)}{
${t(6)}enabled= Create,Tab 
${t(6)}allFieldsVisible= true 
${t(6)}ReportPermissions
${t(6)}{
${t(7)}All_Requests={"View","Edit"}
${t(6)}}
${t(5)}}
${t(5)}Validate_Log
${t(5)}{
${t(6)}enabled= Create,Tab 
${t(6)}allFieldsVisible= true 
${t(5)}}
${t(3)}}
${t(2)}}
${t(2)}roles
${t(2)}{
${t(3)}"CEO"
${t(3)}{
${t(4)}description = "Top"
${t(3)}}
${t(2)}}
${t(2)}role Hierarchy = {Request}
${t(1)}}
}
`;

/**
 * The same row gate must run before an `on start` presuccess body: a form
 * with presuccess actions and no on-edit validate still reads the row under
 * the caller's modify scope first, so a foreign row answers 403 before the
 * presuccess module can run its side effects.
 */
const DS_PRESUCCESS = (withSuccess: boolean) => `application "Log Desk"
{
${t(1)}time zone = "Asia/Kolkata"
${t(1)}forms
${t(1)}{
${t(2)}form Request
${t(2)}{
${t(3)}Title
${t(3)}(
${t(4)}type = text
${t(3)})
${t(2)}}
${t(2)}form Validate_Log
${t(2)}{
${t(3)}Note
${t(3)}(
${t(4)}type = text
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}reports
${t(1)}{
${t(2)}list All_Requests
${t(2)}{
${t(3)}show all rows from Request
${t(3)}(
${t(4)}Title
${t(3)})
${t(2)}}
${t(1)}}
${t(1)}workflow
${t(1)}{
${t(2)}form
${t(2)}{
${t(3)}Req_Start as "Req Start"
${t(3)}{
${t(4)}type = presuccess
${t(4)}form = Request
${t(4)}on start
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}insert into Validate_Log [ Note = "presuccess-ran" ];
${t(6)}if (input.Title == "hijack")
${t(6)}{
${t(7)}cancel submit;
${t(6)}}
${t(5)}}
${t(4)}}
${t(3)}}${
  withSuccess
    ? `
${t(3)}Mark_Add as "Mark Add"
${t(3)}{
${t(4)}type = form
${t(4)}form = Request
${t(4)}record event = on add
${t(4)}on success
${t(4)}{
${t(5)}actions
${t(5)}{
${t(6)}custom deluge script
${t(6)}(
${t(7)}insert into Validate_Log [ Note = "add-success-ran" ];
${t(6)})
${t(5)}}
${t(4)}}
${t(3)}}`
    : ''
}
${t(2)}}
${t(1)}}
${t(1)}share_settings
${t(1)}{
${t(2)}"Requester"
${t(2)}{
${t(3)}name = "Requester"
${t(3)}type = Users_Permissions
${t(3)}permissions = {Chat:false, Predefined:false, ApiAccess:true, PIIAccess:true, ePHIAccess:true}
${t(3)}ModulePermissions
${t(3)}{
${t(5)}Request
${t(5)}{
${t(6)}enabled= Create,Tab 
${t(6)}allFieldsVisible= true 
${t(6)}ReportPermissions
${t(6)}{
${t(7)}All_Requests={"View","Edit"}
${t(6)}}
${t(5)}}
${t(5)}Validate_Log
${t(5)}{
${t(6)}enabled= Create,Tab 
${t(6)}allFieldsVisible= true 
${t(5)}}
${t(3)}}
${t(2)}}
${t(2)}roles
${t(2)}{
${t(3)}"CEO"
${t(3)}{
${t(4)}description = "Top"
${t(3)}}
${t(2)}}
${t(2)}role Hierarchy = {Request}
${t(1)}}
}
`;

interface FakeTable {
  insertRows(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
}

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
  initialize(req: unknown): { datastore(): { table(name: string): FakeTable } };
}

const USERS: Record<string, { user_id: string; email_id: string; role_details: { role_name: string } }> = {
  req1: { user_id: '13', email_id: 'req1@example.test', role_details: { role_name: 'Requester' } },
  req2: { user_id: '14', email_id: 'req2@example.test', role_details: { role_name: 'Requester' } },
};

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  return {
    org: FIXTURE_ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: FIXTURE_REGISTRY,
  };
}

test('a foreign-row edit on /submit is refused before the on-edit validate runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-edit-authz-'));
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
    for (const [token, user] of Object.entries(USERS)) sdk.setSession(token, user);
    const [stored] = await sdk
      .initialize({})
      .datastore()
      .table('Request')
      .insertRows([{ Title: 'req1-row', Notes: 'n1', Added_User: 'req1@example.test' }]);
    const rowId = String(stored!.ROWID);
    const entry = require(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const call = async (who: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `c2c-harness-session=${who}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
    };
    const requests = () => sdk.state().tables.Request ?? [];
    const logNotes = () => (sdk.state().tables.Validate_Log ?? []).map((row) => row.Note);
    const row = () => requests().find((item) => String(item.ROWID) === rowId);

    // MUST-FAIL: another user's row is refused before the on-edit validate
    // runs — no marker row, no write, no privileged script body.
    const foreign = await call('req2', '/forms/Request/submit', { ROWID: rowId, record: { Title: 'hijack' } });
    assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
    assert.equal(row()?.Title, 'req1-row', 'a refused edit must not write');
    assert.deepEqual(logNotes(), [], 'the on-edit validate ran for a caller who may not modify the row');

    // The /success edit route refuses the same row before any script too.
    const foreignSuccess = await call('req2', '/forms/Request/success', { ROWID: rowId, record: { Title: 'hijack' } });
    assert.ok(foreignSuccess.status === 403 || foreignSuccess.status === 404, JSON.stringify(foreignSuccess.body));
    assert.equal(row()?.Title, 'req1-row');
    assert.deepEqual(logNotes(), []);

    // The owner's own edit still runs the on-edit validate and writes.
    const own = await call('req1', '/forms/Request/submit', { ROWID: rowId, record: { Title: 'req1-edited' } });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(row()?.Title, 'req1-edited');
    assert.deepEqual(logNotes(), ['edit-validate-ran']);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const withSuccess of [false, true]) {
  test(`a foreign-row edit is refused before the presuccess body runs (add-owning success=${withSuccess})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c2c-edit-authz-'));
    const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
    const original = moduleAny._resolveFilename;
    moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
      if (request === 'zcatalyst-sdk-node') return fake;
      return original.call(this, request, ...rest);
    };
    let server: Server | undefined;
    try {
      const app = deriveIr(parse(DS_PRESUCCESS(withSuccess)));
      writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
      const require = createRequire(import.meta.url);
      const sdk = require(fake) as FakeSdk;
      for (const [token, user] of Object.entries(USERS)) sdk.setSession(token, user);
      const [stored] = await sdk
        .initialize({})
        .datastore()
        .table('Request')
        .insertRows([{ Title: 'req1-row', Added_User: 'req1@example.test' }]);
      const rowId = String(stored!.ROWID);
      const entry = require(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
      server = createServer((rq, rs) => void entry(rq, rs));
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const call = async (who: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
        const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `c2c-harness-session=${who}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
      };
      const row = () => (sdk.state().tables.Request ?? []).find((item) => String(item.ROWID) === rowId);
      // The fake store keeps its tables for the whole process: count the
      // marker rows this run adds rather than an absolute number.
      const markers = () => (sdk.state().tables.Validate_Log ?? []).filter((item) => item.Note === 'presuccess-ran').length;
      const before = markers();

      // MUST-FAIL: another user's row is refused before the presuccess body
      // runs — no marker row, no write. The body's hijack-title cancel makes
      // a run visible as a 422 instead of this 403, since a deferred marker
      // insert alone is silently dropped on refusal. Plain /submit is the
      // edit route in both shapes (the add-owning success is editSubmitEndpoint).
      const foreign = await call('req2', '/forms/Request/submit', { ROWID: rowId, record: { Title: 'hijack' } });
      assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
      assert.equal(row()?.Title, 'req1-row', 'a refused edit must not write');
      assert.equal(markers(), before, 'the presuccess body ran for a caller who may not modify the row');

      if (withSuccess) {
        const foreignSuccess = await call('req2', '/forms/Request/success', { ROWID: rowId, record: { Title: 'hijack' } });
        assert.ok(foreignSuccess.status === 403 || foreignSuccess.status === 404, JSON.stringify(foreignSuccess.body));
        assert.equal(row()?.Title, 'req1-row');
        assert.equal(markers(), before);
      }

      // The owner's own edit still runs the presuccess body once and writes.
      const own = await call('req1', '/forms/Request/submit', { ROWID: rowId, record: { Title: 'req1-edited' } });
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.equal(row()?.Title, 'req1-edited');
      assert.equal(markers(), before + 1);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      moduleAny._resolveFilename = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
