---
name: c2c-provision-and-deploy
description: "Create the Catalyst infrastructure and deploy the code for a migrated Creator app with c2c: one project per app (console or IaC import), the IaC project template, MCP-first gap filling (job pool, Stratus bucket, table permissions, auth config reads) through an agent-executed step protocol, CLI deploy of functions, API Gateway and Slate, env vars without loss, and plan → apply → read-back verify. Use for 'provision', 'deploy', 'catalyst deploy', 'create project', 'IaC', 'iac:import', 'job pool', 'bucket', 'c2c provision', '--function-env', 'OAUTH_SCOPE_MISMATCH'."
metadata:
  version: "0.2.0"
---

# Provision and deploy

Requires a **green doctor** for this DC/org/project (the CLI refuses with exit 5 otherwise). Load `catalyst-basics` (projects, CLI), `catalyst-functions` and `catalyst-slate` for platform details, and `references/route-map.md` for the route of every resource.

## Principles

- **Plan → apply → read back → record.** Nothing is "done" until its read-back matches.
- **List → match → create-missing.** Never delete, rename or alter existing resources. Update mode is create-missing only.
- **MCP only where the CLI token cannot act** (job pool, bucket, permissions/scopes, auth-config and role/CORS reads, API Gateway routes, mail config). CLI for tables, columns, FKs, crons, jobs, auth enable, CORS add, users, functions, Slate. Console for project create, custom roles, Signals, Connections, NoSQL, security rules (until templated), production.
- **Every write needs the user's yes.** Batch the yes per phase ("create these 4 resources?"), not per HTTP call, but never across phases.
- **Rule — default settings only.** Never drive a browser or console and never change permission rules (C2C.md rule 13). Console steps are guided asks the user performs — exact path, what to click — verified by the step's read-back, and collected into the one provision checklist.
- **One credential, one refresher (C2C.md rule 14).** Serialize the `catalyst` calls — no parallel provision/deploy runs and no keep-fresh loop beside a run; on a read-only `401 INVALID_TOKEN` re-read the stored token rather than forcing a refresh.
- **Customer steps.** Everything else is automated; the user takes only these, in order — list exactly these when you hand over:
  1. Slate start: in the Catalyst console open the project → Slate → Start Exploring
  2. Accept invite: accept the app invite mail
  3. Sign in once: sign in to the deployed app once
  4. Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)
  5. Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)
- **Teardown boundary (C2C.md rule 15). A failed step never deletes the project. Teardown happens only on the user's explicit request or on a failure before the Slate "Start Exploring" step; once any human or console step has run, the project is kept — stop and report.

## Step 1 — The project (guided, the user)

- **Greenfield (preferred for a new app):** `c2c plan` without a project id places the `import` step first because that step creates the project. Start with `c2c provision --out c2c-out/<app> --next`; it must emit `import` even when no project id exists. Run it only with a resolved target org and data centre. The import request, deploy-confirm request, and each status read all carry `CATALYST-ORG: <org-id>`; a missing org is refused before any Catalyst request. A duplicate name is scoped to that org; the CLI reports the org queried and the next name (for example, `-2`) before retrying. IaC import creates a **new** project and cannot target production [DOC]. One import provisions the whole declared graph — tables, columns, per-role table permissions and scopes, custom roles (each `dependsOn` the base role it clones), the function security rule and the function — and it is create-only: a duplicate name answers `409`, it never updates.
- **Update mode:** the project already holds only this app's tables (doctor D-F3).
- Read back: `c2c provision --out c2c-out/<app> --record project` (or `--record import`) — c2c lists the org's projects through the Catalyst CLI itself → id and name. Never call `CatalystbyZoho_List_All_Projects` or `CatalystbyZoho_Get_Project_By_Id`: they return project secrets (jwtSecret, clientSecret) into the transcript. Record only the target project's id and name — the `GET /baas/v1/project` listing carries other projects' authentication secrets; never store the raw listing. Write the id into `c2c-deploy.json` `apps.<link>.project`. Re-run `/c2c:doctor` (the project is now part of the scope).

## Step 2 — Infrastructure (`c2c provision`)

```sh
c2c provision --out c2c-out/<app>                 # dry run: prints provision/plan.json as a table
c2c provision --out c2c-out/<app> --next # emits the next pending step as JSON
```

Each step in `provision/plan.json`:
```json
{ "id": "jobpool", "via": "mcp", "tool": "CatalystbyZoho_Create_Job_Pool",
  "args": { "path_variables": { "project_id": "…" }, "body": { "name": "c2cpool3f2a", "type": "Function", "capacity": { "memory": "256" } } },
  "readBack": { "via": "mcp", "tool": "CatalystbyZoho_List_All_Jobpools", "match": { "name": "c2cpool3f2a" } } }
```

Loop until `--next` prints `{"done": true}`:
1. **`via: cli`** → `c2c provision --confirm --run <id>` (the CLI does the REST call with the customer's CLI session and its own read-back).
2. **`via: mcp`** →
   1. if the read-back already matches (list first), record it as existing: `c2c provision --out c2c-out/<app> --record <id> --result <file>` with the list response;
   2. else `ZohoMCP_getSchema` for the tool (first time in the session), compare with `args`; on a schema mismatch **stop** and report (do not improvise arguments);
   3. call the tool (meta: `ZohoMCP_executeTool`; direct: the tool);
   4. call the read-back tool; save its JSON (redact nothing needed: these are resource names/ids) to `c2c-out/<app>/provision/results/<id>.json`;
   5. `c2c provision --out c2c-out/<app> --record <id> --result c2c-out/<app>/provision/results/<id>.json` → the CLI checks `match`; mismatch = stop.
3. **`via: console`** → show the user the exact console path from the step, wait for "done", then do the step's read-back (CLI or MCP) and record it. If a console item has no read API (e.g. Signals), the step names a behavioural probe; run it only with the user's OK.

Typical step list for an app with schedules, files and auth:

| Order | id | via | Read-back |
|---|---|---|---|
| 1 | tables (all) | cli (diff) | `List_All_Tables`, `List_All_Columns` |
| 2 | table-permissions / scopes per role | mcp `Update_Table_Permissions`, `Update_Table_Scopes` | `Get_Table_Permissions`, `Get_Table_Scopes` |
| 3 | jobpool | mcp `Create_Job_Pool` | `List_All_Jobpools` |
| 4 | bucket | mcp `Create_Bucket` (`c2c-<link>-<h8>`) | `Get_All_Buckets` |
| 5 | auth-hosted, auth-embedded | cli | mcp `Get_Authentication_Configurations` |
| 6 | custom-roles (if any) | console | mcp `List_All_Roles` |
| 7 | mail-sender (if sendmail) | mcp `Create_Email_Configuration` + user code | mail config list → verified |
| 8 | connections (each) | console + consent | cli `GET /connections` + probe after deploy |
| 9 | apig-enable, apig-routes (if Custom APIs) | cli `catalyst apig:enable`, mcp `Configure_API_Gateway_Route` | `List_All_API_route` |

## Step 3 — Code (`c2c deploy`)

```sh
c2c deploy exports/<app>.ds --out c2c-out/<app> --project <id> --org <org>          # plan only
c2c deploy exports/<app>.ds --out c2c-out/<app> --project <id> --org <org> --confirm --function-env ~/.c2c/<app>-function-env.json
```
- `--function-env <file|new>` is required. Keep that file outside the generated tree and repository (for example `~/.c2c/<app>-function-env.json`); never commit it. Derivable values (`PROJECT_ID`, `CATALYST_PROJECT_ID`, `DC`, `CATALYST_DC`, `ENV`, `CATALYST_ENV`, `APP_URL`, `CATALYST_APP_URL`, bucket names, and table IDs) are autofilled by `c2c plan` and `c2c provision` into `<out>/function-env.json`. The user fills third-party connection secrets (if declared connections exist). `deploy` merges current env vars with the `--function-env` file, because `catalyst deploy` **replaces** a function's env vars with the ones in `catalyst-config.json` [TESTED].
- Secret names containing `token`, `secret`, `key`, `password` or `credential` are emitted as empty placeholders in the generated config; after `catalyst deploy`, c2c POSTs their values directly to the function and reads the env back to verify the write. The empty-value placeholder behavior of `catalyst deploy` is [UNVERIFIED]. A malformed or incomplete live env read-back stops before the POST; a failed verification exits non-zero with the console/MCP env tools as fallback. The replace-only API has a small GET-to-POST race window: a concurrent console env edit during that interval can be overwritten.
- Under the hood: `catalyst --org <org> --project <id> deploy --only functions -ni`, then `slate:link` and `catalyst deploy slate` [TESTED]. On a **fresh imported project** the first `catalyst deploy slate` fails `400` `Please access the Slate service in your project's console before deploying via the CLI.` — so `deploy --confirm` probes each first-use gate the app needs (Slate: `GET /slate/v1/project/<id>/app`) before the first write. Closed: it prints one console line (the project → Slate → Start Exploring) and stops; after the user says done, re-run with `--resume` and c2c probes again. No API opens the service (the console's enable action refuses the token with `401 AUTHENTICATION_FAILURE`; no IaC component exists). Data Store and Functions normally answer open with no step. Re-running is safe (redeployed 3× [TESTED]).
- `catalyst.json` `slate` entries take only `name` / `source` / `framework` (+ `template`) — there is no redirect field for Slate (`login_redirect` belongs to Web Client Hosting's `client-package.json`). Post-login landing is set elsewhere: the app's embedded `signIn(elementId, {service_url:<app url>})`, a hosted-login link `…/__catalyst/auth/login?service_url=<app url>`, and the invite `redirect_url` = the Slate URL.
- After the first deploy: `c2c provision` continues with the post-deploy steps: Authorized Domain for the App URL, crons (cli, disabled), Job function checks, P-401.
- **Interrupted?** `c2c deploy … --confirm --resume --out c2c-out/<app>` (skips steps whose bundle bytes are unchanged). A plain re-run without `--resume` regenerates `catalyst.json`.

## Verification (all must pass)

- `c2c provision --status` → every step `done` with a read-back file.
- MCP `List_All_Functions`: `c2c_api` (Advanced I/O, node20) + each Job function; `Get_Function` env keys present (values not shown).
- Slate App URL recorded and returns 200; CORS preflight returns ACAO for it.
- P-401: unauthenticated `POST …/server/c2c_api/forms/<f>/submit` → `401 NO_ACCESS`, run credential-free — `curl -s -o /dev/null -w '%{http_code}' -X POST <function-url>/forms/<f>/submit` prints `401` (a signed-in session passes the gateway, so it cannot prove the rule).
- Sign-in lands on the app root, not the default `/app/` path (404 on Slate) — the embedded `signIn` call passes `{service_url}`; every invite carried `redirect_url` = the Slate URL and went out only after the Slate host existed.
- `c2c-deploy-report.json` written even when a step failed, with `postDeploySteps` and the DC/source.
- **Do not** send the user to click "Start Exploring" unless the gate probe answers closed: Cloud Scale (`GET …/table`), Stratus (`GET …/bucket`), SmartBrowz (the browser-grid list), Slate (`GET /slate/v1/project/<id>/app`). A closed gate is one checklist line; c2c verifies it with the same read (`c2c provision --out c2c-out/<app> --record <gate>-enable`) and never continues past an unverified gate. See `references/facts/projects.md`.

## Limits this phase enforces

Each limit below names its limit id, the c2c behaviour, and [its row](../../references/limits.md).

- [L-PROJECTS](../../references/limits.md#l-projects-projects-per-account): 50 projects per account [DOC](https://docs.catalyst.zoho.com/en/cli/v1/initialize-resources/initialize-new-project/) → refuse; doctor D-F1 fails when no slot — create nothing until the user frees one.
- [L-DEV-USERS](../../references/limits.md#l-dev-users-app-users-in-development): 25 app users in Development [DOC]; a higher effective cap is [UNVERIFIED] → warn.
- [L-TABLE-CREATES](../../references/limits.md#l-table-creates-table-creates-per-org): org-wide table-create quota [TESTED] → warn + retry; on `API_LIMIT_REACHED` stop creates, keep created tables, retry after 30/60/120 min.
- [L-JOB-TIME](../../references/limits.md#l-job-time-job-function): Job functions run 15 min [DOC] → split; generated Jobs chunk with self-resubmit and checkpoint.

## Stop conditions

- doctor not green (exit 5) → `c2c-preflight`.
- A schema mismatch between `ZohoMCP_getSchema` and the planned arguments.
- Any read-back mismatch; any `OAUTH_SCOPE_MISMATCH` on a step planned as `cli` (the route map is wrong for this account: stop and report).
- `An unexpected error has occurred. Kindly contact Catalyst support` from the CLI → run the same command with `--verbose` and look it up in the error index (it can hide the `findIndex` crash [TESTED]).
- Table-step failure (e.g. unique cap) → back to `c2c-schema-and-data`.

## What to ask the user

- Create the project in the console (or run the IaC import and confirm it in the browser).
- Approve each phase: "tables (7), permissions (14), job pool, bucket — create now?".
- Fill third-party connection secrets in `~/.c2c/<app>-function-env.json` — copy the autofilled `<out>/function-env.json` there first (if the end-of-flow checklist requests them; keep secret values out of chat and logs).
- Each console checklist item, then "done?".
