/** Byte-for-byte offline plan goldens for every checked-in synthetic app. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { planCli } from '../src/offline-plan.js';
import type { Io } from '../src/cli.js';
import { repoRoot } from '../../core/src/toolchain.js';

const root = repoRoot();
const fixtureRoot = join(root, 'fixtures/synthetic');
const goldenRoot = join(root, 'tests/golden/offline-plan');
const required = ['plan.md', 'plan.json'];

function syntheticApps(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return syntheticApps(path);
    return entry.isFile() && entry.name.endsWith('.ds') ? [path] : [];
  });
}

function offlineIo(): Io {
  const refuse = (what: string) => async () => { throw new Error(`offline plan golden attempted ${what}`); };
  return { stdout: () => {}, stderr: () => {}, env: {}, spawn: refuse('spawn'), fetch: refuse('fetch') };
}

test('every in-repo synthetic app produces pinned offline plan goldens deterministically', async () => {
  const apps = syntheticApps(fixtureRoot);
  assert.ok(apps.length > 0, 'no checked-in synthetic .ds fixtures found');
  for (const app of apps) {
    const relativeApp = relative(fixtureRoot, app).replaceAll(sep, '/');
    const goldenDir = join(goldenRoot, relativeApp.replace(/\.ds$/, ''));
    const outputs = [mkdtempSync(join(tmpdir(), 'c2c-plan-golden-a-')), mkdtempSync(join(tmpdir(), 'c2c-plan-golden-b-'))];
    try {
      for (const out of outputs) {
        assert.equal(await planCli([app, '--out', out, '--dc', 'in'], offlineIo()), 0, `failed to plan ${relativeApp}`);
      }
      for (const file of required) {
        const first = readFileSync(join(outputs[0]!, file), 'utf8');
        const second = readFileSync(join(outputs[1]!, file), 'utf8');
        assert.equal(second, first, `${relativeApp}: ${file} changed between runs`);
        const golden = join(goldenDir, file);
        let pinned;
        try {
          pinned = readFileSync(golden, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        assert.ok(pinned !== undefined, `${relativeApp}: missing golden ${file}; run npm run golden:offline-plan:update`);
        assert.equal(first, pinned, `${relativeApp}: ${file} differs from its readable golden`);
      }
    } finally {
      for (const out of outputs) rmSync(out, { recursive: true, force: true });
    }
  }
});
