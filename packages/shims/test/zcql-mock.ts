/**
 * In-memory stand-in for the Catalyst Data Store, for tests. It evaluates the
 * WHERE and ORDER BY the runtime sends with Data Store column typing:
 * a VarChar compares as text (`'20.00' <= '100.00'` is false) and a Double
 * compares as a number. Every stored value comes back as a string, as Catalyst
 * returns it. NULL sorts first ascending and last descending. A page larger than
 * 300 rows is refused.
 *
 * WHERE uses SQL three-valued logic, as MySQL does: a comparison with NULL is
 * UNKNOWN, NOT UNKNOWN is UNKNOWN, TRUE OR UNKNOWN is TRUE, FALSE AND UNKNOWN is
 * FALSE, and a row is kept only when the WHERE is TRUE.
 *
 * ROWID is a BIGINT and compares as a number. In a LIKE pattern `*` (and `%`)
 * matches any run of characters and `?` exactly one, as ZCQL documents.
 *
 * Grammar (the subset compileCriteria and orderByClause emit):
 *   or := and (OR and)* ; and := unary (AND unary)* ; unary := NOT unary | primary
 *   primary := '(' or ')' | true | col IS [NOT] NULL | col IN (lit, …) | col LIKE 'x' | col op lit
 */

import { decimal } from '../src/decimal.js';

type Row = Record<string, string | null>;

/** Data Store types relevant to criteria comparisons in the mock. */
export type MockColumnType = 'int' | 'bigint' | 'decimal' | 'double' | 'string';
export type MockTableSchema = Readonly<Record<string, MockColumnType>>;
type MockSchema = Readonly<Record<string, readonly string[] | MockTableSchema>>;

interface Tok {
  t: 'id' | 'num' | 'str' | 'op' | 'p';
  v: string;
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: 'p', v: c });
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= src.length) throw new Error(`zcql-mock: unterminated string in ${src}`);
        if (src[j] === "'" && src[j + 1] === "'") {
          text += "'";
          j += 2;
          continue;
        }
        if (src[j] === "'") break;
        text += src[j];
        j++;
      }
      out.push({ t: 'str', v: text });
      i = j + 1;
      continue;
    }
    const op = /^(<=|>=|!=|<>|=|<|>)/.exec(src.slice(i));
    if (op) {
      out.push({ t: 'op', v: op[1]! });
      i += op[1]!.length;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new Error(`zcql-mock: cannot lex ${src.slice(i)}`);
  }
  return out;
}

/** SQL truth value: null is UNKNOWN. */
type Truth = boolean | null;
type Pred = (row: Row) => Truth;

function or3(values: Truth[]): Truth {
  if (values.some((v) => v === true)) return true;
  return values.some((v) => v === null) ? null : false;
}

function and3(values: Truth[]): Truth {
  if (values.some((v) => v === false)) return false;
  return values.some((v) => v === null) ? null : true;
}

function compile(where: string, types: Readonly<Record<string, MockColumnType>>): Pred {
  if (!where.trim()) return () => true;
  const toks = lex(where);
  let k = 0;
  const peek = () => toks[k];
  const kw = (word: string) => peek()?.t === 'id' && peek()!.v.toUpperCase() === word;
  const take = () => toks[k++]!;
  const expect = (v: string) => {
    const tok = take();
    if (tok?.v !== v) throw new Error(`zcql-mock: expected ${v} in ${where}`);
  };
  const lit = (): string | null => {
    const tok = take();
    if (tok.t === 'num' || tok.t === 'str') return tok.v;
    if (tok.t === 'id' && tok.v.toLowerCase() === 'null') return null;
    if (tok.t === 'id' && (tok.v === 'true' || tok.v === 'false')) return tok.v;
    throw new Error(`zcql-mock: expected a literal in ${where}`);
  };
  const cmp = (col: string, cell: string | null, value: string | null): number | null => {
    if (cell == null || value == null) return null;
    if (col === 'ROWID' || types[col] === 'int' || types[col] === 'bigint') {
      // ROWID is a BIGINT column: it compares as a number.
      const a = BigInt(cell);
      const b = BigInt(value);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (types[col] === 'decimal') {
      // Decimal columns are stored as canonical strings. Keep comparisons exact;
      // converting through Number makes adjacent values near 0.3 indistinguishable.
      return decimal.from(cell).compare(decimal.from(value));
    }
    if (types[col] === 'double') {
      const a = Number(cell);
      const b = Number(value);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return cell < value ? -1 : cell > value ? 1 : 0;
  };
  const or = (): Pred => {
    const parts = [and()];
    while (kw('OR')) {
      take();
      parts.push(and());
    }
    return (row) => or3(parts.map((p) => p(row)));
  };
  const and = (): Pred => {
    const parts = [unary()];
    while (kw('AND')) {
      take();
      parts.push(unary());
    }
    return (row) => and3(parts.map((p) => p(row)));
  };
  const unary = (): Pred => {
    if (kw('NOT')) {
      take();
      const inner = unary();
      return (row) => {
        const v = inner(row);
        return v === null ? null : !v;
      };
    }
    return primary();
  };
  const primary = (): Pred => {
    if (peek()?.v === '(') {
      take();
      const inner = or();
      expect(')');
      return inner;
    }
    if (peek()?.t === 'id' && peek()!.v === 'true') {
      take();
      return () => true;
    }
    const col = take();
    if (col.t !== 'id') throw new Error(`zcql-mock: expected a column in ${where}`);
    const name = col.v;
    if (kw('IS')) {
      take();
      const negate = kw('NOT');
      if (negate) take();
      if (!kw('NULL')) throw new Error(`zcql-mock: expected NULL in ${where}`);
      take();
      return (row) => (row[name] == null) !== negate;
    }
    if (kw('IN')) {
      take();
      expect('(');
      const values: (string | null)[] = [lit()];
      while (peek()?.v === ',') {
        take();
        values.push(lit());
      }
      expect(')');
      return (row) => or3(values.map((v) => {
        const d = cmp(name, row[name] ?? null, v);
        return d === null ? null : d === 0;
      }));
    }
    if (kw('LIKE')) {
      take();
      const pattern = lit() ?? '';
      const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%|\\\*/g, '.*').replace(/\\\?/g, '.')}$`, 'i');
      return (row) => (row[name] == null ? null : re.test(row[name]!));
    }
    const op = take();
    if (op.t !== 'op') throw new Error(`zcql-mock: expected an operator in ${where}`);
    const value = lit();
    return (row) => {
      const d = cmp(name, row[name] ?? null, value);
      if (d === null) return null;
      switch (op.v) {
        case '=':
          return d === 0;
        case '!=':
        case '<>':
          return d !== 0;
        case '<':
          return d < 0;
        case '>':
          return d > 0;
        case '<=':
          return d <= 0;
        default:
          return d >= 0;
      }
    };
  };
  const pred = or();
  if (k !== toks.length) throw new Error(`zcql-mock: trailing tokens in ${where}`);
  return pred;
}

function sorter(orderBy: string, types: Readonly<Record<string, MockColumnType>>): (a: Row, b: Row) => number {
  const m = /^ORDER BY (.+)$/.exec(orderBy.trim());
  if (!m) return (a, b) => compareRowId(a, b);
  const keys = m[1]!.split(',').map((part) => {
    const [col, dir] = part.trim().split(/\s+/);
    return { col: col!, desc: dir?.toUpperCase() === 'DESC' };
  });
  return (a, b) => {
    for (const key of keys) {
      let d: number;
      if (key.col === 'ROWID') d = compareRowId(a, b);
      else {
        const x = a[key.col] ?? null;
        const y = b[key.col] ?? null;
        if (x == null || y == null) d = x == null && y == null ? 0 : x == null ? -1 : 1;
        else if (types[key.col] === 'decimal') d = decimal.from(x).compare(decimal.from(y));
        else if (types[key.col] === 'int' || types[key.col] === 'bigint') {
          const a = BigInt(x);
          const b = BigInt(y);
          d = a < b ? -1 : a > b ? 1 : 0;
        } else if (types[key.col] === 'double') d = Number(x) - Number(y);
        else d = x < y ? -1 : x > y ? 1 : 0;
      }
      if (d !== 0) return key.desc ? -d : d;
    }
    return 0;
  };
}

function compareRowId(a: Row, b: Row): number {
  const x = BigInt(a.ROWID ?? '0');
  const y = BigInt(b.ROWID ?? '0');
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface ZcqlCall {
  form: string;
  where: string;
  limit: number;
  offset: number;
  orderBy: string;
}

/**
 * Schema by form. Object entries name each column's type; the readonly-string-array
 * form is retained for existing tests that only declare Double shadow columns.
 * Undeclared columns default to VarChar, matching Catalyst's textual comparison.
 */
export function mockDatastore(schema: MockSchema) {
  const tables = new Map<string, Row[]>();
  const calls: ZcqlCall[] = [];
  let next = 1000;
  const typed = (form: string): Readonly<Record<string, MockColumnType>> => {
    const table = schema[form] ?? [];
    if (Array.isArray(table)) return Object.fromEntries(table.map((col) => [col, 'double' as const]));
    return table as MockTableSchema;
  };
  const store = (value: unknown): string | null => (value == null ? null : String(value));
  const datastore = {
    async insert(form: string, rows: Record<string, unknown>[]) {
      const list = tables.get(form) ?? [];
      tables.set(form, list);
      const out: Row[] = [];
      for (const row of rows) {
        const stored: Row = { ROWID: String(next++) };
        for (const [key, value] of Object.entries(row)) if (key !== 'ROWID') stored[key] = store(value);
        list.push(stored);
        out.push({ ...stored });
      }
      return out;
    },
    async update(form: string, rows: Record<string, unknown>[]) {
      const list = tables.get(form) ?? [];
      for (const row of rows) {
        const hit = list.find((r) => r.ROWID === String(row.ROWID));
        if (!hit) throw new Error(`zcql-mock: no row ${String(row.ROWID)}`);
        for (const [key, value] of Object.entries(row)) if (key !== 'ROWID') hit[key] = store(value);
      }
      return rows;
    },
    async delete(form: string, rowIds: readonly unknown[]) {
      const list = tables.get(form) ?? [];
      const ids = new Set(rowIds.map(String));
      tables.set(
        form,
        list.filter((row) => !ids.has(String(row.ROWID))),
      );
      return rowIds.length;
    },
    async query(form: string, where: string, limit: number, offset = 0, orderBy = '') {
      if (limit > 300) throw new Error(`zcql-mock: LIMIT ${limit} exceeds 300`);
      calls.push({ form, where, limit, offset, orderBy });
      const pred = compile(where, typed(form));
      const rows = (tables.get(form) ?? []).filter((row) => pred(row) === true).sort(sorter(orderBy, typed(form)));
      return rows.slice(offset, offset + limit).map((row) => ({ ...row }));
    },
  };
  return { datastore, tables, calls };
}
