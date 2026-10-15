# Catalyst limits c2c budgets for

**Rule:** verify Catalyst limits empirically. A limit is enforced as a hard plan failure only when it is [TESTED] or [DOC]. [UNVERIFIED] limits produce warnings and identify a probe that still needs an implementation; never treat the assumption as fact. The CLI probe command is not available yet. Any future probe that creates scratch resources in the customer's project needs the user's OK and must delete them.

Every row below has a stable limit id (`L-…`). Skills cite the id of each limit their verb can hit and link to the row. The behaviour verbs are **refuse** (c2c stops or fails the plan), **split** (c2c moves the work elsewhere: side table, Stratus, Job, page), and **warn** (c2c continues with a warning and a probe).

| ID | Limit | Behaviour |
|---|---|---|
| [L-COLUMNS](#l-columns-columns-per-table-development) | Columns per table (Development) | refuse + split |
| [L-UNIQUE-VARCHAR](#l-unique-varchar-unique-varchar-columns-per-table) | Unique varchar columns per table | refuse |
| [L-FOREIGN-KEYS](#l-foreign-keys-foreign-keys-per-table) | Foreign keys per table | warn |
| [L-TEXT-COLUMNS](#l-text-columns-text-type-columns-per-table) | Text-type columns per table | warn |
| [L-VARCHAR-LENGTH](#l-varchar-length-varchar-length) | varchar length | split |
| [L-TEXT-LENGTH](#l-text-length-text-length) | text length | warn |
| [L-ZCQL-ROWS](#l-zcql-rows-zcql-rows-per-select) | ZCQL rows per SELECT | split |
| [L-ZCQL-OFFSET](#l-zcql-offset-zcql-offset) | ZCQL offset | split |
| [L-ZCQL-LIKE](#l-zcql-like-zcql-like) | ZCQL LIKE | map |
| [L-ZCQL-JOINS](#l-zcql-joins-zcql-joins) | ZCQL JOINs | refuse + split |
| [L-ZCQL-WIDTH](#l-zcql-width-zcql-select-columns) | ZCQL SELECT columns | refuse |
| [L-ZCQL-WRITE-BATCH](#l-zcql-write-batch-zcql-updatedelete) | ZCQL UPDATE/DELETE | batch |
| [L-ZCQL-SUBQUERIES](#l-zcql-subqueries-zcql-subqueries-in-where) | ZCQL subqueries in WHERE | allow |
| [L-ZCQL-WRITE-VERIFY](#l-zcql-write-verify-zcql-insert-error-after-write) | ZCQL INSERT error-after-write | verify |
| [L-DATE-WRITE](#l-date-write-date-strictness) | Date strictness | normalize |
| [L-DOUBLE-ROUNDING](#l-double-rounding-double-rounding) | double rounding | normalize |
| [L-ROW-BATCH](#l-row-batch-row-insert-batch) | Row insert batch | batch |
| [L-BULK-WRITE](#l-bulk-write-bulk-write) | Bulk write | refuse until probed |
| [L-REQUEST-TIME](#l-request-time-advanced-io--appsail-request) | Advanced I/O / AppSail request | split |
| [L-JOB-TIME](#l-job-time-job-function) | Job function | split |
| [L-FUNCTION-CONCURRENCY](#l-function-concurrency-function-concurrency) | Function concurrency | cap |
| [L-WRITE-RATE](#l-write-rate-data-store-write-rate) | Data Store write rate | cap |
| [L-DEV-ROW-CAP](#l-dev-row-cap-dev-per-table-row-cap) | Dev per-table row cap | warn |
| [L-TABLE-CREATES](#l-table-creates-table-creates-per-org) | Table creates per org | warn + retry |
| [L-PROJECTS](#l-projects-projects-per-account) | Projects per account | refuse |
| [L-DEV-USERS](#l-dev-users-app-users-in-development) | App users in Development | warn |
| [L-DEV-API-CALLS](#l-dev-api-calls-dev-api-calls) | Dev API calls | warn |
| [L-STRATUS-OBJECT](#l-stratus-object-stratus-single-object) | Stratus single object | note |
| [L-SLATE-CACHE](#l-slate-cache-slate-indexhtml-cache) | Slate `index.html` cache | version |
| [L-CREATOR-EGRESS](#l-creator-egress-creator-api-from-catalyst) | Creator API from Catalyst | queue |
| [L-UNIQUE-RACE](#l-unique-race-unique-under-concurrency) | Unique under concurrency | refuse |

## Schema shape

### L-COLUMNS: Columns per table (Development)

Hard cap: 250 columns per table [UNVERIFIED]. Default: 100 columns [UNVERIFIED]. Behaviour: warn above the default; refuse above 250 and split overflow fields into 1:1 side tables. Probe: P-COLS.

### L-UNIQUE-VARCHAR: Unique varchar columns per table

Value: 2, else `403 INVALID_OPERATION … Reached max number of columns of Unique varchar type`. Label: [TESTED]. Behaviour: refuse — `c2c plan` fails past 2; app-level uniqueness beyond the cap. Probe: none.

### L-FOREIGN-KEYS: Foreign keys per table

Value: 15. Label: [UNVERIFIED]. Behaviour: warn — extra lookups as plain bigint ROWID. Probe: P-FK.

### L-TEXT-COLUMNS: Text-type columns per table

Value: 130. Label: [UNVERIFIED]. Behaviour: warn. Probe: P-COLS.

### L-VARCHAR-LENGTH: varchar length

Value: 255 clamp; REST insert **silently truncates**. Label: [TESTED]. Behaviour: split — values longer than 255 go to `text`; validate before write. Probe: none.

### L-TEXT-LENGTH: text length

Value: 10,000; not searchable. Label: [UNVERIFIED]. Behaviour: warn. Probe: none.

## Reads

### L-ZCQL-ROWS: ZCQL rows per SELECT

Value: 300. Label: [TESTED]. Behaviour: split — keyset paging. Probe: none.

### L-ZCQL-OFFSET: ZCQL offset

Value: 1-based; 0 is clamped to 1. Label: [TESTED]. Behaviour: split — keyset paging by ROWID. Probe: P-OFFSET.

### L-ZCQL-LIKE: ZCQL LIKE

Value: `*` any run, `?` one char; `%` silently matches nothing. Label: [TESTED]. Behaviour: map — translator emits `*`. Probe: P-LIKE.

### L-ZCQL-JOINS: ZCQL JOINs

Value: 4 (raise is per environment). Label: [DOC]. Behaviour: refuse — `c2c plan` fails past 4; staged reads. Probe: P-JOIN (Dev **and** Prod).

### L-ZCQL-WIDTH: ZCQL SELECT columns

Value: 20. Label: [DOC]; not yet confirmed. Behaviour: refuse — project at most 20 until probed. Probe: P-WIDTH.

### L-ZCQL-SUBQUERIES: ZCQL subqueries in WHERE

Value: supported (`IN (SELECT …)`). Label: [TESTED][DOC]. Behaviour: allow — translator may use them. Probe: none.

## Writes

### L-ZCQL-WRITE-BATCH: ZCQL UPDATE/DELETE

Value: stop silently at 300 rows. Label: [TESTED]. Behaviour: batch — loop with count verify. Probe: P-UPD300.

### L-ZCQL-WRITE-VERIFY: ZCQL INSERT error-after-write

Value: `400 For input string: "nu"` **but the row was written**. Label: [TESTED]. Behaviour: verify — re-read after any ZCQL write error. Probe: none.

### L-DATE-WRITE: Date strictness

Value: REST stores `05-10-2026` as `0011-04-18`. Label: [TESTED]. Behaviour: normalize — normalise to `yyyy-MM-dd` before write. Probe: none.

### L-DOUBLE-ROUNDING: double rounding

Value: `0.105` → `0.10` silently. Label: [TESTED]. Behaviour: normalize — HALF_UP client-side before write. Probe: none.

### L-ROW-BATCH: Row insert batch

Value: 200 rows per call. Label: [TESTED]. Behaviour: batch — mover batches of at most 200. Probe: none.

### L-BULK-WRITE: Bulk write

Value: 100,000 rows per job; needs CSV in Stratus; `find_by`, `fk_mapping`. Label: [DOC]. Behaviour: refuse — only after P-BULK passes. Probe: P-BULK.

## Time and concurrency

### L-REQUEST-TIME: Advanced I/O / AppSail request

Value: 30 s, not raisable. Label: [DOC][TESTED]. Behaviour: split — anything that can exceed ~25 s becomes a Job function with poll. Probe: P-LAT.

### L-JOB-TIME: Job function

Value: 15 min. Label: [DOC]. Behaviour: split — chunk with self-resubmit and checkpoint. Probe: none.

### L-FUNCTION-CONCURRENCY: Function concurrency

Value: ~10 per function in Dev. Label: [UNVERIFIED]. Behaviour: cap — bounded pool of at most 10. Probe: none.

### L-UNIQUE-RACE: Unique under concurrency

Value: duplicates persisted; lost updates. Label: [TESTED]. Behaviour: refuse — never rely on unique for mutual exclusion; autonumber claim protocol. Probe: P-AN1.

## Volume and organisation

### L-WRITE-RATE: Data Store write rate

Value: ~100 writes/min/table. Label: [UNVERIFIED]. Behaviour: cap — mover rate cap with `Retry-After`. Probe: P-RATE.

### L-DEV-ROW-CAP: Dev per-table row cap

Value: hidden value, `API_LIMIT_REACHED … for row`. Label: [UNVERIFIED]. Behaviour: warn — warn for large apps; rehearse elsewhere. Probe: none.

### L-TABLE-CREATES: Table creates per org

Value: unpublished number and window; `403 API_LIMIT_REACHED … for table` has fired at a visible count above and below 200 and persisted after project deletes — a per-period quota or a count including unpurged tables. Label: [TESTED]. Behaviour: warn + retry — on refusal stop creates, keep created tables, retry after 30/60/120 min; a delete may not free capacity at once. Probe: P-TABLES (count only).

### L-PROJECTS: Projects per account

Value: 50. Label: [DOC]. Behaviour: refuse — fail in doctor D-F1 when no slot. Probe: none.

### L-DEV-USERS: App users in Development

Value: 25. Label: [DOC]; a higher effective cap is [UNVERIFIED]. Behaviour: warn. Probe: none.

### L-DEV-API-CALLS: Dev API calls

Value: 200k per application. Label: [DOC]. Behaviour: warn — with the mover's call estimate. Probe: none.

## Files and UI

### L-STRATUS-OBJECT: Stratus single object

Value: 250 GB. Label: [UNVERIFIED]. Behaviour: note — no c2c action; Creator file uploads stay far below this size. Probe: none.

### L-SLATE-CACHE: Slate `index.html` cache

Value: `cache-control: public, max-age=31536000`. Label: [TESTED]. Behaviour: version — hashed assets with a versioned service worker. Probe: none.

## Cross-system calls

### L-CREATOR-EGRESS: Creator API from Catalyst

Value: 429 at ~1 req/min. Label: [UNVERIFIED]. Behaviour: queue — run the mover on the customer machine; queue with backoff. Probe: none.
