# 6. Troubleshooting

When something goes wrong, **paste the exact error text into the
chat** — the AI looks it up in its
[error index](../../plugin/references/error-index.md) (matched by
substring against [facts/errors.md](../../plugin/references/facts/errors.md)),
confirms the cause with a read-only check, and only then fixes or
asks you. Never delete things to "start clean": every step resumes
where it stopped. Where this chapter states a platform number, it
says how solid it is: **proven** (seen in testing),
**documented** (in the platform docs), or **not yet proven**
(assumed until a probe proves it).

## Exit codes: what the number means

Every c2c command finishes with an exit code: `0` means it
worked, anything else means something specific. This is the
complete list — find your number, then do the step next to it.
(You can paste the number and the last lines of the output into
the chat and the AI takes it from there.)

| Code | What it means | What to do |
|---|---|---|
| 0 | OK | Nothing — the step finished. |
| 1 | Findings or blockers in the report, a failed step, or drift (something missing or changed); for every command except `precheck`, `cutover-checklist`, `proof` and `iac-drift`, also an export file that was not found | If the output says "no such file or directory", check the path to the `.ds` file. Otherwise read the report file named in the output and fix what it lists, starting with anything marked blocking. |
| 2 | Usage error, a locked Marketplace export, a refused TODO fill, or drift that is only extra items | Usage: read the usage line; most often a missing option such as `--project`, `--org`, or `--out` — the AI corrects the command. Locked Marketplace export: this app cannot be converted; ask the app's vendor for the source `.ds` or an unlocked copy. Refused TODO fill: the message names the TODO; tell the AI. Extra items only: Catalyst has items the plan does not list and nothing is missing; decide whether to keep them. |
| 3 | An input file that was not found or could not be read, for `precheck`, `cutover-checklist`, `proof` and `iac-drift` (including a template that is not valid JSON) | Check the file path — the file is not where stated. For `iac-drift`, export the template again. |
| 4 | `precheck`: the file is not a readable Creator export; `smoke`: waiting for you to do the check in your own browser | `precheck`: re-export the app from Creator (app → Settings → Export) and try again. If Creator's own export comes out blank, tell the AI — one component in the app is breaking the export. `smoke`: open the page the output names, signed in to the app, wait for Done or Failed, and paste the result code into the chat. |
| 5 | Doctor gate: a `--confirm` command was refused because the environment check is not green, current, or same-scope | This is a safety stop, not a failure in your app: ask the AI to run the doctor check and follow the fix printed next to each failed check (see "The doctor is red" below). |
| 6 | Node or plugin integrity problem | The tool installation itself has a problem (the wrong Node version or a damaged install). Tell the AI — it needs Node 20 or 22, or the plugin reinstalled. |

## First thing to attach: `c2c support-bundle`

When pasting an error or escalating a failed step, the **first thing to attach** is an offline diagnostics bundle:

```bash
c2c support-bundle --out support-bundle.json [--force] [--app <name>] [--stderr-file <file>]
```

- It is strictly **offline and read-only** (no creates, no account or network calls; the only write is `--out <file>`).
- `--out <file>` must not already exist (pass `--force` to overwrite), and its parent directory must already exist with no symlinked component. `--stderr-file` is capped at 256 KB (marked `truncated` when it exceeds the cap).
- It collects the workspace `c2c doctor` JSON (`c2c-out/.c2c/doctor.json`) or its gate refusal, the allow-listed deploy, plan, provision, verify, parity, fidelity, smoke, and proof reports under `c2c-out/<app>/`, the CLI + plugin + Node versions, and the failing command's stderr (from `--stderr-file <file>` or `c2c-out/.c2c/last-stderr.log`), then prints a manifest of every included item.
- It redacts by **allow-list** (only named report files and named fields are included) plus a string redaction pass so the bundle never contains tokens, credentials, OAuth/refresh tokens, `~/.c2c/<app>-function-env.json` or `function-env.json` values, customer row data, or emails.

## The doctor is red

The doctor prints the exact fix next to each failed check
([doctor spec](../../plugin/references/doctor-spec.md)).
The usual suspects:

- **Connector not signed in** — only sign-in tools are visible in
  the AI's tool list. You finish the Zoho sign-in in the browser.
- **Wrong data centre or account** — the connector or CLI points at
  a different data centre than your Catalyst account, or at an
  account that cannot see your organisation. Sign out, sign back in
  with the owning account.
- **CLI not signed in** — you run the browser sign-in for the CLI.
- **No free project slot** — 50/50 projects used (documented:
  cap of 50 [DOC](https://docs.catalyst.zoho.com/en/cli/v1/initialize-resources/initialize-new-project/) —
  [limits.md#projects-per-account](../../plugin/references/facts/limits.md#projects-per-account)).
  Delete an unused project in the console, or ask Catalyst support
  to raise the limit.
- **Target project holds another app's tables** — use a fresh
  project for this app. Merging two apps into one project is refused
  (proven in testing: the second app's tables would merge into the
  first app's —
  [doctor-spec.md#f-target-org--project-budget](../../plugin/references/doctor-spec.md#f-target-org--project-budget)).

## First-use service gates

- **"Please access the Slate service in your project's console
  before deploying via the CLI"** — only an older Catalyst CLI says
  this; a current one links and deploys Slate on a new project with no
  console visit. Update the CLI, or as a fallback open the project →
  Slate → Start Exploring once, then the AI re-runs the deploy.
- The same one-time console visit can apply to file storage or PDF
  making: if a read-back fails there on a brand-new project,
  the AI asks you to open that service once, then re-checks.

## "Authentication required" and sign-in errors

- **`sign in required` / a 401 on your user page** — you are simply
  not signed in yet. Sign in at the app address ([your step
  3](04-your-five-steps.md)).
- **No access on an app address with no sign-in** — this one is
  *good news*: it proves the app's "sign-in required" rule works.
  The AI checks this one itself with a session-free probe.
- **Invite fails while public signup is off** — the AI must send
  an admin invite, never flip public signup on as a shortcut. If
  the invitee lands on a dead `/app/` page, the invite went out
  without the app address — tell the AI.
- **Repeated sign-in attempts failing** — stop trying. Too many
  attempts can trip a throttle that can stay in place for many
  hours (not yet proven —
  [limits.md#url-throttle](../../plugin/references/facts/limits.md#url-throttle);
  the safe move is to wait).

## How to call your API and how the generated pages authenticate

Your app's API (the `c2c_api` function) is **private on purpose**. Calling
its address with no token answers `401 NO_ACCESS`. That is the security
rule working: only a signed-in app user may call it. Do not open it to
the public to make a test pass.

**The generated pages need nothing from you.** They sign the user in,
then send that user's token as the `Authorization` header on every call
to the API (raw token, no `Bearer ` prefix). A page that is not signed in
shows the sign-in screen; a refused token ends the session and returns to
sign-in.

**To call the API yourself (a script, a test, a quick check):**

1. **Enable Authentication on the project.** Catalyst console → your
   project → Authentication → Enable. Public signup stays **off**.
2. **Add an app user.** Authentication → User Management → Add User,
   role *App User* (or *App Administrator*), and the app address as the
   redirect URL. Accept the invite email and set a password.
3. **Sign in once** at the app address so the user has a session.
4. **Get the user's token.** In the signed-in browser tab, open the
   developer console and run `await catalyst.auth.generateAuthToken()`;
   the token is the `access_token` in the answer. Treat it as a password:
   do not paste it into a chat or commit it. It expires, so get a fresh
   one when a call returns 401.
5. **Find the invoke URL.** Console → Functions → `c2c_api`; it ends in
   `/server/c2c_api`.
6. **Send the token** as the `Authorization` header, for example:
   `curl -H "Authorization: $TOKEN" "<invoke URL>/reports/<Report>?page=0&pageSize=1"`.
   A `200` with a `rows` list is a good read-back.

**Checking it from the repo:** keep the token in an environment variable
and run
`C2C_APP_USER_TOKEN=... node tools/catalyst-harness/api-readback.mjs --project <name> --invoke-url <invoke URL>`.
It prints `c2c_api read-back ok` on a 200 and a one-line reason on a
401 (token rejected or missing, Authentication off, or an expired token).

## Quota and "too many requests" waits

- **429 / "concurrency limit reached"** — the platform is busy; the
  AI keeps to 10 parallel calls (the platform's own limit is not
  yet proven —
  [limits.md#concurrent-data-store-calls](../../plugin/references/facts/limits.md#concurrent-data-store-calls))
  and honours the wait it is told.
- **"You have reached the max limit of your current API limit"** —
  stop creating, keep what was created, and retry later with growing
  waits (proven in testing: the table-create refusal persists, even
  after project deletes —
  [limits.md#tables-per-organisation](../../plugin/references/facts/limits.md#tables-per-organisation);
  the AI retries after 30, 60, then 120 minutes; row caps are not
  yet proven —
  [limits.md#rows-per-development-table](../../plugin/references/facts/limits.md#rows-per-development-table)).
  Deleting a project may not free capacity immediately.
- **Creator-side "you have reached your API call limit"** — same
  idea on the Creator side during exports; wait, then resume. Never
  call Creator from the new app's code on every click (not yet
  proven: assume about one call a minute —
  [limits.md#creator-calls-from-a-catalyst-function](../../plugin/references/facts/limits.md#creator-calls-from-a-catalyst-function)).

## If the AI says "unverified: needs a probe"

That is the honest answer, not a dodge: the behaviour has no proven
route, so the AI proposes a tiny scratch-resource test (created,
measured, deleted) and asks your permission first. Say yes or no —
either is fine; "no" just records the assumption as a TODO.
