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

function* shellBlocks(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const fence = /^```(\S*)\s*$/.exec(lines[i]);
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

for (const doc of DOCS) {
  test(`every fenced shell block in ${doc} parses with bash -n`, () => {
    const file = path.join(repo, doc);
    const failures = [];
    for (const block of shellBlocks(file)) {
      const failure = shellSyntaxFailure(block.source);
      if (failure) failures.push(`${doc}:${block.line} ${failure}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('a malformed shell block is reported as a failure', () => {
  assert.match(shellSyntaxFailure("printf '%s\\n' 'unterminated"), /^bash -n exited/);
});
