/**
 * Installs the React template's build dependencies when they are missing so
 * the widget test suites can bundle and render. No-op once the two entries
 * the suites import exist; exits non-zero when the install cannot provide
 * them so `npm test` fails instead of reporting skipped widget tests.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const TEMPLATE_DIR = fileURLToPath(new URL('../packages/ui-react/template/', import.meta.url));
const ENTRIES = [
  'node_modules/vite/dist/node/index.js',
  'node_modules/@vitejs/plugin-react/dist/index.js',
];

const ready = () => ENTRIES.every((entry) => existsSync(join(TEMPLATE_DIR, entry)));
if (ready()) process.exit(0);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = spawnSync(npm, ['ci', '--offline', '--no-audit', '--no-fund'], {
  cwd: TEMPLATE_DIR,
  stdio: 'inherit',
});

if (run.status !== 0 || !ready()) {
  console.error(
    'the React template build dependencies are not installed; run `npm ci --prefix packages/ui-react/template`',
  );
  process.exit(run.status || 1);
}
