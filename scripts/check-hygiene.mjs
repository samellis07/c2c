#!/usr/bin/env node
/**
 * Generic check for a public tree.
 *
 * Fails when a tracked text file contains:
 * - an absolute home-directory path
 * - an email address whose domain is not example.com, example.test,
 *   users.noreply.github.com, or a subdomain of example.com / example.test
 * - an 11-digit organisation id or a 17-digit project id that is not on the
 *   placeholder list below and does not sit in a vendored file listed below
 * - any other 13 to 19 digit id (record, form, field ids) that is not on the
 *   placeholder list and is not obviously synthetic (see longIdAllowed)
 * - in a test file, a spawnSync/execFileSync/spawn call whose '-e' / '--eval'
 *   / env value is built from a file read, a JSON.stringify of a *SOURCE* /
 *   *runtime* value, or a *SOURCE* / *runtime* named variable (see
 *   scanInlineArgs: one Linux argument is capped at 128 KB while macOS
 *   allows far more, so such a spawn passes locally and fails Linux CI)
 *
 * Two quoted vendor addresses are allowed because the product repeats them.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Synthetic ids used in fixtures and docs. A new id of these shapes must be added here. */
export const PLACEHOLDERS = new Set([
  '10000000000',
  '10000000000000001',
  '10000000000000002',
  '10000000000000003',
  '10000000000000004',
  '10000000000000005',
  '10000000000000006',
  '10000000000000007',
  '10000000000000099',
  '10000000001',
  '10000000002',
  '10000000000000012',
  '10000000000000013',
  '10000000000013003',
  '10000000000013004',
  '10000000000013005',
  '10000000000013007',
  '10000000000013008',
  '10000000000013009',
  '10000000000013011',
  '10000000000013012',
  '10000000000013100',
  '10000000000013101',
  '10000000000013200',
  '10000000000099001',
  '00000000000000000',
  '10000000000315012',
  '10000000000315013',
  '10000000000315014',
  '10000000000315015',
  '10000000000315016',
  '10000000008009043',
  '12345678901234567',
  // Upstream sample id from the redistributable freight fixture.
  '45759510000278003',
]);

/**
 * Numeric constants that are not ids: the edges of exact float and 64-bit
 * integer precision that the precision tests exercise.
 */
const NUMERIC_CONSTANTS = new Set([
  '9007199254740991',
  '9007199254740992',
  '9007199254740993',
  '9007199254740994',
  '9007199515875289',
  '9223372036854775807',
  '9223372036854775808',
]);

/** Epoch milliseconds between 2000-01-01 and 2100-01-01 are timestamps, not ids. */
const EPOCH_MS_MIN = Date.UTC(2000, 0, 1);
const EPOCH_MS_MAX = Date.UTC(2100, 0, 1);

/**
 * A 13 to 19 digit run (other than a 17-digit project id) passes when it is a
 * placeholder, a known numeric constant, an epoch-millisecond timestamp
 * (13 digits), a repeated digit (00000..., 99999...), a run of the sequence
 * 1234567890..., or an obviously synthetic id: one or two leading digits
 * followed by at least six zeros (1000000000000000001, 4400000000000000123).
 */
export function longIdAllowed(digits) {
  if (PLACEHOLDERS.has(digits) || NUMERIC_CONSTANTS.has(digits)) return true;
  if (digits.length === 13) {
    const n = Number(digits);
    if (n >= EPOCH_MS_MIN && n < EPOCH_MS_MAX) return true;
  }
  if (/^(\d)\1+$/.test(digits)) return true;
  if ('12345678901234567890'.startsWith(digits)) return true;
  return /^[1-9]\d?0{6,}/.test(digits);
}

// Copied dialling-code samples carry 11-digit example numbers that are not ids.
const VENDORED_ID_SAMPLES = new Set([
  'packages/ui-react/template/lib/c2c-ui/arc/components/phone-input/phone-input.tsx',
]);

// Redistributable upstream Creator exports keep their own ids verbatim.
const VENDORED_ID_DIRS = ['fixtures/redistributable/'];

const PRODUCT_ADDRESSES = new Set([
  'support@zohocreator.com',
  'notifications@zohocreatormail.example',
]);

const SKIP = /(^|\/)(node_modules|dist)\/|\.(png|jpe?g|gif|ico|pdf|zip|woff2?|ttf|otf|lock)$|package-lock\.json$/;

const HOME = [
  new RegExp('/' + 'Users' + '/' + '[A-Za-z0-9._-]+/'),
  new RegExp('/' + 'home' + '/' + '[a-z][a-z0-9_-]*/'),
  new RegExp('C:' + '\\\\' + 'Users' + '\\\\'),
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Standalone digit runs. A hash fragment or the fraction of a decimal is not an id.
// A trailing bigint `n` still counts.
const ORG_ID = /(?<![A-Za-z0-9.])\d{11}(?=n?(?![A-Za-z0-9]))/g;
const PROJECT_ID = /(?<![A-Za-z0-9.])\d{17}(?=n?(?![A-Za-z0-9]))/g;
const LONG_ID = /(?<![A-Za-z0-9.])(?:\d{13,16}|\d{18,19})(?=n?(?![A-Za-z0-9]))/g;

function domainAllowed(address) {
  const lower = address.toLowerCase();
  if (PRODUCT_ADDRESSES.has(lower)) return true;
  const at = lower.lastIndexOf('@');
  if (at < 0) return false;
  const domain = lower.slice(at + 1).replace(/\.$/, '');
  if (domain === 'example.com' || domain.endsWith('.example.com')) return true;
  if (domain === 'example.test' || domain.endsWith('.example.test')) return true;
  if (domain === 'users.noreply.github.com') return true;
  return false;
}

function scanLine(file, line, lineNo, hits, skipIds) {
  for (const re of HOME) {
    re.lastIndex = 0;
    if (re.test(line)) hits.push(`${file}:${lineNo}: home-path`);
  }
  EMAIL.lastIndex = 0;
  for (const match of line.matchAll(EMAIL)) {
    const start = match.index ?? 0;
    if (start > 0 && line[start - 1] === ':') continue;
    if (!domainAllowed(match[0])) hits.push(`${file}:${lineNo}: email`);
  }
  if (skipIds) return;
  ORG_ID.lastIndex = 0;
  for (const match of line.matchAll(ORG_ID)) {
    if (!PLACEHOLDERS.has(match[0])) hits.push(`${file}:${lineNo}: org-id`);
  }
  PROJECT_ID.lastIndex = 0;
  for (const match of line.matchAll(PROJECT_ID)) {
    if (!PLACEHOLDERS.has(match[0])) hits.push(`${file}:${lineNo}: project-id`);
  }
  LONG_ID.lastIndex = 0;
  for (const match of line.matchAll(LONG_ID)) {
    if (!longIdAllowed(match[0])) hits.push(`${file}:${lineNo}: long-id`);
  }
}

export function scanText(file, text) {
  const hits = [];
  if (text.includes('\0')) return hits;
  // The same files also ship inside plugin/vendor/c2c/, so match on the suffix.
  const skipIds =
    VENDORED_ID_SAMPLES.has(file) ||
    [...VENDORED_ID_SAMPLES].some((vendored) => file.endsWith(`/${vendored}`)) ||
    VENDORED_ID_DIRS.some((dir) => file.startsWith(dir));
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) scanLine(file, lines[i], i + 1, hits, skipIds);
  return hits;
}

/**
 * Copies of rejected spawns that the inline-arg rule must flag. The tree scan
 * skips this directory (the files deliberately violate the rule); the unit
 * test in tests/plugin/hygiene.test.mjs feeds them to scanInlineArgs
 * directly, so the guard is proven to fail on them while the tree passes.
 */
const INLINE_ARG_FIXTURE_DIRS = ['tests/plugin/fixtures/inline-arg/'];

function isTestFile(file) {
  return /\.test\.[cm]?[jt]s$/.test(file) || /(^|\/)tests?\/.*\.[cm]?[jt]s$/.test(file);
}

/** A spawn call site: spawnSync, execFileSync, or spawn, called, not `x.spawn`. */
const SPAWN_CALL = /(?<![\w$.])(spawnSync|execFileSync|spawn)\s*\(/g;

/** The node eval flags that inline a script in one argument. */
const EVAL_FLAG = /(['"])-(-eval|e)\1/;

/**
 * A file read feeding the spawn. A read of fd 0 (child stdin) is not a file
 * read: piping a fixture through stdin stays far under the argument cap.
 */
const INLINE_FILE_READ = /(?<![\w$])readFile(Sync)?\s*\(\s*(?!0[\s,)])/;

/**
 * Return the call argument list starting at the `(` at `open`: the text up to
 * the matching close paren, skipping over single/double-quoted strings,
 * template literals (with nested ${} interpolations), and comments. Regex
 * literals are not recognised: a paren inside one extends the region, which
 * only risks a hit, never a miss. Capped at 4000 characters so an unbalanced
 * call still yields a deterministic region.
 */
function balancedCall(text, open) {
  const limit = Math.min(text.length, open + 4000);
  let depth = 0;
  let i = open;
  const stack = [];
  while (i < limit) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\\') i += 2;
      else {
        if (c === top) stack.pop();
        i++;
      }
      continue;
    }
    if (top === '`') {
      if (c === '\\') i += 2;
      else if (c === '`') {
        stack.pop();
        i++;
      } else if (c === '$' && text[i + 1] === '{') {
        stack.push('{');
        i += 2;
      } else i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      stack.push(c);
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      i = nl < 0 ? limit : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? limit : close + 2;
      continue;
    }
    if (c === '{') {
      stack.push(c);
      i++;
      continue;
    }
    if (c === '}') {
      if (top === '{') stack.pop();
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      i++;
      if (depth === 0) return text.slice(open, i);
      continue;
    }
    i++;
  }
  return text.slice(open, limit);
}

/**
 * The region with string literals and comments blanked (newlines kept) so
 * identifier matching sees variables, not prose. Template literal
 * interpolations are kept: `${SOURCE}` is a variable use, not prose.
 */
function stripToCode(region) {
  let out = '';
  let i = 0;
  const stack = [];
  while (i < region.length) {
    const c = region[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\n') out += '\n';
      else out += ' ';
      if (c === '\\') {
        out += ' ';
        i += 2;
        continue;
      }
      if (c === top) stack.pop();
      i++;
      continue;
    }
    if (top === '`') {
      if (c === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        out += ' ';
        i++;
        continue;
      }
      if (c === '$' && region[i + 1] === '{') {
        stack.push('{');
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }
    if (top === '{' || stack.length === 0) {
      if (c === "'" || c === '"' || c === '`') {
        stack.push(c);
        out += ' ';
        i++;
        continue;
      }
      if (c === '/' && region[i + 1] === '/') {
        const nl = region.indexOf('\n', i + 2);
        const end = nl < 0 ? region.length : nl + 1;
        out += ' '.repeat(end - i - (nl < 0 ? 0 : 1)) + (nl < 0 ? '' : '\n');
        i = end;
        continue;
      }
      if (c === '/' && region[i + 1] === '*') {
        const close = region.indexOf('*/', i + 2);
        const end = close < 0 ? region.length : close + 2;
        let chunk = '';
        for (let k = i; k < end; k++) chunk += region[k] === '\n' ? '\n' : ' ';
        out += chunk;
        i = end;
        continue;
      }
      if (c === '{') {
        stack.push(c);
        out += c;
        i++;
        continue;
      }
      if (c === '}') {
        if (top === '{') stack.pop();
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c === '\n' ? '\n' : ' ';
    i++;
  }
  return out;
}

/** A bare variable use whose name contains source or runtime, not `x.source`. */
const SOURCE_VARIABLE = /(?<![\w$.])[\w$]*(?:source|runtime)[\w$]*/i;

const INLINE_ARG_FIX =
  'write the script to a file under a mkdtempSync directory and spawn the file instead ' +
  '(one Linux argument is capped at 128 KB; macOS allows more, so this passes locally and fails Linux CI)';

/** The taint kind for a spawn region with an eval flag, or '' when clean. */
function inlineArgDetail(region) {
  if (INLINE_FILE_READ.test(region)) return 'file read';
  for (const match of region.matchAll(/JSON\s*\.\s*stringify\s*\(\s*([^(),]{1,80}?)\)/g)) {
    if (/(?:source|runtime)/i.test(match[1])) return 'JSON.stringify of a source value';
  }
  const variable = stripToCode(region).match(SOURCE_VARIABLE);
  if (variable) return `variable "${variable[0]}"`;
  return '';
}

/**
 * Flag spawnSync/execFileSync/spawn calls in a test file whose '-e' /
 * '--eval' / env value is built from a file read, a JSON.stringify of a
 * *SOURCE* / *runtime* value, or a *SOURCE* / *runtime* named variable.
 * Only the call's own argument list is inspected, so a helper that spawns a
 * file (probe.mjs) next to a `const SOURCE = ...` declaration stays clean
 * while an inline `-e` template embedding `${JSON.stringify(SOURCE)}` is
 * flagged. Small inline scripts, JSON.stringify of small names, env TZ/LANG
 * settings, and stdin reads (readFileSync(0, ...)) never match.
 */
export function scanInlineArgs(file, text) {
  if (!isTestFile(file)) return [];
  const hits = [];
  SPAWN_CALL.lastIndex = 0;
  let match;
  while ((match = SPAWN_CALL.exec(text)) !== null) {
    const region = balancedCall(text, match.index + match[0].length - 1);
    if (!EVAL_FLAG.test(region)) continue;
    const detail = inlineArgDetail(region);
    if (!detail) continue;
    const line = text.slice(0, match.index).split('\n').length;
    hits.push(`${file}:${line}: inline-arg spawned -e/--eval/env value built from ${detail}; ${INLINE_ARG_FIX}`);
  }
  return hits;
}

const BINARY = /\.(png|jpe?g|gif|ico|pdf|zip|woff2?|ttf|otf)$/;

function skipped(rel, ignore, skipSegments) {
  if (ignore.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) return true;
  if (!skipSegments.length) return false;
  return rel.split('/').some((part) => skipSegments.includes(part));
}

/** Walk a directory and apply {@link scanText}. Symlinks fail closed. */
export function scanDirectory(dir, { ignore = [], skipSegments = [] } = {}) {
  const hits = [];
  const walk = (rel) => {
    if (rel && skipped(rel, ignore, skipSegments)) return;
    const abs = rel ? path.join(dir, rel) : dir;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (skipped(child, ignore, skipSegments)) continue;
      if (entry.isSymbolicLink()) throw new Error(`check-hygiene: symlink ${child}`);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.isFile()) throw new Error(`check-hygiene: not a regular file ${child}`);
      if (BINARY.test(entry.name)) continue;
      const buf = readFileSync(path.join(dir, child));
      if (buf.includes(0)) continue;
      hits.push(...scanText(child, buf.toString('utf8')));
    }
  };
  walk('');
  return hits;
}

function trackedFiles(dir) {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir });
  const files = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i !== raw.length && raw[i] !== 0) continue;
    if (i === start) {
      start = i + 1;
      continue;
    }
    const file = raw.subarray(start, i).toString('utf8');
    start = i + 1;
    if (!SKIP.test(file)) files.push(file);
  }
  return files;
}

export function scanTree(dir = root) {
  const hits = [];
  for (const file of trackedFiles(dir)) {
    // A tracked file deleted in the working tree is not part of the tree.
    let buf;
    try {
      buf = readFileSync(path.join(dir, file));
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' || err?.code === 'ELOOP') continue;
      throw err;
    }
    if (buf.includes(0)) continue;
    const text = buf.toString('utf8');
    hits.push(...scanText(file, text));
    // The guard's own test data deliberately violates the inline-arg rule;
    // the unit test proves it fails there, so the tree scan skips it.
    if (!INLINE_ARG_FIXTURE_DIRS.some((fixtureDir) => file.startsWith(fixtureDir))) {
      hits.push(...scanInlineArgs(file, text));
    }
  }
  return hits;
}

export function canarySamples() {
  return [
    { rule: 'home-path', text: '/' + 'Users' + '/' + 'someone' + '/proj' },
    { rule: 'home-path', text: '/' + 'home' + '/' + 'someone' + '/app' },
    { rule: 'home-path', text: 'C:' + '\\' + 'Users' + '\\' + 'someone' + '\\proj' },
    { rule: 'email', text: 'person' + '@' + 'gmail.com' },
    { rule: 'org-id', text: '12345' + '678901' },
    { rule: 'project-id', text: '200000000000' + '00001' },
    { rule: 'long-id', text: '31415926' + '53589793' },
    { rule: 'long-id', text: '5897932' + '384626433832' },
  ];
}

function canaryOk() {
  const clean = [
    'see /' + 'docs' + '/readme.md',
    'someone@example.test',
    'user@example.com',
    'bot@users.noreply.github.com',
    'id 10000000000 and 10000000000000001',
    'record 1000000000000000001 and 1000000000171021',
    'max safe 9007199254740993 at 1791412505000',
    'sequence 1234567890123 and 9999999999999999999',
  ];
  for (const text of clean) {
    const hits = scanText('canary-clean', text);
    if (hits.length) return `clean sample flagged: ${text}`;
  }
  for (const sample of canarySamples()) {
    const hits = scanText('canary', sample.text);
    if (!hits.some((hit) => hit.endsWith(sample.rule))) return `canary missed ${sample.rule}`;
  }
  const vendoredFile = 'packages/ui-react/template/lib/c2c-ui/arc/components/phone-input/phone-input.tsx';
  const idText = 'id ' + '12345' + '678901';
  if (scanText(vendoredFile, idText).length) return 'vendored sample exception missed';
  if (!scanText('other-file', idText).length) return 'vendored exception leaked to another file';
  return '';
}

function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const canary = process.argv.includes('--canary');
  if (canary) {
    const problem = canaryOk();
    if (problem) {
      process.stderr.write(`check-hygiene canary: ${problem}\n`);
      process.exit(1);
    }
    process.stdout.write('check-hygiene canary: rejected bad samples\n');
    return;
  }
  const scanDir = flagValue('--scan-dir');
  if (process.argv.includes('--scan-dir')) {
    if (!scanDir) {
      process.stderr.write('usage: node scripts/check-hygiene.mjs --scan-dir <dir> [--skip-segment name]\n');
      process.exit(2);
    }
    const skipSegments = [];
    for (let i = 0; i < process.argv.length; i++) {
      if (process.argv[i] === '--skip-segment' && process.argv[i + 1]) skipSegments.push(process.argv[i + 1]);
    }
    const hits = scanDirectory(path.resolve(scanDir), { skipSegments });
    for (const hit of hits) process.stdout.write(`${hit}\n`);
    if (hits.length) {
      process.stderr.write(`check-hygiene: ${hits.length} hit(s)\n`);
      process.exit(1);
    }
    process.stderr.write('check-hygiene: 0 hit(s)\n');
    return;
  }
  const hits = scanTree();
  for (const hit of hits) process.stdout.write(`${hit}\n`);
  if (hits.length) {
    process.stderr.write(`check-hygiene: ${hits.length} hit(s)\n`);
    process.exit(1);
  }
  process.stderr.write('check-hygiene: 0 hit(s)\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
