# Table budget

Regenerable summary of a corpus of sample Creator apps (not included). Recompute with
`C2C_FIXTURES_DIR=<fixtures> npm run tables:budget`; `npm test` fails when this file is
stale and the local corpus is present. Counts and app indexes only — no app names, paths, or
script text.

Data Store tables count against one org-wide limit shared by every project and
environment. Creating a table past it fails with
`403 API_LIMIT_REACHED: You have reached the max limit of your current API Limit for table`.
Each support table is therefore created only for an app that uses its feature:

| support table | created when | created by |
|---|---|---|
| `C2C_Flow_History` | the app has an approval or a blueprint | `c2c plan` (import) and `c2c deploy` |
| `C2CJobCheckpoint` | the app has a form schedule (the sweeper's checkpoints) | `c2c plan` (import) and `c2c deploy` |
| `c2c_mail_log` | the app's functions send mail **and** the deploy ran with `--mail` | `c2c deploy --mail` |
| `C2CEventDeadLetter` | the deploy ran with `--async-on-success` (the async on-success event lane) | `c2c deploy --async-on-success` |
| `C2CEventProcessed` | the deploy ran with `--async-on-success` (the per-module completion ledger that fences replays) | `c2c deploy --async-on-success` |

An app without the feature gets no table, and its functions never reference it: a
deploy of an app that sends no mail ships no mail module, and a deploy without `--mail`
writes no delivery log.

**Before / after.** Before, every deploy of an app whose functions send mail created
`c2c_mail_log`, with or without `--mail`: the "with `--mail`" columns below. After, a
default deploy creates it only with `--mail`: the "default" columns.

| | default deploy (after) | with `--mail` (before) | default + `--async-on-success` |
|---|---:|---:|---:|
| corpus apps | 67 | 67 | 67 |
| app tables | 1035 | 1035 | 1035 |
| `C2C_Flow_History` | 2 | 2 | 2 |
| `C2CJobCheckpoint` | 35 | 35 | 35 |
| `c2c_mail_log` | 0 | 64 | 0 |
| async on-success tables | 0 | 0 | 28 |
| support tables | 37 | 101 | 65 |
| **all tables** | **1072** | **1136** | **1100** |
| largest app | 44 | 45 | 44 |

Apps whose sweeper checkpoints in `C2CJobCheckpoint`: 35.

## Per app

Apps in corpus order. "c2c" is the support tables a deploy creates; "total" is app plus
c2c tables. "checkpoint" marks the apps whose deploy creates `C2CJobCheckpoint`; it is
counted in c2c/total already.

| app | app tables | c2c before | total before | c2c after | total after | async tables | total with async | checkpoint |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 19 | 2 | 21 | 1 | 20 | 0 | 20 | 1 |
| 2 | 20 | 2 | 22 | 1 | 21 | 0 | 21 | 1 |
| 3 | 5 | 2 | 7 | 1 | 6 | 2 | 8 | 0 |
| 4 | 10 | 2 | 12 | 1 | 11 | 0 | 11 | 1 |
| 5 | 14 | 1 | 15 | 0 | 14 | 0 | 14 | 0 |
| 6 | 10 | 0 | 10 | 0 | 10 | 2 | 12 | 0 |
| 7 | 8 | 2 | 10 | 1 | 9 | 0 | 9 | 1 |
| 8 | 21 | 2 | 23 | 1 | 22 | 0 | 22 | 1 |
| 9 | 3 | 2 | 5 | 1 | 4 | 2 | 6 | 1 |
| 10 | 4 | 2 | 6 | 1 | 5 | 2 | 7 | 1 |
| 11 | 26 | 2 | 28 | 1 | 27 | 0 | 27 | 1 |
| 12 | 2 | 0 | 2 | 0 | 2 | 0 | 2 | 0 |
| 13 | 9 | 1 | 10 | 0 | 9 | 0 | 9 | 0 |
| 14 | 13 | 2 | 15 | 1 | 14 | 0 | 14 | 1 |
| 15 | 11 | 2 | 13 | 1 | 12 | 0 | 12 | 1 |
| 16 | 28 | 2 | 30 | 1 | 29 | 0 | 29 | 1 |
| 17 | 11 | 1 | 12 | 0 | 11 | 0 | 11 | 0 |
| 18 | 30 | 1 | 31 | 0 | 30 | 0 | 30 | 0 |
| 19 | 10 | 2 | 12 | 1 | 11 | 0 | 11 | 1 |
| 20 | 18 | 3 | 21 | 2 | 20 | 0 | 20 | 1 |
| 21 | 37 | 1 | 38 | 0 | 37 | 0 | 37 | 0 |
| 22 | 8 | 1 | 9 | 0 | 8 | 2 | 10 | 0 |
| 23 | 18 | 1 | 19 | 0 | 18 | 0 | 18 | 0 |
| 24 | 9 | 2 | 11 | 1 | 10 | 0 | 10 | 1 |
| 25 | 9 | 2 | 11 | 1 | 10 | 0 | 10 | 1 |
| 26 | 13 | 1 | 14 | 0 | 13 | 0 | 13 | 0 |
| 27 | 21 | 1 | 22 | 0 | 21 | 0 | 21 | 0 |
| 28 | 17 | 2 | 19 | 1 | 18 | 0 | 18 | 1 |
| 29 | 10 | 1 | 11 | 0 | 10 | 0 | 10 | 0 |
| 30 | 15 | 2 | 17 | 1 | 16 | 2 | 18 | 1 |
| 31 | 39 | 2 | 41 | 1 | 40 | 0 | 40 | 1 |
| 32 | 43 | 2 | 45 | 1 | 44 | 0 | 44 | 1 |
| 33 | 6 | 1 | 7 | 0 | 6 | 0 | 6 | 0 |
| 34 | 11 | 1 | 12 | 0 | 11 | 0 | 11 | 0 |
| 35 | 8 | 0 | 8 | 0 | 8 | 2 | 10 | 0 |
| 36 | 12 | 2 | 14 | 1 | 13 | 0 | 13 | 1 |
| 37 | 7 | 2 | 9 | 1 | 8 | 2 | 10 | 1 |
| 38 | 16 | 1 | 17 | 0 | 16 | 0 | 16 | 0 |
| 39 | 16 | 2 | 18 | 1 | 17 | 0 | 17 | 1 |
| 40 | 22 | 1 | 23 | 0 | 22 | 0 | 22 | 0 |
| 41 | 10 | 1 | 11 | 0 | 10 | 2 | 12 | 0 |
| 42 | 34 | 1 | 35 | 0 | 34 | 0 | 34 | 0 |
| 43 | 12 | 2 | 14 | 1 | 13 | 2 | 15 | 1 |
| 44 | 11 | 2 | 13 | 1 | 12 | 0 | 12 | 1 |
| 45 | 12 | 1 | 13 | 0 | 12 | 0 | 12 | 0 |
| 46 | 8 | 1 | 9 | 0 | 8 | 0 | 8 | 0 |
| 47 | 8 | 2 | 10 | 1 | 9 | 0 | 9 | 1 |
| 48 | 44 | 1 | 45 | 0 | 44 | 0 | 44 | 0 |
| 49 | 8 | 2 | 10 | 1 | 9 | 0 | 9 | 1 |
| 50 | 29 | 2 | 31 | 1 | 30 | 0 | 30 | 1 |
| 51 | 9 | 1 | 10 | 0 | 9 | 0 | 9 | 0 |
| 52 | 19 | 1 | 20 | 0 | 19 | 0 | 19 | 0 |
| 53 | 13 | 1 | 14 | 0 | 13 | 0 | 13 | 0 |
| 54 | 18 | 2 | 20 | 1 | 19 | 2 | 21 | 1 |
| 55 | 19 | 1 | 20 | 0 | 19 | 2 | 21 | 0 |
| 56 | 27 | 1 | 28 | 0 | 27 | 0 | 27 | 0 |
| 57 | 2 | 2 | 4 | 1 | 3 | 0 | 3 | 1 |
| 58 | 6 | 2 | 8 | 1 | 7 | 0 | 7 | 1 |
| 59 | 26 | 1 | 27 | 0 | 26 | 0 | 26 | 0 |
| 60 | 26 | 2 | 28 | 1 | 27 | 0 | 27 | 1 |
| 61 | 5 | 1 | 6 | 0 | 5 | 0 | 5 | 0 |
| 62 | 16 | 2 | 18 | 1 | 17 | 0 | 17 | 1 |
| 63 | 12 | 2 | 14 | 1 | 13 | 0 | 13 | 1 |
| 64 | 13 | 2 | 15 | 1 | 14 | 0 | 14 | 1 |
| 65 | 3 | 1 | 4 | 0 | 3 | 2 | 5 | 0 |
| 66 | 14 | 2 | 16 | 1 | 15 | 2 | 17 | 1 |
| 67 | 22 | 1 | 23 | 0 | 22 | 0 | 22 | 0 |
