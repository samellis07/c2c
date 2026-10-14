import { createRequire, syncBuiltinESMExports } from 'node:module';

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
}

/** Block Node and web-platform egress while a test exercises offline behavior. */
export function trapNetwork(options: NetworkTrapOptions = {}): NetworkTrap {
  const calls: string[] = [];
  const probes: Array<{ api: string; run: () => unknown }> = [];
  const originals: Array<() => void> = [];
  const deny = (api: string) => (..._args: unknown[]): never => {
    calls.push(api);
    throw new Error(`unexpected network attempt: ${api}`);
  };
  const replace = (target: Record<string, unknown>, key: string, api: string) => {
    if (options.exclude?.includes(api)) return;
    const original = target[key];
    if (typeof original !== 'function') return;
    const blocked = deny(api);
    target[key] = blocked;
    originals.push(() => { target[key] = original; });
    probes.push({ api, run: () => blocked() });
  };

  replace(globalThis as unknown as Record<string, unknown>, 'fetch', 'global.fetch');
  for (const name of ['node:http', 'node:https']) {
    const mod = require(name) as Record<string, unknown>;
    for (const key of ['request', 'get']) replace(mod, key, `${name}.${key}`);
  }
  const net = require('node:net') as Record<string, unknown>;
  for (const key of ['connect', 'createConnection']) replace(net, key, `node:net.${key}`);
  const socket = net.Socket as { prototype: Record<string, unknown> };
  replace(socket.prototype, 'connect', 'node:net.Socket.connect');

  const tls = require('node:tls') as Record<string, unknown>;
  replace(tls, 'connect', 'node:tls.connect');
  const http2 = require('node:http2') as Record<string, unknown>;
  replace(http2, 'connect', 'node:http2.connect');

  const dns = require('node:dns') as Record<string, unknown>;
  for (const key of Object.keys(dns)) {
    if (/^(lookup|resolve\w*|reverse)$/.test(key)) replace(dns, key, `node:dns.${key}`);
  }
  const dnsPromises = require('node:dns/promises') as Record<string, unknown>;
  for (const key of Object.keys(dnsPromises)) {
    if (/^(lookup|resolve\w*|reverse)$/.test(key)) replace(dnsPromises, key, `node:dns/promises.${key}`);
  }

  // Node bundles undici for global fetch, while some projects also install it
  // as a direct dependency. Trap its Dispatcher boundary when that API exists.
  try {
    const undici = require('undici') as Record<string, unknown>;
    const dispatcher = undici.Dispatcher as { prototype?: Record<string, unknown> } | undefined;
    if (dispatcher?.prototype) replace(dispatcher.prototype, 'dispatch', 'undici.Dispatcher.dispatch');
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
      probes.push({ api: 'undici.globalDispatcher.dispatch', run: () => blockedDispatcher.dispatch() });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }

  syncBuiltinESMExports();
  return {
    calls,
    assertTrapsWork() {
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
