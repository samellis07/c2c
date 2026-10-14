import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DEPLOY_CONFIG, doctorCli, doctorJsonPath, type DoctorFile, type DoctorIo, type SpawnResult } from '../src/index.js';

const ORG = '10000000000';
const PROJECT = '10000000000013200';

const PROJECT_TABLE = `\
┌───────────────┬──────────────┐
│ Project ID    │ Name         │
├───────────────┼──────────────┤
│ ${PROJECT} │ my-app       │
└───────────────┴──────────────┘
`;

function greenCatalyst(cmd: string, args: string[]): SpawnResult {
  if (cmd !== 'catalyst') return { code: 127, stdout: '', stderr: 'not found' };
  const key = args.join(' ');
  if (key === '--version') return { code: 0, stdout: '1.28.0\n', stderr: '' };
  if (key === 'whoami') return { code: 0, stdout: 'Logged as: user@example.com\n', stderr: '' };
  if (key.endsWith('project:list')) return { code: 0, stdout: PROJECT_TABLE, stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
}

interface ReactProbes {
  /** stdout of `node --version`; undefined means node is not installed. */
  node?: string;
  /** stdout of `npm --version`; undefined means npm is not installed. */
  npm?: string;
  /** exit of `npm ping`; default 0. */
  pingCode?: number;
  /** stdout of `npm config get cache`. */
  cache?: string;
}

function reactSpawn(probes: ReactProbes): (cmd: string, args: string[]) => SpawnResult {
  return (cmd, args) => {
    if (cmd === 'node') {
      return probes.node === undefined
        ? { code: 127, stdout: '', stderr: 'node: not found' }
        : { code: 0, stdout: probes.node, stderr: '' };
    }
    if (cmd === 'npm') {
      const key = args.join(' ');
      if (key === '--version') {
        return probes.npm === undefined
          ? { code: 127, stdout: '', stderr: 'npm: not found' }
          : { code: 0, stdout: probes.npm, stderr: '' };
      }
      if (args[0] === 'ping') {
        const code = probes.pingCode ?? 0;
        return { code, stdout: code === 0 ? 'PONG\n' : '', stderr: code === 0 ? '' : 'network unreachable' };
      }
      if (key === 'config get cache') {
        return { code: 0, stdout: `${probes.cache ?? ''}\n`, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: `unexpected npm ${key}` };
    }
    return greenCatalyst(cmd, args);
  };
}

/** A workspace with the plugin skills on disk and a deploy config; cleaned up after the test. */
function workspace(t: TestContext, extraConfig: Record<string, unknown> = {}): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-react-doctor-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const home = join(dir, 'home');
  const skills = join(home, 'skills', 'catalyst-by-zoho');
  mkdirSync(skills, { recursive: true });
  writeFileSync(
    join(skills, 'SKILL.md'),
    '---\nname: catalyst-by-zoho\ndescription: official\nmetadata:\n  version: "0.0.2"\n---\nbody\n',
  );
  writeFileSync(
    join(dir, DEPLOY_CONFIG),
    JSON.stringify({ dc: 'in', org: ORG, project: PROJECT, env: 'Development', ...extraConfig }),
  );
  return { dir, env: { HOME: home, C2C_WORKSPACE: dir, C2C_CATALYST_SKILLS_DIR: join(home, 'skills') } };
}

function cacheDir(t: TestContext, writable = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-npm-cache-'));
  if (!writable) chmodSync(dir, 0o555);
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeIo(env: NodeJS.ProcessEnv, probes: ReactProbes) {
  let out = '';
  let err = '';
  const spawn = reactSpawn(probes);
  const io: DoctorIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    spawn: async (command, args) => spawn(command, args),
  };
  return { io, out: () => out, err: () => err };
}

function checksOf(dir: string): DoctorFile['checks'] {
  return (JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile).checks;
}

const GOOD: ReactProbes = { node: 'v20.20.1\n', npm: '10.8.2\n' };

test('react is the default with no flag or config: the four prerequisites run', async (t) => {
  const { dir, env } = workspace(t);
  const { io, out } = fakeIo(env, { ...GOOD, cache: cacheDir(t) });
  const code = await doctorCli([], io, { hooks: { cliDc: () => undefined, cliOrg: () => undefined } });
  assert.equal(code, 0, out());
  for (const id of ['D-R1', 'D-R2', 'D-R3', 'D-R4']) assert.match(out(), new RegExp(`PASS ${id}`));
  assert.equal(checksOf(dir).find((c) => c.id === 'D-R1')?.status, 'pass');
});

test('vanilla fallback: --ui vanilla and config ui=vanilla run no React prerequisite checks', async (t) => {
  const noHooks = { hooks: { cliDc: () => undefined, cliOrg: () => undefined } };
  {
    const { dir, env } = workspace(t, { ui: 'vanilla' });
    const { io, out } = fakeIo(env, { ...GOOD, cache: cacheDir(t) });
    const code = await doctorCli([], io, noHooks);
    assert.equal(code, 0, out());
    assert.doesNotMatch(out(), /D-R[0-9]/);
    assert.ok(!checksOf(dir).some((c) => c.id.startsWith('D-R')), 'vanilla doctor.json holds a D-R check');
  }
  {
    const { dir, env } = workspace(t);
    const { io, out } = fakeIo(env, { ...GOOD, cache: cacheDir(t) });
    const code = await doctorCli(['--ui', 'vanilla'], io, noHooks);
    assert.equal(code, 0, out());
    assert.doesNotMatch(out(), /D-R[0-9]/);
    assert.ok(!checksOf(dir).some((c) => c.id.startsWith('D-R')), 'vanilla doctor.json holds a D-R check');
  }
});

test('react target via c2c-deploy.json: all four prerequisites pass', async (t) => {
  const { dir, env } = workspace(t, { ui: 'react' });
  const { io, out } = fakeIo(env, { ...GOOD, cache: cacheDir(t) });
  const code = await doctorCli([], io, { hooks: { cliDc: () => undefined, cliOrg: () => undefined } });
  assert.equal(code, 0, out());
  for (const id of ['D-R1', 'D-R2', 'D-R3', 'D-R4']) assert.match(out(), new RegExp(`PASS ${id}`));
  assert.equal(checksOf(dir).find((c) => c.id === 'D-R1')?.status, 'pass');
});

test('react target via --ui react, and --ui wins over the config', async (t) => {
  const noHooks = { hooks: { cliDc: () => undefined, cliOrg: () => undefined } };
  {
    const { env } = workspace(t);
    const { io, out } = fakeIo(env, { ...GOOD, cache: cacheDir(t) });
    assert.equal(await doctorCli(['--ui', 'react'], io, noHooks), 0, out());
    assert.match(out(), /PASS D-R1/);
  }
  {
    const { env } = workspace(t, { ui: 'react' });
    const { io, out } = fakeIo(env, { ...GOOD, cache: cacheDir(t) });
    assert.equal(await doctorCli(['--ui', 'vanilla'], io, noHooks), 0, out());
    assert.doesNotMatch(out(), /D-R[0-9]/);
  }
});

test('D-R1 fails when node is missing or below the build floor', async (t) => {
  const noHooks = { hooks: { cliDc: () => undefined, cliOrg: () => undefined } };
  {
    const { env } = workspace(t, { ui: 'react' });
    const { io, out } = fakeIo(env, { npm: '10.8.2\n', cache: cacheDir(t) });
    assert.equal(await doctorCli(['--ui', 'react'], io, noHooks), 1, out());
    assert.match(out(), /FAIL D-R1/);
    assert.match(out(), /install Node/);
  }
  for (const node of ['v18.19.0\n', 'v20.18.3\n', 'v21.0.0\n', 'v22.11.0\n']) {
    const { env } = workspace(t, { ui: 'react' });
    const { io, out } = fakeIo(env, { node, npm: '10.8.2\n', cache: cacheDir(t) });
    assert.equal(await doctorCli(['--ui', 'react'], io, noHooks), 1, node);
    assert.match(out(), /FAIL D-R1/, node);
  }
});

test('D-R1 passes on the supported range edges', async (t) => {
  for (const node of ['v20.19.0\n', 'v20.20.1\n', 'v22.12.0\n']) {
    const { env } = workspace(t, { ui: 'react' });
    const { io, out } = fakeIo(env, { node, npm: '10.8.2\n', cache: cacheDir(t) });
    assert.equal(await doctorCli(['--ui', 'react'], io, { hooks: { cliDc: () => undefined, cliOrg: () => undefined } }), 0, node);
    assert.match(out(), /PASS D-R1/, node);
  }
});

test('missing npm -> doctor fails with the fix line', async (t) => {
  const { env } = workspace(t, { ui: 'react' });
  const { io, out } = fakeIo(env, { node: 'v20.20.1\n' });
  const code = await doctorCli([], io, { hooks: { cliDc: () => undefined, cliOrg: () => undefined } });
  assert.equal(code, 1, out());
  assert.match(out(), /FAIL D-R2/);
  assert.match(out(), /fix: install Node 20\.20\.1; npm ships with it/);
});

test('D-R2 fails when npm is missing or too old; the registry and cache checks skip', async (t) => {
  const noHooks = { hooks: { cliDc: () => undefined, cliOrg: () => undefined } };
  {
    const { env } = workspace(t, { ui: 'react' });
    const { io, out } = fakeIo(env, { node: 'v20.20.1\n' });
    assert.equal(await doctorCli([], io, noHooks), 1, out());
    assert.match(out(), /FAIL D-R2/);
    assert.match(out(), /SKIP D-R3/);
    assert.match(out(), /SKIP D-R4/);
  }
  {
    const { env } = workspace(t, { ui: 'react' });
    const { io, out } = fakeIo(env, { node: 'v20.20.1\n', npm: '9.9.9\n', cache: cacheDir(t) });
    assert.equal(await doctorCli([], io, noHooks), 1, out());
    assert.match(out(), /FAIL D-R2/);
  }
});

test('D-R3 warns when the registry is unreachable, and the run stays green', async (t) => {
  const { dir, env } = workspace(t, { ui: 'react' });
  const { io, out } = fakeIo(env, { ...GOOD, pingCode: 1, cache: cacheDir(t) });
  const code = await doctorCli([], io, { hooks: { cliDc: () => undefined, cliOrg: () => undefined } });
  assert.equal(code, 0, out());
  assert.match(out(), /WARN D-R3/);
  assert.match(out(), /registry/);
  const file = JSON.parse(readFileSync(doctorJsonPath(dir), 'utf8')) as DoctorFile;
  assert.equal(file.green, true);
  assert.equal(file.checks.find((c) => c.id === 'D-R3')?.status, 'warn');
});

test('D-R4 fails when the npm cache is not writable', async (t) => {
  const { env } = workspace(t, { ui: 'react' });
  const { io, out } = fakeIo(env, { ...GOOD, cache: cacheDir(t, false) });
  const code = await doctorCli([], io, { hooks: { cliDc: () => undefined, cliOrg: () => undefined } });
  assert.equal(code, 1, out());
  assert.match(out(), /FAIL D-R4/);
  assert.match(out(), /writable/);
});

test('D-R3 skips on a --local run; the other React checks still run', async (t) => {
  const { env } = workspace(t, { ui: 'react' });
  const { io, out } = fakeIo(env, { ...GOOD, pingCode: 1, cache: cacheDir(t) });
  const code = await doctorCli(['--local'], io, { hooks: { cliDc: () => undefined, cliOrg: () => undefined } });
  assert.match(out(), /SKIP D-R3/);
  assert.match(out(), /PASS D-R1/);
  assert.match(out(), /PASS D-R2/);
  assert.match(out(), /PASS D-R4/);
  assert.equal(code, 0, out());
});

test('an unknown ui value is refused', async (t) => {
  const noHooks = { hooks: { cliDc: () => undefined, cliOrg: () => undefined } };
  {
    const { env } = workspace(t);
    const { io } = fakeIo(env, GOOD);
    assert.equal(await doctorCli(['--ui', 'svelte'], io, noHooks), 2);
  }
  {
    const { env } = workspace(t, { ui: 'svelte' });
    const { io } = fakeIo(env, GOOD);
    assert.equal(await doctorCli([], io, noHooks), 2);
  }
});

test('D-R1 enforces exactly the Node range the emitted web/package.json declares', async (t) => {
  const { generateReactApp } = await import('../../ui-react/src/index.js');
  const { deriveIr, parse } = await import('../../core/src/index.js');
  const app = deriveIr(parse('application "Widget"\n{\n\tsection S\n\t{\n\t\tform F\n\t\t{\n\t\t\tName\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n}\n'));
  const files = generateReactApp(app);
  const text = (path: string) => Buffer.from(files.find((f) => f.path === path)!.data).toString('utf8');
  const engines = (JSON.parse(text('package.json')) as { engines: { node: string } }).engines.node;
  const lockEngines = (JSON.parse(text('package-lock.json')) as { packages: Record<string, { engines?: { node: string } }> }).packages['']!.engines!.node;
  assert.equal(engines, '^20.19.0 || >=22.12.0', 'the emitted range is the pinned Vite build range');
  assert.equal(lockEngines, engines, 'the emitted lockfile root agrees with package.json');
  assert.match(text('.npmrc'), /^engine-strict=true$/m, 'npm refuses a Node outside the range');

  const noHooks = { hooks: { cliDc: () => undefined, cliOrg: () => undefined } };
  const cases: [string, boolean][] = [
    ['v18.20.4\n', false],
    ['v20.18.3\n', false],
    ['v20.19.0\n', true],
    ['v20.20.1\n', true],
    ['v21.7.3\n', false],
    ['v22.11.0\n', false],
    ['v22.12.0\n', true],
    ['v22.23.3\n', true],
    ['v24.1.0\n', true],
  ];
  for (const [node, ok] of cases) {
    const { env } = workspace(t, { ui: 'react' });
    const { io, out } = fakeIo(env, { node, npm: '10.9.9\n', cache: cacheDir(t) });
    assert.equal(await doctorCli(['--ui', 'react'], io, noHooks), ok ? 0 : 1, `${node.trim()}: ${out()}`);
    if (ok) {
      assert.match(out(), /PASS D-R1/, node);
    } else {
      assert.match(out(), /FAIL D-R1/, node);
      assert.ok(out().includes(`the build needs Node ${engines}`), `${node.trim()} names the emitted range: ${out()}`);
      assert.match(out(), /install Node 20\.20\.1 \(nvm install 20\.20\.1 && nvm use 20\.20\.1\)/, node);
    }
  }
});
