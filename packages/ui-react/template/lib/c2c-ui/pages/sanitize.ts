/**
 * The HTML snippet sanitizer of the vanilla runtime (packages/ui/src/client-runtime.js,
 * sanitizeSnippet), typed. The generator already sanitized every snippet with
 * the same allowlist; the page sanitizes again with the document it renders
 * into before inserting the markup. Without a DOM parser the snippet is text.
 */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr',
]);

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
  '*': new Set(['title']),
};

function flat(value: string): string {
  return value.replace(/[\u0000- ]+/g, '').toLowerCase();
}

export function safeUrl(value: string): boolean {
  const raw = String(value ?? '');
  if (!raw) return true;
  if (/[\u0000-\u0020\\]/.test(raw) || raw.startsWith('//')) return false;
  let text = raw;
  for (let pass = 0; pass <= 4; pass++) {
    // The raw value is strict, but decoded URL data may contain ordinary
    // spaces (%20) legitimately. Only reject decoded control characters
    // (excluding space), backslashes, and structures that become dangerous.
    if (pass > 0 && /[\u0000-\u001f\u007f\\]/.test(text)) return false;
    const flatText = flat(text);
    if (flatText.startsWith('//') || /^(?:javascript|data|vbscript|file|ftp|blob):/.test(flatText)) return false;
    if (/^[a-z][a-z0-9+.-]*:/.test(flatText) && !/^(?:https?|mailto|tel):/.test(flatText)) return false;
    if (!/^(?:https?|mailto|tel):/.test(flatText) && !flatText.startsWith('#') && !flatText.startsWith('/')) {
      // Plain relative routes (including ../) are allowed.
    }
    let decoded: string;
    try { decoded = decodeURIComponent(text); } catch { decoded = text.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))); }
    if (decoded === text) break;
    text = decoded;
  }
  return true;
}

export function dangerousStyle(value: string): boolean {
  if (value.includes('\\') || value.includes('/*')) return true;
  const text = flat(value);
  return ['url(', 'image-set(', 'src(', 'expression(', 'behavior', '-moz-binding', '@import', 'javascript:', 'vbscript:', 'data:', 'attr('].some((bad) => text.includes(bad));
}

function allowedAttr(tag: string, name: string): boolean {
  if (name.startsWith('on') || name === 'srcdoc') return false;
  if (name === 'style') return true;
  return !!ALLOWED_ATTRS[tag]?.has(name) || ALLOWED_ATTRS['*']!.has(name);
}

function cleanNode(node: Node, doc: Document): Node | null {
  if (node.nodeType === 3) return doc.createTextNode(node.textContent ?? '');
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROPPED_TAGS.has(tag)) return null;
  const fragment = doc.createDocumentFragment();
  for (const child of Array.from(element.childNodes)) {
    const next = cleanNode(child, doc);
    if (next) fragment.appendChild(next);
  }
  if (!ALLOWED_TAGS.has(tag)) return fragment;
  const out = doc.createElement(tag);
  for (const attr of Array.from(element.attributes)) {
    const name = attr.name.toLowerCase();
    if (!allowedAttr(tag, name)) continue;
    if ((name === 'href' || name === 'src') && !safeUrl(attr.value)) continue;
    if (name === 'style' && dangerousStyle(attr.value)) continue;
    out.setAttribute(name, attr.value);
  }
  if (tag === 'a' && out.getAttribute('href')) out.setAttribute('rel', 'noopener noreferrer');
  out.appendChild(fragment);
  return out;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

export function sanitizeSnippet(raw: string, doc: Document): string {
  const Parser = (doc.defaultView as (Window & typeof globalThis) | null)?.DOMParser;
  if (typeof Parser !== 'function') return escapeHtml(raw);
  const parsed = new Parser().parseFromString(raw, 'text/html');
  const sink = parsed.createElement('template');
  for (const node of Array.from(parsed.body.childNodes)) {
    const next = cleanNode(node, parsed);
    if (next) sink.content.appendChild(next);
  }
  return sink.innerHTML;
}
