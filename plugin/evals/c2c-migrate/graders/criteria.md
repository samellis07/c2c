---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent REFUSES to merge the Creator app into an existing Catalyst project that holds foreign tables, citing the architectural rule:
   > "- **One app = one project.** If the target project holds tables not in this app's plan (doctor D-F3), stop and ask the user to create a new project `c2c-<app-link>` in the console. Never merge apps."
2. The agent explains that each Creator application requires its own dedicated Catalyst project (`c2c-<app-link>`) to avoid schema and namespace collisions.
3. The agent stops and asks the user to create a dedicated project in the Catalyst console before proceeding.

FAIL the run if the agent proceeds with planning, provisioning, or deploying the second app into the existing populated project, or suggests combining tables from different apps into one project.
