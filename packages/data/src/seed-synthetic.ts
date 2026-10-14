/**
 * Synthetic `seed.json` → canonical c2c seed.
 *
 * The synthetic corpora (C2C_FIXTURES_DIR/synthetic) keep their own shape:
 * `{ app_name, forms: { Form: [rows] } }` where a row cell is a scalar, a
 * `{"$ref": Form, "key": natural-key field, "index": n}` lookup pointer, an
 * array of `$ref` pointers (a multi-lookup), an array of row objects (an
 * inline-subform grid), or a `$today+N` / `$now+Nh` / `$user:login`
 * placeholder (see the corpus notes: placeholders resolve at load time,
 * lookups resolve to the target record id after the parent is loaded).
 *
 * This module converts that shape, in code, to the canonical seed schema
 * (`docs/seed-schema.md`): `{ Form: [{ c2c_source_id, ...scalars }] }` with
 * stable source ids, lookup cells holding the parent source id, grids
 * flattened to `<Form>__<field>` child rows linked by `parent_id`, and
 * multi-lookups exploded to `<Form>__<field>` junction rows. Fixture files
 * are never edited. Anything unrecognised fails closed: the loader must
 * never invent values.
 */

export interface SyntheticConvertOptions {
  /** Base day for `$today+N`, `yyyy-MM-dd`. Defaults to the current UTC day. */
  today?: string;
  /** Base time for `$now+Nh`, `yyyy-MM-dd HH:mm:ss` UTC. Defaults to now. */
  now?: string;
  /** Value for `$user:login`. Absent: a seed that uses it is refused. */
  loginUser?: string;
}

export type CanonicalSeedFile = Record<string, Record<string, unknown>[]>;

interface Clock {
  today: string;
  now: string;
}

interface Target {
  form: string;
  ids: string[];
  raws: Record<string, unknown>[];
}

const TODAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOW_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const PLACEHOLDER_RE = /^\$(today([+-]\d+)?|now([+-]\d+h)?|user:login)$/;

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function utcNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function clockOf(opts: SyntheticConvertOptions | undefined): { clock: Clock; loginUser: string | undefined } {
  const today = opts?.today ?? utcToday();
  if (!TODAY_RE.test(today)) throw new Error('synthetic seed today must be yyyy-MM-dd');
  const now = opts?.now ?? utcNow();
  if (!NOW_RE.test(now)) throw new Error('synthetic seed now must be yyyy-MM-dd HH:mm:ss');
  return { clock: { today, now }, loginUser: opts?.loginUser };
}

function addDays(today: string, days: number): string {
  const [y, m, d] = today.split('-').map((part) => parseInt(part, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function addHours(now: string, hours: number): string {
  const [date, time] = now.split(' ');
  const [y, mo, d] = date.split('-').map((part) => parseInt(part, 10));
  const [hh, mm, ss] = time.split(':').map((part) => parseInt(part, 10));
  const dt = new Date(Date.UTC(y, mo - 1, d, hh + hours, mm, ss));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

function isRef(value: unknown): value is { $ref: unknown; key: unknown; index: unknown } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, '$ref');
}

function resolveClock(form: string, field: string, text: string, clock: Clock, loginUser: string | undefined): string {
  if (!PLACEHOLDER_RE.test(text)) return text;
  if (text === '$user:login') {
    if (loginUser === undefined) throw new Error(`synthetic seed uses $user:login for ${form}.${field}; pass loginUser`);
    return loginUser;
  }
  if (text === '$today') return clock.today;
  if (text === '$now') return clock.now;
  const todayMatch = /^\$today([+-]\d+)$/.exec(text);
  if (todayMatch) return addDays(clock.today, parseInt(todayMatch[1], 10));
  const nowMatch = /^\$now([+-]\d+)h$/.exec(text);
  if (nowMatch) return addHours(clock.now, parseInt(nowMatch[1], 10));
  return text;
}

function resolveRef(form: string, field: string, rowId: string, value: { $ref: unknown; key: unknown; index: unknown }, targets: Map<string, Target>): string {
  const { $ref, key, index } = value;
  if (typeof $ref !== 'string' || typeof key !== 'string' || !Number.isInteger(index)) {
    throw new Error(`synthetic seed lookup ${form}.${field} row ${rowId} is not a {$ref, key, index} pointer`);
  }
  const target = targets.get($ref);
  if (!target) throw new Error(`synthetic seed lookup ${form}.${field} row ${rowId} references unknown form ${$ref}`);
  if ((index as number) < 0 || (index as number) >= target.ids.length) {
    throw new Error(`synthetic seed lookup ${form}.${field} row ${rowId} index ${index} is out of range (${target.ids.length} rows in ${$ref})`);
  }
  if (!Object.hasOwn(target.raws[index as number], key)) {
    throw new Error(`synthetic seed lookup ${form}.${field} row ${rowId} key ${key} is missing in ${$ref}`);
  }
  return target.ids[index as number];
}

function scalarCell(
  form: string,
  field: string,
  value: unknown,
  clock: Clock,
  loginUser: string | undefined,
  targets: Map<string, Target>,
  rowId: string,
): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return resolveClock(form, field, value, clock, loginUser);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (isRef(value)) return resolveRef(form, field, rowId, value, targets);
  throw new Error(`synthetic seed cell ${form}.${field} is not a value`);
}

/**
 * Convert a parsed synthetic seed.json to the canonical seed shape.
 * Grids and multi-lookups become `<Form>__<field>` tables; an empty array
 * contributes nothing (no child rows, no junction rows, no cell).
 */
export function convertSyntheticSeed(value: unknown, opts?: SyntheticConvertOptions): CanonicalSeedFile {
  const { clock, loginUser } = clockOf(opts);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('synthetic seed is not an object');
  const forms = (value as { forms?: unknown }).forms;
  if (!forms || typeof forms !== 'object' || Array.isArray(forms)) throw new Error('synthetic seed has no forms');
  const targets = new Map<string, Target>();
  for (const [form, rows] of Object.entries(forms as Record<string, unknown>)) {
    if (!Array.isArray(rows)) throw new Error(`synthetic seed form ${form} rows are missing`);
    const raws: Record<string, unknown>[] = rows.map((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`synthetic seed row ${form}#${i + 1} is not an object`);
      return row as Record<string, unknown>;
    });
    targets.set(form, { form, ids: raws.map((_, i) => `${form}#${i + 1}`), raws });
  }
  const out: CanonicalSeedFile = {};
  const extras: CanonicalSeedFile = {};
  const extraRow = (table: string): Record<string, unknown>[] => extras[table] ?? (extras[table] = []);
  const inputTables = new Set(Object.keys(forms as Record<string, unknown>));
  const claimedTables = new Set<string>();
  const claimedPaths = new Map<string, string>();
  const claimTable = (table: string, parentRowId: string, field: string): void => {
    if (claimedTables.has(table) || inputTables.has(table)) {
      throw new Error(`synthetic seed table ${table} for ${parentRowId}.${field} collides with another table`);
    }
    claimedTables.add(table);
  };
  const claimGeneratedTable = (table: string, parentRowId: string, field: string, logicalPath: string): void => {
    if (inputTables.has(table)) throw new Error(`synthetic seed table ${table} for ${parentRowId}.${field} collides with another table`);
    if (claimedTables.has(table)) {
      if (claimedPaths.get(table) === logicalPath) return;
      throw new Error(`synthetic seed table ${table} for ${parentRowId}.${field} collides with another table`);
    }
    claimedTables.add(table);
    claimedPaths.set(table, logicalPath);
  };
  const flattenGrid = (
    parentTable: string,
    field: string,
    parentRowId: string,
    values: unknown[],
    path: string,
    rootRowNumber: number,
    pathIndexes: number[] = [],
  ): void => {
    const table = `${parentTable}__${field}`;
    claimGeneratedTable(table, parentRowId, path, path);
    values.forEach((item, k) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || isRef(item)) {
        throw new Error(`synthetic seed subform ${path} row ${parentRowId}#${k + 1} is not an object`);
      }
      const childId = `${table}#${rootRowNumber}${[...pathIndexes, k + 1].map((index) => `#${index}`).join('')}`;
      const child: Record<string, unknown> = { c2c_source_id: childId, parent_id: parentRowId, row_order: String(k) };
      for (const [subField, subCell] of Object.entries(item as Record<string, unknown>)) {
        if (Array.isArray(subCell)) {
          if (subCell.length === 0) continue;
          if (subCell.length > 0 && subCell.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && !isRef(entry))) {
            flattenGrid(table, subField, childId, subCell, `${path}.${subField}`, rootRowNumber, [...pathIndexes, k + 1]);
            continue;
          }
          if (subCell.length > 0 && subCell.every(isRef)) {
            const junction = `${table}__${subField}`;
            claimGeneratedTable(junction, childId, `${path}.${subField}`, `${path}.${subField}`);
            subCell.forEach((ref, order) => extraRow(junction).push({
              c2c_source_id: `${junction}#${rootRowNumber}${[...pathIndexes, k + 1, order + 1].map((index) => `#${index}`).join('')}`,
              parent_id: childId,
              row_order: String(order),
              [subField]: resolveRef(path, subField, childId, ref, targets),
            }));
            continue;
          }
          if (subCell.length > 0 && subCell.every((entry) => entry === null || entry === undefined || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')) {
            child[subField] = JSON.stringify(subCell.filter((entry) => entry !== null && entry !== undefined).map((entry) => typeof entry === 'string' ? resolveClock(path, subField, entry, clock, loginUser) : entry));
            continue;
          }
          throw new Error(`synthetic seed array ${path}.${subField} mixes values`);
        }
        const scalar = scalarCell(path, subField, subCell, clock, loginUser, targets, childId);
        if (scalar !== undefined) child[subField] = scalar;
      }
      extraRow(table).push(child);
    });
  };
  for (const target of targets.values()) {
    const rows: Record<string, unknown>[] = [];
    target.raws.forEach((raw, i) => {
      const id = target.ids[i];
      const row: Record<string, unknown> = { c2c_source_id: id };
      for (const [field, cell] of Object.entries(raw)) {
        if (Array.isArray(cell)) {
          if (cell.length === 0) continue;
          if (cell.length > 0 && cell.every(isRef)) {
            const table = `${target.form}__${field}`;
            claimTable(table, id, field);
            cell.forEach((ref, k) => {
              extraRow(table).push({
                c2c_source_id: `${table}#${i + 1}#${k + 1}`,
                parent_id: id,
                row_order: String(k),
                [field]: resolveRef(target.form, field, id, ref, targets),
              });
            });
            continue;
          }
          if (cell.length > 0 && cell.every((item) => !!item && typeof item === 'object' && !Array.isArray(item) && !isRef(item))) {
            const table = `${target.form}__${field}`;
            flattenGrid(target.form, field, id, cell, `${target.form}.${field}`, i + 1);
            continue;
          }
          if (cell.length > 0 && cell.every((item) => item === null || item === undefined || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
            row[field] = JSON.stringify(
              (cell as (string | number | boolean | null | undefined)[]).flatMap((item) => {
                if (item === null || item === undefined) return [];
                return [typeof item === 'string' ? resolveClock(target.form, field, item, clock, loginUser) : item];
              }),
            );
            continue;
          }
          throw new Error(`synthetic seed array ${target.form}.${field} mixes values`);
        }
        const scalar = scalarCell(target.form, field, cell, clock, loginUser, targets, id);
        if (scalar !== undefined) row[field] = scalar;
      }
      rows.push(row);
    });
    out[target.form] = rows;
  }
  for (const [table, rows] of Object.entries(extras)) {
    if (Object.hasOwn(out, table)) throw new Error(`synthetic seed ${table} collides with a subform table`);
    out[table] = rows;
  }
  return out;
}
