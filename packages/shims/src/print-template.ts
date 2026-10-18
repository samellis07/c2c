/**
 * Server-side record print layouts for sendmail `template:` attachments.
 *
 * `as inline` embeds the rendered layout in the mail body; `as pdf` renders
 * the same layout and the mail function converts it to a PDF attachment.
 * The layout model is the one the record view uses (`print template` block
 * `content` JSON on the form): the catalog ships as c2c-print-templates.json
 * next to c2c-mail.mjs.
 * `_default`/`_default1` names are the built-in record summary, synthesized
 * here as a label:value list — an approximation, not a pixel copy.
 *
 * The layout's own `text` markup is sanitized with the same allowlist the page
 * generator applies (tags, attributes, safe URLs, inline styles), ported here
 * DOM-free because the function has no document. Every record value is
 * HTML-escaped before it lands in the output.
 */

/** One record print layout element (the record view's UiPrintElement shape). */
export interface PrintElement {
  type: 'columns' | 'text' | 'field' | 'lookup' | 'image' | 'spacer' | 'todo' | string;
  split?: string;
  columns?: PrintElement[][];
  html?: string;
  field?: string;
  label?: string;
  labelStyle?: string;
  valueStyle?: string;
  valueTextStyle?: string;
  wrapperStyle?: string;
  labelTextStyle?: string;
  fields?: { field: string; label: string; labelStyle?: string; valueStyle?: string }[];
  src?: string;
  alt?: string;
  style?: string;
  height?: string;
  note?: string;
}

/** A resolved `print template` block. */
export interface PrintTemplate {
  name: string;
  label: string;
  style?: string;
  font?: string;
  elements: PrintElement[];
}

/** c2c-print-templates.json: form link name -> template name -> layout. */
export type PrintTemplateCatalog = Record<string, Record<string, PrintTemplate>>;

/** The translated `template:` attachment descriptor inside a sendmail message. */
export interface MailTemplateDescriptor {
  kind: string;
  name?: string;
  form?: string | null;
  record?: unknown;
  format?: string | null;
  rendered?: string;
}

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr',
]);

/** Dropped with their descendants. Unwrapping these would surface script or style text. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'noscript',
  'noembed', 'template', 'svg', 'math', 'title', 'head', 'html', 'body',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  font: new Set(['color', 'face', 'size']),
  td: new Set(['colspan', 'rowspan', 'title']),
  th: new Set(['colspan', 'rowspan', 'title']),
  ol: new Set(['start', 'title']),
  '*': new Set(['title', 'data-style-dropped']),
};

/** Tags that never have a closing tag. */
const VOID_TAGS = new Set(['br', 'col', 'hr', 'img', 'wbr']);

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeEntities(value: string): string {
  return String(value).replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower]!;
    try {
      const cp = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return match;
      return String.fromCodePoint(cp);
    } catch {
      return match;
    }
  });
}

function safeUrl(value: string): boolean {
  const flat = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (!flat) return true;
  return !flat.startsWith('javascript:') && !flat.startsWith('data:') && !flat.startsWith('vbscript:');
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
 * Identical rules to the page generator's `cleanStyle`: each declaration is
 * checked on its own, so a refused declaration never takes the safe ones
 * beside it. A trailing token with no colon and no assignment, quote, escape,
 * or call is not a declaration and is left out.
 */
export function cleanPrintStyle(value: string): { style: string; dropped: string[] } {
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

function allowedAttr(tag: string, name: string): boolean {
  if (name.startsWith('on') || name === 'srcdoc') return false;
  if (name === 'style') return true;
  const specific = ALLOWED_ATTRS[tag];
  if (specific?.has(name)) return true;
  return ALLOWED_ATTRS['*']!.has(name);
}

interface HtmlAttr {
  name: string;
  value: string;
}

interface HtmlNode {
  tag?: string;
  attrs?: HtmlAttr[];
  text?: string;
  children: HtmlNode[];
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

/**
 * A small tag soup parser: enough HTML to rebuild the allowlisted tree. Text
 * and attribute values are entity-decoded; anything the sanitizer refuses is
 * escaped or dropped at emit time, so a malformed input degrades to text.
 */
function parseHtml(raw: string): HtmlNode {
  const root: HtmlNode = { children: [] };
  const stack: HtmlNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  const input = String(raw ?? '');
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      top().children.push({ text: decodeEntities(input.slice(i)), children: [] });
      break;
    }
    if (lt > i) top().children.push({ text: decodeEntities(input.slice(i, lt)), children: [] });
    if (input.startsWith('<!--', lt)) {
      const end = commentClose(input, lt + 4);
      i = end < 0 ? input.length : end;
      continue;
    }
    const close = /^<\/\s*([a-zA-Z][^\s/>]*)\s*>/.exec(input.slice(lt));
    if (close) {
      const name = close[1]!.toLowerCase();
      // Pop back to the matching open tag; an unmatched close is ignored.
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth]!.tag === name) {
          stack.length = depth;
          break;
        }
      }
      i = lt + close[0].length;
      continue;
    }
    const open = /^<\s*([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>?/.exec(input.slice(lt));
    if (!open) {
      // A lone `<` is literal text.
      top().children.push({ text: '<', children: [] });
      i = lt + 1;
      continue;
    }
    const name = open[1]!.toLowerCase();
    const attrText = open[2] ?? '';
    const attrs: HtmlAttr[] = [];
    const attrRe = /([^\s/>="'`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s>]*))?/g;
    for (const match of attrText.matchAll(attrRe)) {
      const raw = match[0];
      const eq = raw.indexOf('=');
      const attrName = eq < 0 ? raw : raw.slice(0, eq);
      if (!attrName) continue;
      const value = eq < 0 ? '' : decodeEntities(raw.slice(eq + 1).replace(/^["']|["']$/g, ''));
      attrs.push({ name: attrName.toLowerCase(), value });
    }
    const node: HtmlNode = { tag: name, attrs, children: [] };
    top().children.push(node);
    const selfClose = /\/\s*>$/.test(open[0]) || VOID_TAGS.has(name);
    if (!selfClose) stack.push(node);
    i = lt + open[0].length;
  }
  return root;
}

function emitNode(node: HtmlNode, dropped?: string[]): string {
  if (node.text !== undefined) return escapeHtml(node.text);
  const tag = node.tag ?? '';
  if (DROPPED_TAGS.has(tag)) return '';
  const inner = node.children.map((child) => emitNode(child, dropped)).join('');
  if (!ALLOWED_TAGS.has(tag)) return inner;
  let attrs = '';
  for (const attr of node.attrs ?? []) {
    const name = attr.name;
    if (!allowedAttr(tag, name)) continue;
    if ((name === 'href' || name === 'src') && !safeUrl(attr.value)) continue;
    if (name === 'style') {
      const style = cleanPrintStyle(attr.value);
      if (style.style || !style.dropped.length) attrs += ` style="${escapeHtml(style.style)}"`;
      if (style.dropped.length) {
        attrs += ` data-style-dropped="${escapeHtml(style.dropped.join(' '))}"`;
        dropped?.push(...style.dropped);
      }
      continue;
    }
    attrs += ` ${name}="${escapeHtml(attr.value)}"`;
  }
  if (tag === 'a' && / href=/.test(attrs)) attrs += ' rel="noopener noreferrer"';
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

/**
 * DOM-free port of the page sanitizer. Same allowlists: refused tags unwrap,
 * dangerous tags drop with their descendants, `on*`/`srcdoc` attributes and
 * unsafe href/src URLs are refused, and a refused style declaration is named
 * in `data-style-dropped` (and pushed onto `dropped`).
 */
export function sanitizePrintHtml(raw: string, dropped?: string[]): string {
  return parseHtml(raw).children.map((node) => emitNode(node, dropped)).join('');
}

/** `Name.prefix` reads `row["Name.prefix"]` first, then `row.Name.prefix` — same rule as the record view. */
function refValue(row: unknown, ref: string): unknown {
  if (!row || typeof row !== 'object' || typeof ref !== 'string' || ref === '') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, ref)) return (row as Record<string, unknown>)[ref];
  let value: unknown = row;
  for (const part of ref.split('.')) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** A cell's printable text; `${A.B}` placeholder refs read nested values. */
function printCell(row: unknown, field: string | undefined): string {
  if (!row || field == null || field === '') return '';
  const value = refValue(row, field);
  if (value == null || typeof value === 'object') return '';
  return String(value);
}

/** A layout style keeps its safe declarations; refused ones are named in `data-style-dropped`. */
function styleAttr(value: string | undefined): string {
  if (!value) return '';
  const style = cleanPrintStyle(value);
  return (
    (style.style ? ` style="${escapeHtml(style.style)}"` : '') +
    (style.dropped.length ? ` data-style-dropped="${escapeHtml(style.dropped.join(' '))}"` : '')
  );
}

function elementHtml(el: PrintElement, row: unknown): string {
  if (!el || typeof el !== 'object') return '';
  switch (el.type) {
    case 'columns': {
      const split = String(el.split || '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      const cols = (el.columns || []).map((col, index) => {
        const width = /^[0-9]+(?:\.[0-9]+)?$/.test(split[index] || '') ? `flex:0 0 ${split[index]}%` : '';
        return `<div data-print-col${styleAttr(width)}>${(col || []).map((item) => elementHtml(item, row)).join('')}</div>`;
      });
      return `<div data-print-columns>${cols.join('')}</div>`;
    }
    case 'text': {
      // Placeholders are filled before the sanitizer runs, so a record value
      // that lands in an attribute (href, src, style) gets the same URL and
      // style checks as the template's own markup. Values are escaped first
      // and filled in one pass, so a value cannot add a placeholder of its own.
      const fill = (html: string) =>
        String(html).replace(/\$\{([^}]+)\}/g, (_match, name) => escapeHtml(printCell(row, String(name).trim())));
      return `<div data-print-text>${sanitizePrintHtml(fill(el.html || ''))}</div>`;
    }
    case 'field':
      return (
        `<div data-print-field${styleAttr(el.wrapperStyle)}>` +
        `<span data-print-label${styleAttr(el.labelStyle || el.labelTextStyle)}>${escapeHtml(el.label || el.field || '')}</span>` +
        `<span data-print-value${styleAttr(el.valueStyle || el.valueTextStyle)}>${escapeHtml(printCell(row, el.field))}</span></div>`
      );
    case 'lookup': {
      const fields = el.fields || [];
      const related = row && typeof row === 'object' && Array.isArray((row as Record<string, unknown>)[el.field ?? ''])
        ? ((row as Record<string, unknown>)[el.field ?? ''] as unknown[])
        : [];
      const head = fields
        .map((item) => `<th scope="col"${styleAttr(item.labelStyle)}>${escapeHtml(item.label || item.field)}</th>`)
        .join('');
      const body = related
        .map((item) => `<tr>${fields.map((col) => `<td${styleAttr(col.valueStyle)}>${escapeHtml(printCell(item, col.field))}</td>`).join('')}</tr>`)
        .join('');
      const label = el.label ? `<h3 data-print-lookup-label>${escapeHtml(el.label)}</h3>` : '';
      return `<div data-print-lookup>${label}<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
    case 'image': {
      const src = el.field ? printCell(row, el.field) : el.src;
      if (!src || !safeUrl(src)) return '';
      return `<img data-print-image src="${escapeHtml(src)}" alt="${escapeHtml(el.alt || el.label || '')}"${styleAttr(el.style)}>`;
    }
    case 'spacer': {
      const height = /^[0-9]+(?:\.[0-9]+)?$/.test(String(el.height || '')) ? `height:${el.height}px` : '';
      return `<div data-print-spacer${styleAttr(height)}></div>`;
    }
    default:
      return `<p class="todo" data-print-todo>${escapeHtml(el.note || 'Print element is not generated.')}</p>`;
  }
}

/** Render one resolved print layout over a record — the record view's sheetHtml, server-side. */
export function renderPrintTemplate(template: PrintTemplate, record: unknown): string {
  const elements = template?.elements || [];
  const body = elements.map((el) => elementHtml(el, record)).join('');
  const style = template?.style ? styleAttr(template.style) : '';
  const font = template?.font ? ` data-print-font="${escapeHtml(template.font)}"` : '';
  return `<div data-print-page${style}${font}>${body}</div>`;
}

/**
 * The built-in `_default`/`_default1` record summary as a label:value list.
 * Object values render as JSON; null values are skipped.
 */
export function recordSummaryHtml(record: unknown): string {
  const entries = record && typeof record === 'object' && !Array.isArray(record) ? Object.entries(record as Record<string, unknown>) : [];
  const rows = entries
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `<div data-print-field><span data-print-label>${escapeHtml(key)}</span><span data-print-value>${escapeHtml(text)}</span></div>`;
    })
    .join('');
  return `<div data-print-page data-print-summary="default">${rows}</div>`;
}

/** `_default`/`_default1` are the built-in record summary; there is no export block for them. */
function isBuiltinSummary(name: string): boolean {
  return name === '_default' || name === '_default1';
}

function templateIn(catalog: PrintTemplateCatalog, form: string | null | undefined, name: string): PrintTemplate | undefined {
  if (form) return catalog[form]?.[name];
  for (const formName of Object.keys(catalog).sort()) {
    const found = catalog[formName]?.[name];
    if (found) return found;
  }
  return undefined;
}

/**
 * Render a `template:` attachment descriptor to inline HTML, or null when the
 * name resolves to nothing the catalog knows — the caller keeps the refusal.
 */
export function renderMailTemplate(catalog: PrintTemplateCatalog | null | undefined, descriptor: MailTemplateDescriptor): string | null {
  if (!catalog || !descriptor || descriptor.kind !== 'template') return null;
  const name = String(descriptor.name ?? '');
  if (!name) return null;
  if (isBuiltinSummary(name)) return recordSummaryHtml(descriptor.record);
  const template = templateIn(catalog, descriptor.form, name);
  if (!template) return null;
  return renderPrintTemplate(template, descriptor.record);
}
