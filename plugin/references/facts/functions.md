# Catalyst functions, scheduling and AppSail — rules

Operating rules for function deployment, env vars, execution limits, Job Scheduling, reachability, logging and AppSail. `<dc>`, `<org-id>`, `<project-id>` and `<function-id>` are placeholders resolved from `c2c-deploy.json` and the CLI context.

## Deploying functions

### Deploy function code only through the CLI

Rule: [UNVERIFIED] `catalyst deploy --only functions:<name> -ni` is the only route that ships function code — MCP can list, read, update configuration and delete a function but cannot create or deploy one, and the Node SDK has no function-create call.

- Function types: `basicio` (HTTP), `applogic` (Advanced I/O), `event`, `cron`, `job`, `integration`.
- Each function ships a `catalyst-config.json` (`stack`, `type`) plus vendored `node_modules` inside the function directory — pin `zcatalyst-sdk-node` to a fixed version and vendor it; never run `npm install` on the deploy target.
- Read back: MCP `List_All_Functions` / `Get_Function`, or `GET /baas/v1/project/<project-id>/function/<function-id>`.

### Manage env vars as one replace-only set

Rule: [UNVERIFIED] every env write replaces the whole set — merge before writing, every time.

- `POST /baas/v1/project/<project-id>/function/<function-id>/configuration` body `{"variables":{...}}` replaces every existing variable.
- `catalyst deploy` replaces env vars with `catalyst-config.json`'s `env_variables` only when that key is present — so the generated `env_variables` must carry every key already live, or the key is erased.
- `c2c deploy <ds> --function-env <file>` writes non-secret values into `env_variables` and secret-named keys (token/secret/key/password/credential, case-insensitive) as name-only `""` entries — generated files are often committed, so no secret value may appear in them. Right after the functions deploy, `c2c deploy exports/<app>.ds --confirm --function-env ~/.c2c/<app>-function-env.json` re-reads the live set (`GET …/function/<function-id>` → `data.configuration.environment.variables`) and POSTs the merged set with the real secret values to `…/function/<function-id>/configuration`, then reads back and compares every key/value. An unknown env shape or missing deployed key refuses the POST. The replace-only API has a GET-to-POST race: a concurrent console edit can be overwritten. The user types the values; they never enter the repo, the plan or the chat.
- MCP tools: `List_All_Env_Variables`, `Create_Env_Variables`, `Update_Environment_Variable`, `Delete_Environment_Variable`.

### Env var aggregate size limit (update only)

Rule: [TESTED] on an **update** deploy (the function already exists), `env_variables` must satisfy `Σ(len(key) + len(value) + 3) ≤ 4096`; over that the deploy fails `HTTP Error: 400, environment_variables value has exceeded its maximum length`. It is NOT a key-count, key-length, value-length or serialized-JSON limit — a 4000-char key and a 4088-char value each pass, 292 keys pass and 293 fail only via the sum. On a **create** deploy the limit is not enforced — an over-limit env is accepted and stored — so an over-limit app deploys once and can never be redeployed. c2c writes each table id once as `TABLE_<NAME>_ID` (never the `TABLE_ID_<NAME>` double) and refuses an env over 4096 before any network call.

## Execution limits

### A ~30-second ceiling decides the function type

Rule: [DOC][TESTED] a synchronous function must finish in ~25 s; anything longer is a Job function
([L-REQUEST-TIME](references/limits.md#l-request-time-advanced-io--appsail-request);
https://docs.catalyst.zoho.com/en/serverless/help/functions/advanced-io/).

- Advanced I/O (`applogic`) executions are killed at ~30 s with `408 EXECUTION_TIME_EXCEEDED`; posting a `timeout` value in the function configuration is ignored and can silently wipe env vars — never post timeout configuration.
- Enforcement lands between 31–38 s for Advanced I/O, Basic I/O and Development AppSail alike (`408 EXECUTION_TIME_EXCEEDED`); design to 30 s, not the tail.
- AppSail shares the ~30 s per-request ceiling.
- Design rule: work that can exceed ~25 s becomes a `job` function submitted and polled asynchronously, or is split into subrequests. Rehearse a 60 s critical path through a Job function before user acceptance — the failure surfaces exactly this way.

### Job functions get 15 minutes and return nothing to the caller

Rule: [DOC] a `job` function runs up to 15 minutes, has no HTTP response, and must close its context
([L-JOB-TIME](references/limits.md#l-job-time-job-function);
https://docs.catalyst.zoho.com/en/serverless/help/functions/job-functions/).

- Wrap the handler body in `try/finally` calling `context.closeWithSuccess()` / `context.closeWithFailure()` — a Job or Basic I/O function that never closes sits `In Progress` indefinitely.
- Job dispatch queues under burst load — treat submit as async; never promise near-real-time delivery from it.
- A Job function runs inside the project's single job pool and is driven by Job Scheduling — `POST /baas/v1/project/<project-id>/job_scheduling/job` submits work (`202` + job id), `GET /baas/v1/project/<project-id>/job_scheduling/job/<job-id>` polls to `SUCCESS`/`FAILURE`, and cron targets must be `job` functions. Pool creation is a separate path — `POST …/job_scheduling/jobpool` with the CLI token answers `401 OAUTH_SCOPE_MISMATCH`, so the one pool per project comes from MCP `Create_Job_Pool`, the console, or the greenfield template.
- Exported templates can carry cron ids inside header values — keep them out of shipped files.

### Never emit deprecated function-side components

Rule: [UNVERIFIED] Event Listeners and the legacy Cron component are deprecated (hidden for newer accounts) and File Store is deprecated — orchestrate multi-step or timer flows with Job functions plus Job Scheduling, and files with Stratus.

## Runtime assumptions — assume, then check

### Assume ~10 concurrent executions per function in Development

Rule: [UNVERIFIED] bursts past a low per-function concurrency cap fail `Concurrency limit reached for the feature COMPONENT`. `c2c plan` caps generated fan-out and pool sizing at ≤ 10 concurrent executions per function; `c2c probe` fires a measured parallel burst before any throughput promise. Data Store behind the function has its own write cap — see `limits.md`.

### Assume 512 MB memory per function — stream, never buffer

Rule: [UNVERIFIED] functions run at 512 MB by default (Advanced I/O and Job alike); a per-function raise to 2 GB is a change the customer requests from Zoho, not a config value.

- Stream payloads through Stratus (`getObject` streams) rather than buffering in the handler.
- Function compute bills in GB·s — a larger box also bills more per second, so the raise is the customer's call.

### Functions are stateless — sandboxes die within minutes

Rule: [UNVERIFIED] there is no self-serve "always warm" flag; an idle sandbox is reclaimed after ~2 minutes.

- Keep state in Cache, Data Store or Stratus — never in module scope or `/tmp`.
- AppSail scales to zero after ~5 idle minutes; the next request pays a cold start. Keeping it warm is a cost decision the customer makes.

## Calling Catalyst services from a function

### Generate PDFs in the function with convertToPdf; templates are console-designed

Recipe: [UNVERIFIED] `smartbrowz().convertToPdf(html, {pdf_options:{format:"A4"}})` inside a deployed function returns a `%PDF-1.4` byte stream (≈5 s first call) from inline HTML or a source URL.

Rule: [UNVERIFIED] render print output as HTML and convert in the function. `generateFromTemplate(<id>)` answers `404 INVALID_ID` for any id not designed in the console — there is no CLI or API template create, so never generate template ids.

### Call Zia text, OCR and object APIs from a function — no console setup

Recipe: [UNVERIFIED] `zia().getKeywordExtraction`, `getSentimentAnalysis`, `extractOpticalCharacters`, `detectObject` and `scanBarcode` work from a deployed function with no console step. Expect partial reads — one OCR call returned the first of two lines — and an empty `content` when a barcode is absent.

Rule: [UNVERIFIED] use Zia calls for assistive fields only; never gate a migration step on OCR completeness.

### The Creator Zia AI app builder is not applicable

Rule: [UNVERIFIED] the Creator Zia AI app builder is not applicable (out of scope). Do not count it as a gap or a TODO, and do not include it in a readiness score. The Zia function APIs above are not that builder.

### Push notifications reach only authenticated app users

Recipe: [UNVERIFIED] the console's Web push tab sends test pushes to an end-user email and offers `catalyst.notification.enableNotification()` in the Web SDK — no VAPID key or certificate upload for web; Android/iOS need FCM/APNs setup in the same console.

Rule: [UNVERIFIED] generate the Web-SDK enable call on pages that need push, and never promise push to signed-out users — end users must be authenticated on the app.

Recipe: [DOC] a function sends web push with `pushNotification.web().sendNotification(message, userList)` — `userList` takes up to 50 user IDs or email addresses per call, admin scope `ZohoCatalyst.notifications.web` (https://docs.catalyst.zoho.com/en/sdk/javascript/v1/cloudscale/push-notifications/send-web-notifications/, https://docs.catalyst.zoho.com/en/cloud-scale/help/push-notifications/). The REST API page for sending web push notifications lists scope `ZohoCatalyst.notifications.web.CUSTOM` (https://docs.catalyst.zoho.com/en/api/code-reference/cloud-scale/push-notifications/web/send-web-push-notifications/). Delivery still needs each recipient's device enrolled through `catalyst.notification.enableNotification()` on the client, so a server-side send with no enrollment path delivers to nobody.

Recipe: [DOC] `catalyst.notification.enableNotification()` belongs to the Web SDK v4, which the docs mark for migration — the register-client page states "Note: This SDK is currently in deprecation. Migrate to JavaScript SDK now." (https://docs.catalyst.zoho.com/en/sdk/web/v4/cloud-scale/push-notifications/register-client/). Prefer the JavaScript SDK successor where it offers the same enrollment call.

## Reachability and security

### Set per-function auth through Security Rules — re-check when API Gateway is on

Rule: [UNVERIFIED] per-function authentication (`required`/`optional`) is declared in the template's `SecurityRules` component or the console — the CLI has no command or import path for it, and `catalyst deploy` leaves a function `optional` unless the rule came in through the IaC import.

- `SecurityRules` items carry the function target, `authentication` and `http_trigger`; project-wide alternatives belong to API Gateway.
- Enabling API Gateway (`catalyst apig:enable`, `catalyst-user-rules.json` via `catalyst deploy`, or MCP `Configure_API_Gateway_Route` with `List_All_API_route`/`Get_API_route` for reads) turns Security Rules off — auth then lives in generated middleware inside each function.
- API Gateway routes do not appear in IaC exports — keep them in the generated `catalyst-user-rules.json`.
- The function read exposes `is_authenticated` as the only signal — the rule itself is not readable, so verify behaviourally.
- After any deploy, an unauthenticated request to a `required` function's URL must return `401 NO_ACCESS`; if it serves data, the security rule is wrong — fix before continuing. Run the check credential-free — `curl -s -o /dev/null -w '%{http_code}' <function-url>` prints `401`: a session already signed in is accepted by the gateway, so only a request carrying no session proves the rule.

### AppSail is public by default — generate auth middleware

Rule: [UNVERIFIED] an AppSail app without auth middleware is reachable by anyone; `app-config.json` keys `catalyst_auth` (boolean) and `login_redirect` forward sign-in to Catalyst auth — after deploy, an anonymous GET must return `401` or a redirect before those keys are relied on.

- Deploy: `catalyst appsail:add`, then `catalyst deploy --only appsail:<name>` (respecting each app's `app-config.json`). Both work with the token; the URL `https://<name>-<zaid>.development.catalystappsail.<dc>` is publicly reachable at once.
- Budget ~30 s per request and ~100 simultaneous requests; at scale the bottleneck moves to Data Store — size reads accordingly.

### Outbound HTTPS from a function is unrestricted

Recipe: [UNVERIFIED] `fetch` to arbitrary external hosts answers normally; the only ceiling is the function's own ~30 s budget — a slow upstream is cut with the function, not by an egress proxy.

Rule: [UNVERIFIED] bound outbound calls with the caller's own timeout below the function limit.

### Never generate Circuits flows in EU, AU, IN, JP, SA or CA

Rule: [UNVERIFIED] Circuits is unavailable in those data centres (invocation → `403`); express orchestration inside a Job or Advanced I/O function instead of emitting a circuit — see `projects.md` for the per-DC probing rule.

### Keep reserved names out of env_variables

Rule: [UNVERIFIED] a deploy whose `env_variables` carried `CATALYST_DC`, `CATALYST_ENV`, `CATALYST_PROJECT_ID`, `DC`, `ENV` and `PROJECT_ID` was refused with `HTTP Error: 400, environment_variables must not contain reserved keywords`, and passed once they were removed. A later redeploy whose env differed from the last accepted one only by `APP_URL` and `CATALYST_APP_URL` hit the same 400; which of the two is reserved is not yet split by a probe. No documented list exists. c2c refuses these names, `X_ZOHO_CATALYST_ORG_ID`, `APP_URL` and `CATALYST_APP_URL`; it assumes no other name is reserved.

### Slate app names are letters, digits and single hyphens

Rule: [UNVERIFIED] `slate:link --name` refuses `_` with `App name must be alphanumeric and cannot contain consecutive hyphens or hyphens at the beginning or end.` No length limit is documented.

### Set the org id in code before QuickML calls

Rule: [UNVERIFIED] `X_ZOHO_CATALYST_ORG_ID` is a reserved env var — deploy refuses it inside `environment_variables` ("must not contain reserved keywords"); inside the generated function set `process.env.X_ZOHO_CATALYST_ORG_ID = '<org-id>'` before `quickML()` calls or they fail `ORGID_HEADER_UNAVAILABLE` / `X-ZOHO-CATALYST-ORGID HEADER IS MISSING`. Set it at runtime, never in config.

### The Node SDK cannot create infrastructure

Rule: [UNVERIFIED] `zcatalyst-sdk-node` covers rows, tables, bucket objects, jobs and reads, but has no create calls for job pools, buckets, roles, connections, NoSQL or Signals — those go through the REST routes or MCP tools named in each area's rules.

### Log structured errors; read logs through MCP Get_Logs

Rule: [UNVERIFIED] generated handlers log errors with context (never secrets or record values); a handler that logs nothing shows only `info "Execution started at: …"` in the logs — swallowed server failures stay invisible there and surface only as `500 {"dryRun":true,"error":"request failed"}`.

- MCP `Get_Logs` filters by resource, function, severity and date with pagination — plan log checks by filter, not by scrolling.
- The console's DevOps → Logs → Application page filters by Log Type (Access/Application), Resources, Date/Time zone and Keyword, with a Configure Alert action — "Log messages for the last 5 mins may not be indexed", so log every failure inside the handler instead of relying on a later read.
- Retention is short (about 7 days in Development, 14 in Production) and entries truncate around 1500 chars — log early, concise and once per failure.

## Deluge client alerts

Rule: [DOC] `alert(message)` is allowed in form workflows for Subform on add row and Subform on delete row events, across Created, Created-or-Edited, and Edited record states. Do not treat those events as unverified; the Creator alert reference lists them as supported: https://www.zoho.com/deluge/help/client-functions/alert.html

### Same-event form workflow ordering and cancellation

Rule: [UNVERIFIED] Creator's export order is assumed to be the execution order when multiple workflows share one form event. Whether a `cancel submit` in one workflow suppresses later workflows is not established by the cited On Success documentation; the generated merged handler stops after cancellation as the safe behavior. Source pointer: [On Success action](https://help.zoho.com/portal/en/kb/creator/developer-guide/workflows/create-and-manage-on-success-action/articles/understand-on-success-action) describes when the event runs but does not specify order among workflows or cancellation propagation.
