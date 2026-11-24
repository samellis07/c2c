import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { dangerousStyle, safeUrl, sanitizeSnippet } from '../template/lib/c2c-ui/pages/sanitize.js';

test('template sanitizer URL policy keeps navigation URLs and rejects dangerous variants', () => {
  // Non-ASCII hostnames are accepted: browsers normalize them to IDN/punycode,
  // and HTTPS remains an allowed navigation scheme under this policy.
  const kept = ['http://example.test', 'https://example.test/a', 'https://例え.テスト', 'https://ex.com/a%20b', 'mailto:a@example.test', 'mailto:x@y.z?subject=hi%20there', 'https://ex.com/?q=a%26b', '/p%2Fq', '#a%20b', 'tel:+15550123', '#route', '../x', '?q=1', '/path'];
  const rejected = ['file:///tmp/x', 'ftp://example.test', '//host/x', 'javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'blob:https://x', 'http:\u0000//x', 'http:\\x', 'java%73cript:alert(1)', '%0ajavascript:alert(1)', 'java%09script:alert(1)', '%2F%2Fhost', '%5C%5Chost', '%00https://host', 'java%2573cript:alert(1)', 'JAVASCRIPT:alert(1)'];
  for (const value of kept) assert.equal(safeUrl(value), true, value);
  for (const value of rejected) assert.equal(safeUrl(value), false, value);
  const dom = new JSDOM('');
  assert.equal(sanitizeSnippet('<a href="&#106;avascript:alert(1)">x</a>', dom.window.document as unknown as Document), '<a>x</a>');
});

test('template sanitizer CSS policy keeps plain properties and rejects executable syntax', () => {
  for (const value of ['color:red', 'margin: 0', 'background-color: white', 'font-size: 1rem']) assert.equal(dangerousStyle(value), false, value);
  for (const value of ['\\75 rl(x)', 'u\\72 l(x)', '\\000075rl(x)', '/*x*/color:red', 'image-set(url(x) 1x)', '@import url(x)', 'expression(alert(1))', '-moz-binding:url(x)', 'attr(x)']) assert.equal(dangerousStyle(value), true, value);
});
