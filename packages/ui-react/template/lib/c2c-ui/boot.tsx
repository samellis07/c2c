/**
 * Boot: mount the app into #root of a document. The entry module exports
 * boot(spec, document) and calls it once for the page's own document; a
 * harness (the UI scorer, a smoke test) may call it again for another
 * document. The first render commits synchronously.
 */
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { AppSpec, NavSection } from './types';
import { createApi, type AppWindow } from './runtime/api';
import { EnvContext, useEnv, type AppEnv } from './runtime/env';
import { CustomizationContext, type Customization } from './runtime/extend';
import { routeKey, useRoute, hrefFor } from './runtime/router';
import { ensureObservers } from './runtime/observers';
import { AuthGate } from './runtime/auth';
import { AppShell } from './shell/AppShell';
import { SmokePage } from './smoke/SmokePage';
import { AppBoundary, rootErrorOptions } from './shell/ScreenBoundary';

/** Screen components by route key (`form/<name>`, `report/<name>`, `page/<name>`, `flow/<name>[/<view>]`), written by the generator. */
export type ScreenProps = { edit?: string; row?: string; view?: string };
export type RouteTable = Record<string, ComponentType<ScreenProps>>;

/**
 * Screen names hidden from this profile by a Creator `hide = true` section —
 * the same set the vanilla runtime's `hiddenTarget` computes. The server
 * denies these endpoints unconditionally (403 "hidden form"), so the router
 * paints the denied state directly without a probe request.
 */
export function deniedTargets(spec: AppSpec): ReadonlySet<string> {
  return new Set(spec.denied ?? []);
}

/** The generated nav plus the customization's route additions and nav transform. */
export function navSections(spec: AppSpec, custom: Customization): NavSection[] {
  const sections = spec.nav.map((section) => ({ ...section, items: [...section.items] }));
  for (const added of custom.routes ?? []) {
    const name = added.page.replace(/^page\//, '');
    const item = { kind: 'page' as const, name, label: added.label, href: hrefFor('page', name) };
    const home = sections.find((section) => section.label === (added.section ?? 'More'));
    if (home) home.items.push(item);
    else sections.push({ label: added.section ?? 'More', items: [item] });
  }
  return custom.nav ? custom.nav(sections) : sections;
}

function App({ spec, routes, custom }: { spec: AppSpec; routes: RouteTable; custom: Customization }) {
  const env = useEnv();
  const route = useRoute(env.view);
  const sections = navSections(spec, custom);
  const table: RouteTable = { ...routes };
  for (const added of custom.routes ?? []) table[`page/${added.page.replace(/^page\//, '')}`] = added.component;
  const first = sections.flatMap((s) => s.items)[0];
  const key = routeKey(route) || (first ? `${first.kind}/${first.name}` : '');
  const Screen = table[key];
  // The smoke page checks access itself through POST /admin/smoke {op:status}:
  // a signed-out visit must paint not-signed-in, not wait at the sign-in gate.
  if (route.name === 'smoke') {
    return (
      <AppShell title={spec.name} sections={sections} current="">
        <SmokePage />
      </AppShell>
    );
  }
  // A screen in a hidden section never mounts on a typed-in hash: its form,
  // its report and their queries stay cold, and the shell paints the same
  // denied state the vanilla runtime shows.
  const denied =
    (route.name === 'form' || route.name === 'report' || route.name === 'page') && deniedTargets(spec).has(route.id);
  return (
    <AuthGate>
      <AppShell title={spec.name} sections={sections} current={key}>
        {denied ? (
          <p data-access-status="403">This page is not available.</p>
        ) : Screen ? (
          <Screen
            key={route.name === 'form' ? `${key}/${route.edit ?? ''}` : route.name === 'report' ? `${key}/${route.row ?? ''}` : route.name === 'flow' ? `flow/${route.id}` : key}
            edit={route.name === 'form' ? route.edit : undefined}
            row={route.name === 'report' ? route.row : undefined}
            view={route.name === 'flow' ? route.view : undefined}
          />
        ) : (
          <section className="c2c-card">
            <h1>Not found</h1>
            <p>This screen is not part of the app. Choose a screen from the menu.</p>
          </section>
        )}
      </AppShell>
    </AuthGate>
  );
}

/**
 * Globals that must never be taken from the booted realm: the JavaScript
 * intrinsics (swapping jsdom's Object onto globalThis would break the host)
 * and window's self-referential and console globals.
 */
const REALM_INTRINSICS = new Set([
  'globalThis',
  'window',
  'self',
  'top',
  'parent',
  'frames',
  'frameElement',
  'console',
  'undefined',
  'NaN',
  'Infinity',
  'eval',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'unescape',
  'Object',
  'Function',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Symbol',
  'BigInt',
  'Date',
  'RegExp',
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'Promise',
  'Proxy',
  'Reflect',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'FinalizationRegistry',
  'Iterator',
  'Generator',
  'GeneratorFunction',
  'AsyncFunction',
  'AsyncGenerator',
  'AsyncGeneratorFunction',
  'Atomics',
  'JSON',
  'Math',
  'Intl',
  'WebAssembly',
  'Temporal',
]);

/**
 * Realm globals whose names are lowercase: the booted document's state
 * objects and DOM functions. Timers, microtasks and performance are absent —
 * those delegate to the host platform, so copying them recurses.
 */
const REALM_GLOBALS = new Set([
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'screen',
  'origin',
  'visualViewport',
  'fetch',
  'getComputedStyle',
  'getSelection',
  'matchMedia',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'scroll',
  'scrollTo',
  'scrollBy',
  'scrollX',
  'scrollY',
  'pageXOffset',
  'pageYOffset',
  'innerWidth',
  'innerHeight',
  'outerWidth',
  'outerHeight',
  'devicePixelRatio',
  'focus',
  'blur',
  'close',
  'alert',
  'confirm',
  'prompt',
  'print',
  'atob',
  'btoa',
]);

export function bootApp(spec: AppSpec, doc: Document | undefined, routes: RouteTable, custom: Customization): void {
  const container = doc?.getElementById('root');
  const view = doc?.defaultView as AppWindow | null | undefined;
  if (!doc || !container || !view) return;
  // A harness can boot the app into a document from another realm (jsdom under
  // Node, as the UI scorer does). React DOM reads the global window for event
  // priority, and third-party effects (the dialog's focus trap and scroll
  // lock) read bare globals like NodeFilter and document. Values the app
  // creates and hands to DOM APIs — events, abort signals, observers — must
  // be the booted document's own realm's or jsdom rejects them, so the view's
  // globals are adopted wholesale. In a browser host.window is the window
  // itself, a getter-only property a strict-mode assignment would throw on,
  // so it is adopted only when the host lacks it.
  const host = globalThis as Record<string, unknown>;
  const source = view as unknown as Record<string, unknown>;
  if (typeof host.window === 'undefined') host.window = view;
  for (const key of Object.getOwnPropertyNames(source)) {
    const domInterface = /^[A-Z]/.test(key) && !REALM_INTRINSICS.has(key);
    if (!domInterface && !REALM_GLOBALS.has(key)) continue;
    const value = source[key];
    if (value === undefined || value === host[key]) continue;
    try {
      host[key] = typeof value === 'function' && REALM_GLOBALS.has(key) ? (value as () => void).bind(view) : value;
    } catch {
      /* the host made this global non-writable; keep its own */
    }
  }
  ensureObservers(view);
  const env: AppEnv = { view, doc, spec, api: createApi(view, custom.api?.headers) };
  const root = createRoot(container, rootErrorOptions);
  flushSync(() => {
    root.render(
      <StrictMode>
        <EnvContext.Provider value={env}>
          <CustomizationContext.Provider value={custom}>
            <AppBoundary>
              <App spec={spec} routes={routes} custom={custom} />
            </AppBoundary>
          </CustomizationContext.Provider>
        </EnvContext.Provider>
      </StrictMode>,
    );
  });
}
