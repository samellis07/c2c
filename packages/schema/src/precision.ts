import type { App, Field } from '../../core/src/ir.js';
import { generateSchema, type SchemaTable } from './generator.js';
import { CURRENCY_CODES, fieldTypeRow, normalizeType } from './mapping.js';

const EXACT_IDS = new Set(['decimal', 'percent', 'currency']);

export interface PrecisionMappingRow {
  app: string;
  form: string;
  /** Link name, or `Subform.Field` for a nested field. */
  field: string;
  matrixId: 'decimal' | 'percent' | 'currency';
  places: number;
  currencyCode?: string;
  storage: 'varchar-exact-decimal' | 'embedded-exact-decimal';
  /** Double shadow column for ZCQL criteria and sort. Only on `varchar-exact-decimal`. */
  shadow?: string;
}

function placesOf(field: Field): number {
  for (const key of ['decimalplace', 'decimal places', 'decimal digits']) {
    const found = field.properties.find((property) => property.key.toLowerCase() === key);
    if (!found) continue;
    const n = parseInt(found.value.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return 2;
}

function currencyCodeOf(field: Field): string | undefined {
  const token = normalizeType(field.type);
  if (!token || !CURRENCY_CODES.has(token)) return undefined;
  return token.toUpperCase();
}

function isSubform(field: Field): boolean {
  const token = normalizeType(field.type);
  return token === 'grid' || token === 'subform' || token === 'inline subform' || token === 'form';
}

function isInlineSubform(field: Field): boolean {
  return isSubform(field) && !field.lookup;
}

/**
 * Every decimal, currency, and percent field in parse order.
 * A NoSQL form (two or more inline subforms) keeps the value in the document.
 * A child-table column on a Data Store form is `varchar-exact-decimal`.
 * A nested subform that the schema does not expand is `embedded-exact-decimal`.
 */
export function precisionFields(app: App, appLink?: string): PrecisionMappingRow[] {
  const link = appLink || app.name || 'app';
  const rows: PrecisionMappingRow[] = [];
  for (const form of app.forms) {
    const nosql = form.fields.filter(isInlineSubform).length >= 2;
    walk(form.fields, form.name, nosql ? 'embedded-exact-decimal' : 'varchar-exact-decimal', rows, link, '');
  }
  if (rows.some((row) => row.storage === 'varchar-exact-decimal')) {
    const tables = generateSchema(app).tables;
    for (const row of rows) {
      if (row.storage !== 'varchar-exact-decimal') continue;
      const shadow = shadowColumn(tables, row.form, row.field);
      if (shadow) row.shadow = shadow;
    }
  }
  return rows;
}

/** The schema's shadow column for a form field or a single inline subform's `Sub.Field`. */
function shadowColumn(tables: readonly SchemaTable[], form: string, path: string): string | undefined {
  const dot = path.indexOf('.');
  const leaf = dot < 0 ? path : path.slice(dot + 1);
  const owners = tables.filter((table) => {
    if (table.form !== form || table.nosql) return false;
    if (dot < 0) return table.role === 'form';
    if (table.role !== 'child') return false;
    const parent = tables.find((t) => t.role === 'form' && t.form === form);
    const base = `${parent?.name ?? ''}__${path.slice(0, dot).replace(/[^A-Za-z0-9_]/g, '_')}`;
    return table.name === base || /^_\d+$/.test(table.name.slice(base.length)) && table.name.startsWith(base);
  });
  for (const table of owners) {
    const column = table.columns.find((c) => c.shadowFor === leaf);
    if (column) return column.name;
  }
  return undefined;
}

function walk(
  fields: readonly Field[],
  form: string,
  storage: PrecisionMappingRow['storage'],
  rows: PrecisionMappingRow[],
  link: string,
  prefix: string,
): void {
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const row = fieldTypeRow(field.type);
    if (row && EXACT_IDS.has(row.id)) {
      const currencyCode = currencyCodeOf(field);
      rows.push({
        app: link,
        form,
        field: path,
        matrixId: row.id as PrecisionMappingRow['matrixId'],
        places: placesOf(field),
        ...(currencyCode ? { currencyCode } : {}),
        storage,
      });
    }
    if (!field.subfields.length) continue;
    if (!isSubform(field)) {
      walk(field.subfields, form, storage, rows, link, path);
      continue;
    }
    if (storage === 'embedded-exact-decimal') {
      walk(field.subfields, form, 'embedded-exact-decimal', rows, link, path);
    } else if (isInlineSubform(field) && prefix === '') {
      walk(field.subfields, form, 'varchar-exact-decimal', rows, link, path);
    } else {
      walk(field.subfields, form, 'embedded-exact-decimal', rows, link, path);
    }
  }
}

export function formatPrecisionMapping(rows: readonly PrecisionMappingRow[]): string {
  const lines = [
    '# Precision mapping',
    '',
    'Currency, decimal, and percent values are stored as an exact canonical decimal string in a Catalyst VarChar column of length 64. Scale is the field decimal places (`decimalplace`, `decimal places`, or `decimal digits`). When the `.ds` omits that property the scale is 2. Extra fractional digits quantize half-away-from-zero, the same rule as the Deluge `round` shim (`218.5` to 0 places is `219`; `-1.5` to 0 places is `-2`).',
    '',
    'Creator counts a decimal, percent, or currency value at a maximum of 19 characters, and the minus sign, the digits, and the decimal point all count (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-max-digits). Decimal points are the maximum digits after the point. Extra digits on submit are invalid, not silently rounded (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-decimal-points). Reducing the property later “rounds off” stored values, and that help page does not name the rounding mode (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/set-decimal-points). Import therefore quantizes with the Deluge rule (https://www.zoho.com/deluge/help/functions/number/round.html).',
    '',
    'Percent is the number the user types. The % sign is display only, and the stored value is not divided by 100 (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-percent). Currency display follows the field currency type (`type = INR` and the other ISO 4217 codes). The code is column metadata, not a per-cell value (https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/fields-currency-understand). Decimal, percent, and currency are DECIMAL values in Deluge; a plain number is BIGINT (https://www.zoho.com/deluge/help/creator-field-datatype.html).',
    '',
    'Catalyst Data Store has no decimal and no BigDecimal column. The column types are Text, VarChar, Date, DateTime, Int, Double, Boolean, BigInt, Foreign Key, and Encrypted text. Double is binary64 (https://docs.catalyst.zoho.com/en/cloud-scale/help/data-store/columns/). This mapping does not use Double for these fields. Address latitude and longitude stay Double with precision 6.',
    '',
    'ZCQL compares and orders a varchar as text (`\'20.00\' <= \'100.00\'` is false; `\'90.00\'` sorts after `\'1000.00\'`). Each `varchar-exact-decimal` field therefore has a Double shadow column (`<Field>__n`, listed below). The runtime, the CSV loader, and the Creator migrator write it next to the varchar; app code never reads it. ZCQL criteria and ORDER BY on the field use the shadow with a bound widened by 10^-scale + |value| * 10^-15, a superset of the exact match. The runtime then keeps only rows that `shim.decimal.cmp` accepts on the exact varchar, re-sorts rows tied on the shadow by the exact value and ROWID, and applies `range from/to` to the exact result. This mapping does not claim a ZCQL decimal cast exists.',
    '',
    'Rows with a NULL shadow. ZCQL WHERE is SQL three-valued: a comparison with a NULL shadow is UNKNOWN, NOT UNKNOWN is UNKNOWN, and only TRUE rows come back. A shadow is NULL for a blank value, and for every row stored before the shadow column existed: deploy adds `<Field>__n` to an existing table and does not fill it. So every decimal comparison compiles to `(<bound> OR <shadow> IS NULL)`, NOT of `<`, `<=`, `>`, or `>=` compiles to `(NOT (<bound>) OR <shadow> IS NULL)`, and a comparison deeper under NOT is `(<shadow> IS NOT NULL AND <bound>)`. A NULL-shadow row therefore always reaches the exact check on the varchar, where a blank is not `< 5` and so is in `NOT (x < 5)`. A decimal sort with a range reads the NULL-shadow rows in one more query and places them by their exact value. The cost is reads, not correctness: every NULL-shadow row on the table is read by every decimal criteria on it. In a test with 6000 rows, `Amount <= 100` (101 matches) reads 101 rows with no NULL shadows, 690 rows when 10% are blank or stale, and all 6000 (21 queries) before a backfill; a windowed decimal sort takes 2 queries instead of 1. When deploy creates a shadow column on a table that already has rows, its post-deploy steps name the table and row count, and `c2c migrate-data --source-csv` warns when a written table still has rows with a value and a NULL shadow. `c2c deploy <app> --project <id> --org <org> --backfill-shadows --confirm` fills them: it reads NULL-shadow rows by ROWID keyset, 200 at a time, writes the binary64 of the varchar, pauses 250 ms between pages, and waits Retry-After on a 429 (it stops with the counts so far when that wait is over 60 s, or after five 429s in a row). Blanks and non-numbers stay NULL. Re-running it is safe.',
    '',
    'A form with two or more inline subforms is NoSQL. Its precision fields, including fields nested in those subforms, are `embedded-exact-decimal` strings inside the document, not JSON numbers, and the Data Store table is not created. A single inline subform’s fields are real child-table columns (`varchar-exact-decimal`). A nested subform the schema does not expand is `embedded-exact-decimal`. CSV import still skips NoSQL forms; those fields are listed here anyway.',
    '',
    `Measured fields: ${rows.length}`,
    '',
    '## Fields',
    '',
  ];
  if (!rows.length) lines.push('- none');
  const appAlias = new Map<string, string>();
  const formAlias = new Map<string, string>();
  const fieldAlias = new Map<string, string>();
  for (const row of rows) {
    if (!appAlias.has(row.app)) appAlias.set(row.app, `App_${String(appAlias.size + 1).padStart(2, '0')}`);
    const formKey = `${row.app}${row.form}`;
    const fieldKey = `${formKey}${row.field}`;
    if (!formAlias.has(formKey)) formAlias.set(formKey, `Form_${formAlias.size + 1}`);
    if (!fieldAlias.has(fieldKey)) fieldAlias.set(fieldKey, `Field_${fieldAlias.size + 1}`);
    const code = row.currencyCode ? ` currency ${row.currencyCode}` : '';
    const shadow = row.shadow ? ` + shadow ${fieldAlias.get(fieldKey)}__n Double` : '';
    lines.push(`${appAlias.get(row.app)} / ${formAlias.get(formKey)}.${fieldAlias.get(fieldKey)} ${row.matrixId} places ${row.places}${code} → ${row.storage}${shadow}`);
  }
  lines.push('');
  return lines.join('\n');
}
