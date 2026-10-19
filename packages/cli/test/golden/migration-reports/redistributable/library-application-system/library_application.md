# Migration report: redistributable/library-application-system/library_application

App: Library_System_Application

## Scope

- Payments — not supported in this version (counted)
- Offline — not supported in this version (counted)
- Form Email — not supported in this version (counted)
- C8 dialect — not supported in this version (counted)
- Cliq bots — not supported in this version (counted)
- Native mobile / MDM — not supported in this version (counted; on the roadmap)
- Marketplace publishing — not applicable (out of scope)
- Zia AI builder — not applicable (out of scope)
- On-prem Data Bridge — not applicable (out of scope)

## Converted inventory

- 4 forms
- 5 reports
- 1 page
- 7 functions

## TODO counts

0

- none

## Field gaps

- auto-number: 4 (Book.Book_ID, Member_Info.Auto_Number, Book_Transaction.Trans, Staff_Members.Staff_ID) — ROWID is not a substitute: it has no prefix, start, or reset. A bigint column plus a generated counter (start index from the .ds) is the plan. Concurrent inserts can collide until an atomic increment is proven, so this stays partial.
- checkbox-multi: 1 (Book.Mark_as_Featured) — The .ds token checkboxes is a list, not a boolean. Stored as text holding a JSON list. values = Form.Field is a multi lookup (junction table).
- currency: 1 (Book_Transaction.Fine_Amount) — Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
- decimal: 1 (Member_Info.Max_Books_Allowed) — Decimal is not a Data Store column type (Text, VarChar, Date, DateTime, Int, Double, Boolean, BigInt, Foreign Key, Encrypted). Stored as a canonical decimal string in varchar 64. Scale is the field decimal places (default 2). Extra fractional digits quantize half-away-from-zero. ZCQL orders the varchar as text.
- email: 2 (Member_Info.Email, Staff_Members.Staff_Email) — There is no email column (API type email returns PATTERN_NOT_MATCHED). Stored as varchar plus a generated format check. Creator’s exact rule is unpublished, so the check can differ on edge cases.
- lookup-single: 2 (Book_Transaction.Member, Book_Transaction.Book) — Foreign key is creatable by API: data_type "foreign key" and on_delete "ON-DELETE-SET-NULL" (optional) or "ON-DELETE-CASCADE" (mandatory). ZCQL INNER/LEFT joins need this FK. The parent column is ROWID. A missing target form becomes a bigint id column and the report says "FK needs console". Picklist, radio, and list fields with values = Form.Field use this row (list uses the multi row).
- phone: 2 (Member_Info.Phone_Number, Staff_Members.Phone_Number) — There is no phone column. Stored as varchar. Country digit rules are a generated table and can drift from Creator.

## Manual steps

- none

## Residual TODO steps

- none

## Hidden from end users

8

- report Book_by_Genre: the kanban view is not drawn
- page DashBoard: <search>: ZML <search> has no generated component
- page DashBoard: <searchbar>: ZML <searchbar> has no generated component
- page DashBoard: <searchbutton>: ZML <searchbutton> has no generated component
- page DashBoard: <button>: the VIEW button opens without its values (View all Books)
- page DashBoard: <text>: the value distinctcount is not generated yet
- page DashBoard: <button>: the View button opens without its values (Overdue transactions)
- page DashBoard: <button>: the Staff Activity Log button opens without its values (Staff Activity Log)

## Human steps

- Accept invite: accept the app invite mail
- Sign in once: sign in to the deployed app once
- Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)
- Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)

## Not converted

Silent drops: 19 (still counted; each has a guided step below)

- `field-property:Book.Genre property others option` — not converted. property others option is not carried by the generated dropdown field. Varchar plus the .ds choice list. The server rejects values outside the list. A choice longer than 255 is promoted to text. A values = Form.Field target is a lookup, not a dropdown. module = users is the Users field.
  - Step: The property others option setting for Book.Genre was not converted. In the Catalyst console, configure that setting for Book.Genre, then preview the form or report and confirm the field behaves as expected.
- `field-property:Book_Transaction.Member property displayformat` — not converted. property displayformat is not carried by the generated lookup-single field. Foreign key is creatable by API: data_type "foreign key" and on_delete "ON-DELETE-SET-NULL" (optional) or "ON-DELETE-CASCADE" (mandatory). ZCQL INNER/LEFT joins need this FK. The parent column is ROWID. A missing target form becomes a bigint id column and the report says "FK needs console". Picklist, radio, and list fields with values = Form.Field use this row (list uses the multi row).
  - Step: The lookup display format for Book_Transaction.Member was not converted. In the Catalyst console, set the lookup's display field or display format for Book_Transaction.Member, then preview the form and confirm the lookup shows the intended value.
- `field-property:Book_Transaction.Member property sortorder` — not converted. property sortorder is not carried by the generated lookup-single field. Foreign key is creatable by API: data_type "foreign key" and on_delete "ON-DELETE-SET-NULL" (optional) or "ON-DELETE-CASCADE" (mandatory). ZCQL INNER/LEFT joins need this FK. The parent column is ROWID. A missing target form becomes a bigint id column and the report says "FK needs console". Picklist, radio, and list fields with values = Form.Field use this row (list uses the multi row).
  - Step: The sort order for Book_Transaction.Member was not converted. In the Catalyst console, set the field's sort order for Book_Transaction.Member, then preview the form or report and confirm values appear in that order.
- `field-property:Book_Transaction.Book property displayformat` — not converted. property displayformat is not carried by the generated lookup-single field. Foreign key is creatable by API: data_type "foreign key" and on_delete "ON-DELETE-SET-NULL" (optional) or "ON-DELETE-CASCADE" (mandatory). ZCQL INNER/LEFT joins need this FK. The parent column is ROWID. A missing target form becomes a bigint id column and the report says "FK needs console". Picklist, radio, and list fields with values = Form.Field use this row (list uses the multi row).
  - Step: The lookup display format for Book_Transaction.Book was not converted. In the Catalyst console, set the lookup's display field or display format for Book_Transaction.Book, then preview the form and confirm the lookup shows the intended value.
- `field-property:Book_Transaction.Book property sortorder` — not converted. property sortorder is not carried by the generated lookup-single field. Foreign key is creatable by API: data_type "foreign key" and on_delete "ON-DELETE-SET-NULL" (optional) or "ON-DELETE-CASCADE" (mandatory). ZCQL INNER/LEFT joins need this FK. The parent column is ROWID. A missing target form becomes a bigint id column and the report says "FK needs console". Picklist, radio, and list fields with values = Form.Field use this row (list uses the multi row).
  - Step: The sort order for Book_Transaction.Book was not converted. In the Catalyst console, set the field's sort order for Book_Transaction.Book, then preview the form or report and confirm values appear in that order.
- `field-property:Staff_Members.Staff_Name property personal data` — not converted. property personal data is not carried by the generated name field. One varchar per part (prefix, first_name, last_name, suffix). Deluge sees one value; a shim joins the parts. Parts are not separate field-type rows.
  - Step: The personal-data setting for Staff_Members.Staff_Name was not converted. In the Catalyst console, mark Staff_Members.Staff_Name as personal or sensitive data if required by your policy, then inspect the field settings and verify the protection is enabled.
- `field-property:Staff_Members.Staff_Email property personal data` — not converted. property personal data is not carried by the generated email field. There is no email column (API type email returns PATTERN_NOT_MATCHED). Stored as varchar plus a generated format check. Creator’s exact rule is unpublished, so the check can differ on edge cases.
  - Step: The personal-data setting for Staff_Members.Staff_Email was not converted. In the Catalyst console, mark Staff_Members.Staff_Email as personal or sensitive data if required by your policy, then inspect the field settings and verify the protection is enabled.
- `field-property:Staff_Members.Phone_Number property defaultcountry` — not converted. property defaultcountry is not carried by the generated phone field. There is no phone column. Stored as varchar. Country digit rules are a generated table and can drift from Creator.
  - Step: The property defaultcountry setting for Staff_Members.Phone_Number was not converted. In the Catalyst console, configure that setting for Staff_Members.Phone_Number, then preview the form or report and confirm the field behaves as expected.
- `field-property:Staff_Members.Phone_Number property personal data` — not converted. property personal data is not carried by the generated phone field. There is no phone column. Stored as varchar. Country digit rules are a generated table and can drift from Creator.
  - Step: The personal-data setting for Staff_Members.Phone_Number was not converted. In the Catalyst console, mark Staff_Members.Phone_Number as personal or sensitive data if required by your policy, then inspect the field settings and verify the protection is enabled.
- `report-feature:Book_Report block options` — not converted. Report Book_Report block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Book_Report report were not converted. In the Catalyst console, open the Book_Report report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Book_by_Genre block options` — not converted. Report Book_by_Genre block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Book_by_Genre report were not converted. In the Catalyst console, open the Book_by_Genre report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:All_Member_Infos block options` — not converted. Report All_Member_Infos block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the All_Member_Infos report were not converted. In the Catalyst console, open the All_Member_Infos report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:All_Book_Transactions block options` — not converted. Report All_Book_Transactions block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the All_Book_Transactions report were not converted. In the Catalyst console, open the All_Book_Transactions report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:All_Staff_Members block options` — not converted. Report All_Staff_Members block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the All_Staff_Members report were not converted. In the Catalyst console, open the All_Staff_Members report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `page-element:DashBoard.Book_Report #1` — not converted. ZML element <search> Book_Report on page DashBoard is generated without its criteria. Add one: either emit the element or record the manual step.
  - Step: The DashBoard.Book_Report page element was not converted. In the Catalyst console, open the page and add or configure this element, then preview the page and verify it behaves as expected.
- `page-element:DashBoard.Book_Report #2` — not converted. ZML element <button> Book_Report on page DashBoard is generated without its parameters. Add one: either emit the element or record the manual step.
  - Step: The DashBoard.Book_Report page element was not converted. In the Catalyst console, open the page and add or configure this element, then preview the page and verify it behaves as expected.
- `page-element:DashBoard.All_Book_Transactions #1` — not converted. ZML element <text> All_Book_Transactions on page DashBoard is generated without its parameters. Add one: either emit the element or record the manual step.
  - Step: The DashBoard.All_Book_Transactions page element was not converted. In the Catalyst console, open the page and add or configure this element, then preview the page and verify it behaves as expected.
- `page-element:DashBoard.All_Book_Transactions #2` — not converted. ZML element <button> All_Book_Transactions on page DashBoard is generated without its parameters. Add one: either emit the element or record the manual step.
  - Step: The DashBoard.All_Book_Transactions page element was not converted. In the Catalyst console, open the page and add or configure this element, then preview the page and verify it behaves as expected.
- `translation:translation Language_Settings` — not converted. The Language_Settings translation block is not migrated and has no manual step — only a migration-report warning, which is not a counted manual item. List the language, the string count, and what the user must copy into the generated client.
  - Step: The translation Language_Settings was not converted. In the Catalyst console, add the language and copy the source translation strings into the generated app, then preview the translated text and verify it is correct.
