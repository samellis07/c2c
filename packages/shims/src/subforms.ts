/**
 * Subform rows stored in child tables.
 *
 * Every inline subform is a Data Store child table with a foreign key to the
 * parent ROWID and a 0-based row-order column (`SchemaTable.subform` in the
 * schema plan). The parent row never stores the subform array. Data Store has
 * no transactions, so a failed child insert deletes the child rows it already
 * wrote and, for a new parent, the parent row too (compensating delete), then
 * rethrows.
 *
 * The adapter is the same datastore slot the generated handlers use: the child
 * table name is passed where a form name goes.
 */

/** One inline subform of a form, as the schema plan stores it. */
export interface SubformTable {
  /** Subform field link name on the parent form. */
  field: string;
  /** Child Data Store table. */
  table: string;
  /** Foreign key to the parent ROWID. */
  parentColumn: string;
  /**
   * 0-based row position. Absent for a grid linked to another form: its rows
   * are that form's records and read back in ROWID order.
   */
  orderColumn?: string;
}

/** Parent form → its inline subforms. */
export type SubformTables = Readonly<Record<string, readonly SubformTable[]>>;

export interface SubformStore {
  insert?(table: string, rows: Record<string, unknown>[]): Promise<unknown>;
  query?(table: string, zcqlWhere: string, limit: number, offset?: number, orderBy?: string): Promise<Record<string, unknown>[]>;
  delete?(table: string, rowIds: readonly unknown[]): Promise<unknown>;
}

/** Optional read scope used when attaching child rows to an authorized parent. */
export interface SubformReadScope {
  criteria: string;
  fields?: readonly string[];
}
export interface AttachSubformsOptions {
  authorize?: (table: string) => SubformReadScope | null;
  project?: (row: Record<string, unknown>, fields?: readonly string[]) => Record<string, unknown>;
}

/** Catalyst insertRows / deleteRows take at most 200 rows per call. */
export const SUBFORM_WRITE_BATCH = 200;
/** ZCQL returns at most 300 rows per query; IN lists use the same cap. */
export const SUBFORM_READ_PAGE = 300;

export class SubformWriteError extends Error {
  readonly code = 'SUBFORM_WRITE_FAILED';
  constructor(
    readonly field: string,
    /** Child rows deleted again after the failure. */
    readonly compensated: number,
    override readonly cause: unknown,
  ) {
    super(`subform ${field} rows were not saved; ${compensated} child row(s) rolled back`);
    this.name = 'SubformWriteError';
  }
}

function linksOf(tables: SubformTables | undefined, form: string): readonly SubformTable[] {
  return tables && Object.hasOwn(tables, form) ? tables[form]! : [];
}

const SQL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!SQL_IDENT.test(name)) throw new Error(`subform column ${name} is not a bare ZCQL identifier`);
  return name;
}

/** A ROWID literal. Ids are digit strings; a JS number past 2^53 has already lost digits. */
function rowIdLiteral(id: unknown): string {
  if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('parent ROWID is an unsafe number');
  const text = typeof id === 'bigint' ? id.toString() : String(id ?? '');
  if (!/^\d+$/.test(text)) throw new Error('parent ROWID must be a digit string');
  return `'${text}'`;
}

/**
 * Separates the subform arrays from a record. `parent` is a shallow copy
 * without them. A subform key that is absent from the record is not in
 * `children`, so an update that does not carry it leaves its rows alone.
 */
export function splitSubforms(
  record: Record<string, unknown>,
  tables: SubformTables | undefined,
  form: string,
): { parent: Record<string, unknown>; children: { link: SubformTable; rows: Record<string, unknown>[] }[] } {
  const links = linksOf(tables, form);
  if (!links.length) return { parent: record, children: [] };
  const parent: Record<string, unknown> = { ...record };
  const children: { link: SubformTable; rows: Record<string, unknown>[] }[] = [];
  for (const link of links) {
    if (!Object.hasOwn(record, link.field)) continue;
    delete parent[link.field];
    const value = record[link.field];
    const list = value == null || value === '' ? [] : Array.isArray(value) ? value : null;
    if (!list) throw new Error(`subform ${link.field} must be a list of rows`);
    const rows = list.map((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`subform ${link.field} row ${index} is not an object`);
      // A constructed `Form.Subform()` row carries its fields under `values`.
      if ('__row' in row) {
        const values = (row as { values?: unknown }).values;
        if (values && typeof values === 'object' && !Array.isArray(values)) return values as Record<string, unknown>;
        return {} as Record<string, unknown>;
      }
      return row as Record<string, unknown>;
    });
    children.push({ link, rows });
  }
  return { parent, children };
}

/** Child rows ready to insert: link and order columns set, client ids dropped. */
export function childRowsFor(link: SubformTable, parentRowId: unknown, rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const parent = rowIdLiteral(parentRowId).slice(1, -1);
  return rows.map((row, index) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row).sort()) {
      if (key === 'ROWID' || key === 'ID' || key === 'id' || key === link.parentColumn || key === link.orderColumn) continue;
      out[key] = row[key];
    }
    out[link.parentColumn] = parent;
    if (link.orderColumn) out[link.orderColumn] = index;
    return out;
  });
}

/** ROWIDs of the child rows that point at one parent. Pages until a short page. */
export async function childRowIds(store: SubformStore, link: SubformTable, parentRowId: unknown): Promise<string[]> {
  if (!store.query) throw new Error('subform read needs datastore.query');
  const where = `${ident(link.parentColumn)} = ${rowIdLiteral(parentRowId)}`;
  const ids: string[] = [];
  for (let offset = 0; ; offset += SUBFORM_READ_PAGE) {
    const page = await store.query(link.table, where, SUBFORM_READ_PAGE, offset, 'ORDER BY ROWID');
    for (const row of page) if (row && row.ROWID != null) ids.push(String(row.ROWID));
    if (page.length < SUBFORM_READ_PAGE) return ids;
  }
}

async function deleteIds(store: SubformStore, table: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  if (!store.delete) throw new Error('subform write needs datastore.delete');
  for (let i = 0; i < ids.length; i += SUBFORM_WRITE_BATCH) await store.delete(table, ids.slice(i, i + SUBFORM_WRITE_BATCH));
}

export interface SaveSubformsOptions {
  /** Update: delete the parent's existing rows of each carried subform first. */
  replace?: boolean;
  /** Insert: delete this parent row when a child write fails. */
  parentTable?: string;
}

/**
 * Writes the subform rows of one parent. On a failure it deletes the child
 * rows this call inserted (and the new parent when `parentTable` is set) and
 * throws {@link SubformWriteError}. A replace that already deleted old rows
 * cannot restore them; the error says so through `compensated`.
 */
export async function saveSubforms(
  store: SubformStore,
  parentRowId: unknown,
  children: readonly { link: SubformTable; rows: readonly Record<string, unknown>[] }[],
  options: SaveSubformsOptions = {},
): Promise<{ inserted: number; deleted: number }> {
  rowIdLiteral(parentRowId);
  // Every row of a touched subform under this parent was written by this call
  // (a new parent, or a replace that removed the old rows first), so the
  // compensating delete re-reads them by parent id instead of trusting the
  // insert reply to carry ROWIDs.
  const touched: SubformTable[] = [];
  let inserted = 0;
  let deleted = 0;
  for (const { link, rows } of children) {
    try {
      touched.push(link);
      if (options.replace) {
        const old = await childRowIds(store, link, parentRowId);
        await deleteIds(store, link.table, old);
        deleted += old.length;
      }
      const ready = childRowsFor(link, parentRowId, rows);
      if (ready.length && !store.insert) throw new Error('subform write needs datastore.insert');
      for (let i = 0; i < ready.length; i += SUBFORM_WRITE_BATCH) {
        const batch = ready.slice(i, i + SUBFORM_WRITE_BATCH);
        await store.insert!(link.table, batch);
        inserted += batch.length;
      }
    } catch (err) {
      let compensated = 0;
      for (const item of touched) {
        try {
          const ids = await childRowIds(store, item, parentRowId);
          await deleteIds(store, item.table, ids);
          compensated += ids.length;
        } catch {
          /* the original failure is the one reported */
        }
      }
      if (options.parentTable && !options.replace) {
        try {
          await deleteIds(store, options.parentTable, [rowIdLiteral(parentRowId).slice(1, -1)]);
        } catch {
          /* reported through the thrown error */
        }
      }
      throw new SubformWriteError(link.field, compensated, err);
    }
  }
  return { inserted, deleted };
}

function stripLink(link: SubformTable, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === link.parentColumn || key === link.orderColumn) continue;
    out[key] = value;
  }
  return out;
}

function orderOf(link: SubformTable, row: Record<string, unknown>): number {
  if (!link.orderColumn) return 0;
  const raw = row[link.orderColumn];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function compareRowIds(a: unknown, b: unknown): number {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Sets each subform field on the given parent rows (mutates them), read with
 * one ZCQL IN query per 300 parents per subform. Rows are in Creator order:
 * the order column, then ROWID. The link and order columns are not returned.
 */
export async function attachSubforms(
  store: SubformStore,
  tables: SubformTables | undefined,
  form: string,
  parents: Record<string, unknown>[],
  options: AttachSubformsOptions = {},
): Promise<Record<string, unknown>[]> {
  const links = linksOf(tables, form);
  if (!links.length || !parents.length) return parents;
  if (!store.query) throw new Error('subform read needs datastore.query');
  const ids = parents.map((row) => row.ROWID).filter((id) => id != null && id !== '').map((id) => rowIdLiteral(id).slice(1, -1));
  for (const link of links) {
    const scope = options.authorize ? options.authorize(link.table) : undefined;
    if (scope === null) {
      for (const parent of parents) parent[link.field] = [];
      continue;
    }
    const byParent = new Map<string, Record<string, unknown>[]>();
    for (let i = 0; i < ids.length; i += SUBFORM_READ_PAGE) {
      const chunk = ids.slice(i, i + SUBFORM_READ_PAGE);
      const parentWhere = `${ident(link.parentColumn)} IN (${chunk.map((id) => `'${id}'`).join(', ')})`;
      const where = scope && scope.criteria && scope.criteria !== 'true' ? `(${parentWhere}) AND (${scope.criteria})` : parentWhere;
      for (let offset = 0; ; offset += SUBFORM_READ_PAGE) {
        const page = await store.query(link.table, where, SUBFORM_READ_PAGE, offset, link.orderColumn ? `ORDER BY ${ident(link.orderColumn)}, ROWID` : 'ORDER BY ROWID');
        for (const row of page) {
          const key = String(row[link.parentColumn] ?? '');
          const list = byParent.get(key) ?? [];
          list.push(row);
          byParent.set(key, list);
        }
        if (page.length < SUBFORM_READ_PAGE) break;
      }
    }
    for (const parent of parents) {
      const key = parent.ROWID == null ? '' : String(parent.ROWID);
      const rows = (byParent.get(key) ?? []).slice();
      rows.sort((a, b) => orderOf(link, a) - orderOf(link, b) || compareRowIds(a.ROWID, b.ROWID));
      parent[link.field] = rows.map((row) => {
        const projected = options.project ? options.project(row, scope && scope.fields) : row;
        return stripLink(link, projected);
      });
    }
  }
  return parents;
}
