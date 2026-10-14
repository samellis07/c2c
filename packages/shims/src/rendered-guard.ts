/**
 * Post-render markup guard for generated page endpoints: parse the HTML the
 * endpoint is about to return and list every parsed element (tag plus
 * attributes) so the caller can apply its markup policy. parse5 is required
 * lazily, so the shim bundle loads without it and a missing parser throws at
 * audit time, where the caller refuses the render.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface RenderedElement {
  tag: string;
  attributes: { name: string; value: string }[];
}

interface GuardAttr {
  name: string;
  prefix?: string;
  value: string;
}

interface GuardNode {
  nodeName: string;
  tagName?: string;
  attrs?: GuardAttr[];
  childNodes?: GuardNode[];
  /** A <template> element keeps its children here, not in childNodes. */
  content?: GuardNode;
}

let cachedFragment: ((html: string) => GuardNode) | undefined;
let cachedDocument: ((html: string) => GuardNode) | undefined;

function fragmentParser(): (html: string) => GuardNode {
  if (!cachedFragment) {
    const loaded = require('parse5') as { parseFragment(html: string): GuardNode };
    cachedFragment = (html: string) => loaded.parseFragment(html);
  }
  return cachedFragment;
}

function documentParser(): (html: string) => GuardNode {
  if (!cachedDocument) {
    const loaded = require('parse5') as { parse(html: string): GuardNode };
    cachedDocument = (html: string) => loaded.parse(html);
  }
  return cachedDocument;
}

function attrName(attr: GuardAttr): string {
  return (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase();
}

function walk(node: GuardNode, out: RenderedElement[]): void {
  if (node.tagName) {
    const attributes = (node.attrs ?? []).map((attr) => ({
      name: (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase(),
      value: String(attr.value ?? ''),
    }));
    out.push({ tag: node.tagName.toLowerCase(), attributes });
    if (node.content) walk(node.content, out);
  }
  for (const child of node.childNodes ?? []) walk(child, out);
}

/** Every element an HTML parse of `html` produces, in document order. */
export function renderedHtmlElements(html: unknown): RenderedElement[] {
  const fragment = fragmentParser()(String(html ?? ''));
  const out: RenderedElement[] = [];
  for (const child of fragment.childNodes ?? []) walk(child, out);
  return out;
}

/**
 * Structural violations the fragment audit cannot see: it parses in a
 * fragment context, where `html`, `head`, `body` and `frameset` start tags
 * (and their attributes) are discarded before the audit walks the elements.
 * A full document parse keeps them: any attribute on the document's `html`,
 * `head` or `body` element, or any `frameset` element the parser built, is a
 * violation. A `frameset` token the document parser itself drops (after body
 * content, where the HTML grammar ignores it) builds no element and passes.
 */
export function renderedDocumentViolation(html: unknown): string {
  const doc = documentParser()(String(html ?? ''));
  let violation = '';
  const visit = (node: GuardNode): void => {
    if (violation) return;
    if (node.tagName) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'frameset') {
        violation = 'element frameset';
        return;
      }
      if ((tag === 'html' || tag === 'head' || tag === 'body') && (node.attrs ?? []).length > 0) {
        violation = `${tag} ${attrName((node.attrs ?? [])[0] as GuardAttr)}`;
        return;
      }
      if (node.content) visit(node.content);
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(doc);
  return violation;
}
