/**
 * Edge cover for parseJsonExact (lossless-json backed): integer literals of
 * every width stay exact digit strings, non-integers stay numbers, and
 * invalid JSON throws SyntaxError.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exactId, parseJsonExact } from '../src/json-exact.js';

test('17-digit Catalyst ids stay exact strings', () => {
  for (const digits of ['10000000000315013', '10000000000315015', '10000000000000001', '12345678901234567']) {
    assert.deepEqual(parseJsonExact(`{"id":${digits}}`), { id: digits });
    assert.deepEqual(parseJsonExact(`[${digits}]`), [digits]);
  }
});

test('ids at and past 2^53 keep every digit', () => {
  assert.deepEqual(parseJsonExact('[9007199254740991]'), ['9007199254740991']);
  assert.deepEqual(parseJsonExact('[9007199254740992]'), ['9007199254740992']);
  assert.deepEqual(parseJsonExact('[9007199254740993]'), ['9007199254740993']);
  assert.deepEqual(parseJsonExact('{"rowid":9007199254740993}'), { rowid: '9007199254740993' });
});

test('18- and 19-digit ids stay exact', () => {
  assert.deepEqual(parseJsonExact('[123456789012345678]'), ['123456789012345678']);
  assert.deepEqual(parseJsonExact('[1234567890123456789]'), ['1234567890123456789']);
});

test('negative integers and zero forms stay strings', () => {
  assert.deepEqual(parseJsonExact('[-5]'), ['-5']);
  assert.deepEqual(parseJsonExact('[0]'), ['0']);
  assert.deepEqual(parseJsonExact('[-0]'), ['-0']);
  assert.deepEqual(parseJsonExact('{"n":-10000000000315013}'), { n: '-10000000000315013' });
});

test('floats and exponents become numbers', () => {
  assert.deepEqual(parseJsonExact('[1.5]'), [1.5]);
  assert.deepEqual(parseJsonExact('[1e3]'), [1000]);
  assert.deepEqual(parseJsonExact('[2E-2]'), [0.02]);
  assert.deepEqual(parseJsonExact('[-2.5e-7]'), [-2.5e-7]);
  assert.deepEqual(parseJsonExact('[1E400]'), [Number('1E400')]);
  assert.deepEqual(parseJsonExact('[1.0]'), [1]);
});

test('nested structures keep ids exact at every depth', () => {
  const parsed = parseJsonExact('{"a":[{"b":{"id":10000000000315013}}]}') as {
    a: [{ b: { id: string } }];
  };
  assert.equal(parsed.a[0]!.b.id, '10000000000315013');
});

test('top-level scalars keep the contract', () => {
  assert.equal(parseJsonExact('5'), '5');
  assert.equal(parseJsonExact('"s"'), 's');
  assert.equal(parseJsonExact('true'), true);
  assert.equal(parseJsonExact('null'), null);
  assert.deepEqual(parseJsonExact('[1,[2,{"x":3}]]'), ['1', ['2', { x: '3' }]]);
});

test('a repeated key keeps the last value', () => {
  assert.deepEqual(parseJsonExact('{"a":1,"a":2}'), { a: '2' });
});

test('__proto__ stays an own data key with the prototype intact', () => {
  const parsed = parseJsonExact('{"__proto__":{"ID":"0"},"constructor":"x","a":1}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ['__proto__', 'constructor', 'a']);
  assert.equal(parsed.a, '1');
  const nulled = parseJsonExact('{"__proto__":null}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(nulled), Object.prototype);
  assert.deepEqual(Object.keys(nulled), ['__proto__']);
  assert.equal(nulled.__proto__, null);
});

test('__proto__ with a primitive value stays an own data key', () => {
  for (const [text, expected] of [
    ['{"__proto__":5}', '5'],
    ['{"__proto__":"s"}', 's'],
    ['{"__proto__":true}', true],
    ['{"__proto__":null}', null],
  ] as const) {
    const parsed = parseJsonExact(text) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
    assert.deepEqual(Object.keys(parsed), ['__proto__']);
    assert.equal(parsed.__proto__, expected);
  }
});

test('__proto__ keeps JSON.parse key order and works nested', () => {
  const parsed = parseJsonExact('{"a":1,"__proto__":{"x":10000000000315013},"b":2}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ['a', '__proto__', 'b']);
  assert.deepEqual(parsed.__proto__, { x: '10000000000315013' });
  const ordered = parseJsonExact('{"a":1,"__proto__":2,"b":3}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(ordered), ['a', '__proto__', 'b']);
  assert.equal(ordered.__proto__, '2');
  const nested = parseJsonExact('{"outer":{"__proto__":7,"z":[1,{"__proto__":false}]}}') as {
    outer: Record<string, unknown> & { z: [string, Record<string, unknown>] };
  };
  assert.equal(Object.getPrototypeOf(nested.outer), Object.prototype);
  assert.equal(nested.outer.__proto__, '7');
  assert.equal(Object.getPrototypeOf(nested.outer.z[1]), Object.prototype);
  assert.equal(nested.outer.z[1]!.__proto__, false);
});

test('a unicode-escaped "__proto__" key is still kept as an own data key', () => {
  const parsed = parseJsonExact('{"\\u005f\\u005fproto__":9}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ['__proto__']);
  assert.equal(parsed.__proto__, '9');
});

test('invalid JSON throws SyntaxError', () => {
  for (const bad of ['{', '{"a":}', '{"a" 1}', '[1,]', '01', '{"a":1} trailing', '', '{"a":NaN}', '{"a":1e}', '"\\q"']) {
    assert.throws(() => parseJsonExact(bad), SyntaxError, bad);
  }
});

test('exactId keeps its guards', () => {
  assert.equal(exactId('10000000000315013', 'ROWID'), '10000000000315013');
  assert.equal(exactId(42, 'ROWID'), '42');
  assert.throws(() => exactId(JSON.parse('10000000000315013'), 'ROWID'), /numeric id beyond MAX_SAFE_INTEGER/);
  assert.throws(() => exactId(null, 'ROWID'), /is not a string/);
});
