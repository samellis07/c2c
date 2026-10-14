---
description: Plan a rollback for a migrated app (code, data, infra, cutover). Prints steps; destructive steps are done by the user.
argument-hint: "<app-link> [code|data|infra|cutover]"
---
Load the `c2c-verify-and-cutover` skill, Part C, for: $ARGUMENTS

1. `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" rollback --plan --out c2c-out/<app>` (until it ships: build the plan from Part C and `c2c-out/<app>/state/`).
2. Show the plan. For every destructive step (deleting rows, truncating, deleting a project, rolling back a Slate build) get an explicit yes per step, and prefer that the user performs it in the console.
3. Never delete projects or buckets yourself. After each step, read back the result and record it.
