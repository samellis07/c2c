# Arc Library in @c2c/ui

`arc/` holds component source vendored from Arc Library, shadcn-style: plain
source we own and adapt, not an npm dependency.

- Upstream: https://github.com/kuratlielia/arc-library (MIT, Copyright (c) 2026 Elia Kuratli; licence in `arc/LICENSE`)
- Pinned upstream commit: `86330cc9270c4acc55b7204c9583fcbaa378192c`
- Vendored: `registry/foundation.css` (design and motion tokens), `registry/motion-tokens.ts`, and the components `button`, `input`, `alert`, `empty-state`, `sortable-data-table`, `pagination`, `filter-toolbar`, `combobox`, `number-field`, `money-input`, `phone-input`, `date-picker`, `time-picker`, `select`, `multi-select`, `checkbox`, `radio-cards`, `file-dropzone`, `signature-pad`, `rich-text-editor`, `textarea`, `metric-card`, `animated-counter` (used by `metric-card`), `bar-chart`, `line-chart`, `donut-chart`, `stepper`, `timeline`, `dialog`, `comment-thread` (each `.tsx` with its `.module.css`, from `registry/components/<name>/`). Only components the generated apps use are vendored; a change that needs another Arc component vendors it the same way and adds a row below. `dialog` needs `@radix-ui/react-dialog`, pinned in `package.json`.

## Local changes

| file | change | why |
|---|---|---|
| every component | `@/lib/motion-tokens` import becomes `../../motion-tokens` | no path alias in generated apps |
| `sortable-data-table.tsx` | `ResizeObserver` use guarded; `getComputedStyle` taken from the table's own window | the app can be booted into a document of another realm (a test or scoring harness) |
| `number-field.tsx` | `empty` and `onClear` props: an unset value shows no number, and a draft with no digits commits as a clear instead of returning to the last value | a stored number can be emptied on an edit form; empty is not 0 |
| `sortable-data-table.tsx` | cells carry `data-th` (the column label) and `data-phone` (shown on the phone card); the column type gains `phone` | phone record cards and the report contract in docs/react-target.md |
| `pagination.tsx` | `ResizeObserver` use guarded | the app can be booted into a document of another realm (a test or scoring harness) |
| `combobox.tsx` | `ResizeObserver` taken from the control's own window and skipped when absent; the outside-click listener goes on the control's own document | same realm reason as the data table |
| `combobox.tsx` | new props `hideLabel` (label kept for assistive technology only), `footer` (content below the options in the open menu) and `onOpenChange`; `.footer` and `.srOnly` added to the module CSS | lookup pickers: a grid cell is named by its column header, and the menu carries the lookup paging controls (load more, retry) |
| `combobox.tsx` | `aria-describedby` joins the hint id with the caller's own (an error message) instead of replacing it | field errors stay announced with the control |
| `multi-select.tsx` | the outside-click listener goes on the control's own document | same realm reason as the data table |
| `multi-select.tsx` | new props `searchable` (a search box at the top of the open menu filtering by label; the menu is a wrapper around the listbox, Escape returns focus to the trigger), `emptyMessage`, `hideLabel`, `footer`, `onOpenChange` and `invalid` (`aria-invalid` on the trigger); `.listbox`, `.search`, `.empty`, `.footer` and the invalid border added to the module CSS | multi lookups: searchable options over paged lookup reads, and grid cells |
| `combobox.tsx`, `multi-select.tsx` | Enter in an open menu is always consumed: it chooses the highlighted option, or the first enabled match of a typed search, else does nothing (`enterAction` in the new `combobox/keys.ts`, shared by both) | the controls sit inside a submitting form, where an Enter that gets through posts the whole record |
| `multi-select.tsx` | each option has an id and `tabIndex={-1}`; the trigger (or the search box when `searchable`) carries `aria-activedescendant` for the highlighted option; new prop `describedBy` (`aria-describedby` on the trigger) | the arrow-key highlight is announced while focus stays put, and a multi lookup error is linked to its control |
| `bar-chart.tsx`, `line-chart.tsx`, `donut-chart.tsx`, `animated-counter.tsx` | `useInView` comes from `../../in-view` (a local file) instead of `motion/react` | motion's `useInView` throws where the window has no `IntersectionObserver`; the local hook observes with the element's own window and treats such a document as in view, so a chart draws in a test or scoring harness |
| `metric-card.tsx` | optional `decimals` prop, passed to `AnimatedCounter` | dashboard sums carry cents |
| `in-view.ts` (new file, not upstream) | the guarded `useInView` above | see the row above |
| `stepper.tsx` | `getComputedStyle` taken from the element's own window | the app can be booted into a document of another realm |
| `timeline.tsx` | `document.activeElement` read through the scroller's owner document | the app can be booted into a document of another realm |
| `dialog.tsx` | `DialogContent` gains an optional `container` prop passed to the portal | the overlay must mount into the app's own document body |
| `comment-thread.tsx` | `requestAnimationFrame` taken from the node's own window, with a timeout fallback | the app can be booted into a document of another realm |

Everything else is byte-identical to upstream at the pinned commit.

## Taking an upstream update

Updates are deliberate, never automatic:

1. Read the upstream changelog between the pinned commit and the candidate commit.
2. Fetch the changed files for the vendored components only (raw files at the new commit).
3. Re-apply the local changes in the table above; keep the table accurate.
4. Update the pinned commit here.
5. Regenerate a gallery app, run its type check and build, and score it; the bundle budget and the UI score must hold.

Arc's own peer packages (motion, lucide-react, Radix primitives) are pinned in the app's `package.json`; bump them in the same change when the new upstream needs it.
