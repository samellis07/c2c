# c2c — Zoho Creator → Zoho Catalyst

c2c converts a Zoho Creator app (`.ds` export plus its records) into a Zoho Catalyst project: Data Store tables, Node.js functions translated from Deluge, a Slate web app, Authentication, Job Scheduling and the rest. It runs inside your own agent (Claude Code, OpenAI Codex or Cursor), on your own machine, against your own Zoho accounts.

## Prerequisites (checked by `/c2c:doctor` before anything runs)

1. **The official Catalyst plugin** — its agent skills and its Catalyst MCP connector, signed in to the Zoho account that owns your Catalyst org.
2. **The Catalyst CLI** ≥ 1.27.2, signed in (`catalyst login --dc <your dc>`) to the same org and data centre.
3. **Node.js 20 or 22** (`>=20.20 <23`; 20.20.1 recommended).
4. A Creator `.ds` export of your app (and, to move data, CSV exports of its reports).
5. A free Catalyst project slot (one project per migrated app; an account allows 50).

## Install

The converter ships as a local build (`plugin/vendor/c2c`), so install from a checkout, not from the marketplace shorthand. From the repo root:

```sh
npm ci
npm run build
node scripts/vendor-plugin.mjs
```

- **Claude Code:** `claude plugin marketplace add "$PWD/plugin"` then `claude plugin install c2c@creator-to-catalyst` (or the same two steps as `/plugin` commands inside Claude Code). Then run `/c2c:doctor`.
- **OpenAI Codex:** unpack the plugin once (clone the repo and build it as above, or copy the `plugin/` folder somewhere stable), then copy its skills and commands into the host's folders — from the repo root:
  ```sh
  PLUGIN_DIR="$PWD/plugin"   # path to the unpacked plugin/ folder
  mkdir -p ~/.codex/skills ~/.codex/prompts
  cp -R "$PLUGIN_DIR"/skills/* ~/.codex/skills/
  for c in "$PLUGIN_DIR"/commands/*.md; do cp "$c" ~/.codex/prompts/c2c-$(basename "$c"); done
  ```
  Start OpenAI Codex in your workspace, run `/prompts:c2c-doctor`.
- **Cursor:** unpack the plugin once (as above) and point the project at it with the rule template — from the repo root:
  ```sh
  PLUGIN_DIR="$PWD/plugin"   # path to the unpacked plugin/ folder
  mkdir -p .cursor/rules
  sed "s|<c2c-plugin>|$PLUGIN_DIR|g" "$PLUGIN_DIR"/templates/cursor-rule.mdc > .cursor/rules/c2c.mdc
  ```
  Then ask the agent to run the c2c doctor.

Installing never edits your MCP configuration; paste the snippet for your host yourself (see `templates/mcp-snippets.md`).

## Flow

`/c2c:doctor` → `/c2c:analyze` → `/c2c:plan` → `/c2c:migrate` (provision → deploy → data) → `/c2c:verify` (probes, parity, cutover). `/c2c:rollback` and `/c2c:troubleshoot` help when something goes wrong. See the [command map](C2C.md#4-command-map) for the mapping of command groups, slash commands, skills, CLI verbs, and human steps.

## Privacy

- Everything runs locally. The plugin folder is never written to. Outputs go to `c2c-out/` in your workspace.
- No telemetry. Reports contain counts and names, not record values.
- c2c never sees your passwords or tokens: you sign in to the Catalyst CLI and the MCP connector yourself, and you do every console click and consent.

## License

MIT.
