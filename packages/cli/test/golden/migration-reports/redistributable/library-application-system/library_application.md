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

## TODO counts

6

- 1 Custom action "Group By  Member." is not migrated; its button is turned off.
- 1 Custom action "Mark as Featured" is not migrated; its button is turned off.
- 1 Custom action "Mark as Lost" is not migrated; its button is turned off.
- 1 Custom action "Overdue Books Report" is not migrated; its button is turned off.
- 1 Custom action "Overdue Books" is not migrated; its button is turned off.
- 1 Custom action "Publication year" is not migrated; its button is turned off.

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
