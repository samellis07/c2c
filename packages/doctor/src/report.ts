/**
 * doctor.json: where it lives, how it merges, and the c2c version stamp.
 * `c2c-out/.c2c/doctor.json` under the workspace (cwd, or C2C_WORKSPACE — the
 * same place bin/c2c writes its vendor-ok marker). Holds no emails, no tokens,
 * no URL paths.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DoctorFile } from './types.js';

export function workspaceDir(env: NodeJS.ProcessEnv): string {
  const named = env.C2C_WORKSPACE;
  return typeof named === 'string' && named.trim() !== '' ? named : process.cwd();
}

export function doctorJsonPath(workspace: string): string {
  return join(workspace, 'c2c-out', '.c2c', 'doctor.json');
}

let cachedVersion: string | undefined;

/** The converter version: the package.json beside the built dist (repo root or vendor/c2c). */
export function c2cVersion(): string {
  if (cachedVersion) return cachedVersion;
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      cachedVersion = parsed.version.trim();
      return cachedVersion;
    }
  } catch {
    /* fall through */
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

/** The last doctor.json in this workspace, or undefined. Never throws. */
export function readDoctorFile(workspace: string): DoctorFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(doctorJsonPath(workspace), 'utf8')) as DoctorFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.green !== 'boolean' || !Array.isArray(parsed.checks)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Merge this run into any earlier doctor.json: the mcp D-B record and any
 * scope fields this run could not resolve are preserved, so a `doctor` re-run
 * cannot wipe a still-valid MCP record — but only inside the same scope.
 * A changed dc invalidates the earlier org/project; a changed org invalidates
 * the earlier project. The mcp record survives only when the scope it was
 * bound to equals the merged scope exactly; a record from another dc/org/
 * project is stale evidence and is dropped (the gate then reports no-mcp).
 * A record with no bound scope predates scope binding; it is never kept.
 */
export function mergeDoctorFile(previous: DoctorFile | undefined, next: DoctorFile): DoctorFile {
  if (!previous) return next;
  const prev = previous.scope ?? {};
  const nxt = next.scope ?? {};
  const scope = { ...prev };
  for (const key of ['dc', 'org', 'project', 'app'] as const) {
    if (nxt[key] !== undefined) scope[key] = nxt[key];
  }
  if (prev.dc !== undefined && nxt.dc !== undefined && prev.dc !== nxt.dc) {
    if (nxt.org === undefined) delete scope.org;
    if (nxt.project === undefined) delete scope.project;
  }
  if (prev.org !== undefined && nxt.org !== undefined && prev.org !== nxt.org) {
    if (nxt.project === undefined) delete scope.project;
  }
  const bound = previous.mcp?.scope;
  const keepMcp =
    !next.mcp &&
    previous.mcp !== undefined &&
    typeof bound === 'object' &&
    bound !== null &&
    (['dc', 'org', 'project'] as const).every((key) => bound[key] === scope[key]);
  return {
    ...next,
    scope,
    ...(next.mcp ? { mcp: next.mcp } : keepMcp ? { mcp: previous.mcp } : {}),
  };
}

export function writeDoctorFile(workspace: string, file: DoctorFile): string {
  const path = doctorJsonPath(workspace);
  const merged = mergeDoctorFile(readDoctorFile(workspace), file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return path;
}

/** Best-effort host id for doctor.json.host; the agent evidence overrides it. */
export function detectHost(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.CODEX_HOME || env.CODEX_SANDBOX) return 'codex';
  if (env.TERM_PROGRAM === 'cursor' || env.CURSOR_TRACE_DIR) return 'cursor';
  return 'unknown';
}
