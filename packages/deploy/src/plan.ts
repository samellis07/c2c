/**
 * Dry-run Catalyst app directory: catalyst.json, functions, Slate client, Data Store schema.
 * Printing the plan does not call the network. --confirm is the only path that spawns the CLI.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { App } from '../../core/src/ir.js';
import { widgetManualItems, type WidgetManualItem } from '../../core/src/parse.js';
import { integrityColumns } from '../../data/src/integrity.js';
import { columnRenamesOf, constraintDecisionNote, generateSchema, schemaAsJson, type ConstraintDecision, type SchemaColumn, type SchemaTable, type SourceTableData } from '../../schema/src/generator.js';
import { appTimeZone, authBridgeUrl, buildUi, slateConfigSource } from '../../ui/src/generate.js';
import { mailTemplateCatalog } from '../../ui/src/decorations/print-templates.js';
import { generateReactApp } from '../../ui-react/src/generate.js';
import { API_FUNCTION, appOrigins, columnTypes, FUNCTION_DIR, functionDir, routeTable } from './function-dir.js';
import { AUTH_FUNCTION, authBridgeFiles, slateOriginOf } from './auth-bridge.js';
import { planSmoke } from './smoke.js';
import { slateAppName } from './slate.js';
import { confirmGuardLines, planScopeLines, type GuardOk } from './guards.js';
import { catalystRc, catalystScopeArgs } from './scope.js';
import {
  formatMailFindings,
  mailConfig,
  mailImportSpec,
  mailLogTableStep,
  mailModuleSource,
  mailSenderPrecheck,
  patchMail,
  sendsMail,
  type MailConfig,
  type MailFinding,
  type MailSender,
} from './mail.js';
import { ASYNC_ON_SUCCESS_WARNING, TRIGGERS_WIRED_FLAG, deadLetterTableStep, processedTableStep } from './events.js';
import { PROJECT_TEMPLATE_FILE, projectTemplateJson } from './iac.js';
import { seedBucketName, seedFileColumns } from './seed.js';
import { formatTableCreate, tableCreatePlan, type TableCreateStep } from './tables.js';
import { formatPostDeploySteps, postDeploySteps, servicesTouched } from './post-deploy.js';
import { authProvisionPlan } from './auth.js';
import { authPlan } from '../../auth/src/plan.js';
import { principalRoleMap } from '../../auth/src/apply.js';

/** ROWID plus every schema column, including decimal shadows, without a repeated name. */
function projectionNames(columnNames: readonly string[]): string[] {
  const names = ['ROWID'];
  for (const name of columnNames) if (!names.includes(name)) names.push(name);
  return names;
}

export interface DeployFile {
  path: string;
  data: string | Buffer;
}

/** Which UI the Slate app serves: the vanilla slate/ tree, or the React app built from web/ to web/dist. */
export type DeployUi = 'vanilla' | 'react';

export interface DeployCommand {
  /** Step id recorded in the resume state. */
  id: 'install' | 'functions' | 'functions-auth' | 'ui-deps' | 'ui-build' | 'slate-link' | 'slate';
  /** Program to spawn. Defaults to catalyst. */
  command?: 'catalyst' | 'npm';
  argv: string[];
  /** Working directory relative to the deploy dir. Defaults to the deploy dir. */
  cwd?: string;
}

export interface DeployOptions {
  /** live for a confirmed deploy; dry-run otherwise. */
  mode?: 'live' | 'dry-run';
  /** Base URL of the c2c_api function as the Slate client calls it. */
  apiBase?: string;
  /** The c2c_api function's current console environment, carried into catalyst-config.json env_variables. */
  functionEnv?: Readonly<Record<string, string>>;
  /** c2c-deploy.json `mail.testRecipients`. Omitted means nobody: no test sends. */
  mailTestRecipients?: readonly string[];
  /**
   * Source rows the store constraints are measured against (`--source-*`): a
   * mandatory/unique column the data disproves is provisioned without it and
   * stays enforced in the generated app instead.
   */
  source?: readonly SourceTableData[];
  /** The UI target the Slate app serves. Default react, which writes web/ and builds web/dist; vanilla is the fallback. */
  ui?: DeployUi;
  /**
   * This app's Slate host (bare host or the App Url slate:link prints). Its
   * https origin goes into the function's `allowedOrigins` alongside the API
   * base's origin — the only page origins the generated write endpoints accept.
   * When known (--slate-domain or a resumed slateUrl) it also lands as
   * c2c_auth's C2C_SLATE_ORIGIN.
   */
  slateDomain?: string;
  /** Opt-in async on-success lane: emit the event function, dead-letter store and sweep Job (docs/event-deadletter.md). */
  asyncOnSuccess?: boolean;
  /** Spike: copy only the subset of shim modules imported by generated code. Off by default. */
  subsetShims?: boolean;
}

export interface DeployBundle {
  files: DeployFile[];
  plan: string;
  commands: DeployCommand[];
  projectName: string;
  mail: MailConfig;
  tableSteps: TableCreateStep[];
  /** Mail sender precheck. A blocker stops a confirmed deploy. */
  mailFindings: MailFinding[];
  /** True when a generated server function calls the mail shim — the app sends mail. */
  sendsMail: boolean;
  /** True when the bundle emits async on-success event functions (the trigger gate applies). */
  usesEvents: boolean;
  /** Store constraints the `--source-*` data disproved — the deploy report records them so a later audit can see why a column was provisioned app-level. */
  constraints?: readonly ConstraintDecision[];
}

/**
 * Order: deploy the API, build and serve Slate, then deploy c2c_auth with the
 * served Slate origin in its environment. The bridge cannot run safely before
 * the app URL is known.
 */
export function deployCommands(slateName: string, org: string, projectId: string, dc: string, ui: DeployUi = 'react'): DeployCommand[] {
  const scope = catalystScopeArgs(org, projectId);
  const slateScope = ['-p', projectId, '--org', org, '--dc', dc];
  return [
    { id: 'install', command: 'npm', argv: ['install', '--omit=dev', '--no-audit', '--no-fund'], cwd: FUNCTION_DIR },
    { id: 'functions', argv: [...scope, 'deploy', '--only', `functions:${API_FUNCTION}`, '-ni'] },
    // The React target deploys the built dist/, not its source: the app's
    // pinned dependencies are installed and `npm run build` writes web/dist
    // inside the deploy dir before the Slate steps.
    ...(ui === 'react'
      ? [
          { id: 'ui-deps' as const, command: 'npm' as const, argv: ['ci', '--prefer-offline'], cwd: 'web' },
          { id: 'ui-build' as const, command: 'npm' as const, argv: ['run', 'build'], cwd: 'web' },
        ]
      : []),
    { id: 'slate-link', argv: [...slateScope, 'slate:link', '--name', slateName, '--framework', 'static', '--source', ui === 'react' ? './web/dist' : './slate', '-ni'] },
    { id: 'slate', argv: [...slateScope, 'deploy', 'slate', slateName, '-ni'] },
    // c2c_auth has no dependencies; cli.ts writes its validated C2C_SLATE_ORIGIN
    // after the Slate URL is known and immediately before this deployment.
    { id: 'functions-auth', argv: [...scope, 'deploy', '--only', `functions:${AUTH_FUNCTION}`, '-ni'] },
  ];
}

export function commandLine(command: DeployCommand): string {
  const where = command.cwd ? ` (in ${command.cwd})` : '';
  return `${command.command ?? 'catalyst'} ${command.argv.join(' ')}${where}`;
}

/** True when a generated server function calls the mail shim. */
function functionsSendMail(files: readonly { path: string; data: string | Buffer }[]): boolean {
  return sendsMail(files.map((file) => (file.path.startsWith('functions/') && typeof file.data === 'string' ? file.data : '')));
}

/**
 * The c2c_api function sources the app's handlers need before functionDir
 * expands the runtime assets: mail module, mail/projections/schema json, and
 * every functions/* file buildUi generated (mail import patched in).
 */
export function functionSources(
  schema: ReturnType<typeof generateSchema>,
  ui: { files: { path: string; data: string | Buffer }[] },
  mail: MailConfig,
  app?: App,
): DeployFile[] {
  // The mail module and its config ship only with an app whose handlers send
  // mail: a function of any other app never loads it or names its log table.
  const mails = functionsSendMail(ui.files);
  // sendmail `template:` attachments render against the app's print layouts;
  // the catalog ships beside c2c-mail.mjs only when there are layouts to name.
  const templates = app && mails ? mailTemplateCatalog(app) : {};
  const hasTemplates = Object.keys(templates).length > 0;
  const generated: DeployFile[] = [
    ...(mails
      ? [
          { path: 'functions/c2c-mail.mjs', data: mailModuleSource(mail.allowlist) },
          { path: 'functions/c2c-mail.json', data: `${JSON.stringify(mail, null, 2)}\n` },
          ...(hasTemplates
            ? [{ path: 'functions/c2c-print-templates.json', data: `${JSON.stringify(templates, null, 2)}\n` }]
            : []),
        ]
      : []),
    // c2c-columns.json stays the type map written by functionDir. The projection
    // is ROWID plus every schema column, including decimal shadows. The function
    // checks that list against c2c-schema.json at load.
    {
      path: 'functions/c2c-projections.json',
      data: `${JSON.stringify(Object.fromEntries(schema.tables.map((table) => [table.name, projectionNames(table.columns.map((column) => column.name))])), null, 2)}\n`,
    },
    {
      path: 'functions/c2c-schema.json',
      data: `${JSON.stringify(Object.fromEntries(schema.tables.map((table) => [table.name, table.columns.map((column) => column.name)])), null, 2)}\n`,
    },
    // Write-rule columns keyed like the generated runtime options (form link
    // name, child/junction table name): index.js hands them to the datastore
    // adapter so a direct adapter write is checked the same as a runtime write.
    {
      path: 'functions/c2c-rules.json',
      data: `${JSON.stringify(
        Object.fromEntries(
          schema.tables
            .filter((table) => !table.nosql && table.role !== 'junction')
            .map((table) => [table.role === 'form' ? table.form : table.name, integrityColumns(table)]),
        ),
        null,
        2,
      )}\n`,
    },
  ];
  // Reserved column names stored under another column: the adapter translates
  // the handlers' field names to these columns.
  const renames = columnRenamesOf(schema);
  if (Object.keys(renames).length) generated.push({ path: 'functions/c2c-renames.json', data: `${JSON.stringify(renames, null, 2)}\n` });
  for (const file of ui.files) {
    if (file.path === 'functions/c2c-mail.mjs' || !file.path.startsWith('functions/')) continue;
    const data = mails && typeof file.data === 'string' && file.path.endsWith('.mjs') ? patchMail(file.data, mailImportSpec(file.path)) : file.data;
    generated.push({ path: file.path, data });
  }
  return generated;
}

/** Files deploy would write. Table ordering is separate and may still throw on a foreign-key cycle. */
export function deployFiles(
  app: App,
  guard: GuardOk,
  mailEnabled: boolean,
  opts: DeployOptions = {},
  sender: MailSender = {},
): { files: DeployFile[]; mail: MailConfig; schema: ReturnType<typeof generateSchema>; sendsMail: boolean; usesEvents: boolean } {
  // A live tree without the app time zone fails every live handler at request
  // time (TimeZoneRequired inside createRuntime). Report it here, at generate
  // time, with the fix named — not as a runtime 500 "request failed".
  if (opts.mode === 'live' && !appTimeZone(app)) {
    throw new Error(
      `live deploy of "${app.name || 'app'}" needs the Creator "time zone" application setting: without it every live handler fails at request time. Add \`time zone = "<IANA zone>"\` to the .ds application settings, or set C2C_APP_TIMEZONE on the deployed function environment.`,
    );
  }
  const mail = mailConfig(mailEnabled, sender, opts.mailTestRecipients ?? []);
  const schema = generateSchema(app, opts.source ? { source: opts.source } : undefined);
  const ui = buildUi(app, { dc: guard.dc, schema, ...(opts.asyncOnSuccess ? { asyncOnSuccess: true } : {}) });
  const files: DeployFile[] = [];
  files.push({ path: 'catalyst.json', data: `${JSON.stringify(catalystJson(guard, mail), null, 2)}\n` });
  files.push({
    path: '.catalystrc',
    data: `${JSON.stringify(catalystRc(guard), null, 2)}\n`,
  });
  files.push({ path: 'c2c-mail.json', data: `${JSON.stringify(mail, null, 2)}\n` });
  // The drift template names the seed file-column bucket the import creates,
  // so an export that dropped it reads as drift. Apps without file fields
  // emit no Stratus items.
  const fileBucket = Object.keys(seedFileColumns(schema)).length ? seedBucketName((app.name ?? '').trim() || 'app') : undefined;
  files.push({ path: `iac/${PROJECT_TEMPLATE_FILE}`, data: projectTemplateJson(schema, undefined, fileBucket ? { bucket: fileBucket } : {}) });
  const json = schemaAsJson(schema);
  files.push({ path: 'schema/datastore.json', data: json.endsWith('\n') ? json : `${json}\n` });
  const generated = functionSources(schema, ui, mail, app);
  if (opts.ui === 'react') {
    // The React target: web/ holds the app source; the deploy commands build it
    // to web/dist, which the Slate steps link and deploy in place of slate/.
    // The runtime config is written with the same values the vanilla client
    // carries — API base, Web SDK sign-in, app time zone, and the smoke plan the
    // hidden #/admin/smoke page runs. Route keys come from the generated
    // functions exactly as routes.json assembles them.
    const smoke = planSmoke(app, { routes: routeTable(generated.filter((f) => f.path.startsWith('functions/'))), model: ui.model, schema });
    // The runtime config is the deploy's own: generated with the placeholder
    // base (its manifest hash stays stable), then replaced here with the real
    // api base, auth, smoke plan and project — the same values slate/c2c-config.js
    // carries for the vanilla target.
    for (const file of generateReactApp(app, { auth: true })) {
      files.push({
        path: `web/${file.path}`,
        data:
          file.path === 'public/c2c-config.js'
            ? slateConfigSource({ apiBase: opts.apiBase, auth: true, authBridge: authBridgeUrl(opts.apiBase), appTimeZone: appTimeZone(app), smokePlan: smoke, smokeProject: guard.projectId })
            : file.data,
      });
    }
  } else {
    for (const file of ui.files) {
      if (file.path === 'functions/c2c-mail.mjs' || file.path.startsWith('functions/')) continue;
      if (file.path === 'slate/c2c-config.js') {
        // The smoke plan the hidden #/admin/smoke page runs — the same calls
        // `c2c smoke --confirm` plans. Route keys come from the generated
        // functions exactly as routes.json assembles them.
        const smoke = planSmoke(app, { routes: routeTable(generated.filter((f) => f.path.startsWith('functions/'))), model: ui.model, schema });
        files.push({ path: file.path, data: slateConfigSource({ apiBase: opts.apiBase, auth: true, authBridge: authBridgeUrl(opts.apiBase), appTimeZone: appTimeZone(app), smokePlan: smoke, smokeProject: guard.projectId }) });
        continue;
      }
      files.push({ path: file.path, data: file.data });
    }
  }
  const verifiedFrom = mail.from && mail.verifiedSenders.includes(mail.from) ? mail.from : undefined;
  // The auth bridge function: a Slate page cannot mint a functions token (its
  // init.js leaves api_domain empty, so /baas calls 404 on the Slate origin).
  // c2c_auth serves the bridge page on the function origin, where the Web SDK
  // works first-party, and hands the token back in a state-bound fragment.
  files.push(...authBridgeFiles(guard.dc, slateOriginOf(opts.slateDomain)));
  files.push(
    ...functionDir(generated, {
      mode: opts.mode ?? 'dry-run',
      columns: columnTypes(schema.tables),
      env: opts.functionEnv,
      roleMap: principalRoleMap(authPlan(app)),
      origins: appOrigins({ apiBase: opts.apiBase, slateDomain: opts.slateDomain }),
      ...(verifiedFrom ? { mailFrom: verifiedFrom } : {}),
      ...(opts.subsetShims !== undefined ? { subsetShims: opts.subsetShims } : {}),
    }),
  );
  const widgetItems = widgetManualItems(app.widgets);
  if (widgetItems.length) {
    files.push({ path: 'manual/widgets.json', data: `${JSON.stringify({ widgets: widgetItems }, null, 2)}\n` });
  }
  return { files, mail, schema, sendsMail: functionsSendMail(ui.files), usesEvents: ui.files.some((file) => file.path.startsWith('functions/events/')) };
}

/**
 * Every table step a deploy runs: the app's schema tables, then the support
 * tables it needs. The delivery log is written only when a send can happen —
 * the app's functions send mail and the deploy turned mail on — so any other
 * deploy creates no log table.
 */
export function deployTableSteps(schema: ReturnType<typeof generateSchema>, sendingApp: boolean, mailEnabled: boolean, usesEvents = false): TableCreateStep[] {
  return [...tableCreatePlan(schema), ...(sendingApp && mailEnabled ? [mailLogTableStep()] : []), ...(usesEvents ? [deadLetterTableStep(), processedTableStep()] : [])];
}

export function buildDeploy(
  app: App,
  guard: GuardOk,
  mailEnabled: boolean,
  confirm = false,
  apiBase?: string,
  functionEnv?: Readonly<Record<string, string>>,
  sender: MailSender = {},
  auth?: { slateDomain?: string; admin?: { email: string; name?: string; roleId?: string } },
  mailTestRecipients: readonly string[] = [],
  source?: readonly SourceTableData[],
  ui: DeployUi = 'react',
  asyncOnSuccess = false,
  subsetShims?: boolean,
  slateName: string = slateAppName(guard.projectName),
): DeployBundle {
  const { files, mail, schema, sendsMail: mails, usesEvents } = deployFiles(
    app,
    guard,
    mailEnabled,
    {
      mode: confirm ? 'live' : 'dry-run',
      apiBase,
      functionEnv,
      mailTestRecipients,
      ...(source ? { source } : {}),
      ui,
      ...(asyncOnSuccess ? { asyncOnSuccess } : {}),
      ...(subsetShims !== undefined ? { subsetShims } : {}),
      ...(auth?.slateDomain ? { slateDomain: auth.slateDomain } : {}),
    },
    sender,
  );
  const commands = deployCommands(slateName, guard.org, guard.projectId, guard.dc, ui);
  const tableSteps = deployTableSteps(schema, mails, mail.enabled, usesEvents);
  const mailFindings = mailSenderPrecheck(app, mail);
  const widgetItems = widgetManualItems(app.widgets);
  const plan = formatPlan({
    guard,
    mail,
    tables: schema.tables,
    files,
    commands,
    confirm,
    tableSteps,
    mailFindings,
    auth,
    constraints: schema.constraints,
    ui,
    ...(widgetItems.length ? { widgets: widgetItems } : {}),
  });
  return { files, plan, commands, projectName: guard.projectName, mail, tableSteps, mailFindings, sendsMail: mails, usesEvents, ...(schema.constraints?.length ? { constraints: schema.constraints } : {}) };
}

export function writeDeployTree(dir: string, files: readonly DeployFile[]): void {
  for (const file of files) {
    const dest = join(dir, ...file.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
}

function catalystJson(guard: GuardOk, mail: MailConfig) {
  // No `slate` key: `slate:link` registers the app and writes that entry
  // itself. A pre-written entry can make the CLI answer "already linked".
  return {
    name: guard.projectName,
    project_id: guard.projectId,
    org_id: guard.org,
    environment: guard.environment,
    functions: { targets: [API_FUNCTION, AUTH_FUNCTION], ignore: [], source: 'functions' },
    mail: { enabled: mail.enabled, allowlist: mail.allowlist },
  };
}

/**
 * Remove a malformed non-array `slate` field from an existing catalyst.json.
 * Older c2c wrote an object; deleting it lets `slate:link` write the current
 * entry itself. An array (in particular one the CLI itself extended on link)
 * is left untouched.
 */
export function migrateCatalystJson(dir: string): boolean {
  const path = join(dir, 'catalyst.json');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.slate === undefined || Array.isArray(parsed.slate)) return false;
  delete parsed.slate;
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

function columnLine(column: SchemaColumn): string {
  const bits: string[] = [column.dataType];
  if (column.length !== undefined) bits.push(`length=${column.length}`);
  if (column.mandatory) bits.push('mandatory');
  if (column.unique) bits.push('unique');
  if (column.appMandatory) bits.push('app-mandatory (checked by the handler)');
  if (column.appUnique) bits.push('app-unique (checked by the handler)');
  if (column.relation) bits.push(`references=${column.relation.table}.${column.relation.column} on_delete=${column.relation.onDelete}`);
  return `  - ${column.name} ${bits.join(' ')}`;
}

function tableBlock(table: SchemaTable): string {
  const head = `- ${table.name} form=${table.form} role=${table.role}${table.nosql ? ' nosql' : ''}`;
  return [head, ...table.columns.map(columnLine)].join('\n');
}

/**
 * Deploy-time trigger gate, printed part. The trigger/rule is project
 * configuration the deploy does not create: when the bundle emits the
 * after-commit event function, the plan must say so loudly, and a confirmed
 * deploy refuses without the explicit opt-in (cli.ts). No event function, no
 * lines — flag-off plans are byte-identical.
 */
export function formatAsyncLaneWarning(files: readonly { path: string }[]): string[] {
  if (!files.some((file) => file.path.endsWith('/events/after-commit.mjs'))) return [];
  return [
    '',
    'async on-success triggers (opt-in lane):',
    `- ${ASYNC_ON_SUCCESS_WARNING.construct}: ${ASYNC_ON_SUCCESS_WARNING.note}`,
    `- triggers: wire one record trigger per table per action to functions/events/after-commit.mjs; a confirmed deploy refuses without ${TRIGGERS_WIRED_FLAG}`,
  ];
}

export function formatPlan(opts: {
  guard: GuardOk;
  mail: MailConfig;
  tables: readonly SchemaTable[];
  files: readonly DeployFile[];
  commands: readonly DeployCommand[];
  tableSteps: readonly TableCreateStep[];
  confirm?: boolean;
  mailFindings?: readonly MailFinding[];
  auth?: { slateDomain?: string; admin?: { email: string; name?: string; roleId?: string } };
  /** Constraints the source data moved to the app layer (deploy --source-*). */
  constraints?: readonly ConstraintDecision[];
  ui?: DeployUi;
  /** Widget packages the deploy does not generate. */
  widgets?: readonly WidgetManualItem[];
}): string {
  const functions = opts.files.map((file) => file.path).filter((path) => path.startsWith('functions/')).sort();
  const slate = opts.files.map((file) => file.path).filter((path) => path.startsWith('slate/')).sort();
  const web = opts.files.map((file) => file.path).filter((path) => path.startsWith('web/')).sort();
  // The app-specific React files are listed; the platform tree is byte-identical
  // for every app (build config and lib/c2c-ui/**) and is summarized.
  const webListed = web.filter((path) => path.startsWith('web/src/generated/') || path.startsWith('web/public/') || path.startsWith('web/src/custom/') || path === 'web/index.html');
  const webPlatform = web.length - webListed.length;
  const lines = [
    'c2c deploy plan v1',
    ...planScopeLines(opts.guard),
    opts.confirm ? 'credential: set' : 'credential: not checked',
    ...(opts.confirm ? [] : confirmGuardLines()),
    `mail: ${opts.mail.enabled ? 'enabled' : 'disabled'}`,
    `allowlist: ${opts.mail.allowlist.join(', ')}`,
    ...(opts.mail.from ? [`mail from: ${opts.mail.from} (${opts.mail.verifiedSenders.includes(opts.mail.from) ? 'verified' : 'not verified'})`] : []),
    ...formatMailFindings(opts.mailFindings ?? []),
    `confirm: ${opts.confirm ? 'yes' : 'no'}`,
    `ui: ${opts.ui ?? 'react'}`,
    ...formatAsyncLaneWarning(opts.files),
    '',
    'tables:',
    ...(opts.tables.length ? opts.tables.map(tableBlock) : ['- none']),
    ...(opts.constraints?.length ? ['', 'store constraints decided from source:', ...opts.constraints.map(constraintDecisionNote).map((line) => `- ${line}`)] : []),
    '',
    'functions:',
    ...(functions.length ? functions.map((path) => `- ${path}`) : ['- none']),
    '',
    'slate:',
    ...(slate.length ? slate.map((path) => `- ${path}`) : ['- none']),
    ...(web.length ? ['', 'web:', ...webListed.map((path) => `- ${path}`), `- plus ${webPlatform} platform files (build config and lib/c2c-ui/** — byte-identical for every app)`] : []),
    ...(opts.widgets?.length ? ['', 'widgets:', ...opts.widgets.map((item) => `- ${item.detail}`)] : []),
    '',
    'schema:',
    '- schema/datastore.json',
    '',
    'iac:',
    `- iac/${PROJECT_TEMPLATE_FILE}`,
    '',
    ...formatTableCreate(opts.guard.projectId, opts.tableSteps, opts.confirm === true),
    '',
    opts.confirm ? 'commands (Development only):' : 'commands (Development only; not run):',
    ...opts.commands.map((command) => `- ${commandLine(command)}`),
    '',
    opts.confirm ? 'auth provisioning (API):' : 'auth provisioning (API; not run):',
    ...authProvisionPlan({
      projectId: opts.guard.projectId,
      ...(opts.auth?.slateDomain ? { slateDomain: opts.auth.slateDomain } : {}),
      ...(opts.auth?.admin ? { admin: opts.auth.admin } : {}),
    }).map((op) => `- ${op.call.method} ${op.call.path} — ${op.note}`),
    '',
    // Planned: every table step may create a table. After the run the report uses the actual diff.
    formatPostDeploySteps(
      postDeploySteps(opts.guard.projectId, servicesTouched({ createdTables: opts.tableSteps.map((step) => step.table), commands: opts.commands, auth: true })),
      false,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
