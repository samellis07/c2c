# 9. After go-live: changes, backups and upgrades

Once people use the new app, three jobs come back: changing the
app's fields, keeping a copy of the data, and moving to a newer c2c.
None of them may lose data, and none of them touches the Creator
export, your edits file or your deploy settings by surprise.

The AI runs the commands. Where a step needs the signed-in Catalyst
command line it says so, and the AI waits for you to sign in.

## Change a field and redeploy

Change the app in Creator and export it again, or add the change to
your edits file. Then:

1. `c2c plan <app> --previous <deployed.ds>` compares the new export
   with the one that is deployed and writes `schema-change/delta.md`.
   Each change is listed as one of:
   - **Added** (a new form, a new field, a new choice in a list): safe.
     `c2c deploy --previous <deployed.ds> --confirm` adds it and every
     existing row stays as it is.
   - **Rename, drop or altered field:** refused. Nothing is changed.
     A rename that Creator exported without saying so reads as a drop
     plus an add; tell c2c with `--rename Form.Old=New`.
2. For a drop, a rename or an alteration, take a backup first (next
   section), then plan with `--allow-destructive --backup <export
   folder>`. The plan accepts the backup only when its manifest
   matches the app. c2c does not apply a rename or drop on the live
   project today: the plan shows it, and you do it in the Catalyst
   console. This is an open item, listed in the known gaps.
3. A choice removed from a list is a note in the plan. Rows that
   still hold the removed choice are not listed or changed for you;
   check them before you publish the change.
4. A new mandatory field on a table that already has rows needs a
   value for those rows. Add the field as optional first, fill it,
   then make it mandatory.

What was checked without signing in, for each sample app: adding a
field, a form and a choice keeps every row; a rename and a drop are
refused unless a verified backup is named; a refused change leaves
the rows exactly as they were. Not checked: applying a rename or
drop on a real project.

## Back up and export your data

- `c2c rollback-export --ds <app> --out <dir> --project <id>
  --confirm` writes every stored row as one CSV per form, a manifest
  with a checksum per file, and the record ids in a side file. Run it
  on a schedule of your own: c2c has no timer.
- `--changed-since <state>` writes only what changed since the last
  delta.
- Keep the folder outside the project folder. It holds record values.
- The CSVs read back with `--source-csv`, and Creator's report
  **Import Data** accepts them.
- Subform rows, multiple lookups and file fields are written to side
  folders (`manual/`, `files/`) and are re-entered or re-attached by
  hand.
- Restoring rows into the same Catalyst project is not a c2c feature.
  To rebuild a project, run the migration again from the Creator
  export: loading is safe to repeat because rows are matched by their
  Creator record id and never duplicated.

## Move to a newer c2c

`c2c upgrade <app> --plan <plan folder> --ui <React app folder>`
compares what the newer c2c generates with what is in your folders
and prints:

- the version in the folder and the running version; a folder made by
  a **newer** c2c is refused;
- **regenerated** files, new files and removed files;
- table changes the new version brings, split into added and breaking;
- files you edited by hand, which stop the upgrade.

Without `--apply` it writes nothing. With `--apply` it writes the
regenerated files. If it names a breaking table change, take a backup
and add `--allow-destructive --backup <export folder>`; the table
change itself still goes through the change flow above.

### What is regenerated and what is kept

| Item | On upgrade |
|------|------------|
| Plan files, function code, the table plan, generated screens | **Regenerated** from your Creator export, your edits and your accepted fills |
| Platform files in the React app (shared components, service worker) | **Replaced** by the newer version |
| `src/custom/` in the React app | **Kept** exactly |
| `function-env.json` and `provision/inputs.json` in the plan folder | **Kept** (you edit these) |
| Creator export, edits file, accepted fills, deploy settings | **Not touched** (they live outside the generated folders) |
| Rows in the Data Store, app users, uploaded files | **Not touched**; the upgrade never reads or writes them |
| A generated file you changed by hand | **Stops** the upgrade; move the change to your edits file or `src/custom/`, or pass `--force` to discard it |

After `--apply`, run `c2c deploy` to publish the new code and then
`c2c verify` and `c2c smoke`. Deploy re-runs are safe to repeat.

What was checked without signing in: the comparison, the hand-edit
stop, the refusal to go to an older version, the additive and
breaking table classification, that custom files and the function
environment are byte-for-byte unchanged, and that nothing makes a
network call. Not checked: the redeploy and the smoke run against a
real project.
