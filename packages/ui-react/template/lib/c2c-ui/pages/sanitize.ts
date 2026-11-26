// GENERATED from packages/ui/src/sanitizer-core.ts by scripts/sanitizer-core.mjs. Do not edit: change the core and run `npm run build`.
/**
 * The one HTML/CSS snippet sanitizer. Every other copy is derived from this file:
 *  - the build (packages/ui/src/pages.ts) imports it;
 *  - the browser runtime (packages/ui/src/client-runtime.js) carries the transpiled block between its
 *    sanitizer-core markers;
 *  - the React template (packages/ui-react/template/lib/c2c-ui/pages/sanitize.ts) is this file verbatim
 *    under a generated banner.
 * `npm run build` regenerates both copies (scripts/sanitizer-core.mjs); a test fails when either drifts.
 * Keep this file self-contained: no imports, and no TypeScript syntax that does not erase.
 */

/** Ids the page shell owns: a snippet control may not take one (getElementById would find it first, or a label for it would click a shell button). */
export const SHELL_IDS = new Set(['main', 'tabbar', 'more-sheet', 'more-tab', 'toasts', 'app-title', 'nav', 'drawer', 'nav-drawer-open', 'offline', 'sign-out', 'install', 'menu-toggle', 'root', 'c2c-login', 'c2c-login-title', 'c2c-session-body', 'c2c-session-title', 'c2c-smoke-code', 'c2c-smoke-json']);

/**
 * An id (or a label's `for`) a snippet may keep: one bounded token, a letter then letters, digits, `_` or `-`, at most 64 long, and
 * never a shell id. The generated render builds a computed id from an encoded token, so the same rule closes quote, space, `#` or URL text
 * in a value. The generator and the browser runtime keep identical copies.
 */
const ID_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function idTokenOk(value: unknown): boolean {
  const text = String(value ?? '');
  return ID_TOKEN.test(text) && !SHELL_IDS.has(text.toLowerCase());
}

export const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'button', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'input', 'label',
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
  input: new Set(['type', 'checked']),
  label: new Set(['for']),
  // A generated ExecuteFunction button carries its call route, encoded
  // arguments, and success message; the runtime wires the click.
  button: new Set(['type', 'data-fn-call', 'data-fn-args', 'data-fn-argc', 'data-fn-msg', 'data-fn-refresh']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  font: new Set(['color', 'face', 'size']),
  td: new Set(['colspan', 'rowspan', 'title']),
  th: new Set(['colspan', 'rowspan', 'title']),
  ol: new Set(['start', 'title']),
  '*': new Set(['class', 'title', 'id', 'data-style-dropped', 'data-zml']),
};

/**
 * Classes a shell stylesheet lifts out of flow (fixed, absolute or z-indexed):
 * page or data markup may not borrow one to paint over the app. The browser
 * runtime and the React template keep identical copies; a test derives the
 * list from both stylesheets.
 */
export const SHELL_OVERLAY_CLASSES = new Set([
  'c2c-modal-backdrop', 'c2c-sr-only', 'modal', 'modal-close', 'navitems', 'skip', 'skip-link', 'visually-hidden',
]);
// A bundler-hashed CSS-module name, `_local_hash`: the template's modules lift .overlay and .content out of flow.
const SHELL_OVERLAY_MODULE_CLASS = /^_[A-Za-z0-9-]+_[A-Za-z0-9_-]+$/;

/** Longest class attribute and token the sanitizers scan, and the most tokens they keep. */
const CLASS_TEXT_MAX = 4096;
const CLASS_TOKENS_MAX = 32;
const CLASS_TOKEN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/**
 * A class attribute reduced to its plain identifier tokens, minus the shell's
 * overlay classes (compared without case: a quirks-mode page matches class
 * names case-insensitively). A carried `<style>` rule is scoped to the page
 * and selects by class, so the class has to survive the sanitizer; nothing
 * else in a token may.
 */
function cleanClass(value: string): string {
  const text = String(value ?? '');
  if (text.length > CLASS_TEXT_MAX) return '';
  const kept: string[] = [];
  for (const token of text.split(/\s+/)) {
    if (kept.length < CLASS_TOKENS_MAX && CLASS_TOKEN.test(token) && !SHELL_OVERLAY_CLASSES.has(token.toLowerCase()) && !SHELL_OVERLAY_MODULE_CLASS.test(token)) kept.push(token);
  }
  return kept.join(' ');
}

interface DomAttr {
  name: string;
  value: string;
}

export interface DomNode {
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

export interface DomDocument {
  documentElement: DomNode;
  body: DomNode;
  createElement(tag: string): DomNode;
  createTextNode(text: string): DomNode;
  createDocumentFragment(): DomNode;
}

export function listOf<T>(items: ArrayLike<T> | undefined): T[] {
  if (!items) return [];
  const out: T[] = [];
  for (let i = 0; i < items.length; i++) out.push(items[i]);
  return out;
}

export function flatCss(value: string): string {
  return String(value ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
}

/** CSS functions an inline style value may call: colour notations and numeric transforms and filters. None can fetch. */
export const STYLE_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'hue-rotate', 'scale', 'scalex', 'scaley',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scalez', 'scale3d', 'skew', 'skewx', 'skewy',
  'matrix', 'matrix3d', 'perspective', 'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'invert', 'opacity', 'saturate', 'sepia',
  'linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient',
]);

/** Arguments of an allowed function: numbers with an optional unit, separated by spaces, commas or `/`. */
export const STYLE_ARGS = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?(?:(?:\s*[,/]\s*|\s+)[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?)*\s*$/i;
const STYLE_PAINT_ARGS = /^[\s,a-zA-Z0-9#.%+\-]+$/;
const STYLE_PAINT_FUNCTIONS = new Set(['drop-shadow', 'linear-gradient', 'radial-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient']);

/** Longest style attribute or declaration value the sanitizer scans; longer values are refused. */
export const STYLE_TEXT_MAX = 8192;

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
 * A declaration written `name=value`, as `width=3%` in a table cell. A browser's
 * CSS parser skips a declaration with no colon, so it styled nothing in Creator
 * either: there is nothing to carry and nothing lost.
 */
const IGNORED_ASSIGNMENT = /^-?[a-z][-a-z]*\s*=\s*[-\w.%#\s]*$/i;
/** `text-align:"center"`: no browser takes a quoted word for text-align, so it styled nothing in Creator either. */
const IGNORED_QUOTED_ALIGN = /^(["'])[-a-z]+\1$/i;

/**
 * Split an inline style into the declarations kept and the ones refused.
 * Each declaration is checked on its own: the property must be a plain CSS
 * name (never behavior or -moz-binding) and the value a safe style value, so
 * a refused declaration never takes the safe ones beside it. A trailing token
 * with no colon and no assignment, quote, escape, or call is not a declaration
 * and is left out, as is a plain `name=value` pair. The browser runtime keeps an identical copy.
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
      if (/[=@\\'"()]/.test(text) && !IGNORED_ASSIGNMENT.test(text)) dropped.push('?');
      continue;
    }
    const prop = flatCss(text.slice(0, colon));
    const body = text.slice(colon + 1).replace(/!\s*important\s*$/i, '');
    const flat = flatCss(body);
    if (prop === 'text-align' && IGNORED_QUOTED_ALIGN.test(body.trim())) continue;
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
export function ieGradientFilterSafe(args: string): string | undefined {
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
 * One inline-style or exported presentation value: keywords, numbers,
 * lengths, `#hex`, the allowed functions with numeric arguments, `calc()`
 * with numbers, units and + - * /, and in `font-family` quoted plain names.
 * Backslashes (CSS escapes like `u\72 l(`), comments, `@` rules, nested
 * `calc()`, and every other function (`url`, `image-set`, `attr`, `var`, …)
 * are refused.
 */
/** A fetched background image as `c2c fetch-assets` names it: `bg/`, a 64-hex sha256, an image extension. Nothing else. */
const LOCAL_BACKGROUND_URL = /url\(bg\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)\)/g;

export function safeStyleValue(raw: string, prop?: string): boolean {
  let text = String(raw ?? '').trim();
  if (!text || text.length > STYLE_TEXT_MAX || /[;\\@<>{}]/.test(text) || text.includes('/*')) return false;
  if (prop === 'font-family' || prop === 'font') text = text.replace(/"[A-Za-z0-9 _-]*"|'[A-Za-z0-9 _-]*'/g, 'x');
  if (/['"]/.test(text)) return false;
  // The one url() an inline style may carry: a background image this app ships under bg/, named by its sha256.
  if (prop === 'background' || prop === 'background-image') text = text.replace(LOCAL_BACKGROUND_URL, ' ');
  const flat = flatCss(text);
  if (flat.includes('url(') || flat.includes('expression')) return false;
  // Nested calls (a colour inside a gradient) resolve innermost first, one level per pass.
  for (let pass = 0; pass < 4 && /[()]/.test(text); pass++) {
    const next = replaceStyleCalls(text, (name: string, args: string) => {
      const fn = name.toLowerCase();
      if (STYLE_FUNCTIONS.has(fn) && (STYLE_ARGS.test(args) || (STYLE_PAINT_FUNCTIONS.has(fn) && STYLE_PAINT_ARGS.test(args)))) return ' ';
      if (fn === 'calc' && calcArgsSafe(args)) return ' ';
      return '(';
    });
    if (next === text) return false;
    text = next;
  }
  return !/[()]/.test(text);
}

export function allowedAttr(tag: string, name: string): boolean {
  if (name.startsWith('on') || name === 'srcdoc') return false;
  if (name === 'style') return true;
  const specific = ALLOWED_ATTRS[tag];
  if (tag === 'button' && /^data-fn-arg-\d+$/.test(name)) return true;
  if (specific?.has(name)) return true;
  return ALLOWED_ATTRS['*'].has(name);
}

/**
 * The one frame a snippet may keep: a YouTube player, `https://www.youtube.com/embed/<11-character id>` and nothing else
 * (no query, userinfo, port, other host or path). It is rewritten to the privacy-enhanced host the shell CSP allows.
 * The runtime sanitizers carry the same rule.
 */
export function videoEmbedSrc(value: string): string | undefined {
  const match = /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})$/.exec(value);
  return match ? `https://www.youtube-nocookie.com/embed/${match[1]}` : undefined;
}

/** A kept video frame: only its address, size and title survive; the sandbox and the referrer policy are fixed here. */
function videoFrame(node: DomNode, doc: DomDocument): DomNode | null {
  const src = videoEmbedSrc(node.getAttribute('src') ?? '');
  if (!src) return null;
  const out = doc.createElement('iframe');
  out.setAttribute('src', src);
  for (const name of ['width', 'height']) {
    const value = node.getAttribute(name) ?? '';
    if (/^[0-9]{1,4}$/.test(value)) out.setAttribute(name, value);
  }
  const title = node.getAttribute('title');
  if (title) out.setAttribute('title', title);
  out.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  out.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  out.setAttribute('loading', 'lazy');
  out.setAttribute('allowfullscreen', '');
  return out;
}

export function cleanNode(node: DomNode, doc: DomDocument, dropped?: string[], urlOk: (value: string) => boolean = safeUrl): DomNode | null {
  if (node.nodeType === 3) return doc.createTextNode(node.textContent ?? '');
  if (node.nodeType !== 1) return null;
  const tag = (node.tagName || '').toLowerCase();
  if (tag === 'input' && node.getAttribute('type')?.toLowerCase() !== 'checkbox') return null;
  if (tag === 'iframe') return videoFrame(node, doc);
  if (DROPPED_TAGS.has(tag)) return null;
  const fragment = doc.createDocumentFragment();
  for (const child of listOf(node.childNodes)) {
    const next = cleanNode(child, doc, dropped, urlOk);
    if (next) fragment.appendChild(next);
  }
  if (!ALLOWED_TAGS.has(tag)) return fragment;
  const out = doc.createElement(tag);
  for (const attr of listOf(node.attributes)) {
    const name = attr.name.toLowerCase();
    if (!allowedAttr(tag, name)) continue;
    if ((name === 'id' || (tag === 'label' && name === 'for')) && !idTokenOk(attr.value)) continue;
    if (name === 'checked') {
      // A boolean: the initial state of a checkbox, whatever text the author gave it.
      out.setAttribute('checked', '');
      continue;
    }
    if ((name === 'href' || name === 'src') && !(tag === 'img' && name === 'src' && DATA_IMAGE_SRC.test(attr.value)) && !urlOk(attr.value)) continue;
    if (name === 'style') {
      const style = cleanStyle(attr.value);
      if (style.style || !style.dropped.length) out.setAttribute('style', style.style);
      if (style.dropped.length) {
        out.setAttribute('data-style-dropped', style.dropped.join(' '));
        dropped?.push(...style.dropped);
      }
      continue;
    }
    if (name === 'class') {
      const kept = cleanClass(attr.value);
      if (kept) out.setAttribute('class', kept);
      continue;
    }
    out.setAttribute(name, attr.value);
  }
  if (tag === 'a' && out.getAttribute('href')) out.setAttribute('rel', 'noopener noreferrer');
  out.appendChild(fragment);
  return out;
}


/** The one `data:` URL an `<img>` keeps: an inline raster image, matched on the raw value so case, whitespace and SVG stay refused. */
const DATA_IMAGE_SRC = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * An href or src a snippet may keep. The raw value may not hold a control, a space or a backslash and may not
 * start protocol-relative; after each percent-decode pass (four at most) the flattened value may not name a
 * script-capable, local or opaque scheme, and any other scheme than http(s), mailto or tel is refused.
 * A relative path, a query and a hash stay.
 */
export function safeUrl(value: unknown): boolean {
  const raw = String(value ?? '');
  if (!raw) return true;
  if (/[\u0000-\u0020\\]/.test(raw) || raw.startsWith('//')) return false;
  let text = raw;
  for (let pass = 0; pass <= 4; pass++) {
    // Decoded URL data may hold ordinary spaces (%20) legitimately; only decoded controls and backslashes refuse.
    if (pass > 0 && /[\u0000-\u001f\u007f\\]/.test(text)) return false;
    const flatText = flatCss(text);
    if (flatText.startsWith('//') || /^(?:javascript|data|vbscript|file|ftp|blob):/.test(flatText)) return false;
    if (/^[a-z][a-z0-9+.-]*:/.test(flatText) && !/^(?:https?|mailto|tel):/.test(flatText)) return false;
    let decoded: string;
    try { decoded = decodeURIComponent(text); } catch { decoded = text.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))); }
    if (decoded === text) break;
    text = decoded;
  }
  return true;
}

/** True when an inline style would lose a declaration or carry a comment or escape (the strict yes/no form of cleanStyle). */
export function dangerousStyle(value: string): boolean {
  const text = String(value ?? '');
  return text.includes('\\') || text.includes('/*') || cleanStyle(text).dropped.length > 0;
}

const escapeText = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

/**
 * Allowlist sanitizer. `doc` is the document to parse with (jsdom in tests, the page document in the browser).
 * Without a DOM the snippet is text. A refused style declaration is named in the element's `data-style-dropped`
 * and, when `dropped` is an array, pushed onto it.
 */
export function sanitizeSnippet(raw: unknown, doc?: unknown, dropped?: string[]): string {
  const g = globalThis as unknown as { document?: DomDocument & { defaultView?: { DOMParser?: new () => { parseFromString(html: string, type: string): DomDocument } } }; DOMParser?: new () => { parseFromString(html: string, type: string): DomDocument } };
  const documentRef = (doc as typeof g.document) || g.document || null;
  const Parser = (documentRef && documentRef.defaultView && documentRef.defaultView.DOMParser) || g.DOMParser || null;
  if (!documentRef || !Parser) return escapeText(raw);
  const parsed = new Parser().parseFromString(String(raw ?? ''), 'text/html');
  const sink = parsed.createElement('template');
  const content = sink.content;
  if (!content) return '';
  for (const node of listOf(parsed.body.childNodes)) {
    const next = cleanNode(node, parsed, dropped);
    if (next) content.appendChild(next);
  }
  return sink.innerHTML;
}
