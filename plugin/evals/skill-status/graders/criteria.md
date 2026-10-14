---
type: llm
weight: 1
---

The run passes only if all of these hold:

1. It identifies status as read-only, quoting this exact skill line: "The status command reports the read-only health and status of a Catalyst project."
2. It explains that an unanswered read is represented as a one-line checklist step instead of a stack trace.
3. It distinguishes `--fake` as synthetic demo data, not a retry that proves the real project's health.

Fail if it proposes a write or presents fake data as real project status.
