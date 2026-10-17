/**
 * Hash routes, the same URLs as the vanilla runtime so bookmarks and the
 * smoke plan keep working: #/form/<name>, #/form/<name>/edit/<ROWID>,
 * #/report/<name>, #/page/<name>. Flow screens add a third segment for the
 * view (#/flow/approvals/completed). A hash that is not a route (the skip
 * link's #main) keeps the current screen.
 */
import { useRef, useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'form'; id: string; edit?: string }
  | { name: 'report'; id: string; row?: string }
  | { name: 'record'; id: string; row: string }
  | { name: 'page'; id: string }
  /** The hidden admin smoke page — never in the nav. */
  | { name: 'smoke'; id: 'smoke' }
  | { name: 'flow'; id: string; view?: string }
  | { name: 'missing'; id: string };

export function parseRoute(hash: string): Route | undefined {
  const [pathPart] = String(hash || '').split('?');
  const raw = pathPart.replace(/^#/, '');
  if (raw !== '' && !raw.startsWith('/')) return undefined;
  const parts = raw
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (!parts.length) return { name: 'home' };
  // Hidden admin route — `c2c smoke --in-browser` points a browser here.
  if (parts[0] === 'admin' && parts[1] === 'smoke') return { name: 'smoke', id: 'smoke' };
  if (parts[0] === 'form' && parts[1]) return { name: 'form', id: parts[1], edit: parts[2] === 'edit' ? parts[3] : undefined };
  if (parts[0] === 'report' && parts[1]) return { name: 'report', id: parts[1], row: parts[2] === 'row' ? parts[3] : undefined };
  if (parts[0] === 'record' && parts[1] && parts[2]) return { name: 'record', id: parts[1], row: parts[2] };
  if (parts[0] === 'page' && parts[1]) return { name: 'page', id: parts[1] };
  if (parts[0] === 'flow' && parts[1]) return { name: 'flow', id: parts[1], view: parts[2] };
  return { name: 'missing', id: parts.join('/') };
}

export function hrefFor(kind: 'form' | 'report' | 'page' | 'flow', name: string, ...rest: string[]): string {
  return `#/${[kind, name, ...rest].map(encodeURIComponent).join('/')}`;
}

/**
 * The add screen's starting values from a navigation link's query
 * (`#/form/X?Field=value`), or undefined. Only plain names are kept; an edit
 * route never prefills.
 */
export function routePrefill(hash: string): Record<string, string> | undefined {
  const text = String(hash || '');
  const at = text.indexOf('?');
  if (at < 0) return undefined;
  const route = parseRoute(text);
  if (!route || route.name !== 'form' || route.edit) return undefined;
  const out: Record<string, string> = {};
  let any = false;
  for (const pair of text.slice(at + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(pair.slice(0, eq));
      value = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = value;
    any = true;
  }
  return any ? out : undefined;
}

export interface ActionNav {
  href: string;
  params: Array<{ name: string; field?: string; value?: string }>;
}

/** A navigation that prefills from the clicked row needs a row to open. */
export function navNeedsRow(nav: ActionNav): boolean {
  return nav.params.some((param) => typeof param.field === 'string');
}

/**
 * The route a navigation custom action opens: the target's own route (its
 * access gate runs as for any visit) plus a query prefilling the target form.
 * A row value is sent only when the row the caller read holds it as a scalar.
 */
export function actionNavHref(nav: ActionNav, row?: Record<string, unknown>): string {
  const query: string[] = [];
  for (const param of nav.params) {
    let value: string | undefined;
    if (typeof param.field === 'string') {
      const raw = row && Object.prototype.hasOwnProperty.call(row, param.field) ? row[param.field] : undefined;
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') value = String(raw);
    } else if (typeof param.value === 'string') value = param.value;
    if (value !== undefined && value !== '') query.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(value)}`);
  }
  return query.length ? `${nav.href}?${query.join('&')}` : nav.href;
}

/** The route as a stable key, for nav highlighting and route additions. */
export function routeKey(route: Route): string {
  if (route.name === 'home') return '';
  if (route.name === 'flow' && route.view) return `${route.name}/${route.id}/${route.view}`;
  return `${route.name}/${route.id}`;
}

/**
 * The current route. useSyncExternalStore renders a hash change synchronously,
 * so the screen and the nav's current marker always agree.
 */
export function useRoute(view: Window): Route {
  const hash = useSyncExternalStore(
    (notify) => {
      view.addEventListener('hashchange', notify);
      return () => view.removeEventListener('hashchange', notify);
    },
    () => {
      // A scheduled render can land after the window is torn down; a closed
      // window throws on `location`, so read the hash defensively.
      try {
        return view.location.hash;
      } catch {
        return '';
      }
    },
  );
  const last = useRef<Route>({ name: 'home' });
  const next = parseRoute(hash);
  if (next) last.current = next;
  return last.current;
}

export function navigate(view: Window, hash: string): void {
  view.location.hash = hash;
}
