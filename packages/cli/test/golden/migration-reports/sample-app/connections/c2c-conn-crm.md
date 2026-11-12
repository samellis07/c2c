# Migration report: sample-app/connections/c2c-conn-crm

App: c2c-conn-crm

## Scope

- Payments — not supported in this version (counted)
- Offline — not supported in this version (counted)
- Form Email — not supported in this version (counted)
- C8 dialect — not supported in this version (counted)
- Cliq bots — not supported in this version (counted)
- Native mobile / MDM — not supported in this version (counted; on the roadmap)
- Marketplace publishing — not applicable (out of scope)
- Zia AI builder — not applicable (out of scope)
- On-prem Data Bridge — not applicable (out of scope)

## Converted inventory

- 3 forms
- 3 reports
- 1 function
- The generated Catalyst app carries 3 Data Store tables, 1 Catalyst function, 0 scheduled jobs, 6 pages
- Deluge: 3 statements translated, 16 kept working through a compatibility shim, of 19

## TODO counts

0

- none

## Field gaps

- email: 2 (Conn_Crm_Lead.Lead_Email, Conn_Crm_Touch.Touch_Email) — There is no email column (API type email returns PATTERN_NOT_MATCHED). Stored as varchar plus a generated format check. Creator’s exact rule is unpublished, so the check can differ on edge cases.
- multi-line: 2 (Conn_Crm_Lead.Crm_Response, Conn_Crm_Touch.Touch_Response) — Data Store text holds 10,000 characters. A generated length check rejects the rest. Multi-line formula output (up to 65,355) does not fit.

## Manual steps

- none

## Residual TODO steps

- none

## Hidden from end users

0

- none

## Human steps

- Accept invite: accept the app invite mail
- Sign in once: sign in to the deployed app once
- Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)
- console: cloudscale-enable — Catalyst console → the project → Cloud Scale → Start Exploring (<console>/baas/<org>/project/<project>/Development#/cloudscale) — then c2c verifies it: c2c provision --record cloudscale-enable (GET /baas/v1/project/<project>/table)
- console: connections — Catalyst console → Connections: connect zoho.crm.* (the user consents to each OAuth flow)

## Not converted

Silent drops: 0 (still counted; each has a guided step below)

- none
