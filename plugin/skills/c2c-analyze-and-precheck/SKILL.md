---
name: c2c-analyze-and-precheck
description: "Static analysis of a Zoho Creator .ds export before migration: c2c precheck (every blocker in one pass, with Creator's own error text, including latent faults like function arity/type/void drift and workflow-to-function binding drift) and c2c analyze (readiness score, Deluge coverage, effort). Use for 'is my app ready', 'precheck', 'analyze', 'why does my Creator export fail', 'Something went wrong. Please retry', 'Problem occurred during publish', blank .ds export, or before planning a migration."
metadata:
  version: "0.2.0"
---

# Analyze and precheck

Offline. No account access, no network. Allowed with a red doctor (results are stamped `doctor: red`).

## Why this step matters

Creator lets latent faults into an app and its runtime tolerates them, but whole-app re-generation (Duplicate, Environments publish, `.ds` export/import, backup) rejects them with a generic error that never names the component ("Something went wrong. Please retry.", "Problem occurred during publish"). One bad component can also make the `.ds` export itself blank. c2c starts from that same export, so the precheck must list **every** blocker at once, with Creator's own text and the component.

## Steps

1. **Export sanity.** The `.ds` exists, is non-empty, and parses. A 0-byte file, a blank page or an HTTP-200-empty export is BLOCKING.
   ```sh
   c2c precheck exports/<app>.ds --json > c2c-out/<app>/precheck.json
   ```
   Exit codes: `0` no blockers, `1` blockers, `2` usage, `3` missing file, `4` not a parseable `.ds`.
   - Exit 3/4: stop. Ask the user to re-export (Creator: app → Settings → Export). If Creator's export is blank, the app has a component that breaks export; run precheck on an earlier export if they have one.
2. **Read the findings.** Each has `rule`, `severity` (BLOCKING / WARN / INFO), `component`, `line`, and `creatorText` (the message Creator itself would show). Group them by rule for the user.
3. **Analyze.**
   ```sh
   c2c analyze exports/<app>.ds --json > c2c-out/<app>/analyze.json
   c2c analyze exports/<app>.ds --quality      # adds compile (Q2) and smoke-clean (Q4) checks
   ```
   Report: feature verdicts, Deluge statements (translated / shimmed / todo), estimated tables, functions, pages, score, and **deterministic** flag.
4. **Do not trust the score alone.** A high readiness score does not prove the app can save a record [TESTED]: the score does not see deploy/runtime limits. Always continue to the plan (budgets) before saying "ready".
5. **Present** the result as three lists: *must fix in Creator first* (BLOCKING), *c2c will convert with a TODO* (with the TODO count), *Catalyst limits to decide on in the plan*.

## Latent-fault rules (BLOCKING unless noted)

| Rule | Detects | Creator text the user may have seen |
|---|---|---|
| precheck rule 01 | Function call arity ≠ mandatory params (every `thisapp.<fn>(` call site in workflows, functions, schedules, pages, snippets) | `The number of arguments for 'X' function does not match the number of mandatory params 'N'.`; at runtime `Number of params/datatype mismatch` |
| precheck rule 02 | Argument or criteria operand type mismatch (1-based index) | `Data type of argument at index 'N' of the function 'X' did not match …`; `the left expression is of type NUMBER and the right expression is of type TEXT …` |
| precheck rule 03 | A `void` function used as a value (assignment, operand, argument, condition, return) | `Void function 'X' cannot be used in expression` (and silently empty fields at runtime) |
| precheck rule 04 | Workflow / custom-action → function binding drift: missing function, removed param, bulk action without a form-object argument | An export that fails on a corrupted workflow; a blank export |
| precheck rule 05 | Undefined variables (per script and snippet scope) | `Variable X is not defined` |
| precheck rule 06 | References to deleted forms/fields/views/functions | `Form does not exist - X`, `Not able to find "X" function`, `REFERENCES_FOUND` |
| precheck rule 08 | `success message` outside On Success | `'success message' can be used only in on success actions` |
| precheck rule 09 | sendmail `from` not admin/login user/verified | `The "from" address can only be zoho.adminuserid, zoho.loginuserid, or a verified email address.` |
| precheck rule 11 | Multi-value traversal on the left of a criteria | `… is not supported in left expression of criteria` |
| precheck rule 12 / precheck rule 13 | Duplicate names; reserved words; over-long link names (50 chars) | `… already exists`; `is a reserved keyword for our system field` |
| precheck rule 14 / precheck rule 15 / precheck rule 16 | Deluge syntax re-generation rejects; `.ds` grammar; characters that break XML | `Improper Statement`; an import that fails on the `.ds` grammar; `SAXParseException` |
| precheck rule 17 / precheck rule 18 | Cross-app / unshared dependencies; connection references that do not exist | `function you're trying to use is from an unshared application`; `connection X does not exist` |
| precheck rule 19 / precheck rule 20 | Metadata limits; structural corruption | `You can add only up to four display fields …`; `This application has workflow version mismatches.` |
| precheck rule 21 | Deprecated C4 payment components | An import that fails on payment components (payments are not supported in this version; on the roadmap) |
| precheck rule 22 | Approver field set after approval association (WARN) | `Invalid user name found for Approver field` |
| precheck rule 23 / precheck rule 24 | Same-app REST/invokeurl inside workflows (lock waits); self-triggering workflows (WARN) | `Lock wait timeout exceeded` |
| precheck rule 25 / precheck rule 26 / precheck rule 27 | Quota-consuming patterns; statement-limit hotspots (5,000 per execution); null-guard lint (WARN) | `Number of statement execution limit exceed` |
| precheck rule 28 / precheck rule 29 / precheck rule 30 / precheck rule 31 | Widget/snippet packaging, hard-coded URLs, stateless form inventory, sensitive-label block (WARN) | `Refused to connect …`, `Sensitive label name present in the form` |

precheck rules 01 through 31 are implemented. Not yet implemented: precheck rule 32 subform-in-list-report, precheck rule 33 calendar columns, mixed workflow dialects, `zoho_books` connector name, undefined connection, precheck rule 16 downgrade, Creator-side 0-byte export. Say so when relevant; do not claim the app is clean of those.

## Decision rules

- **BLOCKING latent fault** → the fix belongs in Creator (it breaks Creator's own export/duplicate too). Recommend: fix in Creator, re-export, re-run precheck. c2c never auto-guesses missing arguments (precheck rule 01).
- **The user wants to proceed anyway** → allowed only for rules whose component c2c converts to a TODO (record the user's choice in `c2c-out/<app>/decisions.json`). precheck rules 14, 15, and 16 parse failures cannot be skipped.
- **Dialect:** C5 and C6 are detected heuristically; **C8 is not supported in this version (on the roadmap)**. If analyze reports an unknown dialect, stop and tell the user.
- **Not supported in this version (counted; on the roadmap; never silently drop):** payments, Form Email, offline mode (the PWA replaces native apps, with offline on the roadmap), C8 dialect, and Cliq integration-function bots where Integration Functions are unavailable. Report them as not supported in this version.
- **Out of scope (permanently not applicable):** marketplace publishing, Zia AI builder, and on-prem Data Bridge only. Report them as not applicable (out of scope).
- **Zoho One / org SSO portals** → Catalyst has no native SAML/OIDC; precheck flags it; the fallback is Catalyst hosted/embedded auth plus re-invite or third-party JWT (`c2c-auth-and-access`).
- **Rule — default settings only (C2C.md rule 13).** No browser automation, no permission-rule changes, no supplied evidence — this step is fully offline, and anything it flags that needs a live check becomes a guided ask or a read-back, never a browser drive.

## Verification

- `precheck.json` and `analyze.json` exist, are byte-identical on a second run (`c2c analyze` is deterministic), and carry `deterministic: true|false`.
- The finding count in your summary equals the count in the JSON.

## Stop conditions

- Exit 3/4 (no file / not a `.ds`).
- BLOCKING findings the user has not explicitly accepted.
- Unsupported dialect (C8).

## What to ask the user

- "Here are N blockers Creator itself would reject (list). Fix them in Creator and re-export, or continue with them as TODOs?"
- For SSO-dependent apps: "Your portal uses Zoho One/SSO; Catalyst needs hosted login plus re-invites or a JWT bridge. Which do you want?"
