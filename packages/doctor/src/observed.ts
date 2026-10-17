/**
 * The plugin's MCP evidence path. The CLI cannot see the host's MCP session,
 * so the evidence comes from calls the agent makes there, under the host's
 * normal per-call approval:
 *
 *   1. `c2c doctor --mcp-begin` opens a one-time request
 *      (`c2c-out/.c2c/mcp-request.json`: a random id, when it was issued,
 *      the probe bucket, this run's nonce and the scope it was opened
 *      under, authenticated by an HMAC recomputed on read so an edited
 *      file is refused)
 *      and prints the calls to make;
 *   2. the agent calls `CatalystbyZoho_Create_Bucket` (one probe bucket per
 *      project, reused), then `CatalystbyZoho_Create_Upload_Signature` to
 *      write an object whose key is this run's nonce, and
 *      `CatalystbyZoho_List_All_Organizations` — never the MCP project tools,
 *      which return project secrets (the doctor lists projects through the
 *      Catalyst CLI, D-C4);
 *   3. the agent pipes an observation — the request id, the session's
 *      Catalyst server/host/tool names, and each call's verbatim result — into
 *      `c2c doctor --mcp-observed -`.
 *
 * The echo of the nonce inside the submitted JSON proves nothing: the call
 * results are caller-controlled. The binding comes from the server side —
 * the doctor reads this run's nonce object back from the probe bucket over
 * the Catalyst REST API with the user's own CLI credential (`binding`), and
 * a stdio/local transport goes green only on that exact key. A bucket that
 * already exists without this run's object does not pass. The observation
 * results are still checked for error envelopes and reduced to ids/digests.
 *
 * The doctor derives the org ids from the call results itself, stamps
 * `at` and the workspace itself, and records a sha256 digest of each result.
 * Raw results are never written anywhere: only ids and digests are kept. An
 * observation that names its own orgs/projects/at/workspace, answers a request
 * this workspace did not issue (or already used), or arrives after the request
 * expired is refused. A free-standing evidence file is operator-only
 * (`--record-mcp <file> --operator`).
 *
 * Threat model for the request file: the file lives in the workspace, so it
 * is authenticated with an HMAC-SHA256 keyed by the same per-user key as the
 * stored MCP evidence (`$XDG_CONFIG_HOME/c2c/mcp-state.key`, 0600 in a 0700
 * directory outside the workspace, created on the first --mcp-begin, never
 * logged and never written into the request file). A local file edit between
 * begin and complete — a moved probe or nonce, a rewritten scope, a stripped
 * field — is detected and refused, and a request file written by an older
 * c2c (no `mac`, or the old plain-sha256 `digest` anyone could recompute)
 * is refused outright: there is no legacy fallback and no completion that
 * accepts the probe bucket's existence alone. An attacker who can read the
 * key file itself is out of scope, as with the stored-evidence signature.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EvidenceRejected, EvidenceStale, entryIdOf, parseEvidence, shortToolName, type McpEvidence } from './evidence.js';
import { NEVER_CALL_MCP_TOOLS } from './required-tools.js';
import { dcOfCreatorHost, type Dc } from './scope.js';
import { isProbeName, PROBE_CREATE_CALL, PROBE_DELETE_CALL, PROBE_OBJECT_CALL, probeCreateCall, probeDeleteCall, probeNameOf, probeNonceCleanup, probeObjectCall, probeScopeOf, type ProbeNonceCleanup, type ProbeScope, type ProbeTarget } from './mcp-probe.js';
import { mcpSigningKey } from './mcp-state.js';

export const OBSERVATION_KIND = 'c2c-mcp-observation';
export const OBSERVATION_SCHEMA = 1;
/** An open request must be answered within this window. */
export const MCP_REQUEST_MAX_AGE_MS = 15 * 60 * 1000;
/** The largest observation the CLI reads; results are only digested, never kept. */
export const OBSERVATION_MAX_BYTES = 4 * 1024 * 1024;
/** The largest verbatim call result inside an observation. */
export const MCP_RESULT_MAX_BYTES = 1024 * 1024;
/** A parsed result may unwrap through a few encoding layers (string → envelope → content → string), never deeper. */
const PAYLOAD_MAX_DEPTH = 12;

export const ORGS_CALL = 'CatalystbyZoho_List_All_Organizations';
export const PROBE_CALL = PROBE_CREATE_CALL;

/** Fields the agent reports from its session; everything else is derived or refused. */
const PASSTHROUGH = ['host', 'server', 'host_of_url', 'transport', 'shape', 'features', 'tools', 'schemas', 'catalyst_skills_visible', 'servers', 'tables', 'orgTableCount'];
/** Fields only the doctor writes. A caller that supplies one has edited the observation. */
const DERIVED = ['orgs', 'projects', 'at', 'workspace', 'binding'];
const ENVELOPE = ['kind', 'schema', 'request', 'calls'];
/** A calls[] entry carries exactly these keys. */
const CALL_KEYS = ['tool', 'result'];

export class ObservationRejected extends EvidenceRejected {
  constructor(reason: string) {
    super(reason);
    this.name = 'ObservationRejected';
  }
}

export interface McpRequest {
  schema: number;
  request: string;
  at: string;
  /** The probe bucket the begin output named (deterministic per scope); the observation answers for this bucket. */
  probe: string;
  /** This run's object key (32 hex). Recorded here so the read-back can require it. */
  nonce: string;
  /** The scope kind and exact target ids --mcp-begin ran under; the verify step rejects any drift from it. */
  scope: ProbeScope;
  /**
   * Whether the probe bucket was already in the project when --mcp-begin
   * ran (project-scoped begins only; absent when the list could not tell).
   * Signed with the rest, so the "created by this run" marker the cleanup
   * relies on can never be edited in.
   */
  bucketBefore?: 'present' | 'absent';
  /** HMAC-SHA256 over the request fields under the per-user key, recomputed when the file is read: an edited request never verifies. */
  mac: string;
}

export interface ObservedCall {
  /** Short tool name (`List_All_Organizations`). */
  tool: string;
  /** sha256 of the call's verbatim result. */
  digest: string;
}

export interface Observed {
  request: string;
  orgs: string[];
  calls: ObservedCall[];
}

export function mcpRequestPath(workspace: string): string {
  return join(workspace, 'c2c-out', '.c2c', 'mcp-request.json');
}

/** JSON with sorted object keys, so the request digest does not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The tag written into the request file: HMAC-SHA256 under the per-user key over every field the verify step trusts. */
function requestMac(key: Buffer, request: unknown): string {
  return `hmac-sha256:${createHmac('sha256', key).update(canonical(request)).digest('hex')}`;
}

function scopeOfRequest(value: unknown): ProbeScope | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const scope = value as Record<string, unknown>;
  if (scope.kind !== 'project' && scope.kind !== 'org' && scope.kind !== 'request') return undefined;
  const out: ProbeScope = { kind: scope.kind };
  if (scope.org !== undefined) {
    if (typeof scope.org !== 'string') return undefined;
    out.org = scope.org;
  }
  if (scope.project !== undefined) {
    if (typeof scope.project !== 'string') return undefined;
    out.project = scope.project;
  }
  return out;
}

/**
 * Open (or replace) this workspace's one-time request. The probe bucket and
 * the begin scope are pinned here so --mcp-observed reads back and tracks the
 * bucket --mcp-begin actually named, and refuses a completion in any other
 * scope — an org-scoped begin is never verified by a project-scoped binding
 * that creates the org-named bucket inside the project. The mac is
 * recomputed on read, so a request file edited after --mcp-begin is refused.
 */
export function beginMcpRequest(
  workspace: string,
  now: Date = new Date(),
  target: ProbeTarget = {},
  env: NodeJS.ProcessEnv = process.env,
  opts: { bucketBefore?: 'present' | 'absent' } = {},
): McpRequest {
  const signer = mcpSigningKey(env, workspace, true);
  if ('refused' in signer) throw new ObservationRejected(`the MCP request cannot be authenticated: ${signer.refused}`);
  const id = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const body = { schema: OBSERVATION_SCHEMA, request: id, at: now.toISOString(), probe: probeNameOf(id, target), nonce, scope: probeScopeOf(target), ...(opts.bucketBefore ? { bucketBefore: opts.bucketBefore } : {}) };
  const request: McpRequest = { ...body, mac: requestMac(signer.key, body) };
  const path = mcpRequestPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  for (const stale of readdirSync(dirname(path))) {
    if (/^mcp-request\.[0-9a-f]+\.closed$/.test(stale)) rmSync(join(dirname(path), stale), { force: true });
  }
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

function readMcpRequest(workspace: string, env: NodeJS.ProcessEnv): McpRequest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(mcpRequestPath(workspace), 'utf8')) as Partial<McpRequest> & { digest?: unknown };
    if (typeof parsed.request === 'string' && /^[0-9a-f]{32}$/.test(parsed.request) && typeof parsed.at === 'string') {
      // A request file without a mac is from an older c2c (the plain-sha256
      // `digest` anyone who can write the file could recompute, or nothing at
      // all). It is refused, never answered: there is no fallback to the
      // current scope's deterministic probe and no bucket-existence check.
      if (typeof parsed.mac !== 'string' || parsed.digest !== undefined) {
        throw new ObservationRejected('the MCP request file is from an older c2c; run c2c doctor --mcp-begin again');
      }
      const signer = mcpSigningKey(env, workspace, false);
      if ('refused' in signer) throw new ObservationRejected(`the MCP request cannot be authenticated: ${signer.refused}; run c2c doctor --mcp-begin again`);
      const probe = typeof parsed.probe === 'string' && isProbeName(parsed.probe) ? parsed.probe : undefined;
      const nonce = typeof parsed.nonce === 'string' && /^[0-9a-f]{32}$/.test(parsed.nonce) ? parsed.nonce : undefined;
      const scope = scopeOfRequest(parsed.scope);
      const bucketBefore = parsed.bucketBefore === 'present' || parsed.bucketBefore === 'absent' ? parsed.bucketBefore : undefined;
      const body: { schema: number; request: string; at: string; probe?: string; nonce?: string; scope?: ProbeScope; bucketBefore?: 'present' | 'absent' } = {
        schema: Number(parsed.schema),
        request: parsed.request,
        at: parsed.at,
        ...(probe ? { probe } : {}),
        ...(nonce ? { nonce } : {}),
        ...(scope ? { scope } : {}),
        ...(bucketBefore ? { bucketBefore } : {}),
      };
      // Authenticate before trusting a single field: the mac is over the
      // canonical fields, so a moved probe or nonce, a rewritten scope or a
      // stripped field can never complete.
      const want = Buffer.from(requestMac(signer.key, body));
      const got = Buffer.from(parsed.mac);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        throw new ObservationRejected('the MCP request file was edited after --mcp-begin; run c2c doctor --mcp-begin again');
      }
      // A request this c2c signed always carries probe, nonce and scope;
      // their absence means the file was hand-built with a copied mac.
      if (probe === undefined || nonce === undefined || scope === undefined) {
        throw new ObservationRejected('the MCP request file is incomplete; run c2c doctor --mcp-begin again');
      }
      return { ...body, probe, nonce, scope, mac: parsed.mac };
    }
  } catch (err) {
    if (err instanceof ObservationRejected) throw err;
    /* no open request */
  }
  return undefined;
}

/**
 * Close the request once its observation was accepted: an observation answers
 * exactly one request. The closed marker is created exclusively, so two
 * observations racing for one request cannot both win — the loser is refused.
 */
export function closeMcpRequest(workspace: string, request: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    writeFileSync(join(dirname(mcpRequestPath(workspace)), `mcp-request.${request}.closed`), `${request}\n`, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ObservationRejected('the MCP request was already answered; run c2c doctor --mcp-begin again');
    }
    throw err;
  }
  // Drop the open file only while it still names this request.
  try {
    if (readMcpRequest(workspace, env)?.request === request) rmSync(mcpRequestPath(workspace), { force: true });
  } catch {
    /* an unverifiable request file is left for the next begin to replace */
  }
}

/** An error flag on a result envelope: boolean true, or the "true" string a host may serialize. */
function isErrorFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Refuse a result carrying an error flag anywhere inside it: the top
 * envelope, a later text block, a bare array entry, or a data-style list.
 * JSON text layers unwrap the same way payloadOf unwraps them; nesting
 * beyond PAYLOAD_MAX_DEPTH is refused.
 */
function rejectIfErrorFlag(value: unknown, tool: string, depth = 0): void {
  if (depth > PAYLOAD_MAX_DEPTH) throw new ObservationRejected(`the ${tool} result nests deeper than the observation schema allows`);
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return;
    }
    rejectIfErrorFlag(parsed, tool, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectIfErrorFlag(item, tool, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isErrorFlag(record.isError)) throw new ObservationRejected(`the ${tool} call returned an error; make the call again`);
    for (const nested of Object.values(record)) rejectIfErrorFlag(nested, tool, depth + 1);
  }
}

/** The JSON payload of a tool result: a CallToolResult, its content blocks, a JSON string, or a plain value. */
function payloadOf(result: unknown, tool: string, depth = 0): unknown {
  if (depth > PAYLOAD_MAX_DEPTH) throw new ObservationRejected(`the ${tool} result nests deeper than the observation schema allows`);
  if (typeof result === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      throw new ObservationRejected(`the ${tool} result is not JSON`);
    }
    // A JSON string is one more encoding layer, not a leaf: re-enter so an
    // error envelope carried as text (`{"isError":true,…}`) is still caught.
    return payloadOf(parsed, tool, depth + 1);
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (isErrorFlag(record.isError)) throw new ObservationRejected(`the ${tool} call returned an error; make the call again`);
    if (record.structuredContent !== undefined) return payloadOf(record.structuredContent, tool, depth + 1);
    if (Array.isArray(record.content)) return payloadOf(record.content, tool, depth + 1);
  }
  if (Array.isArray(result) && result.length && result.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')) {
    const texts = (result as { text?: unknown }[]).map((block) => (typeof block.text === 'string' ? block.text : ''));
    return payloadOf(texts.length === 1 ? texts[0] : `[${texts.join(',')}]`, tool, depth + 1);
  }
  return result;
}

/** The first list of entries in a payload: the payload itself or a `data`-style field, a few levels deep. */
function entriesOf(payload: unknown, depth = 0): Record<string, unknown>[] | undefined {
  if (Array.isArray(payload)) {
    const objects = payload.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
    return objects.length === payload.length ? objects : undefined;
  }
  if (!payload || typeof payload !== 'object' || depth > 3) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'organizations', 'orgs', 'projects', 'result', 'results', 'items']) {
    if (record[key] !== undefined) {
      const found = entriesOf(record[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * An error result that only says the deterministic probe bucket is already
 * there (a repeated run re-creating the one bucket per project). The write
 * is still attested by the REST read-back, never by this result — any other
 * error is refused as before. The live duplicate shape is not documented, so
 * this matches the common wordings ([UNVERIFIED] against the live API).
 */
function isAlreadyExistsResult(result: unknown): boolean {
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    return false;
  }
  return /already[\s_-]*exists|duplicate|conflict|\b409\b/i.test(text);
}

/**
 * The Stratus first-use refusal: on a project that never opened Stratus the
 * Create_Bucket call (and any bucket write) answers OPERATION_NOT_ALLOWED
 * "in session when accessing Stratus for the first time". Retrying cannot
 * help — the fix is the one console bucket — so the rejection names it.
 */
function isStratusFirstUseResult(result: unknown): boolean {
  let text: string;
  try {
    text = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    return false;
  }
  return /in session when accessing Stratus/i.test(text);
}

/** A DC is retained only after it is derived from an org's observed console/API host. */
function orgHostDc(entry: Record<string, unknown>): Dc | undefined {
  for (const key of ['console_url', 'consoleUrl', 'console_host', 'consoleHost', 'api_url', 'apiUrl', 'api_host', 'apiHost']) {
    const value = entry[key];
    if (typeof value !== 'string') continue;
    let host = value;
    try {
      if (/^https?:\/\//i.test(value)) host = new URL(value).host;
    } catch {
      continue;
    }
    const dc = dcOfCreatorHost(host);
    if (dc) return dc;
  }
  return undefined;
}

/** The decimal ids a list call's verbatim result names; nothing else in the result is kept. */
function idsOfResult(result: unknown, tool: string): { ids: string[]; orgDcs: Record<string, Dc> } {
  // The envelope checks in payloadOf only see the top object: scan the whole
  // result first, so a flag in a later block, entry or list is still refused.
  rejectIfErrorFlag(result, tool);
  const entries = entriesOf(payloadOf(result, tool));
  if (!entries) throw new ObservationRejected(`the ${tool} result holds no list of entries`);
  const ids: string[] = [];
  const orgDcs: Record<string, Dc> = {};
  for (const entry of entries) {
    const id = entryIdOf(entry);
    if (id === undefined) throw new EvidenceStale(`the ${tool} result holds an entry with no decimal id`);
    ids.push(id);
    const dc = orgHostDc(entry);
    if (dc) orgDcs[id] = dc;
  }
  return { ids, orgDcs };
}

/** sha256 of a result exactly as observed (a string as-is, anything else as its JSON text). */
function resultDigest(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Read standard input up to `limit` bytes for `--mcp-observed -`. The read
 * stops as soon as the limit is passed, so a huge pipe is refused without
 * buffering it first; the byte check in parseObservation still applies to
 * observations that arrive by any other path.
 */
export function readStdinBounded(limit: number = OBSERVATION_MAX_BYTES, fd: number = 0): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const block = Buffer.alloc(64 * 1024);
  for (;;) {
    const read = readSync(fd, block, 0, block.length, null);
    if (read === 0) break;
    total += read;
    if (total > limit) throw new ObservationRejected(`the observation is larger than the ${limit}-byte limit`);
    chunks.push(Buffer.from(block.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Validate an observation against this workspace's open request and derive
 * the evidence from its call results. Throws ObservationRejected (or
 * EvidenceStale for an expired request / an id-less entry). Does not close
 * the request; the caller closes it once the observation is accepted.
 */
export function parseObservation(
  text: string,
  input: { workspace: string; now?: Date; env?: NodeJS.ProcessEnv },
): { evidence: McpEvidence; observed: Observed; probe: string; nonce: string; scope: ProbeScope; createdThisRun: boolean } {
  const now = input.now ?? new Date();
  if (Buffer.byteLength(text, 'utf8') > OBSERVATION_MAX_BYTES) {
    throw new ObservationRejected(`the observation is larger than the ${OBSERVATION_MAX_BYTES}-byte limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ObservationRejected('the observation is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ObservationRejected('the observation is not a JSON object');
  const record = parsed as Record<string, unknown>;
  if (record.kind !== OBSERVATION_KIND || record.schema !== OBSERVATION_SCHEMA) {
    throw new ObservationRejected(`not a ${OBSERVATION_KIND} (schema ${OBSERVATION_SCHEMA}); run c2c doctor --mcp-begin and make the calls it names`);
  }
  for (const key of DERIVED) {
    if (record[key] !== undefined) throw new ObservationRejected(`the observation sets ${key}; the doctor derives it from the call results`);
  }
  for (const key of Object.keys(record)) {
    if (!ENVELOPE.includes(key) && !PASSTHROUGH.includes(key)) throw new ObservationRejected('the observation holds a field that is not part of the observation schema');
  }

  const open = readMcpRequest(input.workspace, input.env ?? process.env);
  if (!open) throw new ObservationRejected('there is no open MCP request in this workspace; run c2c doctor --mcp-begin first');
  if (typeof record.request !== 'string' || record.request !== open.request) {
    throw new ObservationRejected('the observation answers a request this workspace did not issue; run c2c doctor --mcp-begin again');
  }
  const age = now.getTime() - Date.parse(open.at);
  if (!Number.isFinite(age) || age < 0 || age > MCP_REQUEST_MAX_AGE_MS) throw new EvidenceStale('the MCP request expired before the observation arrived');

  if (!Array.isArray(record.calls)) throw new ObservationRejected('the observation has no calls list');
  const calls: ObservedCall[] = [];
  let orgs: string[] | undefined;
  let orgDcs: Record<string, Dc> = {};
  let probeAlreadyExisted = false;
  for (const [index, call] of record.calls.entries()) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) throw new ObservationRejected(`calls[${index}] is not a call`);
    for (const key of Object.keys(call as Record<string, unknown>)) {
      if (!CALL_KEYS.includes(key)) throw new ObservationRejected(`calls[${index}] holds a field that is not part of the call schema`);
    }
    const { tool, result } = call as { tool?: unknown; result?: unknown };
    if (typeof tool !== 'string' || result === undefined) throw new ObservationRejected(`calls[${index}] needs a tool name and its result`);
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
    if (Buffer.byteLength(resultText, 'utf8') > MCP_RESULT_MAX_BYTES) {
      throw new ObservationRejected(`calls[${index}] result is larger than the ${MCP_RESULT_MAX_BYTES}-byte limit`);
    }
    const short = shortToolName(tool);
    if (NEVER_CALL_MCP_TOOLS.includes(short)) {
      throw new ObservationRejected(
        `calls[${index}] is ${short}: c2c never calls the MCP project tools — they return project secrets into the transcript; the doctor lists projects through the Catalyst CLI. Run c2c doctor --mcp-begin again and send only the calls it names`,
      );
    }
    if (short === shortToolName(ORGS_CALL)) {
      const listed = idsOfResult(result, ORGS_CALL);
      orgs = listed.ids;
      orgDcs = listed.orgDcs;
    } else if (short === shortToolName(PROBE_CALL) || short === shortToolName(PROBE_DELETE_CALL) || short === shortToolName(PROBE_OBJECT_CALL)) {
      // The probe write, the nonce-object signature, and the cleanup delete
      // are attested by the doctor's own REST read-back, never by this
      // result: it is checked for an error envelope and digested. The
      // signature call may be omitted — the object list is the proof. A
      // repeated run reuses the one probe bucket per project, so an
      // already-exists answer to the re-create is accepted for the probe
      // write only (never for the signature call or the cleanup delete).
      try {
        rejectIfErrorFlag(result, short);
      } catch (err) {
        const alreadyExists = short === shortToolName(PROBE_CALL) && isAlreadyExistsResult(result);
        if (alreadyExists) probeAlreadyExisted = true;
        if (!alreadyExists) {
          if (isStratusFirstUseResult(result)) {
            throw new ObservationRejected(
              `the ${short} call was refused with OPERATION_NOT_ALLOWED — "in session when accessing Stratus" means this project has never opened Stratus and no retry helps: in the Catalyst console open the project → Cloud Scale → Stratus → Start Exploring, then on Create your First Bucket create one bucket (any name) and wait until it shows in the bucket list (click Create again if nothing happens after a few seconds); then run c2c doctor --mcp-begin again and repeat the calls`,
            );
          }
          throw err;
        }
      }
    } else throw new ObservationRejected(`calls[${index}] is not a call the MCP request asked for`);
    calls.push({ tool: short, digest: resultDigest(result) });
  }
  if (!orgs) throw new ObservationRejected(`the observation has no ${ORGS_CALL} result`);
  if (!calls.some((call) => call.tool === shortToolName(PROBE_CALL))) {
    throw new ObservationRejected(`the observation has no ${PROBE_CALL} result; run c2c doctor --mcp-begin and make every call it names`);
  }

  // The session facts go through the evidence validator (no URL path, no email, Catalyst tool names only).
  const session: Record<string, unknown> = {};
  for (const key of PASSTHROUGH) if (record[key] !== undefined) session[key] = record[key];
  const evidence = parseEvidence(JSON.stringify(session));
  evidence.orgs = orgs;
  if (Object.keys(orgDcs).length) evidence.orgDcs = orgDcs;
  evidence.at = now.toISOString();
  evidence.workspace = input.workspace;
  // The bucket --mcp-begin named, this run's nonce and the scope it ran
  // under, all pinned in the authenticated request file: the read-back, the
  // drift check and the cleanup track what was actually begun, even if the
  // scope flags drifted since the begin run.
  // Created by this run: the signed begin-time list did not show the bucket
  // and the session's create did not answer already-exists. Only then may
  // the cleanup delete the bucket; anything else leaves it alone.
  const createdThisRun = open.bucketBefore === 'absent' && !probeAlreadyExisted;
  return { evidence, observed: { request: open.request, orgs, calls }, probe: open.probe, nonce: open.nonce, scope: open.scope, createdThisRun };
}

/** What the agent is asked to do, for the --mcp-begin output. */
export function mcpRequestInstructions(request: McpRequest, target: ProbeTarget = {}): { request: string; expires: string; probe: string; nonce?: string; calls: Record<string, unknown>[]; cleanup: Record<string, unknown>; objectCleanup?: ProbeNonceCleanup; neverCall: string[]; command: string; observation: Record<string, unknown> } {
  // The pinned bucket and nonce from the authenticated request this begin
  // opened; no fallback — a request file without them is refused on read.
  const probe = request.probe;
  const nonce = request.nonce;
  const project = target.project !== undefined && /^[0-9]+$/.test(target.project) ? target.project : undefined;
  const calls: Record<string, unknown>[] = [probeCreateCall(probe, target)];
  // Org-only begin has no project to put an object in, so it stays the two
  // calls. A numeric project asks for the nonce object between the bucket
  // and the org list. The observation template still shows the two required
  // calls: the signature result is allowed and not required.
  if (project) calls.push(probeObjectCall(probe, nonce, target));
  calls.push({ tool: ORGS_CALL });
  const objectCleanup = project ? probeNonceCleanup(probe, nonce, project) : undefined;
  return {
    request: request.request,
    expires: new Date(Date.parse(request.at) + MCP_REQUEST_MAX_AGE_MS).toISOString(),
    probe,
    nonce,
    calls,
    cleanup: probeDeleteCall(probe, target),
    ...(objectCleanup ? { objectCleanup } : {}),
    neverCall: NEVER_CALL_MCP_TOOLS.map((name) => `CatalystbyZoho_${name}`),
    command: 'c2c doctor --mcp-observed -',
    observation: {
      kind: OBSERVATION_KIND,
      schema: OBSERVATION_SCHEMA,
      request: request.request,
      server: '<the Catalyst MCP server name>',
      host_of_url: '<the host of its URL, no path; omit for stdio/local>',
      transport: 'http, stdio, or local',
      shape: '<meta or direct>',
      tools: ['<every Catalyst tool name the session lists>'],
      schemas: { '<each Catalyst tool name the session lists>': { path_variables: ['<its input schema path variable names>'], body: ['<its input schema body field names>'] } },
      calls: [
        { tool: PROBE_CALL, result: '<the call result, verbatim>' },
        { tool: ORGS_CALL, result: '<the call result, verbatim>' },
      ],
    },
  };
}
