# Behavior verification: `c2c verify-behavior`

Deterministic is not the same as correct. `verify-behavior` is the
differential check: it replays a captured **Creator golden** — the original
app's inputs and outputs — against the migrated app and reports every
difference. An app with zero differences is **behavior-equivalent**, the
correctness KPI printed as the last line:

```
behavior-equivalent apps: 1
```

## Usage

```
c2c verify-behavior <file|dir> --goldens tests/behavior/<app>/creator [--report <file.json>] [--report-md <file.md>]
c2c verify-behavior <file|dir> --goldens <dir> --live --confirm --url <fn-base> [--project <id>] [--org <id>] [--auth-token <token> | --session-cookie <name=value>]
```

- **Offline (default, CI-safe).** The deploy tree is generated into a temp
  directory and `functions/c2c_api` runs in-process under the same Catalyst
  harness as `tools/catalyst-harness/serve.mjs` (the in-memory
  `zcatalyst-sdk-node` stand-in). No project, no credential, no network.
  Stored rows are compared from the in-memory datastore.
- **`--live`.** The same steps run against the deployed function over HTTPS.
  `--url` must match the function origin in the `c2c-deploy-report.json`
  beside the source — the same credential binding the smoke run uses — the
  project must be live, and stored rows are read back through the admin ZCQL
  surface with the Catalyst CLI scope (`--project`/`--org` or the deploy
  config/registry). App-user auth rides as `--auth-token` or
  `--session-cookie`, exactly like `c2c smoke`.

## What is compared

For every golden case (schema in `tests/behavior/SCHEMA.md`):

- **Stored rows** — `expect.tables` names a Catalyst table and its complete
  expected contents; a missing or extra row is a finding.
- **Computed and formula fields** — they are stored row fields, compared like
  any other.
- **Validation outcomes and messages** — a step's `expect.status` and
  `expect.body` pin the refusal status, code and message text.
- **Workflow side effects** — rows an on-success/on-delete script writes to
  other tables surface in `expect.tables`.
- **Report outputs** — a `report` step compares the query response.

## Normalization

Comparisons normalize ids, timestamps and ordering (`<id>`, `<timestamp>`,
`<any>` markers; arrays and table rows match as multisets), and compare
numeric text across the text/number boundary — see
`tests/behavior/SCHEMA.md` for the exact rules. Everything else is strict, so
a changed validation message is a finding.

## Findings and reports

Every difference is a finding `{case, step?, pointer, expected, actual}` —
the minimal repro. `--report` writes deterministic JSON
(`c2c-behavior-report/1`), `--report-md` writes the markdown table, and the
markdown is always printed. Exit code: `1` on any finding, `0` on none, `2`
on usage.

Goldens are synthetic and redacted: no real names, emails or ids. The schema
and the tiny hand-written `behavior-sample` golden (with its deliberately
broken `app-broken.ds` must-fail variant) live under `tests/behavior/`.
