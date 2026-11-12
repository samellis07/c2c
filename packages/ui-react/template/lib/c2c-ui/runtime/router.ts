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
 * Filter a report click put on the hash. A `filter=c2c-click:` label is the
 * named filter baked into the report. One `Field=value` pair (no `*_op`) is
 * the equality the endpoint already accepts. Anything else is no route filter.
 */
export type ReportClickFilter = '' | string | { field: string; value: string };

export function reportClickFilter(hash: string): ReportClickFilter {
  const text = String(hash || '');
  const at = text.indexOf('?');
  if (at < 0) return '';
  const pairs: { name: string; value: string }[] = [];
  for (const pair of text.slice(at + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) return '';
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(pair.slice(0, eq));
      value = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return '';
    }
    pairs.push({ name, value });
  }
  const labeled = pairs.filter((item) => item.name === 'filter' && item.value.startsWith('c2c-click:'));
  if (labeled.length === 1) return labeled[0]!.value;
  if (labeled.length > 1) return '';
  const rest = pairs.filter((item) => item.name !== 'filter');
  if (rest.some((item) => item.name.endsWith('_op'))) return '';
  if (rest.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rest[0]!.name)) return { field: rest[0]!.name, value: rest[0]!.value };
  return '';
}

/** The current hash. A query-only change still notifies, unlike `useRoute`. */
export function useLocationHash(view: Window): string {
  return useSyncExternalStore(
    (notify) => {
      view.addEventListener('hashchange', notify);
      return () => view.removeEventListener('hashchange', notify);
    },
    () => {
      try {
        return view.location.hash;
      } catch {
        return '';
      }
    },
  );
}

/**
 * The form screen's starting values from a navigation link's query
 * (`#/form/X?Field=value`), or undefined. On an edit route they preset the
 * loaded record's fields — the link's own overrides. Only plain names are
 * kept.
 */
export function routePrefill(hash: string): Record<string, string> | undefined {
  const text = String(hash || '');
  const at = text.indexOf('?');
  if (at < 0) return undefined;
  const route = parseRoute(text);
  if (!route || route.name !== 'form') return undefined;
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
  record?: { field?: string; value?: string };
  params: Array<{ name: string; field?: string; value?: string }>;
  when?: { field: string; equals?: string; nullish?: true };
  branches?: ActionNav[];
}

/** A navigation that prefills from the clicked row, or picks an if/else branch, needs a row to open. */
export function navNeedsRow(nav: ActionNav): boolean {
  if (nav.when || (nav.branches && nav.branches.length)) return true;
  return nav.params.some((param) => typeof param.field === 'string') || typeof nav.record?.field === 'string';
}

/** A nav field reads the row's own key first, then a nested object path — the same order lookup cells resolve. */
function navFieldValue(row: Record<string, unknown> | undefined, field: string): unknown {
  if (!row || typeof field !== 'string' || field === '') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, field)) return row[field];
  if (!field.includes('.')) return undefined;
  let value: unknown = row;
  for (const part of field.split('.')) {
    if (value == null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function navWhenMatches(when: { field: string; equals?: string; nullish?: true } | undefined, row?: Record<string, unknown>): boolean {
  if (!when) return false;
  const raw = row && Object.prototype.hasOwnProperty.call(row, when.field) ? row[when.field] : undefined;
  if (when.nullish === true) return raw == null || raw === '';
  if (typeof when.equals === 'string') {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return String(raw) === when.equals;
    return false;
  }
  return false;
}

function pickNav(nav: ActionNav, row?: Record<string, unknown>): ActionNav | undefined {
  if (!nav.branches?.length) return nav;
  for (const branch of nav.branches) {
    if (!branch.when) return branch;
    if (navWhenMatches(branch.when, row)) return branch;
  }
  return undefined;
}

/**
 * The route a navigation custom action opens: the target's own route (its
 * access gate runs as for any visit) plus a query prefilling the target form.
 * A row value is sent only when the row the caller read holds it as a scalar.
 * An if/else navigation picks the first matching `when`, then the else branch
 * (no `when`); no match opens `#`.
 */
export function actionNavHref(nav: ActionNav, row?: Record<string, unknown>): string | undefined {
  const picked = pickNav(nav, row);
  if (!picked) return '#';
  let href = picked.href;
  if (picked.record) {
    // A record link without its record context is refused; its caller renders
    // the same turned-off control used for a counted manual step.
    let id: string | undefined;
    if (typeof picked.record.field === 'string') {
      const raw = navFieldValue(row, picked.record.field);
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') id = String(raw);
    } else if (typeof picked.record.value === 'string') id = picked.record.value;
    if (id === undefined || id === '') return undefined;
    href += `/${encodeURIComponent(id)}`;
  }
  const query: string[] = [];
  for (const param of picked.params) {
    let value: string | undefined;
    if (typeof param.field === 'string') {
      const raw = navFieldValue(row, param.field);
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') value = String(raw);
    } else if (typeof param.value === 'string') value = param.value;
    if (typeof param.field === 'string' && (value === undefined || value === '')) return undefined;
    if (value !== undefined && value !== '') query.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(value)}`);
  }
  return query.length ? `${href}?${query.join('&')}` : href;
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
