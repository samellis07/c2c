import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALLOWED_TAGS as pageAllowed, DROPPED_TAGS as pageDropped } from '../src/pages.js';

async function runtimeSets(): Promise<{
  allowed: Set<string>;
  dropped: Set<string>;
}> {
  const runtime = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    ALLOWED_TAGS: Set<string>;
    DROPPED_TAGS: Set<string>;
  };
  return { allowed: runtime.ALLOWED_TAGS, dropped: runtime.DROPPED_TAGS };
}

test('snippet sanitizer tag sets mirror each other', async () => {
  const runtime = await runtimeSets();
  assert.deepEqual([...runtime.allowed].sort(), [...pageAllowed].sort(), 'runtime vs page allowed tags');
  assert.deepEqual([...runtime.dropped].sort(), [...pageDropped].sort(), 'runtime vs page dropped tags');
});
