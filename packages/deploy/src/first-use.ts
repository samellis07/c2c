/**
 * Console first-use gates: a fresh project can refuse a service until the
 * user opens it once in the Catalyst console ("Start Exploring"). No
 * documented API or CLI command opens a service — the console's own
 * `PATCH /baas/v1/project/<id>/service` refuses the CLI token with 401
 * AUTHENTICATION_FAILURE — so every gate is one guided checklist line plus a
 * documented read c2c runs itself. The read's answer is what changes when the
 * gate opens: a closed gate answers the "access the service" refusal, an open
 * one answers a success envelope. Only an open answer lets a run continue; a
 * closed or unrecognised answer stops it with the checklist line.
 *
 * Probe docs:
 * - Slate: the app list the deploy already reads (GET /slate/v1/project/<id>/app),
 *   https://docs.catalyst.zoho.com/en/api/code-reference/slate/redeploy-app/
 * - Cloud Scale: Get All Tables Metadata,
 *   https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/data-store/get-all-tables-metadata/
 * - Stratus: Get All Buckets,
 *   https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/stratus/get-all-buckets/
 * - SmartBrowz: List All Grids,
 *   https://docs.catalyst.zoho.com/en/api/code-reference/smartbrowz/browser-grid/list-all-grids/
 */
import type { RestCall, RestFn, RestResult } from './tables.js';

export type FirstUseGateId = 'cloudscale' | 'stratus' | 'smartbrowz' | 'slate';

export interface FirstUseGate {
  id: FirstUseGateId;
  /** The provision step that tracks the gate. */
  stepId: `${FirstUseGateId}-enable`;
  service: string;
  /** The console page that holds the service's "Start Exploring" action, from the project. */
  page: string;
  /** One checklist line; `<console>`, `<org>` and `<project>` are filled per project. */
  console: string;
  /** The read c2c runs: a GET path template with `<project>`. */
  probe: string;
  doc: string;
}

const CONSOLE_PROJECT = '<console>/baas/<org>/project/<project>/Development';

/** Plan order: Cloud Scale before tables, Stratus and SmartBrowz with their services, Slate before its deploy. */
export const FIRST_USE_GATES: Readonly<Record<FirstUseGateId, FirstUseGate>> = {
  cloudscale: {
    id: 'cloudscale',
    stepId: 'cloudscale-enable',
    service: 'Cloud Scale',
    page: 'Cloud Scale',
    console: `Catalyst console → the project → Cloud Scale → Start Exploring (${CONSOLE_PROJECT}#/cloudscale)`,
    probe: '/baas/v1/project/<project>/table',
    doc: 'https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/data-store/get-all-tables-metadata/',
  },
  stratus: {
    id: 'stratus',
    stepId: 'stratus-enable',
    service: 'Stratus',
    page: 'Cloud Scale → Stratus',
    console: `Catalyst console → the project → Cloud Scale → Stratus → Start Exploring (${CONSOLE_PROJECT}#/cloudscale), then on Create your First Bucket create one bucket (any name) — done when it shows in the bucket list (click Create again if nothing happens after a few seconds)`,
    probe: '/baas/v1/project/<project>/bucket',
    doc: 'https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/stratus/get-all-buckets/',
  },
  smartbrowz: {
    id: 'smartbrowz',
    stepId: 'smartbrowz-enable',
    service: 'SmartBrowz',
    page: 'SmartBrowz',
    console: `Catalyst console → the project → SmartBrowz → Start Exploring (${CONSOLE_PROJECT}#/smartbrowz)`,
    probe: '/browser360/v1/project/<project>/browser-grid',
    doc: 'https://docs.catalyst.zoho.com/en/api/code-reference/smartbrowz/browser-grid/list-all-grids/',
  },
  slate: {
    id: 'slate',
    stepId: 'slate-enable',
    service: 'Slate',
    page: 'Slate',
    console: `Catalyst console → the project → Slate → Start Exploring (${CONSOLE_PROJECT}#/slate)`,
    probe: '/slate/v1/project/<project>/app',
    doc: 'https://docs.catalyst.zoho.com/en/api/code-reference/slate/redeploy-app/',
  },
};

export const FIRST_USE_GATE_LIST: readonly FirstUseGate[] = Object.values(FIRST_USE_GATES);

export function gateForStep(stepId: string): FirstUseGate | undefined {
  return FIRST_USE_GATE_LIST.find((gate) => gate.stepId === stepId);
}

/** What the app needs: Cloud Scale always, the rest only when the app uses the service. */
export function requiredGates(signals: { client: boolean; files: boolean; pdf: boolean }): FirstUseGate[] {
  return FIRST_USE_GATE_LIST.filter(
    (gate) =>
      gate.id === 'cloudscale' ||
      (gate.id === 'stratus' && signals.files) ||
      (gate.id === 'smartbrowz' && signals.pdf) ||
      (gate.id === 'slate' && signals.client),
  );
}

/**
 * The services whose first activation the human checklist names. Each has no
 * API, CLI or MCP path, so it stays one guided console action inside the
 * customer's first step — named only when the app uses the service. Cloud
 * Scale is not listed: its probe normally answers open on a fresh project, and
 * a closed answer is the provision step's guided line.
 */
export type ActivationServiceId = Extract<FirstUseGateId, 'stratus' | 'smartbrowz' | 'slate'>;

export const ACTIVATION_SERVICES: readonly ActivationServiceId[] = ['stratus', 'smartbrowz', 'slate'];

/**
 * One sentence per service, always the same pattern: `<Service> — in the
 * Catalyst console open the project → <page> → Start Exploring`. Stratus adds
 * its first-bucket clause: Start Exploring alone does not open it — the gate
 * lifts only after one bucket exists, so the sentence names that step and its
 * done signal.
 */
export function activationSentence(id: ActivationServiceId): string {
  const gate = FIRST_USE_GATES[id];
  const sentence = `${gate.service} — in the Catalyst console open the project → ${gate.page} → Start Exploring`;
  return id === 'stratus'
    ? `${sentence}, then on Create your First Bucket create one bucket (any name) and wait until it shows in the Stratus bucket list — click Create again if nothing happens after a few seconds`
    : sentence;
}

/** The services an app uses, in checklist order, from the plan signals. */
export function activationServices(signals: { client: boolean; files: boolean; pdf: boolean }): ActivationServiceId[] {
  return ACTIVATION_SERVICES.filter(
    (id) => (id === 'stratus' && signals.files) || (id === 'smartbrowz' && signals.pdf) || (id === 'slate' && signals.client),
  );
}

export function gateConsoleLine(gate: FirstUseGate, where: { console: string; org: string; project: string }): string {
  return gate.console.replaceAll('<console>', where.console).replaceAll('<org>', where.org).replaceAll('<project>', where.project);
}

export function gateProbeCall(gate: FirstUseGate, projectId: string): RestCall {
  if (!/^[0-9]+$/.test(projectId)) throw new Error('refusing a path outside the project');
  return { method: 'GET', path: gate.probe.replaceAll('<project>', projectId) };
}

export type GateVerdict = 'open' | 'closed' | 'unknown';

/**
 * Recorded closed shapes: `catalyst deploy slate` on a fresh project answers
 * 400 "Please access the Slate service in your project's console before
 * deploying via the CLI."; the Slate app list on an unopened service answers
 * INVALID_URL_PATTERN; a Stratus write or bucket list on a project that never
 * opened the service answers OPERATION_NOT_ALLOWED "in session when accessing
 * Stratus for the first time". Any "access the <service> service" refusal,
 * INVALID_URL_PATTERN or a first-session refusal on the probe path is read as
 * closed.
 */
const CLOSED_TEXT = /access the [\w ]+ service|INVALID_URL_PATTERN|in session when accessing [\w ]+/i;

export function classifyGateProbe(result: Pick<RestResult, 'status' | 'body'>): GateVerdict {
  const text = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? '');
  if (result.status >= 400) return CLOSED_TEXT.test(text) ? 'closed' : 'unknown';
  if (result.status < 200 || result.status >= 300) return 'unknown';
  const body = result.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const status = (body as Record<string, unknown>).status;
    if (status === 'failure' || status === 'error') return CLOSED_TEXT.test(text) ? 'closed' : 'unknown';
  }
  return 'open';
}

export interface GateCheck {
  gate: FirstUseGate;
  verdict: GateVerdict;
  status: number;
  /** One line for you. */
  message: string;
}

function answerSummary(result: Pick<RestResult, 'status' | 'body'>): string {
  const body = result.body;
  const record = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  const data = record?.data && typeof record.data === 'object' && !Array.isArray(record.data) ? (record.data as Record<string, unknown>) : undefined;
  const pick = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
  const said = pick(data?.message) ?? pick(record?.message) ?? pick(data?.error_code) ?? pick(record?.error_code) ?? pick(record?.code);
  return said ? `${result.status} ${said.slice(0, 160)}` : String(result.status);
}

export function gateMessage(gate: FirstUseGate, verdict: GateVerdict, result: Pick<RestResult, 'status' | 'body'>, consoleLine: string): string {
  const read = `GET ${gate.probe}`;
  if (verdict === 'open') return `${gate.service} first-use gate verified open (${read} → ${result.status})`;
  if (verdict === 'closed') {
    return `${gate.service} first-use gate is closed (${read} → ${answerSummary(result)}). Checklist: ${consoleLine}. When done, re-run and c2c verifies it again.`;
  }
  return `${gate.service} first-use gate could not be verified (${read} → ${answerSummary(result)}); c2c does not continue past an unverified gate. If the service was never opened: ${consoleLine}, then re-run.`;
}

/** Run one gate's probe. A thrown read is unverified, never open. */
export async function checkGate(rest: RestFn, gate: FirstUseGate, projectId: string, consoleLine: string): Promise<GateCheck> {
  let result: Pick<RestResult, 'status' | 'body'>;
  try {
    result = await rest(gateProbeCall(gate, projectId));
  } catch (err) {
    result = { status: 0, body: { message: err instanceof Error ? err.message : String(err) } };
  }
  const verdict = result.status === 0 ? 'unknown' : classifyGateProbe(result);
  return { gate, verdict, status: result.status, message: gateMessage(gate, verdict, result, consoleLine) };
}
