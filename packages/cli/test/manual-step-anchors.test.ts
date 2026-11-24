import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = join(import.meta.dirname, '../../..');
const page = readFileSync(join(root, 'docs/human-steps.md'), 'utf8');

// These categories are the manual-step wording emitted by the UI model and
// guided residual generator. Keep the page anchors coupled to that contract.
const emitted = [
  'manual-kind-field-time-precision',
  'manual-kind-field-privacy',
  'manual-kind-report-options',
  'manual-kind-report-properties',
  'manual-kind-zml-click-parameters',
];

test('every emitted manual-step anchor resolves to one heading', () => {
  for (const anchor of emitted) {
    const matches = page.match(new RegExp(`id=["']${anchor}["']`, 'g')) ?? [];
    assert.equal(matches.length, 1, `${anchor} must be present exactly once`);
    assert.match(page, new RegExp(`^## <a id=["']${anchor}["']></a>[^\\n]+$`, 'm'));
  }
});
