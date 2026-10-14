# Large data and platform limits

Code: `packages/data/src/bulk-load.ts` (chunked bulk load), `packages/deploy/src/bulk-store.ts`
(the REST calls it makes), `packages/shims/src/bulk-dml.ts` (ZCQL UPDATE/DELETE past 300 rows),
`packages/shims/src/long-work.ts` (accept, run as a Job, poll), `packages/shims/src/write-rules.ts`
(write validation). Tests: `packages/data/test/bulk-load.test.ts` (load test on an in-memory store),
`packages/shims/test/bulk-dml.test.ts`, `packages/shims/test/long-work.test.ts`,
`packages/deploy/test/bulk-store.test.ts`, `packages/deploy/test/table-limit.test.ts`.

## Bulk load (10k+ rows)

`insertRows` takes at most 200 rows per call. A larger table goes through the Data Store Bulk Write API
(https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/bulk-operations/):

```
POST {api}/baas/v1/project/{project}/bulk/write
     { "table_identifier": "<table>", "operation": "insert",
       "object_details": { "bucket_name": "<bucket>", "object_key": "<prefix>/<table>/chunk-00000.csv" },
       "fk_mapping": [ { "local_column": "<lookup column>", "reference_column": "<unique parent column>" } ] }
GET  {api}/baas/v1/project/{project}/bulk/write/{job_id}
     data.status: "In-Progress" | "Completed" (results.details[].records_processed) | "Failed" (results.description)
```

`bulkLoad` is a dry run unless `dryRun: false` is passed with a store. For each table, parents first:

1. Rows are pulled from the source lazily and cut into chunks (`BULK_CHUNK_ROWS`, 5000).
2. Every row is checked against the write rules (below). A refused row is named (table, source id,
   column, rule) and not sent.
3. Source ids already in the table are read back (ZCQL `IN`, at most 300 ids per query) and dropped.
4. Lookups are resolved (below), the chunk is written as one CSV object, and one write job is created.
5. The job is polled with backoff, bounded by the run's `deadline`. When it ends, the chunk's source
   ids are read back. A row a Completed job skipped is refused — `unknown-reference` when a mapped
   lookup's parent is not stored, else `not-stored` — and only those rows are retried on resume.
6. Self and cyclic lookups are written last, with row updates of at most 200 rows. The number of rows
   updated is checked, because `updateRows` skips an unknown ROWID without an error.

The bulk write job needs admin scope and a Stratus bucket holding the CSV. The object upload is
supplied by the caller. c2c does not handle a bucket credential.

### Lookups and fk_mapping

A lookup cell holds the parent's source id. `fk_mapping` lets the store replace it with the parent
ROWID, but only when the parent's `reference_column` is store-unique. Otherwise the job fails with
`The reference_column '<column>' in fk_mapping of table <id> is not a unique column`.
`c2c_source_id` is not unique by default (`docs/schema-mapping.md`). So the loader picks a method for
each lookup:

| Lookup | Method |
|---|---|
| Parent has a store-unique column holding the source id (`uniqueReference`) | `fk_mapping` on that column |
| Any other parent | `remap`: for each chunk, the parent ROWIDs it needs are read back (≤300 ids per query) and written into the CSV |
| Parent table not in this load (a subset load) | resolved against the store the same way — `fk_mapping` when the parent has a `uniqueReference`, else `remap` |
| Self lookup, or a lookup on a cycle | `deferred`: left empty on insert, then set by row update once every side has a ROWID |
| A multi lookup (JSON list cell) | `remap` for that chunk, because the store cannot map a list |

No table-wide id map is kept, so memory grows with the chunk size, not with the table. A lookup to a
parent that is not stored is refused (`unknown-reference`) and named.

### Resume and time boxes

The checkpoint records each chunk as `submitted` (with its job id) or `done` — a done chunk also
records the source ids it refused — and it is saved after every step. A run that stops, whether by a
crash, a lost reply after the store accepted a job, or a failed upload, resumes from the checkpoint:

- a submitted job is waited on, not resent;
- rows already stored are dropped before a chunk is sent (step 3), so no row is inserted twice even
  when the job landed but the checkpoint did not record it;
- a done chunk's refused ids are checked and sent again, so "fix the source and resume" lands them;
  while any refused row remains the result is `ok: false` and names them;
- a source that repeats an id is refused (`duplicate-source-id`) before any send, as in the
  row-by-row loader;
- a finished checkpoint sends nothing.

Chunks are keyed by position, so the source must yield the same rows in the same order on every run
of a checkpoint.

With `deadline`, the load stops between chunks — and stops waiting on a job — and returns
`complete: false`. The same checkpoint continues it. This lets a Job function run the load in
slices (see below).

### Load test

`bulk-load.test.ts` runs on an in-memory store that reproduces the job lifecycle, the fk_mapping
uniqueness rule, silent row skips, the 300-id `IN` cap and the 200-row update cap. It proves:

- 10,000 rows with a remapped lookup, and 50,000 rows with `fk_mapping` plus a self lookup, all land.
  Each source id is stored exactly once and every lookup points at its parent's ROWID.
- At most one chunk of source rows is ever held before upload. This is counted from outside the
  loader, as rows handed out by the source minus rows sent.
- After two different mid-load failures, the resumed run has no duplicate and no missing row. A
  further run is a no-op.
- A 20,000-row load runs as several Job slices behind a 202 reply and finishes from the saved cursor.

## UPDATE and DELETE past 300 rows

One ZCQL `UPDATE … WHERE` or `DELETE FROM … WHERE` changes at most 300 rows and returns no error for
the rest. `updateAllWhere` and `deleteAllWhere` repeat the statement, re-counting with
`SELECT COUNT(ROWID)` after each round, until nothing matches. They stop with `BulkDmlError` in
three cases:

- the round bound is reached: `ceil(matches / 300) + 2`, or `maxRounds`;
- a round makes no progress, such as an UPDATE whose SET does not take the row out of its WHERE;
- the first count differs from `expected`. In this case nothing is changed.

Generated handlers do not emit bulk ZCQL DML. A Deluge `update` or `delete` with criteria pages the
matches by ROWID and uses `updateRows`/`deleteRows` in chunks of 200 (`runtime.ts`).

## Work longer than the 30 s request cut

An Advanced I/O function (and AppSail) is cut at about 30 s, and that limit cannot be raised. A Job
function runs for up to 15 minutes. `runOrDefer` runs small work inline and answers 200. Larger
work, more than one 300-row page by default, is handled like this:

1. The handler writes a work status row (`queued`) and submits a Job (`submitJob` on the app's job
   pool) with the work id.
2. The handler answers **202** with `{ work_id, state, poll }` and `Location: /c2c/work/<work_id>`.
3. `runWorkSlice` runs inside the Job. It calls the work in steps and saves a cursor after each one.
   It stops before the slice limit (`JOB_SLICE_MS`, 12 min) and submits a fresh Job for what is left.
   It fails the work after `maxJobs` Jobs instead of resubmitting forever.
4. `pollWork` answers the status: `queued`, `running` (with progress), `done` (with the result) or
   `failed` (with the error). It never returns the cursor.

A retried request for the same work id gets 202 again without a second Job. The job queue and status
store are injected. Nothing is submitted in dry-run mode.

## Write validation

Data Store changes some values without an error:

- varchar past its length is truncated;
- a numeric date such as `05-10-2026` is stored as `0011-04-18`;
- a double with `decimal_digits 2` stores `0.105` as `0.10`;
- a double past 15 significant digits is altered.

c2c checks every write first (`write-rules.ts`): length, scale, date and datetime format, significant
digits, and mandatory values. The data loaders, including `bulkLoad`, refuse a bad value and name it.
The generated runtime and the deployed adapter first round a scale column half up (away from zero:
`0.105` → `0.11`, `-0.015` → `-0.02`) and then check. `bulkLoad({ roundScale: true })` applies that
rounding during a load too.

## Known limits

| Limit | Behaviour | What c2c does |
|---|---|---|
| **Org table limit** | Creating a table past it fails with `403 API_LIMIT_REACHED` "You have reached the max limit of your current API Limit for table". It is an org-wide limit on table creates; its value is not published [TESTED]. | `c2c plan` reports the app's Data Store table count (`counts.dataStoreTables` and the `org-tables` budget). Deploy stops at the first refused create. The error names the limit, the tables the app needs and the tables already created. On that refusal: stop creates, keep created tables, and retry later with growing waits (observed: the refusal cleared after 30 minutes to a few hours [TESTED]); a project delete may not free capacity at once. |
| insertRows / updateRows / deleteRows | 200 rows per call [TESTED] | chunked; update counts are checked |
| ZCQL SELECT | 300 rows per query [DOC]; `IN` lists of up to 300 values [TESTED] | keyset paging; `IN` reads chunked |
| ZCQL UPDATE / DELETE | 300 rows per statement, with no error for the rest [TESTED] | `updateAllWhere` / `deleteAllWhere` |
| Request cut (Advanced I/O, AppSail) | about 30 s, not raisable (Advanced I/O [DOC]; AppSail [UNVERIFIED]) | `runOrDefer` → Job + 202 + poll |
| Job function | 15 min [DOC] | `runWorkSlice` stops at 12 min and resubmits |
| Bulk write | needs admin scope and a Stratus bucket; `fk_mapping` needs a unique reference column [TESTED] | lookup method chosen per edge; upload injected |
