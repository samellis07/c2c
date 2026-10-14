/**
 * File bytes: Creator Download File → one Stratus object per value.
 *
 * The row mover (`migrateData` with `MigrateTable.files`) writes each file cell
 * as its deterministic key `migrated/<form>/<field>/<record id>/<name>`. This
 * step reads the same Creator report pages, downloads each value
 * (`GET …/report/<report>/<id>/<field>/download`, with `filepath` when the
 * value carries one) and PUTs the bytes to that key. The two steps agree on the
 * key without sharing state, so they run in either order.
 *
 * Resumable. The checkpoint stores, per table, the cursor of the page in
 * progress and how many of its rows are finished; nothing else. A rerun
 * re-reads that page and starts at the first unfinished row. A PUT without the
 * `overwrite` header answers 409 when the key exists, so a row redone after a
 * crash counts as `existing`, never as a second object.
 *
 * Fail closed. A Creator 404 is a missing source file: it is listed and the run
 * goes on. Any other download or upload failure stops that table, keeps the
 * checkpoint at the failing row, and reports the error. Counts are only what
 * Stratus acknowledged; nothing is invented. Bytes are held in memory for one
 * value at a time and never logged.
 */
import { creatorFilePath, migratedObjectKey } from '../../shims/src/files.js';
import { assertAllowedHost, creatorUrl, readPage, type FetchLike } from './migrate.js';

export interface FileBytesTable {
  /** Creator report link name the rows are read from. */
  report: string;
  /** Creator form link name; the key prefix. */
  form: string;
  /** Data Store table; the checkpoint key. */
  table: string;
  /** File, image, audio, video, and signature field link names. */
  columns: readonly string[];
}

export interface BytesResponse {
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type BytesFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array },
) => Promise<BytesResponse>;

/** Where the bytes go. `exists` means the key was already stored (no overwrite). */
export interface ObjectSink {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<'created' | 'exists'>;
}

export interface FileTableCheckpoint {
  /** Cursor that fetched the page in progress. Null is the first page. */
  requestCursor: string | null;
  /** Rows of that page already finished. */
  rowIndex: number;
  uploaded: number;
  existing: number;
  empty: number;
  done: boolean;
}

export interface FileCheckpoint {
  version: 1;
  tables: Record<string, FileTableCheckpoint>;
}

export interface FileBytesOptions {
  dc: string;
  creatorBase: string;
  owner: string;
  appLink: string;
  tables: FileBytesTable[];
  /** Get Records pages (JSON). The caller's wrapper adds Creator auth. */
  fetch: FetchLike;
  /** Download File (bytes). The caller's wrapper adds Creator auth. */
  download: BytesFetch;
  sink: ObjectSink;
  checkpoint: FileCheckpoint;
  saveCheckpoint?: (checkpoint: FileCheckpoint) => void;
  /** Plan only: read pages and count keys, no download and no upload. */
  dryRun: boolean;
  /** Largest value held in memory. Default 100 MB (Stratus advises multipart above that). */
  maxBytes?: number;
}

export interface MissingFile {
  sourceId: string;
  field: string;
  key: string;
}

/** Counts are this run's. The checkpoint carries the running totals across resumes. */
export interface FileBytesTableResult {
  table: string;
  uploaded: number;
  existing: number;
  empty: number;
  /** Keys a dry run would copy. */
  planned: number;
  /** Creator answered 404 for these values. */
  missing: MissingFile[];
  done: boolean;
  /** Why the table stopped. The checkpoint stays at the failing row. */
  error?: string;
}

export interface FileBytesResult {
  ok: boolean;
  dryRun: boolean;
  tables: FileBytesTableResult[];
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export function emptyFileCheckpoint(): FileCheckpoint {
  return { version: 1, tables: {} };
}

/** Creator Download File URL for one value. */
export function creatorDownloadUrl(base: string, owner: string, app: string, report: string, id: string, field: string, value: string): string {
  const url = `${creatorUrl(base, owner, app, report)}/${encodeURIComponent(id)}/${encodeURIComponent(field)}/download`;
  const filepath = creatorFilePath(value);
  return filepath ? `${url}?filepath=${filepath}` : url;
}

function contentTypeOf(response: BytesResponse): string {
  const raw = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw) ? raw : 'application/octet-stream';
}

export async function migrateFileBytes(opts: FileBytesOptions): Promise<FileBytesResult> {
  if (opts.checkpoint.version !== 1) throw new Error('file checkpoint version must be 1');
  opts.checkpoint.tables ??= {};
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const results: FileBytesTableResult[] = [];
  const save = () => opts.saveCheckpoint?.(opts.checkpoint);
  for (const table of opts.tables) {
    const state: FileTableCheckpoint = opts.checkpoint.tables[table.table] ?? {
      requestCursor: null,
      rowIndex: 0,
      uploaded: 0,
      existing: 0,
      empty: 0,
      done: false,
    };
    if (!opts.dryRun) opts.checkpoint.tables[table.table] = state;
    const result: FileBytesTableResult = { table: table.table, uploaded: 0, existing: 0, empty: 0, planned: 0, missing: [], done: state.done };
    results.push(result);
    if (state.done) continue;
    const pageUrl = creatorUrl(opts.creatorBase, opts.owner, opts.appLink, table.report);
    let cursor = state.requestCursor;
    let start = state.rowIndex;
    try {
      for (;;) {
        const page = await readPage(opts.fetch, pageUrl, cursor, opts.dc);
        for (let i = start; i < page.rows.length; i++) {
          const row = page.rows[i]!;
          for (const field of table.columns) {
            const value = row.columns[field];
            const key = migratedObjectKey(table.form, field, row.id, value);
            if (!key) {
              result.empty += 1;
              if (!opts.dryRun) state.empty += 1;
              continue;
            }
            if (opts.dryRun) {
              result.planned += 1;
              continue;
            }
            const url = creatorDownloadUrl(opts.creatorBase, opts.owner, opts.appLink, table.report, row.id, field, String(value));
            assertAllowedHost(url, opts.dc);
            const response = await opts.download(url, { method: 'GET', headers: { Accept: '*/*' } });
            if (response.status === 404) {
              result.missing.push({ sourceId: row.id, field, key });
              continue;
            }
            if (response.status >= 400) throw new Error(`creator download failed: ${response.status} (${table.form}.${field})`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > maxBytes) throw new Error(`file over ${maxBytes} bytes (${table.form}.${field}); multipart is not implemented`);
            const stored = await opts.sink.put(key, bytes, contentTypeOf(response));
            if (stored === 'created') {
              result.uploaded += 1;
              state.uploaded += 1;
            } else {
              result.existing += 1;
              state.existing += 1;
            }
          }
          if (!opts.dryRun) {
            state.rowIndex = i + 1;
            save();
          }
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        start = 0;
        if (!opts.dryRun) {
          state.requestCursor = cursor;
          state.rowIndex = 0;
          save();
        }
      }
      result.done = true;
      if (!opts.dryRun) {
        state.done = true;
        save();
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      if (!opts.dryRun) save();
    }
  }
  return { ok: results.every((r) => !r.error), dryRun: opts.dryRun, tables: results };
}

/** Stratus object host suffix per DC. Development buckets are `<bucket>-development`. */
export const STRATUS_HOSTS: Record<string, string> = {
  in: 'zohostratus.in',
  com: 'zohostratus.com',
  eu: 'zohostratus.eu',
  'com.au': 'zohostratus.com.au',
  jp: 'zohostratus.jp',
  ca: 'zohostratus.ca',
  sa: 'zohostratus.sa',
};

export interface StratusRestSinkOptions {
  bucket: string;
  dc: string;
  environment: 'development' | 'production';
  /** OAuth token with Stratus.fileop.CREATE. Sent as `Zoho-oauthtoken`. */
  token: string;
  fetch: BytesFetch;
}

/** Object URL: each key segment percent-encoded, slashes kept. */
export function stratusObjectUrl(bucket: string, dc: string, environment: 'development' | 'production', key: string): string {
  const host = STRATUS_HOSTS[dc.toLowerCase()];
  if (!host) throw new Error(`no Stratus host for DC ${dc}`);
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(bucket)) throw new Error('bucket name must be 3-50 lowercase letters, digits, or -');
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://${bucket}${environment === 'development' ? '-development' : ''}.${host}/${path}`;
}

/**
 * Upload through the Stratus object REST API: `PUT https://<bucket>.zohostratus.<tld>/<key>`
 * with Content-Type and no `overwrite` header, so an existing key answers 409.
 * https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/stratus/upload-object/
 */
export function stratusRestSink(options: StratusRestSinkOptions): ObjectSink {
  return {
    async put(key, bytes, contentType) {
      const url = stratusObjectUrl(options.bucket, options.dc, options.environment, key);
      const response = await options.fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Zoho-oauthtoken ${options.token}`, 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) },
        body: bytes,
      });
      if (response.status === 409) return 'exists';
      if (response.status >= 200 && response.status < 300) return 'created';
      throw new Error(`stratus upload failed: ${response.status}`);
    },
  };
}
