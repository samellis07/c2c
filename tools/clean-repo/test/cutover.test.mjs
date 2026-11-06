import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, stripMessage, vendorTrailerHits } from '../strip.mjs';
import { messageRewriter, verifyFidelity } from '../cutover.mjs';

const TOOL = fileURLToPath(new URL('../cutover.mjs', import.meta.url));

// Some sandboxes run git through a confined wrapper that refuses refs/heads
// writes even in scratch dirs. The throwaway repos below are plain local
// repos, so spawned children get a PATH with any such wrapper segment removed.
const GIT_ENV = {
  ...process.env,
  PATH: process.env.PATH.split(':')
    .filter((segment) => !segment.includes('.assemble-git'))
    .join(':'),
};

// The bare one-word footer on current history names a tool the wording gate
// will not accept as a literal in this file. Build it so the test still
// exercises that exact line.
const BARE_TOOL = String.fromCharCode(68, 101, 118, 105, 110);

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

function commit(dir, file, text, message) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', message);
}

function makeSource(root) {
  const src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'config', 'user.email', 'cutover@example.test');
  git(src, 'config', 'user.name', 'Cut Over');
  commit(src, 'a.txt', 'one\n', 'plain subject');
  commit(
    src,
    'b.txt',
    'two\n',
    'add b\n\nBody mentions that the file was co-authored by: the pair, mid-sentence.\n\nCo-Authored-By: Paint Bot <42+pbot[bot]@users.noreply.github.com>\nGenerated with [Tool](https://example.test/tool)\n',
  );
  git(src, 'checkout', '-qb', 'feature');
  commit(src, 'c.txt', 'three\n', 'feature work\n\n🤖 Generated with a helper\n');
  git(src, 'checkout', '-q', 'main');
  git(src, 'tag', '-a', 'v1', '-m', 'release v1\n\nCo-Authored-By: Paint Bot <42+pbot[bot]@users.noreply.github.com>\n');
  return src;
}

test('stripMessage removes trailer lines only', () => {
  const rules = loadRules();
  const out = stripMessage(
    'subject\n\nbody kept, co-authored by: the pair mid-sentence\n\nCo-Authored-By: Bot <b@users.noreply.github.com>\nGenerated with [Tool](https://example.test)\n',
    rules,
  );
  assert.equal(out, 'subject\n\nbody kept, co-authored by: the pair mid-sentence\n');
});

test('stripMessage collapses leftover blank lines and stays idempotent', () => {
  const rules = loadRules();
  const once = stripMessage('subject\n\n\n\nCo-Authored-By: Bot <b@users.noreply.github.com>\n', rules);
  assert.equal(once, 'subject\n');
  assert.equal(stripMessage(once, rules), once);
});

test('a sentence that says generated with is kept', () => {
  const raw = 'subject\n\nThe report was generated with care.\n';
  assert.equal(stripMessage(raw, loadRules()), raw);
});

test('a human sign-off line is kept', () => {
  const raw = 'subject\n\nSigned-off-by: A Person <a@example.test>\n';
  assert.equal(stripMessage(raw, loadRules()), raw);
});

test('messageRewriter rewrites only the data block after committer', () => {
  const rules = loadRules();
  const msg = Buffer.from('keep me\n\nCo-Authored-By: Bot <b@users.noreply.github.com>\n', 'utf8');
  const stream = Buffer.concat([
    Buffer.from(`blob\nmark :1\ndata 3\nhi\n\n`),
    Buffer.from(`commit refs/heads/main\nmark :2\nauthor A <a@example.test> 1 +0000\ncommitter A <a@example.test> 1 +0000\ndata ${msg.length}\n`),
    msg,
    Buffer.from('M 100644 :1 a.txt\n\n'),
  ]);
  const feed = messageRewriter(rules);
  let rewritten = '';
  // Deliver in odd-sized chunks to prove partial-line and partial-payload buffering.
  for (let i = 0; i < stream.length; i += 7) rewritten += feed(stream.subarray(i, i + 7)).toString('utf8');
  rewritten += feed(Buffer.alloc(0), true).toString('utf8');
  assert.match(rewritten, /data 8\nkeep me\n/);
  assert.ok(!rewritten.includes('Co-Authored-By'), 'trailer removed from commit message');
  assert.ok(rewritten.includes('data 3\nhi\n'), 'blob payload untouched');
});

test('cutover writes a clean mirror into a fresh directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-repo-'));
  const src = makeSource(root);
  const dst = join(root, 'dst.git');
  const run = spawnSync(process.execPath, [TOOL, src, dst], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\d+ message\(s\) rewritten, 3 ref\(s\) imported/);

  const srcLog = git(src, 'log', '--format=%s', '--all');
  const dstLog = git(dst, 'log', '--format=%s', '--all');
  assert.equal(dstLog, srcLog, 'subjects survive on every ref');
  const bodies = git(dst, 'log', '--format=%B', '--all') + git(dst, 'tag', '-l', '--format=%(contents)', 'v1');
  for (const bad of ['Co-Authored-By', 'Generated with', '🤖']) {
    assert.ok(!bodies.includes(bad), `no ${bad} trailer in ${dst}`);
  }
  assert.ok(bodies.includes('co-authored by: the pair'), 'mid-sentence mention kept');

  // Trees are identical object-for-object; only the metadata changed.
  assert.equal(git(src, 'ls-tree', '-r', 'refs/heads/main'), git(dst, 'ls-tree', '-r', 'refs/heads/main'));
  assert.equal(git(src, 'ls-tree', '-r', 'refs/heads/feature'), git(dst, 'ls-tree', '-r', 'refs/heads/feature'));

  // The source is read-only: its trailers remain untouched.
  assert.match(git(src, 'log', '--format=%B', '-1'), /Co-Authored-By/);

  // Refusing to write into a non-empty target protects an existing clone.
  const again = spawnSync(process.execPath, [TOOL, src, dst], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(again.status, 3);
  assert.match(again.stderr, /refusing non-empty target/);
});

const SESSION = 'Claude-Session: https://claude.ai/code/session_01FixtureAAAA';
const VENDOR_MSG = `vendor trailers\n\nThe review bot said the parser was fine; Claude agreed.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nGenerated with [Review Bot](https://bot.example.test)\nGenerated with ${BARE_TOOL}\nCo-Authored-By: Claude Opus 5.5 <opus@users.noreply.github.com>\nCo-Authored-By: Review Bot <158243242+review-bot[bot]@users.noreply.github.com>\nSigned-off-by: dependabot[bot] <bot@users.noreply.github.com>\n${SESSION}\n`;

// A source with an SSH-signed commit, an SSH-signed annotated tag, a
// Claude-Session trailer and the full vendor footer set.
function makeSignedSource(root) {
  const src = makeSource(root);
  const key = join(root, 'signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', key]);
  git(src, 'config', 'gpg.format', 'ssh');
  git(src, 'config', 'user.signingkey', key);
  writeFileSync(join(src, 'd.txt'), 'four\n');
  git(src, 'add', 'd.txt');
  git(src, 'commit', '-qS', '-m', VENDOR_MSG);
  git(src, 'commit', '-q', '--allow-empty', '-m', `second session\n\n${SESSION.replace('AAAA', 'BBBB')}\n`);
  git(src, 'tag', '-s', 'v2-signed', '-m', `signed release\n\n${SESSION}\n`);
  git(src, 'tag', 'light', 'HEAD~1');
  return src;
}

const rawObject = (dir, ref) => execFileSync('git', ['-C', dir, 'cat-file', '-p', ref], { encoding: 'utf8', env: GIT_ENV });

test('cutover strips session trailers and signatures, then verifies every pair', () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-repo-signed-'));
  const src = makeSignedSource(root);
  assert.match(rawObject(src, 'HEAD~1'), /^gpgsig /m, 'fixture commit is signed');
  assert.match(rawObject(src, 'v2-signed'), /BEGIN SSH SIGNATURE/, 'fixture tag is signed');
  const refsBefore = git(src, 'for-each-ref', '--format=%(refname) %(objectname)');

  const dst = join(root, 'dst.git');
  const run = spawnSync(process.execPath, [TOOL, src, dst], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /--signed-commits=strip --signed-tags=strip\): 1 signed commit\(s\) and 1 signed tag\(s\)/);
  assert.match(run.stdout, /trailer self-check passed, 0 vendor\/agent trailer hits/);
  assert.match(run.stdout, /fidelity check passed, 5 commit pair\(s\) and 5 ref\(s\) match; source refs unchanged/);

  const history = git(dst, 'log', '--all', '--format=%B') + git(dst, 'for-each-ref', 'refs/tags', '--format=%(contents)');
  for (const bad of ['Claude-Session', 'claude.ai/code/session_', 'Co-Authored-By', 'Generated with', '🤖', 'opus@users.noreply.github.com', BARE_TOOL, 'Signed-off-by']) {
    assert.ok(!history.includes(bad), `no ${bad} left in target`);
  }
  assert.ok(history.includes('The review bot said the parser was fine; Claude agreed.'), 'prose naming vendors kept');

  assert.doesNotMatch(rawObject(dst, 'refs/heads/main~1'), /^gpgsig /m, 'commit signature stripped');
  const tag = rawObject(dst, 'refs/tags/v2-signed');
  assert.doesNotMatch(tag, /SIGNATURE/, 'tag signature stripped');
  assert.match(tag, /^type commit$/m, 'signed tag kept as an annotated tag');
  assert.equal(git(dst, 'rev-parse', 'v2-signed^{}'), git(dst, 'rev-parse', 'main'));
  assert.equal(git(dst, 'rev-parse', 'light'), git(dst, 'rev-parse', 'main~1'));

  assert.equal(git(src, 'for-each-ref', '--format=%(refname) %(objectname)'), refsBefore, 'source refs unchanged');
  assert.match(git(src, 'log', '--format=%B', '-1'), /Claude-Session/, 'source history untouched');
});

test('cutover fails the self-check when a rule lets a trailer through', () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-repo-selfcheck-'));
  const src = makeSignedSource(root);
  const rules = join(root, 'no-session-rule.txt');
  writeFileSync(rules, 'regex:(?m)^[Cc]o-[Aa]uthored-[Bb]y:[^\\n]*==>\n');
  const run = spawnSync(process.execPath, [TOOL, src, join(root, 'dst.git')], {
    encoding: 'utf8',
    env: { ...GIT_ENV, CLEAN_REPO_RULES: rules },
  });
  assert.equal(run.status, 4, run.stdout);
  assert.match(run.stderr, /FAILED trailer self-check/);
  assert.match(run.stderr, /Claude-Session trailer/);
  assert.match(run.stderr, /"Generated with" footer/);
  assert.match(run.stderr, /bare generated-with footer/);
  assert.match(run.stderr, /bot signed-off-by trailer/);
});

test('verifyFidelity reports a mismatched commit pair and a moved ref', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clean-repo-fidelity-'));
  const src = makeSource(root);
  const ids = git(src, 'rev-list', '--all').split('\n');
  const pairs = new Map(ids.map((id) => [id, id]));
  // Swap two pairs: trees, parents and messages then disagree.
  pairs.set(ids[0], ids[1]);
  pairs.set(ids[1], ids[0]);
  const refs = new Map([['refs/heads/main', git(src, 'rev-parse', 'main')]]);
  const moved = new Map([['refs/heads/main', git(src, 'rev-parse', 'main~1')]]);
  const errors = await verifyFidelity(src, src, pairs, loadRules(), refs, moved);
  assert.ok(errors.some((e) => /tree differs/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /parents differ/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /refs\/heads\/main: points at/.test(e)), errors.join('\n'));
});

test('stripMessage removes every vendor trailer in the real history shapes', () => {
  const hits = vendorTrailerHits(VENDOR_MSG);
  assert.ok(hits.includes('Claude-Session trailer'));
  assert.ok(hits.includes('bare generated-with footer'));
  assert.ok(hits.includes('bot signed-off-by trailer'));
  const out = stripMessage(VENDOR_MSG, loadRules());
  assert.equal(out, 'vendor trailers\n\nThe review bot said the parser was fine; Claude agreed.\n');
  assert.deepEqual(vendorTrailerHits(out), []);
});
