# Third-party notices

Third-party software that ships inside this repository or inside the apps it
generates. Test fixtures and their licences are listed in `NOTICE`.

## Arc Library (vendored source)

- Source: https://github.com/kuratlielia/arc-library
- Licence: MIT License, Copyright (c) 2026 Elia Kuratli
- Where: `packages/ui-react/template/lib/c2c-ui/arc/` (licence text in `arc/LICENSE`), copied into every generated React app under `lib/c2c-ui/arc/`
- Pinned commit and local changes: `packages/ui-react/template/lib/c2c-ui/ARC-UPSTREAM.md`

## npm packages of the CLI

Pinned exactly in the root `package.json` and `package-lock.json`. These run
on the user's machine at conversion time; none ships inside generated
Catalyst functions (which carry only `zcatalyst-sdk-node` plus vendored
shims — see `packages/deploy/src/function-dir.ts`).

| package | licence | shipped in generated functions |
|---|---|---|
| lossless-json@4.3.1 | MIT | no (CLI-side exact-JSON parsing only) |

## npm packages of the generated React app

Pinned exactly in `packages/ui-react/template/package.json` and
`packages/ui-react/template/package-lock.json`. A test checks every lockfile
entry against this allowlist.

| package | licence | shipped in the app bundle |
|---|---|---|
| react, react-dom, scheduler | MIT | yes |
| motion, motion-dom, motion-utils | MIT | yes |
| lucide-react | ISC | yes |
| @radix-ui/react-dialog and its primitives (@radix-ui/primitive, react-compose-refs, react-context, react-dismissable-layer, react-focus-guards, react-focus-scope, react-id, react-portal, react-presence, react-primitive, react-slot, react-use-callback-ref, react-use-controllable-state, react-use-effect-event, react-use-layout-effect) | MIT | yes (the vendored Arc dialog) |
| aria-hidden, detect-node-es, get-nonce, react-remove-scroll, react-remove-scroll-bar, react-style-singleton, use-callback-ref, use-sidecar | MIT | yes (the vendored Arc dialog) |
| tslib | 0BSD | yes |
| vite, rolldown, @vitejs/plugin-react, postcss and their helpers | MIT | no (build only) |
| lightningcss | MPL-2.0 | no (build only, CSS minifier) |
| typescript, detect-libc | Apache-2.0 | no (build only) |
| picocolors | ISC | no (build only) |
| source-map-js | BSD-3-Clause | no (build only) |
| @types/react, @types/react-dom, @types/node | MIT | no (types only) |

## npm packages shipped inside the c2c plugin

The generated plugin tree `plugin/vendor/c2c/node_modules/` ships the runtime
dependencies the vendored CLI needs, byte-identical to the repo's installed
copies. Versions are the exact pins in `package-lock.json`.

The vendor step (`scripts/vendor-plugin.mjs`) writes
`plugin/vendor/c2c/node_modules/THIRD_PARTY_LICENSES.txt` from the shipped tree
itself: name, version, licence and full licence text of every shipped package.
Most packages carry their own licence file. Where a published package carries
none (saxes 6.0.0, ISC), the text comes from its upstream repository via
`scripts/licenses/`. Shipped code may carry only MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause or ISC unless an exception has maintainer approval, recorded in
`scripts/licenses/exceptions.json`. Vendoring fails on a shipped package with no
licence text or an unlisted licence, and `tests/plugin/packaging.test.mjs`
fails until every exception is approved. `@csstools/color-helpers` 5.1.0
(MIT-0, under jsdom's cssstyle) is pending maintainer approval as an exception.

| package | licence | shipped in the plugin |
|---|---|---|
| typescript | Apache-2.0 | yes |
| jsdom | MIT | yes |
| jsdom's dependency tree (cssstyle, @csstools/*, parse5, whatwg-*, nwsapi, saxes, ws, tough-cookie, iconv-lite, and helpers) | MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 | yes |
