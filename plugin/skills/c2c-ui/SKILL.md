---
name: c2c-ui
description: "Creator forms, reports and pages to a Catalyst Slate PWA with c2c: form rendering and validation, lookup dropdowns, report views (list, kanban, calendar, timeline, spreadsheet, grouping), pages and snippets, widgets, Slate link/deploy, App URL, cache headers and the cross-origin call to functions. Use for 'Slate', 'web client', 'forms UI', 'report view', 'empty dropdown', 'lookup not loading', 'page', 'widget', 'CORS blocked', 'stale UI after deploy', 'onslate'."
metadata:
  version: "0.2.0"
---

# UI: Slate PWA, forms, reports, pages

Load `catalyst-slate` for Slate config and deploy, `catalyst-authentication` for the Web SDK sign-in. This skill adds the migration rules.

**Rule — default settings only (C2C.md rule 13):** no browser automation, no permission-rule changes, no supplied evidence — the user opens the App URL and signs in themselves; you verify by read-back (`curl -I`, MCP, the store), never by driving their browser.

## What c2c generates

The default UI is the React app: `c2c deploy` writes the React source under `c2c-out/<app>/web/`, builds it to `web/dist`, and Slate serves `dist/`. The vanilla fallback (`c2c ui`, or `c2c deploy <ds> --ui vanilla`) is a static PWA (vanilla ES modules, manifest, service worker, content-hashed assets) under `c2c-out/<app>/slate/`, plus `c2c-config.js` with the API base. Both call the `c2c_api` function cross-origin: Slate is served on `*.onslate.<dc>`, functions on `*.catalystserverless.<dc>` [TESTED], so the Slate host must be an **Authorized Domain** (CORS) and the user must be signed in (`c2c-auth-and-access`).

| Creator | Slate | Status / gap |
|---|---|---|
| Form (fields, validation, initial values, on user input) | Generated form; client validation; server re-validates | Renders [TESTED]. The server re-checks mandatory fields |
| Lookup field | `<select>` filled from `/lookups/<Form>/<Field>` | An empty dropdown means the lookups route is missing or unrouted: check the deployed function routes [TESTED] |
| Subform | Inline grid | Renders; each subform is a child table |
| List report | Table view, server paging (ZCQL keyset), display names in headers | 300 rows per SELECT ([L-ZCQL-ROWS](../../references/limits.md#l-zcql-rows-zcql-rows-per-select) → split), 1-based offsets ([L-ZCQL-OFFSET](../../references/limits.md#l-zcql-offset-zcql-offset) → split), projection ≤ 20 columns ([L-ZCQL-WIDTH](../../references/limits.md#l-zcql-width-zcql-select-columns) → refuse). Headers showed link names and lookups as raw ROWIDs [TESTED]; #76 |
| Kanban / calendar / timeline / spreadsheet / grouping / pivot | Generated views | A view type c2c cannot render yet falls back to a table and is reported as a TODO |
| Report criteria | `Field is today`, `Field is this week`, and `Field is this month` bind in the application time zone; untranslatable criteria fail closed (TODO), never `true` | |
| Pages / HTML snippets / ZML | Generated pages | Partial |
| Widgets | TODO | Report as TODO |
| File upload field | Upload to Stratus via the API | A live deploy must not show the "dry-run upload does not write bytes" text; if it does, the deploy ran in dry-run mode |
| Menu / navigation | Generated nav | Check for page-only menu items without links and dead system links (approval/localization/connection) |

## Unsupported report filters

For `report-criteria` and `Filter not migrated` TODOs, use
[the manual repair procedure](../../../docs/report-filters.md). Report and named
filter criteria use the same compiler. Owner variables, function results and
record-query values remain counted until resolved; configuring an owner env var
alone does not translate them. Preserve authenticated record access and verify
matching, nonmatching and missing-record cases before accepting a custom rule.

## Steps

1. **Review** the UI section of `plan.md`: forms, reports by view type, pages, TODOs. Show the user which views degrade to tables.
2. **Deploy** happens in `c2c deploy <ds> --confirm --function-env <file>` (`c2c-provision-and-deploy`): `catalyst slate:link` then `catalyst deploy slate`.
   - `catalyst.json` must contain `"slate": [ … ]` (an **array**). An object makes zcatalyst-cli crash in `addExistingSlate` with `TypeError: existingSlates.findIndex is not a function`, shown as `An unexpected error has occurred. Kindly contact Catalyst support` [TESTED]; c2c writes an array. If you see it on an older c2c, do not hand-edit generated files: upgrade c2c.
   - `slate:link` writes an absolute local `source` path into `catalyst.json` [TESTED]; that file is workspace-only, never committed with customer paths.
3. **Record the App URL.** c2c must print and store `App Url: https://<name>.onslate.<dc>` in `c2c-deploy-report.json`. Without it, you cannot add the Authorized Domain. A deploy that printed the URL and then `HTTP Error: 404, No such app with the given id exists` was live anyway [TESTED]: verify by fetching the URL, not by the CLI exit code alone.
4. **Authorized Domain** for the App URL host (`c2c-auth-and-access` step 3).
5. **Cache:** Slate serves `/` and `index.html` with `cache-control: public, max-age=31536000` [TESTED] ([L-SLATE-CACHE](../../references/limits.md#l-slate-cache-slate-indexhtml-cache) → version). c2c's hashed assets and versioned service worker handle redeploys; tell the user a hard refresh may be needed once after a redeploy. (Console "Web Cache" toggle effect: [UNVERIFIED].)

## Verification

- `curl -sI https://<app>.onslate.<dc>/` → 200.
- MCP `CatalystbyZoho_List_All_Slate_Apps` shows the app; `Get_Slate_App` deployment is live.
- CORS: `OPTIONS https://<project-domain>/server/c2c_api/reports/<r>` with `Origin: https://<app>.onslate.<dc>` returns `Access-Control-Allow-Origin: https://<app>.onslate.<dc>` and `Allow-Credentials: true` [TESTED].
- After the user signs in: `GET /baas/v1/project/<id>/project-user/current` → 200 (was 401 before auth setup [TESTED]); a report shows rows; a lookup dropdown has options.

## Stop conditions

- `findIndex` crash → wrong c2c version; stop and upgrade.
- No App URL recorded → stop before auth (the domain cannot be authorized).
- Preflight without `Access-Control-Allow-Origin` → the domain is not authorized; stop and fix auth.

## What to ask the user

- Accept degraded views (kanban/calendar/… as tables) or wait for native support.
- "Deploy the Slate app to <project>? (yes/no)".
- After auth: "Open <App URL>, sign in, and tell me what you see" (you never sign in for them).
