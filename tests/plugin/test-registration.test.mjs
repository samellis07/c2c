import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { readTestListLines } from '../../scripts/test-list.mjs';

const root = new URL('../../', import.meta.url);
const TEST_SCRIPT = 'npm run build && node scripts/ensure-ui-react-template.mjs && node scripts/run-tests.mjs --list scripts/test-files.txt && npm run check:hygiene';

test('npm test reads scripts/test-files.txt', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(packageJson.scripts.test, TEST_SCRIPT);
});

test('every plugin test is registered exactly once in npm test', async () => {
  const pluginDir = new URL('tests/plugin/', root);
  const files = (await readdir(pluginDir)).filter((file) => file.endsWith('.test.mjs'));
  const text = await readFile(new URL('scripts/test-files.txt', root), 'utf8');
  const args = readTestListLines(text)
    .map((entry) => entry.path)
    .filter((entry) => /^tests\/plugin\/[^/]+\.test\.mjs$/.test(entry));
  const registered = new Set(args);
  const missing = files.filter((file) => !registered.has(`tests/plugin/${file}`));
  const duplicates = args.filter((arg, index) => args.indexOf(arg) !== index);

  assert.deepEqual(missing, [], `Unregistered plugin tests: ${missing.join(', ')}`);
  assert.deepEqual(duplicates, [], `Duplicate plugin test registrations: ${duplicates.join(', ')}`);
});
