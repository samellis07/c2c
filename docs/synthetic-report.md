# Per-app migration report (synthetic)

Source: the synthetic fixture directory (34 apps).
Plan data centre: in. Rows are numbered in corpus path order and name no app.

Columns: compiles is the static gate over the generated tree (yes/no);
manual items are the precheck findings and analyze blockers grouped by severity and check;
unresolved TODOs are the analyze residual with per-construct counts;
plan errors are the first line of each failing stage (parse, quality, ui, plan, deploy), or none;
verdict is migrates (deterministic, no manual blocker, every offline stage clean),
manual-items (lists what stays manual), or FAIL (neither).

apps 34  migrates 9  manual-items 25  FAIL 0  compiles-yes 33  todos 166

| n | compiles | manual items | unresolved TODOs | plan errors | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | yes | none | 0 | none | migrates |
| 2 | yes | 1 blocker workflow PO_Success:4; 1 blocker workflow PO_Validate:20; 1 blocker workflow PO_Validate:22; 3 warning converter-gap; 1 warning table-name-length-unverified | 3 (3 client-condition-uses-server) | none | manual-items |
| 3 | yes | 1 blocker page PO_Dashboard.dsp; 1 blocker workflow PO_Success:4; 1 blocker workflow PO_Validate:20; 1 blocker workflow PO_Validate:22; 3 warning converter-gap; 1 warning table-name-length-unverified | 4 (3 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 4 | yes | 1 blocker page PO_Dashboard.dsp; 1 blocker sendmail-sender; 1 blocker workflow PO_Success:4; 1 blocker workflow PO_Validate:20; 1 blocker workflow PO_Validate:22; 3 warning converter-gap; 1 warning table-name-length-unverified | 4 (3 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 5 | yes | 1 blocker page PO_Dashboard.dsp; 1 blocker success-message; 1 blocker workflow PO_Success:4; 1 blocker workflow PO_Validate:20; 1 blocker workflow PO_Validate:22; 3 warning converter-gap; 1 warning table-name-length-unverified | 4 (3 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 6 | yes | 1 blocker page PO_Dashboard.dsp; 1 blocker signature; 1 blocker workflow PO_Success:4; 1 blocker workflow PO_Validate:20; 1 blocker workflow PO_Validate:22; 3 warning converter-gap; 1 warning table-name-length-unverified | 4 (3 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 7 | yes | 1 blocker page PO_Dashboard.dsp; 1 blocker workflow PO_Success:4; 1 blocker workflow PO_Validate:20; 1 blocker workflow PO_Validate:22; 1 warning approver-on-success; 3 warning converter-gap; 1 warning table-name-length-unverified | 4 (3 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 8 | yes | 1 blocker page PO_Dashboard.dsp; 1 blocker workflow PO_Success:4; 1 blocker workflow PO_Validate:20; 1 blocker workflow PO_Validate:22; 3 warning converter-gap; 1 warning table-name-length-unverified | 4 (3 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 9 | yes | none | 0 | none | migrates |
| 10 | yes | 1 blocker workflow Visit_Success:2; 1 warning converter-gap | 1 (1 client-condition-uses-server) | none | manual-items |
| 11 | yes | 1 blocker page Kiosk_Home.dsp; 1 blocker page Visitor_Badge.dsp; 1 blocker workflow Visit_Success:2; 1 warning converter-gap | 3 (2 Server-side Deluge snippet requires manual translation, 1 client-condition-uses-server) | none | manual-items |
| 12 | yes | 1 blocker non-bmp; 1 blocker page Kiosk_Home.dsp; 1 blocker page Visitor_Badge.dsp; 1 blocker workflow Visit_Success:2; 1 warning converter-gap | 3 (2 Server-side Deluge snippet requires manual translation, 1 client-condition-uses-server) | none | manual-items |
| 13 | yes | 1 blocker page Kiosk_Home.dsp; 1 blocker page Visitor_Badge.dsp; 1 blocker void-assign; 1 blocker workflow Visit_Success:2; 1 warning converter-gap | 3 (2 Server-side Deluge snippet requires manual translation, 1 client-condition-uses-server) | none | manual-items |
| 14 | no | 1 blocker page Kiosk_Home.dsp; 1 blocker page Visitor_Badge.dsp; 1 blocker undefined-variable; 1 blocker workflow Visit_Success:2; 1 blocker workflow Visit_Validate:18; 2 warning converter-gap | 4 (2 client-condition-uses-server, 2 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 15 | yes | none | 0 | none | migrates |
| 16 | yes | 1 blocker workflow App_Success:2; 1 warning converter-gap; 1 warning table-name-length-unverified | 1 (1 client-condition-uses-server) | none | manual-items |
| 17 | yes | 1 blocker page Careers.dsp; 1 blocker workflow App_Success:2; 1 blocker workflow Hiring_Process; 4 blocker workflow Hiring_Process #1; 4 blocker workflow Hiring_Process #2; 4 blocker workflow Hiring_Process #3; 4 blocker workflow Hiring_Process #4; 4 blocker workflow Hiring_Process #5; 4 blocker workflow Hiring_Process #6; 26 warning converter-gap; 1 warning table-name-length-unverified | 27 (6 blueprint-phase-property-from port, 6 blueprint-phase-property-path, 6 blueprint-phase-property-to port, 6 blueprint-stage-block-chart data, 1 blueprint-start-block-chart data, 1 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 18 | yes | 1 blocker page Careers.dsp; 1 blocker reserved-name; 1 blocker workflow App_Success:2; 1 blocker workflow Hiring_Process; 4 blocker workflow Hiring_Process #1; 4 blocker workflow Hiring_Process #2; 4 blocker workflow Hiring_Process #3; 4 blocker workflow Hiring_Process #4; 4 blocker workflow Hiring_Process #5; 4 blocker workflow Hiring_Process #6; 26 warning converter-gap; 1 warning table-name-length-unverified | 27 (6 blueprint-phase-property-from port, 6 blueprint-phase-property-path, 6 blueprint-phase-property-to port, 6 blueprint-stage-block-chart data, 1 blueprint-start-block-chart data, 1 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 19 | yes | 1 blocker criteria-multiselect; 1 blocker page Careers.dsp; 1 blocker workflow App_Success:2; 1 blocker workflow Hiring_Process; 4 blocker workflow Hiring_Process #1; 4 blocker workflow Hiring_Process #2; 4 blocker workflow Hiring_Process #3; 4 blocker workflow Hiring_Process #4; 4 blocker workflow Hiring_Process #5; 4 blocker workflow Hiring_Process #6; 26 warning converter-gap; 1 warning table-name-length-unverified | 27 (6 blueprint-phase-property-from port, 6 blueprint-phase-property-path, 6 blueprint-phase-property-to port, 6 blueprint-stage-block-chart data, 1 blueprint-start-block-chart data, 1 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 20 | yes | 1 blocker page Careers.dsp; 1 blocker workflow App_Success:2; 1 blocker workflow Hiring_Process; 4 blocker workflow Hiring_Process #1; 4 blocker workflow Hiring_Process #2; 4 blocker workflow Hiring_Process #3; 4 blocker workflow Hiring_Process #4; 4 blocker workflow Hiring_Process #5; 4 blocker workflow Hiring_Process #6; 26 warning converter-gap; 1 warning table-name-length-unverified | 27 (6 blueprint-phase-property-from port, 6 blueprint-phase-property-path, 6 blueprint-phase-property-to port, 6 blueprint-stage-block-chart data, 1 blueprint-start-block-chart data, 1 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 21 | yes | none | 0 | none | migrates |
| 22 | yes | 1 warning table-name-length-unverified | 0 | none | migrates |
| 23 | yes | 1 blocker page Inventory_Dashboard.dsp; 1 blocker workflow Stock_Adjustment_Apply:4; 1 warning converter-gap; 1 warning table-name-length-unverified | 2 (1 client-condition-uses-server, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
| 24 | yes | 1 blocker insert-comment; 1 warning table-name-length-unverified | 0 | none | manual-items |
| 25 | yes | 1 blocker legacy-getall; 1 warning table-name-length-unverified | 0 | none | manual-items |
| 26 | yes | 1 warning table-name-length-unverified | 0 | none | migrates |
| 27 | yes | 1 warning table-name-length-unverified | 0 | none | migrates |
| 28 | yes | none | 0 | none | migrates |
| 29 | yes | none | 0 | none | migrates |
| 30 | yes | 1 blocker function fs.listBooksInvoices:2; 1 blocker function fs.notifyTechnician:4; 1 blocker page Dispatch_Board.dsp; 1 blocker widget Route_Map; 2 warning converter-gap | 3 (1 method:toFile, 1 Server-side Deluge snippet requires manual translation, 1 task:resp) | none | manual-items |
| 31 | yes | 2 blocker custom-action; 1 blocker function fs.listBooksInvoices:2; 1 blocker function fs.notifyTechnician:4; 1 blocker page Dispatch_Board.dsp; 1 blocker widget Route_Map; 2 warning converter-gap | 3 (1 method:toFile, 1 Server-side Deluge snippet requires manual translation, 1 task:resp) | none | manual-items |
| 32 | yes | 1 blocker function fs.listBooksInvoices:2; 1 blocker function fs.notifyTechnician:4; 1 blocker page Dispatch_Board.dsp; 1 blocker widget Route_Map; 1 warning connection-display-name; 2 warning converter-gap | 3 (1 method:toFile, 1 Server-side Deluge snippet requires manual translation, 1 task:resp) | none | manual-items |
| 33 | yes | 1 blocker function fs.listBooksInvoices:2; 1 blocker function fs.notifyTechnician:4; 1 blocker page Dispatch_Board.dsp; 1 blocker widget Route_Map; 2 warning converter-gap | 3 (1 method:toFile, 1 Server-side Deluge snippet requires manual translation, 1 task:resp) | none | manual-items |
| 34 | yes | 1 blocker page Expense_Dashboard.dsp; 1 blocker workflow Date_Field_Schedule; 1 warning converter-gap | 2 (1 schedule-start, 1 Server-side Deluge snippet requires manual translation) | none | manual-items |
