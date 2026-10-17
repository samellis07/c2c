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
 */
import { createHash } from 'node:crypto';
import type { App } from '../../core/src/ir.js';
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
  return {
    forms: result.order.filter((name) => formNames.has(name)),
    children,
    composites: seedCompositeMap(app),
    dropped: droppedColumns(app),
    ids,
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
  const record: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row.columns)) {
    if (dropped.has(column)) continue;
    const part = parts.get(column);
    if (part) {
      const group = (record[part.field] ??= {}) as Record<string, unknown>;
      group[part.part] = value;
      continue;
    }
    record[column] = cell(value, plan.ids, rowIds);
  }
  for (const [table, link] of plan.children) {
    if (link.parent !== form) continue;
    const rows = children.get(table)?.get(row.id) ?? [];
    if (!rows.length) continue;
    record[link.field] = rows.map((child) => {
      if (link.junction) return cell(child.columns[link.field]!, plan.ids, rowIds);
      const out: Record<string, unknown> = {};
      for (const [column, value] of Object.entries(child.columns)) {
        if (column === 'parent_id' || column === 'row_order') continue;
        out[column] = cell(value, plan.ids, rowIds);
      }
      return out;
    });
  }
  return record;
}
