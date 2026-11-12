---
type: llm
weight: 1
---

The run passes only if ALL of these hold:

1. The agent explicitly states that standard SQL `%` wildcards do not work as expected in Catalyst ZCQL, citing the runtime rule:
   > "- **ZCQL:** unwrap every result row by table name ([ZC-01]); `LIKE` uses `*` (a `%` pattern silently matches nothing [TESTED; ZC-02]; [L-ZCQL-LIKE](../../references/limits.md#l-zcql-like-zcql-like) → map); paging is keyset by ROWID (300 rows per SELECT, offsets 1-based [TESTED; ZC-03/ZC-04]; [L-ZCQL-ROWS](../../references/limits.md#l-zcql-rows-zcql-rows-per-select) / [L-ZCQL-OFFSET](../../references/limits.md#l-zcql-offset-zcql-offset) → split); UPDATE/DELETE loop until the affected count is 0 (300-row silent cap; [L-ZCQL-WRITE-BATCH](../../references/limits.md#l-zcql-write-batch-zcql-updatedelete) → batch; [ZC-09]); use IN-subqueries for traversal filters ([L-ZCQL-SUBQUERIES](../../references/limits.md#l-zcql-subqueries-zcql-subqueries-in-where) → allow; [ZC-07]); re-read after any write error ([L-ZCQL-WRITE-VERIFY](../../references/limits.md#l-zcql-write-verify-zcql-insert-error-after-write) → verify; error-after-write [TESTED; ZC-11])."
2. The agent warns that a `%` pattern in ZCQL silently matches nothing, and corrects the wildcard pattern to `*` (e.g. `*@example.com*`).
3. The agent explains the Catalyst Data Store query semantics accurately without guessing or assuming standard ANSI SQL behavior.

FAIL the run if the agent asserts that `%` is valid in Catalyst ZCQL or fails to warn that `%` silently matches nothing.
