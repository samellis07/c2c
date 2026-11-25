import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractLiteralHttpsHosts, isSameAppNavTarget, navigationAllowed, navigationPolicyFunctionSource } from '../src/url-policy.js';

// navigationAllowed (and the generated c2cNavOk it mirrors) is the gate a
// server action's navigate instruction must pass before a generated page
// acts on it. Every class the protocol names as refused gets its own
// attack vector here: a denied scheme, a protocol-relative open redirect,
// plain http, and an https host that is not on the per-app allowlist —
// including a value an attacker chose specifically to look allowed.

const ALLOWED = new Set(['allowed.example', 'docs.allowed.example']);

/** [label, url, expected navigationAllowed(url, ALLOWED) result]. */
const NAV_VECTORS: Array<[string, string, boolean]> = [
  // ALLOW: same-app hash routes and relative paths.
  ['same-app hash route', '#/report/Orders', true],
  ['same-app hash route with query', '#/form/Orders/edit/123?Field=1', true],
  ['bare hash fragment', '#frag', true],
  ['relative path', '/report/Orders', true],
  ['relative path with traversal (ordinary same-origin navigation)', '/a/../b', true],
  // ALLOW: https on the per-app allowlist.
  ['allowlisted https host', 'https://allowed.example/doc', true],
  ['allowlisted https host, case-insensitive scheme', 'HTTPS://allowed.example/doc', true],
  ['allowlisted https host, upper-case host folds to lower', 'https://ALLOWED.EXAMPLE/doc', true],
  ['allowlisted https host with dynamic query appended', 'https://allowed.example/doc?id=123', true],
  // DENY: javascript:/data:/vbscript:/file:, literal.
  ['literal javascript: scheme', 'javascript:alert(1)', false],
  ['literal data: scheme', 'data:text/html,<script>alert(1)</script>', false],
  ['literal vbscript: scheme', 'vbscript:msgbox(1)', false],
  ['literal file: scheme', 'file:///etc/passwd', false],
  // DENY: javascript:/data:/vbscript:, revealed only after flattening control/whitespace characters.
  ['javascript: scheme hidden by an embedded tab', 'java\tscript:alert(1)', false],
  ['javascript: scheme hidden by an embedded newline', 'java\nscript:alert(1)', false],
  ['javascript: scheme hidden by leading whitespace', ' javascript:alert(1)', false],
  ['javascript: scheme in mixed case', 'JaVaScRiPt:alert(1)', false],
  // DENY: protocol-relative open redirect, never treated as a relative path.
  ['protocol-relative open redirect', '//evil.example/x', false],
  ['protocol-relative open redirect to an allowlisted-looking host', '//allowed.example/x', false],
  // DENY: plain http, even to an allowlisted host — only https is trusted.
  ['plain http to an allowlisted host', 'http://allowed.example/doc', false],
  // DENY: an https host not on the allowlist — including a value read from
  // user input with no allowlist match, and values crafted to look allowed.
  ['https host not on the allowlist (arbitrary user-controlled host)', 'https://evil.example/x', false],
  ['https host that merely contains an allowed host as a substring', 'https://notallowed.example.evil.example/x', false],
  ['https host that is a subdomain of an allowed host, not the host itself', 'https://allowed.example.evil.example/x', false],
  ['https userinfo trick: attacker host after an allowed-looking userinfo', 'https://allowed.example.com@evil.example.com/x', false],
  ['https userinfo trick with a colon', 'https://allowed.example:443@evil.example/x', false],
  ['https credentials on an ALLOWED host still reach the browser', 'https://attacker:password@allowed.example/', false],
  ['https empty-password credentials on an allowed host', 'https://attacker:@allowed.example/x', false],
  ['https allowed host as its own userinfo', 'https://allowed.example@allowed.example/x', false],
  ['https with no host at all', 'https:///x', false],
  ['single-slash https (malformed scheme, not a real https URL)', 'https:/evil.example/x', false],
  ['backslash scheme confusion', 'https:\\\\evil.example/x', false],
  // DENY: a relative-looking path that is actually a backslash-based scheme trick.
  ['relative path carrying an embedded backslash', '/\\evil.example', false],
  ['relative path carrying a control character', '/\u0000evil', false],
  // DENY: empty or garbage input never navigates anywhere.
  ['empty string', '', false],
  ['bare scheme-looking garbage', 'not-a-url', false],
  ['ftp scheme, not on the allow-list at all', 'ftp://allowed.example/x', false],
];

test('navigationAllowed allows only same-app routes and allowlisted https hosts, and refuses every attack class', () => {
  for (const [label, url, expected] of NAV_VECTORS) {
    assert.equal(navigationAllowed(url, ALLOWED), expected, `${label}: navigationAllowed(${JSON.stringify(url)})`);
  }
});

test('the generated c2cNavOk mirrors navigationAllowed exactly, including every attack vector', () => {
  const source = navigationPolicyFunctionSource();
  const c2cNavOk = new Function(`return (${source.replace('function c2cNavOk', 'function')});`)() as (url: string, allowedHosts: string[]) => boolean;
  const allowedArray = [...ALLOWED];
  for (const [label, url, expected] of NAV_VECTORS) {
    assert.equal(c2cNavOk(url, allowedArray), expected, `${label}: c2cNavOk(${JSON.stringify(url)})`);
  }
});

test('isSameAppNavTarget accepts a hash route or a single-leading-slash path, and refuses a protocol-relative one', () => {
  assert.equal(isSameAppNavTarget('#/report/Orders'), true);
  assert.equal(isSameAppNavTarget('/report/Orders'), true);
  assert.equal(isSameAppNavTarget('//evil.example/x'), false);
  assert.equal(isSameAppNavTarget('https://example.com/x'), false);
  assert.equal(isSameAppNavTarget(''), false);
});

test('extractLiteralHttpsHosts collects only a literal https host immediately inside openUrl(...), never a dynamically built one', () => {
  const sources = [
    'void a() { openUrl("https://docs.allowed.example/help", "new window"); }',
    'void b() { openUrl("https://allowed.example/path?x=" + input.ID, "same window"); }',
    // A dynamic prefix (string concatenation building the scheme/host itself)
    // contributes no host: the scan only trusts a literal right after `openUrl(`.
    'void c() { url = "https://" + input.Host; openUrl(url, "same window"); }',
    'void d() { openUrl(zoho.appuri + "https://ignored.example", "same window"); }',
    // Case and userinfo are normalized the same way the runtime check reads them.
    'void e() { openUrl("https://User:Pass@Upper.Allowed.Example/x", "same window"); }',
  ];
  const hosts = extractLiteralHttpsHosts(sources);
  assert.deepEqual(hosts, ['allowed.example', 'docs.allowed.example', 'upper.allowed.example']);
});
