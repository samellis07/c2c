#!/usr/bin/env node
/**
 * Clean-repo cutover: copy a repository's full history into a NEW directory
 * with the trailer rules in replace-msg.txt applied to every commit and tag
 * message. The source is only ever read: `git fast-export --all` streams out
 * of it, this script rewrites the `data` blocks that carry messages, and
 * `git fast-import` lands the result in a fresh `--bare` init.
 *
 * Usage: node tools/clean-repo/cutover.mjs <source-repo> <target-dir>
 * (full docs: tools/clean-repo/README.md)
 *
 * The same rules file can be handed to `git filter-repo --replace-msg` when
 * that tool is preferred; this script exists so the cutover needs nothing
 * beyond git and node.
 *
 * Commits are unchanged apart from their messages, so every tree, parentage,
 * author, committer, timestamp, branch and tag survives; only object ids move.
 *
 * Signatures: a signature covers the object id, and every rewritten commit
 * gets a new id, so NO commit or tag signature can survive. The export runs
 * with `--signed-commits=strip --signed-tags=strip`: signed commits land as
 * ordinary unsigned commits and signed annotated tags land as unsigned
 * annotated tags (same name, tagger, date, message and target). Re-sign in
 * the new repository afterwards if signatures are required. The tool counts
 * the signed objects it found in the source and prints that loss.
 *
 * After import the tool verifies, and exits non-zero (target unusable) when:
 *   4  a vendor/agent trailer (VENDOR_TRAILER_CHECKS in strip.mjs) survives
 *      in any commit or tag message of the target;
 *   5  any source/target commit pair differs in tree, parents (mapped),
 *      author, committer, dates, encoding or expected message; any ref or
 *      annotated tag differs; or the source refs changed during the run.
 * CLEAN_REPO_RULES=<file> overrides replace-msg.txt (used by the tests).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadRules, stripMessage, vendorTrailerHits } from './strip.mjs';

function usage(code) {
  process.stderr.write('usage: node tools/clean-repo/cutover.mjs <source-repo> <target-dir>\n');
  process.exit(code);
}

function git(args, opts = {}) {
  return new Promise((done, fail) => {
    const child = spawn('git', args, { stdio: opts.stdio ?? ['ignore', 'pipe', 'inherit'] });
    const chunks = [];
    if (child.stdout) child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', fail);
    child.on('close', (code) => {
      if (code === 0) done(Buffer.concat(chunks));
      else fail(new Error(`git ${args.join(' ')} exited ${code}`));
    });
  });
}

/**
 * Transform one fast-export stream: rewrite the `data <n>` payload that
 * follows a `committer` or `tagger` line (the commit/tag message) and pass
 * every other byte through untouched. Buffers incomplete lines and payloads
 * until the source delivers them.
 */
export function messageRewriter(rules, onCount) {
  let pending = Buffer.alloc(0);
  let pos = 0;
  let nextDataIsMessage = false;
  let nextDataIsTag = false;
  // Returns the output bytes currently decodable; call once more with
  // flushed=true at end of stream.
  function feed(chunk, flushed = false) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const out = [];
    for (;;) {
      const nl = pending.indexOf(0x0a, pos);
      if (nl === -1) {
        if (!flushed) break;
        if (pos < pending.length) out.push(pending.subarray(pos));
        pos = pending.length;
        break;
      }
      const line = pending.subarray(pos, nl + 1);
      const text = line.toString('utf8');
      const data = /^data (\d+)\n$/.exec(text);
      if (data) {
        const need = Number(data[1]);
        if (nl + 1 + need > pending.length && !flushed) break; // wait for the payload
        const payload = pending.subarray(nl + 1, nl + 1 + need);
        if (nextDataIsMessage) {
          // Apple Git-155's --signed-tags=strip only knows PGP blocks, so an
          // SSH tag signature would ride along in the message; drop it here.
          const raw = payload.toString('utf8');
          const message = nextDataIsTag ? unsignedTagMessage(raw) : raw;
          const stripped = Buffer.from(stripMessage(message, rules), 'utf8');
          out.push(Buffer.from(`data ${stripped.length}\n`), stripped);
          onCount?.();
        } else {
          out.push(line, payload);
        }
        pos = nl + 1 + need;
        nextDataIsMessage = false;
        nextDataIsTag = false;
        continue;
      }
      out.push(line);
      // Sticky until the next data block: an `encoding` header may sit
      // between the committer line and the message payload.
      if (/^committer |^tagger /.test(text)) nextDataIsMessage = true;
      if (/^tagger /.test(text)) nextDataIsTag = true;
      pos = nl + 1;
    }
    pending = pending.subarray(pos);
    pos = 0;
    return Buffer.concat(out);
  }
  return feed;
}

/** Raw object bodies for `ids`, via one `git cat-file --batch`. */
export async function readObjects(repo, ids) {
  const out = await new Promise((done, fail) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(Buffer.concat(chunks)) : fail(new Error(`git cat-file exited ${code}`))));
    child.stdin.end(ids.map((id) => `${id}\n`).join(''));
  });
  const objects = new Map();
  let pos = 0;
  for (const id of ids) {
    const nl = out.indexOf(0x0a, pos);
    const [, type, size] = out.subarray(pos, nl).toString('utf8').split(' ');
    if (type === undefined || size === undefined) throw new Error(`cat-file: missing object ${id}`);
    const body = out.subarray(nl + 1, nl + 1 + Number(size));
    objects.set(id, { type, body: body.toString('utf8') });
    pos = nl + 1 + Number(size) + 1;
  }
  return objects;
}

/**
 * Split a raw commit or tag body into header fields and message. Multi-line
 * headers (gpgsig, mergetag) keep their continuation lines.
 */
export function parseObject(body) {
  const split = body.indexOf('\n\n');
  const headerText = split === -1 ? body : body.slice(0, split);
  const message = split === -1 ? '' : body.slice(split + 2);
  const headers = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ') && headers.length) headers[headers.length - 1].value += `\n${line.slice(1)}`;
    else {
      const sp = line.indexOf(' ');
      headers.push({ key: line.slice(0, sp), value: line.slice(sp + 1) });
    }
  }
  const one = (key) => headers.find((h) => h.key === key)?.value;
  const all = (key) => headers.filter((h) => h.key === key).map((h) => h.value);
  return { headers, one, all, message };
}

const SIGNATURE_BLOCK = /(^|\n)-----BEGIN (PGP|SSH|SIGNED) [A-Z ]*-----\n[\s\S]*$/;

/** A tag message with its trailing signature block removed. */
export function unsignedTagMessage(message) {
  return message.replace(SIGNATURE_BLOCK, '$1');
}

/** `refname -> objectname` for every non-symbolic ref. */
async function refMap(repo) {
  const text = (await git(['-C', repo, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)'])).toString();
  const refs = new Map();
  for (const line of text.split('\n')) {
    const [name, id, symref] = line.split(' ');
    if (name && !symref) refs.set(name, id);
  }
  return refs;
}

/** `mark -> object id` from a fast-export / fast-import marks file. */
function readMarks(file) {
  const marks = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [mark, id] = line.split(' ');
    if (mark && id) marks.set(mark, id);
  }
  return marks;
}

/**
 * Compare every source/target commit pair and every ref. `pairs` maps a
 * source commit id to its target id. Returns a list of human-readable
 * mismatches (empty when the target is a faithful copy).
 */
export async function verifyFidelity(src, dst, pairs, rules, srcRefs, dstRefs) {
  const errors = [];
  const srcIds = [...pairs.keys()];
  const srcObjs = await readObjects(src, srcIds);
  const dstObjs = await readObjects(dst, srcIds.map((id) => pairs.get(id)));
  for (const sid of srcIds) {
    const tid = pairs.get(sid);
    const a = parseObject(srcObjs.get(sid).body);
    const b = parseObject(dstObjs.get(tid).body);
    const where = `commit ${sid.slice(0, 12)} -> ${tid.slice(0, 12)}`;
    if (dstObjs.get(tid).type !== 'commit') { errors.push(`${where}: target is not a commit`); continue; }
    for (const key of ['tree', 'author', 'committer', 'encoding']) {
      if (a.one(key) !== b.one(key)) errors.push(`${where}: ${key} differs`);
    }
    const mapped = a.all('parent').map((p) => pairs.get(p) ?? `unmapped:${p}`);
    if (mapped.join(' ') !== b.all('parent').join(' ')) errors.push(`${where}: parents differ`);
    if (b.one('gpgsig') !== undefined) errors.push(`${where}: target still carries a signature`);
    if (b.message !== stripMessage(a.message, rules)) errors.push(`${where}: message is not the rule-stripped source message`);
  }

  const srcNames = [...srcRefs.keys()].sort();
  const dstNames = [...dstRefs.keys()].sort();
  if (srcNames.join('\n') !== dstNames.join('\n')) errors.push(`ref sets differ: source [${srcNames.join(', ')}] target [${dstNames.join(', ')}]`);
  const srcRefObjs = await readObjects(src, [...new Set(srcRefs.values())]);
  const dstRefObjs = await readObjects(dst, [...new Set([...dstRefs.values()])]);
  for (const name of srcNames) {
    const sid = srcRefs.get(name);
    const tid = dstRefs.get(name);
    if (!tid) continue;
    const s = srcRefObjs.get(sid);
    const t = dstRefObjs.get(tid);
    if (s.type !== t.type) { errors.push(`${name}: object type ${s.type} became ${t.type}`); continue; }
    if (s.type === 'commit') {
      if (pairs.get(sid) !== tid) errors.push(`${name}: points at ${tid.slice(0, 12)}, expected ${pairs.get(sid)?.slice(0, 12)}`);
    } else if (s.type === 'tag') {
      const a = parseObject(s.body);
      const b = parseObject(t.body);
      for (const key of ['type', 'tag', 'tagger']) {
        if (a.one(key) !== b.one(key)) errors.push(`${name}: tag ${key} differs`);
      }
      const object = a.one('type') === 'commit' ? pairs.get(a.one('object')) : a.one('object');
      if (object !== b.one('object')) errors.push(`${name}: tag target differs`);
      if (SIGNATURE_BLOCK.test(b.message) || b.one('gpgsig') !== undefined) errors.push(`${name}: target tag still carries a signature`);
      if (b.message !== stripMessage(unsignedTagMessage(a.message), rules)) errors.push(`${name}: tag message is not the rule-stripped source message`);
    } else if (sid !== tid) {
      errors.push(`${name}: ${s.type} id changed`);
    }
  }
  return errors;
}

/** Every vendor/agent trailer left in the target's commit and tag messages. */
export async function trailerSelfCheck(dst) {
  const hits = [];
  const commits = (await git(['-C', dst, 'log', '--all', '--format=%H%x00%B%x01'])).toString().split('\x01');
  for (const record of commits) {
    const [id, message] = record.replace(/^\n/, '').split('\0');
    if (id && message !== undefined) for (const name of vendorTrailerHits(message)) hits.push(`commit ${id.slice(0, 12)}: ${name}`);
  }
  const tags = (await git(['-C', dst, 'for-each-ref', 'refs/tags', '--format=%(refname)%00%(contents)%01'])).toString().split('\x01');
  for (const record of tags) {
    const [name, message] = record.replace(/^\n/, '').split('\0');
    if (name && message !== undefined) for (const hit of vendorTrailerHits(message)) hits.push(`${name}: ${hit}`);
  }
  return hits;
}

/** Count signed commits and signed annotated tags reachable from `refs`. */
async function countSigned(repo, refs) {
  const ids = (await git(['-C', repo, 'rev-list', '--all'])).toString().split('\n').filter(Boolean);
  let commits = 0;
  for (const { body } of (await readObjects(repo, ids)).values()) {
    if (parseObject(body).one('gpgsig') !== undefined) commits++;
  }
  let tags = 0;
  for (const { type, body } of (await readObjects(repo, [...new Set(refs.values())])).values()) {
    if (type === 'tag' && (SIGNATURE_BLOCK.test(parseObject(body).message) || parseObject(body).one('gpgsig') !== undefined)) tags++;
  }
  return { commits, tags };
}

const sameRefs = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

async function main(argv) {
  const [srcArg, dstArg] = argv;
  if (!srcArg || !dstArg || srcArg.startsWith('-') || dstArg.startsWith('-')) usage(2);
  const src = resolve(srcArg);
  const dst = resolve(dstArg);
  if (!existsSync(src)) {
    process.stderr.write(`cutover: no such source: ${src}\n`);
    return 3;
  }
  const top = (await git(['-C', src, 'rev-parse', '--git-dir'], { stdio: ['ignore', 'pipe', 'pipe'] })).toString().trim();
  if (!top) {
    process.stderr.write(`cutover: not a git repository: ${src}\n`);
    return 3;
  }
  if (existsSync(dst) && readdirSync(dst).length) {
    process.stderr.write(`cutover: refusing non-empty target: ${dst}\n`);
    return 3;
  }
  const srcRefsBefore = await refMap(src);
  const signed = await countSigned(src, srcRefsBefore);
  mkdirSync(dst, { recursive: true });
  await git(['init', '--bare', '-q', dst]);

  const rules = loadRules(process.env.CLEAN_REPO_RULES || undefined);
  let rewritten = 0;
  const feed = messageRewriter(rules, () => rewritten++);
  const work = mkdtempSync(join(tmpdir(), 'clean-repo-marks-'));
  const srcMarks = join(work, 'source.marks');
  const dstMarks = join(work, 'target.marks');
  try {
    // No --quiet: on Apple Git-155 it truncates the stream (blob records go
    // missing). Progress lines go to stderr, which is inherited anyway.
    // Signatures cannot survive new object ids, so strip them explicitly.
    const exporter = spawn(
      'git',
      ['-C', src, 'fast-export', '--all', '--signed-commits=strip', '--signed-tags=strip', '--reencode=no', `--export-marks=${srcMarks}`],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const importer = spawn('git', ['-C', dst, 'fast-import', '--quiet', `--export-marks=${dstMarks}`], { stdio: ['pipe', 'inherit', 'inherit'] });
    const exitOf = (child) => new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', (code) => (code === 0 ? done() : fail(new Error(`git exited ${code}`))));
    });
    importer.stdin.on('drain', () => exporter.stdout.resume());
    exporter.stdout.on('data', (chunk) => {
      if (!importer.stdin.write(feed(chunk))) exporter.stdout.pause();
    });
    exporter.stdout.on('end', () => importer.stdin.end(feed(Buffer.alloc(0), true)));
    await Promise.all([exitOf(exporter), exitOf(importer)]);

    const dstRefs = await refMap(dst);
    process.stdout.write(`cutover: ${rewritten} message(s) rewritten, ${dstRefs.size} ref(s) imported into ${dst}\n`);
    process.stdout.write(
      `cutover: signatures stripped (--signed-commits=strip --signed-tags=strip): ${signed.commits} signed commit(s) and ${signed.tags} signed tag(s) in the source are unsigned in the target; rewritten objects cannot keep signatures\n`,
    );

    const hits = await trailerSelfCheck(dst);
    if (hits.length) {
      process.stderr.write(`cutover: FAILED trailer self-check, ${hits.length} hit(s); do not use ${dst}\n${hits.map((h) => `  ${h}\n`).join('')}`);
      return 4;
    }
    process.stdout.write('cutover: trailer self-check passed, 0 vendor/agent trailer hits\n');

    const srcIdByMark = readMarks(srcMarks);
    const dstIdByMark = readMarks(dstMarks);
    const pairs = new Map();
    for (const [mark, sid] of srcIdByMark) {
      const tid = dstIdByMark.get(mark);
      if (tid) pairs.set(sid, tid);
    }
    const srcCommits = new Set((await git(['-C', src, 'rev-list', '--all'])).toString().split('\n').filter(Boolean));
    for (const id of [...pairs.keys()]) if (!srcCommits.has(id)) pairs.delete(id); // blobs keep their ids
    const errors = await verifyFidelity(src, dst, pairs, rules, srcRefsBefore, dstRefs);
    if (pairs.size !== srcCommits.size) errors.push(`commit count: source ${srcCommits.size}, paired ${pairs.size}`);
    if (!sameRefs(srcRefsBefore, await refMap(src))) errors.push('source refs changed during the cutover');
    if (errors.length) {
      process.stderr.write(`cutover: FAILED fidelity check, ${errors.length} mismatch(es); do not use ${dst}\n${errors.slice(0, 50).map((e) => `  ${e}\n`).join('')}`);
      return 5;
    }
    process.stdout.write(`cutover: fidelity check passed, ${pairs.size} commit pair(s) and ${dstRefs.size} ref(s) match; source refs unchanged\n`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('cutover.mjs')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`cutover: ${err.message}\n`);
      process.exit(1);
    },
  );
}
