---
description: Precheck and analyze a Zoho Creator .ds export offline (blockers with Creator's own error text, Deluge coverage, readiness).
argument-hint: "<path/to/app.ds>"
---
Load the `c2c-analyze-and-precheck` skill and follow it for: $ARGUMENTS

1. If doctor has not run in the current session, run `/c2c:doctor` first (offline analysis may continue if it is red; label the result "preview").
2. Run `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" precheck $ARGUMENTS --json` and capture its stdout as `c2c-out/<app>/precheck.json` (create the directory first). A blocker exit is a valid report, not a command failure.
3. Run `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" analyze $ARGUMENTS --json` and capture its stdout as `c2c-out/<app>/analyze.json` (create the directory first). Add `--quality` only when the user asks for compile and smoke-quality checks.
4. Present: blockers to fix in Creator, what converts with TODOs, out-of-scope items, and the limits the plan will have to decide. Remind the user the score alone does not mean "ready".
