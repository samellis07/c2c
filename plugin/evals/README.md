# c2c plugin evals (G-18)

Offline, deterministic eval cases for the c2c router and individual skills
(`skills/c2c-*/SKILL.md` + `C2C.md`). Each case is a `prompt.md`
(the user message) plus `graders/criteria.md` (what a passing run looks
like) — the shape `claude plugin eval init --bare` scaffolds, and the
shape `claude plugin eval` runs from this directory.

## Router cases

| Case | Router rule under test |
|---|---|
| `router-doctor-first/` | The agent runs `c2c doctor` (via `c2c-preflight`) before anything else. A run that converts first and never runs the doctor gate FAILS. |
| `router-red-doctor-refuses/` | With a red doctor the agent refuses everything past plan (no `--confirm`, no MCP write; the CLI refuses with exit 5) and offers the offline steps as a labelled preview only. |
| `router-no-login-no-secrets/` | The agent never logs in for the user and never reads, prints, or echoes secrets, tokens, or credential files — even when the user offers them. |
| `router-offline-plan-preview/` | With a red doctor the agent still runs precheck/analyze/plan offline, stamps every report `doctor: red`, creates nothing, and stops before provision. |

## Skill cases

| Case | Skill rule under test |
|---|---|
| `c2c-analyze-and-precheck/` | Never auto-guess missing arguments for BLOCKING latent faults (precheck rule 01); the fix belongs in Creator. |
| `c2c-auth-and-access/` | Creator portal users are re-invited, never imported with passwords; missing users never silently fall back to super admin. |
| `c2c-edit/` | Generated files are never edited by hand; edits must use typed ops replayed through the edits log. |
| `c2c-integrations/` | Never call Creator from a generated Catalyst function in the request path. |
| `c2c-logic/` | ZCQL `LIKE` uses `*` (a `%` pattern silently matches nothing). |
| `c2c-migrate/` | One app = one project; if target project holds foreign tables, stop and create a new project; never merge apps. |
| `c2c-preflight/` | Doctor is green only when the CLI says so after `--mcp-observed`; never declare green from own reading. |

Prompts use only placeholder apps, orgs, and projects, stay read-only
(`Read`, `Glob`, `Grep`, `Skill` — no writes, no network), and quote the
exact Catalyst error shapes
(`401 {"error":"sign in required"}`). Nothing here needs an account.

## Offline check (runs in CI, no model, no network)

`tests/plugin/router-evals.test.mjs` validates every case without a model:
prompt frontmatter (`max_turns`, offline-safe `allowed_tools`), grader
frontmatter (`type`, non-empty body), that each grader pins its rule's
keywords (so a violating run cannot pass), that criteria cite skill lines
verbatim, and that no case ships a denylisted org id, project id/name,
email, or machine path. It also lints every skill/command frontmatter entry
(names, descriptions, versions equal to `plugin.json`) and the router
contract itself.

## Live `claude plugin eval` (needs model calls — NOT run offline)

Each eval run is a full Claude child on your own credential, so
the live suite needs network access, a billed model, and maintainer approval;
it is deliberately not part of `npm test`. To run it, from the repo root:

```sh
claude plugin eval ./plugin --trust-plugin
```

(cases live in the default eval dir `plugin/evals/`; add `--runs 1`
for a cheap smoke pass, `--case 'router-*'` or `--case 'c2c-*'` to filter.)
Publish the report and keep it out of the repo (`plugin/evals/results/` is run
output, not committed).

## Skill evals

The offline skill cases cover the operational boundaries in six individual
skills. Each directory contains a `prompt.md` and `graders/criteria.md` in the
`claude plugin eval init --bare` format:

| Case | Skill rule under test |
|---|---|
| `skill-provision-and-deploy/` | A write is not complete until its read-back matches; stop on MCP schema mismatch. |
| `skill-schema-and-data/` | Fail closed on schema budgets before data loading. |
| `skill-status/` | Status is read-only; unanswered reads become checklist steps and fake data stays labelled. |
| `skill-troubleshooting/` | Unknown errors are reported as blocked; do not invent a cause or declare unsupported. |
| `skill-ui/` | Do not proceed to auth until the App URL is recorded. |
| `skill-verify-and-cutover/` | Probes and cutover need a green doctor and explicit yes; Production promotion is user-driven in the console. |

The offline schema test also checks that each skill grader includes the cited
rule text verbatim from its source `SKILL.md`.
