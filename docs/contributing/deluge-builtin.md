# Adding a Deluge builtin

Every builtin lands in one of three states, defined in
`packages/deluge/src/catalogue.ts`:

| status | meaning |
|---|---|
| `supported` | the builtin becomes native JS — no `shim.todo`, no shim call of its own |
| `shimmed` | it maps to a named `shim.*` call or a client `actions.push` |
| `todo` | the translation emits `shim.todo()` |

## Steps

1. **Docs entry.** If the builtin is not yet in
   `packages/deluge/data/builtin-docs.json`, add it there (name, kind,
   category, receivers, arity, `docUrl`, snippet/syntax). This file is the
   hand-maintained list of what Zoho documents; it never stores status —
   status is derived by spot-translating each entry.
2. **Dispatch.** Wire the translation in `packages/deluge/src/dispatch.ts` —
   the tables such as `NATIVE_STRING_JS`, `MATH_FUNCTIONS`, `DATE_METHODS`,
   `AGGREGATE_METHODS` and `HANDLED_TASKS`, or the dispatch logic around
   them. `recognisedBuiltinNames()` must be able to enumerate the name: a
   recognised name missing from `builtin-docs.json` fails
   `packages/deluge/test/catalogue.test.ts`.
3. **Shim (if `shimmed`).** Add or extend the runtime function in
   `packages/shims/src/` that the emitted call targets, with its own test.
4. **Test.** Add a case to the fitting file under `packages/deluge/test/`
   (`builtins-depth.test.ts` for builtin behaviour, `translate.test.ts` for
   dispatch shape). Assert both the emitted code and the status — a shimmed
   or supported builtin must not emit a todo hole (see
   `cross-form.test.ts`), and method and free forms should agree where both
   exist.
5. **Regenerate the catalogue.** `docs/deluge-builtins.json` is generated —
   after `npm run build`, run
   `node dist/deluge/scripts/builtins-catalogue.js` and commit the result.
   Never hand-edit it: the catalogue test spot-translates the entries and
   fails on drift.
6. Run `npm test`. If the emitted bytes change generated output for a
   committed fixture, the determinism manifests need
   `npm run determinism:update` in the same pull request — see
   [determinism.md](determinism.md).

## Notes

- The builtin catalogue lists 269 `todo` entries in
  `docs/deluge-builtins.json` (`counts.todo`); that is not the corpus residual — see
  [docs/determinism-status.md](../determinism-status.md).
- Client-side builtins that read the server go through the prefetch
  mechanism documented in `packages/deluge/CLIENT-SPLIT.md` — a client
  handler cannot perform a data-store read inline.
