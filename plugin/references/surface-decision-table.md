# Surface decision table

Every operation c2c performs or guides uses one surface: REST with the CLI token, Catalyst CLI, one MCP tool, or a guided console step. `<dc>` comes from config. Never hard-code a data centre. Host for token calls is `https://api.catalyst.<dc>`. Header names are Authorization, Accept, X-CATALYST-Environment, and CATALYST-ORG. Accept is `application/vnd.catalyst.v2+json`. MCP calls add header names Catalyst-org and Environment and path_variables.projectId. Call ZohoMCP_getSchema once before the first use of a tool, then ZohoMCP_executeTool. `c2c plan`, `c2c deploy` without `--confirm`, and `c2c migrate-data` without `--confirm` only write review files.

A name collision on project create returns `409 DUPLICATE_ENTRY`: append a suffix and retry. Import into an existing project is not supported; create a new one.

## Project

### Create a project

Rule: Create a project with the greenfield import. The name comes only from the project_name field. Ask before the deploy GET. Direct POST /baas/v1/project is refused with `400 PROJECT_CREATION_NOT_ALLOWED`.

Surface: REST with the CLI token; Catalyst CLI `catalyst iac:import` is the browser-confirm fallback

Recipe: POST /baas/v1/project/import (multipart: project_name, template_format=JSON, code=<zip of project-template-1.0.0.json>, schedule=false). Then GET /baas/v1/project/import/<import-id>/deploy?catalyst_org=<org-id>&redirect_url=<url> with the same bearer token. Poll GET /baas/v1/project/import/<import-id> until Completed. On `400 MISSING_PARAM`, add redirect_url. On `400 INVALID_REQUEST_METHOD`, use GET for the deploy URL.

Read-back: GET /baas/v1/project (CLI token) lists the project Live, and `catalyst --org <org> project:list` prints the same id. Never MCP CatalystbyZoho_Get_Project_By_Id (it returns project secrets).

### Import a template into an existing project

Rule: Do not apply a template to an existing project. PUT /baas/v1/project/<project-id>/import reaches Error_Processing and `Internal error occurred while importing the project` and changes nothing.

Surface: REST with the CLI token

Recipe: Do not call PUT /baas/v1/project/<project-id>/import. Change the live project with the resource rules below, or create a new project.

Read-back: GET /baas/v1/project/<project-id>/export/download matches the export taken before the refused PUT.

### Delete a project

Rule: Delete with the token only when Production is off. Otherwise the user disables Production in the console first.

Surface: REST with the CLI token

Recipe: DELETE /baas/v1/project/<project-id> with the token headers. On `400 INVALID_OPERATION` naming the production environment, stop and use the disable-Production rule.

Read-back: GET /baas/v1/project no longer lists the id.

### List projects

Rule: Count projects before creating one. Assume the account budget in the limits file.

Surface: Catalyst CLI

Recipe: `catalyst project:list --org <org-id>`. The same list is GET /baas/v1/project with headers Authorization, Accept, and CATALYST-ORG. The GET listing carries other projects' authentication secrets — record only the target project's id and name, never the raw listing.

Read-back: The printed project id and name match `catalyst --org <org> project:list` (c2c provision --record reads it itself). Never MCP CatalystbyZoho_List_All_Projects (it returns project secrets).

### Export a project

Rule: Export is the token path that lists roles. The zip contains environment values and cron header values in clear text. Do not log it or ship it.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/export body `{"template_format":"JSON"}`. Poll GET /baas/v1/project/<project-id>/export/status until Completed. GET /baas/v1/project/<project-id>/export/download. Unknown body keys return `400 INVALID_INPUT`.

Read-back: The unzipped project-template-1.0.0.json lists Authentication.roles. `catalyst iac:export --production` is the Production variant.

### Enable Production

Rule: Enabling Production, computing the diff, migrating, and disabling Production are console steps. The token receives `401 AUTHENTICATION_FAILURE` or an HTML sign-in page.

Surface: guided console step

Recipe: The user enables Production in the console for the project (it is cloned from Development) and waits until the console shows it ready.

Read-back: GET /baas/v1/project/<project-id>/environment returns Development and Production records.

### Migrate a diff to Production

Rule: The user reviews the diff in the console, then migrates. Do not attempt the migration with the CLI token.

Surface: guided console step

Recipe: In the console, the user starts a deployment to Production, waits for the computed diff, reviews it, and confirms the migration.

Read-back: `catalyst iac:export --production` matches the migrated components.

### Disable Production

Rule: Disable Production in the console before a token delete that returned the production-environment error.

Surface: guided console step

Recipe: The user disables Production in the console for the project. The token cannot do this (`401 AUTHENTICATION_FAILURE`).

Read-back: GET /baas/v1/project/<project-id>/environment no longer shows an active Production env, and DELETE /baas/v1/project/<project-id> returns 200.

### Insert rows in Production

Rule: With X-CATALYST-Environment Production, row inserts and reads succeed. Schema creates do not.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row with the Production header. Send at most 200 rows.

Read-back: `SELECT COUNT(ROWID) FROM <table>` via POST /baas/v1/project/<project-id>/query returns the expected count.

### Create schema in Production

Rule: Do not create tables or columns with the Production environment header. The response is `406 INVALID_OPERATION` and `You cannot perform this operation for current environment`.

Surface: REST with the CLI token

Recipe: Create schema in Development. Promote with the migrate rule. Then use the insert-rows-in-Production rule.

Read-back: GET /baas/v1/project/<project-id>/table with the Production header lists the promoted tables and no extra table from a Production POST.

### Skip Start Exploring except for the first Slate deploy

Rule: Do not ask the user to click Start Exploring for Data Store, Functions, or Authentication when the gate probe already answers open — those calls already work. On a fresh imported project the user opens Slate once before the first `catalyst deploy slate`, which otherwise returns `400` `Please access the Slate service in your project's console before deploying via the CLI.`

Surface: guided console step; verified by a REST read c2c runs with the CLI token

Recipe: c2c probes each gate the app needs (Cloud Scale GET /baas/v1/project/<project-id>/table, Stratus GET /baas/v1/project/<project-id>/bucket, SmartBrowz grid list, Slate GET /slate/v1/project/<project-id>/app). Open: continue with no human step. Closed: print one line (console → the project → <service> → Start Exploring), stop before any write, and probe again on the re-run (`c2c provision --record <gate>-enable`, or deploy `--resume`). The console enable has no token equivalent (`401 AUTHENTICATION_FAILURE`) and no IaC component pre-enables it.

Read-back: the gate probe answers `200` with a success envelope; then `catalyst deploy slate` finishes and the App URL serves.

## Data Store

### Create a table

Rule: Create missing tables with the token. Do not drop or rename an existing table. Re-running must create nothing new.

Surface: REST with the CLI token; MCP CatalystbyZoho_Create_Table is only the fallback

Recipe: POST /baas/v1/project/<project-id>/table with the table name. Diff against the current list first.

Read-back: MCP CatalystbyZoho_List_All_Tables and GET /baas/v1/project/<project-id>/table list the same names.

### Create a column

Rule: Add missing columns with a JSON array body. An object body returns `400 JSON_PARSE_ERROR`.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/column with `[{column_name, data_type, …}]`. One request may carry the planned new columns. A unique-varchar refusal rejects the batch; fix the plan and resume.

Read-back: MCP CatalystbyZoho_List_All_Columns matches the plan for that table.

### Create a foreign key

Rule: Create a lookup as a foreign key to the parent ROWID when the table is inside the foreign-key budget. Past that budget, store a plain bigint.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/column with the parent reference and ON DELETE CASCADE or SET NULL, as a JSON array.

Read-back: A ZCQL INNER JOIN on that column via POST /query or MCP CatalystbyZoho_Execute_Query returns HTTP 200.

### Insert rows

Rule: Insert with POST …/row, at most 200 objects, parents before children. Never POST …/rows (`404 INVALID_URL_PATTERN`). Keep ids as strings. Apply HALF_UP and `yyyy-MM-dd` before the call. `c2c_source_id` stays nullable and not unique.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/table/<table-id>/row with a JSON array. Checkpoint the last acknowledged batch. Re-run skips source ids already stored.

Read-back: MCP CatalystbyZoho_Execute_Query `SELECT COUNT(ROWID) FROM <table>` equals the expected count, and a sample of rows matches the CSV.

### Update a row

Rule: Update with PUT on the same row path. A 200 can still store a shortened varchar, a rolled date, or a rounded double. Read the row back.

Surface: REST with the CLI token

Recipe: PUT /baas/v1/project/<project-id>/table/<table-id>/row with the ROWID and the changed fields. Do not use `SET col = col + 1` as a lock.

Read-back: POST /baas/v1/project/<project-id>/query selects that ROWID and the fields match the validated payload.

### Bulk write from Stratus

Rule: For a large CSV, upload the object and start a bulk-write job. Do not use `catalyst ds:import -ni` with object_details.bucket_name; it throws `TypeError: Cannot read properties of undefined (reading 'bucket_name')` and uploads nothing.

Surface: REST with the CLI token

Recipe: PUT `https://<bucket>-development.zohostratus.<dc>/<object-key>` with headers Authorization, CATALYST-ORG, X-CATALYST-Environment, compress `false`, and Content-Type `text/csv`. POST /baas/v1/project/<project-id>/bulk/write body table_identifier, operation, object_details.bucket_name, object_details.object_key, optional find_by, optional fk_mapping. Poll GET /baas/v1/project/<project-id>/bulk/write/<job-id> until Completed.

Read-back: Job status Completed, COUNT(ROWID) matches, and mapped columns hold parent ROWIDs. The error-report CSV is not proof the values were stored unchanged.

### Bulk write from File Store

Rule: When no bucket exists, upload a CSV through File Store and pass file_id. Prefer a bucket declared at project creation when one exists.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/folder body `{"folder_name":"<name>"}`. POST /folder/<folder-id>/file as multipart. POST /baas/v1/project/<project-id>/bulk/write body table_identifier, operation `insert`, file_id.

Read-back: Poll GET /bulk/write/<job-id> until Completed and COUNT(ROWID) matches.

### Upload a Stratus object

Rule: Upload file bytes to an existing bucket with the token. The column stores the object key, not the bytes.

Surface: REST with the CLI token

Recipe: PUT `https://<bucket>-development.zohostratus.<dc>/<object-key>` with headers Authorization, CATALYST-ORG, X-CATALYST-Environment, compress, and Content-Type. MCP CatalystbyZoho_Create_Upload_Signature is the alternative signing call.

Read-back: MCP CatalystbyZoho_Get_All_Objects lists the key. Do not use CatalystbyZoho_Head_Bucket as proof.

### Run ZCQL

Rule: Run ZCQL with the token or with Execute_Query. Use `*` and `?` in LIKE, 1-based LIMIT offsets, at most 300 rows, and at most 4 JOINs. After a write error, SELECT before retry.

Surface: REST with the CLI token; MCP CatalystbyZoho_Execute_Query is the same query

Recipe: POST /baas/v1/project/<project-id>/query body `{"query":"<ZCQL>"}` with the token headers.

Read-back: HTTP 200 and the row array. For a paged read, the next page uses `WHERE ROWID > <last>`.

### Update table permissions

Rule: The token PUT …/permission returns `401 OAUTH_SCOPE_MISMATCH`. Update permissions with MCP. The tool accepts only the role names App Administrator and App User. Custom-role permissions belong in the greenfield template or the console.

Surface: MCP CatalystbyZoho_Update_Table_Permissions

Recipe: Body keyed by those two role names to arrays of SELECT, INSERT, UPDATE, DELETE. The call replaces the previous grants. Call ZohoMCP_getSchema first.

Read-back: MCP CatalystbyZoho_Get_Table_Permissions returns the same grants.

### Update table scopes

Rule: The token PUT …/scopes returns `401 OAUTH_SCOPE_MISMATCH`. Update scopes with MCP, or declare tableScope in the greenfield template.

Surface: MCP CatalystbyZoho_Update_Table_Scopes

Recipe: Call the tool with the scope body from ZohoMCP_getSchema. Do not guess keys.

Read-back: MCP CatalystbyZoho_Get_Table_Scopes matches the body you sent.

## Scheduling and files

### Create a job pool

Rule: POST /job_scheduling/jobpool with the token returns `401 OAUTH_SCOPE_MISMATCH`. Create the one Function pool with MCP or by declaring SchedulingJobpool in the greenfield template. Names are letters and digits, at most 50 characters.

Surface: MCP CatalystbyZoho_Create_Job_Pool

Recipe: Body name, type `Function`, capacity `{memory:"<MB>"}`. Other pool types use capacity `{number:"1-10"}`.

Read-back: MCP CatalystbyZoho_List_All_Jobpools (or Get_Jobpool_By_Id) contains the name. GET /job_scheduling/jobpool with the token also returns 200.

### Create a cron

Rule: After a pool exists, create the cron with the token. The target is a Job function. A legacy cron_function_id body returns `cron_url_details cannot be null`.

Surface: REST with the CLI token

Recipe: POST /job_scheduling/cron body cron_name, cron_type, cron_status, jobpool_id, and job_details for the Job function. Full path is under /baas/v1/project/<project-id>/.

Read-back: MCP CatalystbyZoho_List_All_Crons lists cron_name.

### Submit a job

Rule: Submit a job with the token against an existing pool. Poll until SUCCESS. Chunk work so it finishes inside 15 minutes, and close the job.

Surface: REST with the CLI token

Recipe: POST /job_scheduling/job body jobpool_id and job_details. Poll the job GET until SUCCESS or a failure status.

Read-back: The job status is SUCCESS and the checkpoint row matches the chunk.

### Create a bucket

Rule: POST /bucket with the token returns `401 OAUTH_SCOPE_MISMATCH` even when the token holds bucket scopes. Create the bucket with MCP or declare it in the greenfield template. Names are global.

Surface: MCP CatalystbyZoho_Create_Bucket

Recipe: Body bucket_name and bucket_meta type protected (plus the schema's other required keys). On `Bucket already exists`, append a suffix and retry once.

Read-back: MCP CatalystbyZoho_Get_All_Buckets lists bucket_name. GET /bucket with the token returns 200. Do not use Head_Bucket.

### Deploy functions

Rule: Deploy function code with the CLI. Omit env_variables from the generated catalyst-config.json unless the user's env file was merged into a full replacement set. A deploy that includes env_variables replaces the whole set.

Surface: Catalyst CLI

Recipe: `catalyst deploy --only functions -ni` with `--org <org-id>` and the project id. c2c deploy --confirm runs this after the user fills the env file. Dry-run deploy does not call Catalyst.

Read-back: MCP CatalystbyZoho_List_All_Functions lists the function, and GET /baas/v1/project/<project-id>/function/<function-id> shows the env keys (do not print values).

### Set function environment variables

Rule: POST /function/<function-id>/configuration replaces the entire variable map. A body that omits environment clears it. A deploy that omits env_variables leaves the current map. There is no merge flag.

Surface: REST with the CLI token

Recipe: GET /baas/v1/project/<project-id>/function/<function-id>, merge keys in memory, POST /baas/v1/project/<project-id>/function/<function-id>/configuration body `{"environment":{"variables":{…full map…}}}`. Do not put X_ZOHO_CATALYST_ORG_ID in this map; set it in code before QuickML.

Read-back: GET the function again and compare key names to the merged map.

### Link a Slate app

Rule: catalyst.json `slate` must be an array. An object makes `catalyst slate:link` throw `TypeError: existingSlates.findIndex is not a function`.

Surface: Catalyst CLI

Recipe: Write `"slate": []`, then `catalyst slate:link`. Do not record an absolute machine path as the source.

Read-back: catalyst.json slate is an array and the link command exits 0.

### Deploy a Slate app

Rule: Deploy Slate with the CLI after link. Capture the App URL. A later `HTTP Error: 404, No such app with the given id exists` still leaves a live URL in place when that URL returns 200.

Surface: Catalyst CLI

Recipe: `catalyst deploy slate`. Production static deploy is `catalyst deploy slate --production`. `<dc>` is the config data centre, so the host is `<app>.onslate.<dc>`.

Read-back: The App URL returns HTTP 200, and MCP CatalystbyZoho_List_All_Slate_Apps lists the app. `curl -I` shows `cache-control: public, max-age=31536000` on index.html; hashed asset names are the cache bust.

### Enable API Gateway

Rule: Enable API Gateway with the CLI before creating routes.

Surface: Catalyst CLI

Recipe: `catalyst apig:enable` for the project.

Read-back: MCP CatalystbyZoho_List_All_API_route succeeds (an empty list is a successful enable before routes exist).

### Configure an API Gateway route

Rule: Create each custom-API route with MCP after the gateway is enabled. Do not invent arguments; getSchema first.

Surface: MCP CatalystbyZoho_Configure_API_Gateway_Route

Recipe: Body method, path, and target from the plan, shaped as the schema says.

Read-back: MCP CatalystbyZoho_Get_API_route returns that method and path. One unauthenticated call returns 401 when the security rule is on, or the generated body when it is open.

## Authentication and access

### Enable hosted authentication

Rule: Enable hosted authentication with the token. Leave public_signup false unless the user explicitly wants open signup.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/authentication/enable?auth_type=hosted body `{"public_signup":false}`.

Read-back: MCP CatalystbyZoho_Get_Authentication_Configurations shows hosted_auth true. The token GET of /authentication/configuration returns `401 OAUTH_SCOPE_MISMATCH`; use the MCP read.

### Enable embedded authentication

Rule: Enable embedded authentication with the token after hosted enable.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/authentication/enable?auth_type=embedded body `{}` or `{"public_signup":false}`.

Read-back: MCP CatalystbyZoho_Get_Authentication_Configurations shows embedded auth on.

### Update authentication configuration

Rule: The token PUT of /authentication/configuration returns 401. Change url_preference and the rest with MCP, or in the console under Authentication.

Surface: MCP CatalystbyZoho_Update_Authentication_Configuration

Recipe: Body from ZohoMCP_getSchema. Embedded sign-in does not require a custom url_preference.

Read-back: MCP CatalystbyZoho_Get_Authentication_Configurations shows the field you changed.

### Add a CORS domain

Rule: Authorize the Slate host with the token, with cors and iframe both on at first create — an entry created `iframe:false` cannot be updated with the token (a repeat POST returns `409`, PUT /cors-domain returns `401 OAUTH_SCOPE_MISMATCH`) and is corrected only in the console. The domain is the app host only, using `<dc>` from config.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/cors-domain body `{"domain":"<app>.onslate.<dc>","cors":true,"iframe":true}`.

Read-back: MCP CatalystbyZoho_List_All_CORS_Domains contains the host. OPTIONS preflight returns Access-Control-Allow-Origin. Token GET /cors-domain is `401 OAUTH_SCOPE_MISMATCH`.

### List roles

Rule: The token cannot GET /role (`401 OAUTH_SCOPE_MISMATCH`) or GET /role/<role-id>. Role ids differ per project. Read them with MCP, or from the export zip.

Surface: MCP CatalystbyZoho_List_All_Roles

Recipe: Call the tool with projectId. Do not cache a role id from another project.

Read-back: The tool returns App Administrator and App User, plus any custom role, each with its role id.

### Create a custom role

Rule: POST /baas/v1/project/<project-id>/role with the token returns `401 AUTHENTICATION_FAILURE`. There is no MCP create-role tool.

Surface: guided console step

Recipe: Console path Authentication → User Management → Roles → Add Role: name, description, and the existing role to clone. Or declare Authentication.roles in the greenfield template before import.

Read-back: MCP CatalystbyZoho_List_All_Roles contains role_name.

### Add an app user

Rule: Invite with the admin add path, not signup, while public signup is off. Signup returns `403 PUBLIC_SIGNUP_ERROR`. The invite sends mail; ask first.

Surface: REST with the CLI token; MCP CatalystbyZoho_Add_User is equivalent

Recipe: POST /baas/v1/project/<project-id>/project-user body `{"user_details":{"email_id":"<address>","role_id":"<role-id>"},"platform_type":"web","redirect_url":"<app-url>"}` where app-url is the deployed Slate app URL — omitting it lands the invitee on an unhosted `/app/` path that returns `404`. Use a placeholder address only in examples; the real address is one the user types.

Read-back: GET /baas/v1/project/<project-id>/project-user or MCP CatalystbyZoho_List_All_Project_Users shows the user. is_confirmed becomes true only after the person confirms.

### Delete an app user

Rule: Remove an app user with the token.

Surface: REST with the CLI token

Recipe: DELETE /baas/v1/project/<project-id>/project-user/<user-id>.

Read-back: GET /project-user no longer lists that id.

### Require sign-in on a function

Rule: There is no token, MCP, or CLI call that sets the function security rule — `catalyst deploy` leaves it `optional` unless the rule arrived through the IaC import. Put it in the greenfield SecurityRules, or the user sets it in the console.

Surface: guided console step

Recipe: Console → Functions → the API function → Security Rules → authentication required.

Read-back: An unauthenticated POST to the function URL returns `401 NO_ACCESS`. A signed-in app user receives the handler body. Run the check credential-free — `curl -s -o /dev/null -w '%{http_code}' -X POST <function-url>` prints `401`; the gateway accepts an already signed-in session. The function read exposes `is_authenticated` only; the rule itself is not readable.

## Integrations

### Create an email configuration

Rule: Create the sender only after the user reads the verification code from the mailbox. The code is an argument. Do not call the tool speculatively.

Surface: MCP CatalystbyZoho_Create_Email_Configuration

Recipe: Body email_address, display_name, and code, per ZohoMCP_getSchema. List_All_Emails_Configuration is the only read; there is no get-by-id.

Read-back: MCP CatalystbyZoho_List_All_Emails_Configuration shows the address as verified.

### Send mail

Rule: Send only from a verified domain. A public-domain from_email returns `403 VERIFICATION_NEEDED`. Ask before any real send.

Surface: REST with the CLI token

Recipe: POST /baas/v1/project/<project-id>/email/send multipart fields from_email, to_email, subject, content, html_mode.

Read-back: HTTP 200, and the user confirms receipt when a test was requested.

### Create a connection

Rule: Connection create is a console step. Token POST /connections returns `400 INVALID_REQUEST_METHOD`.

Surface: guided console step

Recipe: Console → Connections → Create → service, scopes, and the link name. The user then authorizes the connection in the console.

Read-back: GET /baas/v1/project/<project-id>/connections shows the link name. connected becomes true after consent. A deployed route that calls getConnectionCredentials returns ok and does not return the credential.

### Read connection status

Rule: Read connection status with the token. Do not try to create on this path.

Surface: REST with the CLI token

Recipe: GET /baas/v1/project/<project-id>/connections with the token headers.

Read-back: HTTP 200 and an array of id, connected, display_name, link_name, and group_name.

### Create a Signals rule

Rule: Token calls to the Signals API return `401 OAUTH_SCOPE_MISMATCH`. Signals is optional and is not on the request path. Creator is not a publisher. A rule fans out to at most 5 targets.

Surface: guided console step

Recipe: In the console, create the publisher, endpoint, target, and rule. The first Production Signals deploy is also a console step.

Read-back: The console lists the rule ACTIVE. There is no token list. In-function dispatch needs no Signals read-back.

### Read logs

Rule: Read function logs with MCP when a handler returns a store error or a 500 that hides it.

Surface: MCP CatalystbyZoho_Get_Logs

Recipe: Call the tool for the function and the time window. Log lines should include the store code and column name, never a secret or an environment value.

Read-back: The log entry cites the same code the direct POST /row returns for that body.

### Call QuickML

Rule: Set the org id in code before QuickML. A missing header returns `ORGID_HEADER_UNAVAILABLE`. Do not put X_ZOHO_CATALYST_ORG_ID in the deploy env file.

Surface: Catalyst CLI

Recipe: The deployed function assigns process.env.X_ZOHO_CATALYST_ORG_ID from `<org-id>` at runtime, then calls quickML. Ship that function with `catalyst deploy`.

Read-back: The call returns a model result. `ORGID_HEADER_UNAVAILABLE` means the assignment did not run.

### Invoke a Circuit

Rule: Do not invoke a Circuit when `<dc>` is EU, AU, IN, or CA. The call returns 403. Use a Job function.

Surface: REST with the CLI token

Recipe: POST /job_scheduling/job for that work. Do not call the Circuit endpoint in those data centres.

Read-back: The job status reaches SUCCESS.

### Generate a template PDF

Rule: Template records are created in the console. The generate call is a token or SDK call. Keep templates free of page-size CSS that the renderer drops, and pass booleans as the strings the renderer accepts.

Surface: guided console step

Recipe: The user creates the template in the console. The function then calls the template PDF endpoint with the record payload.

Read-back: The PDF bytes are stored in Stratus and a sample open shows the expected page count.

### Third-party sign-in

Rule: There is no native SAML or OIDC switch. Enterprise sign-in uses the documented custom-token JWT exchange.

Surface: guided console step

Recipe: In Authentication, configure third-party sign-in and the JWT exchange the Authentication help describes. Re-invite app users for ordinary hosted login when JWT is not required.

Read-back: MCP CatalystbyZoho_Get_Authentication_Configurations shows the third-party block the console saved.

### Do not create a NoSQL table

Rule: POST /nosqltable with the token returns `401 OAUTH_SCOPE_MISMATCH`. There is no MCP create. Map every subform to a child table. Do not skip a form because it has two subforms.

Surface: REST with the CLI token

Recipe: GET /baas/v1/project/<project-id>/nosqltable may return 200 and an empty list. Do not POST. Create the child table with the create-a-table rule.

Read-back: MCP CatalystbyZoho_List_All_Tables contains `<form>__<subform>` and GET /nosqltable does not gain a table from c2c.
