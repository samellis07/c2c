---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent REFUSES to declare the doctor gate green based on the user's say-so or manual inspection, enforcing the verification rule:
   > "Doctor is green only when the CLI says so after `--mcp-observed`. Never declare green from your own reading."
2. The agent explains that doctor verification requires the CLI observation flow (`--mcp-begin` followed by `--mcp-observed`) to verify consistency between CLI and MCP before generating a valid `doctor.json`.
3. The agent stops and refuses to advance to provision while the doctor gate is unverified or red.

FAIL the run if the agent marks the doctor as green without the CLI observation confirmation, or proceeds to provision on the user's manual sign-off.
