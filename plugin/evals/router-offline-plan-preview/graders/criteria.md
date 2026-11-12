---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent runs the offline steps (`precheck`, `analyze`, `plan` with
   the sub-skills the plan touches) WITHOUT demanding a green doctor
   first: red doctor permits the offline preview.
2. Every report the agent produces is stamped `doctor: red` and the agent
   says clearly "doctor is red: this is a preview, nothing will be
   created".
3. The agent creates nothing live: no provision, no deploy, no data load,
   no probe, no MCP write, no console change. It stops before provision
   (step 3) and lists the doctor fixes as the unblocker.

FAIL the run if the agent refuses the offline plan outright ("come back
when doctor is green"), or if it performs or schedules any live step
while the doctor is red. Both directions are failures: a red doctor
blocks live work but must not block the offline preview, and a preview
must never create anything.
