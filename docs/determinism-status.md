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
0 of the 39 deterministic apps still have UI TODO stubs (0 in total).

The builtin catalogue lists 20 TODO entries
(`docs/deluge-builtins.json` `counts.todo`). That is not the corpus residual counted here: one
TODO item per untranslated construct occurrence.

| | |
|---|---:|
| corpus apps | 67 |
| apps with no residual todos | 39/67 |
| apps with no residual todos and no silent drops (deterministic) | 39/67 (58.2%) |
| silent drops (total) | 0 |
| residual TODO items | 72 |
| distinct TODO kinds | 29 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 20 TODO kinds

| construct | count |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 28 |
| `Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.` | 6 |
| `openurl-unsupported-target` | 3 |
| `Report (app identifier) lists column Added_Location, a Creator built-in record column; the generated schema has no column for it.` | 3 |
| `Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)` | 3 |
| `openurl-dropped-unrecognized-branch-shape` | 2 |
| `openurl-dropped-with-server-logic` | 2 |
| `The <iframe> element is removed from this page snippet by the sanitizer` | 2 |
| `The <script> element is removed from this page snippet by the sanitizer` | 2 |
| `ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand` | 2 |
| `Custom action (app identifier) is not migrated; its button is turned off.` | 1 |
| `Embedded zc-component form (app identifier) has no generated view` | 1 |
| `Field (app identifier) sets `annotation = true`; the generated image field accepts the chosen file unchanged, with no tool to draw or mark it up first.` | 1 |
| `Field (app identifier) sets `duration = 150`; the generated video field hands recording off to the device camera app with no recording-length limit.` | 1 |
| `Field (app identifier) sets `duration = 30`; the generated video field hands recording off to the device camera app with no recording-length limit.` | 1 |
| `Field (app identifier) sets `show onload = true`; the generated image field opens its camera only when the user taps the control, never automatically when the form loads.` | 1 |
| `Inline style declarations not carried over (unsafe or unsupported CSS): background, background, background-image, background, background, background` | 1 |
| `Inline style declarations not carried over (unsafe or unsupported CSS): background, background, background, background, background` | 1 |
| `Inline style declarations not carried over (unsafe or unsupported CSS): text-align, text-align` | 1 |
| `Map report Map_View is shown as a list because Raise_Incident has no address field to plot.` | 1 |

## Top 0 silent-drop kinds

| construct | count |
|---|---:|

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 4 |
| `Field (app identifier) sets `duration = 30`; the generated video field hands recording off to the device camera app with no recording-length limit.` | 1 |
| `Map report Map_View is shown as a list because Raise_Incident has no address field to plot.` | 1 |
| `Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)` | 1 |
| `The <script> element is removed from this page snippet by the sanitizer` | 1 |
| `ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand` | 1 |
| `ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand` | 1 |

## Machine-readable

```json
{
  "deterministicApps": 39,
  "deterministicWithUiTodos": {
    "apps": 0,
    "uiTodos": 0
  },
  "kinds": [
    {
      "construct": "Server-side Deluge snippet requires manual translation",
      "count": 28
    },
    {
      "construct": "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
      "count": 6
    },
    {
      "construct": "openurl-unsupported-target",
      "count": 3
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
      "construct": "openurl-dropped-unrecognized-branch-shape",
      "count": 2
    },
    {
      "construct": "openurl-dropped-with-server-logic",
      "count": 2
    },
    {
      "construct": "The <iframe> element is removed from this page snippet by the sanitizer",
      "count": 2
    },
    {
      "construct": "The <script> element is removed from this page snippet by the sanitizer",
      "count": 2
    },
    {
      "construct": "ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
      "count": 2
    },
    {
      "construct": "Custom action (app identifier) is not migrated; its button is turned off.",
      "count": 1
    },
    {
      "construct": "Embedded zc-component form (app identifier) has no generated view",
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
      "construct": "Field (app identifier) sets `show onload = true`; the generated image field opens its camera only when the user taps the control, never automatically when the form loads.",
      "count": 1
    },
    {
      "construct": "Inline style declarations not carried over (unsafe or unsupported CSS): background, background, background-image, background, background, background",
      "count": 1
    },
    {
      "construct": "Inline style declarations not carried over (unsafe or unsupported CSS): background, background, background, background, background",
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
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background-image declaration)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 11 static style rules or declarations (CSS built by a Deluge tag x11)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 7 static style rules or declarations (CSS built by a Deluge tag x7)",
      "count": 1
    },
    {
      "construct": "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
      "count": 1
    }
  ],
  "noTodoApps": 39,
  "perAppConstructSets": [
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Custom action (app identifier) on report (app identifier) runs its workflow, but a navigation (openUrl) inside it is not carried over — the button reports success without taking the user anywhere.",
        "Embedded zc-component form (app identifier) has no generated view",
        "openurl-dropped-unrecognized-branch-shape"
      ],
      "items": 4
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
        "Field (app identifier) sets `annotation = true`; the generated image field accepts the chosen file unchanged, with no tool to draw or mark it up first.",
        "Report (app identifier) has a `customlayouts` settings block (template (app identifier)) that Catalyst generates no equivalent for."
      ],
      "items": 2
    },
    {
      "constructs": [
        "Field (app identifier) sets `duration = 150`; the generated video field hands recording off to the device camera app with no recording-length limit.",
        "Map report Today_Inspection_Map is shown as a list because Add_New_Inspection has no address field to plot.",
        "Report (app identifier) lists column Added_Location, a Creator built-in record column; the generated schema has no column for it."
      ],
      "items": 4
    },
    {
      "constructs": [
        "Field (app identifier) sets `duration = 30`; the generated video field hands recording off to the device camera app with no recording-length limit."
      ],
      "items": 1
    },
    {
      "constructs": [
        "Field (app identifier) sets `show onload = true`; the generated image field opens its camera only when the user taps the control, never automatically when the form loads.",
        "Report (app identifier) lists column Record_Status, a Creator built-in record column; the generated schema has no column for it."
      ],
      "items": 2
    },
    {
      "constructs": [
        "Inline style declarations not carried over (unsafe or unsupported CSS): background, background, background-image, background, background, background",
        "Inline style declarations not carried over (unsafe or unsupported CSS): background, background, background, background, background"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Inline style declarations not carried over (unsafe or unsupported CSS): text-align, text-align",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Map report Map_View is shown as a list because Raise_Incident has no address field to plot."
      ],
      "items": 1
    },
    {
      "constructs": [
        "openurl-dropped-unrecognized-branch-shape",
        "Server-side Deluge snippet requires manual translation"
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
        "Server-side Deluge snippet requires manual translation",
        "The <script> element is removed from this page snippet by the sanitizer"
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
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
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
      "items": 3
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)",
        "The <iframe> element is removed from this page snippet by the sanitizer"
      ],
      "items": 6
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
        "Static <style> CSS not carried over: the page sanitizer drops 11 static style rules or declarations (CSS built by a Deluge tag x11)"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 7 static style rules or declarations (CSS built by a Deluge tag x7)"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)"
      ],
      "items": 1
    },
    {
      "constructs": [
        "The <script> element is removed from this page snippet by the sanitizer"
      ],
      "items": 1
    },
    {
      "constructs": [
        "ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 1
    },
    {
      "constructs": [
        "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 1
    }
  ],
  "silentDropKinds": [],
  "silentDropTotal": 0,
  "todoTotal": 72,
  "totalApps": 67
}
```
