# Report export and print (React target)

A list report draws three toolbar buttons when it has rows: **Export CSV**, **Export XLSX** and **Print**.
`toolbar { show export = false }` removes the two export buttons (carried as `showExport: false`); Print stays.

## What an export holds

- The data columns of the report, in report order. Action and bulk-select columns are not data and are left out.
- The rows the table shows, in the order it shows them (group-by lanes included), after the search and the named filter. The cell text is the table's own text (app date format, grouped numbers, composite values); a blank cell carries the table's own blank mark, so a file matches the screen cell for cell.
- Only the page on screen. When more pages exist, the notice under the toolbar says so ("This is page N; other pages are not included").
- A direct PDF export is not offered. Print opens a print view whose dialog saves a PDF; the verifier counts the PDF check as a gap.

## Print

The print stylesheet (`report/print.css`) hides the top bar, menu, tab bar, toolbar, search, bulk controls, pagination, row actions and the action and select columns, lifts the table's scroll box so every row prints, and shows a one-line filter summary (report, filter, search). Earlier, a rule that hid every `body` child blanked the whole app when printing.

## Security

- **Formula injection.** A CSV cell whose text starts with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe, headers included. A plain negative number (`-12.50`) is left alone. An XLSX cell is always an inline string, never a formula (`<f>` is never written).
- **File name.** The name comes from the report label reduced to letters, digits, dot, underscore and dash, at most 64 characters, never starting or ending with a dot or dash; `report` when nothing is left. No path separator can survive.
- **Size.** An export carries at most 10,000 data rows; the notice names how many were left out. The rows come from the loaded page, so the page size bounds it first. Control characters are dropped from XLSX text; the XLSX is a stored ZIP built in memory with no compression, so there is no decompression to bound.
- **No network.** Export is built in the browser from rows already loaded; it makes no request and reads no other data.
