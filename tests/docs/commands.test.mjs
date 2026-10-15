/**
 * Every command a public doc tells the reader to copy must be real: an
 * `npm run <script>` names a package.json script, a `node dist/<p>.js` maps
 * to a source file under packages/, a `tools/` or `scripts/` path exists,
 * and a `c2c <verb> --flag` names a verb this CLI has (and, for a verb with
 * an argument contract in packages/cli/src/argv.ts, a flag that contract
 * accepts). Only fenced code blocks and inline `code spans` are scanned —
 * prose mentioning "c2c" is not a command a reader copies.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sliceBalanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

/** `{ verbToFlags: Map<string, Set<string>|undefined>, rootVerbs: Set<string> }` from the CLI source. */
function loadCliCommands() {
  const argvSrc = readFileSync(path.join(repoRoot, 'packages/cli/src/argv.ts'), 'utf8');
  const scopeDecl = /const SCOPE:[^=]*=\s*(\{)/.exec(argvSrc);
  const scopeBlock = sliceBalanced(argvSrc, scopeDecl.index + scopeDecl[0].length - 1);
  const scopeFlags = [...scopeBlock.matchAll(/'(--[a-zA-Z0-9-]+)'/g)].map((m) => m[1]);

  const specDecl = /export const ARGV_SPEC:[^=]*=\s*(\{)/.exec(argvSrc);
  const specBlock = sliceBalanced(argvSrc, specDecl.index + specDecl[0].length - 1);
  const verbToFlags = new Map();
  const entryRe = /\n\s{2}(?:'([a-zA-Z0-9-]+)'|([a-zA-Z0-9-]+)):\s*\{/g;
  let m;
  while ((m = entryRe.exec(specBlock))) {
    const name = m[1] || m[2];
    const openIdx = m.index + m[0].length - 1;
    const block = sliceBalanced(specBlock, openIdx);
    const flags = new Set(block.includes('...SCOPE') ? scopeFlags : []);
    for (const fm of block.matchAll(/'(--[a-zA-Z0-9-]+)'/g)) flags.add(fm[1]);
    verbToFlags.set(name, flags);
  }

  const c2cSrc = readFileSync(path.join(repoRoot, 'packages/cli/src/c2c.ts'), 'utf8');
  const rootVerbs = new Set(verbToFlags.keys());
  for (const vm of c2cSrc.matchAll(/cmd === '([^']+)'/g)) rootVerbs.add(vm[1]);

  return { verbToFlags, rootVerbs };
}

/** Fenced-code-block bodies and inline `code span` bodies of a markdown doc, as separate regions. */
function codeRegions(markdown) {
  const regions = [];
  const lines = markdown.split('\n');
  let inFence = false;
  let fenceBuf = [];
  const proseLines = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        regions.push(fenceBuf.join('\n'));
        fenceBuf = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) fenceBuf.push(line);
    else proseLines.push(line);
  }
  const prose = proseLines.join('\n');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) regions.push(m[1]);
  return regions;
}

/** Shell line-continuations (`\` at end of line) joined, so a multi-line invocation is one logical line. */
function logicalLines(region) {
  return region.replace(/\\\r?\n[ \t]*/g, ' ').split('\n');
}

const NPM_RUN = /\bnpm run ([A-Za-z0-9_:-]+)/g;
const NODE_PATH = /\bnode ((?:dist|tools|scripts)\/[A-Za-z0-9._/-]+)/g;
const BARE_TOOLS_SCRIPTS = /(?:^|[\s"'(])((?:tools|scripts)\/[A-Za-z0-9._/-]+)/g;
const C2C_JS = /\bnode\s+\S*\bc2c\.js\b/g;
const C2C_VERB = /\bc2c\s+(--verify-vendor|[A-Za-z][A-Za-z0-9-]*)/g;
const FLAG = /--[A-Za-z][A-Za-z0-9-]*/g;

/**
 * Every problem a doc's code regions name: an unknown npm script, a
 * `node dist/<p>.js` with no matching source file, a missing tools/scripts
 * path, an unknown c2c verb, or a flag not in that verb's argument contract.
 */
function checkMarkdown(relPath, text, { scripts, rootVerbs, verbToFlags }) {
  const problems = [];
  for (const region of codeRegions(text)) {
    for (const m of region.matchAll(NPM_RUN)) {
      if (!scripts.has(m[1])) problems.push(`${relPath}: npm run ${m[1]} is not a package.json script`);
    }
    for (const m of region.matchAll(NODE_PATH)) {
      const p = m[1];
      if (p.startsWith('dist/') && p.endsWith('.js')) {
        const srcPath = path.join(repoRoot, 'packages', `${p.slice('dist/'.length, -'.js'.length)}.ts`);
        if (!statSync(srcPath, { throwIfNoEntry: false })) problems.push(`${relPath}: node ${p} has no source file ${path.relative(repoRoot, srcPath)}`);
      } else if (!statSync(path.join(repoRoot, p), { throwIfNoEntry: false })) {
        problems.push(`${relPath}: node ${p} does not exist`);
      }
    }
    for (const m of region.matchAll(BARE_TOOLS_SCRIPTS)) {
      if (!statSync(path.join(repoRoot, m[1]), { throwIfNoEntry: false })) problems.push(`${relPath}: ${m[1]} does not exist`);
    }
    for (const line of logicalLines(region)) {
      const normalized = line.replace(C2C_JS, 'c2c');
      const matches = [...normalized.matchAll(C2C_VERB)];
      for (let i = 0; i < matches.length; i++) {
        const verb = matches[i][1];
        if (!rootVerbs.has(verb)) {
          problems.push(`${relPath}: c2c ${verb} is not a known command`);
          continue;
        }
        const spec = verbToFlags.get(verb);
        if (!spec) continue;
        const start = matches[i].index + matches[i][0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
        for (const fm of normalized.slice(start, end).matchAll(FLAG)) {
          if (!spec.has(fm[0])) problems.push(`${relPath}: c2c ${verb} ${fm[0]} is not in its argument contract`);
        }
      }
    }
  }
  return problems;
}

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(child);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield child;
  }
}

function docTargets() {
  const files = [...markdownFiles(path.join(repoRoot, 'docs'))];
  files.push(path.join(repoRoot, 'README.md'), path.join(repoRoot, 'CONTRIBUTING.md'));
  return files;
}

function loadContext() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const { verbToFlags, rootVerbs } = loadCliCommands();
  return { scripts, rootVerbs, verbToFlags };
}

test('every command named in docs/**, README.md and CONTRIBUTING.md exists', () => {
  const ctx = loadContext();
  const problems = [];
  for (const file of docTargets()) {
    const rel = path.relative(repoRoot, file);
    problems.push(...checkMarkdown(rel, readFileSync(file, 'utf8'), ctx));
  }
  assert.deepEqual(problems, []);
});

test('the checker rejects a planted bad npm script, node path, verb and flag', () => {
  const ctx = loadContext();
  const bad = [
    '```sh\nnpm run totally-not-a-script\n```',
    '```sh\nnode dist/cli/src/does-not-exist.js\n```',
    '`c2c teleport <file>`',
    '`c2c deploy --teleport`',
  ];
  for (const sample of bad) {
    const problems = checkMarkdown('fixture.md', sample, ctx);
    assert.ok(problems.length > 0, `expected a problem for: ${sample}`);
  }
});

test('the checker passes real commands and does not flag prose that merely mentions c2c', () => {
  const ctx = loadContext();
  const good = [
    '```sh\nnpm run build\nnode dist/cli/src/c2c.js deploy <ds> --project <id> --org <org> --confirm\n```',
    '`c2c smoke --confirm`',
    '`tools/matrix-check.mjs`',
    'the **c2c plugin** is the migration toolkit',
    'c2c never writes a token anywhere',
  ];
  for (const sample of good) {
    assert.deepEqual(checkMarkdown('fixture.md', sample, ctx), [], `expected no problem for: ${sample}`);
  }
});
