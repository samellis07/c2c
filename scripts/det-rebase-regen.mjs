#!/usr/bin/env node
/**
 * det:rebase-regen — put a branch's determinism regeneration last.
 *
 *   npm run det:rebase-regen [-- --allow-increase "<reason>"]
 *
 * 1. `git fetch origin`.
 * 2. Replay the current HEAD's commits onto origin/main, dropping every
 *    commit whose only changed paths are generated determinism artifacts
 *    (manifests, status doc, decimal audit, quality/coverage gate docs,
 *    builtins catalogue, TODO ratchet baseline) — detected by changed
 *    paths, never by subject. A replay conflict on any other path stops
 *    the run: the repo is restored to its previous HEAD and the run exits
 *    non-zero. Generated-file conflicts never reach this point because
 *    those commits are dropped.
 * 3. Regenerate the artifacts: `npm run determinism:update`,
 *    `npm run determinism:status`, the decimal audit when a gallery is
 *    resolvable, and the TODO ratchet. A ratchet rise is refused unless
 *    `--allow-increase "<reason>"` was passed; the reason is printed.
 * 4. Commit the staged generated paths as `Regenerate determinism
 *    manifests` — always the last commit, using the git-config identity,
 *    no trailers.
 * 5. Print one summary line for the report:
 *    `det:rebase-regen: base=<sha> dropped=<n> regen=<sha|none>`
 *
 * The script never pushes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const COMMIT_MESSAGE = 'Regenerate determinism manifests';

/** Exact generated paths (single files). */
const GENERATED_FILES = new Set([
  'docs/determinism-status.md',
  'docs/decimal-audit.md',
  'docs/quality-gate.md',
  'docs/coverage-gate.md',
  'docs/deluge-builtins.json',
  'tests/ratchet/todo-kinds.json',
]);

/** Generated path prefixes (directories). */
const GENERATED_PREFIXES = ['packages/determinism/test/manifests/'];

function isGenerated(path) {
  return GENERATED_FILES.has(path) || GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function fail(message) {
  process.stderr.write(`det:rebase-regen: ${message}\n`);
  process.exit(1);
}

function warn(message) {
  process.stderr.write(`det:rebase-regen: ${message}\n`);
}

let root = process.cwd();
function git(args, { check = true } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (check && result.status !== 0) {
    fail(`git ${args[0]} failed\n${result.stderr ?? ''}`.trimEnd());
  }
  return result;
}

function gitOut(args) {
  return git(args).stdout.trim();
}

/** Run a long command with inherited stdio; returns the exit status. */
function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (result.error) fail(`cannot run ${cmd}: ${result.error.message}`);
  return result.status ?? 1;
}

function parseArgs(argv) {
  let allowIncrease = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-increase') {
      allowIncrease = argv[++i] ?? '';
    } else if (arg.startsWith('--allow-increase=')) {
      allowIncrease = arg.slice('--allow-increase='.length);
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: npm run det:rebase-regen [-- --allow-increase "<reason>"]\n');
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return { allowIncrease };
}

const { allowIncrease } = parseArgs(process.argv.slice(2));

const toplevel = git(['rev-parse', '--show-toplevel'], { check: false });
if (toplevel.status !== 0) fail('not inside a git worktree');
root = toplevel.stdout.trim();

if (gitOut(['status', '--porcelain'])) {
  fail('worktree is not clean; commit or stash before rebasing');
}

const oldHead = gitOut(['rev-parse', 'HEAD']);

// 1. Fetch.
if (run('git', ['fetch', 'origin']) !== 0) fail('git fetch origin failed');
const baseCheck = git(['rev-parse', '--verify', 'origin/main'], { check: false });
if (baseCheck.status !== 0) fail('origin/main not found after fetch');
const base = baseCheck.stdout.trim();

// 2. Rebase, dropping regen-only commits.
const commits = gitOut(['rev-list', '--reverse', `${base}..HEAD`]).split('\n').filter(Boolean);
if (gitOut(['rev-list', '--merges', `${base}..HEAD`])) {
  fail('the branch contains merge commits; rebase onto origin/main manually');
}

const dropped = [];
const keep = [];
for (const sha of commits) {
  const files = gitOut(['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
    .split('\n')
    .filter(Boolean);
  if (files.length > 0 && files.every(isGenerated)) dropped.push(sha);
  else keep.push(sha);
}

const basedOnTip = git(['merge-base', '--is-ancestor', base, 'HEAD'], { check: false }).status === 0;
if (dropped.length > 0 || !basedOnTip) {
  git(['reset', '--hard', base]);
  if (keep.length > 0) {
    const pick = git(['cherry-pick', ...keep], { check: false });
    if (pick.status !== 0) {
      const unmerged = git(['diff', '--name-only', '--diff-filter=U'], { check: false })
        .stdout.trim().split('\n').filter(Boolean);
      const head = git(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], { check: false });
      const current = head.status === 0 ? head.stdout.trim() : keep[0];
      git(['cherry-pick', '--abort'], { check: false });
      git(['reset', '--hard', oldHead]);
      fail(
        `non-generated conflict replaying ${current.slice(0, 12)}` +
        `${unmerged.length ? ` (${unmerged.join(', ')})` : ''}; ` +
        'the run never resolves code conflicts — rebase onto origin/main manually',
      );
    }
  }
}

// 3. Regenerate.
if (run('npm', ['run', 'determinism:update']) !== 0) fail('determinism:update failed');
if (run('npm', ['run', 'determinism:status']) !== 0) fail('determinism:status failed');

const galleryDir = process.env.C2C_GALLERY_DIR
  ?? (process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'gallery') : null);
const auditTool = join(root, 'dist/determinism/src/decimal-audit.js');
if (galleryDir && existsSync(galleryDir) && existsSync(auditTool)) {
  const audit = spawnSync(process.execPath, [auditTool, galleryDir], { cwd: root, encoding: 'utf8' });
  if (audit.status === 0 && audit.stdout) {
    writeFileSync(join(root, 'docs/decimal-audit.md'), audit.stdout);
  } else {
    warn('decimal audit regeneration failed; docs/decimal-audit.md left as is');
  }
}

const ratchetScript = join(root, 'scripts/update-todo-kinds-ratchet.mjs');
const ratchetArgs = existsSync(ratchetScript)
  ? { cmd: process.execPath, args: [ratchetScript] }
  : { cmd: 'npm', args: ['run', 'ratchet:update', '--'] };
if (allowIncrease !== null) {
  ratchetArgs.args.push('--allow-increase');
  warn(`allow-increase: ${allowIncrease}`);
}
if (run(ratchetArgs.cmd, ratchetArgs.args) !== 0) {
  fail(
    allowIncrease === null
      ? 'TODO ratchet refused; if the rise is intended rerun with --allow-increase "<reason>"'
      : 'ratchet update failed even with --allow-increase',
  );
}

// 4. Stage generated paths and commit the regen as the last commit.
const addPaths = [...GENERATED_FILES, ...GENERATED_PREFIXES].filter((path) =>
  existsSync(join(root, path)),
);
if (addPaths.length > 0) git(['add', '--', ...addPaths]);

let regen = 'none';
if (git(['diff', '--cached', '--quiet'], { check: false }).status !== 0) {
  git(['commit', '-m', COMMIT_MESSAGE]);
  regen = gitOut(['rev-parse', 'HEAD']).slice(0, 12);
}

const leftover = gitOut(['status', '--porcelain']);
if (leftover) {
  warn(`regeneration left non-generated changes unstaged; review and commit them yourself:\n${leftover}`);
}

// 5. Summary.
process.stdout.write(
  `det:rebase-regen: base=${base.slice(0, 12)} dropped=${dropped.length} regen=${regen}\n`,
);
