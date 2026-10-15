# Limits

Budget every plan against the numbers below. `<dc>` comes from config. Never hard-code a data centre. Placeholders are `<org-id>` and `<project-id>`. A token call uses host `https://api.catalyst.<dc>` and header names Authorization, Accept, X-CATALYST-Environment, and CATALYST-ORG. Set Accept to `application/vnd.catalyst.v2+json`. There is no limits endpoint: a GET of `/limits`, `/quota`, or `/usage` returns `404 INVALID_URL_PATTERN` [TESTED]. c2c plan counts local schema and c2c doctor counts live resources before a create.

See also: https://docs.catalyst.zoho.com/en/cloud-scale/help/zcql/syntax-exceptions/

## Data Store schema

### Columns per table

Rule: Plan for 250 columns per table [UNVERIFIED], the raised cap; the stated default is 100 columns per table [UNVERIFIED]. c2c plan warns when a table exceeds 100 columns because it relies on the raised cap (confirm with P-COLS). When a Creator form exceeds 250 columns, c2c plan splits overflow fields into 1:1 side tables keyed by the parent ROWID; it blocks a field group that cannot fit. c2c doctor D-F5 checks the generated table set against the same cap and default; it does not read live tables. Do not plan a wider physical table in Development or Production.

Recipe: GET /baas/v1/project/<project-id>/table/<table-id>/column with the token headers. Success is a column array whose length plus the planned additions is at most 250. On a refusal while adding a column, stop and split.

### Text-type columns per table

Rule: Plan for 130 text-type columns (varchar plus text) per table [UNVERIFIED]. c2c plan checks the text-type count before create and moves overflow text into Stratus, leaving a varchar key column.

Recipe: Same column list as the columns-per-table rule. Count columns whose data_type is varchar or text. Success is a count of at most 130.

### Varchar length

Rule: Size each varchar to its max_length, and assume a max_length of at most 255 [TESTED]. A REST insert or update returns HTTP 200 and stores only the first max_length characters. A ZCQL INSERT or UPDATE of a longer value returns 400 and writes nothing. c2c plan maps a single-line field longer than 255 to text, and the writer checks length before the call.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row with a JSON array of row objects. Read the row back. Success for a safe value is an exact match. A ZCQL overflow returns `400` and `'…' data too long for column '…'`.

### Text length

Rule: Plan for 10000 characters per text column, and assume a text column is not searchable [UNVERIFIED]. c2c plan checks the length before create and stores a longer value as a Stratus object plus a key column.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row. Success is a read-back whose text field equals the submitted value. Do not mark the column searchable.

### Unique varchar columns

Rule: At most 2 columns per table may be data_type varchar with is_unique true [TESTED]. Unique int and unique bigint do not use that budget. A text column cannot be unique. `email` and bare `encrypted` are not valid column data_type names; store an email as text with an app-side email check, and store an encrypted value as `encrypted text`. c2c plan checks the unique-varchar count and keeps database uniqueness on at most two fields; the handler enforces the rest. Prefer a unique bigint for an integer source id. Keep `c2c_source_id` nullable and not unique.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/column with a JSON array body. A third unique varchar returns `403 INVALID_OPERATION` and `Reached max number of columns of Unique varchar type`. The whole column batch is refused. Unique int or bigint returns 200. Unique text returns `400` and `Text column cannot be Unique`. data_type `email` or bare `encrypted` returns `400 PATTERN_NOT_MATCHED` even when is_unique is set. Use a valid data_type. Do not drop is_unique to clear that error.

### Foreign keys per table

Rule: Plan for 15 foreign keys per table [UNVERIFIED]. c2c plan checks the foreign-key count and stores lookups past 15 as plain bigint ROWID columns with no constraint.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/column with a JSON array whose element names the parent table and ON DELETE behaviour (CASCADE or SET NULL). Success is 200 and a later ZCQL INNER JOIN on that column. The 16th foreign key is not created; store the ROWID as bigint.

### No decimal column type

Rule: Do not send data_type decimal, numeric, currency, percent, float, bigdecimal, or number [TESTED]. Store a value of at most 15 digits and 2 decimal places as double with max_length 15 and decimal_digits 2. Store a wider or finer value as varchar, with an optional double shadow column.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/column with a one-element JSON array. Any of those data_type names returns `400 PATTERN_NOT_MATCHED`. double with decimal_digits 2 returns 200.

### Double rounding

Rule: Round a double HALF_UP to its decimal_digits before every write [TESTED]. A REST or ZCQL write that skips this stores a shorter value and still returns 200. `0.105` is stored as `0.1`, `-0.015` as `-0.01`, and `0.125` as `0.12`. c2c plan checks that the writer rounds before insert, update, and bulk write.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row, then GET the row. Success is a stored value equal to the HALF_UP value, not merely HTTP 200.

### Date values on write

Rule: Send dates only as `yyyy-MM-dd` and datetimes only as `yyyy-MM-dd HH:mm:ss` [TESTED]. Omit a blank date or send null. Never send an empty string. A REST write returns 200 and stores a different calendar date for a day-month-year string or an impossible date (`05-10-2026` stores as `0011-04-18`, `2026-13-45` as `2027-02-14`, `2026-02-30` as `2026-03-02`). c2c plan checks that every date is normalised before write.

Recipe: POST or PUT /baas/v1/project/<project-id>/table/<table-id>/row, then read the row back. Success is an exact date match. `10/05/2026`, `abc`, and `1e400` return `400 INVALID_INPUT`.

### Identifier width

Rule: Keep ROWID, CREATORID, int, and bigint as strings end to end [TESTED]. ZCQL returns them as JSON strings. A 19-digit integer does not fit in a JavaScript number. Parse only doubles as numbers, and keep a double as a string when it has more than 15 digits.

Recipe: POST /baas/v1/project/<project-id>/query with body `{"query":"SELECT ROWID, <bigint-column> FROM <table>"}`. Success is string JSON for those fields. Do not Number() them.

## Data Store volume

### Tables per organisation

Rule: No organisation table limit is published — neither the number nor its window appears in the docs, the console, or an API [TESTED]. Treat `403 API_LIMIT_REACHED` with `… API Limit for table` as an org-wide limit on table creates, shared by every project and environment, not a fixed count cap: the refusal has fired at a visible count above and below 200, and has persisted right after project deletes, so it behaves like a per-period create quota or a count that still includes tables whose purge has not run. On the refusal, stop creating tables and keep what was created; table-free work (redeploys, data loads, smoke) can continue. Back off and re-measure — retry the create after 30 minutes, then 60, then 120. Deleting a project may not free capacity immediately. c2c doctor counts tables with CatalystbyZoho_List_All_Tables (or GET /baas/v1/project/<project-id>/table on each project) to report headroom; no count predicts the refusal.

Recipe: MCP CatalystbyZoho_List_All_Tables with headers Catalyst-org and Environment and path_variables.projectId. Success is a reported count plus creates that succeed; a `403 API_LIMIT_REACHED` on POST /table is the stop signal, and success on retry comes after a backoff window, not straight after a delete.

### Rows per Development table

Rule: Assume a Development table can refuse further inserts [UNVERIFIED]. c2c plan checks the estimated row count and warns when the load is large. On `API_LIMIT_REACHED` whose message says the max limit for row, stop that table. Do not treat the code as proof the account is over quota; show the raw code and the table name.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row. The refusal body is `{ message: 'You have reached the max limit of your current API Limit for row', code: 'API_LIMIT_REACHED' }`. Success for a small batch is HTTP 200 and a matching COUNT(ROWID).

### Rows per Production table

Rule: Assume Production has no per-table row cap [UNVERIFIED]. c2c plan still chunks the load and checks COUNT(ROWID) after each table. Schema creates under the Production environment header are refused; load rows only after the tables exist.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row with X-CATALYST-Environment set to Production. Success is HTTP 200. POST /table under that header returns `406 INVALID_OPERATION`.

### Row insert batch

Rule: Send at most 200 rows per insert call [DOC]. c2c migrate-data checks the batch length and splits above 200.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row with a JSON array of at most 200 objects. Path ends in `/row`, never `/rows`. Success is HTTP 200 and a `data` array as long as the batch. Read-back: `SELECT COUNT(ROWID) FROM <table>`.

### Write rate per table

Rule: Plan for 100 writes per minute per table [UNVERIFIED]. Job functions share one rate bucket. c2c migrate-data checks the pace, stays at or under that rate, and honours Retry-After. Parallel jobs on the same table share the budget.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row paced to 100 calls per minute. On HTTP 429, sleep for Retry-After and retry the same idempotent batch.

### Concurrent Data Store calls

Rule: Plan for 10 concurrent executions against one table [UNVERIFIED]. c2c migrate-data checks the in-flight count and keeps the pool at or below 10. A wider fan-out returns 429 or `Concurrency limit reached for the feature COMPONENT`.

Recipe: Bound the insert pool to 10. Success is a run with no 429. On 429 or that concurrency string, shrink the pool and retry.

### Bulk write job size

Rule: Plan for 100000 rows per bulk-write job [UNVERIFIED]. c2c plan checks the CSV row count and splits a larger file. Use bulk write only after a small CSV job reaches status Completed and the row read-back matches. Unmatched fk_mapping keys are dropped with no error row.

Recipe: PUT the CSV to `https://<bucket>-development.zohostratus.<dc>/<object-key>` with headers Authorization, CATALYST-ORG, X-CATALYST-Environment, compress, and Content-Type. Then POST /baas/v1/project/<project-id>/bulk/write with table_identifier, operation (`insert`, `update`, or `upsert`), object_details.bucket_name, object_details.object_key, optional find_by, and optional fk_mapping. Poll GET /baas/v1/project/<project-id>/bulk/write/<job-id> until Completed. Success is Completed plus COUNT(ROWID) and parent ROWIDs in the mapped column. A `.json` object returns `400` and `Invalid Operation! The object should be of .csv file format.`

### Bulk read page size

Rule: Plan for 200000 rows per bulk-read page [DOC]. c2c plan checks the page size and requests the next page instead of one unbounded read.

Recipe: Use the bulk-read API with a page of at most 200000 rows. Success is a full page plus a continuation token when more rows remain.

### Unique constraints under parallel inserts

Rule: Do not use is_unique as a lock [TESTED]. Parallel inserts of the same unique value can all return a mix of 200, 409, and 429 and still persist duplicates. `UPDATE <table> SET <col> = <col> + 1` is accepted and is not atomic. c2c plan checks that id allocation is a claimed range or a single writer, not a unique column.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row. After a parallel burst, `SELECT COUNT(ROWID)` for that value. Success is a count of 1. A count above 1 means the unique column did not hold. Serialise the counter in one Job function.

### No multi-statement transaction

Rule: One call is atomic [TESTED]. Nothing groups two calls. c2c plan checks that a multi-table write is a sequence of idempotent steps with a checkpoint file, and generated code must not assume a transaction.

Recipe: There is no transaction path. Success for a two-table write is both rows present on read-back and a checkpoint that names the last finished step.

### ZCQL indexes

Rule: Assume there is no user-built ZCQL index [UNVERIFIED]. A search-index flag serves Catalyst Search only. c2c plan checks hot filters and stores a denormalised column when a report would scan.

Recipe: POST /baas/v1/project/<project-id>/query. Success is a result set. Do not send an index-create body.

## ZCQL

### ZCQL rows returned

Rule: A SELECT returns at most 300 rows [DOC]. Page with a keyset on ROWID (`WHERE ROWID > <last> ORDER BY ROWID LIMIT 300`) rather than a deep offset. c2c plan checks that a generated query pages this way.

Recipe: POST /baas/v1/project/<project-id>/query with `{"query":"SELECT ROWID FROM <table> ORDER BY ROWID LIMIT 300"}`. Success is at most 300 rows. Repeat with the last ROWID.

### ZCQL SELECT width

Rule: Plan for 20 columns in one SELECT [DOC]. c2c plan checks the select list and rejects a wider projection, including SELECT *. The observed wide-query refusal is `More than 30 select columns are not allowed` [TESTED]; stay at the documented 20.

Recipe: POST /baas/v1/project/<project-id>/query. Success is HTTP 200 for a list of at most 20 columns. Split a wider read into two queries.

### ZCQL JOIN clauses

Rule: Plan for 4 JOIN clauses, one condition each, and only on a declared foreign key [DOC]. c2c plan checks the JOIN count and rewrites a wider report into staged reads. The refusal text is `Table Join Limitation`.

Recipe: POST /baas/v1/project/<project-id>/query with at most four JOINs. Success is HTTP 200. A fifth JOIN is not emitted.

### ZCQL OFFSET

Rule: LIMIT offset is 1-based [TESTED]. LIMIT 0,n returns the same rows as LIMIT 1,n. Add 1 to a zero-based offset. Prefer the keyset in the rows-returned rule. c2c plan checks that generated LIMIT offsets start at 1.

Recipe: POST /baas/v1/project/<project-id>/query `ORDER BY ROWID LIMIT 1,2` returns the first two rows; `LIMIT 2,2` returns the next two. Success is that shift. An offset of 0 is not an error.

### ZCQL LIKE wildcards

Rule: In LIKE, `*` matches any run, `?` matches one character, and `_` is literal [TESTED]. `%` matches nothing and returns zero rows with HTTP 200. c2c plan checks that contains, starts-with, and ends-with emit `*` and that a literal percent is not sent as a wildcard.

Recipe: POST /baas/v1/project/<project-id>/query with `LIKE '*term*'`. Success is the matching rows. The same predicate with `%` returning zero rows is a bad pattern, not an empty table.

### ZCQL UPDATE and DELETE batch

Rule: One ZCQL UPDATE or DELETE changes at most 300 rows and returns HTTP 200 either way [TESTED]. Loop while the returned row count or `DELETED_ROWS_COUNT` is 300. c2c plan checks that a bulk mutation uses this loop and then a COUNT.

Recipe: POST /baas/v1/project/<project-id>/query with the UPDATE or DELETE. Success for a drained set is a last response whose count is below 300 and a COUNT of the remaining predicate equal to 0.

### ZCQL subqueries

Rule: `WHERE <col> IN (SELECT <col> FROM <table> WHERE …)` is valid [TESTED]. Use it for a non-join filter. Joins still need a foreign key and stay inside the JOIN budget.

Recipe: POST /baas/v1/project/<project-id>/query with that IN (SELECT …) shape. Success is HTTP 200 and a count equal to the same filter run directly.

### ZCQL execution time

Rule: Assume a project-wide query time budget [UNVERIFIED]. c2c plan checks a report query with a COUNT and a narrow WHERE before cutover. On `Query Processing Error`, denormalise the filter instead of widening the JOIN.

Recipe: POST /baas/v1/project/<project-id>/query. Success is HTTP 200 inside the time the function budget allows. A processing error stops the report and switches to staged reads.

### ZCQL write after a bad date

Rule: A ZCQL INSERT of a bad date can return `400` with `For input string: "nu"` after the row is already stored [TESTED]. A varchar overflow returns 400 and does not write. After any ZCQL write error, read the row back before retrying.

Recipe: POST /baas/v1/project/<project-id>/query. On HTTP 400, SELECT the key. Success for a retry is at most one row, whether the failed call stored it or not.

## Projects, users, files

### Projects per account

Rule: Plan for 50 projects per account [UNVERIFIED]. c2c doctor counts projects with `catalyst project:list --org <org-id>` before import and stops when no slot remains. A second import of the same project_name returns `409 DUPLICATE_ENTRY`; append a suffix and retry. Import into an existing project is not supported; create a new one.

Recipe: GET /baas/v1/project with headers Authorization, Accept, and CATALYST-ORG. Success is a list shorter than 50 before POST /baas/v1/project/import.

### App users in Development

Rule: Plan for 25 app users in Development [DOC]. c2c plan checks CatalystbyZoho_List_All_Project_Users (or GET /baas/v1/project/<project-id>/project-user) before adding one, and stops at 25.

Recipe: GET /baas/v1/project/<project-id>/project-user. Success is a user list of length below 25. POST /project-user adds one user; do not use POST /project-user/signup when public signup is off.

### App users in Production

Rule: Plan for 1000 app users in Production [UNVERIFIED]. c2c plan checks the same user list before inviting past that count.

Recipe: GET /baas/v1/project/<project-id>/project-user with X-CATALYST-Environment Production. Success is a count below 1000.

### Development API calls

Rule: Plan for 200000 API calls per application in Development [UNVERIFIED]. c2c plan checks the mover's call estimate (rows divided by batch size, plus polls) and warns when the estimate is a large fraction of 200000. Prefer bulk write for a large table.

Recipe: Estimate calls before migrate-data --confirm. Success is an estimate under 200000, or an explicit switch to POST /bulk/write.

### Stratus object size

Rule: Plan for at most 250 GB per object [UNVERIFIED]. c2c plan checks the file size before upload and refuses a larger object. Bucket names are global; include a stable suffix so a second project does not collide.

Recipe: PUT `https://<bucket>-development.zohostratus.<dc>/<object-key>` with headers Authorization, CATALYST-ORG, X-CATALYST-Environment, compress `false`, and Content-Type. Success is HTTP 200 and CatalystbyZoho_Get_All_Objects listing the key.

### Bucket name namespace

Rule: Assume a bucket name is unique across the platform [UNVERIFIED]. c2c plan checks Get_All_Buckets for the chosen name and, on `Bucket already exists`, appends a suffix and retries once.

Recipe: MCP CatalystbyZoho_Create_Bucket body bucket_name and bucket_meta. Read-back is CatalystbyZoho_Get_All_Buckets. Do not trust CatalystbyZoho_Head_Bucket as proof the bucket exists.

### Slate entry cache

Rule: `/` and `/index.html` are served with `cache-control: public, max-age=31536000` [TESTED]. Hash every asset file name and version the service worker. c2c plan checks that index.html references hashed assets only.

Recipe: `curl -I https://<app>.onslate.<dc>/` and the same for `/index.html`. Success is a later deploy whose HTML points at new hashed names. Do not expect a redeploy to refresh an unhashed index.html.

## Functions and jobs

### Advanced I/O time

Rule: An Advanced I/O request must finish in well under 30 seconds [DOC]. A handler that sleeps about 35 seconds returns `408 EXECUTION_TIME_EXCEEDED` [TESTED]. Posting a configuration body with timeout or execution_timeout returns 200 and does not raise the cap. c2c plan checks every request path and moves work that can pass 25 seconds to a Job function.

Recipe: Invoke the function. Success is HTTP 200. On `408 EXECUTION_TIME_EXCEEDED`, stop retrying on the request path and submit a job.

### AppSail request time

Rule: Plan for the same 30 second cap for an AppSail request, not raisable [UNVERIFIED]. c2c plan checks an AppSail route the same way as Advanced I/O and moves a longer call to a Job.

Recipe: Request the AppSail URL. Success is HTTP 200 inside 25 seconds. A body that says the request exceeded maximum execution time is the same stop: use a Job.

### Job function time

Rule: Assume a Job function stops after 15 minutes and returns no HTTP response [DOC]. c2c plan checks that a long task chunks itself, writes a checkpoint, and submits the next job before the 15 minutes elapse.

Recipe: POST /baas/v1/project/<project-id>/job_scheduling/job with jobpool_id and job_details, then poll the job until SUCCESS. A chunk's success is SUCCESS plus the checkpoint row. A job that hits 15 minutes is failed; resume from the checkpoint, do not rerun finished chunks.

### Function concurrency

Rule: Plan for 10 concurrent executions of one function in Development [UNVERIFIED]. c2c plan checks fan-out and caps it at 10. On `Concurrency limit reached for the feature COMPONENT` or HTTP 429, shrink the pool.

Recipe: Submit at most 10 overlapping invocations. Success is every call HTTP 200 or a job status SUCCESS. A 429 backs off using Retry-After.

### Function memory

Rule: Assume function memory stays at the value GET /function/<function-id> returns [TESTED]. A configuration body that sets memory is not a reliable change. c2c doctor reads that value before a memory-heavy job and streams a large payload to Stratus instead of buffering it.

Recipe: GET /baas/v1/project/<project-id>/function/<function-id>. Success is reading `configuration` memory and planning under it. Do not claim a raise from a POST that only returns 200.

### Idle function sandbox

Rule: Assume an idle function sandbox is gone after about 2 minutes [UNVERIFIED]. Do not keep migration state in process memory. c2c plan checks that state sits in the checkpoint file, Data Store, or Stratus.

Recipe: Two requests more than 2 minutes apart must both read the checkpoint. Success is the second request resuming at the stored step.

### AppSail idle

Rule: Assume AppSail scales to zero after 5 minutes with no requests [UNVERIFIED]. c2c plan checks user-facing copy so a cold first request is expected.

Recipe: Request the AppSail URL after an idle gap. Success is HTTP 200, possibly after a slow first response.

### Job close

Rule: A Job function must call closeWithSuccess or closeWithFailure, including on the failure path [DOC]. Otherwise the job stays In Progress until the 15 minute stop. c2c plan checks generated job code for a close in a finally block.

Recipe: POST /job_scheduling/job, then poll status. Success is SUCCESS or a failure status, not In Progress past the job's own work.

### Basic I/O close

Rule: Close a Basic I/O context in a finally block [DOC]. An open context runs until timeout and consumes the whole interval. c2c plan checks generated Basic I/O code for that close.

Recipe: Invoke the function once. Success is a short execution in the logs, not a timeout with an empty body.

### Circuits by data centre

Rule: Do not call Circuits when `<dc>` is EU, AU, IN, or CA [UNVERIFIED]. The call returns 403. c2c plan checks the configured data centre and emits a Job function instead. There is no availability endpoint; doctor does not query one.

Recipe: Skip Circuits in those data centres. Success is the Job status SUCCESS for the same work. A 403 from a Circuit call means switch to the Job, not a retry.

### Creator calls from a Catalyst function

Rule: Assume one Creator API call per minute from a Catalyst function, and assume a 429 with `You have reached your API call limit` [UNVERIFIED]. c2c plan checks that no request path calls Creator. Run Creator exports on your own machine. A queued sync, if one is required, sleeps to that rate and honours Retry-After.

Recipe: Do not call Creator from the function. Success for a migration is a local CSV load via POST /row or POST /bulk/write.

### Signals targets and rules

Rule: Assume one Signals rule fans out to at most 5 targets, and assume at most 100 rules [UNVERIFIED]. c2c plan checks the rule count and does not put Signals on the request path. Creator is not a Signals publisher; deliver Creator events with a webhook or a function call.

Recipe: Signals create is a console call, not a token call. Read-back is the rule list in the console. A token call to the Signals API returns `401 OAUTH_SCOPE_MISMATCH`.

### URL throttle

Rule: Assume a per-project URL throttle [UNVERIFIED]. A redirect loop can return `Throttle Limit Reached` for hours. c2c plan checks that generated sign-in redirects stop after one hop and that scripts do not repeat sign-in.

Recipe: On `Throttle Limit Reached`, stop every automated sign-in and wait. Success after recovery is a single sign-in HTTP 200. Do not retry in a loop.

### No quota read

Rule: Do not call a limits or quota URL [TESTED]. c2c doctor counts projects, tables, columns, and users directly, and c2c plan applies the budgets in this file before the first create.

Recipe: GET /baas/v1/project/<project-id>/limits, `/quota`, `/usage`, `/table/<table-id>/limits`, `/datastore/limits`, and GET /baas/v1/limits each return `404 INVALID_URL_PATTERN`. Success is not calling them.
