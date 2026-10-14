/**
 * The one Slate-host rule, shared by `c2c deploy --slate-domain`,
 * `c2c provision --domain`, `provision/inputs.json` "slateDomain" and the
 * generated auth apply script.
 *
 * A Slate host is a bare hostname — optionally pasted as the https URL that
 * `slate:link` prints. It is never a wildcard, never carries userinfo, a port,
 * a path or a query, and never another scheme: the value lands verbatim in a
 * JSON request body and inside a `redirect_url`, so anything looser could
 * splice fields or point an invite at another host. Returns the bare host in
 * lowercase, or undefined when the input is anything else.
 */
export function slateHost(value: string | undefined): string | undefined {
  const raw = (value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return undefined;
  const bare = raw.replace(/^https:\/\//i, '');
  // A remaining scheme is another protocol or a host:port — both refuse.
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return undefined;
  // Userinfo, path, query and fragment markers refuse too.
  if (/[/?#@\\]/.test(bare)) return undefined;
  // Labels, not characters: 1–63 character alphanumeric labels joined by
  // dots, so an empty label, a hyphen-edged label or a trailing dot refuses.
  if (
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(bare)
  ) {
    return undefined;
  }
  // The last label is letters only (or an xn-- punycode TLD) — a bare
  // address, a hex form or a single word is not a Slate host.
  if (!/\.(?:[a-z]+|xn--[a-z0-9-]+)$/i.test(bare)) return undefined;
  // And no label may read as a number to a URL parser — "0x7f", "0177" or any
  // all-digit label — wherever it sits in the host.
  if (bare.split('.').some((label) => /^0x[0-9a-f]*$/i.test(label) || /^[0-9]+$/.test(label))) {
    return undefined;
  }
  return bare.toLowerCase();
}
