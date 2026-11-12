/**
 * The stage bar above a governed form's record screen. For each machine that
 * governs the form it reads the stored stage out of the record reply, draws a
 * stepper, and offers exactly the transitions declared from that stage — the
 * server re-checks the stored stage, the approver and the transition. The
 * timeline under the stepper shows this session's transitions.
 */
import { useEffect, useState } from 'react';
import { Button } from '../arc/components/button/button';
import { Stepper } from '../arc/components/stepper/stepper';
import { Timeline } from '../arc/components/timeline/timeline';
import type { ThreadComment } from '../arc/components/comment-thread/comment-thread';
import { formatValue } from '../report/ReportView';
import { useEnv } from '../runtime/env';
import type { FormSpec } from '../types';
import { flowsForForm, recordStage, stageBarStages, transitionsFrom, transitionLabel, type FlowEvent } from './flows';
import { APPROVER, DecisionDialog, type FlowDecision, type FlowOutcome } from './DecisionDialog';
import styles from './workflow.module.css';

type Row = Record<string, unknown>;

export function FlowStageBar({ form, rowId }: { form: FormSpec; rowId: string }) {
  const { api, spec, view: appView } = useEnv();
  const flows = flowsForForm(spec, form.name);
  const [record, setRecord] = useState<Row>();
  const [missing, setMissing] = useState(false);
  const [stages, setStages] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<Record<string, FlowEvent[]>>({});
  const [threads, setThreads] = useState<Record<string, ThreadComment[]>>({});
  const [decision, setDecision] = useState<FlowDecision | null>(null);

  useEffect(() => {
    if (!flows.length) return;
    let live = true;
    api.post<{ record?: Row }>(form.recordEndpoint, { ROWID: rowId }).then(
      (reply) => {
        if (!live) return;
        const row = reply.body?.record;
        if (reply.ok && row && typeof row === 'object' && !Array.isArray(row)) setRecord(row);
        else setMissing(true);
      },
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the record is re-read only when the row changes
  }, [api, form.recordEndpoint, rowId]);

  if (!flows.length || missing) return null;

  function onDone(outcome: FlowOutcome) {
    const { flow, transition, rowId: row } = outcome.decision;
    const key = `${flow.name}|${row}`;
    setStages((prev) => ({ ...prev, [flow.name]: outcome.to }));
    setActivity((prev) => ({
      ...prev,
      [key]: [...(prev[key] ?? []), { action: transition.action, name: transition.name, from: outcome.from, to: outcome.to, comment: outcome.comment || undefined, at: Date.now(), dryRun: outcome.dryRun }],
    }));
    if (outcome.comment) {
      setThreads((prev) => ({
        ...prev,
        [key]: [...(prev[key] ?? []), { id: `${key}-c${(prev[key] ?? []).length}`, author: APPROVER, body: outcome.comment, createdAt: new Date().toLocaleString() }],
      }));
    }
    setDecision(null);
  }

  const recordLabel = (): string => {
    const first = form.fields[0]?.name;
    const value = first && record ? formatValue(record[first]) : '';
    return value && value !== '–' ? value : `record ${rowId}`;
  };

  return (
    <>
      {flows.map((flow) => {
        const stage = stages[flow.name] ?? recordStage(flow, record);
        // A record the workflow's criteria never matched carries no stage — no bar.
        if (!stage || !flow.stages.includes(stage)) return null;
        const rejected = /reject/i.test(stage);
        const names = stageBarStages(flow, stage);
        const index = names.indexOf(stage);
        const current = index >= 0 && !rejected && index === names.length - 1 ? names.length : index;
        const key = `${flow.name}|${rowId}`;
        const events = activity[key] ?? [];
        return (
          <div key={flow.name} className={styles.bar} data-flow={flow.name} data-stage={stage}>
            <div className={styles.barHead}>
              <span className={styles.flowName}>{flow.label}</span>
              <span className={styles.stageActions}>
                {transitionsFrom(flow, stage).map((transition) => (
                  <Button
                    key={`${transition.action}:${transition.name}`}
                    type="button"
                    variant={transition.action === 'reject' ? 'danger' : 'primary'}
                    onClick={() => setDecision({ flow, transition, rowId, recordLabel: recordLabel() })}
                  >
                    {transitionLabel(transition)}
                  </Button>
                ))}
              </span>
            </div>
            <Stepper
              steps={names.map((name) => ({ id: name, label: name, error: name === stage && rejected ? 'Rejected' : undefined }))}
              current={current}
            />
            {events.length > 0 && (
              <div className={styles.events}>
                <h3>This session's transitions</h3>
                <Timeline
                  events={events.map((event, index) => ({
                    id: `${key}-${index}`,
                    at: event.at,
                    actor: 'You',
                    title: `${event.name}: ${event.from} → ${event.to}`,
                    meta: event.dryRun ? 'Dry run — nothing was stored' : undefined,
                    detail: event.comment ? <p className={styles.detail}>{event.comment}</p> : undefined,
                    tone: event.action === 'reject' ? 'danger' : 'success',
                  }))}
                  now={Date.now()}
                  label="This session's transitions"
                  timeZone={appView.C2C_APP_TIMEZONE}
                />
              </div>
            )}
          </div>
        );
      })}
      <DecisionDialog
        decision={decision}
        comments={decision ? threads[`${decision.flow.name}|${decision.rowId}`] ?? [] : []}
        onComments={(next) => {
          if (decision) setThreads((prev) => ({ ...prev, [`${decision.flow.name}|${decision.rowId}`]: next }));
        }}
        onDone={onDone}
        onClose={() => setDecision(null)}
      />
    </>
  );
}
