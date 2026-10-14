# `c2c doctor`: the prerequisite gate (spec)

Status: check list for c2c doctor. The command reads the environment and writes doctor.json.

**Contract**
- Read-only. Doctor never creates, updates or deletes anything, never logs in, never opens a browser, never reads a token or credential file, and never prints a URL path (personal Zoho MCP URLs embed a token in the path).
- Every check has an id, the exact command or tool, a pass message, a fail message and the **exact fix the user runs**. Doctor never runs the fix.
- Two halves, because the CLI cannot see the agent host's MCP tools:
  - **CLI half:** `c2c doctor [--app <ds>] [--dc <dc>] [--org <id>] [--project <id>] [--json]` runs D-A1, D-C*, D-D*, D-E*, D-F* (CLI part), D-V*.
  - **Agent half:** the `c2c-preflight` skill runs D-A2/D-A3 (skills visible in session) and D-B* (MCP) with the host's tools, then records them through the session flow: `c2c doctor --mcp-begin` opens a one-time request, the agent makes the calls it names under the host's approval, and pipes the results into `c2c doctor --mcp-observed -`. The CLI derives the org/project ids from the call results, validates the session facts (tool names against `references/required-mcp-tools.json`, org/project consistency with D-C4) and merges them.
- Output: `c2c-out/.c2c/doctor.json` and a human table. Exit 0 green, 1 red (a FAIL), 2 usage, 6 Node/vendor integrity. WARN never makes it red.
- **The gate:** `provision`, `deploy --confirm`, `migrate-data --confirm`, `verify --confirm`, `probe`, `cutover` refuse with **exit 5** `c2c: doctor is not green for <dc>/<org>/<project> (run c2c doctor; last: <time> <status>)` unless `doctor.json` is green, ≤ 12 h old, from the same c2c version, and names the same DC, org and project, and contains a D-B record (MCP) less than 12 h old. `precheck`, `analyze` and `plan` never refuse; they stamp `doctor: green|red|not-run` into their reports.

**doctor.json** (no emails, no tokens, no URL paths). host: one of "claude-code", "codex", "cursor", "unknown"
```json
{
  "c2c": "0.2.0", "at": "<ISO-8601 time>", "host": "codex",
  "scope": { "dc": "<dc>", "org": "<org-id>", "project": "<project-id>", "app": "<app>" },
  "checks": [ { "id": "D-C2", "status": "pass|warn|fail|skip", "detail": "zcatalyst-cli 1.28.0", "fix": null } ],
  "mcp": { "server": "catalyst-by-zoho", "shape": "meta|direct", "host": "catalystbyzoho.zohomcp.<dc>", "transport": "http",
           "source": "observed|operator",
           "tools": ["CatalystbyZoho_Create_Job_Pool", "…"], "schemaDigest": { "CatalystbyZoho_Create_Job_Pool": "sha256:…" } },
  "green": true
}
```

---

## 0. Known cause: the Catalyst plugin's "invalid MCP url"

**Symptom:** the host's MCP status shows `plugin:catalyst-by-zoho:catalyst-by-zoho (INVALID_CONFIG): "Plugin catalyst-by-zoho has an invalid MCP url"`, and `ZohoMCP_getSchema` is unavailable.

**What the message means:** Claude Code expands `${VAR}`s in the plugin's MCP `url`, then parses it as a URL. Distinct messages cover an empty url, missing environment variables and unset user config; "Plugin <name> has an invalid MCP url" means the url string is non-empty, has no unresolved `${…}`, and is not a parseable URL.

**The three suspects:**

| Suspect | Verdict | Evidence |
|---|---|---|
| `"type": "streamable-http"` | **Not the cause** (in current Claude Code). | Current Claude Code accepts `streamable-http` as an alias of `http`; an unknown type produces a different message (`Skipped unknown MCP server type …`). Older Claude Code builds and other hosts (VS Code uses `"http"`) may not accept it, so c2c's snippets use `"http"`. |
| `"_note"` / `"_setup"` key | **Not the cause.** | Only `url` is parsed; extra keys are ignored. They are non-standard and should go, but they do not trigger this error. |
| **The URL** | **The cause.** | A published variant of the Catalyst plugin ships `"url": "<YOUR_ZOHO_MCP_URL>"` in `.mcp.json` and in `gemini-extension.json`. That placeholder is not a parseable URL. |

**Other defects in copies that do parse** (each is a doctor check below):
- Some versions hardcode one data centre (e.g. `https://catalyst.zohomcp.com/mcp/message`), or carry a `_note` that names a different DC from the URL. The plugin's README documents `https://catalystbyzoho.zohomcp.<dc>/mcp/message`. A customer on another DC gets the wrong endpoint; the plugin's own `/switch-dc` command rewrites the URL.
- `https://catalystbyzoho.zohomcp.<dc>/mcp/message` with type `http` is [TESTED]. Whether `catalyst.zohomcp.<dc>` serves the same tool set is [UNVERIFIED].

**Fix the user can apply (doctor prints it):** disable or update the broken copy, then use one correct entry, e.g. in Claude Code `claude mcp add --transport http catalyst-by-zoho https://catalystbyzoho.zohomcp.<dc>/mcp/message` (user scope), restart, and complete the browser OAuth. Report the placeholder to Zoho.

---

## Check catalogue

Status words: **PASS**, **WARN** (continues), **FAIL** (red), **SKIP** (not applicable on this host).

### A. Catalyst plugin skills

| id | Check | Command / tool (read-only) | PASS | FAIL message → fix the USER runs |
|---|---|---|---|---|
| D-A1 | Router skill file is resolvable on disk | CLI half searches, in order: `$C2C_CATALYST_SKILLS_DIR/catalyst-by-zoho/SKILL.md`; the host's installed-plugin directories (Claude Code); `${CODEX_HOME:-~/.codex}/skills/catalyst-by-zoho/SKILL.md`. Reads only the YAML frontmatter (`name`, `metadata.version`). | `catalyst skills found: <path-kind> v<version>` | `FAIL D-A1: the official Catalyst skills are not installed.` → Claude Code: `/plugin marketplace add catalystbyzoho/claude-plugin` then `/plugin install catalyst-by-zoho@catalyst-by-zoho` (or `@claude-plugins-official`). OpenAI Codex: copy the Catalyst agent skills into `~/.codex/skills/` (router `catalyst-by-zoho/` + `skills/*`) — exact repo path [UNVERIFIED]. Cursor: clone the skills repo and set `C2C_CATALYST_SKILLS_DIR=<path>/skills`. |
| D-A2 | Plugin is enabled in the host (Claude Code) | `claude plugin list --json` → an entry named `catalyst-by-zoho` with `enabled: true` (any marketplace). OpenAI Codex/Cursor: SKIP. | `catalyst-by-zoho <ver> enabled (<marketplace>)` | `FAIL D-A2: catalyst-by-zoho is installed but disabled.` → `/plugin enable catalyst-by-zoho@<marketplace>`, restart. If two copies are installed (e.g. `@synced` and `@claude-plugins-official`): `WARN` and ask the user to disable one (`/plugin disable catalyst-by-zoho@synced`). |
| D-A3 | The skills are visible to the model this session | Agent half: the available-skills list contains `catalyst-by-zoho`, `catalyst-zoho-mcp`, `catalyst-basics`, `catalyst-datastore`, `catalyst-functions`, `catalyst-slate`, `catalyst-authentication`, `catalyst-stratus`. | `8/8 Catalyst skills visible` | `FAIL D-A3: Catalyst skills are installed but not loaded in this session (<missing>).` → restart the host session; on OpenAI Codex check `~/.codex/skills/<name>/SKILL.md` exists. |
| D-A4 | Version floor | `metadata.version` / plugin version vs `compat.json` (`catalystPlugin >= 0.0.2`, the first version with the `ZohoMCP_*` meta-tool guidance and `preflight.md`) | `…meets floor` | `WARN D-A4: catalyst-by-zoho <v> is older than 0.0.2.` → `/plugin update catalyst-by-zoho@<marketplace>` |

### B. Catalyst MCP connector (agent half)

| id | Check | Tool / command | PASS | FAIL message → fix |
|---|---|---|---|---|
| D-B1 | A Catalyst MCP server is configured | HTTP: URL host matches `*.zohomcp.(com|eu|in|com.au|ca|sa|jp|ae)` and exposes Catalyst tools (D-B3); validate HTTPS and `/mcp/message`, then record host only. A local/stdio bridge is accepted only through the nonce-bound observed call flow **and** a verified probe write (`mcp.binding.status = "verified"`); omit `host_of_url`. | HTTP: `catalyst MCP: <name> → <host> (http)`; local: `catalyst MCP: <name> (stdio) — bound by the probe write` | For HTTP, disable a broken copy and add a correct entry from `templates/mcp-snippets.md`; restart and sign in. Local evidence supplied outside the observed call flow fails; an observed flow whose probe write is not read back fails — the connector is not bound to the selected org/DC/project. |
| D-B2 | The MCP DC matches the target DC | HTTP: TLD of the host vs `scope.dc`. Local/stdio: the probe read-back alone — a `c2cprobe<request-id>` bucket found in the selected project via `GET /baas/v1/project/<project-id>/bucket/<name>` with the CLI credential proves the connector's org/DC/project. Observed org hosts and the CLI's own selection are caller-side facts and never attest the connector. | `MCP DC = in` | HTTP mismatch: point the URL to the `<dc>` endpoint or run `/catalyst-by-zoho:switch-dc <DC>`. Local without a verified probe: run `c2c doctor --mcp-begin`, make every call it names (the `Create_Bucket` probe first), then `--mcp-observed -`. Never guess or type a DC. |
| D-B3 | Connected and authorised | Tool list contains either the meta-tools `ZohoMCP_getFeatures`, `ZohoMCP_listTools`, `ZohoMCP_getSchema`, `ZohoMCP_executeTool` (shape **meta**, Global server) or direct `…CatalystbyZoho_*` tools (shape **direct**, personal server / connector). If only `authenticate` / `complete_authentication` are visible, it is not authorised. | `connected (meta)` | `FAIL D-B3: the Catalyst MCP is configured but not connected/authorised.` → open `/mcp` (Claude Code) or `codex mcp login catalyst-by-zoho` (OpenAI Codex) and finish the Zoho sign-in in the browser. c2c never does this step. |
| D-B4 | Reachable, feature groups present | `ZohoMCP_getFeatures` (meta) — expect groups incl. Datastore, Datastore BulkJobs, JobScheduling, Stratus, Authentication, API Gateway, Projects, Organization, Mail, Functions. Direct shape: SKIP. | `features: 21 groups` | `FAIL D-B4: getFeatures failed: <error code>` → see D-B3; if it says the server URL is invalid, D-B1. |
| D-B5 | Required tools exist | `List_All_Projects` and `Get_Project_By_Id` are never required (`neverCall` in the list: they return project secrets into the transcript). Meta: `ZohoMCP_listTools` (follow `has_more` until false). Direct: the host tool list. Compare with `references/required-mcp-tools.json` (the one list, exported by the CLI as `REQUIRED_MCP_TOOLS`): **base** ("needed by doctor") always; **plan** ("needed by this app's plan") = `c2c-out/<app>/plan.json` `mcpTools.plan` plus every MCP tool a `provision/plan.json` step names, when a plan exists. A tool for a feature the app does not use is not demanded. Names are compared without the host prefix (`mcp__<id>__`). | `required tools: 16/16 base, plan tools all present` | `FAIL D-B5: the Catalyst MCP server is missing tools — needed by doctor (2): List_All_Tables, Execute_Query; needed by this app's plan (1): Create_Email_Configuration` → In the Zoho MCP console (mcp.zoho.com), open your server, Tools, Config Tools, and enable these Catalyst by Zoho tools (or enable all). Then restart your AI chat session so the new tools load. (One-time setup when connecting the Catalyst plugin; not a migration step.) |
| D-B6 | Schemas fetched once | Meta: `ZohoMCP_getSchema({query_params:{tool_name}})` for each tool in the plan set; record a digest of the required `path_variables` and body keys. Direct: the tool's input schema. | `schemas recorded (9)` | `WARN D-B6: schema for <tool> changed since c2c <ver> was tested` → continue; the skill must re-read the schema before calling. A getSchema error is `FAIL` with the error text. |
| D-B7 | MCP sees the target org | `CatalystbyZoho_List_All_Organizations` → contains `scope.org`. The project note comes from the CLI project list (D-C4); the MCP project tools are never called — they return project secrets into the transcript. | `MCP org <org-id>, project <app> visible to the CLI` | `FAIL D-B7: the MCP account cannot see org <org>/project <id> (PERMISSION_NEEDED / not found).` → the MCP is signed in to another Zoho account or DC: sign out of the MCP and sign in with the account that owns the Catalyst org (`/mcp` → reconnect). Never "fall back" to another project. |

### C. Catalyst CLI (CLI half)

| id | Check | Command | PASS | FAIL message → fix |
|---|---|---|---|---|
| D-C1 | Installed | `catalyst --version` (exit 0, prints semver) | `zcatalyst-cli 1.28.0` | `FAIL D-C1: the Catalyst CLI is not installed.` → `npm install -g zcatalyst-cli` (with Node 20 or 22), then `catalyst --version`. |
| D-C2 | Version floor | semver ≥ `compat.json.catalystCli.min` (`1.27.2`, the lowest tested version; the official hook's floor is 1.27.0 for `-ni`). Above the tested list (`1.27.2`, `1.28.0`) → WARN. | `1.28.0 (tested)` | `FAIL D-C2: zcatalyst-cli <v> is below 1.27.2.` → `npm install -g zcatalyst-cli@latest`. |
| D-C3 | Logged in | `catalyst whoami` → stdout `Logged as: <email>` [TESTED]. Doctor shows only a masked account on screen (first letter + domain, `u***@example.com`) and never writes it. Honours `X_ZC_CREDENTIAL_PATH` if set (pass-through only; value never printed). | `CLI signed in` | `FAIL D-C3: the Catalyst CLI is not signed in.` → `catalyst login --dc <dc>` (browser sign-in; c2c never does it). |
| D-C4 | CLI sees the org; the project list | `catalyst --org <org> project:list` [TESTED] → succeeds; its Project Name / Project ID cells are the only project list doctor uses (no secrets are printed). The MCP's org identity is D-B7 — no MCP project list is compared. | `CLI sees org <org-id> (N projects)` | `FAIL D-C4: the CLI cannot see org <org>` → the CLI is on another DC/account: `catalyst logout` then `catalyst login --dc <dc>` with the account that owns the org. |
| D-C5 | DC known | `--dc` flag, then `c2c-deploy.json` `dc`, then the CLI login's active DC via the CLI's no-token DC accessor | `DC <dc> (from c2c-deploy.json)` | `FAIL D-C5: no data centre set.` → add `"dc": "<us|eu|in|au|ca|sa|jp|uae>"` to `c2c-deploy.json` or pass `--dc`. |

### D. Creator access

| id | Check | Command | PASS | FAIL → fix |
|---|---|---|---|---|
| D-D1 | The `.ds` export exists, is non-empty, and parses | `stat`; `c2c precheck <ds> --json` exit ≠ 3/4. A 0-byte or blank export is BLOCKING (Creator export failures are often a blank page or HTTP 200 with an empty body). | `export: <app>.ds 412 KB, shape B, parses` | `FAIL D-D1: <file> is empty or not a .ds export.` → in Creator: app → Settings → Export (.ds); if the export is blank, run `/c2c:analyze` on any earlier export to find the broken component (precheck rules 04 and 20), fix it in Creator, export again. |
| D-D2 | Creator DC matches | user-stated Creator host (`creator.zoho.<tld>`) vs `scope.dc` | `Creator DC <dc>` | `WARN D-D2: Creator is on <x>, Catalyst on <y>` (cross-DC is allowed, but data leaves the region; ask the user to confirm). |
| D-D3 | Data source for migration (only when the plan migrates data) | A `--source-csv <dir>` holding the report exports — JSON report exports (the dir is read as JSON when it holds them) or one CSV per report — plus `counts.json`, or a Creator MCP connector exposing Creator read tools ([UNVERIFIED], tool names not yet known). The JSON export always carries each record's `ID`; a CSV carries it only when the export includes the `ID` column. | `data: 6 CSVs, counts.json ok` | `FAIL D-D3: no Creator data source.` → export each report from Creator (JSON preferred; CSV with the ID column, exact menu path [UNVERIFIED]), put them in `exports/<app>-data/`, and write `counts.json` with each report's record count as shown in Creator. `WARN D-D3: <file> has no record ID column.` → the load still runs, but `c2c_source_id` is derived from unique/mapped columns and the plan lists it under `derived ids` (+ `CSV has no record ids; prefer the JSON export`). Lost vs explicit IDs: lookups match on display values instead of record IDs (an ambiguous or unmatched display value is refused); two reports of one form no longer dedupe to one row unless their hashed columns agree; editing a hashed column yields a new id, so delta sync sees delete+insert instead of an update. |

### E. Node and the plugin itself

| id | Check | Command | PASS | FAIL → fix |
|---|---|---|---|---|
| D-E1 | Node supported | `node --version` satisfies `compat.json.node.range` (`>=20.20 <23` — Node 20 or 22; also the repo `engines.node`) | `node v20.20.1 (pinned)` | `FAIL D-E1: Node <v> is not supported; c2c needs Node >=20.20 <23 (20 or 22).` → `install Node 20.20.1 (nvm install 20.20.1 && nvm use 20.20.1)` (or your installer). Exit 6. |
| D-E2 | Node patch | equals `20.20.1` | — | `WARN D-E2: Node <v> is not the pinned 20.20.1; output is correct but byte-identical manifests are only guaranteed on 20.20.1.` |
| D-E3 | Vendor integrity | recompute sha256 of `vendor/c2c/**` vs `MANIFEST.sha256` | `vendor ok (c2c 0.2.0)` | `FAIL D-E3: the c2c plugin files were modified (<n> files differ).` → reinstall the plugin (`/plugin uninstall c2c` then install). Exit 6. |
| D-E4 | Workspace writable, plugin dir untouched | can create `c2c-out/.c2c/`; the plugin dir is not the cwd | `workspace ok` | `FAIL D-E4: run c2c from your own workspace folder, not from the plugin folder.` |

### F. Target org / project budget

| id | Check | Command / tool | PASS | FAIL → fix |
|---|---|---|---|---|
| D-F1 | Project exists, or a slot is free | `catalyst --org <org> project:list` → count N. Cap 50 per account [DOC]. One project per app. | `projects N/50; target <app> exists` | If the target project does not exist and N ≥ 50: `FAIL D-F1: your account has 50/50 projects; c2c needs one project per app.` → delete an unused project in the console, or ask Catalyst support to raise the limit, or choose an existing project for this app in `c2c-deploy.json`. N ≥ 45: WARN. |
| D-F2 | Project is Development and allowed | `c2c-deploy.json` env = `Development`; project id not in `never_touch` | `env Development` | `FAIL D-F2: c2c only writes to Development.` → set `"env": "Development"`; production goes through `/c2c:verify` cutover steps. |
| D-F3 | Target project is empty or c2c-owned | MCP `List_All_Tables` for the project: either no tables, or every table name is in this app's plan (update mode) | `project empty (greenfield)` / `update mode: 7 tables match the plan` | `FAIL D-F3: project <id> has <n> tables that are not part of this app (<names…>).` → use a new project for this app (one project per app), or name this project for this app only. Merging two apps into one project is refused (the second app's tables would merge into the first app's tables [TESTED]). |
| D-F4 | Org table budget | Sum `List_All_Tables` over all org projects + planned tables; the org-wide table-create limit is unpublished — `API_LIMIT_REACHED` for table has fired at a visible count above and below 200 and persisted after project deletes [TESTED] | `tables N + 0 planned` | `WARN D-F4: org has <n> tables and the plan adds <p>; the org table-create limit is unpublished and can refuse at any count. On API_LIMIT_REACHED for table: stop creates, keep created tables, retry after 30/60/120 min; a project delete may not free capacity at once.` (WARN whenever the plan creates tables; `c2c probe P-TABLES` counts.) |
| D-F5 | Per-table budgets from the plan | From `plan.json`: columns ≤ 100 per table in Dev [DOC]; unique varchar ≤ 2 per table (`Reached max number of columns of Unique varchar type`) [TESTED]; FK ≤ 15 [UNVERIFIED]; JOINs ≤ 4 [DOC]; SELECT width ≤ 20 [DOC] (not yet confirmed) | `budgets ok` | `FAIL D-F5: table <T> needs 3 unique varchar columns (<cols>); Catalyst allows 2.` → choose which fields lose "No Duplicate" in Catalyst (c2c then enforces them in the app layer), or let c2c's splitter handle it; re-run `/c2c:plan`. |
| D-F6 | Dev user and API budgets | planned app users vs 25 Dev users [DOC] (a higher effective cap is [UNVERIFIED]); planned data rows vs Dev row cap [UNVERIFIED] | — | `WARN D-F6` with the numbers and the advice to rehearse full volume outside Dev (see `references/limits.md`). |

### V. Consistency (CLI half, after `--mcp-observed`)

| id | Check | FAIL → fix |
|---|---|---|
| D-V1 | `scope.dc` = MCP DC (D-B2) = CLI DC (D-C4/D-C5) | `FAIL D-V1: DC mismatch (config <a>, MCP <b>, CLI <c>).` → fix whichever is wrong per D-B2/D-C4. |
| D-V2 | MCP evidence is < 12 h old and from this workspace | `FAIL D-V2: MCP check is stale.` → run `/c2c:doctor` again. |
| D-V3 | Only one Catalyst MCP server is in use | `WARN D-V3: two Catalyst MCP servers are connected (<a> on .in, <b> on .com); c2c uses <a>.` |

---

## Agent-half observation (input to `c2c doctor --mcp-observed -`)

`c2c doctor --mcp-begin` opens a one-time request (`c2c-out/.c2c/mcp-request.json`: a random request id and when it was issued; it expires after 15 minutes) and prints the calls to make and the observation shape. The agent makes the calls in the session — `CatalystbyZoho_Create_Bucket` writing a probe bucket named `c2cprobe<request-id>` into the selected project, then `CatalystbyZoho_List_All_Organizations` — and pipes one observation into `c2c doctor --mcp-observed -` (stdin). The echoed nonce proves nothing on its own: the doctor reads the probe bucket back with `GET /baas/v1/project/<project-id>/bucket/c2cprobe<request-id>` using the user's CLI credential — `verified` binds the connector to that org/DC/project (recorded as `mcp.binding`), `absent`/unreadable fails local transports on D-B1/D-B2. Cleanup is `CatalystbyZoho_Delete_Bucket` by bucket name; the call is re-printed while a pending-cleanup record exists and clears once a read-back shows the probe gone.

```json
{
  "kind": "c2c-mcp-observation",
  "schema": 1,
  "request": "<request-id>",
  "server": "catalyst-by-zoho",
  "host_of_url": "catalystbyzoho.zohomcp.<dc>",
  "transport": "http",
  "shape": "meta",
  "features": ["Authentication", "Datastore", "Datastore BulkJobs", "JobScheduling", "Stratus", "API Gateway", "Mail", "Projects", "Organization", "Functions"],
  "tools": ["CatalystbyZoho_List_All_Organizations", "…"],
  "schemas": { "CatalystbyZoho_Create_Job_Pool": { "path_variables": ["project_id"], "body": ["name", "type", "capacity"] } },
  "catalyst_skills_visible": ["catalyst-by-zoho", "catalyst-zoho-mcp", "…"],
  "calls": [
    { "tool": "CatalystbyZoho_Create_Bucket", "result": "<the call result, verbatim>" },
    { "tool": "CatalystbyZoho_List_All_Organizations", "result": "<the call result, verbatim>" }
  ]
}
```

The doctor derives `orgs` from the call result itself, stamps `at` and the workspace itself, and digests each result (`sha256`) — raw results are never written. It refuses (nothing written) an observation that is not `c2c-mcp-observation` schema 1 (a legacy evidence file included), sets `orgs`, `projects`, `at`, `workspace` or `binding`, answers a request this workspace did not issue or already used, arrives after the request expired, has no `List_All_Organizations` or `Create_Bucket` result, quotes `List_All_Projects` or `Get_Project_By_Id` (never called: they return project secrets), or quotes a call that returned an error. A result that does not list the target org records fine and fails D-B7.

For stdio/local, use `"transport": "stdio"` (or `"local"`) and omit
`host_of_url`. Submitted org hosts and the CLI's own selection never attest
the connector: D-B1/D-B2 pass only on `mcp.binding.status = "verified"` — the
probe bucket read back in the selected project.

Every session fact comes from MCP calls made live in the current session, each under the host's own approval prompt, no permission-rule changes. A pre-made, copied or user-supplied observation is never acceptable: if one is offered, discard it and run the calls (C2C.md rule 13). There is no `mcp-evidence.json` for the agent to write — `c2c doctor --record-mcp <file>` is only for scripted runs outside a host session (`--operator` flag) and marks the record `source: "operator"`.

## Order and cost

1. CLI half first (fast, offline except D-C3/D-C4).
2. Agent half: D-B1 → D-B3 → D-B4 → D-B5 → D-B7 (≈ 4–6 MCP reads; D-B6 adds one `getSchema` per plan tool, cached by digest).
3. `--mcp-observed -`, then D-V*.
4. Doctor is run once per session and again only if the context changes (DC, org, project, a `PERMISSION_NEEDED`), mirroring the official preflight rule.
