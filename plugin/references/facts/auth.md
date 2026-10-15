# Catalyst authentication, users, roles, connections and mail — rules

Operating rules for enabling auth, authorized domains, app users, roles, table permissions, Connections and Mail in a Catalyst project. `<dc>`, `<org-id>`, `<project-id>`, `<table-id>`, `<host>` and `<url>` are placeholders resolved from `c2c-deploy.json` and the CLI context.

## Authentication configuration

### Enable hosted and embedded auth with the token; read back through MCP

Rule: [UNVERIFIED] enabling authentication works with the CLI token; reading or updating the configuration does not.

- `POST /baas/v1/project/<project-id>/authentication/enable?auth_type=hosted` then `?auth_type=embedded`, body `{"public_signup":false}` → `200`. Public signup stays off; enable it only as a deliberate step, never as a workaround.
- `GET` and `PUT /baas/v1/project/<project-id>/authentication/configuration` with the token → `401 OAUTH_SCOPE_MISMATCH`. Read via MCP `Get_Authentication_Configurations`; write via a console step the user performs under Authentication (there is no verified MCP update tool).
- `url_preference` (the hosted-login redirect target) is changed only in the console — the token's `PUT` is the scope mismatch above; embedded sign-in does not need it, so leave it unchanged.
- Social-login client secrets apply to Development only — the user re-enters them in Production after promotion.

### Add authorized domains with cors and iframe on at first create

Rule: [UNVERIFIED] register the Slate origin and any app origin before browser-side sign-in or API calls, with `"cors":true,"iframe":true` on the first create — embedded sign-in renders inside a frame, and a domain created `iframe:false` stays that way.

- `POST /baas/v1/project/<project-id>/cors-domain` body `{"domain":"<host>","cors":true,"iframe":true}` works with the token; the same POST on an existing domain → `409`.
- `PUT /cors-domain` with the token → `401 OAUTH_SCOPE_MISMATCH` — an entry already created with `iframe:false` is corrected only by a console edit the user performs.
- `GET /cors-domain` with the token → `401 OAUTH_SCOPE_MISMATCH`; read back through MCP `List_All_CORS_Domains`, or behaviourally — an `OPTIONS` preflight to the origin must return `Access-Control-Allow-Origin` (and allow credentials when used with cookies).

### Order sign-in host → domain → invites → check, and keep the service worker off auth paths

Rule: [UNVERIFIED] deploy the Slate host first, then create the authorized domain with `iframe` on, then send invites, then run the sign-in check — each step's read-back depends on the step before it.

- The generated app's service worker never answers navigations under `/accounts/`, `/__catalyst/`, `/baas/` or `/server/` and never answers cross-origin requests — a worker that does serves the app shell inside the sign-in frame instead of the login page. Check by loading the sign-in page framed: it must render the login form, not the app.
- The app renders a clear signed-out state when `GET /baas/v1/project/<project-id>/project-user/current` answers `401` — a blank shell is a failed check, not a pending one.

### Land sign-in on the app root — Slate has no redirect field

Rule: [UNVERIFIED] post-login landing is set in the app, not in project configuration — a `catalyst.json` `slate` entry takes only `name`, `source`, `framework` (and `template`); `login_redirect` exists only for Web Client Hosting (`client-package.json`), never for Slate.

- Embedded login: the generated page calls the Web SDK `signIn(<elementId>, {"service_url":"<app url>"})`; without `service_url` the user lands on the default `/app/` path, which a Slate app does not host → `404`.
- A link to hosted login carries the target itself: `/__catalyst/auth/login?service_url=<app url>`.
- Invites carry `redirect_url` = the Slate app URL (the users-and-roles rule) — the third lever.

### Keep public signup off; gate portal signup behind validation

Rule: [UNVERIFIED] `public_signup` stays `false`. When the app needs gated self-registration, generate a Custom User Validation Basic I/O function that applies the app's portal rules (allow/deny by domain, invite list, …) instead of opening public signup.

- While `public_signup` is on, `POST /baas/v1/project/<project-id>/project-user/signup` with the token creates an `ACTIVE` user with `is_confirmed:false` — an uncontrolled path that exists only because signup is on. Keep it off.

## Users and roles

### Resolve role ids per project — they are not portable

Rule: [UNVERIFIED] `App Administrator` and `App User` exist by default; every other role id is per-project.

- `GET /baas/v1/project/<project-id>/role` with the token → `401 OAUTH_SCOPE_MISMATCH`; read roles via MCP `List_All_Roles` / `Get_Role`, an existing project user's `role_details`, or the console.
- The IaC export's `Authentication` `roles` items are keyed by `role_name` and carry no role id, so deploy never reads a role id from an export.
- Fresh project with the token (no app users yet, `GET /role` refused): the first admin is a console Add User step — Role = App Administrator (picked by name, no id needed), Platform = Web, Component = Slate + the app, Deployment = default, Redirect URL = the Slate app URL. `c2c deploy` prints these values as one block.
- Never ship a role id in generated files — resolve it by name at apply time.
- [TESTED] (live run, 15 Oct 2026) MCP `List_All_Roles` returns `role_id` as an exact string (17 digits). Keep it a string end to end: parsed as a JSON number it is rounded (two ids that differ in the last digit read back as the same number). `c2c users invite --role-ids 'App Administrator=<id>'` sends the id unchanged.

### Create custom roles in the template or the console — never with the token

Rule: [UNVERIFIED] `POST /baas/v1/project/<project-id>/role` with the token → `401 AUTHENTICATION_FAILURE` and there is no MCP create-role tool.

- Greenfield: declare roles in the template's `Authentication` component (`roles` items).
- Existing project: the user creates the role in the console (Authentication → User Management → Roles → Add Role); read its `role_name` and id back afterwards.
- The refusal is `401 AUTHENTICATION_FAILURE` (not `OAUTH_SCOPE_MISMATCH`) whether or not `clone_role` is sent — role creation is unreachable with the token on any body shape.

### Manage table permissions and scopes by role name

Rule: [UNVERIFIED] `PUT /baas/v1/project/<project-id>/table/<table-id>/permission` and `PUT …/scopes` with the token → `401 OAUTH_SCOPE_MISMATCH`; the MCP routes write per-role grants and scope flags.

- MCP `Update_Table_Permissions` takes a body keyed by role name (`{"App Administrator":["SELECT",...]}`) — custom roles are not reachable through it and ship via the template or console instead.
- MCP `Update_Table_Scopes` toggles a table's scope flags.
- Read first with `Get_Table_Permissions` / `Get_Table_Scopes`: the update replaces the permission mapping, so `c2c` shows the planned change and the user answers "yes" before it is applied.
- The console requires an existing role to clone for a new role; scopes (Global/Org/User) and permissions apply to Data Store and File Store only.

### Add users as admin — self-service signup is off

Rule: [UNVERIFIED] invite app users one by one; the invitee confirms from the invitation email.

- `POST /baas/v1/project/<project-id>/project-user` body `{"user_details":{"email_id":"<invitee>","role_id":<id>},"platform_type":"web","redirect_url":"<url>"}` → `200` with `is_confirmed:false`; resolve `role_id` via the role read-back above.
- Send only those fields (plus `first_name` / `last_name`); no `org_id`. `first_name` is never empty — an empty one is rejected `400 MISSING_PARAM` (and a nameless duplicate loses its `409 DUPLICATE_VALUE`); `c2c deploy` takes `--admin-name` or derives one from the email local part. With the token and public signup off, the send is unverified — any refusal or rejection falls back to the console Add User values block.
- The Slate host is a prerequisite of inviting — never send an invite before it exists. Always send `redirect_url` as the deployed Slate app URL — an invite without it lands the invitee on an unhosted `/app/` path that answers `404` and the confirmation never completes.
- [TESTED] (live run, 15 Oct 2026) an email with `+` is rejected `400 INVALID_INPUT` `Email Id cannot contain '+' character`. `c2c users` normalises the identity (plain mailbox; Gmail dot/googlemail variants fold) and invites that — `migrate-data` rewrites `Added_User`/`Modified_User` and Users-field cells to match.
- `GET /project-user` lists users (token works); `DELETE /project-user/<id>` → `200`. `PUT /project-user/<id>` `{status:'enable'|'disable'}` and `{role_details:{role_id}}` drive `c2c users disable|enable|set-role` — [UNVERIFIED] for the CLI token, so each write is confirmed by re-reading the user.
- Self-service `POST /project-user/signup` with signup disabled → `403 PUBLIC_SIGNUP_ERROR` — that is the expected signal to use the admin add instead, not a reason to open signup.
- `POST /project-user` rejects an empty body with `500 INTERNAL_SERVER_ERROR` rather than `401 OAUTH_SCOPE_MISMATCH` — the admin invite path is scope-reachable with the token; prove a real body on a throwaway address before relying on it.
- MCP: `Add_User`, `User_Signup`, `List_All_Project_Users`, `Get_Project_User_By_Id`, `Update_Project_User`, `Enable_Or_Disable_Project_User`, `Delete_Project_User`.
- The plugin never sends an invitation email on its own — the send is a user-approved step.

### Budget the user cap before inviting

Rule: [DOC] assume 25 app users in Development
([L-DEV-USERS](references/limits.md#l-dev-users-app-users-in-development));
Production allows ~1000 by default [UNVERIFIED] and the cap is raisable by the customer. `c2c doctor`/`c2c plan` reads the limit the auth configuration reports (MCP `Get_Authentication_Configurations`) and warns before invites that would cross it.

### Hosted login redirects carry ?redirect= — cap the retries

Rule: [UNVERIFIED] after hosted sign-in the user lands on `/__catalyst/auth/login?redirect=<path>`; generate the redirect param and cap retries — a redirect loop trips the per-domain throttle (`THROTTLE_LIMIT_REACHED`), which is slow to clear. Keep a per-session counter (at most 2 redirects per 60 s, then serve a static error page).

### Third-party JWT is the SSO route

Rule: [UNVERIFIED] Catalyst has no native SAML/OIDC/Zoho-One SSO for app users — use Third-Party Authentication (custom token + `signinWithJwt`, the documented Okta-style path [DOC]). Flag Creator apps that rely on org SSO as a manual step in the migration plan.

See also: https://docs.catalyst.zoho.com/en/cloud-scale/help/authentication/third-party-authentication/

### Give external systems a client token, not a user login

Rule: [UNVERIFIED] for server-to-server callers, mint a JWT from the project's client credentials (`client_id` + secret, ~1 hour lifetime); bearer-token signup for arbitrary external users is not a self-serve route.

## Connections

### Create connections in the console — consent is the user's click

Rule: [UNVERIFIED] no token or MCP route creates a connection; the user completes OAuth consent in the browser.

- `POST /baas/v1/project/<project-id>/connections` → `400 INVALID_REQUEST_METHOD`; console-only connection paths refuse the token with `400 BROWSER_COOKIES_DISABLED`.
- Read status: `GET /baas/v1/project/<project-id>/connections` (token works) → `[{id, connected, display_name, link_name, group_name}]` — poll it after consent until `connected:true`.
- Consent: the user authorizes the connection in the console (Connections → the connection), then c2c re-reads the status.
- Connections arriving via IaC import land `Not Connected` — run the same consent step.

### Name connectors exactly — the link name is the runtime key

Rule: [UNVERIFIED] use the connector's `link_name` verbatim (`zohobooks`, not `zoho_books`); a deluge script naming a connection the project does not define fails app import with `Connection <name> does not exists`. Generate calls only for connections the target project actually defines.

### Grant Connection Access for script callers

Rule: [UNVERIFIED] a script that uses a connection needs that connection's Connection Access enabled for the calling context (console → Connections → the connection); without it calls fail with `2945`-class scope errors (`zoho.creator.*Record` calls surface `3100`). Custom-scope edits can require an org-level grant — same error family.

### Route Catalyst→Creator calls through a queued, backing-off client

Rule: [UNVERIFIED] assume Creator-side APIs throttle to ~1 request per minute per source; calls from Catalyst code into Creator go through a serialized client with backoff — never a tight retry loop. Creator→Catalyst is also one-way: Creator cannot publish into Catalyst Signals or call Catalyst webhooks natively — plan a Catalyst-side poll or an explicit bridge the user approves.

## Mail

### Verify the sender domain before any send

Rule: [UNVERIFIED] `POST /baas/v1/project/<project-id>/email/send` (multipart fields `from_email`, `to_email`, `subject`, `content`, `html_mode`) from an unverified or public-mailbox domain → `403 VERIFICATION_NEEDED` — `"You need to verify the email domain :: <domain> before accessing this API"`. A freemail domain (`@gmail.com`-style) can never pass verification; the sender domain must be customer-owned.

- Path: verify a customer-owned domain (console → Mail → add domain, or MCP `Create_Domain`), configure the sender, then retry the send.
- `POST /baas/v1/project/<project-id>/email` `{"display_name":…,"email_address":…}` → `status PENDING`; `POST /email/verify` `{"email_address":…,"code":"<6-char code>"}` → `VERIFIED`. A public-domain sender verifies the address but the domain stays `Verification Pending` — DKIM/SPF cannot be proven for it — and a send from an unregistered `from_email` answers `No such from_email with the given id exists`.
- Keep a per-message delivery log (message id, timestamp, send result) — "accepted by the API" is not "delivered".

### Configure the sender through MCP with a code the user supplies

Rule: [MCP-LISTED] `Create_Email_Configuration` body `{ "email_address": "<sender>", "display_name": "<name>", "code": "<code>" }` — the verification `code` is mailed to that address; ask the user to read it from their mailbox. Never call the tool speculatively — calling it triggers the mail.

- Read back: MCP `List_All_Emails_Configuration` (spelling as listed; there is no get-by-id) or `GET /baas/v1/project/<project-id>/email`; `Delete_Email_Configuration` removes a sender.
- Console path: Mail → add sender → enter the 6-character code → the config shows `VERIFIED`.

### Rewrite Creator `sendmail` `from:` rules on migration

Rule: [UNVERIFIED] on the Creator side, a literal `sendmail from:` must be a Zoho account address (`zoho.adminuserid`, `zoho.loginuserid`, `zoho.adminuser`) or a sender address already verified in the target account — other literals are rejected at save/import ("the from address can only be zoho.adminuserid … or a verified email address"). A `from:` built from a variable bypasses that check — flag it for review.

- Map `from: zoho.adminuserid` → the verified Catalyst sender, and preserve intent with `reply to:` the original admin address.
- Attachments: ≤ 15 MB total, ≤ 5 files per message.

### Slate serves no /baas — the Web SDK cannot mint a functions token there

Rule: [TESTED] (public test: `packages/deploy/test/auth-bridge.test.ts`) `GET <slate-host>/__catalyst/sdk/init.js` answers `api_domain:""`, so the Web SDK (4.6.1 and 4.6.2) sends `/baas/*` root-relative → 404 HTML on `*.onslate.<dc>` (`/baas/.../custom-token?feature=functions` → 404; on the function host the same path → 401 JSON). `generateAuthToken()` then never settles — its non-200 custom-token reply does not reject. The SDK pin does not fix it; the empty api_domain is what the Slate origin serves.

- [TESTED] (public tests: `packages/deploy/test/auth-bridge.test.ts`, `packages/ui/test/auth-bridge.test.ts`, `packages/ui-react/test/auth-bridge.test.ts`) the `c2c_auth` Advanced I/O function on the function host serves `GET /server/c2c_auth/bridge?state=<43 base64url>` — a strict-CSP page that runs `generateAuthToken()` first-party there and returns the token to the Slate origin in `#c2c_auth=<token>&state=<state>`; the Slate page checks state against sessionStorage, strips the fragment, and calls `c2c_api` with `Authorization: <token>` and `credentials:'omit'`. The bridge answers 200 text/html with CSP `frame-ancestors 'none'` + `referrer-policy: no-referrer`, a bad state → 400, and `OPTIONS /server/c2c_api/<route>` from the Slate origin → ACAO + `allow-headers: authorization`. `bridge?action=signout` ends the function-origin session after the Slate page clears its stored token.
- [UNVERIFIED] whether the gateway accepts the functions JWT in `Authorization` on an Advanced I/O call.
- `GET <slate>/server/c2c_api/` → 404 HTML and `<slate>/__catalyst/server/...` → 404: there is no same-origin function path on Slate ("Slate's Access URL" in the cross-domain doc means a backend *hosted on Slate*, not a proxy to functions).
