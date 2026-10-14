# Dependencies and licences

## The tool itself

Zero runtime dependencies. `package.json` carries only dev dependencies
(`typescript`, `@types/node`, `jsdom` for the form smoke test) and the
Node.js 20.20.1 pin in `engines`. Keep it that way — a runtime dependency
would ship into every environment the CLI runs in.

## The generated React app

`packages/ui-react/template/` is the one place third-party code ships: it is
copied into every generated app, so its dependency rules are strict.

- **Exact pins only.** Every dependency is pinned to an exact version in
  `packages/ui-react/template/package.json`, and the committed
  `package-lock.json` (lockfile v3, including each platform's optional native
  binary) makes `npm ci` resolve the same tree on macOS, Linux and Windows.
- **Licence allowlist.** Shipped code (what lands in the app bundle) is MIT,
  ISC or 0BSD. Build-only tools may also be Apache-2.0, BSD-3-Clause or
  MPL-2.0 — e.g. lightningcss, the CSS minifier, which is never in the
  bundle. The full table is in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
- **A test enforces it.** A suite test checks every lockfile entry against
  the notices allowlist, so adding a dependency without updating
  `THIRD_PARTY_NOTICES.md` fails `npm test`.

When you add or bump a template dependency:

1. Pin the exact version; regenerate `package-lock.json`.
2. Check the licence is on the allowlist (or is build-only).
3. Add the row to `THIRD_PARTY_NOTICES.md` — package, licence, whether it
   ships in the bundle.
4. Update the stack table in [docs/react-target.md](../react-target.md) if
   the version appears there.

## Vendored source

The Arc Library is vendored, not packaged: source at a pinned commit under
`packages/ui-react/template/lib/c2c-ui/arc/` with its `LICENSE` alongside and
the upstream record in `ARC-UPSTREAM.md`; it is listed in
`THIRD_PARTY_NOTICES.md`. A new vendored component follows the same pattern —
pinned commit, licence text next to the source, notices entry.

## Fixture licences

Fixture licence policy is separate: see "Fixtures" in
[CONTRIBUTING.md](../../CONTRIBUTING.md). Only redistributable exports are
committed, each with its original `LICENSE` and a `NOTICE` entry.
