---
name: c2c-status
description: "View Creator-to-Catalyst migration project health and status: deployed functions, last deploy time, Slate URL, table counts against budget, and recent function errors. Use for 'c2c status', 'project health', 'deployment status', 'check limits', 'check budget', 'unanswered reads', 'checklist steps'."
metadata:
  version: "0.2.0"
---

# Status

The `c2c status` command reports the read-only health and status of a Catalyst project.

## Usage

```bash
c2c status --project <id> [--org <id>] [--app <name>] [--json] [--fake] [--table-budget <n>]
```

## What it reports

The status command reads your project environment and reports:
- **Functions**: Deployed functions along with their last deploy time.
- **Slate**: The Slate URL for the project.
- **Data Store Tables**: The table count. When `--table-budget <n>` is passed, it compares the table count against the org-wide table-create limit (which Catalyst does not publish itself).
- **Logs**: Recent function errors.

## Unanswered reads and checklists

Anything a read cannot answer becomes a one-line console checklist step (e.g., a missing resource check). It does not throw a stack trace, but instead provides a plain-language checklist step to guide you.

## Demo mode (`--fake`)

The `--fake` flag runs the same path against a built-in fake, returning healthy synthetic demo data for any project ID. It prints a label on the first line indicating it is fake data (e.g. `FAKE DATA (demo mode): not your project`).

## JSON output (`--json`)

Pass `--json` to output the status report as structured JSON instead of plain text. When combined with `--fake`, the JSON payload will carry `"fake": true`.
