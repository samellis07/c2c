/**
 * Offline schema-change runner: change the app later without losing data.
 *
 * Deploys an app to the in-process Catalyst harness (the generated c2c_api
 * function over the offline SDK stand-in), seeds rows through the API, then
 * applies a sequence of Creator-side changes to a copy of the .ds. Each change
 * goes through `c2c plan --previous`, the schema delta is applied to the
 * harness store, and the new tree is redeployed and read back. Additive
 * changes must keep every row and value; a drop or rename must be refused
 * without --allow-destructive and a verified backup, and the backup must exist
 * before the store changes. Anything c2c cannot do yet is a counted gap.
 * Nothing here opens a socket beyond 127.0.0.1 or reads a credential.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { generateSchema, type SchemaColumn, type SchemaTable } from '../../schema/src/generator.js';
import { deployCli, loadApp, type Io } from './cli.js';
import { applySchemaDelta, modelPlan, planDelta, type StoreDriver } from './delta.js';
import type { FieldRename } from './edit.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from './guards.js';
import { parseCsv } from './csv.js';
import { planCli } from './offline-plan.js';
import { deployFiles, writeDeployTree } from './plan.js';
import { rollbackBackupProblem, rollbackExport, STORE_SYSTEM_COLUMNS } from './rollback.js';

const ORG = '10000000000';
const DC = 'in';
const SESSION = 'c2c-schema-change';

export interface SchemaChange {
  id: string;
  title: string;
  kind: 'additive' | 'destructive';
  /** Rewrites the previous .ds text into the re-export. Throws when the anchor is missing. */
  apply(ds: string): string;
  renames?: FieldRename[];
}

export interface ScenarioResult {
  id: string;
  title: string;
  kind: SchemaChange['kind'];
  status: 'PASS' | 'FAIL';
  evidence: string[];
  /** Seeded values neither in the store nor in a verified backup. Must be empty. */
  lost: string[];
  rows: { before: Record<string, number>; after: Record<string, number> };
}

export interface SchemaChangeGap {
  id: string;
  scenario: string;
  detail: string;
}

export interface SchemaChangeReport {
  schema: 'c2c-scorecard-d12/1';
  app: string;
  scenarios: ScenarioResult[];
  gaps: SchemaChangeGap[];
  summary: { pass: number; fail: number; gaps: number };
}

type Row = Record<string, unknown>;

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Row[]> };
}

function replaceOnce(text: string, pattern: RegExp, by: string, what: string): string {
  if (!pattern.test(text)) throw new Error(`schema change anchor not found: ${what}`);
  return text.replace(pattern, by);
}

/** The library sequence: add field, add form, picklist add and remove, rename field, delete field. */
export const LIBRARY_CHANGES: readonly SchemaChange[] = [
  {
    id: 'add-field',
    title: 'add field Book.Shelf_Code',
    kind: 'additive',
    apply: (ds) =>
      replaceOnce(ds, /^(\t+)Mark_as_Featured$/m, '$1Shelf_Code\n$1(\n$1\ttype = text\n$1\tdisplayname = "Shelf Code"\n$1)\n$1Mark_as_Featured', 'Book.Mark_as_Featured'),
  },
  {
    id: 'add-form',
    title: 'add form Branch',
    kind: 'additive',
    apply: (ds) =>
      replaceOnce(ds, /^(\t+)form Member_Info$/m, '$1form Branch\n$1{\n$1\tBranch_Name\n$1\t(\n$1\t\ttype = text\n$1\t\tdisplayname = "Branch Name"\n$1\t)\n$1}\n$1form Member_Info', 'form Member_Info'),
  },
  {
    id: 'picklist-add',
    title: 'add choice "Poetry" to Book.Genre',
    kind: 'additive',
    apply: (ds) => replaceOnce(ds, /values = \{"Sci-Fi","Biography","Non-Fiction","Fiction"\}/, 'values = {"Sci-Fi","Biography","Non-Fiction","Fiction","Poetry"}', 'Book.Genre values'),
  },
  {
    id: 'picklist-remove',
    title: 'remove choice "Biography" from Book.Genre (a seeded row holds it)',
    kind: 'additive',
    apply: (ds) => replaceOnce(ds, /values = \{"Sci-Fi","Biography","Non-Fiction","Fiction","Poetry"\}/, 'values = {"Sci-Fi","Non-Fiction","Fiction","Poetry"}', 'Book.Genre values'),
  },
  {
    id: 'rename-field',
    title: 'rename field Book.Author -> Writer',
    kind: 'destructive',
    apply: (ds) => replaceOnce(ds, /^(\s+)Author(\s*)$/gm, '$1Writer$2', 'Book.Author'),
    renames: [{ form: 'Book', from: 'Author', to: 'Writer' }],
  },
  {
    id: 'delete-field',
    title: 'delete field Book.Rating',
    kind: 'destructive',
    apply: (ds) =>
      replaceOnce(
        replaceOnce(ds, /^\t+Rating\n\t+\(\n(?:[^\n]*\n)*?\t+\)\n/m, '', 'Book.Rating field'),
        /^\s+Rating as "Rating \(1-5\)"\n/gm,
        '',
        'Book.Rating report columns',
      ),
  },
];

/** Library seed rows: one holds the choice the picklist-remove step drops. */
export const LIBRARY_SEED: readonly { form: string; record: Row }[] = [
  { form: 'Book', record: { Title: 'Dune', Author: 'Frank Herbert', Genre: 'Sci-Fi', Publication_Year: 1965, Rating: 5 } },
  { form: 'Book', record: { Title: 'Long Walk', Author: 'Nelson Mandela', Genre: 'Biography', Publication_Year: 1994, Rating: 4 } },
  { form: 'Book', record: { Title: 'Emma', Author: 'Jane Austen', Genre: 'Fiction', Publication_Year: 1815, Rating: 3 } },
];

function guardFor(app: App): GuardOk {
  return {
    org: ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: DC,
    registry: { org: ORG, env: 'Development', projects: {}, dc: DC },
  };
}

/** An Io that refuses any network or process: the runner is offline. */
function offlineIo(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    spawn: () => {
      throw new Error('schema-change runner: no process spawn offline');
    },
    fetch: () => Promise.reject(new Error('schema-change runner: no network offline')),
  } as Io & { out: string[]; err: string[] };
}

/** The in-process harness: one deployed c2c_api at a time over the shared offline SDK. */
class Harness {
  private server: Server | undefined;
  private port = 0;
  readonly sdk: FakeSdk;
  private readonly restore: () => void;
  readonly columns = new Map<string, string[]>();

  constructor(private readonly sdkPath: string) {
    const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
    const original = moduleAny._resolveFilename;
    moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
      if (request === 'zcatalyst-sdk-node') return sdkPath;
      return original.call(this, request, ...rest);
    };
    this.restore = () => {
      moduleAny._resolveFilename = original;
    };
    this.sdk = createRequire(import.meta.url)(sdkPath) as FakeSdk;
    for (const rows of Object.values(this.sdk.state().tables)) rows.splice(0);
    this.sdk.setSession(SESSION, { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
  }

  tables(): Record<string, Row[]> {
    return this.sdk.state().tables;
  }

  async deploy(app: App, dir: string): Promise<void> {
    await this.stop();
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    const entry = createRequire(import.meta.url)(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    this.server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${this.port}/server/c2c_api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `c2c-harness-session=${SESSION}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = { raw };
    }
    return { status: res.status, body: parsed };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  async close(): Promise<void> {
    await this.stop();
    this.restore();
  }

  /** A StoreDriver over the harness tables; column lists are tracked beside the rows. */
  driver(): StoreDriver {
    const rows = (table: string) => this.tables()[table] ?? [];
    const filled = (value: unknown) => value !== undefined && value !== null && value !== '';
    return {
      columns: async (table) => this.columns.get(table)?.slice(),
      rowCount: async (table) => rows(table).length,
      valueCount: async (table, column) => rows(table).filter((row) => filled(row[column])).length,
      createTable: async (table: SchemaTable) => {
        this.columns.set(table.name, table.columns.map((c) => c.name));
      },
      addColumn: async (table: string, column: SchemaColumn) => {
        this.columns.get(table)!.push(column.name);
      },
      renameColumn: async (table, from, to) => {
        this.columns.set(table, this.columns.get(table)!.map((c) => (c === from ? to : c)));
        for (const row of rows(table)) {
          if (from in row) {
            row[to] = row[from];
            delete row[from];
          }
        }
      },
      alterColumn: async () => {},
      dropColumn: async (table, column) => {
        this.columns.set(table, this.columns.get(table)!.filter((c) => c !== column));
        for (const row of rows(table)) delete row[column];
      },
      dropTable: async (table) => {
        this.columns.delete(table);
        rows(table).splice(0);
      },
    };
  }
}

function snapshot(tables: Record<string, Row[]>): Map<string, Map<string, Row>> {
  const out = new Map<string, Map<string, Row>>();
  for (const [table, list] of Object.entries(tables)) {
    out.set(table, new Map(list.map((row) => [String(row.ROWID), { ...row }])));
  }
  return out;
}

function counts(snap: Map<string, Map<string, Row>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, rows] of [...snap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) if (rows.size) out[table] = rows.size;
  return out;
}

/** Per table, per ROWID, the exported cell of each column (header = field name). */
type BackupCells = Map<string, Map<string, Map<string, string>>>;

/**
 * Read a rollback export back: import/<Form>.csv row i is ids/<Form>.ids.csv
 * row i, which carries the store ROWID.
 */
function backupCells(app: App, files: readonly { path: string; body: string }[]): BackupCells {
  const out: BackupCells = new Map();
  const body = new Map(files.map((file) => [file.path, file.body]));
  for (const table of generateSchema(app).tables) {
    if (table.role !== 'form') continue;
    const data = body.get(`import/${table.form}.csv`);
    const ids = body.get(`ids/${table.form}.ids.csv`);
    if (!data || !ids) continue;
    const [header, ...rows] = parseCsv(data);
    const [idHeader, ...idRows] = parseCsv(ids);
    const rowidAt = idHeader!.indexOf('ROWID');
    const cells = new Map<string, Map<string, string>>();
    rows.forEach((row, i) => {
      const rowid = idRows[i]?.[rowidAt];
      if (rowid) cells.set(rowid, new Map(header!.map((name, j) => [name, row[j] ?? ''])));
    });
    out.set(table.name, cells);
  }
  return out;
}

/**
 * Seeded values that the store no longer holds (under the same or the renamed
 * column), unless the delta drops that column and the verified backup holds the value.
 */
function lostValues(before: Map<string, Map<string, Row>>, after: Map<string, Map<string, Row>>, renames: readonly { table: string; from: string; to: string }[], dropped: ReadonlySet<string>, backup: BackupCells | undefined): string[] {
  const lost: string[] = [];
  for (const [table, rows] of before) {
    for (const [rowid, row] of rows) {
      const now = after.get(table)?.get(rowid);
      for (const [column, value] of Object.entries(row)) {
        if (STORE_SYSTEM_COLUMNS.has(column) || value === undefined || value === null || value === '') continue;
        const moved = renames.find((r) => r.table === table && r.from === column)?.to ?? column;
        if (now && now[moved] === value) continue;
        // Only a column the delta drops may leave the store, and only into the backup.
        if (dropped.has(`${table}.${column}`) && backup?.get(table)?.get(rowid)?.get(column) === String(value)) continue;
        lost.push(`${table}.${column} row ${rowid}: ${JSON.stringify(value)}${now ? '' : ' (row gone)'}`);
      }
    }
  }
  return lost;
}

export interface RunOptions {
  /** The deployed .ds. */
  ds: string;
  /** Scratch directory for the copies, plans, deploy trees and backups. */
  workDir: string;
  /** Path to the offline SDK stand-in (tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs). */
  sdkPath: string;
  changes?: readonly SchemaChange[];
  seed?: readonly { form: string; record: Row }[];
  /** Fault injection for the runner's own tests: wrap the store driver. */
  wrapDriver?: (driver: StoreDriver) => StoreDriver;
  /** Fault injection: apply destructive changes without taking the backup first. */
  skipBackup?: boolean;
}

export async function runSchemaChangeScenarios(opts: RunOptions): Promise<SchemaChangeReport> {
  const changes = opts.changes ?? LIBRARY_CHANGES;
  const seed = opts.seed ?? LIBRARY_SEED;
  mkdirSync(opts.workDir, { recursive: true });
  let prevPath = join(opts.workDir, '0-deployed', 'app.ds');
  mkdirSync(dirname(prevPath), { recursive: true });
  let prevText = readFileSync(opts.ds, 'utf8');
  writeFileSync(prevPath, prevText);
  let prev = loadApp(prevPath);
  const harness = new Harness(opts.sdkPath);
  const scenarios: ScenarioResult[] = [];
  const gaps: SchemaChangeGap[] = [];
  try {
    await harness.deploy(prev, join(opts.workDir, '0-deployed', 'tree'));
    for (const table of generateSchema(prev).tables) harness.columns.set(table.name, table.columns.map((c) => c.name));
    for (const { form, record } of seed) {
      const res = await harness.post(`/forms/${form}/submit`, { record });
      if (res.status !== 200) throw new Error(`seed ${form} failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const driver = opts.wrapDriver ? opts.wrapDriver(harness.driver()) : harness.driver();

    for (const [index, change] of changes.entries()) {
      const dir = join(opts.workDir, `${index + 1}-${change.id}`);
      mkdirSync(dir, { recursive: true });
      const evidence: string[] = [];
      let ok = true;
      const check = (cond: boolean, line: string) => {
        evidence.push(`${cond ? 'ok' : 'FAIL'}: ${line}`);
        if (!cond) ok = false;
      };
      const before = snapshot(harness.tables());
      const nextText = change.apply(prevText);
      const nextPath = join(dir, 'app.ds');
      writeFileSync(nextPath, nextText);
      const next = loadApp(nextPath);
      const renameArgs = (change.renames ?? []).flatMap((r) => ['--rename', `${r.form}.${r.from}=${r.to}`]);
      const plan = async (extra: string[]) => {
        const io = offlineIo();
        const code = await planCli([nextPath, '--out', join(dir, 'plan'), '--dc', DC, '--previous', prevPath, '--allow-budget-fail', ...renameArgs, ...extra], io);
        return { code, out: io.out.join(''), err: io.err.join('') };
      };
      let backup: BackupCells | undefined;
      const delta = planDelta(modelPlan(prev, DC), modelPlan(next, DC), { app: next.name || 'app', edits: [], renames: change.renames ?? [] });
      const schemaOps = [...delta.tables.map((t) => `${t.op} table ${t.table}`), ...delta.columns.map((c) => (c.op === 'rename' ? `rename ${c.table}.${c.from}->${c.to}` : `${c.op} ${c.table}.${'column' in c ? c.column : ''}`))];
      evidence.push(`schema delta: ${schemaOps.length ? schemaOps.join(', ') : 'none'}`);
      let backedUp: Set<string> | undefined;

      if (change.kind === 'additive') {
        const first = await plan([]);
        check(first.code === 0, `c2c plan --previous exits 0 without --allow-destructive (exit ${first.code}${first.err ? `: ${first.err.trim().split('\n')[0]}` : ''})`);
        for (const line of first.out.split('\n').filter((l) => l.startsWith('note: '))) evidence.push(`plan ${line}`);
      } else {
        const refused = await plan([]);
        check(refused.code === 1 && /next steps:/.test(refused.err) && /c2c rollback-export/.test(refused.err), `c2c plan --previous refuses without --allow-destructive and names the next step (exit ${refused.code})`);
        const noBackup = await plan(['--allow-destructive']);
        check(noBackup.code === 1 && /needs --backup/.test(noBackup.err), `--allow-destructive alone is refused: a backup is required (exit ${noBackup.code})`);
        const bogus = join(dir, 'not-a-backup');
        mkdirSync(bogus, { recursive: true });
        const badBackup = await plan(['--allow-destructive', '--backup', bogus]);
        check(badBackup.code === 1 && /not a verified export|no readable/.test(badBackup.err), `an unverified --backup is refused (exit ${badBackup.code})`);
        const backupDir = join(dir, 'backup');
        if (!opts.skipBackup) {
          const rows = new Map(Object.entries(harness.tables()).map(([table, list]) => [table, list.map((row) => ({ ...row }))]));
          const exported = rollbackExport(prev, rows);
          for (const file of [...exported.files, exported.manifest]) {
            const path = join(backupDir, file.path);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, file.body);
          }
          backup = backupCells(prev, exported.files);
          backedUp = new Set(Object.keys((JSON.parse(exported.manifest.body) as { tables: Record<string, string> }).tables));
        }
        const problem = rollbackBackupProblem(backupDir, prev);
        check(problem === undefined, `a verified rollback export exists before the store changes${problem ? ` (${problem})` : ` (${backupDir})`}`);
        const allowed = await plan(['--allow-destructive', '--backup', backupDir]);
        check(allowed.code === 0, `c2c plan --previous --allow-destructive --backup exits 0 (exit ${allowed.code}${allowed.err ? `: ${allowed.err.trim().split('\n')[0]}` : ''})`);
        const deployIo = offlineIo();
        const deployCode = await deployCli([nextPath, '--previous', prevPath, '--dc', DC, ...renameArgs], deployIo);
        const refusal = deployIo.err.join('').split('\n').filter((l) => l.startsWith('- '));
        evidence.push(`c2c deploy --previous (live table step) exit ${deployCode}${refusal.length ? `: ${refusal.join('; ')}` : ''}`);
        if (deployCode !== 0) for (const line of refusal) gaps.push({ id: `live-${change.id}`, scenario: change.id, detail: line.slice(2) });
      }

      if (ok) {
        try {
          const applied = await applySchemaDelta(delta, generateSchema(next), driver, { confirm: change.kind === 'destructive', ...(backedUp ? { backedUp } : {}) });
          evidence.push(`store delta applied: ${applied.applied.length ? applied.applied.join(', ') : 'nothing to change'}${applied.skipped.length ? `; skipped: ${applied.skipped.join(', ')}` : ''}`);
        } catch (err) {
          check(false, `store delta: ${err instanceof Error ? err.message : String(err)}`);
        }
        await harness.deploy(next, join(dir, 'tree'));
        const sample = [...(before.get('Book')?.keys() ?? [])][0];
        if (sample) {
          const read = await harness.post('/forms/Book/record', { ROWID: sample });
          check(read.status === 200, `redeployed c2c_api reads Book row ${sample} back (HTTP ${read.status})`);
        }
      }
      const after = snapshot(harness.tables());
      const renamed = delta.columns.flatMap((c) => (c.op === 'rename' ? [{ table: c.table, from: c.from, to: c.to }] : []));
      const dropped = new Set(delta.columns.flatMap((c) => (c.op === 'drop' ? [`${c.table}.${c.column}`] : [])));
      const lost = lostValues(before, after, renamed, dropped, backup);
      check(lost.length === 0, `no seeded value lost (rows ${JSON.stringify(counts(before))} -> ${JSON.stringify(counts(after))})`);
      scenarios.push({ id: change.id, title: change.title, kind: change.kind, status: ok ? 'PASS' : 'FAIL', evidence, lost, rows: { before: counts(before), after: counts(after) } });
      if (change.id === 'picklist-remove') {
        gaps.push({ id: 'picklist-stored-values', scenario: change.id, detail: 'a removed choice is reported as a plan note; c2c does not list or remap the stored rows that still hold it' });
      }
      if (ok) {
        prevText = nextText;
        prevPath = nextPath;
        prev = next;
      }
    }
  } finally {
    await harness.close();
  }
  gaps.push({ id: 'deployed-model-not-recorded', scenario: '*', detail: 'the deploy state keeps a bundle digest, not the deployed model: the operator must pass the deployed .ds as --previous' });
  gaps.push({ id: 'creator-rename-undetectable', scenario: 'rename-field', detail: 'a .ds re-export carries no rename record: without --rename Form.Old=New a renamed field reads as a drop plus an add' });
  const pass = scenarios.filter((s) => s.status === 'PASS').length;
  return { schema: 'c2c-scorecard-d12/1', app: prev.name || 'app', scenarios, gaps, summary: { pass, fail: scenarios.length - pass, gaps: gaps.length } };
}

export function formatSchemaChangeReport(report: SchemaChangeReport): string {
  const lines = [`# D12 schema change + redeploy (offline): ${report.app}`, '', `PASS ${report.summary.pass}, FAIL ${report.summary.fail}, gaps ${report.summary.gaps}`, ''];
  lines.push('| # | Scenario | Kind | Result | Rows before -> after | Lost values |', '|---|---|---|---|---|---|');
  for (const [i, s] of report.scenarios.entries()) {
    lines.push(`| ${i + 1} | ${s.title} | ${s.kind} | ${s.status} | ${JSON.stringify(s.rows.before)} -> ${JSON.stringify(s.rows.after)} | ${s.lost.length} |`);
  }
  for (const s of report.scenarios) {
    lines.push('', `## ${s.id}: ${s.status}`, '', ...s.evidence.map((e) => `- ${e}`), ...s.lost.map((l) => `- lost: ${l}`));
  }
  lines.push('', '## Gaps (counted)', '', ...report.gaps.map((g, i) => `${i + 1}. ${g.id} (${g.scenario}): ${g.detail}`), '');
  return lines.join('\n');
}
