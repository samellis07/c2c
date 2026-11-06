# Migration report: redistributable/freight-forwarding/Creator_app_source_code

App: Freight Forwarding and Feeder Solution

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

- 20 forms
- 22 reports
- 4 functions
- The generated Catalyst app carries 26 Data Store tables, 1 Catalyst function, 0 scheduled jobs, 42 pages
- Deluge: 56 statements translated, 486 kept working through a compatibility shim, of 553

## TODO counts

25

- 11 client-condition-uses-server
- 5 Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
- 4 Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
- 2 Field Mobile is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
- 1 Field Assistant_Phone is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
- 1 Field Contact_Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
- 1 Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.

## Field gaps

- auto-number: 1 (New_Deal.Auto_Number) — ROWID is not a substitute: it has no prefix, start, or reset. A bigint column plus a generated counter (start index from the .ds) is the plan. Concurrent inserts can collide until an atomic increment is proven, so this stays partial.
- currency: 32 (New_Account.Annual_Revenue, New_Deal.Amount, New_Deal.Expected_Revenue, New_Lead.Annual_Revenue, New_Quotation.List_Price, New_Quotation.Amount, New_Quotation.Discount, New_Quotation.Tax, New_Quotation.Total, New_Quotation.Sub_Total, New_Quotation.Tax_Total, New_Quotation.Grand_Total, New_Delivery_Order.Sales_Commission, New_Delivery_Order.Excise_Duty, New_Delivery_Order.List_Price, New_Delivery_Order.Amount, New_Delivery_Order.Discount, New_Delivery_Order.Tax, New_Delivery_Order.Total, New_Delivery_Order.Sub_Total, New_Delivery_Order.Tax_Total, New_Delivery_Order.Grand_Total, New_Invoice.Excise_Duty, New_Invoice.Sales_Commission, New_Invoice.List_Price, New_Invoice.Amount, New_Invoice.Discount, New_Invoice.Tax, New_Invoice.Total, New_Invoice.Sub_Total, New_Invoice.Tax_Total, New_Invoice.Grand_Total) — Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
- decimal: 27 (New_Quotation.Width_of_Cargo_cm, New_Quotation.Chargeable_Weight_KG, New_Quotation.Length_of_Cargo_cm, New_Quotation.Volume_CBM, New_Quotation.Height_of_Cargo_cm, New_Quotation.Gross_Weight_KG, New_Quotation.Quantity, New_Delivery_Order.Length_of_Cargo_cm, New_Delivery_Order.Volume_CBM, New_Delivery_Order.Width_of_Cargo_cm, New_Delivery_Order.Height_of_Cargo_cm, New_Delivery_Order.Gross_Weight_KG, New_Delivery_Order.Chargeable_Weight_KG, New_Delivery_Order.Quantity, New_Invoice.Quantity, New_SOF.FWD, New_SOF.AFT, New_SOF.FWD2, New_SOF.AFT2, New_SOF.FO, New_SOF.DO, New_SOF.FW, New_SOF.FO2, New_SOF.DO2, New_SOF.FW2, New_Table_of_Container.G_Wt, New_Table_of_Container.NetWt) — Decimal is not a Data Store column type (Text, VarChar, Date, DateTime, Int, Double, Boolean, BigInt, Foreign Key, Encrypted). Stored as a canonical decimal string in varchar 64. Scale is the field decimal places (default 2). Extra fractional digits quantize half-away-from-zero. ZCQL orders the varchar as text.
- email: 5 (New_Account.Email, New_User.Email, New_Contact.Email, New_Vendor.Email, New_Lead.Email) — There is no email column (API type email returns PATTERN_NOT_MATCHED). Stored as varchar plus a generated format check. Creator’s exact rule is unpublished, so the check can differ on edge cases.
- image: 7 (New_Account.Image, New_Contact.Contact_Image, New_Vendor.Vendor_Image, New_Deal.Deal_Image, New_Deal.Photograph, New_Lead.Photograph, New_Product.Product_Image) — Stratus object key (same upload, download, and byte-migration path as file upload). Thumbnail, crop, and annotation are not generated.
- lookup-single: 57 (New_Account.Account_Owner, New_Account.Lead_ID, New_Contact.Contact_Owner, New_Contact.Vendor, New_Contact.Lead_ID, New_Contact.Account_Name, New_Vendor.Vendor_Owner, New_Deal.Deal_Owner, New_Deal.Gate_Way_Airport, New_Deal.Destination_Airport, New_Deal.Port_of_Loading, New_Deal.Account_Name, New_Deal.Port_of_Discharge, New_Deal.Lead_ID, New_Deal.Vessel_Name, New_Lead.Lead_Owner, New_Lead.Gate_Way_Airport, New_Lead.Destination_Airport, New_Lead.Port_of_Loading, New_Lead.Account_ID, New_Lead.Port_of_Discharge, New_Lead.Vessel_Name, New_Quotation.Quote_Owner, New_Quotation.Deal_Name, New_Quotation.Account_Name, New_Quotation.Contact_Name, New_Quotation.Port_of_Loading, New_Quotation.Port_of_Discharge, New_Quotation.Gate_Way_Airport, New_Quotation.Destination_Airport, New_Quotation.HS_Code, New_Quotation.Product_Name, New_Product.Product_Owner, New_Product.Vendor_Name, New_Delivery_Order.Delivery_Order_Owner, New_Delivery_Order.Deal_Name, New_Delivery_Order.Quote_Number, New_Delivery_Order.Contact_Name, New_Delivery_Order.Account_Name, New_Delivery_Order.Product_Name, New_Invoice.Invoice_Owner, New_Invoice.Delivery_Order, New_Invoice.Deal_Name, New_Invoice.Contact_Name, New_Invoice.Account_Name, New_Invoice.Product_Name, New_SOF.Vessel_Name, New_SOF.New_Port, New_SOF.Appointment, New_Table_of_Container.Container_No, New_Table_of_Container.Container_Seal_Number, New_Table_of_Container.Container_Type, New_Table_of_Container.Container_Size, New_Table_of_Container.Port_of_Loading, New_Table_of_Container.Port_of_Discharge, New_Table_of_Container.Gate_Way_Airport, New_Table_of_Container.Destination_Airport) — Foreign key is creatable by API: data_type "foreign key" and on_delete "ON-DELETE-SET-NULL" (optional) or "ON-DELETE-CASCADE" (mandatory). ZCQL INNER/LEFT joins need this FK. The parent column is ROWID. A missing target form becomes a bigint id column and the report says "FK needs console". Picklist, radio, and list fields with values = Form.Field use this row (list uses the multi row).
- multi-line: 12 (New_Account.Description, New_Contact.Description, New_Deal.General_Description, New_Deal.Description, New_Lead.General_Description, New_Lead.Description, New_Delivery_Order.Terms_and_Conditions2, New_Delivery_Order.Description, New_Invoice.Terms_and_Conditions2, New_Invoice.Description, New_SOF.Remarks1, New_SOF.Master_Remarks1) — Data Store text holds 10,000 characters. A generated length check rejects the rest. Multi-line formula output (up to 65,355) does not fit.
- multi-select: 4 (Map_Dependency_Mode.Sub_Mode_of_Shipment, Map_Submode.Cargo_Type, Map_Submode.Shipment_Terms, Map_Submode.Container_Movement_Type) — No array column. Stored as text holding a JSON list. Criteria do not match list semantics. values = Form.Field on this type is a multi lookup (junction table), not this column.
- phone: 7 (New_Account.Phone_Number, New_Contact.Mobile, New_Contact.Assistant_Phone, New_Contact.Phone_Number, New_Vendor.Phone_Number, New_Lead.Phone_Number, New_Lead.Mobile) — There is no phone column. Stored as varchar. Country digit rules are a generated table and can drift from Creator.
- subform: 8 (New_Quotation.Quoted_Items, New_Delivery_Order.Table_of_Containers, New_Delivery_Order.Ordered_Items, New_Invoice.Table_of_Containers, New_Invoice.Invoiced_Items, New_SOF.DETAILS1, New_SOF.STOPPAGES, New_SOF.NO_CARGO_OPERATIONS) — The .ds token is grid. Every inline subform (nested fields, no values = Form.Field) becomes its own child table with a parent_id foreign key to the parent ROWID (ON-DELETE-CASCADE) and a row_order Int (0-based Creator row position). A form with several subforms gets one child table per subform; it is not a NoSQL collection. A nested subform inside a subform is not expanded. A grid whose values point at another form is a relation to that form’s table, not a second copy of it.
- time: 5 (New_SOF.Time, New_SOF.FROM, New_SOF.TO, New_SOF.FROM2, New_SOF.TO2) — There is no time column. Stored as varchar HH:MM:SS. Range comparisons are generated code.
- url: 2 (New_Account.Website, New_Lead.Website) — URLs routinely exceed varchar 255, which truncates silently. Default storage is text. maxchar of 255 or less stays varchar of that length. Creator also stores link title; a second column is not invented here.

## Manual steps

- 11 warning converter-gap — Rewrite the construct into something the converter already translates, or leave it as a fill-todo. Precheck only lists it.
- 12 warning duplicate-name — Optional: give each label its own text so migrated screens are not ambiguous.
- 1 warning pivot-analytics — Before migrating, check the report renders and exportScript succeeds in Creator; if Analytics sync is broken, recreate the report.
- 1 warning sendmail-sender — Use from : zoho.adminuserid and reply to : zoho.loginuserid, or verify the senders in the Catalyst org.
- 1 warning unique-varchar-budget — Keep at most 2 no-duplicate text fields on this form, or accept handler-level checks: they run before each insert and update but are not atomic, and a CSV or seed import does not re-check them.

## Residual TODO steps

- `field New_Account.Email property personal data` — Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Email needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Account.Phone_Number property personal data` — Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Phone_Number needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_User.Email property personal data` — Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Email needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Contact.Contact_Name property personal data` — Field Contact_Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Contact_Name needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Contact.Mobile property personal data` — Field Mobile is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Mobile needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Contact.Assistant_Phone property personal data` — Field Assistant_Phone is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Assistant_Phone needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Contact.Email property personal data` — Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Email needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Contact.Phone_Number property personal data` — Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Phone_Number needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Vendor.Phone_Number property personal data` — Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Phone_Number needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Vendor.Email property personal data` — Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Email needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Lead.Phone_Number property personal data` — Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Phone_Number needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Lead.Name property personal data` — Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Name needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Lead.Email property personal data` — Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Email needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_Lead.Mobile property personal data` — Field Mobile is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.
  - Step: In the Catalyst console, apply the data-privacy protection Mobile needs by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.

## Hidden from end users

0

- none

## Human steps

- Accept invite: accept the app invite mail
- Sign in once: sign in to the deployed app once
- Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)
- Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)
- console: cloudscale-enable — Catalyst console → the project → Cloud Scale → Start Exploring (<console>/baas/<org>/project/<project>/Development#/cloudscale) — then c2c verifies it: c2c provision --record cloudscale-enable (GET /baas/v1/project/<project>/table)
- console: stratus-enable — Catalyst console → the project → Cloud Scale → Stratus → Start Exploring (<console>/baas/<org>/project/<project>/Development#/cloudscale), then on Create your First Bucket create one bucket (any name) — done when it shows in the bucket list (click Create again if nothing happens after a few seconds) — then c2c verifies it: c2c provision --record stratus-enable (GET /baas/v1/project/<project>/bucket)
- console: connections — Catalyst console → Connections: connect zoho.books.* (the user consents to each OAuth flow)

## Not converted

Silent drops: 40 (still counted; each has a guided step below)

- `field-property:New_Account.Annual_Revenue property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Account.Annual_Revenue was not converted. In the Catalyst console, set the field's number or currency format for New_Account.Annual_Revenue, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Deal.Amount property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Deal.Amount was not converted. In the Catalyst console, set the field's number or currency format for New_Deal.Amount, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Deal.Expected_Revenue property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Deal.Expected_Revenue was not converted. In the Catalyst console, set the field's number or currency format for New_Deal.Expected_Revenue, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Lead.Annual_Revenue property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Lead.Annual_Revenue was not converted. In the Catalyst console, set the field's number or currency format for New_Lead.Annual_Revenue, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Quotation.Sub_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Quotation.Sub_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Quotation.Sub_Total, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Quotation.Tax_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Quotation.Tax_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Quotation.Tax_Total, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Quotation.Grand_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Quotation.Grand_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Quotation.Grand_Total, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Delivery_Order.Sales_Commission property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Delivery_Order.Sales_Commission was not converted. In the Catalyst console, set the field's number or currency format for New_Delivery_Order.Sales_Commission, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Delivery_Order.Excise_Duty property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Delivery_Order.Excise_Duty was not converted. In the Catalyst console, set the field's number or currency format for New_Delivery_Order.Excise_Duty, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Delivery_Order.Sub_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Delivery_Order.Sub_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Delivery_Order.Sub_Total, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Delivery_Order.Tax_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Delivery_Order.Tax_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Delivery_Order.Tax_Total, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Delivery_Order.Grand_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Delivery_Order.Grand_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Delivery_Order.Grand_Total, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Invoice.Excise_Duty property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Invoice.Excise_Duty was not converted. In the Catalyst console, set the field's number or currency format for New_Invoice.Excise_Duty, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Invoice.Sales_Commission property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Invoice.Sales_Commission was not converted. In the Catalyst console, set the field's number or currency format for New_Invoice.Sales_Commission, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Invoice.Sub_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Invoice.Sub_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Invoice.Sub_Total, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Invoice.Tax_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Invoice.Tax_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Invoice.Tax_Total, then preview a record and confirm the value is displayed correctly.
- `field-property:New_Invoice.Grand_Total property format` — not converted. property format is not carried by the generated currency field. Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.
  - Step: The display format for New_Invoice.Grand_Total was not converted. In the Catalyst console, set the field's number or currency format for New_Invoice.Grand_Total, then preview a record and confirm the value is displayed correctly.
- `report-feature:Container_Movement_Tracking block report properties` — not converted. Report Container_Movement_Tracking block report properties is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The report properties for Container_Movement_Tracking were not converted. In the Catalyst console, open the Container_Movement_Tracking report and configure its report properties, then preview it and verify the layout and visible data match the source app.
- `report-feature:SOFs block options` — not converted. Report SOFs block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the SOFs report were not converted. In the Catalyst console, open the SOFs report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Leads block options` — not converted. Report Leads block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Leads report were not converted. In the Catalyst console, open the Leads report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Converted_Leads block options` — not converted. Report Converted_Leads block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Converted_Leads report were not converted. In the Catalyst console, open the Converted_Leads report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Accounts block options` — not converted. Report Accounts block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Accounts report were not converted. In the Catalyst console, open the Accounts report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Contacts block options` — not converted. Report Contacts block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Contacts report were not converted. In the Catalyst console, open the Contacts report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Deals block options` — not converted. Report Deals block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Deals report were not converted. In the Catalyst console, open the Deals report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Quotations block options` — not converted. Report Quotations block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Quotations report were not converted. In the Catalyst console, open the Quotations report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Delivery_Orders block options` — not converted. Report Delivery_Orders block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Delivery_Orders report were not converted. In the Catalyst console, open the Delivery_Orders report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Invoices block options` — not converted. Report Invoices block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Invoices report were not converted. In the Catalyst console, open the Invoices report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Airports block options` — not converted. Report Airports block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Airports report were not converted. In the Catalyst console, open the Airports report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Ports block options` — not converted. Report Ports block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Ports report were not converted. In the Catalyst console, open the Ports report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:HS_Codes block options` — not converted. Report HS_Codes block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the HS_Codes report were not converted. In the Catalyst console, open the HS_Codes report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Users block options` — not converted. Report Users block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Users report were not converted. In the Catalyst console, open the Users report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Containers block options` — not converted. Report Containers block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Containers report were not converted. In the Catalyst console, open the Containers report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Vendors block options` — not converted. Report Vendors block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Vendors report were not converted. In the Catalyst console, open the Vendors report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Products block options` — not converted. Report Products block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Products report were not converted. In the Catalyst console, open the Products report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Vessels block options` — not converted. Report Vessels block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Vessels report were not converted. In the Catalyst console, open the Vessels report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Tax_Rates block options` — not converted. Report Tax_Rates block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Tax_Rates report were not converted. In the Catalyst console, open the Tax_Rates report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Mode_to_SubMode block options` — not converted. Report Mode_to_SubMode block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Mode_to_SubMode report were not converted. In the Catalyst console, open the Mode_to_SubMode report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Submode_to_CT_ST_CMT block options` — not converted. Report Submode_to_CT_ST_CMT block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Submode_to_CT_ST_CMT report were not converted. In the Catalyst console, open the Submode_to_CT_ST_CMT report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `report-feature:Table_of_Containers block options` — not converted. Report Table_of_Containers block options is not in the generated report. Add one: either emit it or record the manual step.
  - Step: The options for the Table_of_Containers report were not converted. In the Catalyst console, open the Table_of_Containers report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.
- `translation:translation Language_Settings` — not converted. The Language_Settings translation block is not migrated and has no manual step — only a migration-report warning, which is not a counted manual item. List the language, the string count, and what the user must copy into the generated client.
  - Step: The translation Language_Settings was not converted. In the Catalyst console, add the language and copy the source translation strings into the generated app, then preview the translated text and verify it is correct.
