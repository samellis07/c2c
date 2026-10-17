# Bulk write, Stratus and files, jobs and crons for the c2c plugin

Bulk load, file storage, and scheduled work. Every rule below is an
imperative recipe: method, path, headers, body, polling, success
signal, and the exact error codes with the action for each.

Token call envelope. Recipe: send HTTPS calls to
`https://api.catalyst.<dc>` with headers `Authorization`,
`Accept: application/vnd.catalyst.v2+json`,
and `X-CATALYST-Environment` plus `CATALYST-ORG`. `<dc>` is the data
centre from the customer config file; never hard-code it.

## Bulk write

### Load large data sets through bulk write from a Stratus CSV

Recipe: [UNVERIFIED] 1) upload the CSV with `PUT
https://<bucket>-development.zohostratus.<dc>/<object-key>` and headers
`Authorization`, `CATALYST-ORG`, `X-CATALYST-Environment`,
`compress:false`, `Content-Type: text/csv`; success is HTTP 200. 2)
`POST /baas/v1/project/<project-id>/bulk/write` with body fields
`table_identifier`, `operation` (`insert`), `object_details`
(`bucket_name`, `object_key`), and `fk_mapping` (array of
`local_column` plus `reference_column`); success is HTTP 200 with a
job id. 3) Poll `GET /baas/v1/project/<project-id>/bulk/write/<job-id>`
until `Completed`.

Rule: [UNVERIFIED] sanitise the CSV with the row-write validation rules before
upload: the job stores truncated varchars and rolled dates exactly
like REST, reports `records_processed` with `Completed`, and leaves
the downloadable error report empty. Assert the loaded rows by
re-reading the table; never trust the job status or the error report
as proof of exactness.

### Resolve lookups with fk_mapping; load parents first

Recipe: [TESTED] `fk_mapping` entries of `local_column` plus `reference_column`
resolve local values to the referenced parent ROWIDs on insert; the
`reference_column` must be a unique column. Keys
with no parent match are dropped silently. `find_by` names the unique
column for upsert matching.

Rule: [DOC] load parent tables before children, pre-validate every foreign
key value against the parent set, and re-count children after the job.
Assume about 100,000 rows per bulk-write call
([L-BULK-WRITE](references/limits.md#l-bulk-write-bulk-write);
https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/data-store/bulk-write/);
split larger loads into several jobs.

### Send CSV only; JSON sources and URL objects are rejected

Recipe: [UNVERIFIED] a `.json` object as the bulk source returns 400 ("The object
should be of .csv file format"); `object_details` with a `url`
returns 400 `INVALID_INPUT`.

Rule: [UNVERIFIED] always convert the payload to CSV and upload it first. Never
point bulk write at a JSON object or a URL.

### Without a bucket, feed bulk write a File Store file id

Recipe: [UNVERIFIED] `POST /baas/v1/project/<project-id>/folder` with body field
`folder_name` returns 200; `POST
/baas/v1/project/<project-id>/folder/<folder-id>/file` with the CSV as
multipart returns 200 with the file id in `data.id`; `POST
/baas/v1/project/<project-id>/bulk/write` with `table_identifier`,
`operation`, and `file_id` polls to `Completed` with the row present.

Rule: [UNVERIFIED] use this path when no bucket exists yet. Direct all new work at
Stratus buckets; keep File Store as the fallback only.

### Never drive bulk loads through the non-interactive CLI import

Recipe: [UNVERIFIED] `ds:import` with a `bucket_name` config crashes reading the
bucket answer; with a pre-uploaded `object_key` it schedules the job
then errors on a spurious option; with `file_id` it is accepted;
without non-interactive flags it prompts on a TTY.

Rule: [UNVERIFIED] skip the CLI for bulk loads. Upload with the PUT recipe above
and call `POST /bulk/write` directly.

## Stratus and files

### Create each bucket once outside the token path; names are global

Recipe: [UNVERIFIED] `POST /baas/v1/project/<project-id>/bucket` answers the
automation token with `401 OAUTH_SCOPE_MISMATCH`. Reading with
`GET /baas/v1/project/<project-id>/bucket` returns 200.

Rule: [UNVERIFIED] declare the bucket in the greenfield import template or create
it once in the console, then use the token for objects and bulk
write. Bucket names are global across all accounts: always suffix
generated names with an org or random part. `c2c doctor` reads the
bucket list back to confirm the bucket exists before any upload.

### Read a bucket back from the bucket list, never the per-bucket path

Recipe: [UNVERIFIED] GET .../bucket/<name> answered 404 INVALID_URL_PATTERN in one DC; the list route works.
`GET /baas/v1/project/<project-id>/bucket` returns every bucket inside the
`data` envelope.

Rule: [UNVERIFIED] confirm a bucket exists by listing
`GET /baas/v1/project/<project-id>/bucket` and matching `bucket_name`
exactly (follow a page token when one is returned). Never treat a 404 from
the per-bucket path as "bucket absent". The `c2c doctor` MCP probe
read-back uses the list route, then the nonce-object list below.

### Read the doctor probe nonce object back by exact key

Recipe: [DOC] `GET /baas/v1/project/<project-id>/bucket/objects?bucket_name=<bucket>&prefix=<key>&max_keys=50` returns `data.contents[].key` and `data.next_continuation_token`. Follow that token. `truncated` or `more_records` without a token does not prove the key is absent. Match `key` exactly. Do not use `GET .../bucket/<name>`.

Rule: [DOC] A project-scoped `c2c doctor` probe lists that exact object key — a fresh 32-hex nonce for the run — inside the reused probe bucket. A bucket without this run's key does not pass. Delete the object with `PUT /baas/v1/project/<project-id>/bucket/object?bucket_name=<bucket>` and body `{"objects":[{"key":"<nonce>"}]}`. The CLI token's objects delete scope is [UNVERIFIED], so the doctor still prints that PUT when the delete may not have landed. The bucket stays until `CatalystbyZoho_Delete_Bucket`.

### Assume 250 GB per single object

Rule: [UNVERIFIED] assume one Stratus object holds at most 250 GB. Chunk anything
larger and store a manifest row pointing at the parts.

## Signals

### Fan out through a Signals custom publisher — the ingest URL's digest is the credential

Recipe: [UNVERIFIED] a custom publisher plus event plus rule to a Function target is console work end to end; the REST ingest endpoint is `POST /signals/v2/event_notification?digest=<128-hex>` with no OAuth — the digest is the only credential and the console offers `Regenerate Digest`.

Rule: [UNVERIFIED] treat the digest URL as a secret in generated config; create publishers and rules in the console and point them at Job-type targets.

### Event Listeners are deprecated — Signals is the exit, and drift still reports them

Rule: [UNVERIFIED] never emit the `EventListeners` IaC component or call `/event-bus` — on a current project the API answers `EVENT_BUS_ERROR` ("Event listeners are now deprecated. Please use Signals") and `event:generate` redirects to `signals:generate`. Route row triggers (`row_inserted` / `row_updated` / `row_deleted`) to Signals rules, which are console-created only.

- `c2c iac-drift` still watches the `EventListeners` component: an export that carries `listeners` or `rules` items c2c did not create is reported as drift, never silently ignored.
- Event delivery is documented as a single attempt — no automatic retry, backoff, or DLQ; a failure lands in the rule's Processed Events tab (retention 3 months Prod, 1 month Dev) with optional email alerts. Plan a dead-letter write plus a sweep for any async work the user must not lose.
- Ordering and latency are undocumented; keep ordered or response-affecting work synchronous in `c2c_api` and use events only for fire-and-forget actions (mail, notifications, outbound calls).

## Job pools, crons, and jobs

### Create one Function job pool per project outside the token path

Recipe: [UNVERIFIED] `POST /baas/v1/project/<project-id>/job_scheduling/jobpool`
answers the automation token with `401 OAUTH_SCOPE_MISMATCH`.

Rule: [UNVERIFIED] create the single Function pool once in the console or in the
greenfield import template, using an alphanumeric name without
underscores, then drive every cron and job through the token. `c2c
doctor` reads the pool list back to confirm the pool exists before
scheduling anything.

- Pool names reject underscores and spaces; `Allocate Max Compute
Memory` is a mandatory console choice (128 MB–10 GB in 0.5 GB steps).

### Create crons through Job Scheduling with job_meta and job_detail

Recipe: [UNVERIFIED] `POST /baas/v1/project/<project-id>/job_scheduling/cron` with
body fields `cron_name`, `cron_type` (`OneTime`), `cron_status`,
`cron_execution_type`, `job_detail` (the schedule: `time_of_execution`
plus `timezone`), and `job_meta` (`jobpool_id` of an existing pool,
`job_name`, `source_type`, `target_type`, `target_id` of the target
Job function) returns 200. The body uses the two singular keys only;
never send a pluralised variant of the schedule key.

- [TESTED] (live run, 17 Oct 2026, `c2c provision --out <dir> --confirm
--run crons`) a body with
the pluralised schedule keys and a top-level
`jobpool_id` (no `job_meta`) answers `400` `Mandatory parameter
job_meta is missing` and creates nothing.
- [UNVERIFIED] the unit of `time_of_execution` (c2c sends epoch
seconds), the values `cron_execution_type: pre-defined` and
`source_type: Cron`, `cron_expression` as a top-level field of a
CronExpression cron, and `job_meta.params` reaching the Job function.

Rule: [UNVERIFIED] post only crons the generator planned
(job-scheduling.json): a repeating custom schedule is `CronExpression`,
a schedule with no frequency is `OneTime`, and `--run crons` refuses a
`OneTime` start in the past (it would never fire) and refuses every
cron until the project's function list shows the `c2c_jobs` Job
function, whose id is the `target_id`. A record-relative form schedule
is reported, never posted as a cron.

Rule: [UNVERIFIED] generate Job functions as cron targets; the console picker
lists Job functions only. Never emit the legacy shape. Map
`cron_url_details cannot be null` to the legacy `POST /cron` with
`cron_function_id`, never to a field on `/job_scheduling/cron`.

- Pre-defined crons migrate to Production with the project on
promotion.

### Submit jobs with the token and poll to SUCCESS

Recipe: [UNVERIFIED] `POST /baas/v1/project/<project-id>/job_scheduling/job` with
flat fields `source_type`, `job_name`, `jobpool_id`, `target_type`,
and `target_id` returns 200 with status `PENDING`; poll the job from
`PENDING` through to `SUCCESS`.

Rule: [DOC] chunk work past minutes with persisted checkpoints and
self-resubmit; a Job function runs at most 15 minutes
([L-JOB-TIME](references/limits.md#l-job-time-job-function);
https://docs.catalyst.zoho.com/en/serverless/help/functions/job-functions/)
and returns no
HTTP response. Close every job with success or failure in a `finally`
block, or it hangs `In Progress` to timeout. Dispatch queues under
burst, so poll patiently and never promise near-real-time for
job-backed workflows.

### Route work past 25 seconds to a Job function, never to sync config

Recipe: [DOC][TESTED] an Advanced I/O call sleeping 35 seconds dies with `408
EXECUTION_TIME_EXCEEDED` near the 32-second mark; timeout and memory
configuration posts return 200 but change nothing. AppSail requests
cut off the same way near 30 seconds
([L-REQUEST-TIME](references/limits.md#l-request-time-advanced-io--appsail-request);
https://docs.catalyst.zoho.com/en/serverless/help/functions/advanced-io/).

Rule: [DOC][TESTED] send anything that can exceed about 25 seconds to a Job
function with submit-plus-poll. Never tune timeouts through the
function configuration route.

### Queue Creator-bound calls on the plugin host with backoff

Rule: [UNVERIFIED] assume calls from Catalyst into Creator APIs throttle near one
request per minute with 429. Run the mover and any dual-run sync on
the plugin host (the customer machine), not inside Catalyst, through
one queued client with 429 backoff and a per-minute budget. Log the
Creator code and message verbatim on refusal.
