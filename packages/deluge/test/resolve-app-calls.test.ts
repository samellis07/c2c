import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FunctionDef } from '../../core/src/ir.js';
import { resolveAppCalls } from '../src/resolve-app-calls.js';
import { translate } from '../src/translate.js';

const functionDef = (name: string, signature: string): FunctionDef => ({
  name,
  kind: 'deluge',
  signature,
  deluge: [],
  properties: [],
  span: { start: 0, end: 0 },
});

test('same-app resolution leaves mismatched and ambiguous calls as TODOs', () => {
  const mismatch = 'return target();';
  const mismatchTodos = translate(mismatch).todos;
  assert.equal(resolveAppCalls(mismatch, [functionDef('target', 'int target(int n)')], mismatchTodos), mismatch);

  const ambiguous = 'return target(1);';
  const ambiguousTodos = translate(ambiguous).todos;
  assert.equal(
    resolveAppCalls(ambiguous, [functionDef('target', 'int target(int n)'), functionDef('TARGET', 'int TARGET(int n)')], ambiguousTodos),
    ambiguous,
  );
});

test('a bare call that collides with a catalogued builtin remains a TODO', () => {
  const source = 'return today();';
  const translated = translate(source);
  assert.ok(translated.todos.some((todo) => todo.construct === 'call:today'));
  assert.equal(resolveAppCalls(source, [functionDef('today', 'date today()')], translated.todos), source);
});

test('same-app resolution handles ordinary bare calls and preserves explicit thisapp calls', () => {
  const source = 'return helper();';
  const todos = translate(source).todos;
  assert.equal(resolveAppCalls(source, [functionDef('helper', 'int helper()')], todos), 'return thisapp.helper();');

  const explicit = 'return thisapp.helper();';
  assert.equal(resolveAppCalls(explicit, [functionDef('helper', 'int helper()')], translate(explicit).todos), explicit);
});
