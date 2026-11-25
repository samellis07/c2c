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

import { htmlCommentRanges, inRanges } from './html-comments.js';
import type { App } from '../../core/src/ir.js';
import { lex } from '../../deluge/src/lexer.js';
import { parse } from '../../deluge/src/parser.js';
import type { Expr, Script, Stmt } from '../../deluge/src/ast.js';
import { administratorProfiles, multiLookupsOf, navRoutesSource, buttonCallFunctions, clientCallFunctions, fnSignatureParams, functionCallModule, functionRowBinding, functionScriptOptions, rawFnParams, slug as functionSlug, translateInApp, type ButtonFunctionCall, type ClientCallCatalog } from '../../deluge/src/generate.js';
import type { SchemaPlan } from '../../schema/src/generator.js';
import { withoutDecimalAudit } from '../../deluge/src/audit.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import { criteriaHasRelative, criteriaHasTodo } from '../../shims/src/criteria.js';
import { ALLOWED_ATTRS, ALLOWED_TAGS, DROPPED_TAGS, allowedAttr, droppedStyles, inlineConstantStyleCalls, sanitizeSnippet, STYLE_BRANCH_MARK_PREFIX, STYLE_VALUE_VAR_PREFIX, styleBranchId, styleBranchMarkers, styleValues, styleValueUnit } from './pages.js';
import { toolchainBannerLines } from '../../core/src/toolchain.js';
import { c2cUrlFunctionSource, flatUrl } from './url-policy.js';
import { c2cImageFunctionSource, c2cMarkupFunctionSource } from './markup-value.js';
import { allStmts, markupFlow, thisappPath } from './markup-flow.js';
import { fileFieldsFor } from '../../deluge/src/field-store.js';
import { hasShapeCWrites, hasUnguardedRecordWrite, isShapeCGuarded, shapeCStmtOk, shapeCServerOk, type ShapeCGuard } from './htmlpage-shape-c.js';
import { displayRefs, displayTerms } from './decorations/lookups.js';
import { INTERNAL_RECORD_SUMMARY, MARKUP_LITERAL, islandCode, recordSummaryIdShape, serverSnippetGuidance, type SnippetReason } from './snippet-guidance.js';

export interface HtmlpageFile {
  path: string;
  source: string;
}

export interface HtmlpageCompiled {
  ok: boolean;
  manualReasons?: SnippetReason[];
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
  /** Popups the render itself opens, under a condition only it can decide (the lifter carries the rest). */
  popupMarks?: { target: 'form' | 'report'; name: string }[];
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
  /** A `<% %>` island that parses as one bare expression, printed like `<%= %>`. */
  wasStmts?: boolean;
  /** Where the island sits in the markup. */
  context?: 'text' | 'attr' | 'url' | 'style' | 'style-fn' | 'unwrapped' | 'sheet' | 'cssbody' | 'comment' | 'reject';
}

// A word marker stands for an island in text or an attribute. An island in a
// CSS function argument (`rgb(<%=n%>,...)`) is a number marker instead: the
// style sanitizer only keeps numbers there, so the marker is one.
const MARK_SPLIT = /ZZC2CSLOT\d+ZZ|0\.7391\d{4}/g;
const MARK_MATCH = /ZZC2CSLOT(\d+)ZZ|0\.7391(\d{4})/g;
const MARK_CHECK = /ZZC2CSLOT\d+ZZ|0\.7391\d{4}/;

function marker(i: number, numeric = false): string {
  return numeric ? `0.7391${String(i).padStart(4, '0')}` : `ZZC2CSLOT${i}ZZ`;
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

/**
 * Text-level elements the sanitizer unwraps (they are neither allowed nor
 * dropped), keeping their children. Text under one of these is text of the
 * element they sit in, so an expression island there renders its escaped value
 * in place. The list is closed: an unlisted tag keeps the island refused, and
 * every island must still survive sanitization where it stood.
 */
const UNWRAPPED_TEXT_TAGS = new Set([
  'center', 'time', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'label', 'address',
  'details', 'summary', 'cite', 'dfn', 'bdi', 'bdo', 'data', 'big', 'tt', 'strike', 'nobr', 'output',
]);

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
function slotContext(prefix: string): 'text' | 'attr' | 'url' | 'style' | 'style-fn' | 'unwrapped' | 'sheet' | 'cssbody' | 'comment' | 'reject' {
  let mode: SlotMode = 'data';
  let tag = '';
  let name = '';
  let quotedName = '';
  let valueStart = 0;
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
          valueStart = i + 1;
          mode = 'value-dq';
        } else if (c === "'") {
          quotedName = name;
          valueStart = i + 1;
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
    if (/^style$/i.test(quotedName)) {
      // Inside the parentheses of a CSS function the island is an argument.
      let depth = 0;
      for (const ch of prefix.slice(valueStart)) depth = ch === '(' ? depth + 1 : ch === ')' ? Math.max(0, depth - 1) : depth;
      return depth > 0 ? 'style-fn' : 'style';
    }
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
    // Text of a `<style>` element: the sanitizer removes the element, so an
    // expression island there has no output position. It is dropped like a
    // comment island, and the page's dropped-CSS manual step counts the loss.
    // Text of a `<script>` element: the sanitizer removes it the same way, and the
    // page's dropped-markup step already lists `<script>`.
    if (t === 'style') return 'cssbody';
    if (t === 'script') return 'sheet';
    // An expression island under an unwrapped text-level tag renders its
    // escaped value in place; a statement island there stays refused.
    if (UNWRAPPED_TEXT_TAGS.has(t)) return 'unwrapped';
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

// Per the HTML5 tokenizer's "after attribute value (quoted)" state, a
// character right after a quoted value's closing quote starts a new
// attribute even with no separating whitespace (a parse-error the browser,
// and Creator's own renderer, still recovers from). The lookbehind on a
// closing quote covers that recovery; every other position still needs
// whitespace, so an unquoted value still cannot glue straight into the next
// attribute name.
const IFRAME_ATTR = `(?:[${TAG_WS}]+|(?<=["']))[A-Za-z_:][\\w:.-]*(?:[${TAG_WS}]*=[${TAG_WS}]*(?:"[^"<]*"|'[^'<]*'|[^${TAG_WS}"'=<>\`%]+))?`;
const IFRAME_OPEN = new RegExp(`^<iframe(?:${IFRAME_ATTR})*?(?:[${TAG_WS}]+|(?<=["']))src[${TAG_WS}]*=[${TAG_WS}]*(["'])$`, 'i');
const APPURI_ISLAND = /<%=[ \t]*zoho[ \t]*\.[ \t]*appuri[ \t]*%>/gi;

/** A forwarded page parameter: exactly one `<%=input.<name>%>` island. */
const FORWARD_ISLAND = /^<%=[ \t]*input[ \t]*\.[ \t]*([A-Za-z_]\w*)[ \t]*%>$/;
/** Literal include parameter values: no delimiter, quote, percent escape, scheme colon or slash. */
const LITERAL_PARAM = /^[A-Za-z0-9_.-]{0,64}$/;
/**
 * A value the server render supplies: exactly one `<%=read%>` island holding a
 * bare read (`a.b.c`, optional `.toLong()`/`.toString()`), the grammar of an
 * embed parameter value. The island is encoded into the marker at render time.
 */
const SUPPLIED_READ = '[A-Za-z_]\\w*(?:[ \\t]*\\.[ \\t]*[A-Za-z_]\\w*)*(?:[ \\t]*\\.[ \\t]*(?:toLong|toString)[ \\t]*\\([ \\t]*\\))?';
const SUPPLIED_ISLAND_SOURCE = `<%=[ \\t]*${SUPPLIED_READ}[ \\t]*%>`;
const SUPPLIED_ISLAND = new RegExp(`^<%=[ \\t]*(${SUPPLIED_READ})[ \\t]*%>$`);
/** Grammar of one include parameter in a declared spec: `key=@param` (forward), `key=*` (supplied by the render) or `key=literal`. */
export const INCLUDE_PARAM = /^[A-Za-z_]\w*=(?:@[A-Za-z_]\w*|\*|[A-Za-z0-9_.-]{0,64})$/;
const INCLUDE_RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The include parameters of an embed query, or null when any part cannot be
 * proven safe. Names must be parameters the target page declares (matched
 * case-insensitively, emitted under the declared spelling) and appear once;
 * a value is a bounded literal or one `<%=input.p%>` island forwarding a
 * parameter the embedding page declares. `zc_*` display flags are dropped.
 * Percent escapes, entities, nested islands, other expressions and unknown
 * names all refuse, so the iframe stays a counted snippet. A caller that
 * passes `omit` (a hand-written page link) leaves an undeclared name out of
 * the link instead: Creator hands a page only the parameters it declares, so
 * the page could not read that value there either.
 */
function includeParams(query: string, target: readonly string[], own: ReadonlySet<string>, undeclared: 'refuse' | 'omit' = 'refuse', supplied?: string[]): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const raw = part.slice(eq + 1);
    if (!/^[A-Za-z_]\w*$/.test(key)) return null;
    const matches = target.filter((name) => name.toLowerCase() === key.toLowerCase());
    if (matches.length === 0 && /^zc_\w+$/i.test(key)) {
      // Undeclared display flags are harmless only when their value is a
      // bounded literal. An island or other expression must keep the embed
      // counted so it is not silently dropped.
      if (!LITERAL_PARAM.test(raw)) return null;
      continue;
    }
    if (matches.length > 1 || (matches.length === 0 && undeclared === 'refuse')) return null;
    const name = matches[0] ?? key;
    if (INCLUDE_RESERVED.has(key.toLowerCase())) return null;
    if (seen.has(name.toLowerCase())) return null;
    seen.add(name.toLowerCase());
    const forward = FORWARD_ISLAND.exec(raw);
    if (matches.length === 0) {
      // A key the target page does not declare, which `omit` leaves out of the link: its value must
      // still be a bounded literal or a parameter of this page, so nothing odd is dropped unseen.
      if (forward ? !own.has(forward[1]) || INCLUDE_RESERVED.has(forward[1].toLowerCase()) : !LITERAL_PARAM.test(raw)) return null;
      continue;
    }
    const read = supplied && !forward ? SUPPLIED_ISLAND.exec(raw)?.[1].replace(/[ \t]/g, '') : undefined;
    if (forward) {
      if (INCLUDE_RESERVED.has(forward[1].toLowerCase())) return null;
      if (!own.has(forward[1])) return null;
      out.push(`${name}=@${forward[1]}`);
    } else if (read && supplied) {
      const segments = read.split('.');
      if (segments.some((segment) => INCLUDE_RESERVED.has(segment.toLowerCase()))) return null;
      // A page input must be a parameter this snippet declares.
      if (segments[0] === 'input' && (segments.length < 2 || !own.has(segments[1]))) return null;
      supplied.push(read);
      out.push(`${name}=*`);
    } else if (LITERAL_PARAM.test(raw)) {
      out.push(`${name}=${raw}`);
    } else {
      return null;
    }
  }
  return out;
}

/**
 * A literal `href="<%=zoho.appuri%>#Page:<Page>?..."` link to another page of
 * the same app, written by hand instead of through an iframe embed. Creator's
 * own page parameters have no declared type: `input.<name>` is always the raw
 * query string, read with whatever cast the snippet applies, so there is
 * nothing here to type-check against — only the same name/value grammar
 * {@link includeParams} already proves for an embed query. Each value is
 * carried into the generated link's query as a bounded literal, unchanged, or
 * as `encodeUrl(input.<p>)` forwarding one of this page's own parameters, or
 * as `encodeUrl(<read>)` of a bare read the render supplies (a fetched
 * record's `.ID`), percent-encoded so a hostile value can never widen the query past the one
 * key it is bound to. A name the target page does not declare is left out of
 * the link, and a page the app does not have keeps its route. Anything
 * `includeParams` cannot prove — a repeated parameter name, an expression other
 * than a bare forwarded `input.p`, path traversal, a non-`#Page:` target —
 * leaves the href untouched and the snippet stays the counted TODO.
 */
// Creator also emits same-app page links as a bare `#Page:` fragment (the
// appuri island is optional in hand-authored markup). Both forms are scoped
// to the generated app route below; no arbitrary URL is accepted here.
const PAGE_HREF = /^(?:(?:https?:\/\/[^"'<>#?]*)?<%=[ \t]*zoho[ \t]*\.[ \t]*appuri[ \t]*%>)?#Page:([A-Za-z_]\w*)(?:\?([^"']*))?$/i;

function rewritePageParamLinks(template: string, app: App, page: string, ownParams: ReadonlySet<string>): string {
  if (!/#Page:/i.test(template)) return template;
  return replaceAnchorElements(template, (whole, attrs, inner) => {
    const hrefMatch = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
    if (!hrefMatch) return whole;
    const m = PAGE_HREF.exec(hrefMatch[2].trim());
    if (!m) return whole;
    const name = m[1]!;
    // A page this app does not have declares nothing; the link keeps its route and Creator shows the same missing page.
    const matches = app.pages.filter((item) => item.name === name || (name !== item.name && linkNameKey(item.name) === linkNameKey(name)));
    const target = matches.find((item) => item.name === name) ?? (matches.length === 1 ? matches[0] : undefined);
    if (matches.length > 1 && !target) return whole;
    const supplied: string[] = [];
    const params = includeParams(m[2] ?? '', target?.params ?? [], ownParams, 'omit', supplied);
    // The caller's identity (`zoho.loginuser`) never rides a page link; only a record value or a page parameter does.
    if (params === null || supplied.some((read) => /^zoho\b/i.test(read))) return whole;
    const query = params
      .map((p) => {
        const eq = p.indexOf('=');
        const key = p.slice(0, eq);
        const value = p.slice(eq + 1);
        if (value === '*') return `${key}=<%=encodeUrl(${supplied.shift()})%>`;
        return value.startsWith('@') ? `${key}=<%=encodeUrl(input.${value.slice(1)})%>` : `${key}=${value}`;
      })
      .join('&amp;');
    const href = `#/page/${encodeURIComponent(target?.name ?? name)}${query ? `?${query}` : ''}`;
    const nextAttrs = attrs.slice(0, hrefMatch.index) + `href=${hrefMatch[1]}${href}${hrefMatch[1]}` + attrs.slice(hrefMatch.index + hrefMatch[0].length);
    return `<a${nextAttrs}>${inner}</a>`;
  });
}

/**
 * A literal `<iframe src="<%=zoho.appuri%>page-embed/<Page>">` (or the older
 * `view-embed/<Page>` spelling) of another page
 * of this app becomes an inline include of that page's generated view. Creator
 * draws the named page inside the frame [UNVERIFIED]; `zc_*` query keys are
 * Creator display flags (header, footer) [UNVERIFIED] with no view effect
 * here, so they may stay. Other query parameters pass only through
 * `includeParams`: names the target page declares, bounded literal values or
 * a forwarded parameter of this page. The included page's snippets receive
 * them as their page input, exactly what a user could put in that page's own
 * URL, so their server routes re-check the caller per record and a parameter
 * never widens a read. Anything else is left as written, and the iframe
 * keeps the snippet counted: an unknown page, the page embedding itself, an
 * undeclared or repeated parameter, an encoded or expression value, an island
 * elsewhere in the URL or the tag, frame content, or a position that is not
 * plain text (a comment, a raw-text or dropped element).
 */
function inlinePageEmbeds(template: string, app: App, page: string, ownParams: ReadonlySet<string> = new Set()): { template: string; includes: string[]; markers: string[] } {
  const includes: string[] = [];
  const markers: string[] = [];
  const pages = new Map(app.pages.map((item) => [item.name, item]));
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
      `^(?:page-embed|view-embed)/([A-Za-z_]\\w*)(?:\\?((?:[^"'<>%${TAG_WS}]|${SUPPLIED_ISLAND_SOURCE})*))?${quote}(?:${IFRAME_ATTR})*[${TAG_WS}]*>[${TAG_WS}]*</iframe[${TAG_WS}]*>`,
      'i',
    ).exec(rest);
    if (!tail) continue;
    const name = tail[1];
    const query = tail[2] ?? '';
    const target = pages.get(name);
    if (!target || name === page) continue;
    const supplied: string[] = [];
    const params = includeParams(query, target.params ?? [], ownParams, 'refuse', supplied);
    if (!params) continue;
    // The tag must open in a text position of an element the sanitizer keeps.
    const before = out + template.slice(at, at + start);
    const pieces = splitChunks(before);
    if (!pieces) continue;
    if (slotContext(pieces.map((c) => (c.kind === 'static' ? c.text : 'x')).join('')) !== 'text') continue;
    const spec = params.length ? `${name}?${params.join(',')}` : name;
    // The declaration keeps `key=*`; the marker carries the value the render computes, form-encoded.
    const marker = spec.replace(/=\*(?=,|$)/g, () => `=<%=encodeUrl(${supplied.shift()})%>`);
    out = `${before}<div data-zml="${PAGE_INCLUDE_PREFIX}${marker}"></div>`;
    at = m.index + m[0].length + tail[0].length;
    APPURI_ISLAND.lastIndex = at;
    if (!includes.includes(spec)) includes.push(spec);
    // The static shell carries the marker without the values the render supplies.
    markers.push(marker.replace(/<%=[^%]*%>/g, ''));
  }
  return { template: out + template.slice(at), includes, markers };
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

interface EmbeddedComponent { kind: 'form' | 'report'; name: string; /** Field keys the marker carries as encoded query values. */ params?: string[] }

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
const COMPONENT_FLAGS: Record<string, { kinds: readonly string[]; values: readonly string[]; hide?: string }> = {
  zc_header: { kinds: ['form', 'report'], values: ['true', 'false'] },
  // Creator's secondary header toggle has no separate Catalyst rendering;
  // accepting it preserves an otherwise renderable generated embed.
  zc_secheader: { kinds: ['form', 'report'], values: ['true', 'false'] },
  zc_focus: { kinds: ['form'], values: ['false'] },
  zc_succmsg: { kinds: ['form'], values: ['data added successfully!'] },
  zc_submitval: { kinds: ['form'], values: ['submit'] },
  zc_resetval: { kinds: ['form'], values: ['reset'] },
  // A report's controls. `false` hides the control the generated report draws
  // (the marker carries the name, the page hides it); `true` is the default.
  // A flag whose control the generated report never draws needs nothing.
  zc_footer: { kinds: ['report'], values: ['true', 'false'], hide: 'pages' },
  zc_paging: { kinds: ['report'], values: ['true', 'false'], hide: 'pages' },
  zc_addrec: { kinds: ['report'], values: ['true', 'false'], hide: 'add' },
  zc_editrec: { kinds: ['report'], values: ['true', 'false'], hide: 'edit' },
  zc_delrec: { kinds: ['report'], values: ['true', 'false'], hide: 'delete' },
  zc_editbulkrec: { kinds: ['report'], values: ['true', 'false'], hide: 'bulk' },
  zc_recselect: { kinds: ['report'], values: ['true', 'false'], hide: 'select' },
  zc_filter: { kinds: ['report'], values: ['true', 'false'], hide: 'filter' },
  zc_search: { kinds: ['report'], values: ['true', 'false'], hide: 'search' },
  zc_duplrec: { kinds: ['report'], values: ['true', 'false'] },
  zc_sumrow: { kinds: ['report'], values: ['true', 'false'] },
  zc_colmenu: { kinds: ['report'], values: ['true', 'false'] },
  zc_summary: { kinds: ['report'], values: ['true', 'false'] },
  zc_saverec: { kinds: ['report'], values: ['true', 'false'] },
};

/** An island of an embed tag, held as a token until its tag attributes are parsed. */
const SLOT_TOKEN = /^\u0001(\d+)\u0001$/;
/**
 * The only islands an embed parameter may carry: one bare read, `a.b.c`, a
 * page input `input.p` (checked against the page's own parameters), or either
 * with a closing `.toLong()` / `.toString()`. Calls with arguments, operators,
 * indexes and quotes keep the snippet counted.
 */
const PARAM_READ = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\.(?:toLong|toString)\(\))?$/;
// Creator snippets commonly pre-encode a value before placing it in a
// component's params attribute. The generated route performs the same
// form/query encoding, so prove the wrapper and carry its bounded read.
const PARAM_ENCODED_READ = /^zoho\.encryption\.urlEncode\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\)$/i;
const PARAM_RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** One key of an embed's `params` that fills a field: a bounded literal or a bare read evaluated at render. */
interface ComponentParam {
  key: string;
  value: { literal: string } | { read: string } | { pieces: ({ read: string } | { literal: string })[] };
}

/** The field keys a parameterised embed may name: top-level fields of the form (or the report's form). */
interface EmbedLookup {
  name: string;
  /** `Lookup.Target`: set only when one stored target field holds the display text. */
  path?: string;
  /** Set when the text the report shows is composed from stored fields of the target form: the key is `Lookup:display`. */
  display?: true;
}

function embedForm(app: App, kind: string, name: string) {
  return kind === 'form' ? app.forms.find((item) => item.name === name) : app.forms.find((item) => item.name === app.reports.find((report) => report.name === name)?.form);
}

function embedFieldNames(app: App, kind: string, name: string): string[] {
  // A lookup column stores the target row's id, while a page value is display text: a filter or prefill by name would never match.
  return (embedForm(app, kind, name)?.fields ?? []).filter((field) => field.subfields.length === 0 && !field.lookup && !/^(?:section|subform|grid|add notes)$/i.test(field.type ?? '')).map((field) => field.name);
}

/**
 * The lookup fields of an embedded form or report's form, by name, with the
 * target field that holds the display text. A report filters such a field by
 * that text on the lookup path (`Lookup.Target`), which the report endpoint
 * resolves under the caller's read grants on both forms. A lookup whose text
 * is not exactly one stored target field (a composite, a literal around the
 * field, several fields) has no single value to compare and carries no path.
 */
function embedLookupFields(app: App, kind: string, name: string): EmbedLookup[] {
  const out: EmbedLookup[] = [];
  for (const field of embedForm(app, kind, name)?.fields ?? []) {
    const lookup = field.lookup;
    if (!lookup) continue;
    const terms = lookup.displayFormat ? displayTerms(lookup.displayFormat) : [];
    const shown = terms.length === 0 ? lookup.field : terms.length === 1 && 'ref' in terms[0] ? terms[0].ref : undefined;
    const target = shown && field.subfields.length === 0 ? app.forms.find((item) => item.name === lookup.form)?.fields.find((item) => item.name === shown) : undefined;
    const path = target && target.subfields.length === 0 && !target.lookup ? `${field.name}.${target.name}` : undefined;
    out.push({ name: field.name, ...(path ? { path } : displayComposable(app, field) ? { display: true as const } : {}) });
  }
  return out;
}

/** The last field a bare read names, without a closing `.toLong()` / `.toString()`. */
function lastReadName(read: string): string {
  return read.trim().replace(/\.(?:toLong|toString)\(\)$/, '').split('.').pop() ?? '';
}

/**
 * A `Lookup:display` param whose one bare read names a stored field the
 * lookup's text composes from several fields (`record.Case_Number` for a
 * "number - title" text)
 * filters on that field of the target (`Lookup.Field`), the way a single-field
 * display does. Any other value is compared with the whole text.
 */
function shownFieldKeys(app: App, kind: string, name: string, params: ComponentParam[]): ComponentParam[] {
  return params.map((param) => {
    if (!param.key.endsWith(':display') || !('read' in param.value)) return param;
    const head = param.key.slice(0, -':display'.length);
    const lookup = embedForm(app, kind, name)?.fields.find((field) => field.name === head)?.lookup;
    const target = lookup ? app.forms.find((item) => item.name === lookup.form) : undefined;
    const read = lastReadName(param.value.read).toLowerCase();
    const refs = lookup?.displayFormat ? displayRefs(lookup.displayFormat) : [];
    const shown = refs.length > 1 ? refs.find((ref) => ref.toLowerCase() === read) : undefined;
    const stored = target?.fields.find((field) => field.name === shown);
    return stored && stored.subfields.length === 0 && !stored.lookup ? { ...param, key: `${head}.${stored.name}` } : param;
  });
}

/**
 * True when a lookup's displayed text is built only from literals and stored
 * fields of its target form (a name composite's part, a plain field): the
 * report endpoint composes the same text from the parent rows it may read, so
 * a filter value can be compared with it. A ref the target form lacks, a
 * lookup of a lookup or no target form leaves the key counted.
 */
function displayComposable(app: App, field: { subfields: readonly unknown[]; lookup?: { form: string; field?: string; displayFormat?: string } }): boolean {
  const lookup = field.lookup;
  const parent = lookup ? app.forms.find((item) => item.name === lookup.form) : undefined;
  if (!lookup || !parent || field.subfields.length > 0) return false;
  const terms = lookup.displayFormat ? displayTerms(lookup.displayFormat) : [];
  const refs = terms.flatMap((term) => ('ref' in term ? [term.ref] : []));
  if (refs.length === 0) return false;
  return refs.every((ref) => {
    const top = parent.fields.find((item) => item.name === ref.split('.')[0]);
    return !!top && !top.lookup && (ref.includes('.') ? top.subfields.some((part) => part.name === ref.split('.')[1]) : top.subfields.length === 0);
  });
}

/**
 * The embed's applicable params, or null when any one cannot be applied. A key
 * that is not a display flag must name a field of the embedded form (or the
 * report's form), once, with a bounded literal or one bare read as its value:
 * the value reaches the embed only as an encoded query value the runtime
 * applies as the form prefill or the report filter. A form prefill key that
 * names no field fills nothing, so it is left out once its value is checked.
 */
function componentParams(
  raw: string,
  kind: string,
  name: string,
  fields: readonly string[] = [],
  slots: readonly string[] = [],
  own: ReadonlySet<string> = new Set(),
  lookups: readonly EmbedLookup[] = [],
): { untitled: boolean; hidden: string[]; params: ComponentParam[] } | null {
  // A reference without its `;` still reads as `&` where an `&` follows, as the browser reads an attribute value.
  const text = raw.replace(/&amp;|&amp(?=&)/gi, '&').trim();
  if (!text) return { untitled: false, hidden: [], params: [] };
  let untitled = false;
  const hidden = new Set<string>();
  const seenFlags = new Set<string>();
  const params: ComponentParam[] = [];
  const seenKeys = new Set<string>();
  // One island of a value: a bare read of a record field or a declared page input, checked the same way wherever it stands.
  const readOf = (slot: string): string | null => {
    const found = SLOT_TOKEN.exec(slot);
    const text = found ? (slots[Number(found[1])] ?? '').trim() : '';
    // The generated route encodes a value once, so a wrapper that encodes it first is carried as the bare read.
    const read = PARAM_ENCODED_READ.exec(text)?.[1] ?? text;
    if (!PARAM_READ.test(read)) return null;
    const segments = read.split('.');
    if (segments.some((segment) => PARAM_RESERVED.has(segment.toLowerCase()))) return null;
    // A page input must be a parameter this snippet declares.
    if (segments[0] === 'input' && (segments.length < 2 || !own.has(segments[1]))) return null;
    return read;
  };
  for (const part of text.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    // A lone island with no `=` names a key and gives it no value: it filters or fills nothing, but its read was checked.
    if (eq < 0) {
      if (SLOT_TOKEN.test(part.trim()) && readOf(part.trim()) !== null) continue;
      return null;
    }
    const rawKey = part.slice(0, eq).trim();
    const key = rawKey.toLowerCase();
    const rawValue = part.slice(eq + 1).trim();
    const value = rawValue.toLowerCase();
    // Creator repeats the embed's own link name inside `params`; naming the
    // same view again changes nothing, naming another one is not provable.
    if (ZC_LINK.test(key) && value === name.toLowerCase()) continue;
    const flag = Object.prototype.hasOwnProperty.call(COMPONENT_FLAGS, key) ? COMPONENT_FLAGS[key] : undefined;
    if (flag) {
      if (!flag.kinds.includes(kind) || !flag.values.includes(value) || seenFlags.has(key)) return null;
      seenFlags.add(key);
      if (key === 'zc_header') untitled = value === 'false';
      if (flag.hide && value === 'false') hidden.add(flag.hide);
      continue;
    }
    if (!/^[A-Za-z_]\w*$/.test(rawKey) || PARAM_RESERVED.has(key) || /^zc_/i.test(rawKey)) return null;
    const matches = fields.filter((field) => field.toLowerCase() === key);
    const looked = lookups.filter((lookup) => lookup.name.toLowerCase() === key);
    const slot = SLOT_TOKEN.exec(rawValue);
    // A form prefill of a lookup would have to pick the option whose label is the text, and a label can name several rows.
    // The caller's own page input is no such text: Creator hands the URL value to the lookup as it came, a row id, and
    // the prefill sets the select to the option with that value, so the input passes through unchanged.
    const idPass = kind === 'form' && looked.length === 1 && slot !== null && /^input\.[A-Za-z_]\w*$/.test((slots[Number(slot[1])] ?? '').trim());
    if (looked.length && !idPass && (kind === 'form' || (!looked[0].path && !looked[0].display))) return null;
    // A report filter on a key that is no field would show more records than Creator does; a form prefill of one fills nothing.
    if (matches.length + looked.length > 1 || (matches.length + looked.length === 0 && kind !== 'form') || seenKeys.has(key)) return null;
    seenKeys.add(key);
    const outKey = matches[0] ?? (idPass ? looked[0].name : looked[0]?.path) ?? (looked[0]?.display ? `${looked[0].name}:display` : undefined);
    if (slot) {
      const read = readOf(rawValue);
      if (read === null) return null;
      // A key that names no field of the form fills nothing, but its value was checked all the same.
      if (outKey) params.push({ key: outKey, value: { read } });
    } else if (rawValue.includes('\u0001')) {
      // Islands joined by an encoded space: one text, the way a person's first and last name are written.
      const pieces: ({ read: string } | { literal: string })[] = [];
      for (const piece of rawValue.split(/(\u0001\d+\u0001|%20)/).filter(Boolean)) {
        if (piece === '%20') pieces.push({ literal: piece });
        else {
          const read = readOf(piece);
          if (read === null) return null;
          pieces.push({ read });
        }
      }
      if (outKey) params.push({ key: outKey, value: { pieces } });
    } else if (LITERAL_PARAM.test(rawValue)) {
      if (outKey) params.push({ key: outKey, value: { literal: rawValue } });
    } else {
      return null;
    }
  }
  return { untitled, hidden: [...hidden].sort(), params };
}

/** A param value as marker text: literals as written, each read encoded when the page renders. */
function valueMarker(value: ComponentParam['value']): string {
  if ('literal' in value) return value.literal;
  if ('read' in value) return `<%=encodeUrl(${value.read})%>`;
  return value.pieces.map((piece) => valueMarker(piece)).join('');
}

/**
 * The string literals a name is assigned across a template's statement islands, in sorted order, or null when
 * any other binding could reach it (a non-literal or compound assignment, a loop variable of that name, a script
 * that does not parse) or it is never assigned.
 */
function literalChoices(template: string, name: string): string[] | null {
  const chunks = splitChunks(template);
  if (!chunks) return null;
  let script: Script;
  try {
    script = parse(chunks.filter((c) => c.kind === 'stmts').map((c) => c.text).join('\n'));
  } catch {
    return null;
  }
  const values = new Set<string>();
  let clean = true;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const rec = node as Record<string, unknown>;
    const target = rec.target as { kind?: string; name?: string } | undefined;
    if (rec.kind === 'assign' && target?.kind === 'name' && target.name?.toLowerCase() === name.toLowerCase()) {
      const value = rec.value as { kind?: string; value?: string };
      if (rec.op === '=' && value.kind === 'string' && typeof value.value === 'string') values.add(value.value);
      else clean = false;
    }
    if (rec.kind === 'forEach' && typeof rec.name === 'string' && rec.name.toLowerCase() === name.toLowerCase()) clean = false;
    for (const key of Object.keys(rec).sort()) if (key !== 'span') visit(rec[key]);
  };
  visit(script.body);
  return clean && values.size > 0 ? [...values].sort() : null;
}

/**
 * A name set once to `zoho.encryption.urlEncode(<bounded read>);` and printed
 * as a value in a zc-component `params` attribute. Creator wrote the encoded
 * value into the query itself; the generated marker encodes the one value it
 * carries, so the parameter takes the wrapper back in the place the name stood
 * and {@link componentParams} proves the bounded read. The name and its root
 * must be assigned once in the render code, so the read cannot have changed
 * between the statement and the embed. Uses outside `params` keep the name.
 */
const ENCODED_VARIABLE =
  /(^|[;{}\r\n])[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*(zoho\.encryption\.urlEncode\([ \t]*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]*\))[ \t]*;/g;

function inlineEncodedParamVariables(template: string): string {
  if (!/\belname\s*=\s*['"]zc-component['"]/i.test(template)) return template;
  const code = islandCode(template);
  const assigned = (name: string): number => [...code.matchAll(new RegExp(`(?<![\\w.])${name}[ \\t]*=(?!=)`, 'g'))].length;
  const encoded = new Map<string, string>();
  for (const match of template.matchAll(ENCODED_VARIABLE)) {
    const [, , name, call, read] = match as unknown as [string, string, string, string, string];
    const root = read.split('.')[0]!;
    if (assigned(name) === 1 && (root === 'input' || assigned(root) === 1)) encoded.set(name, call);
  }
  if (!encoded.size) return template;
  return template.replace(/<div\b(?:<%=?[^%<>]*%>|[^>])*>/gi, (tag) => {
    if (!/\belname\s*=\s*['"]zc-component['"]/i.test(tag)) return tag;
    return tag.replace(/(\bparams\s*=\s*)(["'])([^"']*)\2/i, (whole, head: string, quote: string, value: string) =>
      `${head}${quote}${value.replace(/<%=[ \t]*([A-Za-z_]\w*)[ \t]*%>/g, (island, name: string) => (encoded.has(name) ? `<%=${encoded.get(name)}%>` : island))}${quote}`,
    );
  });
}

/**
 * A tag with each `<%= read %>` island replaced by a numbered token, and the
 * island bodies in token order. Match the whole island body, then trim spaces
 * and tabs in a linear pass (a regex with optional blanks on both sides of a
 * lazy body backtracks polynomially on long runs of tabs).
 */
function tokenizeIslands(tag: string): { tokenized: string; slots: string[] } {
  const slots: string[] = [];
  const tokenized = tag.replace(/<%=([^%<>'"\\\u0001]*)%>/g, (_m, read: string) => `\u0001${slots.push(trimSpaceTab(read)) - 1}\u0001`);
  return { tokenized, slots };
}

/**
 * Creator zc-component divs can name a generated form/report [UNVERIFIED]. Only a literal
 * link name whose params are all applicable display flags is provable; other embeds stay TODOs.
 */
function embeddedComponents(
  template: string,
  app: App,
  own: ReadonlySet<string> = new Set(),
): { template: string; components: EmbeddedComponent[]; markers: string[]; todos: { target: string; step?: string }[] } {
  const components: EmbeddedComponent[] = [];
  const markers: string[] = [];
  const todos: { target: string; step?: string }[] = [];
  const embed = (tag: string, slots: readonly string[]): string | null => {
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
    const written = linkEntry?.[1] ?? '';
    // Creator link names compare case-insensitively; embed the generated component under its own name.
    const pool = kind === 'form' ? app.forms : kind === 'report' ? app.reports : [];
    const folded = pool.filter((item) => item.name.toLowerCase() === written.toLowerCase());
    const name = pool.some((item) => item.name === written) || folded.length !== 1 ? written : folded[0].name;
    const target = linkEntry ? `${kind || linkEntry[0].replace(/linkname$/i, '').toLowerCase()} "${written}"` : 'component';
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
    // A token outside `params` is an island in another attribute: not an embed.
    if (slots.length && attrKeys.some((key) => key !== 'params' && (attrs.get(key) ?? '').includes('\u0001'))) return null;
    const params = rawParams === undefined ? { untitled: false, hidden: [], params: [] } : known ? componentParams(rawParams, kind, name, embedFieldNames(app, kind, name), slots, own, embedLookupFields(app, kind, name)) : null;
    if (known && !hostile && params) {
      const applied = shownFieldKeys(app, kind, name, params.params);
      const keys = applied.map((item) => item.key);
      const component: EmbeddedComponent = { kind: kind as 'form' | 'report', name, ...(keys.length ? { params: keys } : {}) };
      components.push(component);
      const query = applied.map((item) => `${item.key}=${valueMarker(item.value)}`).join('&');
      const marker = `component-${component.kind}:${component.name}${params.untitled ? COMPONENT_UNTITLED : ''}${params.hidden.length ? `:hide-${params.hidden.join('-')}` : ''}${query ? `?${query}` : ''}`;
      markers.push(marker.replace(/<%=[^%]*%>/g, ''));
      if (!slots.length) return tag.replace(/>$/, ` data-zml="${marker}">`);
      // The tag is rebuilt from its parsed attributes: the island-carrying
      // `params` and the link attributes are replaced by the marker.
      const kept = attrKeys
        .filter((key) => key !== 'params' && key !== 'elname' && !ZC_LINK.test(key))
        .map((key) => ` ${key}="${(attrs.get(key) ?? '').replace(/"/g, '&quot;')}"`)
        .join('');
      return `<div${kept} data-zml="${marker}">`;
    }
    todos.push({ target });
    return tag;
  };
  // An embed whose link name is one name the script only ever sets to literals is written once per literal under an
  // `if` on that name, so each branch is a plain embed of a known component. Any branch the embed cannot prove keeps
  // the tag as it was, and the embed stays a TODO.
  const choiceTag = /<div\b((?:[^<>%]|<%=[^%<>]*%>)*)>([^<>%]*)<\/div[ \t\r\n]*>/gi;
  const choiceLink = /\b(?:form|view|report)linkname[ \t\r\n]*=[ \t\r\n]*(["'])<%=[ \t]*([A-Za-z_]\w*)[ \t]*%>\1/i;
  // A tag the HTML parser reads inside a comment is inert: it is no embed, so it neither generates a view nor counts.
  const commented = htmlCommentRanges(template);
  const chosen = template.replace(choiceTag, (whole: string, inner: string, body: string, offset: number) => {
    if (inRanges(commented, offset)) return whole;
    const link = choiceLink.exec(inner);
    if (!link || !ZC_COMPONENT_ELNAME.test(inner)) return whole;
    // What else the tag carries as islands is read once, as a plain embed reads it: `embed` accepts them in `params` only.
    const { tokenized, slots } = tokenizeIslands(inner.replace(link[0], '\u0002'));
    if (tokenized.includes('<%') || tokenized.includes('%>')) return whole;
    const values = literalChoices(template, link[2]);
    if (!values) return whole;
    const before = { components: components.length, markers: markers.length, todos: todos.length };
    const branches = values.map((value) => {
      const open = `<div${tokenized.replace('\u0002', link[0].replace(/<%=[^%]*%>/, value))}>`;
      return { value, open: embed(open, slots), literal: open };
    });
    if (todos.length !== before.todos || branches.some((branch) => branch.open === null || branch.open === branch.literal)) {
      components.length = before.components;
      markers.length = before.markers;
      todos.length = before.todos;
      return whole;
    }
    const arms = branches.map((branch) => `if (${link[2]} == ${JSON.stringify(branch.value)}) { %>${branch.open}${body}</div><% }`);
    return `<% ${arms.join(' else ')} %>`;
  });
  // A tag whose attributes hold `<%= %>` islands is matched whole; its islands
  // become tokens while the attributes are read and only a bare-read value in
  // `params` is ever written back.
  const commentedNow = chosen === template ? commented : htmlCommentRanges(chosen);
  const rewritten = chosen.replace(/<div\b(?:<%=?[^%<>]*%>|[^>])*>/gi, (tag, offset: number) => {
    if (inRanges(commentedNow, offset)) return tag;
    if (!tag.includes('<%')) return embed(tag, []) ?? tag;
    const { tokenized, slots } = tokenizeIslands(tag);
    // What the tokenizer cannot read keeps the old reading of the tag: cut at
    // the first `>`, which may still count as an unparsed component.
    const legacy = () => {
      embed(tag.slice(0, tag.indexOf('>') + 1), []);
      return tag;
    };
    if (tokenized.includes('<%') || tokenized.includes('%>') || !/\belname\s*=\s*['"]zc-component['"]/i.test(tokenized)) return legacy();
    const done = embed(tokenized, slots);
    return done === null ? legacy() : done === tokenized ? tag : done;
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

/** A call statement of a function in a group: `thisapp.Group.name();`, alone in its statement. */
const SETUP_CALL = /(^|[;{}\n])([ \t]*)thisapp[ \t]*\.[ \t]*([A-Za-z_]\w*)[ \t]*\.[ \t]*([A-Za-z_]\w*)[ \t]*\([ \t]*\)[ \t]*;/g;

/**
 * The names a function body binds: assignment targets and loop variables, in
 * sorted order.
 */
function boundNames(node: unknown, out: Set<string> = new Set()): string[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) {
    for (const item of node) boundNames(item, out);
  } else {
    const rec = node as Record<string, unknown>;
    const target = rec.target as { kind?: string; name?: string } | undefined;
    if (rec.kind === 'assign' && target?.kind === 'name' && typeof target.name === 'string') out.add(target.name.toLowerCase());
    if (rec.kind === 'forEach') {
      for (const key of ['name', 'index']) if (typeof rec[key] === 'string') out.add((rec[key] as string).toLowerCase());
    }
    for (const key of Object.keys(rec).sort()) if (key !== 'span') boundNames(rec[key], out);
  }
  return [...out].sort();
}

/**
 * A `thisapp.Group.name();` statement that calls a void function with no
 * parameters stands for that function's body: Creator runs the body in place,
 * so the statements are written where the call stood and the snippet's own
 * checks (the setup-write guards among them) judge them there. The body must
 * read nothing of the page (`input`), call no further function and return
 * nothing, and none of the names it binds may occur anywhere in the snippet,
 * so it can neither read nor overwrite a value of the page.
 */
function inlineSetupCalls(template: string, app: App): string {
  if (!/\bthisapp\b/i.test(template)) return template;
  const chunks = splitChunks(template);
  if (!chunks) return template;
  const body = (path: string[]): string | null => {
    const fn = appFunction(app, path);
    if (!fn || functionRowBinding(fn) || fn.deluge.length !== 1 || !/^\s*void\s+[A-Za-z_][\w.]*\s*\(\s*\)\s*$/i.test(fn.signature ?? '')) return null;
    const text = fn.deluge[0]!.text;
    if (/\b(?:thisapp|input|return)\b/i.test(text)) return null;
    let names: string[];
    try {
      names = boundNames(parse(text).body);
    } catch {
      return null;
    }
    return names.some((name) => !/^\w+$/.test(name) || new RegExp(`\\b${name}\\b`, 'i').test(template)) ? null : text.trim();
  };
  let changed = false;
  const out = chunks.map((chunk) => {
    if (chunk.kind !== 'stmts') return chunk;
    const text = chunk.text.replace(SETUP_CALL, (whole: string, lead: string, indent: string, group: string, name: string) => {
      const inlined = body([group, name]);
      if (inlined === null) return whole;
      changed = true;
      return `${lead}${indent}${inlined}`;
    });
    return { ...chunk, text };
  });
  if (!changed) return template;
  return out.map((chunk) => (chunk.kind === 'static' ? chunk.text : chunk.kind === 'expr' ? `<%=${chunk.text}%>` : `<%${chunk.text}%>`)).join('');
}

const ALLOWED_STMTS = new Set(['block', 'if', 'assign', 'expr', 'forEach', 'break', 'continue', 'try', 'info']);
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

/** The statements of a function body, or none when it does not parse. */
function parseOrNothing(text: string): Stmt[] {
  try {
    return parse(text).body;
  } catch {
    return [];
  }
}

/** True when any statement in the tree is an `if`. */
function hasIfNode(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasIfNode);
  const rec = node as Record<string, unknown>;
  if (rec.kind === 'if') return true;
  for (const key of Object.keys(rec).sort()) {
    if (key !== 'span' && hasIfNode(rec[key])) return true;
  }
  return false;
}

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
  // `rows.get(0).X`: a call on the binding yields its element, so the chain continues through the callee.
  while (cur.kind === 'member' || cur.kind === 'index' || cur.kind === 'paren' || cur.kind === 'call') {
    cur = cur.kind === 'paren' ? cur.expr : cur.kind === 'call' ? cur.callee : cur.object;
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

/** `inLoop`: a `break` or `continue` is only a render-loop control inside a `for each`. */
function stmtOk(s: Stmt, inLoop = false): boolean {
  if (!ALLOWED_STMTS.has(s.kind)) return false;
  switch (s.kind) {
    case 'block':
      return s.body.every((inner) => stmtOk(inner, inLoop));
    case 'if':
      return (
        exprOk(s.test) &&
        stmtOk(s.then, inLoop) &&
        s.elifs.every((elif) => exprOk(elif.test) && stmtOk(elif.body, inLoop)) &&
        (!s.else || stmtOk(s.else, inLoop))
      );
    case 'assign':
      // `Form[criteria].Field = x` writes that record. It is not a read.
      return exprOk(s.target) && exprOk(s.value) && !assignsCriteriaField(s.target);
    case 'expr':
      return exprOk(s.expr);
    case 'info':
      // `info x` writes x to the Deluge log; the translation emits nothing, so a render has no effect to check.
      return exprOk(s.value);
    case 'forEach':
      return exprOk(s.collection) && stmtOk(s.body, true);
    case 'break':
    case 'continue':
      return inLoop;
    case 'try':
      return stmtOk(s.body, inLoop) && (!s.catchBody || stmtOk(s.catchBody, inLoop));
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
 * `openUrl(...)` statements inside an island. A popup-window target naming a
 * form or report becomes a popup mark in the output ({@link settlePopups}
 * decides which ones the snippet popup lifter already carries); any other
 * popup, or one of a computed address, becomes a rendered link part like
 * every other openUrl, so the user opens it with a click.
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
    // A form or report named outright rides the render as a popup mark; whether the page keeps it is settled once the whole script is known.
    const named = /popup/i.test(target) ? /^(["'])#(Form|Report):([A-Za-z_]\w*)(?:[?&][^"']*)?\1$/i.exec(args[0] ?? '') : null;
    if (named) {
      edits.push({ start: t.start, end: stmtEnd, text: `c2c_out.add({"k":"P","v":"${named[2]!.toLowerCase()}:${named[3]}"});` });
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

/** The popup a `c2c_out.add({"k":"P","v":"form:Name"})` statement marks, or null for any other statement. */
function popupMark(stmt: Stmt): { target: 'form' | 'report'; name: string } | null {
  if (stmt.kind !== 'expr' || stmt.expr.kind !== 'call' || stmt.expr.args.length !== 1) return null;
  const callee = stmt.expr.callee;
  const arg = stmt.expr.args[0]!;
  if (callee.kind !== 'member' || callee.property !== 'add' || callee.object.kind !== 'name' || callee.object.name !== 'c2c_out' || arg.kind !== 'map') return null;
  const entry = (key: string) => {
    const found = arg.entries.find((item) => item.key.kind === 'string' && item.key.value === key);
    return found && found.value.kind === 'string' ? found.value.value : null;
  };
  const value = /^(form|report):([A-Za-z_]\w*)$/.exec(entry('v') ?? '');
  return entry('k') === 'P' && value ? { target: value[1] as 'form' | 'report', name: value[2]! } : null;
}

/**
 * The popup marks of a script, each with the statements around it. The lifter
 * carries the two shapes it can state: a mark nothing encloses (always) and a
 * mark alone under `if (rows.count() == 0)` (empty). Every other mark sits
 * under a condition only this render can decide, so it stays in the script and
 * prints a marker where it runs. Returns the script without the marks the
 * lifter carries, and the marks that stay.
 */
function settlePopups(script: string, ast: Script): { script: string; marks: { target: 'form' | 'report'; name: string }[] } {
  const lifted: Stmt[] = [];
  const marks: { target: 'form' | 'report'; name: string }[] = [];
  const countsZero = (test: Expr): boolean => {
    while (test.kind === 'paren') test = test.expr;
    if (test.kind !== 'binary' || test.op !== '==' || test.right.kind !== 'number' || Number(test.right.text) !== 0) return false;
    const left = test.left;
    return left.kind === 'call' && left.args.length === 0 && left.callee.kind === 'member' && left.callee.property.toLowerCase() === 'count' && left.callee.object.kind === 'name';
  };
  const visit = (stmt: Stmt, around: Stmt[], plain: boolean): void => {
    const mark = popupMark(stmt);
    if (mark) {
      const lone = around.filter((item) => item.kind !== 'block');
      if (plain && (lone.length === 0 || (lone.length === 1 && lone[0]!.kind === 'if' && countsZero(lone[0]!.test)))) lifted.push(stmt);
      else marks.push(mark);
      return;
    }
    const inner = [...around, stmt];
    switch (stmt.kind) {
      case 'block':
        for (const child of stmt.body) visit(child, inner, plain);
        break;
      case 'if':
        visit(stmt.then, inner, plain);
        for (const elif of stmt.elifs) visit(elif.body, inner, false);
        if (stmt.else) visit(stmt.else, inner, false);
        break;
      case 'forEach':
      case 'while':
        visit(stmt.body, inner, false);
        break;
      case 'try':
        visit(stmt.body, inner, false);
        if (stmt.catchBody) visit(stmt.catchBody, inner, false);
        break;
      default:
        break;
    }
  };
  for (const stmt of ast.body) visit(stmt, [], true);
  let out = script;
  for (const stmt of [...lifted].sort((a, b) => b.span.start - a.span.start)) {
    const end = out[stmt.span.end] === ';' ? stmt.span.end + 1 : stmt.span.end;
    out = out.slice(0, stmt.span.start) + out.slice(end);
  }
  return { script: out, marks };
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
export function renderAuditSource(options: { dataImages?: boolean } = {}): string {
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
${options.dataImages ? '  if (tag === "img" && attr === "src" && C2C_MK_IMAGE_SRC.test(value)) return true;\n' : ''}  if (C2C_AUDIT_URLS.test(attr) && !c2cUrlOk(value)) return false;
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

/**
 * `c2cRoute` and `c2cHref` in a generated page endpoint: a link target written
 * the Creator way (`#Page:Name?x=1`, with or without the app's address in
 * front) as this app's own route. The route comes from `shim.nav.resolve`, the
 * navigation an `openUrl` in a workflow already takes, so a page link means one
 * thing everywhere; a page parameter the target does not declare is left out,
 * because Creator hands a page only the parameters it declares. A Creator route
 * that names nothing this app has gets no target (the stale Creator address is
 * never kept); any other target must be a web or mail address the page's URL
 * policy admits.
 */
function routeSource(routes: string): string {
  return `const C2C_ROUTES = ${routes};

function c2cRoute(shim, text) {
  const nav = shim.nav.resolve({ kind: "navigate", url: String(text), target: "same" }, C2C_ROUTES, { ignoreUndeclared: true });
  return nav && nav.kind === "navigate" && /^#\\/(?:form|report|page)\\//.test(nav.url) ? nav.url : "";
}

function c2cHref(shim, text) {
  const raw = String(text == null ? "" : text).replace(/&amp;/g, "&").trim();
  const route = c2cRoute(shim, raw);
  if (route) return route;
  if (/#(?:Form|Report|Page|View|Script):/i.test(raw)) return "";
  return /^(?:https?:\\/\\/|mailto:)/i.test(raw) && c2cUrlOk(raw) ? raw : "";
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
  /** The render calls `thisapp.<fn>()` functions proved read-only (readOnlyAppFunction). */
  appCalls?: boolean;
  /** The render prints a value that holds markup (`c2cMarkup`). */
  markup?: boolean;
  /** The render reads an image field as its `<img>` element (`c2cImage`). */
  images?: boolean;
  /** `navRoutesSource(app)`: the render resolves a link to one of this app's own routes through `shim.nav.resolve`. */
  routes?: string;
  /** form -> composite field -> its parts, for the forms the render reads: a stored row carries one column per part. */
  composites?: Record<string, Record<string, string[]>>;
  /** The render prints a popup marker where a popup mark runs. */
  popups?: boolean;
  /** form -> lookup field -> linked form, for the lookups whose linked-record fields a query compares. */
  lookupForms?: Record<string, Record<string, string>>;
  /** form -> lookup field -> the fields of the linked record the render reads through it. */
  lookupReads?: Record<string, Record<string, string[]>>;
  /** The junction tables of the multi lookups among them. */
  multiLookups?: ReturnType<typeof multiLookupsOf>;
}): string {
  const banner = `/**\n${[
    `htmlpage ${opts.name || opts.id} on page ${opts.page}: a server-side snippet compiled to ${opts.hasWrites ? 'an endpoint with setup writes' : 'a read-only endpoint'}.`,
    ...(opts.hasWrites ? ['Setup writes run only for an administrator profile (and the application owner under a zoho.adminuserid check); any other caller still gets the page, with those writes skipped.'] : []),
    `Advanced I/O POST ${opts.path}`,
    'Static markup was sanitized with the snippet allowlist at generation; every interpolated value is HTML-escaped',
    'for its context (text or attribute). The client sanitizes the response again before inserting it.',
    'Reads go through the runtime scopeRead (profile grants, record filters, hidden forms), like the report endpoints.',
    'Page input values are bound criteria/parameters only; nothing is concatenated into ZCQL.',
    ...(opts.appCalls ? ['thisapp.<fn>() calls dispatch through functions/thisapp.mjs; each callee was proved read-only at generation.'] : []),
    'openUrl actions in the template render as links; "popup window" targets stay lifted popup triggers.',
    'Dry run unless deploy mode is live (c2c-deploy.json or C2C_DEPLOY_MODE) and a datastore is configured.',
    ...toolchainBannerLines(),
  ]
    .map((line) => ` * ${line}`)
    .join('\n')}\n */\n`;
  // The render takes an environment when it reads files or runs setup writes.
  const env = opts.images || opts.hasWrites;
  const statics = opts.statics.map((s, i) => `const c2c_static_${i} = ${JSON.stringify(s)};`).join('\n');
  const indented = opts.server
    .split('\n')
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join('\n');
  return `${banner}import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, jsonReplacer, principalFromRequest, renderedDocumentViolation, renderedHtmlElements${opts.images ? ', signDownload' : ''} } from "creator-to-catalyst/shims";
${opts.appCalls ? 'import { functions } from "../thisapp.mjs";\n' : ''}
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
    if (v.constructor && v.constructor.name === "Decimal") return v.toString();
${opts.composites || opts.lookupReads ? '    // A composite (a name, an address) prints its non-empty parts joined by spaces; a linked record prints as its id.\n    if (Object.prototype.hasOwnProperty.call(v, "toString")) return v.toString();\n' : ''}    try {
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

// An island in a CSS function argument (rgb(<%=n%>,...)) renders one plain
// number: digits with an optional short fraction, at most 9999.999. Signs,
// exponents, units, words and every other character render empty.
function c2cCssNumber(v) {
  const text = String(v == null ? "" : v).trim();
  return /^\\d{1,4}(?:\\.\\d{1,3})?$/.test(text) ? text : "";
}

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
${opts.hasWrites ? `
// A caller that may not run the setup writes still gets the page: its write calls do nothing.
function c2cWithoutWrites(shim, notes) {
  const skip = async () => {
    const note = "a setup write was skipped because the caller may not run it";
    if (notes.indexOf(note) < 0) notes.push(note);
    return null;
  };
  return { ...shim, datastore: { ...shim.datastore, insert: skip, update: skip, setField: skip } };
}
` : ''}${opts.routes ? `\n${routeSource(opts.routes)}\n` : ''}${opts.markup ? `\n${c2cMarkupFunctionSource()}\n` : ''}${opts.images ? `\n${c2cImageFunctionSource()}\n` : ''}
${renderAuditSource({ dataImages: opts.markup })}

function c2cLink(url${opts.routes ? ', shim' : ''}) {
  const text = String(url || "").trim();
  let href = "";
  let label = text;
${opts.routes ? `  const route = c2cRoute(shim, text);
  const internal = route ? null : /^#(Form|Report):(.+)$/.exec(text);
  if (route) {
    href = route;
    label = decodeURIComponent(route.split("?")[0].split("/")[2]).replace(/_/g, " ");
  } else ` : '  const internal = /^#(Form|Report):(.+)$/.exec(text);\n  '}if (internal) {
    href = "#/" + internal[1].toLowerCase() + "/" + encodeURIComponent(internal[2]);
    label = internal[2].replace(/_/g, " ");
  } else if (/^https?:\\/\\//i.test(text)) {
    href = text;
  }
  if (!href) return "";
  return '<a href="' + c2cEsc(href) + '">' + c2cEsc(label) + "</a>";
}

async function render(ctx${env ? ', c2c_env' : ''}) {
  const shim = ${opts.hasWrites ? 'c2c_env.mayWrite ? ctx.shim : c2cWithoutWrites(ctx.shim, c2c_env.notes)' : 'ctx.shim'};
${indented}
  const c2c_parts = [];
  const c2c_notes = ${env ? 'c2c_env.notes' : '[]'};
  const c2c_vars = [];
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
${opts.popups ? '    else if (item.k === "P") c2c_parts.push(\'<div data-zml="popup-\' + c2cEsc(c2cStr(item.v)) + \'"></div>\');\n' : ''}    else if (item.k === "L") c2c_parts.push(c2cLink(c2cStr(item.v)${opts.routes ? ', shim' : ''}));${opts.markup ? '\n    else if (item.k === "M") c2c_parts.push(c2cMarkup(c2cStr(item.v), c2c_notes, (text) => c2cHref(shim, text)));' : ''}
    else if (item.k === "Q") {
      const piece = c2cStr(item.v);
      const num = c2cCssNumber(piece);
      if (!num && piece.trim()) c2c_notes.push("a style island value was not a safe number and rendered empty");
      c2c_parts.push(num);
    } else if (item.k === "S") {
      const piece = c2cStr(item.v);
      const num = c2cCssNumber(piece);
      if (num) c2c_vars.push(item.n + ":" + num + item.u);
      else if (piece.trim()) c2c_notes.push("a style island value was not a safe number and rendered empty");
    } else if (item.k === "C") {
      const piece = c2cStr(item.v);
      const css = c2cCss(piece);
      if (!css && piece.trim()) c2c_notes.push("a style island value was not a safe CSS value and rendered empty");
      c2c_parts.push(css);
    } else if (item.k === "N") c2c_notes.push(String(item.v == null ? "" : item.v));
  }
  c2c_urlFlush();
  const c2c_html = c2c_parts.join("");
  return { html: c2c_vars.length ? '<div style="display:contents;' + c2c_vars.join(";") + '">' + c2c_html + "</div>" : c2c_html, notes: c2c_notes };
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
${opts.hasWrites ? `  // The page renders for any caller the read policy admits; only an administrator profile
  // (and, under a zoho.adminuserid existence check, the application owner) may run its
  // setup writes. The owner id is deploy configuration (C2C_ADMIN_USER_ID), never a client value.
  const ownerId = String(process.env.C2C_ADMIN_USER_ID || "");
  const mayWrite = adminProfiles.includes(principal.profile)${opts.requireOwner ? ' && !!ownerId && String(principal.userId || "") === ownerId' : ''};
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
${opts.hasWrites ? '      adminUserId: mayWrite ? principal.userId || "" : ownerId,\n' : ''}${opts.appCalls ? '      functions,\n' : ''}${opts.composites ? `      composites: ${JSON.stringify(opts.composites)},\n` : ''}${opts.lookupForms ? `      lookupForms: ${JSON.stringify(opts.lookupForms)},\n` : ''}${opts.lookupReads ? `      lookupReads: ${JSON.stringify(opts.lookupReads)},\n` : ''}${opts.multiLookups && Object.keys(opts.multiLookups).length ? `      multiLookups: ${JSON.stringify(opts.multiLookups)},\n` : ''}      ...(datastore ? { datastore } : {}),
    });
    const ctx = runtime.context({ record: input, old: {}, principal, appTimeZone });
    const rendered = await render(ctx${env ? `, { ${[opts.images ? 'files: live ? await liveFileStore(req) : null, bytes: 0' : '', opts.hasWrites ? 'mayWrite' : '', 'notes: []'].filter(Boolean).join(', ')} }` : ''});
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
  // A typed empty list (`List:Int()`) is a local value; it reads and writes nothing.
  'list',
  // `info x` only notes x in the render transcript.
  'log.info',
  'get',
  'set',
  'datastore.query',
  'datastore.aggregate',
  'datastore.field',
  'datastore.column',
  'datastore.rows',
  'datastore.plainRows',
  'each',
  'input.get',
  'input.root',
  'input.set',
  'old.get',
  'zoho.currentDate',
  'zoho.currentTime',
  'zoho.loginUser',
  'zoho.loginUserId',
  'zoho.loginUserProfile',
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
  'list.numberList',
  'list.column',
  'list.distinct',
  'list.sort',
  'list.sortKey',
  'list.removeElement',
  'list.remove',
  'list.removeAll',
  'list.clear',
  'list.addAll',
  'list.intersect',
  'list.subList',
  'list.notContains',
  'list.duplicate',
  'list.insert',
  'list.insertAll',
  'list.putAll',
  'list.deleteKey',
  'list.deleteKeys',
  'list.getKey',
  'list.getLastKey',
  'isEmpty',
  'number.largest',
  'number.smallest',
  'number.nthLargest',
  'number.nthSmallest',
  'number.toHex',
  'number.toWords',
  'number.sin',
  'number.cos',
  'number.tan',
  'number.asin',
  'decimal.cmp',
  // Exact decimal arithmetic is pure: a running total over fetched rows.
  'decimal.from',
  'decimal.add',
  'decimal.sub',
  'decimal.mul',
  'decimal.div',
  'compare.eq',
  'compare.ne',
  'record.get',
  'record.system',
]);

const READ_ONLY_PREFIX = ['date.', 'string.', 'convert.', 'math.'];

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
  const mutation =
    /\bshim\.(?:list\.(?:add|addAll|sort|sortKey|clear|remove|removeAll|removeElement|intersect|subList|duplicate|insert|insertAll|putAll|deleteKey|deleteKeys|getKey|getLastKey)|set)\s*\(\s*/g;
  const directRead = /^(?:await\s+)?shim\.datastore\.(?:field|column|rows)\b/;
  const fetchedLocals = new Set<string>();
  // Generated assignments occupy their own line. Anchoring keeps the
  // `// Deluge: copy = rows` source comment from being mistaken for code.
  const assignment = /^\s*(?:var\s+|let\s+|const\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*);/gm;
  const events: Array<{ at: number; kind: 'assignment' | 'mutation'; match: RegExpMatchArray }> = [];

  for (const match of server.matchAll(assignment)) {
    // Apply an assignment after its RHS. This lets `rows = sort(rows)` see the
    // old fetched binding before the assignment replaces it.
    events.push({ at: (match.index ?? 0) + match[0].length, kind: 'assignment', match });
  }
  for (const match of server.matchAll(mutation)) events.push({ at: match.index ?? 0, kind: 'mutation', match });
  events.sort((a, b) => a.at - b.at || (a.kind === 'mutation' ? -1 : 1));

  for (const event of events) {
    const match = event.match;
    if (event.kind === 'assignment') {
      const local = match[1] ?? '';
      const rhs = (match[2] ?? '').trim();
      // A helper or conditional may return one of its arguments. Conservatively
      // carry taint through any RHS that consumes a fetched local; a later list
      // mutator proves that the result is collection-shaped.
      const usesFetchedLocal = [...rhs.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].some((part) => fetchedLocals.has(part[1] ?? ''));
      if (/\b(?:await\s+)?shim\.datastore\.(?:field|column|rows)\s*\(/.test(rhs) || usesFetchedLocal) {
        fetchedLocals.add(local);
      } else {
        fetchedLocals.delete(local);
      }
      continue;
    }
    const receiver = server.slice((match.index ?? 0) + match[0].length);
    if (directRead.test(receiver)) return true;
    const local = /^([A-Za-z_$][\w$]*)\b/.exec(receiver)?.[1];
    if (local !== undefined && fetchedLocals.has(local)) return true;
  }
  return false;
}

/** The literal dotted path of a translated `shim.thisapp.call(ctx, [...], ...)`, else null. */
export function appCallPath(rest: string): string[] | null {
  const m = /^ctx, (\[(?:"(?:[^"\\]|\\.)*"(?:, ?)?)+\])/.exec(rest);
  if (!m) return null;
  try {
    const path: unknown = JSON.parse(m[1] ?? '');
    return Array.isArray(path) && path.every((part) => typeof part === 'string' && /^[A-Za-z_]\w*$/.test(part)) ? (path as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * True when the call whose `(` is at `open` is `text.remove("literal")` over a text a string shim produced:
 * the removed text is written in the source, and the value is the whole result of a `shim.string.*` call, or a
 * name declared once as one. A date's text (`dt.toString()`, a datetime field) never reaches it, so the format the
 * shim writes it in cannot change what is removed.
 */
function removesLiteralFromText(server: string, open: number): boolean {
  const close = matchingParen(server, open);
  if (close < 0 || server[close - 1] !== '"') return false;
  let at = close - 2;
  while (at >= open) {
    if (server[at] === '"') {
      let slashes = 0;
      while (server[at - 1 - slashes] === '\\') slashes++;
      if (slashes % 2 === 0) break;
    }
    at--;
  }
  const comma = server.lastIndexOf(',', at);
  if (at <= open || comma <= open || !/^,[ \t]*$/.test(server.slice(comma, at))) return false;
  return isStringShimText(server, server.slice(open + 1, comma).trim());
}

/** A date or datetime shim call anywhere in an expression: a string shim wrapped around a date's text is still a date's text. */
const DATE_SHIM = /\bshim\.date\w*\./i;

/** The text of the first argument of the call whose `(` is at `open`, up to its top-level comma or `)`. */
function firstArgument(expr: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open + 1; i < expr.length; i++) {
    const ch = expr[i] ?? '';
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return expr.slice(open + 1, i).trim();
      depth--;
    } else if (ch === ',' && depth === 0) return expr.slice(open + 1, i).trim();
  }
  return '';
}

/**
 * A whole `shim.string.*(...)` call, or a name declared once as `var name = shim.string.*(...);` and assigned nowhere
 * else, whose text starts from the page input, a written literal or another such string shim. A name that holds a date's
 * text (or any other value) breaks the chain, so a string shim around it is no proof of a plain text.
 */
function isStringShimText(source: string, expr: string, depth = 0): boolean {
  if (depth > 8) return false;
  // The `// Deluge:` comment above each statement quotes the source and is no assignment.
  const server = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  if (expr.startsWith('shim.string.')) {
    const paren = expr.indexOf('(');
    if (paren < 0 || matchingParen(expr, paren) !== expr.length - 1 || DATE_SHIM.test(expr)) return false;
    const first = firstArgument(expr, paren);
    return first === 'input' || /^input\.\w+$/.test(first) || /^shim\.input\.get\(ctx, "\w+"\)$/.test(first) || /^"(?:[^"\\]|\\.)*"$/.test(first) || isStringShimText(source, first, depth + 1);
  }
  if (!/^[A-Za-z_]\w*$/.test(expr)) return false;
  const declaration = `var ${expr} = `;
  const at = server.indexOf(declaration);
  if (at < 0 || server.indexOf(declaration, at + 1) >= 0) return false;
  const initializer = server.slice(at + declaration.length);
  if (!initializer.startsWith('shim.string.')) return false;
  const close = matchingParen(initializer, initializer.indexOf('('));
  if (close < 0 || initializer[close + 1] !== ';') return false;
  if ((server.match(new RegExp(`(?<![\\w.$])${expr}\\s*[-+*/%]?=(?!=)`, 'g')) ?? []).length !== 1) return false;
  return isStringShimText(source, initializer.slice(0, close + 1), depth + 1);
}

/** The call a render makes to `zoho.encryption.urlEncode`, the one `zoho.task` that never leaves the process. */
const PURE_ZOHO_TASK = /^\s*ctx,\s*\["encryption",\s*"urlEncode"\]/;

/**
 * True when every shim call is read-only and every await is one of those calls.
 * A `thisapp.<fn>()` call is read-only only when `appCall` proves its callee.
 */
export function islandReadOnly(server: string, appCall?: (path: string[]) => boolean): boolean {
  if (/\bfunctions\./.test(server)) return false;
  for (const match of server.matchAll(/\bshim\.([A-Za-z_][\w.]*)\s*\(/g)) {
    const name = match[1] ?? '';
    if (name === 'thisapp.call' && appCall) {
      const path = appCallPath(server.slice((match.index ?? 0) + match[0].length));
      if (!path || !appCall(path)) return false;
      continue;
    }
    // `zoho.encryption.urlEncode` is a pure local adapter: the runtime answers it without a Zoho call.
    if (name === 'zoho.task' && PURE_ZOHO_TASK.test(server.slice((match.index ?? 0) + match[0].length))) continue;
    // `text.remove("literal")` over a string shim's text is a pure text edit.
    if (name === 'list.removeText' && removesLiteralFromText(server, (match.index ?? 0) + match[0].length - 1)) continue;
    if (!readOnlyShim(name)) return false;
  }
  if (assignsDatastoreRead(server) || mutatesFetchedRead(server)) return false;
  if (/\bawait\s+(?!shim\.)/.test(server)) return false;
  return true;
}

/** stmtOk for a function body: the same statement classes, plus `return`. */
function calleeStmtOk(s: Stmt): boolean {
  switch (s.kind) {
    case 'return':
      return !s.value || exprOk(s.value);
    case 'block':
      return s.body.every(calleeStmtOk);
    case 'if':
      return exprOk(s.test) && calleeStmtOk(s.then) && s.elifs.every((elif) => exprOk(elif.test) && calleeStmtOk(elif.body)) && (!s.else || calleeStmtOk(s.else));
    case 'forEach':
      return exprOk(s.collection) && calleeStmtOk(s.body);
    default:
      return stmtOk(s);
  }
}


/** Stratus-key columns of a form that Creator types as image: the fields whose value a page reads as an `<img>` element. */
function imageColumns(app: App, form: string): Set<string> {
  const images = new Set(app.forms.find((item) => item.name === form)?.fields.filter((field) => (field.type ?? '').trim().toLowerCase() === 'image').map((field) => field.name));
  return new Set(fileFieldsFor(app, form).filter((column) => images.has(column)));
}

/**
 * Translated render code with every `Form[criteria].Image` read of a fetched
 * record wrapped in `c2cImage`, which turns the stored key into the `<img>`
 * element Creator's value is. A name assigned from more than one form is not
 * rewritten, and `reads` counts the wrapped reads.
 */
function withImageReads(app: App, server: string): { server: string; reads: number } {
  const formOf = new Map<string, string | null>();
  for (const m of server.matchAll(/\bvar ([A-Za-z_$][\w$]*) = shim\.datastore\.query\(ctx, "([A-Za-z_]\w*)"/g)) {
    formOf.set(m[1]!, formOf.has(m[1]!) && formOf.get(m[1]!) !== m[2] ? null : m[2]!);
  }
  let reads = 0;
  const wrapped = server.replace(/await shim\.datastore\.field\(ctx, ([A-Za-z_$][\w$]*), "([A-Za-z_]\w*)"\)/g, (whole, name: string, field: string) => {
    const form = formOf.get(name);
    if (!form || !imageColumns(app, form).has(field)) return whole;
    reads++;
    return `await c2cImage(c2c_env, ${whole}, ${JSON.stringify(form)}, ${JSON.stringify(field)})`;
  });
  return { server: wrapped, reads };
}

/**
 * A render statement `thisapp.<fn>();` whose callee is a `void` function with
 * no parameters that does nothing but `insert into`. The call is that insert
 * written where it is called, so it meets the same guard rules as an inline
 * one (htmlpage-shape-c.ts) instead of reaching the function registry. Any
 * other call is left as written.
 */
function inlineInsertCalls(app: App, script: string, body: Stmt[]): string {
  let out = script;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const s of allStmts(body)) {
    if (s.kind !== 'expr' || s.expr.kind !== 'call' || s.expr.args.length > 0) continue;
    const path = thisappPath(s.expr.callee);
    const fn = path ? appFunction(app, path) : undefined;
    if (!fn || !/^\s*void\b/.test(fn.signature ?? '') || fnSignatureParams(fn.signature).length > 0) continue;
    const texts = fn.deluge.map((d) => d.text.trim()).filter(Boolean);
    const inserts = texts.length > 0 && texts.every((text) => onlyInserts(text));
    if (inserts) edits.push({ start: s.span.start, end: s.span.end, text: `${texts.join('\n').replace(/;\s*$/, '')};` });
  }
  for (const edit of edits.reverse()) out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  return out;
}

/** True when the Deluge text parses to `insert into` statements and nothing else. */
function onlyInserts(text: string): boolean {
  try {
    return parse(text).body.every((stmt) => stmt.kind === 'expr' && stmt.expr.kind === 'insert');
  } catch {
    return false;
  }
}

/** The app function a `thisapp.<fn>()` path names: the exact name, then the case-insensitive one the generated registry also resolves. */
function appFunction(app: App, path: string[]): App['functions'][number] | undefined {
  const name = path.join('.');
  return app.functions.find((item) => item.name === name) ?? app.functions.find((item) => item.name.toLowerCase() === name.toLowerCase());
}

/** True when the function's body holds a string literal with a tag, so what it returns is markup. */
function buildsMarkup(fn: App['functions'][number]): boolean {
  return fn.deluge.some((d) => MARKUP_LITERAL.test(d.text));
}

/**
 * A `thisapp.<fn>()` call a rendered page may make: the callee resolves the
 * way the generated registry does (exact name, then case-insensitive), is not
 * bound to a record, and its whole body passes the same read-only checks as
 * an island — no write or external action, only the handled statement
 * classes plus `return`, no manual translation, and read-only shim calls,
 * where a nested `thisapp` call is proved the same way. A call back into a
 * function whose proof is still running adds no effect of its own: its body is
 * the one being checked, and the registry's depth bound stops the recursion at
 * run time. A function with no `if` has no way to stop calling itself and
 * stays refused. A body that builds markup is refused too, unless `markupOk`: the
 * page prints a call's value as escaped text, so returned HTML would show as
 * tags. Each proved
 * callee's server code is pushed to `servers`, so its forms join the
 * endpoint's hidden-form check.
 *
 * `markupOk` admits a callee that builds markup: the caller assigns its value
 * to a name and the page prints that name through `c2cMarkup` (markup-flow.ts).
 */
function readOnlyAppFunction(app: App, path: string[], seen: ReadonlySet<string>, servers: string[], markupOk = false): boolean {
  const fn = appFunction(app, path);
  if (!fn || functionRowBinding(fn)) return false;
  if (seen.has(fn.name)) return fn.deluge.some((d) => hasIfNode(parseOrNothing(d.text)));
  if (!fn.deluge.some((d) => d.text.trim()) || (!markupOk && buildsMarkup(fn))) return false;
  const inner = new Set(seen).add(fn.name);
  let slot = 0;
  // A body that translates to no server code generates no registry entry.
  let emitted = false;
  for (const d of fn.deluge) {
    let body: Stmt[];
    try {
      body = parse(d.text).body;
    } catch {
      return false;
    }
    if (hasEffectNode(body) || boundFieldWrite(body, new Set()) || !body.every(calleeStmtOk)) return false;
    let tr: ReturnType<typeof translateInApp>;
    try {
      // A probe: the function's own module records its sites when it is generated.
      tr = withoutDecimalAudit(() => translateInApp(app, d.text, functionScriptOptions(app, fn, slot)));
    } catch {
      return false;
    }
    slot = tr.nextSlot;
    if (tr.todos.some((t) => !CLIENT_PROJECTION_TODOS.has(t.construct)) || (tr.stats.todo > 0 && !tr.todos.length)) return false;
    if (/shim\.todo\(/.test(tr.server)) return false;
    if (!islandReadOnly(tr.server, (callee) => readOnlyAppFunction(app, callee, inner, servers))) return false;
    servers.push(tr.server);
    if (tr.server.trim()) emitted = true;
  }
  return emitted;
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
  form?: string;
  /** Report link name of an icon `OpenReport` click. */
  report?: string;
  label?: string;
  element?: 'button';
}

const WINDOW_TARGETS = new Set([
  'popup',
  'popup window',
  'new-window',
  'new window',
  'same-window',
  'same window',
  '_blank',
  '_self',
]);

function getZmlAttr(attributes: Record<string, string> | undefined, keys: string[]): string | undefined {
  if (!attributes) return undefined;
  const byLower = new Map<string, string>();
  for (const key of Object.keys(attributes).sort()) {
    const lower = key.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, attributes[key]);
  }
  for (const key of keys) {
    const value = byLower.get(key.toLowerCase());
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

export function isFormAction(action: string, attributes?: Record<string, string>): boolean {
  const act = (action || '').trim().toLowerCase();
  if (act === 'form' || act === 'openform' || act.startsWith('#form:')) return true;
  if (/openUrl\s*\(\s*(?:&quot;|["'])#Form:/i.test(action || '')) return true;
  if (attributes) {
    const href = (getZmlAttr(attributes, ['url', 'href']) || '').toLowerCase();
    if (href.startsWith('#form:') || /openUrl\s*\(\s*(?:&quot;|["'])#Form:/i.test(href)) return true;
  }
  return false;
}

export function formActionTarget(action: string, attributes?: Record<string, string>): string | undefined {
  const act = (action || '').trim();
  const lower = act.toLowerCase();
  if (lower.startsWith('#form:')) {
    return act.slice(6).trim().split(/[?&,"') ]/)[0] || undefined;
  }
  const openUrlMatch = /openUrl\s*\(\s*(?:&quot;|["'])#Form:([A-Za-z_]\w*)/i.exec(act);
  if (openUrlMatch) return openUrlMatch[1];
  if (attributes) {
    const href = (getZmlAttr(attributes, ['url', 'href']) || '').trim();
    if (href.toLowerCase().startsWith('#form:')) {
      return href.slice(6).trim().split(/[?&,"') ]/)[0] || undefined;
    }
    const openUrlHref = /openUrl\s*\(\s*(?:&quot;|["'])#Form:([A-Za-z_]\w*)/i.exec(href);
    if (openUrlHref) return openUrlHref[1];
  }
  if (lower === 'form' || lower === 'openform') {
    if (attributes) {
      const explicit = getZmlAttr(attributes, ['componentLinkName', 'formLinkName', 'linkName', 'form', 'targetForm']);
      if (explicit) return explicit;
      const rawTarget = getZmlAttr(attributes, ['target']);
      if (rawTarget && !WINDOW_TARGETS.has(rawTarget.toLowerCase())) return rawTarget;
    }
  }
  return undefined;
}

export function isReportAction(action: string, attributes?: Record<string, string>): boolean {
  const act = (action || '').trim().toLowerCase().replace(/\s+/g, '');
  if (act === 'report' || act === 'openreport' || act.startsWith('#report:')) return true;
  if (/openUrl\s*\(\s*(?:&quot;|["'])#Report:/i.test(action || '')) return true;
  if (attributes) {
    const href = (getZmlAttr(attributes, ['url', 'href']) || '').toLowerCase();
    if (href.startsWith('#report:') || /openUrl\s*\(\s*(?:&quot;|["'])#Report:/i.test(href)) return true;
  }
  return false;
}

export function reportActionTarget(action: string, attributes?: Record<string, string>): string | undefined {
  const act = (action || '').trim();
  const lower = act.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  if (lower.startsWith('#report:')) {
    return act.slice('#report:'.length).trim().split(/[?&,"') ]/)[0] || undefined;
  }
  const openUrlMatch = /openUrl\s*\(\s*(?:&quot;|["'])#Report:([A-Za-z_]\w*)/i.exec(act);
  if (openUrlMatch) return openUrlMatch[1];
  if (attributes) {
    const href = (getZmlAttr(attributes, ['url', 'href']) || '').trim();
    if (href.toLowerCase().startsWith('#report:')) {
      return href.slice('#report:'.length).trim().split(/[?&,"') ]/)[0] || undefined;
    }
    const openUrlHref = /openUrl\s*\(\s*(?:&quot;|["'])#Report:([A-Za-z_]\w*)/i.exec(href);
    if (openUrlHref) return openUrlHref[1];
  }
  if (compact === 'report' || compact === 'openreport') {
    if (attributes) {
      const explicit = getZmlAttr(attributes, ['componentLinkName', 'reportLinkName', 'linkName', 'formLinkName']);
      if (explicit) return explicit;
      const rawTarget = getZmlAttr(attributes, ['target']);
      if (rawTarget && !WINDOW_TARGETS.has(rawTarget.toLowerCase())) return rawTarget;
    }
  }
  return undefined;
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
    const form = isFormAction(action, attrs) ? formActionTarget(action, attrs) : undefined;
    const imgType = (attrs.type ?? attrs.imagetype ?? '').trim().toLowerCase();
    const report = imgType === 'icon' && isReportAction(action, attrs) ? reportActionTarget(action, attrs) : undefined;
    out.push({
      action,
      siteId: `image-${m.index}`,
      ...(fn ? { fn } : {}),
      ...(label ? { label } : {}),
      ...(form ? { form } : {}),
      ...(report ? { report } : {}),
    });
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

/** Options for converting ZML snippets to HTML. */
export interface ConvertZmlOptions {
  app?: App;
  fnFiles?: HtmlpageFile[];
  schema?: SchemaPlan;
  reports?: ReadonlySet<string>;
}

/**
 * `forms` is the set of app form link names: an icon's Form click action
 * becomes a `#/form/<name>` link only when its target is exactly one of them.
 * `reports` is the same for an icon OpenReport click and `#/report/<name>`.
 */
export function convertZmlSnippetToHtml(
  template: string,
  forms: ReadonlySet<string> = new Set(),
  opts?: ConvertZmlOptions,
): string {
  const reports = opts?.reports ?? new Set<string>();
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
        const imageAttrs = parseZmlAttributes(attrStr);
        const imgType = (imageAttrs.type ?? imageAttrs.imagetype ?? '').trim().toLowerCase();
        if (tag === 'image' && !isClosing && imgType === 'icon') {
          const actionText = imageAttrs.action ?? '';
          const formTarget = isFormAction(actionText, imageAttrs) ? formActionTarget(actionText, imageAttrs) : undefined;
          const reportTarget = isReportAction(actionText, imageAttrs) ? reportActionTarget(actionText, imageAttrs) : undefined;
          const iconDiv = `<div data-zml="icon"${zmlAttributesToStyle(imageAttrs)}></div>`;
          const formLinked = !!formTarget && /^[A-Za-z0-9_]+$/.test(formTarget) && forms.has(formTarget);
          const reportLinked = !!reportTarget && /^[A-Za-z0-9_]+$/.test(reportTarget) && reports.has(reportTarget);
          const href = formLinked ? `#/form/${formTarget}` : reportLinked ? `#/report/${reportTarget}` : '';
          let wrapped = href ? `<a href="${href}">${iconDiv}</a>` : iconDiv;

          const action = (imageAttrs.action ?? '').replace(/\s+/g, '').toLowerCase();
          const fnName = (imageAttrs.functionname ?? imageAttrs.function ?? '').trim();
          const voteFunction = /^(vote\.(?:upvote|downvote))$/.exec(fnName.toLowerCase())?.[1];
          if ((action === 'function' || action === 'executefunction') && voteFunction) {
            const fn = opts?.app?.functions.find((f) => f.name.toLowerCase() === voteFunction);
            if (fn && opts?.app) {
              if (opts.fnFiles && !opts.fnFiles.some((f) => f.path === `functions/custom/${functionSlug(fn.name)}-call.mjs`)) {
                const buttonCalls = buttonCallsFor(opts.app);
                const writeCall = buttonCalls.get(voteFunction);
                const declared = rawFnParams(fn.signature);
                opts.fnFiles.push({
                  path: `functions/custom/${functionSlug(fn.name)}-call.mjs`,
                  source: functionCallModule({
                    app: opts.app,
                    name: fn.name,
                    signature: fn.signature,
                    params: declared,
                    reads: [...(writeCall?.reads ?? [])],
                    writes: [...(writeCall?.writes ?? new Map())].map(([form, op]) => ({ form, op })),
                    schema: opts.schema,
                  }),
                });
              }
              const params = (imageAttrs.parameters ?? '').trim();
              let argc = 0;
              let argAttrs = '';
              if (params) {
                const parts = splitButtonArgs(params) || [params];
                argc = parts.length;
                argAttrs = parts
                  .map((part, i) => {
                    const trimmed = part.trim();
                    const isl = /^<%=([\s\S]+?)%>$/.exec(trimmed);
                    const expr = isl ? isl[1].trim() : trimmed;
                    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
                      const val = trimmed.slice(1, -1);
                      return ` data-fn-arg-${i}="j:${JSON.stringify(val)}"`;
                    }
                    if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
                      return ` data-fn-arg-${i}="n:${trimmed}"`;
                    }
                    return ` data-fn-arg-${i}="p:${expr}"`;
                  })
                  .join('');
              }
              const msg = imageAttrs.successmsg ?? imageAttrs.successMsg ?? '';
              wrapped = `<button type="button" data-fn-call="/functions/${functionSlug(fn.name)}/call" data-fn-argc="${argc}"${argAttrs}${msg ? ` data-fn-msg="${msg}"` : ''} data-fn-refresh="true">${iconDiv}</button>`;
            }
          }

          out += wrapped;
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
 * A record-summary URL a snippet builds in a variable first
 * (`src = zoho.appuri + "/record-summary/Report/" + record.Lookup.ID;`) and
 * prints once as an iframe `src`. The variable is written back into the iframe
 * as the literal URL form, so {@link rewriteRecordSummaryFrames} proves the
 * same report and row shape it proves for a URL written in place. A variable
 * used anywhere else stays as written.
 */
const SUMMARY_URL_VARIABLE =
  /(^|[;{}\r\n])[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*zoho\.appuri[ \t]*\+[ \t]*"\/?record-summary\/([A-Za-z_]\w*)\/"[ \t]*\+[ \t]*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]*;/;

function inlineSummaryUrlVariable(template: string): string {
  const assign = SUMMARY_URL_VARIABLE.exec(template);
  if (!assign) return template;
  const [whole, lead, name, report, idExpr] = assign as unknown as [string, string, string, string, string];
  const use = new RegExp(`(<iframe\\b[^>]*\\bsrc\\s*=\\s*)(["'])<%=\\s*${name}\\s*%>\\2`, 'i').exec(template);
  if (!use) return template;
  // The one assignment and the one printed use are the only places the name appears in code.
  if ([...islandCode(template).matchAll(new RegExp(`(?<![\\w.])${name}(?!\\w)`, 'g'))].length !== 2) return template;
  const url = `<%=zoho.appuri%>/record-summary/${report}/<%=${idExpr}%>`;
  const without = template.slice(0, assign.index) + lead + template.slice(assign.index + whole.length);
  return without.replace(use[0], `${use[1]}${use[2]}${url}${use[2]}`);
}

/**
 * Point the one known record-summary iframe shape at the generated route. The
 * URL's row id is still untrusted: the route uses the form's record endpoint,
 * which applies authorizeRead to that exact ROWID before returning fields.
 */
export function rewriteRecordSummaryFrames(template: string, app?: App, source?: string): string {
  return replaceIframeElements(String(template ?? ''), (whole, attrs, inner) => {
    const src = /\bsrc\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
    if (!src) return whole;
    const match = INTERNAL_RECORD_SUMMARY.exec(src[2].trim());
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
    if (!recordSummaryIdShape(idExpr, form, source ?? template, app)) return whole;
    const routed = report ? `#/report/${report.name}/row/<%=${idExpr}%>` : `#/record/${form}/<%=${idExpr}%>`;
    const nextAttrs = attrs.slice(0, src.index) + `src=${src[1]}${routed}${src[1]}` + attrs.slice(src.index + src[0].length);
    const anchorAttrs = nextAttrs.replace(/\bsrc\s*=/i, 'href=');
    const label = inner.trim() || 'View record summary';
    return `<a${anchorAttrs}>${label}</a>`;
  });
}

/** Attributes of a blank frame that change nothing the page shows: its name only targeted a navigation, the rest tune content. */
const BLANK_FRAME_ATTRS = new Set(['allowtransparency', 'class', 'name', 'scrolling', 'src', 'style', 'zc_mobileview']);
const NO_BORDER = /(?:^|;)[\t\n\f\r ]*border[\t\n\f\r ]*:[\t\n\f\r ]*(?:none|0(?:px)?)[\t\n\f\r ]*(?:;|$)/i;

/**
 * A frame with an empty `src`, no content and no border is the blank box the
 * browser draws for `about:blank`, sized by its style. It becomes a `<div>`
 * carrying that style and class, the same box, because the sanitizer drops an
 * `iframe`. A frame that could show anything else (an address, an island in
 * its tag, a width or height attribute, frame content, a visible default
 * border, a value that needs escaping) is left as written and stays counted.
 */
function rewriteBlankFrames(template: string): string {
  return replaceIframeElements(template, (whole, attrs, inner) => {
    if (inner.trim() !== '' || attrs.includes('<%')) return whole;
    const parsed = parseZmlAttributes(attrs);
    const names = Object.keys(parsed);
    if (!names.every((name) => BLANK_FRAME_ATTRS.has(name)) || parsed.src === undefined || parsed.src.trim() !== '') return whole;
    if (!NO_BORDER.test(parsed.style ?? '')) return whole;
    const kept = ['class', 'style'].filter((name) => parsed[name] !== undefined);
    if (kept.some((name) => /["&<>]/.test(parsed[name] ?? ''))) return whole;
    return `<div${kept.map((name) => ` ${name}="${parsed[name]}"`).join('')}></div>`;
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
  return replaceTaggedElements(template, 'iframe', replace);
}

/**
 * Replace each complete `<a ...>...</a>` element the same way
 * {@link replaceIframeElements} does for `<iframe>` — a single quote-aware
 * scan, never a backtracking attribute-list regular expression.
 */
function replaceAnchorElements(template: string, replace: (whole: string, attrs: string, inner: string) => string): string {
  return replaceTaggedElements(template, 'a', replace);
}

function replaceTaggedElements(template: string, tagName: string, replace: (whole: string, attrs: string, inner: string) => string): string {
  const open = new RegExp(`<${tagName}(?![A-Za-z0-9_])`, 'gi');
  const close = new RegExp(`</${tagName}`, 'gi');
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

/** An open `<label>` tag whose attributes may hold `<%= %>` islands. */
const LABEL_OPEN = /<label\b[^<>]*(?:<%[^%<>]*%>[^<>]*)*>/gi;
/** What makes a label more than a span: a control it labels (inside it, or by `for`). */
const LABEL_CONTROL = /<(?:input|select|textarea|button|meter|output|progress)\b/i;

/**
 * Pre-pass for compileHtmlpage: a `<label>` whose attributes hold an island
 * (`style="background-color: <%=color%>"`) is written as a `<span>`. The
 * sanitizer unwraps `label`, so the attribute and the island in it would
 * vanish. A label with no `for` and no control inside labels nothing: it draws
 * inline like a span and a click on it does nothing, so the span is the same
 * element to the reader. A label that names or holds a control keeps its
 * meaning and stays as written; so does one the tag pattern cannot close.
 */
function rewriteIslandLabels(template: string): string {
  if (!/<label\b/i.test(template)) return template;
  let out = '';
  let at = 0;
  LABEL_OPEN.lastIndex = 0;
  for (let m = LABEL_OPEN.exec(template); m; m = LABEL_OPEN.exec(template)) {
    const open = m[0];
    if (!open.includes('<%') || /[\t\n\f\r ]for[\t\n\f\r ]*=/i.test(open.replace(/<%=?[^%<>]*%>/g, ''))) continue;
    const close = template.toLowerCase().indexOf('</label', m.index + open.length);
    if (close < 0) continue;
    const content = template.slice(m.index + open.length, close);
    if (/<label\b/i.test(content) || LABEL_CONTROL.test(content)) continue;
    const end = template.indexOf('>', close);
    if (end < 0) continue;
    out += `${template.slice(at, m.index)}<span${open.slice('<label'.length)}${content}</span>`;
    at = end + 1;
    LABEL_OPEN.lastIndex = at;
  }
  return out + template.slice(at);
}

/** An open `<div>` tag whose attributes may hold `<%= %>` islands. */
const DIV_OPEN = /<div\b[^<>]*(?:<%[^%<>]*%>[^<>]*)*>/gi;
/** The `background-*` declarations a cover image carries; any other one keeps the div as written. */
const IMAGE_BACKGROUND_PARTS = new Set(['background-repeat', 'background-size', 'background-position']);

/** The island expression of `url(<%= x %>)`, bare or quoted, or null when the value is anything else. */
function backgroundUrlIsland(value: string): string | null {
  const text = value.trim();
  if (!text.toLowerCase().startsWith('url(') || !text.endsWith(')')) return null;
  const inner = text.slice(4, -1).trim();
  const quote = inner.startsWith("'") || inner.startsWith('"') ? inner[0]! : '';
  if (quote && !inner.endsWith(quote)) return null;
  const island = inner.slice(quote.length, inner.length - quote.length);
  if (!island.startsWith('<%=') || !island.endsWith('%>')) return null;
  const expr = island.slice(3, -2);
  return /[<>"'%;]/.test(expr) || !expr.trim() ? null : expr.trim();
}

/**
 * Pre-pass for compileHtmlpage: an empty `<div>` whose own style paints a photo from an island
 * (`background: url('<%=photo%>'); background-size: cover; background-position: center`) draws that
 * photo as an `<img>` filling the div instead. The sanitizer refuses a `url()` in an inline style, so
 * the declaration and the island in it would vanish; an image element fetches the same address through
 * the page's URL rules, and `object-fit` is the same cover or contain scaling, centred or from the
 * corner. Every other declaration stays on the div, which becomes the positioned box the image fills
 * (padding box, where a background is drawn). A div that has content, repeats the image, sets another
 * background part, is positioned `static`, or holds more than the one island stays as written.
 */
function rewriteIslandBackgrounds(template: string): string {
  if (!/url\(/i.test(template)) return template;
  let out = '';
  let at = 0;
  DIV_OPEN.lastIndex = 0;
  for (let m = DIV_OPEN.exec(template); m; m = DIV_OPEN.exec(template)) {
    const open = m[0];
    const end = m.index + open.length;
    if (!open.includes('<%') || template.slice(end, end + 6).toLowerCase() !== '</div>') continue;
    const rewritten = divWithBackgroundImage(open);
    if (rewritten === null) continue;
    out += template.slice(at, m.index) + rewritten;
    at = end + 6;
    DIV_OPEN.lastIndex = at;
  }
  return out + template.slice(at);
}

function divWithBackgroundImage(open: string): string | null {
  const styleAt = open.search(/[\t\n\f\r ]style="/i);
  if (styleAt < 0) return null;
  const valueStart = open.indexOf('"', styleAt) + 1;
  const valueEnd = open.indexOf('"', valueStart);
  if (valueEnd < 0) return null;
  const value = open.slice(valueStart, valueEnd);
  if (value.indexOf('<%') !== value.lastIndexOf('<%') || value.indexOf('%>') !== value.lastIndexOf('%>')) return null;
  const rest: string[] = [];
  let expr: string | null = null;
  const bgParts = new Map<string, string>();
  for (const declaration of value.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) {
      if (declaration.trim()) return null;
      continue;
    }
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const body = declaration.slice(colon + 1).trim();
    if (name === 'background' || name === 'background-image') {
      expr = backgroundUrlIsland(body);
      if (expr === null) return null;
    } else if (IMAGE_BACKGROUND_PARTS.has(name)) bgParts.set(name, body.toLowerCase());
    else if (name.startsWith('background') && name !== 'background-color') return null;
    else rest.push(`${name}:${body}`);
  }
  const size = bgParts.get('background-size');
  const position = bgParts.get('background-position');
  if (expr === null || bgParts.get('background-repeat') !== 'no-repeat' || (size !== 'cover' && size !== 'contain')) return null;
  if (position !== undefined && position !== 'center' && position !== 'center center') return null;
  const placed = rest.find((d) => d.startsWith('position:'));
  if (placed?.slice('position:'.length).trim().toLowerCase() === 'static') return null;
  if (!placed) rest.push('position:relative');
  const attrs = open.slice(0, styleAt) + open.slice(valueEnd + 1, -1);
  const fill = `position:absolute;top:0;left:0;width:100%;height:100%;object-fit:${size};object-position:${position ? 'center' : '0 0'}`;
  return `${attrs} style="${rest.join(';')}"><img src="<%=${expr}%>" alt="" style="${fill}"></div>`;
}

/**
 * Pre-pass for compileHtmlpage: rewrites `<iframe>` embeds of own reports or
 * forms (`<%=zoho.appuri%>report-embed/<Report>`, `<%=zoho.appuri%>form-embed/<Form>`)
 * to allowlisted static `<a>` links.
 * `page-embed` iframes are handled by `inlinePageEmbeds` instead: a provable
 * one becomes an inline include marker, anything else keeps the snippet
 * counted.
 * Non-matching or unsafe iframes (external URLs, dynamic names/islands,
 * unallowlisted query parameters) remain unchanged so the compiler refuses them.
 */
function rewriteEmbedIframes(template: string, app: App): string {
  if (!template.includes('report-embed') && !template.includes('form-embed')) {
    return template;
  }
  const IFRAME_RE = /<iframe\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>(?:[\s\S]*?<\/iframe>)?)/gi;
  return template.replace(IFRAME_RE, (match, attrText) => {
    const attrs = parseZmlAttributes(attrText);
    const src = attrs.src;
    if (!src) return match;
    const m = /^<%=\s*zoho\.appuri\s*%>(report-embed|form-embed)\/([^?#]+)(?:\?([^#]*))?$/i.exec(src.trim());
    if (!m) return match;
    const isForm = m[1].toLowerCase() === 'form-embed';
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
    const target = isForm ? app.forms.find((f) => f.name === name) : app.reports.find((r) => r.name === name);
    if (!target) return match;
    for (const part of queryParts) {
      if (!isZcParam(part)) return match;
    }
    const label = target.displayName || target.name;
    const href = `#/${isForm ? 'form' : 'report'}/${encodeURIComponent(name)}`;
    return `<a href="${href}">${escapeHtml(label)}</a>`;
  });
}

/**
 * A template whose markup ends in an end tag that never reaches its `>` (the
 * `</div` a hand edit left) followed only by the statement island that closes
 * the function. Nothing follows the island, so the rendered markup ends inside
 * that tag, and the HTML tokenizer drops a tag it meets the end of the input
 * in. The compiled markup leaves it out instead of putting an island inside a
 * tag. Any other shape keeps its position check.
 */
const CLOSING_BRACE_ISLAND = new RegExp(`^<%[${TAG_WS}]*\\}[${TAG_WS}]*%>[${TAG_WS}]*$`);
const CUT_OFF_END_TAG = new RegExp(`^</[A-Za-z][\\w:-]*[${TAG_WS}]*$`);
function dropCutOffEndTag(template: string): string {
  const island = template.lastIndexOf('<%');
  if (island < 0 || !CLOSING_BRACE_ISLAND.test(template.slice(island))) return template;
  const tag = template.lastIndexOf('</', island);
  if (tag < 0 || !CUT_OFF_END_TAG.test(template.slice(tag, island))) return template;
  return template.slice(0, tag) + template.slice(island);
}

/** `<%=zoho.appuri%>form-embed/<Form>` and the parameters Creator reads after it, behind `?` or a bare `/`. */
const FORM_EMBED_SRC = /^<%=[ \t]*zoho[ \t]*\.[ \t]*appuri[ \t]*%>form-embed\/([A-Za-z_]\w*)(?:[/?]([\s\S]*))?$/i;
const FORM_FRAME_ATTRS = new Set(['allowtransparency', 'class', 'frameborder', 'height', 'name', 'scrolling', 'src', 'style', 'width']);
const FRAME_SIZE = /^\d{1,5}(?:%|px)?$/;

/**
 * An `<iframe>` of one of this app's forms whose address carries parameters
 * (`<%=zoho.appuri%>form-embed/<Form>?zc_Header=false&Field=<%=input.p%>`)
 * draws the form inline, prefilled, the way a `zc-component` embed does. It
 * becomes that embed, so the one parameter grammar decides everything after:
 * declared fields only, one bare read or bounded literal per value, a lookup
 * field never. A frame whose look the embed would change (a visible default
 * border, scrolling off, an attribute with an island, content in the frame,
 * a size that is not a plain length) is left as written. The frame's `name`
 * only targeted a navigation, and a navigation into it is its sender's own
 * counted `openUrl` target.
 */
function rewriteFormEmbedFrames(template: string, app: App): string {
  if (!/form-embed/i.test(template)) return template;
  return replaceIframeElements(template, (whole, attrs, inner) => {
    if (inner.trim() !== '') return whole;
    const parsed = parseZmlAttributes(attrs);
    if (!Object.keys(parsed).every((name) => FORM_FRAME_ATTRS.has(name))) return whole;
    const match = FORM_EMBED_SRC.exec((parsed.src ?? '').trim());
    if (!match || !app.forms.some((form) => form.name === match[1])) return whole;
    if (Object.entries(parsed).some(([name, value]) => name !== 'src' && /[<>"'&]/.test(value))) return whole;
    if (parsed.frameborder !== '0' && !NO_BORDER.test(parsed.style ?? '')) return whole;
    if (parsed.scrolling !== undefined && parsed.scrolling.toLowerCase() !== 'auto') return whole;
    const sizes: string[] = [];
    for (const name of ['width', 'height']) {
      const value = parsed[name];
      if (value === undefined) continue;
      if (!FRAME_SIZE.test(value)) return whole;
      sizes.push(`${name}:${/^\d+$/.test(value) ? `${value}px` : value}`);
    }
    const query = (match[2] ?? '').trim();
    if (/['"]/.test(query)) return whole;
    const style = [parsed.style?.trim().replace(/;$/, ''), ...sizes].filter(Boolean).join(';');
    const kept = [parsed.class === undefined ? '' : ` class="${parsed.class}"`, style ? ` style="${style}"` : ''].join('');
    return `<div elName='zc-component' formLinkName='${match[1]}'${query ? ` params='${query}'` : ''}${kept}></div>`;
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
  opts: { id?: string; schema?: SchemaPlan; resolvedConditionals?: boolean } = {},
): HtmlpageCompiled {
  const fail = (reason: string): HtmlpageCompiled => ({
    ok: false,
    reason,
    manualReasons: serverSnippetGuidance(decoded, reason, elementName, app).reasons,
  });
  const head = splitTemplate(decoded);
  head.template = inlineConstantStyleCalls(head.template, app);
  head.template = dropCutOffEndTag(head.template);
  head.template = rewriteRecordSummaryFrames(inlineSummaryUrlVariable(head.template), app, decoded);
  head.template = rewriteBlankFrames(head.template);
  const fnFiles: HtmlpageFile[] = [];
  head.template = convertZmlSnippetToHtml(head.template, new Set(app.forms.map((f) => f.name)), {
    app,
    fnFiles,
    schema: opts.schema,
    reports: new Set(app.reports.map((r) => r.name)),
  });
  head.template = rewriteEmbedIframes(head.template, app);
  head.template = rewriteFormEmbedFrames(head.template, app);
  head.template = rewriteIslandBackgrounds(rewriteIslandLabels(head.template));
  head.template = inlineSetupCalls(head.template, app);
  if (hasExecuteFunctionButton(head.template)) {
    head.template = rewriteExecuteFunctionButtons(head.template, app, new Set(head.params), fnFiles, opts.schema);
    if (hasExecuteFunctionButton(head.template)) return fail(EXECUTE_FUNCTION_BUTTON);
  }
  // A template that already writes the include marker could name a page the
  // compiler never checked: it stays the counted snippet.
  if (head.template.toLowerCase().includes(PAGE_INCLUDE_PREFIX)) return fail('marker collision');
  // A forwarded value may name either this `htmlpage` function's own
  // declared parameter or, as in a real `page Name(date)` snippet, the
  // enclosing page's own declared parameter — both are names the page itself
  // already exposes as `input.<name>`, never a value a caller invents.
  const ownPageParams = new Set([...head.params, ...(app.pages.find((item) => item.name === page)?.params ?? [])]);
  head.template = rewritePageParamLinks(head.template, app, page, ownPageParams);
  // A `#Page:` href the rewrite above could not prove safe (unknown page, an
  // undeclared or repeated parameter, a value other than a bounded literal or
  // one forwarded `input.p`, the page linking itself) must never reach the
  // generic island pipeline below: that stage only checks a URL's scheme, not
  // its target, so an unresolved marker would otherwise compile to a link
  // that is either dead (literal `#Page:` text, not a real route) or unproven
  // safe. Refuse the whole snippet instead, same as the other markers above.
  // A bare, fully static `#Page:` pseudo-URL (no `zoho.appuri` island at all)
  // is plain literal text the rewrite above never touches — Creator's own
  // markup carries the same text unchanged, so it is not this construct's
  // job. Only an appuri-prefixed `#Page:` target the rewrite could not
  // resolve is refused here.
  if (/<%=[ \t]*zoho[ \t]*\.[ \t]*appuri[ \t]*%>#Page:/i.test(head.template)) return fail('marker collision');
  const embeds = inlinePageEmbeds(head.template, app, page, ownPageParams);
  head.template = embeds.template;
  const includes = embeds.includes;
  if (/component-(?:form|report):|popup-(?:form|report):/i.test(head.template)) return fail('marker collision');
  head.template = inlineEncodedParamVariables(head.template);
  const embedded = embeddedComponents(head.template, app, ownPageParams);
  head.template = embedded.template;
  const withIncludes = (done: HtmlpageCompiled): HtmlpageCompiled => {
    // Every include must survive sanitization where it stood; a marker the
    // allowlist removed would be an embed that silently vanished.
    const html = done.html ?? '';
    for (const marker of embeds.markers) if (!html.includes(`data-zml="${PAGE_INCLUDE_PREFIX}${marker}"`)) return fail('page embed did not survive markup sanitization');
    for (const marker of embedded.markers) if (!html.includes(`data-zml="${marker.replace(/&/g, '&amp;')}"`)) return fail('component embed did not survive markup sanitization');
    return { manualReasons: [], ...done, ...(includes.length ? { includes } : {}), ...(embedded.components.length ? { components: embedded.components } : {}), ...(embedded.todos.length ? { componentTodos: embedded.todos } : {}) };
  };
  const chunks = splitChunks(head.template);
  if (!chunks) return fail('malformed Deluge island');
  const rawIslands = chunks.filter((c) => c.kind !== 'static');
  if (!rawIslands.length) {
    // A template that never carried Deluge is still suspect and refused; one
    // whose islands all collapsed to literal `if`/`else` branches upstream was
    // genuinely processed, so what remains is ordinary static markup.
    if (!includes.length && !embedded.components.length && !fnFiles.length && !opts.resolvedConditionals) return fail('no Deluge islands');
    // The embed's appuri island or a generated component marker was the only
    // dynamic construct: the rest is static markup. A snippet that is static
    // markup plus wired function-call buttons needs no render endpoint; the
    // runtime wires `data-fn-call` clicks on the shell.
    const staticMarkup = chunks.map((c) => c.text).join('');
    if (droppedStyles(staticMarkup, false).length) return fail('static markup contains a dropped style declaration');
    const droppedTags: string[] = [];
    const html = sanitizeSnippet(staticMarkup, undefined, droppedTags);
    return withIncludes({ ok: true, staticOnly: true, html, ...(droppedTags.length ? { droppedTags } : {}), ...(fnFiles.length ? { files: fnFiles } : {}) });
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
  if (head.template.includes(STYLE_BRANCH_MARK_PREFIX) || head.template.includes(STYLE_VALUE_VAR_PREFIX)) return fail('marker collision');

  // Context for every island, from the static markup that precedes it.
  {
    let prefix = '';
    for (let n = 0; n < chunks.length; n++) {
      const chunk = chunks[n];
      if (chunk.kind === 'static') prefix += chunk.text;
      else {
        chunk.context = slotContext(prefix);
        // A CSS function argument is its own whole number: it stands between
        // an opener or separator and a separator, closer, or unit, never
        // inside a longer token, and the marker needs four digits of room.
        if (chunk.context === 'style-fn') {
          const after = chunks[n + 1]?.kind === 'static' ? chunks[n + 1].text.charAt(0) : '';
          if (!/[(,/\s]$/.test(prefix) || !/^[,/)\s%A-Za-z]/.test(after) || islandOrdinal(chunks, chunk) > 9999) chunk.context = 'style';
        }
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
      if (only && (only.kind === 'expr' || (only.kind === 'unknown' && only.reason === 'no-effect'))) {
        isl.kind = 'expr';
        isl.wasStmts = true;
      }
    } catch {
      /* stays a statement island */
    }
  }

  // A quoted attribute value accepts an expression island only. A statement
  // island is written into the value, and an openUrl there becomes a link
  // between the quotes. The page stays the counted snippet.
  // A statement island in a `<style>` body only computes: the sanitizer
  // removes the element, so nothing it does reaches the output, and the page's
  // dropped-CSS step still counts every tag in the stylesheet. One that opens a
  // URL would be a redirect the removed element hides, so it stays refused.
  for (const isl of islands) {
    if (isl.kind === 'expr' || isl.context === 'text' || isl.context === 'comment') continue;
    if (isl.context === 'cssbody' && !/\bopenUrl\b/i.test(isl.text)) continue;
    return fail('island in an unsafe position');
  }

  // A computed number in a `<style>` body (`rotate(<%=angle%>deg)`) is carried as a custom property the
  // rendered snippet sets on a wrapper; the page's carried CSS reads it with var(). The sites found here
  // must be the ones the page model replaced, or the carried rule would read a property nothing sets.
  const valueSites = new Map<number, { name: string; unit: string }>();
  const modelValues = styleValues(head.template);
  if (modelValues.length) {
    const islandAt = new Map(islands.map((isl) => [isl.i, isl]));
    const elementOf: number[] = [];
    const withStatements = new Set<number>();
    let element = -1;
    chunks.forEach((chunk, n) => {
      if (chunk.kind === 'static') {
        const low = chunk.text.toLowerCase();
        if (low.lastIndexOf('<style') > low.lastIndexOf('</style')) element++;
      }
      elementOf[n] = element;
      const isl = islandAt.get(n);
      if (isl && isl.context === 'cssbody' && (isl.kind === 'stmts' || isl.wasStmts)) withStatements.add(element);
    });
    const sites: { n: number; expr: string; unit: string }[] = [];
    let body = '';
    chunks.forEach((chunk, n) => {
      if (chunk.kind === 'static') {
        const low = chunk.text.toLowerCase();
        const open = low.lastIndexOf('<style');
        const close = low.lastIndexOf('</style');
        if (open > close) body = chunk.text.slice(chunk.text.indexOf('>', open) + 1);
        else if (close >= 0) body = '';
        else body += chunk.text;
        return;
      }
      const isl = islandAt.get(n)!;
      if (isl.context === 'cssbody' && isl.kind === 'expr' && !isl.wasStmts && !withStatements.has(elementOf[n]!)) {
        const next = chunks[n + 1];
        const text = next?.kind === 'static' ? next.text : '';
        const cut = text.search(/<\/style/i);
        const unit = styleValueUnit(body, cut >= 0 ? text.slice(0, cut) : text + (chunks[n + 1] ? '<%' : ''));
        if (unit !== undefined && isl.text.trim()) sites.push({ n, expr: isl.text.trim(), unit });
      }
      body += 'x';
    });
    if (sites.length !== modelValues.length || sites.some((site, k) => site.expr !== modelValues[k]!.expr || site.unit !== modelValues[k]!.unit)) return fail('style value mismatch');
    sites.forEach((site, k) => valueSites.set(site.n, { name: modelValues[k]!.name, unit: site.unit }));
  }

  // Marker-sanitize-split: sanitize the whole document once, then read which
  // island slots survived and where the static fragments landed.
  let combined = '';
  for (const chunk of chunks) combined += chunk.kind === 'static' ? chunk.text : marker(islandOrdinal(chunks, chunk), chunk.context === 'style-fn');
  const nIslands = islands.length;
  const droppedTags: string[] = [];
  const sanitized = sanitizeSnippet(combined, undefined, droppedTags);
  MARK_SPLIT.lastIndex = 0;
  MARK_MATCH.lastIndex = 0;
  const pieces = sanitized.split(MARK_SPLIT);
  const surviving = [...sanitized.matchAll(MARK_MATCH)].map((m) => Number(m[1] ?? m[2]));
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
    if (islands[i].context !== 'comment' && islands[i].context !== 'sheet' && islands[i].context !== 'cssbody' && !survived.has(i)) return fail('island in an unsafe position');
  }

  // Reassemble the Deluge script: static pushes, verbatim statement islands,
  // expr islands as escaped output parts, openUrl rewritten to link parts.
  // A URL attribute value may span islands and static fragments. Those pieces
  // are emitted as "V" (escaped island value) and "W" (literal static) parts
  // so the generated render joins them and applies the scheme rule to the
  // whole assembled value, not to each island alone.
  const branchIds = new Set(styleBranchMarkers(head.template));
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
    if (isl.context === 'cssbody' && (isl.kind === 'stmts' || isl.wasStmts)) {
      // The statements run (their reads and conditions are checked like any
      // island's) but print nothing: the element they sit in is removed.
      scriptParts.push(isl.wasStmts ? `${isl.text.trim().replace(/;$/, '')};` : isl.text);
      // The rule group that follows prints where the branch runs, as a marker
      // the page's carried CSS selects on (see styleBranchMarkers).
      const after = chunks[isl.i + 1];
      const group = after?.kind === 'static' ? after.text.split(/<\/style/i)[0]! : '';
      const id = styleBranchId(group);
      if (branchIds.has(id)) scriptParts.push(`c2c_out.add({"k":"H","v":${JSON.stringify(`<span title="${STYLE_BRANCH_MARK_PREFIX}${id}"></span>`)}});`);
    } else if (valueSites.has(isl.i)) {
      const site = valueSites.get(isl.i)!;
      scriptParts.push(`c2c_out.add({"k":"S","n":${JSON.stringify(site.name)},"u":${JSON.stringify(site.unit)},"v":(${isl.text.trim()})});`);
    } else if (isl.context === 'comment' || isl.context === 'sheet' || isl.context === 'cssbody') {
      // An island inside an HTML comment produces no output (drop it, with a note).
      scriptParts.push('c2c_out.add({"k":"D","v":0});');
    } else if (isl.kind === 'expr') {
      if (survived.has(i)) {
        const kind = isl.context === 'url' ? 'V' : isl.context === 'attr' ? 'A' : isl.context === 'style' ? 'C' : isl.context === 'style-fn' ? 'Q' : 'T';
        scriptParts.push(`c2c_out.add({"k":"${kind}","v":(${isl.text.trim()})});`);
      } else if (isl.context === 'style' || isl.context === 'style-fn') {
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
  let script = scriptParts.join('\n');

  let ast;
  try {
    ast = parse(script);
    const inlined = inlineInsertCalls(app, script, ast.body);
    if (inlined !== script) {
      script = inlined;
      ast = parse(script);
    }
  } catch {
    return fail('Deluge islands do not parse');
  }
  const settled = settlePopups(script, ast);
  const popupMarks = settled.marks;
  if (settled.script !== script) {
    script = settled.script;
    try {
      ast = parse(script);
    } catch {
      return fail('Deluge islands do not parse');
    }
  }
  const isShapeC = hasShapeCWrites(ast);
  // A guarded write belongs where its output shows; one hidden in a removed `<style>` body is refused.
  if (isShapeC && islands.some((isl) => isl.kind !== 'expr' && isl.context === 'cssbody')) return fail('island in an unsafe position');
  // A write or external action on render (`insert into`, `update`, `sendmail`,
  // `invokeUrl`, ...) is never read-only, whatever else the island holds —
  // except the Shape C setup writes, which carry their own guard rules.
  if (!isShapeC && (hasEffectNode(ast.body) || boundFieldWrite(ast.body, new Set()))) {
    return fail('island is not a read-only render');
  }
  let shapeCGuard: ShapeCGuard | undefined;
  if (isShapeC) {
    shapeCGuard = isShapeCGuarded(ast);
    if (!shapeCGuard.ok || hasUnguardedRecordWrite(ast)) return fail('island writes are unguarded');
    if (!ast.body.every(shapeCStmtOk)) return fail('island outside the handled classes');
  } else {
    if (!ast.body.every((stmt) => stmtOk(stmt))) return fail('island outside the handled classes');
  }

  // A value that holds markup is printed through `c2cMarkup`, not as escaped text.
  const flow = markupFlow(
    ast.body,
    (path) => {
      const fn = appFunction(app, path);
      return !!fn && buildsMarkup(fn);
    },
    (form, field) => imageColumns(app, form).has(field),
  );
  const printed = flow.prints.length > 0;
  if (printed) script = flow.prints.reduceRight((text, span) => `${text.slice(0, span.start)}"M"${text.slice(span.end)}`, script);

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
  // Server code of every `thisapp.<fn>()` callee the read-only check proved.
  const calleeServers: string[] = [];
  // A rendered page only reads: value slots, one record field, a column,
  // the rows of a query, aggregates, and pure helpers. Any other shim call,
  // a functions.* call, an assignment through a fetched value, or an await
  // that is not one of those reads stays the same counted snippet.
  const appCall = (callee: string[]) => readOnlyAppFunction(app, callee, new Set(), calleeServers, flow.functions.has(callee.join('.').toLowerCase()));
  if (isShapeC) {
    if (!shapeCServerOk(server, appCall, shapeCGuard?.sweeps)) return fail('island is not an allowed write render');
  } else {
    if (!islandReadOnly(server, appCall)) return fail('island is not a read-only render');
  }

  // The read-only check ran on the plain translation; the endpoint wraps its image reads.
  const images = withImageReads(app, server);
  const queried = [server, ...calleeServers].flatMap((code) =>
    [...code.matchAll(/shim\.datastore\.(?:query|aggregate|insert|update)\(ctx, "([^"]+)"/g), ...code.matchAll(/compileCriteria\(ctx\.shim, "([^"]+)"/g)].map((m) => m[1]),
  );
  const serverText = [server, ...calleeServers].join('\n');
  const paths = lookupPathsOf(app, serverText, [...new Set(queried)].sort());
  const reads = lookupReadsOf(app, serverText, [...new Set(queried)].sort());
  const forms = [...queried, ...linkedForms(paths), ...linkedForms(reads.forms)];
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
      server: images.server,
      statics: cleanStatics,
      hasWrites: isShapeC,
      requireOwner: shapeCGuard?.requireOwner,
      appCalls: calleeServers.length > 0,
      markup: printed || images.reads > 0,
      images: images.reads > 0,
      ...(printed || images.reads > 0 || /#Page:/i.test(server) ? { routes: navRoutesSource(app) } : {}),
      ...(popupMarks.length ? { popups: true } : {}),
      ...compositesOf(app, [...new Set(forms)].sort()),
      ...(Object.keys(paths).length || Object.keys(reads.forms).length
        ? { lookupForms: mergeLookupForms(paths, reads.forms), ...(Object.keys(reads.fields).length ? { lookupReads: reads.fields } : {}), multiLookups: multiLookupsOfPaths(app, mergeLookupForms(paths, reads.forms), opts.schema) }
        : {}),
    }),
  };
  return withIncludes({ ok: true, html: cleanStatics.join(''), ...(droppedTags.length ? { droppedTags } : {}), src: path, file, ...(fnFiles.length ? { files: fnFiles } : {}), ...(popupMarks.length ? { popupMarks } : {}) });
}

/** The composite fields (a name, an address) of the forms a render reads, by form, or nothing when they hold none. */
function compositesOf(app: App, forms: readonly string[]): { composites?: Record<string, Record<string, string[]>> } {
  const out: Record<string, Record<string, string[]>> = {};
  for (const name of forms) {
    for (const field of app.forms.find((item) => item.name === name)?.fields ?? []) {
      if (field.subfields.length === 0 || /^(?:section|subform|grid|add notes)$/i.test(field.type ?? '')) continue;
      (out[name] ??= {})[field.name] = field.subfields.map((part) => part.name);
    }
  }
  return Object.keys(out).length ? { composites: out } : {};
}

/**
 * form -> lookup field -> linked form, for the lookups of the queried forms
 * whose linked-record field the render's criteria compares (`"Head.Field"`).
 */
function lookupPathsOf(app: App, server: string, forms: readonly string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const name of forms) {
    for (const field of app.forms.find((item) => item.name === name)?.fields ?? []) {
      if (field.lookup && server.includes(`field: "${field.name}.`)) (out[name] ??= {})[field.name] = field.lookup.form;
    }
  }
  return out;
}

/**
 * form -> lookup field -> linked form, and form -> lookup field -> fields, for
 * the lookups of the queried forms whose linked record the render reads a
 * field of (`shim.record.get(row, "Head", "Field")` or a `"Head.Field"` read).
 */
function lookupReadsOf(app: App, server: string, forms: readonly string[]): { forms: Record<string, Record<string, string>>; fields: Record<string, Record<string, string[]>> } {
  const linked: Record<string, Record<string, string>> = {};
  const fields: Record<string, Record<string, string[]>> = {};
  for (const name of forms) {
    for (const field of app.forms.find((item) => item.name === name)?.fields ?? []) {
      if (!field.lookup || !/^[A-Za-z_]\w*$/.test(field.name)) continue;
      const read = new Set<string>();
      for (const m of server.matchAll(new RegExp(`shim\\.record\\.get\\([A-Za-z_$][\\w$]*, "${field.name}", "([A-Za-z_]\\w*)"`, 'g'))) read.add(m[1]!);
      for (const m of server.matchAll(new RegExp(`shim\\.datastore\\.(?:field|column)\\(ctx, [A-Za-z_$][\\w$]*, "${field.name}\\.([A-Za-z_]\\w*)"`, 'g'))) read.add(m[1]!);
      if (!read.size) continue;
      (linked[name] ??= {})[field.name] = field.lookup.form;
      (fields[name] ??= {})[field.name] = [...read].sort();
    }
  }
  return { forms: linked, fields };
}

/** The linked forms of a form -> lookup -> linked-form map, in form then lookup order. */
function linkedForms(map: Record<string, Record<string, string>>): string[] {
  return Object.keys(map).sort().flatMap((form) => Object.keys(map[form]!).sort().map((head) => map[form]![head]!));
}

/** Two form -> lookup -> linked-form maps as one. */
function mergeLookupForms(...maps: Record<string, Record<string, string>>[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const map of maps) for (const form of Object.keys(map).sort()) out[form] = { ...out[form], ...map[form] };
  return out;
}

/** The multi lookups among the named lookup paths, as the junction tables that hold them. */
function multiLookupsOfPaths(app: App, paths: Record<string, Record<string, string>>, schema?: SchemaPlan): ReturnType<typeof multiLookupsOf> {
  const all = multiLookupsOf(app, schema);
  const out: ReturnType<typeof multiLookupsOf> = {};
  for (const form of Object.keys(paths).sort()) {
    for (const head of Object.keys(paths[form]!).sort()) {
      if (Object.hasOwn(all, form) && Object.hasOwn(all[form]!, head)) (out[form] ??= {})[head] = all[form]![head]!;
    }
  }
  return out;
}

function islandOrdinal(chunks: Chunk[], target: Chunk): number {
  let n = -1;
  for (const c of chunks) {
    if (c.kind !== 'static') n++;
    if (c === target) return n;
  }
  return n;
}

/** Strip leading and trailing spaces and tabs only (no regex, linear). */
function trimSpaceTab(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === ' ' || text[start] === '\t')) start++;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(start, end);
}
