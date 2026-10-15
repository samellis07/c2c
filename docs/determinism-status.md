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
0 of the 7 deterministic apps still have UI TODO stubs (0 in total).

The builtin catalogue lists 27 TODO entries
(`docs/deluge-builtins.json` `counts.todo`). That is not the corpus residual counted here: one
TODO item per untranslated construct occurrence.

| | |
|---|---:|
| corpus apps | 67 |
| deterministic apps | 7 (10.4%) |
| residual TODO items | 634 |
| distinct TODO kinds | 18 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 18 TODO kinds

| construct | count |
|---|---:|
| `client-condition-uses-server` | 268 |
| `client-shim-unsupported` | 127 |
| `Server-side Deluge snippet requires manual translation` | 108 |
| `client-loop-uses-server` | 87 |
| `criteria-dynamic` | 8 |
| `pushnotification` | 6 |
| `Filter not migrated:(app identifier)` | 4 |
| `Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)` | 4 |
| `method:(app identifier)` | 4 |
| `report-criteria` | 4 |
| `task:(app identifier)` | 3 |
| `call:(app identifier)` | 2 |
| `Rebuild the pivot table manually:(app identifier)` | 2 |
| `report-conditional-format` | 2 |
| `Server-side Deluge snippet with an ExecuteFunction button requires manual translation of the button's function call` | 2 |
| `method:toLong` | 1 |
| `sendmail-attachment:view` | 1 |
| `task:sort` | 1 |

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `client-shim-unsupported` | 6 |
| `Server-side Deluge snippet requires manual translation` | 1 |

## Machine-readable

```json
{
  "deterministicApps": 7,
  "deterministicWithUiTodos": {
    "apps": 0,
    "uiTodos": 0
  },
  "kinds": [
    {
      "construct": "client-condition-uses-server",
      "count": 268
    },
    {
      "construct": "client-shim-unsupported",
      "count": 127
    },
    {
      "construct": "Server-side Deluge snippet requires manual translation",
      "count": 108
    },
    {
      "construct": "client-loop-uses-server",
      "count": 87
    },
    {
      "construct": "criteria-dynamic",
      "count": 8
    },
    {
      "construct": "pushnotification",
      "count": 6
    },
    {
      "construct": "Filter not migrated:(app identifier)",
      "count": 4
    },
    {
      "construct": "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)",
      "count": 4
    },
    {
      "construct": "method:(app identifier)",
      "count": 4
    },
    {
      "construct": "report-criteria",
      "count": 4
    },
    {
      "construct": "task:(app identifier)",
      "count": 3
    },
    {
      "construct": "call:(app identifier)",
      "count": 2
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
      "construct": "Server-side Deluge snippet with an ExecuteFunction button requires manual translation of the button's function call",
      "count": 2
    },
    {
      "construct": "method:toLong",
      "count": 1
    },
    {
      "construct": "sendmail-attachment:view",
      "count": 1
    },
    {
      "construct": "task:sort",
      "count": 1
    }
  ],
  "perAppConstructSets": [
    {
      "constructs": [
        "call:(app identifier)",
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 12
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "client-shim-unsupported"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "client-shim-unsupported",
        "criteria-dynamic",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 17
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 183
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation",
        "task:sort"
      ],
      "items": 22
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported"
      ],
      "items": 2
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported"
      ],
      "items": 13
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "criteria-dynamic"
      ],
      "items": 8
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Filter not migrated:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 9
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 20
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 29
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "pushnotification"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "pushnotification",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 19
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "pushnotification",
        "task:(app identifier)"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Rebuild the pivot table manually:(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 13
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 46
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 6
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 6
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 8
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 22
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-shim-unsupported",
        "Server-side Deluge snippet with an ExecuteFunction button requires manual translation of the button's function call"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Rebuild the pivot table manually:(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 11
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
        "client-shim-unsupported"
      ],
      "items": 1
    },
    {
      "constructs": [
        "client-shim-unsupported"
      ],
      "items": 1
    },
    {
      "constructs": [
        "client-shim-unsupported"
      ],
      "items": 1
    },
    {
      "constructs": [
        "client-shim-unsupported"
      ],
      "items": 1
    },
    {
      "constructs": [
        "client-shim-unsupported"
      ],
      "items": 2
    },
    {
      "constructs": [
        "client-shim-unsupported"
      ],
      "items": 2
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "criteria-dynamic",
        "method:toLong",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "criteria-dynamic",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Filter not migrated:(app identifier)",
        "method:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 9
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Filter not migrated:(app identifier)",
        "report-criteria"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Filter not migrated:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "pushnotification",
        "task:(app identifier)"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "pushnotification",
        "task:(app identifier)"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
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
      "items": 4
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-shim-unsupported",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 9
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
      "items": 4
    }
  ],
  "todoTotal": 634,
  "totalApps": 67
}
```
