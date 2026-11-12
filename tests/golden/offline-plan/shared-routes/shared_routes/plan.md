# c2c plan for Shared_Routes

dc: in (from --dc)
doctor: not-run (plan is offline; provision and deploy need a green doctor)
budgets: ok

tables: 4 (34 columns)  functions: 0  schedules: 0  reports: 1  pages: 0  roles: 0  custom APIs: 0
mail: none
integrations: none
files: none
project: new — provision/plan.json creates it with one IaC import (provision/iac; a taken name retries as "<name>-2"; the imported c2c_api is the dry-run handler — c2c deploy --confirm installs the live function)

## Budgets (D-F5)

- [PASS] (columns) Catalog: table Catalog: 8/250 columns
- [PASS] (unique-varchar) Catalog: table Catalog: 1/2 unique varchar columns
- [PASS] (fk) Catalog: table Catalog: 0/15 foreign keys
- [PASS] (columns) Activity: table Activity: 6/250 columns
- [PASS] (unique-varchar) Activity: table Activity: 0/2 unique varchar columns
- [PASS] (fk) Activity: table Activity: 0/15 foreign keys
- [PASS] (columns) Order_Sheet__Lines: table Order_Sheet__Lines: 11/250 columns
- [PASS] (unique-varchar) Order_Sheet__Lines: table Order_Sheet__Lines: 0/2 unique varchar columns
- [PASS] (fk) Order_Sheet__Lines: table Order_Sheet__Lines: 1/15 foreign keys
- [PASS] (columns) Order_Sheet: table Order_Sheet: 9/250 columns
- [PASS] (unique-varchar) Order_Sheet: table Order_Sheet: 0/2 unique varchar columns
- [PASS] (fk) Order_Sheet: table Order_Sheet: 0/15 foreign keys
- [PASS] (select-width) Order_Sheet__Lines: widest generated read of Order_Sheet__Lines selects 11 columns per statement (docs 20, unverified limit 30; confirm with P-WIDTH)
- [PASS] (joins) generated reads are single-table (0/4 joins); lookup display needs one fetch per lookup (confirm with P-JOIN)
- [PASS] (org-tables) this app creates 4 Data Store table(s); an org-wide limit on table creates refuses a create with 403 API_LIMIT_REACHED "API Limit for table" — on that refusal stop creates, keep created tables, and retry after 30/60/120 minutes; a project delete may not free capacity at once
- [WARN] (dev-row-cap) the per-table row estimate needs source row counts; Development's per-table row cap is a hidden value (datastore.rows_per_table_dev, the value is not published) — a load refused with 403 API_LIMIT_REACHED "API Limit for row" is the signal → re-run c2c plan with --source-backup, --source-csv or --source-json so the budget lists the largest tables; rehearse a large load on a different environment before cutover
- [WARN] (varchar-length) source string values are unmeasured; a REST insert silently truncates past a varchar column's length (measured ceiling 255) — validate before write; counts are JavaScript code points — whether Catalyst counts emoji, multibyte characters or CRLF line endings the same way is unverified → re-run c2c plan with --source-backup, --source-csv or --source-json so the budget measures source string values against varchar column lengths
- [WARN] (dev-api-calls) the mover's API-call estimate needs source row counts; Development allows 200000 API calls per application (api.calls_dev, docs figure) → re-run c2c plan with --source-backup, --source-csv or --source-json so the estimate counts the mover reads and writes
- [PASS] (dev-write-rate) no source row counts — the dev-api-calls budget carries the missing-source warning; the stated Development write rate is ~100 writes/min/table (datastore.write_requests_per_minute, unverified) → re-run c2c plan with --source-backup, --source-csv or --source-json so both estimates count the mover calls; run c2c probe P-RATE before a large load

## Field behavior gaps (no silent shim)

- decimal: 3 fields (Catalog.Unit_Price, Order_Sheet.Total, Order_Sheet.Price) — Decimal is not a Data Store column type (Text, VarChar, Date, DateTime, Int, Double, Boolean, BigInt, Foreign Key, Encrypted). Stored as a canonical decimal string in varchar 64. Scale is the field decimal places (default 2). Extra fractional digits quantize half-away-from-zero. ZCQL orders the varchar as text.
- subform: 1 field (Order_Sheet.Lines) — The .ds token is grid. Every inline subform (nested fields, no values = Form.Field) becomes its own child table with a parent_id foreign key to the parent ROWID (ON-DELETE-CASCADE) and a row_order Int (0-based Creator row position). A form with several subforms gets one child table per subform; it is not a NoSQL collection. A nested subform inside a subform is not expanded. A grid whose values point at another form is a relation to that form’s table, not a second copy of it.

## Provision steps (provision/plan.json)

- import [cli] c2c provision --confirm --run import → read back c2c provision --record import
- cloudscale-enable [console] Catalyst console → the project → Cloud Scale → Start Exploring (<console>/baas/<org>/project/<project>/Development#/cloudscale) — then c2c verifies it: c2c provision --record cloudscale-enable (GET /baas/v1/project/<project>/table) → read back c2c provision --record cloudscale-enable
- tables [cli] c2c provision --confirm --run tables → read back CatalystbyZoho_List_All_Tables
- import-table-permissions [mcp] CatalystbyZoho_Get_Table_Permissions → read back CatalystbyZoho_Get_Table_Permissions
- import-table-scopes [mcp] CatalystbyZoho_Get_Table_Scopes → read back CatalystbyZoho_Get_Table_Scopes
- authorized-domain [cli] c2c provision --confirm --run authorized-domain (after the Slate deploy, when the App URL host is known) → read back CatalystbyZoho_List_All_CORS_Domains
- sign-in-check [console] Open the Slate app URL — the sign-in box must show the Catalyst sign-in page, not the app itself or a blank box. A blank box means iFrame is off for the host: Authentication > Whitelisting > the Slate host > Edit > iFrame on, then reload. → read back record the check: c2c provision --record sign-in-check --result <file> ({"sign_in_page": true} once the sign-in page shows)
- import-security-rule [mcp] CatalystbyZoho_List_All_Functions → read back CatalystbyZoho_List_All_Functions

## Human steps (after the last provision step; c2c provision prints the same list)

1. Accept invite: accept the app invite mail
2. Sign in once: sign in to the deployed app once
3. Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)

## Required MCP tools (doctor D-B5)

- base (16): CatalystbyZoho_List_All_Organizations, CatalystbyZoho_List_All_Tables, CatalystbyZoho_List_All_Columns, CatalystbyZoho_Execute_Query, CatalystbyZoho_Get_Table_Permissions, CatalystbyZoho_Update_Table_Permissions, CatalystbyZoho_Get_Table_Scopes, CatalystbyZoho_Update_Table_Scopes, CatalystbyZoho_Get_Authentication_Configurations, CatalystbyZoho_List_All_Roles, CatalystbyZoho_List_All_CORS_Domains, CatalystbyZoho_List_All_Project_Users, CatalystbyZoho_List_All_Functions, CatalystbyZoho_List_All_Env_Variables, CatalystbyZoho_List_All_Slate_Apps, CatalystbyZoho_Get_Logs
- plan (0): none beyond base

## Probes (scratch resources prefixed c2c_probe_, deleted afterwards)

- P-LIKE [needed] LIKE '*x*' returns the row; '%x%' returns 0 — every migration verifies it
- P-OFFSET [needed] LIMIT a,b offset base — every migration verifies it
- P-UPD300 [needed] ZCQL UPDATE/DELETE statement cap — every migration verifies it
- P-JOIN [needed] max joins (Development and Production) — every migration verifies it
- P-WIDTH [needed] max select columns + exact error — every migration verifies it
- P-COLS [needed] columns per table by type (scratch table) — every migration verifies it
- P-401 [needed] private route without auth returns 401 — every migration verifies it
- P-BULK [needed] bulk write job path with a Stratus CSV — run before the data load
- P-RATE [needed] write rate before a large load — run before the data load
- P-SVC [skip] enabled services (console first-use on a fresh project) — no Job Scheduling, Stratus or Signals use planned
- P-MAIL [skip] send from the verified sender (customer confirms receipt) — the app sends no mail

