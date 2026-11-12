/**
 * In-memory match for a compiled report criteria JSON — the same leaf rules
 * as the vanilla runtime's matchCriteria, on report display values. A `todo`
 * node (a condition the export did not translate) never matches, so an
 * unmigrated conditional format paints nothing instead of everything.
 */
export interface CriteriaNode {
  op: string;
  field?: string;
  value?: unknown;
  args?: CriteriaNode[];
  arg?: CriteriaNode;
}

type Row = Record<string, unknown>;

/** `ID` in a report criteria reads as the row's ROWID. */
function criteriaField(row: Row, field: string | undefined): unknown {
  if (field === 'ID' && !Object.prototype.hasOwnProperty.call(row, 'ID')) {
    return (row.ROWID ?? (row as { rowid?: unknown }).rowid) as unknown;
  }
  return field === undefined ? undefined : row[field];
}

/** A numeric-looking non-empty string reads as a number, like the plain-JS runtime's criteriaValue. */
function criteriaCoerce(value: unknown): unknown {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
}

/**
 * A `{ __field }` value is another cell of the same row (`input.Field` in a
 * conditional format). Only the row's own cells resolve: an inherited name
 * such as `__proto__` or `constructor` reads as no value. Report cell values
 * (decimal/currency fields) travel as exact-decimal strings, so a numeric-
 * looking cell is coerced to a number before the row-vs-row comparison.
 */
function criteriaOperand(row: Row, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as { __field?: unknown }).__field;
    if (typeof ref === 'string') {
      const other = ref === 'ID' || Object.prototype.hasOwnProperty.call(row, ref) ? criteriaField(row, ref) : undefined;
      return other == null ? other : criteriaCoerce(other);
    }
  }
  return value;
}

/** The left-hand cell of a comparison, numerically coerced to match when the right side is another cell. */
function criteriaCell(row: Row, node: CriteriaNode): unknown {
  const cell = criteriaField(row, node.field);
  const right = node.value;
  return right && typeof right === 'object' && !Array.isArray(right) && typeof (right as { __field?: unknown }).__field === 'string'
    ? criteriaOperand(row, { __field: node.field })
    : cell;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left == null || right == null) return left == null && right == null;
  return left === right;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  const a = left == null ? '' : String(left);
  const b = right == null ? '' : String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function matchCriteria(row: Row, c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const node = c as CriteriaNode;
  switch (node.op) {
    case 'true':
      return true;
    case 'and':
      return (node.args ?? []).every((arg) => matchCriteria(row, arg));
    case 'or':
      return (node.args ?? []).some((arg) => matchCriteria(row, arg));
    case 'not':
      return !matchCriteria(row, node.arg);
    case 'isNull':
      return criteriaField(row, node.field) == null;
    case 'notNull':
      return criteriaField(row, node.field) != null;
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const raw = criteriaField(row, node.field);
      const text = raw == null ? '' : String(raw);
      const needle = node.value == null ? '' : String(node.value);
      if (node.op === 'contains') return text.includes(needle);
      if (node.op === 'startsWith') return text.startsWith(needle);
      return text.endsWith(needle);
    }
    case 'in': {
      const items = Array.isArray(node.value) ? node.value : [node.value];
      return items.some((item) => sameValue(criteriaField(row, node.field), item));
    }
    case '==':
      return sameValue(criteriaCell(row, node), criteriaOperand(row, node.value));
    case '!=':
      return !sameValue(criteriaCell(row, node), criteriaOperand(row, node.value));
    case '<':
      return compareValues(criteriaCell(row, node), criteriaOperand(row, node.value)) < 0;
    case '>':
      return compareValues(criteriaCell(row, node), criteriaOperand(row, node.value)) > 0;
    case '<=':
      return compareValues(criteriaCell(row, node), criteriaOperand(row, node.value)) <= 0;
    case '>=':
      return compareValues(criteriaCell(row, node), criteriaOperand(row, node.value)) >= 0;
    default:
      return false;
  }
}

/** Any `{ op: 'todo' }` predicate at or under this criteria node. */
export function criteriaTodo(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const node = c as CriteriaNode;
  if (node.op === 'todo') return true;
  const kids = Array.isArray(node.args) ? node.args : node.arg ? [node.arg] : [];
  return kids.some(criteriaTodo);
}
