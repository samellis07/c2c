/**
 * Memory and time limits every test process carries.
 *
 * `run-tests.mjs` starts `node --test` with these flags and puts the heap
 * cap in NODE_OPTIONS, so each per-file test process and every Node process a
 * test spawns inherits a bounded heap. A test that spawns its own
 * `node --test` child passes the smaller child cap and the timeout itself.
 * A runaway allocation then dies at the cap with a heap-limit error, and a
 * test that never settles fails at the timeout, instead of either one
 * running until the machine runs out of memory.
 */
export const TEST_HEAP_MB = 4096;
export const CHILD_HEAP_MB = 2048;
export const TEST_TIMEOUT_MS = 120000;

const HEAP_FLAG = /--max-old-space-size=(\d+)/;
const TIMEOUT_FLAG = /--test-timeout=(\d+)/;

/** Flags for the `node --test` process the runner starts. */
export function getTestLimitArgs() {
  return [`--max-old-space-size=${TEST_HEAP_MB}`, `--test-timeout=${TEST_TIMEOUT_MS}`];
}

/** Flags for a `node --test` child that a test spawns itself. */
export function getChildTestLimitArgs() {
  return [`--max-old-space-size=${CHILD_HEAP_MB}`, `--test-timeout=${TEST_TIMEOUT_MS}`];
}

/** NODE_OPTIONS with the heap cap appended; a later flag wins over an earlier one. */
export function withHeapCap(nodeOptions = '') {
  const cap = `--max-old-space-size=${TEST_HEAP_MB}`;
  return nodeOptions.trim() === '' ? cap : `${nodeOptions.trim()} ${cap}`;
}

/**
 * Names the package scripts that run tests without the limits. A script
 * that runs tests either goes through `scripts/run-tests.mjs` (which adds
 * them) or calls `node --test` with a heap cap no larger than TEST_HEAP_MB
 * and a timeout no larger than TEST_TIMEOUT_MS on its own command line.
 */
export function findUnlimitedTestScripts(scripts) {
  const problems = [];
  for (const [name, command] of Object.entries(scripts ?? {})) {
    for (const part of String(command).split(/&&|\|\||;/)) {
      const step = part.trim();
      if (/\bscripts\/run-tests\.mjs\b/.test(step)) continue;
      const runsTests = /\b(?:node|tsx)\b[^]*--test\b(?!-)/.test(step) || /\b(?:vitest|jest|mocha)\b/.test(step);
      if (!runsTests) continue;
      const heap = HEAP_FLAG.exec(step);
      const timeout = TIMEOUT_FLAG.exec(step);
      if (!heap || Number(heap[1]) > TEST_HEAP_MB) {
        problems.push(`${name}: "${step}" runs tests without --max-old-space-size<=${TEST_HEAP_MB}`);
      }
      if (!timeout || Number(timeout[1]) > TEST_TIMEOUT_MS) {
        problems.push(`${name}: "${step}" runs tests without --test-timeout<=${TEST_TIMEOUT_MS}`);
      }
    }
  }
  return problems;
}
