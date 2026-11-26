# 8. Go-live and rollback

This chapter is the switch-over day: you stop edits in Creator, move
the last changes, check the new app, and point people to it. It also
says how to go back if the new app is not right. The AI runs the
commands; you do the steps marked **you**.

Do the dry run first. Every step below that reads and writes only
files can be rehearsed on your machine with no Catalyst sign-in. The
steps that touch your real project need the signed-in Catalyst
command line, and the AI waits for you to sign in before it tries
them.

## The order

| # | Step | Command the AI runs | Already covered by | Checked without signing in | Needs the Catalyst sign-in |
|---|------|--------------------|--------------------|----------------------------|----------------------------|
| 0 | Pre-checks | `c2c doctor`, `c2c precheck`, `c2c plan` | existing commands | yes: the plan and its budgets are files | doctor reads your project |
| 1 | Take the rollback baseline | `c2c rollback-export --ds <app> --out <dir> --confirm` | existing command | the export format, the manifest and the checksums | reading the rows from your project |
| 2 | **You:** freeze Creator | none (a Creator permission change) | the checklist step 2 | — | — |
| 3 | Final export from Creator | **you** export every report with record ids | the checklist step 3 | — | — |
| 4 | Final data delta | `c2c sync-delta ... --since <state>` then again with `--confirm` | existing command | the plan, the conflict report, the second plan showing 0 new and 0 changed | the `--confirm` write to your project |
| 5 | Verify | `c2c verify --data-parity`, `c2c smoke`, `c2c cutover-checklist` | existing commands | counts and checksums against your export | the smoke run in the live app |
| 6 | Switch | **you** change the Creator home page, sign-in redirect and links | the checklist steps 5 to 7 | the old-link map (every Creator form, report and page address and where it lands) | opening the live app |
| 7 | Close | `c2c proof`, owner sign-off | existing commands | the proof file | — |

Nothing here is new work for the AI except the rehearsal: one
command, `node tools/cutover-rehearsal.mjs --ds <app> --out <dir>`
in a source checkout, runs steps 1 to 7 against a stand-in data
store and writes a PASS, FAIL or GAP line per step.

## Before the freeze

1. Run `c2c plan` and read the budgets. A failed budget is fixed
   before go-live, not on the day.
2. Run `c2c rollback-export` and keep the folder **outside** the
   project folder. It holds your record values. Its manifest has a
   checksum for each file; `c2c cutover-checklist --rollback-export
   <dir>` refuses a baseline that does not belong to the app.
3. Do one full dry run with a copy of the data. Time it. The
   rehearsal prints an estimate of the freeze window (store calls and
   rows priced at planning rates, plus the steps only you can do). The
   estimate is a planning number, not a promise: your real window
   depends on how fast your project answers.

## During the freeze

1. **You:** tell your users the window, then restrict Creator writes
   to administrators and confirm a normal user cannot save. Write the
   time down.
2. **You:** export every report again with record ids.
3. The AI runs `c2c sync-delta` with your state folder. It reports
   new, changed and deleted records, and stops on a record edited on
   both sides: the report names the table, the record and the field,
   and shows a short fingerprint instead of the value. You choose per
   table with `--prefer creator` or `--prefer catalyst`, or give a file
   of choices with `--conflicts`. Deletions apply only with
   `--apply-deletes` and only from a complete export.
4. Run the same command with `--confirm`, then plan again. Every
   table must show 0 new, 0 changed.
5. `c2c verify --data-parity` and `c2c smoke` confirm the counts and
   one saved record per form.

## The switch

**You:** open the new app signed in as one person of each role,
repoint the Creator home page, and update links in mail, documents
and integrations. The checklist lists every Creator address and the
new address it maps to; addresses that have no generated page are
listed as manual steps, never skipped.

If you use your own web address, the AI cannot set it up or check it
yet: record the name, where it points and the certificate in the
checklist. This is the one open item in the rehearsal.

## Rollback

Rollback is a decision you take before the switch is announced as
final, and it stays possible afterwards.

1. **You:** put Creator back into normal use (lift the freeze).
2. The AI runs `c2c rollback-export ... --confirm` again. The export
   holds every stored row, including rows saved in the new app after
   the switch, as one CSV per form that Creator's report **Import
   Data** accepts. Use `--changed-since <state>` to export only what
   changed since the last delta.
3. **You:** import the CSVs in Creator. Subform rows and multiple
   lookups are written under `manual/`, and file fields are listed in
   `files/`, because Creator's report import cannot load them. You
   re-enter or re-attach those by hand. This is the second open item.
4. Point the Creator home page back and tell users.

The new app and its data stay in place until you delete them, so
you can go forward again later with another delta.

## What was checked, and what was not

Checked without signing in, on this machine, for each sample app:
the order above, the final delta and its second plan, the
both-sides edit report, the verify counts, the rollback export and
its manifest, the old-link map and the freeze-window estimate.

**Not** checked without signing in: reading and writing a real
Catalyst project, the live smoke run, sign-in and invitations, the
Creator home page redirect, custom domains, and time taken in
practice. These wait for the Catalyst sign-in and are marked not run.
