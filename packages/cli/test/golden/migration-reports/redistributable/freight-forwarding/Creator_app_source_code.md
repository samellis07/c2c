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

## TODO counts

12

- 11 client-condition-uses-server
- 1 Rebuild the pivot table manually: the export carries no pivot shelves, so pick the row, column and measure (aggregation) fields again over New_Table_of_Container.

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

## Hidden from end users

0

- none

## Human steps

- Accept invite: accept the app invite mail
- Sign in once: sign in to the deployed app once
- Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)
- Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)
