---
description: Build the full offline migration plan for a Creator app (schema, budgets, functions, Slate, auth, integrations, provisioning steps). No account access.
argument-hint: "<path/to/app.ds>"
---
Load `c2c-migrate`, then the sub-skills the plan touches (`c2c-schema-and-data`, `c2c-logic`, `c2c-ui`, `c2c-auth-and-access`, `c2c-integrations`). Input: $ARGUMENTS

1. Choose a stable app directory under `c2c-out/`, then run `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" plan $ARGUMENTS --out c2c-out/<app-link> --dc <dc>`. This is an offline dry run; it needs no project id, org, or `--confirm`. The data centre can instead come from `"dc"` in `c2c-deploy.json`; omit `--dc` only when that file already sets it.
2. Walk the user through `c2c-out/<app-link>/plan.md` section by section. Resolve every budget decision (unique fields over the cap, side tables, async workflows, degraded views) and record them in `decisions.json`; re-plan until budgets pass.
3. State the doctor status in the summary. If doctor is red, say clearly that nothing past this plan can run until it is green.
