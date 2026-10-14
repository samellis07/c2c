/**
 * Data Store table budget of a corpus of sample Creator apps (not included): per app, the tables its
 * own forms need and the support tables the converter adds, under a default
 * deploy and under `c2c deploy --mail`.
 *
 * Data Store tables count against one org-wide limit shared by every project,
 * so each support table is created only for an app that uses its feature:
 *
 * - `C2C_Flow_History`: an app with an approval or blueprint (schema generator).
 * - `C2CJobCheckpoint`: an app with a form schedule — the sweeper's checkpoints.
 * - `c2c_mail_log`: an app whose functions send mail, deployed with `--mail`.
 *   A default deploy refuses every send and writes no log, so it creates none.
 *
 * Counts and app indexes only — never app names, paths or source text — so the
 * rendered doc (docs/table-budget.md) is safe to commit and regenerates
 * byte-identically. Regenerate with:
 *
 *   C2C_FIXTURES_DIR=<fixtures> npm run tables:budget
 *
 * which reads the gallery from `--dir`, `C2C_FIXTURES_DIR/gallery`, or
 * `C2C_GALLERY_DIR`, in that order.
 */
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { parseFile, parseProject } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { listReportApps } from '../../cli/src/migration-report.js';
import type { GuardOk } from '../../deploy/src/guards.js';
import { MAIL_LOG_TABLE } from '../../deploy/src/mail.js';
import { deployFiles, deployTableSteps } from '../../deploy/src/plan.js';
import { resolveStatusDir } from './status.js';

export interface AppTableBudget {
  /** Tables for the app's forms, subforms and multi lookups. */
  appTables: number;
  /** C2C_Flow_History (0 or 1). */
  flowHistory: number;
  /** c2c_mail_log under a default deploy (mail off). */
  mailLogDefault: number;
  /** c2c_mail_log under `c2c deploy --mail`. */
  mailLogWithMail: number;
  /** C2CJobCheckpoint for an app with a form schedule. */
  jobCheckpoint: number;
}

// Placeholder scope: the counts depend only on the app.
const GUARD: GuardOk = {
  org: '10000000000',
  projectId: '1001',
  environment: 'Development',
  projectName: 'c2c-budget',
  dc: 'eu',
  registry: { org: '10000000000', dc: 'eu', env: 'Development', projects: {} },
};

const uniqueTables = (steps: readonly { table: string; nosql: boolean }[]): Set<string> => new Set(steps.filter((step) => !step.nosql).map((step) => step.table));

export function appTableBudget(app: App): AppTableBudget {
  const { schema, sendsMail } = deployFiles(app, GUARD, false);
  // The generated system tables, by canonical name — allocated names can carry a
  // suffix when a form takes the base name first.
  const system = new Map(schema.tables.filter((table) => table.role === 'system' && !table.nosql).map((table) => [table.name, table.form]));
  const off = uniqueTables(deployTableSteps(schema, sendsMail, false));
  const on = uniqueTables(deployTableSteps(schema, sendsMail, true));
  const created = (kind: string) => [...off].filter((name) => system.get(name) === kind).length;
  return {
    appTables: [...off].filter((name) => !system.has(name) && name !== MAIL_LOG_TABLE).length,
    flowHistory: created('C2C_Flow_History'),
    mailLogDefault: off.has(MAIL_LOG_TABLE) ? 1 : 0,
    mailLogWithMail: on.has(MAIL_LOG_TABLE) ? 1 : 0,
    jobCheckpoint: created('C2CJobCheckpoint'),
  };
}

export function computeTableBudget(dir: string): AppTableBudget[] {
  return listReportApps(dir).map((entry) => {
    const ir = statSync(entry.target).isDirectory() ? parseProject(entry.target).ir : parseFile(entry.target).ir;
    return appTableBudget(ir);
  });
}

/** Support tables a deploy creates. */
const support = (row: AppTableBudget, mail: boolean): number => row.flowHistory + row.jobCheckpoint + (mail ? row.mailLogWithMail : row.mailLogDefault);
const sum = (rows: readonly AppTableBudget[], pick: (row: AppTableBudget) => number): number => rows.reduce((n, row) => n + pick(row), 0);

export function renderTableBudgetDoc(rows: readonly AppTableBudget[]): string {
  const totalBefore = sum(rows, (row) => row.appTables + support(row, true));
  const totalAfter = sum(rows, (row) => row.appTables + support(row, false));
  return [
    '# Table budget',
    '',
    'Regenerable summary of a corpus of sample Creator apps (not included). Recompute with',
    '`C2C_FIXTURES_DIR=<fixtures> npm run tables:budget`; `npm test` fails when this file is',
    'stale and the local corpus is present. Counts and app indexes only — no app names, paths, or',
    'script text.',
    '',
    'Data Store tables count against one org-wide limit shared by every project and',
    'environment. Creating a table past it fails with',
    '`403 API_LIMIT_REACHED: You have reached the max limit of your current API Limit for table`.',
    'Each support table is therefore created only for an app that uses its feature:',
    '',
    '| support table | created when | created by |',
    '|---|---|---|',
    '| `C2C_Flow_History` | the app has an approval or a blueprint | `c2c plan` (import) and `c2c deploy` |',
    '| `C2CJobCheckpoint` | the app has a form schedule (the sweeper\'s checkpoints) | `c2c plan` (import) and `c2c deploy` |',
    '| `c2c_mail_log` | the app\'s functions send mail **and** the deploy ran with `--mail` | `c2c deploy --mail` |',
    '',
    'An app without the feature gets no table, and its functions never reference it: a',
    'deploy of an app that sends no mail ships no mail module, and a deploy without `--mail`',
    'writes no delivery log.',
    '',
    '**Before / after.** Before, every deploy of an app whose functions send mail created',
    '`c2c_mail_log`, with or without `--mail`: the "with `--mail`" columns below. After, a',
    'default deploy creates it only with `--mail`: the "default" columns.',
    '',
    '| | default deploy (after) | with `--mail` (before) |',
    '|---|---:|---:|',
    `| corpus apps | ${rows.length} | ${rows.length} |`,
    `| app tables | ${sum(rows, (row) => row.appTables)} | ${sum(rows, (row) => row.appTables)} |`,
    `| \`C2C_Flow_History\` | ${sum(rows, (row) => row.flowHistory)} | ${sum(rows, (row) => row.flowHistory)} |`,
    `| \`C2CJobCheckpoint\` | ${sum(rows, (row) => row.jobCheckpoint)} | ${sum(rows, (row) => row.jobCheckpoint)} |`,
    `| \`c2c_mail_log\` | ${sum(rows, (row) => row.mailLogDefault)} | ${sum(rows, (row) => row.mailLogWithMail)} |`,
    `| support tables | ${sum(rows, (row) => support(row, false))} | ${sum(rows, (row) => support(row, true))} |`,
    `| **all tables** | **${totalAfter}** | **${totalBefore}** |`,
    `| largest app | ${Math.max(0, ...rows.map((row) => row.appTables + support(row, false)))} | ${Math.max(0, ...rows.map((row) => row.appTables + support(row, true)))} |`,
    '',
    `Apps whose sweeper checkpoints in \`C2CJobCheckpoint\`: ${sum(rows, (row) => row.jobCheckpoint)}.`,
    '',
    '## Per app',
    '',
    'Apps in corpus order. "c2c" is the support tables a deploy creates; "total" is app plus',
    'c2c tables. "checkpoint" marks the apps whose deploy creates `C2CJobCheckpoint`; it is',
    'counted in c2c/total already.',
    '',
    '| app | app tables | c2c before | total before | c2c after | total after | checkpoint |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map(
      (row, i) =>
        `| ${i + 1} | ${row.appTables} | ${support(row, true)} | ${row.appTables + support(row, true)} | ${support(row, false)} | ${row.appTables + support(row, false)} | ${row.jobCheckpoint} |`,
    ),
    '',
  ].join('\n');
}

function main(argv: string[]): number {
  const take = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    process.stderr.write('usage: tables:budget [--dir <gallery-dir>] [--out <file>]\n');
    return 2;
  }
  const dir = resolveStatusDir(process.env, take('--dir'));
  if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write('tables:budget: gallery not found; pass --dir or set C2C_FIXTURES_DIR or C2C_GALLERY_DIR\n');
    return 1;
  }
  const rows = computeTableBudget(dir);
  if (rows.length === 0) {
    process.stderr.write('tables:budget: no apps in the gallery directory\n');
    return 1;
  }
  const out = take('--out') ?? join(repoRoot(), 'docs/table-budget.md');
  writeFileSync(out, renderTableBudgetDoc(rows));
  const total = (mail: boolean) => sum(rows, (row) => row.appTables + support(row, mail));
  process.stdout.write(`tables:budget apps=${rows.length} tables-before=${total(true)} tables-after=${total(false)}\n`);
  return 0;
}

const invoked = process.argv[1]?.endsWith('/table-budget.js') ?? false;
if (invoked) process.exitCode = main(process.argv.slice(2));
