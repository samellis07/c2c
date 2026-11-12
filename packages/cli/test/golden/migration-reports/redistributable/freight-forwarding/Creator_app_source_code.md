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
- Deluge: 56 statements translated, 497 kept working through a compatibility shim, of 553

## TODO counts

28

- 1 Field FROM sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
- 1 Field FROM2 sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
- 1 Field Time sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
- 1 Field TO sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
- 1 Field TO2 sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
- 1 Fields "New_Account.Email (personal data = true), New_Account.Phone_Number (personal data = true), New_User.Email (personal data = true), New_Contact.Contact_Name (personal data = true), New_Contact.Mobile (personal data = true), New_Contact.Assistant_Phone (personal data = true), New_Contact.Email (personal data = true), New_Contact.Phone_Number (personal data = true), New_Vendor.Phone_Number (personal data = true), New_Vendor.Email (personal data = true), New_Lead.Phone_Number (personal data = true), New_Lead.Name (personal data = true), New_Lead.Email (personal data = true), New_Lead.Mobile (personal data = true)" are flagged for data privacy; Catalyst generates no privacy or access control for these fields.
- 1 Report "Accounts" has an `options` setting (icon = travel-world) that Catalyst does not carry into the generated list report.
- 1 Report "Airports" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
- 1 Report "Contacts" has an `options` setting (icon = users-2-wc) that Catalyst does not carry into the generated list report.
- 1 Report "Container_Movement_Tracking" has a `report properties` settings block (records displayed = all_records, allow export = false, allow drilldown and view underlying data = false) that Catalyst generates no equivalent for.
- 1 Report "Containers" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
- 1 Report "Converted_Leads" has an `options` setting (icon = users-2-home) that Catalyst does not carry into the generated list report.
- 1 Report "Deals" has an `options` setting (icon = business-laptop-71) that Catalyst does not carry into the generated list report.
- 1 Report "Delivery_Orders" has an `options` setting (icon = shopping-delivery-time) that Catalyst does not carry into the generated list report.
- 1 Report "HS_Codes" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
- 1 Report "Invoices" has an `options` setting (icon = shopping-receipt-list-42) that Catalyst does not carry into the generated list report.
- 1 Report "Leads" has an `options` setting (icon = users-2-a-add) that Catalyst does not carry into the generated list report.
- 1 Report "Mode_to_SubMode" has an `options` setting (icon = ui-1-settings-gear-64) that Catalyst does not carry into the generated list report.
- 1 Report "Ports" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
- 1 Report "Products" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
- 1 Report "Quotations" has an `options` setting (icon = text-quote) that Catalyst does not carry into the generated list report.
- 1 Report "SOFs" has an `options` setting (icon = business-laptop-71) that Catalyst does not carry into the generated list report.
- 1 Report "Submode_to_CT_ST_CMT" has an `options` setting (icon = ui-1-settings-gear-64) that Catalyst does not carry into the generated list report.
- 1 Report "Table_of_Containers" has an `options` setting (icon = business-laptop-71) that Catalyst does not carry into the generated list report.
- 1 Report "Tax_Rates" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
- 1 Report "Users" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
- 1 Report "Vendors" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
- 1 Report "Vessels" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.

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
- subform: 6 (New_Quotation.Quoted_Items, New_Delivery_Order.Ordered_Items, New_Invoice.Invoiced_Items, New_SOF.DETAILS1, New_SOF.STOPPAGES, New_SOF.NO_CARGO_OPERATIONS) — The .ds token is grid. Every inline subform (nested fields, no values = Form.Field) becomes its own child table with a parent_id foreign key to the parent ROWID (ON-DELETE-CASCADE) and a row_order Int (0-based Creator row position). A form with several subforms gets one child table per subform; it is not a NoSQL collection. A nested subform inside a subform is not expanded. A grid whose values point at another form is a relation to that form’s table, not a second copy of it.
- subform-relation: 2 (New_Delivery_Order.Table_of_Containers, New_Invoice.Table_of_Containers) — The .ds token is grid with values = Form.Field and no nested fields: a related-list view of that form’s rows, not an inline subform. No child table and no row_order column are created for this grid. The foreign key lives on the target form’s own matching lookup field (declared there directly, or named by `bidirectional`); when that column does not already exist, one parent_id foreign key (ON-DELETE-CASCADE) is added to the target table instead.
- time: 5 (New_SOF.Time, New_SOF.FROM, New_SOF.TO, New_SOF.FROM2, New_SOF.TO2) — There is no time column. Stored as varchar HH:MM:SS. Range comparisons are generated code.
- url: 2 (New_Account.Website, New_Lead.Website) — URLs routinely exceed varchar 255, which truncates silently. Default storage is text. maxchar of 255 or less stays varchar of that length. Creator also stores link title; a second column is not invented here.

## Manual steps

- 12 warning duplicate-name — Optional: give each label its own text so migrated screens are not ambiguous.
- 1 warning pivot-analytics — Before migrating, check the report renders and exportScript succeeds in Creator; if Analytics sync is broken, recreate the report.
- 1 warning sendmail-sender — Use from : zoho.adminuserid and reply to : zoho.loginuserid, or verify the senders in the Catalyst org.
- 1 warning unique-varchar-budget — Keep at most 2 no-duplicate text fields on this form, or accept handler-level checks: they run before each insert and update but are not atomic, and a CSV or seed import does not re-check them.

## Residual TODO steps

- `field privacy flags` — Fields "New_Account.Email (personal data = true), New_Account.Phone_Number (personal data = true), New_User.Email (personal data = true), New_Contact.Contact_Name (personal data = true), New_Contact.Mobile (personal data = true), New_Contact.Assistant_Phone (personal data = true), New_Contact.Email (personal data = true), New_Contact.Phone_Number (personal data = true), New_Vendor.Phone_Number (personal data = true), New_Vendor.Email (personal data = true), New_Lead.Phone_Number (personal data = true), New_Lead.Name (personal data = true), New_Lead.Email (personal data = true), New_Lead.Mobile (personal data = true)" are flagged for data privacy; Catalyst generates no privacy or access control for these fields.
  - Step: In the Catalyst console, apply the data-privacy protection needed for New_Account.Email (personal data = true), New_Account.Phone_Number (personal data = true), New_User.Email (personal data = true), New_Contact.Contact_Name (personal data = true), New_Contact.Mobile (personal data = true), New_Contact.Assistant_Phone (personal data = true), New_Contact.Email (personal data = true), New_Contact.Phone_Number (personal data = true), New_Vendor.Phone_Number (personal data = true), New_Vendor.Email (personal data = true), New_Lead.Phone_Number (personal data = true), New_Lead.Name (personal data = true), New_Lead.Email (personal data = true), New_Lead.Mobile (personal data = true) by hand (field-level masking, access restriction, or encryption, per your policy) — this is not generated.
- `field New_SOF.Time property timedisplayoptions` — Field Time sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
  - Step: Add a seconds-precision time control for Time by hand (the native time input shows only hours and minutes) — this is not generated.
- `field New_SOF.FROM property timedisplayoptions` — Field FROM sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
  - Step: Add a seconds-precision time control for FROM by hand (the native time input shows only hours and minutes) — this is not generated.
- `field New_SOF.TO property timedisplayoptions` — Field TO sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
  - Step: Add a seconds-precision time control for TO by hand (the native time input shows only hours and minutes) — this is not generated.
- `field New_SOF.FROM2 property timedisplayoptions` — Field FROM2 sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
  - Step: Add a seconds-precision time control for FROM2 by hand (the native time input shows only hours and minutes) — this is not generated.
- `field New_SOF.TO2 property timedisplayoptions` — Field TO2 sets `timedisplayoptions = hh:mm:ss`; the generated time input has no seconds step and never shows seconds.
  - Step: Add a seconds-precision time control for TO2 by hand (the native time input shows only hours and minutes) — this is not generated.
- `report Container_Movement_Tracking block report properties` — Report "Container_Movement_Tracking" has a `report properties` settings block (records displayed = all_records, allow export = false, allow drilldown and view underlying data = false) that Catalyst generates no equivalent for.
  - Step: In the Catalyst console, apply the `report properties` settings by hand on report Container_Movement_Tracking: records displayed = all_records, allow export = false, allow drilldown and view underlying data = false.
- `report SOFs block options` — Report "SOFs" has an `options` setting (icon = business-laptop-71) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report SOFs: icon = business-laptop-71.
- `report Leads block options` — Report "Leads" has an `options` setting (icon = users-2-a-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Leads: icon = users-2-a-add.
- `report Converted_Leads block options` — Report "Converted_Leads" has an `options` setting (icon = users-2-home) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Converted_Leads: icon = users-2-home.
- `report Accounts block options` — Report "Accounts" has an `options` setting (icon = travel-world) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Accounts: icon = travel-world.
- `report Contacts block options` — Report "Contacts" has an `options` setting (icon = users-2-wc) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Contacts: icon = users-2-wc.
- `report Deals block options` — Report "Deals" has an `options` setting (icon = business-laptop-71) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Deals: icon = business-laptop-71.
- `report Quotations block options` — Report "Quotations" has an `options` setting (icon = text-quote) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Quotations: icon = text-quote.
- `report Delivery_Orders block options` — Report "Delivery_Orders" has an `options` setting (icon = shopping-delivery-time) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Delivery_Orders: icon = shopping-delivery-time.
- `report Invoices block options` — Report "Invoices" has an `options` setting (icon = shopping-receipt-list-42) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Invoices: icon = shopping-receipt-list-42.
- `report Airports block options` — Report "Airports" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Airports: icon = files-folder-add.
- `report Ports block options` — Report "Ports" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Ports: icon = files-folder-add.
- `report HS_Codes block options` — Report "HS_Codes" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report HS_Codes: icon = files-folder-add.
- `report Users block options` — Report "Users" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Users: icon = files-folder-add.
- `report Containers block options` — Report "Containers" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Containers: icon = files-folder-add.
- `report Vendors block options` — Report "Vendors" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Vendors: icon = files-folder-add.
- `report Products block options` — Report "Products" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Products: icon = files-folder-add.
- `report Vessels block options` — Report "Vessels" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Vessels: icon = files-folder-add.
- `report Tax_Rates block options` — Report "Tax_Rates" has an `options` setting (icon = files-folder-add) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Tax_Rates: icon = files-folder-add.
- `report Mode_to_SubMode block options` — Report "Mode_to_SubMode" has an `options` setting (icon = ui-1-settings-gear-64) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Mode_to_SubMode: icon = ui-1-settings-gear-64.
- `report Submode_to_CT_ST_CMT block options` — Report "Submode_to_CT_ST_CMT" has an `options` setting (icon = ui-1-settings-gear-64) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Submode_to_CT_ST_CMT: icon = ui-1-settings-gear-64.
- `report Table_of_Containers block options` — Report "Table_of_Containers" has an `options` setting (icon = business-laptop-71) that Catalyst does not carry into the generated list report.
  - Step: In the Catalyst console, apply the `options` setting by hand on report Table_of_Containers: icon = business-laptop-71.

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

Silent drops: 0 (still counted; each has a guided step below)

- none
