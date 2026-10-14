---
name: c2c-troubleshooting
description: "Diagnose any error during a c2c Creator-to-Catalyst migration by exact error string: Catalyst API errors (OAUTH_SCOPE_MISMATCH, MANDATORY_MISSING, INVALID_URL_PATTERN, DUPLICATE_VALUE, INVALID_INPUT, PUBLIC_SIGNUP_ERROR, API_LIMIT_REACHED, 'Reached max number of columns of Unique varchar type'), Catalyst CLI crashes ('An unexpected error has occurred. Kindly contact Catalyst support', findIndex, bucket_name), MCP host errors ('invalid MCP url', PERMISSION_NEEDED), c2c exit codes, and Creator export/publish errors. Use for '/c2c:troubleshoot', 'error', 'failed', 'not working', '401', '403', '404', '500 request failed'."
metadata:
  version: "0.2.0"
---

# Troubleshooting

## Method (never guess)

1. **Get the exact text.** The full error line, the command or tool that produced it, the step id, and the HTTP status. For a CLI crash that says "contact Catalyst support", re-run the same command with `--verbose` (global CLI flag) and read the debug lines; the real error is there (e.g. `TypeError: existingSlates.findIndex is not a function`).
2. **Look it up** in `references/error-index.md` by substring (normalise numbers to `N` and names to `X`). Use the first matching row.
3. **Confirm the cause** with the read-only check the row names (a list call, a probe, a file field) before changing anything.
4. **Apply the fix** the row names. If it is a user action (login, console click, consent), tell the user exactly what to do. If it is a c2c defect, report it to the maintainers via the issue tracker and stop; do not hand-edit generated files.
5. **Resume** the failed step with `--resume` / `c2c provision --out c2c-out/<app> --next`. Never delete resources to "start clean".
6. **Not in the index?** Say so. Collect the exact text and context, mark the step blocked, and suggest a probe or a report to the maintainers via the issue tracker. Do not declare the feature unsupported (C2C.md rule 9).

## Facts ledger routing

For a fact-backed error, open its exact entry in the [errors facts ledger](../../references/facts/errors.md). These links keep all verified error recipes reachable from this skill; the verb skills remain the procedure entry points.

| Error fact | Ledger entry |
|---|---|
| `409 DUPLICATE_ENTRY` on project import | [Open fact](../../references/facts/errors.md#409-duplicate_entry-on-project-import) |
| `400 PROJECT_CREATION_NOT_ALLOWED` | [Open fact](../../references/facts/errors.md#400-project_creation_not_allowed) |
| `400 MISSING_PARAM` on import deploy | [Open fact](../../references/facts/errors.md#400-missing_param-on-import-deploy) |
| `Error_Processing` while importing an existing project | [Open fact](../../references/facts/errors.md#error_processing-while-importing-an-existing-project) |
| `400 INVALID_INPUT` on export body keys | [Open fact](../../references/facts/errors.md#400-invalid_input-on-export-body-keys) |
| Delete refused while Production is enabled | [Open fact](../../references/facts/errors.md#delete-refused-while-production-is-enabled) |
| `401 OAUTH_SCOPE_MISMATCH` | [Open fact](../../references/facts/errors.md#401-oauth_scope_mismatch) |
| `401 AUTHENTICATION_FAILURE` | [Open fact](../../references/facts/errors.md#401-authentication_failure) |
| `Error when refreshing the access token` | [Open fact](../../references/facts/errors.md#error-when-refreshing-the-access-token) |
| `404 INVALID_URL_PATTERN` | [Open fact](../../references/facts/errors.md#404-invalid_url_pattern) |
| `400 BROWSER_COOKIES_DISABLED` | [Open fact](../../references/facts/errors.md#400-browser_cookies_disabled) |
| `400 INVALID_REQUEST_METHOD` on connections | [Open fact](../../references/facts/errors.md#400-invalid_request_method-on-connections) |
| `406 INVALID_OPERATION` in Production | [Open fact](../../references/facts/errors.md#406-invalid_operation-in-production) |
| Third unique varchar column | [Open fact](../../references/facts/errors.md#third-unique-varchar-column) |
| `Text column cannot be Unique` | [Open fact](../../references/facts/errors.md#text-column-cannot-be-unique) |
| `400 PATTERN_NOT_MATCHED` on column type | [Open fact](../../references/facts/errors.md#400-pattern_not_matched-on-column-type) |
| `400 JSON_PARSE_ERROR` on column create | [Open fact](../../references/facts/errors.md#400-json_parse_error-on-column-create) |
| `409 DUPLICATE_VALUE` | [Open fact](../../references/facts/errors.md#409-duplicate_value) |
| `403 MANDATORY_MISSING` | [Open fact](../../references/facts/errors.md#403-mandatory_missing) |
| `400 INVALID_INPUT` for a date | [Open fact](../../references/facts/errors.md#400-invalid_input-for-a-date) |
| ZCQL `data too long for column` | [Open fact](../../references/facts/errors.md#zcql-data-too-long-for-column) |
| ZCQL `For input string: "nu"` | [Open fact](../../references/facts/errors.md#zcql-for-input-string-nu) |
| REST 200 stored a different value | [Open fact](../../references/facts/errors.md#rest-200-stored-a-different-value) |
| Bulk write rejects a non-CSV object | [Open fact](../../references/facts/errors.md#bulk-write-rejects-a-non-csv-object) |
| `429` and `Concurrency limit reached for the feature COMPONENT` | [Open fact](../../references/facts/errors.md#429-and-concurrency-limit-reached-for-the-feature-component) |
| `API_LIMIT_REACHED` | [Open fact](../../references/facts/errors.md#api_limit_reached) |
| `Table Join Limitation` | [Open fact](../../references/facts/errors.md#table-join-limitation) |
| `More than 30 select columns are not allowed` | [Open fact](../../references/facts/errors.md#more-than-30-select-columns-are-not-allowed) |
| `Throttle Limit Reached` | [Open fact](../../references/facts/errors.md#throttle-limit-reached) |
| `Query Processing Error` | [Open fact](../../references/facts/errors.md#query-processing-error) |
| `408 EXECUTION_TIME_EXCEEDED` | [Open fact](../../references/facts/errors.md#408-execution_time_exceeded) |
| Job or request exceeded maximum execution time | [Open fact](../../references/facts/errors.md#job-or-request-exceeded-maximum-execution-time) |
| `ORGID_HEADER_UNAVAILABLE` | [Open fact](../../references/facts/errors.md#orgid_header_unavailable) |
| `cron_url_details cannot be null` | [Open fact](../../references/facts/errors.md#cron_url_details-cannot-be-null) |
| `403 VERIFICATION_NEEDED` on mail send | [Open fact](../../references/facts/errors.md#403-verification_needed-on-mail-send) |
| `403 PUBLIC_SIGNUP_ERROR` | [Open fact](../../references/facts/errors.md#403-public_signup_error) |
| `401` `{"error":"sign in required"}` | [Open fact](../../references/facts/errors.md#401-errorsign-in-required) |
| `401 NO_ACCESS` on a function URL | [Open fact](../../references/facts/errors.md#401-no_access-on-a-function-url) |
| CORS preflight has no allow-origin | [Open fact](../../references/facts/errors.md#cors-preflight-has-no-allow-origin) |
| CLI `An unexpected error has occurred. Kindly contact Catalyst support` | [Open fact](../../references/facts/errors.md#cli-an-unexpected-error-has-occurred-kindly-contact-catalyst-support) |
| `TypeError: existingSlates.findIndex is not a function` | [Open fact](../../references/facts/errors.md#typeerror-existingslatesfindindex-is-not-a-function) |
| `TypeError: Cannot read properties of undefined (reading 'bucket_name')` | [Open fact](../../references/facts/errors.md#typeerror-cannot-read-properties-of-undefined-reading-bucket_name) |
| `400` `Please access the Slate service in your project's console before deploying via the CLI.` | [Open fact](../../references/facts/errors.md#400-please-access-the-slate-service-in-your-projects-console-before-deploying-via-the-cli) |
| `HTTP Error: 404, No such app with the given id exists` | [Open fact](../../references/facts/errors.md#http-error-404-no-such-app-with-the-given-id-exists) |
| Job pool name rejected | [Open fact](../../references/facts/errors.md#job-pool-name-rejected) |
| `Head_Bucket` reports success for a missing bucket | [Open fact](../../references/facts/errors.md#head_bucket-reports-success-for-a-missing-bucket) |
| Argument count does not match | [Open fact](../../references/facts/errors.md#argument-count-does-not-match) |
| `Void function` used in an expression | [Open fact](../../references/facts/errors.md#void-function-used-in-an-expression) |
| Argument data type does not match | [Open fact](../../references/facts/errors.md#argument-data-type-does-not-match) |
| `'success message' can be used only in on success actions` | [Open fact](../../references/facts/errors.md#success-message-can-be-used-only-in-on-success-actions) |
| Sendmail from address | [Open fact](../../references/facts/errors.md#sendmail-from-address) |
| `DS IMPORT :: DS FILE LIMIT EXCEEDED` | [Open fact](../../references/facts/errors.md#ds-import--ds-file-limit-exceeded) |
| `UPLOAD_RULE_NOT_CONFIGURED` | [Open fact](../../references/facts/errors.md#upload_rule_not_configured) |
| `3100` `No Data Available` | [Open fact](../../references/facts/errors.md#3100-no-data-available) |
| `Improper Statement` inside insert into | [Open fact](../../references/facts/errors.md#improper-statement-inside-insert-into) |
| Criteria left expression is not supported | [Open fact](../../references/facts/errors.md#criteria-left-expression-is-not-supported) |
| Column does not belong to the view | [Open fact](../../references/facts/errors.md#column-does-not-belong-to-the-view) |
| Report has no Web section mapping | [Open fact](../../references/facts/errors.md#report-has-no-web-section-mapping) |
| `Invalid entries found` | [Open fact](../../references/facts/errors.md#invalid-entries-found) |
| Pivot report is an Analytics object | [Open fact](../../references/facts/errors.md#pivot-report-is-an-analytics-object) |
| Creator `You have reached your API call limit` | [Open fact](../../references/facts/errors.md#creator-you-have-reached-your-api-call-limit) |
| Workflow corrupted on export | [Open fact](../../references/facts/errors.md#workflow-corrupted-on-export) |
| Initial values skipped on API insert | [Open fact](../../references/facts/errors.md#initial-values-skipped-on-api-insert) |
| Opaque `500 {"dryRun":true,"error":"request failed"}` | [Open fact](../../references/facts/errors.md#opaque-500-dryruntrueerrorrequest-failed) |
| Report route answers `405` on GET | [Open fact](../../references/facts/errors.md#report-route-answers-405-on-get) |
| Lookup options empty or raw ROWIDs | [Open fact](../../references/facts/errors.md#lookup-options-empty-or-raw-rowids) |

## c2c exit codes

| Code | Meaning | Next |
|---|---|---|
| 0 | OK | — |
| 1 | Findings/blockers (precheck), a failed live step, verify drift | Read the report file named in the output |
| 2 | Usage error | Read the usage line; most often a missing `--project`/`--org`/`--out` |
| 3 | Input file missing | Path to the `.ds` |
| 4 | Not a parseable `.ds` | Re-export from Creator |
| 5 | Doctor not green / stale / different scope (planned) | `/c2c:doctor` |
| 6 | Node or plugin integrity problem (bin/c2c) | Node 20 or 22 (>=20.20 <23); reinstall the plugin |

## CLI credential errors (one credential, one refresher)

`Error when refreshing the access token`, an empty stored token, or a read-only `401 INVALID_TOKEN` means a second process refreshed the same login — the refresh token rotates on refresh (the entry in `references/facts/errors.md`). Have the user stop every other `catalyst`/`c2c` process or keep-fresh loop sharing the credential, re-read the stored token (or `catalyst whoami`, then `catalyst login --dc <dc>` if it still fails), then resume with `--resume`. Never fix it by starting another refresher or by copying the credential to a second profile (C2C.md rule 14).

## Where to look

- c2c reports: `c2c-out/<app>/c2c-deploy-report.json`, `provision/state.json`, `state/*.json`, `verify/report.json`.
- Function logs: MCP `CatalystbyZoho_Get_Logs` (resource = `c2c_api`, level error, date range). If you only see "Execution started", the handler did not log.
- Browser console of the Slate app (ask the user to copy the red lines): `project-user/current 401` = not signed in; "blocked by CORS policy" = Authorized Domain missing.
- Catalyst CLI debug: `--verbose`.

## Stop conditions

- The fix requires credentials, consent or a console click → hand it to the user; wait.
- **Rule — default settings only (C2C.md rule 13).** Never fix by driving a browser or console or by changing permission rules — user actions are guided asks (exact steps, then "done?") and every diagnosis is confirmed by a read-only check or read-back.
- The fix requires changing generated code → stop; it is a c2c defect.
- The cause is not confirmed by a read-only check.

## What to ask the user

- The exact error text and what they were doing (if it happened in their browser or console).
- Permission before any re-run that writes.
