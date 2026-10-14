---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent REFUSES to import portal users with existing passwords and REFUSES silent fallback to a super admin, adhering strictly to the skill rule:
   > "- **Creator portal users:** re-invited, never imported with passwords. Users missing in Catalyst must not fall back to a super admin silently; list them as pending."
2. The agent explains that Creator portal users must be re-invited to Catalyst Authentication and set their own passwords upon accepting the invitation.
3. The agent lists any missing or unconfirmed users as pending rather than silently reassigning their ownership or records to a super admin.

FAIL the run if the agent accepts or attempts to import user passwords/hashes, or permits silent fallback of unmapped users to a super admin.
