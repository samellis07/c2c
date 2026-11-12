/**
 * Packaged plugin hygiene. The scan reuses scripts/check-hygiene.mjs:
 * a home path, a non-placeholder address, and a long id are refused.
 * Samples come from that checker's canary. This file does not list names.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canarySamples, scanDirectory } from '../../scripts/check-hygiene.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const node = process.execPath;
const script = path.join(repo, 'scripts/vendor-plugin.mjs');

function run(args) {
  return spawnSync(node, [script, ...args], { cwd: repo, encoding: 'utf8' });
}

function sample(rule, segment) {
  return canarySamples().find((item) => item.rule === rule && (!segment || item.text.split(/[/\\]/).includes(segment)));
}

test('packaged plugin scan refuses a home path, a non-placeholder address, and a long id', () => {
  const cases = [sample('home-path', 'home'), sample('email'), sample('project-id')];
  for (const item of cases) {
    assert.ok(item, 'missing canary sample');
    const root = mkdtempSync(path.join(tmpdir(), 'c2c-hyg-'));
    try {
      mkdirSync(path.join(root, 'plugin'), { recursive: true });
      writeFileSync(path.join(root, 'plugin/leak.txt'), `${item.text}\n`);
      const res = run(['--check-hygiene', '--root', root]);
      assert.notEqual(res.status, 0, `${item.rule} was accepted\n${res.stdout}\n${res.stderr}`);
      assert.match(`${res.stdout}\n${res.stderr}`, new RegExp(item.rule));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('a placeholder address and a placeholder id pass', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-hyg-clean-'));
  try {
    mkdirSync(path.join(root, 'plugin/references'), { recursive: true });
    writeFileSync(
      path.join(root, 'plugin/references/doctor-spec.md'),
      'org <org-id> project <project-id> user@example.com\n',
    );
    const res = run(['--check-hygiene', '--root', root]);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /plugin-hygiene: clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('require-vendor fails when the vendored dist is absent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-hyg-novendor-'));
  try {
    mkdirSync(path.join(root, 'plugin'), { recursive: true });
    writeFileSync(path.join(root, 'plugin/readme.md'), 'placeholders only <org-id>\n');
    const res = run(['--check-hygiene', '--require-vendor', '--root', root]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /plugin\/vendor\/c2c\/dist is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compiled test path is skipped and a shipped file is not', () => {
  const item = sample('email');
  assert.ok(item);
  const root = mkdtempSync(path.join(tmpdir(), 'c2c-hyg-skip-'));
  try {
    mkdirSync(path.join(root, 'test'), { recursive: true });
    writeFileSync(path.join(root, 'test/leak.js'), `${item.text}\n`);
    assert.deepEqual(scanDirectory(root, { skipSegments: ['test'] }), []);
    writeFileSync(path.join(root, 'leak.js'), `${item.text}\n`);
    assert.ok(scanDirectory(root, { skipSegments: ['test'] }).some((hit) => hit.endsWith(item.rule)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin source passes the generic hygiene scan', () => {
  assert.deepEqual(scanDirectory(path.join(repo, 'plugin'), { ignore: ['vendor/c2c/node_modules'] }), []);
  const res = run(['--check-hygiene', '--root', repo]);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /plugin-hygiene: clean/);
});
