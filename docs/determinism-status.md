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
0 of the 10 deterministic apps still have UI TODO stubs (0 in total).

The builtin catalogue lists 56 TODO entries
(`docs/deluge-builtins.json` `counts.todo`). That is not the corpus residual counted here: one
TODO item per untranslated construct occurrence.

| | |
|---|---:|
| corpus apps | 67 |
| deterministic apps | 10 (14.9%) |
| residual TODO items | 570 |
| distinct TODO kinds | 19 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 19 TODO kinds

| construct | count |
|---|---:|
| `client-condition-uses-server` | 321 |
| `Server-side Deluge snippet requires manual translation` | 111 |
| `client-loop-uses-server` | 86 |
| `criteria-dynamic` | 10 |
| `pushnotification` | 6 |
| `task:(app identifier)` | 5 |
| `Filter not migrated:(app identifier)` | 4 |
| `Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)` | 4 |
| `method:(app identifier)` | 4 |
| `report-criteria` | 4 |
| `method:count` | 3 |
| `alert-in-unverified-event` | 2 |
| `call:(app identifier)` | 2 |
| `Rebuild the pivot table manually:(app identifier)` | 2 |
| `report-conditional-format` | 2 |
| `method:toLong` | 1 |
| `sendmail-attachment:view` | 1 |
| `task:sort` | 1 |
| `ZML <embed> has no generated component` | 1 |

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 10 |
| `client-condition-uses-server` | 9 |
| `Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)` | 1 |

## Machine-readable

```json
{
  "deterministicApps": 10,
  "deterministicWithUiTodos": {
    "apps": 0,
    "uiTodos": 0
  },
  "kinds": [
    {
      "construct": "client-condition-uses-server",
      "count": 321
    },
    {
      "construct": "Server-side Deluge snippet requires manual translation",
      "count": 111
    },
    {
      "construct": "client-loop-uses-server",
      "count": 86
    },
    {
      "construct": "criteria-dynamic",
      "count": 10
    },
    {
      "construct": "pushnotification",
      "count": 6
    },
    {
      "construct": "task:(app identifier)",
      "count": 5
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
      "construct": "method:count",
      "count": 3
    },
    {
      "construct": "alert-in-unverified-event",
      "count": 2
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
    },
    {
      "construct": "ZML <embed> has no generated component",
      "count": 1
    }
  ],
  "perAppConstructSets": [
    {
      "constructs": [
        "alert-in-unverified-event",
        "client-condition-uses-server",
        "client-loop-uses-server",
        "method:count",
        "Server-side Deluge snippet requires manual translation",
        "task:sort"
      ],
      "items": 28
    },
    {
      "constructs": [
        "alert-in-unverified-event",
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "call:(app identifier)",
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 11
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
      "items": 2
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
      "items": 11
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "criteria-dynamic",
        "Server-side Deluge snippet requires manual translation",
        "task:(app identifier)"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 34
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 184
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "criteria-dynamic"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "criteria-dynamic",
        "Filter not migrated:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 24
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "pushnotification"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "pushnotification",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 14
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "pushnotification",
        "task:(app identifier)"
      ],
      "items": 3
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "pushnotification",
        "task:(app identifier)"
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
        "Rebuild the pivot table manually:(app identifier)",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 11
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 32
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
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 6
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
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 13
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 18
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 24
    },
    {
      "constructs": [
        "criteria-dynamic",
        "Filter not migrated:(app identifier)",
        "report-criteria"
      ],
      "items": 3
    },
    {
      "constructs": [
        "criteria-dynamic",
        "method:toLong",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 6
    },
    {
      "constructs": [
        "criteria-dynamic",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Filter not migrated:(app identifier)",
        "method:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "Filter not migrated:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Inline style declarations not carried over (unsafe or unsupported CSS):(app identifier)"
      ],
      "items": 1
    },
    {
      "constructs": [
        "pushnotification",
        "task:(app identifier)"
      ],
      "items": 2
    },
    {
      "constructs": [
        "report-conditional-format",
        "Server-side Deluge snippet requires manual translation",
        "task:(app identifier)"
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
      "items": 3
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "ZML <embed> has no generated component"
      ],
      "items": 5
    }
  ],
  "todoTotal": 570,
  "totalApps": 67
}
```
