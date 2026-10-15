---
name: c2c-verify-and-cutover
description: "Prove a migrated Creator app works on Catalyst and go live with c2c: empirical limit probes (P-LIKE, P-OFFSET, P-JOIN, P-WIDTH, P-COLS, P-401, P-BULK, P-MAIL), smoke tests, given/when/then parity cases, IaC export diff, record counts, Dev to Production promotion and post-promotion checks, Creator freeze and delta sync, and rollback. Use for 'verify', 'is it working', 'smoke', 'parity', 'probe', 'go live', 'cutover', 'deploy to production', 'rollback', 'undo'."
metadata:
  version: "0.2.0"
---

# Verify, cut over, roll back

Requires a green doctor. Every probe and every cutover action needs the user's explicit yes.

**Rule — default settings only (C2C.md rule 13).** No browser automation, no permission-rule changes, no pre-made or supplied evidence. This offline checklist command proves only facts computable from the local `.ds`, export, state and smoke report inputs; a supplied smoke report is labelled as supplied evidence and is never described as independently observed. Everything requiring a live project, account or console is an explicit human check with exact steps and a requested record of the result. Do not mark an item passed when its evidence is absent.

**One credential, one refresher (C2C.md rule 14).** Serialize the `catalyst` calls (exports, Production deploys) — no parallel runs and no keep-fresh loop beside a run; on a read-only `401 INVALID_TOKEN` re-read the stored token rather than forcing a refresh.

## Part A — Verify (Development)

### A1. Probes (Rule: verify limits empirically)

There is no `c2c probe` CLI command yet. The probe rows below describe checks that need a future implementation; do not present them as runnable CLI operations.

| Probe | Measures | Why |
|---|---|---|
| P-LIKE | `LIKE '*x*'` returns rows; `'%x%'` returns 0 | Every `contains` criterion [TESTED] |
| P-OFFSET | ZCQL offset base | Paging [TESTED] |
| P-UPD300 | ZCQL UPDATE/DELETE statement cap | Silent partial writes |
| P-JOIN | max JOINs (Dev, and Prod at cutover) | Raises are per environment [UNVERIFIED] |
| P-WIDTH | max SELECT columns + error text | 20 [DOC]; not yet confirmed |
| P-COLS | columns per table by type on a scratch table | 100 [DOC] default; raised cap 250 [UNVERIFIED] |
| P-401 | private route without a session → `401 NO_ACCESS`; run credential-free — `curl -s -o /dev/null -w '%{http_code}' <function-url>` prints `401` | Functions are public/`optional` by default [TESTED]; a signed-in session passes the gateway, so only a no-session probe proves the rule (`is_authenticated` is the only readable signal) |
| P-BULK | bulk write with `fk_mapping` from a CSV in the bucket | Before any bulk load |
| P-RATE | sustained writes/min on a scratch table | ~100/min/table [UNVERIFIED] |
| P-SVC | Job Scheduling / Stratus usable on a fresh project with no "Start Exploring" | [UNVERIFIED] |
| P-MAIL | one send from the verified sender to the user's own address | Sends real mail: explicit OK only |

Run the probes the plan needs (it lists them), not all of them.

### A2. Smoke

`c2c smoke <ds> --project <id> --org <org> --confirm` — no browser automation, no token or cookie. It prints one step and exits 4: the user opens `<app url>#/admin/smoke` in their own browser, signed in to the app once (the deploy report's `slate.appUrl` names the page), waits until the page says Done or Failed, presses **Copy** beside the result code (a `c2cs1…` token under "Paste this into your AI chat (Claude or any LLM)") and pastes it into this chat. **Ask the user for that code**, then run `c2c smoke <ds> --result-code <code>` (or pipe it to `--result-code -`) — it unpacks the whole `c2c-smoke/1` block and verifies it: this app's origin and project, this source's smoke plan, freshness, every step passed — and writes the smoke report; a failed, foreign, stale or edited block exits 1 with the refused reasons, and a mistyped or cut-short code is refused by its check characters (ask the user to press Copy again). A user on the CLI may instead save the block to `smoke-result.txt` and run `c2c smoke <ds> --result smoke-result.txt`; it is the same check.

Customer steps (in order) — tell the user exactly these, nothing else:

1. Slate start: in the Catalyst console open the project → Slate → Start Exploring
2. Accept invite: accept the app invite mail
3. Sign in once: sign in to the deployed app once
4. Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)
5. Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)
 Check the sign-in path too: before sign-in the app shows a clear signed-out state, and the framed sign-in page renders the login form — if it serves the app shell, the service worker is answering `/accounts/`, `/__catalyst/`, `/baas/`, `/server/` or cross-origin navigations it must bypass. After sign-in the user must land on the app root — a landing on `/app/` (404) means the `signIn` call is missing `{service_url}` (Slate has no redirect field in `catalyst.json`).

### A3. Parity

The parity runner (planned) executes the app's given/when/then cases against the deployed app. Until it ships: pick 3–5 business rules with the user (a required field, a unique field, an initial value, a workflow side effect, an approval transition), state them as given/when/then, run them through the UI with the user, and verify in the store. Known traps: a duplicate is enforced by the store (`409 DUPLICATE_VALUE`) but can surface as `500 request failed` [TESTED].

### A4. Structure and data

- `c2c proof <app> --out c2c-out/<app>` writes a proof report from available source facts, counts, checksums and smoke results. The automated Catalyst IaC export diff is not implemented yet.
- Counts per table equal `counts.json`; FK resolution 100%; file objects counted.

**Green = required checks are recorded, smoke (or the manual smoke) passes, parity cases pass, the proof is reviewed, and counts equal.** Summarise the evidence for the user, including the per-app maintenance list (what they now own: N Deluge functions as Node code, M connections, …).

## Part B — Cutover checklist (the user drives; offline c2c records local evidence)

Run `c2c cutover-checklist <app.ds> [--source-json|--source-csv|--source-backup <export>] [--since <state>] [--smoke <report>] --out <dir>` while offline. The generated `cutover-checklist.md` has an evidence ledger and exact actions; `c2c-proof.json` and `c2c-proof.md` name the local facts it can establish. The command does not connect to Creator or Catalyst and cannot verify that a human performed a freeze, promotion, sign-in, DNS change or link update. Treat those rows as open until the requested evidence is recorded. Never infer a live success from a checkbox or from readiness percentage.

The automated smoke sequence is the `c2c smoke` check above — the CLI verifies origin, project, plan, freshness and step results with no browser. The customer's human steps are exactly five, in order: (1) in Catalyst, open the project → Slate → Start Exploring; (2) accept the app invite email; (3) sign in to the deployed app once; (4) open `<app-url>#/admin/smoke`, wait for Done, press Copy and paste the result code into the AI chat; and (5) confirm the Catalyst Mail sender only when the app sends mail. Separately, the [human cutover checklist](#human-actions-after-the-offline-checklist) lists the remaining human actions it requires (freeze, promotion, post-promotion checks, link switch and sign-off). Anything else that would require browser automation is a P1 bug: fix the plugin via CLI/MCP/skills or stop and report it. Never silently turn an unverified check into a passing item.

1. **Rollback baseline and freeze:** before freezing, the user runs `c2c rollback-export --ds <app.ds> --out <rollback-dir> --project <id> --confirm`, keeps the output outside the workspace, then restricts Creator writes and records the freeze time. Record command output, path and time in the checklist evidence ledger.
2. **Final delta:** the user exports every Creator report with record IDs after the freeze. Run the generated `sync-delta` plan, review it, apply only with explicit approval and `--confirm`, then plan again. Record export folder/time, plan and apply results, and zero-new/zero-changed read-back in the evidence ledger.
3. **Smoke:** run the documented `c2c smoke ... --confirm --report <file>` flow. If it requires the user to complete the in-app action, give the exact URL and ask them to paste the generated result code; do not automate the browser. Preserve the report path and result. Test each form by submitting a test record and confirming that record appears in its report; do not clean up data without explicit approval.
4. **Sign-in and role checks:** the user checks each configured role and one user per role, records landing URL and page visibility, and does not share credentials. The checklist gives the app URL and role names available from the local app.
5. **Redirect, DNS and integrations:** the user opens the app URL and Creator home page, checks each custom domain and certificate if used, and updates links/integrations. Record observed destinations, locations updated and one representative successful integration response. Mark an optional custom domain “not used” with that exact evidence.
6. **Rollback readiness and sign-off:** the user confirms the baseline files are intact and, if post-cutover writes occurred, makes a second rollback export. The owner reviews the proof, closes every manual item or records an exception, and records name/date/approval.

### Human actions after the offline checklist

The following Catalyst-side actions cannot be verified offline; the generated checklist must keep them open until the user records the result:

1. **Rehearse** the full data volume outside Development if the app is large (Dev row cap [UNVERIFIED]); record environment, approximate row counts and result.
2. **Production promotion is a console action by the user:** Catalyst console → Deploy to Production (a payment method is required). c2c cannot do it: no CLI/API for functions or schema [TESTED]. The CLI does have `catalyst deploy slate --production` and `ds:import --production` [CLI] for later updates. From the checklist, record project and completion time; do not claim the offline CLI verified promotion.
3. **Post-promotion verify** (human checks; there is no offline `c2c cutover` command):
   - `catalyst iac:export --production` diff against the template;
   - every function deployed; crons and the job pool present (pre-defined crons migrate with the deployment [TESTED]; Stratus/Job Scheduling/Signals promotion: [UNVERIFIED]);
   - auth login works in Prod (embedded auth has failed with `invalid_client` only in Prod [UNVERIFIED]); re-configure social logins; record the new ZAID;
   - bucket names: a promotion can fail with `Bucket already exists` [UNVERIFIED] (global names);
   - P-JOIN and P-COLS **in Prod** (raises do not carry over [UNVERIFIED]).
4. **Pre-cutover rollback baseline:** take the pre-cutover baseline (`c2c rollback-export --ds <app.ds> --out <dir> --confirm`) and keep the export outside the workspace. `c2c cutover-checklist` automatically verifies the `c2c-rollback-manifest.json` (`c2c-rollback-export/1`) the exporter writes — every table, every file checksum — and confirms the export lives outside the workspace, ticking both items automatically.
5. **Freeze** Creator writes (the user: make forms read-only or announce a window). Announcing the window and stopping Creator data entry remain human items in the end-of-flow checklist. Then delta sync: records with `Modified_Time ≥ watermark` from fresh JSON report exports (the JSON export always carries record IDs; a CSV carries them only when the export includes the `ID` column — without one, delta sync sees edits as delete+insert) → `c2c migrate-data --confirm` (upsert by `c2c_source_id`).
6. **Invite real users** (Prod allows 1,000 by default [UNVERIFIED]; request a higher limit from Zoho early) — each invite carries `redirect_url` = the Slate app URL; without it the invitee lands on the unhosted `/app/` path (404).
7. **Switch links** (the user): bookmarks, embedded links, integrations pointing at Creator.
8. Keep Creator read-only (not deleted) until the user signs off.

## Part C — Rollback

c2c never deletes projects, tables, rows or buckets on its own. Teardown happens only on the user's explicit request, or on a failure before the Slate "Start Exploring" step — a project that has taken a human or console step is kept (C2C.md rule 15). There is no `c2c rollback` CLI command. `c2c rollback-export` exports Data Store rows for Creator report import; it is not an automated rollback plan.

| Situation | Rollback |
|---|---|
| Bad code deploy (Dev) | Redeploy the previous c2c output: `c2c deploy … --confirm` from the previous `c2c-out` commit, or Slate: MCP `Rollback_Build` / `Redeploy_a_deployment` with the user's yes |
| Bad data load | Rows carry `c2c_source_id`; the plan lists a ZCQL delete per table in batches (DELETE stops at 300 rows: loop until 0); the user approves each table. Or the user truncates in the console |
| Wrong infra (greenfield) | No in-place undo. The user deletes the project in the console and re-imports/re-creates it; c2c re-runs provision and data (one project per app keeps the blast radius small) |
| Cutover problem | Unfreeze Creator, switch links back. Creator remained the system of record until sign-off |
| Production | Console only; the user decides |

## Stop conditions

- Any measured result that contradicts the plan's assumption → re-plan before cutover.
- Smoke/parity failures on business rules the user marked critical.
- Verify exit 1.
- Post-promotion check failure → do not freeze Creator.

## What to ask the user

- Which probes to run (they create and delete scratch resources).
- To sign in and do the manual smoke steps; to define 3–5 parity rules.
- Before cutover: rollback-export baseline outside the workspace (verified automatically by cutover-checklist), freeze window, Deploy to Production done, real-user invite list.
- For any rollback: explicit approval per destructive step, which they perform.
