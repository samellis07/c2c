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

## Step 2 — Plan: the full blueprint

Still offline. The AI builds the whole migration plan — tables,
limit budgets, functions, screens, sign-in, integrations, and the
exact infrastructure steps — and walks you through it section by
section. You approve the plan and answer the decisions it forces
(for example which fields lose "no duplicates", since Catalyst
allows only 2 unique text columns per table). Nothing runs until
you approve.

## Step 3 — Provision: build the empty house

Needs a green doctor and your yes per phase. The AI creates the
infrastructure item by item — tables, permissions, the job pool,
the file bucket, sign-in config — reading each one back after
creating it. Anything only a human can do in the console (creating
the project itself, custom roles, some connections) becomes a
precise instruction: exact page, exact click, then "tell me when
done", and the AI verifies it afterwards.

## Step 4 — Deploy: move the code in

With your yes, the AI deploys the translated functions and links
and deploys your Slate web app, then records the app's web address
(URL). One detail you may be asked for: secret values (API keys and
similar) go into a file **you** fill in — the AI never reads or
repeats them — because deploying replaces them otherwise.

## Step 5 — Sign-in and access: lock the doors, invite yourself

The AI enables hosted and embedded sign-in, registers your app's
address as an authorised domain, sets table permissions per role,
and invites **you** as the first administrator. Then come two of
your five human steps (invite mail, one sign-in — see
[chapter 4](04-your-five-steps.md)).

## Step 6 — Data load: move the records

Needs your yes. The AI loads your records table by table (in small
batches), remaps links between records, uploads files to the file
bucket, and proves it: **per-table counts must equal Creator's own
counts**, and every link must resolve 100%. A mismatch stops the
step — it is never smoothed over.

## After that — verify, then go live (your call)

- **Verify:** the AI runs limit probes (tiny scratch resources it
  creates, measures and deletes), a smoke test with you in the
  browser, and your 3–5 most important business rules stated as
  given/when/then and tried through the screens.
- **Cutover (optional, you drive):** when you are satisfied, *you*
  click **Deploy to Production** in the console (a payment method is
  required), freeze writes in Creator, and switch your links. The AI
  checks each stage after you. Creator stays read-only — not
  deleted — until you sign off, so you can always go back.
