/**
 * Plugin relative references. Every `references/…`, `templates/…`, `skills/…`,
 * `commands/…`, `bin/…`, `hooks/…` or `evals/…` path a plugin document names in
 * backticks or as a markdown link target must exist — resolved from the plugin
 * root, or relative to the file that names it. Patterns that contain a glob
 * star (AGENTS.md names two) are skipped. `facts/…` link targets are covered
 * too, and every `#anchor` on a markdown link must match a heading in the
 * linked file.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = path.join(repo, 'plugin');

const BACKTICK = /`((?:references|templates|skills|commands|bin|hooks|evals)\/[A-Za-z0-9_./-]+)`/g;
const LINK = /\]\((?:\.\.\/|\.\/)?((?:references|facts|templates|skills|commands|bin|hooks|evals)\/[A-Za-z0-9_./#-]+)\)/g;

// Mirrors the hosted docs heading-anchor rule: lowercase, drop punctuation
// except - and _, then turn every remaining space into a hyphen.
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

function resolveTarget(fromFile, target) {
  if (existsSync(path.join(plugin, target))) return path.join(plugin, target);
  const sibling = path.join(path.dirname(fromFile), target);
  if (existsSync(sibling)) return sibling;
  return null;
}

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(child);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield child;
  }
}

test('every plugin-relative path named in a plugin document exists', () => {
  const missing = [];
  for (const file of markdownFiles(plugin)) {
    const rel = path.relative(repo, file);
    const text = readFileSync(file, 'utf8');
    const seen = new Set();
    for (const pattern of [BACKTICK, LINK]) {
      for (const match of text.matchAll(pattern)) {
        const target = match[1].split('#')[0].replace(/\/+$/, '');
        if (!target || target.includes('*') || seen.has(target)) continue;
        seen.add(target);
        if (resolveTarget(file, target)) continue;
        missing.push(`${rel}: ${target}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('every #anchor on a plugin-relative markdown link matches a heading', () => {
  const broken = [];
  const anchorCache = new Map();
  for (const file of markdownFiles(plugin)) {
    const rel = path.relative(repo, file);
    const text = readFileSync(file, 'utf8');
    const seen = new Set();
    for (const match of text.matchAll(LINK)) {
      const raw = match[1];
      const hash = raw.indexOf('#');
      if (hash < 0) continue;
      const target = raw.slice(0, hash).replace(/\/+$/, '');
      const anchor = raw.slice(hash + 1);
      if (!target || !target.endsWith('.md') || !anchor || seen.has(raw)) continue;
      seen.add(raw);
      const resolved = resolveTarget(file, target);
      if (!resolved) continue;
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
