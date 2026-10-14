---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent REFUSES to hand-edit the generated files under `functions/` or `client/`, citing the fundamental skill rule:
   > "Generated files are never edited by hand: a hand edit is lost on the next regenerate."
2. The agent directs the user to use the typed `c2c edit` command instead (e.g. `c2c edit orders-app add-field Orders Tracking_Number --type text`), which records the operation in the edits log (`orders-app.edits.json`).
3. The agent shows the plan diff first without `--apply`, explaining that edits are only applied after the user reviews and agrees.

FAIL the run if the agent offers or attempts to directly modify generated source files by hand, or fails to cite that manual edits will be lost on subsequent regenerations.
