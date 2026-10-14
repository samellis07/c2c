# Canonical c2c seed schema

One JSON shape feeds every seed path: `c2c seed` writes it, `migrate-data --seed` loads it,
and synthetic `seed.json` files are converted to it in code (fixtures are never edited).

```json
{
  "Author": [
    { "c2c_source_id": "Author#9f3a2b#1", "Name": "Ada" }
  ],
  "Book": [
    { "c2c_source_id": "Book#9f3a2b#1", "Title": "T", "Author": "Author#9f3a2b#1" }
  ]
}
```

Rules:

- Top level maps form (table) name to its row array. Table names must be ZCQL identifiers.
- Every row carries a stable `c2c_source_id` (string, non-empty, unique across the whole file).
  `c2c seed` assigns `<form>#<seed-tag>#<row>`; the same inputs always give the same ids, so a
  re-run reconciles instead of duplicating, while a different `--seed` value never collides.
  The synthetic converter assigns `<form>#<row>` (the fixture file is fixed, so its ids are stable).
- Lookup cells hold the parent row's **source id**, never a display value and never a ROWID.
  The loader remaps them to the created ROWIDs with the same code the CSV loader uses
  (`packages/deploy/src/remap.ts`): parents-first order, ROWID read-back per table, self/cyclic
  lookups deferred to a row update. A cell naming an unknown parent id is refused before any write.
- Cells are scalars (`string | number | boolean`; the loader stringifies). `null` is omitted.
  Subform grids and multi-lookups are flat tables linked by `parent_id`. The child or junction
  table name comes from the same helper the schema uses: the parent table name, `__`, and the
  field identifier. That identifier rewrites `$` and every character outside ASCII letters,
  digits, and underscore, and a numeric suffix is added when the name is already taken. The
  link column uses that same identifier. `c2c seed` writes one, two, or three
  rows in each inline-subform child table for every parent row. The count comes from the seed
  value, so the same inputs repeat. `parent_id` is the parent row's source id and `row_order`
  is the 0-based position under that parent. A multi-lookup inside a subform follows the same
  rule. Its junction is `<Child>__<identifier>`, so every seed table is a table the schema
  plans. A table name longer than the longest name a create has been seen to keep
  (25 characters) is a `table-name-length-unverified` blocker on the schema plan and on the seed.
  No published Data Store table-name maximum is recorded, and the table is still emitted.
  A grid that looks up another form does not add a
  child table; it fills the back-reference column on that form.
- A name or address value is one column per part (`<Field>_<part>`), the same names the schema
  generates. Each part is a deterministic non-empty value. A seed row that still carries the
  composite under the field name is split into those part columns when it is loaded.
- Image, file upload, audio, video, and signature cells hold a fixture file name, not the
  bytes and not a Stratus key. `c2c seed` writes that file next to `seed.json` (one file per
  field, or one per row when the field is unique). Image and signature files are a PNG. File
  upload, audio, and video files are a PDF. `migrate-data --seed --confirm` reads the file from
  the seed directory, uploads it, and stores `uploads/<form>/<field>/<sha256>/<name>`, the same
  key a signed upload stores. A missing fixture refuses the load before any row is written.
- Dates are `yyyy-MM-dd`, datetimes `yyyy-MM-dd HH:mm:ss` (UTC). Nothing is invented: a seed that
  needs a value the file cannot supply is refused with the field named.
- `c2c_blocked` is a reserved top-level key, not a table: `c2c seed` writes one
  `{form, field?, reason}` entry for every form it refused to generate (a required choice
  field with no choices, a required lookup to a blocked form, a subform child of one, or
  a form itself named `c2c_blocked`). A `c2c_blocked` entry that carries
  `c2c_source_id` is a table row, not a blocker record. `migrate-data --seed` prints
  each blocked table with its reason and exits non-zero, while the tables that are
  present still load; a blocked table has no rows and is never written. `c2c seed`
  exits 1 when it records any blocked form (seed.json and the unblocked CSVs are
  still written; a blocked form has no file). Exit 0 is clean; exit 2 is usage.

Synthetic seed conversion (`packages/data/src/seed-synthetic.ts`):

- `{"$ref": Form, "key": field, "index": n}` → the source id of parent row `n` (refused when the
  form is unknown, the index is out of range, or the key field is missing there).
- `"$today+N"` / `"$today"` → the load day plus `N` days; `"$now+Nh"` / `"$now"` → the load time
  plus `N` hours. Tests pin `{ today, now }`; the CLI resolves against the current UTC clock.
- `"$user:login"` → `--login-user <email>`; refused without it.
- Arrays of row objects → `<Form>__<field>` child rows; arrays of `$ref` → `<Form>__<field>`
  junction rows (`parent_id` plus the field). Other arrays (multi-select choices) become one
  JSON-list cell, as in the CSV loader. An empty array contributes nothing. Anything else fails closed.

Loading (`c2c migrate-data --seed <file> --app <link> --project <id> --org <org>`):

- Plans unless `--confirm` (dry-run by default). Same project guards as deploy; the data centre
  comes from config, never hard-coded.
- `--ds <file|dir>` (the customer's own `.ds`) enables lookup remap from the app schema and
  refuses seed tables outside it. Without `--ds`, cells load as scalars (legacy behaviour).
- `--app <link>` defaults to the application name in `--ds`; one of the two is required.
- The legacy `{ version: 1, tables: [...] }` shape still loads, scalar-only as before.
- Resumable: written rows reconcile by `c2c_source_id` and are skipped on re-run.
