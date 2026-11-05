# Creator Enterprise Caps vs. Catalyst Limits

Code: `packages/deluge/src/schedules.ts` (scheduling plan, sweeper module, known gaps),
`packages/shims/src/long-work.ts` (asynchronous Job deferral, slice engine),
`packages/cli/src/precheck.ts` (static precheck analysis and cap risk warnings),
`packages/schema/src/limits.ts` (budgeted platform limits).
Related docs: `docs/job-scheduling.md`, `docs/large-data.md`.

This document maps Zoho Creator Enterprise plan caps to their corresponding Zoho Catalyst platform limits, identifies where Catalyst's runtime constraints are stricter than Creator's, and specifies the adapter patterns required to prevent migration failures.

---

## 1. Deluge Statement Limit (50,000 statements/action)

### Creator Enterprise Cap
- **Cap**: 50,000 Deluge statements per action execution on Enterprise plans.
  - Free: 5,000 statements
  - Standard: 10,000 statements
  - Professional: 20,000 statements
  - Enterprise: 50,000 statements
  - Blueprint transitions: 50 statements
- **Sources**:
  - Zoho Creator Pricing Comparison: https://www.zoho.com/creator/pricing-comparison.html
  - Zoho Creator Limitations (Developer Guide): https://help.zoho.com/portal/en/kb/creator/developer-guide/limitations
- **Creator Failure Behavior**: Exceeding the statement limit raises `Number of statement execution limit exceed` and halts execution. In form actions (such as `on success` scripts or subform row inserts), Creator exhibits a partial-failure defect: the record itself is committed (`code 3000 "Data Added Successfully"`), but the `on success` script rolls back completely, leaving an inconsistent state.

### Mapped Catalyst Limit
- **Statement Counter**: Catalyst does **not** count or cap JavaScript/Node.js statements (`Node stops on time and memory, not statements`). There is no statement limit in Catalyst.
- **Function Execution Time**:
  - **Advanced I/O / AppSail requests**: **30 seconds** (`[DOC][TESTED]`, https://docs.catalyst.zoho.com/en/serverless/help/functions/execution-limits/, `function.timeout_seconds` in `packages/schema/src/limits.ts`). This limit is non-raisable. If execution exceeds 30 s, the platform returns HTTP `408 EXECUTION_TIME_EXCEEDED` or terminates the request.
  - **Job functions**: **15 minutes** (`[DOC]`, `job.timeout_minutes` in `packages/schema/src/limits.ts`).
- **Function Memory**: Typically 256 MB or 512 MB default per function configuration (`GET /baas/v1/project/<project-id>/function/<function-id>`).
- **Authoritative Number Status**: Authoritative numbers exist and are verified for Catalyst function timeouts (30 s Advanced I/O, 15 min Job functions) and the absence of any statement-count limit.

### Where Catalyst is Stricter & Migration Restructuring Required
- **Where Catalyst is stricter**: In raw statement count, Catalyst is more permissive (no statement counter). However, in **execution time on the synchronous request path**, Catalyst is stricter. Creator permits Deluge scripts up to 40 seconds (and background workflows even longer). In Catalyst, all HTTP request handlers, form submissions, and custom API endpoints run inside Advanced I/O functions with a hard 30-second cut.
- **Migration Restructuring**:
  - A Deluge script executing near the 50,000 statement cap—especially scripts containing nested loops, multi-table queries, external `invokeurl` HTTP requests, or `sendmail` iterations—risks exceeding Catalyst's 30-second wall-clock timeout if executed inline.
  - **Restructuring pattern**:
    1. Long work must be offloaded from the request path using `runOrDefer` (`packages/shims/src/long-work.ts`). The handler answers HTTP **202 Accepted** with `{ work_id, state, poll }` and a `Location: /c2c/work/<work_id>` header, enqueuing an asynchronous Job (`submitJob`).
    2. The Job function runs the execution in slices bounded by `JOB_SLICE_MS` (12 minutes, safely within the 15-minute Job function limit).
    3. State and cursors are checkpointed after each step; if additional work remains, the Job resubmits itself under the same `work_id` until completion.
    4. Client callers poll `/c2c/work/<work_id>` until status is `done` or `failed`.

---

## 2. Custom Schedules Quota (600 schedules/user/month)

### Creator Enterprise Cap
- **Cap**: 600 custom schedules per user per month on Enterprise plans.
  - Free: Not supported
  - Standard: 90 custom schedules / user / month
  - Professional: 300 custom schedules / user / month
  - Enterprise: 600 custom schedules / user / month
- **Sources**:
  - Zoho Creator Pricing: https://www.zoho.com/creator/pricing.html
  - Zoho Creator Pricing Comparison: https://www.zoho.com/creator/pricing-comparison.html
- **Creator Failure Behavior**: Quotas are pooled across account users per month (e.g., 10 Enterprise users = 6,000 monthly executions). Form-based schedules (schedules running on date fields) count **one execution per record per run**. When the monthly quota is exhausted, **all schedules across the entire account stop executing** until the quota resets at the next monthly cycle.

### Mapped Catalyst Limit
- **Cron Quota**: Catalyst Job Scheduling documentation (https://docs.catalyst.zoho.com/en/serverless/help/job-scheduling/) states **no cron-count limit** and **no monthly schedule execution quota**.
- **Authoritative Number Status**: Explicitly unstated: Catalyst does **not** publish an authoritative numeric ceiling for total crons or monthly cron execution counts.
- **Catalyst Scheduling Mechanics**:
  - **Execution interval**: Minimum 1 minute between runs (`[DOC]`).
  - **Cron types**: `CronExpression`, `Periodic`, `OneTime`.
  - **Target**: Crons target Job functions (`c2c_jobs`).
  - **Job pool**: 1 pool per application; pool names allow only alphanumeric characters (hyphens and underscores rejected).
  - **Form Schedule Sweeper**: Catalyst has no native record-date-based form scheduler. c2c translates all form schedules into a single sweeper Job running on a 5-minute Periodic cron (`SWEEP_PERIOD_MINUTES = 5`) targeting `functions/job/c2c-form-sweeper.mjs`.
  - **Sweeper Budget**: The sweeper stops after 4 minutes (`SWEEP_BUDGET_MINUTES = 4`) to prevent overlapping executions with the next 5-minute tick.

### Where Catalyst is Stricter & Migration Restructuring Required
- **Where Catalyst is more permissive**: Catalyst has no monthly schedule execution quota. An app that sweeps thousands of records will never trigger an account-wide shutdown of all schedules mid-month.
- **Where Catalyst is stricter / differs**:
  - **Execution Granularity**: Form schedules fire on the first 5-minute sweep tick after their due time, introducing up to 5 minutes of latency compared to Creator's 1-minute trigger resolution.
  - **Sweeper Time Budget**: In Creator, form schedules run independently per record. In Catalyst, all form schedules across the application share one sweeper execution bounded by the 4-minute time limit.
  - **Restructuring pattern**:
    1. Form schedules page records through ZCQL in batches of 300 (`ROWID > cursor ORDER BY ROWID`).
    2. Checkpoints (`C2CJobCheckpoint`) record progress after every page.
    3. If an application contains numerous form schedules or tens of thousands of active records, a single sweep cannot exceed 4 minutes. Records not completed within 4 minutes are checkpointed and deferred to the next 5-minute window.
    4. Migration analysis must verify that record volumes per 5-minute interval fit within the sweeper's 4-minute processing window.

---

## 3. Comparison Matrix

| Feature / Cap | Zoho Creator Enterprise Cap | Catalyst Mapped Limit | Which is Stricter | Migration Impact / Restructuring |
|---|---|---|---|---|
| **Deluge statements per action** | 50,000 statements / execution (`https://www.zoho.com/creator/pricing-comparison.html`) | No statement counter (`Node stops on time and memory`) | Creator (on statement count) | Catalyst will not halt execution on raw statement counts. |
| **Request execution timeout** | 40 s script timeout (longer in background) | 30 s hard cut for Advanced I/O / AppSail (`[DOC][TESTED]`) | **Catalyst** (on request time) | Work approaching 50k statements or >20 s must be offloaded to Job functions via `runOrDefer` (202 + poll). |
| **Background job timeout** | Handled via asynchronous tasks | 15 min per Job function (`[DOC]`) | Comparable | Long jobs must chunk work into 12 min slices (`JOB_SLICE_MS`) with checkpoints. |
| **Custom schedules quota** | 600 / user / month (`https://www.zoho.com/creator/pricing.html`) | No published cron-count or monthly run limit (`[DOC]`) | Creator (on monthly runs) | Converted apps are not throttled or shut down by monthly execution quotas. |
| **Form schedule execution** | Evaluated per record per run against monthly quota | Batched into 1 sweeper Job every 5 min on a Periodic cron | **Catalyst** (on granularity and 4 min sweeper budget) | Firing can lag up to 5 min; high-volume sweeps page 300 rows via ZCQL and checkpoint across 5 min ticks. |
| **Minimum cron frequency** | 1 minute | 1 minute (`[DOC]`) | Identical | 1-minute minimum interval preserved. |

---

## 4. Adapter Honesty and Diagnostics

1. **`job-scheduling.json`**: Emitted by `packages/deluge/src/schedules.ts`. The `knownGaps` array explicitly carries both `creator-schedule-quota` and `deluge-statement-limit`, linking the Creator Enterprise limits to their respective Catalyst behavior and sources.
2. **`c2c precheck`**: Flags static migration risks:
   - `statement-limit-risk`: Warns on functions or workflow scripts with large statement counts (>= 5,000 statements), highlighting the 50k Enterprise cap and the risk of exceeding Catalyst's 30 s Advanced I/O timeout.
   - `schedule-quota-risk`: Warns on applications defining >= 600 schedules, highlighting the Creator Enterprise monthly quota and the Catalyst 5-minute sweeper budget.
