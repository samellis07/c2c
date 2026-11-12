/**
 * `c2c plan`, the provision dry-run (`c2c provision --status` / `--next`) and
 * the deploy dry-run (`c2c deploy` without --confirm) describe the same work.
 * For three synthetic apps, in both plan modes (new project and configured
 * project), every step the dry-runs name appears in the plan in the same
 * order with the same resources and human steps, and vice versa.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCli, sha256 } from '../src/offline-plan.js';
import { provisionCli, resolveTokens, type ProvisionPlanFile, type ProvisionState } from '../src/provision.js';
import { resolveProvisionScope } from '../src/provision-config.js';
import { deployCli, type Io } from '../src/cli.js';
import { repoRoot } from '../../core/src/toolchain.js';

const FORMS_ONLY = `application "Parity Forms"
{
  time zone = "Asia/Kolkata"
  form Booking
  {
    Subject
    (
      type = text
    )
    Opened
    (
      type = date
    )
  }
  list Open_Bookings
  {
    show all rows from Booking
  }
}
`;

const MAIL_SCHEDULE = `application "Parity Mail" {
  form Reminder {
    Note ( type = text )
  }
  workflow {
    schedule {
      Daily as "Daily" {
        type = schedule
        start = "2020-01-01 10:00:00"
        frequency = daily
        on start {
          actions {
            on load ( sendmail [ from: zoho.adminuserid to: "person@example.com" subject: "hi" message: "hi" ] )
          }
        }
      }
    }
  }
}
`;

const PROJECT = '1234567890';

function capture(): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const refuse = (what: string) => async () => {
    throw new Error(`dry-run parity attempted ${what}`);
  };
  return {
    io: { stdout: (text: string) => void (out += text), stderr: (text: string) => void (err += text), env: { PATH: process.env.PATH }, spawn: refuse('spawn'), fetch: refuse('fetch') } as Io,
    out: () => out,
    err: () => err,
  };
}

/** The `- …` or `N. …` lines of one plan.md section. */
function mdSection(md: string, heading: string): string[] {
  const lines = md.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${heading}`));
  assert.ok(start >= 0, `plan.md has no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== '');
}

/** The lines under a `<head>` line of the deploy plan, up to the next blank line. */
function block(text: string, head: RegExp): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => head.test(line));
  assert.ok(start >= 0, `deploy dry-run prints no ${head} block`);
  const rest = lines.slice(start + 1);
  const end = rest.indexOf('');
  return end < 0 ? rest : rest.slice(0, end);
}

function numbered(lines: readonly string[]): string[] {
  return lines.map((line, index) => {
    const match = /^(\d+)\. (.*)$/.exec(line);
    assert.ok(match, `not a numbered item: ${line}`);
    assert.equal(Number(match[1]), index + 1, `items are numbered 1..n: ${line}`);
    return match[2]!;
  });
}

interface Artifacts {
  /** plan.json steps */
  planJson: { id: string; via: string }[];
  /** provision/plan.json, as provision reads it */
  provisionPlan: ProvisionPlanFile;
  /** plan.md "Provision steps" lines */
  planMdSteps: string[];
  /** plan.md "Human steps" items */
  planMdHuman: string[];
  /** provision/tables.json */
  tables: { table: string; nosql: boolean; columns: { column_name: string; data_type: string }[] }[];
  /** provision --status on a fresh plan */
  status: string;
  /** provision --next on a fresh plan */
  next: { step: { id: string; via: string; tool?: string; command?: string } };
  /** provision --status and --next once every step is recorded */
  doneStatus: string;
  doneNext: { done: boolean; steps: number; checklist: string[] };
  /** c2c deploy without --confirm */
  deploy: string;
}

/** Record every step as existing, with the match hash provision itself computes. */
function allDoneState(out: string, args: readonly string[], plan: ProvisionPlanFile, state: ProvisionState): ProvisionState {
  const scope = resolveProvisionScope({ args, cwd: process.cwd(), app: plan.app, ...(plan.dc ? { planDc: plan.dc } : {}) });
  const inputs = JSON.parse(readFileSync(join(out, 'provision', 'inputs.json'), 'utf8')) as Record<string, unknown>;
  // provision reads the generated "" slateDomain placeholder as unfilled.
  if (inputs.slateDomain === '') delete inputs.slateDomain;
  const ctx = { out, plan, state, scope, inputs, io: capture().io, now: () => '2026-01-01T00:00:00.000Z' };
  const steps: ProvisionState['steps'] = {};
  for (const step of plan.steps) {
    const missing: string[] = [];
    const match = resolveTokens(step.readBack.match ?? {}, ctx as unknown as Parameters<typeof resolveTokens>[1], missing);
    const matchSha256 = missing.length ? `unresolved:${[...new Set(missing)].join(',')}` : sha256(JSON.stringify(match));
    steps[step.id] = { status: 'existing', at: ctx.now(), applied: false, matchSha256 } as ProvisionState['steps'][string];
  }
  return { ...state, steps };
}

async function collect(dsText: string, name: string, project: boolean): Promise<Artifacts> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plan-parity-'));
  try {
    const source = join(dir, name);
    writeFileSync(source, dsText);
    const out = join(dir, 'plan');
    const planArgs = [source, '--out', out, '--dc', 'in', ...(project ? ['--project', PROJECT] : [])];
    const plan = capture();
    assert.equal(await planCli(planArgs, plan.io), 0, plan.err());
    const provisionArgs = ['--out', out, '--dc', 'in', ...(project ? ['--project', PROJECT] : [])];
    const status = capture();
    assert.equal(await provisionCli([...provisionArgs, '--status'], status.io), 0, status.err());
    const next = capture();
    assert.equal(await provisionCli([...provisionArgs, '--next'], next.io), 0, next.err());
    // One real record writes provision/state.json (with the plan hash); the
    // rest of the steps are then marked existing the way a finished run would.
    const result = join(dir, 'sign-in.json');
    writeFileSync(result, '{"sign_in_page": true}\n');
    const record = capture();
    assert.equal(await provisionCli([...provisionArgs, '--record', 'sign-in-check', '--result', result], record.io), 0, record.err());
    const provisionPlan = JSON.parse(readFileSync(join(out, 'provision', 'plan.json'), 'utf8')) as ProvisionPlanFile;
    const statePath = join(out, 'provision', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as ProvisionState;
    writeFileSync(statePath, `${JSON.stringify(allDoneState(out, provisionArgs, provisionPlan, state), null, 2)}\n`);
    const doneStatus = capture();
    assert.equal(await provisionCli([...provisionArgs, '--status'], doneStatus.io), 0, doneStatus.err());
    assert.equal(doneStatus.err(), '', 'no step reopened');
    const doneNext = capture();
    assert.equal(await provisionCli([...provisionArgs, '--next'], doneNext.io), 0, doneNext.err());
    const deploy = capture();
    assert.equal(await deployCli([source, '--out', join(dir, 'deploy')], deploy.io), 0, deploy.err());
    const md = readFileSync(join(out, 'plan.md'), 'utf8');
    return {
      planJson: (JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')) as { steps: { id: string; via: string }[] }).steps,
      provisionPlan,
      planMdSteps: mdSection(md, 'Provision steps'),
      planMdHuman: numbered(mdSection(md, 'Human steps')),
      tables: JSON.parse(readFileSync(join(out, 'provision', 'tables.json'), 'utf8')) as Artifacts['tables'],
      status: status.out(),
      next: JSON.parse(next.out()) as Artifacts['next'],
      doneStatus: doneStatus.out(),
      doneNext: JSON.parse(doneNext.out()) as Artifacts['doneNext'],
      deploy: deploy.out(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every parity rule; throws an AssertionError naming the first mismatch. */
function assertParity(a: Artifacts): void {
  const planned = a.planJson.map((step) => `${step.id} [${step.via}]`);
  // plan.json, provision/plan.json and plan.md list the same steps in the same order.
  assert.deepEqual(a.provisionPlan.steps.map((step) => `${step.id} [${step.via}]`), planned, 'provision/plan.json steps match plan.json');
  assert.deepEqual(a.planMdSteps.map((line) => /^- (\S+ \[\w+\])/.exec(line)?.[1]), planned, 'plan.md "Provision steps" match plan.json');

  // The provision dry-run walks exactly the planned steps, in plan order.
  const statusSteps = a.status
    .split('\n')
    .map((line) => /^- (\S+ \[\w+\]) pending$/.exec(line)?.[1])
    .filter((step): step is string => step !== undefined);
  assert.deepEqual(statusSteps, planned, 'provision --status lists the planned steps in order');
  assert.match(a.status, new RegExp(`^done: 0/${planned.length}$`, 'm'));
  assert.equal(`${a.next.step.id} [${a.next.step.via}]`, planned[0], 'provision --next starts at the first planned step');
  const first = a.provisionPlan.steps[0]!;
  assert.equal(a.next.step.tool, first.tool, 'provision --next names the planned tool');
  assert.equal(a.next.step.command === undefined, first.command === undefined, 'provision --next carries the planned command');

  // Human steps: the plan names the list a finished provision prints, item for item.
  assert.match(a.doneStatus, new RegExp(`^done: ${planned.length}/${planned.length}$`, 'm'));
  assert.deepEqual(numbered(a.doneStatus.split('human checklist:\n')[1]!.trim().split('\n')), a.planMdHuman, 'provision --status checklist matches plan.md human steps');
  assert.equal(a.doneNext.done, true);
  assert.equal(a.doneNext.steps, planned.length);
  assert.deepEqual(a.doneNext.checklist, a.planMdHuman, 'provision --next checklist matches plan.md human steps');
  assert.ok(a.planMdHuman.length <= 4, 'at most the four customer steps');
  const ids = new Set(a.planJson.map((step) => step.id));
  assert.equal(a.planMdHuman.some((item) => item.startsWith('Verify mail sender:')), ids.has('mail-sender'), 'mail human step iff the mail-sender step');

  // Resources: the deploy dry-run creates exactly the planned tables and columns, in order.
  const createLines = block(a.deploy, /^table-create /).filter((line) => /^- (create|skip nosql) /.test(line));
  const plannedCreates = a.tables.flatMap((table) => {
    if (table.nosql) return [`- skip nosql ${table.table} `];
    const foreignOnly = table.columns.length > 0 && table.columns.every((column) => column.data_type === 'foreign key');
    return [
      ...(foreignOnly ? [] : [`- create table ${table.table} if missing`]),
      ...table.columns.map((column) => `- create column ${table.table}.${column.column_name} data_type=${column.data_type}`),
    ];
  });
  assert.deepEqual(
    createLines.map((line, index) => (plannedCreates[index] !== undefined && line.startsWith(plannedCreates[index]!) ? plannedCreates[index] : line)),
    plannedCreates,
    'deploy dry-run table-create matches provision/tables.json',
  );
  assert.deepEqual(
    block(a.deploy, /^tables:$/).filter((line) => line.startsWith('- ')).map((line) => line.slice(2).split(' ')[0]).sort(),
    // tables.json repeats a table for its foreign-key pass; the deploy lists each table once.
    [...new Set(a.tables.map((table) => table.table))].sort(),
    'deploy dry-run tables match the planned tables',
  );
  if (ids.has('tables')) {
    const step = a.provisionPlan.steps.find((item) => item.id === 'tables')!;
    // The read-back is a set match: the same tables, in any order.
    const match = step.readBack.match as { table_name: string[] };
    assert.deepEqual([...match.table_name].sort(), [...new Set(a.tables.filter((table) => !table.nosql).map((table) => table.table))].sort(), 'the tables step reads back the planned tables');
  }

  // The Slate client the deploy ships is planned: its gate, its domain and the sign-in check.
  const commands = block(a.deploy, /^commands /);
  const deploysSlate = commands.some((line) => / slate:link /.test(line)) && commands.some((line) => / deploy slate /.test(line));
  for (const id of ['authorized-domain', 'sign-in-check']) {
    assert.equal(ids.has(id), deploysSlate, `plan step ${id} iff the deploy dry-run deploys Slate`);
  }
  assert.equal(ids.has('slate-enable'), false, 'Slate needs no first-use console gate');
  const postDeploy = block(a.deploy, /^post-deploy /);
  assert.equal(postDeploy.some((line) => line.startsWith('- Sign-in check:')), ids.has('sign-in-check'), 'the deploy sign-in check is the planned sign-in-check step');
  assert.equal(
    postDeploy.some((line) => line.includes('Security Rules')),
    ids.has('security-rule') || ids.has('import-security-rule'),
    'the deploy security-rule step is planned',
  );
}

const root = repoRoot();
const APPS: { name: string; file: string; ds: () => string; mail: boolean }[] = [
  { name: 'forms-only app (no Creator pages)', file: 'parity_forms.ds', ds: () => FORMS_ONLY, mail: false },
  { name: 'scheduled mail app', file: 'parity_mail.ds', ds: () => MAIL_SCHEDULE, mail: true },
  { name: 'kitchen-sink app', file: 'kitchen_sink.ds', ds: () => readFileSync(join(root, 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds'), 'utf8'), mail: false },
];

for (const app of APPS) {
  for (const project of [false, true]) {
    test(`plan and the provision/deploy dry-runs agree: ${app.name}, ${project ? 'configured project' : 'new project'}`, async () => {
      const artifacts = await collect(app.ds(), app.file, project);
      assertParity(artifacts);
      assert.equal(artifacts.planMdHuman.some((item) => item.startsWith('Verify mail sender:')), app.mail, 'the mail human step follows the app');
    });
  }
}

test('the parity check catches a dropped, reordered or extra step and a drifted human step', async () => {
  const good = await collect(FORMS_ONLY, 'parity_forms.ds', false);
  assertParity(good);
  const clone = (): Artifacts => structuredClone(good);
  const mutations: [string, (a: Artifacts) => void][] = [
    ['plan.md drops a step', (a) => void a.planMdSteps.pop()],
    ['plan.json reorders steps', (a) => void a.planJson.reverse()],
    ['provision runs an unplanned step', (a) => void (a.status += '- extra-step [cli] pending\n')],
    ['plan wrongly adds a Slate gate', (a) => void a.planJson.unshift({ id: 'slate-enable', via: 'console' })],
    ['plan.md loses a human step', (a) => void a.planMdHuman.pop()],
    ['provision prints a different checklist', (a) => void (a.doneNext.checklist = [...a.doneNext.checklist, 'Extra: a sixth step'])],
    ['deploy creates an unplanned column', (a) => void (a.deploy = a.deploy.replace(/^- iac:import/m, '- create column Booking.Extra data_type=varchar max_length=255 if missing\n- iac:import'))],
    ['plan has no tables the deploy creates', (a) => void (a.tables = a.tables.slice(1))],
  ];
  for (const [what, mutate] of mutations) {
    const bad = clone();
    mutate(bad);
    assert.throws(() => assertParity(bad), assert.AssertionError, what);
  }
});
