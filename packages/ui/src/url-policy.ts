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
