---
name: c2c-preflight
description: "c2c prerequisite gate (doctor). Verifies, read-only, that the official Catalyst plugin skills are installed, the Catalyst MCP connector is connected on the right data centre with the required tools, the Catalyst CLI is installed and signed in to the same org, Creator exports are usable, a supported Node (20 or 22, >=20.20 <23) is active, and the project budget fits. Use at the start of every c2c session, for '/c2c:doctor', 'c2c doctor', 'invalid MCP url', 'MCP not connecting', 'PERMISSION_NEEDED', 'wrong DC', or before any provision/deploy/data step."
metadata:
  version: "0.2.0"
---

# c2c preflight (doctor)

The full check catalogue with every pass/fail message is `references/doctor-spec.md`. This skill is the procedure.

## Rules

- **Read-only.** You never fix anything here. You never sign in, never complete an OAuth screen, never edit the user's MCP config files. You print the fix; the user runs it.
- Never print or store a URL path from an MCP config (personal Zoho MCP URLs contain a token). Record the host only.
- Never record the user's email (it is shown on screen by `catalyst whoami`; do not write it to any file).
- Run once per session; re-run only when the DC/org/project changes, an MCP call returns `PERMISSION_NEEDED`, or the MCP disconnects.
- **Rule — default settings only.** Never drive a browser or console, never change permission rules, never accept a pre-made or user-supplied evidence file: the observation in step 3g is built only from MCP calls made live in the current session, each under the host's own approval (C2C.md rule 13).
- **One credential, one refresher (C2C.md rule 14).** Run no `catalyst`/`c2c` command in parallel with another run or a keep-fresh loop — a second refresher on the same login rotates the refresh token out from under both (`Error when refreshing the access token`). On a read-only `401 INVALID_TOKEN`, re-read the stored token rather than forcing a refresh.

## Steps

### 1. Context

Read `c2c-deploy.json` in the workspace (`dc`, `org`, `env`, `apps.<link>.project`). If any is missing, ask the user once and offer to write the file from `templates/c2c-deploy.example.json` (it holds no secrets). Confirm in one line: "Target: DC <dc>, org <org>, project <id> (Development). Correct?"

### 2. CLI half

Run:
```sh
"${CLAUDE_PLUGIN_ROOT}/bin/c2c" doctor --app <path/to/app.ds> --json
```
(OpenAI Codex/Cursor: `<plugin-root>/bin/c2c doctor …`.) It runs D-A1 (skills on disk), D-C1..C5 (CLI installed, ≥ 1.27.2, `catalyst whoami`, `catalyst --org <org> project:list`, DC), D-D1..D3 (Creator export/data), D-E1..E4 (Node >=20.20 <23, vendor integrity, workspace), D-F1/F2/F5/F6 (budgets from the plan if it exists).

If `bin/c2c` exits 6, stop: Node or the plugin files are wrong; give the printed fix.
If D-A1 reports the plugin skills directories could not be read (for example a sandboxed host), set `C2C_CATALYST_SKILLS_DIR` to the installed Catalyst skills directory and re-run.

### 3. Agent half (you, with host tools)

**3a. Catalyst skills visible (D-A2, D-A3).**
- Claude Code: run `claude plugin list --json`; find `catalyst-by-zoho` with `enabled: true`. Also confirm these skills are in your available-skills list: `catalyst-by-zoho`, `catalyst-zoho-mcp`, `catalyst-basics`, `catalyst-datastore`, `catalyst-functions`, `catalyst-slate`, `catalyst-authentication`, `catalyst-stratus`.
- OpenAI Codex: `ls ~/.codex/skills/catalyst-by-zoho/SKILL.md` and the seven others.
- Cursor: `ls "$C2C_CATALYST_SKILLS_DIR"/catalyst-by-zoho/SKILL.md`.
- If two copies of the plugin are installed (for example `@synced` and `@claude-plugins-official`), WARN and ask the user to disable one.

**3b. MCP configured with a valid URL (D-B1, D-B2).**
- Claude Code: `claude mcp list`, then `claude mcp get <name>` for each server whose host ends in `.zohomcp.<tld>`.
- OpenAI Codex: `codex mcp list`, `codex mcp get catalyst-by-zoho`.
- Cursor: read `.cursor/mcp.json` and `~/.cursor/mcp.json`.
- For each candidate check: `url` parses as a URL (a `<…>` placeholder does not: that is the "invalid MCP url" failure); `https`; path ends `/mcp/message`; the host TLD matches the target DC (`in`→`.in`, `us`→`.com`, `eu`→`.eu`, `au`→`.com.au`, `ca`→`.ca`, `sa`→`.sa`, `jp`→`.jp`, `uae`→`.ae`).
- Fix to print on failure: the matching snippet from `templates/mcp-snippets.md`, e.g. `claude mcp add --scope user --transport http catalyst-by-zoho https://catalystbyzoho.zohomcp.<tld>/mcp/message`, then restart and sign in.
- A local/stdio bridge has no URL host: report `transport: "stdio"` (or `"local"`) and omit `host_of_url`. Its org/DC/project binding is proven server-side only: the probe bucket the `--mcp-begin` request names must land in the selected project, which the doctor verifies with its own REST read-back. Never guess or type a host/DC; if the probe is not read back, relay the D-B1/D-B2 failure and stop.

**3c. Connected (D-B3).** Look at your tool list:
- **meta shape:** `ZohoMCP_getFeatures`, `ZohoMCP_listTools`, `ZohoMCP_getSchema`, `ZohoMCP_executeTool` present;
- **direct shape:** tools ending in `CatalystbyZoho_<Name>` present;
- only `authenticate` / `complete_authentication` visible → not signed in. Fix: "Open `/mcp` (Claude Code) or run `codex mcp login catalyst-by-zoho`, and finish the Zoho sign-in in your browser."

**3d. Features and tools (D-B4, D-B5).**
- Meta: call `ZohoMCP_getFeatures` (read-only). Then `ZohoMCP_listTools`, following `has_more` until it is false.
- Compare the tool names with `references/required-mcp-tools.json` (the one list; the CLI checks the same file): all of `base` ("needed by doctor"); and, once `c2c plan` has run, the tools the plan names (`c2c-out/<app>/plan.json` `mcpTools.plan` plus every MCP tool a step in `provision/plan.json` calls: "needed by this app's plan"). A tool for a feature the app does not use (for example email or jobs) is never demanded.
- On D-B5 FAIL, relay the CLI's finding as given — the exact missing names under each heading — and this **one-time setup step** (part of connecting the Catalyst plugin; it is not one of the five migration steps):
  > In the Zoho MCP console (mcp.zoho.com), open your server, Tools, Config Tools, and enable these Catalyst by Zoho tools (or enable all). Then restart your AI chat session so the new tools load.
  
  Then stop: the new tools appear only in a new session, so the user re-runs doctor there.

**3e. Schemas (D-B6).** For each tool the plan uses: meta `ZohoMCP_getSchema({ query_params: { tool_name: "CatalystbyZoho_<Name>" } })`; direct: read the tool's input schema. Record the required `path_variables` and body keys.

**3f. Identity (D-B7).** `CatalystbyZoho_List_All_Organizations` must include the target org. The project is checked through the Catalyst CLI (`catalyst --org <org> project:list`, D-C4) — Never call `CatalystbyZoho_List_All_Projects` or `CatalystbyZoho_Get_Project_By_Id`: they return project secrets (jwtSecret, clientSecret) into the transcript. On `PERMISSION_NEEDED` or not found: FAIL — "The MCP is signed in to a different Zoho account or DC. Reconnect it with the account that owns org <org>." Never switch to another project.

**3g. Record — observed calls, never a hand-written file.**
1. `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" doctor --mcp-begin` — opens a one-time request (`c2c-out/.c2c/mcp-request.json`, 15-minute expiry) and prints the Catalyst MCP calls to make and the observation shape.
2. Make the calls it names in this session, behind the host's own approval prompt: first `CatalystbyZoho_Create_Bucket` — a short-lived probe bucket named after the request id, the write the doctor reads back over the Catalyst REST API to prove the connector is bound to the selected org/DC/project — then `CatalystbyZoho_List_All_Organizations`. Never call `CatalystbyZoho_List_All_Projects` or `CatalystbyZoho_Get_Project_By_Id`: they return project secrets (jwtSecret, clientSecret) into the transcript. The doctor refuses an observation that quotes either.
3. Pipe one observation into `"${CLAUDE_PLUGIN_ROOT}/bin/c2c" doctor --mcp-observed -` (stdin): the request id, server name, `transport`, `shape`, Catalyst tool names, and each call's result verbatim. For HTTP include only the URL host (never its path); for stdio/local omit `host_of_url`. The doctor derives org ids from the observed result and attests the binding itself — never set `orgs`, `orgDcs`, `projects`, `at`, `workspace` or `binding`. Never write `mcp-evidence.json`: a free-standing evidence file is operator-only (`c2c doctor --record-mcp <file> --operator`), not the plugin path.
4. Afterwards remove the probe bucket with `CatalystbyZoho_Delete_Bucket` exactly as the doctor output prints it (it re-prints the call while the probe may still exist).
The CLI digests each result, checks consistency (D-V1..V3: DC, org, freshness; projects come from the Catalyst CLI list, D-C4) and writes the final `doctor.json`.

### 4. Report

Show one table: id, status, one-line detail. Then, if red, a numbered **"What you need to do"** list with only the user-run fixes, in this order: install/enable the Catalyst plugin → fix the MCP URL → sign in to the MCP → enable the missing Catalyst MCP tools (D-B5, one-time) → install/upgrade the CLI → `catalyst login --dc <dc>` → Node 20 or 22 → Creator export → free a project slot.

## Verification

Doctor is green only when the CLI says so after `--mcp-observed`. Never declare green from your own reading.

## Stop conditions

- Any FAIL → stop before provision. Offline steps (precheck/analyze/plan) may run as a labelled preview.
- Vendor integrity failure (D-E3) → stop everything; the plugin is modified.
- The user declines to sign in → stop; explain that c2c cannot do it for them.

## What to ask the user

- DC/org/project (once).
- Permission to run the read-only MCP calls in 3d–3f ("I'll list your Catalyst MCP tools and confirm the org; read-only. OK?").
- Each fix, as an instruction for them to run; then "tell me when done" and re-run only the failed checks.
