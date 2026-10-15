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
  /** A ZML `<embed>` element with a static http(s) URL, drawn as an iframe. */
  embed?: { url: string; width?: string; height?: string };
  children: UiElement[];
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
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
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
  if (!text || text.length > STYLE_TEXT_MAX || /[;\\@]/.test(text) || text.includes('/*')) return false;
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
      rules += cssRuleCount((node.textContent ?? '').replace(/<%[\s\S]*?%>/g, 'x'));
      return;
    }
    for (const child of listOf(node.childNodes)) walk(child);
  };
  walk(parsed.documentElement);
  return rules;
}

/** The TODO reason and manual step for a page's dropped `<style>` CSS. */
export function droppedStyleRulesTodo(page: string, rules: number): { reason: string; step: string } {
  const what = `${rules} static style rule${rules === 1 ? '' : 's'}`;
  return {
    reason: `Static <style> CSS not carried over: the page sanitizer drops ${what}`,
    step: `page ${page}: The sanitizer drops ${what} in <style> elements. Move them into the app stylesheet, scoped to this page, or restyle the page with supported components. Keep this TODO open until the restyled page is verified.`,
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
      const compiled = env ? compileHtmlpage(env.app, env.page, name ?? tag, decoded, { id }) : null;
      const styleRules = droppedStyleRules(decoded);
      const lostCss = styleRules ? { droppedStyleRules: styleRules } : {};
      const actionItems = imageActionTodos(imageActions, compiled && !compiled.ok ? compiled.reason : undefined);
      if (compiled?.ok && compiled.staticOnly) {
        return { tag, kind, ...(name ? { name } : {}), html: compiled.html ?? '', ...lostCss, ...(compiled.droppedTags?.length ? { droppedTags: compiled.droppedTags } : {}), ...(popups.length ? { popups } : {}), children: [...actionItems, ...children] };
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
    const lostCss = styleRules ? { droppedStyleRules: styleRules } : {};
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
