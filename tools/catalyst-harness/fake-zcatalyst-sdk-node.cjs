'use strict';
/**
 * Offline stand-in for zcatalyst-sdk-node, enough for the generated c2c_api
 * function: initialize(req[, { scope }]), userManagement().getCurrentUser(),
 * datastore().table(name).insertRows/updateRows/deleteRows, and
 * zcql().executeZCQLQuery(sql). Tables live in memory. Nothing opens a socket.
 *
 * The ZCQL subset is strict on purpose: SELECT <cols|*> FROM <table> [WHERE <predicate>]
 * [ORDER BY ...] LIMIT <count> or LIMIT <offset>, <count>. A literal predicate such
 * as WHERE true is a syntax error, as it is in ZCQL. `col [NOT] IN (v, ...)` is supported.
 * LIMIT's offset is 1-based and 0 is clamped to 1 (it is not a syntax error):
 * LIMIT 0,2 and LIMIT 1,2 both return rows 1-2, and LIMIT 2,2 returns rows 2-3.
 * A bare LIMIT n is the first n rows.
 * Integer values compare as BigInt (ids are 17-19 digits). Rows passed to the
 * table calls go through JSON, as the SDK's request body does.
 *
 * Users: a request whose cookie carries c2c-harness-session=<token> is that
 * token's user (see setSession). Anything else has no current user.
 *
 * Unique columns: setUnique({ <table>: [<column>, ...] }) declares the columns
 * the table plan creates with is_unique. insertRows/updateRows then refuse a
 * row that repeats a stored non-empty value (or one earlier in the same call)
 * with the Data Store answer: 409 DUPLICATE_VALUE, "Duplicate value for
 * <column>. Please give a different value" (plugin/references/facts/errors.md).
 * Nothing is written on a refusal. [UNVERIFIED] that the Node SDK error carries
 * statusCode 409 and code DUPLICATE_VALUE, that a refused batch stores no row,
 * that comparison is exact (case-sensitive) and that empty values never clash:
 * confirm with a live check.
 *
 * Foreign-key columns: setForeignKeys({ <table>: [<column>, ...] }) declares
 * the columns the table plan creates as data_type "foreign key" (a bigint
 * ROWID). insertRows/updateRows then refuse a non-empty value that is not a
 * whole number with 400 INVALID_INPUT, "Invalid input value for <column>.
 * bigint value expected" (the store's type-mismatch shape, store-errors.ts).
 * Nothing is written on a refusal. [UNVERIFIED] the exact text for a foreign
 * key column, and whether a well-formed id with no parent row is refused:
 * this fake does not check the parent row.
 */

const tables = new Map();
let uniqueColumns = new Map();
let foreignKeyColumns = new Map();
const sessions = new Map();
const calls = [];
let nextRowId = 10000000000000001n;

function rowsOf(name) {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name);
}

function sdkError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code: code || (statusCode === 400 ? 'INVALID_INPUT' : 'ERROR') });
}

/**
 * Refuse the first unique value that `next` (the rows after the call) repeats.
 * Only rows in `changed` are checked, so a clash that predates setUnique stays.
 */
function assertUnique(name, next, changed) {
  for (const column of uniqueColumns.get(name) || []) {
    const seen = new Map();
    for (const row of next) {
      const value = row[column];
      if (value == null || value === '') continue;
      const key = String(value);
      if (seen.has(key) && (changed.has(row) || changed.has(seen.get(key)))) {
        throw sdkError(`Duplicate value for ${column}. Please give a different value`, 409, 'DUPLICATE_VALUE');
      }
      if (!seen.has(key)) seen.set(key, row);
    }
  }
}

/** Refuse the first foreign-key value in `changed` that is not a whole-number id. */
function assertForeignKeys(name, changed) {
  for (const column of foreignKeyColumns.get(name) || []) {
    for (const row of changed) {
      const value = row[column];
      if (value == null || value === '') continue;
      if (!/^\d+$/.test(String(value))) throw sdkError(`Invalid input value for ${column}. bigint value expected`, 400, 'INVALID_INPUT');
    }
  }
}

function cookie(req, name) {
  const header = req && req.headers ? req.headers.cookie || '' : '';
  for (const part of String(header).split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function stamp(row) {
  const now = '2026-10-06 14:00:00';
  return { ...row, CREATEDTIME: row.CREATEDTIME || now, MODIFIEDTIME: now };
}

function table(name) {
  return {
    async insertRows(rows) {
      rows = wire(rows);
      calls.push(['insertRows', name, rows.length]);
      let id = nextRowId;
      const out = rows.map((row) => {
        id += 1n;
        return stamp({ ...stringify(row), ROWID: String(id) });
      });
      assertForeignKeys(name, out);
      assertUnique(name, [...rowsOf(name), ...out], new Set(out));
      nextRowId = id;
      rowsOf(name).push(...out);
      return out.map((row) => ({ ...row }));
    },
    async updateRows(rows) {
      rows = wire(rows);
      calls.push(['updateRows', name, rows.length]);
      const store = rowsOf(name);
      const next = [...store];
      const changed = new Set();
      const out = [];
      for (const patch of rows) {
        const at = next.findIndex((row) => row.ROWID === String(patch.ROWID));
        if (at < 0) throw sdkError(`no row ${patch.ROWID} in ${name}`, 400);
        next[at] = stamp({ ...next[at], ...stringify(patch), ROWID: next[at].ROWID });
        changed.add(next[at]);
        out.push({ ...next[at] });
      }
      assertForeignKeys(name, changed);
      assertUnique(name, next, changed);
      store.splice(0, store.length, ...next);
      return out;
    },
    async deleteRows(ids) {
      ids = wire(ids);
      calls.push(['deleteRows', name, ids.length]);
      const store = rowsOf(name);
      const out = [];
      for (const id of ids) {
        const at = store.findIndex((row) => row.ROWID === String(id));
        if (at >= 0) out.push(...store.splice(at, 1));
      }
      return out;
    },
  };
}

/** The SDK sends a JSON body: a bigint throws (TypeError) as it does live. */
function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

function stringify(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = value == null ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return out;
}

// ---- ZCQL subset ----

function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(' || ch === ')' || ch === ',' || ch === '*') { out.push({ t: ch }); i += 1; continue; }
    if (ch === "'") {
      let value = '';
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") { value += "'"; i += 2; continue; }
        if (text[i] === "'") { i += 1; break; }
        value += text[i];
        i += 1;
      }
      out.push({ t: 'str', v: value });
      continue;
    }
    const op = /^(<>|!=|<=|>=|=|<|>)/.exec(text.slice(i));
    if (op) { out.push({ t: 'op', v: op[1] }); i += op[1].length; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(text.slice(i));
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i));
    if (word) { out.push({ t: 'word', v: word[0] }); i += word[0].length; continue; }
    throw sdkError(`ZCQL syntax error near ${text.slice(i, i + 10)}`, 400);
  }
  return out;
}

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'IS', 'NULL', 'LIKE', 'IN', 'TRUE', 'FALSE', 'ORDER', 'BY', 'LIMIT', 'WHERE', 'ASC', 'DESC']);

function parsePredicate(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const word = (v) => peek() && peek().t === 'word' && peek().v.toUpperCase() === v;
  function primary() {
    const tok = peek();
    if (!tok) throw sdkError('ZCQL syntax error: incomplete WHERE', 400);
    if (tok.t === '(') {
      pos += 1;
      const inner = or();
      if (!peek() || peek().t !== ')') throw sdkError('ZCQL syntax error: missing )', 400);
      pos += 1;
      return inner;
    }
    if (tok.t !== 'word' || KEYWORDS.has(tok.v.toUpperCase())) throw sdkError(`ZCQL syntax error near ${tok.v ?? tok.t}`, 400);
    pos += 1;
    const column = tok.v.includes('.') ? tok.v.split('.').pop() : tok.v;
    if (word('IS')) {
      pos += 1;
      const negate = word('NOT');
      if (negate) pos += 1;
      if (!word('NULL')) throw sdkError('ZCQL syntax error: IS needs NULL', 400);
      pos += 1;
      return (row) => (row[column] == null || row[column] === '') !== negate;
    }
    let negate = false;
    if (word('NOT')) { negate = true; pos += 1; }
    if (word('LIKE')) {
      pos += 1;
      const pattern = peek();
      if (!pattern || pattern.t !== 'str') throw sdkError('ZCQL syntax error: LIKE needs a string', 400);
      pos += 1;
      const re = new RegExp(`^${pattern.v.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      return (row) => re.test(String(row[column] ?? '')) !== negate;
    }
    if (word('IN')) {
      pos += 1;
      if (!peek() || peek().t !== '(') throw sdkError('ZCQL syntax error: IN needs (', 400);
      pos += 1;
      const values = [];
      for (;;) {
        const item = peek();
        if (!item || (item.t !== 'str' && item.t !== 'num')) throw sdkError('ZCQL syntax error: IN needs values', 400);
        values.push(item.v);
        pos += 1;
        if (peek() && peek().t === ',') { pos += 1; continue; }
        if (peek() && peek().t === ')') { pos += 1; break; }
        throw sdkError('ZCQL syntax error: missing )', 400);
      }
      return (row) => values.some((v) => compare(row[column], '=', v)) !== negate;
    }
    const op = peek();
    if (!op || op.t !== 'op') throw sdkError('ZCQL syntax error: expected a comparison', 400);
    pos += 1;
    const value = peek();
    if (!value || (value.t !== 'str' && value.t !== 'num')) throw sdkError('ZCQL syntax error: expected a value', 400);
    pos += 1;
    return (row) => compare(row[column], op.v, value.v);
  }
  function unary() {
    if (word('NOT')) { pos += 1; const inner = unary(); return (row) => !inner(row); }
    return primary();
  }
  function and() {
    let left = unary();
    while (word('AND')) { pos += 1; const l = left; const r = unary(); left = (row) => l(row) && r(row); }
    return left;
  }
  function or() {
    let left = and();
    while (word('OR')) { pos += 1; const l = left; const r = and(); left = (row) => l(row) || r(row); }
    return left;
  }
  const fn = or();
  if (pos !== tokens.length) throw sdkError('ZCQL syntax error: trailing tokens in WHERE', 400);
  return fn;
}

function compare(actual, op, expected) {
  const a = actual == null ? '' : String(actual);
  // Ids are 17-19 digits; Number() would make neighbours equal.
  if (/^-?\d+$/.test(a) && /^-?\d+$/.test(String(expected))) {
    const x = BigInt(a);
    const y = BigInt(expected);
    if (op === '=') return x === y;
    if (op === '!=' || op === '<>') return x !== y;
    if (op === '<') return x < y;
    if (op === '>') return x > y;
    if (op === '<=') return x <= y;
    if (op === '>=') return x >= y;
    return false;
  }
  const numeric = a !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(expected));
  const left = numeric ? Number(a) : a;
  const right = numeric ? Number(expected) : String(expected);
  switch (op) {
    case '=': return left === right;
    case '!=': case '<>': return left !== right;
    case '<': return left < right;
    case '>': return left > right;
    case '<=': return left <= right;
    case '>=': return left >= right;
    default: return false;
  }
}

function executeZCQLQuery(sql) {
  calls.push(['zcql', sql]);
  const del = /^DELETE FROM ([A-Za-z_][A-Za-z0-9_]*)(?: WHERE (.+))?$/.exec(sql.trim());
  if (del) {
    const predicate = del[2] ? parsePredicate(tokenize(del[2])) : () => true;
    const store = rowsOf(del[1]);
    let count = 0;
    for (let i = store.length - 1; i >= 0; i -= 1) {
      if (predicate(store[i])) {
        store.splice(i, 1);
        count += 1;
      }
    }
    return { DELETED_ROWS_COUNT: count };
  }
  const m = /^SELECT (\*|[A-Za-z_][A-Za-z0-9_]*(?:, *[A-Za-z_][A-Za-z0-9_]*)*) FROM ([A-Za-z_][A-Za-z0-9_]*)(?: WHERE (.+?))?(?: ORDER BY ([A-Za-z0-9_ ,]+?))? LIMIT (\d+)(?:, (\d+))?$/.exec(sql.trim());
  if (!m) throw sdkError(`ZCQL syntax error: ${sql}`, 400);
  const [, select, name, where, orderBy, first, count] = m;
  const limit = Number(count ?? first);
  // A bare LIMIT n is the first n rows. LIMIT a, b is 1-based, and 0 clamps to 1.
  const skip = count === undefined ? 0 : Math.max(0, Number(first) - 1);
  if (limit > 300) throw sdkError('ZCQL CANNOT HAVE MORE THAN 300 ROWS in LIMIT', 400);
  const predicate = where ? parsePredicate(tokenize(where)) : () => true;
  let rows = rowsOf(name).filter(predicate);
  if (orderBy) {
    const keys = orderBy.split(',').map((part) => part.trim().split(/\s+/));
    rows = [...rows].sort((x, y) => {
      for (const [field, dir] of keys) {
        const a = x[field] ?? '';
        const b = y[field] ?? '';
        const cmp = field === 'ROWID' ? (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0) : a < b ? -1 : a > b ? 1 : 0;
        if (cmp) return (dir || '').toUpperCase() === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });
  }
  const cols = select === '*' ? null : select.split(',').map((col) => col.trim());
  const project = (row) => (cols ? Object.fromEntries(cols.map((col) => [col, row[col]])) : { ...row });
  return rows.slice(skip, skip + limit).map((row) => ({ [name]: project(row) }));
}

function initialize(req, opts) {
  const admin = opts && opts.scope === 'admin';
  return {
    userManagement() {
      return {
        async getCurrentUser() {
          if (admin) throw sdkError('no user credentials present', 401);
          // The generated client sends the Web SDK token in `authorization`; the
          // session cookie is the embedded-login path. Either names a session.
          const authz = String((req && req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
          const user = sessions.get(cookie(req, 'c2c-harness-session')) ?? sessions.get(authz);
          return user ? { ...user, role_details: { ...user.role_details } } : null;
        },
      };
    },
    datastore() {
      return { table };
    },
    zcql() {
      return { executeZCQLQuery: async (sql) => executeZCQLQuery(sql) };
    },
  };
}

function setSession(token, user) {
  sessions.set(token, user);
}

/** Replace the unique-column declaration: { <table>: [<column>, ...] }. */
function setUnique(declared) {
  uniqueColumns = new Map(Object.entries(declared || {}).map(([name, columns]) => [name, [...columns]]));
}

/** Replace the foreign-key column declaration: { <table>: [<column>, ...] }. */
function setForeignKeys(declared) {
  foreignKeyColumns = new Map(Object.entries(declared || {}).map(([name, columns]) => [name, [...columns]]));
}

function state() {
  return { tables: Object.fromEntries([...tables.entries()].sort()), calls: [...calls] };
}

module.exports = { initialize, setSession, setUnique, setForeignKeys, state, executeZCQLQuery, __fake: true };
