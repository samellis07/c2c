import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexPath = path.join(repo, 'plugin/references/error-index.md');
const skillPath = path.join(repo, 'plugin/skills/c2c-troubleshooting/SKILL.md');
const anchor = (heading) => heading.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');
const sections = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const anchors = (text) => [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => anchor(m[1]));

test('every public error-index section is routed from troubleshooting', () => {
  const index = readFileSync(indexPath, 'utf8');
  const skill = readFileSync(skillPath, 'utf8');
  const routes = skill.split(/^## Error family routing$/m)[1] ?? '';
  const missing = sections(index).filter((title) => !routes.includes(`#${anchor(title)}`));
  assert.deepEqual(missing, []);
});

test('removing a public error route fails the routing check', () => {
  const index = readFileSync(indexPath, 'utf8');
  const skill = readFileSync(skillPath, 'utf8');
  const routes = skill.split(/^## Error family routing$/m)[1] ?? '';
  const expected = sections(index).map((title) => `#${anchor(title)}`);
  const mutated = routes.replace(/\[[^\]]+\]\(\.\.\/\.\.\/references\/error-index\.md#[^)]+\)/, '');
  assert.notEqual(mutated, routes);
  assert.ok(expected.some((link) => routes.includes(link) && !mutated.includes(link)));
});

test('all links in the troubleshooting skill resolve to public files and headings', () => {
  const skill = readFileSync(skillPath, 'utf8');
  const broken = [];
  for (const [, target] of skill.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [relative, fragment] = target.split('#');
    const resolved = path.resolve(path.dirname(skillPath), relative);
    if (!existsSync(resolved)) { broken.push(target); continue; }
    if (fragment && resolved.endsWith('.md')) {
      const markdown = readFileSync(resolved, 'utf8');
      if (!anchors(markdown).includes(fragment)) broken.push(target);
    }
  }
  assert.deepEqual(broken, []);
});
