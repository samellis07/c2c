import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { dangerousStyle, safeUrl, sanitizeSnippet } from '../template/lib/c2c-ui/pages/sanitize.js';

test('template sanitizer URL policy keeps navigation URLs and rejects dangerous variants', () => {
  const kept = ['http://example.test', 'https://example.test/a', 'mailto:a@example.test', 'tel:+12025550123', '#route', '../x', '?q=1', '/path'];
  const rejected = ['file:///tmp/x', 'ftp://example.test', '//host/x', 'javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'blob:https://x', 'http:\u0000//x', 'http:\\x', 'java%73cript:alert(1)', 'JAVASCRIPT:alert(1)'];
  for (const value of kept) assert.equal(safeUrl(value), true, value);
  for (const value of rejected) assert.equal(safeUrl(value), false, value);
  const dom = new JSDOM('');
  assert.equal(sanitizeSnippet('<a href="&#106;avascript:alert(1)">x</a>', dom.window.document), '<a>x</a>');
});

test('template sanitizer CSS policy keeps plain properties and rejects executable syntax', () => {
  for (const value of ['color:red', 'margin: 0', 'background-color: white', 'font-size: 1rem']) assert.equal(dangerousStyle(value), false, value);
  for (const value of ['\\75 rl(x)', 'u\\72 l(x)', '\\000075rl(x)', '/*x*/color:red', 'image-set(url(x) 1x)', '@import url(x)', 'expression(alert(1))', '-moz-binding:url(x)', 'attr(x)']) assert.equal(dangerousStyle(value), true, value);
});
