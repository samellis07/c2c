---
name: c2c-troubleshooting
description: "Diagnose any error during a c2c Creator-to-Catalyst migration by exact error string: Catalyst API errors (OAUTH_SCOPE_MISMATCH, MANDATORY_MISSING, INVALID_URL_PATTERN, DUPLICATE_VALUE, INVALID_INPUT, PUBLIC_SIGNUP_ERROR, API_LIMIT_REACHED, 'Reached max number of columns of Unique varchar type'), Catalyst CLI crashes ('An unexpected error has occurred. Kindly contact Catalyst support', findIndex, bucket_name), MCP host errors ('invalid MCP url', PERMISSION_NEEDED), c2c exit codes, and Creator export/publish errors. Use for '/c2c:troubleshoot', 'error', 'failed', 'not working', '401', '403', '404', '500 request failed'."
metadata:
  version: "0.2.0"
---

# Troubleshooting

For limits and quota failures, use the evidence labels in `plugin/references/facts/limits.md`; `[UNVERIFIED]` is a planning assumption, while `[TESTED]` must link to an existing public test or run record. Do not infer a numeric cap from an error code alone.

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
| `400 INVALID_INPUT` / `Email Id cannot contain '+' character` | [Open fact](../../references/facts/errors.md#400-invalid_input--email-id-cannot-contain--character) |
| `users invite`: role has no id (GET /role refused) | [Open fact](../../references/facts/errors.md#role-id-unknown-for-c2c-users-invite) |
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

## Doctor check failures

After `/c2c:doctor`, use the exact `FAIL D-*` id below. Only failing checks need a route; `WARN`, `SKIP`, and `NOTE` are not failures. User steps below are guided asks: state the command or setting and wait for the user to do it. Do not sign in, edit account settings, or use a browser for them. Fix local configuration or inputs in the workspace only when the user has asked for that change.

| Check | Troubleshooting route |
|---|---|
| D-A1 | Install the official Catalyst skills for the host: Claude Code `/plugin marketplace add catalystbyzoho/claude-plugin`, then `/plugin install catalyst-by-zoho@catalyst-by-zoho`; OpenAI Codex — install the Catalyst agent skills per the Catalyst plugin's own Codex install instructions so that `~/.codex/skills/catalyst-by-zoho/SKILL.md` exists (doctor reads `${CODEX_HOME:-~/.codex}/skills/catalyst-by-zoho/SKILL.md`; the exact source repo path is [UNVERIFIED] per `references/doctor-spec.md` D-A1); Cursor sets `C2C_CATALYST_SKILLS_DIR` to the skills directory. Re-run doctor. |
| D-A2 | Ask the user to run `/plugin enable catalyst-by-zoho@<marketplace>` in Claude Code and restart the session; then re-run doctor. |
| D-A3 | Ask the user to restart the host session so the installed Catalyst skills load; on Codex, verify each required `~/.codex/skills/<name>/SKILL.md` exists; then re-record doctor evidence. |
| D-C1 | Ask the user to install `zcatalyst-cli` with Node 20 (`npm install -g zcatalyst-cli`), then check `catalyst --version`. |
| D-C2 | Ask the user to update `zcatalyst-cli` (`npm install -g zcatalyst-cli@latest`), then re-run doctor. |
| D-C3 | Ask the user to run `catalyst login --dc <dc>` and complete the Zoho sign-in, then re-run doctor. |
| D-C4 | Ask the user to `catalyst logout`, then `catalyst login --dc <dc>` with the account that owns the org. If CLI and MCP project lists differ, have the user re-sign in to the mismatched client and collect fresh evidence containing project ids/names only. |
| D-C5 | Set the workspace `c2c-deploy.json` `dc` to the target DC, or pass `--dc <dc>`, then re-run doctor. |
| D-D1 | Re-export the Creator app as a valid, non-empty `.ds` export and pass its path with `--app`; if parsing still fails, capture the exact parser error for maintainers. |
| D-D3 | For a data migration, export each Creator report as CSV with its `ID` column, put the files and `counts.json` in `exports/<app>-data/`, and pass `--source-csv <dir>`. |
| D-E1 | Install and select the pinned Node version shown by doctor (`nvm install <pinned> && nvm use <pinned>`), then re-run doctor. |
| D-E3 | Reinstall the c2c plugin (`/plugin uninstall c2c`, then install again), then re-run doctor. |
| D-E4 | Run c2c from the user's writable workspace folder, not inside the plugin directory; if it still cannot write, check workspace permissions. |
| D-F1 | Choose an existing Catalyst project in `c2c-deploy.json`, or ask the user to delete an unused project / request a higher limit from Catalyst support. Never delete a project yourself. |
| D-F2 | Set `env` to `Development` in `c2c-deploy.json`; production cutover follows `/c2c:verify`. If the selected project is protected, choose another project. |
| D-F3 | Refresh the project table evidence with `/c2c:doctor`; if an update plan reports tables missing from or outside the plan, reconcile the plan with the target project before provisioning. |
| D-F4 | Re-run `/c2c:doctor` to record the org table count. If the combined existing and planned count exceeds the limit, reduce the planned tables or ask Catalyst support about the limit. |
| D-F5 | Reduce the per-table budget breach in `/c2c:plan`: choose which fields lose `No Duplicate` (c2c enforces them in the app layer), or let the splitter handle it; then plan again. |
| D-F7 | Ask the user to check the project in the Catalyst console; if it stays Importing, contact Catalyst support, or create the app under a new project name. A stuck import cannot be deleted and holds its name. Do not retry the delete. |
| D-B1 | Correct the Catalyst MCP server URL/entry for the target DC, restart the host session, and re-record doctor evidence. |
| D-B2 | Align the MCP endpoint with the target Catalyst DC: correct its URL and restart, or ask the user to run `/catalyst-by-zoho:switch-dc <DC>`; re-record evidence. |
| D-B3 | Ask the user to open `/mcp` in Claude Code or run `codex mcp login catalyst-by-zoho`, complete Zoho sign-in, then re-record evidence. |
| D-B5 | Update/reconnect the Catalyst plugin's global MCP server, or ask the user to add all required “Catalyst by Zoho” tools under `mcp.zoho.com` → server → Tools → Config Tools; re-record evidence. |
| D-B7 | Re-record org evidence using `/c2c:doctor --mcp-begin`, the `CatalystbyZoho_List_All_Organizations` call, and `c2c doctor --mcp-observed -`. If the MCP cannot see the target org, ask the user to sign it in to the Zoho account that owns the org. |
| D-V1 | Compare target config, MCP endpoint, and CLI account DC; correct the mismatched endpoint/account using the D-B2 or D-C4 route, then re-record. |
| D-V2 | Re-run `/c2c:doctor` in the target workspace and collect fresh MCP evidence; stale evidence cannot be reused. A plain `c2c doctor` reuses the last observed MCP evidence (`c2c-out/.c2c/mcp-state.json`) for the same DC/org/project and c2c version for 12 h after it was observed and says `observed <age> ago`; after 12 h, for another scope, or when it says `stored MCP evidence … not used` (the record was edited, copied or not signed by this user's doctor), run `c2c doctor --mcp-begin` and `--mcp-observed -` again. Never patch `mcp-state.json`. |
| D-V3 | FAIL D-V3 means the recorded MCP server list in the doctor evidence is malformed — each `servers` entry must be an object `{name, host}`, never a bare name. Re-record the evidence with `/c2c:doctor` (`c2c doctor --mcp-begin`, make the MCP calls it names, then `c2c doctor --mcp-observed -`); if it still fails, the recorded evidence was hand-edited — regenerate it instead of patching the file. |
| D-R1 | For a React UI, ask the user to install/select the pinned Node version shown by doctor, then re-run doctor. |
| D-R2 | Install/select the pinned Node version (npm ships with it), or update npm to the minimum version shown by doctor; then re-run doctor. |
| D-R4 | Repair the Node/npm installation if `npm config get cache` returns nothing. Otherwise ask the user to make the reported cache writable or choose a writable npm cache (`npm config set cache <dir>`). |
| D-M1 | Set `mail.from` in `c2c-deploy.json` if none is set, then ask the user to verify that sender in the Catalyst console (Mail → Email Configuration). `mail.verified` is only the operator's attestation and never counts as verified. After verification, re-run `c2c deploy app.ds --confirm --function-env function-env.json` so the live Catalyst read-back is recorded under `c2c-out/.c2c/mail-sender.json`, then re-run doctor. |

Checks omitted from this table currently emit no `FAIL` result: D-A4, D-B4, D-B6, D-D2, D-E2, and D-R3 are warning/skip/info-only today; D-F6 is warning/pass-only. `WARN D-B8` means a probe bucket the doctor created (`c2cprobe-p<project-id>`, or a legacy `c2cprobe<request-id>` still tracked) may still exist: in the session call the `CatalystbyZoho_Delete_Bucket` the doctor printed under `cleanup` (by exact `bucket_name`; never another bucket) — the warning clears once a read-back shows it gone. Also delete this run's nonce object when the doctor prints that PUT; deleting the object does not clear D-B8. D-B6, D-F5 JOIN/SELECT, and D-F6 row-count limits may also be described as deferred notes. A new failing `D-*` must get a route here in the same change that adds the check.

## CLI credential errors (one credential, one refresher)

`Error when refreshing the access token`, an empty stored token, or a read-only `401 INVALID_TOKEN` means a second process refreshed the same login — the refresh token rotates on refresh (the entry in `references/facts/errors.md`). Have the user stop every other `catalyst`/`c2c` process or keep-fresh loop sharing the credential, re-read the stored token (or `catalyst whoami`, then `catalyst login --dc <dc>` if it still fails), then resume with `--resume`. Never fix it by starting another refresher or by copying the credential to a second profile (C2C.md rule 14).

## Service not started (first-use gate closed)

`<Service> first-use gate is closed (GET … → …). Checklist: …` from `deploy --confirm`, `migrate-data --seed --confirm` or `c2c provision --out c2c-out/<app> --record <gate>-enable` means the project never opened a service the app uses. First activation has no API, CLI or MCP path: hand the user the one sentence for that service, then re-run (deploy: `--resume`) — c2c probes the gate again and continues only on an open answer.

- Stratus — in the Catalyst console open the project → Cloud Scale → Stratus → Start Exploring, then on Create your First Bucket create one bucket (any name) and wait until it shows in the Stratus bucket list — click Create again if nothing happens after a few seconds [TESTED]
- SmartBrowz — in the Catalyst console open the project → SmartBrowz → Start Exploring
- Slate — in the Catalyst console open the project → Slate → Start Exploring

Name only the services the app uses; never ask for a service the app does not use. The gate table is in [facts/projects.md](../../references/facts/projects.md#console-first-use-gates-are-one-checklist-line-plus-a-read-c2c-verifies).

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
