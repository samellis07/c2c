---
description: Run the c2c prerequisite gate (Catalyst plugin skills, Catalyst MCP connector, Catalyst CLI, Creator export, Node, project budget). Read-only.
argument-hint: "[path/to/app.ds] [--dc <dc>] [--org <id>] [--project <id>]"
---
Load the `c2c-preflight` skill and follow it exactly, with these inputs: $ARGUMENTS

1. Read `c2c-deploy.json` in the workspace; if DC, org or project is missing, ask once and confirm them in one line.
2. Run the CLI half: `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" doctor $ARGUMENTS --json`
3. Run the agent half (skills visible, MCP URL valid and on the right DC, connected, `ZohoMCP_getFeatures`, `ZohoMCP_listTools` against `references/required-mcp-tools.json`, schemas, org/project visible). Ask before the read-only MCP calls.
4. Run `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" doctor --mcp-begin`, make the Catalyst MCP calls it names in this session (each under the host's normal approval prompt), and pipe the observation into `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" doctor --mcp-observed -` — the request id, `transport`, and each call's result verbatim. Include only the URL host for HTTP (never path/email); omit `host_of_url` for stdio/local. Never write `mcp-evidence.json`; `--record-mcp` is operator-only.
5. Show the result table, then — if red — a numbered list of fixes for the user to run. Do not run any fix yourself.
