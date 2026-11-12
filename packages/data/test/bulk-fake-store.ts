/**
 * In-memory Data Store with the Bulk Write job lifecycle, for the bulk-load tests.
 *
 * Reproduced store behaviour:
 * - a write job is accepted and its rows land before the first status read;
 *   status reads say "In-Progress" `polls` times, then "Completed" with
 *   records_processed, or "Failed" with results.description;
 * - fk_mapping needs a unique reference column, else the job fails with
 *   "The reference_column '<column>' in fk_mapping of table <id> is not a unique column";
 * - a row whose fk_mapping value has no parent is skipped without an error;
 * - a ZCQL IN read takes at most 300 ids; updateRows takes at most 200 rows
 *   and skips an unknown ROWID without an error;
 * - ROWIDs are 16-digit strings.
 */
import type { BulkJobStatus, BulkStore, BulkWriteJobRequest } from '../src/bulk-load.js';

export interface FakeTable {
  rows: Map<string, Record<string, string>>;
  bySource: Map<string, string>;
  unique: Set<string>;
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

export class FakeBulkStore implements BulkStore {
  readonly tables = new Map<string, FakeTable>();
  readonly objects = new Map<string, string>();
  readonly jobs = new Map<string, { status: BulkJobStatus; polls: number }>();
  /** Every CSV object's data row count, in upload order. */
  readonly objectRows: number[] = [];
  maxInIds = 0;
  calls = 0;
  private nextRow = 0;
  private nextJob = 0;
  /** Status reads that answer In-Progress before the final status. */
  polls = 1;
  /** Called before each object upload; throw to simulate a crash there. */
  beforePut?: (key: string) => void;
  /** Called after a job's rows landed, before the reply; throw to simulate a lost reply. */
  afterCreate?: (jobNumber: number) => void;

  constructor(readonly parents: Readonly<Record<string, string>> = {}) {}

  table(name: string): FakeTable {
    let table = this.tables.get(name);
    if (!table) {
      table = { rows: new Map(), bySource: new Map(), unique: new Set() };
      this.tables.set(name, table);
    }
    return table;
  }

  insert(name: string, row: Record<string, string>): string {
    const table = this.table(name);
    const rowid = (4n * 10n ** 15n + BigInt(++this.nextRow)).toString();
    table.rows.set(rowid, { ...row, ROWID: rowid });
    if (row.c2c_source_id) table.bySource.set(row.c2c_source_id, rowid);
    return rowid;
  }

  /** Stored c2c_source_id values of a table, with repeats. */
  sourceIds(name: string): string[] {
    return [...this.table(name).rows.values()].map((row) => row.c2c_source_id ?? '');
  }

  async putObject(bucket: string, key: string, csv: string): Promise<void> {
    this.calls += 1;
    this.beforePut?.(key);
    this.objects.set(`${bucket}/${key}`, csv);
    this.objectRows.push(parseCsv(csv).length - 1);
  }

  async createWriteJob(request: BulkWriteJobRequest): Promise<{ jobId: string }> {
    this.calls += 1;
    const csv = this.objects.get(`${request.object_details.bucket_name}/${request.object_details.object_key}`);
    if (csv === undefined) throw new Error('object not found');
    const jobId = String(++this.nextJob);
    const table = this.table(request.table_identifier);
    for (const map of request.fk_mapping ?? []) {
      const parent = this.parents[`${request.table_identifier}.${map.local_column}`];
      if (!parent || !this.table(parent).unique.has(map.reference_column)) {
        this.jobs.set(jobId, {
          polls: this.polls,
          status: { status: 'Failed', description: `The reference_column '${map.reference_column}' in fk_mapping of table ${request.table_identifier} is not a unique column` },
        });
        return { jobId };
      }
    }
    const [header, ...lines] = parseCsv(csv);
    const index = (rows: Iterable<Record<string, string>>, column: string): Map<string, string> => {
      const map = new Map<string, string>();
      for (const row of rows) if (row[column] !== undefined) map.set(row[column]!, row.ROWID!);
      return map;
    };
    const refs = new Map(
      (request.fk_mapping ?? []).map((map) => [
        map.local_column,
        index(this.table(this.parents[`${request.table_identifier}.${map.local_column}`]!).rows.values(), map.reference_column),
      ]),
    );
    const taken = new Map([...table.unique].map((column) => [column, index(table.rows.values(), column)]));
    let processed = 0;
    for (const line of lines) {
      const row: Record<string, string> = {};
      header!.forEach((name, i) => {
        if (line[i] !== '') row[name] = line[i]!;
      });
      let skip = false;
      for (const map of request.fk_mapping ?? []) {
        const value = row[map.local_column];
        if (value === undefined) continue;
        const found = refs.get(map.local_column)!.get(value);
        if (!found) skip = true;
        else row[map.local_column] = found;
      }
      if (skip) continue;
      for (const [column, values] of taken) if (row[column] !== undefined && values.has(row[column]!)) skip = true;
      if (skip) continue;
      const rowid = this.insert(request.table_identifier, row);
      for (const [column, values] of taken) if (row[column] !== undefined) values.set(row[column]!, rowid);
      processed += 1;
    }
    this.jobs.set(jobId, { polls: this.polls, status: { status: 'Completed', processed } });
    this.afterCreate?.(this.nextJob);
    return { jobId };
  }

  async writeJobStatus(jobId: string): Promise<BulkJobStatus> {
    this.calls += 1;
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`no job ${jobId}`);
    if (job.polls > 0) {
      job.polls -= 1;
      return { status: 'In-Progress' };
    }
    return job.status;
  }

  async rowIdsBySourceId(name: string, ids: readonly string[]): Promise<Map<string, string>> {
    this.calls += 1;
    if (ids.length > 300) throw new Error('ZCQL IN takes at most 300 values');
    this.maxInIds = Math.max(this.maxInIds, ids.length);
    const table = this.table(name);
    const out = new Map<string, string>();
    for (const id of ids) {
      const rowid = table.bySource.get(id);
      if (rowid) out.set(id, rowid);
    }
    return out;
  }

  async updateRows(name: string, rows: readonly Record<string, string>[]): Promise<string[]> {
    this.calls += 1;
    if (rows.length > 200) throw new Error('updateRows takes at most 200 rows');
    const table = this.table(name);
    const done: string[] = [];
    for (const row of rows) {
      const current = table.rows.get(row.ROWID!);
      if (!current) continue;
      Object.assign(current, row);
      done.push(row.ROWID!);
    }
    return done;
  }
}
