/**
 * Volume seeds for the offline performance run: 10k or 100k rows per table,
 * built on `c2c seed` (generateSeed), so the rows are the canonical seed shape
 * (`docs/seed-schema.md`): stable source ids, unique columns distinct per row,
 * lookup cells naming a parent row's source id, example.com addresses only.
 * The same app, size and seed give byte-identical JSON.
 *
 * `seedRecord` turns one seed row into the body a generated form route takes:
 * composite parts become one object per field, lookup cells become the parent
 * ROWID created earlier, JSON-list cells become arrays, and subform and
 * multi-lookup child tables fold back into their parent row. File, image and
 * users cells are left out: an offline run has no Stratus and no user list.
 *
 * Self and cyclic lookups use the loader's deferral rule (`cyclicForeignKeys`):
 * the first pass posts them empty, then `deferredPatch` gives the row update
 * that sets them once every row has a ROWID. A mandatory lookup on a cycle
 * stays in the insert order when another edge of the cycle can move; when it
 * cannot, it is posted empty too and counted as a warning naming the cycle.
 */
import { createHash } from 'node:crypto';
import type { App } from '../../core/src/ir.js';
import { foreignKeyId, cyclicForeignKeyComponents, cyclicForeignKeys } from './tables.js';
import { orderTables } from './remap.js';
import { canonicalSeedJson, generateSeed, seedCompositeMap, type SeedGenRow, type SeedResult } from '../../data/src/seed.js';

export const PERF_SIZES = { '10k': 10_000, '100k': 100_000 } as const;
export type PerfSize = keyof typeof PERF_SIZES;

export const PERF_DEFAULT_SEED = 'c2c-perf';

export interface PerfSeed {
  app: string;
  size: PerfSize;
  seed: string;
  result: SeedResult;
  /** Canonical seed.json text. */
  json: string;
  sha256: string;
}

export function perfSeed(app: App, size: PerfSize, seed: string = PERF_DEFAULT_SEED): PerfSeed {
  const result = generateSeed(app, { n: PERF_SIZES[size], seed });
  const json = canonicalSeedJson(result.tables, result.blockers);
  return { app: app.name || 'app', size, seed, result, json, sha256: createHash('sha256').update(json).digest('hex') };
}

/** Columns a perf record never posts: the run has no Stratus objects and no user list. */
function droppedColumns(app: App): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const skip = new Set(['upload file', 'image', 'audio', 'video', 'signature', 'users']);
  for (const form of app.forms) out.set(form.name, new Set(form.fields.filter((f) => skip.has(String(f.type))).map((f) => f.name)));
  return out;
}

export interface RecordPlan {
  /** Seed tables posted as records, parents first. */
  forms: string[];
  /** Child table → parent form and the subform or multi-lookup field it folds into. */
  children: Map<string, { parent: string; field: string; junction: boolean }>;
  composites: ReturnType<typeof seedCompositeMap>;
  dropped: Map<string, Set<string>>;
  /** Source ids of every seed row, for telling a lookup cell from text. */
  ids: Set<string>;
  /**
   * Lookups posted empty on insert, per form: a top-level column, a
   * multi-lookup field, or `<subform field>.<column>` inside a subform row.
   */
  deferred: Map<string, Set<string>>;
  /** Counted seed warnings: mandatory lookups that a cycle forces to post empty, and subform lookups with no second pass. */
  warnings: string[];
}

interface LookupKey {
  table: string;
  column: string;
  parent: string;
  required: boolean;
  /** Set for a lookup inside a subform row: the second pass cannot reach it. */
  subform?: boolean;
}

/** The form a source id belongs to (`<form>#<seed-tag>#<row>`). */
function idForm(id: string): string {
  return id.slice(0, id.indexOf('#'));
}

function cellIds(value: string, ids: ReadonlySet<string>): string[] {
  if (ids.has(value)) return [value];
  if (!value.startsWith('[')) return [];
  try {
    const list = JSON.parse(value) as unknown;
    return Array.isArray(list) ? list.map(String).filter((id) => ids.has(id)) : [];
  } catch {
    return [];
  }
}

/**
 * Lookup edges between posted forms, read from the seed cells. A child table's
 * lookups belong to the form its rows fold into.
 */
function lookupKeys(app: App, result: SeedResult, children: RecordPlan['children'], ids: ReadonlySet<string>): LookupKey[] {
  const required = (form: string, field: string) => app.forms.find((f) => f.name === form)?.fields.find((f) => f.name === field)?.required === true;
  const keys = new Map<string, LookupKey>();
  for (const table of result.tables) {
    const link = children.get(table.form);
    for (const row of table.rows) {
      for (const [column, value] of Object.entries(row.columns)) {
        if (link && column === 'parent_id') continue;
        for (const id of cellIds(value, ids)) {
          const key: LookupKey = !link
            ? { table: table.form, column, parent: idForm(id), required: required(table.form, column) }
            : link.junction
              ? { table: link.parent, column: link.field, parent: idForm(id), required: required(link.parent, link.field) }
              : { table: link.parent, column: `${link.field}.${column}`, parent: idForm(id), required: false, subform: true };
          const name = `${foreignKeyId(key)}\0${key.parent}`;
          if (!keys.has(name)) keys.set(name, key);
        }
      }
    }
  }
  return [...keys.values()].sort((a, b) => (foreignKeyId(a) + a.parent < foreignKeyId(b) + b.parent ? -1 : 1));
}

/** `A.x -> B -> A`: the shortest way back from the key's parent to its table. */
function cyclePath(key: LookupKey, keys: readonly LookupKey[]): string {
  const prev = new Map<string, LookupKey | null>([[key.parent, null]]);
  const queue = [key.parent];
  while (queue.length && !prev.has(key.table)) {
    const name = queue.shift()!;
    for (const next of keys) {
      if (next.table !== name || prev.has(next.parent)) continue;
      prev.set(next.parent, next);
      queue.push(next.parent);
    }
  }
  const steps: string[] = [];
  for (let at = prev.get(key.table); at; at = prev.get(at.table)) steps.unshift(`${at.table}.${at.column}`);
  return [`${key.table}.${key.column}`, ...steps, key.table].join(' -> ');
}

export function recordPlan(app: App, result: SeedResult): RecordPlan {
  const formNames = new Set(app.forms.map((f) => f.name));
  const children = new Map<string, { parent: string; field: string; junction: boolean }>();
  for (const table of result.tables) {
    if (formNames.has(table.form)) continue;
    const cut = table.form.indexOf('__');
    const parent = table.form.slice(0, cut);
    const field = table.form.slice(cut + 2);
    const sample = table.rows[0]?.columns ?? {};
    children.set(table.form, { parent, field, junction: Object.hasOwn(sample, field) });
  }
  const ids = new Set<string>();
  for (const table of result.tables) for (const row of table.rows) ids.add(row.id);
  const forms = result.order.filter((name) => formNames.has(name));
  const keys = lookupKeys(app, result, children, ids);
  // Keep a mandatory cyclic lookup in the insert order when the rest of its
  // cycle can move to the second pass; a cycle of mandatory lookups cannot.
  const cyclic = cyclicForeignKeys(forms, keys);
  const mandatory = new Set(keys.filter((key) => key.required && key.table !== key.parent && cyclic.has(foreignKeyId(key))).map(foreignKeyId));
  const stuck = cyclicForeignKeyComponents(
    forms,
    keys.filter((key) => !cyclic.has(foreignKeyId(key)) || mandatory.has(foreignKeyId(key))),
  );
  const pin = new Set([...mandatory].filter((id) => !stuck.has(id)));
  const deferredIds = cyclicForeignKeys(forms, keys, pin);
  const deferred = new Map<string, Set<string>>();
  const warnings: string[] = [];
  for (const key of keys) {
    if (!deferredIds.has(foreignKeyId(key))) continue;
    if (!deferred.get(key.table)?.has(key.column)) (deferred.get(key.table) ?? deferred.set(key.table, new Set()).get(key.table)!).add(key.column);
    else continue;
    const path = cyclePath(key, keys);
    if (key.required) warnings.push(`mandatory lookup ${key.table}.${key.column} is on a lookup cycle (${path}): its rows post it empty and the second pass sets it`);
    else if (key.subform) warnings.push(`subform lookup ${key.table}.${key.column} is on a lookup cycle (${path}): its rows post it empty and it stays empty`);
  }
  const ordered = orderTables(forms.map((table) => ({ table, rows: [] })), keys, pin).map((table) => table.table);
  return {
    forms: ordered,
    children,
    composites: seedCompositeMap(app),
    dropped: droppedColumns(app),
    ids,
    deferred,
    warnings,
  };
}

function cell(value: string, ids: Set<string>, rowIds: ReadonlyMap<string, string>): unknown {
  if (ids.has(value)) {
    const rowid = rowIds.get(value);
    if (!rowid) throw new Error(`perf seed: lookup ${value} has no created row`);
    return rowid;
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      const list = JSON.parse(value) as unknown;
      if (Array.isArray(list)) return list;
    } catch {
      // Not a JSON list: plain text.
    }
  }
  return value;
}

/** Child rows grouped by parent source id, in row_order. */
export function childIndex(result: SeedResult, plan: RecordPlan): Map<string, Map<string, SeedGenRow[]>> {
  const out = new Map<string, Map<string, SeedGenRow[]>>();
  for (const table of result.tables) {
    if (!plan.children.has(table.form)) continue;
    const byParent = new Map<string, SeedGenRow[]>();
    for (const row of table.rows) {
      const key = row.columns.parent_id ?? '';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(row);
    }
    for (const rows of byParent.values()) rows.sort((a, b) => Number(a.columns.row_order) - Number(b.columns.row_order));
    out.set(table.form, byParent);
  }
  return out;
}

export function seedRecord(
  form: string,
  row: SeedGenRow,
  plan: RecordPlan,
  rowIds: ReadonlyMap<string, string>,
  children: ReadonlyMap<string, ReadonlyMap<string, readonly SeedGenRow[]>>,
): Record<string, unknown> {
  const dropped = plan.dropped.get(form) ?? new Set<string>();
  const parts = new Map<string, { field: string; part: string }>();
  for (const [field, list] of Object.entries(plan.composites[form] ?? {})) for (const p of list) parts.set(p.column, { field, part: p.part });
  const deferred = plan.deferred.get(form) ?? new Set<string>();
  const record: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row.columns)) {
    if (dropped.has(column) || deferred.has(column)) continue;
    const part = parts.get(column);
    if (part) {
      const group = (record[part.field] ??= {}) as Record<string, unknown>;
      group[part.part] = value;
      continue;
    }
    record[column] = cell(value, plan.ids, rowIds);
  }
  for (const [table, link] of plan.children) {
    if (link.parent !== form || deferred.has(link.field)) continue;
    const rows = children.get(table)?.get(row.id) ?? [];
    if (!rows.length) continue;
    record[link.field] = rows.map((child) => {
      if (link.junction) return cell(child.columns[link.field]!, plan.ids, rowIds);
      const out: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(child.columns)) {
        if (column === 'parent_id' || column === 'row_order' || deferred.has(`${link.field}.${column}`)) continue;
        out[column] = cell(value, plan.ids, rowIds);
      }
      return out;
    });
  }
  return record;
}

/**
 * The second pass for one row: its deferred top-level and multi-lookup cells
 * mapped to ROWIDs, ready for a row update. Null when the row has none.
 */
export function deferredPatch(
  form: string,
  row: SeedGenRow,
  plan: RecordPlan,
  rowIds: ReadonlyMap<string, string>,
  children: ReadonlyMap<string, ReadonlyMap<string, readonly SeedGenRow[]>>,
): Record<string, unknown> | null {
  const deferred = plan.deferred.get(form);
  if (!deferred?.size) return null;
  const patch: Record<string, unknown> = {};
  for (const column of deferred) {
    const value = row.columns[column];
    if (value) patch[column] = cell(value, plan.ids, rowIds);
  }
  for (const [table, link] of plan.children) {
    if (link.parent !== form || !link.junction || !deferred.has(link.field)) continue;
    const rows = children.get(table)?.get(row.id) ?? [];
    if (rows.length) patch[link.field] = rows.map((child) => cell(child.columns[link.field]!, plan.ids, rowIds));
  }
  return Object.keys(patch).length ? patch : null;
}
