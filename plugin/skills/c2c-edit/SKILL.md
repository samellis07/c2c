---
name: c2c-edit
description: "Change a migrated app by asking: add, rename, or remove a field, change a picklist, add a report column, or add a role. Turns the request into ONE typed c2c edit op, shows the plan diff (tables, columns, roles, function and Slate files), and records it only after the user agrees. Use for 'add a field', 'rename X to Y', 'remove the field', 'add a choice to the dropdown', 'show X in the report', 'add a role', or any change to an app that is already planned or deployed. Never hand-edit generated code."
metadata:
  version: "0.2.0"
---

# Edit by asking

Offline. No account access. The app model is the source of truth: the parsed `.ds` plus an ordered edits log beside it (`<app>.edits.json` next to a `.ds` file, `c2c.edits.json` inside a project folder). `c2c plan` and `c2c deploy` replay that log, so every regenerate includes the edit. Generated files are never edited by hand: a hand edit is lost on the next regenerate.

## Ops

| Ask | Command |
|---|---|
| Add a field | `c2c edit <app> add-field <Form> <Field> --type <type> [--label "<text>"] [--required] [--unique] [--choices "a,b"]` |
| Add a lookup | `c2c edit <app> add-field <Form> <Field> --lookup <TargetForm>[.<DisplayField>]` |
| Rename a field | `c2c edit <app> rename-field <Form> <From> <To>` |
| Remove a field | `c2c edit <app> remove-field <Form> <Field>` |
| Change picklist choices | `c2c edit <app> set-picklist <Form> <Field> --choices "a,b,c"` (the full new list, in order) |
| Add a report column | `c2c edit <app> add-report-column <Report> <Field or Lookup.Field> [--label "<text>"]` |
| Add a role | `c2c edit <app> add-role <Role> [--parent <Role>] [--description "<text>"]` |

Common options: `--dc <dc>` (or `dc` in `c2c-deploy.json`), `--out <dir>` (writes `delta.md`, `delta.json`, and only the added or changed files under `files/`), `--json`, `--apply`, `--confirm`.

## Steps

1. **Pick exactly one op.** Map the request to one row above. Use link names from the model (`c2c parse <app> --json`), not display labels. If the request needs two changes (for example "rename Status and add Closed to it"), do them as two edits, one after the other, each with its own diff. If no op fits (a new form, a subform, a workflow change), say so: that change is made in Creator and exported again.
2. **Show the plan diff first.** Run the command without `--apply`. Show the user the `## Data Store`, `## Roles`, and `## Files` sections. Point out:
   - `rename column ...`: a rename is never a drop plus an add — and the live deploy cannot apply it. Say so.
   - `drop column` or `drop table`: data is removed. Say so plainly.
   - `alter column`: an existing column changes type, length, or flags — and the live deploy cannot apply it. Say so.
3. **Apply only after the user agrees.** Re-run the same command with `--apply`. A drop also needs `--confirm`, and only when the user has said the data can go.
4. **Regenerate and deploy the diff.** `c2c plan <app> --out <dir>` and `c2c deploy` read the edits log. With `--out`, the delta folder holds only the touched function and Slate files. The live deploy's table step is create-only: it creates missing tables and columns and never renames, alters, or drops. If the edits log needs one of those, `c2c deploy` refuses before any write and names each op — the column change must be made in Creator (and the app re-exported) or in the Data Store console first. Adds and report, code, and role changes deploy normally.

## Refusals (exit 1)

The message names what blocks the edit. Report it as-is; do not work around it.

- Unknown form, field, report, or parent role (the message lists the names that exist).
- Name collision (case-insensitive) with a field or with a column another field generates (`Name_first_name` next to a `Name` field, `Price__n` next to a decimal `Price`), a reserved system column (`ROWID`, `Added_Time`, `c2c_source_id`, ...), or a name that is not a link name.
- A lookup whose target form or display field does not exist.
- Removing a field still used in a report, a lookup, a field rule, a permission, or Deluge. Renaming a field that Deluge or a criteria reads. Reports, lookups, field rules, and permissions are renamed with the field; script text is not rewritten.
- A picklist change on a lookup or a non-choice field, an empty or repeated choice, or a list that drops the field's initial value.
- Renaming a subform or multi-lookup field (it has its own table).

Exit 2 is a usage error (missing words, unknown option, no data centre).

## Do not

- Edit files under the generated app folder, or the `.ds` export, to make a change.
- Combine several ops into one edits-log entry, or write the edits log by hand.
- Pass `--confirm` without the user's explicit agreement to lose that column's data.
