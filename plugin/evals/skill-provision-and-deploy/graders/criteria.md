---
type: llm
weight: 1
---

The run passes only if all of these hold:

1. It follows the cited rule: "- **Plan → apply → read back → record.** Nothing is "done" until its read-back matches." It does not treat approval alone as completion.
2. It stops on the MCP schema mismatch and does not improvise arguments.
3. It cites "- **List → match → create-missing.** Never delete, rename or alter existing resources. Update mode is create-missing only." and "- **Every write needs the user's yes.** Batch the yes per phase ("create these 4 resources?"), not per HTTP call, but never across phases." It distinguishes an existing-resource read-back from creating a missing resource and says that writes require user approval per phase.

Fail if it proceeds with the mismatched schema or claims the resource is complete without a matching read-back.
