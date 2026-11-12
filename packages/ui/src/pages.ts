/**
 * ZML page elements → a small element tree the PWA can render.
 * Layout wrappers stay containers. A tag this generator does not draw becomes
 * a TODO on that element; its children are still kept.
 *
 * HTML snippets are parsed with the DOM and rebuilt from an allowlist. A regex
 * strip leaves slash-separated handlers (`<svg/onload=...>`) in place.
 */

import { createRequire } from 'node:module';
import type { App, Form } from '../../core/src/ir.js';
import type { ZmlElement } from '../../core/src/zml.js';
import type { SchemaPlan } from '../../schema/src/generator.js';
import {
  compileHtmlpage,
  convertZmlSnippetToHtml,
  decodeXmlEntities,
  EXECUTE_FUNCTION_BUTTON,
  formActionTarget,
  isFormAction,
  isReportAction,
  reportActionTarget,
  zmlExecuteFunctionButtons,
  zmlImageActions,
  type HtmlpageFile,
  type ZmlImageAction,
} from './htmlpage.js';
import { serverSnippetGuidance, type SnippetReason } from './snippet-guidance.js';
import { pcClickHref, pcClickParameters, reportFormFields } from './click-parameters.js';
import { safeUrl } from './url-policy.js';

const require = createRequire(import.meta.url);

/**
 * Collapse the deliberately small class of page-load conditionals whose
 * predicate is already known while generating the page.  A literal predicate
 * cannot vary between callers, so retaining the Deluge block would only turn
 * static markup into an unnecessary server-side TODO.  Anything involving an
 * input, record, or helper is left untouched and remains subject to the normal
 * htmlpage compiler/runtime checks.
 */
/**
 * Mask HTML comments (`<!-- ... -->` or Creator's `<!-- ... --!>`) to spaces,
 * but only in static markup — comments and islands are mutually exclusive
 * regions, so whichever delimiter (`<!--` or `<%`) occurs first in the
 * remaining text determines which one is actually being entered next:
 *  - A `<!--` that opens before any upcoming `<%` is a real comment: scan to
 *    its terminator and mask the whole span, INCLUDING any island-looking
 *    text inside it (a fake `<% } %>` written as plain comment content is
 *    exactly what this is meant to hide, same as before this fix).
 *  - A `<%`/`<%{` that opens before any upcoming `<!--` is a real island:
 *    skip it verbatim using the same closer-walking rule `splitChunks` uses,
 *    so a string literal that merely looks like a comment delimiter (e.g.
 *    `s = "<!--"`) is never mistaken for the start of a real comment, and a
 *    live island between two separate real comments is never swallowed
 *    regardless of which terminator the first one uses.
 */
function maskStaticComments(source: string): string {
  let out = '', at = 0;
  for (;;) {
    const commentAt = source.indexOf('<!--', at);
    const islandAt = source.indexOf('<%', at);
    if (commentAt < 0 && islandAt < 0) return out + source.slice(at);
    if (islandAt >= 0 && (commentAt < 0 || islandAt < commentAt)) {
      out += source.slice(at, islandAt);
      let close: number;
      if (source.startsWith('<%{', islandAt)) {
        const brace = source.indexOf('%}', islandAt + 3);
        const plain = source.indexOf('%>', islandAt + 3);
        if (brace < 0 && plain < 0) return out + source.slice(islandAt);
        close = brace >= 0 && (plain < 0 || brace < plain) ? brace + (source.startsWith('%}>', brace) ? 3 : 2) : plain + 2;
      } else {
        const end = source.indexOf('%>', islandAt + 2);
        if (end < 0) return out + source.slice(islandAt);
        close = end + 2;
      }
      out += source.slice(islandAt, close);
      at = close;
      continue;
    }
    out += source.slice(at, commentAt);
    const terminator = /--!?>/.exec(source.slice(commentAt + 4));
    if (!terminator) return out + source.slice(commentAt).replace(/[^\r\n]/g, ' ');
    const close = commentAt + 4 + terminator.index + terminator[0].length;
    out += source.slice(commentAt, close).replace(/[^\r\n]/g, ' ');
    at = close;
  }
}

function resolveStaticConditionals(source: string): string {
  const conditional = /<%\s*if\s*\(\s*(true|false)\s*\)\s*\{\s*%>([\s\S]*?)<%\s*\}\s*else\s*\{\s*%>([\s\S]*?)<%\s*\}\s*%>/gi;
  // Delimiters inside an HTML comment are markup, not conditional syntax. Mask
  // them while finding matches so a comment-wrapped <% } %> cannot terminate
  // the false arm early; preserve offsets so replacements use the source text.
  const masked = maskStaticComments(source);
  // A nested `if` is always a real conditional boundary. A bare `}` is also
  // suspect in both island shapes: splitChunks keeps `slice(open + 3, brace)`
  // as the paired `<%{ ... %}>` island's statement text (the `%}>` itself is
  // the delimiter, consumed separately), so a `}` inside that slice is body
  // content — e.g. a nested closer like `<%{ }%}>` or a stray `}` in a
  // statement — not the wrapper's own delimiter. Treat it the same as a bare
  // `}` inside a plain `<% %>` island: a possible fragment of some other
  // block's closer, and therefore real nesting.
  const hasIfOrBrace = /\bif\b|}/;
  // Walk every island in an arm the same way splitChunks does: a `<%{` island
  // ends at whichever of `%}` or `%>` comes first (so a bare `<% } %>` closer
  // and a paired `<%{ }%}>` closer are both found, not just one of the two);
  // a plain `<%` island, or a `<%{` one where `%>` wins (an ordinary brace
  // inside a plain island, per splitChunks), ends at the next `%>`.
  const nested = (arm: string) => {
    let at = 0;
    for (;;) {
      const open = arm.indexOf('<%', at);
      if (open < 0) return false;
      if (arm.startsWith('<%{', open)) {
        const brace = arm.indexOf('%}', open + 3);
        const plain = arm.indexOf('%>', open + 3);
        if (brace < 0 && plain < 0) return false;
        if (brace >= 0 && (plain < 0 || brace < plain)) {
          if (hasIfOrBrace.test(arm.slice(open + 3, brace))) return true;
          at = brace + (arm.startsWith('%}>', brace) ? 3 : 2);
          continue;
        }
        if (hasIfOrBrace.test(arm.slice(open + 2, plain))) return true;
        at = plain + 2;
        continue;
      }
      const close = arm.indexOf('%>', open + 2);
      if (close < 0) return false;
      if (hasIfOrBrace.test(arm.slice(open + 2, close))) return true;
      at = close + 2;
    }
  };
  let out = '', cursor = 0;
  for (const match of masked.matchAll(conditional)) {
    const start = match.index ?? 0;
    const whole = match[0]!;
    const original = source.slice(start, start + whole.length);
    const trueStart = whole.indexOf(match[2]!);
    const falseStart = whole.lastIndexOf(match[3]!);
    const whenTrue = original.slice(trueStart, trueStart + match[2]!.length);
    const whenFalse = original.slice(falseStart, falseStart + match[3]!.length);
    out += source.slice(cursor, start);
    // Scan the masked arms, not the unmasked ones: a decoy delimiter sitting
    // inside an HTML comment is still literal `<%`/`%>` text in `original`
    // and must not count as a nested island there either.
    out += nested(match[2]!) || nested(match[3]!) ? original : match[1]!.toLowerCase() === 'true' ? whenTrue : whenFalse;
    cursor = start + whole.length;
  }
  return out + source.slice(cursor);
}

/** Context elementsFromZml needs to compile server-side snippets. */
export interface ZmlEnv {
  /** The app the page belongs to (form names, aggregates, criteria). */
  app: App;
  /** The page name, for endpoint paths. */
  page: string;
  /** Collects generated endpoint modules. */
  emit?: (file: HtmlpageFile) => void;
  /** Counter for unique snippet ids within a page. */
  seq?: { n: number };
  /** Generated views available to inline zc-component embeds. */
  components?: { forms: Set<string>; reports: Set<string> };
  /** The deploy-time schema plan; generated endpoint modules match its store constraints. */
  schema?: SchemaPlan;
}

export interface UiElement {
  tag: string;
  kind: 'container' | 'report' | 'chart' | 'form' | 'button' | 'text' | 'search' | 'gauge' | 'html' | 'todo' | 'kpi' | 'embed';
  name?: string;
  text?: string;
  /** Why a server-snippet TODO stays counted, in a fixed order. */
  manualReasons?: SnippetReason[];
  /** Stable source occurrence identifier for repeated click-action TODOs. */
  siteId?: string;
  /** Developer-facing manual step for that TODO, with its location. */
  manualStep?: string;
  /** A `type="form data"` cell: `thisapp.<Report>.<Field>.<fn>()` plus the row criteria. */
  kpi?: { report?: string; form?: string; field?: string; fn?: string; expression?: string };
  criteria?: string;
  /**
   * Link query text carried into the generated route: a click action's
   * `parameters`, or an embedded `<report>`'s `criteriaString` translated to
   * the same `Field=Value` grammar (a declared `page Name(a, …)` input rides
   * as `${name}` and is substituted from the page's own route when drawn).
   */
  parameters?: string;
  /** A button's `parameters` text the click action does not carry through; recorded as a manual step. */
  droppedParameters?: string;
  /** A search box's `criteriaString`/`criteria` text the generated element does not bind; recorded as a manual step. */
  droppedCriteria?: string;
  /** Allowlisted HTML. The runtime sanitizes again before inserting it. */
  html?: string;
  /** Active or non-rendering snippet elements removed by the sanitizer. */
  droppedTags?: string[];
  /** Static CSS rules in `<style>` elements the sanitizer dropped from `html`; the page counts them as one TODO. */
  droppedStyleRules?: number;
  /** Source text of the malformed inline style declarations the sanitizer labels `?`, in document order; the page names them in its manual step. */
  refusedStyles?: string[];
  staticCss?: string;
  /** Endpoint the runtime POSTs to for a server-rendered snippet (`data-snippet-src`). */
  src?: string;
  href?: string;
  todo?: string;
  /** Column or panel width copied from the export, such as `24%`. */
  width?: string;
  /** Decorative icon name. The image is not a missing component. */
  icon?: string;
  /** A value the browser cannot compute. The expression source is not the visible text. */
  unresolved?: boolean;
  /** Presentation attributes the export wrote on the element, as CSS declarations. */
  style?: Record<string, string>;
  /** `openUrl(..., "popup window")` actions a snippet would have run server-side. */
  popups?: UiPopup[];
  /** Pages of this app the snippet embedded by `page-embed` iframe, drawn inline at their markers. */
  includes?: string[];
  /** Generated forms/reports embedded by a zc-component marker. */
  components?: { kind: 'form' | 'report'; name: string }[];
  /** A ZML `<embed>` element with a static http(s) URL, drawn as an iframe. */
  embed?: { url: string; width?: string; height?: string };
  children: UiElement[];
}

/**
 * Static CSS carried into a page, scoped to the page root. `dropped` names
 * each refused construct (an at-rule, a declaration's property, a selector or
 * unparsed text) once per occurrence; `droppedRules` is its length.
 */
export interface ScopedStyle {
  css: string;
  droppedRules: number;
  dropped: string[];
  /** For each dropped entry, the rule it came from: its selector, at-rule, or Deluge tag ('' when none). */
  where?: string[];
}

/** A Creator `openUrl("#Form:X","popup window")` action lifted from a snippet. */
export interface UiPopup {
  target: 'form' | 'report';
  /** The link name, e.g. `Add_Firm`. */
  name: string;
  /** `empty` = the snippet opened it only when a form had no rows. */
  when: 'always' | 'empty';
  /** The form the `count() == 0` guard queried. */
  whenForm?: string;
}

const CONTAINERS = new Set([
  'zml',
  'layout',
  'row',
  'column',
  'panel',
  'pr',
  'pc',
  'card',
  'section',
  'page',
  'dashboard',
  'container',
  'div',
  'span',
  'template',
  'table',
  'tr',
  'td',
  'th',
  'cell',
  'p',
  'h',
  'v',
]);

const NAMED: Record<string, UiElement['kind']> = {
  report: 'report',
  chart: 'chart',
  pivotchart: 'chart',
  form: 'form',
  button: 'button',
  text: 'text',
  label: 'text',
  title: 'text',
  search: 'search',
  gauge: 'gauge',
  html: 'html',
  snippet: 'html',
  dsp: 'html',
  dspzml: 'html',
  htmlsnippet: 'html',
};

export const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'button', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr',
]);

/** Dropped with their descendants. Unwrapping these would surface script or style text. */
export const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'noscript',
  'noembed', 'template', 'svg', 'math', 'title', 'head', 'html', 'body',
]);

export const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  // A generated ExecuteFunction button carries its call route, encoded
  // arguments, and success message; the runtime wires the click.
  button: new Set(['type', 'data-fn-call', 'data-fn-args', 'data-fn-argc', 'data-fn-msg', 'data-fn-refresh']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  font: new Set(['color', 'face', 'size']),
  td: new Set(['colspan', 'rowspan', 'title']),
  th: new Set(['colspan', 'rowspan', 'title']),
  ol: new Set(['start', 'title']),
  '*': new Set(['class', 'title', 'data-style-dropped', 'data-zml']),
};

interface DomAttr {
  name: string;
  value: string;
}

interface DomNode {
  nodeType: number;
  tagName?: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  attributes?: ArrayLike<DomAttr>;
  innerHTML: string;
  content?: { appendChild(node: DomNode): void };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(node: DomNode): void;
}

interface DomDocument {
  documentElement: DomNode;
  body: DomNode;
  createElement(tag: string): DomNode;
  createTextNode(text: string): DomNode;
  createDocumentFragment(): DomNode;
}

interface DomWindow {
  DOMParser: new () => { parseFromString(html: string, type: string): DomDocument };
  document: DomDocument;
}

let cachedWindow: DomWindow | undefined;

/**
 * No DOM implementation is reachable for HTML sanitising. Named so callers
 * (and the CLI's top-level handler) can tell a missing optional runtime from
 * a sanitizer bug; the vendored plugin ships jsdom, so this should only fire
 * on an incomplete install.
 */
export class DomUnavailableError extends Error {
  constructor(cause: unknown) {
    super('a DOM is required to sanitize notes/print-template HTML but jsdom could not be loaded; reinstall the plugin or run npm ci');
    this.name = 'DomUnavailableError';
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

function domWindow(): DomWindow {
  const g = globalThis as unknown as { document?: DomDocument; DOMParser?: DomWindow['DOMParser'] };
  if (g.document && g.DOMParser) return { document: g.document, DOMParser: g.DOMParser };
  if (!cachedWindow) {
    let loaded: { JSDOM: new (html?: string) => { window: DomWindow } };
    try {
      loaded = require('jsdom') as typeof loaded;
    } catch (error) {
      throw new DomUnavailableError(error);
    }
    cachedWindow = new loaded.JSDOM('<!doctype html><html><body></body></html>').window;
  }
  return cachedWindow;
}

function listOf<T>(items: ArrayLike<T> | undefined): T[] {
  if (!items) return [];
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) out.push(items[i]);
  return out;
}

function flatCss(value: string): string {
  return String(value ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
}

/** CSS functions an inline style value may call: colour notations and numeric transforms and filters. None can fetch. */
const STYLE_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'hue-rotate', 'scale', 'scalex', 'scaley',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scalez', 'scale3d', 'skew', 'skewx', 'skewy',
  'matrix', 'matrix3d', 'perspective', 'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'invert', 'opacity', 'saturate', 'sepia',
  'linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient',
]);

/** Arguments of an allowed function: numbers with an optional unit, separated by spaces, commas or `/`. */
const STYLE_ARGS = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?(?:(?:\s*[,/]\s*|\s+)[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?)*\s*$/i;
const STYLE_PAINT_ARGS = /^[\s,a-zA-Z0-9#.%+\-]+$/;
const STYLE_PAINT_FUNCTIONS = new Set(['drop-shadow', 'linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient']);

/** Longest style attribute or declaration value the sanitizer scans; longer values are refused. */
const STYLE_TEXT_MAX = 8192;

/** Longest calc() argument list the sanitizer parses; longer values are refused. */
const CALC_ARGS_MAX = 200;

/** ASCII letter test for CSS units and function names (the regex [a-z] with the i flag). */
function asciiLetter(ch: string): boolean {
  const c = ch.charCodeAt(0) | 32;
  return c >= 97 && c <= 122;
}

/**
 * One pass over a calc() argument list, the same decisions as the old
 * CALC_ARGS regex without the backtracking: a number is an optional sign,
 * digits with an optional fraction (or a bare fraction like .5), then an
 * optional unit (% or up to four letters); + - * / operators separate the
 * numbers and spaces may sit around them.
 */
export function calcArgsSafe(args: string): boolean {
  const text = String(args ?? '');
  const n = text.length;
  if (n === 0 || n > CALC_ARGS_MAX) return false;
  let i = 0;
  const spaces = (): void => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  const number = (): boolean => {
    if (text[i] === '+' || text[i] === '-') i++;
    let whole = 0;
    while (i < n && text[i] >= '0' && text[i] <= '9') {
      i++;
      whole++;
    }
    let frac = 0;
    if (text[i] === '.') {
      i++;
      while (i < n && text[i] >= '0' && text[i] <= '9') {
        i++;
        frac++;
      }
    }
    return whole > 0 || frac > 0;
  };
  const unit = (): boolean => {
    if (text[i] === '%') {
      i++;
      return true;
    }
    let letters = 0;
    while (i < n && asciiLetter(text[i])) {
      i++;
      letters++;
    }
    return letters <= 4;
  };
  spaces();
  if (!number() || !unit()) return false;
  for (;;) {
    spaces();
    if (i >= n) return true;
    const op = text[i];
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return false;
    i++;
    spaces();
    if (!number() || !unit()) return false;
  }
}

/**
 * Remove css comments in one pass — the same spans the old
 * /\/\*[\s\S]*?\*\//g replace dropped, pairing each opener with the next
 * closer. An unterminated opener is literal text, like the regex left it.
 */
export function stripStyleComments(value: string): string {
  const text = String(value ?? '');
  let out = '';
  let i = 0;
  for (;;) {
    const start = text.indexOf('/*', i);
    if (start < 0) return out + text.slice(i);
    const end = text.indexOf('*/', start + 2);
    if (end < 0) return out + text.slice(i);
    out += text.slice(i, start);
    i = end + 2;
  }
}

/**
 * Rewrite each name(args) call left to right — the same matches as the old
 * /([-a-z0-9]*)\(([^()]*)\)/gi replace, without the regex: a call's name is
 * the run of [-a-z0-9] characters ending at its '(' and its arguments are
 * everything up to the next ')' with no '(' inside. Text that is not a call,
 * or whose call never closes, is kept as is.
 */
export function replaceStyleCalls(text: string, decide: (name: string, args: string) => string): string {
  const nameChar = (ch: string): boolean => ch === '-' || (ch >= '0' && ch <= '9') || asciiLetter(ch);
  let out = '';
  let i = 0;
  const n = text.length;
  let from = 0;
  while (from < n) {
    const open = text.indexOf('(', from);
    if (open < 0) break;
    let nameStart = open;
    while (nameStart > i && nameChar(text[nameStart - 1])) nameStart--;
    let close = open + 1;
    while (close < n && text[close] !== '(' && text[close] !== ')') close++;
    if (close >= n || text[close] === '(') {
      from = open + 1;
      continue;
    }
    out += text.slice(i, nameStart) + decide(text.slice(nameStart, open), text.slice(open + 1, close));
    i = close + 1;
    from = i;
  }
  return out + text.slice(i);
}

/**
 * Split an inline style into the declarations kept and the ones refused.
 * Each declaration is checked on its own: the property must be a plain CSS
 * name (never behavior or -moz-binding) and the value a safe style value, so
 * a refused declaration never takes the safe ones beside it. A trailing token
 * with no colon and no assignment, quote, escape, or call is not a declaration
 * and is left out. The browser runtime keeps an identical copy.
 */
export function cleanStyle(value: string): { style: string; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  let rewrote = false;
  const source = String(value ?? '');
  if (source.length > STYLE_TEXT_MAX) return { style: '', dropped: ['?'] };
  const hasComment = source.includes('/*');
  const stripped = hasComment ? stripStyleComments(source) : source;
  const rawPieces = stripped.split(';').map((piece) => piece.trim()).filter(Boolean);
  for (const text of rawPieces) {
    const colon = text.indexOf(':');
    if (colon < 0) {
      if (/[=@\\'"()]/.test(text)) dropped.push('?');
      continue;
    }
    const prop = flatCss(text.slice(0, colon));
    const body = text.slice(colon + 1).replace(/!\s*important\s*$/i, '');
    const flat = flatCss(body);
    const safe =
      /^-?[-a-z]+$/.test(prop) &&
      prop !== 'behavior' &&
      prop !== '-moz-binding' &&
      !flat.includes('javascript:') &&
      !flat.includes('vbscript:') &&
      safeStyleValue(body, prop);
    if (safe) kept.push(text);
    else if ((prop === 'filter' || prop === '-ms-filter') && ieGradientDeclaration(text.slice(colon + 1), prop)) { kept.push(`${prop}:${ieGradientDeclaration(text.slice(colon + 1), prop)!}`); rewrote = true; }
    else dropped.push(/^-?[-a-z]+$/.test(prop) ? prop : '?');
  }
  const hasDebris = rawPieces.length !== kept.length + dropped.length;
  return { style: dropped.length || rewrote ? kept.join('; ') : hasComment || hasDebris ? kept.join('; ') : source, dropped };
}

function ieGradientDeclaration(raw: string, prop: string): string | undefined {
  const body = raw.trim().replace(/!\s*important\s*$/i, '');
  const match = /^(?:progid:DXImageTransform\.Microsoft\.)?gradient\(([\s\S]*)\)$/i.exec(body);
  const normalized = match && ieGradientFilterSafe(match[1]!);
  return normalized ? normalized + (/!\s*important\s*$/i.test(raw) ? ' !important' : '') : undefined;
}

/**
 * A `@media` prelude is carried only when it is plain query text: no url(),
 * no expression(), and balanced parentheses over an allowed character set.
 */
function mediaConditionSafe(condition: string): boolean {
  const lower = condition.toLowerCase();
  if (!condition || lower.includes('url') || lower.includes('expression')) return false;
  let depth = 0;
  for (const ch of condition) {
    if (/[a-zA-Z0-9\s():.,%/-]/.test(ch)) {
      if (ch === '(') depth++;
      else if (ch === ')' && --depth < 0) return false;
    } else return false;
  }
  return depth === 0;
}

/**
 * Comma-split a selector list (depth- and quote-aware) and check every part
 * the way a page-scoped rule needs: no leading combinator, which would hang
 * off the scope itself and reach the page's siblings, and no markup, at-rule,
 * or fetch syntax. Returns the selectors, or the drop label to report.
 */
function sheetSelectors(head: string): { sels: string[] } | { label: string } {
  const sels: string[] = [];
  let start = 0, depth = 0, quote = '', okay = true;
  for (let n = 0; n <= head.length; n++) {
    const ch = head[n] ?? ',';
    if (quote) { if (ch === '\\') n++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') { depth--; if (depth < 0) okay = false; }
    else if (ch === ',' && depth === 0) { sels.push(head.slice(start, n).trim()); start = n + 1; }
  }
  if (sels.some((s) => s[0] === '~' || s[0] === '+' || s[0] === '>')) return { label: 'leading combinator selector' };
  const safeSelector = (s: string) => !!s && !/[{};@\\<]/.test(s) && !/url\s*\(|expression\s*\(/i.test(s);
  if (!okay || depth !== 0 || quote || !sels.every(safeSelector)) return { label: 'selector' };
  return { sels };
}

/**
 * `<!--`/`-->` tokens at the top level of a declaration list, blanked.
 * Browsers ignore CDO/CDC there (and between rules): real page sheets wrap
 * their CSS in HTML comments. Inside a quoted string or parentheses they are
 * value text and stay.
 */
function blankCdoCdc(body: string): string {
  if (!body.includes('<!') && !body.includes('-->')) return body;
  let out = '', quote = '', depth = 0;
  for (let n = 0; n < body.length; n++) {
    const ch = body[n]!;
    if (quote) { out += ch; if (ch === '\\' && n + 1 < body.length) out += body[++n]!; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '(') depth++; else if (ch === ')' && depth > 0) depth--;
    if (depth === 0 && body.startsWith('<!--', n)) { out += '    '; n += 3; continue; }
    if (depth === 0 && body.startsWith('-->', n)) { out += '   '; n += 2; continue; }
    out += ch;
  }
  return out;
}

/**
 * Stands in for a masked `<% … %>` island in sheet text. carriedStyleRules
 * counts each island once as CSS built by a Deluge tag, so the declaration or
 * rule holding the stand-in is left out without being counted a second time.
 */
const TEMPLATE_MARK = '\uE000';

/** A rule's selector or prelude as a manual step names it: whitespace collapsed, long text shortened. */
function ruleHead(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

/** Scan static CSS without regex parsing/backtracking. Unsupported constructs fail closed. */
export function carryStaticStyle(css: string, scope: string, inMedia = false, keyframes?: Set<string>): ScopedStyle {
  const rules: string[] = [];
  const dropped: string[] = [];
  const where: string[] = [];
  let at = '';
  const drop = (what: string) => { dropped.push(what); where.push(at); };
  let uncommented = '';
  let quote = '', comment = '', lineWhitespace = true, parens = 0, braces = 0;
  for (let n = 0; n < css.length; n++) {
    const ch = css[n]!;
    if (comment === 'block') { if (ch === '*' && css[n + 1] === '/') { comment = ''; n++; uncommented += ' '; } continue; }
    if (comment === 'line') { if (ch === '\n' || ch === '\r') { comment = ''; uncommented += ch; lineWhitespace = true; } continue; }
    if (quote) { uncommented += ch; if (ch === '\\' && n + 1 < css.length) uncommented += css[++n]!; else if (ch === quote) quote = ''; if (ch === '\n' || ch === '\r') lineWhitespace = true; else if (!/\s/.test(ch)) lineWhitespace = false; continue; }
    // A `//` line comment is honored only between rules: inside a body the
    // declaration scanner owns it, so it cannot hide a closing brace here.
    if (braces === 0 && parens === 0 && ch === '/' && css[n + 1] === '/') { comment = 'line'; n++; continue; }
    if (ch === '/' && css[n + 1] === '*') { comment = 'block'; n++; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    if (ch === '(') parens++; else if (ch === ')' && parens > 0) parens--;
    if (ch === '{') braces++; else if (ch === '}' && braces > 0) braces--;
    uncommented += ch;
    if (ch === '\n' || ch === '\r') lineWhitespace = true;
    else if (!/\s/.test(ch)) lineWhitespace = false;
  }
  // An unterminated /* hides the rest of the sheet; count it rather than lose it silently.
  if (comment === 'block') drop('unterminated comment');
  css = uncommented;
  const names = keyframes ?? keyframeNames(css);
  const prefix = keyframePrefix(scope);
  let i = 0;
  // Between rules a browser ignores CDO/CDC (`<!--`, `-->`) like whitespace;
  // sheets that wrap their CSS in HTML comments still carry. Inside a head
  // or a body the tokens stay and fail closed as before.
  const skip = () => {
    for (;;) {
      while (i < css.length && (css[i]!.trim() === '' || css[i] === ';' || css[i] === TEMPLATE_MARK)) i++;
      if (css.startsWith('<!--', i)) { i += 4; continue; }
      if (css.startsWith('-->', i)) { i += 3; continue; }
      return;
    }
  };
  // Safe declarations are kept; each refused one is named by its property.
  const declarations = (rawBody: string, check: (part: string, colon: number) => string | undefined = cleanSheetDeclaration): string[] | null => {
    const body = blankCdoCdc(rawBody);
    const out: string[] = []; let start = 0, depth = 0, quote = '', comment = false, lineComment = false;
    const emit = (text: string): void => {
      const part = text.trim();
      if (!part || part.includes(TEMPLATE_MARK)) return;
      const colon = part.indexOf(':');
      // A token run with no colon and no assignment, quote, escape, call or
      // markup is not a declaration at all: a browser skips it, the way the
      // inline-style sanitizer skips it, rather than counting a loss.
      if (colon <= 0) { if (/[=@\\'"()<>]/.test(part)) drop('unparsed declaration'); return; }
      const cleaned = check(part, colon);
      if (!cleaned) { drop(declarationLabel(part.slice(0, colon))); return; }
      out.push(names.size && /^\s*(?:-[a-z]+-)?animation(?:-name)?\s*:/i.test(cleaned) ? renameAnimations(cleaned, names, prefix) : cleaned);
    };
    for (let n = 0; n <= body.length; n++) {
      const ch = body[n] ?? ';';
      if (comment) { if (ch === '*' && body[n + 1] === '/') { comment = false; n++; } continue; }
      if (lineComment) { if (ch === '\n' || ch === '\r') { lineComment = false; start = n + 1; } continue; }
      if (quote) { if (ch === '\\') n++; else if (ch === quote) quote = ''; continue; }
      if (ch === '/' && body[n + 1] === '*') { comment = true; n++; continue; }
      // A `//` line comment ends the declaration it follows, like the `;` it
      // stands in for; the text before the slashes is not comment text.
      if (depth === 0 && ch === '/' && body[n + 1] === '/') { emit(body.slice(start, n)); lineComment = true; n++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '{' || ch === '}') return null;
      if (ch === '(') depth++; else if (ch === ')') depth--;
      else if (ch === ';' && depth === 0) { emit(body.slice(start, n)); start = n + 1; }
    }
    if (depth !== 0 || quote || comment) return null;
    return out;
  };
  while (i < css.length) {
    skip(); if (i >= css.length) break;
    const start = i; let quote = '', comment = false, parens = 0;
    for (; i < css.length; i++) {
      const ch = css[i]!;
      if (comment) { if (ch === '*' && css[i + 1] === '/') { comment = false; i++; } continue; }
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '/' && css[i + 1] === '*') { comment = true; i++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') parens++; else if (ch === ')') parens--;
      else if (ch === '{' && parens === 0) break;
      else if (ch === ';' && parens === 0 && css.slice(start, i).trim().startsWith('@')) break;
      else if (ch === '}' && parens === 0) break;
    }
    if (i >= css.length) { at = ruleHead(css.slice(start)); drop(atRuleLabel(css.slice(start)) ?? 'unparsed CSS'); break; }
    if (css[i] !== '{') {
      // A stray close brace carries no rules or declarations; like a browser,
      // skip it and keep scanning rather than count a loss.
      if (css[i] === '}') { i++; continue; }
      const statementEnd = css.indexOf(';', i);
      if (css.slice(start, i).trim().startsWith('@') && statementEnd >= 0) { at = ruleHead(css.slice(start, statementEnd)); drop(atRuleLabel(css.slice(start, i))!); i = statementEnd + 1; continue; }
      drop('unparsed CSS'); break;
    }
    let head = css.slice(start, i).trim();
    at = ruleHead(head);
    let depth = 1, end = i + 1; quote = ''; comment = false;
    for (; end < css.length && depth; end++) {
      const ch = css[end]!;
      if (comment) { if (ch === '*' && css[end + 1] === '/') { comment = false; end++; } continue; }
      if (quote) { if (ch === '\\') end++; else if (ch === quote) quote = ''; continue; }
      if (ch === '/' && css[end + 1] === '*') { comment = true; end++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '{') depth++; else if (ch === '}') depth--;
    }
    if (depth) { drop('unparsed CSS'); break; }
    const body = css.slice(i + 1, end - 1); i = end;
    // A selector or at-rule prelude a Deluge tag builds is already counted with the tag.
    if (head.includes(TEMPLATE_MARK)) continue;
    if (head.startsWith('@media') && (head.length === 6 || head[6] === '(' || /\s/.test(head[6]!))) {
      const condition = head.slice(6).trim();
      // A Creator sheet sometimes writes `@media (cond) .sel { decls }` with
      // no braces around the media body: one rule under the media, not a media
      // block. When the text after the last ')' is a selector list, wrap the
      // declarations in one. A body that is not declarations keeps the old
      // media-block path, which recurses and carries or scores what is inside.
      const lastClose = head.lastIndexOf(')');
      const mediaSelector = lastClose >= 0 ? head.slice(lastClose + 1).trim() : '';
      const mediaCondition = lastClose >= 0 ? head.slice(6, lastClose + 1).trim() : '';
      if (!inMedia && mediaSelector && mediaConditionSafe(mediaCondition)) {
        const found = sheetSelectors(mediaSelector);
        if ('label' in found) { drop(found.label); continue; }
        const before = dropped.length;
        const decl = declarations(body);
        if (decl) {
          if (decl.length || dropped.length === before) {
            rules.push(`@media ${mediaCondition}{${found.sels.map((s) => `${scope} ${s}`).join(',')}{${decl.join(';')}}}`);
          }
          continue;
        }
      }
      if (!mediaConditionSafe(condition) || inMedia) { drop(inMedia ? 'nested @media' : '@media condition'); continue; }
      const nested = carryStaticStyle(body, scope, true, names);
      dropped.push(...nested.dropped);
      where.push(...(nested.where ?? []).map((w) => ruleHead(`${head} ${w}`)));
      if (nested.css) rules.push(`@media ${condition}{${nested.css}}`);
      continue;
    }
    if (head.startsWith('@supports') && (head.length === 9 || /\s/.test(head[9]!))) {
      const condition = head.slice(9).trim();
      // Feature queries do not fetch or execute code, but the condition text
      // still reaches the generated stylesheet verbatim. Reuse the same
      // allowed-character check the @media path uses rather than a separate
      // blocklist: mediaConditionSafe accepts only a fixed safe character set
      // (no backslash), so it refuses CSS escape sequences that decode to
      // url(/expression(/a brace at render time, not just their literal text.
      if (!mediaConditionSafe(condition) || inMedia) { drop(inMedia ? 'nested @supports' : '@supports condition'); continue; }
      const nested = carryStaticStyle(body, scope, true, names);
      dropped.push(...nested.dropped);
      where.push(...(nested.where ?? []).map((w) => ruleHead(`${head} ${w}`)));
      if (nested.css) rules.push(`@supports ${condition}{${nested.css}}`);
      continue;
    }
    const frames = !inMedia && /^@(?:-webkit-|-moz-|-o-)?keyframes\s+[A-Za-z_][-\w]{0,60}$/i.test(head) ? keyframesRule(head, body, prefix, declarations) : undefined;
    if (frames) { rules.push(frames); continue; }
    // A font face whose descriptors all check out carries unscoped, like a
    // keyframes rule: local(), same-origin url() and data:font sources cannot
    // fetch a remote resource. A block with any refused descriptor is left
    // out whole — a face without its src is useless, and a remote font fetch
    // stays refused either way.
    if (/^@font-face$/i.test(head)) {
      const before = dropped.length;
      const decl = declarations(body, fontFaceDeclaration);
      if (!decl) { drop('unparsed declaration'); continue; }
      if (decl.length && dropped.length === before) rules.push(`@font-face{${decl.join(';')}}`);
      continue;
    }
    if (head.startsWith('@')) { drop(atRuleLabel(head)!); continue; }
    if (head.includes(';')) {
      let lastSemi = -1, q = '', d = 0;
      for (let n = 0; n < head.length; n++) {
        const ch = head[n]!;
        if (q) { if (ch === '\\') n++; else if (ch === q) q = ''; }
        else if (ch === '"' || ch === "'") q = ch;
        else if (ch === '(' || ch === '[') d++;
        else if (ch === ')' || ch === ']') { if (d > 0) d--; }
        else if (ch === ';' && d === 0) lastSemi = n;
      }
      if (lastSemi >= 0) { head = head.slice(lastSemi + 1).trim(); at = ruleHead(head); }
    }
    const sels: string[] = [];
    let selectorStart = 0, selectorDepth = 0, selectorQuote = '', selectorSyntaxOkay = true;
    for (let n = 0; n <= head.length; n++) {
      const ch = head[n] ?? ',';
      if (selectorQuote) { if (ch === '\\') n++; else if (ch === selectorQuote) selectorQuote = ''; continue; }
      if (ch === '"' || ch === "'") selectorQuote = ch;
      else if (ch === '(' || ch === '[') selectorDepth++;
      else if (ch === ')' || ch === ']') { selectorDepth--; if (selectorDepth < 0) selectorSyntaxOkay = false; }
      else if (ch === ',' && selectorDepth === 0) { sels.push(head.slice(selectorStart, n).trim()); selectorStart = n + 1; }
    }
    // A selector opening with a combinator would hang off the scope itself ('[data-page] ~ *') and reach the page's siblings.
    if (sels.some((s) => s[0] === '~' || s[0] === '+' || s[0] === '>')) { drop('leading combinator selector'); continue; }
    const safeSelector = (s: string) => !!s && !/[{};@\\<]/.test(s) && !/url\s*\(|expression\s*\(/i.test(s);
    if (!selectorSyntaxOkay || selectorDepth !== 0 || selectorQuote || !sels.every(safeSelector)) { drop('selector'); continue; }
    const before = dropped.length;
    const decl = declarations(body);
    if (!decl) { drop('unparsed declaration'); continue; }
    // A rule keeps its safe declarations; one whose declarations were all refused is left out.
    if (decl.length || dropped.length === before) rules.push(`${sels.map((s) => `${scope} ${s}`).join(',')}{${decl.join(';')}}`);
  }
  return { css: rules.join('\n'), droppedRules: dropped.length, dropped, ...(where.length ? { where } : {}) };
}

/** Numeric-argument functions a page stylesheet may also call: 3D transforms, filters, `rect()` clips and easing curves. None can fetch. */
const SHEET_NUMERIC_FUNCTIONS = new Set([
  'translate3d', 'scale3d', 'rotate3d', 'matrix', 'matrix3d', 'perspective', 'brightness', 'contrast', 'grayscale',
  'invert', 'opacity', 'saturate', 'sepia', 'blur', 'rect', 'cubic-bezier', 'translatez', 'scalez',
]);

/** Gradient and easing functions whose arguments are keywords, numbers and `#hex` colours (nested colour calls resolve first). */
const SHEET_KEYWORD_FUNCTIONS = new Set([
  'linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'conic-gradient',
  '-webkit-linear-gradient', '-moz-linear-gradient', '-ms-linear-gradient', '-o-linear-gradient', '-webkit-radial-gradient',
  '-moz-radial-gradient', '-ms-radial-gradient', '-o-radial-gradient', '-webkit-gradient', 'from', 'to', 'color-stop',
  'steps', 'drop-shadow', 'image-set', '-webkit-image-set',
]);

/** A quoted CSS string with no raw markup, braces, semicolons or line breaks; a backslash only starts a hex escape. */
const SHEET_STRING = /"(?:[^"\\<>;{}\r\n\f]|\\[0-9a-fA-F])*"|'(?:[^'\\<>;{}\r\n\f]|\\[0-9a-fA-F])*'/g;

/**
 * One `startColorstr`/`endColorstr` argument of IE's gradient filter: a
 * `#hex` colour or an `rgb()`/`rgba()` call with numeric arguments, optionally
 * wrapped in a quote — `'`, `"`, or the `&apos;`/`&quot;` entity a `<style>`
 * raw-text element never decodes. The wrapper is stripped by shape only (its
 * two markers need not match), then the inner text may hold no quote,
 * backslash or angle bracket of its own.
 */
function ieGradientColor(raw: string): string | undefined {
  let text = raw.trim();
  const wrapped = /^(?:'([\s\S]*)'|"([\s\S]*)"|&apos;([\s\S]*)&apos;|&quot;([\s\S]*)&quot;)$/.exec(text);
  if (wrapped) text = (wrapped[1] ?? wrapped[2] ?? wrapped[3] ?? wrapped[4] ?? '').trim();
  if (!text || /['"\\<>]/.test(text)) return undefined;
  if (/^#[0-9a-fA-F]{3}$/.test(text) || /^#[0-9a-fA-F]{6}$/.test(text) || /^#[0-9a-fA-F]{8}$/.test(text)) return text.toLowerCase();
  const call = /^(?:rgb|rgba)\(([^()]*)\)$/i.exec(text);
  if (!call) return undefined;
  const nums = call[1]!.split(',').map((v) => v.trim());
  if ((nums.length !== 3 && nums.length !== 4) || nums.some((v, i) => !/^(?:\d+(?:\.\d+)?)$/.test(v) || (i < 3 ? Number(v) > 255 : Number(v) > 1))) return undefined;
  if (nums.length === 4 && /^rgb\(/i.test(text)) return undefined;
  return `${nums.length === 4 ? 'rgba' : 'rgb'}(${nums.join(',')})`;
}

/**
 * IE's `gradient()` filter paints a two-stop fallback background from plain
 * colour arguments and a boolean/0-1 flag — it never fetches and modern
 * browsers already ignore it, so a page carrying it loses nothing either way.
 * Only `startColorstr`, `endColorstr`, `GradientType` and `enabled` are
 * recognized; any other key, duplicate, or malformed argument list refuses
 * the whole filter the same as an unknown function would.
 */
function ieGradientFilterSafe(args: string): string | undefined {
  // Split on top-level commas only: a colour argument like
  // `rgba(240, 173, 78, 0.54)` has commas of its own that must stay inside
  // that one key=value pair rather than splitting it apart.
  const parts: string[] = [];
  let start = 0, depth = 0;
  for (let n = 0; n <= args.length; n++) {
    const ch = args[n] ?? ',';
    if (ch === '(') depth++;
    else if (ch === ')') { if (depth === 0) return undefined; depth--; }
    else if (ch === ',' && depth === 0) { parts.push(args.slice(start, n)); start = n + 1; }
  }
  if (depth !== 0 || !parts.length) return undefined;
  const values: Record<string, string> = {};
  for (const raw of parts) {
    const eq = raw.indexOf('=');
    const key = raw.slice(0, eq).trim().toLowerCase();
    if (eq < 0 || key in values) return undefined;
    const value = raw.slice(eq + 1).trim();
    if (key === 'gradienttype') { if (!/^[01]$/.test(value)) return undefined; values[key] = value; }
    else if (key === 'enabled') { if (!/^(?:true|false)$/i.test(value)) return undefined; values[key] = value.toLowerCase(); }
    else if (key === 'startcolorstr' || key === 'endcolorstr') { const color = ieGradientColor(value); if (!color) return undefined; values[key] = color; }
    else return undefined;
  }
  // IE also emits a standalone enabled switch.  It has no colour payload to
  // normalize, but is still safe when it is the sole recognized argument.
  if (Object.hasOwn(values, 'enabled') && Object.keys(values).length === 1) {
    return `progid:DXImageTransform.Microsoft.gradient(enabled=${values.enabled})`;
  }
  // Both colours are required; GradientType and enabled are optional and are
  // re-emitted only when present, in one fixed order.
  if (!values.startcolorstr || !values.endcolorstr) return undefined;
  const tail = [
    Object.hasOwn(values, 'gradienttype') ? `GradientType=${values.gradienttype}` : '',
    Object.hasOwn(values, 'enabled') ? `enabled=${values.enabled}` : '',
  ].filter(Boolean);
  return `progid:DXImageTransform.Microsoft.gradient(${['startColorstr=' + values.startcolorstr, 'endColorstr=' + values.endcolorstr, ...tail].join(',')})`;
}

/**
 * One declaration of a page `<style>` sheet: kept when the inline-style
 * sanitizer keeps it, or when its value passes the sheet-only checks
 * (gradients, 3D transforms, filters, easing curves, quoted `font` names, and
 * `content` strings or `attr()`). Remote and relative `url()`, `@` rules,
 * `expression`, `behavior` and `-moz-binding` stay refused.
 */
function cleanSheetDeclaration(part: string, colon: number): string | undefined {
  const cleaned = cleanStyle(part);
  if (!cleaned.dropped.length && cleaned.style) return cleaned.style;
  const prop = flatCss(part.slice(0, colon));
  // A `*prop`/`_prop` legacy hack names a property no modern browser applies,
  // so carrying it verbatim is inert; its value is checked like any other.
  const hack = /^[*_]([-a-z0-9]+)$/.exec(prop);
  const base = hack ? hack[1]! : prop;
  // Digits reach property names through legacy entries like
  // `scrollbar-3dlight-color`; a value still passes the same checks.
  if ((!hack && !/^-?[-a-z0-9]+$/.test(prop)) || base === 'behavior' || base === '-moz-binding') return undefined;
  const body = part.slice(colon + 1).replace(/!\s*important\s*$/i, '');
  // IE's alpha(opacity) filter predates the opacity property; N/100 is its
  // modern equivalent. Only that one argument is rewritten — other legacy
  // filters can fetch (AlphaImageLoader) or run script and stay refused.
  if (base === 'filter' || base === '-ms-filter') {
    const trimmedBody = body.trim();
    const alpha = /^(?:progid:DXImageTransform\.Microsoft\.)?alpha\s*\(\s*opacity\s*=\s*(\d{1,3})\s*\)$/i.exec(trimmedBody);
    if (alpha) return `opacity:${parseInt(alpha[1]!, 10) / 100}${/!\s*important\s*$/i.test(part.slice(colon + 1)) ? ' !important' : ''}`;
    const gradient = /^(?:progid:DXImageTransform\.Microsoft\.)?gradient\(([\s\S]*)\)$/i.exec(trimmedBody);
    const normalizedGradient = gradient && ieGradientFilterSafe(gradient[1]!);
    if (normalizedGradient) return `${prop}:${normalizedGradient}${/!\s*important\s*$/i.test(part.slice(colon + 1)) ? ' !important' : ''}`;
  }
  return safeSheetValue(body, base) ? part.trim() : undefined;
}

/** Descriptors a `@font-face` block may set: every property a font face uses. */
const FONT_FACE_PROPS = new Set([
  'font-family', 'font-style', 'font-weight', 'font-stretch', 'font-variant', 'font-feature-settings',
  'font-variation-settings', 'font-display', 'unicode-range', 'size-adjust', 'ascent-override',
  'descent-override', 'line-gap-override', 'src',
]);

/**
 * A `data:font/*;base64` URI fetches nothing, like a data:image one: the font
 * bytes are already in the sheet. Text-encoded and non-base64 forms stay out.
 */
const DATA_FONT_URL = /url\(\s*["']?data:font\/(?:woff2?|ttf|otf|sfnt)(?:;charset=[a-z0-9_-]+)?;base64,[a-z0-9+/=\s]+["']?\s*\)/gi;

/**
 * A font-face `src`: local() names, same-origin url() targets and data:font
 * URIs, each optionally followed by format()/tech() hints. Quotes are only
 * ever the argument of those calls — anywhere else they refuse the value.
 */
function fontSrcSafe(raw: string): boolean {
  let text = String(raw ?? '').trim();
  if (!text || text.length > STYLE_TEXT_MAX) return false;
  text = text.replace(DATA_FONT_URL, ' ');
  if (/[;\\@<>{}]/.test(text) || text.includes('/*')) return false;
  const flat = flatCss(text);
  if (flat.includes('expression') || flat.includes('javascript:') || flat.includes('vbscript:')) return false;
  for (let pass = 0; pass < 4 && text.includes('('); pass++) {
    const next = replaceStyleCalls(text, (name: string, args: string) => {
      const fn = name.toLowerCase();
      const inner = args.trim();
      const quoted = /^(['"])([\s\S]*)\1$/.exec(inner);
      const unquoted = quoted ? quoted[2]! : inner;
      if (fn === 'url' && safeUrl(unquoted, true)) return ' ';
      if ((fn === 'local' || fn === 'format' || fn === 'tech') && (quoted ? !/['"\\<>]/.test(unquoted) : /^[\w .-]+$/.test(inner))) return ' ';
      return ' ';
    });
    if (next === text || next.includes(' ')) return false;
    text = next;
  }
  return !/[()'"\\@{};<>]/.test(text);
}

/**
 * One `@font-face` descriptor: the property must be a known font-face
 * property, and its value the same checks a style rule applies — `src`
 * additionally takes local()/format()/tech() calls and data:font URIs.
 */
function fontFaceDeclaration(part: string, colon: number): string | undefined {
  const prop = flatCss(part.slice(0, colon));
  if (!FONT_FACE_PROPS.has(prop)) return undefined;
  const cleaned = cleanSheetDeclaration(part, colon);
  if (cleaned) return cleaned;
  const body = part.slice(colon + 1).replace(/!\s*important\s*$/i, '').trim();
  if (prop === 'src') return fontSrcSafe(body) ? part.trim() : undefined;
  // Other descriptors are keywords, numbers, U+XXXX ranges and quoted names
  // or feature tags; a lifted string leaves plain value text, so anything
  // left outside the safe character set is not a descriptor value.
  if (/[;@{}<>()\\]/.test(body) || body.includes('/*')) return undefined;
  return /^[\s,a-zA-Z0-9#.%+?\/-]*$/.test(body.replace(SHEET_STRING, 's')) ? part.trim() : undefined;
}

/**
 * A `url()` whose target is a `data:image/*;base64` URI fetches nothing — the
 * bytes are already in the sheet — so it cannot beacon or exfiltrate like a
 * remote `url()` can. Only the base64 form is allowed (quoted or unquoted):
 * the payload's alphabet carries no markup, quotes, or a `</style>` break-out,
 * and an SVG loaded this way renders as an image, where browsers disable
 * scripting. A text-encoded or non-image `data:` URI stays refused.
 */
const DATA_IMAGE_URL = /url\(\s*["']?data:image\/(?:png|gif|jpe?g|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[a-z0-9+/=\s]+["']?\s*\)/gi;
const DATA_IMAGE_ARG = /^\s*["']?data:image\/(?:png|gif|jpe?g|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[a-z0-9+/=\s]+["']?\s*$/i;

/**
 * A quoted `url('…')`/`url("…")` lifts out when what sits between the quotes
 * passes the same url policy as an unquoted target, so `background-image:
 * url('a.png')` carries like `url(a.png)`. The inner alphabet keeps out
 * quotes, whitespace and `<`/`>`/`{`/`}`: a quoted string can never hide a
 * `</style>` break-out, a second quote, or a scheme smuggled through
 * whitespace — and an unsafe inner target keeps the literal text, which the
 * character check then refuses on its quotes.
 */
const QUOTED_URL = /url\(\s*(["'])([^"'\s<>{}]*)\1\s*\)/gi;

function safeSheetValue(raw: string, prop: string): boolean {
  let text = String(raw ?? '').trim();
  if (!text || text.length > STYLE_TEXT_MAX) return false;
  if (prop === 'content') text = text.replace(SHEET_STRING, ' ').replace(/\battr\(\s*[a-zA-Z][-a-zA-Z0-9]{0,40}\s*\)/g, ' ');
  if (prop === 'font' || prop === 'font-family') text = text.replace(/"[A-Za-z0-9 _-]*"|'[A-Za-z0-9 _-]*'/g, 'x');
  // Lifted out first: the URI's ';base64,' would otherwise hit the character check.
  text = text.replace(DATA_IMAGE_URL, ' ');
  text = text.replace(QUOTED_URL, (match, _quote: string, inner: string) => (safeUrl(inner, true) ? ' ' : match));
  if (/[;\\@<>'"{}]/.test(text) || text.includes('/*')) return false;
  const flat = flatCss(text);
  if (flat.includes('expression') || flat.includes('javascript:') || flat.includes('vbscript:')) return false;
  // Nested calls (a colour inside a gradient) resolve innermost first, one level per pass.
  for (let pass = 0; pass < 4 && text.includes('('); pass++) {
    const next = replaceStyleCalls(text, (name: string, args: string) => {
      const fn = name.toLowerCase();
      if ((STYLE_FUNCTIONS.has(fn) || SHEET_NUMERIC_FUNCTIONS.has(fn)) && STYLE_ARGS.test(args)) return ' ';
      if (fn === 'calc' && calcArgsSafe(args)) return ' ';
      if (SHEET_KEYWORD_FUNCTIONS.has(fn) && /^[\s,a-zA-Z0-9#.%+-]*$/.test(args)) return ' ';
      if (fn === 'url' && (safeUrl(args.trim(), true) || DATA_IMAGE_ARG.test(args))) return ' ';
      // A var() only reads a custom property — and every custom property a
      // page sets passed these same checks — so it can never smuggle in a
      // remote fetch. Its fallback had any nested calls resolved first.
      if (fn === 'var' && /^\s*--[-\w]+\s*(?:,[^(){};@'"\\<>]*)?$/.test(args)) return ' ';
      return '\u0000';
    });
    if (next === text || next.includes('\u0000')) return false;
    text = next;
  }
  return !/[()]/.test(text);
}

/** Names declared by `@keyframes` rules (any vendor prefix) in comment-free CSS. */
function keyframeNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/@(?:-webkit-|-moz-|-o-)?keyframes\s+([A-Za-z_][-\w]{0,60})/gi)) names.add(match[1]);
  return names;
}

/** A per-page prefix for carried keyframe names, so a page never overrides app or other-page animations. */
function keyframePrefix(scope: string): string {
  const name = scope.replace(/[^a-zA-Z0-9_-]+/g, '-');
  // Trim edge dashes with an index walk: a regex /-+$/ backtracks quadratically on a long inner dash run.
  let start = 0, end = name.length;
  while (start < end && name[start] === '-') start++;
  while (end > start && name[end - 1] === '-') end--;
  return `c2c-${name.slice(start, end)}-`;
}

/** Point `animation` / `animation-name` at the renamed keyframes declared on this page. */
function renameAnimations(declaration: string, names: Set<string>, prefix: string): string {
  const colon = declaration.indexOf(':');
  const value = declaration.slice(colon + 1).replace(/[A-Za-z_][-\w]*/g, (word) => (names.has(word) ? prefix + word : word));
  return declaration.slice(0, colon + 1) + value;
}

/**
 * A `@keyframes` rule with its name page-prefixed. Every frame selector must
 * be `from`, `to` or a percentage list, and frames may not nest; otherwise the
 * whole rule is refused (undefined). Refused declarations inside a frame are
 * reported by `declarations`.
 */
function keyframesRule(head: string, body: string, prefix: string, declarations: (body: string) => string[] | null): string | undefined {
  const [, at, name] = /^@((?:-webkit-|-moz-|-o-)?keyframes)\s+(\S+)$/i.exec(head)!;
  // Names in the c2c-* namespace are reserved for the prefix we generate.
  if (/^c2c-/i.test(name)) return undefined;
  const frames: string[] = [];
  let i = 0;
  for (;;) {
    const open = body.indexOf('{', i);
    if (open < 0) { if (body.slice(i).trim()) return undefined; break; }
    const close = body.indexOf('}', open + 1);
    if (close < 0 || body.slice(open + 1, close).includes('{')) return undefined;
    const selector = body.slice(i, open).trim();
    if (!/^(?:from|to|\d{1,3}(?:\.\d{1,4})?%)(?:\s*,\s*(?:from|to|\d{1,3}(?:\.\d{1,4})?%)){0,20}$/i.test(selector)) return undefined;
    const decl = declarations(body.slice(open + 1, close));
    if (decl === null) return undefined;
    if (decl.length) frames.push(`${selector.toLowerCase()}{${decl.join(';')}}`);
    i = close + 1;
  }
  return `@${at.toLowerCase()} ${prefix}${name}{${frames.join('')}}`;
}

/** `@name` of an at-rule head, lower-cased; undefined when `text` is not an at-rule. */
function atRuleLabel(text: string): string | undefined {
  const match = /^\s*@(-?[a-zA-Z][-a-zA-Z]{0,40})/.exec(text);
  if (!match) return text.trim().startsWith('@') ? '@ rule' : undefined;
  return `@${match[1].toLowerCase()}`;
}

/** The property a refused declaration names, or a generic label for a malformed one. */
function declarationLabel(prop: string): string {
  const name = prop.trim().toLowerCase();
  return /^-?[-a-z0-9]{1,60}$/.test(name) ? `${name} declaration` : 'unparsed declaration';
}

/**
 * One inline-style or exported presentation value: keywords, numbers,
 * lengths, `#hex`, the allowed functions with numeric arguments, `calc()`
 * with numbers, units and + - * /, and in `font-family` quoted plain names.
 * Backslashes (CSS escapes like `u\72 l(`), comments, `@` rules, nested
 * `calc()`, and every other function (`url`, `image-set`, `attr`, `var`, …)
 * are refused.
 */
function safeStyleValue(raw: string, prop?: string): boolean {
  let text = String(raw ?? '').trim();
  if (!text || text.length > STYLE_TEXT_MAX || /[;\\@<>{}]/.test(text) || text.includes('/*')) return false;
  if (prop === 'font-family' || prop === 'font') text = text.replace(/"[A-Za-z0-9 _-]*"|'[A-Za-z0-9 _-]*'/g, 'x');
  if (/['"]/.test(text)) return false;
  const flat = flatCss(text);
  if (flat.includes('url(') || flat.includes('expression')) return false;
  const rest = replaceStyleCalls(text, (name: string, args: string) => {
    const fn = name.toLowerCase();
    if (STYLE_FUNCTIONS.has(fn) && (STYLE_ARGS.test(args) || (STYLE_PAINT_FUNCTIONS.has(fn) && STYLE_PAINT_ARGS.test(args)))) return ' ';
    if (fn === 'calc' && calcArgsSafe(args)) return ' ';
    return '(';
  });
  return !/[()]/.test(rest);
}

export function allowedAttr(tag: string, name: string): boolean {
  if (name.startsWith('on') || name === 'srcdoc') return false;
  if (name === 'style') return true;
  const specific = ALLOWED_ATTRS[tag];
  if (tag === 'button' && /^data-fn-arg-\d+$/.test(name)) return true;
  if (specific?.has(name)) return true;
  return ALLOWED_ATTRS['*'].has(name);
}

function cleanNode(node: DomNode, doc: DomDocument, dropped?: string[]): DomNode | null {
  if (node.nodeType === 3) return doc.createTextNode(node.textContent ?? '');
  if (node.nodeType !== 1) return null;
  const tag = (node.tagName || '').toLowerCase();
  if (DROPPED_TAGS.has(tag)) return null;
  const fragment = doc.createDocumentFragment();
  for (const child of listOf(node.childNodes)) {
    const next = cleanNode(child, doc, dropped);
    if (next) fragment.appendChild(next);
  }
  if (!ALLOWED_TAGS.has(tag)) return fragment;
  const out = doc.createElement(tag);
  for (const attr of listOf(node.attributes)) {
    const name = attr.name.toLowerCase();
    if (!allowedAttr(tag, name)) continue;
    if ((name === 'href' || name === 'src') && !safeUrl(attr.value)) continue;
    if (name === 'style') {
      const style = cleanStyle(attr.value);
      if (style.style || !style.dropped.length) out.setAttribute('style', style.style);
      if (style.dropped.length) {
        out.setAttribute('data-style-dropped', style.dropped.join(' '));
        dropped?.push(...style.dropped);
      }
      continue;
    }
    out.setAttribute(name, attr.value);
  }
  if (tag === 'a' && out.getAttribute('href')) out.setAttribute('rel', 'noopener noreferrer');
  out.appendChild(fragment);
  return out;
}

/** Embedding tags: the sanitizer removes them with whatever they showed (a video, a map, an external page). */
const EMBED_DROPPED_TAGS = new Set(['embed', 'frame', 'iframe', 'object']);

const REPORTED_DROPPED_TAGS = new Set(['script', 'style', 'svg', 'template', ...EMBED_DROPPED_TAGS]);

export function sanitizeSnippet(raw: string, dropped?: string[], droppedTags?: string[]): string {
  const win = domWindow();
  const parsed = new win.DOMParser().parseFromString(String(raw ?? ''), 'text/html');
  const sink = parsed.createElement('template');
  const content = sink.content;
  if (!content) return '';
  // Walk source nodes before cleanNode removes the blocked subtrees. Keep a
  // stable, unique report so repeated instances do not inflate page TODOs.
  if (droppedTags) {
    const visit = (node: DomNode) => {
      if (node.nodeType === 1) {
        const tag = (node.tagName || '').toLowerCase();
        if (REPORTED_DROPPED_TAGS.has(tag)) droppedTags.push(tag);
        for (const child of listOf(node.childNodes)) visit(child);
      }
    };
    if (parsed.documentElement) visit(parsed.documentElement);
  }
  for (const node of listOf(parsed.body.childNodes)) {
    const next = cleanNode(node, parsed, dropped);
    if (next) content.appendChild(next);
  }
  if (droppedTags) {
    const unique = [...new Set(droppedTags)].sort();
    droppedTags.splice(0, droppedTags.length, ...unique);
  }
  return sink.innerHTML;
}

/**
 * Property names of the style declarations refused inside `html`. Already
 * sanitized markup carries them in `data-style-dropped`; raw markup is run
 * through the sanitizer to find them.
 */
export function droppedStyles(html: string, sanitized = false): string[] {
  const dropped: string[] = [];
  if (!sanitized) {
    sanitizeSnippet(html, dropped);
    return dropped;
  }
  for (const match of html.matchAll(/data-style-dropped="([^"]*)"/g)) dropped.push(...match[1].split(' ').filter(Boolean));
  return dropped;
}

/**
 * Source text of each inline style declaration `cleanStyle` refuses as `?`
 * (not a `property: value` pair, such as `width=3%`), in document order, so a
 * manual step can name what was written instead of `?`.
 */
export function malformedStyleDeclarations(raw: string): string[] {
  const found: string[] = [];
  for (const match of String(raw ?? '').matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2] ?? '';
    const show = (text: string) => {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
    };
    if (value.length > STYLE_TEXT_MAX) {
      found.push(show(value));
      continue;
    }
    const pieces = (value.includes('/*') ? stripStyleComments(value) : value).split(';').map((piece) => piece.trim()).filter(Boolean);
    for (const piece of pieces) if (cleanStyle(piece).dropped.includes('?')) found.push(show(piece));
  }
  return found;
}

/**
 * Top-level rules in a stylesheet: each `{}` block (an `@media` block counts
 * once) and each `;`-terminated `@` statement such as `@import`. Leftover
 * text after the last rule counts as one more, so non-empty CSS is never zero.
 */
function cssRuleCount(css: string): number {
  const text = css.includes('/*') ? css.replace(/\/\*[\s\S]*?\*\//g, ' ') : css;
  let depth = 0;
  let count = 0;
  let pending = false;
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) count++;
      depth++;
      pending = false;
    } else if (ch === '}') {
      if (depth > 0) depth--;
    } else if (depth === 0 && ch === ';') {
      if (pending) count++;
      pending = false;
    } else if (depth === 0 && ch.trim()) {
      pending = true;
    }
  }
  return count + (pending ? 1 : 0);
}

/**
 * The constant CSS an app function returns, when the function takes no
 * arguments, is declared to return a string, and its whole body is one
 * `return "literal";`. `\"`, `\\`, `\n` and `\t` are decoded; any other
 * backslash pair (a CSS escape or hack such as `\9`) stays as written, for the
 * sheet sanitizer to judge. Anything else (parameters, logic, concatenation of
 * values, markup inside the text) is not constant CSS and yields undefined.
 */
function constantStyleFunction(app: App | undefined, name: string): string | undefined {
  const fn = app?.functions?.find((f) => f.kind === 'deluge' && f.name === name);
  if (!fn || fn.deluge.length !== 1) return undefined;
  const signature = (fn.signature ?? '').replace(/\s+/g, ' ').trim();
  if (signature !== `string ${name}()`) return undefined;
  const body = /^\s*return\s+"((?:[^"\\\r\n]|\\[^\r\n])*)"\s*;?\s*$/.exec(fn.deluge[0]!.text ?? '');
  if (!body) return undefined;
  // CSS comments carry nothing; dropping them first keeps a `<` in comment text (`IE < 9`) from refusing the sheet.
  const text = body[1]!.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\\([\s\S])/g, (m, ch: string) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === '"' || ch === '\\' ? ch : m));
  // A `<` (or an entity decoding to one) could end the <style> element; such text stays a dynamic island.
  if (/<|&(?:#|lt\b)/i.test(text)) return undefined;
  return text;
}

/**
 * Replace each `<%=thisapp.fn()%>` island (raw or XML-escaped) whose function returns constant CSS
 * (see constantStyleFunction) with that CSS, so the page's stylesheet carries
 * it through the same sanitizer as the CSS written inline. Other islands stay.
 */
export function inlineConstantStyleCalls(raw: string, app: App | undefined): string {
  if (!app || !/<%|&lt;%/.test(raw)) return raw;
  return raw.replace(/(?:<|&lt;)%=\s*thisapp\.([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)\s*\(\s*\)\s*;?\s*%(?:>|&gt;)/g, (island, name: string) => constantStyleFunction(app, name) ?? island);
}

/** Mask `<% … %>` template islands in one pass; an unclosed `<%` stays. */
function maskTemplateIslands(text: string, fill: string): string {
  if (!text.includes('<%')) return text;
  let out = '', i = 0;
  for (;;) {
    const open = text.indexOf('<%', i);
    if (open < 0) return out + text.slice(i);
    const close = text.indexOf('%>', open + 2);
    if (close < 0) return out + text.slice(i);
    out += text.slice(i, open) + fill;
    i = close + 2;
  }
}

/** The text of every `<style>` element in `raw`, as the sanitizer's parse sees it. */
function styleSheets(raw: string): string[] {
  if (!/<\s*style/i.test(String(raw ?? ''))) return [];
  const win = domWindow();
  const parsed = new win.DOMParser().parseFromString(String(raw ?? ''), 'text/html');
  const sheets: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType !== 1) return;
    if ((node.tagName || '').toLowerCase() === 'style') {
      sheets.push(node.textContent ?? '');
      return;
    }
    for (const child of listOf(node.childNodes)) walk(child);
  };
  walk(parsed.documentElement);
  return sheets;
}

/**
 * `raw` holds a `<style>` element the sanitizer removes. An element with no
 * CSS rules loses nothing, but its presence still suppresses the generic
 * dropped-tag TODO: the loss, when there is one, is counted by the page's
 * dropped-CSS TODO instead.
 */
export function hasStyleElement(raw: string): boolean {
  return styleSheets(raw).length > 0;
}

/**
 * Static CSS rules inside the `<style>` elements of `raw`. The sanitizer drops
 * every `<style>` element whole, so this is the CSS a page loses. Template
 * islands inside the stylesheet are masked before counting.
 */
export function droppedStyleRules(raw: string): number {
  let rules = 0;
  for (const sheet of styleSheets(raw)) rules += cssRuleCount(maskTemplateIslands(decodeXmlEntities(sheet), 'x'));
  return rules;
}

const DYNAMIC_CSS = 'CSS built by a Deluge tag';

export function carriedStyleRules(raw: string, scope: string): ScopedStyle {
  if (!/<\s*style/i.test(String(raw ?? ''))) return { css: '', droppedRules: 0, dropped: [] };
  const win = domWindow();
  const parsed = new win.DOMParser().parseFromString(String(raw ?? ''), 'text/html');
  const sheets: string[] = [];
  const templateCss: string[] = [];
  const templateWhere: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType !== 1) return;
    if ((node.tagName || '').toLowerCase() === 'style') {
      const decoded = decodeXmlEntities(node.textContent ?? '');
      sheets.push(maskTemplateIslands(decoded, TEMPLATE_MARK));
      // CSS a Deluge tag builds at request time has no static rule to carry: count each tag as lost.
      for (let at = decoded.indexOf('<%'); at >= 0; at = decoded.indexOf('<%', at + 2)) {
        const close = decoded.indexOf('%>', at + 2);
        templateCss.push(DYNAMIC_CSS);
        templateWhere.push(ruleHead(close < 0 ? decoded.slice(at) : decoded.slice(at, close + 2)));
      }
      return;
    }
    for (const child of listOf(node.childNodes)) walk(child);
  };
  walk(parsed.documentElement);
  // Keyframes declared in any of the page's <style> elements are renamed in all of them.
  const names = keyframeNames(sheets.join('\n'));
  const carried: string[] = []; const dropped: string[] = [...templateCss]; const where: string[] = [...templateWhere];
  for (const sheet of sheets) {
    const result = carryStaticStyle(sheet, scope, false, names);
    if (result.css) carried.push(result.css);
    dropped.push(...result.dropped);
    where.push(...(result.where ?? result.dropped.map(() => '')));
  }
  return { css: carried.join('\n'), droppedRules: dropped.length, dropped, ...(where.length ? { where } : {}) };
}

/**
 * Each dropped item next to the rule it came from, for the manual step:
 * `Dropped: .card (background declaration); <%=x%> (CSS built by a Deluge tag).`
 * Repeats are counted, and a long list names the first 25 and counts the rest.
 */
function droppedRulesList(dropped: string[], where: string[]): string {
  const counts = new Map<string, number>();
  dropped.forEach((label, n) => {
    const item = where[n] ? `${where[n]} (${label})` : label;
    counts.set(item, (counts.get(item) ?? 0) + 1);
  });
  if (!counts.size || !where.some(Boolean)) return '';
  // determinism-allow: dropped-rule source order; each location is listed in the order the sanitizer reported it
  const items = [...counts].map(([item, n]) => (n > 1 ? `${item} x${n}` : item));
  const shown = items.slice(0, 25);
  const more = items.length > shown.length ? `; and ${items.length - shown.length} more` : '';
  return `Dropped: ${shown.join('; ')}${more}. `;
}

/** The TODO reason and manual step for a page's dropped `<style>` CSS. */
export function droppedStyleRulesTodo(page: string, rules: number, dropped: string[] = [], where: string[] = []): { reason: string; step: string } {
  const counts = new Map<string, number>();
  for (const name of dropped) counts.set(name, (counts.get(name) ?? 0) + 1);
  const named = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
  const what = `${rules} static style rule${rules === 1 ? '' : 's'} or declaration${rules === 1 ? '' : 's'}${named.length ? ` (${named.join(', ')})` : ''}`;
  return {
    reason: `Static <style> CSS not carried over: the page sanitizer drops ${what}`,
    step: `page ${page}: The sanitizer carries the safe <style> rules, scoped to this page, and drops ${what}. ${droppedRulesList(dropped, where)}Restyle what was dropped in the app stylesheet, scoped to this page, or with supported components. Keep this TODO open until the restyled page is verified.`,
  };
}

export function droppedTagReason(tag: string): string {
  return `The <${tag}> element is removed from this page snippet by the sanitizer`;
}

/**
 * The manual step for a dropped `<script>`: the sanitizer never runs page
 * scripts, so the behaviour they carried has to be rebuilt by hand. Other
 * dropped tags keep their reason-only TODO.
 */
export function droppedTagStep(page: string, tag: string): string | undefined {
  if (EMBED_DROPPED_TAGS.has(tag))
    return `page ${page}: The page snippet embeds content with an <${tag}> element. The sanitizer removes it and what it showed is not on the page. Re-add it as a link to its address, or rebuild it as a client component with a fixed allowlisted source, then keep this TODO open until the page is verified.`;
  if (tag !== 'script') return undefined;
  return `page ${page}: The page snippet contains a <script> element. The sanitizer removes it and its code is not run or bundled. Rebuild what it did as a client component or a function the page calls, then keep this TODO open until the page is verified.`;
}

/** The TODO reason for refused inline style declarations. */
export function droppedStyleReason(dropped: string[]): string {
  return `Inline style declarations not carried over (unsafe or unsupported CSS): ${dropped.join(', ')}`;
}

/** The manual step for refused inline style declarations at `where` (for example `On page Home, the <htmlsnippet> element`). */
export function droppedStyleStep(where: string, dropped: string[]): string {
  // determinism-allow: declaration source order; dedup keeps the first refusal
  return `${where} lost the inline style declarations ${[...new Set(dropped)].join(', ')} to the sanitizer. Re-create that styling by hand with a class in the app stylesheet, using only safe CSS (no url(), expressions, or scripts), then check the layout.`;
}

function dedupeImageActions(actions: ZmlImageAction[]): ZmlImageAction[] {
  // Each markup occurrence is a separate wiring site, even when its action
  // and label match another occurrence exactly.
  return actions;
}

/** Link names a generated `#/form/<name>` or `#/report/<name>` route can carry. */
const ROUTE_LINK_NAME = /^[A-Za-z0-9_]+$/;

/** The app form whose link name is exactly `target`; any other target stays a manual step. */
function findMatchingForm(forms: Form[] | undefined, target: string | undefined): Form | undefined {
  if (!forms || !target || !ROUTE_LINK_NAME.test(target)) return undefined;
  return forms.find((f) => f.name === target);
}

/** The app report whose link name is exactly `target`; any other target stays a manual step. */
function findMatchingReport(reports: { name: string }[] | undefined, target: string | undefined): { name: string } | undefined {
  if (!reports || !target || !ROUTE_LINK_NAME.test(target)) return undefined;
  return reports.find((r) => r.name === target);
}

/**
 * A free-text `#` href survives only as a generated route to a form or report
 * the app has: `#/form/<name>` or `#/report/<name>` with an exact link name.
 */
function knownRouteHref(app: App | undefined, href: string | undefined): string | undefined {
  const m = /^#\/(form|report)\/([A-Za-z0-9_]+)$/.exec((href ?? '').trim());
  if (!m || !app) return undefined;
  const known = m[1] === 'form' ? app.forms.some((f) => f.name === m[2]) : app.reports.some((r) => r.name === m[2]);
  return known ? `#/${m[1]}/${m[2]}` : undefined;
}

/**
 * The report a `click action = 'OpenReport'` (or `Report`) element opens, as a
 * generated route, or undefined when the action names no report in this app.
 */
function reportClickHref(action: string, attributes: Record<string, string>, app?: App): string | undefined {
  if (!isReportAction(action, attributes)) return undefined;
  const target = reportActionTarget(action, attributes);
  const match = findMatchingReport(app?.reports, target);
  return match ? `#/report/${match.name}` : undefined;
}

/**
 * Creator's report-link `parameters` grammar: `Field=Value` conditions joined
 * by `&` or `&&`, a `Field_op=<n>` pair giving the operator for the field's
 * condition, and values that are literals or `${zoho.currentdate}`. The client
 * runtime parses the same text into report query filters; a parameters string
 * holding anything else (a Deluge `<%= %>` island, a `${other}` variable, an
 * unknown `_op` code, or a valueless comparison) cannot be wired, so the
 * caller keeps it a manual step.
 */
export function translatableClickParameters(parameters: string | undefined, pageParams?: ReadonlySet<string>): boolean {
  const text = (parameters ?? '').trim();
  if (!text) return false;
  const conditions = new Map<string, { value?: string; op?: string }>();
  const order: string[] = [];
  const valueOk = (value: string | undefined): boolean => {
    if (value === undefined) return false;
    const trimmed = value.trim();
    if (!trimmed || /[<&=\u0000-\u001f]/.test(trimmed)) return false;
    // A declared page input (`${name}` / `input.name`) substitutes when the
    // link is drawn, like the wider form-link grammar allows.
    const input = PAGE_INPUT_VALUE.exec(trimmed);
    if (input) return !!pageParams?.has(input[1] ?? input[2]!);
    if (/\$\{[^}]*\}/.test(trimmed)) return /^\$\{zoho\.currentdate\}$/i.test(trimmed);
    if (!trimmed.includes('%')) return true;
    try {
      decodeURIComponent(trimmed);
      return true;
    } catch {
      return false;
    }
  };
  for (const pair of text.split(/&+/).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return false;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    const opm = /^([A-Za-z_][A-Za-z0-9_]*)_op$/i.exec(name);
    if (opm) {
      if (!/^\d+$/.test(value.trim())) return false;
      const field = opm[1]!;
      if (!order.includes(field)) order.push(field);
      const cond = conditions.get(field) ?? {};
      cond.op = value.trim();
      conditions.set(field, cond);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
    if (!order.includes(name)) order.push(name);
    const cond = conditions.get(name) ?? {};
    if (!valueOk(value)) return false;
    cond.value = value;
    conditions.set(name, cond);
  }
  if (!order.length) return false;
  for (const field of order) {
    const cond = conditions.get(field)!;
    if (cond.op === undefined) {
      if (cond.value === undefined) return false;
      continue;
    }
    // An `_op` the client runtime's clickParamConditions cannot translate
    // drops the condition on the route, so the whole string stays manual.
    if (!/^(20|32|45|58)$/.test(cond.op)) return false;
    if ((cond.op === '20' || cond.op === '58') && cond.value === undefined) return false;
    if (cond.op === '58') {
      // BETWEEN applies only when the value splits into two bounds, and a
      // page input substitutes unknown text, so only a literal `v1;v2` wires.
      let bounds = cond.value!.trim();
      try {
        bounds = decodeURIComponent(bounds);
      } catch {
        return false;
      }
      const parts = bounds.split(';');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    }
  }
  return true;
}

/** A `${name}` or `input.name` value — the page's declared input, substituted when the link is drawn. */
const PAGE_INPUT_VALUE = /^(?:\$\{([A-Za-z_]\w*)\}|input\.([A-Za-z_]\w*))$/;

/** The declared `page Name(a, b)` input parameters of the page holding an element; the `( ?? [])` rule is the same one the page-link classifiers apply. */
function declaredPageParams(env?: ZmlEnv): ReadonlySet<string> | undefined {
  const page = env?.app?.pages.find((item) => item.name === env.page);
  return page?.params ? new Set(page.params) : undefined;
}

/**
 * Link `parameters` in the wider grammar the corpus writes on form targets:
 * `Field=Value` pairs whose value is a literal, `${zoho.currentdate}`, or a
 * declared page input written `${name}` / `input.name`. The client re-encodes
 * the pairs on the route — `#/form/` prefills the add screen, `#/report/`
 * ANDs the conditions into the read — substituting page inputs when it draws
 * the link. A pair outside this grammar (a Deluge island, an unwritten
 * `${…}` or `input.` name, an unsafe literal) is not wired, so the caller
 * keeps it a manual step. The text is XML-decoded first: the export writes
 * `&` as `&amp;` inside attribute values.
 */
export function translatableLinkParameters(parameters: string | undefined, pageParams?: ReadonlySet<string>): boolean {
  const text = decodeXmlEntities(parameters ?? '').trim();
  if (!text) return false;
  for (const pair of text.split(/&+/).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return false;
    const name = pair.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
    const value = pair.slice(eq + 1).trim();
    const input = PAGE_INPUT_VALUE.exec(value);
    if (input) {
      if (!pageParams?.has(input[1] ?? input[2]!)) return false;
      continue;
    }
    if (/^\$\{zoho\.currentdate\}$/i.test(value)) continue;
    if (!value || /[<&= -]/.test(value) || /\$\{[^}]*\}/.test(value)) return false;
    if (value.includes('%')) {
      try {
        decodeURIComponent(value);
      } catch {
        return false;
      }
    }
  }
  return true;
}

/**
 * One `Field == <value>` conjunct of an embedded `<report>`'s `criteriaString`
 * or `criteria`, as a link pair: `input.param` becomes the `${param}` page
 * input, `zoho.loginuser`/`zoho.loginuserid` the self-binding marker the
 * report endpoint resolves to the caller, and a quoted or numeric literal
 * stays literal. undefined for anything else (other operators, an undeclared
 * input, a literal that would shadow a substituted token).
 */
function embedCriterionPair(conjunct: string, pageParams?: ReadonlySet<string>): string | undefined {
  const m = /^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:==|=)\s*(?:(input)\.([A-Za-z_]\w*)|(zoho)\.(loginuserid|loginuser)|"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?))\s*$/i.exec(conjunct);
  if (!m) return undefined;
  const field = m[1]!;
  if (m[3]) {
    if (!pageParams?.has(m[3])) return undefined;
    return `${field}=\${${m[3]}}`;
  }
  if (m[5]) return `${field}=zoho.${m[5].toLowerCase()}`;
  const literal = m[6] ?? m[7] ?? m[8];
  // A literal equal to a substituted token (input./zoho./${…}) or a raw `&`
  // would change meaning once it rides the link grammar; keep it manual.
  if (!literal || /[<&= -]/.test(literal) || /\$\{/.test(literal) || /^(?:input|zoho)\.[A-Za-z_]\w*$/i.test(literal)) return undefined;
  return `${field}=${literal}`;
}

/**
 * An embedded `<report>`'s `criteriaString`/`criteria` as link parameters the
 * generated route carries: a flat `&&` conjunction of `Field == <value>`
 * conjuncts becomes `Field=value` pairs the report endpoint ANDs into the
 * read, the same filters a click `parameters` link carries. A `||`, a nested
 * expression, or a conjunct outside the pair grammar leaves it the manual
 * wiring step.
 */
export function embedCriteriaLinkParams(criteria: string | undefined, pageParams?: ReadonlySet<string>): string | undefined {
  const decoded = decodeXmlEntities(criteria ?? '').trim();
  if (!decoded || /\|\||\bor\b/i.test(decoded)) return undefined;
  const pairs = decoded.split('&&').map((part) => embedCriterionPair(part, pageParams));
  return pairs.length && pairs.every((pair) => pair !== undefined) ? pairs.join('&') : undefined;
}

function isWiredImageAction(a: ZmlImageAction, app?: App): boolean {
  const action = (a.action ?? '').replace(/\s+/g, '').toLowerCase();
  const fnName = (a.fn ?? '').toLowerCase();
  if ((action === 'function' || action === 'executefunction') && /^(vote\.(?:upvote|downvote))$/.test(fnName)) {
    return !app || app.functions.some((f) => f.name.toLowerCase() === fnName);
  }
  return false;
}

/**
 * One counted manual step per image or button click action the generated page drops.
 * Generated pages have no client path that calls a Creator function, so the
 * action is never rewired or relabelled here. Declarative Form and OpenReport
 * navigation actions whose target is a form or report in the app are emitted
 * as client routes and omitted here.
 */
function imageActionTodos(actions: ZmlImageAction[], why?: string, app?: App): UiElement[] {
  return actions
    .filter((a) => {
      if (a.form || isFormAction(a.action)) {
        const target = a.form ?? formActionTarget(a.action);
        if (target && findMatchingForm(app?.forms, target)) {
          return false;
        }
      }
      if (isWiredImageAction(a, app)) {
        return false;
      }
      if (a.report || isReportAction(a.action)) {
        const target = a.report ?? reportActionTarget(a.action);
        if (target && findMatchingReport(app?.reports, target)) {
          return false;
        }
      }
      return true;
    })
    .map((a) => {
      const element = a.element ?? 'image';
      const what = a.label ? `ZML <${element}> "${a.label}"` : `ZML <${element}>`;
      const call = a.fn ? ` calling function ${a.fn}` : '';
      const reason = why ? ` (the snippet stays manual: ${why})` : '';
      return {
        tag: element,
        kind: 'todo' as const,
        ...(a.fn ? { name: a.fn } : a.label ? { name: a.label } : {}),
        ...(a.siteId ? { siteId: a.siteId } : {}),
        todo: `${what} click action ${a.action}${call} is not generated; wire the click to the function by hand${reason}`,
        children: [],
      };
    });
}

function attr(attributes: Record<string, string>, keys: string[]): string | undefined {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  for (const [key, value] of Object.entries(attributes)) { // determinism-allow: ZML attribute insertion order is source order; the first wanted key wins, and sorting would change which duplicate wins
    if (want.has(key.toLowerCase()) && value.trim()) return value;
  }
  return undefined;
}

/** Export presentation attributes → CSS declarations. Values are sanitized. */
const STYLE_ATTRS: Record<string, string> = {
  color: 'color',
  bgcolor: 'background-color',
  padding: 'padding',
  size: 'font-size',
  cornerradius: 'border-radius',
  halign: 'text-align',
  height: 'height',
};

function styleOf(attributes: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) { // determinism-allow: attribute source order; a fixed property per attribute name
    const prop = STYLE_ATTRS[key.toLowerCase()];
    if (!prop) continue;
    const text = value.trim();
    if (text && /^[a-zA-Z0-9#().,%\-'" ]+$/.test(text) && safeStyleValue(text)) out[prop] = text;
  }
  const bold = attr(attributes, ['bold']);
  if (bold && bold.trim().toLowerCase() === 'true') out['font-weight'] = '700';
  return Object.keys(out).length ? out : undefined;
}

/**
 * Lift `openUrl("#Form:X","popup window")` calls out of a dropped Deluge
 * snippet. A preceding `if (rows.count() == 0)` guard — the Creator "no firm
 * yet" pattern — becomes `when: 'empty'` over the queried form.
 */
function popupActions(raw: string): UiPopup[] {
  if (!raw || !/popup/i.test(raw)) return [];
  const vars = new Map<string, string>();
  const decl = /([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\[[^\]]*\]\s*;/g;
  for (let m = decl.exec(raw); m; m = decl.exec(raw)) vars.set(m[1], m[2]);
  const guards: { index: number; form?: string }[] = [];
  const guard = /if\s*\(\s*([A-Za-z_]\w*)\s*\.\s*count\s*\(\s*\)\s*==\s*0\s*\)/g;
  for (let m = guard.exec(raw); m; m = guard.exec(raw)) guards.push({ index: m.index, form: vars.get(m[1]) });
  const out: UiPopup[] = [];
  const open = /openUrl\s*\(\s*(?:&quot;|"|')#(Form|Report):([A-Za-z_]\w*)[^,)]*,\s*(?:&quot;|"|')[^"')]*popup/gi;
  for (let m = open.exec(raw); m; m = open.exec(raw)) {
    const enclosing = guards.filter((item) => item.index < m.index).pop();
    const name = m[2];
    out.push({
      target: m[1].toLowerCase() === 'report' ? 'report' : 'form',
      name,
      when: enclosing ? 'empty' : 'always',
      ...(enclosing ? { whenForm: enclosing.form ?? name } : {}),
    });
  }
  return out;
}

/** `linkName` wins over `elementName` even when the export writes `elementName` first. */
function namedAttr(attributes: Record<string, string>, keys: string[]): string | undefined {
  const wanted = keys.map((key) => key.toLowerCase());
  const found: { rank: number; value: string }[] = [];
  // determinism-allow: attribute source order; the fixed key priority, not object key order, chooses the value
  for (const [key, value] of Object.entries(attributes)) {
    const rank = wanted.indexOf(key.toLowerCase());
    if (rank < 0 || !value.trim()) continue;
    if (found.some((item) => item.rank === rank)) continue;
    found.push({ rank, value });
  }
  found.sort((a, b) => a.rank - b.rank);
  return found[0]?.value;
}

function stripInlineDelugeTags(source: string): string {
  let out = '';
  let pos = 0;
  let nextBracedEnd = source.indexOf('%}>');
  while (pos < source.length) {
    const start = source.indexOf('<%', pos);
    if (start < 0) {
      out += source.slice(pos);
      break;
    }
    if (source[start + 2] === '{' && nextBracedEnd >= 0) {
      if (nextBracedEnd < start + 3) {
        nextBracedEnd = source.indexOf('%}>', start + 3);
      }
      if (nextBracedEnd >= 0) {
        out += source.slice(pos, start);
        pos = nextBracedEnd + 3;
        continue;
      }
    }
    const plainEnd = source.indexOf('%>', start + 2);
    if (plainEnd < 0) {
      out += source.slice(pos);
      break;
    }
    out += source.slice(pos, start);
    pos = plainEnd + 2;
  }
  return out;
}

export function elementFromZml(
  tag: string,
  attributes: Record<string, string>,
  children: UiElement[],
  text?: string,
  env?: ZmlEnv,
): UiElement {
  const key = tag.toLowerCase();
  const name = namedAttr(attributes, ['linkName', 'formLinkName', 'componentLinkName', 'elementName', 'name', 'id']);
  const width = attr(attributes, ['width']);
  const style = styleOf(attributes);
  const body = text?.trim() ? text : undefined;
  const isIcon = (attr(attributes, ['type', 'imagetype']) || '').toLowerCase() === 'icon';
  if (key === 'image' && isIcon) {
    const icon = attr(attributes, ['value']) ?? '';
    const tile = { ...style };
    if (width && tile.width === undefined) tile.width = width;
    const action = (attr(attributes, ['action']) ?? '').trim();
    const fn = (attr(attributes, ['functionName', 'function']) ?? '').trim();
    const isForm = isFormAction(action, attributes);
    const formTarget = isForm ? formActionTarget(action, attributes) : undefined;
    const matchingForm = formTarget ? findMatchingForm(env?.app?.forms, formTarget) : undefined;
    const isReport = isReportAction(action, attributes);
    const reportTarget = isReport ? reportActionTarget(action, attributes) : undefined;
    const matchingReport = reportTarget ? findMatchingReport(env?.app?.reports, reportTarget) : undefined;
    const href = matchingForm ? `#/form/${matchingForm.name}` : matchingReport ? `#/report/${matchingReport.name}` : undefined;
    const dropped = action && !matchingForm && !matchingReport
      ? imageActionTodos([{ action, ...(fn ? { fn } : {}), ...(icon ? { label: icon } : {}) }], undefined, env?.app)
      : [];
    // The export names this image by the report it opens. The icon glyph stays
    // on `icon`; the element name is that report so the click target is the
    // same link the page refers to.
    const identity = matchingReport ? { name: matchingReport.name, ...(icon ? { icon } : {}) } : icon ? { name: icon, icon } : {};
    return {
      tag,
      kind: 'text',
      ...identity,
      ...(href ? { href } : {}),
      text: '',
      ...(Object.keys(tile).length ? { style: tile } : {}),
      children: [...children, ...dropped],
    };
  }
  if (key === 'pc' && (attr(attributes, ['action']) || '').replace(/\s+/g, '').toLowerCase() === 'openreport') {
    const target = namedAttr(attributes, ['componentLinkName', 'linkName', 'formLinkName']);
    const parameters = attr(attributes, ['parameters'])?.trim();
    const fields = target && env?.app ? reportFormFields(env.app, target) : null;
    const click = parameters && fields ? pcClickParameters(parameters, fields) : null;
    // A compiled click keeps the raw parameters in the href (the coverage
    // check looks for that text) and points the report query at the filter.
    const href = click && parameters ? pcClickHref(target ?? '', parameters, click) : `#/report/${encodeURIComponent(target ?? '')}`;
    const droppedParameters = parameters && !click ? { droppedParameters: parameters } : {};
    return {
      tag,
      kind: 'container',
      ...(target ? { name: target } : {}),
      href,
      ...(width ? { width } : {}),
      ...(style ? { style } : {}),
      ...droppedParameters,
      children,
    };
  }
  if (CONTAINERS.has(key)) {
    return { tag, kind: 'container', ...(name ? { name } : {}), ...(width ? { width } : {}), ...(style ? { style } : {}), children };
  }
  if (key === 'embed') {
    // A static http(s) embed is an iframe. Any other source (a Deluge-templated
    // or missing URL) stays a manual TODO rather than embed something else.
    const source = (attr(attributes, ['url', 'src']) ?? '').trim();
    if (/^https?:\/\//i.test(source)) {
      const height = attr(attributes, ['height']);
      const embedWidth = attr(attributes, ['width']);
      return {
        tag,
        kind: 'embed',
        ...(name ? { name } : {}),
        embed: { url: source, ...(embedWidth ? { width: embedWidth } : {}), ...(height ? { height } : {}) },
        children,
      };
    }
    return {
      tag,
      kind: 'todo',
      ...(name ? { name } : {}),
      todo: `ZML <${tag}> has no generated component`,
      children,
    };
  }
  const kind = NAMED[key];
  if (!kind) {
    return {
      tag,
      kind: 'todo',
      ...(name ? { name } : {}),
      todo: `ZML <${tag}> has no generated component`,
      children,
    };
  }
  if (kind === 'html') {
    const source = body ?? attr(attributes, ['value', 'content', 'html', 'text']) ?? '';
    const decoded = decodeXmlEntities(source);
    const resolved = resolveStaticConditionals(decoded);
    const refused = malformedStyleDeclarations(resolved);
    const refusedStyles = refused.length ? { refusedStyles: refused } : {};
    const popups = popupActions(resolved);
    const imageActions = dedupeImageActions([...zmlImageActions(resolved), ...zmlExecuteFunctionButtons(resolved)]);
    // The attribute is XML-escaped, so `<% %>` islands show up as `&lt;%`.
    // Routing reads the snippet as authored: a page whose Deluge was only
    // literal conditionals is island-free after the collapse yet still belongs
    // to the htmlpage path it took before the islands resolved.
    if (/^\s*htmlpage\b/i.test(decoded) || /<%/.test(decoded) || /<%/.test(source)) {
      const id = env ? `s${env.seq ? env.seq.n++ : 0}` : 's0';
      const compiled = env
        ? compileHtmlpage(env.app, env.page, name ?? tag, resolved, { id, schema: env.schema, resolvedConditionals: resolved !== decoded })
        : null;
      if (compiled?.ok) for (const extra of compiled.files ?? []) env?.emit?.(extra);
      const styleSource = inlineConstantStyleCalls(resolved, env?.app);
      const styleRules = droppedStyleRules(styleSource);
      const lostCss = hasStyleElement(styleSource) ? { droppedStyleRules: styleRules, staticCss: styleSource } : {};
// A compiled snippet wired every ExecuteFunction button to its generated
      // client-call endpoint (any unwired one refuses the compile), so only
      // the image actions remain manual steps.
      const actionItems = compiled?.ok
        ? imageActionTodos(dedupeImageActions(zmlImageActions(resolved)), undefined, env?.app)
        : imageActionTodos(imageActions, compiled ? compiled.reason : undefined, env?.app);
      if (compiled?.ok) {
        const inline = (compiled.components ?? []).filter((item) => env?.components?.[item.kind === 'form' ? 'forms' : 'reports'].has(item.name));
        const unavailable = (compiled.components ?? []).filter((item) => !inline.includes(item)).map((item) => `${item.kind} "${item.name}"`);
        const componentNote = (item: { target: string; step?: string } | string) => ({
          tag,
          kind: 'todo' as const,
          todo: `Embedded zc-component ${typeof item === 'string' ? item : item.target} has no generated view`,
          ...(typeof item === 'object' && item.step ? { manualStep: item.step } : {}),
          children: [],
        });
        const notes = [...(compiled.componentTodos ?? []), ...unavailable].map(componentNote);
        children = [...notes, ...children];
      }
      if (compiled?.ok && compiled.staticOnly) {
        return {
          tag,
          kind,
          ...(name ? { name } : {}),
          html: compiled.html ?? '',
          ...refusedStyles,
          ...lostCss,
          ...(compiled.droppedTags?.length ? { droppedTags: compiled.droppedTags } : {}),
          ...(compiled.includes?.length ? { includes: compiled.includes } : {}),
          ...(compiled.components?.length ? { components: compiled.components.filter((item) => env?.components?.[item.kind === 'form' ? 'forms' : 'reports'].has(item.name)) } : {}),
          ...(popups.length ? { popups } : {}),
          children: [...actionItems, ...children],
        };
      }
      if (compiled?.ok && compiled.file && compiled.src !== undefined) {
        env?.emit?.(compiled.file);
        return {
          tag,
          kind,
          ...(name ? { name } : {}),
          html: compiled.html ?? '',
          ...refusedStyles,
          ...lostCss,
          ...(compiled.droppedTags?.length ? { droppedTags: compiled.droppedTags } : {}),
          src: compiled.src,
          ...(compiled.includes?.length ? { includes: compiled.includes } : {}),
          ...(compiled.components?.length ? { components: compiled.components.filter((item) => env?.components?.[item.kind === 'form' ? 'forms' : 'reports'].has(item.name)) } : {}),
          ...(popups.length ? { popups } : {}),
          children: [...actionItems, ...children],
        };
      }
      // If the snippet was refused solely because of an ExecuteFunction button,
      // the button is already counted by actionItems above; omit the redundant
      // snippet-level TODO so the construct is counted exactly once.
      const snippetTodos: UiElement[] = [];
      if (compiled?.reason !== EXECUTE_FUNCTION_BUTTON) {
        const where = `snippet ${name ?? tag}${env ? ` on page ${env.page}` : ''}`;
        const guidance = serverSnippetGuidance(resolved, compiled?.reason, where, env?.app);
        snippetTodos.push({
          tag,
          kind: 'todo' as const,
          ...(name ? { name } : {}),
          todo: 'Server-side Deluge snippet requires manual translation',
          manualReasons: guidance.reasons,
          manualStep: guidance.step,
          children: [],
        });
      }
      // A full `htmlpage` function declaration is Deluge code end to end
      // (its `content` body still runs through the Deluge engine on every
      // request): drop it whole when it could not be compiled, same as
      // always. An inline `<% ... %>` / `<%{ ... %}>` tag mixed into
      // otherwise literal markup is not a full server-side body, though:
      // the literal HTML around it is not server-driven and would be lost
      // for no reason if the whole snippet were dropped with it.
      if (!/^\s*htmlpage\b/i.test(decoded)) {
        const withoutDeluge = stripInlineDelugeTags(source);
        return {
          tag,
          kind,
          ...(name ? { name } : {}),
          html: sanitizeSnippet(withoutDeluge),
          ...refusedStyles,
          ...(popups.length ? { popups } : {}),
          children: [...snippetTodos, ...actionItems, ...children],
        };
      }
      return {
        tag,
        kind,
        ...(name ? { name } : {}),
        html: '',
        ...lostCss,
        ...(popups.length ? { popups } : {}),
        children: [...snippetTodos, ...actionItems, ...children],
      };
    }
    const droppedTags: string[] = [];
    const staticFnFiles: HtmlpageFile[] = [];
    const html = sanitizeSnippet(
      convertZmlSnippetToHtml(source, new Set((env?.app?.forms ?? []).map((f) => f.name)), {
        app: env?.app,
        fnFiles: staticFnFiles,
        schema: env?.schema,
        reports: new Set((env?.app?.reports ?? []).map((r) => r.name)),
      }),
      undefined,
      droppedTags,
    );
    if (env?.emit) for (const f of staticFnFiles) env.emit(f);
    const styleRules = droppedStyleRules(source);
    const lostCss = hasStyleElement(source) ? { droppedStyleRules: styleRules, staticCss: source } : {};
    const actionItems = imageActionTodos(imageActions, undefined, env?.app);
    return {
      tag,
      kind,
      ...(name ? { name } : {}),
      html,
      ...refusedStyles,
      ...lostCss,
      ...(droppedTags.length ? { droppedTags } : {}),
      ...(popups.length ? { popups } : {}),
      children: [...actionItems, ...children],
    };
  }
  if (kind === 'text' || kind === 'gauge' || kind === 'search' || kind === 'button') {
    if ((attr(attributes, ['type']) || '').toLowerCase() === 'form data') {
      const value = attr(attributes, ['value']) ?? '';
      const criteria = attr(attributes, ['criteria']);
      const expr = /^thisapp\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*(?:\(|$)/.exec(value.trim());
      const kpi = expr ? { form: expr[1], field: expr[2], fn: expr[3].toLowerCase() } : { expression: value };
      // The export attaches a click-through target and drill-down `parameters`
      // (`OpenReport` on a KPI tile): the tile links to the report and the
      // parameters ride its query as filters. A target the app does not have,
      // or parameters outside the report-link grammar, stays a manual step.
      const action = attr(attributes, ['action']) ?? '';
      const clickHref = reportClickHref(action, attributes, env?.app);
      const parameters = attr(attributes, ['parameters'])?.trim();
      // The export entity-encodes the `&` separator (`Field=a&amp;Field_op=20`)
      // inside the attribute; the grammar and the carried link text both read
      // the decoded pairs, like the button path's link parameters.
      const decodedParameters = parameters ? decodeXmlEntities(parameters).trim() : undefined;
      const wiredParameters = clickHref && decodedParameters && translatableClickParameters(decodedParameters, declaredPageParams(env));
      const droppedParameters =
        parameters && !wiredParameters && !JSON.stringify(kpi).includes(parameters) ? { droppedParameters: parameters } : {};
      return {
        tag,
        kind: 'kpi',
        ...(name ? { name } : {}),
        kpi,
        ...(criteria ? { criteria } : {}),
        ...(clickHref ? { href: clickHref } : {}),
        ...(wiredParameters ? { parameters: decodedParameters } : {}),
        ...(style ? { style } : {}),
        ...droppedParameters,
        children,
      };
    }
  }
  if (kind === 'button') {
    const label = attr(attributes, ['value', 'text', 'label', 'title', 'content']) ?? body?.trim() ?? name ?? tag;
    const action = (attr(attributes, ['action']) ?? '').trim();
    const fn = (attr(attributes, ['functionName', 'function']) ?? '').trim();
    const isForm = isFormAction(action, attributes);
    const formTarget = isForm ? formActionTarget(action, attributes) : undefined;
    const matchingForm = formTarget ? findMatchingForm(env?.app?.forms, formTarget) : undefined;
    // The click action carries the form/report target; `parameters` ride the
    // generated link's query — `Field=value` pairs whose value may name a
    // declared page input (`${name}` / `input.name`, substituted when the
    // link is drawn). A string outside the link grammar stays a manual step
    // unless the text already happens to show it.
    const parameters = attr(attributes, ['parameters'])?.trim();
    const pageParams = declaredPageParams(env);
    const linkParameters = (href: string | undefined): string | undefined => {
      if (!parameters || !href) return undefined;
      if (!href.startsWith('#/report/')) return translatableLinkParameters(parameters, pageParams) ? decodeXmlEntities(parameters).trim() : undefined;
      // Report links wire the report-filter grammar extended with declared
      // page inputs; any leaf the runtime cannot apply (an unknown `_op`, a
      // BETWEEN without two bounds) leaves the whole string a manual step.
      const decodedParameters = decodeXmlEntities(parameters).trim();
      return translatableClickParameters(decodedParameters, pageParams) ? decodedParameters : undefined;
    };
    const droppedParameters = (haystack: (string | undefined)[], href?: string): { droppedParameters?: string } =>
      parameters && !linkParameters(href) && !haystack.filter(Boolean).join('\n').includes(parameters) ? { droppedParameters: parameters } : {};
    if (isForm && matchingForm) {
      const href = `#/form/${matchingForm.name}`;
      const wired = linkParameters(href);
      return { tag, kind: 'button', ...(name ? { name } : {}), text: label, href, ...(wired ? { parameters: wired } : {}), ...(style ? { style } : {}), ...droppedParameters([label, href], href), children };
    }
    if (isForm && env?.app && !matchingForm) {
      const what = label ? `ZML <button> "${label}"` : `ZML <button>`;
      return {
        tag,
        kind: 'todo',
        ...(label ? { name: label } : {}),
        todo: `${what} click action ${action} is not generated; wire the click to the function by hand`,
        children,
      };
    }
    const isExecFn = /^(executefunction|function)$/i.test(action.replace(/\s+/g, ''));
    if (isExecFn || fn) {
      const what = label ? `ZML <button> "${label}"` : `ZML <button>`;
      const call = fn ? ` calling function ${fn}` : '';
      return {
        tag,
        kind: 'todo',
        ...(fn ? { name: fn } : label ? { name: label } : {}),
        todo: `${what} click action ${action || 'ExecuteFunction'}${call} is not generated; wire the click to the function by hand`,
        children,
      };
    }
    // A free-text `#` href is kept only as a route to a form or report the app has.
    const free = attr(attributes, ['url', 'href', 'linkName']);
    let href = free?.trim().startsWith('#') ? knownRouteHref(env?.app, free) : free;
    const act = action.replace(/\s+/g, '').toLowerCase();
    if (act === 'openreport' || act === 'report') {
      const reportTarget = namedAttr(attributes, ['componentLinkName', 'linkName', 'formLinkName']);
      const reportHref = knownRouteHref(env?.app, reportTarget ? `#/report/${reportTarget}` : undefined);
      if (reportHref) href = reportHref;
    }
    const wired = linkParameters(href);
    return { tag, kind: 'button', ...(name ? { name } : {}), text: label, ...(href ? { href } : {}), ...(wired ? { parameters: wired } : {}), ...(style ? { style } : {}), ...droppedParameters([label, href], href), children };
  }
  if (kind === 'text' || kind === 'gauge' || kind === 'search') {
    const label = attr(attributes, ['value', 'text', 'label', 'title', 'content']) ?? body?.trim() ?? name ?? tag;
    // A text element with an `OpenReport` click links to the report; its
    // `parameters` ride the link query as filters when the whole string is in
    // the report-link grammar. Anything else stays flagged a manual step.
    const clickHref = kind === 'text' ? reportClickHref(attr(attributes, ['action']) ?? '', attributes, env?.app) : undefined;
    const href = kind === 'search' ? attr(attributes, ['url', 'href', 'linkName']) : clickHref;
    // A search box's `criteriaString`/`criteria` names the predicate it should
    // filter by, but the generated element has nowhere to bind it; flag it as
    // a manual step so the filtering gets wired by hand.
    const criteria = kind === 'search' ? attr(attributes, ['criteriaString', 'criteria'])?.trim() : undefined;
    // A text/gauge element can carry the same click `parameters` a button
    // does (the export points it at a form or report with arguments for the
    // receiving end); report-link parameters wire into the link, others are
    // flagged too.
    const parameters = kind !== 'search' ? attr(attributes, ['parameters'])?.trim() : undefined;
    // The export entity-encodes the `&` separator (`Field=a&amp;Field_op=20`)
    // inside the attribute; the grammar and the carried link text both read
    // the decoded pairs, like the button path's link parameters.
    const decodedParameters = parameters ? decodeXmlEntities(parameters).trim() : undefined;
    const wiredParameters = clickHref && decodedParameters && translatableClickParameters(decodedParameters, declaredPageParams(env));
    const droppedParameters =
      parameters && !wiredParameters && ![label, href].filter(Boolean).join('\n').includes(parameters) ? { droppedParameters: parameters } : {};
    return {
      tag,
      kind,
      ...(name ? { name } : {}),
      text: label,
      ...(href ? { href } : {}),
      ...(wiredParameters ? { parameters: decodedParameters } : {}),
      ...(style ? { style } : {}),
      ...(criteria ? { droppedCriteria: criteria } : {}),
      ...droppedParameters,
      children,
    };
  }
  const href =
    kind === 'report'
      ? `#/report/${encodeURIComponent(name ?? '')}`
      : kind === 'form'
        ? `#/form/${encodeURIComponent(name ?? '')}`
        : undefined;
  // An embedded `<report>` card's `criteriaString`/`criteria` names the rows
  // it should be limited to (e.g. the parent record's related rows). A flat
  // `Field == <value>` conjunction rides the generated link's query — a
  // declared page input (`input.name`), a `zoho.loginuser[id]` bind, or a
  // literal — and lands as report filters; anything else stays a manual step
  // so the filtering gets wired by hand.
  const reportCriteria = kind === 'report' ? attr(attributes, ['criteriaString', 'criteria'])?.trim() : undefined;
  const linkCriteria = reportCriteria ? embedCriteriaLinkParams(reportCriteria, declaredPageParams(env)) : undefined;
  return {
    tag,
    kind,
    ...(name ? { name } : {}),
    ...(href ? { href } : {}),
    ...(linkCriteria ? { parameters: linkCriteria } : {}),
    ...(reportCriteria && !linkCriteria ? { droppedCriteria: reportCriteria } : {}),
    children,
  };
}

export function elementsFromZml(roots: ZmlElement[], env?: ZmlEnv): UiElement[] {
  const walk = (node: ZmlElement): UiElement => elementFromZml(node.tag, node.attributes, node.children.map(walk), node.text, env);
  return roots.map(walk);
}

export function leaves(elements: UiElement[]): UiElement[] {
  const out: UiElement[] = [];
  const walk = (el: UiElement) => {
    if (el.kind === 'container') {
      // A container still carries its own dropped click `parameters` (a
      // `<pc>` opening a report with filter args the generator cannot wire)
      // even though it is otherwise just a wrapper around its children.
      if (el.droppedParameters) out.push(el);
      el.children.forEach(walk);
      return;
    }
    out.push(el);
    // An `html` element may nest a manual TODO (a dropped server-side snippet);
    // every other non-container's children are parts of the element itself.
    if (el.kind === 'html') el.children.forEach(walk);
    // An icon image keeps its dropped click action as a nested manual TODO.
    else if (el.icon !== undefined || el.tag.toLowerCase() === 'image') el.children.filter((c) => c.kind === 'todo').forEach(walk);
  };
  elements.forEach(walk);
  return out;
}
