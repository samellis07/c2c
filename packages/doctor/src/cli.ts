/**
 * `c2c doctor` argument handling and output. Read-only by contract:
 * the only writes are `c2c-out/.c2c/doctor.json`, the one-time
 * `c2c-out/.c2c/mcp-request.json` and its `mcp-request.<id>.closed` marker
 * (plus the D-E4 probe).
 *
 *   c2c doctor [--app <ds>] [--dc <dc>] [--org <id>] [--project <id>] [--json]
 *   c2c doctor --mcp-begin           open a one-time request for the MCP calls to observe
 *   c2c doctor --mcp-observed -      record evidence from the observed call results (stdin), then the D-B and D-V checks
 *   c2c doctor --record-mcp <file> --operator   operator-only: merge a supplied evidence file
 *   c2c doctor --local --quiet       SessionStart hook: local checks only, no output
 *   c2c --verify-vendor <dir>        vendor manifest check for bin/c2c (exit 0 or 6)
 *
 * Exit 0 green, 1 a FAIL check or rejected/stale evidence, 2 usage or a missing evidence file, 6 Node/vendor integrity.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { runDoctorChecks, type DoctorContext } from './checks.js';
import { listCatalystProjects, peekCliTokenTag, refreshCliAccessToken } from '../../deploy/src/rest.js';
import { EvidenceRejected, EvidenceStale, mcpRecord, parseEvidence, type McpEvidence } from './evidence.js';
import { beginMcpRequest, closeMcpRequest, mcpRequestInstructions, parseObservation, readStdinBounded, type Observed } from './observed.js';
import { clearPendingCleanup, probeDeleteCall, probeNameOf, readPendingCleanups, verifyProbe, writePendingCleanup, type ProbeTarget } from './mcp-probe.js';
import { catalystRestCall } from '../../deploy/src/rest.js';
import { c2cVersion, detectHost, workspaceDir, writeDoctorFile } from './report.js';
import { cliStoreHooks, resolveScope, type ScopeHooks } from './scope.js';
import { verifyVendorDir } from './vendor.js';
import { readRegularFile } from './read-file.js';
import { isDirectoryPath, listDsFiles } from '../../core/src/index.js';
import { GATE_EXIT, carriedMcpRecord, doctorStamp, evaluateGate, gateRefusalMessage, type GateScope } from './gate.js';
import type { CheckResult, DoctorFile, DoctorIo, SpawnResult } from './types.js';

export function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

const USAGE =
  'usage: c2c doctor [--app <file.ds|dir>] [--dc <dc>] [--org <id>] [--project <id>] [--config <file>] [--creator-dc <dc|host>] [--source-csv <dir>] [--ui vanilla|react] [--json] [--local] [--quiet]\n' +
  '       c2c doctor --mcp-begin [--json]\n' +
  '       c2c doctor --mcp-observed - [scope flags]\n' +
  '       c2c doctor --record-mcp <file> --operator   (operator-only)\n' +
  '       c2c --verify-vendor <dir>\n';

/** One spawn with a deadline; a killed child reports as code 124. */
export function doctorSpawn(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Not spawn's own `timeout` option: that timer stays armed after an ENOENT
    // and keeps the event loop alive. Our timer is unref'd and cleared.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 20_000);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ code: 124, stdout, stderr: `${stderr}\ntimed out` });
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function defaultDoctorIo(): DoctorIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    spawn: doctorSpawn,
    stdin: () => readStdinBounded(),
    tokenTag: () => peekCliTokenTag(process.env),
    refreshToken: async (org) => {
      await refreshCliAccessToken(process.env, org);
    },
    // The org list for D-F7 (project_type/created_time only — the raw listing carries other projects' secrets).
    listProjects: (org) => listCatalystProjects(process.env, org),
  };
}

interface DoctorArgs {
  app?: string;
  dc?: string;
  org?: string;
  project?: string;
  config?: string;
  creatorDc?: string;
  sourceCsv?: string;
  ui?: string;
  recordMcp?: string;
  mcpObserved?: string;
  mcpBegin: boolean;
  operator: boolean;
  json: boolean;
  local: boolean;
  quiet: boolean;
}

function parseArgs(args: readonly string[], io: DoctorIo): DoctorArgs | 'usage' {
  const known = new Set(['--app', '--dc', '--org', '--project', '--config', '--creator-dc', '--creator-host', '--source-csv', '--ui', '--record-mcp', '--mcp-observed', '--mcp-begin', '--operator', '--json', '--local', '--quiet']);
  for (const arg of args) {
    if (arg.startsWith('--') && !known.has(arg)) {
      io.stderr(`c2c doctor: unknown flag ${arg}\n${USAGE}`);
      return 'usage';
    }
  }
  if (args.includes('--record-mcp') && flag(args, '--record-mcp') === undefined) {
    io.stderr(`c2c doctor: --record-mcp needs an evidence file\n${USAGE}`);
    return 'usage';
  }
  const ui = flag(args, '--ui');
  if (ui !== undefined && ui !== 'vanilla' && ui !== 'react') {
    io.stderr(`c2c doctor: --ui must be vanilla or react\n${USAGE}`);
    return 'usage';
  }
  return {
    ...(flag(args, '--app') !== undefined ? { app: flag(args, '--app') } : {}),
    ...(flag(args, '--dc') !== undefined ? { dc: flag(args, '--dc') } : {}),
    ...(flag(args, '--org') !== undefined ? { org: flag(args, '--org') } : {}),
    ...(flag(args, '--project') !== undefined ? { project: flag(args, '--project') } : {}),
    ...(flag(args, '--config') !== undefined ? { config: flag(args, '--config') } : {}),
    ...(flag(args, '--creator-dc') !== undefined ? { creatorDc: flag(args, '--creator-dc') } : {}),
    ...(flag(args, '--creator-host') !== undefined ? { creatorDc: flag(args, '--creator-host') } : {}),
    ...(flag(args, '--source-csv') !== undefined ? { sourceCsv: flag(args, '--source-csv') } : {}),
    ...(ui !== undefined ? { ui } : {}),
    ...(flag(args, '--record-mcp') !== undefined ? { recordMcp: flag(args, '--record-mcp') } : {}),
    // `-` (stdin) is the only value the skill passes; flag() would read it as a value too.
    ...(args.includes('--mcp-observed') ? { mcpObserved: args[args.indexOf('--mcp-observed') + 1] ?? '' } : {}),
    mcpBegin: args.includes('--mcp-begin'),
    operator: args.includes('--operator'),
    json: args.includes('--json'),
    local: args.includes('--local'),
    quiet: args.includes('--quiet'),
  };
}

function formatTable(checks: CheckResult[], file: DoctorFile): string {
  const lines = [`c2c doctor ${file.c2c} — scope ${file.scope.dc ?? '?'}/${file.scope.org ?? '?'}/${file.scope.project ?? '?'}`];
  for (const c of checks) {
    const label = c.status.toUpperCase().padEnd(4);
    lines.push(`${label} ${c.id}  ${c.screen ?? c.detail}`);
    if (c.fix) lines.push(`     fix: ${c.fix}`);
  }
  for (const d of file.deferred ?? []) {
    lines.push(`NOTE ${d.id}: deferred — ${d.reason}`);
  }
  lines.push(`doctor: ${file.green ? 'green' : 'red'}`);
  return `${lines.join('\n')}\n`;
}

async function doctorMain(parsed: DoctorArgs, io: DoctorIo, hooks?: ScopeHooks): Promise<number> {
  const workspace = workspaceDir(io.env);
  const cliHooks = hooks ?? cliStoreHooks(io.env);
  let scope;
  try {
    scope = resolveScope({
      cwd: workspace,
      ...(parsed.app !== undefined ? { appPath: parsed.app } : {}),
      flags: {
        ...(parsed.dc !== undefined ? { dc: parsed.dc } : {}),
        ...(parsed.org !== undefined ? { org: parsed.org } : {}),
        ...(parsed.project !== undefined ? { project: parsed.project } : {}),
        ...(parsed.config !== undefined ? { config: parsed.config } : {}),
        ...(parsed.creatorDc !== undefined ? { creatorDc: parsed.creatorDc } : {}),
        ...(parsed.ui !== undefined ? { ui: parsed.ui } : {}),
      },
      hooks: cliHooks,
    });
  } catch (err) {
    io.stderr(`c2c doctor: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  // The app's own link name (the .ds `application` name or the file name) for
  // scope.app. A directory target names its single .ds when there is one.
  if (!scope.app && parsed.app) {
    let named = parsed.app;
    if (isDirectoryPath(named)) {
      const ds = listDsFiles(named);
      if (ds.length === 1) named = ds[0]!;
    }
    scope.app = basename(named).replace(/\.ds$/i, '');
  }
  const probeTarget: ProbeTarget = {
    ...(scope.org !== undefined ? { org: scope.org } : {}),
    ...(scope.project !== undefined ? { project: scope.project } : {}),
  };

  if (parsed.mcpBegin) {
    const request = beginMcpRequest(workspace);
    const ask = mcpRequestInstructions(request, probeTarget);
    const pending = readPendingCleanups(workspace);
    if (parsed.json) {
      io.stdout(`${JSON.stringify({ ...ask, ...(pending.length ? { pendingCleanup: pending.map((p) => probeDeleteCall(p.name, p)) } : {}) }, null, 2)}\n`);
    } else {
      const callLines = ask.calls.map((call) => `   ${JSON.stringify(call)}`).join('\n');
      io.stdout(
        `MCP request ${ask.request} (answer before ${ask.expires})\n` +
          `1. In this session, make these calls; approve each call when asked. Never call ${ask.neverCall.join(' or ')}: they return project secrets into the transcript, and the doctor lists projects through the Catalyst CLI.\n${callLines}\n` +
          `   The first call writes a short-lived probe bucket (${ask.probe}) the doctor reads back over the Catalyst REST API with your CLI credential — the echoed nonce alone proves nothing.\n` +
          `2. Pipe the observation — this request id, the Catalyst server, host and tool names the session lists, and each call's result verbatim — into:\n` +
          `   ${ask.command}\n` +
          `${JSON.stringify(ask.observation, null, 2)}\n` +
          `3. Afterwards remove the probe bucket: call ${JSON.stringify(ask.cleanup)}\n` +
          pending.map((p) => `cleanup still pending from an earlier run: call ${JSON.stringify(probeDeleteCall(p.name, p))}\n`).join(''),
      );
    }
    return 0;
  }

  let evidence: McpEvidence | undefined;
  let origin: { source: 'observed'; observed: Observed } | { source: 'operator' } | undefined;
  if (parsed.mcpObserved !== undefined) {
    if (parsed.mcpObserved !== '-' || !io.stdin) {
      io.stderr(`c2c doctor: --mcp-observed reads the observation from standard input only: --mcp-observed -\n${USAGE}`);
      return 2;
    }
    try {
      const result = parseObservation(io.stdin(), { workspace });
      evidence = result.evidence;
      origin = { source: 'observed', observed: result.observed };
      // A --local run persists nothing, so it must not consume the request;
      // the run that writes doctor.json closes it first (fail closed), atomically.
      if (!parsed.local) {
        // The submitted results are caller-controlled: the binding is the
        // doctor's own REST read-back of the probe bucket, not the echoed
        // nonce. Runs before closeMcpRequest so a rejected observation can
        // never consume the request (parse already threw by this point).
        const probe = probeNameOf(result.observed.request);
        const rest = io.rest ?? ((call: { method: 'GET' | 'POST'; path: string }) => catalystRestCall(io.env, probeTarget.org ?? '', probeTarget.project ?? '', call));
        const binding = await verifyProbe(rest, probeTarget, probe);
        evidence.binding = binding;
        if (binding.status === 'absent') clearPendingCleanup(workspace, probe);
        else writePendingCleanup(workspace, probe, probeTarget);
        // Earlier runs' probes owe a delete too: each is re-checked and its
        // reminder drops only once the read-back shows it is actually gone.
        for (const pending of readPendingCleanups(workspace)) {
          if (pending.name === probe || !pending.project || !/^[0-9]+$/.test(pending.project)) continue;
          const leftover = await verifyProbe(rest, pending, pending.name);
          if (leftover.status === 'absent') clearPendingCleanup(workspace, pending.name);
        }
        closeMcpRequest(workspace, result.observed.request);
      }
    } catch (err) {
      if (err instanceof EvidenceStale) {
        io.stderr(`c2c doctor: ${err.message}\n`);
        return 1;
      }
      if (err instanceof EvidenceRejected) {
        io.stderr(`c2c doctor: observation rejected: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  } else if (parsed.recordMcp !== undefined && !parsed.operator) {
    io.stderr(
      'c2c doctor: --record-mcp reads a supplied evidence file and is operator-only (add --operator).\n' +
        'The plugin records MCP evidence from calls made in this session: run c2c doctor --mcp-begin, make the calls it names, then pipe the results into c2c doctor --mcp-observed -\n',
    );
    return 2;
  }
  if (parsed.recordMcp !== undefined && parsed.operator && evidence === undefined) {
    origin = { source: 'operator' };
    // One open classifies and reads the file: absent, a directory or a FIFO is "no such evidence file".
    const read = readRegularFile(parsed.recordMcp);
    if (read.kind !== 'file') {
      io.stderr(`c2c doctor: no such evidence file: ${parsed.recordMcp}\n`);
      return 2;
    }
    try {
      evidence = parseEvidence(read.bytes.toString('utf8'));
    } catch (err) {
      if (err instanceof EvidenceStale) {
        io.stderr(`c2c doctor: ${err.message}\n`);
        return 1;
      }
      if (err instanceof EvidenceRejected) {
        io.stderr(`c2c doctor: evidence rejected: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }

  // No evidence this run: carry the last MCP record for this exact scope, so
  // doctor and the gate read the same D-B rows and agree on the verdict.
  const carried = evidence === undefined ? carriedMcpRecord({ workspace, scope: { dc: scope.dc, org: scope.org, project: scope.project } }) : undefined;
  const ctx: DoctorContext = {
    io,
    workspace,
    scope,
    ...(parsed.app !== undefined ? { appPath: parsed.app } : {}),
    ...(parsed.sourceCsv !== undefined ? { sourceCsv: parsed.sourceCsv } : {}),
    local: parsed.local,
    ...(evidence ? { evidence } : {}),
    ...(origin ? { evidenceSource: origin.source } : {}),
    ...(carried ? { carried: { checks: carried.checks, at: carried.mcp.at ?? '' } } : {}),
    cliDc: cliHooks.cliDc,
    cliOrg: cliHooks.cliOrg,
  };
  const run = await runDoctorChecks(ctx);
  const appName = run.ir?.name ?? scope.app;
  const file: DoctorFile = {
    c2c: c2cVersion(),
    at: new Date().toISOString(),
    host: evidence?.host ?? detectHost(io.env),
    scope: {
      ...(run.scope.dc !== undefined ? { dc: run.scope.dc } : {}),
      ...(run.scope.org !== undefined ? { org: run.scope.org } : {}),
      ...(run.scope.project !== undefined ? { project: run.scope.project } : {}),
      ...(appName !== undefined ? { app: appName } : {}),
    },
    checks: run.checks.map(({ id, status, detail, fix }) => ({ id, status, detail, fix })),
    ...(evidence ? { mcp: mcpRecord(evidence, { dc: run.scope.dc, org: run.scope.org, project: run.scope.project }, origin) } : carried ? { mcp: carried.mcp } : {}),
    deferred: run.deferred,
    green: run.green,
  };
  // A --local hook run never persists: it skipped the account/network checks,
  // so it must not refresh `at` or turn a red doctor green for the gate.
  const path = parsed.local ? undefined : writeDoctorFile(workspace, file);
  if (!parsed.quiet) {
    if (parsed.json) {
      io.stdout(`${JSON.stringify({ ...file, ...(path ? { doctorJson: path } : {}) }, null, 2)}\n`);
    } else {
      io.stdout(formatTable(run.checks, file));
      if (carried) io.stdout(`D-B/D-V: from the MCP observation recorded at ${carried.mcp.at}; run c2c doctor --mcp-begin to record a new one\n`);
      if (path) io.stdout(`doctor.json: ${path}\n`);
      else io.stdout('(local run; doctor.json not updated)\n');
    }
    // Cleanup always runs: while a probe bucket may exist, the delete call is
    // re-printed on every run (each pending record clears only when a REST
    // read-back confirms that bucket is gone).
    for (const pending of readPendingCleanups(workspace)) {
      io.stdout(`cleanup: remove the probe bucket ${pending.name} — in this session call ${JSON.stringify(probeDeleteCall(pending.name, pending))}\n`);
    }
  }
  if (run.integrityFailed) return 6;
  return run.green ? 0 : 1;
}

export async function doctorCli(args: readonly string[], io: DoctorIo, opts?: { hooks?: ScopeHooks }): Promise<number> {
  const parsed = parseArgs(args, io);
  if (parsed === 'usage') return 2;
  return doctorMain(parsed, io, opts?.hooks);
}

/** `c2c --verify-vendor <dir>` — the bin/c2c integrity step. Exit 0 ok, 6 mismatch. */
export function verifyVendorCli(args: readonly string[], io: DoctorIo): number {
  const dir = args[0] && !args[0].startsWith('--') ? args[0] : flag(args, '--verify-vendor') ?? args[1];
  if (!dir || args.length > 2) {
    io.stderr(USAGE);
    return 2;
  }
  const verdict = verifyVendorDir(dir);
  if (verdict.error) {
    io.stderr(`c2c: ${verdict.error}\n`);
    return 6;
  }
  if (!verdict.ok) {
    io.stderr(`c2c: the c2c plugin files were modified or are incomplete (${verdict.mismatched.length} files differ). Reinstall the plugin.\n`);
    return 6;
  }
  return 0;
}

const VALUE_FLAGS = new Set(['--app', '--dc', '--org', '--project', '--config', '--creator-dc', '--creator-host', '--source-csv', '--ui', '--record-mcp', '--mcp-observed', '--env']);

/** First non-flag positional, skipping flag values. */
export function positionalOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

/**
 * The gate for live verbs, evaluated before dispatch in c2c.ts.
 * `args` is everything after the verb (the positional .ds target is ignored).
 * Returns the verdict; the caller prints gateRefusalMessage and exits 5.
 */
export function doctorGateForArgs(args: readonly string[], input: { cwd: string; env: NodeJS.ProcessEnv; now?: Date; createsProject?: boolean }) {
  const hooks = cliStoreHooks(input.env);
  let scope: GateScope = {};
  // A project registry file (--projects) is also a dc/org source for deploy.
  const extra: { dc: { origin: string; value: string | undefined }[]; org: { origin: string; value: string | undefined }[] } = { dc: [], org: [] };
  const projectsFile = flag(args, '--projects');
  if (projectsFile !== undefined) {
    try {
      const registry = JSON.parse(readFileSync(projectsFile, 'utf8')) as { dc?: unknown; org?: unknown };
      extra.dc.push({ origin: projectsFile, value: typeof registry.dc === 'string' ? registry.dc : undefined });
      extra.org.push({
        origin: projectsFile,
        value: typeof registry.org === 'string' ? registry.org : typeof registry.org === 'number' && Number.isSafeInteger(registry.org) ? String(registry.org) : undefined,
      });
    } catch {
      /* an unreadable registry is the command's own problem */
    }
  }
  let scopeError: string | undefined;
  try {
    const resolved = resolveScope({
      cwd: input.cwd,
      appPath: positionalOf(args) ?? flag(args, '--app'),
      flags: {
        ...(flag(args, '--dc') !== undefined ? { dc: flag(args, '--dc') } : {}),
        ...(flag(args, '--org') !== undefined ? { org: flag(args, '--org') } : {}),
        ...(flag(args, '--project') !== undefined ? { project: flag(args, '--project') } : {}),
        ...(flag(args, '--config') !== undefined ? { config: flag(args, '--config') } : {}),
        ...(flag(args, '--app') !== undefined ? { app: flag(args, '--app') } : {}),
      },
      hooks,
      extraDc: extra.dc,
      extraOrg: extra.org,
    });
    scope = {
      ...(resolved.dc !== undefined ? { dc: resolved.dc } : {}),
      ...(resolved.org !== undefined ? { org: resolved.org } : {}),
      ...(resolved.project !== undefined ? { project: resolved.project } : {}),
    };
  } catch (err) {
    // Fail closed: a scope that cannot be resolved is a refusal, not a skipped
    // comparison. The raw flags still name the scope in the refusal line.
    scopeError = err instanceof Error ? err.message : String(err);
    scope = {
      ...(flag(args, '--dc') !== undefined ? { dc: flag(args, '--dc') } : {}),
      ...(flag(args, '--org') !== undefined ? { org: flag(args, '--org') } : {}),
      ...(flag(args, '--project') !== undefined ? { project: flag(args, '--project') } : {}),
    };
  }
  const verdict = evaluateGate({
    workspace: input.cwd,
    scope,
    ...(scopeError !== undefined ? { scopeError } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.createsProject ? { createsProject: true } : {}),
  });
  return { verdict, scope };
}

export { GATE_EXIT, doctorStamp, gateRefusalMessage };
