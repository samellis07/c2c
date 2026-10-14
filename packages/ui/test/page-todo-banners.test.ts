/**
 * Page-element TODO banners are migration notes for you, not app
 * content: a rendered page must never show them to its users. The items stay
 * on the migration report and are echoed to the console instead.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../src/index.js';
import { generateReactApp } from '../../ui-react/src/generate.js';

interface Runtime {
  renderPage(page: unknown, doc: unknown, appModel?: unknown): string;
}

async function loadRuntime(): Promise<Runtime> {
  return (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as Runtime;
}

function appOf(body: string): App {
  return deriveIr(parse(`application "Demo"\n{\n${body}\n}\n`));
}

const SNIPPET_PAGE = `\tpage Home
\t{
\t\tContent="<zml><layout><panel><dspZml name=\\"Snippet\\" value=\\"<% while (x < 1) { z = 1; } %>\\"/><text value=\\"Hello\\"/></panel></layout></zml>"
\t}`;

function capturedConsole<T>(fn: (infos: string[]) => T): { result: T; infos: string[] } {
  const infos: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => infos.push(args.map(String).join(' '));
  try {
    return { result: fn(infos), infos };
  } finally {
    console.info = original;
  }
}

test('a rendered page shows no TODO banner for a dropped server-side snippet', async () => {
  const runtime = await loadRuntime();
  const dom = new JSDOM('<!doctype html><body></body>');
  const { model } = buildUi(appOf(SNIPPET_PAGE));
  const page = model.pages[0];
  const { result: html, infos } = capturedConsole(() => runtime.renderPage(page, dom.window.document, model));
  assert.equal(html.includes('manual translation'), false, html);
  assert.equal(/class="todo"/.test(html), false, html);
  assert.ok(infos.some((line) => /manual translation/.test(line)), JSON.stringify(infos));
  assert.match(html, /Hello/, html);
});

test('a page whose every element is a TODO shows no banner either', async () => {
  const runtime = await loadRuntime();
  const dom = new JSDOM('<!doctype html><body></body>');
  const page = {
    name: 'Bare',
    label: 'Bare',
    status: 'todo' as const,
    todo: 'Every element on this page is a TODO.',
    elements: [],
  };
  const { result: html, infos } = capturedConsole(() => runtime.renderPage(page, dom.window.document));
  assert.equal(html.includes('TODO'), false, html);
  assert.equal(/class="todo"/.test(html), false, html);
  assert.ok(infos.length > 0, 'the migration note is logged, not dropped');
});

test('a page embed of an ungenerated component shows no TODO banner', async () => {
  const runtime = await loadRuntime();
  const dom = new JSDOM('<!doctype html><body></body>');
  const page = {
    name: 'P',
    label: 'P',
    status: 'generated' as const,
    elements: [{ tag: 'report', kind: 'report' as const, name: 'Later', children: [] }],
  };
  const fake = { reports: [{ name: 'Later', label: 'Later', status: 'todo', todo: 'Report type x is not generated.' }] };
  const { result: html, infos } = capturedConsole(() => runtime.renderPage(page, dom.window.document, fake));
  assert.equal(html.includes('not generated'), false, html);
  assert.equal(/class="todo"/.test(html), false, html);
  assert.ok(infos.some((line) => /not generated/.test(line)), JSON.stringify(infos));
});

test('the migration report still counts the dropped snippet', () => {
  const built = buildUi(appOf(SNIPPET_PAGE));
  const { model } = built;
  assert.equal(built.summary.pageElementsTodo, 1);
  assert.ok(
    model.todos.some((todo) => todo.area === 'zml' && todo.name === 'Home.dspZml' && /manual translation/.test(todo.reason)),
    JSON.stringify(model.todos),
  );
});

test('the React output never carries the snippet TODO text', () => {
  const files = generateReactApp(appOf(SNIPPET_PAGE));
  for (const file of files) {
    const text = typeof file.data === 'string' ? file.data : file.data.toString('utf8');
    assert.equal(text.includes('manual translation'), false, file.path);
  }
});
