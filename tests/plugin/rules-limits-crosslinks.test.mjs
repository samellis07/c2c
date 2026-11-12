/**
 * Every limit row in plugin/references/limits.md carries a stable limit id
 * (`L-…`) and is cited by the skill whose verb can hit it: the skill names
 * the limit, states the c2c behaviour, and links to the row.
 *
 * The mapping lives in tests/limits-corpus/limit-skills.json (limit id ->
 * skill directory names). This test enforces it from in-repo sources only:
 * the limits file, the corpus, and the five SKILL.md files.
 *
 * Note: skill links use `../../references/limits.md#anchor`, which the
 * generic links test does not expand (it only strips one `../`), so this
 * file resolves those links itself: target must exist relative to the
 * skill directory and the anchor must match a heading in the target.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = path.join(repo, 'plugin');
const limitsRel = 'plugin/references/limits.md';
const skillsDir = path.join(plugin, 'skills');
const corpusFile = path.join(repo, 'tests/limits-corpus/limit-skills.json');

const SKILLS = [
  'c2c-schema-and-data',
  'c2c-provision-and-deploy',
  'c2c-logic',
  'c2c-ui',
  'c2c-integrations',
];

// Mirrors the hosted docs heading-anchor rule (same as links.test.mjs).
function anchorFor(heading) {
  return heading
    .replace(/\s+#+\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

function limitRows() {
  const md = readFileSync(path.join(repo, limitsRel), 'utf8');
  const rows = new Map();
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!match || match[1].length !== 3) continue;
    const id = /^(L-[A-Z0-9-]+):/.exec(match[2])?.[1];
    if (id) {
      assert.ok(!rows.has(id), `duplicate limit id: ${id}`);
      rows.set(id, anchorFor(match[2]));
    }
  }
  return rows;
}

function skillText(skill) {
  return readFileSync(path.join(skillsDir, skill, 'SKILL.md'), 'utf8');
}

function citedIds(text) {
  return new Set([...text.matchAll(/\b(L-[A-Z0-9-]+)\b/g)].map((m) => m[1]));
}

// Every `](…limits.md[#anchor])` link in text, resolved from `fromDir`.
function limitsLinks(text, fromDir) {
  const out = [];
  for (const m of text.matchAll(/\]\(([^)]*?references\/limits\.md(#[^)]*)?)\)/g)) {
    const raw = m[1];
    const hash = raw.indexOf('#');
    const target = hash < 0 ? raw : raw.slice(0, hash);
    const anchor = hash < 0 ? null : raw.slice(hash + 1);
    out.push({ raw, resolved: path.normalize(path.join(fromDir, target)), anchor });
  }
  return out;
}

function headingAnchors(markdown) {
  const anchors = new Set();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) anchors.add(anchorFor(match[2]));
  }
  return anchors;
}

test('corpus maps every limit row and nothing stale', () => {
  const rows = limitRows();
  assert.ok(rows.size >= 30, `expected at least 30 limit rows, got ${rows.size}`);
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
  assert.deepEqual(new Set(Object.keys(corpus)), new Set(rows.keys()));
  for (const [id, skills] of Object.entries(corpus)) {
    assert.ok(Array.isArray(skills) && skills.length >= 1, `${id} maps to no skill`);
    for (const skill of skills) {
      assert.ok(SKILLS.includes(skill), `${id} maps to out-of-scope skill ${skill}`);
      assert.ok(existsSync(path.join(skillsDir, skill, 'SKILL.md')), `missing skill dir ${skill}`);
    }
  }
  const covered = new Set(Object.values(corpus).flat());
  assert.deepEqual(covered, new Set(SKILLS), 'each of the five skills must own at least one limit');
});

test('each mapped skill names the limit and links to its row', () => {
  const rows = limitRows();
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'));
  const limitsPath = path.join(repo, limitsRel);
  const anchors = headingAnchors(readFileSync(limitsPath, 'utf8'));
  for (const [id, skills] of Object.entries(corpus)) {
    for (const skill of skills) {
      const text = skillText(skill);
      assert.ok(citedIds(text).has(id), `${skill} does not name ${id}`);
      const links = limitsLinks(text, path.join(skillsDir, skill)).filter((l) => l.anchor === rows.get(id));
      assert.ok(links.length >= 1, `${skill} does not link ${id} to its row`);
      for (const link of links) {
        assert.equal(link.resolved, limitsPath, `${skill}: ${id} link misses ${limitsRel}`);
        assert.ok(anchors.has(link.anchor), `${skill}: ${id} anchor #${link.anchor} matches no row`);
      }
    }
  }
});

test('no skill cites an unknown limit id and every limits link resolves', () => {
  const rows = limitRows();
  const limitsPath = path.join(repo, limitsRel);
  const anchors = headingAnchors(readFileSync(limitsPath, 'utf8'));
  for (const skill of SKILLS) {
    const text = skillText(skill);
    for (const id of citedIds(text)) {
      assert.ok(rows.has(id), `${skill} cites unknown limit id ${id}`);
    }
    const fromDir = path.join(skillsDir, skill);
    for (const link of limitsLinks(text, fromDir)) {
      assert.ok(existsSync(link.resolved), `${skill}: link target missing: ${link.raw}`);
      if (link.anchor) assert.ok(anchors.has(link.anchor), `${skill}: broken row anchor #${link.anchor}`);
    }
  }
  const indexText = readFileSync(limitsPath, 'utf8');
  for (const m of indexText.matchAll(/\]\((#[^)]+)\)/g)) {
    assert.ok(anchors.has(m[1].slice(1)), `limits index links a missing row: ${m[1]}`);
  }
});
