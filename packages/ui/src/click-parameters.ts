/**
 * Creator report URL parameters on a page `<pc action="OpenReport">`.
 *
 * The coverage check treats parameters as carried only when the raw attribute
 * text appears in the element's href. A click is wired only when that text
 * compiles to a filter the report endpoint already accepts: one static
 * equality the client posts as `{field, value}`, or a named filter baked into
 * the report module (the only place a `{__rel}` marker may come from).
 * Anything else stays a counted manual step.
 */
import type { App, Field, Form } from '../../core/src/ir.js';
import type { ZmlElement } from '../../core/src/zml.js';
import { compareEnUs } from '../../core/src/order.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { criteriaHasTodo, type Criteria } from '../../shims/src/criteria.js';
import { decodeXmlEntities } from './htmlpage.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLICK_PREFIX = 'c2c-click:';

/** Zoho functionality-URL operator constants this compiler emits. */
const COMPARE_OP: Readonly<Record<number, string>> = {
  18: '==',
  19: '!=',
  20: '<',
  21: '>',
  22: '<=',
  23: '>=',
};

const METHOD_OP: Readonly<Record<number, string>> = {
  24: 'startsWith',
  25: 'endsWith',
  26: 'contains',
};

const DAY_OP: Readonly<Record<number, string>> = {
  31: 'yesterday',
  32: 'today',
  33: 'tomorrow',
};

const PERIOD_OP: Readonly<Record<number, string>> = {
  34: 'last 7 days',
  35: 'last 30 days',
  44: 'last month',
  45: 'this month',
  46: 'next month',
  59: 'this week',
  60: 'last week',
  61: 'next week',
};

export interface PcClick {
  /** Named-filter label. Equality clicks do not bake this into the report. */
  label: string;
  criteria: Criteria;
  mode: 'equality' | 'named';
  /** Decoded scalar for a single `==` the client can post itself. */
  equality?: { field: string; value: string };
}

interface Piece {
  field: string;
  value?: string;
  op?: number;
}

function formFields(form: Form | undefined): Set<string> {
  const names = new Set<string>();
  const walk = (fields: readonly Field[]) => {
    for (const field of fields) {
      if (field.name) names.add(field.name);
      if (field.subfields?.length) walk(field.subfields);
    }
  };
  if (form) walk(form.fields);
  return names;
}

/** Field link names of the report's form, or null when the report or form is missing. */
export function reportFormFields(app: App, reportName: string): Set<string> | null {
  const report = app.reports.find((item) => item.name === reportName);
  if (!report?.form) return null;
  const form = app.forms.find((item) => item.name === report.form);
  if (!form) return null;
  return formFields(form);
}

function attr(attributes: Record<string, string>, key: string): string | undefined {
  const want = key.toLowerCase();
  // determinism-allow: ZML attribute source order; the first wanted key wins
  for (const [name, value] of Object.entries(attributes)) {
    if (name.toLowerCase() === want && value.trim()) return value;
  }
  return undefined;
}

function namedTarget(attributes: Record<string, string>): string | undefined {
  for (const key of ['componentLinkName', 'linkName', 'formLinkName']) {
    const value = attr(attributes, key);
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function splitOutsideQuotes(raw: string, sep: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (raw.startsWith(sep, i)) {
      parts.push(raw.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  if (quote) return null;
  parts.push(raw.slice(start));
  return parts;
}

function percentDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function delugeLiteral(value: string): string | null {
  if (value.includes('"') || value.includes('\\') || value.includes('${')) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value;
  return `"${value}"`;
}

function parsePieces(raw: string): Piece[] | null {
  const sep = raw.includes('&&') ? '&&' : '&';
  const chunks = splitOutsideQuotes(raw, sep);
  if (!chunks || chunks.some((chunk) => chunk.trim() === '')) return null;
  const grouped = new Map<string, Piece>();
  for (const chunk of chunks) {
    const eq = chunk.indexOf('=');
    if (eq <= 0) return null;
    const key = chunk.slice(0, eq).trim();
    const rawValue = chunk.slice(eq + 1);
    if (key.endsWith('_op') && IDENT.test(key.slice(0, -3))) {
      if (!/^\d+$/.test(rawValue)) return null;
      const field = key.slice(0, -3);
      const piece = grouped.get(field) ?? { field };
      if (piece.op !== undefined) return null;
      piece.op = Number(rawValue);
      grouped.set(field, piece);
      continue;
    }
    if (!IDENT.test(key)) return null;
    const decoded = percentDecode(rawValue);
    if (decoded === null) return null;
    const piece = grouped.get(key) ?? { field: key };
    if (piece.value !== undefined) return null;
    piece.value = decoded;
    grouped.set(key, piece);
  }
  // determinism-allow: clause source order; the compiler sorts fields before emitting Deluge
  return [...grouped.values()];
}

function clauseOf(piece: Piece): { text: string; equality?: { field: string; value: string } } | null {
  const op = piece.op ?? 18;
  const field = piece.field;
  if (Object.prototype.hasOwnProperty.call(DAY_OP, op)) {
    if (piece.value !== undefined) return null;
    return { text: `${field} is ${DAY_OP[op]}` };
  }
  if (Object.prototype.hasOwnProperty.call(PERIOD_OP, op)) {
    if (piece.value !== undefined) return null;
    return { text: `${field} in ${PERIOD_OP[op]}` };
  }
  if (piece.value === undefined) return null;
  if (piece.value === '${zoho.currentdate}') {
    const cmp = COMPARE_OP[op];
    if (!cmp) return null;
    return { text: `${field} ${cmp} zoho.currentdate` };
  }
  if (piece.value.includes('${')) return null;
  if (Object.prototype.hasOwnProperty.call(METHOD_OP, op)) {
    const literal = delugeLiteral(piece.value);
    if (!literal || !literal.startsWith('"')) return null;
    return { text: `${field}.${METHOD_OP[op]}(${literal})` };
  }
  const cmp = COMPARE_OP[op];
  if (!cmp) return null;
  const literal = delugeLiteral(piece.value);
  if (literal === null) return null;
  const equality = op === 18 ? { field, value: piece.value } : undefined;
  return { text: `${field} ${cmp} ${literal}`, ...(equality ? { equality } : {}) };
}

function compileDeluge(deluge: string, fields: ReadonlySet<string>, pieces: Piece[], equality?: { field: string; value: string }): PcClick | null {
  for (const piece of pieces) {
    if (!fields.has(piece.field)) return null;
  }
  let criteria: Criteria;
  try {
    criteria = reportCriteria(deluge);
  } catch {
    return null;
  }
  if (criteriaHasTodo(criteria)) return null;
  const label = `${CLICK_PREFIX}${deluge}`;
  if (equality && pieces.length === 1) return { label, criteria, mode: 'equality', equality };
  return { label, criteria, mode: 'named' };
}

/**
 * Compile one `<pc>` `parameters` attribute against the target form's fields.
 * Returns null when the shape, operator, or field is not one this generator applies.
 */
export function pcClickParameters(raw: string, fields: ReadonlySet<string>): PcClick | null {
  const text = raw.trim();
  if (!text) return null;
  // The href keeps this exact text. An entity-encoded separator would not
  // survive as the same query the client reads, so it stays a manual step.
  if (decodeXmlEntities(text) !== text) return null;
  const whole = /^([A-Za-z_][A-Za-z0-9_]*)\s+is\s+\$\{zoho\.currentdate\}$/i.exec(text);
  if (whole) {
    const field = whole[1]!;
    if (!fields.has(field)) return null;
    return compileDeluge(`${field} is zoho.currentdate`, fields, [{ field }]);
  }
  if (!text.includes('=')) return null;
  const pieces = parsePieces(text);
  if (!pieces || !pieces.length) return null;
  const clauses: { text: string; equality?: { field: string; value: string } }[] = [];
  for (const piece of [...pieces].sort((a, b) => compareEnUs(a.field, b.field))) {
    const clause = clauseOf(piece);
    if (!clause) return null;
    clauses.push(clause);
  }
  const equality = clauses.length === 1 ? clauses[0]!.equality : undefined;
  return compileDeluge(clauses.map((clause) => clause.text).join(' && '), fields, pieces, equality);
}

/** Report hash whose query contains the raw parameters and, for a named filter, `filter=`. */
export function pcClickHref(target: string, rawParameters: string, click: PcClick): string {
  const base = `#/report/${encodeURIComponent(target)}?${rawParameters}`;
  if (click.mode === 'equality') return base;
  return `${base}&filter=${encodeURIComponent(click.label)}`;
}

function walkZml(nodes: readonly ZmlElement[], visit: (el: ZmlElement) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.children?.length) walkZml(node.children, visit);
  }
}

/**
 * Named filters a page `<pc>` contributes to this report. Equality clicks are
 * omitted: the client posts those as `{field, value}` and the report module
 * stays unchanged. Labels are sorted; the caller appends them after the
 * report's own filters so an identical label keeps the Creator filter.
 */
export function pcNamedFilters(app: App, reportName: string): { label: string; criteria: Criteria }[] {
  const fields = reportFormFields(app, reportName);
  if (!fields) return [];
  const byLabel = new Map<string, Criteria>();
  for (const page of app.pages) {
    walkZml(page.zml ?? [], (el) => {
      if (el.tag.toLowerCase() !== 'pc') return;
      const action = (attr(el.attributes, 'action') ?? '').replace(/\s+/g, '').toLowerCase();
      if (action !== 'openreport') return;
      if (namedTarget(el.attributes) !== reportName) return;
      const parameters = attr(el.attributes, 'parameters')?.trim();
      if (!parameters) return;
      const click = pcClickParameters(parameters, fields);
      if (!click || click.mode !== 'named') return;
      if (!byLabel.has(click.label)) byLabel.set(click.label, click.criteria);
    });
  }
  return [...byLabel.entries()]
    .sort((a, b) => compareEnUs(a[0], b[0]))
    .map(([label, criteria]) => ({ label, criteria }));
}
