# Print templates

A Creator report can name a `print template = <Name>` property. The named
block lives on the report's form (`print template { <Name> { content = {...}
} }`, `record summary { ... }` in older exports) and is a record layout: a
reader opens a report's record, presses Print, and sees that layout filled
with the record's own values, ready for the browser's print dialog ("Save as
PDF"). There is no server-side PDF anywhere in this path.

Both generated web apps draw it. The vanilla target always did
(`packages/ui/src/client/70-print.js`). The React target draws it the same
way, from the same resolved model, with its own component
(`packages/ui-react/template/lib/c2c-ui/report/PrintSheet.tsx`).

## Where the layout comes from

`packages/ui/src/decorations/print-templates.ts` resolves a report's print
template onto the shared UI model (`UiModel.reports[].printTemplate`, a
`UiPrintTemplate`), independent of which UI target eventually renders it:

1. Read the report's `print template` property (`reportProp`).
2. Find the matching child block on the report's form, under a `print
   template` or `record summary` parent block (`templateBlock`).
3. Parse that block's `content` property as JSON and walk its `mainLayout`
   (and, when enabled, `header`/`footer`) into a tree of typed elements
   (`elementOf`).

A property that names a template the form does not have, or a block with no
parseable `content`, is a todo with no manual step — the template never
resolved, so there is nothing to recreate by hand.

### Element types

| Creator export shape | `UiPrintElement.type` | drawn as |
|---|---|---|
| `columns` (`split`, `collayouts`) | `columns` | a flex row of columns, split widths from `split` |
| `text` (`content`, an HTML string) | `text` | sanitized HTML, `${Field}` placeholders filled from the record |
| `fields` (`Label_Name`, `labelText`) | `field` | a label/value pair |
| `lookupfields` (`Label_Name`, `refFields`) | `lookup` | a related-record table |
| `image` (`src` or `Label_Name`) | `image` | an `<img>`, field-bound or static |
| `spacer` (`height`) | `spacer` | a fixed-height gap |
| anything else | `todo` | a visible placeholder paragraph, and a counted manual-step todo naming the feature (see [Unsupported features](#unsupported-features)) |

`header`/`footer` (Creator's `isHeaderEnabled`/`isFooterEnabled` toggle and
`header`/`footer` content blocks) parse into the same element tree, drawn
once above/below the body. Plain CSS has no reliable way to repeat arbitrary
HTML on every physical page a browser's print engine lays out, so this is not
a running header/footer the way a dedicated PDF renderer could draw one — it
is a once-per-print header/footer, which is what both targets draw.

## Rendering: untrusted content, two places it is checked

A print template's own markup is something an app's builder wrote in
Creator's drag-and-drop template editor, not something this pipeline
generated — it is untrusted the same way a Creator ZML page snippet is
(`docs/security-model.md`). A record's field values are untrusted for the
ordinary reason: user data. Both get checked before they reach the page:

- **`${Field}` placeholders are filled, then escaped, before the sanitizer
  runs.** A `text` element's `content` string is scanned for `${Name}`
  placeholders; each is replaced with the record's value for that field,
  HTML-escaped, in one pass — so a record value can never itself contain a
  placeholder that gets filled again, and a value that lands inside an
  attribute (`href`, `src`, `style`) is escaped first and only then subject
  to the same URL/style checks as the template's own markup.
- **The filled HTML goes through the page's own sanitizer**, the same
  allowlist the generator already applies to every other HTML snippet in the
  app (`sanitizeSnippet` — an allowed-tag/allowed-attribute list, `on*` and
  `srcdoc` attributes refused, `href`/`src` refused when they start with
  `javascript:`, `data:` or `vbscript:`, and an inline `style` attribute run
  through the same declaration-by-declaration allowlist report conditional
  formatting uses). React's `PrintSheet` imports the same
  `pages/sanitize.ts` module `PageView` uses; nothing is parsed or rendered
  with a second, bespoke rule set.
- **A `field`/`lookup` element's label and value are plain React/DOM text
  nodes**, never HTML — React escapes them by construction, so there is
  nothing to sanitize there.
- **An `image` element's `src`** (static or field-bound) is checked against
  the same `javascript:`/`data:`/`vbscript:` refusal before it reaches an
  `<img>` tag, independently of the sanitizer pass (it is a plain attribute,
  not HTML the sanitizer parses).
- **Every inline style** (`style`, `labelStyle`, `valueStyle`,
  `valueTextStyle`, `wrapperStyle`, `labelTextStyle`, a `templateStyle` on the
  layout container) is split into declarations and each one is checked
  against the same property/value allowlist as report conditional formatting
  (`style-allowlist.ts`): `url(`, `expression(`, `@import`, `-moz-binding`,
  quotes and CSS comments are refused, and a `calc()`/colour/transform
  function call is only kept when its own arguments are plain numbers. A
  declaration the allowlist refuses is dropped from the rendered style and
  counted once at generation time (`Print template "X": Inline style
  declarations not carried over ...`) — the *rendered* page never shows which
  declaration was dropped; that record lives in the migration report, not in
  the page's DOM, since a `data-style-dropped` attribute visible to every
  reader would advertise exactly what content a builder tried and failed to
  inject.

This is the same two-layer shape the vanilla target and the sendmail
`template:` attachment renderer (`packages/shims/src/print-template.ts`) both
use: resolve the data once, sanitize again at the point each target actually
turns it into HTML a document loads.

## The React runtime

`ReportSpec.printTemplate` (`packages/ui-react/template/lib/c2c-ui/types.ts`)
carries the same tree, mapped 1:1 from the UI model in
`packages/ui-react/src/reports.ts`. `ReportView`'s record-detail route shows
a Print button whenever the report has one; pressing it opens `PrintSheet` as
a full-screen overlay over the already-loaded record (the same record the
detail route fetched — no second request). The overlay's own bar offers
Close and Print; Print calls `window.print()`. `print.css`
(`@media print`) hides everything in the document except the open sheet, so
what prints is the template, not the app shell — the same contract the
vanilla target's `BASE_CSS` print rules enforce. Printed content avoids
breaking a field row, a lookup table row, or the header/footer block across a
page boundary (`break-inside: avoid`); Creator's own page-break and
page-number options are not modeled (no fixture in this pipeline's test apps
uses them with a resolved template), so a reader gets the browser's default
pagination inside the sheet.

No PDF is generated anywhere in this path, on either target: "Save as PDF"
is the reader's own print dialog, a browser capability this code never calls
into.

## Unsupported features

A print template element kind `elementOf` does not recognize (anything other
than `columns`, `text`, `fields`, `lookupfields`, `image`, `spacer`) parses to
a `type: 'todo'` element. Both targets draw it as a visible `.todo`
placeholder paragraph naming the feature, and the decoration additionally
pushes one counted manual-step todo per occurrence (recursing into nested
columns, the header and the footer):

> Print template "Name" uses a `<feature>` element; the generated print
> layout does not draw it.
>
> manual step: Recreate the `<feature>` element by hand in the "Name" print
> layout on report `<Report>` — this is not generated.

This is never a silent drop: every element the parser cannot place still
shows up on the printed sheet (so a reader sees something is missing, not a
gap) and in the migration report (so the app owner knows what to recreate
and where).
