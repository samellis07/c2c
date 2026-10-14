/**
 * Progress heartbeat for a gallery app process. Imported first by the gallery
 * entry, so it starts before the other modules load: with
 * `--heartbeat-ms <n>` on the command line, a worker thread writes the
 * process CPU time (microseconds) and the count of work marks to stderr every
 * n ms, also while the main thread is busy in synchronous work.
 *
 * The CPU time covers this process only. Work done in a subprocess (and
 * awaited by the main thread) shows up as a mark instead: the main thread
 * calls markProgress when such a piece of work finishes.
 */
import { Worker } from 'node:worker_threads';

export const PROGRESS = 'c2c-gallery-progress';

let marks: Int32Array | undefined;

export function startHeartbeat(ms: number): void {
  if (!Number.isInteger(ms) || ms < 1) return;
  marks = new Int32Array(new SharedArrayBuffer(4));
  const code = `const { writeSync } = require('node:fs');
const { workerData } = require('node:worker_threads');
setInterval(() => { const u = process.cpuUsage(); writeSync(2, '${PROGRESS} ' + (u.user + u.system) + ' ' + Atomics.load(workerData, 0) + '\\n'); }, ${ms});`;
  new Worker(code, { eval: true, workerData: marks }).unref();
}

/** Records a finished piece of work whose CPU time is not this process's. No-op without a heartbeat. */
export function markProgress(): void {
  if (marks) Atomics.add(marks, 0, 1);
}

const at = process.argv.indexOf('--heartbeat-ms');
if (at >= 0 && process.argv.includes('--once')) startHeartbeat(Number(process.argv[at + 1]));
