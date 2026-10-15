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

/**
 * Generous bound for every spawned child. The children are cheap, but a
 * loaded CI runner can take tens of seconds just to spawn Node; a tight
 * timeout turns load into a flaky kill. The budget is shared with the
 * matrix runs below, which are the expensive children.
 */
const CHILD_TIMEOUT = 180_000;

/** Child env scrubbed of repo selectors, with the matrix cell applied. */
function childEnv(tz: string, lang: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'C2C_GALLERY_DIR']) delete env[key];
  env.TZ = tz;
  env.LANG = lang;
  env.LC_ALL = lang;
  return env;
}

/** Spawn a child and assert it exited 0, reporting kill signal and output on failure. */
function runChild(args: string[], tz: string, lang: string, cwd: string): string {
  const child = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd,
    env: childEnv(tz, lang),
    maxBuffer: 64 * 1024 * 1024,
    timeout: CHILD_TIMEOUT,
  });
  assert.equal(
    child.status,
    0,
    `child failed: status=${child.status} signal=${child.signal} error=${child.error?.message ?? 'none'}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
  return child.stdout;
}

function genOnce(target: string, tz: string, lang: string, cwd: string): string {
  return runChild([gallery, '--once', target], tz, lang, cwd);
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

/** What a child sees under a matrix cell: default locale, local hour of epoch 0, a localeCompare sort, supported ICU candidates. */
function probe(tz: string, lang: string): { locale: string; hour: number; sorted: string; supported: string[] } {
  const stdout = runChild(
    [
      '-e',
      "process.stdout.write(JSON.stringify({ locale: Intl.DateTimeFormat().resolvedOptions().locale, hour: new Date(0).getHours(), sorted: ['z', 'aa', 'b', 'A', 'a', 'B'].sort((x, y) => x.localeCompare(y)).join(), supported: Intl.Collator.supportedLocalesOf(['da', 'sv', 'de-u-co-phonebk', 'tr', 'es', 'en'], { localeMatcher: 'lookup' }) }))",
    ],
    tz,
    lang,
    root,
  );
  return JSON.parse(stdout) as { locale: string; hour: number; sorted: string; supported: string[] };
}

test('positive control: environment reaches child and available ICU locale changes collation', () => {
  // Each spawned child is expensive on a loaded box, so one probe child
  // answers every question its env cell can: the base cell also lists the
  // supported ICU candidates, and the two remaining cells each verify a
  // foreign TZ and a foreign LANG together.
  const base = probe('UTC', 'C');
  const distinct = base.supported.find((locale) => {
    const sorted = ['z', 'aa', 'b', 'A', 'a', 'B'].sort(new Intl.Collator(locale).compare).join(',');
    return sorted !== base.sorted;
  });
  assert.ok(distinct, `no supported ICU locale changes collation from root; supported candidates: ${base.supported.join(', ') || '(none)'}`);
  const localeProbe = probe('UTC', distinct);
  const kolkata = probe('Asia/Kolkata', 'de_DE.UTF-8');
  const losAngeles = probe('America/Los_Angeles', 'en_US.UTF-8');
  assert.equal(base.hour, 0, 'TZ=UTC did not reach the child');
  assert.equal(kolkata.hour, 5, 'TZ=Asia/Kolkata did not reach the child');
  assert.equal(losAngeles.hour, 16, 'TZ=America/Los_Angeles did not reach the child');
  assert.ok(kolkata.locale.startsWith('de'), 'LANG=de_DE.UTF-8 did not reach the child');
  assert.ok(losAngeles.locale.startsWith('en'), 'LANG=en_US.UTF-8 did not reach the child');
  assert.notEqual(localeProbe.sorted, base.sorted, `${distinct} collation did not change a localeCompare sort`);
});

for (const name of FIXTURES) {
  test(`${name} regenerates byte-identical output across TZ, LANG, cwd, and output paths`, () => {
    const target = join(root, 'fixtures/redistributable', name);
    const baseline = genOnce(target, 'UTC', 'C', root);
    // The combined foreign-cell run below already covers Asia/Kolkata and
    // da_DK.UTF-8, so the single-axis loops skip them rather than pay for
    // duplicate generator runs.
    for (const tz of TZS) {
      if (tz === 'UTC' || tz === 'Asia/Kolkata') continue;
      assert.equal(genOnce(target, tz, 'C', root), baseline, `TZ=${tz} changed the generated tree`);
    }
    for (const lang of LANGS) {
      if (lang === 'C' || lang === 'da_DK.UTF-8') continue;
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
        runChild([gallery, '--write', target, out], TZS[i]!, LANGS[(i + 1) % LANGS.length]!, i === 0 ? root : tmpdir());
        listings.push(hashTree(out));
      }
      assert.equal(listings[1], listings[0], 'different absolute output paths changed the written bytes');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
