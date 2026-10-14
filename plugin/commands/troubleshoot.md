---
description: Diagnose a c2c migration error from its exact text using the error index; names the cause, the confirming read-only check and the fix.
argument-hint: "<error text or step id>"
---
Load the `c2c-troubleshooting` skill and `references/error-index.md`. Problem: $ARGUMENTS

1. Get the exact error text, the command/tool, and the step id. For "contact Catalyst support" CLI errors, re-run the same command with `--verbose` (ask first if it writes).
2. Match it in the index, confirm the cause with the read-only check, then give the fix. User actions go to the user; c2c defects are reported to the maintainers via the issue tracker.
3. Resume the failed step with `--resume` or `c2c provision --next`. Never delete resources to start over.
