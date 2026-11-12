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
0 of the 3 deterministic apps still have UI TODO stubs (0 in total).

The builtin catalogue lists 20 TODO entries
(`docs/deluge-builtins.json` `counts.todo`). That is not the corpus residual counted here: one
TODO item per untranslated construct occurrence.

| | |
|---|---:|
| corpus apps | 67 |
| apps with no residual todos | 3/67 |
| apps with no residual todos and no silent drops (deterministic) | 3/67 (4.5%) |
| silent drops (total) | 0 |
| residual TODO items | 564 |
| distinct TODO kinds | 212 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 20 TODO kinds

| construct | count |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 78 |
| `client-condition-uses-server` | 53 |
| `translation` | 41 |
| `Toolbar setting is not carried; the generated editor has no toolbar control.` | 36 |
| `Field (app identifier) is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.` | 29 |
| `Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.` | 29 |
| `ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand` | 22 |
| `Report (app identifier) has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.` | 10 |
| `Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.` | 8 |
| `openurl-unsupported-target` | 8 |
| `Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report.` | 8 |
| `Custom action (app identifier) is not migrated; its button is turned off.` | 6 |
| `Report (app identifier) has a `permission` settings block (add = true) that Catalyst generates no equivalent for.` | 4 |
| `Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (filter declaration x3)` | 4 |
| `ZML <button> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand` | 4 |
| `Field (app identifier) is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Project is one.` | 3 |
| `Field (app identifier) is flagged `enable = link`; the generated image field collects no link name or title alongside the upload, and the shown image is not a clickable link.` | 3 |
| `Report (app identifier) has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.` | 3 |
| `Report (app identifier) has an `options` setting (display type = week) that Catalyst does not carry into the generated calendar report.` | 3 |
| `ZML <report> (app identifier) criteria (app identifier) is not generated; wire the report filter by hand` | 3 |

## Top 0 silent-drop kinds

| construct | count |
|---|---:|

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `translation` | 4 |
| `client-condition-uses-server` | 1 |
| `Report (app identifier) has an `options` setting (display field = Added_Location) that Catalyst does not carry into the generated list report.` | 1 |
| `Server-side Deluge snippet requires manual translation` | 1 |

## Machine-readable

```json
{
  "deterministicApps": 3,
  "deterministicWithUiTodos": {
    "apps": 0,
    "uiTodos": 0
  },
  "kinds": [
    {
      "construct": "Server-side Deluge snippet requires manual translation",
      "count": 78
    },
    {
      "construct": "client-condition-uses-server",
      "count": 53
    },
    {
      "construct": "translation",
      "count": 41
    },
    {
      "construct": "Toolbar setting is not carried; the generated editor has no toolbar control.",
      "count": 36
    },
    {
      "construct": "Field (app identifier) is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 29
    },
    {
      "construct": "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 29
    },
    {
      "construct": "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
      "count": 22
    },
    {
      "construct": "Report (app identifier) has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 10
    },
    {
      "construct": "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
      "count": 8
    },
    {
      "construct": "openurl-unsupported-target",
      "count": 8
    },
    {
      "construct": "Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report.",
      "count": 8
    },
    {
      "construct": "Custom action (app identifier) is not migrated; its button is turned off.",
      "count": 6
    },
    {
      "construct": "Report (app identifier) has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
      "count": 4
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (filter declaration x3)",
      "count": 4
    },
    {
      "construct": "ZML <button> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
      "count": 4
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Project is one.",
      "count": 3
    },
    {
      "construct": "Field (app identifier) is flagged `enable = link`; the generated image field collects no link name or title alongside the upload, and the shown image is not a clickable link.",
      "count": 3
    },
    {
      "construct": "Report (app identifier) has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.",
      "count": 3
    },
    {
      "construct": "Report (app identifier) has an `options` setting (display type = week) that Catalyst does not carry into the generated calendar report.",
      "count": 3
    },
    {
      "construct": "ZML <report> (app identifier) criteria (app identifier) is not generated; wire the report filter by hand",
      "count": 3
    },
    {
      "construct": "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.",
      "count": 2
    },
    {
      "construct": "client-loop-uses-server",
      "count": 2
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Inventory`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Stock.Inventory is one.",
      "count": 2
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Invoice_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Return_Product.Invoice_ID is one.",
      "count": 2
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Jobs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Project.Jobs is one.",
      "count": 2
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Job.Project is one.",
      "count": 2
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Sales_Invoice`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Order_Request.Sales_Invoice is one.",
      "count": 2
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Stocks`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Inventory_stateform.Stocks is one.",
      "count": 2
    },
    {
      "construct": "Field (app identifier) restricts selectable weekdays to `0`; the generated date input is a plain native control with no weekday restriction.",
      "count": 2
    },
    {
      "construct": "Field (app identifier) sets `switch camera = true`; the generated scan field has no camera switch.",
      "count": 2
    },
    {
      "construct": "Report (app identifier) has an `options` setting (display field = Added_Location) that Catalyst does not carry into the generated list report.",
      "count": 2
    },
    {
      "construct": "report-conditional-format",
      "count": 2
    },
    {
      "construct": "Sort by (app identifier) is not migrated; the field is not a plain column of Accounting, so rows render in default (ROWID) order.",
      "count": 2
    },
    {
      "construct": "Sort by (app identifier) is not migrated; the field is not a plain column of Add_New_Inspection, so rows render in default (ROWID) order.",
      "count": 2
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 2 static style rules or declarations (background declaration, filter declaration)",
      "count": 2
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 56 static style rules or declarations (-moz-transform declaration x14, -o-transform declaration x14, -webkit-transform declaration x14, transform declaration x14)",
      "count": 2
    },
    {
      "construct": "ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
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
      "construct": "Field (app identifier) is flagged `bidirectional = Account_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Opportunity.Account_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Account_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Lead.Account_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Account`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Contact.Account is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Add_Branch`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Setup.Add_Branch is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Add_Customer_First_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Book_Free_Events1.Add_Customer_First_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Add_Customer_First_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Book_Paid_Events.Add_Customer_First_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Advance_Payments`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Report.Advance_Payments is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Appointment_Booking_Address`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Services.Appointment_Booking_Address is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Appointment_Booking_Booking_Id`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Appointment_Booking_Booking_Id is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Assign_to`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Complaint_Registration.Assign_to is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Assigned_Tasks`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staff.Assigned_Tasks is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Assigned_Tickets`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Assigned_Tickets is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Assigned_to`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Raise_a_Complaint.Assigned_to is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Block_Details_Master_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Project.Block_Details_Master_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Block`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Floor.Block is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Blocks`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Property.Blocks is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = BOM`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Production_Batch.BOM is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Book_Free_Events_Rec_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Customer.Book_Free_Events_Rec_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Book_Paid_Event_Rec_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Customer.Book_Paid_Event_Rec_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Branch`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Raise_New_Crisis.Branch is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Branches`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Services.Branches is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Buildings`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Floor.Buildings is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Category`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Sub_Category.Category is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Class_Trainer`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Class.Class_Trainer is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Class`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Student.Class is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Classes`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staff_Trainer.Classes is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Classes`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Trainee.Classes is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Company_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Distributor_Details.Company_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Services.Company_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Company_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Company`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Company is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Complaint_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Status_Update.Complaint_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Complaint_IDs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Unit_Details.Complaint_IDs is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Contact_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Opportunity.Contact_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Contacts`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Accounts.Contacts is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Course`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Tutoring_Request.Course is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Accounts.Create_Opportunity_Opportunity_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Contact.Create_Opportunity_Opportunity_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Lead.Create_Opportunity_Opportunity_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Created_Quotation`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Request_Quotation.Created_Quotation is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Customer_Review`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Order.Customer_Review is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Customer_Stats_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Appointment_Booking.Customer_Stats_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Deals_with`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Vendor.Deals_with is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Department is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Employee.Department is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Managers.Department is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Start_New_Admission.Department is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Designation`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Employee.Designation is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Distributors`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Company_Details.Distributors is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Driver_For`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_User.Driver_For is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Driver`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Vehicle.Driver is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Employees_Employee_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Service_Locations_Hubs.Employees_Employee_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Department.Employees is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Designation.Employees is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Location.Employees is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Departments.Employees is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Event_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Event_Registration.Event_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Event`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Sub_Event.Event is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Firm_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Firm_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Flats_Apartments_Master_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Project.Flats_Apartments_Master_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Floors`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Block.Floors is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Invoice_Number`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Hire_Request.Invoice_Number is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Issues`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Issues is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Lead_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Opportunity.Lead_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Lead`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Account.Lead is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Link_Advance_To`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Advance.Link_Advance_To is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Location`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Employee.Location is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Manager_Email`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Unit_Details.Manager_Email is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Manager`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Manager is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Manager`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Departments.Manager is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Managers_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Employee.Managers_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Managing_Units`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Managers.Managing_Units is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Order_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Invoice.Order_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Order_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Sales.Order_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Order_Number`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Review.Order_Number is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Owned_Vehicles`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_User.Owned_Vehicles is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Owner_Email`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Unit_Details.Owner_Email is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Owner`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Product.Owner is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Owner`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Vehicle.Owner is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Policies`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Property.Policies is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Previous_Bookings`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Customer.Previous_Bookings is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Production_Batch`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_BOM.Production_Batch is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Products_Supply`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Supplier.Products_Supply is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Products_Supply`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Vendor.Products_Supply is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Products`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_User.Products is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Project_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Block_Detail.Project_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Project_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Flats_Apartments_Shop_Details.Project_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Property_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Block.Property_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Property_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Policy.Property_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Quotation_Request_Number`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Quotation.Quotation_Request_Number is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Raise_New_Crisis_Crisis_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Branch.Raise_New_Crisis_Crisis_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Registered_Volunteers`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Event.Registered_Volunteers is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Related_Employee`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Manager.Related_Employee is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Related_Manager`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Employee.Related_Manager is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Rental_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Invoice.Rental_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Reporting_Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Manager.Reporting_Employees is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Resolved_Issues`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Service_Entry.Resolved_Issues is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Return_Products_Details`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Sales.Return_Products_Details is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Returned_Date`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Invoice.Returned_Date is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Returned_Date`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Sales.Returned_Date is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Sales_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Return_Product.Sales_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Schedule_Assessment_Batch_Number`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Fill_New_Application.Schedule_Assessment_Batch_Number is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Select_Applications`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Schedule_Assessment.Select_Applications is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Select_Floors`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Building.Select_Floors is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Service_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Issue.Service_ID is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Service_Locations_Hub`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Employees.Service_Locations_Hub is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Service`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Appointment_Booking.Service is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Branch.Services is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Services is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Setup.Services is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Staff_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Appointment_Booking.Staff_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Staff_Names`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Setup.Staff_Names is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Staffs_Working`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Branch.Staffs_Working is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Staffs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Admin_Details.Staffs is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Staffs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Services.Staffs is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Start_New_Admission_Course_Admission_Id`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Department.Start_New_Admission_Course_Admission_Id is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Status_updates`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Complaint_Registration.Status_updates is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Students`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Class.Students is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Sub_Category`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Category.Sub_Category is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Sub_Events`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Event.Sub_Events is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Subscription_Id`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Transaction.Subscription_Id is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Supplier_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Product.Supplier_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Tenant_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Unit_Details.Tenant_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Third_Party_Carriers_Contracted_Carrier_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Truck_Details.Third_Party_Carriers_Contracted_Carrier_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Trainees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Class.Trainees is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Transactions`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_New_Subscription.Transactions is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Tutoring_Requests`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Course.Tutoring_Requests is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Owner.Unit_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Tenant_Details.Unit_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Raise_a_Complaint.Unit_Name is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Vehicle_No`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Third_Party_Carriers.Vehicle_No is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Vendor`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Product.Vendor is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Vendors`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Product.Vendors is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Warehouse_Code`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Warehouse_Code is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Warehouse_Incharge`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Warehouse.Warehouse_Incharge is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `bidirectional = Working_at`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Working_at is one.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) is flagged `enable = link, title`; the generated image field collects no link name or title alongside the upload, and the shown image is not a clickable link.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) restricts selectable weekdays to `1,2,3,4,5`; the generated date input is a plain native control with no weekday restriction.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) restricts selectable weekdays to `6`; the generated date input is a plain native control with no weekday restriction.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `advanced field search = true`; the generated lookup search matches only the display field, not the other fields of the parent form.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `annotation = true`; the generated image field accepts the chosen file unchanged, with no tool to draw or mark it up first.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `duration = 150`; the generated video field hands recording off to the device camera app with no recording-length limit.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `duration = 30`; the generated video field hands recording off to the device camera app with no recording-length limit.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `manual input = true`; the generated scan field has no free-text fallback next to the camera.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `preview duration = 3`; the generated capture control has no auto-dismiss timer.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `show gallery = true`; the generated scan field cannot read a code from a photo in the gallery.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `show onload = true`; the generated image field opens its camera only when the user taps the control, never automatically when the form loads.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `show onload = true`; the generated scan field opens its scanner only when the user taps the control, never automatically when the form loads.",
      "count": 1
    },
    {
      "construct": "Field (app identifier) sets `target = same window`; the generated image field has no clickable link, so there is no window to open it in.",
      "count": 1
    },
    {
      "construct": "Inline style declarations not carried over (unsafe or unsupported CSS): ?",
      "count": 1
    },
    {
      "construct": "Report (app identifier) has a `customlayouts` settings block (template (app identifier)) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report (app identifier) has an `options` setting (display type = day) that Catalyst does not carry into the generated calendar report.",
      "count": 1
    },
    {
      "construct": "Report (app identifier) has an `options` setting (sort order = ascending, record count = enable) that Catalyst does not carry into the generated kanban report.",
      "count": 1
    },
    {
      "construct": "Report (app identifier) has an `options` setting (week start day = monday) that Catalyst does not carry into the generated timeline report.",
      "count": 1
    },
    {
      "construct": "Report (app identifier) lists column Record_Status, a Creator built-in record column; the generated schema has no column for it.",
      "count": 1
    },
    {
      "construct": "sendmail-attachment:view",
      "count": 1
    },
    {
      "construct": "Sort by (app identifier) is not migrated; the field is not a plain column of Add_Sales_Rep, so rows render in default (ROWID) order.",
      "count": 1
    },
    {
      "construct": "Sort by (app identifier) is not migrated; the field is not a plain column of Place_Order, so rows render in default (ROWID) order.",
      "count": 1
    },
    {
      "construct": "Sort by (app identifier) is not migrated; the field is not a plain column of Raise_an_Idea, so rows render in default (ROWID) order.",
      "count": 1
    },
    {
      "construct": "Sort by (app identifier) is not migrated; the field is not a plain column of Registration_Form, so rows render in default (ROWID) order.",
      "count": 1
    },
    {
      "construct": "Sort by (app identifier) is not migrated; the field is not a plain column of Status_Update, so rows render in default (ROWID) order.",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (@ rule)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background-image declaration)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (filter declaration)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (unparsed declaration)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (@font-face x3)",
      "count": 1
    },
    {
      "construct": "Static <style> CSS not carried over: the page sanitizer drops 6 static style rules or declarations (unparsed declaration x6)",
      "count": 1
    },
    {
      "construct": "The <script> element is removed from this page snippet by the sanitizer",
      "count": 1
    },
    {
      "construct": "The export caps Store_Timings (maxrow) at 7 row(s); the generated grid lets a user add past it and the submit handler does not reject an oversized subform.",
      "count": 1
    },
    {
      "construct": "The export caps Working_Hours (maxrow) at 7 row(s); the generated grid lets a user add past it and the submit handler does not reject an oversized subform.",
      "count": 1
    },
    {
      "construct": "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand",
      "count": 1
    }
  ],
  "noTodoApps": 3,
  "perAppConstructSets": [
    {
      "constructs": [
        "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.",
        "Field (app identifier) sets `advanced field search = true`; the generated lookup search matches only the display field, not the other fields of the parent form.",
        "translation",
        "ZML <report> (app identifier) criteria (app identifier) is not generated; wire the report filter by hand"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 4
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
        "Field (app identifier) is flagged `bidirectional = Inventory`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Stock.Inventory is one.",
        "Field (app identifier) is flagged `bidirectional = Invoice_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Return_Product.Invoice_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Order_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Invoice.Order_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Products_Supply`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Vendor.Products_Supply is one.",
        "Field (app identifier) is flagged `bidirectional = Returned_Date`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Invoice.Returned_Date is one.",
        "Field (app identifier) is flagged `bidirectional = Sales_Invoice`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Order_Request.Sales_Invoice is one.",
        "Field (app identifier) is flagged `bidirectional = Stocks`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Inventory_stateform.Stocks is one.",
        "Field (app identifier) is flagged `bidirectional = Vendor`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Product.Vendor is one.",
        "Field (app identifier) is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report.",
        "Report (app identifier) has an `options` setting (sort order = ascending, record count = enable) that Catalyst does not carry into the generated kanban report.",
        "Server-side Deluge snippet requires manual translation",
        "translation"
      ],
      "items": 17
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field (app identifier) is flagged `bidirectional = Jobs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Project.Jobs is one.",
        "Field (app identifier) is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Job.Project is one.",
        "Field (app identifier) is flagged `enable = link, title`; the generated image field collects no link name or title alongside the upload, and the shown image is not a clickable link.",
        "Field (app identifier) restricts selectable weekdays to `0`; the generated date input is a plain native control with no weekday restriction.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Embedded zc-component form (app identifier) has no generated view",
        "Field (app identifier) is flagged `enable = link`; the generated image field collects no link name or title alongside the upload, and the shown image is not a clickable link.",
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "Sort by (app identifier) is not migrated; the field is not a plain column of Place_Order, so rows render in default (ROWID) order."
      ],
      "items": 12
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field (app identifier) is flagged `bidirectional = Account`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Contact.Account is one.",
        "Field (app identifier) is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Distributor_Details.Company_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Contacts`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Accounts.Contacts is one.",
        "Field (app identifier) is flagged `bidirectional = Distributors`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Company_Details.Distributors is one.",
        "Field (app identifier) is flagged `bidirectional = Inventory`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Stock.Inventory is one.",
        "Field (app identifier) is flagged `bidirectional = Invoice_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Return_Product.Invoice_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Order_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Sales.Order_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Products_Supply`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Supplier.Products_Supply is one.",
        "Field (app identifier) is flagged `bidirectional = Returned_Date`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Sales.Returned_Date is one.",
        "Field (app identifier) is flagged `bidirectional = Sales_Invoice`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Order_Request.Sales_Invoice is one.",
        "Field (app identifier) is flagged `bidirectional = Stocks`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Inventory_stateform.Stocks is one.",
        "Field (app identifier) is flagged `bidirectional = Supplier_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Product.Supplier_Name is one.",
        "Sort by (app identifier) is not migrated; the field is not a plain column of Accounting, so rows render in default (ROWID) order.",
        "translation"
      ],
      "items": 17
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field (app identifier) is flagged `bidirectional = Add_Branch`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Setup.Add_Branch is one.",
        "Field (app identifier) is flagged `bidirectional = Appointment_Booking_Address`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Services.Appointment_Booking_Address is one.",
        "Field (app identifier) is flagged `bidirectional = Appointment_Booking_Booking_Id`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Appointment_Booking_Booking_Id is one.",
        "Field (app identifier) is flagged `bidirectional = Branches`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Services.Branches is one.",
        "Field (app identifier) is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Company_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Services.Company_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Company_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Customer_Stats_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Appointment_Booking.Customer_Stats_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Previous_Bookings`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Customer.Previous_Bookings is one.",
        "Field (app identifier) is flagged `bidirectional = Service`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Appointment_Booking.Service is one.",
        "Field (app identifier) is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Branch.Services is one.",
        "Field (app identifier) is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Services is one.",
        "Field (app identifier) is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Setup.Services is one.",
        "Field (app identifier) is flagged `bidirectional = Staff_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Appointment_Booking.Staff_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Staff_Names`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Setup.Staff_Names is one.",
        "Field (app identifier) is flagged `bidirectional = Staffs_Working`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Branch.Staffs_Working is one.",
        "Field (app identifier) is flagged `bidirectional = Staffs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Services.Staffs is one.",
        "Field (app identifier) is flagged `bidirectional = Working_at`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Working_at is one.",
        "Report (app identifier) has an `options` setting (display type = week) that Catalyst does not carry into the generated calendar report.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background declaration)",
        "The export caps Working_Hours (maxrow) at 7 row(s); the generated grid lets a user add past it and the submit handler does not reject an oversized subform."
      ],
      "items": 27
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field (app identifier) is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Department is one.",
        "Field (app identifier) is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Managers.Department is one.",
        "Field (app identifier) is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Departments.Employees is one.",
        "Field (app identifier) is flagged `bidirectional = Manager`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Departments.Manager is one.",
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Report (app identifier) has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 29
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field (app identifier) is flagged `bidirectional = Employees_Employee_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Service_Locations_Hubs.Employees_Employee_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Service_Locations_Hub`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Employees.Service_Locations_Hub is one.",
        "Field (app identifier) is flagged `bidirectional = Third_Party_Carriers_Contracted_Carrier_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Truck_Details.Third_Party_Carriers_Contracted_Carrier_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Vehicle_No`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Third_Party_Carriers.Vehicle_No is one.",
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 2 static style rules or declarations (background declaration, filter declaration)",
        "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (@font-face x3)",
        "translation"
      ],
      "items": 21
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field (app identifier) is flagged `bidirectional = Event_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Event_Registration.Event_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Registered_Volunteers`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Event.Registered_Volunteers is one.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field (app identifier) is flagged `bidirectional = Event`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Sub_Event.Event is one.",
        "Field (app identifier) is flagged `bidirectional = Sub_Events`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Event.Sub_Events is one.",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 4
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field (app identifier) is flagged `bidirectional = Jobs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Project.Jobs is one.",
        "Field (app identifier) is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Job.Project is one.",
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field (app identifier) restricts selectable weekdays to `0`; the generated date input is a plain native control with no weekday restriction.",
        "Field (app identifier) restricts selectable weekdays to `6`; the generated date input is a plain native control with no weekday restriction.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 11
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field (app identifier) restricts selectable weekdays to `1,2,3,4,5`; the generated date input is a plain native control with no weekday restriction.",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 20
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report.",
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation",
        "translation"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 56 static style rules or declarations (-moz-transform declaration x14, -o-transform declaration x14, -webkit-transform declaration x14, transform declaration x14)",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 22
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation",
        "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 15
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation",
        "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 7
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field (app identifier) is flagged `bidirectional = Buildings`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Floor.Buildings is one.",
        "Field (app identifier) is flagged `bidirectional = Select_Floors`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Building.Select_Floors is one.",
        "Field (app identifier) is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "Field (app identifier) sets `manual input = true`; the generated scan field has no free-text fallback next to the camera.",
        "Field (app identifier) sets `show onload = true`; the generated scan field opens its scanner only when the user taps the control, never automatically when the form loads.",
        "openurl-unsupported-target",
        "translation"
      ],
      "items": 20
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field (app identifier) is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "translation",
        "ZML <button> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
        "ZML <report> (app identifier) criteria (app identifier) is not generated; wire the report filter by hand"
      ],
      "items": 23
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation",
        "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 14
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Embedded zc-component report (app identifier) has no generated view",
        "Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report.",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (@ rule)",
        "The <script> element is removed from this page snippet by the sanitizer"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Account_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Opportunity.Account_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Contact_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Opportunity.Contact_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Accounts.Create_Opportunity_Opportunity_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Contact.Create_Opportunity_Opportunity_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Lead.Create_Opportunity_Opportunity_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Lead_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Opportunity.Lead_Name is one.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 3 static style rules or declarations (filter declaration x3)",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 19
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Account_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Lead.Account_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Lead`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Account.Lead is one.",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "Sort by (app identifier) is not migrated; the field is not a plain column of Add_Sales_Rep, so rows render in default (ROWID) order.",
        "translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Add_Customer_First_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Book_Free_Events1.Add_Customer_First_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Add_Customer_First_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Book_Paid_Events.Add_Customer_First_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Book_Free_Events_Rec_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Customer.Book_Free_Events_Rec_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Book_Paid_Event_Rec_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Customer.Book_Paid_Event_Rec_ID is one.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (filter declaration)"
      ],
      "items": 10
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Advance_Payments`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Report.Advance_Payments is one.",
        "Field (app identifier) is flagged `bidirectional = Link_Advance_To`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Advance.Link_Advance_To is one.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Assign_to`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Complaint_Registration.Assign_to is one.",
        "Field (app identifier) is flagged `bidirectional = Assigned_Tickets`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Assigned_Tickets is one.",
        "Field (app identifier) is flagged `bidirectional = Complaint_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Status_Update.Complaint_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Firm_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Firm_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Staffs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Admin_Details.Staffs is one.",
        "Field (app identifier) is flagged `bidirectional = Status_updates`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Complaint_Registration.Status_updates is one.",
        "Server-side Deluge snippet requires manual translation",
        "Sort by (app identifier) is not migrated; the field is not a plain column of Status_Update, so rows render in default (ROWID) order."
      ],
      "items": 8
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Assigned_Tasks`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staff.Assigned_Tasks is one.",
        "Field (app identifier) is flagged `bidirectional = Assigned_to`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Raise_a_Complaint.Assigned_to is one.",
        "Field (app identifier) is flagged `bidirectional = Block`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Floor.Block is one.",
        "Field (app identifier) is flagged `bidirectional = Blocks`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Property.Blocks is one.",
        "Field (app identifier) is flagged `bidirectional = Complaint_IDs`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Unit_Details.Complaint_IDs is one.",
        "Field (app identifier) is flagged `bidirectional = Floors`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Block.Floors is one.",
        "Field (app identifier) is flagged `bidirectional = Manager_Email`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Unit_Details.Manager_Email is one.",
        "Field (app identifier) is flagged `bidirectional = Managing_Units`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Managers.Managing_Units is one.",
        "Field (app identifier) is flagged `bidirectional = Owner_Email`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Unit_Details.Owner_Email is one.",
        "Field (app identifier) is flagged `bidirectional = Policies`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Property.Policies is one.",
        "Field (app identifier) is flagged `bidirectional = Property_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Block.Property_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Property_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Policy.Property_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Tenant_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Unit_Details.Tenant_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Owner.Unit_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Tenant_Details.Unit_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Raise_a_Complaint.Unit_Name is one.",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 18
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Block_Details_Master_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Project.Block_Details_Master_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Flats_Apartments_Master_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Project.Flats_Apartments_Master_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Project_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Block_Detail.Project_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Project_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Flats_Apartments_Shop_Details.Project_Name is one.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (background-image declaration)"
      ],
      "items": 8
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = BOM`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Production_Batch.BOM is one.",
        "Field (app identifier) is flagged `bidirectional = Production_Batch`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_BOM.Production_Batch is one.",
        "Field (app identifier) is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field (app identifier) sets `annotation = true`; the generated image field accepts the chosen file unchanged, with no tool to draw or mark it up first.",
        "Report (app identifier) has a `customlayouts` settings block (template (app identifier)) that Catalyst generates no equivalent for.",
        "translation"
      ],
      "items": 11
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Branch`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Raise_New_Crisis.Branch is one.",
        "Field (app identifier) is flagged `bidirectional = Raise_New_Crisis_Crisis_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Branch.Raise_New_Crisis_Crisis_Name is one.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Category`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Sub_Category.Category is one.",
        "Field (app identifier) is flagged `bidirectional = Invoice_Number`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Hire_Request.Invoice_Number is one.",
        "Field (app identifier) is flagged `bidirectional = Owner`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Product.Owner is one.",
        "Field (app identifier) is flagged `bidirectional = Products`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_User.Products is one.",
        "Field (app identifier) is flagged `bidirectional = Rental_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Invoice.Rental_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Sub_Category`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Category.Sub_Category is one.",
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "Field (app identifier) sets `show onload = true`; the generated image field opens its camera only when the user taps the control, never automatically when the form loads.",
        "Field (app identifier) sets `switch camera = true`; the generated scan field has no camera switch.",
        "Report (app identifier) lists column Record_Status, a Creator built-in record column; the generated schema has no column for it.",
        "translation"
      ],
      "items": 12
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Class_Trainer`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Class.Class_Trainer is one.",
        "Field (app identifier) is flagged `bidirectional = Classes`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staff_Trainer.Classes is one.",
        "Field (app identifier) is flagged `bidirectional = Classes`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Trainee.Classes is one.",
        "Field (app identifier) is flagged `bidirectional = Trainees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Class.Trainees is one.",
        "Field (app identifier) sets `duration = 30`; the generated video field hands recording off to the device camera app with no recording-length limit.",
        "Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report.",
        "translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Class`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Student.Class is one.",
        "Field (app identifier) is flagged `bidirectional = Students`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Class.Students is one.",
        "translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Company`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Company is one.",
        "Field (app identifier) is flagged `bidirectional = Issues`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Issues is one.",
        "Field (app identifier) is flagged `bidirectional = Manager`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Manager is one.",
        "Field (app identifier) is flagged `bidirectional = Managers_Name`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Employee.Managers_Name is one.",
        "Field (app identifier) is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor (app identifier).Project is one.",
        "Field (app identifier) is flagged `bidirectional = Related_Employee`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Manager.Related_Employee is one.",
        "Field (app identifier) is flagged `bidirectional = Related_Manager`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Employee.Related_Manager is one.",
        "Field (app identifier) is flagged `bidirectional = Reporting_Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Manager.Reporting_Employees is one.",
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Report (app identifier) has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report (app identifier) has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
        "Report (app identifier) has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over: the page sanitizer drops 1 static style rule or declaration (unparsed declaration)",
        "Static <style> CSS not carried over: the page sanitizer drops 6 static style rules or declarations (unparsed declaration x6)",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 37
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Course`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Tutoring_Request.Course is one.",
        "Field (app identifier) is flagged `bidirectional = Tutoring_Requests`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Course.Tutoring_Requests is one.",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 8
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Created_Quotation`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Request_Quotation.Created_Quotation is one.",
        "Field (app identifier) is flagged `bidirectional = Quotation_Request_Number`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Create_Quotation.Quotation_Request_Number is one."
      ],
      "items": 2
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Customer_Review`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor New_Order.Customer_Review is one.",
        "Field (app identifier) is flagged `bidirectional = Order_Number`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Review.Order_Number is one.",
        "Report (app identifier) has an `options` setting (display type = day) that Catalyst does not carry into the generated calendar report.",
        "translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Deals_with`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Vendor.Deals_with is one.",
        "Field (app identifier) is flagged `bidirectional = Vendors`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Product.Vendors is one.",
        "translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Employee.Department is one.",
        "Field (app identifier) is flagged `bidirectional = Designation`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Employee.Designation is one.",
        "Field (app identifier) is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Department.Employees is one.",
        "Field (app identifier) is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Designation.Employees is one.",
        "Field (app identifier) is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Location.Employees is one.",
        "Field (app identifier) is flagged `bidirectional = Location`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Employee.Location is one.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 9
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Start_New_Admission.Department is one.",
        "Field (app identifier) is flagged `bidirectional = Schedule_Assessment_Batch_Number`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Fill_New_Application.Schedule_Assessment_Batch_Number is one.",
        "Field (app identifier) is flagged `bidirectional = Select_Applications`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Schedule_Assessment.Select_Applications is one.",
        "Field (app identifier) is flagged `bidirectional = Start_New_Admission_Course_Admission_Id`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Department.Start_New_Admission_Course_Admission_Id is one.",
        "translation"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Driver_For`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_User.Driver_For is one.",
        "Field (app identifier) is flagged `bidirectional = Driver`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Vehicle.Driver is one.",
        "Field (app identifier) is flagged `bidirectional = Owned_Vehicles`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_User.Owned_Vehicles is one.",
        "Field (app identifier) is flagged `bidirectional = Owner`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Vehicle.Owner is one.",
        "Field (app identifier) is flagged `bidirectional = Resolved_Issues`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Service_Entry.Resolved_Issues is one.",
        "Field (app identifier) is flagged `bidirectional = Service_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Issue.Service_ID is one.",
        "Server-side Deluge snippet requires manual translation",
        "translation"
      ],
      "items": 8
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Return_Products_Details`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Sales.Return_Products_Details is one.",
        "Field (app identifier) is flagged `bidirectional = Sales_ID`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Return_Product.Sales_ID is one.",
        "Field (app identifier) is flagged `bidirectional = Warehouse_Code`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Staffs.Warehouse_Code is one.",
        "Field (app identifier) is flagged `bidirectional = Warehouse_Incharge`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Warehouse.Warehouse_Incharge is one."
      ],
      "items": 4
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `bidirectional = Subscription_Id`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_Transaction.Subscription_Id is one.",
        "Field (app identifier) is flagged `bidirectional = Transactions`; Catalyst only creates the reverse column from a linked grid side, and neither (app identifier) nor Add_New_Subscription.Transactions is one.",
        "translation",
        "ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `enable = link`; the generated image field collects no link name or title alongside the upload, and the shown image is not a clickable link.",
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field (app identifier) sets `preview duration = 3`; the generated capture control has no auto-dismiss timer.",
        "Sort by (app identifier) is not migrated; the field is not a plain column of Registration_Form, so rows render in default (ROWID) order.",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 7
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `enable = link`; the generated image field collects no link name or title alongside the upload, and the shown image is not a clickable link.",
        "Field (app identifier) sets `target = same window`; the generated image field has no clickable link, so there is no window to open it in.",
        "translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field (app identifier) sets `camera = primary`; the generated scan field is a text input marked for scanning and does not choose a camera lens.",
        "Field (app identifier) sets `show gallery = true`; the generated scan field cannot read a code from a photo in the gallery.",
        "Field (app identifier) sets `switch camera = true`; the generated scan field has no camera switch.",
        "Inline style declarations not carried over (unsafe or unsupported CSS): ?",
        "translation",
        "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 9
    },
    {
      "constructs": [
        "Field (app identifier) is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report.",
        "Report (app identifier) has an `options` setting (week start day = monday) that Catalyst does not carry into the generated timeline report.",
        "translation",
        "ZML <pc> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 6
    },
    {
      "constructs": [
        "Field (app identifier) sets `duration = 150`; the generated video field hands recording off to the device camera app with no recording-length limit.",
        "Report (app identifier) has an `options` setting (display field = Added_Location) that Catalyst does not carry into the generated list report.",
        "Sort by (app identifier) is not migrated; the field is not a plain column of Add_New_Inspection, so rows render in default (ROWID) order."
      ],
      "items": 4
    },
    {
      "constructs": [
        "Report (app identifier) has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
        "Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report."
      ],
      "items": 4
    },
    {
      "constructs": [
        "Report (app identifier) has an `options` setting (display field = Added_Location) that Catalyst does not carry into the generated list report."
      ],
      "items": 1
    },
    {
      "constructs": [
        "Report (app identifier) has an `options` setting (display type = week) that Catalyst does not carry into the generated calendar report.",
        "Report (app identifier) has an `options` setting (record count = enable) that Catalyst does not carry into the generated kanban report.",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "report-conditional-format",
        "Server-side Deluge snippet requires manual translation",
        "translation"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Sort by (app identifier) is not migrated; the field is not a plain column of Raise_an_Idea, so rows render in default (ROWID) order.",
        "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand"
      ],
      "items": 2
    },
    {
      "constructs": [
        "The export caps Store_Timings (maxrow) at 7 row(s); the generated grid lets a user add past it and the submit handler does not reject an oversized subform.",
        "translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation"
      ],
      "items": 2
    },
    {
      "constructs": [
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation",
        "ZML <text> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 4
    },
    {
      "constructs": [
        "translation"
      ],
      "items": 1
    },
    {
      "constructs": [
        "translation"
      ],
      "items": 1
    },
    {
      "constructs": [
        "translation"
      ],
      "items": 1
    },
    {
      "constructs": [
        "translation"
      ],
      "items": 1
    }
  ],
  "silentDropKinds": [],
  "silentDropTotal": 0,
  "todoTotal": 564,
  "totalApps": 67
}
```
