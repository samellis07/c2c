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
 *
 * Two quoted vendor addresses are allowed because the product repeats them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
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
    for (const name of readdirSync(abs)) {
      const child = rel ? `${rel}/${name}` : name;
      if (skipped(child, ignore, skipSegments)) continue;
      const info = lstatSync(path.join(dir, child));
      if (info.isSymbolicLink()) throw new Error(`check-hygiene: symlink ${child}`);
      if (info.isDirectory()) {
        walk(child);
        continue;
      }
      if (!info.isFile()) throw new Error(`check-hygiene: not a regular file ${child}`);
      if (BINARY.test(name)) continue;
      const buf = readFileSync(path.join(dir, child));
      if (buf.includes(0)) continue;
      hits.push(...scanText(child, buf.toString('utf8')));
    }
  };
  walk('');
  return hits;
}

function trackedFiles() {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
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

export function scanTree() {
  const hits = [];
  for (const file of trackedFiles()) {
    // A tracked file deleted in the working tree is not part of the tree.
    if (!existsSync(path.join(root, file))) continue;
    const buf = readFileSync(path.join(root, file));
    if (buf.includes(0)) continue;
    hits.push(...scanText(file, buf.toString('utf8')));
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
