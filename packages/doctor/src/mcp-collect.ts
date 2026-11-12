/**
 * `c2c doctor --mcp-collect <results.json>`: turn the session's raw call
 * results into the observation file `--mcp-observed -` reads. The agent only
 * pastes what the session returned (server, host, tool list, call results);
 * the helper adds the request id and the schema fields, and refuses the
 * omissions that otherwise fail later (no host_of_url → D-B1 "no Catalyst MCP
 * server was recorded"; an incomplete tool list → D-B5). Offline: it makes no
 * call and records nothing itself.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ObservationRejected, OBSERVATION_KIND, OBSERVATION_MAX_BYTES, OBSERVATION_SCHEMA, mcpRequestPath, readMcpRequest } from './observed.js';
import { REQUIRED_MCP_TOOLS } from './required-tools.js';

export function mcpObservationPath(workspace: string): string {
  return join(dirname(mcpRequestPath(workspace)), 'mcp-observation.json');
}

export interface CollectResult {
  file: string;
  request: string;
  missingTools: string[];
}

const bare = (name: string): string => name.replace(/^.*?(CatalystbyZoho_)/, '$1').replace(/^CatalystbyZoho_/, '');

export function collectObservation(resultsFile: string, workspace: string, env: NodeJS.ProcessEnv): CollectResult {
  let raw: string;
  try {
    raw = readFileSync(resultsFile, 'utf8');
  } catch {
    throw new ObservationRejected(`cannot read ${resultsFile}: write the session results there (server, host_of_url, transport, shape, tools, calls) and run c2c doctor --mcp-collect <results.json> again with that path`);
  }
  if (Buffer.byteLength(raw, 'utf8') > OBSERVATION_MAX_BYTES) throw new ObservationRejected(`${resultsFile} is larger than the ${OBSERVATION_MAX_BYTES}-byte limit`);
  let results: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    results = parsed as Record<string, unknown>;
  } catch {
    throw new ObservationRejected(`${resultsFile} is not a JSON object`);
  }
  const request = readMcpRequest(workspace, env);
  if (!request) throw new ObservationRejected('no MCP request is open; run c2c doctor --mcp-begin first');
  if (typeof results.server !== 'string' || results.server === '') throw new ObservationRejected('the results have no server: name the Catalyst MCP server the session lists');
  const transport = typeof results.transport === 'string' ? results.transport : 'http';
  if (transport !== 'stdio' && transport !== 'local' && (typeof results.host_of_url !== 'string' || results.host_of_url === '')) {
    throw new ObservationRejected('the results have no host_of_url: record the host of the MCP server URL (no path) — without it the doctor fails D-B1 "no Catalyst MCP server was recorded"');
  }
  if (!Array.isArray(results.tools) || results.tools.length === 0) throw new ObservationRejected('the results have no tools: list every Catalyst tool name the session lists');
  if (!Array.isArray(results.calls) || results.calls.length === 0) throw new ObservationRejected('the results have no calls: add each call the request named with its result verbatim');
  const listed = new Set((results.tools as unknown[]).filter((t): t is string => typeof t === 'string').map(bare));
  const missingTools = REQUIRED_MCP_TOOLS.base.filter((name) => !listed.has(name));
  const observation = { ...results, kind: OBSERVATION_KIND, schema: OBSERVATION_SCHEMA, request: request.request };
  const file = mcpObservationPath(workspace);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(observation, null, 2)}\n`, { mode: 0o600 });
  return { file, request: request.request, missingTools };
}
