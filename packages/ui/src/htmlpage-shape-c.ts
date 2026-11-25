/**
 * Shape C in the htmlpage snippet engine: handle setup writes (insert into /
 * update inside page snippets guarded by zoho.adminuserid / zoho.loginuserid
 * checks) in server-rendered endpoints.
 *
 * Rules:
 * 1. Writes must not be inside loops (forEach or while).
 * 2. Every write must be guarded by an enclosing if test that is either
 *    (a) exactly `zoho.loginuserid == zoho.adminuserid`, or
 *    (b) a provisioning existence check: `read.count() == 0` or `<= 0`, where
 *        the read is `Form[Field == zoho.loginuserid]` or
 *        `Form[Field == zoho.adminuserid]` — a plain equality on one identity
 *        slot with no other operand — bound once to a variable directly, or
 *        spelled inline, and never reassigned. Under (b) the only write is an
 *        `insert into` the same form that binds the checked field exactly once
 *        to `zoho.loginuserid` or to the slot the check read (the server
 *        resolves either to the authenticated caller, never a client value;
 *        an administrator check also requires the caller to be the owner).
 *        No other identity-like field in that
 *        insert may read a client value. The same guard also covers `rec.Field = value`
 *        for a `rec` bound once to that identical read, when the field is not identity-like and
 *        the value does not read a client value: the record is the one the insert just created. A `zoho.adminuserid`-scoped check (b)
 *        additionally requires the caller to be the application owner at
 *        runtime (the endpoint compares the principal to C2C_ADMIN_USER_ID).
 *    A null test, a looser comparison, or any extra operand (`||`, `&&`)
 *    is not a guard.
 * 3. Statements and expressions outside read-only constructs are limited to
 *    insert, update, and criteria/record field assignments.
 * 4. Runtime shims allow datastore.insert, datastore.update, and
 *    datastore.setField in addition to read-only shims, with no functions.*
 *    and no unshimmed awaits.
 */

import type { Expr, Script, Stmt } from '../../deluge/src/ast.js';
import {
  appCallPath,
  assignsCriteriaField,
  assignsDatastoreRead,
  fieldNameOk,
  mutatesFetchedRead,
  readOnlyShim,
} from './htmlpage.js';

const SHAPE_C_SHIM = new Set(['datastore.insert', 'datastore.update', 'datastore.setField']);
/** The queued row writes a sweep translates to: each assignment is checked when made, the flush applies them. */
const SWEEP_SHIM = new Set(['record.set', 'datastore.flush']);

function walkExpr(e: Expr, onExpr: (e: Expr) => void): void {
  onExpr(e);
  switch (e.kind) {
    case 'list':
      for (const el of e.elements) walkExpr(el, onExpr);
      break;
    case 'map':
      for (const en of e.entries) {
        walkExpr(en.key, onExpr);
        walkExpr(en.value, onExpr);
      }
      break;
    case 'unary':
    case 'paren':
      walkExpr(e.expr, onExpr);
      break;
    case 'binary':
      walkExpr(e.left, onExpr);
      walkExpr(e.right, onExpr);
      break;
    case 'member':
      walkExpr(e.object, onExpr);
      break;
    case 'call':
      walkExpr(e.callee, onExpr);
      for (const arg of e.args) walkExpr(arg, onExpr);
      break;
    case 'index':
      walkExpr(e.object, onExpr);
      walkExpr(e.index, onExpr);
      break;
    case 'criteria':
      walkExpr(e.object, onExpr);
      walkExpr(e.criteria, onExpr);
      if (e.range) {
        walkExpr(e.range.from, onExpr);
        walkExpr(e.range.to, onExpr);
      }
      break;
    case 'ifExpr':
      walkExpr(e.test, onExpr);
      walkExpr(e.then, onExpr);
      if (e.else) walkExpr(e.else, onExpr);
      break;
    case 'insert':
      walkExpr(e.form, onExpr);
      for (const en of e.entries) walkExpr(en.value, onExpr);
      break;
    case 'invokeurl':
    case 'sendmail':
    case 'pushnotification':
      for (const en of e.entries) walkExpr(en.value, onExpr);
      break;
    case 'colonCall':
      walkExpr(e.object, onExpr);
      for (const arg of e.args) walkExpr(arg, onExpr);
      break;
    default:
      break;
  }
}

function walkStmt(s: Stmt, onStmt: (s: Stmt) => void, onExpr: (e: Expr) => void): void {
  onStmt(s);
  switch (s.kind) {
    case 'block':
      for (const child of s.body) walkStmt(child, onStmt, onExpr);
      break;
    case 'if':
      walkExpr(s.test, onExpr);
      walkStmt(s.then, onStmt, onExpr);
      for (const elif of s.elifs) {
        walkExpr(elif.test, onExpr);
        walkStmt(elif.body, onStmt, onExpr);
      }
      if (s.else) walkStmt(s.else, onStmt, onExpr);
      break;
    case 'forEach':
      walkExpr(s.collection, onExpr);
      walkStmt(s.body, onStmt, onExpr);
      break;
    case 'while':
      walkExpr(s.test, onExpr);
      walkStmt(s.body, onStmt, onExpr);
      break;
    case 'try':
      walkStmt(s.body, onStmt, onExpr);
      if (s.catchBody) walkStmt(s.catchBody, onStmt, onExpr);
      break;
    case 'return':
    case 'info':
    case 'alert':
    case 'successMessage':
      if (s.value) walkExpr(s.value, onExpr);
      break;
    case 'openUrl':
      for (const arg of s.args) walkExpr(arg, onExpr);
      break;
    case 'deleteFrom':
      walkExpr(s.target, onExpr);
      break;
    case 'update':
      walkExpr(s.target, onExpr);
      for (const en of s.entries) walkExpr(en.value, onExpr);
      break;
    case 'assign':
      walkExpr(s.target, onExpr);
      walkExpr(s.value, onExpr);
      break;
    case 'expr':
      walkExpr(s.expr, onExpr);
      break;
    case 'fn':
      walkStmt(s.body, onStmt, onExpr);
      break;
    default:
      break;
  }
}

function exprHasCriteria(e: Expr): boolean {
  let hasCrit = false;
  walkExpr(e, (node) => {
    if (node.kind === 'criteria') hasCrit = true;
  });
  return hasCrit;
}

function collectCriteriaVars(ast: Script): Set<string> {
  const vars = new Set<string>();
  for (const s of ast.body) {
    walkStmt(
      s,
      (stmt) => {
        if (stmt.kind === 'assign' && stmt.target.kind === 'name' && exprHasCriteria(stmt.value)) {
          vars.add(stmt.target.name.toLowerCase());
        }
      },
      () => {},
    );
  }
  return vars;
}

function unwrap(e: Expr): Expr {
  while (e.kind === 'paren') e = e.expr;
  return e;
}

/** The operands of an `a && b && c` chain, looking through parentheses. */
function conjuncts(e: Expr): Expr[] {
  e = unwrap(e);
  if (e.kind === 'binary' && (e.op === '&&' || e.op.toLowerCase() === 'and')) return [...conjuncts(e.left), ...conjuncts(e.right)];
  return [e];
}

/** Only this exact comparison proves that the authenticated app admin is the caller. */
function isAuthenticatedAdminGuard(e: Expr): boolean {
  e = unwrap(e);
  if (e.kind !== 'binary' || e.op !== '==') return false;
  const isIdentity = (value: Expr, property: string) => {
    value = unwrap(value);
    return value.kind === 'member' && value.object.kind === 'name' &&
      value.object.name.toLowerCase() === 'zoho' && value.property.toLowerCase() === property;
  };
  return (isIdentity(e.left, 'loginuserid') && isIdentity(e.right, 'adminuserid')) ||
    (isIdentity(e.right, 'loginuserid') && isIdentity(e.left, 'adminuserid'));
}

/** `zoho.loginuserid` or `zoho.adminuserid` member. */
function identityProp(e: Expr): 'loginuserid' | 'adminuserid' | null {
  e = unwrap(e);
  if (e.kind !== 'member') return null;
  const object = unwrap(e.object);
  if (object.kind !== 'name' || object.name.toLowerCase() !== 'zoho') return null;
  const prop = e.property.toLowerCase();
  return prop === 'loginuserid' || prop === 'adminuserid' ? prop : null;
}

interface IdentityRead {
  form: string;
  field: string;
  prop: 'loginuserid' | 'adminuserid';
}

/**
 * `Form[Field == zoho.loginuserid]` / `Form[Field == zoho.adminuserid]` — a
 * plain equality between one field and one identity slot and nothing else:
 * no second criteria term, no sort, no range.
 */
function identityRead(e: Expr): IdentityRead | null {
  e = unwrap(e);
  if (e.kind !== 'criteria' || e.sort || e.range) return null;
  const object = unwrap(e.object);
  if (object.kind !== 'name') return null;
  const crit = unwrap(e.criteria);
  if (crit.kind !== 'binary' || crit.op !== '==') return null;
  const left = unwrap(crit.left);
  const right = unwrap(crit.right);
  if (left.kind === 'name') {
    const prop = identityProp(right);
    return prop ? { form: object.name, field: left.name, prop } : null;
  }
  if (right.kind === 'name') {
    const prop = identityProp(left);
    return prop ? { form: object.name, field: right.name, prop } : null;
  }
  return null;
}

/** `Form[ID != 0]`: every record of one form, nothing else (no second term, sort or range). */
function allRecordsRead(e: Expr): { form: string } | null {
  e = unwrap(e);
  if (e.kind !== 'criteria' || e.sort || e.range) return null;
  const object = unwrap(e.object);
  if (object.kind !== 'name') return null;
  const crit = unwrap(e.criteria);
  if (crit.kind !== 'binary' || crit.op !== '!=') return null;
  const left = unwrap(crit.left);
  const right = unwrap(crit.right);
  if (left.kind !== 'name' || left.name.toLowerCase() !== 'id') return null;
  if (right.kind !== 'number' || Number(right.text) !== 0) return null;
  return { form: object.name };
}

interface StmtMeta {
  seq: number;
  chain: Stmt[];
}

/** Preorder sequence and the enclosing statement chain of every statement. */
function indexStmts(ast: Script): Map<Stmt, StmtMeta> {
  const meta = new Map<Stmt, StmtMeta>();
  let seq = 0;
  const visit = (s: Stmt, chain: Stmt[]) => {
    meta.set(s, { seq: seq++, chain });
    const inner = [...chain, s];
    switch (s.kind) {
      case 'block':
        for (const child of s.body) visit(child, inner);
        break;
      case 'if':
        visit(s.then, inner);
        for (const elif of s.elifs) visit(elif.body, inner);
        if (s.else) visit(s.else, inner);
        break;
      case 'forEach':
      case 'while':
      case 'fn':
        visit(s.body, inner);
        break;
      case 'try':
        visit(s.body, inner);
        if (s.catchBody) visit(s.catchBody, inner);
        break;
      default:
        break;
    }
  };
  for (const s of ast.body) visit(s, []);
  return meta;
}

interface AssignInfo {
  op: string;
  value: Expr;
  meta: StmtMeta;
}

/** All `name <op> value` assignments, by lowercased variable name. */
function collectAssigns(ast: Script, meta: Map<Stmt, StmtMeta>): Map<string, AssignInfo[]> {
  const assigns = new Map<string, AssignInfo[]>();
  // determinism-allow: meta is populated by a source-order AST walk, so this preserves assignment order
  for (const [stmt, info] of meta) {
    if (stmt.kind === 'assign' && stmt.target.kind === 'name') {
      const key = stmt.target.name.toLowerCase();
      const list = assigns.get(key) ?? [];
      list.push({ op: stmt.op, value: stmt.value, meta: info });
      assigns.set(key, list);
    }
  }
  return assigns;
}

/**
 * The value a name is bound to by exactly one `=` assignment that precedes and
 * dominates the if (its enclosing chain is a prefix of the if's chain, so no
 * branch can skip it and no reassignment is possible), else null.
 */
function boundOnce(name: string, ifMeta: StmtMeta, assigns: Map<string, AssignInfo[]>): Expr | null {
  const binds = assigns.get(name.toLowerCase());
  if (!binds || binds.length !== 1 || binds[0]!.op !== '=') return null;
  const bind = binds[0];
  if (bind.meta.seq >= ifMeta.seq || bind.meta.chain.length > ifMeta.chain.length) return null;
  for (let i = 0; i < bind.meta.chain.length; i++) {
    if (bind.meta.chain[i] !== ifMeta.chain[i]) return null;
  }
  return bind.value;
}

/**
 * The provisioning existence check: `read.count() == 0` / `read.count() <= 0`
 * and nothing else, or the same test on a name bound once to `read.count()`.
 * The receiver is an inline `Form[Field == zoho.*userid]` read or a variable
 * bound once, before and above the if, to that read.
 */
function provisioningRead(
  test: Expr,
  ifMeta: StmtMeta,
  assigns: Map<string, AssignInfo[]>,
): ProvisionRead | null {
  test = unwrap(test);
  if (test.kind !== 'binary' || (test.op !== '==' && test.op !== '<=')) return null;
  const right = unwrap(test.right);
  if (right.kind !== 'number' || Number(right.text) !== 0) return null;
  let left = unwrap(test.left);
  if (left.kind === 'name') {
    const counted = boundOnce(left.name, ifMeta, assigns);
    if (!counted) return null;
    left = unwrap(counted);
  }
  if (left.kind !== 'call' || left.args.length !== 0) return null;
  const callee = unwrap(left.callee);
  if (callee.kind !== 'member' || callee.property.toLowerCase() !== 'count') return null;
  const recv = unwrap(callee.object);
  if (recv.kind === 'criteria') return identityRead(recv) ?? allRecordsRead(recv);
  if (recv.kind !== 'name') return null;
  const read = boundOnce(recv.name, ifMeta, assigns);
  return read ? (identityRead(read) ?? allRecordsRead(read)) : null;
}

/** An identity existence check, or the empty-form check `Form[ID != 0].count() == 0`. */
type ProvisionRead = IdentityRead | { form: string };

type WriteGuard =
  | { kind: 'none' }
  | { kind: 'admin' }
  | { kind: 'provision'; read: ProvisionRead };

const NO_GUARD: WriteGuard = { kind: 'none' };

const IDENTITY_FIELD = /email|user|owner|login|creatorid/i;

/** A value that reads the page's client input, directly or through an assigned name. */
function readsClientInput(e: Expr, assigns: Map<string, AssignInfo[]>, seen = new Set<string>()): boolean {
  let found = false;
  walkExpr(e, (node) => {
    if (found) return;
    if (node.kind !== 'name') return;
    const name = node.name.toLowerCase();
    if (name === 'input') {
      found = true;
      return;
    }
    if (seen.has(name)) return;
    seen.add(name);
    for (const bind of assigns.get(name) ?? []) {
      if (readsClientInput(bind.value, assigns, seen)) {
        found = true;
        return;
      }
    }
  });
  return found;
}

/**
 * Under a provisioning existence check the only write is `insert into` the
 * same form, binding the checked field exactly once to `zoho.loginuserid`; the
 * runtime resolves that slot to the authenticated caller, never a client value.
 * Any identity-like field reading `input` makes the insert unsafe, because a
 * duplicate or sibling binding can overwrite the identity the guard checked.
 * A write sitting under several guards is allowed by any one of them.
 */
function writeExprOk(e: Expr, guard: WriteGuard, assigns: Map<string, AssignInfo[]>): boolean {
  if (guard.kind === 'admin') return true;
  if (guard.kind !== 'provision' || e.kind !== 'insert') return false;
  const read = guard.read;
  const form = unwrap(e.form);
  if (form.kind !== 'name' || form.name.toLowerCase() !== read.form.toLowerCase()) return false;
  if (!('field' in read)) {
    // Empty-form bootstrap: the form holds no record yet, so the insert may seed it. No
    // value may come from the request, so the first caller cannot choose what is stored.
    return !e.entries.some((en) => readsClientInput(en.value, assigns));
  }
  const checked = e.entries.filter((en) => en.key.toLowerCase() === read.field.toLowerCase());
  // The caller's own id, or the id the check read: under an administrator check the endpoint requires the caller to be the owner.
  const bound = identityProp(checked[0]?.value as Expr);
  if (checked.length !== 1 || (bound !== 'loginuserid' && bound !== read.prop)) return false;
  return !e.entries.some((en) => IDENTITY_FIELD.test(en.key) && readsClientInput(en.value, assigns));
}

/**
 * Under a provisioning existence check on an identity slot, a field set on the record that same check read:
 * the name is bound once, above the write, to the identical `Form[Field == zoho.*userid]` read, so the write
 * reaches only the record the guarded insert just created for that identity (the check proved none existed).
 * An identity-like field, or a value that reads the request, is never set this way.
 */
function provisionedFieldWriteOk(s: Stmt, guard: WriteGuard, at: StmtMeta | undefined, assigns: Map<string, AssignInfo[]>): boolean {
  if (guard.kind !== 'provision' || !('field' in guard.read) || !at) return false;
  if (s.kind !== 'assign' || s.op !== '=' || s.target.kind !== 'member') return false;
  const record = unwrap(s.target.object);
  if (record.kind !== 'name' || IDENTITY_FIELD.test(s.target.property) || readsClientInput(s.value, assigns)) return false;
  const bound = boundOnce(record.name, at, assigns);
  const read = bound ? identityRead(bound) : null;
  return !!read && read.prop === guard.read.prop && read.form.toLowerCase() === guard.read.form.toLowerCase() && read.field.toLowerCase() === guard.read.field.toLowerCase();
}

function isWriteStmt(s: Stmt, criteriaVars: Set<string>): boolean {
  if (s.kind === 'update') return true;
  if (s.kind === 'assign') {
    if (assignsCriteriaField(s.target)) return true;
    if (s.target.kind === 'member') {
      let cur: Expr = s.target;
      while (cur.kind === 'member' || cur.kind === 'paren') {
        cur = cur.kind === 'member' ? cur.object : cur.expr;
      }
      if (cur.kind === 'name' && criteriaVars.has(cur.name.toLowerCase())) return true;
    }
  }
  return false;
}

function rootName(e: Expr): string | null {
  let cur: Expr = e;
  while (cur.kind === 'member' || cur.kind === 'index' || cur.kind === 'paren' || cur.kind === 'call') {
    cur = cur.kind === 'paren' ? cur.expr : cur.kind === 'call' ? cur.callee : cur.object;
  }
  return cur.kind === 'name' ? cur.name.toLowerCase() : null;
}

/**
 * Names that can hold a fetched record or collection: assigned from a read,
 * from another such name, or the row variable of a loop over one. Order and
 * branches are ignored, so a name that is ever bound that way counts.
 */
function recordNames(ast: Script): Set<string> {
  const bound = new Set<string>();
  const holds = (e: Expr): boolean => {
    e = unwrap(e);
    if (exprHasCriteria(e)) return true;
    const root = rootName(e);
    return root !== null && bound.has(root);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const root of ast.body) {
      walkStmt(
        root,
        (stmt) => {
          let name: string | undefined;
          if (stmt.kind === 'assign' && stmt.target.kind === 'name' && stmt.op === '=' && holds(stmt.value)) name = stmt.target.name.toLowerCase();
          if (stmt.kind === 'forEach' && !stmt.iteratesIndex && !stmt.index && holds(stmt.collection)) name = stmt.name.toLowerCase();
          if (name !== undefined && !bound.has(name)) {
            bound.add(name);
            changed = true;
          }
        },
        () => {},
      );
    }
  }
  return bound;
}

/**
 * Sweeps: `for each r in Form[criteria] { r.Field = value; ... }` whose
 * criteria and values come from the snippet and the server clock (never the
 * request) and whose body holds nothing but field assignments to the row
 * variable. Creator rewrites the matching rows on every render; the generated
 * route does the same per row through the checked write path, once per render.
 */
function findSweeps(ast: Script, assigns: Map<string, AssignInfo[]>): Set<Stmt> {
  const sweeps = new Set<Stmt>();
  for (const root of ast.body) {
    walkStmt(
      root,
      (stmt) => {
        if (stmt.kind !== 'forEach' || stmt.iteratesIndex || stmt.index) return;
        const collection = unwrap(stmt.collection);
        if (collection.kind !== 'criteria' || unwrap(collection.object).kind !== 'name') return;
        if (!shapeCExprOk(collection) || readsClientInput(collection, assigns)) return;
        const loopVar = stmt.name.toLowerCase();
        const body = stmt.body.kind === 'block' ? stmt.body.body : [stmt.body];
        if (body.length === 0) return;
        const loopVarOnly = (e: Expr) => {
          let ok = true;
          walkExpr(e, (node) => {
            if (node.kind === 'criteria' || node.kind === 'insert') ok = false;
            if (node.kind === 'name' && node.name.toLowerCase() !== 'zoho' && node.name.toLowerCase() !== loopVar) ok = false;
          });
          return ok;
        };
        const assignsRow = body.every((inner) => {
          if (inner.kind !== 'assign' || inner.op !== '=' || inner.target.kind !== 'member') return false;
          const object = unwrap(inner.target.object);
          if (object.kind !== 'name' || object.name.toLowerCase() !== loopVar) return false;
          return shapeCExprOk(inner.value) && loopVarOnly(inner.value);
        });
        if (assignsRow) sweeps.add(stmt);
      },
      () => {},
    );
  }
  return sweeps;
}

function isWriteExpr(e: Expr): boolean {
  return e.kind === 'insert';
}

/**
 * True when a field is written through a fetched record or collection in a
 * way the guard rules do not cover: a row variable of a loop, an element by
 * index, or an alias of either. A sweep's own assignments and the whole-record
 * variables the admin guard handles do not count.
 */
export function hasUnguardedRecordWrite(ast: Script): boolean {
  const meta = indexStmts(ast);
  const sweeps = findSweeps(ast, collectAssigns(ast, meta));
  const covered = collectCriteriaVars(ast);
  const bound = recordNames(ast);
  let found = false;
  const visit = (s: Stmt): void => {
    if (found || sweeps.has(s)) return;
    if (s.kind === 'assign' && s.target.kind !== 'name') {
      const root = rootName(s.target);
      const viaIndex = (() => {
        let cur = s.target as Expr;
        while (cur.kind === 'member' || cur.kind === 'index' || cur.kind === 'paren' || cur.kind === 'call') {
          if (cur.kind === 'index' || cur.kind === 'call') return true;
          cur = cur.kind === 'paren' ? cur.expr : cur.object;
        }
        return false;
      })();
      if (root !== null && bound.has(root) && (viaIndex || !covered.has(root))) found = true;
    }
    switch (s.kind) {
      case 'block':
        s.body.forEach(visit);
        break;
      case 'if':
        visit(s.then);
        s.elifs.forEach((elif) => visit(elif.body));
        if (s.else) visit(s.else);
        break;
      case 'forEach':
      case 'while':
        visit(s.body);
        break;
      case 'try':
        visit(s.body);
        if (s.catchBody) visit(s.catchBody);
        break;
      default:
        break;
    }
  };
  ast.body.forEach(visit);
  return found;
}

/** True when the AST contains any setup write (insert into, update, or field write). */
export function hasShapeCWrites(ast: Script): boolean {
  const criteriaVars = collectCriteriaVars(ast);
  let found = findSweeps(ast, collectAssigns(ast, indexStmts(ast))).size > 0;
  for (const s of ast.body) {
    walkStmt(
      s,
      (stmt) => {
        if (isWriteStmt(stmt, criteriaVars)) found = true;
      },
      (expr) => {
        if (isWriteExpr(expr)) found = true;
      },
    );
  }
  return found;
}

export interface ShapeCGuard {
  /** Writes exist and every write sits under a valid guard. */
  ok: boolean;
  /**
   * A `zoho.adminuserid`-scoped existence check guards a write: the endpoint
   * must additionally verify the caller is the application owner
   * (`C2C_ADMIN_USER_ID`) before any write runs.
   */
  requireOwner: boolean;
  /** The snippet holds a sweep, whose row assignments translate to queued writes and one flush. */
  sweeps: boolean;
}

/**
 * Verifies writes are not inside loops and every write sits under an if test
 * that is exactly `zoho.loginuserid == zoho.adminuserid`, or under the tight
 * provisioning existence check (see the file header).
 */
export function isShapeCGuarded(ast: Script): ShapeCGuard {
  const criteriaVars = collectCriteriaVars(ast);
  const meta = indexStmts(ast);
  const assigns = collectAssigns(ast, meta);
  const sweeps = findSweeps(ast, assigns);

  let allWritesValid = true;
  let writeCount = 0;
  let requireOwner = false;
  const provisionWrites = new Map<WriteGuard, number>();

  function testGuard(test: Expr, ifMeta: StmtMeta | undefined): WriteGuard {
    // `admin && other`: the then-branch runs only when the admin comparison holds.
    if (conjuncts(test).some(isAuthenticatedAdminGuard)) return { kind: 'admin' };
    if (!ifMeta) return NO_GUARD;
    const read = provisioningRead(test, ifMeta, assigns);
    if (!read) return NO_GUARD;
    if ('prop' in read && read.prop === 'adminuserid') requireOwner = true;
    return { kind: 'provision', read };
  }

  function checkExpr(e: Expr, inLoop: boolean, guards: WriteGuard[], ifMeta?: StmtMeta): void {
    if (isWriteExpr(e)) {
      writeCount++;
      const allowedBy = guards.filter((guard) => writeExprOk(e, guard, assigns));
      if (inLoop || allowedBy.length === 0) allWritesValid = false;
      for (const guard of allowedBy) {
        if (guard.kind !== 'provision') continue;
        const count = (provisionWrites.get(guard) ?? 0) + 1;
        provisionWrites.set(guard, count);
        if (count > 1) allWritesValid = false;
      }
    }
    switch (e.kind) {
      case 'list':
        for (const el of e.elements) checkExpr(el, inLoop, guards);
        break;
      case 'map':
        for (const en of e.entries) {
          checkExpr(en.key, inLoop, guards);
          checkExpr(en.value, inLoop, guards);
        }
        break;
      case 'unary':
      case 'paren':
        checkExpr(e.expr, inLoop, guards);
        break;
      case 'binary':
        checkExpr(e.left, inLoop, guards);
        checkExpr(e.right, inLoop, guards);
        break;
      case 'member':
        checkExpr(e.object, inLoop, guards);
        break;
      case 'call':
        checkExpr(e.callee, inLoop, guards);
        for (const arg of e.args) checkExpr(arg, inLoop, guards);
        break;
      case 'index':
        checkExpr(e.object, inLoop, guards);
        checkExpr(e.index, inLoop, guards);
        break;
      case 'criteria':
        checkExpr(e.object, inLoop, guards);
        checkExpr(e.criteria, inLoop, guards);
        if (e.range) {
          checkExpr(e.range.from, inLoop, guards);
          checkExpr(e.range.to, inLoop, guards);
        }
        break;
      case 'ifExpr': {
        const testGuarded = testGuard(e.test, ifMeta);
        checkExpr(e.test, inLoop, guards);
        checkExpr(e.then, inLoop, testGuarded.kind === 'none' ? guards : [...guards, testGuarded]);
        if (e.else) checkExpr(e.else, inLoop, guards);
        break;
      }
      case 'insert':
        checkExpr(e.form, inLoop, guards);
        for (const en of e.entries) checkExpr(en.value, inLoop, guards);
        break;
      case 'invokeurl':
      case 'sendmail':
      case 'pushnotification':
        for (const en of e.entries) checkExpr(en.value, inLoop, guards);
        break;
      case 'colonCall':
        checkExpr(e.object, inLoop, guards);
        for (const arg of e.args) checkExpr(arg, inLoop, guards);
        break;
      default:
        break;
    }
  }

  function checkStmt(s: Stmt, inLoop: boolean, guards: WriteGuard[]): void {
    if (isWriteStmt(s, criteriaVars)) {
      writeCount++;
      // Statement writes (update, field assignment) need the admin guard;
      // a provisioning existence check covers its bound insert and the fields set on the record it read.
      const stmtMeta = meta.get(s);
      if (inLoop || !guards.some((guard) => guard.kind === 'admin' || provisionedFieldWriteOk(s, guard, stmtMeta, assigns))) {
        allWritesValid = false;
      }
    }
    switch (s.kind) {
      case 'block':
        for (const child of s.body) checkStmt(child, inLoop, guards);
        break;
      case 'if': {
        const stmtMeta = meta.get(s);
        const testGuarded = testGuard(s.test, stmtMeta);
        checkExpr(s.test, inLoop, guards, stmtMeta);
        checkStmt(s.then, inLoop, testGuarded.kind === 'none' ? guards : [...guards, testGuarded]);
        for (const elif of s.elifs) {
          const elifGuarded = testGuard(elif.test, meta.get(s));
          checkExpr(elif.test, inLoop, guards);
          checkStmt(elif.body, inLoop, elifGuarded.kind === 'none' ? guards : [...guards, elifGuarded]);
        }
        if (s.else) checkStmt(s.else, inLoop, guards);
        break;
      }
      case 'forEach':
        checkExpr(s.collection, inLoop, guards);
        if (sweeps.has(s)) {
          // A sweep is the one loop that may write; it may not sit inside another loop.
          writeCount++;
          if (inLoop) allWritesValid = false;
          break;
        }
        checkStmt(s.body, true, guards);
        break;
      case 'while':
        checkExpr(s.test, inLoop, guards);
        checkStmt(s.body, true, guards);
        break;
      case 'try':
        checkStmt(s.body, inLoop, guards);
        if (s.catchBody) checkStmt(s.catchBody, inLoop, guards);
        break;
      case 'assign':
        checkExpr(s.target, inLoop, guards);
        checkExpr(s.value, inLoop, guards);
        break;
      case 'expr':
        checkExpr(s.expr, inLoop, guards);
        break;
      case 'update':
        checkExpr(s.target, inLoop, guards);
        for (const en of s.entries) checkExpr(en.value, inLoop, guards);
        break;
      case 'return':
      case 'info':
      case 'alert':
      case 'successMessage':
        if (s.value) checkExpr(s.value, inLoop, guards);
        break;
      case 'openUrl':
        for (const arg of s.args) checkExpr(arg, inLoop, guards);
        break;
      default:
        break;
    }
  }

  for (const s of ast.body) {
    checkStmt(s, false, []);
  }

  const ok = writeCount > 0 && allWritesValid;
  return { ok, requireOwner: ok && requireOwner, sweeps: ok && sweeps.size > 0 };
}

export function shapeCExprOk(e: Expr): boolean {
  switch (e.kind) {
    case 'number':
    case 'string':
    case 'date':
    case 'name':
    case 'relative':
      return true;
    case 'list':
      return e.elements.every(shapeCExprOk);
    case 'map':
      return e.entries.every((en) => shapeCExprOk(en.key) && shapeCExprOk(en.value));
    case 'unary':
    case 'paren':
      return shapeCExprOk(e.expr);
    case 'binary':
      return shapeCExprOk(e.left) && shapeCExprOk(e.right);
    case 'member':
      return shapeCExprOk(e.object);
    case 'call':
      return shapeCExprOk(e.callee) && e.args.every(shapeCExprOk);
    case 'index':
      return shapeCExprOk(e.object) && shapeCExprOk(e.index);
    case 'criteria':
      return (
        shapeCExprOk(e.object) &&
        shapeCExprOk(e.criteria) &&
        (!e.sort || (fieldNameOk(e.sort.field) && (e.sort.fields ?? []).every((f) => fieldNameOk(f.field)))) &&
        (!e.range || (shapeCExprOk(e.range.from) && shapeCExprOk(e.range.to)))
      );
    case 'ifExpr':
      return shapeCExprOk(e.test) && shapeCExprOk(e.then) && (!e.else || shapeCExprOk(e.else));
    case 'insert':
      return shapeCExprOk(e.form) && e.entries.every((en) => shapeCExprOk(en.value));
    default:
      return false;
  }
}

export function shapeCStmtOk(s: Stmt): boolean {
  switch (s.kind) {
    case 'block':
      return s.body.every(shapeCStmtOk);
    case 'if':
      return (
        shapeCExprOk(s.test) &&
        shapeCStmtOk(s.then) &&
        s.elifs.every((elif) => shapeCExprOk(elif.test) && shapeCStmtOk(elif.body)) &&
        (!s.else || shapeCStmtOk(s.else))
      );
    case 'assign':
      return shapeCExprOk(s.target) && shapeCExprOk(s.value);
    case 'expr':
      return shapeCExprOk(s.expr);
    case 'forEach':
      return shapeCExprOk(s.collection) && shapeCStmtOk(s.body);
    case 'update':
      return shapeCExprOk(s.target) && s.entries.every((en) => shapeCExprOk(en.value));
    default:
      return false;
  }
}

/**
 * Allows READ_ONLY_SHIM plus datastore.insert, datastore.update, and
 * datastore.setField, ensuring no functions.* and no unshimmed awaits. A
 * `thisapp.<fn>()` call passes only when `appCall` proves its callee read-only.
 */
export function shapeCServerOk(server: string, appCall?: (path: string[]) => boolean, sweeps = false): boolean {
  if (/\bfunctions\./.test(server)) return false;
  for (const match of server.matchAll(/\bshim\.([A-Za-z_][\w.]*)\s*\(/g)) {
    const name = match[1] ?? '';
    if (name === 'thisapp.call' && appCall) {
      const path = appCallPath(server.slice((match.index ?? 0) + match[0].length));
      if (!path || !appCall(path)) return false;
      continue;
    }
    if (!readOnlyShim(name) && !SHAPE_C_SHIM.has(name) && !(sweeps && SWEEP_SHIM.has(name))) return false;
  }
  if (assignsDatastoreRead(server) || mutatesFetchedRead(server)) return false;
  if (/\bawait\s+(?!shim\.)/.test(server)) return false;
  return true;
}
