/**
 * Static Catalyst quota and cost estimate for loading a seed and for a month
 * of use. Every limit comes from the repo's limits table
 * (packages/schema/src/limits.ts, plugin/references/facts/limits.md) and
 * carries its label. The repo records no Catalyst price, so every price line
 * is [UNVERIFIED] with no number and the cost total is null: a number here
 * would be invented.
 *
 * The usage profile (users, requests per user per day, days) is an input,
 * not a fact; the report prints it as an assumption.
 */
import { catalystLimit } from '../../schema/src/limits.js';
import { LIMITS } from '../../shims/src/runtime.js';
import { moverApiCalls } from './offline-plan.js';

export interface EstimateTable {
  name: string;
  rows: number;
}

export interface UsageProfile {
  users: number;
  days: number;
  /** Report page loads per user per day. */
  pageLoads: number;
  searches: number;
  submits: number;
}

/** Data Store calls one request makes, from the offline run (the part that carries over). */
export interface CallsPerRequest {
  pageLoad: number;
  search: number;
  submit: number;
}

export interface LimitRef {
  id: string;
  value: number | null;
  unit: string;
  label: '[UNVERIFIED]' | '[DOC]';
  source: string;
}

export interface EstimateLine {
  item: string;
  quantity: number | null;
  unit: string;
  limit?: LimitRef;
  /** quantity / limit, when both are numbers. */
  share?: number;
  note?: string;
}

export interface QuotaEstimate {
  import: EstimateLine[];
  month: EstimateLine[];
  prices: { item: string; price: null; label: '[UNVERIFIED]'; note: string }[];
  costTotal: null;
  profile: UsageProfile;
}

const LIMITS_FILE = 'packages/schema/src/limits.ts';
const FACTS_FILE = 'plugin/references/facts/limits.md';

/** Bulk-write rows per job: the facts ledger marks this one [DOC] ("Bulk write job size"). */
export const BULK_WRITE_ROWS_PER_JOB = 100_000;

function ref(id: string): LimitRef {
  const row = catalystLimit(id);
  return { id, value: row.value, unit: row.unit, label: '[UNVERIFIED]', source: `${LIMITS_FILE} ${id}` };
}

function line(item: string, quantity: number | null, unit: string, limit?: LimitRef, note?: string): EstimateLine {
  const out: EstimateLine = { item, quantity, unit };
  if (limit) out.limit = limit;
  if (limit && quantity !== null && limit.value) out.share = Math.round((quantity / limit.value) * 1000) / 1000;
  if (note) out.note = note;
  return out;
}

export const PRICED_ITEMS = ['Function invocations', 'Function execution time', 'Data Store rows stored', 'Data Store API calls', 'Stratus storage'];

export function estimateQuota(tables: readonly EstimateTable[], profile: UsageProfile, calls: CallsPerRequest): QuotaEstimate {
  const rows = tables.reduce((sum, t) => sum + t.rows, 0);
  const moverCalls = tables.reduce((sum, t) => sum + moverApiCalls(t.rows), 0);
  const insertCalls = tables.reduce((sum, t) => sum + Math.ceil(t.rows / LIMITS.insertRowsPerCall), 0);
  const writeRate = ref('datastore.write_requests_per_minute');
  const maxTableWrites = Math.max(0, ...tables.map((t) => Math.ceil(t.rows / LIMITS.insertRowsPerCall)));
  const bulkJobs = tables.reduce((sum, t) => sum + Math.ceil(t.rows / BULK_WRITE_ROWS_PER_JOB), 0);
  const importLines = [
    line('Rows loaded', rows, 'rows', undefined, `${tables.length} tables`),
    line('Mover API calls (floor)', moverCalls, 'API calls', ref('api.calls_dev'), 'call model of c2c plan dev-api-calls (moverApiCalls)'),
    line('Insert calls', insertCalls, 'calls', undefined, `${LIMITS.insertRowsPerCall} rows per call (${FACTS_FILE} "Row insert batch", [UNVERIFIED])`),
    line(
      'Minutes at the stated write rate, largest table',
      writeRate.value ? Math.ceil(maxTableWrites / writeRate.value) : null,
      'minutes',
      writeRate,
      'tables load in parallel at best; the sum over tables is the sequential bound',
    ),
    line('Minutes at the stated write rate, all tables in sequence', writeRate.value ? Math.ceil(insertCalls / writeRate.value) : null, 'minutes', writeRate),
    line('Bulk-write jobs instead of inserts', bulkJobs, 'jobs', undefined, `${BULK_WRITE_ROWS_PER_JOB} rows per job (${FACTS_FILE} "Bulk write job size", [DOC])`),
    line('Rows per Development table', Math.max(0, ...tables.map((t) => t.rows)), 'rows', ref('datastore.rows_per_table_dev'), 'cap value not published: a 403 API_LIMIT_REACHED "API Limit for row" is the signal'),
  ];
  const perDay = profile.users * (profile.pageLoads + profile.searches + profile.submits);
  const invocations = perDay * profile.days;
  const storeCalls = profile.users * profile.days * (profile.pageLoads * calls.pageLoad + profile.searches * calls.search + profile.submits * calls.submit);
  const month = [
    line('Function invocations (c2c_api requests)', invocations, 'invocations'),
    line('Data Store calls from those requests', storeCalls, 'calls', ref('api.calls_dev'), 'api.calls_dev is stated per application in Development, not per month'),
    line('Peak concurrent executions', null, 'executions', ref('function.concurrency_dev'), 'depends on the arrival pattern, not on a daily count'),
    line('Request time cap', catalystLimit('function.timeout_seconds').value, 'seconds', ref('function.timeout_seconds'), 'see the timeout-risk table for calls per request'),
  ];
  return {
    import: importLines,
    month,
    prices: PRICED_ITEMS.map((item) => ({ item, price: null, label: '[UNVERIFIED]', note: 'no Catalyst price is recorded in the repo' })),
    costTotal: null,
    profile,
  };
}
