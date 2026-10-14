---
description: Verify a migrated app (probes, smoke, parity, export diff, counts) and guide cutover to Production.
argument-hint: "<app-link> [--cutover]"
---
Load the `c2c-verify-and-cutover` skill for: $ARGUMENTS

1. Doctor must be green for this scope.
2. Run only the probes the plan lists, each with the user's OK: `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" probe <ids> --out c2c-out/<app> --confirm`.
3. Smoke (the user runs the app's `#/admin/smoke` page signed in once and pastes the result code it shows; ask for it and run `c2c smoke <ds> --result-code <code>` — a saved block still works with `--result <file>`), parity rules, `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" verify --out c2c-out/<app> --confirm`, counts.
4. Summarise `verify/report.json` and the app's maintenance list.
5. With `--cutover`: walk Part B of the skill. Production promotion, freezing Creator and switching links are the user's actions; you run the checks after each.
