---
description: Verify a migrated app (probes, smoke, parity, export diff, counts) and guide cutover to Production.
argument-hint: "<app-link> [--cutover]"
---
Load the `c2c-verify-and-cutover` skill for: $ARGUMENTS

1. Doctor must be green for this scope.
2. The plan may name empirical probes, but there is no `c2c probe` command yet. Do not invoke a guessed probe command; follow the skill's read-only/manual procedure and ask before any probe that creates or deletes scratch resources.
3. Smoke (the user runs the app's `#/admin/smoke` page signed in once and pastes the result code it shows; ask for it and run `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" smoke <ds> --result-code <code>` — a saved block works with `--result <file>`), parity rules, then `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" proof <ds> --out c2c-out/<app>` for the offline proof report. There is no `c2c verify` command; use the proof report and manual checks described in the skill.
4. Summarise `verify/report.json` and the app's maintenance list.
5. With `--cutover`: walk Part B of the skill. Production promotion, freezing Creator and switching links are the user's actions; you run the checks after each.
