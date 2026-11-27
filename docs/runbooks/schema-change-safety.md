# Changing the app after go-live without losing data

When you change a form in Creator and export the app again, c2c compares the
new export with the one that is deployed and sorts every change into one of
three kinds. Nothing is changed until you say so.

| Change | What c2c does |
|--------|---------------|
| Add a form, a field or a choice; make a text length longer | Goes through. Every row stays as it is. |
| Rename a field | Detected, shown to you, and the values are **moved** to the new name. Needs your go-ahead (below). |
| Delete a field or a form; change a field's type; make its length shorter | **Refused.** c2c prints exactly what would be lost. |

## How a rename is told from a delete plus an add

A Creator export does not carry a field id: the field's link name is the only
name, and a rename changes it. So c2c reads a removed field and a new field as
**one rename** only when nothing else could explain them:

- they sit in the same place in the form (the same field before them),
- they have the same type, length, required, unique, default and lookup,
- and they are the only such pair in that place.

Anything less certain (two look-alike fields at once, a different type, a new
position) stays a delete plus an add, and is refused. Two ways to settle a
doubtful case:

- `--rename Form.Old=New` says it is a rename.
- `--no-detect-renames` says it is not: the old field is deleted and a new one
  added.

## Plan first

    c2c plan <new export> --previous <deployed .ds> --out <folder>

The plan writes `schema-change/delta.md`. If the change is not safe it stops
and prints, for example:

    - detected rename Book.Author -> Writer (same type, constraints and position; values move to the new name)
    would lose:
      - Book.Rating: every stored value is deleted

and the steps to go on. Nothing is planned until you act on it.

## Go ahead with a rename or a delete

1. Take a backup of the rows: `c2c rollback-export --ds <deployed .ds> --out <backup folder> --confirm`.
2. Plan again with `--allow-destructive --backup <backup folder>`. c2c checks
   the backup belongs to this app before it accepts it.
3. When the store applies a rename it **copies** the values into the new
   column, checks every value arrived, and keeps the old column. The old column
   is dropped only when the drop is confirmed too. Read the detected pairs in the
   plan before you confirm: c2c pairs a removed field with an added field of the
   same shape in the same position, so an unrelated field of the same shape
   (for example one text field replaced by another) can be paired by mistake,
   and the old values would then be copied into the new field. If a pair is
   wrong, pass `--no-detect-renames` and name the real renames yourself.
4. A type change or a shorter length is refused without `--confirm`, even when
   the column holds no value yet, and is refused while any row holds a value in
   the column unless a backup is verified. The message names how many rows are
   affected. A new mandatory column without a default is refused without
   `--confirm` when the table already has rows.
5. A deploy folder whose recorded model is missing, or a previous model that holds
   no forms, is refused: c2c never plans against an empty old model, because that
   would show every column as new and hide a deleted field.

## What is not covered yet

- Applying a rename, a delete or a type change on a **real** Catalyst project
  needs the owner's Catalyst sign-in. Everything above is checked against the
  offline test store only; `c2c deploy --previous` still refuses these changes
  on the live project and prints the same list of what would be lost.
- A deploy of a single `.ds` file records that export in the deploy folder
  (`.c2c-deployed-model`), and `--previous <deploy folder>` compares against it, so
  you do not have to keep the old export. A deploy of a project folder does not
  record it: pass the old export as `--previous`. Recording on a real deploy is
  not yet checked against a live project.
- Rows that still hold a choice you removed from a list keep that stored
  value; c2c does not list or change them. Check them before you publish.
- A composite field (name, address) renamed in Creator changes several columns
  at once and is not paired automatically: use `--rename`.
