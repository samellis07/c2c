# 10. A worked example — Admission Management, start to finish

This chapter follows one real sample app, **Admission Management**
(an admissions app: 14 forms, 26 reports, one dashboard page), through
the steps of [chapter 3](03-the-journey.md). Every command below was
run on the app's `.ds` export, offline, and the output is pasted
trimmed — so you can see what the AI sees. You never type these
yourself; the AI does.

Steps that need your Catalyst account are marked **needs your Catalyst
account**. They are not shown with output, because they cannot be run
offline.

## Step 0 — Check the export

```
$ c2c --version
0.2.0
$ c2c precheck Admission_Management.ds
Admission Management  findings 7  blockers 0  warnings 7
```

Zero blockers: nothing has to be fixed in Creator before going on.
The four table-name warnings are named in step 1.

The setup check (`c2c doctor`) reads your Catalyst sign-in and
installed tools, so its output depends on your machine and account:
**needs your Catalyst account** (see
[chapter 2](02-before-you-start.md)).

## Step 1 — Analyse

```
$ c2c analyze Admission_Management.ds
application: Admission Management  shape: B  dialect: D1
score: 77/100 needs-work  (features 74, deluge 81)
features used: 63  supported 0  adapter 62  needs-assessment 0  gap 1  blocker 0
scope: Payments — not supported in this version (counted)
scope: Offline — not supported in this version (counted)
...
field behavior gaps: 44 across 11 types
  email: 5 (Add_Assessor.Email, ...) — There is no email column ...
  phone: 5 (Add_Assessor.Phone_Number, ...) — There is no phone column. Stored ...
hidden from end users: 9
deluge: 287 statements  translated 10  shimmed 277  todo 0  (69 units)
blockers: 0
catalyst (estimate): tables 21  nosql 0  deluge units 69  functions 1  cron 3  slate pages 41
```

How to read it: **blockers: 0** means no must-fix-in-Creator list.
**todo 0** means no script is left untranslated. The 44 field
behaviour gaps are fields Catalyst stores differently (for example,
an email or phone number is kept as text); each is counted, not
hidden. The two "slow pattern" warnings from
[step 1](03-the-journey.md) show up here:

```
[warning] store-calls-lookup-path-filter  form Fill_New_Application  field Select_Course
  Report Direct_Admissions criteria filters on lookup path Select_Course.Admission_Flow. ...
  fix: Keep Start_New_Admission small, or store the filtered value on Fill_New_Application itself ...
[warning] store-calls-on-success  form Fill_New_Application
  Fill_New_Application on success makes at least 7 Data Store calls per submit, over the 4-call target ...
  fix: Keep running totals updated on write instead of re-reading other forms, ...
```

The rest are four table-name warnings: a few generated table names are
longer than any name Catalyst has been seen to keep, so the plan asks
you to shorten them or confirm they create.

## Step 2 — Plan

First the table design, as a dry run (nothing is created):

```
$ c2c schema Admission_Management.ds
# Schema migration report: Admission Management
Dry run only. Project `c2c-Admission-Management`.
...
Tables: 21 (NoSQL collections: 0)
Columns: 207
...
Mapped (supported + partial): 100.0%
```

Then the whole blueprint (the data centre is yours to choose; `in`
is used here):

```
$ c2c plan Admission_Management.ds --dc in --out plan
plan: plan/plan.md
next step: c2c provision --out plan needs the org: pass --org <id> or add "org" to c2c-deploy.json
```

The top of `plan/plan.md`:

```
tables: 21 (207 columns)  functions: 31  schedules: 3  reports: 26  pages: 1  roles: 6  custom APIs: 0
mail: the app sends mail, so a sender step is planned
files: 2 Stratus-backed fields
project: new — provision/plan.json creates it with one IaC import ...
```

Tables are checked against limit budgets (columns, unique text columns,
links). Two schedules run relative to each record's deadline; the plan
lists them as handled by one shared sweeper job rather than dropping
them, and the migration report (step 2b below) lists them as manual
follow-up.

**Step 2b — the migration report**

```
$ c2c report Admission_Management.ds --dc in --out report
report: report/migration-report.md
```

```
## What will be converted
- Forms: 14 ...   - Reports: 26 ...   - Pages: 1 — Dashboard
- Workflows: 41   - Schedules: 3      - Functions: 31   - Roles: 6
## Guided steps for a person
1. Start the used services ...  2. Accept the admin invite
3. Sign in once                 4. Verify the sender email
## App-specific manual work
- Deadline_Notification — ... Catalyst has no per-record schedule, so it was not created.
- Mark_Absent — The schedule is created disabled for review.
```

Read it the way [chapter 5](05-reading-the-report.md) describes. This
is where you approve the plan — nothing below happens before your yes.

## Step 3 — Provision

The ordered list the AI will work through, and how far along it is:

```
$ c2c provision --out plan --status
provision Admission Management
- import [cli] pending
- cloudscale-enable [console] pending
- tables [cli] pending
...
- mail-sender [console] pending
- crons [cli] pending
done: 0/17
```

Items marked `[console]` are your clicks (they match
[your five steps](04-your-five-steps.md)). Creating the project, the
tables, the file bucket and the sign-in settings: **needs your
Catalyst account**. The plan also writes the table definitions it
would import, in `plan/provision/`.

## Step 4 — Deploy, and the web screens

Deploying functions and the Slate app: **needs your Catalyst account**.
Generating the web app is offline and can be shown:

```
$ c2c ui-react Admission_Management.ds --out ui
ui-react files 245 written 245 kept 0 removed 0
```

The generated app has one screen module per form (14), per report (26)
and for the dashboard page (1), and a `src/custom/` folder that c2c
never overwrites. Installing its packages and building it needs the
network, so it was not run here: **needs your network access**.

## Step 5 — Sign-in and access

The offline dry run of what would be set up:

```
$ c2c auth Admission_Management.ds
# Auth plan (dry run)
Nothing in this plan is applied. Role ids and user invites are not invented.
- Hosted login: true   - Embedded login: true   - Public signup: false
- Roles: 6             - Table permission rows: 98
```

Applying it, the invite mail and the first sign-in: **needs your
Catalyst account**.

## Step 6 — Data load

Without an export of your real records, c2c can write sample rows so
the later checks have something to compare:

```
$ c2c seed Admission_Management.ds --out seed --n 5
seed Admission Management n=5 forms=14
Add_Assessor: 5 rows
...
```

Loading and the per-table count check against Creator: **needs your
Catalyst account** (and your data export).

## Before going live

The offline cut-over checklist:

```
$ c2c cutover-checklist Admission_Management.ds --out cutover
wrote cutover-checklist.md, c2c-proof.json, c2c-proof.md
readiness: 77% automatic, 5 manual item(s)
```

The checklist has nine sections: rollback baseline, freeze Creator,
final delta, smoke, sign-in, redirect, DNS and links, rollback ready,
and owner sign-off. Deploy to Production, the freeze and the switch
stay yours; see [chapter 8](08-go-live-and-rollback.md).

## What this example shows

- Every offline step ran with no blockers, and each step's output
  names what is left for a person.
- Everything that touches your Catalyst account is a separate,
  marked step — nothing is assumed to have passed.
- The numbers above are from one run of one sample app; your app's
  counts will differ.
