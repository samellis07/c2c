---
name: c2c-troubleshooting
description: "Diagnose any error during a c2c Creator-to-Catalyst migration by exact error string: Catalyst API errors (OAUTH_SCOPE_MISMATCH, MANDATORY_MISSING, INVALID_URL_PATTERN, DUPLICATE_VALUE, INVALID_INPUT, PUBLIC_SIGNUP_ERROR, API_LIMIT_REACHED, 'Reached max number of columns of Unique varchar type'), Catalyst CLI crashes ('An unexpected error has occurred. Kindly contact Catalyst support', findIndex, bucket_name), MCP host errors ('invalid MCP url', PERMISSION_NEEDED), c2c exit codes, and Creator export/publish errors. Use for '/c2c:troubleshoot', 'error', 'failed', 'not working', '401', '403', '404', '500 request failed'."
metadata:
  version: "0.2.0"
---

# Troubleshooting

## Method (never guess)

1. **Get the exact text.** The full error line, the command or tool that produced it, the step id, and the HTTP status. For a CLI crash that says "contact Catalyst support", re-run the same command with `--verbose` (global CLI flag) and read the debug lines; the real error is there (e.g. `TypeError: existingSlates.findIndex is not a function`).
2. **Look it up** in `references/error-index.md` by substring (normalise numbers to `N` and names to `X`). Use the first matching row.
3. **Confirm the cause** with the read-only check the row names (a list call, a probe, a file field) before changing anything.
4. **Apply the fix** the row names. If it is a user action (login, console click, consent), tell the user exactly what to do. If it is a c2c defect, report it to the maintainers via the issue tracker and stop; do not hand-edit generated files.
5. **Resume** the failed step with `--resume` / `c2c provision --next`. Never delete resources to "start clean".
6. **Not in the index?** Say so. Collect the exact text and context, mark the step blocked, and suggest a probe or a report to the maintainers via the issue tracker. Do not declare the feature unsupported (C2C.md rule 9).

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

## CLI credential errors (one credential, one refresher)

`Error when refreshing the access token`, an empty stored token, or a read-only `401 INVALID_TOKEN` means a second process refreshed the same login — the refresh token rotates on refresh (the entry in `references/facts/errors.md`). Have the user stop every other `catalyst`/`c2c` process or keep-fresh loop sharing the credential, re-read the stored token (or `catalyst whoami`, then `catalyst login --dc <dc>` if it still fails), then resume with `--resume`. Never fix it by starting another refresher or by copying the credential to a second profile (C2C.md rule 14).

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
