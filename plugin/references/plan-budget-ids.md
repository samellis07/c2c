# Offline plan budget row IDs

`c2c plan` prints each budget row as `[STATUS] (id)`. These IDs are stable
identifiers for reading the plan and matching a row to its fix. A status of
`PASS` means the check is currently within its limit; `WARN` or `FAIL` needs
the action listed in the row.

| ID | Meaning | Fix when WARN or FAIL |
|---|---|---|
| `columns` | Number of generated columns in one table compared with the Development limit. | Split the form into child tables for subforms and side tables for other fields, then rerun `c2c plan`. |
| `unique-varchar` | Store-level and handler-checked unique varchar fields combined, compared with Catalyst's per-table cap. | To keep every field store-unique, remove the No Duplicate setting until the cap is met. Otherwise, the generated handler checks overflow fields before inserts and updates; those checks are not atomic and do not run for CSV or seed imports. |
| `fk` | Number of lookup/relation fields in a table compared with the plan's foreign-key limit. | Replace excess lookups with plain fields and app-layer checks, then rerun `c2c plan`. |
| `select-width` | Widest generated table compared with the documented select width and the unverified runtime limit. | At WARN, run probe `P-WIDTH` before the data load. At FAIL, generated reads use bounded column batches; run `P-WIDTH` before relying on a wider single SELECT. |
| `joins` | Join count used by generated reads. This plan currently emits single-table reads, so the row is informational and passes. | No plan change is needed for generated reads; confirm the environment limit with probe `P-JOIN` if application queries use joins. |
| `org-tables` | Number of Data Store table creates in this app; NoSQL tables are shown separately. This row is informational and passes. | If Catalyst refuses a create with `403 API_LIMIT_REACHED` / `API Limit for table`, follow the org-wide table-limit recovery guidance in [limits](limits.md). |
| `dev-row-cap` | Largest measured Data Store row counts against the unpublished Development per-table cap. A count cannot clear the hidden cap. | Supply source counts and rehearse large loads outside Development; a row-limit refusal stops that table and the mover checkpoints for reruns. |
| `varchar-length` | Source strings compared with generated VarChar lengths, with JavaScript code-point semantics stated as unverified. | Shorten over-length values or confirm the field should be text; provide a complete source to measure all values. |
| `dev-api-calls` | Estimated mover API calls from measured source row counts compared with the documented Development allowance. | Supply source counts, load in stages, and watch API usage; the published figure is unverified. |
| `dev-write-rate` | Estimated per-table mover insert calls compared with the documented Development write rate. | Run probe `P-RATE` before a large load; stage the load if the estimate reaches the stated rate or 429s fire. |

The Development limit estimates and varchar-length check are warn-only. Their
figures and character semantics are unverified; supplying complete source data
can improve the estimates but cannot verify unpublished Development limits.
