# Exact-decimal audit

Regenerable summary of a corpus of sample Creator apps (not included). Recompute with
`node dist/determinism/src/decimal-audit.js <corpus-dir> > docs/decimal-audit.md`; `npm test` fails when this
file is stale and `C2C_FIXTURES_DIR` is set. Counts only — no app names, fields, or script text.

Decimal, currency, and percent columns are exact decimal strings in VarChar(64). ZCQL compares a varchar
as text, so each such column has a Double shadow (`<Field>__n`). A criteria or sort site on one is routed
when its decimal leaves compile to the shadow column (a widened superset) and its sort orders by the shadow;
the runtime then filters with `shim.decimal.cmp` on the varchar, re-sorts ties exactly, and applies the range.
Sites are counted over `c2c ui` generation. NoSQL forms have no shadow and are not ZCQL tables, so their
fields are not counted here.

| | |
|---|---:|
| corpus apps | 67 |
| apps with exact-decimal columns | 40 |
| `Form[criteria]` sites emitted | 5418 |
| …criteria on an exact-decimal field | 20 |
| …sort by an exact-decimal field | 4 |
| report criteria/filters on an exact-decimal field | 0 |
| report sort by an exact-decimal field | 2 |
| sites not routed through the shadow path | 0 |
| raw JS arithmetic ops on a decimal operand | 0 |
