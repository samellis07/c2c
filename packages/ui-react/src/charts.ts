/**
 * Charts, dashboards and pages for the React target (see
 * docs/react-target.md): the spec of every Creator page (its ZML element
 * tree with metrics, charts and embeds resolved) and of every chart report.
 *
 * Data comes from the report query endpoints the app already has; the browser
 * folds the rows (count, sum) after applying the criteria that translate. A
 * criteria clause, an element or a setting that does not translate is kept as
 * a visible TODO on its element and listed at the top of the page; nothing is
 * dropped silently.
 *
 * Pure and deterministic: source order only, no clock.
 */
import type { App } from '../../core/src/ir.js';
import type { ZmlElement } from '../../core/src/zml.js';
import type { UiModel, UiReport } from '../../ui/src/model.js';
import { carriedStyleRules, droppedStyleRulesTodo, elementFromZml } from '../../ui/src/pages.js';
import type { ChartSpec, FilterClause, MeasureSpec, MetricSpec, PageElement, PageSpec } from '../template/lib/c2c-ui/types.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the HTML entities the export writes inside ZML attribute values. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function humanize(name: string): string {
  return name.replace(/_+/g, ' ').trim();
}

/** Case-insensitive attribute read; the first non-blank of `keys` wins. */
function attrOf(attributes: Record<string, string>, ...keys: string[]): string | undefined {
  const lower = new Map<string, string>();
  for (const key of Object.keys(attributes).sort()) if (!lower.has(key.toLowerCase())) lower.set(key.toLowerCase(), attributes[key]!);
  for (const key of keys) {
    const value = lower.get(key.toLowerCase());
    if (value !== undefined && value.trim()) return decodeEntities(value.trim());
  }
  return undefined;
}

const FIELD = '([A-Za-z_][\\w]*(?:\\.[A-Za-z_][\\w]*)*)';
const CLAUSES: { re: RegExp; make: (m: RegExpExecArray) => FilterClause }[] = [
  { re: new RegExp(`^${FIELD}\\s*(==|!=)\\s*"([^"]*)"$`), make: (m) => ({ field: m[1]!, op: m[2] === '==' ? 'eq' : 'ne', value: m[3]! }) },
  { re: new RegExp(`^${FIELD}\\s*(==|!=)\\s*(true|false)$`, 'i'), make: (m) => ({ field: m[1]!, op: m[2] === '==' ? 'eq' : 'ne', value: m[3]!.toLowerCase() === 'true' }) },
  { re: new RegExp(`^${FIELD}\\s*(==|!=|<=|>=|<|>)\\s*(-?\\d+(?:\\.\\d+)?)$`), make: (m) => numeric(m[1]!, m[2]!, Number(m[3])) },
  { re: new RegExp(`^${FIELD}\\s+is\\s+(today|yesterday|tomorrow)$`, 'i'), make: (m) => dayClause(m[1]!, m[2]!) },
  { re: new RegExp(`^${FIELD}\\s+in\\s+(today|yesterday|tomorrow)$`, 'i'), make: (m) => dayClause(m[1]!, m[2]!) },
  { re: new RegExp(`^${FIELD}\\s+in\\s+(this|last|next)\\s+(week|month|year)$`, 'i'), make: (m) => ({ field: m[1]!, op: 'period', when: m[2]!.toLowerCase() as 'this', unit: m[3]!.toLowerCase() as 'week' }) },
  { re: new RegExp(`^${FIELD}\\s+in\\s+last\\s+(\\d+)\\s+days$`, 'i'), make: (m) => ({ field: m[1]!, op: 'period', when: 'last', unit: 'day', count: Number(m[2]) }) },
  { re: new RegExp(`^${FIELD}\\s+is\\s+(not\\s+)?(empty|null)$`, 'i'), make: (m) => ({ field: m[1]!, op: m[2] ? 'filled' : 'empty' }) },
  { re: new RegExp(`^${FIELD}\\s*(==|!=|<=|>=|<|>)\\s*zoho\\.currentdate$`, 'i'), make: (m) => ({ field: m[1]!, op: OPS[m[2]!]!, today: true }) },
  { re: new RegExp(`^${FIELD}\\s*(==|!=|<=|>=|<|>)\\s*${FIELD}$`), make: (m) => ({ field: m[1]!, op: OPS[m[2]!]!, ref: m[3]! }) },
];
const OPS: Record<string, 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'> = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };

function numeric(field: string, op: string, value: number): FilterClause {
  const mapped = OPS[op]!;
  return mapped === 'eq' || mapped === 'ne' ? { field, op: mapped, value } : { field, op: mapped, value };
}

function dayClause(field: string, word: string): FilterClause {
  const w = word.toLowerCase();
  return { field, op: 'period', when: w === 'today' ? 'this' : w === 'yesterday' ? 'last' : 'next', unit: 'day' };
}

/** Split on a top-level operator (`&&` or `||`), outside quotes and parentheses. */
function split(text: string, op: '&&' | '||'): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quote = !quote;
    else if (!quote && ch === '(') depth++;
    else if (!quote && ch === ')') depth--;
    else if (!quote && depth === 0 && ch === op[0] && text[i + 1] === op[1]) {
      out.push(text.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

/** Strip parentheses that wrap the whole clause. */
function unwrap(clause: string): string {
  let text = clause.trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < text.length - 1 && wraps; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) wraps = false;
    }
    if (!wraps) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Values the browser cannot know: the signed-in user, form inputs, other Deluge expressions. */
const RUNTIME_ONLY = /\b(zoho|input|thisapp)\./i;

function compileExpr(raw: string): { clause?: FilterClause; todos: string[] } {
  const text = unwrap(raw);
  const ors = split(text, '||');
  if (ors.length > 1) {
    const parts = ors.map(compileExpr);
    if (parts.some((part) => !part.clause || part.todos.length)) return { todos: [`filter not applied: ${text}`] };
    return { clause: { op: 'any', of: parts.map((part) => part.clause!) }, todos: [] };
  }
  const ands = split(text, '&&');
  if (ands.length > 1) {
    const parts = ands.map(compileExpr);
    const of = parts.flatMap((part) => (part.clause ? [part.clause] : []));
    return { ...(of.length ? { clause: { op: 'all' as const, of } } : {}), todos: parts.flatMap((part) => part.todos) };
  }
  const rule = RUNTIME_ONLY.test(text.replace(/zoho\.currentdate$/i, '')) ? undefined : CLAUSES.find((candidate) => candidate.re.test(text));
  const match = rule?.re.exec(text);
  return rule && match ? { clause: rule.make(match), todos: [] } : { todos: [`filter not applied: ${text}`] };
}

/**
 * Creator criteria → browser filter clauses. A conjunction keeps every clause
 * that translates; each one that does not becomes a TODO (the element then
 * shows more rows than Creator would, and says so). A disjunction applies only
 * when every branch translates.
 */
export function compileCriteria(raw: string | undefined): { filter: FilterClause[]; todos: string[] } {
  const text = decodeEntities(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { filter: [], todos: [] };
  const { clause, todos } = compileExpr(text);
  const filter = !clause ? [] : 'of' in clause && clause.op === 'all' ? clause.of : [clause];
  return { filter, todos };
}

interface Ctx {
  app: App;
  model: UiModel;
  reports: Map<string, UiReport>;
  forms: Set<string>;
  pageName: string;
}

function fieldLabel(ctx: Ctx, form: string | undefined, path: string): string {
  const head = path.split('.')[0]!;
  const field = ctx.app.forms.find((f) => f.name === form)?.fields.find((f) => f.name === head);
  const last = humanize(path.split('.').pop() ?? path);
  if (!field) return last;
  const label = field.displayName ?? humanize(field.name);
  return path.includes('.') ? `${label} ${last}` : label;
}

/** The report whose rows a form-level chart or metric reads: unfiltered reports first, then list views. */
function reportForForm(ctx: Ctx, form: string): { report?: UiReport; todos: string[] } {
  const candidates = ctx.model.reports.filter((r) => r.form === form && r.view !== 'chart' && r.queryEndpoint);
  const unfiltered = (r: UiReport) => !ctx.app.reports.find((ir) => ir.name === r.name)?.criteria?.trim();
  const ranked = [...candidates.filter(unfiltered), ...candidates.filter((r) => !unfiltered(r))];
  const report = ranked.find((r) => r.view === 'list') ?? ranked[0];
  if (!report) return { todos: [`no report reads the ${form} form, so there are no rows to draw`] };
  return { report, todos: unfiltered(report) ? [] : [`rows come from the ${report.label} report, which applies its own filter`] };
}

/** `count:Field,sum:Other` → measures. */
function measuresOf(ctx: Ctx, form: string | undefined, raw: string): { measures: MeasureSpec[]; todos: string[] } {
  const measures: MeasureSpec[] = [];
  const todos: string[] = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(count|sum|value):(.+)$/i.exec(part);
    if (!m) {
      todos.push(`measure ${part} is not drawn`);
      continue;
    }
    const fn = m[1]!.toLowerCase() as MeasureSpec['fn'];
    const field = m[2]!.trim();
    const name = fieldLabel(ctx, form, field);
    measures.push({ fn, field, label: fn === 'count' ? `Count of ${name}` : fn === 'sum' ? `Sum of ${name}` : name });
  }
  return { measures, todos };
}

const KIND_OF_TYPE: Record<string, ChartSpec['kind']> = {
  column: 'bar',
  bar: 'bar',
  'stacked column': 'bar',
  'stacked bar': 'bar',
  'percentage column': 'bar',
  funnel: 'bar',
  pyramid: 'bar',
  line: 'line',
  spline: 'line',
  area: 'line',
  'stacked area': 'line',
  pie: 'donut',
  donut: 'donut',
  'semi donut': 'donut',
  'semi pie': 'donut',
};

/** A ZML `<chart>` element: type, category field, measures, criteria. */
export function chartFromZml(ctx: Ctx, attributes: Record<string, string>): ChartSpec | { todo: string } {
  const type = attrOf(attributes, 'type') ?? 'Column';
  const kind = KIND_OF_TYPE[type.toLowerCase()];
  const form = attrOf(attributes, 'formLinkName');
  const x = attrOf(attributes, 'xfield');
  const yfields = attrOf(attributes, 'yfields');
  if (!kind) return { todo: `the ${type} chart type is not drawn yet` };
  if (!form || !x || !yfields) return { todo: `the chart has no form, category or measure in the export` };
  const source = reportForForm(ctx, form);
  const { measures, todos: measureTodos } = measuresOf(ctx, form, yfields);
  const criteria = compileCriteria(attrOf(attributes, 'DelugeCriteria', 'criteria'));
  const todos = [...source.todos, ...measureTodos, ...criteria.todos];
  const notes: string[] = [];
  const lower = type.toLowerCase();
  const groupBy = attrOf(attributes, 'groupBy');
  if (lower.startsWith('stacked') && groupBy && groupBy !== x) todos.push(`the stack by ${fieldLabel(ctx, form, groupBy)} is drawn as one total per ${fieldLabel(ctx, form, x)}`);
  if (lower === 'funnel' || lower === 'pyramid') notes.push(`The ${type} chart is drawn as bars.`);
  if (kind === 'donut' && measures.length > 1) todos.push(`only the first measure (${measures[0]!.label}) is drawn in the ${type} chart`);
  const title = attrOf(attributes, 'title') ?? `${measures[0]?.label ?? 'Records'} by ${fieldLabel(ctx, form, x)}`;
  return {
    kind,
    creatorType: type,
    title,
    ...(source.report ? { report: source.report.name } : {}),
    x,
    xLabel: attrOf(attributes, 'xtitle') ?? fieldLabel(ctx, form, x),
    measures: measures.length ? measures : [{ fn: 'count', field: '', label: 'Records' }],
    filter: criteria.filter,
    notes,
    todos,
  };
}

const ID_LIKE = /(^|_)(id|no|num|number|code|ref)$/i;
const OVER_TIME = /month|week|year|date|day|daily|trend|time/i;

/**
 * A chart report (Creator `pivotchart`). The export keeps no chart settings,
 * so the report's columns decide: a date column for a report named for a
 * period, else the first choice or lookup column, as the category; the first
 * numeric column that is not an identifier as the summed measure, else the
 * record count. The chart says how it was drawn.
 */
export function reportChart(app: App, report: UiReport): ChartSpec {
  const fields = new Map((app.forms.find((f) => f.name === report.form)?.fields ?? []).map((f) => [f.name, f]));
  const typeOf = (field: string) => (fields.get(field.split('.')[0]!)?.type ?? '').toLowerCase();
  const title = report.label.toLowerCase();
  const named = (c: { label: string }) => c.label.toLowerCase().split(/[^a-z0-9]+/).some((word) => word.length > 2 && title.includes(word));
  const measures0 = report.columns.filter((c) => c.numeric && !ID_LIKE.test(c.field) && !typeOf(c.field).startsWith('auto'));
  const measure = measures0.find(named) ?? measures0[0];
  const others = report.columns.filter((c) => !c.numeric);
  const by = /\bby\s+(.+)$/i.exec(report.label)?.[1]?.toLowerCase();
  const label =
    (by ? others.find((c) => c.label.toLowerCase().includes(by) || by.includes(c.label.toLowerCase())) : undefined) ??
    (OVER_TIME.test(`${report.name} ${report.label}`) ? others.find((c) => typeOf(c.field).startsWith('date')) : undefined) ??
    others.find((c) => fields.get(c.field)?.choices?.length || fields.get(c.field)?.lookup) ??
    others.find((c) => !ID_LIKE.test(c.field)) ??
    others[0] ??
    report.columns[0];
  const measures: MeasureSpec[] = measure ? [{ fn: 'sum', field: measure.field, label: `Sum of ${measure.label}` }] : [{ fn: 'count', field: '', label: 'Records' }];
  const xLabel = label?.label ?? 'Record';
  return {
    kind: 'auto',
    creatorType: report.type,
    title: report.label,
    report: report.name,
    x: label?.field ?? '',
    xLabel,
    measures,
    filter: [],
    notes: [`The Creator export keeps no chart settings: drawn as ${measure ? `the sum of ${measure.label}` : 'the record count'} by ${xLabel}.`],
    todos: label ? [] : ['the report has no column to group by'],
  };
}

function metricFromKpi(ctx: Ctx, el: { kpi?: { form?: string; field?: string; fn?: string; expression?: string }; criteria?: string }, suffix: string | undefined): MetricSpec | { todo: string } {
  const k = el.kpi ?? {};
  if (!k.form || !k.field || (k.fn !== 'count' && k.fn !== 'sum')) return { todo: `the value ${decodeEntities(k.expression ?? `${k.fn ?? ''}`).trim() || 'expression'} is not generated yet` };
  const named = ctx.reports.get(k.form);
  const source = named && named.view !== 'chart' ? { report: named, todos: [] as string[] } : reportForForm(ctx, k.form);
  const criteria = compileCriteria(el.criteria);
  return {
    ...(source.report ? { report: source.report.name } : {}),
    fn: k.fn,
    field: k.field,
    filter: criteria.filter,
    ...(suffix ? { suffix } : {}),
    todos: [...source.todos, ...criteria.todos],
  };
}

function leavesOf(elements: PageElement[]): PageElement[] {
  return elements.flatMap((el) => (el.kind === 'box' ? leavesOf(el.children) : [el]));
}

/** A caption worth a label: not a bare separator such as `-`. */
const meaningful = (el: PageElement): el is Extract<PageElement, { kind: 'text' }> => el.kind === 'text' && /[\p{L}\p{N}]/u.test(el.text);

/**
 * A Creator dashboard panel (an icon, `form data` values and their captions)
 * becomes metric cards. One value, or one caption: one card, the captions as
 * its label and any further values as its context line. Several of each: one
 * card per value, labelled by its nearest caption (on the side the panel
 * puts captions: before the values when it opens with a caption, else after).
 * The cards sit as one grid where the first value stood; every caption no
 * value claims — and every separator — stays as text exactly where it stood.
 */
function metricPanel(children: PageElement[]): PageElement[] {
  const leaves = leavesOf(children);
  const metrics = leaves.filter((el): el is Extract<PageElement, { kind: 'metric' }> => el.kind === 'metric');
  const texts = leaves.filter(meaningful);
  if (!metrics.length || !texts.length || leaves.some((el) => el.kind !== 'metric' && el.kind !== 'text' && el.kind !== 'icon')) return children;
  const icon = leaves.find((el): el is Extract<PageElement, { kind: 'icon' }> => el.kind === 'icon');
  if (metrics.length === 1 || texts.length === 1) {
    const [first, ...rest] = metrics;
    return [{ kind: 'metric', label: texts.map((t) => t.text).join(' · '), ...(icon ? { icon: icon.icon } : {}), value: first!.value, extra: rest.map((m) => ({ ...m.value, label: m.label })), ...(first!.style ? { style: first!.style } : {}) }];
  }
  const used = new Set<PageElement>();
  const before = leaves.indexOf(texts[0]!) < leaves.indexOf(metrics[0]!);
  const cards = metrics.map((metric, n): PageElement => {
    const at = leaves.indexOf(metric);
    let best: Extract<PageElement, { kind: 'text' }> | undefined;
    for (let d = 1; d < leaves.length && !best; d++) {
      for (const candidate of before ? [leaves[at - d], leaves[at + d]] : [leaves[at + d], leaves[at - d]]) {
        if (!best && candidate && meaningful(candidate) && !used.has(candidate)) best = candidate;
      }
    }
    if (best) used.add(best);
    return { ...metric, label: best?.text ?? metric.label, ...(n === 0 && icon ? { icon: icon.icon } : {}) };
  });
  const out: PageElement[] = [];
  let placed = false;
  for (const leaf of leaves) {
    if (leaf.kind === 'metric') {
      if (!placed) {
        out.push({ kind: 'box', tag: 'metrics', children: cards });
        placed = true;
      }
      continue;
    }
    if (leaf.kind === 'icon') continue; // the icon rides on the first card
    if (leaf.kind === 'text' && used.has(leaf)) continue; // claimed as a card label
    out.push(leaf);
  }
  return out;
}

function safeHref(url: string): string | undefined {
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined;
}

function convert(ctx: Ctx, node: ZmlElement): PageElement[] {
  const key = node.tag.toLowerCase();
  const ui = elementFromZml(node.tag, node.attributes, [], node.text);
  const kids = (skip?: (child: ZmlElement) => boolean) => node.children.filter((child) => !skip?.(child)).flatMap((child) => convert(ctx, child));
  const style = ui.style ? { style: ui.style } : {};
  if (ui.kind === 'container') {
    const children = kids();
    return [{ kind: 'box', tag: key, ...(ui.width ? { width: ui.width } : {}), ...style, ...(ui.href ? { href: ui.href } : {}), children: key === 'panel' ? metricPanel(children) : children }];
  }
  if (ui.kind === 'kpi') {
    const isSuffix = (child: ZmlElement) => child.tag.toLowerCase() === 'suffix';
    const suffixNode = node.children.find(isSuffix);
    const metric = metricFromKpi(ctx, ui, suffixNode ? attrOf(suffixNode.attributes, 'value') : undefined);
    const fn = ui.kpi?.fn === 'count' ? 'Count' : 'Sum';
    // No report reads this form, so there is no number to show: a wrong 0 is
    // worse than none. The metric becomes a TODO where it stood (a filter has
    // nothing to filter without rows, so its TODOs fall away with it).
    if (!('todo' in metric) && !metric.report) {
      const label = metric.fn === 'count' ? `${fn} of records` : `${fn} of ${fieldLabel(ctx, ui.kpi?.form, metric.field)}`;
      return [{ kind: 'todo', tag: node.tag, reason: `the ${label} metric has no report to read, so it shows no value` }, ...kids(isSuffix)];
    }
    const head: PageElement =
      'todo' in metric
        ? { kind: 'todo', tag: node.tag, reason: metric.todo }
        : { kind: 'metric', label: metric.fn === 'count' ? `${fn} of records` : `${fn} of ${fieldLabel(ctx, ui.kpi?.form, metric.field)}`, value: metric, extra: [], ...style };
    return [head, ...kids(isSuffix)];
  }
  if (ui.icon !== undefined) return [{ kind: 'icon', icon: ui.icon, ...style }, ...kids()];
  if (ui.kind === 'text') {
    const text = decodeEntities(ui.text ?? '').trim();
    return [...(text ? [{ kind: 'text' as const, text, ...style }] : []), ...kids()];
  }
  if (ui.kind === 'html') {
    const raw = (node.text ?? attrOf(node.attributes, 'value', 'content', 'html', 'text') ?? '').trim();
    const links = (ui.popups ?? []).map((popup) => ({ label: `Open ${humanize(popup.name)}`, href: `#/${popup.target}/${encodeURIComponent(popup.name)}` }));
    // A plain link stays passive: Creator opened these popups on their own
    // (`always`) or when a form had no rows (`empty`), so each keeps a TODO
    // naming the trigger the link no longer carries.
    const triggers = (ui.popups ?? []).map((popup) =>
      popup.when === 'empty'
        ? `the ${humanize(popup.name)} ${popup.target} opened on its own in Creator when ${humanize(popup.whenForm ?? popup.name)} had no records; here it is a link`
        : `the ${humanize(popup.name)} ${popup.target} opened on its own in Creator; here it is a link`,
    );
    const html = (ui.html ?? '').trim();
    const pageSelector = ctx.pageName.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch.codePointAt(0)!.toString(16)} `);
    const carried = carriedStyleRules(raw, `[data-page="${pageSelector}"]`);
    const out: PageElement[] = [];
    if (html || links.length) out.push({ kind: 'html', html, links });
    // Keep the same sanitizer loss details and precedence as the vanilla model.
    for (const tag of ui.droppedTags ?? []) {
      if (tag === 'style' && (ui.droppedStyleRules ?? 0) > 0) continue;
      out.push({ kind: 'todo', tag: node.tag, reason: `The <${tag}> element is removed from this page snippet by the sanitizer` });
    }
    if (carried.droppedRules > 0) {
      const lost = droppedStyleRulesTodo('page', carried.droppedRules);
      out.push({ kind: 'todo', tag: node.tag, reason: lost.reason });
    }
    for (const child of ui.children ?? []) {
      if (child.kind === 'todo' && child.siteId) out.push({ kind: 'todo', tag: child.tag, reason: child.todo ?? `ZML <${child.tag}> has no generated component`, siteId: child.siteId });
    }
    for (const reason of triggers) out.push({ kind: 'todo', tag: node.tag, reason });
    if (raw && !html && !ui.droppedTags?.length && !ui.children?.some((child) => child.siteId)) out.push({ kind: 'todo', tag: node.tag, reason: 'the HTML snippet is built by a server-side script; it is not generated yet' });
    return [...out, ...kids()];
  }
  if (ui.kind === 'chart') {
    const chart = chartFromZml(ctx, node.attributes);
    return ['todo' in chart ? { kind: 'todo', tag: node.tag, reason: chart.todo } : { kind: 'chart', chart }, ...kids()];
  }
  if (ui.kind === 'report') {
    const name = ui.name ?? '';
    const report = ctx.reports.get(name);
    if (!report) return [{ kind: 'todo', tag: node.tag, reason: `the ${name || 'unnamed'} report is not part of the app` }, ...kids()];
    if (report.view === 'chart') return [{ kind: 'chart', chart: reportChart(ctx.app, report) }, ...kids()];
    return [{ kind: 'report', report: name, label: attrOf(node.attributes, 'title') ?? report.label }, ...kids()];
  }
  if (ui.kind === 'form') {
    const name = ui.name ?? '';
    if (!ctx.forms.has(name)) return [{ kind: 'todo', tag: node.tag, reason: `the ${name || 'unnamed'} form is not part of the app` }, ...kids()];
    const label = ctx.model.forms.find((f) => f.name === name)?.label ?? humanize(name);
    return [{ kind: 'form', form: name, label: attrOf(node.attributes, 'title') ?? label }, ...kids()];
  }
  if (ui.kind === 'button') {
    const label = decodeEntities(ui.text ?? ui.name ?? 'Button');
    const action = (attrOf(node.attributes, 'action') ?? '').toLowerCase();
    const target = attrOf(node.attributes, 'componentLinkName');
    const route = action === 'openform' ? 'form' : action === 'openreport' ? 'report' : action === 'openpage' ? 'page' : undefined;
    const known = route === 'form' ? ctx.forms.has(target ?? '') : route === 'report' ? ctx.reports.has(target ?? '') : route === 'page' ? ctx.model.pages.some((p) => p.name === target) : false;
    const href = route && target && known ? `#/${route}/${encodeURIComponent(target)}` : ui.href ? safeHref(ui.href) : undefined;
    if (!href) return [{ kind: 'todo', tag: node.tag, reason: `the ${label} button has no action the app can run` }, ...kids()];
    const parameters = attrOf(node.attributes, 'parameters');
    return [
      { kind: 'button', label, href, ...style },
      ...(parameters ? [{ kind: 'todo' as const, tag: node.tag, reason: `the ${label} button opens without its values (${parameters})` }] : []),
      ...kids(),
    ];
  }
  if (key === 'embed') {
    const href = safeHref(attrOf(node.attributes, 'url', 'src') ?? '');
    return [href ? { kind: 'link', label: attrOf(node.attributes, 'title') ?? 'Open the embedded page', href } : { kind: 'todo', tag: node.tag, reason: 'the embed has no web address' }, ...kids()];
  }
  if (key === 'suffix') {
    const text = attrOf(node.attributes, 'value');
    return [...(text ? [{ kind: 'text' as const, text, ...style }] : []), ...kids()];
  }
  if (key === 'dspzml') return [{ kind: 'todo', tag: node.tag, reason: 'the ZML snippet is built by a server-side script; it is not generated yet' }, ...kids()];
  return [{ kind: 'todo', tag: node.tag, reason: ui.todo ?? `ZML <${node.tag}> has no generated component` }, ...kids()];
}

/** Every TODO on a page, in page order, named by the element that carries it. */
function pageTodos(elements: PageElement[]): string[] {
  const out: string[] = [];
  const walk = (el: PageElement) => {
    if (el.kind === 'box') el.children.forEach(walk);
    else if (el.kind === 'todo') out.push(`<${el.tag}>: ${el.reason}`);
    else if (el.kind === 'chart') for (const todo of el.chart.todos) out.push(`chart "${el.chart.title}": ${todo}`);
    else if (el.kind === 'metric') for (const m of [el.value, ...el.extra]) for (const todo of m.todos) out.push(`value "${m.label ?? el.label}": ${todo}`);
  };
  elements.forEach(walk);
  return out;
}

/** The spec of every Creator page, in model order. */
export function pageSpecs(app: App, model: UiModel): Record<string, PageSpec> {
  const ctx: Ctx = { app, model, reports: new Map(model.reports.map((r) => [r.name, r])), forms: new Set(model.forms.map((f) => f.name)), pageName: '' };
  const out: Record<string, PageSpec> = {};
  for (const page of model.pages) {
    ctx.pageName = page.name;
    const ir = app.pages.find((p) => p.name === page.name);
    const elements: PageElement[] = ir?.zml.length
      ? ir.zml.flatMap((node) => convert(ctx, node))
      : ir?.content?.trim()
        ? [{ kind: 'text', text: ir.content.trim() }]
        : [];
    out[page.name] = { name: page.name, label: page.label, ...(page.scopedCss ? { scopedCss: page.scopedCss } : {}), elements, todos: pageTodos(elements) };
  }
  return out;
}
