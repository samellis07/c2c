# c2c plan for Kitchen_Sink_Studio

dc: in (from --dc)
doctor: not-run (plan is offline; provision and deploy need a green doctor)
budgets: ok

tables: 8 (89 columns)  functions: 0  schedules: 1  reports: 7  pages: 1  roles: 4  custom APIs: 0
mail: none
integrations: none
files: 5 Stratus-backed fields
project: new — provision/plan.json creates it with one IaC import (provision/iac; a taken name retries as "<name>-2"; the imported c2c_api is the dry-run handler — c2c deploy --confirm installs the live function)

## Budgets (D-F5)

- [PASS] (columns) Room: table Room: 7/250 columns
- [PASS] (unique-varchar) Room: table Room: 1/2 unique varchar columns
- [PASS] (fk) Room: table Room: 0/15 foreign keys
- [PASS] (columns) Gear: table Gear: 8/250 columns
- [PASS] (unique-varchar) Gear: table Gear: 0/2 unique varchar columns
- [PASS] (fk) Gear: table Gear: 0/15 foreign keys
- [PASS] (columns) Session_Log: table Session_Log: 7/250 columns
- [PASS] (unique-varchar) Session_Log: table Session_Log: 0/2 unique varchar columns
- [PASS] (fk) Session_Log: table Session_Log: 0/15 foreign keys
- [PASS] (columns) Booking__Lines: table Booking__Lines: 9/250 columns
- [PASS] (unique-varchar) Booking__Lines: table Booking__Lines: 0/2 unique varchar columns
- [PASS] (fk) Booking__Lines: table Booking__Lines: 1/15 foreign keys
- [PASS] (columns) Booking: table Booking: 20/250 columns
- [PASS] (unique-varchar) Booking: table Booking: 0/2 unique varchar columns
- [PASS] (fk) Booking: table Booking: 1/15 foreign keys
- [PASS] (columns) Guest: table Guest: 17/250 columns
- [PASS] (unique-varchar) Guest: table Guest: 0/2 unique varchar columns
- [PASS] (fk) Guest: table Guest: 0/15 foreign keys
- [PASS] (columns) Media_Kit: table Media_Kit: 17/250 columns
- [PASS] (unique-varchar) Media_Kit: table Media_Kit: 0/2 unique varchar columns
- [PASS] (fk) Media_Kit: table Media_Kit: 1/15 foreign keys
- [PASS] (columns) Booking__Gear_Refs: table Booking__Gear_Refs: 4/250 columns
- [PASS] (unique-varchar) Booking__Gear_Refs: table Booking__Gear_Refs: 0/2 unique varchar columns
- [PASS] (fk) Booking__Gear_Refs: table Booking__Gear_Refs: 2/15 foreign keys
- [PASS] (select-width) Booking: widest generated read of Booking selects 20 columns per statement (docs 20, unverified limit 30; confirm with P-WIDTH)
- [PASS] (joins) generated reads are single-table (0/4 joins); lookup display needs one fetch per lookup (confirm with P-JOIN)
- [PASS] (org-tables) this app creates 8 Data Store table(s); an org-wide limit on table creates refuses a create with 403 API_LIMIT_REACHED "API Limit for table" — on that refusal stop creates, keep created tables, and retry after 30/60/120 minutes; a project delete may not free capacity at once
- [WARN] (dev-row-cap) the per-table row estimate needs source row counts; Development's per-table row cap is a hidden value (datastore.rows_per_table_dev, the value is not published) — a load refused with 403 API_LIMIT_REACHED "API Limit for row" is the signal → re-run c2c plan with --source-backup, --source-csv or --source-json so the budget lists the largest tables; rehearse a large load on a different environment before cutover
- [WARN] (varchar-length) source string values are unmeasured; a REST insert silently truncates past a varchar column's length (measured ceiling 255) — validate before write; counts are JavaScript code points — whether Catalyst counts emoji, multibyte characters or CRLF line endings the same way is unverified → re-run c2c plan with --source-backup, --source-csv or --source-json so the budget measures source string values against varchar column lengths
- [WARN] (dev-api-calls) the mover's API-call estimate needs source row counts; Development allows 200000 API calls per application (api.calls_dev, docs figure) → re-run c2c plan with --source-backup, --source-csv or --source-json so the estimate counts the mover reads and writes
- [PASS] (dev-write-rate) no source row counts — the dev-api-calls budget carries the missing-source warning; the stated Development write rate is ~100 writes/min/table (datastore.write_requests_per_minute, unverified) → re-run c2c plan with --source-backup, --source-csv or --source-json so both estimates count the mover calls; run c2c probe P-RATE before a large load

## Provision steps (provision/plan.json)

- import [cli] c2c provision --confirm --run import → read back c2c provision --record import
- cloudscale-enable [console] Catalyst console → the project → Cloud Scale → Start Exploring (<console>/baas/<org>/project/<project>/Development#/cloudscale) — then c2c verifies it: c2c provision --record cloudscale-enable (GET /baas/v1/project/<project>/table) → read back c2c provision --record cloudscale-enable
- tables [cli] c2c provision --confirm --run tables → read back CatalystbyZoho_List_All_Tables
- import-table-permissions [mcp] CatalystbyZoho_Get_Table_Permissions → read back CatalystbyZoho_Get_Table_Permissions
- import-table-scopes [mcp] CatalystbyZoho_Get_Table_Scopes → read back CatalystbyZoho_Get_Table_Scopes
- jobpool [mcp] CatalystbyZoho_Create_Job_Pool → read back CatalystbyZoho_List_All_Jobpools
- stratus-enable [console] Catalyst console → the project → Cloud Scale → Stratus → Start Exploring (<console>/baas/<org>/project/<project>/Development#/cloudscale) — then c2c verifies it: c2c provision --record stratus-enable (GET /baas/v1/project/<project>/bucket) → read back c2c provision --record stratus-enable
- bucket [mcp] CatalystbyZoho_Create_Bucket → read back CatalystbyZoho_Get_All_Buckets
- auth-hosted [cli] c2c provision --confirm --run auth-hosted → read back CatalystbyZoho_Get_Authentication_Configurations
- auth-embedded [cli] c2c provision --confirm --run auth-embedded → read back CatalystbyZoho_Get_Authentication_Configurations
- import-roles [mcp] CatalystbyZoho_List_All_Roles → read back CatalystbyZoho_List_All_Roles
- slate-enable [console] Catalyst console → the project → Slate → Start Exploring (<console>/baas/<org>/project/<project>/Development#/slate) — then c2c verifies it: c2c provision --record slate-enable (GET /slate/v1/project/<project>/app) → read back c2c provision --record slate-enable
- authorized-domain [cli] c2c provision --confirm --run authorized-domain (after the Slate deploy, when the App URL host is known) → read back CatalystbyZoho_List_All_CORS_Domains
- sign-in-check [console] Open the Slate app URL — the sign-in box must show the Catalyst sign-in page, not the app itself or a blank box. A blank box means iFrame is off for the host: Authentication > Whitelisting > the Slate host > Edit > iFrame on, then reload. → read back record the check: c2c provision --record sign-in-check --result <file> ({"sign_in_page": true} once the sign-in page shows)
- import-security-rule [mcp] CatalystbyZoho_List_All_Functions → read back CatalystbyZoho_List_All_Functions
- crons [cli] c2c provision --confirm --run crons (crons are created disabled; the user enables each in the console) → read back CatalystbyZoho_List_All_Crons

## Required MCP tools (doctor D-B5)

- base (16): CatalystbyZoho_List_All_Organizations, CatalystbyZoho_List_All_Tables, CatalystbyZoho_List_All_Columns, CatalystbyZoho_Execute_Query, CatalystbyZoho_Get_Table_Permissions, CatalystbyZoho_Update_Table_Permissions, CatalystbyZoho_Get_Table_Scopes, CatalystbyZoho_Update_Table_Scopes, CatalystbyZoho_Get_Authentication_Configurations, CatalystbyZoho_List_All_Roles, CatalystbyZoho_List_All_CORS_Domains, CatalystbyZoho_List_All_Project_Users, CatalystbyZoho_List_All_Functions, CatalystbyZoho_List_All_Env_Variables, CatalystbyZoho_List_All_Slate_Apps, CatalystbyZoho_Get_Logs
- plan (7): CatalystbyZoho_Create_Bucket, CatalystbyZoho_Create_Job_Pool, CatalystbyZoho_Create_Upload_Signature, CatalystbyZoho_Get_All_Buckets, CatalystbyZoho_Head_Bucket, CatalystbyZoho_List_All_Crons, CatalystbyZoho_List_All_Jobpools

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
- P-SVC [needed] enabled services (console first-use on a fresh project) — the plan uses Stratus
- P-MAIL [skip] send from the verified sender (customer confirms receipt) — the app sends no mail

