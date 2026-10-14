/**
 * Product adapters for Creator integration tasks (`zoho.crm.*`,
 * `zoho.books.*`, `zoho.desk.*`, `zoho.cliq.*`, `zoho.creator.*`),
 * `zoho.encryption.urlEncode`, and `invokeurl` with `connection:`.
 *
 * Each adapter has the task's Deluge signature (help-page order, with the
 * connection's argument index), builds the REST request the task wraps, and
 * reshapes the REST reply into the value Creator returns for that task.
 *
 * Auth comes from a Catalyst Connection (Console → Connections, a built-in
 * Zoho service). The Catalyst Node SDK (v3.2.0+) returns its credentials
 * with `app.connections().getConnectionCredentials(name)`:
 *   https://docs.catalyst.zoho.com/en/cloud-scale/help/connections/
 *   https://docs.catalyst.zoho.com/en/sdk/javascript/v1/cloudscale/connections/get-auth-credentials
 * The runtime takes that call as an injected `credentials(name)` function. It
 * accepts the documented headers/parameters object, or a bare access token
 * string (sent as `Authorization: Zoho-oauthtoken <token>`). A token is never
 * written to the transcript.
 *
 * Nothing here opens a socket unless the runtime is live, a DC is set, the
 * Creator link name maps to a Catalyst connection name, and credentials are
 * injected. Each missing piece is a refusal that names it.
 */

import { zohoConnectionHosts, zohoDcSpellings } from '../../core/src/dc.js';
import { jsonReplacer, parseJsonLossless } from './ids.js';
import { INVOKE_URL_DEFAULTS, InvokeUrlError, invokeUrl, type InvokeUrlFetch } from './invoke-url.js';
import { REDACTED, SECRET_NAME, redactUrlText } from './redact.js';

export { SECRET_NAME, redactUrlText };

export type ZohoService = 'crm' | 'books' | 'desk' | 'cliq' | 'creator' | 'encryption';

/**
 * Zoho data centres the adapters build URLs for: `C2C_ZOHO_DC` /
 * c2c-deploy.json `zohoDc`. Each DC has its own domain suffix
 * (e.g. https://www.zohoapis.eu/crm/v7, desk.zoho.eu). `com` is the host the
 * Deluge help pages use. Every DC follows the same per-DC domain suffix, including ca / sa / ae. Canada Desk
 * and Cliq use zohocloud.ca, the same accounts host as packages/core/src/dc.ts.
 * A DC not listed is refused, never guessed. An unset zohoDc is refused.
 * Zoho multi-DC API domains: https://www.zoho.com/accounts/protocol/oauth/multi-dc.html
 */
function connectionHosts(dc: string): { apis: string; desk: string; cliq: string } {
  const hosts = zohoConnectionHosts(dc);
  if (!hosts) {
    throw new ZohoConnectionRefused('zoho-dc', `unsupported Zoho DC "${dc}" (supported: ${zohoDcSpellings().join(', ')})`);
  }
  return hosts;
}

/** Supported zohoDc spellings. The value is the API origin; presence is the check. */
export const ZOHO_DCS: Readonly<Record<string, string>> = Object.fromEntries(
  zohoDcSpellings().map((key) => {
    const hosts = zohoConnectionHosts(key);
    if (!hosts) throw new Error(`DC table missing ${key}`);
    return [key, hosts.apis];
  }),
);

export function serviceBase(service: ZohoService, dc: string): string {
  const hosts = connectionHosts(dc);
  switch (service) {
    case 'crm':
      return `${hosts.apis}/crm/v7`;
    case 'books':
      return `${hosts.apis}/books/v3`;
    case 'creator':
      return `${hosts.apis}/creator/v2.1`;
    case 'desk':
      return `${hosts.desk}/api/v1`;
    case 'cliq':
      return `${hosts.cliq}/api/v2`;
    case 'encryption':
      throw new ZohoConnectionRefused('zoho-service', 'zoho.encryption tasks do not call a Zoho API');
  }
}

export const SERVICE_NAMES: Readonly<Record<ZohoService, string>> = {
  crm: 'Zoho CRM',
  books: 'Zoho Books',
  desk: 'Zoho Desk',
  cliq: 'Zoho Cliq',
  creator: 'Zoho Creator',
  encryption: 'Deluge encryption',
};

export interface RestRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RestReply {
  status: number;
  /** Parsed JSON, or the raw text when the body is not JSON, or null when empty. */
  body: unknown;
  /** Lowercased response headers, when the fetch result exposes them. */
  headers?: Record<string, string>;
}

export interface TaskAdapter {
  service: ZohoService;
  /** Parameter names in help-page order. */
  params: readonly string[];
  /** Index of `<connection>` in the Deluge call. Replaces "the last string argument". */
  connectionIndex: number;
  help: string;
  /** Minimal OAuth scope for this call. `args` lets a module-scoped scope name the module. */
  scope(args: readonly unknown[]): string;
  request(args: readonly unknown[], dc: string): RestRequest;
  response(reply: RestReply, args: readonly unknown[]): unknown;
  /** What the response shape was checked against. */
  evidence: string;
  /**
   * Computed locally. No connection and no HTTP. Dry run still returns the
   * value: there is no side effect to skip.
   */
  local?(args: readonly unknown[]): unknown;
}

export class ZohoConnectionRefused extends Error {
  readonly code = 'ZOHO_CONNECTION_REFUSED';
  readonly missing: string;
  constructor(missing: string, message: string) {
    super(`live-refused: ${message}`);
    this.name = 'ZohoConnectionRefused';
    this.missing = missing;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function redactNamed(map: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, SECRET_NAME.test(k) ? REDACTED : v]));
}

/** A REST request or a raw invokeurl map for the transcript: secret-named headers/parameters masked, URL redacted. */
export function redactForTranscript<T extends { url?: unknown; headers?: unknown; parameters?: unknown }>(request: T): T {
  const out: Record<string, unknown> = { ...request };
  if (typeof request.url === 'string') out.url = redactUrlText(request.url);
  if (isMap(request.headers)) out.headers = redactNamed(request.headers);
  if (isMap(request.parameters)) out.parameters = redactNamed(request.parameters);
  return out as T;
}

/**
 * Refuses a URL that carries userinfo, before any request: fetch throws on it
 * and its message would carry the raw credentials. Names the host, never the
 * userinfo (or the query/fragment).
 */
export function refuseUrlUserinfo(url: URL, what: string, missing: string): void {
  if (url.username || url.password) {
    throw new ZohoConnectionRefused(missing, `${what} URL ${url.host} carries userinfo; pass credentials as headers or parameters, never in the URL`);
  }
}

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value, jsonReplacer) : String(value);
}

function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value ?? null, jsonReplacer));
}

function seg(value: unknown): string {
  return encodeURIComponent(text(value));
}

function query(params: Record<string, unknown>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return pairs.length ? `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(text(v))}`).join('&')}` : '';
}

function isMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** CRM write reply `{data:[{code, details, message, status}]}` → Deluge value. */
function crmWriteResponse(reply: RestReply): unknown {
  const first = isMap(reply.body) && Array.isArray(reply.body.data) ? reply.body.data[0] : undefined;
  if (isMap(first) && first.code === 'SUCCESS' && isMap(first.details)) return plain(first.details);
  // Error shape is not documented: return what CRM sent for the record (code, message, details), else the body.
  return plain(isMap(first) ? first : reply.body);
}

/** A 429 or 503 is retried (see invoke-url.ts). Retry-After is a floor and is never capped; a wait past maxWaitMs fails at once. */
export const ZOHO_RETRY = { maxRetries: 4, baseDelayMs: 200, maxDelayMs: 8000, maxWaitMs: 60_000 };

export { retryAfterMs } from './invoke-url.js';

function httpError(reply: RestReply): Record<string, unknown> {
  if (isMap(reply.body) && (reply.body.code !== undefined || reply.body.message !== undefined || reply.body.status !== undefined)) {
    return plain(reply.body) as Record<string, unknown>;
  }
  const message = typeof reply.body === 'string' && reply.body ? reply.body : 'request failed';
  return { code: `HTTP_${reply.status}`, message, status: 'error' };
}

/** CRM `{data:[record]}` → the record. Empty or 204 → {}. An error status with no body is an error map. */
function crmRecordResponse(reply: RestReply): unknown {
  if (reply.status === 204) return {};
  if (reply.body == null || reply.body === '') return reply.status >= 400 ? httpError(reply) : {};
  if (isMap(reply.body) && Array.isArray(reply.body.data)) {
    const first = reply.body.data[0];
    return first === undefined ? {} : plain(first);
  }
  if (reply.status >= 400) return httpError(reply);
  return plain(reply.body);
}

/** CRM `{data:[...]}` → the list. Empty or 204 → []. An error status with no body is an error map. */
function crmListResponse(reply: RestReply): unknown {
  if (reply.status === 204) return [];
  if (reply.body == null || reply.body === '') return reply.status >= 400 ? httpError(reply) : [];
  if (isMap(reply.body) && Array.isArray(reply.body.data)) return plain(reply.body.data);
  if (reply.status >= 400) return httpError(reply);
  return plain(reply.body);
}

/** JSON body as Deluge returned it; a non-JSON error becomes `{code, message, status}`. */
function bodyOrError(reply: RestReply): unknown {
  if (reply.body == null || reply.body === '') return reply.status >= 400 ? httpError(reply) : null;
  if (reply.status >= 400 && !isMap(reply.body) && !Array.isArray(reply.body)) return httpError(reply);
  return plain(reply.body);
}

function queryMap(value: unknown): Record<string, unknown> {
  if (!isMap(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key || entry === undefined || entry === null || entry === '') continue;
    out[key] = entry;
  }
  return out;
}

function orDefault(value: unknown, fallback: number): unknown {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function orgValue(value: unknown): unknown {
  if (value === undefined) return null;
  return value !== null && typeof value === 'object' ? plain(value) : value;
}

/** Variables API list → the requested variable's value. A miss or an HTTP error is an error map. */
function orgVariableResponse(reply: RestReply, name: string): unknown {
  const invalid = { code: 'INVALID_DATA', message: 'org variable was not in the response', status: 'error' };
  if (reply.status >= 400) return httpError(reply);
  if (isMap(reply.body) && Array.isArray(reply.body.variables)) {
    const hit = reply.body.variables.find((entry) => isMap(entry) && entry.api_name === name && 'value' in entry);
    if (isMap(hit)) return orgValue(hit.value);
    return invalid;
  }
  if (reply.body == null || reply.body === '') return invalid;
  return plain(reply.body);
}

/**
 * invokeConnector's Deluge value is `{status_code, response}` — `status_code`
 * is a string in Zoho's documented sample (`{"status_code":"200", …}`) and
 * `response` is text (callers do `.get("response").toJSONList()`). A body
 * that is already that map is returned as sent.
 */
function connectorResponse(reply: RestReply): unknown {
  if (isMap(reply.body) && 'status_code' in reply.body && 'response' in reply.body) return plain(reply.body);
  const response = reply.body == null || reply.body === '' ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body, jsonReplacer);
  return { status_code: String(reply.status), response };
}

/**
 * Deluge urlEncode. Same unreserved set as Java URLEncoder (alphanumeric,
 * `*`, `-`, `.`, `_`); every other byte is `%HH`. A space is `%20`, not `+`
 * (encodeUrl uses `+`). Non-text returns null.
 * https://www.zoho.com/deluge/help/functions/encryption/urlencode.html
 * https://www.zoho.com/deluge/help/functions/common/encodeurl.html
 */
const URL_ENCODE_UNRESERVED = /[A-Za-z0-9.*_-]/;

export function urlEncode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (URL_ENCODE_UNRESERVED.test(ch)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * The registry, keyed by task path after `zoho.` (`crm.createRecord`).
 * Help pages: https://www.zoho.com/deluge/help/ (one page per task).
 */
export const TASK_ADAPTERS: Readonly<Record<string, TaskAdapter>> = {
  'crm.createRecord': {
    service: 'crm',
    params: ['module_name', 'record_details', 'options_map', 'connection'],
    connectionIndex: 3,
    help: 'https://www.zoho.com/deluge/help/crm/create-record.html',
    scope: (args) => `ZohoCRM.modules.${text(args[0]).toLowerCase()}.CREATE`,
    request(args, dc) {
      const options = isMap(args[2]) ? args[2] : {};
      const body: Record<string, unknown> = { data: [plain(args[1] ?? {})] };
      if (options.trigger !== undefined) body.trigger = plain(options.trigger);
      return { method: 'POST', url: `${serviceBase('crm', dc)}/${seg(args[0])}`, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
    },
    response: crmWriteResponse,
    evidence: '[TESTED] (Deluge value = details map; CRM v7 POST reply envelope)',
  },
  'crm.searchRecords': {
    service: 'crm',
    params: ['module_name', 'criteria', 'page', 'per_page', 'search_value', 'connection'],
    connectionIndex: 5,
    help: 'https://www.zoho.com/deluge/help/crm/search-records.html',
    scope: (args) => `ZohoCRM.modules.${text(args[0]).toLowerCase()}.READ`,
    request(args, dc) {
      const extra = isMap(args[4]) ? args[4] : {};
      return {
        method: 'GET',
        url: `${serviceBase('crm', dc)}/${seg(args[0])}/search${query({ criteria: args[1], ...extra, page: args[2], per_page: args[3] })}`,
        headers: {},
      };
    },
    response(reply) {
      // 204 No Content (no match) is an empty list; a match is the record list.
      if (reply.status === 204 || reply.body === null || reply.body === '') return [];
      if (isMap(reply.body) && Array.isArray(reply.body.data)) return plain(reply.body.data);
      return plain(reply.body);
    },
    evidence: '[TESTED] (search feeds updateRecord; the search list shape is [UNVERIFIED])',
  },
  'crm.updateRecord': {
    service: 'crm',
    params: ['module_name', 'record_ID', 'record_value', 'options_map', 'connection'],
    connectionIndex: 4,
    help: 'https://www.zoho.com/deluge/help/crm/update-record.html',
    scope: (args) => `ZohoCRM.modules.${text(args[0]).toLowerCase()}.UPDATE`,
    request(args, dc) {
      const options = isMap(args[3]) ? args[3] : {};
      const body: Record<string, unknown> = { data: [plain(args[2] ?? {})] };
      if (options.trigger !== undefined) body.trigger = plain(options.trigger);
      return { method: 'PUT', url: `${serviceBase('crm', dc)}/${seg(args[0])}/${seg(args[1])}`, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
    },
    response: crmWriteResponse,
    evidence: '[TESTED] (Deluge value = details map; CRM v7 PUT reply envelope)',
  },
  'books.createRecord': {
    service: 'books',
    params: ['module_name', 'org_ID', 'data_map', 'connection'],
    connectionIndex: 3,
    help: 'https://www.zoho.com/deluge/help/books/create-record.html',
    scope: (args) => `ZohoBooks.${text(args[0]).toLowerCase()}.CREATE`,
    request(args, dc) {
      return {
        method: 'POST',
        url: `${serviceBase('books', dc)}/${seg(text(args[0]).toLowerCase())}${query({ organization_id: args[1] })}`,
        headers: { ...JSON_HEADERS },
        body: JSON.stringify(plain(args[2] ?? {})),
      };
    },
    response: (reply) => plain(reply.body),
    evidence: '[TESTED] (Deluge value = the Books reply: code, message, contact)',
  },
  'books.getRecords': {
    service: 'books',
    params: ['module_name', 'org_ID', 'search', 'connection'],
    connectionIndex: 3,
    help: 'https://www.zoho.com/deluge/help/books/fetch-records.html',
    scope: (args) => `ZohoBooks.${text(args[0]).toLowerCase()}.READ`,
    request(args, dc) {
      // Creator types <search> as STRING ("contact_name=C2C-B1"): a query string, appended as given.
      const search = text(args[2]);
      const params = new URLSearchParams(search);
      const extra = [...params.entries()].map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('');
      return { method: 'GET', url: `${serviceBase('books', dc)}/${seg(text(args[0]).toLowerCase())}${query({ organization_id: args[1] })}${extra}`, headers: {} };
    },
    response: (reply) => plain(reply.body),
    evidence: '[TESTED] Books lookup (Deluge value = the Books reply: code, contacts, page_context)',
  },
  'books.updateRecord': {
    service: 'books',
    params: ['module_name', 'org_ID', 'record_ID', 'data_map', 'books_connection'],
    connectionIndex: 4,
    help: 'https://www.zoho.com/deluge/help/books/update-record.html',
    scope: (args) => `ZohoBooks.${text(args[0]).toLowerCase()}.UPDATE`,
    request(args, dc) {
      return {
        method: 'PUT',
        url: `${serviceBase('books', dc)}/${seg(text(args[0]).toLowerCase())}/${seg(args[2])}${query({ organization_id: args[1] })}`,
        headers: { ...JSON_HEADERS },
        body: JSON.stringify(plain(args[3] ?? {})),
      };
    },
    response: (reply) => plain(reply.body),
    evidence: '[UNVERIFIED] assumed like books.createRecord (Deluge value = the Books reply)',
  },
  'desk.create': {
    service: 'desk',
    params: ['orgId', 'module_name', 'record_value', 'connection'],
    connectionIndex: 3,
    help: 'https://www.zoho.com/deluge/help/desk/create-record.html',
    scope: (args) => `Desk.${text(args[1]).toLowerCase()}.CREATE`,
    request(args, dc) {
      return {
        method: 'POST',
        url: `${serviceBase('desk', dc)}/${seg(args[1])}`,
        headers: { ...JSON_HEADERS, orgId: text(args[0]) },
        body: JSON.stringify(plain(args[2] ?? {})),
      };
    },
    response: (reply) => plain(reply.body),
    evidence: '[TESTED] (Deluge value = the Zoho Desk record)',
  },
  'cliq.postToChannel': {
    service: 'cliq',
    params: ['channel_name', 'message', 'connection'],
    connectionIndex: 2,
    help: 'https://www.zoho.com/deluge/help/cliq/post-to-channel.html',
    scope: () => 'ZohoCliq.Webhooks.CREATE',
    request(args, dc) {
      const message = isMap(args[1]) ? plain(args[1]) : { text: text(args[1]) };
      return { method: 'POST', url: `${serviceBase('cliq', dc)}/channelsbyname/${seg(args[0])}/message`, headers: { ...JSON_HEADERS }, body: JSON.stringify(message) };
    },
    response(reply) {
      // Creator returned {"code":200,"data":{"success":true},"status":"OK"} for a delivered post. The
      // upstream Cliq reply shape is not documented; an empty 2xx is treated as delivered.
      if (reply.status >= 200 && reply.status < 300 && (reply.body === null || reply.body === '')) {
        return { code: 200, data: { success: true }, status: 'OK' };
      }
      return plain(reply.body);
    },
    evidence: '[TESTED] (Deluge value); upstream reply [UNVERIFIED]',
  },
  'creator.getRecords': {
    service: 'creator',
    params: ['owner_name', 'app_link_name', 'report_link_name', 'criteria', 'from_index', 'limit', 'connection_link_name'],
    connectionIndex: 6,
    help: 'https://www.zoho.com/deluge/help/creator/get-records.html',
    scope: () => 'ZohoCreator.report.READ',
    request(args, dc) {
      return {
        method: 'GET',
        url: `${serviceBase('creator', dc)}/data/${seg(args[0])}/${seg(args[1])}/report/${seg(args[2])}${query({ criteria: args[3], from: args[4], limit: args[5] })}`,
        headers: {},
      };
    },
    response(reply) {
      // Creator returned exactly {code, data} (code 3000, ID as a string).
      if (isMap(reply.body) && reply.body.code === 3000) return { code: 3000, data: plain(reply.body.data ?? []) };
      return plain(reply.body);
    },
    evidence: '[TESTED] (Deluge value = {code:3000, data:[...]})',
  },
  // https://www.zoho.com/crm/developer/docs/api/v7/get-records.html
  'crm.getRecordById': {
    service: 'crm',
    params: ['module_name', 'record_ID', 'query_value', 'connection'],
    connectionIndex: 3,
    help: 'https://www.zoho.com/deluge/help/crm/get-record-by-id.html',
    scope: (args) => `ZohoCRM.modules.${text(args[0]).toLowerCase()}.READ`,
    request(args, dc) {
      return { method: 'GET', url: `${serviceBase('crm', dc)}/${seg(args[0])}/${seg(args[1])}${query(queryMap(args[2]))}`, headers: {} };
    },
    response: crmRecordResponse,
    evidence: 'Deluge returns the record map, not the data envelope. [DOC]',
  },
  // https://www.zoho.com/crm/developer/docs/api/v7/get-related-records.html
  'crm.getRelatedRecords': {
    service: 'crm',
    params: ['relation_name', 'parent_module_name', 'record_id', 'page', 'per_page', 'query_value', 'connection'],
    connectionIndex: 6,
    help: 'https://www.zoho.com/deluge/help/crm/get-related-records.html',
    scope: (args) => `ZohoCRM.modules.${text(args[1]).toLowerCase()}.READ`,
    request(args, dc) {
      const extra = queryMap(args[5]);
      return {
        method: 'GET',
        url: `${serviceBase('crm', dc)}/${seg(args[1])}/${seg(args[2])}/${seg(args[0])}${query({ ...extra, page: orDefault(args[3], 1), per_page: orDefault(args[4], 200) })}`,
        headers: {},
      };
    },
    response: crmListResponse,
    evidence: 'Deluge scripts iterate a list of records. Page defaults to 1 and per_page to 200. [DOC]',
  },
  // https://www.zoho.com/books/api/v3/contacts/#get-a-contact
  'books.getRecordsByID': {
    service: 'books',
    params: ['module_name', 'org_ID', 'record_id', 'connection'],
    connectionIndex: 3,
    help: 'https://www.zoho.com/deluge/help/books/fetch-record-by-id.html',
    scope: (args) => `ZohoBooks.${text(args[0]).toLowerCase()}.READ`,
    request(args, dc) {
      return {
        method: 'GET',
        url: `${serviceBase('books', dc)}/${seg(text(args[0]).toLowerCase())}/${seg(args[2])}${query({ organization_id: args[1] })}`,
        headers: {},
      };
    },
    response: bodyOrError,
    evidence: 'Deluge names this getRecordsByID, not getRecords. The sample response is the Books body. [DOC]',
  },
  // https://www.zoho.com/cliq/help/restapi/v2/
  'cliq.getRecords': {
    service: 'cliq',
    params: ['database_name', 'query_map', 'connection'],
    connectionIndex: 2,
    help: 'https://www.zoho.com/deluge/help/cliq/get-records.html',
    scope: () => 'ZohoCliq.Storages.READ',
    request(args, dc) {
      return { method: 'GET', url: `${serviceBase('cliq', dc)}/storages/${seg(args[0])}/records${query(queryMap(args[1]))}`, headers: {} };
    },
    response: bodyOrError,
    evidence: 'Deluge returns the Cliq body ({status, url, list}, or {status:FAILURE, message, code}). A read, so the messaging guard does not treat it as a send. Not available in Creator. [DOC]',
  },
  // https://www.zoho.com/crm/developer/docs/api/v7/get-variables.html
  'crm.getOrgVariable': {
    service: 'crm',
    params: ['api_name'],
    connectionIndex: -1,
    help: 'https://www.zoho.com/deluge/help/crm/get-organization-variable.html',
    scope: () => 'ZohoCRM.settings.variables.READ',
    request(args, dc) {
      const name = text(args[0]).trim();
      if (!name) throw new ZohoConnectionRefused('api_name', 'zoho.crm.getOrgVariable: api_name is empty; an unfiltered variables list can return the wrong variable');
      return { method: 'GET', url: `${serviceBase('crm', dc)}/settings/variables${query({ api_names: name })}`, headers: {} };
    },
    response: (reply, args) => orgVariableResponse(reply, text(args[0])),
    evidence: 'The task returns the variable value. The syntax has no connection argument, so live uses default:crm. [DOC]',
  },
  // https://www.zoho.com/developer/help/extensions/connectors.html
  'crm.invokeConnector': {
    service: 'crm',
    params: ['connector_api_name', 'parameter_map'],
    connectionIndex: -1,
    help: 'https://www.zoho.com/deluge/help/crm/invoke-connector-task.html',
    scope: () => 'ZohoCRM.settings.ALL',
    request(args, dc) {
      const variables = isMap(args[1]) ? plain(args[1]) : {};
      return {
        method: 'POST',
        url: `${serviceBase('crm', dc)}/settings/connectors/${seg(args[0])}/actions/invoke`,
        headers: { ...JSON_HEADERS },
        body: JSON.stringify({ variables }, jsonReplacer),
      };
    },
    response: connectorResponse,
    evidence: 'Deluge returns {status_code, response} and response is text. The syntax has no connection argument, so live uses default:crm. [DOC]',
  },
  'encryption.urlEncode': {
    service: 'encryption',
    params: ['string'],
    connectionIndex: -1,
    help: 'https://www.zoho.com/deluge/help/functions/encryption/urlencode.html',
    scope: () => '',
    local: (args) => urlEncode(args[0]),
    request() {
      throw new ZohoConnectionRefused('pure', 'zoho.encryption.urlEncode does not call a Zoho API');
    },
    response: (reply) => reply.body,
    evidence: 'Pure function. A space is %20; encodeUrl uses +. Non-text returns null.',
  },
};

export function adapterFor(path: readonly string[]): { key: string; adapter: TaskAdapter } | null {
  const key = path.join('.');
  const hit = Object.keys(TASK_ADAPTERS).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit ? { key: hit, adapter: TASK_ADAPTERS[hit]! } : null;
}

/** The connection argument at the signature's index, or null. */
export function connectionArg(adapter: TaskAdapter, args: readonly unknown[]): string | null {
  if (adapter.connectionIndex < 0) return null;
  const value = args[adapter.connectionIndex];
  return typeof value === 'string' && value.length ? value : null;
}

/** Service of an invokeurl URL on a Zoho API host, or null. */
export function serviceOfUrl(url: string): ZohoService | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (/^desk\.zoho\./.test(host) || host === 'desk.zohocloud.ca') return 'desk';
  if (/^cliq\.zoho\./.test(host) || host === 'cliq.zohocloud.ca') return 'cliq';
  if (/^(www\.)?zohoapis\./.test(host)) {
    const first = parsed.pathname.split('/')[1] ?? '';
    if (first === 'crm' || first === 'books' || first === 'creator') return first;
  }
  return null;
}

/** DC of a Zoho API URL (`in` for zohoapis.in), or null. */
export function dcOfUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('.zohocloud.ca')) return 'ca';
    const m = /^(?:www\.)?(?:zohoapis|desk\.zoho|cliq\.zoho)\.(.+)$/.exec(host);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

const VERB_ACTION: Readonly<Record<string, string>> = { GET: 'READ', POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE' };

/** Minimal scope for an invokeurl on a CRM module URL (`/crm/v7/Leads...`), or null when not derivable. */
export function invokeurlScope(url: string, method: string): string | null {
  const service = serviceOfUrl(url);
  const action = VERB_ACTION[method.toUpperCase()];
  if (service !== 'crm' || !action) return null;
  const module = new URL(url).pathname.split('/')[3];
  return module ? `ZohoCRM.modules.${module.toLowerCase()}.${action}` : null;
}

/** What `getConnectionCredentials(name)` (or an injected stand-in) returns. */
export type ConnectionCredentials = string | { headers?: Record<string, string>; parameters?: Record<string, string> } | { access_token?: string };

export interface ZohoConnectionsConfig {
  /** `C2C_ZOHO_DC` / c2c-deploy.json `zohoDc`. Required for a live call. */
  dc?: string | null;
  /**
   * Creator connection link name → Catalyst connection name. Required per
   * link for a live call. A call that names no connection uses the key
   * `default:<service>` (e.g. `default:crm`), never a guess.
   */
  connections?: Record<string, string | null | undefined>;
  /** Catalyst Connections credentials for a Catalyst connection name. */
  credentials?: (catalystName: string) => Promise<ConnectionCredentials>;
  /** HTTP client. Defaults to global fetch. `headers.get` is read for Retry-After. */
  fetch?: InvokeUrlFetch;
  /** Test hook. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Overrides {@link ZOHO_RETRY}. */
  maxRetries?: number;
  maxWaitMs?: number;
  /** Per-attempt timeout. Defaults to INVOKE_URL_DEFAULTS.timeoutMs. */
  timeoutMs?: number;
  /** Overall budget for one call including retries. Defaults to max(25 s, maxWaitMs + 1 ms). */
  deadlineMs?: number;
  /**
   * Test-only origin rewrite, e.g. { "https://www.zohoapis.com": "http://127.0.0.1:4100" }.
   * The transcript keeps the real URL.
   */
  originOverrides?: Record<string, string>;
  /**
   * Org-internal messaging destinations. A live Cliq post or mail to anything
   * not listed is refused (`owner-approval`) unless `ownerApprovalToken` is
   * set. Missing or empty means every live message is refused. Dry run is not
   * affected. See {@link guardMessaging}.
   */
  orgInternal?: OrgInternalDestinations | null;
  /** Owner approval for one deploy to message non-org-internal destinations. Never logged. */
  ownerApprovalToken?: string | null;
}

/**
 * The owner's org-internal destinations. Public forums and anything outside
 * the owner's Zoho org are never listed here.
 */
export interface OrgInternalDestinations {
  /** Cliq channel unique names (the `channelsbyname/<name>` segment). Compared case-insensitively. */
  cliqChannels?: readonly string[];
  /**
   * Mail recipients: a full address (`ops@example.com`) or a domain
   * (`@example.com` or `example.com`). Also covers Cliq `postToUser` (buddies/<email>).
   */
  mailRecipients?: readonly string[];
}

/**
 * `zoho-write`: a write to a Zoho endpoint c2c does not classify (value
 * `host/path`), or a mail send whose recipients could not be read. Never on
 * the allowlist: it needs the owner's token.
 */
export type MessageDestination = { kind: 'cliq-channel' | 'mail' | 'cliq-other' | 'zoho-write'; value: string; reason?: string };

/** The bare address of `Name <a@b.c>` or `a@b.c`, lower-cased. */
function bareAddress(value: string): string {
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1]! : value).trim().toLowerCase();
}

/** A mail address matches `a@b.c` exactly, or `@b.c` / `b.c` by domain. */
function mailMatches(value: string, entry: string): boolean {
  const addr = bareAddress(value);
  const at = addr.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = addr.slice(at + 1);
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e.startsWith('@')) return domain === e.slice(1);
  return e.includes('@') ? addr === e : domain === e;
}

function onAllowlist(dest: MessageDestination, allow: OrgInternalDestinations): boolean {
  if (dest.kind === 'cliq-channel') return (allow.cliqChannels ?? []).some((c) => c.trim().toLowerCase() === dest.value.trim().toLowerCase());
  if (dest.kind === 'mail') return (allow.mailRecipients ?? []).some((entry) => mailMatches(dest.value, entry));
  // Bots, chats and unclassified Zoho writes have no org-internal allowlist: they need the owner's token.
  return false;
}

/**
 * The owner's approval, read from `ownerApprovalToken`
 * (`C2C_OWNER_APPROVAL_TOKEN`):
 * - a JSON map `{"<destination>": "<token>", ...}` or `<destination>=<token>`
 *   pairs separated by commas approve only the destinations they name (a
 *   mail destination may be an address or `@domain`; a Cliq channel its
 *   unique name; an unclassified Zoho write its `host/path`);
 * - any other non-empty string approves every destination on that deploy.
 * A plain token is read as pairs when every comma-separated part is
 * `x=y` with y not starting with `=` (base64 padding stays plain). An
 * unreadable JSON map approves nothing.
 */
export function ownerApproval(token: string | null | undefined): { all: boolean; destinations: string[] } {
  const none = { all: false, destinations: [] };
  if (typeof token !== 'string' || !token.trim()) return none;
  const t = token.trim();
  if (t.startsWith('{')) {
    try {
      const map = JSON.parse(t) as unknown;
      if (!isMap(map)) return none;
      return { all: false, destinations: Object.entries(map).filter(([k, v]) => k.trim() && typeof v === 'string' && v.length > 0).map(([k]) => k.trim()) };
    } catch {
      return none;
    }
  }
  const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
  const pairs = parts.map((p) => /^([^=]+)=([^=].*)$/.exec(p));
  if (pairs.length && pairs.every((m) => m && m[1]!.trim() && m[2]!.trim())) return { all: false, destinations: pairs.map((m) => m![1]!.trim()) };
  return { all: true, destinations: [] };
}

function approvedByEntry(dest: MessageDestination, entry: string): boolean {
  if (dest.kind === 'mail') return mailMatches(dest.value, entry);
  return dest.value.trim().toLowerCase() === entry.trim().toLowerCase();
}

function hasAllowlist(allow: OrgInternalDestinations | null | undefined): allow is OrgInternalDestinations {
  return !!allow && ((allow.cliqChannels?.length ?? 0) > 0 || (allow.mailRecipients?.length ?? 0) > 0);
}

/**
 * Live outbound-message guard (rule: nothing posts outside the app owner's
 * org without approval). Every destination must be on `orgInternal`, or the
 * whole message is refused naming the outside destinations, unless
 * `ownerApprovalToken` is set. Returns whether the token was used.
 */
export function guardMessaging(
  config: Pick<ZohoConnectionsConfig, 'orgInternal' | 'ownerApprovalToken'> | null | undefined,
  call: string,
  destinations: readonly MessageDestination[],
): { approvedBy: 'allowlist' | 'owner-approval-token' } {
  const approval = ownerApproval(config?.ownerApprovalToken);
  const allow = config?.orgInternal;
  const outside = hasAllowlist(allow) ? destinations.filter((d) => !onAllowlist(d, allow)) : destinations;
  if (!outside.length && hasAllowlist(allow)) return { approvedBy: 'allowlist' };
  if (approval.all) return { approvedBy: 'owner-approval-token' };
  if (outside.length && outside.every((d) => approval.destinations.some((e) => approvedByEntry(d, e)))) return { approvedBy: 'owner-approval-token' };
  const unclassified = outside.find((d) => d.kind === 'zoho-write');
  if (unclassified) {
    throw new ZohoConnectionRefused('owner-approval', `${call}: ${unclassified.reason ?? 'a write to a Zoho endpoint c2c does not classify'} (${unclassified.value}); an owner approval token is required`);
  }
  const names = outside.map((d) => `${d.kind} "${d.value}"`).join(', ');
  if (!hasAllowlist(allow)) {
    throw new ZohoConnectionRefused('owner-approval', `${call}: no org-internal allowlist (zohoConnections.orgInternal) is configured, so live messaging is refused${names ? ` (destination ${names})` : ''}; an owner approval token is required`);
  }
  throw new ZohoConnectionRefused('owner-approval', `${call}: destination ${names} is not on the org-internal allowlist; an owner approval token is required`);
}

/** Mail recipients from a sendmail map: `to`, `cc`, `bcc` (string, comma list, or list). */
export function mailDestinations(message: Record<string, unknown>): MessageDestination[] {
  const out: MessageDestination[] = [];
  for (const key of ['to', 'cc', 'bcc']) {
    const raw = message[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      for (const part of text(item).split(/[,;]/)) if (part.trim()) out.push({ kind: 'mail', value: part.trim() });
    }
  }
  return out;
}

/**
 * Destinations of a `zoho.cliq.<task>` that posts a message, or null when the
 * task does not post. `postToChannel*` → the channel, `postToUser` → the
 * user's email, any other post (bot, chat) → `cliq-other`.
 */
export function cliqTaskDestinations(path: readonly string[], args: readonly unknown[]): MessageDestination[] | null {
  if ((path[0] ?? '').toLowerCase() !== 'cliq') return null;
  const task = (path[1] ?? '').toLowerCase();
  // Every documented Cliq task that sends a message starts with "post"
  // (postToChannel*, postToUser, postToBot*, postToChat). Update this check
  // if Zoho adds a sending task that does not.
  if (!task.startsWith('post')) return null;
  const target = text(args[0]);
  if (task.startsWith('posttochannel')) return [{ kind: 'cliq-channel', value: target }];
  if (task === 'posttouser') return [{ kind: 'mail', value: target }];
  return [{ kind: 'cliq-other', value: `${path[1]} ${target}` }];
}

/**
 * Destinations of a `zoho.<task>` that is an unclassified write rather than
 * a Cliq post, or null. `crm.invokeConnector` is an opaque RPC: a connector
 * can call an arbitrary third-party API (Zoho's own example posts CRM data
 * to Google Contacts), so it is always a `zoho-write` — the owner token,
 * never the org-internal allowlist. Used when there is no built request to
 * classify (the generic connection fallback, or an unset DC).
 */
export function connectorTaskDestinations(path: readonly string[], args: readonly unknown[]): MessageDestination[] | null {
  if ((path[0] ?? '').toLowerCase() !== 'crm' || (path[1] ?? '').toLowerCase() !== 'invokeconnector') return null;
  return [
    {
      kind: 'zoho-write',
      value: `crm/v7/settings/connectors/${text(args[0])}/actions/invoke`,
      reason: 'a CRM connector can call an arbitrary third-party API',
    },
  ];
}

/**
 * Destinations of a write to a Cliq message endpoint, or null when the URL
 * is not one. Read-only verbs are not messages.
 */
export function cliqUrlDestinations(url: string, method: string): MessageDestination[] | null {
  if (serviceOfUrl(url) !== 'cliq' || /^(GET|HEAD|OPTIONS)$/i.test(method)) return null;
  const parts = new URL(url).pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  return cliqPathDestinations(parts, method, url);
}

/**
 * Destinations from decoded Cliq path segments. `url` is only the
 * `cliq-other` fallback value — the request's own URL, so the data centre
 * always comes from config and never a hard-coded host.
 */
export function cliqPathDestinations(parts: string[], method: string, url: string): MessageDestination[] | null {
  if (/^(GET|HEAD|OPTIONS)$/i.test(method)) return null;
  const at = parts.findIndex((p) => /^(channelsbyname|channels|buddies|bots|chats)$/.test(p));
  if (at < 0) return [{ kind: 'cliq-other', value: url }];
  const kind = parts[at]!;
  const target = parts[at + 1] ?? '';
  if (kind === 'channelsbyname') return [{ kind: 'cliq-channel', value: target }];
  if (kind === 'buddies') return [{ kind: 'mail', value: target }];
  return [{ kind: 'cliq-other', value: `${kind}/${target}` }];
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A Zoho-owned host: any label starting with `zoho` (zoho.in, zohoapis.com, zohocloud.ca, zohomail.*). */
export function isZohoHost(host: string): boolean {
  return host.toLowerCase().replace(/\.$/, '').split('.').some((label) => label.startsWith('zoho'));
}

/**
 * A token of a path segment of a known service that sends mail or a
 * notification (CRM `actions/send_mail`, Books `invoices/<id>/email`,
 * `paymentreminder`, Desk `sendReply`). Such a write is not a record write.
 * Matched as a prefix of each token, so `send_mail`, `sendReply`,
 * `notifications` and `e-mail` all count.
 */
const SENDING_TOKEN = /^(send|e?mail|remind|notif|sms|paymentreminder)/;

/**
 * Whether a raw path segment sends: percent-decoded (to a fixed point),
 * `;params` and any `.ext` stripped, lowercased, split into tokens on `_`,
 * `-` and any other non-alphanumeric. `undecodable` when decoding fails;
 * the caller treats that as unknown.
 */
function sendingSegment(raw: string): boolean | 'undecodable' {
  let s = raw;
  for (let i = 0; i < 5 && s.includes('%'); i++) {
    let next: string;
    try {
      next = decodeURIComponent(s);
    } catch {
      return 'undecodable';
    }
    if (next === s) break;
    s = next;
  }
  if (/%[0-9a-f]{2}/i.test(s)) return 'undecodable';
  s = s.toLowerCase();
  const base = s.split(';')[0]!.split('.')[0]!;
  return [s, base].some((v) => v.split(/[^a-z0-9]+/).some((t) => SENDING_TOKEN.test(t)));
}

/** A host c2c cannot place: an IP literal (v4 or v6), localhost, or a single label. */
function ambiguousHost(host: string): boolean {
  return host.startsWith('[') || host.includes(':') || /^\d+(\.\d+){3}$/.test(host) || host === 'localhost' || host.endsWith('.localhost') || !host.includes('.');
}

/** A URL or header host, lowercased, without userinfo, port or trailing dots. Null when it cannot be parsed. */
function normalHost(value: string): string | null {
  try {
    return new URL(`http://${value.trim()}/`).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}

/** Host-naming header values of a request (`Host`, `:authority`, `X-Forwarded-Host`), split on commas. */
function headerHosts(headers: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (/^(host|:authority|x-forwarded-host)$/i.test(k.trim())) for (const part of String(v).split(',')) if (part.trim()) out.push(part.trim());
  }
  return out;
}

/** Mail recipients of a Zoho Mail send body: `toAddress`, `ccAddress`, `bccAddress` (comma lists). Null when the body is not readable. */
export function zohoMailBodyDestinations(body: string | undefined): MessageDestination[] | null {
  if (body === undefined || !body.trim()) return null;
  let fields: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isMap(parsed)) fields = parsed;
  } catch {
    const form = new URLSearchParams(body);
    if ([...form.keys()].some((k) => /^(to|cc|bcc)Address$/.test(k))) fields = Object.fromEntries(form.entries());
  }
  if (!fields) return null;
  // A recipient key in another spelling is not read here, so refuse to guess.
  if (Object.keys(fields).some((k) => /^(to|cc|bcc)address$/i.test(k) && !/^(to|cc|bcc)Address$/.test(k))) return null;
  const out: MessageDestination[] = [];
  for (const key of ['toAddress', 'ccAddress', 'bccAddress']) {
    const raw = fields[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      if (typeof item !== 'string') return null;
      for (const part of item.split(/[,;]/)) if (part.trim()) out.push({ kind: 'mail', value: part.trim() });
    }
  }
  return out.length ? out : null;
}

/**
 * How the messaging guard treats a live invokeurl / http request.
 * - `not-guarded`: a read verb (GET/HEAD/OPTIONS), or a placeable non-Zoho
 *   host (a dotted DNS name, no Host header naming another host). A
 *   non-Zoho host follows the connection policy only: with a connection
 *   link it needs `requireLive` (a configured Catalyst connection), without
 *   one it goes to the deployer's own `options.http` client. The messaging
 *   guard does not inspect it.
 * - `service`: a record write to a known non-messaging Zoho service (CRM,
 *   Books, Creator on zohoapis; Desk on desk.zoho), allowed under the
 *   connection rules.
 * - `messaging`: Cliq (cliq.zoho or zohoapis /cliq) or Zoho Mail (mail.zoho
 *   or zohoapis /mail). Every destination must be on `orgInternal`, or the
 *   owner's token must approve it. A mail write whose recipients cannot be
 *   read is a `zoho-write` destination (token only).
 * - `unknown`: any other write to a Zoho host, including a sending segment
 *   of a known service. Token only, named by host and path.
 * - An ambiguous effective host is `unknown`: an IP literal, localhost, a
 *   single label, a Zoho name in URL userinfo, or a Host / :authority /
 *   X-Forwarded-Host header naming another host. A header naming a Zoho
 *   host is classified as that host, and only `messaging` survives.
 * Deny by default: a write c2c cannot place is `unknown`, never `service`.
 */
export function classifyZohoWrite(url: string, method: string, body?: string, headers?: Record<string, string>):
  | { kind: 'not-guarded' }
  | { kind: 'service'; service: ZohoService }
  | { kind: 'messaging' | 'unknown'; destinations: MessageDestination[] } {
  if (/^(GET|HEAD|OPTIONS)$/i.test(method)) return { kind: 'not-guarded' };
  const verb = method.toUpperCase();
  const deny = (value: string, reason: string) => ({ kind: 'unknown' as const, destinations: [{ kind: 'zoho-write' as const, value, reason }] });
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny(url, `a ${verb} to a URL c2c cannot parse`);
  }
  const urlHost = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  const named = headerHosts(headers).map(normalHost);
  if (named.some((h) => h === null)) return deny(`${urlHost}${parsed.pathname}`, `a ${verb} with a Host header c2c cannot parse`);
  const others = [...new Set(named as string[])].filter((h) => h !== urlHost);
  // The effective host is ambiguous when a header names another host, or the
  // URL names no placeable one. A Zoho host in a header is classified as that
  // host (so it may be messaging); anything short of messaging is unknown.
  if (others.length > 0) {
    if (others.length === 1 && isZohoHost(others[0]!)) {
      const viaHeader = new URL(url);
      viaHeader.username = '';
      viaHeader.password = '';
      viaHeader.port = '';
      viaHeader.hostname = others[0]!;
      const c = classifyZohoWrite(viaHeader.toString(), method, body);
      if (c.kind === 'messaging' || c.kind === 'unknown') return c;
    }
    return deny(`${urlHost}${parsed.pathname}`, `a ${verb} whose Host header (${others.join(', ')}) differs from the URL host`);
  }
  const userinfo = `${decodeURIComponentSafe(parsed.username)}:${decodeURIComponentSafe(parsed.password)}`;
  if (!isZohoHost(urlHost) && (ambiguousHost(urlHost) || /zoho/i.test(userinfo))) {
    return deny(`${urlHost}${parsed.pathname}`, `a ${verb} to a host c2c cannot place (IP literal, localhost, single label or a Zoho name in userinfo)`);
  }
  const host = urlHost;
  if (!isZohoHost(host)) return { kind: 'not-guarded' };
  const where = `${host}${parsed.pathname}`;
  const unknown = (reason: string) => deny(where, reason);
  const raw = parsed.pathname.split('/').filter(Boolean);
  const sending = raw.map(sendingSegment);
  if (sending.includes('undecodable')) return unknown(`a ${verb} to a Zoho path c2c cannot decode`);
  const parts = raw.map((p) => decodeURIComponent(p));
  const apis = /^(www\.)?zohoapis\./.test(host);
  const first = (parts[0] ?? '').toLowerCase();
  if (/^cliq\.zoho\./.test(host) || host === 'cliq.zohocloud.ca' || (apis && first === 'cliq')) {
    return { kind: 'messaging', destinations: cliqPathDestinations(parts, method, url) ?? [] };
  }
  if (/^mail\.zoho\./.test(host) || /(^|\.)zohomail\./.test(host) || (apis && first === 'mail')) {
    const inQuery = [...parsed.searchParams.keys()].some((k) => /address/i.test(k));
    const dests = inQuery ? null : zohoMailBodyDestinations(body);
    if (dests) return { kind: 'messaging', destinations: dests };
    const sends = method.toUpperCase() === 'POST' && parts.some((p) => p.toLowerCase() === 'messages');
    return {
      kind: 'messaging',
      destinations: [{ kind: 'zoho-write', value: where, reason: sends ? `a ${method.toUpperCase()} to a Zoho Mail send endpoint whose recipients (toAddress/ccAddress/bccAddress) could not be read` : `a ${method.toUpperCase()} to a Zoho Mail endpoint with no readable recipients` }],
    };
  }
  let service: ZohoService | null = null;
  if (/^desk\.zoho\./.test(host) || host === 'desk.zohocloud.ca') service = 'desk';
  else if (apis && (first === 'crm' || first === 'books' || first === 'creator')) service = first;
  if (!service) return unknown(`a ${method.toUpperCase()} to a Zoho endpoint c2c does not classify`);
  if (sending.some(Boolean)) return unknown(`a ${method.toUpperCase()} to a ${service} endpoint that sends mail or a notification`);
  // A CRM connector invoke is an opaque RPC: the connector can call an
  // arbitrary third-party API, so it is never a plain record write.
  if (service === 'crm' && parts.some((p, i) => p.toLowerCase() === 'settings' && parts[i + 1]?.toLowerCase() === 'connectors')) {
    return unknown(`a ${method.toUpperCase()} to a CRM connector endpoint (a connector can call an arbitrary third-party API)`);
  }
  return { kind: 'service', service };
}

/** Destinations the messaging guard must check for a live invokeurl / http request, or null when it is not guarded. */
export function urlWriteDestinations(url: string, method: string, body?: string, headers?: Record<string, string>): MessageDestination[] | null {
  const c = classifyZohoWrite(url, method, body, headers);
  return c.kind === 'messaging' || c.kind === 'unknown' ? c.destinations : null;
}

/** Live preconditions. Throws a refusal naming the first missing piece. */
export function requireLive(
  config: ZohoConnectionsConfig | undefined,
  link: string | null,
  call: string,
  service: ZohoService | null = null,
): { dc: string; catalystName: string; credentials: NonNullable<ZohoConnectionsConfig['credentials']> } {
  if (!config) throw new ZohoConnectionRefused('zoho-connections', `${call}: no Zoho connections config`);
  if (!config.dc) throw new ZohoConnectionRefused('zoho-dc', `${call}: zohoDc / C2C_ZOHO_DC is not set`);
  if (!ZOHO_DCS[config.dc]) throw new ZohoConnectionRefused('zoho-dc', `${call}: unsupported Zoho DC "${config.dc}"`);
  const key = link ?? (service ? `default:${service}` : null);
  if (!key) throw new ZohoConnectionRefused('connection', `${call}: the Creator call names no connection`);
  const catalystName = config.connections?.[key];
  if (!catalystName) throw new ZohoConnectionRefused(`connections.${key}`, `${call}: no Catalyst connection configured for "${key}"`);
  if (!config.credentials) throw new ZohoConnectionRefused('credentials', `${call}: Catalyst Connections credentials are not available`);
  return { dc: config.dc, catalystName, credentials: config.credentials };
}

function authorise(request: RestRequest, creds: ConnectionCredentials): RestRequest {
  if (typeof creds === 'string') return { ...request, headers: { ...request.headers, Authorization: `Zoho-oauthtoken ${creds}` } };
  if (creds && 'access_token' in creds && typeof creds.access_token === 'string') {
    return { ...request, headers: { ...request.headers, Authorization: `Zoho-oauthtoken ${creds.access_token}` } };
  }
  const c = creds as { headers?: Record<string, string>; parameters?: Record<string, string> };
  let url = request.url;
  const params = c?.parameters ? Object.entries(c.parameters) : [];
  if (params.length) url += `${url.includes('?') ? '&' : '?'}${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  return { ...request, url, headers: { ...request.headers, ...(c?.headers ?? {}) } };
}

function rewrite(url: string, overrides: Record<string, string> | undefined): string {
  if (!overrides) return url;
  for (const [from, to] of Object.entries(overrides)) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
}

/**
 * One authorised REST call through {@link invokeUrl}: per-attempt timeout,
 * deadline, and 429/503 Retry-After. Zoho APIs do not document an
 * idempotency key, so none is added and a POST is not retried on 5xx.
 * Redirects are not followed: a 3xx is the reply, so the token and body never
 * reach a host the call did not name.
 * The token never leaves this function.
 */
export async function send(config: ZohoConnectionsConfig, request: RestRequest, credentials: ConnectionCredentials): Promise<RestReply> {
  const authed = authorise(request, credentials);
  const doFetch = config.fetch ?? (globalThis.fetch as unknown as NonNullable<ZohoConnectionsConfig['fetch']>);
  if (!doFetch) throw new ZohoConnectionRefused('fetch', 'no fetch available');
  const url = rewrite(authed.url, config.originOverrides);
  try {
    refuseUrlUserinfo(new URL(url), 'zoho request', 'userinfo');
  } catch (err) {
    if (err instanceof ZohoConnectionRefused) throw err;
    // An unparseable URL reaches the transport, whose thrown message is redacted.
  }
  try {
    return await invokeUrl({ ...authed, url }, {
      fetch: doFetch,
      ...(config.sleep ? { sleep: config.sleep } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      maxRetries: config.maxRetries ?? ZOHO_RETRY.maxRetries,
      maxWaitMs: config.maxWaitMs ?? ZOHO_RETRY.maxWaitMs,
      deadlineMs: config.deadlineMs ?? Math.max(INVOKE_URL_DEFAULTS.deadlineMs, (config.maxWaitMs ?? ZOHO_RETRY.maxWaitMs) + 1),
    }, parseJsonLossless);
  } catch (err) {
    if (err instanceof InvokeUrlError) throw new ZohoConnectionRefused(err.reason, redactUrlText(err.message));
    throw err;
  }
}

/**
 * Deluge `toString()` of a map or list is its JSON text (tested: every
 * response column). The translator emits `String(x)`, so adapter results get
 * a non-enumerable `toString` that returns that text.
 */
export function delugeValue<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.defineProperty(value, 'toString', { value: () => JSON.stringify(value, jsonReplacer), enumerable: false, configurable: true, writable: true });
  }
  return value;
}

/** invokeurl request map → REST request. `type` defaults to GET; `body` is sent as given. */
export function invokeurlRequest(request: Record<string, unknown>): RestRequest {
  const method = text(request.type || 'GET').toUpperCase() as RestRequest['method'];
  const headers: Record<string, string> = {};
  if (isMap(request.headers)) for (const [k, v] of Object.entries(request.headers)) headers[k] = text(v);
  const out: RestRequest = { method, url: text(request.url), headers };
  if (request.body !== undefined && request.body !== null) out.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body, jsonReplacer);
  else if (isMap(request.parameters)) {
    out.body = new URLSearchParams(Object.fromEntries(Object.entries(request.parameters).map(([k, v]) => [k, text(v)]))).toString();
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return out;
}

/** invokeurl reply → Deluge value: the parsed body (tested for GET/POST/PUT/DELETE). */
export function invokeurlResponse(reply: RestReply): unknown {
  return plain(reply.body);
}
