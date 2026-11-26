/**
 * Remote CSS background images, fetched once at migration time.
 *
 * `c2c fetch-assets` downloads each literal `https` image a page's CSS
 * `background` names into `c2c-assets/<sha256>.<ext>` next to the export and
 * records the result in `c2c-assets.lock.json`. Generation never touches the
 * network: it reads the lock and the cached bytes, checks every byte against
 * the locked hash and the image signature, and serves the file from the app's
 * own origin. This module is the pure half: the policy checks, the image
 * sniff, and the lock reader. The network half is in the cli package.
 */

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export const ASSET_LOCK_FILE = 'c2c-assets.lock.json';
export const ASSET_CACHE_DIR = 'c2c-assets';
/** Largest accepted image, in bytes. */
export const ASSET_MAX_BYTES = 1_048_576;
/** Redirects followed per url. */
export const ASSET_MAX_REDIRECTS = 3;
/** Whole-request deadline, in milliseconds. */
export const ASSET_TIMEOUT_MS = 10_000;
/** Distinct urls fetched or locked per app. */
export const ASSET_MAX_URLS = 32;
/** Longest url accepted. */
export const ASSET_MAX_URL_LENGTH = 2048;

/** Image types served. SVG is not one: it can carry script and markup. */
export const ASSET_EXTENSIONS = ['png', 'jpg', 'gif', 'webp'] as const;
export type AssetExtension = (typeof ASSET_EXTENSIONS)[number];

export const ASSET_MIME: Readonly<Record<AssetExtension, string>> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface AssetLockEntry {
  url: string;
  status: 'fetched' | 'refused' | 'failed';
  sha256?: string;
  ext?: string;
  size?: number;
  reason?: string;
}

/** One remote background as the generator sees it. `bytes` is present only for a verified, fetched image. */
export interface RemoteAsset {
  url: string;
  status: 'fetched' | 'refused' | 'failed';
  reason?: string;
  sha256?: string;
  ext?: AssetExtension;
  bytes?: Buffer;
}

/** Image type from the leading bytes, or undefined. The type is decided here, never from a header or a name. */
export function sniffImage(bytes: Uint8Array): AssetExtension | undefined {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return undefined;
}

/** Extension for a Content-Type header's media type, or undefined when it is not on the allowlist. */
export function extensionForContentType(header: string | undefined): AssetExtension | undefined {
  const essence = (header ?? '').split(';')[0]?.trim().toLowerCase();
  if (essence === 'image/png') return 'png';
  if (essence === 'image/jpeg') return 'jpg';
  if (essence === 'image/gif') return 'gif';
  if (essence === 'image/webp') return 'webp';
  return undefined;
}

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : undefined;
}

function deniedIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
  if (a === 169 && b === 254) return true; // link local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // protocol assignments, documentation
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // documentation
  if (a === 203 && b === 0 && c === 113) return true; // documentation
  return a >= 224; // multicast, reserved, broadcast
}

/** True for an address a migration fetch must never connect to. Unparseable input is denied. */
export function isDeniedAddress(address: string): boolean {
  const text = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const kind = isIP(text);
  if (kind === 4) {
    const octets = ipv4Octets(text);
    return !octets || deniedIpv4(octets);
  }
  if (kind !== 6) return true;
  const groups = expandIpv6(text);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 <= 1) return true; // unspecified, loopback
  const embedded = (hi: number, lo: number) => deniedIpv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return embedded(g6, g7); // ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7); // ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b) return embedded(g6, g7); // NAT64 64:ff9b::/96
  if (g0 === 0x2002) return true; // 6to4: the embedded address is not checked, the range is refused
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // link local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

function expandIpv6(text: string): number[] | undefined {
  let value = text;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (tail) {
    const o = ipv4Octets(tail[1] as string);
    if (!o) return undefined;
    value = `${value.slice(0, -tail[1]!.length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const all = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map((g) => parseInt(g, 16));
}

const DENIED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa', '.corp', '.intranet'];
const DENIED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * The static rules for a fetch target: https only, no credentials, the default
 * port, a registered-looking host name (never an IP literal, `localhost`, or an
 * internal suffix). Runs on the first url and again on every redirect target.
 * The resolved addresses are checked separately, at connect time.
 */
export function checkAssetUrl(value: string): UrlCheck {
  if (value.length > ASSET_MAX_URL_LENGTH) return { ok: false, reason: 'the url is longer than the limit' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'the url does not parse' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: `only https urls are fetched, not ${url.protocol.replace(/:$/, '')}` };
  if (url.username || url.password) return { ok: false, reason: 'a url with credentials is not fetched' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'only the default https port is fetched' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'the url has no host' };
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || host.startsWith('[')) return { ok: false, reason: 'an ip address host is not fetched' };
  if (!host.includes('.')) return { ok: false, reason: 'a single-label host is not fetched' };
  if (DENIED_HOSTS.has(host) || DENIED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { ok: false, reason: 'a local or internal host name is not fetched' };
  return { ok: true, url };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Cache file name for a fetched image. */
export function assetFileName(sha256: string, ext: string): string {
  return `${sha256}.${ext}`;
}

/** The url generated pages use for a fetched image: relative, same-origin, content-named. */
export function assetPublicPath(sha256: string, ext: string): string {
  return `bg/${assetFileName(sha256, ext)}`;
}

const SHA_RE = /^[0-9a-f]{64}$/;

function isExtension(value: unknown): value is AssetExtension {
  return typeof value === 'string' && (ASSET_EXTENSIONS as readonly string[]).includes(value);
}

/** Open a regular file without following a link; undefined when it is absent, linked, or not a plain file. */
function readPlainFile(path: string, max: number): Buffer | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > max) return undefined;
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Parse a lock file's text. Anything malformed is dropped entry by entry; a wrong version gives no entries. */
export function parseAssetLock(text: string): AssetLockEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== 1) return [];
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: AssetLockEntry[] = [];
  const seen = new Set<string>();
  for (const item of entries.slice(0, ASSET_MAX_URLS)) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.url !== 'string' || e.url.length > ASSET_MAX_URL_LENGTH || seen.has(e.url)) continue;
    if (e.status !== 'fetched' && e.status !== 'refused' && e.status !== 'failed') continue;
    seen.add(e.url);
    const entry: AssetLockEntry = { url: e.url, status: e.status };
    if (typeof e.reason === 'string') entry.reason = e.reason.slice(0, 300);
    if (typeof e.sha256 === 'string') entry.sha256 = e.sha256;
    if (typeof e.ext === 'string') entry.ext = e.ext;
    if (typeof e.size === 'number') entry.size = e.size;
    out.push(entry);
  }
  return out;
}

/**
 * The remote assets recorded next to an export. A `fetched` entry becomes
 * usable only when its cached file is a plain file within the size cap whose
 * bytes hash to the locked sha256 and sniff as the locked image type; any
 * other result keeps the entry as a failure naming why. Sorted by url.
 */
export function loadRemoteAssets(dir: string): RemoteAsset[] {
  const lock = readPlainFile(join(dir, ASSET_LOCK_FILE), 1_048_576);
  if (!lock) return [];
  const out: RemoteAsset[] = [];
  for (const entry of parseAssetLock(lock.toString('utf8'))) {
    if (entry.status !== 'fetched') {
      out.push({ url: entry.url, status: entry.status, reason: entry.reason ?? (entry.status === 'refused' ? 'the url was refused' : 'the fetch failed') });
      continue;
    }
    const sha = entry.sha256 ?? '';
    const lockedExt = entry.ext;
    if (!SHA_RE.test(sha) || !isExtension(lockedExt)) {
      out.push({ url: entry.url, status: 'failed', reason: 'the lock entry is malformed' });
      continue;
    }
    const bytes = readPlainFile(join(dir, ASSET_CACHE_DIR, assetFileName(sha, lockedExt)), ASSET_MAX_BYTES);
    if (!bytes) {
      out.push({ url: entry.url, status: 'failed', reason: 'the locked image is missing from the asset cache; run c2c fetch-assets' });
    } else if (sha256Hex(bytes) !== sha) {
      out.push({ url: entry.url, status: 'failed', reason: 'the cached image does not match its locked hash' });
    } else if (sniffImage(bytes) !== lockedExt) {
      out.push({ url: entry.url, status: 'failed', reason: 'the cached file is not an image of the locked type' });
    } else {
      out.push({ url: entry.url, status: 'fetched', sha256: sha, ext: lockedExt, bytes });
    }
  }
  out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return out;
}
