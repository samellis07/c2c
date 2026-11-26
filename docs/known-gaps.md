# Known Gaps

These are intended fidelity boundaries; individual analyzer and report behavior must be verified for each input.

- Residual TODOs are counted per app and per kind by `c2c analyze` and recorded in `docs/determinism-status.md`; that document is the reference, and its figures must be recomputed on the release head before they are quoted.
- Server-side Deluge snippets require manual translation (`docs/ui.md`, `docs/fill-todos.md`). Client conditions that read server data, unsupported `openUrl` shapes, camera, lens and scan limits, CSS the sanitizer refuses, and unsupported navigation targets are also reported as manual steps.
- Unsupported or dynamic `openUrl` targets and markup the sanitizer drops are reported as manual steps (`docs/report-action-navigation.md`, `docs/ui.md`).
- Unsupported workflow approver forms (form-field, reporting-level) are denied by the endpoint and counted in `migration-report.json` (`approver-field`, `approver-reporting-level`) (`docs/ui.md`).
- Checkpoint and state files are written by `packages/data/src/checkpoint-file.ts`; inspect them before reuse.
- The toolbar setting is not carried; fields marked private or personal data get no generated privacy control; report `permission` blocks have no generated equivalent (`docs/determinism-status.md`).
- This release's documentation does not record a run of the generated output against a deployed Catalyst project or live Zoho; test the deployment before relying on it.
- Creator placement relative to On Validate and other items marked `[UNVERIFIED]` in the source documentation remain unverified (`docs/ui.md`).
- The determinism status document hides the names of your forms, fields, reports, pages, functions, workflows and option labels, and the free-text values a source app sets in the sentences it prints (a field `target`, `aspect ratio`, `displayformat`, `duration`, allowed days, time display options, a code value, a reverse lookup name, a function or click-action name, an unknown tag, field type or report type, and every option label, digits included): each such value is shown as `(app identifier)` unless it is a short number (up to four digits per part), a boolean or a short list of Creator keywords. It is not a guarantee. What can still show app wording: a short number you set as a value (for example a four-digit code in a barcode value or a reverse lookup name); a name written in lower case that is exactly a common word the status sentences already use (for example `status`, `value` or `target`) wherever that word is not in a recognised name position of a sentence; a report settings block or blueprint block or property whose name is a Creator keyword; numbers and true/false values, which are printed as they are; a CSS property name in a dropped-style line, which is printed when it is a plain lower-case CSS word; and any sentence added after this list was taken, which prints its names until its slot is added. Review `docs/determinism-status.md` for your own app wording before publishing a status document generated from a private app.
- A report grouped or measured by a lookup field blanks the id of a parent row the caller cannot read, in batches of 300 parent ids per read. The display text a report shows for a lookup is resolved in the same batches of 300.
- A lookup that holds several values is handled when it is stored as a list. A multi-value lookup stored as one comma-separated text value is not resolved or checked as a lookup.
- A field name of tens of thousands of characters (about 40,000 or more) makes the status command stop with a regular-expression error that prints the name in its error output, and no status document is written. Keep names short, and do not share that error output if the name is private.
- The status command's wording rules are slow (the time grows with the square of the length) on a single sentence of hundreds of kilobytes; a sentence of about 450 KB took several seconds in testing.

## Manual steps that come from broken references in the source app

Some manual steps are not platform limits. The source app refers to something that does not exist, and the converter does not guess a nearest match, because a guessed destination or field would send users somewhere the original never went. The generated app keeps the rest of the behavior and counts the broken part as a manual step whose reason names the missing target.

- A `#Form:`, `#Report:` or `#Page:` link, or an `openUrl` target, whose form, report or page is not in the app, or whose pseudo-route is malformed (a misspelled prefix, or a query written without `=`). The navigation is not carried.
- A report or click parameter that names a field the form does not have, or spells it with different capitalization, or passes a variable nothing in the source defines. The click is not wired to a filter.
- An embedded component (`zc-component`) that names a form or report the app does not define, or whose markup is cut off.

To resolve one: read the reason in `c2c analyze` (it names the missing form, field or route), then either correct the reference in the source app and convert again, or wire the navigation or filter by hand in the generated app. These items stay counted in `docs/determinism-status.md` until the reference exists.

## Platform limits and their manual steps

Each row below is a construct that `c2c analyze` reports as a manual step because the generated app cannot reproduce it. The construct names match `docs/determinism-status.md`. For each one: what Creator does, what the generated app does instead, why the two differ, and what to do by hand. Where the reason is a browser or platform rule rather than something this tree enforces, the row says so.

### Fields

| Construct | Creator | Generated app | Why it differs | Manual step |
| --- | --- | --- | --- | --- |
| Video field `duration = N` | Stops recording at N seconds in its own capture dialog. | Hands recording to the device camera app; there is no recording-length limit. | The generated field does not host a capture dialog, so no timer can stop the device's recorder. | Enforce the limit by hand: a client-side timer, a server-side rejection of longer uploads, or accept any length. |
| Image field `annotation = true` | Lets the user draw or mark up the photo before it is stored. | Accepts the chosen file unchanged. | No drawing tool is generated for the image field. | Add a markup step before the upload, or accept unmarked photos. |
| Image field `show onload = true` | Opens the camera when the form opens. | Opens the camera only when the user taps the control. (A scan field with this setting does open its scanner on load.) | The generated image field is a file input started by a user action. A browser's rule that camera and file pickers start from a user gesture is the underlying reason; this tree does not test it. | Trigger the camera for that field when the form loads, by hand in the console, where your target browsers allow it. |
| Scan field `camera = <lens>` | Chooses the lens. | The primary and secondary lenses are generated. Any other value is a manual step and the scanner opens the primary camera. | The generated browser scanner offers those two lenses only. | Choose the lens you need when the field scans. |
| File field `browse` with `google_docs` or `zoho_docs` | Offers those document stores in the picker. | Uploads from the local drive only. The field carries a note saying so; it is not a counted TODO. | Catalyst has no equivalent document-store picker. | Download the file and upload it, or build a reviewed integration. |

### Reports

| Construct | Creator | Generated app | Why it differs | Manual step |
| --- | --- | --- | --- | --- |
| `customlayouts` settings block on a report | Applies a named custom layout template. | Generates the standard report view and no layout. | Catalyst generates no equivalent for the block. | Apply the layout settings by hand on that report in the console, from the settings the report lists. |
| Report `options` setting the view does not read (for example a timeline `week start day` other than `monday` or `sunday`) | Applies the setting. | Carries `week start day` of `monday` or `sunday`, and the other settings the view reads. Any other `options` entry is counted: "has an `options` setting (...) that Catalyst does not carry into the generated ... report". | The generator proves each option it carries; the rest have no generated home. | Apply the setting by hand on that report. |
| Built-in record column (for example `Added_Location`, or `Record_Status` where no status column exists) | Lists the column. | The column is left out. | The generated schema has no column for it. | Add a column, or a manual note, that stands in for it. |
| Map report on a form with no address field | Plots pins. | Shows the same rows as a list. | A map needs stored latitude and longitude; none are invented. | Add an address field, fill in its coordinates, point the report's display field at it, and regenerate. |
| Custom action: `Custom action ... is not migrated` | Runs the action's workflow from a report button. | The button is turned off. An action whose workflow opens an external URL or calls an integration task carries that detail in its reason. | An action is migrated only when its workflow generates a function or is a navigation to an own-app screen. | Rebuild the action as a generated workflow or a Catalyst function and wire the button to it. |
| Custom action: `navigation (openUrl) inside it is not carried over` | Runs the workflow, then navigates. | Runs the workflow; the button reports success and does not navigate. | The navigation is dropped when it is a second `openUrl`, a `#Script` pseudo-route, or a target that cannot be resolved. | Wire the navigation in the generated UI by hand. The manual step names the reason. |

### Pages and snippets

| Construct | Creator | Generated app | Why it differs | Manual step |
| --- | --- | --- | --- | --- |
| `The <script> element is removed from this page snippet by the sanitizer` | Runs the script. | The element is removed, always in full. | A script body is always executable, so no safe subset exists. | Reimplement the behavior as a client handler or a generated function. |
| `The <iframe> element is removed from this page snippet by the sanitizer` | Embeds the framed page. | The element is removed. | The sanitizer keeps no `<iframe>` subset, and the generated page's content security policy allows frames only from the app itself and one video host. | Embed the content through a reviewed route of the app, or link to it. |
| `Static <style> CSS not carried over` and `Inline style declarations not carried over`, for `background` and `background-image` | Loads a background image from any host. | A `url()` that fetches the app's own origin, or a `data:image` URI, is kept. A remote or protocol-relative `url()` is dropped, and the counted entry names the property. | A remote `url()` is a way to fetch from, or leak to, another host, and no syntax check separates a safe use from an attack. The page's policy also allows images only from the app itself and `data:`. | Host the image with the app (or inline it as a `data:` URI) and point the style at it. |
| `Static <style> CSS not carried over` counted as `CSS built by a Deluge tag` | Builds CSS with Deluge at render time. | A computed number inside a style body is carried as a custom property the page sets; other rules built by a Deluge tag are counted. | The generated page ships fixed CSS, so only the computed-number shape has a generated home. | Rewrite the counted rules as static CSS. |
| `Embedded zc-component form ... has no generated view` | Embeds a form. | No component is drawn for that embed. | The embedded form has no generated view to include. | Embed a form or report the app does generate, or link to it. |
| `ZML <pc>` and `ZML <text>` `click parameters ... are not generated` | Passes the parameters when the element is clicked. | Wires a click only for one static equality or a named filter. | A parameter that is not one of those (for example a Deluge expression) has no filter the report endpoint accepts. | Wire the parameters to the generated click handler by hand. |
| `Server-side Deluge snippet requires manual translation` | Runs Deluge when the snippet renders. | One counted manual step, with reasons from a fixed list (`write`, `render-navigation`, `caller-read`, `markup-function`, `dynamic-url`, `sanitizer-loss`, `untranslated`) and the page named. | A snippet that writes, sends mail, or calls out on render is always refused, and other shapes stay manual when they cannot be proved safe. | Translate the snippet by hand using the reasons, then retest the page (`docs/ui.md`, `docs/fill-todos.md`). |

### Deluge functions and mail

| Construct | Creator | Generated app | Why it differs | Manual step |
| --- | --- | --- | --- | --- |
| `openurl-unsupported-target` | A function whose body is an `openUrl` goes anywhere. | No function is generated. | The target is not an own-app form, report, or page link (`docs/report-action-navigation.md`). | Reconfigure the function's navigation. |
| `openurl-dropped-with-server-logic` | Runs server logic, then navigates. | The server logic is kept; the navigation after it is dropped. | A function that does server work cannot return client navigation. | Wire that navigation in the generated UI. |
| `openurl-dropped-unrecognized-branch-shape` | Navigates from any branch layout. | The server logic is kept; the `openUrl` is dropped. | Only a bare `openUrl`, or an `if` whose branches are each one `openUrl` after plain assigns, is recognized. | Wire that navigation by hand. |
| `sendmail-attachment:view` | Attaches a report view as a file. | The mail carries a typed descriptor; no file is rendered. | Catalyst Mail cannot render a Creator report view into a file (`docs/fill-todos.md`). | Render the matching rows in a Catalyst function, attach the file, and send a test mail. |
