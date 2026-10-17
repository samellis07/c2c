/**
 * Shape C in the htmlpage snippet engine: handle setup writes (insert into /
 * update inside page snippets guarded by zoho.adminuserid / zoho.loginuserid
 * checks) in server-rendered endpoints.
 *
 * Rules:
 * 1. Writes must not be inside loops (forEach or while).
 * 2. Every write must be guarded by an enclosing if test that is exactly
 *    `zoho.loginuserid == zoho.adminuserid` — the only comparison that proves
 *    the authenticated app admin is the caller. An existence check over an
 *    identity-scoped read (a count or null test on `Form[... == zoho.*userid]`)
 *    says nothing about who is calling and is not a guard.
 * 3. Statements and expressions outside read-only constructs are limited to
 *    insert, update, and criteria/record field assignments.
 * 4. Runtime shims allow datastore.insert, datastore.update, and
 *    datastore.setField in addition to read-only shims, with no functions.*
 *    and no unshimmed awaits.
 */

import type { Expr, Script, Stmt } from '../../deluge/src/ast.js';
import {
  assignsCriteriaField,
  assignsDatastoreRead,
  fieldNameOk,
  mutatesFetchedRead,
  readOnlyShim,
} from './htmlpage.js';

const SHAPE_C_SHIM = new Set(['datastore.insert', 'datastore.update', 'datastore.setField']);

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

function isWriteExpr(e: Expr): boolean {
  return e.kind === 'insert';
}

/** True when the AST contains any setup write (insert into, update, or field write). */
export function hasShapeCWrites(ast: Script): boolean {
  const criteriaVars = collectCriteriaVars(ast);
  let found = false;
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

/**
 * Verifies writes are not inside loops and every write sits under an if test
 * that is exactly `zoho.loginuserid == zoho.adminuserid`.
 */
export function isShapeCGuarded(ast: Script): boolean {
  const criteriaVars = collectCriteriaVars(ast);

  let allWritesValid = true;
  let writeCount = 0;

  function checkExpr(e: Expr, inLoop: boolean, isGuarded: boolean): void {
    if (isWriteExpr(e)) {
      writeCount++;
      if (inLoop || !isGuarded) {
        allWritesValid = false;
      }
    }
    switch (e.kind) {
      case 'list':
        for (const el of e.elements) checkExpr(el, inLoop, isGuarded);
        break;
      case 'map':
        for (const en of e.entries) {
          checkExpr(en.key, inLoop, isGuarded);
          checkExpr(en.value, inLoop, isGuarded);
        }
        break;
      case 'unary':
      case 'paren':
        checkExpr(e.expr, inLoop, isGuarded);
        break;
      case 'binary':
        checkExpr(e.left, inLoop, isGuarded);
        checkExpr(e.right, inLoop, isGuarded);
        break;
      case 'member':
        checkExpr(e.object, inLoop, isGuarded);
        break;
      case 'call':
        checkExpr(e.callee, inLoop, isGuarded);
        for (const arg of e.args) checkExpr(arg, inLoop, isGuarded);
        break;
      case 'index':
        checkExpr(e.object, inLoop, isGuarded);
        checkExpr(e.index, inLoop, isGuarded);
        break;
      case 'criteria':
        checkExpr(e.object, inLoop, isGuarded);
        checkExpr(e.criteria, inLoop, isGuarded);
        if (e.range) {
          checkExpr(e.range.from, inLoop, isGuarded);
          checkExpr(e.range.to, inLoop, isGuarded);
        }
        break;
      case 'ifExpr': {
        const testGuarded = isAuthenticatedAdminGuard(e.test);
        checkExpr(e.test, inLoop, isGuarded);
        checkExpr(e.then, inLoop, isGuarded || testGuarded);
        if (e.else) checkExpr(e.else, inLoop, isGuarded);
        break;
      }
      case 'insert':
        checkExpr(e.form, inLoop, isGuarded);
        for (const en of e.entries) checkExpr(en.value, inLoop, isGuarded);
        break;
      case 'invokeurl':
      case 'sendmail':
      case 'pushnotification':
        for (const en of e.entries) checkExpr(en.value, inLoop, isGuarded);
        break;
      case 'colonCall':
        checkExpr(e.object, inLoop, isGuarded);
        for (const arg of e.args) checkExpr(arg, inLoop, isGuarded);
        break;
      default:
        break;
    }
  }

  function checkStmt(s: Stmt, inLoop: boolean, isGuarded: boolean): void {
    if (isWriteStmt(s, criteriaVars)) {
      writeCount++;
      if (inLoop || !isGuarded) {
        allWritesValid = false;
      }
    }
    switch (s.kind) {
      case 'block':
        for (const child of s.body) checkStmt(child, inLoop, isGuarded);
        break;
      case 'if': {
        const testGuarded = isAuthenticatedAdminGuard(s.test);
        checkExpr(s.test, inLoop, isGuarded);
        checkStmt(s.then, inLoop, isGuarded || testGuarded);
        for (const elif of s.elifs) {
          const elifGuarded = isAuthenticatedAdminGuard(elif.test);
          checkExpr(elif.test, inLoop, isGuarded);
          checkStmt(elif.body, inLoop, isGuarded || elifGuarded);
        }
        if (s.else) checkStmt(s.else, inLoop, isGuarded);
        break;
      }
      case 'forEach':
        checkExpr(s.collection, inLoop, isGuarded);
        checkStmt(s.body, true, isGuarded);
        break;
      case 'while':
        checkExpr(s.test, inLoop, isGuarded);
        checkStmt(s.body, true, isGuarded);
        break;
      case 'try':
        checkStmt(s.body, inLoop, isGuarded);
        if (s.catchBody) checkStmt(s.catchBody, inLoop, isGuarded);
        break;
      case 'assign':
        checkExpr(s.target, inLoop, isGuarded);
        checkExpr(s.value, inLoop, isGuarded);
        break;
      case 'expr':
        checkExpr(s.expr, inLoop, isGuarded);
        break;
      case 'update':
        checkExpr(s.target, inLoop, isGuarded);
        for (const en of s.entries) checkExpr(en.value, inLoop, isGuarded);
        break;
      case 'return':
      case 'info':
      case 'alert':
      case 'successMessage':
        if (s.value) checkExpr(s.value, inLoop, isGuarded);
        break;
      case 'openUrl':
        for (const arg of s.args) checkExpr(arg, inLoop, isGuarded);
        break;
      default:
        break;
    }
  }

  for (const s of ast.body) {
    checkStmt(s, false, false);
  }

  return writeCount > 0 && allWritesValid;
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
 * datastore.setField, ensuring no functions.* and no unshimmed awaits.
 */
export function shapeCServerOk(server: string): boolean {
  if (/\bfunctions\./.test(server)) return false;
  for (const match of server.matchAll(/\bshim\.([A-Za-z_][\w.]*)\s*\(/g)) {
    const name = match[1] ?? '';
    if (!readOnlyShim(name) && !SHAPE_C_SHIM.has(name)) return false;
  }
  if (assignsDatastoreRead(server) || mutatesFetchedRead(server)) return false;
  if (/\bawait\s+(?!shim\.)/.test(server)) return false;
  return true;
}
