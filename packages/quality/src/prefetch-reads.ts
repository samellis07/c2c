/**
 * Prefetch read-only gate. A generated prefetch endpoint runs the server
 * reads a client condition or loop needs, once per render — so a write, a
 * send, or a call that leaves the app in one of those modules would fire on
 * every form load. The sweep fails any app whose generated prefetch modules
 * perform a non-read, the same list the translator refuses to replay into a
 * prefetch: datastore writes, mail, notification, http, zoho.task, and thisapp.call.
 *
 * Input and record field writes are not non-reads there: the translator
 * replays the handler's own field writes into the prefetch, in program order
 * under the guards of their arms, so a slot that reads a written field sees
 * the post-write value. The prefetch endpoint is dry-run and never flushes,
 * so a replayed write changes only the request's copy of the record. The
 * gate counts them separately (`replayedWrites`) so they stay visible.
 */
import type { GeneratedTree } from './modules.js';
import { sortedCounts } from './static.js';

/**
 * A call a generated prefetch endpoint must never run: it writes, sends, or
 * leaves the datastore read surface (a thisapp function body may write).
 * Reads — rows, lookup, aggregate, column, field — and zoho.* environment
 * lookups are allowed.
 */
export const PREFETCH_NON_READ =
  /\bshim\.(datastore\.(?:insert|insertRow|insertRows|update|updateRows|delete|deleteRows|writeRow|setField|flush)|mail\.\w+|notification\.\w+|http\.\w+|zoho\.task|thisapp\.call)\s*\(/g;

/**
 * A handler field write the translator replays into a prefetch before a
 * read of that field: input.set / input.insert / record.set. Counted, not
 * failed — a record.set only persists at datastore.flush, which a prefetch
 * never runs.
 */
export const PREFETCH_REPLAYED_WRITE = /\bshim\.(input\.(?:set|insert)|record\.set)\s*\(/g;

/** A generated module is a prefetch endpoint when its file name ends `-prefetch.mjs` / `-prefetch.js`. */
export function isPrefetchModule(path: string): boolean {
  return /(?:^|\/)[^/]*-prefetch\.m?js$/.test(path);
}

export interface PrefetchNonRead {
  path: string;
  /** The call matched, e.g. `shim.mail.send`. */
  op: string;
  line: number;
}

export interface PrefetchReadsReport {
  /** True when no prefetch module performs a non-read. */
  ok: boolean;
  /** Generated prefetch endpoint modules scanned. */
  modules: number;
  /** Non-read calls found across every prefetch module. */
  nonReads: number;
  /** Op name → calls. */
  byOp: Record<string, number>;
  findings: PrefetchNonRead[];
  /** Handler field writes replayed into prefetch modules (not non-reads). */
  replayedWrites: number;
  /** Replayed op name → calls. */
  replayedByOp: Record<string, number>;
}

/**
 * Comment lines that can quote the source statement (which may itself be a
 * non-read) are dropped before matching, the same normalisation the
 * call-site scan applies.
 */
function codeLines(text: string): string {
  return text
    .replace(/^\s*\/\/ Deluge: .*/gm, '')
    .replace(/^[\s]*\*.*$/gm, '')
    .replace(/^[\s]*\/\/.*/gm, '');
}

export function checkPrefetchReads(tree: GeneratedTree): PrefetchReadsReport {
  const findings: PrefetchNonRead[] = [];
  const byOp: Record<string, number> = {};
  const replayedByOp: Record<string, number> = {};
  let replayedWrites = 0;
  let modules = 0;
  for (const m of tree.modules) {
    if (!isPrefetchModule(m.path)) continue;
    modules++;
    const code = codeLines(m.text);
    PREFETCH_NON_READ.lastIndex = 0;
    for (let match = PREFETCH_NON_READ.exec(code); match; match = PREFETCH_NON_READ.exec(code)) {
      const op = `shim.${match[1]!}`;
      byOp[op] = (byOp[op] ?? 0) + 1;
      findings.push({ path: m.path, op, line: lineOf(code, match.index) });
    }
    PREFETCH_REPLAYED_WRITE.lastIndex = 0;
    for (let match = PREFETCH_REPLAYED_WRITE.exec(code); match; match = PREFETCH_REPLAYED_WRITE.exec(code)) {
      const op = `shim.${match[1]!}`;
      replayedByOp[op] = (replayedByOp[op] ?? 0) + 1;
      replayedWrites++;
    }
  }
  return { ok: findings.length === 0, modules, nonReads: findings.length, byOp: sortedCounts(byOp), findings, replayedWrites, replayedByOp: sortedCounts(replayedByOp) };
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
