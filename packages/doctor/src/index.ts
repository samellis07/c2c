export { doctorCli, verifyVendorCli, doctorGateForArgs, positionalOf, flag, defaultDoctorIo, doctorSpawn } from './cli.js';
export {
  evaluateGate,
  gateRefusalMessage,
  doctorStamp,
  GATE_EXIT,
  GATE_REQUIRED_CHECKS,
  DOCTOR_MAX_AGE_MS,
  type GateScope,
  type GateVerdict,
  type GateStatus,
  type DoctorStamp,
} from './gate.js';
export {
  resolveScope,
  cliStoreHooks,
  normalizeDc,
  dcOfMcpHost,
  dcOfCreatorHost,
  dcTld,
  KNOWN_DCS,
  DEPLOY_CONFIG,
  findDeployConfig,
  type ScopeFlags,
  type ScopeHooks,
  type ResolvedScopeValues,
  type Dc,
} from './scope.js';
export { REQUIRED_MCP_TOOLS, ALL_REQUIRED_MCP_TOOLS, MCP_TOOL_PREFIX, MCP_TOOLS_GUIDANCE, NEVER_CALL_MCP_TOOLS } from './required-tools.js';
export { parseEvidence, missingRequiredTools, shortToolName, EvidenceRejected, EvidenceStale, type McpEvidence } from './evidence.js';
export {
  parseObservation,
  beginMcpRequest,
  mcpRequestPath,
  readStdinBounded,
  ObservationRejected,
  OBSERVATION_KIND,
  OBSERVATION_SCHEMA,
  OBSERVATION_MAX_BYTES,
  MCP_RESULT_MAX_BYTES,
  MCP_REQUEST_MAX_AGE_MS,
  type Observed,
  type McpRequest,
} from './observed.js';
export { probeNameOf, verifyProbe, IN_PROJECT_PROBE_REQUIRED, probeCreateCall, probeDeleteCall, readPendingCleanups, PROBE_PREFIX, PROBE_CREATE_CALL, PROBE_DELETE_CALL, type PendingCleanup, type ProbeResult, type ProbeTarget } from './mcp-probe.js';
export { writeMcpEvidence, loadMcpEvidence, mcpCarryRefusal, mcpStatePath, mcpStateKeyPath, formatAge, MCP_EVIDENCE_MAX_AGE_HOURS, MCP_EVIDENCE_MAX_AGE_MS, type McpEvidenceReuse } from './mcp-state.js';
export { writeDoctorFile, doctorJsonPath, c2cVersion, detectHost, workspaceDir } from './report.js';
export { verifyVendorDir, MANIFEST_NAME, type VendorVerdict } from './vendor.js';
export { runDoctorChecks, f5TableBudgets, checkMailSender, projectListIds, maskEmail, DEFERRED_CHECKS, type DoctorContext, type DoctorRun } from './checks.js';
export type { CheckResult, DoctorFile, DoctorIo, SpawnFn, SpawnResult } from './types.js';
