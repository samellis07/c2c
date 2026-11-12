/**
 * A tolerant reader for ZML, the markup inside Creator pages
 * (`Content="<zml>...</zml>"` or a page file of its own).
 *
 * It builds an element tree (tag, attributes, children) and never throws.
 * Text and CDATA on an element that is not a layout wrapper are kept. Text
 * inside a layout wrapper is skipped. Unclosed elements are closed at the end,
 * and a stray closing tag is ignored. Attribute values keep their text without
 * the surrounding quotes. The page's references to other components (reports,
 * charts, forms, panels, ...) are listed separately for generators.
 */

export interface ZmlElement {
  tag: string;
  attributes: Record<string, string>;
  children: ZmlElement[];
  /** Text and CDATA inside this element, when it is not a layout wrapper. */
  text?: string;
  /** Offsets into the decoded ZML text. */
  start: number;
  end: number;
}

export interface ZmlReference {
  /** Element tag: `report`, `chart`, `panel`, `form`, `page`, `button`, `text`, ... */
  kind: string;
  /** The component (or element) name the element points at. */
  name: string;
  /** `linkName`, `formLinkName`, `componentLinkName` or `elementName`. */
  via: string;
  /** Application link name, when the element names one. */
  app?: string;
}

const TAG_RE = /<\/?([A-Za-z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

/** Structural tags. Text between their children is indentation, not content. */
const LAYOUT_WRAPPERS = new Set([
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
]);

function appendText(stack: ZmlElement[], chunk: string): void {
  if (!chunk) return;
  const current = stack[stack.length - 1];
  if (!current || LAYOUT_WRAPPERS.has(current.tag.toLowerCase())) return;
  const next = (current.text ?? '') + chunk;
  if (!next.trim()) return;
  current.text = next;
}

export function parseZml(src: string): ZmlElement[] {
  const roots: ZmlElement[] = [];
  const stack: ZmlElement[] = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      const stop = end < 0 ? src.length : end;
      appendText(stack, src.slice(i + 9, stop));
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[i] === '<') {
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(src);
      if (m && m.index === i) {
        const whole = m[0];
        const tag = m[1];
        const attrText = m[2] ?? '';
        const selfClose = m[3] ?? '';
        if (whole.startsWith('</')) {
          const at = stack.map((e) => e.tag.toLowerCase()).lastIndexOf(tag.toLowerCase());
          if (at >= 0) while (stack.length > at) stack.pop()!.end = i + whole.length;
        } else {
          const attributes: Record<string, string> = {};
          for (const a of attrText.matchAll(ATTR_RE)) {
            const v = a[2] ?? '';
            attributes[a[1]] = /^["']/.test(v) ? v.slice(1, -1) : v;
          }
          const el: ZmlElement = { tag, attributes, children: [], start: i, end: i + whole.length };
          (stack.length ? stack[stack.length - 1].children : roots).push(el);
          if (!selfClose) stack.push(el);
        }
        i += whole.length;
        continue;
      }
    }
    let j = i + 1;
    while (j < src.length && src[j] !== '<') j++;
    appendText(stack, src.slice(i, j));
    i = j;
  }
  for (const e of stack) e.end = src.length;
  TAG_RE.lastIndex = 0;
  return roots;
}

const REF_ATTRS = ['linkName', 'formLinkName', 'componentLinkName', 'elementName'] as const;

/** Components a page refers to, in document order. */
export function zmlReferences(roots: ZmlElement[]): ZmlReference[] {
  const out: ZmlReference[] = [];
  const walk = (e: ZmlElement) => {
    for (const via of REF_ATTRS) {
      const name = e.attributes[via];
      if (!name) continue;
      const app = e.attributes.appLinkName;
      out.push({ kind: e.tag, name, via, ...(app ? { app } : {}) });
      break;
    }
    e.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}
