# Per-app migration report (synthetic)

Source: the synthetic fixture directory (34 apps).
Plan data centre: <dc>. Rows are numbered in corpus path order and name no app.

Columns: compiles is the static gate over the generated tree (yes/no);
manual items are the precheck findings and widget packages grouped by severity and check;
unresolved TODOs are the analyze residual with per-construct counts;
plan errors are the first line of each failing stage (parse, quality, ui, plan, deploy), or none;
verdict is migrates (deterministic, no manual blocker, every offline stage clean),
manual-items (lists what stays manual), or FAIL (neither).

apps 34  migrates 15  manual-items 19  FAIL 0  compiles-yes 33  todos 22

| n | compiles | manual items | unresolved TODOs | plan errors | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | yes | none | 0 | none | migrates |
| 2 | yes | none | 0 | none | migrates |
| 3 | yes | 2 warning converter-gap | 2 (2 sendmail-attachment:template) | none | manual-items |
| 4 | yes | 1 blocker sendmail-sender; 2 warning converter-gap | 2 (2 sendmail-attachment:template) | none | manual-items |
| 5 | yes | 1 blocker success-message; 2 warning converter-gap | 2 (2 sendmail-attachment:template) | none | manual-items |
| 6 | yes | 1 blocker signature; 2 warning converter-gap | 2 (2 sendmail-attachment:template) | none | manual-items |
| 7 | yes | 1 warning approver-on-success; 2 warning converter-gap | 2 (2 sendmail-attachment:template) | none | manual-items |
| 8 | yes | 2 warning converter-gap | 2 (2 sendmail-attachment:template) | none | manual-items |
| 9 | yes | none | 0 | none | migrates |
| 10 | yes | none | 0 | none | migrates |
| 11 | yes | none | 0 | none | migrates |
| 12 | yes | 1 blocker non-bmp | 0 | none | manual-items |
| 13 | yes | 1 blocker void-assign | 0 | none | manual-items |
| 14 | no | 1 blocker undefined-variable | 0 | none | manual-items |
| 15 | yes | none | 0 | none | migrates |
| 16 | yes | none | 0 | none | migrates |
| 17 | yes | none | 0 | none | migrates |
| 18 | yes | 1 blocker reserved-name | 0 | none | manual-items |
| 19 | yes | 1 blocker criteria-multiselect | 0 | none | manual-items |
| 20 | yes | none | 0 | none | migrates |
| 21 | yes | none | 0 | none | migrates |
| 22 | yes | none | 0 | none | migrates |
| 23 | yes | 1 warning converter-gap | 1 (1 client-condition-uses-server) | none | manual-items |
| 24 | yes | 1 blocker insert-comment | 0 | none | manual-items |
| 25 | yes | 1 blocker legacy-getall | 0 | none | manual-items |
| 26 | yes | none | 0 | none | migrates |
| 27 | yes | none | 0 | none | migrates |
| 28 | yes | none | 0 | none | migrates |
| 29 | yes | none | 0 | none | migrates |
| 30 | yes | 1 blocker widget Route_Map; 2 warning converter-gap | 2 (1 method:toFile, 1 task:resp) | none | manual-items |
| 31 | yes | 2 blocker custom-action; 1 blocker widget Route_Map; 2 warning converter-gap | 2 (1 method:toFile, 1 task:resp) | none | manual-items |
| 32 | yes | 1 blocker widget Route_Map; 2 warning converter-gap | 2 (1 method:toFile, 1 task:resp) | none | manual-items |
| 33 | yes | 1 blocker widget Route_Map; 2 warning converter-gap | 2 (1 method:toFile, 1 task:resp) | none | manual-items |
| 34 | yes | 1 warning converter-gap | 1 (1 schedule-start) | none | manual-items |
