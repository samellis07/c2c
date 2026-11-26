/**
 * A stylesheet link that climbs out of the bundle directory is not read: the
 * scorer reads the bundle's own files only.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bundleFromDir } from '../src/score.js';

test('a stylesheet link outside the bundle directory is not read', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-link-escape-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  mkdirSync(join(bundle, 'slate', 'assets'), { recursive: true });
  writeFileSync(join(root, 'outside.css'), '.outside-marker{color:red}');
  writeFileSync(join(bundle, 'slate', 'assets', 'in.css'), '.inside-marker{color:blue}');
  writeFileSync(
    join(bundle, 'slate', 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/assets/in.css"><link rel="stylesheet" href="../../outside.css"><link rel="stylesheet" href="/../../outside.css"></head><body></body></html>',
  );
  const result = bundleFromDir(bundle);
  assert.ok(result.css.includes('inside-marker'), 'the bundle stylesheet is read');
  assert.ok(!result.css.includes('outside-marker'), 'a stylesheet outside the bundle is not read');
});
