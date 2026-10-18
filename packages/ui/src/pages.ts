/**
 * ZML page elements → a small element tree the PWA can render.
 * Layout wrappers stay containers. A tag this generator does not draw becomes
 * a TODO on that element; its children are still kept.
 *
 * HTML snippets are parsed with the DOM and rebuilt from an allowlist. A regex
 * strip leaves slash-separated handlers (`<svg/onload=...>`) in place.
 */

import { createRequire } from 'node:module';
import type { App } from '../../core/src/ir.js';
import type { ZmlElement } from '../../core/src/zml.js';
import type { SchemaPlan } from '../../schema/src/generator.js';
import {
  compileHtmlpage,
  decodeXmlEntities,
  EXECUTE_FUNCTION_BUTTON,
  zmlExecuteFunctionButtons,
  zmlImageActions,
  type HtmlpageFile,
  type ZmlImageAction,
} from './htmlpage.js';
import { serverSnippetGuidance, type SnippetReason } from './snippet-guidance.js';
import { safeUrl } from './url-policy.js';

const require = createRequire(import.meta.url);

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
  /** Allowlisted HTML. The runtime sanitizes again before inserting it. */
  html?: string;
  /** Active or non-rendering snippet elements removed by the sanitizer. */
  droppedTags?: string[];
  /** Static CSS rules in `<style>` elements the sanitizer dropped from `html`; the page counts them as one TODO. */
  droppedStyleRules?: number;
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
export interface ScopedStyle { css: string; droppedRules: number; dropped: string[] }

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
  '*': new Set(['title', 'data-style-dropped', 'data-zml']),
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
  'translate', 'translatex', 'translatey', 'skew', 'skewx', 'skewy',
]);

/** Arguments of an allowed function: numbers with an optional unit, separated by spaces, commas or `/`. */
const STYLE_ARGS = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?(?:(?:\s*[,/]\s*|\s+)[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?)*\s*$/i;

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
    else dropped.push(/^-?[-a-z]+$/.test(prop) ? prop : '?');
  }
  const hasDebris = rawPieces.length !== kept.length + dropped.length;
  return { style: dropped.length ? kept.join('; ') : hasComment || hasDebris ? kept.join('; ') : source, dropped };
}

/** Scan static CSS without regex parsing/backtracking. Unsupported constructs fail closed. */
export function carryStaticStyle(css: string, scope: string, inMedia = false, keyframes?: Set<string>): ScopedStyle {
  const rules: string[] = [];
  const dropped: string[] = [];
  const drop = (what: string) => { dropped.push(what); };
  let uncommented = '';
  let quote = '', comment = '', lineWhitespace = true;
  for (let n = 0; n < css.length; n++) {
    const ch = css[n]!;
    if (comment === 'block') { if (ch === '*' && css[n + 1] === '/') { comment = ''; n++; uncommented += ' '; } continue; }
    if (comment === 'line') { if (ch === '\n' || ch === '\r') { comment = ''; uncommented += ch; lineWhitespace = true; } continue; }
    if (quote) { uncommented += ch; if (ch === '\\' && n + 1 < css.length) uncommented += css[++n]!; else if (ch === quote) quote = ''; if (ch === '\n' || ch === '\r') lineWhitespace = true; else if (!/\s/.test(ch)) lineWhitespace = false; continue; }
    if (lineWhitespace && ch === '/' && css[n + 1] === '/') { comment = 'line'; n++; continue; }
    if (ch === '/' && css[n + 1] === '*') { comment = 'block'; n++; continue; }
    if (ch === '"' || ch === "'") quote = ch;
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
  const skip = () => { while (i < css.length && (css[i]!.trim() === '' || css[i] === ';')) i++; };
  // Safe declarations are kept; each refused one is named by its property.
  const declarations = (body: string): string[] => {
    const out: string[] = []; let start = 0, depth = 0, quote = '', comment = false;
    for (let n = 0; n <= body.length; n++) {
      const ch = body[n] ?? ';';
      if (comment) { if (ch === '*' && body[n + 1] === '/') { comment = false; n++; } continue; }
      if (quote) { if (ch === '\\') n++; else if (ch === quote) quote = ''; continue; }
      if (ch === '/' && body[n + 1] === '*') { comment = true; n++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') depth++; else if (ch === ')') depth--;
      else if (ch === ';' && depth === 0) {
        const part = body.slice(start, n).trim(); start = n + 1;
        if (!part) continue;
        const colon = part.indexOf(':');
        if (colon <= 0) { drop('unparsed declaration'); continue; }
        const cleaned = cleanSheetDeclaration(part, colon);
        if (!cleaned) { drop(declarationLabel(part.slice(0, colon))); continue; }
        out.push(names.size && /^\s*(?:-[a-z]+-)?animation(?:-name)?\s*:/i.test(cleaned) ? renameAnimations(cleaned, names, prefix) : cleaned);
      }
    }
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
    if (i >= css.length) { drop(atRuleLabel(css.slice(start)) ?? 'unparsed CSS'); break; }
    if (css[i] !== '{') {
      if (css[i] === '}') { drop('unparsed CSS'); i++; continue; }
      const statementEnd = css.indexOf(';', i);
      if (css.slice(start, i).trim().startsWith('@') && statementEnd >= 0) { drop(atRuleLabel(css.slice(start, i))!); i = statementEnd + 1; continue; }
      drop('unparsed CSS'); break;
    }
    const head = css.slice(start, i).trim();
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
    if (head.startsWith('@media') && (head.length === 6 || head[6] === '(' || /\s/.test(head[6]!))) {
      const condition = head.slice(6).trim();
      const lower = condition.toLowerCase();
      let conditionSafe = !!condition && !lower.includes('url') && !lower.includes('expression');
      let conditionDepth = 0;
      for (const ch of condition) {
        if (/[a-zA-Z0-9\s():.,%/-]/.test(ch)) {
          if (ch === '(') conditionDepth++;
          else if (ch === ')' && --conditionDepth < 0) conditionSafe = false;
        } else conditionSafe = false;
      }
      if (conditionDepth !== 0) conditionSafe = false;
      if (!conditionSafe || inMedia) { drop(inMedia ? 'nested @media' : '@media condition'); continue; }
      const nested = carryStaticStyle(body, scope, true, names);
      dropped.push(...nested.dropped);
      if (nested.css) rules.push(`@media ${condition}{${nested.css}}`);
      continue;
    }
    const frames = !inMedia && /^@(?:-webkit-|-moz-|-o-)?keyframes\s+[A-Za-z_][-\w]{0,60}$/i.test(head) ? keyframesRule(head, body, prefix, declarations) : undefined;
    if (frames) { rules.push(frames); continue; }
    if (head.startsWith('@')) { drop(atRuleLabel(head)!); continue; }
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
    // A rule keeps its safe declarations; one whose declarations were all refused is left out.
    if (decl.length || dropped.length === before) rules.push(`${sels.map((s) => `${scope} ${s}`).join(',')}{${decl.join(';')}}`);
  }
  return { css: rules.join('\n'), droppedRules: dropped.length, dropped };
}

/** Numeric-argument functions a page stylesheet may also call: 3D transforms, filters, `rect()` clips and easing curves. None can fetch. */
const SHEET_NUMERIC_FUNCTIONS = new Set([
  'translate3d', 'scale3d', 'rotate3d', 'matrix', 'matrix3d', 'perspective', 'brightness', 'contrast', 'grayscale',
  'invert', 'opacity', 'saturate', 'sepia', 'blur', 'rect', 'cubic-bezier',
]);

/** Gradient and easing functions whose arguments are keywords, numbers and `#hex` colours (nested colour calls resolve first). */
const SHEET_KEYWORD_FUNCTIONS = new Set([
  'linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'conic-gradient',
  '-webkit-linear-gradient', '-moz-linear-gradient', '-o-linear-gradient', '-webkit-radial-gradient',
  '-moz-radial-gradient', '-webkit-gradient', 'from', 'to', 'color-stop', 'steps', 'drop-shadow',
]);

/** A quoted CSS string with no raw markup, braces, semicolons or line breaks; a backslash only starts a hex escape. */
const SHEET_STRING = /"(?:[^"\\<>;{}\r\n\f]|\\[0-9a-fA-F])*"|'(?:[^'\\<>;{}\r\n\f]|\\[0-9a-fA-F])*'/g;

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
  if (!/^-?[-a-z]+$/.test(prop) || prop === 'behavior' || prop === '-moz-binding') return undefined;
  return safeSheetValue(part.slice(colon + 1).replace(/!\s*important\s*$/i, ''), prop) ? part.trim() : undefined;
}

function safeSheetValue(raw: string, prop: string): boolean {
  let text = String(raw ?? '').trim();
  if (!text || text.length > STYLE_TEXT_MAX) return false;
  if (prop === 'content') text = text.replace(SHEET_STRING, ' ').replace(/\battr\(\s*[a-zA-Z][-a-zA-Z0-9]{0,40}\s*\)/g, ' ');
  if (prop === 'font' || prop === 'font-family') text = text.replace(/"[A-Za-z0-9 _-]*"|'[A-Za-z0-9 _-]*'/g, 'x');
  if (/[;\\@<>'"{}]/.test(text) || text.includes('/*')) return false;
  const flat = flatCss(text);
  if (flat.includes('url(') || flat.includes('expression') || flat.includes('javascript:') || flat.includes('vbscript:')) return false;
  // Nested calls (a colour inside a gradient) resolve innermost first, one level per pass.
  for (let pass = 0; pass < 4 && text.includes('('); pass++) {
    const next = replaceStyleCalls(text, (name: string, args: string) => {
      const fn = name.toLowerCase();
      if ((STYLE_FUNCTIONS.has(fn) || SHEET_NUMERIC_FUNCTIONS.has(fn)) && STYLE_ARGS.test(args)) return ' ';
      if (fn === 'calc' && calcArgsSafe(args)) return ' ';
      if (SHEET_KEYWORD_FUNCTIONS.has(fn) && /^[\s,a-zA-Z0-9#.%+-]*$/.test(args)) return ' ';
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
function keyframesRule(head: string, body: string, prefix: string, declarations: (body: string) => string[]): string | undefined {
  const [, at, name] = /^@((?:-webkit-|-moz-|-o-)?keyframes)\s+(\S+)$/i.exec(head)!;
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
  return /^-?[-a-z]{1,60}$/.test(name) ? `${name} declaration` : 'unparsed declaration';
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
  if (!text || text.length > STYLE_TEXT_MAX || /[;\\@<>]/.test(text) || text.includes('/*')) return false;
  if (prop === 'font-family') text = text.replace(/"[A-Za-z0-9 _-]*"|'[A-Za-z0-9 _-]*'/g, 'x');
  if (/['"]/.test(text)) return false;
  const flat = flatCss(text);
  if (flat.includes('url(') || flat.includes('expression')) return false;
  const rest = replaceStyleCalls(text, (name: string, args: string) => {
    const fn = name.toLowerCase();
    if (STYLE_FUNCTIONS.has(fn) && STYLE_ARGS.test(args)) return ' ';
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

const REPORTED_DROPPED_TAGS = new Set(['script', 'style', 'svg', 'template']);

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

/**
 * Static CSS rules inside the `<style>` elements of `raw`. The sanitizer drops
 * every `<style>` element whole, so this is the CSS a page loses. Template
 * islands inside the stylesheet are masked before counting.
 */
export function droppedStyleRules(raw: string): number {
  if (!/<\s*style/i.test(String(raw ?? ''))) return 0;
  const win = domWindow();
  const parsed = new win.DOMParser().parseFromString(String(raw ?? ''), 'text/html');
  let rules = 0;
  const walk = (node: DomNode) => {
    if (node.nodeType !== 1) return;
    if ((node.tagName || '').toLowerCase() === 'style') {
      rules += cssRuleCount(maskTemplateIslands(node.textContent ?? '', 'x'));
      return;
    }
    for (const child of listOf(node.childNodes)) walk(child);
  };
  walk(parsed.documentElement);
  return rules;
}

export function carriedStyleRules(raw: string, scope: string): ScopedStyle {
  if (!/<\s*style/i.test(String(raw ?? ''))) return { css: '', droppedRules: 0, dropped: [] };
  const win = domWindow();
  const parsed = new win.DOMParser().parseFromString(String(raw ?? ''), 'text/html');
  const sheets: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType !== 1) return;
    if ((node.tagName || '').toLowerCase() === 'style') {
      sheets.push(maskTemplateIslands(node.textContent ?? '', ' '));
      return;
    }
    for (const child of listOf(node.childNodes)) walk(child);
  };
  walk(parsed.documentElement);
  // Keyframes declared in any of the page's <style> elements are renamed in all of them.
  const names = keyframeNames(sheets.join('\n'));
  const carried: string[] = []; const dropped: string[] = [];
  for (const sheet of sheets) {
    const result = carryStaticStyle(sheet, scope, false, names);
    if (result.css) carried.push(result.css);
    dropped.push(...result.dropped);
  }
  return { css: carried.join('\n'), droppedRules: dropped.length, dropped };
}

/** The TODO reason and manual step for a page's dropped `<style>` CSS. */
export function droppedStyleRulesTodo(page: string, rules: number, dropped: string[] = []): { reason: string; step: string } {
  const counts = new Map<string, number>();
  for (const name of dropped) counts.set(name, (counts.get(name) ?? 0) + 1);
  const named = [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
  const what = `${rules} static style rule${rules === 1 ? '' : 's'} or declaration${rules === 1 ? '' : 's'}${named.length ? ` (${named.join(', ')})` : ''}`;
  return {
    reason: `Static <style> CSS not carried over: the page sanitizer drops ${what}`,
    step: `page ${page}: The sanitizer carries the safe <style> rules, scoped to this page, and drops ${what}. Restyle what was dropped in the app stylesheet, scoped to this page, or with supported components. Keep this TODO open until the restyled page is verified.`,
  };
}

export function droppedTagReason(tag: string): string {
  return `The <${tag}> element is removed from this page snippet by the sanitizer`;
}

/** The TODO reason for refused inline style declarations. */
export function droppedStyleReason(dropped: string[]): string {
  return `Inline style declarations not carried over (unsafe or unsupported CSS): ${dropped.join(', ')}`;
}

function dedupeImageActions(actions: ZmlImageAction[]): ZmlImageAction[] {
  // Each markup occurrence is a separate wiring site, even when its action
  // and label match another occurrence exactly.
  return actions;
}

/**
 * One counted manual step per image or button click action the generated page drops.
 * Generated pages have no client path that calls a Creator function, so the
 * action is never rewired or relabelled here.
 */
function imageActionTodos(actions: ZmlImageAction[], why?: string): UiElement[] {
  return actions.map((a) => {
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
  if (key === 'image' && (attr(attributes, ['type']) || '').toLowerCase() === 'icon') {
    const icon = attr(attributes, ['value']) ?? '';
    const tile = { ...style };
    if (width && tile.width === undefined) tile.width = width;
    const action = (attr(attributes, ['action']) ?? '').trim();
    const fn = (attr(attributes, ['functionName', 'function']) ?? '').trim();
    const dropped = action ? imageActionTodos([{ action, ...(fn ? { fn } : {}), ...(icon ? { label: icon } : {}) }]) : [];
    return { tag, kind: 'text', ...(icon ? { name: icon, icon } : {}), text: '', ...(Object.keys(tile).length ? { style: tile } : {}), children: [...children, ...dropped] };
  }
  if (key === 'pc' && (attr(attributes, ['action']) || '').replace(/\s+/g, '').toLowerCase() === 'openreport') {
    const target = namedAttr(attributes, ['componentLinkName', 'linkName', 'formLinkName']);
    return {
      tag,
      kind: 'container',
      ...(target ? { name: target } : {}),
      href: `#/report/${encodeURIComponent(target ?? '')}`,
      ...(width ? { width } : {}),
      ...(style ? { style } : {}),
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
    const popups = popupActions(decoded);
    const imageActions = dedupeImageActions([...zmlImageActions(decoded), ...zmlExecuteFunctionButtons(decoded)]);
    // The attribute is XML-escaped, so `<% %>` islands show up as `&lt;%`.
    if (/^\s*htmlpage\b/i.test(decoded) || /<%/.test(decoded) || /<%/.test(source)) {
      const id = env ? `s${env.seq ? env.seq.n++ : 0}` : 's0';
      const compiled = env ? compileHtmlpage(env.app, env.page, name ?? tag, decoded, { id, schema: env.schema }) : null;
      if (compiled?.ok) for (const extra of compiled.files ?? []) env?.emit?.(extra);
      const styleRules = droppedStyleRules(decoded);
      const lostCss = styleRules ? { droppedStyleRules: styleRules, staticCss: decoded } : {};
      // A compiled snippet wired every ExecuteFunction button to its generated
      // client-call endpoint (any unwired one refuses the compile), so only
      // the image actions remain manual steps.
      const actionItems = compiled?.ok
        ? imageActionTodos(dedupeImageActions(zmlImageActions(decoded)))
        : imageActionTodos(imageActions, compiled ? compiled.reason : undefined);
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
        const guidance = serverSnippetGuidance(decoded, compiled?.reason, where);
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
    const html = sanitizeSnippet(source, undefined, droppedTags);
    const styleRules = droppedStyleRules(source);
    const lostCss = styleRules ? { droppedStyleRules: styleRules, staticCss: source } : {};
    const actionItems = imageActionTodos(imageActions);
    return {
      tag,
      kind,
      ...(name ? { name } : {}),
      html,
      ...lostCss,
      ...(droppedTags.length ? { droppedTags } : {}),
      ...(popups.length ? { popups } : {}),
      children: [...actionItems, ...children],
    };
  }
  if (kind === 'text' || kind === 'gauge' || kind === 'button' || kind === 'search') {
    if ((attr(attributes, ['type']) || '').toLowerCase() === 'form data') {
      const value = attr(attributes, ['value']) ?? '';
      const criteria = attr(attributes, ['criteria']);
      const expr = /^thisapp\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*(?:\(|$)/.exec(value.trim());
      return {
        tag,
        kind: 'kpi',
        ...(name ? { name } : {}),
        kpi: expr
          ? { form: expr[1], field: expr[2], fn: expr[3].toLowerCase() }
          : { expression: value },
        ...(criteria ? { criteria } : {}),
        ...(style ? { style } : {}),
        children,
      };
    }
    const label = attr(attributes, ['value', 'text', 'label', 'title', 'content']) ?? body?.trim() ?? name ?? tag;
    const href = kind === 'button' || kind === 'search' ? attr(attributes, ['url', 'href', 'linkName']) : undefined;
    return { tag, kind, ...(name ? { name } : {}), text: label, ...(href ? { href } : {}), ...(style ? { style } : {}), children };
  }
  const href =
    kind === 'report'
      ? `#/report/${encodeURIComponent(name ?? '')}`
      : kind === 'form'
        ? `#/form/${encodeURIComponent(name ?? '')}`
        : undefined;
  return { tag, kind, ...(name ? { name } : {}), ...(href ? { href } : {}), children };
}

export function elementsFromZml(roots: ZmlElement[], env?: ZmlEnv): UiElement[] {
  const walk = (node: ZmlElement): UiElement => elementFromZml(node.tag, node.attributes, node.children.map(walk), node.text, env);
  return roots.map(walk);
}

export function leaves(elements: UiElement[]): UiElement[] {
  const out: UiElement[] = [];
  const walk = (el: UiElement) => {
    if (el.kind === 'container') {
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
