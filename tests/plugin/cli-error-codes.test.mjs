/**
 * CLI error codes and the troubleshooting index stay in bidirectional parity,
 * and no user-facing error is printed or thrown without a code.
 *
 * Scanned recursively: every source file under packages/cli/src,
 * packages/deploy/src and packages/doctor/src, plus the CLI utility scripts.
 *
 * An error site is "coded" when its output is produced by coded()/codedError()/
 * printError()/writeCliError() (or it is thrown as a C2cError). A raw stderr
 * write whose literal starts with an error prefix (`c2c`, `usage`, `blocker`,
 * `refused`) and carries no code is a failure. `/* uncoded *\/` marks the rare
 * progress notice that deliberately stays plain (warnings, retry logs,
 * build tails and command output never carry a code and need no marker).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcDirs = ['packages/cli/src', 'packages/deploy/src', 'packages/doctor/src'];
const scripts = ['packages/cli/scripts/check-matrix-citations.mjs', 'packages/cli/scripts/refresh-matrix-snapshot.mjs'];
const index = 'plugin/references/error-index.md';
const codePattern = /C2C-(?:CLI|DEPLOY|DOCTOR)-\d{3}/g;
const read = (file) => readFileSync(path.join(repo, file), 'utf8');

function* walk(dir) {
  for (const name of readdirSync(path.join(repo, dir))) {
    const rel = `${dir}/${name}`;
    const st = statSync(path.join(repo, rel));
    if (st.isDirectory()) yield* walk(rel);
    else if (/\.(ts|mts|mjs)$/.test(name)) yield rel;
  }
}

function sourceFiles() {
  return [...srcDirs.flatMap((dir) => [...walk(dir)]), ...scripts];
}

/** Return the [start, end) span of the call whose '(' is at `at`, tracking strings, templates and brackets. */
function callSpan(text, at) {
  const stack = [')'];
  let i = at + 1;
  while (i < text.length && stack.length) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"' || top === '`') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === top) stack.pop();
      else if (top === '`' && c === '$' && text[i + 1] === '{') {
        stack.push('}');
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') stack.push(c);
    else if (c === '(') stack.push(')');
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === top) stack.pop();
    i += 1;
  }
  return [at, i];
}

/** Leading characters of each '..' ".." `..` literal in a call's text. */
function literalHeads(callText) {
  const heads = [];
  for (const m of callText.matchAll(/(['"`])([^'"`$\\]{0,40})/g)) heads.push(m[2]);
  return heads;
}

const ERROR_PREFIX = /^(c2c[ :]|usage:|blocker |refused|no such|cannot |could not|not a |unknown |--[a-z])/i;
const WRITE_CALLEE = /(?:\bio\.stderr|ctx\.io\.stderr|\.stderr|process\.stderr\.write|console\.error|writeCliError)\(/g;

function uncodedErrors(text, file) {
  const failures = [];
  for (const m of text.matchAll(WRITE_CALLEE)) {
    const [start, end] = callSpan(text, m.index + m[0].length - 1);
    const call = text.slice(start, end);
    if (/\/\*\s*uncoded\b/.test(call)) continue;
    if (/C2C-(?:CLI|DEPLOY|DOCTOR)-\d{3}/.test(call)) continue;
    // The plumbing itself (writeCliError/fail) codes dynamically — the code
    // arrives as a parameter, not a literal.
    if (/\b(?:coded|codedError)\(\s*code\b|\(\s*code\s*,/.test(call)) continue;
    for (const head of literalHeads(call)) {
      if (ERROR_PREFIX.test(head)) {
        failures.push(`${file}: stderr write with no error code: ${head.slice(0, 60)}…`);
        break;
      }
    }
  }
  // A thrown error whose message carries the verbatim `c2c`/`usage` print
  // prefix is user-facing by contract and must be the typed class. Other
  // throws are coded where the command boundary catches them (fail(),
  // printCaught(), writeRejection() — each scanned above for its own code).
  for (const m of text.matchAll(/throw new (?!C2cError\b)\w+\(\s*(['"`])([^'"`]{0,60})/g)) {
    if (/^(c2c[ :]|usage:)/.test(m[2])) failures.push(`${file}: thrown user-facing error is not a C2cError: ${m[2].slice(0, 60)}…`);
  }
  return failures;
}

function sourceCodes(sourceTexts) {
  return new Set(sourceTexts.flatMap((text) => [...text.matchAll(codePattern)].map(([code]) => code)));
}
function indexCodes(text) {
  return new Set([...text.matchAll(/^\| `(C2C-(?:CLI|DEPLOY|DOCTOR)-\d{3})` \|/gm)].map(([, code]) => code));
}
function assertParity(sourceTexts, indexText) {
  const source = sourceCodes(sourceTexts);
  const indexed = indexCodes(indexText);
  assert.deepEqual([...source].filter((code) => !indexed.has(code)), [], 'source error code is missing from error-index.md');
  assert.deepEqual([...indexed].filter((code) => !source.has(code)), [], 'error-index.md code has no source error site');
}

const sources = sourceFiles();

test('every CLI error code is indexed and every indexed CLI code has a source site', () => {
  assertParity(sources.map(read), read(index));
});

test('no printed or thrown user-facing error lacks a code', () => {
  const failures = sources.flatMap((file) => uncodedErrors(read(file), file));
  assert.deepEqual(failures, []);
});

test('negative controls detect a missing index row, an orphan row, and an uncoded error', () => {
  const texts = sources.map(read);
  const source = sourceCodes(texts);
  const indexed = indexCodes(read(index));
  const code = [...source][0];
  const missingRow = read(index).replace(new RegExp('^\\| `' + code + '` \\|.*\\n', 'm'), '');
  assert.throws(() => assertParity(texts, missingRow), /source error code is missing/);
  const orphan = read(index).replace('| Code | Error |', '| Code | Error |\n| `C2C-DOCTOR-999` | invented boundary |');
  assert.throws(() => assertParity(texts, orphan), /no source error site/);
  assert.ok(indexed.has(code));
  assert.deepEqual(uncodedErrors("io.stderr(`c2c: something broke\\n`);", 'mutation.ts'), [
    'mutation.ts: stderr write with no error code: c2c: something broke…',
  ]);
  assert.deepEqual(uncodedErrors("throw new Error('c2c: bad flag');", 'mutation.ts'), [
    'mutation.ts: thrown user-facing error is not a C2cError: c2c: bad flag…',
  ]);
  // Warnings, retry logs and command tails are never coded and pass clean.
  assert.deepEqual(uncodedErrors("io.stderr(`warning event-async-triggers: x\\n`); io.stderr(`retry 1/3 in 500ms\\n`);", 'ok.ts'), []);
});

test('CLI utility script errors carry the indexed code and link', () => {
  const check = spawnSync(process.execPath, [path.join(repo, scripts[0]), '--unknown'], { encoding: 'utf8' });
  assert.equal(check.status, 2);
  assert.match(check.stderr, /\[C2C-CLI-021\]/);
  assert.match(check.stderr, /plugin\/references\/error-index\.md#c2c-cli-021/);
  const refresh = spawnSync(process.execPath, [path.join(repo, scripts[1])], { encoding: 'utf8' });
  assert.equal(refresh.status, 2);
  assert.match(refresh.stderr, /\[C2C-CLI-021\]/);
  assert.match(refresh.stderr, /plugin\/references\/error-index\.md#c2c-cli-021/);
});
