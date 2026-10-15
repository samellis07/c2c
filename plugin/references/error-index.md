# Error index: exact error text → the entry that covers it

Match by substring — normalise numbers to `N` and names to `X`, then take the
first matching row. The entry is the rule in [facts/errors.md](facts/errors.md);
it carries the cause, the confirming read-only check, the fix and the recipe.
Rows that name a doctor check point into [doctor-spec.md](doctor-spec.md); the
few rows with neither keep their fix inline. "Stop" means the migration step
must not continue until fixed.

## c2c CLI error codes

Every user-facing error the CLIs print carries one stable code, `C2C-<AREA>-<NNN>`,
emitted at the error site — never on a log, warning, retry line or command tail.
The code names the error family; the message keeps its `c2c:`/`c2c <cmd>:` prefix
and holds the specifics. Each row below gives the cause and the fix.

| Code | Error | Cause | Fix |
|---|---|---|---|
| <a id="c2c-cli-000"></a>`C2C-CLI-000` | Uncaught `c2c` error | A failure no command handled | Re-run; if it repeats report the message |
| <a id="c2c-cli-001"></a>`C2C-CLI-001` | Usage / unknown flag | Missing argument or a flag the command does not take | Follow the printed usage |
| <a id="c2c-cli-002"></a>`C2C-CLI-002` | Input path missing | The file or directory argument does not exist | Check the path |
| <a id="c2c-cli-003"></a>`C2C-CLI-003` | Locked Marketplace export | The .ds export is locked | Unlock it in Creator and re-export |
| <a id="c2c-cli-004"></a>`C2C-CLI-004` | migrate-data write refused | `migrate-data` ran without `--dry-run` | Rehearse with `--dry-run` |
| <a id="c2c-cli-005"></a>`C2C-CLI-005` | Bad `--report` | The value is not `Report:Table` | Pass `--report <Report>:<Table>` |
| <a id="c2c-cli-006"></a>`C2C-CLI-006` | Checkpoint not version 1 | The checkpoint file is an older shape | Delete it and let the run write a fresh one |
| <a id="c2c-cli-007"></a>`C2C-CLI-007` | Doctor gate refusal | A `--confirm` write needs a green, current doctor.json | Run `c2c doctor`, fix FAILs, retry |
| <a id="c2c-cli-008"></a>`C2C-CLI-008` | `--lock` errors | `--lock` has no value or the file is missing | Pass a readable lock file |
| <a id="c2c-cli-009"></a>`C2C-CLI-009` | precheck input | `precheck` got a directory or non-file | Pass exactly one `.ds` file |
| <a id="c2c-cli-010"></a>`C2C-CLI-010` | precheck parse | The file is not a parseable Creator .ds export | Export the app from Creator again |
| <a id="c2c-cli-011"></a>`C2C-CLI-011` | migration-report input | The argument is not an apps directory | Pass the corpus directory |
| <a id="c2c-cli-012"></a>`C2C-CLI-012` | Conflicting `--source-*` | More than one source flag was passed | Keep exactly one source flag |
| <a id="c2c-cli-013"></a>`C2C-CLI-013` | iac-drift input | A template file is unreadable or not JSON | Check both template paths |
| <a id="c2c-cli-014"></a>`C2C-CLI-014` | seed arguments | Bad `--rows`, bad seed args or a non-file fixture name | Fix the flagged argument |
| <a id="c2c-cli-015"></a>`C2C-CLI-015` | `ui`/`ui-react` needs `--out` | No output directory was passed | Pass `--out <dir>` |
| <a id="c2c-cli-016"></a>`C2C-CLI-016` | score-ui failure | The bundle is unreadable or scoring failed | Rebuild the UI bundle and retry |
| <a id="c2c-cli-017"></a>`C2C-CLI-017` | Quality gate failed | `analyze --quality` checks failed | Read docs/quality-gate.md |
| <a id="c2c-cli-018"></a>`C2C-CLI-018` | DOM unavailable | jsdom could not be loaded for HTML sanitize/score | Reinstall the plugin or run npm ci |
| <a id="c2c-cli-019"></a>`C2C-CLI-019` | fill-todos failure | A fill task failed its gates | Read the task error |
| <a id="c2c-cli-020"></a>`C2C-CLI-020` | cutover/proof failure | The checklist or proof could not be produced | Read the message |
| <a id="c2c-cli-021"></a>`C2C-CLI-021` | Utility script error | A repo utility script (`scripts/*.mjs`) refused | Follow the printed message |
| <a id="c2c-cli-022"></a>`C2C-CLI-022` | Hand-edited generated file | `ui-react` found a hand-edited generated file | Move edits to src/custom or pass `--force` |
| <a id="c2c-deploy-001"></a>`C2C-DEPLOY-001` | `deploy` failed | Uncaught failure in the deploy run | Read the message; retry `--resume` |
| <a id="c2c-deploy-002"></a>`C2C-DEPLOY-002` | `plan` failed | The offline plan could not be built | Read the message; check the source |
| <a id="c2c-deploy-003"></a>`C2C-DEPLOY-003` | `provision` refusal | A provision step, scope, or read-back refused | Read the message; record steps in order |
| <a id="c2c-deploy-004"></a>`C2C-DEPLOY-004` | `edit` failed | The edit could not be computed or applied | Read the message |
| <a id="c2c-deploy-005"></a>`C2C-DEPLOY-005` | `migrate-data` failed | A seed/CSV/JSON/backup load failed | Read the message; the checkpoint resumes |
| <a id="c2c-deploy-006"></a>`C2C-DEPLOY-006` | `users` failed | The users plan/invite run failed | Read the message |
| <a id="c2c-deploy-007"></a>`C2C-DEPLOY-007` | `smoke` failed | The smoke run or check failed | Read the message |
| <a id="c2c-deploy-008"></a>`C2C-DEPLOY-008` | `sync-delta` failed | Delta apply failed; the checkpoint was not recorded | Re-run to resume |
| <a id="c2c-deploy-009"></a>`C2C-DEPLOY-009` | `rollback-export` failed | The export could not be produced | Read the message |
| <a id="c2c-deploy-010"></a>`C2C-DEPLOY-010` | `status` failed | A live read failed | Check org/project flags and login |
| <a id="c2c-deploy-011"></a>`C2C-DEPLOY-011` | Console first-use gate | A service was never opened in the project console | Do the named console step, re-run |
| <a id="c2c-deploy-012"></a>`C2C-DEPLOY-012` | Project guard refused | The run targets a guarded/wrong org or project | Fix `--org`/`--project` or the registry |
| <a id="c2c-deploy-013"></a>`C2C-DEPLOY-013` | Mail blocker | A `--mail` precheck finding blocks deploy | Fix the named finding |
| <a id="c2c-deploy-014"></a>`C2C-DEPLOY-014` | Async trigger blocker | `--triggers-wired` is blocked | Wire event triggers or drop the flag |
| <a id="c2c-deploy-015"></a>`C2C-DEPLOY-015` | Edits log can't apply live | Recorded edits change the store beyond rename | Re-plan instead of deploying the delta |
| <a id="c2c-deploy-016"></a>`C2C-DEPLOY-016` | Table step failed | A Data Store table/column call failed | Read the table error |
| <a id="c2c-deploy-017"></a>`C2C-DEPLOY-017` | Missing built web app | `web/dist` holds no built app after the build | Fix the web build and re-run |
| <a id="c2c-deploy-018"></a>`C2C-DEPLOY-018` | Build command failed | `npm run build` in web/ exited non-zero | Fix the build error, `deploy --confirm` |
| <a id="c2c-deploy-019"></a>`C2C-DEPLOY-019` | Slate never opened | The project never opened the Slate service | Console → Slate → Start Exploring, re-run |
| <a id="c2c-deploy-020"></a>`C2C-DEPLOY-020` | Source rows refused | An integrity rule refused rows | Fix the source rows |
| <a id="c2c-deploy-021"></a>`C2C-DEPLOY-021` | Command usage / arguments | A deploy-family command's arguments are wrong | Follow the printed usage or message |
| <a id="c2c-deploy-022"></a>`C2C-DEPLOY-022` | No schema columns | A confirmed load found tables with no export columns | Check `--ds` covers every table |
| <a id="c2c-deploy-023"></a>`C2C-DEPLOY-023` | `--seed --confirm` needs `--ds` | Schema check needs the app's .ds | Pass `--ds <file|dir>` |
| <a id="c2c-deploy-024"></a>`C2C-DEPLOY-024` | Stratus not opened / bucket | The Stratus service or seed bucket is missing | Console → Stratus, or provision step `bucket` |
| <a id="c2c-deploy-025"></a>`C2C-DEPLOY-025` | Load/table error | A table's rows failed to write | Read the per-table message |
| <a id="c2c-deploy-026"></a>`C2C-DEPLOY-026` | Repeated source ids | A table has duplicate `c2c_source_id` values | De-duplicate the source export |
| <a id="c2c-deploy-027"></a>`C2C-DEPLOY-027` | Mandatory values missing | Store-mandatory columns have empty cells | Fill the source or relax the constraint |
| <a id="c2c-deploy-028"></a>`C2C-DEPLOY-028` | smoke `--result` arguments | `--result`/`--result-code` args or binding missing | Pass the code/file and `--url`/`--project` |
| <a id="c2c-deploy-029"></a>`C2C-DEPLOY-029` | Smoke result refused | The pasted result failed verification | Re-copy the code from the app page |
| <a id="c2c-deploy-030"></a>`C2C-DEPLOY-030` | Browser unreachable | CDP endpoint did not answer | Check `--browser-cdp <endpoint>` |
| <a id="c2c-deploy-031"></a>`C2C-DEPLOY-031` | Plan budget failed | A measured budget is over its limit | See the named budget check |
| <a id="c2c-deploy-032"></a>`C2C-DEPLOY-032` | Destructive edit needs confirm | The edit drops columns or tables | Pass `--confirm` with `--apply` |
| <a id="c2c-deploy-033"></a>`C2C-DEPLOY-033` | Edit refused | The named edit is not allowed | Read the refusal reason |
| <a id="c2c-deploy-034"></a>`C2C-DEPLOY-034` | Data parity verification failed | The source export and stored rows differ or could not be read | Check the named table and source/row files |
| <a id="c2c-doctor-001"></a>`C2C-DOCTOR-001` | Doctor usage | Unknown flag or a missing/ill-typed value | Follow the printed usage |
| <a id="c2c-doctor-002"></a>`C2C-DOCTOR-002` | Scope resolution failed | dc/org/project could not be resolved | Pass flags or set c2c-deploy.json |
| <a id="c2c-doctor-003"></a>`C2C-DOCTOR-003` | Evidence stale | The MCP request expired before the evidence | Re-run `c2c doctor --mcp-begin` |
| <a id="c2c-doctor-004"></a>`C2C-DOCTOR-004` | Observation rejected | The piped observation failed the schema | Pipe each call's result verbatim |
| <a id="c2c-doctor-005"></a>`C2C-DOCTOR-005` | Evidence rejected | The evidence file failed the schema | Regenerate it from the calls |
| <a id="c2c-doctor-006"></a>`C2C-DOCTOR-006` | Evidence file missing | `--record-mcp` names no readable file | Check the path |
| <a id="c2c-doctor-007"></a>`C2C-DOCTOR-007` | Vendor check error | `--verify-vendor` could not read the dir | Check the plugin directory |
| <a id="c2c-doctor-008"></a>`C2C-DOCTOR-008` | Plugin files modified | The vendor manifest does not match | Reinstall the plugin |
| <a id="c2c-doctor-009"></a>`C2C-DOCTOR-009` | Doctor run failed | The doctor command itself failed | Read the message |

## Agent host, MCP and the doctor

| Error text | Entry / fix |
|---|---|
| `has an invalid MCP url` | The plugin's `.mcp.json` `url` does not parse as a URL after `${VAR}` expansion — doctor check D-B1: disable the broken copy, add one correct entry (`templates/mcp-snippets.md`), restart, sign in |
| `No URL configured for this server` | The `url` is empty — same fix (D-B1) |
| `Missing environment variables:` | A `${VAR}` in the MCP `url` is not set — set it or use a literal URL |
| `Skipped unknown MCP server type` | `type` is not one of stdio/sse/http/streamable-http/ws — use `"type": "http"` |
| Only `authenticate` / `complete_authentication` tools visible | The MCP is configured but not signed in — doctor D-B3; the user completes the browser sign-in |
| `PERMISSION_NEEDED` | The MCP account cannot see that org/project, or the project context is not set — doctor D-B7; reconnect with the account and DC that owns them; never switch project |
| `Mandatory path variable not present` | Arguments were guessed without the schema — `ZohoMCP_getSchema` first (doctor D-B6), then pass `path_variables` |
| `tool_name is required` | `ZohoMCP_getSchema` was passed `body` — call `ZohoMCP_getSchema({query_params:{tool_name}})` |
| Tools show but return another org's data | The MCP URL is for another DC — doctor D-B2 |
| `catalyst whoami` shows no login | No CLI session — the user runs `catalyst login --dc <dc>` (doctor D-C3) |

## Catalyst CLI

| Error text | Entry / fix |
|---|---|
| `An unexpected error has occurred. Kindly contact Catalyst support` | [the crash wrapper](facts/errors.md#cli-an-unexpected-error-has-occurred-kindly-contact-catalyst-support) — re-run with `--verbose` and match the debug line below. Stop |
| `TypeError: existingSlates.findIndex is not a function` | [`catalyst.json` `slate` written as an object](facts/errors.md#typeerror-existingslatesfindindex-is-not-a-function). Stop |
| `TypeError: Cannot read properties of undefined (reading 'bucket_name')` | [`ds:import -ni` crash](facts/errors.md#typeerror-cannot-read-properties-of-undefined-reading-bucket_name) |
| `HTTP Error: 404, No such app with the given id exists` (after an App Url printed) | [the deploy already landed](facts/errors.md#http-error-404-no-such-app-with-the-given-id-exists) |
| `Please access the Slate service in your project's console before deploying via the CLI.` | [Slate was never opened in the project console](facts/errors.md#400-please-access-the-slate-service-in-your-projects-console-before-deploying-via-the-cli) |
| `ZCATALYST_CONFIG_PERMISSION_DENIED` / `Skipping this update` | Harmless — the CLI cannot write back its own config dir |
| A job-pool name rejected with no other error body | [the underscore rule](facts/errors.md#job-pool-name-rejected) — letters and digits only |
| `Head_Bucket` reports success for a missing bucket | [the read-back lies](facts/errors.md#head_bucket-reports-success-for-a-missing-bucket) — verify with a list |

## Catalyst API

| Error text | Entry |
|---|---|
| `409 DUPLICATE_ENTRY` on project import | [§](facts/errors.md#409-duplicate_entry-on-project-import) |
| `400 PROJECT_CREATION_NOT_ALLOWED` / `Project creation is not supported in this CLI version` | [§](facts/errors.md#400-project_creation_not_allowed) |
| `400 MISSING_PARAM` on the import deploy URL | [§](facts/errors.md#400-missing_param-on-import-deploy) |
| `Error_Processing` / `Internal error occurred while importing the project` | [§](facts/errors.md#error_processing-while-importing-an-existing-project) |
| `400 INVALID_INPUT` on export (unknown body keys) | [§](facts/errors.md#400-invalid_input-on-export-body-keys) |
| `400 INVALID_OPERATION` / `currently in the production environment` on delete | [§](facts/errors.md#delete-refused-while-production-is-enabled) |
| `401 OAUTH_SCOPE_MISMATCH` / `invalid oauth scope to access this URL` | [§](facts/errors.md#401-oauth_scope_mismatch) |
| `401 AUTHENTICATION_FAILURE` | [§](facts/errors.md#401-authentication_failure) |
| `Error when refreshing the access token` / an empty stored token / `401 INVALID_TOKEN` | [§](facts/errors.md#error-when-refreshing-the-access-token) |
| `404 INVALID_URL_PATTERN` / `Please check if the URL trying to access is a correct one` | [§](facts/errors.md#404-invalid_url_pattern) |
| `c2c: catalyst write failed: 404` | same entry — [§](facts/errors.md#404-invalid_url_pattern) |
| `400 BROWSER_COOKIES_DISABLED` (code 3028) | [§](facts/errors.md#400-browser_cookies_disabled) |
| `400 INVALID_REQUEST_METHOD` on connections | [§](facts/errors.md#400-invalid_request_method-on-connections) |
| `406 INVALID_OPERATION` / `You cannot perform this operation for current environment` | [§](facts/errors.md#406-invalid_operation-in-production) |
| `403 INVALID_OPERATION` / `Reached max number of columns of Unique varchar type` | [§](facts/errors.md#third-unique-varchar-column) |
| `Text column cannot be Unique` | [§](facts/errors.md#text-column-cannot-be-unique) |
| `400 PATTERN_NOT_MATCHED` on column create | [§](facts/errors.md#400-pattern_not_matched-on-column-type) |
| `400 JSON_PARSE_ERROR` / `Check if the input json is proper` | [§](facts/errors.md#400-json_parse_error-on-column-create) |
| `409 DUPLICATE_VALUE` / `Duplicate value for X. Please give a different value` | [§](facts/errors.md#409-duplicate_value) |
| `403 MANDATORY_MISSING` / `Column X is mandatory and cannot be empty` | [§](facts/errors.md#403-mandatory_missing) |
| `Invalid input value for X. date value expected` | [§](facts/errors.md#400-invalid_input-for-a-date) |
| `data too long for column` (ZCQL write) | [§](facts/errors.md#zcql-data-too-long-for-column) |
| `For input string: "nu"` (ZCQL write) | [§](facts/errors.md#zcql-for-input-string-nu) — the write may already have landed; re-read before retrying |
| A `POST`/`PUT /row` returns 200 but the stored value differs | [§](facts/errors.md#rest-200-stored-a-different-value) |
| `Invalid Operation! The object should be of .csv file format.` | [§](facts/errors.md#bulk-write-rejects-a-non-csv-object) |
| `429 Too Many Requests` / `Concurrency limit reached for the feature COMPONENT` | [§](facts/errors.md#429-and-concurrency-limit-reached-for-the-feature-component) |
| `API_LIMIT_REACHED` / `You have reached the max limit of your current API Limit` | [§](facts/errors.md#api_limit_reached). Stop; for a table create, back off 30/60/120 min and retry |
| `Table Join Limitation` | [§](facts/errors.md#table-join-limitation) |
| `More than 30 select columns are not allowed` | [§](facts/errors.md#more-than-30-select-columns-are-not-allowed) |
| `Throttle Limit Reached` | [§](facts/errors.md#throttle-limit-reached) — stop scripted sign-ins; the throttle can hold for hours |
| `Query Processing Error` on a query that used to succeed | [§](facts/errors.md#query-processing-error) |
| `408 EXECUTION_TIME_EXCEEDED` | [§](facts/errors.md#408-execution_time_exceeded) |
| `function exceeded maximum execution time` / `request exceeded maximum execution time` | [§](facts/errors.md#job-or-request-exceeded-maximum-execution-time) |
| `ORGID_HEADER_UNAVAILABLE` (QuickML) | [§](facts/errors.md#orgid_header_unavailable) |
| `cron_url_details cannot be null` | [§](facts/errors.md#cron_url_details-cannot-be-null) |
| `403 VERIFICATION_NEEDED` / `You need to verify the email domain` | [§](facts/errors.md#403-verification_needed-on-mail-send) |
| `403 PUBLIC_SIGNUP_ERROR` / `You cannot perform this action. Public Signup restricted.` | [§](facts/errors.md#403-public_signup_error) |
| `401 {"error":"sign in required"}` / a browser `project-user/current` 401 | [§](facts/errors.md#401-errorsign-in-required) |
| `401 NO_ACCESS` on a function URL | [§](facts/errors.md#401-no_access-on-a-function-url) |
| `blocked by CORS policy` / no `Access-Control-Allow-Origin` | [§](facts/errors.md#cors-preflight-has-no-allow-origin) |
| `Bucket already exists` | Global bucket namespace — retry with the deterministic suffix `c2c-<link>-<h8>` |
| `invalid_client` at sign-in in Production | The embedded-auth config did not carry to Production — reconfigure it there and record the new ZAID |
| `500 {"dryRun":true,"error":"request failed"}` | [the opaque handler error](facts/errors.md#opaque-500-dryruntrueerrorrequest-failed) — find the real store error behind it |
| `405` on `GET /reports/<r>` | [generated report routes are POST](facts/errors.md#report-route-answers-405-on-get) |
| A lookup `<select>` shows zero options, or a report cell shows a raw ROWID | [the lookup route or display field is missing](facts/errors.md#lookup-options-empty-or-raw-rowids) |

## Creator export and runtime

| Error text | Entry / fix |
|---|---|
| `Something went wrong. Please retry.` / `Problem occurred during publish` | A component fails the publish precheck — run the analyzer's precheck rules, fix the named components in Creator, re-export |
| A blank export, or an export that fails on a corrupted workflow | [§](facts/errors.md#workflow-corrupted-on-export) |
| `The number of arguments for 'X' function does not match the number of mandatory params 'N'.` | [§](facts/errors.md#argument-count-does-not-match) |
| `Void function 'X' cannot be used in expression` | [§](facts/errors.md#void-function-used-in-an-expression) |
| `Data type of argument at index 'N' of the function 'X' did not match the required data type` | [§](facts/errors.md#argument-data-type-does-not-match) |
| `'success message' can be used only in on success actions` | [§](facts/errors.md#success-message-can-be-used-only-in-on-success-actions) |
| `The "from" address can only be zoho.adminuserid, zoho.loginuserid, or a verified email address` | [§](facts/errors.md#sendmail-from-address) |
| `DS IMPORT :: DS FILE LIMIT EXCEEDED` | [§](facts/errors.md#ds-import--ds-file-limit-exceeded) |
| `UPLOAD_RULE_NOT_CONFIGURED` (code 2945) | [§](facts/errors.md#upload_rule_not_configured) |
| `3100` / `No Data Available` from a zoho.creator record call | [§](facts/errors.md#3100-no-data-available) |
| `Improper Statement` / `Error might be due to missing ';' at end of the line` on insert-into | [§](facts/errors.md#improper-statement-inside-insert-into) |
| `is not supported in left expression of criteria` | [§](facts/errors.md#criteria-left-expression-is-not-supported) |
| `Column 'X' does not belongs to 'Y' view` | [§](facts/errors.md#column-does-not-belong-to-the-view) |
| `The component 'X' does not have section mapping for Web version.` | [§](facts/errors.md#report-has-no-web-section-mapping) |
| `Invalid entries found` / `Enter a valid phone number` / `Enter a valid email address` | [§](facts/errors.md#invalid-entries-found) |
| A pivot report fails to export or migrate | [§](facts/errors.md#pivot-report-is-an-analytics-object) — pivots are Analytics objects, out of scope |
| `You have reached your API call limit` (HTTP 429 from Creator) | [§](facts/errors.md#creator-you-have-reached-your-api-call-limit) |
| A raw insert skips a column's initial value | [§](facts/errors.md#initial-values-skipped-on-api-insert) |
