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
    () => view.location.hash,
  );
  const last = useRef<Route>({ name: 'home' });
  const next = parseRoute(hash);
  if (next) last.current = next;
  return last.current;
}

export function navigate(view: Window, hash: string): void {
  view.location.hash = hash;
}
