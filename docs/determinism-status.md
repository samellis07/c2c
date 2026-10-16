# Determinism status

Regenerable summary of a corpus of sample Creator apps (not included). Recompute with
`C2C_FIXTURES_DIR=<fixtures> npm run determinism:status`; `npm test` fails when this file is
stale and the local corpus is present. Counts and public construct names only — no app names,
paths, or script text. A construct naming an app identifier, including a quoted name
anywhere in the construct, is bucketed as `(app identifier)`.
Each non-deterministic app adds one construct set: the sorted public names and that
app's residual item count, with no app name.

An app is deterministic when `c2c analyze` finds zero residual TODO items and no
`c2c fill-todos` lock entries apply to it. Only deterministic apps count toward the
95% / 100% migration targets.

A residual TODO item is an untranslated Deluge hole or one generated UI stub
(a field, report, page, or ZML item). Each UI stub is included in the residual,
so an app with a stub is not deterministic.
0 of the 20 deterministic apps still have UI TODO stubs (0 in total).

The builtin catalogue lists 27 TODO entries
(`docs/deluge-builtins.json` `counts.todo`). That is not the corpus residual counted here: one
TODO item per untranslated construct occurrence.

| | |
|---|---:|
| corpus apps | 67 |
| deterministic apps | 20 (29.9%) |
| residual TODO items | 440 |
| distinct TODO kinds | 22 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 20 TODO kinds

| construct | count |
|---|---:|
| `client-shim-unsupported` | 131 |
| `client-condition-uses-server` | 122 |
| `Server-side Deluge snippet requires manual translation` | 99 |
| `Static <style> CSS not carried over:(app identifier)` | 44 |
| `Embedded zc-component report (app identifier) has no generated view` | 13 |
| `pushnotification` | 6 |
| `Embedded zc-component form (app identifier) has no generated view` | 4 |
| `client-loop-uses-server` | 3 |
| `Rebuild the pivot table manually:(app identifier)` | 2 |
| `report-conditional-format` | 2 |
| `ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.workoutDone is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)` | 2 |
| `ZML <image> (app identifier) click action Form is not generated; wire the click to the function by hand` | 2 |
| `Filter not migrated:(app identifier)` | 1 |
| `report-criteria` | 1 |
| `sendmail-attachment:view` | 1 |
| `The <script> element is removed from this page snippet by the sanitizer` | 1 |
| `The <style> element is removed from this page snippet by the sanitizer` | 1 |
| `ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.checkIn is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)` | 1 |
| `ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.checkOut is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)` | 1 |
| `ZML <image> (app identifier) click action Function calling function Vote.downvote is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)` | 1 |

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 6 |
| `client-condition-uses-server` | 3 |
| `pushnotification` | 2 |

## Machine-readable

```json
{
  "deterministicApps": 20,
  "deterministicWithUiTodos": {
    "apps": 0,
    "uiTodos": 0
  },
  "kinds": [
    {
      "construct": "client-shim-unsupported",
      "count": 131
    },
    {
      "construct": "client-condition-uses-server",
      "count": 122
    },
    {
      "construct": "Server-side Deluge snippet requires manual translation",
      "count": 99
    },
    {
      "construct": "Static <style> CSS not carried over:(app identifier)",
      "count": 44
    },
    {
      "construct": "Embedded zc-component report (app identifier) has no generated view",
      "count": 13
    },
    {
      "construct": "pushnotification",
      "count": 6
    },
    {
      "construct": "Embedded zc-component form (app identifier) has no generated view",
      "count": 4
    },
    {
      "construct": "client-loop-uses-server",
      "count": 3
    },
    {
      "construct": "Rebuild the pivot table manually:(app identifier)",
      "count": 2
    },
    {
      "construct": "report-conditional-format",
      "count": 2
    },
    {
      "construct": "ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.workoutDone is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)",
      "count": 2
    },
    {
      "construct": "ZML <image> (app identifier) click action Form is not generated; wire the click to the function by hand",
      "count": 2
    },
    {
      "construct": "Filter not migrated:(app identifier)",
      "count": 1
    },
    {
      "construct": "report-criteria",
      "count": 1
    },
    {
      "construct": "sendmail-attachment:view",
      "count": 1
    },
    {
      "construct": "The <script> element is removed from this page snippet by the sanitizer",
      "count": 1
    },
    {
      "construct": "The <style> element is removed from this page snippet by the sanitizer",
      "count": 1
    },
    {
      "construct": "ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.checkIn is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)",
      "count": 1
    },
    {
      "construct": "ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.checkOut is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)",
      "count": 1
    },
    {
      "construct": "ZML <image> (app identifier) click action Function calling function Vote.downvote is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)",
      "count": 1
    },
    {
      "construct": "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)",
      "count": 1
    },
    {
      "construct": "ZML <image> (app identifier) click action OpenReport is not generated; wire the click to the function by hand",
      "count": 1
    }
  ],
  "perAppConstructSets": [
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
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server"
      ],
      "items": 11
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 29
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 12
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Filter not migrated:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 8
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "pushnotification",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 15
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Rebuild the pivot table manually:(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 12
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 40
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 8
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 14
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 22
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "ZML <image> (app identifier) click action Form is not generated; wire the click to the function by hand",
        "ZML <image> (app identifier) click action OpenReport is not generated; wire the click to the function by hand"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Embedded zc-component form (app identifier) has no generated view",
        "Embedded zc-component report (app identifier) has no generated view",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 15
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Embedded zc-component form (app identifier) has no generated view",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Embedded zc-component report (app identifier) has no generated view"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Embedded zc-component report (app identifier) has no generated view",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 12
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "pushnotification"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
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
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 21
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "pushnotification"
      ],
      "items": 2
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 8
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 26
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 70
    },
    {
      "constructs": [
        "Embedded zc-component form (app identifier) has no generated view",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Embedded zc-component report (app identifier) has no generated view",
        "Static <style> CSS not carried over:(app identifier)",
        "The <script> element is removed from this page snippet by the sanitizer"
      ],
      "items": 5
    },
    {
      "constructs": [
        "pushnotification"
      ],
      "items": 1
    },
    {
      "constructs": [
        "pushnotification"
      ],
      "items": 1
    },
    {
      "constructs": [
        "Rebuild the pivot table manually:(app identifier)",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 14
    },
    {
      "constructs": [
        "report-conditional-format",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
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
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 7
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "The <style> element is removed from this page snippet by the sanitizer"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "ZML <image> (app identifier) click action Function calling function Vote.downvote is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)",
        "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)"
      ],
      "items": 3
    },
    {
      "constructs": [
        "ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.checkIn is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)",
        "ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.checkOut is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)",
        "ZML <button> (app identifier) click action ExecuteFunction calling function button_functions.workoutDone is not generated; wire the click to the function by hand (the snippet stays manual:(app identifier)"
      ],
      "items": 4
    }
  ],
  "todoTotal": 440,
  "totalApps": 67
}
```
