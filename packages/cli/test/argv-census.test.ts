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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARGV_SPEC, argvProblems, argvShapeProblems } from '../src/argv.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Each command's entry functions; c2c.ts's own `if (cmd === ...)` block is added for every command. */
const ENTRY_POINTS: Record<string, string[]> = {
  deploy: ['doctorGateForArgs', 'deployCli'],
  provision: ['doctorGateForArgs', 'provisionCreatesProject', 'provisionCli'],
  smoke: ['doctorGateForArgs', 'smokeCli'],
  'migrate-data': ['doctorGateForArgs', 'sourceBackupCli', 'sourceCsvCli', 'seedMigrateCli', 'migrateCli'],
  seed: ['seedArgsProblem'],
  doctor: ['doctorCli'],
  precheck: ['precheck'],
  status: ['statusCli'],
  verify: ['verifyCli'],
  plan: ['planCli'],
  edit: ['editCli'],
  users: ['doctorGateForArgs', 'usersCli'],
  'sync-delta': ['doctorGateForArgs', 'syncDeltaCli'],
  'rollback-export': ['doctorGateForArgs', 'rollbackExportCli'],
  'cutover-checklist': ['cutoverCli'],
  proof: ['cutoverCli'],
  'fill-todos': ['fillTodosMain'],
  '--verify-vendor': ['verifyVendorCli'],
};

const ROOTS: Record<string, string[]> = Object.fromEntries(
  Object.keys(ARGV_SPEC).map((cmd) => [cmd, ENTRY_POINTS[cmd] ?? []]),
);

const READ = /(?:\b(?:flag|valueOf|take)\(\s*(?:[\w.]+,\s*)?|\b(?:args|rest|restAll)\.(?:includes|indexOf)\(|\b(?:args|rest)\[\w+(?: \+ 1)?\] [!=]== |\b(?:if\s*\(|else if\s*\(|case\s+)arg [!=]== )'(--[a-z][a-z0-9-]*)'/g;

function functionBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const pkg of ['cli', 'deploy', 'doctor', 'deluge']) {
    const dir = path.join(repo, 'packages', pkg, 'src');
    if (!existsSync(dir)) continue;
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
  const needle = `cmd === '${cmd}'`;
  const pos = text.indexOf(needle);
  assert.ok(pos >= 0, `c2c.ts dispatches ${cmd}`);
  const start = text.lastIndexOf('\n  if (', pos) + 1;
  const end = text.indexOf('\n  }\n', start);
  return text.slice(start, end);
}

function census(cmd: string, bodies: Map<string, string>): Set<string> {
  const flags = new Set<string>();
  const seen = new Set<string>();
  const queue = [...ROOTS[cmd]];
  const scan = (body: string) => {
    for (const match of body.matchAll(READ)) flags.add(match[1]);
    if (body.includes('--source-${kind}')) {
      flags.add('--source-backup');
      flags.add('--source-csv');
      flags.add('--source-json');
    }
    for (const match of body.matchAll(/(?<!\.)\b(\w+)\(/g)) {
      if (cmd === 'edit' && match[1] === 'doctorGateRefusal') continue;
      if (bodies.has(match[1])) queue.push(match[1]);
    }
  };
  for (const root of ROOTS[cmd]) if (root.endsWith('Cli')) assert.ok(bodies.has(root), `${cmd}: entry function ${root} exists`);
  scan(dispatchBlock(cmd));
  while (queue.length) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    scan(bodies.get(name) as string);
  }
  if (cmd === '--verify-vendor') flags.delete('--verify-vendor');
  return flags;
}

test('every command in ARGV_SPEC has a census', () => {
  assert.deepEqual(Object.keys(ARGV_SPEC).sort(), Object.keys(ROOTS).sort());
});

for (const cmd of Object.keys(ROOTS)) {
  test(`${cmd}: ARGV_SPEC lists exactly the flags the implementation reads`, () => {
    const read = census(cmd, functionBodies());
    // precheck intentionally accepts only --json; requiring four flags would
    // reject its accurate one-flag census.
    if (cmd !== 'precheck') assert.ok(read.size >= 4, `${cmd}: the census found the command's flags (${[...read].join(' ')})`);
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
