import test from 'node:test';
import assert from 'node:assert/strict';
import { singleLine, terminalSafe } from '../src/sanitize.js';

const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const esc = (code: number): string => `\\u{${code.toString(16)}}`;

const INVISIBLE_LOOKALIKES = [0x034f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x180b, 0x180c, 0x180d, 0x180f, 0x17b4, 0x17b5, 0x1d173, 0x1d17a, 0x13430, 0x1343f, 0x1bca0, 0x1bca3, 0x110bd, 0x110cd];
const ODD_SPACES = [0x00a0, 0x1680, 0x2000, 0x2003, 0x200a, 0x202f, 0x205f, 0x3000];

for (const fn of [terminalSafe, singleLine]) {
  test(`${fn.name}: invisible and look-alike characters become a visible escape`, () => {
    for (const code of INVISIBLE_LOOKALIKES) {
      const out = fn(`a${cp(code)}b`);
      assert.equal(out, `a${esc(code)}b`, `U+${code.toString(16)} must be escaped`);
    }
  });

  test(`${fn.name}: no-break and unusual spaces become a plain space`, () => {
    for (const code of ODD_SPACES) assert.equal(fn(`a${cp(code)}b`), 'a b', `U+${code.toString(16)} must be a plain space`);
  });

  test(`${fn.name}: a lone braille blank cannot pass for an empty value`, () => {
    assert.equal(fn(cp(0x2800)), esc(0x2800));
    assert.equal(fn(cp(0x3164, 0x3164)), `${esc(0x3164)}${esc(0x3164)}`);
  });

  test(`${fn.name}: a variation selector after a non-emoji is escaped, one inside an emoji sequence is kept`, () => {
    assert.equal(fn(`a${cp(0xfe0f)}`), `a${esc(0xfe0f)}`);
    assert.equal(fn(`1${cp(0xfe0f)}`), `1${esc(0xfe0f)}`);
    assert.equal(fn(`${cp(0xfe0f)}x`), `${esc(0xfe0f)}x`);
    assert.equal(fn(`a${cp(0xfe0f, 0xfe0f)}`), `a${esc(0xfe0f)}${esc(0xfe0f)}`);
    const heart = cp(0x2764, 0xfe0f);
    assert.equal(fn(heart), heart);
    const keycap = cp(0x31, 0xfe0f, 0x20e3);
    assert.equal(fn(keycap), keycap);
    const text = cp(0x2764, 0xfe0e);
    assert.equal(fn(text), text);
    const zwjSeq = cp(0x1f469, 0x200d, 0x1f4bb);
    assert.equal(fn(zwjSeq).includes(cp(0x1f469)), true);
    assert.equal(fn(`${cp(0x2764, 0xfe0f)}${cp(0xfe0f)}`), `${cp(0x2764, 0xfe0f)}${esc(0xfe0f)}`, 'a second selector is not part of the sequence');
    assert.equal(fn(`a${cp(0xe0100)}`), `a${esc(0xe0100)}`, 'supplementary selectors are never emoji');
  });

  test(`${fn.name}: legitimate text is unchanged`, () => {
    const text = `caf${cp(0xe9)} ${cp(0x65, 0x301)} ${cp(0x65e5, 0x672c, 0x8a9e)} ${cp(0x1f600)} A`;
    assert.equal(fn(text), text);
  });
}

test('multi-line keeps newline and tab; single-line removes them', () => {
  assert.equal(terminalSafe('a\nb\tc'), 'a\nb\tc');
  assert.equal(singleLine('a\nb\tc'), 'a?b?c');
});

for (const fn of [terminalSafe, singleLine]) {
  test(`${fn.name}: no default-ignorable or format character survives anywhere in the Unicode range`, () => {
    const invisible = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/u;
    const survivors: string[] = [];
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const ch = String.fromCodePoint(code);
      if (!invisible.test(ch)) continue;
      if (fn(`a${ch}b`).includes(ch)) survivors.push(code.toString(16));
    }
    assert.deepEqual(survivors, [], 'these invisible characters reach the output unchanged');
  });
}
