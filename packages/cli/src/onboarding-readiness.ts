/**
 * Offline onboarding-readiness check for the per-app migration report and
 * the customer guide.
 *
 * For each named fixture it reads what c2c already produces — `analyze`,
 * `precheck`, the per-fixture migration report and its committed golden, and
 * an offline `c2c plan` run with network and child processes refused — and
 * checks each criterion of a business-user migration report: what converted,
 * what needs a human step (at most four), what is unsupported and its
 * workaround, and that the guide's steps run. The guide checks run once.
 *
 * Every criterion ends PASS, FAIL or GAP. GAP means c2c does not do it yet;
 * its detail names exactly what is missing. A GAP is never counted as a pass.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseFileWithSidecars, widgetManualItems } from '../../core/src/index.js';
import { compareEnUs } from '../../core/src/order.js';
import { decode } from '../../core/src/source.js';
import { CUSTOMER_STEPS, planCustomerSteps } from '../../deploy/src/customer-steps.js';
import { planCli } from '../../deploy/src/index.js';
import { analyze, analyzeAsJson, type AnalyzeReport } from './analyze.js';
import { DISPATCH_COMMANDS } from './commands.js';
import {
  buildFixtureMigrationReport,
  fixtureMigrationReportAsJson,
  fixtureMigrationReportAsMarkdown,
  migrationReportGoldenDir,
  type FixtureMigrationReport,
  type InRepoFixture,
} from './fixture-migration-report.js';
import { precheck, precheckAsJson, type PrecheckReport } from './precheck.js';

export type CriterionStatus = 'PASS' | 'FAIL' | 'GAP';

export interface CriterionResult {
  id: string;
  title: string;
  status: CriterionStatus;
  detail: string;
}

export interface AppReadiness {
  fixture: string;
  app: string | null;
  criteria: CriterionResult[];
}

export interface OnboardingReadiness {
  schema: 'c2c-onboarding-readiness/1';
  apps: AppReadiness[];
  guide: CriterionResult[];
  counts: Record<CriterionStatus, number>;
}

/** Most guided human steps a migration may ask of the customer. */
export const MAX_HUMAN_STEPS = 4;

/** The fixtures the check runs on by default, as paths under fixtures/ without `.ds`. */
export const DEFAULT_FIXTURES = ['redistributable/library-application-system/library_application', 'synthetic/kitchen-sink/kitchen_sink'] as const;

/** Console plan steps that are the same visit as a checklist item ("Sign in once", "Verify mail sender"), so they count once. */
const SAME_VISIT_AS_CUSTOMER_STEP = new Set(['sign-in-check', 'mail-sender']);

interface PlanStep {
  id: string;
  via: string;
  command?: string;
}

interface PlanRun {
  code: number;
  files: string[];
  steps: PlanStep[];
  connectionSecretKeys: string[];
  stderr: string;
}

/** What the checks read for one app. Tests replace single fields to prove a criterion fails. */
export interface AppInputs {
  fixture: InRepoFixture;
  app: string | null;
  analysis: AnalyzeReport;
  precheck: PrecheckReport;
  widgetManual: number;
  report: FixtureMigrationReport;
  reportJson: string;
  reportMd: string;
  /** Second, independent build of the report, for the byte-identity check. */
  rebuiltJson: string;
  rebuiltMd: string;
  golden: { json?: string; md?: string };
  plan: PlanRun;
}

const pass = (id: string, title: string, detail: string): CriterionResult => ({ id, title, status: 'PASS', detail });
const fail = (id: string, title: string, detail: string): CriterionResult => ({ id, title, status: 'FAIL', detail });
const gap = (id: string, title: string, detail: string): CriterionResult => ({ id, title, status: 'GAP', detail });

const refused = (what: string) => async (): Promise<never> => {
  throw new Error(`onboarding check is offline: ${what} refused`);
};

/** `c2c plan` in-process, with spawn and fetch refused. Returns the written files and the plan steps. */
export async function runOfflinePlan(file: string): Promise<PlanRun> {
  const out = mkdtempSync(join(tmpdir(), 'c2c-onboarding-plan-'));
  let stderr = '';
  try {
    const code = await planCli([file, '--out', out, '--dc', 'in'], {
      stdout() {},
      stderr: (text: string) => {
        stderr += text;
      },
      env: {},
      spawn: refused('spawn'),
      fetch: refused('fetch'),
    } as unknown as Parameters<typeof planCli>[1]);
    const files = readdirSync(out).sort(compareEnUs);
    let steps: PlanStep[] = [];
    let connectionSecretKeys: string[] = [];
    if (files.includes('plan.json')) {
      const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')) as { steps?: PlanStep[]; connectionSecretKeys?: string[] };
      steps = plan.steps ?? [];
      connectionSecretKeys = plan.connectionSecretKeys ?? [];
    }
    return { code, files, steps, connectionSecretKeys, stderr };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

export async function loadAppInputs(repoRoot: string, fixture: InRepoFixture): Promise<AppInputs> {
  const ir = parseFileWithSidecars(fixture.file).ir;
  const source = decode(readFileSync(fixture.file)).text;
  const report = buildFixtureMigrationReport(fixture);
  const rebuilt = buildFixtureMigrationReport(fixture);
  const base = join(migrationReportGoldenDir(repoRoot), fixture.id);
  return {
    fixture,
    app: ir.name ?? null,
    analysis: analyze(ir),
    precheck: precheck(ir, source),
    widgetManual: widgetManualItems(ir.widgets).length,
    report,
    reportJson: fixtureMigrationReportAsJson(report),
    reportMd: fixtureMigrationReportAsMarkdown(report),
    rebuiltJson: fixtureMigrationReportAsJson(rebuilt),
    rebuiltMd: fixtureMigrationReportAsMarkdown(rebuilt),
    golden: { json: readIfPresent(`${base}.json`), md: readIfPresent(`${base}.md`) },
    plan: await runOfflinePlan(fixture.file),
  };
}

const kindsKey = (kinds: readonly { construct: string; count: number }[]) =>
  kinds.map((kind) => `${kind.construct}=${kind.count}`).sort(compareEnUs).join(', ');

/** The customer's guided steps for a plan: the checklist items, then console steps that are a separate visit. */
export function humanSteps(plan: Pick<PlanRun, 'steps' | 'connectionSecretKeys'>): string[] {
  const checklist = planCustomerSteps(plan.steps, { connectionSecretKeys: plan.connectionSecretKeys });
  const consoleSteps = plan.steps
    .filter((step) => step.via === 'console' && !SAME_VISIT_AS_CUSTOMER_STEP.has(step.id))
    .map((step) => `console: ${step.id}`);
  return [...checklist, ...consoleSteps];
}

/** Precheck findings grouped by severity and check, as the report groups them. */
function precheckRows(report: PrecheckReport): Map<string, number> {
  const rows = new Map<string, number>();
  for (const finding of report.findings) {
    const key = `${finding.severity} ${finding.check}`;
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  return rows;
}

export function checkApp(inputs: AppInputs): AppReadiness {
  const { analysis, report } = inputs;
  const criteria: CriterionResult[] = [];

  // 1. The report's TODO count and kinds are analyze's, exactly.
  {
    const id = 'report-todos-match-analyze';
    const title = 'Report TODO count and kinds equal analyze';
    const want = `${analysis.determinism.todoCount} [${kindsKey(analysis.determinism.todoKinds)}]`;
    const got = `${report.todoCount} [${kindsKey(report.todoKinds)}]`;
    criteria.push(want === got ? pass(id, title, `${got}`) : fail(id, title, `analyze ${want}, report ${got}`));
  }

  // 2. Every precheck finding and widget package is a listed manual step with its count.
  {
    const id = 'report-manual-steps-match-precheck';
    const title = 'Report lists every precheck finding and widget package as a manual step';
    const listed = new Map<string, number>(report.manualSteps.map((step) => [`${step.severity} ${step.check}`, step.count]));
    const missing: string[] = [];
    for (const [key, count] of precheckRows(inputs.precheck)) {
      if (listed.get(key) !== count) missing.push(`${key} x${count} (report ${listed.get(key) ?? 0})`);
    }
    const widgets = report.manualSteps.filter((step) => step.check.startsWith('widget-package:')).length;
    if (widgets !== inputs.widgetManual) missing.push(`widget packages ${inputs.widgetManual} (report ${widgets})`);
    criteria.push(
      missing.length === 0
        ? pass(id, title, `${report.manualSteps.length} manual step rows (${inputs.precheck.findings.length} precheck findings, ${widgets} widget packages)`)
        : fail(id, title, `missing or miscounted: ${missing.join('; ')}`),
    );
  }

  // 3. Field behavior analyze reports as partial or unsupported.
  {
    const id = 'report-lists-field-gaps';
    const title = 'Report lists partial and unsupported field behavior';
    const total = analysis.fieldGaps.reduce((sum, item) => sum + item.count, 0);
    criteria.push(
      total === 0
        ? pass(id, title, 'analyze reports no field gaps; nothing to list')
        : gap(id, title, `analyze reports ${total} field gap(s) (${analysis.fieldGaps.map((item) => item.matrixId).join(', ')}); the per-app migration report has no field-gap section`),
    );
  }

  // 4. What converted: the business user's "what you get" inventory.
  {
    const id = 'report-lists-converted';
    const title = 'Report says what converted';
    const c = analysis.catalyst;
    criteria.push(
      gap(
        id,
        title,
        `analyze knows ${c.tables} tables, ${c.functions} functions, ${c.cronJobs} cron jobs, ${c.slatePages} pages and ${analysis.deluge.translated} translated + ${analysis.deluge.shimmed} shimmed of ${analysis.deluge.statements} Deluge statements; the per-app migration report carries only TODOs and manual steps, no converted inventory`,
      ),
    );
  }

  // 5. Unsupported items each carry a workaround at their source.
  {
    const id = 'unsupported-has-workaround';
    const title = 'Every unsupported item has workaround text';
    const missing: string[] = [];
    for (const finding of inputs.precheck.findings) if (!finding.fix.trim()) missing.push(`precheck ${finding.check}`);
    for (const item of analysis.fieldGaps) if (!item.reason.trim()) missing.push(`field gap ${item.matrixId}`);
    for (const blocker of analysis.blockers) if (!(blocker.manualStep ?? blocker.detail).trim()) missing.push(`blocker ${blocker.label}`);
    const n = inputs.precheck.findings.length + analysis.fieldGaps.length + analysis.blockers.length;
    criteria.push(missing.length === 0 ? pass(id, title, `${n} item(s), each with fix, reason or manual step`) : fail(id, title, `no workaround: ${missing.join('; ')}`));
  }

  // 6. The report itself carries the workaround the business user acts on.
  {
    const id = 'report-carries-workaround';
    const title = 'Report shows the workaround beside each unsupported item';
    const withFix = inputs.precheck.findings.length + analysis.fieldGaps.length;
    criteria.push(
      withFix === 0 && report.manualSteps.length === 0
        ? pass(id, title, 'no unsupported item to explain')
        : gap(id, title, `${withFix} item(s) have fix/reason text in precheck/analyze, but the per-app report lists manual steps by check name and count only`),
    );
  }

  // 6b. No silent item: every silent drop is a guided residual item in the report.
  {
    const id = 'report-no-silent-item';
    const title = 'Every silent drop is a guided residual item in the report';
    const drops = analysis.determinism.silentDrops;
    const problems: string[] = [];
    if (report.silentDrops !== drops) problems.push(`report counts ${report.silentDrops} silent drops, analyze ${drops}`);
    if ((report.residuals?.length ?? 0) !== drops) problems.push(`${report.residuals?.length ?? 0} residual item(s) for ${drops} silent drop(s)`);
    const ids = new Set<string>();
    for (const item of report.residuals ?? []) {
      if (ids.has(item.id)) problems.push(`duplicate id ${item.id}`);
      ids.add(item.id);
      const empty = (['id', 'construct', 'reason', 'step'] as const).filter((key) => !item[key].trim());
      if (empty.length) problems.push(`${item.id || item.construct}: empty ${empty.join(', ')}`);
      else if (!inputs.reportMd.includes(item.step)) problems.push(`${item.id}: step missing from the markdown report`);
    }
    const generic = (report.residuals ?? []).filter((item) => item.stepSource === 'generic').length;
    criteria.push(
      problems.length === 0
        ? pass(id, title, `${drops} silent drop(s), each guided (${drops - generic} workaround, ${generic} generic manual step); still counted as drops`)
        : fail(id, title, problems.slice(0, 10).join('; ')),
    );
  }

  // 7. Owner scope (not supported in this version / out of scope) is printed.
  {
    const id = 'report-lists-scope';
    const title = 'Report prints the owner scope labels';
    const ok = report.scope.length > 0 && report.scope.every((entry) => inputs.reportMd.includes(`- ${entry.feature} — ${entry.label}`));
    criteria.push(ok ? pass(id, title, `${report.scope.length} scope entries`) : fail(id, title, 'scope entries missing from the markdown report'));
  }

  // 8. Human steps: at most four guided steps, counted from the offline plan.
  const steps = humanSteps(inputs.plan);
  {
    const id = 'human-steps-within-limit';
    const title = `Customer has at most ${MAX_HUMAN_STEPS} guided steps`;
    const detail = `${steps.length}: ${steps.join(' | ')}`;
    if (inputs.plan.code !== 0) criteria.push(fail(id, title, `offline plan failed (exit ${inputs.plan.code}); no step list`));
    else criteria.push(steps.length <= MAX_HUMAN_STEPS ? pass(id, title, detail) : fail(id, title, detail));
  }

  // 9. The human steps are in the per-app report.
  {
    const id = 'report-lists-human-steps';
    const title = "Report lists the customer's human steps";
    const missing = steps.filter((step) => !inputs.reportMd.includes(step.replace(/^console: /, '')));
    criteria.push(
      missing.length === 0
        ? pass(id, title, `${steps.length} step(s) listed`)
        : gap(id, title, `${missing.length} of ${steps.length} human step(s) are only in plan.md (Human steps / console provision steps), not in the per-app migration report`),
    );
  }

  // 10. The report regenerates byte-identically.
  {
    const id = 'report-deterministic';
    const title = 'Report regenerates byte-identically';
    const same = inputs.reportJson === inputs.rebuiltJson && inputs.reportMd === inputs.rebuiltMd;
    criteria.push(same ? pass(id, title, 'json and md identical across two builds') : fail(id, title, 'two builds of the same fixture differ'));
  }

  // 11. The committed golden is current.
  {
    const id = 'report-golden-current';
    const title = 'Committed report golden matches a fresh build';
    const { json, md } = inputs.golden;
    if (json === undefined || md === undefined) criteria.push(fail(id, title, `no committed golden for ${inputs.fixture.id}`));
    else if (json !== inputs.reportJson || md !== inputs.reportMd) criteria.push(fail(id, title, `golden for ${inputs.fixture.id} is stale; run migration-reports:update`));
    else criteria.push(pass(id, title, `${inputs.fixture.id}.json and .md current`));
  }

  // 12. The guide's offline answer files come out of the commands it names.
  {
    const id = 'guide-offline-steps-run';
    const title = 'Guide offline steps run: precheck.json, analyze.json, plan.md';
    const problems: string[] = [];
    if (!analyzeAsJson(analysis).startsWith('{')) problems.push('analyze.json did not render');
    if (!precheckAsJson(inputs.precheck).startsWith('{')) problems.push('precheck.json did not render');
    if (inputs.plan.code !== 0) problems.push(`c2c plan exit ${inputs.plan.code}: ${inputs.plan.stderr.trim().split('\n')[0] ?? ''}`);
    for (const file of ['plan.md', 'plan.json']) if (!inputs.plan.files.includes(file)) problems.push(`c2c plan wrote no ${file}`);
    criteria.push(problems.length === 0 ? pass(id, title, `plan wrote ${inputs.plan.files.length} entries with network and spawn refused`) : fail(id, title, problems.join('; ')));
  }

  // 13. Live steps of the guide and the time-to-migrate target.
  criteria.push(
    gap(
      'guide-live-steps-run',
      'Guide live steps run: c2c-deploy-report.json, counts, c2c-proof.json',
      'deploy, migrate-data and proof need a Catalyst project; there is no in-process Catalyst harness for them, so they are not run offline',
    ),
  );
  criteria.push(
    gap(
      'non-developer-under-one-day',
      'A non-developer completes the migration via the plugin in under one working day',
      'needs a timed blind run by a non-developer with default Claude settings; an offline check cannot measure it',
    ),
  );

  return { fixture: inputs.fixture.id, app: inputs.app, criteria };
}

export interface GuideInputs {
  /** docs/guide markdown files: path relative to the repo root, and content. */
  pages: { path: string; text: string }[];
  /** Whether a repo-relative path exists. */
  exists: (repoPath: string) => boolean;
  commands: readonly string[];
  customerSteps: readonly string[];
}

export function loadGuideInputs(repoRoot: string): GuideInputs {
  const dir = join(repoRoot, 'docs/guide');
  const pages = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort(compareEnUs)
    .map((name) => ({ path: `docs/guide/${name}`, text: readFileSync(join(dir, name), 'utf8') }));
  return { pages, exists: (path) => existsSync(join(repoRoot, path)), commands: DISPATCH_COMMANDS, customerSteps: CUSTOMER_STEPS };
}

const toPosix = (path: string) => path.split(sep).join('/');

export function checkGuide(inputs: GuideInputs): CriterionResult[] {
  const out: CriterionResult[] = [];
  {
    const id = 'guide-commands-exist';
    const title = 'Every `c2c <command>` the guide names is a real command';
    const named = new Set<string>();
    for (const page of inputs.pages) for (const match of page.text.matchAll(/`c2c ([a-z][a-z-]*)/g)) named.add(match[1]!);
    const known = new Set<string>([...inputs.commands, 'plugin', 'rules']);
    const unknown = [...named].filter((cmd) => !known.has(cmd)).sort(compareEnUs);
    const list = [...named].sort(compareEnUs).join(', ');
    out.push(unknown.length === 0 ? pass(id, title, `${named.size} named: ${list}`) : fail(id, title, `unknown: ${unknown.join(', ')}`));
  }
  {
    const id = 'guide-links-resolve';
    const title = 'Every relative link in the guide resolves';
    const broken: string[] = [];
    let links = 0;
    for (const page of inputs.pages) {
      for (const match of page.text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = match[1]!;
        if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue;
        links++;
        const target = toPosix(relative('/', resolve('/', dirname(page.path), href.split('#')[0]!)));
        if (!inputs.exists(target)) broken.push(`${page.path} -> ${href}`);
      }
    }
    out.push(broken.length === 0 ? pass(id, title, `${links} links`) : fail(id, title, `broken: ${broken.join('; ')}`));
  }
  {
    const id = 'guide-names-checklist';
    const title = 'A guide heading names every customer checklist step';
    const words = (text: string) => text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
    const headings = inputs.pages.flatMap((page) => page.text.split('\n').filter((line) => line.startsWith('#')).map((line) => new Set(words(line))));
    const missing = inputs.customerSteps
      .map((step) => step.split(':')[0]!)
      .filter((name) => !headings.some((heading) => words(name).every((word) => heading.has(word))));
    out.push(missing.length === 0 ? pass(id, title, `${inputs.customerSteps.length} steps named`) : fail(id, title, `not named: ${missing.join(', ')}`));
  }
  return out;
}

export function countStatuses(apps: readonly AppReadiness[], guide: readonly CriterionResult[]): Record<CriterionStatus, number> {
  const counts: Record<CriterionStatus, number> = { PASS: 0, FAIL: 0, GAP: 0 };
  for (const item of [...apps.flatMap((app) => app.criteria), ...guide]) counts[item.status]++;
  return counts;
}

export function onboardingReadinessAsJson(result: OnboardingReadiness): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function onboardingReadinessAsMarkdown(result: OnboardingReadiness): string {
  const lines = ['# Onboarding readiness', '', `PASS ${result.counts.PASS} · FAIL ${result.counts.FAIL} · GAP ${result.counts.GAP}`, ''];
  const ids = result.apps[0]?.criteria.map((item) => item.id) ?? [];
  lines.push(`| criterion | ${result.apps.map((app) => cell(app.fixture.split('/').pop() ?? app.fixture)).join(' | ')} |`);
  lines.push(`|---|${result.apps.map(() => '---').join('|')}|`);
  for (const id of ids) lines.push(`| ${id} | ${result.apps.map((app) => app.criteria.find((item) => item.id === id)?.status ?? '-').join(' | ')} |`);
  for (const item of result.guide) lines.push(`| ${item.id} | ${result.apps.map(() => item.status).join(' | ')} |`);
  for (const app of result.apps) {
    lines.push('', `## ${app.fixture} (${app.app ?? 'no app name'})`, '');
    for (const item of app.criteria) lines.push(`- **${item.status}** ${item.id} — ${item.title}: ${item.detail}`);
  }
  lines.push('', '## Guide', '');
  for (const item of result.guide) lines.push(`- **${item.status}** ${item.id} — ${item.title}: ${item.detail}`);
  lines.push('');
  return lines.join('\n');
}

/** Run every check on the named fixtures (default: the library and kitchen-sink exports). */
export async function onboardingReadiness(repoRoot: string, fixtureIds: readonly string[] = DEFAULT_FIXTURES): Promise<OnboardingReadiness> {
  const apps: AppReadiness[] = [];
  for (const id of fixtureIds) {
    const file = join(repoRoot, 'fixtures', `${id}.ds`);
    if (!existsSync(file)) throw new Error(`no fixture ${id} (expected ${file})`);
    apps.push(checkApp(await loadAppInputs(repoRoot, { id, file })));
  }
  const guide = checkGuide(loadGuideInputs(repoRoot));
  return { schema: 'c2c-onboarding-readiness/1', apps, guide, counts: countStatuses(apps, guide) };
}
