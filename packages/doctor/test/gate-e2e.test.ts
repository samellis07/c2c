/**
 * End-to-end gate checks: run the built c2c binary, not the library, so a
 * checkout without the doctor feature shows a behavioural RED (wrong exit code
 * or a missing report stamp), not a missing-module error.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const c2cBin = join(repo, 'dist', 'cli', 'src', 'c2c.js');
const minimalDs = join(repo, 'fixtures', 'dialects', 'd1-minimal.ds');

const ORG = '10000000000';
const PROJECT = '10000000000013200';

/** The check ids the gate requires. */
const REQUIRED_IDS = ['D-C1', 'D-C3', 'D-C5', 'D-E1', 'D-B1', 'D-B3', 'D-B5', 'D-B7', 'D-V1', 'D-V2'];

function pkgVersion(): string {
  return (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;
}

/** Persist a doctor.json the way a real green `c2c doctor --record-mcp` run writes it. */
function writeDoctor(dir: string, overrides: Record<string, unknown> = {}): void {
  const state = join(dir, 'c2c-out', '.c2c');
  mkdirSync(state, { recursive: true });
  const scope = { dc: 'in', org: ORG, project: PROJECT };
  writeFileSync(
    join(state, 'doctor.json'),
    JSON.stringify(
      {
        c2c: pkgVersion(),
        at: new Date().toISOString(),
        host: 'claude-code',
        scope,
        checks: REQUIRED_IDS.map((id) => ({ id, status: 'pass', detail: 'ok', fix: null })),
        mcp: { server: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in', at: new Date().toISOString(), scope },
        green: true,
        ...overrides,
      },
      null,
      2,
    ),
  );
}

const dirs: string[] = [];
function tmp(prefix = 'c2c-gate-e2e-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A bin dir holding only node, so `catalyst` is never found — even where it really is installed. */
function nodeOnlyBin(workspace: string): string {
  const bin = join(workspace, 'bin');
  mkdirSync(bin, { recursive: true });
  const node = join(bin, 'node');
  if (!existsSync(node)) symlinkSync(process.execPath, node);
  return bin;
}

function runC2c(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [c2cBin, ...args], {
      cwd,
      env: { PATH: nodeOnlyBin(cwd), HOME: join(cwd, 'home'), C2C_WORKSPACE: cwd },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('e2e: deploy --confirm exits 5 without a green doctor', () => {
  const dir = tmp();
  const run = runC2c(['deploy', minimalDs, '--org', ORG, '--project', PROJECT, '--confirm'], dir);
  assert.equal(run.code, 5, run.stderr);
  assert.match(run.stderr, /c2c: doctor is not green for \S+\/\d+\/\d+ \(run c2c doctor; last: /);
});

test('e2e: migrate-data --confirm and smoke --confirm also refuse with 5', () => {
  const dir = tmp();
  const migrate = runC2c(['migrate-data', '--source-csv', 'x', '--ds', minimalDs, '--project', PROJECT, '--org', ORG, '--confirm'], dir);
  assert.equal(migrate.code, 5, migrate.stderr);
  assert.match(migrate.stderr, /doctor is not green/);
  const smoke = runC2c(['smoke', minimalDs, '--project', PROJECT, '--org', ORG, '--confirm'], dir);
  assert.equal(smoke.code, 5, smoke.stderr);
  assert.match(smoke.stderr, /doctor is not green/);
});

test('e2e: edit --apply --confirm exits 5 without a green doctor', () => {
  const dir = tmp();
  const ds = join(dir, 'app.ds');
  writeFileSync(ds, readFileSync(minimalDs));
  // Recording a drop in the edits log is a store write, so it gates like the
  // other --confirm commands. A bare --confirm dry run writes nothing and is
  // never refused by the gate.
  const apply = runC2c(['edit', ds, 'remove-field', 'Contact', 'Email', '--dc', 'in', '--apply', '--confirm'], dir);
  assert.equal(apply.code, 5, apply.stderr);
  assert.match(apply.stderr, /doctor is not green/);
  const dry = runC2c(['edit', ds, 'remove-field', 'Contact', 'Email', '--dc', 'in', '--confirm'], dir);
  assert.notEqual(dry.code, 5, `a dry run was gate-refused: ${dry.stderr}`);
  assert.ok(!existsSync(join(dir, 'app.edits.json')), 'the edits log must not be written');
});

test('e2e: provision --confirm exits 5 on a red doctor.json and makes no calls', () => {
  const dir = tmp();
  // A red doctor.json on disk: the run stops at the gate, before the plan file
  // is even looked for (a missing plan would exit 2, a live step would call out).
  writeDoctor(dir, { green: false });
  const run = runC2c(['provision', '--out', join(dir, 'no-such-plan'), '--confirm', '--run', 'tables', '--org', ORG, '--project', PROJECT, '--dc', 'in'], dir);
  assert.equal(run.code, 5, run.stderr);
  assert.match(run.stderr, /doctor is not green/);
});

test('e2e: a missing doctor.json refuses provision --confirm with 5 too', () => {
  const dir = tmp();
  const run = runC2c(['provision', '--out', join(dir, 'no-such-plan'), '--confirm', '--run', 'tables', '--org', ORG, '--project', PROJECT, '--dc', 'in'], dir);
  assert.equal(run.code, 5, run.stderr);
  assert.match(run.stderr, /doctor is not green/);
});

test('e2e: provision --confirm on a green doctor.json proceeds past the gate', () => {
  const dir = tmp();
  writeDoctor(dir);
  // Past the gate the command reaches provision's own code — a missing plan is
  // a usage error (2), never the gate refusal (5).
  const run = runC2c(['provision', '--out', join(dir, 'no-such-plan'), '--confirm', '--run', 'tables', '--org', ORG, '--project', PROJECT, '--dc', 'in'], dir);
  assert.notEqual(run.code, 5, `gate refused anyway: ${run.stderr}`);
});

test('e2e: dry-run reports stamp doctor: not-run instead of refusing', () => {
  const dir = tmp();
  const ds = join(dir, 'app.ds');
  writeFileSync(ds, readFileSync(minimalDs));
  const pre = runC2c(['precheck', ds, '--json'], dir);
  assert.equal(pre.code, 0, pre.stderr);
  assert.equal((JSON.parse(pre.stdout) as { doctor?: { status?: string } }).doctor?.status, 'not-run');
  const analyze = runC2c(['analyze', ds, '--json'], dir);
  assert.equal(analyze.code, 0, analyze.stderr);
  assert.equal((JSON.parse(analyze.stdout) as { doctor?: { status?: string } }).doctor?.status, 'not-run');
  const schema = runC2c(['schema', ds, '--json'], dir);
  assert.equal(schema.code, 0, schema.stderr);
  assert.equal((JSON.parse(schema.stdout) as { doctor?: { status?: string } }).doctor?.status, 'not-run');
});

test('e2e: a green stamp carries provenance (status, at, scope, c2c)', () => {
  const dir = tmp();
  writeDoctor(dir);
  const ds = join(dir, 'app.ds');
  writeFileSync(ds, readFileSync(minimalDs));
  const run = runC2c(['precheck', ds, '--json'], dir);
  assert.equal(run.code, 0, run.stderr);
  const doctor = (JSON.parse(run.stdout) as { doctor?: Record<string, unknown> }).doctor;
  assert.equal(doctor?.status, 'green');
  assert.equal(doctor?.c2c, pkgVersion());
  assert.equal(typeof doctor?.at, 'string');
  const scope = doctor?.scope as { dc?: string; org?: string; project?: string } | undefined;
  assert.equal(scope?.dc, 'in');
  assert.equal(scope?.org, ORG);
  assert.equal(scope?.project, PROJECT);
});

test('e2e: c2c doctor exists, is read-only, and persists c2c-out/.c2c/doctor.json', () => {
  const dir = tmp();
  const run = runC2c(['doctor'], dir);
  // A bare workspace must report failures (exit 1), not a usage error (2).
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stdout, /FAIL D-A1/);
  assert.match(run.stdout, /FAIL D-C1/);
  const doctorJson = join(dir, 'c2c-out', '.c2c', 'doctor.json');
  assert.ok(existsSync(doctorJson), 'doctor.json was not written');
  const file = JSON.parse(readFileSync(doctorJson, 'utf8')) as { green?: boolean; checks?: { id: string }[] };
  assert.equal(file.green, false);
  assert.ok(Array.isArray(file.checks));
});

test('e2e: a green doctor.json lets the gate proceed past the refusal', () => {
  const dir = tmp();
  writeDoctor(dir);
  // Past the gate the command reaches its own code and fails differently — but NOT with 5.
  const run = runC2c(['deploy', minimalDs, '--dc', 'in', '--org', ORG, '--project', PROJECT, '--confirm'], dir);
  assert.notEqual(run.code, 5, `gate refused anyway: ${run.stderr}`);
});

test('e2e: a doctor run for another org does not unlock this deploy', () => {
  const dir = tmp();
  writeDoctor(dir, { scope: { dc: 'in', org: '111111', project: '222222' } });
  const run = runC2c(['deploy', minimalDs, '--dc', 'in', '--org', ORG, '--project', PROJECT, '--confirm'], dir);
  assert.equal(run.code, 5, run.stderr);
  assert.match(run.stderr, /doctor is not green/);
});

// ---------- the gate must fail closed ----------

test('e2e B1: a scope the command cannot resolve refuses with 5', () => {
  // A green doctor must not unlock anything when scope resolution itself fails.
  {
    const dir = tmp();
    writeDoctor(dir);
    const run = runC2c(['deploy', minimalDs, '--dc', 'zz', '--org', ORG, '--project', PROJECT, '--confirm'], dir);
    assert.equal(run.code, 5, run.stderr);
    assert.match(run.stderr, /doctor is not green/);
  }
  {
    const dir = tmp();
    writeDoctor(dir);
    writeFileSync(join(dir, 'c2c-deploy.json'), JSON.stringify({ org: 'not-decimal' }));
    const run = runC2c(['deploy', minimalDs, '--dc', 'in', '--org', ORG, '--project', PROJECT, '--confirm'], dir);
    assert.equal(run.code, 5, run.stderr);
    assert.match(run.stderr, /doctor is not green/);
  }
  {
    const dir = tmp();
    writeDoctor(dir);
    const run = runC2c(['deploy', minimalDs, '--config', join(dir, 'missing.json'), '--org', ORG, '--project', PROJECT, '--confirm'], dir);
    assert.equal(run.code, 5, run.stderr);
    assert.match(run.stderr, /doctor is not green/);
  }
});

test('e2e B1: a missing dc/org/project field refuses, it is never skipped', () => {
  const dir = tmp();
  writeDoctor(dir);
  // No --dc anywhere and no config: the gate cannot compare dc → refuse.
  const noDc = runC2c(['deploy', minimalDs, '--org', ORG, '--project', PROJECT, '--confirm'], dir);
  assert.equal(noDc.code, 5, noDc.stderr);
  // A doctor.json without scope.project refuses even when the command names it.
  const dir2 = tmp();
  writeDoctor(dir2, { scope: { dc: 'in', org: ORG } });
  const run = runC2c(['deploy', minimalDs, '--dc', 'in', '--org', ORG, '--project', PROJECT, '--confirm'], dir2);
  assert.equal(run.code, 5, run.stderr);
});

test('e2e B2: an MCP record bound to another scope does not unlock this one', () => {
  const dir = tmp();
  // doctor.json claims this scope, but the D-B evidence was recorded for another org.
  writeDoctor(dir, { mcp: { server: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in', at: new Date().toISOString(), scope: { dc: 'in', org: '10000000001', project: '888' } } });
  const run = runC2c(['deploy', minimalDs, '--dc', 'in', '--org', ORG, '--project', PROJECT, '--confirm'], dir);
  assert.equal(run.code, 5, run.stderr);
  assert.match(run.stderr, /doctor is not green/);
});

test('e2e B3: green:true alone is not enough — the checks are recomputed', () => {
  for (const mutant of [
    { checks: [...REQUIRED_IDS.map((id) => ({ id, status: 'pass', detail: 'ok', fix: null })), { id: 'D-C3', status: 'fail', detail: 'x', fix: null }] },
    { checks: [] },
    { checks: [{ id: 'D-C1', status: 'pass', detail: 'ok', fix: null }] },
    { checks: REQUIRED_IDS.map((id) => ({ id, status: id === 'D-B7' ? 'skip' : 'pass', detail: 'ok', fix: null })) },
  ]) {
    const dir = tmp();
    writeDoctor(dir, mutant);
    const run = runC2c(['deploy', minimalDs, '--dc', 'in', '--org', ORG, '--project', PROJECT, '--confirm'], dir);
    assert.equal(run.code, 5, `${JSON.stringify(mutant).slice(0, 80)} passed the gate`);
    assert.match(run.stderr, /doctor is not green/);
  }
});

// ---------- an unbound MCP record never passes ----------

test('e2e: an MCP record without a bound scope refuses with 5', () => {
  const base = { server: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in', at: new Date().toISOString() };
  // The top-level scope claims this dc/org/project; only the `mcp` block differs.
  for (const [name, mcp] of [
    // Round-1-shaped: the pre-binding merge wrote `mcp` with no `scope`,
    // while the file's scope (and its carried-over project) still match.
    ['round-1 unbound record', { ...base }],
    // A hand-made green file with `mcp.scope` deleted.
    ['mcp.scope deleted', { ...base, transport: 'streamable-http', tools: ['Get_Project_By_Id'] }],
    // `mcp.scope: null`.
    ['mcp.scope null', { ...base, scope: null }],
    // `mcp.scope` bound to a partial scope (no project).
    ['mcp.scope partial', { ...base, scope: { dc: 'in', org: ORG } }],
  ] as const) {
    const dir = tmp();
    writeDoctor(dir, { mcp });
    const run = runC2c(['deploy', minimalDs, '--dc', 'in', '--org', ORG, '--project', PROJECT, '--confirm'], dir);
    assert.equal(run.code, 5, `${name} passed the gate`);
    assert.match(run.stderr, /doctor is not green/, name);
  }
  // The unbound cases also name the fix, not just the refusal.
  for (const mcp of [{ ...base }, { ...base, scope: null }]) {
    const dir = tmp();
    writeDoctor(dir, { mcp });
    const run = runC2c(['smoke', minimalDs, '--dc', 'in', '--project', PROJECT, '--org', ORG, '--confirm'], dir);
    assert.equal(run.code, 5, run.stderr);
    assert.match(run.stderr, /mcp record is not bound to a scope; re-record the MCP evidence \(c2c doctor --mcp-begin\)/);
  }
});

test('e2e: doctor --local --quiet stays silent and does not persist', () => {
  const dir = tmp();
  const run = runC2c(['doctor', '--local', '--quiet'], dir);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
  assert.ok(!existsSync(join(dir, 'c2c-out', '.c2c', 'doctor.json')), '--local must not write doctor.json');
});
