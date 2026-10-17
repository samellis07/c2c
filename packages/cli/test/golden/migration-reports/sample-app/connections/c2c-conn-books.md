# Migration report: sample-app/connections/c2c-conn-books

App: c2c-conn-books

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
- 1 function

## TODO counts

0

- none

## Field gaps

- multi-line: 2 (Conn_Books_Contact.Books_Response, Conn_Books_Contact.Books_Lookup) — Data Store text holds 10,000 characters. A generated length check rejects the rest. Multi-line formula output (up to 65,355) does not fit.

## Manual steps

- none

## Hidden from end users

0

- none

## Human steps

- Accept invite: accept the app invite mail
- Sign in once: sign in to the deployed app once
- Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)
- Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)
