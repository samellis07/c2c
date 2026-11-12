/**
 * Byte-exact file decoding. `.ds` encoding is not documented, so we decode
 * strict UTF-8 (BOM kept as a character) and fall back to latin1, which maps
 * every byte to one character. Either way `encode(decode(bytes))` equals the
 * original bytes.
 */

export type Encoding = 'utf8' | 'latin1';

export interface SourceText {
  text: string;
  encoding: Encoding;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decode(bytes: Uint8Array): SourceText {
  try {
    return { text: strictUtf8.decode(bytes), encoding: 'utf8' };
  } catch {
    return { text: Buffer.from(bytes).toString('latin1'), encoding: 'latin1' };
  }
}

export function encode(text: string, encoding: Encoding): Buffer {
  return Buffer.from(text, encoding);
}

/**
 * Refusal text for a locked Marketplace export. Partner apps installed from
 * the Zoho Marketplace are LOCKED in Creator: their export (exportScript)
 * returns HTTP 200 with a small text/html "Access denied" page instead of a
 * .ds. c2c must never treat that as an empty or valid export, so every .ds
 * ingestion point fails closed (exit 2) with this message.
 */
export const LOCKED_EXPORT_MESSAGE =
  'This export is not a Creator .ds: the app looks like a locked Marketplace install. Ask the vendor for the source .ds or an unlocked copy.';

export class LockedExportError extends Error {
  constructor() {
    super(LOCKED_EXPORT_MESSAGE);
    this.name = 'LockedExportError';
  }
}

/** A real export always opens with `application "<name>" {` (see dialect.ts). */
const DS_APPLICATION_HEADER = /^\s*application\s+"/m;

/**
 * True when decoded export text is a locked-install error page, not a .ds.
 * Signals: HTML shell (doctype, or <html> with <head>), "Access denied" with
 * a text/html content type, or an HTML shell with no .ds application header.
 * A real export wins over stray tokens, so Deluge text that merely mentions
 * these words is never flagged. Plain garbage (no HTML at all) is NOT locked:
 * it keeps the generic unparsable path.
 */
export function isLockedExportSource(text: string): boolean {
  if (DS_APPLICATION_HEADER.test(text)) return false;
  const lower = text.toLowerCase();
  const htmlShell = lower.includes('<!doctype html') || (lower.includes('<html') && lower.includes('<head'));
  if (htmlShell) return true;
  return lower.includes('access denied') && lower.includes('text/html');
}
