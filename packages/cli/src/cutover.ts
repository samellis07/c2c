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
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, opendirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  ROLLBACK_MANIFEST_FILE,
  ROLLBACK_MANIFEST_VERSION,
  readStateFile,
  rowFingerprint,
  stateFilePath,
  tableChecksum,
  type CsvLoad,
  type DeltaCheckpoint,
  type Io,
  verifyRollbackManifest,
} from '../../deploy/src/index.js';
import { readConflictRecord, type ConflictRecord } from '../../deploy/src/delta-cli.js';
import { doubleColumns, formatConflict, type DeltaConflict } from '../../deploy/src/row-delta.js';
import { generateSchema } from '../../schema/src/index.js';
import { analyze } from './analyze.js';
import { CLI_EXIT } from './exit-codes.js';

export const PROOF_JSON = 'c2c-proof.json';
export const PROOF_MD = 'c2c-proof.md';
export const CHECKLIST_MD = 'cutover-checklist.md';

export interface RollbackEvidence {
  status: 'valid' | 'invalid';
  dir: string;
  manifestFile?: string;
  outsideWorkspace: boolean;
  checksumMatch: boolean;
  reason?: string;
}

export interface SmokeSlot {
  status: 'not run' | 'pass' | 'fail';
  steps?: { name: string; status: string }[];
  /** The session a c2c-smoke-report/1 ran under (owner, app-user or credential). */
  session?: string;
  /** Why a report run could not start (for example, sign in first). */
  blocker?: string;
  /** The step lines a c2c-smoke-report/1 carries. Markdown renders them as escaped text. */
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
  /** The last sync-delta conflict check, when it found any: field values as short hashes only. */
  conflicts?: { since?: string; items: DeltaConflict[] };
}

export interface CutoverInput {
  app: App;
  loaded?: CsvLoad;
  sourceKind?: string;
  checkpoint?: DeltaCheckpoint;
  state?: { projectId?: string; slateUrl?: string };
  scope: { org: string; projectId: string; dc: string };
  smoke?: SmokeSlot;
  rollback?: RollbackEvidence;
  smokeSource?: string;
  conflicts?: ConflictRecord;
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

/** Where a passing smoke report comes from: `--confirm --report` only ever writes a blocked one. */
const SMOKE_PASS_HINT = 'run c2c smoke --result-code <code> --report <file> and pass that file with --smoke';

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
        ? smoke.blocker === 'smoke-page' || smoke.blocker?.startsWith('smoke-page ')
          ? `smoke: open ${smoke.blocker.slice('smoke-page '.length) || "the app's #/admin/smoke page"} signed in as the owner, then ${SMOKE_PASS_HINT}`
          : smoke.blocker
            ? `smoke: the run was blocked — ${smoke.blocker}; resolve it and run c2c smoke again`
            : 'smoke: fix the failed steps and run c2c smoke again'
        : `smoke: run c2c smoke --confirm, open the #/admin/smoke page it names signed in as the owner, then ${SMOKE_PASS_HINT}`,
    );
  }
  const conflicts = input.conflicts?.conflicts ?? [];
  for (const conflict of conflicts.filter((item) => !item.resolution)) {
    manual.push(`resolve conflict: ${formatConflict(conflict)}; re-run sync-delta with --prefer creator|catalyst or --conflicts <file>`);
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
    ...(conflicts.length ? { conflicts: { ...(input.conflicts?.since ? { since: input.conflicts.since } : {}), items: conflicts } } : {}),
  };
}

function mdText(value: string | number | boolean | undefined): string {
  return (value === undefined ? '-' : String(value))
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Untrusted URLs are escaped text, never a Markdown link. There is no host
 * allow-list that would make an active link safe.
 */
function mdUrl(value: string): string {
  return mdText(value);
}

/** Code span that stays closed when an escaped value still contains a backtick. */
function mdInlineCode(code: string): string {
  const fence = code.includes('`') ? '``' : '`';
  return `${fence}${code}${fence}`;
}

function tableRow(cells: readonly (string | number | boolean | undefined)[]): string {
  return `| ${cells.map(mdText).join(' | ')} |`;
}

export function proofMarkdown(proof: ProofReport): string {
  const lines = [
    `# Migration proof: ${mdText(proof.app)}`,
    '',
    `Readiness: ${mdText(proof.readiness.automatic)}% automatic (${mdText(proof.readiness.band)}); ${mdText(proof.readiness.manual.length)} manual item(s).`,
    `Source: ${mdText(proof.source ?? 'none given')}. Checkpoint: ${proof.checkpointSince ? `since ${mdText(proof.checkpointSince)}` : 'none'}.`,
    `Smoke: ${mdText(proof.smoke.status)}${proof.smoke.session ? ` (${mdText(proof.smoke.session)} session)` : ''}${proof.smoke.blocker ? ` — ${mdText(proof.smoke.blocker)}` : ''}.`,
    ...(proof.smoke.lines?.length ? ['', ...proof.smoke.lines.map((line) => `- ${mdText(line)}`)] : []),
    '',
    tableRow(['Table', 'Form', 'Export rows', 'Checkpoint rows', 'Match', 'New', 'Changed', 'Deleted']),
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...proof.tables.map((table) =>
      tableRow([
        table.table,
        table.form,
        table.sourceRows,
        table.checkpointRows,
        table.match === undefined ? undefined : table.match ? 'yes' : 'no',
        table.delta?.new,
        table.delta?.changed,
        table.delta?.missing ? 'not computed' : table.delta?.deleted,
      ]),
    ),
    '',
    `Checksums are the ${mdText(proof.checksum)}:`,
    '',
    ...proof.tables.map((table) => `- ${mdText(table.table)}: export ${mdText(table.sourceChecksum)}, checkpoint ${mdText(table.checkpointChecksum)}`),
    '',
    ...(proof.conflicts
      ? [
          '## Conflicts',
          '',
          `Records changed in Creator and in the new app since the checkpoint${proof.conflicts.since ? ` of ${mdText(proof.conflicts.since)}` : ''}. Values are short sha256 hashes, never the cells.`,
          '',
          tableRow(['Table', 'ROWID', 'Source id', 'Kind', 'Fields (Creator / new app)', 'Resolution']),
          '| --- | --- | --- | --- | --- | --- |',
          ...proof.conflicts.items.map((item) =>
            tableRow([
              item.table,
              item.rowid || '(none)',
              item.sourceId,
              item.kind,
              item.fields.map((field) => `${field.column} ${field.creator} / ${field.catalyst}`).join('; ') || '-',
              item.resolution === 'creator' ? 'keep Creator value' : item.resolution === 'catalyst' ? 'keep new app value' : 'unresolved',
            ]),
          ),
          '',
        ]
      : []),
    '## Manual items',
    '',
    ...proof.readiness.manual.map((item) => `- [ ] ${mdText(item)}`),
    '',
  ];
  return lines.join('\n');
}

export function cutoverChecklist(input: CutoverInput, proof: ProofReport): string {
  const app = input.app;
  const name = mdText(app.name ?? '(none)');
  const auth = authPlan(app);
  const sourceFlag = mdText(`--source-${input.sourceKind ?? 'json'}`);
  const project = mdText(input.state?.projectId ?? input.scope.projectId);
  const slate = input.state?.slateUrl ? mdUrl(input.state.slateUrl) : '<app-url>';
  const dc = mdText(input.scope.dc);
  const totalRows = proof.tables.reduce((sum, table) => sum + (table.sourceRows ?? 0), 0);
  const pending = proof.tables.filter((table) => table.delta && (table.delta.new || table.delta.changed));
  const rollback = input.rollback;
  let rollbackBaselineLine: string;
  let rollbackLocationLine: string;

  if (rollback?.status === 'valid') {
    rollbackBaselineLine = `- [x] \`c2c rollback-export --ds <app.ds> --out <rollback-dir> --project ${project} --confirm\` — the pre-cut-over baseline, taken before the freeze while the store is still stable. (automatic)`;
  } else if (rollback) {
    rollbackBaselineLine = `- [ ] \`c2c rollback-export --ds <app.ds> --out <rollback-dir> --project ${project} --confirm\` — the pre-cut-over baseline, taken before the freeze while the store is still stable. (open: ${mdText(rollback.reason ?? 'checksum mismatch')})`;
  } else {
    rollbackBaselineLine = `- [ ] \`c2c rollback-export --ds <app.ds> --out <rollback-dir> --project ${project} --confirm\` — the pre-cut-over baseline, taken before the freeze while the store is still stable.`;
  }

  if (rollback?.status === 'valid') {
    rollbackLocationLine = '- [x] Keep the exported folder somewhere outside this workspace. (automatic)';
  } else if (rollback) {
    rollbackLocationLine = `- [ ] Keep the exported folder somewhere outside this workspace. (open: ${rollback.outsideWorkspace ? mdText(rollback.reason ?? 'invalid manifest') : 'export is inside the workspace'})`;
  } else {
    rollbackLocationLine = '- [ ] Keep the exported folder somewhere outside this workspace.';
  }

  const smokeEvidence = `${input.smokeSource ? `Input report: ${input.smokeSource}; ` : ''}${
    proof.smoke.lines?.join('; ') ||
    proof.smoke.blocker ||
    (proof.smoke.status === 'not run' ? 'Run the smoke command below and save its report; attach report path and result.' : 'Attach the supplied smoke report path and verify its steps.')
  }`;
  const lines = [
    `# Cut-over checklist: ${name}`,
    '',
    `Project ${project}, data centre ${dc}. ${mdText(app.forms.length)} form(s), ${mdText(proof.tables.length)} table(s)${proof.tables.some((table) => table.sourceRows !== undefined) ? `, ${mdText(totalRows)} record(s) in the export` : ''}.`,
    `Readiness ${mdText(proof.readiness.automatic)}% automatic (${mdText(proof.readiness.band)}); the manual items are in ${mdText(PROOF_MD)}.`,
    '',
    'This offline checklist verifies only the local app, export, checkpoint and smoke report named in the proof. It does not query Catalyst, Creator, users, DNS or links. Record the requested evidence before marking each human check complete; an empty evidence field means the item is still open.',
    '',
    tableRow(['Check', 'Type', 'Evidence to record']),
    '| --- | --- | --- |',
    tableRow([
      `Source app parses and readiness is ${proof.readiness.automatic}% (${proof.readiness.band})`,
      'Verified from local inputs',
      `${PROOF_JSON}: readiness and app facts`,
    ]),
    ...proof.tables.map((table) =>
      tableRow([
        `${table.table}: ${table.sourceRows ?? 'unknown'} source row(s)${table.checkpointRows === undefined ? '' : `; checkpoint ${table.match ? 'matches' : 'does not match'}`}`,
        'Verified from local inputs',
        `${PROOF_JSON}: table counts, checksums${table.delta ? ` and delta (${table.delta.new} new, ${table.delta.changed} changed, ${table.delta.deleted} deleted)` : ''}`,
      ]),
    ),
    tableRow([
      `Smoke result: ${proof.smoke.status}${proof.smoke.session ? ` (${proof.smoke.session})` : ''}`,
      proof.smoke.status === 'not run' ? 'Human check' : 'Supplied report; not independently observed',
      smokeEvidence,
    ]),
    tableRow(['Rollback baseline', 'Human check', 'Record rollback-export output path, project id, export time, and confirm the folder is stored outside this workspace.']),
    tableRow(['Creator freeze', 'Human check', 'Record who restricted Creator edits, the exact freeze time, and how users were notified.']),
    tableRow(['Final delta', 'Human check', 'Record final export folder and timestamp, sync-delta plan output, apply result, and the second plan showing 0 new / 0 changed for every table.']),
    tableRow(['Post-cutover smoke', 'Human check', 'Record smoke report path and pass result; include each form tested and the matching created record visible in its report.']),
    tableRow(['Sign-in and roles', 'Human check', 'Record each role tested, a non-sensitive test user identifier, successful landing URL, and role-appropriate page visibility.']),
    tableRow(['Redirect and links', 'Human check', 'Record the app URL opened, Creator home redirect result, and locations updated (emails, documents, bookmarks, integrations/webhooks).']),
    tableRow(['DNS and certificate', 'Human check', 'If a custom domain is used, record hostname, resolved target, and successful HTTPS/certificate check; otherwise record “not used”.']),
    tableRow(['Rollback readiness', 'Human check', 'Record the baseline path and whether a second post-cutover rollback export was needed and where it is stored.']),
    tableRow(['Owner sign-off', 'Human check', 'Record owner name, date, and approval after reviewing the proof and closing every manual item.']),
    '',
    '## 1. Rollback baseline',
    '',
    rollbackBaselineLine,
    rollbackLocationLine,
    '',
    '## 2. Freeze Creator edits',
    '',
    `- [ ] Human: notify ${name} users of the cut-over window; record the notice and time.`,
    '- [ ] Human: in Zoho Creator, open the app permissions and restrict write access to administrators or disable each form. Record the setting changed and verify a non-admin test account cannot submit.',
    '- [ ] Human: record the freeze time with timezone and the person who confirmed Creator writes are stopped.',
    '',
    '## 3. Final delta',
    '',
    `- [ ] Human: export every Creator report after the freeze with record ids (${sourceFlag}); record export folder and timestamp.`,
    `- [ ] Run and retain the plan output: ${mdInlineCode(`c2c sync-delta ${sourceFlag} <export-dir> --ds <app.ds> --since <state-dir> --project ${project}`)}.`,
    ...(pending.length ? pending.map((table) => `  - ${mdText(table.table)}: ${mdText(table.delta!.new)} new, ${mdText(table.delta!.changed)} changed at the last plan`) : []),
    '- [ ] After reviewing and approving the plan, run the same command with `--confirm`; record the result and checkpoint path.',
    '- [ ] Plan again: every table shows new 0 changed 0.',
    ...proof.tables.filter((table) => table.delta?.deleted).map((table) => `- [ ] ${mdText(table.table)}: ${mdText(table.delta!.deleted)} record(s) deleted in Creator. Delete them with \`--apply-deletes\` or keep them.`),
    '',
    '## 4. Smoke',
    '',
    `- [ ] Human: run ${mdInlineCode(`c2c smoke <app.ds> --project ${project} --url ${slate} --confirm`)}; it does not drive a browser — it names the app's #/admin/smoke page. Open that page signed in as the owner and copy the result code it shows.`,
    `- [ ] Human: run ${mdInlineCode(`c2c smoke <app.ds> --project ${project} --url ${slate} --result-code <code> --report <report.json>`)}; record report path and result, and pass that report to cutover-checklist with \`--smoke\`.`,
    ...app.forms.map((form) => `- [ ] Human: open ${mdText(form.displayName ?? form.name)} in the app, submit a test record, then open its report and confirm that same record appears. Record form, report, and pass/fail; remove test data only with explicit approval.`),
    '',
    '## 5. Sign-in',
    '',
    `- [ ] Human: verify these roles in the Catalyst console: ${auth.roles.length ? auth.roles.map((role) => mdText(role.role_name)).join(', ') : 'App User and App Administrator only'}. Record the role list shown.`,
    `- [ ] Human: invite the users${auth.portalUsers.length ? ` and ${mdText(auth.portalUsers.length)} portal user profile(s)` : ''}; set invitation redirect to ${slate}. Record invitation count and redirect URL, without recording email addresses.`,
    '- [ ] Human: have one user of each role sign in; record role, landing URL, and which permitted pages they can see. Do not record credentials.',
    '',
    '## 6. Redirect',
    '',
    `- [ ] Human: open ${slate} in a normal browser and record the resulting URL and whether the app loads.`,
    `- [ ] Human: open the Creator app home page and confirm it directs users to ${slate}; record the observed destination.`,
    '',
    '## 7. DNS and links',
    '',
    '- [ ] Human: if using a custom domain, check its DNS target and HTTPS certificate in the browser or DNS tooling; record hostname, target and result. Otherwise record “not used”.',
    '- [ ] Human: check links in emails, documents, bookmarks and other apps; record each location updated and its new URL.',
    '- [ ] Human: update integrations and webhooks that called Creator, then run one representative operation and record the successful new-function response.',
    '',
    '## 8. Rollback ready',
    '',
    '- [ ] Human: open the step 1 baseline folder and verify its expected files are intact; record path and check time.',
    `- [ ] Human: if records were written to the new app after the baseline, run ${mdInlineCode(`c2c rollback-export --ds <app.ds> --out <post-cutover-rollback-dir> --project ${project} --confirm`)}; record output path and record counts. Otherwise record “not needed”.`,
    '',
    '## 9. Owner sign-off',
    '',
    `- [ ] Human: review ${mdText(PROOF_MD)}; confirm every table matches, resolve each listed manual item, and record any accepted exception with its reason.`,
    '- [ ] Human owner: record name, date, and explicit approval here: ____________________',
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

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDirectory(path: string): boolean {
  try {
    opendirSync(path).closeSync();
    return true;
  } catch {
    return false;
  }
}

function isPathOutsideWorkspace(target: string, dir: string): boolean {
  const realDir = realPath(dir);

  const envWs = process.env.C2C_WORKSPACE;
  if (typeof envWs === 'string' && envWs.trim() !== '') {
    const rel = relative(realPath(envWs), realDir);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      return false;
    }
  }

  const targetAbs = realPath(target);
  const targetDir = isDirectory(targetAbs) ? targetAbs : dirname(targetAbs);
  const relTarget = relative(targetDir, realDir);
  if (!relTarget.startsWith('..') && !isAbsolute(relTarget)) {
    return false;
  }

  return true;
}

export function verifyRollbackEvidence(target: string, rollbackPath: string | undefined, app: App): RollbackEvidence | undefined {
  if (!rollbackPath) return undefined;
  const resolved = resolve(rollbackPath);
  let dir = dirname(resolved);
  let manifestFile = resolved;
  let rawManifest: string;
  try {
    rawManifest = readFileSync(resolved, 'utf8');
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        status: 'invalid',
        dir: resolved,
        outsideWorkspace: false,
        checksumMatch: false,
        reason: 'directory or file does not exist',
      };
    }
    if (code !== 'EISDIR') throw err;
    dir = resolved;
    manifestFile = join(dir, ROLLBACK_MANIFEST_FILE);
    const outsideWorkspace = isPathOutsideWorkspace(target, dir);
    try {
      rawManifest = readFileSync(manifestFile, 'utf8');
    } catch (manifestErr) {
      const manifestCode = (manifestErr as { code?: unknown } | null)?.code;
      if (manifestCode === 'ENOENT' || manifestCode === 'ENOTDIR' || manifestCode === 'EISDIR') {
        return {
          status: 'invalid',
          dir,
          outsideWorkspace,
          checksumMatch: false,
          reason: 'no manifest found',
        };
      }
      throw manifestErr;
    }
  }

  const outsideWorkspace = isPathOutsideWorkspace(target, dir);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawManifest) as Record<string, unknown>;
  } catch {
    return {
      status: 'invalid',
      dir,
      manifestFile,
      outsideWorkspace,
      checksumMatch: false,
      reason: 'invalid manifest JSON',
    };
  }

  const manifestResult = verifyRollbackManifest(dir, parsed, app);
  if (!manifestResult.ok) {
    return {
      status: 'invalid',
      dir,
      manifestFile,
      outsideWorkspace,
      checksumMatch: false,
      reason: manifestResult.reason,
    };
  }

  return {
    status: outsideWorkspace ? 'valid' : 'invalid',
    dir,
    manifestFile,
    outsideWorkspace,
    checksumMatch: true,
    ...(outsideWorkspace ? {} : { reason: 'export is inside the workspace' }),
  };
}

export function cutoverInput(target: string, args: readonly string[]): CutoverInput {
  const app = loadApp(target);
  const guard = planGuard(target, args, app.name?.trim() || 'app');
  const source = deltaSource(args);
  const loaded = source ? DELTA_SOURCES[source.kind]!(source.path, app, args.includes('--allow-empty')) : undefined;
  const since = flag(args, '--since');
  const state = since ? readStateFile(stateFilePath(since)) : {};
  const checkpoint = parseDeltaCheckpoint(state.delta);
  const conflicts = readConflictRecord(state);
  const projectId = typeof state.projectId === 'string' ? state.projectId : undefined;
  const slateUrl = typeof state.slateUrl === 'string' ? state.slateUrl : undefined;
  const smoke = readSmoke(flag(args, '--smoke'));
  const rollbackArg = flag(args, '--rollback-export') ?? flag(args, '--rollback') ?? flag(args, '--rollback-manifest');
  const rollback = verifyRollbackEvidence(target, rollbackArg, app);
  return {
    app,
    ...(loaded ? { loaded, sourceKind: source!.kind } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    state: { ...(projectId ? { projectId } : {}), ...(slateUrl ? { slateUrl } : {}) },
    scope: { org: guard.org, projectId: guard.projectId, dc: guard.dc },
    ...(smoke ? { smoke } : {}),
    ...(rollback ? { rollback } : {}),
    ...(flag(args, '--smoke') ? { smokeSource: flag(args, '--smoke') } : {}),
    ...(conflicts?.conflicts.length ? { conflicts } : {}),
  };
}

export const CUTOVER_USAGE =
  'usage: c2c cutover-checklist <file|dir> [--source-json <dir>|--source-csv <dir>|--source-backup <zip|dir>] [--since <state-file|dir>] [--smoke <file>] [--rollback-export <dir|file>] [--project <id>] [--dc <dc>] [--config <c2c-deploy.json>] [--out <dir>]\n' +
  '       c2c proof <file|dir> [same options]\n' +
  '       --smoke is the file c2c smoke --result-code <code> --report <file> wrote (a {"status":"pass"} result also works).\n' +
  '       --rollback-export is the directory or manifest file from c2c rollback-export.\n' +
  `       --out writes ${CHECKLIST_MD}, ${PROOF_JSON} and ${PROOF_MD}; otherwise the checklist (or the proof) is printed.\n`;

export function cutoverCli(args: readonly string[], io: Pick<Io, 'stdout' | 'stderr'>, which: 'checklist' | 'proof'): number {
  const [target, ...rest] = args;
  if (!target || target.startsWith('--')) {
    io.stderr(CUTOVER_USAGE);
    return 2;
  }
  try {
    closeSync(openSync(target, 'r'));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      io.stderr(`c2c: no such file or directory: ${target}\n`);
      return CLI_EXIT.inputUnreadable;
    }
    // Let the regular loader produce its established error for an existing
    // target the preflight could not read. EISDIR is expected for directory
    // inputs; other errors are likewise re-raised by the loader itself.
  }
  try {
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
  } catch (err) {
    io.stderr(`c2c: ${err instanceof Error ? err.message : `${which} failed`}\n`);
    return 1;
  }
}
