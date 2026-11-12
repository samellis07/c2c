/** Repo paths and line pointers cited by the plugin's skills and references. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDirs = ['plugin/skills', 'plugin/references'];
const sourceFiles = [...markdownFiles(path.join(repo, 'docs'))].filter((file) => path.relative(repo, file) === 'docs/data-fidelity-gaps.md');
for (const dir of sourceDirs) sourceFiles.push(...markdownFiles(path.join(repo, dir)));

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(file);
    else if (entry.isFile() && file.endsWith('.md')) yield file;
  }
}

function* citedPaths(line) {
  // Full repo-relative citations such as packages/core/src/parse.ts:12-15.
  // Also accept source-relative short citations such as mapping.ts:131-138.
  const pattern = /(?:^|[\s(`])((?:packages|plugin|docs|scripts|tests|tools)\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|mts|cts))(?::(\d+)(?:-(\d+))?)?/g;
  for (const match of line.matchAll(pattern)) {
    let target = match[1].replace(/[.,;]+$/, '');
    if (target.includes('://') || target.includes('*')) continue;
    yield { target, line: Number(match[2] ?? 0), endLine: Number(match[3] ?? match[2] ?? 0) };
  }
}

function resolveCitation(fromFile, target, lineText) {
  const candidates = [];
  if (target.includes('/')) candidates.push(path.resolve(repo, target));
  else {
    // Prefer the source directory explicitly named in a nearby citation, e.g.
    // `mapping.ts:131` following `packages/schema/src/mapping.ts`.
    const mentionedDirs = [...lineText.matchAll(/((?:packages|tests|scripts|tools)\/[A-Za-z0-9_./-]+\/)\S*/g)]
      .map((match) => path.dirname(path.resolve(repo, match[1])));
    for (const dir of mentionedDirs) collectNamedFiles(dir, target, candidates);
    if (candidates.length === 0) {
      for (const root of ['packages', 'tests', 'scripts', 'tools']) {
        collectNamedFiles(path.join(repo, root), target, candidates);
      }
    }
  }
  const valid = [...new Set(candidates)].filter((candidate) =>
    candidate.startsWith(`${repo}${path.sep}`) && existsSync(candidate),
  );
  if (valid.length === 1) return valid[0];
  if (target.includes('/')) return null;
  // A basename is acceptable only when it uniquely identifies one source file.
  return valid.length === 0 ? null : { ambiguous: valid.map((file) => path.relative(repo, file)) };
}

function collectNamedFiles(dir, name, output) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collectNamedFiles(file, name, output);
    else if (entry.isFile() && entry.name === name) output.push(file);
  }
}

test('repo paths cited in plugin skills, references, and fidelity gaps exist with valid lines', () => {
  const issues = [];
  for (const file of sourceFiles) {
    const rel = path.relative(repo, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const citation of citedPaths(lines[i])) {
        const resolved = resolveCitation(file, citation.target, lines[i]);
        if (!resolved) {
          issues.push(`${rel}:${i + 1}: missing or ambiguous path ${citation.target}`);
          continue;
        }
        if (typeof resolved === 'object') {
          issues.push(`${rel}:${i + 1}: ambiguous path ${citation.target} (${resolved.ambiguous.join(', ')})`);
          continue;
        }
        if (citation.line) {
          const count = readFileSync(resolved, 'utf8').split('\n').length;
          if (citation.line < 1 || citation.endLine > count) {
            issues.push(`${rel}:${i + 1}: ${citation.target}:${citation.line}${citation.endLine !== citation.line ? `-${citation.endLine}` : ''} exceeds ${path.relative(repo, resolved)} (${count} lines)`);
          }
        }
      }
    }
  }
  assert.deepEqual(issues, []);
});
