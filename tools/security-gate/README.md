# Security gate

Every route the generated `c2c_api` function exposes, called directly, offline.

```
npm run build
node tools/security-gate.mjs <app.ds | app-dir> [--out <dir>]          # one app
node tools/security-gate.mjs <apps-dir> --out <dir> [--only a,b]        # every app, one at a time, under nice
```

The routes come from the generator's own route table (`functions/c2c_api/routes.json`,
written by `routeTable` in `packages/deploy/src/function-dir.ts`). The app is generated
as a live deploy tree and each route goes through the generated `index.js` entry, over
loopback HTTP, with `tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs` standing in
for Catalyst (in-memory Data Store, recorded ZCQL and writes, cookie sessions).

| check | expectation |
|---|---|
| a | no principal → 401 JSON, and no ZCQL or write recorded |
| a2 | signed-in user whose role maps to no profile (`App User` when unmapped, an undeclared role) → 403 JSON `code: ROLE_UNMAPPED` |
| a3 | no principal, body that is not JSON → 401 (authentication before input parsing) |
| b | a declared profile the policy does not let use the route (no grant on the form; no `delete`, no `write`, a create-only grant; a non-Administrator on `/admin/*`) → 403 JSON |
| c | an owner-scoped grant, given another owner's ROWID: record, edit, delete, report query → no row returned, row unchanged, row not deleted |
| entry | an unknown path and a wrong method without a principal → 401 |
| client | the vanilla `apiCall` (the app's own `slate/assets/runtime.<hash>.js`) and the React `createApi().post` / `apiCall` (template `runtime/api.ts`), in jsdom: 401 → navigate to `/__catalyst/auth/login?service_url=<current page>`; 403 → an access-denied state |

A declared-public route (`PUBLIC_ROUTES` in `gate.mjs`, or `--public "METHOD /path=reason"`) is
listed with its reason instead of being held to a/a2/a3. There are none today.

Checks that fail today and are tracked as a known issue are `EXPECTED_FAIL` in `gate.mjs`. Each marker is
scoped to the one outcome known today (a2 `401`, a3 `400`, unknown route `404`, wrong method
`405`, client `no navigation` / `nothing rendered`): only that outcome reports `XFAIL` with the
issue id. Any other outcome under a marker (a `200`, say) is a plain FAIL, so a marker cannot hide a
bypass. A marked check that passes is also a FAIL ("passes under expected-fail …, remove the
marker"): when a fix lands, drop its entry in the same change. Any FAIL exits 1.

A handler module that fails to import is an entry FAIL (`handler-import`). A sweep lists
directories that hold no `.ds` directly (nested scenario folders) as skipped rows in `summary.md`.

What a fake-SDK gate cannot see: real ZCQL semantics (the fake parses ZCQL with one regex),
Data Store calls other than insert/update/delete rows and ZCQL (getRow, Cache, File Store,
Stratus are not counted by check a), the real Catalyst Authentication principal shape and the
role mapping a deployed app gets (the gate maps its own `C2C Gate <profile>` roles), and the real
owner column. Check b uses the first denied profile per route only.

Output per app: `security-gate.json` and `security-gate.md` (route × check, then the failures
grouped by fix site). A sweep adds `summary.json` and `summary.md`.

Not covered yet (planned): report filter/sort/search field oracle, picklist and lookup
domain checks, ZCQL injection literals, upload limits, CSP and reply headers, draft save and
single retry after sign-in, per-call-site client checks.
