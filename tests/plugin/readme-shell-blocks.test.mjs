/**
 * README shell blocks. Every fenced ```sh/```bash block in the user-facing
 * READMEs must parse as shell (`bash -n`): copyable snippets may not contain
 * bare `<placeholder>` tokens, which bash reads as redirections.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = ['plugin/README.md', 'docs/guide/02-before-you-start.md'];

function shellSyntaxFailure(source) {
  const run = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
  return run.status === 0 ? null : `bash -n exited ${run.status}: ${run.stderr.trim()}`;
}

// Fences may be indented (blocks nested under a list item), so match them
// with leading whitespace.
function* shellBlocks(text) {
  const lines = text.split('\n');
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^\s*```(\S*)\s*$/.exec(lines[i]);
    if (!open) {
      if (fence && /^(sh|bash|shell|zsh)$/.test(fence[1])) open = { start: i + 1, lines: [] };
      else if (fence) open = { start: i + 1, lines: null };
    } else if (fence) {
      if (open.lines) yield { line: open.start, source: open.lines.join('\n') };
      open = null;
    } else if (open.lines) {
      open.lines.push(lines[i]);
    }
  }
}

function shellFailures(label, text) {
  const failures = [];
  for (const block of shellBlocks(text)) {
    const failure = shellSyntaxFailure(block.source);
    if (failure) failures.push(`${label}:${block.line} ${failure}`);
  }
  return failures;
}

for (const doc of DOCS) {
  test(`every fenced shell block in ${doc} parses with bash -n`, () => {
    assert.deepEqual(shellFailures(doc, readFileSync(path.join(repo, doc), 'utf8')), []);
  });
}

test('plugin/README.md install snippets nested under list items are checked', () => {
  const text = readFileSync(path.join(repo, 'plugin/README.md'), 'utf8');
  const sources = [...shellBlocks(text)].map((b) => b.source);
  assert.ok(sources.some((src) => src.includes('~/.codex/prompts')), 'Codex install block not found');
  assert.ok(sources.some((src) => src.includes('.cursor/rules/c2c.mdc')), 'Cursor install block not found');
});

test('a malformed shell block is reported as a failure', () => {
  assert.match(shellSyntaxFailure("printf '%s\\n' 'unterminated"), /^bash -n exited/);
});

test('an indented shell block with a bare <placeholder> fails bash -n', () => {
  const text = '- step:\n  ```sh\n  for c in <plugin>/commands/*.md; do cp "$c" out/; done\n  ```\n';
  const failures = shellFailures('sample', text);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^sample:2 bash -n exited/);
});
