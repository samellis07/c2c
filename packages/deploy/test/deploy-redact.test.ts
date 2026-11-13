import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/cli.js';

const CREDENTIAL = '/tmp/cred-DO-NOT-PRINT';

test('redact masks the credential path', () => {
  assert.equal(redact(`reading ${CREDENTIAL} failed`, CREDENTIAL), 'reading [credential] failed');
});

test('redact masks every secret function env value, exact match, longest first', () => {
  const values = ['tok-123', 'tok-123-long-value', 'hunter2'];
  const text = `env TOKEN=tok-123-long-value\nKEY=tok-123 PASS=hunter2 again hunter2\npath ${CREDENTIAL}`;
  const out = redact(text, CREDENTIAL, values);
  for (const value of values) assert.equal(out.includes(value), false, `${value} must not survive`);
  assert.equal(out.includes(CREDENTIAL), false);
  assert.equal(out, 'env TOKEN=[secret]\nKEY=[secret] PASS=[secret] again [secret]\npath [credential]');
});

test('redact ignores empty secret values and leaves unrelated text alone', () => {
  assert.equal(redact('nothing to hide', undefined, ['', 'absent']), 'nothing to hide');
});
