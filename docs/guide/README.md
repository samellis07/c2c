# Move a Creator app to Catalyst with an AI chat — start here

This guide is for the **Creator app owner who does not write code**.
You migrate by talking to an AI assistant (Claude, or another LLM)
that has the **c2c plugin** installed. You never type commands:
the AI runs them and tells you what is happening in plain words.
There are exactly **five things only you can do**, all in
[chapter 4](04-your-five-steps.md) — everything else is the AI's job.

## The chapters

1. [What c2c does — and does not do](01-what-c2c-does.md) — what gets converted, and what stays manual (every manual item is counted and listed, never hidden).
2. [Before you start](02-before-you-start.md) — the account, the Creator export, the plugin, and the doctor check.
3. [The journey, step by step](03-the-journey.md) — what the AI does in the chat: analyse, plan, provision, deploy, data load.
4. [Your five steps](04-your-five-steps.md) — the ONLY things that need a human: what you see on screen, and how the AI double-checks each one.
5. [Reading the migration report](05-reading-the-report.md) — where your app stands and what still needs a human.
6. [Troubleshooting](06-troubleshooting.md) — the common blocks and what to do about each.
7. [Glossary](07-glossary.md) — the words the AI will use, in plain language.

## The one rule of the whole trip

The AI never guesses and never hides bad news. Anything it cannot
convert becomes a **TODO item in your migration report** — counted,
named, and assigned — never a silent shortcut. That promise is the
project's [no-silent-drop rule](../../docs/no-silent-drop.md), and it is
enforced on every run by rule 8 in
[the c2c rules](../../plugin/C2C.md).

Technical sources for reviewers: the [c2c plugin readme](../../plugin/README.md),
[the migration playbook](../../plugin/skills/c2c-migrate/SKILL.md),
[the route map](../../plugin/references/route-map.md),
[the doctor spec](../../plugin/references/doctor-spec.md), and
[the human checklist](../../docs/human-steps.md).
