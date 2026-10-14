# 1. What c2c does — and does not do

c2c converts your Zoho Creator app — its forms, reports, workflows
and records — into a Zoho Catalyst project: Data Store tables,
Node.js functions translated from your Deluge scripts, a Slate web
app (your new screens), sign-in, and scheduled jobs. It runs inside
your own AI assistant, on your own machine, against your own Zoho
accounts. That description comes from the
[c2c plugin readme](../../plugin/README.md).

## What gets converted

- **Forms become tables with columns.** Field types are mapped
  one by one; subforms become linked child tables; lookups become
  links between tables.
- **Workflows and Deluge scripts become app code.** Each script is
  translated, converted with a helper (shimmed), or listed as a TODO
  (see below) — the analysis tells you which, per script.
- **Reports and pages become Slate screens.** Some complex views
  are simplified; the plan names each one.
- **Users, roles and permissions become Catalyst sign-in plus roles.**
  Portal users are re-invited, never copied with passwords.
- **Records move over.** Your data is loaded table by table and
  counted against Creator's own counts.

## What stays manual — counted and listed, never hidden

Some Creator pieces have no Catalyst equivalent and are flagged,
never silently dropped ([no-silent-drop rule](../../docs/no-silent-drop.md),
rule 8 in [the c2c rules](../../plugin/C2C.md)):

- Payments, form email, native mobile apps and offline mode,
  marketplace publishing, the Zia AI builder, on-prem Data Bridge,
  and some chat integrations are **out of scope** (marked
  `OUT-OF-SCOPE` with a reason code).
- **Single sign-on (Zoho One / SAML)** has no native Catalyst
  equivalent. The fallback is Catalyst's own hosted/embedded sign-in
  plus re-inviting your users — the AI will ask you to choose.
- Anything the converter cannot translate becomes a numbered TODO
  in your migration report with per-construct counts, e.g.
  `2 (2 sendmail-attachment:template)` — two spots need a human to
  decide about mail attachments. Real examples of these counts are
  tabulated in the [synthetic migration report](../../docs/synthetic-report.md).

## The three possible verdicts for your app

After analysis your app is rated, using the same words as the
[synthetic report](../../docs/synthetic-report.md):

- **migrates** — converts cleanly, no manual blockers.
- **manual-items** — migrates, with a named list of things that stay
  manual (most apps land here — that is normal, not a failure).
- **FAIL** — blocked until something is fixed in Creator first.

A high readiness score alone does not mean "ready": an app can score
high and still fail to save a record because it exceeds a platform
limit, so the AI always continues to the plan's limit budgets before
calling your app ready.
