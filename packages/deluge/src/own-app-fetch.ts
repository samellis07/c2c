import type { App } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { parse } from './parser.js';

type Node = { kind?: string; span?: { start: number; end: number }; [key: string]: unknown };

/** Creator returns 200 rows when the call names no limit. */
const DEFAULT_LIMIT = 200;

const alnum = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

function text(node: unknown): string | null {
  const n = node as Node | undefined;
  return n?.kind === 'string' ? String(n.value ?? '') : null;
}

function whole(node: unknown): number | null {
  const n = node as Node | undefined;
  return n?.kind === 'number' && /^\d+$/.test(String(n.text)) ? Number(n.text) : null;
}

function isCreatorGetRecords(callee: Node): boolean {
  if (callee.kind !== 'member' || String(callee.property).toLowerCase() !== 'getrecords') return false;
  const creator = callee.object as Node;
  if (creator?.kind !== 'member' || String(creator.property).toLowerCase() !== 'creator') return false;
  const root = creator.object as Node;
  return root?.kind === 'name' && String(root.name).toLowerCase() === 'zoho';
}

/**
 * Rewrites `zoho.creator.getRecords(owner, "<this app>", "<its report>", crit,
 * from, limit)` into the equivalent record fetch wrapped in the reply map the
 * call returns (`{"code": 3000, "data": Form[crit] range from 1 to N}`), so
 * the generated data API serves it instead of a Creator REST round trip.
 * Only a call that names this application and one of its criteria-free list
 * reports, with a literal criteria, a first-page window, and no connection,
 * is rewritten; anything else stays the integration task. Lookup, subform,
 * and file fields come back from the API as objects the stored row does not
 * reproduce, so a form holding one is left alone as well.
 */
export function resolveOwnAppFetches(source: string, app: App): string {
  if (!/getrecords/i.test(source) || !app.name) return source;
  const edits: { start: number; end: number; code: string }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Node;
    if (node.kind === 'call' && node.span && isCreatorGetRecords(node.callee as Node)) {
      const code = rewrite(app, node.args as unknown[]);
      if (code) edits.push({ start: node.span.start, end: node.span.end, code });
    }
    for (const key of Object.keys(node).sort((a, b) => compareEnUs(a, b))) {
      if (key !== 'span') visit(node[key]);
    }
  };
  visit(parse(source));
  if (!edits.length) return source;
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const edit of edits) out = `${out.slice(0, edit.start)}${edit.code}${out.slice(edit.end)}`;
  return out;
}

function rewrite(app: App, args: unknown[]): string | null {
  if (args.length < 3 || args.length > 6) return null;
  const link = text(args[1]);
  const reportName = text(args[2]);
  if (link === null || reportName === null || alnum(link) !== alnum(app.name ?? '')) return null;
  const report = app.reports.find((r) => r.name === reportName) ?? app.reports.find((r) => r.name.toLowerCase() === reportName.toLowerCase());
  if (!report?.form || report.criteria?.trim()) return null;
  const form = app.forms.find((f) => f.name === report.form);
  if (!form || form.fields.some((f) => f.lookup || f.subfields.length || /subform|file|image|audio|video|signature/i.test(f.type ?? ''))) return null;
  const criteria = args.length > 3 ? text(args[3]) : '';
  if (criteria === null) return null;
  const from = args.length > 4 ? whole(args[4]) : 1;
  const limit = args.length > 5 ? whole(args[5]) : DEFAULT_LIMIT;
  if (from !== 1 || limit === null || limit < 1) return null;
  const where = criteria.trim() || 'ID != 0';
  // Criteria is later embedded in generated source.  Reject source-level
  // constructs that have no meaning in the expression token allowlist rather
  // than carrying them through as text (comments, line breaks, controls, and
  // escaped literals are especially easy to mistake for harmless input).
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(criteria) || /\/\/|\/\*|\*\//u.test(criteria) || /\\/u.test(criteria)) return null;
  let criteriaExpr: unknown;
  try {
    const parsed = parse(`x = ${form.name}[${where}];`) as { body?: Node[] };
    // The criteria text is spliced into a one-statement wrapper and must
    // parse as EXACTLY that one statement. Trailing text that happens to
    // parse as further statements (e.g. a criteria string ending
    // `...]; info "x"; ...`) would otherwise be validated only up to the
    // first statement's span while the UNVALIDATED raw `where` text — not
    // the validated span — is what actually gets spliced into the
    // generated code below, letting unreviewed Deluge statements ride
    // along silently. Reject anything but a single statement outright.
    if ((parsed.body?.length ?? 0) !== 1) return null;
    const assign = parsed.body?.[0];
    const value = assign?.value as Node | undefined;
    if (value?.kind !== 'criteria') return null;
    // `object[c1][c2]` parses as nested `criteria` nodes (the outer one's
    // `object` is the inner `criteria` node, not a bare name) — a single
    // top-level statement, so the length-1 check above does not catch it.
    // Only the outer bracket's `criteria` (`c2`) is what gets validated
    // below; the inner, unvalidated `c1` would otherwise ride along inside
    // `value.object` and still be spliced into the generated `where` text
    // verbatim. Require the object being indexed to be exactly the bare
    // form name the wrapper spliced in, so a chained second bracket can
    // never smuggle an unvalidated criteria through.
    const object = value.object as Node | undefined;
    if (object?.kind !== 'name' || String(object.name) !== form.name) return null;
    criteriaExpr = value.criteria;
  } catch {
    return null;
  }
  // The criteria argument is a literal *string*, but its contents are only
  // safe to splice unparsed into the generated code when every leaf of the
  // parsed criteria is a literal value or a plain column reference on this
  // form (plus the always-present system columns). Anything else — a
  // dotted/member reference (zoho.*, input.*, old.*, row.*, thisapp.*, ...),
  // a relative-date phrase (today, this week, ...; "today" and "now" parse
  // as an ordinary bare name indistinguishable from a field reference, so a
  // denylist of known-dangerous names cannot catch them — only an allowlist
  // of known-safe column names can), a call, an index, or anything the
  // parser could not fully resolve into one of the recognised literal/field
  // shapes (an "unknown" node) resolves per-request or is otherwise not a
  // fixed value, and would turn a supposedly fixed own-app fetch into one
  // scoped by the caller, the clock, or unparsed/untrusted text. Reject the
  // whole call rather than try to partially translate it; it stays the
  // manual integration task.
  if (!isStaticPredicate(criteriaExpr, staticColumnNames(form))) return null;
  const serial = serializeCriteria(criteriaExpr);
  if (serial === null) return null;
  return `{"code":3000,"data":${form.name}[${serial}] range from 1 to ${limit}}`;
}

/** Emit only the expression grammar accepted by isStaticPredicate. */
function serializeCriteria(value: unknown): string | null {
  const node = value as Node | undefined;
  if (!node || typeof node !== 'object') return null;
  switch (node.kind) {
    case 'name': return typeof node.name === 'string' ? node.name : null;
    case 'string': return JSON.stringify(String(node.value ?? ''));
    case 'number': return typeof node.text === 'string' ? node.text : null;
    case 'date': return typeof node.text === 'string' ? node.text : null;
    case 'paren': { const inner = serializeCriteria(node.expr); return inner === null ? null : `(${inner})`; }
    case 'unary': { const inner = serializeCriteria(node.expr); return inner === null || typeof node.op !== 'string' ? null : `${node.op}${inner}`; }
    case 'binary': {
      const left = serializeCriteria(node.left); const right = serializeCriteria(node.right);
      return left === null || right === null || typeof node.op !== 'string' ? null : `${left} ${node.op} ${right}`;
    }
    default: return null;
  }
}

/** Field names on `form`, plus the system columns every Creator form always carries. */
function staticColumnNames(form: { fields: { name: string }[] }): Set<string> {
  const names = new Set([
    'rowid',
    'id',
    'added_user',
    'added_time',
    'modified_user',
    'modified_time',
    'creatorid',
    'createdtime',
    'modifiedtime',
    'created_time',
  ]);
  for (const field of form.fields) names.add(field.name.toLowerCase());
  return names;
}

/** Deluge logical connectives; every other `binary` op is a comparison (==, !=, <, in, is, ...). */
const LOGICAL_OPS = new Set(['&&', '||', 'and', 'or']);

/**
 * Relative-date shorthand parses as an ordinary bare `name` node, identical
 * in shape to a field reference. The real compiler resolves these keywords
 * to the live clock *regardless of whether a column of the same name also
 * exists on the form* — keyword resolution takes precedence over field
 * resolution — so a form that happens to carry a column literally named
 * "Today"/"Now"/etc. must not let that column name vouch for the identifier
 * here. Checked case-insensitively, ahead of the columns lookup.
 */
const RESERVED_RELATIVE_NAMES = new Set(['today', 'now', 'yesterday', 'tomorrow']);

/**
 * True only if every leaf of the parsed criteria expression is a literal
 * value, the boolean literals `true`/`false`, or a bare name matching a
 * known-static column on this form. Any other node kind — including one
 * the parser could not resolve ("unknown") — is rejected by falling through
 * to the default `false`, so an unrecognised future AST shape fails closed
 * rather than silently passing.
 *
 * A bare name is only trustworthy as "this form's own column" where it is
 * the literal field-path token *directly* in a `field OP literal`
 * comparison. Nothing here proves a name isn't instead a same-named local
 * variable/parameter from the surrounding script (set earlier to e.g.
 * `zoho.loginuser`) that merely happens to also match one of this form's
 * column names — the criteria text alone carries no visibility into that
 * outer script's variable bindings. Wrapping that name in an expression —
 * string concatenation, unary negation, arithmetic, parens — does not make
 * it any more trustworthy, it just hides the same name one level down; a
 * comparison is therefore only accepted when ONE side is a column name used
 * bare (not inside any wrapper) and the OTHER side is a "pure literal"
 * subtree containing no name node anywhere except the `true`/`false`
 * keywords, or when BOTH sides are pure-literal subtrees. `field OP field`
 * (two bare names on both sides) is never accepted, matching the direct
 * `name OP name` case this generalises.
 */
function isStaticPredicate(value: unknown, columns: Set<string>): boolean {
  const node = value as Node | undefined;
  if (!node || typeof node !== 'object') return false;
  switch (node.kind) {
    case 'binary': {
      const left = node.left as Node | undefined;
      const right = node.right as Node | undefined;
      if (typeof node.op === 'string' && LOGICAL_OPS.has(node.op)) {
        return isStaticPredicate(left, columns) && isStaticPredicate(right, columns);
      }
      const leftIsBareColumn = isBareColumn(left, columns);
      const rightIsBareColumn = isBareColumn(right, columns);
      if (leftIsBareColumn && rightIsBareColumn) return false;
      if (leftIsBareColumn) return isPureLiteral(right);
      if (rightIsBareColumn) return isPureLiteral(left);
      return isPureLiteral(left) && isPureLiteral(right);
    }
    case 'unary':
    case 'paren':
      return isStaticPredicate(node.expr, columns);
    case 'string':
    case 'number':
    case 'date':
      return true;
    case 'name': {
      const rawName = typeof node.name === 'string' ? node.name : '';
      if (rawName === 'true' || rawName === 'false') return true;
      const name = rawName.toLowerCase();
      if (RESERVED_RELATIVE_NAMES.has(name)) return false;
      return columns.has(name);
    }
    default:
      return false;
  }
}

/** True only for a `name` node, used bare (no wrapper), naming a known-static column — never a relative-date keyword or `true`/`false`. */
function isBareColumn(node: Node | undefined, columns: Set<string>): boolean {
  if (!node || node.kind !== 'name') return false;
  const rawName = typeof node.name === 'string' ? node.name : '';
  // Exact-case: Deluge identifiers are case-sensitive, so only the literal
  // keywords `true`/`false` are excluded here — a variable merely spelled
  // `True`/`False` (any other case) is a real identifier, not the boolean
  // literal, and must not be treated as a safe bare column either.
  if (rawName === 'true' || rawName === 'false') return false;
  const name = rawName.toLowerCase();
  if (RESERVED_RELATIVE_NAMES.has(name)) return false;
  return columns.has(name);
}

/**
 * True only if `node`'s subtree contains no `name` node anywhere except the
 * `true`/`false` keywords — i.e. it is built entirely from literal values
 * (and/or arithmetic/concatenation entirely among literals), so it resolves
 * to a fixed value regardless of any outer-script variable binding and
 * carries no shadowing risk.
 */
function isPureLiteral(value: unknown): boolean {
  const node = value as Node | undefined;
  if (!node || typeof node !== 'object') return false;
  switch (node.kind) {
    case 'string':
    case 'number':
    case 'date':
      return true;
    case 'name': {
      // Exact-case: a variable literally named `True`/`False` (any casing
      // other than the two keyword spellings) is a real identifier that may
      // hold a dynamic value (e.g. `True = zoho.loginuser;`), not the
      // boolean literal. Deluge identifiers are case-sensitive, so this
      // check must be too, or it wrongly treats that variable as a fixed
      // literal and lets a shadowed dynamic value through.
      const rawName = typeof node.name === 'string' ? node.name : '';
      return rawName === 'true' || rawName === 'false';
    }
    case 'unary':
    case 'paren':
      return isPureLiteral(node.expr);
    case 'binary':
      return isPureLiteral(node.left) && isPureLiteral(node.right);
    default:
      return false;
  }
}
