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
