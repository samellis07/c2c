/**
 * Public docs relative references. Every relative markdown link target in
 * docs/**, README.md, CONTRIBUTING.md, SECURITY.md and CODE_OF_CONDUCT.md
 * must resolve to a file that exists (relative to the linking file).
 *
 * Anchor contract: a same-file `#anchor` must match a heading in the linking
 * file itself. A `#fragment` on a `.md` link target must match a heading
 * slug in the linked file. A `#fragment` on any other (non-markdown) target
 * FAILS, unless it matches the line-anchor allowlist below: `L<line>` or
 * `L<start>-L<end>` source-viewer line anchors (e.g. `helper.js#L10`,
 * `helper.js#L10-L20`). External http(s)/mailto links are never fetched or
 * checked.
 */
import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { headingAnchors } from '../helpers/heading-anchors.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ROOTS = ['docs', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'];

const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// Allowlist for fragments on non-markdown targets: source-viewer line
// anchors only. Anything else on a non-.md target is reported as broken.
const LINE_ANCHOR = /^L\d+(-L\d+)?$/;

function isExternal(target) {
  return /^([a-z][a-z0-9+.-]*:)/i.test(target);
}

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(child);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield child;
  }
}

function* docFiles(base = repo) {
  for (const root of ROOTS) {
    const full = path.join(base, root);
    // The directory read is the classification — a stat before the walk
    // would race a swap of the root between the two. Only the root's own
    // read is mapped: an error inside the walk still throws.
    let isDirectory;
    try {
      readdirSync(full);
      isDirectory = true;
    } catch (err) {
      const code = err?.code;
      if (code === 'ENOENT' || code === 'ELOOP') continue;
      if (code !== 'ENOTDIR') throw err;
      isDirectory = false;
    }
    if (isDirectory) yield* markdownFiles(full);
    else yield full;
  }
}

function findBrokenAnchors(files) {
  const broken = [];
  const anchorCache = new Map();
  for (const file of files) {
    const rel = path.relative(repo, file);
    const text = readFileSync(file, 'utf8');
    const ownAnchors = headingAnchors(text);
    for (const match of text.matchAll(LINK)) {
      const raw = match[1];
      if (isExternal(raw)) continue;
      const hash = raw.indexOf('#');
      if (hash < 0) continue;
      const target = raw.slice(0, hash);
      const anchor = raw.slice(hash + 1);
      if (!anchor) continue;

      if (!target) {
        if (!ownAnchors.has(anchor)) broken.push(`${rel}: ${raw}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), target);
      // One open per target: a missing target is reported by the existence
      // test, so skip it here rather than stat-then-read. O_NONBLOCK keeps a
      // FIFO target from blocking the open.
      let fd = null;
      try {
        fd = openSync(resolved, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (err) {
        const code = err?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') continue;
        // A target that exists but cannot be opened still needs no read
        // when it is not markdown; a markdown one fails as its read would.
        if (target.endsWith('.md')) throw err;
      }
      try {
        if (!target.endsWith('.md')) {
          // Non-markdown targets have no headings: only allowlisted line
          // anchors pass; any other fragment is broken.
          if (!LINE_ANCHOR.test(anchor)) broken.push(`${rel}: ${raw}`);
          continue;
        }

        let anchors = anchorCache.get(resolved);
        if (!anchors) {
          anchors = headingAnchors(readFileSync(fd, 'utf8'));
          anchorCache.set(resolved, anchors);
        }
        if (!anchors.has(anchor)) broken.push(`${rel}: ${raw}`);
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
  }
  return broken;
}

test('every relative link target in the public docs exists', () => {
  const missing = [];
  for (const file of docFiles()) {
    const rel = path.relative(repo, file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(LINK)) {
      const raw = match[1];
      if (isExternal(raw)) continue;
      const hash = raw.indexOf('#');
      const target = hash < 0 ? raw : raw.slice(0, hash);
      if (!target) continue; // same-file anchor, checked separately
      const resolved = path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) missing.push(`${rel}: ${raw}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every #anchor on a public-docs link matches a heading', () => {
  assert.deepEqual(findBrokenAnchors(docFiles()), []);
});

test('anchor rules catch bad .md anchors and non-md fragments, allow line anchors', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-links-'));
  try {
    const readmeTarget = path.relative(dir, path.join(repo, 'README.md'));
    writeFileSync(path.join(dir, 'target.md'), '# Real Heading\n');
    writeFileSync(path.join(dir, 'helper.js'), 'export const x = 1;\n');
    const probe = path.join(dir, 'probe.md');
    writeFileSync(
      probe,
      [
        `[bad heading anchor](${readmeTarget}#definitely-not-a-real-heading)`,
        '[non-md fragment](helper.js#some-fragment)',
        '[line anchor](helper.js#L10)',
        '[line range anchor](helper.js#L10-L20)',
        '[valid heading anchor](target.md#real-heading)',
        '',
      ].join('\n'),
    );
    const broken = findBrokenAnchors([probe]);
    assert.ok(
      broken.some((entry) => entry.includes('#definitely-not-a-real-heading')),
      `bad README.md anchor must be reported, got: ${JSON.stringify(broken)}`,
    );
    assert.ok(
      broken.some((entry) => entry.includes('helper.js#some-fragment')),
      `non-md fragment must be reported, got: ${JSON.stringify(broken)}`,
    );
    for (const good of ['helper.js#L10', 'helper.js#L10-L20', 'target.md#real-heading']) {
      assert.ok(
        !broken.some((entry) => entry.endsWith(good)),
        `expected ${good} to pass, got: ${JSON.stringify(broken)}`,
      );
    }
    assert.equal(broken.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docFiles: a missing root is skipped, a file root is listed, a directory root is walked', (t) => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'docs-roots-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.deepEqual([...docFiles(base)], []);
  writeFileSync(path.join(base, 'README.md'), '# Readme\n');
  mkdirSync(path.join(base, 'docs/sub'), { recursive: true });
  writeFileSync(path.join(base, 'docs/sub/page.md'), '# Page\n');
  writeFileSync(path.join(base, 'docs/notes.txt'), 'not markdown\n');
  assert.deepEqual([...docFiles(base)].map((file) => path.relative(base, file)).sort(), ['README.md', 'docs/sub/page.md']);
  // A root that is a directory named like a file is walked like any directory.
  mkdirSync(path.join(base, 'SECURITY.md'));
  writeFileSync(path.join(base, 'SECURITY.md/inner.md'), '# Inner\n');
  assert.ok([...docFiles(base)].includes(path.join(base, 'SECURITY.md/inner.md')));
});

test('findBrokenAnchors: a missing target is skipped, a directory .md target throws, a FIFO is never waited on', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docs-targets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = path.join(dir, 'probe.md');
  writeFileSync(probe, '[gone](missing.md#x)\n[gone file](missing.js#x)\n[under a file](probe.md/inner.md#x)\n');
  assert.deepEqual(findBrokenAnchors([probe]), []);

  execFileSync('mkfifo', [path.join(dir, 'pipe.js'), path.join(dir, 'pipe.md')]);
  writeFileSync(probe, '[pipe](pipe.js#L1)\n[pipe fragment](pipe.js#frag)\n[pipe md](pipe.md#x)\n');
  assert.deepEqual(findBrokenAnchors([probe]), ['probe.md: pipe.js#frag', 'probe.md: pipe.md#x'].map((entry) => `${path.relative(repo, dir)}/${entry}`));

  mkdirSync(path.join(dir, 'folder.md'));
  writeFileSync(probe, '[folder](folder.md#x)\n');
  assert.throws(() => findBrokenAnchors([probe]), { code: 'EISDIR' });
  mkdirSync(path.join(dir, 'folder.js'));
  writeFileSync(probe, '[folder](folder.js#L2)\n[folder fragment](folder.js#frag)\n');
  assert.deepEqual(findBrokenAnchors([probe]), [`${path.relative(repo, dir)}/probe.md: folder.js#frag`]);
});
