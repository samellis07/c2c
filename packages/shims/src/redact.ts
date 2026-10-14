/**
 * Secret masking for URLs, headers, parameters and thrown messages. Kept in
 * its own module so invoke-url.ts can scrub a thrown fetch message without
 * importing zoho-adapters.ts (which already imports invoke-url.ts).
 */

/** Header, parameter and query names whose values are never recorded or echoed. */
export const SECRET_NAME = /auth|token|secret|key|cookie|pass/i;
export const REDACTED = '[redacted]';

/**
 * A URL for a message or transcript: userinfo and the values of secret-named
 * query parameters masked, and the fragment dropped. Text that does not parse
 * loses everything before its last `@` (after any `scheme://`) and its whole
 * query/fragment.
 */
export function redactUrlText(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = REDACTED;
      url.password = '';
    }
    for (const name of [...url.searchParams.keys()]) if (SECRET_NAME.test(name)) url.searchParams.set(name, REDACTED);
    url.hash = '';
    return url.href;
  } catch {
    let out = String(raw);
    const q = out.search(/[?#]/);
    if (q >= 0) out = `${out.slice(0, q)}${out[q] === '?' ? `?${REDACTED}` : ''}`;
    const start = /^[a-z][a-z0-9+.-]*:\/\//i.exec(out)?.[0].length ?? 0;
    const at = out.lastIndexOf('@');
    return at >= start ? `${out.slice(0, start)}${REDACTED}@${out.slice(at + 1)}` : out;
  }
}
