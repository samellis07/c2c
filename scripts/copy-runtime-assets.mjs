import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages/ui/src');
const destination = join(root, 'dist/ui/src');

mkdirSync(destination, { recursive: true });
cpSync(join(source, 'client-runtime.js'), join(destination, 'client-runtime.js'));
cpSync(join(source, 'client'), join(destination, 'client'), { recursive: true });

// TypeScript tests import this helper at runtime, but test golden modules are
// data and must not be emitted where the test runner discovers them.
cpSync(join(root, 'packages/cli/test/cli-test-env.mjs'), join(root, 'dist/cli/test/cli-test-env.mjs'));
rmSync(join(root, 'dist/ui/test/golden/htmlpage-shape-a.mjs'), { force: true });
