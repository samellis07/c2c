/**
 * The plugin's MCP evidence path. The CLI cannot see the host's MCP session,
 * so the evidence comes from calls the agent makes there, under the host's
 * normal per-call approval:
 *
 *   1. `c2c doctor --mcp-begin` opens a one-time request
 *      (`c2c-out/.c2c/mcp-request.json`: a random id and when it was issued)
 *      and prints the calls to make;
 *   2. the agent calls `CatalystbyZoho_List_All_Organizations` in the
 *      session — never the MCP project tools, which return project secrets
 *      (the doctor lists projects through the Catalyst CLI, D-C4);
 *   3. the agent pipes an observation — the request id, the session's
 *      Catalyst server/host/tool names, and each call's verbatim result — into
 *      `c2c doctor --mcp-observed -`.
 *
 * The doctor derives the org ids from the call results itself, stamps
 * `at` and the workspace itself, and records a sha256 digest of each result.
 * Raw results are never written anywhere: only ids and digests are kept. An
 * observation that names its own orgs/projects/at/workspace, answers a request
 * this workspace did not issue (or already used), or arrives after the request
 * expired is refused. A free-standing evidence file is operator-only
 * (`--record-mcp <file> --operator`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EvidenceRejected, EvidenceStale, entryIdOf, parseEvidence, shortToolName, type McpEvidence } from './evidence.js';
import { NEVER_CALL_MCP_TOOLS } from './required-tools.js';

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

/** Fields the agent reports from its session; everything else is derived or refused. */
const PASSTHROUGH = ['host', 'server', 'host_of_url', 'transport', 'shape', 'features', 'tools', 'schemas', 'catalyst_skills_visible', 'servers', 'tables', 'orgTableCount'];
/** Fields only the doctor writes. A caller that supplies one has edited the observation. */
const DERIVED = ['orgs', 'projects', 'at', 'workspace'];
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

/** Open (or replace) this workspace's one-time request. */
export function beginMcpRequest(workspace: string, now: Date = new Date()): McpRequest {
  const request: McpRequest = { schema: OBSERVATION_SCHEMA, request: randomBytes(16).toString('hex'), at: now.toISOString() };
  const path = mcpRequestPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  for (const stale of readdirSync(dirname(path))) {
    if (/^mcp-request\.[0-9a-f]+\.closed$/.test(stale)) rmSync(join(dirname(path), stale), { force: true });
  }
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

function readMcpRequest(workspace: string): McpRequest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(mcpRequestPath(workspace), 'utf8')) as Partial<McpRequest>;
    if (typeof parsed.request === 'string' && /^[0-9a-f]{32}$/.test(parsed.request) && typeof parsed.at === 'string') {
      return { schema: Number(parsed.schema), request: parsed.request, at: parsed.at };
    }
  } catch {
    /* no open request */
  }
  return undefined;
}

/**
 * Close the request once its observation was accepted: an observation answers
 * exactly one request. The closed marker is created exclusively, so two
 * observations racing for one request cannot both win — the loser is refused.
 */
export function closeMcpRequest(workspace: string, request: string): void {
  try {
    writeFileSync(join(dirname(mcpRequestPath(workspace)), `mcp-request.${request}.closed`), `${request}\n`, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ObservationRejected('the MCP request was already answered; run c2c doctor --mcp-begin again');
    }
    throw err;
  }
  // Drop the open file only while it still names this request.
  if (readMcpRequest(workspace)?.request === request) rmSync(mcpRequestPath(workspace), { force: true });
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

/** The decimal ids a list call's verbatim result names; nothing else in the result is kept. */
function idsOfResult(result: unknown, tool: string): string[] {
  // The envelope checks in payloadOf only see the top object: scan the whole
  // result first, so a flag in a later block, entry or list is still refused.
  rejectIfErrorFlag(result, tool);
  const entries = entriesOf(payloadOf(result, tool));
  if (!entries) throw new ObservationRejected(`the ${tool} result holds no list of entries`);
  const ids: string[] = [];
  for (const entry of entries) {
    const id = entryIdOf(entry);
    if (id === undefined) throw new EvidenceStale(`the ${tool} result holds an entry with no decimal id`);
    ids.push(id);
  }
  return ids;
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
export function parseObservation(text: string, input: { workspace: string; now?: Date }): { evidence: McpEvidence; observed: Observed } {
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

  const open = readMcpRequest(input.workspace);
  if (!open) throw new ObservationRejected('there is no open MCP request in this workspace; run c2c doctor --mcp-begin first');
  if (typeof record.request !== 'string' || record.request !== open.request) {
    throw new ObservationRejected('the observation answers a request this workspace did not issue; run c2c doctor --mcp-begin again');
  }
  const age = now.getTime() - Date.parse(open.at);
  if (!Number.isFinite(age) || age < 0 || age > MCP_REQUEST_MAX_AGE_MS) throw new EvidenceStale('the MCP request expired before the observation arrived');

  if (!Array.isArray(record.calls)) throw new ObservationRejected('the observation has no calls list');
  const calls: ObservedCall[] = [];
  let orgs: string[] | undefined;
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
        `calls[${index}] is ${short}: c2c never calls the MCP project tools — they return project secrets into the transcript; the doctor lists projects through the Catalyst CLI. Run c2c doctor --mcp-begin again and send only ${ORGS_CALL}`,
      );
    }
    if (short === shortToolName(ORGS_CALL)) orgs = idsOfResult(result, ORGS_CALL);
    else throw new ObservationRejected(`calls[${index}] is not a call the MCP request asked for`);
    calls.push({ tool: short, digest: resultDigest(result) });
  }
  if (!orgs) throw new ObservationRejected(`the observation has no ${ORGS_CALL} result`);

  // The session facts go through the evidence validator (no URL path, no email, Catalyst tool names only).
  const session: Record<string, unknown> = {};
  for (const key of PASSTHROUGH) if (record[key] !== undefined) session[key] = record[key];
  const evidence = parseEvidence(JSON.stringify(session));
  evidence.orgs = orgs;
  evidence.at = now.toISOString();
  evidence.workspace = input.workspace;
  return { evidence, observed: { request: open.request, orgs, calls } };
}

/** What the agent is asked to do, for the --mcp-begin output. */
export function mcpRequestInstructions(request: McpRequest): { request: string; expires: string; calls: string[]; neverCall: string[]; command: string; observation: Record<string, unknown> } {
  return {
    request: request.request,
    expires: new Date(Date.parse(request.at) + MCP_REQUEST_MAX_AGE_MS).toISOString(),
    calls: [ORGS_CALL],
    neverCall: NEVER_CALL_MCP_TOOLS.map((name) => `CatalystbyZoho_${name}`),
    command: 'c2c doctor --mcp-observed -',
    observation: {
      kind: OBSERVATION_KIND,
      schema: OBSERVATION_SCHEMA,
      request: request.request,
      server: '<the Catalyst MCP server name>',
      host_of_url: '<the host of its URL, no path>',
      transport: 'http',
      shape: '<meta or direct>',
      tools: ['<every Catalyst tool name the session lists>'],
      calls: [{ tool: ORGS_CALL, result: '<the call result, verbatim>' }],
    },
  };
}
