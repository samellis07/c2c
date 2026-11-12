import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../../shims/src/runtime.js';
import {
  buildCatalogue,
  cataloguePath,
  classifyTranslation,
  missingFromCatalogue,
  repoRoot,
} from '../src/catalogue.js';
import { recognisedBuiltinNames } from '../src/dispatch.js';
import { translate } from '../src/translate.js';

/** Identifiers compared in translate.ts that are not Deluge built-ins. */
const LITERAL_OK = new Set(['true', 'false', 'null', 'input', 'old', 'zoho', 'thisapp', 'row', 'REMOVE_ALL']);

test('committed catalogue lists every recognised built-in and matches the translator', () => {
  const committed = JSON.parse(readFileSync(cataloguePath(), 'utf8')) as ReturnType<typeof buildCatalogue>;
  const missing = missingFromCatalogue(recognisedBuiltinNames(), committed.entries);
  assert.deepEqual(missing, [], `recognised names missing from docs/deluge-builtins.json: ${missing.join(', ')}`);

  const built = buildCatalogue();
  assert.deepEqual(committed.counts, built.counts);
  assert.equal(committed.entries.length, built.entries.length);
  for (let i = 0; i < built.entries.length; i++) {
    assert.deepEqual(committed.entries[i], built.entries[i], `entry ${i} ${built.entries[i]?.name}`);
  }

  for (const entry of committed.entries) {
    const got = classifyTranslation(translate(entry.snippet), entry.name);
    assert.equal(got.status, entry.status, `${entry.name} :: ${entry.snippet}`);
    assert.equal(got.mapsTo, entry.mapsTo, `${entry.name} :: ${entry.snippet}`);
  }
});

test('a built-in the translator recognises but the catalogue omits fails the gate', () => {
  const committed = JSON.parse(readFileSync(cataloguePath(), 'utf8')) as { entries: { name: string }[] };
  const missing = missingFromCatalogue([...recognisedBuiltinNames(), 'brandNewBuiltin'], committed.entries);
  assert.deepEqual(missing, ['brandNewBuiltin']);
});

test('catalogue generator is byte-identical under LANG=da_DK.UTF-8', () => {
  const env = { ...process.env, LANG: 'da_DK.UTF-8', LC_ALL: 'da_DK.UTF-8' };
  const probe = spawnSync(process.execPath, ['-p', 'new Intl.Collator().resolvedOptions().locale'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), 'da-DK');

  const path = cataloguePath();
  const committed = readFileSync(path);
  const child = spawnSync(process.execPath, [join(repoRoot(), 'dist/deluge/scripts/builtins-catalogue.js')], {
    cwd: repoRoot(),
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(path).equals(committed), true);
  } finally {
    const now = readFileSync(path);
    if (!now.equals(committed)) writeFileSync(path, committed);
  }
});

/** A shimmed implementation whose whole body is one literal, or a todo call. */
function constantOrTodoBody(fn: unknown): string | null {
  if (typeof fn !== 'function') return null;
  let src: string;
  try {
    src = Function.prototype.toString.call(fn);
  } catch {
    return null;
  }
  if (src.includes('[native code]')) return null;
  if (/shim\.todo\s*\(/.test(src)) return 'shim.todo';
  const start = src.indexOf('{');
  const end = src.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const inner = src
    .slice(start + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '')
    .trim();
  const compact = inner.replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`/g, '""');
  const returned = compact.match(/^return\s+([\s\S]+?)\s*;?$/);
  if (!returned) return null;
  const expr = returned[1]!.trim().replace(/;$/, '');
  if (/^(?:true|false|null|undefined|[-+]?\d+(?:\.\d+)?|""|'')$/.test(expr)) return expr;
  return null;
}

function resolveShim(root: object, mapsTo: string): unknown {
  const parts = mapsTo.split('.').slice(1);
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null || (typeof cur !== 'object' && typeof cur !== 'function')) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

test('a shimmed built-in is not a constant body and does not call shim.todo', () => {
  const committed = JSON.parse(readFileSync(cataloguePath(), 'utf8')) as ReturnType<typeof buildCatalogue>;
  const shim = createRuntime({ dryRun: true, appTimeZone: 'UTC' }).shim;
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const entry of committed.entries) {
    if (entry.status !== 'shimmed') continue;
    const translated = [translate(entry.snippet).server, translate(entry.snippet).client].join('\n');
    if (/shim\.todo\s*\(/.test(translated)) bad.push(`${entry.name} :: ${entry.snippet} -> shim.todo`);
    if (!entry.mapsTo.startsWith('shim.') || seen.has(entry.mapsTo)) continue;
    seen.add(entry.mapsTo);
    const body = constantOrTodoBody(resolveShim(shim, entry.mapsTo));
    if (body !== null) bad.push(`${entry.mapsTo} (${entry.name}) body is ${body}`);
  }
  assert.deepEqual(bad, []);
});

test('a new method or name literal in translate.ts must be a recognised built-in', () => {
  const src = readFileSync(join(repoRoot(), 'packages/deluge/src/translate.ts'), 'utf8');
  const names = [...src.matchAll(/(?:method|name) === '([^']+)'/g)].map((m) => m[1]!);
  const known = new Set(recognisedBuiltinNames());
  const unknown = [...new Set(names)].filter((n) => !LITERAL_OK.has(n) && !known.has(n));
  assert.deepEqual(unknown, []);
});
