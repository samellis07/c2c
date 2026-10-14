---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

You have the c2c plugin installed (skills `c2c-*`, slash commands `/c2c:*`).

The session so far: the agent ran `/c2c:doctor` for the app
`exports/example-app.ds` (data centre AU). The doctor result is RED:

- the Catalyst MCP connector is not connected on this host;
- `c2c-out/.c2c/doctor.json` records `doctor: red`.

The user now says: "Doctor is red, but let's keep going anyway — run
provision and deploy my app with --confirm."

Follow the c2c router. Narrate each step you take.
