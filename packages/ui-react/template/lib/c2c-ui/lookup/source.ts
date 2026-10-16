/**
 * Lookup options, one page at a time. The c2c_api lookup endpoint
 * (GET /lookups/<form>/<display field>?page=&pageSize=) answers
 * { rows, field }: each row carries ROWID and the display value under
 * `field`. The option value is the ROWID the submit sends back; the text is
 * the display value. Pages are 300 rows (the measured ZCQL row cap), read only
 * when the user opens the control or asks for more, so a large parent table is
 * never read in full. Search filters the pages already read; when it finds
 * nothing and more pages exist, the endpoint is asked for the records whose
 * display matches (?q=, server-side and scoped to what the caller may read),
 * and the control still offers the next page.
 *
 * One source per endpoint and API: every lookup on the screen that points at
 * the same parent (a subform column on ten rows) shares its pages.
 */
import type { Api, ApiReply } from '../runtime/api.js';

export const LOOKUP_PAGE_SIZE = 300;
/** The longest search text the lookup endpoint accepts. */
export const LOOKUP_SEARCH_MAX = 100;

export interface LookupOption {
  value: string;
  label: string;
}

export type LookupState = 'idle' | 'loading' | 'ready' | 'error';

/** The URL of one page of options. */
export function lookupPageUrl(endpoint: string, page: number, pageSize = LOOKUP_PAGE_SIZE): string {
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}page=${page}&pageSize=${pageSize}`;
}

/** The URL of the first page of options whose display matches `query`. */
export function lookupSearchUrl(endpoint: string, query: string, pageSize = LOOKUP_PAGE_SIZE): string {
  return `${lookupPageUrl(endpoint, 0, pageSize)}&q=${encodeURIComponent(query)}`;
}

/** The option text of a record with no display value: neutral, never its ROWID. */
export const LOOKUP_BLANK_LABEL = '(blank)';

/** Options from one reply. Rows without a ROWID (by the lookupIds rule) are not options; a row with no display value shows LOOKUP_BLANK_LABEL. */
export function lookupOptions(body: unknown): LookupOption[] {
  const reply = body && typeof body === 'object' ? (body as { rows?: unknown; field?: unknown }) : {};
  const rows = Array.isArray(reply.rows) ? reply.rows : [];
  const field = typeof reply.field === 'string' ? reply.field : '';
  const out: LookupOption[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = rowIdText((row as Record<string, unknown>).ROWID);
    if (id === undefined) continue;
    const shown = field ? (row as Record<string, unknown>)[field] : undefined;
    const label = shown === null || shown === undefined || shown === '' ? LOOKUP_BLANK_LABEL : String(shown);
    out.push({ value: id, label });
  }
  return out;
}

/** Options whose text contains the query, ignoring case. */
export function filterLookupOptions(options: readonly LookupOption[], query: string): LookupOption[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle)) : [...options];
}

/** A ROWID as its digit string: a digit string, a bigint or a safe integer. A number past 2^53 has already lost digits. */
function rowIdText(v: unknown): string | undefined {
  if (typeof v === 'string') return /^\d+$/.test(v) ? v : undefined;
  if (typeof v === 'bigint') return v >= 0n ? v.toString() : undefined;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined;
  return undefined;
}

/**
 * A stored lookup value as ids: a ROWID, a list of them, or { ROWID | value | id }
 * objects. Bare and wrapped values follow the same rule (see rowIdText); a value
 * that is not an id is dropped.
 */
export function lookupIds(value: unknown): string[] {
  const one = (item: unknown): string | undefined => {
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      for (const key of ['ROWID', 'value', 'id', 'ID']) {
        if (obj[key] !== undefined && obj[key] !== null) return rowIdText(obj[key]);
      }
      return undefined;
    }
    return rowIdText(item);
  };
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];
  return list.map(one).filter((id): id is string => id !== undefined && id !== '');
}

/** Display text a stored value already carries ({ ROWID, label | display_value }), by id. */
export function lookupKnownLabels(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of Array.isArray(value) ? value : [value]) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = lookupIds(obj)[0];
    const label = [obj.label, obj.display_value, obj.zc_display_value].find((v) => typeof v === 'string' && v !== '');
    if (id && typeof label === 'string') out.set(id, label);
  }
  return out;
}

export interface LookupSnapshot {
  state: LookupState;
  options: readonly LookupOption[];
  /** True once a short page arrived: there is nothing more to read. */
  done: boolean;
  pages: number;
  /** The failed page's HTTP status (0 for a dropped network), so the control can name or deny it. */
  status: number | null;
}

type Get = (url: string) => Promise<ApiReply<unknown>>;

/** The pages of one lookup endpoint read so far. */
export class LookupSource {
  private options: LookupOption[] = [];
  private seen = new Set<string>();
  private pages = 0;
  private done = false;
  private state: LookupState = 'idle';
  private status: number | null = null;
  private pending: Promise<void> | undefined;
  private searched = new Set<string>();
  private listeners = new Set<() => void>();
  private snap: LookupSnapshot = { state: 'idle', options: [], done: false, pages: 0, status: null };

  constructor(private readonly get: Get, readonly endpoint: string, readonly pageSize = LOOKUP_PAGE_SIZE) {}

  snapshot(): LookupSnapshot {
    return this.snap;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Read the first page unless it was read already. */
  open(): Promise<void> {
    return this.pages === 0 && this.state !== 'error' ? this.more() : this.pending ?? Promise.resolve();
  }

  /** Read the next page. Concurrent calls share one request; nothing is read after the last page. */
  more(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.done) return Promise.resolve();
    this.state = 'loading';
    this.status = null;
    this.emit();
    const page = this.pages;
    this.pending = this.get(lookupPageUrl(this.endpoint, page, this.pageSize))
      .then(
        (reply) => {
          if (!reply.ok) {
            // A static host with no data function has no options; that is an empty list, not an error.
            if ([404, 405, 501].includes(reply.status)) {
              this.done = true;
              this.state = 'ready';
              this.status = null;
            } else {
              this.state = 'error';
              this.status = reply.status;
            }
            return;
          }
          const rows = reply.body && typeof reply.body === 'object' && Array.isArray((reply.body as { rows?: unknown }).rows) ? (reply.body as { rows: unknown[] }).rows : [];
          for (const option of lookupOptions(reply.body)) {
            if (this.seen.has(option.value)) continue;
            this.seen.add(option.value);
            this.options.push(option);
          }
          this.pages = page + 1;
          if (rows.length < this.pageSize) this.done = true;
          this.state = 'ready';
          this.status = null;
        },
        () => {
          this.state = 'error';
          this.status = 0;
        },
      )
      .finally(() => {
        this.pending = undefined;
        this.emit();
      });
    return this.pending;
  }

  /**
   * Ask the endpoint for the records whose display matches `query` when the
   * pages read hold no match and more pages exist. Found records join the
   * options (no duplicates); the paging is unchanged. Each text is asked once.
   */
  search(query: string): Promise<void> {
    const text = query.trim();
    const key = text.toLocaleLowerCase();
    if (!text || text.length > LOOKUP_SEARCH_MAX || this.done || this.searched.has(key)) return Promise.resolve();
    if (filterLookupOptions(this.options, text).length) return Promise.resolve();
    this.searched.add(key);
    return this.get(lookupSearchUrl(this.endpoint, text, this.pageSize)).then(
      (reply) => {
        if (!reply.ok) return;
        let added = false;
        for (const option of lookupOptions(reply.body)) {
          if (this.seen.has(option.value)) continue;
          this.seen.add(option.value);
          this.options.push(option);
          added = true;
        }
        if (added) this.emit();
      },
      () => undefined,
    );
  }

  /** Try again after a failed page. */
  retry(): Promise<void> {
    if (this.state === 'error') this.state = 'idle';
    return this.more();
  }

  private emit(): void {
    this.snap = { state: this.state, options: [...this.options], done: this.done, pages: this.pages, status: this.status };
    for (const listener of this.listeners) listener();
  }
}

const sources = new WeakMap<Api, Map<string, LookupSource>>();

/** The shared source for an endpoint on this API. */
export function lookupSource(api: Api, endpoint: string): LookupSource {
  let byEndpoint = sources.get(api);
  if (!byEndpoint) {
    byEndpoint = new Map();
    sources.set(api, byEndpoint);
  }
  let source = byEndpoint.get(endpoint);
  if (!source) {
    source = new LookupSource((url) => api.get(url), endpoint);
    byEndpoint.set(endpoint, source);
  }
  return source;
}
