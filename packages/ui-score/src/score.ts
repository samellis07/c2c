/**
 * Independent UI scorer: a generated Slate bundle against its Creator source,
 * desktop and phone, out of 10 each. See packages/ui-score/rubric.json and
 * docs/ui-scores.md.
 *
 * What it compares:
 * - the reference is the Creator app as parsed by core (sections, forms,
 *   fields, reports, columns, buttons, custom actions). Nothing from the UI
 *   generator is read on this side, so a generator bug cannot hide itself.
 * - the subject is the bundle's own bytes: index.html, the stylesheet it
 *   links, the runtime module it loads and the model that module imports. The
 *   runtime runs in jsdom (a dev dependency: this is a developer and CI tool,
 *   never a plugin path) inside each session's own window, as in a browser,
 *   against a fake data API; every route is visited, and the rendered DOM is
 *   checked. Viewport behaviour comes from the stylesheet's media rules
 *   evaluated at the rubric widths.
 * - rendered means rendered: an element only satisfies a check if nothing on it
 *   or an ancestor computes to display:none or visibility:hidden (or carries
 *   the hidden attribute) at that viewport's width, and a field's label must be
 *   a rendered label element, never only an accessible-name attribute. Elements
 *   that paint nothing for a sighted user — near-zero opacity, a zero scale, a
 *   far-negative text indent, a clip or clip-path shrunk to nothing, a
 *   clipped box small on either axis, or an offset far offscreen — count as
 *   hidden too, as does text under a transparent colour or a zero font size.
 *
 * Offline and deterministic: no network, no clock, no randomness.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openKind, readRegularFileIfPresent, type App, type Field as IrField, type Property } from '../../core/src/index.js';
import { phoneColumns, reportColumnLabel } from '../../core/src/phone-columns.js';
import { fileURLToPath } from 'node:url';

export type Viewport = 'desktop' | 'phone';
export const VIEWPORTS: Viewport[] = ['desktop', 'phone'];

export interface Rubric {
  version: number;
  scale: number;
  passBar: number;
  viewports: Record<Viewport, { width: number; height: number }>;
  criteria: { id: string; title: string; weights: Record<Viewport, number>; checks: string[] }[];
}

export const RUBRIC_PATH = fileURLToPath(new URL('../../../packages/ui-score/rubric.json', import.meta.url));

export function loadRubric(path = RUBRIC_PATH): Rubric {
  const rubric = JSON.parse(readFileSync(path, 'utf8')) as Rubric;
  for (const vp of VIEWPORTS) {
    const sum = rubric.criteria.reduce((n, c) => n + (c.weights[vp] ?? 0), 0);
    if (Math.abs(sum - rubric.scale) > 1e-9) throw new Error(`ui rubric: ${vp} weights sum to ${sum}, not ${rubric.scale}`);
  }
  return rubric;
}

// ---------------------------------------------------------------------------
// Bundle

export interface UiBundle {
  html: string;
  css: string;
  /** The entry module's source: what the page's module script loads. */
  runtime: string;
  /** The model chunk's source when the entry imports one ("" when it does not). */
  model: string;
  /** Every ES module file in the bundle, keyed by its slash-separated path relative to the bundle root (the page's directory). */
  modules: Record<string, string>;
  /** The `modules` key the page's `<script type="module">` points at. */
  entry: string;
}

type BundleFile = { path: string; data: string | Uint8Array };

function linked(html: string, re: RegExp): string | undefined {
  const m = re.exec(html);
  return m ? m[1]!.replace(/^\.\//, '') : undefined;
}

/** The bundle from in-memory files whose paths start with `slate/` (what `c2c ui` writes). */
export function bundleFromFiles(files: BundleFile[]): UiBundle {
  const text = (rel: string): string | undefined => {
    const file = files.find((f) => f.path === `slate/${rel}`);
    return file ? (typeof file.data === 'string' ? file.data : Buffer.from(file.data).toString('utf8')) : undefined;
  };
  const listJs = (): string[] => files.filter((f) => f.path.startsWith('slate/') && f.path.endsWith('.js')).map((f) => f.path.slice(6));
  return resolveBundle(text, listJs);
}

/** The bundle under a `c2c ui --out` directory, or its `slate/` directory itself. */
export function bundleFromDir(dir: string): UiBundle {
  const slate = openKind(join(dir, 'slate', 'index.html')) ? join(dir, 'slate') : dir;
  // One descriptor per file: a directory, FIFO or socket reads as absent and never blocks.
  const text = (rel: string): string | undefined => readRegularFileIfPresent(join(slate, rel));
  const listJs = (): string[] => {
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const name of readdirSync(join(slate, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${name.name}` : name.name;
        if (name.isDirectory()) walk(child);
        else if (name.isFile() && name.name.endsWith('.js')) out.push(child);
      }
    };
    walk('');
    return out;
  };
  return resolveBundle(text, listJs);
}

function resolveBundle(text: (rel: string) => string | undefined, listJs: () => string[]): UiBundle {
  const html = text('index.html');
  if (html === undefined) throw new Error('ui bundle: slate/index.html not found');
  const cssRel = linked(html, /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/) ?? linked(html, /<link[^>]+href="([^"]+\.css)"/);
  const entry = (linked(html, /<script[^>]+type="module"[^>]+src="([^"]+)"/) ?? '').replace(/^\//, '');
  const css = (cssRel && text(cssRel)) ?? '';
  const modules: Record<string, string> = {};
  for (const rel of listJs()) {
    const source = text(rel);
    if (source !== undefined) modules[rel] = source;
  }
  const runtime = modules[entry] ?? '';
  const modelRel = /from\s+["']\.\/(model\.[^"']+\.js)["']/.exec(runtime)?.[1];
  const model = (modelRel && text(join(dirname(entry), modelRel))) ?? '';
  return { html, css, runtime, model, modules, entry };
}

// ---------------------------------------------------------------------------
// Reference: what the Creator source says the UI must show

export type FieldKind = 'text' | 'longtext' | 'choice' | 'multichoice' | 'decision' | 'file' | 'composite' | 'subform' | 'computed' | 'section' | 'notes' | 'other';

export interface ExpectedField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
}

export interface ExpectedForm {
  name: string;
  label: string;
  fields: ExpectedField[];
  buttons: string[];
}

export interface ExpectedColumn {
  field: string;
  label: string;
}

export interface ExpectedReport {
  name: string;
  label: string;
  type: string;
  form?: string;
  chart: boolean;
  columns: ExpectedColumn[];
  phoneColumns: ExpectedColumn[];
  actions: string[];
}

export interface ExpectedNavItem {
  kind: 'form' | 'report' | 'page';
  name: string;
  label: string;
}

export interface Expected {
  title: string;
  sections: { label: string; items: ExpectedNavItem[] }[];
  forms: ExpectedForm[];
  reports: ExpectedReport[];
  pages: { name: string; label: string }[];
}

const KIND: Record<string, FieldKind> = {
  text: 'text',
  email: 'text',
  phonenumber: 'text',
  url: 'text',
  number: 'text',
  decimal: 'text',
  percentage: 'text',
  date: 'text',
  datetime: 'text',
  time: 'text',
  textarea: 'longtext',
  richtext: 'longtext',
  picklist: 'choice',
  radiobuttons: 'choice',
  list: 'multichoice',
  checkboxes: 'multichoice',
  multiselect: 'multichoice',
  'upload file': 'file',
  image: 'file',
  signature: 'file',
  video: 'file',
  audio: 'file',
  name: 'composite',
  address: 'composite',
  grid: 'subform',
  subform: 'subform',
  autonumber: 'computed',
  formula: 'computed',
  section: 'section',
  plaintext: 'notes',
};

const CURRENCY = /^[A-Z]{3}$/;

export function fieldKind(field: IrField): FieldKind {
  const type = field.type ?? '';
  if (type === 'checkbox') return field.choices?.length || field.lookup ? 'multichoice' : 'decision';
  if (CURRENCY.test(type)) return 'text';
  return KIND[type.toLowerCase()] ?? 'other';
}

function sampleValue(field: string): string {
  return `Sample ${humanize(field)}`;
}

function humanize(name: string): string {
  return name.replace(/_+/g, ' ').trim();
}

function propValue(props: Property[] | undefined, key: string): string | undefined {
  return (props ?? []).find((item) => item.key.toLowerCase() === key)?.value.replace(/^"|"$/g, '');
}

const CHART_TYPES = new Set(['pivotchart', 'pivottable', 'chart']);

export function expectedFromIr(app: App): Expected {
  const formLabel = new Map(app.forms.map((f) => [f.name, f.displayName ?? humanize(f.name)]));
  const reportLabel = new Map(app.reports.map((r) => [r.name, r.displayName ?? humanize(r.name)]));
  const pageLabel = new Map(app.pages.map((p) => [p.name, p.displayName ?? humanize(p.name)]));
  const sections: Expected['sections'] = [];
  for (const section of app.sections) {
    if (section.hidden) continue;
    const items: ExpectedNavItem[] = [];
    for (const ref of section.components) {
      const kind = ref.kind === 'form' ? 'form' : ref.kind === 'page' ? 'page' : reportLabel.has(ref.name) ? 'report' : undefined;
      const label = kind === 'form' ? formLabel.get(ref.name) : kind === 'page' ? pageLabel.get(ref.name) : reportLabel.get(ref.name);
      if (!kind || label === undefined) continue;
      if (/^(true|yes)$/i.test(propValue(ref.properties, 'hide') ?? '')) continue;
      items.push({ kind, name: ref.name, label });
    }
    if (items.length) sections.push({ label: section.displayName ?? humanize(section.name), items });
  }
  const forms: ExpectedForm[] = app.forms.map((form) => {
    const buttons: string[] = [];
    for (const action of form.actions) {
      if (!/add/i.test(action.event)) continue;
      for (const button of action.buttons) {
        const label = button.displayName ?? '';
        if (label && !buttons.includes(label)) buttons.push(label);
      }
    }
    return {
      name: form.name,
      label: formLabel.get(form.name)!,
      fields: form.fields.map((field) => ({
        name: field.name,
        label: field.displayName ?? humanize(field.name),
        kind: fieldKind(field),
        required: field.required,
      })),
      buttons,
    };
  });
  const formsByName = new Map(app.forms.map((f) => [f.name, f]));
  const reports: ExpectedReport[] = app.reports.map((report) => {
    const labelOf = (field: string, label?: string): string => reportColumnLabel(formsByName.get(report.form ?? ''), field, label);
    const columns = report.columns.filter((c) => c.field).map((c) => ({ field: c.field, label: labelOf(c.field, c.label) }));
    return {
      name: report.name,
      label: reportLabel.get(report.name)!,
      type: report.type,
      form: report.form,
      chart: CHART_TYPES.has(report.type),
      columns,
      phoneColumns: phoneColumns(report, columns),
      actions: report.customActions.map((a) => a.name).filter(Boolean),
    };
  });
  return {
    title: app.name ?? '',
    sections,
    forms,
    reports,
    pages: app.pages.map((p) => ({ name: p.name, label: pageLabel.get(p.name)! })),
  };
}

// ---------------------------------------------------------------------------
// Stylesheet: media rules evaluated at a width

interface CssRule {
  media?: string;
  selectors: string[];
  decls: Map<string, string>;
}

export function parseCss(css: string): CssRule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const walk = (text: string, media?: string): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) walk(body, prelude.slice(6).trim());
      else if (!prelude.startsWith('@')) {
        const decls = new Map<string, string>();
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          if (colon > 0) decls.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim());
        }
        rules.push({ media, selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls });
      }
      i = j;
    }
  };
  walk(src);
  return rules;
}

function px(value: string): number {
  const m = /^(-?[\d.]+)(px|rem|em)?$/.exec(value.trim());
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1);
}

/**
 * Painted-area hiding, judged from the computed style because jsdom has no
 * layout: the clip rect and clip-path shapes of the visually-hidden idiom, a
 * pixel-sized box with clipping overflow, or a positioned edge pushed far off
 * the page.
 */

/** `clip: rect(top right bottom left)` shrunk to a pixel or less. */
function clipRectHides(clip: string): boolean {
  const m = /^rect\(\s*([^)]*?)\s*\)$/i.exec(clip);
  if (!m) return false;
  const sides = m[1]!.split(/[\s,]+/).filter(Boolean);
  if (sides.length !== 4 || sides.some((side) => /^auto$/i.test(side))) return false;
  const [top, right, bottom, left] = sides.map(px);
  if ([top, right, bottom, left].some((n) => Number.isNaN(n))) return false;
  return right! - left! <= 1 || bottom! - top! <= 1;
}

/** `clip-path` shapes that paint nothing: an inset() of half or more on an axis, or a zero circle/ellipse. */
function clipPathHides(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v || v === 'none') return false;
  const inset = /^inset\(([^)]*)\)/.exec(v)?.[1];
  if (inset !== undefined) {
    const n = inset
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => (part.endsWith('%') ? Number(part.slice(0, -1)) : NaN));
    if (!n.length || n.length > 4 || n.some(Number.isNaN)) return false;
    const [top, right = top, bottom = top, left = right] = n;
    return top! + bottom! >= 99.5 || left! + right! >= 99.5;
  }
  return /^(circle|ellipse)\(\s*0(?:\.\d+)?(?:%|px)?[\s,)]/.test(v);
}

/** A dimension that resolves to more than a pixel: a length over 1px, or any nonzero percentage of its container. */
function overAPixel(value: string): boolean {
  const t = value.trim();
  if (t.endsWith('%')) return parseFloat(t) !== 0;
  const n = px(t);
  return !Number.isNaN(n) && n > 1;
}

/**
 * A box whose rendered size is no bigger than a pixel on either axis and
 * whose overflow cannot paint outside it. The declared width or height
 * only bounds the content box, so an axis counts as small only when
 * nothing enlarges what actually paints: padding or border on that axis
 * (the clip edge sits outside them), a min-* value (it wins over both the
 * size and the matching max-*), or the flex algorithm on a flex item's
 * main axis (a positive grow, or a flex-basis that replaces the declared
 * size). A max-* of a pixel or less still clamps a flex item, so it stays
 * small on its own.
 */
function tinyBoxHides(style: CSSStyleDeclaration, parentStyle: () => CSSStyleDeclaration | null): boolean {
  const clips = (v: string): boolean => v !== '' && v !== 'visible';
  if (!clips(style.overflow) && !clips(style.overflowX) && !clips(style.overflowY)) return false;

  const parent = parentStyle();
  const flexItem = !!parent && (parent.display === 'flex' || parent.display === 'inline-flex');
  const columnDir = !!parent && parent.flexDirection.startsWith('column');
  const grow = Number(style.flexGrow) || 0;
  const basis = (style.flexBasis || '').trim().toLowerCase();
  const basisIsSize = basis !== '' && basis !== 'auto' && basis !== 'content';

  const axis = (
    size: string,
    max: string,
    min: string,
    padA: string,
    padB: string,
    brdA: string,
    brdB: string,
    flexSized: boolean,
  ): boolean => {
    if (overAPixel(min)) return false;
    let frame = 0;
    for (const v of [padA, padB, brdA, brdB]) {
      const t = v.trim();
      if (t.endsWith('%')) {
        if (parseFloat(t) !== 0) return false;
      } else {
        const n = px(t);
        if (!Number.isNaN(n)) frame += n;
      }
    }
    if (frame > 1) return false;
    const cap = px(max);
    if (!Number.isNaN(cap) && cap <= 1) return true;
    if (flexSized) {
      if (grow > 0) return false;
      if (basisIsSize) return !overAPixel(basis);
    }
    const n = px(size);
    return !Number.isNaN(n) && n <= 1;
  };

  return (
    axis(style.width, style.maxWidth, style.minWidth, style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth, flexItem && !columnDir) ||
    axis(style.height, style.maxHeight, style.minHeight, style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth, flexItem && columnDir)
  );
}

/**
 * A transform whose composed scale drops the element to nothing on an
 * axis: any scale factor under a hundredth, or a matrix whose area
 * collapses — a zero determinant stays zero under composition, so a
 * collapsed matrix anywhere in the list is enough.
 */
function transformHides(transform: string): boolean {
  const t = transform.trim();
  if (!t || t === 'none') return false;
  let x = 1;
  let y = 1;
  for (const m of t.matchAll(/(scale3d|scaleX|scaleY|scaleZ|scale|matrix3d|matrix)\s*\(([^)]*)\)/gi)) {
    const args = m[2]!.split(',').map((part) => parseFloat(part));
    if (args.some(Number.isNaN)) continue;
    const fn = m[1]!.toLowerCase();
    if (fn === 'scale') {
      x *= args[0]!;
      y *= args.length > 1 ? args[1]! : args[0]!;
    } else if (fn === 'scalex') {
      x *= args[0]!;
    } else if (fn === 'scaley') {
      y *= args[0]!;
    } else if (fn === 'scale3d') {
      x *= args[0]!;
      y *= args[1]!;
    } else if (fn === 'matrix') {
      if (args.length === 6 && Math.abs(args[0]! * args[3]! - args[1]! * args[2]!) < 1e-4) return true;
    } else if (fn === 'matrix3d') {
      if (args.length === 16 && Math.abs(args[0]! * args[5]! - args[1]! * args[4]!) < 1e-4) return true;
    }
  }
  return Math.abs(x) < 0.01 || Math.abs(y) < 0.01;
}

/** An absolute or fixed element pushed far off the page on one edge paints nothing in the viewport. */
function offscreenHides(style: CSSStyleDeclaration): boolean {
  if (style.position !== 'absolute' && style.position !== 'fixed') return false;
  for (const prop of ['left', 'right', 'top', 'bottom']) {
    const value = style.getPropertyValue(prop).trim();
    if (/^-[\d.]+%$/.test(value)) {
      if (parseFloat(value) <= -100) return true;
      continue;
    }
    const n = px(value);
    if (!Number.isNaN(n) && n <= -999) return true;
  }
  return false;
}

/** A text colour that paints nothing: transparent, or a colour with a zero alpha. */
function transparentText(color: string): boolean {
  const v = color.trim().toLowerCase();
  if (v === 'transparent') return true;
  const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(v);
  if (slash) return parseFloat(slash[1]!) === 0;
  const alpha = /^(?:rgba|hsla)\(\s*[^,]+,[^,]+,[^,]+,\s*([\d.]+%?)\s*\)$/.exec(v)?.[1];
  return alpha !== undefined && parseFloat(alpha) === 0;
}

export function mediaMatches(media: string | undefined, width: number): boolean {
  if (!media) return true;
  const one = (q: string): boolean => {
    // A leading `not` negates the whole query, so only the exact `not all`
    // never applies; `not all and (…)` is a real query that applies
    // wherever the part it negates does not.
    if (q.startsWith('not ')) return !one(q.slice(4).trim());
    if (/\b(print|prefers-|hover|pointer|orientation|display-mode)\b/.test(q)) return false;
    // A colour display answers no to a positive monochrome request.
    if (/\(\s*monochrome\s*(:[1-9][\d.]*)?\s*\)/.test(q)) return false;
    for (const m of q.matchAll(/\((min|max)-width\s*:\s*([^)]+)\)/g)) {
      const n = px(m[2]!);
      if (Number.isNaN(n)) return false;
      if (m[1] === 'min' ? width < n : width > n) return false;
    }
    return true;
  };
  return media.split(',').some((alt) => one(alt.trim().toLowerCase()));
}

/** The last declared value of `prop` for exactly `selector` at `width`. */
export function declared(rules: CssRule[], width: number, selector: string, prop: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if (!rule.selectors.includes(selector) || !mediaMatches(rule.media, width)) continue;
    const v = rule.decls.get(prop);
    if (v !== undefined) value = v;
  }
  return value;
}

function oneTrack(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  if (/^repeat\(\s*1\s*,/.test(v) || v === 'none') return true;
  return v.split(/\s+(?![^(]*\))/).length === 1;
}

/**
 * The stylesheet flattened to the rules that apply at `width`, ready for a
 * <style> element. jsdom computes styles from a document's own style elements
 * but does not evaluate media widths, so media matching happens here through
 * the same mediaMatches the declaration checks use.
 */
export function cssAtWidth(rules: CssRule[], width: number): string {
  const lines: string[] = [];
  for (const rule of rules) {
    if (!mediaMatches(rule.media, width)) continue;
    const decls = [...rule.decls].map(([prop, value]) => `${prop}:${value}`).join(';');
    lines.push(`${rule.selectors.join(',')}{${decls}}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rendering

/** The bundle's runtime and model modules joined into one classic script for the page's own realm. */
export interface PageScript {
  source: string;
}

type FetchMode = 'rows' | 'empty' | 'error';

/** A scripted page fetch: what `win.fetch` receives — (url, init). */
export type PageFetch = (url: unknown, init?: { method?: string; body?: unknown }) => Promise<unknown>;

export interface Win {
  document: Document;
  location: { hash: string; href?: string };
  navigator?: { onLine?: boolean };
  fetch?: unknown;
  CSS?: { escape?(v: string): string };
  eval(source: string): unknown;
  close(): void;
  setTimeout: typeof setTimeout;
  KeyboardEvent: typeof KeyboardEvent;
  MouseEvent: typeof MouseEvent;
  Event: typeof Event;
  matchMedia?: (query: string) => unknown;
  sessionStorage?: Storage;
  dispatchEvent(event: Event): boolean;
  addEventListener(type: string, listener: (event: Event) => void): void;
  getComputedStyle(el: Element): CSSStyleDeclaration;
}

interface JsdomCtor {
  new (html: string, opts: Record<string, unknown>): { window: Win };
}

let jsdomMod: { JSDOM: JsdomCtor; VirtualConsole: new () => unknown } | undefined;

async function jsdom(): Promise<{ JSDOM: JsdomCtor; VirtualConsole: new () => unknown }> {
  if (!jsdomMod) {
    const specifier = 'jsdom';
    try {
      jsdomMod = (await import(specifier)) as typeof jsdomMod;
    } catch {
      throw new Error('ui scorer: jsdom is not installed; run npm ci (it is a dev dependency of this developer tool)');
    }
  }
  return jsdomMod!;
}

// The bundle runs inside each session's jsdom window, as it does in a
// browser: window, document, getComputedStyle and the DOM constructors are
// that window's own from the moment the modules load. Libraries that look for
// a document when they are imported then see one, and nothing leaks onto the
// host's globals or from one session into the next. jsdom evaluates classic
// scripts only, so the two ES modules become one script: each module body is
// wrapped in a function, its exports are returned from it, and the runtime's
// import of the model reads them.

const STATEMENT_START = String.raw`(^|[;}\n])(\s*)`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const SPEC = String.raw`(?<Q>["'\`])([^"'\`]+)\k<Q>`;

function bindings(list: string, sep: 'as' | ':'): Array<[string, string]> {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = new RegExp(String.raw`^(${IDENT})(?:\s+as\s+(${IDENT}))?$`).exec(part);
      if (!m) throw new Error(`ui bundle: unsupported ${sep === 'as' ? 'export' : 'import'} binding "${part}"`);
      return [m[1]!, m[2] ?? m[1]!];
    });
}

/**
 * One ES module's body as a function body that returns its named exports.
 * `resolve` maps a static or dynamic import specifier to the module's own
 * key inside the bundle. Returns the body and the export names; the caller
 * wraps it with `"use strict"`, `__require` and `__importMeta` in scope.
 */
function moduleBody(source: string, who: string, resolve: (spec: string) => string): { body: string; names: string[] } {
  const exported: Array<[string, string]> = [];
  const stars: string[] = [];
  let temp = 0;
  // Adjacent imports can share no separator at all in a minified bundle
  // (`…from"./a.js"import{…}from"./b.js"`): each rewrite ends in a `;`, so
  // the next statement matches on the following pass — run to a fixpoint.
  let body = source;
  const rewriteImports = (): void => {
    body = body
      // export { a as b } from "spec" — a re-export: the module loads and its
      // own names pass through under their exported names.
      .replace(new RegExp(String.raw`${STATEMENT_START}export\s*\{([^}]*)\}\s*from\s*${SPEC}\s*;?`, 'g'), (_m, lead: string, space: string, list: string, _q: string, spec: string) => {
        const local = `__re${temp++}`;
        for (const [name, as] of bindings(list, 'as')) exported.push([as, `${local}.${name}`]);
        return `${lead}${space}const ${local} = __require(${JSON.stringify(resolve(spec))});`;
      })
      // export * from "spec"
      .replace(new RegExp(String.raw`${STATEMENT_START}export\s*\*\s*from\s*${SPEC}\s*;?`, 'g'), (_m, lead: string, space: string, _q: string, spec: string) => {
        stars.push(resolve(spec));
        return `${lead}${space}`;
      })
      // import { a as b } from "spec"
      .replace(new RegExp(String.raw`${STATEMENT_START}import\s*\{([^}]*)\}\s*from\s*${SPEC}\s*;?`, 'g'), (_m, lead: string, space: string, list: string, _q: string, spec: string) => {
        const names = bindings(list, ':').map(([name, local]) => (name === local ? name : `${name}: ${local}`));
        return `${lead}${space}const { ${names.join(', ')} } = __require(${JSON.stringify(resolve(spec))});`;
      })
      // import * as ns from "spec"
      .replace(new RegExp(String.raw`${STATEMENT_START}import\s*\*\s*as\s+(${IDENT})\s*from\s*${SPEC}\s*;?`, 'g'), (_m, lead: string, space: string, ns: string, _q: string, spec: string) => {
        return `${lead}${space}const ${ns} = __require(${JSON.stringify(resolve(spec))});`;
      })
      // import def, { … } from "spec" / import def, * as ns from "spec" / import def from "spec"
      .replace(new RegExp(String.raw`${STATEMENT_START}import\s+(${IDENT})\s*(?:,\s*(\{[^}]*\}|\*\s*as\s+${IDENT})\s*)?from\s*${SPEC}\s*;?`, 'g'), (_m, lead: string, space: string, def: string, rest: string | undefined, _q: string, spec: string) => {
        const local = `__im${temp++}`;
        let out = `const ${local} = __require(${JSON.stringify(resolve(spec))}); const ${def} = ${local}.default;`;
        if (rest?.startsWith('{')) {
          const names = bindings(rest.slice(1, -1), ':').map(([name, l]) => (name === l ? name : `${name}: ${l}`));
          out += ` const { ${names.join(', ')} } = ${local};`;
        } else if (rest) {
          out += ` const ${rest.replace(/^\*\s*as\s+/, '')} = ${local};`;
        }
        return `${lead}${space}${out}`;
      })
      // import "spec" — for its side effects only.
      .replace(new RegExp(String.raw`${STATEMENT_START}import\s*${SPEC}\s*;?`, 'g'), (_m, lead: string, space: string, _q: string, spec: string) => {
        return `${lead}${space}__require(${JSON.stringify(resolve(spec))});`;
      });
  };
  for (let pass = 0; pass < 100; pass++) {
    const before = body;
    rewriteImports();
    if (body === before) break;
  }
  // import("./chunk.js") — a code-split part of the same bundle: it loads
  // through the same module table, as a resolved dynamic import.
  body = body.replace(/\bimport\(\s*(["'`])([^"'`]+)\1\s*\)/g, (_m, _q: string, spec: string) => `Promise.resolve(__require(${JSON.stringify(resolve(spec))}))`);
  if (new RegExp(String.raw`${STATEMENT_START}import\s*[\w$*{"']`).test(body)) throw new Error(`ui bundle: "${who}" has an import form the scorer cannot load`);
  body = body.replace(new RegExp(String.raw`${STATEMENT_START}export\s*\{([^}]*)\}\s*;?`, 'g'), (_m, lead: string, space: string, list: string) => {
    for (const [local, name] of bindings(list, 'as')) exported.push([name, local]);
    return `${lead}${space}`;
  });
  body = body.replace(new RegExp(String.raw`${STATEMENT_START}export\s+((?:async\s+)?function\s*\*?\s*|(?:const|let|var|class)\s+)(${IDENT})`, 'g'), (_m, lead: string, space: string, kind: string, name: string) => {
    exported.push([name, name]);
    return `${lead}${space}${kind}${name}`;
  });
  body = body.replace(new RegExp(String.raw`${STATEMENT_START}export\s+default\s+((?:async\s+)?function\s*\*?\s*|class\s+)(${IDENT})`, 'g'), (_m, lead: string, space: string, kind: string, name: string) => {
    exported.push(['default', name]);
    return `${lead}${space}${kind}${name}`;
  });
  body = body.replace(new RegExp(String.raw`${STATEMENT_START}export\s+default\s+`, 'g'), (_m, lead: string, space: string) => {
    exported.push(['default', '__default']);
    return `${lead}${space}const __default = `;
  });
  if (new RegExp(String.raw`${STATEMENT_START}export\b`).test(body)) throw new Error(`ui bundle: "${who}" has an export form the scorer cannot load`);
  body = body.replace(/\bimport\.meta\b/g, '__importMeta');
  const out = exported.map(([name, local]) => `${JSON.stringify(name)}: ${local}`).join(', ');
  if (stars.length) {
    // export * merges the target's names under the ones the module declares;
    // a `default` never re-exports through a star, and the module's own names
    // win. __exp is filled after the body runs so a `const` export is past its
    // declaration when the literal reads it.
    let merge = `;const __exp = { ${out} };`;
    for (const key of stars) {
      merge += `\n{ const __st = __require(${JSON.stringify(key)}); for (const __k in __st) if (__k !== "default" && !Object.prototype.hasOwnProperty.call(__exp, __k)) __exp[__k] = __st[__k]; }`;
    }
    return { body: `${body}\n${merge}\n;return __exp;`, names: exported.map(([name]) => name) };
  }
  return { body: `${body}\n;return { ${out} };`, names: exported.map(([name]) => name) };
}

/**
 * A module specifier resolved against the bundle's module table, as the
 * browser resolves it against the page: `./` and `../` against the importing
 * module's directory, a leading `/` against the bundle root. A specifier
 * that leaves the bundle — bare, or escaping the bundle directory — or names
 * a file the build did not emit is rejected: the page would 404 on it.
 */
function moduleKey(spec: string, importer: string, modules: Record<string, string>): string {
  const parts = (spec.startsWith('/') ? spec : `${dirname(importer)}/${spec}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (!out.length) throw new Error(`ui bundle: "${spec}" imported by "${importer}" resolves outside the bundle`);
      out.pop();
    } else out.push(part);
  }
  const key = out.join('/');
  if (!(key in modules)) throw new Error(`ui bundle: "${spec}" imported by "${importer}" is not part of the bundle`);
  return key;
}

export function loadRuntime(bundle: UiBundle): PageScript {
  if (!bundle.entry || !(bundle.entry in bundle.modules)) throw new Error('ui bundle: runtime module not found');
  // The bundle's runtime/model fields are the scoring surface tests (and the
  // slate target) edit: they win over the same module under modules[].
  const modules = { ...bundle.modules, [bundle.entry]: bundle.runtime };
  const modelRel = /from\s+["']\.\/(model\.[^"']+\.js)["']/.exec(bundle.runtime)?.[1];
  if (modelRel) {
    const key = `${dirname(bundle.entry) === '.' ? '' : `${dirname(bundle.entry)}/`}${modelRel}`;
    if (key in modules && bundle.model !== modules[key]) modules[key] = bundle.model;
  }
  // Every emitted module compiles once, import specifiers resolved to the
  // bundle's own keys; a specifier that resolves to nothing is rejected at
  // compile time, before the page ever runs.
  const parts: string[] = [];
  let boot = false;
  for (const key of Object.keys(modules)) {
    const url = `new URL(${JSON.stringify(key)}, document.baseURI).href`;
    const { body, names } = moduleBody(modules[key]!, key, (spec) => moduleKey(spec, key, modules));
    if (key === bundle.entry) boot = names.includes('boot');
    parts.push(`${JSON.stringify(key)}: function (__require) {\n"use strict";\nconst __importMeta = Object.freeze({ url: ${url} });\n${body}\n}`);
  }
  if (!boot) throw new Error('ui bundle: runtime has no boot export');
  const source = `(function () {
const __modules = {
${parts.join(',\n')}
};
const __cache = {};
function __require(key) {
  const hit = __cache[key];
  if (hit) return hit.e;
  const fn = __modules[key];
  if (!fn) throw new Error("ui bundle: module " + key + " missing");
  const rec = { e: {} };
  __cache[key] = rec;
  Object.assign(rec.e, fn(__require));
  return rec.e;
}
__require(${JSON.stringify(bundle.entry)});
})();
`;
  return { source };
}

function fakeFetch(mode: FetchMode, sample: Map<string, Record<string, string>>) {
  return async (url: unknown): Promise<unknown> => {
    const path = String(url);
    const reply = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    const report = /\/reports\/([^/?]+)/.exec(path);
    if (report && !/\/actions\//.test(path)) {
      if (mode === 'error') return reply(500, { error: 'unavailable' });
      const row = sample.get(decodeURIComponent(report[1]!));
      return reply(200, { rows: mode === 'rows' && row ? [row] : [] });
    }
    return reply(200, { rows: [], data: [] });
  };
}

// ---------------------------------------------------------------------------
// Scripted fake API for the UX-states checks (tools/ui-states-check.mjs and
// the extended `states` checks below). One server per session; its lane modes
// change between steps so a single boot can drive several scenarios.

/** One recorded call the page made. */
export interface FakeCall {
  path: string;
  method: string;
  body: unknown;
}

/** The endpoint families the generated apps post to. */
export type ApiLane = 'query' | 'submit' | 'remove' | 'record' | 'action' | 'upload' | 'other';

/**
 * What a lane answers: `ok` (the contract reply), `empty` (query only), `error`
 * (500), `slow` (held until `release`), `reject` (a network failure throw),
 * `gone` (404), `denied` (403), `unauth` (401), `field` (a 400 naming a field).
 */
export type LaneMode = 'ok' | 'empty' | 'error' | 'slow' | 'reject' | 'gone' | 'denied' | 'unauth' | 'field';

export interface FakeApi {
  calls: FakeCall[];
  /** Lane → its answer mode; mutate freely between route visits. */
  lane: Record<ApiLane, LaneMode>;
  /** The field name and message a `field` reply carries. */
  fieldError: { field: string; message: string };
  /** Answer a held `slow` call. */
  release(lane: ApiLane): void;
  /** The calls whose path contains `part`. */
  matching(part: string): FakeCall[];
  fetch: PageFetch;
}

function laneOf(path: string): ApiLane {
  if (path.includes('/actions/')) return 'action';
  if (path.includes('/delete')) return 'remove';
  if (path.includes('/submit')) return 'submit';
  if (path.includes('/record')) return 'record';
  if (path.includes('/upload')) return 'upload';
  if (path.includes('/reports/')) return 'query';
  return 'other';
}

export function createFakeApi(sample: Map<string, Record<string, string>>, rows: Record<string, string>[]): FakeApi {
  const calls: FakeCall[] = [];
  const gates = new Map<ApiLane, () => void>();
  const api: FakeApi = {
    calls,
    lane: { query: 'ok', submit: 'ok', remove: 'ok', record: 'ok', action: 'ok', upload: 'ok', other: 'ok' },
    fieldError: { field: '', message: 'Invalid value' },
    release: (lane) => gates.get(lane)?.(),
    matching: (part) => calls.filter((call) => call.path.includes(part)),
    fetch: async (url: unknown, init: { method?: string; body?: unknown } = {}) => {
      const path = String(url);
      let body: unknown = {};
      try {
        body = typeof init.body === 'string' ? JSON.parse(init.body) : (init.body ?? {});
      } catch {
        body = {};
      }
      calls.push({ path, method: String(init.method ?? 'GET').toUpperCase(), body });
      const reply = (status: number, data: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(data),
        json: async () => data,
      });
      const lane = laneOf(path);
      const mode = api.lane[lane];
      if (mode === 'reject') throw new TypeError('fetch failed');
      if (mode === 'slow') await new Promise<void>((resolve) => gates.set(lane, resolve));
      if (mode === 'unauth') return reply(401, { error: 'unauthorized' });
      if (mode === 'denied') return reply(403, { error: 'access denied' });
      if (mode === 'gone') return reply(404, { error: 'not found' });
      if (mode === 'error') return reply(500, { error: 'unavailable' });
      if (mode === 'field') return reply(400, { error: api.fieldError.message, field: api.fieldError.field });
      if (lane === 'query') {
        const report = /\/reports\/([^/?]+)/.exec(path);
        const row = sample.get(decodeURIComponent(report?.[1] ?? ''));
        return reply(200, { rows: mode === 'empty' ? [] : row ? [row] : rows });
      }
      if (lane === 'record') return reply(200, { record: rows[0] ?? [...sample.values()][0] ?? null });
      if (lane === 'remove' || lane === 'submit' || lane === 'action') return reply(200, { ok: true, dryRun: false });
      if (lane === 'upload') return reply(200, { reference: { key: 'fake/1' } });
      return reply(200, { rows: [], data: [] });
    },
  };
  return api;
}

export async function settle(win: Win, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => win.setTimeout(resolve, 0));
}

export interface Session {
  win: Win;
  doc: Document;
  go(hash: string): Promise<void>;
  /** Rendered at `vp`: no hidden attribute, no display:none or visibility:hidden/collapse, and no paint-killing style (near-zero opacity, a zero scale, a far-negative text indent, a shrunk clip or clip-path, a clipped box small on either axis, a far-offscreen offset) on the element or an ancestor, per the bundle stylesheet at that viewport's width. */
  shown(el: Element | null | undefined, vp: Viewport): boolean;
  /** The normalized text that is actually rendered at `vp`. */
  visibleText(root: Element | null | undefined, vp: Viewport): string;
  close(): void;
}

export async function openSession(
  bundle: UiBundle,
  page: PageScript,
  mode: FetchMode | PageFetch,
  sample: Map<string, Record<string, string>>,
  widthCss: Record<Viewport, string>,
  setup?: (win: Win) => void,
): Promise<Session> {
  const { JSDOM, VirtualConsole } = await jsdom();
  // A fresh window per session: each one evaluates the bundle anew, so no
  // module state carries over from one session to the next.
  const dom = new JSDOM(bundle.html, { url: 'https://app.example.test/', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const win = dom.window;
  win.fetch = typeof mode === 'function' ? mode : fakeFetch(mode, sample);
  // jsdom has no CSS namespace; browsers define CSS.escape on every page.
  if (typeof win.CSS?.escape !== 'function') win.CSS = { ...win.CSS, escape: cssEscape };
  // The bundle stylesheet is a link jsdom never fetches, so the scorer loads it
  // as a style element — one viewport's rules at a time — and computed styles
  // then answer "is this actually rendered at that width".
  const probe = win.document.createElement('style');
  probe.textContent = widthCss.desktop;
  (win.document.head ?? win.document.documentElement).appendChild(probe);
  setup?.(win);
  try {
    win.eval(page.source);
  } catch (err) {
    win.close();
    throw err;
  }
  await settle(win);
  let active: Viewport | undefined;
  const selfShown: Record<Viewport, WeakMap<Element, boolean>> = { desktop: new WeakMap(), phone: new WeakMap() };
  const shownSelf = (node: Element): boolean => {
    if (node.hasAttribute('hidden')) return false;
    const style = win.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    // An element that paints nothing for a sighted user is not shown, and it
    // takes its whole subtree with it (opacity and clipping apply to children).
    if (parseFloat(style.opacity || '1') < 0.01) return false;
    const transform = style.getPropertyValue('transform') || style.transform || '';
    if (transformHides(transform)) return false;
    const textIndent = px(style.textIndent);
    if (!Number.isNaN(textIndent) && textIndent <= -999) return false;
    const indentViewport = /^(-[\d.]+)(vw|vh)$/i.exec(style.textIndent.trim());
    if (indentViewport && parseFloat(indentViewport[1]!) <= -50) return false;
    if ((style.position === 'absolute' || style.position === 'fixed') && clipRectHides(style.clip)) return false;
    if (clipPathHides(style.getPropertyValue('clip-path') || style.clipPath || '')) return false;
    if (tinyBoxHides(style, () => (node.parentElement ? win.getComputedStyle(node.parentElement) : null))) return false;
    if (offscreenHides(style)) return false;
    return true;
  };
  const shown = (el: Element | null | undefined, vp: Viewport): boolean => {
    if (!el) return false;
    if (active !== vp) {
      probe.textContent = widthCss[vp];
      active = vp;
    }
    for (let node: Element | null = el; node; node = node.parentElement) {
      const cache = selfShown[vp];
      const hit = cache.get(node);
      const ok = hit ?? shownSelf(node);
      if (hit === undefined) cache.set(node, ok);
      if (!ok) return false;
    }
    return true;
  };
  // Text paints only when its ink does: font-size:0 and a transparent colour
  // hide text the way `hidden` does, and both inherit until a nearer element
  // sets a real value. The box itself stays shown — only the text is gone.
  const textInk: Record<Viewport, WeakMap<Element, { size: number | undefined; opaque: boolean }>> = { desktop: new WeakMap(), phone: new WeakMap() };
  const inkOf = (el: Element, vp: Viewport): { size: number | undefined; opaque: boolean } => {
    const cache = textInk[vp];
    const hit = cache.get(el);
    if (hit) return hit;
    const base = el.parentElement ? inkOf(el.parentElement, vp) : { size: undefined, opaque: true };
    const style = win.getComputedStyle(el);
    const size = px(style.fontSize);
    const color = style.color.trim().toLowerCase();
    const own = color !== '' && color !== 'canvastext' && color !== 'inherit' && color !== 'currentcolor';
    const out = {
      size: Number.isNaN(size) ? base.size : size,
      opaque: own ? !transparentText(color) : base.opaque,
    };
    cache.set(el, out);
    return out;
  };
  const visibleText = (root: Element | null | undefined, vp: Viewport): string => {
    if (!root || !shown(root, vp)) return '';
    const text: string[] = [];
    const walker = win.document.createTreeWalker(root, 0x4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !shown(parent, vp)) continue;
      const ink = inkOf(parent, vp);
      if (ink.size !== 0 && ink.opaque) text.push(node.textContent ?? '');
    }
    return norm(text.join(' '));
  };
  return {
    win,
    doc: win.document,
    go: async (hash: string) => {
      win.location.hash = hash;
      await settle(win);
    },
    shown,
    visibleText,
    close: () => win.close(),
  };
}

// ---------------------------------------------------------------------------
// Checks

export interface Check {
  criterion: string;
  viewport: Viewport | 'both';
  id: string;
  pass: boolean;
  evidence: string;
  /**
   * Measured but not counted: the UX-states rows (each owned by a
   * tracked issue, see states.ts) are reported in `checks` so the sweep shows the gap, but they
   * stay out of the criterion's passed/total until the issue is fixed and the
   * row flips to scored. Without the flag, scores would drop on states no fix
   * has shipped for yet.
   */
  unscored?: boolean;
}

export interface CriterionScore {
  id: string;
  title: string;
  weight: number;
  passed: number;
  total: number;
  points: number;
  failures: string[];
}

export interface ViewportScore {
  score: number;
  pass: boolean;
  criteria: CriterionScore[];
}

export interface UiScore {
  app: string;
  rubricVersion: number;
  passBar: number;
  desktop: ViewportScore;
  phone: ViewportScore;
  /** The lower of the two: the number a gate compares to the bar. */
  score: number;
  pass: boolean;
  checks: Check[];
}

export function norm(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/[*_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function textOf(el: Element | null | undefined): string {
  return norm(el?.textContent);
}

function routeOf(href: string | null): string | undefined {
  const m = /#\/(form|report|page)\/([^/?#]+)$/.exec(href ?? '');
  return m ? `${m[1]}/${decodeURIComponent(m[2]!)}` : undefined;
}

function hrefFor(kind: string, name: string): string {
  return `#/${kind}/${encodeURIComponent(name)}`;
}

function accessibleName(el: Element, doc: Document): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const id = el.getAttribute('id');
  if (id) {
    for (const label of Array.from(doc.querySelectorAll('label'))) {
      if (label.getAttribute('for') === id && label.textContent?.trim()) return label.textContent.trim();
    }
  }
  const wrap = el.closest('label');
  if (wrap && wrap.textContent?.trim()) return wrap.textContent.trim();
  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'A') {
    const own = el.textContent?.trim();
    if (own) return own;
  }
  if (el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox') {
    const own = el.textContent?.trim();
    if (own) return own;
  }
  if (tag === 'INPUT' && /^(submit|reset|button)$/i.test(el.getAttribute('type') ?? '')) {
    const v = el.getAttribute('value');
    if (v && v.trim()) return v.trim();
  }
  return (el.getAttribute('title') ?? '').trim();
}

const CONTROL = 'input:not([type="hidden"]), select, textarea, [contenteditable="true"]';

/** A semantic control must be exposed, named, and reachable by keyboard. */
function eligibleControl(el: Element, doc: Document): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false;
  }
  if (!accessibleName(el, doc)) return false;
  if (el.getAttribute('role') === 'radiogroup') return false;
  if (el.hasAttribute('tabindex')) return Number(el.getAttribute('tabindex')) >= 0;
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  if (el.tagName === 'A') return el.hasAttribute('href');
  if (['BUTTON', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return true;
  if (el.tagName === 'INPUT') return (el.getAttribute('type') ?? 'text').toLowerCase() !== 'hidden';
  if (el.getAttribute('contenteditable') === 'true') return true;
  return false;
}

function fieldContainer(form: Element, name: string): Element | null {
  for (const el of Array.from(form.querySelectorAll('[data-field]'))) if (el.getAttribute('data-field') === name) return el;
  for (const el of Array.from(form.querySelectorAll('[name]'))) {
    const n = el.getAttribute('name') ?? '';
    if (n === name || n.startsWith(`${name}.`) || n.startsWith(`${name}[`)) return el.closest('[data-field], .field, fieldset, div') ?? el;
  }
  return null;
}

function controlSuits(kind: FieldKind, box: Element, rendered: (el: Element) => boolean = () => true): boolean {
  const doc = box.ownerDocument;
  const controls = Array.from(box.querySelectorAll(CONTROL)).concat(box.matches(CONTROL) ? [box] : []).filter((el) => rendered(el) && eligibleControl(el, doc));
  const types = controls.map((c) => (c.tagName === 'INPUT' ? (c.getAttribute('type') ?? 'text').toLowerCase() : c.tagName.toLowerCase()));
  const has = (pred: (t: string, el: Element) => boolean): boolean => controls.some((c, i) => pred(types[i]!, c));
  const sees = (selector: string): boolean => Array.from(box.querySelectorAll(selector)).some((el) => rendered(el) && eligibleControl(el, doc));
  // A rendered popup trigger opens the field's options: the Arc Select,
  // MultiSelect, DatePicker and TimePicker triggers carry these semantics. A
  // closed popup is not in the DOM — the real DatePicker renders no
  // aria-controls and the MultiSelect and TimePicker listboxes exist only
  // while open — so the trigger is credited on its own terms: a popup kind
  // that fits the field, and a name the field's own labelling gives it inside
  // the box.
  const POPUP_KINDS: Partial<Record<FieldKind, string[]>> = {
    text: ['dialog', 'listbox', 'grid'],
    choice: ['listbox'],
    multichoice: ['listbox'],
  };
  // The trigger is this field's control when the field's own labelling gives
  // it its name: a label-for inside the box, an aria-labelledby pointing at
  // a label element inside the box, or a label wrapped around it.
  const namedByField = (el: Element): boolean => {
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    if (labelledBy.some((id) => { const target = doc.getElementById(id); return !!target && box.contains(target) && !el.contains(target); })) return true;
    const id = el.getAttribute('id');
    if (id && Array.from(box.querySelectorAll('label')).some((label) => label.getAttribute('for') === id)) return true;
    const wrap = el.closest('label');
    return !!wrap && box.contains(wrap);
  };
  const popupTrigger = (): boolean => Array.from(box.querySelectorAll('button[aria-haspopup][aria-expanded], [role="combobox"][aria-expanded]')).some((trigger) => {
    if (!rendered(trigger) || !eligibleControl(trigger, doc)) return false;
    // role=combobox's implicit popup is a listbox; aria-haspopup="true" means a menu.
    const haspopup = (trigger.getAttribute('aria-haspopup') ?? (trigger.getAttribute('role') === 'combobox' ? 'listbox' : '')).toLowerCase();
    if (!(POPUP_KINDS[kind] ?? []).includes(haspopup === 'true' ? 'menu' : haspopup)) return false;
    return namedByField(trigger);
  });
  switch (kind) {
    case 'text':
      return has((t) => !['checkbox', 'radio', 'file', 'submit', 'button', 'reset'].includes(t)) || popupTrigger();
    case 'longtext':
      return has((t, el) => t === 'textarea' || el.getAttribute('contenteditable') === 'true' || t === 'text');
    case 'choice':
      return has((t) => t === 'select' || t === 'radio' || t === 'text' || t === 'search') || popupTrigger() || sees('[role="radio"]');
    case 'multichoice':
      return has((t, el) => (t === 'select' && el.hasAttribute('multiple')) || t === 'checkbox' || t === 'select') || popupTrigger();
    case 'decision':
      // Radix renders a decision as a button with the checkbox role.
      return has((t) => t === 'checkbox') || sees('[role="checkbox"]');
    case 'file':
      // The dropzone button delegates to its mirror file input on click.
      return has((t) => t === 'file') || sees('canvas') || fileControlProxy(box, rendered) || (sees('button') && box.querySelector('input[type="file"]') !== null);
    case 'composite':
      return controls.length >= 2;
    case 'subform':
      return sees('table, fieldset, [data-subform], button') || controls.length > 0;
    case 'computed':
    case 'other':
      return true;
    default:
      return true;
  }
}

/** A file input hidden from sight still suits a file field when a rendered label activates it. */
function fileControlProxy(box: Element, rendered: (el: Element) => boolean): boolean {
  return Array.from(box.querySelectorAll('label')).some((label) => {
    if (!rendered(label)) return false;
    const id = label.getAttribute('for');
    const target = id ? label.ownerDocument.getElementById(id) : label.querySelector('input[type="file"]');
    return !!target && box.contains(target) && target.tagName === 'INPUT' && (target.getAttribute('type') ?? '').toLowerCase() === 'file';
  });
}

function isRequiredMarked(box: Element): boolean {
  // Custom groups mark the field on their container: RadioCards on its
  // radiogroup, the Radix decision on its checkbox button.
  const doc = box.ownerDocument;
  const eligible = (selector: string): Element[] => Array.from(box.querySelectorAll(selector)).filter((el) => eligibleControl(el, doc));
  const nativeMarked = eligible(CONTROL).some((c) => c.hasAttribute('required') || c.getAttribute('aria-required') === 'true');
  const checkboxMarked = eligible('[role="checkbox"][aria-required="true"]').length > 0;
  // aria-required is supported on input-like roles only; on a role it does
  // not fit — a plain menu button, say — it marks nothing.
  const REQUIRED_ROLES = new Set(['checkbox', 'combobox', 'gridcell', 'listbox', 'radio', 'radiogroup', 'spinbutton', 'switch', 'textbox', 'tree']);
  const accessibleMarked = eligible('[aria-required="true"]').some((el) => REQUIRED_ROLES.has(el.getAttribute('role') ?? ''));
  const radioGroups = Array.from(box.querySelectorAll('[role="radiogroup"][aria-required="true"]')).filter((group) => {
    for (let node: Element | null = group; node; node = node.parentElement) {
      if (node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  });
  const hasAccessibleRadio = radioGroups.some((group) => Array.from(group.querySelectorAll('[role="radio"]')).some((radio) => eligibleControl(radio, doc)));
  return nativeMarked || checkboxMarked || accessibleMarked || hasAccessibleRadio;
}

/** CSS.escape as browsers define it: the runtime calls it as a page global, which jsdom lacks. */
function cssEscape(value: string): string {
  return String(value)
    .replace(/[^\w\u00a0-\uffff-]/g, (ch) => `\\${ch}`)
    .replace(/^(-?)(\d)/, (_m, dash: string, digit: string) => `${dash}\\3${digit} `);
}

export async function scoreUi(app: App, bundle: UiBundle, opts: { rubric?: Rubric; ui?: 'react' | 'vanilla' } = {}): Promise<UiScore> {
  const rubric = opts.rubric ?? loadRubric();
  const exp = expectedFromIr(app);
  const checks: Check[] = [];
  const add = (criterion: string, viewport: Check['viewport'], id: string, pass: boolean, evidence: string, unscored?: boolean): void => {
    checks.push({ criterion, viewport, id, pass, evidence, ...(unscored ? { unscored } : {}) });
  };
  // A check about what is rendered is evaluated at each viewport: an element
  // hidden at one width fails there and stays credited at the other.
  const addBoth = (criterion: string, id: string, pass: (vp: Viewport) => boolean, evidence: (vp: Viewport) => string): void => {
    for (const vp of VIEWPORTS) add(criterion, vp, id, pass(vp), evidence(vp));
  };
  const rules = parseCss(bundle.css);
  const W = { desktop: rubric.viewports.desktop.width, phone: rubric.viewports.phone.width };
  const widthCss: Record<Viewport, string> = { desktop: cssAtWidth(rules, W.desktop), phone: cssAtWidth(rules, W.phone) };

  let loaded: PageScript | undefined;
  try {
    loaded = loadRuntime(bundle);
  } catch (err) {
    add('layout', 'both', 'runtime', false, `the bundle does not load: ${(err as Error).message}`);
  }
  const sample = new Map<string, Record<string, string>>();
  for (const r of app.reports) {
    const row: Record<string, string> = { ROWID: '1001' };
    for (const f of app.forms.find((x) => x.name === r.form)?.fields ?? []) row[f.name] = sampleValue(f.name);
    for (const c of r.columns) if (c.field) row[c.field] = sampleValue(c.field);
    sample.set(r.name, row);
  }

  // ---- document-level (both viewports)
  const { JSDOM, VirtualConsole } = await jsdom();
  const shell = new JSDOM(bundle.html, { url: 'https://app.example.test/', virtualConsole: new VirtualConsole() }).window;
  const sdoc = shell.document;
  add('accessibility', 'both', 'lang', !!sdoc.documentElement.getAttribute('lang'), 'html lang attribute');
  add('accessibility', 'both', 'title', norm(sdoc.title) !== '', `document title "${sdoc.title}"`);
  const skip = Array.from(sdoc.querySelectorAll('a[href^="#"]')).find((a) => {
    const target = (a.getAttribute('href') ?? '').slice(1);
    const el = target && !target.startsWith('/') ? sdoc.getElementById(target) : null;
    return el !== null && (el.tagName === 'MAIN' || el.getAttribute('role') === 'main');
  });
  add('accessibility', 'both', 'skip-link', !!skip, 'a skip link to the main landmark');
  const viewport = sdoc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
  add('responsive', 'both', 'viewport-meta', /width\s*=\s*device-width/.test(viewport), `viewport meta "${viewport}"`);
  shell.close();

  // ---- CSS at each width
  const menuShown = (w: number): boolean => declared(rules, w, '#nav', 'display') !== 'none';
  const tabbarShown = (w: number): boolean => {
    const d = declared(rules, w, '#tabbar', 'display');
    return d !== undefined && d !== 'none';
  };
  add('responsive', 'desktop', 'desktop-menu', menuShown(W.desktop) && !tabbarShown(W.desktop), `at ${W.desktop}px: menu ${menuShown(W.desktop) ? 'shown' : 'hidden'}, tab bar ${tabbarShown(W.desktop) ? 'shown' : 'hidden'}`);
  const sheetPos = declared(rules, W.phone, '#more-sheet', 'position');
  add('responsive', 'phone', 'more-overlay', sheetPos === 'fixed', `More sheet position ${sheetPos ?? 'unset'}`);
  const theadHidden = declared(rules, W.phone, '[data-report] thead', 'display') === 'none';
  const tableScroll = /auto|scroll/.test(declared(rules, W.phone, '.table-wrap', 'overflow-x') ?? '');
  add('responsive', 'phone', 'report-fit', theadHidden || tableScroll, theadHidden ? 'report rows become cards' : tableScroll ? 'report table scrolls sideways' : 'report table neither stacks nor scrolls');

  let rowsS: Session | undefined;
  if (loaded) {
    try {
      rowsS = await openSession(bundle, loaded, 'rows', sample, widthCss);
    } catch (err) {
      add('layout', 'both', 'runtime', false, `the bundle does not boot: ${(err as Error).message}`);
    }
  }
  if (!loaded || !rowsS) {
    // Nothing rendered: every criterion that needs the page fails, rather
    // than counting as met for want of a check.
    for (const id of ['navigation', 'forms', 'reports', 'actions', 'states']) add(id, 'both', `unrendered:${id}`, false, 'the bundle does not render');
    add('responsive', 'phone', 'phone-tabbar', false, 'the bundle does not render a tab bar');
    return finish(app, rubric, checks);
  }

  // ---- rows session: nav, forms, reports, actions, a11y per route
  const doc = rowsS.doc;
  const shown = rowsS.shown;
  const visibleText = rowsS.visibleText;
  add('layout', 'both', 'app-title', textOf(doc.getElementById('app-title')) === norm(exp.title) || norm(doc.title) === norm(exp.title), `app title "${doc.getElementById('app-title')?.textContent ?? doc.title}" vs Creator "${exp.title}"`);
  const navEl = doc.getElementById('nav') ?? doc.querySelector('nav');
  const tabbar = doc.getElementById('tabbar');
  const sheet = doc.getElementById('more-sheet');
  for (const landmark of Array.from(doc.querySelectorAll('nav'))) {
    if (landmark.closest('main')) continue;
    add('accessibility', 'both', `nav-name:${landmark.id || 'nav'}`, accessibleName(landmark, doc) !== '', `navigation landmark #${landmark.id || '?'} has a name`);
  }

  // Desktop menu.
  const navLinks = new Map<string, Element>();
  for (const a of Array.from(navEl?.querySelectorAll('a[href]') ?? [])) {
    const r = routeOf(a.getAttribute('href'));
    if (r && !navLinks.has(r)) navLinks.set(r, a);
  }
  const navText = visibleText(navEl, 'desktop');
  for (const section of exp.sections) {
    const grouped = exp.sections.length > 1 || section.items.length > 1;
    if (grouped) add('navigation', 'desktop', `section:${section.label}`, navText.includes(norm(section.label)), `menu group "${section.label}"`);
    for (const item of section.items) {
      const link = navLinks.get(`${item.kind}/${item.name}`);
      const linkShown = !!link && shown(link, 'desktop');
      const linkText = linkShown ? visibleText(link!, 'desktop') : '';
      add('navigation', 'desktop', `link:${item.kind}/${item.name}`, linkShown && linkText.includes(norm(item.label)), link ? (linkShown ? `menu link "${link.textContent?.trim()}" for ${item.kind} "${item.label}"` : `menu link for ${item.kind} "${item.label}" hidden at ${W.desktop}px`) : `no menu link for ${item.kind} "${item.label}"`);
    }
  }

  // Phone tab bar and More. A tab bar the stylesheet hides at phone width
  // offers nothing there.
  const allItems = exp.sections.flatMap((s) => s.items);
  const tabbarVisible = tabbarShown(W.phone) && !!tabbar && tabbar.children.length > 0 && shown(tabbar, 'phone');
  add('responsive', 'phone', 'phone-tabbar', !menuShown(W.phone) && tabbarVisible, `at ${W.phone}px: menu ${menuShown(W.phone) ? 'shown' : 'hidden'}, tab bar ${tabbarVisible ? 'shown' : tabbar?.children.length ? 'hidden' : 'absent or empty'}`);
  const tabEntries = tabbarVisible ? Array.from(tabbar.querySelectorAll('a[href], button')).filter((t) => shown(t, 'phone')) : [];
  add('navigation', 'phone', 'tab-count', tabEntries.length >= 1 && tabEntries.length <= 5, tabbarVisible ? `${tabEntries.length} tab bar entries` : `no tab bar at ${W.phone}px`);
  const unnamedTabs = tabEntries.filter((t) => accessibleName(t, doc) === '');
  add('navigation', 'phone', 'tab-names', tabEntries.length > 0 && unnamedTabs.length === 0, `${unnamedTabs.length} tab bar entries without a name`);
  const reachable = new Set<string>();
  const tabLinks = tabEntries.filter((t) => t.tagName === 'A');
  for (const a of tabLinks) {
    const r = routeOf(a.getAttribute('href'));
    if (r) reachable.add(r);
  }
  const more = tabEntries.find((t) => t.matches('[data-more], [aria-haspopup], [aria-controls="more-sheet"]')) ?? null;
  if (allItems.length > tabLinks.length) {
    let opened = false;
    let closed = false;
    if (more && sheet) {
      (more as HTMLElement).click();
      opened = !sheet.hidden && more.getAttribute('aria-expanded') === 'true';
      // The sheet's links count only behind a More control that opens it, and
      // only while it is open: a hidden sheet hides its links.
      if (opened) {
        for (const a of Array.from(sheet.querySelectorAll('a[href]'))) {
          const r = routeOf(a.getAttribute('href'));
          if (r && shown(a, 'phone')) reachable.add(r);
        }
      }
      doc.dispatchEvent(new rowsS.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      closed = sheet.hidden && more.getAttribute('aria-expanded') !== 'true';
    }
    add('navigation', 'phone', 'more', opened && closed, !more ? 'no More control for the destinations beyond the tab bar' : `More opens ${opened ? 'yes' : 'no'}, Escape closes ${closed ? 'yes' : 'no'}`);
    add('accessibility', 'phone', 'more-aria', !!more && more.hasAttribute('aria-haspopup') && more.hasAttribute('aria-expanded') && !!sheet && (sheet.getAttribute('role') === 'dialog' || sheet.tagName === 'DIALOG'), 'More control states its popup; the sheet is a dialog');
  }
  for (const item of allItems) {
    const key = `${item.kind}/${item.name}`;
    add('navigation', 'phone', `reach:${key}`, reachable.has(key), reachable.has(key) ? `${item.kind} "${item.label}" reachable on phone` : `${item.kind} "${item.label}" is neither a tab nor in More`);
  }

  // Routes.
  const auditRoute = (where: string): void => {
    const main = doc.getElementById('main') ?? doc.body;
    // A control hidden at the evaluated width leaves the accessibility tree;
    // it is the presence checks' job to fail for it, not this one's.
    const controls = Array.from(main.querySelectorAll(`${CONTROL}, button`));
    for (const vp of VIEWPORTS) {
      const unnamed: string[] = [];
      for (const el of controls) {
        if (shown(el, vp) && accessibleName(el, doc) === '') unnamed.push(el.getAttribute('name') ?? el.getAttribute('data-field') ?? el.tagName.toLowerCase());
      }
      add('accessibility', vp, `names:${where}`, unnamed.length === 0, unnamed.length ? `${where}: ${unnamed.length} unnamed control(s): ${unnamed.slice(0, 5).join(', ')}` : `${where}: every control named`);
    }
    const ids = new Map<string, number>();
    for (const el of Array.from(doc.querySelectorAll('[id]'))) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    const dup = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
    add('accessibility', 'both', `ids:${where}`, dup.length === 0, dup.length ? `${where}: repeated ids ${dup.slice(0, 5).join(', ')}` : `${where}: ids unique`);
    const todos = main.querySelectorAll('.todo').length;
    add('layout', 'both', `placeholder:${where}`, todos === 0, todos ? `${where}: ${todos} not-generated placeholder(s)` : `${where}: no placeholders`);
  };
  // The menu may be repainted after a route change, so read it live.
  const currentMarked = (key: string): boolean => {
    const live = doc.getElementById('nav') ?? doc.querySelector('nav');
    return Array.from(live?.querySelectorAll('a[href]') ?? []).some((a) => routeOf(a.getAttribute('href')) === key && a.getAttribute('aria-current') === 'page');
  };

  const layouts = new Set<string>();
  for (const form of exp.forms) {
    await rowsS.go(hrefFor('form', form.name));
    const main = doc.getElementById('main') ?? doc.body;
    const el = Array.from(main.querySelectorAll('form[data-form]')).find((f) => f.getAttribute('data-form') === form.name) ?? main.querySelector('form');
    const where = `form ${form.label}`;
    const formHeading = main.querySelector('h1, h2');
    addBoth(
      'forms',
      `form:${form.name}`,
      (vp) => !!el && shown(el, vp) && !!formHeading && shown(formHeading, vp) && visibleText(formHeading, vp).includes(norm(form.label)),
      (vp) => (!el ? `${where}: no form rendered` : !shown(el, vp) || (formHeading && !shown(formHeading, vp)) ? `${where}: hidden at ${W[vp]}px` : `${where}: heading "${visibleText(formHeading, vp)}"`),
    );
    if (navLinks.has(`form/${form.name}`)) add('navigation', 'desktop', `current:form/${form.name}`, currentMarked(`form/${form.name}`), `${where}: menu link marked current`);
    if (!el) continue;
    const layout = el.getAttribute('data-layout');
    if (layout) layouts.add(layout);
    const order: number[] = [];
    const domFields = Array.from(el.querySelectorAll('[data-field]')).map((x) => x.getAttribute('data-field'));
    for (const field of form.fields) {
      const fw = `${where} / ${field.label}`;
      if (field.kind === 'section') {
        if (norm(field.label) !== 'section' && field.label !== humanize(field.name)) {
          addBoth('layout', `section:${form.name}.${field.name}`, (vp) => visibleText(el, vp).includes(norm(field.label)), () => `${fw}: section heading`);
        }
        continue;
      }
      if (field.kind === 'notes') continue;
      const box = fieldContainer(el, field.name);
      addBoth('forms', `field:${form.name}.${field.name}`, (vp) => !!box && shown(box, vp), (vp) => (box ? (shown(box, vp) ? `${fw}: present` : `${fw}: hidden at ${W[vp]}px`) : `${fw}: missing`));
      if (!box) continue;
      const pos = domFields.indexOf(field.name);
      if (pos >= 0) order.push(pos);
      if (field.kind === 'computed') continue;
      addBoth('forms', `control:${form.name}.${field.name}`, (vp) => shown(box, vp) && controlSuits(field.kind, box, (c) => shown(c, vp)), (vp) => (shown(box, vp) ? `${fw}: control for a ${field.kind} field` : `${fw}: field hidden at ${W[vp]}px`));
      // The label must be rendered text at the field; an accessible-name
      // attribute alone still counts for `names:` but not here.
      const labelEl = box.querySelector('label, legend, .field-title');
      addBoth(
        'forms',
        `label:${form.name}.${field.name}`,
        (vp) => !!labelEl && shown(labelEl, vp) && visibleText(labelEl, vp).includes(norm(field.label)),
        (vp) => (!labelEl ? `${fw}: no rendered label` : shown(labelEl, vp) ? `${fw}: label "${visibleText(labelEl, vp)}"` : `${fw}: label hidden at ${W[vp]}px`),
      );
      if (field.required) add('forms', 'both', `required:${form.name}.${field.name}`, isRequiredMarked(box), `${fw}: mandatory marked`);
    }
    const ordered = order.every((v, i) => i === 0 || v > order[i - 1]!);
    add('layout', 'both', `order:${form.name}`, ordered, ordered ? `${where}: fields in Creator order` : `${where}: fields out of Creator order`);
    const submit = el.querySelector('button[type="submit"], input[type="submit"]');
    addBoth('actions', `submit:${form.name}`, (vp) => !!submit && shown(submit, vp), () => `${where}: submit button`);
    const buttons = Array.from(el.querySelectorAll('button, input[type="submit"], input[type="reset"]'));
    for (const label of form.buttons) {
      addBoth(
        'actions',
        `button:${form.name}.${label}`,
        (vp) => buttons.some((b) => shown(b, vp) && (norm(accessibleName(b, doc)) === norm(label) || norm(accessibleName(b, doc)).includes(norm(label)))),
        () => `${where}: button "${label}"`,
      );
    }
    auditRoute(where);
  }

  for (const report of exp.reports) {
    await rowsS.go(hrefFor('report', report.name));
    const main = doc.getElementById('main') ?? doc.body;
    const sec = Array.from(main.querySelectorAll('[data-report]')).find((s) => s.getAttribute('data-report') === report.name) ?? null;
    const where = `report ${report.label}`;
    const reportHeading = main.querySelector('h1, h2');
    addBoth(
      'reports',
      `report:${report.name}`,
      (vp) => !!sec && shown(sec, vp) && !!reportHeading && shown(reportHeading, vp) && visibleText(reportHeading, vp).includes(norm(report.label)),
      (vp) => (!sec ? `${where}: no report rendered` : !shown(sec, vp) || (reportHeading && !shown(reportHeading, vp)) ? `${where}: hidden at ${W[vp]}px` : `${where}: heading "${visibleText(reportHeading, vp)}"`),
    );
    if (navLinks.has(`report/${report.name}`)) add('navigation', 'desktop', `current:report/${report.name}`, currentMarked(`report/${report.name}`), `${where}: menu link marked current`);
    if (!sec) continue;
    if (report.chart) {
      const chartArea = sec.querySelector('svg, canvas, [data-chart], table');
      addBoth('reports', `chart:${report.name}`, (vp) => !!chartArea && shown(chartArea, vp), () => `${where}: chart area`);
    } else {
      // A table names a column in its header; a board card (kanban,
      // calendar, timeline) shows the value, so either counts there. Only
      // text rendered at the evaluated width counts.
      const board = sec.querySelector('[data-board]');
      const shownOnBoard = (col: ExpectedColumn, vp: Viewport): boolean => {
        if (!board) return false;
        const boardText = visibleText(board, vp);
        return boardText.includes(norm(col.label)) || boardText.includes(norm(sampleValue(col.field)));
      };
      const headText = visibleText(sec.querySelector('thead') ?? sec, 'desktop');
      for (const col of report.columns) {
        add('reports', 'desktop', `col:${report.name}.${col.field}`, headText.includes(norm(col.label)) || shownOnBoard(col, 'desktop'), `${where}: column "${col.label}"`);
      }
      const cells = Array.from(sec.querySelectorAll('tbody tr:first-child td'));
      const phoneText = visibleText(sec, 'phone');
      for (const col of report.phoneColumns) {
        const n = norm(col.label);
        const ok = board ? shownOnBoard(col, 'phone') : theadHidden ? cells.some((td) => norm(td.getAttribute('data-th')) === n && shown(td, 'phone')) : phoneText.includes(n);
        add('reports', 'phone', `pcol:${report.name}.${col.field}`, ok, `${where}: phone card shows "${col.label}"`);
      }
      if (report.form) {
        const row = sec.querySelector('tbody tr, [data-board] [data-row], [data-board] article, [data-board] li');
        // A record can open from anything rendered that activates it: a
        // focusable row opens its record on tap, and any link, button or
        // focusable element inside it does. Judging only the first inner
        // match mistakes an action cell hidden at this width for a missing
        // opener.
        const openers = row ? [...(row.hasAttribute('tabindex') ? [row] : []), ...Array.from(row.querySelectorAll('a[href], button, [tabindex]'))] : [];
        addBoth('actions', `record:${report.name}`, (vp) => openers.some((o) => shown(o, vp)), (vp) => {
          const opener = openers.find((o) => shown(o, vp)) ?? openers[0];
          return opener ? `${where}: a record opens from <${opener.tagName.toLowerCase()}>` : `${where}: records have no open or edit control`;
        });
      }
    }
    const buttons = Array.from(sec.querySelectorAll('button, a'));
    for (const action of report.actions) {
      addBoth('actions', `action:${report.name}.${action}`, (vp) => buttons.some((b) => shown(b, vp) && norm(accessibleName(b, doc)) === norm(action)), () => `${where}: custom action "${action}"`);
    }
    auditRoute(where);
  }

  for (const page of exp.pages) {
    await rowsS.go(hrefFor('page', page.name));
    const main = doc.getElementById('main') ?? doc.body;
    const where = `page ${page.label}`;
    addBoth('layout', `page:${page.name}`, (vp) => visibleText(main, vp) !== '' || Array.from(main.children).some((c) => shown(c, vp)), () => `${where}: renders content`);
    auditRoute(where);
  }
  rowsS.close();

  // Phone form layout: a multi-column form collapses to one column.
  for (const layout of [...layouts].sort()) {
    if (layout === 'one') continue;
    const sel = `[data-layout="${layout}"] .form-grid`;
    const value = declared(rules, W.phone, sel, 'grid-template-columns') ?? declared(rules, W.phone, '.form-grid', 'grid-template-columns');
    add('layout', 'phone', `stack:${layout}`, oneTrack(value), `"${layout}" column forms at ${W.phone}px: grid-template-columns ${value ?? 'unset'}`);
  }

  // ---- empty and error states, and the form validation message
  const tableReports = exp.reports.filter((r) => !r.chart);
  if (tableReports.length) {
    const emptyS = await openSession(bundle, loaded, 'empty', sample, widthCss);
    for (const report of tableReports) {
      await emptyS.go(hrefFor('report', report.name));
      const main = emptyS.doc.getElementById('main') ?? emptyS.doc.body;
      const state = main.querySelector('[data-state="empty"]');
      const emptyOk = (vp: Viewport): boolean => (!!state && emptyS.shown(state, vp)) || /no records|no data|nothing/i.test(emptyS.visibleText(main, vp));
      addBoth('states', `empty:${report.name}`, emptyOk, (vp) => `report ${report.label}: empty state ${emptyOk(vp) ? `"${norm(state?.textContent ?? 'shown').slice(0, 60)}"` : 'missing'}`);
    }
    emptyS.close();
    const errorS = await openSession(bundle, loaded, 'error', sample, widthCss);
    for (const report of tableReports) {
      await errorS.go(hrefFor('report', report.name));
      const main = errorS.doc.getElementById('main') ?? errorS.doc.body;
      const alert = main.querySelector('[role="alert"], [data-state="error"]');
      const retry = alert?.querySelector('button') ?? null;
      addBoth(
        'states',
        `error:${report.name}`,
        (vp) => !!alert && errorS.shown(alert, vp) && !!retry && errorS.shown(retry, vp),
        (vp) =>
          `report ${report.label}: error ${
            !alert ? 'missing' : !errorS.shown(alert, vp) || (retry && !errorS.shown(retry, vp)) ? `"${norm(alert.textContent).slice(0, 60)}" hidden at ${W[vp]}px` : `"${norm(alert.textContent).slice(0, 60)}"`
          }${alert && !retry ? ' without a retry' : ''}`,
      );
    }
    errorS.close();
  }
  const requiredForms = exp.forms.filter((f) => f.fields.some((x) => x.required && !['computed', 'section', 'notes', 'file', 'subform'].includes(x.kind)));
  if (requiredForms.length) {
    const s = await openSession(bundle, loaded, 'empty', sample, widthCss);
    for (const form of requiredForms) {
      await s.go(hrefFor('form', form.name));
      const el = s.doc.querySelector('#main form');
      if (!el) {
        add('states', 'both', `invalid:${form.name}`, false, `form ${form.label}: no form to submit`);
        continue;
      }
      try {
        el.dispatchEvent(new s.win.Event('submit', { bubbles: true, cancelable: true }));
      } catch (err) {
        add('states', 'both', `invalid:${form.name}`, false, `form ${form.label}: submit throws ${(err as Error).name}`);
        continue;
      }
      await settle(s.win);
      const markers = Array.from(el.querySelectorAll('[data-error-for], .error, [role="alert"]'));
      const ariaInvalid = el.querySelector('[aria-invalid="true"]') !== null;
      const shownError = (vp: Viewport): boolean => markers.some((e) => s.shown(e, vp) && (e.textContent ?? '').trim() !== '') || ariaInvalid;
      addBoth('states', `invalid:${form.name}`, shownError, (vp) => `form ${form.label}: empty mandatory field ${shownError(vp) ? 'shows an error' : 'shows no error'}`);
    }
    s.close();
  }

  // ---- extended UX states
  // The scorer and tools/ui-states-check.mjs share one engine: every verdict
  // checkUiStates returns lands here as an UNSCORED check until its issue
  // is fixed (the issue id rides in the evidence), so the sweep shows the gap
  // without moving the score.
  const { checkUiStates } = await import('./states.js');
  try {
    for (const v of await checkUiStates(app, bundle, { ui: opts.ui ?? 'vanilla' })) {
      const pass = v.status !== 'fail' && v.status !== 'error';
      const id = v.scope === 'app' ? v.state : `${v.state}:${v.scope}`;
      add('states', 'both', id, pass, `${v.status === 'pass' ? v.evidence : `${v.status}: ${v.evidence}`}${v.issue ? ` — ${v.issue}` : ''}`, true);
    }
  } catch (err) {
    add('states', 'both', 'states-engine', false, `the states engine threw: ${(err as Error).message}`, true);
  }

  return finish(app, rubric, checks);
}

function viewportScore(rubric: Rubric, checks: Check[], vp: Viewport): ViewportScore {
  const criteria = rubric.criteria.map((c) => {
    const mine = checks.filter((x) => x.criterion === c.id && !x.unscored && (x.viewport === 'both' || x.viewport === vp));
    const passed = mine.filter((x) => x.pass).length;
    const total = mine.length;
    // A criterion with nothing to check (an app with no reports, say) is met.
    const fraction = total === 0 ? 1 : passed / total;
    return {
      id: c.id,
      title: c.title,
      weight: c.weights[vp],
      passed,
      total,
      points: Math.round(c.weights[vp] * fraction * 100) / 100,
      failures: mine.filter((x) => !x.pass).map((x) => x.evidence),
    };
  });
  // Rounded down to one decimal: 7.96 stays below an 8 bar.
  const score = Math.floor(criteria.reduce((n, c) => n + c.points, 0) * 10 + 1e-9) / 10;
  return { score, pass: score >= rubric.passBar, criteria };
}

function finish(app: App, rubric: Rubric, checks: Check[]): UiScore {
  const desktop = viewportScore(rubric, checks, 'desktop');
  const phone = viewportScore(rubric, checks, 'phone');
  return {
    app: app.name ?? '',
    rubricVersion: rubric.version,
    passBar: rubric.passBar,
    desktop,
    phone,
    score: Math.min(desktop.score, phone.score),
    pass: desktop.pass && phone.pass,
    checks,
  };
}

/** The score file a gate reads: the gate number plus both viewports. */
export function scoreFileOf(result: UiScore): Record<string, unknown> {
  const failing = (vp: ViewportScore) => vp.criteria.filter((c) => c.passed < c.total).map((c) => `${c.id} ${c.passed}/${c.total}`);
  return {
    score: result.score,
    desktop: result.desktop.score,
    phone: result.phone.score,
    pass: result.pass,
    rubricVersion: result.rubricVersion,
    note: `desktop ${result.desktop.score}/10 (${failing(result.desktop).join(', ') || 'all checks pass'}); phone ${result.phone.score}/10 (${failing(result.phone).join(', ') || 'all checks pass'})`,
  };
}

/** Per-criterion table for each viewport, then the first failing checks as evidence. */
export function uiScoreAsText(result: UiScore, opts: { evidence?: number } = {}): string {
  const limit = opts.evidence ?? 5;
  const lines: string[] = [`ui score: ${result.app || '(unnamed app)'}  rubric v${result.rubricVersion}  bar ${result.passBar}/10`];
  for (const vp of VIEWPORTS) {
    const s = result[vp];
    lines.push('', `${vp} ${s.score}/10 ${s.pass ? 'PASS' : 'FAIL'}`);
    for (const c of s.criteria) {
      lines.push(`  ${c.title.padEnd(52)} ${c.points.toFixed(2).padStart(5)} / ${c.weight.toFixed(2)}  (${c.passed}/${c.total} checks)`);
      for (const f of c.failures.slice(0, limit)) lines.push(`      - ${f}`);
      if (c.failures.length > limit) lines.push(`      … ${c.failures.length - limit} more`);
    }
  }
  lines.push('', `result ${result.score}/10 (the lower viewport) ${result.pass ? 'PASS' : 'FAIL'}`);
  return `${lines.join('\n')}\n`;
}

/** What a failing check of each kind (the check id before `:`) means, without app data. */
export const CHECK_KINDS: Record<string, string> = {
  runtime: 'the bundle does not load',
  unrendered: 'nothing rendered for this criterion',
  'app-title': 'app title differs from the Creator name',
  order: 'form fields out of Creator order',
  section: 'section heading missing from a form',
  placeholder: 'not-generated placeholder on a route',
  page: 'page renders no content',
  stack: 'multi-column form stays multi-column on a phone',
  section_menu: 'menu group missing',
  link: 'menu link missing or mislabelled',
  current: 'open route not marked current in the menu',
  'tab-count': 'tab bar missing or over five entries',
  'tab-names': 'tab bar entry without a name',
  more: 'More control missing or not opening and closing',
  reach: 'destination neither a tab nor in More',
  form: 'form route missing or mis-headed',
  field: 'Creator field missing from its form',
  control: 'control does not suit the Creator field type',
  label: 'field label differs from the Creator label',
  required: 'mandatory field not marked required',
  report: 'report route missing or mis-headed',
  col: 'report column not shown on desktop',
  pcol: 'phone record card hides or does not label a column',
  chart: 'chart report renders no chart area',
  submit: 'form without a submit button',
  button: 'Creator form button missing',
  action: 'report custom action missing',
  record: 'record cannot be opened or edited from the report',
  empty: 'report without an empty state',
  error: 'report without an error state and retry',
  invalid: 'empty mandatory field shows no error on submit',
  loading: 'report without a busy loading state',
  'route-focus': 'route change does not focus the screen heading or retitle the document',
  'not-found': 'unknown route without a not-found screen, a way home and focus',
  confirm: 'destructive action without a confirm step',
  pending: 'a second submit while busy posts again',
  denied: 'access denied without a denied screen and a way home',
  toast: 'write result without a dismissible toast',
  lang: 'document without a language',
  title: 'document without a title',
  'skip-link': 'no skip link to the main landmark',
  'nav-name': 'navigation landmark without a name',
  names: 'unnamed control or button on a route',
  ids: 'repeated element id on a route',
  'more-aria': 'More control or sheet without its popup semantics',
  'viewport-meta': 'no device-width viewport',
  'desktop-menu': 'desktop menu hidden or tab bar shown on desktop',
  'phone-tabbar': 'phone shows the side menu or no tab bar',
  'more-overlay': 'More sheet is not a fixed overlay',
  'report-fit': 'report table neither stacks nor scrolls on a phone',
};

/** The kind of a check, for counting failures without app data. */
export function checkKind(check: Check): string {
  const kind = check.id.split(':')[0]!;
  return kind === 'section' && check.criterion === 'navigation' ? 'section_menu' : kind;
}
