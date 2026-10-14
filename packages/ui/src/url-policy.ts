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

/** True when the browser sanitizer would keep an href or src. */
export function safeUrl(value: unknown): boolean {
  const flat = flatUrl(value);
  if (!flat) return true;
  return !DENIED_HREF_SCHEMES.some((scheme) => flat.startsWith(scheme));
}

/**
 * `c2cUrlOk` in a generated page endpoint. Flattens controls and whitespace
 * across the WHOLE assembled attribute value (static pieces and islands
 * joined), then keeps http(s), mailto, a hash, or a relative URL. Any other
 * scheme empties the attribute. Running the rule per island would let two
 * halves — `javascript` + `:alert(1)` — each pass and compose a script URL.
 */
export function c2cUrlFunctionSource(): string {
  const allowed = PAGE_HREF_SCHEMES.map((scheme) => `flat.startsWith(${JSON.stringify(scheme)})`).join(' || ');
  return `function c2cUrlOk(url) {
  const flat = String(url || "").replace(/${URL_FLAT_CLASS}+/g, "").toLowerCase();
  if (!flat || flat.startsWith("#") || flat.startsWith("/") || !/^[a-z][a-z0-9+.-]*:/.test(flat) || ${allowed}) return true;
  return false;
}`;
}
