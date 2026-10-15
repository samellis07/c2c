# Catalyst functions, scheduling and AppSail — rules

Operating rules for function deployment, env vars, execution limits, Job Scheduling, reachability, logging and AppSail. `<dc>`, `<org-id>`, `<project-id>` and `<function-id>` are placeholders resolved from `c2c-deploy.json` and the CLI context.

## Deploying functions

### Deploy function code only through the CLI

Rule: `catalyst deploy --only functions:<name> -ni` is the only route that ships function code — MCP can list, read, update configuration and delete a function but cannot create or deploy one, and the Node SDK has no function-create call.

- Function types: `basicio` (HTTP), `applogic` (Advanced I/O), `event`, `cron`, `job`, `integration`.
- Each function ships a `catalyst-config.json` (`stack`, `type`) plus vendored `node_modules` inside the function directory — pin `zcatalyst-sdk-node` to a fixed version and vendor it; never run `npm install` on the deploy target.
- Read back: MCP `List_All_Functions` / `Get_Function`, or `GET /baas/v1/project/<project-id>/function/<function-id>`.

### Manage env vars as one replace-only set

Rule: every env write replaces the whole set — merge before writing, every time.

- `POST /baas/v1/project/<project-id>/function/<function-id>/configuration` body `{"variables":{...}}` replaces every existing variable.
- `catalyst deploy` replaces env vars with `catalyst-config.json`'s `env_variables` only when that key is present — generate configs without `env_variables` so deploys preserve live values.
- `c2c deploy <ds> --function-env <file>` reads the live set (`GET …/function/<function-id>` → `data.configuration.environment.variables`), merges the user's local file and writes the full set once. The user types the values; they never enter the repo, the plan or the chat.
- MCP tools: `List_All_Env_Variables`, `Create_Env_Variables`, `Update_Environment_Variable`, `Delete_Environment_Variable`.

## Execution limits

### A ~30-second ceiling decides the function type

Rule: a synchronous function must finish in ~25 s; anything longer is a Job function.

- Advanced I/O (`applogic`) executions are killed at ~30 s with `408 EXECUTION_TIME_EXCEEDED`; posting a `timeout` value in the function configuration is ignored and can silently wipe env vars — never post timeout configuration.
- Enforcement lands between 31–38 s for Advanced I/O, Basic I/O and Development AppSail alike (`408 EXECUTION_TIME_EXCEEDED`); design to 30 s, not the tail.
- AppSail shares the ~30 s per-request ceiling.
- Design rule: work that can exceed ~25 s becomes a `job` function submitted and polled asynchronously, or is split into subrequests. Rehearse a 60 s critical path through a Job function before user acceptance — the failure surfaces exactly this way.

### Job functions get 15 minutes and return nothing to the caller

Rule: a `job` function runs up to 15 minutes, has no HTTP response, and must close its context.

- Wrap the handler body in `try/finally` calling `context.closeWithSuccess()` / `context.closeWithFailure()` — a Job or Basic I/O function that never closes sits `In Progress` indefinitely.
- Job dispatch queues under burst load — treat submit as async; never promise near-real-time delivery from it.
- A Job function runs inside the project's single job pool and is driven by Job Scheduling — `POST /baas/v1/project/<project-id>/job_scheduling/job` submits work (`202` + job id), `GET /baas/v1/project/<project-id>/job_scheduling/job/<job-id>` polls to `SUCCESS`/`FAILURE`, and cron targets must be `job` functions. Pool creation is a separate path — `POST …/job_scheduling/jobpool` with the CLI token answers `401 OAUTH_SCOPE_MISMATCH`, so the one pool per project comes from MCP `Create_Job_Pool`, the console, or the greenfield template.
- Exported templates can carry cron ids inside header values — keep them out of shipped files.

### Never emit deprecated function-side components

Rule: Event Listeners and the legacy Cron component are deprecated (hidden for newer accounts) and File Store is deprecated — orchestrate multi-step or timer flows with Job functions plus Job Scheduling, and files with Stratus.

## Runtime assumptions — assume, then check

### Assume ~10 concurrent executions per function in Development

Rule: bursts past a low per-function concurrency cap fail `Concurrency limit reached for the feature COMPONENT`. `c2c plan` caps generated fan-out and pool sizing at ≤ 10 concurrent executions per function; `c2c probe` fires a measured parallel burst before any throughput promise. Data Store behind the function has its own write cap — see `limits.md`.

### Assume 512 MB memory per function — stream, never buffer

Rule: functions run at 512 MB by default (Advanced I/O and Job alike); a per-function raise to 2 GB is a change the customer requests from Zoho, not a config value.

- Stream payloads through Stratus (`getObject` streams) rather than buffering in the handler.
- Function compute bills in GB·s — a larger box also bills more per second, so the raise is the customer's call.

### Functions are stateless — sandboxes die within minutes

Rule: there is no self-serve "always warm" flag; an idle sandbox is reclaimed after ~2 minutes.

- Keep state in Cache, Data Store or Stratus — never in module scope or `/tmp`.
- AppSail scales to zero after ~5 idle minutes; the next request pays a cold start. Keeping it warm is a cost decision the customer makes.

## Calling Catalyst services from a function

### Generate PDFs in the function with convertToPdf; templates are console-designed

Recipe: `smartbrowz().convertToPdf(html, {pdf_options:{format:"A4"}})` inside a deployed function returns a `%PDF-1.4` byte stream (≈5 s first call) from inline HTML or a source URL.

Rule: render print output as HTML and convert in the function. `generateFromTemplate(<id>)` answers `404 INVALID_ID` for any id not designed in the console — there is no CLI or API template create, so never generate template ids.

### Call Zia text, OCR and object APIs from a function — no console setup

Recipe: `zia().getKeywordExtraction`, `getSentimentAnalysis`, `extractOpticalCharacters`, `detectObject` and `scanBarcode` work from a deployed function with no console step. Expect partial reads — one OCR call returned the first of two lines — and an empty `content` when a barcode is absent.

Rule: use Zia calls for assistive fields only; never gate a migration step on OCR completeness.

### Push notifications reach only authenticated app users

Recipe: the console's Web push tab sends test pushes to an end-user email and offers `catalyst.notification.enableNotification()` in the Web SDK — no VAPID key or certificate upload for web; Android/iOS need FCM/APNs setup in the same console.

Rule: generate the Web-SDK enable call on pages that need push, and never promise push to signed-out users — end users must be authenticated on the app.

## Reachability and security

### Set per-function auth through Security Rules — re-check when API Gateway is on

Rule: per-function authentication (`required`/`optional`) is declared in the template's `SecurityRules` component or the console — the CLI has no command or import path for it, and `catalyst deploy` leaves a function `optional` unless the rule came in through the IaC import.

- `SecurityRules` items carry the function target, `authentication` and `http_trigger`; project-wide alternatives belong to API Gateway.
- Enabling API Gateway (`catalyst apig:enable`, `catalyst-user-rules.json` via `catalyst deploy`, or MCP `Configure_API_Gateway_Route` with `List_All_API_route`/`Get_API_route` for reads) turns Security Rules off — auth then lives in generated middleware inside each function.
- API Gateway routes do not appear in IaC exports — keep them in the generated `catalyst-user-rules.json`.
- The function read exposes `is_authenticated` as the only signal — the rule itself is not readable, so verify behaviourally.
- After any deploy, an unauthenticated request to a `required` function's URL must return `401 NO_ACCESS`; if it serves data, the security rule is wrong — fix before continuing. Run the check credential-free — `curl -s -o /dev/null -w '%{http_code}' <function-url>` prints `401`: a session already signed in is accepted by the gateway, so only a request carrying no session proves the rule.

### AppSail is public by default — generate auth middleware

Rule: an AppSail app without auth middleware is reachable by anyone; `app-config.json` keys `catalyst_auth` (boolean) and `login_redirect` forward sign-in to Catalyst auth — after deploy, an anonymous GET must return `401` or a redirect before those keys are relied on.

- Deploy: `catalyst appsail:add`, then `catalyst deploy --only appsail:<name>` (respecting each app's `app-config.json`). Both work with the token; the URL `https://<name>-<zaid>.development.catalystappsail.<dc>` is publicly reachable at once.
- Budget ~30 s per request and ~100 simultaneous requests; at scale the bottleneck moves to Data Store — size reads accordingly.

### Outbound HTTPS from a function is unrestricted

Recipe: `fetch` to arbitrary external hosts answers normally; the only ceiling is the function's own ~30 s budget — a slow upstream is cut with the function, not by an egress proxy.

Rule: bound outbound calls with the caller's own timeout below the function limit.

### Never generate Circuits flows in EU, AU, IN, JP, SA or CA

Rule: Circuits is unavailable in those data centres (invocation → `403`); express orchestration inside a Job or Advanced I/O function instead of emitting a circuit — see `projects.md` for the per-DC probing rule.

### Set the org id in code before QuickML calls

Rule: `X_ZOHO_CATALYST_ORG_ID` is a reserved env var — deploy refuses it inside `environment_variables` ("must not contain reserved keywords"); inside the generated function set `process.env.X_ZOHO_CATALYST_ORG_ID = '<org-id>'` before `quickML()` calls or they fail `ORGID_HEADER_UNAVAILABLE` / `X-ZOHO-CATALYST-ORGID HEADER IS MISSING`. Set it at runtime, never in config.

### The Node SDK cannot create infrastructure

Rule: `zcatalyst-sdk-node` covers rows, tables, bucket objects, jobs and reads, but has no create calls for job pools, buckets, roles, connections, NoSQL or Signals — those go through the REST routes or MCP tools named in each area's rules.

### Log structured errors; read logs through MCP Get_Logs

Rule: generated handlers log errors with context (never secrets or record values); a handler that logs nothing shows only `info "Execution started at: …"` in the logs — swallowed server failures stay invisible there and surface only as `500 {"dryRun":true,"error":"request failed"}`.

- MCP `Get_Logs` filters by resource, function, severity and date with pagination — plan log checks by filter, not by scrolling.
- The console's DevOps → Logs → Application page filters by Log Type (Access/Application), Resources, Date/Time zone and Keyword, with a Configure Alert action — "Log messages for the last 5 mins may not be indexed", so log every failure inside the handler instead of relying on a later read.
- Retention is short (about 7 days in Development, 14 in Production) and entries truncate around 1500 chars — log early, concise and once per failure.

## Deluge client alerts

Rule: `alert(message)` is allowed in form workflows for Subform on add row and Subform on delete row events, across Created, Created-or-Edited, and Edited record states. Do not treat those events as unverified; the Creator alert reference lists them as supported: https://www.zoho.com/deluge/help/client-functions/alert.html
