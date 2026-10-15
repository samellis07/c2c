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
import { headingAnchors } from '../helpers/heading-anchors.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = path.join(repo, 'plugin');

const BACKTICK = /`((?:references|templates|skills|commands|bin|hooks|evals)\/[A-Za-z0-9_./-]+)`/g;
const LINK = /\]\((?:\.\.\/|\.\/)?((?:references|facts|templates|skills|commands|bin|hooks|evals)\/[A-Za-z0-9_./#-]+)\)/g;

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

// An installed plugin ships only plugin/, so a relative markdown link that
// resolves outside it is dead for plugin users.
const RELATIVE_LINK = /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;

export function linksEscapingRoot(file, text, root) {
  const escaping = [];
  for (const match of text.matchAll(RELATIVE_LINK)) {
    const target = match[1].split('#')[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(file), target);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) escaping.push(target);
  }
  return escaping;
}

test('no plugin markdown link resolves outside the plugin root', () => {
  const escaping = [];
  for (const file of markdownFiles(plugin)) {
    const rel = path.relative(repo, file);
    for (const target of linksEscapingRoot(file, readFileSync(file, 'utf8'), plugin)) escaping.push(`${rel}: ${target}`);
  }
  assert.deepEqual(escaping, []);
});

test('the plugin-root link guard flags a link into the repo docs', () => {
  const skill = path.join(plugin, 'skills', 'c2c-ui', 'SKILL.md');
  assert.deepEqual(linksEscapingRoot(skill, 'See [repair](../../../docs/report-filters.md).', plugin), ['../../../docs/report-filters.md']);
  assert.deepEqual(linksEscapingRoot(skill, 'See [repair](references/report-filters.md#repair-procedure) and [limits](../../references/limits.md).', plugin), []);
});
