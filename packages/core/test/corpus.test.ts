import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSummary, runCorpus } from '../src/index.js';

test('corpus harness: redistributable fixtures round-trip 2/2', () => {
  const s = runCorpus('fixtures/redistributable');
  assert.equal(s.files, 2);
  assert.equal(s.roundTripOk, 2);
  assert.equal(s.roundTripFail, 0);
  assert.equal(s.shapes.B, 2);
  assert.equal(s.unknownNodes, 0);
});

test('corpus summary carries aggregate numbers only (no names, paths or contents)', () => {
  const md = formatSummary('fixtures', runCorpus('fixtures/redistributable'));
  assert.doesNotMatch(md, /\w\.ds\b/);
  assert.doesNotMatch(md, /Library|Freight|fixtures\/|https?:/);
  assert.match(md, /round-trip OK \| 2 \/ 2/);
});
