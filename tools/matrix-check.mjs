#!/usr/bin/env node
/**
 * Feature-matrix evidence gate.
 *
 * Ladder: not-started < built-in-Creator < adapter-written < migrated < verified.
 * A claimed status is kept only when every required link resolves. Repo evidence
 * is `git cat-file -e <sha>:<path>` and the sha must be an ancestor of main
 * (a blob that exists only off main is not proof of what shipped). testId, when
 * present, is `file#exact full name` and that test is run from a git archive of
 * the evidence sha. e2e captures may live under
 * --evidence-root (outside the repo) but must be hashed in the row.
 * --fix-downgrade never raises a status.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema } from './matrix-schema.mjs';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LADDER = [
  'not-started',
  'built-in-Creator',
  'adapter-written',
  'migrated',
  'verified',
];

const REQUIRED_EVIDENCE = {
  'not-started': [],
  'built-in-Creator': ['creatorApp', 'dsPath'],
  'adapter-written': ['repo', 'sha', 'path'],
  migrated: ['repo', 'sha', 'path', 'catalystProjectId', 'migrationRecord'],
  verified: [
    'repo',
    'sha',
    'path',
    'catalystProjectId',
    'migrationRecord',
    'testId',
    'e2eEvidence',
    'e2eSha256',
  ],
};

const TEST_FILE_RE = /\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|jsx)$/;
const CATALYST_PROJECT_ID_RE = /^[0-9]{17}$/;

function rankOf(status) {
  const rank = LADDER.indexOf(status);
  return rank === -1 ? -1 : rank;
}

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function originSlug(repo) {
  const res = git(repo, ['remote', 'get-url', 'origin']);
  if (res.status !== 0) return null;
  const url = (res.stdout || '').trim();
  const match = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function resolveMainRef(repo, requested) {
  if (requested) {
    const verify = git(repo, ['rev-parse', '--verify', '--quiet', `${requested}^{commit}`]);
    if (verify.status !== 0) {
      throw new Error(`main ref not found: ${requested}`);
    }
    return requested;
  }
  for (const ref of ['origin/main', 'main']) {
    const verify = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (verify.status === 0) return ref;
  }
  throw new Error('no main ref (tried origin/main, main)');
}

function statusEnum(schema) {
  return schema?.$defs?.row?.properties?.status?.enum ?? null;
}

function assertSchemaLadder(schema) {
  const enumValues = statusEnum(schema);
  if (!enumValues || enumValues.join('\0') !== LADDER.join('\0')) {
    throw new Error(
      `schema status enum must be exactly ${LADDER.join(' | ')} so the downgrade ladder cannot drift`,
    );
  }
}

function isInside(child, root) {
  const c = path.resolve(child);
  const r = path.resolve(root);
  return c === r || c.startsWith(r + path.sep);
}

function realInside(abs, roots) {
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return false;
  }
  return roots.some((root) => {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      realRoot = path.resolve(root);
    }
    return real === realRoot || real.startsWith(realRoot + path.sep);
  });
}

function resolveFile(rel, roots) {
  if (typeof rel !== 'string' || rel.length === 0) {
    return { ok: false, code: 'missing-evidence-file', detail: 'empty path' };
  }
  if (rel.includes('\0')) {
    return { ok: false, code: 'bad-path', detail: rel };
  }
  const candidates = [];
  if (path.isAbsolute(rel)) candidates.push(path.resolve(rel));
  else {
    for (const root of roots) candidates.push(path.resolve(root, rel));
  }
  for (const abs of candidates) {
    if (!roots.some((root) => isInside(abs, root))) continue;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    if (!realInside(abs, roots)) {
      return { ok: false, code: 'evidence-outside-root', detail: rel };
    }
    return { ok: true, abs };
  }
  return { ok: false, code: 'missing-evidence-file', detail: rel };
}

function fixtureDirs(repo) {
  const dirs = [];
  if (process.env.C2C_FIXTURES_DIR) dirs.push(path.resolve(process.env.C2C_FIXTURES_DIR));
  return dirs.filter((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
}

function resolveAppFile(rel, ctx) {
  const own = resolveFile(rel, ctx.roots);
  if (own.ok || typeof rel !== 'string' || rel.length === 0 || rel.includes('\0') || path.isAbsolute(rel)) return own;
  for (const dir of fixtureDirs(ctx.repo)) {
    for (const base of [dir, path.dirname(dir)]) {
      const abs = path.resolve(base, rel);
      if (!isInside(abs, dir)) continue;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      if (!realInside(abs, [dir])) return { ok: false, code: 'evidence-outside-root', detail: rel };
      return { ok: true, abs };
    }
  }
  return own;
}

function sha256File(abs) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(abs));
  return hash.digest('hex');
}

function badGitPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return 'empty path';
  if (filePath.includes('\0') || filePath.includes(':') || filePath.startsWith('/') || path.isAbsolute(filePath)) {
    return 'path must be a repo-relative blob path without a colon';
  }
  if (filePath.split('/').some((part) => part === '..' || part === '')) {
    return 'path must not contain empty or .. segments';
  }
  return null;
}

function parseTestId(testId) {
  const hash = testId.indexOf('#');
  if (hash === -1) return { file: testId, name: null };
  const name = testId.slice(hash + 1);
  return { file: testId.slice(0, hash), name: name.length > 0 ? name : null };
}

function isCommit(repo, sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return false;
  const typeRes = git(repo, ['cat-file', '-t', sha]);
  return typeRes.status === 0 && (typeRes.stdout || '').trim() === 'commit';
}

function blobAt(repo, sha, filePath) {
  const typeRes = git(repo, ['cat-file', '-t', `${sha}:${filePath}`]);
  return typeRes.status === 0 && (typeRes.stdout || '').trim() === 'blob';
}

function materialize(ctx, sha) {
  const key = `${ctx.repo}\0${sha}`;
  const cached = ctx.trees.get(key);
  if (cached) return cached.src;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-sha-'));
  const tarPath = path.join(root, 'tree.tar');
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  const archived = spawnSync('git', ['-C', ctx.repo, 'archive', '--format=tar', '-o', tarPath, sha], {
    encoding: 'utf8',
  });
  if (archived.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    return null;
  }
  const extracted = spawnSync('tar', ['-xf', tarPath, '-C', src], { encoding: 'utf8' });
  fs.rmSync(tarPath, { force: true });
  if (extracted.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    return null;
  }
  ctx.trees.set(key, { root, src });
  return src;
}

function tsconfigRootDir(tree) {
  try {
    const match = /"rootDir"\s*:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(tree, 'tsconfig.json'), 'utf8'));
    if (match) return match[1].replace(/^\.\//, '').replace(/\/$/, '');
  } catch {
    // A tree without tsconfig cannot be freshly built.
  }
  return 'packages';
}

function buildFresh(ctx, tree) {
  if (ctx.buildCache.has(tree)) return ctx.buildCache.get(tree);
  const tsconfig = path.join(tree, 'tsconfig.json');
  const tsc = path.join(TOOL_ROOT, 'node_modules/typescript/lib/tsc.js');
  let ok = false;
  if (fs.existsSync(tsconfig) && fs.existsSync(tsc)) {
    const modules = path.join(tree, 'node_modules');
    if (!fs.existsSync(modules)) {
      const hostModules = path.join(TOOL_ROOT, 'node_modules');
      if (fs.existsSync(hostModules)) fs.symlinkSync(hostModules, modules, 'dir');
    }
    const res = spawnSync(process.execPath, [
      tsc,
      '-p',
      tsconfig,
      '--outDir',
      '.matrix-fresh',
      '--pretty',
      'false',
      '--declaration',
      'false',
      '--sourceMap',
      'false',
    ], {
      cwd: tree,
      encoding: 'utf8',
      timeout: 180000,
    });
    ok = res.status === 0;
  }
  ctx.buildCache.set(tree, ok);
  return ok;
}

function runnableAt(ctx, tree, suiteFile) {
  const abs = path.join(tree, suiteFile);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  if (!suiteFile.endsWith('.ts') && !suiteFile.endsWith('.tsx')) return abs;
  if (!suiteFile.startsWith('packages/')) return null;
  if (!buildFresh(ctx, tree)) return null;
  const rootDir = tsconfigRootDir(tree);
  const prefix = rootDir ? `${rootDir}/` : '';
  if (!suiteFile.startsWith(prefix)) return null;
  const rel = suiteFile.slice(prefix.length).replace(/\.tsx?$/, '.js');
  const compiled = path.join(tree, '.matrix-fresh', rel);
  if (!fs.existsSync(compiled) || !fs.statSync(compiled).isFile()) return null;
  return compiled;
}

function tapPoints(tapText) {
  const lines = tapText.split(/\r?\n/);
  const points = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^( *)(not ok|ok) \d+ - (.*)$/.exec(lines[index]);
    if (!match) continue;
    let name = match[3];
    let directive = null;
    const marked = / # (SKIP|TODO)\b/.exec(name);
    if (marked) {
      directive = marked[1];
      name = name.slice(0, marked.index);
    }
    const indent = match[1].length;
    let suite = false;
    for (let follow = index + 1; follow < lines.length; follow += 1) {
      const line = lines[follow];
      if (/^\s*type:\s*'suite'\s*$/.test(line)) {
        suite = true;
        break;
      }
      if (/^( *)\.\.\.\s*$/.test(line)) break;
      const next = /^( *)(not ok|ok) \d+ - /.exec(line);
      if (next && next[1].length <= indent) break;
    }
    points.push({
      indent,
      failed: match[2] === 'not ok',
      directive,
      suite,
      name: name.trim(),
    });
  }
  return points.map((point, index) => {
    const chain = [point.name];
    let indent = point.indent;
    for (let i = index + 1; i < points.length; i += 1) {
      if (points[i].indent < indent) {
        chain.push(points[i].name);
        indent = points[i].indent;
      }
    }
    return { ...point, fullName: chain.reverse().join(' > ') };
  });
}

function summaryCounts(tapText) {
  const keys = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'suites'];
  const summary = {};
  const lines = tapText.split(/\r?\n/);
  for (const key of keys) {
    const found = [];
    const re = new RegExp(`^# ${key} (\\d+)\\s*$`);
    for (const line of lines) {
      const match = re.exec(line);
      if (match) found.push(Number(match[1]));
    }
    if (found.length !== 1) {
      return {
        ok: false,
        detail: found.length === 0 ? `missing summary ${key}` : `repeated summary ${key}`,
      };
    }
    summary[key] = found[0];
  }
  return { ok: true, summary };
}

function accountTap(tapText) {
  if (typeof tapText !== 'string' || tapText.trim() === '') {
    return { ok: false, detail: 'empty tap' };
  }
  const points = tapPoints(tapText);
  const plans = [];
  for (const line of tapText.split(/\r?\n/)) {
    const match = /^1\.\.(\d+)\s*$/.exec(line);
    if (match) plans.push(Number(match[1]));
  }
  if (plans.length !== 1) {
    return { ok: false, detail: plans.length === 0 ? 'missing plan' : 'multiple plans' };
  }
  const topLevel = points.filter((point) => point.indent === 0).length;
  if (topLevel !== plans[0]) {
    return { ok: false, detail: `plan ${plans[0]} != ${topLevel} top-level results` };
  }
  const counted = summaryCounts(tapText);
  if (!counted.ok) return { ok: false, detail: counted.detail };
  const summary = counted.summary;
  const summed = summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo;
  if (summed !== summary.tests) {
    return { ok: false, detail: `summary tests ${summary.tests} != ${summed}` };
  }
  const cases = points.filter((point) => !point.suite);
  if (cases.length !== summary.tests) {
    return { ok: false, detail: `summary tests ${summary.tests} != ${cases.length} counted results` };
  }
  const pass = cases.filter((point) => !point.failed && !point.directive).length;
  const skipped = cases.filter((point) => point.directive === 'SKIP').length;
  const todo = cases.filter((point) => point.directive === 'TODO').length;
  const failOrCancelled = cases.filter((point) => point.failed && point.directive !== 'TODO').length;
  const suites = points.filter((point) => point.suite).length;
  if (pass !== summary.pass) return { ok: false, detail: `summary pass ${summary.pass} != ${pass} counted` };
  if (skipped !== summary.skipped) return { ok: false, detail: `summary skipped ${summary.skipped} != ${skipped} counted` };
  if (todo !== summary.todo) return { ok: false, detail: `summary todo ${summary.todo} != ${todo} counted` };
  if (failOrCancelled !== summary.fail + summary.cancelled) {
    return {
      ok: false,
      detail: `summary fail+cancelled ${summary.fail + summary.cancelled} != ${failOrCancelled} counted`,
    };
  }
  if (suites !== summary.suites) {
    return { ok: false, detail: `summary suites ${summary.suites} != ${suites} counted` };
  }
  return { ok: true, points };
}

// One suite file at one sha runs once per context; rows that name different
// tests in the same file share the run and only differ in the name match.
function runSuiteAtSha(ctx, sha, suiteFile) {
  const key = `${ctx.repo}\0${sha}\0${suiteFile}`;
  const cached = ctx.suites.get(key);
  if (cached) return cached;
  const run = runSuiteOnce(ctx, sha, suiteFile);
  ctx.suites.set(key, run);
  return run;
}

import { getTestConcurrencyArgs } from '../scripts/test-concurrency.mjs';

function runSuiteOnce(ctx, sha, suiteFile) {
  const tree = materialize(ctx, sha);
  if (!tree) {
    return { ok: false, code: 'missing-test', detail: (label) => `could not extract ${sha} for ${label}` };
  }
  const runnable = runnableAt(ctx, tree, suiteFile);
  if (!runnable) {
    const source = suiteFile.endsWith('.ts') || suiteFile.endsWith('.tsx');
    const detail = source
      ? (label) => `refusing dist without a fresh build of ${label}`
      : () => `${sha}:${suiteFile} is not a runnable test`;
    return { ok: false, code: 'missing-test', detail };
  }
  const tapDir = fs.mkdtempSync(path.join(os.tmpdir(), `${randomBytes(12).toString('hex')}-`));
  const tapFile = path.join(tapDir, randomBytes(16).toString('hex'));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  // Nested `node --test` refuses to run files when the parent runner set this.
  delete env.NODE_TEST_CONTEXT;
  let tap = '';
  let res = { status: 1 };
  try {
    const args = [
      '--test',
      '--test-reporter=tap',
      '--test-reporter-destination',
      tapFile,
      '--test-timeout',
      '180000',
      ...getTestConcurrencyArgs(env, () => {}),
      runnable,
    ];
    res = spawnSync(process.execPath, args, {
      cwd: tree,
      encoding: 'utf8',
      timeout: 200000,
      env,
    });
    try {
      tap = fs.readFileSync(tapFile, 'utf8');
    } catch {
      tap = '';
    }
  } finally {
    fs.rmSync(tapDir, { recursive: true, force: true });
  }
  if (!tap) {
    if (res.status === 0) {
      return {
        ok: false,
        code: 'missing-test',
        detail: (label, name) => `no test named ${JSON.stringify(name)} in ${label}`,
      };
    }
    return { ok: false, code: 'test-failed', detail: (label) => `test failed: ${label}` };
  }
  const accounted = accountTap(tap);
  if (!accounted.ok) {
    return {
      ok: false,
      code: 'test-failed',
      detail: (label) => `tap plan/summary mismatch for ${label}: ${accounted.detail}`,
    };
  }
  return { ok: true, points: accounted.points };
}

function runTestAtSha(ctx, sha, suiteFile, name) {
  const label = `${suiteFile}#${name}`;
  const run = runSuiteAtSha(ctx, sha, suiteFile);
  if (!run.ok) return { ok: false, code: run.code, detail: run.detail(label, name) };
  const matches = run.points.filter((point) => point.fullName === name);
  if (matches.length === 0) {
    return { ok: false, code: 'missing-test', detail: `no test named ${JSON.stringify(name)} in ${suiteFile} at ${sha}` };
  }
  if (matches.length !== 1) {
    return { ok: false, code: 'missing-test', detail: `${label} matched ${matches.length} tests` };
  }
  const hit = matches[0];
  if (hit.directive === 'SKIP' || hit.directive === 'TODO') {
    return { ok: false, code: 'missing-test', detail: `${label} is ${hit.directive.toLowerCase()}, not a pass` };
  }
  if (hit.failed) return { ok: false, code: 'test-failed', detail: `test failed: ${label}` };
  return { ok: true };
}

function checkRepoEvidence(repo, evidence, mainRef, slug) {
  const failures = [];
  const passing = new Set();
  if (typeof evidence.repo === 'string' && evidence.repo.length > 0) {
    if (evidence.repo === slug) passing.add('repo');
    else failures.push({ code: 'repo-mismatch', detail: `repo ${evidence.repo} != ${slug}` });
  }
  const sha = evidence.sha;
  const shaShape = typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha);
  let commitOk = false;
  if (shaShape) {
    const typeRes = git(repo, ['cat-file', '-t', sha]);
    if (typeRes.status !== 0) {
      failures.push({ code: 'unknown-sha', detail: sha });
    } else if ((typeRes.stdout || '').trim() !== 'commit') {
      failures.push({ code: 'not-commit', detail: `${sha} is ${(typeRes.stdout || '').trim()}` });
    } else {
      commitOk = true;
      const anc = git(repo, ['merge-base', '--is-ancestor', sha, mainRef]);
      if (anc.status === 0) passing.add('sha');
      else failures.push({ code: 'not-ancestor', detail: `${sha} is not an ancestor of ${mainRef}` });
    }
  }
  if (typeof evidence.path === 'string') {
    const why = badGitPath(evidence.path);
    if (why) failures.push({ code: 'bad-path', detail: why });
    else if (commitOk) {
      const blob = git(repo, ['cat-file', '-t', `${sha}:${evidence.path}`]);
      if (blob.status !== 0) failures.push({ code: 'missing-path', detail: `${sha}:${evidence.path}` });
      else if ((blob.stdout || '').trim() !== 'blob') {
        failures.push({ code: 'missing-path', detail: `${sha}:${evidence.path} is not a blob` });
      } else passing.add('path');
    }
  }
  return { failures, passing };
}

function loadJson(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    const pathName = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${pathName}${url.search}`;
  } catch {
    return null;
  }
}

function sectionCoversDoc(sectionUrl, docUrl) {
  const section = canonicalUrl(sectionUrl);
  const doc = canonicalUrl(docUrl);
  if (!section || !doc) return false;
  return doc === section || doc.startsWith(`${section}/`);
}

function checkManifest(manifest, rows) {
  const failures = [];
  const unmapped = [];
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.sections) || typeof manifest.complete !== 'boolean') {
    failures.push({ rowId: null, code: 'manifest-invalid', detail: 'manifest must be { version: 1, complete, sections }' });
    return { failures, unmapped };
  }
  if (manifest.complete !== true) {
    failures.push({
      rowId: null,
      code: 'manifest-incomplete',
      detail: 'help sitemap manifest is not a finished crawl; it is not coverage',
    });
  }
  const rowIds = new Set(rows.map((row) => String(row.id)));
  const rowById = new Map(rows.filter((row) => row && row.id !== undefined).map((row) => [String(row.id), row]));
  const sectionIdsByRow = new Map();
  for (const row of rows) {
    if (!Array.isArray(row.helpSectionIds)) continue;
    for (const sectionId of row.helpSectionIds) {
      if (!sectionIdsByRow.has(sectionId)) sectionIdsByRow.set(sectionId, new Set());
      sectionIdsByRow.get(sectionId).add(String(row.id));
    }
  }
  manifest.sections.forEach((section, index) => {
    if (!section || typeof section.id !== 'string' || section.id.length === 0) {
      failures.push({ rowId: null, code: 'manifest-invalid', detail: `sections[${index}].id` });
      return;
    }
    if (typeof section.count !== 'number' || !Number.isInteger(section.count) || section.count < 0) {
      failures.push({ rowId: null, code: 'manifest-invalid', detail: `sections[${index}].count` });
    }
    if (!Array.isArray(section.rowIds)) {
      failures.push({ rowId: null, code: 'manifest-invalid', detail: `sections[${index}].rowIds` });
      return;
    }
    const linked = section.rowIds.map(String).filter((id) => rowIds.has(id));
    const claimants = sectionIdsByRow.get(section.id);
    let claimed = false;
    if (claimants && typeof section.url === 'string') {
      for (const id of claimants) {
        const claimRow = rowById.get(id);
        if (claimRow && sectionCoversDoc(section.url, claimRow.doc_url)) {
          claimed = true;
          break;
        }
      }
    }
    const mapped = linked.length > 0 || claimed;
    if (!mapped) {
      unmapped.push(section.id);
      if (manifest.complete === true) {
        failures.push({
          rowId: null,
          code: 'unmapped-section',
          detail: section.id,
        });
      }
    }
  });
  return { failures, unmapped };
}

function provenStatus(passing) {
  const has = (key) => passing.has(key);
  const repoOk = has('repo') && has('sha') && has('path');
  const builtinOk = has('creatorApp') && has('dsPath');
  const migratedOk = repoOk && has('catalystProjectId') && has('migrationRecord');
  const verifiedOk = migratedOk && has('testId') && has('e2eEvidence') && has('e2eSha256');
  if (verifiedOk) return 'verified';
  if (migratedOk) return 'migrated';
  if (repoOk) return 'adapter-written';
  if (builtinOk) return 'built-in-Creator';
  return 'not-started';
}

function inspectRow(row, ctx) {
  const failures = [];
  const passing = new Set();
  const evidence = isPlainEvidence(row.evidence) ? row.evidence : null;
  if (!evidence) return { failures, passing };

  const repoResult = checkRepoEvidence(ctx.repo, evidence, ctx.mainRef, ctx.slug);
  for (const failure of repoResult.failures) failures.push(failure);
  for (const key of repoResult.passing) passing.add(key);

  if (typeof evidence.creatorApp === 'string' && evidence.creatorApp.length > 0) {
    if (!evidence.creatorApp.endsWith('.ds')) {
      failures.push({
        code: 'bad-creator-app',
        detail: `${evidence.creatorApp} is a bare app name; creatorApp must be a repo-relative or fixtures-root .ds path`,
      });
    } else {
      const file = resolveAppFile(evidence.creatorApp, ctx);
      if (!file.ok) failures.push({ code: 'bad-creator-app', detail: `${evidence.creatorApp} does not exist` });
      else passing.add('creatorApp');
    }
  }
  if (typeof evidence.dsPath === 'string') {
    if (!evidence.dsPath.endsWith('.ds')) {
      failures.push({ code: 'ds-suffix', detail: evidence.dsPath });
    } else {
      const file = resolveAppFile(evidence.dsPath, ctx);
      if (!file.ok) failures.push({ code: 'missing-ds', detail: evidence.dsPath });
      else passing.add('dsPath');
    }
  }
  if (typeof evidence.catalystProjectId === 'string' && evidence.catalystProjectId.length > 0) {
    if (!CATALYST_PROJECT_ID_RE.test(evidence.catalystProjectId)) {
      failures.push({ code: 'bad-catalyst-project-id', detail: evidence.catalystProjectId });
    } else passing.add('catalystProjectId');
  }
  if (typeof evidence.migrationRecord === 'string') {
    const file = resolveFile(evidence.migrationRecord, ctx.roots);
    if (!file.ok) failures.push({ code: 'missing-migration-record', detail: evidence.migrationRecord });
    else if (fs.statSync(file.abs).size === 0) {
      failures.push({ code: 'missing-migration-record', detail: `${evidence.migrationRecord} is empty` });
    } else passing.add('migrationRecord');
  }
  if (typeof evidence.testId === 'string' && evidence.testId.length > 0) {
    const parsed = parseTestId(evidence.testId);
    const why = badGitPath(parsed.file);
    const sha = evidence.sha;
    if (!parsed.name) {
      failures.push({ code: 'missing-test', detail: `${evidence.testId} must be file#exact full name` });
    } else if (why || !TEST_FILE_RE.test(parsed.file)) {
      failures.push({ code: 'missing-test', detail: evidence.testId });
    } else if (!isCommit(ctx.repo, sha) || !blobAt(ctx.repo, sha, parsed.file)) {
      failures.push({ code: 'missing-test', detail: `${evidence.testId} is not in ${sha}` });
    } else {
      const cacheKey = `${sha}\0${parsed.file}\0${parsed.name}`;
      if (!ctx.testCache.has(cacheKey)) {
        ctx.testCache.set(cacheKey, runTestAtSha(ctx, sha, parsed.file, parsed.name));
      }
      const result = ctx.testCache.get(cacheKey);
      if (!result.ok) failures.push({ code: result.code, detail: result.detail || evidence.testId });
      else passing.add('testId');
    }
  }
  if (typeof evidence.e2eEvidence === 'string') {
    const file = resolveFile(evidence.e2eEvidence, ctx.roots);
    if (!file.ok) failures.push({ code: 'missing-evidence-file', detail: evidence.e2eEvidence });
    else if (fs.statSync(file.abs).size === 0) {
      failures.push({ code: 'missing-evidence-file', detail: `${evidence.e2eEvidence} is empty` });
    } else if (typeof evidence.e2eSha256 === 'string' && /^[0-9a-f]{64}$/.test(evidence.e2eSha256)) {
      const actual = sha256File(file.abs);
      if (actual !== evidence.e2eSha256.toLowerCase()) {
        failures.push({ code: 'evidence-hash-mismatch', detail: evidence.e2eEvidence });
      } else {
        passing.add('e2eEvidence');
        passing.add('e2eSha256');
      }
    } else {
      failures.push({ code: 'evidence-hash-missing', detail: evidence.e2eEvidence });
    }
  }
  return { failures, passing };
}

function isPlainEvidence(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keptEvidence(passing, source) {
  const keys = [];
  const repoOk = passing.has('repo') && passing.has('sha') && passing.has('path');
  const migratedOk = repoOk && passing.has('catalystProjectId') && passing.has('migrationRecord');
  const verifiedOk = migratedOk && passing.has('testId') && passing.has('e2eEvidence') && passing.has('e2eSha256');
  if (passing.has('creatorApp') && passing.has('dsPath')) keys.push('creatorApp', 'dsPath');
  if (repoOk) keys.push('repo', 'sha', 'path');
  if (migratedOk) keys.push('catalystProjectId', 'migrationRecord');
  if (repoOk && passing.has('testId')) keys.push('testId');
  if (verifiedOk) keys.push('e2eEvidence', 'e2eSha256');
  const kept = {};
  for (const key of keys) {
    if (source[key] !== undefined) kept[key] = source[key];
  }
  return kept;
}

function applyDowngrade(row, passing) {
  const claimed = row.status;
  const proven = provenStatus(passing);
  const claimedRank = rankOf(claimed);
  const provenRank = rankOf(proven);
  const next = claimedRank === -1 || provenRank < claimedRank ? proven : claimed;
  const copy = { ...row, status: next };
  const source = isPlainEvidence(row.evidence) ? row.evidence : {};
  const kept = keptEvidence(passing, source);
  if (next === 'not-started' || Object.keys(kept).length === 0) delete copy.evidence;
  else copy.evidence = kept;
  return { row: copy, from: claimed, to: next };
}

function pointerToRowIndex(pointer) {
  const match = /^\/rows\/(\d+)(?:\/|$)/.exec(pointer);
  return match ? Number(match[1]) : null;
}

export function checkMatrix(options) {
  const repo = path.resolve(options.repo || process.cwd());
  const schema = loadJson(options.schemaPath);
  assertSchemaLadder(schema);
  const matrix = loadJson(options.matrixPath);
  const manifest = loadJson(options.manifestPath);
  const mainRef = resolveMainRef(repo, options.mainRef);
  const slug = options.repoSlug || originSlug(repo);
  if (!slug) throw new Error('could not resolve origin repo slug; pass --repo-slug');

  const schemaErrors = validateAgainstSchema(schema, matrix);
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const failures = [];
  for (const error of schemaErrors) {
    const index = pointerToRowIndex(error.path);
    const rowId = index !== null && rows[index] ? rows[index].id ?? index : null;
    failures.push({
      rowId,
      code: 'schema',
      detail: `${error.path || '/'} ${error.message}`,
    });
  }

  const seenIds = new Map();
  rows.forEach((row, index) => {
    const id = row?.id;
    const key = id === undefined ? null : String(id);
    if (key === null) return;
    if (seenIds.has(key)) {
      failures.push({ rowId: id, code: 'schema', detail: `duplicate id ${key}` });
    } else seenIds.set(key, index);
  });

  const roots = (options.evidenceRoots && options.evidenceRoots.length > 0
    ? options.evidenceRoots
    : [repo]
  ).map((root) => path.resolve(root));
  if (!roots.some((root) => path.resolve(root) === repo)) roots.push(repo);

  // options.runCache ({ trees, suites, builds }) lets a caller that checks the
  // same commits more than once share extracted trees and suite runs across
  // calls; the caller then owns cleanup of the extracted trees.
  const shared = options.runCache && typeof options.runCache === 'object' ? options.runCache : null;
  const sharedTrees = shared && shared.trees instanceof Map ? shared.trees : null;
  const ctx = {
    repo,
    mainRef,
    slug,
    roots,
    testCache: new Map(),
    trees: sharedTrees ?? new Map(),
    suites: shared && shared.suites instanceof Map ? shared.suites : new Map(),
    buildCache: shared && shared.builds instanceof Map ? shared.builds : new Map(),
    ownsTrees: !sharedTrees,
  };

  try {
  const downgradedRows = [];
  const downgraded = [];
  rows.forEach((row, index) => {
    const inspected = inspectRow(row && typeof row === 'object' ? row : {}, ctx);
    for (const failure of inspected.failures) {
      failures.push({ rowId: row?.id ?? index, code: failure.code, detail: failure.detail });
    }
    const change = applyDowngrade(row && typeof row === 'object' ? row : { status: 'not-started' }, inspected.passing);
    downgradedRows.push(change.row);
    if (change.from !== change.to) downgraded.push({ id: row?.id ?? index, from: change.from, to: change.to });
  });

  const manifestResult = checkManifest(manifest, rows);
  failures.push(...manifestResult.failures);
  const failedRowIds = new Set(
    failures
      .filter((failure) => failure.rowId !== null && failure.rowId !== undefined)
      .map((failure) => String(failure.rowId)),
  );

  const reasons = {};
  for (const failure of failures) reasons[failure.code] = (reasons[failure.code] || 0) + 1;

  const report = {
    ok: failures.length === 0,
    rows: rows.length,
    failedRows: failedRowIds.size,
    reasons,
    failures,
    unmappedSections: manifestResult.unmapped,
    downgraded,
    mainRef,
    repo: slug,
  };

  if (options.fixDowngrade) {
    const outDoc = {
      schemaVersion: matrix?.schemaVersion ?? 1,
      rows: downgradedRows,
    };
    fs.mkdirSync(path.dirname(path.resolve(options.fixDowngrade)), { recursive: true });
    fs.writeFileSync(options.fixDowngrade, `${JSON.stringify(outDoc, null, 2)}\n`);
    report.downgradePath = path.resolve(options.fixDowngrade);
  }

  return report;
  } finally {
    if (ctx.ownsTrees) {
      for (const entry of ctx.trees.values()) {
        fs.rmSync(entry.root, { recursive: true, force: true });
      }
    }
  }
}

function printReport(report) {
  const lines = [];
  lines.push(report.ok ? 'matrix-check: OK' : 'matrix-check: FAIL');
  lines.push(`rows: ${report.rows} checked, ${report.failedRows} failed`);
  lines.push(`main: ${report.mainRef} repo: ${report.repo}`);
  if (report.unmappedSections.length > 0) {
    lines.push(`unmapped sections (${report.unmappedSections.length}): ${report.unmappedSections.join(', ')}`);
  }
  for (const failure of report.failures) {
    const who = failure.rowId === null || failure.rowId === undefined ? 'manifest' : `row ${failure.rowId}`;
    lines.push(`FAIL ${who} ${failure.code} ${failure.detail}`);
  }
  if (report.downgraded.length > 0) {
    for (const change of report.downgraded) {
      lines.push(`DOWNGRADE row ${change.id} ${change.from} -> ${change.to}`);
    }
  }
  if (report.downgradePath) lines.push(`wrote ${report.downgradePath}`);
  const reasonText = Object.entries(report.reasons)
    .map(([code, count]) => `${code}=${count}`)
    .join(' ');
  if (reasonText) lines.push(`reasons: ${reasonText}`);
  console.log(lines.join('\n'));
  console.log(`MATRIX_CHECK_JSON ${JSON.stringify(report)}`);
}

function parseArgs(argv) {
  const opts = {
    matrixPath: null,
    schemaPath: null,
    manifestPath: null,
    evidenceRoots: [],
    mainRef: null,
    repoSlug: null,
    fixDowngrade: null,
    repo: process.cwd(),
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--schema') opts.schemaPath = next();
    else if (arg === '--manifest') opts.manifestPath = next();
    else if (arg === '--evidence-root') opts.evidenceRoots.push(next());
    else if (arg === '--main-ref') opts.mainRef = next();
    else if (arg === '--repo-slug') opts.repoSlug = next();
    else if (arg === '--fix-downgrade') opts.fixDowngrade = next();
    else if (arg === '--repo') opts.repo = next();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) throw new Error(`unknown argument ${arg}`);
    else positionals.push(arg);
  }
  opts.matrixPath = positionals[0] || null;
  if (positionals.length > 1) throw new Error(`unexpected argument ${positionals[1]}`);
  return opts;
}

function usage() {
  return `usage: node tools/matrix-check.mjs [matrix.json]
  --schema docs/feature-matrix/schema.json
  --manifest docs/feature-matrix/help-sitemap-manifest.json
  --evidence-root DIR   (repeatable; captures may live outside the repo)
  --main-ref origin/main
  --repo-slug owner/name
  --fix-downgrade OUT.json
  --repo DIR`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(usage());
      process.exit(0);
    }
    const repo = path.resolve(opts.repo);
    opts.schemaPath = path.resolve(repo, opts.schemaPath || 'docs/feature-matrix/schema.json');
    opts.manifestPath = path.resolve(repo, opts.manifestPath || 'docs/feature-matrix/help-sitemap-manifest.json');
    opts.matrixPath = path.resolve(repo, opts.matrixPath || 'docs/feature-matrix/matrix.json');
    if (!fs.existsSync(opts.matrixPath)) {
      console.error(`matrix-missing ${opts.matrixPath}`);
      console.error(usage());
      process.exit(1);
    }
    const report = checkMatrix(opts);
    printReport(report);
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exit(1);
  }
}

export { LADDER, REQUIRED_EVIDENCE, accountTap };
