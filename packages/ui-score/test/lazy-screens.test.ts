/**
 * A code-split screen scores as the screen it is. Vite loads such a chunk
 * through a preload that appends a stylesheet link and waits for its `load`
 * event, then mounts the screen a few ticks later; the page's stylesheets are
 * several links, and a lazy screen's own sheet is not linked from index.html.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleFromFiles, loadRuntime, openSession, settle } from '../src/score.js';

const HTML = '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/assets/a.css"><link rel="stylesheet" href="/assets/b.css"><script type="module" src="/assets/entry.js"></script></head><body><main id="main"></main></body></html>';

// The lazy chunk: preload awaits the stylesheet link's load, then mounts after more ticks.
const ENTRY = `
export function boot() {}
const preload = () => new Promise((resolve) => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/assets/lazy.css';
  document.head.appendChild(link);
  link.addEventListener('load', resolve);
});
const show = async () => {
  await preload();
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  document.getElementById('main').innerHTML = '<p data-route-loading="true">Loading…</p>';
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
  document.getElementById('main').innerHTML = '<form data-form="X"><label>Name</label></form>';
};
window.addEventListener('hashchange', () => { document.getElementById('main').innerHTML = '<p data-route-loading="true">Loading…</p>'; void show(); });
`;

const files = [
  { path: 'slate/index.html', data: HTML },
  { path: 'slate/assets/entry.js', data: ENTRY },
  { path: 'slate/assets/a.css', data: '.a{color:red}' },
  { path: 'slate/assets/b.css', data: '.b{color:blue}' },
  { path: 'slate/assets/lazy.css', data: '.lazy{color:green}' },
];

test('the bundle stylesheet is every linked sheet and the on-demand ones', () => {
  const { css } = bundleFromFiles(files);
  for (const rule of ['.a{', '.b{', '.lazy{']) assert.ok(css.includes(rule), `css has ${rule}`);
  assert.ok(css.indexOf('.a{') < css.indexOf('.b{'), 'linked sheets keep document order');
});

test('settle waits for a lazy screen whose stylesheet preload awaits a load event', async () => {
  const bundle = bundleFromFiles(files);
  const session = await openSession(bundle, loadRuntime(bundle), 'rows', new Map(), { desktop: bundle.css, phone: bundle.css });
  try {
    await session.go('#/form/X');
    assert.ok(session.doc.querySelector('form[data-form="X"]'), 'the lazy screen is mounted after go()');
    assert.equal(session.doc.querySelector('[data-route-loading]'), null);
  } finally {
    session.close();
  }
});

test('settle gives up on a screen that never resolves instead of hanging', async () => {
  const bundle = bundleFromFiles(files);
  const session = await openSession(bundle, loadRuntime(bundle), 'rows', new Map(), { desktop: bundle.css, phone: bundle.css });
  try {
    session.doc.getElementById('main')!.innerHTML = '<p data-route-loading="true">Loading…</p>';
    const started = Date.now();
    await settle(session.win);
    assert.ok(Date.now() - started < 8000);
  } finally {
    session.close();
  }
});
