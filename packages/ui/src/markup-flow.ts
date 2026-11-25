/**
 * Which values of a rendered page's script hold markup, and where the page
 * prints them. Creator prints `<%=value%>` raw, so a value built from HTML (a
 * string literal with tags, an app function that returns one, an image field)
 * shows as markup there. The generated endpoint prints such a value through
 * `c2cMarkup` (markup-value.ts) and every other value as escaped text.
 *
 * A name is a markup value when any assignment to it is one. That is a
 * conservative reading: a name wrongly taken for markup only takes the
 * sanitizing path, which keeps every allowed tag and escapes the rest.
 */
import type { Expr, Span, Stmt } from '../../deluge/src/ast.js';

export interface MarkupFlow {
  /** Lower-case dotted `thisapp` paths of markup-building functions whose every call assigns a name. */
  functions: Set<string>;
  /** Spans of the `"T"` print kind in `c2c_out.add({"k":"T",...})` calls that print a markup value. */
  prints: Span[];
}

/** A string value that holds a tag, a closing tag or a comment. */
const MARKUP_TEXT = /<[A-Za-z/!]/;

/** `thisapp.<A>.<B>` call target, else null. */
function thisappPath(callee: Expr): string[] | null {
  const path: string[] = [];
  let cur: Expr = callee;
  while (cur.kind === 'member') {
    path.unshift(cur.property);
    cur = cur.object;
  }
  return cur.kind === 'name' && cur.name === 'thisapp' && path.length > 0 ? path : null;
}

function childStmts(s: Stmt): Stmt[] {
  switch (s.kind) {
    case 'block':
      return s.body;
    case 'if':
      return [s.then, ...s.elifs.map((elif) => elif.body), ...(s.else ? [s.else] : [])];
    case 'forEach':
    case 'while':
      return [s.body];
    case 'try':
      return [s.body, ...(s.catchBody ? [s.catchBody] : [])];
    default:
      return [];
  }
}

function allStmts(body: Stmt[]): Stmt[] {
  return body.flatMap((s) => [s, ...allStmts(childStmts(s))]);
}

/** Every call node under `node`, in source order. */
function calls(node: unknown, out: Extract<Expr, { kind: 'call' }>[] = []): Extract<Expr, { kind: 'call' }>[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) calls(item, out);
    return out;
  }
  const rec = node as Record<string, unknown>;
  if (rec.kind === 'call') out.push(rec as Extract<Expr, { kind: 'call' }>);
  for (const key of Object.keys(rec)) if (key !== 'span') calls(rec[key], out);
  return out;
}

/**
 * `isMarkupFunction` says whether a `thisapp` path names an app function that
 * builds markup. Only a function whose every call is the whole right side of
 * an assignment to a name is returned in `functions`. `isImageField` says
 * whether a form's field is an image, whose value the page reads as an `<img>`
 * element; the form comes from a name assigned `Form[criteria]`.
 */
export function markupFlow(
  body: Stmt[],
  isMarkupFunction: (path: string[]) => boolean,
  isImageField: (form: string, field: string) => boolean,
): MarkupFlow {
  const stmts = allStmts(body);
  const assigns = stmts.filter((s): s is Extract<Stmt, { kind: 'assign' }> => s.kind === 'assign' && s.op === '=' && s.target.kind === 'name');
  const vars = new Set<string>();
  // The form a name holds a record of: every assignment to it reads that one form.
  const forms = new Map<string, string | null>();
  for (const s of assigns) {
    const name = (s.target as Extract<Expr, { kind: 'name' }>).name;
    const value = s.value.kind === 'paren' ? s.value.expr : s.value;
    const form = value.kind === 'criteria' && value.object.kind === 'name' ? value.object.name : null;
    forms.set(name, forms.has(name) && forms.get(name) !== form ? null : form);
  }
  const markup = (e: Expr): boolean => {
    switch (e.kind) {
      case 'string':
        return MARKUP_TEXT.test(e.value);
      case 'name':
        return vars.has(e.name);
      case 'paren':
        return markup(e.expr);
      case 'member': {
        const form = e.object.kind === 'name' ? forms.get(e.object.name) : null;
        return !!form && isImageField(form, e.property);
      }
      case 'binary':
        return e.op === '+' && (markup(e.left) || markup(e.right));
      case 'ifExpr':
        return markup(e.then) || (!!e.else && markup(e.else));
      case 'call': {
        const path = thisappPath(e.callee);
        if (path) return isMarkupFunction(path);
        // A string method on a markup value (`replaceFirst`, `trim`) keeps it markup.
        return e.callee.kind === 'member' && markup(e.callee.object);
      }
      default:
        return false;
    }
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of assigns) {
      const name = (s.target as Extract<Expr, { kind: 'name' }>).name;
      if (!vars.has(name) && markup(s.value)) {
        vars.add(name);
        changed = true;
      }
    }
  }
  const direct = new Set<unknown>(assigns.map((s) => s.value));
  const used = new Set<string>();
  const stray = new Set<string>();
  for (const call of calls(body)) {
    const path = thisappPath(call.callee);
    if (!path || !isMarkupFunction(path)) continue;
    const key = path.join('.').toLowerCase();
    (direct.has(call) ? used : stray).add(key);
  }
  const functions = new Set([...used].filter((key) => !stray.has(key)));
  const prints: Span[] = [];
  for (const s of stmts) {
    if (s.kind !== 'expr' || s.expr.kind !== 'call') continue;
    const callee = s.expr.callee;
    if (callee.kind !== 'member' || callee.property !== 'add' || callee.object.kind !== 'name' || callee.object.name !== 'c2c_out') continue;
    const arg = s.expr.args[0];
    if (!arg || arg.kind !== 'map') continue;
    const kind = arg.entries.find((entry) => entry.key.kind === 'string' && entry.key.value === 'k')?.value;
    const value = arg.entries.find((entry) => entry.key.kind === 'string' && entry.key.value === 'v')?.value;
    if (kind && kind.kind === 'string' && kind.value === 'T' && value && markup(value)) prints.push(kind.span);
  }
  return { functions, prints };
}
