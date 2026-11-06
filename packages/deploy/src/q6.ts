/**
 * Verified bar (quality-gate Q6): one report that folds the two halves of Q6
 * into a single per-app verdict.
 *
 * Half one is the Catalyst E2E. The generated suite (`tests/e2e/` in the deploy
 * tree, emitted by `generateE2eFiles`) runs the same regression cases against
 * Creator and Catalyst as two Playwright projects, `creator` and `catalyst`.
 * `e2eParity` reads the Playwright JSON report (`reporter: [['json', ...]]` or
 * PLAYWRIGHT_JSON_OUTPUT_NAME) and checks every case ran on both projects and
 * passed on both — a case that only exists on one side, or fails on either, is
 * not evidence of parity. A `flaky` outcome (passed on retry) counts as a pass
 * but is named in the report so a flaky verified bar is visible.
 *
 * Half two is the data parity `dataParity` already computes: per-table counts
 * and the per-record canonical hash keyed by c2c_source_id.
 *
 * `q6Verdict` combines them: `verified` is true only when both halves pass. The
 * check reads files only — the browser run and the live row dump happen
 * upstream.
 */
import { readFileSync } from 'node:fs';
import type { DataParityReport } from './parity.js';

/** Playwright's computed outcome for one spec on one project. */
export type E2eCaseStatus = 'expected' | 'unexpected' | 'flaky' | 'skipped' | 'unknown';

export interface E2eCaseReport {
  /** Spec title, identical in the creator and catalyst spec files. */
  name: string;
  creator: E2eCaseStatus;
  catalyst: E2eCaseStatus;
  ok: boolean;
}

export interface E2eParityReport {
  ok: boolean;
  /** Stable reasons that make the E2E half fail Q6. */
  reasons: string[];
  /** Project names seen, other than the two compared. */
  otherProjects: string[];
  cases: E2eCaseReport[];
}

export interface Q6Verdict {
  /** The verified bar: E2E parity and data parity both hold. */
  verified: boolean;
  reasons: string[];
  e2e: E2eParityReport;
  parity: DataParityReport;
}

interface PlaywrightSpecEntry {
  title?: unknown;
  ok?: unknown;
  tests?: unknown;
}

interface PlaywrightSuiteEntry {
  specs?: unknown;
  suites?: unknown;
}

const PASS: ReadonlySet<E2eCaseStatus> = new Set(['expected', 'flaky']);
const KNOWN_STATUSES: ReadonlySet<string> = new Set(['expected', 'unexpected', 'flaky', 'skipped']);

function outcomeOf(test: Record<string, unknown>): E2eCaseStatus {
  const status = typeof test.status === 'string' ? test.status : '';
  if (KNOWN_STATUSES.has(status)) return status as E2eCaseStatus;
  const results = Array.isArray(test.results) ? test.results : [];
  const last = results[results.length - 1];
  const ran = last && typeof last === 'object' ? (last as Record<string, unknown>).status : undefined;
  if (ran === 'passed') return 'expected';
  if (ran === 'skipped') return 'skipped';
  if (typeof ran === 'string') return 'unexpected';
  return 'unknown';
}

/**
 * Walks a Playwright JSON report (`suites` -> `specs` -> `tests`) and returns
 * per-project spec outcomes keyed by spec title. The generated spec files
 * differ per project (`regression-creator.spec.ts`,
 * `regression-catalyst.spec.ts`) and wrap cases in a per-target describe, so
 * the file name and suite titles are deliberately not part of the key.
 */
export function playwrightSpecOutcomes(report: unknown): Map<string, Map<string, E2eCaseStatus>> {
  const out = new Map<string, Map<string, E2eCaseStatus>>();
  const walk = (suite: PlaywrightSuiteEntry): void => {
    for (const spec of Array.isArray(suite.specs) ? (suite.specs as PlaywrightSpecEntry[]) : []) {
      const title = typeof spec.title === 'string' ? spec.title : '';
      for (const test of Array.isArray(spec.tests) ? (spec.tests as Record<string, unknown>[]) : []) {
        const project = typeof test.projectName === 'string' ? test.projectName : '';
        if (!title || !project) continue;
        let byProject = out.get(title);
        if (!byProject) out.set(title, (byProject = new Map()));
        byProject.set(project, outcomeOf(test));
      }
    }
    for (const child of Array.isArray(suite.suites) ? (suite.suites as PlaywrightSuiteEntry[]) : []) walk(child);
  };
  const root = report && typeof report === 'object' ? (report as PlaywrightSuiteEntry) : {};
  for (const suite of Array.isArray(root.suites) ? (root.suites as PlaywrightSuiteEntry[]) : []) walk(suite);
  return out;
}

/**
 * The E2E half of Q6 from a parsed Playwright JSON report: the same cases must
 * run on the `creator` and `catalyst` projects and pass on both.
 */
export function e2eParity(report: unknown): E2eParityReport {
  const outcomes = playwrightSpecOutcomes(report);
  const otherProjects = [
    ...new Set([...outcomes.values()].flatMap((byProject) => [...byProject.keys()])),
  ]
    .filter((project) => project !== 'creator' && project !== 'catalyst')
    .sort();
  const reasons = new Set<string>();
  const cases: E2eCaseReport[] = [];
  for (const [name, byProject] of [...outcomes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const creator = byProject.get('creator');
    const catalyst = byProject.get('catalyst');
    if (creator === undefined || catalyst === undefined) reasons.add('Q6_E2E_CASE_MISSING');
    if (creator !== undefined && !PASS.has(creator)) reasons.add('Q6_E2E_CREATOR_FAILED');
    if (catalyst !== undefined && !PASS.has(catalyst)) reasons.add('Q6_E2E_CATALYST_FAILED');
    cases.push({
      name,
      creator: creator ?? 'unknown',
      catalyst: catalyst ?? 'unknown',
      ok: creator !== undefined && catalyst !== undefined && PASS.has(creator) && PASS.has(catalyst),
    });
  }
  if (cases.length === 0) reasons.add('Q6_E2E_NO_CASES');
  else if (cases.every((item) => item.creator === 'unknown' || item.catalyst === 'unknown')) reasons.add('Q6_E2E_CASE_MISSING');
  return { ok: reasons.size === 0 && cases.every((item) => item.ok), reasons: [...reasons], otherProjects, cases };
}

/** The Q6 verified bar: the E2E half and the data-parity half both hold. */
export function q6Verdict(input: { e2e: E2eParityReport; parity: DataParityReport }): Q6Verdict {
  return {
    verified: input.e2e.ok && input.parity.ok,
    reasons: [...new Set([...input.e2e.reasons, ...input.parity.reasons])],
    e2e: input.e2e,
    parity: input.parity,
  };
}

/** Reads and parses a Playwright JSON report file. Throws on invalid JSON. */
export function readPlaywrightReport(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function formatE2eParity(report: E2eParityReport): string {
  const lines = ['c2c e2e-parity v1'];
  for (const item of report.cases) {
    lines.push(`${item.name}: creator ${item.creator} catalyst ${item.catalyst} ${item.ok ? 'match' : 'MISMATCH'}`);
  }
  if (report.otherProjects.length) lines.push(`other projects (not compared): ${report.otherProjects.join(', ')}`);
  if (report.reasons.length) lines.push(`reasons: ${report.reasons.join(', ')}`);
  lines.push(report.ok ? 'e2e: ok' : 'e2e: MISMATCH');
  return `${lines.join('\n')}\n`;
}

export function formatQ6(verdict: Q6Verdict): string {
  const lines = ['c2c verify Q6'];
  for (const item of verdict.e2e.cases) {
    lines.push(`${item.name}: creator ${item.creator} catalyst ${item.catalyst} ${item.ok ? 'match' : 'MISMATCH'}`);
  }
  lines.push(`e2e: ${verdict.e2e.ok ? 'ok' : 'MISMATCH'}`);
  lines.push(`parity: ${verdict.parity.ok ? 'ok' : 'MISMATCH'}`);
  if (verdict.reasons.length) lines.push(`reasons: ${verdict.reasons.join(', ')}`);
  lines.push(verdict.verified ? 'verified: yes' : 'verified: NO');
  return `${lines.join('\n')}\n`;
}
