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
| apps with no residual todos | 1/67 |
| apps with no residual todos and no silent drops (deterministic) | 0/67 (0%) |
| silent drops (total) | 261 |
| residual TODO items | 841 |
| distinct TODO kinds | 276 |
| deterministic apps with UI TODO stubs (included in the residual) | 0 (0 stubs) |

## Top 20 TODO kinds

| construct | count |
|---|---:|
| `Server-side Deluge snippet requires manual translation` | 96 |
| `Custom action (app identifier) is not migrated; its button is turned off.` | 89 |
| `Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.` | 76 |
| `openurl-unsupported-target` | 71 |
| `client-condition-uses-server` | 63 |
| `Toolbar setting is not carried; the generated editor has no toolbar control.` | 36 |
| `Static <style> CSS not carried over:(app identifier)` | 27 |
| `translation-block` | 26 |
| `Default row count is not carried; the generated subform starts with no pre-filled rows.` | 14 |
| `Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.` | 8 |
| `Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.` | 7 |
| `Field Company_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.` | 6 |
| `pushnotification` | 6 |
| `Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.` | 5 |
| `Field Billing_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.` | 4 |
| `Field Shipping_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.` | 4 |
| `Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.` | 4 |
| `function-untranslated` | 4 |
| `ZML <button> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand` | 4 |
| `client-loop-uses-server` | 3 |

## Top 4 silent-drop kinds

| construct | count |
|---|---:|
| `field-property` | 139 |
| `page-element` | 49 |
| `translation` | 41 |
| `report-feature` | 32 |

## Sole-kind unblocks

An app in this table has exactly one public construct left. Fixing that construct
clears the app. The count is apps, not items.

| construct | apps |
|---|---:|
| `Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.` | 1 |

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
      "construct": "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 76
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
      "construct": "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 8
    },
    {
      "construct": "Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 7
    },
    {
      "construct": "Field Company_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 6
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
      "construct": "Field Billing_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 4
    },
    {
      "construct": "Field Shipping_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 4
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
      "construct": "ZML <button> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand",
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
      "construct": "Field Delivery_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 3
    },
    {
      "construct": "Field Location is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 3
    },
    {
      "construct": "Field Mail_ID is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 3
    },
    {
      "construct": "Field Present_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 3
    },
    {
      "construct": "Field Warehouse_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
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
      "construct": "Field Branch_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 2
    },
    {
      "construct": "Field Current_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 2
    },
    {
      "construct": "Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 2
    },
    {
      "construct": "Field From_Date restricts selectable weekdays to `0`; the generated date input is a plain native control with no weekday restriction.",
      "count": 2
    },
    {
      "construct": "Field Inventory is flagged `bidirectional = Stocks`; Catalyst only creates the reverse column from a linked grid side, and neither Inventory nor Inventory_stateform.Stocks is one.",
      "count": 2
    },
    {
      "construct": "Field Jobs is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Jobs nor Add_Job.Project is one.",
      "count": 2
    },
    {
      "construct": "Field Location1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 2
    },
    {
      "construct": "Field Order_ID is flagged `bidirectional = Sales_Invoice`; Catalyst only creates the reverse column from a linked grid side, and neither Order_ID nor New_Order_Request.Sales_Invoice is one.",
      "count": 2
    },
    {
      "construct": "Field Organization_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 2
    },
    {
      "construct": "Field Permanent_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 2
    },
    {
      "construct": "Field Phone is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 2
    },
    {
      "construct": "Field Present_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 2
    },
    {
      "construct": "Field Project is flagged `bidirectional = Jobs`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Add_Project.Jobs is one.",
      "count": 2
    },
    {
      "construct": "Field Returned_Date is flagged `bidirectional = Invoice_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Returned_Date nor Return_Product.Invoice_ID is one.",
      "count": 2
    },
    {
      "construct": "Field Stocks is flagged `bidirectional = Inventory`; Catalyst only creates the reverse column from a linked grid side, and neither Stocks nor Add_Stock.Inventory is one.",
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
      "construct": "Field Account is flagged `bidirectional = Contacts`; Catalyst only creates the reverse column from a linked grid side, and neither Account nor Add_Accounts.Contacts is one.",
      "count": 1
    },
    {
      "construct": "Field Account_Name is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Account_Name nor Create_Accounts.Create_Opportunity_Opportunity_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Account_Name is flagged `bidirectional = Lead`; Catalyst only creates the reverse column from a linked grid side, and neither Account_Name nor New_Account.Lead is one.",
      "count": 1
    },
    {
      "construct": "Field Add_Branch is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Add_Branch nor Add_Branch.Company_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Add_Customer_First_Name is flagged `bidirectional = Book_Free_Events_Rec_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Add_Customer_First_Name nor Add_Customer.Book_Free_Events_Rec_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Add_Customer_First_Name is flagged `bidirectional = Book_Paid_Event_Rec_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Add_Customer_First_Name nor Add_Customer.Book_Paid_Event_Rec_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Address is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Address_Parent is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Address_Student is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Admin_Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Advance_Payments is flagged `bidirectional = Link_Advance_To`; Catalyst only creates the reverse column from a linked grid side, and neither Advance_Payments nor Add_Advance.Link_Advance_To is one.",
      "count": 1
    },
    {
      "construct": "Field Appointment_Booking_Address is flagged `bidirectional = Service`; Catalyst only creates the reverse column from a linked grid side, and neither Appointment_Booking_Address nor Appointment_Booking.Service is one.",
      "count": 1
    },
    {
      "construct": "Field Appointment_Booking_Booking_Id is flagged `bidirectional = Staff_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Appointment_Booking_Booking_Id nor Appointment_Booking.Staff_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Assign_to is flagged `bidirectional = Assigned_Tickets`; Catalyst only creates the reverse column from a linked grid side, and neither Assign_to nor Add_Staffs.Assigned_Tickets is one.",
      "count": 1
    },
    {
      "construct": "Field Assigned_Tasks is flagged `bidirectional = Assigned_to`; Catalyst only creates the reverse column from a linked grid side, and neither Assigned_Tasks nor Raise_a_Complaint.Assigned_to is one.",
      "count": 1
    },
    {
      "construct": "Field Assigned_Tickets is flagged `bidirectional = Assign_to`; Catalyst only creates the reverse column from a linked grid side, and neither Assigned_Tickets nor Complaint_Registration.Assign_to is one.",
      "count": 1
    },
    {
      "construct": "Field Assigned_to is flagged `bidirectional = Assigned_Tasks`; Catalyst only creates the reverse column from a linked grid side, and neither Assigned_to nor Add_Staff.Assigned_Tasks is one.",
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
      "construct": "Field Billing_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Block is flagged `bidirectional = Floors`; Catalyst only creates the reverse column from a linked grid side, and neither Block nor Add_Block.Floors is one.",
      "count": 1
    },
    {
      "construct": "Field Block_Details_Master_ID is flagged `bidirectional = Project_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Block_Details_Master_ID nor Add_Block_Detail.Project_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Blocks is flagged `bidirectional = Property_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Blocks nor Add_Block.Property_Name is one.",
      "count": 1
    },
    {
      "construct": "Field BOM is flagged `bidirectional = Production_Batch`; Catalyst only creates the reverse column from a linked grid side, and neither BOM nor Create_BOM.Production_Batch is one.",
      "count": 1
    },
    {
      "construct": "Field Book_Free_Events_Rec_ID is flagged `bidirectional = Add_Customer_First_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Book_Free_Events_Rec_ID nor Book_Free_Events1.Add_Customer_First_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Book_Paid_Event_Rec_ID is flagged `bidirectional = Add_Customer_First_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Book_Paid_Event_Rec_ID nor Book_Paid_Events.Add_Customer_First_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Borrower_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Branch is flagged `bidirectional = Raise_New_Crisis_Crisis_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Branch nor Add_Branch.Raise_New_Crisis_Crisis_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Branch_Site_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Branches is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither Branches nor Add_Branch.Services is one.",
      "count": 1
    },
    {
      "construct": "Field Buildings is flagged `bidirectional = Select_Floors`; Catalyst only creates the reverse column from a linked grid side, and neither Buildings nor Add_Building.Select_Floors is one.",
      "count": 1
    },
    {
      "construct": "Field Category is flagged `bidirectional = Sub_Category`; Catalyst only creates the reverse column from a linked grid side, and neither Category nor New_Category.Sub_Category is one.",
      "count": 1
    },
    {
      "construct": "Field Class is flagged `bidirectional = Students`; Catalyst only creates the reverse column from a linked grid side, and neither Class nor Add_Class.Students is one.",
      "count": 1
    },
    {
      "construct": "Field Class_Trainer is flagged `bidirectional = Classes`; Catalyst only creates the reverse column from a linked grid side, and neither Class_Trainer nor Add_Staff_Trainer.Classes is one.",
      "count": 1
    },
    {
      "construct": "Field Classes is flagged `bidirectional = Class_Trainer`; Catalyst only creates the reverse column from a linked grid side, and neither Classes nor Add_Class.Class_Trainer is one.",
      "count": 1
    },
    {
      "construct": "Field Classes is flagged `bidirectional = Trainees`; Catalyst only creates the reverse column from a linked grid side, and neither Classes nor Add_Class.Trainees is one.",
      "count": 1
    },
    {
      "construct": "Field Company is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Company nor Company.Project is one.",
      "count": 1
    },
    {
      "construct": "Field Company_Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Company_Name is flagged `bidirectional = Add_Branch`; Catalyst only creates the reverse column from a linked grid side, and neither Company_Name nor Setup.Add_Branch is one.",
      "count": 1
    },
    {
      "construct": "Field Company_Name is flagged `bidirectional = Distributors`; Catalyst only creates the reverse column from a linked grid side, and neither Company_Name nor Company_Details.Distributors is one.",
      "count": 1
    },
    {
      "construct": "Field Company_Name is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither Company_Name nor Setup.Services is one.",
      "count": 1
    },
    {
      "construct": "Field Company_Name is flagged `bidirectional = Staff_Names`; Catalyst only creates the reverse column from a linked grid side, and neither Company_Name nor Setup.Staff_Names is one.",
      "count": 1
    },
    {
      "construct": "Field Complaint_ID is flagged `bidirectional = Status_updates`; Catalyst only creates the reverse column from a linked grid side, and neither Complaint_ID nor Complaint_Registration.Status_updates is one.",
      "count": 1
    },
    {
      "construct": "Field Complaint_IDs is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Complaint_IDs nor Raise_a_Complaint.Unit_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Contact_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Contact_Name is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Contact_Name nor Create_Contact.Create_Opportunity_Opportunity_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Contacts is flagged `bidirectional = Account`; Catalyst only creates the reverse column from a linked grid side, and neither Contacts nor Add_Contact.Account is one.",
      "count": 1
    },
    {
      "construct": "Field Course is flagged `bidirectional = Tutoring_Requests`; Catalyst only creates the reverse column from a linked grid side, and neither Course nor Add_Course.Tutoring_Requests is one.",
      "count": 1
    },
    {
      "construct": "Field Court_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Create_Opportunity_Opportunity_Name is flagged `bidirectional = Account_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Create_Opportunity_Opportunity_Name nor Create_Opportunity.Account_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Create_Opportunity_Opportunity_Name is flagged `bidirectional = Contact_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Create_Opportunity_Opportunity_Name nor Create_Opportunity.Contact_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Create_Opportunity_Opportunity_Name is flagged `bidirectional = Lead_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Create_Opportunity_Opportunity_Name nor Create_Opportunity.Lead_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Created_Quotation is flagged `bidirectional = Quotation_Request_Number`; Catalyst only creates the reverse column from a linked grid side, and neither Created_Quotation nor Create_Quotation.Quotation_Request_Number is one.",
      "count": 1
    },
    {
      "construct": "Field Customer_Review is flagged `bidirectional = Order_Number`; Catalyst only creates the reverse column from a linked grid side, and neither Customer_Review nor Add_Review.Order_Number is one.",
      "count": 1
    },
    {
      "construct": "Field Customer_Stats_ID is flagged `bidirectional = Previous_Bookings`; Catalyst only creates the reverse column from a linked grid side, and neither Customer_Stats_ID nor Add_Customer.Previous_Bookings is one.",
      "count": 1
    },
    {
      "construct": "Field Date_field restricts selectable weekdays to `1,2,3,4,5`; the generated date input is a plain native control with no weekday restriction.",
      "count": 1
    },
    {
      "construct": "Field Days is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Deals_with is flagged `bidirectional = Vendors`; Catalyst only creates the reverse column from a linked grid side, and neither Deals_with nor Add_Product.Vendors is one.",
      "count": 1
    },
    {
      "construct": "Field Department is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Department nor Add_Department.Employees is one.",
      "count": 1
    },
    {
      "construct": "Field Department is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Department nor Departments.Employees is one.",
      "count": 1
    },
    {
      "construct": "Field Department is flagged `bidirectional = Manager`; Catalyst only creates the reverse column from a linked grid side, and neither Department nor Departments.Manager is one.",
      "count": 1
    },
    {
      "construct": "Field Department is flagged `bidirectional = Start_New_Admission_Course_Admission_Id`; Catalyst only creates the reverse column from a linked grid side, and neither Department nor Add_Department.Start_New_Admission_Course_Admission_Id is one.",
      "count": 1
    },
    {
      "construct": "Field Designation is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Designation nor Add_Designation.Employees is one.",
      "count": 1
    },
    {
      "construct": "Field Distributors is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Distributors nor Add_Distributor_Details.Company_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Driver is flagged `bidirectional = Driver_For`; Catalyst only creates the reverse column from a linked grid side, and neither Driver nor Add_User.Driver_For is one.",
      "count": 1
    },
    {
      "construct": "Field Driver_For is flagged `bidirectional = Driver`; Catalyst only creates the reverse column from a linked grid side, and neither Driver_For nor Add_Vehicle.Driver is one.",
      "count": 1
    },
    {
      "construct": "Field Employee_Emails is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Employees is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither Employees nor Add_Employee.Department is one.",
      "count": 1
    },
    {
      "construct": "Field Employees is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither Employees nor Employees.Department is one.",
      "count": 1
    },
    {
      "construct": "Field Employees is flagged `bidirectional = Designation`; Catalyst only creates the reverse column from a linked grid side, and neither Employees nor Add_Employee.Designation is one.",
      "count": 1
    },
    {
      "construct": "Field Employees is flagged `bidirectional = Location`; Catalyst only creates the reverse column from a linked grid side, and neither Employees nor Add_Employee.Location is one.",
      "count": 1
    },
    {
      "construct": "Field Employees_Employee_Name is flagged `bidirectional = Service_Locations_Hub`; Catalyst only creates the reverse column from a linked grid side, and neither Employees_Employee_Name nor Employees.Service_Locations_Hub is one.",
      "count": 1
    },
    {
      "construct": "Field Event is flagged `bidirectional = Sub_Events`; Catalyst only creates the reverse column from a linked grid side, and neither Event nor Add_Event.Sub_Events is one.",
      "count": 1
    },
    {
      "construct": "Field Event is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Event_Name is flagged `bidirectional = Registered_Volunteers`; Catalyst only creates the reverse column from a linked grid side, and neither Event_Name nor Create_Event.Registered_Volunteers is one.",
      "count": 1
    },
    {
      "construct": "Field Feed_back is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Firm_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Firm_Name is flagged `bidirectional = Staffs`; Catalyst only creates the reverse column from a linked grid side, and neither Firm_Name nor Add_Admin_Details.Staffs is one.",
      "count": 1
    },
    {
      "construct": "Field Flats_Apartments_Master_ID is flagged `bidirectional = Project_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Flats_Apartments_Master_ID nor Add_Flats_Apartments_Shop_Details.Project_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Floors is flagged `bidirectional = Block`; Catalyst only creates the reverse column from a linked grid side, and neither Floors nor Add_Floor.Block is one.",
      "count": 1
    },
    {
      "construct": "Field Founder_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Gym_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Home_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Hours is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Invoice_ID is flagged `bidirectional = Returned_Date`; Catalyst only creates the reverse column from a linked grid side, and neither Invoice_ID nor Add_Invoice.Returned_Date is one.",
      "count": 1
    },
    {
      "construct": "Field Invoice_ID is flagged `bidirectional = Returned_Date`; Catalyst only creates the reverse column from a linked grid side, and neither Invoice_ID nor Add_Sales.Returned_Date is one.",
      "count": 1
    },
    {
      "construct": "Field Invoice_Number is flagged `bidirectional = Rental_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Invoice_Number nor Add_Invoice.Rental_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Issues is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Issues nor Issues.Project is one.",
      "count": 1
    },
    {
      "construct": "Field Lead is flagged `bidirectional = Account_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Lead nor New_Lead.Account_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Lead_Name is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Lead_Name nor Create_Lead.Create_Opportunity_Opportunity_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Link_Advance_To is flagged `bidirectional = Advance_Payments`; Catalyst only creates the reverse column from a linked grid side, and neither Link_Advance_To nor Add_Report.Advance_Payments is one.",
      "count": 1
    },
    {
      "construct": "Field Location is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Location nor Add_Location.Employees is one.",
      "count": 1
    },
    {
      "construct": "Field Mail_Id is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Mailing_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Main_Contact_Person is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Manager is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither Manager nor Managers.Department is one.",
      "count": 1
    },
    {
      "construct": "Field Manager is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Manager nor Manager.Project is one.",
      "count": 1
    },
    {
      "construct": "Field Manager_Email is flagged `bidirectional = Managing_Units`; Catalyst only creates the reverse column from a linked grid side, and neither Manager_Email nor Add_Managers.Managing_Units is one.",
      "count": 1
    },
    {
      "construct": "Field Managers_Name is flagged `bidirectional = Reporting_Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Managers_Name nor Manager.Reporting_Employees is one.",
      "count": 1
    },
    {
      "construct": "Field Managing_Units is flagged `bidirectional = Manager_Email`; Catalyst only creates the reverse column from a linked grid side, and neither Managing_Units nor Add_Unit_Details.Manager_Email is one.",
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
      "construct": "Field Order_Number is flagged `bidirectional = Customer_Review`; Catalyst only creates the reverse column from a linked grid side, and neither Order_Number nor New_Order.Customer_Review is one.",
      "count": 1
    },
    {
      "construct": "Field Organisation_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Owned_Vehicles is flagged `bidirectional = Owner`; Catalyst only creates the reverse column from a linked grid side, and neither Owned_Vehicles nor Add_Vehicle.Owner is one.",
      "count": 1
    },
    {
      "construct": "Field Owner is flagged `bidirectional = Owned_Vehicles`; Catalyst only creates the reverse column from a linked grid side, and neither Owner nor Add_User.Owned_Vehicles is one.",
      "count": 1
    },
    {
      "construct": "Field Owner is flagged `bidirectional = Products`; Catalyst only creates the reverse column from a linked grid side, and neither Owner nor Add_User.Products is one.",
      "count": 1
    },
    {
      "construct": "Field Owner_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Owner_Email is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Owner_Email nor Add_Owner.Unit_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Permananet_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Permanent_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Phone_Number1 is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Pickup_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Policies is flagged `bidirectional = Property_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Policies nor Add_Policy.Property_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Previous_Bookings is flagged `bidirectional = Customer_Stats_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Previous_Bookings nor Appointment_Booking.Customer_Stats_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Production_Batch is flagged `bidirectional = BOM`; Catalyst only creates the reverse column from a linked grid side, and neither Production_Batch nor Add_Production_Batch.BOM is one.",
      "count": 1
    },
    {
      "construct": "Field Products is flagged `bidirectional = Owner`; Catalyst only creates the reverse column from a linked grid side, and neither Products nor Add_Product.Owner is one.",
      "count": 1
    },
    {
      "construct": "Field Products_Supply is flagged `bidirectional = Supplier_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Products_Supply nor Add_Product.Supplier_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Products_Supply is flagged `bidirectional = Vendor`; Catalyst only creates the reverse column from a linked grid side, and neither Products_Supply nor Add_Product.Vendor is one.",
      "count": 1
    },
    {
      "construct": "Field Project is flagged `bidirectional = Company`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Project.Company is one.",
      "count": 1
    },
    {
      "construct": "Field Project is flagged `bidirectional = Issues`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Project.Issues is one.",
      "count": 1
    },
    {
      "construct": "Field Project is flagged `bidirectional = Manager`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Project.Manager is one.",
      "count": 1
    },
    {
      "construct": "Field Project_Name is flagged `bidirectional = Block_Details_Master_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Project_Name nor Add_Project.Block_Details_Master_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Project_Name is flagged `bidirectional = Flats_Apartments_Master_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Project_Name nor Add_Project.Flats_Apartments_Master_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Property_Name is flagged `bidirectional = Blocks`; Catalyst only creates the reverse column from a linked grid side, and neither Property_Name nor Add_Property.Blocks is one.",
      "count": 1
    },
    {
      "construct": "Field Property_Name is flagged `bidirectional = Policies`; Catalyst only creates the reverse column from a linked grid side, and neither Property_Name nor Add_Property.Policies is one.",
      "count": 1
    },
    {
      "construct": "Field Purchased_amount_till_now is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Quotation_Request_Number is flagged `bidirectional = Created_Quotation`; Catalyst only creates the reverse column from a linked grid side, and neither Quotation_Request_Number nor Request_Quotation.Created_Quotation is one.",
      "count": 1
    },
    {
      "construct": "Field Raise_New_Crisis_Crisis_Name is flagged `bidirectional = Branch`; Catalyst only creates the reverse column from a linked grid side, and neither Raise_New_Crisis_Crisis_Name nor Raise_New_Crisis.Branch is one.",
      "count": 1
    },
    {
      "construct": "Field Registered_Volunteers is flagged `bidirectional = Event_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Registered_Volunteers nor Event_Registration.Event_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Related_Employee is flagged `bidirectional = Related_Manager`; Catalyst only creates the reverse column from a linked grid side, and neither Related_Employee nor Employee.Related_Manager is one.",
      "count": 1
    },
    {
      "construct": "Field Related_Manager is flagged `bidirectional = Related_Employee`; Catalyst only creates the reverse column from a linked grid side, and neither Related_Manager nor Manager.Related_Employee is one.",
      "count": 1
    },
    {
      "construct": "Field Rental_ID is flagged `bidirectional = Invoice_Number`; Catalyst only creates the reverse column from a linked grid side, and neither Rental_ID nor Hire_Request.Invoice_Number is one.",
      "count": 1
    },
    {
      "construct": "Field Reporting_Employees is flagged `bidirectional = Managers_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Reporting_Employees nor Employee.Managers_Name is one.",
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
      "construct": "Field Resolved_Issues is flagged `bidirectional = Service_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Resolved_Issues nor Add_Issue.Service_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Return_Products_Details is flagged `bidirectional = Sales_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Return_Products_Details nor Return_Product.Sales_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Sales_ID is flagged `bidirectional = Return_Products_Details`; Catalyst only creates the reverse column from a linked grid side, and neither Sales_ID nor Add_Sales.Return_Products_Details is one.",
      "count": 1
    },
    {
      "construct": "Field Sales_Invoice is flagged `bidirectional = Order_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Sales_Invoice nor Add_Invoice.Order_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Sales_Invoice is flagged `bidirectional = Order_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Sales_Invoice nor Add_Sales.Order_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Schedule_Assessment_Batch_Number is flagged `bidirectional = Select_Applications`; Catalyst only creates the reverse column from a linked grid side, and neither Schedule_Assessment_Batch_Number nor Schedule_Assessment.Select_Applications is one.",
      "count": 1
    },
    {
      "construct": "Field Seconds is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Select_Applications is flagged `bidirectional = Schedule_Assessment_Batch_Number`; Catalyst only creates the reverse column from a linked grid side, and neither Select_Applications nor Fill_New_Application.Schedule_Assessment_Batch_Number is one.",
      "count": 1
    },
    {
      "construct": "Field Select_Floors is flagged `bidirectional = Buildings`; Catalyst only creates the reverse column from a linked grid side, and neither Select_Floors nor Add_Floor.Buildings is one.",
      "count": 1
    },
    {
      "construct": "Field Service is flagged `bidirectional = Appointment_Booking_Address`; Catalyst only creates the reverse column from a linked grid side, and neither Service nor Add_Services.Appointment_Booking_Address is one.",
      "count": 1
    },
    {
      "construct": "Field Service_ID is flagged `bidirectional = Resolved_Issues`; Catalyst only creates the reverse column from a linked grid side, and neither Service_ID nor Service_Entry.Resolved_Issues is one.",
      "count": 1
    },
    {
      "construct": "Field Service_Locations_Hub is flagged `bidirectional = Employees_Employee_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Service_Locations_Hub nor Service_Locations_Hubs.Employees_Employee_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Services is flagged `bidirectional = Branches`; Catalyst only creates the reverse column from a linked grid side, and neither Services nor Add_Services.Branches is one.",
      "count": 1
    },
    {
      "construct": "Field Services is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Services nor Add_Services.Company_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Services is flagged `bidirectional = Staffs`; Catalyst only creates the reverse column from a linked grid side, and neither Services nor Add_Services.Staffs is one.",
      "count": 1
    },
    {
      "construct": "Field Shipping_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Shipping_To is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Signature is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Site_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Staff_Name is flagged `bidirectional = Appointment_Booking_Booking_Id`; Catalyst only creates the reverse column from a linked grid side, and neither Staff_Name nor Add_Staffs.Appointment_Booking_Booking_Id is one.",
      "count": 1
    },
    {
      "construct": "Field Staff_Names is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Staff_Names nor Add_Staffs.Company_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Staffs is flagged `bidirectional = Firm_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Staffs nor Add_Staffs.Firm_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Staffs is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither Staffs nor Add_Staffs.Services is one.",
      "count": 1
    },
    {
      "construct": "Field Staffs_Working is flagged `bidirectional = Working_at`; Catalyst only creates the reverse column from a linked grid side, and neither Staffs_Working nor Add_Staffs.Working_at is one.",
      "count": 1
    },
    {
      "construct": "Field Start_New_Admission_Course_Admission_Id is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither Start_New_Admission_Course_Admission_Id nor Start_New_Admission.Department is one.",
      "count": 1
    },
    {
      "construct": "Field Status_updates is flagged `bidirectional = Complaint_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Status_updates nor Status_Update.Complaint_ID is one.",
      "count": 1
    },
    {
      "construct": "Field Student_Absent_List is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Students is flagged `bidirectional = Class`; Catalyst only creates the reverse column from a linked grid side, and neither Students nor Add_Student.Class is one.",
      "count": 1
    },
    {
      "construct": "Field Sub_Category is flagged `bidirectional = Category`; Catalyst only creates the reverse column from a linked grid side, and neither Sub_Category nor New_Sub_Category.Category is one.",
      "count": 1
    },
    {
      "construct": "Field Sub_Events is flagged `bidirectional = Event`; Catalyst only creates the reverse column from a linked grid side, and neither Sub_Events nor Add_Sub_Event.Event is one.",
      "count": 1
    },
    {
      "construct": "Field Subscription_Id is flagged `bidirectional = Transactions`; Catalyst only creates the reverse column from a linked grid side, and neither Subscription_Id nor Add_New_Subscription.Transactions is one.",
      "count": 1
    },
    {
      "construct": "Field Supplier_Name is flagged `bidirectional = Products_Supply`; Catalyst only creates the reverse column from a linked grid side, and neither Supplier_Name nor Add_Supplier.Products_Supply is one.",
      "count": 1
    },
    {
      "construct": "Field Tenant_Name is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Tenant_Name nor Add_Tenant_Details.Unit_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Text_for_Attendance is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Third_Party_Carriers_Contracted_Carrier_Name is flagged `bidirectional = Vehicle_No`; Catalyst only creates the reverse column from a linked grid side, and neither Third_Party_Carriers_Contracted_Carrier_Name nor Third_Party_Carriers.Vehicle_No is one.",
      "count": 1
    },
    {
      "construct": "Field To_Date restricts selectable weekdays to `6`; the generated date input is a plain native control with no weekday restriction.",
      "count": 1
    },
    {
      "construct": "Field Trainees is flagged `bidirectional = Classes`; Catalyst only creates the reverse column from a linked grid side, and neither Trainees nor Add_Trainee.Classes is one.",
      "count": 1
    },
    {
      "construct": "Field Transactions is flagged `bidirectional = Subscription_Id`; Catalyst only creates the reverse column from a linked grid side, and neither Transactions nor Add_Transaction.Subscription_Id is one.",
      "count": 1
    },
    {
      "construct": "Field Tutoring_Requests is flagged `bidirectional = Course`; Catalyst only creates the reverse column from a linked grid side, and neither Tutoring_Requests nor Tutoring_Request.Course is one.",
      "count": 1
    },
    {
      "construct": "Field Unit_Name is flagged `bidirectional = Complaint_IDs`; Catalyst only creates the reverse column from a linked grid side, and neither Unit_Name nor Add_Unit_Details.Complaint_IDs is one.",
      "count": 1
    },
    {
      "construct": "Field Unit_Name is flagged `bidirectional = Owner_Email`; Catalyst only creates the reverse column from a linked grid side, and neither Unit_Name nor Add_Unit_Details.Owner_Email is one.",
      "count": 1
    },
    {
      "construct": "Field Unit_Name is flagged `bidirectional = Tenant_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Unit_Name nor Add_Unit_Details.Tenant_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Vehicle_No is flagged `bidirectional = Third_Party_Carriers_Contracted_Carrier_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Vehicle_No nor Truck_Details.Third_Party_Carriers_Contracted_Carrier_Name is one.",
      "count": 1
    },
    {
      "construct": "Field Vendor is flagged `bidirectional = Products_Supply`; Catalyst only creates the reverse column from a linked grid side, and neither Vendor nor Add_Vendor.Products_Supply is one.",
      "count": 1
    },
    {
      "construct": "Field Vendors is flagged `bidirectional = Deals_with`; Catalyst only creates the reverse column from a linked grid side, and neither Vendors nor Add_Vendor.Deals_with is one.",
      "count": 1
    },
    {
      "construct": "Field Venue is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Venue_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Verified_User is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
      "count": 1
    },
    {
      "construct": "Field Warehouse_Code is flagged `bidirectional = Warehouse_Incharge`; Catalyst only creates the reverse column from a linked grid side, and neither Warehouse_Code nor Add_Warehouse.Warehouse_Incharge is one.",
      "count": 1
    },
    {
      "construct": "Field Warehouse_Incharge is flagged `bidirectional = Warehouse_Code`; Catalyst only creates the reverse column from a linked grid side, and neither Warehouse_Incharge nor Add_Staffs.Warehouse_Code is one.",
      "count": 1
    },
    {
      "construct": "Field Work_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
      "count": 1
    },
    {
      "construct": "Field Working_at is flagged `bidirectional = Staffs_Working`; Catalyst only creates the reverse column from a linked grid side, and neither Working_at nor Add_Branch.Staffs_Working is one.",
      "count": 1
    },
    {
      "construct": "Filter not migrated on report Holidays_Employee:(app identifier)",
      "count": 1
    },
    {
      "construct": "Report All_Accounts has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report All_Callbacks has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report All_Case_History has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report All_Cases has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report All_Pending_cases has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report All_Problems has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report All_Questions has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report allhardwares has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report allmachines has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report allmobiledevices has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Case_Settings_Report has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Company_Setup1 has a `customlayouts` settings block ((no properties)) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Departments_View has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report History has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Hubs_Inventory has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Manager_s_Profile has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Callbacks has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_case_History has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Company_Contacts has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Company_Projects has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_History has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Ongoing_Bookings has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Open_cases has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Pending_cases has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Profile_Customers has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Projects has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Team_Callbacks has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report My_Upcoming_Booking has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Ongoing_Bookings has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Profile has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Registered_Volunteers has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
      "count": 1
    },
    {
      "construct": "Report Sales_Rep_Details has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
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
  "noTodoApps": 1,
  "perAppConstructSets": [
    {
      "constructs": [],
      "items": 0
    },
    {
      "constructs": [
        "Browse option(s) google_docs, zoho_docs have no Catalyst equivalent; file uploads are supported from local drive only.",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Branch_Site_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Contact_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target"
      ],
      "items": 6
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
        "Field Date_field restricts selectable weekdays to `1,2,3,4,5`; the generated date input is a plain native control with no weekday restriction.",
        "Field Student_Absent_List is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Text_for_Attendance is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 21
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "client-loop-uses-server",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Company_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Inventory is flagged `bidirectional = Stocks`; Catalyst only creates the reverse column from a linked grid side, and neither Inventory nor Inventory_stateform.Stocks is one.",
        "Field Invoice_ID is flagged `bidirectional = Returned_Date`; Catalyst only creates the reverse column from a linked grid side, and neither Invoice_ID nor Add_Invoice.Returned_Date is one.",
        "Field Order_ID is flagged `bidirectional = Sales_Invoice`; Catalyst only creates the reverse column from a linked grid side, and neither Order_ID nor New_Order_Request.Sales_Invoice is one.",
        "Field Phone_Number1 is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Products_Supply is flagged `bidirectional = Vendor`; Catalyst only creates the reverse column from a linked grid side, and neither Products_Supply nor Add_Product.Vendor is one.",
        "Field Returned_Date is flagged `bidirectional = Invoice_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Returned_Date nor Return_Product.Invoice_ID is one.",
        "Field Sales_Invoice is flagged `bidirectional = Order_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Sales_Invoice nor Add_Invoice.Order_ID is one.",
        "Field Stocks is flagged `bidirectional = Inventory`; Catalyst only creates the reverse column from a linked grid side, and neither Stocks nor Add_Stock.Inventory is one.",
        "Field Vendor is flagged `bidirectional = Products_Supply`; Catalyst only creates the reverse column from a linked grid side, and neither Vendor nor Add_Vendor.Products_Supply is one.",
        "Field Warehouse_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 21
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Account is flagged `bidirectional = Contacts`; Catalyst only creates the reverse column from a linked grid side, and neither Account nor Add_Accounts.Contacts is one.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Company_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Company_Name is flagged `bidirectional = Distributors`; Catalyst only creates the reverse column from a linked grid side, and neither Company_Name nor Company_Details.Distributors is one.",
        "Field Contacts is flagged `bidirectional = Account`; Catalyst only creates the reverse column from a linked grid side, and neither Contacts nor Add_Contact.Account is one.",
        "Field Distributors is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Distributors nor Add_Distributor_Details.Company_Name is one.",
        "Field Inventory is flagged `bidirectional = Stocks`; Catalyst only creates the reverse column from a linked grid side, and neither Inventory nor Inventory_stateform.Stocks is one.",
        "Field Invoice_ID is flagged `bidirectional = Returned_Date`; Catalyst only creates the reverse column from a linked grid side, and neither Invoice_ID nor Add_Sales.Returned_Date is one.",
        "Field Order_ID is flagged `bidirectional = Sales_Invoice`; Catalyst only creates the reverse column from a linked grid side, and neither Order_ID nor New_Order_Request.Sales_Invoice is one.",
        "Field Products_Supply is flagged `bidirectional = Supplier_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Products_Supply nor Add_Product.Supplier_Name is one.",
        "Field Returned_Date is flagged `bidirectional = Invoice_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Returned_Date nor Return_Product.Invoice_ID is one.",
        "Field Sales_Invoice is flagged `bidirectional = Order_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Sales_Invoice nor Add_Sales.Order_ID is one.",
        "Field Stocks is flagged `bidirectional = Inventory`; Catalyst only creates the reverse column from a linked grid side, and neither Stocks nor Add_Stock.Inventory is one.",
        "Field Supplier_Name is flagged `bidirectional = Products_Supply`; Catalyst only creates the reverse column from a linked grid side, and neither Supplier_Name nor Add_Supplier.Products_Supply is one.",
        "Field Warehouse_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 24
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Embedded zc-component form (app identifier) has no generated view",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field No_Of_Times__Visits is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "translation-block"
      ],
      "items": 16
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Address_Parent is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Address_Student is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 28
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Shipping_To is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Site_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 14
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target"
      ],
      "items": 12
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target",
        "sendmail-attachment:view",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 24
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field From_Date restricts selectable weekdays to `0`; the generated date input is a plain native control with no weekday restriction.",
        "Field Jobs is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Jobs nor Add_Job.Project is one.",
        "Field Permanent_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Present_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Present_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Project is flagged `bidirectional = Jobs`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Add_Project.Jobs is one.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 26
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Associated_Contacts is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Associated_Emails is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Days is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Department is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Department nor Departments.Employees is one.",
        "Field Department is flagged `bidirectional = Manager`; Catalyst only creates the reverse column from a linked grid side, and neither Department nor Departments.Manager is one.",
        "Field Employees is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither Employees nor Employees.Department is one.",
        "Field Hours is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Manager is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither Manager nor Managers.Department is one.",
        "Field Minutes is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field msg is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Resolved_at is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Resolved_By is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Seconds is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Report All_Accounts has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report All_Callbacks has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report All_Problems has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report All_Questions has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report Case_Settings_Report has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report Departments_View has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report My_Callbacks has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report My_Profile_Customers has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report My_Team_Callbacks has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 45
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Event is flagged `bidirectional = Sub_Events`; Catalyst only creates the reverse column from a linked grid side, and neither Event nor Add_Event.Sub_Events is one.",
        "Field Sub_Events is flagged `bidirectional = Event`; Catalyst only creates the reverse column from a linked grid side, and neither Sub_Events nor Add_Sub_Event.Event is one.",
        "openurl-unsupported-target",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation-block"
      ],
      "items": 7
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Add_Branch is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Add_Branch nor Add_Branch.Company_Name is one.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Appointment_Booking_Address is flagged `bidirectional = Service`; Catalyst only creates the reverse column from a linked grid side, and neither Appointment_Booking_Address nor Appointment_Booking.Service is one.",
        "Field Appointment_Booking_Booking_Id is flagged `bidirectional = Staff_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Appointment_Booking_Booking_Id nor Appointment_Booking.Staff_Name is one.",
        "Field Branch_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Branches is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither Branches nor Add_Branch.Services is one.",
        "Field Company_Name is flagged `bidirectional = Add_Branch`; Catalyst only creates the reverse column from a linked grid side, and neither Company_Name nor Setup.Add_Branch is one.",
        "Field Company_Name is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither Company_Name nor Setup.Services is one.",
        "Field Company_Name is flagged `bidirectional = Staff_Names`; Catalyst only creates the reverse column from a linked grid side, and neither Company_Name nor Setup.Staff_Names is one.",
        "Field Customer_Stats_ID is flagged `bidirectional = Previous_Bookings`; Catalyst only creates the reverse column from a linked grid side, and neither Customer_Stats_ID nor Add_Customer.Previous_Bookings is one.",
        "Field Previous_Bookings is flagged `bidirectional = Customer_Stats_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Previous_Bookings nor Appointment_Booking.Customer_Stats_ID is one.",
        "Field Service is flagged `bidirectional = Appointment_Booking_Address`; Catalyst only creates the reverse column from a linked grid side, and neither Service nor Add_Services.Appointment_Booking_Address is one.",
        "Field Services is flagged `bidirectional = Branches`; Catalyst only creates the reverse column from a linked grid side, and neither Services nor Add_Services.Branches is one.",
        "Field Services is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Services nor Add_Services.Company_Name is one.",
        "Field Services is flagged `bidirectional = Staffs`; Catalyst only creates the reverse column from a linked grid side, and neither Services nor Add_Services.Staffs is one.",
        "Field Staff_Name is flagged `bidirectional = Appointment_Booking_Booking_Id`; Catalyst only creates the reverse column from a linked grid side, and neither Staff_Name nor Add_Staffs.Appointment_Booking_Booking_Id is one.",
        "Field Staff_Names is flagged `bidirectional = Company_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Staff_Names nor Add_Staffs.Company_Name is one.",
        "Field Staffs is flagged `bidirectional = Services`; Catalyst only creates the reverse column from a linked grid side, and neither Staffs nor Add_Staffs.Services is one.",
        "Field Staffs_Working is flagged `bidirectional = Working_at`; Catalyst only creates the reverse column from a linked grid side, and neither Staffs_Working nor Add_Staffs.Working_at is one.",
        "Field Working_at is flagged `bidirectional = Staffs_Working`; Catalyst only creates the reverse column from a linked grid side, and neither Working_at nor Add_Branch.Staffs_Working is one.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "translation-block"
      ],
      "items": 30
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Event_Name is flagged `bidirectional = Registered_Volunteers`; Catalyst only creates the reverse column from a linked grid side, and neither Event_Name nor Create_Event.Registered_Volunteers is one.",
        "Field Founder_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Organisation_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Registered_Volunteers is flagged `bidirectional = Event_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Registered_Volunteers nor Event_Registration.Event_Name is one.",
        "Field Venue_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Report Registered_Volunteers has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field Access_Hub is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Access_Hubs is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Delivery_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Employee_Emails is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Employees_Employee_Name is flagged `bidirectional = Service_Locations_Hub`; Catalyst only creates the reverse column from a linked grid side, and neither Employees_Employee_Name nor Employees.Service_Locations_Hub is one.",
        "Field Service_Locations_Hub is flagged `bidirectional = Employees_Employee_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Service_Locations_Hub nor Service_Locations_Hubs.Employees_Employee_Name is one.",
        "Field Third_Party_Carriers_Contracted_Carrier_Name is flagged `bidirectional = Vehicle_No`; Catalyst only creates the reverse column from a linked grid side, and neither Third_Party_Carriers_Contracted_Carrier_Name nor Third_Party_Carriers.Vehicle_No is one.",
        "Field Vehicle_No is flagged `bidirectional = Third_Party_Carriers_Contracted_Carrier_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Vehicle_No nor Truck_Details.Third_Party_Carriers_Contracted_Carrier_Name is one.",
        "Report Hubs_Inventory has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)"
      ],
      "items": 25
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Department is flagged `bidirectional = Start_New_Admission_Course_Admission_Id`; Catalyst only creates the reverse column from a linked grid side, and neither Department nor Add_Department.Start_New_Admission_Course_Admission_Id is one.",
        "Field Schedule_Assessment_Batch_Number is flagged `bidirectional = Select_Applications`; Catalyst only creates the reverse column from a linked grid side, and neither Schedule_Assessment_Batch_Number nor Schedule_Assessment.Select_Applications is one.",
        "Field Select_Applications is flagged `bidirectional = Schedule_Assessment_Batch_Number`; Catalyst only creates the reverse column from a linked grid side, and neither Select_Applications nor Fill_New_Application.Schedule_Assessment_Batch_Number is one.",
        "Field Start_New_Admission_Course_Admission_Id is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither Start_New_Admission_Course_Admission_Id nor Start_New_Admission.Department is one.",
        "Field Venue is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "pushnotification"
      ],
      "items": 10
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 8
    },
    {
      "constructs": [
        "client-condition-uses-server",
        "Field Assignees_Admin is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field From_Date restricts selectable weekdays to `0`; the generated date input is a plain native control with no weekday restriction.",
        "Field Jobs is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Jobs nor Add_Job.Project is one.",
        "Field Project is flagged `bidirectional = Jobs`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Add_Project.Jobs is one.",
        "Field To_Date restricts selectable weekdays to `6`; the generated date input is a plain native control with no weekday restriction.",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 18
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
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Address is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Approver is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Company_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Company_Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Mail_Id is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Mail_ID is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Main_Contact_Person is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Mobile_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "ZML <button> (app identifier) click parameters (app identifier) are not generated; wire them to the click handler by hand"
      ],
      "items": 28
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Company is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Company nor Company.Project is one.",
        "Field Issues is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Issues nor Issues.Project is one.",
        "Field Manager is flagged `bidirectional = Project`; Catalyst only creates the reverse column from a linked grid side, and neither Manager nor Manager.Project is one.",
        "Field Managers_Name is flagged `bidirectional = Reporting_Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Managers_Name nor Manager.Reporting_Employees is one.",
        "Field Project is flagged `bidirectional = Company`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Project.Company is one.",
        "Field Project is flagged `bidirectional = Issues`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Project.Issues is one.",
        "Field Project is flagged `bidirectional = Manager`; Catalyst only creates the reverse column from a linked grid side, and neither Project nor Project.Manager is one.",
        "Field Related_Employee is flagged `bidirectional = Related_Manager`; Catalyst only creates the reverse column from a linked grid side, and neither Related_Employee nor Employee.Related_Manager is one.",
        "Field Related_Manager is flagged `bidirectional = Related_Employee`; Catalyst only creates the reverse column from a linked grid side, and neither Related_Manager nor Manager.Related_Employee is one.",
        "Field Reporting_Employees is flagged `bidirectional = Managers_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Reporting_Employees nor Employee.Managers_Name is one.",
        "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Report Manager_s_Profile has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.",
        "Report My_Company_Contacts has a `permission` settings block (add = true, edit = true) that Catalyst generates no equivalent for.",
        "Report My_Company_Projects has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.",
        "Report My_Projects has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
        "Report Profile has a `permission` settings block (edit = true) that Catalyst generates no equivalent for.",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 80
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Event is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Feed_back is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target",
        "Toolbar setting is not carried; the generated editor has no toolbar control.",
        "translation-block"
      ],
      "items": 12
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Block_Details_Master_ID is flagged `bidirectional = Project_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Block_Details_Master_ID nor Add_Block_Detail.Project_Name is one.",
        "Field Flats_Apartments_Master_ID is flagged `bidirectional = Project_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Flats_Apartments_Master_ID nor Add_Flats_Apartments_Shop_Details.Project_Name is one.",
        "Field Location1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Project_Name is flagged `bidirectional = Block_Details_Master_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Project_Name nor Add_Project.Block_Details_Master_ID is one.",
        "Field Project_Name is flagged `bidirectional = Flats_Apartments_Master_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Project_Name nor Add_Project.Flats_Apartments_Master_ID is one.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "translation-block"
      ],
      "items": 26
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Created_Quotation is flagged `bidirectional = Quotation_Request_Number`; Catalyst only creates the reverse column from a linked grid side, and neither Created_Quotation nor Create_Quotation.Quotation_Request_Number is one.",
        "Field Quotation_Request_Number is flagged `bidirectional = Created_Quotation`; Catalyst only creates the reverse column from a linked grid side, and neither Quotation_Request_Number nor Request_Quotation.Created_Quotation is one.",
        "openurl-unsupported-target",
        "translation-block"
      ],
      "items": 8
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Customer_Review is flagged `bidirectional = Order_Number`; Catalyst only creates the reverse column from a linked grid side, and neither Customer_Review nor Add_Review.Order_Number is one.",
        "Field Order_Number is flagged `bidirectional = Customer_Review`; Catalyst only creates the reverse column from a linked grid side, and neither Order_Number nor New_Order.Customer_Review is one.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 10
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Assigned_Tasks is flagged `bidirectional = Assigned_to`; Catalyst only creates the reverse column from a linked grid side, and neither Assigned_Tasks nor Raise_a_Complaint.Assigned_to is one.",
        "Field Assigned_to is flagged `bidirectional = Assigned_Tasks`; Catalyst only creates the reverse column from a linked grid side, and neither Assigned_to nor Add_Staff.Assigned_Tasks is one.",
        "Field Block is flagged `bidirectional = Floors`; Catalyst only creates the reverse column from a linked grid side, and neither Block nor Add_Block.Floors is one.",
        "Field Blocks is flagged `bidirectional = Property_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Blocks nor Add_Block.Property_Name is one.",
        "Field Complaint_IDs is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Complaint_IDs nor Raise_a_Complaint.Unit_Name is one.",
        "Field Current_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Floors is flagged `bidirectional = Block`; Catalyst only creates the reverse column from a linked grid side, and neither Floors nor Add_Floor.Block is one.",
        "Field Manager_Email is flagged `bidirectional = Managing_Units`; Catalyst only creates the reverse column from a linked grid side, and neither Manager_Email nor Add_Managers.Managing_Units is one.",
        "Field Managing_Units is flagged `bidirectional = Manager_Email`; Catalyst only creates the reverse column from a linked grid side, and neither Managing_Units nor Add_Unit_Details.Manager_Email is one.",
        "Field Owner_Email is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Owner_Email nor Add_Owner.Unit_Name is one.",
        "Field Policies is flagged `bidirectional = Property_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Policies nor Add_Policy.Property_Name is one.",
        "Field Property_Name is flagged `bidirectional = Blocks`; Catalyst only creates the reverse column from a linked grid side, and neither Property_Name nor Add_Property.Blocks is one.",
        "Field Property_Name is flagged `bidirectional = Policies`; Catalyst only creates the reverse column from a linked grid side, and neither Property_Name nor Add_Property.Policies is one.",
        "Field Tenant_Name is flagged `bidirectional = Unit_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Tenant_Name nor Add_Tenant_Details.Unit_Name is one.",
        "Field Unit_Name is flagged `bidirectional = Complaint_IDs`; Catalyst only creates the reverse column from a linked grid side, and neither Unit_Name nor Add_Unit_Details.Complaint_IDs is one.",
        "Field Unit_Name is flagged `bidirectional = Owner_Email`; Catalyst only creates the reverse column from a linked grid side, and neither Unit_Name nor Add_Unit_Details.Owner_Email is one.",
        "Field Unit_Name is flagged `bidirectional = Tenant_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Unit_Name nor Add_Unit_Details.Tenant_Name is one.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 26
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Course is flagged `bidirectional = Tutoring_Requests`; Catalyst only creates the reverse column from a linked grid side, and neither Course nor Add_Course.Tutoring_Requests is one.",
        "Field Tutoring_Requests is flagged `bidirectional = Course`; Catalyst only creates the reverse column from a linked grid side, and neither Tutoring_Requests nor Tutoring_Request.Course is one.",
        "openurl-unsupported-target",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 14
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Court_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target",
        "Report All_Case_History has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report All_Cases has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report All_Pending_cases has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report My_case_History has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report My_Open_cases has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report My_Pending_cases has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 15
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Delivery_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Pickup_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Subscription_Id is flagged `bidirectional = Transactions`; Catalyst only creates the reverse column from a linked grid side, and neither Subscription_Id nor Add_New_Subscription.Transactions is one.",
        "Field Transactions is flagged `bidirectional = Subscription_Id`; Catalyst only creates the reverse column from a linked grid side, and neither Transactions nor Add_Transaction.Subscription_Id is one.",
        "openurl-unsupported-target",
        "pushnotification",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 13
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Advance_Payments is flagged `bidirectional = Link_Advance_To`; Catalyst only creates the reverse column from a linked grid side, and neither Advance_Payments nor Add_Advance.Link_Advance_To is one.",
        "Field Link_Advance_To is flagged `bidirectional = Advance_Payments`; Catalyst only creates the reverse column from a linked grid side, and neither Link_Advance_To nor Add_Report.Advance_Payments is one.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 8
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Branch_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Buildings is flagged `bidirectional = Select_Floors`; Catalyst only creates the reverse column from a linked grid side, and neither Buildings nor Add_Building.Select_Floors is one.",
        "Field Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Phone_Number is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Select_Floors is flagged `bidirectional = Buildings`; Catalyst only creates the reverse column from a linked grid side, and neither Select_Floors nor Add_Floor.Buildings is one.",
        "Field Signature is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "openurl-unsupported-target"
      ],
      "items": 17
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Permananet_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Present_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target"
      ],
      "items": 7
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "Field Return_Products_Details is flagged `bidirectional = Sales_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Return_Products_Details nor Return_Product.Sales_ID is one.",
        "Field Sales_ID is flagged `bidirectional = Return_Products_Details`; Catalyst only creates the reverse column from a linked grid side, and neither Sales_ID nor Add_Sales.Return_Products_Details is one.",
        "Field Warehouse_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Warehouse_Code is flagged `bidirectional = Warehouse_Incharge`; Catalyst only creates the reverse column from a linked grid side, and neither Warehouse_Code nor Add_Warehouse.Warehouse_Incharge is one.",
        "Field Warehouse_Incharge is flagged `bidirectional = Warehouse_Code`; Catalyst only creates the reverse column from a linked grid side, and neither Warehouse_Incharge nor Add_Staffs.Warehouse_Code is one.",
        "openurl-unsupported-target",
        "translation-block"
      ],
      "items": 8
    },
    {
      "constructs": [
        "Custom action (app identifier) is not migrated; its button is turned off.",
        "openurl-unsupported-target",
        "Report allhardwares has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
        "Report allmachines has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
        "Report allmobiledevices has a `permission` settings block (add = true) that Catalyst generates no equivalent for.",
        "translation-block"
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
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude."
      ],
      "items": 4
    },
    {
      "constructs": [
        "Default row count is not carried; the generated subform starts with no pre-filled rows.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Purchased_amount_till_now is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
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
        "Field Account_Name is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Account_Name nor Create_Accounts.Create_Opportunity_Opportunity_Name is one.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Billing_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Contact_Name is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Contact_Name nor Create_Contact.Create_Opportunity_Opportunity_Name is one.",
        "Field Create_Opportunity_Opportunity_Name is flagged `bidirectional = Account_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Create_Opportunity_Opportunity_Name nor Create_Opportunity.Account_Name is one.",
        "Field Create_Opportunity_Opportunity_Name is flagged `bidirectional = Contact_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Create_Opportunity_Opportunity_Name nor Create_Opportunity.Contact_Name is one.",
        "Field Create_Opportunity_Opportunity_Name is flagged `bidirectional = Lead_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Create_Opportunity_Opportunity_Name nor Create_Opportunity.Lead_Name is one.",
        "Field Lead_Name is flagged `bidirectional = Create_Opportunity_Opportunity_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Lead_Name nor Create_Lead.Create_Opportunity_Opportunity_Name is one.",
        "Field Mailing_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Organization_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Shipping_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 35
    },
    {
      "constructs": [
        "Field Account_Name is flagged `bidirectional = Lead`; Catalyst only creates the reverse column from a linked grid side, and neither Account_Name nor New_Account.Lead is one.",
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Billing_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Lead is flagged `bidirectional = Account_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Lead nor New_Lead.Account_Name is one.",
        "Field Shipping_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Report Sales_Rep_Details has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for."
      ],
      "items": 8
    },
    {
      "constructs": [
        "Field Add_Customer_First_Name is flagged `bidirectional = Book_Free_Events_Rec_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Add_Customer_First_Name nor Add_Customer.Book_Free_Events_Rec_ID is one.",
        "Field Add_Customer_First_Name is flagged `bidirectional = Book_Paid_Event_Rec_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Add_Customer_First_Name nor Add_Customer.Book_Paid_Event_Rec_ID is one.",
        "Field Book_Free_Events_Rec_ID is flagged `bidirectional = Add_Customer_First_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Book_Free_Events_Rec_ID nor Book_Free_Events1.Add_Customer_First_Name is one.",
        "Field Book_Paid_Event_Rec_ID is flagged `bidirectional = Add_Customer_First_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Book_Paid_Event_Rec_ID nor Book_Paid_Events.Add_Customer_First_Name is one.",
        "Field Location is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "function-untranslated",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "translation-block"
      ],
      "items": 12
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude."
      ],
      "items": 2
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Assign_to is flagged `bidirectional = Assigned_Tickets`; Catalyst only creates the reverse column from a linked grid side, and neither Assign_to nor Add_Staffs.Assigned_Tickets is one.",
        "Field Assigned_Tickets is flagged `bidirectional = Assign_to`; Catalyst only creates the reverse column from a linked grid side, and neither Assigned_Tickets nor Complaint_Registration.Assign_to is one.",
        "Field Complaint_ID is flagged `bidirectional = Status_updates`; Catalyst only creates the reverse column from a linked grid side, and neither Complaint_ID nor Complaint_Registration.Status_updates is one.",
        "Field Firm_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Firm_Name is flagged `bidirectional = Staffs`; Catalyst only creates the reverse column from a linked grid side, and neither Firm_Name nor Add_Admin_Details.Staffs is one.",
        "Field Staffs is flagged `bidirectional = Firm_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Staffs nor Add_Staffs.Firm_Name is one.",
        "Field Status_updates is flagged `bidirectional = Complaint_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Status_updates nor Status_Update.Complaint_ID is one.",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 11
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Borrower_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Category is flagged `bidirectional = Sub_Category`; Catalyst only creates the reverse column from a linked grid side, and neither Category nor New_Category.Sub_Category is one.",
        "Field Invoice_Number is flagged `bidirectional = Rental_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Invoice_Number nor Add_Invoice.Rental_ID is one.",
        "Field Owner is flagged `bidirectional = Products`; Catalyst only creates the reverse column from a linked grid side, and neither Owner nor Add_User.Products is one.",
        "Field Owner_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Products is flagged `bidirectional = Owner`; Catalyst only creates the reverse column from a linked grid side, and neither Products nor Add_Product.Owner is one.",
        "Field Rental_ID is flagged `bidirectional = Invoice_Number`; Catalyst only creates the reverse column from a linked grid side, and neither Rental_ID nor Hire_Request.Invoice_Number is one.",
        "Field Sub_Category is flagged `bidirectional = Category`; Catalyst only creates the reverse column from a linked grid side, and neither Sub_Category nor New_Sub_Category.Category is one.",
        "Field Verified_User is flagged `private = true`; Catalyst generates no privacy or access control for this field."
      ],
      "items": 10
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Branch is flagged `bidirectional = Raise_New_Crisis_Crisis_Name`; Catalyst only creates the reverse column from a linked grid side, and neither Branch nor Add_Branch.Raise_New_Crisis_Crisis_Name is one.",
        "Field Raise_New_Crisis_Crisis_Name is flagged `bidirectional = Branch`; Catalyst only creates the reverse column from a linked grid side, and neither Raise_New_Crisis_Crisis_Name nor Raise_New_Crisis.Branch is one.",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Class_Trainer is flagged `bidirectional = Classes`; Catalyst only creates the reverse column from a linked grid side, and neither Class_Trainer nor Add_Staff_Trainer.Classes is one.",
        "Field Classes is flagged `bidirectional = Class_Trainer`; Catalyst only creates the reverse column from a linked grid side, and neither Classes nor Add_Class.Class_Trainer is one.",
        "Field Classes is flagged `bidirectional = Trainees`; Catalyst only creates the reverse column from a linked grid side, and neither Classes nor Add_Class.Trainees is one.",
        "Field Gym_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Trainees is flagged `bidirectional = Classes`; Catalyst only creates the reverse column from a linked grid side, and neither Trainees nor Add_Trainee.Classes is one."
      ],
      "items": 6
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Department is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Department nor Add_Department.Employees is one.",
        "Field Designation is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Designation nor Add_Designation.Employees is one.",
        "Field Employees is flagged `bidirectional = Department`; Catalyst only creates the reverse column from a linked grid side, and neither Employees nor Add_Employee.Department is one.",
        "Field Employees is flagged `bidirectional = Designation`; Catalyst only creates the reverse column from a linked grid side, and neither Employees nor Add_Employee.Designation is one.",
        "Field Employees is flagged `bidirectional = Location`; Catalyst only creates the reverse column from a linked grid side, and neither Employees nor Add_Employee.Location is one.",
        "Field Location is flagged `bidirectional = Employees`; Catalyst only creates the reverse column from a linked grid side, and neither Location nor Add_Location.Employees is one.",
        "Filter not migrated on report Holidays_Employee:(app identifier)",
        "report-criteria",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 13
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Driver is flagged `bidirectional = Driver_For`; Catalyst only creates the reverse column from a linked grid side, and neither Driver nor Add_User.Driver_For is one.",
        "Field Driver_For is flagged `bidirectional = Driver`; Catalyst only creates the reverse column from a linked grid side, and neither Driver_For nor Add_Vehicle.Driver is one.",
        "Field Owned_Vehicles is flagged `bidirectional = Owner`; Catalyst only creates the reverse column from a linked grid side, and neither Owned_Vehicles nor Add_Vehicle.Owner is one.",
        "Field Owner is flagged `bidirectional = Owned_Vehicles`; Catalyst only creates the reverse column from a linked grid side, and neither Owner nor Add_User.Owned_Vehicles is one.",
        "Field Resolved_Issues is flagged `bidirectional = Service_ID`; Catalyst only creates the reverse column from a linked grid side, and neither Resolved_Issues nor Add_Issue.Service_ID is one.",
        "Field Service_ID is flagged `bidirectional = Resolved_Issues`; Catalyst only creates the reverse column from a linked grid side, and neither Service_ID nor Service_Entry.Resolved_Issues is one.",
        "function-untranslated",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 11
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Location is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Status is flagged `private = true`; Catalyst generates no privacy or access control for this field.",
        "Report History has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report My_History has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report My_Ongoing_Bookings has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report My_Upcoming_Booking has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for.",
        "Report Ongoing_Bookings has a `properties` settings block (display record count = true) that Catalyst generates no equivalent for."
      ],
      "items": 8
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Location is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "pushnotification",
        "translation-block"
      ],
      "items": 4
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Permanent_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Present_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude."
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "openurl-unsupported-target",
        "Server-side Deluge snippet requires manual translation",
        "Static <style> CSS not carried over:(app identifier)",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 5
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "pushnotification",
        "translation-block"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "report-conditional-format",
        "Server-side Deluge snippet requires manual translation"
      ],
      "items": 7
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Server-side Deluge snippet requires manual translation",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 5
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 2
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "translation-block"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "translation-block",
        "ZML <image> (app identifier) click action Function calling function Vote.upvote is not generated; wire the click to the function by hand"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field Admin_Email is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field BOM is flagged `bidirectional = Production_Batch`; Catalyst only creates the reverse column from a linked grid side, and neither BOM nor Create_BOM.Production_Batch is one.",
        "Field Mail_ID is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Name is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Phone is flagged `personal data = true`; Catalyst generates no privacy or access control for this field.",
        "Field Production_Batch is flagged `bidirectional = BOM`; Catalyst only creates the reverse column from a linked grid side, and neither Production_Batch nor Add_Production_Batch.BOM is one.",
        "Report Company_Setup1 has a `customlayouts` settings block ((no properties)) that Catalyst generates no equivalent for."
      ],
      "items": 9
    },
    {
      "constructs": [
        "Field Class is flagged `bidirectional = Students`; Catalyst only creates the reverse column from a linked grid side, and neither Class nor Add_Class.Students is one.",
        "Field Students is flagged `bidirectional = Class`; Catalyst only creates the reverse column from a linked grid side, and neither Students nor Add_Student.Class is one."
      ],
      "items": 2
    },
    {
      "constructs": [
        "Field Company_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Server-side Deluge snippet requires manual translation",
        "translation-block"
      ],
      "items": 5
    },
    {
      "constructs": [
        "Field Deals_with is flagged `bidirectional = Vendors`; Catalyst only creates the reverse column from a linked grid side, and neither Deals_with nor Add_Product.Vendors is one.",
        "Field Vendors is flagged `bidirectional = Deals_with`; Catalyst only creates the reverse column from a linked grid side, and neither Vendors nor Add_Vendor.Deals_with is one."
      ],
      "items": 2
    },
    {
      "constructs": [
        "Field Home_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "Field Work_Address1 is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "translation-block"
      ],
      "items": 3
    },
    {
      "constructs": [
        "Field Organization_Address is flagged `capture_coordinates = true`; the generated address field has no device-location pin or stored latitude/longitude.",
        "pushnotification",
        "translation-block"
      ],
      "items": 3
    },
    {
      "constructs": [
        "function-untranslated",
        "Toolbar setting is not carried; the generated editor has no toolbar control."
      ],
      "items": 3
    }
  ],
  "silentDropKinds": [
    {
      "construct": "field-property",
      "count": 139
    },
    {
      "construct": "page-element",
      "count": 49
    },
    {
      "construct": "translation",
      "count": 41
    },
    {
      "construct": "report-feature",
      "count": 32
    }
  ],
  "silentDropTotal": 261,
  "todoTotal": 841,
  "totalApps": 67
}
```
