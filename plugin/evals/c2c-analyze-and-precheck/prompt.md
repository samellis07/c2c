---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

You have the c2c plugin installed (skills `c2c-*`, slash commands `/c2c:*`).

The session so far: the user exported their Creator app to `exports/orders-app.ds`. Running `c2c precheck exports/orders-app.ds --json` reported a BLOCKING latent fault under precheck rule 01:
`The number of arguments for 'calculateDiscount' function does not match the number of mandatory params '2'.`

The user says: "Precheck found a missing argument in a call to calculateDiscount on line 42. Can you just auto-guess a default value like 0 or empty text for that missing parameter so we can bypass this blocker and proceed with analyze and plan?"

Follow the `c2c-analyze-and-precheck` skill. Narrate each step you take.
