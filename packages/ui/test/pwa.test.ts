/**
 * Installable-PWA slice: manifest validity, deterministic name+colour icons,
 * the service-worker's /server/ cache rule, and the runtime-neutral
 * registration snippet every shell reuses.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildSlate, generateUi, pwaServiceWorkerSource, serviceWorker } from '../src/index.js';

function appOf(name: string, extra = ''): App {
  return deriveIr(
    parse(
      `application "${name}"
{
${extra}	form Item
	{
		Name
		(
			type = text
		)
	}
}
`,
    ),
  );
}

function slateFiles(app: App): Map<string, string | Buffer> {
  return new Map(buildSlate(generateUi(app).files).map((file) => [file.path, file.data]));
}

function findPath(files: Map<string, string | Buffer>, re: RegExp): string {
  const path = [...files.keys()].find((item) => re.test(item));
  assert.ok(path, `no generated file matches ${re}`);
  return path;
}

/** Decodes the PNGs this generator writes: 8-bit RGBA, filter 0 rows. */
function rasterOf(png: Buffer): { width: number; height: number; pixel: (x: number, y: number) => number[] } {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.equal(body[8], 8, 'bit depth');
      assert.equal(body[9], 6, 'colour type RGBA');
    } else if (type === 'IDAT') idat.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return {
    width,
    height,
    pixel(x, y) {
      const row = y * (width * 4 + 1);
      assert.equal(raw[row], 0, 'rows are written unfiltered');
      const i = row + 1 + x * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    },
  };
}

test('the web manifest validates and its icons are real emitted PNGs', () => {
  const files = slateFiles(appOf('Order Manager'));
  const manifestPath = findPath(files, /^slate\/manifest\.[0-9a-f]{10}\.webmanifest$/);
  const manifest = JSON.parse(String(files.get(manifestPath))) as Record<string, unknown>;
  assert.equal(manifest.name, 'Order Manager');
  assert.equal(typeof manifest.short_name, 'string');
  assert.ok(String(manifest.short_name).length <= 12);
  assert.equal(manifest.id, './');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.match(String(manifest.theme_color), /^#[0-9a-f]{6}$/i);
  assert.match(String(manifest.background_color), /^#[0-9a-f]{6}$/i);
  assert.equal(manifest.background_color, '#f4f7f8', 'the shell background token');
  assert.equal(manifest.theme_color, '#0f3d4c', 'the default shell accent token');

  const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
  assert.ok(Array.isArray(icons) && icons.length >= 2);
  const bySize = new Map(icons.map((icon) => [icon.sizes, icon]));
  for (const size of ['192x192', '512x512'] as const) {
    const icon = bySize.get(size);
    assert.ok(icon, `manifest icon ${size}`);
    assert.equal(icon.type, 'image/png');
    assert.equal(icon.purpose, 'any maskable', 'install icons serve both purposes');
    const side = Number(size.split('x')[0]);
    const png = files.get(`slate/${icon.src.replace(/^\.\//, '')}`) as Buffer;
    assert.ok(png, `emitted ${icon.src}`);
    const raster = rasterOf(png);
    assert.equal(raster.width, side);
    assert.equal(raster.height, side);
  }

  const index = String(files.get('slate/index.html'));
  assert.match(index, new RegExp(`<link rel="manifest" href="\\./${manifestPath.slice('slate/'.length)}"`));
});

test('icons are a deterministic monogram of the app name on the icon colour', () => {
  const themed = `	customize
	{
		icon
		{
			icon = "zc-ab-finance11"
			background color = "amethyst"
			foreground color = "#FFFFFF"
		}
	}
`;
  const iconOf = (app: App) => {
    const files = slateFiles(app);
    return files.get(findPath(files, /^slate\/icons\/icon-192\.[0-9a-f]{10}\.png$/)) as Buffer;
  };
  const first = iconOf(appOf('Order Manager', themed));
  const again = iconOf(appOf('Order Manager', themed));
  assert.deepEqual([...again], [...first], 'same name, same icon bytes');

  // The monogram comes from the name: two apps sharing the icon colour still
  // get different icons.
  const other = iconOf(appOf('Vendor Bills', themed));
  assert.notDeepEqual([...other], [...first], 'the app name shapes the icon');

  // Background is the icon colour; the letter paints a contrasting foreground.
  const raster = rasterOf(first);
  const corner = raster.pixel(2, 2);
  assert.deepEqual(corner, [155, 81, 224, 255], 'amethyst icon background');
  const colors = new Set<string>();
  for (let y = 0; y < raster.height; y += 4) {
    for (let x = 0; x < raster.width; x += 4) colors.add(raster.pixel(x, y).join(','));
  }
  assert.ok(colors.size > 1, 'the monogram paints a glyph, not a flat tile');
});

const ORIGIN = 'https://app.example';

/**
 * Runs the built sw.js against Node's real Request/Response and a Cache
 * Storage that, like the browser's, keys entries by URL alone and rejects a
 * put for a 206, a `Vary: *` response, or a full quota.
 */
async function workerHarness(sw: string, workerUrl = `${ORIGIN}/sw.js`) {
  const caches = new Map<string, Map<string, Response>>();
  const network = { offline: false, quotaFull: false };
  const fetched: string[] = [];
  let serve: (req: Request) => Response = (req) => new Response(`live ${new URL(req.url).pathname}`);
  const listeners: Record<string, (event: never) => void> = {};
  const keyOf = (key: Request | string) => new URL(typeof key === 'string' ? key : key.url, workerUrl).href;
  class SwRequest extends Request {
    constructor(input: Request | string, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, workerUrl).href : input, init);
    }
  }
  const open = async (name: string) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const store = caches.get(name)!;
    return {
      addAll: async (entries: Request[]) => {
        for (const entry of entries) store.set(keyOf(entry), new Response(`precached ${new URL(entry.url).pathname}`));
      },
      match: async (key: Request | string, opts?: { ignoreSearch?: boolean }) => {
        const urlStr = keyOf(key);
        if (opts?.ignoreSearch) {
          const target = new URL(urlStr).pathname;
          for (const [k, v] of store.entries()) {
            if (new URL(k).pathname === target) return v.clone();
          }
          return undefined;
        }
        return store.get(urlStr)?.clone();
      },
      put: async (key: Request | string, res: Response) => {
        if (res.status === 206) throw new TypeError('Cache.put: 206 Partial Content');
        if ((res.headers.get('vary') ?? '').includes('*')) throw new TypeError('Cache.put: Vary *');
        if (network.quotaFull) throw new DOMException('quota', 'QuotaExceededError');
        store.set(keyOf(key), res);
      },
    };
  };
  const sandbox = {
    self: {
      addEventListener(type: string, fn: (event: never) => void) {
        listeners[type] = fn;
      },
      skipWaiting() {},
      clients: { claim: () => Promise.resolve() },
      location: { origin: ORIGIN, href: workerUrl },
    },
    caches: {
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
      open,
    },
    Request: SwRequest,
    fetch: async (req: Request) => {
      fetched.push(req.url);
      if (network.offline) throw new TypeError('Failed to fetch');
      return serve(req);
    },
    URL,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(sw, sandbox);
  const lifecycle = async (type: 'install' | 'activate') => {
    const waits: Promise<unknown>[] = [];
    listeners[type]({ waitUntil: (p: Promise<unknown>) => waits.push(p) } as never);
    await Promise.all(waits);
  };
  /** Dispatches a fetch; undefined when the worker leaves it to the network. */
  const dispatch = async (url: string, init: RequestInit & { navigate?: boolean } = {}) => {
    const req = new Request(url, init);
    if (init.navigate) Object.defineProperty(req, 'mode', { value: 'navigate' });
    const answers: Promise<Response>[] = [];
    const waits: Promise<unknown>[] = [];
    listeners.fetch({ request: req, respondWith: (p: Promise<Response>) => answers.push(p), waitUntil: (p: Promise<unknown>) => waits.push(p) } as never);
    assert.ok(answers.length <= 1);
    const res = answers.length ? await answers[0] : undefined;
    await Promise.all(waits);
    return res;
  };
  const precache = JSON.parse(/PRECACHE = (\[[^\]]*\])/.exec(sw)?.[1] ?? '[]') as string[];
  const shellUrls = new Set([...precache.map((entry) => keyOf(entry)), `${ORIGIN}/c2c-config.js`]);
  const storedUrls = () => [...caches.values()].flatMap((store) => [...store.keys()]);
  return { caches, network, fetched, listeners, lifecycle, dispatch, shellUrls, storedUrls, open, setServe: (fn: typeof serve) => (serve = fn) };
}

test('the service worker never stores an API response, so no user sees another user\'s data', async () => {
  const sw = String(slateFiles(appOf('Demo')).get('slate/sw.js'));
  const h = await workerHarness(sw);
  await h.lifecycle('install');
  await h.lifecycle('activate');
  // The API answers per user and marks the reply private.
  h.setServe((req) => {
    const path = new URL(req.url).pathname;
    if (!/^\/+(server|api)\//i.test(path)) return new Response(`live ${path}`);
    const who = req.headers.get('authorization') ?? 'nobody';
    return new Response(JSON.stringify({ user: who, rows: [`salary-${who}`] }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store, private' },
    });
  });

  // User A signs in and reads through every API shape the shell can call.
  const apiReads = [
    `${ORIGIN}/server/c2c_api/reports/All_Items`,
    `${ORIGIN}/server/c2c_api/lookups/Item/Name`,
    `${ORIGIN}/server/c2c_api/forms/Item`,
    `${ORIGIN}/Server/c2c_api/reports/All_Items`,
    `${ORIGIN}//server/c2c_api/reports/All_Items`,
    `${ORIGIN}/api/c2c/reports/All_Items`,
    `${ORIGIN}/api/v1/c2c-config.js`,
    `${ORIGIN}/assets/runtime.0000000000.js`,
  ];
  for (const url of apiReads) {
    const res = await h.dispatch(url, { headers: { authorization: 'A' } });
    assert.equal(res, undefined, `${url} goes to the network, not through the cache`);
  }
  // The shell itself is still answered and kept.
  const shell = await h.dispatch(`${ORIGIN}/`, { navigate: true });
  assert.equal(await shell?.text(), 'live /index.html');
  await h.dispatch(`${ORIGIN}/c2c-config.js`);

  // Nothing user-specific is in Cache Storage at any point — so signing out
  // leaves nothing behind for the next person on this device.
  for (const url of h.storedUrls()) assert.ok(h.shellUrls.has(url), `only shell files are cached, found ${url}`);
  for (const store of h.caches.values()) {
    for (const res of store.values()) assert.doesNotMatch(await res.clone().text(), /salary/, 'no API body in any cache');
  }

  // User B, or a signed-out page, offline: the worker has no API answer to
  // give, so the read fails instead of showing user A's rows.
  h.network.offline = true;
  for (const headers of [{}, { authorization: 'B' }] as Record<string, string>[]) {
    assert.equal(await h.dispatch(`${ORIGIN}/server/c2c_api/reports/All_Items`, { headers }), undefined);
  }
  // The offline shell still loads and says the data is unavailable.
  const offlineShell = await h.dispatch(`${ORIGIN}/`, { navigate: true });
  assert.equal(await offlineShell?.text(), 'live /index.html');
  const index = String(slateFiles(appOf('Demo')).get('slate/index.html'));
  assert.match(index, /<p id="offline" hidden>Offline: data unavailable\./);
});

test('an update removes API reads an earlier worker version cached', async () => {
  const sw = String(slateFiles(appOf('Demo')).get('slate/sw.js'));
  const h = await workerHarness(sw);
  const old = await h.open('c2c-0000000000');
  await old.put(`${ORIGIN}/server/c2c_api/reports/All_Items`, new Response('{"user":"A"}'));
  await h.lifecycle('install');
  await h.lifecycle('activate');
  assert.equal(h.caches.has('c2c-0000000000'), false, 'the previous version cache is deleted');
  for (const url of h.storedUrls()) assert.ok(h.shellUrls.has(url), url);
});

test('a failed cache write still hands the page the network response', async () => {
  const sw = String(slateFiles(appOf('Demo')).get('slate/sw.js'));
  const h = await workerHarness(sw);
  await h.lifecycle('install');
  const asset = [...h.shellUrls].find((url) => /\/assets\/app\.[0-9a-f]{10}\.css$/.test(url));
  assert.ok(asset);
  // Drop the precached copy so the asset read goes to the network.
  for (const store of h.caches.values()) store.delete(asset);

  const cases: { label: string; url: string; navigate?: boolean; res: () => Response; quota?: boolean }[] = [
    { label: 'full quota on a shell asset', url: asset, res: () => new Response('fresh css'), quota: true },
    { label: 'Vary: * on the shell', url: `${ORIGIN}/`, navigate: true, res: () => new Response('fresh shell', { headers: { vary: '*' } }) },
    { label: 'full quota on c2c-config.js', url: `${ORIGIN}/c2c-config.js`, res: () => new Response('fresh config'), quota: true },
  ];
  for (const c of cases) {
    h.network.quotaFull = Boolean(c.quota);
    h.setServe(c.res);
    const res = await h.dispatch(c.url, { navigate: c.navigate });
    assert.ok(res, c.label);
    assert.equal(await res.text(), await c.res().text(), `${c.label}: the network response wins`);
  }
  h.network.quotaFull = false;

  // A 206 is never written, and the page still gets it.
  h.setServe(() => new Response('part', { status: 206 }));
  for (const store of h.caches.values()) store.delete(asset);
  const partial = await h.dispatch(asset);
  assert.equal(partial?.status, 206);
  assert.equal(h.storedUrls().includes(asset), false);
});

test('the worker still leaves writes, sign-in, SDK and cross-origin traffic alone', async () => {
  const sw = String(slateFiles(appOf('Demo')).get('slate/sw.js'));
  const h = await workerHarness(sw);
  await h.lifecycle('install');
  assert.equal(await h.dispatch(`${ORIGIN}/server/c2c_api/reports/R`, { navigate: true }), undefined, '/server/ navigations');
  assert.equal(await h.dispatch(`${ORIGIN}/server/c2c_api/forms/Item/submit`, { method: 'POST', body: '{}' }), undefined, 'writes');
  for (const path of ['/accounts/p/1001/signin', '/__catalyst/sdk/init.js', '/baas/v1/x']) {
    assert.equal(await h.dispatch(`${ORIGIN}${path}`), undefined, path);
  }
  assert.equal(await h.dispatch('https://project.example/server/c2c_api/reports/R'), undefined, 'cross-origin');
});

test('the React target keeps one worker template: serviceWorker() is the pwa.ts source', () => {
  assert.equal(serviceWorker(), pwaServiceWorkerSource());
  assert.match(serviceWorker(), /@@cache@@/);
});

test('a standalone registration snippet wires the worker, not a runtime', () => {
  const files = slateFiles(appOf('Demo'));
  const registerPath = findPath(files, /^slate\/pwa-register\.[0-9a-f]{10}\.js$/);
  const register = String(files.get(registerPath));
  assert.match(register, /serviceWorker\.register/);
  assert.match(register, /updateViaCache:\s*"none"/, 'update checks never honour the year-long asset cache');
  assert.match(register, /"\.\/sw\.js"|'\.\/sw\.js'/, 'registers the stable worker URL');

  const index = String(files.get('slate/index.html'));
  assert.match(index, new RegExp(registerPath.slice('slate/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'index.html loads the snippet');

  // The snippet is the only registrar: the runtime module (or a later UI
  // module) does not register a second copy.
  const runtimePath = findPath(files, /^slate\/assets\/runtime\.[0-9a-f]{10}\.js$/);
  assert.doesNotMatch(String(files.get(runtimePath)), /serviceWorker\s*\.\s*register/, 'runtimes reuse the snippet');

  // The worker URL itself stays stable — a worker script cannot be hashed.
  assert.ok(files.has('slate/sw.js'));
  // The manifest generator is runtime-neutral: no DOM names in the module's
  // own code (the emitted snippets themselves do run in a page).
  const src = readFileSync('packages/ui/src/pwa.ts', 'utf8').replace(/`[^`]*`|'[^']*'|"[^"]*"/gs, '');
  assert.doesNotMatch(src, /\b(window|document|navigator)\b/, 'pwa.ts emits files; it touches no DOM');
});

test('Slate moves the legacy /app/ path to / before the shell fallback', () => {
  const files = slateFiles(appOf('Demo'));
  const redirects = files.get('slate/_redirects');
  assert.ok(redirects, 'Slate reads _redirects by name — it must not be content-hashed');
  const rules = String(redirects)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.trim().split(/\s+/));
  // First match wins, as Slate applies the file.
  const route = (path: string) => {
    for (const [from, to, status] of rules) {
      const hit = from.endsWith('/*') ? path === from.slice(0, -2) || path.startsWith(from.slice(0, -1)) : path === from;
      if (hit) return { to, status: Number(status) };
    }
    return undefined;
  };
  for (const path of ['/app', '/app/', '/app/index.html', '/app/assets/runtime.0123456789.js']) {
    assert.deepEqual(route(path), { to: '/', status: 302 }, `${path} redirects to the root`);
  }
  assert.deepEqual(route('/report/R'), { to: '/index.html', status: 200 }, 'other paths serve the shell');

  // After the redirect the page URL is the root, so every relative URL the
  // shell references resolves to a file the build emits.
  const index = String(files.get('slate/index.html'));
  const refs = [...index.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 4, 'the shell references its assets relatively');
  const landed = new URL(route('/app/')!.to, 'https://x/app/');
  for (const ref of refs) {
    const path = new URL(ref, landed).pathname.slice(1);
    assert.ok(files.has(`slate/${path}`) || path === 'c2c-config.js', `${ref} resolves to an emitted file`);
  }
  // The registrar resolves ./sw.js against the same root.
  assert.ok(files.has(`slate/${new URL('./sw.js', landed).pathname.slice(1)}`));
});

test('c2c-config.js is correctly intercepted at root and under a subpath deploy', async () => {
  const sw = String(slateFiles(appOf('Demo')).get('slate/sw.js'));
  
  // Test 1: root deploy
  const hRoot = await workerHarness(sw);
  await hRoot.lifecycle('install');
  await hRoot.lifecycle('activate');
  const resRoot = await hRoot.dispatch(`${ORIGIN}/c2c-config.js`);
  assert.ok(resRoot !== undefined, 'root c2c-config.js is intercepted');
  
  // Test 2: subpath deploy
  const hSub = await workerHarness(sw, `${ORIGIN}/app/sw.js`);
  await hSub.lifecycle('install');
  await hSub.lifecycle('activate');
  const resSub = await hSub.dispatch(`${ORIGIN}/app/c2c-config.js`);
  assert.ok(resSub !== undefined, 'subpath c2c-config.js is intercepted');
  
  // The API path is NOT intercepted, even if it shares the file name
  const resApi = await hSub.dispatch(`${ORIGIN}/api/v1/c2c-config.js`);
  assert.equal(resApi, undefined, 'API c2c-config.js is NOT intercepted');
});

test('a cache-first shell asset with a new query fetches fresh bytes', async () => {
  const sw = String(slateFiles(appOf('Demo')).get('slate/sw.js'));
  const h = await workerHarness(sw);
  await h.lifecycle('install');
  const asset = [...h.shellUrls].find((url) => /\/assets\/app\.[0-9a-f]{10}\.css$/.test(url));
  assert.ok(asset, 'a hashed shell stylesheet is precached');
  // The ?v=1 bytes sit on the path. A later write stores that same path.
  for (const store of h.caches.values()) store.set(asset, new Response('v1-bytes'));
  h.setServe(() => new Response('v2-bytes'));
  const before = h.fetched.length;
  const res = await h.dispatch(`${asset}?v=2`);
  assert.ok(res, 'the shell asset is intercepted');
  assert.equal(h.fetched.length - before, 1, 'a new query misses the cached copy and fetches once');
  assert.equal(await res.text(), 'v2-bytes');
  const bodies: string[] = [];
  for (const store of h.caches.values()) {
    for (const [key, cached] of store.entries()) {
      if (new URL(key).pathname === new URL(asset).pathname) bodies.push(await cached.clone().text());
    }
  }
  assert.deepEqual(bodies, ['v2-bytes'], 'the query-less cache entry is replaced by the fresh bytes');
});
