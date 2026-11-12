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

test('Creator export mode preserves every numeric token spelling', () => {
  assert.deepEqual(
    parseJsonExact('{"amount":12345678901234567890.12345678901234567890,"count":1e3}', { preserveNumberLiterals: true }),
    { amount: '12345678901234567890.12345678901234567890', count: '1e3' },
  );
  // Other callers retain the established number behavior.
  assert.deepEqual(parseJsonExact('{"amount":1.25}'), { amount: 1.25 });
});

test('table-driven round-trip preserves JSON scalar types for booleans, null, and numeric-looking strings', () => {
  const cases: { raw: string; optIn: unknown; standard: unknown; label: string }[] = [
    // booleans
    { raw: 'true', optIn: true, standard: true, label: 'boolean true' },
    { raw: 'false', optIn: false, standard: false, label: 'boolean false' },
    { raw: '{"active":true}', optIn: { active: true }, standard: { active: true }, label: 'object boolean true' },
    { raw: '{"active":false}', optIn: { active: false }, standard: { active: false }, label: 'object boolean false' },
    // null
    { raw: 'null', optIn: null, standard: null, label: 'null literal' },
    { raw: '{"item":null}', optIn: { item: null }, standard: { item: null }, label: 'object null property' },
    // empty string vs "null"
    { raw: '""', optIn: '', standard: '', label: 'empty string' },
    { raw: '"null"', optIn: 'null', standard: 'null', label: 'string "null"' },
    { raw: '{"val":""}', optIn: { val: '' }, standard: { val: '' }, label: 'object empty string' },
    { raw: '{"val":"null"}', optIn: { val: 'null' }, standard: { val: 'null' }, label: 'object string "null"' },
    // numeric-looking strings stay strings in both modes
    { raw: '"007"', optIn: '007', standard: '007', label: 'string with leading zeros' },
    { raw: '"1e3"', optIn: '1e3', standard: '1e3', label: 'string with scientific notation' },
    { raw: '"-0"', optIn: '-0', standard: '-0', label: 'string negative zero' },
    { raw: '"+1"', optIn: '+1', standard: '+1', label: 'string positive sign' },
    { raw: '"42"', optIn: '42', standard: '42', label: 'string integer' },
    { raw: '"0"', optIn: '0', standard: '0', label: 'string zero' },
    { raw: '"0.00"', optIn: '0.00', standard: '0.00', label: 'string decimal with zeros' },
    { raw: '"1.5e-4"', optIn: '1.5e-4', standard: '1.5e-4', label: 'string float exponential' },
    {
      raw: '{"s":"007","exp":"1e3","neg":"-0","pos":"+1"}',
      optIn: { s: '007', exp: '1e3', neg: '-0', pos: '+1' },
      standard: { s: '007', exp: '1e3', neg: '-0', pos: '+1' },
      label: 'object numeric-looking strings',
    },
    // number tokens: integers stay strings in both modes; floats/exponents are strings in opt-in, numbers in standard
    { raw: '42', optIn: '42', standard: '42', label: 'integer token' },
    { raw: '-0', optIn: '-0', standard: '-0', label: 'negative zero token' },
    { raw: '1e3', optIn: '1e3', standard: 1000, label: 'exponent token' },
    { raw: '1.25', optIn: '1.25', standard: 1.25, label: 'float token' },
  ];
  for (const { raw, optIn, standard, label } of cases) {
    assert.deepEqual(parseJsonExact(raw, { preserveNumberLiterals: true }), optIn, `opt-in mode: ${label}`);
    assert.deepEqual(parseJsonExact(raw), standard, `standard mode: ${label}`);
  }
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
