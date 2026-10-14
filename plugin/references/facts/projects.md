# Catalyst projects, environments, IaC and Slate hosting — rules

Operating rules for project lifecycle, environments, project template import/export and Slate hosting. `<dc>`, `<org-id>`, `<project-id>`, `<import-id>` and `<url>` are placeholders resolved from `c2c-deploy.json` and the CLI context — never hard-code them.

## Admin API envelope

### Share one request envelope for every admin call

Rule: every Catalyst admin REST call goes to `https://api.catalyst.<dc>` with headers `Authorization` (`Bearer <token>`), `Accept` (`application/vnd.catalyst.v2+json`), `X-CATALYST-Environment` (`Development` unless the rule says otherwise) and `CATALYST-ORG` (`<org-id>`).

- The token is the zcatalyst-cli login token and its scope set is fixed — there is no scope flag to widen it. A call outside the set answers `401 OAUTH_SCOPE_MISMATCH` on reads and `401 AUTHENTICATION_FAILURE` on admin writes: route that call through the Catalyst MCP tool named in the rule, or through a console step the user performs. Never ask the customer for a different token.
- MCP tools come in two shapes: the meta shape (`ZohoMCP_getSchema` first, then `ZohoMCP_executeTool` with `{ path_variables, headers, body }`) and the direct shape (call the tool with the arguments its schema declares). Send the `Catalyst-org` and `Environment` headers every schema requires.

### One CLI credential, one refresher

Rule: a zcatalyst-cli login credential tolerates exactly one refresher — the refresh token rotates on refresh, so a second process refreshing the same credential breaks it for both (`Error when refreshing the access token`, or a stored token that reads back empty). Serialize CLI use per credential.

- One `catalyst`/`c2c` run at a time against the credential — no parallel runs, and never a background keep-fresh loop beside a run.
- A credential copied to a second machine, profile or checkout is two refreshers on one login: same breakage. Keep a single login per workspace.
- On a read-only `401 INVALID_TOKEN`, re-read the stored token — the other process's refresh may already have renewed it — instead of forcing a refresh. Forcing a local refresh is opt-in (`C2C_ALLOW_LOCAL_REFRESH=1`) and only for a single user who owns the only credential.

## Projects

### Create a project only through the IaC import

Rule: a new project is created by importing a template ZIP — there is no direct create call. Name it `c2c-<app-link>` and always pass a `redirect_url` the user's browser can land on.

1. `POST https://api.catalyst.<dc>/baas/v1/project/import` as multipart form with fields `project_name` (`c2c-<app-link>`), `template_format` (`JSON`), `code` (the template ZIP) and `schedule` (`false`) → returns `import_id` (the `project_id` can be absent until deploy completes).
2. In the user's browser open `GET /baas/v1/project/import/<import-id>/deploy?catalyst_org=<org-id>&redirect_url=<url>` with the same bearer token; the user approves the "New Project Import" console page; the API returns a `success_url` — GET it once so the success page is reached.
3. Poll `GET /baas/v1/project/import/<import-id>` until `status` is `Completed` (`Staged` → `Scheduled` → `Processing` → `Completed`); allow several minutes — project provisioning is lazy.

Error handling:

- Missing `redirect_url` on the deploy step → `400 MISSING_PARAM` ("Mandatory parameter missing"): add the param and retry the GET.
- `POST` or `PUT` to `/deploy` → `400 INVALID_REQUEST_METHOD`: the deploy confirm is GET-only.
- `409 DUPLICATE_ENTRY` ("This project name is already in use"): append a suffix to `project_name` and retry the whole import.
- The project name comes only from the `project_name` form field — a `project_name` key inside the template JSON is ignored.
- Each import consumes a project slot; never import throwaway projects.

### Never call the direct project-create endpoint

Rule: `POST /baas/v1/project` is refused — `400 PROJECT_CREATION_NOT_ALLOWED` regardless of client — and `catalyst init`'s "create a new project" choice opens a browser for the user. Plan creation as the import flow above or a console step the user performs; MCP has no project-create tool either.

### Verify the project before depending on it

Rule: after creation, read the project back and record the id before any resource step.

- `GET /baas/v1/project` lists the org's projects (`id`, `project_name`, `environment_details.env_type`); match by name, never by position. c2c reads it through the Catalyst CLI (`catalyst --org <org> project:list`, or the CLI-token GET) and keeps only id, name and env. Never call MCP `Get_Project_By_Id` / `List_All_Projects`: they return project secrets (jwtSecret, clientSecret) into the transcript.
- CLI: `catalyst project:list --org <org-id>`; `catalyst project:use <project-id>` writes the local project link.
- A project read on an org the CLI user cannot see answers `401`-class errors — stop and have the user fix org membership rather than retrying.

### Record ids, not listings — the project list carries other projects' secrets

Rule: `GET /baas/v1/project` returns more than the target project — the listing carries other projects' authentication secrets. Record only the target project's `id` and `project_name`; never write the raw listing to disk, a log or `c2c-deploy.json`.

- Match projects by `project_name` and `id` together, roles by `role_name`, functions by `name` — listing order and per-project ids are not stable keys.
- A function's `is_authenticated` flag is the only readable signal for its security rule; the rule itself is not readable, so verify it behaviourally (see `functions.md`).

### Apply a template only to a new project — the update path fails all-or-nothing

Rule: never plan "re-import into the existing project."

- `PUT /baas/v1/project/<project-id>/import` — the endpoint `catalyst codelib:install` uses — accepts the ZIP but finishes `Error_Processing` with a console error; the apply is all-or-nothing so nothing is changed.
- Importing a template under an existing name creates another project; `409 DUPLICATE_ENTRY` means pick a new name, not retry the apply.
- Change an existing project through the per-resource routes in `route-map.md` (tables, functions, buckets, pools, roles).

### The import template carries infrastructure, never data or secrets

Rule: ship one ZIP with `project-template-1.0.0.json` at the root (YAML also accepted), `functions/<name>.zip` per function and optional `webclient/<app>.zip` / `catalyst.json` files.

- Items are `{ type, name, properties, dependsOn }` — reference other components by `name` inside `dependsOn`, never by id.
- Emit only the component types the writer supports: `Datastore` (`table`, `column`, `tableScope`, `tablePermission`), `Functions` (`function` of type `basicio`, `applogic`, `event`, `cron`, `job`, `integration`), `Authentication` (`roles`, `SignupConfiguration`, `HostedLogin`, `emailTemplates`), `SecurityRules`, `Stratus` (`bucket`), `SchedulingJobpool`, `SchedulingCron`, `Cache` (`segment`).
- Never emit `Circuits` (unavailable in EU, AU, IN, JP, SA, CA), `EventListeners` or legacy `Cron` (deprecated — hidden for newer accounts), `Filestore` (deprecated), `WebClient` (legacy hosting — use Slate), or `Signals` / `Apigateway` / `Connections` / `Nosql` segments — exports do not produce them, so there is no import schema to emit.
- The template contains no data rows, no app-user list and no live env values from the source project.
- One import provisions the whole declared graph in the new project: tables, columns, per-role table permissions and scopes, custom roles (each `dependsOn` the base role it clones), a function's security rule and the function itself.
- The import is create-only — a duplicate name answers `409` instead of updating the existing component.
- Env-var values and cron headers travel inside the template in clear text — treat the ZIP as secret-bearing (see the export rule).
- Adding a component type means extending the template writer and the `iac-component-types` allowlist together; an unrecognised component must fail validation, never be silently dropped.

### Export is the configuration read-back — treat the ZIP as secret-bearing

Rule: verify a project's configuration by exporting it, then delete the ZIP.

1. `POST /baas/v1/project/<project-id>/export` body `{"template_format":"JSON"}`.
2. Poll `GET /baas/v1/project/<project-id>/export/status` until `Completed`.
3. `GET /baas/v1/project/<project-id>/export/download` → unzip.

- CLI equivalent: `catalyst iac:export` (`--production` for the Production copy), `catalyst iac:status`, `catalyst iac:download`.
- Only the latest export is kept per project, the download link expires in about 15 days, and only one active export runs at a time.
- The ZIP contains env values and cron headers in clear and cannot be redacted server-side (`mask_secrets`, `exclude_sensitive` → `400 INVALID_INPUT`): redact in memory, never log or commit it, and delete the ZIP after the diff.
- Export is also the token-visible route that lists all roles in a project, by `role_name` only — it carries no role ids.

### Delete a project only while Production is disabled

Rule: `DELETE /baas/v1/project/<project-id>` → `200`; while the Production environment is enabled it fails `400 INVALID_OPERATION` ("This project is currently in the production environment. Disable the project's production environment to complete this operation."). Disabling Production is a console step the user performs. Deleted names linger as `Deleted` rows in the import history.

### Tear down only on request, or before the first console step

Rule: c2c tears a project down only when the user explicitly asks, or when a failure struck before the Slate "Start Exploring" step — the first human/console step in the flow. A project that has taken any human or console step is kept: stop, report the state, and let the user decide.

- "Kept" means no delete of the project, its tables, buckets or rows to "start clean" — a failed step resumes with `--resume` or is re-planned.
- Automation built on c2c inherits the same boundary: a later-stage failure never deletes a project that passed the Slate step.

## Environments

### Run the Development→Production flow in the console

Rule: enabling the Production environment, Deploy to Production (a diff-driven promote), pipelines and disabling Production are console steps the user performs — token calls answer `401 AUTHENTICATION_FAILURE` or return a sign-in page.

- Token-side Production routes that do work: `catalyst deploy slate --production`, `catalyst ds:import --production`, `catalyst ds:export --production`, `catalyst iac:export --production`.
- Promotion is the persistent `Deploy to Production` header action; pre-defined crons migrate with it and social logins must be re-entered on the Production side.
- A fresh import always lands in Development — never import into Production.
- The first Production deploy needs a payment method on the account — the user adds it.

See also: https://docs.catalyst.zoho.com/en/deployment-and-billing/environments/using-pipelines/

### Treat Pipelines as an optional console CI — never depend on it

Recipe: the Pipelines console creates a pipeline only against a GitHub, GitLab or BitBucket integration and writes `catalyst-pipelines.yaml` into that repository. There is no pipeline API, CLI verb or MCP tool, and DevOps services (Pipelines, APM, alerts, logs) are opt-in per project — opening one issues `PATCH /baas/v1/project/<project-id>/service` `{"service":"DevOps"}`.

Rule: the plugin never requires Pipelines; deploy and promote through the CLI and console paths. Read build failures through `Get_Logs`/the DevOps console, not a pipeline.

### Send the environment header with intent

Rule: `X-CATALYST-Environment: Production` switches the same base URL to the Production environment: row writes (`POST /baas/v1/project/<project-id>/table/<table-id>/row`) and metadata reads work, but schema writes (`POST …/table`) return `406 INVALID_OPERATION`. Schema and config changes reach Production only through Deploy to Production. Never hard-code the environment — read it from `c2c-deploy.json`.

### Verify after every promotion — promotion is not atomic

Rule: treat Deploy to Production as a checklist the user runs, then re-verify on Production reads.

- After the user promotes: functions are listed and respond; authentication still answers (an `invalid_client` sign-in error means re-enable auth on the Production side); buckets, signals and job links exist; per-project limit raises (JOIN count, column caps, resource-count waivers) do not carry over — the user re-requests them for Production.
- A failed promote can leave partial state — diff a Production IaC export against the Development one before retrying, instead of re-promoting blind.

### Keep the source of record outside Catalyst

Rule: Catalyst does not keep your source. Web Client Hosting downloads serve built artifacts only and Production holds no recoverable source — generated functions, Slate source and `catalyst.json` live in the customer's workspace or repo.

## Quotas and availability

### Budget quotas yourself — there is no limits API

Rule: assume 50 projects per account; table creates are capped org-wide across projects by a limit whose number and window are not published, so `API_LIMIT_REACHED` for table is the signal, not a count. `c2c doctor`/`c2c plan` counts projects via `GET /baas/v1/project` and tables via `List_All_Tables` before creating either, and warns on that refusal rather than near a guessed cap. The plausible quota endpoints answer `404 INVALID_URL_PATTERN` — do not probe for one. Never create burner projects to measure quota.

### Probe service availability per DC — there is no availability API

Rule: never assume a component exists in the customer's DC; `c2c doctor` probes a read per service on the DC in `c2c-deploy.json` before planning (list tables, functions, buckets, job pools).

- Circuits is absent in EU, AU, IN, JP, SA and CA.
- File Store is absent for accounts created after its deprecation cutoff.
- Catalyst has no Singapore DC.

### Console first-use gates are one checklist line plus a read c2c verifies

Rule: no API or CLI command opens a service on a project ("Start Exploring") — the console's enable action answers `401 AUTHENTICATION_FAILURE` to the CLI token, and IaC has no component for it. Each gate is therefore one guided console line, and c2c then runs the gate's documented GET itself. Only an open answer lets provision, deploy or the seed load continue; a closed or unrecognised answer stops before any write and prints the line. A result file never closes a gate.

| Gate | When | Console line | Probe c2c runs | Closed answer | Open answer |
|---|---|---|---|---|---|
| Cloud Scale (Data Store, Authentication) | every app | the project → Cloud Scale → Start Exploring | `GET /baas/v1/project/<project-id>/table` | an "access the … service" refusal or `INVALID_URL_PATTERN` | `200` success envelope |
| Stratus | the app has file fields | the project → Cloud Scale → Stratus → Start Exploring | `GET /baas/v1/project/<project-id>/bucket` | same | `200` (an empty bucket list still opens the gate) |
| SmartBrowz | the app renders PDF | the project → SmartBrowz → Start Exploring | the SmartBrowz browser-grid list | same | `200` |
| Slate | the app ships a Slate client | the project → Slate → Start Exploring | `GET /slate/v1/project/<project-id>/app` | `400` "Please access the Slate service in your project's console before deploying via the CLI." | `200` `{"status":"success","data":[...]}` |

- Provision: `c2c provision --record <gate>-enable` runs the probe; any later `--run` probes every unverified gate before it and stops on a closed one. Deploy `--confirm` and `migrate-data --seed --confirm` probe the gates they need before the first write; re-run (deploy: `--resume`) after the console step.
- Data Store, Functions and Authentication calls usually work on a fresh project before any click, so the Cloud Scale probe normally answers open and no human step is printed.
- An unrecognised probe answer (`401`, `5xx`, a failure envelope without the refusal text) is unverified, never open.
- Project services are opt-in — the first console open of a service (Start Exploring) enables it for the project.

### Treat DevOps (APM, alerts, logs) as opt-in console observability

Recipe: opening DevOps in the console enables it for the project, alongside Cloud Scale, Settings, Signals and Job Scheduling. APM starts from "Enable now" and covers Basic I/O, Job, Event and Advanced I/O invocations; alerts send email whenever a cron or an event listener's execution isn't successful, or for specific logs search results.

Rule: never depend on APM or alerts in generated code or plans — read build failures through `Get_Logs`/the DevOps console, and keep the IaC template's `ApplicationAlerts` component as exported (empty until the user configures alerts in the console).

## Slate hosting

### Link and deploy the Slate app through the CLI only

Rule: Slate has no create/deploy REST or MCP route — `catalyst slate:link` records the app, `catalyst deploy slate` publishes it.

- In `catalyst.json`, `slate` must be an array (`"slate": []` before linking). If the key holds an object, `slate:link` crashes with `TypeError: existingSlates.findIndex is not a function` — fix the JSON and retry.
- `slate:link` writes the build path as an absolute `source` in `catalyst.json` — rewrite it to a relative path before the tree leaves the machine.
- A PWA (service worker + manifest) deploys unchanged.

### Capture the app URL from the deployment API, not from deploy output

Rule: after `catalyst deploy slate`, read `GET /slate/v1/project/<project-id>/app/<app>/deployment` (the CLI token works) → `app_details.app_url`, or MCP `List_All_Slate_Apps` / `Get_Slate_App`.

- Deploy stdout can be discarded, and a trailing `404` "No such app with the given id exists" can follow a live build — treat that combination as success-with-warning: verify the URL serves (`curl -I` on `*.onslate.<dc>`) and record it in `c2c-deploy.json`.

### Serve content-hashed assets — the index document is cached for a year

Rule: `*.onslate.<dc>` serves `/` and `/index.html` with `cache-control: public, max-age=31536000` — effectively immutable for a year.

- Every asset URL must carry a content hash; fetch runtime config and API responses network-first; version the service worker.
- The console Web Cache toggle does not change this header — verify any caching claim with `curl -I <app-url>` on the deployed app, not by toggling.

### Slate custom domains are a manual DNS step

Rule: at most one custom domain per Slate app; the user adds the domain and its DNS record in the console. Plan cutover as "add domain, wait for propagation", never as an API call.
