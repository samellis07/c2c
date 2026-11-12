import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeUrl, c2cUrlFunctionSource } from '../src/url-policy.js';

// safeUrl and the generated c2cUrlOk must refuse a denied scheme
// (javascript:/data:/vbscript:) whether it is written literally or revealed
// only after one or more rounds of percent-decoding. A vector that an older
// revision allowed (checked once, against the raw value) and the current
// revision refuses (checked on every decode pass) is the regression this
// file exists to pin down.

/** [label, value, relativeOnly, expected safeUrl() result]. */
const SAFE_URL_VECTORS: Array<[string, string, boolean, boolean]> = [
  ['plain relative path', 'a.png', true, true],
  ['relative path with query', 'a.png?x=1', true, true],
  ['literal javascript: scheme', 'javascript:alert(1)', true, false],
  ['literal javascript: scheme, non-relativeOnly', 'javascript:alert(1)', false, false],
  ['single-encoded javascript: scheme', 'javascript%3Aalert(1)', true, false],
  ['single-encoded javascript: scheme, non-relativeOnly', 'javascript%3Aalert(1)', false, false],
  ['double-encoded javascript: scheme', 'javascript%253Aalert(1)', true, false],
  ['triple-encoded javascript: scheme (depth 3, right at the cap boundary)', 'javascript%25253Aalert(1)', true, false],
  ['quadruple-encoded javascript: scheme (depth 4, the off-by-one this test pins)', 'javascript%2525253Aalert(1)', true, false],
  ['quadruple-encoded javascript: scheme, non-relativeOnly', 'javascript%2525253Aalert(1)', false, false],
  ['quadruple-encoded data: scheme', 'data%2525253Atext/html,x', true, false],
  ['quadruple-encoded protocol-relative authority', '%2525252F%2525252Fevil.example/x', true, false],
  ['quadruple-encoded parent-traversal separator', '..%2525252Fsecret.png', true, false],
  ['lower-case hex digits in the escape (escapes are case-insensitive)', 'javascript%3aalert(1)', true, false],
  ['encoded data: scheme with svg payload', 'data%3Aimage/svg+xml,%3Csvg%3E', true, false],
  ['encoded vbscript: scheme', 'vbscript%3Amsgbox(1)', true, false],
  ['literal protocol-relative authority', '//evil.example/x', true, false],
  ['encoded protocol-relative authority', '%2f%2fevil.example/x', true, false],
  ['literal parent-traversal separator is normal relative navigation and stays allowed (only an ENCODED separator is refused)', '../secret.png', true, true],
  ['single-encoded parent-traversal separator', '..%2fsecret.png', true, false],
  ['double-encoded parent-traversal separator', '..%252fsecret.png', true, false],
  ['leading whitespace', ' a.png', true, false],
  ['embedded backslash', 'a\\b.png', true, false],
  ['mixed-case scheme letters', 'JaVaScRiPt:alert(1)', true, false],
  ['allowed http(s) scheme ignores relativeOnly refusal', 'https://example.com/x', false, true],
  // decodeURIComponent throws on the WHOLE string for any one malformed
  // escape anywhere in it; a loop that `catch { break }`s on that throw
  // stops validating before ever seeing what a well-formed %HH sitting
  // right next to the malformed one decodes to. The fix must see through
  // the malformed escape WITHOUT becoming so strict that ordinary text
  // containing a literal '%' (50%.png) gets refused.
  ['trailing bare % after a well-formed escape', 'javascript%3Aalert(1)%', true, false],
  ['invalid hex digits (%GG) after a well-formed escape', 'javascript%3Aalert(1)%GG', true, false],
  ['truncated escape (%2) after a well-formed escape', 'javascript%3Aalert(1)%2', true, false],
  ['a malformed % immediately before a well-formed %33 (javascript%%33A...)', 'javascript%%33Aalert(1)', true, false],
  ['encoded data: with a trailing bare %', 'data%3Atext/html,x%', true, false],
  ['encoded vbscript: with a trailing bare %', 'vbscript%3Amsgbox(1)%', true, false],
  ['relativeOnly traversal with a trailing bare %', '..%2fsecret.png%', true, false],
  ['relativeOnly protocol-relative authority with a trailing bare %', '%2f%2fevil.example/x%', true, false],
  ['depth-4 scheme payload with a poison trailing % on top', 'javascript%2525253Aalert(1)%', true, false],
  ['a literal percent sign in ordinary text stays allowed (50%.png)', '50%.png', true, true],
  ['a literal percent sign in ordinary text stays allowed (100%organic.png)', '100%organic.png', true, true],
];

test('safeUrl refuses a denied scheme on every percent-decode pass, not just the raw value', () => {
  for (const [label, value, relativeOnly, expected] of SAFE_URL_VECTORS) {
    assert.equal(safeUrl(value, relativeOnly), expected, `${label}: safeUrl(${JSON.stringify(value)}, ${relativeOnly})`);
  }
});

/** [label, value, expected c2cUrlOk() result]. */
const C2C_URL_OK_VECTORS: Array<[string, string, boolean]> = [
  ['http allowed', 'http://example.com/x', true],
  ['https allowed', 'https://example.com/x', true],
  ['mailto allowed', 'mailto:a@b.com', true],
  ['relative allowed', 'a.png', true],
  ['hash allowed', '#frag', true],
  ['literal javascript: refused', 'javascript:alert(1)', false],
  ['single-encoded javascript: refused', 'javascript%3Aalert(1)', false],
  ['double-encoded javascript: refused', 'javascript%253Aalert(1)', false],
  ['quadruple-encoded javascript: refused (the off-by-one this test pins)', 'javascript%2525253Aalert(1)', false],
  ['encoded data: refused', 'data%3Atext/html,x', false],
  ['scheme not on the allow-list refused', 'ftp://evil.example/x', false],
  ['a malformed % immediately before a well-formed %33 (javascript%%33A...)', 'javascript%%33Aalert(1)', false],
  ['trailing bare % after a well-formed escape', 'javascript%3Aalert(1)%', false],
  ['a literal percent sign in ordinary text stays allowed (50%.png)', '50%.png', true],
];

test('the generated c2cUrlOk refuses a denied scheme revealed only after decoding', () => {
  const source = c2cUrlFunctionSource();
  const c2cUrlOk = new Function(`return (${source.replace('function c2cUrlOk', 'function')});`)() as (url: string) => boolean;
  for (const [label, value, expected] of C2C_URL_OK_VECTORS) {
    assert.equal(c2cUrlOk(value), expected, `${label}: c2cUrlOk(${JSON.stringify(value)})`);
  }
});

// Both functions cap percent-decoding at 4 passes (5 states: the raw value,
// then each of the 4 decoded results). That cap is deliberate, not the bug
// this file pins -- the bug was that the LAST state inside the cap (depth 4)
// went unchecked. This test documents, rather than hides, the cap's actual
// edge: depth 4 (4 decodes) must be refused; a payload needing a 5th decode
// to reveal its scheme is outside the cap and is a known, accepted limit.
test('percent-decoding is capped at 4 passes: depth 4 is refused, depth 5 is a documented cap limit, not a regression', () => {
  const depth4 = 'javascript%2525253Aalert(1)'; // needs exactly 4 decodeURIComponent calls to become 'javascript:alert(1)'
  const depth5 = 'javascript%252525253Aalert(1)'; // needs exactly 5 decodeURIComponent calls

  let probe = depth4;
  for (let i = 0; i < 4; i++) probe = decodeURIComponent(probe);
  assert.equal(probe, 'javascript:alert(1)', 'depth4 fixture must resolve to the dangerous scheme in exactly 4 decodes');

  probe = depth5;
  for (let i = 0; i < 5; i++) probe = decodeURIComponent(probe);
  assert.equal(probe, 'javascript:alert(1)', 'depth5 fixture must resolve to the dangerous scheme in exactly 5 decodes');

  assert.equal(safeUrl(depth4, true), false, 'depth4 (within the 4-pass cap) must be refused');
  assert.equal(safeUrl(depth5, true), true, 'depth5 (one decode beyond the 4-pass cap) is a known cap limit, not asserted safe by this fix');
});
