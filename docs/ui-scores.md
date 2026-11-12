# UI scores

An independent score of each generated app's UI against its Creator source, on a
desktop (1440x900) and a phone (390x844) viewport, out of 10 each.
The bar is **8/10 on both**; a gate uses the lower of the two.

The scorer (`packages/ui-score/src/score.ts`) reads the Creator app through the
parser only, never the UI generator. It boots the generated bundle's own runtime
in jsdom against a fake data API (rows, empty, failing), visits every form, report
and page route, and checks the rendered DOM. Viewport behaviour comes from the
bundle's stylesheet media rules evaluated at each width. Offline, deterministic, no
browser. A criterion's points are its weight times the share of its checks that
pass; the total is rounded down to one decimal.

```
c2c score-ui <file|dir> [--ui <c2c ui --out dir>] [--json] [--write score.json]
C2C_FIXTURES_DIR=<fixtures-dir> npm run score-ui:gallery -- --out docs/ui-scores.md
```

## Rubric (`packages/ui-score/rubric.json`, v1)

| criterion | desktop | phone | checks |
|---|---:|---:|---|
| Layout parity | 1.5 | 1.5 | the app title is the Creator application name; each form shows its fields in the Creator field order; each titled Creator section field is a heading in its form; each form, report and page route renders without a not-generated placeholder; phone: a multi-column form layout collapses to one column |
| Navigation (desktop menu; phone tab bar and More) | 1.5 | 2 | desktop: every visible Creator section is a menu group with its label; desktop: every form, report and page of a visible section is a menu link with its Creator label; desktop: the link of the open route is marked current; phone: the tab bar has between one and five entries, each with a name; phone: when the menu has more destinations than tabs, a More control opens a sheet and Escape closes it; phone: every menu destination is a tab or a More sheet link |
| Forms and fields | 1.5 | 1.5 | each form route renders a form headed with the Creator form label; each input field of the Creator form is present; each field's control suits its Creator type (choice, date, file, composite, subform, ...); each field's label is its Creator label; each mandatory Creator field is marked required |
| Reports and columns | 1.5 | 1.5 | each report route renders a report headed with the Creator report label; desktop: each Creator column label is shown; phone: the phone quick view columns (or the first four) are shown on the record card; a chart or pivot report renders a chart area |
| Actions | 1 | 1 | each form has a submit button; each Creator form button label is a button; each Creator report custom action is a button; each record of a form-backed report can be opened or edited |
| Empty and error states | 1 | 0.8 | a report with no records shows an empty state; a report whose data call fails shows an error with a retry; submitting a form with an empty mandatory field shows a field error; a slow report shows a busy loading state (measured, not yet scored); a destructive action asks for confirmation first (measured, not yet scored); a second submit while busy posts once (measured, not yet scored); a 403 shows a denied screen with a way home, no dead retry (measured, not yet scored); an unknown route shows a not-found screen with a way home and focus (measured, not yet scored); a write result shows a toast that dismisses or closes (measured, not yet scored); a route change focuses the screen heading and retitles the document (measured, not yet scored) |
| Accessibility basics | 1 | 0.8 | the document has a language and a title; a skip link leads to the main landmark; every navigation landmark has a name; every form control and button on every route has an accessible name; no route repeats an element id; phone: the More control states its popup and expanded state; the sheet is a dialog |
| Responsiveness | 1 | 1 | the page declares a device-width viewport; desktop: the menu is shown and the tab bar is hidden; phone: the menu is hidden and the tab bar is shown; phone: the More sheet is a fixed overlay; phone: report rows become cards or the table scrolls sideways |

## Local corpus

<!-- ui-scores:begin table=8c0b267db28cea334be27b029318e3084b6e01ebc0d59f73e996fb155517198e -->
| | desktop | phone |
|---|---:|---:|
| apps scored | 67 | 67 |
| at or above 8/10 | 67 | 67 |
| mean | 9.49 | 9.81 |
| median | 9.5 | 9.8 |
| lowest | 8.8 | 9.1 |

**67 of 67 apps pass both viewports** (the bar is 8/10 on each).

### Points by criterion (mean over the corpus)

| criterion | desktop | phone | apps losing points (desktop / phone) |
|---|---:|---:|---:|
| Layout parity | 1.43 / 1.5 | 1.43 / 1.5 | 53 / 53 |
| Navigation (desktop menu; phone tab bar and More) | 1.5 / 1.5 | 2 / 2 | 0 / 0 |
| Forms and fields | 1.5 / 1.5 | 1.5 / 1.5 | 32 / 32 |
| Reports and columns | 1.14 / 1.5 | 1.46 / 1.5 | 65 / 40 |
| Actions | 0.98 / 1 | 0.98 / 1 | 35 / 35 |
| Empty and error states | 0.99 / 1 | 0.75 / 0.8 | 4 / 4 |
| Accessibility basics | 1 / 1 | 0.75 / 0.8 | 0 / 0 |
| Responsiveness | 1 / 1 | 1 / 1 | 0 / 0 |

### Failing checks by kind

| check | failing checks | apps |
|---|---:|---:|
| destructive action without a confirm step | 67 | 67 |
| access denied without a denied screen and a way home | 67 | 67 |
| unknown route without a not-found screen, a way home and focus | 67 | 67 |
| route change does not focus the screen heading or retitle the document | 67 | 67 |
| report column not shown on desktop | 2733 | 65 |
| a second submit while busy posts again | 60 | 60 |
| write result without a dismissible toast | 60 | 60 |
| not-generated placeholder on a route | 169 | 53 |
| phone record card hides or does not label a column | 169 | 40 |
| mandatory field not marked required | 65 | 32 |
| record cannot be opened or edited from the report | 88 | 30 |
| report custom action missing | 52 | 10 |
| report without an empty state | 8 | 4 |
| report without an error state and retry | 8 | 4 |

### Per app

Apps are numbered in sorted corpus order. "Short" lists the criteria below full marks as points/weight.

| # | desktop | phone | result | short on desktop | short on phone |
|---:|---:|---:|---|---|---|
| 1 | 9.4 | 10 | pass | reports 0.9/1.5 |  |
| 2 | 9.5 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.2/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5, actions 1.0/1 |
| 3 | 8.9 | 9.1 | pass | layout 1.3/1.5, reports 1.0/1.5, actions 0.9/1, states 0.8/1 | layout 1.3/1.5, reports 1.2/1.5, actions 0.9/1, states 0.6/0.8 |
| 4 | 9.9 | 9.9 | pass | layout 1.4/1.5 | layout 1.4/1.5 |
| 5 | 9.2 | 9.8 | pass | layout 1.4/1.5, reports 0.9/1.5, actions 0.9/1 | layout 1.4/1.5, actions 0.9/1 |
| 6 | 9.9 | 9.8 | pass | forms 1.5/1.5, reports 1.4/1.5 | forms 1.5/1.5, reports 1.4/1.5 |
| 7 | 9.6 | 9.8 | pass | layout 1.4/1.5, reports 1.3/1.5, actions 1.0/1 | layout 1.4/1.5, actions 1.0/1 |
| 8 | 9.4 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.1/1.5 | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5 |
| 9 | 9.5 | 9.7 | pass | layout 1.3/1.5, reports 1.3/1.5 | layout 1.3/1.5 |
| 10 | 9.3 | 9.6 | pass | layout 1.4/1.5, reports 1.0/1.5, actions 0.9/1 | layout 1.4/1.5, reports 1.3/1.5, actions 0.9/1 |
| 11 | 9.6 | 9.7 | pass | layout 1.3/1.5, forms 1.5/1.5, reports 1.4/1.5 | layout 1.3/1.5, forms 1.5/1.5, reports 1.5/1.5 |
| 12 | 9 | 10 | pass | reports 0.5/1.5 |  |
| 13 | 9.7 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, actions 1.0/1 |
| 14 | 9.4 | 9.9 | pass | layout 1.5/1.5, forms 1.5/1.5, reports 1.0/1.5 | layout 1.5/1.5, forms 1.5/1.5 |
| 15 | 9.3 | 9.7 | pass | layout 1.4/1.5, reports 1.0/1.5, actions 0.9/1, states 1.0/1 | layout 1.4/1.5, reports 1.4/1.5, actions 0.9/1, states 0.7/0.8 |
| 16 | 9.4 | 9.9 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.1/1.5 | layout 1.4/1.5, forms 1.5/1.5 |
| 17 | 9.8 | 9.8 | pass | layout 1.4/1.5, reports 1.4/1.5 | layout 1.4/1.5, reports 1.4/1.5 |
| 18 | 9.9 | 9.8 | pass | layout 1.5/1.5, forms 1.5/1.5, reports 1.5/1.5 | layout 1.5/1.5, forms 1.5/1.5, reports 1.4/1.5 |
| 19 | 9.2 | 9.8 | pass | layout 1.3/1.5, reports 1.0/1.5 | layout 1.3/1.5, reports 1.5/1.5 |
| 20 | 9.6 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.2/1.5 | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5 |
| 21 | 9.7 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5 | layout 1.4/1.5, forms 1.5/1.5, reports 1.5/1.5 |
| 22 | 9.5 | 9.5 | pass | layout 1.3/1.5, reports 1.3/1.5, actions 0.9/1, states 0.9/1 | layout 1.3/1.5, reports 1.4/1.5, actions 0.9/1, states 0.7/0.8 |
| 23 | 9.3 | 9.9 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 0.9/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, actions 1.0/1 |
| 24 | 9.2 | 9.8 | pass | layout 1.4/1.5, reports 0.8/1.5 | layout 1.4/1.5 |
| 25 | 9.2 | 9.8 | pass | layout 1.3/1.5, reports 1.0/1.5, actions 1.0/1 | layout 1.3/1.5, actions 1.0/1 |
| 26 | 9.6 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.3/1.5 | layout 1.4/1.5, forms 1.5/1.5, reports 1.5/1.5 |
| 27 | 9.6 | 9.9 | pass | layout 1.5/1.5, reports 1.2/1.5, actions 1.0/1 | layout 1.5/1.5, reports 1.4/1.5, actions 1.0/1 |
| 28 | 9.2 | 9.9 | pass | layout 1.4/1.5, reports 0.8/1.5 | layout 1.4/1.5 |
| 29 | 9.6 | 9.9 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.3/1.5 | layout 1.4/1.5, forms 1.5/1.5 |
| 30 | 9.6 | 9.9 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.2/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, actions 1.0/1 |
| 31 | 9.4 | 9.9 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.0/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, reports 1.5/1.5, actions 1.0/1 |
| 32 | 9.5 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.2/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5, actions 1.0/1 |
| 33 | 9.4 | 9.9 | pass | reports 1.0/1.5, actions 1.0/1 | actions 1.0/1 |
| 34 | 9.8 | 9.8 | pass | layout 1.5/1.5, forms 1.5/1.5, reports 1.4/1.5, actions 1.0/1 | layout 1.5/1.5, forms 1.5/1.5, reports 1.5/1.5, actions 1.0/1 |
| 35 | 9.7 | 9.8 | pass | layout 1.4/1.5, reports 1.4/1.5, actions 1.0/1 | layout 1.4/1.5, reports 1.4/1.5, actions 1.0/1 |
| 36 | 9.2 | 9.9 | pass | layout 1.5/1.5, forms 1.5/1.5, reports 0.8/1.5, actions 1.0/1 | layout 1.5/1.5, forms 1.5/1.5, reports 1.5/1.5, actions 1.0/1 |
| 37 | 9.2 | 9.9 | pass | layout 1.4/1.5, reports 0.8/1.5 | layout 1.4/1.5 |
| 38 | 9.3 | 9.6 | pass | layout 1.3/1.5, reports 1.1/1.5, actions 0.9/1, states 0.9/1 | layout 1.3/1.5, reports 1.4/1.5, actions 0.9/1, states 0.7/0.8 |
| 39 | 9.5 | 9.9 | pass | layout 1.4/1.5, reports 1.1/1.5, actions 1.0/1 | layout 1.4/1.5, reports 1.5/1.5, actions 1.0/1 |
| 40 | 9.3 | 9.8 | pass | layout 1.4/1.5, reports 0.9/1.5 | layout 1.4/1.5, reports 1.4/1.5 |
| 41 | 9.6 | 9.8 | pass | layout 1.5/1.5, reports 1.2/1.5, actions 1.0/1 | layout 1.5/1.5, reports 1.4/1.5, actions 1.0/1 |
| 42 | 9.9 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.5/1.5 | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5 |
| 43 | 9.4 | 9.7 | pass | layout 1.3/1.5, forms 1.5/1.5, reports 1.2/1.5 | layout 1.3/1.5, forms 1.5/1.5, reports 1.4/1.5 |
| 44 | 9.8 | 9.9 | pass | layout 1.5/1.5, forms 1.5/1.5, reports 1.4/1.5 | layout 1.5/1.5, forms 1.5/1.5 |
| 45 | 9.7 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5 | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5 |
| 46 | 9.4 | 9.7 | pass | layout 1.3/1.5, forms 1.5/1.5, reports 1.1/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, reports 1.5/1.5, actions 1.0/1 |
| 47 | 9.5 | 9.8 | pass | reports 1.1/1.5, actions 0.9/1 | reports 1.4/1.5, actions 0.9/1 |
| 48 | 9.9 | 9.9 | pass | layout 1.4/1.5, reports 1.5/1.5 | layout 1.4/1.5, reports 1.5/1.5 |
| 49 | 9.6 | 9.9 | pass | reports 1.2/1.5 | reports 1.4/1.5 |
| 50 | 9.9 | 9.9 | pass | layout 1.5/1.5, forms 1.5/1.5, reports 1.4/1.5, actions 1.0/1 | layout 1.5/1.5, forms 1.5/1.5, actions 1.0/1 |
| 51 | 9.7 | 9.8 | pass | forms 1.5/1.5, reports 1.3/1.5, actions 1.0/1 | forms 1.5/1.5, reports 1.4/1.5, actions 1.0/1 |
| 52 | 8.8 | 9.7 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 0.5/1.5, actions 0.9/1 | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5, actions 0.9/1 |
| 53 | 9.2 | 9.9 | pass | layout 1.4/1.5, reports 0.8/1.5 | layout 1.4/1.5 |
| 54 | 9.4 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.1/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, reports 1.5/1.5, actions 1.0/1 |
| 55 | 9.4 | 9.9 | pass | layout 1.5/1.5, forms 1.5/1.5, reports 1.0/1.5, actions 1.0/1 | layout 1.5/1.5, forms 1.5/1.5, actions 1.0/1 |
| 56 | 9.5 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.1/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, reports 1.5/1.5, actions 1.0/1 |
| 57 | 9.7 | 10 | pass | reports 1.2/1.5 |  |
| 58 | 9.5 | 10 | pass | reports 1.1/1.5 |  |
| 59 | 9.7 | 9.8 | pass | layout 1.4/1.5, forms 1.5/1.5, reports 1.3/1.5, actions 1.0/1 | layout 1.4/1.5, forms 1.5/1.5, reports 1.4/1.5, actions 1.0/1 |
| 60 | 9.9 | 9.9 | pass | layout 1.4/1.5 | layout 1.4/1.5 |
| 61 | 9.3 | 9.8 | pass | reports 0.9/1.5, actions 0.9/1 | reports 1.4/1.5, actions 0.9/1 |
| 62 | 9.3 | 9.6 | pass | layout 1.2/1.5, reports 1.1/1.5, actions 1.0/1 | layout 1.2/1.5, reports 1.4/1.5, actions 1.0/1 |
| 63 | 9.5 | 9.9 | pass | reports 1.1/1.5, actions 1.0/1 | actions 1.0/1 |
| 64 | 9.4 | 10 | pass | reports 0.9/1.5 |  |
| 65 | 9.1 | 9.8 | pass | reports 0.9/1.5, actions 0.8/1 | actions 0.8/1 |
| 66 | 9.7 | 9.8 | pass | layout 1.5/1.5, forms 1.5/1.5, reports 1.3/1.5, actions 1.0/1 | layout 1.5/1.5, forms 1.5/1.5, reports 1.4/1.5, actions 1.0/1 |
| 67 | 9.5 | 9.9 | pass | forms 1.5/1.5, reports 1.1/1.5 | forms 1.5/1.5, reports 1.4/1.5 |
<!-- ui-scores:end -->
