# ZCQL rules for the c2c plugin

ZCQL is the query language over Data Store tables. Every rule below is
an imperative recipe: method, path, headers, body, success signal, and
the exact error codes with the action for each.

Token call envelope. Recipe: `POST
/baas/v1/project/<project-id>/query` with headers `Authorization`,
`Accept: application/vnd.catalyst.v2+json`, `X-CATALYST-Environment`,
and `CATALYST-ORG`, body
`{"query": "<statement>"}`. `<dc>` (the host's data centre) comes from
the customer config file; never hard-code it.

## Reads

### Unwrap every ZCQL result row by table name

Rule: result rows arrive wrapped per table. Map every result set with
`rows.map((r) => r.<TableName>)` before reading columns. Accessing
fields on the wrapped row is the most common Data Store bug; generated
handlers always unwrap first.

### Translate LIKE to star wildcards; percent matches nothing

Recipe: in ZCQL `LIKE`, `*` matches any run and `?` matches one
character, `_` is a literal, and SQL-style `%` matches zero rows with
HTTP 200 and no error.

Rule: emit `*` for a multi-character wildcard and `?` for a
single-character one. Translate contains to `LIKE '*<value>*'`,
starts-with to `LIKE '<value>*'`, ends-with to `LIKE '*<value>'`.
Warn when a user value holds a literal `*`; never emit `%`.

- A literal `_` never matches a space — `LIKE 'Vendor_Name 01'`
returns zero rows where `LIKE 'Vendor?Name 01'` returns one.
Translate user text by escaping or by `?`, never by passing `_`
through as a wildcard.

### Emit 1-based LIMIT offsets; prefer keyset paging

Recipe: `LIMIT <offset>,<count>` treats the offset as 1-based:
`LIMIT 0,2` and `LIMIT 1,2` return the same first two rows while
`LIMIT 2,2` returns rows two to three. Offset 0 is clamped to 1, never
an error.

Rule: emit offset `1 + skip` for user sorts. Prefer keyset paging
(`WHERE ROWID > <last> ORDER BY ROWID LIMIT 300`), which never
re-reads a boundary row.

### Page every SELECT at 300 rows

Recipe: a SELECT returns at most 300 rows per call with HTTP 200.

Rule: loop `LIMIT <offset>,300` (or keyset pages) until a short page
arrives, then assert the total against the expected count. Never
assume one SELECT drained the set.

### Assume at most 20 SELECT columns; never emit SELECT star on wide tables

Rule: assume a SELECT carries at most 20 columns. Never generate
`SELECT *` on wide or joined tables; project the needed columns
explicitly. `c2c plan` fails closed past the budget.

### Join at most 4 tables with one condition each across declared keys

Recipe: ZCQL joins run only across a declared foreign key between the
two tables.

Rule: emit at most 4 JOIN clauses with one condition each. The raise
path is per environment, so `c2c doctor` checks the raise in both
Development and Production before cutover. Past the cap, compose
staged reads or denormalise instead of joining.

- Joining on a non-key column answers `400` `ZCQL QUERY ERROR`
`No relationship between tables <a> and <b>` — joins exist only
across a declared foreign key.

### Use IN-subqueries for traversal filters

Recipe: `POST .../query` with
`SELECT * FROM <child> WHERE <col> IN (SELECT <col> FROM <parent>
WHERE ...)` returns HTTP 200 with the same rows as the equivalent
direct filter.

Rule: compile lookup-traversal criteria to one `IN (SELECT ...)`
query. Keep the chunked two-step plan only where the id set exceeds
page budgets.

### Expect every aggregate result as a string — parse before comparing

Recipe: `SELECT COUNT(ROWID), SUM(amt), AVG(amt), MAX(amt), MIN(amt)
FROM <table>` returns `{"COUNT(ROWID)":"200","SUM(amt)":"19900",
"AVG(amt)":"99.5000"}` — every value a string, keyed by the raw
expression text. `GROUP BY <col> HAVING COUNT(ROWID) > <n>` and
`DISTINCT` work.

Rule: read aggregate cells by the emitted key and `Number()` them;
never rely on JSON numeric typing from ZCQL.

## Writes

### Loop UPDATE and DELETE on the returned count

Recipe: a ZCQL `UPDATE` matching 350 rows applies to 300 and returns
300 row objects with HTTP 200; a `DELETE` matching 350 rows returns
200 with `{"DELETED_ROWS_COUNT": 300}`. The remainder stays unapplied
with no error.

Rule: loop the statement while the returned count is 300, then assert
zero rows remain. Never emit ZCQL bulk DML without the loop and a
final count assert.

### ZCQL rejects over-length varchar honestly

Recipe: `INSERT INTO <table> (v10) VALUES ('<16 chars>')` into a
varchar(10) returns 400 ("data too long for column") and writes
nothing; the same shape as `UPDATE` leaves the row unchanged.

Rule: rely on the rejection but still validate lengths client-side,
so one bad value never aborts a whole batch.

### Re-read after every ZCQL write error; a 400 can follow a write

Recipe: `INSERT` with date `'05-10-2026'` returns 400 (`ZCQL QUERY
ERROR`, `For input string`) while the row is already stored with the
rolled date. `INSERT` of `0.105` into a double returns 200 stored as
`0.1`.

Rule: re-read the row after ANY ZCQL write error before deciding the
write failed. Validate dates and doubles client-side exactly as for
REST rows, and read back after the write.

## Planning bounds

### Assume no user-tunable indexes and a capped execution budget

Rule: assume ZCQL has no user-configurable indexes ("Search Indexed"
serves search only, not filters), and assume a per-project query
execution budget that fails growing reports with a processing error.
Denormalise hot filter columns, load-test every report query at full
volume, and split long-running reads into staged pages. `c2c plan`
warns on unindexed filter columns and fails closed past the join and
width budgets.
