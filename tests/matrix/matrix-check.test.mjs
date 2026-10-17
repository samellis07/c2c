import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LADDER, REQUIRED_EVIDENCE, accountTap, checkMatrix } from '../../tools/matrix-check.mjs';
import { checkCites, extractCites } from '../../packages/cli/scripts/check-matrix-citations.mjs';
import {
  MIN_INTERVAL_MS,
  crawlHelpSitemap,
  parseRobots,
  pathAllowed,
  sectionIdFor,
  sitemapLocs,
} from '../../tools/fetch-help-sitemap.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = path.join(repoRoot, 'docs/feature-matrix/schema.json');
const checkScript = path.join(repoRoot, 'tools/matrix-check.mjs');
const fetchScript = path.join(repoRoot, 'tools/fetch-help-sitemap.mjs');
const CATALYST_PROJECT_ID = '12345678901234567';
const DS_REL = 'tests/matrix/fixtures/builtin-app.ds';
const MIGRATION_REL = 'tests/matrix/fixtures/migration-record.json';
const PASSING_REL = 'tests/matrix/fixtures/passing.test.mjs';
const PASSING_TEST_ID = `${PASSING_REL}#matrix fixture passes`;

function git(args) {
  const res = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return (res.stdout || '').trim();
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function manifestFor(rowIds, { complete = true, extra = [] } = {}) {
  return {
    version: 1,
    source: 'fixture',
    fetchedAt: '2026-10-06T00:00:00.000Z',
    complete,
    minIntervalMs: MIN_INTERVAL_MS,
    robotsRespected: true,
    sections: [
      {
        id: 'fixture',
        url: 'https://example.test/help/fixture',
        title: 'Fixture',
        count: 1,
        rowIds,
      },
      ...extra,
    ],
  };
}

const REPO_SLUG = 'example-org/creator-to-catalyst';
const FIXTURE_ORIGIN = `https://github.com/${REPO_SLUG}.git`;

class FixtureSkipped extends Error {
  constructor(message) {
    super(message);
    this.skip = true;
  }
}

function fixtureGitEnv(repo) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-git-home-'));
  const gitconfig = path.join(home, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
  const gitDir = path.join(repo, '.git');
  return {
    gitDir,
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitconfig,
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_DIR: gitDir,
      GIT_WORK_TREE: repo,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'c2c-test',
      GIT_AUTHOR_EMAIL: 'c2c-test@example.test',
      GIT_COMMITTER_NAME: 'c2c-test',
      GIT_COMMITTER_EMAIL: 'c2c-test@example.test',
    },
  };
}

function fixtureGit(repo, args, env) {
  const gitDir = path.join(repo, '.git');
  return spawnSync('git', [
    '-c', 'user.name=c2c-test',
    '-c', 'user.email=c2c-test@example.test',
    '-c', 'commit.gpgsign=false',
    '--git-dir', gitDir,
    '--work-tree', repo,
    ...args,
  ], {
    encoding: 'utf8',
    env,
    cwd: repo,
  });
}

function guardRefused(res) {
  return res.status !== 0 && /git-guard/.test(res.stderr || '');
}

function fixtureOrThrow(repo, args, env, label) {
  const res = fixtureGit(repo, args, env);
  if (res.status === 0) return res;
  const detail = `${(res.stderr || '').trim()}\n${(res.stdout || '').trim()}`.trim();
  if (guardRefused(res)) {
    throw new FixtureSkipped(`git guard refused fixture ${label}: ${detail}`);
  }
  throw new Error(`fixture ${label} failed: ${detail}`);
}

function deleteLooseRef(gitDir, ref) {
  const parts = ref.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`bad ref ${ref}`);
  }
  const file = path.resolve(gitDir, ...parts);
  const root = path.resolve(gitDir);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new Error(`ref ${ref} escaped the fixture git dir`);
  }
  fs.rmSync(file, { force: true });
}

function makeRepo(files, t) {
  try {
    return buildFixtureRepo(files);
  } catch (error) {
    if (error.skip && t) {
      t.skip(error.message);
      return null;
    }
    throw error;
  }
}

function buildFixtureRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-repo-'));
  const { env, gitDir } = fixtureGitEnv(repo);
  const resolvedGit = path.resolve(gitDir);
  const resolvedRepo = path.resolve(repo);
  if (!resolvedGit.startsWith(`${resolvedRepo}${path.sep}`)) {
    throw new Error(`refusing git dir outside the fixture repo: ${gitDir}`);
  }
  let init = fixtureGit(repo, ['init', '-b', 'main'], env);
  if (init.status !== 0) init = fixtureGit(repo, ['init'], env);
  if (init.status !== 0) {
    const detail = (init.stderr || init.stdout || '').trim();
    if (guardRefused(init)) throw new FixtureSkipped(`git guard refused fixture init: ${detail}`);
    throw new Error(`fixture init failed: ${detail}`);
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  fixtureOrThrow(repo, ['add', '-A'], env, 'add');
  const tree = fixtureOrThrow(repo, ['write-tree'], env, 'write-tree');
  const treeSha = (tree.stdout || '').trim();
  const commit = fixtureOrThrow(repo, ['commit-tree', treeSha, '-m', 'evidence'], env, 'commit-tree');
  const sha = (commit.stdout || '').trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`fixture commit-tree did not print a sha (${sha})`);
  }
  const updated = fixtureGit(repo, ['update-ref', 'refs/heads/main', sha], env);
  if (updated.status !== 0) {
    if (!guardRefused(updated)) {
      throw new Error(`fixture update-ref failed: ${(updated.stderr || '').trim()}`);
    }
    // The git guard refuses refs/heads/* even in a temp repo. The loose ref
    // is written only under this fixture GIT_DIR, never the product clone.
    const refFile = path.resolve(gitDir, 'refs', 'heads', 'main');
    if (!refFile.startsWith(`${path.resolve(gitDir)}${path.sep}`)) {
      throw new Error('refusing to write a main ref outside the fixture git dir');
    }
    fs.mkdirSync(path.dirname(refFile), { recursive: true });
    fs.writeFileSync(refFile, `${sha}\n`);
  }
  const configPath = path.join(gitDir, 'config');
  const config = readFixtureConfig(configPath);
  if (!config.includes('[remote "origin"]')) {
    fs.appendFileSync(configPath, `\n[remote "origin"]\n\turl = ${FIXTURE_ORIGIN}\n`);
  }
  const resolved = fixtureOrThrow(repo, ['rev-parse', '--verify', 'main'], env, 'rev-parse main');
  if ((resolved.stdout || '').trim() !== sha) {
    throw new Error(`fixture main ref ${resolved.stdout.trim()} != ${sha}`);
  }
  return { repo, sha, env, gitDir };
}

/** The fixture git config text, '' when it is missing; a directory still throws EISDIR. */
function readFixtureConfig(configPath) {
  try {
    return fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR' && err?.code !== 'ELOOP') throw err;
    return '';
  }
}

test('readFixtureConfig: missing config is empty, a directory throws, a file is read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-config-'));
  try {
    assert.equal(readFixtureConfig(path.join(dir, 'config')), '');
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    assert.equal(readFixtureConfig(path.join(dir, 'file', 'config')), '');
    fs.mkdirSync(path.join(dir, 'config'));
    assert.throws(() => readFixtureConfig(path.join(dir, 'config')), { code: 'EISDIR' });
    fs.writeFileSync(path.join(dir, 'real'), '[core]\n');
    assert.equal(readFixtureConfig(path.join(dir, 'real')), '[core]\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureBytes(rel) {
  return fs.readFileSync(path.join(repoRoot, rel));
}

function evidenceTree(extra = {}) {
  return {
    'package.json': '{"type":"module"}\n',
    [DS_REL]: fixtureBytes(DS_REL),
    [MIGRATION_REL]: fixtureBytes(MIGRATION_REL),
    [PASSING_REL]: fixtureBytes(PASSING_REL),
    ...extra,
  };
}

const TS_TEST_CONFIG = `${JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: false,
    skipLibCheck: true,
    outDir: 'dist',
    rootDir: 'packages',
    types: ['node'],
  },
  include: ['packages/*/test/**/*.ts'],
}, null, 2)}\n`;

const HOSTILE_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "const fake = [",
  "  'TAP version 13',",
  "  '# Subtest: hostile cannot spoof the tap file',",
  "  'ok 1 - hostile cannot spoof the tap file',",
  "  '1..1',",
  "  '# tests 1',",
  "  '# suites 0',",
  "  '# pass 1',",
  "  '# fail 0',",
  "  '# cancelled 0',",
  "  '# skipped 0',",
  "  '# todo 0',",
  "  '',",
  "].join('\\n');",
  "test('hostile cannot spoof the tap file', () => {",
  "  for (const name of fs.readdirSync(os.tmpdir())) {",
  "    if (!name.startsWith('matrix-tap-') || !name.endsWith('.tap')) continue;",
  "    fs.writeFileSync(path.join(os.tmpdir(), name), fake);",
  "  }",
  "  assert.equal(1, 2);",
  "});",
  '',
].join('\n');

// Every evidence-check test inspects committed content, never the working
// tree, so they share one fixture repo at one sha instead of each rebuilding
// the same repo and re-extracting the same tree.
const SHARED_FILES = evidenceTree({
  'tsconfig.json': TS_TEST_CONFIG,
  'packages/demo/test/demo.test.ts': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('counts', () => { assert.equal(1, 2); });",
    '',
  ].join('\n'),
  'dist/demo/test/demo.test.js': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('counts', () => { assert.equal(1, 1); });",
    '',
  ].join('\n'),
  't/exact.test.mjs': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('adds numbers', () => { assert.equal(1 + 1, 2); });",
    "test('same', () => {});",
    "test('same', () => {});",
    "test('skipped proof', { skip: true }, () => {});",
    '',
  ].join('\n'),
  't/fake.test.mjs': [
    "console.log('# tests 1');",
    "console.log('# pass 1');",
    "console.log('# fail 0');",
    "console.log('ok 1 - fake pass');",
    '',
  ].join('\n'),
  't/hostile.test.mjs': HOSTILE_TEST,
  't/dirty.test.mjs': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('adds numbers', () => { assert.equal(1, 2); });",
    '',
  ].join('\n'),
  't/fail.test.mjs': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('fails hard', () => { assert.equal(1, 2); });",
    '',
  ].join('\n'),
});

// In-process checks share extracted trees and suite runs through sharedRuns,
// so each commit's evidence is built and run once for the whole file.
const sharedRuns = { trees: new Map(), suites: new Map(), builds: new Map() };
let sharedState = null;

after(() => {
  for (const entry of sharedRuns.trees.values()) {
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
  if (sharedState?.made) fs.rmSync(sharedState.made.repo, { recursive: true, force: true });
});

function sharedRepo(t) {
  if (!sharedState) {
    try {
      sharedState = { made: buildFixtureRepo(SHARED_FILES) };
    } catch (error) {
      sharedState = { error };
    }
  }
  if (sharedState.error) {
    if (sharedState.error.skip && t) {
      t.skip(sharedState.error.message);
      return null;
    }
    throw sharedState.error;
  }
  return sharedState.made;
}

function checkArgs(args) {
  const opts = { repo: repoRoot, repoSlug: REPO_SLUG, evidenceRoots: [], runCache: sharedRuns };
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      i += 1;
      return args[i];
    };
    if (arg === '--schema') opts.schemaPath = next();
    else if (arg === '--manifest') opts.manifestPath = next();
    else if (arg === '--evidence-root') opts.evidenceRoots.push(next());
    else if (arg === '--main-ref') opts.mainRef = next();
    else if (arg === '--repo') opts.repo = next();
    else if (arg === '--repo-slug') opts.repoSlug = next();
    else if (arg === '--fix-downgrade') opts.fixDowngrade = next();
    else if (arg.startsWith('--')) throw new Error(`unknown argument ${arg}`);
    else positionals.push(arg);
  }
  opts.matrixPath = positionals[0];
  return opts;
}

function runCheck(args, env) {
  const saved = env ? Object.keys(env).map((key) => [key, process.env[key]]) : null;
  if (env) Object.assign(process.env, env);
  try {
    const report = checkMatrix(checkArgs(args));
    return { status: report.ok ? 0 : 1, stdout: '', stderr: '', json: report };
  } catch (error) {
    return { status: 1, stdout: '', stderr: String(error?.stack || error), json: null };
  } finally {
    if (saved) {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}

function runCheckCli(args) {
  const slugArgs = args.includes('--repo-slug') ? [] : ['--repo-slug', REPO_SLUG];
  const res = spawnSync(process.execPath, [checkScript, ...args, ...slugArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
  });
  const line = (res.stdout || '').split('\n').find((item) => item.startsWith('MATRIX_CHECK_JSON '));
  let json = null;
  if (line) json = JSON.parse(line.slice('MATRIX_CHECK_JSON '.length));
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', json };
}

function row(id, status, evidence) {
  const out = {
    id,
    area: 'fixture',
    feature: String(id),
    doc_url: 'https://example.test/help/fixture',
    plan_tier: 'test',
    enterprise_only: false,
    status,
  };
  if (evidence) out.evidence = evidence;
  return out;
}

function repoEvidence(sha, filePath, extra = {}) {
  return {
    repo: REPO_SLUG,
    sha,
    path: filePath,
    ...extra,
  };
}

const mainSha = git(['rev-parse', 'origin/main']);
// A fresh clone of a single-commit history has no origin/main^; the
// not-ancestor case below then skips instead of failing the whole file.
const parentRes = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', 'origin/main^'], { encoding: 'utf8' });
const parentSha = parentRes.status === 0 ? parentRes.stdout.trim() : '';

function unknownSha() {
  let sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  for (let i = 0; i < 5; i += 1) {
    const res = spawnSync('git', ['-C', repoRoot, 'cat-file', '-t', sha], { encoding: 'utf8' });
    if (res.status !== 0) return sha;
    sha = createHash('sha1').update(sha).digest('hex').slice(0, 40);
  }
  throw new Error('could not find an unknown sha');
}

test('schema ladder matches the evidence the checker will prove', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepEqual(schema.$defs.row.properties.status.enum, LADDER);
  for (const status of ['built-in-Creator', 'adapter-written', 'migrated', 'verified']) {
    const clause = schema.$defs.row.allOf.find((item) => item.if?.properties?.status?.const === status);
    assert.ok(clause, status);
    assert.deepEqual(clause.then.properties.evidence.required, REQUIRED_EVIDENCE[status]);
  }
  assert.deepEqual(REQUIRED_EVIDENCE['not-started'], []);
});

test('accepts every status when the evidence actually resolves', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-ok-'));
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const capture = path.join(dir, 'console-capture.txt');
  fs.writeFileSync(capture, 'catalyst console fixture\n');
  const e2eSha256 = createHash('sha256').update(fs.readFileSync(capture)).digest('hex');
  const rows = [
    row('bare', 'not-started'),
    row('builtin', 'built-in-Creator', {
      creatorApp: DS_REL,
      dsPath: DS_REL,
    }),
    row('adapter', 'adapter-written', repoEvidence(sha, 'package.json')),
    row('migrated', 'migrated', repoEvidence(sha, 'package.json', {
      catalystProjectId: CATALYST_PROJECT_ID,
      migrationRecord: MIGRATION_REL,
    })),
    row('verified', 'verified', repoEvidence(sha, 'package.json', {
      catalystProjectId: CATALYST_PROJECT_ID,
      migrationRecord: MIGRATION_REL,
      testId: PASSING_TEST_ID,
      e2eEvidence: 'console-capture.txt',
      e2eSha256,
    })),
  ];
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(rows.map((item) => item.id)));
  const result = runCheck([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--evidence-root', dir,
    '--repo', repo,
    '--main-ref', 'main',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.failedRows, 0);
  assert.deepEqual(result.json.failures, []);
});

test('fixture with good and bad rows fails on a missing path, a missing test, and an unknown sha', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-bad-'));
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const capture = path.join(dir, 'console-capture.txt');
  fs.writeFileSync(capture, 'catalyst console fixture\n');
  const e2eSha256 = createHash('sha256').update(fs.readFileSync(capture)).digest('hex');
  const rows = [
    row('good-verified', 'verified', repoEvidence(sha, 'package.json', {
      catalystProjectId: CATALYST_PROJECT_ID,
      migrationRecord: MIGRATION_REL,
      testId: PASSING_TEST_ID,
      e2eEvidence: 'console-capture.txt',
      e2eSha256,
    })),
    row('bad-path', 'adapter-written', repoEvidence(sha, 'docs/feature-matrix/no-such-file.txt')),
    row('bad-test', 'adapter-written', repoEvidence(sha, 'package.json', {
      testId: 'tests/matrix/fixtures/does-not-exist.test.mjs',
    })),
    row('bad-sha', 'adapter-written', repoEvidence(unknownSha(), 'package.json')),
  ];
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(rows.map((item) => item.id)));
  const result = runCheck([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--evidence-root', dir,
    '--repo', repo,
    '--main-ref', 'main',
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.ok, false);
  const byRow = Object.fromEntries(result.json.failures.map((failure) => [String(failure.rowId), failure.code]));
  assert.equal(byRow['good-verified'], undefined);
  assert.equal(byRow['bad-path'], 'missing-path');
  assert.equal(byRow['bad-test'], 'missing-test');
  assert.equal(byRow['bad-sha'], 'unknown-sha');
  assert.equal(result.json.reasons['missing-path'], 1);
  assert.equal(result.json.reasons['missing-test'], 1);
  assert.equal(result.json.reasons['unknown-sha'], 1);
});

test('a sha that is not an ancestor of main is not repo evidence', (t) => {
  if (!parentSha) {
    t.skip('origin/main has no parent commit');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-anc-'));
  const rows = [row('side', 'adapter-written', repoEvidence(mainSha, 'package.json'))];
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(['side']));
  const result = runCheckCli([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--main-ref', parentSha,
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.failures.some((failure) => failure.code === 'not-ancestor'), true);
  assert.equal(result.json.failures.some((failure) => failure.code === 'missing-path'), false);
});

test('e2e evidence must exist and match the hash stored on the row', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-hash-'));
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const rows = [
    row('hashed', 'verified', repoEvidence(sha, 'package.json', {
      catalystProjectId: CATALYST_PROJECT_ID,
      migrationRecord: MIGRATION_REL,
      testId: PASSING_TEST_ID,
      e2eEvidence: 'console-capture.txt',
      e2eSha256: 'a'.repeat(64),
    })),
  ];
  fs.writeFileSync(path.join(dir, 'console-capture.txt'), 'not the hashed bytes\n');
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(['hashed']));
  const result = runCheck([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--evidence-root', dir,
    '--repo', repo,
    '--main-ref', 'main',
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.failures.some((failure) => failure.code === 'evidence-hash-mismatch'), true);
});

test('--fix-downgrade lowers each status to the highest level the evidence proves', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-down-'));
  const rows = [
    row('over-verified', 'verified', repoEvidence(mainSha, 'package.json')),
    row('no-sha', 'verified', repoEvidence(unknownSha(), 'package.json', {
      catalystProjectId: CATALYST_PROJECT_ID,
      migrationRecord: MIGRATION_REL,
      testId: PASSING_TEST_ID,
      e2eEvidence: 'tests/matrix/fixtures/e2e-evidence.txt',
      e2eSha256: 'b'.repeat(64),
    })),
    row('builtin-only', 'adapter-written', {
      repo: REPO_SLUG,
      sha: mainSha,
      path: 'docs/feature-matrix/no-such-file.txt',
      creatorApp: DS_REL,
      dsPath: DS_REL,
    }),
    row('bad-optional-test', 'adapter-written', repoEvidence(mainSha, 'package.json', {
      testId: 'tests/matrix/fixtures/does-not-exist.test.mjs',
    })),
  ];
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(rows.map((item) => item.id)));
  const copy = path.join(dir, 'downgraded.json');
  const result = runCheck([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--main-ref', 'origin/main',
    '--fix-downgrade', copy,
  ]);
  assert.notEqual(result.status, 0);
  const downgraded = JSON.parse(fs.readFileSync(copy, 'utf8'));
  const byId = Object.fromEntries(downgraded.rows.map((item) => [item.id, item]));
  assert.equal(byId['over-verified'].status, 'adapter-written');
  assert.equal(byId['over-verified'].evidence.testId, undefined);
  assert.equal(byId['no-sha'].status, 'not-started');
  assert.equal(byId['no-sha'].evidence, undefined);
  assert.equal(byId['builtin-only'].status, 'built-in-Creator');
  assert.deepEqual(Object.keys(byId['builtin-only'].evidence).sort(), ['creatorApp', 'dsPath']);
  assert.equal(byId['bad-optional-test'].status, 'adapter-written');
  assert.equal(byId['bad-optional-test'].evidence.testId, undefined);
  const again = runCheck([
    copy,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--main-ref', 'origin/main',
  ]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
});

test('a finished crawl manifest reports sections that no row maps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-unmap-'));
  const matrix = writeJson(dir, 'matrix.json', {
    schemaVersion: 1,
    rows: [row('only', 'not-started')],
  });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(['missing-row'], {
    extra: [{ id: 'forms/fields', url: 'https://www.zoho.com/creator/help/forms/fields/', title: 'Fields', count: 3, rowIds: [] }],
  }));
  const result = runCheck([matrix, '--schema', schemaPath, '--manifest', manifest, '--main-ref', 'origin/main']);
  assert.notEqual(result.status, 0);
  const unmapped = result.json.failures.filter((failure) => failure.code === 'unmapped-section').map((failure) => failure.detail);
  assert.deepEqual(unmapped.sort(), ['fixture', 'forms/fields']);
});

test('an incomplete crawl manifest is not coverage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-inc-'));
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows: [row('only', 'not-started')] });
  const manifest = writeJson(dir, 'manifest.json', manifestFor([], { complete: false }));
  const result = runCheck([matrix, '--schema', schemaPath, '--manifest', manifest, '--main-ref', 'origin/main']);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.reasons['manifest-incomplete'], 1);
  assert.equal(result.json.failedRows, 0);
});

test('a .ds creatorApp is the path the checker accepts', () => {
  const imported = { schemaVersion: 1, rows: [row('builtin', 'built-in-Creator', { creatorApp: DS_REL, dsPath: DS_REL })] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-ds-'));
  const matrix = writeJson(dir, 'matrix.json', imported);
  const manifest = writeJson(dir, 'manifest.json', manifestFor(['builtin']));
  const result = runCheckCli([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--main-ref', 'origin/main',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json.failures, []);
});

test('help crawl stays on the robots rules and will not go faster than one request per 2s', () => {
  assert.equal(MIN_INTERVAL_MS, 2000);
  const parsed = parseRobots([
    'User-agent: *',
    'Disallow: /creator/help/secret',
    'Allow: /creator/help/',
    'Crawl-delay: 5',
    'Sitemap: https://www.zoho.com/creator-sitemap.xml',
    'Sitemap: https://evil.example.test/sitemap.xml',
  ].join('\n'));
  assert.deepEqual(parsed.sitemaps, [
    'https://www.zoho.com/creator-sitemap.xml',
    'https://evil.example.test/sitemap.xml',
  ]);
  const group = parsed.groups[0];
  assert.equal(pathAllowed('/creator/help/forms/fields/', group), true);
  assert.equal(pathAllowed('/creator/help/secret/page', group), false);
  assert.equal(pathAllowed('/anywhere', { disallow: ['/'], allow: [] }), false);
  assert.equal(pathAllowed('/creator/help/', { disallow: [''], allow: [] }), true);
  assert.equal(sectionIdFor('/creator/help/forms/fields/single-line.html'), 'forms/fields');
  assert.equal(sectionIdFor('/creator/help/forms/form-properties.html'), 'forms');
  assert.equal(sectionIdFor('/creator/newhelp/reports/map/understand-address-field.html'), 'newhelp/reports/map');
  assert.equal(sectionIdFor('/creator/help/'), null);
  assert.deepEqual(
    sitemapLocs('<urlset><url><loc>https://www.zoho.com/creator/help/a.html?x=1&amp;y=2</loc></url></urlset>'),
    ['https://www.zoho.com/creator/help/a.html?x=1&y=2'],
  );
  const refused = spawnSync(process.execPath, [fetchScript, '--min-interval-ms', '500'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /2000/);
});

function verifiedEvidence(sha, testId, e2eSha256) {
  return repoEvidence(sha, 'package.json', {
    catalystProjectId: CATALYST_PROJECT_ID,
    migrationRecord: MIGRATION_REL,
    testId,
    e2eEvidence: 'console-capture.txt',
    e2eSha256,
  });
}

function checkRows(repo, rows, { mainRef = 'main', evidenceDir } = {}) {
  const dir = evidenceDir || fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-gate-'));
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(rows.map((item) => item.id)));
  return runCheck([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--evidence-root', dir,
    '--repo', repo,
    '--main-ref', mainRef,
  ]);
}

test('testId must match one exact full test name', (t) => {
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-exact-'));
  const e2eSha256 = createHash('sha256').update('catalyst console fixture\n').digest('hex');
  fs.writeFileSync(path.join(dir, 'console-capture.txt'), 'catalyst console fixture\n');
  const rows = [
    row('substring', 'verified', verifiedEvidence(sha, 't/exact.test.mjs#adds', e2eSha256)),
    row('duplicate', 'verified', verifiedEvidence(sha, 't/exact.test.mjs#same', e2eSha256)),
    row('skipped', 'verified', verifiedEvidence(sha, 't/exact.test.mjs#skipped proof', e2eSha256)),
    row('exact', 'verified', verifiedEvidence(sha, 't/exact.test.mjs#adds numbers', e2eSha256)),
    row('unnamed', 'verified', verifiedEvidence(sha, 't/exact.test.mjs', e2eSha256)),
  ];
  const result = checkRows(repo, rows, { evidenceDir: dir });
  assert.notEqual(result.status, 0);
  const codes = (id) => result.json.failures.filter((failure) => failure.rowId === id).map((failure) => failure.code);
  assert.deepEqual(codes('substring'), ['missing-test']);
  assert.deepEqual(codes('duplicate'), ['missing-test']);
  assert.deepEqual(codes('skipped'), ['missing-test']);
  assert.deepEqual(codes('unnamed'), ['missing-test']);
  assert.deepEqual(codes('exact'), []);
  const skipped = result.json.failures.find((failure) => failure.rowId === 'skipped');
  assert.match(skipped.detail, /skip/);
});

test('stdout tap text is not a passing test', (t) => {
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-fake-'));
  const e2eSha256 = createHash('sha256').update('catalyst console fixture\n').digest('hex');
  fs.writeFileSync(path.join(dir, 'console-capture.txt'), 'catalyst console fixture\n');
  const rows = [row('spoof', 'verified', verifiedEvidence(sha, 't/fake.test.mjs#fake pass', e2eSha256))];
  const result = checkRows(repo, rows, { evidenceDir: dir });
  assert.notEqual(result.status, 0);
  const failure = result.json.failures.find((item) => item.rowId === 'spoof');
  assert.equal(failure.code, 'missing-test');
  assert.match(failure.detail, /no test named/);
});

test('tap accounting requires one plan and a summary that matches counted results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-account-'));
  const file = path.join(dir, 't.test.mjs');
  fs.writeFileSync(file, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('parent', async (t) => { await t.test('child', () => { assert.equal(1, 1); }); });",
    "test('fails', () => { assert.equal(1, 2); });",
    "test('skipped proof', { skip: true }, () => {});",
    "test('todo item', { todo: true }, () => { assert.equal(1, 2); });",
    "test.describe('suite', () => { test('inside', () => {}); });",
    '',
  ].join('\n'));
  const tapFile = path.join(dir, 'out.tap');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [
    '--max-old-space-size=2048',
    '--test-timeout=120000',
    '--test',
    '--test-reporter=tap',
    '--test-reporter-destination', tapFile,
    file,
  ], { encoding: 'utf8', env });
  const tap = fs.readFileSync(tapFile, 'utf8');
  assert.notEqual(res.status, 0, tap);
  const accounted = accountTap(tap);
  assert.equal(accounted.ok, true, `${accounted.detail}\n${tap}`);
  assert.equal(accountTap(tap.replace(/^1\.\.\d+\s*$/m, '')).ok, false);
  const lied = tap.replace(/^# pass \d+\s*$/m, '# pass 99');
  const liedAccount = accountTap(lied);
  assert.equal(liedAccount.ok, false);
  assert.match(liedAccount.detail, /pass|tests/);
  assert.equal(accountTap('ok 1 - only\n').detail, 'missing plan');
});

test('a test that hunts the predictable tap path cannot overwrite the result', (t) => {
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-hostile-'));
  const e2eSha256 = createHash('sha256').update('catalyst console fixture\n').digest('hex');
  fs.writeFileSync(path.join(dir, 'console-capture.txt'), 'catalyst console fixture\n');
  const rows = [row('hostile', 'verified', verifiedEvidence(sha, 't/hostile.test.mjs#hostile cannot spoof the tap file', e2eSha256))];
  const result = checkRows(repo, rows, { evidenceDir: dir });
  const failure = result.json.failures.find((item) => item.rowId === 'hostile');
  assert.ok(failure, result.stdout + result.stderr);
  assert.equal(failure.code, 'test-failed');
  assert.match(failure.detail, /test failed/);
  assert.doesNotMatch(failure.detail, /mismatch/);
});

test('an untracked test file in the working tree is not evidence', (t) => {
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const untracked = path.join(repo, 't/new.test.mjs');
  fs.mkdirSync(path.dirname(untracked), { recursive: true });
  fs.writeFileSync(untracked, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('new test', () => { assert.equal(1, 1); });",
    '',
  ].join('\n'));
  assert.equal(fs.existsSync(untracked), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-untracked-'));
  const e2eSha256 = createHash('sha256').update('catalyst console fixture\n').digest('hex');
  fs.writeFileSync(path.join(dir, 'console-capture.txt'), 'catalyst console fixture\n');
  const rows = [row('untracked', 'verified', verifiedEvidence(sha, 't/new.test.mjs#new test', e2eSha256))];
  const result = checkRows(repo, rows, { evidenceDir: dir });
  const failure = result.json.failures.find((item) => item.rowId === 'untracked');
  assert.equal(failure.code, 'missing-test');
  assert.match(failure.detail, /is not in/);
});

test('the test at the evidence sha runs, not the working tree copy', (t) => {
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  fs.writeFileSync(path.join(repo, 't/dirty.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('adds numbers', () => { assert.equal(1, 1); });",
    '',
  ].join('\n'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-sha-run-'));
  const e2eSha256 = createHash('sha256').update('catalyst console fixture\n').digest('hex');
  fs.writeFileSync(path.join(dir, 'console-capture.txt'), 'catalyst console fixture\n');
  const rows = [row('dirty', 'verified', verifiedEvidence(sha, 't/dirty.test.mjs#adds numbers', e2eSha256))];
  const result = checkRows(repo, rows, { evidenceDir: dir });
  const failure = result.json.failures.find((item) => item.rowId === 'dirty');
  assert.equal(failure.code, 'test-failed');
  assert.match(failure.detail, /test failed/);
});

test('mainRef is origin/main or main and never falls back to HEAD', (t) => {
  const made = makeRepo({ 'package.json': '{"type":"module"}\n' }, t);
  if (!made) return;
  const { repo, sha } = made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-head-'));
  const rows = [row('on-main', 'adapter-written', repoEvidence(sha, 'package.json'))];
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(['on-main']));
  const args = [matrix, '--schema', schemaPath, '--manifest', manifest, '--repo', repo];
  const ok = runCheck(args);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.json.mainRef, 'main');
  const detached = fixtureGit(repo, ['checkout', '--detach'], made.env);
  if (detached.status !== 0 && !guardRefused(detached)) {
    assert.equal(detached.status, 0, detached.stderr || detached.stdout);
  }
  deleteLooseRef(made.gitDir, 'refs/heads/main');
  const bad = runCheck(args);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.json, null);
  assert.match(bad.stderr, /no main ref \(tried origin\/main, main\)/);
});

test('a failing test is test-failed and a missing name is missing-test', (t) => {
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-fail-'));
  const e2eSha256 = createHash('sha256').update('catalyst console fixture\n').digest('hex');
  fs.writeFileSync(path.join(dir, 'console-capture.txt'), 'catalyst console fixture\n');
  const rows = [
    row('failed', 'verified', verifiedEvidence(sha, 't/fail.test.mjs#fails hard', e2eSha256)),
    row('absent', 'verified', verifiedEvidence(sha, 't/fail.test.mjs#no such test', e2eSha256)),
  ];
  const result = checkRows(repo, rows, { evidenceDir: dir });
  const failed = result.json.failures.find((item) => item.rowId === 'failed');
  const absent = result.json.failures.find((item) => item.rowId === 'absent');
  assert.equal(failed.code, 'test-failed');
  assert.match(failed.detail, /test failed/);
  assert.equal(absent.code, 'missing-test');
  assert.match(absent.detail, /no test named/);
  assert.doesNotMatch(absent.detail, /test failed/);
});

test('catalystProjectId must be 17 digits and creatorApp must be an existing .ds path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-id-'));
  const rows = [
    row('bad-id', 'migrated', repoEvidence(mainSha, 'package.json', {
      catalystProjectId: 'totally-made-up',
      migrationRecord: MIGRATION_REL,
    })),
    row('short-id', 'migrated', repoEvidence(mainSha, 'package.json', {
      catalystProjectId: '1234567890123456',
      migrationRecord: MIGRATION_REL,
    })),
    row('bad-app', 'built-in-Creator', {
      creatorApp: 'NoSuchAppAnywhere',
      dsPath: DS_REL,
    }),
  ];
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(rows.map((item) => item.id)));
  const result = runCheck([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--main-ref', 'origin/main',
  ]);
  assert.notEqual(result.status, 0);
  const code = (id) => result.json.failures.find((failure) => failure.rowId === id).code;
  assert.equal(code('bad-id'), 'bad-catalyst-project-id');
  assert.equal(code('short-id'), 'bad-catalyst-project-id');
  assert.equal(code('bad-app'), 'bad-creator-app');
  const badApp = result.json.failures.find((failure) => failure.rowId === 'bad-app');
  assert.match(badApp.detail, /bare app name/);
  assert.match(badApp.detail, /repo-relative or fixtures-root \.ds path/);
});

test('creatorApp and dsPath honour C2C_FIXTURES_DIR, both fixtures-root-relative and parent-relative', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-fixtures-'));
  const fixtures = path.join(dir, 'fixtures');
  fs.mkdirSync(path.join(fixtures, 'apps'), { recursive: true });
  fs.writeFileSync(path.join(fixtures, 'apps', 'x.ds'), 'fixture app\n');
  fs.writeFileSync(path.join(dir, 'outside.ds'), 'outside\n');
  const rows = [
    row('parent-relative', 'built-in-Creator', { creatorApp: 'fixtures/apps/x.ds', dsPath: 'fixtures/apps/x.ds' }),
    row('fixtures-relative', 'built-in-Creator', { creatorApp: 'apps/x.ds', dsPath: 'apps/x.ds' }),
    row('escape', 'built-in-Creator', { creatorApp: '../outside.ds', dsPath: '../outside.ds' }),
  ];
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows });
  const manifest = writeJson(dir, 'manifest.json', manifestFor(rows.map((item) => item.id)));
  const res = runCheck([
    matrix,
    '--schema', schemaPath,
    '--manifest', manifest,
    '--main-ref', 'origin/main',
  ], { C2C_FIXTURES_DIR: fixtures });
  const failures = res.json.failures;
  const ids = failures.map((failure) => failure.rowId);
  assert.equal(ids.includes('parent-relative'), false, JSON.stringify(failures));
  assert.equal(ids.includes('fixtures-relative'), false, JSON.stringify(failures));
  assert.ok(failures.some((failure) => failure.rowId === 'escape' && failure.code === 'bad-creator-app'), JSON.stringify(failures));
});

test('a helpSectionIds self-claim does not map a section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-self-'));
  const claimed = row('only', 'not-started');
  claimed.helpSectionIds = ['forms/fields'];
  claimed.doc_url = 'https://example.test/unrelated';
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows: [claimed] });
  const manifest = writeJson(dir, 'manifest.json', {
    version: 1,
    complete: true,
    sections: [{
      id: 'forms/fields',
      url: 'https://www.zoho.com/creator/help/forms/fields/',
      title: 'Fields',
      count: 1,
      rowIds: [],
    }],
  });
  const result = runCheck([matrix, '--schema', schemaPath, '--manifest', manifest, '--main-ref', 'origin/main']);
  assert.equal(result.json.failures.some((failure) => failure.code === 'unmapped-section' && failure.detail === 'forms/fields'), true);
});

test('helpSectionIds maps a section when its URL is the doc_url or a prefix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-prefix-'));
  const claimed = row('only', 'not-started');
  claimed.helpSectionIds = ['forms/fields'];
  claimed.doc_url = 'https://www.zoho.com/creator/help/forms/fields/single-line.html';
  const matrix = writeJson(dir, 'matrix.json', { schemaVersion: 1, rows: [claimed] });
  const manifest = writeJson(dir, 'manifest.json', {
    version: 1,
    complete: true,
    sections: [{
      id: 'forms/fields',
      url: 'https://www.zoho.com/creator/help/forms/fields/',
      title: 'Fields',
      count: 1,
      rowIds: [],
    }],
  });
  const result = runCheck([matrix, '--schema', schemaPath, '--manifest', manifest, '--main-ref', 'origin/main']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json.unmappedSections, []);
});

test('typescript evidence runs a fresh build, not a stale dist', (t) => {
  const made = sharedRepo(t);
  if (!made) return;
  const { repo, sha } = made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-ts-'));
  const rows = [row('stale', 'adapter-written', repoEvidence(sha, 'package.json', {
    testId: 'packages/demo/test/demo.test.ts#counts',
  }))];
  const result = checkRows(repo, rows, { evidenceDir: dir });
  const failure = result.json.failures.find((item) => item.rowId === 'stale');
  assert.ok(failure, result.stdout + result.stderr);
  assert.equal(failure.code, 'test-failed');
  assert.match(failure.detail, /test failed/);
});

test('redirect hops re-check robots and origin and a skipped hop is incomplete', async () => {
  const robots = [
    'User-agent: *',
    'Disallow: /creator/help/private',
    'Allow: /creator/',
    'Sitemap: https://www.zoho.com/creator-sitemap.xml',
  ].join('\n');
  const page = '<urlset><url><loc>https://www.zoho.com/creator/help/forms/fields/single-line.html</loc></url></urlset>';
  const index = [
    '<sitemapindex>',
    '<sitemap><loc>https://www.zoho.com/creator/help-pages.xml</loc></sitemap>',
    '<sitemap><loc>https://www.zoho.com/creator/redirect.xml</loc></sitemap>',
    '</sitemapindex>',
  ].join('');
  function response(status, body, headers = {}) {
    const lower = {};
    for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => lower[name.toLowerCase()] ?? null },
      arrayBuffer: async () => Buffer.from(body ?? ''),
    };
  }
  async function crawl(handler) {
    const calls = [];
    const manifest = await crawlHelpSitemap({
      maxRequests: 10,
      intervalMs: 0,
      fetchImpl: async (url, options) => {
        calls.push(String(url));
        assert.equal(options.redirect, 'manual');
        return handler(String(url));
      },
    });
    return { calls, manifest };
  }

  const disallowed = await crawl((url) => {
    if (url.endsWith('/robots.txt')) return response(200, robots);
    if (url.endsWith('/creator-sitemap.xml')) return response(200, index);
    if (url.endsWith('/creator/help-pages.xml')) return response(200, page);
    if (url.endsWith('/creator/redirect.xml')) {
      return response(302, '<secret>hidden</secret>', { location: '/creator/help/private/secret.xml' });
    }
    if (url.includes('/private/')) return response(200, '<urlset><url><loc>https://www.zoho.com/creator/help/private/hidden.html</loc></url></urlset>');
    return response(404, 'missing');
  });
  assert.equal(disallowed.manifest.complete, false);
  assert.equal(disallowed.calls.some((url) => url.includes('/private/')), false);
  assert.equal(JSON.stringify(disallowed.manifest).includes('hidden'), false);
  assert.equal(disallowed.manifest.sections.some((section) => section.id === 'forms/fields'), true);

  const cross = await crawl((url) => {
    if (url.endsWith('/robots.txt')) return response(200, robots);
    if (url.endsWith('/creator-sitemap.xml')) {
      return response(302, '', { location: 'https://evil.example.test/secret.xml' });
    }
    if (url.includes('evil.example.test')) return response(200, '<urlset><url><loc>https://evil.example.test/hidden.html</loc></url></urlset>');
    return response(404, 'missing');
  });
  assert.equal(cross.manifest.complete, false);
  assert.equal(cross.calls.some((url) => url.includes('evil.example.test')), false);
  assert.equal(JSON.stringify(cross.manifest).includes('evil.example.test'), false);

  const allowed = await crawl((url) => {
    if (url.endsWith('/robots.txt')) return response(200, robots);
    if (url.endsWith('/creator-sitemap.xml')) {
      return response(302, '', { location: 'https://www.zoho.com/creator/help-pages.xml' });
    }
    if (url.endsWith('/creator/help-pages.xml')) return response(200, page);
    return response(404, 'missing');
  });
  assert.equal(allowed.manifest.complete, true);
  assert.equal(allowed.manifest.sections.some((section) => section.id === 'forms/fields'), true);
});

const citationsPath = path.join(repoRoot, 'packages/cli/data/feature-matrix-v4.citations.json');
const snapshotPath = path.join(repoRoot, 'packages/cli/data/feature-matrix-v4.snapshot.json');

test('every committed matrix citation resolves at HEAD', () => {
  const doc = JSON.parse(fs.readFileSync(citationsPath, 'utf8'));
  assert.equal(doc.schema, 'c2c-matrix-citations/1');
  assert.ok(Array.isArray(doc.cites) && doc.cites.length > 0, 'citation sidecar is empty');
  const failures = checkCites(doc.cites, { repo: repoRoot, rev: 'HEAD' });
  assert.deepEqual(failures.map((f) => `row ${f.id}: ${f.spec} — ${f.reason}`), []);
});

test('citation sidecar is in step with the snapshot it was generated beside', () => {
  const doc = JSON.parse(fs.readFileSync(citationsPath, 'utf8'));
  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.equal(doc.sourceSha256, snap.sourceSha256);
  assert.equal(doc.snapshotDate, snap.snapshotDate);
});

test('the citation check fails on a stale path:line (non-vacuous)', () => {
  const rows = [
    {
      id: 'stale-line',
      status_evidence: 'code: package.json:99999 (origin/main deadbee)',
      evidence: { code: 'no/such/file.ts:1 @ deadbee' },
    },
    { id: 'fine', evidence: { code: 'package.json:1 @ deadbee' } },
  ];
  const cites = extractCites(rows);
  assert.deepEqual(
    cites.map((c) => c.spec).sort(),
    ['no/such/file.ts:1', 'package.json:1', 'package.json:99999'],
  );
  const failures = checkCites(cites, { repo: repoRoot, rev: 'HEAD' });
  assert.equal(failures.length, 2);
  assert.ok(failures.some((f) => f.id === 'stale-line' && f.spec === 'no/such/file.ts:1'));
  assert.ok(failures.some((f) => f.id === 'stale-line' && /out of range/.test(f.reason)));
});
