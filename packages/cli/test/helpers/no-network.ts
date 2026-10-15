import { createRequire, syncBuiltinESMExports } from 'node:module';
import { delimiter, resolve, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';

const require = createRequire(import.meta.url);

export interface NetworkTrap {
  calls: string[];
  /** Deliberately invoke every installed trap; each probe must throw. */
  assertTrapsWork(): void;
  restore(): void;
}

export interface NetworkTrapOptions {
  /** Leave selected API traps open so a lower-level boundary can be tested. */
  exclude?: string[];
  /** Executable paths child_process may still run while trapped (default none). */
  allowExec?: string[];
}

/**
 * Trap families assertTrapsWork must see covered; a family with no probe and no
 * excluded member means a trap line was lost or a module shape changed.
 */
const REQUIRED_KINDS = ['fetch', 'http', 'net', 'socket', 'tls', 'http2', 'dns', 'child_process', 'worker'];

/** Release whatever an untrapped probe may have started (request, socket, session, child). */
function tidy(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const v = value as { then?: unknown; catch?: unknown; destroy?: unknown; close?: unknown; kill?: unknown; on?: unknown };
  if (typeof v.on === 'function') (v.on as (event: string, fn: () => void) => unknown)('error', () => {});
  if (typeof v.then === 'function' && typeof v.catch === 'function') {
    (v.catch as (fn: () => void) => unknown)(() => {});
  } else if (typeof v.destroy === 'function') {
    (v.destroy as () => void)();
  } else if (typeof v.close === 'function') {
    (v.close as () => void)();
  }
  if (typeof v.kill === 'function') (v.kill as (signal: string) => void)('SIGKILL');
}

/** Block Node and web-platform egress while a test exercises offline behavior. */
export function trapNetwork(options: NetworkTrapOptions = {}): NetworkTrap {
  const calls: string[] = [];
  const probes: Array<{ api: string; kind: string; run: () => unknown }> = [];
  const excludedKinds = new Set<string>();
  const originals: Array<() => void> = [];
  const deny = (api: string) => (..._args: unknown[]): never => {
    calls.push(api);
    throw new Error(`unexpected network attempt: ${api}`);
  };
  const replace = (
    target: Record<string, unknown>,
    key: string,
    api: string,
    kind: string,
    probe: () => unknown,
    wrap?: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
  ) => {
    if (options.exclude?.includes(api)) {
      excludedKinds.add(kind);
      return;
    }
    const original = target[key];
    if (typeof original !== 'function') return;
    const blocked = wrap ? wrap(original as (...args: unknown[]) => unknown) : deny(api);
    target[key] = blocked;
    originals.push(() => { target[key] = original; });
    probes.push({ api, kind, run: probe });
  };

  replace(globalThis as unknown as Record<string, unknown>, 'fetch', 'global.fetch', 'fetch',
    () => tidy((globalThis.fetch as (url: string) => unknown)('https://trap.invalid/')));

  for (const name of ['node:http', 'node:https']) {
    const mod = require(name) as Record<string, unknown>;
    for (const key of ['request', 'get']) {
      replace(mod, key, `${name}.${key}`, 'http',
        () => tidy((mod[key] as (url: string) => unknown).call(mod, 'https://trap.invalid/')));
    }
  }
  const net = require('node:net') as Record<string, unknown>;
  for (const key of ['connect', 'createConnection']) {
    replace(net, key, `node:net.${key}`, 'net',
      () => tidy((net[key] as (...a: unknown[]) => unknown).call(net, 1, '127.0.0.1')));
  }
  const socket = net.Socket as { prototype: Record<string, unknown>; new (): { connect: (...a: unknown[]) => unknown; destroy: () => void } };
  replace(socket.prototype, 'connect', 'node:net.Socket.connect', 'socket', () => {
    const probe = new (net.Socket as new () => { connect: (...a: unknown[]) => unknown; destroy: () => void })();
    try {
      probe.connect(1, '127.0.0.1');
    } finally {
      probe.destroy();
    }
  });

  const tls = require('node:tls') as Record<string, unknown>;
  replace(tls, 'connect', 'node:tls.connect', 'tls',
    () => tidy((tls.connect as (...a: unknown[]) => unknown)(1, '127.0.0.1')));

  const http2 = require('node:http2') as Record<string, unknown>;
  replace(http2, 'connect', 'node:http2.connect', 'http2',
    () => tidy((http2.connect as (url: string) => unknown)('http://127.0.0.1:1/')));

  const dns = require('node:dns') as Record<string, unknown>;
  for (const key of Object.keys(dns)) {
    if (/^(lookup|resolve\w*|reverse)$/.test(key)) {
      replace(dns, key, `node:dns.${key}`, 'dns',
        () => (dns[key] as (...a: unknown[]) => unknown).call(dns, 'trap.invalid', () => {}));
    }
  }
  const dnsPromises = require('node:dns/promises') as Record<string, unknown>;
  for (const key of Object.keys(dnsPromises)) {
    if (/^(lookup|resolve\w*|reverse)$/.test(key)) {
      replace(dnsPromises, key, `node:dns/promises.${key}`, 'dns',
        () => tidy((dnsPromises[key] as (...a: unknown[]) => unknown).call(dnsPromises, 'trap.invalid')));
    }
  }

  const cp = require('node:child_process') as Record<string, unknown>;
  const resolveExecutable = (value: unknown, cwd = process.cwd(), pathValue = process.env.PATH ?? ''): string => {
    const text = String(value ?? '');
    if (!text || /[\n\r]/.test(text)) return '';
    try {
      const candidates = text.includes('/') || text.includes('\\')
        ? [isAbsolute(text) ? text : resolve(cwd, text)]
        : pathValue.split(delimiter).filter(Boolean).map((directory) => resolve(cwd, directory, text));
      for (const candidate of candidates) {
        try { return realpathSync(candidate); } catch { /* try next PATH entry */ }
      }
    } catch { /* unresolved commands are denied */ }
    return '';
  };
  const allowedExecutables = new Set((options.allowExec ?? []).map((path) => resolveExecutable(path)).filter(Boolean));
  const denyExec = (api: string, detail: string): never => {
    calls.push(api);
    throw new Error(`unexpected network attempt: ${api}${detail ? ` (${detail})` : ''}`);
  };
  const guardExec = (api: string) => (original: (...args: unknown[]) => unknown) => (...args: unknown[]): unknown => {
    const command = String(args[0] ?? '');
    const opts = (args.find((arg) => arg && typeof arg === 'object' && !Array.isArray(arg)) ?? {}) as { shell?: unknown; cwd?: unknown; env?: unknown };
    const shellExec = api.endsWith('.exec') || api.endsWith('.execSync');
    const argv = args.find(Array.isArray) as unknown[] | undefined;
    if (opts.shell || shellExec || /[;|&`$\n\r]/.test(command) || argv?.some((value) => /[;|&`$\n\r]/.test(String(value)))) {
      return denyExec(api, 'shell command refused');
    }
    const cwd = typeof opts.cwd === 'string' ? resolve(opts.cwd) : process.cwd();
    const env = opts.env && typeof opts.env === 'object' ? opts.env as NodeJS.ProcessEnv : process.env;
    const path = resolveExecutable(args[0], cwd, env.PATH ?? '');
    if (!path || !allowedExecutables.has(path)) return denyExec(api, path || 'unknown executable');
    // Pin the checked inode path. Passing the original name would resolve PATH/cwd
    // a second time in child_process and re-open a symlink/lookup race.
    const pinnedArgs = [...args];
    pinnedArgs[0] = path;
    const executableCall = () => original.apply(cp, pinnedArgs);
    return executableCall();
  };
  const cpProbeArg = 'c2c-netprobe-nonexistent';
  const cpProbes: Record<string, () => unknown> = {
    spawn: () => tidy((cp.spawn as (...a: unknown[]) => unknown)(cpProbeArg)),
    spawnSync: () => (cp.spawnSync as (...a: unknown[]) => unknown)(cpProbeArg),
    exec: () => tidy((cp.exec as (...a: unknown[]) => unknown)(cpProbeArg)),
    execSync: () => (cp.execSync as (...a: unknown[]) => unknown)(cpProbeArg),
    execFile: () => tidy((cp.execFile as (...a: unknown[]) => unknown)(cpProbeArg)),
    execFileSync: () => (cp.execFileSync as (...a: unknown[]) => unknown)(cpProbeArg),
    fork: () => tidy((cp.fork as (...a: unknown[]) => unknown)(cpProbeArg)),
  };
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    replace(cp, key, `node:child_process.${key}`, 'child_process', cpProbes[key], guardExec(`node:child_process.${key}`));
  }

  const workerThreads = require('node:worker_threads') as Record<string, unknown>;
  if (!options.exclude?.includes('node:worker_threads.Worker')) {
    const originalWorker = workerThreads.Worker as new (...args: unknown[]) => unknown;
    workerThreads.Worker = new Proxy(originalWorker, {
      construct() { return deny('node:worker_threads.Worker')(); },
    });
    originals.push(() => { workerThreads.Worker = originalWorker; });
    excludedKinds.delete('worker');
    probes.push({
      api: 'node:worker_threads.Worker',
      kind: 'worker',
      run: () => new (workerThreads.Worker as new (...args: unknown[]) => unknown)("fetch('http://127.0.0.1:1/')", { eval: true }),
    });
  } else {
    excludedKinds.add('worker');
  }

  // Node bundles undici for global fetch, while some projects also install it
  // as a direct dependency. Trap its Dispatcher boundary when that API exists.
  try {
    const undici = require('undici') as Record<string, unknown>;
    const dispatcher = undici.Dispatcher as { prototype?: Record<string, unknown> } | undefined;
    if (dispatcher?.prototype) {
      replace(dispatcher.prototype, 'dispatch', 'undici.Dispatcher.dispatch', 'undici',
        () => tidy((dispatcher.prototype!.dispatch as (...a: unknown[]) => unknown).call({}, {}, {})));
    }
    const getGlobalDispatcher = undici.getGlobalDispatcher;
    const setGlobalDispatcher = undici.setGlobalDispatcher;
    if (typeof getGlobalDispatcher === 'function' && typeof setGlobalDispatcher === 'function') {
      const previous = (getGlobalDispatcher as () => unknown)();
      const blockedDispatcher = {
        dispatch: deny('undici.globalDispatcher.dispatch'),
        close: () => Promise.resolve(),
        destroy: () => Promise.resolve(),
      };
      (setGlobalDispatcher as (dispatcher: unknown) => void)(blockedDispatcher);
      originals.push(() => (setGlobalDispatcher as (dispatcher: unknown) => void)(previous));
      probes.push({
        api: 'undici.globalDispatcher.dispatch',
        kind: 'undici',
        run: () => tidy(((getGlobalDispatcher as () => { dispatch: (...a: unknown[]) => unknown })()).dispatch({}, {})),
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }

  syncBuiltinESMExports();
  return {
    calls,
    assertTrapsWork() {
      const covered = new Set(probes.map((probe) => probe.kind));
      for (const kind of REQUIRED_KINDS) {
        if (!covered.has(kind) && !excludedKinds.has(kind)) {
          throw new Error(`network trap missing: no ${kind} trap was installed`);
        }
      }
      for (const { api, run } of probes) {
        const count = calls.length;
        try {
          run();
          throw new Error(`network trap did not fire: ${api}`);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes(`unexpected network attempt: ${api}`)) throw error;
        }
        if (calls.length !== count + 1 || calls.at(-1) !== api) throw new Error(`network trap did not record exactly one call: ${api}`);
      }
      calls.length = 0;
    },
    restore() {
      for (const restore of originals.reverse()) restore();
      syncBuiltinESMExports();
    },
  };
}
