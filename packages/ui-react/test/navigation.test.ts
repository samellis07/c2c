import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navigableUrl } from '../template/lib/c2c-ui/runtime/navigable-url.js';

const allowed = [
  ['#/home', true], ['./x', true], ['../x', true], ['?q=1', true],
  ['https://example.com/a%20b', true], ['http://host:8080/p', true],
  ['//host/x', false], ['\\\\host\\x', false], ['https:\\\\host\\x', false],
  ['https://@host/x', false], ['https://%40@host/x', false], ['https://u@host/x', false],
  ['https://:@host/x', false], ['javascript%3Aalert(1)', false], ['%6aavascript:alert(1)', false],
  [' javascript:alert(1)', false], ['java\tscript:alert(1)', false], ['java\nscript:alert(1)', false],
  ['data:text/html,x', false], ['vbscript:msgbox(1)', false], ['blob:https://x/y', false], ['file:///etc/passwd', false],
  ['HTTPS://example.com/x', true], ['http:', false], ['http:///x', false],
] as const;

test('React navigableUrl applies the URL policy corpus', () => {
  for (const [url, expected] of allowed) assert.equal(navigableUrl(undefined, url), expected, url);
  // Expand the same corpus with representative query/path/control variants.
  for (let i = 0; i < 20; i++) {
    assert.equal(navigableUrl(undefined, `#/route/${i}?q=${i}`), true);
    assert.equal(navigableUrl(undefined, `java\t${i}script:alert(1)`), false);
  }
});
