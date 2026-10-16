/**
 * Census: the flags each live command's implementation reads equal the flags
 * ARGV_SPEC accepts for it. A flag a command reads but the spec lacks would be
 * refused with exit 2 before the command runs; a flag the spec lists but the
 * command never reads would be accepted and silently ignored. Both fail here.
 *
 * The census is static: from each command's entry functions it follows calls
 * to the top-level functions of packages/{cli,deploy,doctor}/src and collects
 * every flag literal read from argv (flag(), valueOf(), .includes(),
 * .indexOf(), args[i] === ...). Flags the code only emits for another tool
 * (the catalyst CLI's --org, a catalyst command's own --only) are not reads.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARGV_SPEC, argvProblems, argvShapeProblems } from '../src/argv.js';
import { DELTA_SOURCES } from '../../deploy/src/delta-cli.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Each command's entry functions; c2c.ts's own `if (cmd === ...)` block is added for every command. */
const ROOTS: Record<string, string[]> = {
  deploy: ['doctorGateForArgs', 'deployCli'],
  provision: ['doctorGateForArgs', 'provisionCreatesProject', 'provisionCli'],
  smoke: ['doctorGateForArgs', 'smokeCli'],
  'migrate-data': ['doctorGateForArgs', 'sourceBackupCli', 'sourceCsvCli', 'seedMigrateCli', 'migrateCli'],
  seed: ['seedArgsProblem'],
  doctor: ['doctorCli'],
  precheck: ['precheck'],
  status: ['statusCli'],
  verify: ['verifyCli'],
  'verify-behavior': ['verifyBehaviorCli'],
  'rollback-export': ['doctorGateForArgs', 'rollbackExportCli'],
  'cutover-checklist': ['cutoverCli'],
  proof: ['cutoverCli'],
  'iac-drift': [],
};

const READ = /(?:\b(?:flag|valueOf)\(\s*(?:[\w.]+,\s*)?|\b(?:args|rest|restAll)\.(?:includes|indexOf)\(|\b(?:args|rest)\[\w+(?: \+ 1)?\] [!=]== )'(--[a-z][a-z0-9-]*)'/g;

function functionBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const pkg of ['cli', 'deploy', 'doctor']) {
    const dir = path.join(repo, 'packages', pkg, 'src');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const text = readFileSync(path.join(dir, file), 'utf8');
      for (const match of text.matchAll(/^(?:export )?(?:async )?function (\w+)[\s\S]*?^}$/gm)) {
        bodies.set(match[1], `${bodies.get(match[1]) ?? ''}\n${match[0]}`);
      }
    }
  }
  return bodies;
}

function dispatchBlock(cmd: string): string {
  const text = readFileSync(path.join(repo, 'packages', 'cli', 'src', 'c2c.ts'), 'utf8');
  // A branch may serve several commands: `if (cmd === 'a' || cmd === 'b') {`.
  const start = text.search(new RegExp(`^  if \\((?:cmd === '[^']+' \\|\\| )*cmd === '${cmd}'(?: \\|\\| cmd === '[^']+')*\\) \\{`, 'm'));
  assert.ok(start >= 0, `c2c.ts dispatches ${cmd}`);
  const end = text.indexOf('\n  }\n', start);
  return text.slice(start, end);
}

function census(cmd: string, bodies: Map<string, string>): Set<string> {
  const flags = new Set<string>();
  const seen = new Set<string>();
  const queue = [...ROOTS[cmd]];
  const scan = (body: string) => {
    for (const match of body.matchAll(READ)) flags.add(match[1]);
    for (const match of body.matchAll(/\b(\w+)\(/g)) if (bodies.has(match[1])) queue.push(match[1]);
  };
  for (const root of ROOTS[cmd]) if (root.endsWith('Cli')) assert.ok(bodies.has(root), `${cmd}: entry function ${root} exists`);
  scan(dispatchBlock(cmd));
  while (queue.length) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    scan(bodies.get(name) as string);
  }
  // deltaSource reads `--source-${kind}` for each DELTA_SOURCES kind.
  if (seen.has('deltaSource')) for (const kind of Object.keys(DELTA_SOURCES)) flags.add(`--source-${kind}`);
  return flags;
}

test('every command in ARGV_SPEC has a census', () => {
  assert.deepEqual(Object.keys(ARGV_SPEC).sort(), Object.keys(ROOTS).sort());
});

for (const cmd of Object.keys(ROOTS)) {
  test(`${cmd}: ARGV_SPEC lists exactly the flags the implementation reads`, () => {
    const read = census(cmd, functionBodies());
    // precheck intentionally accepts only --json and iac-drift no flag at all;
    // requiring four flags would reject their accurate census.
    if (cmd !== 'precheck' && cmd !== 'iac-drift') assert.ok(read.size >= 4, `${cmd}: the census found the command's flags (${[...read].join(' ')})`);
    const spec = new Set(Object.keys(ARGV_SPEC[cmd].flags));
    const missing = [...read].filter((name) => !spec.has(name)).sort();
    const unread = [...spec].filter((name) => !read.has(name)).sort();
    assert.deepEqual(missing, [], `${cmd} reads flags ARGV_SPEC refuses`);
    assert.deepEqual(unread, [], `ARGV_SPEC accepts ${cmd} flags the command never reads`);
  });
}

test('doctor: the session-flow flags pass the shape check and the scope flags doctor refuses do not', () => {
  assert.deepEqual(argvShapeProblems('doctor', ['--mcp-begin']), []);
  assert.deepEqual(argvShapeProblems('doctor', ['--mcp-observed', '-']), []);
  assert.deepEqual(argvShapeProblems('doctor', ['--json', '--org', '<org-id>', '--record-mcp', 'evidence.json', '--operator']), []);
  assert.deepEqual(argvShapeProblems('doctor', ['--projects', 'projects.json']), ['unknown flag --projects']);
  assert.deepEqual(argvShapeProblems('doctor', ['--env', 'Development']), ['unknown flag --env']);
});

test('smoke: the result and browser flags pass the shape check', () => {
  assert.deepEqual(argvShapeProblems('smoke', ['app.ds', '--result', '-', '--max-age', '30', '--project', '<project-id>', '--url', 'https://app.example']), []);
  assert.deepEqual(argvShapeProblems('smoke', ['app.ds', '--result-code', 'c2cs1kAbC_-x', '--report', 'smoke.json']), []);
  assert.deepEqual(argvShapeProblems('smoke', ['app.ds', '--result-code', '-']), []);
  assert.deepEqual(argvShapeProblems('smoke', ['app.ds', '--confirm', '--in-browser', '--cdp', '--browser-cdp', 'http://127.0.0.1:9222', '--report', 'smoke.json']), []);
});

test('smoke: --url is required only when the confirmed run drives a browser or calls the app with a credential flag', () => {
  assert.deepEqual(argvProblems('smoke', ['app.ds', '--confirm']), []);
  assert.deepEqual(argvProblems('smoke', ['app.ds', '--confirm', '--owner-session']), []);
  assert.deepEqual(argvProblems('smoke', ['app.ds', '--result', 'block.txt']), []);
  assert.deepEqual(argvProblems('smoke', ['app.ds', '--confirm', '--in-browser', '--cdp']), ['smoke --confirm requires --url']);
  assert.deepEqual(argvProblems('smoke', ['app.ds', '--confirm', '--auth-token', 't']), ['smoke --confirm requires --url']);
  assert.deepEqual(argvProblems('smoke', ['app.ds', '--confirm', '--cdp', '--url', 'https://app.example']), ['--cdp drives a local browser for --in-browser or --owner-session; pass one of them']);
});

test('argvProblems: a command with no argument contract is reported, not passed', () => {
  assert.deepEqual(argvProblems('no-such-command', []), ['c2c has no no-such-command command with an argument contract']);
});

test('deploy: --function-env is validated offline and never echoes a value', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-argv-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, text: string) => {
    const at = path.join(dir, name);
    writeFileSync(at, text);
    return at;
  };
  assert.match(argvProblems('deploy', ['app.ds', '--confirm']).join('\n'), /^--confirm needs --function-env <file> /);
  assert.deepEqual(argvProblems('deploy', ['app.ds', '--confirm', '--function-env', 'new']), []);
  assert.deepEqual(argvProblems('deploy', ['app.ds']), []);
  assert.deepEqual(argvProblems('deploy', ['app.ds', '--function-env', file('ok.json', '{"API_TOKEN":"s3cr3t-value"}')]), []);
  assert.deepEqual(argvProblems('deploy', ['app.ds', '--function-env', path.join(dir, 'missing.json')]), ['--function-env must be a readable JSON file']);
  assert.deepEqual(argvProblems('deploy', ['app.ds', '--function-env', file('bad.json', '{not json')]), ['--function-env must be a readable JSON file']);
  assert.deepEqual(argvProblems('deploy', ['app.ds', '--function-env', file('array.json', '["a"]')]), ['--function-env must hold a JSON object of name -> string']);
  assert.deepEqual(argvProblems('deploy', ['app.ds', '--function-env', file('num.json', '{"TOKEN":42}')]), ['--function-env: TOKEN must be a string']);
  const badName = argvProblems('deploy', ['app.ds', '--function-env', file('name.json', '{"bad name":"s3cr3t-value"}')]);
  assert.deepEqual(badName, ['function env: "bad name" is not an environment variable name']);
  assert.doesNotMatch(badName.join('\n'), /s3cr3t/);
});

test('provision, seed, status: each command rule reports one first-line problem', () => {
  assert.deepEqual(argvProblems('provision', []), ['usage: c2c provision --out <dir> [--status | --next | --confirm --run <id> | --record <id> [--result <file>] [--applied]]']);
  assert.deepEqual(argvProblems('seed', ['app.ds']), ['c2c seed: --out directory is required']);
  assert.deepEqual(argvProblems('seed', []), ['the app source must come first', 'c2c seed: --out directory is required']);
  assert.deepEqual(argvProblems('status', []), ['c2c status: --project <project-id> is required']);
  assert.deepEqual(argvProblems('status', ['--project', '<project-id>']), ['c2c status: --org <org-id> is required (or run with --fake)']);
  assert.deepEqual(argvProblems('smoke', ['--confirm']), ['smoke needs the app source']);
});

test('migrate-data: --source-csv and --seed each need their own inputs', () => {
  assert.deepEqual(argvProblems('migrate-data', ['--source-csv']), ['--source-csv needs a value', 'migrate-data --source-csv/--source-json needs the data dir and --ds']);
  assert.deepEqual(argvProblems('migrate-data', ['--source-csv', 'data', '--ds', 'app.ds']), []);
  assert.deepEqual(argvProblems('migrate-data', ['--seed', 'seed.json']), ['migrate-data --seed needs the seed file and --ds or --app']);
  assert.deepEqual(argvProblems('migrate-data', ['--seed', 'seed.json', '--ds', 'app.ds']), []);
  assert.deepEqual(argvProblems('migrate-data', ['--source-csv', 'data', '--ds', 'app.ds', '--seed', 'seed.json']), ['c2c: pass either --seed or --source-csv, not both']);
});

test('cutover-checklist, proof, rollback-export and iac-drift refuse a flag they do not read', () => {
  for (const cmd of ['cutover-checklist', 'proof']) {
    assert.deepEqual(argvShapeProblems(cmd, ['app.ds', '--source-json', 'export', '--since', 'state', '--smoke', 'smoke.json', '--rollback-export', 'rollback', '--project', '<project-id>', '--dc', 'us', '--config', 'c2c-deploy.json', '--out', 'out']), []);
    assert.deepEqual(argvShapeProblems(cmd, ['app.ds', '--rollback-dir', 'rollback']), ['unknown flag --rollback-dir', 'unexpected argument rollback']);
    assert.deepEqual(argvShapeProblems(cmd, ['app.ds', '--smoke']), ['--smoke needs a value']);
  }
  assert.deepEqual(argvShapeProblems('rollback-export', ['--ds', 'app.ds', '--out', 'out', '--rows', 'rows']), []);
  assert.deepEqual(argvShapeProblems('rollback-export', ['--ds', 'app.ds', '--out', 'out', '--project', '<project-id>', '--org', '<org-id>', '--confirm']), []);
  assert.deepEqual(argvShapeProblems('rollback-export', ['--ds', 'app.ds', '--out', 'out', '--rows', 'rows', '--bogus']), ['unknown flag --bogus']);
  assert.deepEqual(argvShapeProblems('iac-drift', ['a.json', 'b.json']), []);
  assert.deepEqual(argvShapeProblems('iac-drift', ['a.json', 'b.json', '--json']), ['unknown flag --json']);
  assert.deepEqual(argvShapeProblems('iac-drift', ['a.json']), ['two template files are required']);
  assert.deepEqual(argvShapeProblems('iac-drift', ['a.json', 'b.json', 'c.json']), ['unexpected argument c.json']);
});

test('deploy: --backfill-shadows --confirm does not need --function-env; a plain --confirm still does', () => {
  assert.deepEqual(argvProblems('deploy', ['app.ds', '--backfill-shadows', '--confirm']), []);
  assert.match(argvProblems('deploy', ['app.ds', '--confirm']).join('\n'), /^--confirm needs --function-env <file> /);
});
