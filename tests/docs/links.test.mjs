/**
 * Public docs relative references. Every relative markdown link target in
 * docs/**, README.md, CONTRIBUTING.md, SECURITY.md and CODE_OF_CONDUCT.md
 * must resolve to a file that exists (relative to the linking file), and
 * every `#anchor` on a link must match a heading in the linked file (or, for
 * a same-file anchor, in the linking file itself). External http(s)/mailto
 * links are never fetched or checked.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ROOTS = ['docs', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md'];

const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

// Mirrors tests/plugin/links.test.mjs's anchor rule: lowercase, drop
// punctuation except - and _, then turn every remaining space into a hyphen.
function anchorFor(heading) {
  return heading
    .replace(/\s+#+\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

function headingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!match) continue;
    let slug = anchorFor(match[2]);
    const seen = counts.get(slug) ?? 0;
    counts.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen}`;
    anchors.add(slug);
  }
  return anchors;
}

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

function* docFiles() {
  for (const root of ROOTS) {
    const full = path.join(repo, root);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) yield* markdownFiles(full);
    else yield full;
  }
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
  const broken = [];
  const anchorCache = new Map();
  for (const file of docFiles()) {
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
      if (!target.endsWith('.md')) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) continue; // reported by the existence test

      let anchors = anchorCache.get(resolved);
      if (!anchors) {
        anchors = headingAnchors(readFileSync(resolved, 'utf8'));
        anchorCache.set(resolved, anchors);
      }
      if (!anchors.has(anchor)) broken.push(`${rel}: ${raw}`);
    }
  }
  assert.deepEqual(broken, []);
});
