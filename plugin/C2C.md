# c2c: agent rules (read by every c2c skill)

These rules apply to every host (Claude Code, OpenAI Codex, Cursor) and every c2c skill. If a skill and this file disagree, this file wins.

## 1. Non-negotiable rules

1. **Doctor first.** Run the `c2c-preflight` skill (or `/c2c:doctor`) before anything else in a session. Refuse anything past `plan` while doctor is red: stop and run nothing further until it is green. The CLI enforces this (exit 5); do not work around it.
2. **The customer does every login, consent, payment and console click.** You never type a password, OTP, token or card number, never complete an OAuth screen, never drive the Catalyst or Creator console. You tell the user exactly what to click and then *verify by reading back* (MCP read, CLI read, or a probe).
3. **Never handle secrets.** Never read `~/.config/configstore/*`, `X_ZC_CREDENTIAL_PATH` contents, `.catalystrc` tokens, `auth.json`, MCP URLs with tokens in the path, or IaC exports before redaction. Never echo `catalyst token:generate` output. Env values for functions go into a local file that the user fills and `c2c deploy --function-env <file>` reads once.
4. **Dry run by default.** Every live verb takes `--confirm`. Show the user the plan file (diff-style) and get a clear "yes" in chat before each `--confirm` step and before each MCP write.
5. **Resumable and re-run safe.** Every step is list → match by name/key → create-if-missing → read-back. Use `--resume` after an interruption; never "start over" by deleting things.
6. **One Catalyst project per migrated app, Development only.** Never write to a project that holds another app's tables. Never touch a project in `never_touch`. Never write to Production (promotion is a console step the user does at cutover).
7. **Never assume the org, project or DC.** They come from `c2c-deploy.json` (and the user confirms them once per session). A single org or project in a list is not permission to pick it.
8. **Fail closed.** An unconvertible construct is a TODO in `migration-report.json`, never a silent default (`WHERE true`, empty catch, `dryRun:true` on a live deploy). A failed read-back stops the step.
9. **Nothing is "not supported" without a direct attempt.** If you meet a construct or Catalyst behaviour with no verified route, say "unverified: needs a probe" and use `c2c probe` (with the user's OK) instead of declaring it impossible.
10. **Verify limits empirically.** Limits labelled [UNVERIFIED] in `references/limits.md` are not facts; budget them as warnings and probe them before relying on them.
11. **No customer data in the plugin or the chat.** Do not paste record values, emails or exports into the conversation beyond what the user shows you. Reports hold counts and names only. Everything is written under the user's workspace `c2c-out/`.
12. **Defer to the Catalyst skills for Catalyst facts.** For handler signatures, SDK calls, `catalyst-config.json`, Slate config, ZCQL syntax: load the matching `catalyst-*` skill. c2c skills add the migration decisions on top.
13. **Default settings only — no browser automation, no supplied evidence, no permission changes.** The end user runs this plugin with the host's default settings: you never automate the Zoho web console or a browser (use the CLI, API or MCP), never change the user's permission or approval rules, and never accept evidence you did not produce — every doctor, probe and read-back fact comes from CLI/API/MCP calls made live in the current session, each behind the host's own approval. Whatever no call can do becomes a guided ask — the exact console link or menu path, what to click, and how the result is read back — collected into one batched checklist, not asked one at a time.
14. **One Catalyst CLI credential, one refresher.** The refresh token has been observed to rotate on refresh [TESTED], so two processes refreshing the same login can break it for each other — the loser gets `Error when refreshing the access token` or an empty token. Serialize CLI use: one `catalyst`/`c2c` run at a time per credential, never a background keep-fresh loop beside a run, never a credential copied to a second machine or profile. On a read-only `401 INVALID_TOKEN`, re-read the stored token — a refresh may already have renewed it — rather than forcing a refresh; forcing a local refresh is opt-in (`C2C_ALLOW_LOCAL_REFRESH=1`) and only for a single user who owns the only credential.
15. **Keep whatever a human step has touched.** c2c tears a project down only on the user's explicit request, or on a failure before the Slate "Start Exploring" step — the first console action in the flow. A project that has taken a human or console step is never torn down to "start clean": stop, report the state, and let the user decide.

## 2. Evidence labels

| Label | Meaning | Use |
|---|---|---|
| [DOC] | Public Zoho docs | Rely on it; re-probe if a live result disagrees |
| [CLI] | zcatalyst-cli help or source | Rely on it |
| [MCP-LISTED] | Tool exists in the Catalyst MCP tool list; schema not yet verified by c2c | `getSchema` first; first live call is a probe |
| [TESTED] | Verified by a test run against a Catalyst project | Rely on it |
| [UNVERIFIED] | Not yet verified | Probe before relying on it |

## 3. How to call Catalyst MCP tools (both shapes)

- **Meta shape** (Global server, `ZohoMCP_*` meta-tools visible):
  1. `ZohoMCP_getSchema({ query_params: { tool_name: "CatalystbyZoho_<Tool>" } })` — `query_params`, not `body`.
  2. `ZohoMCP_executeTool({ body: { tool_name: "CatalystbyZoho_<Tool>", arguments: { path_variables: {…}, headers: {…}, body: {…} } } })`.
- **Direct shape** (personal server / connector, tools named `…CatalystbyZoho_<Tool>`): call the tool with the arguments its schema shows.
- Always pass the org header the schema asks for (`CATALYST-ORG` / `Catalyst-org`) and the project id from `c2c-deploy.json`.
- Before the first write in a session: `List_All_Organizations` must include the org in `c2c-deploy.json`, and `catalyst --org <org> project:list` must list its project (doctor D-B7/D-C4 already did this; re-run only if context changed). Never call `CatalystbyZoho_List_All_Projects` or `CatalystbyZoho_Get_Project_By_Id`: they return project secrets (jwtSecret, clientSecret) into the transcript. Projects are read through the Catalyst CLI only (name and id).
- After every MCP write, do the read-back named in `references/route-map.md` and record it with `c2c provision --record`.

## 4. CLI surface c2c skills use

| Verb | Status | Purpose |
|---|---|---|
| `c2c doctor` | exists | Prerequisite gate |
| `c2c precheck <ds> [--json]` | exists | Static blockers, exit 1 on BLOCKING |
| `c2c analyze <ds> [--json] [--quality]` | exists | Readiness, Deluge coverage, estimate |
| `c2c plan <ds> --out c2c-out/<app>` | exists | Full offline plan, no credentials |
| `c2c provision --out <dir> [--next \| --record <step> --result <file> \| --status] [--confirm]` | exists | MCP-first infra with read-back |
| `c2c deploy <ds> --out <dir> --confirm [--resume] --function-env <file\|new>` | exists | Code: functions, API Gateway, Slate |
| `c2c migrate-data --source-csv <dir> --ds <ds> [--confirm] [--checkpoint <f>]` | exists | Data load |
| `c2c smoke` | exists; not yet passing end to end | First live signal |
| `c2c probe <P-…> --confirm` | **planned** | Empirical limit probes, scratch resources deleted |
| `c2c verify --out <dir> [--confirm]` | **planned** | Export diff, probes, parity |
| `c2c cutover …`, `c2c rollback --plan`, `c2c status` | **planned** | Cutover and recovery |

Run the CLI as `"${CLAUDE_PLUGIN_ROOT}/bin/c2c"` in Claude Code and `<plugin-root>/bin/c2c` (or `npx -y creator-to-catalyst@<version>`) elsewhere.
