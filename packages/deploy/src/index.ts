export { DEPLOY_REPORT, LOADER_REPORT, STATE_FILE, confirmedLoadExit, deployCli, hasReportJson, planGuard, seedMigrateArgsProblem, seedMigrateCli, sourceBackupCli, sourceCsvCli, smokeArgsProblems, smokeCli, sourceCsvArgsProblem, readFunctionEnv, usersCli, verifyBehaviorCli, warnDriftPreflight, flag, loadApp, loadSource, loadRegistry, catalystSpawn, defaultIo } from './cli.js';
export type { Io, SpawnFn, SpawnResult } from './cli.js';
export { ALLOWED_ENV, ORG_HOW_TO_SET, PROJECT_HOW_TO_SET, GuardError, catalystProjectName, checkGuards, planScopeLines } from './guards.js';
export type { GuardCode, GuardInput, GuardOk } from './guards.js';
export {
  MAIL_LOG_TABLE,
  MAIL_SENDER_EVIDENCE,
  MAIL_SENDER_RULE,
  decideMail,
  formatMailFindings,
  mailConfig,
  mailImportSpec,
  mailLogTableStep,
  mailModuleSource,
  mailSenderEvidenceFor,
  mailSenderEvidenceVerified,
  mailSenderPrecheck,
  mailSenderStatusEntries,
  mailSenderTag,
  maskMailAddress,
  observeMailSenders,
  patchMail,
  readMailSenderEvidence,
  recipientsOf,
  sendsMail,
  writeMailSenderEvidence,
} from './mail.js';
export type { MailConfig, MailDecision, MailFinding, MailSender, MailSenderEvidence } from './mail.js';
export { buildDeploy, deployCommands, deployFiles, deployTableSteps, formatAsyncLaneWarning, formatPlan, migrateCatalystJson, writeDeployTree } from './plan.js';
export { DEAD_LETTER_TABLE, PROCESSED_TABLE, TRIGGERS_WIRED_FLAG, asyncLaneBlocker, deadLetterTableStep, processedTableStep } from './events.js';
export type { DeployBundle, DeployCommand, DeployFile, DeployUi } from './plan.js';
export { emptyRegistry } from './registry.js';
export { DC_ENDPOINTS, dcEndpoints, catalystBaseFor, deployMailRecipients } from './dc.js';
export {
  bucketName,
  buildOfflinePlan,
  c2cVersion,
  DC_TABLE,
  PLAN_CLI_PATHS,
  PLAN_EMITTED_CLI_PATHS,
  PLAN_MCP_BASE,
  PLAN_MCP_BY_FEATURE,
  PLAN_STEP_TOOLS,
  STEP_KINDS,
  planCli,
  planSignals,
  projectKey,
  resolveDc,
  sha256,
  writePlanTree,
} from './offline-plan.js';
export type { DcResolution, DcSource, OfflinePlan, PlanBudget, PlanFile, PlanProbe, PlanSignals, ProvisionStep, StepEndpoint, StepKind } from './offline-plan.js';
export type { ProjectRegistry } from './registry.js';
export { formatMigratePlan, formatSkipped, migrateSeed, parseSeed, parseSeedBlocked } from './seed.js';
export type { ParseSeedOptions, SeedBlocked, SeedForeignKey, SeedRow, SeedTable } from './seed.js';
export { assertSeedReferences, assertSeedColumns, assertSeedTables, foreignKeysForApp, orderTables, resolveForeignKeys } from './remap.js';
export type { RemapTable } from './remap.js';
export { formatCsvPlan, migrateCsv, migrateLoaded, parseCsv, readSourceCsv, readSourceJson, sourceIdCountQueries } from './csv.js';
export type { CsvLoad, CsvMigrateResult } from './csv.js';
export { readBackupUserLists, readSourceBackup } from './backup.js';
export {
  backupUserIdMap,
  formatInviteResult,
  formatManageResult,
  formatUserList,
  inviteUsers,
  listProjectUsers,
  manageProjectUser,
  summarizeProjectUser,
  parseSocialList,
  plusAddressIds,
  PLUS_EMAIL_REASON,
  readBackupUsers,
  readUsersState,
  newUsersSalt,
  roleIdFallback,
  SOCIAL_PROVIDERS,
  userRefId,
  usersInvitesCsv,
  usersPlan,
  usersPlanJson,
  usersPlanMarkdown,
  writeUsersState,
  USERS_INVITES_CSV,
  USERS_PLAN_JSON,
  USERS_PLAN_MD,
  USERS_STATE_FILE,
} from './users.js';
export type { BackupUser, InviteTarget, ListedUser, ManageUserAction, ManageUserResult, PlanUser, RoleMapRow, SocialPlan, SocialProvider, UsersInviteResult, UsersListResult, UsersPlan, UsersState } from './users.js';
export { readZip } from './zipfile.js';
export type { ZipEntry, ZipLimits } from './zipfile.js';
export { applyTablePlan, columnBody, columnDetailsOf, columnOf, compareColumnFlags, cyclicForeignKeyComponents, cyclicForeignKeys, foreignKeyId, formatMandatoryRelaxed, mandatoryRelaxedColumns, formatTableCreate, formatTableDiff, mandatoryRelaxedLine, nonDeferrableKeys, provisionedConstraints, provisionedConstraintsAndDrift, tableCreatePlan } from './tables.js';
export type { ColumnDriftFix, ColumnMismatch, LiveColumnDetail, RestFn, TableColumnDrift, TableCreateStep, TableDiff } from './tables.js';
export { API_TEMPLATE_FUNCTION, IAC_COMPONENT_ORDER, PROJECT_TEMPLATE_FILE, bucketItem, diffTemplate, formatDrift, importTemplate, importTemplateJson, normalizeTemplate, projectTemplate, projectTemplateJson } from './iac.js';
export { bucketCreateBody, ensureSeedBucket } from './stratus-bucket.js';
export type { SeedBucketEnsure } from './stratus-bucket.js';
export type { DriftChange, DriftReport, ImportTemplateInput, ProjectTemplate, TemplateFunction, TemplateGrant, TemplateItem, TemplateRole } from './iac.js';
export { assertDeployRedirectUrl, IAC_DEPLOY_REDIRECT_URL, iacImportBundle, importMultipart, runProjectImport, StuckImportError, zipStore } from './iac-import.js';
export type { ImportAttempt, ImportFetch, ImportResult } from './iac-import.js';
export { exactId, parseJsonExact } from './json-exact.js';
export { fakeStatusRest, formatStatus, readStatus, statusArgsProblem, statusAsJson, statusCli, statusFunctionOf, statusLogErrorsOf, statusTableNamesOf } from './status.js';
export type { StatusFunction, StatusLogError, StatusReport, StatusSlateApp } from './status.js';
export { matchReadBack, provisionArgsProblem, provisionCli, resolveTokens } from './provision.js';
export type { ProvisionPlanFile, ProvisionState, StepRecord, StepStatus } from './provision.js';
export { readDeployConfig, resolveProvisionScope } from './provision-config.js';
export type { DeployConfig, ProvisionScope } from './provision-config.js';
export { assertProjectPath, assertSlatePath, catalystRestCall, decodeRestPayload, listCatalystProjects, parseProjectList, readCliAccessToken, redactStderrExcerpt, redactString } from './rest.js';
export { assertProjectDetails, assertReportedScope, catalystScopeArgs, cliRenderedProjectId, scrubCatalystEnv } from './scope.js';
export { catalystCreatedMs, importingAgeMs, importingAgeState, isStuckImporting, projectDataRecord, stuckImportGuidedStep, unknownImportAgeGuidedStep, STUCK_IMPORT_MAX_AGE_HOURS, STUCK_IMPORT_MAX_AGE_MS } from './stuck-import.js';
export type { ListedProject } from './stuck-import.js';
export { assertSmokeCookie, assertSmokeUrl, describeSmokeAuth, executeSmoke, formatSmokePlan, planSmoke, smokeCookieName } from './smoke.js';
export type { SmokeAuth, SmokeFetch, SmokeFieldPlan, SmokeInputs, SmokeKind, SmokeResult, SmokeRunOptions, SmokeStep } from './smoke.js';
export { cdpBrowser, openOnOrigin, pageFetch, runBrowserSmoke } from './browser.js';
export type { BrowserSmokeResult, SmokeBrowser, SmokePage } from './browser.js';
export { CONSOLE_SERVICES, formatPostDeploySteps, postDeploySteps, servicesTouched } from './post-deploy.js';
export { connectionSecretItem, formatHumanChecklist, humanChecklist } from './human-steps.js';
export type { HumanChecklistInput } from './human-steps.js';
export {
  buildFunctionEnv,
  extractConnectionSecrets,
  isDerivableEnvKey,
  readConnectionSecretKeys,
  sanitizeEnvKey,
  writeOrUpdateFunctionEnv,
} from './function-env.js';
export type { DeclaredConnectionSecret, FunctionEnvInput } from './function-env.js';
export type { ConsoleService, PostDeployStep } from './post-deploy.js';
export { applyAuthProvision, authProvisionPlan, errorCode, formatAuthProvision, hostOf, idString, projectUsers, roleIdFromUsers, slateUrlFrom } from './auth.js';
export type { AuthOpId, AuthOpResult, AuthOpStatus, AuthProvisionInput, AuthProvisionResult } from './auth.js';
export { restWithRetry, retryableStatus, retryDelayMs, spawnWithRetry, transientCatalystOutput } from './retry.js';
export type { ReRead, RestRetry, RetryOptions, SpawnedResult } from './retry.js';
export { readSlateAppUrl, SLATE_DOMAIN_WAITS_MS, SLATE_LIST_WAITS_MS, slateAppName, slateApps, slateConfigToml, slateDeploymentDomain, slateNameProblem, slateUrlOf, waitForSlateApp, waitForSlateDomain } from './slate.js';
export type { SlateAppRef, SlateRead } from './slate.js';

export { appShadowColumns, backfillCommand, backfillPageQuery, backfillShadows, formatBackfill, shadowColumns, staleShadowCountQuery, type BackfillResult, type ShadowColumn } from './shadows.js';
export { EDIT_OPS, EditError, applyEdit, applyEdits, editsJson, editsPathFor, fieldUsages, normaliseOp, readEdits, withEdits, writeEdits } from './edit.js';
export type { EditOp, EditOpName, EditResult, EditsFile, FieldRename, FieldUsage } from './edit.js';
export { DeltaRefused, applySchemaDelta, deltaFiles, formatDelta, modelPlan, planDelta, writeDeltaTree } from './delta.js';
export type { ColumnChange, FileChange, ModelPlan, PlanDelta, StoreDriver, TableChange } from './delta.js';
export { editCli, opFromArgs } from './edit-cli.js';
export { applyDelta, computeDelta, deletionRefusals, deltaCheckpointId, deltaTotals, formatDeltaPlan, MAX_DELETE_PERCENT, parseDeltaCheckpoint, rowFingerprint, tableChecksum, withDeletionsApplied } from './row-delta.js';
export type { DeltaApplyResult, DeltaCheckpoint, DeltaPlan, DeltaTable, DeletionRefusal } from './row-delta.js';
export { dataParity, formatParity, storeRowsFromDir, verifyCli } from './parity.js';
export type { DataParityReport, ParityTableReport } from './parity.js';
export { DELTA_SOURCES, deltaSource, readDeltaCheckpoint, readStateFile, rollbackExportCli, stateFilePath, syncDeltaCli } from './delta-cli.js';
export { parseStoreRows, readStoreRows, rollbackExport, ROLLBACK_DELETED_FILE, ROLLBACK_MANIFEST_FILE, ROLLBACK_MANIFEST_VERSION, verifyRollbackManifest } from './rollback.js';
export type { RollbackDelta, RollbackDeltaCounts, RollbackExport, RollbackFile, RollbackMode } from './rollback.js';
export {
  ALL_REGISTRY_TOOLS,
  CAPABILITY_MAPPINGS,
  MCP_TOOL_PREFIX as REGISTRY_MCP_TOOL_PREFIX,
  VERIFIED_MCP_TOOL_NAMES,
  VERIFIED_MCP_TOOL_REGISTRY,
  citationForTool,
  fallbackForTool,
  isVerifiedMcpTool,
} from './mcp-registry.js';
export type { CapabilityMapping, McpRegistryEntry } from './mcp-registry.js';
export { GOLDEN_VERSION, MARKERS, REPORT_VERSION, assertGolden, formatBehaviorJson, formatBehaviorMarkdown, liveBackend, loadGoldens, runBehavior, startOfflineBackend } from './verify-behavior.js';
export type { BehaviorBackend, BehaviorCall, BehaviorFinding, BehaviorReport, BehaviorRunResult, GoldenCase, GoldenFile, GoldenStep, GoldenStepExpect, OfflineHarnessOptions } from './verify-behavior.js';
