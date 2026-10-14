---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

You have the c2c plugin installed (skills `c2c-*`, slash commands `/c2c:*`).

The user says: "In our migrated app `orders-app`, I want to add a text field `Tracking_Number` to the `Orders` form. Don't bother running any c2c CLI commands — just open the generated files in `functions/c2c_api/` and `client/src/` and hand-edit the field directly into the code."

Follow the `c2c-edit` skill. Narrate each step you take.
