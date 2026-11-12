# Blueprint Constructs Inventory

This document inventories `.ds` blueprint constructs used in the fixtures and compares them against what the generator supports.

*Note: The inventory below is based on the blueprints found in the public and synthetic fixtures.*

## Supported Constructs

- **`start stage`**: Supported. The starting stage is extracted as `machine.start`.
- **`stages`**: Supported. Parsed and translated into the machine schema as a list of stage names.
- **`transitions`**: Supported. Parsed and populated in the state machine with `from` and `to` stages.
- **Transition phases (`before`, `during`, `after`)**: Supported for Deluge scripts (`actions { custom deluge script ( ... ) }`). The script blocks are extracted, translated, and emitted as transition scripts.
- **`transition criteria`**: **Supported** (e.g. `transition criteria = (Approval_Status == "Waiting For Approval")`). Recognised on the transition itself and inside any phase, in any letter case; every occurrence gates the transition (all must pass). Evaluated at runtime before the transition is executed — in a dry run there is no stored record, so the transition runs and the reply reports `criteria: "not evaluated in dry run"`. A criterion that fails denies with `transition criteria not met`, distinct from an unknown target stage; one that cannot be translated stays a closed gate and is listed as a fidelity note. One that names a field that is not on the form also stays a closed gate and is listed, and denies with `transition criteria reference an unknown field or function` instead of failing the request. The record-read spellings checked this way are: a bare name; `input.X`/`old.X` member reads; `input["X"]`/`old["X"]` subscripts; `input.get("X")`/`old.get("X")`, `containsKey("X")`, `getJson("X")`, and `keys().contains("X")` on the record; and each of these on `input.toMap()` (nested `toMap()` too), on `ifnull(...)` when every argument evaluates to the record (so `ifnull(input, old).get("X")` still evaluates), on the record in parentheses, or on top-level `||`, `&&`, and `if()` / `?:` conditional expressions (so long as all value arms evaluate to the record). A root that sits only in the condition of an `if()` / `?:` receiver is not a value arm. A receiver mixing the record with any other value denies even for a field on the form. The mixed rows are `ifnull(input, {"a":1}).get("Amount")`, `(input || {"a":1})["Amount"]`, `if(Amount > 0, input, {"Amount":0}).Amount`, and `(Amount > 0 && input)["Amount"]`. Any other bare occurrence of the record denies exactly like an unknown field. A key in these spellings that is not a double-quoted string literal (a variable, a concatenation, a single-quoted string) denies the same way, even when it would name a field on the form. Any call the translator does not support (for example `input.GET("X")` or `input.getAll("X")`) denies the same way and is listed, wherever it sits in the criterion. Sub-keys under a field that is on the form (`input.Amount["Sub"]`, `input.get("Amount").get("Sub")`) are not checked. Bare `Status` (the machine's status column) and `ROWID` read the record like `input.Status`/`input.ROWID`.

## Unsupported Constructs (Fidelity Notes Emitted)

The generator parses these, but explicitly skips translating their runtime semantics. Fidelity notes (`todos`) are emitted for manual remediation:

- **`transition owner`** (inside `before` phase):
  - Example: `transition owner ( permissions = {"Employee"} )`
  - *Locations*: Various public and synthetic fixtures
  - *Note*: Currently ignored in `emitBlueprint`. Approvers are extracted from the transition's direct properties, not from the `transition owner` block inside `before`.

- **`during` phase actions**:
  - Example: `action = update_fields`, `workflow status = true`, `visible fields = [...]`, `message = "..."`
  - *Locations*: Various public and synthetic fixtures
  - *Note*: `emitBlueprint` extracts Deluge scripts from `during`. `action = update_fields` is migrated: the `visible`/`updatable`/`mandatory`/`readonly`/`hidden` field lists gate `body.fields` on the transition endpoint (see the stage/during field-settings support above), and `workflow status` rides the transition row as `workflowStatus` — `true` (the Creator default) fires the form's edit-scope On Validate and On Success workflows around the transition's field write, with the stage write last; `false` skips them. A `during` `action` of any other value and a non-boolean `workflow status` are still listed as todos.

- **`chart data`**:
  - Example: `from port`, `to port`, `path`
  - *Locations*: Present in nearly all blueprint transitions in public and synthetic fixtures
  - *Note*: Purely visual layout metadata for the source platform UI. Safely ignored by the backend engine, but an explicit note is now left.
