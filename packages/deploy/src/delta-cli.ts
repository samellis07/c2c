/**
 * `c2c sync-delta` and `c2c rollback-export`. Both plan by default and touch
 * the project only with --confirm, behind the same org, project and data
 * centre guards as migrate-data.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { generateSchema } from '../../schema/src/generator.js';
import { assertLiveProject, fail, flag, loadApp, planGuard, prepareGuard, resolveScope, STATE_FILE, type Io } from './cli.js';
import { readSourceBackup } from './backup.js';
import { readSourceCsv, readSourceJson, type CsvLoad } from './csv.js';
import { catalystBaseFor } from './dc.js';
import {
  applyDelta,
  computeDelta,
  deltaTotals,
  formatConflict,
  formatDeltaPlan,
  MAX_DELETE_PERCENT,
  parseDeltaCheckpoint,
  withDeletionsApplied,
  withStoreFingerprints,
  type ConflictResolver,
  type ConflictSide,
  type DeltaCheckpoint,
  type DeltaConflict,
} from './row-delta.js';
import { GuardError, planScopeLines } from './guards.js';
import { parseStoreRows, readStoreRows, rollbackExport } from './rollback.js';

export type DeltaSourceReader = (path: string, app: App, allowEmpty: boolean) => CsvLoad;

/** Source kinds sync-delta reads, each passed as `--source-<kind> <path>`. */
export const DELTA_SOURCES: Record<string, DeltaSourceReader> = {
  json: readSourceJson,
  csv: readSourceCsv,
  backup: readSourceBackup,
};

export function deltaSource(args: readonly string[]): { kind: string; path: string } | undefined {
  const found = Object.keys(DELTA_SOURCES).filter((kind) => args.includes(`--source-${kind}`));
  if (found.length > 1) throw new GuardError('configuration', `pass one of ${Object.keys(DELTA_SOURCES).map((kind) => `--source-${kind}`).join(', ')}`);
  const kind = found[0];
  if (!kind) return undefined;
  const path = flag(args, `--source-${kind}`);
  if (!path) throw new GuardError('configuration', `--source-${kind} needs a value`);
  return { kind, path };
}

/** --since names the project's state file, or the folder that holds it. */
export function stateFilePath(since: string): string {
  return statSync(since, { throwIfNoEntry: false })?.isDirectory() ? join(since, STATE_FILE) : since;
}

export function readStateFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${STATE_FILE} is not an object`);
  return parsed as Record<string, unknown>;
}

export function readDeltaCheckpoint(path: string): DeltaCheckpoint | undefined {
  return parseDeltaCheckpoint(readStateFile(path).delta);
}

function writeState(path: string, patch: Record<string, unknown>): void {
  const state = readStateFile(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...state, ...patch }, null, 2)}\n`);
}

function writeDeltaCheckpoint(path: string, checkpoint: DeltaCheckpoint): void {
  writeState(path, { delta: checkpoint });
}

/** State-file key of the last conflict check: what `c2c proof` lists. Values are hashes, never the cells. */
export const CONFLICTS_KEY = 'deltaConflicts';

export interface ConflictRecord {
  /** Checkpoint the conflicts were found against. */
  since?: string;
  conflicts: DeltaConflict[];
}

export function readConflictRecord(state: Record<string, unknown>): ConflictRecord | undefined {
  const value = state[CONFLICTS_KEY];
  if (!value || typeof value !== 'object' || !Array.isArray((value as ConflictRecord).conflicts)) return undefined;
  return value as ConflictRecord;
}

function side(value: string, where: string): ConflictSide {
  if (value === 'creator' || value === 'catalyst') return value;
  throw new GuardError('configuration', `${where} must be creator or catalyst`);
}

/**
 * The conflict resolver from --prefer and --conflicts. `--prefer creator|catalyst`
 * covers every table, `--prefer <Table>=creator|catalyst` one table (repeatable),
 * and a --conflicts JSON file `{ "<Table>": { "<source id>": "creator"|"catalyst" } }`
 * single records; a record entry wins over its table, a table over the default.
 */
export function conflictResolver(args: readonly string[]): { resolve?: ConflictResolver; describe: string } {
  let all: ConflictSide | undefined;
  const tables = new Map<string, ConflictSide>();
  args.forEach((arg, index) => {
    if (arg !== '--prefer') return;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new GuardError('configuration', '--prefer needs creator, catalyst or <Table>=creator|catalyst');
    const eq = value.indexOf('=');
    if (eq < 0) {
      const chosen = side(value, '--prefer');
      if (all && all !== chosen) throw new GuardError('configuration', '--prefer is given twice with different sides');
      all = chosen;
      return;
    }
    const table = value.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new GuardError('configuration', `--prefer ${value}: the table name is not valid`);
    tables.set(table, side(value.slice(eq + 1), `--prefer ${table}`));
  });
  const records = new Map<string, Map<string, ConflictSide>>();
  const file = flag(args, '--conflicts');
  if (args.includes('--conflicts') && !file) throw new GuardError('configuration', '--conflicts needs a file');
  if (file) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GuardError('configuration', '--conflicts file must be an object of tables');
    for (const [table, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new GuardError('configuration', `--conflicts file: ${table} must map source ids to creator or catalyst`);
      records.set(table, new Map(Object.entries(entries as Record<string, unknown>).map(([id, value]) => [id, side(String(value), `--conflicts file ${table}.${id}`)])));
    }
  }
  const parts = [
    ...(all ? [`--prefer ${all}`] : []),
    ...[...tables].sort(([a], [b]) => (a < b ? -1 : 1)).map(([table, value]) => `--prefer ${table}=${value}`),
    ...(file ? [`--conflicts file (${[...records.values()].reduce((sum, map) => sum + map.size, 0)} record(s))`] : []),
  ];
  if (!parts.length) return { describe: 'none (any conflict refuses --confirm)' };
  return { resolve: (table, sourceId) => records.get(table)?.get(sourceId) ?? tables.get(table) ?? all, describe: parts.join(', ') };
}

const SYNC_USAGE =
  'usage: c2c sync-delta --source-json <dir> --ds <file|dir> --since <state-file|dir> [--project <id>] [--org <id>] [--app <link>] [--confirm] [--apply-deletes] [--allow-mass-delete] [--max-delete-percent <pct>] [--allow-empty] [--catalyst-base <url>] [--dc <dc>] [--config <c2c-deploy.json>] [--projects <file>]\n' +
  '       c2c sync-delta --source-csv <dir> --ds <file|dir> --since <state-file|dir> [same options]\n' +
  '       c2c sync-delta --source-backup <zip|dir> --ds <file|dir> --since <state-file|dir> [same options]\n' +
  '       Plans by default: new, changed, unchanged and deleted records per table against the checkpoint in the state file.\n' +
  '       --confirm upserts by source id and records the new checkpoint. Deletions are applied only with --apply-deletes,\n' +
  '       and only for a table the source proves complete: a backup, or a report export matching a counts.json of each\n' +
  '       form\'s total record count — never a filtered report\'s count. A subform child or junction table needs its\n' +
  '       own counts.json entry ("<Form>__<Subform>": <total> for a child, "<Form>__<Lookup>": <total> for a junction)\n' +
  '       or a backup — the parent forms\' counts never cover it. A backup that drops a generated-table row proves\n' +
  '       that table complete no better than a report.\n' +
  `       Deleting over ${MAX_DELETE_PERCENT}% of a table's remembered records also needs --allow-mass-delete.\n` +
  '       Before --confirm writes, every changed or deleted record is checked against the store: a row also edited in the\n' +
  '       new app since the last sync is a conflict and refuses the run until it is resolved with --prefer creator|catalyst,\n' +
  '       --prefer <Table>=creator|catalyst (repeatable) or --conflicts <file> ({"<Table>": {"<source id>": "creator"|"catalyst"}}).\n' +
  '       After the first run, a new record whose source id the store already holds (a restored older checkpoint, or a row\n' +
  '       added on both sides) is a conflict too, never an in-place update; one whose stored values already match is not.\n' +
  '       Conflicts list table, ROWID, source id and fields with a short hash of each value, never the value itself.\n';

function appLinkOf(app: App, args: readonly string[]): string {
  const named = flag(args, '--app');
  const appLink = named ?? app.name?.trim();
  if (!appLink) throw new GuardError('name-mismatch', 'application name is missing');
  if (named && app.name?.trim() !== named) throw new GuardError('name-mismatch', 'application name does not match --app');
  return appLink;
}

export async function syncDeltaCli(args: readonly string[], io: Io): Promise<number> {
  try {
    const source = deltaSource(args);
    const ds = flag(args, '--ds');
    const since = flag(args, '--since');
    if (!source || !ds || !since) {
      io.stderr(SYNC_USAGE);
      return 2;
    }
    const app = loadApp(ds);
    const appLink = appLinkOf(app, args);
    const confirm = args.includes('--confirm');
    const applyDeletes = args.includes('--apply-deletes');
    const allowMassDelete = args.includes('--allow-mass-delete');
    const capText = flag(args, '--max-delete-percent');
    let maxDeletePercent: number | undefined;
    if (capText !== undefined) {
      maxDeletePercent = Number(capText);
      if (!Number.isFinite(maxDeletePercent) || maxDeletePercent < 0 || maxDeletePercent > 100) {
        throw new GuardError('configuration', '--max-delete-percent must be a number from 0 to 100');
      }
    }
    const resolver = conflictResolver(args);
    const guard = confirm ? await prepareGuard(ds, args, appLink, io) : planGuard(ds, args, appLink);
    const loaded = DELTA_SOURCES[source.kind]!(source.path, app, args.includes('--allow-empty'));
    const statePath = stateFilePath(since);
    const plan = computeDelta(app, loaded, readDeltaCheckpoint(statePath), source.kind);
    io.stdout(formatDeltaPlan(plan, { source: source.kind, applyDeletes, scope: planScopeLines(guard), loaded, confirm, allowMassDelete, maxDeletePercent, resolution: resolver.describe }));
    if (!confirm) return 0;
    const totals = deltaTotals(plan);
    if (totals.upserts === 0 && (!applyDeletes || totals.deleted === 0)) {
      writeDeltaCheckpoint(statePath, plan.next);
      io.stdout('applied: none (nothing to write)\ncheckpoint: recorded\n');
      return 0;
    }
    await assertLiveProject(io, guard.org, guard.projectId);
    const scope = await resolveScope(io, guard.org, guard.projectId);
    const result = await applyDelta({
      app,
      loaded,
      plan,
      applyDeletes,
      allowMassDelete,
      maxDeletePercent,
      dc: guard.dc,
      catalystBase: flag(args, '--catalyst-base') ?? catalystBaseFor(guard.dc),
      fetch: io.fetch,
      scope,
      ...(resolver.resolve ? { resolve: resolver.resolve } : {}),
    });
    io.stdout(`conflicts: ${result.conflicts.length}${result.unchecked ? ` (${result.unchecked} changed or deleted record(s) synced before store fingerprints were kept: not checked)` : ''}\n`);
    for (const conflict of result.conflicts) io.stdout(`  ${formatConflict(conflict)}\n`);
    const record: ConflictRecord = { ...(plan.since ? { since: plan.since } : {}), conflicts: result.conflicts };
    writeState(statePath, { [CONFLICTS_KEY]: record });
    for (const table of result.tables) {
      io.stdout(`${table.table}: inserted ${table.inserted} updated ${table.updated} unchanged-in-store ${table.same} deleted ${table.deleted}${table.kept ? ` kept-new-app ${table.kept}` : ''}\n`);
    }
    if (!result.ok) {
      io.stderr(`c2c: ${result.error ?? 'sync-delta failed'}\nc2c: checkpoint not recorded; re-run to resume (rows already written are matched by source id)\n`);
      return 1;
    }
    writeDeltaCheckpoint(statePath, withStoreFingerprints(withDeletionsApplied(plan.next, result.appliedDeletes), result.store));
    const applied = result.tables.reduce((sum, table) => sum + table.inserted + table.updated, 0);
    io.stdout(`applied: ${applied} upsert(s)\ncheckpoint: recorded\n`);
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

const ROLLBACK_USAGE =
  'usage: c2c rollback-export --ds <file|dir> --out <dir> --rows <dir>\n' +
  '       c2c rollback-export --ds <file|dir> --out <dir> [--project <id>] [--org <id>] [--app <link>] [--confirm] [--catalyst-base <url>] [--dc <dc>] [--config <c2c-deploy.json>] [--projects <file>]\n' +
  '       --rows reads <table>.json row files offline. Without --rows the rows are read from the project, only with --confirm.\n';

export async function rollbackExportCli(args: readonly string[], io: Io): Promise<number> {
  try {
    const ds = flag(args, '--ds');
    const out = flag(args, '--out');
    if (!ds || !out) {
      io.stderr(ROLLBACK_USAGE);
      return 2;
    }
    const app = loadApp(ds);
    const appLink = appLinkOf(app, args);
    const tables = generateSchema(app)
      .tables.filter((table) => !table.nosql && table.role !== 'system')
      .map((table) => table.name);
    const rowsDir = flag(args, '--rows');
    const confirm = args.includes('--confirm');
    let rows: Map<string, Record<string, unknown>[]>;
    if (rowsDir) {
      rows = new Map();
      const names = new Set(readdirSync(rowsDir));
      for (const table of tables) {
        if (names.has(`${table}.json`)) rows.set(table, parseStoreRows(table, readFileSync(join(rowsDir, `${table}.json`), 'utf8')));
      }
    } else {
      const guard = confirm ? await prepareGuard(ds, args, appLink, io) : planGuard(ds, args, appLink);
      if (!confirm) {
        const lines = ['c2c rollback-export plan v1', ...planScopeLines(guard), '', 'tables to read:', ...tables.map((table) => `- ${table}`), '', `out: ${out}`, 'reads: no', ''];
        io.stdout(`${lines.join('\n')}\n`);
        return 0;
      }
      await assertLiveProject(io, guard.org, guard.projectId);
      const scope = await resolveScope(io, guard.org, guard.projectId);
      rows = await readStoreRows({ dc: guard.dc, catalystBase: flag(args, '--catalyst-base') ?? catalystBaseFor(guard.dc), fetch: io.fetch, scope }, tables);
    }
    const result = rollbackExport(app, rows);
    for (const file of [...result.files, result.manifest]) {
      const path = join(out, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.body);
    }
    for (const count of result.counts) io.stdout(`${count.form}: rows ${count.rows}\n`);
    io.stdout(`import order: ${result.order.join(', ')}\n`);
    for (const line of result.warnings) io.stdout(`note: ${line}\n`);
    io.stdout(`wrote ${result.files.length + 1} files to ${out} (${result.files.length} export files and ${result.manifest.path})\n`);
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}
