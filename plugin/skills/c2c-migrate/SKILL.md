---
name: c2c-migrate
description: "Router and end-to-end playbook for migrating a Zoho Creator app to Zoho Catalyst with c2c. Use for 'migrate my Creator app', 'Creator to Catalyst', 'convert .ds', 'move Zoho Creator to Catalyst', 'c2c', '/c2c:migrate', Deluge to Node.js migration, or any question about where a migration stands. Loads the sub-skill for each step; always starts with the doctor gate."
metadata:
  version: "0.2.0"
---

# c2c migration playbook (router)

This is the routing layer and the order of work. Do not do a step from memory: load the sub-skill named for that step. Read `C2C.md` (plugin root) once per session; its rules override this file.

## The order (never reorder, never skip)

| # | Step | Load | CLI / tools | Exit criterion (verified, not assumed) |
|---|---|---|---|---|
| 0 | **Doctor gate** | `c2c-preflight` | `c2c doctor` + MCP checks | `c2c-out/.c2c/doctor.json` green for this DC/org/project |
| 1 | Precheck + analyze | `c2c-analyze-and-precheck` | `c2c precheck`, `c2c analyze` | 0 BLOCKING findings, or the user chose to fix them in Creator first |
| 2 | Plan (offline) | `c2c-schema-and-data`, `c2c-logic`, `c2c-ui`, `c2c-auth-and-access`, `c2c-integrations` as the plan touches them | `c2c plan` | Plan reviewed by the user; budgets pass; TODO list accepted |
| 3 | Provision (infra) | `c2c-provision-and-deploy` | `c2c provision` + MCP tools + guided console steps | Every item `done` with a read-back |
| 4 | Deploy (code) | `c2c-provision-and-deploy` | `c2c deploy --confirm --function-env …` | Functions + Slate live; App URL recorded; 401 probe passes |
| 5 | Auth + access | `c2c-auth-and-access` | CLI + MCP + guided | Auth config, authorized domain, roles/permissions, first admin read back |
| 6 | Data | `c2c-schema-and-data` | `c2c migrate-data --source-csv <data-dir> --ds <app.ds> --project <id> --org <org> --confirm` | Per-table counts equal Creator's `counts.json`; FK resolution 100% |
| 7 | Verify | `c2c-verify-and-cutover` | `c2c cutover-checklist`, `c2c proof`, `c2c smoke` | Proof reviewed; smoke and required manual checklist items pass |
| 8 | Cutover (optional, user-driven) | `c2c-verify-and-cutover` | console promotion, performed by the user | Post-promotion checks pass; Creator frozen; links switched |
| any | Something failed | `c2c-troubleshooting` | — | Root cause named from the error index, fix applied, step re-run with `--resume` |

## Session start

1. Ask once (if not already in `c2c-deploy.json`): the Creator app (path to `.ds`), the Catalyst **data centre**, the Catalyst **org id**, and the **project** for this app. Confirm all three back to the user in one line. Never guess them (C2C.md rule 7).
2. Run step 0. If doctor is red:
   - give the user the exact fixes it printed, grouped by who does what;
   - you may still run steps 1–2 (offline) if the user wants, and say clearly "doctor is red: this is a preview, nothing will be created";
   - refuse anything past `plan` while doctor is red: stop before step 3.
3. Run `c2c status --project <project-id> --org <org-id>` to inspect project health. Read `c2c-out/<app>/state/*.json` to see where an earlier run stopped; never start a finished step again without `--resume`.

## Decision rules

- **One app = one project.** If the target project holds tables not in this app's plan (doctor D-F3), stop and ask the user to create a new project `c2c-<app-link>` in the console. Never merge apps.
- **Development only.** Production is promoted by the user in the console at cutover.
- **Greenfield vs update:** empty project → greenfield (IaC template import is an option; see `c2c-provision-and-deploy`). Project already holds this app's tables → update mode (create-missing only, never drop or alter).
- **Data before or after auth?** Deploy and auth come before data, so the app can be signed into and smoke-tested on an empty store first. Large data loads (> 200k rows or > Dev caps) wait until probes P-RATE/P-BULK pass.
- **When a step needs the console:** tell the user the exact path (from `references/route-map.md`), wait for "done", then run the read-back. Never mark a guided step done without its read-back.
- **When something is unverified:** say "unverified: needs a probe" and ask before proposing an empirical check. The CLI probe command is not available yet.
- **Rule — default settings only:** the user runs c2c with default host settings and no browser automation — never drive a browser or console, never change permission rules, never use a pre-made or supplied evidence file. Every fact comes from CLI/API/MCP calls made live in the current session; what no call can do is a guided ask (exact console path, what to click, how it is read back), collected into one batched checklist (C2C.md rule 13).
- **One credential, one refresher (C2C.md rule 14):** serialize every `catalyst`/`c2c` call — no parallel runs and no keep-fresh loop beside a run; a second refresher on the same login rotates the refresh token out from under both. On a read-only `401 INVALID_TOKEN`, re-read the stored token rather than forcing a refresh.
- **Teardown boundary (C2C.md rule 15):** a failed step never means deleting the project to retry — teardown happens only on the user's explicit request, or on a failure before the first human or console step. Anything that has taken a human or console step is kept; stop, report, resume with `--resume`.

## What to ask the user (and when)

| When | Ask |
|---|---|
| Start | Path to the `.ds`; DC; org id; project id (or "create a new project named c2c-<link> in the console") |
| After analyze | "These N blockers come from Creator. Fix them in Creator and re-export, or continue with them as TODOs?" |
| After plan | "Review `c2c-out/<app>/plan.md`. Approve the plan?" plus every unique-field decision the budget forces |
| Before each `--confirm` and each MCP write | "Run <step> on project <name> (<id>) in <dc>/Development? (yes/no)" |
| Console steps | "Please do <exact clicks>. Tell me when done." |
| Env values | "Fill `~/.c2c/<app>-function-env.json` (opened for you); I will not read or print the values." |
| Before cutover | "Freeze Creator writes now?" and "Have you clicked Deploy to Production?" |

## Stop conditions (fail closed)

Stop, report, and do not continue when:
- doctor is red, stale (> 12 h) or names a different DC/org/project (exit 5);
- `precheck` exits 1 and the user has not accepted the blockers;
- a plan budget fails (columns, unique varchar, joins, projects);
- any read-back after a create does not match;
- any Catalyst error that the error index marks "stop";
- counts after a data step differ from `counts.json`;
- the user did not say yes.

## Sub-skill index

| Skill | Load when |
|---|---|
| `c2c-preflight` | Session start; any context change (DC/org/project); `PERMISSION_NEEDED`; MCP disconnect |
| `c2c-analyze-and-precheck` | A new or re-exported `.ds`; questions about readiness or "will this convert" |
| `c2c-schema-and-data` | Tables, columns, limits budgets, IDs, files, data load |
| `c2c-logic` | Deluge, workflows, functions, schedules, approvals, blueprints |
| `c2c-ui` | Forms, reports, pages, Slate |
| `c2c-auth-and-access` | Login, portals, roles, permissions, users |
| `c2c-integrations` | Connections, zoho.* tasks, invokeurl, Custom APIs, sendmail, PDF |
| `c2c-provision-and-deploy` | Creating infrastructure, deploying code |
| `c2c-verify-and-cutover` | Probes, parity, smoke, export diff, go-live, rollback |
| `c2c-troubleshooting` | Any error string |

The Catalyst skills (`catalyst-*`) remain the source for platform facts; load them from the sub-skills when they say so.
