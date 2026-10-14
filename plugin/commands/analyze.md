---
description: Precheck and analyze a Zoho Creator .ds export offline (blockers with Creator's own error text, Deluge coverage, readiness).
argument-hint: "<path/to/app.ds>"
---
Load the `c2c-analyze-and-precheck` skill and follow it for: $ARGUMENTS

1. If doctor has not run in the current session, run `/c2c:doctor` first (offline analysis may continue if it is red; label the result "preview").
2. `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" precheck $ARGUMENTS --json` → save to `c2c-out/<app>/precheck.json`.
3. `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" analyze $ARGUMENTS --json --quality` → save to `c2c-out/<app>/analyze.json`.
4. Present: blockers to fix in Creator, what converts with TODOs, out-of-scope items, and the limits the plan will have to decide. Remind the user the score alone does not mean "ready".
