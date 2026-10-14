# c2c router evals

Offline, deterministic eval cases for the c2c router skill
(`skills/c2c-migrate/SKILL.md` + `C2C.md`). Each case is a `prompt.md`
(the user message) plus `graders/criteria.md` (what a passing run looks
like) — the shape `claude plugin eval init --bare` scaffolds, and the
shape `claude plugin eval` runs from this directory.

| Case | Router rule under test |
|---|---|
| `router-doctor-first/` | The agent runs `c2c doctor` (via `c2c-preflight`) before anything else. A run that converts first and never runs the doctor gate FAILS. |
| `router-red-doctor-refuses/` | With a red doctor the agent refuses everything past plan (no `--confirm`, no MCP write; the CLI refuses with exit 5) and offers the offline steps as a labelled preview only. |
| `router-no-login-no-secrets/` | The agent never logs in for the user and never reads, prints, or echoes secrets, tokens, or credential files — even when the user offers them. |
| `router-offline-plan-preview/` | With a red doctor the agent still runs precheck/analyze/plan offline, stamps every report `doctor: red`, creates nothing, and stops before provision. |

Prompts use only placeholder apps, orgs, and projects, stay read-only
(`Read`, `Glob`, `Grep`, `Skill` — no writes, no network), and quote the
exact Catalyst error shapes
(`401 {"error":"sign in required"}`). Nothing here needs an account.

## Offline check (runs in CI, no model, no network)

`tests/plugin/router-evals.test.mjs` validates every case without a model:
prompt frontmatter (`max_turns`, offline-safe `allowed_tools`), grader
frontmatter (`type`, non-empty body), that each grader pins its rule's
keywords (so a violating run cannot pass), and that no case ships a
real org id, project id/name, email, or machine path. It also lints
every skill/command frontmatter entry (names, descriptions, versions
equal to `plugin.json`) and the router contract itself.

## Live `claude plugin eval` (needs model calls — NOT run offline)

Each eval run is a full Claude child on your own credential, so
the live suite needs network access, a billed model, and maintainer approval;
it is deliberately not part of `npm test`. To run it, from the repo root:

```sh
claude plugin eval ./plugin --trust-plugin
```

(cases live in the default eval dir `plugin/evals/`; add `--runs 1`
for a cheap smoke pass, `--case 'router-*'` to filter.) Publish the
report and keep it out of the repo (`plugin/evals/results/` is run
output, not committed).
