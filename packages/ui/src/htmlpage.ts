/**
 * `htmlpage` / server-side Deluge snippets (`<dsp>`/`<dspZml>` and `<% %>`
 * islands) → a generated read-only endpoint that renders the template
 * server-side. The browser element keeps a sanitized static shell and fetches
 * the rendered HTML, which the client sanitizes again before inserting.
 *
 * Design: one endpoint that returns finished HTML (not a data endpoint plus a
 * client template). The template's control flow (`if`) wraps static markup,
 * so the markup must be emitted by the script itself — a client render would
 * need the same Deluge evaluation in the browser. The islands translate with
 * the shared `translateInApp`, so form reads go through the same scopeRead /
 * authorizeRead path and criteria use bound parameter objects, never string
 * concatenation. Every interpolated value is HTML-escaped; the static markup
 * passes through the same allowlist sanitizer as every other snippet.
 *
 * An island the compiler cannot prove stays a manual TODO (the same counted
 * construct as before), never silently dropped. A statement island inside a
 * quoted attribute value is one of those: only an expression island is
 * rendered there. A style expression is limited to the CSS value grammar.
 */

import type { App } from '../../core/src/ir.js';
import { lex } from '../../deluge/src/lexer.js';
import { parse } from '../../deluge/src/parser.js';
import type { Expr, Stmt } from '../../deluge/src/ast.js';
import { administratorProfiles, buttonCallFunctions, clientCallFunctions, fnSignatureParams, functionCallModule, rawFnParams, slug as functionSlug, translateInApp, type ButtonFunctionCall, type ClientCallCatalog } from '../../deluge/src/generate.js';
import type { SchemaPlan } from '../../schema/src/generator.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { criteriaHasRelative, criteriaHasTodo } from '../../shims/src/criteria.js';
import { ALLOWED_ATTRS, ALLOWED_TAGS, DROPPED_TAGS, allowedAttr, droppedStyles, sanitizeSnippet } from './pages.js';
import { toolchainBannerLines } from '../../core/src/toolchain.js';
import { c2cUrlFunctionSource, flatUrl } from './url-policy.js';
import { hasShapeCWrites, isShapeCGuarded, shapeCStmtOk, shapeCServerOk, type ShapeCGuard } from './htmlpage-shape-c.js';

export interface HtmlpageFile {
  path: string;
  source: string;
}

export interface HtmlpageCompiled {
  ok: boolean;
  /** The template contains only an empty statement wrapper and static markup. */
  staticOnly?: boolean;
  /** Sanitized static shell for the element (`el.html`). */
  html?: string;
  /** Sanitizer-dropped tags found in static markup, including compiled paths. */
  droppedTags?: string[];
  /** Endpoint path the client posts to. */
  src?: string;
  /** The generated endpoint module. */
  file?: HtmlpageFile;
  /** Extra generated modules the snippet depends on (function-call endpoints). */
  files?: HtmlpageFile[];
  /** Why this template is not compiled (the element keeps its TODO). */
  reason?: string;
  /** Pages of this app the template embedded by `page-embed` iframe, now inline includes. */
  includes?: string[];
  /** `zc-component` embeds that can resolve to generated in-app forms or reports. */
  components?: { kind: 'form' | 'report'; name: string }[];
  /** Component embeds without a generated inline target; each remains a counted TODO. */
  componentTodos?: { target: string; step?: string }[];
}

/** Decode the XML entities the ZML attribute escapes the template with. */
export function decodeXmlEntities(raw: string): string {
  return String(raw ?? '').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (whole, body: string) => {
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    if (body === 'amp') return '&';
    const code = body.startsWith('#x') || body.startsWith('#X') ? parseInt(body.slice(2), 16) : body.startsWith('#') ? parseInt(body.slice(1), 10) : 0;
    return code > 0 ? String.fromCodePoint(code) : whole;
  });
}

interface Chunk {
  kind: 'static' | 'expr' | 'stmts';
  text: string;
  /** Where the island sits in the markup. */
  context?: 'text' | 'attr' | 'url' | 'style' | 'comment' | 'reject';
}

const MARK_SPLIT = /ZZC2CSLOT\d+ZZ/g;
const MARK_MATCH = /ZZC2CSLOT(\d+)ZZ/g;
const MARK_CHECK = /ZZC2CSLOT\d+ZZ/;

function marker(i: number): string {
  return `ZZC2CSLOT${i}ZZ`;
}

function localSlug(value: string): string {
  // One linear pass: runs of non [a-z0-9] collapse to a single '-', with no
  // leading or trailing dash. Equivalent to the previous two-step replace
  // but with no backtracking on long runs of separators.
  const lower = String(value ?? '').toLowerCase();
  let out = '';
  let dash = false;
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i);
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      if (dash && out) out += '-';
      out += lower[i];
      dash = false;
    } else {
      dash = true;
    }
  }
  return out || 'page';
}

/** The `htmlpage <name>(<params>)` header, optional property lines, then `content`. */
function splitTemplate(decoded: string): { name: string; params: string[]; template: string } {
  const head = /^[ \t]*htmlpage\b[ \t]*([A-Za-z_]\w*)?[ \t]*(\(([^)]*)\))?/i.exec(decoded);
  if (!head) return { name: '', params: [], template: decoded };
  const name = head[1] ?? '';
  const params = (head[3] ?? '')
    .split(',')
    .map((p) => p.trim().split(/\s+/).pop() ?? '')
    .filter((p) => /^[A-Za-z_]\w*$/.test(p));
  const rest = decoded.slice(head[0].length);
  const content = /(?:^|\r?\n)[ \t]*content\b/.exec(rest);
  let template: string;
  if (content) {
    let after = rest.slice(content.index + content[0].length);
    const eq = /^[ \t]*[=:]/.exec(after);
    if (eq) after = after.slice(eq[0].length);
    template = after.replace(/^[ \t]*\r?\n/, '');
  } else {
    const nl = rest.indexOf('\n');
    template = nl < 0 ? '' : rest.slice(nl + 1);
  }
  const trimmed = template.trim();
  if (trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')) template = trimmed.slice(1, -1);
  return { name, params, template };
}

const URL_ATTRS =
  /^(href|src|srcset|action|formaction|xlink:href|poster|cite|background|longdesc|profile|usemap|data|ping|manifest|codebase|archive|lowsrc|dynsrc|srcdoc)$/i;

/** Whitespace allowed inside a tag: tab, line feed, form feed, carriage return, space. */
const TAG_WS_CHARS = '\t\n\f\r ';
/** The same characters, as a source character class for the URL-value opener. */
const TAG_WS = '\\t\\n\\f\\r ';

function isTagWs(c: string): boolean {
  return TAG_WS_CHARS.includes(c);
}

/**
 * Elements whose contents the HTML parser keeps as raw text or RCDATA rather
 * than markup. An island inside one sits in text the sanitizer cannot place
 * as a real tag or attribute, so it stays a counted snippet, like any other
 * position the compiler cannot prove.
 */
const RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'template',
  'plaintext',
  'listing',
]);

/** Document-shell elements the sanitizer unwraps, keeping their children. */
const DOCUMENT_SHELL_TAGS = new Set(['html', 'body']);

/** Elements whose open tag ends before any content (HTML void elements). */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

type SlotMode =
  | 'data'
  | 'tag-open'
  | 'tag-name'
  | 'end-name'
  | 'before-attr'
  | 'attr-name'
  | 'after-attr'
  | 'before-value'
  | 'value-dq'
  | 'value-sq'
  | 'value-unquoted'
  | 'after-value'
  | 'self-close'
  | 'comment'
  | 'markup'
  | 'bogus';

/**
 * Where an island lands: a text node, an attribute, an HTML comment, or a
 * position output cannot fill safely.
 *
 * A quote opens a value only in the before-value state, which is the state
 * right after '=' once tag whitespace is skipped. An island in an unquoted
 * attribute value is emitted as a quoted attribute with the HTML-attribute
 * escaper. An island inside an HTML comment produces no output (dropped).
 * An island in tag-name or attribute-name position stays refused, as does an
 * island inside an attribute the sanitizer allowlist will remove (a dropped
 * island must stay a counted item, never vanish from a compiled page).
 */
function slotContext(prefix: string): 'text' | 'attr' | 'url' | 'style' | 'comment' | 'reject' {
  let mode: SlotMode = 'data';
  let tag = '';
  let name = '';
  let quotedName = '';
  let unquotedQuote = false;
  let endBuf = '';
  const stack: string[] = [];
  const top = () => (stack.length ? stack[stack.length - 1] : '');
  // Push the just-closed open tag, pop through its end tag. Content of a
  // raw-text or sanitizer-removed element is never a text position.
  const openTag = () => {
    const t = tag.toLowerCase();
    if (t && !VOID_TAGS.has(t)) stack.push(t);
    mode = 'data';
  };
  const closeTag = () => {
    const at = stack.lastIndexOf(endBuf.toLowerCase());
    if (at >= 0) stack.length = at;
    mode = 'data';
  };
  for (let i = 0; i < prefix.length; i++) {
    const c = prefix[i];
    switch (mode) {
      case 'data':
        if (c === '<') {
          // Inside a raw-text element the HTML parser keeps '<' as text until
          // the matching end tag, so a '<a href="' there is not a tag.
          const t = top();
          if (!RAW_TEXT_TAGS.has(t) || new RegExp(`^</${t}(?=[${TAG_WS}/>])`, 'i').test(prefix.slice(i)))
            mode = 'tag-open';
        }
        break;
      case 'tag-open':
        tag = '';
        endBuf = '';
        if (/[A-Za-z]/.test(c)) {
          tag = c;
          mode = 'tag-name';
        } else if (c === '/') {
          mode = 'end-name';
        } else if (c === '!') {
          if (prefix.startsWith('--', i + 1)) {
            mode = 'comment';
            i += 2;
          } else {
            mode = 'markup';
          }
        } else if (c === '?') {
          mode = 'bogus';
        } else {
          mode = 'before-attr';
          i -= 1;
        }
        break;
      case 'tag-name':
        if (isTagWs(c)) mode = 'before-attr';
        else if (c === '/') mode = 'self-close';
        else if (c === '>') openTag();
        else tag += c;
        break;
      case 'end-name':
        if (isTagWs(c)) mode = 'before-attr';
        else if (c === '>') closeTag();
        else if (/[A-Za-z]/.test(c)) endBuf += c;
        else mode = 'bogus';
        break;
      case 'before-attr':
        if (c === '<') {
          tag = '';
          mode = 'tag-open';
          break;
        }
        if (isTagWs(c)) break;
        if (c === '/') {
          mode = 'self-close';
          break;
        }
        if (c === '>') {
          openTag();
          break;
        }
        if (c === '=') {
          name = '';
          mode = 'before-value';
          break;
        }
        name = '';
        mode = 'attr-name';
        i -= 1;
        break;
      case 'attr-name':
        if (c === '<') {
          tag = '';
          mode = 'tag-open';
          break;
        }
        if (isTagWs(c)) mode = 'after-attr';
        else if (c === '/') mode = 'self-close';
        else if (c === '>') openTag();
        else if (c === '=') mode = 'before-value';
        else name += c;
        break;
      case 'after-attr':
        if (c === '<') {
          tag = '';
          mode = 'tag-open';
          break;
        }
        if (isTagWs(c)) break;
        if (c === '/') mode = 'self-close';
        else if (c === '=') mode = 'before-value';
        else if (c === '>') openTag();
        else {
          mode = 'before-attr';
          i -= 1;
        }
        break;
      case 'before-value':
        if (c === '<') {
          tag = '';
          mode = 'tag-open';
          break;
        }
        if (isTagWs(c)) break;
        if (c === '"') {
          quotedName = name;
          mode = 'value-dq';
        } else if (c === "'") {
          quotedName = name;
          mode = 'value-sq';
        } else if (c === '>') openTag();
        else {
          unquotedQuote = false;
          mode = 'value-unquoted';
          i -= 1;
        }
        break;
      case 'value-dq':
        if (c === '"') mode = 'after-value';
        break;
      case 'value-sq':
        if (c === "'") mode = 'after-value';
        break;
      case 'value-unquoted':
        if (c === '<') {
          tag = '';
          mode = 'tag-open';
          unquotedQuote = false;
          break;
        }
        if (isTagWs(c)) {
          unquotedQuote = false;
          mode = 'before-attr';
        } else if (c === '>') {
          unquotedQuote = false;
          openTag();
        } else if (c === '"' || c === "'") unquotedQuote = true;
        break;
      case 'after-value':
        if (c === '<') {
          tag = '';
          mode = 'tag-open';
          break;
        }
        if (isTagWs(c)) mode = 'before-attr';
        else if (c === '/') mode = 'self-close';
        else if (c === '>') openTag();
        else {
          mode = 'before-attr';
          i -= 1;
        }
        break;
      case 'self-close':
        if (c === '<') {
          tag = '';
          mode = 'tag-open';
          break;
        }
        if (c === '>') {
          // The HTML parser ignores the self-closing mark on a raw-text
          // element: it stays open and its content is raw text.
          if (RAW_TEXT_TAGS.has(tag.toLowerCase())) openTag();
          else mode = 'data';
        } else {
          mode = 'before-attr';
          i -= 1;
        }
        break;
      case 'comment':
        if (c === '-' && prefix.startsWith('-->', i)) {
          mode = 'data';
          i += 2;
        } else if (c === '-' && prefix.startsWith('--!>', i)) {
          mode = 'data';
          i += 3;
        }
        break;
      case 'markup':
      case 'bogus':
        if (c === '>') mode = 'data';
        break;
    }
  }
  if (mode === 'comment') return 'comment';
  // An attribute the sanitizer drops (not in the allowlist, an on* handler,
  // srcdoc) would remove the island marker after compile: refuse instead so
  // the page stays a counted snippet. An inline-style value or a URL-bearing
  // attribute is unsafe the same way.
  const keptAttr = (n: string) => !!n && allowedAttr(tag.toLowerCase(), n.toLowerCase());
  if (mode === 'value-dq' || mode === 'value-sq') {
    if (!keptAttr(quotedName)) return 'reject';
    if (/^style$/i.test(quotedName)) return 'style';
    return URL_ATTRS.test(quotedName) ? 'url' : 'attr';
  }
  if (mode === 'value-unquoted' && unquotedQuote) {
    // A quote inside an unquoted value is part of that value, so the value is
    // already polluted: the island is emitted as an escaped plain attribute
    // (the same as any unquoted value), but only when the attribute itself
    // survives the allowlist.
    if (!keptAttr(name) || /^style$/i.test(name)) return 'reject';
    return 'attr';
  }
  if (mode === 'before-value' || mode === 'value-unquoted') {
    if (!keptAttr(name) || /^style$/i.test(name) || URL_ATTRS.test(name)) return 'reject';
    return 'attr';
  }
  if (mode === 'data') {
    // `<html>` / `<body>` are the document shell: the sanitizer unwraps them
    // and keeps their children, so text under them is text of the element
    // they sit in (the snippet root when nothing else encloses them).
    let at = stack.length - 1;
    while (at >= 0 && DOCUMENT_SHELL_TAGS.has(stack[at])) at -= 1;
    const t = at >= 0 ? stack[at] : '';
    if (t && (DROPPED_TAGS.has(t) || RAW_TEXT_TAGS.has(t) || !ALLOWED_TAGS.has(t))) return 'reject';
    return 'text';
  }
  return 'reject';
}

/**
 * `data-zml` value a translated page embed leaves in the markup. `data-zml`
 * survives every snippet sanitizer, and the runtime fills only the names the
 * element declares (`UiElement.includes`), so markup cannot invent one.
 */
export const PAGE_INCLUDE_PREFIX = 'page-include:';

const IFRAME_ATTR = `[${TAG_WS}]+[A-Za-z_:][\\w:.-]*(?:[${TAG_WS}]*=[${TAG_WS}]*(?:"[^"<]*"|'[^'<]*'|[^${TAG_WS}"'=<>\`%]+))?`;
const IFRAME_OPEN = new RegExp(`^<iframe(?:${IFRAME_ATTR})*?[${TAG_WS}]+src[${TAG_WS}]*=[${TAG_WS}]*(["'])$`, 'i');
const APPURI_ISLAND = /<%=[ \t]*zoho[ \t]*\.[ \t]*appuri[ \t]*%>/gi;

/**
 * A literal `<iframe src="<%=zoho.appuri%>page-embed/<Page>">` of another page
 * of this app becomes an inline include of that page's generated view. Creator
 * draws the named page inside the frame [UNVERIFIED]; `zc_*` query keys are
 * Creator display flags (header, footer) [UNVERIFIED] with no view effect
 * here, so they may stay. Anything else is left as written, and the iframe
 * keeps the snippet counted: an unknown page, the page embedding itself, any
 * other query parameter, an island in the URL or the tag, frame content, or a
 * position that is not plain text (a comment, a raw-text or dropped element).
 */
function inlinePageEmbeds(template: string, app: App, page: string): { template: string; includes: string[] } {
  const includes: string[] = [];
  const known = new Set(app.pages.map((item) => item.name));
  let out = '';
  let at = 0;
  APPURI_ISLAND.lastIndex = 0;
  for (let m = APPURI_ISLAND.exec(template); m; m = APPURI_ISLAND.exec(template)) {
    const left = template.slice(at, m.index);
    const start = left.toLowerCase().lastIndexOf('<iframe');
    if (start < 0) continue;
    const open = IFRAME_OPEN.exec(left.slice(start));
    if (!open) continue;
    const quote = open[1];
    const rest = template.slice(m.index + m[0].length);
    const tail = new RegExp(
      `^page-embed/([A-Za-z_]\\w*)(?:\\?([^"'<>%${TAG_WS}]*))?${quote}(?:${IFRAME_ATTR})*[${TAG_WS}]*>[${TAG_WS}]*</iframe[${TAG_WS}]*>`,
      'i',
    ).exec(rest);
    if (!tail) continue;
    const name = tail[1];
    const query = tail[2] ?? '';
    if (!known.has(name) || name === page) continue;
    if (query && !query.split('&').every((part) => part === '' || /^zc_\w+(=[^&]*)?$/i.test(part))) continue;
    // The tag must open in a text position of an element the sanitizer keeps.
    const before = out + template.slice(at, at + start);
    const pieces = splitChunks(before);
    if (!pieces) continue;
    if (slotContext(pieces.map((c) => (c.kind === 'static' ? c.text : 'x')).join('')) !== 'text') continue;
    out = `${before}<div data-zml="${PAGE_INCLUDE_PREFIX}${name}"></div>`;
    at = m.index + m[0].length + tail[0].length;
    APPURI_ISLAND.lastIndex = at;
    if (!includes.includes(name)) includes.push(name);
  }
  return { template: out + template.slice(at), includes };
}

const ZC_LINK = /^(form|view|report|page)linkname$/i;
const SAFE_COMPONENT_NAME = /^[A-Za-z_]\w*$/;
/**
 * A tag that declares itself a zc-component even when its attribute list does
 * not parse (a repeated or unquoted attribute, a stray quote). Anything the
 * strict parser cannot read stays a counted TODO, never an inlined target.
 */
const ZC_COMPONENT_ELNAME = /\belname\s*=\s*['"]zc-component(?=['"\s>]|$)/i;
/** Fold a link name or display name to one comparison shape, the way Creator link names compare. */
const linkNameKey = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Parse a whole component tag's attributes; malformed quoting never proves an embed target. */
function componentAttributes(tag: string): Map<string, string> | null {
  const attrs = new Map<string, string>();
  let at = tag.indexOf(' ') + 1;
  while (at > 0 && at < tag.length) {
    while (/[\t\n\f\r ]/.test(tag[at] ?? '')) at++;
    if (tag[at] === '>' || (tag[at] === '/' && tag[at + 1] === '>')) return attrs;
    const nameStart = at;
    while (/[A-Za-z0-9_:.-]/.test(tag[at] ?? '')) at++;
    if (at === nameStart) return null;
    const name = tag.slice(nameStart, at).toLowerCase();
    while (/[\t\n\f\r ]/.test(tag[at] ?? '')) at++;
    if (tag[at] !== '=') return null;
    at++;
    while (/[\t\n\f\r ]/.test(tag[at] ?? '')) at++;
    const quote = tag[at];
    if (quote !== "'" && quote !== '"') return null;
    at++;
    const valueStart = at;
    while (at < tag.length && tag[at] !== quote) {
      if (tag[at] === '<' || tag[at] === '>') return null;
      at++;
    }
    if (at >= tag.length) return null;
    if (attrs.has(name)) return null;
    attrs.set(name, tag.slice(valueStart, at));
    at++;
  }
  return null;
}

interface EmbeddedComponent { kind: 'form' | 'report'; name: string }

/**
 * Named HTML entities a smuggled URL can hide behind. Numeric references ride
 * on the second branch; anything else stays literal, the way the browser
 * leaves unknown entities alone.
 */
const URL_ENTITY_NAMES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  colon: ':',
  Tab: '\t',
  NewLine: '\n',
};

/** Decode the character references the browser resolves before it parses a URL. */
function decodeUrlEntities(raw: string): string {
  return String(raw ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return URL_ENTITY_NAMES[body] ?? whole;
  });
}

/**
 * Raster image `data:` payloads, the only `data:` URLs a component attribute
 * may carry. SVG and every other `data:` media type can run script; plain and
 * entity/whitespace/case tricks are flattened first, the way the sanitizer
 * and the browser read them (`flatUrl`).
 */
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp)(?:;base64)?,/;

/** True when an attribute value could run code as a URL, so the tag proves no embed target. */
function hostileUrlValue(value: string): boolean {
  const flat = flatUrl(decodeUrlEntities(value));
  if (!flat) return false;
  if (flat.startsWith('javascript:') || flat.startsWith('vbscript:')) return true;
  return flat.startsWith('data:') && !SAFE_DATA_IMAGE.test(flat);
}

/** Marker suffix for an embed whose `zc_Header=false` hides the view title. */
export const COMPONENT_UNTITLED = ':untitled';

/**
 * `params` display flags of a zc-component embed [UNVERIFIED], each with the
 * values the generated view already shows or can apply. `zc_Header=false`
 * hides the view title; the form flags are accepted only at the values the
 * generated form uses (Creator's default labels, no autofocus). Any other key,
 * value, field criteria or Deluge island is not applied, so the embed stays a
 * counted TODO.
 */
const COMPONENT_FLAGS: Record<string, { kinds: readonly string[]; values: readonly string[] }> = {
  zc_header: { kinds: ['form', 'report'], values: ['true', 'false'] },
  zc_focus: { kinds: ['form'], values: ['false'] },
  zc_succmsg: { kinds: ['form'], values: ['data added successfully!'] },
  zc_submitval: { kinds: ['form'], values: ['submit'] },
  zc_resetval: { kinds: ['form'], values: ['reset'] },
};

/** The embed's applicable params, or null when any one cannot be applied. */
function componentParams(raw: string, kind: string): { untitled: boolean } | null {
  const text = raw.replace(/&amp;/gi, '&').trim();
  if (!text) return { untitled: false };
  let untitled = false;
  for (const part of text.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim().toLowerCase();
    const flag = Object.prototype.hasOwnProperty.call(COMPONENT_FLAGS, key) ? COMPONENT_FLAGS[key] : undefined;
    if (!flag || !flag.kinds.includes(kind) || !flag.values.includes(value)) return null;
    if (key === 'zc_header') untitled = value === 'false';
  }
  return { untitled };
}

/**
 * Creator zc-component divs can name a generated form/report [UNVERIFIED]. Only a literal
 * link name whose params are all applicable display flags is provable; other embeds stay TODOs.
 */
function embeddedComponents(template: string, app: App): { template: string; components: EmbeddedComponent[]; markers: string[]; todos: { target: string; step?: string }[] } {
  const components: EmbeddedComponent[] = [];
  const markers: string[] = [];
  const todos: { target: string; step?: string }[] = [];
  const rewritten = template.replace(/<div\b[^>]*>/gi, (tag) => {
    if (!/\belname\s*=/i.test(tag)) return tag;
    const attrs = componentAttributes(tag);
    if (!attrs) {
      // A zc-component tag that does not parse still counts: it never renders,
      // but the customer has an embed to migrate by hand.
      if (ZC_COMPONENT_ELNAME.test(tag)) todos.push({ target: 'component' });
      return tag;
    }
    const componentAttr = attrs.get('elname');
    if (!componentAttr || componentAttr.toLowerCase() !== 'zc-component') return tag;
    const attrKeys = [...attrs.keys()].sort();
    const linkEntry = [...attrs.entries()].sort().find(([key]) => ZC_LINK.test(key));
    const linkKind = linkEntry?.[0].replace(/linkname$/i, '').toLowerCase() ?? '';
    const kind = linkKind === 'view' || linkKind === 'report' ? 'report' : linkKind;
    const name = linkEntry?.[1] ?? '';
    const target = linkEntry ? `${kind || linkEntry[0].replace(/linkname$/i, '').toLowerCase()} "${name}"` : 'component';
    // An embed of another app's component is never inlined against the local
    // same-named target. `ownerName` cannot be verified against this app (the
    // IR carries no owner), so its presence always counts as cross-app.
    const appLink = attrs.get('applinkname');
    const owner = attrs.get('ownername');
    const crossApp = appLink !== undefined && linkNameKey(appLink) !== linkNameKey(app.name ?? '');
    if (crossApp || owner !== undefined) {
      const where = crossApp ? `application "${appLink}"` : `owner "${owner}"`;
      todos.push({
        target: `${target} of ${where}`,
        step: `The embed points at ${target} in another application (${crossApp ? appLink : owner}). Migrate that component into this application, or link the other application, before it can render inline.`,
      });
      return tag;
    }
    const known = SAFE_COMPONENT_NAME.test(name) && (kind === 'form' ? app.forms.some((form) => form.name === name) : kind === 'report' ? app.reports.some((report) => report.name === name) : false);
    const hostile = attrKeys.some((key) => /^on/i.test(key)) || [...attrs.values()].sort().some(hostileUrlValue);
    const rawParams = attrs.get('params');
    const params = rawParams === undefined ? { untitled: false } : componentParams(rawParams, kind);
    if (known && !hostile && params) {
      const component = { kind: kind as 'form' | 'report', name };
      components.push(component);
      const marker = `component-${component.kind}:${component.name}${params.untitled ? COMPONENT_UNTITLED : ''}`;
      markers.push(marker);
      return tag.replace(/>$/, ` data-zml="${marker}">`);
    }
    todos.push({ target });
    return tag;
  });
  return { template: rewritten, components, markers, todos };
}

/** Split the decoded template into static markup and `<% %>` / `<%{ }%>` / `<%= %>` islands. */
function splitChunks(template: string): Chunk[] | null {
  const out: Chunk[] = [];
  let at = 0;
  for (;;) {
    const open = template.indexOf('<%', at);
    if (open < 0) {
      out.push({ kind: 'static', text: template.slice(at) });
      return out;
    }
    if (open > at) out.push({ kind: 'static', text: template.slice(at, open) });
    if (template.startsWith('<%{', open)) {
      // `<%{ ... }%>` is a paired block island in some templates; in others the
      // `{` is an ordinary brace inside a `<% %>` island. Take the first closer.
      const brace = template.indexOf('%}', open + 3);
      const plain = template.indexOf('%>', open + 3);
      if (brace < 0 && plain < 0) return null;
      if (brace >= 0 && (plain < 0 || brace < plain)) {
        out.push({ kind: 'stmts', text: template.slice(open + 3, brace) });
        // Creator's paired empty wrapper closes with `%}>`; the final `>` is
        // part of the delimiter, not visible static markup.
        at = brace + (template.startsWith('%}>', brace) ? 3 : 2);
        continue;
      }
      out.push({ kind: 'stmts', text: template.slice(open + 2, plain) });
      at = plain + 2;
      continue;
    }
    const expr = template.startsWith('<%=', open);
    const close = template.indexOf('%>', open + 2);
    if (close < 0) return null;
    out.push({ kind: expr ? 'expr' : 'stmts', text: template.slice(open + (expr ? 3 : 2), close) });
    at = close + 2;
  }
}

const ALLOWED_STMTS = new Set(['block', 'if', 'assign', 'expr', 'forEach']);
const ALLOWED_EXPRS = new Set([
  'number',
  'string',
  'date',
  'name',
  'list',
  'map',
  'unary',
  'binary',
  'member',
  'call',
  'index',
  'criteria',
  'paren',
  'ifExpr',
  'relative',
]);

/** AST nodes that write a record, send a message, or call out of the app. */
const EFFECT_NODES = new Set(['insert', 'deleteFrom', 'update', 'invokeurl', 'sendmail', 'pushnotification', 'mailAttachments']);

/** True when any node in the tree is a write or an external action. */
function hasEffectNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasEffectNode);
  const rec = node as Record<string, unknown>;
  if (typeof rec.kind === 'string' && EFFECT_NODES.has(rec.kind)) return true;
  if (rec.kind === 'assign' && assignsCriteriaField(rec.target as Expr)) return true;
  for (const key of Object.keys(rec).sort()) {
    if (key !== 'span' && hasEffectNode(rec[key])) return true;
  }
  return false;
}

/** True when the assignment target is a field of `Form[criteria]`. */
export function assignsCriteriaField(target: Expr): boolean {
  if (target.kind !== 'member') return false;
  let cur: Expr = target;
  while (cur.kind === 'member' || cur.kind === 'paren') {
    cur = cur.kind === 'member' ? cur.object : cur.expr;
  }
  return cur.kind === 'criteria';
}

/** Root name of a member/index chain (`r.Sub[0].Field` → `r`), else null. */
function chainRoot(e: Expr): string | null {
  let cur: Expr = e;
  while (cur.kind === 'member' || cur.kind === 'index' || cur.kind === 'paren') {
    cur = cur.kind === 'paren' ? cur.expr : cur.object;
  }
  return cur.kind === 'name' ? cur.name : null;
}

/**
 * `r = Form[…]` (or a member/index/alias of such a binding) holds a fetched
 * record or collection; writing through it changes stored data.
 */
function bindsRecord(e: Expr, bound: ReadonlySet<string>): boolean {
  if (e.kind === 'criteria') return true;
  const root = chainRoot(e);
  return root !== null && bound.has(root);
}

/**
 * True when the statements write a field of a record/collection binding:
 * `r.X =`, `r.X.Y =`, `rows[i].X =`, or the same through a `for each` row
 * variable over a fetched collection. Plain AST kind checks cannot see these:
 * the parser renders them as ordinary assignments.
 */
function boundFieldWrite(stmts: Stmt[], bound: Set<string>): boolean {
  for (const s of stmts) {
    switch (s.kind) {
      case 'assign':
        if (s.target.kind !== 'name') {
          const root = chainRoot(s.target);
          if (root !== null && bound.has(root)) return true;
        } else if (s.op === '=' && bindsRecord(s.value, bound)) {
          bound.add(s.target.name);
        }
        break;
      case 'block':
        if (boundFieldWrite(s.body, bound)) return true;
        break;
      case 'if':
        if (boundFieldWrite([s.then], bound)) return true;
        for (const elif of s.elifs) if (boundFieldWrite([elif.body], bound)) return true;
        if (s.else && boundFieldWrite([s.else], bound)) return true;
        break;
      case 'forEach': {
        const inner = new Set(bound);
        if (!s.iteratesIndex && bindsRecord(s.collection, bound)) inner.add(s.name);
        if (boundFieldWrite([s.body], inner)) return true;
        break;
      }
      default:
        break;
    }
  }
  return false;
}

function stmtOk(s: Stmt): boolean {
  if (!ALLOWED_STMTS.has(s.kind)) return false;
  switch (s.kind) {
    case 'block':
      return s.body.every(stmtOk);
    case 'if':
      return (
        exprOk(s.test) &&
        stmtOk(s.then) &&
        s.elifs.every((elif) => exprOk(elif.test) && stmtOk(elif.body)) &&
        (!s.else || stmtOk(s.else))
      );
    case 'assign':
      // `Form[criteria].Field = x` writes that record. It is not a read.
      return exprOk(s.target) && exprOk(s.value) && !assignsCriteriaField(s.target);
    case 'expr':
      return exprOk(s.expr);
    case 'forEach':
      return exprOk(s.collection) && stmtOk(s.body);
    default:
      return false;
  }
}

export function fieldNameOk(value: string | undefined): boolean {
  return value === undefined || /^[A-Za-z_]\w*$/.test(value);
}

function exprOk(e: Expr): boolean {
  if (!ALLOWED_EXPRS.has(e.kind)) return false;
  switch (e.kind) {
    case 'list':
      return e.elements.every(exprOk);
    case 'map':
      return e.entries.every((en) => exprOk(en.key) && exprOk(en.value));
    case 'unary':
      return exprOk(e.expr);
    case 'binary':
      return exprOk(e.left) && exprOk(e.right);
    case 'member':
      return exprOk(e.object);
    case 'call':
      return exprOk(e.callee) && e.args.every(exprOk);
    case 'index':
      return exprOk(e.object) && exprOk(e.index);
    case 'criteria':
      return (
        exprOk(e.object) &&
        exprOk(e.criteria) &&
        (!e.sort || (fieldNameOk(e.sort.field) && (e.sort.fields ?? []).every((f) => fieldNameOk(f.field)))) &&
        (!e.range || (exprOk(e.range.from) && exprOk(e.range.to)))
      );
    case 'paren':
      return exprOk(e.expr);
    case 'ifExpr':
      return exprOk(e.test) && exprOk(e.then) && (!e.else || exprOk(e.else));
    default:
      return true;
  }
}

/**
 * `openUrl(...)` statements inside an island. Popup-window targets stay lifted
 * by the snippet popup lifter and are removed from the script; every other
 * openUrl becomes a rendered link part at its position in the output.
 */
function rewriteOpenUrls(src: string): string | null {
  let tokens;
  try {
    tokens = lex(src);
  } catch {
    return null;
  }
  const edits: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident' || t.text.toLowerCase() !== 'openurl') continue;
    const open = tokens[i + 1];
    if (!open || open.kind !== 'punct' || open.text !== '(') continue;
    let depth = 0;
    let end = -1;
    const commas: number[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const tk = tokens[j];
      if (tk.kind === 'punct' && tk.text === '(') depth++;
      else if (tk.kind === 'punct' && tk.text === ')') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (depth === 1 && tk.kind === 'punct' && tk.text === ',') commas.push(j);
    }
    if (end < 0) return null;
    const args: string[] = [];
    for (let a = 0; a <= commas.length; a++) {
      const from = a === 0 ? open.end : tokens[commas[a - 1]].end;
      const to = a === commas.length ? tokens[end].start : tokens[commas[a]].start;
      args.push(src.slice(from, to).trim());
    }
    const stmtEnd =
      tokens[end + 1] && tokens[end + 1].kind === 'punct' && tokens[end + 1].text === ';' ? tokens[end + 1].end : tokens[end].end;
    const target = (args[1] ?? '').replace(/^['"]|['"]$/g, '');
    if (/popup/i.test(target)) {
      edits.push({ start: t.start, end: stmtEnd, text: '' });
      continue;
    }
    if (!args[0]) return null;
    edits.push({ start: t.start, end: stmtEnd, text: `c2c_out.add({"k":"L","v":(${args[0]})});` });
  }
  if (!edits.length) return src;
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += src.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + src.slice(at);
}

/**
 * `c2cAuditViolation` in a generated page endpoint: the last check before the
 * rendered HTML leaves. A full document parse first refuses structural markup
 * the fragment walk cannot see (attributes on the `html`/`head`/`body`
 * elements, or a `frameset` element the parser built). Then the joined markup
 * is parsed once more with a real HTML parser and every parsed element and
 * attribute must be inside the sanitized allowlist — no scriptable elements
 * (`script`, `style`, `iframe`, `object`, `embed`, `base`, `meta`, `link`,
 * and everything else outside the tag set), no `on*` handler or `srcdoc`,
 * no attribute the allowlist removes, no refused scheme in a URL-bearing
 * attribute's whole assembled value, and no script scheme flattened into an
 * inline style. A violation refuses the render instead of returning the HTML.
 */
export function renderAuditSource(): string {
  const attrs: Record<string, string[]> = {};
  for (const [tag, set] of Object.entries(ALLOWED_ATTRS).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    attrs[tag] = [...set].sort();
  // The sanitizer adds rel="noopener noreferrer" to rendered anchors, so the
  // rendered document carries it even though templates cannot author it.
  attrs['a'] = [...(attrs['a'] ?? []), 'rel'];
  return `const C2C_AUDIT_TAGS = new Set(${JSON.stringify([...ALLOWED_TAGS].sort())});
const C2C_AUDIT_ATTRS = ${JSON.stringify(attrs)};
const C2C_AUDIT_URLS = ${URL_ATTRS};
function c2cAttrAuditOk(tag, name, value) {
  const attr = String(name).toLowerCase();
  if (attr.slice(0, 2) === "on" || attr === "srcdoc") return false;
  if (attr === "style") {
    const flat = String(value == null ? "" : value).replace(/[\\u0000-\\u0020]+/g, "").toLowerCase();
    return flat.indexOf("javascript:") < 0 && flat.indexOf("vbscript:") < 0;
  }
  const specific = C2C_AUDIT_ATTRS[tag];
  if (tag === "button" && /^data-fn-arg-\\d+$/.test(attr)) return true;
  if (!(specific && specific.indexOf(attr) >= 0) && C2C_AUDIT_ATTRS["*"].indexOf(attr) < 0) return false;
  if (C2C_AUDIT_URLS.test(attr) && !c2cUrlOk(value)) return false;
  return true;
}
function c2cAuditViolation(html) {
  const structural = renderedDocumentViolation(html);
  if (structural) return structural;
  for (const el of renderedHtmlElements(html)) {
    if (!C2C_AUDIT_TAGS.has(el.tag)) return "element " + el.tag;
    for (const attr of el.attributes) {
      if (!c2cAttrAuditOk(el.tag, attr.name, attr.value)) return el.tag + " " + attr.name;
    }
  }
  return "";
}`;
}

/** The generated endpoint module. */
function endpointModule(opts: {
  page: string;
  id: string;
  name: string;
  path: string;
  forms: string[];
  adminProfiles: string[];
  server: string;
  statics: string[];
  hasWrites?: boolean;
  requireOwner?: boolean;
}): string {
  const banner = `/**\n${[
    `htmlpage ${opts.name || opts.id} on page ${opts.page}: a server-side snippet compiled to ${opts.hasWrites ? 'an endpoint with setup writes' : 'a read-only endpoint'}.`,
    `Advanced I/O POST ${opts.path}`,
    'Static markup was sanitized with the snippet allowlist at generation; every interpolated value is HTML-escaped',
    'for its context (text or attribute). The client sanitizes the response again before inserting it.',
    'Reads go through the runtime scopeRead (profile grants, record filters, hidden forms), like the report endpoints.',
    'Page input values are bound criteria/parameters only; nothing is concatenated into ZCQL.',
    'openUrl actions in the template render as links; "popup window" targets stay lifted popup triggers.',
    'Dry run unless deploy mode is live (c2c-deploy.json or C2C_DEPLOY_MODE) and a datastore is configured.',
    ...toolchainBannerLines(),
  ]
    .map((line) => ` * ${line}`)
    .join('\n')}\n */\n`;
  const statics = opts.statics.map((s, i) => `const c2c_static_${i} = ${JSON.stringify(s)};`).join('\n');
  const indented = opts.server
    .split('\n')
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join('\n');
  return `${banner}import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, jsonReplacer, principalFromRequest, renderedDocumentViolation, renderedHtmlElements } from "creator-to-catalyst/shims";

const policyPath = join(dirname(fileURLToPath(import.meta.url)), "../access-policy.json");
export const access = JSON.parse(readFileSync(policyPath, "utf8"));

export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(opts.path)}, dryRun: true };
export const htmlpage = ${JSON.stringify({ page: opts.page, name: opts.name || opts.id, forms: opts.forms })};
${opts.hasWrites ? `const adminProfiles = ${JSON.stringify(opts.adminProfiles)};\n\n` : '\n'}${statics}

function isHidden(name) {
  return !!name && Array.isArray(access.hidden) && access.hidden.includes(name);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, jsonReplacer));
}

function c2cStr(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (typeof v.zoho === "string") return v.zoho === "appuri" ? "#" : "";
    if (Array.isArray(v)) return v.map(c2cStr).join(", ");
    if (typeof v.y === "number" && typeof v.m === "number" && typeof v.d === "number") return v.toString();
    if (typeof v.label === "string") return v.label;
    try {
      return JSON.stringify(v, jsonReplacer);
    } catch (err) {
      return "";
    }
  }
  return String(v);
}

function c2cEsc(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// An island inside a quoted style attribute renders only a strict CSS value:
// numbers with a unit, #hex, rgb()/rgba()/hsl()/hsla() with numeric arguments,
// and a keyword allowlist, joined by whitespace, commas or '/'. Semicolons,
// quotes, backslashes, comments, braces, url(), expression() and every other
// function can never come from a value — it renders empty and is reported as
// a note instead.
const C2C_CSS_WORDS = new Set((${JSON.stringify(
    'auto none normal inherit initial unset revert solid dashed dotted double groove ridge inset outset hidden visible ' +
      'block inline inline-block flex inline-flex grid inline-grid table table-row table-cell list-item run-in ' +
      'absolute relative fixed static sticky center left right top bottom middle baseline sub super text-top text-bottom ' +
      'start end first last only even odd nowrap wrap wrap-reverse pre pre-wrap pre-line break-word italic oblique ' +
      'underline overline line-through wavy capitalize uppercase lowercase full-width small-caps all-small-caps ' +
      'transparent currentcolor cover contain repeat repeat-x repeat-y no-repeat space round scroll local ' +
      'serif sans-serif monospace cursive fantasy system-ui ui-serif ui-sans-serif ui-monospace ui-rounded math emoji fangsong ' +
      'pointer default move text wait help crosshair not-allowed grab grabbing zoom-in zoom-out ' +
      'col-resize row-resize e-resize w-resize n-resize s-resize ne-resize nw-resize se-resize sw-resize ew-resize ns-resize nesw-resize nwse-resize ' +
      'bold bolder lighter thin medium thick collapse separate show row row-reverse column column-reverse ' +
      'flex-start flex-end space-between space-around space-evenly stretch open closed both horizontal vertical ltr rtl ' +
      'forwards backwards alternate alternate-reverse infinite running paused ' +
      'ease linear ease-in ease-out ease-in-out step-start step-end jump-start jump-end jump-none jump-both ' +
      'border-box content-box padding-box margin-box fill-box stroke-box view-box flat preserve-3d ' +
      'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
      'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod ' +
      'darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon ' +
      'darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray ' +
      'dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
      'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon ' +
      'lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon ' +
      'lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
      'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
      'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy ' +
      'oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip ' +
      'peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon ' +
      'sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue ' +
      'tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen',
  )}).split(" "));

const C2C_CSS_VALUE =
  /^(?:[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:px|em|rem|vh|vw|vmin|vmax|cm|mm|in|pt|pc|ex|ch|s|ms|deg|rad|grad|turn|fr|%)?|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\\(\\s*[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)%?\\s*(?:,\\s*[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)%?\\s*){2,3}\\)|[A-Za-z][A-Za-z0-9-]*)(?:[\\s,/]+(?:[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:px|em|rem|vh|vw|vmin|vmax|cm|mm|in|pt|pc|ex|ch|s|ms|deg|rad|grad|turn|fr|%)?|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\\(\\s*[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)%?\\s*(?:,\\s*[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)%?\\s*){2,3}\\)|[A-Za-z][A-Za-z0-9-]*))*$/i;

function c2cCss(v) {
  const text = String(v == null ? "" : v).trim();
  if (!text) return "";
  if (/[;\\\\{}<>&'"!@]/.test(text) || text.includes("/*") || text.includes("*/")) return "";
  const flat = text.replace(/[\\u0000-\\u0020]+/g, "").toLowerCase();
  if (flat.includes("url(") || flat.includes("expression") || flat.includes("javascript:") || flat.includes("vbscript:")) return "";
  if (!C2C_CSS_VALUE.test(text)) return "";
  const words =
    text
      .replace(/(?:rgb|rgba|hsl|hsla)\\([^()]*\\)/gi, " ")
      .replace(/#[0-9a-fA-F]{3,8}/g, " ")
      .replace(/[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[a-zA-Z]{1,5}|%)?/g, " ")
      .match(/[A-Za-z][A-Za-z0-9-]*/g) || [];
  if (!words.every((w) => C2C_CSS_WORDS.has(w.toLowerCase()))) return "";
  return text;
}

${c2cUrlFunctionSource()}

${renderAuditSource()}

function c2cLink(url) {
  const text = String(url || "").trim();
  let href = "";
  let label = text;
  const internal = /^#(Form|Report):(.+)$/.exec(text);
  if (internal) {
    href = "#/" + internal[1].toLowerCase() + "/" + encodeURIComponent(internal[2]);
    label = internal[2].replace(/_/g, " ");
  } else if (/^https?:\\/\\//i.test(text)) {
    href = text;
  }
  if (!href) return "";
  return '<a href="' + c2cEsc(href) + '">' + c2cEsc(label) + "</a>";
}

async function render(ctx) {
  const shim = ctx.shim;
${indented}
  const c2c_parts = [];
  const c2c_notes = [];
  // A URL attribute value may span several parts (static pieces and islands).
  // The scheme check runs on the whole joined value, so the pieces accumulate
  // until the next non-URL part; a dropped island inside the value does not
  // break the accumulation.
  let c2c_url_on = false;
  let c2c_url_raw = "";
  let c2c_url_esc = "";
  const c2c_urlFlush = () => {
    if (!c2c_url_on) return;
    c2c_parts.push(c2cUrlOk(c2c_url_raw) ? c2c_url_esc : "");
    c2c_url_on = false;
    c2c_url_raw = "";
    c2c_url_esc = "";
  };
  for (const item of c2c_out) {
    if (item && typeof item === "object" && !Array.isArray(item) && (item.k === "V" || item.k === "W")) {
      const piece = item.k === "V" ? c2cStr(item.v) : String(item.v == null ? "" : item.v);
      c2c_url_on = true;
      c2c_url_raw += piece;
      c2c_url_esc += item.k === "V" ? c2cEsc(piece) : piece;
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item) && item.k === "D") continue;
    c2c_urlFlush();
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.k === "H") c2c_parts.push(item.v == null ? "" : String(item.v));
    else if (item.k === "T") c2c_parts.push(c2cEsc(c2cStr(item.v)));
    else if (item.k === "A") c2c_parts.push(c2cEsc(c2cStr(item.v)));
    else if (item.k === "L") c2c_parts.push(c2cLink(c2cStr(item.v)));
    else if (item.k === "C") {
      const piece = c2cStr(item.v);
      const css = c2cCss(piece);
      if (!css && piece.trim()) c2c_notes.push("a style island value was not a safe CSS value and rendered empty");
      c2c_parts.push(css);
    } else if (item.k === "N") c2c_notes.push(String(item.v == null ? "" : item.v));
  }
  c2c_urlFlush();
  return { html: c2c_parts.join(""), notes: c2c_notes };
}

function modeOverride() {
  const value = typeof process !== "undefined" && process.env ? process.env.C2C_DEPLOY_MODE : undefined;
  return value === "live" || value === "dry-run" ? value : "";
}

function deployConfig() {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), "../c2c-deploy.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const mode = modeOverride() || (parsed && parsed.mode === "live" ? "live" : "dry-run");
    const appTimeZone = parsed && typeof parsed.appTimeZone === "string" ? parsed.appTimeZone : "";
    const origins = c2cPageOrigins(parsed && parsed.allowedOrigins);
    return { mode, appTimeZone, origins };
  } catch (err) {
    return { mode: modeOverride() || "dry-run", appTimeZone: "", origins: [] };
  }
}

// c2c-deploy.json allowedOrigins names this app's own page origins — the
// Slate URL origin and the function's own domain — written by c2c deploy.
// Each entry is normalized to a URL origin (scheme + host + port), so a
// wildcard or a path suffix can never widen the match.
function c2cPageOrigins(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    try {
      const parsed = new URL(String(item));
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.host.includes("*") && parsed.pathname === "/" && !parsed.search && !parsed.hash) out.push(parsed.origin);
    } catch (err) {}
  }
  return out;
}

async function liveDatastore() {
  try {
    const mod = await import("../c2c-store.mjs");
    if (mod && typeof mod.getDatastore === "function") {
      const stored = mod.getDatastore();
      if (stored) return stored;
    }
  } catch (err) {
    /* store module is absent when this file is loaded alone */
  }
  try {
    if (globalThis.__c2cDatastore) return globalThis.__c2cDatastore;
  } catch (err) {
    /* no injected global */
  }
  return null;
}

export default async function handler(req, res) {
${opts.hasWrites ? `  const headers = req && req.headers && typeof req.headers === "object" ? req.headers : {};
  const header = (name) => headers[name] || headers[name.toLowerCase()] || "";
  if (String(req && req.method || "").toUpperCase() !== "POST") {
    send(res, 405, { dryRun: true, error: "POST required" });
    return;
  }
  // The page is served by Slate and posts cross-origin to this function, so a
  // Host match can never pass. A write runs only for a request whose Origin
  // is one of this app's own configured page origins exactly.
  const origin = String(header("origin") || "");
  let requestOrigin = "";
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") requestOrigin = parsedOrigin.origin;
  } catch (err) {}
  if (!requestOrigin || deployConfig().origins.indexOf(requestOrigin) < 0) {
    send(res, 403, { dryRun: true, error: "request origin not allowed" });
    return;
  }
` : ''}  const principal = principalFromRequest(req);
  if (!principal?.profile) {
    send(res, 401, { dryRun: true, error: "authenticated caller required" });
    return;
  }
${opts.hasWrites ? `  if (!adminProfiles.includes(principal.profile)) {
    send(res, 403, { dryRun: true, error: "administrator profile required" });
    return;
  }
` : ''}${opts.requireOwner ? `  // The snippet's existence check is scoped to zoho.adminuserid, the
  // application owner: only the owner principal may run the write path. The
  // owner id is deploy configuration (C2C_ADMIN_USER_ID), never a client value.
  const ownerId = String(process.env.C2C_ADMIN_USER_ID || "");
  if (!ownerId || String(principal.userId || "") !== ownerId) {
    send(res, 403, { dryRun: true, error: "application owner required" });
    return;
  }
` : ''}  for (const form of htmlpage.forms) {
    if (isHidden(form)) {
      send(res, 403, { dryRun: true, error: "hidden form" });
      return;
    }
  }
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  const datastore = live ? await liveDatastore() : null;
  const appTimeZone = process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined;
  const body = req && typeof req.body === "object" && req.body && !Array.isArray(req.body) ? req.body : {};
  const input = body && typeof body.input === "object" && body.input && !Array.isArray(body.input) ? body.input : {};
  try {
    const runtime = createRuntime({
      dryRun: !live,
      appTimeZone,
      access,
${opts.hasWrites ? '      adminUserId: principal.userId || "",\n' : ''}      ...(datastore ? { datastore } : {}),
    });
    const ctx = runtime.context({ record: input, old: {}, principal, appTimeZone });
    const rendered = await render(ctx);
    let violation = "";
    try {
      violation = c2cAuditViolation(rendered.html);
    } catch (err) {
      violation = "markup audit unavailable";
    }
    if (violation) {
      send(res, 500, { dryRun: !live, error: "rendered markup failed the output attribute check" });
      return;
    }
    send(res, 200, { dryRun: !live, html: rendered.html, notes: rendered.notes, transcript: runtime.transcript });
  } catch (err) {
    const denied = err && err.code === "RECORD_ACCESS_DENIED";
    send(res, denied ? 403 : 500, { dryRun: !live, error: denied ? err.message : "render failed" });
  }
}
`;
}

/**
 * Shim calls a rendered page may make. Value slots, record reads and
 * aggregates through the caller's read policy, and pure helpers (dates,
 * text, lists already in memory). A write, a queued write, a flush, a
 * fetch, mail, or another function call is not in this set.
 *
 * `datastore.field`, `datastore.column` and `datastore.rows` are the same
 * scopeRead path as `datastore.aggregate`: the runtime authorizes with the
 * caller's principal, then returns only the fields that grant allows.
 *
 * `input.set` is the request-local `input.<param> = value` defaulting idiom:
 * it only rewrites the input map for this render — nothing is persisted, and
 * the value reaches any read as a bound criteria parameter. `input.insert`
 * and subform `clear` stay refused.
 *
 * `get`/`set` are the generated index accessors: `get` is a pure own-key
 * read, and `set` is the same class of request-local write as `input.set` —
 * it mutates only its receiver, never a persisted row. A `set` whose
 * receiver is a datastore read is refused below.
 */
const READ_ONLY_SHIM = new Set([
  'get',
  'set',
  'datastore.query',
  'datastore.aggregate',
  'datastore.field',
  'datastore.column',
  'datastore.rows',
  'each',
  'input.get',
  'input.root',
  'input.set',
  'old.get',
  'zoho.currentDate',
  'zoho.currentTime',
  'zoho.loginUser',
  'zoho.loginUserId',
  'zoho.adminUser',
  'zoho.adminUserId',
  'zoho.appUri',
  'zoho.ipAddress',
  'zoho.appName',
  'isNull',
  'isBlank',
  'isNumber',
  'ifnull',
  'list.add',
  'list.get',
  'list.contains',
  'list.containsKey',
  'list.containsValue',
  'list.length',
  'list.size',
  'list.indexOf',
  'list.lastIndexOf',
  'list.keys',
  'list.values',
  'list.aggregate',
  'list.column',
  'list.distinct',
  'number.largest',
  'number.smallest',
  'decimal.cmp',
  'compare.eq',
  'compare.ne',
  'record.get',
  'record.system',
]);

const READ_ONLY_PREFIX = ['date.', 'string.', 'convert.'];

export function readOnlyShim(path: string): boolean {
  if (READ_ONLY_SHIM.has(path)) return true;
  return READ_ONLY_PREFIX.some((prefix) => path.startsWith(prefix) && /^[A-Za-z_][\w]*$/.test(path.slice(prefix.length)));
}

/**
 * Index of the `)` that closes the `(` at `open`, skipping quoted text.
 * Returns -1 when the call is unfinished.
 */
function matchingParen(source: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < source.length; i++) {
    const ch = source[i] ?? '';
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Assigning through a fetched field, column, or row list is not a read.
 * The translator writes that as `await shim.datastore.field(...) = value`.
 */
export function assignsDatastoreRead(server: string): boolean {
  const re = /\b(?:await\s+)?shim\.datastore\.(?:field|column|rows)\s*\(/g;
  for (const match of server.matchAll(re)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = matchingParen(server, open);
    if (close >= 0 && /^\s*=(?!=)/.test(server.slice(close + 1))) return true;
  }
  return false;
}

/**
 * `list.add` on a value already in memory is a local edit, and `set` on a
 * local is a request-local write. The same calls whose receiver is a
 * datastore read would change a fetched record.
 */
export function mutatesFetchedRead(server: string): boolean {
  return /\bshim\.(?:list\.add|set)\s*\(\s*(?:await\s+)?shim\.datastore\.(?:field|column|rows)\b/.test(server);
}

/** True when every shim call is read-only and every await is one of those calls. */
export function islandReadOnly(server: string): boolean {
  if (/\bfunctions\./.test(server)) return false;
  for (const match of server.matchAll(/\bshim\.([A-Za-z_][\w.]*)\s*\(/g)) {
    const name = match[1] ?? '';
    if (!readOnlyShim(name)) return false;
  }
  if (assignsDatastoreRead(server) || mutatesFetchedRead(server)) return false;
  if (/\bawait\s+(?!shim\.)/.test(server)) return false;
  return true;
}

function cleanCssVal(v: string | undefined): string {
  return String(v || '').replace(/;+$/, '').trim();
}

function zmlSizeToCss(size: string | undefined): string {
  if (!size) return '';
  const s = String(size).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const map: Record<number, string> = { 1: '12px', 2: '14px', 3: '16px', 4: '18px', 5: '24px', 6: '32px' };
    return map[n] || `${n * 4}px`;
  }
  return cleanCssVal(s);
}

function zmlAttributesToStyle(attrs: Record<string, string>): string {
  const styles: string[] = [];
  if (attrs.style) styles.push(cleanCssVal(attrs.style));
  if (attrs.width) {
    const w = cleanCssVal(attrs.width);
    if (w === 'fill') styles.push('flex:1;min-width:0');
    else if (w === 'auto') styles.push('width:auto');
    else styles.push(`width:${w}`);
  }
  if (attrs.height) {
    const h = cleanCssVal(attrs.height);
    if (h === 'fill') styles.push('height:100%');
    else if (h === 'auto') styles.push('height:auto');
    else styles.push(`height:${h}`);
  }
  if (attrs.bgcolor) styles.push(`background-color:${cleanCssVal(attrs.bgcolor)}`);
  if (attrs.color) styles.push(`color:${cleanCssVal(attrs.color)}`);
  if (attrs.size) {
    const sz = zmlSizeToCss(attrs.size);
    if (sz) styles.push(`font-size:${sz}`);
  }
  if (attrs.bold === 'true') styles.push('font-weight:bold');
  else if (attrs.bold === 'false') styles.push('font-weight:normal');
  if (attrs.italic === 'true') styles.push('font-style:italic');
  if (attrs.textalign || attrs.halign) {
    const a = cleanCssVal(attrs.textalign || attrs.halign).toLowerCase();
    if (a === 'center' || a === 'left' || a === 'right') styles.push(`text-align:${a}`);
  }
  if (attrs.valign) {
    const va = cleanCssVal(attrs.valign).toLowerCase();
    if (va === 'middle' || va === 'top' || va === 'bottom') styles.push(`vertical-align:${va}`);
  }
  if (attrs.padding) styles.push(`padding:${cleanCssVal(attrs.padding)}`);
  if (attrs.paddingleft) styles.push(`padding-left:${cleanCssVal(attrs.paddingleft)}`);
  if (attrs.paddingright) styles.push(`padding-right:${cleanCssVal(attrs.paddingright)}`);
  if (attrs.paddingtop) styles.push(`padding-top:${cleanCssVal(attrs.paddingtop)}`);
  if (attrs.paddingbottom) styles.push(`padding-bottom:${cleanCssVal(attrs.paddingbottom)}`);
  if (attrs.marginleft) styles.push(`margin-left:${cleanCssVal(attrs.marginleft)}`);
  if (attrs.marginright) styles.push(`margin-right:${cleanCssVal(attrs.marginright)}`);
  if (attrs.margintop) styles.push(`margin-top:${cleanCssVal(attrs.margintop)}`);
  if (attrs.marginbottom) styles.push(`margin-bottom:${cleanCssVal(attrs.marginbottom)}`);
  if (attrs.cornerradius) styles.push(`border-radius:${cleanCssVal(attrs.cornerradius)}`);
  const safe = styles.filter(Boolean).join(';');
  return safe ? ` style="${safe}"` : '';
}

function parseZmlAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  while (i < attrText.length) {
    while (i < attrText.length && /\s/.test(attrText[i] ?? '')) i++;
    if (i >= attrText.length || attrText[i] === '/' || attrText[i] === '>') break;
    let name = '';
    while (i < attrText.length && !/[\s=/]/.test(attrText[i] ?? '')) {
      name += attrText[i++];
    }
    if (!name) break;
    while (i < attrText.length && /\s/.test(attrText[i] ?? '')) i++;
    if (attrText[i] !== '=') {
      attrs[name.toLowerCase()] = '';
      continue;
    }
    i++;
    while (i < attrText.length && /\s/.test(attrText[i] ?? '')) i++;
    if (i >= attrText.length) break;
    const q = attrText[i];
    if (q === '"' || q === "'") {
      i++;
      let val = '';
      while (i < attrText.length && attrText[i] !== q) {
        val += attrText[i++];
      }
      if (i < attrText.length) i++;
      attrs[name.toLowerCase()] = val;
    } else {
      let val = '';
      while (i < attrText.length && !/[\s>]/.test(attrText[i] ?? '')) {
        val += attrText[i++];
      }
      attrs[name.toLowerCase()] = val;
    }
  }
  return attrs;
}

/**
 * Offset just past the first `-->` or `--!>` comment close at or after
 * `from`, or -1 when the comment is unterminated.
 */
function commentClose(input: string, from: number): number {
  for (let i = input.indexOf('--', from); i >= 0 && i + 2 < input.length; i = input.indexOf('--', i + 1)) {
    if (input[i + 2] === '>') return i + 3;
    if (input[i + 2] === '!' && input[i + 3] === '>') return i + 4;
  }
  return -1;
}

/** A click action a ZML `<image>` declared that the generated markup does not run. */
export interface ZmlImageAction {
  action: string;
  /** Stable occurrence identifier within the source snippet. */
  siteId?: string;
  fn?: string;
  label?: string;
  element?: 'button';
}

/**
 * Click actions on the ZML `<image>` elements of a snippet, in source order.
 * The HTML parser reads `<image>` as `<img>` and the sanitizer keeps no
 * `action`, so each one is listed for the caller to count as a manual step.
 * Deluge islands are blanked first: their text is not markup.
 */
export function zmlImageActions(template: string): ZmlImageAction[] {
  const chunks = splitChunks(template);
  const markup = chunks ? chunks.map((c) => (c.kind === 'static' ? c.text : '')).join('') : template.replace(/<%[\s\S]*?(?:%>|$)/g, '');
  const out: ZmlImageAction[] = [];
  for (const m of markup.matchAll(/<image\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attrs = parseZmlAttributes(m[1] ?? '');
    const action = (attrs.action ?? '').trim();
    if (!action) continue;
    const fn = (attrs.functionname ?? attrs.function ?? '').trim();
    const label = ['elementname', 'name', 'id', 'value', 'src', 'alt'].map((k) => (attrs[k] ?? '').trim()).find(Boolean);
    out.push({ action, siteId: `image-${m.index}`, ...(fn ? { fn } : {}), ...(label ? { label } : {}) });
  }
  return out;
}

/** ExecuteFunction buttons in literal snippet markup; islands are not markup. */
export function zmlExecuteFunctionButtons(template: string): ZmlImageAction[] {
  const chunks = splitChunks(template);
  const markup = chunks ? chunks.map((c) => (c.kind === 'static' ? c.text : '')).join('') : template.replace(/<%[\s\S]*?(?:%>|$)/g, '');
  const out: ZmlImageAction[] = [];
  for (const tag of buttonTags(markup)) {
    const attrs = parseZmlAttributes(tag.attrText);
    const action = (attrs.action ?? '').trim();
    if (action.replace(/\s+/g, '').toLowerCase() !== 'executefunction') continue;
    const fn = (attrs.functionname ?? attrs.function ?? '').trim();
    const label = ['elementname', 'name', 'id', 'value', 'text', 'label'].map((k) => (attrs[k] ?? '').trim()).find(Boolean);
    out.push({ action: 'ExecuteFunction', siteId: `button-${tag.start}`, ...(fn ? { fn } : {}), ...(label ? { label } : {}), element: 'button' });
  }
  return out;
}

export function convertZmlSnippetToHtml(template: string): string {
  if (!/<\/?(panel|pr|pc|prefix|suffix|text|row|column|image)\b/i.test(template)) {
    return template;
  }
  let out = '';
  let at = 0;
  const tagStack: { tag: string; isContainer: boolean }[] = [];

  while (at < template.length) {
    if (template.startsWith('<%', at)) {
      // Same closer rule as splitChunks: a `<%{` island ends at whichever of
      // `%}` and `%>` comes first. A later `<%}%>` must not swallow the markup
      // between them, or the ZML tags inside are never converted.
      const isBlock = template.startsWith('<%{', at);
      const brace = isBlock ? template.indexOf('%}', at + 3) : -1;
      const plain = template.indexOf('%>', at + (isBlock ? 3 : 2));
      const close = brace >= 0 && (plain < 0 || brace < plain) ? brace + 2 : plain + 2;
      const end = close > 1 ? close : template.length;
      out += template.slice(at, end);
      at = end;
      continue;
    }

    if (template[at] === '<') {
      if (template.startsWith('<!--', at)) {
        const end = commentClose(template, at + 4);
        const stop = end < 0 ? template.length : end;
        out += template.slice(at, stop);
        at = stop;
        continue;
      }

      const m = /^<\/?([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(template.slice(at));
      if (m) {
        const full = m[0];
        const rawTag = m[1];
        const tag = rawTag.toLowerCase();
        const attrStr = m[2];
        const isSelfClosing = m[3] === '/' || full.endsWith('/>');
        const isClosing = full.startsWith('</');

        if (tag === 'prefix' || tag === 'suffix') {
          if (isClosing) {
            at += full.length;
            continue;
          }
          const attrs = parseZmlAttributes(attrStr);
          const val = attrs.value || '';
          const style = zmlAttributesToStyle(attrs);
          out += `<span${style}>${val}</span>`;
          at += full.length;
          const after = template.slice(at);
          const closeMatch = new RegExp(`^\\s*<\\/${tag}>`, 'i').exec(after);
          if (closeMatch) at += closeMatch[0].length;
          continue;
        }

        if (tag === 'text') {
          if (isClosing) {
            const popped = tagStack.pop();
            if (popped?.isContainer) {
              out += '</div>';
            }
            at += full.length;
            continue;
          }
          const attrs = parseZmlAttributes(attrStr);
          const style = zmlAttributesToStyle(attrs);
          if (isSelfClosing) {
            const val = attrs.value || '';
            out += `<div${style}>${val}</div>`;
            at += full.length;
            continue;
          }
          const after = template.slice(at + full.length);
          if (/^\s*<(prefix|suffix)\b/i.test(after)) {
            tagStack.push({ tag: 'text', isContainer: true });
            out += `<div${style}>`;
            at += full.length;
          } else {
            const val = attrs.value || '';
            out += `<div${style}>${val}</div>`;
            at += full.length;
            const closeMatch = /^\s*<\/text>/i.exec(template.slice(at));
            if (closeMatch) {
              at += closeMatch[0].length;
            } else {
              tagStack.push({ tag: 'text', isContainer: false });
            }
          }
          continue;
        }

        // A ZML icon image is a decorative styled tile, as on a page-level
        // ZML layout: the box keeps its size, colours and corner radius, and
        // the icon glyph name is not rendered.
        if (tag === 'image' && !isClosing && (parseZmlAttributes(attrStr).type ?? '').trim().toLowerCase() === 'icon') {
          out += `<div data-zml="icon"${zmlAttributesToStyle(parseZmlAttributes(attrStr))}></div>`;
          at += full.length;
          if (!isSelfClosing) {
            const closeMatch = /^\s*<\/image>/i.exec(template.slice(at));
            if (closeMatch) at += closeMatch[0].length;
          }
          continue;
        }

        if (tag === 'panel' || tag === 'pr' || tag === 'pc' || tag === 'row' || tag === 'column') {
          if (isClosing) {
            out += '</div>';
            at += full.length;
            continue;
          }
          const attrs = parseZmlAttributes(attrStr);
          const style = zmlAttributesToStyle(attrs);
          out += `<div data-zml="${tag}"${style}>`;
          if (isSelfClosing) out += '</div>';
          at += full.length;
          continue;
        }

        out += full;
        at += full.length;
        continue;
      }
    }

    out += template[at++];
  }

  return out;
}

/** Todo constructs raised only by the translator's client projection. */
const CLIENT_PROJECTION_TODOS: ReadonlySet<string> = new Set(['client-condition-uses-server', 'client-loop-uses-server']);

/**
 * Compile refusal for a ZML `<button action='ExecuteFunction'>` whose function
 * call cannot be generated. The button runs a Deluge function with the given
 * parameters when clicked; only a call to a read-only function of this app
 * with constant or declared-page-parameter arguments is rewritten to a
 * generated client-call endpoint. Anything else keeps the snippet a counted
 * manual item with this reason.
 */
export const EXECUTE_FUNCTION_BUTTON = 'ZML ExecuteFunction button';

/**
 * Point the one known record-summary iframe shape at the generated route. The
 * URL's row id is still untrusted: the route uses the form's record endpoint,
 * which applies authorizeRead to that exact ROWID before returning fields.
 */
export function rewriteRecordSummaryFrames(template: string, app?: App): string {
  return replaceIframeElements(String(template ?? ''), (whole, attrs, inner) => {
    const src = /\bsrc\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
    if (!src) return whole;
    const match = /^<%=\s*zoho\.appuri\s*%>record-summary\/([A-Za-z_]\w*)\/<%=([\s\S]+?)%>$/i.exec(src[2]);
    if (!match) return whole;
    const target = match[1];
    const report = app?.reports.find((item) => item.name === target);
    const form = report?.form ?? target;
    if (app && (!app.forms.some((item) => item.name === form) || (!report && !app.forms.some((item) => item.name === target)))) return whole;
    if (report) {
      const criteria = reportCriteria(report.criteria?.trim() || 'true');
      if (criteriaHasTodo(criteria) || criteriaHasRelative(criteria)) return whole;
    }
    const idExpr = match[2].trim();
    const read = new RegExp(`^${form}\\s*\\[[^\\[\\]]+\\]\\s*\\.\\s*ID$`, 'i').test(idExpr);
    const param = /^input\.[A-Za-z_]\w*$/.test(idExpr);
    if (!read && !param) return whole;
    const routed = report ? `#/report/${report.name}/row/<%=${idExpr}%>` : `#/record/${form}/<%=${idExpr}%>`;
    const nextAttrs = attrs.slice(0, src.index) + `src=${src[1]}${routed}${src[1]}` + attrs.slice(src.index + src[0].length);
    const anchorAttrs = nextAttrs.replace(/\bsrc\s*=/i, 'href=');
    const label = inner.trim() || 'View record summary';
    return `<a${anchorAttrs}>${label}</a>`;
  });
}

/**
 * Replace each complete `<iframe ...>...</iframe>` element, scanning once from
 * left to right. Attributes are read quote-aware (a quote with no closing
 * partner is plain text), the body ends at the first `</iframe>` (whitespace
 * allowed before `>`), and an element with no closing tag is left as written.
 * A hand scanner keeps this linear in the template length where the equivalent
 * backtracking regular expression was not.
 */
function replaceIframeElements(template: string, replace: (whole: string, attrs: string, inner: string) => string): string {
  const open = /<iframe(?![A-Za-z0-9_])/gi;
  const close = /<\/iframe/gi;
  const lastDouble = template.lastIndexOf('"');
  const lastSingle = template.lastIndexOf("'");
  let out = '';
  let copied = 0;
  for (let start = open.exec(template); start; start = open.exec(template)) {
    let i = start.index + start[0].length;
    let quote = '';
    for (; i < template.length; i += 1) {
      const ch = template[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if ((ch === '"' && i < lastDouble) || (ch === "'" && i < lastSingle)) {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    if (i >= template.length) break;
    close.lastIndex = i + 1;
    let end = -1;
    let bodyEnd = -1;
    for (let tag = close.exec(template); tag; tag = close.exec(template)) {
      let j = tag.index + tag[0].length;
      while (j < template.length && /\s/.test(template[j]!)) j += 1;
      if (template[j] === '>') {
        bodyEnd = tag.index;
        end = j + 1;
        break;
      }
      close.lastIndex = j;
    }
    if (end < 0) break;
    const attrs = template.slice(start.index + start[0].length, i);
    out += template.slice(copied, start.index) + replace(template.slice(start.index, end), attrs, template.slice(i + 1, bodyEnd));
    copied = end;
    open.lastIndex = end;
  }
  return out + template.slice(copied);
}

/** A `<button …>` tag found by `buttonTags`. */
interface ButtonTag {
  /** Offset of the `<`. */
  start: number;
  /** Offset just past the closing `>`. */
  end: number;
  /** Attribute text between `<button` and `>`, minus a self-closing `/`. */
  attrText: string;
  /** The tag ended `/>`: the ZML button is a self-closing element. */
  selfClose: boolean;
}

/**
 * `<button …>` tags in `template`, found by a single-pass scan (a
 * backtracking attribute-list regex is super-linear on adversarial input).
 * `FIND` locates each `<button` word; the attribute scan then steps forward
 * once, skipping `>` inside a closed quote. A quote with no closing partner
 * abandons only that tag — a later `<button` can still open one. A scan that
 * reaches the end of the template means no `>` remains, so no later
 * `<button` can close either and the scan stops.
 */
function* buttonTags(template: string): Generator<ButtonTag> {
  const FIND = /<button\b/gi;
  for (let m = FIND.exec(template); m; m = FIND.exec(template)) {
    const start = m.index;
    let i = start + m[0].length;
    let end = -1;
    while (i < template.length) {
      const c = template[i]!;
      if (c === '>') {
        end = i + 1;
        break;
      }
      if (c === '"' || c === "'") {
        const close = template.indexOf(c, i + 1);
        if (close < 0) break;
        i = close + 1;
        continue;
      }
      i++;
    }
    if (end < 0) {
      if (i >= template.length) return;
      continue;
    }
    const raw = template.slice(start + m[0].length, end - 1);
    const trimmed = raw.trimEnd();
    const selfClose = trimmed.endsWith('/');
    yield { start, end, attrText: selfClose ? trimmed.slice(0, -1) : raw, selfClose };
    FIND.lastIndex = end;
  }
}

/** True when the template holds a ZML button whose action calls a Deluge function. */
export function hasExecuteFunctionButton(template: string): boolean {
  for (const tag of buttonTags(template)) {
    const action = parseZmlAttributes(tag.attrText).action ?? '';
    if (action.replace(/\s+/g, '').toLowerCase() === 'executefunction') return true;
  }
  return false;
}

/** One decoded ExecuteFunction argument: a constant JSON value or a declared page parameter name. */
type FnButtonArg = { kind: 'c'; value: unknown } | { kind: 'p'; name: string } | { kind: 'r'; expr: string; type: string };

/**
 * Split a `parameters` attribute on its top-level commas. Commas inside
 * quoted strings or `<%= %>` islands do not split. `null` on an unterminated
 * quote or island — the button is left in place and stays counted.
 */
function splitButtonArgs(text: string): string[] | null {
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  let island = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (island) {
      cur += c;
      if (c === '%' && text[i + 1] === '>') {
        cur += '>';
        i++;
        island = false;
      }
      continue;
    }
    if (quote) {
      cur += c;
      if (c === '\\') {
        if (i + 1 < text.length) cur += text[++i];
      } else if (c === quote) {
        quote = '';
      }
      continue;
    }
    if (c === '<' && text.startsWith('<%', i)) {
      cur += '<%';
      i++;
      island = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ',') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (quote || island) return null;
  parts.push(cur);
  return parts;
}

/**
 * Decode one ExecuteFunction argument. A `<%=name%>` island that spans the
 * whole argument names a declared page parameter (the client reads it from
 * the page URL like the snippet render input does); anything else inside an
 * island — a member read, an expression, a script variable — is refused.
 * Quoted strings, numbers, and booleans are constants; every other shape is
 * refused so the button stays the counted manual item.
 */
function buttonArg(raw: string, pageParams: ReadonlySet<string>, rendered: boolean, paramType = ''): FnButtonArg | null {
  const arg = raw.trim();
  if (!arg) return null;
  const island = /^<%=([\s\S]+?)%>$/.exec(arg);
  if (island) {
    const expr = island[1]!.trim();
    if (/^[A-Za-z_]\w*$/.test(expr) && pageParams.has(expr)) return { kind: 'p', name: expr };
    if (rendered && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(expr)) return { kind: 'r', expr, type: paramType };
    return null;
  }
  if (arg.includes('<%')) return null;
  if (arg[0] === '"' && arg.endsWith('"') && arg.length >= 2) {
    try {
      return { kind: 'c', value: JSON.parse(arg) as unknown };
    } catch {
      return null;
    }
  }
  if (arg[0] === "'" && arg.endsWith("'") && arg.length >= 2) {
    const inner = arg.slice(1, -1);
    if (/\\[^\\'nt]/.test(inner)) return null;
    return { kind: 'c', value: inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\') };
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(arg)) return { kind: 'c', value: Number(arg) };
  if (arg === 'true' || arg === 'false') return { kind: 'c', value: arg === 'true' };
  return null;
}

/** The read-only client-call catalog is identical for every snippet of one app. */
const CLIENT_CALL_CACHE = new WeakMap<App, ClientCallCatalog>();

function clientCallsFor(app: App): ClientCallCatalog {
  let cached = CLIENT_CALL_CACHE.get(app);
  if (!cached) {
    cached = clientCallFunctions(app);
    CLIENT_CALL_CACHE.set(app, cached);
  }
  return cached;
}

const BUTTON_CALL_CACHE = new WeakMap<App, Map<string, ButtonFunctionCall>>();

function buttonCallsFor(app: App): Map<string, ButtonFunctionCall> {
  let cached = BUTTON_CALL_CACHE.get(app);
  if (!cached) {
    cached = buttonCallFunctions(app);
    BUTTON_CALL_CACHE.set(app, cached);
  }
  return cached;
}

function fnArgType(type: string): string {
  const t = type.trim().toLowerCase();
  if (/^(int|integer|number|decimal|float|bigint|long)$/.test(t)) return 'n';
  if (/^(bool|boolean)$/.test(t)) return 'b';
  return 's';
}

/**
 * `[open, end)` ranges the template's `<% %>` / `<%{ }%>` islands span, using
 * the same delimiter rules as splitChunks. `null` when an island never
 * closes — the template is malformed and the caller refuses it anyway.
 */
function islandRanges(template: string): [number, number][] | null {
  const ranges: [number, number][] = [];
  let at = 0;
  for (;;) {
    const open = template.indexOf('<%', at);
    if (open < 0) return ranges;
    if (template.startsWith('<%{', open)) {
      const brace = template.indexOf('%}', open + 3);
      const plain = template.indexOf('%>', open + 3);
      if (brace < 0 && plain < 0) return null;
      if (brace >= 0 && (plain < 0 || brace < plain)) {
        const end = brace + (template.startsWith('%}>', brace) ? 3 : 2);
        ranges.push([open, end]);
        at = end;
        continue;
      }
      ranges.push([open, plain + 2]);
      at = plain + 2;
      continue;
    }
    const close = template.indexOf('%>', open + 2);
    if (close < 0) return null;
    ranges.push([open, close + 2]);
    at = close + 2;
  }
}

/**
 * Rewrite each ZML `<button action='ExecuteFunction'>` in the template to a
 * wired `<button data-fn-call>` that posts to the callee's generated client
 * endpoint — the same read-only function surface a client condition would
 * call. A button is rewritten only when its `functionName` is a Deluge
 * function this app defines and that function is in the proved read-only
 * client-call set, and every `parameters` entry is a quoted/number/boolean
 * constant or a whole-argument `<%=name%>` island naming a declared page
 * parameter (the island is consumed into the encoded argument list, never
 * rendered). Each accepted callee contributes its
 * `functions/custom/<name>-call.mjs` endpoint module to `files` (deduped by
 * function). A button that fails any check is left unchanged so the caller's
 * `hasExecuteFunctionButton` refusal keeps the whole snippet counted. Button
 * text inside a `<% %>` island is never touched.
 */
function rewriteExecuteFunctionButtons(
  template: string,
  app: App,
  pageParams: ReadonlySet<string>,
  files: HtmlpageFile[],
  schema?: SchemaPlan,
): string {
  if (!hasExecuteFunctionButton(template)) return template;
  const islands = islandRanges(template);
  if (!islands) return template;
  const calls = clientCallsFor(app);
  const buttonCalls = buttonCallsFor(app);
  const emitted = new Set<string>();
  let out = '';
  let at = 0;
  for (const tag of buttonTags(template)) {
    const start = tag.start;
    // A `<button` inside an island is Deluge code, not markup.
    if (islands.some(([s, e]) => start >= s && start < e)) continue;
    const rewritten = ((): string | null => {
      const attrs = parseZmlAttributes(tag.attrText);
      if ((attrs.action ?? '').replace(/\s+/g, '').toLowerCase() !== 'executefunction') return null;
      // The ZML button is a self-closing element; a paired `<button>…</button>`
      // with body markup stays the counted snippet. So does any attribute
      // besides `parameters` carrying an island.
      if (!tag.selfClose) return null;
      // determinism-allow: a yes/no test over every attribute; order cannot reach output
      if (Object.entries(attrs).some(([name, value]) => name !== 'parameters' && value.includes('<%'))) return null;
      const fnName = attrs['functionname'] ?? '';
      const key = fnName.toLowerCase();
      const fn = app.functions.find((f) => f.name.toLowerCase() === key);
      // Unknown or untranslated app functions stay counted. Read-only calls
      // use the client-call catalog; a writing call must have a write grant
      // the generated endpoint can preflight.
      const writeCall = calls.names.has(key) ? undefined : buttonCalls.get(key);
      if (!fn || (!calls.names.has(key) && !writeCall?.writes.size)) return null;
      const declared = rawFnParams(fn.signature);
      const declaredTypes = fnSignatureParams(fn.signature);
      const parts = splitButtonArgs(attrs['parameters'] ?? '');
      if (!parts) return null;
      const args: FnButtonArg[] = [];
      for (const part of parts) {
        if (!part.trim() && parts.length === 1) continue;
        const arg = buttonArg(part, pageParams, !!writeCall, declaredTypes[args.length]?.type ?? '');
        if (!arg) return null;
        args.push(arg);
      }
      // The endpoint itself refuses more args than the signature declares; a
      // button that would always fail is a manual step instead.
      if (args.length > declared.length) return null;
      const msg = (attrs['successmsg'] ?? '').trim();
      if (!emitted.has(key)) {
        emitted.add(key);
        files.push({
          path: `functions/custom/${functionSlug(fn.name)}-call.mjs`,
          source: functionCallModule({
            app,
            name: fn.name,
            signature: fn.signature,
            params: declared,
            reads: [...(calls.reads.get(key) ?? writeCall?.reads ?? [])],
            writes: [...(writeCall?.writes ?? new Map<string, 'insert' | 'update' | 'delete'>())].map(([form, op]) => ({ form, op })),
            schema,
          }),
        });
      }
      // A self-closing ZML button carries its label in `text`.
      if (writeCall) {
        const argAttrs = args
          .map((arg, i) => {
            const value = arg.kind === 'c' ? `j:${JSON.stringify(arg.value)}` : arg.kind === 'p' ? `p:${arg.name}` : `${fnArgType(arg.type)}:<%=${arg.expr}%>`;
            return ` data-fn-arg-${i}="${arg.kind === 'r' ? value : escapeHtml(value)}"`;
          })
          .join('');
        return `<button type="button" data-fn-call="/functions/${functionSlug(fn.name)}/call" data-fn-argc="${args.length}"${argAttrs}${msg ? ` data-fn-msg="${escapeHtml(msg)}"` : ''} data-fn-refresh="true">${escapeHtml(attrs['text'] ?? '')}</button>`;
      }
      const encoded = args
        .map((arg) => (arg.kind === 'c' ? `c=${encodeURIComponent(JSON.stringify(arg.value))}` : arg.kind === 'p' ? `p=${encodeURIComponent(arg.name)}` : `r=${encodeURIComponent(arg.expr)}`))
        .join('&');
      return `<button type="button" data-fn-call="/functions/${functionSlug(fn.name)}/call"${encoded ? ` data-fn-args="${escapeHtml(encoded)}"` : ''}${msg ? ` data-fn-msg="${escapeHtml(msg)}"` : ''}>${escapeHtml(attrs['text'] ?? '')}</button>`;
    })();
    if (rewritten === null) continue;
    out += template.slice(at, start) + rewritten;
    at = tag.end;
  }
  return out + template.slice(at);
}

function isZcParam(param: string): boolean {
  const [key] = param.split('=');
  const k = key.trim().toLowerCase();
  return k.startsWith('zc_') || k.startsWith('zc');
}

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pre-pass for compileHtmlpage: rewrites `<iframe>` embeds of own reports
 * (`<%=zoho.appuri%>report-embed/<Report>`) to allowlisted static `<a>` links.
 * `page-embed` iframes are handled by `inlinePageEmbeds` instead: a provable
 * one becomes an inline include marker, anything else keeps the snippet
 * counted.
 * Non-matching or unsafe iframes (external URLs, dynamic names/islands,
 * unallowlisted query parameters) remain unchanged so the compiler refuses them.
 */
function rewriteEmbedIframes(template: string, app: App): string {
  if (!template.includes('report-embed')) {
    return template;
  }
  const IFRAME_RE = /<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>(?:[\s\S]*?<\/iframe>)?)/gi;
  return template.replace(IFRAME_RE, (match, attrText) => {
    const attrs = parseZmlAttributes(attrText);
    const src = attrs.src;
    if (!src) return match;
    const m = /^<%=\s*zoho\.appuri\s*%>(report-embed)\/([^?#]+)(?:\?([^#]*))?$/i.exec(src.trim());
    if (!m) return match;
    const rawName = m[2];
    if (rawName.includes('<%')) return match;
    const rawQuery = m[3] ?? '';
    if (rawQuery.includes('<%')) return match;
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      name = rawName;
    }
    const queryParts = rawQuery ? rawQuery.replace(/&amp;/g, '&').split('&').filter(Boolean) : [];
    const rep = app.reports.find((r) => r.name === name);
    if (!rep) return match;
    for (const part of queryParts) {
      if (!isZcParam(part)) return match;
    }
    const label = rep.displayName || rep.name;
    const href = `#/report/${encodeURIComponent(name)}`;
    return `<a href="${href}">${escapeHtml(label)}</a>`;
  });
}

/**
 * Compile a decoded `htmlpage` template into a generated endpoint plus the
 * sanitized static shell. Returns `{ ok: false }` for anything outside the
 * handled classes; the caller keeps the same manual TODO as before.
 */
export function compileHtmlpage(
  app: App,
  page: string,
  elementName: string,
  decoded: string,
  opts: { id?: string; schema?: SchemaPlan } = {},
): HtmlpageCompiled {
  const fail = (reason: string): HtmlpageCompiled => ({ ok: false, reason });
  const head = splitTemplate(decoded);
  head.template = rewriteRecordSummaryFrames(head.template, app);
  head.template = convertZmlSnippetToHtml(head.template);
  head.template = rewriteEmbedIframes(head.template, app);
  const fnFiles: HtmlpageFile[] = [];
  if (hasExecuteFunctionButton(head.template)) {
    head.template = rewriteExecuteFunctionButtons(head.template, app, new Set(head.params), fnFiles, opts.schema);
    if (hasExecuteFunctionButton(head.template)) return fail(EXECUTE_FUNCTION_BUTTON);
  }
  // A template that already writes the include marker could name a page the
  // compiler never checked: it stays the counted snippet.
  if (head.template.toLowerCase().includes(PAGE_INCLUDE_PREFIX)) return fail('marker collision');
  const embeds = inlinePageEmbeds(head.template, app, page);
  head.template = embeds.template;
  const includes = embeds.includes;
  if (head.template.toLowerCase().includes('component-form:') || head.template.toLowerCase().includes('component-report:')) return fail('marker collision');
  const embedded = embeddedComponents(head.template, app);
  head.template = embedded.template;
  const withIncludes = (done: HtmlpageCompiled): HtmlpageCompiled => {
    // Every include must survive sanitization where it stood; a marker the
    // allowlist removed would be an embed that silently vanished.
    const html = done.html ?? '';
    for (const name of includes) if (!html.includes(`data-zml="${PAGE_INCLUDE_PREFIX}${name}"`)) return fail('page embed did not survive markup sanitization');
    for (const marker of embedded.markers) if (!html.includes(`data-zml="${marker}"`)) return fail('component embed did not survive markup sanitization');
    return { ...done, ...(includes.length ? { includes } : {}), ...(embedded.components.length ? { components: embedded.components } : {}), ...(embedded.todos.length ? { componentTodos: embedded.todos } : {}) };
  };
  const chunks = splitChunks(head.template);
  if (!chunks) return fail('malformed Deluge island');
  const rawIslands = chunks.filter((c) => c.kind !== 'static');
  if (!rawIslands.length) {
    if (!includes.length && !embedded.components.length && !fnFiles.length) return fail('no Deluge islands');
    // The embed's appuri island or a generated component marker was the only
    // dynamic construct: the rest is static markup. A snippet that is static
    // markup plus wired function-call buttons needs no render endpoint; the
    // runtime wires `data-fn-call` clicks on the shell.
    const staticMarkup = chunks.map((c) => c.text).join('');
    if (droppedStyles(staticMarkup, false).length) return fail('static markup contains a dropped style declaration');
    return withIncludes({ ok: true, staticOnly: true, html: sanitizeSnippet(staticMarkup), ...(fnFiles.length ? { files: fnFiles } : {}) });
  }
  // Legacy exports sometimes wrap entirely static markup in an empty
  // statement block. Parse every statement island before accepting this path:
  // comments and whitespace have no AST nodes, while any real statement keeps
  // the existing server-side translation/TODO behavior.
  if (
    rawIslands.every((island) => island.kind === 'stmts') &&
    rawIslands.every((island) => {
      try {
        return parse(island.text).body.length === 0;
      } catch {
        return false;
      }
    })
  ) {
    const staticMarkup = chunks
      .filter((c) => c.kind === 'static')
      .map((c) => c.text)
      .join('');
    if (droppedStyles(staticMarkup, false).length) return fail('static markup contains a dropped style declaration');
    const droppedTags: string[] = [];
    const html = sanitizeSnippet(staticMarkup, undefined, droppedTags);
    return withIncludes({
      ok: true,
      staticOnly: true,
      html,
      ...(droppedTags.length ? { droppedTags } : {}),
      ...(fnFiles.length ? { files: fnFiles } : {}),
    });
  }
  if (MARK_CHECK.test(head.template) || /\bc2c_(out|parts|static|str|esc|link|notes|css)\b/i.test(head.template))
    return fail('marker collision');

  // Context for every island, from the static markup that precedes it.
  {
    let prefix = '';
    for (const chunk of chunks) {
      if (chunk.kind === 'static') prefix += chunk.text;
      else {
        chunk.context = slotContext(prefix);
        prefix += 'x';
      }
    }
  }
  if (chunks.some((c) => c.context === 'reject')) return fail('island in an unsafe position');

  // Islands that parse as a lone expression print like `<%= %>` did.
  const islands = chunks.map((c, i) => ({ ...c, i })).filter((c) => c.kind !== 'static');
  for (const isl of islands) {
    if (isl.kind !== 'stmts') continue;
    try {
      const script = parse(isl.text.trim());
      const only = script.body.length === 1 ? script.body[0] : undefined;
      if (only && (only.kind === 'expr' || (only.kind === 'unknown' && only.reason === 'no-effect'))) isl.kind = 'expr';
    } catch {
      /* stays a statement island */
    }
  }

  // A quoted attribute value accepts an expression island only. A statement
  // island is written into the value, and an openUrl there becomes a link
  // between the quotes. The page stays the counted snippet.
  for (const isl of islands) {
    if (isl.kind !== 'expr' && isl.context !== 'text' && isl.context !== 'comment') return fail('island in an unsafe position');
  }

  // Marker-sanitize-split: sanitize the whole document once, then read which
  // island slots survived and where the static fragments landed.
  let combined = '';
  for (const chunk of chunks) combined += chunk.kind === 'static' ? chunk.text : marker(islandOrdinal(chunks, chunk));
  const nIslands = islands.length;
  const droppedTags: string[] = [];
  const sanitized = sanitizeSnippet(combined, undefined, droppedTags);
  MARK_SPLIT.lastIndex = 0;
  MARK_MATCH.lastIndex = 0;
  const pieces = sanitized.split(MARK_SPLIT);
  const surviving = [...sanitized.matchAll(MARK_MATCH)].map((m) => Number(m[1]));
  const cleanStatics: string[] = new Array(nIslands + 1).fill('');
  {
    const bounds = [...surviving, nIslands];
    for (let i = 0; i < pieces.length; i++) {
      const gap = Math.min(bounds[i] ?? nIslands, nIslands);
      cleanStatics[gap] += pieces[i];
    }
  }
  const survived = new Set(surviving);
  // An island whose marker the sanitizer removed sat in text or an attribute
  // the allowlist drops (a dropped tag, a refused attribute, a refused URL
  // scheme). Emitting nothing for it would compile a page that silently lost
  // a Deluge slot, so the whole template stays the counted snippet. Comment
  // islands are the documented exception: they produce no output by design.
  for (let i = 0; i < islands.length; i++) {
    if (islands[i].context !== 'comment' && !survived.has(i)) return fail('island in an unsafe position');
  }

  // Reassemble the Deluge script: static pushes, verbatim statement islands,
  // expr islands as escaped output parts, openUrl rewritten to link parts.
  // A URL attribute value may span islands and static fragments. Those pieces
  // are emitted as "V" (escaped island value) and "W" (literal static) parts
  // so the generated render joins them and applies the scheme rule to the
  // whole assembled value, not to each island alone.
  const scriptParts: string[] = ['c2c_out = List();'];
  for (const param of head.params) scriptParts.push(`${param} = input.${param};`);
  const URL_VALUE_OPEN = new RegExp(`([A-Za-z_:][\\w:.-]*)[${TAG_WS}]*=[${TAG_WS}]*("|')`, 'g');
  let inUrl = false;
  let urlQuote = '';
  const pushPart = (kind: string, i: number, text: string) => {
    scriptParts.push(`c2c_out.add({"k":"${kind}","v":${text === cleanStatics[i] ? `c2c_static_${i}` : JSON.stringify(text)}});`);
  };
  for (let i = 0; i <= islands.length; i++) {
    const isl = i < islands.length ? islands[i] : undefined;
    let rest = cleanStatics[i];
    // A static piece can hold the end of one attribute value and the start
    // of the next (`" ... href="`), so the region close runs first, then
    // this island's own opener inside the same piece.
    if (inUrl && rest) {
      const end = rest.indexOf(urlQuote);
      if (end < 0) {
        pushPart('W', i, rest);
        rest = '';
      } else {
        if (end > 0) pushPart('W', i, rest.slice(0, end));
        rest = rest.slice(end);
        inUrl = false;
      }
    }
    if (isl && isl.kind === 'expr' && isl.context === 'url' && survived.has(i) && !inUrl) {
      // The island opens a URL attribute value: the last `name="` of the
      // static before it starts the value, and any static tail after that
      // quote is the first piece of the value itself.
      URL_VALUE_OPEN.lastIndex = 0;
      let open: RegExpExecArray | null = null;
      for (let m = URL_VALUE_OPEN.exec(rest); m; m = URL_VALUE_OPEN.exec(rest)) open = m;
      if (!open || !URL_ATTRS.test(open[1])) return fail('url attribute boundary not found');
      urlQuote = open[2];
      const valueStart = open.index + open[0].length;
      const headText = rest.slice(0, valueStart);
      const tailText = rest.slice(valueStart);
      if (headText) pushPart('H', i, headText);
      if (tailText) pushPart('W', i, tailText);
      inUrl = true;
    } else if (rest) {
      pushPart('H', i, rest);
    }
    if (!isl) break;
    if (isl.context === 'comment') {
      // An island inside an HTML comment produces no output (drop it, with a note).
      scriptParts.push('c2c_out.add({"k":"D","v":0});');
    } else if (isl.kind === 'expr') {
      if (survived.has(i)) {
        const kind = isl.context === 'url' ? 'V' : isl.context === 'attr' ? 'A' : isl.context === 'style' ? 'C' : 'T';
        scriptParts.push(`c2c_out.add({"k":"${kind}","v":(${isl.text.trim()})});`);
      } else if (isl.context === 'style') {
        scriptParts.push('c2c_out.add({"k":"N","v":"a style island did not survive markup sanitization and rendered empty"});');
      } else {
        scriptParts.push('c2c_out.add({"k":"D","v":0});');
      }
    } else {
      // A statement island's output is spliced only at a surviving marker.
      // A marker the sanitizer removed (a dropped element swallowed it) has
      // no output position: the island stays the counted snippet rather than
      // appending its output at a later gap.
      if (!survived.has(i)) return fail('island in an unsafe position');
      const rewritten = rewriteOpenUrls(isl.text);
      if (rewritten === null) return fail('openUrl could not be rewritten');
      scriptParts.push(rewritten);
    }
  }
  const script = scriptParts.join('\n');

  let ast;
  try {
    ast = parse(script);
  } catch {
    return fail('Deluge islands do not parse');
  }
  const isShapeC = hasShapeCWrites(ast);
  // A write or external action on render (`insert into`, `update`, `sendmail`,
  // `invokeUrl`, ...) is never read-only, whatever else the island holds —
  // except the Shape C setup writes, which carry their own guard rules.
  if (!isShapeC && (hasEffectNode(ast.body) || boundFieldWrite(ast.body, new Set()))) {
    return fail('island is not a read-only render');
  }
  let shapeCGuard: ShapeCGuard | undefined;
  if (isShapeC) {
    shapeCGuard = isShapeCGuarded(ast);
    if (!shapeCGuard.ok) return fail('island writes are unguarded');
    if (!ast.body.every(shapeCStmtOk)) return fail('island outside the handled classes');
  } else {
    if (!ast.body.every(stmtOk)) return fail('island outside the handled classes');
  }

  let tr;
  try {
    tr = translateInApp(app, script);
  } catch {
    return fail('island translation failed');
  }
  // The endpoint runs only the server translation. A `client-*-uses-server`
  // todo is about the client projection of the same code (a client condition
  // or loop that would need a server read), which a server render never runs;
  // the server code itself is still refused below if it holds a shim.todo.
  const serverTodos = tr.todos.filter((t) => !CLIENT_PROJECTION_TODOS.has(t.construct));
  if (serverTodos.length || (tr.stats.todo > 0 && !tr.todos.length)) return fail('island needs manual translation');
  // The translator may also emit a client projection of the same code (slot
  // conditions, list pushes). Only a real client action — a UI effect the
  // endpoint cannot perform — is out of scope.
  if (/actions\.push\(/.test(tr.client)) return fail('island needs a client step');
  const server = tr.server;
  if (/shim\.todo\(/.test(server)) return fail('untranslated construct');
  // A rendered page only reads: value slots, one record field, a column,
  // the rows of a query, aggregates, and pure helpers. Any other shim call,
  // a functions.* call, an assignment through a fetched value, or an await
  // that is not one of those reads stays the same counted snippet.
  if (isShapeC) {
    if (!shapeCServerOk(server)) return fail('island is not an allowed write render');
  } else {
    if (!islandReadOnly(server)) return fail('island is not a read-only render');
  }

  const forms = [
    ...server.matchAll(/shim\.datastore\.(?:query|aggregate|insert|update)\(ctx, "([^"]+)"/g),
    ...server.matchAll(/compileCriteria\(ctx\.shim, "([^"]+)"/g),
  ].map((m) => m[1]);
  const id = opts.id ?? 's0';
  const path = `/htmlpages/${encodeURIComponent(page)}/${encodeURIComponent(id)}`;
  const file: HtmlpageFile = {
    path: `functions/htmlpages/${localSlug(page)}-${localSlug(id)}.mjs`,
    source: endpointModule({
      page,
      id,
      name: head.name || elementName,
      path,
      forms: [...new Set(forms)].sort(),
      adminProfiles: administratorProfiles(app),
      server,
      statics: cleanStatics,
      hasWrites: isShapeC,
      requireOwner: shapeCGuard?.requireOwner,
    }),
  };
  return withIncludes({ ok: true, html: cleanStatics.join(''), ...(droppedTags.length ? { droppedTags } : {}), src: path, file, ...(fnFiles.length ? { files: fnFiles } : {}) });
}

function islandOrdinal(chunks: Chunk[], target: Chunk): number {
  let n = -1;
  for (const c of chunks) {
    if (c.kind !== 'static') n++;
    if (c === target) return n;
  }
  return n;
}
