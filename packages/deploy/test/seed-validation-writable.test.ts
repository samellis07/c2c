/**
 * Synthetic library-shaped fixture verifying 0 refused rows offline
 * through the in-process c2c_api harness when seed rows satisfy date-order
 * validation and omit non-writable composite parts.
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
import { generateSeed, seedCompositeMap } from '../../data/src/seed.js';
import { deployFiles, writeDeployTree } from '../src/plan.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const root = repoRoot();
const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const FIXTURE_ORG = '10000000000';
const FIXTURE_REGISTRY: ProjectRegistry = { org: FIXTURE_ORG, env: 'Development', projects: {}, dc: 'in' };

const LIBRARY_APP_DS = `application "LibrarySystem"
{
\ttime zone = "Asia/Kolkata"
\tshare_settings
\t{
\t\t"Administrator"
\t\t{
\t\t\tname = "Administrator"
\t\t\ttype = Users_Permissions
\t\t\tdescription = "This profile will have all the permissions."
\t\t}
\t}
\tforms
\t{
\t\tform Catalog_Item
\t\t{
\t\t\tItem_Title
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t\tform Loan_Record
\t\t{
\t\t\tCheckout_Date
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tDue_Date
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t}
\t\tform Staff_Profile
\t\t{
\t\t\tFull_Name
\t\t\t(
\t\t\t\ttype = name
\t\t\t\tprefix
\t\t\t\t(
\t\t\t\t\ttype = prefix
\t\t\t\t\tdisplayname = "Prefix"
\t\t\t\t\tvisibility = false
\t\t\t\t\tvalue = {"Mr.","Mrs.","Ms."}
\t\t\t\t)
\t\t\t\tfirst_name
\t\t\t\t(
\t\t\t\t\ttype = first_name
\t\t\t\t\tdisplayname = "First Name"
\t\t\t\t)
\t\t\t\tlast_name
\t\t\t\t(
\t\t\t\t\ttype = last_name
\t\t\t\t\tdisplayname = "Last Name"
\t\t\t\t)
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tLoan_Validation as "Loan Due Date after Checkout Date"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Loan_Record
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (input.Due_Date <= input.Checkout_Date)
\t\t\t\t\t\t\t{
\t\t\t\t\t\t\t\talert "Due Date must be greater than Checkout Date";
\t\t\t\t\t\t\t\tcancel submit;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

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

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Record<string, unknown>[]> };
}

interface PostReply {
  status: number;
  body: Record<string, unknown>;
}

test('generateSeed satisfies date-order rules and omits non-writable composite parts', () => {
  const app = deriveIr(parse(LIBRARY_APP_DS));
  const seed = generateSeed(app, { n: 10, seed: 'lib-synthetic' });

  // 1. Staff_Profile omits prefix
  const composites = seedCompositeMap(app);
  const staffParts = composites.Staff_Profile?.Full_Name ?? [];
  const partNames = staffParts.map((p) => p.part);
  assert.ok(!partNames.includes('prefix'), 'non-writable prefix must be omitted from seed composite parts');
  assert.ok(partNames.includes('first_name'), 'writable first_name must be present');
  assert.ok(partNames.includes('last_name'), 'writable last_name must be present');

  const staffTable = seed.tables.find((t) => t.form === 'Staff_Profile')!;
  assert.ok(staffTable, 'Staff_Profile table must be generated');
  for (const row of staffTable.rows) {
    assert.equal(row.columns.Full_Name_prefix, undefined, 'seed rows must not contain Full_Name_prefix');
    assert.ok(row.columns.Full_Name_first_name, 'first_name must be present in row');
    assert.ok(row.columns.Full_Name_last_name, 'last_name must be present in row');
  }

  // 2. Loan_Record dates satisfy Due_Date > Checkout_Date
  const loanTable = seed.tables.find((t) => t.form === 'Loan_Record')!;
  assert.ok(loanTable, 'Loan_Record table must be generated');
  for (const row of loanTable.rows) {
    const checkout = row.columns.Checkout_Date!;
    const due = row.columns.Due_Date!;
    assert.ok(checkout, 'Checkout_Date must be set');
    assert.ok(due, 'Due_Date must be set');
    assert.ok(due > checkout, `Due_Date (${due}) must be strictly greater than Checkout_Date (${checkout})`);
  }

  // 3. Byte-identical determinism
  const seedAgain = generateSeed(app, { n: 10, seed: 'lib-synthetic' });
  assert.deepEqual(seed.tables, seedAgain.tables, 'generateSeed must be byte-identical per seed');
});

test('synthetic library seed rows achieve 0 refused rows offline through in-process harness', async () => {
  const app = deriveIr(parse(LIBRARY_APP_DS));
  const composites = seedCompositeMap(app);
  const seed = generateSeed(app, { n: 5, seed: 'lib-synthetic' });

  const dir = mkdtempSync(join(tmpdir(), 'c2c-seed-verify-'));
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };

  let server: Server | undefined;
  try {
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as FakeSdk;
    sdk.setSession('admin', { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });

    const entry = req(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const postForm = async (form: string, record: Record<string, unknown>): Promise<PostReply> => {
      const res = await fetch(`http://127.0.0.1:${port}/server/c2c_api/forms/${encodeURIComponent(form)}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'c2c-harness-session=admin' },
        body: JSON.stringify({ record }),
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await res.text();
      return { status: res.status, body: JSON.parse(raw) as Record<string, unknown> };
    };

    let refusedCount = 0;

    // Submit Catalog_Item rows
    const catalogTable = seed.tables.find((t) => t.form === 'Catalog_Item')!;
    for (const row of catalogTable.rows) {
      const reply = await postForm('Catalog_Item', { Item_Title: row.columns.Item_Title });
      if (reply.status !== 200 || !reply.body.wrote) refusedCount++;
      assert.equal(reply.status, 200);
      assert.equal(reply.body.wrote, true);
    }

    // Submit Loan_Record rows (satisfies validation)
    const loanTable = seed.tables.find((t) => t.form === 'Loan_Record')!;
    for (const row of loanTable.rows) {
      const reply = await postForm('Loan_Record', {
        Checkout_Date: row.columns.Checkout_Date,
        Due_Date: row.columns.Due_Date,
      });
      if (reply.status !== 200 || !reply.body.wrote) refusedCount++;
      assert.equal(reply.status, 200, `Loan_Record submit should succeed: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.wrote, true);
    }

    // Submit Staff_Profile rows (omits non-writable prefix)
    const staffTable = seed.tables.find((t) => t.form === 'Staff_Profile')!;
    const staffComposites = composites.Staff_Profile?.Full_Name ?? [];
    for (const row of staffTable.rows) {
      const fullName: Record<string, string> = {};
      for (const p of staffComposites) {
        if (row.columns[p.column] !== undefined) fullName[p.part] = row.columns[p.column]!;
      }
      const reply = await postForm('Staff_Profile', { Full_Name: fullName });
      if (reply.status !== 200 || !reply.body.wrote) refusedCount++;
      assert.equal(reply.status, 200, `Staff_Profile submit should succeed: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.wrote, true);
    }

    assert.equal(refusedCount, 0, 'Seed submission must have 0 refused rows');

    // Negative verification 1: equal dates trigger 422 refusal
    const refusedDate = await postForm('Loan_Record', {
      Checkout_Date: '2020-01-01',
      Due_Date: '2020-01-01',
    });
    assert.equal(refusedDate.status, 422, 'Equal dates must trigger 422 refusal');
    assert.equal(refusedDate.body.refused, true);
    assert.match(String(refusedDate.body.message || refusedDate.body.error), /Due Date must be greater than Checkout Date/);

    // Negative verification 2: non-writable prefix triggers 403 refusal
    const refusedPrefix = await postForm('Staff_Profile', {
      Full_Name: {
        prefix: 'Mr.',
        first_name: 'Avery',
        last_name: 'Carter',
      },
    });
    assert.equal(refusedPrefix.status, 403, 'Non-writable prefix must trigger 403 refusal');
    assert.match(String(refusedPrefix.body.message || refusedPrefix.body.error), /cannot write Staff_Profile\.Full_Name\.prefix/);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    moduleAny._resolveFilename = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('date order rule cycle emits a counted warning and does not skip rows', () => {
  const CYCLE_DS = `application "CycleApp"
{
\tforms
\t{
\t\tform Event
\t\t{
\t\t\tStarts
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEnds
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRule1 as "Rule1"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Event
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (input.Starts >= input.Ends) { cancel submit; }
\t\t\t\t\t\t\tif (input.Ends >= input.Starts) { cancel submit; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(CYCLE_DS));
  const seed = generateSeed(app, { n: 3, seed: 'cycle-test' });
  assert.equal(seed.tables.find((t) => t.form === 'Event')?.rows.length, 3, 'rows must not be skipped on cycle');
  const cycleWarning = seed.warnings.find((w) => w.form === 'Event' && /cycle/i.test(w.message));
  assert.ok(cycleWarning, 'must emit counted warning naming table and cycle');
});

test('hidden composite field omits every part from the seed', () => {
  const HIDDEN_DS = `application "HiddenCompositeApp"
{
\tforms
\t{
\t\tform Member
\t\t{
\t\t\tFull_Name
\t\t\t(
\t\t\t\ttype = name
\t\t\t\tvisibility = false
\t\t\t\tfirst_name
\t\t\t\t(
\t\t\t\t\ttype = first_name
\t\t\t\t)
\t\t\t\tlast_name
\t\t\t\t(
\t\t\t\t\ttype = last_name
\t\t\t\t)
\t\t\t)
\t\t}
\t}
}
`;
  const app = deriveIr(parse(HIDDEN_DS));
  const seed = generateSeed(app, { n: 3, seed: 'hidden-composite' });
  const parts = seedCompositeMap(app).Member?.Full_Name ?? [];
  assert.equal(parts.length, 0, 'a hidden composite field must contribute no writable parts');
  const table = seed.tables.find((t) => t.form === 'Member')!;
  for (const row of table.rows) {
    for (const key of Object.keys(row.columns)) {
      assert.ok(!key.startsWith('Full_Name_'), `hidden composite must not seed ${key}`);
    }
  }
});

test('a field rule naming the bare part name does not deny the composite part', () => {
  const BARE_RULE_DS = `application "BareRuleApp"
{
\tforms
\t{
\t\tform Member
\t\t{
\t\t\tFull_Name
\t\t\t(
\t\t\t\ttype = name
\t\t\t\tfirst_name
\t\t\t\t(
\t\t\t\t\ttype = first_name
\t\t\t\t)
\t\t\t\tlast_name
\t\t\t\t(
\t\t\t\t\ttype = last_name
\t\t\t\t)
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Member
\t\t\t\trecord event = on add
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\thide first_name;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(BARE_RULE_DS));
  const parts = seedCompositeMap(app).Member?.Full_Name ?? [];
  const partNames = parts.map((p) => p.part);
  assert.ok(partNames.includes('first_name'), 'a bare-name rule must not match the dotted composite part');
  assert.ok(partNames.includes('last_name'));
});

test('a field rule naming the dotted composite part denies that part only', () => {
  // Dotted field-rule targets do not parse out of DS actions blocks, so the
  // rule is attached to the parsed IR the way the parser would emit it.
  const BARE_DS = `application "DottedRuleApp"
{
\tforms
\t{
\t\tform Member
\t\t{
\t\t\tFull_Name
\t\t\t(
\t\t\t\ttype = name
\t\t\t\tfirst_name
\t\t\t\t(
\t\t\t\t\ttype = first_name
\t\t\t\t)
\t\t\t\tlast_name
\t\t\t\t(
\t\t\t\t\ttype = last_name
\t\t\t\t)
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Member
\t\t\t\trecord event = on add
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\thide other_field;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(BARE_DS));
  app.workflows[0]!.fieldRules = [
    { actions: [{ action: 'hide', fields: ['Full_Name.first_name'] }], span: app.workflows[0]!.fieldRules![0]!.span },
  ];
  const parts = seedCompositeMap(app).Member?.Full_Name ?? [];
  const partNames = parts.map((p) => p.part);
  assert.ok(!partNames.includes('first_name'), 'a dotted rule must deny the named composite part');
  assert.ok(partNames.includes('last_name'), 'other parts stay writable');
});

test('a negated date-order rule still orders seed rows', () => {
  const NEGATED_DS = `application "NegatedApp"
{
\tforms
\t{
\t\tform Event
\t\t{
\t\t\tStarts
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEnds
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRule1 as "Rule1"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Event
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (!(input.Ends > input.Starts)) { cancel submit; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(NEGATED_DS));
  const seed = generateSeed(app, { n: 3, seed: 'negated-test' });
  const table = seed.tables.find((t) => t.form === 'Event')!;
  assert.equal(table.rows.length, 3);
  for (const row of table.rows) {
    assert.ok(row.columns.Ends! > row.columns.Starts!, `Ends (${row.columns.Ends}) must be after Starts (${row.columns.Starts})`);
  }
});

test('a date method call in a guard emits a counted warning', () => {
  const CALL_DS = `application "CallApp"
{
\tforms
\t{
\t\tform Event
\t\t{
\t\t\tStarts
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEnds
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRule1 as "Rule1"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Event
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (input.Starts.daysBetween(input.Ends) < 0) { cancel submit; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(CALL_DS));
  const seed = generateSeed(app, { n: 3, seed: 'call-test' });
  const warn = seed.warnings.find((w) => w.form === 'Event' && /cannot be satisfied generically/i.test(w.message));
  assert.ok(warn, 'a date method call that yields no constraint must emit a counted warning');
});

test('a parent rule is not double-counted on the subform child table', () => {
  const SUBFORM_DS = `application "SubformApp"
{
\tforms
\t{
\t\tform Event
\t\t{
\t\t\tStarts
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEnds
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tLines
\t\t\t(
\t\t\t\ttype = grid
\t\t\t\tStart
\t\t\t\t(
\t\t\t\t\ttype = date
\t\t\t\t)
\t\t\t\tEnd
\t\t\t\t(
\t\t\t\t\ttype = date
\t\t\t\t)
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRule1 as "Rule1"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Event
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (input.Starts.daysBetween(input.Ends) < 0) { cancel submit; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(SUBFORM_DS));
  const seed = generateSeed(app, { n: 3, seed: 'subform-test' });
  const counted = seed.warnings.filter((w) => /cannot be satisfied generically/i.test(w.message));
  assert.equal(counted.length, 1, `one rule must yield one counted warning, got ${JSON.stringify(counted)}`);
  assert.equal(counted[0]!.form, 'Event', 'the warning must name the form the rule belongs to');
});

test('unsupported date rule expression emits a counted warning and does not skip rows', () => {
  const UNSUPPORTED_DS = `application "UnsupportedApp"
{
\tforms
\t{
\t\tform Event
\t\t{
\t\t\tStarts
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEnds
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRule1 as "Rule1"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Event
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (input.Starts.addDays(1) <= input.Ends) { cancel submit; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(UNSUPPORTED_DS));
  const seed = generateSeed(app, { n: 3, seed: 'unsupported-test' });
  assert.equal(seed.tables.find((t) => t.form === 'Event')?.rows.length, 3, 'rows must not be skipped on unsupported rule');
  const warn = seed.warnings.find((w) => w.form === 'Event' && /date order rule.*cannot be satisfied/i.test(w.message));
  assert.ok(warn, 'must emit counted warning naming table and rule');
});

test('a negated call guard yields its sibling constraint instead of dropping the workflow', () => {
  const NEGATED_CALL_DS = `application "NegatedCallApp"
{
\tforms
\t{
\t\tform Event
\t\t{
\t\t\tStarts
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEnds
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRule1 as "Rule1"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Event
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (!isNull(input.Ends) && input.Ends <= input.Starts) { cancel submit; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(NEGATED_CALL_DS));
  const seed = generateSeed(app, { n: 3, seed: 'negated-call' });
  const table = seed.tables.find((t) => t.form === 'Event')!;
  assert.equal(table.rows.length, 3);
  for (const row of table.rows) {
    assert.ok(row.columns.Ends! > row.columns.Starts!, `Ends (${row.columns.Ends}) must be after Starts (${row.columns.Starts})`);
  }
  const warn = seed.warnings.find((w) => w.form === 'Event' && /cannot be satisfied generically/i.test(w.message));
  assert.ok(warn, 'the negated call leaf must be counted as a warning, not drop the workflow');
});

test('a negated call guard on a non-date field emits no warning', () => {
  const NON_DATE_DS = `application "NonDateApp"
{
\tforms
\t{
\t\tform Event
\t\t{
\t\t\tStarts
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEnds
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEmail
\t\t\t(
\t\t\t\ttype = email
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRule1 as "Rule1"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Event
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (!input.Email.contains("@")) { cancel submit; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(NON_DATE_DS));
  const seed = generateSeed(app, { n: 3, seed: 'non-date-guard' });
  assert.equal(seed.tables.find((t) => t.form === 'Event')?.rows.length, 3);
  const warned = seed.warnings.filter((w) => w.form === 'Event');
  assert.equal(warned.length, 0, `a non-date negated guard must emit no warning, got ${JSON.stringify(warned)}`);
});

test('a deeply nested negated guard finishes and is counted', () => {
  const NOTS = '!'.repeat(700);
  const DEEP_DS = `application "DeepApp"
{
\tforms
\t{
\t\tform Event
\t\t{
\t\t\tStarts
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t\tEnds
\t\t\t(
\t\t\t\ttype = date
\t\t\t)
\t\t}
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRule1 as "Rule1"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Event
\t\t\t\trecord event = on add
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif (${NOTS}(input.Ends > input.Starts)) { cancel submit; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;
  const app = deriveIr(parse(DEEP_DS));
  const seed = generateSeed(app, { n: 3, seed: 'deep-nest' });
  assert.equal(seed.tables.find((t) => t.form === 'Event')?.rows.length, 3);
  const warn = seed.warnings.find((w) => w.form === 'Event' && /cannot be satisfied generically|unparseable/i.test(w.message));
  assert.ok(warn, 'a guard deeper than the analysis backstop must still be counted');
});
