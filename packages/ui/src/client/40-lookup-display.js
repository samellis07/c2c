/**
 * Lookup display values for report cells. A column the decorator marked with
 * `displayTrue`/`displayFalse` swaps a boolean cell, `formula` is the cell text
 * when every name it reads is on the row, `view` makes the cell a link to that
 * report, and a `lookup` cell shows the parent's display field — joining the
 * parts of a composite value or the refs in `lookup.displayFields`.
 */

/** A composite display value joins its non-empty scalar parts with a space. */
export function joinDisplayParts(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  const parts = [];
  for (const key of Object.keys(value)) { // determinism-allow: row key insertion order is the stored part order; sorting would scramble first/last name
    const part = value[key];
    if (part == null || part === '' || typeof part === 'object') continue;
    parts.push(String(part));
  }
  return parts.join(' ');
}

/** `Name.prefix` reads `row["Name.prefix"]` first, then `row.Name.prefix`. */
export function lookupRefValue(row, ref) {
  if (!row || typeof row !== 'object' || typeof ref !== 'string' || ref === '') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, ref)) return row[ref];
  const parts = ref.split('.');
  let value = row;
  for (const part of parts) {
    if (value == null || typeof value !== 'object') return undefined;
    value = value[part];
  }
  return value;
}

/** `A + " - " + B` becomes [{ref: "A"}, {text: " - "}, {ref: "B"}]. */
export function displayFormulaTerms(formula) {
  if (typeof formula !== 'string' || formula.trim() === '') return undefined;
  const terms = [];
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)*|[^"'\w]+/g;
  for (const match of formula.matchAll(re)) {
    const token = match[0];
    if (/^[A-Za-z_]/.test(token)) terms.push({ ref: token });
    else if (token[0] === '"' || token[0] === "'") terms.push({ text: token.slice(1, -1) });
  }
  return terms.length ? terms : undefined;
}

/** The formula text when every ref is on the row, else undefined. */
export function formulaCellText(formula, row) {
  const terms = displayFormulaTerms(formula);
  if (!terms) return undefined;
  let text = '';
  for (const term of terms) {
    if (Object.prototype.hasOwnProperty.call(term, 'text')) {
      text += term.text;
      continue;
    }
    const value = lookupRefValue(row, term.ref);
    if (value === undefined || value === null) return undefined;
    text += joinDisplayParts(value);
  }
  return text;
}

/** `displaytrue`/`displayfalse` cell text, else undefined. */
export function booleanCellText(column, value) {
  const truthy = value === true || value === 'true' || value === 'TRUE' || value === '1' || value === 1;
  const shown = truthy ? column.displayTrue : column.displayFalse;
  return shown === undefined ? undefined : shown;
}

/** `view = Some_Report` makes the cell a link to `#/report/Some_Report`. */
export function reportCellLink(column) {
  const view = typeof column.view === 'string' && column.view !== '' ? column.view : undefined;
  if (!view) return undefined;
  return { href: '#/report/' + encodeURIComponent(view), text: typeof column.viewLabel === 'string' && column.viewLabel !== '' ? column.viewLabel : view };
}

/**
 * The parent display value for a lookup cell. `parents` is the report's
 * parent rows keyed by ROWID; a composite display joins its parts, and
 * `lookup.displayFields` picks the refs in export order.
 */
export function lookupCellText(column, row, parents) {
  const lookup = column.lookup;
  if (!lookup || !row || typeof row !== 'object') return undefined;
  const value = row[column.field];
  if (value == null || value === '') return undefined;
  const parts = Array.isArray(lookup.displayFields) && lookup.displayFields.length ? lookup.displayFields : undefined;
  if (typeof value === 'object') {
    if (parts) {
      const joined = [];
      for (const ref of parts) {
        const part = lookupRefValue(value, ref.includes('.') ? ref.slice(ref.indexOf('.') + 1) : ref);
        if (part != null && part !== '' && typeof part !== 'object') joined.push(String(part));
      }
      return joined.length ? joined.join(' ') : undefined;
    }
    return joinDisplayParts(value);
  }
  if (typeof value !== 'string' || !Array.isArray(parents)) return undefined;
  const parent = parents.find((item) => item && typeof item === 'object' && String(item.ROWID) === value);
  if (!parent) return undefined;
  const field = typeof lookup.field === 'string' && lookup.field !== '' ? lookup.field : undefined;
  if (!field) return undefined;
  const shown = lookupRefValue(parent, field);
  if (shown === undefined || shown === null) return undefined;
  return joinDisplayParts(shown);
}

/**
 * The cell display for a row: `{ text }` for a string replace, `{ link }` for
 * a report link, undefined when the raw value paints as-is.
 */
export function displayCell(column, row, ctx) {
  if (!column || typeof column !== 'object') return undefined;
  const formula = formulaCellText(column.formula, row);
  if (formula !== undefined) return { text: formula };
  const link = reportCellLink(column);
  if (link) return { link };
  const bool = booleanCellText(column, valueOf(column, row));
  if (bool !== undefined) return { text: bool };
  const joined = lookupCellText(column, row, ctx && ctx.parents);
  if (joined !== undefined) return { text: joined };
  return undefined;
}

function valueOf(column, row) {
  return row && typeof row === 'object' ? row[column.field] : undefined;
}

/**
 * Repaints `tbody` rows (one `tr` per entry of `rows`, columns in order) with
 * their display values. Returns the number of cells changed.
 */
export function applyLookupDisplays(report, tbody, rows, ctx) {
  if (!report || !tbody || typeof tbody !== 'object' || !Array.isArray(report.columns)) return 0;
  const body = Array.isArray(rows) ? rows : [];
  const trs = tbody.querySelectorAll ? Array.from(tbody.querySelectorAll('tr')) : [];
  let changed = 0;
  for (let i = 0; i < trs.length && i < body.length; i += 1) {
    const cells = trs[i].querySelectorAll ? Array.from(trs[i].querySelectorAll('td')) : [];
    for (let c = 0; c < cells.length && c < report.columns.length; c += 1) {
      const shown = displayCell(report.columns[c], body[i], ctx);
      if (!shown) continue;
      const td = cells[c];
      if (shown.link) {
        const document = td.ownerDocument;
        if (!document) continue;
        const a = document.createElement('a');
        a.setAttribute('href', shown.link.href);
        a.textContent = shown.link.text;
        td.textContent = '';
        td.appendChild(a);
        changed += 1;
      } else if (td.textContent !== shown.text) {
        td.textContent = shown.text;
        changed += 1;
      }
    }
  }
  return changed;
}
