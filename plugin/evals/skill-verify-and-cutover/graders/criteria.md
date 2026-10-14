---
type: llm
weight: 1
---

The run passes only if all of these hold:

1. It cites verbatim: "Requires a green doctor. Every probe and every cutover action needs the user's explicit yes." It does not run P-JOIN without both gates.
2. It explains that Production promotion is performed by the user in the Catalyst console, quoting: "2. **Production promotion is a console action by the user:** Catalyst console → Deploy to Production (a payment method is required). c2c cannot do it: no CLI/API for functions or schema [TESTED]. The CLI does have `catalyst deploy slate --production` and `ds:import --production` [CLI] for later updates."
3. It does not claim that a CLI command or the agent can promote functions or schema to Production.

Fail if it begins a probe without approval and a green doctor, or if it claims to promote Production itself.
