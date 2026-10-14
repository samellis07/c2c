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

function resolveRef(form: string, field: string, value: { $ref: unknown; key: unknown; index: unknown }, targets: Map<string, Target>): string {
  const { $ref, key, index } = value;
  if (typeof $ref !== 'string' || typeof key !== 'string' || !Number.isInteger(index)) {
    throw new Error(`synthetic seed lookup ${form}.${field} is not a {$ref, key, index} pointer`);
  }
  const target = targets.get($ref);
  if (!target) throw new Error(`synthetic seed lookup ${form}.${field} references unknown form ${$ref}`);
  if ((index as number) < 0 || (index as number) >= target.ids.length) {
    throw new Error(`synthetic seed lookup ${form}.${field} index ${index} is out of range (${target.ids.length} rows in ${$ref})`);
  }
  if (!Object.hasOwn(target.raws[index as number], key)) {
    throw new Error(`synthetic seed lookup ${form}.${field} key ${key} is missing in ${$ref}`);
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
): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return resolveClock(form, field, value, clock, loginUser);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (isRef(value)) return resolveRef(form, field, value, targets);
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
  for (const target of targets.values()) {
    const rows: Record<string, unknown>[] = [];
    target.raws.forEach((raw, i) => {
      const id = target.ids[i];
      const row: Record<string, unknown> = { c2c_source_id: id };
      for (const [field, cell] of Object.entries(raw)) {
        if (Array.isArray(cell)) {
          if (cell.length === 0) continue;
          if (cell.every(isRef)) {
            const table = `${target.form}__${field}`;
            cell.forEach((ref, k) => {
              extraRow(table).push({
                c2c_source_id: `${table}#${i + 1}#${k + 1}`,
                parent_id: id,
                [field]: resolveRef(target.form, field, ref, targets),
              });
            });
            continue;
          }
          if (cell.every((item) => !!item && typeof item === 'object' && !Array.isArray(item) && !isRef(item))) {
            const table = `${target.form}__${field}`;
            cell.forEach((item, k) => {
              const sub = item as Record<string, unknown>;
              const child: Record<string, unknown> = { c2c_source_id: `${table}#${i + 1}#${k + 1}`, parent_id: id };
              for (const [subField, subCell] of Object.entries(sub)) {
                if (Array.isArray(subCell)) throw new Error(`synthetic seed nested subform ${target.form}.${field}.${subField} is not supported`);
                const scalar = scalarCell(target.form, `${field}.${subField}`, subCell, clock, loginUser, targets);
                if (scalar !== undefined) child[subField] = scalar;
              }
              extraRow(table).push(child);
            });
            continue;
          }
          if (cell.every((item) => item === null || item === undefined || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
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
        const scalar = scalarCell(target.form, field, cell, clock, loginUser, targets);
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
