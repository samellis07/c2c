/**
 * The customer's data centre comes from config: --dc, c2c-deploy.json,
 * projects.json `dc`, or the Catalyst CLI login. Nothing configured is an
 * error, never IN. Only base-era exports are imported so these run on the
 * pre-fix tree too (RED there).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrateResponse } from '../../data/src/migrate.js';
import { rowEndpoint } from '../../data/test/catalyst-row-fake.js';
import { deployCli, seedMigrateCli, smokeCli, sourceCsvCli, type Io } from '../src/cli.js';
import { deployMailRecipients, readDeployConfig } from '../src/dc.js';
import { checkGuards } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';

const SECRET = '/tmp/cred-DO-NOT-PRINT';
const ORG = '10000000000';
const DS = `application "Widget"
{
	form Item
	{
		Name
		(
			type = text
		)
	}
	list Open_Items
	{
		show all rows from Item
	}
}
`;

function response(body: unknown, status = 200): MigrateResponse {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

/** A tmp dir holding widget.ds and a projects.json; `dc` omitted means projects.json names none. */
function workspace(dc?: string): { dir: string; ds: string; projects: string } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-dc-'));
  const ds = join(dir, 'widget.ds');
  writeFileSync(ds, DS);
  const projects = join(dir, 'projects.json');
  writeFileSync(projects, JSON.stringify({ org: ORG, ...(dc ? { dc } : {}), env: 'Development', projects: { 'c2c-widget': '1001' } }));
  return { dir, ds, projects };
}

function capture(cliDc?: string) {
  let out = '';
  let err = '';
  const fetched: string[] = [];
  const stored = new Map<string, Record<string, unknown>>();
  const io = {
    stdout: (text: string) => void (out += text),
    stderr: (text: string) => void (err += text),
    env: { X_ZC_CREDENTIAL_PATH: SECRET },
    cliDc: () => cliDc,
    spawn: async () => assert.fail('no catalyst CLI spawn in a DC test'),
    fetch: rowEndpoint(async (url: string, init?: { method?: string; body?: string }) => {
      fetched.push(url);
      if ((init?.method ?? 'GET') === 'GET') throw new Error('called Creator');
      if (new URL(url).pathname.endsWith('/query')) {
        const sql = (JSON.parse(init?.body ?? '{}') as { query: string }).query;
        if (/COUNT\(/i.test(sql)) return response({ data: [{ 'COUNT(ROWID)': String(stored.size) }] });
        return response({ data: [...stored.values()] });
      }
      const body = JSON.parse(init?.body ?? '{}') as { rows?: { id: string; columns?: { c2c_source_id?: string } }[] };
      for (const row of body.rows ?? []) {
        const id = String(row.columns?.c2c_source_id ?? row.id);
        stored.set(id, { ...row.columns, c2c_source_id: id, ROWID: `r${id}` });
      }
      return response({ ids: (body.rows ?? []).map((row) => row.id) });
    }),
    rest: async (call: { method: string; path: string }) => {
      if (call.method === 'GET' && call.path === '/baas/v1/project/1001') {
        return { status: 200, body: { data: { id: '1001', org_id: ORG } } };
      }
      // The provisioned-constraints read: an empty list means every Creator flag stands.
      if (call.method === 'GET' && call.path === '/baas/v1/project/1001/table') {
        return { status: 200, body: { data: [] } };
      }
      // The Stratus first-use gate probe: an opened service lists its buckets.
      if (call.method === 'GET' && call.path === '/baas/v1/project/1001/bucket') {
        return { status: 200, body: { status: 'success', data: [] } };
      }
      assert.fail(`no admin REST in a DC test except the project-details, table-metadata and gate checks (${call.method} ${call.path})`);
    },
    accessToken: async () => 'test-cli-token',
    sleep: async () => {},
  } as unknown as Io;
  return { io, stdout: () => out, stderr: () => err, fetched };
}

function hosts(urls: readonly string[]): string[] {
  return [...new Set(urls.map((url) => new URL(url).origin))];
}

test('checkGuards refuses a registry with no DC instead of defaulting to IN', () => {
  const noDc: ProjectRegistry = { org: ORG, env: 'Development', projects: { 'c2c-bill-of-materials': '10000000000000001' } };
  assert.throws(
    () =>
      checkGuards({
        org: ORG,
        projectId: '10000000000000001',
        appLink: 'Bill Of Materials',
        credentialPath: SECRET,
        registry: noDc,
      }),
    /data centre is not configured.*--dc/,
  );
});

test('a plan with no DC uses a placeholder; confirm refuses before it writes', async () => {
  const { ds, projects } = workspace();
  const cap = capture(undefined);
  const code = await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects], cap.io);
  assert.equal(code, 0, cap.stderr());
  assert.match(cap.stdout(), /^data_centre: <dc>$/m);
  assert.match(cap.stdout(), /data centre is configured/);
  assert.equal(cap.stdout().includes('catalyst CLI login'), false);
  const confirm = capture(undefined);
  assert.notEqual(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects, '--confirm', '--function-env', 'new'], confirm.io), 0);
  assert.match(confirm.stderr(), /data centre is not configured/);
  assert.equal(confirm.stdout().includes('c2c deploy plan'), false);
});

test('deploy dry run states the DC and where it came from, in precedence order', async () => {
  const { dir, ds, projects } = workspace('in');
  const fromFlag = capture('jp');
  assert.equal(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects, '--dc', 'eu'], fromFlag.io), 0, fromFlag.stderr());
  assert.match(fromFlag.stdout(), /^data_centre: eu \(from --dc\)$/m);

  const fromRegistry = capture('jp');
  assert.equal(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects], fromRegistry.io), 0, fromRegistry.stderr());
  assert.match(fromRegistry.stdout(), new RegExp(`^data_centre: in \\(from ${projects.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`, 'm'));

  const config = join(dir, 'c2c-deploy.json');
  writeFileSync(config, JSON.stringify({ dc: 'us' }));
  const fromConfig = capture('jp');
  assert.equal(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects], fromConfig.io), 0, fromConfig.stderr());
  assert.ok(fromConfig.stdout().includes(`data_centre: us (from ${config})\n`), fromConfig.stdout());

  // The runtime's key and its domain-suffix spelling work too.
  writeFileSync(config, JSON.stringify({ zohoDc: 'com.au' }));
  const zohoDc = capture('jp');
  assert.equal(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects], zohoDc.io), 0, zohoDc.stderr());
  assert.ok(zohoDc.stdout().includes(`data_centre: au (from ${config})\n`), zohoDc.stdout());

  writeFileSync(config, JSON.stringify({ dc: 'eu', zohoDc: 'in' }));
  const conflict = capture('jp');
  assert.notEqual(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects], conflict.io), 0);
  assert.match(conflict.stderr(), /sets "dc" eu and "zohoDc" in; they must agree/);
});

test('a plan does not read the Catalyst CLI login DC; confirm uses it when nothing else is set', async () => {
  const { ds, projects } = workspace();
  // A live confirm also needs the application time zone. The plan is printed before any CLI spawn.
  writeFileSync(ds, DS.replace('{\n', '{\ntime zone = "Asia/Kolkata"\n'));
  // zcatalyst-cli stores US as active_dc "com".
  const cap = capture('com');
  assert.equal(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects], cap.io), 0, cap.stderr());
  assert.match(cap.stdout(), /^data_centre: <dc>$/m);
  assert.equal(cap.stdout().includes('catalyst CLI login'), false);
  const confirm = capture('com');
  const code = await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects, '--confirm', '--function-env', 'new'], confirm.io);
  assert.notEqual(code, 0);
  assert.match(confirm.stdout(), /^data_centre: us \(from catalyst CLI login \(active_dc\)\)$/m);
  assert.match(confirm.stderr(), /no catalyst CLI spawn/);
});

test('an unknown DC is refused with the valid ones listed', async () => {
  const { ds, projects } = workspace('in');
  const cap = capture(undefined);
  assert.notEqual(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects, '--dc', 'xx'], cap.io), 0);
  assert.match(cap.stderr(), /unknown data centre "xx"; valid values: us, eu, in, au, jp, ca, sa, ae/);
  const dangling = capture(undefined);
  assert.notEqual(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects, '--dc'], dangling.io), 0);
  assert.match(dangling.stderr(), /--dc needs a value/);
});

for (const [dc, catalyst] of [
  ['us', 'https://api.catalyst.zoho.com'],
  ['eu', 'https://api.catalyst.zoho.eu'],
] as const) {
  test(`seed migrate --confirm writes to the ${dc} Catalyst API`, async () => {
    const { dir, ds, projects } = workspace();
    const seed = join(dir, 'seed.json');
    writeFileSync(seed, JSON.stringify({ version: 1, tables: [{ table: 'Item', rows: [{ c2c_source_id: 's1', Name: 'a' }] }] }));
    const cap = capture(undefined);
    const args = ['--seed', seed, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', ORG, '--projects', projects, '--dc', dc];
    assert.equal(await seedMigrateCli(args, cap.io), 0, cap.stderr());
    assert.match(cap.stdout(), new RegExp(`^data_centre: ${dc} \\(from --dc\\)$`, 'm'));
    assert.equal(cap.fetched.length, 0);
    assert.equal(await seedMigrateCli([...args, '--confirm'], cap.io), 0, cap.stderr());
    assert.ok(cap.fetched.length > 0);
    assert.deepEqual(hosts(cap.fetched), [catalyst]);
  });

  test(`source csv --confirm writes to the ${dc} Catalyst API`, async () => {
    const { ds, projects } = workspace(dc);
    const csv = mkdtempSync(join(tmpdir(), 'c2c-dc-csv-'));
    writeFileSync(join(csv, 'Item.csv'), 'ID,Name\n1,Bolt\n');
    writeFileSync(join(csv, 'counts.json'), JSON.stringify({ Item: 1 }));
    const cap = capture(undefined);
    const args = ['--source-csv', csv, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', ORG, '--projects', projects];
    assert.equal(await sourceCsvCli(args, cap.io), 0, cap.stderr());
    assert.match(cap.stdout(), new RegExp(`^data_centre: ${dc} \\(from .*projects\\.json\\)$`, 'm'));
    assert.equal(await sourceCsvCli([...args, '--confirm'], cap.io), 0, cap.stderr());
    assert.ok(cap.fetched.length > 0);
    assert.deepEqual(hosts(cap.fetched), [catalyst]);
  });

  test(`deploy --backfill-shadows --confirm reads the ${dc} Catalyst API`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c2c-dc-'));
    const ds = join(dir, 'widget.ds');
    writeFileSync(ds, DS.replace('type = text', 'type = decimal'));
    writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ dc }));
    const projects = join(dir, 'projects.json');
    writeFileSync(projects, JSON.stringify({ org: ORG, env: 'Development', projects: { 'c2c-widget': '1001' } }));
    const cap = capture(undefined);
    const args = [ds, '--project', '1001', '--org', ORG, '--projects', projects, '--backfill-shadows'];
    assert.equal(await deployCli(args, cap.io), 0, cap.stderr());
    assert.match(cap.stdout(), new RegExp(`^data_centre: ${dc} \\(from .*c2c-deploy\\.json\\)$`, 'm'));
    assert.equal(await deployCli([...args, '--confirm'], cap.io), 0, cap.stderr());
    assert.ok(cap.fetched.length > 0);
    assert.deepEqual(hosts(cap.fetched), [catalyst]);
  });
}

test('--catalyst-base still overrides the base once a DC is resolved', async () => {
  const { dir, ds, projects } = workspace();
  const seed = join(dir, 'seed.json');
  writeFileSync(seed, JSON.stringify({ version: 1, tables: [{ table: 'Item', rows: [{ c2c_source_id: 's1', Name: 'a' }] }] }));
  const cap = capture(undefined);
  const args = ['--seed', seed, '--ds', ds, '--app', 'Widget', '--project', '1001', '--org', ORG, '--projects', projects, '--dc', 'eu', '--catalyst-base', 'https://custom-base.zoho.eu', '--confirm'];
  assert.equal(await seedMigrateCli(args, cap.io), 0, cap.stderr());
  assert.deepEqual(hosts(cap.fetched), ['https://custom-base.zoho.eu']);
});

test('smoke plan states the DC', async () => {
  const { ds, projects } = workspace();
  const cap = capture(undefined);
  assert.equal(await smokeCli([ds, '--project', '1001', '--org', ORG, '--projects', projects, '--dc', 'eu'], cap.io), 0, cap.stderr());
  assert.match(cap.stdout(), /^data_centre: eu \(from --dc\)$/m);
});

test('c2c-deploy.json mail.testRecipients is parsed, validated, and fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-dc-mail-'));
  const config = join(dir, 'c2c-deploy.json');
  writeFileSync(config, JSON.stringify({ dc: 'in' }));
  assert.deepEqual(readDeployConfig(config).mail, undefined);
  assert.deepEqual(deployMailRecipients(config), []);
  assert.deepEqual(deployMailRecipients(undefined), []);
  writeFileSync(config, JSON.stringify({ dc: 'in', mail: { testRecipients: [' owner@example.com '] } }));
  assert.deepEqual(readDeployConfig(config).mail, { testRecipients: ['owner@example.com'] });
  assert.deepEqual(deployMailRecipients(config), ['owner@example.com']);
  writeFileSync(config, JSON.stringify({ dc: 'in', mail: { testRecipients: [] } }));
  assert.deepEqual(deployMailRecipients(config), []);
  for (const bad of [
    { mail: { testRecipients: 'owner@example.com' } },
    { mail: { testRecipients: ['not-an-address'] } },
    { mail: { testRecipients: [''] } },
    { mail: { testRecipients: [42] } },
    { mail: ['owner@example.com'] },
  ]) {
    writeFileSync(config, JSON.stringify({ dc: 'in', ...bad }));
    assert.throws(() => readDeployConfig(config), /mail/);
  }
});

test('deploy --mail reads test recipients from c2c-deploy.json, default none', async () => {
  const { dir, ds, projects } = workspace('in');
  const out = join(dir, 'out');
  const noMail = capture('in');
  assert.equal(await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects, '--mail', '--out', out], noMail.io), 0, noMail.stderr());
  assert.match(noMail.stdout(), /^allowlist:\s*$/m);
  assert.deepEqual((JSON.parse(readFileSync(join(out, 'c2c-mail.json'), 'utf8')) as { allowlist: string[] }).allowlist, []);

  const config = join(dir, 'c2c-deploy.json');
  writeFileSync(config, JSON.stringify({ dc: 'in', mail: { testRecipients: ['owner@example.com'] } }));
  const withMail = capture('in');
  const out2 = join(dir, 'out2');
  assert.equal(
    await deployCli([ds, '--project', '1001', '--org', ORG, '--projects', projects, '--mail', '--out', out2], withMail.io),
    0,
    withMail.stderr(),
  );
  assert.match(withMail.stdout(), /^allowlist: owner@example.com$/m);
  assert.deepEqual((JSON.parse(readFileSync(join(out2, 'c2c-mail.json'), 'utf8')) as { allowlist: string[] }).allowlist, [
    'owner@example.com',
  ]);
});
