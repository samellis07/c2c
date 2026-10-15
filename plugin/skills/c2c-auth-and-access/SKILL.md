---
name: c2c-auth-and-access
description: "Creator users, portals, profiles and permissions to Catalyst Authentication with c2c: enable hosted and embedded login, authorized domain (CORS) for the Slate URL, roles (App Administrator, App User, custom), table permissions and scopes, inviting app users, function security rules, and SSO gaps. Use for 'sign in required', '401', 'project-user/current 401', 'CORS', 'Authorized Domains', 'roles', 'permissions', 'portal users', 'invite user', 'PUBLIC_SIGNUP_ERROR', 'OAUTH_SCOPE_MISMATCH', 'Zoho One SSO'."
metadata:
  version: "0.2.0"
---

# Authentication and access

Load `catalyst-authentication` for Web SDK sign-in, ZAID and Security Rules. This skill adds the routes c2c has proven and the order.

## Why this step is not optional

Every generated API call needs a signed-in Catalyst app user with role App Administrator or App User (`c2c-principal.mjs` + `principal-map.json`). The developer's CLI token gets `401 {"error":"sign in required"}` [TESTED]. Without this step the migrated app is an empty, silent shell [TESTED].

## Route per item (see `references/route-map.md`)

| Item | Do it with | Read back with | Evidence |
|---|---|---|---|
| Enable hosted login | CLI REST `POST /authentication/enable?auth_type=hosted` body `{"public_signup":false}` | MCP `Get_Authentication_Configurations` (CLI read → `OAUTH_SCOPE_MISMATCH`) | [TESTED] |
| Enable embedded login | CLI REST `POST /authentication/enable?auth_type=embedded` `{}` | same | [TESTED] |
| Authorized domain = Slate host | CLI REST `POST /cors-domain {"domain":"<app>.onslate.<dc>","cors":true,"iframe":true}` — iframe must be on at first create | MCP `List_All_CORS_Domains` + `OPTIONS` preflight returns ACAO | [TESTED]; repeat POST → `409`, `PUT` → `OAUTH_SCOPE_MISMATCH`: an existing iframe-off entry is a console edit |
| `url_preference` (hosted-login redirect) | Console only — c2c uses embedded login, which does not need it; leave it unchanged | MCP `Get_Authentication_Configurations` | CLI `PUT` → 401 scope mismatch [TESTED] |
| Other auth config | Console Authentication → Embedded (no MCP update tool exists) | MCP `Get_Authentication_Configurations` | CLI `PUT` → 401 [TESTED] |
| Role ids | default roles exist; ids differ per project | MCP `List_All_Roles` (CLI → 401 [TESTED]) | [TESTED] |
| Custom roles (from Creator profiles) | IaC template (greenfield) or **console** | MCP `List_All_Roles` | role create → `AUTHENTICATION_FAILURE` [TESTED]; no MCP create |
| Table permissions & scopes | MCP `Update_Table_Permissions`, `Update_Table_Scopes` | MCP `Get_Table_Permissions`, `Get_Table_Scopes` | CLI → 401 [TESTED] |
| First admin user | CLI REST `POST /project-user` (admin add) or MCP `Add_User` | CLI `GET /project-user` / MCP `List_All_Project_Users` | `POST /project-user` worked [TESTED] with public signup on; with signup **off**: [UNVERIFIED]. `/project-user/signup` with signup off → `403 PUBLIC_SIGNUP_ERROR` [TESTED] |
| Function security rule "authentication required" | IaC `SecurityRules` (greenfield) or console | Probe P-401 credential-free: `curl -s -o /dev/null -w '%{http_code}' <function-url>` → `401 NO_ACCESS` (`is_authenticated` is the only readable signal) | No CLI/MCP command [TESTED]; `catalyst deploy` leaves `optional` unless the rule arrived through the import |
| Users beyond the first admin | Same as first admin, after the user approves the list | as above | Dev allows 25 users [DOC] (a higher effective cap is [UNVERIFIED]) |

## Steps

1. **Plan review** (`plan.md` → *Auth*): Creator profiles → Catalyst roles (custom roles cloned from App User or App Administrator), per-table permissions (SELECT/INSERT/UPDATE/DELETE) and scope, portal users count, SSO flags.
2. **Ask for the first admin's email** (the user's own, usually). Note: inviting sends that address a real email.
3. **Order** (each with the user's yes, each followed by its read-back):
   1. enable hosted, then embedded (public signup **off** unless the Creator app has open portal signup and the user asks for it);
   2. Authorized domain for the App URL host (needs the App URL from `c2c-ui`);
   3. read role ids (MCP);
   4. custom roles: console checklist item if any (exact path: Authentication → User Management → Roles → Add Role), then read back;
   5. table permissions and scopes per role (MCP), read back;
   6. invite the first admin (role App Administrator) with `redirect_url` = the Slate app URL — the Slate host must already exist (never invite without it), and the default lands the invitee on an unhosted `/app/` path (404) where the invite never completes. In the console path the form needs Platform = Web, Component = Slate, the Slate app and Deployment = `default` [TESTED];
   7. the **user** opens the invite email, confirms, sets a password, and signs in once on the App URL;
   8. read back `is_confirmed: true` (`GET /project-user`) and `project-user/current` → 200 from the page. Before sign-in the app shows a clear signed-out state, and the framed sign-in page renders the login form — if it shows the app shell, the service worker is answering `/accounts/`, `/__catalyst/`, `/baas/`, `/server/` or cross-origin navigations it must bypass. After sign-in the user lands on the app root — a landing on `/app/` (404) means the app's `signIn(elementId, …)` call is missing `{service_url:<app url>}`; Slate has no redirect field in `catalyst.json` (`login_redirect` is Web Client Hosting only).
4. **Security rule:** until c2c writes it, add a checklist item: Console → Functions → `c2c_api` → Security Rules → authentication required. The CLI has no command or import path for it and `catalyst deploy` leaves the function `optional` unless the rule arrived through the IaC import — check it after every deploy; verify with P-401 — `curl -s -o /dev/null -w '%{http_code}' <function-url>` prints `401` with no session involved.
5. Record every result in `c2c-out/<app>/provision/state.json` via `c2c provision --out c2c-out/<app> --record <step-id> --result <file>`.

## Decision rules

- **Public signup:** off by default. Turning it on is the user's explicit decision.
- **Creator portal users:** re-invited, never imported with passwords. Users missing in Catalyst must not fall back to a super admin silently; list them as pending.
- **SSO (Zoho One / SAML):** no native equivalent [UNVERIFIED]. Offer hosted/embedded login with re-invites, or the documented third-party (custom token / JWT) path. Flag it as a decision in `decisions.json`.
- **Field/report/action-level permissions:** Catalyst roles govern table CRUD and scope only. c2c enforces the finer rules in the handler middleware; say so.
- **Redirect loops** can trip the per-project URL throttle for 10+ hours [UNVERIFIED]: generated auth redirects are capped; never script repeated sign-in attempts.
- **Rule — default settings only (C2C.md rule 13).** Never drive a browser or console and never sign in for the user; every sign-in, consent and console click is a guided ask the user performs, verified by the named read-back.

## Managing users after go-live

`c2c users` runs the management ops over the same `project-user` REST hook as invite — no console needed. Every write needs the user's yes plus `--confirm` (doctor-gated) and is proven by a read-back; `--confirm` runs refuse when doctor.json is not green for the org/project scope.

- `c2c users list --ds <file|dir> --project <id> --org <org>` — user_id, role, status, confirmed per user (addresses are never printed).
- `c2c users add --ds <file|dir> --project <id> --org <org> --email <e> --role <name> --confirm` — POST /project-user with `redirect_url` = the Slate app URL (same rules as invite; `--role-ids`/`--slate-domain` as needed).
- `c2c users disable|enable --ds <file|dir> --project <id> --org <org> --user-id <id> --confirm` — `PUT /project-user/<id>` `{status}` ([UNVERIFIED] shape for the CLI token — the result is verified by re-reading the user).
- `c2c users set-role --ds <file|dir> --project <id> --org <org> --user-id <id> --role <name> --confirm` — role must be one the export plans, a built-in, or one a project user holds (`--role-ids <name=id>` supplies the id); an unknown role is refused before any request.

## Stop conditions

- Any read-back mismatch (e.g. `embedded_auth:false` after enable).
- `PUBLIC_SIGNUP_ERROR` on invite → do not turn public signup on to get around it; use `POST /project-user` / `Add_User` or the console.
- A `+` in an invitee email → Add User rejects it (`Email Id cannot contain '+' character` [TESTED]); `c2c users` normalises the identity instead — the plain mailbox is invited and `migrate-data` rewrites `Added_User`/`Modified_User` to it (dot/plus variants fold to one invite; non-Google `+tag` delivery is [UNVERIFIED] — confirm the invitee got the mail).
- `users invite` says a role has no id (GET /role → `401 OAUTH_SCOPE_MISMATCH` [TESTED]) → read `role_id` with MCP `List_All_Roles` (a string; copy it exactly) or the console, then re-run with `--role-ids 'App Administrator=<id>'`.
- A preflight without ACAO after adding the domain.
- The user has not confirmed the invite: everything after (smoke, parity through the UI) waits.

## What to ask the user

- First admin email; whether public signup should be on.
- Approval of the role/permission matrix.
- "Please confirm the Catalyst invite email and sign in at <App URL>; tell me when done."
- For each console-only item: the exact clicks, then "done?".

- **Slate auth token = the c2c_auth bridge, not the Web SDK on Slate.** `init.js` on `*.onslate.*` serves `api_domain:""`, so `generateAuthToken()` on a Slate page hangs (its `/baas` calls 404). Deployed apps set `C2C_AUTH_BRIDGE` in `c2c-config.js` and fetch the token by a top-level trip to `<fn-host>/server/c2c_auth/bridge`, returned in a `#c2c_auth=` fragment bound to a tab-generated `state`. Public symptom text: "generateAuthToken hangs forever" / every API call `401 NO_ACCESS`. Live-verified on project <project-id> (2026-10-15); gateway acceptance of the functions JWT is proven when the smoke POST logs 200.
