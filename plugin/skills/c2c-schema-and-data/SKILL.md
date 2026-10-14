---
name: c2c-schema-and-data
description: "Creator forms to Catalyst Data Store tables and Creator records to Catalyst rows with c2c: field-type mapping, per-table limit budgets (100 columns in Dev, 2 unique varchar, 15 FK, 4 JOINs), subforms to child tables, lookups to FK + ROWID remap, 19-digit IDs as strings, initial values, files to Stratus, and the data load (/row batches of 200, bulk write, checkpoints, counts). Use for 'tables', 'schema', 'columns', 'migrate data', 'import records', 'c2c migrate-data', 'unique varchar', 'MANDATORY_MISSING', 'c2c_source_id', 'files to Stratus'."
metadata:
  version: "0.2.0"
---

# Schema and data

Load `catalyst-datastore` for ZCQL and SDK syntax and `catalyst-stratus` for buckets/objects. This skill adds the migration decisions.

## Part A — Schema (offline, in `c2c plan`)

### Mapping rules

| Creator | Catalyst Data Store | Notes |
|---|---|---|
| Form (stateful) | 1 table named after the form link name | Stateless forms get **no** table |
| Single line ≤ 255 | `varchar(255)` | > 255 or unknown → `text` (not searchable). REST inserts **truncate silently** [TESTED]: c2c validates length before writing |
| Multi line / rich text | `text` (≤ 10,000 [UNVERIFIED]) | Larger → Stratus object + key |
| Number / Decimal / Currency / Percent | `bigint` / exact `varchar(64)` + `double` shadow `<Field>__n` | Catalyst has no decimal type [TESTED]. `double(15,2)` rounds silently on write (`0.105→0.10`) [TESTED]: round HALF_UP client-side first |
| Date / Date-time | `date` / `datetime` | Send `yyyy-MM-dd` / `yyyy-MM-dd HH:mm:ss` only. `05-10-2026` is stored as `0011-04-18` [TESTED]. Blank → omit or `null`, never `""` (`400 INVALID_INPUT … date value expected`) [TESTED] |
| Decision box | `boolean` | Values come back as strings in some paths: compare typed |
| Lookup (single) | `foreign key` → parent `ROWID`, `ON-DELETE-SET-NULL` or `CASCADE` | FK creation by API works [TESTED]. > 15 FKs per table [UNVERIFIED] → plain `bigint` ROWID without constraint |
| Multi-select lookup / users field | child link table / `varchar` list | Users field → app users map |
| Subform | child table `<Form>__<Subform>` with FK to parent | Every subform maps to a child table (NoSQL tables are skipped on deploy [TESTED]). NoSQL is never created by c2c (console only [TESTED]) |
| File upload / image | `varchar` key + Stratus object | See Part C |
| Autonumber | `bigint` + claim protocol (not a unique column race) | Unique columns are not race-safe [TESTED]; reconciler job |
| Formula | computed in code (evaluator); TODO where the evaluator does not support it yet | Never leave an empty column silently |
| Initial value | applied **by the server on insert** when the field is absent | The generated handler applies it; without that, absent fields are stored as `null` [TESTED]. Migrated rows keep their explicit values |
| Record ID | `c2c_source_id varchar(255)`, **nullable, not unique** | Mandatory+unique made every app insert fail with `403 MANDATORY_MISSING "Column c2c_source_id is mandatory and cannot be empty"` and used a unique slot [TESTED]. The loader enforces uniqueness of migrated IDs |
| "No duplicate values" | `is_unique` while the table has ≤ 2 unique varchar columns; beyond that, app-level uniqueness | Cap is 2 [TESTED] |

Reserved ZCQL words (`FROM`, `TO`, …) as column names are renamed with a mapping.

### Budgets (the plan fails closed)

`c2c plan` checks every table; see `references/limits.md`.
- columns ≤ 100 per table in Development [DOC] → else split into 1:1 side tables (splitter);
- unique varchar ≤ 2 [TESTED] → the user picks which fields keep DB uniqueness; the rest are enforced by the handler and the loader;
- JOINs per report ≤ 4 [DOC]; projection ≤ 20 columns until P-WIDTH is measured; never `SELECT *`;
- org table-create limit (unpublished number and window, not a count cap [TESTED]) and Dev row cap [UNVERIFIED] → WARN only, with the probe to run; on `API_LIMIT_REACHED` for table, stop creates and retry after 30/60/120 min.

### Steps

1. `c2c plan exports/<app>.ds --out c2c-out/<app>` (or `c2c schema <ds> --report` and `c2c deploy <ds>` without `--confirm`).
2. Read `plan.md` → *Data Store* section with the user: tables, columns per table and type, unique columns, FKs, side tables, TODOs.
3. Resolve every budget decision with the user; record in `decisions.json`; re-plan until budgets pass.

## Part B — Creating tables (live)

Done by `c2c deploy --confirm` / `c2c provision` (see `c2c-provision-and-deploy`): CLI REST, diff-based, create-missing only (a second run prints `created-tables: none`) [TESTED]. Table permissions and scopes are set via MCP (`c2c-auth-and-access`).

**Rule — default settings only (C2C.md rule 13):** no browser automation, no permission-rule changes, no supplied evidence — loads run through the CLI token and are verified by read-back counts and samples, never by a drive of the user's browser.

**One credential, one refresher (C2C.md rule 14):** a data load holds the CLI credential for a long run — never run a second `catalyst`/`c2c` process or a keep-fresh loop beside it; a second refresher rotates the refresh token out from under both. On a read-only `401 INVALID_TOKEN`, re-read the stored token rather than forcing a refresh.

**Verification:** MCP `CatalystbyZoho_List_All_Tables` + `List_All_Columns` match `plan.json`; one ZCQL `INNER JOIN` per FK returns without error. A column batch failure leaves a half-built table [TESTED]: stop, fix the plan (usually the unique cap), re-run (`--resume`), and confirm the table now has every column.

## Part C — Files → Stratus

1. One bucket per project, name `c2c-<app-link>-<h8>` (lowercase; global namespace [DOC]; `h8` = sha256 of dc:org:project:app, deterministic). Created via **MCP** `CatalystbyZoho_Create_Bucket` (CLI token 401 [TESTED]); read-back `Get_All_Buckets`/`Head_Bucket`.
2. Object key: `<table>/<c2c_source_id>/<field>/<file name>`; the Data Store column holds the key.
3. Bytes: the customer downloads Creator files to their own disk (file URLs in Creator exports are not portable), then c2c uploads with the CLI token or a signed upload (MCP `Create_Upload_Signature`) — [UNVERIFIED]; > 100 MB / multipart is [UNVERIFIED].
4. Verify: object count per field = non-empty file cells; sample `Head_Object` sizes.

## Part D — Data load

### Source

Default: the user's own Creator report exports as **JSON** — the JSON export always carries each record's **ID**; a CSV of the same report carries it only when the export includes the `ID` column (both forms occur). Prefer JSON. Without an `ID` column the loader derives `c2c_source_id` from unique/mapped columns and the plan lists it under `derived ids` (`CSV has no record ids; prefer the JSON export`): lookups then match on display values instead of record IDs, and editing a hashed column yields a new id. Lookups export as display values and subform rows arrive flattened into the parent's columns: split them into child-table rows under an explicit per-subform rule, and refuse a lookup whose display value matches more than one parent — a display value is not a key. Plus `counts.json` (record count per report as Creator shows it). c2c never calls Creator with the user's credentials. A Creator MCP route is **[UNVERIFIED]**.

### Path decision

| Rows in the largest table | Path |
|---|---|
| ≤ 50,000 | `/row` inserts, JSON array ≤ 200 per call [TESTED], bounded pool ≤ 5, `Retry-After` wins |
| > 50,000, or the user wants speed | Bulk write job (CSV in the project bucket, `find_by` + `fk_mapping`) — only after **P-BULK** passes. `catalyst ds:import -ni` crashes (`reading 'bucket_name'`) [TESTED]: use the REST job, not the CLI command |
| Dev row cap risk (very large app) | Rehearse in a non-Dev project; ask the user |

### Steps

1. Plan (dry run):
   ```sh
   c2c migrate-data --source-csv exports/<app>-data --ds exports/<app>.ds --project <id> --org <org> --checkpoint c2c-out/<app>/state/data.json
   ```
   Check: every report maps to a table; per-table row counts equal `counts.json`; FK columns reference parents in the load order; dates/decimals/booleans parse; no value exceeds its column.
2. Ask the user; then the same command with `--confirm`. Parents first, children after; FK values remapped from Creator ID to parent ROWID; IDs kept as **strings** (19-digit Creator IDs exceed JS numbers; ROWIDs are 17 digits and come back as strings from ZCQL [TESTED]).
3. After each table: `SELECT COUNT(ROWID) FROM <t>` (MCP `Execute_Query`) = expected; FK resolution 100% (no child row with a non-null Creator lookup and a null FK); sample 20 rows field-by-field against the export.
4. Interrupted? Re-run with the same `--checkpoint` (resumes after the last acknowledged batch; the loader refuses repeated source IDs).

The row endpoint is `/table/<t>/row`; `/table/<t>/rows` answers `404 INVALID_URL_PATTERN` [TESTED]. Seed formats differ (`c2c seed` CSV vs `--seed` JSON vs the synthetic `seed.json`): use `--source-csv` for real data.

## Stop conditions

- Any budget FAIL in the plan.
- A column batch error during table creation.
- Count mismatch, FK resolution < 100%, or any per-row error in a batch (`data[]` echo shorter than the batch).
- `API_LIMIT_REACHED` (do not assume quota; it has also been a platform bug [UNVERIFIED]); show the raw code and table, and stop. For a table create the limit is org-wide with no published number: keep created tables, continue table-free work, and retry after 30/60/120 min.
- A ZCQL write error: re-read before retrying (error-after-write [TESTED]).

## What to ask the user

- Which unique fields keep DB uniqueness when a table has more than 2.
- Where the JSON report exports and `counts.json` are; confirm counts.
- Whether to rehearse a large load outside Development.
- "Load <n> rows into <tables> on <project>? (yes/no)" before `--confirm`.
