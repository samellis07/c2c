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
| apps with no residual todos | 7/67 |
| apps with no residual todos and no silent drops (deterministic) | 0/67 (0%) |
| silent drops (total) | 695 |
| residual TODO items | 504 |
| distinct TODO kinds | 56 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 20 TODO kinds

| construct | count |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 96 |
| `Custom action (app identifier) is not migrated; its button is turned off.` | 89 |
| `openurl-unsupported-target` | 71 |
| `client-condition-uses-server` | 63 |
| `Toolbar setting is not carried; the generated editor has no toolbar control.` | 36 |
| `Static <style> CSS not carried over:(app identifier)` | 27 |
| `translation-block` | 26 |
| `Default row count is not carried; the generated subform starts with no pre-filled rows.` | 14 |
| `Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.` | 7 |
| `pushnotification` | 6 |
| `Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.` | 5 |
| `Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.` | 4 |
| `function-untranslated` | 4 |
| `client-loop-uses-server` | 3 |
| `Field Access_Hubs is flagged `private = true`; Catalyst generates no privacy or access control for this field.` | 3 |
| `Field Mail_ID is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.` | 3 |
| `Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.` | 2 |
| `Field Academic_Year is flagged `private = true`; Catalyst generates no privacy or access control for this field.` | 2 |
| `Field Access_Hub is flagged `private = true`; Catalyst generates no privacy or access control for this field.` | 2 |
| `Field Approver is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.` | 2 |

## Top 4 silent-drop kinds

| construct | count |
|---|---:|
| `field-property` | 441 |
| `page-element` | 149 |
| `report-feature` | 64 |
| `translation` | 41 |

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `translation-block` | 2 |
| `Default row count is not carried; the generated subform starts with no pre-filled rows.` | 1 |
| `Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.` | 1 |
| `Field Verified_User is flagged `private = true`; Catalyst generates no privacy or access control for this field.` | 1 |
| `Toolbar setting is not carried; the generated editor has no toolbar control.` | 1 |

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
      "construct": "Custom action (app identifier) is not migrated; its button is turned off.",
      "count": 89
    },
    {
      "construct": "openurl-unsupported-target",
      "count": 71
    },
    {
      "construct": "client-condition-uses-server",
      "count": 63
    },
    {
      "construct": "Toolbar setting is not carried; the generated editor has no toolbar control.",
      "count": 36
    },
    {
      "construct": "Static <style> CSS not carried over:(app identifier)",
      "count": 27
    },
    {
      "construct": "translation-block",
      "count": 26
    },
    {
      "construct": "Default row count is not carried; the generated subform starts with no pre-filled rows.",
      "count": 14
    },
    {
      "construct": "Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 7
    },
    {
      "construct": "pushnotification",
      "count": 6
    },
    {
      "construct": "Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 5
    },
    {
      "construct": "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 4
    },
    {
      "construct": "function-untranslated",
      "count": 4
    },
    {
      "construct": "client-loop-uses-server",
      "count": 3
    },
    {
      "construct": "Field Access_Hubs is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 3
    },
    {
      "construct": "Field Mail_ID is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 3
    },
    {
      "construct": "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.",
      "count": 2
    },
    {
      "construct": "Field Academic_Year is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 2
    },
    {
      "construct": "Field Access_Hub is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 2
    },
    {
      "construct": "Field Approver is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 2
    },
    {
      "construct": "Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 2
    },
    {
      "construct": "Field Phone is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
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
      "construct": "Field Address is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Admin_Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Assignees_Admin is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Associated_Contacts is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Associated_Emails is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Company_Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Days is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Employee_Emails is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Event is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Feed_back is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Hours is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Mail_Id is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Main_Contact_Person is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Minutes is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Mobile_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field msg is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field No_Of_Times__Visits is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Phone_Number1 is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Purchased_amount_till_now is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Resolved_at is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Resolved_By is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Seconds is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Signature is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Student_Absent_List is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Text_for_Attendance is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Verified_User is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
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
      "construct": "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand",
      "count": 1
    }
  ],
  "noTodoApps": 7,
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
      "constructs": [
        "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation-block"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Academic_Year is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Student_Absent_List is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Text_for_Attendance is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 20
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Phone_Number1 is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Embedded zc-component form (app identifier) has no generated view",
        "Field No_Of_Times__Visits is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "translation-block"
      ],
      "items": 14
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Associated_Contacts is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Associated_Emails is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Days is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Hours is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Minutes is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field msg is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Resolved_at is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Resolved_By is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Seconds is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 32
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 20
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 24
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 9
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 17
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation-block"
      ],
      "items": 5
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "translation-block"
      ],
      "items": 9
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field Access_Hub is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Access_Hubs is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Employee_Emails is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 16
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field Assignees_Admin is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 14
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
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "translation-block"
      ],
      "items": 9
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Address is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Approver is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Company_Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Mail_Id is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Mail_ID is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Main_Contact_Person is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Mobile_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 22
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Event is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Feed_back is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation-block"
      ],
      "items": 9
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 63
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "translation-block"
      ],
      "items": 19
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Signature is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target"
      ],
      "items": 14
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "pushnotification",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 6
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 5
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 6
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 11
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "translation-block"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "translation-block"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "translation-block"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Default row count is not carried; the generated subform starts with no pre-filled rows."
      ],
      "items": 1
    },
    {
      "constructs": [
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Purchased_amount_till_now is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Embedded zc-component report (app identifier) has no generated view",
        "openurl-unsupported-target",
        "Static <style> CSS not carried over:(app identifier)",
        "The <script> element is removed from this page snippet by the sanitizer",
        "translation-block"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Field Admin_Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Mail_ID is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Phone is flagged `personal data = true`; Catalyst generates no privacy or access control for this field."
      ],
      "items": 6
    },
    {
      "constructs": [
        "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field."
      ],
      "items": 1
    },
    {
      "constructs": [
        "Field Verified_User is flagged `private = true`; Catalyst generates no privacy or access control for this field."
      ],
      "items": 1
    },
    {
      "constructs": [
        "Filter not migrated on report Holidays_Employee:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 6
    },
    {
      "constructs": [
        "function-untranslated",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "function-untranslated",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "translation-block"
      ],
      "items": 7
    },
    {
      "constructs": [
        "function-untranslated",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 3
    },
    {
      "constructs": [
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 4
    },
    {
      "constructs": [
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 16
    },
    {
      "constructs": [
        "pushnotification",
        "translation-block"
      ],
      "items": 2
    },
    {
      "constructs": [
        "pushnotification",
        "translation-block"
      ],
      "items": 2
    },
    {
      "constructs": [
        "pushnotification",
        "translation-block"
      ],
      "items": 2
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
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 3
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 1
    },
    {
      "constructs": [
        "translation-block"
      ],
      "items": 1
    },
    {
      "constructs": [
        "translation-block"
      ],
      "items": 1
    },
    {
      "constructs": [
        "translation-block",
        "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand"
      ],
      "items": 2
    }
  ],
  "silentDropKinds": [
    {
      "construct": "field-property",
      "count": 441
    },
    {
      "construct": "page-element",
      "count": 149
    },
    {
      "construct": "report-feature",
      "count": 64
    },
    {
      "construct": "translation",
      "count": 41
    }
  ],
  "silentDropTotal": 695,
  "todoTotal": 504,
  "totalApps": 67
}
```
