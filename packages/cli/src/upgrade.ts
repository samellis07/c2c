/**
 * `c2c upgrade`: move a generated app from the c2c version that made it to the
 * c2c version that is running, keeping the data and the customisations.
 *
 * Nothing in the Data Store is read or written. The report says, per file,
 * what is regenerated, what is kept and what stops the upgrade, and lists the
 * schema changes the new version brings (additive or breaking). Without
 * --apply it writes nothing.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { App } from '../../core/src/index.js';
import { flag, loadApp } from '../../deploy/src/cli.js';
import { rollbackBackupProblem } from '../../deploy/src/rollback.js';
import { buildOfflinePlan, c2cVersion, resolveDc, sha256, type PlanFile } from '../../deploy/src/offline-plan.js';
import { generateReactApp, planReactWrite, writeReactApp, type WritePlan } from '../../ui-react/src/index.js';
import { terminalSafe, singleLine } from '../../doctor/src/sanitize.js';

export const UPGRADE_SCHEMA = 'c2c-upgrade/1';

/** Files the customer edits; a re-plan never overwrites them. */
export const PRESERVED_PLAN_FILES = ['function-env.json', 'provision/inputs.json'] as const;

/** Inputs the upgrade never touches: they live outside the generated folders. */
export const PRESERVED_INPUTS = [
  'the Creator export (.ds) and the edits file beside it (<app>.edits.json, or c2c.edits.json in a project folder)',
  'accepted logic fills (c2c.lock.json)',
  'deploy settings (c2c-deploy.json) and the function environment file you keep outside the repository',
  'every row in the Data Store, every app user and every uploaded file',
  'files under src/custom/ in the React app',
] as const;

export interface PlanTreeChanges {
  dir: string;
  /** c2c version recorded in the old plan, when it has a manifest. */
  from: string | undefined;
  regenerated: string[];
  unchanged: string[];
  added: string[];
  removed: string[];
  /** Files whose bytes no longer match the old manifest; the upgrade stops on these unless --force. */
  handEdited: string[];
  preserved: string[];
}

export interface SchemaChanges {
  additive: string[];
  breaking: string[];
}

export interface UpgradeReport {
  schema: typeof UPGRADE_SCHEMA;
  app: string;
  to: string;
  from: string | undefined;
  /** upgrade: older to newer. same: nothing to do for the version. downgrade: refused. unknown: no recorded version. */
  direction: 'upgrade' | 'same' | 'downgrade' | 'unknown';
  plan?: PlanTreeChanges;
  schemaChange?: SchemaChanges;
  ui?: { dir: string; changes: WritePlan };
  preserved: readonly string[];
  /** Why --apply refuses. Empty when the upgrade can be applied. */
  blocked: string[];
  /** What to do next. */
  next: string[];
}

export interface UpgradeInput {
  app: App;
  dc: string;
  dcSource: Parameters<typeof buildOfflinePlan>[1]['dcSource'];
  planDir?: string;
  uiDir?: string;
  apiBase?: string;
  auth?: boolean;
  mail?: boolean;
  production?: boolean;
  projectId?: string;
  force?: boolean;
  allowDestructive?: boolean;
}

interface Manifest {
  c2c?: string;
  files: Record<string, string>;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function versionParts(version: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function compareVersions(from: string | undefined, to: string): UpgradeReport['direction'] {
  const a = from === undefined ? undefined : versionParts(from);
  const b = versionParts(to);
  if (!a || !b) return 'unknown';
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return 'upgrade';
    if (a[i]! > b[i]!) return 'downgrade';
  }
  return 'same';
}

interface TableStepLike {
  table: string;
  columns: Record<string, unknown>[];
}

function columnSignatures(steps: readonly TableStepLike[]): Map<string, Map<string, Record<string, unknown>>> {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  for (const step of steps) {
    const columns = tables.get(step.table) ?? new Map<string, Record<string, unknown>>();
    for (const column of step.columns) columns.set(String(column.column_name), column);
    tables.set(step.table, columns);
  }
  return tables;
}

/** Compare two `provision/tables.json` plans: what the new version adds and what it would break. */
export function diffTablePlans(before: readonly TableStepLike[], after: readonly TableStepLike[]): SchemaChanges {
  const was = columnSignatures(before);
  const now = columnSignatures(after);
  const additive: string[] = [];
  const breaking: string[] = [];
  for (const [table, columns] of [...now].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const old = was.get(table);
    if (!old) {
      additive.push(`new table ${table}`);
      continue;
    }
    for (const [name, column] of [...columns].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const prior = old.get(name);
      if (!prior) {
        if (column.is_mandatory === true) breaking.push(`new mandatory column ${table}.${name}: existing rows have no value for it`);
        else additive.push(`new column ${table}.${name}`);
        continue;
      }
      if (prior.data_type !== column.data_type) breaking.push(`column ${table}.${name} changes type ${String(prior.data_type)} -> ${String(column.data_type)}`);
      if (prior.is_unique !== true && column.is_unique === true) breaking.push(`column ${table}.${name} becomes unique: duplicate values would be refused`);
      if (prior.is_mandatory !== true && column.is_mandatory === true) breaking.push(`column ${table}.${name} becomes mandatory: empty values would be refused`);
    }
    for (const name of [...old.keys()].sort()) if (!columns.has(name)) breaking.push(`column ${table}.${name} is dropped`);
  }
  for (const table of [...was.keys()].sort()) if (!now.has(table)) breaking.push(`table ${table} is dropped`);
  return { additive, breaking };
}


/**
 * A path a manifest or a generated plan names, resolved inside the folder it belongs to. A manifest is a file the operator can edit
 * (or an attacker can swap), so every path it names is checked before anything is read, written or removed: no empty or absolute
 * path, no `..` segment, no backslash or control character, and the resolved location (through any symlinked parent) must stay
 * inside the folder.
 */
export function insidePlanDir(dir: string, rel: string): string {
  if (typeof rel !== 'string' || rel === '' || isAbsolute(rel) || /[\\\u0000-\u001f\u007f]/.test(rel) || rel.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('upgrade refused: the plan names a path that is not a plain relative path inside the plan folder');
  }
  const target = join(dir, ...rel.split('/'));
  const root = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  // Walk up to the nearest existing ancestor: a symlinked directory on the way must still resolve inside the folder.
  let probe = target;
  while (!existsSync(probe) && !isLink(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = existsSync(probe) ? realpathSync(probe) : resolve(probe);
  const outside = relative(root, real);
  if (outside.startsWith('..') || isAbsolute(outside)) {
    throw new Error('upgrade refused: the plan names a path that resolves outside the plan folder');
  }
  if (isLink(target)) throw new Error('upgrade refused: the plan names a path that is a symbolic link');
  return target;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function planTreeChanges(dir: string, files: readonly PlanFile[]): PlanTreeChanges {
  const manifest = readJson<Manifest>(join(dir, 'c2c-manifest.json'));
  const recorded = manifest?.files ?? {};
  const changes: PlanTreeChanges = { dir, from: manifest?.c2c, regenerated: [], unchanged: [], added: [], removed: [], handEdited: [], preserved: [] };
  for (const [path, digest] of Object.entries(recorded)) {
    const file = insidePlanDir(dir, path);
    if ((PRESERVED_PLAN_FILES as readonly string[]).includes(path)) continue;
    if (existsSync(file) && `sha256:${sha256(readFileSync(file))}` !== digest) {
      const next = files.find((f) => f.path === path);
      if (!next || `sha256:${sha256(next.bytes ?? next.data)}` !== `sha256:${sha256(readFileSync(file))}`) changes.handEdited.push(path);
    }
  }
  const next = new Set<string>();
  for (const file of files) {
    if (file.path === 'c2c-manifest.json') continue;
    next.add(file.path);
    if ((PRESERVED_PLAN_FILES as readonly string[]).includes(file.path) && existsSync(join(dir, ...file.path.split('/')))) {
      changes.preserved.push(file.path);
      continue;
    }
    const digest = `sha256:${sha256(file.bytes ?? file.data)}`;
    if (!(file.path in recorded)) changes.added.push(file.path);
    else if (recorded[file.path] === digest) changes.unchanged.push(file.path);
    else changes.regenerated.push(file.path);
  }
  for (const path of changes.added) {
    if (existsSync(insidePlanDir(dir, path))) changes.handEdited.push(path);
  }
  for (const path of Object.keys(recorded)) if (!next.has(path) && path !== 'c2c-manifest.json') changes.removed.push(path);
  for (const list of [changes.regenerated, changes.unchanged, changes.added, changes.removed, changes.handEdited, changes.preserved]) list.sort();
  return changes;
}

function buildFiles(input: UpgradeInput): PlanFile[] {
  return buildOfflinePlan(input.app, {
    dc: input.dc,
    dcSource: input.dcSource,
    mail: input.mail === true,
    newProject: input.projectId === undefined,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.production ? { production: true } : {}),
  }).files;
}

/** Work out the upgrade without writing anything. */
export function planUpgrade(input: UpgradeInput): { report: UpgradeReport; planFiles: PlanFile[] } {
  const to = c2cVersion();
  const report: UpgradeReport = {
    schema: UPGRADE_SCHEMA,
    app: input.app.name ?? 'app',
    to,
    from: undefined,
    direction: 'unknown',
    preserved: PRESERVED_INPUTS,
    blocked: [],
    next: [],
  };
  const planFiles = input.planDir !== undefined ? buildFiles(input) : [];
  if (input.planDir !== undefined) {
    if (!existsSync(join(input.planDir, 'c2c-manifest.json'))) {
      report.blocked.push(`${input.planDir} has no c2c-manifest.json: it is not a c2c plan folder`);
    } else {
      const plan = planTreeChanges(input.planDir, planFiles);
      report.plan = plan;
      report.from = plan.from;
      report.direction = compareVersions(plan.from, to);
      const before = readJson<TableStepLike[]>(join(input.planDir, 'provision', 'tables.json'));
      const after = planFiles.find((file) => file.path === 'provision/tables.json');
      if (before && after) report.schemaChange = diffTablePlans(before, JSON.parse(after.data) as TableStepLike[]);
    }
  }
  if (input.uiDir !== undefined) {
    const files = generateReactApp(input.app, { ...(input.apiBase ? { apiBase: input.apiBase } : {}), auth: input.auth !== false });
    const manifest = readJson<{ spec?: unknown }>(join(input.uiDir, 'c2c-generated.json'));
    if (manifest?.spec !== undefined && manifest.spec !== 1) report.blocked.push(`React app spec ${String(manifest.spec)} is newer than this c2c`);
    report.ui = { dir: input.uiDir, changes: planReactWrite(input.uiDir, files, { upgradePlatform: true }) };
  }
  if (report.direction === 'downgrade') report.blocked.push(`the folder was made by c2c ${report.from}, which is newer than this c2c ${to}: install the newer c2c, never downgrade a generated app`);
  if (report.direction === 'unknown' && report.from !== undefined) report.blocked.push(`the folder has an unknown c2c version ${report.from}; refuse to apply it`);
  const edited = [...(report.plan?.handEdited ?? []), ...(report.ui?.changes.edited ?? [])];
  if (edited.length > 0 && !input.force) report.blocked.push(`generated files were edited by hand: ${edited.join(', ')}. Move the change to a customisation (the edits file, src/custom/) or pass --force to discard it`);
  if (report.schemaChange && report.schemaChange.breaking.length > 0 && !input.allowDestructive) {
    report.blocked.push(`the new version changes the tables in a breaking way (${report.schemaChange.breaking.length}): take a backup with c2c rollback-export and re-run with --allow-destructive --backup <dir>, or plan the change with c2c plan --previous`);
  }
  if (report.blocked.length === 0) {
    report.next.push(input.planDir !== undefined || input.uiDir !== undefined ? 'c2c upgrade ... --apply writes the regenerated files' : 'pass --plan <dir> and/or --ui <dir> to compare a generated app');
    if (report.schemaChange && report.schemaChange.additive.length > 0) report.next.push('c2c deploy applies the additive table changes; existing rows stay as they are');
    report.next.push('c2c verify and c2c smoke confirm the upgraded app after deploy');
  } else report.next.push('resolve the blocked items above, then run c2c upgrade again');
  return { report, planFiles };
}

/** Write the regenerated files. Refuses while `report.blocked` is not empty. */
export function applyUpgrade(input: UpgradeInput, result: { report: UpgradeReport; planFiles: PlanFile[] }): { written: string[]; removed: string[]; kept: string[] } {
  const { report, planFiles } = result;
  if (report.blocked.length > 0) throw new Error(`upgrade blocked: ${report.blocked.join('; ')}`);
  const written: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];
  if (input.planDir !== undefined && report.plan) {
    const preserved = new Set(report.plan.preserved);
    const manifestFile = planFiles.find((file) => file.path === 'c2c-manifest.json');
    for (const path of report.plan.removed) {
      rmSync(insidePlanDir(input.planDir, path), { force: true });
      removed.push(path);
    }
    for (const file of planFiles) {
      if (preserved.has(file.path)) {
        kept.push(file.path);
        continue;
      }
      if (file.path === 'c2c-manifest.json') continue;
      const dest = insidePlanDir(input.planDir, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.bytes ?? file.data);
      written.push(file.path);
    }
    if (manifestFile) {
      // Keep the manifest honest about files this upgrade did not write.
      const manifest = JSON.parse(manifestFile.data) as Manifest;
      for (const path of preserved) delete manifest.files[path];
      writeFileSync(join(input.planDir, 'c2c-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      written.push('c2c-manifest.json');
    }
  }
  if (input.uiDir !== undefined) {
    const files = generateReactApp(input.app, { ...(input.apiBase ? { apiBase: input.apiBase } : {}), auth: input.auth !== false });
    const ui = writeReactApp(input.uiDir, files, { upgradePlatform: true, force: input.force === true });
    written.push(...ui.written.map((path) => `ui:${path}`));
    removed.push(...ui.removed.map((path) => `ui:${path}`));
    kept.push(...ui.kept.map((path) => `ui:${path}`));
  }
  return { written, removed, kept };
}

function list(title: string, items: readonly string[], limit = 12): string[] {
  if (items.length === 0) return [];
  const indent = /^ */.exec(title)![0];
  const shown = items.slice(0, limit).map((item) => `${indent}  - ${item}`);
  if (items.length > limit) shown.push(`${indent}  - ... and ${items.length - limit} more`);
  return [`${title} (${items.length}):`, ...shown];
}

export function upgradeAsText(report: UpgradeReport): string {
  const lines: string[] = [];
  lines.push(`c2c upgrade: ${report.app}`);
  lines.push(`version: ${report.from ?? 'not recorded'} -> ${report.to} (${report.direction})`);
  if (report.plan) {
    lines.push(`plan folder ${report.plan.dir}:`);
    lines.push(...list('  regenerated', report.plan.regenerated));
    lines.push(`  unchanged ${report.plan.unchanged.length}, new ${report.plan.added.length}, removed ${report.plan.removed.length}`);
    lines.push(...list('  new', report.plan.added.map(singleLine)), ...list('  removed', report.plan.removed.map(singleLine)));
    lines.push(...list('  kept (you edit these)', report.plan.preserved));
    lines.push(...list('  edited by hand', report.plan.handEdited));
  }
  if (report.schemaChange) {
    lines.push(`table changes: ${report.schemaChange.additive.length} additive, ${report.schemaChange.breaking.length} breaking`);
    lines.push(...list('  additive', report.schemaChange.additive), ...list('  breaking', report.schemaChange.breaking));
  }
  if (report.ui) {
    const c = report.ui.changes;
    lines.push(`React app ${report.ui.dir}: replaced ${c.replaced.length}, new ${c.added.length}, removed ${c.removed.length}, unchanged ${c.unchanged.length}, kept ${c.kept.length}`);
    lines.push(...list('  replaced', c.replaced.map(singleLine)), ...list('  kept (custom files)', c.kept.filter((path) => path.startsWith('src/custom/')).map(singleLine)), ...list('  edited by hand', c.edited.map(singleLine)));
  }
  lines.push('data: no row is read or changed by the upgrade');
  lines.push(...list('always kept', report.preserved));
  lines.push(...list('blocked', report.blocked), ...list('next', report.next));
  return `${terminalSafe(lines.join('\n'))}\n`;
}

export const UPGRADE_USAGE =
  'usage: c2c upgrade <file|dir> [--plan <plan-dir>] [--ui <react-dir>] [--dc <dc>] [--project <id>] [--mail] [--production] [--api-base <url>] [--no-auth]\n' +
  '                   [--force] [--allow-destructive --backup <rollback-export dir>] [--apply] [--json] [--out <file>]\n' +
  '       Compares a generated plan folder and/or React app with what this c2c version generates for the same Creator export.\n' +
  '       Without --apply nothing is written. Data, customisations and your deploy settings are never touched.\n';

export function upgradeCli(args: readonly string[], io: { stdout: (s: string) => void; stderr: (s: string) => void }): number {
  const target = args[0] !== undefined && !args[0].startsWith('--') ? args[0] : undefined;
  if (!target) {
    io.stderr(UPGRADE_USAGE);
    return 2;
  }
  const planDir = flag(args, '--plan');
  const uiDir = flag(args, '--ui');
  if (planDir === undefined && uiDir === undefined) {
    io.stderr(`c2c upgrade: pass --plan <plan-dir> and/or --ui <react-dir>\n${UPGRADE_USAGE}`);
    return 2;
  }
  try {
    const app = loadApp(target);
    const dc = resolveDc(args, process.cwd());
    const backup = flag(args, '--backup');
    const allowDestructive = args.includes('--allow-destructive');
    const projectId = flag(args, '--project');
    if (projectId !== undefined && !/^[0-9]+$/.test(projectId)) {
      io.stderr('c2c upgrade: --project must be a decimal id\n');
      return 2;
    }
    if (allowDestructive) {
      if (backup === undefined) {
        io.stderr('c2c upgrade: --allow-destructive needs --backup <rollback-export dir>\n');
        return 2;
      }
      const problem = rollbackBackupProblem(backup, app);
      if (problem) {
        io.stderr(`c2c upgrade: backup ${backup} does not verify: ${problem}\n`);
        return 1;
      }
    }
    const input: UpgradeInput = {
      app,
      dc: dc.dc,
      dcSource: dc.source,
      ...(planDir !== undefined ? { planDir } : {}),
      ...(uiDir !== undefined ? { uiDir } : {}),
      ...(flag(args, '--api-base') ? { apiBase: flag(args, '--api-base')! } : {}),
      auth: !args.includes('--no-auth'),
      mail: args.includes('--mail'),
      production: args.includes('--production'),
      ...(projectId !== undefined ? { projectId } : {}),
      force: args.includes('--force'),
      allowDestructive,
    };
    const result = planUpgrade(input);
    const text = args.includes('--json') ? `${JSON.stringify(result.report, null, 2)}\n` : upgradeAsText(result.report);
    const out = flag(args, '--out');
    if (out) writeFileSync(out, text);
    else io.stdout(text);
    if (!args.includes('--apply')) return result.report.blocked.length > 0 ? 1 : 0;
    if (result.report.blocked.length > 0) {
      io.stderr('c2c upgrade: nothing written; resolve the blocked items first\n');
      return 1;
    }
    const done = applyUpgrade(input, result);
    io.stdout(`upgrade applied: wrote ${done.written.length}, removed ${done.removed.length}, kept ${done.kept.length}\n`);
    return 0;
  } catch (err) {
    io.stderr(`c2c upgrade: ${err instanceof Error ? err.message : 'upgrade failed'}\n`);
    return 1;
  }
}
