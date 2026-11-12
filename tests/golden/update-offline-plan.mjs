#!/usr/bin/env node
/** Regenerate readable c2c plan.md and plan.json goldens from checked-in synthetic apps. */
import { readdirSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCli } from '../../dist/deploy/src/offline-plan.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(root, 'fixtures/synthetic');
const goldenRoot = join(root, 'tests/golden/offline-plan');
const outputs = ['plan.md', 'plan.json'];

function apps(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return apps(path);
    return entry.isFile() && entry.name.endsWith('.ds') ? [path] : [];
  });
}

const refuse = (what) => async () => { throw new Error(`offline plan golden attempted ${what}`); };
const io = { stdout() {}, stderr: (text) => process.stderr.write(text), env: {}, spawn: refuse('spawn'), fetch: refuse('fetch') };
const fixtures = apps(fixtureRoot);
if (fixtures.length === 0) throw new Error(`no synthetic .ds fixtures under ${fixtureRoot}`);
const changed = [];
for (const app of fixtures) {
  const rel = relative(fixtureRoot, app).replaceAll(sep, '/');
  const target = join(goldenRoot, rel.replace(/\.ds$/, ''));
  const out = mkdtempSync(join(tmpdir(), 'c2c-plan-golden-update-'));
  try {
    const code = await planCli([app, '--out', out, '--dc', 'in'], io);
    if (code !== 0) throw new Error(`c2c plan failed for ${rel} (exit ${code})`);
    mkdirSync(target, { recursive: true });
    for (const file of outputs) {
      const next = readFileSync(join(out, file), 'utf8');
      const path = join(target, file);
      let previous;
      try { previous = readFileSync(path, 'utf8'); } catch {}
      if (previous !== next) {
        writeFileSync(path, next);
        changed.push(`${relative(root, path)}${previous === undefined ? ' (added)' : ''}`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
console.log(changed.length ? `Updated ${changed.length} offline plan golden file(s):\n${changed.map((path) => `  ${path}`).join('\n')}` : 'Offline plan goldens are already current.');
console.log('Review changes with git diff; plan.json is pretty-printed and plan.md is directly readable.');
