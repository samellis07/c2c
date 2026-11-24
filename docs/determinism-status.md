# Determinism status

Regenerable summary of a corpus of sample Creator apps (not included). Recompute with
`C2C_FIXTURES_DIR=<fixtures> npm run determinism:status`; `npm test` fails when this file is
stale and the local corpus is present. Counts and public construct names only — no app names,
paths, or script text. A construct naming an app identifier, including a quoted name
anywhere in the construct, is bucketed as `(app identifier)`.
Each non-deterministic app adds one construct set: the sorted public names and that
app's residual item count, with no app name.

Two app counts are shown. "Apps with no residual todos" counts apps where `c2c analyze`
finds zero residual TODO items and no `c2c fill-todos` lock entries apply. "Apps with no
residual todos and no silent drops" also requires that no declared construct is silently
dropped (neither generated nor listed as a TODO or manual step). Only that second number
is the deterministic count, and only those apps count toward the 95% / 100% migration
targets. The gap between the two numbers is the apps held back only by silent drops.

A residual TODO item is an untranslated Deluge hole or one generated UI stub
(a field, report, page, or ZML item). Each UI stub is included in the residual,
so an app with a stub is not deterministic.
0 of the 13 deterministic apps still have UI TODO stubs (0 in total).

The builtin catalogue lists 20 TODO entries
(`docs/deluge-builtins.json` `counts.todo`). That is not the corpus residual counted here: one
TODO item per untranslated construct occurrence.

| | |
|---|---:|
| corpus apps | 67 |
| apps with no residual todos | 13/67 |
| apps with no residual todos and no silent drops (deterministic) | 13/67 (19.4%) |
| silent drops (total) | 0 |
| residual TODO items | 303 |
| distinct TODO kinds | 44 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 20 TODO kinds

| construct | count |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 73 |
| `client-condition-uses-server` | 62 |
| `Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.` | 50 |
| `openurl-dropped-unrecognized-branch-shape` | 34 |
| `openurl-dropped-with-server-logic` | 11 |
| `Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.` | 8 |
| `openurl-unsupported-target` | 6 |
| `Static <style> CSS not carried over: the page sanitizer drops 35 static style rules or declarations (background-color declaration, selector, unparsed declaration x33)` | 5 |
| `Custom action (app identifier) is not migrated; its button is turned off.` | 4 |
| `Static <style> CSS not carried over: the page sanitizer drops 21 static style rules or declarations (background-color declaration, selector, unparsed declaration x19)` | 4 |
| `Report (app identifier) lists column Added_Location, a Creator built-in record column; the generated schema has no column for it.` | 3 |
| `Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)` | 3 |
| `Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (CSS built by a Deluge tag)` | 3 |
| `Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.` | 2 |
| `client-loop-uses-server` | 2 |
| `Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (CSS built by a Deluge tag x3)` | 2 |
| `Static <style> CSS not carried over: the page sanitizer drops 56 static style rules or declarations (CSS built by a Deluge tag x56)` | 2 |
| `The <iframe> element is removed from this page snippet by the sanitizer` | 2 |
| `ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand` | 2 |
| `client-shim-unsupported:(app identifier)` | 1 |

## Top 0 silent-drop kinds

| construct | count |
|---|---:|

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `client-condition-uses-server` | 4 |
| `Server-side Deluge snippet requires manual translation` | 4 |
| `Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.` | 2 |
| `openurl-dropped-unrecognized-branch-shape` | 2 |
| `Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.` | 1 |
| `Field (app identifier) sets `duration = 30`; the generated video field hands recording off to the device camera app with no recording-length limit.` | 1 |
| `The <iframe> element is removed from this page snippet by the sanitizer` | 1 |

## Machine-readable

```json
{
  "deterministicApps": 13,
  "deterministicWithUiTodos": {
    "apps": 0,
    "uiTodos": 0
  },
  "kinds": [
    {
      "construct": "Server-side Deluge snippet requires manual translation",
      "count": 73
    },
    {
      "construct": "client-condition-uses-server",
      "count": 62
    },
    {
      "construct": "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
      "count": 50
    },
    {
      "construct": "openurl-dropped-unrecognized-branch-shape",
      "count": 34
    },
    {
      "construct": "openurl-dropped-with-server-logic",
      "count": 11
    },
    {
      "construct": "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
      "count": 8
    },
    {
      "construct": "openurl-unsupported-target",
      "count": 6
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 35 static style rules or declarations (background-color declaration, selector, unparsed declaration x33)",
      "count": 5
    },
    {
      "construct": "Custom action (app identifier) is not migrated; its button is turned off.",
      "count": 4
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 21 static style rules or declarations (background-color declaration, selector, unparsed declaration x19)",
      "count": 4
    },
    {
      "construct": "Report (app identifier) lists column Added_Location, a Creator built-in record column; the generated schema has no column for it.",
      "count": 3
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)",
      "count": 3
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (CSS built by a Deluge tag)",
      "count": 3
    },
    {
      "construct": "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.",
      "count": 2
    },
    {
      "construct": "client-loop-uses-server",
      "count": 2
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (CSS built by a Deluge tag x3)",
      "count": 2
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 56 static style rules or declarations (CSS built by a Deluge tag x56)",
      "count": 2
    },
    {
      "construct": "The <iframe> element is removed from this page snippet by the sanitizer",
      "count": 2
    },
    {
      "construct": "ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
      "count": 2
    },
    {
      "construct": "client-shim-unsupported:(app identifier)",
      "count": 1
    },
    {
      "construct": "Embedded zc-component form (app identifier) has no generated view",
      "count": 1
    },
    {
      "construct": "Embedded zc-component report (app identifier) has no generated view",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `annotation = true`; the generated image field accepts the chosen file unchanged, with no tool to draw or mark it up first.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `duration = 150`; the generated video field hands recording off to the device camera app with no recording-length limit.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `duration = 30`; the generated video field hands recording off to the device camera app with no recording-length limit.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `show gallery = true`; the generated scan field cannot read a code from a photo in the gallery.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `show onload = true`; the generated image field opens its camera only when the user taps the control, never automatically when the form loads.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `show onload = true`; the generated scan field opens its scanner only when the user taps the control, never automatically when the form loads.",
      "count": 1
    },
    {
      "construct": "Inline style declarations not carried over (unsafe or unsupported CSS): (app identifier)",
      "count": 1
    },
    {
      "construct": "Inline style declarations not carried over (unsafe or unsupported CSS): text-align, text-align",
      "count": 1
    },
    {
      "construct": "Map report Map_View is shown as a list because Raise_Incident has no address field to plot.",
      "count": 1
    },
    {
      "construct": "Map report Today_Inspection_Map is shown as a list because Add_New_Inspection has no address field to plot.",
      "count": 1
    },
    {
      "construct": "Report (app identifier) has a `customlayouts` settings block (template (app identifier)) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report (app identifier) has an `options` setting (week start day = monday) that Catalyst does not carry into the generated timeline report.",
      "count": 1
    },
    {
      "construct": "Report (app identifier) lists column Record_Status, a Creator built-in record column; the generated schema has no column for it.",
      "count": 1
    },
    {
      "construct": "sendmail-attachment:view",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (@ rule)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background-image declaration)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 13 static style rules or declarations (CSS built by a Deluge tag x13)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (src declaration x3)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 44 static style rules or declarations (background-color declaration x2, selector x2, unparsed declaration x40)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 7 static style rules or declarations (CSS built by a Deluge tag x7)",
      "count": 1
    },
    {
      "construct": "The <script> element is removed from this page snippet by the sanitizer",
      "count": 1
    },
    {
      "construct": "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
      "count": 1
    }
  ],
  "noTodoApps": 13,
  "perAppConstructSets": [
    {
      "constructs": [
        "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only."
      ],
      "items": 1
    },
    {
      "constructs": [
        "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only."
      ],
      "items": 1
    },
    {
      "constructs": [
        "client-condition-uses-server"
      ],
      "items": 1
    },
    {
      "constructs": [
        "client-condition-uses-server"
      ],
      "items": 2
    },
    {
      "constructs": [
        "client-condition-uses-server"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server"
      ],
      "items": 6
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "openurl-dropped-unrecognized-branch-shape",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 6
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported:(app identifier)",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)"
      ],
      "items": 8
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "Embedded zc-component form (app identifier) has no generated view",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "openurl-dropped-unrecognized-branch-shape"
      ],
      "items": 9
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape",
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 36
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 21 static style rules or declarations (background-color declaration, selector, unparsed declaration x19)",
        "Static <style> CSS not carried over: the page sanitizer drops 35 static style rules or declarations (background-color declaration, selector, unparsed declaration x33)"
      ],
      "items": 12
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 6
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 11
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)",
        "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (src declaration x3)",
        "The <iframe> element is removed from this page snippet by the sanitizer"
      ],
      "items": 11
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (CSS built by a Deluge tag x3)"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 56 static style rules or declarations (CSS built by a Deluge tag x56)"
      ],
      "items": 18
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape",
        "openurl-dropped-with-server-logic",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 8
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "Field (app identifier) sets `show onload = true`; the generated scan field opens its scanner only when the user taps the control, never automatically when the form loads.",
        "openurl-unsupported-target"
      ],
      "items": 6
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "Field (app identifier) sets `show gallery = true`; the generated scan field cannot read a code from a photo in the gallery.",
        "Inline style declarations not carried over (unsafe or unsupported CSS): (app identifier)",
        "openurl-dropped-with-server-logic",
        "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 10
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "Field (app identifier) sets `show onload = true`; the generated image field opens its camera only when the user taps the control, never automatically when the form loads.",
        "openurl-dropped-unrecognized-branch-shape",
        "Report (app identifier) lists column Record_Status, a Creator built-in record column; the generated schema has no column for it."
      ],
      "items": 7
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "Field (app identifier) sets `duration = 150`; the generated video field hands recording off to the device camera app with no recording-length limit.",
        "Map report Today_Inspection_Map is shown as a list because Add_New_Inspection has no address field to plot.",
        "openurl-dropped-unrecognized-branch-shape",
        "Report (app identifier) lists column Added_Location, a Creator built-in record column; the generated schema has no column for it."
      ],
      "items": 6
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "Inline style declarations not carried over (unsafe or unsupported CSS): text-align, text-align",
        "openurl-dropped-unrecognized-branch-shape",
        "openurl-dropped-with-server-logic",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 21 static style rules or declarations (background-color declaration, selector, unparsed declaration x19)",
        "Static <style> CSS not carried over: the page sanitizer drops 35 static style rules or declarations (background-color declaration, selector, unparsed declaration x33)",
        "Static <style> CSS not carried over: the page sanitizer drops 44 static style rules or declarations (background-color declaration x2, selector x2, unparsed declaration x40)"
      ],
      "items": 18
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "Map report Map_View is shown as a list because Raise_Incident has no address field to plot.",
        "openurl-dropped-with-server-logic"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape"
      ],
      "items": 6
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape"
      ],
      "items": 8
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape",
        "openurl-dropped-with-server-logic"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape",
        "openurl-dropped-with-server-logic"
      ],
      "items": 14
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-unrecognized-branch-shape",
        "ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 6
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-with-server-logic"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "openurl-dropped-with-server-logic"
      ],
      "items": 6
    },
    {
      "constructs": [
        "Embedded zc-component report (app identifier) has no generated view",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (@ rule)",
        "The <script> element is removed from this page snippet by the sanitizer"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field (app identifier) sets `annotation = true`; the generated image field accepts the chosen file unchanged, with no tool to draw or mark it up first.",
        "Report (app identifier) has a `customlayouts` settings block (template (app identifier)) that Catalyst generates no equivalent for."
      ],
      "items": 2
    },
    {
      "constructs": [
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens."
      ],
      "items": 1
    },
    {
      "constructs": [
        "Field (app identifier) sets `duration = 30`; the generated video field hands recording off to the device camera app with no recording-length limit."
      ],
      "items": 1
    },
    {
      "constructs": [
        "openurl-dropped-unrecognized-branch-shape"
      ],
      "items": 1
    },
    {
      "constructs": [
        "openurl-dropped-unrecognized-branch-shape"
      ],
      "items": 2
    },
    {
      "constructs": [
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Report (app identifier) has an `options` setting (week start day = monday) that Catalyst does not carry into the generated timeline report.",
        "ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Report (app identifier) lists column Added_Location, a Creator built-in record column; the generated schema has no column for it.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 1
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 1
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background-image declaration)"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (CSS built by a Deluge tag)"
      ],
      "items": 9
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (CSS built by a Deluge tag)",
        "Static <style> CSS not carried over: the page sanitizer drops 7 static style rules or declarations (CSS built by a Deluge tag x7)"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 13 static style rules or declarations (CSS built by a Deluge tag x13)"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (CSS built by a Deluge tag x3)"
      ],
      "items": 3
    },
    {
      "constructs": [
        "The <iframe> element is removed from this page snippet by the sanitizer"
      ],
      "items": 1
    }
  ],
  "silentDropKinds": [],
  "silentDropTotal": 0,
  "todoTotal": 303,
  "totalApps": 67
}
```
