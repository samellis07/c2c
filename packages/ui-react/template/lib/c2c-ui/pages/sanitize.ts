/**
 * The HTML snippet sanitizer of the vanilla runtime (packages/ui/src/client-runtime.js,
 * sanitizeSnippet), typed. The generator already sanitized every snippet with
 * the same allowlist; the page sanitizes again with the document it renders
 * into before inserting the markup. Without a DOM parser the snippet is text.
 */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
  'input', 'label', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr',
]);

const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset', 'noscript',
  'noembed', 'template', 'svg', 'math', 'title', 'head', 'html', 'body',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  input: new Set(['id', 'type']),
  label: new Set(['for']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  font: new Set(['color', 'face', 'size']),
  td: new Set(['colspan', 'rowspan', 'title']),
  th: new Set(['colspan', 'rowspan', 'title']),
  ol: new Set(['start', 'title']),
  '*': new Set(['class', 'title']),
};

/**
 * Classes a shell stylesheet lifts out of flow (fixed, absolute or z-indexed):
 * page or data markup may not borrow one to paint over the app. The generator and the browser runtime keep
 * identical copies; a test derives the list from both stylesheets.
 */
export const SHELL_OVERLAY_CLASSES = new Set([
  'c2c-modal-backdrop', 'c2c-sr-only', 'modal', 'modal-close', 'navitems', 'skip', 'skip-link', 'visually-hidden',
]);
const SHELL_OVERLAY_MODULE_CLASS = /^_overlay_[A-Za-z0-9_-]+$/i;

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

function flat(value: string): string {
  return value.replace(/[\u0000- ]+/g, '').toLowerCase();
}

/** The one `data:` URL an `<img>` keeps: an inline raster image, matched on the raw value so case, whitespace and SVG stay refused. */
const DATA_IMAGE_SRC = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

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
  return ['url(', 'image-set(', 'image(', 'cross-fade(', 'src(', 'expression(', 'behavior', '-moz-binding', '@import', 'javascript:', 'vbscript:', 'data:', 'attr('].some((bad) => text.includes(bad));
}

function allowedAttr(tag: string, name: string): boolean {
  if (name.startsWith('on') || name === 'srcdoc') return false;
  if (name === 'style') return true;
  return !!ALLOWED_ATTRS[tag]?.has(name) || ALLOWED_ATTRS['*']!.has(name);
}

/**
 * The one frame a snippet may keep: a YouTube player, `https://www.youtube.com/embed/<11-character id>` and
 * nothing else. The build sanitizer (packages/ui/src/pages.ts) carries the same rule.
 */
function videoEmbedSrc(value: string): string | undefined {
  const match = /^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})$/.exec(value);
  return match ? `https://www.youtube-nocookie.com/embed/${match[1]}` : undefined;
}

function videoFrame(element: Element, doc: Document): Node | null {
  const src = videoEmbedSrc(element.getAttribute('src') ?? '');
  if (!src) return null;
  const out = doc.createElement('iframe');
  out.setAttribute('src', src);
  for (const name of ['width', 'height']) {
    const value = element.getAttribute(name) ?? '';
    if (/^[0-9]{1,4}$/.test(value)) out.setAttribute(name, value);
  }
  const title = element.getAttribute('title');
  if (title) out.setAttribute('title', title);
  out.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
  out.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  out.setAttribute('loading', 'lazy');
  out.setAttribute('allowfullscreen', '');
  return out;
}

function cleanNode(node: Node, doc: Document): Node | null {
  if (node.nodeType === 3) return doc.createTextNode(node.textContent ?? '');
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' && (element.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') return null;
  if (tag === 'iframe') return videoFrame(element, doc);
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
    if ((name === 'href' || name === 'src') && !(tag === 'img' && name === 'src' && DATA_IMAGE_SRC.test(attr.value)) && !safeUrl(attr.value)) continue;
    if (name === 'style' && dangerousStyle(attr.value)) continue;
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
