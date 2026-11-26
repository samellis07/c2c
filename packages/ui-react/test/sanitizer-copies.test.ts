import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// packages/ui/src/sanitizer-core.ts is the one sanitizer source; the browser runtime block and the React template copy are generated from it.
test('the browser runtime and React template sanitizer copies equal what the core generates', async () => {
  const generator = (await import(pathToFileURL(join(process.cwd(), 'scripts/sanitizer-core.mjs')).href)) as { expected(): { runtime: string; react: string }; REACT: string; RUNTIME: string };
  const want = generator.expected();
  assert.equal(readFileSync(generator.RUNTIME, 'utf8'), want.runtime, 'client-runtime.js drifted from sanitizer-core.ts: run node scripts/sanitizer-core.mjs');
  assert.equal(readFileSync(generator.REACT, 'utf8'), want.react, 'pages/sanitize.ts drifted from sanitizer-core.ts: run node scripts/sanitizer-core.mjs');
});

test('the build sanitizer defines no sanitizer logic of its own', () => {
  const pages = readFileSync(join(process.cwd(), 'packages/ui/src/pages.ts'), 'utf8');
  assert.match(pages, /from '\.\/sanitizer-core\.js'/);
  for (const own of [/const ALLOWED_TAGS\b/, /function safeStyleValue\b/, /function cleanNode\b/, /const SHELL_IDS\b/]) assert.doesNotMatch(pages, own);
});
