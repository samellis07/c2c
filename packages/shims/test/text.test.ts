import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexToText, htmlDecode, htmlEncode } from '../src/text.js';

test('hexToText malformed hex returns null', () => {
  assert.equal(hexToText('48656c6c6'), null);
  assert.equal(hexToText('48zz'), null);
  assert.equal(hexToText('zz'), null);
  assert.equal(hexToText('4g'), null);
  assert.equal(hexToText('0x41'), null);
});

test('hexToText decodes valid hex identical to Buffer', () => {
  assert.equal(hexToText('48656c6c6f'), 'Hello');
});

test('htmlDecode decodes exactly once and handles emojis', () => {
  assert.equal(htmlDecode('&amp;#60;'), '&#60;');
  assert.equal(htmlDecode('&amp;lt;'), '&lt;');
  assert.equal(htmlDecode('&#128512;'), '😀');
  assert.equal(htmlDecode('&#x1F600;'), '😀');
  assert.equal(htmlDecode('&#x263a;'), '☺');
});

test('htmlDecode refuses NUL, surrogates, and values above 10FFFF', () => {
  assert.equal(htmlDecode('&#0;'), '&#0;');
  assert.equal(htmlDecode('&#xD800;'), '&#xD800;');
  assert.equal(htmlDecode('&#55296;'), '&#55296;');
  assert.equal(htmlDecode('&#x110000;'), '&#x110000;');
});

test('htmlEncode encodes & < > " and leaves the apostrophe literal', () => {
  assert.equal(htmlEncode('a<b>&"c'), 'a&lt;b&gt;&amp;&quot;c');
  assert.equal(htmlEncode("order's"), "order's");
  assert.equal(htmlEncode('&amp;'), '&amp;amp;');
  assert.equal(htmlDecode(htmlEncode('&amp;')), '&amp;');
  assert.equal(htmlDecode(htmlEncode('a<b>&"c')), 'a<b>&"c');
  assert.equal(htmlEncode(null), null);
  assert.equal(htmlEncode(''), null);
  assert.equal(htmlEncode(0), '0');
});
