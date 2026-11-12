/** Every user-facing error fact must be reachable from troubleshooting. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FACTS_REL = 'plugin/references/facts/errors.md';
const SKILL_REL = 'plugin/skills/c2c-troubleshooting/SKILL.md';
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

function read(rel) {
  return readFileSync(path.join(repo, rel), 'utf8');
}

function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

function factHeadings(markdown) {
  return [...markdown.matchAll(/^### (.+)$/gm)].map((match) => match[1].trim());
}

function missingFactLinks(skill, headings) {
  const linked = new Set(
    [...skill.matchAll(LINK)]
      .map((match) => match[1])
      .filter((target) => target.startsWith('../../references/facts/errors.md#'))
      .map((target) => target.slice(target.indexOf('#') + 1)),
  );
  return headings.filter((heading) => !linked.has(slug(heading)));
}

test('every errors.md fact links from the troubleshooting skill', () => {
  const headings = factHeadings(read(FACTS_REL));
  assert.ok(headings.length > 0, `${FACTS_REL} has no ### fact headings`);
  assert.deepEqual(missingFactLinks(read(SKILL_REL), headings), []);
});

test('negative control: an unlinked fact is detected', () => {
  const headings = factHeadings(read(FACTS_REL));
  const skill = read(SKILL_REL);
  const first = headings[0];
  const link = `../../references/facts/errors.md#${slug(first)}`;
  const withoutFirstLink = skill.replace(link, '');
  assert.ok(
    missingFactLinks(withoutFirstLink, headings).includes(first),
    `removing the ${first} link should make parity fail`,
  );
});
