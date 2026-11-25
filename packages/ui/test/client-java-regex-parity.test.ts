import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { javaReplaceAll as serverReplaceAll } from '../../shims/src/java-regex.js';
import { replaceAll as serverShimReplaceAll } from '../../shims/src/text.js';

// The browser copy of the Java regex compiler (src/client/java-regex.js) is a
// port of packages/shims/src/java-regex.ts. This corpus runs both copies and
// requires the same output or the same error, so the copies cannot drift apart.
const clientSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../packages/ui/src/client/java-regex.js'), 'utf8');
const clientReplaceAll = new Function(`${clientSource}\nreturn javaReplaceAll;`)() as (
  text: string,
  pattern: string,
  replacement: string,
  first?: boolean,
  ignoreCase?: boolean,
) => string;

type Case = [text: string, pattern: string, replacement: string, first?: boolean, ignoreCase?: boolean];

const CASES: Case[] = [
  // The call shapes the gallery apps use.
  ['a b c', ' ', ''],
  ['a b c', ' ', '0'],
  ['a b', ' ', '1,'],
  ['x,y,z', ',', '<br>'],
  ['1234567', '(?<!\\.\\d)(?<=\\d)(?=(?:\\d\\d\\d)+\\b)', ','],
  ['12345.678', '(?<!\\.\\d)(?<=\\d)(?=(?:\\d\\d\\d)+\\b)', ','],
  ['<img src="a"><img src="b">', '<img ', "<img style='width:100%;'"],
  ['<img src="a">', '<img src', "<img style='width:200px;height:150px;' src"],
  ['2012-12', '12', '00'],
  ['null and null', 'null', ''],
  // Dialect and replacement syntax.
  ['abc', '(b)', '[$1]'],
  ['abc', '(?<x>b)', '[${x}]'],
  ['a.b.c', '\\.', '-'],
  ['a.b.c', '\\Q.\\E', '-'],
  ['a1b22c333', '\\d+', '#'],
  ['a1b22c333', '\\d{2,}', '#'],
  ['Hello World', '\\bW', 'w'],
  ['Hello', 'l', '\\$'],
  ['Hello', 'l', '$0$0'],
  ['abc', 'B', 'x', false, true],
  ['abcabc', 'b', 'x', true],
  ['line1\nline2', '$', '!'],
  ['line1\nline2', '^', '> '],
  ['tab\there', '\\s', '_'],
  ['café', '\\p{L}+', 'W'],
  ['a-b_c', '[-_]', ' '],
  ['aaa', 'a*', 'X'],
  ['abc', '', '-'],
  ['', 'a', 'b'],
  ['abc', 'x', 'y'],
  // Constructs both copies must refuse in the same way.
  ['aaa', 'a++', 'x'],
  ['aaa', '(?>a)', 'x'],
  ['aaa', '(?i)A', 'x'],
  ['aa', '(a)\\1', 'x'],
  ['a', '(', 'x'],
  ['a', '[', 'x'],
  ['aaaa', '(a{1,2})*', 'x'],
  ['aaaa', '(a?)*', 'x'],
  ['a', '(a|a)*', 'x'],
  ['a'.repeat(20000), 'a', 'b'],
  ['abc', 'b', '$9'],
  ['abc', 'b', '\\'],
];

function outcome(run: () => string): string {
  try {
    return `ok:${run()}`;
  } catch (error) {
    return `error:${(error as Error).name}:${(error as Error).message}`;
  }
}

test('the browser Java regex compiler gives the server shim output or error on every corpus case', () => {
  for (const [text, pattern, replacement, first, ignoreCase] of CASES) {
    assert.equal(
      outcome(() => clientReplaceAll(text, pattern, replacement, first, ignoreCase)),
      outcome(() => serverReplaceAll(text, pattern, replacement, first, ignoreCase)),
      `replaceAll(${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text)}, ${JSON.stringify(pattern)}, ${JSON.stringify(replacement)}, first=${first ?? false}, ignoreCase=${ignoreCase ?? false})`,
    );
  }
});

// The browser string.replaceAll wrapper (client-runtime.js) must give the server
// shim's result for the same arguments: null/empty text, empty replacement, the
// optional fourth argument that makes the search literal, empty-result-is-null.
const runtimeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../packages/ui/src/client-runtime.js'), 'utf8');
const wrapperStart = runtimeSource.indexOf('replaceAll(value, find, replacement, escape) {');
const wrapperEnd = runtimeSource.indexOf('\n      },', wrapperStart);
const emptyStart = runtimeSource.indexOf('function clientEmptyToNull(value) {');
const emptyEnd = runtimeSource.indexOf('\n}\n', emptyStart);
assert.ok(wrapperStart > 0 && wrapperEnd > wrapperStart && emptyStart > 0 && emptyEnd > emptyStart, 'the browser replaceAll wrapper moved: update this test');
const clientWrapper = new Function(
  `${clientSource}\n${runtimeSource.slice(emptyStart, emptyEnd + 2)}\nconst shim = { ${runtimeSource.slice(wrapperStart, wrapperEnd + 9)} };\nreturn shim.replaceAll;`,
)() as (value: unknown, find: unknown, replacement: unknown, escape?: unknown) => string | null;

const WRAPPER_CASES: [unknown, unknown, unknown, unknown?][] = [
  [null, 'a', 'b'],
  ['', 'a', 'b'],
  ['abc', 'b', ''],
  ['abc', 'b', null],
  ['abc', null, 'x'],
  ['abc', 'b', 'x', true],
  ['a.b', '.', '-', true],
  ['a.b', '.', '-', 'true'],
  ['a.b', '.', '-', false],
  ['a.b', '.', '-'],
  ['abc', '', 'x', true],
  ['aaa', 'a', '', true],
  ['aaa', 'a', ''],
  ['a.b', '.', '$1', true],
];

test('the browser string.replaceAll wrapper gives the server shim result or error on every case', () => {
  for (const [value, find, replacement, escape] of WRAPPER_CASES) {
    assert.equal(
      outcome(() => String(clientWrapper(value, find, replacement, escape))),
      outcome(() => String(serverShimReplaceAll(value, find, replacement, escape))),
      `replaceAll(${JSON.stringify(value)}, ${JSON.stringify(find)}, ${JSON.stringify(replacement)}, ${JSON.stringify(escape)})`,
    );
  }
});
