# 5. Reading the migration report

Everything the AI learns lands in a folder called `c2c-out/<your
app>/` in the workspace. You do not need to open it yourself — the
AI summarises it — but this is what is in there and what each piece
means for you.

## The headline: your verdict

- **migrates** — clean conversion, no manual blockers.
- **manual-items** — converts, with a **named list** of things that
  stay manual. Most apps land here. Each item says what it is, where
  it is, and who decides it — for example `1 blocker sendmail-sender`
  means one mail sender needs a human decision. The shape of these
  lists, with real examples, is tabulated in the
  [synthetic migration report](../../docs/synthetic-report.md).
- **FAIL** — blocked; fix the named items in Creator and re-export.

## The three lists that matter to you

1. **Must fix in Creator first** — blocking faults (a bad workflow
   link, a function call with the wrong arguments). These break
   Creator's own export too, so they are fixed where they live.
2. **Converts with a TODO** — the AI converts these but flags each
   one with a numbered TODO: what was approximated, and what a human
   should review. Unresolved TODOs carry per-construct counts, e.g.
   `2 (2 sendmail-attachment:template)`.
3. **Decisions for you** — the plan's forced choices (which fields
   lose "no duplicates", async workflows, simplified views). Your
   answers are recorded and the plan is re-run until it passes.

## Where each answer lives

| Question | File the AI shows you |
|---|---|
| What is broken in my export? | `precheck.json` — every blocker with Creator's own error text |
| Will it convert? | `analyze.json` — readiness score, Deluge coverage, deterministic flag |
| What exactly will be built? | `plan.md` — the blueprint you review and approve before anything runs |
| What did the run do? | `c2c-deploy-report.json` — written **even when a step failed**, so a failure still leaves a full record |
| Did my data arrive whole? | per-table counts vs Creator's `counts.json`; links resolved 100% |
| Is it proven working? | `c2c-proof.json` (and `c2c-proof.md`) — per-table counts and checksums, the smoke result, and readiness plus every manual item by name. The list of what you now own comes in the AI's summary |

## Counts must match, always

The finding count the AI quotes must equal the count in the JSON;
per-table row counts must equal Creator's counts. If any number the
AI says disagrees with a file, stop and point at it — a mismatch is
a failed check, never a rounding error.
