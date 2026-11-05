# Migration report: sample-app/connections/c2c-conn-rest-putdel

App: c2c-conn-rest-putdel

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

- 2 forms
- 2 reports
- The generated Catalyst app carries 2 Data Store tables, 1 Catalyst function, 0 scheduled jobs, 4 pages
- Deluge: 4 statements translated, 14 kept working through a compatibility shim, of 18

## TODO counts

0

- none

## Field gaps

- multi-line: 1 (Conn_Rest_Put_Delete.Rest_Response) — Data Store text holds 10,000 characters. A generated length check rejects the rest. Multi-line formula output (up to 65,355) does not fit.

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

## Not converted

Silent drops: 0 (still counted; each has a guided step below)

- none
