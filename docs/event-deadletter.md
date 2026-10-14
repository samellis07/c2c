# Async on-success and the event dead-letter

Opt-in (`c2c deploy --async-on-success`). Catalyst event functions have no
documented automatic retry: when an event execution fails, Catalyst records the
event as failed and does not run it again. The generated async lane therefore
pairs the after-commit event function with a failure-marker table and a sweep
Job, so a failed on-success run is retried instead of lost.

Without the flag nothing changes: generated output is byte-identical, no
`functions/events/` tree exists, no support table is created, and the submit
endpoints run on-success scripts inline as before.

## What the flag emits

- `functions/events/after-commit.mjs` — the Catalyst Event function. It reads
  the trigger payload `{data{row,table_details},action,event_time}`, selects
  the same on-success modules the submit endpoint deferred (per form, add and
  edit scope only), reloads the committed row by id, and runs them. Deletes
  stay synchronous in the delete endpoint; this lane never serves them.
- `functions/c2c-deadletter.mjs` — the marker store shared by the event
  function and the sweeper.
- `functions/job/c2c-event-sweeper.mjs` plus a `c2c_event_sweeper` cron entry in
  `job-scheduling.json` — a 15-minute periodic Job with a 14-minute execution
  budget, so two sweeps never overlap inside Catalyst's 15-minute limit.
- The `C2CEventDeadLetter` and `C2CEventProcessed` support tables, created by
  the deploy only when the app emits event functions (see docs/table-budget.md).

## What may defer

Only fire-and-forget on-success work defers. Generation classifies every
on-success workflow and refuses the flag with `AsyncOnSuccessRefusedError`
(code `ASYNC_ON_SUCCESS_RESPONSE_SENSITIVE`), naming each workflow, when one:

- can `cancel submit` (changes the reply status);
- has client actions — `info`, `alert`, `openUrl`, show/hide (user-visible);
- returns a value (becomes the reply `result`);
- writes the triggering record (becomes the reply `values`).

Mail, notifications, reads and cross-form store writes defer; the completion
ledger below fences their replay. Remove the flag or rewrite the named
workflows to fire-and-forget work.

Under the same flag the live submit endpoints change contract: they validate
and store the row, then reply without running the on-success script. The record
trigger runs the script instead, with the per-module replay limits below. Dry
runs keep executing the script inline and show its transcript.

## Required wiring

Catalyst event listener rules are project configuration the deploy does not
create. Wire one record trigger (an event listener rule, or a Signals rule per
the generated module's banner) per table per action — insert, update, delete —
to the after-commit function. Until a trigger exists, the deferred on-success
actions never run. The gate is deploy-time:

- the printed deploy plan carries an `async on-success triggers (opt-in lane)`
  section with the `event-async-onsuccess` warning;
- a plan-only run (no `--confirm`) prints `warning event-async-triggers` on
  stderr;
- `--confirm` refuses with `blocker event-async-triggers` (exit 1) unless
  `--triggers-wired` is passed, the operator's explicit statement that every
  table/action trigger is wired.

## Marker schema

One row per failed event, keyed by `Event_Key` so a redelivered event updates
rather than duplicates:

| column | type | meaning |
|---|---|---|
| `Event_Key` | varchar, unique | form/action/record/time fingerprint |
| `Form`, `Action`, `Record_ID` | varchar | what failed |
| `Target` | varchar | module the sweeper re-drives (default `events/after-commit.mjs`) |
| `State` | varchar | `pending` → `resolved` or `discarded` |
| `Attempts` | int | sweep re-drive count |
| `Error` | text | last failure message (clipped) |
| `Envelope` | text | identity-only envelope `{v, key, form, table, action, rowId, eventTime}` — never record data |
| `First_Failed`, `Last_Failed` | varchar | ISO timestamps |

Without `event_time` two firings cannot be told apart, so the key gets a
unique suffix instead of collapsing distinct firings into one marker.

## Replay idempotency

`C2CEventProcessed` holds one row per envelope key per on-success module that
ran to completion (`Event_Key`, `Spec`, `State`, `Finished_At`). Before a
module runs, the event function and every replay check the ledger and skip a
module already done for that key; after it completes, they record it. When a
later module fails, replay skips earlier completed modules and retries the
failed module. This is **at-least-once per module**, not per action: side
effects earlier in a module may repeat if a later action fails, and the whole
module may repeat if execution stops after its effects but before its ledger
entry is written. Make deferred side effects safe to repeat where possible.

## Sweep procedure

The `c2c_event_sweeper` cron runs every 15 minutes. Each run:

1. Pages pending markers (`State = 'pending'`, `ORDER BY ROWID`, 50 per page).
2. Re-drives each marker through `replay(envelope, {datastore})` on the module
   its `Target` names — the same spec list the original event ran.
3. On success, sets `State = 'resolved'`. On failure, increments `Attempts`;
   at 5 attempts the marker becomes `discarded` and is never retried again.
4. Stops at the 14-minute budget with `stopped: true`; the next cron resumes
   from the row cursor, so no marker is skipped or double-run inside a run.

The stored envelope carries only the record id: each replay reloads the
committed row from the store, so no names, contact details or free text rest in
the dead-letter table. A row deleted since the failure fails the replay (and
is discarded after 5 attempts). A legacy envelope that still embeds a record
has it ignored. `resolved` and `discarded` markers are kept for
audit; an operator deletes or files them manually.

Manual inspection: query `C2CEventDeadLetter` in the Catalyst console (Data
Store), filter `State = 'pending'` for the backlog and `State = 'discarded'`
for permanent failures. To force an immediate pass, run the
`c2c-event-sweeper` Job once from the console — it is idempotent against the
same markers.

## Failure semantics

- **Dry run** (deploy mode not `live`): the event function runs the script and
  returns its transcript; no marker is written and the sweeper writes nothing.
- **Live without a datastore**: the event function closes with failure and
  throws `live datastore is not configured`; the sweeper throws the same.
- **Event function throws in live**: the marker is written first, then the
  execution closes with failure — the marker survives the function's own
  failure report.
- **Retry fails**: `Attempts` increments; after 5 the marker is `discarded`.
- **Retry succeeds**: `State = 'resolved'`, `Attempts` untouched.

The row itself is never rolled back: the submit endpoint committed it before
the event fired, matching the synchronous lane's post-write failure behavior.
