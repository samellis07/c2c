# Error index: exact error text → the entry that covers it

Match by substring — normalise numbers to `N` and names to `X`, then take the
first matching row. The entry is the rule in [facts/errors.md](facts/errors.md);
it carries the cause, the confirming read-only check, the fix and the recipe.
Rows that name a doctor check point into [doctor-spec.md](doctor-spec.md); the
few rows with neither keep their fix inline. "Stop" means the migration step
must not continue until fixed.

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
| `400 INVALID_INPUT` / `Email Id cannot contain '+' character` on Add User | [§](facts/errors.md#400-invalid_input--email-id-cannot-contain--character) |
| `users invite`: `role App Administrator has no id in this project (GET /role is refused ...)` | [§](facts/errors.md#role-id-unknown-for-c2c-users-invite) |
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
| A pivot report fails to export or migrate | [§](facts/errors.md#pivot-report-is-an-analytics-object) — Analytics pivots are not migrated; C2C continues with supported app data |
| `You have reached your API call limit` (HTTP 429 from Creator) | [§](facts/errors.md#creator-you-have-reached-your-api-call-limit) |
| A raw insert skips a column's initial value | [§](facts/errors.md#initial-values-skipped-on-api-insert) |
