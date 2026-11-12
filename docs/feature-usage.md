# Feature Matrix Usage Ranking

Every row of the Creator-to-Catalyst feature matrix (v4, 194 rows) ranked by how many apps use it across the 67 gallery apps and the 35 synthetic + kitchen-sink apps in the repo.

- Evaluated from the parsed IR using the committed mapping table (`scripts/feature-mapping.mjs`).
- Gallery apps evaluated: 67 (counts only, private gallery app names omitted).
- Synthetic apps evaluated: 35 (33 synthetic apps from the local fixtures directory plus the 2 kitchen-sink apps in the repo).
- Rows that cannot be observed in a `.ds` export are listed as `not detectable` with their documented reason.

## Ranked Feature Usage

| row id | title | status in matrix | gallery apps using it | synthetic apps using it |
|---|---|---|---|---|
| 1 | Single line | adapter-written | 67 | 35 |
| 32 | Section | adapter-written | 67 | 34 |
| 44 | Mandatory | adapter-written | 67 | 34 |
| 61 | Detail view | not-started | 67 | 0 |
| 143 | Roles (data hierarchy) | adapter-written | 67 | 34 |
| 144 | Profiles (feature permissions) | adapter-written | 67 | 34 |
| 156 | Localization / multi-language | not-started | 67 | 33 |
| 17 | Lookup single | adapter-written | 66 | 34 |
| 46 | Default value | adapter-written | 66 | 33 |
| 50 | Hide / show field (field rules) | adapter-written | 66 | 1 |
| 56 | System record id | adapter-written | 66 | 28 |
| 84 | Load of form | adapter-written | 66 | 24 |
| 89 | Successful form submission | adapter-written | 66 | 29 |
| 106 | if / else | adapter-written | 66 | 30 |
| 114 | fetch by criteria | adapter-written | 66 | 28 |
| 125 | thisapp.* | adapter-written | 66 | 28 |
| 3 | Email | adapter-written | 65 | 33 |
| 58 | List report | adapter-written | 65 | 34 |
| 77 | Record-level custom action | adapter-written | 65 | 1 |
| 85 | User input of a field | adapter-written | 65 | 29 |
| 13 | Dropdown | adapter-written | 64 | 34 |
| 30 | Name (composite) | adapter-written | 64 | 1 |
| 72 | Custom filter criteria | adapter-written | 64 | 29 |
| 119 | sendmail | adapter-written | 64 | 19 |
| 135 | Global Deluge function | adapter-written | 64 | 28 |
| 51 | Enable / disable field | adapter-written | 63 | 1 |
| 126 | openUrl | adapter-written | 63 | 19 |
| 45 | Unique / no duplicates | adapter-written | 62 | 34 |
| 88 | Validation on form submission | adapter-written | 62 | 30 |
| 115 | update record | adapter-written | 62 | 26 |
| 127 | alert | adapter-written | 62 | 30 |
| 2 | Multi line | adapter-written | 61 | 20 |
| 111 | Date-time and app timezone | adapter-written | 61 | 29 |
| 73 | Grouping | not-started | 60 | 0 |
| 4 | Phone | adapter-written | 58 | 27 |
| 5 | Number | adapter-written | 57 | 31 |
| 83 | Field rules | adapter-written | 57 | 1 |
| 107 | for each over a list | adapter-written | 57 | 26 |
| 9 | Date | adapter-written | 56 | 28 |
| 53 | Field-level permissions | adapter-written | 56 | 19 |
| 128 | cancel submit | adapter-written | 55 | 30 |
| 152 | Auto-generated iOS and Android apps | adapter-written | 55 | 0 |
| 14 | Radio | adapter-written | 54 | 1 |
| 137 | Page / dashboard | adapter-written | 54 | 20 |
| 31 | Address (composite) | adapter-written | 53 | 1 |
| 33 | Add notes | adapter-written | 51 | 1 |
| 139 | HTML / ZML snippet | adapter-written | 51 | 19 |
| 79 | Export (report) | not-started | 50 | 0 |
| 80 | Print (report or record) | not-started | 50 | 0 |
| 81 | Import into a report | adapter-written | 50 | 0 |
| 163 | Import data (CSV, XLS, JSON) | adapter-written | 50 | 0 |
| 19 | Subform | adapter-written | 48 | 24 |
| 22 | Image | adapter-written | 48 | 11 |
| 76 | Conditional formatting | not-started | 48 | 0 |
| 57 | Added user | adapter-written | 47 | 18 |
| 93 | Stateless form: button click | not-started | 47 | 20 |
| 18 | Lookup multi | adapter-written | 46 | 6 |
| 113 | insert record | adapter-written | 46 | 18 |
| 117 | Aggregate (sum, count, min, max, distinct) | adapter-written | 45 | 23 |
| 12 | Decision box | adapter-written | 44 | 25 |
| 91 | Validation on record deletion | not-started | 44 | 0 |
| 60 | List report, custom quick view | not-started | 40 | 0 |
| 68 | Pivot chart | not-started | 39 | 0 |
| 134 | Subform row loop (input.Subform) | adapter-written | 37 | 18 |
| 75 | Search in a report | adapter-written | 36 | 0 |
| 10 | Date-time | adapter-written | 35 | 19 |
| 94 | Schedule on a date field | not-started | 35 | 10 |
| 138 | Panel, chart, gauge, search, button on a page | adapter-written | 34 | 1 |
| 29 | Auto number | adapter-written | 32 | 29 |
| 74 | Sorting | adapter-written | 32 | 1 |
| 141 | Embed a form or report in a page | not-started | 31 | 1 |
| 8 | Currency | adapter-written | 30 | 1 |
| 86 | Addition of a subform row | adapter-written | 30 | 12 |
| 118 | for each over fetched records | adapter-written | 30 | 14 |
| 47 | Max length | adapter-written | 29 | 2 |
| 55 | System Added / Modified Time | adapter-written | 29 | 0 |
| 109 | List | adapter-written | 29 | 5 |
| 26 | URL | adapter-written | 26 | 1 |
| 116 | delete record | adapter-written | 25 | 4 |
| 78 | Bulk edit | not-started | 24 | 1 |
| 87 | Deletion of a subform row | not-started | 23 | 7 |
| 7 | Percent | adapter-written | 21 | 7 |
| 21 | File upload | adapter-written | 21 | 11 |
| 62 | Calendar | not-started | 19 | 10 |
| 6 | Decimal | adapter-written | 18 | 26 |
| 27 | Rich text | adapter-written | 17 | 1 |
| 92 | Successful record deletion | not-started | 17 | 0 |
| 146 | Customer portal | adapter-written | 15 | 15 |
| 164 | Record template / HTML print layout | not-started | 14 | 28 |
| 59 | List report, card quick view | not-started | 13 | 0 |
| 65 | Map | not-started | 13 | 0 |
| 110 | Map | adapter-written | 12 | 5 |
| 16 | Checkbox (multi) | adapter-written | 11 | 7 |
| 28 | Formula | adapter-written | 11 | 8 |
| 64 | Kanban | not-started | 11 | 8 |
| 112 | Decimal precision | adapter-written | 11 | 18 |
| 145 | Sharing / share with stakeholders | not-started | 11 | 0 |
| 90 | Update of a field | adapter-written | 10 | 0 |
| 95 | Schedule on a fixed date and time | adapter-written | 9 | 16 |
| 15 | Multi select | adapter-written | 8 | 1 |
| 130 | PDF / print task | not-started | 8 | 6 |
| 147 | Portal permission sets | adapter-written | 8 | 15 |
| 25 | Signature | adapter-written | 7 | 6 |
| 49 | Field validation (format rules) | adapter-written | 7 | 0 |
| 129 | Portal user tasks | adapter-written | 6 | 0 |
| 40 | QR / Barcode field (generated code image) | adapter-written | 5 | 6 |
| 121 | Push / in-app notification | built-in-Creator | 5 | 0 |
| 155 | Barcode / QR scan on mobile | not-started | 5 | 0 |
| 48 | Decimal places | adapter-written | 4 | 1 |
| 52 | Personal data / encrypt | adapter-written | 4 | 0 |
| 71 | Predefined filters | adapter-written | 4 | 5 |
| 122 | invokeurl | adapter-written | 4 | 11 |
| 20 | Users | adapter-written | 3 | 19 |
| 63 | Timeline | not-started | 3 | 4 |
| 24 | Video | adapter-written | 2 | 1 |
| 67 | Pivot table | not-started | 2 | 0 |
| 97 | Approval (multi-level) | adapter-written | 1 | 0 |
| 108 | try / catch | adapter-written | 1 | 0 |
| 120 | SMS (sendsms / twilio.sms.send etc.) | not-started | 1 | 0 |
| 140 | Widget (embedded JS app) | adapter-written | 1 | 0 |
| 11 | Time | adapter-written | 0 | 16 |
| 23 | Audio | adapter-written | 0 | 6 |
| 34 | Integration field | adapter-written | 0 | 1 |
| 35 | Prediction (Zia field) | not-started | 0 | 1 |
| 36 | Keyword extraction | adapter-written | 0 | 1 |
| 37 | Sentiment analysis | adapter-written | 0 | 1 |
| 38 | OCR (text analysis) | adapter-written | 0 | 1 |
| 39 | Object detection | adapter-written | 0 | 1 |
| 41 | Geolocation (Address geo capture / Added Location) | not a Creator feature | 0 | 1 |
| 42 | Legacy Zoho CRM field | adapter-written | 0 | 1 |
| 43 | Legacy Zoho CRM link | adapter-written | 0 | 0 |
| 66 | Spreadsheet | built-in-Creator | 0 | 6 |
| 69 | Gantt | not a Creator feature | 0 | 0 |
| 98 | Payment workflow | adapter-written | 0 | 0 |
| 99 | Payment gateway names | adapter-written | 0 | 0 |
| 100 | Batch workflow on import | built-in-Creator | 0 | 1 |
| 101 | Batch workflow on a schedule | built-in-Creator | 0 | 1 |
| 102 | Blueprint stages | adapter-written | 0 | 4 |
| 103 | Blueprint transitions (before / during / after) | adapter-written | 0 | 4 |
| 104 | Blueprint SLA / due date | not a Creator feature | 0 | 0 |
| 123 | zoho.crm.* | adapter-written | 0 | 4 |
| 124 | zoho.books.* | adapter-written | 0 | 4 |
| 131 | File tasks | built-in-Creator | 0 | 0 |
| 136 | Creator custom API (function as HTTP) | built-in-Creator | 0 | 0 |
| 148 | Accept payments from portal users | not-started | 0 | 0 |
| 153 | Mobile app customization / code-sign / MDM | not-started | 0 | 0 |
| 165 | Connections (OAuth to Zoho or third parties) | adapter-written | 0 | 4 |
| 166 | Data sources | not-started | 0 | 0 |
| 54 | Search index on a column | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 70 | Switch view | not-started | not detectable (not distinguishable in the IR) | not detectable (not distinguishable in the IR) |
| 82 | Record comments | not-started | not detectable (not in the IR) | not detectable (not in the IR) |
| 96 | Custom schedule quota | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 105 | Blueprint analytics | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 132 | Statement limit | not-started | not detectable (runtime limit, not in a .ds export) | not detectable (runtime limit, not in a .ds export) |
| 133 | Script timeout | not-started | not detectable (runtime limit, not in a .ds export) | not detectable (runtime limit, not in a .ds export) |
| 142 | Drag-and-drop form builder | not a Creator feature | not detectable (builder feature, not in a .ds export) | not detectable (builder feature, not in a .ds export) |
| 149 | Public signup | adapter-written | not detectable (portal setting, not in a .ds export) | not detectable (portal setting, not in a .ds export) |
| 150 | Social login | not-started | not detectable (portal setting, not in a .ds export) | not detectable (portal setting, not in a .ds export) |
| 151 | Hosted login page | adapter-written | not detectable (portal setting, not in a .ds export) | not detectable (portal setting, not in a .ds export) |
| 154 | Offline forms and reports | adapter-written | not detectable (device setting, not in a .ds export) | not detectable (device setting, not in a .ds export) |
| 157 | Environments: Development, Stage, Production | adapter-written | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 158 | Publish version history | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 159 | Audit trail: record edits and deletes | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 160 | Audit trail: report export and print | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 161 | Application backup (manual) | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 162 | Scheduled backup | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 167 | Custom connectors | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 168 | Email domain authentication (SPF/DKIM) | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 169 | Developer / execution logs | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 170 | APM | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 171 | Application alerts | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 172 | Metrics | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 173 | Automation testing | adapter-written | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 174 | Pipelines (CI) | not-started | not detectable (not in a .ds export) | not detectable (not in a .ds export) |
| 175 | Node.js runtime | adapter-written | not detectable (Catalyst-side, not a Creator feature) | not detectable (Catalyst-side, not a Creator feature) |
| 176 | Hosting a web client | adapter-written | not detectable (Catalyst-side, not a Creator feature) | not detectable (Catalyst-side, not a Creator feature) |
| 177 | AppSail (long-running Node) | not-started | not detectable (Catalyst-side, not a Creator feature) | not detectable (Catalyst-side, not a Creator feature) |
| 178 | Cache | not-started | not detectable (Catalyst-side, not a Creator feature) | not detectable (Catalyst-side, not a Creator feature) |
| 179 | NoSQL document store | not-started | not detectable (Catalyst-side, not a Creator feature) | not detectable (Catalyst-side, not a Creator feature) |
| 180 | IaC project template | adapter-written | not detectable (Catalyst-side, not a Creator feature) | not detectable (Catalyst-side, not a Creator feature) |
| 181 | Multi-DC (IN versus US) | not-started | not detectable (account setting, not in a .ds export) | not detectable (account setting, not in a .ds export) |
| 182 | SAML 2.0 / IdP Single Sign-On (SSO) | not-started | not detectable (account/IdP SAML configuration, not in a .ds export) | not detectable (account/IdP SAML configuration, not in a .ds export) |
| 183 | Solutions Workspace: Integration Flows & RPA | not-started | not detectable (Enterprise solutions workspace, not in a .ds export) | not detectable (Enterprise solutions workspace, not in a .ds export) |
| 184 | Org-Level Microservices | built-in-Creator | not detectable (org-level microservices setting, not in a .ds export) | not detectable (org-level microservices setting, not in a .ds export) |
| 185 | User Management & Provisioning | adapter-written | not detectable (account user provisioning, not in a .ds export) | not detectable (account user provisioning, not in a .ds export) |
| 186 | AI agents (AI Modeler) | not-started | not detectable (AI modeler workspace setting, not in a .ds export) | not detectable (AI modeler workspace setting, not in a .ds export) |
| 187 | Create application by importing a .ds export | built-in-Creator | not detectable (application import flow, not in a .ds export) | not detectable (application import flow, not in a .ds export) |
| 188 | Billing and subscriptions | not-started | not detectable (account billing setting, not in a .ds export) | not detectable (account billing setting, not in a .ds export) |
| 189 | Governance: password policy, multi-factor authentication, Active Directory | not-started | not detectable (org governance setting, not in a .ds export) | not detectable (org governance setting, not in a .ds export) |
| 190 | Organization settings and org-level administration | not-started | not detectable (org administration console, not in a .ds export) | not detectable (org administration console, not in a .ds export) |
| 191 | Mobile SDK (native app development) | not-started | not detectable (external mobile SDK, not in a .ds export) | not detectable (external mobile SDK, not in a .ds export) |
| 192 | Creator product limitations (documentation section) | not a Creator feature | not detectable (documentation section only, not a Creator feature) | not detectable (documentation section only, not a Creator feature) |
| 193 | Getting started (documentation section) | not a Creator feature | not detectable (documentation section only, not a Creator feature) | not detectable (documentation section only, not a Creator feature) |
| 194 | Post-creation application setup | not-started | not detectable (post-creation application setup flow, not in a .ds export) | not detectable (post-creation application setup flow, not in a .ds export) |
