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

test('replaceAllIgnoreCase and replaceFirstIgnoreCase reproduce the help-page examples', async () => {
  const { replaceAllIgnoreCase, replaceFirstIgnoreCase } = await import('../src/text.js');
  const input = 'Zoho Creator, Zoho Desk, Zoho CRM';
  assert.equal(replaceAllIgnoreCase(input, 'ZOHO ', 'Z'), 'ZCreator, ZDesk, ZCRM');
  assert.equal(replaceFirstIgnoreCase(input, 'ZOHO ', 'Z'), 'ZCreator, Zoho Desk, Zoho CRM');
});

test('ignore-case replace reads the search text as a regex by default and literally with true', async () => {
  const { replaceAllIgnoreCase, replaceFirstIgnoreCase } = await import('../src/text.js');
  assert.equal(replaceAllIgnoreCase('a.B.c', '.', '-'), '-----');
  assert.equal(replaceAllIgnoreCase('a.B.c', '.', '-', false), '-----');
  assert.equal(replaceAllIgnoreCase('a.B.c', '.', '-', true), 'a-B-c');
  assert.equal(replaceAllIgnoreCase('a.B.c', '.', '-', 'true'), 'a-B-c');
  assert.equal(replaceAllIgnoreCase('A$b$', '$B', 'x', true), 'Ax$');
  assert.equal(replaceAllIgnoreCase('a b,c<', ' B,C<', '!', true), 'a!');
  assert.equal(replaceFirstIgnoreCase('xAxa', 'a', '-'), 'x-xa');
  // Java replacement text: a group keeps the matched case.
  assert.equal(replaceAllIgnoreCase('Hello hello', '(h)ello', '$1i'), 'Hi hi');
  assert.equal(replaceAllIgnoreCase('aBc', '[a-b]', '*'), '**c');
  assert.equal(replaceAllIgnoreCase('a—B', 'b', 'x'), 'a—x');
});

test('ignore-case replace keeps the replaceAll null and empty rules', async () => {
  const { replaceAllIgnoreCase, replaceFirstIgnoreCase } = await import('../src/text.js');
  assert.equal(replaceAllIgnoreCase(null, 'a', 'b'), null);
  assert.equal(replaceAllIgnoreCase('', 'a', 'b'), null);
  assert.equal(replaceAllIgnoreCase('A', 'a', ''), null);
  assert.equal(replaceFirstIgnoreCase(null, 'a', 'b'), null);
  assert.equal(replaceFirstIgnoreCase('aA', 'a', ''), 'A');
});

test('ignore-case replace refuses what US-ASCII and Unicode case folding could answer differently', async () => {
  const { replaceAllIgnoreCase, replaceFirstIgnoreCase } = await import('../src/text.js');
  const { DelugeRuntimeError } = await import('../src/errors.js');
  const refused = (f: () => unknown, what: RegExp) =>
    assert.throws(f, (e: unknown) => e instanceof DelugeRuntimeError && what.test((e as Error).message));
  refused(() => replaceAllIgnoreCase('Straße', 's', 'x'), /ignore case on non-ASCII letters/);
  refused(() => replaceFirstIgnoreCase('Émile', 'e', 'x'), /ignore case on non-ASCII letters/);
  refused(() => replaceAllIgnoreCase('kk', '\\u212A', 'x'), /non-ASCII character with ignore case/);
  refused(() => replaceAllIgnoreCase('ss', '[\\x{17F}]', 'x'), /non-ASCII character with ignore case/);
  refused(() => replaceAllIgnoreCase('abc', '\\p{Lower}', 'x'), /\\p\{\.\.\} with ignore case/);
  refused(() => replaceAllIgnoreCase('abc', '\\p{Lu}', 'x'), /\\p\{\.\.\} with ignore case/);
  refused(() => replaceAllIgnoreCase('ab', '', 'x', true), /empty search text/);
  refused(() => replaceAllIgnoreCase('ab', 'a', '$0', true), /replacement/);
  refused(() => replaceFirstIgnoreCase('ab', 'a', '\\\\', true), /replacement/);
  refused(() => replaceAllIgnoreCase('ab', '(a)\\1', 'x'), /back reference/i);
});

test('case-sensitive replaceAll is unchanged by the ignore-case mode', async () => {
  const { replaceAll } = await import('../src/text.js');
  assert.equal(replaceAll('aBa', 'b', 'x'), 'aBa');
  assert.equal(replaceAll('Straße', 's', 'x'), 'Straße');
});
