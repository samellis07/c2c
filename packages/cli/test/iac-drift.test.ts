import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = path.join(repo, 'dist/cli/src/c2c.js');
// The `node c2c.js` children below share a V8 compile cache so each e2e spawn
// does not recompile the whole CLI (ignored on runtimes without it).
process.env.NODE_COMPILE_CACHE ??= path.join(tmpdir(), 'c2c-node-compile-cache');
const DS = 'application "Demo"\n{\n\tform Customer\n\t{\n\t\tName\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t}\n}\n';

function c2c(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('c2c schema --iac writes the Catalyst project template; iac-drift diffs it against an export', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'c2c-iac-'));
  try {
    const ds = path.join(dir, 'demo.ds');
    writeFileSync(ds, DS);
    const templatePath = path.join(dir, 'project-template-1.0.0.json');
    const gen = c2c('schema', ds, '--iac', '--out', templatePath);
    assert.equal(gen.status, 0, gen.stderr);
    const text = readFileSync(templatePath, 'utf8');
    const template = JSON.parse(text) as { name: string; components: { Datastore: { type: string; name: string; properties: Record<string, unknown> }[] } };
    assert.equal(template.name, 'project-template');
    assert.ok(template.components.Datastore.some((i) => i.type === 'table' && i.name === 'Customer'));
    assert.doesNotMatch(text, /^table |signals \{/m);

    const exported = structuredClone(template);
    for (const i of exported.components.Datastore) i.properties.id = '1000000000001';
    const exportPath = path.join(dir, 'export.json');
    writeFileSync(exportPath, JSON.stringify(exported));
    const exact = c2c('iac-drift', templatePath, exportPath);
    assert.equal(exact.status, 0, exact.stderr);
    assert.match(exact.stdout, /^drift: none\n/);

    exported.components.Datastore = exported.components.Datastore.filter((i) => i.name !== 'Customer-Name');
    writeFileSync(exportPath, JSON.stringify(exported));
    const drift = c2c('iac-drift', templatePath, exportPath);
    assert.equal(drift.status, 1);
    assert.match(drift.stdout, /missing:\n- Datastore\.column\.Customer-Name\n/);

    writeFileSync(exportPath, '{not json');
    const bad = c2c('iac-drift', templatePath, exportPath);
    assert.equal(bad.status, 3);
    assert.match(bad.stderr, /^c2c iac-drift: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
