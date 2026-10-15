import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

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
  /** Executable basenames child_process may still run while trapped (default none). */
  allowExec?: string[];
}

/**
 * Trap families assertTrapsWork must see covered; a family with no probe and no
 * excluded member means a trap line was lost or a module shape changed.
 */
const REQUIRED_KINDS = ['fetch', 'http', 'net', 'socket', 'tls', 'http2', 'dns', 'child_process'];

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
  const allowExec = new Set(options.allowExec ?? []);
  const execName = (value: unknown, shell: boolean) => {
    const text = String(value ?? '');
    const first = shell ? (text.trim().split(/\s+/)[0] ?? '') : text;
    return basename(first);
  };
  const guardExec = (api: string, shell: boolean) => (original: (...args: unknown[]) => unknown) => (...args: unknown[]): unknown => {
    const name = execName(args[0], shell);
    if (!allowExec.has(name)) {
      calls.push(api);
      throw new Error(`unexpected network attempt: ${api} (${name || 'unknown'})`);
    }
    return original.apply(cp, args);
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
    const shell = key === 'exec' || key === 'execSync';
    replace(cp, key, `node:child_process.${key}`, 'child_process', cpProbes[key], guardExec(`node:child_process.${key}`, shell));
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
