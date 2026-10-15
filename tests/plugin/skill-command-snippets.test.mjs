/**
 * Every concrete c2c command example covered by the CLI argument contract in
 * the plugin skills and references must remain parseable by that contract.
 * This intentionally reads docs instead of copying the snippets into a
 * separate fixture list, so documentation drift is exercised directly.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { ARGV_SPEC, argvProblems } = await import(path.join(repo, 'dist/cli/src/argv.js'));

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

function commandSnippets(file) {
  const text = readFileSync(file, 'utf8');
  const parts = [];
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) parts.push(match[1]);
  for (const match of text.matchAll(/`([^`]+)`/g)) parts.push(match[1]);

  const snippets = [];
  for (const part of parts) {
    for (const line of part.split(/\r?\n/)) {
      const source = line.replace(/\s+#.*$/, '').replace(/;.*/, '').trim();
      const match = source.match(/(?:^|\s)c2c\s+([a-z][a-z0-9-]*)(.*)$/);
      if (!match || !ARGV_SPEC[match[1]]) continue;
      // Usage signatures and unfinished examples are descriptive, not argv.
      if (/[\[\]]|…|\.\.\./.test(match[2])) continue;
      const args = tokenize(match[2].replace(/\s+>\s+.*$/, '').trim());
      if (!args.length) continue;
      snippets.push({ command: match[1], args, file, source: source.trim() });
    }
  }
  return snippets;
}

function tokenize(source) {
  const tokens = [];
  for (const match of source.matchAll(/"([^\"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens.map((token) => /^<[^>]+>$/.test(token) ? '<placeholder>' : token);
}

const files = [
  ...markdownFiles(path.join(repo, 'plugin/skills')),
  ...markdownFiles(path.join(repo, 'plugin/references')),
];
const snippets = files.flatMap(commandSnippets);
const pluginDocs = markdownFiles(path.join(repo, 'plugin'));

// The env file contains plaintext credentials, so plugin instructions must
// keep it outside the generated tree that users commonly commit.
test('plugin docs keep function-env.json outside c2c-out', () => {
  const unsafePath = /c2c-out\/(?:<[^>]+>|[^/\s`'"<>]+)\/function-env\.json/;
  assert.equal(unsafePath.test('c2c-out/<app>/function-env.json'), true);
  assert.equal(unsafePath.test('c2c-out/my-app/function-env.json'), true);
  const violations = pluginDocs.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(new RegExp(unsafePath, 'g'))].map((match) =>
      `${path.relative(repo, file)}: ${match[0]}`
    );
  });
  assert.deepEqual(violations, []);
});

test('plugin skill and reference c2c command snippets parse against the CLI argument contract', () => {
  assert.ok(snippets.length >= 20, `found concrete contracted command snippets (${snippets.length})`);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'c2c-skill-snippets-'));
  const envFile = path.join(temp, 'function-env.json');
  writeFileSync(envFile, '{}\n');
  try {
    const failures = snippets.flatMap(({ command, args, file, source }) => {
      const normalized = args.map((arg, i) => arg === '--function-env' ? (args[i + 1] = envFile, arg) : arg);
      const problems = argvProblems(command, normalized);
      return problems.length ? [`${path.relative(repo, file)}: ${source}: ${problems.join('; ')}`] : [];
    });
    assert.deepEqual(failures, []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('status argument checks reject missing scope and accept documented project scope', () => {
  assert.deepEqual(argvProblems('status', ['--fake']), ['c2c status: --project <project-id> is required']);
  assert.deepEqual(argvProblems('status', ['--project', '<project-id>', '--org', '<org-id>']), []);
});
