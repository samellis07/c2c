/**
 * Manual-step guidance for a server-side Deluge snippet the compiler leaves
 * as a TODO. The TODO keeps its fixed reason and stays counted; this only
 * names why it could not be translated safely and what to rebuild by hand.
 *
 * The reasons come from the snippet source and the compiler's refusal, in a
 * fixed order, so the same snippet always yields the same step text.
 */
import type { App, Report } from '../../core/src/index.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { criteriaHasRelative, criteriaHasTodo } from '../../shims/src/criteria.js';
import { DROPPED_TAGS, droppedStyles } from './pages.js';

export const INTERNAL_RECORD_SUMMARY =
  /^(?:https?:\/\/(?:[A-Za-z0-9-]+\.)*(?:zohocreator\.(?:com|in|eu|com\.au|com\.cn)|creator(?:app)?\.zoho\.(?:com|in|eu|com\.au|com\.cn))(?::\d+)?)?(?:<%=\s*zoho\.appuri\s*%>\/?|\/)?record-summary\/([A-Za-z_]\w*)\/<%=([\s\S]+?)%>$/i;

/**
 * Every reason a server snippet stays counted, in report order. analyze,
 * the UI model and ui-manual-steps.json use only these values.
 */
export const SNIPPET_REASONS = ['write', 'render-navigation', 'caller-read', 'markup-function', 'dynamic-url', 'sanitizer-loss', 'untranslated'] as const;

export type SnippetReason = (typeof SNIPPET_REASONS)[number];

export interface SnippetGuidance {
  reasons: SnippetReason[];
  step: string;
}

/** Compiler refusals that mean a Deluge construct had no verified translation. */
const TRANSLATION_REFUSALS = new Set([
  'malformed Deluge island',
  'no Deluge islands',
  'marker collision',
  'Deluge islands do not parse',
  'island outside the handled classes',
  'island translation failed',
  'island needs manual translation',
  'island needs a client step',
  'untranslated construct',
]);

const URL_REFUSALS = new Set(['url attribute boundary not found', 'island in an unsafe position']);

const WRITE_PATTERNS = [
  /\binsert\s+into\b/i,
  /\bdelete\s+from\b/i,
  /\.\s*(?:delete|update)\s*\(/i,
  /\bsendmail\b/i,
  /\binvokeurl\b/i,
  /\bzoho\.[a-z]+\.\w*(?:create|update|delete|upload|send|add)\w*\s*\(/i,
  /\bthisapp\.\w+(?:\.\w+)?\s*\(/i,
  // A `record.Field = value` statement on anything but the request-local input map.
  /(?:^|[;{}\n])\s*(?!input\.)[A-Za-z_]\w*\.[A-Za-z_]\w*\s*=(?!=)/,
];

const EMBED_TAGS = new Set(['iframe', 'object', 'embed', 'frame', 'frameset']);
/** Document wrappers the sanitizer unwraps without losing content. */
const WRAPPER_TAGS = new Set(['html', 'head', 'body', 'title', 'meta']);

const STEPS: Record<SnippetReason, string> = {
  write:
    'It writes during page rendering (insert, update, delete, mail, an external call, or an app function). Keep the rendered page read-only and move each write into an explicit, authenticated user action such as a form submit or a button route.',
  'render-navigation':
    'It calls openUrl while the page renders. Replace the call with a link or button the user clicks, and check the destination against the app\'s own form, report, and page routes.',
  'caller-read':
    'It reads records filtered by the signed-in user or by page parameters. Serve those reads from a server route that checks the caller\'s read grant for each form and field and passes the parameters as bound criteria values.',
  'markup-function': 'It prints HTML built by app function',
  'dynamic-url':
    'It builds an iframe, embed, or link URL at render time. Rebuild it with a fixed allowlisted destination or a generated form or report route, and encode each dynamic part.',
  'sanitizer-loss': 'The sanitizer drops part of its static markup',
  untranslated: 'The compiler stopped at a Deluge construct with no verified translation',
};

/** A Deluge string literal that holds markup. */
export const MARKUP_LITERAL = /"[^"\n]*<[A-Za-z/!%]/;

/**
 * App functions the snippet calls directly (`thisapp.<name>(...)`) whose body
 * holds a markup string literal, in call order. The function resolves the way
 * the generated registry does: exact name, then case-insensitive.
 */
function markupFunctions(code: string, app: App | undefined): string[] {
  if (!app) return [];
  const names: string[] = [];
  for (const m of code.matchAll(/\bthisapp\s*\.\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g)) {
    const name = (m[1] ?? '').replace(/\s+/g, '');
    const fn = app.functions.find((item) => item.name === name) ?? app.functions.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (fn && fn.deluge.some((d) => MARKUP_LITERAL.test(d.text)) && !names.includes(fn.name)) names.push(fn.name);
  }
  return names;
}

/** Attributes that carry a URL, an embed target, or embed parameters. */
const EMBED_VALUE_ATTRS = /^(?:src|href|action|formaction|data|poster|url|params|parameters|(?:form|view|report|page|component)linkname)$/i;

/**
 * `element attribute` pairs whose value holds a `<% %>` island and names a URL,
 * an embed target, or embed parameters, in source order without repeats. A
 * zc-component is labelled with its static link name when it has one.
 */
function islandEmbedValues(source: string): string[] {
  let flat = '';
  let pos = 0;
  for (;;) {
    const open = source.indexOf('<%', pos);
    if (open < 0) break;
    const close = source.indexOf('%>', open + 2);
    if (close < 0) break;
    flat += source.slice(pos, open) + '\u0001';
    pos = close + 2;
  }
  flat += source.slice(pos);
  const out: string[] = [];
  for (const tag of flat.matchAll(/<([A-Za-z][\w-]*)((?:[^<>"']|"[^<"]*"|'[^<']*')*)>/g)) {
    const attrs = [...(tag[2] ?? '').matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+)/g)].map((m) => ({
      name: m[1] ?? '',
      value: (m[2] ?? '').replace(/^["']|["']$/g, ''),
    }));
    const dynamic = attrs.filter((a) => a.value.includes('\u0001') && EMBED_VALUE_ATTRS.test(a.name)).map((a) => a.name);
    if (!dynamic.length) continue;
    const component = attrs.some((a) => /^elname$/i.test(a.name) && /^zc-component$/i.test(a.value));
    const link = attrs.find((a) => /^(?:form|view|report|page|component)linkname$/i.test(a.name) && /^[A-Za-z_]\w*$/.test(a.value));
    const element = component ? `zc-component${link ? ` ${link.value}` : ''}` : (tag[1] ?? '').toLowerCase();
    for (const name of dynamic) {
      const label = `${element} ${name}`;
      if (!out.includes(label)) out.push(label);
    }
  }
  return out;
}

/** Deluge code inside the snippet's `<% %>` islands. */
function islandCode(source: string): string {
  return splitIslands(source).islands.join('\n');
}

/**
 * Split `<% %>` islands from the markup with a linear scan (a lazy regex is
 * quadratic on many unclosed `<%`). An unclosed `<%` stays in the markup.
 */
function splitIslands(source: string): { islands: string[]; markup: string } {
  const islands: string[] = [];
  let markup = '';
  let pos = 0;
  for (;;) {
    const open = source.indexOf('<%', pos);
    if (open < 0) break;
    const start = source[open + 2] === '=' ? open + 3 : open + 2;
    const close = source.indexOf('%>', start);
    if (close < 0) break;
    markup += source.slice(pos, open);
    islands.push(source.slice(start, close));
    pos = close + 2;
  }
  return { islands, markup: markup + source.slice(pos) };
}

/** Header parameters of `htmlpage name(a, b)`. */
function headerParams(source: string): string[] {
  const head = /^\s*htmlpage\s+[\w.]+\s*\(([^)]*)\)/i.exec(source);
  return (head?.[1] ?? '')
    .split(',')
    .map((p) => p.trim().split(/\s+/).pop() ?? '')
    .filter((p) => /^[A-Za-z_]\w*$/.test(p));
}

const CALLER_FILTER_CRITERIA =
  /^\s*(?:[A-Za-z_]\w*\s*==\s*zoho\.loginuser(?:id)?|zoho\.loginuser(?:id)?\s*==\s*[A-Za-z_]\w*)\s*$/i;

interface KnownSummary {
  report: Report;
  form: string;
  varName?: string;
}

function isSummaryVarReadMatch(
  code: string,
  matchIndex: number,
  matchLength: number,
  form: string,
  criteria: string,
  summaries: KnownSummary[],
): boolean {
  if (!summaries.length || !CALLER_FILTER_CRITERIA.test(criteria)) return false;
  const before = code.slice(0, matchIndex);
  const lhs = /(?:^|[;{}\r\n])\s*([A-Za-z_]\w*)\s*=\s*$/.exec(before);
  if (!lhs) return false;
  const varName = lhs[1];
  const after = code.slice(matchIndex + matchLength);
  if (!/^\s*\.\s*ID\s*(?:;|$|[\r\n}])/i.test(after)) return false;
  return summaries.some((s) => s.varName === varName && s.form.toLowerCase() === form.toLowerCase());
}

function readsForCaller(code: string, params: string[], summaries: KnownSummary[] = []): boolean {
  if (/\bzoho\.creator\.getRecords?(?:ById)?\s*\(/i.test(code)) return true;
  const caller = [/\bzoho\.loginuser(?:id)?\b/i, /\binput\.\w+/];
  for (const p of params) caller.push(new RegExp(`\\b${p}\\b`));
  // A form read `Form[criteria]`; an `insert into Form [ ... ]` block is a write, not a read.
  for (const match of code.matchAll(/(?<!\binsert\s+into\s+)\b([A-Za-z_]\w*)\s*\[([^\]]*)\]/gi)) {
    const form = match[1] ?? '';
    const criteria = match[2] ?? '';
    if (!/==|!=|<|>|\b(?:in|contains|startsWith|endsWith)\b/i.test(criteria)) continue;
    if (isSummaryVarReadMatch(code, match.index ?? 0, match[0].length, form, criteria, summaries)) continue;
    if (caller.some((re) => re.test(criteria))) return true;
  }
  return false;
}

function droppedTags(markup: string): string[] {
  const found = new Set<string>();
  for (const match of markup.matchAll(/<\s*([A-Za-z][\w-]*)/g)) {
    const tag = (match[1] ?? '').toLowerCase();
    if (DROPPED_TAGS.has(tag) && !EMBED_TAGS.has(tag) && !WRAPPER_TAGS.has(tag)) found.add(tag);
  }
  return [...found].sort();
}

/**
 * True when the snippet code assigns `varName` exactly once, and that single assignment
 * derives from `<Form>[<field> == zoho.loginuserid|zoho.loginuser].ID` where `form` matches
 * the report's base form.
 */
export function isCallerFilteredVariable(source: string, varName: string, form: string): boolean {
  if (!/^[A-Za-z_]\w*$/.test(varName) || !/^[A-Za-z_]\w*$/.test(form)) return false;
  const code = source.includes('<%') ? islandCode(source) : source;
  const assignRe = new RegExp(`(?<![.\\w])${varName}(?![\\w])\\s*=(?!=)`, 'g');
  const matches = [...code.matchAll(assignRe)];
  if (matches.length !== 1) return false;
  const match = matches[0];
  // Statement-start check, kept linear: strip trailing non-newline whitespace,
  // then the last character must be a separator or the text all whitespace.
  const before = code.slice(0, match.index).replace(/[^\S\r\n]+$/, '');
  if (before !== '' && !/[;{}\r\n]$/.test(before)) return false;

  const afterEqual = code.slice(match.index + match[0].length);
  const semiIdx = afterEqual.indexOf(';');
  const rhs = (semiIdx >= 0 ? afterEqual.slice(0, semiIdx) : afterEqual.split(/[\r\n}]/)[0] ?? '').trim();

  // `<form>[<criteria>].ID`, parsed with indexOf instead of a lazy-bracket
  // regex so adversarial whitespace cannot trigger polynomial backtracking.
  const openIdx = rhs.indexOf('[');
  const closeIdx = openIdx < 0 ? -1 : rhs.indexOf(']', openIdx + 1);
  const rhsForm = openIdx < 0 ? '' : rhs.slice(0, openIdx).trim();
  const criteria = closeIdx < 0 ? '' : rhs.slice(openIdx + 1, closeIdx);
  if (
    closeIdx < 0 ||
    !/^[A-Za-z_]\w*$/.test(rhsForm) ||
    criteria.length === 0 ||
    criteria.includes('[') ||
    !/^\s*\.\s*ID$/i.test(rhs.slice(closeIdx + 1))
  ) {
    return false;
  }
  if (rhsForm.toLowerCase() !== form.toLowerCase()) return false;
  return CALLER_FILTER_CRITERIA.test(criteria);
}

export function isKnownReportSummaryUrl(url: string, app?: App, source?: string): boolean {
  if (!app) return false;
  const match = INTERNAL_RECORD_SUMMARY.exec(url.trim());
  if (!match) return false;
  const target = match[1];
  const report = app.reports.find((r) => r.name === target);
  if (!report) return false;
  const form = report.form ?? target;
  if (!app.forms.some((f) => f.name === form) || !/^[A-Za-z_]\w*$/.test(form)) return false;
  const criteria = reportCriteria(report.criteria?.trim() || 'true');
  if (criteriaHasTodo(criteria) || criteriaHasRelative(criteria)) return false;

  const idExpr = match[2].trim();
  const read = new RegExp(`^${form}\\s*\\[[^\\[\\]]+\\]\\s*\\.\\s*ID$`, 'i').test(idExpr);
  const param = /^input\.[A-Za-z_]\w*$/.test(idExpr);
  const variable = /^[A-Za-z_]\w*$/.test(idExpr) && isCallerFilteredVariable(source ?? '', idExpr, form);
  return read || param || variable;
}

function findKnownSummaries(source: string, app?: App): KnownSummary[] {
  if (!app) return [];
  const results: KnownSummary[] = [];
  for (const m of source.matchAll(/<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*?)>/gi)) {
    const src = /\bsrc\s*=\s*(["'])([\s\S]*?)\1/i.exec(m[1]);
    if (!src) continue;
    const url = src[2].trim();
    const match = INTERNAL_RECORD_SUMMARY.exec(url);
    if (!match) continue;
    const target = match[1];
    const report = app.reports.find((r) => r.name === target);
    if (!report) continue;
    const form = report.form ?? target;
    if (!app.forms.some((f) => f.name === form) || !/^[A-Za-z_]\w*$/.test(form)) continue;
    const criteria = reportCriteria(report.criteria?.trim() || 'true');
    if (criteriaHasTodo(criteria) || criteriaHasRelative(criteria)) continue;
    const idExpr = match[2].trim();
    const read = new RegExp(`^${form}\\s*\\[[^\\[\\]]+\\]\\s*\\.\\s*ID$`, 'i').test(idExpr);
    const param = /^input\.[A-Za-z_]\w*$/.test(idExpr);
    const isVar = /^[A-Za-z_]\w*$/.test(idExpr) && isCallerFilteredVariable(source, idExpr, form);
    if (read || param || isVar) {
      results.push({ report, form, varName: isVar ? idExpr : undefined });
    }
  }
  return results;
}

function hasOtherEmbedOrIslandUrl(source: string, markup: string, summaries: KnownSummary[], app?: App): { hasEmbed: boolean; hasIslandUrl: boolean } {
  const nonIframeEmbeds = [...markup.matchAll(/<\s*([A-Za-z][\w-]*)/g)].some((m) => {
    const tag = (m[1] ?? '').toLowerCase();
    return EMBED_TAGS.has(tag) && tag !== 'iframe';
  });
  const totalIframes = [...source.matchAll(/<iframe\b/gi)].length;
  const hasEmbed = nonIframeEmbeds || totalIframes > summaries.length;

  const urlAttrs = [...source.matchAll(/\b(?:src|href|action|formaction|data|poster)\s*=\s*(?:(["'])([\s\S]*?)\1|([^\s>]+))/gi)];
  const islandUrls = urlAttrs.filter((m) => (m[2] ?? m[3] ?? '').includes('<%'));
  const allowedIslandUrls = islandUrls.filter((m) => isKnownReportSummaryUrl((m[2] ?? m[3] ?? '').trim(), app, source));
  const hasIslandUrl = islandUrls.length > allowedIslandUrls.length;

  return { hasEmbed, hasIslandUrl };
}

/**
 * Guidance for one counted snippet. `source` is the decoded snippet text,
 * `refusal` the compiler's reason (absent when it was not compiled), and
 * `location` names the snippet and its page.
 */
export function serverSnippetGuidance(source: string, refusal: string | undefined, location: string, app?: App): SnippetGuidance {
  const code = islandCode(source);
  const markup = splitIslands(source).markup.replace(/^\s*htmlpage\b[^\n]*\n?/i, '');
  const summaries = findKnownSummaries(source, app);
  const reasons: SnippetReason[] = [];
  if (WRITE_PATTERNS.some((re) => re.test(code)) || refusal === 'island is not a read-only render' || refusal === 'island writes are unguarded' || refusal === 'island is not an allowed write render') reasons.push('write');
  if (/\bopenUrl\s*\(/i.test(code) || refusal === 'openUrl could not be rewritten') reasons.push('render-navigation');
  if (readsForCaller(code, headerParams(source), summaries)) reasons.push('caller-read');
  const htmlFunctions = markupFunctions(code, app);
  if (htmlFunctions.length) reasons.push('markup-function');
  const embeds = [...markup.matchAll(/<\s*([A-Za-z][\w-]*)/g)].some((m) => EMBED_TAGS.has((m[1] ?? '').toLowerCase()));
  const islandUrl = /\b(?:src|href|action|formaction|data|poster)\s*=\s*["']?[^"'>\s]*<%/i.test(source);
  if (embeds || islandUrl || (refusal !== undefined && URL_REFUSALS.has(refusal))) {
    const { hasEmbed, hasIslandUrl } = summaries.length
      ? hasOtherEmbedOrIslandUrl(source, markup, summaries, app)
      : { hasEmbed: embeds, hasIslandUrl: islandUrl };
    if (hasEmbed || hasIslandUrl || (refusal !== undefined && URL_REFUSALS.has(refusal))) {
      reasons.push('dynamic-url');
    }
  }
  const lost = [...droppedTags(markup).map((t) => `<${t}>`), ...[...new Set(droppedStyles(markup))].sort()];
  if (lost.length || refusal === 'static markup contains a dropped style declaration') reasons.push('sanitizer-loss');
  if (!reasons.length || (refusal !== undefined && TRANSLATION_REFUSALS.has(refusal))) reasons.push('untranslated');

  reasons.sort((a, b) => SNIPPET_REASONS.indexOf(a) - SNIPPET_REASONS.indexOf(b));
  const steps = reasons.map((reason) => {
    if (reason === 'sanitizer-loss') {
      const what = lost.length ? ` (${lost.join(', ')})` : '';
      const script = lost.includes('<script>') ? ' Rebuild its script as reviewed client code.' : '';
      const css = lost.length === 0 || lost.some((item) => item !== '<script>') ? ' Move its CSS and other dropped markup into the app stylesheet or supported components.' : '';
      return `${STEPS[reason]}${what}.${css}${script}`;
    }
    if (reason === 'dynamic-url') {
      const carriers = islandEmbedValues(source);
      return carriers.length ? STEPS[reason].replace('at render time.', `at render time (${carriers.join(', ')}).`) : STEPS[reason];
    }
    if (reason === 'markup-function') {
      return `${STEPS[reason]}${htmlFunctions.length > 1 ? 's' : ''} ${htmlFunctions.join(', ')}. A generated page prints a function value as escaped text, so rebuild that HTML as page markup or supported components that show the same values.`;
    }
    if (reason === 'untranslated') {
      const at = refusal && TRANSLATION_REFUSALS.has(refusal) ? ` (${refusal})` : '';
      return `${STEPS[reason]}${at}. Rebuild the section with supported components, or translate the construct by hand with a test.`;
    }
    return STEPS[reason];
  });
  return { reasons, step: `${location}: ${steps.join(' ')} Keep this TODO open until the rebuilt section is verified.` };
}
