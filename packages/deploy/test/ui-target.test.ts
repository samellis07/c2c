import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleDigest } from '../src/cli.js';
import { buildDeploy, deployFiles } from '../src/plan.js';
import { checkGuards, deployCli, type Io, type ProjectRegistry, type RestFn, type SpawnResult } from '../src/index.js';
import { findDeployConfig, readDeployConfig } from '../src/dc.js';
import { deriveIr, parse } from '../../core/src/index.js';
import type { FetchLike, MigrateResponse } from '../../data/src/migrate.js';

const SECRET = '/tmp/cred-DO-NOT-PRINT';
const CLI_TOKEN = 'test-cli-token';

const DS = `application "Widget"
{
	time zone = "Asia/Kolkata"
	section S
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
			displayName = "Open"
			show all rows from Item
		}
	}
}
`;

const registry: ProjectRegistry = {
  org: '10000000000',
  dc: 'in',
  env: 'Development',
  projects: { 'c2c-widget': '1001' },
};

function projectDetails() {
  return {
    status: 'success',
    data: {
      id: '1001',
      project_name: 'c2c-widget',
      project_type: 'Live',
      timezone: 'Asia/Kolkata',
      project_domain_details: { project_domain_id: '10', project_domain_name: 'c2c-widget' },
      env_details: [{ env_name: 'Development', env_type: 1, env_zgid: '10000000000', id: '10000000000', is_default: true, project_details: { id: '1001', project_name: 'c2c-widget' } }],
    },
  };
}

function writeDs(dir = mkdtempSync(join(tmpdir(), 'c2c-ui-ds-')), ds = DS): string {
  const path = join(dir, 'widget.ds');
  writeFileSync(path, ds);
  return path;
}

function projectsFile(reg: ProjectRegistry = registry): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ui-projects-'));
  const path = join(dir, 'projects.json');
  writeFileSync(path, JSON.stringify(reg));
  return path;
}

function baseArgs(ds: string, extra: string[] = []): string[] {
  return [ds, '--project', '1001', '--org', '10000000000', '--projects', projectsFile(), ...extra];
}

const FAITHFUL_PROJECT_LIST = `
┌─────────────────────┬────────────┐
│    Project Name     │ Project ID │
├─────────────────────┼────────────┤
│ c2c-widget (active) │ 1001       │
└─────────────────────┴────────────┘`;

function capture(env: NodeJS.ProcessEnv = { X_ZC_CREDENTIAL_PATH: SECRET }): {
  io: Io;
  stdout: () => string;
  stderr: () => string;
  spawned: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[];
  restCalls: { method: string; path: string; body?: unknown }[];
} {
  let out = '';
  let err = '';
  const spawned: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const restCalls: { method: string; path: string; body?: unknown }[] = [];
  const rest: RestFn = async (call) => {
    restCalls.push({ method: call.method, path: call.path, body: call.body });
    if (call.method === 'GET' && /^\/baas\/v1\/project\/[0-9]+$/.test(call.path)) return { status: 200, body: projectDetails() };
    if (call.method === 'GET' && call.path.endsWith('/table')) return { status: 200, body: { data: [] } };
    if (call.method === 'POST' && call.path.endsWith('/table')) return { status: 200, body: { data: { table_id: `t${restCalls.length}` } } };
    if (call.method === 'GET' && /\/table\/[^/]+$/.test(call.path)) return { status: 200, body: { data: { column_details: [] } } };
    if (call.method === 'POST' && call.path.includes('/column')) return { status: 200, body: { status: 'success' } };
    if (call.method === 'GET' && call.path.endsWith('/project-user')) return { status: 200, body: { data: [] } };
    if (call.method === 'POST' && call.path.endsWith('/cors-domain')) return { status: 200, body: { data: { id: '1', cors: true, iframe: true } } };
    if (call.method === 'POST' && call.path.includes('/authentication/')) return { status: 200, body: { data: {} } };
    // Opened services answer their first-use gate probes (Slate app list, Stratus bucket list).
    if (call.method === 'GET' && /^\/(slate|baas)\/v1\/project\/[0-9]+\/(app|bucket)$/.test(call.path)) return { status: 200, body: { status: 'success', data: [] } };
    return { status: 404, body: {} };
  };
  const fetch: FetchLike = async (): Promise<MigrateResponse> => ({ status: 404, headers: { get: () => null }, text: async () => '{}' });
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    cliDc: () => undefined,
    spawn: async (command, args, opts) => {
      spawned.push({ command, args, cwd: opts.cwd, env: opts.env });
      if (args.includes('project:list')) return { code: 0, stdout: FAITHFUL_PROJECT_LIST, stderr: '' };
      if (args.includes('--only')) {
        return { code: 0, stdout: 'Deployed functions:c2c_api https://c2c-widget-1001.development.catalystserverless.in/server/c2c_api', stderr: '' };
      }
      // A stand-in for `npm run build` in web/: the build writes dist/ plus the
      // files the deploy itself cannot supply.
      if (command === 'npm' && args[0] === 'run' && args[1] === 'build') {
        mkdirSync(join(opts.cwd, 'dist'), { recursive: true });
        writeFileSync(join(opts.cwd, 'dist', 'index.html'), '<!doctype html>\n');
      }
      return { code: 0, stdout: '', stderr: '' } satisfies SpawnResult;
    },
    fetch,
    rest,
    accessToken: async () => CLI_TOKEN,
  };
  return { io, stdout: () => out, stderr: () => err, spawned, restCalls };
}

test('--ui react writes web/ instead of slate/ and builds it before the Slate steps', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-out-'));
  try {
    const cap = capture({ X_ZC_CREDENTIAL_PATH: '' });
    const code = await deployCli([...baseArgs(ds), '--out', out, '--ui', 'react'], cap.io);
    assert.equal(code, 0, cap.stderr());
    const plan = cap.stdout();
    assert.match(plan, /ui: react/);
    assert.match(plan, /npm ci --prefer-offline \(in web\)/);
    assert.match(plan, /npm run build \(in web\)/);
    assert.match(plan, /slate:link --name c2c-widget --framework static --source \.\/web\/dist -ni/);
    assert.match(plan, /- web\/src\/generated\/model\.ts/);
    assert.match(plan, /- web\/public\/c2c-config\.js/);
    assert.doesNotMatch(plan, /slate\/index\.html/);
    // The deploy dir holds the React source, nothing of the vanilla client.
    assert.ok(existsSync(join(out, 'web', 'package.json')));
    assert.ok(existsSync(join(out, 'web', 'package-lock.json')), 'lockfile present in generated web/');
    assert.ok(existsSync(join(out, 'web', 'src', 'generated', 'model.ts')));
    assert.ok(existsSync(join(out, 'web', 'lib', 'c2c-ui', 'boot.tsx')));
    const config = readFileSync(join(out, 'web', 'public', 'c2c-config.js'), 'utf8');
    assert.match(config, /C2C_API_BASE/);
    assert.match(config, /C2C_SMOKE_PLAN/);
    assert.match(config, /C2C_SMOKE_PROJECT = "1001"/);
    assert.match(config, /C2C_APP_TIMEZONE = "Asia\/Kolkata"/);
    assert.ok(!existsSync(join(out, 'slate')));
    assert.equal(cap.spawned.length, 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the react target is the default without --ui or config ui', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-out-'));
  try {
    const cap = capture({ X_ZC_CREDENTIAL_PATH: '' });
    const code = await deployCli([...baseArgs(ds), '--out', out], cap.io);
    assert.equal(code, 0, cap.stderr());
    assert.match(cap.stdout(), /ui: react/);
    assert.ok(existsSync(join(out, 'web', 'package.json')));
    assert.ok(!existsSync(join(out, 'slate')));
    assert.match(cap.stdout(), /--source \.\/web\/dist/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('--ui vanilla and config ui=vanilla still select the vanilla fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ui-ds-'));
  const ds = writeDs(dir);
  writeFileSync(join(dir, 'c2c-deploy.json'), `${JSON.stringify({ dc: 'in', org: '10000000000', project: '1001', ui: 'vanilla' })}\n`);
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-out-'));
  try {
    const cap = capture({ X_ZC_CREDENTIAL_PATH: '' });
    const code = await deployCli([ds, '--project', '1001', '--org', '10000000000', '--out', out], cap.io);
    assert.equal(code, 0, cap.stderr());
    assert.match(cap.stdout(), /ui: vanilla/);
    assert.ok(existsSync(join(out, 'slate', 'index.html')));
    assert.ok(!existsSync(join(out, 'web')));

    const out2 = mkdtempSync(join(tmpdir(), 'c2c-ui-out-'));
    try {
      const cap2 = capture({ X_ZC_CREDENTIAL_PATH: '' });
      const code2 = await deployCli([ds, '--project', '1001', '--org', '10000000000', '--out', out2, '--ui', 'vanilla'], cap2.io);
      assert.equal(code2, 0, cap2.stderr());
      assert.match(cap2.stdout(), /ui: vanilla/);
      assert.ok(existsSync(join(out2, 'slate', 'index.html')));
      assert.ok(!existsSync(join(out2, 'web')));
    } finally {
      rmSync(out2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('--ui react --confirm installs, builds, rewrites the config and deploys web/dist', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-out-'));
  try {
    const cap = capture();
    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--ui', 'react', '--out', out], cap.io);
    assert.equal(code, 0, `stdout:\n${cap.stdout()}\nstderr:\n${cap.stderr()}`);
    const names = cap.spawned.map((call) => `${call.command} ${call.args.join(' ')}`);
    const functions = names.findIndex((n) => n.includes('deploy --only functions:c2c_api'));
    const deps = cap.spawned.findIndex((call) => call.command === 'npm' && call.args[0] === 'ci');
    const build = cap.spawned.findIndex((call) => call.command === 'npm' && call.args[0] === 'run' && call.args[1] === 'build');
    const link = names.findIndex((n) => n.includes('slate:link'));
    const deploy = names.findIndex((n) => n.includes('deploy slate'));
    assert.ok(functions >= 0 && deps > functions && build > deps && link > build && deploy > link, names.join('\n'));
    assert.deepEqual(cap.spawned[deps]!.args, ['ci', '--prefer-offline']);
    // The web steps run inside web/, the catalyst steps inside the deploy dir.
    assert.equal(cap.spawned[deps]!.cwd, join(out, 'web'));
    assert.equal(cap.spawned[build]!.cwd, join(out, 'web'));
    assert.equal(cap.spawned[link]!.cwd, out);
    const linkArgs = cap.spawned[link]!.args.join(' ');
    assert.match(linkArgs, /--source \.\/web\/dist/);
    assert.match(linkArgs, /--framework static/);
    // The learned function base lands in the source config the build reads and
    // in the built dist/ the deploy uploads (rewritten after the clean build).
    const apiBase = 'https://c2c-widget-1001.development.catalystserverless.in/server/c2c_api';
    assert.match(readFileSync(join(out, 'web', 'public', 'c2c-config.js'), 'utf8'), new RegExp(`C2C_API_BASE = ${JSON.stringify(apiBase)}`));
    assert.match(readFileSync(join(out, 'web', 'dist', 'c2c-config.js'), 'utf8'), new RegExp(`C2C_API_BASE = ${JSON.stringify(apiBase)}`));
    const toml = readFileSync(join(out, 'web', 'dist', '.catalyst', 'slate-config.toml'), 'utf8');
    assert.match(toml, /framework = "static"/);
    assert.match(toml, /deployment_name = "default"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('build failure -> deploy stops before Slate with the tail', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-out-'));
  try {
    const cap = capture();
    const errorLines = Array.from({ length: 25 }, (_, i) => `TS2304: Cannot find name 'ErrorLine${i + 1}'`);
    const origSpawn = cap.io.spawn;
    cap.io.spawn = async (command, args, opts) => {
      if (command === 'npm' && args[0] === 'run' && args[1] === 'build') {
        return { code: 1, stdout: '', stderr: errorLines.join('\n') };
      }
      return origSpawn(command, args, opts);
    };

    const code = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--ui', 'react', '--out', out], cap.io);
    assert.notEqual(code, 0, 'deploy exits non-zero on build failure');

    const spawnedArgvs = cap.spawned.map((c) => c.args.join(' '));
    assert.ok(!spawnedArgvs.some((a) => a.includes('slate:link')), 'slate:link must not be run before a successful build');
    assert.ok(!spawnedArgvs.some((a) => a.includes('deploy slate')), 'deploy slate must not be run before a successful build');

    const err = cap.stderr();
    assert.match(err, /npm run build \(in web\)/, 'surfaces failing command');
    assert.match(err, /ErrorLine25/, 'surfaces the tail of the error');
    assert.doesNotMatch(err, /ErrorLine1\b/, 'does not include lines before the last 20');
    assert.match(err, /next step:/i, 'surfaces the next step');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('re-run safe: skips web/ build when web/dist matches the inputs', async () => {
  const ds = writeDs();
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-out-'));
  try {
    const cap1 = capture();
    const code1 = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--ui', 'react', '--out', out], cap1.io);
    assert.equal(code1, 0, cap1.stderr());
    const buildCount1 = cap1.spawned.filter((c) => c.command === 'npm' && c.args[0] === 'run' && c.args[1] === 'build').length;
    assert.equal(buildCount1, 1, 'first run builds');

    const cap2 = capture();
    const code2 = await deployCli([...baseArgs(ds), '--confirm', '--function-env', 'new', '--ui', 'react', '--out', out], cap2.io);
    assert.equal(code2, 0, cap2.stderr());
    const buildCount2 = cap2.spawned.filter((c) => c.command === 'npm' && c.args[0] === 'run' && c.args[1] === 'build').length;
    assert.equal(buildCount2, 0, 'second run skips build when web/dist matches inputs');
    assert.match(cap2.stdout(), /skip npm run build \(in web\) \(web\/dist matches the inputs\)/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('"ui" in c2c-deploy.json selects the React target and a wrong value is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-ui-ds-'));
  const ds = writeDs(dir);
  writeFileSync(join(dir, 'c2c-deploy.json'), `${JSON.stringify({ dc: 'in', org: '10000000000', project: '1001', ui: 'react' })}\n`);
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-out-'));
  try {
    const cap = capture({ X_ZC_CREDENTIAL_PATH: '' });
    const code = await deployCli([ds, '--project', '1001', '--org', '10000000000', '--out', out], cap.io);
    assert.equal(code, 0, cap.stderr());
    assert.match(cap.stdout(), /ui: react/);
    assert.ok(existsSync(join(out, 'web', 'package.json')));

    writeFileSync(join(dir, 'c2c-deploy.json'), `${JSON.stringify({ dc: 'in', ui: 'preact' })}\n`);
    assert.throws(() => readDeployConfig(findDeployConfig(ds, undefined)!), /"ui" must be "vanilla" or "react"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('--ui refuses an unknown target', async () => {
  const ds = writeDs();
  const cap = capture({ X_ZC_CREDENTIAL_PATH: '' });
  const code = await deployCli([...baseArgs(ds), '--ui', 'ember'], cap.io);
  assert.equal(code, 1);
  assert.match(cap.stderr(), /--ui must be vanilla or react/);
});

test('the bundle digest ignores the rewritten client config for both targets', () => {
  const app = deriveIr(parse(DS));
  const guard = checkGuards({ org: '10000000000', projectId: '1001', appLink: 'Widget', credentialPath: SECRET, registry });
  for (const ui of ['vanilla', 'react'] as const) {
    const a = deployFiles(app, guard, false, { ui, apiBase: 'https://a.invalid/server/c2c_api' });
    const b = deployFiles(app, guard, false, { ui, apiBase: 'https://b.invalid/server/c2c_api' });
    assert.equal(bundleDigest(a.files), bundleDigest(b.files), ui);
  }
  const react = buildDeploy(app, guard, false, false, undefined, undefined, {}, undefined, undefined, undefined, 'react');
  assert.ok(react.files.some((f) => f.path === 'web/public/c2c-config.js'));
  assert.ok(react.files.every((f) => !f.path.startsWith('slate/')));
  assert.deepEqual(
    react.commands.map((c) => c.id),
    ['install', 'functions', 'ui-deps', 'ui-build', 'slate-link', 'slate'],
  );
});
