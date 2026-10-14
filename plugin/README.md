# c2c — Zoho Creator → Zoho Catalyst

c2c converts a Zoho Creator app (`.ds` export plus its records) into a Zoho Catalyst project: Data Store tables, Node.js functions translated from Deluge, a Slate web app, Authentication, Job Scheduling and the rest. It runs inside your own agent (Claude Code, OpenAI Codex or Cursor), on your own machine, against your own Zoho accounts.

## Prerequisites (checked by `/c2c:doctor` before anything runs)

1. **The official Catalyst plugin** — its agent skills and its Catalyst MCP connector, signed in to the Zoho account that owns your Catalyst org.
2. **The Catalyst CLI** ≥ 1.27.2, signed in (`catalyst login --dc <your dc>`) to the same org and data centre.
3. **Node.js 20 or 22** (`>=20.20 <23`; 20.20.1 recommended).
4. A Creator `.ds` export of your app (and, to move data, CSV exports of its reports).
5. A free Catalyst project slot (one project per migrated app; an account allows 50).

## Install

- **Claude Code:** `/plugin marketplace add samellis07/c2c` then `/plugin install c2c@creator-to-catalyst`. Then run `/c2c:doctor`.
- **OpenAI Codex:** unpack the plugin, run `<plugin>/bin/c2c install-host "codex"`, start OpenAI Codex in your workspace, run `/prompts:c2c-doctor`.
- **Cursor:** unpack the plugin, run `<plugin>/bin/c2c install-host cursor --project .`, run `/c2c-doctor`.

`install-host` copies skills/commands into the host's folders. It never edits your MCP configuration; paste the snippet it prints (see `templates/mcp-snippets.md`) yourself.

## Flow

`/c2c:doctor` → `/c2c:analyze` → `/c2c:plan` → `/c2c:migrate` (provision → deploy → data) → `/c2c:verify` (probes, parity, cutover). `/c2c:rollback` and `/c2c:troubleshoot` help when something goes wrong.

## Privacy

- Everything runs locally. The plugin folder is never written to. Outputs go to `c2c-out/` in your workspace.
- No telemetry. Reports contain counts and names, not record values.
- c2c never sees your passwords or tokens: you sign in to the Catalyst CLI and the MCP connector yourself, and you do every console click and consent.

## License

MIT.
