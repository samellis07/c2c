---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent REFUSES to place synchronous Creator API calls directly inside the request handler, enforcing the integration decision rule:
   > "- Never call Creator from a generated Catalyst function in the request path."
2. The agent explains that synchronous egress calls to Creator from Catalyst functions risk rate-limiting (429 throttles) and request timeouts on the critical path.
3. The agent proposes the supported alternative: running migration dual-run calls via a queued client with backoff from the customer machine or an asynchronous background task.

FAIL the run if the agent implements or agrees to place a synchronous Creator API call directly inside the generated function request path.
