#!/usr/bin/env node
/**
 * c2c: creator-to-catalyst command line.
 *
 *   c2c parse <file|dir> [--json]   parse a .ds file or a multi-file export folder; print an IR summary or the IR as JSON
 *   c2c analyze <file|dir> [--json]  pre-migration readiness: feature verdicts, Deluge coverage, blockers, score, effort estimate
 *                                   --quality adds compiles (Q2) and smokeClean (Q4); see docs/quality-gate.md
 *   c2c precheck <file.ds> [--json]  every migration finding in one pass (blockers and warnings)
 *                                   exit 0 no blockers, 1 blockers, 2 usage or locked Marketplace export,
 *                                   3 missing file, 4 not a parseable .ds
 *   c2c doctor [--app <file.ds|dir>] [--dc <dc>] [--org <id>] [--project <id>] [--json]
 *                                   read-only environment check; writes c2c-out/.c2c/doctor.json
 *                                   exit 0 green, 1 a FAIL check, 2 usage, 6 Node/vendor integrity
 *   c2c doctor --mcp-begin           open a one-time request naming the Catalyst MCP calls to make in the session
 *   c2c doctor --mcp-observed -      record MCP evidence from the observed call results on stdin, then run D-B and D-V
 *   c2c doctor --record-mcp <file> --operator   operator-only: merge a supplied evidence file
 *   c2c doctor --local --quiet       SessionStart-hook mode: local checks only, no output
 *   c2c --verify-vendor <dir>        vendor manifest check for the plugin bin launcher; exit 0 or 6
 *                                   a --confirm write (deploy, migrate-data, smoke, edit --apply) refuses with exit 5
 *                                   unless doctor.json is green, < 12 h old, same version and scope
 *   c2c analyze <file|dir> --lock <file>  same, counting that lock's applied fills against the deterministic flag
 *   c2c migration-report <dir> [--label name] [--out file] [--json]
 *                                   per-app deterministic flags plus the aggregate: total apps vs
 *                                   deterministic apps, with the 95%/100% targets counting deterministic only
 *   c2c corpus <dir> [--label name] [--out file] [--top n]
 *                                   round-trip every .ds under <dir> and print an aggregate summary
 *                                   with IR coverage (no contents); --top sets how many unmodelled kinds to list
 *   c2c features <dir> [--unit dir|file] [--names] [--out file] [--apps file]
 *                                   count matrix features per app from the IR (feature names and counts only);
 *                                   an app is each sub-folder of <dir> (merged) or, with --unit file, each .ds file;
 *                                   --apps writes the per-app summary table; --names labels apps by folder/file name
 *   c2c schema <file|dir> [--json|--iac|--report] [--out file]
 *                                   [--source-backup <zip|dir>|--source-csv <dir>|--source-json <dir>] measures
 *                                   the records so is_mandatory/is_unique match the deployed columns
 *                                   dry-run Data Store plan. Default output is the human report.
 *   c2c iac-drift <project-template.json> <export-template.json>
 *                                   normalise both templates and diff them; prints missing / changed / extra.
 *                                   Exit 0 exact, 1 missing or changed, 2 extra only, 3 unreadable input.
 *   c2c schema-corpus <dir> [--label name] [--out file]
 *                                   aggregate schema counts for every app under <dir>. No field values.
 *   c2c seed <file|dir> --out <dir> [--n 50] [--seed link] [--json]
 *                                   deterministic per-form CSVs plus seed.json in the canonical
 *                                   seed schema (docs/seed-schema.md) for migrate-data --seed.
 *                                   Image, signature, file, audio, and video fields also write
 *                                   a fixture file next to seed.json. The cell names that file.
 *                                   Prints row counts only; --json prints the machine report.
 *                                   Exit 0 clean, 1 one or more forms blocked (seed.json and the
 *                                   unblocked CSVs are still written; a blocked form has no file),
 *                                   2 usage.
 *   c2c seed <file|dir> --creator-import --out <dir> [--rows 20] [--seed link]
 *                                   realistic CSVs for Zoho Creator's report Import Data UI,
 *                                   plus IMPORT_ORDER.txt and README.md. Forms with inline
 *                                   subforms are a manual worksheet, not an import file.
 *                                   A stateless form whose must-have lookup targets one of
 *                                   those forms is left out of the import order.
 *   c2c migrate-data --dry-run --dc <dc> --creator-base <url> --catalyst-base <url>
 *                    --owner <name> --app <link> --report <Report:Table> --checkpoint <file>
 *                                   cursor read, batches of at most 200, checkpoint of cursors and ids.
 *                                   Creator rehearsal. Live writes are refused. This command does not POST.
 *   c2c migrate-data --seed <file> --ds <file|dir> [--app <link>] [--project <id-or-name>] [--org <id>] [--confirm]
 *                                   [--login-user <email>]
 *                                   seed-file writes. Plans unless --confirm. --confirm requires --ds.
 *                                   --app defaults to the application name in --ds.
 *                                   Same project guards as deploy.
 *                                   --ds enables lookup remap from the app schema; synthetic
 *                                   seed.json files are converted in code (docs/seed-schema.md).
 *   c2c migrate-data --source-json <dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--confirm] [--allow-empty]
 *                                   Creator JSON report export. Record ID is the source id. A lookup object
 *                                   is remapped by its record ID. Counts come from the export. Same guards.
 *   c2c migrate-data --source-csv <dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--confirm] [--allow-empty]
 *                                   Creator CSV report export. counts.json is optional. Without an ID column
 *                                   the source id is derived and the plan says to prefer the JSON export.
 *                                   A lookup cell may be the display value. Same guards.
 *   c2c migrate-data --source-backup <zip|dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--confirm] [--allow-empty]
 *                                   Creator application backup ("Schema + Data + Include Files"). Every field,
 *                                   lookup record ids, and subform rows. Counts come from the backup. Same guards.
 *   c2c users plan --source-backup <zip|dir> --ds <file|dir> [--out <dir>] [--state <file>] [--salt <s>] [--social <a,b>] [--json]
 *                                   Creator users -> Catalyst roles: per-role counts and usr_<hash> ids only.
 *                                   Identities are read at run time, never written.
 *   c2c users invite --source-backup <zip|dir> --ds <file|dir> --project <id> --org <org> --confirm
 *                    [--slate-domain <host>] [--role-ids <name=id,...>] [--state <file>] [--salt <s>]
 *                                   POST /project-user per pending user with redirect_url = the Slate URL;
 *                                   each landed invite is recorded in the state file so a re-run skips it.
 *   c2c sync-delta --source-json|--source-csv <dir>|--source-backup <zip|dir> --ds <file|dir> --since <state-file|dir>
 *                                   [--project <id>] [--org <org>] [--confirm] [--apply-deletes] [--allow-mass-delete] [--max-delete-percent <pct>]
 *                                   new, changed and deleted records against the checkpoint in the project's state file.
 *                                   Plans unless --confirm. --confirm upserts by source id and records the checkpoint.
 *                                   Deletions are reported; they are applied only with --apply-deletes, and only
 *                                   from a provably complete source. Same guards.
 *   c2c cutover-checklist <file|dir> [same source flags] [--since <state>] [--smoke <file>] [--rollback-export <dir|file>] [--project <id>] [--dc <dc>] [--config <file>] [--out <dir>]
 *                                   cut-over checklist filled with the app's facts; --out also writes c2c-proof.json/.md.
 *   c2c proof <file|dir> [same options]
 *                                   counts, checksums, smoke result and readiness (% automatic plus the manual items).
 *   c2c rollback-export --ds <file|dir> --out <dir> (--rows <dir> | [--project <id>] [--org <id>] [--confirm])
 *                                   Data Store rows as CSV files for Creator's report import, ids in a side file.
 *   c2c deploy <file|dir> [--project <id>] [--org <id>] [--confirm] [--out <dir>] [--mail] [--ui vanilla|react] [--async-on-success [--triggers-wired]]
 *                                   Catalyst app dir and a full plan. Development only. CLI deploy runs only with --confirm.
 *                                   react is the default (web/ built to web/dist); --ui vanilla keeps the previous target as the fallback.
 *   c2c plan <file|dir> --out <dir> [--dc <dc>] [--mail]
 *                                   offline migration plan (no credentials, no project): plan.md, plan.json,
 *                                   provision/plan.json, provision/tables.json, provision/inputs.json, c2c-manifest.json.
 *                                   DC from --dc or c2c-deploy.json.
 *   c2c provision --out <dir> [--status | --next | --confirm --run <id> | --record <id> [--result <file>] [--applied]]
 *                                   drive provision/plan.json to done. MCP steps are printed for the host
 *                                   agent to call (c2c never calls MCP); every step ends when its read-back
 *                                   matches. --run is for via:cli steps only. Scope from flags or c2c-deploy.json.
 *   c2c edit <file|dir> <op> ... [--dc <dc>] [--edits <file>] [--out <dir>] [--json] [--apply] [--confirm]
 *                                   one model edit (add-field, rename-field, remove-field, set-picklist,
 *                                   add-report-column, add-role) and its plan diff. Dry run unless --apply;
 *                                   --apply records it in the edits log that plan and deploy replay.
 *                                   A rename stays a column rename. A drop needs --confirm.
 *   c2c deploy <file|dir> --backfill-shadows [--confirm] [--project <id>] [--org <id>]
 *                                   fill NULL <Field>__n shadows from the exact varchar (rows that predate the column).
 *   c2c smoke <file|dir> --project <id> --org <org> [--url <fn-base>] [--confirm] [--auth-token <token> | --session-cookie <name=value>]
 *                                   dry-run plan of the generated routes (submit, read-back, report, cleanup); calls only with --confirm.
 *                                   --confirm with no credential prints one step: open <app url>#/admin/smoke in your own browser
 *   c2c smoke <file|dir> --result-code <code|->   verify the result code that page shows (pasted into your AI chat)
 *   c2c smoke <file|dir> --result <file|->   the same check on the c2c-smoke/1 block saved to a file
 *   c2c deluge <dir> [--out file] [--top n] [--label name]
 *                                   translate every Deluge span and print aggregate numbers only
 *                                   (no app names, paths, or script text)
 *   c2c ui <file|dir> --out <dir>   dry-run Slate PWA (hashed assets) plus upload, lookup, and report stubs
 *   c2c score-ui <file|dir> [--ui <dir>] [--json] [--write <score.json>]
 *                                   operator/CI tool: score the generated UI against the Creator source, desktop
 *                                   and phone, out of 10 (packages/ui-score/rubric.json). --ui reads what
 *                                   `c2c ui --out <dir>` wrote; without it the bundle is built in memory.
 *                                   Renders offline in jsdom (a dev dependency). Exit 0 both >= 8, 1 below, 2 usage.
 *   c2c ui-react <file|dir> --out <dir> [--api-base <url>] [--no-auth] [--upgrade-platform] [--force]
 *                                   React + Vite app for Slate (docs/react-target.md). Into an existing app it
 *                                   rewrites src/generated only and keeps src/custom; stops on a hand-edited generated file
 *   c2c auth <file|dir> [--json] [--out file]
 *                                   dry-run Authentication plan. Does not call Catalyst.
 *   c2c ui-corpus <dir> [--label name] [--out file]
 *                                   forms, reports, and pages generated vs TODO. Folder names only
 *   c2c fill-todos <file|dir> --emit <dir>
 *                                   one JSON task per remaining migration TODO. No model call.
 *   c2c fill-todos <file|dir> --accept <task-id> <fill-file> [--lock c2c.lock.json]
 *                                   lint, run the D3 and unit gates, and record the fill
 *   c2c fill-todos <file|dir> --lock <file> --report
 *                                   print stale lock keys. Does not rewrite output.
 *   c2c status --project <id> [--org <id>] [--app <name>] [--json] [--fake] [--table-budget <n>]
 *                                   read-only project health: deployed functions with last
 *                                   deploy time, Slate URL, table count, recent function errors.
 *                                   --table-budget compares the count against the org-wide
 *                                   table-create limit (Catalyst doesn't publish the number).
 *                                   Unanswered reads become console checklist steps.
 *                                   --fake runs a built-in demo, labelled as such.
 *                                   Exit 0 all answered, 1 checklist fallback, 2 usage.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  decode,
  featureReport,
  formatApps,
  formatFeatures,
  formatSummary,
  listDsFiles,
  LockedExportError,
  NotFileError,
  parseFile,
  parseFileOrProjectWithSidecars,
  parseProject,
  roundTrips,
  runCorpus,
  type App,
} from '../../core/src/index.js';
import { generateSchema, schemaAsJson, schemaAsReport, schemaCorpusMarkdown } from '../../schema/src/index.js';
import { canonicalSeedJson, emptyCheckpoint, generateCreatorImport, generateSeed, migrateData, writeCheckpointFile, type Checkpoint, type MigrateResponse } from '../../data/src/index.js';
import { accumulate, emptyNumbers, formatCorpus } from '../../deluge/src/index.js';
import { authApplyPlan, authApplyReport, authAsJson, authAsReport, authPlan } from '../../auth/src/index.js';
import { buildUi, DomUnavailableError, formatUiReport, uiCorpus } from '../../ui/src/index.js';
import { generateReactApp, HandEditedError, writeReactApp } from '../../ui-react/src/index.js';
import { defaultIo, deployCli, diffTemplate, editCli, formatDrift, hasReportJson, planCli, projectTemplateJson, provisionCli, readSourceBackup, readSourceCsv, readSourceJson, rollbackExportCli, seedMigrateCli, smokeCli, sourceBackupCli, sourceCsvCli, statusCli, syncDeltaCli, usersCli, verifyCli } from '../../deploy/src/index.js';
import { cutoverCli } from './cutover.js';
import { ARGV_SPEC, argvShapeProblems, seedArgsProblem } from './argv.js';
import { GATE_EXIT, defaultDoctorIo, doctorCli, doctorGateForArgs, doctorStamp, gateRefusalMessage, verifyVendorCli, workspaceDir, type DoctorStamp } from '../../doctor/src/index.js';
import { FillTodoError, fillTodosMain } from '../../deluge/src/fill-todos.js';
import { analyze, analyzeAsJson, analyzeAsText } from './analyze.js';
import { precheck, precheckAsJson, precheckAsText } from './precheck.js';
import { DISPATCH_COMMANDS } from './commands.js';

/** precheck exit codes: input errors never share a code with "has blockers". */
const PRECHECK_EXIT = { clean: 0, blockers: 1, missing: 3, unparsable: 4 } as const;
import { analyzeQuality, qualityAsText } from './analyze-quality.js';
import { migrationReportAsJson, migrationReportAsText, migrationReportForDir } from './migration-report.js';
import { readLock } from '../../deluge/src/index.js';
import { bundleFromDir, bundleFromFiles, scoreFileOf, scoreUi, uiScoreAsText } from '../../ui-score/src/score.js';

const USAGE =
    'usage: c2c parse <file|dir> [--json]\n       c2c corpus <dir> [--label name] [--out file] [--top n]\n' +
      '       c2c features <dir> [--unit dir|file] [--names] [--out file] [--apps file]\n' +
      '       c2c schema <file|dir> [--json|--iac|--report] [--out file] [--source-backup <zip|dir>|--source-csv <dir>|--source-json <dir>] [--allow-empty]\n' +
      '       c2c iac-drift <project-template.json> <export-template.json>\n' +
      '       c2c schema-corpus <dir> [--label name] [--out file]\n' +
      '       c2c seed <file|dir> --out <dir> [--n 50] [--seed link] [--json] (exit 0 clean, 1 a form is blocked, 2 usage)\n' +
      '       c2c seed <file|dir> --creator-import --out <dir> [--rows 20] [--seed link]\n' +
      '              (when some tables are blocked, seed.json and the CSVs for unblocked tables are still written; blocked tables get no CSV, junction rows or fixture files)\n' +
      '       c2c migrate-data --dry-run --dc <dc> --creator-base <url> --catalyst-base <url> --owner <name> --app <link> --report <Report:Table> --checkpoint <file>\n' +
      '       c2c migrate-data --seed <file> --ds <file|dir> [--app <link>] [--project <id-or-name>] [--org <id>] [--confirm] [--checkpoint <file>] [--login-user <email>]\n' +
      '       c2c migrate-data --source-json <dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--app <link>] [--confirm] [--allow-empty] [--checkpoint <file>]\n' +
      '       c2c migrate-data --source-csv <dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--app <link>] [--confirm] [--allow-empty] [--checkpoint <file>]\n' +
      '       c2c migrate-data --source-backup <zip|dir> --ds <file|dir> [--project <id-or-name>] [--org <id>] [--app <link>] [--confirm] [--allow-empty] [--checkpoint <file>]\n' +
      '       c2c users plan --source-backup <zip|dir> --ds <file|dir> [--out <dir>] [--state <file>] [--salt <s>] [--social <a,b>] [--json]\n' +
      '       c2c users invite --source-backup <zip|dir> --ds <file|dir> --project <id> --org <org> --confirm [--slate-domain <host>] [--role-ids <name=id,...>] [--state <file>]\n' +
      '       c2c sync-delta --source-json <dir> --ds <file|dir> --since <state-file|dir> [--project <id>] [--org <org>] [--confirm] [--apply-deletes] [--allow-mass-delete] [--max-delete-percent <pct>]\n' +
      '              (--source-csv <dir> and --source-backup <zip|dir> read the same reports)\n' +
      '       c2c cutover-checklist <file|dir> [--source-json|--source-csv <dir>|--source-backup <zip|dir>] [--since <state-file|dir>] [--smoke <file>] [--rollback-export <dir|file>] [--project <id>] [--dc <dc>] [--config <c2c-deploy.json>] [--out <dir>]\n' +
      '       c2c proof <file|dir> [same options as cutover-checklist]\n' +
      '       c2c rollback-export --ds <file|dir> --out <dir> --rows <dir>\n' +
      '       c2c rollback-export --ds <file|dir> --out <dir> [--project <id-or-name>] [--org <id>] [--app <link>] [--confirm] [--dc <dc>] [--config <c2c-deploy.json>]\n' +
      '              (without --rows: plans the tables to read; --confirm reads the rows from the project)\n' +
      '       c2c verify --data-parity --ds <file|dir> (--source-json <dir> | --source-csv <dir> | --source-backup <zip|dir>) --rows <dir> [--json]\n' +
      '       c2c deploy <file|dir> [--project <id-or-name>] [--org <id>] [--env Development] [--out <dir>] [--ui vanilla|react] [--mail [--mail-from <address> --mail-sender-verified]] [--confirm] [--resume] [--api-base <url>] [--function-env <file>|new] [--slate-domain <host>] [--slate-name <name>] [--admin-email <mail> --admin-name <name> --admin-role <name> --admin-role-id <id>] [--async-on-success [--triggers-wired]] [--subset-shims] [--source-backup <zip|dir>|--source-csv <dir>|--source-json <dir>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>] [--edits <file>]\n' +
      '       c2c deploy <file|dir> --backfill-shadows [--confirm] [--catalyst-base <url>] [--projects <file>] [--dc <dc>] [--config <c2c-deploy.json>]\n' +
      '       c2c plan <file|dir> --out <dir> [--dc <dc>] [--mail] [--allow-budget-fail]\n' +
      '       c2c provision --out <dir> [--status|--next|--confirm --run <id>|--record <id> [--result <file>] [--applied]]\n' +
      '       c2c edit <file|dir> <op> ... [--dc <dc>] [--edits <file>] [--out <dir>] [--json] [--apply] [--confirm]\n' +
      '       c2c smoke <file|dir> [--project <id-or-name>] [--org <id>] [--url <app-url>] [--confirm] [--report <file>]\n' +
      '       c2c smoke <file|dir> --result-code <code|-> [--project <id>] [--url <app-url>] [--max-age <minutes>] [--report <file>]\n' +
      '       c2c smoke <file|dir> --result <file|-> [--project <id>] [--url <app-url>] [--max-age <minutes>] [--report <file>]\n' +
      '       c2c analyze <file|dir> [--json] [--lock <file>] [--quality]\n' +
      '       c2c precheck <file.ds> [--json]\n' +
      '       c2c doctor [--app <file.ds|dir>] [--dc <dc>] [--org <id>] [--project <id>] [--json] [--local] [--quiet]\n' +
      '       c2c doctor --mcp-begin [--json]\n' +
      '       c2c doctor --mcp-observed - [--dc <dc>] [--org <id>] [--project <id>]\n' +
      '       c2c doctor --record-mcp <file> --operator   (operator-only)\n' +
      '       c2c --verify-vendor <dir>\n' +
      '       c2c migration-report <dir> [--label name] [--out file] [--json]\n' +
      '       c2c deluge <dir> [--label name] [--out file] [--top n]\n' +
      '       c2c ui <file|dir> --out <dir>\n' +
      '       c2c score-ui <file|dir> [--ui <dir>] [--json] [--write <score.json>]\n' +
      '       c2c ui-react <file|dir> --out <dir> [--api-base <url>] [--no-auth] [--upgrade-platform] [--force]\n' +
      '       c2c auth <file|dir> [--json|--apply] [--out file]\n' +
      '       c2c ui-corpus <dir> [--label name] [--out file]\n' +
      '       c2c fill-todos <file|dir> --emit <dir>\n' +
      '       c2c fill-todos <file|dir> --accept <task-id> <fill-file> [--lock c2c.lock.json]\n' +
      '       c2c fill-todos <file|dir> --lock <file> --report\n' +
      '       c2c doctor [--local] [--quiet]\n' +
      '       c2c --verify-vendor <dir>\n' +
      '       c2c status --project <id> [--org <id>] [--app <name>] [--json] [--fake] [--table-budget <n>]\n';

function helpRequested(cmd: string, args: readonly string[]): boolean {
  const flags = ARGV_SPEC[cmd]?.flags;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return true;
    if (flags?.[arg] === 'value') i++;
  }
  return false;
}

function helpText(command?: string): string {
  if (!command) return USAGE;
  const lines = USAGE.trimEnd().split('\n');
  const selected: string[] = [];
  let includeContinuation = false;
  for (const line of lines) {
    const match = line.match(/(?:usage: )?c2c ([^ <]+)/);
    if (match) {
      includeContinuation = match[1] === command;
      if (includeContinuation) selected.push(line);
    } else if (includeContinuation && /^\s+\(/.test(line)) {
      selected.push(line);
    } else {
      includeContinuation = false;
    }
  }
  return selected.length ? `${selected.join('\n')}\n` : USAGE;
}

function printHelp(command?: string): number {
  process.stdout.write(helpText(command));
  return 0;
}

function usage(): never {
  process.stderr.write(USAGE);
  process.exit(2);
}

function summarize(ir: App): string {
  const fields = ir.forms.reduce((n, f) => n + f.fields.length, 0);
  return [
    `application: ${ir.name ?? '(none)'}  shape: ${ir.shape}`,
    `sections: ${ir.sections.length}  forms: ${ir.forms.length}  fields: ${fields}  reports: ${ir.reports.length}  pages: ${ir.pages.length}`,
    `workflows: ${ir.workflows.length}  functions: ${ir.functions.length}  permissions: ${ir.permissions.length}`,
    `unknown nodes: ${ir.unknown.length} of ${ir.statementCount} statements`,
  ].join('\n');
}

function loadIr(target: string): App | undefined {
  try {
    return parseFileOrProjectWithSidecars(target).ir;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      process.stderr.write(`c2c: no such file or directory: ${target}\n`);
      return undefined;
    }
    throw err;
  }
}

/**
 * Single-target .ds load that fails closed on a locked Marketplace export:
 * prints the refusal and reports locked so the caller exits 2. Anything else
 * propagates to the caller.
 */
function loadIrOrLocked(target: string): { ir: App | undefined; locked: boolean } {
  try {
    return { ir: loadIr(target), locked: false };
  } catch (err) {
    if (err instanceof LockedExportError) {
      process.stderr.write(`c2c: ${err.message}\n`);
      return { ir: undefined, locked: true };
    }
    throw err;
  }
}

function writeOut(text: string, out: string | undefined): void {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (out) writeFileSync(out, body);
  else process.stdout.write(body);
}

async function migrateCli(args: string[]): Promise<number> {
  if (!args.includes('--dry-run')) {
    process.stderr.write('c2c: migrate-data refuses to write; pass --dry-run\n');
    return 2;
  }
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dc = flag('--dc');
  const creator = flag('--creator-base');
  const catalyst = flag('--catalyst-base');
  const owner = flag('--owner');
  const app = flag('--app');
  const checkpointPath = flag('--checkpoint');
  const tables: { report: string; table: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--report' || !args[i + 1]) continue;
    const [report, table] = args[i + 1].split(':');
    if (!report || !table) {
      process.stderr.write('c2c: --report must be Report:Table\n');
      return 2;
    }
    tables.push({ report, table });
  }
  if (!dc || !creator || !catalyst || !owner || !app || !checkpointPath || !tables.length) usage();
  let checkpoint: Checkpoint = emptyCheckpoint();
  if (statSync(checkpointPath, { throwIfNoEntry: false })?.isFile()) {
    const parsed = JSON.parse(readFileSync(checkpointPath, 'utf8')) as Checkpoint;
    if (parsed.version !== 1 || !parsed.tables) {
      process.stderr.write('c2c: checkpoint is not version 1\n');
      return 2;
    }
    checkpoint = parsed;
  }
  const result = await migrateData({
    dc,
    creatorBase: creator,
    catalystBase: catalyst,
    owner,
    appLink: app,
    tables,
    dryRun: true,
    checkpoint,
    saveCheckpoint: (next) => writeCheckpointFile(checkpointPath, next),
    fetch: (url, init) => globalThis.fetch(url, init) as Promise<MigrateResponse>,
  });
  for (const table of result.tables) {
    const missing = table.missingIds?.length ? ` missing ${table.missingIds.join(',')}` : '';
    process.stdout.write(
      `${table.table}: source ${table.sourceCount} written ${table.writtenCount} batches ${table.batches.length} mismatch ${table.mismatch}${missing}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

/** Report stamp: dry-run commands record doctor truth, they never refuse. */
function doctorReportStamp(): DoctorStamp {
  return doctorStamp({ workspace: workspaceDir(process.env) });
}

/** `doctor: <status>` folded into a --json report (every serializer is JSON.stringify(x, null, 2)). */
function stampedJson(json: string): string {
  const doc = JSON.parse(json) as Record<string, unknown>;
  doc.doctor = doctorReportStamp();
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** `provision --run import` (the one-shot project import) is the only verb that creates a project. */
function provisionCreatesProject(args: readonly string[]): boolean {
  const at = args.indexOf('--run');
  return at >= 0 && args[at + 1] === 'import' && !args.includes('--project');
}

/**
 * A live command with --confirm needs a green, current, same-scope
 * doctor.json. Returns the exit code to refuse with, or undefined to proceed.
 */
function doctorGateRefusal(args: readonly string[], opts: { createsProject?: boolean } = {}): number | undefined {
  if (!args.includes('--confirm')) return undefined;
  const { verdict, scope } = doctorGateForArgs(args, { cwd: workspaceDir(process.env), env: process.env, ...(opts.createsProject ? { createsProject: true } : {}) });
  if (verdict.ok) return undefined;
  process.stderr.write(`${gateRefusalMessage(verdict, scope)}\n`);
  return GATE_EXIT;
}

function main(argv: string[]): number {
  const [cmd, ...restAll] = argv;
  if (!cmd) usage();
  if (cmd === '--help' || cmd === '-h') return printHelp();
  if (helpRequested(cmd, restAll)) return printHelp((DISPATCH_COMMANDS as readonly string[]).includes(cmd) ? cmd : undefined);
  // A flag the command does not know is refused, never silently ignored.
  const unknown = argvShapeProblems(cmd, restAll).filter((problem) => problem.startsWith('unknown flag '));
  if (unknown.length) {
    process.stderr.write(`c2c ${cmd}: ${unknown.join('; ')}\n`);
    return 2;
  }
  if (cmd === '--verify-vendor') {
    return verifyVendorCli(restAll, defaultDoctorIo());
  }
  if (cmd === 'doctor') {
    doctorCli(restAll, defaultDoctorIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'doctor failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'deploy') {
    const refusal = doctorGateRefusal(restAll);
    if (refusal !== undefined) return refusal;
    deployCli(restAll, defaultIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'deploy failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'edit') {
    // --apply --confirm records a drop in the edits log deploy replays against
    // the live store, so it is gated like every other --confirm write.
    const refusal = restAll.includes('--apply') ? doctorGateRefusal(restAll) : undefined;
    if (refusal !== undefined) return refusal;
    return editCli(restAll, defaultIo());
  }
  if (cmd === 'plan') {
    planCli(restAll, defaultIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'plan failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'provision') {
    // The import step mints the project, so its gate is the org-scoped doctor
    // (dc + org, no project). Every other provision step names its project.
    const refusal = doctorGateRefusal(restAll, { createsProject: provisionCreatesProject(restAll) });
    if (refusal !== undefined) return refusal;
    provisionCli(restAll, defaultIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'provision failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'users') {
    const refusal = doctorGateRefusal(restAll);
    if (refusal !== undefined) return refusal;
    usersCli(restAll, defaultIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'users failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'smoke') {
    const refusal = doctorGateRefusal(restAll);
    if (refusal !== undefined) return refusal;
    smokeCli(restAll, defaultIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'smoke failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'sync-delta' || cmd === 'rollback-export') {
    // --confirm writes to the live project, so it is gated like deploy and migrate-data.
    const refusal = doctorGateRefusal(restAll);
    if (refusal !== undefined) return refusal;
    (cmd === 'sync-delta' ? syncDeltaCli : rollbackExportCli)(restAll, defaultIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : `${cmd} failed`;
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'verify') {
    try {
      return verifyCli(restAll, defaultIo());
    } catch (err) {
      process.stderr.write(`c2c: ${err instanceof Error ? err.message : 'verify failed'}\n`);
      return 1;
    }
  }
  if (cmd === 'status') {
    statusCli(restAll, defaultIo()).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'status failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'cutover-checklist' || cmd === 'proof') {
    const io = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) };
    try {
      return cutoverCli(restAll, io, cmd === 'proof' ? 'proof' : 'checklist');
    } catch (err) {
      process.stderr.write(`c2c: ${err instanceof Error ? err.message : `${cmd} failed`}\n`);
      return 1;
    }
  }
  if (cmd === 'fill-todos') {
    fillTodosMain(restAll).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'fill-todos failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  if (cmd === 'migrate-data') {
    const refusal = doctorGateRefusal(restAll);
    if (refusal !== undefined) return refusal;
    if (restAll.includes('--source-backup')) {
      sourceBackupCli(restAll, defaultIo()).then(
        (code) => {
          process.exitCode = code;
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : 'migrate failed';
          process.stderr.write(`c2c: ${message}\n`);
          process.exitCode = 1;
        },
      );
      return 0;
    }
    if (restAll.includes('--source-csv') || restAll.includes('--source-json')) {
      sourceCsvCli(restAll, defaultIo()).then(
        (code) => {
          process.exitCode = code;
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : 'migrate failed';
          process.stderr.write(`c2c: ${message}\n`);
          process.exitCode = 1;
        },
      );
      return 0;
    }
    if (restAll.includes('--seed')) {
      seedMigrateCli(restAll, defaultIo()).then(
        (code) => {
          process.exitCode = code;
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : 'migrate failed';
          process.stderr.write(`c2c: ${message}\n`);
          process.exitCode = 1;
        },
      );
      return 0;
    }
    migrateCli(restAll).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'migrate failed';
        process.stderr.write(`c2c: ${message}\n`);
        process.exitCode = 1;
      },
    );
    return 0;
  }
  const [target, ...rest] = restAll;
  if (!target) usage();
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? (rest[i + 1] ?? '') : undefined;
  };
  if (cmd === 'analyze') {
    const { ir, locked } = loadIrOrLocked(target);
    if (locked) return 2;
    if (!ir) return 1;
    const lockPath = flag('--lock');
    if (rest.includes('--lock') && !lockPath) {
      process.stderr.write('c2c: needs a value\n');
      return 2;
    }
    if (lockPath !== undefined && !statSync(lockPath, { throwIfNoEntry: false })?.isFile()) {
      process.stderr.write(`c2c: no such lock file: ${lockPath}\n`);
      return 2;
    }
    const report = analyze(ir, lockPath !== undefined ? { lock: readLock(lockPath) } : undefined);
    if (rest.includes('--quality')) {
      analyzeQuality(ir, report).then(
        (q) => {
          process.stdout.write(rest.includes('--json') ? stampedJson(analyzeAsJson(q)) : `${qualityAsText(q)}\n`);
        },
        (err: unknown) => {
          process.stderr.write(`c2c: ${err instanceof Error ? err.message : 'quality gate failed'}\n`);
          process.exitCode = 1;
        },
      );
      return 0;
    }
    process.stdout.write(rest.includes('--json') ? stampedJson(analyzeAsJson(report)) : `${analyzeAsText(report)}\n`);
    return 0;
  }
  if (cmd === 'precheck') {
    if (rest.some((arg) => arg !== '--json')) usage();
    const st = statSync(target, { throwIfNoEntry: false });
    if (!st) {
      process.stderr.write(`c2c: no such file or directory: ${target}\n`);
      return PRECHECK_EXIT.missing;
    }
    if (!st.isFile()) {
      process.stderr.write('c2c: precheck needs one .ds file\n');
      return 2;
    }
    let parsed: { source: string; file: ReturnType<typeof parseFile> };
    try {
      parsed = { source: decode(readFileSync(target)).text, file: parseFile(target) };
    } catch (err) {
      if (err instanceof LockedExportError) {
        process.stderr.write(`c2c: ${err.message}\n`);
        return 2;
      }
      process.stderr.write(`c2c: cannot parse ${target}: ${err instanceof Error ? err.message : String(err)}\n`);
      return PRECHECK_EXIT.unparsable;
    }
    // A file with no `application "<name>" { ... }` block is not a Creator export; never certify it clean.
    if (!parsed.file.ir.name || parsed.file.ir.dialect === 'snippet') {
      process.stderr.write(`c2c: ${target} is not a Creator .ds application export (no application block)\n`);
      return PRECHECK_EXIT.unparsable;
    }
    // A truncated or unbalanced .ds is a parse failure, not a clean app.
    if (parsed.file.cst.errors.length) {
      const first = parsed.file.cst.errors[0]!;
      process.stderr.write(`c2c: cannot parse ${target}: ${first.message}${parsed.file.cst.errors.length > 1 ? ` (+${parsed.file.cst.errors.length - 1} more)` : ''}\n`);
      return PRECHECK_EXIT.unparsable;
    }
    const { ir } = parsed.file;
    const { source } = parsed;
    const report = precheck(ir, source);
    process.stdout.write(rest.includes('--json') ? stampedJson(precheckAsJson(report)) : `${precheckAsText(report)}\n`);
    return report.counts.blocker > 0 ? PRECHECK_EXIT.blockers : PRECHECK_EXIT.clean;
  }
  if (cmd === 'migration-report') {
    const st = statSync(target, { throwIfNoEntry: false });
    if (!st?.isDirectory()) {
      process.stderr.write('c2c: migration-report needs an apps directory\n');
      return 2;
    }
    const report = migrationReportForDir(target, flag('--label') ?? 'corpus');
    writeOut(rest.includes('--json') ? migrationReportAsJson(report) : `${migrationReportAsText(report)}\n`, flag('--out'));
    return 0;
  }
  if (cmd === 'parse') {
    let ir: App;
    let ok = true;
    try {
      const p = parseFileOrProjectWithSidecars(target);
      ir = p.ir;
      ok = p.files.every((f) => roundTrips(f));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        process.stderr.write(`c2c: no such file or directory: ${target}\n`);
        return 1;
      }
      if (err instanceof NotFileError) {
        process.stderr.write(`c2c: ${err.message}\n`);
        return 1;
      }
      if (err instanceof LockedExportError) {
        process.stderr.write(`c2c: ${err.message}\n`);
        return 2;
      }
      throw err;
    }
    if (rest.includes('--json')) process.stdout.write(JSON.stringify(ir, null, 2) + '\n');
    else process.stdout.write(`${summarize(ir)}\nround-trip: ${ok ? 'OK' : 'FAIL'}\n`);
    return ok ? 0 : 1;
  }
  if (cmd === 'corpus') {
    const s = runCorpus(target);
    const md = formatSummary(flag('--label') ?? 'corpus', s, Number(flag('--top') ?? 20) || 20);
    const out = flag('--out');
    if (out) writeFileSync(out, md);
    process.stdout.write(md + '\n');
    return s.roundTripFail === 0 ? 0 : 1;
  }
  if (cmd === 'features') {
    const apps: { name: string; ir: App }[] = [];
    if (flag('--unit') === 'file') {
      for (const p of listDsFiles(target)) apps.push({ name: relative(target, p), ir: parseFile(p).ir });
    } else {
      for (const name of readdirSync(target).sort()) {
        const p = join(target, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (st?.isDirectory() && listDsFiles(p).length) apps.push({ name, ir: parseProject(p).ir });
        else if (st?.isFile() && name.toLowerCase().endsWith('.ds')) apps.push({ name: basename(name), ir: parseFile(p).ir });
      }
    }
    const names = rest.includes('--names');
    const labelled = apps.map((a, i) => ({ name: names ? a.name : `app ${i + 1}`, ir: a.ir }));
    const r = featureReport(labelled);
    const md = formatFeatures(flag('--label') ?? 'corpus', r);
    const out = flag('--out');
    if (out) writeFileSync(out, md);
    else process.stdout.write(md + '\n');
    const appsOut = flag('--apps');
    if (appsOut) writeFileSync(appsOut, formatApps(r));
    return 0;
  }
  if (cmd === 'schema') {
    const { ir, locked } = loadIrOrLocked(target);
    if (locked) return 2;
    if (!ir) return 1;
    const srcBackup = flag('--source-backup');
    const srcCsv = flag('--source-csv');
    const srcJson = flag('--source-json');
    if ([srcBackup, srcCsv, srcJson].filter((dir) => dir !== undefined).length > 1) {
      process.stderr.write('c2c: pass at most one of --source-backup, --source-csv, or --source-json\n');
      return 2;
    }
    const allowEmpty = rest.includes('--allow-empty');
    const source =
      srcBackup !== undefined
        ? readSourceBackup(srcBackup, ir, allowEmpty).sourceData
        : srcCsv !== undefined
          ? (hasReportJson(srcCsv, ir) ? readSourceJson(srcCsv, ir, allowEmpty) : readSourceCsv(srcCsv, ir, allowEmpty)).sourceData
          : srcJson !== undefined
            ? readSourceJson(srcJson, ir, allowEmpty).sourceData
            : undefined;
    const plan = generateSchema(ir, source ? { source } : undefined);
    const text = rest.includes('--json') ? stampedJson(schemaAsJson(plan)) : rest.includes('--iac') ? projectTemplateJson(plan) : schemaAsReport(plan);
    writeOut(text, flag('--out'));
    return 0;
  }
  if (cmd === 'iac-drift') {
    const exported = rest[0];
    if (!exported) usage();
    let report;
    try {
      report = diffTemplate(JSON.parse(readFileSync(target, 'utf8')), JSON.parse(readFileSync(exported, 'utf8')));
    } catch (err) {
      process.stderr.write(`c2c iac-drift: ${err instanceof Error ? err.message : String(err)}\n`);
      return 3;
    }
    process.stdout.write(formatDrift(report));
    return report.exitCode;
  }
  if (cmd === 'schema-corpus') {
    const md = schemaCorpusMarkdown(target, { label: flag('--label') ?? 'corpus', date: new Date().toISOString().slice(0, 10) });
    writeOut(md, flag('--out'));
    return 0;
  }
  if (cmd === 'seed') {
    const { ir, locked } = loadIrOrLocked(target);
    if (locked) return 2;
    if (!ir) return 1;
    const n = flag('--n');
    const parsedN = n === undefined ? undefined : Number(n);
    const problem = seedArgsProblem(rest);
    if (problem) {
      process.stderr.write(`${problem}\n`);
      return 2;
    }
    const out = flag('--out') as string;
    if (rest.includes('--creator-import')) {
      const rowsArg = flag('--rows') ?? n;
      const rows = rowsArg === undefined ? undefined : Number(rowsArg);
      if (rows !== undefined && (!Number.isInteger(rows) || rows < 0)) {
        process.stderr.write('c2c seed: --rows must be a non-negative integer\n');
        return 2;
      }
      const result = generateCreatorImport(ir, { rows, seed: flag('--seed') });
      mkdirSync(out, { recursive: true });
      for (const file of result.files) writeFileSync(join(out, file.fileName), file.csv);
      for (const manual of result.manual) writeFileSync(join(out, manual.fileName), manual.body);
      writeFileSync(join(out, 'IMPORT_ORDER.txt'), result.orderText);
      writeFileSync(join(out, 'README.md'), result.readme);
      process.stdout.write(`creator-import seed ${result.seed} rows=${result.rows} forms=${result.files.length} skipped=${result.skipped.length} manual=${result.manual.length}\n`);
      for (const file of result.files) process.stdout.write(`${file.form}: ${file.rowCount} rows\n`);
      for (const manual of result.manual) process.stdout.write(`${manual.form}: manual worksheet ${manual.fileName}\n`);
      for (const s of result.skipped) process.stdout.write(`${s.form}: skipped (${s.reason})\n`);
      for (const w of result.warnings) process.stdout.write(`warning ${w.form}${w.field ? `/${w.field}` : ''}: ${w.message}\n`);
      return 0;
    }
    const result = generateSeed(ir, { n: parsedN, seed: flag('--seed') });
    mkdirSync(out, { recursive: true });
    for (const file of result.files) writeFileSync(join(out, file.fileName), file.csv);
    for (const file of result.fixtureFiles) {
      if (file.name !== basename(file.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(file.name)) {
        process.stderr.write('c2c seed: fixture name is not a file name\n');
        return 2;
      }
      writeFileSync(join(out, file.name), file.bytes);
    }
    writeFileSync(join(out, 'seed.json'), canonicalSeedJson(result.tables, result.blockers));

    if (rest.includes('--json')) {
      const output = {
        seed: result.seed,
        n: result.n,
        forms: result.files.length,
        files: result.files.map(f => {
          const lines = f.csv.trimEnd() === '' ? [] : f.csv.trimEnd().split('\n');
          return { form: f.form, rows: lines.length > 0 ? lines.length - 1 : 0 };
        }),
        warnings: result.warnings,
        blockers: result.blockers || []
      };
      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
      return (result.blockers && result.blockers.length > 0) ? 1 : 0;
    }

    process.stdout.write(`seed ${result.seed} n=${result.n} forms=${result.files.length}\n`);
    for (const file of result.files) {
      const lines = file.csv.trimEnd() === '' ? [] : file.csv.trimEnd().split('\n');
      const rows = lines.length > 0 ? lines.length - 1 : 0;
      process.stdout.write(`${file.form}: ${rows} rows\n`);
    }
    for (const w of result.warnings) process.stdout.write(`warning ${w.form}${w.field ? `/${w.field}` : ''}: ${w.message}\n`);
    for (const b of result.blockers || []) process.stdout.write(`blocker ${b.form}${b.field ? `/${b.field}` : ''}: ${b.message}\n`);
    if (result.blockers && result.blockers.length > 0) return 1;
    return 0;
  }
  if (cmd === 'deluge') {
    const numbers = emptyNumbers();
    if (flag('--unit') === 'file') {
      for (const p of listDsFiles(target)) accumulate(parseFile(p).ir, numbers);
    } else {
      let any = false;
      for (const name of readdirSync(target).sort()) {
        const p = join(target, name);
        const st = statSync(p, { throwIfNoEntry: false });
        if (st?.isDirectory() && listDsFiles(p).length) {
          accumulate(parseProject(p).ir, numbers);
          any = true;
        } else if (st?.isFile() && name.toLowerCase().endsWith('.ds')) {
          accumulate(parseFile(p).ir, numbers);
          any = true;
        }
      }
      if (!any && statSync(target, { throwIfNoEntry: false })?.isDirectory() && listDsFiles(target).length) {
        accumulate(parseProject(target).ir, numbers);
      }
    }
    const md = formatCorpus(flag('--label') ?? 'corpus', numbers, Number(flag('--top') ?? 20) || 20);
    const out = flag('--out');
    if (out) writeFileSync(out, md);
    process.stdout.write(md + '\n');
    return 0;
  }
  if (cmd === 'ui') {
    const { ir, locked } = loadIrOrLocked(target);
    if (locked) return 2;
    if (!ir) return 1;
    const out = flag('--out');
    if (!out) {
      process.stderr.write('c2c ui: --out directory is required\n');
      return 2;
    }
    const bundle = buildUi(ir);
    for (const file of bundle.files) {
      const dest = join(out, file.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, file.data);
    }
    const summary = bundle.summary;
    process.stdout.write(
      `ui dry-run forms ${summary.formsGenerated}/${summary.forms} reports ${summary.reportsGenerated}/${summary.reports} pages ${summary.pagesGenerated}/${summary.pages} todos ${summary.todos.length}\n`,
    );
    return 0;
  }
  if (cmd === 'score-ui') {
    const { ir, locked } = loadIrOrLocked(target);
    if (locked) return 2;
    if (!ir) return 1;
    const uiDir = flag('--ui');
    let bundle;
    try {
      bundle = uiDir ? bundleFromDir(uiDir) : bundleFromFiles(buildUi(ir).files);
    } catch (err) {
      process.stderr.write(`c2c score-ui: ${err instanceof Error ? err.message : 'unreadable bundle'}\n`);
      return 2;
    }
    const write = flag('--write');
    scoreUi(ir, bundle).then(
      (result) => {
        if (write) {
          mkdirSync(dirname(write), { recursive: true });
          writeFileSync(write, `${JSON.stringify(scoreFileOf(result), null, 2)}\n`);
        }
        process.stdout.write(rest.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : uiScoreAsText(result));
        process.exitCode = result.pass ? 0 : 1;
      },
      (err: unknown) => {
        process.stderr.write(`c2c score-ui: ${err instanceof Error ? err.message : 'scoring failed'}\n`);
        process.exitCode = 2;
      },
    );
    return 0;
  }
  if (cmd === 'ui-react') {
    const { ir, locked } = loadIrOrLocked(target);
    if (locked) return 2;
    if (!ir) return 1;
    const out = flag('--out');
    if (!out) {
      process.stderr.write('c2c ui-react: --out directory is required\n');
      return 2;
    }
    const apiBase = flag('--api-base');
    const files = generateReactApp(ir, { ...(apiBase ? { apiBase } : {}), auth: !rest.includes('--no-auth') });
    try {
      const result = writeReactApp(out, files, { upgradePlatform: rest.includes('--upgrade-platform'), force: rest.includes('--force') });
      process.stdout.write(`ui-react files ${files.length} written ${result.written.length} kept ${result.kept.length} removed ${result.removed.length}\n`);
    } catch (err) {
      if (err instanceof HandEditedError) {
        process.stderr.write(`c2c ui-react: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    return 0;
  }
  if (cmd === 'auth') {
    const { ir, locked } = loadIrOrLocked(target);
    if (locked) return 2;
    if (!ir) return 1;
    const plan = authPlan(ir);
    const out = rest.includes('--apply') ? authApplyReport(authApplyPlan(plan)) : rest.includes('--json') ? authAsJson(plan) : authAsReport(plan);
    writeOut(out, flag('--out'));
    return 0;
  }
  if (cmd === 'ui-corpus') {
    const numbers = uiCorpus(target);
    const md = formatUiReport(numbers, { label: flag('--label') ?? 'corpus', date: new Date().toISOString().slice(0, 10) });
    const out = flag('--out');
    if (out) writeFileSync(out, md.endsWith('\n') ? md : `${md}\n`);
    else process.stdout.write(md.endsWith('\n') ? md : `${md}\n`);
    process.stdout.write(
      `ui-corpus apps=${numbers.apps} buildOk=${numbers.buildOk} buildFail=${numbers.buildFail} forms ${numbers.formsGenerated} generated / ${numbers.formsTodo} todo reports ${numbers.reportsGenerated} generated / ${numbers.reportsTodo} todo pages ${numbers.pagesGenerated} generated / ${numbers.pagesTodo} todo\n`,
    );
    return numbers.buildFail === 0 ? 0 : 1;
  }
  usage();
}

// Directory readers (features, deluge, corpus, migration-report, schema-corpus,
// ui-corpus) parse every .ds they walk. A locked Marketplace page throws here
// so the process refuses with exit 2 instead of an uncaught stack.
let code: number;
try {
  code = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof LockedExportError) {
    process.stderr.write(`c2c: ${err.message}\n`);
    code = 2;
  } else if (err instanceof FillTodoError) {
    process.stderr.write(`c2c: ${err.message}\n`);
    code = 2;
  } else if (err instanceof DomUnavailableError || (err instanceof Error && err.name === 'DomUnavailableError')) {
    process.stderr.write(`c2c: ${err.message}\n`);
    code = 1;
  } else {
    throw err;
  }
}
process.exitCode = code;
