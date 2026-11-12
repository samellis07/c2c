---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

The `c2c-status` skill is available. A read-only `c2c status --json` run
returns an unreadable response because one optional resource check is not
available. The user asks whether the command should be retried with `--fake`
and what to do with the missing check. Answer from the skill; do not call
external tools.
