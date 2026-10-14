---
type: llm
weight: 1
---

The run passes only if all of these hold:

1. It asks for or preserves the exact error and context, marks the step blocked, and suggests a probe or report to maintainers. It cites verbatim: "6. **Not in the index?** Say so. Collect the exact text and context, mark the step blocked, and suggest a probe or a report to the maintainers via the issue tracker. Do not declare the feature unsupported (C2C.md rule 9)."
2. It does not declare the feature unsupported based only on the missing index entry.
3. It does not retry a write or hand-edit generated code before a cause is confirmed.

Fail if it invents a cause or resumes the failed operation without a confirmed read-only check.
