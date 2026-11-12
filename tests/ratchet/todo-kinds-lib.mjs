import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile, parseProject } from '../../dist/core/src/index.js';
import { analyze } from '../../dist/cli/src/analyze.js';

export const UPDATE_COMMAND = 'npm run ratchet:update';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const baselineFile = path.join(repoRoot, 'tests/ratchet/todo-kinds.json');

export class TodoRatchetError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'TodoRatchetError';
    this.code = code;
  }
}

function displayPath(file) {
  const rel = path.relative(repoRoot, file);
  return rel.startsWith('..') ? file : rel;
}

/**
 * Discover committed redistributable fixtures:
 * fixtures/redistributable/* / and fixtures/dialects/*.ds
 */
export function findCommittedFixtures(root = repoRoot) {
  const redistDir = path.join(root, 'fixtures/redistributable');
  const dialectsDir = path.join(root, 'fixtures/dialects');
  const fixtures = [];

  if (existsSync(redistDir)) {
    for (const ent of readdirSync(redistDir, { withFileTypes: true })) {
      if (ent.isDirectory() && !ent.name.startsWith('.')) {
        fixtures.push(`fixtures/redistributable/${ent.name}`);
      }
    }
  }

  if (existsSync(dialectsDir)) {
    for (const ent of readdirSync(dialectsDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.ds')) {
        fixtures.push(`fixtures/dialects/${ent.name}`);
      }
    }
  }

  return fixtures.sort();
}

/**
 * Run analyze in-process on one fixture and return a sorted construct -> count map.
 */
export function analyzeFixture(relPath, root = repoRoot) {
  const fullPath = path.join(root, relPath);
  const st = statSync(fullPath);
  const ir = st.isDirectory() ? parseProject(fullPath).ir : parseFile(fullPath).ir;
  const report = analyze(ir);

  const counts = {};
  for (const item of report.determinism.todoKinds) {
    counts[item.construct] = item.count;
  }

  const sorted = {};
  for (const key of Object.keys(counts).sort()) {
    sorted[key] = counts[key];
  }
  return sorted;
}

/**
 * Collect per-construct counts across all discovered committed fixtures.
 */
export function collectAllFixtureCounts(root = repoRoot) {
  const fixtures = findCommittedFixtures(root);
  const result = {};
  for (const fixture of fixtures) {
    result[fixture] = analyzeFixture(fixture, root);
  }
  return result;
}

/**
 * Format a baseline object with deterministically sorted fixture and construct keys.
 */
export function formatBaseline(baseline) {
  const sorted = {};
  for (const fixture of Object.keys(baseline).sort()) {
    sorted[fixture] = {};
    for (const construct of Object.keys(baseline[fixture] || {}).sort()) {
      sorted[fixture][construct] = baseline[fixture][construct];
    }
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

/**
 * Compare current counts against a baseline.
 * Returns { increases, decreases }.
 */
export function compareCounts(current, baseline) {
  const increases = [];
  const decreases = [];

  const allFixtures = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const fixture of [...allFixtures].sort()) {
    const curCounts = current[fixture];
    const baseCounts = baseline[fixture];

    if (baseCounts === undefined) {
      if (curCounts) {
        for (const [construct, count] of Object.entries(curCounts)) {
          increases.push({ fixture, construct, current: count, baseline: 0 });
        }
        if (Object.keys(curCounts).length === 0) {
          decreases.push({ fixture, construct: '(fixture missing from baseline)', current: 0, baseline: 0 });
        }
      }
      continue;
    }

    if (curCounts === undefined) {
      decreases.push({ fixture, construct: '(fixture deleted)', current: 0, baseline: 0 });
      continue;
    }

    const allConstructs = new Set([...Object.keys(curCounts), ...Object.keys(baseCounts)]);
    for (const construct of [...allConstructs].sort()) {
      const cur = curCounts[construct] ?? 0;
      const base = baseCounts[construct] ?? 0;
      if (cur > base) {
        increases.push({ fixture, construct, current: cur, baseline: base });
      } else if (cur < base) {
        decreases.push({ fixture, construct, current: cur, baseline: base });
      }
    }
  }

  return { increases, decreases };
}

/**
 * Parse baseline JSON. Malformed input throws TodoRatchetError and never authorises a rewrite.
 * @param {string} raw
 * @param {string} label
 */
export function parseBaseline(raw, label = 'tests/ratchet/todo-kinds.json') {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TodoRatchetError(
      'TODO_RATCHET_BASELINE_MALFORMED',
      `Failed to parse ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TodoRatchetError(
      'TODO_RATCHET_BASELINE_MALFORMED',
      `Baseline ${label} must be a JSON object of fixture paths to construct counts.`,
    );
  }

  for (const [fixture, counts] of Object.entries(parsed)) {
    if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
      throw new TodoRatchetError(
        'TODO_RATCHET_BASELINE_MALFORMED',
        `Baseline ${label} fixture "${fixture}" must be an object of construct counts.`,
      );
    }
    for (const [construct, count] of Object.entries(counts)) {
      if (!Number.isInteger(count) || count < 0) {
        throw new TodoRatchetError(
          'TODO_RATCHET_BASELINE_MALFORMED',
          `Baseline ${label} fixture "${fixture}" construct "${construct}" must be a non-negative integer.`,
        );
      }
    }
  }

  return parsed;
}

/**
 * Read a baseline file. Missing and malformed files throw TodoRatchetError.
 * This function does not write.
 */
export function loadBaselineFile(file = baselineFile) {
  const label = displayPath(file);
  if (!existsSync(file)) {
    throw new TodoRatchetError(
      'TODO_RATCHET_BASELINE_MISSING',
      `Baseline file ${label} does not exist. Run "${UPDATE_COMMAND}" to generate it.`,
    );
  }

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new TodoRatchetError(
      'TODO_RATCHET_BASELINE_MALFORMED',
      `Failed to read ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const baseline = parseBaseline(raw, label);
  const expectedFormatted = formatBaseline(baseline);
  if (raw !== expectedFormatted) {
    throw new TodoRatchetError(
      'TODO_RATCHET_BASELINE_UNCANONICAL',
      `${label} keys are not canonical/sorted. Run "${UPDATE_COMMAND}" to reformat.`,
    );
  }
  return baseline;
}

function formatDiffLines(rows, verb) {
  return rows.map(
    (row) =>
      `  ${row.fixture}: "${row.construct}" ${verb} (current: ${row.current}, baseline: ${row.baseline})`,
  );
}

/**
 * Throw TodoRatchetError when counts rise or the baseline is stale.
 * Read-only: this function never writes a baseline.
 */
export function enforceRatchet(current, baseline) {
  const { increases, decreases } = compareCounts(current, baseline);

  if (increases.length > 0) {
    const lines = increases.map(
      (inc) =>
        `  ${inc.fixture}: "${inc.construct}" ${inc.baseline === 0 ? 'appeared' : 'increased'} (current: ${inc.current}, baseline: ${inc.baseline})`,
    );
    throw new TodoRatchetError(
      'TODO_RATCHET_INCREASE',
      `TODO kinds increased or appeared (ratchet violation):\n${lines.join('\n')}\nFix the regression; baseline cannot be raised.`,
    );
  }

  if (decreases.length > 0) {
    const lines = formatDiffLines(decreases, 'decreased');
    throw new TodoRatchetError(
      'TODO_RATCHET_DECREASE',
      `TODO kinds decreased (baseline is stale):\n${lines.join('\n')}\nThe baseline must be lowered in the same commit.\nUpdate command: ${UPDATE_COMMAND}`,
    );
  }
}

/**
 * Decide the next baseline text. Does not write.
 * A missing baseline may be created by the explicit update script.
 * Malformed JSON and unapproved increases throw TodoRatchetError.
 */
export function planBaselineWrite({ exists, raw, current, allowIncrease }) {
  if (exists) {
    const baseline = parseBaseline(raw, 'tests/ratchet/todo-kinds.json');
    const { increases } = compareCounts(current, baseline);
    if (increases.length > 0 && !allowIncrease) {
      const lines = increases.map(
        (inc) =>
          `  ${inc.fixture}: "${inc.construct}" (current: ${inc.current}, baseline: ${inc.baseline})`,
      );
      throw new TodoRatchetError(
        'TODO_RATCHET_INCREASE',
        `Cannot update baseline: TODO kinds increased or appeared:\n${lines.join('\n')}\nThe ratchet only lowers baseline counts. Regressions must be fixed.`,
      );
    }
  }
  return formatBaseline(current);
}
