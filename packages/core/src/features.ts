/**
 * Feature usage from the IR: for each Creator feature row of the conversion
 * matrix, how often an app uses it.
 *
 * Every count comes from IR nodes (field types and properties, report types and
 * views, workflow containers and events, profiles, devices, ZML elements, ...).
 * Deluge features are counted on lexer tokens of the IR's Deluge spans (string
 * literals and comments never match), not on raw file text.
 *
 * Rows whose feature leaves no trace in a `.ds` export (environments, logs,
 * offline mode, ...) have no detector: they are reported as not observable,
 * never as zero.
 */

import { isTrivia, tokenize, type Token } from './lexer.js';
import type { App, Field, Report, Workflow } from './ir.js';
import type { ZmlElement } from './zml.js';

export interface FeatureRow {
  area: string;
  /** Feature name as in the matrix. */
  feature: string;
  /** How the IR is read, in a few words. */
  method: string;
  /** Occurrences in one app; undefined when the feature is not observable in a `.ds` export. */
  count?: (x: AppFacts) => number;
}

/** An app's IR plus the derived views the detectors share. */
export interface AppFacts {
  app: App;
  /** Every field, including subform and composite parts. */
  allFields: Field[];
  /** Top-level fields of every form (no composite parts, no inline-subform fields). */
  fields: Field[];
  zml: ZmlElement[];
  deluge: DelugeStats;
}

export interface DelugeStats {
  spans: number;
  /** Statements: `;`-terminated statements plus `if` / `for each` / `try` constructs. */
  statements: number;
  /** Single identifiers (lower-cased) → occurrences. */
  idents: Map<string, number>;
  /** Dotted names `a.b.c` (lower-cased, longest chain) → occurrences. */
  dotted: Map<string, number>;
  /** Named patterns (see `scanDeluge`) → occurrences. */
  patterns: Map<string, number>;
}

const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

/** Deluge spans of an app: workflow handlers, functions, blueprint transition phases. */
export function delugeTexts(app: App): string[] {
  const out: string[] = [];
  for (const w of app.workflows) {
    if (w.deluge) out.push(w.deluge.text);
    for (const t of w.blueprint?.transitions ?? []) for (const p of t.phases) for (const d of p.deluge) out.push(d.text);
  }
  for (const f of app.functions) for (const d of f.deluge) out.push(d.text);
  return out;
}

const STMT_START = new Set([';', '{', '}', ')']);

/** Token-level Deluge statistics. `forms` and `subforms` are link names from the IR. */
export function scanDeluge(texts: string[], forms: Set<string>, subforms: Set<string>): DelugeStats {
  const st: DelugeStats = { spans: texts.length, statements: 0, idents: new Map(), dotted: new Map(), patterns: new Map() };
  const pat = (k: string) => bump(st.patterns, k);
  for (const text of texts) {
    const toks = tokenize(text).filter((t) => !isTrivia(t));
    const at = (i: number) => toks[i]?.text ?? '';
    const low = (i: number) => at(i).toLowerCase();
    const fetched = new Set<string>(); // variables bound to fetched records
    for (let i = 0; i < toks.length; i++) {
      const t: Token = toks[i];
      if (t.kind === 'punct' && t.text === ';') st.statements++;
      if (t.kind !== 'ident') continue;
      const w = t.text.toLowerCase();
      const prevDot = at(i - 1) === '.';
      if (!prevDot) {
        bump(st.idents, w);
        // dotted chain
        let j = i;
        const parts = [w];
        while (at(j + 1) === '.' && toks[j + 2]?.kind === 'ident') {
          parts.push(low(j + 2));
          j += 2;
        }
        if (parts.length > 1) bump(st.dotted, parts.join('.'));
      }
      const startOfStmt = i === 0 || STMT_START.has(at(i - 1));
      if (w === 'if' && at(i + 1) === '(') (st.statements++, pat('if'));
      if (w === 'else') pat('else');
      if (w === 'try' && at(i + 1) === '{') (st.statements++, pat('try'));
      if (w === 'catch' && at(i + 1) === '(') pat('catch');
      if (w === 'for' && low(i + 1) === 'each') {
        st.statements++;
        pat('for each');
        // for each v in Form[...]  /  for each v in input.Subform
        const v = at(i + 2);
        if (low(i + 3) === 'in') {
          if (forms.has(at(i + 4)) && at(i + 5) === '[') {
            pat('for each fetched');
            fetched.add(v);
          } else if (low(i + 4) === 'input' && at(i + 5) === '.' && subforms.has(at(i + 6))) pat('subform loop');
        }
      }
      if (w === 'insert' && low(i + 1) === 'into') pat('insert');
      if (w === 'delete' && low(i + 1) === 'from') pat('delete');
      if (w === 'cancel' && low(i + 1) === 'submit') pat('cancel submit');
      if (startOfStmt && !prevDot && ['hide', 'show', 'enable', 'disable'].includes(w) && toks[i + 1]?.kind === 'ident') pat(w);
      if (!prevDot && forms.has(t.text) && at(i + 1) === '[' && low(i - 1) !== 'into') {
        pat('fetch');
        if (at(i - 1) === '=' && toks[i - 2]?.kind === 'ident') fetched.add(at(i - 2));
        // Form[...].sum(F) etc.
        let depth = 0;
        let k = i + 1;
        for (; k < toks.length; k++) {
          if (at(k) === '[') depth++;
          else if (at(k) === ']' && --depth === 0) break;
        }
        if (at(k + 1) === '.' && ['sum', 'count', 'minimum', 'maximum', 'min', 'max', 'distinct', 'average', 'avg'].includes(low(k + 2)) && at(k + 3) === '(') pat('aggregate');
      }
      // rec.Field = value on a fetched record
      if (!prevDot && fetched.has(t.text) && at(i + 1) === '.' && toks[i + 2]?.kind === 'ident' && at(i + 3) === '=') pat('update');
      if (prevDot && ['round', 'todecimal'].includes(w) && at(i + 1) === '(') pat('decimal');
      if (prevDot && /^(adddays?|addmonths?|addyears?|addhours?|addminutes?|addseconds?|subdays?|submonths?|subyears?|todate|todatetime|totime|daysbetween|workdaysbetween|getday|getmonth|getyear|gethour|getminutes)$/.test(w) && at(i + 1) === '(') pat('datetime');
    }
  }
  return st;
}

export function appFacts(app: App): AppFacts {
  const allFields: Field[] = [];
  const walk = (f: Field) => (allFields.push(f), f.subfields.forEach(walk));
  const fields = app.forms.flatMap((f) => f.fields);
  fields.forEach(walk);
  const zml: ZmlElement[] = [];
  const zwalk = (e: ZmlElement) => (zml.push(e), e.children.forEach(zwalk));
  app.pages.forEach((p) => p.zml.forEach(zwalk));
  const forms = new Set(app.forms.map((f) => f.name));
  const subforms = new Set(allFields.filter((f) => f.type === 'grid').map((f) => f.name));
  return { app, allFields, fields, zml, deluge: scanDeluge(delugeTexts(app), forms, subforms) };
}

// ---------------------------------------------------------------------------
// detectors

const ft = (...types: string[]) => (x: AppFacts) => x.allFields.filter((f) => types.includes((f.type ?? '').toLowerCase())).length;
const ftNoLookup = (...types: string[]) => (x: AppFacts) => x.allFields.filter((f) => types.includes(f.type ?? '') && !f.lookup).length;
const ftLookup = (...types: string[]) => (x: AppFacts) => x.allFields.filter((f) => types.includes(f.type ?? '') && !!f.lookup).length;
const fprop = (...keys: string[]) => (x: AppFacts) => x.allFields.filter((f) => f.properties.some((p) => keys.includes(p.key.toLowerCase()))).length;
const fpropTrue = (...keys: string[]) => (x: AppFacts) =>
  x.allFields.filter((f) => f.properties.some((p) => keys.includes(p.key.toLowerCase()) && /^"?true"?$/i.test(p.value.trim()))).length;
const rtype = (...types: string[]) => (x: AppFacts) => x.app.reports.filter((r) => types.includes(r.type)).length;
const reports = (pred: (r: Report) => boolean) => (x: AppFacts) => x.app.reports.filter(pred).length;
const wf = (pred: (w: Workflow) => boolean) => (x: AppFacts) => x.app.workflows.filter(pred).length;
const ev = (w: Workflow) => w.event.toLowerCase();
const leaf = (w: Workflow) => ev(w).split(' / ').pop() ?? '';
const isDelete = (w: Workflow) => (w.recordEvent ?? '').toLowerCase() === 'on delete' || ev(w).startsWith('on delete /');
const pat = (k: string) => (x: AppFacts) => x.deluge.patterns.get(k) ?? 0;
const id = (...ks: string[]) => (x: AppFacts) => ks.reduce((n, k) => n + (x.deluge.idents.get(k) ?? 0), 0);
const dottedPrefix = (p: string) => (x: AppFacts) => [...x.deluge.dotted].filter(([k]) => k.startsWith(p)).reduce((n, [, v]) => n + v, 0);
const zmlTag = (...tags: string[]) => (x: AppFacts) => x.zml.filter((e) => tags.includes(e.tag.toLowerCase())).length;
const menuItem = (item: string) => (x: AppFacts) =>
  x.app.reports.filter((r) => r.views.some((v) => Object.values(v.menus).some((m) => m.some((i) => i.toLowerCase() === item)))).length;
const viewAction = (...gestures: string[]) => (x: AppFacts) =>
  x.app.reports.reduce((n, r) => n + r.views.filter((v) => Object.keys(v.actions).some((a) => gestures.includes(a))).length, 0) +
  x.app.devices.reduce((n, d) => n + d.components.reduce((m, c) => m + c.views.filter((v) => Object.keys(v.actions).some((a) => gestures.includes(a))).length, 0), 0);
/**
 * Enterprise mobile customization markers in a phone/tablet `customize` block. Standard layout
 * (`layout`, `font`, `style`, `color options { color }`, `logo { preference = "none" }`) is not a marker.
 */
const MOBILE_BRANDING_KEY = /sign|mdm|bundle|provision|certificate|splash|app icon|brand/i;
const mobileCustomized = (x: AppFacts) =>
  x.app.devices.filter((d) => {
    if (d.device === 'web' || !d.customize) return false;
    const brandKey = d.customize.properties.some((p) => MOBILE_BRANDING_KEY.test(p.key));
    const customLogo = (d.customize.blocks.find((b) => b.name.toLowerCase() === 'logo')?.properties ?? []).some(
      (p) => p.key.toLowerCase() === 'preference' && p.value.replace(/"/g, '').trim().toLowerCase() !== 'none',
    );
    return brandKey || customLogo;
  }).length;
const sum = (...fs: ((x: AppFacts) => number)[]) => (x: AppFacts) => fs.reduce((n, f) => n + f(x), 0);
const hasCol = (name: string) => (x: AppFacts) =>
  x.app.reports.reduce((n, r) => n + r.columns.filter((c) => c.field === name).length + r.sortBy.filter((s) => s.field === name).length, 0) +
  (x.deluge.idents.get(name.toLowerCase()) ?? 0);
const portalProfiles = (x: AppFacts) => x.app.profiles.filter((p) => /portal/i.test(p.type ?? '')).length;
const payments = (x: AppFacts) =>
  x.app.forms.filter((f) => f.blocks.some((b) => b.name.toLowerCase() === 'enable payment')).length + x.app.workflows.filter((w) => /payment/i.test(w.container ?? w.type ?? '')).length;

/** Zia AI fields: `AI_Properties ( fieldtype = OCR ... )` nested in a field (types normalised: lower case, no spaces). */
const zia = (...kinds: string[]) => (x: AppFacts) =>
  x.allFields.filter(
    (f) =>
      f.name === 'AI_Properties' &&
      f.properties.some((p) => {
        const value = p.value.replace(/["\s_]/g, '').toLowerCase();
        return p.key.toLowerCase() === 'fieldtype' && kinds.some((k) => k === value || (k === 'keywordextraction' && value === 'keywordextractor'));
      }),
  ).length;

const N = undefined;

/** Matrix rows (feature-matrix-v2 order) with their IR detectors. */
export const FEATURES: FeatureRow[] = [
  // field types
  { area: 'Field type', feature: 'Single line', method: 'field type `text`', count: ft('text') },
  { area: 'Field type', feature: 'Multi line', method: 'field type `textarea`', count: ft('textarea') },
  { area: 'Field type', feature: 'Email', method: 'field type `email`', count: ft('email') },
  { area: 'Field type', feature: 'Phone', method: 'field type `phonenumber`', count: ft('phonenumber') },
  { area: 'Field type', feature: 'Number', method: 'field type `number`', count: ft('number') },
  { area: 'Field type', feature: 'Decimal', method: 'field type `decimal`', count: ft('decimal') },
  { area: 'Field type', feature: 'Percent', method: 'field type `percentage`', count: ft('percentage') },
  {
    area: 'Field type',
    feature: 'Currency',
    method: 'field type is a currency code (`USD`, `INR`, ...) or `currency`',
    count: (x) => x.allFields.filter((f) => /^[A-Z]{3}$/.test(f.type ?? '') || f.type === 'currency').length,
  },
  { area: 'Field type', feature: 'Date', method: 'field type `date`', count: ft('date') },
  { area: 'Field type', feature: 'Date-time', method: 'field type `datetime`', count: ft('datetime') },
  { area: 'Field type', feature: 'Time', method: 'field type `time`', count: ft('time') },
  { area: 'Field type', feature: 'Decision box', method: 'field type `checkbox`', count: ft('checkbox') },
  { area: 'Field type', feature: 'Dropdown', method: 'field type `picklist` without lookup', count: ftNoLookup('picklist') },
  { area: 'Field type', feature: 'Radio', method: 'field type `radiobuttons` without lookup', count: ftNoLookup('radiobuttons') },
  { area: 'Field type', feature: 'Multi select', method: 'field type `list` without lookup', count: ftNoLookup('list') },
  { area: 'Field type', feature: 'Checkbox', method: 'field type `checkboxes` without lookup', count: ftNoLookup('checkboxes') },
  { area: 'Field type', feature: 'Lookup single (dropdown or radio)', method: '`picklist`/`radiobuttons` with `values = Form.Field`', count: ftLookup('picklist', 'radiobuttons') },
  { area: 'Field type', feature: 'Lookup multi (multi select or checkbox)', method: '`list`/`checkboxes` with `values = Form.Field`', count: ftLookup('list', 'checkboxes') },
  { area: 'Field type', feature: 'Subform', method: 'field type `grid` (inline or from an existing form)', count: ft('grid') },
  { area: 'Field type', feature: 'Users', method: 'field type `users` or `module = users`', count: (x) => x.allFields.filter((f) => f.type?.toLowerCase() === 'users' || f.properties.some((p) => p.key.toLowerCase() === 'module' && p.value.replace(/["']/g, '').toLowerCase() === 'users')).length },
  { area: 'Field type', feature: 'File upload', method: 'field type `upload file`', count: ft('upload file') },
  { area: 'Field type', feature: 'Image', method: 'field type `image`', count: ft('image') },
  { area: 'Field type', feature: 'Audio', method: 'field type `audio`', count: ft('audio') },
  { area: 'Field type', feature: 'Video', method: 'field type `video`', count: ft('video') },
  { area: 'Field type', feature: 'Signature', method: 'field type `signature`', count: ft('signature') },
  { area: 'Field type', feature: 'URL', method: 'field type `url`', count: ft('url') },
  { area: 'Field type', feature: 'Rich text', method: 'field type `richtext`', count: ft('richtext') },
  { area: 'Field type', feature: 'Formula', method: 'field type `formula` or `Formula_Properties`', count: (x) => x.allFields.filter((f) => f.type?.toLowerCase() === 'formula' || f.subfields.some((s) => s.name.toLowerCase() === 'formula_properties')).length },
  { area: 'Field type', feature: 'Auto number', method: 'field type `autonumber`', count: ft('autonumber') },
  { area: 'Field type', feature: 'Name (composite)', method: 'field type `name`', count: ft('name') },
  { area: 'Field type', feature: 'Address (composite)', method: 'field type `address`', count: ft('address') },
  { area: 'Field type', feature: 'Section', method: 'field type `section`', count: ft('section') },
  { area: 'Field type', feature: 'Add notes', method: 'field type `plaintext`', count: ft('plaintext') },
  { area: 'Field type', feature: 'Integration', method: 'field type `integration`', count: ft('integration') },
  { area: 'Field type', feature: 'Prediction (Zia field)', method: '`AI_Properties` `fieldtype = Prediction`', count: zia('prediction') },
  { area: 'Field type', feature: 'Keyword extraction', method: '`AI_Properties` `fieldtype = KeywordExtraction`', count: zia('keywordextraction') },
  { area: 'Field type', feature: 'Sentiment analysis', method: '`AI_Properties` `fieldtype = SentimentAnalysis`', count: zia('sentimentanalysis') },
  { area: 'Field type', feature: 'OCR (text analysis)', method: '`AI_Properties` `fieldtype = OCR`', count: zia('ocr') },
  { area: 'Field type', feature: 'Object detection', method: '`AI_Properties` `fieldtype = ObjectDetection`', count: zia('objectdetection') },
  { area: 'Field type', feature: 'Barcode / QR code', method: 'field type `qrcode` or property `barcode`/`qrcode` = true', count: (x) => x.allFields.filter((f) => ['qrcode', 'barcode'].includes((f.type ?? '').toLowerCase()) || f.properties.some((p) => ['barcode', 'qrcode'].includes(p.key.toLowerCase()) && /^"?true"?$/i.test(p.value.trim()))).length },
  { area: 'Field type', feature: 'Geolocation (distinct field)', method: 'field type `geolocation`/`location`', count: ft('geolocation', 'location') },
  { area: 'Field type', feature: 'Legacy Zoho CRM field', method: 'field type `crm`/`zohocrm`', count: ft('crm', 'zohocrm', 'crmfield') },
  { area: 'Field type', feature: 'Legacy Zoho CRM link', method: 'field type `crmlink`', count: ft('crmlink') },
  // field properties
  { area: 'Field property', feature: 'Mandatory', method: '`must have` modifier', count: (x) => x.allFields.filter((f) => f.required).length },
  { area: 'Field property', feature: 'Unique / no duplicates', method: '`unique` modifier', count: (x) => x.allFields.filter((f) => f.unique).length },
  { area: 'Field property', feature: 'Default value', method: '`initial value` property', count: (x) => x.allFields.filter((f) => f.initialValue !== undefined).length },
  { area: 'Field property', feature: 'Max length', method: '`maxchar` property', count: fprop('maxchar') },
  { area: 'Field property', feature: 'Decimal places', method: '`decimalplace` property', count: fprop('decimalplace', 'decimal places') },
  { area: 'Field property', feature: 'Field validation (format rules)', method: '`format` property on a field', count: fprop('format') },
  {
    area: 'Field property',
    feature: 'Hide / show field (field rules)',
    method: 'field-rule `hide`/`show` actions + Deluge `hide`/`show` statements',
    count: (x) => x.app.workflows.reduce((n, w) => n + (w.fieldRules ?? []).reduce((m, r) => m + r.actions.filter((a) => /^(hide|show)$/i.test(a.action)).length, 0), 0) + pat('hide')(x) + pat('show')(x),
  },
  {
    area: 'Field property',
    feature: 'Enable / disable field',
    method: 'field-rule `enable`/`disable` actions + Deluge `enable`/`disable` statements',
    count: (x) => x.app.workflows.reduce((n, w) => n + (w.fieldRules ?? []).reduce((m, r) => m + r.actions.filter((a) => /^(enable|disable)$/i.test(a.action)).length, 0), 0) + pat('enable')(x) + pat('disable')(x),
  },
  { area: 'Field property', feature: 'Personal data / encrypt', method: '`personal data` = true', count: fpropTrue('personal data', 'encrypt', 'encryptdata') },
  { area: 'Field property', feature: 'Field-level permissions', method: 'profile `FieldPermissions` entries', count: (x) => x.app.profiles.reduce((n, p) => n + p.modules.reduce((m, md) => m + md.fields.length, 0), 0) },
  { area: 'Field property', feature: 'Search index on a column', method: 'not in a .ds export', count: N },
  { area: 'Field property', feature: 'System Added Time / Modified Time', method: '`Added_Time`/`Modified_Time` in report columns, sort and Deluge identifiers', count: sum(hasCol('Added_Time'), hasCol('Modified_Time')) },
  { area: 'Field property', feature: 'System record id', method: '`ID` in report columns, sort and Deluge identifiers', count: hasCol('ID') },
  { area: 'Field property', feature: 'Added user', method: '`Added_User` in report columns, sort and Deluge identifiers', count: hasCol('Added_User') },
  // reports
  { area: 'Report', feature: 'List report', method: 'report type `list`', count: rtype('list') },
  {
    area: 'Report',
    feature: 'List report, card quick view',
    method: '`list` report whose web quick view sets a layout type (layout codes are not decoded)',
    count: reports((r) => r.type === 'list' && r.views.some((v) => v.kind === 'quickview' && (!v.device || v.device === 'web') && v.layoutType !== undefined)),
  },
  { area: 'Report', feature: 'List report, custom quick view', method: 'report type `custom` (list with a custom quick-view layout)', count: rtype('custom') },
  { area: 'Report', feature: 'Detail view', method: 'reports with a `detailview` layout', count: reports((r) => r.views.some((v) => v.kind === 'detailview')) },
  { area: 'Report', feature: 'Calendar', method: 'report type `calendar`', count: rtype('calendar') },
  { area: 'Report', feature: 'Timeline', method: 'report type `timeline`', count: rtype('timeline') },
  { area: 'Report', feature: 'Kanban', method: 'report type `kanban`', count: rtype('kanban') },
  { area: 'Report', feature: 'Map', method: 'report type `map`', count: rtype('map') },
  { area: 'Report', feature: 'Spreadsheet', method: 'report type `spreadsheet`/`sheet`/`grid`', count: rtype('spreadsheet', 'sheet', 'grid') },
  { area: 'Report', feature: 'Pivot table', method: 'report type `pivottable`', count: rtype('pivottable') },
  { area: 'Report', feature: 'Pivot chart', method: 'report type `pivotchart`', count: rtype('pivotchart') },
  { area: 'Report', feature: 'Gantt', method: 'report type `gantt`', count: rtype('gantt') },
  { area: 'Report', feature: 'Summary report (not a matrix row)', method: 'report type `summary`', count: rtype('summary') },
  { area: 'Report', feature: 'Switch view (list, spreadsheet, kanban, calendar, timeline)', method: 'not distinguishable in the IR', count: N },
  { area: 'Report', feature: 'Predefined filters', method: 'named `filters` entries (`"Label" : criteria`)', count: (x) => x.app.reports.reduce((n, r) => n + r.filters.filter((f) => f.label !== undefined).length, 0) },
  { area: 'Report', feature: 'Custom filter criteria', method: 'criteria on `show all rows from Form [ ... ]`', count: reports((r) => !!r.criteria) },
  { area: 'Report', feature: 'Grouping', method: '`group by` entries', count: (x) => x.app.reports.reduce((n, r) => n + r.groupBy.length, 0) },
  { area: 'Report', feature: 'Sorting', method: '`sort by` entries', count: (x) => x.app.reports.reduce((n, r) => n + r.sortBy.length, 0) },
  { area: 'Report', feature: 'Search in a report', method: 'field `filters` entries (filter/search fields)', count: (x) => x.app.reports.reduce((n, r) => n + r.filters.filter((f) => f.field !== undefined).length, 0) },
  { area: 'Report', feature: 'Conditional formatting', method: '`conditional formatting` rules', count: (x) => x.app.reports.reduce((n, r) => n + r.conditionalFormats.length, 0) },
  { area: 'Report', feature: 'Record-level custom action', method: 'report custom actions', count: (x) => x.app.reports.reduce((n, r) => n + r.customActions.length, 0) },
  {
    area: 'Report',
    feature: 'Bulk edit',
    method: 'custom actions flagged `execute action for collection of records`',
    count: (x) => x.app.reports.reduce((n, r) => n + r.customActions.filter((c) => c.flags.some((f) => /collection of records/i.test(f))).length, 0),
  },
  { area: 'Report', feature: 'Export (report)', method: 'reports with an `Export` menu item', count: menuItem('export') },
  {
    area: 'Report',
    feature: 'Print (report or record)',
    method: 'reports with a `Print` menu item',
    count: menuItem('print'),
  },
  { area: 'Report', feature: 'Import into a report', method: 'reports with an `Import` menu item', count: menuItem('import') },
  { area: 'Report', feature: 'Record comments', method: 'not in the IR', count: N },
  // workflows
  { area: 'Workflow', feature: 'Field rules', method: 'workflows with `field rules`', count: wf((w) => !!w.fieldRules?.length) },
  { area: 'Workflow', feature: 'Load of form', method: 'form workflow handler `on load`', count: wf((w) => w.container === 'form' && leaf(w) === 'on load') },
  { area: 'Workflow', feature: 'User input of a field', method: 'handler `on user input of <field>`', count: wf((w) => /^on user input\b/.test(ev(w))) },
  { area: 'Workflow', feature: 'Addition of a subform row', method: 'handler `on add row of <subform>`', count: wf((w) => /^on add row\b/.test(ev(w))) },
  { area: 'Workflow', feature: 'Deletion of a subform row', method: 'handler `on delete row of <subform>`', count: wf((w) => /^on delete row\b/.test(ev(w))) },
  { area: 'Workflow', feature: 'Validation on form submission', method: 'handler `on validate`, record event not `on delete`', count: wf((w) => leaf(w) === 'on validate' && !isDelete(w)) },
  { area: 'Workflow', feature: 'Successful form submission', method: 'handler `on success`, record event not `on delete`', count: wf((w) => leaf(w) === 'on success' && !isDelete(w)) },
  { area: 'Workflow', feature: 'Update of a field', method: 'handler `on update of <field>`', count: wf((w) => /^on update of\b/.test(ev(w))) },
  { area: 'Workflow', feature: 'Validation on record deletion', method: 'handler `on validate` under record event `on delete`', count: wf((w) => leaf(w) === 'on validate' && isDelete(w)) },
  { area: 'Workflow', feature: 'Successful record deletion', method: 'handler `on success` under record event `on delete`', count: wf((w) => leaf(w) === 'on success' && isDelete(w)) },
  { area: 'Workflow', feature: 'Stateless form: button click', method: 'form workflow handler `on click`', count: wf((w) => w.container === 'form' && leaf(w) === 'on click') },
  { area: 'Workflow', feature: 'Schedule on a date field', method: 'schedule workflow with a `form` (date-field based)', count: wf((w) => w.container === 'schedule' && !!w.form) },
  { area: 'Workflow', feature: 'Schedule on a fixed date and time', method: 'schedule workflow without a `form`', count: wf((w) => w.container === 'schedule' && !w.form) },
  { area: 'Workflow', feature: 'Custom schedule quota', method: 'not in a .ds export', count: N },
  {
    area: 'Workflow',
    feature: 'Approval (multi-level)',
    method: 'approval workflows (distinct names); multi-level = has `on level 2`',
    count: (x) => new Set(x.app.workflows.filter((w) => w.container === 'approval').map((w) => w.name)).size,
  },
  { area: 'Workflow', feature: 'Approval with 2+ levels (not a matrix row)', method: 'approval workflows with an `on level 2` handler', count: (x) => new Set(x.app.workflows.filter((w) => w.container === 'approval' && /^on level [2-9]/.test(ev(w))).map((w) => w.name)).size },
  { area: 'Workflow', feature: 'Payment workflow', method: 'form `enable payment` block or payment workflow', count: payments },
  {
    area: 'Workflow',
    feature: 'Payment gateway names (Stripe, PayPal, Zoho Checkout)',
    method: '`type` in an `enable payment` block',
    count: (x) => x.app.forms.reduce((n, f) => n + f.blocks.filter((b) => b.name.toLowerCase() === 'enable payment' && b.properties.some((p) => p.key.toLowerCase() === 'type')).length, 0),
  },
  { area: 'Workflow', feature: 'Batch workflow on import', method: 'batch workflow container/type', count: wf((w) => /batch/i.test(w.container ?? '') && /import/i.test(w.properties.map((p) => p.value).join(' '))) },
  { area: 'Workflow', feature: 'Batch workflow on a schedule', method: 'batch workflow container/type', count: wf((w) => /batch/i.test(w.container ?? '') && !/import/i.test(w.properties.map((p) => p.value).join(' '))) },
  { area: 'Workflow', feature: 'Function on records (not a matrix row)', method: 'creator functions with `execution type` (custom-action targets)', count: (x) => x.app.functions.filter((f) => f.kind === 'creator').length },
  { area: 'Workflow', feature: 'Blueprint stages', method: 'blueprint `stages`', count: (x) => x.app.workflows.reduce((n, w) => n + (w.blueprint?.stages.length ?? 0), 0) },
  { area: 'Workflow', feature: 'Blueprint transitions (before / during / after)', method: 'blueprint `transitions`', count: (x) => x.app.workflows.reduce((n, w) => n + (w.blueprint?.transitions.length ?? 0), 0) },
  {
    area: 'Workflow',
    feature: 'Blueprint SLA / due date',
    method: 'transition properties naming `sla`/`due`',
    count: (x) => x.app.workflows.reduce((n, w) => n + (w.blueprint?.transitions ?? []).filter((t) => t.properties.some((p) => /sla|due/i.test(p.key))).length, 0),
  },
  { area: 'Workflow', feature: 'Blueprint analytics', method: 'not in a .ds export', count: N },
  // deluge
  { area: 'Deluge', feature: 'if / else', method: '`if (` tokens', count: pat('if') },
  { area: 'Deluge', feature: 'for each over a list', method: '`for each` tokens', count: pat('for each') },
  { area: 'Deluge', feature: 'try / catch', method: '`try {` tokens', count: pat('try') },
  { area: 'Deluge', feature: 'List', method: '`List`/`list` identifiers', count: id('list') },
  { area: 'Deluge', feature: 'Map', method: '`Map`/`map` identifiers', count: id('map') },
  { area: 'Deluge', feature: 'Date-time and app timezone', method: '`zoho.currentdate/currenttime` + date methods (`addDay`, `toDate`, ...)', count: sum(dottedPrefix('zoho.currentdate'), dottedPrefix('zoho.currenttime'), pat('datetime')) },
  { area: 'Deluge', feature: 'Decimal precision', method: '`.round(` / `.toDecimal(`', count: pat('decimal') },
  { area: 'Deluge', feature: 'insert record', method: '`insert into`', count: pat('insert') },
  { area: 'Deluge', feature: 'fetch by criteria', method: '`<Form>[` with a form of the app', count: pat('fetch') },
  { area: 'Deluge', feature: 'update record', method: '`rec.Field =` on a variable bound to fetched records', count: pat('update') },
  { area: 'Deluge', feature: 'delete record', method: '`delete from`', count: pat('delete') },
  { area: 'Deluge', feature: 'Aggregate (sum, count, min, max, distinct)', method: '`<Form>[...].sum(` etc.', count: pat('aggregate') },
  { area: 'Deluge', feature: 'for each over fetched records', method: '`for each v in <Form>[`', count: pat('for each fetched') },
  { area: 'Deluge', feature: 'sendmail', method: '`sendmail` identifier', count: id('sendmail') },
  { area: 'Deluge', feature: 'sendsms', method: '`sendsms` identifier + `zoho.sms.*` tasks', count: sum(id('sendsms'), dottedPrefix('zoho.sms.')) },
  { area: 'Deluge', feature: 'Push / in-app notification', method: '`pushnotify`/`pushnotification`/`zoho.notify*` identifiers', count: sum(id('pushnotify', 'pushnotification', 'sendpushnotification'), dottedPrefix('zoho.notify')) },
  { area: 'Deluge', feature: 'invokeurl', method: '`invokeurl` (+ legacy `getUrl`/`postUrl`)', count: id('invokeurl', 'geturl', 'posturl') },
  { area: 'Deluge', feature: 'zoho.crm.*', method: 'dotted names under `zoho.crm.`', count: dottedPrefix('zoho.crm.') },
  { area: 'Deluge', feature: 'zoho.books.*', method: 'dotted names under `zoho.books.`', count: dottedPrefix('zoho.books.') },
  { area: 'Deluge', feature: 'thisapp.*', method: 'dotted names under `thisapp.`', count: dottedPrefix('thisapp.') },
  { area: 'Deluge', feature: 'openUrl', method: '`openUrl` identifier', count: id('openurl') },
  { area: 'Deluge', feature: 'alert', method: '`alert` identifier', count: id('alert') },
  { area: 'Deluge', feature: 'cancel submit', method: '`cancel submit`', count: pat('cancel submit') },
  { area: 'Deluge', feature: 'Portal user tasks', method: 'dotted names under `thisapp.portal.`', count: dottedPrefix('thisapp.portal.') },
  { area: 'Deluge', feature: 'PDF / print task', method: 'identifiers containing `pdf` (e.g. `zoho.file.convertToPDF`, `pdf` sendmail attachments)', count: (x) => [...x.deluge.idents].filter(([k]) => k.includes('pdf')).reduce((n, [, v]) => n + v, 0) },
  { area: 'Deluge', feature: 'File tasks (upload, download)', method: '`zoho.file.*`, `.toFile(`, `getFileContent`', count: sum(dottedPrefix('zoho.file.'), id('tofile', 'getfilecontent')) },
  { area: 'Deluge', feature: 'Statement limit', method: 'runtime limit, not in a .ds export', count: N },
  { area: 'Deluge', feature: 'Script timeout', method: 'runtime limit, not in a .ds export', count: N },
  { area: 'Deluge', feature: 'Subform row loop (input.Subform)', method: '`for each r in input.<subform field>`', count: pat('subform loop') },
  { area: 'Deluge', feature: 'Global Deluge function', method: 'Deluge functions defined (`ret name(args)`)', count: (x) => x.app.functions.filter((f) => f.kind === 'deluge').length },
  { area: 'Deluge', feature: 'Creator custom API (function as HTTP)', method: '`api <name> { ... }` blocks', count: (x) => x.app.apis.length },
  // pages
  { area: 'Pages and UI', feature: 'Page / dashboard', method: 'pages', count: (x) => x.app.pages.length },
  { area: 'Pages and UI', feature: 'Panel, chart, gauge, search, button on a page', method: 'ZML `panel`/`chart`/`gauge`/`search`/`button` elements', count: zmlTag('panel', 'chart', 'gauge', 'search', 'button') },
  { area: 'Pages and UI', feature: 'HTML / ZML snippet', method: 'ZML `dsp`/`dspZml` (snippet) and `html` elements', count: zmlTag('dsp', 'dspzml', 'html', 'htmlsnippet') },
  { area: 'Pages and UI', feature: 'Widget (embedded JS app)', method: 'ZML `widget`/`embed` elements', count: zmlTag('widget', 'embed') },
  { area: 'Pages and UI', feature: 'Embed a form or report in a page', method: 'ZML `report`/`form` elements', count: zmlTag('report', 'form') },
  { area: 'Pages and UI', feature: 'Drag-and-drop form builder', method: 'builder feature, not in a .ds export', count: N },
  // security and portal
  { area: 'Security and portal', feature: 'Roles (data hierarchy)', method: 'roles (incl. nested)', count: (x) => { const n = (rs: App['roles']): number => rs.reduce((k, r) => k + 1 + n(r.children), 0); return n(x.app.roles); } },
  { area: 'Security and portal', feature: 'Profiles (feature permissions)', method: 'profiles of type `Users_Permissions`', count: (x) => x.app.profiles.filter((p) => !/portal/i.test(p.type ?? '')).length },
  { area: 'Security and portal', feature: 'Sharing / share with stakeholders', method: '`share_settings` properties (`role Hierarchy`, ...)', count: (x) => x.app.shareSettings.length },
  { area: 'Security and portal', feature: 'Customer portal', method: 'profiles of a portal type (`Customer_Portal`)', count: portalProfiles },
  { area: 'Security and portal', feature: 'Portal permission sets', method: 'portal profiles with module permissions', count: (x) => x.app.profiles.filter((p) => /portal/i.test(p.type ?? '') && p.modules.length > 0).length },
  { area: 'Security and portal', feature: 'Accept payments from portal users', method: 'payment + portal in the same app', count: (x) => (payments(x) > 0 && portalProfiles(x) > 0 ? 1 : 0) },
  { area: 'Security and portal', feature: 'Public signup', method: 'portal setting, not in a .ds export', count: N },
  { area: 'Security and portal', feature: 'Social login', method: 'portal setting, not in a .ds export', count: N },
  { area: 'Security and portal', feature: 'Hosted login page', method: 'portal setting, not in a .ds export', count: N },
  // mobile and locale
  { area: 'Mobile and locale', feature: 'Auto-generated iOS and Android apps', method: '`phone`/`tablet` device blocks with menu sections', count: (x) => x.app.devices.filter((d) => d.device !== 'web' && d.sections.length > 0).length },
  { area: 'Mobile and locale', feature: 'Mobile app customization / code-sign / MDM', method: '`phone`/`tablet` `customize` with a branding or signing key, or `logo { preference }` not `"none"`', count: mobileCustomized },
  { area: 'Mobile and locale', feature: 'Mobile record actions (swipe, long press, tap)', method: 'report views with `on left/right swipe`, `on long press` or `on tap` actions', count: viewAction('on left swipe', 'on right swipe', 'on long press', 'on tap') },
  { area: 'Mobile and locale', feature: 'Offline forms and reports', method: 'device setting, not in a .ds export', count: N },
  { area: 'Mobile and locale', feature: 'Barcode scan on mobile', method: 'field property `barcode`/`qrcode` = true', count: fpropTrue('barcode', 'qrcode') },
  { area: 'Mobile and locale', feature: 'Localization / multi-language', method: '`translation` blocks', count: (x) => x.app.translations.length },
  // platform
  { area: 'Platform', feature: 'Environments: Development, Stage, Production', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Publish version history', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Audit trail: record edits and deletes', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Audit trail: report export and print', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Application backup (manual)', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Scheduled backup', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Import data (CSV, XLS, JSON)', method: 'same as the `Import` report menu item', count: menuItem('import') },
  {
    area: 'Platform',
    feature: 'Record template / HTML print layout',
    method: 'form `print template`/`record summary` blocks + report `print template`/`template` properties',
    count: (x) =>
      x.app.forms.reduce((n, f) => n + f.blocks.filter((b) => /print template|record summary/i.test(b.name)).length, 0) +
      x.app.reports.reduce((n, r) => n + r.properties.filter((p) => /^(print template|template)$/i.test(p.key)).length, 0),
  },
  { area: 'Platform', feature: 'Connections (OAuth to Zoho or third parties)', method: '`connections` settings block + Deluge `connection :` arguments', count: (x) => x.app.configuration.filter((b) => b.name.toLowerCase() === 'connections').length + id('connection')(x) },
  { area: 'Platform', feature: 'Data sources', method: '`datasources` settings block', count: (x) => x.app.configuration.filter((b) => b.name.toLowerCase() === 'datasources').length },
  { area: 'Platform', feature: 'Custom connectors', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Email domain authentication (SPF/DKIM)', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Developer / execution logs', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'APM', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Application alerts', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Metrics', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Automation testing', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Pipelines (CI)', method: 'not in a .ds export', count: N },
  { area: 'Platform', feature: 'Node.js runtime', method: 'Catalyst-side, not a Creator feature', count: N },
  { area: 'Platform', feature: 'Hosting a web client', method: 'Catalyst-side, not a Creator feature', count: N },
  { area: 'Platform', feature: 'AppSail (long-running Node)', method: 'Catalyst-side, not a Creator feature', count: N },
  { area: 'Platform', feature: 'Cache', method: 'Catalyst-side, not a Creator feature', count: N },
  { area: 'Platform', feature: 'NoSQL document store', method: 'Catalyst-side, not a Creator feature', count: N },
  { area: 'Platform', feature: 'IaC project template', method: 'Catalyst-side, not a Creator feature', count: N },
  { area: 'Platform', feature: 'Multi-DC (IN versus US)', method: 'account setting, not in a .ds export', count: N },
];

/** `zoho.<x>` system variables: `zoho.currentdate.addDay(1)` is a date method, not an integration task. */
const SYSTEM_VARS = new Set(['currentdate', 'currenttime', 'appname', 'appuri', 'loginuser', 'loginuserid', 'adminuser', 'adminuserid', 'ipaddress', 'devicetype', 'timezone']);

/** Zoho integration namespaces called from Deluge: `zoho.<ns>.<task>` → occurrences (system variables like `zoho.loginuser` excluded). */
export function integrationNamespaces(x: AppFacts): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of x.deluge.dotted) {
    const parts = k.split('.');
    if (parts[0] === 'zoho' && parts.length >= 3 && !SYSTEM_VARS.has(parts[1])) bump(out, `zoho.${parts[1]}.*`, v);
  }
  return out;
}

export interface AppSummary {
  forms: number;
  /** Data fields: top-level fields excluding `section` and `plaintext` (composites count once). */
  fields: number;
  reportsByType: Record<string, number>;
  workflowsByKind: Record<string, number>;
  delugeStatements: number;
  pages: number;
}

export function appSummary(x: AppFacts): AppSummary {
  const by = <T>(xs: T[], k: (t: T) => string) => xs.reduce<Record<string, number>>((m, t) => ((m[k(t)] = (m[k(t)] ?? 0) + 1), m), {});
  return {
    forms: x.app.forms.length,
    fields: x.fields.filter((f) => f.type !== 'section' && f.type !== 'plaintext').length,
    reportsByType: by(x.app.reports, (r) => r.type),
    // distinct workflow definitions (a definition has one IR entry per handler)
    workflowsByKind: by(
      [...new Map(x.app.workflows.map((w) => [`${w.container}|${w.name}`, w])).values()],
      (w) => (w.blueprint ? 'blueprint' : w.container ?? w.type ?? 'other'),
    ),
    delugeStatements: x.deluge.statements,
    pages: x.app.pages.length,
  };
}

// ---------------------------------------------------------------------------
// corpus aggregation

export interface FeatureUsage {
  row: FeatureRow;
  /** Apps with at least one occurrence. */
  apps: number;
  occurrences: number;
}

export interface FeatureReport {
  apps: { name: string; summary: AppSummary; counts: number[]; namespaces: Map<string, number> }[];
  usage: FeatureUsage[];
  /** `zoho.<ns>.*` → [apps, occurrences]. */
  namespaces: Map<string, [number, number]>;
}

/** Count features over named app IRs (one entry per app). */
export function featureReport(apps: { name: string; ir: App }[]): FeatureReport {
  const rows = apps.map(({ name, ir }) => {
    const x = appFacts(ir);
    return { name, summary: appSummary(x), counts: FEATURES.map((f) => (f.count ? f.count(x) : 0)), namespaces: integrationNamespaces(x) };
  });
  const usage = FEATURES.map((row, i) => ({
    row,
    apps: rows.filter((r) => r.counts[i] > 0).length,
    occurrences: rows.reduce((n, r) => n + r.counts[i], 0),
  }));
  const namespaces = new Map<string, [number, number]>();
  for (const r of rows)
    for (const [k, v] of r.namespaces) {
      const t = namespaces.get(k) ?? [0, 0];
      namespaces.set(k, [t[0] + 1, t[1] + v]);
    }
  return { apps: rows, usage, namespaces };
}

// ---------------------------------------------------------------------------
// markdown

const cell = (s: string) => s.replace(/\|/g, '\\|');

/** Feature usage table, integration namespaces, and the zero-app (UNCOVERED) list. Names and counts only. */
export function formatFeatures(label: string, r: FeatureReport): string {
  const n = r.apps.length;
  const L: string[] = [];
  L.push(`### ${label}: feature usage from the IR (${n} apps)`, '');
  L.push('| Area | Creator feature | apps using it | occurrences | how the IR is read |', '|---|---|---|---|---|');
  for (const u of r.usage) {
    const observable = !!u.row.count;
    L.push(`| ${cell(u.row.area)} | ${cell(u.row.feature)} | ${observable ? `${u.apps} / ${n}` : 'n/o'} | ${observable ? u.occurrences : 'n/o'} | ${cell(u.row.method)} |`);
  }
  L.push('', 'n/o = not observable in a `.ds` export (no detector; never counted as zero).', '');
  L.push('#### Zoho integration tasks called from Deluge (`zoho.<service>.*`)', '');
  L.push('| namespace | apps | occurrences |', '|---|---|---|');
  const ns = [...r.namespaces].sort((a, b) => b[1][1] - a[1][1]);
  for (const [k, [a, o]] of ns) L.push(`| \`${k}\` | ${a} | ${o} |`);
  if (!ns.length) L.push('| (none) | 0 | 0 |');
  L.push('', '#### UNCOVERED features (observable, zero apps)', '');
  const unc = r.usage.filter((u) => u.row.count && u.apps === 0);
  for (const u of unc) L.push(`- ${u.row.area}: ${u.row.feature} (${u.row.method})`);
  if (!unc.length) L.push('- none');
  return L.join('\n') + '\n';
}

/** Per-app summary table. */
export function formatApps(r: FeatureReport): string {
  const fmt = (m: Record<string, number>) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || '-';
  const L = [
    '| app | forms | fields | reports (by type) | workflows (by kind) | Deluge statements | pages |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const a of r.apps) {
    const s = a.summary;
    const reports = Object.values(s.reportsByType).reduce((x, y) => x + y, 0);
    const wfs = Object.values(s.workflowsByKind).reduce((x, y) => x + y, 0);
    L.push(`| ${cell(a.name)} | ${s.forms} | ${s.fields} | ${reports}: ${fmt(s.reportsByType)} | ${wfs}: ${fmt(s.workflowsByKind)} | ${s.delugeStatements} | ${s.pages} |`);
  }
  return L.join('\n') + '\n';
}
