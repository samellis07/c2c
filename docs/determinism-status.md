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
0 of the 0 deterministic apps still have UI TODO stubs (0 in total).

The builtin catalogue lists 27 TODO entries
(`docs/deluge-builtins.json` `counts.todo`). That is not the corpus residual counted here: one
TODO item per untranslated construct occurrence.

| | |
|---|---:|
| corpus apps | 67 |
| apps with no residual todos | 23/67 |
| apps with no residual todos and no silent drops (deterministic) | 0/67 (0%) |
| silent drops (total) | 4015 |
| residual TODO items | 234 |
| distinct TODO kinds | 19 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 19 TODO kinds

| construct | count |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 96 |
| `client-condition-uses-server` | 63 |
| `Static <style> CSS not carried over:(app identifier)` | 28 |
| `Custom action (app identifier) is not migrated; its button is turned off.` | 18 |
| `form-event-server-uninvoked` | 6 |
| `pushnotification` | 6 |
| `client-loop-uses-server` | 3 |
| `Rebuild the pivot table manually:(app identifier)` | 2 |
| `report-conditional-format` | 2 |
| `Embedded zc-component form (app identifier) has no generated view` | 1 |
| `Embedded zc-component report (app identifier) has no generated view` | 1 |
| `Filter not migrated on report Holidays_Employee:(app identifier)` | 1 |
| `report-criteria` | 1 |
| `sendmail-attachment:view` | 1 |
| `The <script> element is removed from this page snippet by the sanitizer` | 1 |
| `The <style> element is removed from this page snippet by the sanitizer` | 1 |
| `ZML <image> (app identifier) click action Function calling function Vote.downvote is not generated; wire the click to the function by hand` | 1 |
| `ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand` | 1 |
| `ZML <image> (app identifier) click action OpenReport is not generated; wire the click to the function by hand` | 1 |

## Top 5 silent-drop kinds

| construct | count |
|---|---:|
| `field-property` | 2864 |
| `report-feature` | 744 |
| `function` | 191 |
| `page-element` | 149 |
| `translation` | 67 |

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 9 |
| `client-condition-uses-server` | 3 |
| `pushnotification` | 3 |
| `Custom action (app identifier) is not migrated; its button is turned off.` | 1 |

## Machine-readable

```json
{
  "deterministicApps": 0,
  "deterministicWithUiTodos": {
    "apps": 0,
    "uiTodos": 0
  },
  "kinds": [
    {
      "construct": "Server-side Deluge snippet requires manual translation",
      "count": 96
    },
    {
      "construct": "client-condition-uses-server",
      "count": 63
    },
    {
      "construct": "Static <style> CSS not carried over:(app identifier)",
      "count": 28
    },
    {
      "construct": "Custom action (app identifier) is not migrated; its button is turned off.",
      "count": 18
    },
    {
      "construct": "form-event-server-uninvoked",
      "count": 6
    },
    {
      "construct": "pushnotification",
      "count": 6
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
      "construct": "Embedded zc-component form (app identifier) has no generated view",
      "count": 1
    },
    {
      "construct": "Embedded zc-component report (app identifier) has no generated view",
      "count": 1
    },
    {
      "construct": "Filter not migrated on report Holidays_Employee:(app identifier)",
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
      "construct": "ZML <image> (app identifier) click action Function calling function Vote.downvote is not generated; wire the click to the function by hand",
      "count": 1
    },
    {
      "construct": "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand",
      "count": 1
    },
    {
      "construct": "ZML <image> (app identifier) click action OpenReport is not generated; wire the click to the function by hand",
      "count": 1
    }
  ],
  "noTodoApps": 23,
  "perAppConstructSets": [
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [],
      "items": 0
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
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server"
      ],
      "items": 8
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 12
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 14
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "ZML <image> (app identifier) click action OpenReport is not generated; wire the click to the function by hand"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Embedded zc-component form (app identifier) has no generated view"
      ],
      "items": 8
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
        "Rebuild the pivot table manually:(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
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
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 12
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
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 10
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
        "Custom action (app identifier) is not migrated; its button is turned off."
      ],
      "items": 3
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 9
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 9
    },
    {
      "constructs": [
        "Embedded zc-component report (app identifier) has no generated view",
        "Static <style> CSS not carried over:(app identifier)",
        "The <script> element is removed from this page snippet by the sanitizer"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Filter not migrated on report Holidays_Employee:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "form-event-server-uninvoked",
        "pushnotification",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 9
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
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 11
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
        "ZML <image> (app identifier) click action Function calling function Vote.downvote is not generated; wire the click to the function by hand",
        "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand"
      ],
      "items": 2
    }
  ],
  "silentDropKinds": [
    {
      "construct": "field-property",
      "count": 2864
    },
    {
      "construct": "report-feature",
      "count": 744
    },
    {
      "construct": "function",
      "count": 191
    },
    {
      "construct": "page-element",
      "count": 149
    },
    {
      "construct": "translation",
      "count": 67
    }
  ],
  "silentDropTotal": 4015,
  "todoTotal": 234,
  "totalApps": 67
}
```
