/**
 * URL scheme rules shared by the page sanitizer and generated page endpoints.
 * The browser runtime keeps the same character class and the same refused
 * schemes (`client-runtime.js`).
 */

/** ASCII controls and whitespace, removed before a scheme test. */
export const URL_FLAT_CLASS = '[\\u0000-\\u0020]';

/** Schemes a rendered page href may keep. A hash or a relative URL has none. */
export const PAGE_HREF_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

/** Schemes refused after flattening. The browser runtime refuses this same list. */
export const DENIED_HREF_SCHEMES = ['javascript:', 'data:', 'vbscript:'] as const;

export function flatUrl(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
}

/**
 * True when the browser sanitizer would keep an href or src. `relativeOnly`
 * additionally refuses schemes, authorities, non-canonical whitespace and an
 * encoded traversal separator; page-sheet url() values use that stricter form.
 */
function urlPolicyRejects(decoded: string, relativeOnly: boolean): boolean {
  const flatPass = flatUrl(decoded);
  if (DENIED_HREF_SCHEMES.some((scheme) => flatPass.startsWith(scheme))) return true;
  if (!relativeOnly) return false;
  return /[\u0000-\u0020\\]/.test(decoded) || flatPass.startsWith('//') || /^[a-z][a-z0-9+.-]*:/.test(flatPass);
}

/**
 * The `../` parent-traversal check applies only to a value produced BY a
 * decode, never to the literal raw text: an ordinary relative URL written
 * with `../` (`../icons/dot.png`) is normal, safe browser navigation within
 * the same origin and must stay allowed, while a `..` separator that only
 * appears after percent-decoding (`..%2f`) is the evasion this exists to
 * catch. Splitting this out of urlPolicyRejects keeps that distinction
 * instead of refusing every literal `../` along with every encoded one.
 */
function urlPolicyRejectsDecodedTraversal(decoded: string): boolean {
  return /(?:^|\/)\.\.(?:\/|$)/.test(decoded);
}

/**
 * A percent-decode that never throws. `decodeURIComponent` throws on ANY
 * malformed escape in the whole string (a lone `%`, `%GG`, a truncated
 * `%H`), which would otherwise stop a caller from seeing what a well-formed
 * `%HH` token NEXT TO a malformed one decodes to -- `javascript%%33Aalert(1)`
 * has a bad `%` immediately before a perfectly well-formed `%33`, and the
 * real decode throws on the whole string. When the real decode succeeds,
 * its result (including correct UTF-8 handling) is used unchanged; only on
 * failure does this fall back to decoding every well-formed `%HH` token
 * byte-by-byte and leaving every other `%` (and ordinary text like `50%` in
 * `50%.png`) exactly as written, matching how a URL parser treats a
 * malformed escape rather than refusing or throwing on it.
 */
function percentDecodeLenient(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
}

export function safeUrl(value: unknown, relativeOnly = false): boolean {
  const raw = String(value ?? '');
  const flat = flatUrl(raw);
  if (!flat) return !relativeOnly;
  if (relativeOnly && raw !== raw.trim()) return false;
  // Checked AFTER every decode as well as before the first one: up to 4
  // decode passes means 5 states to validate (the raw value, then each of
  // the 4 decoded results) -- checking only the pre-decode state each pass
  // left the result of the pass's own decode, including the final one,
  // unvalidated, so a scheme/traversal/authority revealed only by the Nth
  // decode (not sooner) sailed through uncaught. The decode itself never
  // throws (percentDecodeLenient), so a malformed escape next to a
  // dangerous well-formed one can't short-circuit the loop before that
  // state is checked either.
  let decoded = raw;
  if (urlPolicyRejects(decoded, relativeOnly)) return false;
  for (let pass = 0; pass < 4; pass++) {
    const next = percentDecodeLenient(decoded);
    if (next === decoded) break;
    decoded = next;
    if (urlPolicyRejects(decoded, relativeOnly) || (relativeOnly && urlPolicyRejectsDecodedTraversal(decoded))) return false;
  }
  return true;
}

/**
 * `c2cUrlOk` in a generated page endpoint. Flattens controls and whitespace
 * across the WHOLE assembled attribute value (static pieces and islands
 * joined), then keeps http(s), mailto, a hash, or a relative URL. Any other
 * scheme empties the attribute. Running the rule per island would let two
 * halves — `javascript` + `:alert(1)` — each pass and compose a script URL.
 *
 * Checked on every percent-decode pass, not just the raw value: a scheme that
 * only appears after decoding (`javascript%3Aalert(1)`) must not be treated
 * as a scheme-less relative URL just because it has no literal `:` yet.
 */
/**
 * A navigation instruction a dispatched report custom action's server
 * function returns instead of performing the browser navigation itself
 * (see docs/report-action-navigation.md). `target` mirrors Deluge's openUrl
 * window argument: "same" keeps the current tab, "new" opens a tab with
 * `noopener,noreferrer`.
 */
export interface NavInstruction {
  kind: 'navigate';
  url: string;
  target?: 'same' | 'new';
}

/**
 * This app's own hash route (`#...`) or a single-leading-slash relative path
 * (`/report/...`, never `//host/...`, which is a protocol-relative open
 * redirect wearing a relative path's clothes): always allowed, regardless of
 * any per-app host allowlist, because it can never leave the generated app's
 * own origin.
 */
export function isSameAppNavTarget(url: string): boolean {
  const raw = String(url ?? '');
  if (raw.startsWith('#')) return true;
  return raw.startsWith('/') && !raw.startsWith('//');
}

/**
 * The lowercase hostname of a well-formed `https://host/...` prefix, or
 * undefined for anything else (no scheme, a different scheme, or a scheme
 * written with the wrong number of slashes). Userinfo (`user:pass@host`) is
 * part of the authority, not the host: this takes the text AFTER the last
 * `@`, so `https://allowed.example@evil.example` is judged on
 * `evil.example`, never on the attacker-chosen prefix before it.
 */
function httpsHost(url: string): string | undefined {
  const m = /^https:\/\/([^/?#\\]+)/i.exec(String(url ?? ''));
  if (!m) return undefined;
  const authority = m[1]!;
  const at = authority.lastIndexOf('@');
  const hostPart = at >= 0 ? authority.slice(at + 1) : authority;
  const host = hostPart.split(':')[0]!.toLowerCase();
  return host || undefined;
}

/**
 * The policy a generated page runs before acting on a server action's
 * navigate instruction (the browser runtime keeps the same rule — see
 * client-runtime.js and the ui-react runtime navigation module, both named
 * in docs/report-action-navigation.md): a same-app hash route or relative
 * path is always allowed; an `https:` URL is allowed only when its host is
 * on this app's own allowlist (built at generate time from literal URLs
 * found in the source .ds — see `extractLiteralHttpsHosts` — never from a
 * value only known at runtime); everything else — a denied scheme
 * (`javascript:`, `data:`, `vbscript:`, `file:`), a protocol-relative
 * `//host/...` open redirect, plain `http:`, or an https host not on the
 * allowlist — is refused.
 */
export function navigationAllowed(url: string, allowedHosts: ReadonlySet<string>): boolean {
  const raw = String(url ?? '');
  const flat = flatUrl(raw);
  if (DENIED_HREF_SCHEMES.some((scheme) => flat.startsWith(scheme)) || flat.startsWith('file:') || flat.startsWith('//')) return false;
  if (isSameAppNavTarget(raw)) return !/[\u0000- \\]/.test(raw);
  const host = httpsHost(raw);
  return !!host && allowedHosts.has(host);
}

/**
 * Literal `https://host...` prefixes immediately inside an `openUrl(` call
 * in Deluge source — the only hosts a generated app's server-returned
 * navigation may ever target. A dynamically-built URL (a local variable, a
 * concatenation, a field read — anything that is not a plain quoted string
 * literal right after `openUrl(`) contributes no host here: a value this
 * scan cannot see statically cannot be trusted as a navigation target at
 * runtime either, so that case stays a manual step instead (see
 * docs/report-action-navigation.md).
 */
export function extractLiteralHttpsHosts(sources: readonly string[]): string[] {
  const hosts = new Set<string>();
  const re = /openUrl\(\s*["']https:\/\/([^/"'?#\\\s]+)/gi;
  for (const source of sources) {
    for (const m of source.matchAll(re)) {
      const authority = m[1]!;
      const at = authority.lastIndexOf('@');
      const host = (at >= 0 ? authority.slice(at + 1) : authority).split(':')[0]!.toLowerCase();
      if (host) hosts.add(host);
    }
  }
  return [...hosts].sort();
}

/**
 * `c2cNavOk` in the generated page client: the browser-side mirror of
 * `navigationAllowed`, run on every server-returned navigate instruction
 * before it is acted on (see the ui-react runtime navigation module, which
 * keeps this same rule hand-written in TypeScript instead of generated from
 * this source, the same split `c2cUrlFunctionSource` already uses).
 */
export function navigationPolicyFunctionSource(): string {
  const denied = DENIED_HREF_SCHEMES.map((scheme) => `flat.startsWith(${JSON.stringify(scheme)})`).join(' || ');
  return `function c2cNavOk(url, allowedHosts) {
  var raw = String(url || "");
  var flat = raw.replace(/${URL_FLAT_CLASS}+/g, "").toLowerCase();
  if (${denied} || flat.startsWith("file:") || flat.startsWith("//")) return false;
  if (raw.startsWith("#") || (raw.startsWith("/") && !raw.startsWith("//"))) return !/[\\u0000-\\u0020\\\\]/.test(raw);
  var m = /^https:\\/\\/([^/?#\\\\]+)/i.exec(raw);
  if (!m) return false;
  var authority = m[1];
  var at = authority.lastIndexOf("@");
  var hostPart = at >= 0 ? authority.slice(at + 1) : authority;
  var host = hostPart.split(":")[0].toLowerCase();
  return !!host && allowedHosts.indexOf(host) >= 0;
}`;
}

export function c2cUrlFunctionSource(): string {
  const allowed = PAGE_HREF_SCHEMES.map((scheme) => `flat.startsWith(${JSON.stringify(scheme)})`).join(' || ');
  return `function c2cUrlOk(url) {
  function rejected(decoded) {
    var flat = decoded.replace(/${URL_FLAT_CLASS}+/g, "").toLowerCase();
    return !!(flat && !flat.startsWith("#") && !flat.startsWith("/") && /^[a-z][a-z0-9+.-]*:/.test(flat) && !(${allowed}));
  }
  function decodeLenient(value) {
    try { return decodeURIComponent(value); } catch (e) {
      return value.replace(/%([0-9a-fA-F]{2})/g, function (m, hex) { return String.fromCharCode(parseInt(hex, 16)); });
    }
  }
  var decoded = String(url || "");
  if (rejected(decoded)) return false;
  for (var pass = 0; pass < 4; pass++) {
    var next = decodeLenient(decoded);
    if (next === decoded) break;
    decoded = next;
    if (rejected(decoded)) return false;
  }
  return true;
}`;
}
