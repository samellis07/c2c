/**
 * jsdom render harness for ui-snapshot. Boots the real generated app
 * (bootApp + generated routes, compiled by compile.mjs from the same bytes a
 * generated app ships) into a fresh jsdom document per snapshot — no browser,
 * no CDP, no pixels. Widths are desktop (1280) and phone (390); the 767px
 * breakpoint (styles/shell.css) is CSS-only, so both widths render the same
 * structure and the viewport rides in the snapshot envelope, guarding the day
 * a screen starts branching on width in JS.
 *
 * Endpoint behaviour is fully scripted through view.fetch: each snapshot
 * resolves the app's reads with canned replies (or leaves them pending for
 * the loading state), so every render is deterministic.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { serialise } from './normalize.mjs';

export const VIEWPORTS = [
  { name: 'desktop', width: 1280 },
  { name: 'phone', width: 390 },
];

const SHELL = '<!doctype html><html><body><div id="root"></div></body></html>';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function templateRequire() {
  const base = join(new URL('../../packages/ui-react/template/', import.meta.url).pathname, 'package.json');
  return createRequire(base);
}

/** React + act from the template's own install (the copy the app renders with). */
export function loadReact() {
  const require = templateRequire();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  void createRoot;
  return { React, act: React.act };
}

function installGlobals(win, width) {
  const set = (key, value) => {
    try {
      globalThis[key] = value;
    } catch {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  };
  set('window', win);
  set('document', win.document);
  set('navigator', win.navigator);
  for (const key of [
    'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLFormElement',
    'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLCanvasElement', 'SVGElement', 'Element', 'Node',
    'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent', 'PointerEvent',
    'AbortController', 'AbortSignal', 'EventTarget', 'MutationObserver', 'DOMParser', 'XMLSerializer',
    'DocumentFragment', 'ShadowRoot', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
    'FileReader', 'Blob', 'File', 'DataTransfer', 'ClipboardEvent', 'DragEvent', 'Touch', 'TouchEvent', 'CSS',
  ]) {
    if (win[key] !== undefined) set(key, win[key]);
  }
  const g = globalThis;
  g.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
  g.cancelAnimationFrame ??= (id) => clearTimeout(id);
  g.self ??= win;
  g.NodeFilter ??= win.NodeFilter;
  Object.defineProperty(win, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(win, 'innerHeight', { value: 800, configurable: true });
  win.matchMedia = (query) => {
    const max = /max-width:\s*(\d+)px/.exec(String(query));
    const min = /min-width:\s*(\d+)px/.exec(String(query));
    let matches = true;
    if (max) matches = matches && width <= Number(max[1]);
    if (min) matches = matches && width >= Number(min[1]);
    return {
      matches, media: String(query), onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    };
  };
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (win.Element?.prototype && !win.Element.prototype.scrollIntoView) win.Element.prototype.scrollIntoView = () => {};
  // React DOM's legacy value-tracking polyfill calls the IE-only
  // attachEvent/detachEvent when focus moves programmatically (the form's
  // submit handler focuses the first invalid control). jsdom has neither;
  // no-op shims keep the validation-error state renderable with no DOM effect.
  for (const proto of [win.Element?.prototype, win.HTMLElement?.prototype, win.HTMLInputElement?.prototype]) {
    if (proto && !proto.attachEvent) proto.attachEvent = () => {};
    if (proto && !proto.detachEvent) proto.detachEvent = () => {};
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}

/**
 * A scripted fetch. Reads resolve from `routes` (endpoint prefix → reply or
 * 'pending'); every call is recorded. Pending promises are released by
 * resolveAll (as empty results) so no snapshot leaks work into the next one.
 */
export function scriptedFetch(routes) {
  const calls = [];
  const pending = [];
  const replyFor = (url, body) => {
    const path = new URL(url, 'http://127.0.0.1/').pathname;
    for (const [prefix, reply] of routes) {
      if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(prefix)) return { path, reply, body };
    }
    return { path, reply: { ok: true, status: 200, body: {} }, body };
  };
  const fetch = (url, init = {}) => {
    let body;
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    const { path, reply } = replyFor(url, body);
    calls.push({ method: init.method ?? 'GET', path, body });
    if (reply === 'pending') return new Promise((resolve) => pending.push(resolve));
    const { ok = true, status = 200, body: data = {} } = reply;
    return Promise.resolve({ ok, status, text: async () => JSON.stringify(data) });
  };
  const resolveAll = () => {
    for (const resolve of pending.splice(0)) resolve({ ok: true, status: 200, text: async () => JSON.stringify({ rows: [] }) });
  };
  return { fetch, calls, resolveAll };
}

async function flushLazy(act, container, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await delay(0);
    });
    if (!container.querySelector('[aria-busy="true"]')) return;
  }
  throw new Error('a lazy widget never mounted (aria-busy stuck)');
}

async function flushSettled(act, container, rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await delay(0);
    });
  }
  await flushLazy(act, container, 200);
}

/**
 * Render one snapshot: boot the app at `hash` with `apiRoutes` scripted
 * replies, drive `mode`, and serialise #root. Modes: list, empty, loading,
 * denied, detail, form, invalid, page. Returns the snapshot text.
 */
export async function renderSnapshot({ boot, routes, spec, app, viewport, hash, id, apiRoutes, mode }) {
  const { act } = loadReact();
  const dom = new JSDOM(SHELL, { url: 'http://127.0.0.1/', pretendToBeVisual: true });
  const win = dom.window;
  installGlobals(win, viewport.width);
  const api = scriptedFetch(apiRoutes);
  win.fetch = api.fetch;
  win.location.hash = hash;
  const doc = win.document;
  const container = doc.getElementById('root');
  await act(async () => {
    boot(spec, doc, routes, {});
  });
  if (mode === 'loading') {
    // Settle the lazy widgets but never the data read: the loading marker is
    // what this snapshot pins.
    await flushLazy(act, container);
  } else {
    await flushSettled(act, container);
    if (mode === 'invalid') {
      const form = container.querySelector('form');
      if (!form) throw new Error(`no form to submit at ${hash}`);
      await act(async () => {
        form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushSettled(act, container);
    }
  }
  const text = serialise(container, {
    app,
    route: hash,
    state: mode,
    viewport: viewport.name,
    width: viewport.width,
  });
  void id;
  api.resolveAll();
  await act(async () => {
    await delay(0);
  });
  win.close();
  return { text, calls: api.calls };
}
