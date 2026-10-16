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
    cases.json           one JSON document, version c2c-behavior-golden/1
```

`<app>` is the Creator application link name.

## `cases.json`

```json
{
  "version": "c2c-behavior-golden/1",
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
            "body": { "values": { "Title": "Dune", "ROWID": "<id>" } }
          }
        }
      ],
      "expect": {
        "tables": {
          "Book": [
            { "Title": "Dune", "Qty": "2", "ROWID": "<id>", "CREATEDTIME": "<timestamp>" }
          ]
        }
      }
    }
  ]
}
```

Top level:

- `version` — required, exactly `c2c-behavior-golden/1`.
- `app` — optional application link name; the runner refuses a golden that
  names a different app than the `.ds` under test.
- `cases` — required array; `id` is unique across the file.

Each case runs against a fresh store (all tables are emptied first):

- `steps` — ordered calls, the same shape the generated client makes.
- `expect.tables` — optional; names a Catalyst table and its **complete**
  expected contents after the steps run. Every expected row must match a
  distinct stored row and vice versa (count included). Expected rows list only
  the fields the case asserts — stored system columns it does not list are
  ignored. Tables not named are not checked.

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

## Matching and normalization

Deterministic: same app + same golden always produce the same findings in the
same order (case order, then step order, then pointer).

- **Objects** match as subsets: every expected key must be present and match;
  extra actual keys are ignored.
- **Arrays and table rows** match as multisets — ordering is a normalization.
  Lengths must agree after matching.
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
