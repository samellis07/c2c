# Operations checklist

Day-2 checklist for a converted app and for this repo itself, built from what
the code and rules actually support today. Items the repo does not support are
marked **[gap]** — treat them as console steps or missing tooling, not as
things c2c does quietly.

Everything here assumes the deployment is a Catalyst project produced by
`c2c deploy` / `c2c provision` — one Advanced I/O function (`c2c_api`), a
Data Store schema, optional Slate web client — and that `<dc>`, `<org-id>`,
`<project-id>` resolve from `c2c-deploy.json` and the CLI context.

## 1. Logging

- [ ] Generated handlers log errors with context — never secrets or record
  values (rule: `plugin/references/facts/functions.md`). Keep it that way: a
  handler that logs nothing shows only `info "Execution started at: …"` in the
  logs, and a swallowed server failure surfaces only as
  `500 {"dryRun":true,"error":"request failed"}`.
- [ ] Read function logs through MCP `Get_Logs` (filters: resource, function,
  severity, date, paginated; rule: `plugin/references/facts/functions.md`).
  Plan checks by filter, not by scrolling.
- [ ] Console path: DevOps → Logs → Application, which reads
  `GET /baas/v1/project/<project-id>/logs?logType=application&resource_list=<function-id>`
  and filters by Log Type (Access/Application), Resources, Date/Time zone and
  Keyword, with a Configure Alert action (rule:
  `plugin/references/facts/functions.md`).
- [ ] Indexing lag: console notice ("Log messages for the last 5 mins may not
  be indexed"; unverified platform lag cited in
  `plugin/references/facts/functions.md`) — log every failure inside the
  handler instead of relying on a later read.
- [ ] Retention is short (unverified rule: about 7 days in Development, 14 in
  Production; cited in `plugin/references/facts/functions.md`,
  `packages/deploy/src/status.ts`) and entries truncate around 1500 chars
  (unverified; cited in `plugin/references/facts/functions.md`) — log early,
  concise and once per failure.
- [ ] **[gap]** No log shipping or long-term archival exists; if retention
  matters beyond the unverified ~14-day Production window
  (`plugin/references/facts/functions.md`), that is a console/export step the
  operator owns.

## 2. Monitoring & alerts

- [ ] DevOps (APM, alerts, logs) is an opt-in console service: the first open
  issues `PATCH /baas/v1/project/<project-id>/service`
  `{"service":"DevOps"}`; the project services list then carries DevOps (rule:
  `plugin/references/facts/projects.md`).
- [ ] APM starts from "Enable now" and covers Basic I/O, Job, Event and
  Advanced I/O invocations — enable it in the console per environment (rule:
  `plugin/references/facts/projects.md`).
- [ ] Alerts send email when a cron or an event listener's execution is not
  successful, or for specific logs search results — configured in the console
  (rule: `plugin/references/facts/projects.md`).
- [ ] Never depend on APM or alerts in generated code or plans. The IaC
  template's `ApplicationAlerts` component stays empty until the user
  configures alerts in the console; read build/runtime failures through
  `Get_Logs` / the DevOps console (rule:
  `plugin/references/facts/projects.md`).
- [ ] **[gap]** No uptime or synthetic monitoring of the Slate app or
  `c2c_api` endpoints is generated; nothing here pages anyone.

## 3. Backups & recovery

- [ ] Project template export:
  `POST /baas/v1/project/<project-id>/export`, poll
  `GET …/export/status` until `Completed`, then `GET …/export/download`.
  `catalyst iac:export` accepts only `--production` besides the default
  environment (rules: `plugin/references/facts/projects.md`).
- [ ] The Creator source export (.ds) is the durable input — keep it; every
  generated tree is regenerable from it (see §7).
- [ ] **[gap]** No Data Store row export/backup is generated or scheduled.
  Loaded data lives in Catalyst tables; a table-level export or scheduled
  backup is a console step or missing tooling — do not claim one exists.
- [ ] **[gap]** No restore drill is defined. Re-running `c2c` reconciles a
  fresh project from source (seed/migrate dedupe by `c2c_source_id`), but a
  "restore rows to the same project" path is not a c2c feature.

## 4. Development vs Production

- [ ] Admin calls default to `X-CATALYST-Environment: Development`; the
  header is per-call, never assumed (rule:
  `plugin/references/facts/projects.md`).
- [ ] Schema writes are Development-only: `POST /table` and
  `POST /table/<table-id>/column` under the Production header return
  `406 INVALID_OPERATION` (rules: `plugin/references/facts/projects.md`,
  `plugin/references/facts/datastore.md`, `plugin/references/facts/errors.md`).
  Plan table/column creation against Development; load rows straight into
  Production after console promotion.
- [ ] Production enable, diff, migrate and disable are guided console steps —
  there is no API or CLI path; the operator performs them (rules:
  `plugin/references/facts/projects.md`).
- [ ] Social-login client secrets apply to Development only — re-enter them
  in Production after promotion (rule: `plugin/references/facts/projects.md`).
- [ ] App-user capacity differs: assume ~25 app users in Development,
  ~1000 in Production (unverified rules: `plugin/references/facts/limits.md`,
  `plugin/references/facts/auth.md`, check `D-F6` in
  `packages/doctor/src/checks.ts`; raisable by the customer). `c2c doctor` /
  `c2c plan` reads the reported limit before invites.
- [ ] While Production is enabled, project delete is refused
  (`400 INVALID_OPERATION`; rules: `plugin/references/facts/projects.md`,
  `plugin/references/facts/errors.md`); the operator disables Production in the
  console first. Do not delete a project you still need.

## 5. CI/CD (this repo)

- [ ] CI workflow (`.github/workflows/ci.yml`) runs on PRs and pushes to `main`,
  on Node 20.20.1 and 22: `npm ci`, React template `npm ci --prefix
  packages/ui-react/template`, then `npm run check` (defined in `package.json`:
  build, tests, hygiene, determinism gate). It is offline — no secrets, no
  network beyond `npm ci`; fixture-dependent tests skip when `C2C_FIXTURES_DIR`
  / `C2C_GALLERY_DIR` are unset.
- [ ] CI vendors the plugin twice and compares `MANIFEST.sha256` to check
  repeatability. It also checks plugin versions and hygiene, runs the shipped
  licence gate, and validates plugin and marketplace manifests
  (`.github/workflows/ci.yml`). The hygiene scan checks for machine paths,
  non-placeholder email addresses and long numeric ids; it is not a configured
  organization-secret denylist (`scripts/vendor-plugin.mjs`).
- [ ] Security scanning: `.github/workflows/codeql.yml` runs CodeQL.
- [ ] Local equivalent before handing off: `npm test` plus
  `npm run determinism:check` (or `npm run check` for both; scripts defined in
  `package.json`).
- [ ] **[gap]** No deployment pipeline for converted apps — deploys are
  operator-run `c2c`/`catalyst` commands against a signed-in CLI, not a CI
  job, and must stay that way (the CLI credential allows exactly one
  refresher — see §6).

## 6. Secrets & credentials

- [ ] One CLI credential, one refresher: Zoho rotates the refresh token on
  every refresh, so two processes sharing one credential break it for both.
  Serialize CLI use per credential; never run a background keep-fresh loop
  beside a run; keep a single login per workspace. On a read-only
  `401 INVALID_TOKEN`, re-read the stored token first — a forced local
  refresh is opt-in (`C2C_ALLOW_LOCAL_REFRESH=1`; rules:
  `plugin/references/facts/projects.md`, `plugin/references/facts/errors.md`).
- [ ] `GET /baas/v1/project` returns more than the target project — the
  listing carries other projects' authentication secrets (rule:
  `plugin/references/facts/projects.md`). Record only the target project's
  `id` and `project_name`; never write the raw listing to disk, a log or
  `c2c-deploy.json`.
- [ ] Function environment: `catalyst deploy` **replaces** the function's
  console environment with `env_variables` (rule:
  `plugin/references/facts/functions.md`). A live deploy needs
  `--function-env <file>` carrying every existing key
  (`C2C_MAIL_FROM`, `C2C_ZOHO_DC`, `C2C_OWNER_APPROVAL_TOKEN`,
  `C2C_APP_TIMEZONE`, …; source: `packages/deploy/src/cli.ts`). Keep that file
  outside the repo — values may be secrets; only key names are ever printed.
- [ ] Outbound `invokeurl` without `connection:` is deny-by-default: https
  only, to hosts listed in `c2c-deploy.json` `outboundHosts`; redirects are
  re-checked per hop (≤3; source: `MAX_REDIRECTS` in
  `packages/shims/src/invoke-url.ts`, `packages/shims/src/outbound.ts`) and a
  cross-origin hop drops body and headers.
- [ ] Handlers never log secrets or record values (§1; rule:
  `plugin/references/facts/functions.md`). Keep credentials outside the repo;
  the CI plugin hygiene scan checks plugin files for machine paths, real email
  addresses and long numeric ids (`scripts/vendor-plugin.mjs`).

## 7. Safe regeneration

- [ ] Generated output is deterministic: `bash tools/determinism-gate.sh`
  regenerates every committed fixture twice in fresh processes and fails on
  any byte difference; `npm run determinism:check` (defined in `package.json`)
  verifies the committed manifests. Run it before treating a regeneration as safe.
- [ ] Regenerate committed determinism manifests with
  `npm run determinism:update`, then verify them with
  `npm run determinism:check`. Rebuild the plugin vendor tree with
  `node scripts/vendor-plugin.mjs`; CI checks that repeated runs produce the
  same manifest (`package.json`, `.github/workflows/ci.yml`).
- [ ] Re-runs reconcile, not duplicate: seed/migrate dedupe by
  `c2c_source_id`; a deploy re-run that finds stored raw ids corrects them;
  `--backfill-shadows` is resumable and safe to re-run; a template import
  re-run reads the existing import instead of creating a second project
  (rules: `plugin/references/facts/projects.md`, `packages/deploy/src/cli.ts`).
- [ ] Project create/update is all-or-nothing at the API level: apply
  templates only to a new project; each import consumes a project slot —
  never import throwaway projects (rule:
  `plugin/references/facts/projects.md`).
