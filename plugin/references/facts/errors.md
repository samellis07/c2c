# Errors

Match the first exact substring. Stop the step, apply the fix, then read the resource back. Token calls use `https://api.catalyst.<dc>` (`<dc>` from config) and header names Authorization, Accept, X-CATALYST-Environment, and CATALYST-ORG. Accept is `application/vnd.catalyst.v2+json`. Placeholders are `<org-id>` and `<project-id>`.

## Project lifecycle

### `409 DUPLICATE_ENTRY` on project import

Rule: On `409 DUPLICATE_ENTRY` the project name is already in use. Append a suffix to project_name (try `-2`, `-3` … `-5` suffixes, up to 5 names in all) and retry the greenfield import. Import into an existing project is not supported; create a new one.

Cause: POST /baas/v1/project/import was sent with a project_name that already exists.

Fix: Change project_name and repeat the import. Do not PUT /baas/v1/project/<project-id>/import.

Recipe: POST /baas/v1/project/import multipart fields project_name, template_format=JSON, code=<zip>, schedule=false. Send Authorization, Accept, and CATALYST-ORG: <org-id> on the POST, the deploy-confirm GET, and every import-status GET. Confirm with GET /baas/v1/project/import/<import-id>/deploy?catalyst_org=<org-id>&redirect_url=<url>. Poll GET /baas/v1/project/import/<import-id> until Completed. Refuse the import before making a request if the target org id is unresolved; never let Catalyst choose a default org.

### `400 PROJECT_CREATION_NOT_ALLOWED`

Rule: `400 PROJECT_CREATION_NOT_ALLOWED` with `Project creation is not supported in this CLI version` means the direct create path is closed.

Cause: POST /baas/v1/project with a project_name body.

Fix: Create the project with the greenfield import in the previous rule. Do not retry POST /baas/v1/project with a different client version.

Recipe: POST /baas/v1/project returns this 400. Success is the import poll reaching Completed and GET /baas/v1/project listing the new id.

### `400 MISSING_PARAM` on import deploy

Rule: `400 MISSING_PARAM` on the import deploy URL means redirect_url was omitted.

Cause: GET /baas/v1/project/import/<import-id>/deploy lacked the query parameter.

Fix: Repeat the GET with catalyst_org=<org-id> and redirect_url set. POST or PUT of that URL returns `400 INVALID_REQUEST_METHOD`; use GET.

Recipe: GET /baas/v1/project/import/<import-id>/deploy?catalyst_org=<org-id>&redirect_url=<url> with header Authorization. Success is HTTP 200, then poll status Completed.

### `Error_Processing` while importing an existing project

Rule: Status `Error_Processing` and `Internal error occurred while importing the project` mean the update import applied nothing.

Cause: PUT /baas/v1/project/<project-id>/import, including an unchanged export, an additive table, or the call `catalyst codelib:install` makes.

Fix: Stop. Change the live project with the per-resource calls in the surface decision table, or create a new project with POST /baas/v1/project/import. A later export that matches the earlier export confirms nothing was applied.

Recipe: Poll GET /baas/v1/project/import/<import-id>. Success is not expected on this PUT. The safe success is a greenfield import reaching Completed, or a single-resource read-back after a targeted call.

### `400 INVALID_INPUT` on export body keys

Rule: `400 INVALID_INPUT` on export means the body contained a key the export API does not accept.

Cause: POST /baas/v1/project/<project-id>/export included mask_secrets, mask, exclude_env_variables, redact, or another unknown key.

Fix: Send only `{"template_format":"JSON"}`. Treat the downloaded zip as secret: function environment values and cron header values are in clear text. Do not write the zip into a shipped file or a log.

Recipe: POST /baas/v1/project/<project-id>/export, poll GET /baas/v1/project/<project-id>/export/status until Completed, GET …/export/download. Success is a zip whose project-template-1.0.0.json lists roles. Catalyst CLI `catalyst iac:export` accepts only `--production` besides the default.

### Delete refused while Production is enabled

Rule: `400 INVALID_OPERATION` and `This project is currently in the production environment. Disable the project's production environment to complete this operation.` means delete is blocked.

Cause: DELETE /baas/v1/project/<project-id> while Production is on. POST /environment/disable is not a token call.

Fix: The user disables Production in the console, then repeat DELETE. Do not delete a project you still need.

Recipe: DELETE /baas/v1/project/<project-id> with the token headers. Success is HTTP 200 and the id absent from GET /baas/v1/project.

## Scope and host

### `401 OAUTH_SCOPE_MISMATCH`

Rule: `401 OAUTH_SCOPE_MISMATCH` and `invalid oauth scope to access this URL` mean this token cannot call that path. The login token's scopes are fixed. Retrying on the console host with the same token fails the same way.

Cause: The token called a path outside its scopes. Common ones: POST /job_scheduling/jobpool, POST /bucket, GET /role, GET /role/<role-id>, GET /authentication/configuration, GET /cors-domain, PUT /table/<table-id>/permission, PUT /table/<table-id>/scopes, POST /nosqltable, any Signals API path, POST /email/send is a different error when the domain is unverified.

Fix: Use the surface decision table. Job pool, bucket, table permissions, table scopes, auth-config read, role read, and CORS read go through the named MCP tool. Signals, custom roles, connections, and Production promotion are guided console steps. Do not create a NoSQL table; use a child table.

Recipe: The failing call already happened. Read-back is the MCP list or get for that resource, or a GET that the token is allowed to make (GET /bucket, GET /job_scheduling/jobpool, GET /nosqltable, GET /connections).

### `401 AUTHENTICATION_FAILURE`

Rule: `401 AUTHENTICATION_FAILURE` on a write means the token is not accepted for that operation at all, not merely short one scope.

Cause: POST /baas/v1/project/<project-id>/role, or a console-only action (Production enable, diff, migrate or disable; a service's Start Exploring) attempted with the CLI token.

Fix: Custom roles and Production enable, diff, migrate, and disable are guided console steps. Skip Start Exploring for Data Store, Functions, and Authentication; on a fresh imported project Slate needs that console click before the first `catalyst deploy slate`. Declare custom roles, table scopes, and table permissions in the greenfield template when the project is created.

Recipe: Do not retry the token call. Success is the console action's read-back: MCP CatalystbyZoho_List_All_Roles, or GET /baas/v1/project/<project-id>/environment showing both environments after a promotion the user ran.

### `Error when refreshing the access token`

Rule: `Error when refreshing the access token`, or a stored token that reads back empty, means the CLI credential's refresh token was rotated under it — a second process refreshed the same login and invalidated this one's copy.

Cause: two refreshers on one credential — parallel `catalyst`/`c2c` runs, a keep-fresh loop running beside a run, or the same credential copied to another machine or profile. A read-only `401 INVALID_TOKEN` can mean the same thing: the other process already renewed the token.

Fix: Stop every process sharing the credential, then have the user run `catalyst whoami`; if it still fails, `catalyst login --dc <dc>` again. On a read-only `401 INVALID_TOKEN`, re-read the stored token before forcing anything — a forced local refresh is opt-in (`C2C_ALLOW_LOCAL_REFRESH=1`) and only for a single user who owns the only credential. Then keep one refresher per credential (the one-refresher rule in `projects.md`).

Recipe: `catalyst whoami` prints `Logged as: <email>` again. Success is the failed read-only call retried after re-reading the stored token — never a second refresher started beside the first.

### `404 INVALID_URL_PATTERN`

Rule: `404 INVALID_URL_PATTERN` and `Please check if the URL trying to access is a correct one` mean the path does not exist.

Cause: A wrong path. The row collection is `/table/<table-id>/row`, not `/rows`. `/project-user/roles` does not exist. A connection create posted to the api host 404s. Quota paths 404. [UNVERIFIED] GET .../bucket/<name> answered 404 INVALID_URL_PATTERN in one DC; the list route works (`jobs-and-files.md`).

Fix: Switch to the path in the surface decision table. A c2c message `c2c: catalyst write failed: 404` is this same wrong row path: post to `/row` and include the URL and table name in the error.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row. Success is HTTP 200. GET /baas/v1/project/<project-id>/limits returning this 404 is expected; do not invent a quota path.

### `400 BROWSER_COOKIES_DISABLED`

Rule: `400 BROWSER_COOKIES_DISABLED` (code 3028) means a console-only path received a token instead of a browser session.

Cause: The token was sent to a console-only path, such as a console connection call.

Fix: Create the connection in the console. Read status with GET /baas/v1/project/<project-id>/connections on the api host.

Recipe: Stop the token call. Success is GET /connections containing the link name with connected true after the user finishes consent.

### `400 INVALID_REQUEST_METHOD` on connections

Rule: `400 INVALID_REQUEST_METHOD` on POST /baas/v1/project/<project-id>/connections means connection create has no token method.

Cause: POST of a connection body to the api host.

Fix: Guided console step: the user creates and authorizes the connection in the console (Connections). Then poll the GET.

Recipe: GET /baas/v1/project/<project-id>/connections with the token headers. Success is HTTP 200 and connected true.

### `406 INVALID_OPERATION` in Production

Rule: `406 INVALID_OPERATION` and `You cannot perform this operation for current environment` mean a schema write was sent with the Production environment header.

Cause: POST /table or POST /table/<table-id>/column with X-CATALYST-Environment Production.

Fix: Create schema in Development, promote in the console, then insert rows with the Production header. Row POST under that header returns 200.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row with X-CATALYST-Environment Production. Success is HTTP 200. Do not retry the schema POST against Production.

## Data Store writes

### Third unique varchar column

Rule: `403 INVALID_OPERATION` and `You cannot perform this operation. Reached max number of columns of Unique varchar type` mean the table already has two unique varchar columns. The column batch was not applied.

Cause: POST /table/<table-id>/column tried to add another is_unique varchar.

Fix: c2c plan keeps at most two unique varchar columns. Enforce the other fields in the handler. Make an integer idempotency key a unique bigint. Leave `c2c_source_id` nullable and not unique. Re-run the column step after the plan changes.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/column with a JSON array. Success is HTTP 200 and GET column listing every planned column.

### `Text column cannot be Unique`

Rule: `400` and `Text column cannot be Unique` mean is_unique was set on a text column.

Cause: The column body asked for a unique text column.

Fix: Drop is_unique. Enforce the rule in the handler, or use varchar inside the two-column unique budget.

Recipe: POST the column array without is_unique. Success is HTTP 200.

### `400 PATTERN_NOT_MATCHED` on column type

Rule: `400 PATTERN_NOT_MATCHED` on column create means data_type is not a Data Store type. `email` and bare `encrypted` are not valid column data_type names. The error is the invalid type, and it is returned even when is_unique is set.

Cause: data_type was decimal, numeric, currency, percent, float, bigdecimal, number, email, or encrypted. The encrypted column type is `encrypted text`.

Fix: Use a valid data_type. Store an email as text with an app-side email check. Store an encrypted value as `encrypted text`. Use double with max_length and decimal_digits, or varchar, for a number. Do not drop is_unique to clear this error. Round HALF_UP before a double write. See the limits file.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/column with a one-element JSON array and data_type double, text, or `encrypted text`. Success is HTTP 200.

### `400 JSON_PARSE_ERROR` on column create

Rule: `400 JSON_PARSE_ERROR` and `Check if the input json is proper` mean the column body was an object.

Cause: POST /table/<table-id>/column sent `{"column_name":…}` instead of an array.

Fix: Send a one-element JSON array of the same fields.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/column body `[{…}]` and Content-Type application/json. Success is HTTP 200.

### `409 DUPLICATE_VALUE`

Rule: `409 DUPLICATE_VALUE` and `Duplicate value for <column>. Please give a different value` mean a unique column rejected the row. That is the constraint working for a single writer.

Cause: POST /row or a ZCQL insert repeated a unique value.

Fix: Show the column name on the field. Do not turn the whole request into one opaque 500. Under parallel inserts a unique column can still persist duplicates; do not use it as a lock.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row. Success for a new value is HTTP 200. On this 409, leave the stored row unchanged and return the column name.

### `403 MANDATORY_MISSING`

Rule: `403 MANDATORY_MISSING` and `Column <name> is mandatory and cannot be empty` mean a required column was absent or empty.

Cause: The row omitted a mandatory column. `Column c2c_source_id is mandatory and cannot be empty` means an old table still has that column mandatory. App-created rows do not send a source id.

Fix: Send the field, or alter `c2c_source_id` so it is nullable and not unique. Map the store message onto the form field. Do not replace it with `500 {"dryRun":true,"error":"request failed"}`.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row including every mandatory column, or with `c2c_source_id` omitted when that column is nullable. Success is HTTP 200.

### `400 INVALID_INPUT` for a date

Rule: `400 INVALID_INPUT` and `Invalid input value for <column>. date value expected` mean an empty string or a non-date was sent for a date column.

Cause: The body used `""` for a blank optional date, or a value such as `abc`.

Fix: Omit the key or send null. Normalise real dates to `yyyy-MM-dd` before the call. A REST 200 is not proof the calendar date you sent was stored; read the row back.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row. Success is HTTP 200 and a read-back equal to the normalised date.

### ZCQL `data too long for column`

Rule: `400` and `'…' data too long for column '<column>'` with error_code `ZCQL QUERY ERROR` mean a ZCQL write refused a varchar overflow and did not write.

Cause: INSERT or UPDATE via POST /query put a string longer than max_length.

Fix: Truncate or reject before the query. Do not rely on REST, which returns 200 and stores a prefix. After this 400, a read-back of that key is empty (insert) or unchanged (update).

Recipe: POST /baas/v1/project/<project-id>/query. Success is either HTTP 200 with a matching read-back, or this 400 with no new row.

### ZCQL `For input string: "nu"`

Rule: `400` body `{"error_code":"ZCQL QUERY ERROR","message":"For input string: \"nu\""}` can mean the bad date was already stored.

Cause: A ZCQL INSERT wrote a non-ISO date, then returned this 400. The stored date may already be a rolled value such as `0011-04-18`.

Fix: SELECT the key before any retry. If the row exists, do not insert again. Validate dates before the query.

Recipe: POST /baas/v1/project/<project-id>/query, then SELECT. Success is one row whose date equals the normalised input, or no row when the statement was a pure rejection.

### REST 200 stored a different value

Rule: HTTP 200 on POST or PUT /row can still mean the stored varchar was cut to max_length, the date was rolled, or the double was shortened.

Cause: The body passed the HTTP check and failed the value check. Bulk write does the same and still reports Completed with an empty error-report CSV.

Fix: Validate length, calendar date, and HALF_UP rounding before the call. Read the row back. Do not trust records_processed or an empty error report.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row or POST /bulk/write, then SELECT the row. Success is an exact field match.

### Bulk write rejects a non-CSV object

Rule: `400` and `Invalid Operation! The object should be of .csv file format.` mean the bulk-write object was not a CSV. `400 INVALID_INPUT` on object_details that contains only a url means a remote URL is not a source.

Cause: object_key ended in `.json`, or object_details was `{url:…}`.

Fix: Upload a CSV with PUT to the bucket host, or pass a File Store file_id. Unmatched fk_mapping values are dropped with no error row; load parents first.

Recipe: POST /baas/v1/project/<project-id>/bulk/write and poll GET /bulk/write/<job-id> until Completed. Success is Completed plus the expected COUNT(ROWID).

### `429` and `Concurrency limit reached for the feature COMPONENT`

Rule: HTTP 429, `429 Too Many Requests`, or `Concurrency limit reached for the feature COMPONENT` means the call fan-out is too wide.

Cause: Parallel inserts, updates, or function calls exceeded the concurrency budget. Unique-column calls in the same burst may also return 409 while duplicates persist.

Fix: Cap the pool at 10. Honour Retry-After. Retry only idempotent batches. Do not treat 200 in that burst as proof of uniqueness.

Recipe: Repeat the POST /row or POST /query at a lower concurrency. Success is HTTP 200 and a COUNT that matches the checkpoint.

### `API_LIMIT_REACHED`

Rule: `API_LIMIT_REACHED` with `You have reached the max limit of your current API Limit for row`, or the same code for table, means stop the load or the create. The code has also appeared when the account was not actually over quota, so do not invent a quota story. For table it is an org-wide limit on table creates with no published number or window, not a fixed count: the refusal has fired at a visible count above and below 200 and persisted right after project deletes.

Cause: A Development row cap, an organisation table-create limit (a per-period quota or a count that still includes tables whose delete purge has not run), or a platform refusal that uses this code.

Fix: Show the raw code and the table name. Stop the create or the load and keep what was created; table-free work (redeploys, data loads, smoke) can continue. For the table limit, back off and re-measure — retry the create after 30 minutes, then 60, then 120 — and do not expect a project delete to free capacity immediately. For a large Development load, continue in a project whose environment can hold the rows. Delete unused tables before deleting a project.

Recipe: The failing POST /row or POST /table is the signal. Success after a stop is a later GET /table or COUNT that matches the checkpoint, or a create that succeeds after the backoff window, not a blind retry.

### `Table Join Limitation`

Rule: `Table Join Limitation` means the query has more JOINs than this environment allows.

Cause: A ZCQL statement exceeded the JOIN budget. Assume 4. A higher budget in Development does not apply itself to Production.

Fix: Split into staged reads. c2c plan rejects a query above 4 JOINs.

Recipe: POST /baas/v1/project/<project-id>/query with at most 4 JOINs. Success is HTTP 200 in the environment that will serve the report.

### `More than 30 select columns are not allowed`

Rule: `More than 30 select columns are not allowed` means the SELECT list is too wide.

Cause: The projection exceeded the wide-query cap.

Fix: c2c plan allows at most 20 columns in one SELECT so a tighter cap still passes. Never emit SELECT * on a wide table.

Recipe: POST /query with an explicit column list of at most 20 names. Success is HTTP 200.

### `Throttle Limit Reached`

Rule: `Throttle Limit Reached` means the project URL throttle has tripped, often from an authentication redirect loop. It can stay in place for many hours in Development and Production.

Cause: Repeated sign-in or a redirect loop against the project domain.

Fix: Stop every scripted sign-in. Cap generated redirects at one hop. Wait. Do not retry in a loop.

Recipe: One browser sign-in after the pause. Success is HTTP 200 from project-user/current. Further automation waits.

### `Query Processing Error`

Rule: `Query Processing Error` on a query that used to succeed means the statement is over the project's query time budget at this volume.

Cause: The row count grew. There is no index-create call that fixes it.

Fix: Denormalise the filter column or stage the read. Load-test the report query before cutover.

Recipe: POST /baas/v1/project/<project-id>/query. Success is HTTP 200. On this error, replace the statement; do not retry it unchanged.

## Functions, hosting, mail

### `408 EXECUTION_TIME_EXCEEDED`

Rule: `408 EXECUTION_TIME_EXCEEDED` means an Advanced I/O or AppSail request passed the fixed time cap (about 30 seconds; a 35 second sleep fails around 32 seconds).

Cause: The handler ran too long. A configuration POST with timeout or execution_timeout returns 200 and does not raise the cap, and it can wipe environment variables.

Fix: Move the work to a Job function. Poll the job. Do not post a timeout override.

Recipe: POST /baas/v1/project/<project-id>/job_scheduling/job and poll until SUCCESS. Success is SUCCESS. A request-path retry of the same long call fails again.

### Job or request exceeded maximum execution time

Rule: `function exceeded maximum execution time` and `request exceeded maximum execution time` are the same cap as `408 EXECUTION_TIME_EXCEEDED`, including AppSail.

Cause: The invocation ran past the cap. A Job that is not closed can also sit In Progress until the 15 minute stop.

Fix: Chunk the work, checkpoint, and close the job with closeWithSuccess or closeWithFailure in a finally block. Close a Basic I/O context in a finally block too.

Recipe: Poll the job status. Success is SUCCESS or a failure status with a checkpoint, not In Progress and not a second 408 on the HTTP path.

### `ORGID_HEADER_UNAVAILABLE`

Rule: `ORGID_HEADER_UNAVAILABLE` on a QuickML call means the SDK did not send the org header.

Cause: process.env.X_ZOHO_CATALYST_ORG_ID was unset at runtime. Putting that name into the deploy environment file is refused because the name is reserved.

Fix: Assign `process.env.X_ZOHO_CATALYST_ORG_ID` to `<org-id>` in code before the QuickML call. The SDK then sends header CATALYST-ORG.

Recipe: Deploy the function without that key in env_variables, set it at runtime, and call again. Success is a QuickML response instead of this error.

### `cron_url_details cannot be null`

Rule: `cron_url_details cannot be null` means a legacy cron body pointed at a function id.

Cause: POST /cron used cron_function_id. The function target must be a Job function, and the cron must be a Job Scheduling cron bound to an existing pool.

Fix: Create the pool with MCP CatalystbyZoho_Create_Job_Pool (the token POST /jobpool returns `401 OAUTH_SCOPE_MISMATCH`). Then POST /job_scheduling/cron with cron_name, cron_type, cron_status, jobpool_id, and job_details for a Job function.

Recipe: POST /job_scheduling/cron with the token headers. Success is HTTP 200 and the cron present in CatalystbyZoho_List_All_Crons.

### `403 VERIFICATION_NEEDED` on mail send

Rule: `403 VERIFICATION_NEEDED` and `You need to verify the email domain :: gmail.com before accessing this API` mean the sender domain is not verified. A public mailbox domain cannot be verified.

Cause: POST /baas/v1/project/<project-id>/email/send multipart fields from_email, to_email, subject, content, html_mode used an unverified from_email.

Fix: Send only from a domain the org has verified. Create the sender with MCP CatalystbyZoho_Create_Email_Configuration after the user supplies the mailed code. Do not send a test message unless the user asks.

Recipe: POST /email/send after the sender shows verified in CatalystbyZoho_List_All_Emails_Configuration. Success is HTTP 200.

### `403 PUBLIC_SIGNUP_ERROR`

Rule: `403 PUBLIC_SIGNUP_ERROR` and `You cannot perform this action. Public Signup restricted.` mean signup was called while public signup is off.

Cause: POST /baas/v1/project/<project-id>/project-user/signup. An empty POST /project-user can return 500; that is a bad body, not a scope refusal.

Fix: POST /project-user with user_details.email_id, user_details.role_id, platform_type `web`, and redirect_url. Or MCP CatalystbyZoho_Add_User. Do not turn public signup on to get past this error. Default public_signup is false.

Recipe: POST /baas/v1/project/<project-id>/project-user. Success is HTTP 200, is_confirmed false until the person confirms, then GET /project-user shows is_confirmed true.

### `401` `{"error":"sign in required"}`

Rule: `401 {"error":"sign in required"}` from the generated API means the caller is not an app user. The developer CLI token is not an app user.

Cause: The request had no app-user session. A browser `GET …/project-user/current` 401 is the same fact.

Fix: Enable hosted and embedded authentication, add the CORS domain, invite the person, and have them sign in on the app URL. Then project-user/current returns 200.

Recipe: POST /baas/v1/project/<project-id>/authentication/enable?auth_type=hosted with body `{"public_signup":false}`, and the same path with auth_type=embedded. Read-back is MCP CatalystbyZoho_Get_Authentication_Configurations. An unauthenticated call to the function should stay 401 after the security rule is on.

### `401 NO_ACCESS` on a function URL

Rule: `401 NO_ACCESS` from an unauthenticated call to a function URL means the security rule `required` is on and working. A signed-in session is accepted by the gateway, so run the check credential-free — `curl -s -o /dev/null -w '%{http_code}' <function-url>` prints `401` and carries no session.

Cause: The function's security rule requires an app-user session and the caller had none.

Fix: None when the rule is `required` — this is the pass signal. If the call serves data instead, set the rule: the SecurityRules template component or the console; the CLI has no command for it and deploy leaves the function `optional`.

Recipe: `curl -s -o /dev/null -w '%{http_code}' <function-url>` (add `-X POST` for a POST route). Success is `401 NO_ACCESS`; the same call signed in reaches the function.

### CORS preflight has no allow-origin

Rule: A browser error that the request was blocked by CORS policy because there is no Access-Control-Allow-Origin header means the Slate host is not an authorized domain.

Cause: The app host was not posted to cors-domain. GET /cors-domain with the token returns `401 OAUTH_SCOPE_MISMATCH`; that does not mean the add failed.

Fix: POST /baas/v1/project/<project-id>/cors-domain body `{"domain":"<host>","cors":true,"iframe":true}` where host is the app host for `<dc>`, never a hard-coded data centre. The same POST on an existing domain returns 409 and PUT /cors-domain returns `401 OAUTH_SCOPE_MISMATCH`, so an entry created `iframe:false` is fixed in the console. Read back with MCP CatalystbyZoho_List_All_CORS_Domains. OPTIONS must return Access-Control-Allow-Origin.

Recipe: POST /cors-domain with the token headers. Success is the domain in the MCP list and a preflight that echoes the origin.

### CLI `An unexpected error has occurred. Kindly contact Catalyst support`

Rule: `An unexpected error has occurred. Kindly contact Catalyst support` is a wrapper. Read the debug line before changing anything.

Cause: The CLI threw. Two known lines underneath: `TypeError: existingSlates.findIndex is not a function` and `TypeError: Cannot read properties of undefined (reading 'bucket_name')`.

Fix: Re-run the same command with `--verbose` and match the debug line to the rules below. Do not keep clicking past the wrapper.

Recipe: `catalyst <command> --verbose`. Success is a debug line that matches a specific rule, then that rule's fix.

### `TypeError: existingSlates.findIndex is not a function`

Rule: `TypeError: existingSlates.findIndex is not a function` means catalyst.json `slate` is an object. The CLI requires an array.

Cause: A deploy wrote `"slate": {…}` and `catalyst slate:link` called findIndex on it.

Fix: Write `"slate": []` before link. A plain re-run that rewrites catalyst.json as an object crashes again. Resume after the file is an array.

Recipe: `catalyst slate:link` then `catalyst deploy slate`. Success is a link that finishes and an App URL that returns HTTP 200.

### `TypeError: Cannot read properties of undefined (reading 'bucket_name')`

Rule: `TypeError: Cannot read properties of undefined (reading 'bucket_name')` means `catalyst ds:import -ni` was given object_details.bucket_name and then crashed. Nothing was uploaded.

Cause: The non-interactive import dereferenced an empty bucket answer. A follow-up status spawn can also print `unknown option '--nonInteractive'`. Without `-ni` the command waits for a prompt.

Fix: Do not use `catalyst ds:import -ni` for a bucket upload. PUT the CSV to the bucket host and POST /baas/v1/project/<project-id>/bulk/write. A file_id body is the no-bucket alternative.

Recipe: POST /bulk/write and poll until Completed. Success is Completed and the row count. The CLI crash is not a partial load.

### `400` `Please access the Slate service in your project's console before deploying via the CLI.`

Rule: `Please access the Slate service in your project's console before deploying via the CLI.` on the first Slate deploy means the Slate service was never opened in the project's console.

Cause: `catalyst deploy slate` on a fresh imported project where "Start Exploring" for Slate was never clicked. Data Store and Functions deploys do not need it.

Fix: The user opens Slate in the project console once (the CLI token cannot enable it: `401 AUTHENTICATION_FAILURE`), then re-run the deploy. No IaC component pre-enables it.

Recipe: `catalyst deploy slate`. Success is the deploy finishing and GET /slate/v1/project/<project-id>/app/<app>/deployment returning the app_url.

### `HTTP Error: 404, No such app with the given id exists`

Rule: `HTTP Error: 404, No such app with the given id exists` after the CLI has printed an App URL can mean the app is already served and a later lookup failed.

Cause: Slate deploy succeeded and a follow-up call used a stale id.

Fix: Request the App URL. HTTP 200 means deployed. Record the URL. Do not treat the process exit alone as proof of failure.

Recipe: GET the App URL, and GET the Slate deployment for the app. Success is HTTP 200 on the URL. MCP CatalystbyZoho_List_All_Slate_Apps is the list read-back.

### Job pool name rejected

Rule: A job-pool create that rejects the name, with no other error body, is the underscore rule. Pool names are letters and digits only, at most 50 characters.

Cause: The name contained `_`.

Fix: Use a name such as a letter prefix plus digits. type for a function pool is `Function` and capacity is `{memory:"<MB>"}`. Other pool types use capacity `{number:"1-10"}`.

Recipe: MCP CatalystbyZoho_Create_Job_Pool. Success is the name in CatalystbyZoho_List_All_Jobpools.

### `Head_Bucket` reports success for a missing bucket

Rule: CatalystbyZoho_Head_Bucket can return an error body that still says success, including after the bucket was deleted.

Cause: The tool looks up query_params.bucket_name and does not prove existence.

Fix: Read CatalystbyZoho_Get_All_Buckets. Delete with CatalystbyZoho_Delete_Bucket using query_params.bucket_name, not an id, then list again.

Recipe: MCP CatalystbyZoho_Get_All_Buckets. Success is the name present or absent in that list, matching the intended state.

## Creator export and runtime

### Argument count does not match

Rule: `The number of arguments for '<name>' function does not match the number of mandatory params '<n>'.` means a thisapp call's arity does not match the function. Import is rejected. Duplicate then fails with `Something went wrong. Please retry.` Environment publish fails with `Problem occurred during publish. Contact us at support[at]zohocreator.com`.

Cause: A workflow, page, schedule, or report action calls the function with the wrong count. Saving a signature change in the builder only warns. A report action bound to the old arity still exports and then fails re-import.

Fix: c2c analyze blocks until every thisapp call matches the mandatory parameter count, including report custom actions. Fix the call in the source app and export again. Do not emit a hand-written report custom-action block; a grafted block can export HTTP 200 with content-length 0.

Recipe: Re-import the .ds. Success is an import that finishes and a Duplicate that returns 201.

### `Void function` used in an expression

Rule: `Void function '<name>' cannot be used in expression` means a void function's result was used as a value.

Cause: An assignment or other expression calls a void function. Changing an already-used function to void can save silently and only fail later on Duplicate (`Something went wrong. Please retry.`).

Fix: c2c analyze blocks any non-bare thisapp call of a void function. Return a value or call the function as a statement.

Recipe: Re-import. Success is a clean import. A Duplicate 405 after a silent save is this rule until the call sites match.

### Argument data type does not match

Rule: `Data type of argument at index '<n>' of the function '<name>' did not match the required data type of '<TYPE>'.` means the call's argument type does not match. The index is 1-based and the type name is upper case.

Cause: The .ds call passes a different Deluge type than the parameter. The builder may still save a parameter-type edit. Runtime submit can succeed anyway. Duplicate then returns `Something went wrong. Please retry.`

Fix: c2c analyze blocks the mismatch using literal types, input field types, and variables assigned from literals.

Recipe: Re-import after the call or the parameter type is aligned. Success is a clean import.

### `'success message' can be used only in on success actions`

Rule: `'success message' can be used only in on success actions` means the statement sits in On Validate, a function, a button, or a custom action.

Cause: success message is legal in On Success. In On Load it imports and does nothing.

Fix: c2c analyze blocks it outside On Success. In On Load, warn that it does not display. Use alert or info on validate, load, and click. Move a real success message to On Success.

Recipe: Re-import. Success is a clean import, and an On Load form that does not depend on success message.

### Sendmail from address

Rule: `The "from" address can only be zoho.adminuserid, zoho.loginuserid, or a verified email address. Please specify a valid email address and try again.` means a literal from address is not allowed in the target account.

Cause: sendmail `from :` is a literal that is not zoho.adminuserid, zoho.loginuserid, zoho.adminuser, or an address verified in the target account. A variable from address skips this check.

Fix: c2c analyze blocks a literal from that is not one of those three ids. Repair with `from : zoho.adminuserid` and reply-to set to the original address. Flag a variable sender for the user to check. Do not copy a source-account address into the target and assume it is accepted.

Recipe: Re-import the .ds. Success is a clean import. A variable from still needs the user's check because import will not reject it.

### `DS IMPORT :: DS FILE LIMIT EXCEEDED`

Rule: `DS IMPORT :: DS FILE LIMIT EXCEEDED :: Size :: 16MB` means Creator will not import this file.

Cause: The .ds is over 16 MB.

Fix: c2c can still read a larger file locally. Creator itself will not take it back. Split or trim before a round-trip import. Do not promise a re-import.

Recipe: The import call returns this string. Success for a round trip is a file at or under 16 MB that imports cleanly. Local plan and deploy do not require that import.

### `UPLOAD_RULE_NOT_CONFIGURED`

Rule: `UPLOAD_RULE_NOT_CONFIGURED` and code 2945 mean a file or connection call lacked its scope or rule. A Creator message `{"code":2945}` on an upload is this family. Keep ids as strings so a wide integer is not rounded into a different id.

Cause: The request used a file upload without the rule, or a connection without the scope. Cross-app `zoho.creator` calls with the wrong scope return `2945` and `invalid oauthscope`.

Fix: Move file bytes as files the user downloads, and store the Catalyst object key as a string. For a connection, add the scope and enable per-app connection access. Never parse a 17-digit or 19-digit id as a number.

Recipe: Re-run the upload or the integration call after the scope is present. Success is a stored object key or a response code 3000, not 2945.

### `3100` `No Data Available`

Rule: `{"code":3100,"message":"No Data Available"}` from zoho.creator.updateRecord, getRecordById, or deleteRecord means the id is outside the report's criteria. The task does not throw. The form can still say the data was added.

Cause: The call targeted a criteria-filtered report. Code 3000 and `Data Updated Successfully` is the success shape. Missing per-app access saves with `Connection '<name>' access is disabled for this application`. Omitting the connection argument is an arity error (7 mandatory parameters).

Fix: c2c analyze warns when the target report has criteria. Generated code must check response code 3000. Use an unfiltered report when the intent is to update any row.

Recipe: Call updateRecord and read the code. Success is code 3000. Code 3100 stops the workflow step and reports the report name.

### `Improper Statement` inside insert into

Rule: `Improper Statement` and `Error might be due to missing ';' at end of the line or incomplete expression` on an insert-into line mean a comment sits inside the bracket block. Import can instead say `A problem encountered while creating the application. Please contact support[at]zohocreator.com, along with the application .ds file.`

Cause: `//` or `/* */` inside `insert into Form [ … ]`. The doubled legacy `(input.Sub.Field).input.Sub.Field.getall()` fails the same way.

Fix: c2c analyze strips or hoists comments inside those brackets. Replace the doubled getall with `input.Sub.Field.getall()`. `List((input.Sub.Field).getall())` is valid.

Recipe: Re-import. Success is a clean import. Save in the builder must not report Improper Statement on that line.

### Criteria left expression is not supported

Rule: `<multiselect_lookup/subform>.<multiselect_value> is not supported in left expression of criteria` means a criteria walks a multi-select lookup or a subform into a multi-value field.

Cause: A report filter, lookup values criteria, fetch, aggregate, or permission uses that left operand. `type = multiselect` is not a .ds field type; the field type is `checkboxes`. The bad type imports with `An error has occurred. Please contact support[at]zohocreator.com for assistance.`

Fix: c2c analyze blocks the left expression on every criteria surface. Prefetch ids and use `in`, or filter a single lookup. Emit `checkboxes`, never `multiselect`.

Recipe: Re-import. Success is a clean import and a report filter that uses the prefetched id list.

### Column does not belong to the view

Rule: `Column '<display name>' does not belongs to '<view>' view` means a report column `view =` points at a report of a different form than the lookup target.

Cause: The view is a two-hop report. The error names the display name and uses the wording "does not belongs".

Fix: c2c analyze requires the view's form to be the lookup's target form. Drop `view =` or retarget it.

Recipe: Re-import. Success is a clean import with no such column error.

### Report has no Web section mapping

Rule: `The component '<name>' does not have section mapping for Web version.` means a report is missing its web menu entry.

Cause: The .ds has the report and no `web > menu` mapping. A workflow link-named `Type` fails import with `An error has occurred. Please contact support[at]zohocreator.com for assistance.` and no line number. Fields and reports named Type are fine. The builder renames a workflow Type to `Type_workflow`.

Fix: c2c analyze blocks a workflow link name Type and appends `_workflow`. Emit a web menu entry for every report.

Recipe: Re-import. Success is a clean import, including an environment publish of that app.

### `Invalid entries found`

Rule: `Invalid entries found` and `Rectify and submit again.` on edit, with `Enter a valid phone number`, mean a stored phone value is not a phone. Insert accepted it. `Enter a valid email address for <field>` is raised on insert. `Due to invalid expressions insert statement is terminated` is the email-insert failure.

Cause: Deluge insert into enforced email and did not enforce phone or a mandatory image or file. The bad phone then blocks every later edit.

Fix: Before insert, require phone values to look like `+<country code><number>`, require mandatory file fields, and require email format. Scan rows that already hold a bad phone and clear or correct them before an edit migration.

Recipe: POST the row only after those checks. Success is a later edit that saves. A modal with Invalid entries found means fix the stored phone first.

### Pivot report is an Analytics object

Rule: An export or import that fails on a pivot report means the app contains an Analytics pivot.

Cause: Pivots are Analytics objects, not Data Store reports.

Fix: Leave pivots out of the migration. Remove them from the export you ask Creator to re-import. Do not create a Catalyst table for a pivot.

Recipe: Re-export without the pivot. Success is an import that no longer fails on the pivot. C2C does not migrate Analytics pivots or create a Catalyst table for them; it continues with the supported app data.

### Creator `You have reached your API call limit`

Rule: `You have reached your API call limit` with HTTP 429 from Creator means the Creator API budget is exhausted. Assume a Catalyst function is limited to about one Creator call per minute.

Cause: A function called Creator. The same call from another client can still succeed.

Fix: Do not call Creator from a Catalyst function on a request path. Export CSV on your own machine and load with /row or bulk write. A queued sync sleeps and honours Retry-After.

Recipe: The 429 body is the signal to stop. Success is a load that uses only Catalyst Data Store calls.

### Workflow corrupted on export

Rule: An export that fails on a corrupted workflow, or a blank export, usually means a workflow's function binding is stale.

Cause: The function signature changed and a workflow, including a report action, still points at the old binding.

Fix: Re-bind or remove the call in the source app, then export again. c2c analyze flags the arity mismatch before deploy. Do not deploy from a zero-byte export.

Recipe: Export again after the re-bind. Success is a non-empty .ds that imports cleanly.

### Initial values skipped on API insert

Rule: A REST or import insert that omits a field stores null even when the column has an initial value. The initial value is applied by the form path when the field is absent there, not by a raw row insert that sends the key as empty.

Cause: The loader sent the column as empty or the handler omitted the default.

Fix: Apply the initial value in the handler when the incoming field is absent. Migrated rows keep their explicit CSV values and do not get the initial value pasted over them.

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row without the optional key, then SELECT. Success is the initial value present for an app insert, and the CSV value present for a migrated row.

### Opaque `500 {"dryRun":true,"error":"request failed"}`

Rule: `500 {"dryRun":true,"error":"request failed"}` on a live call means the handler hid the store error. Duplicates, missing fields, and bad dates look the same. Logs that contain only an execution-started line do not identify it.

Cause: The handler mapped 400, 403, and 409 to one 500 and set dryRun true on a confirmed deploy.

Fix: Return the store status and the column name. Log the error code and column, not secrets. Repeat the same row with POST /row using the admin token to see `409 DUPLICATE_VALUE`, `403 MANDATORY_MISSING`, or `400 INVALID_INPUT`.

Recipe: POST /row with the admin token for the same body. Success for the app is a response whose status matches that store status, with dryRun absent on a confirmed deploy.

### Report route answers `405` on GET

Rule: HTTP 405 on GET /reports/<report> means the generated report route is POST only.

Cause: A smoke call used GET.

Fix: POST the report route. Keep GET for health checks that are actually GET.

Recipe: POST the report path with the signed-in session. Success is HTTP 200 and the report body, not 405.

### Lookup options empty or raw ROWIDs

Rule: A lookup select with zero options, or a report cell that shows a raw ROWID, means the lookup display route is missing or the display field was not resolved.

Cause: The client asked a route that was not deployed, or it printed the foreign key instead of the parent display column.

Fix: Deploy a lookup read that returns the display field, and render that field in the report. The stored column remains the parent ROWID.

Recipe: GET or POST the lookup route, then open the report. Success is a non-empty option list and a report cell equal to the parent display value.
