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
| Enable hosted login | CLI REST `POST /authentication/enable?auth_type=hosted` body `{"public_signup":false}` | MCP `Get_Authentication_Configurations` (CLI read → `OAUTH_SCOPE_MISMATCH`) | [E2E auth row 1] |
| Enable embedded login | CLI REST `POST /authentication/enable?auth_type=embedded` `{}` | same | [E2E row 3] |
| Authorized domain = Slate host | CLI REST `POST /cors-domain {"domain":"<app>.onslate.<dc>","cors":true,"iframe":true}` — iframe must be on at first create | MCP `List_All_CORS_Domains` + `OPTIONS` preflight returns ACAO | [E2E rows 2, 4]; repeat POST → `409`, `PUT` → `OAUTH_SCOPE_MISMATCH`: an existing iframe-off entry is a console edit |
| `url_preference` (hosted-login redirect) | Console only — c2c uses embedded login, which does not need it; leave it unchanged | MCP `Get_Authentication_Configurations` | CLI `PUT` → 401 scope mismatch [E2E row 5] |
| Other auth config | Console Authentication → Embedded (no MCP update tool exists) | MCP `Get_Authentication_Configurations` | CLI `PUT` → 401 [E2E row 5] |
| Role ids | default roles exist; ids differ per project | MCP `List_All_Roles` (CLI → 401 [HV H5]) | [E2E] |
| Custom roles (from Creator profiles) | IaC template (greenfield) or **console** | MCP `List_All_Roles` | role create → `AUTHENTICATION_FAILURE` [HV H6]; no MCP create |
| Table permissions & scopes | MCP `Update_Table_Permissions`, `Update_Table_Scopes` | MCP `Get_Table_Permissions`, `Get_Table_Scopes` | CLI → 401 [HV H5] |
| First admin user | CLI REST `POST /project-user` (admin add) or MCP `Add_User` | CLI `GET /project-user` / MCP `List_All_Project_Users` | `POST /project-user` worked [HV H7] with public signup on; with signup **off**: PROBE FIRST. `/project-user/signup` with signup off → `403 PUBLIC_SIGNUP_ERROR` [E2E] |
| Function security rule "authentication required" | IaC `SecurityRules` (greenfield) or console | Probe P-401 credential-free: `curl -s -o /dev/null -w '%{http_code}' <function-url>` → `401 NO_ACCESS` (`is_authenticated` is the only readable signal) | No CLI/MCP command [§3a CA-15]; `catalyst deploy` leaves `optional` unless the rule arrived through the import |
| Users beyond the first admin | Same as first admin, after the user approves the list | as above | Dev allows 25 users [DOC] (observed limit 1000 [E2E]: PROBE FIRST) |

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

## Stop conditions

- Any read-back mismatch (e.g. `embedded_auth:false` after enable).
- `PUBLIC_SIGNUP_ERROR` on invite → do not turn public signup on to get around it; use `POST /project-user` / `Add_User` or the console.
- A preflight without ACAO after adding the domain.
- The user has not confirmed the invite: everything after (smoke, parity through the UI) waits.

## What to ask the user

- First admin email; whether public signup should be on.
- Approval of the role/permission matrix.
- "Please confirm the Catalyst invite email and sign in at <App URL>; tell me when done."
- For each console-only item: the exact clicks, then "done?".
