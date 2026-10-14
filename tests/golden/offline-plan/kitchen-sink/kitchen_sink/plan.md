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

- [PASS] Room: table Room: 7/250 columns
- [PASS] Room: table Room: 1/2 unique varchar columns
- [PASS] Room: table Room: 0/15 foreign keys
- [PASS] Gear: table Gear: 8/250 columns
- [PASS] Gear: table Gear: 0/2 unique varchar columns
- [PASS] Gear: table Gear: 0/15 foreign keys
- [PASS] Session_Log: table Session_Log: 7/250 columns
- [PASS] Session_Log: table Session_Log: 0/2 unique varchar columns
- [PASS] Session_Log: table Session_Log: 0/15 foreign keys
- [PASS] Booking__Lines: table Booking__Lines: 9/250 columns
- [PASS] Booking__Lines: table Booking__Lines: 0/2 unique varchar columns
- [PASS] Booking__Lines: table Booking__Lines: 1/15 foreign keys
- [PASS] Booking: table Booking: 20/250 columns
- [PASS] Booking: table Booking: 0/2 unique varchar columns
- [PASS] Booking: table Booking: 1/15 foreign keys
- [PASS] Guest: table Guest: 17/250 columns
- [PASS] Guest: table Guest: 0/2 unique varchar columns
- [PASS] Guest: table Guest: 0/15 foreign keys
- [PASS] Media_Kit: table Media_Kit: 17/250 columns
- [PASS] Media_Kit: table Media_Kit: 0/2 unique varchar columns
- [PASS] Media_Kit: table Media_Kit: 1/15 foreign keys
- [PASS] Booking__Gear_Refs: table Booking__Gear_Refs: 4/250 columns
- [PASS] Booking__Gear_Refs: table Booking__Gear_Refs: 0/2 unique varchar columns
- [PASS] Booking__Gear_Refs: table Booking__Gear_Refs: 2/15 foreign keys
- [PASS] Booking: widest generated read of Booking selects 20 columns per statement (docs 20, unverified limit 30; confirm with P-WIDTH)
- [PASS] generated reads are single-table (0/4 joins); lookup display needs one fetch per lookup (confirm with P-JOIN)
- [PASS] this app creates 8 Data Store table(s); an org-wide limit on table creates refuses a create with 403 API_LIMIT_REACHED "API Limit for table" — on that refusal stop creates, keep created tables, and retry after 30/60/120 minutes; a project delete may not free capacity at once

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
- plan (8): CatalystbyZoho_Create_Bucket, CatalystbyZoho_Create_Job_Pool, CatalystbyZoho_Create_Upload_Signature, CatalystbyZoho_Get_All_Buckets, CatalystbyZoho_Head_Bucket, CatalystbyZoho_List_All_Crons, CatalystbyZoho_List_All_Jobpools, CatalystbyZoho_Update_Authentication_Configuration

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

