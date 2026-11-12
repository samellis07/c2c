# 3. The journey, step by step

You stay in the chat while the AI works through this fixed order.
It never reorders or skips steps
([migration playbook](../../plugin/skills/c2c-migrate/SKILL.md)).
Every step that creates something asks for your **"yes" first**,
and nothing counts as done until the AI reads it back and it matches.

## Step 1 — Analyse: is my app convertible?

Fully offline; nothing touches your accounts. The AI checks your
`.ds` export for blockers (each with Creator's own error text and
the broken component), then scores readiness and Deluge coverage.
You get three lists: **must fix in Creator first** (blocking faults
— fix them there and re-export), **converts with a TODO**, and
**Catalyst limits to decide on in the plan**.

The analysis also warns about two slow patterns it would rather
catch now than after go-live: a report filter that reads through a
record link (each matching row re-reads its parent form, and the
read stops answering above about a thousand matches), and an
on-success script — with the functions it calls — that makes more
than four Data Store calls on one save. Both are counted in your
migration report.

The report also identifies constructs that need a deliberate manual
follow-up. Pivot reports include the row, column, and measure choices
needed to rebuild the pivot in Catalyst. Form-event gaps include the
event, script, and concrete guided steps needed to reproduce it;
residual items from unsupported translations stay in the same guided
list rather than being silently omitted.

## Step 2 — Plan: the full blueprint

Still offline. The AI builds the whole migration plan — tables,
limit budgets, functions, screens, sign-in, integrations, and the
exact infrastructure steps — and walks you through it section by
section. You approve the plan and answer the decisions it forces
(for example which fields lose "no duplicates": Catalyst
allows only 2 unique short-text columns per table
([L-UNIQUE-VARCHAR](../../plugin/references/limits.md#l-unique-varchar-unique-varchar-columns-per-table),
[TESTED]) — the rest are enforced in the app code instead).
Nothing is created until you approve.

## Step 3 — Provision: build the empty house

Needs a green doctor and your yes per phase. The AI creates the
infrastructure item by item — tables, permissions, the job pool,
the file bucket, sign-in config — reading each one back after
creating it. Anything only a human can do in the console (custom
roles, some connections, and similar — a brand-new project is
created by the import, or by you in the console) becomes a
precise instruction: exact page, exact click, then "tell me when
done", and the AI verifies it afterwards.

If a table already exists in the project and its columns differ
from the plan — uniqueness, type, mandatory or length — the step
stops marked **drift** instead of changing anything: the output
lists each differing column with the planned and live values and
prints the non-destructive fix.

## Step 4 — Deploy: move the code in

With your yes, the AI deploys the translated functions and links
and deploys your Slate web app, then records the app's web address
(URL). One detail you may be asked for: secret values (API keys and
similar) go into a file **you** fill in — the AI never reads or
repeats them — because a deploy writes the full set at once and
would otherwise wipe them
([facts/functions.md](../../plugin/references/facts/functions.md)).
Before anything is sent, the AI also measures the full environment
against Catalyst's size limit and refuses an over-limit set —
naming the size and the limit, never the values — so a deploy
cannot create something it could never update later.

## Step 5 — Sign-in and access: lock the doors, invite yourself

The AI enables hosted and embedded sign-in, registers your app's
address as an authorised domain, sets table permissions per role,
and invites **you** as the first administrator. Then come your
human steps for this stage: the invite mail, plus the one sign-in
when your app has web screens (see
[chapter 4](04-your-five-steps.md)).

## Step 6 — Data load: move the records

Needs your yes. The AI loads your records table by table (in small
batches), remaps links between records, uploads files to the file
bucket, and proves it: **per-table counts must equal Creator's own
counts**, and every link must resolve 100%. A mismatch stops the
step — it is never smoothed over. And if a table's columns have
drifted from the plan since provisioning, the AI warns and names
them before loading rows into it.

## After that — verify, then go live (your call)

- **Verify:** the AI runs the checks the plan flags (small scratch
  resources it creates, measures and deletes, with your OK), an
  offline pass that mounts each report, chart and dashboard screen
  and compares its rows, totals and file exports against known
  data — a screen that cannot render or export is counted, never
  passed — a smoke test you run in your own browser (step 4 of
  your five steps), and your 3–5 most important business rules
  stated as given/when/then and tried through the screens.
- **Cutover (optional, you drive):** when you are satisfied, *you*
  click **Deploy to Production** in the console (a payment method is
  required on the account —
  [facts/projects.md](../../plugin/references/facts/projects.md)),
  freeze writes in Creator, and switch your links. The AI
  re-verifies on Production reads after each stage you complete.
  Creator stays read-only — not deleted — until you sign off, so
  you can always go back.
