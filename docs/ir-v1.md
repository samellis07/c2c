# IR v1

IR v1 is the typed model of a Zoho Creator application. It is derived from
the lossless CST (`packages/core/src/cst.ts`) by `deriveIr` / `parseProject`
(`packages/core/src/ir.ts`, `packages/core/src/parse.ts`). TypeScript types in
`ir.ts` are the normative schema; this page explains them.

## Design rules

1. **The CST is the source of truth.** `print(parse(src)) === src` byte for byte.
   The IR is a view: every IR node carries a `span` (`start`, `end` UTF-16
   offsets, plus `file` for multi-file projects) pointing back at the source.
2. **Nothing is dropped.** A construct the deriver does not recognise at a
   modelled level goes to `unknown[]` with its exact text and span. A construct
   it recognises but does not model goes to `unmodelled[]` with its span (empty
   on both local corpora in v1).
5. **Coverage is measured.** `deriveIr` records, for every CST statement it
   turns into IR, the role it plays (`report.column`, `workflow.handler`,
   `deluge`, ...). `c2c corpus` reports modelled vs preserved-only statements
   by kind (`coverage.ts`); preserved-only statements are still in the CST but
   invisible to generators.
3. **Deluge is raw.** Embedded Deluge is a `RawDeluge { text, span }`: the exact
   source between the delimiters. The Deluge AST is a later phase.
4. **Values are verbatim.** `Property.value` is the source text after `=`
   (strings keep their quotes). Convenience fields such as `displayName` are
   decoded string values.

## Parsing model (how the CST is built)

The `.ds` grammar is not published; these rules come from real exports.

- **Tokens:** whitespace, newlines (`\n`, `\r\n`, `\r`), `//` and `/* */`
  comments, strings (`"..."` with backslash escapes and possibly spanning lines;
  `'...'` on one line), numbers (`200px` is one number token), identifiers
  (Unicode letters allowed) and punctuation. A character that cannot start a
  token (an unterminated quote) becomes a `bad` token; lexing never fails.
- **Groups:** `{}`, `()` and `[]` are matched into groups. A stray closer stays a
  token and an unclosed opener runs to end of file; both are reported in
  `Document.errors`.
- **Statements:** block and paren bodies are split into statements on newlines,
  except that a statement continues when the next line starts with `{` or `(`
  (`form Book` ⏎ `{`), or the line ends in `=`, `,` or an operator. Several
  `key = value` pairs on one line are split before the next key
  (`Name ( type = text width = 200px )`); a string or number value followed by
  words starts a new statement (`icon = "x"  show all rows from Y`). A `;` ends a
  statement.
- **Statement kinds:** `property` (`key words = value`), `block`
  (`header words { ... }`, also `ret name(args) { ... }`), `call`
  (`header words ( ... )`), `pairs` (`key : value, ...`), `word` (bare words,
  dotted references, comma lists), `group` (a lone `[ ... ]`), `unknown`.
  Header words may be dotted (`on user input of Sub.Field`).
- **Raw groups:** `custom deluge script ( ... )`, `on click ( ... )`, and brace
  bodies that look like Deluge (contain `;` plus a call, member access or Deluge
  keyword) are not split further.

## Schema

`ir.ts` is normative; this is a map.

```ts
App {
  irVersion: 1
  name?, shape, header?, settings: Property[]
  sections: Section[]           // menu sections with component refs (+ menu-entry properties, enclosing space)
  forms: Form[]
  reports: Report[]
  pages: Page[]
  workflows: Workflow[]
  functions: FunctionDef[]
  permissions: Permission[]     // raw {…} permission literals, with the owning profile
  profiles: Profile[]           // share_settings profiles: type, description, permissions, module permissions
  roles: Role[]                 // role hierarchy (nested)
  shareSettings: Property[]     // other share_settings properties (role Hierarchy = …)
  translations: Translation[]   // translation { {json} }: verbatim text + parsed JSON
  configuration: PropertyBlock[]// customize, reports configuration, connections, datasources, …
  apis: PropertyBlock[]         // api <name> { … }
  devices: Device[]             // web / phone / tablet: menus, unused entries, per-device form and report layouts
  unknown: UnknownNode[]
  unmodelled: UnmodelledNode[]
  statementCount: number
  files?: string[]
  widgets?: WidgetSidecar[]    // sidecars/widgets/<name> (html + json, not a .ds). Omitted when none.
}

PropertyBlock { name, properties, blocks: PropertyBlock[], items: string[], span }
                                                          // any settings block: properties, nested blocks, bare words
Property      { key, value, span }                       // `key = value`, and single `key : value` pairs
Form          { name, displayName?, section?, properties, fields, actions: FormAction[], blocks: PropertyBlock[], span }
                                                          // blocks: customize, title, properties, print template,
                                                          // record summary, blueprint components, enable/disable payment
Field         { name, type?, displayName?, modifiers, required, unique, choices?, lookup?, initialValue?,
                properties, subfields: Field[], annotations: PropertyBlock[], flags: string[], span }
                                                          // subfields: composite parts (name, address) and inline subform fields
                                                          // lookup: values = Form.Field or Form[criteria].Field (+ displayformat)
Report        { name, type, modifiers, displayName?, form?, criteria?, basedOn?, flags, section?, properties,
                columns: ReportColumn[], customActions, conditionalFormats, filters, groupBy, sortBy,
                blocks: PropertyBlock[], views: ReportView[], span }
ReportView    { kind: quickview | detailview, device?, layoutType?, layoutProperties, blocks: ReportDataBlock[],
                menus: {placement → items}, actions: {gesture → items}, properties, span }
Page          { name, displayName?, section?, content?, zml: ZmlElement[], references: ZmlReference[], properties, span }
ZmlElement    { tag, attributes, children, start, end }  // tolerant reader (zml.ts); never throws
ZmlReference  { kind, name, via, app? }                  // report/chart/form/panel/… a page points at
Workflow      { name, label?, container?, type?, form?, recordEvent?, actionCondition?, event, deluge: RawDeluge | null, properties,
                approvers?, fieldRules?, blueprint?: { start?, stages, transitions }, span }
FunctionDef   { name, label?, kind: 'creator' | 'deluge' | 'script', signature?, form?, deluge: RawDeluge[], properties, span }
Profile       { name, type?, description?, permissions?, properties, modules: ModulePermission[], span }
ModulePermission { component, properties, reports: Property[], fields: {field, flags}[], span }
Role          { name, description?, properties, children: Role[], span }
Device        { device, customize?, menuPreference?, sections, unused, forms, components, span }
RawDeluge     { text, span }
UnknownNode   { context, keyword?, cstKind, span, text }
UnmodelledNode{ context, keyword, span }
Span          { start, end, file? }
```

### Workflow entries

A workflow definition produces one `Workflow` entry per handler:

- `on validate { actions { custom deluge script ( … ) } }` → event `on validate`.
- `on add { actions { on validate ( … ) on success ( … ) } }` (the 2025 form
  workflow shape) → `recordEvent: "on add"`, events `on validate`, `on success`.
  Statements written directly inside `actions` become an entry with the record
  event as `event`.
- Approvals: `on level 1 { approvers ( … ) on approve { … } }` → event
  `on level 1 / on approve`, with `approvers`.
- Schedules: `on start { actions { on load ( … ) } }` → `on start / on load`.
- Blueprints: `start { start stage = … }`, `stages`, `transitions` with
  `before` / `during` / `after` phases, each with properties, settings blocks
  and Deluge.
- Field rules: `field rules { actions (condition) { hide A, B; } }`.
- `actions (criteria) { … }` stores that criteria on `actionCondition`. Bare names are fields of `form`. The generator runs the handler only when the criteria is true. A criteria that does not translate — an unbound name, or a construct the translator cannot turn into a value — omits the handler body and records `workflow-action-condition` on the migration report. It does not emit `if (todo())`, and it does not run the script unfiltered.

### Changes from v0

- `irVersion` 1; new collections `profiles`, `roles`, `shareSettings`,
  `translations`, `configuration`, `apis`, `devices`.
- Form `customize` and other settings blocks are `Form.blocks`; v0 counted a
  form-level `customize` as a field (1,482 such pseudo-fields on the local
  public corpus).
- Workflow handlers nested in `actions` are separate entries with their own
  event; v0 split a handler's Deluge at nested braces into several entries for
  the same event.
- `share_settings`, report bodies, field bodies, menus and device files are
  modelled instead of preserved-only.

### Shapes

| shape | meaning | detection |
|---|---|---|
| `A` | 2016-style monolithic export | top-level `application`, header `Version` major ≥ 2 |
| `B` | 2024/2025 monolithic export | top-level `application`, any other `Version` |
| `C` | one file of a multi-file export | no `application`; starts at `form`, `menu`, `forms`, a report keyword, `Name as "Label" { type = ... }`, a profile `"Name" { ... }`, a function `ret name(args) { ... }`, settings only, or a ZML page |
| `deluge` | a bare Deluge script (custom function file) | none of the above, contains `;` |
| `empty` | comments/whitespace only | |
| `unknown` | anything else | |

The `Version` comment is not a reliable format id, so A/B is a
heuristic; it only affects reporting, not parsing.

### Multi-file projects

`parseProject(dir)` parses every `.ds` file under `dir` and merges the IRs.
Spans carry `file` (relative to `dir`). A form declared in a component file and
re-declared in `devices/*/forms.ds` (layout properties only) is merged into one
form. Menu files (`menu { space { section { form X { icon } } } }`) produce
section component references, not form definitions.

### What counts as Unknown

At modelled levels (document, application, section, form, workflow, functions)
a statement is Unknown when its CST kind is `unknown`, or when it is a block or
call whose keyword is not recognised. Inside modelled constructs, statements the
deriver does not use stay in the CST as preserved-only; `c2c corpus` counts them
by kind (keywords only, identifiers shown as `<name>`).

### Feature usage

`features.ts` maps each row of the Creator→Catalyst feature matrix to an IR
detector (field types and properties, report types and views, workflow
handlers, profiles, devices, ZML elements). Deluge rows are counted on lexer
tokens of the IR's Deluge spans, so comments and string literals never match.
Rows with no trace in a `.ds` export have no detector and are reported as not
observable, never as zero. `c2c features <dir>` prints apps-using / occurrences
per row, the `zoho.<service>.*` integration tasks, and the zero-app rows.
