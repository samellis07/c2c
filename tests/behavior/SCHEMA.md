# Behavior golden schema — `tests/behavior/<app>/creator/`

A behavior golden is the captured input/output of a Creator app. `c2c
verify-behavior <app.ds> --goldens tests/behavior/<app>/creator` replays each
case's inputs against the migrated app — offline in the in-process Catalyst
harness (default, CI) or live against a deployed project (`--live --confirm`)
— and reports every difference as a finding. Zero findings means the app is
behavior-equivalent (the correctness KPI).

Goldens are **redacted, synthetic data only**: no emails, names or ids from
real people; no Desk/support provenance. A capture card writes this schema;
if a capture produces something this schema cannot express, extend the schema
here and the runner together — never invent per-app formats.

## Layout

```
tests/behavior/<app>/
  app.ds                 the Creator export the golden was captured against
  creator/
    cases.json           one JSON document, version c2c-behavior-golden/2
```

`<app>` is the Creator application link name. `app.ds` is committed only
when the export is redistributable. Otherwise it is left out and
`cases.json` names it in `source`; the run passes the local export path as
`<app.ds>`.

## `cases.json`

```json
{
  "version": "c2c-behavior-golden/2",
  "app": "behavior-sample",
  "cases": [
    {
      "id": "submit-valid",
      "name": "happy-path submit stores the row",
      "steps": [
        {
          "op": "submit",
          "form": "Book",
          "record": { "Title": "Dune", "Qty": 2 },
          "expect": {
            "status": 200,
            "body": {
              "dryRun": false,
              "wrote": true,
              "values": {
                "Title": "Dune", "Qty": 2,
                "Added_User": "<any>", "Added_Time": "<timestamp>",
                "ID": "<id>", "ROWID": "<id>",
                "CREATEDTIME": "<timestamp>", "MODIFIEDTIME": "<timestamp>"
              }
            }
          }
        }
      ],
      "expect": {
        "tables": {
          "Book": [
            { "Title": "Dune", "Qty": "2", "Added_User": "<any>", "ROWID": "<id>", "CREATEDTIME": "<timestamp>" }
          ]
        }
      }
    }
  ]
}
```

Top level:

- `version` — required, exactly `c2c-behavior-golden/2`.
- `app` — optional application link name; the runner refuses a golden that
  names a different app than the `.ds` under test.
- `source` — optional `{file, origin?, redistributable?, note?}`: the Creator
  export the golden was captured against, when it is not committed as
  `app.ds`.
- `cases` — required array; `id` is unique across the file.

Each case runs against a fresh store (all tables are emptied first):

- `steps` — ordered calls, the same shape the generated client makes.
- `expect.tables` — optional; names a Catalyst table and its **complete**
  expected contents after the steps run: expected row `i` is compared with
  stored row `i` (count included), unless `expect.unordered: true` matches
  rows as a multiset instead. Expected rows must list every stored field the
  case asserts; stored fields whose value is volatile (id- or
  timestamp-shaped, e.g. `Added_Time`) may be left unlisted. Tables not named
  are not checked.
- `expect.unordered` — optional boolean, default `false`; opt the case's
  `tables` into multiset row matching for stores with no meaningful order.
- `expect.partial` — optional boolean, default `false`; compare `tables` rows
  as subsets: listed columns must match, unlisted stored columns are not
  findings. Use it for goldens captured from Creator, whose replies list only
  some fields. Row count and order rules still apply.
- `tags` — optional strings carried into every finding of the case (see
  Tags).
- `skip` — optional reason. The case is not replayed and is reported under
  `skipped`, never as passing (e.g. a happy path that cannot be reached
  through the Creator API).
- `notes` — optional strings for the reader (lookup substitutions, capture
  caveats); not compared.

## Step ops

| op | call it makes |
| --- | --- |
| `submit` | `POST /forms/<form>/submit` with `{record}` — record add validation, computed fields and on-success workflow side effects |
| `report` | `POST /reports/<report>` with `{op:"query", page:0, pageSize:300, ...body}` — report output rows |
| `call` | `POST /functions/<slug>` with `{args}` — a migrated Creator function |
| `request` | raw `method` + `path` + `body` — any other generated endpoint |
| `update` | Creator's update-by-criteria: query `report` (page 0, 300 rows), keep the rows whose fields equal every `where` value, and submit `record` as an edit (`{ROWID, record}`) of each. The compared reply is `{matched, updated, refused}` — Creator `3100 No Data Available` is `{matched: 0, updated: 0, refused: 0}` |

Every step may also carry:

- `bind` — `{name: pointer}` with pointers into the reply
  (`body.values.ROWID`). A later step or the case's `expect.tables` writes
  `<ref:name>` where it needs the value — the stable placeholder for a
  record id, e.g. a lookup to a parent created earlier in the case. An unset
  pointer and an unbound ref are findings.
- `setup` — `true` for a prerequisite: replayed and bound, reply not
  compared. Each case runs on an empty store, so a case repeats the writes it
  depends on as setup steps.
- `tags` — strings carried into this step's findings (see Tags).
- `creator` — the captured Creator reply (`code`, `message`, `error`):
  documentation for the reader, not compared.

Each step's optional `expect`:

- `status` — HTTP status, default `200` (none when `outcome` is set), or a
  class `"2xx"`, `"4xx"`, `"5xx"`. A `4xx` expectation captures a Creator
  validation refusal; pair it with `body` to pin the message.
- `outcome` — the outcome class a captured Creator reply maps to, without
  pinning c2c's reply text:
  - `saved` — 2xx, `wrote: true`, no `warning` (Creator code 3000);
  - `saved-with-warning` — 2xx, `wrote: true` and a `warning` (Creator code
    3000 with an `error` array from an on-success script: the insert is not
    blocked);
  - `refused` — 4xx and nothing written (Creator 3001/3002/2965);
  - `rows` — 2xx report rows; `count` pins how many (Creator `9220 No
    records exist in this report.` is `count: 0`).
- `partial` — optional boolean; compare `body` objects as subsets.
- `body` — expected JSON response, compared by the matching rules below.
- `unordered` — optional boolean, default `false`; opt this step's `body`
  arrays into multiset matching. Leave it off for sorted reports and ordered
  lists — a reordered row list is then a finding.

## Matching and normalization

Deterministic: same app + same golden always produce the same findings in the
same order (case order, then step order, then pointer).

- **Objects** match with exact key sets: every expected key must be present
  and match, and every actual key must be expected — an extra or missing
  field is a finding. The only exception is volatile system values: an actual
  key whose value is id- or timestamp-shaped (the `<id>`/`<timestamp>`
  classes below) may appear unlisted, because such columns are generated per
  run. A volatile field the golden does list — usually via a marker — must
  still be present.
- **Arrays and table rows** compare **in order** by default: expected
  element `i` is compared with actual element `i`. A golden opts into
  multiset matching only where it explicitly declares `unordered: true` (on
  the step `expect` for `body` arrays, on the case `expect` for `tables`
  rows). Lengths must agree after matching.
- **The text/typed boundary**: Creator cells are text, Catalyst columns are
  typed. A number equals numeric text by value (`"2"` equals `2`, `"947.00"`
  equals `947`) and a boolean equals `"true"`/`"false"`. Two strings or two
  numbers still compare strictly.
- Expected string markers normalize volatile values:
  - `"<any>"` — any value; the key must exist.
  - `"<id>"` — an id-shaped value (15–20 digit string or number ≥ 10^14), for
    `ROWID` and lookup columns.
  - `"<timestamp>"` — an ISO-8601/`YYYY-MM-DD HH:MM:SS`-shaped value, for
    `CREATEDTIME`/`MODIFIEDTIME` and date fields.
- Everything else compares with strict equality — including validation
  message text in `body`, so a changed message is a finding.

## Tags

Tags are data, not passes. The runner acts on one family; the rest are
carried into findings so a report can separate them:

- `env-artifact:<what>` on a step — the captured Creator reply reflects the
  capture environment, not the app (e.g. `env-artifact:trial-user-limit`: a
  trial account's user cap refused or warned in a workflow that adds a
  user). The step is replayed (its writes and binds count) but its reply is
  not compared; the report lists it under `envArtifacts`. The case's tables
  still assert what Creator stored.
- `unreachable-via-api` — a behaviour the Creator REST API cannot exercise
  (a mandatory image/file field: addRecords cannot upload a file). Used with
  `skip`.
- `creator-api-replay-unconfirmed` — Creator's API reply differs from what
  the app's rule implies (e.g. an on-validate refusal that did not fire on
  an exact replay). The golden keeps what Creator returned; the finding is
  an open question, not a c2c defect until confirmed.
- `superseded` — the capture was overwritten; used with `skip`.

## Findings and reports

Every diff is a finding: `{case, step?, pointer, expected, actual}` — the
minimal repro is the case id plus the pointer (`body.values.Title`,
`tables.Book[0].Qty`, `… status`). `--report <file>` writes deterministic
JSON (`c2c-behavior-report/1`; `summary.skipped`, and `skipped` /
`envArtifacts` when present); `--report-md <file>` writes the markdown
table; both are printed to stdout regardless. `status` is `equivalent`
(every case replayed, no finding), `not-equivalent` (a finding, or any
skipped case — a skip is never a pass) or `not-run` (no case replayed); the
markdown states it as `equivalent on N of M cases, K skipped`. Exit code is
`0` when equivalent, `1` on a finding or a skipped case, `2` on usage, `3`
when nothing was replayed. The KPI line is `behavior-equivalent apps: N` —
`1` only when the app ran clean with 0 findings and 0 skipped cases, `0`
otherwise.
