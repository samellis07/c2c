/**
 * `c2c doctor` argument handling and output. Read-only by contract:
 * the only writes are `c2c-out/.c2c/doctor.json`, the one-time
 * `c2c-out/.c2c/mcp-request.json` and its `mcp-request.<id>.closed` marker,
 * `c2c-out/.c2c/mcp-state.json` (the last accepted MCP evidence, signed and
 * reused by later runs for MCP_EVIDENCE_MAX_AGE_HOURS), the per-user signing
 * key outside the workspace (`~/.config/c2c/mcp-state.key`, created once)
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
import { scrubCatalystEnv } from '../../deploy/src/scope.js';
import { listCatalystProjects, peekCliTokenTag, refreshCliAccessToken } from '../../deploy/src/rest.js';
import { EvidenceRejected, EvidenceStale, mcpRecord, parseEvidence, type McpEvidence } from './evidence.js';
import { beginMcpRequest, closeMcpRequest, mcpRequestInstructions, ObservationRejected, parseObservation, readStdinBounded, type Observed } from './observed.js';
import { clearPendingCleanup, deleteProbeNonce, probeDeleteCall, probeNonceCleanup, probeScopeOf, readPendingCleanups, verifyProbe, writePendingCleanup, type ProbeNonceCleanup, type ProbeScope, type ProbeTarget } from './mcp-probe.js';
import { catalystRestCall } from '../../deploy/src/rest.js';
import { c2cVersion, detectHost, workspaceDir, writeDoctorFile } from './report.js';
import { formatAge, loadMcpEvidence, MCP_EVIDENCE_MAX_AGE_HOURS, writeMcpEvidence, type McpEvidenceReuse } from './mcp-state.js';
import { cliStoreHooks, resolveScope, type ScopeHooks } from './scope.js';
import { verifyVendorDir } from './vendor.js';
import { readRegularFile } from './read-file.js';
import { isDirectoryPath, listDsFiles } from '../../core/src/index.js';
import { GATE_EXIT, INTEGRITY_EXIT, carriedMcpRecord, doctorStamp, evaluateGate, gateRefusalMessage, type GateScope } from './gate.js';
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
    const child = spawn(command, args, { cwd: opts.cwd, env: scrubCatalystEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
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

function formatTable(checks: CheckResult[], file: DoctorFile, note?: string): string {
  const lines = [`c2c doctor ${file.c2c} — scope ${file.scope.dc ?? '?'}/${file.scope.org ?? '?'}/${file.scope.project ?? '?'}`];
  for (const c of checks) {
    const label = c.status.toUpperCase().padEnd(4);
    lines.push(`${label} ${c.id}  ${c.screen ?? c.detail}`);
    if (c.fix) lines.push(`     fix: ${c.fix}`);
  }
  for (const d of file.deferred ?? []) {
    lines.push(`NOTE ${d.id}: deferred — ${d.reason}`);
  }
  if (note) lines.push(`NOTE ${note}`);
  lines.push(`doctor: ${file.green ? 'green' : 'red'}`);
  return `${lines.join('\n')}\n`;
}

async function doctorMain(parsed: DoctorArgs, io: DoctorIo, hooks?: ScopeHooks, now?: () => Date): Promise<number> {
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
    let request;
    try {
      request = beginMcpRequest(workspace, now?.(), probeTarget, io.env);
    } catch (err) {
      if (err instanceof ObservationRejected) {
        io.stderr(`c2c doctor: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    const ask = mcpRequestInstructions(request, probeTarget);
    const pending = readPendingCleanups(workspace);
    if (parsed.json) {
      io.stdout(`${JSON.stringify({ ...ask, ...(pending.length ? { pendingCleanup: pending.map((p) => probeDeleteCall(p.name, p)) } : {}) }, null, 2)}\n`);
    } else {
      const callLines = ask.calls.map((call) => `   ${JSON.stringify(call)}`).join('\n');
      io.stdout(
        `MCP request ${ask.request} (answer before ${ask.expires})\n` +
          `1. In this session, make these calls; approve each call when asked. Never call ${ask.neverCall.join(' or ')}: they return project secrets into the transcript, and the doctor lists projects through the Catalyst CLI.\n${callLines}\n` +
          (ask.objectCleanup
            ? `   The probe bucket (${ask.probe}) is one per project and is reused across runs — an already-exists answer means an earlier run left it, and that bucket alone does not pass. Write an object whose key is this run's nonce (${ask.nonce}) with CatalystbyZoho_Create_Upload_Signature, then PUT the nonce text to the signed URL. The doctor lists objects in that bucket and requires that exact key. Echoed call results prove nothing. The observation must include Create_Bucket and List_All_Organizations; Create_Upload_Signature may be included and is not required.\n`
            : `   The first call writes the probe bucket (${ask.probe}; one per project, reused across runs — an already-exists answer means an earlier run left it: carry on and still send the observation) the doctor reads back over the Catalyst REST API with your CLI credential — the echoed nonce alone proves nothing.\n`) +
          `2. Pipe the observation — this request id, the Catalyst server, host and tool names the session lists, and each call's result verbatim — into:\n` +
          `   ${ask.command}\n` +
          `${JSON.stringify(ask.observation, null, 2)}\n` +
          (ask.objectCleanup
            ? `3. Afterwards delete this run's nonce object (the bucket stays): PUT ${ask.objectCleanup.path} with body ${JSON.stringify(ask.objectCleanup.body)}. Then remove the probe bucket: call ${JSON.stringify(ask.cleanup)}\n`
            : `3. Afterwards remove the probe bucket: call ${JSON.stringify(ask.cleanup)}\n`) +
          pending.map((p) => `cleanup still pending from an earlier run: call ${JSON.stringify(probeDeleteCall(p.name, p))}\n`).join(''),
      );
    }
    return 0;
  }

  let evidence: McpEvidence | undefined;
  let nonceCleanup: ProbeNonceCleanup | undefined;
  let origin: { source: 'observed'; observed: Observed } | { source: 'operator' } | undefined;
  if (parsed.mcpObserved !== undefined) {
    if (parsed.mcpObserved !== '-' || !io.stdin) {
      io.stderr(`c2c doctor: --mcp-observed reads the observation from standard input only: --mcp-observed -\n${USAGE}`);
      return 2;
    }
    try {
      const result = parseObservation(io.stdin(), { workspace, env: io.env });
      evidence = result.evidence;
      origin = { source: 'observed', observed: result.observed };
      // A --local run persists nothing, so it must not consume the request;
      // the run that writes doctor.json closes it first (fail closed), atomically.
      if (!parsed.local) {
        // The submitted results are caller-controlled: the binding is the
        // doctor's own REST read-back of this run's nonce object, not the
        // echoed nonce. Runs before closeMcpRequest so a rejected observation
        // can never consume the request (parse already threw by this point).
        // The bucket --mcp-begin named, pinned in the request file: the
        // read-back and the cleanup track the bucket that was actually
        // created, even if the scope flags drifted since the begin run.
        const probe = result.probe;
        // The request pins the scope --mcp-begin ran under (fail closed):
        // an org-scoped begin is never completed by a project-scoped binding,
        // which could create the org-named bucket inside the project, and the
        // same in reverse. A scope the begin could not pin ('request' kind,
        // no numeric org/project) carries no drift check.
        if (result.scope.kind !== 'request') {
          const runScope = probeScopeOf(probeTarget);
          const drift =
            result.scope.kind !== runScope.kind ||
            (result.scope.org !== undefined && result.scope.org !== probeTarget.org) ||
            (result.scope.project !== undefined && result.scope.project !== probeTarget.project);
          if (drift) {
            const describe = (scope: ProbeScope): string =>
              scope.kind === 'project' ? `project-scoped (project ${scope.project})` : scope.kind === 'org' ? `org-scoped (org ${scope.org})` : 'unscoped';
            throw new ObservationRejected(`the MCP request was opened ${describe(result.scope)} but this run is ${describe(runScope)}; run c2c doctor --mcp-begin again in the same scope`);
          }
        }
        const projectScoped = probeTarget.project !== undefined && /^[0-9]+$/.test(probeTarget.project);
        const rest = io.rest ?? ((call: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown }) => catalystRestCall(io.env, probeTarget.org ?? '', probeTarget.project ?? '', call));
        // A project-scoped request always carries this run's nonce (the
        // authenticated request file requires it), so the binding is the
        // nonce-object read-back — never the bucket's existence alone.
        const binding = projectScoped
          ? await verifyProbe(rest, probeTarget, probe, result.nonce)
          : await verifyProbe(rest, probeTarget, probe);
        evidence.binding = binding;
        // Absent means the bucket itself is gone, so the pending delete can
        // drop. A missing nonce object leaves the reusable bucket in place:
        // that detail names the nonce object and the cleanup record stays.
        const bucketGone = binding.status === 'absent' && !binding.detail.includes('nonce object');
        if (bucketGone) {
          clearPendingCleanup(workspace, probe);
        } else if (projectScoped) {
          writePendingCleanup(workspace, probe, probeTarget);
          if (binding.status === 'verified') {
            // A verified in-project probe supersedes the pre-project probe:
            // project-less records name no actionable delete target, so
            // they would warn forever. Legacy random buckets stay tracked
            // until the re-check below shows them gone.
            for (const pending of readPendingCleanups(workspace)) {
              if (!pending.project && (pending.org === undefined || pending.org === probeTarget.org)) clearPendingCleanup(workspace, pending.name);
            }
            await deleteProbeNonce(rest, probeTarget.project as string, probe, result.nonce);
          }
        }
        if (projectScoped && binding.status !== 'absent') {
          nonceCleanup = probeNonceCleanup(probe, result.nonce, probeTarget.project as string);
        }
        // A verified probe without a project tracks nothing: no bucket was
        // provably created inside a project, and its delete call would carry
        // a placeholder project. The in-project probe after the project
        // exists tracks its own bucket.
        // Earlier runs' probes owe a delete too: each is re-checked and its
        // reminder drops only once the read-back shows it is actually gone.
        for (const pending of readPendingCleanups(workspace)) {
          if (pending.name === probe || !pending.project || !/^[0-9]+$/.test(pending.project)) continue;
          const leftover = await verifyProbe(rest, pending, pending.name);
          if (leftover.status === 'absent') clearPendingCleanup(workspace, pending.name);
        }
        closeMcpRequest(workspace, result.observed.request, io.env);
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

  // No new evidence this run: reuse the last accepted record for this scope
  // while it is inside its expiry window — only a record this doctor signed
  // (mcp-state.ts); an unsigned or edited one is rejected and never used.
  let reuse: McpEvidenceReuse = { status: 'none' };
  const fresh = evidence !== undefined;
  if (evidence === undefined && parsed.recordMcp === undefined) {
    reuse = loadMcpEvidence(workspace, scope, { env: io.env, ...(now ? { now: now() } : {}) });
    if (reuse.status === 'reused') {
      evidence = reuse.evidence;
      origin = reuse.origin;
    }
  }
  const reuseNote =
    reuse.status === 'reused'
      ? `MCP evidence observed ${formatAge(reuse.ageMs)} ago (${reuse.at}), reused; re-check required after ${MCP_EVIDENCE_MAX_AGE_HOURS} h (by ${reuse.expires}): c2c doctor --mcp-begin`
      : reuse.status === 'expired'
        ? `MCP evidence observed ${formatAge(reuse.ageMs)} ago has expired; re-check required after ${MCP_EVIDENCE_MAX_AGE_HOURS} h: run c2c doctor --mcp-begin, make the calls it names, then pipe the results into c2c doctor --mcp-observed -`
        : reuse.status === 'rejected'
          ? `stored MCP evidence (c2c-out/.c2c/mcp-state.json) not used: ${reuse.reason}; run c2c doctor --mcp-begin, make the calls it names, then pipe the results into c2c doctor --mcp-observed -`
          : undefined;
  // Nothing new or reused: carry the last MCP record for this exact scope, so
  // doctor and the gate read the same D-B rows and agree on the verdict.
  const carried = evidence === undefined ? carriedMcpRecord({ workspace, scope: { dc: scope.dc, org: scope.org, project: scope.project }, env: io.env, ...(now ? { now: now() } : {}) }) : undefined;

  // Cleanup always runs: while a probe bucket may exist, the delete call is
  // re-printed on every run — in the human table and as pendingCleanup in
  // the JSON body, so machine consumers see the instruction too. Each record
  // clears only when a REST read-back confirms that bucket is gone.
  const pendingCleanups = readPendingCleanups(workspace);
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
    ...(reuseNote ? { evidenceNote: reuseNote } : {}),
    pendingCleanup: pendingCleanups.map((p) => p.name),
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
    ...(reuse.status === 'reused' ? { mcpReused: { observedAt: reuse.at, expires: reuse.expires } } : {}),
    deferred: run.deferred,
    green: run.green,
  };
  // A --local hook run never persists: it skipped the account/network checks,
  // so it must not refresh `at` or turn a red doctor green for the gate.
  const path = parsed.local ? undefined : writeDoctorFile(workspace, file);
  // Only evidence accepted this run is stored; a reused record keeps its own `at`.
  if (path && fresh && evidence && origin) {
    const stored = writeMcpEvidence(workspace, evidence, run.scope, origin, { env: io.env });
    if (typeof stored !== 'string' && !parsed.quiet) io.stderr(`c2c doctor: MCP evidence not kept for later runs: ${stored.refused}\n`);
  }
  if (!parsed.quiet) {
    if (parsed.json) {
      io.stdout(
        `${JSON.stringify({ ...file, ...(path ? { doctorJson: path } : {}), ...(pendingCleanups.length ? { pendingCleanup: pendingCleanups.map((p) => probeDeleteCall(p.name, p)) } : {}), ...(nonceCleanup ? { nonceCleanup } : {}) }, null, 2)}\n`,
      );
    } else {
      io.stdout(formatTable(run.checks, file, reuseNote));
      if (carried) io.stdout(`D-B/D-V: ${carried.signed ? '' : 'failed rows '}from the MCP observation recorded at ${carried.mcp.at}; run c2c doctor --mcp-begin to record a new one\n`);
      if (path) io.stdout(`doctor.json: ${path}\n`);
      else io.stdout('(local run; doctor.json not updated)\n');
    }
    for (const pending of pendingCleanups) {
      io.stdout(`cleanup: remove the probe bucket ${pending.name} — in this session call ${JSON.stringify(probeDeleteCall(pending.name, pending))}\n`);
    }
    if (nonceCleanup) {
      io.stdout(`cleanup: remove the probe nonce object ${nonceCleanup.nonce} from bucket ${nonceCleanup.bucket} — PUT ${nonceCleanup.path} body ${JSON.stringify(nonceCleanup.body)}\n`);
    }
  }
  if (run.integrityFailed) return INTEGRITY_EXIT;
  return run.green ? 0 : 1;
}

export async function doctorCli(args: readonly string[], io: DoctorIo, opts?: { hooks?: ScopeHooks; now?: () => Date }): Promise<number> {
  const parsed = parseArgs(args, io);
  if (parsed === 'usage') return 2;
  return doctorMain(parsed, io, opts?.hooks, opts?.now);
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
    return INTEGRITY_EXIT;
  }
  if (!verdict.ok) {
    io.stderr(`c2c: the c2c plugin files were modified or are incomplete (${verdict.mismatched.length} files differ). Reinstall the plugin.\n`);
    return INTEGRITY_EXIT;
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
