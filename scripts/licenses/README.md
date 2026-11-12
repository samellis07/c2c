# Licence texts for vendored packages that publish none

`scripts/vendor-plugin.mjs` writes `plugin/vendor/c2c/node_modules/THIRD_PARTY_LICENSES.txt`
from the licence file inside each shipped package. A few npm tarballs omit that
file. Their text lives here as `<name>-<version>.txt` (scope slash replaced by
`__`), taken from the package's upstream repository. Vendoring fails for a
shipped package that has neither.

| file | package | upstream |
|---|---|---|
| `saxes-6.0.0.txt` | saxes 6.0.0 (ISC) | https://github.com/lddubeau/saxes (LICENSE) |

## Licence exceptions

The plugin ships only MIT, MIT-0, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
ISC, 0BSD, Unlicense and CC0-1.0 (the project allowlist).
`exceptions.json` names any other licence that a
shipped package carries, one entry per exact package, version and licence:

- `EXCEPTION_NEEDED`: recorded, awaiting maintainer approval. Vendoring still runs, but
  the licence test in `tests/plugin/packaging.test.mjs` fails.
- `APPROVED`: a maintainer approved the exception; the test passes.

An unlisted licence fails vendoring outright.
