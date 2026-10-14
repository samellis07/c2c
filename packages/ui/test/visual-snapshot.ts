/**
 * Deterministic visual snapshot of a generated app, without a browser.
 *
 * The generated shell (index.html), stylesheet (app.css) and client runtime
 * are booted in jsdom against a fake data API that answers every call with
 * no rows (or with `rows` sample rows, for the populated list and page
 * surfaces). For each screen (home, the first form, the first report — and
 * optionally the first list report and the first ZML page) and each
 * viewport width, a fixed list of key elements is read back through
 * getComputedStyle and recorded property by property.
 *
 * jsdom does not evaluate media widths or custom properties, so both happen
 * here first: the stylesheet is flattened to the rules whose @media matches
 * the width, and every var() is substituted with the value the document root
 * resolves for it (:root plus any html[...] block the root matches). Colours
 * come back from jsdom normalised to rgb(), everything else as declared, so
 * the snapshot is stable across machines.
 */
import { JSDOM } from 'jsdom';
import { clientRuntimeSource, generateUi } from '../src/index.js';
import type { App } from '../../core/src/index.js';

export const VIEWPORTS = [1440, 390] as const;

/** Elements whose look the snapshot pins, by screen. The first match is read. */
export const KEY_ELEMENTS = [
  'body',
  '.topbar',
  '#app-title',
  '#menu-toggle',
  '#nav',
  '#nav a',
  '#nav a[aria-current="page"]',
  '#main',
  '.card',
  'h1',
  'h2',
  '.form-grid',
  '.field',
  '.field>label',
  'input:not([type="checkbox"]):not([type="radio"])',
  'select',
  'textarea',
  'button[type="submit"]',
  'table',
  'thead th',
  'td',
  '[data-pages] button',
  '.state-empty',
  '#tabbar',
  '#tabbar a',
  '#toasts',
] as const;

/** Extra elements read on populated list and ZML page screens (see visual-pages.test.ts). */
export const PAGE_ELEMENTS = [
  'article[data-page]',
  'article[data-page] [data-zml]',
  'article[data-page] [data-zml="panel"]',
  'article[data-page] [data-zml="panel"] [data-zml]',
  'article[data-page] .embed',
  'article[data-page] .embed h3 a',
  'article[data-page] .kpi',
  'article[data-page] .gauge',
  'article[data-page] .snippet',
  'article[data-page] .zicon',
  'article[data-page] [data-report-search] input',
  'section[data-report]',
  '[data-board]',
  '[data-board] [data-lane]',
  '[data-board] [data-lane] h3',
  '[data-board] li',
  'h3[data-group]',
  '.report-tools',
  '.report-tools input[type="search"]',
  '.report-tools select[data-filter]',
  '[data-rows]',
  'thead',
  'tbody',
  'tbody tr',
  'td[data-primary="true"]',
  'nav[data-pages]',
  '[data-page-label]',
] as const;

export const PROPS = [
  'display',
  'color',
  'background-color',
  'border-top-color',
  'border-top-width',
  'border-radius',
  'box-shadow',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'padding-top',
  'padding-left',
  'margin-bottom',
  'width',
  'max-width',
  'min-height',
  'gap',
  'grid-template-columns',
  'position',
] as const;

interface CssRule {
  media?: string;
  selectors: string[];
  body: string;
}

/** Top-level and @media rules in source order; other at-rules are dropped. */
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
      else if (!prelude.startsWith('@')) rules.push({ media, selectors: splitSelectors(prelude), body });
      i = j;
    }
  };
  walk(src);
  return rules;
}

function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function px(value: string): number {
  const m = /^([\d.]+)(px|rem|em)?$/.exec(value.trim());
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === 'rem' || m[2] === 'em' ? 16 : 1);
}

/** Width queries only; colour-scheme, hover and other media features never match. */
export function mediaMatches(media: string | undefined, width: number, scheme: 'light' | 'dark' = 'light'): boolean {
  if (!media) return true;
  return media.split(',').some((alt) => {
    const q = alt.trim().toLowerCase();
    const schemeQuery = /\(prefers-color-scheme\s*:\s*(light|dark)\)/.exec(q);
    if (schemeQuery && schemeQuery[1] !== scheme) return false;
    if (/\b(print|prefers-(?!color-scheme)|hover|pointer|orientation|display-mode)\b/.test(q)) return false;
    for (const m of q.matchAll(/\((min|max)-width\s*:\s*([^)]+)\)/g)) {
      const n = px(m[2]!);
      if (Number.isNaN(n)) return false;
      if (m[1] === 'min' ? width < n : width > n) return false;
    }
    return true;
  });
}

function declarations(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) out.push([part.slice(0, colon).trim(), part.slice(colon + 1).trim()]);
  }
  return out;
}

interface RootLike {
  matches(selector: string): boolean;
}

/** Custom properties the document root resolves, in cascade order (specificity, then source). */
export function rootVariables(rules: CssRule[], root: RootLike): Map<string, string> {
  const hits: { spec: number; order: number; body: string }[] = [];
  for (const rule of rules) {
    const specs = rule.selectors
      .filter((sel) => /^(?::root|html(?:\[[^\]]+\])*)$/.test(sel) && root.matches(sel === ':root' ? 'html' : sel))
      .map(specificity);
    if (specs.length) hits.push({ spec: Math.max(...specs), order: hits.length, body: rule.body });
  }
  hits.sort((x, y) => x.spec - y.spec || x.order - y.order);
  const vars = new Map<string, string>();
  for (const hit of hits) {
    for (const [prop, value] of declarations(hit.body)) if (prop.startsWith('--')) vars.set(prop, value);
  }
  return vars;
}

/** Replace every var(--name[, fallback]) with its resolved value, innermost first. */
export function substituteVars(value: string, vars: Map<string, string>): string {
  let out = value;
  for (let guard = 0; guard < 20 && out.includes('var('); guard++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_m, name: string, fallback?: string) => {
      const v = vars.get(name);
      return v !== undefined ? v : (fallback ?? '').trim();
    });
  }
  return out;
}

/** Selector specificity as one sortable number (ids, then classes/attributes/pseudo-classes, then types). */
export function specificity(selector: string): number {
  let a = 0;
  let b = 0;
  let c = 0;
  let sel = selector;
  // Functional pseudo-classes count their most specific argument; :where() counts nothing.
  for (let guard = 0; guard < 10; guard++) {
    const m = /:(not|is|has|where)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(sel);
    if (!m) break;
    if (m[1] !== 'where') {
      const inner = Math.max(...splitSelectors(m[2]!).map(specificity));
      a += Math.floor(inner / 1e6);
      b += Math.floor(inner / 1e3) % 1e3;
      c += inner % 1e3;
    }
    sel = sel.slice(0, m.index) + ' ' + sel.slice(m.index + m[0].length);
  }
  sel = sel.replace(/\[[^\]]*\]/g, () => {
    b++;
    return ' ';
  });
  sel = sel.replace(/::[\w-]+(\([^)]*\))?/g, () => {
    c++;
    return ' ';
  });
  sel = sel.replace(/:[\w-]+(\([^)]*\))?/g, () => {
    b++;
    return ' ';
  });
  for (const m of sel.matchAll(/([#.]?)(-?[_a-zA-Z][\w-]*)/g)) {
    if (m[1] === '#') a++;
    else if (m[1] === '.') b++;
    else c++;
  }
  return a * 1e6 + b * 1e3 + c;
}

/**
 * The stylesheet as it applies at `width`, with custom properties resolved.
 * jsdom lets the last matching rule win, so rules are split one selector each
 * and stably sorted by specificity, which gives the browser cascade for
 * declarations without !important.
 */
export function flattenCss(css: string, width: number, root: RootLike, scheme: 'light' | 'dark' = 'light'): string {
  const rules = parseCss(css).filter((rule) => mediaMatches(rule.media, width, scheme));
  const vars = rootVariables(rules, root);
  for (const [name, value] of vars) vars.set(name, substituteVars(value, vars));
  const entries: { spec: number; order: number; line: string }[] = [];
  for (const rule of rules) {
    const decls = declarations(rule.body)
      .filter(([prop]) => !prop.startsWith('--'))
      .map(([prop, value]) => `${prop}:${substituteVars(value, vars)}`);
    if (!decls.length) continue;
    for (const selector of rule.selectors) {
      entries.push({ spec: specificity(selector), order: entries.length, line: `${selector}{${decls.join(';')}}` });
    }
  }
  entries.sort((x, y) => x.spec - y.spec || x.order - y.order);
  return entries.map((entry) => entry.line).join('\n');
}

export interface SnapshotOptions {
  /** Extra attributes on <html>, e.g. { 'data-color-scheme': 'dark' }. */
  rootAttrs?: Record<string, string>;
  scheme?: 'light' | 'dark';
  /**
   * Screens to capture: 'home', 'form', 'report', 'list' (the first
   * list-view report), 'page' (the first ZML page), 'view:<kind>' (the
   * first generated report of that view) and 'report:<name>'. Screens the
   * app does not have are skipped. Default ['home', 'form', 'report'].
   */
  screens?: readonly string[];
  /** Elements to read; defaults to KEY_ELEMENTS. */
  elements?: readonly string[];
  /**
   * Sample rows the fake data API answers report queries with. 0 (the
   * default) keeps every report in its empty state.
   */
  rows?: number;
}

export type Snapshot = Record<string, Record<string, Record<string, string>>>;

interface Win {
  document: Document;
  fetch?: unknown;
  getComputedStyle(el: Element): CSSStyleDeclaration;
  close(): void;
}

const runtimeUrls = new Map<string, Promise<{ boot(model: unknown, doc: unknown): unknown }>>();

function loadRuntime(): Promise<{ boot(model: unknown, doc: unknown): unknown }> {
  const source = clientRuntimeSource();
  let hit = runtimeUrls.get(source);
  if (!hit) {
    hit = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    runtimeUrls.set(source, hit);
  }
  return hit;
}

const EMPTY_BODY = { status: 'success', data: [], rows: [], total: 0 };

type UiReportLike = {
  name: string;
  view?: string;
  status?: string;
  queryEndpoint?: string;
  columns?: { field: string; label?: string; numeric?: boolean }[];
};

/** The hash a named screen loads, or undefined when the app has no such screen. */
export function screenHash(model: { forms: { name: string }[]; reports: UiReportLike[]; pages?: { name: string }[] }, screen: string): string | undefined {
  switch (screen) {
    case 'home':
      return '#/';
    case 'form':
      return model.forms[0] ? `#/form/${encodeURIComponent(model.forms[0].name)}` : undefined;
    case 'report':
      return model.reports[0] ? `#/report/${encodeURIComponent(model.reports[0].name)}` : undefined;
    case 'list': {
      const list = model.reports.find((report) => report.view === 'list') ?? model.reports[0];
      return list ? `#/report/${encodeURIComponent(list.name)}` : undefined;
    }
    case 'page':
      return model.pages && model.pages[0] ? `#/page/${encodeURIComponent(model.pages[0].name)}` : undefined;
    default: {
      // 'view:<kind>' is the first generated report of that view;
      // 'report:<name>' is the report itself.
      const view = /^view:(.+)$/.exec(screen);
      if (view) {
        const report = model.reports.find((item) => item.view === view[1] && item.status !== 'todo');
        return report ? `#/report/${encodeURIComponent(report.name)}` : undefined;
      }
      const named = /^report:(.+)$/.exec(screen);
      if (named) {
        const report = model.reports.find((item) => item.name === named[1]);
        return report ? `#/report/${encodeURIComponent(report.name)}` : undefined;
      }
      return undefined;
    }
  }
}

/** `count` stable rows shaped for the report's own columns, so cells paint real values. */
export function sampleRows(report: UiReportLike, count: number): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, string> = { ROWID: String(910001 + i) };
    for (const column of report.columns || []) {
      row[column.field] = column.numeric ? String((i + 1) * 2.5) : `Row ${i + 1} ${column.label || column.field}`;
    }
    rows.push(row);
  }
  return rows;
}

function queryOp(init: unknown): boolean {
  const body = init && typeof init === 'object' ? (init as { body?: unknown }).body : undefined;
  if (typeof body !== 'string') return false;
  try {
    return (JSON.parse(body) as { op?: string }).op === 'query';
  } catch {
    return false;
  }
}

/**
 * The fake data API. Report queries (`op: 'query'` POSTs to a report's own
 * query endpoint) get `count` sample rows; every other call gets the empty
 * body, so a populated screen still exercises only generated markup.
 */
function fakeFetch(model: { reports?: UiReportLike[] }, count: number): (url: unknown, init?: unknown) => Promise<unknown> {
  return (url: unknown, init?: unknown) => {
    let body: unknown = EMPTY_BODY;
    if (count > 0 && queryOp(init)) {
      const target = String(url ?? '');
      const report = (model.reports || []).find((item) => item && item.queryEndpoint && target.endsWith(item.queryEndpoint));
      const rows = report ? sampleRows(report, count) : [];
      body = { status: 'success', data: rows, rows, total: rows.length };
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
      clone() {
        return this;
      },
    });
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Computed styles of the key elements for every screen x viewport of one app. */
export async function snapshotApp(app: App, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const bundle = generateUi(app);
  const file = (path: string): string => {
    const hit = bundle.files.find((f) => f.path === path);
    if (!hit) throw new Error(`visual snapshot: ${path} not generated`);
    return typeof hit.data === 'string' ? hit.data : hit.data.toString('utf8');
  };
  const html = file('slate/index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  const css = file('slate/assets/app.css');
  const runtime = await loadRuntime();
  const model = bundle.model;
  const routes: [string, string][] = [];
  for (const screen of opts.screens ?? ['home', 'form', 'report']) {
    const hash = screenHash(model, screen);
    if (hash) routes.push([screen, hash]);
  }
  const elements = opts.elements ?? KEY_ELEMENTS;
  const fetchImpl = fakeFetch(model, opts.rows ?? 0);

  const out: Snapshot = {};
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = fetchImpl;
  try {
    for (const width of VIEWPORTS) {
      for (const [screen, hash] of routes) {
        const dom = new JSDOM(html, { url: `http://127.0.0.1/slate/index.html${hash}`, pretendToBeVisual: false }) as unknown as {
          window: Win;
        };
        const win = dom.window;
        const doc = win.document;
        for (const [name, value] of Object.entries(opts.rootAttrs ?? {})) doc.documentElement.setAttribute(name, value);
        win.fetch = fetchImpl;
        const style = doc.createElement('style');
        style.textContent = flattenCss(css, width, doc.documentElement, opts.scheme ?? 'light');
        doc.head.appendChild(style);
        await runtime.boot(model, doc);
        await settle();
        // Boot repaints the app's own theme attributes; forced ones win.
        for (const [name, value] of Object.entries(opts.rootAttrs ?? {})) doc.documentElement.setAttribute(name, value);
        const shot: Record<string, Record<string, string>> = {};
        for (const selector of elements) {
          const el = doc.querySelector(selector);
          if (!el) continue;
          const cs = win.getComputedStyle(el);
          const props: Record<string, string> = {};
          for (const prop of PROPS) {
            const v = cs.getPropertyValue(prop).replace(/\s+/g, ' ').trim();
            if (v) props[prop] = v;
          }
          shot[selector] = props;
        }
        out[`${screen}@${width}`] = shot;
        win.close();
      }
    }
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
  return out;
}
