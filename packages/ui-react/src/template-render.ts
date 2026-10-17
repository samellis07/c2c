/**
 * Render the generated React template's screens in jsdom, without a browser
 * or a bundler: lib/c2c-ui is transpiled to ESM under a temporary directory
 * (css imports get a stub module, the template's node_modules is linked), and
 * one screen mounts inside EnvContext + ScreenBoundary the way the app shell
 * mounts it. Used by the report verification runner and the report view tests.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { TEMPLATE_DIR } from './generate.js';
import type { AppSpec } from '../template/lib/c2c-ui/types.js';

export const TEMPLATE_MODULES = join(TEMPLATE_DIR, 'node_modules');
export const TEMPLATE_MISSING = 'template runtime dependencies are not installed: run `npm ci --prefix packages/ui-react/template`';

/** Whether the template's runtime dependencies (react, react-dom) are installed. */
export function templateRuntimeReady(): boolean {
  return existsSync(join(TEMPLATE_MODULES, 'react')) && existsSync(join(TEMPLATE_MODULES, 'react-dom'));
}

/** Transpile lib/c2c-ui to ESM .js under <out>/lib; css imports get a stub module, bare specifiers get a node_modules link. */
export function compileTemplateLib(out: string): void {
  if (!templateRuntimeReady()) throw new Error(TEMPLATE_MISSING);
  const lib = join(TEMPLATE_DIR, 'lib');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(lib);
  mkdirSync(out, { recursive: true });
  const stub = join(out, 'css-stub.mjs');
  writeFileSync(stub, 'export default new Proxy({}, { get: (_, key) => String(key) });\n');
  for (const file of files) {
    const target = join(out, 'lib', relative(lib, file).replace(/\.tsx?$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    const specifier = (pre: string, spec: string): string => {
      if (spec.endsWith('.css')) {
        const to = relative(dirname(target), stub).replace(/\\/g, '/');
        return `${pre}'${to.startsWith('.') ? to : `./${to}`}'`;
      }
      return /\.[a-z]+$/.test(spec) ? `${pre}'${spec}'` : `${pre}'${spec}.js'`;
    };
    const rewritten = outputText
      .replace(/^(\s*(?:import|export)\s[^'"]*?\bfrom\s*)['"](\.{1,2}\/[^'"]+)['"]/gm, (_all, pre: string, spec: string) => specifier(pre, spec))
      .replace(/^(\s*import\s*)['"](\.{1,2}\/[^'"]+)['"]/gm, (_all, pre: string, spec: string) => specifier(pre, spec));
    writeFileSync(target, rewritten);
  }
  symlinkSync(TEMPLATE_MODULES, join(out, 'node_modules'), 'dir');
}

/** The api the template's EnvContext carries: one POST per endpoint call. */
export interface TemplateApi {
  post(endpoint: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; body?: unknown }>;
}

/** Which screen to mount: a report route (optionally one record), a chart report, or a page. */
export type TemplateScreen =
  | { kind: 'report'; report: string; row?: string }
  | { kind: 'chart'; report: string }
  | { kind: 'page'; page: string };

export interface MountedScreen {
  container: HTMLElement;
  window: Window;
  /** Let effects and endpoint round-trips settle. */
  flush(rounds?: number): Promise<void>;
  unmount(): Promise<void>;
}

/**
 * Mount one screen of a compiled template (see compileTemplateLib) in a fresh
 * jsdom window. jsdom is imported lazily; it is a development dependency.
 */
export async function mountTemplateScreen(out: string, spec: AppSpec, screen: TemplateScreen, api: TemplateApi): Promise<MountedScreen> {
  const jsdomName = 'jsdom';
  const { JSDOM } = (await import(jsdomName)) as { JSDOM: new (html: string, opts: Record<string, unknown>) => { window: Window } };
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
  const view = dom.window as unknown as Record<string, unknown> & Window;
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'DocumentFragment', 'SVGElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTableElement', 'getComputedStyle', 'CSS', 'self'];
  for (const key of globals) {
    try {
      (globalThis as Record<string, unknown>)[key] = view[key as keyof typeof view];
    } catch {
      Object.defineProperty(globalThis, key, { value: view[key as keyof typeof view], configurable: true });
    }
  }
  const w = view as unknown as Record<string, unknown>;
  if (typeof w.matchMedia !== 'function') {
    w.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as Record<string, unknown>).ResizeObserver = w.ResizeObserver;
  }
  if (typeof w.CSS !== 'object' || w.CSS === null) {
    w.CSS = { escape: (text: string) => text.replace(/["\\]/g, '\\$&') };
    (globalThis as Record<string, unknown>).CSS = w.CSS;
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  const require = createRequire(join(out, 'lib', 'loader.cjs'));
  const React = require('react') as { createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown; act?: (fn: () => Promise<unknown>) => Promise<void> };
  const { createRoot } = require('react-dom/client') as { createRoot: (el: Element) => { render(node: unknown): void; unmount(): void } };
  const act: (fn: () => Promise<unknown>) => Promise<void> = React.act ?? (async (fn) => void (await fn()));
  const load = async <T>(path: string): Promise<T> => (await import(pathToFileURL(join(out, 'lib/c2c-ui', path)).href)) as T;
  const { EnvContext } = await load<{ EnvContext: { Provider: unknown } }>('runtime/env.js');
  const { ScreenBoundary } = await load<{ ScreenBoundary: unknown }>('shell/ScreenBoundary.js');
  let node: unknown;
  let name: string;
  if (screen.kind === 'page') {
    const { PageView } = await load<{ PageView: unknown }>('pages/PageView.js');
    const page = spec.pages?.[screen.page];
    if (!page) throw new Error(`no page ${screen.page} in the app spec`);
    node = React.createElement(PageView, { page });
    name = screen.page;
  } else {
    const report = spec.reports[screen.report];
    if (!report) throw new Error(`no report ${screen.report} in the app spec`);
    if (screen.kind === 'chart') {
      const { ChartReport } = await load<{ ChartReport: unknown }>('charts/ChartView.js');
      node = React.createElement(ChartReport, { report });
    } else {
      const { ReportView } = await load<{ ReportView: unknown }>('report/ReportView.js');
      node = React.createElement(ReportView, { report, ...(screen.row ? { row: screen.row } : {}) });
    }
    name = screen.report;
  }
  const container = view.document.getElementById('root') as HTMLElement;
  const root = createRoot(container);
  const env = { view, doc: view.document, spec, api };
  const flush = async (rounds = 3) => {
    for (let i = 0; i < rounds; i++) await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  };
  await act(async () => {
    root.render(React.createElement(EnvContext.Provider, { value: env }, React.createElement(ScreenBoundary, { screen: name, route: screen.kind === 'page' ? 'page' : 'report' }, node)));
  });
  await flush();
  return {
    container,
    window: view,
    flush,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}
