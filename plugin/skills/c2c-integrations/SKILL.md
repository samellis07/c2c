---
name: c2c-integrations
description: "Creator integrations to Catalyst with c2c: Connections (OAuth to Zoho CRM, Books and others), zoho.* integration tasks, invokeurl (timeouts, retries), Custom APIs to API Gateway, sendmail to Catalyst Mail with a verified sender, record templates and PDF via SmartBrowz, and Creator-to-Catalyst calls. Use for 'connection', 'zoho.crm', 'zoho.books', 'invokeurl', 'Custom API', 'API Gateway', 'sendmail', 'email not sent', 'verified sender', 'PDF', 'record template'."
metadata:
  version: "0.2.0"
---

# Integrations

Load `catalyst-authentication` (Connections section) and `catalyst-functions` (API Gateway) for platform details.

## Routes

| Creator | Catalyst | How it is created | Read-back / probe | Status |
|---|---|---|---|---|
| Connection (`zoho.*`, invokeurl with `connection:`) | Catalyst Connection, credentials fetched in code with `getConnectionCredentials` | **Console + user consent** (no API: `POST /connections` → `INVALID_REQUEST_METHOD` [TESTED]; no MCP tool). Zoho Creator is listed among the console's default services [TESTED] | CLI `GET /connections` → the name is listed [TESTED]; probe route that calls `getConnectionCredentials` and returns only `ok` | Checklist + probe |
| `zoho.*` integration tasks (~290 kinds) | Adapters on the Node SDK / REST | Generated code | Unit vectors; probe per connection | 16 adapters; others → TODO with the task name |
| `invokeurl` | Wrapper with timeout, retry with fixed backoff, idempotency key | Generated code | — | Lane 8 s1 (`agent/lane8-invokeurl`); calls out live under the 30 s request bound ([L-REQUEST-TIME](../../references/limits.md#l-request-time-advanced-io--appsail-request) → split) |
| Custom APIs | API Gateway routes to `c2c_api` | `catalyst apig:enable` [CLI] + MCP `Configure_API_Gateway_Route` [MCP-LISTED] | MCP `List_All_API_route` / `Get_API_route`; one call per route | Planned (currently counted only) |
| `sendmail` | Catalyst Mail from a verified sender | MCP `Create_Email_Configuration` (+ `Create_Domain`) [MCP-LISTED]; the **user** enters the 6-character verification code | MCP list of email configs → verified; P-MAIL (one real send) only with the user's OK | Generated. A gmail sender stayed "Domain Verification Pending" [TESTED]; public-domain sender behaviour **[UNVERIFIED]** |
| Record templates / PDF | LiquidJS templates + SmartBrowz HTML→PDF → Stratus | Generated code; SmartBrowz stored templates are console-only | Render one PDF, check page size | Planned. `@page{size:A4}` ignored and `landscape` only as the string `"true"` [TESTED] |
| Catalyst → Creator calls (dual run) | Queued client with 429 backoff | Generated code; run from the customer machine during migration | — | 429 at ~1 req/min from Catalyst egress [UNVERIFIED] ([L-CREATOR-EGRESS](../../references/limits.md#l-creator-egress-creator-api-from-catalyst) → queue): never on a hot path |

## Steps

1. **Inventory** (from `plan.md` → *Integrations*): connections by service and scope, `zoho.*` tasks by kind (adapter / TODO), invokeurl targets, Custom APIs, sendmail uses (from address, attachments), templates.
2. **Connections** (per connection, guided):
   1. tell the user: Console → project → Connections → Create → service <X> → scopes <list from plan> → name `<creator connection link name>` → authorize (their own consent screen);
   2. read back `GET /connections` (CLI) lists the name;
   3. after deploy, run the probe route; `ok` = credentials resolvable.
3. **Mail:** ask which sender address to use (Creator's `from` must be admin, login user or verified: precheck rule 09). Create the configuration via MCP with the user's yes; the user enters the code they receive; read back verified. Do **not** send a test email without the user's explicit OK (it sends real mail).
4. **Custom APIs:** enable API Gateway (CLI), create each route via MCP with the plan's method/path/target, read back, then call each once (expect the generated response or 401 when unauthenticated). A Custom API declared `GET` whose function writes, mails, or calls out is routed as `POST` (a state change is never a GET); the migration report names it as `custom-function-api-method`, and the gateway route uses `POST`.
5. **TODO tasks:** every `zoho.*` task without an adapter is a TODO in `migration-report.json` with the task name and line. Draft fills only through `c2c fill-todos --accept` (`c2c-logic` step 2).
6. **Env values** for third-party API keys: user fills `function-env.json`; never in chat, never in files under `c2c-out/` other than that one, which is git-ignored.

## Decision rules

- A connection the plan references but the `.ds` does not define (precheck rule 18) blocks the workflows that use it: fix in Creator or remove the call.
- Integrations to Zoho apps in another DC than Catalyst: allowed, but say data crosses regions.
- Cliq integration-function bots: Integration Functions are not available in every data centre [DOC]: not supported in this version (counted).
- Never call Creator from a generated Catalyst function in the request path.
- **Rule — default settings only (C2C.md rule 13).** No browser automation and no permission-rule changes: connection consent and console steps are guided asks the user performs (exact clicks, then "done?"), verified by the named read-back.

## Verification

- Each connection: listed + probe `ok`.
- Mail: sender verified (read-back); optional P-MAIL with the user's OK and their confirmation of receipt.
- Each API Gateway route: listed + one call.
- `migration-report.json`: every integration is `converted`, a TODO or out of scope; none unflagged.

## Stop conditions

- A required connection is not authorized (probe fails).
- Mail sender not verified while the app sends mail on a critical path (submit/approval).
- An API route read-back mismatch.

## What to ask the user

- To create and authorize each connection (exact clicks), then "done?".
- Which sender email; to enter the verification code; whether to send one test email.
- Third-party API keys into the env file.
