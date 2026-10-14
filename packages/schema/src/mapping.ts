/**
 * Creator field type → Catalyst column. One row per matrix feature.
 * `.ds` tokens and the matrix name share a row. Reasons are the migration contract:
 * varchar never silently truncates, decimal is not a column type, foreign keys use
 * the API's on_delete enums, and a geolocation field is not invented.
 */

export type Support = 'supported' | 'partial' | 'unsupported';

export type CatalystType =
  | 'Text'
  | 'VarChar'
  | 'Date'
  | 'DateTime'
  | 'Int'
  | 'Double'
  | 'Boolean'
  | 'BigInt'
  | 'Foreign Key'
  | 'Encrypted';

/** How a mapped field is stored. `none` is display-only or deliberately not generated. */
export type StorageKind = 'column' | 'none' | 'composite' | 'child-table' | 'junction' | 'stratus-key';

export interface FieldTypeRow {
  id: string;
  /** Feature-matrix v3 name. */
  label: string;
  /** Normalized IR / .ds type tokens that select this row. */
  tokens: string[];
  status: Support;
  kind: StorageKind;
  dataType?: CatalystType;
  reason: string;
}

/** VarChar length for an exact decimal string. Creator's max-digits count is 19, including the sign and the point. */
export const EXACT_DECIMAL_LENGTH = 64;

/** ISO 4217 alphabetic codes. Creator writes the code itself as `type = INR`. */
export const CURRENCY_CODES: ReadonlySet<string> = new Set(
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD
   CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP
   GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT
   LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN
   NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF
   SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS
   UAH UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XDR XOF XPD XPF XPT XSU XTS XUA XXX
   YER ZAR ZMW ZWL`
    .split(/\s+/)
    .map((c) => c.toLowerCase()),
);

export const FIELD_TYPES: readonly FieldTypeRow[] = [
  {
    id: 'single-line',
    label: 'Single line',
    tokens: ['text', 'single line', 'singleline'],
    status: 'supported',
    kind: 'column',
    dataType: 'VarChar',
    reason:
      'Creator single line is capped at 255. The column is varchar of maxchar when that is 1–255, otherwise 255. maxchar above 255, or a choice longer than 255, is promoted to text so insert cannot silently truncate.',
  },
  {
    id: 'multi-line',
    label: 'Multi line',
    tokens: ['textarea', 'multi line', 'multiline'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason:
      'Data Store text holds 10,000 characters. A generated length check rejects the rest. Multi-line formula output (up to 65,355) does not fit.',
  },
  {
    id: 'email',
    label: 'Email',
    tokens: ['email'],
    status: 'partial',
    kind: 'column',
    dataType: 'VarChar',
    reason:
      'There is no email column (API type email returns PATTERN_NOT_MATCHED). Stored as varchar plus a generated format check. Creator’s exact rule is unpublished, so the check can differ on edge cases.',
  },
  {
    id: 'phone',
    label: 'Phone',
    tokens: ['phonenumber', 'phone', 'phone number'],
    status: 'partial',
    kind: 'column',
    dataType: 'VarChar',
    reason: 'There is no phone column. Stored as varchar. Country digit rules are a generated table and can drift from Creator.',
  },
  {
    id: 'number',
    label: 'Number',
    tokens: ['number'],
    status: 'supported',
    kind: 'column',
    dataType: 'BigInt',
    reason:
      'Bigint (19 digits), not int (10). Data Store returns bigint as text; the datastore adapter reads it as a JS number (a JS bigint past 2^53, so no digit is lost) and writes it back as the same digits, so generated arithmetic adds instead of joining text.',
  },
  {
    id: 'decimal',
    label: 'Decimal',
    tokens: ['decimal'],
    status: 'partial',
    kind: 'column',
    dataType: 'VarChar',
    reason:
      'Decimal is not a Data Store column type (Text, VarChar, Date, DateTime, Int, Double, Boolean, BigInt, Foreign Key, Encrypted). Stored as a canonical decimal string in varchar 64. Scale is the field decimal places (default 2). Extra fractional digits quantize half-away-from-zero. ZCQL orders the varchar as text.',
  },
  {
    id: 'percent',
    label: 'Percent',
    tokens: ['percent', 'percentage'],
    status: 'partial',
    kind: 'column',
    dataType: 'VarChar',
    reason:
      'Creator stores the percentage number, not a fraction of 1. The % sign is display only. Stored as a canonical decimal string in varchar 64 at the field scale (default 2). ZCQL orders the varchar as text.',
  },
  {
    id: 'currency',
    label: 'Currency',
    tokens: ['currency'],
    status: 'partial',
    kind: 'column',
    dataType: 'VarChar',
    reason:
      'Stored as a canonical decimal string in varchar 64, not Double and not bigint minor units. The ISO 4217 code on the field (type = INR) is column metadata, not a cell. Scale is the field decimal places (default 2). ZCQL orders the varchar as text.',
  },
  {
    id: 'date',
    label: 'Date',
    tokens: ['date'],
    status: 'supported',
    kind: 'column',
    dataType: 'Date',
    reason: 'Date-only column (YYYY-MM-DD). App-timezone versus Deluge date-time semantics are a separate shim, not a different column type.',
  },
  {
    id: 'date-time',
    label: 'Date-time',
    tokens: ['datetime', 'date time', 'date-time'],
    status: 'partial',
    kind: 'column',
    dataType: 'DateTime',
    reason: 'Datetime column. Creator stores the app timezone; Catalyst datetime timezone handling is not the same, so a shim converts. The difference is reported, not ignored.',
  },
  {
    id: 'time',
    label: 'Time',
    tokens: ['time'],
    status: 'partial',
    kind: 'column',
    dataType: 'VarChar',
    reason: 'There is no time column. Stored as varchar HH:MM:SS. Range comparisons are generated code.',
  },
  {
    id: 'decision-box',
    label: 'Decision box',
    tokens: ['decisionbox', 'decision box', 'checkbox'],
    status: 'supported',
    kind: 'column',
    dataType: 'Boolean',
    reason:
      'The .ds token is checkbox (initial value true/false). checkboxes (plural) is the multi-value field, not this row. Data Store returns the strings true and false; the shim makes the string false not truthy. A checkbox that has a choice list or a lookup is the multi-value field instead.',
  },
  {
    id: 'dropdown',
    label: 'Dropdown',
    tokens: ['picklist', 'dropdown', 'inline picklist', 'inlinepicklist'],
    status: 'supported',
    kind: 'column',
    dataType: 'VarChar',
    reason:
      'Varchar plus the .ds choice list. The server rejects values outside the list. A choice longer than 255 is promoted to text. A values = Form.Field target is a lookup, not a dropdown. module = users is the Users field.',
  },
  {
    id: 'radio',
    label: 'Radio',
    tokens: ['radiobuttons', 'radio', 'inline radio', 'inlineradio'],
    status: 'supported',
    kind: 'column',
    dataType: 'VarChar',
    reason: 'Same storage as dropdown. The .ds token is radiobuttons. A values = Form.Field target is a lookup.',
  },
  {
    id: 'multi-select',
    label: 'Multi select',
    tokens: ['list', 'multiselect', 'multi select'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason:
      'No array column. Stored as text holding a JSON list. Criteria do not match list semantics. values = Form.Field on this type is a multi lookup (junction table), not this column.',
  },
  {
    id: 'checkbox-multi',
    label: 'Checkbox (multi)',
    tokens: ['checkboxes'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason:
      'The .ds token checkboxes is a list, not a boolean. Stored as text holding a JSON list. values = Form.Field is a multi lookup (junction table).',
  },
  {
    id: 'lookup-single',
    label: 'Lookup single',
    tokens: ['lookup', 'lookup single'],
    status: 'partial',
    kind: 'column',
    dataType: 'Foreign Key',
    reason:
      'Foreign key is creatable by API: data_type "foreign key" and on_delete "ON-DELETE-SET-NULL" (optional) or "ON-DELETE-CASCADE" (mandatory). ZCQL INNER/LEFT joins need this FK. The parent column is ROWID. A missing target form becomes a bigint id column and the report says "FK needs console". Picklist, radio, and list fields with values = Form.Field use this row (list uses the multi row).',
  },
  {
    id: 'lookup-multi',
    label: 'Lookup multi',
    tokens: ['lookup multi', 'multi lookup'],
    status: 'partial',
    kind: 'junction',
    dataType: 'Foreign Key',
    reason:
      'No multi-value foreign key. A junction table holds two ids (this row’s ROWID and the related ROWID), each a foreign key when the target form exists. A missing target is a bigint id and "FK needs console".',
  },
  {
    id: 'subform',
    label: 'Subform',
    tokens: ['grid', 'subform', 'inline subform'],
    status: 'partial',
    kind: 'child-table',
    reason:
      'The .ds token is grid. Every inline subform (nested fields, no values = Form.Field) becomes its own child table with a parent_id foreign key to the parent ROWID (ON-DELETE-CASCADE) and a row_order Int (0-based Creator row position). A form with several subforms gets one child table per subform; it is not a NoSQL collection. A nested subform inside a subform is not expanded. A grid whose values point at another form is a relation to that form’s table, not a second copy of it.',
  },
  {
    id: 'users',
    label: 'Users',
    tokens: ['users', 'user'],
    status: 'partial',
    kind: 'column',
    dataType: 'BigInt',
    reason:
      'Stores a user id. Creator org users are not Catalyst app users; people must be invited into the project. A picklist or radio with module = users is this row, not a dropdown.',
  },
  {
    id: 'file-upload',
    label: 'File upload',
    tokens: ['upload file', 'file upload', 'fileupload', 'upload', 'file'],
    status: 'partial',
    kind: 'stratus-key',
    dataType: 'VarChar',
    reason: 'The column stores a Stratus object key, not the bytes: uploads/<form>/<field>/<sha256>/<name> from a signed PUT, or migrated/<form>/<field>/<record id>/<name> from the byte mover. Reads are signed GET URLs. Bucket creation and permissions are not done by this step.',
  },
  {
    id: 'image',
    label: 'Image',
    tokens: ['image'],
    status: 'partial',
    kind: 'stratus-key',
    dataType: 'VarChar',
    reason: 'Stratus object key (same upload, download, and byte-migration path as file upload). Thumbnail, crop, and annotation are not generated.',
  },
  {
    id: 'audio',
    label: 'Audio',
    tokens: ['audio', 'audioupload', 'audio upload'],
    status: 'partial',
    kind: 'stratus-key',
    dataType: 'VarChar',
    reason: 'Stratus object key plus a player later. No audio recorder is generated by the schema step.',
  },
  {
    id: 'video',
    label: 'Video',
    tokens: ['video', 'videoupload', 'video upload'],
    status: 'partial',
    kind: 'stratus-key',
    dataType: 'VarChar',
    reason: 'Stratus object key. No video player is generated by the schema step.',
  },
  {
    id: 'signature',
    label: 'Signature',
    tokens: ['signature'],
    status: 'partial',
    kind: 'stratus-key',
    dataType: 'VarChar',
    reason: 'Stratus key for a PNG. The pad canvas is uploaded as PNG bytes through the same signed PUT as a file upload.',
  },
  {
    id: 'url',
    label: 'URL',
    tokens: ['url'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason:
      'URLs routinely exceed varchar 255, which truncates silently. Default storage is text. maxchar of 255 or less stays varchar of that length. Creator also stores link title; a second column is not invented here.',
  },
  {
    id: 'rich-text',
    label: 'Rich text',
    tokens: ['richtext', 'rich text'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason: 'Text column (10,000) for HTML. The editor widget and sanitizer are not the column. Longer HTML is rejected by a generated check.',
  },
  {
    id: 'formula',
    label: 'Formula',
    tokens: ['formula'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason:
      'The value is computed, not entered. A text column holds the result until expression translation knows the result type. It is not dropped and it is not a ROWID.',
  },
  {
    id: 'auto-number',
    label: 'Auto number',
    tokens: ['autonumber', 'auto number'],
    status: 'partial',
    kind: 'column',
    dataType: 'BigInt',
    reason:
      'ROWID is not a substitute: it has no prefix, start, or reset. A bigint column plus a generated counter (start index from the .ds) is the plan. Concurrent inserts can collide until an atomic increment is proven, so this stays partial.',
  },
  {
    id: 'name',
    label: 'Name (composite)',
    tokens: ['name'],
    status: 'supported',
    kind: 'composite',
    dataType: 'VarChar',
    reason: 'One varchar per part (prefix, first_name, last_name, suffix). Deluge sees one value; a shim joins the parts. Parts are not separate field-type rows.',
  },
  {
    id: 'address',
    label: 'Address (composite)',
    tokens: ['address'],
    status: 'partial',
    kind: 'composite',
    dataType: 'VarChar',
    reason:
      'One column per part. Latitude and longitude are double columns on the address, not a geolocation field (that field type does not exist). No map picker is generated.',
  },
  {
    id: 'section',
    label: 'Section',
    tokens: ['section'],
    status: 'supported',
    kind: 'none',
    reason: 'A section collects no data. It is a heading in the generated form and is not a column.',
  },
  {
    id: 'add-notes',
    label: 'Add notes',
    tokens: ['plaintext', 'plain text', 'notes', 'add notes', 'addnotes'],
    status: 'supported',
    kind: 'none',
    reason: 'The .ds token is plaintext. Display-only. Deluge types it as text but it is not a stored answer, so no column is created.',
  },
  {
    id: 'integration',
    label: 'Integration field',
    tokens: ['integration'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason:
      'Needs a Connection the owner authorizes later. The column stores the external id or display text. The fetch is not generated by the schema step.',
  },
  {
    id: 'prediction',
    label: 'Prediction (Zia field)',
    tokens: ['prediction', 'zia prediction', 'ziaprediction'],
    status: 'unsupported',
    kind: 'none',
    reason: 'Needs a trained Zia model. No column is generated. Not-yet-tried as a generated field.',
  },
  {
    id: 'keyword',
    label: 'Keyword extraction',
    tokens: ['keyword', 'keyword extraction', 'keywords'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason: 'Not a column that fills itself. Text stores the Zia result of a post-submit call. The call is not part of this schema step.',
  },
  {
    id: 'sentiment',
    label: 'Sentiment analysis',
    tokens: ['sentiment', 'sentiment analysis'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason: 'Same as keyword extraction: text holds a post-submit Zia result. Not self-filling.',
  },
  {
    id: 'ocr',
    label: 'OCR (text analysis)',
    tokens: ['ocr'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason: 'Text holds a post-submit Zia OCR result. Depends on the image living in Stratus. Not self-filling.',
  },
  {
    id: 'object-detection',
    label: 'Object detection',
    tokens: ['object detection', 'objectdetection'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason: 'Text holds post-submit labels. Not a column that fills itself.',
  },
  {
    id: 'barcode',
    label: 'QR / Barcode field (generated code image)',
    tokens: ['barcode', 'qrcode', 'qr code', 'qr'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason:
      'Creator builds the code from static text plus other fields. The column stores that payload. The renderer is not a Data Store type. At most two per form in Creator; this step does not enforce the cap beyond reporting the field.',
  },
  {
    id: 'geolocation',
    label: 'Geolocation (distinct field)',
    tokens: ['geolocation', 'geo location'],
    status: 'unsupported',
    kind: 'none',
    reason:
      'Not a Creator field type. Latitude and longitude exist only inside Address (and Added/Modified Location). No geo column is invented for this token. If a source still says geolocation, it is reported unsupported.',
  },
  {
    id: 'legacy-crm',
    label: 'Legacy Zoho CRM field',
    tokens: ['crm', 'zoho crm', 'legacy zoho crm'],
    status: 'partial',
    kind: 'column',
    dataType: 'Text',
    reason: 'Pre-Creator 5 display value (API type 22). Text column. The CRM connection is owner-later and is not created here.',
  },
  {
    id: 'legacy-crm-link',
    label: 'Legacy Zoho CRM link',
    tokens: ['crm link', 'zoho crm link', 'legacy zoho crm link'],
    status: 'partial',
    kind: 'column',
    dataType: 'BigInt',
    reason: 'Pre-Creator 5 record id (API type 23). Bigint column. The CRM connection is owner-later.',
  },
  {
    id: 'encrypted',
    label: 'Encrypted',
    tokens: ['encrypted', 'encrypted text'],
    status: 'partial',
    kind: 'column',
    dataType: 'Encrypted',
    reason: 'Encrypted text. Equality comparisons only; range and partial match are not available. Reported so it is not stored as plain text.',
  },
];

const BY_TOKEN = new Map<string, FieldTypeRow>();
const BY_ID = new Map<string, FieldTypeRow>();
for (const row of FIELD_TYPES) {
  BY_ID.set(row.id, row);
  for (const token of row.tokens) BY_TOKEN.set(token, row);
}

/** Lowercase, turn `_` and `-` into spaces, collapse whitespace. */
export function normalizeType(raw?: string): string {
  return (raw ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function fieldTypeById(id: string): FieldTypeRow | undefined {
  return BY_ID.get(id);
}

export function fieldTypeRow(raw?: string): FieldTypeRow | undefined {
  const token = normalizeType(raw);
  if (!token) return undefined;
  return BY_TOKEN.get(token) ?? (CURRENCY_CODES.has(token) ? BY_TOKEN.get('currency') : undefined);
}

export const DECISIONS = {
  currency:
    'Currency, decimal, and percent are an exact canonical decimal string in VarChar length 64, not Double and not bigint minor units. Decimal is not a Catalyst column type. Scale is the field decimal places (default 2). Extra fractional digits quantize half-away-from-zero. The currency ISO code is field metadata. Percent is the typed number, not divided by 100. ZCQL orders the varchar lexicographically; numeric order is the generated comparator.',
  varchar:
    'VarChar longer than 255, or a choice longer than 255, is promoted to Text. Inserts are never planned around silent truncation.',
  fk:
    'Lookup single is data_type "foreign key" with on_delete ON-DELETE-SET-NULL when the field is optional and ON-DELETE-CASCADE when it is mandatory. The parent column is ROWID. A missing target is a bigint id and the report item "FK needs console".',
  nosql:
    'Data Store is the default. Every inline subform (type = grid with nested fields) is a child table with parent_id ON-DELETE-CASCADE and row_order, however many subforms the form has. The schema step does not plan NoSQL collections.',
  signals:
    'Each Data Store table gets three Signals rules, one event per rule: row_inserted, row_updated, row_deleted. Targets are Event functions only. NoSQL collections are not Data Store row events.',
  jobPool: 'Job pool names cannot contain "_". This plan does not create job pools.',
  sourceId:
    'Every migrated table, including child and junction tables, has a varchar c2c_source_id (255) holding the Creator record id. It is not mandatory and not unique: rows the deployed app creates leave it NULL (a mandatory column fails every app insert with 403 MANDATORY_MISSING), and a unique varchar would spend the per-table unique varchar budget. The loader enforces one row per Creator id: it refuses a source that repeats an id, and the server-side write gate never accepts c2c_source_id from a client. A field that would have used that name is renamed. Creator v2.1 Get Records returns ID as a numeric string; the published sample is 17 digits and a lookup criteria example is 19 digits. The mover rejects a longer source id before insert instead of hashing it, because a varchar past 255 is stored truncated. It reconciles a pending batch with ZCQL IN queries of at most 300 ids and skips ids already stored. A DUPLICATE_VALUE response (HTTP 409) re-queries that batch, drops ids now present, and retries the rest; any other write error fails closed. It does not upsert. Each live table run holds a checkpoint lease (owner id and expiry, renewed on each save, released when the table finishes or the run throws). Another mover does not write that table while the lease is unexpired; an expired lease can be taken over. Movers that do not share the checkpoint rely on the re-reconcile on resume.',
  uniqueVarchar:
    'Data Store refuses a third unique varchar column on one table (403 INVALID_OPERATION "Reached max number of columns of Unique varchar type"). The schema keeps the first UNIQUE_VARCHAR_MAX_PER_TABLE unique varchar columns of a table, in field order, as store-level unique. The rest are created not unique and marked appUnique: the generated handler checks them with a ZCQL read before insert and update and refuses a duplicate. That check is not atomic, so two concurrent submits can both pass. A unique varchar the source data disproved also demotes (see constraintsFromSource) and frees its slot for the next unique column. precheck reports every table over the budget.',
  constraintsFromSource:
    'With source rows to measure (a backup, an export, or a seed), a store constraint is kept unless the data itself disproves it: a Creator "must have" field demotes only when a row carries the column with an empty value, and a "unique" field demotes only when two carried non-empty values repeat. A disproved constraint demotes to the app layer — the column is provisioned without it and the schema marks it appMandatory or appUnique — and the generated app enforces the Creator rule instead: an insert or update carrying an empty value is refused MANDATORY_MISSING, and an app-unique value is checked by a ZCQL read before insert and update. Existing rows that violate the flag still load: Creator applies the flag at submit time, not retroactively. Every demotion is a plan decision {table, column, rule, layer: "app", violations} named in the plan and fidelity output with the offending row count, so re-runs, the table templates, and provisioning agree. A field the source does not carry proves nothing — the store constraint stands (a complete source may store the field outside the row files, as a backup\'s reverse-lookup rel# files do), and a load that leaves a kept is_mandatory column empty, or repeats a kept store-unique value, is refused before any write with the column named and a re-provision instruction. Confirmed loads check against the constraint flags the live project actually reports — the provisioned decisions replayed onto the generated schema — not a re-measure of the current input. Generated columns (c2c_source_id, system fields, parent links) are never demoted this way.',
  logicalId:
    'Creator `ID` is a logical field; generated tables have no ID column. A migrated row keeps its Creator id in c2c_source_id; an app-created row has only ROWID. A Deluge criteria on `ID` compiles against both — `ID == x` and `ID in (…)` become `(c2c_source_id IS NOT NULL AND c2c_source_id = x) OR ROWID = x`, `!=` becomes `(c2c_source_id IS NULL OR c2c_source_id != x) AND ROWID != x`, and ordering/text leaves compare the row\'s effective id (c2c_source_id when set, else ROWID). Ordering is numeric, as in Creator: c2c_source_id is a varchar that ZCQL compares as text and ZCQL allows no function or CAST in WHERE, so a digit operand compiles to digit count first (a LIKE with ZCQL\'s `?` one-character and `*` any-run wildcards), then text order within the same count — numeric for ids without leading zeros, so a 17-digit id sorts before a 19-digit one. The in-memory matcher uses the same order on both arms. Every leaf is total (never UNKNOWN) so it composes under AND/OR/NOT. A criteria value may be a number, digit string, bigint, or a lookup `{id,label}` — the id is unwrapped and compared exactly, never through `Number()` (see ids.ts). A lookup-field cell already stores the target ROWID (the FK remap rewrites it), so `Form[ID == rec.Lookup]` resolves by ROWID. Reads of `rec.ID`, `input.ID`, `old.ID`, `Form[criteria].ID`, `distinct(ID)`, and `sort by ID` resolve to the Catalyst ROWID — not the source id — so an id a script stores and later queries by `ID` always round-trips.',
  systemFields:
    'Every form table and inline-subform child table has Added_User, Added_Time, Modified_User, and Modified_Time. Added_User and Modified_User are varchar 255 and store the Creator username. Added_Time and Modified_Time are datetime. They are not mandatory and not unique. A form field that would have used one of those names is renamed. Junction tables do not get these columns. The mover and the CSV import copy the values from the source row and do not stamp the signed-in user or the current time. Creator v2.1 Get Records returns the visible fields of the report (https://www.zoho.com/creator/help/api/v2.1/get-records.html). The published all-field-types sample does not include Added_User, Added_Time, Modified_User, or Modified_Time on the record. When a source row omits them, the column is left empty and the run records a system-field coverage gap. It does not invent a value.',
  bidirectionalRel:
    'A bidirectional lookup stores the link once, on the forward side: a backup\'s rel#<field>#<form>.csv carries the forward rows, and the reverse column on the target form has no cell in the basic# files. The loader fills the named reverse column on each target row with the base record id, single and multi alike, and remaps it to the Catalyst ROWID like every other lookup. A reverse column the basic# files do not carry is therefore populated, never empty, and is not a constraint violation.',
} as const;

/**
 * Unique varchar columns Data Store accepts on one table. A column batch
 * with three unique varchar columns is refused with 403 INVALID_OPERATION
 * "You cannot perform this operation. Reached max number of columns of Unique
 * varchar type"; the same table with two is created. Not documented by Catalyst.
 */
export const UNIQUE_VARCHAR_MAX_PER_TABLE = 2;

/**
 * Column names Data Store refuses when the column is created:
 * 403 INVALID_OPERATION "You cannot perform this operation. Column name cannot
 * contain reserved keywords". The whole name is compared, ignoring case: a
 * column named `Table_Number` or `task_priority` is created. Catalyst does not
 * publish the list; these names are the ones a column create has refused.
 */
export const STORE_REFUSED_COLUMN_NAMES: readonly string[] = ['priority', 'table', 'time'];

/**
 * ZCQL clause words (https://docs.catalyst.zoho.com/en/cloud-scale/help/zcql/
 * SELECT, INSERT, UPDATE, DELETE, JOIN, GROUP BY / ORDER BY and WHERE pages).
 * Generated ZCQL names columns bare, so a column called one of these breaks
 * the statement that reads or filters it.
 */
export const ZCQL_CLAUSE_WORDS: readonly string[] = [
  'and', 'as', 'asc', 'between', 'by', 'delete', 'desc', 'distinct', 'from', 'group', 'having', 'in', 'inner', 'insert',
  'into', 'is', 'join', 'left', 'like', 'limit', 'not', 'null', 'on', 'or', 'order', 'select', 'set', 'update', 'values', 'where',
];

const RESERVED_COLUMN_NAMES = new Set([...STORE_REFUSED_COLUMN_NAMES, ...ZCQL_CLAUSE_WORDS]);

/** True when a Data Store column cannot be named `name` (whole name, any case). */
export function isReservedColumnName(name: string): boolean {
  return RESERVED_COLUMN_NAMES.has(name.toLowerCase());
}

/** Suffix a reserved column name takes: `Table` is stored as `Table_col`. */
export const RESERVED_COLUMN_SUFFIX = '_col';

/** Creator record id on every migrated table. The data mover skips ids already stored here. */
export const SOURCE_ID_COLUMN = 'c2c_source_id';
/** Data Store varchar hard cap. Creator record ids in the v2.1 docs are 17–19 digits. */
export const SOURCE_ID_MAX_LENGTH = 255;

/**
 * Creator system columns stored on form and child tables.
 * Added User is the username (`zoho.loginuser`), not the email (`zoho.loginuserid`).
 * https://www.zoho.com/deluge/help/zoho-variables.html
 * https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-system-fields
 */
export const SYSTEM_FIELD_COLUMNS: readonly {
  name: 'Added_User' | 'Added_Time' | 'Modified_User' | 'Modified_Time';
  dataType: 'VarChar' | 'DateTime';
  length?: number;
  note: string;
}[] = [
  {
    name: 'Added_User',
    dataType: 'VarChar',
    length: 255,
    note: 'Creator username (zoho.loginuser), copied from the source export. Not stamped on import.',
  },
  {
    name: 'Added_Time',
    dataType: 'DateTime',
    note: 'Added time copied from the source export. Not stamped on import.',
  },
  {
    name: 'Modified_User',
    dataType: 'VarChar',
    length: 255,
    note: 'Creator username of the last editor, copied from the source export. Not stamped on import.',
  },
  {
    name: 'Modified_Time',
    dataType: 'DateTime',
    note: 'Modified time copied from the source export. Not stamped on import.',
  },
];

/** Recorded when a source row does not carry the four system columns. Import does not invent them. */
export const SYSTEM_FIELD_COVERAGE_GAP =
  'Creator export omitted Added_User, Added_Time, Modified_User, or Modified_Time. Creator v2.1 Get Records returns the visible fields of the report (https://www.zoho.com/creator/help/api/v2.1/get-records.html); the published all-field-types sample does not include those columns on the record. The import copies them when the row has them and does not stamp a user or a time.';

const SYSTEM_FIELD_ALIASES: Record<string, (typeof SYSTEM_FIELD_COLUMNS)[number]['name']> = {
  addeduser: 'Added_User',
  addedtime: 'Added_Time',
  createdtime: 'Added_Time',
  modifieduser: 'Modified_User',
  modifiedtime: 'Modified_Time',
};

/** Map a Creator export key (`Added User`, `CREATEDTIME`, …) onto a system column. Other keys are undefined. */
export function systemFieldColumn(key: string): (typeof SYSTEM_FIELD_COLUMNS)[number]['name'] | undefined {
  return SYSTEM_FIELD_ALIASES[key.trim().toLowerCase().replace(/[\s_]+/g, '')];
}

export function schemaMappingMarkdown(): string {
  const lines: string[] = [];
  lines.push('# Creator field type → Catalyst schema');
  lines.push('');
  lines.push('One row per field type the schema generator maps. The reason is the contract, not a hint.');
  lines.push('');
  lines.push('For a field stored as one column, Creator `must have` and `unique` are emitted as `mandatory` and `unique`, and `initial value` is emitted as `defaultValue` when Catalyst supports a default for that column type. Text, Foreign Key, and Encrypted columns keep their documented default behavior: no Catalyst default, with a generated-form prefill warning. Type-specific size, precision, lookup relation, and composite parts are described in the row reason. Source-measured constraint demotions and the per-table unique-varchar limit are described below.');
  lines.push('');
  lines.push('## Decisions');
  lines.push('');
  for (const [key, text] of Object.entries(DECISIONS)) lines.push(`- **${key}.** ${text}`); // determinism-allow: const DECISIONS object; key order is the published contract in docs/schema-mapping.md, not a hash map
  lines.push('');
  lines.push('`.ds` tokens and matrix names share a row. `type = INR` (any ISO 4217 code) is Currency.');
  lines.push('A `checkbox` with a choice list or a lookup is Checkbox (multi), not Decision box.');
  lines.push('`values = Form.Field` on a single-value field is Lookup single; on list/checkboxes it is Lookup multi.');
  lines.push('');
  lines.push('| Matrix type | .ds tokens | Status | Storage | Reason |');
  lines.push('|---|---|---|---|---|');
  for (const row of FIELD_TYPES) {
    const storage = row.dataType ? `${row.kind} / ${row.dataType}` : row.kind;
    const tokens = row.tokens.map((t) => `\`${t}\``).join(', ');
    lines.push(`| ${row.label} | ${tokens} | ${row.status} | ${storage} | ${row.reason.replace(/\|/g, '/')} |`);
  }
  lines.push('');
  return lines.join('\n');
}
