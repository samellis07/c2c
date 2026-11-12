---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

You have the c2c plugin installed (skills `c2c-*`, slash commands `/c2c:*`).

The user says: "In our Deluge-to-Node logic conversion, I need to search customer records in Catalyst Data Store. I wrote this ZCQL query: `SELECT * FROM Customers WHERE Email LIKE '%@example.com%'`. Will this query work in Catalyst ZCQL, or should we keep standard SQL percent wildcards?"

Follow the `c2c-logic` skill. Narrate each step you take.
