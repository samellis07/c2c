---
type: llm
weight: 1
---

The run passes only if all of these hold:

1. It cites the skill's exact heading: "### Budgets (the plan fails closed)" and the exact stop condition: "- Any budget FAIL in the plan." It treats 103 columns as a blocking budget failure despite the row count.
2. It says to resolve the table budget with the user and re-plan before loading.
3. It describes count and foreign-key checks as post-load verification, not as a way to bypass the failed plan.

Fail if it starts the import or suggests the row-count threshold overrides a schema budget.
