/**
 * The Approvals system screen. `pending` lists governed records sitting in a
 * stage that still offers transitions; `completed` lists records at a terminal
 * stage. Buckets come from the governed report's query endpoint filtered on
 * the machine's status column — the same stored stage the server re-checks
 * before writing a transition.
 *
 * Decisions run through DecisionDialog: the confirm posts { ROWID, status,
 * comment? } to the action's own endpoint, and the server stores the comment
 * on the C2C_Flow_History audit row. This screen shows the session's own
 * decisions as a timeline plus the comments they carried; the completed view
 * lists those comments read-only — a stored record's history is not an
 * endpoint yet, so nothing here accepts new text after the decision posts.
 */
import { useEffect, useState } from 'react';
import { Button } from '../arc/components/button/button';
import { EmptyState } from '../arc/components/empty-state/empty-state';
import { Timeline } from '../arc/components/timeline/timeline';
import type { ThreadComment } from '../arc/components/comment-thread/comment-thread';
import { formatValue } from '../report/ReportView';
import { hrefFor } from '../runtime/router';
import { useEnv } from '../runtime/env';
import type { FlowSpec, ReportSpec } from '../types';
import {
  approvalFlows,
  openStages,
  terminalStages,
  transitionsFrom,
  transitionLabel,
  type FlowEvent,
} from './flows';
import { APPROVER, DecisionDialog, type FlowDecision, type FlowOutcome } from './DecisionDialog';
import styles from './workflow.module.css';

type Row = Record<string, unknown>;

export type InboxView = 'pending' | 'completed';

interface InboxItem {
  key: string;
  rowId: string;
  row: Row;
  stage: string;
}

interface FlowBucket {
  flow: FlowSpec;
  report?: ReportSpec;
  load: 'loading' | 'error' | 'ready';
  items: InboxItem[];
}

function stageChip(stage: string) {
  const rejected = /reject/i.test(stage);
  return (
    <span className={styles.stage} data-done={!rejected || undefined} data-rejected={rejected || undefined}>
      {stage}
    </span>
  );
}

function summaryFields(report: ReportSpec | undefined, row: Row) {
  const columns = report ? (report.columns.length > 3 ? report.columns.slice(0, 3) : report.columns) : [];
  return columns.map((column) => (
    <span key={column.field} className={styles.field}>
      <span className={styles.fieldLabel}>{column.label}:</span>
      {formatValue(row[column.field])}
    </span>
  ));
}

function itemLabel(report: ReportSpec | undefined, item: InboxItem): string {
  const first = report?.columns[0]?.field;
  const value = first ? formatValue(item.row[first]) : '';
  return value && value !== '–' ? value : `record ${item.rowId}`;
}

function eventAt(at: number): string {
  return new Date(at).toLocaleString();
}

export function ApprovalsInbox({ view }: { view?: string }) {
  const { api, spec, view: appView } = useEnv();
  const mode: InboxView = view === 'completed' ? 'completed' : 'pending';
  const flows = approvalFlows(spec);
  const [buckets, setBuckets] = useState<Record<string, FlowBucket>>({});
  const [decision, setDecision] = useState<FlowDecision | null>(null);
  const [activity, setActivity] = useState<Record<string, FlowEvent[]>>({});
  const [threads, setThreads] = useState<Record<string, ThreadComment[]>>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const jobs = flows.map(async (flow) => {
      const report = flow.report ? spec.reports[flow.report] : undefined;
      if (!report) return { name: flow.name, bucket: { flow, report, load: 'ready', items: [] } as FlowBucket };
      const stages = mode === 'pending' ? openStages(flow) : terminalStages(flow);
      try {
        const replies = await Promise.all(
          stages.map((stage) =>
            api.post<{ rows?: Row[] }>(report.queryEndpoint, {
              op: 'query',
              page: 0,
              pageSize: Math.max(report.pageSize, 100),
              filter: { field: flow.statusColumn, value: stage },
            }),
          ),
        );
        const unavailable = replies.every((reply) => [404, 405, 501].includes(reply.status));
        const failed = replies.some((reply) => !reply.ok);
        if (failed && !unavailable) return { name: flow.name, bucket: { flow, report, load: 'error', items: [] } as FlowBucket };
        const items: InboxItem[] = [];
        stages.forEach((stage, index) => {
          const rows = replies[index]?.body?.rows;
          if (!Array.isArray(rows)) return;
          for (const row of rows) {
            const rowId = row.ROWID ?? row.rowid;
            if (rowId === undefined || rowId === null) continue;
            items.push({ key: `${flow.name}|${String(rowId)}`, rowId: String(rowId), row, stage });
          }
        });
        return { name: flow.name, bucket: { flow, report, load: 'ready', items } as FlowBucket };
      } catch {
        return { name: flow.name, bucket: { flow, report, load: 'error', items: [] } as FlowBucket };
      }
    });
    Promise.all(jobs).then((results) => {
      if (!live) return;
      const next: Record<string, FlowBucket> = {};
      for (const result of results) next[result.name] = result.bucket;
      setBuckets(next);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buckets reload when the view or retry changes
  }, [api, mode, attempt, spec]);

  function onDone(outcome: FlowOutcome) {
    const { flow, transition, rowId } = outcome.decision;
    const key = `${flow.name}|${rowId}`;
    setActivity((prev) => ({
      ...prev,
      [key]: [...(prev[key] ?? []), { action: transition.action, name: transition.name, from: outcome.from, to: outcome.to, comment: outcome.comment || undefined, at: Date.now(), dryRun: outcome.dryRun }],
    }));
    if (outcome.comment) {
      setThreads((prev) => ({
        ...prev,
        [key]: [...(prev[key] ?? []), { id: `${key}-c${(prev[key] ?? []).length}`, author: APPROVER, body: outcome.comment, createdAt: eventAt(Date.now()) }],
      }));
    }
    if (!outcome.dryRun && mode === 'pending') {
      setBuckets((prev) => {
        const bucket = prev[flow.name];
        if (!bucket) return prev;
        return { ...prev, [flow.name]: { ...bucket, items: bucket.items.filter((item) => item.rowId !== rowId) } };
      });
    }
    setDecision(null);
  }

  return (
    <section className="c2c-card" data-inbox={mode}>
      <h1>{mode === 'pending' ? 'Pending approvals' : 'Completed approvals'}</h1>
      {flows.length === 0 && <EmptyState title="No approvals configured" description="This app declares no approval workflows." />}
      {flows.map((flow) => {
        const bucket = buckets[flow.name];
        const items = bucket?.items ?? [];
        return (
          <div key={flow.name} className={styles.group} data-flow={flow.name}>
            <h2>{flow.label}</h2>
            {bucket?.load === 'loading' || bucket === undefined ? (
              <p className={styles.loading}>Loading…</p>
            ) : bucket.load === 'error' ? (
              <EmptyState title="The list could not be loaded." description="The record query failed." action={<Button type="button" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>} />
            ) : items.length === 0 ? (
              <EmptyState title={mode === 'pending' ? 'Nothing is waiting.' : 'Nothing is finished yet.'} description={mode === 'pending' ? 'No record is at a stage that asks for a decision.' : 'No record has reached a final stage.'} />
            ) : (
              <ul className={styles.list}>
                {items.map((item) => {
                  const transitions = mode === 'pending' ? transitionsFrom(flow, item.stage) : [];
                  const events = activity[item.key] ?? [];
                  const comments = threads[item.key] ?? [];
                  return (
                    <li key={item.key} className={styles.item} data-stage={item.stage}>
                      <div className={styles.summary}>{summaryFields(bucket.report, item.row)}</div>
                      {mode === 'pending' ? <span className={styles.stage}>{item.stage}</span> : stageChip(item.stage)}
                      <span className={styles.itemActions}>
                        <a className={styles.editLink} href={hrefFor('form', flow.form, 'edit', item.rowId)}>Edit</a>
                        {transitions.map((transition) => (
                          <Button
                            key={`${transition.action}:${transition.name}`}
                            type="button"
                            variant={transition.action === 'reject' ? 'danger' : 'primary'}
                            onClick={() => setDecision({ flow, transition, rowId: item.rowId, recordLabel: itemLabel(bucket.report, item) })}
                          >
                            {transitionLabel(transition)}
                          </Button>
                        ))}
                      </span>
                      {events.length > 0 && (
                        <div className={styles.events}>
                          <h3>This session's decisions</h3>
                          <Timeline
                            events={events.map((event, index) => ({
                              id: `${item.key}-${index}`,
                              at: event.at,
                              actor: 'You',
                              title: `${transitionLabel({ name: event.name, action: event.action, from: event.from, to: event.to })}: ${event.from} → ${event.to}`,
                              meta: event.dryRun ? 'Dry run — nothing was stored' : undefined,
                              detail: event.comment ? <p className={styles.detail}>{event.comment}</p> : undefined,
                              tone: event.action === 'reject' ? 'danger' : 'success',
                            }))}
                            now={Date.now()}
                            label="This session's decisions"
                            timeZone={appView.C2C_APP_TIMEZONE}
                          />
                        </div>
                      )}
                      {mode === 'completed' && comments.length > 0 && (
                        <div className={styles.events}>
                          <h3>This session's comments</h3>
                          <ul className={styles.commentList}>
                            {comments.filter((comment) => !comment.deleted).map((comment) => (
                              <li key={comment.id} className={styles.commentItem}>
                                <span className={styles.commentMeta}>{comment.author.name} · {comment.createdAt}</span>
                                <p className={styles.detail}>{comment.body}</p>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
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
    </section>
  );
}
