# Migration report for Archive_Intake_Gaps

This report explains what will move to Catalyst, what needs a person, and what to check before go-live. Data centre: in.

## What will be converted

- Forms: 1 — Artifact_Intake
- Reports: 0
- Pages: 0
- Workflows: 1 — Artifact_Intake_Validate
- Schedules: 0
- Functions: 0
- Roles: 0

## Guided steps for a person

1. **Accept the admin invite** — Open the app invite email sent to the admin address and set the password.
2. **Sign in once** — Open the deployed app URL and sign in once so the first login completes activation.

## App-specific manual work

- none

## Unsupported or needs review

This list covers everything the converter can see in the export. A check inside the running app may surface more; open each converted screen once before sign-off.

- Artifact_Intake.Detected_Objects — Objects in uploaded images are no longer labelled automatically.
  - What to do: Keep the AI-filled value out of the automatic form, or add a reviewed post-submit enrichment step before go-live.
- Artifact_Intake.External_Record — The link to the other product is stored as text or an external reference until a connection is authorized.
  - What to do: Ask the person who owns the external account to authorize the matching connection during migration; otherwise keep the value as text and complete the lookup after launch.
- Artifact_Intake.Extracted_Terms — Keywords are no longer extracted automatically when a record is submitted.
  - What to do: Keep the AI-filled value out of the automatic form, or add a reviewed post-submit enrichment step before go-live.
- Artifact_Intake.Forecast — The AI-predicted value is not filled automatically in the generated app.
  - What to do: Keep the AI-filled value out of the automatic form, or add a reviewed post-submit enrichment step before go-live.
- Artifact_Intake.Old_Crm_Record — The link to the old customer-record system is kept as a reference number.
  - What to do: Ask the person who owns the external account to authorize the matching connection during migration; otherwise keep the value as text and complete the lookup after launch.
- Artifact_Intake.Old_Crm_Reference — The link to the old customer-record system is kept as its display text.
  - What to do: Ask the person who owns the external account to authorize the matching connection during migration; otherwise keep the value as text and complete the lookup after launch.
- Artifact_Intake.Shelf_Code — The code value is stored as text; the code image is not rendered in the generated app.
  - What to do: Enter or paste the code value into the generated text field, or add a reviewed scanning flow if the device workflow is required.
- Artifact_Intake.Site_Location — There is no separate map-location field; coordinates travel inside the address field instead.
  - What to do: Capture the needed address or location in the supported address fields instead of a separate location field.
- Artifact_Intake.Text_From_Image — Text is no longer read out of uploaded images automatically.
  - What to do: Keep the AI-filled value out of the automatic form, or add a reviewed post-submit enrichment step before go-live.
- Artifact_Intake.Tone_Result — Sentiment is no longer scored automatically when a record is submitted.
  - What to do: Keep the AI-filled value out of the automatic form, or add a reviewed post-submit enrichment step before go-live.

## Data migration

The following source data is planned for migration:

- Artifact_Intake (table, 14 columns)

How to verify it:

- Run the guided data load, then compare each migrated table count with the source export count.
- When automated record verification is available, run it to compare row counts and checksums and keep the result with the migration files.
- Check one parent row and its related child or lookup rows before sign-off.

## Go-live checklist

- [ ] Complete guided step: Accept the admin invite.
- [ ] Complete guided step: Sign in once.
- [ ] Load the source data and confirm every table count matches the source count.
- [ ] Run record verification when it is available, then keep the counts/checksum report with the migration files.
- [ ] Sign in as one user in each role and open the pages and reports that role should see.
- [ ] Submit one test record through each converted form and confirm it appears in the expected report.
- [ ] Promote the reviewed project to Production, switch business links, and keep Creator read-only until final sign-off.
