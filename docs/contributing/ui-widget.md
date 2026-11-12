# Adding a UI widget

A "widget" is the control a Creator field type renders as. There are two UI
targets, and a new widget lands in both: the React target is where generated
UIs are heading, and the vanilla target remains the `c2c ui` (deploy default)
fallback — a widget that exists in only one leaves the other emitting
`unsupported` or a stub.

## 1. Model

`packages/ui/src/model.ts` is the single source of the widget vocabulary:

- `WIDGET` maps a Creator field-type id (`'single-line'`, `'date-time'`, …)
  to a `Widget` name. If the new widget is a new field type, add the mapping;
  unknown ids fall back to `unsupported`.
- `READONLY` marks widgets that never submit (formula, autonumber, …);
  `FILE_WIDGETS` marks the ones that upload through `POST /uploads/...`
  instead of carrying a JSON value.
- `buildField` can still override the map — `users`, `lookup-multi` and
  `multiselect` are chosen there from field shape (lookup, choices, subform
  token), not just the type id. Check your new type is not claimed by one of
  those rules first.
- The widget also needs a scalar/write mapping: `scalarOf` in
  `packages/ui/src/generate.ts` derives the submit shape per widget, and
  [docs/schema-mapping.md](../schema-mapping.md) documents which column type
  each widget stores.

## 2. Vanilla runtime

The fallback client is `packages/ui/src/client-runtime.js` plus the modules
under `packages/ui/src/client/`. For a new widget:

- rendering — the field-paint switch in `client-runtime.js` (around the
  `field.widget === …` cases);
- validation — the same file's validators (the `Enter an email address.`
  style checks) if the widget takes free input;
- submit semantics — read-only widgets are omitted from the submit body, and
  file-family widgets post `{ key }` references, per
  [docs/ui.md](../ui.md).

## 3. React target

The default field controls live in
`packages/ui-react/template/lib/c2c-ui/form/fields.tsx` (one component per
widget; heavy widgets load lazily so a form pays only for what it uses), with
the `Widget` union in `lib/c2c-ui/types.ts`. Add the control there; app owners
can already override any widget via `components.fields[widget]` in
`src/custom/index.tsx`, so keep the `FieldProps` contract stable.

Template dependencies are pinned — see
[dependencies.md](dependencies.md) before adding one for a widget.

## 4. Tests and evidence

- Model mapping and submit shape: `packages/ui/test/` (and the ui-react
  generator tests under `packages/ui-react/` if the spec changes).
- A widget that leaves a field as a generated stub counts in the residual —
  an app with a UI TODO stub is not deterministic
  ([docs/determinism-status.md](../determinism-status.md)).
- Regenerated output changes go through the determinism rule —
  [determinism.md](determinism.md).
