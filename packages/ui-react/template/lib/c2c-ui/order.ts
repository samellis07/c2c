/**
 * Cell order of a sorted report column, matching the ORDER BY the report
 * endpoint applies. A page arrives already ordered; drawing it through the
 * same rule keeps the sequence the next page continues, so a blank cannot
 * surface mid-list. Each comparator returns the ascending order; the caller
 * negates it for descending, like the endpoint does.
 *
 * Number-family columns sort by their exact decimal shadow (the endpoint's
 * compareDecimalCells): a blank is a null shadow, first ascending and last
 * descending. Other columns sort as varchar (compareCells): numbers as
 * numbers, else code-unit text, where a null still lands first ascending
 * because it compares as the empty string.
 */

/** A decimal literal the endpoint's exact decimal accepts (its Decimal.from grammar). */
const NUMERIC_TEXT = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** A number or numeric string as sign + integer + fraction digits, so order is exact and no float is formed. */
function decimalParts(value: unknown): { neg: boolean; int: string; frac: string } | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = NUMERIC_TEXT.exec(text);
  if (!match) return null;
  const digits = match[2]! + (match[3] ?? "");
  const point = match[2]!.length + (match[4] ? Number(match[4]) : 0);
  let int: string, frac: string;
  if (point <= 0) { int = "0"; frac = "0".repeat(-point) + digits; }
  else if (point >= digits.length) { int = digits + "0".repeat(point - digits.length); frac = ""; }
  else { int = digits.slice(0, point); frac = digits.slice(point); }
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  return { neg: match[1] === "-" && (int !== "0" || frac !== ""), int, frac };
}

/** Exact order of two decimal parts; negative values compare in reverse magnitude. */
function compareDecimals(left: { neg: boolean; int: string; frac: string }, right: { neg: boolean; int: string; frac: string }): number {
  if (left.neg !== right.neg) return left.neg ? -1 : 1;
  const order = left.int.length - right.int.length || (left.int < right.int ? -1 : left.int > right.int ? 1 : 0) || (left.frac < right.frac ? -1 : left.frac > right.frac ? 1 : 0);
  return left.neg ? -order : order;
}

/** The endpoint's varchar ORDER BY: two numbers as numbers, else code-unit text. */
export function compareCells(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  const a = left == null ? "" : String(left);
  const b = right == null ? "" : String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A null shadow cell: unset, or text with nothing but space in it. */
const isBlank = (value: unknown): boolean => value == null || (typeof value === "string" && value.trim() === "");

/**
 * Ascending order of two cells in one column. A numeric column uses the
 * decimal-shadow rule: blanks first, then the exact decimal order, then cell
 * order for a non-number. Any other column is plain cell order.
 */
export function compareReportCells(left: unknown, right: unknown, numeric: boolean): number {
  if (numeric) {
    const blankL = isBlank(left);
    const blankR = isBlank(right);
    if (blankL || blankR) return blankL && blankR ? 0 : blankL ? -1 : 1;
    const a = decimalParts(left);
    const b = decimalParts(right);
    if (a && b) return compareDecimals(a, b);
  }
  return compareCells(left, right);
}
