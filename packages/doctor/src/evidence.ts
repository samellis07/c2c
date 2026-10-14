/**
 * The MCP evidence record: validated facts only. The plugin builds it from
 * calls observed in the user's session (`--mcp-observed`, observed.ts); an
 * operator may supply it as a file (`--record-mcp <file> --operator`).
 * The file carries facts only — host, tool names, ids — never a URL path
 * (personal Zoho MCP URLs embed a token), never an email, never a value so
 * long it could smuggle record data. Rejected files never reach doctor.json.
 * Org/project lists are ids or `id name` pairs only: a raw read-back entry an
 * agent pasted whole is reduced to its id, so secret-bearing fields the
 * Catalyst project listing can carry never enter the record. An entry that
 * cannot name a decimal id is stale or partial — re-record, don't keep it.
 */
import { createHash } from 'node:crypto';
import { normalizeDc, type Dc } from './scope.js';
import requiredTools from '../data/required-mcp-tools.json' with { type: 'json' };
import { REQUIRED_MCP_TOOLS } from './required-tools.js';

const MAX_VALUE = 200;
const PREFIX = 'mcp__';
const TOOL_PREFIX = requiredTools.prefix; // CatalystbyZoho_
const META_TOOLS = new Set<string>(requiredTools.metaTools);
const AUTH_TOOLS = new Set(['authenticate', 'complete_authentication']);

export class EvidenceRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EvidenceRejected';
  }
}

/**
 * The file is stale or partial: a read-back entry lacks the fields a usable
 * record needs. The fix is always to record the evidence again, so the
 * finding names what is missing and nothing it held.
 */
export class EvidenceStale extends EvidenceRejected {
  constructor(what: string) {
    super(`MCP evidence is stale/incomplete: ${what}; re-record`);
    this.name = 'EvidenceStale';
  }
}

export interface McpEvidence {
  host?: string;
  server?: string;
  host_of_url?: string;
  transport?: string;
  shape?: string;
  features?: string[];
  tools?: string[];
  schemas?: Record<string, { path_variables?: string[]; body?: string[] }>;
  orgs?: string[];
  /** DCs derived only from observed organization console/API hosts, keyed by org id. */
  orgDcs?: Record<string, Dc>;
  /** Legacy operator field: parsed (ids only) but never compared — projects come from the Catalyst CLI list (D-C4). */
  projects?: string[];
  catalyst_skills_visible?: string[];
  at?: string;
  workspace?: string;
  /** Optional: every Catalyst MCP server the host saw (D-V3). */
  servers?: { name: string; host: string }[];
  /** Optional: table names in the target project (D-F3). */
  tables?: string[];
  /** Optional: the per-project table listing the MCP answers, keyed by project id (D-F3). */
  projectTables?: Record<string, string[]>;
  /** Optional: org-wide table count (D-F4). */
  orgTableCount?: number;
  /**
   * Doctor-derived only (never parsed from a file): the server-side probe
   * result. `verified` means the nonce-named write the request asked for was
   * read back over the Catalyst REST API in the selected project — the MCP
   * connector is bound to the CLI's org/DC/project.
   */
  binding?: { kind: 'bucket'; name: string; status: 'verified' | 'absent' | 'unverifiable' | 'unresolved'; detail: string };
}

/** Strip a host prefix `mcp__<server>__` (or `mcp__<a>__<b>__`) from a tool name. A non-string name is '', never a throw. */
export function bareToolName(name: string): string {
  let out = typeof name === 'string' ? name : '';
  while (out.startsWith(PREFIX)) {
    const rest = out.slice(PREFIX.length);
    const sep = rest.indexOf('__');
    if (sep < 0) return out;
    out = rest.slice(sep + 2);
  }
  return out;
}

/** The Catalyst tool short name (`CatalystbyZoho_Get_X` → `Get_X`), or the name itself for meta/auth tools. */
export function shortToolName(name: string): string {
  const bare = bareToolName(name);
  return bare.startsWith(TOOL_PREFIX) ? bare.slice(TOOL_PREFIX.length) : bare;
}

/** A plain server/name field: host-style characters only, no separators that carry a path or token. */
const PLAIN_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** True when the value looks like a URL or carries a path/query/fragment — token carriers, all rejected. */
function urlish(value: string, allowSlash: boolean): boolean {
  if (/[?#]/.test(value)) return true; // query / fragment: never valid, even in a path
  if (!allowSlash && value.includes('/')) return true; // path separators carry tokens
  // `scheme:` at position 0 (https:, data:, file:, mailto:). Timestamps start
  // with digits so `at` is unaffected; a Windows `C:\` path is only compared,
  // never dereferenced, so it is exempt under allowSlash.
  return !allowSlash && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

/**
 * Every string in the file must be short, path-free and address-free. Only
 * `evidence.workspace` may contain `/` (it is a path the D-V2 check compares,
 * never a URL c2c calls). Rejected keys are never echoed back: the error names
 * the field position, not the value, so a token inside a key cannot leak.
 */
function scanStrings(value: unknown, trail: string): void {
  if (typeof value === 'string') {
    const isPath = trail === 'evidence.workspace';
    if (value.length > MAX_VALUE) throw new EvidenceRejected(`${trail} is longer than ${MAX_VALUE} characters`);
    if (value.includes('@')) throw new EvidenceRejected(`${trail} contains an email address`);
    if (urlish(value, isPath)) throw new EvidenceRejected(`${trail} contains a URL path`);
    if (/<[^>\s]+>/.test(value)) throw new EvidenceRejected(`${trail} contains a placeholder like <YOUR_ZOHO_MCP_URL>`);
    return;
  }
  if (Array.isArray(value)) {
    // Raw read-back entries under projects/orgs are reduced to an id before
    // anything uses them, so their fields (which may hold secrets or URLs the
    // entry carried) never reach a check or a file; the id/name extraction
    // validates what it keeps.
    const rawEntries = trail === 'evidence.projects' || trail === 'evidence.orgs';
    value.forEach((item, i) => {
      if (rawEntries && item && typeof item === 'object') return;
      scanStrings(item, `${trail}[${i}]`);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.length > MAX_VALUE || key.includes('@') || urlish(key, false) || /<[^>\s]+>/.test(key)) {
        throw new EvidenceRejected(`${trail} holds a key that is not a plain key`);
      }
      scanStrings(item, `${trail}.${key}`);
    }
  }
}

function stringArray(value: unknown, trail: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new EvidenceRejected(`${trail} must be a list of strings`);
  }
  return value as string[];
}

/**
 * The recorded table listing. The MCP answers per project — a record
 * `{project_id, project_name?, environment?, tables: [names], error?}` — so a
 * recorded file can hold every project the org carries and a check still only
 * reads the target project's names. Table records `{name}` and bare names
 * make a flat list (the target project's tables). Names and records never
 * mix; any other entry shape is rejected.
 */
function tableList(value: unknown, trail: string): { tables?: string[]; projectTables?: Record<string, string[]> } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new EvidenceRejected(`${trail} must be a list of table names or project records`);
  const flat: string[] = [];
  const perProject: Record<string, string[]> = {};
  let records = 0;
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string') {
      flat.push(item);
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const entry = item as Record<string, unknown>;
      if (typeof entry.name === 'string' && entry.name.trim()) {
        flat.push(entry.name);
        continue;
      }
      const id = entryIdOf(entry);
      if (id !== undefined && Array.isArray(entry.tables)) {
        perProject[id] = stringArray(entry.tables, `${trail}[${index}].tables`) ?? [];
        records++;
        continue;
      }
    }
    throw new EvidenceRejected(`${trail}[${index}] is not a table name or a project table record`);
  }
  if (records && records !== value.length) throw new EvidenceRejected(`${trail} mixes table names and project records`);
  return records ? { projectTables: perProject } : { tables: flat };
}

/** The decimal id leaf of a raw list entry, or undefined when the entry cannot name one. */
export function entryIdOf(entry: Record<string, unknown>): string | undefined {
  for (const key of ['id', 'project_id', 'projectId', 'org_id', 'zaid']) {
    const leaf = entry[key];
    if (typeof leaf === 'string' && /^[0-9]+$/.test(leaf.trim())) return leaf.trim();
    if (typeof leaf === 'number' && Number.isSafeInteger(leaf) && leaf >= 0) return String(leaf);
  }
  return undefined;
}

/**
 * An org/project list: each item is an id string (`"<id>"` or `"<id> <name>"`)
 * or a raw read-back entry — reduced to its id here, so a field the entry
 * carried (a client id, a secret, a URL) is never kept. An entry without a
 * decimal id is stale or partial evidence.
 */
function idArray(value: unknown, trail: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new EvidenceRejected(`${trail} must be a list of ids or entries`);
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const id = entryIdOf(item as Record<string, unknown>);
      if (id === undefined) throw new EvidenceStale(`${trail}[${index}] holds a project entry with no decimal id`);
      out.push(id);
      continue;
    }
    throw new EvidenceRejected(`${trail}[${index}] is not an id or an entry`);
  }
  for (const item of out) {
    const id = item.trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9]+$/.test(id)) throw new EvidenceRejected(`${trail} holds a non-decimal id`);
  }
  return out;
}

/**
 * Parse and validate an evidence file's text. Throws EvidenceRejected naming
 * the offending field. Returns the normalised record the merge keeps.
 */
export function parseEvidence(text: string): McpEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EvidenceRejected('the evidence file is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new EvidenceRejected('the evidence file is not a JSON object');
  scanStrings(parsed, 'evidence');
  const record = parsed as Record<string, unknown>;
  const out: McpEvidence = {};
  const str = (key: keyof McpEvidence & string): string | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new EvidenceRejected(`evidence.${key} must be a string`);
    return value.trim() || undefined;
  };
  out.host = str('host');
  out.server = str('server');
  if (out.server !== undefined && !PLAIN_NAME.test(out.server)) {
    throw new EvidenceRejected('evidence.server must be a plain server name');
  }
  out.host_of_url = str('host_of_url');
  if (out.host_of_url !== undefined && !/^[a-z0-9.-]+$/i.test(out.host_of_url)) {
    throw new EvidenceRejected('evidence.host_of_url must be a host name only');
  }
  out.transport = str('transport');
  if (out.transport !== undefined && !['http', 'streamable-http', 'sse', 'stdio', 'local'].includes(out.transport)) {
    throw new EvidenceRejected('evidence.transport must be http, stdio, or local');
  }
  out.shape = str('shape');
  if (out.shape !== undefined && out.shape !== 'meta' && out.shape !== 'direct') {
    throw new EvidenceRejected('evidence.shape must be meta or direct');
  }
  out.at = str('at');
  if (out.at !== undefined && Number.isNaN(Date.parse(out.at))) {
    throw new EvidenceRejected('evidence.at is not a timestamp');
  }
  out.workspace = str('workspace');
  out.features = stringArray(record.features, 'evidence.features');
  const tools = stringArray(record.tools, 'evidence.tools');
  if (tools !== undefined) {
    for (const name of tools) {
      const bare = bareToolName(name);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) throw new EvidenceRejected(`evidence.tools holds a bad tool name`);
      if (!bare.startsWith(TOOL_PREFIX) && !META_TOOLS.has(bare) && !AUTH_TOOLS.has(bare) && !/^ZohoMCP_/.test(bare)) {
        throw new EvidenceRejected('evidence.tools names a non-Catalyst tool');
      }
    }
    out.tools = tools;
  }
  const schemas = record.schemas;
  if (schemas !== undefined) {
    if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) throw new EvidenceRejected('evidence.schemas must be an object');
    const clean: McpEvidence['schemas'] = {};
    for (const [tool, value] of Object.entries(schemas as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvidenceRejected(`evidence.schemas.${tool} must be an object`);
      const entry = value as Record<string, unknown>;
      clean[tool] = {
        ...(entry.path_variables !== undefined ? { path_variables: stringArray(entry.path_variables, `evidence.schemas.${tool}.path_variables`) } : {}),
        ...(entry.body !== undefined ? { body: stringArray(entry.body, `evidence.schemas.${tool}.body`) } : {}),
      };
    }
    out.schemas = clean;
  }
  out.orgs = idArray(record.orgs, 'evidence.orgs');
  if (record.orgDcs !== undefined) {
    if (!record.orgDcs || typeof record.orgDcs !== 'object' || Array.isArray(record.orgDcs)) throw new EvidenceRejected('evidence.orgDcs must be an object');
    const orgDcs: Record<string, Dc> = {};
    for (const [org, value] of Object.entries(record.orgDcs as Record<string, unknown>)) {
      const dc = typeof value === 'string' ? normalizeDc(value) : undefined;
      if (!/^[0-9]+$/.test(org) || !dc) throw new EvidenceRejected('evidence.orgDcs must map decimal org ids to known DCs');
      orgDcs[org] = dc;
    }
    out.orgDcs = orgDcs;
  }
  out.projects = idArray(record.projects, 'evidence.projects');
  out.catalyst_skills_visible = stringArray(record.catalyst_skills_visible, 'evidence.catalyst_skills_visible');
  const tableLists = tableList(record.tables, 'evidence.tables');
  out.tables = tableLists.tables;
  out.projectTables = tableLists.projectTables;
  if (record.orgTableCount !== undefined) {
    if (typeof record.orgTableCount !== 'number' || !Number.isInteger(record.orgTableCount) || record.orgTableCount < 0) {
      throw new EvidenceRejected('evidence.orgTableCount must be a non-negative integer');
    }
    out.orgTableCount = record.orgTableCount;
  }
  if (record.servers !== undefined) {
    if (!Array.isArray(record.servers)) throw new EvidenceRejected('evidence.servers must be a list');
    out.servers = (record.servers as unknown[]).map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new EvidenceRejected(`evidence.servers[${i}] must be an object {name, host}, never a bare name`);
      const entry = item as Record<string, unknown>;
      if (
        typeof entry.name !== 'string' ||
        !PLAIN_NAME.test(entry.name) ||
        typeof entry.host !== 'string' ||
        !/^[a-z0-9.-]+$/i.test(entry.host)
      ) {
        throw new EvidenceRejected(`evidence.servers[${i}] must be {name, host}: a plain name and a host name`);
      }
      return { name: entry.name, host: entry.host };
    });
  }
  return out;
}

/** tools as bare names (prefix stripped) for comparisons against required-mcp-tools.json. */
export function evidenceToolShortNames(evidence: McpEvidence): Set<string> {
  return new Set((evidence.tools ?? []).map(shortToolName));
}

/**
 * Which required tools the evidence is missing: `base` (doctor's own set) and
 * `plan` (what this app's plan needs beyond base). The plan's needs come from
 * the caller as tool names (prefixed or bare) — `plan.json mcpTools.plan` plus
 * every MCP tool a provision step names.
 */
export function missingRequiredTools(
  evidence: McpEvidence,
  planToolNames: readonly string[] = [],
): { base: string[]; plan: string[] } {
  const have = evidenceToolShortNames(evidence);
  const base = REQUIRED_MCP_TOOLS.base.filter((name) => !have.has(name));
  const baseSet = new Set(REQUIRED_MCP_TOOLS.base);
  const planTools = new Set<string>();
  for (const name of planToolNames) planTools.add(shortToolName(name));
  const plan = [...planTools].filter((name) => !baseSet.has(name) && !have.has(name)).sort();
  return { base, plan };
}

export const REQUIRED_TOOL_GROUPS = Object.keys(REQUIRED_MCP_TOOLS.byFeature);

/** sha256 of the recorded schema shape for one tool (D-B6). */
export function schemaDigest(entry: { path_variables?: string[]; body?: string[] }): string {
  const norm = {
    path_variables: [...(entry.path_variables ?? [])].sort(),
    body: [...(entry.body ?? [])].sort(),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(norm)).digest('hex')}`;
}

/** The doctor.json `mcp` block for a validated evidence file, bound to the run's scope. */
export function mcpRecord(
  evidence: McpEvidence,
  scope?: { dc?: string; org?: string; project?: string },
  origin?: { source: 'observed'; observed: import('./observed.js').Observed } | { source: 'operator' },
): NonNullable<import('./types.js').DoctorFile['mcp']> {
  const digest: Record<string, string> = {};
  for (const [tool, entry] of Object.entries(evidence.schemas ?? {})) digest[tool] = schemaDigest(entry);
  return {
    ...(evidence.server ? { server: evidence.server } : {}),
    ...(evidence.shape ? { shape: evidence.shape } : {}),
    ...(evidence.host_of_url ? { host: evidence.host_of_url } : {}),
    ...(evidence.transport ? { transport: evidence.transport } : {}),
    ...(evidence.orgDcs ? { orgDcs: evidence.orgDcs } : {}),
    ...(evidence.tools ? { tools: [...evidence.tools].map(bareToolName).sort() } : {}),
    ...(Object.keys(digest).length ? { schemaDigest: digest } : {}),
    ...(scope && (scope.dc || scope.org || scope.project)
      ? { scope: { ...(scope.dc !== undefined ? { dc: scope.dc } : {}), ...(scope.org !== undefined ? { org: scope.org } : {}), ...(scope.project !== undefined ? { project: scope.project } : {}) } }
      : {}),
    ...(evidence.at ? { at: evidence.at } : {}),
    ...(origin ? { source: origin.source } : {}),
    ...(evidence.binding ? { binding: evidence.binding } : {}),
    ...(origin?.source === 'observed' ? { observed: origin.observed } : {}),
  };
}
