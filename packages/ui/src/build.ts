/**
 * Content-hash the Slate tree.
 *
 * Slate sends `cache-control: public, max-age=31536000` on every asset
 * and offers no per-file header control, so nothing
 * here can keep the two stable-URL files — index.html and sw.js — fresh in
 * the HTTP cache. Meta cache tags cannot help either: browsers do not honour
 * them for document caching, so index.html carries none. Freshness is
 * enforced by the service worker instead. sw.js embeds a hash of index.html
 * so an index-only edit changes the worker bytes; an update check fetches it
 * with cache mode no-cache (every updateViaCache mode except "all", which the
 * registration never sets, and unconditionally once a registration is more
 * than 24 hours old). On install the worker precaches every entry — index.html
 * included — with cache:"reload", so a new worker cannot install a stale shell
 * out of the HTTP cache, and navigations are answered network-first with a
 * revalidating fetch, the cached shell only as an offline fallback. Other
 * files are named with a sha256 prefix. The cache name embeds the worker's own
 * bytes, so an sw.js change bumps it and an installed client moves to a fresh
 * cache. Activate deletes only caches named c2c- (previous versions of this app).
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { dirname, relative } from 'node:path';

export interface OutFile {
  path: string;
  data: string | Buffer;
}

const SHELL = new Set(['slate/index.html', 'slate/sw.js', 'slate/assets/model.js', 'slate/assets/runtime.js', 'slate/manifest.webmanifest']);
/**
 * Stable-name files that are neither hashed nor precached. c2c deploy rewrites
 * c2c-config.js; Slate reads _redirects by name.
 */
const STABLE = new Set(['slate/c2c-config.js', 'slate/_redirects']);

export function solidPng(size: number, rgb: [number, number, number]): Buffer {
  return imagePng(size, () => [rgb[0], rgb[1], rgb[2], 255]);
}

/** A square RGBA PNG, one `paint` call per pixel. Filter byte 0 per row. */
export function imagePng(size: number, paint: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      const [r, g, b, a] = paint(x, y);
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function buildSlate(files: OutFile[]): OutFile[] {
  const slate = files.filter((file) => file.path.startsWith('slate/'));
  const rest = files.filter((file) => !file.path.startsWith('slate/'));
  const hashed = new Map<string, { outPath: string; data: string | Buffer }>();

  for (const file of slate) {
    if (SHELL.has(file.path) || STABLE.has(file.path)) continue;
    const rel = file.path.slice('slate/'.length);
    hashed.set(file.path, { outPath: withHash(rel, sha(file.data)), data: file.data });
  }

  const manifest = must(slate, 'slate/manifest.webmanifest');
  const manifestText = replaceTokens(textOf(manifest), manifest.path, hashed);
  hashed.set(manifest.path, { outPath: withHash('manifest.webmanifest', sha(manifestText)), data: manifestText });

  const model = must(slate, 'slate/assets/model.js');
  const modelText = replaceTokens(textOf(model), model.path, hashed);
  hashed.set(model.path, { outPath: withHash('assets/model.js', sha(modelText)), data: modelText });

  const runtime = must(slate, 'slate/assets/runtime.js');
  const runtimeText = replaceTokens(textOf(runtime), runtime.path, hashed);
  hashed.set(runtime.path, { outPath: withHash('assets/runtime.js', sha(runtimeText)), data: runtimeText });

  const index = must(slate, 'slate/index.html');
  const indexText = replaceTokens(textOf(index), index.path, hashed);
  const indexHash = sha(indexText);
  const precache = [...hashed.values()].map((file) => `./${file.outPath}`).sort();
  precache.push('./index.html');
  // The worker's own bytes mix into the cache id, so a sw.js change bumps the
  // cache name — an installed client moves to a fresh cache on activate.
  const sw = must(slate, 'slate/sw.js');
  const cacheId = sha(`${sha(textOf(sw))}\n${indexHash}\n${precache.join('\n')}`).slice(0, 10);
  const swText = textOf(sw)
    .replaceAll('@@precache@@', JSON.stringify(precache))
    .replaceAll('@@cache@@', cacheId)
    .replaceAll('@@index@@', indexHash);

  for (const source of [manifestText, modelText, runtimeText, indexText, swText]) {
    if (source.includes('@@asset:') || source.includes('@@precache@@') || source.includes('@@cache@@') || source.includes('@@index@@')) {
      throw new Error('unresolved slate asset token');
    }
  }

  const out: OutFile[] = rest.map((file) => ({ path: file.path, data: file.data }));
  for (const file of [...hashed.values()].sort((a, b) => (a.outPath < b.outPath ? -1 : a.outPath > b.outPath ? 1 : 0))) {
    out.push({ path: `slate/${file.outPath}`, data: file.data });
  }
  out.push({ path: 'slate/index.html', data: indexText });
  out.push({ path: 'slate/sw.js', data: swText });
  for (const file of slate) if (STABLE.has(file.path)) out.push({ path: file.path, data: file.data });
  return out;
}

function must(files: OutFile[], path: string): OutFile {
  const file = files.find((item) => item.path === path);
  if (!file) throw new Error(`slate shell missing ${path}`);
  return file;
}

function textOf(file: OutFile): string {
  return typeof file.data === 'string' ? file.data : file.data.toString('utf8');
}

function replaceTokens(source: string, referrer: string, hashed: Map<string, { outPath: string }>): string {
  return source.replace(/@@asset:([^@]+)@@/g, (_match, logical: string) => {
    const hit = hashed.get(logical);
    if (!hit) throw new Error(`missing asset ${logical}`);
    return relFrom(referrer, `slate/${hit.outPath}`);
  });
}

function relFrom(referrer: string, target: string): string {
  let next = relative(dirname(referrer), target).split('\\').join('/');
  if (!next.startsWith('.')) next = `./${next}`;
  return next;
}

function withHash(rel: string, hash: string): string {
  const dot = rel.lastIndexOf('.');
  const slash = rel.lastIndexOf('/');
  if (dot <= slash) return `${rel}.${hash}`;
  return `${rel.slice(0, dot)}.${hash}${rel.slice(dot)}`;
}

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 10);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
