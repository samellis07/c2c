import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url);

test('every plugin test is registered exactly once in npm test', async () => {
  const pluginDir = new URL('tests/plugin/', root);
  const files = (await readdir(pluginDir)).filter((file) => file.endsWith('.test.mjs'));
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const testScript = packageJson.scripts.test;
  const args = testScript.match(/tests\/plugin\/[^\s]+\.test\.mjs/g) ?? [];
  const registered = new Set(args);
  const missing = files.filter((file) => !registered.has(`tests/plugin/${file}`));
  const duplicates = args.filter((arg, index) => args.indexOf(arg) !== index);

  assert.deepEqual(missing, [], `Unregistered plugin tests: ${missing.join(', ')}`);
  assert.deepEqual(duplicates, [], `Duplicate plugin test registrations: ${duplicates.join(', ')}`);
});
