/**
 * functions/c2c_jobs: the Job function every generated cron targets. An app
 * with schedules deploys it next to c2c_api; an app without schedules does not.
 * The live run goes through the offline Catalyst harness (no network).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import { deployCommands, deployFiles, writeDeployTree, type DeployFile } from '../src/plan.js';

const root = repoRoot();
const KITCHEN_SINK = join(root, 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds');
const NO_SCHEDULES = join(root, 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds');

function load(path: string): App {
  return deriveIr(parse(readFileSync(path, 'utf8')));
}

function guardFor(app: App): GuardOk {
  return {
    org: '10000000000',
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry: { org: '10000000000', env: 'Development', projects: {}, dc: 'in' },
  };
}

function text(files: readonly DeployFile[], path: string): string {
  const file = files.find((item) => item.path === path);
  assert.ok(file, `missing ${path}`);
  return typeof file.data === 'string' ? file.data : file.data.toString('utf8');
}

interface Cron {
  cron_name: string;
  cron_type: string;
  cron_detail: Record<string, unknown>;
  job_meta: { target_name: string; jobpool_name: string; params: { module: string } };
}

test('an app with schedules lists c2c_jobs as a Job function target with its pool and crons', () => {
  const app = load(KITCHEN_SINK);
  const bundle = deployFiles(app, guardFor(app), false, { mode: 'live' });
  assert.equal(bundle.usesJobs, true);
  const files = bundle.files;
  const catalyst = JSON.parse(text(files, 'catalyst.json')) as { functions: { targets: string[] } };
  assert.deepEqual(catalyst.functions.targets, ['c2c_api', 'c2c_jobs', 'c2c_auth']);
  const config = JSON.parse(text(files, 'functions/c2c_jobs/catalyst-config.json')) as {
    deployment: { name: string; stack: string; type: string; env_variables: Record<string, string> };
    execution: { main: string };
  };
  assert.deepEqual(config, { deployment: { name: 'c2c_jobs', stack: 'node20', type: 'job', env_variables: { C2C_DEPLOY_MODE: 'live' } }, execution: { main: 'index.js' } });
  const pkg = JSON.parse(text(files, 'functions/c2c_jobs/package.json')) as { name: string; main: string; dependencies: Record<string, string> };
  assert.deepEqual(pkg, { name: 'c2c_jobs', version: '1.0.0', private: true, main: 'index.js', dependencies: { 'zcatalyst-sdk-node': '3.4.0' } });
  const lock = JSON.parse(text(files, 'functions/c2c_jobs/package-lock.json')) as { name: string; packages: Record<string, { name?: string; dependencies?: Record<string, string> }> };
  assert.equal(lock.name, 'c2c_jobs');
  assert.equal(lock.packages['']?.name, 'c2c_jobs');
  assert.deepEqual(lock.packages['']?.dependencies, pkg.dependencies);

  // The function carries the same job-scheduling.json the generator wrote: one pool, crons targeting c2c_jobs.
  const scheduling = text(files, 'functions/c2c_jobs/job-scheduling.json');
  assert.equal(scheduling, text(files, 'job-scheduling.json'));
  const parsed = JSON.parse(scheduling) as { jobPool: { name: string; type: string }; target: Record<string, string>; crons: Cron[] };
  assert.deepEqual(parsed.jobPool, { name: 'KitchenSinkStudio', type: 'Function' });
  assert.deepEqual(parsed.target, { type: 'Function', name: 'c2c_jobs', functionType: 'job' });
  const crons = parsed.crons.map((cron) => ({ name: cron.cron_name, type: cron.cron_type, detail: cron.cron_detail, module: cron.job_meta.params.module, target: cron.job_meta.target_name, pool: cron.job_meta.jobpool_name }));
  assert.deepEqual(crons, [
    { name: 'c2c_Daily_Sweep', type: 'CronExpression', detail: { cron_expression: '0 6 * * *' }, module: 'job/daily-sweep.mjs', target: 'c2c_jobs', pool: 'KitchenSinkStudio' },
    { name: 'c2c_form_sweeper', type: 'Periodic', detail: { hour: 0, minute: 5, second: 0, repetition_type: 'every' }, module: 'job/c2c-form-sweeper.mjs', target: 'c2c_jobs', pool: 'KitchenSinkStudio' },
  ]);

  const inner = files.filter((file) => file.path.startsWith('functions/c2c_jobs/')).map((file) => file.path.slice('functions/c2c_jobs/'.length));
  for (const cron of crons) assert.ok(inner.includes(cron.module), `cron module ${cron.module} is in the function`);
  assert.ok(inner.includes('job/session-reminder.mjs'), 'the sweeper imports the form schedule module');
  // No HTTP surface: the Job function has no routes, principal, or handlers no job imports.
  for (const path of inner) assert.doesNotMatch(path, /^(routes\.json|principal-map\.json|c2c-principal\.mjs|aio\/|forms\/|reports\/|htmlpages\/|lookups\/|uploads\/|admin\/)/, path);
  const manifest = JSON.parse(text(files, 'functions/c2c_jobs/c2c-manifest.json')) as { function: string; files: string[] };
  assert.equal(manifest.function, 'c2c_jobs');
  assert.deepEqual(manifest.files, inner.filter((path) => path !== 'c2c-manifest.json'));

  // Generated twice, byte for byte.
  const again = deployFiles(app, guardFor(app), false, { mode: 'live' }).files.filter((file) => file.path.startsWith('functions/c2c_jobs/'));
  assert.deepEqual(again, files.filter((file) => file.path.startsWith('functions/c2c_jobs/')));
});

test('deploy commands install and deploy c2c_jobs after c2c_api only when the app has schedules', () => {
  const withJobs = deployCommands('app', '1', '1001', 'in', 'react', true).map((command) => [command.id, command.cwd ?? '', command.argv.join(' ')]);
  const ids = withJobs.map(([id]) => id);
  assert.deepEqual(ids.slice(0, 4), ['install', 'functions', 'install-jobs', 'functions-jobs']);
  assert.deepEqual(withJobs[2], ['install-jobs', 'functions/c2c_jobs', 'install --omit=dev --no-audit --no-fund']);
  assert.match(withJobs[3]?.[2] ?? '', / deploy --only functions:c2c_jobs -ni$/);
  const without = deployCommands('app', '1', '1001', 'in', 'react').map((command) => command.id);
  assert.deepEqual(without, ids.filter((id) => id !== 'install-jobs' && id !== 'functions-jobs'));
});

test('an app without schedules deploys no c2c_jobs and keeps its targets', () => {
  const app = load(NO_SCHEDULES);
  const bundle = deployFiles(app, guardFor(app), false, { mode: 'live' });
  assert.equal(bundle.usesJobs, false);
  assert.equal(bundle.files.some((file) => file.path.startsWith('functions/c2c_jobs/')), false);
  const catalyst = JSON.parse(text(bundle.files, 'catalyst.json')) as { functions: { targets: string[] } };
  assert.deepEqual(catalyst.functions.targets, ['c2c_api', 'c2c_auth']);
});

interface JobContext {
  closed: string[];
  closeWithSuccess(): void;
  closeWithFailure(): void;
}

function jobContext(): JobContext {
  const closed: string[] = [];
  return { closed, closeWithSuccess: () => closed.push('success'), closeWithFailure: () => closed.push('failure') };
}

test('c2c_jobs runs the module its cron names in the job datastore and refuses any other module', async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-jobs-'));
  const fake = join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
  const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
  const original = moduleAny._resolveFilename;
  moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'zcatalyst-sdk-node') return fake;
    return original.call(this, request, ...rest);
  };
  const quiet = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.join(' '));
  try {
    const app = load(KITCHEN_SINK);
    writeDeployTree(out, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const req = createRequire(import.meta.url);
    const sdk = req(fake) as { state(): { tables: Record<string, Record<string, unknown>[]> } };
    const entry = req(join(out, 'functions/c2c_jobs/index.js')) as (jobRequest: unknown, context: JobContext) => Promise<void>;
    const rows = () => (sdk.state().tables.Session_Log ?? []).length;
    const before = rows();

    const ran = jobContext();
    await entry({ getJobParam: (key: string) => (key === 'module' ? 'job/daily-sweep.mjs' : undefined) }, ran);
    assert.deepEqual(ran.closed, ['success']);
    assert.equal(rows(), before + 1, 'the live job inserted its Session_Log row through the job datastore');
    const inserted = sdk.state().tables.Session_Log?.at(-1) as Record<string, unknown>;
    assert.equal(inserted.Entry, 'Daily sweep');

    // getAllJobParams is read when getJobParam is absent.
    const viaAll = jobContext();
    await entry({ getAllJobParams: () => ({ module: 'job/daily-sweep.mjs' }) }, viaAll);
    assert.deepEqual(viaAll.closed, ['success']);
    assert.equal(rows(), before + 2);

    // A module no cron lists, a path outside job/, and no parameter all close with failure and write nothing.
    for (const module of ['job/session-reminder.mjs', '../c2c_api/index.js', 'index.js', 'job/../c2c-store.mjs', undefined]) {
      const refused = jobContext();
      await entry({ params: module === undefined ? {} : { module } }, refused);
      assert.deepEqual(refused.closed, ['failure'], String(module));
    }
    assert.equal(rows(), before + 2);
    assert.ok(logged.every((line) => line.startsWith('c2c_jobs: job parameter "module" names no scheduled job module')), logged.join('\n'));
  } finally {
    console.error = quiet;
    moduleAny._resolveFilename = original;
    rmSync(out, { recursive: true, force: true });
  }
});
