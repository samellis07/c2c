# Report filters requiring manual translation

[TESTED] Report criteria and named-filter criteria share `reportCriteria()`.
Literal comparisons, boolean combinations, supported relative dates and
`zoho.loginuser` / `zoho.loginuserid` bindings are supported. An owner variable,
a user-function call, or a record query used as a comparison value stays a
`report-criteria` TODO. The report also carries a UI TODO and returns no rows;
a named filter that cannot compile returns no rows when selected. These are
two counted consequences of the same untranslated criterion.

The report and filter IR retain the original criteria (see
[IR v1](ir-v1.md)). Creator variables and `thisapp` calls are listed with their
Deluge documentation sources in [the builtin catalogue](deluge-builtins.json).
[Record access rules](security-model.md) must still hold after a repair.

## Repair procedure

1. Run `c2c analyze <export.ds> --json`. Locate `report-criteria` entries under
   `deluge.todoLocations`; the location names the report and, for a named
   filter, its label. In a writable copy of the export, find that report in
   `reports`, then its `show all rows from Form [criterion]` expression (or its
   named `filters` block). Preserve the original export for comparison.
2. Resolve the unsupported value using the table below. Changing an identity
   or replacing a dynamic value with a snapshot requires an explicit decision
   about the intended report behavior.
3. Run analyze again and regenerate with `c2c plan <copy.ds> --out <directory>`.
   Check that the intended report criteria and access policy remain present.
   Keep unresolved criteria counted and reports closed until implemented.
4. Compare matching and nonmatching rows for two different authenticated users,
   including missing lookup rows, null values and permission-denied reads.
   Check every OR branch and AND condition. Use API read-back and local tests;
   a comparison is incomplete if it tests only the positive case.

| Unsupported value | Required manual work and location |
|---|---|
| `zoho.adminuserid` | Obtain the Creator application owner's email. In the copied report criterion replace only that variable with a quoted email literal, preserving the surrounding lookup paths, AND/OR operators and parentheses. An owner transfer requires updating that literal and regenerating. Do not substitute `zoho.loginuserid` unless changing the rule to the current user is intended. Environment variables alone do not repair the compiler gap. |
| `thisapp.function()` | Open the function in the export's `functions` section and inspect all its reads and return paths. Implement its result resolution on the server for the authenticated caller before applying the report predicate, including missing-record and denied-read behavior. A literal replacement in the copied report is only suitable for a deliberately fixed value; it does not preserve a dynamic function. |
| `OtherForm[criterion].Lookup.ID` | Implement the dependent record query on the server using the authenticated identity and existing read policy, then resolve its lookup id before evaluating the complete report criterion. Preserve relative-date grouping, OR precedence and multi-lookup membership. A single fixed id cannot preserve a per-user rule. |

[UNVERIFIED] Equivalence of a custom server implementation, including Creator's
selection when several source rows match and its null/multi-lookup semantics,
must be established for the particular app. The generator does not infer those
choices. Do not remove the TODO or widen the report to all rows to make it appear
migrated. Regenerating an unmodified export retains these gaps.
