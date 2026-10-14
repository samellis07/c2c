import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';

/**
 * Generation must not depend on the ambient environment: the same fixture
 * regenerates byte-identical output under different time zones, locales,
 * parent working directories, and absolute output paths. Every generation
 * below runs in a spawned child process so the parent's own TZ/LANG/cwd
 * cannot mask a leak. The positive control probes installed ICU locales and
 * requires one to change collation from the root locale, so this axis cannot
 * silently become vacuous on a small-ICU Node build. de_DE catches locale
 * number/date formatting; Asia/Kolkata catches local-time reads.
 */
const root = repoRoot();
const gallery = join(root, 'dist/determinism/src/gallery.js');
const FIXTURES = ['freight-forwarding', 'library-application-system'];
const TZS = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'];
const LANGS = ['C', 'en_US.UTF-8', 'de_DE.UTF-8', 'da_DK.UTF-8'];

/** Child env scrubbed of repo selectors, with the matrix cell applied. */
function childEnv(tz: string, lang: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'C2C_GALLERY_DIR']) delete env[key];
  env.TZ = tz;
  env.LANG = lang;
  env.LC_ALL = lang;
  return env;
}

function genOnce(target: string, tz: string, lang: string, cwd: string): string {
  const child = spawnSync(process.execPath, [gallery, '--once', target], {
    encoding: 'utf8',
    cwd,
    env: childEnv(tz, lang),
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return child.stdout;
}

/** "<sha256>  <relative-path>" per file, sorted bytewise — the gate's form. */
function hashTree(base: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${relative(base, path)}`);
    }
  };
  walk(base);
  out.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0));
  return out.join('\n') + '\n';
}

/** What a child sees under a matrix cell: default locale, local hour of epoch 0, a localeCompare sort. */
function probe(tz: string, lang: string): { locale: string; hour: number; sorted: string } {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      "process.stdout.write(JSON.stringify({ locale: Intl.DateTimeFormat().resolvedOptions().locale, hour: new Date(0).getHours(), sorted: ['z', 'aa', 'b', 'A', 'a', 'B'].sort((x, y) => x.localeCompare(y)).join() }))",
    ],
    { encoding: 'utf8', cwd: root, env: childEnv(tz, lang), timeout: 30_000 },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout) as { locale: string; hour: number; sorted: string };
}

test('positive control: environment reaches child and available ICU locale changes collation', () => {
  const base = probe('UTC', 'C');
  const available = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(Intl.Collator.supportedLocalesOf(['da', 'sv', 'de-u-co-phonebk', 'tr', 'es', 'en'], { localeMatcher: 'lookup' })))"], {
    encoding: 'utf8', cwd: root, env: childEnv('UTC', 'C'), timeout: 30_000,
  });
  assert.equal(available.status, 0, available.stderr || available.stdout);
  const locales = JSON.parse(available.stdout) as string[];
  const distinct = locales.find((locale) => {
    const sorted = ['z', 'aa', 'b', 'A', 'a', 'B'].sort(new Intl.Collator(locale).compare).join(',');
    return sorted !== base.sorted;
  });
  assert.ok(distinct, `no supported ICU locale changes collation from root; supported candidates: ${locales.join(', ') || '(none)'}`);
  const localeProbe = probe('UTC', distinct);
  assert.equal(base.hour, 0, 'TZ=UTC did not reach the child');
  assert.equal(probe('Asia/Kolkata', 'C').hour, 5, 'TZ=Asia/Kolkata did not reach the child');
  assert.equal(probe('America/Los_Angeles', 'C').hour, 16, 'TZ=America/Los_Angeles did not reach the child');
  assert.ok(probe('UTC', 'de_DE.UTF-8').locale.startsWith('de'), 'LANG=de_DE.UTF-8 did not reach the child');
  assert.ok(probe('UTC', 'en_US.UTF-8').locale.startsWith('en'), 'LANG=en_US.UTF-8 did not reach the child');
  assert.notEqual(localeProbe.sorted, base.sorted, `${distinct} collation did not change a localeCompare sort`);
});

for (const name of FIXTURES) {
  test(`${name} regenerates byte-identical output across TZ, LANG, cwd, and output paths`, () => {
    const target = join(root, 'fixtures/redistributable', name);
    const baseline = genOnce(target, 'UTC', 'C', root);
    for (const tz of TZS) {
      if (tz === 'UTC') continue;
      assert.equal(genOnce(target, tz, 'C', root), baseline, `TZ=${tz} changed the generated tree`);
    }
    for (const lang of LANGS) {
      if (lang === 'C') continue;
      assert.equal(genOnce(target, 'UTC', lang, root), baseline, `LANG=${lang} changed the generated tree`);
    }
    const farCwd = mkdtempSync(join(tmpdir(), 'c2c-env-cwd-'));
    try {
      assert.equal(
        genOnce(target, 'Asia/Kolkata', 'da_DK.UTF-8', farCwd),
        baseline,
        'a foreign TZ, LANG, and cwd together changed the generated tree',
      );
    } finally {
      rmSync(farCwd, { recursive: true, force: true });
    }
    const work = mkdtempSync(join(tmpdir(), 'c2c-env-out-'));
    try {
      const listings: string[] = [];
      for (let i = 0; i < 2; i++) {
        const out = join(work, `run-${i}`, 'nested out dir', 'tree');
        const child = spawnSync(process.execPath, [gallery, '--write', target, out], {
          encoding: 'utf8',
          cwd: i === 0 ? root : tmpdir(),
          env: childEnv(TZS[i]!, LANGS[(i + 1) % LANGS.length]!),
          timeout: 120_000,
        });
        assert.equal(child.status, 0, child.stderr || child.stdout);
        listings.push(hashTree(out));
      }
      assert.equal(listings[1], listings[0], 'different absolute output paths changed the written bytes');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
