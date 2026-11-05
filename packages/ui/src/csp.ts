/**
 * Content-Security-Policy for a generated Slate shell.
 *
 * Slate (`*.onslate.<dc>`) and Advanced I/O functions (`*.catalystserverless.<dc>`)
 * are different origins. connect-src is `'self'` plus the exact function origin
 * when the API base is an absolute function URL. The host pattern is the
 * Advanced I/O function host fact (plugin/references/facts/functions.md): one
 * Catalyst-assigned label, optional `.development`, then `catalystserverless.<dc>`.
 * A wildcard, a foreign host, or a relative `/server/...` base adds nothing.
 */

/** Byte-stable policy when no function origin is known. Trailing semicolon included. */
export const SHELL_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' https://static.zohocdn.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';";

/** Public suffixes of `catalystserverless` hosts. `com.au` is one suffix, matched before `com`. */
const FUNCTION_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.development)?\.catalystserverless\.(?:com\.au|com|eu|in|jp|ca|sa|ae)$/i;

const CSP_META = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/;

/** Policy string for the shell. `origin` is a `https://host` function origin with no path. */
export function shellContentSecurityPolicy(origin?: string): string {
  if (!origin) return SHELL_CONTENT_SECURITY_POLICY;
  return SHELL_CONTENT_SECURITY_POLICY.replace("connect-src 'self'", `connect-src 'self' ${origin}`);
}

/**
 * Origin of an absolute Advanced I/O base, or undefined when the base is
 * relative, not https, or not a function host. The origin is the host the
 * client calls (`URL.origin`), never `https://*.catalystserverless.*`.
 */
export function functionOriginFromApiBase(apiBase: string | undefined): string | undefined {
  if (!apiBase) return undefined;
  const trimmed = apiBase.trim();
  if (!trimmed || trimmed.startsWith('/')) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (url.port) return undefined;
  if (url.pathname !== '/server' && !url.pathname.startsWith('/server/')) return undefined;
  if (!FUNCTION_HOST.test(url.hostname)) return undefined;
  return url.origin;
}

/**
 * Replace the shell CSP content attribute so connect-src names the function
 * origin. A document with no CSP meta, or a base that is not a function URL,
 * is returned unchanged.
 */
export function applyFunctionConnectSrc(html: string, apiBase?: string): string {
  const origin = functionOriginFromApiBase(apiBase);
  if (!origin) return html;
  return html.replace(CSP_META, `$1${shellContentSecurityPolicy(origin)}$2`);
}
