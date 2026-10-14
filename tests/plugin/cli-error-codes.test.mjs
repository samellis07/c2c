/** CLI error codes and the troubleshooting index stay in bidirectional parity. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sources = [
  'packages/cli/src/c2c.ts',
  'packages/deploy/src/cli.ts',
  'packages/doctor/src/cli.ts',
];
const index = 'plugin/references/error-index.md';
const codePattern = /C2C-(?:CLI|DEPLOY|DOCTOR)-\d{3}/g;
const read = (file) => readFileSync(path.join(repo, file), 'utf8');
function sourceCodes(sourceTexts) {
  return new Set(sourceTexts.flatMap((text) => [...text.matchAll(codePattern)].map(([code]) => code)));
}
function indexCodes(text) {
  return new Set([...text.matchAll(/^\| `(C2C-(?:CLI|DEPLOY|DOCTOR)-\d{3})` \|/gm)].map(([, code]) => code));
}
function assertParity(sourceTexts, indexText) {
  const source = sourceCodes(sourceTexts);
  const indexed = indexCodes(indexText);
  assert.deepEqual([...source].filter((code) => !indexed.has(code)), [], 'source error code is missing from error-index.md');
  assert.deepEqual([...indexed].filter((code) => !source.has(code)), [], 'error-index.md code has no source boundary');
}

test('every CLI error code is indexed and every indexed CLI code has a source boundary', () => {
  assertParity(sources.map(read), read(index));
});

test('negative controls detect a missing index row and an orphan index row', () => {
  const texts = sources.map(read);
  const source = sourceCodes(texts);
  const indexed = indexCodes(read(index));
  const code = [...source][0];
  const missingRow = read(index).replace(new RegExp('^\\| `' + code + '` \\|.*\\n', 'm'), '');
  assert.throws(() => assertParity(texts, missingRow), /source error code is missing/);
  const orphan = read(index).replace('| Code | Error boundary |', '| Code | Error boundary |\n| `C2C-DOCTOR-999` | invented boundary |');
  assert.throws(() => assertParity(texts, orphan), /no source boundary/);
  assert.ok(indexed.has(code));
});
