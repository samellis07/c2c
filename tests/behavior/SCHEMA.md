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

`<app>` is the Creator application link name.

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

## Step ops

| op | call it makes |
| --- | --- |
| `submit` | `POST /forms/<form>/submit` with `{record}` — record add validation, computed fields and on-success workflow side effects |
| `report` | `POST /reports/<report>` with `{op:"query", page:0, pageSize:300, ...body}` — report output rows |
| `call` | `POST /functions/<slug>` with `{args}` — a migrated Creator function |
| `request` | raw `method` + `path` + `body` — any other generated endpoint |

Each step's optional `expect`:

- `status` — HTTP status, default `200`. A `4xx` expectation captures a
  Creator validation refusal; pair it with `body` to pin the message.
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
- **Numbers vs numeric strings** compare equal across the text/number
  boundary (`"2"` equals `2`): Creator cells are text, Catalyst columns are
  typed.
- Expected string markers normalize volatile values:
  - `"<any>"` — any value; the key must exist.
  - `"<id>"` — an id-shaped value (15–20 digit string or number ≥ 10^14), for
    `ROWID` and lookup columns.
  - `"<timestamp>"` — an ISO-8601/`YYYY-MM-DD HH:MM:SS`-shaped value, for
    `CREATEDTIME`/`MODIFIEDTIME` and date fields.
- Everything else compares with strict equality — including validation
  message text in `body`, so a changed message is a finding.

## Findings and reports

Every diff is a finding: `{case, step?, pointer, expected, actual}` — the
minimal repro is the case id plus the pointer (`body.values.Title`,
`tables.Book[0].Qty`, `… status`). `--report <file>` writes deterministic
JSON (`c2c-behavior-report/1`); `--report-md <file>` writes the markdown
table; both are printed to stdout regardless. Exit code is `1` on any
finding, `0` on none, `2` on usage. The KPI line is
`behavior-equivalent apps: N` — `1` when the app ran clean, `0` otherwise.
