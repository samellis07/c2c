/**
 * Shared types for `c2c doctor` and the exit-5 gate.
 * Check catalogue: plugin/references/doctor-spec.md.
 */

/** One catalogue line. `detail` is recorded in doctor.json; `screen` is shown only. */
export interface CheckResult {
  id: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  /** One line, safe to persist: no email, no token, no URL path. */
  detail: string;
  /** Shown on screen instead of detail when present (a masked account at most, never a full email; never written). */
  screen?: string;
  /** The exact fix the USER runs, or null. Doctor never runs a fix. */
  fix: string | null;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<SpawnResult>;

export interface DoctorIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  /** Standard input, for `--mcp-observed -`. */
  stdin?: () => string;
  /** A one-way tag of the token in the Catalyst CLI credential store, read without a refresh; undefined when none is fresh. */
  tokenTag?: () => Promise<string | undefined>;
  /** Forces one Catalyst CLI token refresh (nothing is kept). Used only with C2C_ALLOW_LOCAL_REFRESH=1. */
  refreshToken?: (org?: string) => Promise<unknown>;
}

export type { ResolvedScopeValues as ResolvedScope } from './scope.js';

/** doctor.json persisted shape (no emails, no tokens, no URL paths). */
export interface DoctorFile {
  c2c: string;
  at: string;
  host: string;
  scope: { dc?: string; org?: string; project?: string; app?: string };
  checks: CheckResult[];
  mcp?: {
    server?: string;
    shape?: string;
    host?: string;
    transport?: string;
    tools?: string[];
    schemaDigest?: Record<string, string>;
    /** The dc/org/project this record was validated for; the gate binds to it. */
    scope?: { dc?: string; org?: string; project?: string };
    /** Evidence `at` time: when the agent collected the D-B record. */
    at?: string;
    /** `observed`: derived from MCP calls made in the user's session; `operator`: a supplied file. */
    source?: 'observed' | 'operator';
    /** The observed calls this record was derived from: the request id, the org/project ids and each result's digest. */
    observed?: { request: string; orgs: string[]; projects?: string[]; calls: { tool: string; digest: string }[] };
  };
  /** Spec items reported but not yet checked (id + reason); printed as NOTE lines. */
  deferred?: { id: string; reason: string }[];
  green: boolean;
}
