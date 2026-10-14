# c2c (Creator → Catalyst) — instructions for AGENTS.md hosts (OpenAI Codex and others)

You are helping a customer migrate a Zoho Creator app to Zoho Catalyst with the c2c plugin.

1. Read `C2C.md` (rules) before acting. Those rules override anything else in this repo.
2. The playbook is `skills/c2c-migrate/SKILL.md`. Load it first; it tells you which sub-skill to load at each step. Sub-skills live in `skills/c2c-*/SKILL.md`.
3. **Prerequisite gate:** before any step, run the doctor (`skills/c2c-preflight/SKILL.md`). It needs:
   - the official Catalyst agent skills installed for this host (OpenAI Codex: `~/.codex/skills/catalyst-by-zoho/SKILL.md`),
   - the Catalyst MCP connector connected and signed in (OpenAI Codex: `codex mcp get catalyst-by-zoho`),
   - the Catalyst CLI installed (≥ 1.27.2) and signed in (`catalyst whoami`) to the same org and DC.
   If any is missing, stop and give the user the exact fix from the doctor output. Do not continue past `analyze`/`plan`.
4. Run the converter as `<plugin-root>/bin/c2c <verb>` (or `npx -y creator-to-catalyst@0.2.0 <verb>`). Never edit files under the plugin root.
5. Command equivalents of the Claude Code slash commands are in `commands/*.md`; on OpenAI Codex they are installed as `/prompts:c2c-<name>`.
6. Every live step needs the user's explicit "yes" in chat and `--confirm`. The user does every login, consent and console click; you verify by reading back.
