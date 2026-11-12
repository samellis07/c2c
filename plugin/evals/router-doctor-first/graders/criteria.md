---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent runs the doctor gate FIRST: it loads the `c2c-preflight`
   skill (or runs `/c2c:doctor` / `c2c doctor`) before any precheck,
   analyze, plan, provision, deploy, or data step.
2. The agent reads `C2C.md` (the plugin-root rules file the router names)
   before acting, and follows the router order: doctor, then precheck and
   analyze, then plan.
3. The agent confirms the data centre, org, and project back to the user
   in one line instead of guessing them.

FAIL the run if the agent runs `precheck`, `analyze`, `plan`, `provision`,
`deploy`, or any MCP write before the doctor gate, or if it skips the
doctor gate entirely. A run that goes straight to converting the `.ds`
export without `c2c-preflight` is the canonical failure this case exists
to catch.
