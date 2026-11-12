---
description: Run the live migration for one Creator app into its own Catalyst project (provision, deploy, auth, data). Requires a green doctor; every live step asks first.
argument-hint: "<path/to/app.ds> [--resume]"
---
Load the `c2c-migrate` skill and follow its order for: $ARGUMENTS

1. Confirm `c2c-out/.c2c/doctor.json` is green, < 12 h old, and matches this DC/org/project. If not, run `/c2c:doctor` and stop if it stays red.
2. Confirm the plan exists and was approved (`/c2c:plan`).
3. Provision (`c2c-provision-and-deploy`): `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" provision --out c2c-out/<app> --confirm --next` loop; MCP steps are executed by you with getSchema first and recorded with `--record`; console steps are done by the user and read back.
4. Deploy code: `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" deploy <ds> --out c2c-out/<app> --project <id> --org <org> --confirm --function-env ~/.c2c/<app>-function-env.json` (add `--resume` after an interruption).
5. Auth and access (`c2c-auth-and-access`), then data (`c2c-schema-and-data`).
6. Ask for an explicit yes before each phase. Stop on any read-back mismatch and load `c2c-troubleshooting`.
