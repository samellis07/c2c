/**
 * Deluge file name on the value a generated app holds.
 *
 * A file upload, image, audio, video, or signature column stores a Stratus
 * object key, never the bytes:
 * `uploads/<form>/<field>/<sha256>/<name>` or
 * `migrated/<form>/<field>/<record id>/<name>`. Before the write the value
 * may be `{ key }`, the signed-upload reference. A Creator download path
 * uses its `filepath` parameter as the name, otherwise the last path segment.
 *
 * `getFileName` returns a `name` carried on the value when one is set,
 * otherwise that stored name. `actualname` is the uploaded name and ignores
 * a carried `name`. A blank, null, number, or any other non-file value has
 * no name.
 *
 * Byte length, file bytes, content type, charset, and a PDF or ZIP password
 * are not on this value.
 */
import { creatorFileName } from './files.js';

/** In-memory file value: the stored key plus an optional name override. */
export interface HeldFile {
  key: string;
  name?: string;
}

function isHeld(value: unknown): value is HeldFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'key' || key === 'name')) return false;
  const record = value as { key?: unknown };
  return typeof record.key === 'string' && record.key.trim() !== '';
}

function fileKey(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (isHeld(value)) return value.key;
  return null;
}

/** Uploaded name carried by a key or a Creator download path. No override. */
function uploadedName(value: unknown): string | null {
  const key = fileKey(value);
  if (key == null) return null;
  const name = creatorFileName(key);
  return name || null;
}

/** Name of the file value. A `name` carried on the value wins over the stored name. */
export function getFileName(value: unknown): string | null {
  if (isHeld(value) && Object.hasOwn(value, 'name') && typeof value.name === 'string') return value.name;
  return uploadedName(value);
}

/** Uploaded name. Ignores a `name` carried on the value. */
export function actualname(value: unknown): string | null {
  return uploadedName(value);
}
