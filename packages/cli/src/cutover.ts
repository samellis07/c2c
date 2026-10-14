/**
 * Cut-over checklist and proof report for one app. Offline: built from the
 * .ds, an optional newer export, the project's state file and an optional
 * smoke result. The same inputs give the same bytes.
 *
 * The proof report (c2c-proof.json / c2c-proof.md) holds per-table counts and
 * checksums of the export and of the last applied checkpoint, the delta still
 * to apply, the smoke result slot, and readiness: the automatic percentage
 * from analyze plus every manual item by name. Checksums are sha256 over the
 * sorted per-record fingerprints (no field values).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { App } from '../../core/src/index.js';
import { authPlan } from '../../auth/src/index.js';
import {
  DELTA_SOURCES,
  computeDelta,
  deltaSource,
  flag,
  loadApp,
  parseDeltaCheckpoint,
  planGuard,
  readStateFile,
  rowFingerprint,
  stateFilePath,
  tableChecksum,
  type CsvLoad,
  type DeltaCheckpoint,
  type Io,
} from '../../deploy/src/index.js';
import { doubleColumns } from '../../deploy/src/row-delta.js';
import { generateSchema } from '../../schema/src/index.js';
import { analyze } from './analyze.js';

export const PROOF_JSON = 'c2c-proof.json';
export const PROOF_MD = 'c2c-proof.md';
export const CHECKLIST_MD = 'cutover-checklist.md';

export interface SmokeSlot {
  status: 'not run' | 'pass' | 'fail';
  steps?: { name: string; status: string }[];
  /** The session a c2c-smoke-report/1 ran under (owner, app-user or credential). */
  session?: string;
  /** Why a report run could not start (for example, sign in first). */
  blocker?: string;
  /** The step lines a c2c-smoke-report/1 carries, printed verbatim in the proof. */
  lines?: string[];
}

export interface ProofTable {
  table: string;
  form: string;
  sourceRows?: number;
  sourceChecksum?: string;
  checkpointRows?: number;
  checkpointChecksum?: string;
  /** Present when both sides are known: true when the export matches the last applied checkpoint. */
  match?: boolean;
  delta?: { new: number; changed: number; deleted: number; missing: boolean };
}

export interface ProofReport {
  schema: 'c2c-proof/1';
  app: string;
  checksum: 'sha256 of sorted record fingerprints';
  source?: string;
  checkpointSince?: string;
  tables: ProofTable[];
  smoke: SmokeSlot;
  readiness: { automatic: number; band: string; manual: string[] };
}

export interface CutoverInput {
  app: App;
  loaded?: CsvLoad;
  sourceKind?: string;
  checkpoint?: DeltaCheckpoint;
  state?: { projectId?: string; slateUrl?: string };
  scope: { org: string; projectId: string; dc: string };
  smoke?: SmokeSlot;
}

function fingerprints(app: App, loaded: CsvLoad): Map<string, Record<string, string>> {
  const doubles = doubleColumns(app);
  return new Map(
    loaded.tables.map((table) => [
      table.table,
      Object.fromEntries(table.rows.map((row) => [row.id, rowFingerprint(row.columns, doubles.get(table.table))])),
    ]),
  );
}

export function proofReport(input: CutoverInput): ProofReport {
  const schema = generateSchema(input.app);
  const report = analyze(input.app);
  const plan = input.loaded ? computeDelta(input.app, input.loaded, input.checkpoint, input.sourceKind) : undefined;
  const sourcePrints = input.loaded ? fingerprints(input.app, input.loaded) : undefined;
  const tables: ProofTable[] = [];
  for (const table of schema.tables) {
    if (table.nosql || table.role === 'system') continue;
    const item: ProofTable = { table: table.name, form: table.form };
    const prints = sourcePrints?.get(table.name);
    if (prints) {
      item.sourceRows = Object.keys(prints).length;
      item.sourceChecksum = tableChecksum(prints);
    }
    const stored = input.checkpoint?.tables[table.name];
    if (input.checkpoint) {
      item.checkpointRows = Object.keys(stored?.rows ?? {}).length;
      item.checkpointChecksum = tableChecksum(stored?.rows ?? {});
    }
    if (item.sourceChecksum !== undefined && item.checkpointChecksum !== undefined) item.match = item.sourceChecksum === item.checkpointChecksum;
    const delta = plan?.tables.find((entry) => entry.table === table.name);
    if (delta) item.delta = { new: delta.added.length, changed: delta.changed.length, deleted: delta.deleted.length, missing: delta.missing };
    tables.push(item);
  }
  const manual: string[] = [];
  for (const blocker of report.blockers) manual.push(`blocker: ${blocker.label} (${blocker.detail})`);
  for (const use of report.features.used) {
    if (use.verdict === 'gap') manual.push(`rebuild by hand: ${use.area} / ${use.feature} (${use.uses})`);
    if (use.verdict === 'needs-assessment') manual.push(`check by hand: ${use.area} / ${use.feature} (${use.uses})`);
  }
  for (const kind of report.determinism.todoKinds) manual.push(`finish Deluge: ${kind.construct} (${kind.count})`);
  if (report.determinism.uiTodoCount) manual.push(`finish generated screens marked TODO (${report.determinism.uiTodoCount})`);
  for (const table of schema.tables.filter((item) => item.nosql)) manual.push(`load by hand: ${table.form} is a NoSQL form`);
  if (input.loaded) {
    for (const line of input.loaded.fidelity) manual.push(`data fidelity: ${line}`);
    for (const item of input.loaded.missingRequired) manual.push(`missing required value: ${item.table}.${item.field}`);
  }
  for (const table of tables) {
    if (table.delta?.missing) manual.push(`export ${table.form} again: the export holds no rows for ${table.table}`);
    if (table.delta?.deleted) manual.push(`decide on ${table.delta.deleted} record(s) deleted in Creator from ${table.table} (sync-delta --apply-deletes)`);
  }
  const smoke = input.smoke ?? { status: 'not run' as const };
  if (smoke.status !== 'pass') {
    manual.push(
      smoke.status === 'fail'
        ? smoke.blocker
          ? `smoke: the run was blocked — ${smoke.blocker}; resolve it and run c2c smoke again`
          : 'smoke: fix the failed steps and run c2c smoke again'
        : 'smoke: run c2c smoke --confirm --report <file> and pass it with --smoke',
    );
  }
  manual.push('sign-in: invite users and confirm each role signs in');
  manual.push('links: replace Creator app links and bookmarks with the new app URL');
  manual.push('owner sign-off');
  return {
    schema: 'c2c-proof/1',
    app: input.app.name ?? '(none)',
    checksum: 'sha256 of sorted record fingerprints',
    ...(input.sourceKind ? { source: input.sourceKind } : {}),
    ...(input.checkpoint?.since ? { checkpointSince: input.checkpoint.since } : {}),
    tables,
    smoke,
    readiness: { automatic: report.score.readiness, band: report.score.band, manual },
  };
}

function cell(value: string | number | boolean | undefined): string {
  return value === undefined ? '-' : String(value);
}

export function proofMarkdown(proof: ProofReport): string {
  const lines = [
    `# Migration proof: ${proof.app}`,
    '',
    `Readiness: ${proof.readiness.automatic}% automatic (${proof.readiness.band}); ${proof.readiness.manual.length} manual item(s).`,
    `Source: ${proof.source ?? 'none given'}. Checkpoint: ${proof.checkpointSince ? `since ${proof.checkpointSince}` : 'none'}.`,
    `Smoke: ${proof.smoke.status}${proof.smoke.session ? ` (${proof.smoke.session} session)` : ''}${proof.smoke.blocker ? ` — ${proof.smoke.blocker}` : ''}.`,
    ...(proof.smoke.lines?.length ? ['', ...proof.smoke.lines.map((line) => `- ${line}`)] : []),
    '',
    '| Table | Form | Export rows | Checkpoint rows | Match | New | Changed | Deleted |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...proof.tables.map((table) =>
      `| ${table.table} | ${table.form} | ${cell(table.sourceRows)} | ${cell(table.checkpointRows)} | ${cell(table.match === undefined ? undefined : table.match ? 'yes' : 'no')} | ${cell(table.delta?.new)} | ${cell(table.delta?.changed)} | ${table.delta?.missing ? 'not computed' : cell(table.delta?.deleted)} |`,
    ),
    '',
    `Checksums are the ${proof.checksum}:`,
    '',
    ...proof.tables.map((table) => `- ${table.table}: export ${table.sourceChecksum ?? '-'}, checkpoint ${table.checkpointChecksum ?? '-'}`),
    '',
    '## Manual items',
    '',
    ...proof.readiness.manual.map((item) => `- [ ] ${item}`),
    '',
  ];
  return lines.join('\n');
}

export function cutoverChecklist(input: CutoverInput, proof: ProofReport): string {
  const app = input.app;
  const name = app.name ?? '(none)';
  const auth = authPlan(app);
  const sourceFlag = `--source-${input.sourceKind ?? 'json'}`;
  const project = input.state?.projectId ?? input.scope.projectId;
  const slate = input.state?.slateUrl ?? '<app-url>';
  const totalRows = proof.tables.reduce((sum, table) => sum + (table.sourceRows ?? 0), 0);
  const pending = proof.tables.filter((table) => table.delta && (table.delta.new || table.delta.changed));
  const lines = [
    `# Cut-over checklist: ${name}`,
    '',
    `Project ${project}, data centre ${input.scope.dc}. ${app.forms.length} form(s), ${proof.tables.length} table(s)${proof.tables.some((table) => table.sourceRows !== undefined) ? `, ${totalRows} record(s) in the export` : ''}.`,
    `Readiness ${proof.readiness.automatic}% automatic (${proof.readiness.band}); the manual items are in ${PROOF_MD}.`,
    '',
    '## 1. Rollback baseline',
    '',
    `- [ ] \`c2c rollback-export --ds <app.ds> --out <rollback-dir> --project ${project} --confirm\` — the pre-cut-over baseline, taken before the freeze while the store is still stable.`,
    '- [ ] Keep the exported folder somewhere outside this workspace.',
    '',
    '## 2. Freeze Creator edits',
    '',
    `- [ ] Announce the cut-over window to the users of ${name}.`,
    '- [ ] Stop data entry in Creator: restrict the app to administrators or disable its forms.',
    '- [ ] Note the freeze time. Records saved after it are not in the final delta.',
    '',
    '## 3. Final delta',
    '',
    `- [ ] Export every report again with record ids (${sourceFlag}).`,
    `- [ ] Plan: \`c2c sync-delta ${sourceFlag} <export-dir> --ds <app.ds> --since <state-dir> --project ${project}\``,
    ...(pending.length ? pending.map((table) => `  - ${table.table}: ${table.delta!.new} new, ${table.delta!.changed} changed at the last plan`) : []),
    '- [ ] Apply: the same command with `--confirm`.',
    '- [ ] Plan again: every table shows new 0 changed 0.',
    ...proof.tables.filter((table) => table.delta?.deleted).map((table) => `- [ ] ${table.table}: ${table.delta!.deleted} record(s) deleted in Creator. Delete them with \`--apply-deletes\` or keep them.`),
    '',
    '## 4. Smoke',
    '',
    `- [ ] \`c2c smoke <app.ds> --project ${project} --url ${slate} --confirm\` (last result: ${proof.smoke.status}).`,
    ...app.forms.map((form) => `- [ ] Open ${form.displayName ?? form.name}, add a record, see it in its report.`),
    '',
    '## 5. Sign-in',
    '',
    `- [ ] Roles exist: ${auth.roles.length ? auth.roles.map((role) => role.role_name).join(', ') : 'App User and App Administrator only'}.`,
    `- [ ] Invite the users${auth.portalUsers.length ? ` and ${auth.portalUsers.length} portal user profile(s)` : ''}; the invitation redirect is ${slate}.`,
    '- [ ] One user of each role signs in and sees only their pages.',
    '',
    '## 6. Redirect',
    '',
    `- [ ] The new app answers at ${slate}.`,
    `- [ ] The Creator app home page tells users the app moved to ${slate}.`,
    '',
    '## 7. DNS and links',
    '',
    '- [ ] A custom domain, if used, points at the new app and its certificate is valid.',
    '- [ ] Links in emails, documents, bookmarks and other apps use the new URL.',
    '- [ ] Integrations and webhooks that called Creator call the new functions.',
    '',
    '## 8. Rollback ready',
    '',
    '- [ ] The baseline export from step 1 is intact.',
    `- [ ] If records were written to the new app after the baseline, run \`c2c rollback-export\` again so the post-cut-over data is held too.`,
    '',
    '## 9. Owner sign-off',
    '',
    `- [ ] ${PROOF_MD} reviewed: every table matches and the manual items are closed.`,
    '- [ ] Owner: ____________________  Date: ____________',
    '',
  ];
  return lines.join('\n');
}

function readSmoke(path: string | undefined): SmokeSlot | undefined {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  // The file `c2c smoke --report <file>` writes: version, ok, session, lines and a blocker when the run could not start.
  if (parsed.version === 'c2c-smoke-report/1') {
    if (typeof parsed.ok !== 'boolean') throw new Error(`${basename(path)}: the smoke report carries no ok flag`);
    const lines = Array.isArray(parsed.lines) ? parsed.lines.map((line) => String(line)) : [];
    return {
      status: parsed.ok ? 'pass' : 'fail',
      ...(typeof parsed.session === 'string' ? { session: parsed.session } : {}),
      ...(typeof parsed.blocker === 'string' ? { blocker: parsed.blocker } : {}),
      ...(lines.length ? { lines } : {}),
    };
  }
  // A hand-written {"status":"pass"|"fail","steps":[...]} result also counts.
  if (parsed.status !== 'pass' && parsed.status !== 'fail') {
    throw new Error(`${basename(path)}: pass the file c2c smoke --report wrote, or a {"status":"pass"|"fail"} result`);
  }
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map((step) => ({ name: String((step as { name?: unknown }).name ?? ''), status: String((step as { status?: unknown }).status ?? '') }))
    : undefined;
  return { status: parsed.status, ...(steps ? { steps } : {}) };
}

export function cutoverInput(target: string, args: readonly string[]): CutoverInput {
  const app = loadApp(target);
  const guard = planGuard(target, args, app.name?.trim() || 'app');
  const source = deltaSource(args);
  const loaded = source ? DELTA_SOURCES[source.kind]!(source.path, app, args.includes('--allow-empty')) : undefined;
  const since = flag(args, '--since');
  const state = since ? readStateFile(stateFilePath(since)) : {};
  const checkpoint = parseDeltaCheckpoint(state.delta);
  const projectId = typeof state.projectId === 'string' ? state.projectId : undefined;
  const slateUrl = typeof state.slateUrl === 'string' ? state.slateUrl : undefined;
  const smoke = readSmoke(flag(args, '--smoke'));
  return {
    app,
    ...(loaded ? { loaded, sourceKind: source!.kind } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    state: { ...(projectId ? { projectId } : {}), ...(slateUrl ? { slateUrl } : {}) },
    scope: { org: guard.org, projectId: guard.projectId, dc: guard.dc },
    ...(smoke ? { smoke } : {}),
  };
}

export const CUTOVER_USAGE =
  'usage: c2c cutover-checklist <file|dir> [--source-json <dir>|--source-csv <dir>|--source-backup <zip|dir>] [--since <state-file|dir>] [--smoke <file>] [--project <id>] [--dc <dc>] [--config <c2c-deploy.json>] [--out <dir>]\n' +
  '       c2c proof <file|dir> [same options]\n' +
  '       --smoke is the file c2c smoke --report <file> wrote (a {"status":"pass"} result also works).\n' +
  `       --out writes ${CHECKLIST_MD}, ${PROOF_JSON} and ${PROOF_MD}; otherwise the checklist (or the proof) is printed.\n`;

export function cutoverCli(args: readonly string[], io: Pick<Io, 'stdout' | 'stderr'>, which: 'checklist' | 'proof'): number {
  const [target, ...rest] = args;
  if (!target || target.startsWith('--')) {
    io.stderr(CUTOVER_USAGE);
    return 2;
  }
  if (!existsSync(target)) {
    io.stderr(`c2c: no such file or directory: ${target}\n`);
    return 3;
  }
  const input = cutoverInput(target, rest);
  const proof = proofReport(input);
  const out = flag(rest, '--out');
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, CHECKLIST_MD), cutoverChecklist(input, proof));
    writeFileSync(join(out, PROOF_JSON), `${JSON.stringify(proof, null, 2)}\n`);
    writeFileSync(join(out, PROOF_MD), proofMarkdown(proof));
    io.stdout(`wrote ${CHECKLIST_MD}, ${PROOF_JSON}, ${PROOF_MD}\nreadiness: ${proof.readiness.automatic}% automatic, ${proof.readiness.manual.length} manual item(s)\n`);
    return 0;
  }
  io.stdout(which === 'proof' ? proofMarkdown(proof) : cutoverChecklist(input, proof));
  return 0;
}
