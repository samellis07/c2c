# React UI target

Generated app UIs move from the vanilla runtime (`docs/ui.md`) to React. A
migrated app keeps being developed by its owner after migration, and a React +
TypeScript app is far easier for a person or a coding assistant to customize,
extend and hire for than a bespoke runtime.

Only the UI target changes. The backend (the `c2c_api` Advanced I/O function
and its routes), the data, the IaC, authentication and the deploy pipeline are
unchanged: the React app calls the same endpoints with the same bodies.

Status: `c2c ui-react` generates the app for any Creator app; the shell,
navigation, forms (all field families except users and rich text), lookups
and subforms ([Lookups and subforms](#lookups-and-subforms)), list reports,
sign-in, offline, the extension points, and Creator pages, dashboards and
chart reports ([Pages, dashboards and charts](#pages-dashboards-and-charts))
are in place. `c2c deploy --ui react` (or `"ui": "react"` in
`c2c-deploy.json`) deploys it: the deploy writes the React source under
`web/`, builds it to `web/dist`, and links Slate to `dist/` instead of the
vanilla `slate/` tree. Other report views, users and rich-text fields, and
the approval and blueprint screens are planned.
React is the deploy default (`c2c deploy` serves the React app); `c2c ui` (vanilla) and `--ui vanilla` stay as the fallback.

## Stack

| layer | choice | pinned |
|---|---|---|
| language | TypeScript, strict | typescript 5.9.3 (same as the repository) |
| UI | React | react, react-dom 19.3.0 |
| build | Vite (Rolldown) with @vitejs/plugin-react | vite 8.3.4, @vitejs/plugin-react 6.1.2 |
| components | `@c2c/ui`: vendored Arc Library components, adapted (see [Arc Library](#arc-library)) | Arc commit `86330cc9270c4acc55b7204c9583fcbaa378192c` |
| primitives | Radix UI, added per component when a vendored Arc component uses it (select, dialog, tabs, popover) | exact versions in the app `package.json` |
| icons | lucide-react | 1.54.0 |
| motion | motion (`motion/react`); every animation has a reduced-motion path (`useReducedMotion`, `prefers-reduced-motion` rules) | 13.5.1 |
| runtime | Node `^20.19.0 \|\| >=22.12.0` for the build (`engines`, enforced by `engine-strict`; the pinned Vite's own range), 20.20.1 recommended (`.nvmrc`); the bundle targets ES2022 browsers | |

Every dependency is pinned to an exact version in
`packages/ui-react/template/package.json` and the committed
`package-lock.json` (lockfile v3, every platform's optional native build
binary listed, so `npm ci` gives the same tree on macOS, Linux and Windows).
Licences: shipped code is MIT, ISC or 0BSD; build-only tools add Apache-2.0,
BSD-3-Clause and MPL-2.0 (lightningcss, the CSS minifier, never in the
bundle). `THIRD_PARTY_NOTICES.md` lists them and a test checks every lockfile
entry against that allowlist.

### Slate

Catalyst Slate builds React + Vite natively: framework `react-vite`, build
command `npm run build`, output `dist/` (see the Catalyst Slate
documentation, https://docs.catalyst.zoho.com/en/slate/). The generated app is a
standard Vite project, so the Git-connected Slate flow works unchanged:
push the app's source and Slate builds it on push (`npm run build`) and
serves `dist/`. For a CLI deploy (`catalyst deploy slate`), `dist/.catalyst/slate-config.toml`
must be written after every clean build, because the build empties `dist/`;
the deploy step
owns that file, not the build.

Two Slate facts shape the build config:

- Slate serves from the site root, so `base` is `/` (a non-root base makes
  every asset 404).
- Slate and the function run on different domains. `public/c2c-config.js`
  carries the absolute function base (`C2C_API_BASE`), which `c2c deploy`
  rewrites; the Slate domain must be an authorized domain with CORS on, and
  the function sets no CORS headers for production origins.

Slate sends `cache-control: public, max-age=31536000` on every file; the
[offline](#offline-and-pwa) section covers how a redeploy still reaches users.

## Packages

| path | what | owner |
|---|---|---|
| `packages/ui-react/src/generate.ts` | the generator: Creator app → app spec → file tree; the writer that enforces ownership | this repository |
| `packages/ui-react/template/` | the app template: build setup, `src/main.tsx`, the `src/custom/` scaffold, and `lib/c2c-ui/` (the `@c2c/ui` library) | this repository |
| `packages/ui-react/template/lib/c2c-ui/arc/` | vendored Arc Library source at a pinned commit | adapted copy, see `ARC-UPSTREAM.md` |
| `tools/ui-react-check.mjs` | type check, two builds, budget and score for one app | this repository |

`@c2c/ui` is vendored into each generated app as `lib/c2c-ui/` and imported
as `@c2c/ui` through a Vite and TypeScript path alias. It is not published to
npm yet; publishing it later only swaps the alias for a pinned dependency.

### Arc Library

Arc Library (https://github.com/kuratlielia/arc-library, MIT) is the base of
`@c2c/ui`. Arc ships plain component source (CSS modules on a small token set,
Motion, keyboard support, a reduced-motion path), so `@c2c/ui` vendors it
shadcn-style: copied at a recorded commit, then owned and adapted (Creator
layouts, c2c tokens, phone layouts, accessibility, i18n). It is not an npm
dependency. `lib/c2c-ui/ARC-UPSTREAM.md` records the commit, the vendored
files, every local change and the deliberate update procedure.
`THIRD_PARTY_NOTICES.md` (repository and every generated app) carries the MIT
notice.

The skeleton vendors only what it uses: `foundation.css` (tokens),
`motion-tokens.ts`, `button`, `input`, `alert`, `empty-state`,
`sortable-data-table`. Pages and charts add `metric-card` (with
`animated-counter`), `bar-chart`, `line-chart` and `donut-chart`. A new
feature vendors the Arc components it needs the same way; what Arc lacks (subforms, lookups, the approval
inbox, the blueprint stage UI) is built in Arc's style: CSS modules on the
tokens, Motion with a reduced-motion path, keyboard support.

## The generated app

```
<app>/
  package.json  package-lock.json  .npmrc  .nvmrc  .gitignore     platform
  tsconfig.json  vite.config.ts                                    platform
  README.md  THIRD_PARTY_NOTICES.md                                platform
  index.html                                                       generated
  public/c2c-config.js  public/manifest.webmanifest  public/icons/ generated
  lib/c2c-ui/**                                                    platform (@c2c/ui, Arc, Vite plugin, service worker template)
  src/main.tsx  src/vite-env.d.ts                                  platform
  src/generated/model.ts         the app spec (typed AppSpec)      generated
  src/generated/routes.tsx       route key -> screen component      generated
  src/generated/forms/<Form>.tsx one module per form               generated
  src/generated/reports/<Report>.tsx                               generated
  src/generated/pages/<Page>.tsx                                   generated
  src/generated/theme.css        Creator theme -> --c2c-* tokens    generated
  src/generated/c2c-generated.json  sha256 of every generated file  generated
  src/custom/index.tsx  theme.css  README.md                       custom (yours)
```

`c2c ui-react <file|dir> --out <dir>` writes it. The generator is pure and
deterministic; the writer applies the ownership rules.

### Ownership

| owner | files | first generation | regeneration | `--upgrade-platform` |
|---|---|---|---|---|
| generated | `src/generated/**`, `index.html`, the generated `public/` files | written | rewritten; generated files the app no longer has are removed | rewritten |
| platform | build setup, `src/main.tsx`, `lib/c2c-ui/**`, notices | written | written only when missing | replaced |
| custom | `src/custom/**` | written | written only when missing, never overwritten | never overwritten |

Regeneration (a Creator change, an edit-by-asking request, the admin editor)
therefore touches only the generated area. `src/generated/c2c-generated.json`
holds the sha256 of every generated file; a regeneration first compares the
files on disk with it, and a hand edit stops the write with the list of edited
files (exit 1) instead of overwriting the change. `--force` discards hand edits
deliberately. Other files a user adds anywhere (new components, pages, public
images) are never touched because the writer only writes paths it generates.

A test proves the split: two different apps produce byte-identical platform
and custom files, and every app-specific byte is in the generated area.

### Extension points

All customization goes through one object exported by `src/custom/index.tsx`
(`defineCustomization`, typed by `@c2c/ui`):

| point | shape | effect |
|---|---|---|
| `components.fields[widget]` | `ComponentType<FieldProps>` | replaces a field control everywhere (`'email'`, `'date'`, `'subform'`, ...) |
| `components.ReportTable` | `ComponentType<{ report, rows }>` | replaces the record table of every list report |
| `components.EmptyState` | `ComponentType<{ report }>` | replaces the empty state |
| `forms[name].fields[field]` | `ComponentType<FieldProps>` | replaces one field's control |
| `forms[name].slots` | `{ before, after, actions }` | content around a form and beside its buttons |
| `forms[name].beforeSubmit` | `(record, ctx) => record \| false` | change the record before it is posted, or stop the submit |
| `forms[name].afterSubmit` | `(reply, ctx) => void` | react to the reply (`{ ok, dryRun, body }`) |
| `reports[name].cells[field]` | `(value, row) => ReactNode` | render one column's cells |
| `reports[name].slots` | `{ before, after, toolbar }` | content around a report and in its toolbar |
| `reports[name].rowActions` | `(row) => ReactNode` | extra controls on each record row |
| `routes` | `[{ page, label, section?, component }]` | extra screens at `#/page/<page>`, added to the menu |
| `nav` | `(sections) => sections` | reorder, rename or hide menu entries |
| `api.headers` | `() => headers` | extra request headers on every `c2c_api` call |
| `src/custom/theme.css` | CSS | override any `--c2c-*` or Arc token; loaded last |

Generated forms render `<Field name="..." />` only; `Field` resolves the
control in the order per-field override, per-widget override, default. That is
what lets a user change any generated screen without editing generated code,
and what lets a new default widget land without touching generated code.

```tsx
// src/custom/index.tsx
import { defineCustomization } from '@c2c/ui';
import { Dashboard } from './Dashboard';

export default defineCustomization({
  routes: [{ page: 'Dashboard', label: 'Dashboard', component: Dashboard }],
  reports: { All_Contacts: { cells: { Email: (v) => <a href={`mailto:${v}`}>{String(v)}</a> } } },
  forms: { New_Contact: { beforeSubmit: (record) => ({ ...record, Source: 'web' }) } },
});
```

## Data access

The app talks to the existing `c2c_api` function through `createApi`
(`lib/c2c-ui/runtime/api.ts`), the same contract as the vanilla runtime:

- Base: `globalThis.C2C_API_BASE` from `public/c2c-config.js` (a stable URL,
  rewritten by `c2c deploy`; absolute on Slate). With no base, endpoints stay
  root-relative.
- Auth: when the Catalyst Web SDK is loaded, every call carries the signed-in
  user's token in `authorization` (the raw token, Web SDK 4.6.1+) and
  cross-origin calls send cookies. The function's access policy decides; the UI
  never filters records for security.
- Every call is a `POST` with a JSON body (`api.post`); a bigint id is sent as its
  digit string. The lookup reads are the one `GET` (`api.get`, no body), as
  the lookup endpoint takes its paging from the query string.

| use | endpoint (from the spec) | body | reply |
|---|---|---|---|
| report rows | `report.queryEndpoint` (`/reports/<name>`) | `{ op: "query", page, pageSize }` | `{ rows: [...] }`; 404/405/501 is an empty report (static host), other errors show the error state |
| chart and metric rows | the same `report.queryEndpoint` | the same, pages 0, 1, ... until a short page, at most 10 pages | the same; one read per report per screen, shared by every chart and metric on it |
| add or edit | `form.submitEndpoint` / `form.editSubmitEndpoint` | `{ record, ROWID? }` | `{ ok, dryRun, message? }`; `dryRun !== false` is worded as "nothing was saved" |
| edit prefill | `form.recordEndpoint` (`/forms/<name>/record`) | `{ ROWID }` | `{ record }` |
| file upload | `field.uploadEndpoint` (`/uploads/<form>/<field>`) | `{ filename, contentType }` | `{ reference: { key } }`; the submit value is exactly `{ key }` |
| lookup options | `field.lookup.endpoint` (`GET /lookups/<form>/<display field>?page=&pageSize=300`) | none | `{ rows: [{ ROWID, <display field> }], field }`; 404/405/501 is an empty list |

Custom actions, approvals and blueprint transitions use their existing
endpoints.

## Lookups and subforms

`packages/ui-react/src/lookups.ts` builds the spec part,
`lib/c2c-ui/lookup/` and `lib/c2c-ui/subform/` hold the widgets.

- Spec: a lookup or multi lookup field (and a subform column) carries
  `lookup: { form, display, endpoint }`: the parent form, the field its
  options show (the export's display format when it names one field, else the
  linked field) and the endpoint that pages them. A lookup whose export names
  no parent form stays a counted placeholder with that reason.
- Lookup: the vendored Arc combobox. A multi lookup: the vendored Arc
  multi-select with a search box. Options are read one 300-row page at a time
  (the ZCQL row cap): the first page when the control opens, or at once when the
  record already holds a value (to show its display text); further pages from
  the "Load more records" control in the open menu; the search filters the
  pages read and says when more pages remain. The lookup endpoint has no
  search parameter, so a parent table is never read in full to search it.
  Every lookup on the screen that points at the same endpoint shares its pages
  (`lookupSource`). A failed page shows a Retry control.
- Submit value: the parent ROWID (a list of them for a multi lookup), carried
  by a named hidden control, so `readRecord` sees it like any other field.
- Deep link: when the parent form has a screen in this app, the chosen record
  links to `#/form/<parent>/edit/<ROWID>`.
- Users field: an email control (Creator stores the user's email address),
  checked as an email.
- Subform: an editable grid in the Creator column order, one cell control per
  column type (a lookup column is a lookup picker; a name or address column
  one control per part, posted nested). Rows are added and removed in place
  (focus moves to the new row, or to Add after a removal). Before the submit,
  `validateSubforms` checks every non-empty row (mandatory cells, email, URL,
  number, length, Creator pattern): each invalid cell gets its error under it,
  keyed `Field[i].Column` and linked to the cell control with
  `aria-describedby`, the grid's own error names the rows, and focus moves to
  the first invalid cell. Empty rows are not sent.
- Subform save: the generated grid always sends its list, empty when every row
  was removed, and the server replaces the parent's child rows with it (delete
  the stored rows, insert the list in grid order). Removing every row deletes
  them all. Child ROWIDs are not kept: every edit of the parent stores its rows
  under new ROWIDs, so nothing outside the parent should hold a child ROWID. A
  stored row carries its ROWID in a hidden cell only so that it is sent even
  when its visible cells were cleared. A custom subform widget that draws no
  grid sends nothing and leaves the stored rows alone.
- Keyboard: Enter in an open lookup menu chooses the highlighted record, or
  the first match of a typed search, and never submits the form. The multi
  lookup keeps focus on its trigger or search box and announces the
  highlighted record through `aria-activedescendant`. Lookup and multi lookup
  errors are linked to their control with `aria-describedby`.
- Stored lookup values: `lookupIds` accepts ROWID digit strings, bigints and
  safe integers (bare or as `{ ROWID | value | id }`); anything else, such as
  a number past 2^53 that has already lost digits, is not treated as an id.
- Reports: a lookup column already arrives as its display text (the report
  endpoint resolves parent ROWIDs through the same access scope), so the table
  shows it as is.

Interface additions: `Api.get`, `FieldSpec.lookup` (`LookupSpec`), and
`FormContext` moved to `form/context.ts` (still exported from `form/fields.tsx`)
so the grid can read cell errors without an import cycle.

## Auth

Sign-in is the default, exactly as in the vanilla target: `public/c2c-config.js`
loads the Catalyst Web SDK and `/__catalyst/sdk/init.js`. `AuthGate` renders the
app only after `catalyst.auth.isUserAuthenticated()` resolves; otherwise it
shows Catalyst's embedded sign-in in `#c2c-login` with a `service_url` that can
only point back to this origin (the same sanitizer as the vanilla runtime), a
standing hint for a blank frame (iFrame off for the host) and an alert when no
frame appears. `c2c ui-react --no-auth` leaves the SDK out for a local preview;
the function still enforces access. Roles, profiles and permissions stay in
`packages/auth`; nothing about them moves to the UI.

## Routing

Hash routes, identical to the vanilla runtime so bookmarks, the smoke plan and
deep links keep working: `#/form/<name>`, `#/form/<name>/edit/<ROWID>`,
`#/report/<name>`, `#/page/<name>`. Hash routing needs no server rewrite rule on
Slate. A hash that is not a route (the skip link's `#main`) keeps the current
screen. `useRoute` reads the hash through `useSyncExternalStore`, so a route
change renders synchronously and the screen and the menu's current marker never
disagree. With no hash the first menu destination is shown.

`#/admin/smoke` is the hidden admin smoke page — never in the nav, same as the
vanilla target. It runs the `C2C_SMOKE_PLAN` a deploy embeds through the same
guarded endpoints, checks access first with `POST /admin/smoke { op: "status" }`
(so a signed-out visit paints `not-signed-in`, never the sign-in gate), and
paints the same element contract the CLI browser driver polls:
`[data-smoke-state]` for the run state, one `td` per line under
`[data-smoke-steps]`, the result code in `#c2c-smoke-code` beside its Copy
button (`[data-smoke-copy-code]`, under "Paste this into your AI chat (Claude
or any LLM)"), and the sealed `c2c-smoke/1` block in `#c2c-smoke-json`.
The runner (`lib/c2c-ui/smoke/run.ts`) is a TypeScript port of the vanilla
`runSmokePlan`; the guided `c2c smoke --confirm` step and `c2c smoke
--result-code` / `--result` verification work unchanged against a React deploy.

## Shell contract and phone layout

The shell ids and data attributes are a contract: the UI scorer, the smoke plan
and the CSS rely on them. Class names starting with `c2c-` are styling only.

| element | contract |
|---|---|
| `index.html` | `lang`, a non-empty `title`, `meta viewport width=device-width`, a skip link to `#main`, `#root` containing `main#main` |
| `#app-title` | the Creator application name |
| `nav#nav` (named) | desktop menu: one group per visible Creator section with its label, one link per form, report and page; the open route's link has `aria-current="page"` |
| `nav#tabbar` (named) | phone tab bar: up to five entries; with more destinations, four tabs plus a More button (`data-more`, `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls="more-sheet"`) |
| `#more-sheet` | `role="dialog"`, `hidden` when closed, a fixed overlay; Escape or a link closes it and focus returns to More |
| `form[data-form][data-layout]` | one per form screen, inside a card headed by an `h1` with the Creator form label; `.form-grid` holds the fields |
| `[data-field]` | one box per field with a rendered `label`/`legend`, named controls (`Field`, `Field.part`, `Field[2].Column`), `required` on mandatory fields, `[data-error-for]` + `aria-invalid` after a failed submit |
| `[data-report][data-view]` | one per report screen, headed by an `h1`; `.table-wrap` holds the table; cells carry `data-th` (column label) and `data-phone` (on the phone card) |
| `[data-state="loading" \| "empty" \| "error"]` | the three data states; the error state is `role="alert"` with a Retry button |
| `.todo` | a construct the generator cannot draw yet: visible and counted, never dropped |

Phone layout, below 768 px: the menu hides and the tab bar shows; multi-column
forms collapse to one column (composite parts too); report rows become cards
that show the Creator phone quick view columns (else the first four) with
their labels, plus the Edit action; the More sheet rises above the tab bar.
Desktop at 1440 px shows the section menu beside the content. Tokens and
breakpoints live in `lib/c2c-ui/styles/`.

## Design tokens

`lib/c2c-ui/styles/tokens.css` defines the `--c2c-*` layer the app theme sets
(accent, top bar, menu, page background, font, widths) and maps it onto Arc's
foundation tokens (`--accent`, `--control-on`, radii, fonts), which stay the
component vocabulary. `src/generated/theme.css` sets the `--c2c-*` values from
the Creator theme (the same palette table as the vanilla target,
`packages/ui/src/theme-map.ts`); `src/custom/theme.css` overrides last. The
design system owns the default values and the theme table; it changes
values, not names, so generated apps and user themes keep working.

## Offline and PWA

- `dist/sw.js` is the vanilla target's service worker (`serviceWorker()` in
  `packages/ui/src/generate.ts`, copied into the app as
  `lib/c2c-ui/pwa/sw.template.js`) with this build's precache list and cache
  id filled in by the c2c Vite plugin. Same rules: the shell is network-first
  with a revalidating fetch and the cached copy only as the offline fallback;
  hashed assets are cache-first; report, lookup and form reads are
  network-first then cache; writes are never intercepted or stored; the
  sign-in, SDK and API paths (`/accounts`, `/__catalyst`, `/baas`, `/server`)
  are never answered by the worker; previous `c2c-` caches are deleted on
  activate. Because the cache-name prefix is the same, a migrated app's first
  React deploy clears the vanilla caches.
- `sw.js` embeds the hash of `index.html` and the precache list, so any change
  to the build changes `sw.js`, which is what reaches users through Slate's
  year-long cache (see `docs/ui.md`, "Cache").
- The production entry registers `/sw.js`. `public/manifest.webmanifest` and
  the icons make the app installable.
- A submit while offline says so ("Submitting a form needs a network") and
  sends nothing.

## Pages, dashboards and charts

Creator pages (ZML panels and dashboards) and chart reports render from the
spec; no page is a placeholder. The generator side is
`packages/ui-react/src/charts.ts` (`pageSpecs`, `reportChart`,
`compileCriteria`); the library side is `lib/c2c-ui/charts/` (data folding,
row reads, `ChartReport`, `ChartPanel`, `MetricTile`) and `lib/c2c-ui/pages/`
(`PageView`, the snippet sanitizer).

Spec: `AppSpec.pages[name]` is a `PageSpec` (the element tree plus every TODO
on the page) and a chart report carries `ReportSpec.chart` (`ChartSpec`).
Both are optional fields; the spec version stays 1.

| ZML element | React |
|---|---|
| `row`, `column`, `panel`, `pr`, `pc` and the other layout tags | flex rows and columns with the exported widths; one column per row on a phone |
| `text type="Form Data"` (`thisapp.<Report or Form>.<Field>.count/sum`) | an Arc metric card: the count or sum of the report's rows that pass its criteria; a value with no report to read is a TODO, not a 0 |
| a panel of icons, captions and values | one metric card per value, labelled by its caption; further values of a one-caption panel form its context line, each with the label it carried; unclaimed captions and separators stay where they stood |
| `chart` | an Arc chart, by the exported type (below), from the rows of a report on its form |
| `report` | the record list (`ReportView`), or the chart for a chart report |
| `form` | a link to the form |
| `button` (`OpenForm`, `OpenReport`, `OpenPage`, a web address) | a link styled as a button; prefill parameters are a TODO |
| `embed` with a web address | a link that opens it |
| `text`, `image type="icon"`, `suffix` | text, a decorative icon, the value's suffix |
| `dsp`, `html` snippets | the markup after the snippet sanitizer (generation and again in the browser); a snippet built by a server-side script is a TODO; a snippet popup becomes a link plus a TODO naming the auto-open trigger the link no longer carries |
| `dspZml`, anything else | a TODO |

| Creator chart type | drawn as | charts in the sample corpus |
|---|---|---:|
| Column, Stacked Column, Bar, Funnel | Arc bar chart (one per measure; the 24 largest categories) | 25 |
| Pie, Donut, Semi Donut | Arc donut chart | 26 |
| Line, Spline, Area | Arc line chart (one series per measure) | 1 |
| chart report (`pivotchart`) | line when most categories are dates, else bars | 68 on pages, 103 reports |

A `pivotchart` export records no chart settings, so the report's columns
decide: a date column for a report named for a period, a column named after
"by" in the title, else the first choice or lookup column, as the category;
the first numeric column that is not an identifier (preferring one named in
the title) as the summed measure, else the record count. The chart states
how it was drawn.

Criteria (`DelugeCriteria` on a chart, `criteria` on a value) are applied in
the browser to the report rows. Translated: `==`, `!=`, `<`, `<=`, `>`, `>=`
against a literal or another field, `is empty`, `is today/yesterday/tomorrow`,
`in this/last/next week/month/year`, `in last N days`, `&&`, and `||` when
every branch translates; dates are compared in the app time zone
(`C2C_APP_TIMEZONE`). A clause on the signed-in user, a form input or any
other expression is a TODO, and the rest of the conjunction still applies.
A value or chart on a form whose only reports carry their own criteria says
so as a TODO.

TODOs are never dropped: each sits where its element stood (`.todo`) and the
page lists them all at its top. Over a corpus of sample Creator apps (not
included; 68 apps, 155 pages): 191 TODO
elements, of which 186 are server-side snippets (`dsp` 137, `dspZml` 49).

## Determinism and build

- Source: `generateReactApp` is pure (no clock, no randomness; iteration in
  source order; sorted output). Every committed fixture's React tree is part of
  the determinism manifests under `web/`
  (`packages/determinism/test/manifests/*.sha256`, one sha256 line per file),
  so the determinism gate (`bash tools/determinism-gate.sh`) and
  `npm run determinism:check` cover it, and the codegen lint covers
  `packages/ui-react/src`.
- Toolchain: exact pins and the committed lockfile; Node `^20.19.0 || >=22.12.0`
  (the built `dist/` is byte-identical on Node 20 and 22); TypeScript 5.9.3,
  the same as the generator's own toolchain.
- Build: the c2c Vite plugin (`lib/c2c-ui/vite/plugin.ts`) makes the output
  deterministic and checked: input `src/main.tsx`, `assets/runtime.<hash>.js`
  and `assets/model.<hash>.js` only, one stylesheet, `dist/index.html` written
  from the source `index.html`, no source maps, no module-preload helper, no
  clock. `tools/ui-react-check.mjs` builds every app twice and compares the
  `dist/` bytes (`reproducible=true`).
- CI (per app, and over a local corpus): `npm ci --prefix packages/ui-react/template`
  once, then `npm run build && node tools/ui-react-check.mjs <app> --out <dir>`
  for one app, or `C2C_GALLERY_DIR=<dir> node tools/ui-react-check.mjs` for a
  whole corpus (one line per app, a pass count, exit 1 on any failure).
  It fails on: non-deterministic source, a type error (the Q2 compile gate for
  the UI: `tsc --noEmit` over generated, platform and custom code), a failed or
  non-reproducible build, a bundle over budget. The existing Q2 and Q4 gates
  over the generated handler modules are unchanged.

## Bundle budget

The plugin gzips every emitted JS and CSS file at level 9 and fails the build
over budget: JavaScript 250 KiB, CSS 24 KiB (`DEFAULT_BUDGET`). `dist/c2c-build.json`
records the numbers. Per chunk, `lib/c2c-ui/vite/route-chunk-budgets.json` is
the reviewed gate: an emitted chunk with no budget entry, or over its entry by
more than the 5% tolerance, fails the build naming the chunk and its size, and
for the apps in `samples` a budgeted chunk missing from the output fails too
(`C2C_BUDGET_STRICT=1`, set by `tools/ui-react-check.mjs`). Raising a budget
means editing that file in the pull request. Skeleton measurements (gzip):

| app | JS | CSS |
|---|---:|---:|
| a small sample app | 131,454 B | 8,817 B |
| library-application-system (fixture) | 132,184 B | 8,817 B |
| freight-forwarding (fixture, 20 forms) | 150,744 B | 8,817 B |

With pages, dashboards and the Arc charts, over the 68 sample apps: JS
117-163 KiB gzip (119,681-166,880 B), CSS under 12 KiB (6,968-12,099 B); every
app stays inside the default budget, so no new number is argued.

React, React DOM and Motion are most of the JavaScript; the app spec grows with
the app (about 1 KiB per small form). A feature that adds weight (charts) must
stay inside the budget or argue a new number in this file; code-splitting per
route is the fallback if large apps approach it.

The workflow screens' measured cost: an app with an approval and a blueprint
machine builds at 153,189 B JS and 11,690 B CSS gzipped — about 15 KiB of JS
over a comparable app with no machines, for the vendored Arc stepper,
timeline, dialog and comment-thread (the dialog's @radix-ui/react-dialog
dependency is pinned exactly in the template lockfile and licensed in
THIRD_PARTY_NOTICES.md).

## The UI scorer on a React bundle

The UI scorer (`c2c score-ui`, rubric v1, 8/10 on desktop 1440 px and phone
390 px) boots a bundle in jsdom: it reads `index.html`, the linked stylesheet,
the module script and the module that script imports, calls the runtime's
exported `boot(model, document)` against a fake data API (rows, empty,
failing), visits every route and checks the rendered DOM. The React build
meets that contract without a scorer change:

- the c2c plugin emits exactly two modules: `runtime.<hash>.js` (exports `boot`)
  importing only `model.<hash>.js` (exports `model`), with the import written as
  `from "./model.<hash>.js"`; the build fails if that shape breaks;
- `boot(spec, document)` mounts into that document's `#root` and commits the
  first render synchronously; the More sheet and route changes commit
  synchronously too;
- under Node there is no global `window`; React DOM reads it for event
  priority, so `bootApp` assigns the document's window when, and only when, the
  host has none (never in a browser);
- vendored components take browser APIs from the node's own window and guard
  `ResizeObserver`.

Skeleton scores (scorer at its revision then, run on the built `dist/`):

| app | desktop | phone | vanilla target, same scorer |
|---|---:|---:|---:|
| a small sample app | 10 / 10 | 10 / 10 | 7.2 / 7.7 |
| library-application-system | 9.2 / 10 | 8.7 / 10 | |
| freight-forwarding | 9.2 / 10 | 8.6 / 10 | |

In the skeleton the fixture apps lost points to the lookup placeholders and
report views drawn as lists (both counted as `.todo`); lookups have since
replaced the placeholders, and the other report views are planned.

Sweep over a corpus of 67 sample Creator apps (not included), skeleton
(`ui-react-check` plus the scorer):

| check | result |
|---|---|
| source deterministic (two generations byte-identical) | 67 / 67 |
| `tsc --noEmit` | 67 / 67 |
| `vite build`, and two builds byte-identical | 67 / 67 |
| bundle budget | 67 / 67 (JS 131-144 KiB gzip, CSS under 9 KiB) |
| UI score ≥ 8 on desktop and phone | 67 / 67; mean 9.43 desktop, 9.44 phone; lowest 9.1 |

What the remaining points were, by scorer check kind: field controls the
generator did not draw yet (lookups, users, rich text), the `.todo`
placeholders for those fields and for non-list report views, and mandatory
marks on those placeholder fields.

No browser is needed anywhere: generation, type check, build and scoring all
run headless under Node, which also fits the plugin rule that the user has no
browser automation.

## Gates

| gate | React target |
|---|---|
| Q2 compile | `tsc --noEmit` on the whole app (generated + platform + custom), per app in `ui-react-check`; the handler-module Q2 is unchanged |
| Q4 smoke | unchanged for the generated handlers; `#/admin/smoke` exists on both targets with the same element contract, so the guided `c2c smoke --confirm` step and `--result` verification work unchanged |
| UI score | ≥ 8/10 desktop and phone, from `ui-react-check` (when the scorer is built) or `c2c score-ui <app> --ui <dir>/dist` |
| sign-in | default on (`--no-auth` only for a local preview) |
| offline / PWA | service worker with precache, manifest, offline submit message |
| bundle budget | enforced by the build |
| determinism | manifests under `web/`, the determinism gate, and the two-build comparison |

