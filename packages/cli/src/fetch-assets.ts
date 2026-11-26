/**
 * `c2c fetch-assets`: the migration-time download of the literal remote CSS
 * backgrounds an export names. This is the only code that opens a network
 * connection for them. Generation (`c2c ui`, `ui-react`, `analyze`) never does:
 * it reads the lock this command writes.
 *
 * Every fetch is bounded: https only, a static host check on the first url and
 * on every redirect target, a connect-time check of every address the host
 * resolves to (the connection is pinned to the checked address, so a later
 * lookup cannot swap it), a redirect cap, a size cap, a deadline, a media-type
 * allowlist and a magic-byte check. Fetched bytes are written to a file and
 * hashed; they are never executed, parsed, or embedded in generated source.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { chmodSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { dirname, join } from 'node:path';
import {
  ASSET_CACHE_DIR,
  ASSET_LOCK_FILE,
  ASSET_MAX_BYTES,
  ASSET_MAX_REDIRECTS,
  ASSET_MAX_URLS,
  ASSET_TIMEOUT_MS,
  assetFileName,
  checkAssetUrl,
  extensionForContentType,
  isDeniedAddress,
  parseAssetLock,
  sha256Hex,
  sniffImage,
  type AssetExtension,
  type AssetLockEntry,
} from '../../core/src/remote-assets.js';
import { literalBackgroundUrls } from '../../ui/src/remote-backgrounds.js';

export interface AssetResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Body chunks. The caller stops reading once the size cap is passed. */
  body: AsyncIterable<Uint8Array>;
  /** Stop the transfer. */
  destroy(): void;
}

export interface FetchDeps {
  /** Every address the host resolves to. */
  resolve(host: string): Promise<string[]>;
  /** One GET to `url`, connected to `address` (already checked). No cookies, no credentials. */
  get(url: URL, address: string, signal: AbortSignal): Promise<AssetResponse>;
}

export type FetchResult =
  | { ok: true; sha256: string; ext: AssetExtension; bytes: Buffer; finalHost: string }
  | { ok: false; status: 'refused' | 'failed'; reason: string };

const refuse = (reason: string): FetchResult => ({ ok: false, status: 'refused', reason });
const fail = (reason: string): FetchResult => ({ ok: false, status: 'failed', reason });

export const nodeFetchDeps: FetchDeps = {
  async resolve(host) {
    const found = await dnsLookup(host, { all: true, verbatim: true });
    return found.map((item) => item.address);
  },
  get(url, address, signal) {
    return new Promise<AssetResponse>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: 'https:',
          hostname: url.hostname,
          servername: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { accept: 'image/png,image/jpeg,image/gif,image/webp', 'accept-encoding': 'identity', 'user-agent': 'creator-to-catalyst-fetch-assets' },
          // The connection goes to the address that passed the check, not to whatever the name resolves to next.
          lookup: (_host, options, callback) => {
            const family = address.includes(':') ? 6 : 4;
            if ((options as { all?: boolean }).all) (callback as unknown as (err: null, list: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
            else callback(null, address, family);
          },
          signal,
        },
        (res) => {
          const headers: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(res.headers)) headers[key] = Array.isArray(value) ? value.join(', ') : value;
          resolve({ status: res.statusCode ?? 0, headers, body: res, destroy: () => res.destroy() });
        },
      );
      req.on('error', reject);
      req.end();
    });
  },
};

/** Fetch one url under every bound. Never throws. */
export async function fetchAsset(start: string, deps: FetchDeps = nodeFetchDeps): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
  try {
    let current = start;
    for (let hop = 0; hop <= ASSET_MAX_REDIRECTS; hop++) {
      const checked = checkAssetUrl(current);
      if (!checked.ok) return refuse(hop === 0 ? checked.reason : `redirect target refused: ${checked.reason}`);
      let addresses: string[];
      try {
        addresses = await deps.resolve(checked.url.hostname);
      } catch {
        return fail('the host name did not resolve');
      }
      if (!addresses.length) return fail('the host name did not resolve');
      const denied = addresses.find((address) => isDeniedAddress(address));
      if (denied !== undefined) return refuse('the host resolves to a private, loopback, link-local or reserved address');
      let res: AssetResponse;
      try {
        res = await deps.get(checked.url, addresses[0] as string, controller.signal);
      } catch {
        return fail(controller.signal.aborted ? 'the request timed out' : 'the request failed');
      }
      if (res.status >= 300 && res.status < 400) {
        res.destroy();
        const location = res.headers.location;
        if (!location) return fail('a redirect named no location');
        if (hop === ASSET_MAX_REDIRECTS) return refuse(`more than ${ASSET_MAX_REDIRECTS} redirects`);
        try {
          current = new URL(location, checked.url).href;
        } catch {
          return fail('a redirect location did not parse');
        }
        continue;
      }
      if (res.status !== 200) {
        res.destroy();
        return fail(`the server answered ${res.status}`);
      }
      if (!extensionForContentType(res.headers['content-type'])) {
        res.destroy();
        return refuse(`the content type ${JSON.stringify((res.headers['content-type'] ?? 'none').split(';')[0]?.slice(0, 60))} is not an allowed image type`);
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > ASSET_MAX_BYTES) {
        res.destroy();
        return refuse(`the image is larger than ${ASSET_MAX_BYTES} bytes`);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > ASSET_MAX_BYTES) {
            res.destroy();
            return refuse(`the image is larger than ${ASSET_MAX_BYTES} bytes`);
          }
          chunks.push(Buffer.from(chunk));
        }
      } catch {
        return fail(controller.signal.aborted ? 'the request timed out' : 'the transfer failed');
      }
      const bytes = Buffer.concat(chunks);
      const sniffed = sniffImage(bytes);
      if (!sniffed) return refuse('the bytes are not a png, jpeg, gif or webp image');
      // The header only has to name an allowed image type; the bytes decide which one the file is.
      return { ok: true, sha256: sha256Hex(bytes), ext: sniffed, bytes, finalHost: checked.url.hostname };
    }
    return refuse(`more than ${ASSET_MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchAssetsSummary {
  entries: AssetLockEntry[];
  fetched: number;
  refused: number;
  failed: number;
  reused: number;
  overCap: number;
}


/** Write `data` to `path` through a sibling temp file opened O_EXCL|O_NOFOLLOW, then rename: a symlink planted at the temp or the target is never followed. */
function writeNoFollow(path: string, data: Uint8Array | string, mode: number): void {
  const temp = `${path}.tmp`;
  rmSync(temp, { force: true });
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, mode);
  renameSync(temp, path);
}

/** The export's own cache directory and lock must be what they claim: refuse a symlink instead of writing through it. */
function refuseSymlink(path: string): void {
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    return;
  }
  if (link) throw new Error('fetch-assets refuses to write through a symbolic link in the export directory');
}

/**
 * Fetch every literal remote background url found in `sources` (the export's
 * text), write the cache and the lock under `dir`. A url already locked as
 * fetched with its cached file present is reused with no network call, so a
 * rerun is offline and leaves the lock byte-identical.
 */
export async function fetchAssetsInto(dir: string, sources: readonly string[], deps: FetchDeps = nodeFetchDeps): Promise<FetchAssetsSummary> {
  const lockPath = join(dir, ASSET_LOCK_FILE);
  const cacheDir = join(dir, ASSET_CACHE_DIR);
  refuseSymlink(lockPath);
  refuseSymlink(cacheDir);
  const existing = new Map<string, AssetLockEntry>();
  if (existsSync(lockPath) && lstatSync(lockPath).isFile()) for (const entry of parseAssetLock(readFileSync(lockPath, 'utf8'))) existing.set(entry.url, entry);
  const urls = [...new Set(sources.flatMap((text) => literalBackgroundUrls(text)))].sort();
  const entries: AssetLockEntry[] = [];
  const summary: FetchAssetsSummary = { entries, fetched: 0, refused: 0, failed: 0, reused: 0, overCap: Math.max(0, urls.length - ASSET_MAX_URLS) };
  for (const url of urls.slice(0, ASSET_MAX_URLS)) {
    const prior = existing.get(url);
    if (prior?.status === 'fetched' && prior.sha256 && prior.ext && existsSync(join(cacheDir, assetFileName(prior.sha256, prior.ext)))) {
      entries.push(prior);
      summary.reused++;
      continue;
    }
    const result = await fetchAsset(url, deps);
    if (result.ok) {
      mkdirSync(cacheDir, { recursive: true });
      refuseSymlink(cacheDir);
      const target = join(cacheDir, assetFileName(result.sha256, result.ext));
      refuseSymlink(target);
      writeNoFollow(target, result.bytes, 0o644);
      entries.push({ url, status: 'fetched', sha256: result.sha256, ext: result.ext, size: result.bytes.length });
      summary.fetched++;
    } else {
      entries.push({ url, status: result.status, reason: result.reason });
      summary[result.status]++;
    }
  }
  mkdirSync(dirname(lockPath), { recursive: true });
  refuseSymlink(lockPath);
  writeNoFollow(lockPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 0o644);
  return summary;
}
