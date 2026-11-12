import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureFixtures } from '../src/measure.js';

const root = process.env.C2C_FIXTURES_DIR;

test('fixture corpora: how many forms and queries hit each unverified limit', { skip: root ? false : 'C2C_FIXTURES_DIR is not set' }, () => {
  const report = measureFixtures(root!);
  const byName = Object.fromEntries(report.corpora.map((corpus) => [corpus.name, corpus]));
  assert.equal(byName.gallery?.apps, 67);
  assert.equal(byName.synthetic?.apps, 34);
  assert.ok((byName['public-corpus']?.apps ?? 0) > 0);
  for (const corpus of report.corpora) {
    assert.deepEqual(corpus.failed, [], corpus.name);
    assert.equal(Number.isInteger(corpus.counts.formsOverColumnCap), true);
  }
  console.log(`LIMIT_HITS ${JSON.stringify(report)}`);
});
