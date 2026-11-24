import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_STEP_ANCHORS, type ManualStepAnchor } from '../../ui/src/manual-step-anchors.js';

const root = join(import.meta.dirname, '../../..');
const page = readFileSync(join(root, 'docs/human-steps.md'), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const emitted: readonly ManualStepAnchor[] = Object.values(MANUAL_STEP_ANCHORS);
const source = sourceFiles(join(root, 'packages'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const linked = [...source.matchAll(/human-steps#([a-z0-9-]+)/g)].map((match) => match[1]!);

test('every emitted manual-step anchor resolves to one heading', () => {
  assert.deepEqual([...new Set(linked)].sort(), emitted.map(({ id }) => id).sort());
  for (const { id, heading } of emitted) {
    const matches = page.match(new RegExp(`id=["']${id}["']`, 'g')) ?? [];
    assert.equal(matches.length, 1, `${id} must be present exactly once`);
    assert.match(page, new RegExp(`^## <a id=["']${id}["']></a>${heading}$`, 'm'));
  }
});
