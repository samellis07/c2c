# Machine-checked feature matrix

`npm run matrix:check -- <matrix.json>` validates a feature matrix against `schema.json` and resolves every evidence link. A row's status may be no higher than its evidence proves:

| Status | Required evidence |
|---|---|
| built-in-Creator | `creatorApp` / `dsPath`: a `.ds` file, repo-relative or fixtures-root (see below) |
| adapter-written | `code`: `{repo, sha, path}` with the sha an ancestor of `origin/main` and the path present at that sha |
| migrated | the above plus a migration run record and a 17-digit Catalyst project id |
| verified | the above plus a test id that passes at the evidence sha and an e2e evidence file whose sha256 matches |

Fixtures root: `C2C_FIXTURES_DIR`, else `<repo>/c2c-fixtures-local`, else `<repo>/../c2c-fixtures-local`. A `.ds` path may be relative to the fixtures dir or to its parent, but must resolve inside it.

`--fix-downgrade` writes a copy of the matrix with each status lowered to the highest level its evidence proves.

## Test results file

Evidence tests run from a `git archive` of the evidence sha. The TAP results go to a file in a fresh `mkdtemp` directory with a random name, and the stream's plan and summary must match the counted results. This guards against accidents and naive tampering. It is **not** a security boundary: test code runs as the same user and could find the directory. Evidence tests must come from the reviewed repository.

