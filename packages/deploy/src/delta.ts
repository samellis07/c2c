/**
 * Plan delta: what changes between the model before and after an edit.
 *
 * Both sides are generated the same way (schema plus the dry-run deploy tree
 * under a fixed placeholder project), then compared. The delta lists only the
 * touched tables, columns, roles, and files, so a deploy can send just those.
 * A field rename is carried as a column rename, never as a drop plus an add,
 * so the column keeps its rows. Drops need --confirm and are refused while the
 * column or table still holds data.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { App, Field } from '../../core/src/ir.js';
import { authPlan } from '../../auth/src/plan.js';
import { type SchemaColumn, type SchemaPlan, type SchemaTable } from '../../schema/src/generator.js';
import type { EditOp, FieldRename } from './edit.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from './guards.js';
import { deployFiles, type DeployFile } from './plan.js';

/** Placeholder ids: the delta compares two generated trees, it never names a real project. */
const PLACEHOLDER_ORG = '10000000000';
const PLACEHOLDER_PROJECT = '00000000000000000';

export interface ModelPlan {
  schema: SchemaPlan;
  files: Map<string, DeployFile>;
  roles: { name: string; parent?: string }[];
}

export type ColumnChange =
  | { op: 'add'; table: string; column: string; dataType: string }
  | { op: 'rename'; table: string; from: string; to: string }
  | { op: 'alter'; table: string; column: string; changes: string[] }
  | { op: 'drop'; table: string; column: string };

export interface TableChange {
  op: 'add' | 'drop';
  table: string;
  form: string;
}

export interface FileChange {
  op: 'add' | 'change' | 'remove';
  path: string;
  /** sha256 of the new bytes; absent on remove. */
  sha256?: string;
}

export interface PlanDelta {
  version: 1;
  app: string;
  edits: EditOp[];
  tables: TableChange[];
  columns: ColumnChange[];
  roles: { op: 'add' | 'remove'; role: string; parent?: string }[];
  files: FileChange[];
  /** True when the delta drops a table or column: applying it needs --confirm. */
  needsConfirm: boolean;
}

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The generated plan for one model: schema, dry-run deploy tree, and roles. Deterministic for a given model and DC. */
export function modelPlan(app: App, dc: string): ModelPlan {
  const guard: GuardOk = {
    org: PLACEHOLDER_ORG,
    projectId: PLACEHOLDER_PROJECT,
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc,
    registry: { org: PLACEHOLDER_ORG, env: ALLOWED_ENV, projects: {}, dc },
  };
  const { files: list, schema } = deployFiles(app, guard, false);
  const files = new Map<string, DeployFile>();
  for (const file of list) files.set(file.path, file);
  const roles = authPlan(app).roles.map((r) => ({ name: r.role_name, ...(r.parent ? { parent: r.parent } : {}) }));
  return { schema, files, roles };
}

function columnShape(column: SchemaColumn): string {
  return JSON.stringify({
    dataType: column.dataType,
    length: column.length ?? null,
    mandatory: column.mandatory,
    unique: column.unique,
    appUnique: column.appUnique ?? false,
    defaultValue: column.defaultValue ?? null,
    relation: column.relation ?? null,
  });
}

function alterations(before: SchemaColumn, after: SchemaColumn): string[] {
  const out: string[] = [];
  if (before.dataType !== after.dataType) out.push(`type ${before.dataType} -> ${after.dataType}`);
  if ((before.length ?? null) !== (after.length ?? null)) out.push(`length ${before.length ?? '-'} -> ${after.length ?? '-'}`);
  if (before.mandatory !== after.mandatory) out.push(`mandatory ${before.mandatory} -> ${after.mandatory}`);
  if (before.unique !== after.unique) out.push(`unique ${before.unique} -> ${after.unique}`);
  if ((before.appUnique ?? false) !== (after.appUnique ?? false)) out.push(`app unique ${before.appUnique ?? false} -> ${after.appUnique ?? false}`);
  if ((before.defaultValue ?? null) !== (after.defaultValue ?? null)) out.push(`default ${before.defaultValue ?? '-'} -> ${after.defaultValue ?? '-'}`);
  if (JSON.stringify(before.relation ?? null) !== JSON.stringify(after.relation ?? null)) {
    out.push(`relation ${before.relation?.table ?? '-'} -> ${after.relation?.table ?? '-'}`);
  }
  return out;
}

function tableColumns(before: SchemaTable, after: SchemaTable, renames: readonly FieldRename[]): ColumnChange[] {
  const out: ColumnChange[] = [];
  const oldByName = new Map(before.columns.map((c) => [c.name, c]));
  const newByName = new Map(after.columns.map((c) => [c.name, c]));
  // A rename pairs by name through the recorded edits, so it stays a rename
  // even when other columns are added or dropped in the same delta. A rename
  // chain (A -> B -> C) collapses into one rename of the first name.
  const byFrom = new Map(renames.map((r) => [r.from, r.to]));
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();
  for (const from of byFrom.keys()) {
    let to = from;
    const seen = new Set<string>();
    while (byFrom.has(to) && !seen.has(to)) {
      seen.add(to);
      to = byFrom.get(to)!;
    }
    if (to === from) continue;
    // The base column and any derived columns (<from>_<part>, <from>__n) move
    // to the same names under `to`. A coincidental prefix match is skipped:
    // its target name is not present, and the column then compares by name.
    for (const old of before.columns) {
      let suffix: string | undefined;
      if (old.name === from) suffix = '';
      else if (old.name.startsWith(`${from}_`)) suffix = old.name.slice(from.length);
      if (suffix === undefined) continue;
      const next = newByName.get(`${to}${suffix}`);
      if (!next || pairedNew.has(next.name)) continue;
      if (columnShape(old) !== columnShape(next)) throw new Error(`rename of ${before.name}.${old.name} changed the column shape`);
      out.push({ op: 'rename', table: before.name, from: old.name, to: next.name });
      pairedOld.add(old.name);
      pairedNew.add(next.name);
    }
  }
  for (const column of after.columns) {
    if (pairedNew.has(column.name)) continue;
    const old = oldByName.get(column.name);
    if (!old || pairedOld.has(column.name)) {
      out.push({ op: 'add', table: after.name, column: column.name, dataType: column.dataType });
      continue;
    }
    const changes = alterations(old, column);
    if (changes.length) out.push({ op: 'alter', table: after.name, column: column.name, changes });
  }
  for (const column of before.columns) {
    if (pairedOld.has(column.name)) continue;
    if (!newByName.has(column.name)) out.push({ op: 'drop', table: before.name, column: column.name });
  }
  return out;
}

/** Compare two model plans. `renames` comes from the edits, so a renamed field pairs with its old column. */
export function planDelta(before: ModelPlan, after: ModelPlan, opts: { app: string; edits: readonly EditOp[]; renames: readonly FieldRename[] }): PlanDelta {
  const renamesByForm = new Map<string, FieldRename[]>();
  for (const r of opts.renames) renamesByForm.set(r.form, [...(renamesByForm.get(r.form) ?? []), r]);
  const oldTables = new Map(before.schema.tables.map((t) => [t.name, t]));
  const newTables = new Map(after.schema.tables.map((t) => [t.name, t]));
  const tables: TableChange[] = [];
  const columns: ColumnChange[] = [];
  for (const table of after.schema.tables) {
    const old = oldTables.get(table.name);
    if (!old) {
      tables.push({ op: 'add', table: table.name, form: table.form });
      continue;
    }
    columns.push(...tableColumns(old, table, table.role === 'junction' ? [] : (renamesByForm.get(table.form) ?? [])));
  }
  for (const table of before.schema.tables) {
    if (!newTables.has(table.name)) tables.push({ op: 'drop', table: table.name, form: table.form });
  }

  const oldRoles = new Set(before.roles.map((r) => r.name));
  const newRoles = new Set(after.roles.map((r) => r.name));
  const roles: PlanDelta['roles'] = [
    ...after.roles.filter((r) => !oldRoles.has(r.name)).map((r) => ({ op: 'add' as const, role: r.name, ...(r.parent ? { parent: r.parent } : {}) })),
    ...before.roles.filter((r) => !newRoles.has(r.name)).map((r) => ({ op: 'remove' as const, role: r.name })),
  ];

  const files: FileChange[] = [];
  const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
  for (const path of paths) {
    const old = before.files.get(path);
    const next = after.files.get(path);
    if (!next) files.push({ op: 'remove', path });
    else if (!old) files.push({ op: 'add', path, sha256: sha(next.data) });
    else if (sha(old.data) !== sha(next.data)) files.push({ op: 'change', path, sha256: sha(next.data) });
  }

  return {
    version: 1,
    app: opts.app,
    edits: [...opts.edits],
    tables,
    columns,
    roles,
    files,
    needsConfirm: tables.some((t) => t.op === 'drop') || columns.some((c) => c.op === 'drop'),
  };
}

function fileGroup(path: string): string {
  if (path.startsWith('functions/')) return 'function';
  if (path.startsWith('slate/')) return 'slate';
  if (path.startsWith('schema/') || path.startsWith('iac/')) return 'schema';
  return 'config';
}

export function formatDelta(delta: PlanDelta): string {
  const lines = [`# c2c plan diff for ${delta.app}`, ''];
  lines.push('## Edits', '');
  for (const op of delta.edits) lines.push(`- ${JSON.stringify(op)}`);
  lines.push('', '## Data Store', '');
  const schema = [
    ...delta.tables.map((t) => `- ${t.op} table ${t.table} (form ${t.form})${t.op === 'drop' ? ' [needs --confirm; refused while it has rows]' : ''}`),
    ...delta.columns.map((c) => {
      if (c.op === 'add') return `- add column ${c.table}.${c.column} (${c.dataType})`;
      if (c.op === 'rename') return `- rename column ${c.table}.${c.from} -> ${c.to} (keeps rows where the store can rename; the live deploy refuses a column rename)`;
      if (c.op === 'alter') return `- alter column ${c.table}.${c.column}: ${c.changes.join(', ')} (the live deploy refuses a column alter)`;
      return `- drop column ${c.table}.${c.column} [needs --confirm; refused while it has values, and the live deploy cannot drop it]`;
    }),
  ];
  lines.push(...(schema.length ? schema : ['- no change']));
  lines.push('', '## Roles', '');
  lines.push(...(delta.roles.length ? delta.roles.map((r) => `- ${r.op} role ${r.role}${r.parent ? ` (reports to ${r.parent})` : ''}`) : ['- no change']));
  lines.push('', '## Files', '');
  lines.push(...(delta.files.length ? delta.files.map((f) => `- ${f.op} ${fileGroup(f.path)} ${f.path}`) : ['- no change']));
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** delta.json, delta.md, and the added and changed files only, under files/. */
export function deltaFiles(delta: PlanDelta, after: ModelPlan): DeployFile[] {
  const out: DeployFile[] = [
    { path: 'delta.json', data: `${JSON.stringify(delta, null, 2)}\n` },
    { path: 'delta.md', data: formatDelta(delta) },
  ];
  for (const change of delta.files) {
    if (change.op === 'remove') continue;
    out.push({ path: `files/${change.path}`, data: after.files.get(change.path)!.data });
  }
  return out;
}

export function writeDeltaTree(dir: string, files: readonly DeployFile[]): void {
  for (const file of files) {
    const dest = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
}

/** The Data Store calls a schema delta needs. A driver reads the live shape so a re-run skips finished steps. */
export interface StoreDriver {
  /** Column names of a table, or undefined when the table does not exist. */
  columns(table: string): Promise<string[] | undefined>;
  /** Rows in a table. */
  rowCount(table: string): Promise<number>;
  /** Rows where the column is not empty. */
  valueCount(table: string, column: string): Promise<number>;
  createTable(table: SchemaTable): Promise<void>;
  addColumn(table: string, column: SchemaColumn): Promise<void>;
  renameColumn(table: string, from: string, to: string): Promise<void>;
  alterColumn(table: string, column: SchemaColumn): Promise<void>;
  dropColumn(table: string, column: string): Promise<void>;
  dropTable(table: string): Promise<void>;
}

export class DeltaRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeltaRefused';
  }
}

/**
 * Schema changes the live deploy cannot make, one line each. The deploy table
 * step creates missing tables and columns only: it never renames, alters, or
 * drops. `renames` comes from the edits so a renamed column pairs with its old
 * name instead of reading as a drop plus an add.
 */
export function unsupportedSchemaOps(before: SchemaPlan, after: SchemaPlan, renames: readonly FieldRename[]): string[] {
  const empty = { files: new Map<string, DeployFile>(), roles: [] };
  const delta = planDelta({ schema: before, ...empty }, { schema: after, ...empty }, { app: '', edits: [], renames });
  const out: string[] = [];
  for (const table of delta.tables) {
    if (table.op === 'drop') out.push(`drop table ${table.table}: dropping a table is not yet supported on the live store`);
  }
  for (const column of delta.columns) {
    if (column.op === 'add') continue;
    if (column.op === 'rename') out.push(`rename column ${column.table}.${column.from} -> ${column.to}: column rename is not yet supported on the live store`);
    else if (column.op === 'alter') out.push(`alter column ${column.table}.${column.column} (${column.changes.join('; ')}): column alter is not yet supported on the live store`);
    else out.push(`drop column ${column.table}.${column.column}: column drop is not yet supported on the live store`);
  }
  return out;
}

/**
 * A Creator-side change between the model that is deployed and a re-export of
 * the app. A .ds diff carries no edit log, so a renamed field reads as a drop
 * plus an add unless `renames` names it.
 */
export interface SchemaChangeReview {
  delta: PlanDelta;
  /** Changes that drop, move, or reshape stored values: they need --allow-destructive and a verified --backup. */
  destructive: string[];
  /** Choices removed from a choice field. Rows that hold one keep the stored value. */
  removedChoices: string[];
}

function choiceFields(app: App): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (form: string, fields: readonly Field[]) => {
    for (const field of fields) {
      if (field.choices?.length) out.set(`${form}.${field.name}`, field.choices);
      if (field.subfields?.length) visit(`${form}.${field.name}`, field.subfields);
    }
  };
  for (const form of app.forms) visit(form.name, form.fields);
  return out;
}

/** Review a re-exported model against the deployed one before a redeploy. Deterministic for the same inputs. */
export function reviewSchemaChange(before: App, after: App, dc: string, renames: readonly FieldRename[] = []): SchemaChangeReview {
  const delta = planDelta(modelPlan(before, dc), modelPlan(after, dc), { app: after.name || 'app', edits: [], renames });
  const destructive: string[] = [];
  for (const table of delta.tables) {
    if (table.op === 'drop') destructive.push(`drop table ${table.table} (form ${table.form})`);
  }
  for (const column of delta.columns) {
    if (column.op === 'drop') destructive.push(`drop column ${column.table}.${column.column}`);
    else if (column.op === 'rename') destructive.push(`rename column ${column.table}.${column.from} -> ${column.to}`);
    else if (column.op === 'alter') destructive.push(`alter column ${column.table}.${column.column}: ${column.changes.join(', ')}`);
  }
  const removedChoices: string[] = [];
  const next = choiceFields(after);
  for (const [field, choices] of choiceFields(before)) {
    const kept = next.get(field);
    if (!kept) continue;
    const gone = choices.filter((choice) => !kept.includes(choice));
    if (gone.length) removedChoices.push(`${field}: ${gone.map((choice) => JSON.stringify(choice)).join(', ')} removed; rows that hold a removed choice keep it`);
  }
  return { delta, destructive, removedChoices };
}

/** Parse repeated `--rename Form.Old=New` flags. */
export function renameFlags(args: readonly string[]): FieldRename[] {
  const out: FieldRename[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--rename') continue;
    const value = args[i + 1] ?? '';
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (!match) throw new Error(`--rename needs Form.Old=New, got ${JSON.stringify(value)}`);
    out.push({ form: match[1]!, from: match[2]!, to: match[3]! });
  }
  return out;
}

/** The text a refused destructive plan prints: what would change, and the steps that make it safe. */
export function destructiveRefusal(review: SchemaChangeReview, opts: { target: string; previous: string; reason: string }): string {
  const renamed = review.delta.columns.some((c) => c.op === 'rename');
  const pairs = review.delta.columns.filter((c) => c.op === 'drop').length > 0 && review.delta.columns.some((c) => c.op === 'add');
  const lines = [
    `the re-export changes stored data and ${opts.reason}; nothing was planned`,
    ...review.destructive.map((line) => `- ${line}`),
    'next steps:',
    `  1. export the deployed rows: c2c rollback-export --ds ${opts.previous} --out <backup-dir> --confirm`,
    ...(pairs ? ['  2. if a field was renamed in Creator, add --rename Form.Old=New so the column keeps its rows instead of a drop plus an add'] : []),
    `  ${pairs ? 3 : 2}. re-run: c2c plan ${opts.target} --out <dir> --previous ${opts.previous}${renamed || pairs ? ' [--rename Form.Old=New]' : ''} --allow-destructive --backup <backup-dir>`,
  ];
  return `${lines.join('\n')}\n`;
}

/** What a delta apply did: the store calls made, and the ops it could not locate. */
export interface DeltaApplyResult {
  applied: string[];
  /**
   * Ops whose target is not in the store. A finished step is skipped quietly;
   * a missing target is different — the store may hold the old name or the row
   * data the op assumed, so the skip is reported instead of silent.
   */
  skipped: string[];
}

/**
 * Apply the schema part of a delta. Every drop is checked before anything is
 * written: without confirm, or while the table or column still holds data,
 * nothing is applied. A column whose table is in `backedUp` may be dropped
 * with values: the verified export holds them. Steps already in place are skipped, so a re-run after a
 * partial apply finishes the rest.
 */
export async function applySchemaDelta(
  delta: PlanDelta,
  after: SchemaPlan,
  driver: StoreDriver,
  opts: {
    confirm?: boolean;
    /** Tables whose rows are in a verified rollback export: a confirmed column drop there may discard values the export holds. */
    backedUp?: ReadonlySet<string>;
  } = {},
): Promise<DeltaApplyResult> {
  const drops: { table: string; column?: string }[] = [
    ...delta.tables.filter((t) => t.op === 'drop').map((t) => ({ table: t.table })),
    ...delta.columns.flatMap((c) => (c.op === 'drop' ? [{ table: c.table, column: c.column }] : [])),
  ];
  if (drops.length > 0 && !opts.confirm) {
    const what = drops.map((d) => (d.column !== undefined ? `${d.table}.${d.column}` : `table ${d.table}`)).join(', ');
    throw new DeltaRefused(`the delta drops ${what}; pass --confirm to drop`);
  }
  for (const d of drops) {
    const present = await driver.columns(d.table);
    if (!present) continue;
    if (d.column !== undefined) {
      if (!present.includes(d.column)) continue;
      const n = await driver.valueCount(d.table, d.column);
      if (n > 0 && !opts.backedUp?.has(d.table)) throw new DeltaRefused(`drop of ${d.table}.${d.column} refused: ${n} row(s) hold a value; export or clear them first`);
    } else {
      const n = await driver.rowCount(d.table);
      if (n > 0) throw new DeltaRefused(`drop of table ${d.table} refused: it has ${n} row(s); export or clear them first`);
    }
  }
  const tableOf = new Map(after.tables.map((t) => [t.name, t]));
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const change of delta.tables) {
    if (change.op !== 'add') continue;
    if (await driver.columns(change.table)) continue;
    await driver.createTable(tableOf.get(change.table)!);
    applied.push(`create table ${change.table}`);
  }
  for (const change of delta.columns) {
    const present = (await driver.columns(change.table)) ?? [];
    const spec = (name: string) => tableOf.get(change.table)?.columns.find((c) => c.name === name);
    if (change.op === 'add') {
      if (present.includes(change.column)) continue;
      await driver.addColumn(change.table, spec(change.column)!);
      applied.push(`add column ${change.table}.${change.column}`);
    } else if (change.op === 'rename') {
      if (!present.includes(change.from) && present.includes(change.to)) continue;
      if (!present.includes(change.from)) {
        skipped.push(`rename column ${change.table}.${change.from} -> ${change.to}: neither column is in the store`);
        continue;
      }
      if (present.includes(change.to)) throw new DeltaRefused(`rename ${change.table}.${change.from} -> ${change.to} refused: ${change.to} already exists`);
      await driver.renameColumn(change.table, change.from, change.to);
      applied.push(`rename column ${change.table}.${change.from} -> ${change.to}`);
    } else if (change.op === 'alter') {
      if (!present.includes(change.column)) {
        skipped.push(`alter column ${change.table}.${change.column}: the column is not in the store`);
        continue;
      }
      await driver.alterColumn(change.table, spec(change.column)!);
      applied.push(`alter column ${change.table}.${change.column}`);
    } else {
      if (!present.includes(change.column)) {
        skipped.push(`drop column ${change.table}.${change.column}: the column is not in the store`);
        continue;
      }
      await driver.dropColumn(change.table, change.column);
      applied.push(`drop column ${change.table}.${change.column}`);
    }
  }
  for (const change of delta.tables) {
    if (change.op !== 'drop') continue;
    if (!(await driver.columns(change.table))) {
      skipped.push(`drop table ${change.table}: the table is not in the store`);
      continue;
    }
    await driver.dropTable(change.table);
    applied.push(`drop table ${change.table}`);
  }
  return { applied, skipped };
}
