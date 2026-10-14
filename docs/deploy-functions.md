# Deployable functions: `functions/c2c_api`

`c2c deploy` writes one Catalyst **Advanced I/O** function, `c2c_api`, that serves
every generated form, report, upload, and lookup endpoint. This page covers the
layout, the principal model for v1, the deploy order and resume, the offline
harness, and the console steps you do by hand.

References (public docs; this page does not fetch them):
- Node SDK: https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/overview/
- Web SDK: https://docs.catalyst.zoho.com/en/sdk/web/v4/overview/
- CLI: https://docs.catalyst.zoho.com/en/cli/v1/cli-command-reference/
- Bulk row limits: https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/bulk-operations/

## Layout

```
catalyst.json                  functions: { targets: ["c2c_api"], source: "functions" }, slate: {...}
functions/c2c_api/
  catalyst-config.json         deployment { name, stack node20, type advancedio, env_variables { kept console env + C2C_DEPLOY_MODE; secret names hold "" } }, execution { main index.js }
  package.json                 exact pins: zcatalyst-sdk-node 3.4.0
  index.js                     module.exports(req, res): the Advanced I/O entry (CommonJS)
  routes.json                  "POST /forms/<Form>/submit" -> handler module
  c2c-principal.mjs            Catalyst Authentication user -> Creator profile
  principal-map.json           default Catalyst roles -> Creator profiles
  c2c-sdk-datastore.mjs        shim datastore over zcatalyst-sdk (admin scope)
  c2c-field-values.mjs         field values by type, for stored rows and posted records
  c2c-columns.json             { <table>: { <column>: Number | Double | Decimal | Boolean | Date | DateTime | BigInt | Foreign Key } } for the adapter and the entry
  c2c-store.mjs                per-request datastore slot (AsyncLocalStorage)
  c2c-deploy.json              { mode: live | dry-run, appTimeZone, outboundHosts? }
  access-policy.json           Creator profile grants (from the .ds)
  aio/ reports/ uploads/ lookups/   generated handlers (ES modules)
  vendor/shims/                compiled creator-to-catalyst shims, type: module
slate/c2c-config.js            stable URL: API base + Catalyst Web SDK loader
```

- The handlers import `../../vendor/shims/index.js`, never the workspace package
  `creator-to-catalyst/shims`. The vendored files are the compiled shims without
  source-map comments, so two runs write identical bytes (`function-dir.test.ts`
  and the local-corpus determinism snapshots check this).
- `zcatalyst-sdk-node` is pinned to 3.4.0. Integrity:
  `sha512-+hjLHve+BeQdSd9rt8MgugMrfVKfBO9kZO58e+Uwakmn7SrasqOJDyWffECxMAVfemMPSSQOpRx/aAbghdOQIA==`.
- The entry is a plain `(req, res)` function, not Express: an Express app is
  called the same way, and the function then needs no extra dependency. Routes
  are matched after `/server/c2c_api` and an optional `/execute`.

## Mode

A handler writes only in live mode. `C2C_DEPLOY_MODE` (`live` or `dry-run`)
overrides `c2c-deploy.json`. `c2c deploy --confirm` writes `live` to both
`c2c-deploy.json` and `catalyst-config.json` `env_variables`. A plan-only run
writes `dry-run`.

`catalyst deploy` **replaces** the function's console environment with
`env_variables`, so a deploy must carry every key already there
(`C2C_MAIL_FROM`, `C2C_ZOHO_DC`, `C2C_OWNER_APPROVAL_TOKEN`, `C2C_APP_TIMEZONE`, ...).
`c2c deploy --confirm` refuses to run without `--function-env`:

- `--function-env <file>`: the function's current console environment as a JSON
  object of name -> string. Keep the file outside the repo; values may be secrets.
  Non-secret values go into `env_variables` (sorted), and only key names are
  ever printed. `C2C_DEPLOY_MODE` is always this deploy's mode.
- `--function-env new`: a first deploy, with nothing to keep.

**Secret values never enter the generated tree.** The generated project is the
customer's and is often committed, so a `--function-env` name matching
`token`, `secret`, `key`, `password` or `credential` (case-insensitive) is
written to `env_variables` as a name-only entry (`"NAME": ""`). Whether
`catalyst deploy` accepts the empty value and keeps the variable is
[UNVERIFIED]. Right after the
functions deploy succeeds, `c2c deploy --confirm` sets the real values on the
live function over the Catalyst env API (`POST
/baas/v1/project/<project-id>/function/<id>/configuration`, which replaces the
whole set — the live variables are re-read and merged first; see
`plugin/references/facts/functions.md`, "Manage env vars as one replace-only
set", and `packages/deploy/src/function-env.ts`). If that write fails the run
exits non-zero and names the console/MCP env-var route as the manual fallback.
The matcher intentionally has limits: names such as `DB_PASS`, `PWD`, `DATABASE_URL`, `WEBHOOK_URL`, `AUTH`, `PRIVATE_PEM`, `SIGNING_SALT` and `DSN` are not recognized and can be written verbatim. Name secrets with one of the five matched words. Conversely, harmless names containing `key` (such as `KEYBOARD_LAYOUT`) are over-matched; they remain functional because the value is sent in the POST. A concurrent console edit between the live GET and POST can be overwritten because the Catalyst endpoint replaces the full set.

A plan-only run writes the same name-only placeholders; whoever deploys that
tree by hand must set the secret values in the console or through the MCP env
tools before the function runs.

**Migration:** earlier versions wrote every `--function-env` value verbatim
into `catalyst-config.json`. If a generated `--out` tree with real secret
values was committed anywhere, rotate those values and remove them from the
committed file — the next deploy writes only their names.

## Environment variables

The deployed function reads configuration from its environment variables, set in `catalyst-config.json` (`env_variables`) via `--function-env`:

- `C2C_ADMIN_USER`: The Creator application owner's username or email (e.g. `<owner-email>`).
- `C2C_ADMIN_USERID`: The Creator application owner's user id.

Each variable affects only the filters that use it: when `C2C_ADMIN_USER` is unset, report filters on `zoho.adminuser` match nothing; when `C2C_ADMIN_USERID` is unset, report filters on `zoho.adminuserid` match nothing. The runtime never guesses the owner, and these values are never read from a client request.

## Outbound invokeurl (`outboundHosts`)

A live `invokeurl` without `connection:` (a third-party URL) is deny by
default: it is sent only over https to a host listed in `c2c-deploy.json`
`outboundHosts`, e.g. `["api.example.com", "*.hooks.example.org"]`. Every
other call is refused before any request.

- List hosts explicitly. `*.example.com` matches any subdomain of
  `example.com` (not `example.com` itself). A bare `*`, `*.<tld>` or a `*`
  anywhere else is refused with a clear `outbound-config` error on the first
  invokeurl; nothing is sent.
- Redirects are not followed by the transport. A 3xx `Location` is checked
  like the original URL (https, listed host) before it is fetched, for at most
  3 hops. A hop to another origin drops the body and every header (including
  `Authorization` and the `Idempotency-Key`); a cross-origin 307/308 of a write
  is not followed and the 3xx is the reply. Calls through a Catalyst Connection
  never follow redirects.
- The transcript a handler returns masks `Authorization` and any header,
  parameter or query value named like a secret (`auth`, `token`, `secret`,
  `key`, `cookie`, `pass`), URL userinfo, and URL fragments. Refusal messages
  do not echo them.
- Limit: the list is checked by host name, not by resolved address. A listed
  name that resolves to a private, loopback or metadata address (or is rebound
  by DNS) is reached. DNS rebinding is out of scope; list only hosts whose DNS
  you trust.

## Data Store adapter

`c2c-sdk-datastore.mjs` implements the shim datastore interface:

| shim call | SDK call | limit |
| --- | --- | --- |
| `insert(form, rows)` | `datastore().table(form).insertRows` | 200 rows per call |
| `update(form, rows)` | `table(form).updateRows` (every row has `ROWID`) | 200 |
| `delete(form, ids)` | `table(form).deleteRows` | 200 |
| `query(form, where, limit, offset, orderBy)` | `zcql().executeZCQLQuery` | 300 rows |

The query is `SELECT <columns> FROM <form> [WHERE <predicate>] ORDER BY ... LIMIT offset + 1, count`:
`offset` is a 0-based count of rows to skip, but ZCQL `LIMIT` offsets are 1-based
(0 clamps to 1), so the first page reads `LIMIT 1, count`. A ROWID-ordered read
wider than one page continues with `WHERE (<predicate>) AND ROWID > <last>`
(or `<` for DESC) and `LIMIT 1, count`.
ZCQL has no boolean literal predicate, so an always-true read sends no WHERE
clause (the old `WHERE true` was a syntax error) and `false` reads nothing;
`true`/`false` match in any case.
Rows are unwrapped from `{ <Form>: {...} }`. ISO local datetimes from the shims
are written as `yyyy-MM-dd HH:mm:ss`.

Column types come from `c2c-columns.json` (generated from the schema; the entry
passes it with the app time zone, `C2C_APP_TIMEZONE` else `c2c-deploy.json`
`appTimeZone`):

| type | write | read |
| --- | --- | --- |
| Boolean | `true`/`false` -> `"true"`/`"false"` | `"true"`/`"false"` (any case) -> boolean; Data Store returns text and `"false"` is truthy |
| DateTime | `yyyy-MM-dd HH:mm:ss`; a fraction is dropped; a date alone is midnight; an instant (`Z`, `+hh:mm`, a `Date`) becomes wall time in the app zone, and throws with no zone | `yyyy-MM-dd HH:mm:ss[:SSS]` -> `yyyy-MM-ddTHH:mm:ss` |
| BigInt, Foreign Key | digit string | digit string |
| Number (a BigInt Creator number or auto-number, or an Int) | a number or bigint as its digit string | digit text -> JS number; past 2^53 a JS bigint (exact; arithmetic mixing it with a number throws instead of storing a wrong value); NULL stays null |
| Double | as sent | numeric text -> JS number (ZCQL returns a Double as a JSON number already; an insert response pads it, `"12.5000"`) |
| Decimal (an exact-decimal varchar: decimal, percent, currency) | as sent | canonical decimal text, every fractional digit kept |
| Date | as sent | `yyyy-MM-dd` |

A blank typed value reads as null. Stored rows and posted records are read by
the same rules (`c2c-field-values.mjs`).

Posted records: before a form handler runs, the entry reads `body.record` by
the same types (a renamed field by its stored column), so `input.Qty` posted as
`"5"` is the number 5 and `input.Qty + rec.Stock` adds whichever client sent it.
A posted value may also be a JSON number, a Creator `dd-MMM-yyyy` date, or a
date-time without seconds or with a `Z`/offset (converted to app time on the
write). A value that is not its type (`"abc"` in a number field, `5.5` in a
whole-number field, `2026-02-30`) is refused with 400 `{ error, field }` naming
the field; it is never read as NaN, 0 or text. Text fields are never touched
(`"007"` stays `"007"`). Each subform row inside a record is read by its child
table's types the same way; a refused child value names the subform, row and
field (`{ "field": "Lines[1].Qty" }`). A decimal posted as text keeps the digits
that were typed; a decimal posted as a JSON number is written out to the
field's Creator decimal places from the generated write rules (`10.3` with 2
places is `"10.30"`), or its shortest text when the rules give none.

A local run of generated code (`createRuntime` from the shims) reads values the
same way when it is given the function's reader: pass
`fieldValues: createFieldReader({ columns, renames, rules, subforms })` from
`c2c-field-values.mjs` and name the form in `context({ form, record })`. The
record is then read like a posted one and each `seed` row like a stored one, so
a dry run computes what the deployed function computes.

ZCQL returns BigInt and Int columns as JSON strings and Boolean columns as the
text `true`/`false`. Without the `Number` type a generated `rec.Stock + 1` on
a stored 100 is the text `1001`, written back to the row.
Exact decimals (decimal, percent, currency) are varchar and stay canonical decimal
text; the generated code does their arithmetic and comparison exactly. A Date
column stays `yyyy-MM-dd` text, which the date shims compare as a date.

`ROWID` and `CREATORID` are digit strings on every table. A JS number that is not
a safe integer has already lost digits, so it throws on write or read rather
than reach the store or a handler as a wrong id. A table missing from the file
keeps the untyped behaviour. `CREATEDTIME`/`MODIFIEDTIME` are returned as Data
Store sends them (project time zone); converting them is not done yet.

Rate limits: a 429 with `Retry-After` (seconds or an HTTP date) is retried no
sooner than the header asks. If the header asks for more than `RETRY.maxWaitMs`
(60 s), the call fails at once with `datastore: rate limited (429); Retry-After
asks for <n>s, more than the 60s max wait` instead of retrying early. A 429 with
no header is retried after 0.5 s, 1 s, 2 s, 4 s (that backoff alone is capped at
8 s). The fifth 429 is thrown. Other errors are thrown at once.

## Principal model (v1): Catalyst Authentication

Decision: the Slate app signs users in with **Catalyst Authentication**
(embedded login), and `c2c_api` serves only signed-in app users.

1. `slate/c2c-config.js` loads the Catalyst Web SDK 4.6.1 and
   `/__catalyst/sdk/init.js`. With no session the client shows the embedded
   sign-in in `#c2c-login` behind a visible "Sign in to continue." line; a
   frame that never loads leaves a message naming the iFrame fix instead of a
   silent empty box.
2. Each API call carries `Authorization: <token>` from
   `catalyst.auth.generateAuthToken()` (raw token, no prefix) and
   `credentials: 'include'`. Slate (`*.onslate.*`) and the function
   (`*.catalystserverless.*`) are on different domains, so the client calls the
   absolute function URL.
3. `index.js` resolves the user with user scope
   (`catalyst.initialize(req).userManagement().getCurrentUser()`). No user, or a
   role with no matching profile, gets **401** before any handler runs.
4. The role maps to a Creator profile only through `principal-map.json`:
   `App Administrator` to `Administrator` and `App User` to `User`. A Catalyst
   role whose name matches a profile (for example a role literally named
   `Administrator`) is not promoted to that profile; it is unmapped and gets
   **401**, like any role not in the map. To admit another role, add it to
   `principal-map.json` and redeploy the function. The generated handlers then apply the Creator grants (`authorizeWrite`,
   `authorizeRead`, record filters) as before.
5. The handler sees only `{ catalyst: { user: principal } }`. A `user` in the
   body or headers is ignored. Data access uses admin scope, so the server-side
   Creator checks, not Data Store table permissions, decide what a user can do.

Why not public access: the generated handlers write rows and need a profile.
A public function would make every caller the same profile with no audit
trail. Project collaborators in the console are not app users, so the test
user must be added as an app user.

Not yet verified: the exact header the Catalyst gateway
accepts for `generateAuthToken()` tokens on an Advanced I/O call, and whether
the deploy output prints the function URL in the form `functionBaseFrom()`
reads. If the URL is not found, pass `--api-base`.

## Org and project

The org and project are the ones you configure. Nothing is bundled. The first
source that names each one wins:

1. `--org <id>` and `--project <id-or-name>`;
2. `c2c-deploy.json` (`--config`, beside the export, or the cwd) keys `org` and
   `project`;
3. a project registry file (`--projects`): `org`, and the project map (app key
   → id). This file is optional. When it is present, its protected-project
   lists refuse those project ids, and they also refuse a project whose name
   matches a key in either list even when the id stored for that key is
   different. A project id taken from the map is refused when the file's `org`
   is not the org this run resolved;
4. for the org only, the Catalyst CLI login's `active_org` (the decimal id
   only; no token is read).

A project name is resolved by one read-only `GET /baas/v1/project` in that org,
including on a dry run. The plan then prints
`name lookup: one read-only GET /baas/v1/project`. It also prints
`org: <id> (from <source>)` and `project: <name> <id> (from <source>)` before
any write. `--confirm` accepts that pair. Before the first write of a row,
table, function, cron, auth setting, or Slate app, c2c reads
`GET /baas/v1/project/<id>` and refuses unless that body reports the same org
and project. If the name is not in the org, the run stops and tells you to
create the project in the Catalyst console. c2c does not create projects. A
missing org is an error that names the four sources.

Projects on a protected-project list in the registry file passed with
`--projects` are refused, by id or by name. The product does not
bundle a registry: a confirmed run that names a protected id and omits
`--projects` is not refused by one.

```json
{ "org": "<id>", "project": "<id-or-name>", "dc": "<dc>", "mail": { "testRecipients": ["you@example.com"] } }
```

## Test mail recipients

`c2c deploy --mail` enables the guarded mail path, but the recipients come
from your `c2c-deploy.json` `mail.testRecipients`, never from a bundled
address. The default is empty, and an empty list sends to nobody: `--mail`
without `testRecipients` plans `allowlist: ` (blank) and every send decision
is `no test recipients configured`. Each entry must be a mail address;
anything else stops the run before any spawn. The generated
`functions/c2c-mail.mjs` bakes in exactly that list and refuses a
`c2c-mail.json` that differs, so a tampered config still sends nowhere.
A verified Catalyst Mail sender is still required before a confirmed `--mail`
deploy will send. Name it with `mail.from` in `c2c-deploy.json` (or
`--mail-from <address>`); `mail.verified: true` and `--mail-sender-verified`
record your attestation only — the sender counts as verified when a confirmed
deploy reads the state back live (`GET /email`, the same list the
`List_All_Emails_Configuration` MCP tool answers) and Catalyst reports it
`VERIFIED`. The read-back is recorded under `c2c-out/.c2c/mail-sender.json`
(sender tags only, no addresses), and the doctor reports `verified` solely
from that record — the bare attestation shows as `attested`.
The human checklist names the verification-code step (Catalyst console →
Mail → Email Configuration).

## Data centre

The DC is never implicit. `c2c deploy`, `migrate-data` and `smoke` resolve it
from `--dc`, then `c2c-deploy.json` (`--config`, beside the export, or the cwd;
key `dc` or `zohoDc`), then the project registry file's `dc`, then the Catalyst CLI login's
`active_dc`. If none names a DC the run stops before any spawn or fetch:

```
c2c: data centre is not configured; pass --dc <dc>, set "dc" in c2c-deploy.json, or log the Catalyst CLI in to your data centre (catalyst login --dc <dc>). Valid values: us, eu, in, au, jp, ca, sa, ae
```

The plan prints `data_centre: <dc> (from --dc)` (or the config path, the registry
file path, or `catalyst CLI login (active_dc)`), and `c2c-deploy-report.json` has
`dc` and `dcSource`. Seed, source-csv and `--backfill-shadows` write to that
DC's Catalyst API (`https://api.catalyst.zoho.<dc>`, or `zohocloud.ca` for
`ca`) unless `--catalyst-base` overrides it; the mover's host allow-list comes
from the same table (`packages/core/src/dc.ts`).

## Deploy order and resume

`c2c deploy <ds> --project <id> --org <org> --out <dir> --confirm` runs:

1. guards, `catalyst project:list`, project details;
2. the Data Store table diff (creates only what is missing; safe to repeat);
3. `npm install --omit=dev --no-audit --no-fund` in `functions/c2c_api`;
4. `catalyst deploy --only functions:c2c_api -ni`; the printed function URL
   becomes the client API base unless `--api-base` is given;
5. `slate/c2c-config.js` is rewritten with that base, then
   `catalyst slate:link ...` and `catalyst deploy slate <name> -ni`.

Each finished step is recorded in `<out>/.c2c-deploy-state.json` with a digest of
the generated bundle. `--resume` (with `--confirm` and the same `--out`) skips
finished steps when the bundle is unchanged; if the bundle changed, every step
runs again. The table diff always runs.

### Resume after the credential is re-authenticated

```
cd <creator-to-catalyst checkout> && npm run build
X_ZC_CREDENTIAL_PATH=<credential dir> node dist/cli/src/c2c.js deploy \
  <app>.ds \
  --project <project-id> --org <org-id> \
  --projects <registry.json> \
  --out <deploy-dir> \
  --confirm --resume
```

The first run with a new `--out` has no state, so `--resume` simply runs every
step. Add `--api-base https://<project-domain>/server/c2c_api` if the output
prints `warning: no API base`.

## Console steps (done by the user in the Catalyst console)

1. Open your project (`<project-id>`), Development.
2. **Authentication**: deploy already POSTs `/authentication/enable` (hosted +
   embedded, public signup off) and `/cors-domain` (Slate host, CORS on, iFrame
   on — the embedded sign-in frame needs it) — the CLI token cannot read them
   back, so confirm both in the console. An existing domain listed with iFrame
   off needs the console fix: Authentication > Whitelisting > the host > Edit >
   iFrame on.
3. **Functions > c2c_api > Security Rules**: set authentication to **required**.
4. **First admin**: pass `--admin-email`. On a fresh project (no app users
   yet, and `GET /role` refused for the CLI token) the console Add User step is
   the path today: deploy sends no invite and prints one block of exact values
   — Email = the `--admin-email` address, Role = App Administrator, Platform =
   Web, Component = Slate, Slate App = the app, Deployment = default, Redirect
   URL = the Slate app URL. The console picks the role by name, so no role id
   is needed. When the role id is known (`--admin-role-id`, a role-readable
   token, or an existing app user's `role_details`), deploy sends
   `POST /project-user` with the console's Add User fields only
   (`platform_type: "web"`, `redirect_url`, `user_details` email / name /
   `role_id`); a token-side refusal or rejection prints the same values block.
   `first_name` is never sent empty (the server rejects it with 400
   MISSING_PARAM): `--admin-name` wins, and without it deploy derives a name
   from the email local part (`jane.doe@…` → `Jane`, fallback `Admin`). The
   first admin's role is pinned — `--admin-role` accepts `App Administrator`
   only.
   Public signup is not used. After the admin accepts the emailed invite and
   signs in once, a re-run verifies them through `GET /project-user` without
   resending. A `409 DUPLICATE_VALUE` answer means the address already holds
   an invite: `verified` when the per-user read confirms it, otherwise
   `pending` — accept the invite mail and sign in once; never add the same
   address again in the console.
5. **Sign-in check**: open the Slate app URL — the sign-in box must show the
   Catalyst sign-in page, not the app itself or a blank box. A blank box means
   iFrame is off for the host (step 2).
6. Run the deploy resume command above.
7. Save a signed-in browser session for the suite:
   `npx playwright codegen --save-storage=catalyst-auth.json https://<slate-url>`,
   sign in as the test user, close the window.
8. Run the suite:
   ```
   CATALYST_BASE_URL=https://<slate-url> CATALYST_STORAGE_STATE=catalyst-auth.json \
     npx playwright test --config tests/e2e/playwright.config.ts --project=catalyst
   ```

## Offline harness

```
node dist/cli/src/c2c.js deploy <ds> --project ... --org ... --projects ... --out <dir>   # plan only, no spawn
node tools/catalyst-harness/serve.mjs --dir <dir> --port 4183 --live
CATALYST_BASE_URL=http://127.0.0.1:4183 npx playwright test --config tests/e2e/playwright.config.ts --project=catalyst
curl http://127.0.0.1:4183/__exit
```

The harness applies `catalyst-config.json` `env_variables`, requires
`execution.main`, and passes every `/server/c2c_api/...` request to it.
`zcatalyst-sdk-node` resolves to `tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs`
(in-memory tables, a strict ZCQL subset that rejects `WHERE true`). Loading the
page sets a session cookie for one App Administrator user; a request without it
gets 401. It binds 127.0.0.1 only.
