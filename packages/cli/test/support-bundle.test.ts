import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { argvProblems } from '../src/argv.js';
import { SUPPORT_BUNDLE_SCHEMA, supportBundleCli, type SupportBundle } from '../src/support-bundle.js';
import { c2cVersion } from '../../doctor/src/index.js';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'dist/cli/src/c2c.js');

function captureIo(overrides: { cwd?: string; env?: NodeJS.ProcessEnv; now?: Date } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      ...overrides,
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

test('support-bundle collects allow-listed reports and scrubs planted tokens, env values, row data, and emails', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-support-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspace = join(root, 'workspace');
  const fakeHome = join(root, 'home');
  const appDir = join(workspace, 'c2c-out', 'expenses');
  mkdirSync(join(workspace, 'c2c-out', '.c2c'), { recursive: true });
  mkdirSync(join(appDir, 'provision'), { recursive: true });
  mkdirSync(join(appDir, 'verify'), { recursive: true });
  mkdirSync(join(fakeHome, '.c2c'), { recursive: true });

  const now = new Date('2026-10-16T12:00:00.000Z');
  const recentAt = '2026-10-16T11:30:00.000Z';

  writeFileSync(
    join(workspace, 'c2c-deploy.json'),
    JSON.stringify({ dc: 'in', org: '10000000001', project: '10000000000000001' }, null, 2),
  );

  // Planted secrets in ~/.c2c/<app>-function-env.json and c2c-out/<app>/function-env.json
  const plantedSecrets = {
    fakeOauthToken: '1000.deadbeef1234567890abcdef.9876543210fedcba',
    fakeRefreshToken: '1000.refresh_token_secret_998877665544',
    fakeJwt:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFsaWNlIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    fakeStripeKey: 'c2cfake_live_PLANTED_987654',
    fakeWebhookEnvVal: 'plain-webhook-env-value-without-digits',
    fakeDbPasswordVal: ' hunter2-super-private-passphrase ',
    fakeClientSecret: 'cs_planted_client_secret_12345678',
    fakeEmail1: 'alice.admin@corp.example.com',
    fakeEmail2: 'billing.sender@corp.example.com',
    fakeEmail3: 'vip.customer@client.example.test',
    fakeMaskedEmail: 'al***@corp.example.com',
    fakeCustomerRowName: 'Acme Confidential Deal Row 42',
    fakeCustomerRowNote: 'SSN-999-00-1234-private-customer-record',
  };

  writeFileSync(
    join(fakeHome, '.c2c', 'expenses-function-env.json'),
    JSON.stringify(
      {
        C2C_ZOHO_DC: 'in',
        WEBHOOK_SECRET: plantedSecrets.fakeWebhookEnvVal,
        ZOHO_REFRESH_TOKEN: plantedSecrets.fakeRefreshToken,
        STRIPE_KEY: plantedSecrets.fakeStripeKey,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(appDir, 'function-env.json'),
    JSON.stringify(
      {
        C2C_ZOHO_DC: 'in',
        DB_PASSPHRASE: plantedSecrets.fakeDbPasswordVal.trim(),
      },
      null,
      2,
    ),
  );

  // Planted un-allow-listed files in c2c-out/<app>/ that must NEVER be bundled
  writeFileSync(
    join(appDir, 'provision', 'inputs.json'),
    JSON.stringify(
      {
        slateDomain: 'expenses.onslate.in',
        senderEmail: plantedSecrets.fakeEmail2,
        users: [{ email_id: plantedSecrets.fakeEmail3, role: 'App Administrator' }],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(appDir, 'seed.json'),
    JSON.stringify(
      {
        tables: [
          {
            name: 'Expenses',
            rows: [{ ROWID: '1', Vendor: plantedSecrets.fakeCustomerRowName, Notes: plantedSecrets.fakeCustomerRowNote }],
          },
        ],
      },
      null,
      2,
    ),
  );

  // 1. doctor.json with valid checks + planted secrets in screen, detail, and extra keys
  writeFileSync(
    join(workspace, 'c2c-out', '.c2c', 'doctor.json'),
    JSON.stringify(
      {
        c2c: c2cVersion(),
        at: recentAt,
        host: 'claude-code',
        green: true,
        scope: { dc: 'in', org: '10000000001', project: '10000000000000001', app: 'expenses.ds' },
        checks: [
          { id: 'D-C1', status: 'pass', detail: 'zcatalyst-cli 1.29.2' },
          {
            id: 'D-C3',
            status: 'pass',
            detail: `signed in as ${plantedSecrets.fakeEmail1}`,
            screen: plantedSecrets.fakeMaskedEmail,
          },
          { id: 'D-C5', status: 'pass', detail: 'dc=in' },
          { id: 'D-E1', status: 'pass', detail: 'node 22.14.0' },
          { id: 'D-B1', status: 'pass', detail: 'catalyst-mcp' },
          { id: 'D-B3', status: 'pass', detail: 'authenticated' },
          { id: 'D-B5', status: 'pass', detail: 'all required tools present' },
          { id: 'D-B7', status: 'pass', detail: 'org 10000000001 visible' },
          { id: 'D-V1', status: 'pass', detail: 'dc aligned' },
          { id: 'D-V2', status: 'pass', detail: 'fresh mcp evidence' },
        ],
        mcp: {
          server: 'catalyst-by-zoho',
          shape: 'direct',
          host: 'catalyst-mcp.zoho.in',
          scope: { dc: 'in', org: '10000000001', project: '10000000000000001' },
          at: recentAt,
          source: 'observed',
          tools: ['CatalystbyZoho_List_All_Tables'],
          oauth_token: plantedSecrets.fakeOauthToken,
        },
        refresh_token: plantedSecrets.fakeRefreshToken,
      },
      null,
      2,
    ),
  );

  // 2. c2c-deploy-report.json with valid fields + planted secrets
  writeFileSync(
    join(appDir, 'c2c-deploy-report.json'),
    JSON.stringify(
      {
        project: 'c2c-expenses',
        projectId: '10000000000000001',
        environment: 'Development',
        dc: 'in',
        ui: 'react',
        dcSource: 'c2c-deploy.json',
        exitCode: 1,
        tableError: `HTTP 401 Zoho-oauthtoken ${plantedSecrets.fakeOauthToken} for ${plantedSecrets.fakeEmail1}`,
        tableDiff: {
          createdTables: ['Expenses'],
          existingTables: ['Categories'],
          createdColumns: { Expenses: ['Amount', 'Category_ID'] },
          existingColumns: {},
          shadowsOnExistingRows: [],
        },
        commands: [
          ['catalyst', '--org', '10000000001', '--project', '10000000000000001', 'deploy', '--only', 'functions:c2c_api'],
          ['c2c', 'deploy', '--admin-email', plantedSecrets.fakeEmail1, '--auth-token', plantedSecrets.fakeOauthToken],
        ],
        skipped: ['slate-link'],
        auth: [{ id: 'admin-invite', status: 'failed', code: 'INVALID_INPUT', message: `invite failed for ${plantedSecrets.fakeEmail1}` }],
        postDeploySteps: [
          {
            kind: 'configure',
            projectId: '10000000000000001',
            services: ['Web Client Hosting (Slate)'],
            text: 'Open Slate in the console once.',
          },
        ],
        humanChecklist: [
          `Verify mail sender ${plantedSecrets.fakeEmail2} in Catalyst Mail`,
        ],
        slate: {
          appUrl: 'https://expenses-10000000001.onslate.in?access_token=secret123456',
          notice: 'Slate deployment succeeded',
        },
        env: {
          WEBHOOK_SECRET: plantedSecrets.fakeWebhookEnvVal,
          STRIPE_KEY: plantedSecrets.fakeStripeKey,
        },
        credentials: {
          client_secret: plantedSecrets.fakeClientSecret,
        },
        rows: [{ Name: plantedSecrets.fakeCustomerRowName, Notes: plantedSecrets.fakeCustomerRowNote }],
      },
      null,
      2,
    ),
  );

  // 3. plan.json
  writeFileSync(
    join(appDir, 'plan.json'),
    JSON.stringify(
      {
        version: 1,
        command: 'plan',
        c2c: c2cVersion(),
        app: 'expenses',
        dc: 'in',
        dcSource: 'c2c-deploy.json',
        doctor: 'not-run',
        counts: {
          tables: 2,
          dataStoreTables: 2,
          columns: 8,
          nosqlTables: 0,
          functions: 1,
          schedules: 0,
          reports: 2,
          pages: 1,
          roles: 2,
          customApis: 0,
        },
        budgets: [{ id: 'columns', status: 'pass', detail: '8/75 columns' }],
        budgetsOk: true,
        connectionSecretKeys: ['WEBHOOK_SECRET'],
        plantedSecretField: plantedSecrets.fakeClientSecret,
      },
      null,
      2,
    ),
  );

  // 4. provision/plan.json and provision/state.json
  writeFileSync(
    join(appDir, 'provision', 'plan.json'),
    JSON.stringify(
      {
        version: 1,
        app: 'expenses',
        dc: 'in',
        connectionSecretKeys: ['WEBHOOK_SECRET'],
        steps: [
          {
            id: 'tables',
            via: 'cli',
            command: 'tables',
            args: { secretToken: plantedSecrets.fakeJwt, adminEmail: plantedSecrets.fakeEmail1 },
            readBack: { via: 'mcp', tool: 'CatalystbyZoho_List_All_Tables', match: { customerRow: plantedSecrets.fakeCustomerRowName } },
          },
        ],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(appDir, 'provision', 'state.json'),
    JSON.stringify(
      {
        version: 1,
        app: 'expenses',
        planSha256: 'abc123def456',
        learned: {
          projectId: '10000000000000001',
          byName: { Expenses: '400000000101' },
        },
        steps: {
          tables: {
            status: 'done',
            at: recentAt,
            applied: true,
            result: 'provision/results/tables.json',
          },
        },
        oauth_token: plantedSecrets.fakeOauthToken,
      },
      null,
      2,
    ),
  );

  // 5. verify/report.json with parity + behavior findings + planted customer row values
  writeFileSync(
    join(appDir, 'verify', 'report.json'),
    JSON.stringify(
      {
        version: 'c2c-behavior-report/1',
        app: 'expenses',
        mode: 'offline',
        ok: false,
        reasons: ['Expenses: 1 changed record'],
        behaviorEquivalentApps: 0,
        summary: { cases: 2, steps: 5, findings: 1 },
        tables: [
          {
            table: 'Expenses',
            sourceCount: 10,
            storedCount: 10,
            missingIds: [],
            extraIds: [],
            changedIds: ['src_42'],
            duplicateIds: [],
            unattributed: 0,
            reasons: ['1 changed record'],
            sourceChecksum: '1111aaaa',
            storedChecksum: '2222bbbb',
            mismatch: true,
            rows: [{ Vendor: plantedSecrets.fakeCustomerRowName, Notes: plantedSecrets.fakeCustomerRowNote }],
          },
        ],
        findings: [
          {
            case: 'submit-expense',
            step: 2,
            pointer: 'tables.Expenses[0].Vendor',
            expected: plantedSecrets.fakeCustomerRowName,
            actual: plantedSecrets.fakeEmail3,
          },
        ],
      },
      null,
      2,
    ),
  );

  // 6. c2c-proof.json
  writeFileSync(
    join(appDir, 'c2c-proof.json'),
    JSON.stringify(
      {
        schema: 'c2c-proof/1',
        app: 'expenses',
        checksum: 'sha256 of sorted record fingerprints',
        source: 'json',
        tables: [
          {
            table: 'Expenses',
            form: 'Expenses_Form',
            sourceRows: 10,
            sourceChecksum: '1111aaaa',
            checkpointRows: 10,
            checkpointChecksum: '1111aaaa',
            match: true,
          },
        ],
        smoke: { status: 'pass', session: 'owner' },
        readiness: { automatic: 96, band: 'high', manual: ['owner sign-off'] },
        customerRows: [{ Name: plantedSecrets.fakeCustomerRowName, Email: plantedSecrets.fakeEmail3 }],
      },
      null,
      2,
    ),
  );

  // 7. Failing command stderr transcript with planted tokens, env values, and emails
  const stderrPath = join(root, 'deploy-stderr.log');
  writeFileSync(
    stderrPath,
    [
      'c2c deploy: step functions-api failed with HTTP 400 INVALID_INPUT',
      `Authorization: Bearer ${plantedSecrets.fakeJwt}`,
      `Zoho-oauthtoken ${plantedSecrets.fakeOauthToken}`,
      `refresh_token=${plantedSecrets.fakeRefreshToken}`,
      `export WEBHOOK_SECRET=${plantedSecrets.fakeWebhookEnvVal}`,
      `leaked env literal: ${plantedSecrets.fakeWebhookEnvVal} and ${plantedSecrets.fakeDbPasswordVal.trim()}`,
      `stripe key ${plantedSecrets.fakeStripeKey} for user ${plantedSecrets.fakeEmail1} and ${plantedSecrets.fakeEmail3}`,
    ].join('\n') + '\n',
  );

  mkdirSync(join(root, 'bundle'));
  const outPath = join(root, 'bundle', 'support-bundle.json');
  const cap = captureIo({
    cwd: workspace,
    env: { ...process.env, C2C_WORKSPACE: workspace, HOME: fakeHome },
    now,
  });

  const code = supportBundleCli(['--out', outPath, '--app', 'expenses', '--stderr-file', stderrPath], cap.io);
  assert.equal(code, 0, cap.stderr);
  assert.equal(cap.stderr, '');

  const rawBundle = readFileSync(outPath, 'utf8');
  const combinedOutput = `${rawBundle}\n${cap.stdout}\n${cap.stderr}`;

  // Security assertion: NONE of the planted secrets may appear anywhere in the bundle or stdout/stderr.
  for (const [label, secret] of Object.entries(plantedSecrets)) {
    assert.equal(
      combinedOutput.includes(secret.trim()),
      false,
      `planted secret ${label} (${secret.trim()}) leaked into support bundle`,
    );
  }

  const bundle = JSON.parse(rawBundle) as SupportBundle;
  assert.equal(bundle.schema, SUPPORT_BUNDLE_SCHEMA);
  assert.equal(bundle.versions.c2c, c2cVersion());
  assert.equal(typeof bundle.versions.plugin, 'string');
  assert.ok(bundle.versions.plugin.length > 0);
  assert.equal(bundle.versions.node, process.versions.node);

  // Doctor report is present and green
  assert.equal(bundle.doctor.ok, true);
  assert.equal(bundle.doctor.status, 'green');
  assert.equal(bundle.doctor.refusal, undefined);
  assert.ok(bundle.doctor.report);
  const dChecks = bundle.doctor.report.checks as Record<string, unknown>[];
  const dC3 = dChecks.find((c) => c.id === 'D-C3');
  assert.ok(dC3);
  assert.equal('screen' in dC3, false, 'doctor check screen field must be excluded by allow-list');
  assert.equal('oauth_token' in (bundle.doctor.report.mcp as Record<string, unknown>), false);
  assert.equal('refresh_token' in bundle.doctor.report, false);

  // Expected reports under c2c-out/expenses/ are present
  const appReports = bundle.apps.expenses;
  assert.ok(appReports, 'expenses app reports included');
  assert.ok(appReports['c2c-deploy-report.json']);
  assert.ok(appReports['plan.json']);
  assert.ok(appReports['provision/plan.json']);
  assert.ok(appReports['provision/state.json']);
  assert.ok(appReports['verify/report.json']);
  assert.ok(appReports['c2c-proof.json']);

  const deployReport = appReports['c2c-deploy-report.json'] as Record<string, unknown>;
  assert.equal(deployReport.project, 'c2c-expenses');
  assert.equal(deployReport.exitCode, 1);
  assert.equal('env' in deployReport, false);
  assert.equal('credentials' in deployReport, false);
  assert.equal('rows' in deployReport, false);

  const verifyReport = appReports['verify/report.json'] as Record<string, unknown>;
  assert.equal(verifyReport.ok, false);
  const findings = verifyReport.findings as Record<string, unknown>[];
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pointer, 'tables.Expenses[0].Vendor');
  assert.equal('expected' in (findings[0] ?? {}), false);
  assert.equal('actual' in (findings[0] ?? {}), false);

  // Stderr error line is preserved while secrets are redacted
  assert.ok(bundle.stderr);
  assert.match(bundle.stderr.lines[0] ?? '', /c2c deploy: step functions-api failed with HTTP 400 INVALID_INPUT/);

  // Manifest lists every included item and matches stdout
  const expectedManifest = [
    'versions',
    'c2c-out/.c2c/doctor.json',
    'c2c-out/expenses/c2c-deploy-report.json',
    'c2c-out/expenses/plan.json',
    'c2c-out/expenses/provision/plan.json',
    'c2c-out/expenses/provision/state.json',
    'c2c-out/expenses/verify/report.json',
    'c2c-out/expenses/c2c-proof.json',
    'stderr',
  ];
  assert.deepEqual(bundle.manifest, expectedManifest);
  for (const item of expectedManifest) {
    assert.match(cap.stdout, new RegExp(`^- ${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }

  // Deterministic regeneration: a second run produces byte-identical output
  const outPath2 = join(root, 'bundle', 'support-bundle-2.json');
  const cap2 = captureIo({
    cwd: workspace,
    env: { ...process.env, C2C_WORKSPACE: workspace, HOME: fakeHome },
    now,
  });
  assert.equal(supportBundleCli(['--out', outPath2, '--app', 'expenses', '--stderr-file', stderrPath], cap2.io), 0);
  assert.equal(readFileSync(outPath2, 'utf8'), rawBundle);
});

test('support-bundle records doctor refusal when doctor.json is missing or stale', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-support-bundle-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 1. Missing doctor.json -> status: not-run + refusal message
  const outMissing = join(root, 'missing-doctor.json');
  const cap1 = captureIo({ cwd: root, env: { ...process.env, C2C_WORKSPACE: root } });
  assert.equal(supportBundleCli(['--out', outMissing], cap1.io), 0);
  const b1 = JSON.parse(readFileSync(outMissing, 'utf8')) as SupportBundle;
  assert.equal(b1.doctor.ok, false);
  assert.equal(b1.doctor.status, 'not-run');
  assert.match(b1.doctor.refusal ?? '', /c2c: doctor is not green/);
  assert.deepEqual(b1.manifest, ['versions', 'doctor']);

  // 2. Stale doctor.json (> 12h old) -> status: stale + refusal message + redacted report
  mkdirSync(join(root, 'c2c-out', '.c2c'), { recursive: true });
  writeFileSync(
    join(root, 'c2c-out', '.c2c', 'doctor.json'),
    JSON.stringify(
      {
        c2c: c2cVersion(),
        at: '2026-10-15T00:00:00.000Z',
        host: 'claude-code',
        green: true,
        scope: { dc: 'in', org: '10000000001', project: '10000000000000001' },
        checks: [{ id: 'D-C1', status: 'pass', detail: 'ok' }],
      },
      null,
      2,
    ),
  );
  const outStale = join(root, 'stale-doctor.json');
  const cap2 = captureIo({
    cwd: root,
    env: { ...process.env, C2C_WORKSPACE: root },
    now: new Date('2026-10-16T12:00:00.000Z'),
  });
  assert.equal(supportBundleCli(['--out', outStale], cap2.io), 0);
  const b2 = JSON.parse(readFileSync(outStale, 'utf8')) as SupportBundle;
  assert.equal(b2.doctor.ok, false);
  assert.equal(b2.doctor.status, 'stale');
  assert.match(b2.doctor.refusal ?? '', /stale/);
  assert.ok(b2.doctor.report);
  assert.deepEqual(b2.manifest, ['versions', 'c2c-out/.c2c/doctor.json']);
});

test('support-bundle validates arguments, refuses path traversal or symlinks, and works via c2c CLI', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-support-bundle-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(argvProblems('support-bundle', []), ['c2c support-bundle: --out <file> is required']);
  assert.deepEqual(argvProblems('support-bundle', ['--out', 'bundle.json', '--app', '../escape']), [
    'c2c support-bundle: --app must be an application directory name under c2c-out',
  ]);
  assert.deepEqual(argvProblems('support-bundle', ['--out', 'bundle.json', '--app', 'expenses', '--stderr-file', 'err.log']), []);

  // Missing --stderr-file exits 2 without stack trace
  const capMissing = captureIo({ cwd: root });
  assert.equal(
    supportBundleCli(['--out', join(root, 'out.json'), '--stderr-file', join(root, 'no-such.log')], capMissing.io),
    2,
  );
  assert.match(capMissing.stderr, /^c2c support-bundle: no such stderr file:/);

  // Symlinked --stderr-file is refused
  const realSecret = join(root, 'secret.txt');
  const linkSecret = join(root, 'link.txt');
  writeFileSync(realSecret, 'TOP_SECRET=123456\n');
  symlinkSync(realSecret, linkSecret);
  const capLink = captureIo({ cwd: root });
  assert.equal(
    supportBundleCli(['--out', join(root, 'out.json'), '--stderr-file', linkSecret], capLink.io),
    2,
  );
  assert.match(capLink.stderr, /--stderr-file must be a regular file/);

  // End-to-end spawn via dist/cli/src/c2c.js
  const e2eOut = join(root, 'e2e-bundle.json');
  const res = spawnSync(process.execPath, [cli, 'support-bundle', '--out', e2eOut], {
    cwd: root,
    env: { ...process.env, C2C_WORKSPACE: root },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /manifest:/);
  const parsed = JSON.parse(readFileSync(e2eOut, 'utf8')) as SupportBundle;
  assert.equal(parsed.schema, SUPPORT_BUNDLE_SCHEMA);
});

test('support-bundle caps --stderr-file reads at MAX_STDERR_BYTES and marks truncation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-support-bundle-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // A 10 MB stderr file must never be held in memory or bundled whole.
  const bigLog = join(root, 'big-stderr.log');
  const tail = 'MARKER-LINE-NEAR-END\n';
  writeFileSync(bigLog, 'x'.repeat(10 * 1024 * 1024) + tail);
  const outPath = join(root, 'bundle.json');
  const cap = captureIo({ cwd: root, env: { ...process.env, C2C_WORKSPACE: root } });
  assert.equal(supportBundleCli(['--out', outPath, '--stderr-file', bigLog], cap.io), 0, cap.stderr);
  const bundle = JSON.parse(readFileSync(outPath, 'utf8')) as SupportBundle;
  assert.ok(bundle.stderr);
  assert.equal(bundle.stderr.truncated, true);
  const joined = bundle.stderr.lines.join('\n');
  assert.equal(joined.includes(tail.trim()), false, 'bytes past the cap must not reach the bundle');
  assert.ok(joined.length <= 256 * 1024);

  // A small file is not marked truncated.
  const smallLog = join(root, 'small.log');
  writeFileSync(smallLog, 'one\n two\n');
  const outPath2 = join(root, 'bundle2.json');
  const cap2 = captureIo({ cwd: root, env: { ...process.env, C2C_WORKSPACE: root } });
  assert.equal(supportBundleCli(['--out', outPath2, '--stderr-file', smallLog], cap2.io), 0, cap2.stderr);
  const bundle2 = JSON.parse(readFileSync(outPath2, 'utf8')) as SupportBundle;
  assert.equal(bundle2.stderr?.truncated, undefined);
  assert.deepEqual(bundle2.stderr?.lines, ['one', ' two']);
});

test('support-bundle refuses an existing --out unless --force and refuses missing or symlinked parents', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-support-bundle-out-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, C2C_WORKSPACE: root };

  // Existing --out is refused without --force.
  const existing = join(root, 'exists.json');
  writeFileSync(existing, '{"prior":true}\n');
  const cap1 = captureIo({ cwd: root, env });
  assert.equal(supportBundleCli(['--out', existing], cap1.io), 2);
  assert.match(cap1.stderr, /refusing to overwrite existing file/);
  assert.equal(readFileSync(existing, 'utf8'), '{"prior":true}\n', 'existing file must not be clobbered');

  // --force overwrites the same file.
  const cap2 = captureIo({ cwd: root, env });
  assert.equal(supportBundleCli(['--out', existing, '--force'], cap2.io), 0, cap2.stderr);
  assert.match(readFileSync(existing, 'utf8'), /"schema": "c2c-support-bundle\/1"/);

  // A missing parent directory is refused (no directory creation).
  const missing = join(root, 'no-such-dir', 'bundle.json');
  const cap3 = captureIo({ cwd: root, env });
  assert.equal(supportBundleCli(['--out', missing], cap3.io), 2);
  assert.match(cap3.stderr, /parent directory does not exist/);

  // A symlinked parent directory is refused.
  const realDir = join(root, 'real-dir');
  const linkDir = join(root, 'link-dir');
  mkdirSync(realDir);
  symlinkSync(realDir, linkDir);
  const cap4 = captureIo({ cwd: root, env });
  assert.equal(supportBundleCli(['--out', join(linkDir, 'bundle.json')], cap4.io), 2);
  assert.match(cap4.stderr, /symlinked directory/);

  // A symlinked grandparent component is refused.
  const nested = join(realDir, 'nested');
  mkdirSync(nested);
  const cap5 = captureIo({ cwd: root, env });
  assert.equal(supportBundleCli(['--out', join(linkDir, 'nested', 'bundle.json')], cap5.io), 2);
  assert.match(cap5.stderr, /symlinked directory/);

  // An existing --out symlink is refused.
  const realOut = join(root, 'real-out.json');
  const linkOut = join(root, 'link-out.json');
  writeFileSync(realOut, '{}\n');
  symlinkSync(realOut, linkOut);
  const cap6 = captureIo({ cwd: root, env });
  assert.equal(supportBundleCli(['--out', linkOut], cap6.io), 2);
  assert.match(cap6.stderr, /refusing to write through symlink/);
});

test('support-bundle scrubs split-line, base64, query-string, header, rc-style, and env-var secrets', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-support-bundle-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const workspace = join(root, 'workspace');
  const appDir = join(workspace, 'c2c-out', 'expenses');
  mkdirSync(appDir, { recursive: true });

  const fakeOauthToken = '1000.aaaabbbbccccddddeeeeffff00001111.2222333344445555';
  const fakeEnvValue = 'fake-env-var-value-qwerty-987';
  const fakeBase64 = Buffer.from(fakeOauthToken, 'utf8').toString('base64');
  const splitAt = Math.floor(fakeOauthToken.length / 2);
  const splitTokenLines = `${fakeOauthToken.slice(0, splitAt)}\n${fakeOauthToken.slice(splitAt)}`;

  // The token's only home is this function-env file; every other appearance must be scrubbed.
  writeFileSync(
    join(appDir, 'function-env.json'),
    JSON.stringify({ ZOHO_OAUTH_TOKEN: fakeOauthToken }, null, 2),
  );

  // A report field carrying a URL with query-string tokens.
  writeFileSync(
    join(appDir, 'plan.json'),
    JSON.stringify(
      {
        version: 1,
        command: 'plan',
        app: 'expenses',
        dcSource: `https://console.example.test/callback?access_token=${fakeOauthToken}&refresh_token=${fakeOauthToken}`,
      },
      null,
      2,
    ),
  );

  // stderr: split-line token, base64 token, query-string tokens, Bearer header, rc-style credential.
  const stderrPath = join(root, 'err.log');
  writeFileSync(
    stderrPath,
    [
      `deploy failed; token dump follows`,
      splitTokenLines,
      `encoded: ${fakeBase64}`,
      `url was https://api.example.test/x?access_token=${fakeOauthToken} done`,
      `retry with &refresh_token=${fakeOauthToken} appended`,
      `Authorization: Bearer ${fakeOauthToken}`,
      `authtoken=${fakeOauthToken}`,
      `env value leaked: ${fakeEnvValue}`,
    ].join('\n') + '\n',
  );

  const outPath = join(root, 'bundle.json');
  const cap = captureIo({
    cwd: workspace,
    env: { ...process.env, C2C_WORKSPACE: workspace, HOME: join(root, 'home'), FAKE_DEPLOY_SECRET: fakeEnvValue },
  });
  assert.equal(supportBundleCli(['--out', outPath, '--app', 'expenses', '--stderr-file', stderrPath], cap.io), 0, cap.stderr);

  const combined = `${readFileSync(outPath, 'utf8')}\n${cap.stdout}\n${cap.stderr}`;
  for (const [label, fragment] of Object.entries({
    token: fakeOauthToken,
    tokenHalf1: fakeOauthToken.slice(0, splitAt),
    tokenHalf2: fakeOauthToken.slice(splitAt),
    base64: fakeBase64,
    envValue: fakeEnvValue,
  })) {
    assert.equal(combined.includes(fragment), false, `${label} leaked into the bundle output`);
  }

  const bundle = JSON.parse(readFileSync(outPath, 'utf8')) as SupportBundle;
  const plan = bundle.apps.expenses?.['plan.json'] as Record<string, unknown>;
  assert.ok(plan);
  assert.equal((plan.dcSource as string).includes(fakeOauthToken), false);
});
