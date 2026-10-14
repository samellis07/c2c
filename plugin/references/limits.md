# Catalyst limits c2c budgets for

**Rule:** verify Catalyst limits empirically. A limit is enforced as a hard plan failure only when it is [TESTED] or [DOC]. [UNVERIFIED] limits produce warnings and a probe (`c2c probe <id>`), never a silent assumption. Probes create scratch resources prefixed `c2c_probe_<h8>` in the customer's project and delete them; each needs the user's OK.

| Limit | Value | Label | Enforcement | Probe |
|---|---|---|---|---|
| Columns per table (Development) | 100; "no upper limit" in Production | [DOC] (a higher figure of 325 is [UNVERIFIED]) | FAIL in plan; splitter to 1:1 side tables | P-COLS |
| Unique varchar columns per table | 2 → `403 INVALID_OPERATION … Reached max number of columns of Unique varchar type` | [TESTED] | FAIL in plan; app-level uniqueness beyond the cap | — |
| Foreign keys per table | 15 | [UNVERIFIED] | WARN; extra lookups as plain bigint ROWID | P-FK |
| Text-type columns per table | 130 | [UNVERIFIED] | WARN | P-COLS |
| varchar length | 255 clamp; REST insert **silently truncates** | [TESTED] | Values > 255 → `text`; validate before write | — |
| text length | 10,000; not searchable | [UNVERIFIED] | WARN | — |
| ZCQL rows per SELECT | 300 | [TESTED] | keyset paging | — |
| ZCQL offset | 1-based; 0 is clamped to 1 | [TESTED] | keyset paging by ROWID | P-OFFSET |
| ZCQL LIKE | `*` any run, `?` one char; `%` silently matches nothing | [TESTED] | translator emits `*` | P-LIKE |
| ZCQL JOINs | 4 (raise is per environment) | [DOC] | FAIL beyond 4 in plan; staged reads | P-JOIN (Dev **and** Prod) |
| ZCQL SELECT columns | 20 | [DOC]; not yet confirmed | project ≤ 20 until probed | P-WIDTH |
| ZCQL UPDATE/DELETE | stop silently at 300 rows | [TESTED] | loop + count verify | P-UPD300 |
| ZCQL subqueries in WHERE | supported (`IN (SELECT …)`) | [TESTED][DOC] | translator may use them | — |
| ZCQL INSERT error-after-write | `400 For input string: "nu"` **but the row was written** | [TESTED] | re-read after any ZCQL write error | — |
| Date strictness | REST stores `05-10-2026` as `0011-04-18` | [TESTED] | normalise to `yyyy-MM-dd` before write | — |
| double rounding | `0.105` → `0.10` silently | [TESTED] | HALF_UP client-side before write | — |
| Row insert batch | 200 rows per call | [TESTED] | mover batches ≤ 200 | — |
| Bulk write | 100,000 rows per job; needs CSV in Stratus; `find_by`, `fk_mapping` | [DOC] | only after P-BULK passes | P-BULK |
| Advanced I/O / AppSail request | 30 s, not raisable | [DOC][TESTED] | anything that can exceed ~25 s → Job function + poll | P-LAT |
| Job function | 15 min | [DOC] | chunk + self-resubmit with checkpoint | — |
| Function concurrency | ~10 per function in Dev | [UNVERIFIED] | bounded pool ≤ 10 | — |
| Data Store write rate | ~100 writes/min/table | [UNVERIFIED] | mover rate cap + `Retry-After` | P-RATE |
| Dev per-table row cap | hidden value, `API_LIMIT_REACHED … for row` | [UNVERIFIED] | WARN for large apps; rehearse elsewhere | — |
| Table creates per org | unpublished number and window; `403 API_LIMIT_REACHED … for table` has fired at a visible count above and below 200 and persisted after project deletes — a per-period quota or a count including unpurged tables | [TESTED] | WARN; on refusal stop creates, keep created tables, retry after 30/60/120 min; a delete may not free capacity at once | P-TABLES (count only) |
| Projects per account | 50 | [DOC] | FAIL in doctor D-F1 when no slot | — |
| App users in Development | 25 | [DOC]; a higher effective cap is [UNVERIFIED] | WARN | — |
| Dev API calls | 200k per application | [DOC] | WARN with the mover's call estimate | — |
| Stratus single object | 250 GB | [UNVERIFIED] | — | — |
| Slate `index.html` cache | `cache-control: public, max-age=31536000` | [TESTED] | hashed assets + versioned service worker | — |
| Creator API from Catalyst | 429 at ~1 req/min | [UNVERIFIED] | run the mover on the customer machine; queue + backoff | — |
| Unique under concurrency | duplicates persisted; lost updates | [TESTED] | never rely on unique for mutual exclusion; autonumber claim protocol | P-AN1 |
