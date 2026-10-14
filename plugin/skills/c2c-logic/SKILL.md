---
name: c2c-logic
description: "Deluge to Node.js with c2c: form workflows (on load, on validate, on success, on user input), custom functions, thisapp.* calls, schedules and batch workflows to Catalyst Job Scheduling (job pool + crons + Job functions), the 30-second request rule, approvals and blueprints as a persisted state machine, and event dispatch without Signals. Use for 'Deluge', 'workflow', 'custom function', 'schedule', 'cron', 'job pool', 'approval', 'blueprint', 'thisapp', '30 second timeout', 'dryRun true', 'request failed'."
metadata:
  version: "0.2.0"
---

# Logic: Deluge, workflows, schedules, approvals

Load `catalyst-functions` for handler signatures, `catalyst-config.json`, and Job function APIs. This skill adds the migration rules.

**Rule — default settings only (C2C.md rule 13):** no browser automation, no permission-rule changes, no supplied evidence — MCP writes happen only behind the host's own approval; what no call can do is a guided ask the user performs, verified by read-back.

## What c2c generates

| Creator | Catalyst | Status |
|---|---|---|
| Form workflows (submit / edit / delete, on validate, on success) | Routes in one Advanced I/O function `c2c_api` (Node 20, `zcatalyst-sdk-node 3.4.0`, shims vendored) [TESTED] | Deploys [TESTED]; `thisapp.*` calls dispatch in-process |
| On user input / add row | Client-side handlers in the Slate PWA | Runs in the browser; server re-validates |
| Custom functions (`thisapp.<fn>`) | Exported functions in the same bundle, dispatched by name | Generated |
| Schedules (form/date/custom) | **Job functions** + Job Scheduling **crons** in one **job pool** | Definitions generated; automatic bootstrap planned |
| Batch workflows (10–1,000 records) | Job function with checkpointed chunks, self-resubmitting | Planned |
| Work that can exceed ~25 s | HTTP route enqueues a Job, returns 202 + id; client polls | 30 s cap on Advanced I/O and AppSail, not raisable [DOC][TESTED]; Job functions 15 min [DOC] |
| Approvals / blueprints | Persisted state machine (Status + history tables), generated transitions | Generated; SLA timers via dynamic crons are planned. Circuits is not available in every data centre [DOC] |
| Data Store triggers between forms | **In-function dispatch** following Creator's event × source rules | Signals rules are console-only and locked in Prod [DOC][TESTED]: never on the critical path |

## Steps

1. **Read the Deluge section of the plan** (`plan.md` → *Logic*): units translated / shimmed / TODO, schedules, approvals, long-running candidates, `thisapp.*` call graph.
2. **TODOs:** `c2c fill-todos <ds> --emit c2c-out/<app>/todos` writes one task per remaining TODO. You may draft a fill for a task, but it is accepted only through:
   ```sh
   c2c fill-todos <ds> --accept <task-id> <fill-file> --lock c2c-out/<app>/c2c.lock.json
   ```
   which lints and runs the D3 and unit gates. A fill over the byte, statement, or loop cap is refused with the limit name and the measured value; the fill is not shortened, and replay applies the same check. Never hand-edit generated files under `functions/`.
3. **Long-running classification.** For each workflow the plan flags as possibly > 25 s (loops over fetched records, invokeurl chains, sendmail in loops, statement hotspots precheck rule 26), confirm with the user that it becomes an async Job (the UI shows "processing" and polls).
4. **Schedules → Job Scheduling** (live; via `c2c-provision-and-deploy`):
   - **one job pool per project**: MCP `CatalystbyZoho_Create_Job_Pool` (CLI token → 401 `OAUTH_SCOPE_MISMATCH` [TESTED]). Pool name without `_` [TESTED]: `c2cpool` + 4 hex. Read-back `List_All_Jobpools`.
   - Job functions deploy with the code (`catalyst deploy --only functions`).
   - **crons**: CLI token `POST /job_scheduling/cron` works once the pool exists [TESTED]; target type Function must be a **Job** function [DOC][TESTED]. Created disabled, enabled after verify. Read-back MCP `List_All_Crons`.
   - Generated Job code calls `closeWithSuccess()` / `closeWithFailure()` in `finally` (else it shows as a 15-min timeout or "In Progress" for hours [UNVERIFIED]).
5. **Env values** the logic needs (API keys for invokeurl, etc.) go into `c2c-out/<app>/function-env.json`, filled by the user; `c2c deploy --function-env <file>` merges them (deploy otherwise **replaces** the function's env vars).

## Runtime rules the generated code must follow (check them in review)

- **Errors are surfaced, not hidden.** Every handler maps Catalyst errors to Creator-like messages with the right HTTP status and logs a structured line (no secrets, no record values). A handler that returns `500 {"dryRun":true,"error":"request failed"}` for a duplicate (409), a missing field (403) and a bad date (400) alike, and logs nothing, breaks this rule [TESTED]; if you see it, tell the user errors will be generic until the code is regenerated.
- **No `dryRun: true` on a live deploy** (`C2C_DEPLOY_MODE=live` is set on `--confirm` [TESTED]).
- **Blank optional values** are omitted or `null`, never `""` [TESTED].
- **ZCQL:** `LIKE` uses `*` (a `%` pattern silently matches nothing [TESTED]); paging is keyset by ROWID (offsets are 1-based [TESTED]); UPDATE/DELETE loop until the affected count is 0 (300-row silent cap); re-read after any write error.
- **No transactions:** multi-table writes use the compensation journal; parent + children + on-success can half-apply otherwise.
- **Statement-limit semantics:** Creator saves the record and rolls back On Success on its 5,000-statement limit (code 3000). The port neither reproduces nor hides this; it reports the partial result.
- **Concurrency:** bounded fan-out ≤ 10 [UNVERIFIED]; never use a unique column or conditional update as a lock [TESTED].
- **Trigger semantics:** on user input / add row do not fire for API inserts; approval associates before On Success; subform events do not fire for script-inserted rows. The dispatch table encodes this; do not "simplify" it.

## Verification

- `c2c analyze --quality` Q2 (compiles) and Q4 (smoke-clean) pass for the generated code.
- After deploy: `MCP List_All_Functions` shows `c2c_api` (Advanced I/O, node20) and each Job function.
- Each cron: `List_All_Crons` shows it with the right Job function target and schedule, `cron_status` false until verify enables it.
- One manual Job submit per Job function returns SUCCESS (CLI `POST /job_scheduling/job` [TESTED]), with the user's OK.

## Stop conditions

- A TODO in a code path the user marked critical and no accepted fill.
- A schedule with no pool (pool step not read back).
- A cron target that is not a Job function.
- `analyze --quality` Q2 failure.

## What to ask the user

- Which long workflows may become asynchronous.
- Approval of each TODO fill.
- The env values file (they fill it; you never see the values).
- "Create job pool `c2cpoolXXXX` (256 MB) via the Catalyst MCP? (yes/no)" and "Create <n> crons (disabled)? (yes/no)".
