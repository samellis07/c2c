/**
 * State-machine helpers shared by the approval inbox and the record stage bar.
 * The stages, transitions and endpoints come straight from the generated
 * machine (model.workflows); the client offers a transition only for the
 * record's stored stage, and the server re-checks everything.
 */
import type { AppSpec, FlowSpec, FlowTransitionSpec } from '../types';

/** Machines governing `form`, in spec order. */
export function flowsForForm(spec: AppSpec, form: string): FlowSpec[] {
  return (spec.workflows ?? []).filter((flow) => flow.form === form);
}

/** Approval machines only — the inbox lists approvals, blueprints live on the record. */
export function approvalFlows(spec: AppSpec): FlowSpec[] {
  return (spec.workflows ?? []).filter((flow) => flow.kind === 'approval');
}

/** Stages that still offer transitions, in declaration order — the inbox's pending buckets. */
export function openStages(flow: FlowSpec): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const transition of flow.transitions) {
    if (!seen.has(transition.from)) {
      seen.add(transition.from);
      out.push(transition.from);
    }
  }
  return out;
}

/** Stages with no outgoing transition — the inbox's completed buckets. */
export function terminalStages(flow: FlowSpec): string[] {
  const open = new Set(openStages(flow));
  return flow.stages.filter((stage) => !open.has(stage));
}

/** The transitions the machine allows from `stage`, in declaration order. */
export function transitionsFrom(flow: FlowSpec, stage: string): FlowTransitionSpec[] {
  return flow.transitions.filter((transition) => transition.from === stage);
}

/** The button label: the action word for approvals, the display name for blueprint transitions. */
export function transitionLabel(transition: FlowTransitionSpec): string {
  if (transition.action === 'approve') return 'Approve';
  if (transition.action === 'reject') return 'Reject';
  return transition.name;
}

/**
 * The stages the stepper shows. A terminal stage replaces the un-reached
 * alternatives: a rejected approval ends on Rejected, not on Approved plus a
 * stale Rejected step.
 */
export function stageBarStages(flow: FlowSpec, stage: string): string[] {
  const terminal = new Set(terminalStages(flow));
  const open = flow.stages.filter((name) => !terminal.has(name));
  if (terminal.has(stage)) return [...open, stage];
  const goal = flow.stages.find((name) => terminal.has(name) && !/reject/i.test(name)) ?? terminalStages(flow)[0];
  return goal ? [...open, goal] : open;
}

/** A transition the user confirmed this session, as a timeline row. */
export interface FlowEvent {
  action: FlowTransitionSpec['action'];
  name: string;
  from: string;
  to: string;
  comment?: string;
  at: number;
  /** The server ran the transition only when it was not a dry run. */
  dryRun: boolean;
}

/** The stage a record sits in, from the record endpoint's reply. */
export function recordStage(flow: FlowSpec, record: Record<string, unknown> | undefined): string {
  const value = record?.[flow.statusColumn];
  return typeof value === 'string' ? value : '';
}
