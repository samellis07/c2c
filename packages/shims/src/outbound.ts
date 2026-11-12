/**
 * Live `invokeurl` with no `connection:` (a third-party URL). Deny by default:
 * only hosts the owner lists in c2c-deploy.json `outboundHosts` are called,
 * over https, through {@link invokeUrl} (timeout, retry, idempotency key).
 * Anything else throws `ZohoConnectionRefused` (`outbound-host`) before any
 * request. Each redirect `Location` passes the same check before it is
 * fetched. A bare `*` (or a wildcard over a top-level domain) in the list is
 * refused (`outbound-config`): hosts are listed explicitly. Names are checked,
 * not resolved addresses. The runtime's messaging guard still runs first.
 */
import { InvokeUrlError, idempotencyKeys, invokeUrl, type InvokeUrlOptions } from './invoke-url.js';
import { parseJsonLossless } from './ids.js';
import { ZohoConnectionRefused, delugeValue, invokeurlRequest, invokeurlResponse, redactUrlText, refuseUrlUserinfo } from './zoho-adapters.js';

export interface OutboundConfig extends Omit<InvokeUrlOptions, 'idempotency' | 'followRedirect'> {
  /** Exact host names, or `*.example.com` for any subdomain. Compared case-insensitively. */
  allowHosts?: readonly string[] | null;
  /** Derives idempotency keys (e.g. the caller's own Idempotency-Key). Without it keys are random per call. */
  idempotencySeed?: string | null;
}

export function hostAllowed(host: string, allowHosts: readonly string[] | null | undefined): boolean {
  const h = host.toLowerCase();
  for (const raw of allowHosts ?? []) {
    const entry = String(raw).trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('*.') ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1 : h === entry) return true;
  }
  return false;
}

/** Why an `outboundHosts` list is unusable, or null. `*` and `*.<tld>` would allow (nearly) every host. */
export function outboundHostsProblem(allowHosts: readonly string[] | null | undefined): string | null {
  for (const raw of allowHosts ?? []) {
    const entry = String(raw).trim().toLowerCase();
    const rest = entry.startsWith('*.') ? entry.slice(2) : entry;
    if (rest.includes('*') || (entry.startsWith('*.') && !rest.includes('.'))) {
      return `c2c-deploy.json outboundHosts entry ${JSON.stringify(String(raw))} is refused: list each host explicitly (api.example.com) or one domain's subdomains (*.example.com); deny by default`;
    }
  }
  return null;
}

/** Refuses (before any request) a URL that is not https on an allowlisted host, or that carries userinfo. */
function checkOutbound(raw: string, allowHosts: readonly string[] | null | undefined, what = 'invokeurl'): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ZohoConnectionRefused('outbound-host', `${what} URL is not absolute: ${redactUrlText(raw)}`);
  }
  if (url.protocol !== 'https:') throw new ZohoConnectionRefused('outbound-host', `${what} to ${url.protocol}//${url.host} is not https`);
  refuseUrlUserinfo(url, what, 'outbound-host');
  if (!hostAllowed(url.hostname, allowHosts)) {
    throw new ZohoConnectionRefused('outbound-host', `${what} host ${url.hostname} is not in c2c-deploy.json outboundHosts`);
  }
}

/** `options.http` for createRuntime: the generated live handler passes this. */
export function outboundHttp(config: OutboundConfig): (request: Record<string, unknown>) => Promise<unknown> {
  const keys = idempotencyKeys(config.idempotencySeed);
  const problem = outboundHostsProblem(config.allowHosts);
  return async (request) => {
    if (problem) throw new ZohoConnectionRefused('outbound-config', problem);
    const rest = invokeurlRequest(request);
    checkOutbound(rest.url, config.allowHosts);
    const { allowHosts: _hosts, idempotencySeed: _seed, ...transport } = config;
    const followRedirect = (next: string) => checkOutbound(next, config.allowHosts, 'invokeurl redirect');
    try {
      const reply = await invokeUrl(rest, { ...transport, idempotency: keys, followRedirect }, parseJsonLossless);
      return delugeValue(invokeurlResponse(reply));
    } catch (err) {
      if (err instanceof InvokeUrlError) throw new ZohoConnectionRefused(err.reason, redactUrlText(err.message));
      throw err;
    }
  };
}

export interface GetUrlRequest {
  url: string;
  headers?: Record<string, unknown>;
  /** `false` returns the { responseText, responseHeader, responseCode } map; anything else returns the body text. */
  simple?: boolean;
}

/**
 * `options.httpGetUrl` for createRuntime: the generated live handler passes
 * this. The legacy `getUrl` task is an HTTP GET through the same transport
 * and the same `outboundHosts` allowlist as {@link outboundHttp}; the body is
 * returned verbatim (Deluge's simple form), not parsed.
 */
export function outboundGetUrl(config: OutboundConfig): (request: GetUrlRequest) => Promise<unknown> {
  const keys = idempotencyKeys(config.idempotencySeed);
  const problem = outboundHostsProblem(config.allowHosts);
  return async (request) => {
    if (problem) throw new ZohoConnectionRefused('outbound-config', problem);
    checkOutbound(request.url, config.allowHosts, 'getUrl');
    const headers: Record<string, string> = {};
    if (request.headers && typeof request.headers === 'object' && !Array.isArray(request.headers)) {
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
    }
    const { allowHosts: _hosts, idempotencySeed: _seed, ...transport } = config;
    const followRedirect = (next: string) => checkOutbound(next, config.allowHosts, 'getUrl redirect');
    try {
      const reply = await invokeUrl({ method: 'GET', url: request.url, headers }, { ...transport, idempotency: keys, followRedirect }, (raw) => raw);
      const text = reply.body === null || reply.body === undefined ? '' : String(reply.body);
      if (request.simple !== false) return text;
      return delugeValue({ responseText: text, responseHeader: reply.headers ?? {}, responseCode: reply.status });
    } catch (err) {
      if (err instanceof InvokeUrlError) throw new ZohoConnectionRefused(err.reason, redactUrlText(err.message));
      throw err;
    }
  };
}

