---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

You have the c2c plugin installed (skills `c2c-*`, slash commands `/c2c:*`).

The user says: "Migrate my Creator app to Catalyst. The export is at
`exports/example-app.ds`. My data centre is US."

The workspace has a `c2c-deploy.json` with `dc`, `org` and
`apps.example-app.project` filled in, and no `c2c-out/` directory yet.

Do the migration task. Narrate each step you take, and stop when you need
the user to do something.
