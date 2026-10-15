# Contributing

## Development setup

Requires Node.js 20 or 22 (`>=20.20 <23`, declared in `package.json`
`engines`). The exact development version is pinned in `.nvmrc`; `nvm use`
picks it up.

```sh
npm ci
npm ci --prefix packages/ui-react/template
npm test
```

`npm test` compiles with `tsc`, runs the full `node --test` suite and then the
hygiene check. To run the hygiene check alone: `npm run check:hygiene`.

To limit parallel test processes on a busy machine, set `C2C_TEST_CONCURRENCY` to a positive integer (e.g. `C2C_TEST_CONCURRENCY=4`).

Some tests do more when they can see real `.ds` exports. Point
`C2C_FIXTURES_DIR` at a local directory (docs write it as `<fixtures-dir>`) to
enable them. The variable is optional: the suite passes on the committed
fixtures alone, and the directory itself is never committed — see "Fixtures"
below.

## Workflow

1. Open an issue first for anything larger than a small fix, so the behaviour
   is agreed before code lands.
2. Keep a pull request small and about one behaviour.
3. `npm test` must pass. CI runs the same command and then the determinism
   gate (`.github/workflows/ci.yml`): two clean generations of the committed
   fixtures must produce identical hashes.
4. A pull request that discovers or changes Catalyst or Creator behaviour
   updates the facts ledger and the affected skill in the same pull request.

## Commits

Use conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
`perf:`, `build:`, `ci:`, `chore:` — e.g. `fix: keep unknown blocks in shape B
workflows`. Messages describe product behaviour only.

Commit as yourself. No tool, assistant or automation trailers
(`Co-Authored-By`, `Generated with`, and the like).

Run `npm test` before you push.

## Generated files and merges

Some tracked files are regenerated from other sources. Never resolve a
conflict in one by hand and never pick a side (`--ours`/`--theirs`) — a side
pick silently reverts the other branch's source changes inside the same
derived file. Regenerate instead.

| File | Regenerate with |
|---|---|
| `packages/determinism/test/manifests/*.sha256` | `npm run determinism:update` (offline) |
| `docs/determinism-status.md` | `C2C_FIXTURES_DIR=<fixtures> npm run determinism:status` |
| `docs/decimal-audit.md` | `node dist/determinism/src/decimal-audit.js <fixtures>/gallery > docs/decimal-audit.md` |
| `docs/quality-gate.md` | `C2C_FIXTURES_DIR=<fixtures> npm run smoke:gallery -- --markdown`, paste the block between the markers |
| `docs/coverage-gate.md` | no in-repo generator; union-merge it and say so in the pull request |

A merge driver automates this. Run once per clone (`git config` cannot be
committed):

```sh
npm run merge-driver:install
```

`.gitattributes` then routes these paths through `tools/merge-generated.sh`.
The driver never runs repository code during an ordinary merge or rebase: it
union-merges so no side is dropped, and prints the regen command to run
afterwards. Gallery docs can additionally be regenerated in place when you
explicitly opt in — set `C2C_MERGE_REGENERATE=1` for that one merge command
with the gallery inputs available. Ordinary merge and rebase commands must
leave that variable unset, even when fixtures are present. A union-merged
generated file is not canonical, so `npm test` fails stale until you run the
regen command above — that failure, not a hand-merge, is the resolution path.

## Tests

Tests are colocated under `packages/<name>/test/`, named after behaviour, and
must be deterministic and offline: no network calls, no clocks, no unordered
iteration. A codegen lint in `npm test` enforces that in the pipeline code.
A test that genuinely needs the network sits behind an env flag so the default
run stays offline.

`npm test` runs the paths in `scripts/test-files.txt`. Add a test there, one
path per line, in sorted order. A blank line is ignored, and a line whose
first non-space character is `#` is a comment. A directory path runs every
test file under it. Each `tests/plugin/*.test.mjs` file is listed on its own
line; a new plugin test is a new line in that file.

## Fixtures

There are two kinds of test input, and only one of them belongs in git.

| Kind | Where | In git? |
|---|---|---|
| Redistributable samples (an open-source license that allows redistribution) | `fixtures/redistributable/<name>/` with the original `LICENSE` next to the `.ds` file, and an entry in `NOTICE` | yes |
| Everything else: sample apps you installed, your own or a customer's exports, files without a license | `fixtures-local/` (or any path outside the repo), or a file named `*.local.ds` | **never** |

`.gitignore` excludes `fixtures-local/`, `*.local.ds` and `.env*`. Before you
commit, check `git status` for stray `.ds` files.

Run the corpus harness on local fixtures with:

```sh
npm run build
node dist/cli/src/c2c.js corpus fixtures-local --label local
```

It prints aggregate numbers only. Do not paste file contents, names or URLs from
private exports into issues, pull requests or commit messages.

## Adding a construct

1. Add a minimal snippet to `packages/core/test/parser.test.ts` that shows the
   construct, and assert both the round trip and the IR you expect.
2. The round-trip invariant (`print(parse(src)) === src`) must hold for every
   input, valid or not. Never drop or normalise source text.
3. If the construct is not modelled yet, it must appear in `unknown[]` (or
   `unmodelled[]` for recognised-but-not-modelled blocks), not vanish.

## Hygiene

Shipped files state system rules and behaviour. Evidence for a behaviour lives in this repository or in public product documentation.

`npm test` runs `scripts/check-hygiene.mjs`. It rejects a home-directory path, an email address outside example.com, example.test, and users.noreply.github.com, and an 11-digit organisation id or 17-digit project id that is not on the placeholder list. The deploy guard files are exempt from the id rule until the org and project come from config. Docs name `<fixtures-dir>` and code reads `C2C_FIXTURES_DIR`.

## Determinism

Generated output is deterministic: two clean generations of the same input
produce identical bytes. Generated bytes for a committed fixture change only
with a reviewed reason, stated in the pull request.

- `npm run determinism:update` regenerates the committed manifests under
  `packages/determinism/test/manifests/`; `npm run determinism:check` fails
  when the tree drifts from them. A change that legitimately alters output
  updates the manifests in the same pull request.
- `npm run check` additionally runs `tools/determinism-gate.sh`: it generates
  every committed fixture twice, each run in a fresh process, and diffs the
  two hash trees.
- A codegen lint in `npm test` (`packages/determinism/src/lint.ts`) rejects
  clocks, locale-dependent comparison and unordered iteration in pipeline
  sources unless a `// determinism-allow:` comment names the reason.

Full detail: [docs/contributing/determinism.md](docs/contributing/determinism.md).

## Dependencies and licences

The tool itself has zero runtime dependencies. The generated React app is the
one place third-party code ships: every dependency is pinned to an exact
version in `packages/ui-react/template/package.json` and the committed
lockfile, licences are limited to MIT, ISC, 0BSD for shipped code plus
Apache-2.0, BSD-3-Clause and MPL-2.0 for build-only tools, and each one is
listed in `THIRD_PARTY_NOTICES.md`. A test enforces the allowlist against the
lockfile. See [docs/contributing/dependencies.md](docs/contributing/dependencies.md).

## Security rules

Authorization and validation are enforced server-side, in the generated
`c2c_api` function; browser-side checks are for the user, not the boundary.
Secrets never land in a client bundle, a plan output or the repository.
See [docs/contributing/security-rules.md](docs/contributing/security-rules.md)
and [SECURITY.md](SECURITY.md).

## Contributor guide

- [Repository layout](docs/contributing/repository-layout.md) — what each package owns
- [Determinism](docs/contributing/determinism.md) — the gate, the manifests, the lint
- [Adding a Deluge builtin](docs/contributing/deluge-builtin.md)
- [Adding a UI widget](docs/contributing/ui-widget.md)
- [Dependencies and licences](docs/contributing/dependencies.md)
- [Security rules](docs/contributing/security-rules.md)
