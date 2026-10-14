/**
 * File, image, audio, video, and signature values in Stratus.
 *
 * The Data Store column stores the Stratus object key, never the bytes. One
 * object per value. Keys are deterministic:
 *
 * - client upload: `uploads/<form>/<field>/<sha256>/<file name>`. The client
 *   sends the SHA-256 of the bytes, so the same file on the same field is the
 *   same object, and a retried upload does not create a second one. The server
 *   cannot check the hash before the bytes arrive; the key only names them.
 * - migrated value: `migrated/<form>/<field>/<Creator record id>/<file name>`.
 *
 * Reads and writes from the browser use signed URLs (Stratus
 * `generatePreSignedUrl`, GET or PUT). A signed PUT needs its Content-Type
 * header. https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/stratus/
 */

/** Signed URL lifetime in seconds. Stratus allows 30 s to 7 days; default 3600. */
export const SIGNED_URL_TTL_SECONDS = 600;
/** Stratus object metadata and keys are text; keep a key comfortably short. */
export const FILE_NAME_MAX = 80;

export type SignedAction = 'GET' | 'PUT';

/** The Stratus operations the generated handlers need. Injected in tests. */
export interface FileStore {
  signedUrl(key: string, action: SignedAction, options: { expiresIn: number; contentType?: string }): Promise<string>;
}

/** Thrown for a key, name, hash, or content type the handlers must not sign. */
export class FileReferenceError extends Error {
  readonly code = 'FILE_REFERENCE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'FileReferenceError';
  }
}

const SEGMENT = /^[A-Za-z0-9_]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function segment(value: string, label: string): string {
  if (!SEGMENT.test(value)) throw new FileReferenceError(`${label} must be a link name (letters, digits, _)`);
  return value;
}

/** A file name safe inside a key: `[A-Za-z0-9._-]`, at most 80 characters, never empty or a dot name. */
export function cleanFileName(name: unknown): string {
  const text = typeof name === 'string' ? name : '';
  const base = text.split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, FILE_NAME_MAX);
  return clean || 'file';
}

/** Object key for a browser upload. */
export function uploadObjectKey(form: string, field: string, sha256: string, fileName: unknown): string {
  const hash = String(sha256 ?? '').toLowerCase();
  if (!SHA256.test(hash)) throw new FileReferenceError('sha256 must be 64 hex characters');
  return `uploads/${segment(form, 'form')}/${segment(field, 'field')}/${hash}/${cleanFileName(fileName)}`;
}

/**
 * The file name in a Creator v2.1 file value. Get Records returns a download
 * path such as `/api/v2.1/<owner>/<app>/report/<report>/<id>/<field>/download?filepath=<name>`,
 * or a bare name. The `filepath` parameter wins; otherwise the last segment.
 */
export function creatorFileName(value: string): string {
  const query = value.indexOf('?');
  if (query >= 0) {
    for (const part of value.slice(query + 1).split('&')) {
      const [k, v] = part.split('=');
      if (k === 'filepath' && v) {
        try {
          return decodeURIComponent(v.replace(/\+/g, ' '));
        } catch {
          return v;
        }
      }
    }
  }
  const path = query >= 0 ? value.slice(0, query) : value;
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return last === 'download' ? '' : last;
}

/** The `filepath` query value Creator Download File takes for a multi-file field, if the value carries one. */
export function creatorFilePath(value: string): string | undefined {
  const query = value.indexOf('?');
  if (query < 0) return undefined;
  for (const part of value.slice(query + 1).split('&')) {
    const [k, v] = part.split('=');
    if (k === 'filepath' && v) return v;
  }
  return undefined;
}

/** Object key for a migrated Creator value, or null when the cell is blank. */
export function migratedObjectKey(form: string, field: string, sourceId: string, value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new FileReferenceError(`${form}.${field} file value is not a string`);
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+$/.test(sourceId)) throw new FileReferenceError('source id must be digits');
  return `migrated/${segment(form, 'form')}/${segment(field, 'field')}/${sourceId}/${cleanFileName(creatorFileName(text))}`;
}

const FILE_KEY_HASH = '[0-9a-f]{64}';
const FILE_KEY_RECORD = String.raw`\d+`;
/** File-name piece of a stored object key. Same class and length as `cleanFileName`. */
const FILE_KEY_NAME = `[A-Za-z0-9._-]{1,${FILE_NAME_MAX}}`;
const FILE_KEY_SEGMENT = '[A-Za-z0-9_]+';

/**
 * Stored object key for any form and field:
 * `uploads/<form>/<field>/<sha256>/<name>` or
 * `migrated/<form>/<field>/<record id>/<name>`.
 * `keyBelongsTo` uses these same hash, id, and name pieces and also pins the form and field.
 */
export const FILE_OBJECT_KEY = new RegExp(
  `^(?:uploads/${FILE_KEY_SEGMENT}/${FILE_KEY_SEGMENT}/${FILE_KEY_HASH}|migrated/${FILE_KEY_SEGMENT}/${FILE_KEY_SEGMENT}/${FILE_KEY_RECORD})/${FILE_KEY_NAME}$`,
);

/** True when `key` has the stored file-key shape (any form and field). */
export function isStoredFileKey(key: unknown): boolean {
  if (typeof key !== 'string' || key.length > 512 || key.includes('..') || key.includes('//')) return false;
  return FILE_OBJECT_KEY.test(key);
}

/** True when `key` is an object key this form and field own (an upload or a migrated value). */
export function keyBelongsTo(form: string, field: string, key: unknown): boolean {
  if (typeof key !== 'string' || key.length > 512 || key.includes('..') || key.includes('//')) return false;
  if (!SEGMENT.test(form) || !SEGMENT.test(field)) return false;
  const upload = new RegExp(`^uploads/${form}/${field}/${FILE_KEY_HASH}/${FILE_KEY_NAME}$`);
  const migrated = new RegExp(`^migrated/${form}/${field}/${FILE_KEY_RECORD}/${FILE_KEY_NAME}$`);
  return upload.test(key) || migrated.test(key);
}

export function contentTypeOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) return 'application/octet-stream';
  if (!CONTENT_TYPE.test(text)) throw new FileReferenceError('content type is not a MIME type');
  return text;
}

/**
 * Signs a browser upload. Returns the reference the record stores and the PUT
 * the browser sends. The PUT must carry the same Content-Type header.
 */
export async function signUpload(
  store: FileStore,
  form: string,
  field: string,
  request: { sha256?: unknown; filename?: unknown; contentType?: unknown },
  expiresIn = SIGNED_URL_TTL_SECONDS,
): Promise<{ reference: { key: string }; upload: { method: 'PUT'; url: string; headers: Record<string, string>; expiresIn: number } }> {
  const key = uploadObjectKey(form, field, String(request.sha256 ?? ''), request.filename);
  const contentType = contentTypeOf(request.contentType);
  const url = await store.signedUrl(key, 'PUT', { expiresIn, contentType });
  return { reference: { key }, upload: { method: 'PUT', url, headers: { 'Content-Type': contentType }, expiresIn } };
}

/** Signs a download of a key that belongs to this form and field. */
export async function signDownload(
  store: FileStore,
  form: string,
  field: string,
  key: unknown,
  expiresIn = SIGNED_URL_TTL_SECONDS,
): Promise<{ key: string; url: string; expiresIn: number }> {
  if (!keyBelongsTo(form, field, key)) throw new FileReferenceError(`key is not a ${form}.${field} object`);
  const url = await store.signedUrl(key as string, 'GET', { expiresIn });
  return { key: key as string, url, expiresIn };
}

/** Minimal shape of a Catalyst Node SDK app (`catalyst.initialize(req)`). */
export interface CatalystStratusApp {
  stratus(): { bucket(name: string): { generatePreSignedUrl(key: string, action: SignedAction, options?: { expiryIn?: number }): Promise<unknown> } };
}

/**
 * FileStore over the Catalyst SDK. `generatePreSignedUrl` returns
 * `{ signature }`, the signed URL.
 */
export function catalystFileStore(app: CatalystStratusApp, bucket: string): FileStore {
  if (!bucket) throw new Error('Stratus bucket name is required');
  return {
    async signedUrl(key, action, options) {
      const res = (await app.stratus().bucket(bucket).generatePreSignedUrl(key, action, { expiryIn: options.expiresIn })) as
        | { signature?: unknown }
        | string
        | null;
      const url = typeof res === 'string' ? res : res && typeof res.signature === 'string' ? res.signature : '';
      if (!url) throw new Error('Stratus did not return a signed URL');
      return url;
    },
  };
}

/**
 * Before a live write: each file field's `{ key }` reference (the only shape
 * authorizeWrite accepts) becomes the key string the column stores. The key
 * must belong to this form and field, so a record cannot point at another
 * form's object or at a dry-run key. Mutates and returns `record`.
 */
export function storeFileKeys(form: string, record: Record<string, unknown>, fileFields: readonly string[]): Record<string, unknown> {
  for (const field of fileFields) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (value == null || value === '') continue;
    const key = typeof value === 'object' && !Array.isArray(value) ? (value as { key?: unknown }).key : value;
    if (!keyBelongsTo(form, field, key)) throw new FileReferenceError(`${form}.${field} is not an uploaded ${form}.${field} object`);
    record[field] = key;
  }
  return record;
}
