# Schedules → Catalyst Job Scheduling

Code: `packages/deluge/src/schedules.ts` (plan, config, sweeper module) and
`packages/shims/src/jobs.ts` (sweep engine).

## What is generated

| Creator | Catalyst | Generated |
|---|---|---|
| Custom schedule, `start = "<date time>"` + `frequency = daily / weekly / monthly / yearly` | Pre-defined cron, `CronExpression` | `functions/job/<schedule>.mjs` exports `cron`; the cron is listed in `job-scheduling.json` |
| Custom schedule with no `frequency` | Pre-defined cron, `OneTime` at the start instant in the schedule time zone | same |
| Form schedule, `form = X[criteria]` + `start = [before/after N minutes/hours/days/weeks from] Field [at "HH:mm:ss"]`, optional `frequency` and `end = Field` | One `Periodic` cron per app (every 5 min) → sweeper Job | `functions/job/<schedule>.mjs` exports `sweep`; `functions/job/c2c-form-sweeper.mjs` runs them all |

Names are deterministic. A cron and job name is `c2c_<schedule>`, with every run of characters
other than `[A-Za-z0-9]` replaced by `_`, because Catalyst rejects hyphens. Duplicates get `_2`, `_3`, … in
workflow order. The job pool is the app name with non-alphanumerics removed, because pool names reject `_`.
Every cron targets one Job function, `c2c_jobs`. `job_meta.params.module` names the file.

A shape that does not convert gets no cron. Instead it is a TODO (`schedule-start`, `schedule-frequency`,
`schedule-time-zone`) in `migration-report.json`. The generator never guesses a cron. Across a corpus of sample Creator apps (not included),
39 apps have schedules: 13 crons (11 CronExpression, 2 OneTime) and 63 form schedules across 35 sweepers, with 0 gaps.

## Sweeper

On each tick the sweeper does this for every form schedule:

1. Read the checkpoint row from `C2CJobCheckpoint` (`Job_Key`, `State` JSON). The checkpoint holds a watermark. After a run that stopped early, it also holds the pending window end and a ROWID cursor.
2. Page ZCQL 300 rows at a time with `ROWID > cursor ORDER BY ROWID`. The query is narrowed by a date window on the field (±2 days of slack), the end field and the schedule criteria.
3. Fire `handle(ctx)` with `ctx.record = row` for each row whose exact fire instant is in (watermark, until].
4. Save the cursor after each page. Save the watermark when the window ends.

A run stops after 4 minutes. That is below the 5-minute period, so two sweeps never overlap. The next tick resumes the pending window. After a row fires, the sweep marks its due occurrences in the checkpoint table (per schedule and record), so a crash inside a page resumes without refiring the rows already fired; only a crash between a fire and its mark can refire that one row. A first run with no checkpoint looks back one period and does not backfill.

## Live switch

Every job module and the sweeper are dry runs unless **both** are true:

- deploy mode is `live`: `c2c-deploy.json` has `"mode": "live"`, or `C2C_DEPLOY_MODE=live`;
- a datastore is configured: `c2c-store.mjs` `getDatastore()`, or the injected `globalThis.__c2cDatastore`.

If mode is live and no datastore is configured, the job throws before any write. Tests
(`packages/deluge/test/schedules.test.ts`) put tripwires on `fetch` and on the datastore. They prove that no call happens without the
switch.

A Catalyst Job function must close its context. The generated `default` export calls
`context.closeWithSuccess()` or `closeWithFailure()`.

## Known gaps

`job-scheduling.json` `knownGaps` carries these with their sources:

- **Creator custom-schedule quota.** Creator allows 90 / 300 / 600 custom schedules per user per month (Standard / Professional / Enterprise). Source: https://www.zoho.com/creator/pricing.html. Catalyst Job Scheduling states no cron-count limit.
- **Form-schedule runs.** Creator counts a form schedule per record per run, and all account schedules stop when the quota runs out.
- **Sweep granularity.** A form schedule can fire up to 5 minutes late. A repeating form schedule with several occurrences in one window fires once.
- **Cron time zone.** Whether Catalyst evaluates a CronExpression in the project time zone is not verified. The Creator zone is kept in `c2c.timeZone`.
- **Start date.** A repeating custom schedule starts at deploy, not at the Creator start date. A OneTime cron in the past never fires.
- **Deploy.** The deploy table steps create `C2CJobCheckpoint` for an app with a form schedule. `c2c deploy` writes and deploys the `c2c_jobs` Job function (see Deploy tree below); the pool and the crons are `c2c provision` steps (`jobpool`, `crons`).

## Deploy tree

An app with schedules gets `functions/c2c_jobs/` next to `functions/c2c_api/`, and `catalyst.json`
lists it as a function target. An app without schedules gets neither, and its tree is unchanged.

- `catalyst-config.json`: `type: "job"`, the same stack and environment variables as `c2c_api`.
- `index.js` (`packages/deploy/fn/jobs.js`): reads the `module` job parameter and runs that file only if a cron in
  `job-scheduling.json` names it. Any other value closes the job with failure and loads nothing.
  The datastore is the admin-scope SDK adapter, initialized from the job context.
- The job modules and every file they import, at the same paths as in `c2c_api`, plus the vendored shims.
  HTTP handlers, routes and the principal resolver stay out.
- `job-scheduling.json`: the pool, crons and sweeper the generator wrote.

`c2c deploy` runs `npm install` in `functions/c2c_jobs` and deploys it right after `c2c_api`, then reads
the project function list back and records the `c2c_jobs` id (`jobsFunctionId` in the deploy state). A
deploy whose `c2c_jobs` is not in that list stops there with the resume command.

A new-project plan imports `c2c_jobs` too: the import template lists it as a `job` function and
`provision/iac/functions/c2c_jobs.zip` holds the same tree. An app without schedules imports `c2c_api` only.

The `crons` provision step names its target by id (`target_id: <function-id:c2c_jobs>` in
`provision/crons.json`). Before any cron POST it reads the project function list; when `c2c_jobs` is
not deployed it posts nothing and names the next step: run `c2c deploy --confirm`, then re-run
`c2c provision --run crons --confirm`.

## Not yet generated

The engine for work past the request cut is in `packages/shims/src/long-work.ts` (`runOrDefer`,
`runWorkSlice`, `pollWork`; see `docs/large-data.md`): the handler answers 202 with a poll path and an
immediate Job (`submitJob`) runs the work in checkpointed slices. Batch workflows and long actions are not
generated onto it yet.
Flows, approvals and custom functions keep their hard-coded `dryRun: true`.
