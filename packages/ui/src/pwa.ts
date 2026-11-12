/**
 * Installable-PWA files for a generated app. Runtime-neutral: this module
 * emits bytes only — no DOM, no framework — so any shell (the generated
 * vanilla runtime or a future one) ships the same manifest, icons, service
 * worker and registration snippet.
 *
 *   manifest.webmanifest  name/short_name, theme and background from the
 *                         shell tokens, monogram icons (any + maskable)
 *   icons/icon-*.png      the app initial(s) on the icon background colour
 *   sw.js                 versioned offline shell; stores only the shell's
 *                         own files, never an API response
 *   pwa-register.js       one <script src defer> registers ./sw.js
 *   _redirects            the legacy /app/ sign-in return moves to /, every
 *                         other path serves index.html (hash router)
 */
import { toolchainBannerLines } from '../../core/src/toolchain.js';
import { imagePng, type OutFile } from './build.js';
import { SHELL_BACKGROUND } from './styles.js';
import { DEFAULT_PALETTE } from './theme-map.js';

export interface PwaSpec {
  /** App name — manifest `name`/`short_name` and the icon monogram. */
  name: string;
  /** Manifest `theme_color` — the shell accent token. */
  themeColor?: string;
  /** Manifest `background_color` — the shell page background token. */
  backgroundColor?: string;
  /** Icon background RGB — the app icon background colour. */
  iconRgb?: [number, number, number];
}

const DEFAULT_ICON_RGB: [number, number, number] = [15, 61, 76];

export function pwaFiles(spec: PwaSpec): OutFile[] {
  return [
    { path: 'slate/manifest.webmanifest', data: pwaManifest(spec) },
    { path: 'slate/icons/icon-192.png', data: appIconPng(192, spec) },
    { path: 'slate/icons/icon-512.png', data: appIconPng(512, spec) },
    { path: 'slate/sw.js', data: pwaServiceWorkerSource() },
    { path: 'slate/pwa-register.js', data: pwaRegisterScript() },
    { path: 'slate/_redirects', data: slateRedirects() },
  ];
}

export function pwaManifest(spec: PwaSpec): string {
  const name = spec.name || 'App';
  const body = {
    id: './',
    name,
    short_name: name.slice(0, 12).trimEnd(),
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: spec.backgroundColor ?? SHELL_BACKGROUND,
    theme_color: spec.themeColor ?? DEFAULT_PALETTE.accent,
    icons: [
      { src: '@@asset:slate/icons/icon-192.png@@', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '@@asset:slate/icons/icon-512.png@@', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
  return JSON.stringify(body, null, 2) + '\n';
}

/**
 * The install icon: the app initial(s) on the icon background colour. The
 * letter sits inside the maskable safe zone (the centre square of half the
 * icon side), so one PNG serves both purposes. The foreground is white or the
 * ink token by background luminance — everything derives from the name and
 * colour, so identical inputs give identical bytes.
 */
export function appIconPng(size: number, spec: PwaSpec): Buffer {
  const bg = spec.iconRgb ?? DEFAULT_ICON_RGB;
  const luminance = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
  const fg: [number, number, number] = luminance > 150 ? [20, 34, 38] : [255, 255, 255];
  const glyphs = [...appInitials(spec.name)].map((ch) => GLYPHS[ch] ?? GLYPHS['#']);
  const cols = glyphs.length * 6 - 1;
  const cell = (size * 0.5) / Math.max(cols, 7);
  const left = (size - cols * cell) / 2;
  const top = (size - 7 * cell) / 2;
  return imagePng(size, (x, y) => {
    const gx = Math.floor((x - left) / cell);
    const gy = Math.floor((y - top) / cell);
    if (gy >= 0 && gy < 7 && gx >= 0 && gx < cols && gx % 6 < 5 && glyphs[Math.floor(gx / 6)][gy][gx % 6] === '#') {
      return [fg[0], fg[1], fg[2], 255];
    }
    return [bg[0], bg[1], bg[2], 255];
  });
}

/** Up to two word initials — "Order Manager" → "OM", "Inventory" → "I". */
function appInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word));
  const initial = (word: string) => /[A-Za-z0-9]/.exec(word)?.[0]?.toUpperCase() ?? '';
  if (words.length === 0) return '#';
  return (initial(words[0]) + (words.length > 1 ? initial(words[1]) : '')).slice(0, 2);
}

/**
 * The service worker source. Build tokens @@cache@@, @@index@@ and
 * @@precache@@ are filled by buildSlate, which derives the cache name from
 * these bytes so any edit here bumps the cache.
 */
export function pwaServiceWorkerSource(): string {
  return `${banner([
    'Stable URL. Slate caches every file for a year, including this one, and does',
    'not honour a per-file Cache-Control from this generator. An update check',
    'still revalidates this script every time it runs (the registration sets',
    'updateViaCache "none", and unconditionally once a registration is more',
    'than 24 hours old). INDEX_HASH is the sha256 prefix of index.html, so an',
    'index-only edit changes these bytes.',
    'Install precaches every entry with cache "reload", so a new worker cannot',
    'install a stale index.html out of the year-old HTTP cache.',
    'Activate deletes only previous c2c- caches (this app). Other names stay.',
    'Navigations and /index.html fetches are network-first with a revalidating',
    'fetch; the cached shell is only an offline fallback. c2c-config.js is a',
    'stable URL too and gets the same treatment. Hashed assets stay cache-first.',
    'Only the shell is ever stored: the precache list, index.html and',
    'c2c-config.js, which are the same for every user. Any other request,',
    'every API read included, goes to the network and is never written to a',
    'cache, so one user\'s data can never be answered to another user or to a',
    'signed-out page. Offline, the shell loads and API reads fail; the page',
    'shows that data is unavailable.',
    'Every write, and every request to /accounts/, /__catalyst/, /baas/ or',
    '/server/, is never intercepted — a respondWith there could hand the',
    'embedded sign-in frame the app shell. Cross-origin requests are never',
    'intercepted either.',
    'A failed cache write never costs the page the network response.',
  ])}const CACHE = "c2c-@@cache@@";
const INDEX_HASH = "@@index@@";
const PRECACHE = @@precache@@;
const INDEX_URL = "./index.html";
// Sign-in, SDK and API prefixes. The match is the decoded, slash-collapsed,
// lowercased first segment: a host may spell the same prefix "//accounts",
// "/%61ccounts" or "/Accounts", and a bare "/accounts" carries no trailing
// slash. A path that merely starts with a prefix word stays on the shell.
const PASS_THROUGH = /^\\/+(accounts|__catalyst|baas|server)(\\/|$)/i;
// The shell's own files, by path. Nothing outside this set is cached.
const SHELL = new Set(PRECACHE.map((entry) => new URL(entry, self.location.href).pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith("c2c-") && key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // A malformed escape leaves the path unchanged; the raw spelling is matched.
  let passPath = url.pathname;
  try {
    passPath = decodeURIComponent(passPath);
  } catch {}
  // Sign-in, SDK and API traffic belongs to the network — never the shell.
  if (PASS_THROUGH.test(passPath)) return;
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    // Stable URL behind a year-long HTTP cache: fetch must revalidate, and the
    // cached shell is only the offline fallback.
    event.respondWith(networkFirst(event, new Request(INDEX_URL, { cache: "no-cache" }), INDEX_URL));
    return;
  }
  if (url.pathname === new URL("./c2c-config.js", self.location.href).pathname) {
    event.respondWith(networkFirst(event, new Request(req, { cache: "no-cache" })));
    return;
  }
  // Hashed shell assets are cache-first. Anything else is not the shell —
  // an API read on a custom base, a stale asset name — and is left to the
  // network so its response is never stored.
  if (SHELL.has(url.pathname)) event.respondWith(cacheFirst(event, req));
});

async function cacheFirst(event, req) {
  const cache = await caches.open(CACHE);
  // Match the full URL. A new query misses and is fetched. The write stores
  // the path without the query, so the one shell entry is replaced.
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  store(event, cache, req, res);
  return res;
}

async function networkFirst(event, req, fallbackKey) {
  const cache = await caches.open(CACHE);
  let res;
  try {
    res = await fetch(req);
  } catch (err) {
    const hit = await cache.match(fallbackKey ?? req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
  store(event, cache, fallbackKey ?? req, res);
  return res;
}

// A cache write can reject (a 206, Vary: *, a full quota). The page still
// gets the network response; the write only finishes in the background.
function store(event, cache, key, res) {
  if (res.status !== 200) return;
  const urlStr = (typeof key === 'string' ? key : key.url).split('?')[0];
  const write = cache.put(urlStr, res.clone()).catch(() => {});
  if (typeof event.waitUntil === "function") event.waitUntil(write);
}
`;
}

/**
 * slate/pwa-register.js. A classic script any shell includes with
 * <script src="..." defer></script>. sw.js keeps a stable URL — a worker
 * script cannot be content-hashed — and updateViaCache "none" keeps every
 * update check out of the year-long HTTP cache Slate puts on it.
 */
export function pwaRegisterScript(): string {
  return `// Registers the app shell worker. Runtime-neutral: any shell page includes
// this file with a plain <script src="..." defer></script>.
if ("serviceWorker" in window.navigator) {
  window.addEventListener("load", function () {
    window.navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(function () {});
  });
}
`;
}

/**
 * slate/_redirects. Slate reads this file by name (it is not content-hashed)
 * and applies the first rule that matches. A sign-in return can still bounce
 * to the legacy /app/ path; a 200 rewrite there would keep /app/ as the page
 * URL, so the shell's relative ./assets/ URLs would resolve under /app/ and
 * load HTML. A 302 moves the browser to / instead. Every other path serves
 * the shell; the app routes on the location hash.
 */
export function slateRedirects(): string {
  return `/app / 302
/app/* / 302
/* /index.html 200
`;
}

function banner(lines: string[]): string {
  const stamped = [...lines, ...toolchainBannerLines()];
  return `/**\n${stamped.map((line) => ` * ${line}`).join('\n')}\n */\n`;
}

/** 5×7 letterforms for the icon monogram; '#' rows draw the fallback diamond. */
const GLYPHS: Record<string, string[]> = {
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '3': ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  '9': [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  C: [' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### '],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ### ', '#   #', '#    ', '#  ##', '#   #', '#   #', ' ####'],
  H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  J: ['  ###', '   # ', '   # ', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #'],
  L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
  N: ['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  Q: [' ### ', '#   #', '#   #', '#   #', '# # #', '#  # ', ' ## #'],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '# # #', ' # # '],
  X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
  Z: ['#####', '    #', '   # ', '  #  ', ' #   ', '#    ', '#####'],
  '#': ['     ', '  #  ', ' # # ', '#   #', ' # # ', '  #  ', '     '],
};
