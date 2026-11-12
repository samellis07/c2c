/**
 * The confirm dialog for a flow transition. It carries the comment thread of
 * the record's machine, and the newest comment is sent as `comment` with the
 * decision: the server stores it on the transition's C2C_Flow_History row.
 * The confirm button posts to the action's own endpoint
 * (/flows/<name>/approve|reject|transition) with { ROWID, status, comment? } —
 * the server re-checks the stage and the approver.
 */
import { useState } from 'react';
import { Alert } from '../arc/components/alert/alert';
import { Button } from '../arc/components/button/button';
import { Dialog, DialogContent } from '../arc/components/dialog/dialog';
import { CommentThread, type ThreadComment } from '../arc/components/comment-thread/comment-thread';
import type { FlowSpec, FlowTransitionSpec } from '../types';
import { useEnv } from '../runtime/env';
import { transitionLabel } from './flows';
import styles from './workflow.module.css';

export interface FlowDecision {
  flow: FlowSpec;
  transition: FlowTransitionSpec;
  rowId: string;
  /** Shown in the dialog so the approver knows which record the decision lands on. */
  recordLabel?: string;
}

export interface FlowOutcome {
  decision: FlowDecision;
  /** What the server answered: the stored stage it moved from and the stage it wrote. */
  from: string;
  to: string;
  comment: string;
  /** `dryRun: true` in the reply means nothing was stored. */
  dryRun: boolean;
}

interface FlowReply {
  dryRun?: boolean;
  wrote?: boolean;
  action?: string;
  from?: string;
  status?: string;
  error?: string;
}

/** The newest undeleted top-level comment is the one sent with the decision. */
export function latestComment(comments: readonly ThreadComment[]): string {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    if (!comment.deleted && comment.body.trim()) return comment.body;
  }
  return '';
}

export const APPROVER: { id: string; name: string } = { id: 'approver', name: 'You' };

export function DecisionDialog({
  decision,
  comments,
  onComments,
  onDone,
  onClose,
}: {
  decision: FlowDecision | null;
  comments: ThreadComment[];
  onComments: (comments: ThreadComment[]) => void;
  onDone: (outcome: FlowOutcome) => void;
  onClose: () => void;
}) {
  const { api, doc } = useEnv();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = decision !== null;
  const label = decision ? transitionLabel(decision.transition) : '';
  const danger = decision?.transition.action === 'reject';

  async function confirm() {
    if (!decision || busy) return;
    setBusy(true);
    setError('');
    const comment = latestComment(comments);
    const body: Record<string, unknown> = { ROWID: decision.rowId, status: decision.transition.to };
    if (comment) body.comment = comment;
    try {
      const reply = await api.post<FlowReply>(decision.flow.endpoints[decision.transition.action], body);
      setBusy(false);
      if (reply.ok) {
        onDone({ decision, from: reply.body?.from ?? decision.transition.from, to: reply.body?.status ?? decision.transition.to, comment, dryRun: reply.body?.dryRun !== false });
      } else {
        setError(reply.body?.error?.trim() ? reply.body.error : 'The transition was refused.');
      }
    } catch {
      setBusy(false);
      setError('The transition could not be sent.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent
        container={doc.body ?? doc.documentElement}
        title={decision ? `${label} — ${decision.flow.label}` : ''}
        description={decision ? `${decision.recordLabel ?? 'This record'} moves to ${decision.transition.to}.` : undefined}
      >
        <CommentThread
          title="Comments"
          comments={comments}
          onCommentsChange={(next) => onComments(next)}
          currentUser={APPROVER}
          placeholder="Add a comment (optional)"
          className={styles.comments}
        />
        {error ? <Alert tone="danger" title={error} /> : null}
        <div className={styles.actions}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant={danger ? 'danger' : 'primary'} loading={busy} onClick={confirm}>{label}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
