/**
 * Pinned registry of verified Catalyst MCP tool names.
 *
 * Source: Catalyst facts ledger (plugin/references/facts/) and plugin reference files.
 * Every entry cites its verifying source and documented fallback.
 *
 * Capabilities without a verified MCP tool map to CLI/IaC paths or manual checklist items.
 */

export const MCP_TOOL_PREFIX = 'CatalystbyZoho_';

export interface McpRegistryEntry {
  /** Bare tool name, e.g. "Add_User" */
  readonly name: string;
  /** Full tool name with prefix, e.g. "CatalystbyZoho_Add_User" */
  readonly fullName: string;
  /** Group: base (needed by doctor) or byFeature */
  readonly group: 'base' | 'byFeature';
  /** Feature category if byFeature */
  readonly feature?: string;
  /** Description of capability */
  readonly capability: string;
  /** Source citation in facts ledger or plugin reference files */
  readonly source: string;
  /** Documented fallback if the tool is missing from the MCP session */
  readonly fallback: string;
}

export interface CapabilityMapping {
  readonly capability: string;
  readonly mcpTool: string | null;
  readonly cliPath: string | null;
  readonly manualItem: string | null;
}

export const VERIFIED_MCP_TOOL_REGISTRY: readonly McpRegistryEntry[] = [
  // Base tools (needed by doctor)
  {
    name: 'List_All_Organizations',
    fullName: 'CatalystbyZoho_List_All_Organizations',
    group: 'base',
    capability: 'List Catalyst organizations visible to the account',
    source: 'plugin/references/doctor-spec.md:75',
    fallback: 'CLI catalyst --org <org> project:list (D-C4)',
  },
  {
    name: 'List_All_Tables',
    fullName: 'CatalystbyZoho_List_All_Tables',
    group: 'base',
    capability: 'List Data Store tables in the project',
    source: 'plugin/references/facts/limits.md:73',
    fallback: 'CLI GET /baas/v1/project/<project>/table',
  },
  {
    name: 'List_All_Columns',
    fullName: 'CatalystbyZoho_List_All_Columns',
    group: 'base',
    capability: 'List columns for a Data Store table',
    source: 'plugin/references/surface-decision-table.md:139',
    fallback: 'CLI GET /baas/v1/project/<project>/table/<table>/column',
  },
  {
    name: 'Execute_Query',
    fullName: 'CatalystbyZoho_Execute_Query',
    group: 'base',
    capability: 'Execute ZCQL query against Data Store',
    source: 'plugin/references/surface-decision-table.md:205',
    fallback: 'CLI POST /baas/v1/project/<project>/query',
  },
  {
    name: 'Get_Table_Permissions',
    fullName: 'CatalystbyZoho_Get_Table_Permissions',
    group: 'base',
    capability: 'Read role permissions for a Data Store table',
    source: 'plugin/references/facts/auth.md:70',
    fallback: 'console Data Store → <table> → Permissions',
  },
  {
    name: 'Update_Table_Permissions',
    fullName: 'CatalystbyZoho_Update_Table_Permissions',
    group: 'base',
    capability: 'Update role permissions for built-in roles',
    source: 'plugin/references/facts/auth.md:68',
    fallback: 'IaC tablePermission in template or console Data Store → <table> → Permissions',
  },
  {
    name: 'Get_Table_Scopes',
    fullName: 'CatalystbyZoho_Get_Table_Scopes',
    group: 'base',
    capability: 'Read row-level scope flags for a Data Store table',
    source: 'plugin/references/facts/auth.md:70',
    fallback: 'console Data Store → <table> → Permissions',
  },
  {
    name: 'Update_Table_Scopes',
    fullName: 'CatalystbyZoho_Update_Table_Scopes',
    group: 'base',
    capability: 'Update row-level scope flags for built-in roles',
    source: 'plugin/references/facts/auth.md:69',
    fallback: 'IaC tableScope in template or console Data Store → <table> → Permissions',
  },
  {
    name: 'Get_Authentication_Configurations',
    fullName: 'CatalystbyZoho_Get_Authentication_Configurations',
    group: 'base',
    capability: 'Read project authentication configuration',
    source: 'plugin/references/facts/auth.md:12',
    fallback: 'console Authentication → Embedded / Hosted',
  },
  {
    name: 'List_All_Roles',
    fullName: 'CatalystbyZoho_List_All_Roles',
    group: 'base',
    capability: 'List project roles',
    source: 'plugin/references/facts/auth.md:51',
    fallback: 'IaC template Authentication.roles or console Authentication → User Management → Roles',
  },
  {
    name: 'List_All_CORS_Domains',
    fullName: 'CatalystbyZoho_List_All_CORS_Domains',
    group: 'base',
    capability: 'List authorized CORS domains',
    source: 'plugin/references/facts/auth.md:22',
    fallback: 'OPTIONS preflight check or console Authentication → Authorized Domains',
  },
  {
    name: 'List_All_Project_Users',
    fullName: 'CatalystbyZoho_List_All_Project_Users',
    group: 'base',
    capability: 'List project users',
    source: 'plugin/references/facts/auth.md:83',
    fallback: 'CLI GET /baas/v1/project/<project>/project-user',
  },
  {
    name: 'List_All_Functions',
    fullName: 'CatalystbyZoho_List_All_Functions',
    group: 'base',
    capability: 'List project functions',
    source: 'plugin/references/surface-decision-table.md:281',
    fallback: 'CLI GET /baas/v1/project/<project>/function',
  },
  {
    name: 'List_All_Env_Variables',
    fullName: 'CatalystbyZoho_List_All_Env_Variables',
    group: 'base',
    capability: 'List function environment variables',
    source: 'plugin/references/facts/functions.md:22',
    fallback: 'CLI GET /baas/v1/project/<project>/function/<fn-id>',
  },
  {
    name: 'List_All_Slate_Apps',
    fullName: 'CatalystbyZoho_List_All_Slate_Apps',
    group: 'base',
    capability: 'List deployed Slate apps',
    source: 'plugin/references/surface-decision-table.md:311',
    fallback: 'CLI GET /slate/v1/project/<project>/app or curl -I <App Url>',
  },
  {
    name: 'Get_Logs',
    fullName: 'CatalystbyZoho_Get_Logs',
    group: 'base',
    capability: 'Read serverless function execution logs',
    source: 'plugin/references/surface-decision-table.md:481',
    fallback: 'console Functions → Logs',
  },

  // byFeature: schedules_or_long_work
  {
    name: 'Create_Job_Pool',
    fullName: 'CatalystbyZoho_Create_Job_Pool',
    group: 'byFeature',
    feature: 'schedules_or_long_work',
    capability: 'Create Function job pool for background scheduling',
    source: 'plugin/references/surface-decision-table.md:237',
    fallback: 'IaC SchedulingJobpool in template or console Job Scheduling',
  },
  {
    name: 'List_All_Jobpools',
    fullName: 'CatalystbyZoho_List_All_Jobpools',
    group: 'byFeature',
    feature: 'schedules_or_long_work',
    capability: 'List project job pools',
    source: 'plugin/references/surface-decision-table.md:241',
    fallback: 'CLI GET /job_scheduling/jobpool or console Job Scheduling',
  },
  {
    name: 'List_All_Crons',
    fullName: 'CatalystbyZoho_List_All_Crons',
    group: 'byFeature',
    feature: 'schedules_or_long_work',
    capability: 'List scheduled crons',
    source: 'plugin/references/surface-decision-table.md:251',
    fallback: 'CLI GET /job_scheduling/cron or console Job Scheduling',
  },

  // byFeature: files_or_bulk_load
  {
    name: 'Create_Bucket',
    fullName: 'CatalystbyZoho_Create_Bucket',
    group: 'byFeature',
    feature: 'files_or_bulk_load',
    capability: 'Create Stratus file bucket',
    source: 'plugin/references/surface-decision-table.md:267',
    fallback: 'IaC Stratus component in template or console Stratus',
  },
  {
    name: 'Get_All_Buckets',
    fullName: 'CatalystbyZoho_Get_All_Buckets',
    group: 'byFeature',
    feature: 'files_or_bulk_load',
    capability: 'List Stratus file buckets',
    source: 'plugin/references/surface-decision-table.md:271',
    fallback: 'CLI GET /bucket or console Stratus',
  },
  {
    name: 'Head_Bucket',
    fullName: 'CatalystbyZoho_Head_Bucket',
    group: 'byFeature',
    feature: 'files_or_bulk_load',
    capability: 'Check Stratus file bucket presence',
    source: 'plugin/references/surface-decision-table.md:199',
    fallback: 'CLI GET /bucket or console Stratus',
  },
  {
    name: 'Create_Upload_Signature',
    fullName: 'CatalystbyZoho_Create_Upload_Signature',
    group: 'byFeature',
    feature: 'files_or_bulk_load',
    capability: 'Generate signed URL for direct Stratus object upload',
    source: 'plugin/references/surface-decision-table.md:197',
    fallback: 'CLI-token REST PUT to the documented Stratus object URL (surface-decision-table.md:197); verify with Get_All_Objects',
  },

  // byFeature: custom_apis
  {
    name: 'Configure_API_Gateway_Route',
    fullName: 'CatalystbyZoho_Configure_API_Gateway_Route',
    group: 'byFeature',
    feature: 'custom_apis',
    capability: 'Configure API Gateway route',
    source: 'plugin/references/surface-decision-table.md:327',
    fallback: 'console API Gateway → Routes',
  },
  {
    name: 'List_All_API_route',
    fullName: 'CatalystbyZoho_List_All_API_route',
    group: 'byFeature',
    feature: 'custom_apis',
    capability: 'List API Gateway routes',
    source: 'plugin/references/surface-decision-table.md:321',
    fallback: 'console API Gateway → Routes',
  },
  {
    name: 'Get_API_route',
    fullName: 'CatalystbyZoho_Get_API_route',
    group: 'byFeature',
    feature: 'custom_apis',
    capability: 'Get API Gateway route configuration',
    source: 'plugin/references/surface-decision-table.md:331',
    fallback: 'console API Gateway → Routes',
  },

  // byFeature: sendmail
  {
    name: 'Create_Email_Configuration',
    fullName: 'CatalystbyZoho_Create_Email_Configuration',
    group: 'byFeature',
    feature: 'sendmail',
    capability: 'Add and verify email sender address',
    source: 'plugin/references/surface-decision-table.md:431',
    fallback: 'console Mail → Add Sender (with verification code)',
  },
  {
    name: 'List_All_Emails_Configuration',
    fullName: 'CatalystbyZoho_List_All_Emails_Configuration',
    group: 'byFeature',
    feature: 'sendmail',
    capability: 'List configured email sender addresses',
    source: 'plugin/references/surface-decision-table.md:433',
    fallback: 'CLI GET /baas/v1/project/<project>/email',
  },

  // byFeature: user_invites
  {
    name: 'Add_User',
    fullName: 'CatalystbyZoho_Add_User',
    group: 'byFeature',
    feature: 'user_invites',
    capability: 'Invite app user to project',
    source: 'plugin/references/facts/auth.md:83',
    fallback: 'CLI provision --run app-users (or CLI POST /project-user / console Authentication → User Management → Add User)',
  },
];

export const CAPABILITY_MAPPINGS: readonly CapabilityMapping[] = [
  {
    capability: 'auth_config_update',
    mcpTool: null,
    cliPath: 'c2c provision --confirm --run auth-hosted / auth-embedded (POST /baas/v1/project/<project>/authentication/enable)',
    manualItem: 'Catalyst console → Authentication (url_preference, branding, social logins)',
  },
  {
    capability: 'user_invites',
    mcpTool: 'CatalystbyZoho_Add_User',
    cliPath: 'c2c provision --confirm --run app-users (POST /baas/v1/project/<project>/project-user)',
    manualItem: 'Catalyst console → Authentication → User Management → Add User',
  },
  {
    capability: 'custom_roles',
    mcpTool: null,
    cliPath: 'provision/iac/project-template-1.0.0.json Authentication.roles (POST /baas/v1/project/import)',
    manualItem: 'Catalyst console → Authentication → User Management → Roles → Add Role',
  },
  {
    capability: 'table_permissions_custom_roles',
    mcpTool: null,
    cliPath: 'provision/iac/project-template-1.0.0.json tablePermissions (POST /baas/v1/project/import)',
    manualItem: 'Catalyst console → Data Store → <table> → Permissions',
  },
];

const VERIFIED_NAME_SET = new Set<string>();
const FALLBACK_BY_NAME = new Map<string, string>();
const CITATION_BY_NAME = new Map<string, string>();

for (const entry of VERIFIED_MCP_TOOL_REGISTRY) {
  VERIFIED_NAME_SET.add(entry.name);
  VERIFIED_NAME_SET.add(entry.fullName);
  FALLBACK_BY_NAME.set(entry.name, entry.fallback);
  FALLBACK_BY_NAME.set(entry.fullName, entry.fallback);
  CITATION_BY_NAME.set(entry.name, entry.source);
  CITATION_BY_NAME.set(entry.fullName, entry.source);
}

export function isVerifiedMcpTool(name: string): boolean {
  return VERIFIED_NAME_SET.has(name);
}

export function fallbackForTool(name: string): string | undefined {
  return FALLBACK_BY_NAME.get(name);
}

export function citationForTool(name: string): string | undefined {
  return CITATION_BY_NAME.get(name);
}

export const VERIFIED_MCP_TOOL_NAMES: readonly string[] = VERIFIED_MCP_TOOL_REGISTRY.map((e) => e.name);
export const ALL_REGISTRY_TOOLS: readonly string[] = VERIFIED_MCP_TOOL_NAMES;
