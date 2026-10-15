# Host environment rules for the c2c plugin

Operating rules for where the official Catalyst agent skills live on each host. `~` is the user's home directory; `<path>` is a user-chosen absolute path.

## Agent skills

### Official Catalyst skill install locations

Rule: the official Catalyst agent skills resolve on disk at, in order: `$C2C_CATALYST_SKILLS_DIR/catalyst-by-zoho/SKILL.md`; `~/.claude/skills/catalyst-by-zoho/SKILL.md` (plus `~/.claude/skills/catalyst-*/skills/catalyst-by-zoho/SKILL.md`); `~/.claude/plugins/cache/*/catalyst-by-zoho/*/skills/catalyst-by-zoho/SKILL.md`; `~/.claude/plugins/marketplaces/catalyst-by-zoho/skills/catalyst-by-zoho/SKILL.md`; `${CODEX_HOME:-~/.codex}/skills/catalyst-by-zoho/SKILL.md`.

- `C2C_CATALYST_SKILLS_DIR` is authoritative: when set, its directory is searched first. Set it on hosts that keep the skills outside the standard locations (Cursor, a cloned skills repo).
- The router skill `catalyst-by-zoho/SKILL.md` is the resolvable marker; its `catalyst-*` siblings sit beside it in the same skills directory.
- Only the YAML frontmatter (`name`, `metadata.version`) is read; a missing file in every location is `FAIL D-A1` and the message lists every path searched.
