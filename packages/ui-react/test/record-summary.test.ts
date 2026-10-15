import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { TEMPLATE_DIR } from '../src/index.js';
import type { FormSpec } from '../template/lib/c2c-ui/types.js';

const LIB = join(TEMPLATE_DIR, 'lib');
const MODULES = join(TEMPLATE_DIR, 'node_modules');
const runtimeReady = existsSync(join(MODULES, 'react')) && existsSync(join(MODULES, 'react-dom'));
const SKIP = runtimeReady ? false : process.env.CI === 'true' ? false : 'template runtime dependencies are not installed';

function compile(out: string): void {
  const files: string[] = [];
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (/\.tsx?$/.test(file)) files.push(file); } };
  walk(LIB);
  const css = join(out, 'css.mjs');
  mkdirSync(out, { recursive: true });
  writeFileSync(css, 'export default {}');
  for (const file of files) {
    const target = join(out, 'lib', relative(LIB, file).replace(/\.tsx?$/, '.js'));
    mkdirSync(dirname(target), { recursive: true });
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    const rewritten = outputText.replace(/(from\s*)['"](\.{1,2}\/[^'"]+)['"]/g, (_m, p: string, spec: string) => {
      if (spec.endsWith('.css')) return `${p}'${relative(dirname(target), css).replace(/\\/g, '/')}'`;
      const resolved = /\.(?:tsx?|js)$/.test(spec) ? spec.replace(/\.tsx?$/, '.js') : `${spec}.js`;
      return `${p}'${resolved}'`;
    });
    writeFileSync(target, rewritten);
  }
  symlinkSync(MODULES, join(out, 'node_modules'), 'dir');
}

const form = { name: 'F', label: 'Form', layout: 'one', fields: [
  { name: 'Name', label: 'Name', widget: 'text', required: false, readonly: false, generated: true },
  { name: 'Lines', label: 'Lines', widget: 'subform', required: false, readonly: false, generated: true, subfields: [{ name: 'Description', label: 'Description', widget: 'text', required: false, readonly: false, generated: true }] },
], recordEndpoint: '/forms/F/record', submitEndpoint: '/forms/F/submit', buttons: { add: [], edit: [] } } as unknown as FormSpec;

test('RecordSummary handles 403, 404, and renders only declared fields', { skip: SKIP }, async (t) => {
  const out = join(tmpdir(), `c2c-record-summary-${process.pid}`);
  t.after(() => rmSync(out, { recursive: true, force: true }));
  compile(out);
  const domMod = await import('jsdom');
  const dom = new domMod.JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  const view = dom.window as unknown as Record<string, unknown> & Window;
  for (const key of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','DocumentFragment','SVGElement','getComputedStyle','CSS','self']) {
    try { (globalThis as Record<string, unknown>)[key] = view[key as keyof typeof view]; } catch { Object.defineProperty(globalThis, key, { value: view[key as keyof typeof view], configurable: true }); }
  }
  if (!view.matchMedia) view.matchMedia = (() => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof view.matchMedia;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const require = createRequire(join(out, 'loader.cjs'));
  const React = require('react') as { createElement(type: unknown, props: unknown, ...children: unknown[]): unknown; act(fn: () => Promise<void>): Promise<void> };
  const { createRoot } = require('react-dom/client') as { createRoot(el: Element): { render(node: unknown): void; unmount(): void } };
  const { RecordSummary } = await import(pathToFileURL(join(out, 'lib/c2c-ui/form/RecordSummary.js')).href) as { RecordSummary(props: { form: FormSpec; rowId?: string }): unknown };
  const { EnvContext } = await import(pathToFileURL(join(out, 'lib/c2c-ui/runtime/env.js')).href) as { EnvContext: { Provider: unknown } };
  const container = view.document.getElementById('root')!;
  const root = createRoot(container);
  const paint = async (status: number, body: Record<string, unknown>) => {
    const api = { post: async () => ({ ok: status === 200, status, body }) };
    const env = { view, doc: view.document, spec: { name: 'App', spec: 1, theme: {}, nav: [], forms: {}, reports: {} }, api };
    await React.act(async () => { root.render(React.createElement(EnvContext.Provider, { value: env }, React.createElement(RecordSummary, { form, rowId: '1' }))); });
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  try {
    await paint(403, {});
    assert.match(container.textContent ?? '', /This record is not available/);
    await paint(404, {});
    assert.match(container.textContent ?? '', /No record is available/);
    await paint(200, { record: { Name: 'Visible', Lines: [{ Description: 'Child', CREATORID: 'secret-id', Hidden: 'secret-value' }] } });
    assert.match(container.textContent ?? '', /Visible.*Child/s);
    assert.doesNotMatch(container.textContent ?? '', /secret-id|secret-value|CREATORID|Hidden/);
  } finally { root.unmount(); }
});
