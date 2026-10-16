# Data Store rules for the c2c plugin

Data Store is the relational store behind Creator form data. Every rule
below is an imperative recipe: method, path, headers, body, polling,
success signal, and the exact error codes with the action for each.

Token call envelope. Recipe: send HTTPS calls to
`https://api.catalyst.<dc>` with headers `Authorization`,
`Accept: application/vnd.catalyst.v2+json`, and
`X-CATALYST-Environment` plus `CATALYST-ORG`. `<dc>` is the data centre
from the customer config file; never hard-code it. `<org-id>` and
`<project-id>` are placeholders for the customer's own ids.

## Tables and columns

### Create tables, then diff against the list on re-runs

Recipe: [UNVERIFIED] `POST /baas/v1/project/<project-id>/table` creates a table;
success is HTTP 200 with the new table id in the body. Read back with
`GET /baas/v1/project/<project-id>/table` and treat that list as the
source of truth.

Rule: [UNVERIFIED] c2c plan diffs the desired tables against the live list, so a
re-run creates nothing new. A mid-batch failure can leave a half-built
table; fix the cause and re-run the diff rather than recreating by hand.

### Re-read after a 5xx before re-sending a schema write

Recipe: [UNVERIFIED] a table or column create can answer `5xx` and still have
applied; the error means the response was lost, not that the write
failed.

Rule: [UNVERIFIED] on a `5xx` from `POST .../table` or
`POST .../table/<table-id>/column`, re-read the table or column list
before re-sending. A blind retry can create a duplicate name error or
leave a half-built object to reconcile.

### Create columns with a JSON array body

Recipe: [UNVERIFIED] `POST /baas/v1/project/<project-id>/table/<table-id>/column`
with the column definition wrapped in a single-element JSON array.

Rule: [UNVERIFIED] always send the array form. A plain JSON object is rejected with
`400 JSON_PARSE_ERROR` ("Check if the input json is proper").

### 250-column hard cap and 100-column default

Rule: [DOC] the documented default is 100 columns per table in
Development
(https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns/),
raisable on request — assume the raised hard cap is 250 [UNVERIFIED]
([L-COLUMNS](references/limits.md#l-columns-columns-per-table-development)).
`c2c plan` warns above 100, which relies on the raised cap of 250
[UNVERIFIED]. When a Creator form exceeds 250, plan splits overflow fields
into 1:1 side tables keyed by the parent ROWID and blocks an unsplittable
field group. `c2c doctor` D-F5 checks the generated table set against the
same cap and default; it does not read live tables. Assume at most 130
text-type (varchar plus text) columns per table [UNVERIFIED]; `c2c plan`
warns past that count and moves overflow text to Stratus before any write.

### Assume varchar stores at most 255 characters and truncates silently

Recipe: [TESTED] `POST /baas/v1/project/<project-id>/table/<table-id>/row`
returns HTTP 200 while storing only the leading characters of an
over-length varchar value
([L-VARCHAR-LENGTH](references/limits.md#l-varchar-length-varchar-length)).

Rule: [TESTED] refuse every varchar value longer than its `max_length` (assume
255 when the column definition carries none) before any write; never
clamp it, which is the same silent loss. Map any field that can hold
more than 255 characters (multi line, rich text, single line with a
larger or unknown-larger maxchar) to `text`. The `c2c migrate-data`
plan lists each over-length value by table, column and source id
(never the value), and a confirmed load refuses before the first
write. Read back byte-exact after the write. Never treat a 200 as
"stored what was sent".

### Assume text stores at most 10,000 characters and is not searchable

Rule: [UNVERIFIED] assume a text column holds at most 10,000 characters and cannot
be search-indexed. Keep searchable strings in varchar; move longer
rich text to a Stratus object and store the key. `c2c plan` warns when
a mapped field exceeds the budget.

### At most 2 unique varchar columns per table; unique int and bigint are free

Recipe: [TESTED] `POST .../table/<table-id>/column` with a unique varchar as the
third such column returns `403 INVALID_OPERATION` ("Reached max number
of columns of Unique varchar type")
([L-UNIQUE-VARCHAR](references/limits.md#l-unique-varchar-unique-varchar-columns-per-table)).
Unique `int` and unique `bigint`
columns return 200. Unique `text` returns 400 ("Text column cannot be
Unique"). `email` is not a column type, and `encrypted` is not a column
type (the encrypted type is `encrypted text`); a column create with
either name returns 400 `PATTERN_NOT_MATCHED` even with `is_unique`
set. That code is an invalid-type error, not a uniqueness failure.

Rule: [TESTED] model the migration idempotency key (numeric Creator ids fit in
int64) as a unique bigint. `c2c plan` fails closed when more than two
unique text fields are required and enforces the rest at app level.

### Assume at most 15 foreign-key columns per table

Recipe: [TESTED] `POST .../table/<table-id>/column` with body
`[{"column_name": ..., "data_type": "foreign key", "parent_table":
"<parent-table-id>", "constraint_type": "ON-DELETE-CASCADE"}]` returns
200; `ON-DELETE-SET-NULL` is the nulling alternative. The spaced token
is rejected: always send the hyphenated enum.

Rule: [UNVERIFIED] assume a table holds at most 15 foreign-key columns
([L-FOREIGN-KEYS](references/limits.md#l-foreign-keys-foreign-keys-per-table)).
Map the
first 15 lookups as real foreign keys with the parent table id and
`ON-DELETE-CASCADE`; store any further lookups as plain bigint ROWID
values without a constraint. `c2c plan` warns past the count. Declare
every foreign key at generation time: ZCQL joins only run across a
declared key.

## Rows

### Insert rows in batches of at most 200 per call

Recipe: [TESTED] `POST /baas/v1/project/<project-id>/table/<table-id>/row`
accepts an array body; send at most 200 rows per call
([L-ROW-BATCH](references/limits.md#l-row-batch-row-insert-batch)). A `/rows`
(plural) path answers `404 INVALID_URL_PATTERN`. Success is HTTP 200
with a `data` list holding one created record per sent row; assert the
count equals the sent count, and re-read when the shape is absent.

- [TESTED] `updateRows` and `deleteRows` cap at 200 ids per call as well
(`403 INVALID_OPERATION` on update, `400 INVALID_INPUT` "Length of ids
cannot be more than 200" on delete). A missing ROWID inside an update
or delete batch is silently skipped — the call returns fewer affected
rows with no error, so assert on the affected count.
- [UNVERIFIED] Success returns each row with `ROWID`, `CREATORID`, `CREATEDTIME`
and column defaults applied — read them back from the response rather
than re-querying.
- [UNVERIFIED] `deleteRow(<missing id>)` answers `404 INVALID_ID` ("No such row
with the given id exists"); `deleteRows` silently ignores missing ids.
- [UNVERIFIED] A varchar column keeps a 19-digit source id verbatim; remap lookup
fields to the parent ROWID before insert, convert `dd-MMM-yyyy` to
`yyyy-MM-dd`, carry decimals in `double` and booleans as JSON
`true`/`false` — a manual `/row` load with those transforms stores
every row and a ZCQL join resolves the remapped keys.

### Read rows back over MCP in pages of at most 300

Recipe: [TESTED] MCP `CatalystbyZoho_Get_Rows` takes `max_rows` up to 300;
`max_rows: 1000` answers `INVALID_OPERATION` "max_rows cannot be more than
300" even though the tool text says 1000. Send 300 and follow `next_token`
until `more_records` is false. Not every MCP server exposes
`Execute_Query`; when it is absent, reconcile counts and values from the
paged `Get_Rows` read-back.

### Take migrated rows from the JSON report export — it always carries record ids

Recipe: [UNVERIFIED] a Creator report exported as JSON carries each record's `ID`;
the same report's CSV export carries it only when the export includes
the `ID` column. All three forms occur (a CSV with the ID
column, a CSV without it, and JSON), so prefer JSON.
Lookup fields export as their display values, and subform rows arrive flattened
into the parent record's columns.

Rule: [UNVERIFIED] pull source rows from the JSON report export so the
`c2c_source_id` remap keys are real record ids. A CSV without an `ID`
column still loads, but its ids are derived from unique/mapped columns
(the plan lists them under `derived ids`): lookups then match on display
values instead of record IDs. Split flattened
subform columns into child-table rows under an explicit splitting rule
per subform. Refuse to map a lookup whose display value matches more
than one parent row — a display value is not a key.

### Validate every value client-side; the store coerces silently

Recipe: [TESTED] the following inputs all return HTTP 200 with a mutated stored
value ([L-DATE-WRITE](references/limits.md#l-date-write-date-strictness),
[L-DOUBLE-ROUNDING](references/limits.md#l-double-rounding-double-rounding)):
varchar longer than `max_length` (truncated); date
`"05-10-2026"` (stored as `0011-04-18`); `"2026-13-45"` (rolled to
`2027-02-14`); `"2026-02-30"` (rolled to `2026-03-02`); double `0.105`
(stored `0.1`); `-0.015` (stored `-0.01`); `0.125` (stored `0.12`).
Only `"10/05/2026"`-style strings, non-date strings, and `1e400`-style
overflow are rejected with `400 INVALID_INPUT`. Correct shapes on the
REST `/row` path are `"2026-10-05"` and `"2026-10-05T10:00:00"`. The
SDK `insertRows` path is stricter: a `datetime` accepts only
`yyyy-MM-dd HH:mm:ss` (a date-only `yyyy-MM-dd` stores `00:00:00`),
and ISO-8601 `T`/`Z`/offset forms, millisecond suffixes, `HH:mm`,
display strings and epoch values answer `400 INVALID_INPUT`
("datetime value expected"). Values are stored and compared as naive
wall-clock strings on both paths.

Rule: [TESTED] normalise every date to `yyyy-MM-dd` with a real calendar check,
round every double with HALF_UP to the column's decimal digits, bound
doubles to `max_length`, and refuse an over-length varchar before any
write.
Read back after the write.

### Set column default_value and also send defaults in the payload

Recipe: [UNVERIFIED] REST inserts apply a column's `default_value` when the column
was created with one. A blank stored value means the column create
omitted `default_value`, not that the insert path ignored it.

Rule: [UNVERIFIED] set `default_value` on the column at creation and also send the
value in the mover payload.

### Surface duplicate and mandatory failures with field name and status

Recipe: [UNVERIFIED] inserting a duplicate unique value returns `409
DUPLICATE_VALUE` ("Duplicate value for ..."); omitting a mandatory
column returns `403 MANDATORY_MISSING` ("Column ... is mandatory and
cannot be empty").

Rule: [UNVERIFIED] surface both shapes in the handler with the field name and the
original status code. Never collapse them into one opaque 500.

### Keep ids and integers as strings end to end

Recipe: [UNVERIFIED] `ROWID`, `CREATORID`, `int`, and `bigint` columns arrive as
JSON strings; `double` arrives as a JSON number; `boolean` arrives as
a JSON boolean. A 19-digit bigint already exceeds float precision.

Rule: [UNVERIFIED] carry every id, int, and bigint as a string from read through
write; never parse one into a Number. Parse doubles as numbers only
inside 15 digits.

- `CREATORID` records the calling principal's project `user_id` — an
admin-scope write stamps the admin, and a `scope:'user'` SDK init
without a signed-in app user fails `no user credentials present`.

### Read CREATEDTIME and MODIFIEDTIME as project-zone strings

Recipe: [UNVERIFIED] system columns are stored and compared in the project time
zone as `yyyy-MM-dd HH:mm:ss:SSS` (colon before milliseconds). The
function runtime itself is UTC; the project zone arrives in
`CATALYST_PROJECT_TIMEZONE`.

Rule: [UNVERIFIED] format and parse both with the project zone; a UTC literal
misses a row in a non-UTC window.

### There is no decimal, currency, or percent column type

Recipe: [UNVERIFIED] `POST .../column` with `data_type` of `decimal`, `numeric`,
`currency`, `percent`, `float`, `bigdecimal`, or `number` returns 400
`PATTERN_NOT_MATCHED`.

Rule: [UNVERIFIED] store currency in a `double` with `max_length` 15 and
`decimal_digits` 2 (exact equality and `SUM` inside that budget) with
client-side HALF_UP rounding before write, and keep an exact-string
shadow column for values beyond 15 digits or 4 decimal places.

## Permissions and environments

### Grant App User writes per table in the console

Rule: [UNVERIFIED] the App User role carries SELECT by default; enable INSERT,
UPDATE, and DELETE per table under Table Scopes and Permissions for
every table app users must write. Never assign the App Administrator
role to end users; it grants full access to all tables. Permission and
scope write routes answer the automation token with 401, so set them
in the console; custom-role grants go in the greenfield import
template or the console.

### Plan schema against Development only; load rows anywhere

Recipe: [UNVERIFIED] under the `X-CATALYST-Environment: Production` header, row
inserts and all reads return 200 while `POST /table` and
`POST /table/<table-id>/column` return `406 INVALID_OPERATION` ("You
cannot perform this operation for current environment").

Rule: [UNVERIFIED] never plan table or column creation against the Production
header. Load rows straight into Production after the console
promotion instead.

## Concurrency, rate, and quota

### Never rely on unique columns or read-modify-write under concurrency

Recipe: [TESTED] parallel inserts of one unique value store duplicates with a
mix of 200, 409, and 429 responses
([L-UNIQUE-RACE](references/limits.md#l-unique-race-unique-under-concurrency)).
`UPDATE ... SET cnt = cnt + 1`
returns 200 while landing a fraction of the increments; 20 parallel
read-modify-write cycles leave a counter at 1.

Rule: [TESTED] never use a unique column for mutual exclusion or dedup under
load, and never sequence through a counter column. Allocate ids
client-side (key shards, claimed ranges) or serialise through one
writer. Treat unique columns as best-effort with a reconciler.

- The Cache offers no put-if-absent — parallel `put`s on one key all
succeed — so a cache key cannot be a mutex either.

### There is no multi-call transaction; design resumable steps

Rule: [UNVERIFIED] atomicity covers one call only; no endpoint groups calls. Build
the mover as idempotent, resumable per-call steps with a journal, and
roll back with compensation on error. Never emit a "transaction"
assumption in generated code.

- One call is atomic: a single bad row (duplicate, wrong type, bad
date) fails the whole batch with the row's own status and nothing is
written. Rows written by an earlier call are never rolled back.

### Assume about 100 writes per minute per table; back off on 429

Rule: [UNVERIFIED] assume roughly 100 write requests per minute per table. Send
bulk loads through bulk write, bound client concurrency to 10 or
fewer, honour `Retry-After`, and retry 429s idempotently. Never write
rows from the browser in bursts; go through a function or a batch.

### There is no quota read endpoint; surface limit codes raw

Recipe: [TESTED] guessed quota paths (`/limits`, `/quota`, `/usage`,
per-table limits) all return `404 INVALID_URL_PATTERN`.

Rule: [TESTED] budget projects, tables, columns, and calls manually; `c2c
doctor` reports the counts it can read. On `API_LIMIT_REACHED`,
surface the raw code with the affected table; never assume quota ran
out. Assume Development tables may refuse rows past an undisclosed
count [UNVERIFIED]
([L-DEV-ROW-CAP](references/limits.md#l-dev-row-cap-dev-per-table-row-cap)),
while an org-wide table-create limit with no published
number or window can refuse a create at any visible count [TESTED]
([L-TABLE-CREATES](references/limits.md#l-table-creates-table-creates-per-org));
rehearse full-volume loads outside Development.

### NoSQL tables are console-only; prefer child tables

Recipe: [UNVERIFIED] `POST /baas/v1/project/<project-id>/nosqltable` answers
`401 OAUTH_SCOPE_MISMATCH` ("invalid oauth scope to access this URL")
while `GET` on the same path returns `200 {"status":"success","data":[]}`.
A NoSQL table answers on its partition key only.

Rule: [UNVERIFIED] keep report data in relational child tables, not NoSQL. Create
a NoSQL table in the console only when nothing else fits.

### Bulk-write `records_processed` counts attempted rows, not written rows [UNVERIFIED]

Recipe: [UNVERIFIED] a Completed bulk-write job against a table with a unique int
column, fed a 5-row CSV where 2 rows duplicate unique values already in
the same file, reports `records_processed` `"5"` while only 3 rows land
(the first occurrence of each value is kept). The same job over a 5-row
CSV with 2 non-numeric values in an int column also reports
`records_processed` `"5"` while 3 rows land. The job's downloadable
error CSV lists each rejected row with its file row number and the
per-row failure ("Duplicate value for <col>"; "Invalid input value for
<col>. int value expected").

Rule: [UNVERIFIED] never treat `records_processed` as a write count or diff it
against the CSV length as a health check — it counts every input row,
failed ones included. Reconcile a bulk job by re-counting the table and
downloading the error CSV; a `Completed` job with a non-empty error
report is a partial success, not a failure.

## Creator MCP tools

### Read Creator form structure over MCP via ZohoCreator_getFormMetadata

Recipe: [TESTED] on a duplicated app, `ZohoCreator_getForm` sent with the `environment: development` header returned code 30150 ("The requested operation is supported only in the development environment"); sent without that header it returned code 30180 ("The 'environment' header is required").

Rule: [MCP-LISTED] `ZohoCreator_getFormMetadata` is listed in the Creator MCP connector as the form-structure read; no successful call has been recorded yet.

### Read Creator application inventory via ZohoCreator_getApplicationSummary

Recipe: [TESTED] guessed tool name `getAppMetadata` does not exist in the Creator MCP connector; `ZohoCreator_getApplicationSummary` (query `id_required: false`) returned `status: success`, code 3000, with the app's `app_info` on duplicated apps.

Rule: [TESTED] use `ZohoCreator_getApplicationSummary` to read the application structure and component inventory.

### Throttle Creator app duplication to 8 calls per minute

Recipe: [TESTED] `ZohoCreator_duplicateApplication` calls exceeding approximately 8 calls per minute return error code 2955.

Rule: [TESTED] space application duplication requests to stay within 8 calls per minute and back off when error code 2955 is returned.
